from __future__ import annotations

from types import SimpleNamespace

import pytest

from novelvideo.models import NovelScene

ENRICHED_ENVIRONMENT_PROMPT = "Front: street-facing glass window\nLeft: coffee bar counter\nRight: wooden bookshelf\nBack: wooden entrance door"


async def _return_async(value):
    return value


class _FakeSQLiteStore:
    def __init__(
        self, scenes: list[NovelScene] | None = None, *, raw_content: str = ""
    ):
        # The real SQLiteStore owns episode content; CogneeStore only delegates
        # to it. Keeping the fake the same way round means planners that talk to
        # the SQLite store directly resolve content exactly as they do in
        # production.
        self.raw_content = raw_content
        self.scenes = {scene.name: scene for scene in scenes or []}
        self.added: list[NovelScene] = []
        self.updated: list[tuple[str, dict]] = []
        self.patched: list[tuple[int, dict]] = []

    async def load_episode_content(self, ep_num: int):
        return self.raw_content

    async def get_scene(self, name: str):
        return self.scenes.get(name)

    async def list_scenes(self):
        return list(self.scenes.values())

    async def add_scene(self, scene: NovelScene):
        self.added.append(scene)
        self.scenes[scene.name] = scene

    async def update_scene(self, name: str, **updates):
        self.updated.append((name, updates))
        scene = self.scenes[name]
        for key, value in updates.items():
            setattr(scene, key, value)
        return True

    async def patch_episode(self, episode_number: int, **updates):
        # Menu writes go through the column-level patch so concurrent scene and
        # prop planning cannot overwrite each other.
        self.patched.append((episode_number, updates))
        return None


class _FakeCogneeStore:
    def __init__(
        self,
        scenes: list[NovelScene] | None = None,
        *,
        raw_content: str = "",
        project_dir: str = "",
    ):
        self.sqlite_store = _FakeSQLiteStore(scenes, raw_content=raw_content)
        self.project_dir = project_dir
        self.raw_content = raw_content
        self.updated: list[tuple[int, dict]] = []

    async def load_episode_content(self, ep_num: int):
        return await self.sqlite_store.load_episode_content(ep_num)

    async def update_episode(self, episode_number: int, **updates):
        self.updated.append((episode_number, updates))
        return None


def _block(location: str = "Cafe", time_of_day: str = "night"):
    return SimpleNamespace(
        location=location,
        interior_exterior="int",
        time_of_day=time_of_day,
        characters=["Luke", "Mia"],
        header_line=f"Scene 1. INT. {location} - {time_of_day}; Characters: Luke, Mia",
        lines=[
            "Rain pours down outside, hammering against the glass.",
            "They are the only table in the cafe; the dim amber light stretches their shadows long.",
            "Mia pushes her phone to the middle of the table.",
        ],
    )


@pytest.mark.asyncio
async def test_drama_scene_planning_uses_screenplay_normalizer_as_primary(monkeypatch):
    import novelvideo.agents.asset_compiler as asset_compiler
    from novelvideo.cognee.screenplay_normalizer import NormalizedSceneHeader

    calls = []

    async def fake_normalize(header_line, **hints):
        calls.append((header_line, hints))
        return NormalizedSceneHeader(
            episode_number=1,
            scene_no="2",
            location="Bodhi Bedchamber",
            time_of_day="night",
            interior_exterior="int",
        )

    monkeypatch.setattr(asset_compiler, "normalize_screenplay_scene_header", fake_normalize)

    compiler = asset_compiler.AssetCompiler(_FakeCogneeStore())
    original = SimpleNamespace(
        header_line="1-2 INT. BODHI BEDCHAMBER - NIGHT",
        location="Bodhi Bedchamber",
        time_of_day="night",
        interior_exterior="int",
        characters=["Sun Wukong", "Patriarch Subhuti"],
        lines=["Sun Wukong kneels on the prayer cushion."],
    )
    blocks = await compiler._normalize_scene_block_headers(
        [original],
        lambda _message: None,
    )

    assert calls == [
        (
            "1-2 INT. BODHI BEDCHAMBER - NIGHT",
            {
                "location_hint": "Bodhi Bedchamber",
                "time_of_day_hint": "night",
                "interior_exterior_hint": "int",
                "context_lines": ["Sun Wukong kneels on the prayer cushion."],
            },
        )
    ]
    assert len(blocks) == 1
    assert blocks[0].location == "Bodhi Bedchamber"
    assert blocks[0].characters == ["Sun Wukong", "Patriarch Subhuti"]
    assert blocks[0].lines == ["Sun Wukong kneels on the prayer cushion."]


