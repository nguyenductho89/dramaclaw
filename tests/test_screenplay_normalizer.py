import pytest

from novelvideo.cognee.screenplay_normalizer import (
    NormalizedSceneBlock,
    clean_scene_name_and_time,
    normalize_time_of_day,
    normalize_screenplay_scenes,
)


@pytest.fixture
def per_scene_enrichment(monkeypatch):
    from novelvideo.cognee import pipeline

    # These normalization tests supply per-scene enrichment below. An empty
    # batch selects that fallback without creating a real model client.
    monkeypatch.setattr(
        pipeline,
        "_create_scene_build_agent",
        lambda *args, **kwargs: _FakeAgent(pipeline.SceneEnrichmentList(scenes=[])),
    )


def test_normalize_time_of_day_maps_aliases_to_closed_choices():
    assert normalize_time_of_day("midnight") == "night"
    assert normalize_time_of_day("late night") == "night"
    assert normalize_time_of_day("daybreak") == "dawn"
    assert normalize_time_of_day("midday") == "noon"
    assert normalize_time_of_day("evening") == "dusk"
    assert normalize_time_of_day("daytime") == "day"
    assert normalize_time_of_day("day") == "day"
    assert normalize_time_of_day("buổi sáng") == "morning"


def test_time_of_day_agent_outputs_expose_closed_enum_schema():

    expected = ["none", "dawn", "morning", "noon", "afternoon", "day", "dusk", "night"]

    block_schema = NormalizedSceneBlock.model_json_schema()["properties"]["time_of_day"]

    assert block_schema["enum"] == expected


def test_time_of_day_agent_no_value_round_trips_to_internal_empty_string():

    block = NormalizedSceneBlock(
        episode_number=3,
        scene_no="1",
        raw_header="3-1 Phoenix City Bedchamber none none",
        location="Phoenix City Bedchamber",
        time_of_day="none",
        interior_exterior="none",
        characters=[],
        aliases=[],
        scene_type="interior",
        evidence_lines=[],
        content_lines=[],
    )
    assert block.time_of_day == ""
    assert block.interior_exterior == ""


def test_time_of_day_agent_outputs_normalize_before_literal_validation():

    block = NormalizedSceneBlock(
        episode_number=3,
        scene_no="1",
        raw_header="3-1 Phoenix City Bedchamber midnight INT",
        location="Phoenix City Bedchamber",
        time_of_day="midnight",
        interior_exterior="int",
        characters=[],
        aliases=[],
        scene_type="interior",
        evidence_lines=[],
        content_lines=[],
    )
    assert block.time_of_day == "night"


def test_clean_scene_name_and_time_removes_trailing_time_word():
    name, tod = clean_scene_name_and_time("Phoenix City Bedchamber midnight", "")

    assert name == "Phoenix City Bedchamber"
    assert tod == "night"


def test_clean_scene_name_and_time_removes_dash_separated_night_token():
    name, tod = clean_scene_name_and_time("Phoenix City Arena Outer Wall - night", "")

    assert name == "Phoenix City Arena Outer Wall"
    assert tod == "night"


def test_clean_scene_name_and_time_removes_comma_separated_night_token():
    name, tod = clean_scene_name_and_time("Arena Outer Wall, night", "")

    assert name == "Arena Outer Wall"
    assert tod == "night"


def test_clean_scene_name_and_time_removes_dot_separated_night_token():
    name, tod = clean_scene_name_and_time("Arena Outer Wall · night", "")

    assert name == "Arena Outer Wall"
    assert tod == "night"


def test_clean_scene_name_and_time_removes_spaced_interior_exterior_marker():
    name, tod = clean_scene_name_and_time("Zheng Office INT", "")

    assert name == "Zheng Office"
    assert tod == ""


def test_clean_scene_name_and_time_preserves_phrase_that_only_contains_a_time_word():
    name, tod = clean_scene_name_and_time("Night Market Square", "")

    assert name == "Night Market Square"
    assert tod == ""


def test_clean_scene_name_and_time_preserves_specific_location_anchor():
    name, tod = clean_scene_name_and_time("Under the 3D Big Screen on Chunxi Road", "")

    assert name == "Under the 3D Big Screen on Chunxi Road"
    assert tod == ""


