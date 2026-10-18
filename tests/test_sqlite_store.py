"""Storage-layer refactor verification tests -- SQLite + Kuzu.

Verification points:
1. Import raises no error
2. Create a project → data.db generated,3 tables exist
3. novel.txt write/read back
4. characters table write, in-memory cache sync
5. episodes table + beats table write
6. beats updates work
7. load_graph_state from SQLite restores the cache
"""

import asyncio
import json
from pathlib import Path

import pytest


# ── 1. Import raises no error ──────────────────────────────────────────
def test_import():
    from novelvideo.cognee.store import CogneeStore  # noqa: F401
    from novelvideo.cognee.pipeline import (
        NovelCharacter,
        NovelEvent,  # noqa: F401
    )

    # Confirm it no longer depends on DataPoint
    from novelvideo.cognee.pipeline import NovelCharacter
    from pydantic import BaseModel

    assert issubclass(NovelCharacter, BaseModel)
    # Confirm there is no DataPoint base class
    for cls in NovelCharacter.__mro__:
        assert "DataPoint" not in cls.__name__


# ── Fixture: temporary project directory + store ─────────────────────────
@pytest.fixture
async def tmp_project(tmp_path):
    """Create a temporary project directory and CogneeStore(skipping Cognee initialization)."""
    from novelvideo.cognee.store import CogneeStore

    project_dir = tmp_path / "testuser" / "testproject"
    project_dir.mkdir(parents=True)

    store = CogneeStore.__new__(CogneeStore)
    store.project_name = "testuser/testproject"
    store.dataset_name = "novelvideo_testuser/testproject"
    store._db = None
    store._characters = {}
    store._episodes = {}
    store._alias_index = {}
    store.project_dir = str(project_dir)
    store.state_dir = str(project_dir)
    store.db_path = str(project_dir / "data.db")

    try:
        yield store
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_build_characters_from_graph_only_adds_missing_characters(tmp_project, monkeypatch):
    from novelvideo.cognee import pipeline
    from novelvideo.models import CharacterIdentity, NovelCharacter

    existing = NovelCharacter(
        name="Lin Wan",
        aliases=["Xiaowan"],
        role="protagonist",
        description="user-edited character description",
        face_prompt="user-edited face prompt",
        reference_audio_path="voices/linwan.wav",
    )
    existing.identities = [
        CharacterIdentity(
            identity_id="Lin Wan_uniform",
            character_name="Lin Wan",
            identity_name="uniform",
            appearance_details="Blue and white school uniform",
        )
    ]
    await tmp_project.add_character(existing)
    await tmp_project.add_character(NovelCharacter(name="Manual Character", description="added by hand"))

    async def fake_extract_characters_from_graph(**_kwargs):
        return [
            NovelCharacter(
                name="Lin Wan",
                description="new graph description must not overwrite",
                face_prompt="new graph face must not overwrite",
            ),
            NovelCharacter(name="New Character", description="new character from the graph"),
        ]

    monkeypatch.setattr(
        pipeline,
        "extract_characters_from_graph",
        fake_extract_characters_from_graph,
    )
    tmp_project.save_novel_content("剧本文本")

    added = await tmp_project.build_characters_from_graph()

    assert [char.name for char in added] == ["New Character"]
    preserved = tmp_project.get_character("Lin Wan")
    assert preserved is not None
    assert preserved.description == "user-edited character description"
    assert preserved.face_prompt == "user-edited face prompt"
    assert preserved.reference_audio_path == "voices/linwan.wav"
    assert [identity.identity_id for identity in preserved.identities] == ["Lin Wan_uniform"]
    assert tmp_project.get_character("Manual Character") is not None
    assert tmp_project.get_character("New Character") is not None


@pytest.mark.asyncio
async def test_ingest_novel_reuses_graph_based_build_steps(tmp_project, tmp_path, monkeypatch):
    from novelvideo.models import NovelCharacter, NovelEpisode

    novel_path = tmp_path / "novel.txt"
    novel_path.write_text("Lin Zhao walked into the bell tower.", encoding="utf-8")
    calls: list[str] = []

    async def fake_ingest_novel_fast(novel_path_arg, rebuild=False, on_progress=None, on_log=None):
        calls.append(f"fast:{Path(novel_path_arg).name}:{rebuild}")
        tmp_project.save_novel_content("Lin Zhao walked into the bell tower.")
        return {"char_count": 7, "dataset": tmp_project.dataset_name, "status": "graph_ready"}

    async def fake_build_characters_from_graph(on_progress=None, on_log=None):
        calls.append("characters")
        character = NovelCharacter(name="Lin Zhao", description="watchmaker")
        await tmp_project.add_character(character)
        return [character]

    class FakePlanner:
        def __init__(self, store):
            assert store is tmp_project

        async def plan_episodes(
            self,
            target_episodes=10,
            on_progress=None,
            on_log=None,
        ):
            del on_progress, on_log
            calls.append(f"episodes:{target_episodes}")
            return [
                NovelEpisode(
                    number=1,
                    title="Letter from the Bell Tower",
                    content_summary="Lin Zhao finds a clue about his father.",
                )
            ]

    monkeypatch.setattr(tmp_project, "ingest_novel_fast", fake_ingest_novel_fast)
    monkeypatch.setattr(tmp_project, "build_characters_from_graph", fake_build_characters_from_graph)
    monkeypatch.setattr(
        "novelvideo.agents.episode_planner.EpisodePlannerAgent",
        FakePlanner,
    )

    result = await tmp_project.ingest_novel(
        str(novel_path),
        rebuild=True,
        target_episodes=1,
    )

    assert calls == ["fast:novel.txt:True", "characters", "episodes:1"]
    assert result == {
        "char_count": 7,
        "dataset": tmp_project.dataset_name,
        "characters": 1,
        "episodes": 1,
    }