@pytest.mark.asyncio
async def test_drama_scene_planning_rejects_empty_normalizer_output(monkeypatch):
    import novelvideo.agents.asset_compiler as asset_compiler

    async def fake_normalize(_header_line, **_hints):
        return None

    monkeypatch.setattr(asset_compiler, "normalize_screenplay_scene_header", fake_normalize)

    compiler = asset_compiler.AssetCompiler(_FakeCogneeStore())
    with pytest.raises(ValueError, match="AI did not recognize a valid scene header for scene #1"):
        await compiler._normalize_scene_block_headers(
            [_block()],
            lambda _message: None,
        )


@pytest.mark.asyncio
async def test_compile_episode_scenes_reconciles_base_scene_before_planning(monkeypatch):
    import novelvideo.agents.asset_compiler as asset_compiler

    async def fake_enrich(**kwargs):
        return NovelScene(
            name=kwargs["scene_name"],
            aliases=[],
            scene_type=kwargs["scene_type"],
            environment_prompt=ENRICHED_ENVIRONMENT_PROMPT,
            description="Rainy-night cafe",
        )

    async def fake_derived(self, scene_name, block):
        return []

    async def fake_reconcile(self, source_text, episode, log):
        scene = await fake_enrich(
            scene_name="Cafe",
            scene_type="interior",
            context_lines=["Rain pours down outside."],
        )
        await self.cognee_store.sqlite_store.add_scene(scene)
        log("  AI completed base scene: Cafe")
        return ["Cafe"]

    async def fake_load_scene_blocks(self, episode):
        return [_block()]

    monkeypatch.setattr(asset_compiler, "enrich_scene_environment_from_context", fake_enrich)
    monkeypatch.setattr(asset_compiler.AssetCompiler, "_analyze_derived_scenes", fake_derived)
    monkeypatch.setattr(
        asset_compiler.AssetCompiler,
        "_load_scene_blocks",
        fake_load_scene_blocks,
    )
    monkeypatch.setattr(
        asset_compiler.AssetCompiler,
        "_normalize_scene_block_headers",
        lambda self, blocks, log: _return_async(blocks),
    )
    monkeypatch.setattr(
        asset_compiler.AssetCompiler,
        "_reconcile_base_scenes_from_text",
        fake_reconcile,
    )

    store = _FakeCogneeStore()
    compiler = asset_compiler.AssetCompiler(store)

    scene_menu, new_count = await compiler.compile_episode_scenes(
        SimpleNamespace(number=1, title="Episode One", beat_source_text="Scene 1. INT. Cafe"),
        lambda _message: None,
    )

    assert scene_menu[0].scene_id == "Cafe"
    assert new_count == 0
    assert [scene.name for scene in store.sqlite_store.added] == ["Cafe"]
    assert store.sqlite_store.scenes["Cafe"].environment_prompt.startswith("Front: street-facing glass window")


