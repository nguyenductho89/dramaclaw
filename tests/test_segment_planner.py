"""Unit tests for `agents/segment_planner.py` — no network, no DB. Covers
the deterministic validate/repair/fallback logic that the LLM output is
never trusted without (see module docstring)."""

from __future__ import annotations

from novelvideo.agents.segment_planner import (
    MAX_IDENTITIES_PER_SEGMENT,
    MAX_SHOT_SECONDS,
    MAX_SHOTS_PER_SEGMENT,
    MIN_SHOT_SECONDS,
    SegmentPlannerBeatInput,
    SegmentPlanLLMOutput,
    SegmentProposal,
    beat_inputs_from_dicts,
    greedy_fallback_segments,
    validate_and_repair_segment_plan,
)


def _beat(n: int, *, seconds: float = 6.0, scene: str = "s1", identities=None, audio="silence") -> SegmentPlannerBeatInput:
    return SegmentPlannerBeatInput(
        beat_number=n,
        narration_segment=f"line {n}",
        audio_type=audio,
        scene_id=scene,
        identities=list(identities or []),
        estimated_duration=seconds,
    )


# ── greedy_fallback_segments ─────────────────────────────────────────────


def test_greedy_fallback_groups_up_to_three_beats():
    beats = [_beat(1), _beat(2), _beat(3), _beat(4)]
    segments = greedy_fallback_segments(beats)
    beat_numbers = [s.beat_numbers for s in segments]
    assert sum(len(g) for g in beat_numbers) == 4
    assert all(len(g) <= MAX_SHOTS_PER_SEGMENT for g in beat_numbers)
    # every beat appears exactly once, in order
    flat = [n for g in beat_numbers for n in g]
    assert flat == [1, 2, 3, 4]


def test_greedy_fallback_splits_on_identity_cap():
    beats = [
        _beat(1, identities=["A"]),
        _beat(2, identities=["B"]),
        _beat(3, identities=["C"]),
        _beat(4, identities=["D"]),
    ]
    segments = greedy_fallback_segments(beats)
    for seg in segments:
        group = [b for b in beats if b.beat_number in seg.beat_numbers]
        union = {i for b in group for i in b.identities}
        assert len(union) <= MAX_IDENTITIES_PER_SEGMENT


def test_greedy_fallback_prefers_scene_cut_after_soft_minimum():
    beats = [
        _beat(1, seconds=11, scene="s1"),
        _beat(2, seconds=6, scene="s2"),
    ]
    segments = greedy_fallback_segments(beats)
    # beat 1 alone already has >= 10s, so a scene change at beat 2 should
    # start a new segment rather than packing them together.
    assert [s.beat_numbers for s in segments] == [[1], [2]]


def test_greedy_fallback_clamps_seconds():
    beats = [_beat(1, seconds=30.0), _beat(2, seconds=1.0)]
    segments = greedy_fallback_segments(beats)
    all_seconds = [s for seg in segments for s in seg.shot_seconds]
    assert all(MIN_SHOT_SECONDS <= s <= MAX_SHOT_SECONDS for s in all_seconds)


def test_greedy_fallback_empty_input():
    assert greedy_fallback_segments([]) == []


# ── validate_and_repair_segment_plan ────────────────────────────────────


def test_valid_llm_partition_accepted_as_is():
    beats = [_beat(1), _beat(2), _beat(3)]
    llm = SegmentPlanLLMOutput(
        segments=[
            SegmentProposal(beat_numbers=[1, 2], shot_seconds=[6, 7], reason="same scene"),
            SegmentProposal(beat_numbers=[3], shot_seconds=[8], reason="standalone"),
        ]
    )
    plan = validate_and_repair_segment_plan(beats, llm)
    assert plan.source == "llm"
    assert [s.beat_numbers for s in plan.segments] == [[1, 2], [3]]
    assert plan.segments[0].shot_seconds == [6.0, 7.0]


