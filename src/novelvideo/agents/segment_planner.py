"""Groups an episode's beats into short "segments" (10-15s each), each of
which becomes ONE MiniMax H3 Multishot job (one shot per beat, continuous
within the segment) instead of one 1-shot job per beat.

Why this exists: see `.claude/CLAUDE.md`'s "Segment multishot" section and
`docs/adr/0005-segment-multishot-flow.md`. In short — a 45s script of 10+
beats used to mean 10+ separate sketch/render/prompt/video/compose steps,
each needing a click; grouping beats into 3-4 segments means 3-4 first
frames and 3-4 video jobs instead.

**The LLM proposes, Python disposes.** `plan_segments()` asks the model
for a grouping (`SegmentPlanLLMOutput`), but the result the caller
actually gets is always `validate_and_repair_segment_plan()`'s output —
every hard constraint (contiguous, 1-3 beats/segment, every beat
accounted for exactly once, <=3 distinct characters/segment) is enforced
in plain Python, not trusted from the model. An LLM output that violates
the ordered-partition shape outright (missing/duplicate/reordered beats)
is discarded wholesale in favor of `greedy_fallback_segments()`; one that
is shaped correctly but has an individual segment too big gets that one
segment locally split, so a mostly-good plan isn't thrown away over one
bad group.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from pydantic import BaseModel, Field
from pydantic_ai import Agent

from pathlib import Path

_RULES_PATH = Path(__file__).parent / "prompts" / "segment_planner_rules.md"

MAX_SHOTS_PER_SEGMENT = 3
MIN_SHOT_SECONDS = 5.0
MAX_SHOT_SECONDS = 12.0
MAX_IDENTITIES_PER_SEGMENT = 3
# Not a hard cap (the rules doc says "not a hard ceiling") — only used by
# the deterministic fallback to decide when to prefer a cut.
SOFT_MAX_SEGMENT_SECONDS = 15.0
SOFT_MIN_SEGMENT_SECONDS_BEFORE_SCENE_CUT = 10.0


def _load_rules() -> str:
    return _RULES_PATH.read_text(encoding="utf-8")


# ── What the caller gives the planner, one entry per beat ──────────────────


@dataclass
class SegmentPlannerBeatInput:
    beat_number: int
    narration_segment: str = ""
    visual_description: str = ""
    audio_type: str = "silence"
    speaker: str = ""
    scene_id: str = ""
    identities: list[str] = field(default_factory=list)
    estimated_duration: float = 5.0


def beat_inputs_from_dicts(beats: list[dict[str, Any]]) -> list[SegmentPlannerBeatInput]:
    """Builds `SegmentPlannerBeatInput` from the dicts `get_beats_as_dicts`
    returns — the shape the API routes already have in hand."""
    out: list[SegmentPlannerBeatInput] = []
    for b in beats:
        scene_ref = b.get("scene_ref") or {}
        scene_id = scene_ref.get("scene_id", "") if isinstance(scene_ref, dict) else ""
        duration = b.get("estimated_duration")
        try:
            duration = float(duration) if duration else 0.0
        except (TypeError, ValueError):
            duration = 0.0
        if duration <= 0:
            duration = max(len(str(b.get("narration_segment") or "")) / 4.0, MIN_SHOT_SECONDS)
        out.append(
            SegmentPlannerBeatInput(
                beat_number=int(b["beat_number"]),
                narration_segment=str(b.get("narration_segment") or ""),
                visual_description=str(b.get("visual_description") or ""),
                audio_type=str(b.get("audio_type") or "silence"),
                speaker=str(b.get("speaker") or ""),
                scene_id=str(scene_id or ""),
                identities=[str(i) for i in (b.get("detected_identities") or [])],
                estimated_duration=duration,
            )
        )
    return out


# ── LLM output shape (content only — Python assigns the final seconds) ────


class SegmentShotProposal(BaseModel):
    beat_number: int
    seconds: float = Field(
        default=6.0, description="Proposed shot length in seconds, 5-12."
    )


class SegmentProposal(BaseModel):
    beat_numbers: list[int] = Field(description="Beat numbers in this segment, in script order")
    shot_seconds: list[float] = Field(
        default_factory=list,
        description="Proposed seconds per shot, same length/order as beat_numbers; optional",
    )
    reason: str = Field(default="", description="One short sentence: why these beats are grouped")


class SegmentPlanLLMOutput(BaseModel):
    segments: list[SegmentProposal] = Field(default_factory=list)


# ── What the caller actually gets back ─────────────────────────────────────


@dataclass
class ValidatedSegment:
    beat_numbers: list[int]
    shot_seconds: list[float]
    reason: str = ""
    warnings: list[str] = field(default_factory=list)

    @property
    def total_seconds(self) -> float:
        return round(sum(self.shot_seconds), 2)


@dataclass
class ValidatedSegmentPlan:
    segments: list[ValidatedSegment]
    source: str  # "llm" | "llm_repaired" | "fallback"
    warnings: list[str] = field(default_factory=list)


def _clamp_seconds(value: float) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        v = MIN_SHOT_SECONDS
    return max(MIN_SHOT_SECONDS, min(MAX_SHOT_SECONDS, v))


def _identity_union_size(group: list[SegmentPlannerBeatInput]) -> int:
    seen: set[str] = set()
    for b in group:
        seen.update(b.identities)
    return len(seen)


def greedy_fallback_segments(beats: list[SegmentPlannerBeatInput]) -> list[ValidatedSegment]:
    """Deterministic grouping used when the LLM's plan can't be trusted at
    all, or to locally repair one oversized segment from an otherwise-good
    LLM plan. Walks beats in order, starting a new segment when the
    current one would exceed `MAX_SHOTS_PER_SEGMENT`, exceed
    `MAX_IDENTITIES_PER_SEGMENT`, cross a scene boundary once the segment
    already has >= `SOFT_MIN_SEGMENT_SECONDS_BEFORE_SCENE_CUT` seconds, or
    push total seconds past `SOFT_MAX_SEGMENT_SECONDS`."""
    segments: list[ValidatedSegment] = []
    current: list[SegmentPlannerBeatInput] = []
    current_seconds = 0.0

    def flush() -> None:
        nonlocal current, current_seconds
        if not current:
            return
        segments.append(
            ValidatedSegment(
                beat_numbers=[b.beat_number for b in current],
                shot_seconds=[_clamp_seconds(b.estimated_duration) for b in current],
                reason="自动分组（按场景/角色/时长贪心打包）",
            )
        )
        current = []
        current_seconds = 0.0

    prev_scene_id: Optional[str] = None
    for b in beats:
        own_seconds = _clamp_seconds(b.estimated_duration)
        scene_changed = prev_scene_id is not None and b.scene_id and b.scene_id != prev_scene_id
        would_exceed_shots = len(current) + 1 > MAX_SHOTS_PER_SEGMENT
        would_exceed_identities = (
            current and _identity_union_size(current + [b]) > MAX_IDENTITIES_PER_SEGMENT
        )
        would_exceed_soft_cap = current and (current_seconds + own_seconds) > SOFT_MAX_SEGMENT_SECONDS
        prefer_scene_cut = (
            current and scene_changed and current_seconds >= SOFT_MIN_SEGMENT_SECONDS_BEFORE_SCENE_CUT
        )
        if current and (
            would_exceed_shots or would_exceed_identities or would_exceed_soft_cap or prefer_scene_cut
        ):
            flush()
        current.append(b)
        current_seconds += own_seconds
        prev_scene_id = b.scene_id or prev_scene_id
    flush()
    return segments


def validate_and_repair_segment_plan(
    beats: list[SegmentPlannerBeatInput], llm_output: Optional[SegmentPlanLLMOutput]
) -> ValidatedSegmentPlan:
    """Always returns a plan that satisfies every hard constraint. Accepts
    the LLM's grouping (locally repairing any oversized segment) if, and
    only if, its `beat_numbers` form an exact ordered partition of
    `beats` — every beat appears exactly once, in the same relative
    order, with no gaps. Otherwise discards it entirely and uses
    `greedy_fallback_segments()`."""
    by_number = {b.beat_number: b for b in beats}
    expected_order = [b.beat_number for b in beats]

    warnings: list[str] = []
    if llm_output and llm_output.segments:
        flat: list[int] = []
        for seg in llm_output.segments:
            flat.extend(seg.beat_numbers)
        is_exact_partition = (
            sorted(flat) == sorted(expected_order)
            and len(flat) == len(set(flat))
            and flat == expected_order
        )
        if is_exact_partition:
            repaired: list[ValidatedSegment] = []
            did_repair = False
            for seg in llm_output.segments:
                group = [by_number[n] for n in seg.beat_numbers]
                sub_groups = _split_if_needed(group)
                if len(sub_groups) > 1:
                    did_repair = True
                seconds_by_beat = {
                    bn: s
                    for bn, s in zip(seg.beat_numbers, seg.shot_seconds or [])
                }
                for sub in sub_groups:
                    shot_seconds = [
                        _clamp_seconds(seconds_by_beat.get(b.beat_number, b.estimated_duration))
                        for b in sub
                    ]
                    repaired.append(
                        ValidatedSegment(
                            beat_numbers=[b.beat_number for b in sub],
                            shot_seconds=shot_seconds,
                            reason=seg.reason if len(sub_groups) == 1 else f"{seg.reason} (已拆分)",
                        )
                    )
            source = "llm_repaired" if did_repair else "llm"
            if did_repair:
                warnings.append("部分 AI 分段超过单组上限，已自动拆分")
            return ValidatedSegmentPlan(segments=repaired, source=source, warnings=warnings)
        warnings.append("AI 分段结果不是有效的顺序划分（缺漏/重复/乱序），已改用自动分组")

    return ValidatedSegmentPlan(
        segments=greedy_fallback_segments(beats), source="fallback", warnings=warnings
    )


def _split_if_needed(group: list[SegmentPlannerBeatInput]) -> list[list[SegmentPlannerBeatInput]]:
    """Splits one over-the-cap group (too many shots or too many distinct
    characters) into valid sub-groups, greedily, preserving order. A
    group within caps is returned unchanged as a single-element list."""
    if len(group) <= MAX_SHOTS_PER_SEGMENT and _identity_union_size(group) <= MAX_IDENTITIES_PER_SEGMENT:
        return [group]
    out: list[list[SegmentPlannerBeatInput]] = []
    current: list[SegmentPlannerBeatInput] = []
    for b in group:
        if current and (
            len(current) + 1 > MAX_SHOTS_PER_SEGMENT
            or _identity_union_size(current + [b]) > MAX_IDENTITIES_PER_SEGMENT
        ):
            out.append(current)
            current = []
        current.append(b)
    if current:
        out.append(current)
    return out


# ── LLM call ─────────────────────────────────────────────────────────────


def _build_user_prompt(beats: list[SegmentPlannerBeatInput]) -> str:
    lines = ["Beats, in script order:"]
    for b in beats:
        lines.append(
            f"- beat {b.beat_number} (scene={b.scene_id or '(none)'}, "
            f"audio_type={b.audio_type}, speaker={b.speaker or '(none)'}, "
            f"identities={b.identities or '(none)'}, "
            f"~{b.estimated_duration:.1f}s): "
            f"{(b.narration_segment or b.visual_description)[:200]}"
        )
    lines.append(
        "\nGroup these beats into segments following every rule above. "
        "Return every beat exactly once, in the same order given."
    )
    return "\n".join(lines)


def _build_agent() -> Agent:
    from novelvideo.config import get_newapi_structured_output_model_settings, get_newapi_text_pydantic_model

    rules = _load_rules()
    system_prompt = (
        "You are a short-drama segment planner. You split a beat-by-beat "
        "screenplay into short continuous-take segments for video "
        "generation, following the rules below exactly.\n\n" + rules
    )
    return Agent(
        get_newapi_text_pydantic_model("SEGMENT_PLANNER_MODEL", default_model="DC-segment-planner-LLM"),
        system_prompt=system_prompt,
        output_type=SegmentPlanLLMOutput,
        model_settings={**get_newapi_structured_output_model_settings(), "max_tokens": 3000},
        name="Segment Planner",
    )


_agent: Optional[Agent] = None


def get_segment_planner_agent() -> Agent:
    global _agent
    if _agent is None:
        _agent = _build_agent()
    return _agent


async def plan_segments(beats: list[SegmentPlannerBeatInput]) -> ValidatedSegmentPlan:
    """Main entry point: ask the LLM for a grouping, then always run it
    through `validate_and_repair_segment_plan` before returning. A failed
    LLM call (network, quota, malformed output) falls back to the
    deterministic greedy grouping rather than leaving the caller with
    nothing."""
    if not beats:
        return ValidatedSegmentPlan(segments=[], source="fallback")
    try:
        agent = get_segment_planner_agent()
        response = await agent.run(_build_user_prompt(beats))
        llm_output: Optional[SegmentPlanLLMOutput] = response.output
    except Exception:  # noqa: BLE001
        llm_output = None
    return validate_and_repair_segment_plan(beats, llm_output)