@pytest.mark.asyncio
async def test_compile_episode_scenes_backfills_existing_empty_scene_prompt(monkeypatch):
    import novelvideo.agents.asset_compiler as asset_compiler

    existing = NovelScene(name="Cafe", scene_type="interior", environment_prompt="")

    async def fake_enrich(**kwargs):
        return NovelScene(
            name=kwargs["scene_name"],
            aliases=[],
            scene_type="interior",
            environment_prompt=ENRICHED_ENVIRONMENT_PROMPT,
            description="Rainy-night cafe",
        )

    async def fake_derived(self, scene_name, block):
        return []

    monkeypatch.setattr(asset_compiler, "enrich_scene_environment_from_context", fake_enrich)
    monkeypatch.setattr(asset_compiler.AssetCompiler, "_analyze_derived_scenes", fake_derived)

    store = _FakeCogneeStore([existing])
    compiler = asset_compiler.AssetCompiler(store)

    _scene_menu, pending_scenes = await compiler._compile_scenes(
        [_block()],
        SimpleNamespace(number=1),
        lambda _message: None,
    )

    assert pending_scenes == []
    assert store.sqlite_store.updated == [
        (
            "Cafe",
            {
                "scene_type": "interior",
                "environment_prompt": ENRICHED_ENVIRONMENT_PROMPT,
                "description": "Rainy-night cafe",
            },
        )
    ]
    assert existing.environment_prompt.startswith("Front: street-facing glass window")


@pytest.mark.asyncio
async def test_compile_episode_scenes_keeps_existing_prompt(monkeypatch):
    import novelvideo.agents.asset_compiler as asset_compiler

    existing = NovelScene(
        name="Cafe",
        scene_type="interior",
        environment_prompt="Existing complete spatial contract",
        description="Existing description",
    )
    enrich_calls = []

    async def fake_enrich(**kwargs):
        enrich_calls.append(kwargs)
        return NovelScene(name=kwargs["scene_name"], environment_prompt="Should not be used")

    async def fake_derived(self, scene_name, block):
        return []

    monkeypatch.setattr(asset_compiler, "enrich_scene_environment_from_context", fake_enrich)
    monkeypatch.setattr(asset_compiler.AssetCompiler, "_analyze_derived_scenes", fake_derived)

    store = _FakeCogneeStore([existing])
    compiler = asset_compiler.AssetCompiler(store)

    _scene_menu, pending_scenes = await compiler._compile_scenes(
        [_block()],
        SimpleNamespace(number=1),
        lambda _message: None,
    )

    assert pending_scenes == []
    assert store.sqlite_store.updated == []
    assert enrich_calls == []
    assert existing.environment_prompt == "Existing complete spatial contract"


@pytest.mark.asyncio
async def test_compile_episode_scenes_creates_empty_time_plate_slot_for_repeated_time(
    monkeypatch,
):
    import novelvideo.agents.asset_compiler as asset_compiler

    async def fake_enrich(**kwargs):
        return NovelScene(
            name=kwargs["scene_name"],
            aliases=[],
            scene_type="interior",
            environment_prompt=ENRICHED_ENVIRONMENT_PROMPT,
            description="Cafe",
        )

    async def fake_derived(self, scene_name, block):
        return []

    monkeypatch.setattr(asset_compiler, "enrich_scene_environment_from_context", fake_enrich)
    monkeypatch.setattr(asset_compiler.AssetCompiler, "_analyze_derived_scenes", fake_derived)

    store = _FakeCogneeStore(
        [
            NovelScene(
                name="Cafe",
                scene_type="interior",
                environment_prompt=ENRICHED_ENVIRONMENT_PROMPT,
                description="Cafe",
            )
        ]
    )
    compiler = asset_compiler.AssetCompiler(store)

    scene_menu, pending_scenes = await compiler._compile_scenes(
        [_block(time_of_day="night"), _block(time_of_day="night")],
        SimpleNamespace(number=1),
        lambda _message: None,
    )

    assert [item.scene_id for item in scene_menu] == ["Cafe", "Cafe_night"]
    assert scene_menu[1].base_scene_id == "Cafe"
    assert scene_menu[1].variant_id == ""
    assert scene_menu[1].time_of_day == "night"
    time_plate = next(scene for scene in pending_scenes if scene.name == "Cafe_night")
    assert time_plate.base_scene_id == "Cafe"
    assert time_plate.variant_id == ""
    assert time_plate.time_of_day == "night"
    assert "Empty plate slot" in time_plate.notes


