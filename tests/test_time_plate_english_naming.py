from __future__ import annotations

import json
from types import SimpleNamespace

import aiosqlite
import pytest

from novelvideo.agents.asset_compiler import AssetCompiler
from novelvideo.api.routes.scenes import _compose_scene_asset_name, _time_suffix_language
from novelvideo.cognee.scene_name_migration import migrate_time_plate_names
from novelvideo.models import (
    NovelScene,
    resolve_scene_plate,
    resolve_scene_plate_from_records,
)
from novelvideo.time_of_day import time_of_day_label, time_of_day_name_candidates

ENGLISH_BASE = NovelScene(
    name="Kitchen", environment_prompt="A narrow kitchen with a steel counter."
)


def _declare_language(state_dir, language: str) -> None:
    (state_dir / "project_config.json").write_text(
        json.dumps({"asset_language": language}), encoding="utf-8"
    )


class _Store:
    def __init__(self, *scenes: NovelScene, state_dir=None) -> None:
        self.state_dir = state_dir
        self.scenes = {scene.name: scene for scene in scenes}

    async def get_scene(self, name: str):
        return self.scenes.get(name)


def test_time_of_day_labels():
    assert time_of_day_label("夜晚", "en") == "night"
    assert time_of_day_label("夜晚", "zh") == "夜晚"
    assert time_of_day_label("storm", "en") == "storm"
    assert "night" in time_of_day_name_candidates("夜晚")


@pytest.mark.parametrize("plate", ["Kitchen_night", "Kitchen_夜晚"])
def test_plate_resolution_accepts_both_namings(plate):
    assert resolve_scene_plate("Kitchen", "", "夜晚", ["Kitchen", plate]) == (plate, True)
    records = [NovelScene(name="Kitchen"), NovelScene(name=plate)]
    assert resolve_scene_plate_from_records("Kitchen", "", "夜晚", records) == (plate, True)


def test_compiler_names_plates_in_the_script_language():
    episode = SimpleNamespace(number=1)

    english = AssetCompiler._build_time_plate_scene(ENGLISH_BASE, "夜晚", episode, "en")
    chinese = AssetCompiler._build_time_plate_scene(ENGLISH_BASE, "夜晚", episode, "zh")

    assert (english.name, english.time_of_day) == ("Kitchen_night", "夜晚")
    assert chinese.name == "Kitchen_夜晚"


@pytest.mark.asyncio
@pytest.mark.parametrize("existing", ["Kitchen_night", "Kitchen_夜晚"])
async def test_compiler_reuses_a_plate_under_either_naming(existing):
    compiler = AssetCompiler(_Store(NovelScene(name=existing)))

    found = await compiler._find_time_plate("Kitchen", "夜晚", {})

    assert found is not None and found.name == existing


@pytest.mark.parametrize("suffix, language", [("night", "en"), ("夜晚", "zh")])
def test_editing_a_plate_keeps_its_suffix_style(tmp_path, suffix, language):
    # The project says the opposite: an existing name still wins, so assets stay put.
    _declare_language(tmp_path, "zh" if language == "en" else "en")
    name = f"Kitchen_{suffix}"

    chosen = _time_suffix_language(_Store(state_dir=tmp_path), name, "夜晚")

    assert chosen == language
    assert _compose_scene_asset_name(name, "Kitchen", "", "夜晚", time_language=chosen) == name


@pytest.mark.parametrize("language", ["en", "zh"])
def test_a_new_plate_follows_the_project_language(tmp_path, language):
    _declare_language(tmp_path, language)

    assert _time_suffix_language(_Store(state_dir=tmp_path)) == language