def test_oversized_llm_segment_is_locally_split():
    beats = [_beat(1), _beat(2), _beat(3), _beat(4)]
    llm = SegmentPlanLLMOutput(
        segments=[SegmentProposal(beat_numbers=[1, 2, 3, 4], shot_seconds=[5, 5, 5, 5])]
    )
    plan = validate_and_repair_segment_plan(beats, llm)
    assert plan.source == "llm_repaired"
    beat_numbers = [s.beat_numbers for s in plan.segments]
    assert all(len(g) <= MAX_SHOTS_PER_SEGMENT for g in beat_numbers)
    assert [n for g in beat_numbers for n in g] == [1, 2, 3, 4]


def test_identity_overflow_llm_segment_is_split():
    beats = [
        _beat(1, identities=["A"]),
        _beat(2, identities=["B"]),
        _beat(3, identities=["C"]),
        _beat(4, identities=["D"]),
    ]
    llm = SegmentPlanLLMOutput(
        segments=[SegmentProposal(beat_numbers=[1, 2, 3, 4], shot_seconds=[5, 5, 5, 5])]
    )
    plan = validate_and_repair_segment_plan(beats, llm)
    for seg in plan.segments:
        group = [b for b in beats if b.beat_number in seg.beat_numbers]
        union = {i for b in group for i in b.identities}
        assert len(union) <= MAX_IDENTITIES_PER_SEGMENT


def test_llm_plan_missing_a_beat_falls_back():
    beats = [_beat(1), _beat(2), _beat(3)]
    llm = SegmentPlanLLMOutput(segments=[SegmentProposal(beat_numbers=[1, 2])])  # beat 3 missing
    plan = validate_and_repair_segment_plan(beats, llm)
    assert plan.source == "fallback"
    flat = [n for s in plan.segments for n in s.beat_numbers]
    assert flat == [1, 2, 3]


def test_llm_plan_duplicate_beat_falls_back():
    beats = [_beat(1), _beat(2)]
    llm = SegmentPlanLLMOutput(
        segments=[SegmentProposal(beat_numbers=[1, 1]), SegmentProposal(beat_numbers=[2])]
    )
    plan = validate_and_repair_segment_plan(beats, llm)
    assert plan.source == "fallback"


def test_llm_plan_reordered_falls_back():
    beats = [_beat(1), _beat(2), _beat(3)]
    llm = SegmentPlanLLMOutput(
        segments=[SegmentProposal(beat_numbers=[2, 1]), SegmentProposal(beat_numbers=[3])]
    )
    plan = validate_and_repair_segment_plan(beats, llm)
    assert plan.source == "fallback"


def test_none_llm_output_falls_back():
    beats = [_beat(1), _beat(2)]
    plan = validate_and_repair_segment_plan(beats, None)
    assert plan.source == "fallback"
    flat = [n for s in plan.segments for n in s.beat_numbers]
    assert flat == [1, 2]


def test_empty_beats_returns_empty_plan():
    plan = validate_and_repair_segment_plan([], None)
    assert plan.segments == []


# ── beat_inputs_from_dicts ───────────────────────────────────────────────


def test_beat_inputs_from_dicts_basic_mapping():
    beats = [
        {
            "beat_number": 1,
            "narration_segment": "hello there friend",
            "visual_description": "desc",
            "audio_type": "dialogue",
            "speaker": "Alice",
            "scene_ref": {"scene_id": "park"},
            "detected_identities": ["Alice_young"],
            "estimated_duration": 7.5,
        }
    ]
    out = beat_inputs_from_dicts(beats)
    assert len(out) == 1
    b = out[0]
    assert b.beat_number == 1
    assert b.scene_id == "park"
    assert b.identities == ["Alice_young"]
    assert b.estimated_duration == 7.5


def test_beat_inputs_from_dicts_falls_back_to_narration_length_when_no_estimate():
    beats = [
        {
            "beat_number": 1,
            "narration_segment": "x" * 40,
            "scene_ref": None,
            "detected_identities": [],
            "estimated_duration": 0.0,
        }
    ]
    out = beat_inputs_from_dicts(beats)
    assert out[0].estimated_duration == 10.0  # 40 / 4.0