@pytest.mark.asyncio
async def test_compile_episode_scenes_uses_narrated_fallback_without_scene_headers(
    monkeypatch, tmp_path
):
    import novelvideo.agents.asset_compiler as asset_compiler

    async def fake_extract(self, source_text, episode, log):
        assert "Hospital Corridor" in source_text
        return [
            NovelScene(
                name="Hospital Corridor",
                scene_type="interior",
                environment_prompt="Front: nurses station and emergency signage\nLeft: ward door\nRight: waiting chairs\nBack: elevator lobby",
                description="Emergency building hospital corridor",
            )
        ]

    monkeypatch.setattr(
        asset_compiler.AssetCompiler,
        "_extract_narrated_episode_scenes",
        fake_extract,
        raising=False,
    )
    monkeypatch.setattr(
        asset_compiler,
        "normalize_screenplay_scene_header",
        lambda *_args, **_kwargs: pytest.fail("Narrated dramas must not call the screenplay normalizer"),
    )

    store = _FakeCogneeStore(
        raw_content="Lin Wan rushes into the Hospital Corridor, the sign light in front of the nurses station flickering.",
        project_dir=str(tmp_path),
    )
    compiler = asset_compiler.AssetCompiler(store)
    compiler.spine_template = "narrated"
    episode = SimpleNamespace(number=1, title="Episode One", beat_source_text="")

    scene_menu, new_count = await compiler.compile_episode_scenes(episode, lambda _message: None)

    assert new_count == 1
    assert scene_menu[0].scene_id == "Hospital Corridor"
    assert store.sqlite_store.added[0].name == "Hospital Corridor"
    # Both tracks take the column-level patch, so concurrent scene and prop
    # planning cannot overwrite each other's menu.
    assert store.sqlite_store.patched == [(1, {"scene_menu": scene_menu})]


@pytest.mark.asyncio
async def test_drama_without_scene_headers_uses_semantic_scene_planning(monkeypatch, tmp_path):
    import novelvideo.agents.asset_compiler as asset_compiler

    async def fake_load_scene_blocks(self, episode):
        return [
            SimpleNamespace(
                header_line="",
                location="",
                time_of_day="",
                interior_exterior="",
                characters=[],
                lines=["Lin Wan rushes into the Hospital Corridor, the sign light in front of the nurses station flickering."],
            )
        ]

    async def fake_extract(self, source_text, episode, log):
        assert "Hospital Corridor" in source_text
        return [
            NovelScene(
                name="Hospital Corridor",
                scene_type="interior",
                environment_prompt="Front: nurses station\nLeft: ward door\nRight: waiting chairs\nBack: elevator lobby",
                description="Emergency building hospital corridor",
            )
        ]

    async def fail_normalize(self, scene_blocks, log):
        pytest.fail("A legacy drama without scene headers must not call the screenplay normalizer")

    async def fail_reconcile(self, source_text, episode, log):
        pytest.fail("The semantic fallback must not enter the scene-header reconciliation chain")

    monkeypatch.setattr(
        asset_compiler.AssetCompiler,
        "_load_scene_blocks",
        fake_load_scene_blocks,
    )
    monkeypatch.setattr(
        asset_compiler.AssetCompiler,
        "_extract_narrated_episode_scenes",
        fake_extract,
    )
    monkeypatch.setattr(
        asset_compiler.AssetCompiler,
        "_normalize_scene_block_headers",
        fail_normalize,
    )
    monkeypatch.setattr(
        asset_compiler.AssetCompiler,
        "_reconcile_base_scenes_from_text",
        fail_reconcile,
    )

    store = _FakeCogneeStore(
        raw_content="Lin Wan rushes into the Hospital Corridor, the sign light in front of the nurses station flickering.",
        project_dir=str(tmp_path),
    )
    compiler = asset_compiler.AssetCompiler(store)
    compiler.spine_template = "drama"
    logs: list[str] = []

    scene_menu, new_count = await compiler.compile_episode_scenes(
        SimpleNamespace(number=1, title="Episode One", beat_source_text=""),
        logs.append,
    )

    assert new_count == 1
    assert [item.scene_id for item in scene_menu] == ["Hospital Corridor"]
    # Both tracks take the column-level patch, so concurrent scene and prop
    # planning cannot overwrite each other's menu.
    assert store.sqlite_store.patched == [(1, {"scene_menu": scene_menu})]
    assert any("the project type stays drama" in message for message in logs)