@pytest.mark.asyncio
async def test_build_scenes_from_graph_only_adds_missing_base_scenes(tmp_project, monkeypatch):
    from novelvideo.cognee import pipeline
    from novelvideo.models import NovelScene

    await tmp_project.sqlite_store.add_scene(
        NovelScene(
            name="City Street",
            scene_type="exterior",
            environment_prompt="user-edited base scene",
        )
    )
    await tmp_project.sqlite_store.add_scene(
        NovelScene(
            name="City Street_rainy_night",
            scene_type="exterior",
            base_scene_id="City Street",
            variant_id="rainy_night",
            variant_prompt="user-edited rainy-night delta",
        )
    )

    graph_calls = []

    async def fake_extract_scenes_from_graph(**kwargs):
        graph_calls.append(kwargs)
        return [
            NovelScene(
                name="City Street",
                scene_type="exterior",
                environment_prompt="new graph description must not overwrite",
            ),
            NovelScene(name="New Scene", scene_type="interior", environment_prompt="newly added scene"),
        ]

    monkeypatch.setattr(pipeline, "extract_scenes_from_graph", fake_extract_scenes_from_graph)
    tmp_project.save_novel_content("剧本文本")

    added = await tmp_project.build_scenes_from_graph()

    assert len(graph_calls) == 1
    assert graph_calls[0]["dataset_name"] == tmp_project.dataset_name
    assert graph_calls[0]["project_name"] == tmp_project.project_name
    assert graph_calls[0]["state_dir"] == tmp_project.state_dir
    assert [scene.name for scene in added] == ["New Scene"]
    base = await tmp_project.sqlite_store.get_scene("City Street")
    assert base is not None
    assert base.environment_prompt == "user-edited base scene"
    derived = await tmp_project.sqlite_store.get_scene("City Street_rainy_night")
    assert derived is not None
    assert derived.base_scene_id == "City Street"
    assert derived.variant_prompt == "user-edited rainy-night delta"
    assert await tmp_project.sqlite_store.get_scene("New Scene") is not None


@pytest.mark.asyncio
async def test_build_scenes_from_graph_repairs_its_own_boilerplate(
    tmp_project, monkeypatch
):
    """Legacy projects get the same repair as structured ones.

    While the contract validator rejected valid single-line model output, every
    scene built on this track stored generated boilerplate. Skipping existing
    scenes on rebuild would leave those projects on it permanently, so a stored
    prompt carrying the fallback fingerprint is replaced — and nothing else is.
    """
    from novelvideo.cognee import pipeline
    from novelvideo.models import NovelScene

    boilerplate = pipeline._ensure_directional_environment_prompt(
        prompt="",
        scene_name="Director Office",
        scene_type="interior",
        time_of_day="",
        context_lines=["▲Zhang Bingquan sits behind the desk leafing through files."],
    )
    assert pipeline.SCENE_FALLBACK_FINGERPRINT_EN in boilerplate

    await tmp_project.sqlite_store.add_scene(
        NovelScene(
            name="Director Office",
            scene_type="interior",
            environment_prompt=boilerplate,
            spatial_layout_image="/generated/plate.png",
            notes="manual notes",
        )
    )

    real = (
        "Front: the main wall is flat and plain, with the unit emblem hung in the center and a desk below."
        "Left: a light solid wall joins front and back, with a frosted-glass wooden door near the front."
        "Right: the wall extends to the rear, with a large window and venetian blinds."
        "Back: the wall opposite the main wall is complete and straight, with a built-in file cabinet."
    )

    async def fake_extract_scenes_from_graph(**_kwargs):
        return [
            NovelScene(
                name="Director Office", scene_type="interior", environment_prompt=real
            )
        ]

    monkeypatch.setattr(
        pipeline, "extract_scenes_from_graph", fake_extract_scenes_from_graph
    )
    tmp_project.save_novel_content("剧本文本")

    added = await tmp_project.build_scenes_from_graph()

    assert added == []  # a repair is not an addition
    scene = await tmp_project.sqlite_store.get_scene("Director Office")
    assert pipeline.SCENE_FALLBACK_FINGERPRINT_EN not in scene.environment_prompt
    assert "unit emblem" in scene.environment_prompt
    # Only the prompt moved; generated assets and human notes stay put.
    assert scene.spatial_layout_image == "/generated/plate.png"
    assert scene.notes == "manual notes"


@pytest.mark.asyncio
async def test_build_scenes_from_graph_keeps_boilerplate_over_invalid_output(
    tmp_project, monkeypatch
):
    """A malformed rebuild must not overwrite storage with something worse."""
    from novelvideo.cognee import pipeline
    from novelvideo.models import NovelScene

    boilerplate = pipeline._ensure_directional_environment_prompt(
        prompt="",
        scene_name="Director Office",
        scene_type="interior",
        time_of_day="",
        context_lines=["▲Zhang Bingquan sits behind the desk leafing through files."],
    )
    await tmp_project.sqlite_store.add_scene(
        NovelScene(
            name="Director Office",
            scene_type="interior",
            environment_prompt=boilerplate,
        )
    )

    async def fake_extract_scenes_from_graph(**_kwargs):
        return [
            NovelScene(
                name="Director Office", scene_type="interior", environment_prompt="Front: a"
            )
        ]

    monkeypatch.setattr(
        pipeline, "extract_scenes_from_graph", fake_extract_scenes_from_graph
    )
    tmp_project.save_novel_content("剧本文本")

    await tmp_project.build_scenes_from_graph()

    scene = await tmp_project.sqlite_store.get_scene("Director Office")
    assert scene.environment_prompt == boilerplate


