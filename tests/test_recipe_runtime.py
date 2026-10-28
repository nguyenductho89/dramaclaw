from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.brainclaw_contract import (
    BrainClawProfile,
    BrainClawProfileVariant,
)
from novelvideo.freezone import recipe_runtime
from novelvideo.freezone.agent_catalog_schema import validate_agent_recipe_config


def test_builtin_text_recipes_produce_final_deliverables():
    recipe_root = (
        Path(__file__).resolve().parents[1]
        / "src/novelvideo/freezone/agent_catalog/builtins/recipes"
    )
    text_recipe_ids: list[str] = []
    for recipe_path in sorted(recipe_root.glob("*.json")):
        payload = json.loads(recipe_path.read_text(encoding="utf-8"))
        if payload.get("output_kind") != "text":
            continue
        validated = validate_agent_recipe_config(payload)
        text_recipe_ids.append(str(validated["id"]))

    assert len(text_recipe_ids) == 24
    assert "general-text" in text_recipe_ids
    assert "ecommerce-text-plan" in text_recipe_ids


@pytest.mark.parametrize(
    "recipe_id",
    ["sci-fi-survival-shot-video", "anthropomorphic-kungfu-shot-video"],
)
def test_builtin_video_recipes_leave_audio_to_confirmed_user_choice(recipe_id):
    recipe_path = (
        Path(__file__).resolve().parents[1]
        / "src/novelvideo/freezone/agent_catalog/builtins/recipes"
        / f"{recipe_id}.json"
    )
    payload = json.loads(recipe_path.read_text(encoding="utf-8"))

    validated = validate_agent_recipe_config(payload)

    assert validated["id"] == recipe_id
    assert validated["requires_generated_audio"] is False


def test_generated_audio_requirement_cannot_be_attached_to_text_recipe():
    recipe_path = (
        Path(__file__).resolve().parents[1]
        / "src/novelvideo/freezone/agent_catalog/builtins/recipes/general-text.json"
    )
    payload = json.loads(recipe_path.read_text(encoding="utf-8"))
    payload["requires_generated_audio"] = True

    with pytest.raises(
        ValueError, match="requires_generated_audio requires output_kind=video"
    ):
        validate_agent_recipe_config(payload)


def test_text_recipe_rejects_second_stage_model_instruction():
    with pytest.raises(ValueError, match="must produce the final deliverable"):
        validate_agent_recipe_config(
            {
                "id": "invalid-text-recipe",
                "name": "Invalid text Recipe",
                "output_kind": "text",
                "action_keys": ["invalid-text-recipe"],
                "system_prompt": "Do not write it yourself; output only prompts that guide the LLM.",
                "planning_prompt": "Generate an outline",
                "result_summary": "Outline",
            }
        )


def test_authoring_guide_text_recipe_template_produces_final_deliverable():
    guide_path = (
        Path(__file__).resolve().parents[1]
        / ".hermes/skills/freezone/references/skill-studio-authoring-guide.md"
    )
    guide = guide_path.read_text(encoding="utf-8")
    text_recipe_section = guide.split("#### Text Recipe", 1)[1]
    system_prompt = text_recipe_section.split("```text", 1)[1].split("```", 1)[0].strip()

    validated = validate_agent_recipe_config(
        {
            "id": "guide-text-template",
            "name": "Guide text template",
            "output_kind": "text",
            "action_keys": ["guide-text-template"],
            "system_prompt": system_prompt,
            "planning_prompt": "Directly generate the final copy from the confirmed input.",
            "result_summary": "Final copy that can be delivered directly.",
        }
    )

    assert validated["output_kind"] == "text"
    assert "directly produce a deliverable final text" in validated["system_prompt"]