@pytest.mark.asyncio
async def test_compile_scenes_promotes_stable_visual_states_to_pending_scenes(monkeypatch):
    import novelvideo.agents.asset_compiler as asset_compiler

    async def fake_enrich(**kwargs):
        return NovelScene(
            name=kwargs["scene_name"],
            scene_type=kwargs["scene_type"],
            environment_prompt=ENRICHED_ENVIRONMENT_PROMPT,
            description="Rainy-night cafe",
        )

    async def fake_derived(self, scene_name, block):
        return [
            asset_compiler.DerivedSceneRequirement(
                label="rainstorm",
                description="Rainstorm outside, water streaks across the glass",
                lighting="dim amber light",
                atmosphere="damp rainy-night air",
            )
        ]

    monkeypatch.setattr(asset_compiler, "enrich_scene_environment_from_context", fake_enrich)
    monkeypatch.setattr(asset_compiler.AssetCompiler, "_analyze_derived_scenes", fake_derived)

    store = _FakeCogneeStore(
        [
            NovelScene(
                name="Cafe",
                scene_type="interior",
                environment_prompt=ENRICHED_ENVIRONMENT_PROMPT,
                description="Rainy-night cafe",
            )
        ]
    )
    compiler = asset_compiler.AssetCompiler(store)

    scene_menu, pending_scenes = await compiler._compile_scenes(
        [_block()],
        SimpleNamespace(number=1),
        lambda _message: None,
    )

    assert [item.scene_id for item in scene_menu] == ["Cafe", "Cafe_rainstorm"]
    assert scene_menu[1].base_scene_id == "Cafe"
    assert scene_menu[1].variant_id == "rainstorm"
    assert [scene.name for scene in pending_scenes] == ["Cafe_rainstorm"]
    derived_scene = pending_scenes[0]
    assert derived_scene.name == "Cafe_rainstorm"
    assert not hasattr(derived_scene, "base_scene")
    assert derived_scene.aliases == ["Cafe"]
    assert derived_scene.environment_prompt == ""
    assert derived_scene.description == "Rainstorm outside, water streaks across the glass"
    assert "Rainstorm outside, water streaks across the glass" in derived_scene.variant_prompt
    assert "dim amber light" in derived_scene.variant_prompt
    assert "damp rainy-night air" in derived_scene.variant_prompt
    assert "Front: street-facing glass window" not in derived_scene.variant_prompt


@pytest.mark.asyncio
async def test_compile_scenes_reuses_existing_derived_scene(monkeypatch):
    import novelvideo.agents.asset_compiler as asset_compiler

    async def fake_derived(self, scene_name, block):
        return [
            asset_compiler.DerivedSceneRequirement(
                label="rainstorm",
                description="Rainstorm outside, water streaks across the glass",
                lighting="dim amber light",
                atmosphere="damp rainy-night air",
            )
        ]

    monkeypatch.setattr(asset_compiler.AssetCompiler, "_analyze_derived_scenes", fake_derived)

    store = _FakeCogneeStore(
        [
            NovelScene(
                name="Cafe",
                scene_type="interior",
                environment_prompt=ENRICHED_ENVIRONMENT_PROMPT,
            ),
            NovelScene(
                name="Cafe_rainstorm",
                scene_type="interior",
                base_scene_id="Cafe",
                variant_id="rainstorm",
                variant_prompt="Existing rainstorm variant",
            ),
        ]
    )
    compiler = asset_compiler.AssetCompiler(store)

    scene_menu, pending_scenes = await compiler._compile_scenes(
        [_block()],
        SimpleNamespace(number=1),
        lambda _message: None,
    )

    assert [item.scene_id for item in scene_menu] == ["Cafe", "Cafe_rainstorm"]
    assert pending_scenes == []


