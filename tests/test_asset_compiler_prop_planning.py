from __future__ import annotations

from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from novelvideo.utils.screenplay_quality import build_import_format_check
from novelvideo.utils.screenplay_scene_parser import parse_scene_blocks


STANDARD_DRAMA_PROP_SCRIPT = """Episode 1 Start
1-1. INT. BASEMENT - NIGHT
Characters: Luke, Mia
△Dust swirls in the dim basement.
Luke: There's something here.
Mia: Don't touch it.
Luke: I'm only looking.
Mia: Be careful.
Luke: This parchment notebook is not right.
Mia: Hand me the tactical flashlight.
Luke: Look at the cover.
Mia: The Book of Fate.
"""


class _FakeSQLiteStore:
    async def load_working_content(self, episode_number: int) -> str:
        return ""

    async def list_props(self) -> list:
        return []

    async def get_prop(self, name: str):
        return None


class _FakeCogneeStore:
    def __init__(self, raw_content: str = ""):
        self.raw_content = raw_content
        self.sqlite_store = _FakeSQLiteStore()
        self.updated: list[tuple[int, dict]] = []

    async def load_episode_content(self, episode_number: int) -> str:
        return self.raw_content

    async def update_episode(self, episode_number: int, **updates) -> None:
        self.updated.append((episode_number, updates))


def test_standard_drama_prop_sample_matches_current_import_format_rules():
    result = build_import_format_check(STANDARD_DRAMA_PROP_SCRIPT, has_chapters=True)
    blocks = parse_scene_blocks(STANDARD_DRAMA_PROP_SCRIPT)

    assert result["level"] == "ok"
    assert result["issues"] == []
    assert len(blocks) == 1
    assert blocks[0].header_line == "1-1. INT. BASEMENT - NIGHT"
    assert blocks[0].location == "BASEMENT"
    assert blocks[0].time_of_day == "night"
    assert blocks[0].interior_exterior == "int"


def test_prop_requirements_reject_model_string_list_output():
    from novelvideo.agents.asset_compiler import BlockPropRequirements

    with pytest.raises(ValidationError) as exc_info:
        BlockPropRequirements.model_validate(
            {"requirements": ["flashlight", "parchment notebook"]},
            context={
                "block_text": STANDARD_DRAMA_PROP_SCRIPT,
                "allowed_existing_names": set(),
            },
        )

    error_locations = {tuple(error["loc"]) for error in exc_info.value.errors()}
    assert ("requirements", 0) in error_locations
    assert ("requirements", 1) in error_locations


def test_block_prop_prompt_explicitly_forbids_string_list_and_synonym_names():
    from novelvideo.agents.asset_compiler import BLOCK_PROP_PROMPT

    assert "requirements must be an array of objects" in BLOCK_PROP_PROMPT
    assert "must not be an array of strings" in BLOCK_PROP_PROMPT
    assert (
        'If the source says "tactical flashlight", do not write "torch"'
        in BLOCK_PROP_PROMPT
    )


@pytest.mark.asyncio
async def test_standard_drama_prop_planner_reports_string_list_validation_error(
    monkeypatch,
):
    import novelvideo.agents.asset_compiler as asset_compiler

    captured: dict[str, object] = {}

    def fake_newapi_model(
        model_env: str, default_model: str | None = None, **_kwargs
    ) -> str:
        return "prop-model"

    def fake_settings() -> dict[str, str]:
        return {"openai_reasoning_effort": "none"}

    class FakeAgent:
        def __init__(self, model, **kwargs):
            captured["agent_kwargs"] = kwargs

        async def run(self, task: str):
            captured["task"] = task
            kwargs = captured["agent_kwargs"]
            output_type = kwargs["output_type"]
            return SimpleNamespace(
                output=output_type.model_validate(
                    {"requirements": ["flashlight", "parchment notebook"]},
                    context=kwargs["validation_context"],
                )
            )

    monkeypatch.setattr(
        asset_compiler, "get_newapi_text_pydantic_model", fake_newapi_model
    )
    monkeypatch.setattr(
        asset_compiler,
        "get_newapi_structured_output_model_settings",
        fake_settings,
    )
    monkeypatch.setattr(asset_compiler, "Agent", FakeAgent)

    store = _FakeCogneeStore(raw_content=STANDARD_DRAMA_PROP_SCRIPT)
    compiler = asset_compiler.AssetCompiler(store)
    logs: list[str] = []

    with pytest.raises(ValueError, match="requirements must be an array of objects"):
        await compiler.compile_episode_props(
            SimpleNamespace(number=1, beat_source_text=STANDARD_DRAMA_PROP_SCRIPT),
            on_log=logs.append,
        )

    assert logs[0] == "[AssetCompiler] Identified 1 scene blocks"
    assert any("requirements must be an array of objects" in log for log in logs)
    assert store.updated == []
    assert "1-1. INT. BASEMENT - NIGHT" in captured["task"]
    assert "tactical flashlight" in captured["task"]