def test_retro_skill_keeps_entry_guard_out_of_recipe_runtime_constraints():
    skill_path = (
        Path(__file__).resolve().parents[1]
        / "src/novelvideo/freezone/agent_catalog/builtins/skills"
        / "retro-hong-kong-kungfu-comedy-video.json"
    )
    skill = json.loads(skill_path.read_text(encoding="utf-8"))

    constraints = recipe_runtime._skill_constraints(skill)
    compiled_constraints = "\n".join(constraints["hard_constraints"])

    assert "Please upload at least one character reference image or a line of text inspiration first" not in compiled_constraints
    assert "Pause and wait for the director's confirmation" not in compiled_constraints
    assert "Use the [Module Name] format for stage titles" not in constraints["prompt_guide"]
    assert "list the complete workflow in the draft at once" in skill["planning"]["planning_notes"]


def test_kungfu_shot_recipe_requires_per_shot_action_phases():
    recipe_path = (
        Path(__file__).resolve().parents[1]
        / "src/novelvideo/freezone/agent_catalog/builtins/recipes"
        / "anthropomorphic-kungfu-shot-video.json"
    )
    recipe = json.loads(recipe_path.read_text(encoding="utf-8"))
    prompt = recipe["system_prompt"]

    assert "for each core action of the current Shot, write out" in prompt
    assert "must not merely state a generic three-phase requirement" in prompt
    assert "each video node must itself contain" in prompt
    assert "Per-action anticipation/movement/completion" in recipe["must_have_items"]


def test_outdoor_stage_duel_character_elements_use_one_turnaround_reference():
    recipe_path = (
        Path(__file__).resolve().parents[1]
        / "src/novelvideo/freezone/agent_catalog/builtins/recipes"
        / "outdoor-stage-duel-key-elements.json"
    )
    recipe = json.loads(recipe_path.read_text(encoding="utf-8"))

    assert "front, side and back" in recipe["system_prompt"]
    assert "full-body three-view" in "\n".join(recipe["must_have_items"])


def test_outdoor_stage_duel_video_recipe_preserves_confirmed_beat_order():
    recipe_path = (
        Path(__file__).resolve().parents[1]
        / "src/novelvideo/freezone/agent_catalog/builtins/recipes"
        / "outdoor-stage-duel-shot-video.json"
    )
    recipe = json.loads(recipe_path.read_text(encoding="utf-8"))
    prompt = recipe["system_prompt"]

    assert "confirmed" in prompt and "Beat" in prompt
    assert "Beat 3 as the central peak collision with clear impact feedback; Beat 4 as the counterattack" not in prompt
    assert "keep the confirmed Storyboard / user order and actions beat by beat" in prompt
    assert "if no confirmed order is provided" in prompt
    assert "continuous handheld long take" in prompt
    assert "Three-layer composition" in prompt
    assert "First-person audience POV" in prompt
    assert "no visible phone body" in prompt
    assert "hard cuts" in prompt


def test_recipe_compiler_uses_the_dedicated_brainclaw_profile(monkeypatch):
    captured: dict[str, object] = {}

    def fake_model(model_env, default_model=None, **kwargs):
        captured.update(
            model_env=model_env,
            default_model=default_model,
            **kwargs,
        )
        return "model"

    class FakeAgent:
        def __init__(self, model, **kwargs):
            captured.update(model=model, agent_kwargs=kwargs)

        async def run(self, _task, **kwargs):
            captured.update(run_kwargs=kwargs)
            return SimpleNamespace(output="compiled prompt")

    from novelvideo import config

    monkeypatch.setattr(config, "get_newapi_text_pydantic_model", fake_model)
    monkeypatch.setattr(recipe_runtime, "Agent", FakeAgent)

    result = asyncio.run(recipe_runtime._run_recipe_compiler("compile this"))

    assert result.prompt == "compiled prompt"
    assert result.model_call_id.startswith("recipe-compiler:")
    assert result.executed_at > 0
    assert captured["brainclaw_profile"] is BrainClawProfile.FREEZONE_RECIPE_COMPILATION
    assert captured["run_kwargs"] == {
        "model_settings": {"openai_reasoning_effort": "low"}
    }


