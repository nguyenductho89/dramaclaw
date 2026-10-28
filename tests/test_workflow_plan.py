from __future__ import annotations

import copy
import importlib.util
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, ValidationError

from novelvideo.freezone.agent_workflows.graph import build_workflow_graph_commands
from novelvideo.freezone.workflow_plan import validate_workflow_plan
from novelvideo.freezone.workflow_preflight import evaluate_workflow_preflight
from novelvideo.freezone.workflow_schema import (
    workflow_intent_json_schema,
    workflow_plan_json_schema,
)

_MINIMAL_ECOMMERCE_SKILL = {
    "id": "ecommerce-product",
    "name": "E-commerce Product Image",
    "version": 6,
    "description": "E-commerce product image Skill for testing",
    "enabled": True,
    "triggers": {"node_scopes": ["imageGeneration"]},
    "allowed_recipe_ids": [
        "ecommerce-ad-image",
        "general-image",
        "custom-shot-image",
    ],
}

_MINIMAL_ECOMMERCE_RECIPES = [
    {
        "id": "ecommerce-ad-image",
        "name": "E-commerce Ad Image",
        "version": 5,
        "enabled": True,
        "output_kind": "image",
        "requires_source_media": True,
    },
    {
        "id": "general-image",
        "name": "General Image",
        "version": 1,
        "enabled": True,
        "output_kind": "image",
        "requires_source_media": False,
    },
    {
        "id": "general-video",
        "name": "General Video",
        "version": 1,
        "enabled": True,
        "output_kind": "video",
        "requires_source_media": False,
    },
    {
        "id": "custom-shot-image",
        "name": "Custom Storyboard Image",
        "version": 1,
        "enabled": True,
        "output_kind": "image",
        "requires_source_media": False,
    },
]


def _load_catalog_module():
    path = (
        Path(__file__).resolve().parents[1]
        / "src"
        / "novelvideo"
        / "freezone"
        / "agent_workflows"
        / "catalog.py"
    )
    spec = importlib.util.spec_from_file_location("test_dynamic_workflow_catalog", path)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _install_minimal_builtin_catalog(monkeypatch, catalog) -> None:
    def fake_load_json_dir(path):
        if path == catalog._SKILLS_DIR:
            return copy.deepcopy([_MINIMAL_ECOMMERCE_SKILL])
        if path == catalog._RECIPES_DIR:
            return copy.deepcopy(_MINIMAL_ECOMMERCE_RECIPES)
        return []

    monkeypatch.setattr(catalog, "_load_json_dir", fake_load_json_dir)
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)


def _install_real_builtin_catalog(monkeypatch, catalog) -> None:
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)


def test_standard_ecommerce_image_planner_omits_audio_video_and_compose(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    result = catalog.compile_workflow_intent(
        {
            "skill_id": "ecommerce-ad",
            "user_goal": "Generate three e-commerce images of a black action camera",
            "planner": {
                "mode": "standard",
                "deliverable": "images",
                "item_count": 3,
                "include_audio": True,
            },
        }
    )

    assert result["ok"] is True, result
    assert result["planner"]["include_audio"] is False
    node_types = {node["node_type"] for node in result["plan"]["nodes"]}
    assert "audioNode" not in node_types
    assert "videoNode" not in node_types
    assert "videoComposeNode" not in node_types


def test_social_content_campaign_builtin_skill_is_loadable(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    package = catalog.get_workflow_skill(
        {
            "skill_id": "social-content-campaign",
            "user_goal": "Make Xiaohongshu images",
        }
    )

    assert package["ok"] is True
    assert package["input_contract"]["resolved"]["aspect_ratio"] == "3:4"
    assert {recipe["id"] for recipe in package["available_recipes"]} == {
        "social-copywriting",
        "social-content-image",
        "social-xiaohongshu-image",
        "social-douyin-cover",
        "social-weibo-wechat-image",
        "social-ig-post",
    }


def test_social_content_image_count_controls_nodes_not_variants(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "social-content-campaign",
            "user_goal": "Make three social media images",
            "items": [
                {
                    "id": f"social_image_{index}",
                    "title": f"Social image {index}",
                    "recipe_id": "social-content-image",
                }
                for index in range(1, 4)
            ],
            "include_compose": False,
        }
    )

    assert compiled["ok"] is True, compiled
    image_nodes = [
        node
        for node in compiled["plan"]["nodes"]
        if node["node_type"] == "imageGenNode"
    ]
    assert len(image_nodes) == 3
    assert all("count" not in node["data"] for node in image_nodes)
    assert all(
        node["data"]["workflowCatalog"]["confirmedInputs"]["image_count"] == 3
        for node in image_nodes
    )


def test_social_agent_plan_rejects_skill_defaults_that_contradict_its_nodes(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "social-content-campaign",
            "user_goal": "Make two social images",
            "inputs": {
                "platforms": ["Weibo/WeChat", "Instagram"],
                "image_count": 2,
                "aspect_ratio": "1:1",
                "image_aspect_ratio": "1:1",
            },
            "items": [
                {"id": "weibo", "title": "Weibo version", "recipe_id": "social-weibo-wechat-image"},
                {"id": "ig", "title": "Instagram version", "recipe_id": "social-ig-post"},
            ],
            "include_compose": False,
        }
    )
    assert compiled["ok"] is True, compiled
    plan = copy.deepcopy(compiled["plan"])
    plan.pop("planner", None)
    plan.pop("mode", None)
    plan["inputs"] = {"image_aspect_ratio": "1:1"}

    rejected = catalog.validate_agent_workflow_plan(plan)

    assert rejected["ok"] is False, rejected
    assert rejected["status"] == "invalid_dynamic_workflow_plan"
    assert {error["path"] for error in rejected["errors"]} >= {
        "inputs.platforms",
        "inputs.image_count",
        "inputs.aspect_ratio",
    }
    assert plan["inputs"] == {"image_aspect_ratio": "1:1"}

    plan["inputs"] = {
        "platforms": ["Weibo/WeChat", "Instagram"],
        "image_count": 2,
        "aspect_ratio": "1:1",
        "image_aspect_ratio": "1:1",
    }
    accepted = catalog.validate_agent_workflow_plan(plan)
    assert accepted["ok"] is True, accepted
    assert accepted["resolved_inputs"]["platforms"] == ["Weibo/WeChat", "Instagram"]
    assert accepted["resolved_inputs"]["image_count"] == 2
    assert accepted["resolved_inputs"]["aspect_ratio"] == "1:1"

    for parameter_id, conflicting_value in (
        ("platforms", ["Xiaohongshu"]),
        ("image_count", 3),
        ("aspect_ratio", "3:4"),
    ):
        conflicting_plan = copy.deepcopy(plan)
        conflicting_plan["inputs"][parameter_id] = conflicting_value
        rejected = catalog.validate_agent_workflow_plan(conflicting_plan)
        assert rejected["ok"] is False, parameter_id
        assert f"inputs.{parameter_id}" in {
            error["path"] for error in rejected["errors"]
        }


def test_social_agent_plan_can_keep_unspecified_skill_defaults(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "social-content-campaign",
            "user_goal": "Make three social media images",
            "items": [
                {
                    "id": f"social_image_{index}",
                    "title": f"Social image {index}",
                    "recipe_id": "social-content-image",
                }
                for index in range(1, 4)
            ],
            "include_compose": False,
        }
    )
    assert compiled["ok"] is True, compiled
    plan = copy.deepcopy(compiled["plan"])
    plan.pop("planner", None)
    plan.pop("mode", None)
    plan["inputs"] = {}

    accepted = catalog.validate_agent_workflow_plan(plan)

    assert accepted["ok"] is True, accepted
    assert accepted["resolved_inputs"]["platforms"] == ["Xiaohongshu"]
    assert accepted["resolved_inputs"]["image_count"] == 3
    assert accepted["resolved_inputs"]["aspect_ratio"] == "3:4"


def test_social_intent_compiler_keeps_single_recipe_compile_contract(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "social-content-campaign",
            "user_goal": "Compile a general social image plan item",
            "items": [
                {"id": "image", "title": "Image", "recipe_id": "social-content-image"}
            ],
            "include_compose": False,
        }
    )

    assert compiled["ok"] is True, compiled
    assert len(
        [node for node in compiled["plan"]["nodes"] if node["node_type"] == "imageGenNode"]
    ) == 1
    assert compiled["plan"]["inputs"]["image_count"] == 1

    platform_compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "social-content-campaign",
            "user_goal": "Compile an Instagram image plan item",
            "items": [
                {"id": "image", "title": "Image", "recipe_id": "social-ig-post"}
            ],
            "include_compose": False,
        }
    )
    assert platform_compiled["ok"] is True, platform_compiled
    assert platform_compiled["plan"]["inputs"]["platforms"] == ["Instagram"]
    assert platform_compiled["plan"]["inputs"]["image_count"] == 1


