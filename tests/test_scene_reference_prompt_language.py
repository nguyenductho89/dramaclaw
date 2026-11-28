from __future__ import annotations

import re

import pytest

from novelvideo.generators.scene_reference_images import build_scene_reference_prompt
from novelvideo.models import NovelScene

CJK = re.compile(r"[一-鿿]")

EN_ENVIRONMENT = "\n".join(
    [
        "正面：The platform runs along the tracks toward a dark tunnel mouth.",
        "左侧：A concrete wall with a blank display panel.",
        "右侧：The open platform edge facing the rails.",
        "背面：A concrete stairway down to the street.",
        "光源：Fluorescent tubes under the canopy.",
        "材质/风格：Concrete and galvanized steel.",
        "禁止元素：No people, no readable text.",
    ]
)


def _scene(**overrides) -> NovelScene:
    values = {
        "name": "Chicago L Platform",
        "scene_type": "exterior",
        "description": "An empty elevated Chicago L station platform at night.",
        "environment_prompt": EN_ENVIRONMENT,
    }
    values.update(overrides)
    return NovelScene(**values)


@pytest.mark.parametrize("kind", ["master", "reverse_master", "spatial_layout"])
def test_english_scene_prompt_has_no_chinese(kind):
    prompt = build_scene_reference_prompt(
        kind,
        _scene(),
        style_name="写实现代 (realistic)",
        style_prompt="Create a live-action image with grounded realism.",
        avoid_instructions="No anime.",
        has_master_reference=True,
        language="en",
    )

    assert CJK.findall(prompt) == []
    if kind == "master":
        assert "Style id/name: realistic" in prompt


def test_english_headings_replace_chinese_ones_in_the_scene_block():
    prompt = build_scene_reference_prompt("master", _scene(), language="en")

    for heading in ("FRONT: The platform", "LEFT: A concrete wall", "BACK: A concrete stairway", "FORBIDDEN: No people"):
        assert heading in prompt
    assert 'label "FRONT"' in prompt


def test_chinese_scene_keeps_the_original_template():
    scene = _scene(
        name="站台",
        description="空荡的站台。",
        environment_prompt="正面：站台沿铁轨延伸。\n背面：楼梯。",
    )

    prompt = build_scene_reference_prompt(
        "master", scene, style_name="写实现代 (realistic)", language="zh"
    )

    assert "正面：站台沿铁轨延伸。" in prompt
    assert "写实现代 (realistic)" in prompt


def test_scene_enrichment_prompt_pins_environment_body_language():
    from novelvideo.cognee.pipeline import SCENE_ENRICHMENT_SYSTEM_PROMPT

    assert "标题之后的正文必须使用本次指定的输出语言" in SCENE_ENRICHMENT_SYSTEM_PROMPT


def _bare_kitchen(**overrides) -> NovelScene:
    return _scene(name="Kitchen", description="", **overrides)


def _night_plate() -> NovelScene:
    return NovelScene(
        name="Kitchen_夜晚",
        scene_type="interior",
        base_scene_id="Kitchen",
        time_of_day="夜晚",
    )


@pytest.mark.parametrize("kind", ["master", "reverse_master", "spatial_layout"])
@pytest.mark.parametrize(
    "scene, base",
    [
        (_bare_kitchen(), None),
        (_night_plate(), _bare_kitchen()),
        (
            NovelScene(
                name="Kitchen_Flooded",
                base_scene_id="Kitchen",
                variant_id="Flooded",
                variant_prompt="Ankle-deep water covers the floor.",
            ),
            _bare_kitchen(),
        ),
    ],
    ids=["one-word-name", "time-plate", "variant-plate"],
)
def test_short_named_english_scenes_have_no_chinese(kind, scene, base):
    prompt = build_scene_reference_prompt(
        kind, scene, base_scene=base, has_master_reference=True, language="en"
    )

    assert CJK.findall(prompt) == []
    if scene.time_of_day:
        assert "SCENE NAME: Kitchen_night" in prompt
        assert "TARGET TIME-OF-DAY PLATE: night" in prompt
    # Only the prompt text changes; the stored record keeps its name.
    assert scene.name != "Kitchen_night"


def test_the_project_language_picks_the_template_whatever_the_scene_says():
    scene = NovelScene(name="Kitchen")

    english = build_scene_reference_prompt("master", scene, language="en")
    chinese = build_scene_reference_prompt("master", scene, language="zh")

    assert CJK.findall(english) == []
    assert CJK.findall(chinese)


def test_chinese_time_plate_keeps_chinese_name_and_time():
    base = NovelScene(name="厨房", environment_prompt="正面：不锈钢灶台。")
    plate = NovelScene(name="厨房_夜晚", base_scene_id="厨房", time_of_day="夜晚")

    prompt = build_scene_reference_prompt("master", plate, base_scene=base, language="zh")

    assert "SCENE NAME: 厨房_夜晚" in prompt
    assert "TARGET TIME-OF-DAY PLATE: 夜晚" in prompt


def _enrichment(body: str):
    from novelvideo.cognee.pipeline import SceneEnrichmentList

    return SceneEnrichmentList.model_validate(
        {
            "scenes": [
                {
                    "name": "Kitchen",
                    "environment_prompt": "\n".join(
                        f"{heading}：{body}" for heading in ("正面", "左侧", "右侧", "背面")
                    ),
                    "description": "A kitchen.",
                }
            ]
        }
    )


def test_foreign_han_runs_ignores_markers_and_supplied_names():
    from novelvideo.cognee.pipeline import foreign_han_runs

    text = "正面：A counter. 材质/风格: Tile near 老王's stall."
    assert foreign_han_runs(text, "Characters present: 老王") == []
    assert foreign_han_runs("正面：不锈钢灶台", "Kitchen") == ["不锈钢灶台"]


@pytest.mark.asyncio
async def test_english_enrichment_retries_a_chinese_body(monkeypatch):
    from pydantic_ai import Agent
    from pydantic_ai.messages import ModelResponse, ToolCallPart
    from pydantic_ai.models.function import FunctionModel

    from novelvideo.cognee import pipeline

    seen: dict[str, list[str]] = {"system": [], "user": []}
    answers = [_enrichment("不锈钢灶台。"), _enrichment("A steel counter.")]

    def respond(messages, info):
        if not seen["user"]:
            parts = messages[0].parts
            seen["system"] = [p.content for p in parts if p.part_kind == "system-prompt"]
            seen["user"] = [p.content for p in parts if p.part_kind == "user-prompt"]
        return ModelResponse(
            parts=[ToolCallPart(info.output_tools[0].name, answers.pop(0).model_dump())]
        )

    def build(system_prompt, output_type, name, **kwargs):
        return Agent(
            FunctionModel(respond),
            system_prompt=system_prompt,
            output_type=output_type,
            name=name,
            **kwargs,
        )

    monkeypatch.setattr(pipeline, "_create_scene_build_agent", build)

    scene = await pipeline.enrich_scene_environment_from_context(
        scene_name="Kitchen",
        time_of_day="夜晚",
        context_lines=["The chef wipes down the steel counter after closing."],
        output_language="en",
    )

    assert answers == []
    assert scene.environment_prompt.startswith("正面：A steel counter.")
    assert seen["system"] == [pipeline.SCENE_ENRICHMENT_SYSTEM_PROMPT_EN]
    assert "Time-of-day clue: night" in seen["user"][0]
    assert CJK.findall(seen["user"][0]) == []
