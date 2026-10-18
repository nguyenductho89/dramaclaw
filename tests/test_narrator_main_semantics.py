import pytest


@pytest.mark.parametrize(
    ("extractor_name", "error_pattern"),
    [
        ("extract_characters_from_graph", "Cognee graph character search failed"),
        ("extract_scenes_from_graph", "Cognee graph scene search failed"),
        ("extract_props_from_graph", "Cognee graph prop search failed"),
    ],
)
@pytest.mark.asyncio
async def test_graph_asset_extraction_raises_when_search_fails(
    monkeypatch,
    extractor_name,
    error_pattern,
):
    from novelvideo.cognee import pipeline

    async def fake_search(**_kwargs):
        raise ConnectionError("gateway unavailable")

    monkeypatch.setattr("cognee.search", fake_search)

    with pytest.raises(RuntimeError, match=error_pattern):
        await getattr(pipeline, extractor_name)()


@pytest.mark.parametrize(
    ("extractor_name", "error_pattern"),
    [
        ("extract_characters_from_graph", "LLM graph character extraction failed"),
        ("extract_scenes_from_graph", "LLM graph scene extraction failed"),
        ("extract_props_from_graph", "LLM graph prop extraction failed"),
    ],
)
@pytest.mark.asyncio
async def test_graph_asset_extraction_raises_when_structured_llm_fails(
    monkeypatch,
    extractor_name,
    error_pattern,
):
    from cognee.infrastructure.llm.LLMGateway import LLMGateway
    from novelvideo.cognee import pipeline

    async def fake_search(**_kwargs):
        return [{"search_result": "The graph contains valid context."}]

    async def fake_structured_output(*_args, **_kwargs):
        raise TimeoutError("model timed out")

    monkeypatch.setattr("cognee.search", fake_search)
    monkeypatch.setattr(LLMGateway, "acreate_structured_output", fake_structured_output)

    with pytest.raises(RuntimeError, match=error_pattern):
        await getattr(pipeline, extractor_name)()


@pytest.mark.parametrize(
    "extractor_name",
    [
        "extract_characters_from_graph",
        "extract_scenes_from_graph",
        "extract_props_from_graph",
    ],
)
@pytest.mark.asyncio
async def test_graph_asset_extraction_keeps_successful_empty_search_as_empty_result(
    monkeypatch,
    extractor_name,
):
    from novelvideo.cognee import pipeline

    async def fake_search(**_kwargs):
        return []

    monkeypatch.setattr("cognee.search", fake_search)

    assert await getattr(pipeline, extractor_name)() == []


@pytest.mark.asyncio
async def test_character_extraction_keeps_single_narrator_main(monkeypatch):
    from cognee.infrastructure.llm.LLMGateway import LLMGateway
    from novelvideo.cognee import pipeline
    from novelvideo.models import NovelCharacter

    class _Result:
        characters = [
            pipeline.CharacterEnrichment(name="Sang Luo", role="protagonist", is_main=True, gender="female"),
            pipeline.CharacterEnrichment(name="Chu Han", role="master", is_main=True, gender="male"),
            pipeline.CharacterEnrichment(name="Lin Qingqing", role="junior sister", is_main=False, gender="female"),
        ]

    async def fake_search(**kwargs):
        return [{"search_result": "Sang Luo narrates in the first person; Chu Han and Lin Qingqing are key characters."}]

    async def fake_structured_output(*args, **kwargs):
        return _Result()

    monkeypatch.setattr("cognee.search", fake_search)
    monkeypatch.setattr(LLMGateway, "acreate_structured_output", fake_structured_output)

    characters = await pipeline.extract_characters_from_graph()

    assert [c.name for c in characters if c.is_main] == ["Sang Luo"]
    assert all(isinstance(c, NovelCharacter) for c in characters)


@pytest.mark.asyncio
async def test_scene_extraction_uses_graph_context_without_raw_novel(monkeypatch):
    from cognee.infrastructure.llm.LLMGateway import LLMGateway
    from novelvideo.cognee import pipeline
    from novelvideo.models import NovelScene

    search_calls = []
    structured_inputs = []

    async def fake_search(**kwargs):
        search_calls.append(kwargs)
        return [{"search_result": "Bodhi Bedchamber is an important indoor location where Patriarch Bodhi lives and teaches."}]

    async def fake_structured_output(context_text, _prompt, _output_type, **_kwargs):
        structured_inputs.append(context_text)
        return pipeline.GraphSceneCandidateList(
            scenes=[
                pipeline.GraphSceneCandidate(
                    name="Bodhi Bedchamber",
                    aliases=["Patriarch Bedchamber"],
                    scene_type="interior",
                    evidence_lines=["Bodhi Bedchamber is an important indoor location where Patriarch Bodhi lives and teaches."],
                )
            ]
        )

    async def fake_enrich(**kwargs):
        assert kwargs["scene_name"] == "Bodhi Bedchamber"
        assert kwargs["context_lines"] == ["Bodhi Bedchamber is an important indoor location where Patriarch Bodhi lives and teaches."]
        return NovelScene(
            name="Bodhi Bedchamber",
            aliases=kwargs["aliases"],
            scene_type="interior",
            environment_prompt="Front: Bed\nLeft: Bookshelf\nRight: Window\nBack: Door",
        )

    monkeypatch.setattr("cognee.search", fake_search)
    monkeypatch.setattr(LLMGateway, "acreate_structured_output", fake_structured_output)
    monkeypatch.setattr(pipeline, "enrich_scene_environment_from_context", fake_enrich)
    monkeypatch.setattr(pipeline, "_create_scene_build_agent", lambda *_args: object())

    scenes = await pipeline.extract_scenes_from_graph(
        dataset_name="novel-demo",
        project_name="admin/demo",
    )

    assert search_calls[0]["datasets"] == ["novel-demo"]
    assert search_calls[0]["only_context"] is True
    assert structured_inputs == ["Bodhi Bedchamber is an important indoor location where Patriarch Bodhi lives and teaches."]
    assert [scene.name for scene in scenes] == ["Bodhi Bedchamber"]
    assert scenes[0].aliases == ["Patriarch Bedchamber"]
    assert "Cognee graph" in scenes[0].notes


def test_first_person_narrator_copy_uses_narrator_main_terms(tmp_path):
    from novelvideo.models import CharacterIdentity, NovelCharacter
    from novelvideo.seedance2_i2v.voice_clone import NARRATION_STYLES, resolve_narrator_source

    project_dir = tmp_path / "proj"
    voice_path = project_dir / "assets" / "characters" / "Sang Luo" / "voices" / "voice_default.mp3"
    voice_path.parent.mkdir(parents=True)
    voice_path.write_bytes(b"voice")

    character = NovelCharacter(
        name="Sang Luo",
        gender="female",
        is_main=True,
        reference_audio_path="assets/characters/Sang Luo/voices/voice_default.mp3",
    )
    character.identities = [
        CharacterIdentity(
            identity_id="Sang Luo_reborn",
            character_name="Sang Luo",
            identity_name="reborn",
        )
    ]

    class _Store:
        def get_all_characters(self):
            return [character]

    store = _Store()
    store.project_dir = str(project_dir)
    resolution = resolve_narrator_source(
        store=store,
        narration_style="first_person",
        project_narrator_stored_path="",
    )

    assert resolution.source == "protagonist_identity"
    assert NARRATION_STYLES["first_person"]["label"] == "First person (narrator protagonist's perspective)"
    assert "narrator protagonist" in NARRATION_STYLES["first_person"]["prompt"]