def test_social_explicit_platform_rejects_generic_recipe(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    result = catalog.compile_workflow_intent({
        "skill_id": "social-content-campaign", "user_goal": "Instagram image",
        "inputs": {"platforms": ["Instagram"], "image_count": 1},
        "items": [{"id": "image", "title": "Image", "recipe_id": "social-content-image"}],
        "include_compose": False,
    })
    assert result["ok"] is False
    assert any(error["path"] == "inputs.platforms" for error in result["errors"])


def test_social_rejects_mixed_image_ratios(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    result = catalog.compile_workflow_intent({
        "skill_id": "social-content-campaign", "user_goal": "Two-platform images",
        "inputs": {"platforms": ["Weibo/WeChat", "Instagram"], "image_count": 2,
                   "aspect_ratio": "1:1"},
        "items": [
            {"id": "weibo", "title": "Weibo version", "recipe_id": "social-weibo-wechat-image"},
            {"id": "ig", "title": "IG version", "recipe_id": "social-ig-post"},
        ],
        "include_compose": False,
    })
    assert result["ok"] is True, result
    plan = copy.deepcopy(result["plan"])
    images = [node for node in plan["nodes"] if node["node_type"] == "imageGenNode"]
    images[1]["data"]["aspectRatio"] = "16:9"
    rejected = catalog.validate_agent_workflow_plan(plan)
    assert rejected["ok"] is False
    assert any(error["path"] == "inputs.aspect_ratio" for error in rejected["errors"])


def test_social_single_instagram_recipe_uses_compatible_default_ratio(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    result = catalog.compile_workflow_intent({
        "skill_id": "social-content-campaign", "user_goal": "Instagram image",
        "items": [{"id": "ig", "title": "IG version", "recipe_id": "social-ig-post"}],
        "include_compose": False,
    })
    assert result["ok"] is True, result
    assert result["plan"]["inputs"]["aspect_ratio"] == "1:1"
    image = next(node for node in result["plan"]["nodes"] if node["node_type"] == "imageGenNode")
    assert image["data"]["aspectRatio"] == "1:1"
    incompatible = copy.deepcopy(result["plan"])
    incompatible["inputs"]["aspect_ratio"] = "3:4"
    image = next(node for node in incompatible["nodes"] if node["node_type"] == "imageGenNode")
    image["data"]["aspectRatio"] = "3:4"
    rejected = catalog.validate_agent_workflow_plan(incompatible)
    assert rejected["ok"] is False
    assert any(error["path"] == "inputs.aspect_ratio" for error in rejected["errors"])


def test_social_incompatible_platform_recipes_use_native_ratios_without_global_choice(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    result = catalog.compile_workflow_intent({
        "skill_id": "social-content-campaign", "user_goal": "Xiaohongshu and Instagram images",
        "items": [
            {"id": "xhs", "title": "Xiaohongshu version", "recipe_id": "social-xiaohongshu-image"},
            {"id": "ig", "title": "IG version", "recipe_id": "social-ig-post"},
        ],
        "include_compose": False,
    })
    assert result["ok"] is True, result
    plan = result["plan"]
    assert "aspect_ratio" not in plan["inputs"]
    images = {node["id"]: node for node in plan["nodes"] if node["node_type"] == "imageGenNode"}
    assert images["xhs"]["data"]["aspectRatio"] == "3:4"
    assert images["ig"]["data"]["aspectRatio"] == "1:1"
    validated = catalog.validate_agent_workflow_plan(plan)
    assert validated["ok"] is True, validated
    assert "aspect_ratio" not in validated["resolved_inputs"]

    explicit = copy.deepcopy(plan)
    explicit["inputs"]["aspect_ratio"] = "3:4"
    rejected = catalog.validate_agent_workflow_plan(explicit)
    assert rejected["ok"] is False
    assert any(error["path"] == "inputs.aspect_ratio" for error in rejected["errors"])


def test_pixar_custom_anchor_rejects_default_character_source(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    result = catalog.compile_workflow_intent({
        "skill_id": "pixar-ip-ad-video", "user_goal": "Character ad",
        "inputs": {"character_input_method": "Custom character"},
        "items": [{"id": "character", "title": "Character anchor", "recipe_id": "ad-ip-character-anchor",
                   "stage": "characters", "prompt": "Design the protagonist as a custom character"}],
    })
    assert result["ok"] is True, result
    plan = copy.deepcopy(result["plan"])
    plan["inputs"].pop("character_input_method")
    anchor = next(node for node in plan["nodes"] if node["id"] == "character")
    anchor["data"]["workflowCatalog"].pop("confirmedInputs", None)
    rejected = catalog.validate_agent_workflow_plan(plan)
    assert rejected["ok"] is False
    assert any(error["path"] == "inputs.character_input_method" for error in rejected["errors"])


def test_standard_video_planner_distributes_target_duration_across_clips(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    result = catalog.compile_workflow_intent(
        {
            "skill_id": "ecommerce-ad",
            "user_goal": "Make a 30-second vertical perfume ad",
            "planner": {
                "mode": "standard",
                "deliverable": "video",
                "item_count": 5,
                "total_duration_seconds": 30,
                "include_audio": False,
                "units": [
                    {"title": f"Shot {index}", "prompt": f"Perfume shot {index}"}
                    for index in range(1, 6)
                ],
            },
        }
    )

    assert result["ok"] is True
    video_nodes = [
        node for node in result["plan"]["nodes"] if node["node_type"] == "videoNode"
    ]
    assert len(video_nodes) == 5
    assert [node["data"]["durationSec"] for node in video_nodes] == [6, 6, 6, 6, 6]
    assert sum(node["data"]["durationSec"] for node in video_nodes) == 30


def test_standard_video_planner_builds_sequential_clip_dependencies(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    intent = {
        "skill_id": "text-to-image-video",
        "user_goal": "Create five videos executed in order, creating only nodes and edges",
        "inputs": {"video_generation_mode": "textToVideo"},
        "planner": {
            "mode": "standard",
            "deliverable": "video",
            "item_count": 5,
            "include_audio": False,
            "video_dependency": "sequential",
        },
        "include_compose": False,
    }
    Draft202012Validator(workflow_intent_json_schema()).validate(intent)
    result = catalog.compile_workflow_intent(intent)

    assert result["ok"] is True, result
    assert result["planner"]["mode"] == "deterministic_standard"
    assert result["planner"]["video_dependency"] == "sequential"
    video_nodes = [
        node for node in result["plan"]["nodes"] if node["node_type"] == "videoNode"
    ]
    assert len(video_nodes) == 5
    edges = result["plan"]["edges"]
    assert [
        {
            "source": f"clip_{index}",
            "target": f"clip_{index + 1}",
            "link_type": "dependency_for",
        }
        for index in range(1, 5)
    ] == [
        edge
        for edge in edges
        if edge["source"].startswith("clip_")
        and edge["target"].startswith("clip_")
    ]
    assert [
        edge
        for edge in edges
        if edge["source"].startswith("frame_")
        and edge["target"].startswith("clip_")
    ] == [
        {
            "source": f"frame_{index}",
            "target": f"clip_{index}",
            "link_type": "dependency_for",
        }
        for index in range(1, 6)
    ]
    image_nodes = [
        node for node in result["plan"]["nodes"] if node["node_type"] == "imageGenNode"
    ]
    assert image_nodes
    assert all(node["data"]["model"] == "recommended" for node in image_nodes)
    assert result["plan"]["inputs"]["video_generation_mode"] == "textToVideo"


def test_standard_image_to_video_keeps_frame_as_media_input(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    result = catalog.compile_workflow_intent({
        "skill_id": "text-to-image-video",
        "user_goal": "First generate key images, then use the key images to generate videos",
        "inputs": {"video_generation_mode": "imageReference"},
        "planner": {
            "mode": "standard",
            "deliverable": "video",
            "item_count": 2,
            "include_audio": False,
        },
    })

    assert result["ok"] is True, result
    assert [
        edge["link_type"]
        for edge in result["plan"]["edges"]
        if edge["source"].startswith("frame_")
        and edge["target"].startswith("clip_")
    ] == ["media_input_for", "media_input_for"]


def test_standard_image_planner_rejects_sequential_video_dependency(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    result = catalog.compile_workflow_intent({
        "skill_id": "ecommerce-ad",
        "user_goal": "Create three product images",
        "planner": {
            "mode": "standard",
            "deliverable": "images",
            "item_count": 3,
            "video_dependency": "sequential",
        },
    })

    assert result["ok"] is False
    assert result["errors"][0]["path"] == "planner.video_dependency"


def test_standard_tutorial_frames_consume_the_generated_outline(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    result = catalog.compile_workflow_intent({
        "skill_id": "video-tutorial",
        "user_goal": "Make a three-step coffee tutorial: 15 g of coffee, water at 92 degrees Celsius, 30 g pre-infusion for 30 seconds, 240 g of water in total",
        "planner": {
            "mode": "standard", "deliverable": "video", "item_count": 3,
            "include_audio": False, "total_duration_seconds": 18,
            "units": [
                {"title": f"Step {i}", "prompt": f"Show tutorial step {i}"}
                for i in range(1, 4)
            ],
        },
    })

    assert result["ok"] is True, result
    edges = result["plan"]["edges"]
    assert all(
        {"source": "outline", "target": f"frame_{i}", "link_type": "prompt_for"}
        in edges for i in range(1, 4)
    )
    assert not any(
        edge["source"] == "outline" and edge["target"].startswith("frame_")
        and edge["link_type"] == "dependency_for" for edge in edges
    )


def test_standard_tutorial_outline_keeps_facts_supplied_in_units(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    result = catalog.compile_workflow_intent({
        "skill_id": "video-tutorial", "user_goal": "Three-step pour-over coffee tutorial",
        "planner": {"mode": "standard", "deliverable": "video", "item_count": 3,
                    "include_audio": False, "total_duration_seconds": 18,
                    "units": [
                        {"title": "Prepare", "prompt": "Use 15 g of coffee"},
                        {"title": "Pre-infuse", "prompt": "Pour in 30 g of 92 degrees Celsius water and wait 30 seconds"},
                        {"title": "Finish", "prompt": "Keep pouring up to 240 g"},
                    ]},
    })
    assert result["ok"] is True, result
    outline = next(node for node in result["plan"]["nodes"] if node["id"] == "outline")
    assert all(fact in outline["data"]["prompt"] for fact in (
        "15 g", "92 degrees Celsius", "30 g", "30 seconds", "240 g",
    ))
    assert "milk" not in outline["data"]["prompt"]


def test_standard_tutorial_recommends_and_verifies_a_missing_video_model(monkeypatch):
    from novelvideo.freezone.workflow_preflight import evaluate_workflow_preflight

    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    compiled = catalog.compile_workflow_intent({
        "skill_id": "video-tutorial", "user_goal": "Make a coffee tutorial",
        "inputs": {"image_model": "image-model", "video_generation_mode": "imageToVideo",
                   "video_duration_seconds": 6},
        "planner": {"mode": "standard", "deliverable": "video", "item_count": 1,
                    "include_audio": False, "units": [
                        {"title": "Step one", "prompt": "Show the coffee brewing steps"},
                    ]},
    })
    assert compiled["ok"] is True, compiled
    result = evaluate_workflow_preflight(
        compiled,
        model_responses={
            "imageGenNode": {"ok": True, "data": [{"id": "image-model"}]},
            "videoNode": {"ok": True, "data": [{
                "id": "seedance-2.0-fast", "aliases": ["newapi_seedance-2.0-fast"],
                "supportedModes": ["image_to_video"], "minDuration": 4,
                "maxDuration": 15, "ratioOptions": ["16:9"],
                "resolutionOptions": ["720P"],
            }]},
        },
        limits={"ok": True, "data": {"default": {"limit": 2, "remaining": 1},
                                      "video": {"limit": 2, "remaining": 1}}},
    )
    assert result["status"] == "ready", result["blockers"]
    video = next(node for node in compiled["plan"]["nodes"] if node["node_type"] == "videoNode")
    assert video["data"]["model"] == "seedance-2.0-fast"
    assert result["runtime_checks"]["videoNode.models"] == {
        "requested": ["seedance-2.0-fast"], "available": True,
    }


def test_quick_drama_rejects_untitled_video_shots(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    compiled = catalog.compile_workflow_intent({
        "skill_id": "short-drama-quick", "user_goal": "Two-shot short drama",
        "inputs": {"visual_style": "unspecified"},
        "planner": {"mode": "standard", "deliverable": "video", "item_count": 2,
                    "include_audio": False, "units": [
                        {"title": "Opening", "prompt": "The protagonist walks in"},
                        {"title": "Ending", "prompt": "The protagonist stays"},
                    ]},
    })
    assert compiled["ok"] is True, compiled
    valid = catalog.validate_agent_workflow_plan(compiled["plan"], allow_template_reroute=False)
    assert valid["ok"] is True, valid
    plan = copy.deepcopy(compiled["plan"])
    shot = next(node for node in plan["nodes"] if node["node_type"] == "videoNode")
    for field in ("title", "name", "label"):
        shot.pop(field, None)
        shot["data"].pop(field, None)
    shot["data"].pop("displayName", None)
    invalid = catalog.validate_agent_workflow_plan(plan, allow_template_reroute=False)
    assert invalid["ok"] is False
    assert any(error["path"].endswith(".data.title") for error in invalid["errors"])


def test_custom_video_item_keeps_structured_or_prompt_duration(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    result = catalog.compile_workflow_intent(
        {
            "skill_id": "ecommerce-ad",
            "user_goal": "Make a 30-second vertical perfume ad",
            "items": [
                {
                    "id": "product_anchor",
                    "title": "Product reference image",
                    "prompt": "A transparent glass perfume bottle",
                    "recipe_id": "general-image",
                },
                {
                    "id": "clip_explicit",
                    "title": "Product close-up",
                    "prompt": "The camera slowly pushes in on the perfume bottle",
                    "duration_seconds": 7,
                    "recipe_id": "video-clip-generation",
                    "depends_on": ["product_anchor"],
                },
                {
                    "id": "clip_legacy",
                    "title": "Brand ending",
                    "prompt": "The perfume bottle rotates slowly, 6 seconds, 9:16 vertical",
                    "recipe_id": "video-clip-generation",
                    "depends_on": ["product_anchor"],
                },
            ],
            "include_audio": False,
            "include_compose": True,
        }
    )

    assert result["ok"] is True, result
    video_nodes = {
        node["id"]: node
        for node in result["plan"]["nodes"]
        if node["node_type"] == "videoNode"
    }
    assert video_nodes["clip_explicit"]["data"]["durationSec"] == 7
    assert video_nodes["clip_legacy"]["data"]["durationSec"] == 6
    assert (
        video_nodes["clip_legacy"]["data"]["workflowCatalog"]["promptBuilder"][
            "planItem"
        ]["duration_seconds"]
        == 6
    )


def test_dynamic_text_dependencies_gate_media_without_becoming_prompts(monkeypatch):
    catalog = _load_catalog_module()
    recipes = copy.deepcopy(_MINIMAL_ECOMMERCE_RECIPES)
    recipes.append(
        {
            "id": "general-text",
            "name": "General Text",
            "version": 1,
            "enabled": True,
            "output_kind": "text",
            "requires_source_media": False,
        }
    )
    skill = copy.deepcopy(_MINIMAL_ECOMMERCE_SKILL)
    skill["allowed_recipe_ids"].extend(["general-text", "general-video"])
    skill["triggers"]["node_scopes"].append("videoGeneration")

    def fake_load_json_dir(path):
        if path == catalog._SKILLS_DIR:
            return [copy.deepcopy(skill)]
        if path == catalog._RECIPES_DIR:
            return copy.deepcopy(recipes)
        return []

    monkeypatch.setattr(catalog, "_load_json_dir", fake_load_json_dir)
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    result = catalog.compile_workflow_intent(
        {
            "skill_id": "ecommerce-product",
            "user_goal": "First write the product Brief, then generate the product main image",
            "items": [
                {
                    "id": "brief",
                    "title": "Product Brief",
                    "recipe_id": "general-text",
                },
                {
                    "id": "outline",
                    "title": "Product outline",
                    "recipe_id": "general-text",
                    "depends_on": ["brief"],
                },
                {
                    "id": "hero-image",
                    "title": "Product main image",
                    "recipe_id": "general-image",
                    "depends_on": ["outline"],
                },
                {
                    "id": "hero-video",
                    "title": "Product video",
                    "recipe_id": "general-video",
                    "depends_on": ["hero-image"],
                },
            ],
            "include_compose": False,
        }
    )

    assert result["ok"] is True, result
    edges = {
        (edge["source"], edge["target"]): edge["link_type"]
        for edge in result["plan"]["edges"]
    }
    assert edges[("brief", "outline")] == "context_for"
    assert edges[("outline", "hero-image")] == "dependency_for"
    assert edges[("hero-image", "hero-video")] == "media_input_for"


def test_standard_skill_planners_expand_without_agent_authored_topology(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    skill_package = catalog.get_workflow_skill(
        {"skill_id": "ecommerce-ad", "user_goal": "Generate an e-commerce ad"}
    )
    planning_contract = skill_package["planning_contract"]
    assert planning_contract["topology_modes"] == ["standard_planner", "custom_items"]
    assert planning_contract["requires_agent_authored_topology"] is False
    assert planning_contract["custom_items_require_agent_authored_topology"] is True
    assert planning_contract["requires_explicit_recipe_id"] is False
    assert planning_contract["custom_items_require_explicit_recipe_id"] is True

    expectations = {
        "ecommerce-ad": {"video-clip-generation", "general-audio"},
        "text-to-image-video": {"general-image", "general-video"},
        "video-tutorial": {"general-video", "general-audio"},
        "short-drama-quick": {"general-video", "drama-shot-voice"},
    }
    for skill_id, expected_recipe_ids in expectations.items():
        result = catalog.compile_workflow_intent(
            {
                "skill_id": skill_id,
                "user_goal": "Generate a two-part vertical test video",
                **({"inputs": {"visual_style": "unspecified"}}
                   if skill_id == "short-drama-quick" else {}),
                "planner": {
                    "mode": "standard",
                    "item_count": 2,
                    "units": [
                        {
                            "title": "Opening",
                            "prompt": "Quickly establish the theme",
                            "narration": "First, the core content.",
                        },
                        {
                            "title": "Ending",
                            "prompt": "Wrap up the information",
                            "narration": "That is everything.",
                        },
                    ],
                },
            }
        )

        assert result["ok"] is True
        assert result["planner"] == {
            "mode": "deterministic_standard",
            "skill_id": skill_id,
            "deliverable": "video",
            "item_count": 2,
            "include_audio": skill_id != "text-to-image-video",
        }
        plan = result["plan"]
        assert plan["planner"] == result["planner"]
        recipe_ids = {
            node.get("data", {}).get("workflowCatalog", {}).get("recipeId")
            for node in plan["nodes"]
        }
        assert expected_recipe_ids <= recipe_ids
        assert catalog.validate_agent_workflow_plan(plan)["ok"] is True


def test_text_to_image_video_standard_plan_feeds_outline_into_each_image(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    result = catalog.compile_workflow_intent(
        {
            "skill_id": "text-to-image-video",
            "user_goal": "First plan two pictures, then generate the images and videos in turn",
            "planner": {"mode": "standard", "item_count": 2},
        }
    )

    assert result["ok"] is True, result
    plan = result["plan"]
    edges = {
        (edge["source"], edge["target"]): edge["link_type"]
        for edge in plan["edges"]
    }
    assert edges[("outline", "frame_1")] == "prompt_for"
    assert edges[("outline", "frame_2")] == "prompt_for"
    assert catalog.skill_stage_blockers("text-to-image-video", plan["nodes"], plan["edges"]) == []


def test_text_to_image_standard_plan_creates_images_without_video(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    result = catalog.compile_workflow_intent(
        {
            "skill_id": "text-to-image",
            "user_goal": "Generate two forest-themed illustrations",
            "planner": {"mode": "standard", "item_count": 2},
        }
    )

    assert result["ok"] is True, result
    assert result["planner"]["deliverable"] == "images"
    nodes = result["plan"]["nodes"]
    assert len([node for node in nodes if node["node_type"] == "imageGenNode"]) == 2
    assert not any(node["node_type"] == "videoNode" for node in nodes)
    assert catalog.skill_stage_blockers("text-to-image", nodes, result["plan"]["edges"]) == []


def test_ecommerce_standard_plan_feeds_creative_outline_into_product_reference(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    result = catalog.compile_workflow_intent(
        {
            "skill_id": "ecommerce-ad",
            "user_goal": "Plan a product ad, then generate the reference image, scene images and videos",
            "planner": {"mode": "standard", "item_count": 1},
            "include_audio": False,
        }
    )

    assert result["ok"] is True, result
    plan = result["plan"]
    edges = {
        (edge["source"], edge["target"]): edge["link_type"]
        for edge in plan["edges"]
    }
    assert edges[("creative_outline", "product_reference")] == "prompt_for"
    product_reference = next(node for node in plan["nodes"] if node["id"] == "product_reference")
    assert product_reference["data"]["workflowCatalog"]["promptBuilder"]["planItem"][
        "reference_inputs"
    ] == ["creative_outline"]
    assert catalog.skill_stage_blockers("ecommerce-ad", plan["nodes"], plan["edges"]) == []

    order_only = copy.deepcopy(plan)
    next(
        edge for edge in order_only["edges"]
        if edge["source"] == "creative_outline" and edge["target"] == "product_reference"
    )["link_type"] = "dependency_for"
    assert any(
        blocker["code"] == "skill_stage_unused"
        for blocker in catalog.skill_stage_blockers(
            "ecommerce-ad", order_only["nodes"], order_only["edges"]
        )
    )


def test_ecommerce_external_image_replaces_generated_asset_stage(monkeypatch):
    """An existing product image is the asset; recovery must not generate an anchor."""
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    plan = {
        "schema_version": "freezone_workflow_plan.v1",
        "skill": {"id": "ecommerce-ad", "version": 1},
        "summary": "Use the selected red cup as the only image input and remix it.",
        "external_inputs": [
            {"id": "red_cup", "node_id": "red-cup-source", "media_kind": "image"}
        ],
        "nodes": [
            {
                "id": "result",
                "node_type": "imageGenNode",
                "stage": "images",
                "data": {
                    "prompt": "Keep the cup shape, use a blue background, and add no text.",
                    "workflowCatalog": {"recipeId": "ecommerce-remix-image"},
                },
            }
        ],
        "edges": [
            {"source": "red_cup", "target": "result", "link_type": "media_input_for"}
        ],
    }

    missing_planning = catalog.validate_agent_workflow_plan(plan)

    assert missing_planning["ok"] is True, missing_planning
    assert [
        (blocker["code"], blocker["stage"])
        for blocker in missing_planning["preflight"]["blockers"]
    ] == [("skill_stage_missing", "planning")]

    plan["nodes"].insert(
        0,
        {
            "id": "planning_brief",
            "node_type": "textAnnotationNode",
            "stage": "planning",
            "data": {
                "prompt": "Plan the requested red-cup background replacement.",
                "workflowCatalog": {"recipeId": "general-text"},
            },
        },
    )
    plan["edges"].append(
        {"source": "planning_brief", "target": "result", "link_type": "prompt_for"}
    )

    ready = catalog.validate_agent_workflow_plan(plan)

    assert ready["ok"] is True, ready
    assert ready["preflight"]["status"] == "ready"
    assert ready["preflight"]["blockers"] == []
    assert [
        node["id"]
        for node in ready["plan"]["nodes"]
        if node["node_type"] == "imageGenNode"
    ] == ["result"]
    assert ready["plan"]["edges"][0] == {
        "source": "red_cup",
        "target": "result",
        "link_type": "media_input_for",
    }


def test_ecommerce_standard_planner_binds_external_image_to_requested_recipe(
    monkeypatch,
):
    """CORE-RCP-02: compact planning owns the topology and reaches ready once."""
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    intent = {
        "schema_version": "freezone_workflow_intent.v1",
        "skill_id": "ecommerce-ad",
        "user_goal": (
            "Use ecommerce-remix-image with the selected red cup only; preserve its shape, "
            "replace the background with blue, and add no text."
        ),
        "external_inputs": [
            {"id": "red_cup", "node_id": "red-cup-source", "media_kind": "image"}
        ],
        "planner": {
            "mode": "standard",
            "deliverable": "images",
            "item_count": 1,
            "image_recipe_id": "ecommerce-remix-image",
        },
        "include_audio": False,
        "include_compose": False,
    }

    result = catalog.compile_workflow_intent(intent)

    assert result["ok"] is True, result
    Draft202012Validator(workflow_intent_json_schema()).validate(intent)
    assert result["planner"]["mode"] == "deterministic_standard"
    assert result["preflight"]["status"] == "ready"
    assert result["preflight"]["blockers"] == []
    plan = result["plan"]
    planning_nodes = [node for node in plan["nodes"] if node.get("stage") == "planning"]
    image_nodes = [
        node for node in plan["nodes"] if node.get("node_type") == "imageGenNode"
    ]
    assert len(planning_nodes) == 1
    assert len(image_nodes) == 1
    assert (
        image_nodes[0]["data"]["workflowCatalog"]["recipeId"] == "ecommerce-remix-image"
    )
    assert not any(node.get("stage") == "assets" for node in plan["nodes"])
    edges = {
        (edge["source"], edge["target"]): edge["link_type"] for edge in plan["edges"]
    }
    assert edges[(planning_nodes[0]["id"], image_nodes[0]["id"])] == "prompt_for"
    assert edges[("red_cup", image_nodes[0]["id"])] == "media_input_for"
    assert [
        edge for edge in plan["edges"] if edge["link_type"] == "media_input_for"
    ] == [
        {
            "source": "red_cup",
            "target": image_nodes[0]["id"],
            "link_type": "media_input_for",
        }
    ]


def _raw_plan_from_standard(catalog, intent: dict, *, deviate: bool = True) -> dict:
    """A raw plan derived from the standard planner output.

    With ``deviate`` the plan feeds the second frame from the first clip, an
    edge that runs from the video stage back to the images stage: a genuine
    custom topology that stays on the agent-authored path (issue #678).
    Without it the plan restates the template and is rerouted.
    """
    if intent.get("skill_id") == "short-drama-quick":
        intent = {**intent, "inputs": {"visual_style": "unspecified", **intent.get("inputs", {})}}
    compiled = catalog.compile_workflow_intent(intent)
    assert compiled["ok"] is True, compiled
    plan = copy.deepcopy(compiled["plan"])
    plan.pop("planner", None)
    plan.pop("layout", None)
    if deviate:
        plan["edges"].append(
            {"source": "clip_1", "target": "frame_2", "link_type": "media_input_for"}
        )
    return plan


def test_agent_authored_plan_backfills_runtime_fields_from_skill_inputs(monkeypatch):
    """Issue #677: the raw plan path applies the same portable preferences the
    standard planner writes, without overriding values the plan states."""
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    plan = _raw_plan_from_standard(
        catalog, {"skill_id": "text-to-image-video", "user_goal": "Generate a cyber city text-to-image-to-video clip"}
    )
    video_nodes = [node for node in plan["nodes"] if node["node_type"] == "videoNode"]
    assert video_nodes
    for node in video_nodes:
        for field in ("durationSec", "genMode", "generateAudio", "quality", "count"):
            node["data"].pop(field, None)
    # One node states its own duration; it must survive the backfill.
    video_nodes[0]["data"]["durationSec"] = 3
    plan["inputs"] = {
        "video_duration_seconds": 6,
        "video_generate_audio": True,
        "video_generation_mode": "imageToVideo",
        "video_resolution": "720P",
        "video_variants_per_node": 2,
    }

    validated = catalog.validate_agent_workflow_plan(plan)

    assert validated["ok"] is True, validated
    filled = {
        node["id"]: node["data"]
        for node in validated["plan"]["nodes"]
        if node["node_type"] == "videoNode"
    }
    first = filled[video_nodes[0]["id"]]
    assert first["durationSec"] == 3
    assert first["genMode"] == "imageToVideo"
    assert first["generateAudio"] is True
    assert first["quality"] == "720P"
    assert first["count"] == 2
    for node_id, data in filled.items():
        if node_id != video_nodes[0]["id"]:
            assert data["durationSec"] == 6
    backfilled = validated["backfilled_runtime_fields"]
    assert "durationSec" not in backfilled[video_nodes[0]["id"]]
    assert set(backfilled[video_nodes[0]["id"]]) == {"genMode", "generateAudio", "quality", "count"}
    # The plan preflight is rebuilt on the backfilled nodes.
    assert validated["preflight"]["planned_video_duration_seconds"] == 3 + 6 * (len(filled) - 1)


def test_agent_authored_per_shot_duration_alias_cannot_be_masked_by_global_default(monkeypatch):
    """A noncanonical per-shot 7 s value must not become a ready 8 s runtime shot."""
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    plan = _raw_plan_from_standard(
        catalog, {"skill_id": "text-to-image-video", "user_goal": "Two shots of 8 seconds and 7 seconds in turn"}
    )
    videos = [node for node in plan["nodes"] if node["node_type"] == "videoNode"]
    assert len(videos) >= 2
    videos[0]["data"]["durationSec"] = 8
    videos[1]["data"].pop("durationSec", None)
    videos[1]["data"]["durationSeconds"] = 7
    plan["inputs"] = {"video_duration_seconds": 8}

    validated = catalog.validate_agent_workflow_plan(copy.deepcopy(plan))

    assert validated["ok"] is True, validated
    assert validated["preflight"]["status"] == "blocked"
    assert validated["preflight"]["blockers"] == [{
        "path": f"nodes[{plan['nodes'].index(videos[1])}].data.durationSeconds",
        "code": "noncanonical_video_duration",
        "message": "durationSeconds is ignored by workflow runtime; set data.durationSec explicitly",
    }]
    second = next(node for node in validated["plan"]["nodes"] if node["id"] == videos[1]["id"])
    assert "durationSec" not in second["data"]

    videos[1]["data"]["durationSec"] = 8
    conflicting = catalog.validate_agent_workflow_plan(plan)
    assert conflicting["ok"] is True, conflicting
    assert conflicting["preflight"]["status"] == "blocked"
    assert conflicting["preflight"]["blockers"][0]["code"] == "noncanonical_video_duration"

    videos[1]["data"]["durationSec"] = 7
    explicit = catalog.validate_agent_workflow_plan(plan)
    assert explicit["ok"] is True, explicit
    assert explicit["preflight"]["status"] == "ready"
    second = next(node for node in explicit["plan"]["nodes"] if node["id"] == videos[1]["id"])
    assert second["data"]["durationSec"] == 7

def _mode_plan(catalog, node_mode, *, deviate=True, shared_mode="imageToVideo"):
    plan = _raw_plan_from_standard(
        catalog,
        {"skill_id": "text-to-image-video", "user_goal": "Two image-to-video clips"},
        deviate=deviate,
    )
    for node in plan["nodes"]:
        if node["node_type"] == "videoNode":
            node["data"].pop("genMode", None)
            if node_mode:
                node["data"]["genMode"] = node_mode
    plan["inputs"] = {"video_generation_mode": shared_mode} if shared_mode else {}
    return plan


def _mode_conflicts(validated, code="video_generation_mode_conflict"):
    return [
        blocker
        for blocker in (validated.get("preflight") or {}).get("blockers") or []
        if blocker.get("code") == code
    ]


@pytest.mark.parametrize("deviate", [True, False], ids=["agent_authored", "template_reroute"])
def test_plan_video_mode_without_stated_mode_blocks_draft(monkeypatch, deviate):
    """Issue #711 r210 shape: video_generation_mode omitted, every video node
    pinned to firstFrame. The draft must not become ready."""
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    validated = catalog.validate_agent_workflow_plan(
        _mode_plan(catalog, "firstFrame", deviate=deviate, shared_mode=None)
    )

    assert validated["ok"] is True, validated
    assert validated["preflight"]["status"] == "blocked"
    video_count = sum(
        1 for node in validated["plan"]["nodes"] if node["node_type"] == "videoNode"
    )
    assert len(_mode_conflicts(validated, "video_generation_mode_unconfirmed")) == video_count


@pytest.mark.parametrize("deviate", [True, False], ids=["agent_authored", "template_reroute"])
def test_plan_cannot_confirm_its_own_swapped_video_mode(monkeypatch, deviate):
    """Review of #714: confirmedInputs written into a submitted plan is not a
    per-node confirmation; the swapped node still blocks the draft."""
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    plan = _mode_plan(catalog, None, deviate=deviate)
    video = next(node for node in plan["nodes"] if node["node_type"] == "videoNode")
    video["data"]["genMode"] = "firstFrame"
    video["data"]["workflowCatalog"].setdefault("confirmedInputs", {})[
        "video_generation_mode"
    ] = "firstFrame"

    validated = catalog.validate_agent_workflow_plan(plan)

    assert validated["ok"] is True, validated
    conflicts = _mode_conflicts(validated)
    assert [blocker["path"] for blocker in conflicts] == [
        f"runtime.models.{video['id']}.genMode"
    ]


def test_plan_first_frame_stated_as_shared_mode_is_consistent(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    validated = catalog.validate_agent_workflow_plan(
        _mode_plan(catalog, "firstFrame", shared_mode="firstFrame")
    )

    assert validated["ok"] is True, validated
    assert not [
        b for b in validated["preflight"].get("blockers") or [] if b["path"].endswith(".genMode")
    ]


@pytest.mark.parametrize("deviate", [True, False], ids=["agent_authored", "template_reroute"])
def test_plan_video_mode_contradicting_requested_mode_blocks_draft(monkeypatch, deviate):
    """Issue #711: the user asked for imageToVideo; nodes pinned to firstFrame
    must not produce a ready draft that silently delivers another mode."""
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    validated = catalog.validate_agent_workflow_plan(
        _mode_plan(catalog, "firstFrame", deviate=deviate)
    )

    assert validated["ok"] is True, validated
    assert validated["preflight"]["status"] == "blocked"
    conflicts = _mode_conflicts(validated)
    video_ids = [
        node["id"] for node in validated["plan"]["nodes"] if node["node_type"] == "videoNode"
    ]
    assert [blocker["path"] for blocker in conflicts] == [
        f"runtime.models.{node_id}.genMode" for node_id in video_ids
    ]
    assert all(blocker["allowed_values"] == ["imageToVideo"] for blocker in conflicts)
    # The node value is reported, never rewritten behind the user's back.
    assert {
        node["data"]["genMode"]
        for node in validated["plan"]["nodes"]
        if node["node_type"] == "videoNode"
    } == {"firstFrame"}


@pytest.mark.parametrize("node_mode", [None, "imageToVideo"])
def test_plan_video_mode_matching_requested_mode_stays_consistent(monkeypatch, node_mode):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    validated = catalog.validate_agent_workflow_plan(_mode_plan(catalog, node_mode))

    assert validated["ok"] is True, validated
    assert _mode_conflicts(validated) == []
    assert validated["resolved_inputs"]["video_generation_mode"] == "imageToVideo"
    assert {
        node["data"]["genMode"]
        for node in validated["plan"]["nodes"]
        if node["node_type"] == "videoNode"
    } == {"imageToVideo"}


def test_intent_video_item_carries_explicit_embedded_audio_requirement():
    item = {
        "id": "shot-1", "title": "Dialogue shot", "recipe_id": "general-video",
        "prompt": "The character speaks the dialogue", "duration_seconds": 7,
        "requires_generated_audio": True,
    }
    Draft202012Validator(workflow_intent_json_schema()).validate({
        "skill_id": "video-ad", "user_goal": "Dialogue short", "items": [item],
    })
    catalog = _load_catalog_module()
    parsed_item = catalog._intent_items({"items": [item]})[0]
    assert parsed_item["requires_generated_audio"] is True
    node = catalog._intent_item_node(
        skill={"id": "video-ad", "version": 1},
        recipe={"id": "general-video", "name": "Video", "version": 1},
        node_type="videoNode", item_id="shot-1", item=parsed_item,
        user_goal="Dialogue short", resolved_inputs={}, recipe_pipeline=[],
    )

    assert node["data"]["workflowCatalog"]["requiresGeneratedAudio"] is True


def test_explicit_intent_audio_requirement_survives_recipe_rebinding(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "ling-cage-cinematic-video",
            "user_goal": "Make a shot that must include sync sound",
            "items": [
                {
                    "id": "shot",
                    "title": "Dialogue shot",
                    "recipe_id": "sci-fi-survival-shot-video",
                    "prompt": "The character speaks the dialogue",
                    "duration_seconds": 5,
                    "requires_generated_audio": True,
                }
            ],
        }
    )

    assert compiled["ok"] is True, compiled
    checked = catalog.validate_agent_workflow_plan(
        compiled["plan"], allow_template_reroute=False
    )
    shot = next(
        node
        for node in checked["plan"]["nodes"]
        if node["node_type"] == "videoNode"
    )
    assert shot["data"]["workflowCatalog"]["requiresGeneratedAudio"] is True


@pytest.mark.parametrize(
    ("skill_id", "shot_recipe_id", "anchor_recipe_id"),
    [
        ("ling-cage-cinematic-video", "sci-fi-survival-shot-video", None),
        (
            "retro-hong-kong-kungfu-comedy-video",
            "anthropomorphic-kungfu-shot-video",
            "anthropomorphic-kungfu-key-elements",
        ),
    ],
)
def test_builtin_shot_recipe_accepts_confirmed_silent_agent_plan(
    monkeypatch, skill_id, shot_recipe_id, anchor_recipe_id
):
    """The user's direct sound choice must win over optional Recipe audio."""
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    items = []
    if anchor_recipe_id:
        items.append(
            {
                "id": "anchor",
                "title": "Character reference",
                "recipe_id": anchor_recipe_id,
                "prompt": "Character reference image",
            }
        )
    items.append(
        {
            "id": "shot",
            "title": "Dialogue shot",
            "recipe_id": shot_recipe_id,
            "prompt": "A single shot with dialogue and ambient sound",
            "duration_seconds": 5,
            **({"depends_on": ["anchor"]} if anchor_recipe_id else {}),
        }
    )
    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": skill_id,
            "user_goal": "Make a short with dialogue and without BGM",
            "items": items,
        }
    )
    assert compiled["ok"] is True, compiled
    plan = copy.deepcopy(compiled["plan"])
    plan.pop("planner", None)
    shot = next(node for node in plan["nodes"] if node["node_type"] == "videoNode")
    shot["data"]["generateAudio"] = False
    # Simulate a draft compiled before the built-in Recipe made generated
    # audio optional. Validation must rebind this cached catalog value.
    shot["data"]["workflowCatalog"]["requiresGeneratedAudio"] = True

    silent = catalog.validate_agent_workflow_plan(plan, allow_template_reroute=False)

    assert silent["ok"] is True, silent
    actual_shot = next(
        n for n in silent["plan"]["nodes"] if n["node_type"] == "videoNode"
    )
    assert actual_shot["data"]["workflowCatalog"].get("requiresGeneratedAudio") is False
    silent_preflight = evaluate_workflow_preflight(
        silent, model_responses={}, limits={}, runtime_available=False
    )
    assert not any(
        blocker["code"] == "generation_parameter_conflict"
        for blocker in silent_preflight["blockers"]
    )
    shot["data"]["generateAudio"] = True
    audible = catalog.validate_agent_workflow_plan(plan, allow_template_reroute=False)
    audible_preflight = evaluate_workflow_preflight(
        audible, model_responses={}, limits={}, runtime_available=False
    )
    assert not any(
        blocker["code"] == "generation_parameter_conflict"
        for blocker in audible_preflight["blockers"]
    )


def test_ling_cage_requires_every_video_to_feed_terminal_compose():
    catalog = _load_catalog_module()
    nodes = [
        {"id": "shot-1", "node_type": "videoNode"},
        {"id": "shot-2", "node_type": "videoNode"},
    ]

    missing = catalog.skill_stage_blockers(
        "ling-cage-cinematic-video", nodes, []
    )
    assert any(
        blocker["code"] == "skill_stage_missing"
        and blocker["path"] == "plan.stages.compose"
        for blocker in missing
    )

    nodes.append({"id": "compose", "node_type": "videoComposeNode"})
    partly_connected = catalog.skill_stage_blockers(
        "ling-cage-cinematic-video",
        nodes,
        [
            {
                "source": "shot-1",
                "target": "compose",
                "link_type": "composition_input_for",
            }
        ],
    )
    assert any(
        blocker["code"] == "skill_stage_unused"
        and blocker["node_ids"] == ["shot-2"]
        for blocker in partly_connected
    )

    complete = catalog.skill_stage_blockers(
        "ling-cage-cinematic-video",
        nodes,
        [
            {
                "source": shot_id,
                "target": "compose",
                "link_type": "composition_input_for",
            }
            for shot_id in ("shot-1", "shot-2")
        ],
    )
    assert not any(
        blocker["path"].startswith("plan.stages.compose") for blocker in complete
    )

    duplicated = catalog.skill_stage_blockers(
        "ling-cage-cinematic-video",
        [*nodes, {"id": "compose-extra", "node_type": "videoComposeNode"}],
        [
            {
                "source": shot_id,
                "target": "compose",
                "link_type": "composition_input_for",
            }
            for shot_id in ("shot-1", "shot-2")
        ],
    )
    assert any(
        blocker["code"] == "skill_stage_unused"
        and blocker["path"] == "plan.stages.compose.nodes"
        and blocker["node_ids"] == ["compose-extra"]
        for blocker in duplicated
    )


def test_workflow_intent_schema_rejects_recipe_discovery_metadata():
    intent = {
        "skill_id": "video-ad",
        "user_goal": "Generate an ad image",
        "items": [
            {
                "id": "image-1",
                "title": "Ad image",
                "recipe_id": "general-image",
                "requires_source_media": False,
            }
        ],
    }

    with pytest.raises(ValidationError) as exc_info:
        Draft202012Validator(workflow_intent_json_schema()).validate(intent)

    assert list(exc_info.value.absolute_path) == ["items", 0]
    assert "requires_source_media" in exc_info.value.message


def test_workflow_intent_schema_accepts_first_frame_video_mode():
    Draft202012Validator(workflow_intent_json_schema()).validate(
        {
            "skill_id": "text-to-image-video",
            "user_goal": "Generate a video from the first frame",
            "inputs": {"video_generation_mode": "firstFrame"},
        }
    )


def test_agent_authored_plan_backfills_model_and_generic_aspect_ratio(monkeypatch):
    """Raw plans that carry the model / universal ratio only in plan.inputs must
    not run on the runtime default model or shape."""
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    plan = _raw_plan_from_standard(
        catalog, {"skill_id": "text-to-image-video", "user_goal": "Generate a cyber city text-to-image-to-video clip"}
    )
    for node in plan["nodes"]:
        if node["node_type"] in {"imageGenNode", "videoNode"}:
            node["data"].pop("model", None)
            node["data"].pop("aspectRatio", None)
    video = next(node for node in plan["nodes"] if node["node_type"] == "videoNode")
    video["data"]["durationSec"] = 5
    plan["inputs"] = {
        "image_model": "LingShan-G2",
        "video_model": "seedance-2.0",
        "aspect_ratio": "16:9",
    }

    validated = catalog.validate_agent_workflow_plan(plan)

    assert validated["ok"] is True, validated
    for node in validated["plan"]["nodes"]:
        if node["node_type"] == "imageGenNode":
            assert node["data"]["model"] == "LingShan-G2"
            assert node["data"]["aspectRatio"] == "16:9"
        elif node["node_type"] == "videoNode":
            assert node["data"]["model"] == "seedance-2.0"
            assert node["data"]["aspectRatio"] == "16:9"
    # The media-specific ratio takes precedence over the universal one.
    plan["inputs"]["video_aspect_ratio"] = "9:16"
    for node in plan["nodes"]:
        node["data"].pop("model", None)
        node["data"].pop("aspectRatio", None)
    validated = catalog.validate_agent_workflow_plan(plan)
    video = next(n for n in validated["plan"]["nodes"] if n["node_type"] == "videoNode")
    assert video["data"]["aspectRatio"] == "9:16"


def test_exact_plan_validation_records_agent_authored_planner(monkeypatch):
    """Issue #678: a raw plan draft shows which path produced it, and why the
    standard planner was not used (the first deviation from its template)."""
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    plan = _raw_plan_from_standard(
        catalog, {"skill_id": "text-to-image-video", "user_goal": "Generate a cyber city text-to-image-to-video clip"}
    )
    for node in plan["nodes"]:
        if node["node_type"] == "videoNode":
            node["data"]["durationSec"] = 5

    validated = catalog.validate_agent_workflow_plan(plan)

    assert validated["ok"] is True
    assert validated["planner"] == {
        "mode": "agent_authored",
        "source": "exact_plan",
        "skill_id": "text-to-image-video",
        "selected_by": "agent",
        "standard_planner_available": True,
        "item_count": len(validated["plan"]["nodes"]),
        "template_match": {"isomorphic": False, "reason": "stage_order:clip_1->frame_2"},
    }
    assert "planner" not in validated["plan"]


def test_exact_plan_restating_the_template_is_compiled_by_the_standard_planner(monkeypatch):
    """Issue #678: a raw plan whose stages, order and dependencies are the Skill's
    standard template is the template; the server compiles it through the
    standard planner (production shape, compose, recommended models) and
    records the choice, carrying the agent's briefs as the planner units."""
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    plan = _raw_plan_from_standard(
        catalog,
        {"skill_id": "text-to-image-video", "user_goal": "Generate a cyber city text-to-image-to-video clip",
         "planner": {"mode": "standard", "item_count": 2}},
        deviate=False,
    )
    # The agent rewrote the briefs and dropped the compose node it did not think of.
    plan["nodes"] = [n for n in plan["nodes"] if n["node_type"] != "videoComposeNode"]
    plan["edges"] = [e for e in plan["edges"] if e["target"] != "final_compose"]
    briefs = {"1": "A push-in shot of a neon rainy-night street", "2": "A rooftop overlooking the whole city"}
    for node in plan["nodes"]:
        for suffix, brief in briefs.items():
            if node["id"] in {f"frame_{suffix}", f"clip_{suffix}"}:
                node["data"]["prompt"] = brief
                node["data"]["content"] = brief
        if node["id"] == "clip_1":
            node["data"]["durationSec"] = 4

    validated = catalog.validate_agent_workflow_plan(plan)

    assert validated["ok"] is True, validated
    planner = validated["planner"]
    assert planner["mode"] == "deterministic_standard"
    assert planner["selected_by"] == "template_isomorphic"
    assert planner["source"] == "exact_plan"
    assert planner["skill_id"] == "text-to-image-video"
    assert planner["deliverable"] == "video"
    assert planner["item_count"] == 2
    assert planner["template_match"] == {"isomorphic": True, "unit_count": 2}
    # The standard planner's own output, stamped as such on the plan.
    assert validated["plan"]["planner"]["mode"] == "deterministic_standard"
    nodes = {node["id"]: node for node in validated["plan"]["nodes"]}
    assert "final_compose" in nodes
    assert nodes["clip_1"]["data"]["prompt"] == "A push-in shot of a neon rainy-night street"
    assert nodes["frame_1"]["data"]["prompt"] == "A push-in shot of a neon rainy-night street"
    assert nodes["clip_1"]["data"]["durationSec"] == 4
    assert nodes["clip_2"]["data"]["prompt"] == "A rooftop overlooking the whole city"
    assert validated["preflight"]["blockers"] == []
    # The same fields every validated plan carries.
    assert set(validated) >= {"resolved_inputs", "execution_mode", "recommended_run_after_create"}
    assert validated["plan"]["summary"] == "Generate a cyber city text-to-image-to-video clip"


def test_short_drama_restatement_recovers_narration_and_audio(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    plan = _raw_plan_from_standard(
        catalog,
        {"skill_id": "short-drama-quick", "user_goal": "Stage duel",
         "planner": {"mode": "standard", "item_count": 2, "units": [
             {"title": "Opening", "prompt": "The two face off", "narration": "Only one of us walks out standing tonight."},
             {"title": "Twist", "prompt": "The lights suddenly dim", "narration": "He never expected the opponent to be his own shadow."},
         ]}},
        deviate=False,
    )
    validated = catalog.validate_agent_workflow_plan(plan)

    assert validated["ok"] is True, validated
    assert validated["planner"]["selected_by"] == "template_isomorphic"
    assert validated["planner"]["include_audio"] is True
    assert validated["planner"]["item_count"] == 2
    voices = {n["id"]: n["data"]["text"] for n in validated["plan"]["nodes"]
              if n["node_type"] == "audioNode" and n["data"].get("audioKind") == "speech"}
    assert voices == {"voice_1": "Only one of us walks out standing tonight.", "voice_2": "He never expected the opponent to be his own shadow."}
    assert any(n["node_type"] == "videoComposeNode" for n in validated["plan"]["nodes"])
    assert any(n["id"] == "background_music" for n in validated["plan"]["nodes"])


def test_template_restatement_that_the_standard_planner_rejects_stays_agent_authored(
    monkeypatch,
):
    """A stripped speech node stays agent-authored instead of being rewritten."""
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    plan = _raw_plan_from_standard(
        catalog,
        {"skill_id": "short-drama-quick", "user_goal": "Stage duel",
         "planner": {"mode": "standard", "item_count": 1, "units": [
             {"title": "Opening", "prompt": "The two face off", "narration": "Only one of us walks out standing tonight."},
         ]}},
        deviate=False,
    )
    for node in plan["nodes"]:
        if node["id"] == "voice_1":
            for key in ("text", "prompt", "content"):
                node["data"].pop(key, None)
            node["data"]["title"] = "Opening narration"

    validated = catalog.validate_agent_workflow_plan(plan)

    assert validated["ok"] is True, validated
    assert validated["planner"]["mode"] == "agent_authored"
    reason = validated["planner"]["template_match"]["reason"]
    assert reason == "not_expressible:node:voice_1"


def test_reroute_never_rewrites_what_the_plan_says(monkeypatch):
    """Review of #696: a structurally template-shaped plan is only rerouted
    when the standard planner reproduces it node for node. Otherwise the
    agent's plan stands and the record names the node or edge that differs."""
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    tutorial = {"skill_id": "text-to-image-video", "user_goal": "Cyber city",
                "planner": {"mode": "standard", "item_count": 2}}

    def validated_planner(plan):
        validated = catalog.validate_agent_workflow_plan(plan)
        assert validated["ok"] is True, validated
        return validated["planner"]

    # 1. Both clips read frame_1: rerouting would re-source clip_2 from frame_2.
    shared_frame = _raw_plan_from_standard(catalog, tutorial, deviate=False)
    shared_frame["edges"] = [
        {**e, "source": "frame_1"} if e["target"] == "clip_2" and e["source"] == "frame_2"
        else e
        for e in shared_frame["edges"]
    ]
    planner = validated_planner(shared_frame)
    assert planner["mode"] == "agent_authored"
    assert planner["template_match"]["reason"] == "not_expressible:edge:frame_1->clip_2"

    # 2. Frame and clip carry different briefs: one standard unit has one prompt.
    two_briefs = _raw_plan_from_standard(catalog, tutorial, deviate=False)
    for node in two_briefs["nodes"]:
        if node["id"] == "frame_1":
            node["data"]["prompt"] = node["data"]["content"] = "Draw only the building outlines"
    planner = validated_planner(two_briefs)
    assert planner["mode"] == "agent_authored"
    assert planner["template_match"]["reason"] == "not_expressible:node:frame_1"

    drama = {"skill_id": "short-drama-quick", "user_goal": "Stage duel",
    "inputs": {"visual_style": "unspecified"},
             "planner": {"mode": "standard", "item_count": 2, "units": [
                 {"title": "Opening", "prompt": "The two face off", "narration": "Only one of us walks out standing tonight."},
                 {"title": "Twist", "prompt": "The lights suddenly dim", "narration": "He never expected the opponent to be his own shadow."},
             ]}}
    # 3. Background music without voice-over: the planner cannot say music-only.
    music_only = _raw_plan_from_standard(catalog, drama, deviate=False)
    voice_ids = {n["id"] for n in music_only["nodes"] if n["id"].startswith("voice_")}
    music_only["nodes"] = [n for n in music_only["nodes"] if n["id"] not in voice_ids]
    music_only["edges"] = [
        e for e in music_only["edges"]
        if e["source"] not in voice_ids and e["target"] not in voice_ids
    ]
    planner = validated_planner(music_only)
    assert planner["mode"] == "agent_authored"
    assert planner["template_match"]["reason"] == "not_expressible:node:background_music"
    assert any(n["id"] == "background_music" for n in music_only["nodes"])

    # 4. Voice nodes listed in swapped order but attached to their own shot
    #    plans: narration follows the attachment, so the reroute keeps each
    #    line on the shot it belongs to.
    swapped = _raw_plan_from_standard(catalog, drama, deviate=False)
    order = [n["id"] for n in swapped["nodes"]]
    i, j = order.index("voice_1"), order.index("voice_2")
    swapped["nodes"][i], swapped["nodes"][j] = swapped["nodes"][j], swapped["nodes"][i]
    validated = catalog.validate_agent_workflow_plan(swapped)
    assert validated["ok"] is True, validated
    assert validated["planner"]["selected_by"] == "template_isomorphic"
    nodes = {n["id"]: n for n in validated["plan"]["nodes"]}
    fed_by = {
        e["target"]: e["source"] for e in validated["plan"]["edges"]
        if e["target"].startswith("voice_")
    }
    assert nodes[fed_by["voice_1"]]["data"]["prompt"] == "The two face off"
    assert nodes["voice_1"]["data"]["text"] == "Only one of us walks out standing tonight."
    assert nodes[fed_by["voice_2"]]["data"]["prompt"] == "The lights suddenly dim"
    assert nodes["voice_2"]["data"]["text"] == "He never expected the opponent to be his own shadow."


def test_reroute_maps_nodes_by_identity_and_keeps_execution_parameters(monkeypatch):
    """Second review of #696: identical-looking nodes are distinct identities
    (a frame both clips read cannot become two frames), and the recipe and
    every execution parameter a node carries must survive the round trip."""
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    def validated_planner(plan):
        validated = catalog.validate_agent_workflow_plan(plan)
        assert validated["ok"] is True, validated
        return validated["planner"]

    # 1. Two frames with the same brief and settings; both clips read frame_1.
    same_units = {"skill_id": "text-to-image-video", "user_goal": "Cyber city",
                  "planner": {"mode": "standard", "item_count": 2, "units": [
                      {"title": "Shot", "prompt": "Neon street"},
                      {"title": "Shot", "prompt": "Neon street"},
                  ]}}
    shared = _raw_plan_from_standard(catalog, same_units, deviate=False)
    frames = [n for n in shared["nodes"] if n["node_type"] == "imageGenNode"]
    assert catalog._node_signature(frames[0]) == catalog._node_signature(frames[1])
    shared["edges"] = [
        {**e, "source": "frame_1"} if e["source"] == "frame_2" and e["target"] == "clip_2"
        else e
        for e in shared["edges"]
    ]
    planner = validated_planner(shared)
    assert planner["mode"] == "agent_authored"
    assert planner["template_match"]["reason"].startswith("not_expressible:edge:frame_1->")
    # The untouched twin-unit plan still maps node for node and is rerouted.
    assert validated_planner(_raw_plan_from_standard(catalog, same_units, deviate=False))[
        "selected_by"
    ] == "template_isomorphic"

    # 2. The agent chose a different recipe for the frames.
    grid = _raw_plan_from_standard(
        catalog, {"skill_id": "text-to-image-video", "user_goal": "Cyber city",
                  "planner": {"mode": "standard", "item_count": 1}}, deviate=False,
    )
    for node in grid["nodes"]:
        if node["id"] == "frame_1":
            node["data"]["workflowCatalog"]["recipeId"] = "video-storyboard-grid"
    planner = validated_planner(grid)
    assert planner["mode"] == "agent_authored"
    assert planner["template_match"]["reason"] == "not_expressible:node:frame_1"

    # 3. A custom voice on the speech node.
    voiced = _raw_plan_from_standard(
        catalog, {"skill_id": "short-drama-quick", "user_goal": "Stage duel",
                  "planner": {"mode": "standard", "item_count": 1, "units": [
                      {"title": "Opening", "prompt": "The two face off", "narration": "Only one of us walks out standing tonight."},
                  ]}}, deviate=False,
    )
    for node in voiced["nodes"]:
        if node["id"] == "voice_1":
            node["data"].update({"speechMode": "user_custom", "voiceId": "v-42",
                                 "voiceAvailable": True})
    planner = validated_planner(voiced)
    assert planner["mode"] == "agent_authored"
    assert planner["template_match"]["reason"] == "not_expressible:node:voice_1"


def test_reroute_keeps_user_material_compose_order_and_stays_fast(monkeypatch):
    """Third review of #696: a compose input order or a user-provided note is
    part of the plan and must survive the round trip; a plan full of
    look-alike nodes must be judged in bounded time."""
    import time

    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    tutorial = {"skill_id": "text-to-image-video", "user_goal": "Cyber city",
                "planner": {"mode": "standard", "item_count": 2}}

    def validated_planner(plan):
        validated = catalog.validate_agent_workflow_plan(plan)
        assert validated["ok"] is True, validated
        return validated["planner"]

    # 1. The user ordered the final cut clip_2 first.
    reordered = _raw_plan_from_standard(catalog, tutorial, deviate=False)
    compose = next(n for n in reordered["nodes"] if n["node_type"] == "videoComposeNode")
    assert compose["data"]["compositionInputOrder"] == ["clip_1", "clip_2"]
    compose["data"]["compositionInputOrder"] = ["clip_2", "clip_1"]
    planner = validated_planner(reordered)
    assert planner["mode"] == "agent_authored"
    assert planner["template_match"]["reason"] == "not_expressible:compose_order:final_compose"
    # The planner's own order, or no compose node at all, still reroutes.
    assert validated_planner(_raw_plan_from_standard(catalog, tutorial, deviate=False))[
        "selected_by"
    ] == "template_isomorphic"

    # 2. A reference note the user supplied feeds the outline.
    noted = _raw_plan_from_standard(catalog, tutorial, deviate=False)
    noted["nodes"].append({
        "id": "reference_notes", "node_type": "textAnnotationNode", "stage": "resource",
        "data": {"title": "Reference", "content": "Neon leaning cool"},
    })
    noted["edges"].append(
        {"source": "reference_notes", "target": "outline", "link_type": "context_for"}
    )
    planner = validated_planner(noted)
    assert planner["mode"] == "agent_authored"
    assert planner["template_match"]["reason"] == "not_expressible:node:reference_notes"
    # The planner's own input node is user material too and maps onto itself.
    assert any(n.get("stage") == "input" for n in noted["nodes"])

    # 3. Ten look-alike units with one shared frame: rejected quickly, not by
    #    permuting every frame.
    lookalike = {"skill_id": "text-to-image-video", "user_goal": "Cyber city",
                 "planner": {"mode": "standard", "item_count": 10,
                             "units": [{"title": "Shot", "prompt": "Neon street"}] * 10}}
    crowded = _raw_plan_from_standard(catalog, lookalike, deviate=False)
    crowded["edges"] = [
        {**e, "source": "frame_1"} if e["source"] == "frame_2" and e["target"] == "clip_2"
        else e
        for e in crowded["edges"]
    ]
    started = time.monotonic()
    planner = validated_planner(crowded)
    elapsed = time.monotonic() - started
    assert planner["mode"] == "agent_authored"
    assert planner["template_match"]["reason"].startswith("not_expressible:edge:frame_1->")
    assert elapsed < 2.0, elapsed
    started = time.monotonic()
    assert validated_planner(_raw_plan_from_standard(catalog, lookalike, deviate=False))[
        "selected_by"
    ] == "template_isomorphic"
    assert time.monotonic() - started < 2.0


def test_reroute_keeps_workflow_catalog_execution_fields(monkeypatch):
    """Fourth review of #696: workflowCatalog carries fields the runtime prompt
    compiler reads (promptStrategy, inputStrategy, confirmedInputs, recipe
    version); a value the standard planner would not write blocks the reroute."""
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    tutorial = {"skill_id": "text-to-image-video", "user_goal": "Cyber city",
                "planner": {"mode": "standard", "item_count": 1}}

    def reason_for(node_id: str, **catalog_fields):
        plan = _raw_plan_from_standard(catalog, tutorial, deviate=False)
        node = next(n for n in plan["nodes"] if n["id"] == node_id)
        node["data"]["workflowCatalog"].update(catalog_fields)
        validated = catalog.validate_agent_workflow_plan(plan)
        assert validated["ok"] is True, validated
        assert validated["planner"]["mode"] == "agent_authored", validated["planner"]
        return validated["planner"]["template_match"]["reason"]

    assert reason_for("frame_1", promptStrategy="user_message") == "not_expressible:node:frame_1"
    assert reason_for("clip_1", inputStrategy={"upstream": "none"}) == (
        "not_expressible:node:clip_1"
    )
    assert reason_for("frame_1", confirmedInputs={"aspect_ratio": "9:16"}) == (
        "not_expressible:node:frame_1"
    )
    assert reason_for("clip_1", timelineRole="voiceover") == "not_expressible:node:clip_1"
    # The planner's own catalog bookkeeping (name, step id, prompt builder's
    # plan item) is derived and does not block: the untouched plan reroutes.
    untouched = _raw_plan_from_standard(catalog, tutorial, deviate=False)
    assert catalog.validate_agent_workflow_plan(untouched)["planner"]["selected_by"] == (
        "template_isomorphic"
    )


def test_reroute_carries_the_agent_nodes_over_verbatim(monkeypatch):
    """Fifth review of #696: a rerouted draft contains the agent's nodes as
    written (id and data), so a runtime-read field the comparison does not
    know about, such as promptBuilder.planItem.audio_kind, cannot be reset."""
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    drama = {"skill_id": "short-drama-quick", "user_goal": "Stage duel",
             "planner": {"mode": "standard", "item_count": 2, "units": [
                 {"title": "Opening", "prompt": "The two face off", "narration": "Only one of us walks out standing tonight."},
                 {"title": "Twist", "prompt": "The lights suddenly dim", "narration": "He never expected the opponent to be his own shadow."},
             ]}}
    plan = _raw_plan_from_standard(catalog, drama, deviate=False)
    voice = next(n for n in plan["nodes"] if n["id"] == "voice_1")
    voice["data"]["workflowCatalog"]["promptBuilder"]["planItem"]["audio_kind"] = "music"
    # Drop the compose node and layout: the planner adds them back.
    plan["nodes"] = [n for n in plan["nodes"] if n["node_type"] != "videoComposeNode"]
    plan["edges"] = [e for e in plan["edges"] if e["target"] != "final_compose"]
    before = {n["id"]: copy.deepcopy(n) for n in plan["nodes"]}

    validated = catalog.validate_agent_workflow_plan(plan)

    assert validated["ok"] is True, validated
    assert validated["planner"]["selected_by"] == "template_isomorphic"
    after = {n["id"]: n for n in validated["plan"]["nodes"]}
    assert after["voice_1"]["data"]["workflowCatalog"]["promptBuilder"]["planItem"][
        "audio_kind"
    ] == "music"
    assert after["voice_1"]["data"]["audioKind"] == "speech"
    for node_id, node in before.items():
        assert after[node_id]["data"] == node["data"], node_id
    # Only the planner's additions are new, wired to the agent's ids.
    assert set(after) - set(before) == {"final_compose"}
    compose_inputs = {
        e["source"] for e in validated["plan"]["edges"] if e["target"] == "final_compose"
    }
    assert compose_inputs >= {"clip_1", "clip_2"}
    order = after["final_compose"]["data"]["compositionInputOrder"]
    assert order[0] == "clip_1" and "clip_2" in order and set(order) <= set(after)
    group_ids = {i for g in validated["plan"]["layout"]["groups"] for i in g["node_ids"]}
    assert group_ids <= set(after)
    assert validated["preflight"]["blockers"] == []


def test_reroute_keeps_the_agent_link_types(monkeypatch):
    """Sixth review of #696: derived_from and media_input_for mean different
    things on the canvas; a rerouted draft keeps the agent's edges as written
    and only adds the planner's edges to the nodes the planner added."""
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    tutorial = {"skill_id": "text-to-image-video", "user_goal": "Cyber city",
                "planner": {"mode": "standard", "item_count": 2}}
    plan = _raw_plan_from_standard(catalog, tutorial, deviate=False)
    plan["nodes"] = [n for n in plan["nodes"] if n["node_type"] != "videoComposeNode"]
    plan["edges"] = [e for e in plan["edges"] if e["target"] != "final_compose"]
    for edge in plan["edges"]:
        if (edge["source"], edge["target"]) == ("frame_1", "clip_1"):
            edge["link_type"] = "derived_from"
    agent_edges = {(e["source"], e["target"], e["link_type"]) for e in plan["edges"]}

    validated = catalog.validate_agent_workflow_plan(plan)

    assert validated["ok"] is True, validated
    assert validated["planner"]["selected_by"] == "template_isomorphic"
    result_edges = {(e["source"], e["target"], e["link_type"]) for e in validated["plan"]["edges"]}
    assert agent_edges <= result_edges
    assert ("frame_1", "clip_1", "derived_from") in result_edges
    assert ("frame_1", "clip_1", "media_input_for") not in result_edges
    added = result_edges - agent_edges
    assert added and all("final_compose" in (s, t) for s, t, _ in added)
    assert added == {("clip_1", "final_compose", "composition_input_for"),
                     ("clip_2", "final_compose", "composition_input_for")}


def test_reroute_carries_agent_ids_and_wiring_for_renamed_nodes(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    tutorial = {"skill_id": "text-to-image-video", "user_goal": "Cyber city",
                "planner": {"mode": "standard", "item_count": 2}}
    plan = _raw_plan_from_standard(catalog, tutorial, deviate=False)
    renames = {"frame_1": "shot_a_frame", "clip_1": "shot_a_clip"}
    for node in plan["nodes"]:
        node["id"] = renames.get(node["id"], node["id"])
        step = node["data"].get("workflowCatalog", {})
        if "stepId" in step:
            step["stepId"] = renames.get(step["stepId"], step["stepId"])
    for edge in plan["edges"]:
        edge["source"] = renames.get(edge["source"], edge["source"])
        edge["target"] = renames.get(edge["target"], edge["target"])
    compose = next(n for n in plan["nodes"] if n["node_type"] == "videoComposeNode")
    compose["data"]["compositionInputOrder"] = ["shot_a_clip", "clip_2"]

    validated = catalog.validate_agent_workflow_plan(plan)

    assert validated["ok"] is True, validated
    assert validated["planner"]["selected_by"] == "template_isomorphic"
    ids = {n["id"] for n in validated["plan"]["nodes"]}
    assert {"shot_a_frame", "shot_a_clip", "clip_2"} <= ids and "frame_1" not in ids
    edges = {(e["source"], e["target"]) for e in validated["plan"]["edges"]}
    assert ("shot_a_frame", "shot_a_clip") in edges
    assert ("shot_a_clip", "final_compose") in edges
    compose = next(n for n in validated["plan"]["nodes"] if n["node_type"] == "videoComposeNode")
    assert compose["data"]["compositionInputOrder"] == ["shot_a_clip", "clip_2"]


def test_reroute_keeps_plan_summary_and_assumptions(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    tutorial = {"skill_id": "text-to-image-video", "user_goal": "Cyber city",
                "planner": {"mode": "standard", "item_count": 1}}
    # A summary the agent wrote as the draft title is not the planner's to rename.
    retitled = _raw_plan_from_standard(catalog, tutorial, deviate=False)
    assert retitled["summary"] == "Cyber city"
    retitled["summary"] = "Cyber city three-shot sample"
    validated = catalog.validate_agent_workflow_plan(retitled)
    assert validated["planner"]["mode"] == "agent_authored"
    # The summary is also where a raw plan states its goal, so the planner's
    # input node (which repeats the goal) differs first; either way, no reroute.
    assert validated["planner"]["template_match"]["reason"] in {
        "not_expressible:summary", "not_expressible:node:workflow_input",
    }
    # With the summary matching the goal the plan reroutes and keeps its title.
    titled = _raw_plan_from_standard(catalog, tutorial, deviate=False)
    validated = catalog.validate_agent_workflow_plan(titled)
    assert validated["planner"]["selected_by"] == "template_isomorphic"
    assert validated["plan"]["summary"] == "Cyber city"
    # Plan assumptions ride along into the standard compilation.
    assumed = _raw_plan_from_standard(catalog, tutorial, deviate=False)
    assumed["assumptions"] = ["Mainly night scenes", "No dialogue"]
    validated = catalog.validate_agent_workflow_plan(assumed)
    assert validated["planner"]["selected_by"] == "template_isomorphic"
    assert validated["plan"]["assumptions"] == ["Mainly night scenes", "No dialogue"]


def test_plan_node_matching_gives_up_within_budget():
    catalog = _load_catalog_module()
    sig = ("imageGenNode", "x", ("general-image", ()), ())
    # Twelve isolated look-alike frames on each side: every permutation is a
    # valid mapping, so the search succeeds at once ...
    frames = {f"f{i}": sig for i in range(12)}
    assert catalog._match_plan_nodes((frames, {}), (dict(frames), {})) is not None
    # ... while a wiring with identical degrees but no mapping (one 24-cycle
    # against twelve 2-cycles) is cut off by the budget instead of permuting.
    csig = ("videoNode", "x", ("general-video", ()), ())
    agent_nodes = {**frames, **{f"c{i}": csig for i in range(12)}}
    standard_edges = {}
    agent_edges = {}
    for i in range(12):
        standard_edges[(f"f{i}", f"c{i}", "consume")] = 1
        standard_edges[(f"c{i}", f"f{i}", "order")] = 1
        agent_edges[(f"f{i}", f"c{i}", "consume")] = 1
        agent_edges[(f"c{i}", f"f{(i + 1) % 12}", "order")] = 1
    with pytest.raises(catalog._MappingBudgetExceeded):
        catalog._match_plan_nodes(
            (agent_nodes, agent_edges), (dict(agent_nodes), standard_edges), budget=50
        )
    assert catalog._match_plan_nodes(
        (agent_nodes, agent_edges), (dict(agent_nodes), standard_edges), budget=100000
    ) is None


def test_intent_items_with_a_custom_recipe_stay_agent_authored(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    result = catalog.compile_workflow_intent({
        "skill_id": "text-to-image-video",
        "user_goal": "Cyber city",
        "planner": {"mode": "standard"},
        "items": [
            {"id": "outline", "title": "Outline", "prompt": "Cyber city",
             "recipe_id": "video-creative-outline"},
            {"id": "frame_1", "title": "Storyboard cell", "prompt": "Neon street",
             "recipe_id": "video-storyboard-grid", "depends_on": ["outline"],
             "reference_inputs": ["outline"]},
            {"id": "clip_1", "title": "Shot", "prompt": "Neon street",
             "recipe_id": "general-video", "depends_on": ["frame_1"], "duration_seconds": 5},
        ],
    })
    assert result["ok"] is True, result
    assert result["planner"]["mode"] == "agent_authored"
    assert result["planner"]["template_match"]["reason"] == "not_expressible:node:frame_1"
    frame = next(n for n in result["plan"]["nodes"] if n["id"] == "frame_1")
    assert frame["data"]["workflowCatalog"]["recipeId"] == "video-storyboard-grid"


def test_plan_node_matching_is_by_identity():
    catalog = _load_catalog_module()
    sig = ("imageGenNode", "x", ("general-image", ()), ())
    csig = ("videoNode", "x", ("general-video", ()), ())
    standard = ({"f1": sig, "f2": sig, "c1": csig, "c2": csig},
                {("f1", "c1", "consume"): 1, ("f2", "c2", "consume"): 1})
    fan_out = ({"a": sig, "b": sig, "p": csig, "q": csig},
               {("a", "p", "consume"): 1, ("a", "q", "consume"): 1})
    assert catalog._match_plan_nodes(fan_out, standard) is None
    swapped = ({"b": sig, "a": sig, "q": csig, "p": csig},
               {("b", "q", "consume"): 1, ("a", "p", "consume"): 1})
    mapping = catalog._match_plan_nodes(swapped, standard)
    assert mapping is not None
    assert {mapping["b"], mapping["a"]} == {"f1", "f2"}
    assert mapping[mapping_key := "q"] in {"c1", "c2"} and mapping_key


def test_narrations_follow_their_attachment_not_list_order():
    catalog = _load_catalog_module()
    units = [{"id": "clip_1"}, {"id": "clip_2"}]
    speech = [
        {"id": "v_b", "data": {"text": "second"}},
        {"id": "v_a", "data": {"text": "first"}},
        {"id": "v_free", "data": {"text": "loose"}},
    ]
    edges = [
        {"source": "shot_1", "target": "clip_1", "link_type": "prompt_for"},
        {"source": "shot_2", "target": "clip_2", "link_type": "prompt_for"},
        {"source": "shot_1", "target": "v_a", "link_type": "prompt_for"},
        {"source": "shot_2", "target": "v_b", "link_type": "prompt_for"},
    ]
    assert catalog._narrations_by_unit(units, speech, edges) == ["first", "second"]
    # Attached through the clip itself works too; unattached ones fill gaps in order.
    edges = [{"source": "clip_2", "target": "v_a", "link_type": "prompt_for"}]
    assert catalog._narrations_by_unit(units, speech, edges) == ["second", "first"]
    # An order-only edge is still an attachment (the planner gates a voice-over
    # behind its shot plan with dependency_for).
    edges = [{"source": "clip_2", "target": "v_a", "link_type": "dependency_for"}]
    assert catalog._narrations_by_unit(units, speech, edges) == ["second", "first"]
    # Nothing attached: list order.
    assert catalog._narrations_by_unit(units, speech, []) == ["second", "first"]


def test_template_isomorphism_reports_the_first_deviation(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    intent = {"skill_id": "short-drama-quick", "user_goal": "Stage duel",
              "planner": {"mode": "standard", "item_count": 1, "include_audio": False}}
    plan = _raw_plan_from_standard(catalog, intent, deviate=False)
    assert catalog.template_isomorphism("short-drama-quick", plan)["isomorphic"] is True
    assert catalog.template_isomorphism("not-a-template-skill", plan) == {
        "isomorphic": False, "reason": "no_standard_planner",
    }
    # A node of a kind the template has no stage for.
    outside = copy.deepcopy(plan)
    outside["nodes"].append({
        "id": "extra_html", "node_type": "htmlArtifactNode",
        "data": {"prompt": "Extra page", "workflowCatalog": {"recipeId": "html"}},
    })
    assert catalog.template_isomorphism("short-drama-quick", outside)["reason"] == (
        "node_outside_template:extra_html"
    )
    # A required stage missing, or present but bypassed.
    missing = _short_drama_plan_without_shot_planning(catalog)
    assert catalog.template_isomorphism("short-drama-quick", missing)["reason"] == (
        "stage_missing:shots"
    )
    bypassed = copy.deepcopy(plan)
    bypassed["edges"] = [
        {**e, "link_type": "dependency_for"} if e["source"] == "shot_plan_1" else e
        for e in bypassed["edges"]
    ]
    assert catalog.template_isomorphism("short-drama-quick", bypassed)["reason"] == (
        "stage_unused:shots->frames"
    )
    # External inputs are never a template restatement.
    external = copy.deepcopy(plan)
    external["external_inputs"] = [{"id": "ref", "node_id": "workflow_input", "media_kind": "image"}]
    assert catalog.template_isomorphism("short-drama-quick", external)["reason"] == (
        "external_inputs"
    )


def test_agent_authored_plan_without_preferences_is_left_untouched(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    plan = _raw_plan_from_standard(
        catalog, {"skill_id": "text-to-image-video", "user_goal": "Generate a cyber city text-to-image-to-video clip"}
    )
    before = copy.deepcopy(plan["nodes"])

    validated = catalog.validate_agent_workflow_plan(plan)

    assert validated["ok"] is True
    assert "backfilled_runtime_fields" not in validated
    assert validated["plan"]["nodes"] == before


def test_plan_preflight_warns_about_duration_written_under_ignored_keys():
    """Issue #677: a duration the compiler never reads leaves the planned
    duration at 0; the plan preflight now says which key was ignored."""
    from novelvideo.freezone.workflow_plan import _build_plan_preflight

    preflight = _build_plan_preflight([
        {"id": "shot", "node_type": "videoNode",
         "data": {"model": "video-model", "duration_seconds": 5}},
        {"id": "ok", "node_type": "videoNode",
         "data": {"model": "video-model", "durationSec": 4, "duration": 9}},
    ])
    assert preflight["planned_video_duration_seconds"] == 4
    assert [w["path"] for w in preflight["warnings"]] == ["nodes[0].data.duration_seconds"]
    assert "durationSec" in preflight["warnings"][0]["message"]


def test_standard_skill_planner_uses_defaults_for_minimal_intent(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    result = catalog.compile_workflow_intent(
        {
            "skill_id": "text-to-image-video",
            "user_goal": "Generate a cyber city text-to-image-to-video clip",
        }
    )

    assert result["ok"] is True
    assert result["planner"]["mode"] == "deterministic_standard"
    assert result["planner"]["item_count"] == 3
    assert result["planner"]["include_audio"] is False


def test_standard_audio_planner_rejects_placeholder_narration(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    result = catalog.compile_workflow_intent(
        {
            "skill_id": "short-drama-quick",
            "user_goal": "Make a short drama",
            "inputs": {"visual_style": "unspecified"},
            "include_audio": True,
            "planner": {
                "mode": "standard",
                "item_count": 1,
                "include_audio": True,
                "units": [
                    {
                        "title": "Opening",
                        "prompt": "Establish the story scene",
                        "narration": "This is the narration for the first segment of the short drama.",
                    }
                ],
            },
        }
    )
    assert result["ok"] is False
    assert result["errors"][0]["path"] == "planner.units.0.narration"
    assert "narration" in result["errors"][0]["hint"]
    assert "do NOT" in result["agent_instruction"]
    assert "placeholder" in result["errors"][0]["message"]


def test_short_drama_standard_planner_defers_missing_narration_to_shot_output(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    result = catalog.compile_workflow_intent(
        {
            "skill_id": "short-drama-quick",
            "inputs": {"visual_style": "unspecified"},
            "user_goal": "Make a short drama: first generate the script and storyboard, then the shot-by-shot voiceover",
            "include_audio": True,
            "planner": {
                "mode": "standard",
                "item_count": 1,
                "include_audio": True,
                "units": [{"title": "Opening", "prompt": "Establish the story scene"}],
            },
        }
    )

    assert result["ok"] is True, result
    nodes = {node["id"]: node for node in result["plan"]["nodes"]}
    assert "voice_1" in nodes
    assert "text" not in nodes["voice_1"]["data"]
    assert nodes["voice_1"]["data"]["workflowCatalog"]["recipeId"] == (
        "drama-shot-voice"
    )
    assert {
        (edge["source"], edge["target"], edge["link_type"])
        for edge in result["plan"]["edges"]
    } >= {("shot_plan_1", "voice_1", "prompt_for")}


def test_video_tutorial_standard_outline_consumes_unit_facts(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    result = catalog.compile_workflow_intent({
        "skill_id": "video-tutorial",
        "user_goal": "Prepare a three-step pour-over tutorial Draft.",
        "planner": {
            "mode": "standard",
            "item_count": 2,
            "include_audio": True,
            "units": [
                {
                    "title": "Prepare the filter",
                    "prompt": "Use 15 g of coffee and a transparent V60 filter.",
                    "narration": "First put in fifteen grams of coffee.",
                    "duration_seconds": 6,
                },
                {
                    "title": "Bloom",
                    "prompt": "Pour in 30 g of 92 degrees Celsius water and wait 30 seconds.",
                    "narration": "Pour in thirty grams of hot water and wait thirty seconds.",
                    "duration_seconds": 6,
                },
            ],
        },
    })

    assert result["ok"] is True, result
    outline = next(node for node in result["plan"]["nodes"] if node["id"] == "outline")
    prompt = outline["data"]["prompt"]
    assert "15 g" in prompt
    assert "92 degrees Celsius" in prompt
    assert "30 g" in prompt
    assert "30 seconds" in prompt
    assert "fifteen grams of coffee" in prompt


def test_non_screenplay_planner_still_requires_literal_narration(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    result = catalog.compile_workflow_intent(
        {
            "skill_id": "video-tutorial",
            "user_goal": "Make a tutorial",
            "include_audio": True,
            "planner": {
                "mode": "standard",
                "item_count": 1,
                "include_audio": True,
                "units": [{"title": "First step", "prompt": "Show the first step"}],
            },
        }
    )

    assert result["ok"] is False
    assert result["errors"][0]["path"] == "planner.units.0.narration"


def test_standard_planner_rejects_conflicting_audio_policy(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    result = catalog.compile_workflow_intent(
        {
            "skill_id": "short-drama-quick",
            "inputs": {"visual_style": "unspecified"},
            "user_goal": "Make a short drama",
            "include_audio": True,
            "planner": {"mode": "standard", "include_audio": False},
        }
    )

    assert result["ok"] is False
    assert result["errors"][0]["path"] == "planner.include_audio"
    assert "conflicts" in result["error"]


def test_custom_items_take_precedence_over_standard_planner(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    result = catalog.compile_workflow_intent(
        {
            "skill_id": "ecommerce-ad",
            "user_goal": "Generate only one custom product image",
            "planner": {"mode": "standard", "item_count": 6},
            "include_compose": False,
            "items": [
                {
                    "id": "custom_image",
                    "title": "Custom product image",
                    "prompt": "A product on a minimal background",
                    "recipe_id": "general-image",
                }
            ],
        }
    )

    assert result["ok"] is True
    # Issue #678: the agent-authored choice is recorded, including that a
    # standard planner existed for this Skill, what mode the agent asked for,
    # and why the items were not the template.
    assert result["planner"] == {
        "mode": "agent_authored",
        "source": "intent_items",
        "skill_id": "ecommerce-ad",
        "selected_by": "agent",
        "standard_planner_available": True,
        "requested_mode": "standard",
        "item_count": 1,
        "template_match": {"isomorphic": False, "reason": "stage_missing:planning"},
    }
    assert "planner" not in result["plan"]
    node_ids = {node["id"] for node in result["plan"]["nodes"]}
    assert node_ids == {"workflow_input", "custom_image"}


def test_intent_items_restating_the_template_use_the_standard_planner(monkeypatch):
    """Issue #678: the user named the standard planner and the agent still
    wrote items that restate the template; the server compiles them through
    the standard planner and records the requested mode."""
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    intent = {
        "skill_id": "video-tutorial",
        "user_goal": "Three steps to pour-over coffee",
        "planner": {"mode": "standard"},
        "inputs": {"video_duration_seconds": 5},
        "items": [
            {"id": "outline", "title": "Tutorial outline", "prompt": "Three steps to pour-over coffee",
             "recipe_id": "general-text"},
            {"id": "frame_1", "title": "Step one picture", "prompt": "A close-up of grinding coffee beans",
             "recipe_id": "general-image", "depends_on": ["outline"],
             "reference_inputs": ["outline"]},
            {"id": "clip_1", "title": "Step one video", "prompt": "A close-up of grinding coffee beans",
             "recipe_id": "general-video", "depends_on": ["frame_1"],
             "model": "recommended",
             "timeline_role": "visual"},
            {"id": "frame_2", "title": "Step two picture", "prompt": "A slow-motion shot of pouring and blooming",
             "recipe_id": "general-image", "depends_on": ["outline"],
             "reference_inputs": ["outline"]},
            {"id": "clip_2", "title": "Step two video", "prompt": "A slow-motion shot of pouring and blooming",
             "recipe_id": "general-video", "depends_on": ["frame_2"],
             "model": "recommended",
             "timeline_role": "visual"},
        ],
    }
    result = catalog.compile_workflow_intent(intent)

    assert result["ok"] is True, result
    planner = result["planner"]
    assert planner["mode"] == "deterministic_standard"
    assert planner["selected_by"] == "template_isomorphic"
    assert planner["source"] == "intent_items"
    assert planner["requested_mode"] == "standard"
    assert planner["item_count"] == 2
    assert planner["include_audio"] is False
    assert planner["template_match"] == {"isomorphic": True, "unit_count": 2}
    nodes = {node["id"]: node for node in result["plan"]["nodes"]}
    assert nodes["clip_2"]["data"]["prompt"] == "A slow-motion shot of pouring and blooming"
    assert nodes["clip_2"]["data"]["durationSec"] == 5
    assert "final_compose" in nodes
    assert result["preflight"]["blockers"] == []
    order_only = copy.deepcopy(intent)
    for item in order_only["items"]:
        if item["id"].startswith("frame_"):
            item.pop("reference_inputs")
    alternate = catalog.compile_workflow_intent(order_only)
    assert alternate["planner"]["mode"] == "agent_authored"
    assert alternate["planner"]["template_match"]["reason"] == (
        "stage_unused:planning->images"
    )


def test_intent_items_the_standard_planner_cannot_reproduce_stay_agent_authored(
    monkeypatch,
):
    """A frame brief that differs from its clip brief cannot be expressed as one
    standard unit; rerouting would overwrite it, so the items stand."""
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    result = catalog.compile_workflow_intent({
        "skill_id": "video-tutorial",
        "user_goal": "Three steps to pour-over coffee",
        "planner": {"mode": "standard"},
        "items": [
            {"id": "outline", "title": "Tutorial outline", "prompt": "Three steps to pour-over coffee",
             "recipe_id": "general-text"},
            {"id": "frame_1", "title": "Step one picture", "prompt": "Grind coffee beans",
             "recipe_id": "general-image", "depends_on": ["outline"],
             "reference_inputs": ["outline"]},
            {"id": "clip_1", "title": "Step one video", "prompt": "A close-up of grinding coffee beans",
             "recipe_id": "general-video", "depends_on": ["frame_1"],
             "duration_seconds": 5},
        ],
    })

    assert result["ok"] is True, result
    assert result["planner"]["mode"] == "agent_authored"
    assert result["planner"]["requested_mode"] == "standard"
    assert result["planner"]["template_match"]["reason"] == "not_expressible:node:frame_1"
    assert {n["id"] for n in result["plan"]["nodes"]} >= {"outline", "frame_1", "clip_1"}


_STAGE_LOCK_UNITS = [
    {"title": "Opening", "prompt": "Quickly establish the theme", "narration": "First, the core content."},
    {"title": "Ending", "prompt": "Wrap up the information", "narration": "That is everything."},
]


def test_standard_skill_stage_templates_are_locked_to_the_planner_output(monkeypatch):
    """Issue #677: ``stages`` on each deterministic profile is the machine-comparable
    shape of what the standard planner emits. Every planner output must map onto
    it, and ``required`` must mean "emitted for every deliverable / audio choice"."""
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    for skill_id, profile in catalog._DETERMINISTIC_SKILL_PLANNERS.items():
        stages = {stage["id"]: stage for stage in profile["stages"]}
        assert stages, skill_id
        seen_in_every_run = set(stages)
        seen_in_any_run: set[str] = set()
        for deliverable in profile["deliverables"]:
            for include_audio in (True, False):
                result = catalog.compile_workflow_intent({
                    "skill_id": skill_id,
                    "user_goal": "Generate a two-part vertical test video",
                    **({"inputs": {"visual_style": "unspecified"}}
                       if skill_id == "short-drama-quick" else {}),
                    "planner": {
                        "mode": "standard",
                        "item_count": 2,
                        "deliverable": deliverable,
                        "include_audio": include_audio,
                        "units": _STAGE_LOCK_UNITS,
                    },
                })
                assert result["ok"] is True, (skill_id, deliverable, include_audio, result)
                # The planner's own output never trips the stage check.
                assert result["preflight"]["blockers"] == [], (skill_id, deliverable)
                labels: set[str] = set()
                ids_by_label: dict[str, set[str]] = {}
                for node in result["plan"]["nodes"]:
                    label = node.get("stage") or node.get("data", {}).get("stage")
                    if label in {"input", "compose"}:
                        continue
                    assert label in stages, (skill_id, node["id"], label)
                    stage = stages[label]
                    assert node["node_type"] == stage["node_type"], (skill_id, node["id"])
                    recipe_id = node["data"]["workflowCatalog"]["recipeId"]
                    assert recipe_id in stage["recipes"], (skill_id, node["id"], recipe_id)
                    labels.add(label)
                    ids_by_label.setdefault(label, set()).add(node["id"])
                seen_in_every_run &= labels
                seen_in_any_run |= labels
                # Every declared feeding pair holds in the planner's own graph
                # over consuming edges (dependency_for does not count).
                for upstream, downstream in profile["edges"]:
                    assert upstream in stages and downstream in stages, (skill_id, upstream)
                    if downstream not in ids_by_label:
                        continue
                    reached = catalog._downstream_node_ids(
                        ids_by_label[upstream], result["plan"]["edges"]
                    )
                    assert ids_by_label[downstream] <= reached, (skill_id, upstream, downstream)
                if skill_id == "short-drama-quick":
                    # The clip consumes its shot plan: prompt_for, not an order gate.
                    shot_to_clip = {
                        edge["link_type"]
                        for edge in result["plan"]["edges"]
                        if edge["source"].startswith("shot_plan_")
                        and edge["target"].startswith("clip_")
                    }
                    assert shot_to_clip == {"prompt_for"}, shot_to_clip
        assert seen_in_any_run == set(stages), (skill_id, seen_in_any_run)
        assert {s for s, stage in stages.items() if stage["required"]} == seen_in_every_run, (
            skill_id
        )
        assert profile["edges"], skill_id
        # The template is what the agent sees in the planning contract.
        package = catalog.get_workflow_skill({"skill_id": skill_id, "user_goal": "test"})
        assert package["planning_contract"]["standard_planner"]["stages"] == profile["stages"]
        assert package["planning_contract"]["standard_planner"]["edges"] == profile["edges"]


def _short_drama_plan_without_shot_planning(catalog) -> dict:
    compiled = catalog.compile_workflow_intent({
        "skill_id": "short-drama-quick",
        "user_goal": "Stage duel",
        "inputs": {"visual_style": "unspecified"},
        "planner": {"mode": "standard", "item_count": 2, "include_audio": False},
    })
    assert compiled["ok"] is True, compiled
    plan = copy.deepcopy(compiled["plan"])
    plan.pop("planner", None)
    plan.pop("layout", None)
    shot_ids = {node["id"] for node in plan["nodes"] if node.get("stage") == "shots"}
    assert shot_ids
    plan["nodes"] = [node for node in plan["nodes"] if node["id"] not in shot_ids]
    # Feed the clips straight from the outline, as the agent-authored draft did.
    plan["edges"] = [
        {**edge, "source": "outline"} if edge["source"] in shot_ids else edge
        for edge in plan["edges"]
        if edge["target"] not in shot_ids
    ]
    return plan


def test_exact_plan_without_a_required_stage_is_a_preflight_blocker(monkeypatch):
    """Issue #677 (Stage duel): a raw plan that skips the Skill's shot-planning stage
    validates but its preflight is blocked instead of ready."""
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    plan = _short_drama_plan_without_shot_planning(catalog)

    validated = catalog.validate_agent_workflow_plan(plan)

    assert validated["ok"] is True, validated
    assert validated["planner"]["mode"] == "agent_authored"
    preflight = validated["preflight"]
    assert preflight["status"] == "blocked"
    assert [b["code"] for b in preflight["blockers"]] == ["skill_stage_missing"]
    blocker = preflight["blockers"][0]
    assert blocker["path"] == "plan.stages.shots"
    assert blocker["stage"] == "shots"
    assert blocker["node_type"] == "textAnnotationNode"
    assert "drama-shot-group-detail" in blocker["recipes"]
    assert "shots stage" in blocker["message"]
    assert "planner.mode=standard" in blocker["hint"]
    # The ordinary plan preflight fields survive beside the blocker.
    assert preflight["counts"]["video"] == 2
    assert "warnings" in preflight

    def with_shot_design(node: dict, *, feeds_clips: bool, link_type: str = "prompt_for") -> dict:
        """Add a shot-planning node under the outline; optionally connect the
        first frames to it with ``link_type`` (the standard planner uses prompt_for)."""
        revised = copy.deepcopy(plan)
        revised["nodes"].append({**node, "id": "shot_design", "prompt": "Break down every shot"})
        revised["edges"].append(
            {"source": "outline", "target": "shot_design", "link_type": "context_for"}
        )
        if feeds_clips:
            revised["edges"] = [
                {**edge, "source": "shot_design", "link_type": link_type}
                if edge["source"] == "outline" and edge["target"].startswith("frame_")
                else edge
                for edge in revised["edges"]
            ]
        return revised

    labelled = {"node_type": "textAnnotationNode", "stage": "shots",
                "data": {"workflowCatalog": {"recipeId": "general-text"}}}
    by_recipe = {"node_type": "textAnnotationNode",
                 "data": {"workflowCatalog": {"recipeId": "drama-shot-planning"}}}
    # A shot-planning node that feeds the first frames clears it: by stage label or
    # by a recipe of the stage's family without any label.
    for node in (labelled, by_recipe):
        validated = catalog.validate_agent_workflow_plan(with_shot_design(node, feeds_clips=True))
        assert validated["preflight"]["blockers"] == [], validated["preflight"]
    # A shot-planning node on a side branch, with the frames still reading the
    # outline directly, is not a shot-planning stage: the draft stays blocked.
    validated = catalog.validate_agent_workflow_plan(with_shot_design(labelled, feeds_clips=False))
    assert validated["ok"] is True
    (unused,) = validated["preflight"]["blockers"]
    assert unused["code"] == "skill_stage_unused"
    assert unused["path"] == "plan.stages.shots.feeds.frames"
    assert unused["stage"] == "shots"
    assert unused["downstream_stage"] == "frames"
    assert unused["node_ids"] == ["frame_1", "frame_2"]
    assert "shot_design" in unused["message"]
    assert validated["preflight"]["status"] == "blocked"
    # Feeding one frame is not enough: the other is still bypassed.
    partial = with_shot_design(labelled, feeds_clips=False)
    partial["edges"] = [
        {**edge, "source": "shot_design", "link_type": "prompt_for"}
        if edge["source"] == "outline" and edge["target"] == "frame_1"
        else edge
        for edge in partial["edges"]
    ]
    (unused,) = catalog.validate_agent_workflow_plan(partial)["preflight"]["blockers"]
    assert unused["node_ids"] == ["frame_2"]
    # An order-only edge does not make the frames consume the shot plan: wiring
    # shot_design → frame with dependency_for keeps the draft blocked.
    gated = with_shot_design(labelled, feeds_clips=True, link_type="dependency_for")
    (unused,) = catalog.validate_agent_workflow_plan(gated)["preflight"]["blockers"]
    assert unused["code"] == "skill_stage_unused"
    assert unused["node_ids"] == ["frame_1", "frame_2"]
    assert "dependency_for" in unused["message"]


def test_video_tutorial_outline_must_feed_every_step_image():
    """A ready tutorial must consume the generated outline, not just wait for it."""
    catalog = _load_catalog_module()
    nodes = [
        {"id": "outline", "node_type": "textAnnotationNode", "stage": "planning",
         "data": {"workflowCatalog": {"recipeId": "general-text"}}},
        {"id": "frame_1", "node_type": "imageGenNode", "stage": "images",
         "data": {"workflowCatalog": {"recipeId": "general-image"}}},
        {"id": "frame_2", "node_type": "imageGenNode", "stage": "images",
         "data": {"workflowCatalog": {"recipeId": "general-image"}}},
        {"id": "clip_1", "node_type": "videoNode", "stage": "video",
         "data": {"workflowCatalog": {"recipeId": "general-video"}}},
        {"id": "clip_2", "node_type": "videoNode", "stage": "video",
         "data": {"workflowCatalog": {"recipeId": "general-video"}}},
    ]
    edges = [
        {"source": "outline", "target": "frame_1", "link_type": "dependency_for"},
        {"source": "outline", "target": "frame_2", "link_type": "dependency_for"},
        {"source": "frame_1", "target": "clip_1", "link_type": "media_input_for"},
        {"source": "frame_2", "target": "clip_2", "link_type": "media_input_for"},
    ]
    blockers = catalog.skill_stage_blockers("video-tutorial", nodes, edges)
    assert [(item["code"], item["path"], item["node_ids"]) for item in blockers] == [
        ("skill_stage_unused", "plan.stages.planning.feeds.images", ["frame_1", "frame_2"]),
    ]

    edges[0] = {**edges[0], "link_type": "prompt_for"}
    blockers = catalog.skill_stage_blockers("video-tutorial", nodes, edges)
    assert blockers[0]["node_ids"] == ["frame_2"]

    edges[1] = {**edges[1], "link_type": "prompt_for"}
    assert catalog.skill_stage_blockers("video-tutorial", nodes, edges) == []


def test_agent_authored_tutorial_draft_blocks_order_only_outline(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    intent = {
        "skill_id": "video-tutorial",
        "user_goal": "Make a two-step operation tutorial",
        "items": [
            {"id": "outline", "title": "Tutorial copy", "prompt": "List two steps",
             "recipe_id": "general-text"},
            {"id": "frame", "title": "Step image", "prompt": "Show the first step",
             "recipe_id": "general-image", "depends_on": ["outline"]},
            {"id": "clip", "title": "Step video", "prompt": "Show the step image",
             "recipe_id": "general-video", "depends_on": ["frame"],
             "duration_seconds": 5},
        ],
    }
    blocked = catalog.compile_workflow_intent(intent)
    assert blocked["ok"] is True
    assert blocked["preflight"]["status"] == "blocked"
    assert [(item["code"], item["path"]) for item in blocked["preflight"]["blockers"]] == [
        ("skill_stage_unused", "plan.stages.planning.feeds.images"),
    ]

    intent["items"][1]["reference_inputs"] = ["outline"]
    ready = catalog.compile_workflow_intent(intent)
    assert ready["ok"] is True
    assert ready["preflight"]["status"] == "ready"
    assert ready["preflight"]["blockers"] == []


def test_intent_items_without_a_required_stage_are_a_preflight_blocker(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    result = catalog.compile_workflow_intent({
        "skill_id": "video-tutorial",
        "user_goal": "Three steps to brew coffee",
        "include_compose": False,
        "items": [
            {"id": "outline", "title": "Tutorial outline", "prompt": "List three steps",
             "recipe_id": "general-text"},
            {"id": "clip_1", "title": "Step one", "prompt": "Grind coffee beans",
             "recipe_id": "general-video", "depends_on": ["outline"],
             "duration_seconds": 5},
        ],
    })

    assert result["ok"] is True, result
    assert result["planner"]["mode"] == "agent_authored"
    assert result["preflight"]["status"] == "blocked"
    # The missing stage is reported once; its feeding pairs are not reported
    # on top (nothing to reach from or to).
    assert [(b["code"], b["stage"]) for b in result["preflight"]["blockers"]] == [
        ("skill_stage_missing", "images"),
    ]


def test_skill_stage_blockers_tolerance():
    """node_type + recipe family: a single stage of a kind accepts any executable
    node of that kind; a kind shared by two stages needs the label or a family
    recipe; user-material text nodes never count; skills without a standard
    planner are not checked."""
    catalog = _load_catalog_module()

    def node(node_id, node_type, recipe_id=None, stage=None):
        data = {"workflowCatalog": {"recipeId": recipe_id}} if recipe_id else {}
        return {"id": node_id, "node_type": node_type, "data": data,
                **({"stage": stage} if stage else {})}

    ok_plan = [
        node("brief", "textAnnotationNode", stage="input"),
        node("outline", "scriptNode", "video-creative-outline"),
        node("frame", "imageGenNode", "some-custom-image-recipe"),
        node("clip", "videoNode", "some-custom-video-recipe"),
    ]
    chain = [
        {"source": "brief", "target": "outline", "link_type": "context_for"},
        {"source": "outline", "target": "frame", "link_type": "prompt_for"},
        {"source": "frame", "target": "clip", "link_type": "media_input_for"},
    ]
    assert catalog.skill_stage_blockers("text-to-image-video", ok_plan, chain) == []
    planning_gate = chain[:1] + [
        {"source": "outline", "target": "frame", "link_type": "dependency_for"},
        chain[2],
    ]
    assert [
        (b["code"], b["stage"], b["downstream_stage"])
        for b in catalog.skill_stage_blockers("text-to-image-video", ok_plan, planning_gate)
    ] == [("skill_stage_unused", "planning", "images")]
    # A clip that only waits for the frame (dependency_for) does not consume it.
    gated = chain[:2] + [{"source": "frame", "target": "clip", "link_type": "dependency_for"}]
    assert [
        (b["code"], b["stage"], b["downstream_stage"], b["node_ids"])
        for b in catalog.skill_stage_blockers("text-to-image-video", ok_plan, gated)
    ] == [("skill_stage_unused", "images", "video", ["clip"])]
    # Reachability is transitive over consuming edges: frame → extra → clip.
    extra = ok_plan + [node("extra", "imageGenNode", "another-image-recipe")]
    via_extra = chain[:2] + [
        {"source": "frame", "target": "extra", "link_type": "media_input_for"},
        {"source": "extra", "target": "clip", "link_type": "media_input_for"},
    ]
    assert catalog.skill_stage_blockers("text-to-image-video", extra, via_extra) == []
    # Without edges, both required feeding pairs are unmet.
    assert [b["path"] for b in catalog.skill_stage_blockers("text-to-image-video", ok_plan)] == [
        "plan.stages.planning.feeds.images",
        "plan.stages.images.feeds.video",
    ]
    # Only user material of the text kind: the planning stage is still missing.
    codes = [
        b["stage"]
        for b in catalog.skill_stage_blockers(
            "text-to-image-video", ok_plan[:1] + ok_plan[2:], chain
        )
    ]
    assert codes == ["planning"]
    # A general-text node fills planning, not the distinct shots stage; an
    # explicit canonical stage label resolves that ambiguity.
    drama = [
        node("outline", "textAnnotationNode", "general-text"),
        node("more_text", "textAnnotationNode", "general-text"),
        node("clip", "videoNode", "general-video"),
    ]
    stages = {
        stage["id"]: stage
        for stage in catalog.standard_skill_stages("short-drama-quick")
    }
    assert catalog._node_fills_stage(
        drama[0], stages["planning"], kind_is_unique=False
    )
    assert not catalog._node_fills_stage(
        drama[1], stages["shots"], kind_is_unique=False
    )
    drama[1]["data"]["stage"] = "Shots"
    assert catalog._node_fills_stage(
        drama[1], stages["shots"], kind_is_unique=False
    )
    assert catalog.skill_stage_blockers("not-a-template-skill", []) == []
    assert catalog.standard_skill_stages("not-a-template-skill") == []
    assert catalog.standard_skill_stage_edges("not-a-template-skill") == []


def _dynamic_plan(*, image_count: int = 1) -> dict:
    nodes = [
        {
            "id": "brief",
            "node_type": "textAnnotationNode",
            "stage": "input",
            "data": {"displayName": "User request", "content": "Sneaker e-commerce images"},
        }
    ]
    edges = []
    for index in range(image_count):
        node_id = f"product_image_{index + 1}"
        nodes.append(
            {
                "id": node_id,
                "node_type": "imageGenNode",
                "stage": "image",
                "data": {
                    "displayName": f"Product image {index + 1}",
                    "referenceImageUrl": "/static/product.png",
                    "workflowCatalog": {
                        "skillId": "ecommerce-product",
                        "recipeId": "ecommerce-ad-image",
                        "recipeVersion": "5",
                    },
                },
            }
        )
        edges.append({"source": "brief", "target": node_id, "link_type": "prompt_for"})
    return {
        "schema_version": "freezone_workflow_plan.v1",
        "workflow_type": "dynamic.ecommerce-product",
        "skill": {"id": "ecommerce-product", "version": 6},
        "summary": f"{image_count} sneaker e-commerce images",
        "nodes": nodes,
        "edges": edges,
        "layout": {"direction": "left_to_right", "groups": []},
    }


def _use_parameterized_catalog(monkeypatch, catalog):
    def fake_list_user_agent_config_items(_username, kind):
        if kind == "skills":
            return [
                {
                    "id": "cinematic-short",
                    "triggers": {"node_scopes": ["textGeneration"]},
                    "allowed_recipe_ids": ["general-text"],
                    "input_parameters": [
                        {
                            "id": "duration",
                            "label": "Final cut duration",
                            "type": "single_select",
                            "required": True,
                            "default": "60",
                            "options": [
                                {"value": "60", "label": "60 seconds"},
                                {"value": "90", "label": "90 seconds"},
                            ],
                        },
                        {
                            "id": "execution_mode",
                            "label": "Execution mode",
                            "type": "single_select",
                            "required": True,
                            "default": "auto",
                            "options": [
                                {"value": "auto", "label": "Fully automatic"},
                                {"value": "manual", "label": "Canvas only"},
                            ],
                        },
                        {
                            "id": "aspect_ratio",
                            "label": "Aspect ratio",
                            "type": "single_select",
                            "required": False,
                            "default": "16:9",
                            "options": [
                                {"value": "16:9", "label": "16:9 landscape"},
                                {"value": "9:16", "label": "9:16 portrait"},
                            ],
                        },
                    ],
                    "planning": {"planning_notes": "Dynamically plan a cinematic short"},
                }
            ]
        if kind == "recipes":
            return [
                {
                    "id": "general-text",
                    "version": 1,
                    "output_kind": "text",
                    "system_prompt": "Generate text",
                }
            ]
        raise AssertionError(kind)

    monkeypatch.setattr(
        catalog, "list_user_agent_config_items", fake_list_user_agent_config_items
    )
    monkeypatch.setattr(catalog, "_catalog_username", lambda: "local")


def test_workflow_skill_package_supports_skill_without_template(monkeypatch):
    catalog = _load_catalog_module()

    def fake_list_user_agent_config_items(_username, kind):
        if kind == "skills":
            return [
                {
                    "id": "director-method",
                    "description": "A director method without a fixed template",
                    "triggers": {"node_scopes": ["imageGeneration"]},
                    "planning": {"planning_notes": "Dynamically plan shots from the user's request"},
                    "allowed_recipe_ids": ["director-frame"],
                }
            ]
        if kind == "recipes":
            return [
                {
                    "id": "director-frame",
                    "name": "Director keyframes",
                    "version": 2,
                    "output_kind": "image",
                    "planning_prompt": "Generate keyframes",
                    "result_summary": "Keyframe images",
                }
            ]
        raise AssertionError(kind)

    monkeypatch.setattr(
        catalog, "list_user_agent_config_items", fake_list_user_agent_config_items
    )
    monkeypatch.setattr(catalog, "_catalog_username", lambda: "local")

    package = catalog.get_workflow_skill(
        {"skill_id": "director-method", "user_goal": "Plan 8 shots"}
    )

    assert package["ok"] is True
    assert "workflow_templates" not in package["skill"]
    assert package["allowed_node_types"] == ["imageGenNode"]
    assert "director-frame" in {recipe["id"] for recipe in package["available_recipes"]}
    assert package["planning_contract"]["strict_validation"] is True


def test_dynamic_item_supports_ordered_recipe_pipeline(monkeypatch):
    catalog = _load_catalog_module()
    _install_minimal_builtin_catalog(monkeypatch, catalog)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "ecommerce-product",
            "user_goal": "First use the general composition, then generate the product image with the custom storyboard method",
            "items": [
                {
                    "id": "hero-shot",
                    "title": "Hero product shot",
                    "recipe_id": "general-image",
                    "recipe_pipeline": ["custom-shot-image", "general-image"],
                }
            ],
            "include_compose": False,
        }
    )

    assert compiled["ok"] is True
    workflow_catalog = compiled["plan"]["nodes"][1]["data"]["workflowCatalog"]
    assert workflow_catalog["recipeId"] == "general-image"
    assert workflow_catalog["recipeName"] == "General Image"
    assert workflow_catalog["recipePipeline"] == [
        {"id": "custom-shot-image", "name": "Custom Storyboard Image", "version": 1}
    ]


def test_compiler_propagates_portable_image_generation_inputs(monkeypatch):
    catalog = _load_catalog_module()
    _install_minimal_builtin_catalog(monkeypatch, catalog)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "ecommerce-product",
            "user_goal": "Generate the product main image",
            "inputs": {
                "image_model": "image-model",
                "image_aspect_ratio": "16:9",
                "image_resolution": "2K",
                "image_quality": "medium",
                "image_count": 7,
                "image_variants_per_node": 2,
            },
            "items": [
                {
                    "id": "hero",
                    "title": "Product main image",
                    "recipe_id": "general-image",
                }
            ],
            "include_compose": False,
        }
    )

    assert compiled["ok"] is True
    image = next(
        node
        for node in compiled["plan"]["nodes"]
        if node["node_type"] == "imageGenNode"
    )
    assert {
        key: image["data"].get(key)
        for key in ("model", "aspectRatio", "size", "quality", "count")
    } == {
        "model": "image-model",
        "aspectRatio": "16:9",
        "size": "2K",
        "quality": "medium",
        "count": 2,
    }


@pytest.mark.parametrize(
    ("parameter_id", "value"),
    [
        ("image_resolution", "3K"),
        ("image_aspect_ratio", "1:8"),
        ("video_resolution", "2K"),
        ("video_aspect_ratio", "9:21"),
    ],
)
def test_compiler_defers_model_dependent_generation_values_to_live_schema(
    monkeypatch,
    parameter_id,
    value,
):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "text-to-image-video",
            "user_goal": "Generate a model capability test workflow",
            "inputs": {parameter_id: value},
        }
    )

    assert compiled["ok"] is True, compiled
    node_type = "imageGenNode" if parameter_id.startswith("image_") else "videoNode"
    data_key = (
        "aspectRatio"
        if parameter_id.endswith("aspect_ratio")
        else ("size" if node_type == "imageGenNode" else "quality")
    )
    media_nodes = [
        node for node in compiled["plan"]["nodes"] if node["node_type"] == node_type
    ]
    assert media_nodes
    assert all(node["data"][data_key] == value for node in media_nodes)


def test_compiler_propagates_first_frame_video_mode(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "text-to-image-video",
            "user_goal": "Generate a video from the first frame",
            "inputs": {"video_generation_mode": "firstFrame"},
        }
    )

    assert compiled["ok"] is True, compiled
    video_nodes = [
        node
        for node in compiled["plan"]["nodes"]
        if node["node_type"] == "videoNode"
    ]
    assert video_nodes
    assert all(node["data"]["genMode"] == "firstFrame" for node in video_nodes)


@pytest.mark.parametrize(
    ("parameter_id", "value", "message"),
    [
        (
            "image_variants_per_node",
            3,
            "unsupported option: 3; supported values: 1, 2, 4",
        ),
        (
            "video_variants_per_node",
            0,
            "unsupported option: 0; supported values: 1, 2, 4",
        ),
        ("image_variants_per_node", True, "must be an integer"),
        ("video_duration_seconds", 0, "must be greater than 0"),
        ("video_duration_seconds", 601, "must be less than or equal to 600"),
        ("video_generate_audio", "false", "must be a boolean"),
        ("image_model", 42, "must be a non-empty string"),
        ("video_generation_mode", "unknown", "unsupported option: unknown"),
    ],
)
def test_compiler_rejects_invalid_portable_generation_inputs(
    monkeypatch,
    parameter_id,
    value,
    message,
):
    catalog = _load_catalog_module()
    _install_minimal_builtin_catalog(monkeypatch, catalog)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "ecommerce-product",
            "user_goal": "Generate the product main image",
            "inputs": {parameter_id: value},
            "items": [
                {
                    "id": "hero",
                    "title": "Product main image",
                    "recipe_id": "general-image",
                }
            ],
            "include_compose": False,
        }
    )

    assert compiled["ok"] is False
    assert compiled["status"] == "invalid_workflow_intent"
    assert compiled["errors"] == [
        {"path": f"inputs.{parameter_id}", "message": message}
    ]


@pytest.mark.parametrize(
    ("parameter_type", "provided", "expected"),
    [
        ("integer", "2", 2),
        ("count", "4", 4),
        ("number", "3", 3),
        ("number", "3.5", 3.5),
        ("boolean", "true", True),
        ("boolean", "false", False),
    ],
)
def test_skill_input_contract_canonicalizes_unambiguous_scalar_types(
    parameter_type,
    provided,
    expected,
):
    catalog = _load_catalog_module()
    contract = catalog._skill_input_contract(
        {
            "input_parameters": [
                {
                    "id": "value",
                    "label": "Value",
                    "type": parameter_type,
                    "required": True,
                }
            ]
        },
        {"user_goal": "test", "inputs": {"value": provided}},
    )

    assert contract["errors"] == []
    assert contract["resolved"]["value"] == expected


@pytest.mark.parametrize(
    ("parameter_type", "provided", "message"),
    [
        ("integer", "1.5", "must be an integer"),
        ("integer", "9" * 5000, "must be an integer"),
        ("number", "three", "must be a number"),
        ("number", "9" * 5000, "must be a number"),
        ("boolean", "False", "must be a boolean"),
    ],
)
def test_skill_input_contract_rejects_ambiguous_scalar_types(
    parameter_type,
    provided,
    message,
):
    catalog = _load_catalog_module()
    contract = catalog._skill_input_contract(
        {
            "input_parameters": [
                {
                    "id": "value",
                    "label": "Value",
                    "type": parameter_type,
                    "required": True,
                }
            ]
        },
        {"user_goal": "test", "inputs": {"value": provided}},
    )

    assert contract["errors"] == [{"path": "inputs.value", "message": message}]


def test_dynamic_item_auto_connects_unique_generated_source_anchor(monkeypatch):
    catalog = _load_catalog_module()
    _install_minimal_builtin_catalog(monkeypatch, catalog)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "ecommerce-product",
            "user_goal": "First generate the product anchor, then the ad image",
            "items": [
                {
                    "id": "product-anchor",
                    "title": "Product anchor",
                    "recipe_id": "general-image",
                },
                {
                    "id": "hero-shot",
                    "title": "Product ad image",
                    "recipe_id": "ecommerce-ad-image",
                },
            ],
            "include_compose": False,
        }
    )

    assert compiled["ok"] is True
    assert {
        (edge["source"], edge["target"], edge["link_type"])
        for edge in compiled["plan"]["edges"]
    } >= {
        ("product-anchor", "hero-shot", "media_input_for"),
    }


def test_dynamic_item_rejects_conflicting_recipe_pipeline(monkeypatch):
    catalog = _load_catalog_module()
    recipes = copy.deepcopy(_MINIMAL_ECOMMERCE_RECIPES)
    next(item for item in recipes if item["id"] == "custom-shot-image")[
        "conflicts_with"
    ] = ["general-image"]

    def fake_load_json_dir(path):
        if path == catalog._SKILLS_DIR:
            return copy.deepcopy([_MINIMAL_ECOMMERCE_SKILL])
        if path == catalog._RECIPES_DIR:
            return copy.deepcopy(recipes)
        return []

    monkeypatch.setattr(catalog, "_load_json_dir", fake_load_json_dir)
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "ecommerce-product",
            "user_goal": "Generate a product image",
            "items": [
                {
                    "id": "hero",
                    "title": "Product image",
                    "recipe_id": "general-image",
                    "recipe_pipeline": ["custom-shot-image"],
                }
            ],
            "include_compose": False,
        }
    )

    assert compiled["ok"] is False
    assert "conflicts with" in compiled["error"]


def test_user_agent_config_merges_with_builtin_catalog(monkeypatch):
    catalog = _load_catalog_module()
    _install_minimal_builtin_catalog(monkeypatch, catalog)

    def fake_list_user_agent_config_items(_username, kind):
        if kind == "skills":
            return [
                {
                    "id": "director-method",
                    "description": "User-defined director method",
                    "triggers": {"node_scopes": ["imageGeneration"]},
                    "allowed_recipe_ids": ["director-frame"],
                }
            ]
        if kind == "recipes":
            return [
                {
                    "id": "director-frame",
                    "name": "Director keyframes",
                    "version": 1,
                    "output_kind": "image",
                }
            ]
        raise AssertionError(kind)

    monkeypatch.setattr(
        catalog, "list_user_agent_config_items", fake_list_user_agent_config_items
    )
    monkeypatch.setattr(catalog, "_catalog_username", lambda: "local")

    custom_package = catalog.get_workflow_skill({"skill_id": "director-method"})
    builtin_package = catalog.get_workflow_skill({"skill_id": "ecommerce-product"})

    assert custom_package["ok"] is True
    assert builtin_package["ok"] is False


def test_workflow_skill_limits_recipes_and_identifies_source_anchor(monkeypatch):
    catalog = _load_catalog_module()
    _install_minimal_builtin_catalog(monkeypatch, catalog)
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    package = catalog.get_workflow_skill({"skill_id": "ecommerce-product"})

    recipe_ids = {item["id"] for item in package["available_recipes"]}
    assert recipe_ids == {
        "ecommerce-ad-image",
        "general-image",
        "custom-shot-image",
    }
    assert package["planning_contract"]["recipe_ids_by_output_kind"] == {
        "image": [
            "custom-shot-image",
            "ecommerce-ad-image",
            "general-image",
        ]
    }
    assert package["planning_contract"]["missing_source_media"][
        "source_anchor_recipe_ids"
    ] == {"image": ["custom-shot-image", "general-image"]}


def test_compact_dynamic_intent_compiles_recipe_items_to_valid_plan(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    compiled = catalog.compile_workflow_intent(
        {
            "schema_version": "freezone_workflow_intent.v1",
            "skill_id": "pixar-ip-ad-video",
            "user_goal": "Make a 15-second 9:16 vertical ad for a black action camera",
            "inputs": {"aspect_ratio": "9:16", "duration": "15"},
            "items": [
                {
                    "id": "character_anchor",
                    "title": "Character anchor",
                    "prompt": "Design the brand animation character",
                    "recipe_id": "ad-ip-character-anchor",
                },
                {
                    "id": "storyboard",
                    "title": "Ad storyboard",
                    "prompt": "Generate a five-shot ad storyboard",
                    "recipe_id": "storyboard-plan",
                    "depends_on": ["character_anchor"],
                },
                {
                    "id": "video_clip",
                    "title": "Ad video",
                    "prompt": "Generate the brand ad video",
                    "recipe_id": "storyboard-shot-video",
                    "depends_on": ["storyboard", "character_anchor"],
                },
            ],
        }
    )

    assert compiled["ok"] is True
    assert compiled["node_count"] == 4
    plan = compiled["plan"]
    assert plan["mode"] == "tool_compiled_dynamic"
    node_catalog = plan["nodes"][1]["data"]["workflowCatalog"]
    assert node_catalog["recipeId"] == "ad-ip-character-anchor"
    assert node_catalog["skillVersion"] == plan["skill"]["version"]
    assert node_catalog["confirmedInputs"]["aspect_ratio"] == "9:16"
    assert not any(node["node_type"] == "videoComposeNode" for node in plan["nodes"])
    assert catalog.validate_agent_workflow_plan(plan)["ok"] is True


def test_validator_rejects_skill_version_mismatch_and_recipe_outside_whitelist():
    plan = _dynamic_plan()
    plan["nodes"][1]["data"]["workflowCatalog"]["skillVersion"] = "5"
    result = validate_workflow_plan(
        plan,
        skills_by_id={"ecommerce-product": _MINIMAL_ECOMMERCE_SKILL},
        recipes_by_id={item["id"]: item for item in _MINIMAL_ECOMMERCE_RECIPES},
    )
    assert result["ok"] is False
    assert any(issue["path"].endswith("skillVersion") for issue in result["errors"])

    plan = _dynamic_plan()
    plan["nodes"][1]["data"]["workflowCatalog"]["recipeId"] = "general-video"
    result = validate_workflow_plan(
        plan,
        skills_by_id={"ecommerce-product": _MINIMAL_ECOMMERCE_SKILL},
        recipes_by_id={item["id"]: item for item in _MINIMAL_ECOMMERCE_RECIPES},
    )
    assert result["ok"] is False
    assert any("not allowed by skill" in issue["message"] for issue in result["errors"])


def test_graph_builder_backfills_plan_skill_into_node_catalog():
    """Issue 676: raw plans declare the Skill once at plan.skill; the built
    node must still carry skillId so the runtime Recipe compiler keeps the
    Skill boundary and production constraints."""
    plan = _dynamic_plan(image_count=2)
    del plan["nodes"][1]["data"]["workflowCatalog"]["skillId"]
    plan["nodes"][2]["data"]["workflowCatalog"]["skillId"] = "other-skill"
    plan["nodes"][2]["data"]["workflowCatalog"]["skillVersion"] = "3"
    original_catalog = dict(plan["nodes"][1]["data"]["workflowCatalog"])

    graph = build_workflow_graph_commands({"plan": plan, "run_after_create": False})

    assert graph["ok"] is True, graph
    catalogs = {
        command["data"]["workflowPlanNodeId"]: command["data"].get("workflowCatalog")
        for command in graph["commands"]
        if command["type"] == "create_node"
    }
    assert catalogs["product_image_1"]["skillId"] == "ecommerce-product"
    assert catalogs["product_image_1"]["skillVersion"] == 6
    assert catalogs["product_image_1"]["recipeId"] == "ecommerce-ad-image"
    # Explicit node-level Skill identity is never overwritten.
    assert catalogs["product_image_2"]["skillId"] == "other-skill"
    assert catalogs["product_image_2"]["skillVersion"] == "3"
    # Nodes without a catalog gain nothing; the source plan is not mutated.
    assert catalogs["brief"] is None
    assert plan["nodes"][1]["data"]["workflowCatalog"] == original_catalog


def test_graph_builder_adopts_plan_skill_version_over_stale_node_version():
    """A node may carry skillVersion without skillId; the validator accepts
    that. Adopting the plan Skill must also adopt its version, otherwise the
    runtime rejects the node with a skill version mismatch."""
    plan = _dynamic_plan()
    catalog = plan["nodes"][1]["data"]["workflowCatalog"]
    del catalog["skillId"]
    catalog["skillVersion"] = "5"

    graph = build_workflow_graph_commands({"plan": plan, "run_after_create": False})

    assert graph["ok"] is True, graph
    built = next(
        command["data"]["workflowCatalog"]
        for command in graph["commands"]
        if command["type"] == "create_node"
        and command["data"]["workflowPlanNodeId"] == "product_image_1"
    )
    assert built["skillId"] == "ecommerce-product"
    assert built["skillVersion"] == 6

    # An unversioned plan Skill drops the orphan node version too.
    plan = _dynamic_plan()
    plan["skill"] = {"id": "ecommerce-product"}
    catalog = plan["nodes"][1]["data"]["workflowCatalog"]
    del catalog["skillId"]
    catalog["skillVersion"] = "5"

    graph = build_workflow_graph_commands({"plan": plan, "run_after_create": False})

    assert graph["ok"] is True, graph
    built = next(
        command["data"]["workflowCatalog"]
        for command in graph["commands"]
        if command["type"] == "create_node"
        and command["data"]["workflowPlanNodeId"] == "product_image_1"
    )
    assert built["skillId"] == "ecommerce-product"
    assert "skillVersion" not in built


def test_graph_builder_keeps_node_catalog_without_plan_skill():
    plan = _dynamic_plan()
    del plan["skill"]
    del plan["nodes"][1]["data"]["workflowCatalog"]["skillId"]

    graph = build_workflow_graph_commands({"plan": plan, "run_after_create": False})

    assert graph["ok"] is True, graph
    image_command = next(
        command
        for command in graph["commands"]
        if command["type"] == "create_node"
        and command["data"]["workflowPlanNodeId"] == "product_image_1"
    )
    assert "skillId" not in image_command["data"]["workflowCatalog"]


def test_compiler_uses_explicit_anchor_and_skips_audio_only_compose(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    ecommerce = catalog.compile_workflow_intent(
        {
            "skill_id": "pixar-ip-ad-video",
            "user_goal": "Make an animated ad for a new product",
            "items": [
                {
                    "id": "anchor",
                    "title": "Character anchor",
                    "prompt": "Generate the brand character",
                    "recipe_id": "ad-ip-character-anchor",
                },
                {
                    "id": "video",
                    "title": "Ad video",
                    "prompt": "Generate the brand ad video",
                    "recipe_id": "storyboard-shot-video",
                    "depends_on": ["anchor"],
                },
            ],
        }
    )
    audio = catalog.compile_workflow_intent(
        {
            "skill_id": "video-tutorial",
            "user_goal": "Turn Welcome into speech",
            "items": [
                {
                    "id": "audio",
                    "title": "Ad audio",
                    "prompt": "Welcome",
                    "narration": "Welcome",
                    "recipe_id": "general-audio",
                }
            ],
        }
    )

    assert ecommerce["ok"] is True
    assert ecommerce["plan"]["nodes"][1]["id"] == "anchor"
    assert audio["ok"] is True
    assert all(
        node["node_type"] != "videoComposeNode" for node in audio["plan"]["nodes"]
    )
    audio_node = next(
        node for node in audio["plan"]["nodes"] if node["node_type"] == "audioNode"
    )
    assert audio_node["data"]["workflowCatalog"]["recipeId"] == "general-audio"


def test_compiler_routes_general_audio_bgm_to_music_generation(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "video-tutorial",
            "user_goal": "Make a 15-second ad",
            "items": [
                {
                    "id": "bgm",
                    "title": "Background music",
                    "prompt": "Compose gentle background music for a 15-second ad",
                    "recipe_id": "general-audio",
                }
            ],
        }
    )

    assert compiled["ok"] is True
    audio_node = next(
        node for node in compiled["plan"]["nodes"] if node["node_type"] == "audioNode"
    )
    assert audio_node["data"]["audioKind"] == "music"
    assert audio_node["data"]["model"] == "suno_music"
    assert audio_node["data"]["musicLengthMs"] == 16_000
    assert "speechMode" not in audio_node["data"]


def test_compiler_keeps_timeline_audio_out_of_video_references(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "video-tutorial",
            "user_goal": "Make a 30-second tutorial video",
            "items": [
                {
                    "id": "frame",
                    "title": "Tutorial picture",
                    "prompt": "Main tutorial picture",
                    "recipe_id": "general-image",
                },
                {
                    "id": "voice",
                    "title": "Female voice narration",
                    "prompt": "Welcome to this tutorial",
                    "narration": "Welcome to this tutorial",
                    "recipe_id": "general-audio",
                    "timeline_role": "voiceover",
                },
                {
                    "id": "bgm",
                    "title": "30-second background music",
                    "prompt": "Light instrumental music",
                    "recipe_id": "general-audio",
                    "audio_kind": "music",
                    "timeline_role": "music",
                },
                {
                    "id": "clip",
                    "title": "Tutorial video",
                    "prompt": "Generate the tutorial video clip",
                    "recipe_id": "general-video",
                    "depends_on": ["frame", "voice", "bgm"],
                },
            ],
        }
    )

    assert compiled["ok"] is True
    edges = compiled["plan"]["edges"]
    assert not any(
        edge["target"] == "clip" and edge["source"] in {"voice", "bgm"}
        for edge in edges
    )
    assert {
        (edge["source"], edge["target"], edge["link_type"])
        for edge in edges
        if edge["target"] == "final_compose"
    } >= {
        ("voice", "final_compose", "composition_input_for"),
        ("bgm", "final_compose", "composition_input_for"),
        ("clip", "final_compose", "composition_input_for"),
    }


def test_compiler_uses_execution_only_edge_between_generated_video_steps(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "video-tutorial",
            "user_goal": "Make two consecutive tutorial shots",
            "items": [
                {
                    "id": "clip_1",
                    "title": "Shot one",
                    "prompt": "Show the operation entry",
                    "recipe_id": "general-video",
                    "timeline_role": "visual",
                },
                {
                    "id": "clip_2",
                    "title": "Shot two",
                    "prompt": "Show the operation result",
                    "recipe_id": "general-video",
                    "depends_on": ["clip_1"],
                    "timeline_role": "visual",
                },
            ],
        }
    )

    assert compiled["ok"] is True
    assert {
        (edge["source"], edge["target"], edge["link_type"])
        for edge in compiled["plan"]["edges"]
    } >= {
        ("clip_1", "clip_2", "dependency_for"),
        ("clip_1", "final_compose", "composition_input_for"),
        ("clip_2", "final_compose", "composition_input_for"),
    }


def test_compiler_propagates_portable_video_generation_inputs(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "video-tutorial",
            "user_goal": "Generate a tutorial video",
            "inputs": {
                "video_model": "video-model",
                "video_aspect_ratio": "9:16",
                "video_resolution": "1080P",
                "video_duration_seconds": 10,
                "video_generate_audio": True,
                "video_count": 3,
                "video_variants_per_node": 2,
            },
            "items": [
                {
                    "id": "clip",
                    "title": "Tutorial shot",
                    "recipe_id": "general-video",
                }
            ],
        }
    )

    assert compiled["ok"] is True
    video = next(
        node for node in compiled["plan"]["nodes"] if node["node_type"] == "videoNode"
    )
    assert {
        key: video["data"].get(key)
        for key in (
            "model",
            "aspectRatio",
            "quality",
            "durationSec",
            "generateAudio",
            "count",
        )
    } == {
        "model": "video-model",
        "aspectRatio": "9:16",
        "quality": "1080P",
        "durationSec": 10,
        "generateAudio": True,
        "count": 2,
    }


def test_schema_rejects_singular_group_alias():
    plan = {
        "schema_version": "freezone_workflow_plan.v1",
        "skill": {"id": "ecommerce-product"},
        "nodes": [
            {
                "id": "prompt",
                "node_type": "textAnnotationNode",
                "stage": "input",
            }
        ],
        "edges": [],
        "group": {"label": "Test workflow", "nodes": ["prompt", "missing"]},
    }

    with pytest.raises(ValidationError):
        Draft202012Validator(workflow_plan_json_schema()).validate(plan)


def test_validator_rejects_execution_policy_inside_plan():
    result = validate_workflow_plan(
        {
            "schema_version": "freezone_workflow_plan.v1",
            "skill": {"id": "ecommerce-product"},
            "nodes": [
                {
                    "id": "prompt",
                    "node_type": "textAnnotationNode",
                    "stage": "input",
                }
            ],
            "edges": [],
            "run_after_create": False,
        },
        skills_by_id={"ecommerce-product": _MINIMAL_ECOMMERCE_SKILL},
        recipes_by_id={recipe["id"]: recipe for recipe in _MINIMAL_ECOMMERCE_RECIPES},
    )

    assert result["ok"] is False
    assert any(
        issue["path"] == "run_after_create" and "beside plan" in issue["message"]
        for issue in result["errors"]
    )


def test_compiler_keeps_explicit_video_reference_as_media_input(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "video-tutorial",
            "user_goal": "Generate a new shot from a motion reference video",
            "items": [
                {
                    "id": "motion_reference",
                    "title": "Motion reference",
                    "prompt": "Reference the motion",
                    "recipe_id": "general-video",
                },
                {
                    "id": "clip",
                    "title": "New shot",
                    "prompt": "Keep the motion rhythm",
                    "recipe_id": "general-video",
                    "reference_inputs": ["motion_reference"],
                },
            ],
        }
    )

    assert compiled["ok"] is True
    assert (
        "motion_reference",
        "clip",
        "media_input_for",
    ) in {
        (edge["source"], edge["target"], edge["link_type"])
        for edge in compiled["plan"]["edges"]
    }


def test_compiler_maps_explicit_text_reference_to_prompt_input(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "video-tutorial",
            "user_goal": "Generate the first frame from a text prompt",
            "items": [
                {
                    "id": "prompt",
                    "title": "Picture prompt",
                    "prompt": "A future city on a rainy night, neon lights reflected on the road",
                    "recipe_id": "general-text",
                },
                {
                    "id": "frame",
                    "title": "City first frame",
                    "prompt": "Generate the city first frame",
                    "recipe_id": "general-image",
                    "reference_inputs": ["prompt"],
                },
            ],
            "include_compose": False,
        }
    )

    assert compiled["ok"] is True, compiled
    assert (
        "prompt",
        "frame",
        "prompt_for",
    ) in {
        (edge["source"], edge["target"], edge["link_type"])
        for edge in compiled["plan"]["edges"]
    }


@pytest.mark.parametrize("clip_count", [1, 2])
def test_compiler_replaces_recipe_backed_final_compose_with_compose_node(monkeypatch, clip_count):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "video-tutorial",
            "user_goal": "Make a tutorial and compose the final cut",
            "items": [
                *[{
                    "id": "clip" if index == 0 else "clip-two",
                    "title": "Tutorial shot",
                    "prompt": "Show the operation",
                    "recipe_id": "general-video",
                } for index in range(clip_count)],
                {
                    "id": "final-compose",
                    "title": "Final composition",
                    "prompt": "Compose all shots and audio",
                    "recipe_id": "general-video",
                    "depends_on": ["clip"],
                },
            ],
        }
    )

    assert compiled["ok"] is True
    plan = compiled["plan"]
    assert not any(node["id"] == "final-compose" for node in plan["nodes"])
    assert sum(node["node_type"] == "videoComposeNode" for node in plan["nodes"]) == (
        1 if clip_count > 1 else 0
    )


def test_compiler_respects_explicit_audio_kind_for_ambiguous_general_audio(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "video-tutorial",
            "user_goal": "Make an ad",
            "items": [
                {
                    "id": "soundtrack",
                    "title": "Ad sound",
                    "prompt": "Gentle piano",
                    "audio_kind": "music",
                    "recipe_id": "general-audio",
                }
            ],
        }
    )

    audio_node = next(
        node for node in compiled["plan"]["nodes"] if node["node_type"] == "audioNode"
    )
    assert audio_node["data"]["audioKind"] == "music"


def test_compiler_rejects_speech_instruction_without_literal_narration(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "video-tutorial",
            "user_goal": "Make an ad",
            "items": [
                {
                    "id": "narration",
                    "title": "Narration voiceover",
                    "prompt": "Based on the narration copy in the ad script, generate a female-voice narration voiceover",
                    "audio_kind": "speech",
                    "recipe_id": "general-audio",
                }
            ],
        }
    )

    assert compiled["ok"] is False
    assert compiled["errors"][0]["path"] == "items.0.narration"


def test_parameterized_skill_uses_stateless_input_contract(monkeypatch):
    catalog = _load_catalog_module()
    _use_parameterized_catalog(monkeypatch, catalog)

    package = catalog.get_workflow_skill(
        {
            "skill_id": "cinematic-short",
            "user_goal": "Generate a vertical cinematic short",
            "inputs": {"duration": "90"},
        }
    )

    assert package["ok"] is True
    assert "type" not in package["skill"]
    assert "parameters" not in package["skill"]
    assert package["skill"]["input_parameters"]
    assert package["input_contract"]["ready_for_planning"] is True
    assert package["input_contract"]["resolved"]["duration"] == "90"
    assert package["input_contract"]["resolved"]["aspect_ratio"] == "9:16"
    assert package["input_contract"]["inferred"] == {"aspect_ratio": "9:16"}
    assert (
        next(
            field
            for field in package["input_contract"]["fields"]
            if field["id"] == "aspect_ratio"
        )["source"]
        == "inferred"
    )
    assert package["input_contract"]["recommended_run_after_create"] is True
    recipe_ids = {item["id"] for item in package["available_recipes"]}
    assert "general-text" in recipe_ids


def test_explicit_skill_inputs_override_deterministic_inference(monkeypatch):
    catalog = _load_catalog_module()
    _use_parameterized_catalog(monkeypatch, catalog)

    package = catalog.get_workflow_skill(
        {
            "skill_id": "cinematic-short",
            "user_goal": "Generate a 90-second vertical short and execute automatically",
            "inputs": {
                "duration": "60",
                "aspect_ratio": "16:9",
                "execution_mode": "manual",
            },
        }
    )

    contract = package["input_contract"]
    assert contract["resolved"] == {
        "duration": "60",
        "execution_mode": "manual",
        "aspect_ratio": "16:9",
    }
    assert contract["inferred"] == {
        "duration": "90",
        "execution_mode": "auto",
        "aspect_ratio": "9:16",
    }
    assert contract["recommended_run_after_create"] is False


def test_workflow_skill_input_contract_rejects_unknown_option(monkeypatch):
    catalog = _load_catalog_module()
    _use_parameterized_catalog(monkeypatch, catalog)

    package = catalog.get_workflow_skill(
        {
            "skill_id": "cinematic-short",
            "inputs": {"duration": "120"},
        }
    )

    assert package["ok"] is True
    assert package["input_contract"]["ready_for_planning"] is False
    assert package["input_contract"]["errors"] == [
        {"path": "inputs.duration", "message": "unsupported option: 120"}
    ]


def test_dynamic_workflow_plan_accepts_different_node_counts(monkeypatch):
    catalog = _load_catalog_module()
    _install_minimal_builtin_catalog(monkeypatch, catalog)

    three = catalog.validate_agent_workflow_plan(_dynamic_plan(image_count=3))
    six = catalog.validate_agent_workflow_plan(_dynamic_plan(image_count=6))

    assert three["ok"] is True
    assert three["node_count"] == 4
    assert six["ok"] is True
    assert six["node_count"] == 7


def test_workflow_plan_schema_rejects_canvas_type_alias():
    plan = _dynamic_plan(image_count=1)
    for node in plan["nodes"]:
        node["type"] = node.pop("node_type")

    with pytest.raises(ValidationError):
        Draft202012Validator(workflow_plan_json_schema()).validate(plan)


def test_workflow_plan_schema_rejects_extra_node_type_alias():
    plan = _dynamic_plan(image_count=1)
    plan["nodes"][1]["type"] = "audioNode"

    with pytest.raises(ValidationError):
        Draft202012Validator(workflow_plan_json_schema()).validate(plan)


def test_workflow_plan_schema_accepts_data_stage_compatibility_path():
    plan = _dynamic_plan(image_count=1)
    input_node = plan["nodes"][0]
    input_node["data"]["stage"] = input_node.pop("stage")

    Draft202012Validator(workflow_plan_json_schema()).validate(plan)

    result = validate_workflow_plan(plan)

    assert result["ok"] is True


def test_workflow_plan_schema_rejects_data_stage_on_executable_node():
    plan = _dynamic_plan(image_count=1)
    plan["nodes"][1]["data"]["stage"] = "input"

    with pytest.raises(ValidationError):
        Draft202012Validator(workflow_plan_json_schema()).validate(plan)


def test_workflow_plan_schema_rejects_extra_edge_type_alias():
    plan = _dynamic_plan(image_count=1)
    plan["edges"][0]["type"] = "dependency_for"

    with pytest.raises(ValidationError):
        Draft202012Validator(workflow_plan_json_schema()).validate(plan)


def test_workflow_plan_rejects_invalid_runtime_catalog_shapes_before_canvas_apply():
    plan = _dynamic_plan()
    catalog = plan["nodes"][1]["data"]["workflowCatalog"]
    catalog.update(
        {
            "confirmedInputs": ["brief"],
            "promptStrategy": "ambient_bgm",
            "inputStrategy": "script_to_bgm",
            "promptBuilder": "episode_bgm",
        }
    )

    result = validate_workflow_plan(plan)

    assert result["ok"] is False
    errors = {error["path"]: error["message"] for error in result["errors"]}
    catalog_path = "nodes[1].data.workflowCatalog"
    assert errors[f"{catalog_path}.confirmedInputs"] == "must be an object"
    assert errors[f"{catalog_path}.inputStrategy"] == "must be an object"
    assert errors[f"{catalog_path}.promptBuilder"] == "must be an object"
    assert errors[f"{catalog_path}.promptStrategy"].startswith("must be one of:")


def test_workflow_plan_rejects_large_text_hidden_in_mcp_plan_fields():
    plan = _dynamic_plan()
    plan["nodes"][0]["data"]["content"] = "body" * 2_001

    result = validate_workflow_plan(plan)

    assert result["ok"] is False
    assert any(
        error["path"] == "nodes[0].data.content"
        and "deliver large text through a text Recipe" in error["message"]
        for error in result["errors"]
    )


def test_workflow_plan_rejects_large_text_split_across_small_fields():
    plan = _dynamic_plan(image_count=3)
    plan["nodes"][0]["data"].update(
        {
            "content": "a" * 1_500,
            "text": "b" * 1_500,
            "description": "c" * 1_500,
        }
    )

    result = validate_workflow_plan(plan)

    assert result["ok"] is False
    assert any(
        issue["path"] == "$" and "aggregate workflow planning text" in issue["message"]
        for issue in result["errors"]
    )


def test_workflow_plan_rejects_recipe_backed_user_input_node():
    plan = _dynamic_plan()
    plan["nodes"][0]["data"]["workflowCatalog"] = {
        "skillId": "ecommerce-product",
        "recipeId": "general-text",
        "stepId": "user_requirement",
    }

    result = validate_workflow_plan(plan)

    assert result["ok"] is False
    assert any(
        error["path"] == "nodes[0].data.workflowCatalog.recipeId"
        and "must not execute a Recipe" in error["message"]
        for error in result["errors"]
    )


def test_workflow_plan_reports_deterministic_preflight_summary():
    result = validate_workflow_plan(_dynamic_plan(image_count=3))

    assert result["ok"] is True
    assert result["preflight"]["status"] == "ready"
    assert result["preflight"]["generation_task_count"] == 3
    assert result["preflight"]["counts"] == {
        "text": 1,
        "image": 3,
        "video": 0,
        "audio": 0,
        "compose": 0,
        "html": 0,
    }


def test_standard_short_drama_planner_supports_25_beats_and_full_asset_chain(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    units = [
        {
            "title": f"Beat {index:02d}",
            "prompt": f"Concrete action and picture goal of plot Beat {index}",
            "narration": f"These are the lines actually read for Beat {index}.",
        }
        for index in range(1, 26)
    ]
    intent = {
        "schema_version": "freezone_workflow_intent.v1",
        "skill_id": "short-drama-quick",
        "inputs": {"visual_style": "unspecified"},
        "user_goal": "Outline of a three-episode short drama, and make 25 Beats for the first episode",
        "planner": {
            "mode": "standard",
            "item_count": 25,
            "include_audio": True,
            "units": units,
        },
    }

    Draft202012Validator(workflow_intent_json_schema()).validate(intent)
    compiled = catalog.compile_workflow_intent(intent)

    assert compiled["ok"] is True, compiled
    assert compiled["planner"]["mode"] == "deterministic_standard"
    assert compiled["planner"]["item_count"] == 25
    plan = compiled["plan"]
    nodes = {node["id"]: node for node in plan["nodes"]}
    assert {"characters", "character_assets", "scenes", "scene_assets"} <= set(nodes)
    assert {"props", "prop_assets", "frame_25", "clip_25", "voice_25"} <= set(nodes)
    assert "final_compose" in nodes
    assert len(plan["nodes"]) == 110
    assert len(plan["edges"]) <= 400
    assert compiled["preflight"]["blockers"] == []
    graph = build_workflow_graph_commands({"plan": plan, "run_after_create": False})
    assert graph["ok"] is True, graph
    assert sum(command["type"] == "create_node" for command in graph["commands"]) == 110


def _quick_drama_visual_style_plan(style="realistic"):
    return {
        "schema_version": "freezone_workflow_plan.v1",
        "summary": "Two-shot short drama",
        "skill": {"id": "short-drama-quick"},
        "inputs": {"visual_style": style},
        "nodes": [
            {"id": "story", "node_type": "textAnnotationNode", "stage": "story", "data": {
                "displayName": "Story setting",
                "content": "A realistic short drama story" if style == "realistic" else "A short drama story",
                "workflowCatalog": {"skillId": "short-drama-quick", "recipeId": "drama-plot-outline"},
            }},
            {"id": "portrait", "node_type": "imageGenNode", "stage": "image", "data": {
                "displayName": "Character appearance", "prompt": "A person stands on the street",
                "workflowCatalog": {
                    "skillId": "short-drama-quick", "recipeId": "drama-character-turnaround",
                },
            }},
            {"id": "clip", "node_type": "videoNode", "stage": "video", "data": {
                "displayName": "Opening shot", "prompt": "The person walks into the shop", "durationSec": 7,
                "workflowCatalog": {"skillId": "short-drama-quick", "recipeId": "general-video"},
            }},
        ],
        "edges": [
            {"source": "story", "target": "portrait", "link_type": "prompt_for"},
            {"source": "portrait", "target": "clip", "link_type": "media_input_for"},
        ],
    }


def test_quick_drama_requires_explicit_visual_style_decision(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    package = catalog.get_workflow_skill({"skill_id": "short-drama-quick", "user_goal": "short drama"})

    assert "visual_style" in package["input_contract"]["missing_required"]
    missing = _quick_drama_visual_style_plan()
    del missing["inputs"]["visual_style"]
    rejected = catalog.validate_agent_workflow_plan(missing)
    assert rejected["ok"] is False
    assert rejected["errors"][0]["path"] == "inputs.visual_style"

    unspecified = _quick_drama_visual_style_plan("unspecified")
    accepted = catalog.validate_agent_workflow_plan(unspecified)
    assert accepted["ok"] is True, accepted
    assert not any(
        blocker["code"] == "confirmed_visual_style_missing"
        for blocker in accepted["preflight"]["blockers"]
    )
    assert "realistic" not in str(accepted["plan"]["nodes"])


def test_quick_drama_confirmed_style_reaches_every_visual_task(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    plan = _quick_drama_visual_style_plan()

    missing_video = catalog.validate_agent_workflow_plan(plan)
    assert missing_video["ok"] is True, missing_video
    assert missing_video["preflight"]["status"] == "blocked"
    style_blockers = [
        blocker for blocker in missing_video["preflight"]["blockers"]
        if blocker["code"] == "confirmed_visual_style_missing"
    ]
    assert [blocker["node_id"] for blocker in style_blockers] == ["clip"]

    # A title or catalog metadata is not prompt context consumed by the model.
    plan["nodes"][-1]["data"]["displayName"] = "Realistic opening shot"
    titled = catalog.validate_agent_workflow_plan(plan)
    assert any(
        blocker["code"] == "confirmed_visual_style_missing"
        and blocker["node_id"] == "clip"
        for blocker in titled["preflight"]["blockers"]
    )

    plan["edges"].append({"source": "story", "target": "clip", "link_type": "prompt_for"})
    linked = catalog.validate_agent_workflow_plan(plan)
    assert linked["ok"] is True, linked
    assert not any(
        blocker["code"] == "confirmed_visual_style_missing"
        for blocker in linked["preflight"]["blockers"]
    )

    plan["edges"].pop()
    plan["nodes"][-1]["data"]["prompt"] += ", realistic photography style"
    direct = catalog.validate_agent_workflow_plan(plan)
    assert not any(
        blocker["code"] == "confirmed_visual_style_missing"
        for blocker in direct["preflight"]["blockers"]
    )


def test_quick_drama_ignores_stale_style_in_noncanonical_fields(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    plan = _quick_drama_visual_style_plan()
    story, portrait, clip = plan["nodes"]
    story["data"].update(content="A short drama story", prompt="A realistic old story prompt")
    portrait["data"].update(content="A realistic old image prompt", text="A realistic old image text")
    clip["data"].update(content="A realistic old video prompt", text="A realistic old video text")
    plan["edges"].append({"source": "story", "target": "clip", "link_type": "prompt_for"})

    result = catalog.validate_agent_workflow_plan(plan)

    assert result["ok"] is True, result
    assert {
        blocker["node_id"] for blocker in result["preflight"]["blockers"]
        if blocker["code"] == "confirmed_visual_style_missing"
    } == {"portrait", "clip"}


def test_exact_short_drama_plan_supports_24_beats_and_exact_count_guards(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    skill_id = "short-drama-quick"
    nodes = [
        {
            "id": "request",
            "node_type": "textAnnotationNode",
            "stage": "input",
            "data": {"displayName": "User request", "content": "Always generate 24 visual Beats"},
        },
        {
            "id": "script",
            "node_type": "textAnnotationNode",
            "stage": "story",
            "data": {
                "displayName": "Episode 1 complete script",
                "content": "Beat 01—Beat 24",
                "workflowCatalog": {
                    "skillId": skill_id,
                    "recipeId": "general-text",
                },
            },
        },
    ]
    edges = [{"source": "request", "target": "script", "link_type": "context_for"}]
    for beat in range(1, 25):
        suffix = f"{beat:02d}"
        frame_id = f"beat_{suffix}_frame"
        video_id = f"beat_{suffix}_video"
        nodes.extend(
            [
                {
                    "id": frame_id,
                    "node_type": "imageGenNode",
                    "stage": "image",
                    "data": {
                        "displayName": f"Beat {suffix} first frame",
                        "workflowCatalog": {
                            "skillId": skill_id,
                            "recipeId": "general-image",
                        },
                    },
                },
                {
                    "id": video_id,
                    "node_type": "videoNode",
                    "stage": "video",
                    "data": {
                        "displayName": f"Beat {suffix} video",
                        "workflowCatalog": {
                            "skillId": skill_id,
                            "recipeId": "general-video",
                        },
                    },
                },
            ]
        )
        edges.extend(
            [
                {"source": "script", "target": frame_id, "link_type": "prompt_for"},
                {
                    "source": frame_id,
                    "target": video_id,
                    "link_type": "media_input_for",
                },
            ]
        )

    nodes.extend(
        [
            {
                "id": "voiceover",
                "node_type": "audioNode",
                "stage": "audio",
                "data": {
                    "displayName": "Episode 1 narration",
                    "audioKind": "speech",
                    "workflowCatalog": {
                        "skillId": skill_id,
                        "recipeId": "drama-shot-voice",
                    },
                },
            },
            {
                "id": "background_music",
                "node_type": "audioNode",
                "stage": "audio",
                "data": {
                    "displayName": "Episode 1 background music",
                    "audioKind": "music",
                    "workflowCatalog": {
                        "skillId": skill_id,
                        "recipeId": "drama-background-music",
                    },
                },
            },
            {
                "id": "final_compose",
                "node_type": "videoComposeNode",
                "stage": "compose",
                "data": {"displayName": "Episode 1 final cut"},
            },
        ]
    )
    edges.extend(
        [
            {"source": "script", "target": "voiceover", "link_type": "prompt_for"},
            {
                "source": "script",
                "target": "background_music",
                "link_type": "prompt_for",
            },
            {
                "source": "voiceover",
                "target": "final_compose",
                "link_type": "composition_input_for",
            },
            {
                "source": "background_music",
                "target": "final_compose",
                "link_type": "composition_input_for",
            },
            *[
                {
                    "source": f"beat_{beat:02d}_video",
                    "target": "final_compose",
                    "link_type": "composition_input_for",
                }
                for beat in range(1, 25)
            ],
        ]
    )
    node_ids = [node["id"] for node in nodes]
    plan = {
        "schema_version": "freezone_workflow_plan.v1",
        "workflow_type": "dynamic.short-drama-episode",
        "skill": {"id": skill_id, "version": 2},
        "inputs": {"visual_style": "unspecified"},
        "expected_node_count": 53,
        "expected_node_counts": {
            "textAnnotationNode": 2,
            "imageGenNode": 24,
            "videoNode": 24,
            "audioNode": 2,
            "videoComposeNode": 1,
        },
        "nodes": nodes,
        "edges": edges,
        "group": {"label": "Episode 1 production workflow", "node_ids": node_ids},
        "layout": {"mode": "grid", "direction": "left_to_right"},
    }

    validated = catalog.validate_agent_workflow_plan(plan)

    assert validated["ok"] is True, validated
    assert validated["node_count"] == 53
    graph = build_workflow_graph_commands({"plan": plan, "run_after_create": False})
    assert graph["ok"] is True, graph
    assert sum(command["type"] == "create_node" for command in graph["commands"]) == 53
    assert sum(command["type"] == "group_nodes" for command in graph["commands"]) == 1

    truncated = {**plan, "nodes": plan["nodes"][:-1]}
    rejected = validate_workflow_plan(truncated)
    assert rejected["ok"] is False
    assert any(issue["path"] == "expected_node_count" for issue in rejected["errors"])


def _video_compose_plan() -> dict:
    return {
        "schema_version": "freezone_workflow_plan.v1",
        "workflow_type": "dynamic.video",
        "nodes": [
            {"id": "clip", "node_type": "videoNode", "stage": "video"},
            {"id": "compose", "node_type": "videoComposeNode", "stage": "compose"},
        ],
        "edges": [
            {
                "source": "clip",
                "target": "compose",
                "link_type": "composition_input_for",
            }
        ],
    }


@pytest.mark.parametrize("requested_model", [
    "seedance-2.0-fast", "seedance-2.0", "seedance-1.5-pro",
    "newapi_seedance-2.0-fast", "newapi_seedance-2.0",
    "huimeng_seedance-1.5-pro", "01M1N6KNNEQKPZCSKYSK02DPV1",
    "unknown-model", "recommended",
])
def test_workflow_graph_preserves_video_catalog_id(requested_model):
    graph = build_workflow_graph_commands(
        {
            "plan": {
                "schema_version": "freezone_workflow_plan.v1",
                "workflow_type": "dynamic.video",
                "nodes": [
                    {
                        "id": "clip",
                        "node_type": "videoNode",
                        "stage": "video",
                        "data": {"model": requested_model},
                    }
                ],
                "edges": [],
            },
            "run_after_create": False,
        }
    )

    assert graph["ok"] is True
    create_command = next(
        command for command in graph["commands"] if command["type"] == "create_node"
    )
    assert create_command["data"]["model"] == requested_model


def test_workflow_seedance_alias_emits_canvas_catalog_id_not_backend_api_model():
    graph = build_workflow_graph_commands(
        {
            "plan": {
                "schema_version": "freezone_workflow_plan.v1",
                "workflow_type": "dynamic.video",
                "nodes": [
                    {
                        "id": "clip",
                        "node_type": "videoNode",
                        "stage": "video",
                        "data": {"model": "seedance-2.0-fast"},
                    }
                ],
                "edges": [],
            },
            "run_after_create": False,
        }
    )

    assert graph["ok"] is True
    create_command = next(
        command for command in graph["commands"] if command["type"] == "create_node"
    )
    assert create_command["data"]["model"] == "seedance-2.0-fast"


def test_workflow_plan_rejects_duplicate_or_non_terminal_compose_nodes():
    plan = _video_compose_plan()
    plan["nodes"].append(
        {"id": "compose_two", "node_type": "videoComposeNode", "stage": "compose"}
    )
    plan["edges"].append(
        {
            "source": "clip",
            "target": "compose_two",
            "link_type": "composition_input_for",
        }
    )
    plan["edges"].append(
        {"source": "compose", "target": "clip", "link_type": "dependency_for"}
    )

    result = validate_workflow_plan(plan)

    assert result["ok"] is False
    assert any(
        "at most one videoComposeNode" in issue["message"] for issue in result["errors"]
    )
    assert any(
        "must be a terminal node" in issue["message"] for issue in result["errors"]
    )


def test_workflow_plan_rejects_composition_edge_to_regular_video_node():
    plan = _video_compose_plan()
    plan["nodes"].append({"id": "clip_two", "node_type": "videoNode", "stage": "video"})
    plan["edges"].append(
        {
            "source": "clip",
            "target": "clip_two",
            "link_type": "composition_input_for",
        }
    )

    result = validate_workflow_plan(plan)

    assert result["ok"] is False
    assert any(
        "composition_input_for must target videoComposeNode" in issue["message"]
        for issue in result["errors"]
    )


def test_workflow_plan_rejects_recipe_backed_video_as_final_compose():
    plan = _video_compose_plan()
    plan["nodes"] = [
        {
            "id": "clip",
            "node_type": "videoNode",
            "stage": "compose",
            "data": {
                "workflowCatalog": {
                    "recipeId": "general-video",
                    "stepId": "final_compose",
                }
            },
        }
    ]
    plan["edges"] = []

    result = validate_workflow_plan(plan)

    assert result["ok"] is False
    assert any(
        "final composition must use videoComposeNode" in issue["message"]
        for issue in result["errors"]
    )


def test_dynamic_workflow_plan_validates_skill_inputs(monkeypatch):
    catalog = _load_catalog_module()
    _use_parameterized_catalog(monkeypatch, catalog)
    plan = {
        "schema_version": "freezone_workflow_plan.v1",
        "workflow_type": "dynamic.cinematic-short",
        "skill": {"id": "cinematic-short"},
        "inputs": {"duration": "120", "execution_mode": "manual"},
        "nodes": [
            {
                "id": "concept",
                "node_type": "textAnnotationNode",
                "stage": "story",
                "data": {
                    "prompt": "Generate a cinematic short concept",
                    "workflowCatalog": {
                        "skillId": "cinematic-short",
                        "recipeId": "general-text",
                        "recipeVersion": "1",
                    },
                },
            }
        ],
        "edges": [],
    }

    invalid = catalog.validate_agent_workflow_plan(plan)
    assert invalid["ok"] is False
    assert invalid["errors"][0] == {
        "path": "inputs.duration",
        "message": "unsupported option: 120",
    }

    plan["inputs"]["duration"] = "90"
    valid = catalog.validate_agent_workflow_plan(plan)
    assert valid["ok"] is True
    assert valid["execution_mode"] == "manual"
    assert valid["recommended_run_after_create"] is False


def test_strict_workflow_plan_rejects_disconnected_multi_node_graph():
    plan = _dynamic_plan(image_count=2)
    plan["edges"] = []

    result = validate_workflow_plan(plan)

    assert result["ok"] is False
    assert result["errors"] == [
        {
            "path": "edges",
            "message": "multi-node workflow must declare dependency edges",
        }
    ]

    partially_connected = _dynamic_plan(image_count=2)
    partially_connected["edges"] = partially_connected["edges"][:1]

    partial_result = validate_workflow_plan(partially_connected)

    assert partial_result["ok"] is False
    assert partial_result["errors"] == [
        {
            "path": "edges",
            "message": "workflow graph contains disconnected nodes: product_image_2",
        }
    ]


def test_strict_workflow_plan_rejects_unknown_node_bad_edge_and_cycle():
    plan = _dynamic_plan()
    plan["nodes"].append({"id": "invalid", "node_type": "inventedImageNode"})
    plan["edges"].append(
        {"source": "missing", "target": "brief", "link_type": "context_for"}
    )
    plan["edges"].append(
        {"source": "product_image_1", "target": "brief", "link_type": "media_input_for"}
    )

    result = validate_workflow_plan(plan)

    assert result["ok"] is False
    assert result["status"] == "invalid_dynamic_workflow_plan"
    paths = {error["path"] for error in result["errors"]}
    assert "nodes[2].node_type" in paths
    assert "edges[1].source" in paths
    assert any("cycle" in error["message"] for error in result["errors"])


def test_incompatible_text_to_audio_edge_reports_safe_replacement():
    plan = _dynamic_plan()
    plan["nodes"][1] = {
        "id": "voiceover",
        "node_type": "audioNode",
        "stage": "audio",
        "data": {
            "audioKind": "speech",
            "workflowCatalog": {"recipeId": "drama-shot-voice"},
        },
    }
    plan["edges"][0] = {
        "source": "brief",
        "target": "voiceover",
        "link_type": "context_for",
    }

    result = validate_workflow_plan(plan)

    assert result["ok"] is False
    assert result["errors"][0] == {
        "path": "edges[0]",
        "message": (
            "context_for is incompatible with textAnnotationNode -> audioNode; "
            "allowed link types: dependency_for, prompt_for; "
            "use prompt_for when the audio node consumes the source text"
        ),
    }


def test_catalog_validation_rejects_unknown_recipe_and_version_mismatch(monkeypatch):
    catalog = _load_catalog_module()
    _install_minimal_builtin_catalog(monkeypatch, catalog)
    unknown = _dynamic_plan()
    unknown["nodes"][1]["data"]["workflowCatalog"]["recipeId"] = "not-a-recipe"
    mismatch = _dynamic_plan()
    mismatch["nodes"][1]["data"]["workflowCatalog"]["recipeVersion"] = "999"

    unknown_result = catalog.validate_agent_workflow_plan(unknown)
    mismatch_result = catalog.validate_agent_workflow_plan(mismatch)

    assert unknown_result["ok"] is False
    assert "unknown recipe" in unknown_result["error"]
    assert mismatch_result["ok"] is False
    assert "version mismatch" in mismatch_result["error"]


def test_catalog_validation_requires_recipe_and_skill_capability(monkeypatch):
    catalog = _load_catalog_module()
    _install_minimal_builtin_catalog(monkeypatch, catalog)
    missing_recipe = _dynamic_plan()
    missing_recipe["nodes"][1]["data"].pop("workflowCatalog")
    unsupported_capability = _dynamic_plan()
    unsupported_capability["nodes"][1]["node_type"] = "videoNode"
    unsupported_catalog = unsupported_capability["nodes"][1]["data"]["workflowCatalog"]
    unsupported_catalog["recipeId"] = "general-video"
    unsupported_catalog["recipeVersion"] = "1"

    missing_result = catalog.validate_agent_workflow_plan(missing_recipe)
    unsupported_result = catalog.validate_agent_workflow_plan(unsupported_capability)

    assert missing_result["ok"] is False
    assert "requires an explicit recipeId" in missing_result["error"]
    assert unsupported_result["ok"] is False
    assert any(
        "not allowed by skill" in error["message"]
        for error in unsupported_result["errors"]
    )


def test_catalog_validation_requires_real_or_generated_source_media(monkeypatch):
    catalog = _load_catalog_module()
    _install_minimal_builtin_catalog(monkeypatch, catalog)
    missing_source = _dynamic_plan()
    missing_source["nodes"][1]["data"].pop("referenceImageUrl")

    missing_result = catalog.validate_agent_workflow_plan(missing_source)

    assert missing_result["ok"] is False
    assert "requires source media" in missing_result["error"]

    anchor = {
        "id": "product_anchor",
        "node_type": "imageGenNode",
        "stage": "asset",
        "data": {
            "prompt": "A baseline product image of sneakers on a neutral background",
            "workflowCatalog": {
                "skillId": "ecommerce-product",
                "recipeId": "general-image",
                "recipeVersion": "1",
            },
        },
    }
    missing_source["nodes"].insert(1, anchor)
    missing_source["edges"].append(
        {
            "source": "product_anchor",
            "target": "product_image_1",
            "link_type": "media_input_for",
        }
    )

    anchored_result = catalog.validate_agent_workflow_plan(missing_source)

    assert anchored_result["ok"] is True


def test_project_catalog_uses_canonical_pixar_skill_and_recipes(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    skills = {item["id"]: item for item in catalog._load_skills()}
    recipes = {
        item["id"]: item
        for item in catalog._load_agent_config_items("recipes", catalog._RECIPES_DIR)
    }

    assert skills["ecommerce-ad"]["name"] == "E-commerce Ad"
    assert skills["video-tutorial"]["name"] == "Video Explainer Tutorial"
    assert skills["text-to-image-video"]["name"] == "Text to Image to Video (Dynamic)"
    assert skills["text-to-image"]["name"] == "Text to Image (Dynamic)"
    assert skills["short-drama-quick"]["name"] == "Short Drama (Quick Test)"
    assert skills["pixar-ip-ad-video"]["name"] == "Pixar-Style IP Brand Ad Short"
    assert skills["lego-minifigure-animation-video"]["name"] == "LEGO Minifigure Animation Short"
    assert skills["retro-hong-kong-kungfu-comedy-video"]["name"] == "Retro Hong Kong Kung Fu Pet Short"
    assert skills["outdoor-stage-duel-video"]["name"] == "Outdoor Stage Two-Person Ability Show"
    assert skills["ling-cage-cinematic-video"]["name"] == "Ling Cage Style Sci-Fi Short"
    assert skills["japanese-anime-drama-video"]["name"] == "Japanese Anime Drama Studio"
    assert all(
        parameter.get("id") != "execution_mode"
        for skill in skills.values()
        for parameter in skill.get("input_parameters") or []
        if isinstance(parameter, dict)
    )
    assert "pixar-ip-brand-ad-short-film" not in skills
    assert skills["pixar-ip-ad-video"]["allowed_recipe_ids"] == [
        "ad-ip-character-anchor",
        "ad-product-prop-anchor",
        "storyboard-plan",
        "storyboard-shot-video",
        "video-audio-layer",
    ]
    assert skills["lego-minifigure-animation-video"]["allowed_recipe_ids"] == [
        "short-film-script-outline",
        "storyboard-plan",
        "visual-key-elements",
        "storyboard-shot-video",
    ]
    assert skills["retro-hong-kong-kungfu-comedy-video"]["allowed_recipe_ids"] == [
        "four-act-comedy-story-outline",
        "storyboard-plan",
        "anthropomorphic-kungfu-key-elements",
        "anthropomorphic-kungfu-shot-video",
        "video-audio-layer",
    ]
    assert skills["outdoor-stage-duel-video"]["allowed_recipe_ids"] == [
        "outdoor-stage-duel-storyboard",
        "outdoor-stage-duel-key-elements",
        "outdoor-stage-duel-shot-video",
        "outdoor-stage-duel-audio-layers",
    ]
    assert skills["ling-cage-cinematic-video"]["allowed_recipe_ids"] == [
        "sci-fi-survival-story-script",
        "sci-fi-survival-storyboard",
        "sci-fi-survival-key-elements",
        "sci-fi-survival-shot-video",
        "sci-fi-survival-audio-layers",
    ]
    assert skills["japanese-anime-drama-video"]["allowed_recipe_ids"] == [
        "dialogue-drama-story-script",
        "dialogue-drama-storyboard-plan",
        "visual-key-elements",
        "dialogue-continuity-shot-video",
    ]
    assert "ad-ip-character-anchor" in recipes
    assert "ad-product-prop-anchor" in recipes
    assert "workflow-input-analysis" in recipes
    assert "short-film-script-outline" in recipes
    assert "four-act-comedy-story-outline" in recipes
    assert "storyboard-plan" in recipes
    assert "anthropomorphic-kungfu-key-elements" in recipes
    assert "anthropomorphic-kungfu-shot-video" in recipes
    assert "outdoor-stage-duel-storyboard" in recipes
    assert "outdoor-stage-duel-key-elements" in recipes
    assert "outdoor-stage-duel-shot-video" in recipes
    assert "outdoor-stage-duel-audio-layers" in recipes
    assert "sci-fi-survival-story-script" in recipes
    assert "sci-fi-survival-storyboard" in recipes
    assert "sci-fi-survival-key-elements" in recipes
    assert "sci-fi-survival-shot-video" in recipes
    assert "sci-fi-survival-audio-layers" in recipes
    assert "dialogue-drama-story-script" in recipes
    assert "dialogue-drama-storyboard-plan" in recipes
    assert "dialogue-drama-key-elements" not in recipes
    assert "dialogue-continuity-shot-video" in recipes
    assert "dialogue-voice-ambience-layer" not in recipes
    assert "visual-key-elements" in recipes
    assert "storyboard-shot-video" in recipes
    assert "video-audio-layer" in recipes
    assert "pixar-ip-character-design" not in recipes
    assert "pixar-ip-prop-anchor" not in recipes
    assert "pixar-ip-storyboard-sketch" not in recipes
    assert "pixar-ip-shot-video" not in recipes
    assert "pixar-ip-audio-layers" not in recipes
    assert "pixar-ip-compose-plan" not in recipes
    assert "pixar-shot-video-clip" not in recipes
    assert "storyboard-sketch" not in recipes
    assert "shot-video" not in recipes
    assert "ad-video-audio-layer" not in recipes
    assert "ad-audio-production" not in recipes
    assert "lego-minifig-input-analysis" not in recipes
    assert "lego-minifig-script-outline" not in recipes
    assert "lego-minifig-video-spec" not in recipes
    assert "lego-minifig-storyboard" not in recipes
    assert "lego-minifig-key-elements" not in recipes
    assert "lego-minifig-shot-video" not in recipes
    assert "lego-minifig-audio-layers" not in recipes
    assert "retro-kungfu-video-spec" not in recipes
    assert "retro-kungfu-story-outline" not in recipes
    assert "retro-kungfu-shot-list" not in recipes
    assert "retro-kungfu-key-elements" not in recipes
    assert "retro-kungfu-shot-video" not in recipes
    assert "retro-kungfu-bgm" not in recipes
    assert "outdoor-stage-duel-video-spec" not in recipes
    assert "ling-cage-video-spec" not in recipes
    assert "ling-cage-story-script" not in recipes
    assert "ling-cage-storyboard" not in recipes
    assert "ling-cage-key-elements" not in recipes
    assert "ling-cage-shot-video" not in recipes
    assert "ling-cage-audio-layers" not in recipes


def test_pixar_skill_keeps_methodology_while_recipes_stay_stage_focused(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    skills = {item["id"]: item for item in catalog._load_skills()}
    recipes = {
        item["id"]: item
        for item in catalog._load_agent_config_items("recipes", catalog._RECIPES_DIR)
    }
    pixar_skill = skills["pixar-ip-ad-video"]
    planning_text = "\n".join(
        [
            pixar_skill["planning"]["planning_notes"],
            pixar_skill["planning"]["prompt_guide"],
            "\n".join(pixar_skill["planning"]["conduct_rules"]),
            "\n".join(pixar_skill["evaluation"]["domain_constraints"]),
        ]
    )
    planning_notes = pixar_skill["planning"]["planning_notes"]
    prompt_guide = pixar_skill["planning"]["prompt_guide"]

    assert "Gate 1" in planning_text
    assert "character attribute table" in planning_text
    assert "product props" in planning_text
    assert "character-related props" in planning_text
    assert "15-second ad = 9 panels" in planning_text
    assert "A 15-second ad is usually split into 4 video clips" in planning_text
    assert "character anchor" in planning_text and "storyboard" in planning_text
    assert "Sequence → Shot Group → Shot" in planning_text
    assert "Pixar 3D cartoon rendering" in prompt_guide
    assert "C4D + Octane" in prompt_guide
    assert "[Execution path]" not in prompt_guide
    assert "[Pixar visual direction]" not in planning_notes
    assert "input_parameters" not in planning_text
    assert "videoCompose" not in planning_text
    assert "storyboard-sketch" not in planning_text
    assert "shot-video" not in planning_text
    assert "ad-video-audio-layer" not in planning_text
    assert "workflow-input-analysis" not in planning_text
    assert "short-film-script-outline" not in planning_text
    assert "storyboard-plan" not in planning_text
    assert "storyboard-shot-video" not in planning_text
    assert "video-audio-layer" not in planning_text

    recipe_text = "\n".join(
        item
        for recipe_id in [
            "ad-ip-character-anchor",
            "ad-product-prop-anchor",
            "storyboard-plan",
            "storyboard-shot-video",
            "video-audio-layer",
        ]
        for item in [
            recipes[recipe_id]["system_prompt"],
            recipes[recipe_id]["planning_prompt"],
            "\n".join(recipes[recipe_id]["must_have_items"]),
        ]
    )
    assert "self-invented style" not in recipe_text
    assert "overrides the Skill" not in recipe_text
    assert "within the Recipe" not in recipe_text

    character_anchor = recipes["ad-ip-character-anchor"]
    character_text = "\n".join(
        [
            character_anchor["name"],
            character_anchor["system_prompt"],
            character_anchor["planning_prompt"],
            character_anchor["result_summary"],
            "\n".join(character_anchor["must_have_items"]),
        ]
    )
    assert "ad IP character anchor" in character_text
    assert "body appendages" in character_text
    assert "brand, logo, product selling points and product appearance are left to the prop anchor stage" in character_text
    assert "tail state must be explicit" not in character_text
    assert "no tail / tailless" not in character_text


def test_lego_skill_keeps_style_while_recipes_are_shared_workflow_stages(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    skills = {item["id"]: item for item in catalog._load_skills()}
    recipes = {
        item["id"]: item
        for item in catalog._load_agent_config_items("recipes", catalog._RECIPES_DIR)
    }
    lego_skill = skills["lego-minifigure-animation-video"]
    planning = lego_skill["planning"]
    planning_text = "\n".join(
        [
            planning["planning_notes"],
            planning["prompt_guide"],
            "\n".join(planning["conduct_rules"]),
            "\n".join(lego_skill["evaluation"]["domain_constraints"]),
        ]
    )

    assert "LEGO Minifigure animation" in planning["prompt_guide"]
    assert "ABS plastic material" in planning["prompt_guide"]
    assert "LEGO building logic" in planning["prompt_guide"]
    assert "Before starting" in planning["planning_notes"]
    assert "confirmed information" in planning["planning_notes"]
    assert "script outline" in planning["planning_notes"]
    assert "three-level" in planning["planning_notes"]
    assert "visual key element" in planning["planning_notes"]
    assert "video clips" in planning["planning_notes"]
    assert "Final editing" in planning["planning_notes"]
    assert "Final_Video_Spec" not in planning_text
    assert "input_parameters" not in planning_text
    assert "planning.prompt_guide" not in planning_text
    assert "conduct_rules" not in planning_text
    assert "workflow-input-analysis" not in planning_text
    assert "short-film-script-outline" not in planning_text
    assert "storyboard-plan" not in planning_text
    assert "visual-key-elements" not in planning_text
    assert "storyboard-shot-video" not in planning_text
    assert "video-audio-layer" not in planning_text

    recipe_text = "\n".join(
        item
        for recipe_id in [
            "short-film-script-outline",
            "storyboard-plan",
            "visual-key-elements",
            "storyboard-shot-video",
        ]
        for item in [
            recipes[recipe_id]["name"],
            recipes[recipe_id]["system_prompt"],
            recipes[recipe_id]["planning_prompt"],
            recipes[recipe_id]["result_summary"],
            "\n".join(recipes[recipe_id]["must_have_items"]),
        ]
    )
    assert "LEGO Minifigure" not in recipe_text
    assert "official LEGO style" not in recipe_text
    assert "ABS plastic material" not in recipe_text
    assert "Final_Video_Spec" not in recipe_text


@pytest.mark.parametrize(
    "skill_id",
    [
        "retro-hong-kong-kungfu-comedy-video",
        "lego-minifigure-animation-video",
    ],
)
def test_video_skill_compose_contract_reaches_plan_and_canvas(monkeypatch, skill_id):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    package = catalog.get_workflow_skill({"skill_id": skill_id, "compact": True})
    assert package["ok"] is True
    assert "videoNode" in package["allowed_node_types"]
    assert "videoComposeNode" in package["allowed_node_types"]
    assert "composition_input_for" in package["allowed_link_types"]
    assert "multiple video clips or video with audio" in package["agent_instruction"]

    video_recipe = next(
        recipe
        for recipe in package["available_recipes"]
        if recipe["output_kind"] == "video"
    )
    image_recipe = next(
        recipe
        for recipe in package["available_recipes"]
        if recipe["output_kind"] == "image" and not recipe["requires_source_media"]
    )
    plan = {
        "schema_version": "freezone_workflow_plan.v1",
        "workflow_type": "dynamic.compose-contract",
        "skill": {"id": skill_id, "version": package["skill"]["version"]},
        "nodes": [
            {
                "id": "asset",
                "node_type": "imageGenNode",
                "stage": "image",
                "data": {
                    "workflowCatalog": {
                        "skillId": skill_id,
                        "recipeId": image_recipe["id"],
                    }
                },
            }
        ] + [
            {
                "id": node_id,
                "node_type": "videoNode",
                "stage": "video",
                "data": {
                    "workflowCatalog": {
                        "skillId": skill_id,
                        "recipeId": video_recipe["id"],
                    }
                },
            }
            for node_id in ("clip_1", "clip_2")
        ] + [{"id": "final", "node_type": "videoComposeNode", "stage": "compose"}],
        "edges": [
            {"source": "asset", "target": node_id, "link_type": "media_input_for"}
            for node_id in ("clip_1", "clip_2")
        ] + [
            {"source": node_id, "target": "final", "link_type": "composition_input_for"}
            for node_id in ("clip_1", "clip_2")
        ],
    }
    assert not list(Draft202012Validator(workflow_plan_json_schema()).iter_errors(plan))
    validated = catalog.validate_agent_workflow_plan(plan)
    assert validated["ok"] is True, validated
    graph = build_workflow_graph_commands(
        {"plan": validated["plan"], "run_after_create": False}
    )
    assert graph["ok"] is True, graph
    assert sum(command["type"] == "create_node" for command in graph["commands"]) == 4
    assert sum(command["type"] == "create_edge" for command in graph["commands"]) == 4


def test_image_skill_does_not_advertise_video_compose(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    package = catalog.get_workflow_skill(
        {"skill_id": "social-content-campaign", "compact": True}
    )

    assert package["ok"] is True
    assert "videoNode" not in package["allowed_node_types"]
    assert "videoComposeNode" not in package["allowed_node_types"]


def test_retro_kungfu_skill_keeps_style_while_recipes_stay_stage_focused(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    skills = {item["id"]: item for item in catalog._load_skills()}
    recipes = {
        item["id"]: item
        for item in catalog._load_agent_config_items("recipes", catalog._RECIPES_DIR)
    }
    retro_skill = skills["retro-hong-kong-kungfu-comedy-video"]
    planning = retro_skill["planning"]
    planning_text = "\n".join(
        [
            planning["planning_notes"],
            planning["prompt_guide"],
            "\n".join(planning["conduct_rules"]),
            "\n".join(retro_skill["evaluation"]["domain_constraints"]),
        ]
    )

    assert "1980s retro Hong Kong kung fu comedy" in planning["prompt_guide"]
    assert "35mm old film grain" in planning["prompt_guide"]
    assert "Every video node must write out, for each core action of the current shot, the three phases of preparation, motion and completion" in planning["prompt_guide"]
    assert "Hong Kong-flavored accent" in planning["prompt_guide"]
    assert "script outline" in planning["planning_notes"]
    assert "the storyboard plan" in planning["planning_notes"]
    assert "anthropomorphic kung fu key element image" in planning["planning_notes"]
    assert "anthropomorphic kung fu single-clip video" in planning["planning_notes"]
    assert "video audio layer" in planning["planning_notes"]
    assert "independent key element nodes" in planning["planning_notes"]
    assert "Do not merge multiple subjects into one key element node" in planning["planning_notes"]
    assert "By default each shot runs in parallel" in planning["planning_notes"]
    assert "real continuity input" in planning["planning_notes"]
    assert "Final_Video_Spec" not in planning_text
    assert "retro-kungfu" not in planning_text
    assert "four-act-comedy-story-outline" not in planning_text
    assert "storyboard-plan" not in planning_text
    assert "anthropomorphic-kungfu-shot-video" not in planning_text
    assert "video-audio-layer" not in planning_text

    recipe = recipes["anthropomorphic-kungfu-key-elements"]
    recipe_text = "\n".join(
        [
            recipe["name"],
            recipe["system_prompt"],
            recipe["planning_prompt"],
            recipe["result_summary"],
            "\n".join(recipe["must_have_items"]),
        ]
    )
    assert "anthropomorphic kung fu" in recipe_text
    assert "Reference source" in recipe_text
    assert "How it is referenced later" in recipe_text
    assert "35mm" not in recipe_text
    assert "Hong Kong style" not in recipe_text
    assert "Hong Kong" not in recipe_text
    assert "80s" not in recipe_text
    assert "old film" not in recipe_text
    assert "Final_Video_Spec" not in recipe_text
    assert "Skill input parameters" not in recipe_text
    assert "overrides the Skill" not in recipe_text
    assert "within the Recipe" not in recipe_text

    story_recipe = recipes["four-act-comedy-story-outline"]
    story_text = "\n".join(
        [
            story_recipe["name"],
            story_recipe["system_prompt"],
            story_recipe["planning_prompt"],
            story_recipe["result_summary"],
            "\n".join(story_recipe["must_have_items"]),
        ]
    )
    assert "four-act" in story_text
    assert "Comic contrast" in story_text
    assert "three-act structure" not in story_text
    assert "Hong Kong style" not in story_text
    assert "Hong Kong" not in story_text

    shot_recipe = recipes["anthropomorphic-kungfu-shot-video"]
    shot_text = "\n".join(
        [
            shot_recipe["name"],
            shot_recipe["system_prompt"],
            shot_recipe["planning_prompt"],
            shot_recipe["result_summary"],
            "\n".join(shot_recipe["must_have_items"]),
        ]
    )
    assert "Anticipation" in shot_text
    assert "Movement" in shot_text
    assert "Completion" in shot_text
    assert "Animal instinct" in shot_text
    assert "no background music" in shot_text
    assert "35mm" not in shot_text
    assert "Hong Kong style" not in shot_text
    assert "Hong Kong" not in shot_text
    assert "80s" not in shot_text
    assert "old film" not in shot_text


def test_outdoor_stage_duel_skill_keeps_global_spec_in_skill(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    skills = {item["id"]: item for item in catalog._load_skills()}
    recipes = {
        item["id"]: item
        for item in catalog._load_agent_config_items("recipes", catalog._RECIPES_DIR)
    }
    skill = skills["outdoor-stage-duel-video"]
    planning = skill["planning"]
    planning_text = "\n".join(
        [
            planning["planning_notes"],
            planning["prompt_guide"],
            "\n".join(planning["conduct_rules"]),
            "\n".join(skill["evaluation"]["domain_constraints"]),
        ]
    )

    assert "audience first-person" in planning["prompt_guide"]
    assert "two characters A/B" in planning["planning_notes"]
    assert "this specification creates no standalone node" in planning["planning_notes"]
    assert "storyboard" in planning["planning_notes"]
    assert "key element" in planning["planning_notes"]
    assert "single-shot video" in planning["planning_notes"]
    assert "audio layer" in planning["planning_notes"]
    assert "Final_Video_Spec" not in planning_text
    assert "outdoor-stage-duel-video-spec" not in planning_text

    recipe_text = "\n".join(
        item
        for recipe_id in [
            "outdoor-stage-duel-storyboard",
            "outdoor-stage-duel-key-elements",
            "outdoor-stage-duel-shot-video",
            "outdoor-stage-duel-audio-layers",
        ]
        for item in [
            recipes[recipe_id]["name"],
            recipes[recipe_id]["system_prompt"],
            recipes[recipe_id]["planning_prompt"],
            recipes[recipe_id]["result_summary"],
            "\n".join(recipes[recipe_id]["must_have_items"]),
        ]
    )
    assert "Final_Video_Spec" not in recipe_text
    assert "audience POV" in recipe_text
    assert "Element_Character_A" in recipe_text
    assert "Element_Character_B" in recipe_text
    assert "Beat 1" in recipe_text
    assert "Audio_BGM" in recipe_text
    assert "Audio_VO" in recipe_text


def test_ling_cage_skill_keeps_style_while_recipes_are_survival_sci_fi_stages(
    monkeypatch,
):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    skills = {item["id"]: item for item in catalog._load_skills()}
    recipes = {
        item["id"]: item
        for item in catalog._load_agent_config_items("recipes", catalog._RECIPES_DIR)
    }
    skill = skills["ling-cage-cinematic-video"]
    planning = skill["planning"]
    planning_text = "\n".join(
        [
            planning["planning_notes"],
            planning["prompt_guide"],
            "\n".join(planning["conduct_rules"]),
            "\n".join(skill["evaluation"]["domain_constraints"]),
        ]
    )

    assert "Ling Cage-flavored" in planning["prompt_guide"]
    assert "semi-realistic 3D CG" in planning_text
    assert "GPT Image 2" not in planning_text
    assert "Seedance 2.0" not in planning_text
    assert "auto-retry once on the same model failure" not in planning_text
    assert "this specification does not create a standalone node" in planning["planning_notes"]
    assert "story direction" in planning["planning_notes"]
    assert "storyboard" in planning["planning_notes"]
    assert "key element image" in planning["planning_notes"]
    assert 'Do not create just one generic "key elements" node' in planning_text
    assert "Each recurring character or team is its own node" in planning_text
    assert "each main reused scene is its own node" in planning_text
    assert "every Shot List entry must be an independent video intent item" in planning_text
    assert "single-shot video" in planning["planning_notes"]
    assert "audio" in planning["planning_notes"]
    audio_mode = next(
        parameter
        for parameter in skill["input_parameters"]
        if parameter["id"] == "audio_mode"
    )
    assert audio_mode["label"] == "Background music"
    assert audio_mode["default"] == "Generate BGM"
    assert audio_mode["options"] == ["Generate BGM", "Do not generate BGM"]
    assert "dialogue narration sound effects and BGM" not in planning_text
    assert "only sound effects and BGM" not in planning_text
    assert "dialogue and sound effects are written into the corresponding video prompt" in planning_text
    assert "create a BGM audio node only when a score is needed" in planning_text
    assert "Final_Video_Spec" not in planning_text
    assert "ling-cage-video-spec" not in planning_text
    assert "sci-fi-survival-story-script" not in planning_text
    assert "sci-fi-survival-storyboard" not in planning_text
    assert "sci-fi-survival-key-elements" not in planning_text
    assert "sci-fi-survival-shot-video" not in planning_text
    assert "sci-fi-survival-audio-layers" not in planning_text

    recipe_text = "\n".join(
        item
        for recipe_id in [
            "sci-fi-survival-story-script",
            "sci-fi-survival-storyboard",
            "sci-fi-survival-key-elements",
            "sci-fi-survival-shot-video",
            "sci-fi-survival-audio-layers",
        ]
        for item in [
            recipes[recipe_id]["name"],
            recipes[recipe_id]["system_prompt"],
            recipes[recipe_id]["planning_prompt"],
            recipes[recipe_id]["result_summary"],
            "\n".join(recipes[recipe_id]["must_have_items"]),
        ]
    )
    assert "Post-Apocalyptic Sci-Fi" in recipe_text
    assert "Final_Video_Spec" not in recipe_text
    assert "Ling Cage" not in recipe_text
    assert "Mana" not in recipe_text
    assert "Lighthouse" not in recipe_text
    assert "Dragon Bone Village" not in recipe_text
    assert "polar devourer beast" not in recipe_text
    assert "overrides the Skill" not in recipe_text
    assert "within the Recipe" not in recipe_text

    audio_layer = recipes["sci-fi-survival-audio-layers"]
    audio_layer_text = "\n".join(
        [
            audio_layer["name"],
            audio_layer["system_prompt"],
            audio_layer["planning_prompt"],
            audio_layer["result_summary"],
            "\n".join(audio_layer["must_have_items"]),
        ]
    )
    assert "BGM" in audio_layer_text
    assert "Dialogue" not in audio_layer_text
    assert "Narration" not in audio_layer_text
    assert "Ambient" not in audio_layer_text
    assert "Action SFX" not in audio_layer_text
    assert "key_element_audio" not in audio_layer_text
    assert "narration_speaker_profile" not in audio_layer_text

    key_elements = recipes["sci-fi-survival-key-elements"]
    key_text = "\n".join(
        [
            key_elements["name"],
            key_elements["system_prompt"],
            key_elements["planning_prompt"],
            key_elements["result_summary"],
            "\n".join(key_elements["must_have_items"]),
        ]
    )
    assert "full-body three-view" in key_text
    assert "2x2 four-panel grid without characters" in key_text
    assert "Complete structure or multi-angle" in key_text
    assert "Anchors for later video references" in key_text

    shot_text = "\n".join(
        [
            recipes["sci-fi-survival-shot-video"]["system_prompt"],
            "\n".join(recipes["sci-fi-survival-shot-video"]["must_have_items"]),
        ]
    )
    assert "image_infos at most 9" in shot_text
    assert "audio_infos at most 3" in shot_text
    assert "reference_video" in shot_text
    assert "back to camera" in shot_text
    assert "micro-shake" in shot_text
    assert "no subtitles" in shot_text


def test_japanese_anime_drama_skill_locks_language_and_continuity(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    skills = {item["id"]: item for item in catalog._load_skills()}
    recipes = {
        item["id"]: item
        for item in catalog._load_agent_config_items("recipes", catalog._RECIPES_DIR)
    }
    skill = skills["japanese-anime-drama-video"]
    planning = skill["planning"]
    recipe_ids = [
        "dialogue-drama-story-script",
        "dialogue-drama-storyboard-plan",
        "visual-key-elements",
        "dialogue-continuity-shot-video",
    ]
    planning_text = "\n".join(
        [
            planning["planning_notes"],
            planning["prompt_guide"],
            "\n".join(planning["conduct_rules"]),
            "\n".join(skill["evaluation"]["domain_constraints"]),
        ]
    )

    assert "Japanese realistic anime" in planning["prompt_guide"]
    assert "language and accent style" in planning_text
    assert "Vietnamese" in planning_text
    assert "16:9" in planning_text
    assert "24fps" in planning_text
    assert "no BGM" in planning_text
    assert "no subtitles" in planning_text
    assert "no on-screen text" in planning_text
    assert "1.5 seconds" in planning_text
    assert "30-degree rule" in planning_text
    assert "this specification creates no standalone node" in planning["planning_notes"]
    assert "story script" in planning["planning_notes"]
    assert "storyboard" in planning["planning_notes"]
    assert "key element" in planning["planning_notes"]
    assert "dependency_for only controls execution order" in planning_text
    assert "does not consume the upstream output" in planning_text
    assert "Story script to storyboard must use context_for" in planning_text
    assert "storyboard text to image or video nodes must use prompt_for" in planning_text
    assert "visual assets to video nodes must use media_input_for" in planning_text
    assert 'Do not create just one generic "key elements" node' in planning_text
    assert "Each recurring character is its own node" in planning_text
    assert "each main reused scene is its own node" in planning_text
    assert "each core prop, vehicle or environment object that needs a consistent appearance across shots" in planning_text
    assert "sample" in planning["planning_notes"]
    assert "voice reference assets" in planning["planning_notes"]
    assert "lip-sync" in planning["planning_notes"]
    assert "No standalone audio node is created by default" in planning_text
    assert "the user designates an uploaded or on-canvas audio/video as a voice reference" in planning_text
    assert "@audioN or @videoN is used in the video prompt to explain the voice, lip-sync, tone or rhythm purpose" in planning_text
    assert "voiceRef" not in planning_text
    assert "speechMode" not in planning_text
    assert "audio node connection relationships" not in planning_text
    assert (
        "final assembly, mixing, 4K upscaling and export are handled by the canvas compose node"
        in planning["planning_notes"]
    )
    assert "<<<image_" not in planning_text
    assert "<<<video_" not in planning_text
    assert "<<<audio_" not in planning_text
    assert "image_infos" not in planning_text
    assert "audio_infos" not in planning_text
    assert "the model and generation mode selected on the current node" in planning_text
    for recipe_id in recipe_ids:
        assert recipe_id not in planning_text

    recipe_text = "\n".join(
        item
        for recipe_id in recipe_ids
        for item in [
            recipes[recipe_id]["name"],
            recipes[recipe_id]["system_prompt"],
            recipes[recipe_id]["planning_prompt"],
            recipes[recipe_id]["result_summary"],
            "\n".join(recipes[recipe_id]["must_have_items"]),
        ]
    )
    assert "Japanese anime drama" not in recipe_text
    for supplier in ("Seedance", "Kling", "Nano Banana", "Gemini", "GPT Image"):
        assert supplier not in planning_text
        assert supplier not in recipe_text

    key_text = "\n".join(
        [
            recipes["visual-key-elements"]["system_prompt"],
            "\n".join(recipes["visual-key-elements"]["must_have_items"]),
        ]
    )
    assert "character, scene and prop" in key_text
    assert "Multi-angle or expression sheet" in key_text
    assert "consistency anchor for later shots" in key_text
    assert "confirmed character, scene or prop settings" in key_text

    shot_text = "\n".join(
        [
            recipes["dialogue-continuity-shot-video"]["system_prompt"],
            "\n".join(recipes["dialogue-continuity-shot-video"]["must_have_items"]),
        ]
    )
    assert "@imageN" in shot_text
    assert "@videoN" in shot_text
    assert "@audioN" in shot_text
    assert "connected to the current node" in shot_text
    assert "the model and generation mode selected on the current node" in shot_text
    assert "<<<image_" not in shot_text
    assert "<<<video_" not in shot_text
    assert "<<<audio_" not in shot_text
    assert "image_infos" not in shot_text
    assert "audio_infos" not in shot_text
    assert "handheld breathing feel" in shot_text
    assert "offset by at least 15 degrees" in shot_text
    assert "global creative specification" in shot_text


def test_project_catalog_skills_compile_dynamic_multi_item_workflows(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)
    skill_recipes = {
        "ecommerce-ad": ("video-clip-generation", "general-image"),
        "video-tutorial": ("general-video", None),
        "text-to-image-video": ("general-video", None),
        "short-drama-quick": ("general-video", None),
        "pixar-ip-ad-video": ("storyboard-shot-video", "ad-ip-character-anchor"),
        "lego-minifigure-animation-video": (
            "storyboard-shot-video",
            "visual-key-elements",
        ),
        "outdoor-stage-duel-video": (
            "outdoor-stage-duel-shot-video",
            "outdoor-stage-duel-key-elements",
        ),
        "ling-cage-cinematic-video": (
            "sci-fi-survival-shot-video",
            "sci-fi-survival-key-elements",
        ),
        "japanese-anime-drama-video": (
            "dialogue-continuity-shot-video",
            "visual-key-elements",
        ),
    }

    for skill_id, (recipe_id, anchor_recipe_id) in skill_recipes.items():
        anchor_items = (
            [
                {
                    "id": "anchor",
                    "title": "Asset anchor",
                    "prompt": "Generate the consistency asset anchor",
                    "recipe_id": anchor_recipe_id,
                }
            ]
            if anchor_recipe_id
            else []
        )
        compiled = catalog.compile_workflow_intent(
            {
                "schema_version": "freezone_workflow_intent.v1",
                "skill_id": skill_id,
                "user_goal": f"Test {skill_id}",
                **({"inputs": {"visual_style": "unspecified"}}
                   if skill_id == "short-drama-quick" else {}),
                "items": anchor_items
                + [
                    {
                        "id": f"shot_{index}",
                        "title": f"Shot {index}",
                        "prompt": f"Test shot {index}",
                        "recipe_id": recipe_id,
                        **({"depends_on": ["anchor"]} if anchor_recipe_id else {}),
                    }
                    for index in range(1, 4)
                ],
            }
        )

        assert compiled["ok"] is True, (skill_id, compiled)
        assert catalog.validate_agent_workflow_plan(compiled["plan"])["ok"] is True
        assert compiled["plan"]["nodes"][-1]["node_type"] == "videoComposeNode"


def test_short_drama_quick_expands_shot_voice_and_background_music(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    compiled = catalog.compile_workflow_intent(
        {
            "schema_version": "freezone_workflow_intent.v1",
            "skill_id": "short-drama-quick",
            "user_goal": "Make a two-shot suspense short drama",
            "inputs": {"visual_style": "unspecified"},
            "items": [
                {
                    "id": "clip_1",
                    "title": "Shot one",
                    "prompt": "Convenience store exterior",
                    "recipe_id": "general-video",
                },
                {
                    "id": "clip_2",
                    "title": "Shot two",
                    "prompt": "The clerk looks at the monitor",
                    "recipe_id": "general-video",
                },
                {
                    "id": "voice_1",
                    "title": "Shot one narration",
                    "prompt": "The convenience store at midnight, with only him inside.",
                    "narration": "The convenience store at midnight, with only him inside.",
                    "recipe_id": "drama-shot-voice",
                    "depends_on": ["clip_1"],
                    "timeline_role": "shot_voice",
                },
                {
                    "id": "voice_2",
                    "title": "Shot two narration",
                    "prompt": "Why doesn't the self on the monitor move in sync?",
                    "narration": "Why doesn't the self on the monitor move in sync?",
                    "recipe_id": "drama-shot-voice",
                    "depends_on": ["clip_2"],
                    "timeline_role": "shot_voice",
                },
                {
                    "id": "background_music",
                    "title": "Background music",
                    "prompt": "Suspense instrumental music",
                    "recipe_id": "drama-background-music",
                    "timeline_role": "background_music",
                },
            ],
        }
    )

    assert compiled["ok"] is True
    plan = compiled["plan"]
    voice_nodes = [
        node
        for node in plan["nodes"]
        if node["data"].get("workflowCatalog", {}).get("timelineRole") == "shot_voice"
    ]
    bgm_nodes = [
        node
        for node in plan["nodes"]
        if node["data"].get("workflowCatalog", {}).get("timelineRole")
        == "background_music"
    ]
    assert [node["data"]["text"] for node in voice_nodes] == [
        "The convenience store at midnight, with only him inside.",
        "Why doesn't the self on the monitor move in sync?",
    ]
    assert all(node["data"]["audioKind"] == "speech" for node in voice_nodes)
    assert all(
        node["data"]["workflowCatalog"]["timelineRole"] == "shot_voice"
        for node in voice_nodes
    )
    assert len(bgm_nodes) == 1
    assert bgm_nodes[0]["data"]["audioKind"] == "music"
    assert bgm_nodes[0]["data"]["workflowCatalog"]["timelineRole"] == "background_music"
    assert {
        (edge["source"], edge["target"])
        for edge in plan["edges"]
        if edge["target"].startswith("voice_")
    } == {
        ("clip_1", "voice_1"),
        ("clip_2", "voice_2"),
    }


def test_custom_short_drama_speech_can_consume_upstream_script_text(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "short-drama-quick",
            "inputs": {"visual_style": "unspecified"},
            "user_goal": "First generate the shot text, then the voiceover",
            "include_audio": True,
            "include_compose": False,
            "items": [
                {
                    "id": "shot",
                    "title": "Shot text",
                    "prompt": "Output the shot picture, action and actual dialogue",
                    "recipe_id": "drama-shot-group-detail",
                },
                {
                    "id": "voice",
                    "title": "Shot voiceover",
                    "prompt": "Read aloud only the narration or dialogue body in the upstream shot text",
                    "recipe_id": "drama-shot-voice",
                    "depends_on": ["shot"],
                    "reference_inputs": ["shot"],
                    "timeline_role": "voiceover",
                },
            ],
        }
    )

    assert compiled["ok"] is True, compiled
    voice = next(node for node in compiled["plan"]["nodes"] if node["id"] == "voice")
    assert "text" not in voice["data"]
    assert any(
        edge == {"source": "shot", "target": "voice", "link_type": "prompt_for"}
        for edge in compiled["plan"]["edges"]
    )


def test_custom_short_drama_cannot_drop_requested_voiceover(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "short-drama-quick",
            "inputs": {"visual_style": "unspecified"},
            "user_goal": "Make a short drama with voiceover",
            "include_audio": True,
            "items": [
                {
                    "id": "outline",
                    "title": "Plot outline",
                    "prompt": "Generate the plot outline",
                    "recipe_id": "drama-plot-outline",
                },
                {
                    "id": "music",
                    "title": "Background music",
                    "prompt": "Generate suspense instrumental music",
                    "recipe_id": "drama-background-music",
                    "depends_on": ["outline"],
                },
            ],
        }
    )

    assert compiled["ok"] is False
    assert compiled["errors"][0]["path"] == "items"
    assert "no speech node" in compiled["error"]
    assert "Do not remove requested voiceover" in compiled["errors"][0]["hint"]