@pytest.mark.parametrize(
    ("raw_name", "expected_name", "expected_time"),
    [
        ("Seoul Subway Station 11:47 PM", "Seoul Subway Station", "night"),
        ("Living Room - NIGHT", "Living Room", "night"),
        ("Park, daytime", "Park", "day"),
        ("Studio 54", "Studio 54", ""),
    ],
)
def test_clean_scene_name_and_time_removes_english_time_suffixes(
    raw_name, expected_name, expected_time
):
    name, tod = clean_scene_name_and_time(raw_name, "")

    assert name == expected_name
    assert tod == expected_time


def test_normalized_scene_block_validator_cleans_location_time():
    block = NormalizedSceneBlock(
        episode_number=3,
        scene_no="1",
        raw_header="3-1 Phoenix City Bedchamber midnight INT",
        location="Phoenix City Bedchamber midnight",
        time_of_day="",
        interior_exterior="int",
        characters=["Su Tang", "Shen Wan"],
        aliases=[],
        scene_type="interior",
        evidence_lines=["3-1 Phoenix City Bedchamber midnight INT"],
        content_lines=["Candlelight flickers."],
    )

    assert block.location == "Phoenix City Bedchamber"
    assert block.time_of_day == "night"


def test_scene_heading_suffix_strip_removes_time_markers():
    """The name cleanup a per-block model call used to be needed for."""
    from novelvideo.cognee.pipeline import strip_scene_heading_suffix

    assert strip_scene_heading_suffix("Arena Outer Wall - night") == "Arena Outer Wall"
    assert strip_scene_heading_suffix("Arena Outer Wall, night") == "Arena Outer Wall"
    assert (
        strip_scene_heading_suffix("Phoenix City Granary night")
        == "Phoenix City Granary"
    )


def test_scene_heading_suffix_strip_never_generalizes_a_location():
    """It removes heading markers, never part of the place itself."""
    from novelvideo.cognee.pipeline import strip_scene_heading_suffix

    assert strip_scene_heading_suffix("Lanzhou Noodle House") == "Lanzhou Noodle House"
    assert (
        strip_scene_heading_suffix("Under the 3D Big Screen on Chunxi Road")
        == "Under the 3D Big Screen on Chunxi Road"
    )


def test_a_spaced_interior_marker_is_stripped_from_the_name():
    """"Zheng Office INT" is the same room as "Zheng Office".

    In English and Vietnamese the marker is always a separate word, so removing
    it never eats part of a place name ("Interior Design Studio" keeps its
    leading word because the marker is only stripped at the end).
    """
    from novelvideo.cognee.pipeline import strip_scene_heading_suffix

    assert strip_scene_heading_suffix("Zheng Office INT") == "Zheng Office"
    assert strip_scene_heading_suffix("Zheng Villa EXT") == "Zheng Villa"
    assert strip_scene_heading_suffix("Interior Design Studio") == "Interior Design Studio"


def test_scene_candidates_fill_missing_episode_from_raw_header():
    from novelvideo.cognee.pipeline import _scene_candidates_from_normalized_blocks

    candidates = _scene_candidates_from_normalized_blocks(
        [
            NormalizedSceneBlock(
                episode_number=0,
                scene_no="1",
                raw_header="3-1 Phoenix City Bedchamber night INT",
                location="Phoenix City Bedchamber",
                time_of_day="night",
                interior_exterior="int",
                characters=["Su Tang"],
                aliases=["Luan Bedchamber"],
                scene_type="interior",
                evidence_lines=["3-1 Phoenix City Bedchamber night INT"],
                content_lines=["Su Tang wakes up."],
            ),
            NormalizedSceneBlock(
                episode_number=0,
                scene_no="1",
                raw_header="5-1 Phoenix City Bedchamber midnight INT",
                location="Phoenix City Bedchamber",
                time_of_day="midnight",
                interior_exterior="int",
                characters=["Shen Wan"],
                aliases=["Luan Bedchamber"],
                scene_type="interior",
                evidence_lines=["5-1 Phoenix City Bedchamber midnight INT"],
                content_lines=["Shen Wan pushes the door open."],
            ),
        ]
    )

    assert candidates[0]["episodes"] == [3, 5]


class _FakeRunResult:
    def __init__(self, output):
        self.output = output


class _FakeAgent:
    def __init__(self, output):
        self.output = output
        self.prompts = []

    async def run(self, prompt: str):
        self.prompts.append(prompt)
        return _FakeRunResult(self.output)


