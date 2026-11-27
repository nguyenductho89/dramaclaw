from __future__ import annotations

import re

import pytest

from novelvideo.generators.scene_reference_images import (
    build_scene_reference_prompt,
    scene_prompt_language,
)
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
    )

    assert CJK.findall(prompt) == []
    if kind == "master":
        assert "Style id/name: realistic" in prompt


def test_english_headings_replace_chinese_ones_in_the_scene_block():
    prompt = build_scene_reference_prompt("master", _scene())

    for heading in ("FRONT: The platform", "LEFT: A concrete wall", "BACK: A concrete stairway", "FORBIDDEN: No people"):
        assert heading in prompt
    assert 'label "FRONT"' in prompt


def test_chinese_scene_keeps_the_original_template():
    scene = _scene(
        name="站台",
        description="空荡的站台。",
        environment_prompt="正面：站台沿铁轨延伸。\n背面：楼梯。",
    )

    prompt = build_scene_reference_prompt("master", scene, style_name="写实现代 (realistic)")

    assert scene_prompt_language(scene) == "zh"
    assert "正面：站台沿铁轨延伸。" in prompt
    assert "写实现代 (realistic)" in prompt


def test_scene_enrichment_prompt_pins_environment_body_language():
    from novelvideo.cognee.pipeline import SCENE_ENRICHMENT_SYSTEM_PROMPT

    assert "标题之后的正文必须使用本次指定的输出语言" in SCENE_ENRICHMENT_SYSTEM_PROMPT
