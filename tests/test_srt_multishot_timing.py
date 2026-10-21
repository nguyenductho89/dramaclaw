"""`build_srt_content` must use a multishot segment beat's planned
`duration_seconds` instead of falling back to the hardcoded 5.0s default
(it never gets its own TTS mp3) — see
`.claude/CLAUDE.md`'s "Segment multishot" section."""

from __future__ import annotations

import pytest

from novelvideo.export.episode_export import build_srt_content

pytestmark = pytest.mark.m09


@pytest.mark.asyncio
async def test_chain_beat_uses_planned_duration_not_hardcoded_default(tmp_path):
    beats = [
        {
            "beat_number": 1,
            "narration_segment": "hello",
            "multishot_chain_id": "seg_ep001_01",
            "duration_seconds": 8.0,
        }
    ]
    srt = await build_srt_content(tmp_path, 1, beats)
    assert "00:00:00,000 --> 00:00:08,000" in srt


@pytest.mark.asyncio
async def test_chain_beat_without_duration_falls_back_to_five_seconds(tmp_path):
    beats = [
        {
            "beat_number": 1,
            "narration_segment": "hello",
            "multishot_chain_id": "seg_ep001_01",
            "duration_seconds": 0,
        }
    ]
    srt = await build_srt_content(tmp_path, 1, beats)
    assert "00:00:00,000 --> 00:00:05,000" in srt


@pytest.mark.asyncio
async def test_non_chain_beat_unaffected(tmp_path):
    beats = [{"beat_number": 1, "narration_segment": "hello"}]
    srt = await build_srt_content(tmp_path, 1, beats)
    assert "00:00:00,000 --> 00:00:05,000" in srt


@pytest.mark.asyncio
async def test_multi_beat_chain_accumulates_sequentially(tmp_path):
    beats = [
        {
            "beat_number": 1,
            "narration_segment": "first",
            "multishot_chain_id": "seg_ep001_01",
            "duration_seconds": 6.0,
        },
        {
            "beat_number": 2,
            "narration_segment": "second",
            "multishot_chain_id": "seg_ep001_01",
            "duration_seconds": 7.0,
        },
    ]
    srt = await build_srt_content(tmp_path, 1, beats)
    assert "00:00:00,000 --> 00:00:06,000" in srt
    assert "00:00:06,000 --> 00:00:13,000" in srt