def test_prop_name_must_be_exact_source_substring_or_existing_candidate():
    from novelvideo.agents.asset_compiler import BlockPropRequirements

    block_text = "Mia: Hand me the tactical flashlight."

    with pytest.raises(ValidationError, match="does not appear in the current scene block text"):
        BlockPropRequirements.model_validate(
            {
                "requirements": [
                    {
                        "prop_name": "torch",
                        "visual_prompt": "black metal torch, cold white beam",
                    }
                ]
            },
            context={"block_text": block_text, "allowed_existing_names": set()},
        )

    accepted = BlockPropRequirements.model_validate(
        {
            "requirements": [
                {
                    "prop_name": "tactical flashlight",
                    "visual_prompt": "black metal tactical flashlight, cold white beam",
                }
            ]
        },
        context={"block_text": block_text, "allowed_existing_names": set()},
    )

    assert [req.prop_name for req in accepted.requirements] == ["tactical flashlight"]


@pytest.mark.asyncio
async def test_short_block_reuses_prior_episode_prop_without_ai_reanalysis(monkeypatch):
    import novelvideo.agents.asset_compiler as asset_compiler

    blocks = [
        SimpleNamespace(
            header_line="Scene 4. INT. OLD BOOKSTORE GROUND FLOOR - MORNING; Characters: Luke",
            lines=[
                "The next morning. Luke eagerly opens the notebook, and a new prophecy has indeed appeared.",
                "[close_up]: [June 15, 17:10, Green Deer River old pier, the Li family's youngest son drowns].",
                "Luke breathes hard, gripping the notebook tightly, his eyes turning resolute after the struggle.",
            ],
        ),
        SimpleNamespace(
            header_line="Scene 7. EXT. DREAM FIRE GROUND - NIGHT; Characters: Luke, Grandfather",
            lines=[
                "Grandfather's figure stands in the heart of the blaze; as the fire spreads, his outline twists and fades.",
                "Luke: (muttering in his sleep) Grandpa... no...",
                "Luke jolts awake from the dream, drenched in sweat, the parchment notebook before him radiating a chilling silence in the dark.",
            ],
        ),
    ]
    calls: list[str] = []

    async def fake_analyze(self, block, preselected, prior_selected_prop_ids):
        calls.append(block.header_line)
        if "DREAM FIRE GROUND" in block.header_line:
            raise ValueError("should not call AI for short prior-prop-only block")
        return [
            asset_compiler.PropRequirement(
                prop_name="notebook",
                prop_type="object",
                owner="Luke",
                visual_prompt="a worn hardcover notebook with yellowed pages",
                description="the notebook Luke uses to read the prophecy",
            )
        ]

    monkeypatch.setattr(
        asset_compiler.AssetCompiler, "_analyze_block_props", fake_analyze
    )

    store = _FakeCogneeStore()
    compiler = asset_compiler.AssetCompiler(store)
    logs: list[str] = []

    prop_menu = await compiler._compile_props(
        blocks, SimpleNamespace(number=1), logs.append
    )

    assert [item.prop_id for item in prop_menu] == ["notebook"]
    assert calls == [
        "Scene 4. INT. OLD BOOKSTORE GROUND FLOOR - MORNING; Characters: Luke"
    ]
    assert logs == [
        "  Prop [1]: notebook [episode-local]",
        "  Prop [2]: notebook [episode-reused]",
    ]