@pytest.mark.asyncio
async def test_graph_rebuild_waits_only_for_scene_graph_query(
    tmp_project,
    monkeypatch,
):
    from novelvideo.cognee import pipeline
    from novelvideo.cognee.ladybug_access import ladybug_graph_access
    from novelvideo.graph_preview import (
        acquire_graph_preview_lock_async,
        release_graph_preview_lock,
    )

    graph_read_started = asyncio.Event()
    finish_graph_read = asyncio.Event()
    enrichment_started = asyncio.Event()
    finish_enrichment = asyncio.Event()

    async def staged_extract_scenes_from_graph(**kwargs):
        async with ladybug_graph_access(kwargs["state_dir"], read_only=True):
            graph_read_started.set()
            await finish_graph_read.wait()
        enrichment_started.set()
        await finish_enrichment.wait()
        return []

    monkeypatch.setattr(
        pipeline,
        "extract_scenes_from_graph",
        staged_extract_scenes_from_graph,
    )
    tmp_project.save_novel_content("剧本文本")

    read_task = asyncio.create_task(tmp_project.build_scenes_from_graph())
    await asyncio.wait_for(graph_read_started.wait(), timeout=1)

    rebuild_lock_task = asyncio.create_task(
        acquire_graph_preview_lock_async(tmp_project.state_dir)
    )
    await asyncio.sleep(0.1)
    assert not rebuild_lock_task.done()

    finish_graph_read.set()
    await asyncio.wait_for(enrichment_started.wait(), timeout=1)
    rebuild_lock = await asyncio.wait_for(rebuild_lock_task, timeout=1)
    assert not read_task.done()
    release_graph_preview_lock(rebuild_lock)

    finish_enrichment.set()
    assert await asyncio.wait_for(read_task, timeout=1) == []


@pytest.mark.asyncio
async def test_graph_build_steps_reject_missing_novel(tmp_project):
    with pytest.raises(ValueError, match="^Import a novel first$"):
        await tmp_project.build_characters_from_graph()

    with pytest.raises(ValueError, match="^Import a novel first$"):
        await tmp_project.build_scenes_from_graph()


@pytest.mark.asyncio
async def test_scene_round_trip_and_update_with_structured_scene_axes(tmp_path):
    from novelvideo.models import NovelScene
    from novelvideo.sqlite_store import SQLiteStore

    store = SQLiteStore(
        "admin/demo",
        output_dir=str(tmp_path / "output"),
        state_dir=str(tmp_path / "state"),
    )
    try:
        await store.add_scene(
            NovelScene(
                name="Palace_snowy",
                base_scene_id="Palace",
                variant_id="snowy",
                time_of_day="night",
                aliases=["Palace"],
                scene_type="exterior",
                environment_prompt="The Palace in snow",
                variant_prompt="Only change the snow depth and the icicles on the palace wall",
            )
        )

        found = await store.get_scene("Palace_snowy")
        assert found is not None
        assert found.base_scene_id == "Palace"
        assert found.variant_id == "snowy"
        assert found.time_of_day == "night"
        assert found.variant_prompt == "Only change the snow depth and the icicles on the palace wall"

        await store.update_scene(
            "Palace_snowy",
            environment_prompt="The Palace in a blizzard",
            variant_prompt="Thicker snow covers the eaves",
            time_of_day="dusk",
        )
        updated = await store.get_scene("Palace_snowy")
        assert updated is not None
        assert updated.environment_prompt == "The Palace in a blizzard"
        assert updated.variant_prompt == "Thicker snow covers the eaves"
        assert updated.time_of_day == "dusk"

        listed = await store.list_scenes()
        assert [scene.name for scene in listed] == ["Palace_snowy"]
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_duplicate_main_repair_works_without_graph_cache(tmp_path):
    """The lightweight character list must be able to repair legacy rows."""

    from novelvideo.api.routes.characters import _repair_duplicate_main_characters
    from novelvideo.models import NovelCharacter
    from novelvideo.sqlite_store import SQLiteStore

    store = SQLiteStore(
        "admin/demo",
        output_dir=str(tmp_path / "output"),
        state_dir=str(tmp_path / "state"),
    )
    try:
        await store.add_character(NovelCharacter(name="A", is_main=True))
        await store.add_character(NovelCharacter(name="B", is_main=True))
        store._characters.clear()

        rows = await store.list_characters()
        repaired = await _repair_duplicate_main_characters(store, rows)

        assert [row.name for row in repaired if row.is_main] == ["A"]
        persisted = {row.name: row for row in await store.list_characters()}
        assert persisted["A"].is_main is True
        assert persisted["B"].is_main is False
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_add_scene_is_idempotent_by_scene_name(tmp_path):
    from novelvideo.models import NovelScene
    from novelvideo.sqlite_store import SQLiteStore

    store = SQLiteStore(
        "admin/demo",
        output_dir=str(tmp_path / "output"),
        state_dir=str(tmp_path / "state"),
    )
    try:
        await store.add_scene(NovelScene(name="Palace"))
        await store.add_scene(NovelScene(name="Imperial Palace"))

        await store.add_scene(
            NovelScene(
                name="Palace_snowy",
                environment_prompt="First-version snow scene",
            )
        )
        await store.add_scene(
            NovelScene(
                name="Palace_snowy",
                environment_prompt="Updated blizzard",
            )
        )

        scenes = await store.list_scenes()
        derived = [scene for scene in scenes if scene.name == "Palace_snowy"]
        assert len(derived) == 1
        assert derived[0].name == "Palace_snowy"
        assert derived[0].environment_prompt == "Updated blizzard"

        assert sorted(scene.name for scene in scenes) == ["Palace", "Palace_snowy", "Imperial Palace"]
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_add_scene_concurrent_same_name_keeps_single_row(tmp_path):
    from novelvideo.models import NovelScene
    from novelvideo.sqlite_store import SQLiteStore

    store = SQLiteStore(
        "admin/demo",
        output_dir=str(tmp_path / "output"),
        state_dir=str(tmp_path / "state"),
    )
    try:
        await store.add_scene(NovelScene(name="Palace"))

        await asyncio.gather(
            store.add_scene(
                NovelScene(
                    name="Palace_snowy",
                    description="worker a",
                )
            ),
            store.add_scene(
                NovelScene(
                    name="Palace_snowy",
                    description="worker b",
                )
            ),
        )

        scenes = await store.list_scenes()
        derived = [scene for scene in scenes if scene.name == "Palace_snowy"]
        assert len(derived) == 1
        assert derived[0].name == "Palace_snowy"
        assert derived[0].description in {"worker a", "worker b"}
    finally:
        await store.close()