@pytest.mark.asyncio
async def test_single_normalizer_keeps_a_parsed_english_location_verbatim():
    from novelvideo.cognee.screenplay_normalizer import (
        NormalizedSceneHeader,
        normalize_screenplay_scene_header,
    )

    agent = _FakeAgent(
        NormalizedSceneHeader(
            episode_number=1,
            scene_no="1",
            location="Main Hall Library",
            time_of_day="day",
            interior_exterior="int",
        )
    )

    result = await normalize_screenplay_scene_header(
        "1-1 Central Library - DAY",
        location_hint="Central Library",
        context_lines=["MAYA walks between the shelves."],
        agent=agent,
    )

    assert result is not None and result.location == "Central Library"
    assert "English" in agent.prompts[0]


@pytest.mark.asyncio
async def test_batch_normalizer_keeps_each_parsed_english_location_verbatim():
    from novelvideo.cognee.screenplay_normalizer import (
        BatchSceneHeaderItem,
        NormalizedSceneHeaderBatch,
    )

    agent = _FakeAgent(
        NormalizedSceneHeaderBatch(
            scenes=[
                BatchSceneHeaderItem(
                    index=0,
                    episode_number=1,
                    scene_no="1",
                    location="Main Hall Library",
                    time_of_day="day",
                    interior_exterior="int",
                )
            ]
        )
    )

    scenes = await normalize_screenplay_scenes(
        "INT./EXT. CENTRAL LIBRARY - DAY\n"
        "MAYA walks between the shelves and opens a book.",
        agent=agent,
    )

    assert [scene.location for scene in scenes] == ["CENTRAL LIBRARY"]
    assert "English" in agent.prompts[0]


@pytest.mark.asyncio
async def test_standard_headings_are_normalized_without_a_model_call():
    """A standard heading already states location, time and interior/exterior.

    Asking a model to restate them is a round trip per scene, and a heading is
    about fourteen characters long.
    """

    class _NeverCalled:
        async def run(self, prompt: str):
            raise AssertionError("a standard heading must not reach the model")

    scenes = await normalize_screenplay_scenes(
        "1-1 Bedchamber night INT\nCharacters: Wukong\nWukong: Master.\n"
        "1-2 Temple Gate day EXT\nCharacters: Wukong, Acolyte\nWukong walks out of the temple gate.",
        agent=_NeverCalled(),
    )

    assert [scene.location for scene in scenes] == ["Bedchamber", "Temple Gate"]
    assert [scene.interior_exterior for scene in scenes] == ["int", "ext"]
    assert [scene.content_lines for scene in scenes] == [
        ["Wukong: Master."],
        ["Wukong walks out of the temple gate."],
    ]


async def test_headings_the_parser_cannot_resolve_go_to_the_model_in_one_batch():
    from novelvideo.cognee.screenplay_normalizer import (
        BatchSceneHeaderItem,
        NormalizedSceneHeaderBatch,
    )

    class _BatchAgent:
        def __init__(self):
            self.prompts: list[str] = []

        async def run(self, prompt: str):
            self.prompts.append(prompt)
            return _FakeRunResult(
                NormalizedSceneHeaderBatch(
                    scenes=[
                        BatchSceneHeaderItem(
                            index=0, episode_number=3, scene_no="1",
                            location="Phoenix City Bedchamber", time_of_day="night",
                            interior_exterior="int", aliases=["Luan Bedchamber"],
                        ),
                        BatchSceneHeaderItem(
                            index=1, episode_number=3, scene_no="2",
                            location="Imperial Garden", time_of_day="day",
                            interior_exterior="ext",
                        ),
                    ]
                )
            )

    agent = _BatchAgent()
    # Neither heading states interior/exterior, so the parser cannot finish
    # either one and both must travel to the model.
    scenes = await normalize_screenplay_scenes(
        "3-1 Phoenix City Bedchamber night\nCharacters: Su Tang, Shen Wan, Jin Xiu\nInside the bedchamber, the bed curtains are lowered.\n"
        "3-2 Imperial Garden day\nCharacters: Su Tang\nSu Tang walks through the corridor.",
        agent=agent,
    )

    # Both unresolved headings travelled in a single request.
    assert len(agent.prompts) == 1
    assert "Phoenix City Bedchamber" in agent.prompts[0]
    assert "Imperial Garden" in agent.prompts[0]

    assert len(scenes) == 2
    by_location = {scene.location: scene for scene in scenes}
    assert by_location["Phoenix City Bedchamber"].time_of_day == "night"
    assert by_location["Phoenix City Bedchamber"].characters == ["Su Tang", "Shen Wan", "Jin Xiu"]
    assert by_location["Phoenix City Bedchamber"].content_lines == ["Inside the bedchamber, the bed curtains are lowered."]


