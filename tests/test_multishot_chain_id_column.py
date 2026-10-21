"""Integration test for `beats.multishot_chain_id` (added 2026-10-19) —
SQLite roundtrip through the real column-add migration, `update_beat_asset`
and `get_beats_as_dicts`, not a mock."""

from __future__ import annotations

from pathlib import Path

import pytest


def _write_config(state_dir: Path, config: dict) -> None:
    import json

    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "project_config.json").write_text(
        json.dumps(config, ensure_ascii=False), encoding="utf-8"
    )


async def _open_store(state_dir: Path):
    from novelvideo.sqlite_store import SQLiteStore

    store = SQLiteStore("user/project", output_dir=str(state_dir), state_dir=str(state_dir))
    await store.initialize()
    await store.load_graph_state()
    return store


@pytest.fixture
async def project(tmp_path):
    from novelvideo.cognee.pipeline import NovelEpisode
    from novelvideo.knowledge_pipeline import KNOWLEDGE_PIPELINE_KEY, KNOWLEDGE_PIPELINE_STRUCTURED
    from novelvideo.models import NovelVisualBeat

    state_dir = tmp_path / "user" / "project"
    _write_config(state_dir, {KNOWLEDGE_PIPELINE_KEY: KNOWLEDGE_PIPELINE_STRUCTURED})
    store = await _open_store(state_dir)
    await store.add_episodes([NovelEpisode(number=1, title="Episode 1")])
    await store.add_visual_beats(
        [
            NovelVisualBeat(beat_number=1, episode_number=1, narration="a", visual_description="d1"),
            NovelVisualBeat(beat_number=2, episode_number=1, narration="b", visual_description="d2"),
            NovelVisualBeat(beat_number=3, episode_number=1, narration="c", visual_description="d3"),
        ]
    )
    try:
        yield store
    finally:
        await store.close()


async def test_new_column_defaults_to_empty_string(project):
    beats = await project.get_beats_as_dicts(1)
    assert [b["multishot_chain_id"] for b in beats] == ["", "", ""]


async def test_update_beat_asset_sets_and_persists_chain_id(project):
    for beat_num in (1, 2):
        ok = await project.update_beat_asset(
            episode_number=1, beat_number=beat_num, multishot_chain_id="chain-a"
        )
        assert ok is True

    beats = await project.get_beats_as_dicts(1)
    by_num = {b["beat_number"]: b for b in beats}
    assert by_num[1]["multishot_chain_id"] == "chain-a"
    assert by_num[2]["multishot_chain_id"] == "chain-a"
    # beat 3 was never touched — stays unset.
    assert by_num[3]["multishot_chain_id"] == ""


async def test_empty_string_clears_the_chain_id(project):
    await project.update_beat_asset(episode_number=1, beat_number=1, multishot_chain_id="chain-a")
    await project.update_beat_asset(episode_number=1, beat_number=1, multishot_chain_id="")

    beats = await project.get_beats_as_dicts(1)
    assert next(b for b in beats if b["beat_number"] == 1)["multishot_chain_id"] == ""


async def test_update_beat_asset_with_only_multishot_chain_id_touches_no_other_column(project):
    before = await project.get_beats_as_dicts(1)
    before_beat1 = next(b for b in before if b["beat_number"] == 1)

    await project.update_beat_asset(episode_number=1, beat_number=1, multishot_chain_id="chain-x")

    after = await project.get_beats_as_dicts(1)
    after_beat1 = next(b for b in after if b["beat_number"] == 1)
    for key in before_beat1:
        if key == "multishot_chain_id":
            continue
        assert after_beat1[key] == before_beat1[key], key
    assert after_beat1["multishot_chain_id"] == "chain-x"
