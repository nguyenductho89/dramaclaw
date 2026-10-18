"""Path-safety constraints for asset names.

The ``name`` of a character / scene / prop plays three roles at once: SQLite primary key, REST path segment, disk directory name.
Once a single ``/`` gets into a name, all three roles collapse together:

* **Path segment** -- the frontend percent-encodes the name into ``%2F`` (``frontend/src/lib/api-path.ts``),
  but uvicorn unquotes the whole path **before** handing the request to the Starlette router, so ``%2F`` turns back into
  a real slash. The ``{name}`` in ``/projects/{project}/scenes/{name}/delete`` does not match ``/``,
  so that whole row of endpoints -- delete / rename / generate source image / upload ... -- all 404 with FastAPI's
  ``{"detail": "Not Found"}`` rather than the business layer's "scene does not exist". The frontend sees only a bare
  ``Not Found``, and deleting seems to do nothing.
* **Directory name** -- ``assets/scenes/<name>`` spreads into nested directories, scattering an asset's files across two levels.
* **Primary key** -- ``a/b`` and ``a`` look like parent and child but are actually unrelated; the proper way to write a derived scene is ``a_b``
  (see :mod:`novelvideo.utils.derived_scenes`).

These names are free text planned by an LLM and cannot be blocked upstream, so they are always sanitized at the write entry.

Only ``/``, ``\\`` and pure-dot names (``.`` / ``..``) are handled: they are the only forms that change the path structure.
``assets/scenes/..`` resolves to ``assets/`` itself and, like a slash, can climb out of the assets directory. Other characters that merely
look "odd" (spaces, ``#``, ``?``, ``%``, ``:``) all pass safely through routing and the filesystem once percent-encoded,
and replacing them would only needlessly damage the names users chose -- the dot in ``Living room 1.5`` must stay.
"""

from __future__ import annotations

import logging
import re
import shutil
from pathlib import Path

logger = logging.getLogger(__name__)

_PATH_HOSTILE_RUN = re.compile(r"[/\\]+")
# Only a name made entirely of dots is dangerous: ``.`` and ``..`` are the current / parent directory in a path. A dot in the middle of a name
# (``Living room 1.5``) is an ordinary character, and touching it only damages the name the user chose.
_DOT_ONLY = re.compile(r"\A\.+\Z")
# Character names have also always blocked a set of Windows reserved characters (``NovelCharacter.sanitize_name`` has always used this
# rule). That is not a path-safety requirement, but trouble starts whenever the two sides use different character sets: the route checks duplicates with the narrow rule and lets
# ``Wang:Xiaoming`` through, the model layer rewrites it to ``Wang_Xiaoming`` with the wide rule, and ``INSERT ... ON CONFLICT(name)``
# then silently overwrites the real ``Wang_Xiaoming``. So both sides share the definition here; do not write separate regexes.
_CHARACTER_HOSTILE_RUN = re.compile(r'[/\\:*?"<>|]+')
_REPLACEMENT = "_"


def _hostile_run(kind: str) -> re.Pattern[str]:
    return _CHARACTER_HOSTILE_RUN if kind == "character" else _PATH_HOSTILE_RUN


def is_path_safe_asset_name(name: str | None, *, kind: str = "asset") -> bool:
    """Whether the name is safe to use as a path segment and directory name."""

    value = str(name or "")
    if _DOT_ONLY.match(value):
        return False
    return _hostile_run(kind).search(value) is None


def path_safe_asset_name(name: str | None, *, kind: str = "asset") -> str:
    """Replace path-hostile characters with ``_``.

    Consecutive slashes are collapsed into one ``_`` so that ``Living room//Dining room`` does not become ``Living room__Dining room``.

    **No strip**: this function also runs on the read path of the model validators, and ``name`` is a SQLite primary key.
    If the read path trimmed ``"Living room "`` to ``"Living room"``, the model layer could never match the row with the trailing space in the primary key again,
    and ``DELETE ... WHERE name = ?`` would delete nothing -- a replay of the slash bug. To trim,
    call ``.strip()`` explicitly at the write entry.
    """

    value = str(name or "")
    # Collapse slashes first: ``../..`` collapses to ``.._..``, a proper file name that must no longer be treated as a pure-dot name.
    value = _hostile_run(kind).sub(_REPLACEMENT, value)
    if _DOT_ONLY.match(value):
        return _REPLACEMENT * len(value)
    return value