def test_recipe_compiler_reasoning_effort_is_configurable(monkeypatch):
    monkeypatch.setenv("FREEZONE_RECIPE_COMPILER_REASONING_EFFORT", "HIGH")

    assert recipe_runtime._recipe_compiler_reasoning_effort() == "high"


def test_recipe_compiler_reasoning_effort_rejects_unsupported_value(monkeypatch):
    monkeypatch.setenv("FREEZONE_RECIPE_COMPILER_REASONING_EFFORT", "none")

    with pytest.raises(
        recipe_runtime.RecipeRuntimeError,
        match="expected one of: high, low, max",
    ):
        recipe_runtime._recipe_compiler_reasoning_effort()


def test_build_recipe_compiler_task_checks_output_kind():
    with pytest.raises(recipe_runtime.RecipeRuntimeError, match="incompatible"):
        recipe_runtime.build_recipe_compiler_task(
            recipe={
                "id": "image-only",
                "output_kind": "image",
                "system_prompt": "refine",
            },
            node_kind="video",
            node_prompt="rotate product",
        )


def test_build_recipe_compiler_task_contains_runtime_context():
    task = recipe_runtime.build_recipe_compiler_task(
        recipe={"id": "scene", "output_kind": "image", "system_prompt": "commercial photography"},
        node_kind="image",
        node_prompt="Nordic kitchen",
        user_goal="Generate three coffee machine product images",
        upstream_text="Silver metal body",
        reference_media=[{"kind": "image", "label": "Product reference image"}],
        confirmed_inputs={"aspect_ratio": "9:16", "language": "zh"},
        skill_constraints={
            "hard_constraints": ["Do not invent product features", "No subtitles"],
            "prompt_guide": "Premium commercial photography",
        },
        skill_id="ecommerce",
        skill_version="2.1.0",
    )

    assert "commercial photography" in task
    assert "Nordic kitchen" in task
    assert "Silver metal body" in task
    assert "Product reference image" in task
    assert '"aspect_ratio": "9:16"' in task
    assert "Do not invent product features" in task
    assert "Premium commercial photography" in task
    assert '"version": "2.1.0"' in task


def test_get_skill_for_runtime_enforces_version_and_recipe_whitelist(monkeypatch):
    monkeypatch.setattr(
        recipe_runtime,
        "list_user_agent_config_items",
        lambda _username, kind: (
            [
                {
                    "id": "ecommerce",
                    "version": "2.1.0",
                    "allowed_recipe_ids": ["product-image"],
                }
            ]
            if kind == "skills"
            else []
        ),
    )

    skill = recipe_runtime.get_skill_for_runtime(
        username="local",
        skill_id="ecommerce",
        skill_version="2.1.0",
        recipe_id="product-image",
    )
    assert skill is not None

    with pytest.raises(recipe_runtime.RecipeRuntimeError, match="version mismatch"):
        recipe_runtime.get_skill_for_runtime(
            username="local",
            skill_id="ecommerce",
            skill_version="1.0.0",
            recipe_id="product-image",
        )
    with pytest.raises(recipe_runtime.RecipeRuntimeError, match="not allowed"):
        recipe_runtime.get_skill_for_runtime(
            username="local",
            skill_id="ecommerce",
            recipe_id="other-image",
        )


def test_combined_recipe_preserves_pipeline_order():
    combined = recipe_runtime._combined_recipe(
        [
            {
                "id": "shotlist",
                "name": "Storyboard method",
                "version": 1,
                "output_kind": "image",
                "system_prompt": "First settle the shot information.",
            },
            {
                "id": "lighting",
                "name": "Lighting method",
                "version": 2,
                "output_kind": "image",
                "system_prompt": "Then design the lighting.",
            },
        ]
    )

    assert combined["id"] == "shotlist+lighting"
    assert combined["system_prompt"].index("First settle the shot information") < combined[
        "system_prompt"
    ].index("Then design the lighting")


