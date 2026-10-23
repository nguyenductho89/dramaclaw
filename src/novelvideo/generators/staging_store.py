"""Per-episode sidecar storage for a scene's "staging bible" — camera
framing, where each identity stands (left/right of frame, etc.), and
where persistent set-dressing (a prop that stays in frame across many
beats of the same scene, like a toy wall a character keeps adding bricks
to) sits — kept identical across every beat of the same scene so
independently rendered first frames (`runpod_qwen21_compose`/
`gemini_webai_compose`) don't drift in blocking or camera angle from one
beat to the next.

Why a sidecar and not a DB column: this is advisory prompt-shaping data,
disposable/regenerable (re-running `agents/scene_staging_planner.py`
replaces it), not a durable project fact — same reasoning as
`segment_store.py`/`qwen_edit_prompt_store.py`. One file per episode
(not per scene) because a scene's own identity is already `beat.scene_ref
.scene_id`, and an episode's beats are already grouped that way.

See `.claude/CLAUDE.md`'s "Parkun" compose-prompt entry and
`docs/adr/0006-compose-staging-bible.md` for why this exists.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


def _sidecar_path(output_dir: str | Path, episode: int) -> Path:
    return Path(output_dir) / "staging" / f"ep{episode:03d}.json"


@dataclass
class SetDressingItem:
    prop_id: str
    placement_note: str = ""
    persistent: bool = False
    from_beat: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "prop_id": self.prop_id,
            "placement_note": self.placement_note,
            "persistent": self.persistent,
            "from_beat": self.from_beat,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SetDressingItem":
        return cls(
            prop_id=str(data.get("prop_id") or ""),
            placement_note=str(data.get("placement_note") or ""),
            persistent=bool(data.get("persistent", False)),
            from_beat=int(data.get("from_beat") or 0),
        )


@dataclass
class SceneStaging:
    scene_id: str
    camera: str = ""
    blocking: dict[str, str] = field(default_factory=dict)  # identity_id -> placement sentence
    set_dressing: list[SetDressingItem] = field(default_factory=list)
    scale_note: str = ""
    source: str = "fallback"  # "llm" | "llm_repaired" | "fallback" | "manual"

    def to_dict(self) -> dict[str, Any]:
        return {
            "scene_id": self.scene_id,
            "camera": self.camera,
            "blocking": dict(self.blocking),
            "set_dressing": [item.to_dict() for item in self.set_dressing],
            "scale_note": self.scale_note,
            "source": self.source,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SceneStaging":
        return cls(
            scene_id=str(data.get("scene_id") or ""),
            camera=str(data.get("camera") or ""),
            blocking={str(k): str(v) for k, v in (data.get("blocking") or {}).items()},
            set_dressing=[
                SetDressingItem.from_dict(item)
                for item in data.get("set_dressing") or []
                if isinstance(item, dict)
            ],
            scale_note=str(data.get("scale_note") or ""),
            source=str(data.get("source") or "fallback"),
        )

    def persistent_props_as_of(self, beat_number: int) -> list[SetDressingItem]:
        """Set-dressing items marked `persistent` whose `from_beat` is at
        or before `beat_number` — used so a prop established earlier in
        the scene (e.g. the toy wall from beat 1) still gets mentioned and
        referenced at a later beat that doesn't itself tag it (e.g. beat
        5), instead of silently vanishing between independently rendered
        frames (real bug, `Parkun` project, beat 5 — see
        `.claude/CLAUDE.md`)."""
        return [
            item
            for item in self.set_dressing
            if item.persistent and item.from_beat <= beat_number
        ]


def load_episode_staging(output_dir: str | Path, episode: int) -> dict[str, SceneStaging]:
    """`{scene_id: SceneStaging}` for this episode, or `{}` if nothing has
    been planned/saved yet — callers must treat a missing/empty result as
    a silent no-op (render without staging, exactly like before this
    feature existed), never an error."""
    path = _sidecar_path(output_dir, episode)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    scenes = raw.get("scenes") or {}
    return {
        sid: SceneStaging.from_dict({**data, "scene_id": data.get("scene_id") or sid})
        for sid, data in scenes.items()
        if isinstance(data, dict)
    }


def save_episode_staging(
    output_dir: str | Path, episode: int, scenes: dict[str, SceneStaging]
) -> None:
    path = _sidecar_path(output_dir, episode)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "scenes": {sid: s.to_dict() for sid, s in scenes.items()},
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def get_scene_staging(
    output_dir: str | Path, episode: int, scene_id: str
) -> Optional[SceneStaging]:
    """Convenience single-scene lookup for render-time callers
    (`nanobanana_grid.py`'s compose plan builders) — reads the whole
    sidecar each call (cheap: one small JSON file, same tradeoff
    `segment_store.py` makes) rather than requiring every caller to load
    the full episode map first."""
    if not scene_id:
        return None
    return load_episode_staging(output_dir, episode).get(scene_id)
