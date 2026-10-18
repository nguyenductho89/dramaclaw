"""Cross-project asset copy: copy one file from a source project into a new file under the target project's `freezone/_uploads/`.

When a node is pasted across projects, the URLs in the node data still point at the source project. Previously the frontend had to
fetch every file and POST it to the target project's upload endpoint, moving the bytes twice; the backend now copies directly:

1. In production `OUTPUT_DIR` is an ossfs mount, so prefer a server-side OSS CopyObject, which keeps the bytes
   off the pod;
2. If OSS is unavailable, the source object has not been written back yet (or is still an old version), a single object exceeds the CopyObject limit, or the copy is
   not visible on the mount afterwards, fall back to a plain filesystem copy, so correctness does not depend on OSS.

URL parsing only accepts the two same-origin canonical forms `/static/projects/<pid>/<rel>` and `/api/v1/projects/<pid>/media/<rel>`;
legacy paths such as `/static/<user>/<project>/...` carry no project id,
and never occur in scenarios that need cross-project authorization anyway, so they are always rejected.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Literal
from urllib.parse import unquote, urlsplit

from novelvideo.freezone.paths import safe_upload_filename
from novelvideo.utils import oss_client

logger = logging.getLogger("novelvideo.freezone.asset_copy")

MAX_SOURCES_PER_REQUEST = 200
MAX_SOURCE_URL_LENGTH = 2048

# Target file name = timestamp prefix (23) + source file name; a long source name is truncated to this length so it cannot hit the filesystem
# 255-byte per-segment limit; `safe_upload_filename` replaces all non-ASCII with `_`, so character count equals byte count.
_MAX_TARGET_BASENAME = 120
_MAX_KEPT_EXTENSION = 16

# OSS single-shot CopyObject only supports objects up to 1 GB; larger ones would need UploadPartCopy, which is not done here.
_OSS_COPY_OBJECT_LIMIT_BYTES = 1024 * 1024 * 1024

_STATIC_PREFIX = "/static/projects/"
_MEDIA_PREFIX = "/api/v1/projects/"
_MEDIA_MARKER = "/media/"

CopyMethod = Literal["oss", "filesystem"]
FailureReason = Literal["invalid_source", "not_found", "forbidden", "unavailable", "copy_failed"]


class AssetCopyError(Exception):
    """A single source file failed; `reason` is returned to the frontend verbatim, without path details."""

    def __init__(self, reason: FailureReason, detail: str = ""):
        super().__init__(detail or reason)
        self.reason: FailureReason = reason


def parse_project_asset_url(url: str) -> tuple[str, str] | None:
    """Split a same-origin asset URL into `(project_id, project-relative path)`; return None for unrecognized forms."""
    raw = (url or "").strip()
    if not raw or "\\" in raw:
        return None
    try:
        parts = urlsplit(raw)
    except ValueError:
        # Malformed URLs such as `http://[`: urlsplit itself raises (Invalid IPv6 URL); they are not files of this site either.
        return None
    # Only same-origin paths are accepted: anything with a scheme/netloc (including data:/blob:/protocol-relative forms) is not a file of this site.
    if parts.scheme or parts.netloc:
        return None
    path = parts.path
    if path.startswith(_STATIC_PREFIX):
        remainder = path[len(_STATIC_PREFIX) :]
        project_id, sep, rel = remainder.partition("/")
    elif path.startswith(_MEDIA_PREFIX) and _MEDIA_MARKER in path[len(_MEDIA_PREFIX) :]:
        remainder = path[len(_MEDIA_PREFIX) :]
        project_id, sep, rel = remainder.partition(_MEDIA_MARKER)
    else:
        return None
    if not sep:
        return None
    project_id = unquote(project_id)
    rel = unquote(rel)
    if not project_id or "/" in project_id or project_id in {".", ".."}:
        return None
    if not rel or "\\" in rel:
        return None
    # Control characters (such as `%00`) that appear after decoding are not file names, and Path would also blow up on resolve.
    if _has_control_chars(project_id) or _has_control_chars(rel):
        return None
    return project_id, rel


def _has_control_chars(value: str) -> bool:
    return any(ord(ch) < 32 or ch == "\x7f" for ch in value)


def resolve_source_file(project_dir: Path, rel: str) -> Path:
    """Resolve a project-relative path to a real file; out-of-bounds paths and non-regular files count as failures."""
    try:
        root = project_dir.resolve()
        candidate = (project_dir / rel).resolve()
    except (OSError, ValueError, RuntimeError) as exc:
        # Null bytes, over-long paths, symlink loops, ... all mean this one source is bad, not the whole batch.
        raise AssetCopyError("invalid_source", f"unresolvable path {rel!r}: {exc}") from exc
    if candidate == root or not candidate.is_relative_to(root):
        raise AssetCopyError("invalid_source", f"path escapes project: {rel!r}")
    try:
        is_file = candidate.is_file()
    except OSError as exc:
        raise AssetCopyError("not_found", f"cannot stat {rel!r}: {exc}") from exc
    if not is_file:
        raise AssetCopyError("not_found", f"not a regular file: {rel!r}")
    return candidate


def bounded_upload_basename(name: str, limit: int = _MAX_TARGET_BASENAME) -> str:
    """Truncate the source file name to at most `limit` characters, preserving the extension where possible."""
    base = (name or "").split("/")[-1].split("\\")[-1] or "upload"
    if len(base) <= limit:
        return base
    stem, dot, ext = base.rpartition(".")
    if not dot or not stem or len(ext) > _MAX_KEPT_EXTENSION:
        return base[:limit]
    return f"{stem[: limit - len(ext) - 1]}.{ext}"


def allocate_target_path(target_dir: Path, source_name: str) -> Path:
    """Pick a new, not-yet-existing name for the source file under the target `_uploads/`."""
    base = bounded_upload_basename(source_name)
    try:
        target = target_dir / safe_upload_filename(base)
        while target.exists():
            target = target_dir / safe_upload_filename(base)
    except OSError as exc:
        raise AssetCopyError("copy_failed", f"cannot allocate target for {source_name!r}: {exc}") from exc
    return target


def _copy_via_oss(source: Path, target: Path) -> bool:
    bucket = oss_client.get_bucket()
    if bucket is None:
        return False
    source_key = oss_client.local_path_to_key(source)
    target_key = oss_client.local_path_to_key(target)
    if not source_key or not target_key:
        return False
    try:
        size = source.stat().st_size
    except OSError:
        return False
    if size > _OSS_COPY_OBJECT_LIMIT_BYTES:
        return False
    # ossfs write-back is delayed: a just-written source file may not be an OSS object yet (CopyObject would 404),
    # and a file overwritten in place may still be an old version on OSS with the same size; only let OSS copy it
    # once the remote is confirmed to be this local version, otherwise stale content would be kept in the target project as a "successful" result.
    if not oss_client.object_matches_local(source_key, source):
        return False
    try:
        bucket.copy_object(bucket.bucket_name, source_key, target_key)
    except Exception as exc:  # noqa: BLE001 - any OSS exception falls back to a filesystem copy
        logger.warning("OSS copy_object failed %s -> %s: %s", source_key, target_key, exc)
        return False
    # It must be visible on the mount (with a matching size), otherwise the URL returned to the frontend would 404.
    try:
        visible = target.is_file() and target.stat().st_size == size
    except OSError:
        visible = False
    if not visible:
        logger.warning("OSS copy_object done but %s not visible on mount; falling back", target)
    return visible


def copy_project_file(source: Path, target: Path) -> CopyMethod:
    """Copy `source` to `target`, preferring a server-side OSS copy and falling back to the filesystem on failure."""
    target.parent.mkdir(parents=True, exist_ok=True)
    if _copy_via_oss(source, target):
        return "oss"
    shutil.copyfile(source, target)
    return "filesystem"
