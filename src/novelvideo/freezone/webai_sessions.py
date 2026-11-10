# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Per-scene Gemini WebAI conversation ids for a Freezone project.

Gemini keeps character, lighting and background continuity across turns of one
conversation. That is what makes four storyboard frames look like four shots of
the same place rather than four different places, so the conversation id is worth
persisting between jobs instead of starting fresh every time.

**Scope it per scene, never globally.** The previs CLI shared one conversation
across every scene and Gemini carried the Garden of Eden's background figures
into the Moon shots — Adam and Eve, unsuited, standing on the regolith
(2026-11-09). `cmd_storyboard` in `previs_h3_test/scripts/gemini_webai_images.py`
was reworked to one conversation per chain for exactly this reason, and this
module is the app-side equivalent: a `{scene_key: conversation_id}` map, where
the caller chooses the key (the canvas node id is a reasonable default, a shared
"scene" name is better when several nodes really are the same location).

An empty scene key means "no session": a brand-new conversation each time, which
is the behaviour every caller had before this existed.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_SESSION_FILE = Path("freezone") / "_state" / "webai_sessions.json"


def session_file(project_dir: Path) -> Path:
    return Path(project_dir) / _SESSION_FILE


def load_session(project_dir: Path, scene_key: str) -> dict:
    """Return a mutable session dict to hand to `_call_webai_chat_image_api`.

    Always returns a dict (possibly empty) so the caller can pass it straight
    through and read the id back out afterwards.
    """
    key = str(scene_key or "").strip()
    if not key:
        return {}
    path = session_file(project_dir)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    conversation_id = (data or {}).get(key)
    return {"conversation_id": str(conversation_id)} if conversation_id else {}


def save_session(project_dir: Path, scene_key: str, session: dict) -> None:
    """Persist `session["conversation_id"]` under `scene_key`, if there is one.

    Never raises: losing a conversation id costs continuity on the next
    generation, which is not worth failing an otherwise successful job over.
    """
    key = str(scene_key or "").strip()
    conversation_id = str((session or {}).get("conversation_id") or "")
    if not key or not conversation_id:
        return
    path = session_file(project_dir)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                data = {}
        except (OSError, ValueError):
            data = {}
        if data.get(key) == conversation_id:
            return
        data[key] = conversation_id
        path.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    except OSError as exc:
        logger.warning("could not persist webai session for %s: %s", key, exc)