def test_recipe_compiler_priority_places_skill_before_recipe():
    assert (
        "confirmed inputs, Skill hard constraints"
        in recipe_runtime._RECIPE_COMPILER_SYSTEM_PROMPT
    )
    assert (
        "Recipe method, then defaults" in recipe_runtime._RECIPE_COMPILER_SYSTEM_PROMPT
    )


def test_build_recipe_compiler_task_limits_large_upstream_context():
    upstream = "A" * 20_000 + "B" * 20_000
    task = recipe_runtime.build_recipe_compiler_task(
        recipe={"id": "scene", "output_kind": "image", "system_prompt": "commercial photography"},
        node_kind="image",
        node_prompt="kitchen",
        upstream_text=upstream,
    )

    assert "[context truncated]" in task
    assert "A" * 100 in task
    assert "B" * 100 in task
    assert len(task) < 18_000


@pytest.mark.asyncio
async def test_compile_recipe_prompt_loads_server_recipe_and_returns_only_prompt(
    monkeypatch, tmp_path
):
    recipe_runtime._prompt_cache.clear()
    recipe_runtime._prompt_inflight.clear()
    monkeypatch.setattr(recipe_runtime, "OUTPUT_DIR", tmp_path)
    calls = 0
    monkeypatch.setattr(
        recipe_runtime,
        "get_recipe_for_runtime",
        lambda **_kwargs: {
            "id": "scene",
            "version": 1,
            "output_kind": "image",
            "system_prompt": "trusted internal method",
        },
    )

    class FakeAgent:
        def __init__(self, *_args, **_kwargs):
            pass

        async def run(self, task, **_kwargs):
            nonlocal calls
            calls += 1
            assert "trusted internal method" in task
            return SimpleNamespace(output="Final executable prompt")

    monkeypatch.setattr(recipe_runtime, "Agent", FakeAgent)
    monkeypatch.setattr(
        "novelvideo.config.get_newapi_text_pydantic_model",
        lambda *_args, **_kwargs: object(),
    )

    compiled = await recipe_runtime.compile_recipe_prompt_result(
        username="local",
        recipe_id="scene",
        recipe_version="1",
        node_kind="image",
        node_prompt="Kitchen scene",
    )
    cached = await recipe_runtime.compile_recipe_prompt_result(
        username="local",
        recipe_id="scene",
        recipe_version="1",
        node_kind="image",
        node_prompt="Kitchen scene",
    )

    assert compiled.prompt == "Final executable prompt"
    assert compiled.mode == "model"
    assert cached.prompt == compiled.prompt
    assert cached.mode == "memory_cache"
    assert calls == 1

    recipe_runtime._prompt_cache.clear()
    persisted = await recipe_runtime.compile_recipe_prompt_result(
        username="local",
        recipe_id="scene",
        recipe_version="1",
        node_kind="image",
        node_prompt="Kitchen scene",
    )
    assert persisted.prompt == compiled.prompt
    assert persisted.mode == "persistent_cache"
    assert calls == 1

    compatible_prompt = await recipe_runtime.compile_recipe_prompt(
        username="local",
        recipe_id="scene",
        recipe_version="1",
        node_kind="image",
        node_prompt="Kitchen scene",
    )
    assert compatible_prompt == compiled.prompt


@pytest.mark.asyncio
async def test_compile_recipe_prompt_deduplicates_concurrent_model_calls(
    monkeypatch, tmp_path
):
    recipe_runtime._prompt_cache.clear()
    recipe_runtime._prompt_inflight.clear()
    monkeypatch.setattr(recipe_runtime, "OUTPUT_DIR", tmp_path)
    monkeypatch.setattr(
        recipe_runtime,
        "get_recipe_for_runtime",
        lambda **_kwargs: {
            "id": "scene",
            "version": 1,
            "output_kind": "image",
            "system_prompt": "trusted internal method",
        },
    )
    calls = 0

    class FakeAgent:
        def __init__(self, *_args, **_kwargs):
            pass

        async def run(self, _task, **_kwargs):
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.01)
            return SimpleNamespace(output="Shared prompt")

    monkeypatch.setattr(recipe_runtime, "Agent", FakeAgent)
    monkeypatch.setattr(
        "novelvideo.config.get_newapi_text_pydantic_model",
        lambda *_args, **_kwargs: object(),
    )
    kwargs = {
        "username": "local",
        "recipe_id": "scene",
        "recipe_version": "1",
        "node_kind": "image",
        "node_prompt": "Kitchen scene",
    }

    results = await asyncio.gather(
        recipe_runtime.compile_recipe_prompt(**kwargs),
        recipe_runtime.compile_recipe_prompt(**kwargs),
    )

    assert results == ["Shared prompt", "Shared prompt"]
    assert calls == 1