def coerce_path_safe_asset_name(
    name: str | None,
    aliases: list[str] | None = None,
) -> tuple[str, list[str]]:
    """Return the sanitized name and keep the original name as an alias.

    The original name must be kept: beats, storyboards and the canvas already reference this asset by the original name, and the store's
    ``get_scene`` / ``get_character`` / ``get_prop`` all fall back to aliases, so keeping the original name means these references
    do not break -- otherwise one sanitization would turn "16 usages" into dangling references.
    """

    # Likewise no strip: see the note on path_safe_asset_name; this path is called by the model validators at read time.
    original = str(name or "")
    merged = [str(alias or "") for alias in (aliases or [])]
    safe = path_safe_asset_name(original)
    if safe == original:
        return safe, merged
    if original and original not in merged:
        merged.append(original)
    return safe, merged


def unique_path_safe_asset_name(
    name: str | None,
    taken: set[str] | frozenset[str],
    *,
    kind: str = "asset",
) -> str:
    """If the sanitized name collides with an existing one, append ``_2`` / ``_3`` ... until it no longer collides.

    Only needed when repairing legacy data: ``a/b`` is sanitized to ``a_b``, and ``a_b`` may really exist already.
    """

    safe = path_safe_asset_name(name, kind=kind)
    if not safe:
        return safe
    if safe not in taken:
        return safe
    for suffix in range(2, 1000):
        candidate = f"{safe}_{suffix}"
        if candidate not in taken:
            return candidate
    return safe


def asset_dir_within(root: Path, name: str | None) -> Path | None:
    """Return ``root/<name>`` if it lies inside ``root``, or ``None`` if it climbs out.

    Legacy self-healing builds source paths from **old names in the DB**, and old names are exactly the unsanitized ones:
    a source path built from ``../../config.json`` lies outside the asset root, and ``shutil.move`` would really move the project
    config away. Sanitization only covers new names and cannot rescue old values already persisted, so it must be checked again before moving.

    Use ``resolve()`` rather than ``Path.is_relative_to`` directly: a name may mix in symlinks and
    ``..``, and only a comparison after resolving to real paths counts. It also works when ``root`` does not exist -- ``resolve()``
    does a purely lexical normalization of non-existent paths on Python 3.6+.
    """

    value = str(name or "")
    if not value:
        return None
    try:
        root_resolved = Path(root).resolve()
        candidate = (root_resolved / value).resolve()
    except OSError:
        return None
    if candidate == root_resolved:
        return None
    if not candidate.is_relative_to(root_resolved):
        return None
    return candidate


def move_asset_dir(root: Path, old_name: str, new_name: str) -> bool:
    """Move ``root/<old_name>`` to ``root/<new_name>``; return ``True`` on success.

    The source path comes from an old name in the DB and may be a dirty value such as ``../../config.json`` that climbs out of the asset root;
    the target path comes from the sanitized new name and normally cannot climb out, but checking both is simpler. If either end lies outside ``root``,
    treat it as "no directory to move" -- log one warning, leave the disk untouched, and do not stop the caller from renaming the
    DB row. The asset directory for a dirty value never existed anyway, so what is blocked is a false positive, not a migration.

    If the target already exists, raise ``ValueError``: better to keep a bad name on this row than to let a record point at someone else's image.
    """

    old_dir = asset_dir_within(root, old_name)
    new_dir = asset_dir_within(root, new_name)
    if old_dir is None or new_dir is None:
        logger.warning(
            "Asset name escapes the asset root; skipping directory migration: %s → %s (root=%s)", old_name, new_name, root
        )
        return False
    if not old_dir.exists():
        return False
    if new_dir.exists():
        raise ValueError(f"Target asset directory already exists: {new_dir}")
    new_dir.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(old_dir), str(new_dir))
    return True