@pytest.mark.asyncio
async def test_compile_episode_scenes_persists_base_and_derived_as_normal_scenes(
    monkeypatch, tmp_path
):
    import novelvideo.agents.asset_compiler as asset_compiler

    async def fake_load_scene_blocks(self, episode):
        return [_block()]

    async def fake_enrich(**kwargs):
        return NovelScene(
            name=kwargs["scene_name"],
            scene_type=kwargs["scene_type"],
            environment_prompt=ENRICHED_ENVIRONMENT_PROMPT,
            description="Rainy-night cafe",
        )

    async def fake_derived(self, scene_name, block):
        return [
            asset_compiler.DerivedSceneRequirement(
                label="rainstorm",
                description="Rainstorm outside, water streaks across the glass",
                lighting="dim amber light",
                atmosphere="damp rainy-night air",
            )
        ]

    async def fake_reconcile(self, source_text, episode, log):
        scene = await fake_enrich(
            scene_name="Cafe",
            scene_type="interior",
            context_lines=["Rain pours down outside."],
        )
        await self.cognee_store.sqlite_store.add_scene(scene)
        return ["Cafe"]

    monkeypatch.setattr(
        asset_compiler.AssetCompiler,
        "_load_scene_blocks",
        fake_load_scene_blocks,
    )
    monkeypatch.setattr(
        asset_compiler.AssetCompiler,
        "_normalize_scene_block_headers",
        lambda self, blocks, log: _return_async(blocks),
    )
    monkeypatch.setattr(asset_compiler, "enrich_scene_environment_from_context", fake_enrich)
    monkeypatch.setattr(asset_compiler.AssetCompiler, "_analyze_derived_scenes", fake_derived)
    monkeypatch.setattr(
        asset_compiler.AssetCompiler,
        "_reconcile_base_scenes_from_text",
        fake_reconcile,
    )

    store = _FakeCogneeStore(project_dir=str(tmp_path))
    compiler = asset_compiler.AssetCompiler(store)
    scene_menu, new_count = await compiler.compile_episode_scenes(
        SimpleNamespace(number=1, title="Episode One"),
        lambda _message: None,
    )

    assert new_count == 1
    assert [scene.name for scene in store.sqlite_store.added] == ["Cafe", "Cafe_rainstorm"]
    assert [item.scene_id for item in scene_menu] == ["Cafe", "Cafe_rainstorm"]
    assert scene_menu[1].base_scene_id == "Cafe"
    assert scene_menu[1].variant_id == "rainstorm"
    # Both tracks take the column-level patch, so concurrent scene and prop
    # planning cannot overwrite each other's menu.
    assert store.sqlite_store.patched == [(1, {"scene_menu": scene_menu})]


@pytest.mark.asyncio
async def test_base_scene_reconcile_strips_english_time_before_persisting(monkeypatch):
    import novelvideo.agents.asset_compiler as asset_compiler

    async def fake_enrich(**kwargs):
        return NovelScene(
            name=kwargs["scene_name"],
            scene_type=kwargs["scene_type"],
            environment_prompt=ENRICHED_ENVIRONMENT_PROMPT,
        )

    monkeypatch.setattr(
        asset_compiler,
        "enrich_scene_environment_from_context",
        fake_enrich,
    )
    store = _FakeCogneeStore()
    compiler = asset_compiler.AssetCompiler(store)

    created = await compiler._apply_base_scene_reconcile_output(
        asset_compiler.EpisodeBaseSceneReconcileOutput(
            scenes=[
                asset_compiler.BaseSceneReconcileDecision(
                    action="create",
                    scene_name="Seoul Subway Station 11:47 PM",
                    scene_type="interior",
                    evidence_lines=["Location: Seoul Subway Station"],
                )
            ]
        ),
        "Location: Seoul Subway Station\nTime: 11:47 PM",
        SimpleNamespace(number=1),
        lambda _message: None,
    )

    assert created == ["Seoul Subway Station"]
    assert sorted(store.sqlite_store.scenes) == ["Seoul Subway Station"]


