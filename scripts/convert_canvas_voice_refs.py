#!/usr/bin/env python3
"""One-time rewrite of **project-level** voice references in existing canvas nodes into **account-level** references.

B2 section 4, item 3: after block 2 (audio node decoupling) moved voice resolution up to the
account level, saved canvases still carry `voiceRef`s such as `character_default` / `identity` /
`project_narrator` that are **pinned to a project**. They are the only existing-data rewrite in B2.
B2 section 9 ruled: **a standalone script, not part of a migration** (hundreds of records).

What it does, step by step:

1. Scan the live canvases in `<project_dir>/freezone/canvases/*.json` (skipping tombstones and `_history/`).
2. For each project-level `voiceRef`, use the **existing** resolution path
   `audio_node.resolve_speech_voice` to land on a concrete audio file (this step needs the
   project SQLite, so the script runs on the home node).
3. Register that file in the user's account-level voice library
   (`audio_node.create_user_audio_voice`, i.e. `_account/freezone/audio/voices/`), **deduplicated by sha256**.
4. Rewrite the node's `voiceRef` into `{"scope": "user_custom", "voiceId": ...}`.

**Re-entrant**: after the rewrite the node's scope is already `user_custom`, so a second pass no
longer matches: it neither resolves, registers, nor writes to disk -- the second pass is a no-op
(asserted by `tests/test_convert_canvas_voice_refs_script.py`).

**Dry-run by default**; only `--apply` writes. Writes go through `canvas_write_lock` --
B2 section 4, item 3 requires this conversion to run after block 1, and the mutual exclusion
guarantees it does not collide with a user's concurrent save.

Usage::

    python scripts/convert_canvas_voice_refs.py                    # full dry-run
    python scripts/convert_canvas_voice_refs.py --apply
    python scripts/convert_canvas_voice_refs.py --username alice --project demo --apply
"""

from __future__ import annotations

import argparse
import asyncio
import json
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable, Iterable

from novelvideo.config import OUTPUT_DIR
from novelvideo.freezone.audio_node import (
    USER_VOICE_SCOPE,
    FreezoneVoiceRefResolution,
    create_user_audio_voice,
    list_user_audio_voices,
    resolve_speech_voice,
)
from novelvideo.freezone.canvas_lock import canvas_write_lock
from novelvideo.freezone.canvas_store import atomic_write_json, load_canvas_json
from novelvideo.freezone.paths import canvases_dir

# The full set of scopes of the frontend `AudioVoiceRef` is in
# `frontend/src/features/canvas/domain/canvasNodes.ts:445-451`; apart from the account-level
# `user_custom`, all the rest are pinned to a project.
PROJECT_SCOPES = frozenset(
    {
        "project_narrator",
        "character_default",
        "character_age_group",
        "identity",
        "identity_resolved",
    }
)

# Keys unique to the project level; they must be cleared when rewriting into an account-level reference.
PROJECT_ONLY_KEYS = ("characterName", "identityId", "slot")


@dataclass(frozen=True)
class ConversionResult:
    canvases_scanned: int = 0
    canvases_written: int = 0
    nodes_converted: int = 0
    errors: tuple[str, ...] = ()

    def merged(self, other: "ConversionResult") -> "ConversionResult":
        return ConversionResult(
            canvases_scanned=self.canvases_scanned + other.canvases_scanned,
            canvases_written=self.canvases_written + other.canvases_written,
            nodes_converted=self.nodes_converted + other.nodes_converted,
            errors=self.errors + other.errors,
        )


# ---------------------------------------------------------------------------
# Canvas payload side (pure functions, no disk access)
# ---------------------------------------------------------------------------


def iter_voice_refs(payload: dict) -> Iterable[dict]:
    """Yield every `voiceRef` in the canvas that is **pending rewrite** (the dict itself, editable in place)."""
    for node in payload.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        data = node.get("data")
        if not isinstance(data, dict):
            continue
        voice_ref = data.get("voiceRef")
        if not isinstance(voice_ref, dict):
            continue
        if str(voice_ref.get("scope") or "").strip() in PROJECT_SCOPES:
            yield voice_ref


def voice_ref_key(voice_ref: dict) -> str:
    """Dedup key so that the same project-level reference is resolved only once."""
    return json.dumps(
        {
            "scope": str(voice_ref.get("scope") or ""),
            "characterName": str(voice_ref.get("characterName") or ""),
            "identityId": str(voice_ref.get("identityId") or ""),
            "slot": str(voice_ref.get("slot") or ""),
        },
        sort_keys=True,
        ensure_ascii=False,
    )