async def _seed_project(project_dir, scene_rows):
    async with aiosqlite.connect(project_dir / "data.db") as db:
        await db.execute(
            "CREATE TABLE scenes (name TEXT PRIMARY KEY, aliases_json TEXT, scene_type TEXT,"
            " base_scene_id TEXT, variant_id TEXT, time_of_day TEXT, environment_prompt TEXT,"
            " variant_prompt TEXT, description TEXT, spatial_layout_image TEXT, notes TEXT,"
            " updated_at TEXT)"
        )
        await db.execute(
            "CREATE TABLE beats (episode_number INT, beat_number INT, scene_ref_json TEXT,"
            " updated_at TEXT)"
        )
        for name, base, time, prompt, image in scene_rows:
            await db.execute(
                "INSERT INTO scenes VALUES (?, '[]', 'interior', ?, '', ?, ?, '', '', ?, '', '')",
                (name, base, time, prompt, image),
            )
        await db.execute(
            "INSERT INTO beats VALUES (1, 1, ?, '')",
            (json.dumps({"scene_id": "Kitchen_夜晚"}, ensure_ascii=False),),
        )
        await db.commit()


async def _scene_names(project_dir) -> list[str]:
    async with aiosqlite.connect(project_dir / "data.db") as db:
        async with db.execute("SELECT name FROM scenes ORDER BY name") as cursor:
            return [row[0] for row in await cursor.fetchall()]


@pytest.mark.asyncio
async def test_migration_renames_english_plates_with_beats_and_assets(tmp_path):
    await _seed_project(
        tmp_path,
        [
            ("Kitchen", "", "", ENGLISH_BASE.environment_prompt, ""),
            ("Kitchen_夜晚", "Kitchen", "夜晚", "", "assets/scenes/Kitchen_夜晚/layout.png"),
        ],
    )
    asset = tmp_path / "assets" / "scenes" / "Kitchen_夜晚" / "master.png"
    asset.parent.mkdir(parents=True)
    asset.write_bytes(b"png")

    preview = await migrate_time_plate_names(tmp_path)

    expected = [{"old": "Kitchen_夜晚", "canonical": "Kitchen_night"}]
    assert preview.scene_renames == expected
    assert len(preview.beat_updates) == 1
    assert "Kitchen_夜晚" in await _scene_names(tmp_path)

    applied = await migrate_time_plate_names(tmp_path, dry_run=False)

    assert applied.scene_renames == expected
    assert await _scene_names(tmp_path) == ["Kitchen", "Kitchen_night"]
    assert (tmp_path / "assets" / "scenes" / "Kitchen_night" / "master.png").read_bytes() == b"png"
    async with aiosqlite.connect(tmp_path / "data.db") as db:
        async with db.execute("SELECT scene_ref_json FROM beats") as cursor:
            assert json.loads((await cursor.fetchone())[0]) == {"scene_id": "Kitchen_night"}
        async with db.execute(
            "SELECT spatial_layout_image, time_of_day FROM scenes WHERE name = 'Kitchen_night'"
        ) as cursor:
            assert await cursor.fetchone() == (
                "assets/scenes/Kitchen_night/layout.png",
                "夜晚",
            )


@pytest.mark.asyncio
async def test_migration_skips_a_taken_target(tmp_path):
    await _seed_project(
        tmp_path,
        [
            ("Kitchen", "", "", ENGLISH_BASE.environment_prompt, ""),
            ("Kitchen_夜晚", "Kitchen", "夜晚", "", ""),
            ("Kitchen_night", "Kitchen", "夜晚", "", ""),
        ],
    )

    report = await migrate_time_plate_names(tmp_path, dry_run=False)

    assert report.scene_renames == []
    assert any("already exists" in warning for warning in report.warnings)


@pytest.mark.asyncio
async def test_migration_leaves_a_chinese_project_alone(tmp_path):
    _declare_language(tmp_path, "zh")
    await _seed_project(
        tmp_path, [("厨房", "", "", "", ""), ("厨房_夜晚", "厨房", "夜晚", "", "")]
    )

    report = await migrate_time_plate_names(tmp_path, dry_run=False)

    assert report.scene_renames == []
    assert await _scene_names(tmp_path) == ["厨房", "厨房_夜晚"]