def test_compose_derived_scene_name_uses_ascii_underscore():
    from novelvideo.utils.derived_scenes import (
        compose_derived_scene_name,
        derived_scene_ids,
        resolve_base_of,
    )

    assert compose_derived_scene_name("Palace", "snowy") == "Palace_snowy"
    assert compose_derived_scene_name("Imperial Palace_Great Hall", "snow_night") == "Imperial Palace_Great Hall_snow_night"
    names = {"Palace", "Palace_snowy", "Palace_West Side Hall", "Palace_West Side Hall_snowy", "Imperial Garden"}
    assert derived_scene_ids("Palace", names) == {
        "Palace_snowy",
        "Palace_West Side Hall",
        "Palace_West Side Hall_snowy",
    }
    assert resolve_base_of("Palace_West Side Hall_snowy", names) == "Palace_West Side Hall"
    assert resolve_base_of("Imperial Garden", names) == "Imperial Garden"


# ── 2. data.db generation + 3  tables ───────────────────────────────
@pytest.mark.asyncio
async def test_db_creation(tmp_project):
    store = tmp_project
    db = await store._ensure_db()

    # data.db file exists
    assert Path(store.db_path).exists()

    # 3  tables
    async with db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name") as cur:
        tables = [r[0] for r in await cur.fetchall()]

    assert "beats" in tables
    assert "characters" in tables
    assert "episodes" in tables


# ── 3. novel.txt write/read back ─────────────────────────────────
@pytest.mark.asyncio
async def test_novel_content(tmp_project):
    store = tmp_project
    content = "This is a piece of test novel content used to verify the storage-layer refactor." * 100

    store.save_novel_content(content)

    novel_path = Path(store.project_dir) / "novel.txt"
    assert novel_path.exists()

    loaded = store.load_novel_content()
    assert loaded == content


# ── 4. characters write + in-memory cache ──────────────────────────
@pytest.mark.asyncio
async def test_character_crud(tmp_project):
    from novelvideo.cognee.pipeline import NovelCharacter

    store = tmp_project
    await store._ensure_db()

    char = NovelCharacter(
        name="Su Qingyan",
        aliases=["Qingyan", "Miss Su"],
        role="protagonist",
        is_main=True,
        gender="female",
        body_type="slender and tall",
        description="A gentle and clever young lady of good family",
        face_prompt="Female, early twenties, long black hair, almond eyes, fair skin",
    )

    await store.add_character(char)

    # in-memory cache
    assert "Su Qingyan" in store._characters
    assert store._alias_index.get("Qingyan") == "Su Qingyan"

    # Query
    found = store.get_character("Qingyan")
    assert found is not None
    assert found.name == "Su Qingyan"
    assert found.gender == "female"

    # Update
    await store.update_character("Su Qingyan", description="A brilliant legitimate daughter")
    assert store.get_character("Su Qingyan").description == "A brilliant legitimate daughter"

    # list from SQLite read
    chars = await store.list_characters()
    assert len(chars) == 1
    assert chars[0].name == "Su Qingyan"
    assert chars[0].aliases == ["Qingyan", "Miss Su"]

    # Delete
    await store.delete_character("Su Qingyan")
    assert store.get_character("Su Qingyan") is None
    chars = await store.list_characters()
    assert len(chars) == 0


# ── 5. episodes + beats write ───────────────────────────────
@pytest.mark.asyncio
async def test_episode_and_beats(tmp_project):
    from novelvideo.cognee.pipeline import NovelEpisode, NovelVisualBeat

    store = tmp_project
    await store._ensure_db()

    # Add an episode
    ep = NovelEpisode(
        number=1,
        title="Episode One",
        content_summary="Test summary",
        key_events=["event1", "event2"],
        character_names=["Su Qingyan"],
    )
    await store.add_episodes([ep])

    # Save the episode source text
    await store.save_episode_content(1, "This is the full source text of episode one")
    loaded = await store.load_episode_content(1)
    assert loaded == "This is the full source text of episode one"

    # List episodes
    episodes = await store.list_episodes()
    assert len(episodes) == 1
    assert episodes[0].title == "Episode One"
    assert episodes[0].key_events == ["event1", "event2"]

    # Add beats
    beats = [
        NovelVisualBeat(
            beat_number=i,
            episode_number=1,
            narration=f"No. {i} narration of beat",
            visual_description=f"Scene description {i}",
            time_of_day="dusk",
        )
        for i in range(3)
    ]
    await store.add_visual_beats(beats)

    # Query beats
    loaded_beats = await store.get_beats_for_episode(1)
    assert len(loaded_beats) == 3
    assert loaded_beats[0].time_of_day == "dusk"

    # get_beats_as_dicts
    dicts = await store.get_beats_as_dicts(1)
    assert len(dicts) == 3
    assert dicts[0]["narration_segment"] == "No. 0 narration of beat"


@pytest.mark.asyncio
async def test_count_beats_by_episode_groups_in_one_query(tmp_project):
    """The shot count of the episode list takes one grouped query; episodes without shots do not appear in the result.

    This method exists to replace "the frontend pulling the full beats then take len()".
    """
    from novelvideo.cognee.pipeline import NovelEpisode, NovelVisualBeat

    store = tmp_project
    await store._ensure_db()
    await store.add_episodes([NovelEpisode(number=n, title=f"No. {n}episode") for n in (1, 2, 3)])

    await store.add_visual_beats(
        [
            NovelVisualBeat(beat_number=i, episode_number=1, narration="", visual_description="")
            for i in range(3)
        ]
        + [
            NovelVisualBeat(beat_number=i, episode_number=3, narration="", visual_description="")
            for i in range(5)
        ]
    )

    counts = await store.count_beats_by_episode()

    assert counts == {1: 3, 3: 5}
    # No.  2 episode 2 has not been split into shots yet -- absent rather than 0, the route layer uses .get(number, 0) filled in.
    assert 2 not in counts