@pytest.mark.asyncio
@pytest.mark.usefixtures("per_scene_enrichment")
async def test_extract_scenes_from_script_prefers_ai_normalized_blocks(monkeypatch):
    from novelvideo.cognee import pipeline
    from novelvideo.models import NovelScene

    async def fake_normalize(_text: str):
        return [
            NormalizedSceneBlock(
                episode_number=1,
                scene_no="1",
                raw_header="1-1 Phoenix City Bedchamber night INT",
                location="Phoenix City Bedchamber",
                time_of_day="night",
                interior_exterior="int",
                characters=["Su Tang"],
                aliases=["Luan Bedchamber"],
                scene_type="interior",
                evidence_lines=["1-1 Phoenix City Bedchamber night INT"],
                content_lines=["Su Tang sits bolt upright in bed."],
            ),
            NormalizedSceneBlock(
                episode_number=3,
                scene_no="1",
                raw_header="3-1 Phoenix City Bedchamber night INT",
                location="Phoenix City Bedchamber",
                time_of_day="night",
                interior_exterior="int",
                characters=["Su Tang", "Shen Wan", "Jin Xiu"],
                aliases=["Luan Bedchamber"],
                scene_type="interior",
                evidence_lines=["3-1 Phoenix City Bedchamber night INT"],
                content_lines=["Inside the bedchamber, the bed curtains are lowered."],
            ),
        ]

    async def fake_enrich_scene_environment_from_context(**kwargs):
        return NovelScene(
            name=kwargs["scene_name"],
            aliases=kwargs.get("aliases") or [],
            scene_type=kwargs["scene_type"],
            environment_prompt="Front: The bed and bed curtains.\nLeft: A folding screen.\nRight: A windowsill.\nBack: The hall door.",
            description="The princess's bedchamber",
        )

    monkeypatch.setattr(pipeline, "normalize_screenplay_scenes", fake_normalize)
    monkeypatch.setattr(
        pipeline,
        "enrich_scene_environment_from_context",
        fake_enrich_scene_environment_from_context,
    )

    scenes = await pipeline.extract_scenes_from_script(
        "1-1 Phoenix City Bedchamber night INT\nSu Tang wakes up.\n"
        "3-1 Phoenix City Bedchamber night INT\nThe assassination begins."
    )

    assert len(scenes) == 1
    assert scenes[0].name == "Phoenix City Bedchamber"
    assert scenes[0].aliases == ["Luan Bedchamber"]
    assert scenes[0].scene_type == "interior"
    assert scenes[0].time_of_day == ""
    assert "observed_times: night×2" in scenes[0].notes


@pytest.mark.asyncio
@pytest.mark.usefixtures("per_scene_enrichment")
async def test_extract_scenes_from_script_falls_back_when_ai_returns_partial_blocks(
    monkeypatch,
):
    from novelvideo.cognee import pipeline
    from novelvideo.models import NovelScene

    async def fake_normalize(_text: str):
        return [
            NormalizedSceneBlock(
                episode_number=1,
                scene_no="1",
                raw_header="1-1 Phoenix City Bedchamber night INT",
                location="Phoenix City Bedchamber",
                time_of_day="night",
                interior_exterior="int",
                characters=["Su Tang"],
                aliases=["Luan Bedchamber"],
                scene_type="interior",
                evidence_lines=["1-1 Phoenix City Bedchamber night INT"],
                content_lines=["Su Tang wakes up."],
            )
        ]


    async def fake_enrich_scene_environment_from_context(**kwargs):
        return NovelScene(
            name=kwargs["scene_name"],
            aliases=kwargs.get("aliases") or [],
            scene_type=kwargs["scene_type"],
            environment_prompt="Front: Main subject.\nLeft: Side wall.\nRight: Side wall.\nBack: Entrance.",
            description="",
        )

    monkeypatch.setattr(pipeline, "normalize_screenplay_scenes", fake_normalize)
    monkeypatch.setattr(
        pipeline,
        "enrich_scene_environment_from_context",
        fake_enrich_scene_environment_from_context,
    )

    scenes = await pipeline.extract_scenes_from_script(
        "1-1 Phoenix City Bedchamber night INT\n"
        "Characters: Su Tang\n"
        "Su Tang wakes up.\n\n"
        "1-2 Phoenix City Imperial Garden dawn EXT\n"
        "Characters: Su Tang, Shen Wan\n"
        "The two talk in low voices beside the flower path."
    )

    assert [scene.name for scene in scenes] == [
        "Phoenix City Bedchamber",
        "Phoenix City Imperial Garden",
    ]