@pytest.mark.asyncio
async def test_base_scene_reconcile_does_not_create_existing_alias():
    import novelvideo.agents.asset_compiler as asset_compiler

    store = _FakeCogneeStore(
        [
            NovelScene(
                name="Hospital Corridor",
                aliases=["emergency corridor"],
                scene_type="interior",
                environment_prompt=ENRICHED_ENVIRONMENT_PROMPT,
            )
        ]
    )
    compiler = asset_compiler.AssetCompiler(store)

    created = await compiler._apply_base_scene_reconcile_output(
        asset_compiler.EpisodeBaseSceneReconcileOutput(
            scenes=[
                asset_compiler.BaseSceneReconcileDecision(
                    action="create",
                    scene_name="emergency corridor",
                    scene_type="interior",
                    evidence_lines=["The sign light flickers in the emergency corridor."],
                )
            ]
        ),
        "The sign light flickers in the emergency corridor.",
        SimpleNamespace(number=1),
        lambda _message: None,
    )

    assert created == []
    assert sorted(store.sqlite_store.scenes) == ["Hospital Corridor"]


@pytest.mark.asyncio
async def test_find_matching_scene_treats_independent_underscore_scene_as_base_candidate():
    import novelvideo.agents.asset_compiler as asset_compiler

    store = _FakeCogneeStore(
        [
            NovelScene(name="Basement", aliases=[], scene_type="interior"),
            NovelScene(name="Basement_control_room", aliases=["control room"], scene_type="interior"),
            NovelScene(
                name="Basement_leak",
                base_scene_id="Basement",
                variant_id="leak",
                scene_type="interior",
            ),
        ]
    )
    compiler = asset_compiler.AssetCompiler(store)

    matched = await compiler._find_matching_scene("control room")

    assert matched is not None
    assert matched.name == "Basement_control_room"


def test_derived_scene_normalization_filters_plain_time_but_keeps_stable_light_plate():
    import novelvideo.agents.asset_compiler as asset_compiler

    normalized = asset_compiler.AssetCompiler._build_derived_scene_specs(
        [
            asset_compiler.DerivedSceneRequirement(label="night", description="Ordinary night-time period"),
            asset_compiler.DerivedSceneRequirement(
                label="rainstorm neon night",
                description="Rainstorm night, neon lights reflecting in puddles",
                lighting="high-contrast neon reflections",
                atmosphere="curtains of rain and cold damp air",
            ),
            asset_compiler.DerivedSceneRequirement(label="close_up", description="Camera language"),
        ]
    )

    assert [item.label for item in normalized] == ["rainstorm neon night"]


@pytest.mark.asyncio
async def test_menu_writes_go_through_the_column_patch(tmp_path):
    """Every project gets the race-free write, whichever track it is on."""
    import json

    from novelvideo.agents.asset_compiler import AssetCompiler
    from novelvideo.knowledge_pipeline import (
        KNOWLEDGE_PIPELINE_KEY, KNOWLEDGE_PIPELINE_STRUCTURED,
    )

    state_dir = tmp_path / "structured"
    state_dir.mkdir()
    (state_dir / "project_config.json").write_text(
        json.dumps({KNOWLEDGE_PIPELINE_KEY: KNOWLEDGE_PIPELINE_STRUCTURED}),
        encoding="utf-8",
    )

    store = _FakeCogneeStore(project_dir=str(state_dir))
    store.state_dir = str(state_dir)
    compiler = AssetCompiler(store)
    await compiler._write_menus(1, scene_menu=[])

    assert store.sqlite_store.patched == [(1, {"scene_menu": []})]
    assert store.updated == []