@pytest.mark.asyncio
async def test_count_beats_by_episode_on_empty_project(tmp_project):
    store = tmp_project
    await store._ensure_db()

    assert await store.count_beats_by_episode() == {}


@pytest.mark.asyncio
async def test_list_beat_asset_refs_returns_reference_columns_in_order(tmp_project):
    """The six fields read back from the narrow columns must match the full beat match, including scene_ref decoding.

    The asset reverse index uses it to replace ``list_visual_beats()``. The field names are the same as in ``NovelVisualBeat``
    (including ``scene_ref`` property) so that the scan code can treat both shapes alike -- this test
    pins down this equivalence.
    """
    from novelvideo.models import SceneRef
    from novelvideo.cognee.pipeline import NovelVisualBeat

    store = tmp_project
    await store._ensure_db()
    await store.add_visual_beats(
        [
            NovelVisualBeat(
                beat_number=2,
                episode_number=1,
                narration="narration",
                visual_description="[[Wine Glass]] sits on the table",
                detected_identities_json='["Su Qingyan_teen"]',
                detected_props_json='["Wine Glass"]',
                scene_ref_json=SceneRef(scene_id="Study", variant_id="").model_dump_json(),
            ),
            NovelVisualBeat(
                beat_number=1,
                episode_number=1,
                narration="narration",
                visual_description="empty shot",
            ),
        ]
    )

    rows = await store.list_beat_asset_refs()

    assert [(r.episode_number, r.beat_number) for r in rows] == [(1, 1), (1, 2)]

    first, second = rows
    # A beat without a scene/identity/prop beat read back as empty values rather than None, so the scan can directly json.loads.
    assert first.detected_identities_json == "[]"
    assert first.detected_props_json == "[]"
    assert first.scene_ref_json == ""
    assert first.scene_id == ""

    assert second.detected_identities_json == '["Su Qingyan_teen"]'
    assert second.detected_props_json == '["Wine Glass"]'
    assert second.visual_description == "[[Wine Glass]] sits on the table"
    assert second.scene_id == "Study"

    # Equivalent field by field to the full read -- the two paths must not give different answers for the same row.
    full = {(b.episode_number, b.beat_number): b for b in await store.list_visual_beats()}
    for row in rows:
        beat = full[(row.episode_number, row.beat_number)]
        assert row.visual_description == beat.visual_description
        assert row.detected_identities_json == beat.detected_identities_json
        assert row.detected_props_json == beat.detected_props_json
        assert row.scene_id == beat.scene_id


@pytest.mark.asyncio
async def test_list_beat_asset_refs_on_empty_project(tmp_project):
    store = tmp_project
    await store._ensure_db()

    assert await store.list_beat_asset_refs() == []


