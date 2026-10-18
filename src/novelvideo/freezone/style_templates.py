# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Loading and fallback for the short-drama style template manifest.

The template bodies (label, category, cover/sample image relative paths, prompt) live in `style_templates.json`,
shipped with the package; when ops wants to swap in a different style library, it is enough to point `STYLE_GALLERY_MANIFEST` at an external file,
with no code change or re-release -- the same idea as images going through `STYLE_GALLERY_ASSET_BASE`.

If the external manifest is broken (file missing, JSON syntax error, missing fields), always degrade to the built-in one and emit a
warning: styles are a nice-to-have capability and must not drag the whole image endpoint down because of one config file. Only when the built-in
one cannot be read do we raise -- that means the packaging is broken, and it must be loud.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

MANIFEST_ENV = "STYLE_GALLERY_MANIFEST"
BUILTIN_MANIFEST_PATH = Path(__file__).with_name("style_templates.json")

# Non-empty string fields every template must have. samples may be an empty list (a cover alone is usable).
_REQUIRED_TEXT_FIELDS = ("id", "label", "category", "cover", "style_prompt")

_CacheKey = tuple[Any, ...]
_cache: Optional[tuple[_CacheKey, str, list[dict]]] = None


class StyleManifestError(ValueError):
    """The manifest structure is invalid."""


def _manifest_path() -> Path:
    override = os.environ.get(MANIFEST_ENV, "").strip()
    if override:
        return Path(override).expanduser()
    return BUILTIN_MANIFEST_PATH


def _cache_key(path: Path) -> _CacheKey:
    """Include mtime/size: after ops replaces the manifest file in place, the next request takes effect."""
    try:
        stat = path.stat()
    except OSError:
        return (str(path), None)
    return (str(path), stat.st_mtime_ns, stat.st_size)


def _parse_manifest(raw: Any) -> tuple[str, list[dict]]:
    """Accept `{"version": ..., "templates": [...]}`, and also a bare array."""
    if isinstance(raw, list):
        version, templates = "", raw
    elif isinstance(raw, dict):
        version = str(raw.get("version") or "")
        templates = raw.get("templates")
    else:
        raise StyleManifestError("The manifest top level must be an object or an array")

    if not isinstance(templates, list) or not templates:
        raise StyleManifestError("templates must be a non-empty array")

    seen: set[str] = set()
    parsed: list[dict] = []
    for index, item in enumerate(templates):
        if not isinstance(item, dict):
            raise StyleManifestError(f"Template #{index} is not an object")
        for field in _REQUIRED_TEXT_FIELDS:
            value = item.get(field)
            if not isinstance(value, str) or not value.strip():
                raise StyleManifestError(f"Template #{index} is missing field {field}")
        samples = item.get("samples", [])
        if not isinstance(samples, list) or any(
            not isinstance(sample, str) or not sample.strip() for sample in samples
        ):
            raise StyleManifestError(f"samples of template {item['id']} must be an array of strings")
        if item["id"] in seen:
            raise StyleManifestError(f"Duplicate template id: {item['id']}")
        seen.add(item["id"])
        parsed.append(
            {
                "id": item["id"],
                "label": item["label"],
                "category": item["category"],
                "cover": item["cover"],
                "samples": list(samples),
                "style_prompt": item["style_prompt"],
            }
        )
    return version, parsed


def _read_manifest(path: Path) -> tuple[str, list[dict]]:
    return _parse_manifest(json.loads(path.read_text(encoding="utf-8")))


def _load() -> tuple[str, list[dict]]:
    global _cache

    path = _manifest_path()
    key = _cache_key(path)
    if _cache is not None and _cache[0] == key:
        return _cache[1], _cache[2]

    try:
        version, templates = _read_manifest(path)
    except (OSError, ValueError) as exc:
        if path == BUILTIN_MANIFEST_PATH:
            raise RuntimeError(f"Built-in style manifest unavailable: {path}") from exc
        logger.warning(
            "[freezone] Style manifest %s unavailable (%s), falling back to the built-in manifest", path, exc
        )
        version, templates = _read_manifest(BUILTIN_MANIFEST_PATH)

    _cache = (key, version, templates)
    return version, templates


def reset_style_template_cache() -> None:
    """Force a re-read after changing the environment variable or replacing the file in place; for tests."""
    global _cache
    _cache = None


def load_style_templates() -> list[dict]:
    # Copy each entry before handing it out. A shallow list() of the outer level cannot stop mutations like `item["label"] = ...`
    # -- those would poison every later request through the cache. The manifest is only 45 entries, so copying is negligible.
    return [{**item, "samples": list(item["samples"])} for item in _load()[1]]


def get_style_manifest_version() -> str:
    return _load()[0]
