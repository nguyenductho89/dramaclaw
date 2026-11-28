"""Scene section headings and reference names follow the project's asset language."""

from __future__ import annotations

import json
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.api.routes import scenes as scene_routes
from novelvideo.api.schemas import SceneCreate
from novelvideo.cognee.pipeline import (
    normalize_scene_environment_prompt,
    parse_scene_environment_sections,
)
from novelvideo.models import NovelScene, build_scene_effective_prompt
from novelvideo.scene_headings import SCENE_HEADINGS, localize_scene_headings
from novelvideo.seedance2_i2v.assets import build_seedance2_project_assets
from novelvideo.seedance2_i2v.models import Seedance2I2VMode
from novelvideo.sqlite_store import SQLiteStore

CJK = re.compile(r"[一-鿿]")

STORED_ZH_HEADINGS = "\n".join(f"{heading}：Brick wall {n}." for n, heading in enumerate(SCENE_HEADINGS))
ENGLISH = "\n".join(
    f"{heading}: Brick wall {n}."
    for n, heading in enumerate(
        ("FRONT", "LEFT", "RIGHT", "BACK", "LIGHTING", "MATERIALS/STYLE", "FORBIDDEN")
    )
)


def _state_dir(tmp_path: Path, language: str) -> Path:
    state_dir = tmp_path / "state"
    state_dir.mkdir(exist_ok=True)
    (state_dir / "project_config.json").write_text(
        json.dumps({"asset_language": language}), encoding="utf-8"
    )
    return state_dir


def _store(tmp_path: Path, language: str) -> SQLiteStore:
    return SQLiteStore(
        "user/project",
        output_dir=str(tmp_path / "output"),
        state_dir=str(_state_dir(tmp_path, language)),
    )


def test_headings_translate_both_ways_and_leave_bodies_alone():
    assert localize_scene_headings(STORED_ZH_HEADINGS, "en") == ENGLISH
    assert localize_scene_headings(ENGLISH, "zh") == STORED_ZH_HEADINGS
    assert localize_scene_headings(ENGLISH, "en") == ENGLISH


def test_one_line_contract_is_relabelled_without_touching_prose():
    text = "正面：A door; the back: stays. 左侧：A wall."

    assert localize_scene_headings(text, "en") == "FRONT: A door; the back: stays. LEFT: A wall."


def test_parser_reads_english_headings_under_the_canonical_keys():
    assert [key for key, _body in parse_scene_environment_sections(ENGLISH)] == list(SCENE_HEADINGS)
    assert normalize_scene_environment_prompt(ENGLISH) == STORED_ZH_HEADINGS


@pytest.mark.asyncio
async def test_english_project_stores_english_headings_on_add_and_update(tmp_path):
    store = _store(tmp_path, "en")
    try:
        await store.add_scene(NovelScene(name="Street", environment_prompt=STORED_ZH_HEADINGS))
        assert (await store.get_scene("Street")).environment_prompt == ENGLISH

        await store.update_scene("Street", environment_prompt="正面：A new door.")
        assert (await store.get_scene("Street")).environment_prompt == "FRONT: A new door."
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_scenes_saved_earlier_are_relabelled_when_the_project_opens(tmp_path):
    store = _store(tmp_path, "en")
    try:
        db = await store._ensure_db()
        await db.execute(
            "INSERT INTO scenes (name, environment_prompt, updated_at) VALUES (?, ?, ?)",
            ("Street", STORED_ZH_HEADINGS, "2020-01-01 00:00:00"),
        )
        await db.commit()
    finally:
        await store.close()

    reopened = _store(tmp_path, "en")
    try:
        scene = await reopened.get_scene("Street")
    finally:
        await reopened.close()

    assert scene.environment_prompt == ENGLISH
    assert scene.updated_at == "2020-01-01 00:00:00"


@pytest.mark.parametrize("mode", list(Seedance2I2VMode))
def test_english_reference_names_and_notes_have_no_chinese(tmp_path, mode):
    assets = build_seedance2_project_assets(
        project_output=tmp_path / "output",
        state_dir=_state_dir(tmp_path, "en"),
        episode=1,
        beat={
            "beat_number": 1,
            "scene_ref": {"scene_id": "Chicago Street"},
            "detected_props": ["phone"],
            "audio_type": "narration",
        },
        mode=mode,
    )

    assert assets
    assert [text for a in assets for text in (a.label, a.note) if CJK.search(text)] == []
    if mode == Seedance2I2VMode.MULTIMODAL_REFERENCE:
        labels = {asset.label for asset in assets}
        assert {"Scene anchor · Chicago Street", "Episode prop · phone"} <= labels


def test_chinese_reference_names_are_unchanged(tmp_path):
    assets = build_seedance2_project_assets(
        project_output=tmp_path / "output",
        state_dir=_state_dir(tmp_path, "zh"),
        episode=1,
        beat={"beat_number": 1, "scene_ref": {"scene_id": "街道"}, "detected_props": ["手机"]},
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
    )

    assert {"场景锚点 · 街道", "剧集道具 · 手机"} <= {asset.label for asset in assets}


def test_time_plate_effective_prompt_follows_the_language():
    base = NovelScene(name="Street", environment_prompt=ENGLISH)
    plate = NovelScene(name="Street_dawn", base_scene_id="Street", time_of_day="清晨")

    english = build_scene_effective_prompt(plate, base, "en")

    assert CJK.findall(english) == []
    assert "Overall lighting: dawn." in english
    assert "整体光照为清晨时段" in build_scene_effective_prompt(plate, base, "zh")


@pytest.mark.asyncio
async def test_create_scene_response_shows_the_stored_headings(tmp_path, monkeypatch):
    store = _store(tmp_path, "en")
    ctx = SimpleNamespace(project_id="proj", state_dir=tmp_path / "state")

    async def resolve(project, user, *, required_role="editor"):
        return ctx, "user", "project", tmp_path / "output", str(tmp_path / "output"), store

    monkeypatch.setattr(scene_routes, "_resolve_scene_project", resolve)
    monkeypatch.setattr(scene_routes, "_scene_payload", lambda scene, **_kwargs: scene)
    try:
        response = await scene_routes.create_scene(
            project="proj",
            body=SceneCreate(name="Street", environment_prompt=STORED_ZH_HEADINGS),
            user={},
        )
    finally:
        await store.close()

    assert response["data"].environment_prompt == ENGLISH