@pytest.mark.asyncio
async def test_replace_episodes_rolls_back_delete_when_new_plan_write_fails(
    tmp_path,
    monkeypatch,
):
    from novelvideo.models import NovelEpisode
    from novelvideo.sqlite_store import SQLiteStore

    store = SQLiteStore(
        "admin/demo",
        output_dir=str(tmp_path / "output"),
        state_dir=str(tmp_path / "state"),
    )
    old_episode = NovelEpisode(
        number=1,
        title="Old plan",
        content_summary="Must be kept after the replacement fails.",
    )
    new_episodes = [
        NovelEpisode(number=1, title="New plan one"),
        NovelEpisode(number=2, title="New plan two"),
    ]
    try:
        await store.add_episodes([old_episode])
        original_upsert = store._upsert_episodes

        async def fail_after_partial_write(db, episodes):
            await original_upsert(db, episodes[:1])
            raise RuntimeError("simulated planner persistence failure")

        monkeypatch.setattr(store, "_upsert_episodes", fail_after_partial_write)

        with pytest.raises(RuntimeError, match="simulated planner persistence failure"):
            await store.replace_episodes(new_episodes)

        persisted = await store.list_episodes()
        assert [(episode.number, episode.title) for episode in persisted] == [
            (1, "Old plan")
        ]
        assert store.get_episode(1) is old_episode
        assert store.get_episode(2) is None
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_replace_episodes_commits_new_plan_and_refreshes_cache(tmp_path):
    from novelvideo.models import NovelEpisode
    from novelvideo.sqlite_store import SQLiteStore

    store = SQLiteStore(
        "admin/demo",
        output_dir=str(tmp_path / "output"),
        state_dir=str(tmp_path / "state"),
    )
    replacement = [
        NovelEpisode(number=2, title="Episode Two"),
        NovelEpisode(number=3, title="Episode Three"),
    ]
    try:
        await store.add_episodes([NovelEpisode(number=1, title="Old episode one")])

        await store.replace_episodes(replacement)

        persisted = await store.list_episodes()
        assert [(episode.number, episode.title) for episode in persisted] == [
            (2, "Episode Two"),
            (3, "Episode Three"),
        ]
        assert store.get_episode(1) is None
        assert store.get_episode(2) is replacement[0]
        assert store.get_episode(3) is replacement[1]
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_episode_schema_migration_adds_planning_columns(tmp_path):
    import aiosqlite

    from novelvideo.cognee.pipeline import NovelEpisode
    from novelvideo.sqlite_store import SQLiteStore

    output_dir = tmp_path / "output" / "testuser" / "legacy_episode_schema"
    state_dir = tmp_path / "state" / "testuser" / "legacy_episode_schema"
    output_dir.mkdir(parents=True)
    state_dir.mkdir(parents=True)
    db_path = state_dir / "data.db"

    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """CREATE TABLE episodes (
                number INTEGER PRIMARY KEY,
                title TEXT DEFAULT '',
                chapter_start INTEGER DEFAULT 0,
                chapter_end INTEGER DEFAULT 0,
                content_summary TEXT DEFAULT '',
                main_conflict TEXT DEFAULT '',
                cliffhanger TEXT DEFAULT '',
                key_events TEXT DEFAULT '[]',
                character_names TEXT DEFAULT '[]',
                identity_ids TEXT DEFAULT '[]',
                event_ids TEXT DEFAULT '[]',
                sketch_colors_json TEXT DEFAULT '{}',
                raw_content TEXT DEFAULT '',
                adapted_content TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            )"""
        )
        await db.commit()

    store = SQLiteStore(
        "testuser/legacy_episode_schema",
        output_dir=str(output_dir),
        state_dir=str(state_dir),
    )
    try:
        await store.initialize()
        await store.add_episodes(
            [
                NovelEpisode(
                    number=1,
                    title="Episode One",
                    raw_content="Full source text",
                    beat_source_text="line-by-line storyboard text",
                )
            ]
        )

        episodes = await store.list_episodes()
        assert episodes[0].beat_source_text == "line-by-line storyboard text"

        async with store._db.execute("PRAGMA table_info(episodes)") as cursor:
            columns = {row["name"] for row in await cursor.fetchall()}
        assert {
            "beat_source_text",
            "scene_menu_json",
            "prop_menu_json",
            "identity_default_map_json",
        }.issubset(columns)
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_beats_schema_migration_adds_current_columns(tmp_path):
    import aiosqlite

    from novelvideo.cognee.pipeline import NovelVisualBeat
    from novelvideo.sqlite_store import SQLiteStore

    output_dir = tmp_path / "output" / "testuser" / "legacy_beats_schema"
    state_dir = tmp_path / "state" / "testuser" / "legacy_beats_schema"
    output_dir.mkdir(parents=True)
    state_dir.mkdir(parents=True)
    db_path = state_dir / "data.db"

    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """CREATE TABLE beats (
                episode_number INTEGER NOT NULL,
                beat_number INTEGER NOT NULL,
                narration TEXT DEFAULT '',
                visual_description TEXT DEFAULT '',
                video_prompt TEXT,
                location TEXT DEFAULT '',
                location_description TEXT DEFAULT '',
                time_of_day TEXT DEFAULT '',
                set_description TEXT DEFAULT '',
                keyframe_prompt TEXT,
                video_mode TEXT DEFAULT 'first_frame',
                detected_identities_json TEXT DEFAULT '[]',
                audio_type TEXT DEFAULT 'narration',
                speaker TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (episode_number, beat_number)
            )"""
        )
        await db.commit()

    store = SQLiteStore(
        "testuser/legacy_beats_schema",
        output_dir=str(output_dir),
        state_dir=str(state_dir),
    )
    try:
        await store.initialize()
        await store.add_visual_beats(
            [
                NovelVisualBeat(
                    episode_number=1,
                    beat_number=1,
                    narration="narration",
                    visual_description="picture",
                    detected_props_json='["Cardboard Box"]',
                    scene_ref_json='{"scene_id":"Living Room"}',
                    speaker_kind="character",
                    shot_order=1,
                    duration_seconds=2.5,
                    is_manual_shot=True,
                )
            ]
        )

        beats = await store.get_beats_for_episode(1)
        assert beats[0].detected_props_json == '["Cardboard Box"]'
        assert json.loads(beats[0].scene_ref_json)["scene_id"] == "Living Room"
        assert beats[0].speaker_kind == "character"
        assert beats[0].shot_order == 1
        assert beats[0].duration_seconds == 2.5
        assert beats[0].is_manual_shot is True

        async with store._db.execute("PRAGMA table_info(beats)") as cursor:
            columns = {row["name"] for row in await cursor.fetchall()}
        assert {
            "detected_props_json",
            "scene_ref_json",
            "speaker_kind",
            "shot_order",
            "duration_seconds",
            "is_manual_shot",
        }.issubset(columns)
    finally:
        await store.close()


# ── 6. beat Update ───────────────────────────────────────────
@pytest.mark.asyncio
async def test_beat_update(tmp_project):
    from novelvideo.cognee.pipeline import NovelVisualBeat

    store = tmp_project
    await store._ensure_db()

    beat = NovelVisualBeat(
        beat_number=0,
        episode_number=1,
        narration="Original narration",
        visual_description="Original description",
    )
    await store.add_visual_beats([beat])

    # Update video_prompt
    ok = await store.update_beat_asset(
        episode_number=1,
        beat_number=0,
        video_prompt="camera slowly pans left",
        video_mode="first_frame",
    )
    assert ok is True

    # Verify
    prompts = await store.get_beat_prompts(1, 0)
    assert prompts["video_prompt"] == "camera slowly pans left"
    assert prompts["video_mode"] == "first_frame"

    # Update detected_identities
    ok = await store.set_beat_detected_identities(1, {0: ["Su Qingyan_daily"]})
    assert ok == 1

    dicts = await store.get_beats_as_dicts(1)
    assert dicts[0]["detected_identities"] == ["Su Qingyan_daily"]


def test_stringify_search_fragment_handles_nested_lists():
    from novelvideo.cognee.store import CogneeStore

    payload = [
        "First line",
        ["Second line", "Third line"],
        {"role": "narration"},
    ]

    text = CogneeStore._stringify_search_fragment(payload)

    assert "First line" in text
    assert "Second line" in text
    assert "Third line" in text
    assert '"role": "narration"' in text