@pytest.mark.asyncio
async def test_compile_recipe_prompt_uses_fallback_on_timeout_and_caches_late_result(
    monkeypatch,
    tmp_path,
):
    recipe_runtime._prompt_cache.clear()
    recipe_runtime._prompt_inflight.clear()
    monkeypatch.setattr(recipe_runtime, "OUTPUT_DIR", tmp_path)
    monkeypatch.setattr(
        recipe_runtime,
        "get_recipe_for_runtime",
        lambda **_kwargs: {
            "id": "scene",
            "version": 1,
            "output_kind": "image",
            "system_prompt": "Trusted product photography method",
        },
    )

    async def slow_compiler(_task: str) -> str:
        await asyncio.sleep(0.03)
        return "Refined prompt completed in the background"

    monkeypatch.setattr(recipe_runtime, "_run_recipe_compiler", slow_compiler)
    monkeypatch.setattr(
        recipe_runtime, "_recipe_compiler_timeout_seconds", lambda: 0.01
    )

    fallback_result = await recipe_runtime.compile_recipe_prompt_result(
        username="local",
        recipe_id="scene",
        recipe_version="1",
        node_kind="image",
        node_prompt="Kitchen scene",
        user_goal="Generate a coffee machine product image",
    )

    assert fallback_result.mode == "timeout_fallback"
    assert fallback_result.recipe_ids == ("scene",)
    assert "Generate a coffee machine product image" in fallback_result.prompt
    assert "Kitchen scene" in fallback_result.prompt
    assert "Trusted product photography method" in fallback_result.prompt

    await asyncio.sleep(0.04)
    assert recipe_runtime._prompt_inflight == {}
    assert "Refined prompt completed in the background" in recipe_runtime._prompt_cache.values()

    cached = await recipe_runtime.compile_recipe_prompt(
        username="local",
        recipe_id="scene",
        recipe_version="1",
        node_kind="image",
        node_prompt="Kitchen scene",
        user_goal="Generate a coffee machine product image",
    )
    assert cached == "Refined prompt completed in the background"


@pytest.mark.asyncio
async def test_compile_recipe_prompt_skips_model_for_deterministic_strategy(
    monkeypatch,
):
    monkeypatch.setattr(
        recipe_runtime,
        "get_recipe_for_runtime",
        lambda **_kwargs: {
            "id": "video",
            "output_kind": "video",
            "system_prompt": "refine video prompt",
        },
    )

    class UnexpectedAgent:
        def __init__(self, *_args, **_kwargs):
            raise AssertionError("deterministic strategy must not create an Agent")

    monkeypatch.setattr(recipe_runtime, "Agent", UnexpectedAgent)
    result = await recipe_runtime.compile_recipe_prompt(
        username="local",
        recipe_id="video",
        node_kind="video",
        node_prompt="The camera slowly pushes in",
        upstream_text="Product storyboard",
        prompt_strategy="previous_output",
    )

    assert result == "Product storyboard\n\nThe camera slowly pushes in"