def backend_voice_ref(voice_ref: dict) -> dict:
    """camelCase canvas shape -> the snake_case shape the backend `_resolve_voice_ref` consumes.

    The mapping is aligned verbatim with the one the frontend does on dispatch (`frontend/src/api/ops.ts:2074-2090`).
    """
    return {
        "scope": str(voice_ref.get("scope") or ""),
        "character_name": str(voice_ref.get("characterName") or ""),
        "identity_id": str(voice_ref.get("identityId") or ""),
        "slot": str(voice_ref.get("slot") or ""),
        "voice_id": str(voice_ref.get("voiceId") or ""),
    }


def voice_ref_label(voice_ref: dict) -> str:
    scope = str(voice_ref.get("scope") or "")
    character = str(voice_ref.get("characterName") or "").strip()
    if scope == "project_narrator":
        return "Project narrator voice"
    if scope == "character_default":
        return f"{character or 'Character'} - default voice"
    if scope == "character_age_group":
        slot = str(voice_ref.get("slot") or "").strip()
        return f"{character or 'Character'} - {slot or 'age group'}"
    identity = str(voice_ref.get("identityId") or "").strip()
    return f"{character or 'Character'} - identity {identity or 'unknown'}"


def convert_canvas_payload(
    payload: dict,
    *,
    resolve_account_voice_id: Callable[[dict], str],
) -> int:
    """Rewrite one canvas in place and return the number of rewritten nodes. Nodes already at account level are left untouched."""
    converted = 0
    for voice_ref in list(iter_voice_refs(payload)):
        voice_id = resolve_account_voice_id(dict(voice_ref))
        voice_ref.clear()
        voice_ref["scope"] = USER_VOICE_SCOPE
        voice_ref["voiceId"] = str(voice_id)
        converted += 1
    return converted


# ---------------------------------------------------------------------------
# Disk side
# ---------------------------------------------------------------------------


def iter_canvas_files(project_dir: Path) -> list[Path]:
    """Live canvas files in a project. Skips tombstones (`*.deleted.json`), `_history/`, and temporary write files."""
    root = canvases_dir(project_dir)
    if not root.is_dir():
        return []
    return sorted(
        path
        for path in root.glob("*.json")
        if not path.name.startswith(".") and not path.name.endswith(".deleted.json")
    )


def convert_project_canvases(
    project_dir: Path,
    *,
    resolve_account_voice_id: Callable[[dict], str],
    apply: bool,
) -> ConversionResult:
    result = ConversionResult()
    for path in iter_canvas_files(project_dir):
        result = replace(result, canvases_scanned=result.canvases_scanned + 1)
        canvas_id = path.stem
        payload = load_canvas_json(path)
        if not isinstance(payload, dict):
            result = replace(
                result, errors=result.errors + (f"{path}: not readable canvas JSON",)
            )
            continue
        if not any(True for _ in iter_voice_refs(payload)):
            continue
        if not apply:
            pending = sum(1 for _ in iter_voice_refs(payload))
            result = replace(result, nodes_converted=result.nodes_converted + pending)
            continue
        # Re-read after taking the lock, so a user save between the scan and the write is not overwritten.
        with canvas_write_lock(project_dir, canvas_id):
            fresh = load_canvas_json(path)
            if not isinstance(fresh, dict):
                result = replace(
                    result, errors=result.errors + (f"{path}: canvas unreadable after taking the lock",)
                )
                continue
            converted = convert_canvas_payload(
                fresh, resolve_account_voice_id=resolve_account_voice_id
            )
            if not converted:
                continue
            atomic_write_json(path, fresh)
        result = replace(
            result,
            canvases_written=result.canvases_written + 1,
            nodes_converted=result.nodes_converted + converted,
        )
    return result