# ── 7. load_graph_state restores the cache ──────────────────────────
@pytest.mark.asyncio
async def test_load_graph_state(tmp_project):
    from novelvideo.cognee.pipeline import NovelCharacter, NovelEpisode

    store = tmp_project
    await store._ensure_db()

    # Write data
    char = NovelCharacter(name="Xie Zheng", aliases=["Monk"], gender="male")
    await store.add_character(char)
    ep = NovelEpisode(number=1, title="Episode One")
    await store.add_episodes([ep])

    # Clear the in-memory cache
    store._characters.clear()
    store._episodes.clear()
    store._alias_index.clear()

    # Reload
    await store.load_graph_state()

    assert len(store._characters) == 1
    assert "Xie Zheng" in store._characters
    assert store._alias_index.get("Monk") == "Xie Zheng"
    assert len(store._episodes) == 1
    assert 1 in store._episodes


# ── 8. identity CRUD ──────────────────────────────────────────
@pytest.mark.asyncio
async def test_identity_crud(tmp_project):
    from novelvideo.cognee.pipeline import NovelCharacter, CharacterIdentity

    store = tmp_project
    await store._ensure_db()

    char = NovelCharacter(name="Xie Zheng", gender="male")
    await store.add_character(char)

    # Add an identity
    identity = CharacterIdentity(
        identity_id="Xie Zheng_emperor",
        character_name="Xie Zheng",
        identity_name="emperor",
        appearance_details="Dragon robe, tall crown, imperial bearing",
    )
    await store.add_character_identity("Xie Zheng", identity)

    # Verify
    updated = store.get_character("Xie Zheng")
    assert len(updated.identities) == 1

    # Update an identity
    await store.update_character_identity("Xie Zheng", "Xie Zheng_emperor", appearance_details="Golden dragon robe")
    updated = store.get_character("Xie Zheng")
    emperor = updated.get_identity("emperor")
    assert emperor.appearance_details == "Golden dragon robe"

    # Delete an identity
    await store.delete_character_identity("Xie Zheng", "Xie Zheng_emperor")
    updated = store.get_character("Xie Zheng")
    assert updated.get_identity("emperor") is None


# ── 9. Delete all data ──────────────────────────────────────
@pytest.mark.asyncio
async def test_delete_project_data(tmp_project):
    from novelvideo.cognee.pipeline import NovelCharacter, NovelEpisode

    store = tmp_project
    await store._ensure_db()

    await store.add_character(NovelCharacter(name="A"))
    await store.add_episodes([NovelEpisode(number=1, title="E1")])

    await store.delete_project_data()

    assert len(store._characters) == 0
    assert len(store._episodes) == 0
    assert len(await store.list_characters()) == 0
    assert len(await store.list_episodes()) == 0


# ── 10. sketch_colors read/write ────────────────────────────────
@pytest.mark.asyncio
async def test_sketch_colors(tmp_project):
    from novelvideo.cognee.pipeline import NovelEpisode

    store = tmp_project
    await store._ensure_db()

    ep = NovelEpisode(number=1, title="E1")
    await store.add_episodes([ep])
    store._episodes[1] = ep

    colors = {"Su Qingyan_daily": "red", "Xie Zheng_emperor": "blue"}
    await store.set_sketch_colors(1, colors)

    # Reload
    await store.load_graph_state()
    loaded = store.get_sketch_colors(1)
    assert loaded == colors


# ── 11. v2.0 beat field (time/video_prompt) ─
@pytest.mark.asyncio
async def test_new_beat_columns(tmp_project):
    from novelvideo.cognee.pipeline import NovelVisualBeat

    store = tmp_project
    await store._ensure_db()

    beat = NovelVisualBeat(
        beat_number=1,
        episode_number=1,
        narration="test",
        visual_description="picture",
        time_of_day="night",
        video_prompt="camera slowly pans left",
    )
    await store.add_visual_beats([beat])

    loaded = await store.get_beats_for_episode(1)
    assert len(loaded) == 1
    assert loaded[0].time_of_day == "night"
    assert loaded[0].video_prompt == "camera slowly pans left"

    # get_beats_as_dicts also contains v2.0 field
    dicts = await store.get_beats_as_dicts(1)
    assert dicts[0]["time_of_day"] == "night"
    assert dicts[0]["estimated_duration"] == len("test") / 4.0
    assert dicts[0]["video_prompt"] == "camera slowly pans left"


# ── 12. beat_number naming unification ──────────────────────────────
@pytest.mark.asyncio
async def test_beat_number_naming(tmp_project):
    from novelvideo.cognee.pipeline import NovelVisualBeat

    store = tmp_project
    await store._ensure_db()

    beat = NovelVisualBeat(
        beat_number=5,
        episode_number=1,
        narration="Fifth beat",
        visual_description="description",
    )
    await store.add_visual_beats([beat])

    dicts = await store.get_beats_as_dicts(1)
    assert dicts[0]["beat_number"] == 5


# ── 13. get_script_as_dict ────────────────────────────────
@pytest.mark.asyncio
async def test_get_script_as_dict(tmp_project):
    from novelvideo.cognee.pipeline import NovelEpisode, NovelVisualBeat

    store = tmp_project
    await store._ensure_db()

    ep = NovelEpisode(number=1, title="Test Episode")
    await store.add_episodes([ep])
    store._episodes[1] = ep

    beats = [
        NovelVisualBeat(
            beat_number=i,
            episode_number=1,
            narration=f"narration{i}",
            visual_description=f"picture{i}",
        )
        for i in range(1, 4)
    ]
    await store.add_visual_beats(beats)

    colors = {"characterA_default": "red"}
    await store.set_sketch_colors(1, colors)

    result = await store.get_script_as_dict(1)
    assert result is not None
    assert result["episode_number"] == 1
    assert result["title"] == "Test Episode"
    assert len(result["beats"]) == 3
    assert result["sketch_colors"] == colors

    # A non-existent episode number returns None
    assert await store.get_script_as_dict(999) is None


