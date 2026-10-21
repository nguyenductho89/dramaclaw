"""Unit tests for `generators/segment_store.py` — sidecar JSON only, no DB."""

from __future__ import annotations

from novelvideo.generators.segment_store import (
    SegmentState,
    load_segment_states,
    replace_all_segments,
    reset_frame_approval_if_stale,
    save_segment_states,
    set_frame_approved,
    set_video_status,
)


def test_load_missing_sidecar_returns_empty(tmp_path):
    assert load_segment_states(tmp_path, 1) == {}


def test_save_and_load_round_trip(tmp_path):
    states = {
        "seg_01": SegmentState(
            chain_id="seg_01", beat_numbers=[1, 2], shot_seconds=[6.0, 7.0], reason="same scene"
        )
    }
    save_segment_states(tmp_path, 1, states)
    loaded = load_segment_states(tmp_path, 1)
    assert loaded["seg_01"].beat_numbers == [1, 2]
    assert loaded["seg_01"].shot_seconds == [6.0, 7.0]
    assert loaded["seg_01"].frame_status == "pending"


def test_replace_all_segments_overwrites_previous(tmp_path):
    save_segment_states(
        tmp_path, 1, {"old": SegmentState(chain_id="old", beat_numbers=[1])}
    )
    replace_all_segments(
        tmp_path,
        1,
        [{"chain_id": "seg_01", "beat_numbers": [1, 2], "shot_seconds": [5, 5], "reason": "r"}],
    )
    loaded = load_segment_states(tmp_path, 1)
    assert "old" not in loaded
    assert loaded["seg_01"].beat_numbers == [1, 2]


def test_set_frame_approved_updates_status_and_fingerprint(tmp_path):
    replace_all_segments(
        tmp_path, 1, [{"chain_id": "seg_01", "beat_numbers": [1], "shot_seconds": [5]}]
    )
    set_frame_approved(tmp_path, 1, "seg_01", fingerprint="abc123")
    loaded = load_segment_states(tmp_path, 1)
    assert loaded["seg_01"].frame_status == "approved"
    assert loaded["seg_01"].frame_fingerprint == "abc123"


def test_set_frame_approved_unknown_chain_returns_none(tmp_path):
    assert set_frame_approved(tmp_path, 1, "nope", fingerprint="x") is None


def test_reset_frame_approval_if_stale_flips_back_to_pending(tmp_path):
    replace_all_segments(
        tmp_path, 1, [{"chain_id": "seg_01", "beat_numbers": [1], "shot_seconds": [5]}]
    )
    set_frame_approved(tmp_path, 1, "seg_01", fingerprint="abc123")
    state = reset_frame_approval_if_stale(tmp_path, 1, "seg_01", current_fingerprint="different")
    assert state.frame_status == "pending"
    assert state.frame_fingerprint == ""
    loaded = load_segment_states(tmp_path, 1)
    assert loaded["seg_01"].frame_status == "pending"


def test_reset_frame_approval_if_stale_noop_when_matching(tmp_path):
    replace_all_segments(
        tmp_path, 1, [{"chain_id": "seg_01", "beat_numbers": [1], "shot_seconds": [5]}]
    )
    set_frame_approved(tmp_path, 1, "seg_01", fingerprint="abc123")
    state = reset_frame_approval_if_stale(tmp_path, 1, "seg_01", current_fingerprint="abc123")
    assert state.frame_status == "approved"


def test_set_video_status(tmp_path):
    replace_all_segments(
        tmp_path, 1, [{"chain_id": "seg_01", "beat_numbers": [1], "shot_seconds": [5]}]
    )
    set_video_status(tmp_path, 1, "seg_01", status="generated")
    loaded = load_segment_states(tmp_path, 1)
    assert loaded["seg_01"].video_status == "generated"
