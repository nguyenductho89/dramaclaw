from types import SimpleNamespace

from novelvideo.generators.scene_reference_images import build_scene_reference_prompt
from novelvideo.models import NovelScene


def test_scene_reference_prompt_combines_base_prompt_for_variant_without_base_image():
    base_scene = NovelScene(
        name="bathroom",
        scene_type="interior",
        environment_prompt="White tiled walls; the front is the washbasin.",
    )
    variant_scene = NovelScene(
        name="bathroom_leak",
        scene_type="interior",
        base_scene_id="bathroom",
        variant_id="leak",
        variant_prompt="Standing water on the floor; the ceiling keeps dripping.",
        environment_prompt="",
    )

    prompt = build_scene_reference_prompt(
        "master",
        variant_scene,
        base_scene=base_scene,
    )

    assert "White tiled walls" in prompt
    assert "Standing water on the floor" in prompt


def test_scene_reference_prompt_keeps_variant_delta_out_of_scene_description():
    base_scene = NovelScene(
        name="city_street",
        scene_type="exterior",
        environment_prompt="Front: dark gray two-way lanes. Left: modern commercial facades.",
    )
    variant_scene = NovelScene(
        name="city_street_rainy_night",
        scene_type="exterior",
        base_scene_id="city_street",
        variant_id="rainy_night",
        variant_prompt="Light rain falls; the ground is wet with puddles reflecting faint street light.",
        environment_prompt="",
    )

    prompt = build_scene_reference_prompt(
        "master",
        variant_scene,
        base_scene=base_scene,
    )

    assert "VARIANT DELTA PROMPT:\nLight rain falls" in prompt
    scene_description = prompt.split("SCENE DESCRIPTION:", 1)[1].split(
        "PROJECT STYLE PRESET:", 1
    )[0]
    assert "Front: dark gray two-way lanes" in scene_description
    assert "Light rain falls" not in scene_description
    assert "the ground is wet with puddles" not in scene_description


async def test_scene_reference_newapi_uses_normalized_gateway_base_url(monkeypatch, tmp_path):
    import novelvideo.config as config
    from novelvideo.generators import scene_reference_images

    captured: dict[str, str | None] = {}

    async def fake_call_newapi_image_api(**kwargs):
        captured["base_url"] = kwargs.get("base_url")
        return b"image-bytes", "", ""

    monkeypatch.setattr(
        config,
        "get_effective_newapi_gateway_config",
        lambda: SimpleNamespace(
            api_key="platform-key",
            base_url="https://relayclaw.cdnfg.com/v1",
        ),
    )
    monkeypatch.setattr(
        scene_reference_images,
        "_call_newapi_image_api",
        fake_call_newapi_image_api,
    )

    await scene_reference_images.generate_scene_reference_image(
        project_dir=tmp_path,
        scene=NovelScene(name="Hall", environment_prompt="wide hall"),
        kind="master",
    )

    assert captured["base_url"] == "https://relayclaw.cdnfg.com/v1"