# ── 14. persist_narration_script ──────────────────────────
@pytest.mark.asyncio
async def test_persist_narration_script(tmp_project):
    from novelvideo.cognee.pipeline import NovelEpisode

    store = tmp_project
    await store._ensure_db()

    ep = NovelEpisode(number=1, title="E1")
    await store.add_episodes([ep])
    store._episodes[1] = ep

    # Build a minimal NarrationScript-like object, to avoid MagicMock automatically fabricating unknown fields.
    from types import SimpleNamespace

    mock_beat = SimpleNamespace(
        beat_number=1,
        narration_segment="narration text",
        visual_description="picture description",
        time_of_day="dusk",
        shot_id=None,
        scene_ref=None,
        audio_type="narration",
        speaker="",
        speaker_kind="character",
        video_mode="first_frame",
        video_prompt=None,
        keyframe_prompt="",
    )
    mock_script = SimpleNamespace(episode_number=1, beats=[mock_beat])

    await store.persist_narration_script(mock_script)

    loaded = await store.get_beats_for_episode(1)
    assert len(loaded) == 1
    assert loaded[0].narration == "narration text"
    assert loaded[0].time_of_day == "dusk"


@pytest.mark.asyncio
async def test_persist_narration_script_completes_detected_refs_from_markers(tmp_project):
    from novelvideo.cognee.pipeline import (
        CharacterIdentity,
        NovelCharacter,
        NovelEpisode,
        NovelProp,
    )

    store = tmp_project
    await store._ensure_db()

    ep = NovelEpisode(number=1, title="E1")
    await store.add_episodes([ep])
    await store.add_character(
        NovelCharacter(
            name="Lu Chen",
            identities=[
                CharacterIdentity(
                    identity_id="Lu Chen_young_adult",
                    character_name="Lu Chen",
                    identity_name="young_adult",
                ),
            ],
        )
    )
    await store.sqlite_store.add_prop(NovelProp(name="Parchment Notebook", marker_color="#a78bfa"))

    from types import SimpleNamespace

    mock_beat = SimpleNamespace(
        beat_number=1,
        narration_segment="narration text",
        visual_description="{{Lu Chen_young_adult}}holds [[Parchment Notebook]].",
        time_of_day="dusk",
        shot_id=None,
        scene_ref=None,
        audio_type="narration",
        speaker="",
        speaker_kind="character",
        video_mode="first_frame",
        video_prompt=None,
        keyframe_prompt="",
    )
    mock_script = SimpleNamespace(episode_number=1, beats=[mock_beat])

    await store.persist_narration_script(mock_script)

    loaded = await store.get_beats_for_episode(1)
    assert loaded[0].detected_identities_json == '["Lu Chen_young_adult"]'
    assert loaded[0].detected_props_json == '["Parchment Notebook"]'


@pytest.mark.asyncio
async def test_persist_beats_from_script_completes_empty_detected_markers(tmp_project):
    from novelvideo.cognee.pipeline import NovelEpisode

    store = tmp_project
    await store._ensure_db()

    ep = NovelEpisode(number=1, title="E1")
    await store.add_episodes([ep])

    await store.persist_beats_from_script(
        1,
        [
            {
                "beat_number": 1,
                "narration_segment": "narration text",
                "visual_description": "An empty shot with nobody.",
            }
        ],
    )

    loaded = await store.get_beats_for_episode(1)
    assert loaded[0].detected_identities_json == '["__NO_CHARACTER__"]'
    assert loaded[0].detected_props_json == '["__NO_PROP__"]'


# ── 15. beats table schema ───────────────────────────────
@pytest.mark.asyncio
async def test_beats_schema_uses_current_columns(tmp_project):
    """Verify beats table contains only the core columns the current 2.0 schema needs."""
    store = tmp_project
    await store._ensure_db()

    # Confirm the table uses beat_number column
    db = store._db
    async with db.execute("PRAGMA table_info(beats)") as cursor:
        columns = [row[1] for row in await cursor.fetchall()]
    assert "beat_number" in columns
    assert "beat_index" not in columns
    removed_columns = {"shot" + "_hint", "camera" + "_angle", "visual" + "_hint"}
    assert removed_columns.isdisjoint(columns)
    assert "time_of_day" in columns
    assert "scene_ref_json" in columns
    assert "prop_refs_json" not in columns
    assert "video_prompt" in columns


@pytest.mark.asyncio
async def test_sqlite_store_close_rejects_future_operations(tmp_path):
    from novelvideo.sqlite_store import SQLiteStore, StoreClosedError

    store = SQLiteStore(
        "testuser/testproject",
        output_dir=str(tmp_path / "output" / "testuser" / "testproject"),
        state_dir=str(tmp_path / "state" / "testuser" / "testproject"),
    )
    await store.initialize()
    await store.close()

    assert store.is_closed()
    with pytest.raises(StoreClosedError):
        await store.list_episodes()


@pytest.mark.asyncio
async def test_sqlite_store_close_waits_for_inflight_operation(tmp_path, monkeypatch):
    from novelvideo.sqlite_store import SQLiteStore

    store = SQLiteStore(
        "testuser/testproject",
        output_dir=str(tmp_path / "output" / "testuser" / "testproject"),
        state_dir=str(tmp_path / "state" / "testuser" / "testproject"),
    )
    await store.initialize()

    original_ensure_db = store._ensure_db
    entered = asyncio.Event()
    release = asyncio.Event()

    async def slow_ensure_db():
        entered.set()
        await release.wait()
        return await original_ensure_db()

    monkeypatch.setattr(store, "_ensure_db", slow_ensure_db)

    list_task = asyncio.create_task(store.list_episodes())
    await asyncio.wait_for(entered.wait(), timeout=1)

    close_task = asyncio.create_task(store.close())
    await asyncio.sleep(0.01)
    assert not close_task.done()

    release.set()
    assert await list_task == []
    await asyncio.wait_for(close_task, timeout=1)
    assert store.is_closed()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
