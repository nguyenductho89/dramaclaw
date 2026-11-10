# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Previs prompt templates: empty plates, character sheets, in-scene storyboard frames.

Ported from `previs_h3_test/scripts/skits/science_humor/gravity_test/gen_chains.py`
(`storyboard_prompt` / `storyboard_prompt_qwen`) so the same prompts can be run
from a Freezone image node instead of a standalone CLI.

Two things make this a server-side manifest rather than a frontend template list
like `h3PromptTemplates.ts`:

1. **The fragments carry measured physical constants.** Camera height, subject
   height, "the horizon passes through both men's chests" — these came out of
   real measurement of generated frames, not taste. The Gemini wording and the
   Qwen wording must therefore say the *same* thing; keeping both in one table,
   built from one slot set, is what stops them drifting apart.
2. **The Qwen flavour must lint before a GPU call.** `lint_qwen21_compose_prompt`
   is the repo's own checker for the `<imageN>` compose form, and only the server
   can run it.

The two flavours genuinely differ in form, not content: Gemini is addressed in
prose ("Image 1 is the location"), while Qwen requires `<imageN>` tags, a single
paragraph, no double quotes, the literal word "photorealistic", and no
aspect-ratio token (the output size comes from `<image1>`). That split is why
every fragment below has a `gemini` and a `qwen` text.

Scale guidance follows the `image-scale-prompt` skill: name real metres and real
multiples, because both models otherwise shrink whatever does not fit the frame.
Always verify a generated frame with `image-scale-review` before spending GPU on
it — measured 2026-11-09, wording alone did NOT fix a 3x-too-small background;
the plate's own geometry had to change.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Literal, Optional

logger = logging.getLogger(__name__)

Flavor = Literal["gemini", "qwen"]

MANIFEST_ENV = "PREVIS_TEMPLATE_MANIFEST"
BUILTIN_MANIFEST_PATH = Path(__file__).with_name("previs_templates.json")

CATEGORIES = ("plate", "sheet", "storyboard")

#: Reusable sentences shared by several templates, each in both flavours.
#: `{slot}` placeholders are filled from the request's slot values.
#:
#: `one_camera_one_ground_plane` and `subject_height_scale` are the 2026-11-09
#: scale fix: before them, composed frames put the two men on a different ground
#: plane from the background and let metre-scale objects shrink to fit. They are
#: necessary but NOT sufficient — measurement after adding them still showed a
#: 0.33x background, which only a different plate geometry fixed. Keep them, keep
#: measuring.
PREVIS_PROMPT_FRAGMENTS: dict[str, dict[str, str]] = {
    "one_camera_one_ground_plane": {
        "gemini": (
            "One camera, one ground plane: the camera is about {camera_height_m} metres above the ground, "
            "so the horizon line of Image 1 passes through the subjects' chests, and every subject stands on "
            "that same ground plane, in front of the background objects, not floating above them."
        ),
        "qwen": (
            "One camera and one ground plane: the camera is about {camera_height_m} metres above the ground, "
            "the horizon line of <image1> passes through the subjects' chests, and every subject stands on that "
            "same ground plane in front of the background objects."
        ),
    },
    "subject_height_scale": {
        "gemini": (
            "Each person is about {subject_height_m} metres tall, so every background object keeps its real size "
            "relative to them: anything several metres tall (a tree, a lander, a building) stays several times "
            "taller than a standing person and must not shrink to fit the frame."
        ),
        "qwen": (
            "Each person is about {subject_height_m} metres tall and every background object keeps its real size "
            "relative to them, so anything several metres tall stays several times taller than a standing person "
            "at its own distance from the camera."
        ),
    },
    "relight_to_plate": {
        "gemini": (
            "Relight every subject to match Image 1's own light exactly — its direction, colour temperature and "
            "contrast — not the flat, even studio lighting of the reference sheets; their clothing, hair and face "
            "keep their own colours, only the lighting on them changes."
        ),
        "qwen": (
            "Relight every subject to the light of <image1>: its direction, colour temperature and contrast replace "
            "the even studio lighting of the reference sheets, while clothing, hair and face keep their own colours."
        ),
    },
    "contact_shadow": {
        "gemini": (
            "Each subject casts a soft, visible contact shadow on the ground directly beneath their own feet, "
            "matching the shadows already in Image 1."
        ),
        "qwen": (
            "Each subject casts a soft visible contact shadow on the ground directly beneath their own feet, "
            "matching the shadows already in <image1>."
        ),
    },
    "foreground_overlap": {
        "gemini": (
            "A little of the nearest foreground terrain overlaps the lowest part of their legs or feet, so each "
            "subject reads as standing inside the scene, not cut out and pasted on top of it."
        ),
        "qwen": (
            "A little of the nearest foreground terrain overlaps the lowest part of their legs or feet so each "
            "subject stands inside the scene."
        ),
    },
    "photoreal_finish": {
        "gemini": (
            "Natural skin texture, soft gentle contrast, natural film look, photorealistic. Show each subject once. "
            "No text, logos or watermarks."
        ),
        "qwen": (
            "Render the subjects and the scene as a real photorealistic photograph with natural skin texture, soft "
            "gentle contrast and a natural film look, not as a sketch, illustration, painting or 3D render."
        ),
    },
    "keep_plate_contents": {
        "gemini": (
            "Keep Image 1's background, framing, static eye-level camera and lighting exactly as they are, including "
            "any small distant background figures, and do not add any object or prop that is not already in it."
        ),
        "qwen": (
            "Keep the background, framing, static eye-level camera and lighting of <image1> exactly as they are, "
            "including any small distant background figures, and do not add any object that is not already visible "
            "in <image1>."
        ),
    },
}