@pytest.mark.asyncio
async def test_compile_recipe_prompt_batch_preserves_order_and_bounds_concurrency(
    monkeypatch,
):
    active = 0
    max_active = 0

    async def fake_compile(**kwargs):
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.01)
        active -= 1
        if kwargs["recipe_id"] == "broken":
            raise recipe_runtime.RecipeRuntimeError("invalid recipe")
        return recipe_runtime.RecipeCompileResult(
            prompt=f"compiled:{kwargs['recipe_id']}",
            mode="model",
            recipe_ids=(kwargs["recipe_id"],),
        )

    monkeypatch.setattr(recipe_runtime, "compile_recipe_prompt_result", fake_compile)
    outcomes = await recipe_runtime.compile_recipe_prompt_batch(
        [
            {"recipe_id": "first"},
            {"recipe_id": "broken"},
            {"recipe_id": "third"},
            {"recipe_id": "fourth"},
        ],
        concurrency=2,
    )

    assert max_active == 2
    assert isinstance(outcomes[0], recipe_runtime.RecipeCompileResult)
    assert outcomes[0].prompt == "compiled:first"
    assert isinstance(outcomes[1], recipe_runtime.RecipeRuntimeError)
    assert isinstance(outcomes[2], recipe_runtime.RecipeCompileResult)
    assert outcomes[2].prompt == "compiled:third"
    assert isinstance(outcomes[3], recipe_runtime.RecipeCompileResult)


def test_recipe_pipeline_rejects_explicit_conflicts(monkeypatch):
    recipes = {
        "base": {
            "id": "base",
            "output_kind": "image",
            "conflicts_with": [],
        },
        "overlay": {
            "id": "overlay",
            "output_kind": "image",
            "conflicts_with": ["base"],
        },
    }
    monkeypatch.setattr(
        recipe_runtime,
        "get_recipe_for_runtime",
        lambda recipe_id, **_kwargs: recipes[recipe_id],
    )

    with pytest.raises(recipe_runtime.RecipeRuntimeError, match="conflicts with"):
        recipe_runtime.get_recipe_pipeline_for_runtime(
            username="local",
            primary_recipe=recipes["base"],
            recipe_pipeline=["overlay"],
            node_kind="image",
        )


@pytest.mark.asyncio
async def test_generate_recipe_text_rejects_display_copy_that_drops_product_subject(monkeypatch):
    monkeypatch.setattr(
        recipe_runtime,
        "get_recipe_for_runtime",
        lambda **_kwargs: {
            "id": "general-text",
            "version": "1",
            "output_kind": "text",
            "system_prompt": "Generate display copy",
            "_catalog_source": "builtin",
        },
    )

    class FakeAgent:
        def __init__(self, *_args, **_kwargs):
            pass

        async def run(self, _task):
            return SimpleNamespace(output="A touch of blazing red lights up every morning.\nWarm texture, warmth spreading.")

    monkeypatch.setattr(recipe_runtime, "Agent", FakeAgent)
    monkeypatch.setattr(
        "novelvideo.config.get_newapi_text_pydantic_model",
        lambda *_args, **_kwargs: object(),
    )

    with pytest.raises(recipe_runtime.RecipeRuntimeError, match="product subject"):
        await recipe_runtime.generate_recipe_text(
            username="local",
            recipe_id="general-text",
            node_kind="text",
            node_prompt="Write two lines of display copy for the same bright red ceramic cup",
            user_goal="Two lines of red cup display copy, no title",
        )


@pytest.mark.asyncio
async def test_generate_recipe_text_executes_compiled_instruction(monkeypatch):
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        recipe_runtime,
        "get_recipe_for_runtime",
        lambda **_kwargs: {
            "id": "ecommerce-text-plan",
            "version": "1.0.0",
            "output_kind": "text",
            "system_prompt": "Generate a three-screen detail page plan",
            "_catalog_source": "builtin",
        },
    )

    class FakeAgent:
        def __init__(self, *_args, **_kwargs):
            pass

        async def run(self, task):
            assert "Generate a three-screen detail page plan" in task
            assert "Produce the final text deliverable now" in task
            return SimpleNamespace(output="# Detail page plan")

    monkeypatch.setattr(recipe_runtime, "Agent", FakeAgent)
    monkeypatch.setattr(
        "novelvideo.config.get_newapi_text_pydantic_model",
        lambda *args, **kwargs: captured.update(model_env=args[0], **kwargs)
        or object(),
    )

    result = await recipe_runtime.generate_recipe_text(
        username="local",
        recipe_id="ecommerce-text-plan",
        node_kind="text",
        node_prompt="coffee machine",
    )

    assert result == "# Detail page plan"
    assert captured["model_env"] == "FREEZONE_TEXT_WRITER_MODEL"
    assert captured["timeout_seconds_override"] == 540.0
    assert captured["capability"] == "freezone.text.generate"
    assert captured["brainclaw_profile"] is (
        BrainClawProfile.FREEZONE_RECIPE_TEXT_GENERATION
    )
    assert captured["brainclaw_profile_variant"] == BrainClawProfileVariant(
        "recipe/ecommerce-text-plan@1.0.0"
    )