@pytest.mark.asyncio
@pytest.mark.usefixtures("per_scene_enrichment")
async def test_extract_scenes_from_script_falls_back_when_ai_returns_empty(monkeypatch):
    from novelvideo.cognee import pipeline
    from novelvideo.models import NovelScene

    async def fake_normalize(_text: str):
        return []


    async def fake_enrich_scene_environment_from_context(**kwargs):
        return NovelScene(
            name=kwargs["scene_name"],
            aliases=kwargs.get("aliases") or [],
            scene_type=kwargs["scene_type"],
            environment_prompt="Front: Scene subject.\nLeft: Side space.\nRight: Side space.\nBack: Reverse space.",
        )

    monkeypatch.setattr(pipeline, "normalize_screenplay_scenes", fake_normalize)
    monkeypatch.setattr(
        pipeline,
        "enrich_scene_environment_from_context",
        fake_enrich_scene_environment_from_context,
    )

    scenes = await pipeline.extract_scenes_from_script(
        "3-1 Phoenix City Bedchamber night INT\nCharacters: Su Tang, Shen Wan\nCandlelight flickers."
    )

    assert len(scenes) == 1
    assert scenes[0].name == "Phoenix City Bedchamber"


@pytest.mark.asyncio
@pytest.mark.usefixtures("per_scene_enrichment")
async def test_extract_scenes_from_script_falls_back_when_ai_merges_distinct_locations(
    monkeypatch,
):
    from novelvideo.cognee import pipeline
    from novelvideo.models import NovelScene

    async def fake_normalize(_text: str):
        return [
            NormalizedSceneBlock(
                episode_number=1,
                scene_no="1",
                raw_header="1-1 Phoenix City Bedchamber night INT",
                location="Phoenix City Bedchamber",
                time_of_day="night",
                interior_exterior="int",
                characters=["Su Tang"],
                aliases=["Luan Bedchamber"],
                scene_type="interior",
                evidence_lines=["1-1 Phoenix City Bedchamber night INT"],
                content_lines=["Su Tang wakes up."],
            ),
            NormalizedSceneBlock(
                episode_number=1,
                scene_no="2",
                raw_header="1-2 Phoenix City Imperial Garden dawn EXT",
                location="Phoenix City Bedchamber",
                time_of_day="dawn",
                interior_exterior="ext",
                characters=["Su Tang", "Shen Wan"],
                aliases=["Luan Bedchamber"],
                scene_type="exterior",
                evidence_lines=["1-2 Phoenix City Imperial Garden dawn EXT"],
                content_lines=["The two talk in low voices beside the flower path."],
            ),
        ]


    async def fake_enrich_scene_environment_from_context(**kwargs):
        return NovelScene(
            name=kwargs["scene_name"],
            aliases=kwargs.get("aliases") or [],
            scene_type=kwargs["scene_type"],
            environment_prompt="Front: Main subject.\nLeft: Side wall.\nRight: Side wall.\nBack: Entrance.",
            description="",
        )

    monkeypatch.setattr(pipeline, "normalize_screenplay_scenes", fake_normalize)
    monkeypatch.setattr(
        pipeline,
        "enrich_scene_environment_from_context",
        fake_enrich_scene_environment_from_context,
    )

    scenes = await pipeline.extract_scenes_from_script(
        "1-1 Phoenix City Bedchamber night INT\n"
        "Characters: Su Tang\n"
        "Su Tang wakes up.\n\n"
        "1-2 Phoenix City Imperial Garden dawn EXT\n"
        "Characters: Su Tang, Shen Wan\n"
        "The two talk in low voices beside the flower path."
    )

    assert [scene.name for scene in scenes] == [
        "Phoenix City Bedchamber",
        "Phoenix City Imperial Garden",
    ]