def account_voice_id_for(
    username: str,
    *,
    resolution: FreezoneVoiceRefResolution,
    label: str,
) -> str:
    """Register the resolved audio file as an account-level voice, reusing the already registered entry by sha256.

    Dedup is the second safeguard for re-entrancy: if one source file is referenced by several
    nodes, or the conversion is interrupted and rerun, no duplicate entries pile up in
    `_account/freezone/audio/voices/`.
    """
    sha = str(resolution.sha256 or "")
    if sha:
        for record in list_user_audio_voices(username):
            if str(record.get("sha256") or "") == sha:
                return str(record.get("voice_id") or "")
    created = create_user_audio_voice(
        username=username,
        name=label,
        filename=resolution.audio_path.name,
        content=Path(resolution.audio_path).read_bytes(),
    )
    return str(created.get("voice_id") or "")


async def build_account_voice_map(
    *,
    username: str,
    project: str,
    project_dir: Path,
    voice_refs: dict[str, dict],
) -> dict[str, str]:
    """Resolve and register each project-level reference pending rewrite once, returning `voice_ref_key -> voice_id`."""
    from novelvideo.api.deps import make_sqlite_store

    mapping: dict[str, str] = {}
    store = await make_sqlite_store(username, project)
    try:
        for key, voice_ref in voice_refs.items():
            _, resolution = await resolve_speech_voice(
                store=store,
                username=username,
                project=project,
                project_dir=project_dir,
                voice_ref=backend_voice_ref(voice_ref),
            )
            mapping[key] = account_voice_id_for(
                username, resolution=resolution, label=voice_ref_label(voice_ref)
            )
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()
    return mapping


async def convert_project(username: str, project: str, *, apply: bool) -> ConversionResult:
    project_dir = Path(OUTPUT_DIR) / username / project
    files = iter_canvas_files(project_dir)
    pending: dict[str, dict] = {}
    for path in files:
        payload = load_canvas_json(path)
        if not isinstance(payload, dict):
            continue
        for voice_ref in iter_voice_refs(payload):
            pending.setdefault(voice_ref_key(voice_ref), dict(voice_ref))
    if not pending:
        # Complete no-op: do not even open the project store. The second pass takes this path.
        return ConversionResult(canvases_scanned=len(files))

    if not apply:
        return convert_project_canvases(
            project_dir,
            resolve_account_voice_id=lambda _ref: "",
            apply=False,
        )

    try:
        mapping = await build_account_voice_map(
            username=username,
            project=project,
            project_dir=project_dir,
            voice_refs=pending,
        )
    except Exception as exc:  # noqa: BLE001 - one project failing must not abort the whole batch
        return ConversionResult(
            canvases_scanned=len(files),
            errors=(f"{username}/{project}: voice resolution failed: {exc}",),
        )
    return convert_project_canvases(
        project_dir,
        resolve_account_voice_id=lambda ref: mapping[voice_ref_key(ref)],
        apply=True,
    )


def discover_projects(
    username: str | None = None, project: str | None = None
) -> list[tuple[str, str]]:
    root = Path(OUTPUT_DIR)
    if not root.is_dir():
        return []
    found: list[tuple[str, str]] = []
    for user_dir in sorted(root.iterdir()):
        if not user_dir.is_dir() or user_dir.name.startswith("_"):
            continue
        if username and user_dir.name != username:
            continue
        for project_dir in sorted(user_dir.iterdir()):
            if not project_dir.is_dir() or project_dir.name.startswith("_"):
                continue
            if project and project_dir.name != project:
                continue
            if canvases_dir(project_dir).is_dir():
                found.append((user_dir.name, project_dir.name))
    return found


async def run(
    *, username: str | None, project: str | None, apply: bool
) -> ConversionResult:
    total = ConversionResult()
    for owner, name in discover_projects(username, project):
        result = await convert_project(owner, name, apply=apply)
        total = total.merged(result)
        if result.nodes_converted or result.errors:
            print(
                f"{owner}/{name}: scanned {result.canvases_scanned} canvases | "
                f"rewrote {result.nodes_converted} nodes | wrote {result.canvases_written} canvases"
            )
    return total


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--username", default=None, help="Only process this user")
    parser.add_argument("--project", default=None, help="Only process this project")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually write to disk; without it only report (default dry-run)",
    )
    args = parser.parse_args(argv)

    total = asyncio.run(
        run(username=args.username, project=args.project, apply=args.apply)
    )
    mode = "APPLY" if args.apply else "DRY-RUN"
    print(
        f"[{mode}] canvases {total.canvases_scanned} | pending/rewritten nodes "
        f"{total.nodes_converted} | canvases written {total.canvases_written}"
    )
    for error in total.errors:
        print(f"  ! {error}")
    return 1 if total.errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
