"""Unit tests for the MiniMax H3 Multishot chain-resolution/validation
helpers in `api/routes/generation.py` (added 2026-10-19) — no DB, no
network. See `runpod-h3-qwen-endpoints.md` section 5."""

from __future__ import annotations

from novelvideo.api.routes.generation import (
    _multishot_chain_beats,
    _multishot_review_fingerprint,
    _multishot_shared_references,
)


def _beat(beat_number: int, chain_id: str = "", detected_identities=None) -> dict:
    return {
        "beat_number": beat_number,
        "multishot_chain_id": chain_id,
        "detected_identities": detected_identities or [],
    }


# ── _multishot_chain_beats ──────────────────────────────────────────────


def test_empty_chain_id_rejected():
    beats = [_beat(1, "c1")]
    chain, error = _multishot_chain_beats(beats, "")
    assert chain == []
    assert "空" in error


def test_unknown_chain_id_rejected():
    beats = [_beat(1, "c1")]
    chain, error = _multishot_chain_beats(beats, "nope")
    assert chain == []
    assert error


def test_contiguous_chain_resolved_in_order():
    beats = [_beat(1, "other"), _beat(2, "c1"), _beat(3, "c1"), _beat(4, "other")]
    chain, error = _multishot_chain_beats(beats, "c1")
    assert error == ""
    assert [b["beat_number"] for b in chain] == [2, 3]


def test_non_contiguous_chain_rejected():
    # beat 3 (not in the chain) sits between the two chain members.
    beats = [_beat(1, "c1"), _beat(2, "other"), _beat(3, "c1")]
    chain, error = _multishot_chain_beats(beats, "c1")
    assert chain == []
    assert "连续" in error


def test_single_beat_chain_is_valid():
    beats = [_beat(1, "c1")]
    chain, error = _multishot_chain_beats(beats, "c1")
    assert error == ""
    assert len(chain) == 1


# ── _multishot_shared_references ────────────────────────────────────────


def _character_map(tmp_path, *names: str) -> dict:
    out = {}
    for name in names:
        portrait = tmp_path / f"{name}.png"
        portrait.write_bytes(b"fake")
        out[name] = {
            "identities": [],
            "portrait_path": str(portrait),
            "appearance_details": f"{name}'s look",
        }
    return out


def test_shared_references_identical_across_beats(tmp_path):
    cmap = _character_map(tmp_path, "Alice")
    beats = [_beat(1, detected_identities=["Alice"]), _beat(2, detected_identities=["Alice"])]
    shared, error = _multishot_shared_references(cmap, beats)
    assert error == ""
    assert [r["name"] for r in shared] == ["Alice"]


def test_shared_references_mismatch_rejected(tmp_path):
    cmap = _character_map(tmp_path, "Alice", "Bob")
    beats = [_beat(1, detected_identities=["Alice"]), _beat(2, detected_identities=["Bob"])]
    shared, error = _multishot_shared_references(cmap, beats)
    assert shared == []
    assert "不一致" in error


def test_shared_references_all_empty_is_fl2va_ok(tmp_path):
    cmap = _character_map(tmp_path)
    beats = [_beat(1), _beat(2)]
    shared, error = _multishot_shared_references(cmap, beats)
    assert error == ""
    assert shared == []


def test_shared_references_order_matters(tmp_path):
    cmap = _character_map(tmp_path, "Alice", "Bob")
    beats = [
        _beat(1, detected_identities=["Alice", "Bob"]),
        _beat(2, detected_identities=["Bob", "Alice"]),
    ]
    shared, error = _multishot_shared_references(cmap, beats)
    assert shared == []
    assert error


# ── _multishot_review_fingerprint ───────────────────────────────────────


def _fp(**overrides):
    base = dict(
        chain_id="c1",
        script="s",
        checkpoint="fl2va",
        frames_per_shot=124,
        frame_path=None,
        reference_paths=[],
    )
    base.update(overrides)
    return _multishot_review_fingerprint(**base)


def test_fingerprint_deterministic():
    assert _fp() == _fp()


def test_fingerprint_changes_with_script():
    assert _fp(script="a") != _fp(script="b")


def test_fingerprint_changes_with_checkpoint():
    assert _fp(checkpoint="fl2va") != _fp(checkpoint="ref2va")


def test_fingerprint_changes_with_frames_per_shot():
    assert _fp(frames_per_shot=124) != _fp(frames_per_shot=243)


def test_fingerprint_sensitive_to_reference_file_mtime(tmp_path):
    ref = tmp_path / "ref.png"
    ref.write_bytes(b"a")
    fp1 = _fp(reference_paths=[str(ref)])
    ref.write_bytes(b"ab")  # content/mtime changes
    fp2 = _fp(reference_paths=[str(ref)])
    assert fp1 != fp2