_REQUIRED_TEXT_FIELDS = ("id", "label", "category")

_CacheKey = tuple[Any, ...]
_cache: Optional[tuple[_CacheKey, str, list[dict]]] = None


class PrevisManifestError(ValueError):
    """The manifest structure is invalid."""


class PrevisTemplateNotFound(KeyError):
    """No template with that id."""


def _manifest_path() -> Path:
    override = os.environ.get(MANIFEST_ENV, "").strip()
    if override:
        return Path(override).expanduser()
    return BUILTIN_MANIFEST_PATH


def _cache_key(path: Path) -> _CacheKey:
    try:
        stat = path.stat()
    except OSError:
        return (str(path), None)
    return (str(path), stat.st_mtime_ns, stat.st_size)


def _parse_manifest(raw: Any) -> tuple[str, list[dict]]:
    if isinstance(raw, list):
        version, templates = "", raw
    elif isinstance(raw, dict):
        version = str(raw.get("version") or "")
        templates = raw.get("templates")
    else:
        raise PrevisManifestError("The manifest top level must be an object or an array")

    if not isinstance(templates, list) or not templates:
        raise PrevisManifestError("templates must be a non-empty array")

    seen: set[str] = set()
    parsed: list[dict] = []
    for index, item in enumerate(templates):
        if not isinstance(item, dict):
            raise PrevisManifestError(f"Template #{index} is not an object")
        for field in _REQUIRED_TEXT_FIELDS:
            value = item.get(field)
            if not isinstance(value, str) or not value.strip():
                raise PrevisManifestError(f"Template #{index} is missing field {field}")
        if item["category"] not in CATEGORIES:
            raise PrevisManifestError(
                f"Template {item['id']} has unknown category {item['category']!r}; "
                f"expected one of {CATEGORIES}"
            )
        if item["id"] in seen:
            raise PrevisManifestError(f"Duplicate template id: {item['id']}")
        seen.add(item["id"])

        body = item.get("prompt")
        if not isinstance(body, dict) or not body.get("gemini") or not body.get("qwen"):
            raise PrevisManifestError(
                f"Template {item['id']} must define prompt.gemini and prompt.qwen — a "
                "template that only exists in one flavour silently changes meaning when "
                "the user switches image model"
            )
        fragments = item.get("fragments", [])
        if not isinstance(fragments, list) or any(f not in PREVIS_PROMPT_FRAGMENTS for f in fragments):
            raise PrevisManifestError(
                f"Template {item['id']} lists an unknown fragment; known: "
                f"{sorted(PREVIS_PROMPT_FRAGMENTS)}"
            )
        slots = item.get("slots", {})
        if not isinstance(slots, dict):
            raise PrevisManifestError(f"slots of template {item['id']} must be an object")

        parsed.append(
            {
                "id": item["id"],
                "label": item["label"],
                "category": item["category"],
                "description": str(item.get("description") or ""),
                "reference_slots": list(item.get("reference_slots") or []),
                "fragments": list(fragments),
                "slots": dict(slots),
                "prompt": {"gemini": body["gemini"], "qwen": body["qwen"]},
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
            raise RuntimeError(f"Built-in previs manifest unavailable: {path}") from exc
        logger.warning(
            "[freezone] Previs manifest %s unavailable (%s), falling back to the built-in manifest",
            path,
            exc,
        )
        version, templates = _read_manifest(BUILTIN_MANIFEST_PATH)

    _cache = (key, version, templates)
    return version, templates


def reset_previs_template_cache() -> None:
    """Force a re-read after changing the env var or replacing the file; for tests."""
    global _cache
    _cache = None


def load_previs_templates() -> list[dict]:
    return [
        {
            **item,
            "reference_slots": list(item["reference_slots"]),
            "fragments": list(item["fragments"]),
            "slots": dict(item["slots"]),
            "prompt": dict(item["prompt"]),
        }
        for item in _load()[1]
    ]


def get_previs_manifest_version() -> str:
    return _load()[0]


def previs_flavor_for_provider(provider: str | None) -> Flavor:
    """Qwen needs its own `<imageN>` prompt form; everything else reads prose."""
    return "qwen" if str(provider or "").strip().lower().startswith("runpod_qwen") else "gemini"


def build_previs_prompt(
    template_id: str,
    *,
    flavor: Flavor,
    slots: dict[str, Any] | None = None,
    reference_count: int = 0,
) -> str:
    """Render one template into a finished prompt.

    Slot values come from the template's own defaults, overridden by `slots`.
    `reference_count` fills `{reference_count}` and is also what the Qwen lint
    checks the `<imageN>` tags against.
    """
    template = next((t for t in load_previs_templates() if t["id"] == template_id), None)
    if template is None:
        raise PrevisTemplateNotFound(template_id)

    values: dict[str, Any] = {**template["slots"], **(slots or {})}
    values.setdefault("reference_count", reference_count)

    parts = [template["prompt"][flavor]]
    parts.extend(PREVIS_PROMPT_FRAGMENTS[name][flavor] for name in template["fragments"])
    text = " ".join(part.strip() for part in parts if part and part.strip())
    try:
        text = text.format(**values)
    except KeyError as exc:
        raise PrevisManifestError(
            f"Template {template_id} references slot {exc.args[0]!r} with no value; "
            f"known slots: {sorted(values)}"
        ) from exc
    if flavor == "qwen":
        # Qwen's compose form is one paragraph with no double quotes; normalising
        # here means a manifest author cannot accidentally fail the lint with
        # formatting they could not see.
        text = " ".join(text.split()).replace('"', "")
    return text


def lint_previs_prompt(prompt: str, flavor: Flavor, n_images: int) -> list[str]:
    """Flavour-appropriate checks. Qwen delegates to the repo's existing
    `lint_qwen21_compose_prompt` rather than reimplementing its rules."""
    if flavor == "qwen":
        from novelvideo.agents.qwen21_compose_prompt_lint import lint_qwen21_compose_prompt

        return lint_qwen21_compose_prompt(prompt, n_images)

    issues: list[str] = []
    if not prompt.strip():
        issues.append("empty prompt")
    if "<image" in prompt:
        issues.append(
            "gemini-flavour prompt contains an <imageN> tag — that is the Qwen form; "
            "Gemini is addressed with 'Image 1', 'Image 2', ..."
        )
    if "{" in prompt or "}" in prompt:
        issues.append("unresolved {slot} placeholder left in prompt")
    return issues