@pytest.mark.asyncio
async def test_generate_recipe_text_omits_variant_for_user_recipe(monkeypatch):
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        recipe_runtime,
        "get_recipe_for_runtime",
        lambda **_kwargs: {
            "id": "private-recipe",
            "version": "1.0.0",
            "output_kind": "text",
            "system_prompt": "Generate body text",
            "_catalog_source": "user",
        },
    )

    class FakeAgent:
        def __init__(self, *_args, **_kwargs):
            pass

        async def run(self, _task):
            return SimpleNamespace(output="Body text")

    monkeypatch.setattr(recipe_runtime, "Agent", FakeAgent)
    monkeypatch.setattr(
        "novelvideo.config.get_newapi_text_pydantic_model",
        lambda *_args, **kwargs: captured.update(kwargs) or object(),
    )

    assert (
        await recipe_runtime.generate_recipe_text(
            username="local",
            recipe_id="private-recipe",
            node_kind="text",
            node_prompt="writing",
        )
        == "Body text"
    )
    assert captured["brainclaw_profile_variant"] is None


@pytest.mark.asyncio
@pytest.mark.parametrize("subject", ["red cup showcase", "blue ceramic vase showcase"])
async def test_music_compilation_keeps_original_creative_intent_when_model_generalizes(
    monkeypatch, tmp_path, subject
):
    recipe_runtime._prompt_cache.clear()
    recipe_runtime._prompt_inflight.clear()
    monkeypatch.setattr(recipe_runtime, "OUTPUT_DIR", tmp_path)
    monkeypatch.setattr(recipe_runtime, "get_recipe_for_runtime", lambda **kw: {
        "id": "drama-background-music", "version": 1, "output_kind": "audio",
        "system_prompt": "Describe mood, rhythm and instrumentation; output only the music generation instruction.",
    })
    calls = []

    async def generic_compiler(task):
        calls.append(task)
        return recipe_runtime.RecipeModelCompilation(
            "Light, warm product-showcase score led by marimba and soft drum beats; instrumental only, no vocals, no lyrics.",
            "compile-music-1", 123.0,
        )

    monkeypatch.setattr(recipe_runtime, "_run_recipe_compiler", generic_compiler)
    args = dict(
        username="local", recipe_id="drama-background-music", node_kind="audio",
        node_prompt=f"Generate a light instrumental piece for the {subject}, no vocals.",
        user_goal="Run the existing node, use the short-drama-quick Skill, add no new nodes, scope=canvas.",
    )
    result = await recipe_runtime.compile_recipe_prompt_result(**args)
    assert subject in result.prompt
    assert "marimba" in result.prompt and "no lyrics" in result.prompt
    assert "short-drama-quick" not in result.prompt
    assert "scope=canvas" not in result.prompt
    assert result.mode == "model"
    assert result.model_call_id == "compile-music-1"
    assert (await recipe_runtime.compile_recipe_prompt_result(**args)).prompt == result.prompt
    recipe_runtime._prompt_cache.clear()
    persisted = await recipe_runtime.compile_recipe_prompt_result(**args)
    assert persisted.mode == "persistent_cache"
    assert persisted.prompt == result.prompt
    assert len(calls) == 1
