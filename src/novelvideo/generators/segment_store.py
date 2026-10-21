"""Per-episode sidecar storage for the "segment multishot" flow's own
state — which beats are grouped into which segment (`chain_id`), whether
that segment's first frame has been reviewed/approved, and what it was
approved against.

Why a sidecar and not a DB column: the grouping itself already has a DB
column (`NovelVisualBeat.multishot_chain_id`, written via
`update_beat_asset`) — that's the durable source of truth for "beat N is
in segment seg_03". This sidecar only holds the *review workflow* state
on top of that (approved/pending, what the approved frame's fingerprint
was), which is disposable/regenerable and dev-only, same reasoning as
`qwen_edit_prompt_store.py` for render prompts. One file per episode
(not per segment) because segments can be re-planned/re-numbered as a
batch.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


def _sidecar_path(output_dir: str | Path, episode: int) -> Path:
    return Path(output_dir) / "segments" / f"ep{episode:03d}.json"


@dataclass
class SegmentState:
    chain_id: str
    beat_numbers: list[int]
    shot_seconds: list[float] = field(default_factory=list)
    reason: str = ""
    frame_status: str = "pending"  # "pending" | "approved"
    frame_fingerprint: str = ""
    video_status: str = "pending"  # "pending" | "generated"

    def to_dict(self) -> dict[str, Any]:
        return {
            "chain_id": self.chain_id,
            "beat_numbers": self.beat_numbers,
            "shot_seconds": self.shot_seconds,
            "reason": self.reason,
            "frame_status": self.frame_status,
            "frame_fingerprint": self.frame_fingerprint,
            "video_status": self.video_status,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SegmentState":
        return cls(
            chain_id=str(data.get("chain_id") or ""),
            beat_numbers=[int(n) for n in data.get("beat_numbers") or []],
            shot_seconds=[float(s) for s in data.get("shot_seconds") or []],
            reason=str(data.get("reason") or ""),
            frame_status=str(data.get("frame_status") or "pending"),
            frame_fingerprint=str(data.get("frame_fingerprint") or ""),
            video_status=str(data.get("video_status") or "pending"),
        )


def load_segment_states(output_dir: str | Path, episode: int) -> dict[str, SegmentState]:
    """`{chain_id: SegmentState}` for this episode, or `{}` if nothing has
    been planned/saved yet."""
    path = _sidecar_path(output_dir, episode)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    segments = raw.get("segments") or {}
    return {cid: SegmentState.from_dict(data) for cid, data in segments.items()}


def save_segment_states(
    output_dir: str | Path, episode: int, states: dict[str, SegmentState]
) -> None:
    path = _sidecar_path(output_dir, episode)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "segments": {cid: s.to_dict() for cid, s in states.items()},
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def replace_all_segments(
    output_dir: str | Path,
    episode: int,
    segments: list[dict[str, Any]],
) -> dict[str, SegmentState]:
    """Overwrites the whole episode's segment set — used by `segments/apply`
    after a fresh plan. Each `segments` entry is
    `{chain_id, beat_numbers, shot_seconds, reason}`; any segment not in
    the new set is dropped (its `multishot_chain_id` on the beats themselves
    is cleared by the caller, this just drops the matching sidecar entry)."""
    states = {
        seg["chain_id"]: SegmentState(
            chain_id=seg["chain_id"],
            beat_numbers=[int(n) for n in seg["beat_numbers"]],
            shot_seconds=[float(s) for s in seg.get("shot_seconds") or []],
            reason=str(seg.get("reason") or ""),
        )
        for seg in segments
    }
    save_segment_states(output_dir, episode, states)
    return states


def set_frame_approved(
    output_dir: str | Path, episode: int, chain_id: str, *, fingerprint: str
) -> Optional[SegmentState]:
    states = load_segment_states(output_dir, episode)
    state = states.get(chain_id)
    if state is None:
        return None
    state.frame_status = "approved"
    state.frame_fingerprint = fingerprint
    save_segment_states(output_dir, episode, states)
    return state


def reset_frame_approval_if_stale(
    output_dir: str | Path, episode: int, chain_id: str, *, current_fingerprint: str
) -> Optional[SegmentState]:
    """If this segment was previously approved against a different
    fingerprint (the frame was regenerated since), flips it back to
    `pending` so a stale-but-approved frame never silently reaches video
    generation. No-op (returns the state unchanged) if still matching or
    if the segment was never approved."""
    states = load_segment_states(output_dir, episode)
    state = states.get(chain_id)
    if state is None:
        return None
    if state.frame_status == "approved" and state.frame_fingerprint != current_fingerprint:
        state.frame_status = "pending"
        state.frame_fingerprint = ""
        save_segment_states(output_dir, episode, states)
    return state


def set_video_status(
    output_dir: str | Path, episode: int, chain_id: str, *, status: str
) -> Optional[SegmentState]:
    states = load_segment_states(output_dir, episode)
    state = states.get(chain_id)
    if state is None:
        return None
    state.video_status = status
    save_segment_states(output_dir, episode, states)
    return state
