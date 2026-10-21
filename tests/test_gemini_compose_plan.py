"""Unit tests for `generators/nanobanana_grid._build_gemini_compose_plan()`
and `generators/prompt_builder.build_gemini_compose_prompt()` — Gemini
WebAI's sketch-free "compose" render mode (`gemini_webai_compose`, added
2026-10-21), mirroring the Qwen-Image 2.1 compose mode
(`runpod_qwen21_compose`, `tests/test_qwen21_compose_plan.py`). Both share
`_resolve_compose_references()` for reference-gathering (covered by the
Qwen test file's existing cases: ordering, filename collisions, missing
scene, uncovered-prop text, the 16-image cap, crop on/off) — this file
only covers what's actually DIFFERENT for Gemini: the plain "Image N"
prompt phrasing instead of Qwen's `<imageN>` tags, and that the plan
builder wires the Gemini prompt builder, not Qwen's.

Real tiny PNGs on disk via PIL/`tmp_path`, no DB, no network, no GPU
calls — same methodology as the Qwen compose tests. Not yet verified
against a real Gemini WebAI render (2026-10-21, user-confirmed scope:
code + unit tests only for this change)."""

from __future__ import annotations

import pytest
from PIL import Image

from novelvideo.generators import nanobanana_grid as grid
from novelvideo.generators.prompt_builder import build_gemini_compose_prompt
from novelvideo.utils.asset_resolver import ResolvedAssetRef


def _make_png(path, size=(64, 64), color=(10, 20, 30)):
    img = Image.new("RGB", size, color)
    img.save(path, format="PNG")
    return str(path)


def _scene_ref(path: str, base_id: str = "park") -> ResolvedAssetRef:
    return ResolvedAssetRef(
        asset_type="scene",
        base_id=base_id,
        variant_id=None,
        image_paths=[path],
        text_description="",
        source_level="scene_master",
    )


def _prop_ref(path: str, base_id: str) -> ResolvedAssetRef:
    return ResolvedAssetRef(
        asset_type="prop",
        base_id=base_id,
        variant_id=None,
        image_paths=[path],
        text_description="",
        source_level="prop_reference",
    )


def _character_map_for(tmp_path, char_name: str) -> dict:
    portrait = _make_png(tmp_path / f"{char_name}_portrait.png")
    return {
        char_name: {
            "name": char_name,
            "portrait_path": portrait,
            "appearance_details": "",
            "identities": [],
        }
    }


def test_reference_order_is_scene_then_identities_then_props(tmp_path):
    scene_path = _make_png(tmp_path / "scene.png", size=(200, 100))
    nam_map = _character_map_for(tmp_path, "Nam")
    ryan_portrait = _make_png(tmp_path / "ryan_portrait.png")
    nam_map["Ryan"] = {
        "name": "Ryan",
        "portrait_path": ryan_portrait,
        "appearance_details": "",
        "identities": [],
    }
    bucket_path = _make_png(tmp_path / "bucket.png")

    beat = {
        "visual_description": "{{Nam}} holds a [[bucket]] near {{Ryan}}.",
        "detected_identities": ["Nam", "Ryan"],
        "detected_props": ["bucket"],
    }
    scene_refs = {1: [_scene_ref(scene_path)]}
    prop_refs = {1: [_prop_ref(bucket_path, "bucket")]}

    plan, err = grid._build_gemini_compose_plan(
        beat=beat,
        character_map=nam_map,
        scene_refs=scene_refs,
        prop_refs=prop_refs,
        mode_key=None,
    )
    assert plan is not None, err
    assert len(plan.reference_images) == 4
    assert plan.reference_images[0][1] == open(scene_path, "rb").read()
    kinds = [r["kind"] for r in plan.audit_refs]
    assert kinds == ["scene", "identity", "identity", "prop"]


def test_prompt_uses_plain_image_n_not_qwen_tags(tmp_path):
    scene_path = _make_png(tmp_path / "scene.png")
    character_map = _character_map_for(tmp_path, "Nam")
    beat = {
        "visual_description": "{{Nam}} stands.",
        "detected_identities": ["Nam"],
        "detected_props": [],
    }
    plan, err = grid._build_gemini_compose_plan(
        beat=beat,
        character_map=character_map,
        scene_refs={1: [_scene_ref(scene_path)]},
        prop_refs={},
        mode_key=None,
    )
    assert plan is not None, err
    # Gemini phrasing: "Image 1"/"Image 2", never Qwen's "<image1>" tags.
    assert "Image 1" in plan.prompt
    assert "Image 2" in plan.prompt
    assert "<image1>" not in plan.prompt
    assert "<image2>" not in plan.prompt


def test_missing_scene_image_returns_error():
    beat = {"visual_description": "Empty park.", "detected_identities": [], "detected_props": []}
    plan, err = grid._build_gemini_compose_plan(
        beat=beat, character_map={}, scene_refs={}, prop_refs={}, mode_key=None
    )
    assert plan is None
    assert err
    assert "Gemini WebAI" in err


def test_prop_without_image_excluded_from_images_but_kept_in_text(tmp_path):
    scene_path = _make_png(tmp_path / "scene.png")
    beat = {
        "visual_description": "{{Nam}} looks for a [[shovel]] in the sandbox.",
        "detected_identities": ["Nam"],
        "detected_props": ["shovel"],
    }
    character_map = _character_map_for(tmp_path, "Nam")
    plan, err = grid._build_gemini_compose_plan(
        beat=beat,
        character_map=character_map,
        scene_refs={1: [_scene_ref(scene_path)]},
        prop_refs={},
        mode_key=None,
    )
    assert plan is not None, err
    assert len(plan.reference_images) == 2  # scene + Nam only
    assert "shovel" in plan.prompt
    assert not any(r["kind"] == "prop" for r in plan.audit_refs)


def test_more_than_16_total_references_are_capped(tmp_path):
    scene_path = _make_png(tmp_path / "scene.png")
    character_map = _character_map_for(tmp_path, "Nam")
    prop_entries = []
    prop_ids = []
    for i in range(20):
        p = _make_png(tmp_path / f"prop_{i}.png")
        prop_entries.append(_prop_ref(p, f"prop{i}"))
        prop_ids.append(f"prop{i}")
    beat = {
        "visual_description": "{{Nam}} stands surrounded by props.",
        "detected_identities": ["Nam"],
        "detected_props": prop_ids,
    }
    plan, err = grid._build_gemini_compose_plan(
        beat=beat,
        character_map=character_map,
        scene_refs={1: [_scene_ref(scene_path)]},
        prop_refs={1: prop_entries},
        mode_key=None,
    )
    assert plan is not None, err
    assert len(plan.reference_images) <= 16


class TestBuildGeminiComposePromptDirectly:
    """Direct tests of `build_gemini_compose_prompt` (no file I/O), mirror
    of the punctuation-collision regression tests already proven for
    Qwen's version — the marker-substitution logic is copied verbatim
    from there, so the same two real bugs (double comma, double article)
    must stay fixed here too."""

    def test_no_double_comma_when_source_text_has_comma_right_after_marker(self):
        beat = {"visual_description": "{{Ryan}}, smiling."}
        prompt = build_gemini_compose_prompt(
            beat,
            identity_images=[("Ryan", "Ryan")],
            prop_images=[],
            identity_names={"Ryan": "Ryan"},
            prop_names={},
        )
        assert ",," not in prompt
        assert "Ryan (matching Image 2 exactly), smiling" in prompt

    def test_no_double_article_when_source_text_already_has_one(self):
        beat = {"visual_description": "holding up a [[bucket]]"}
        prompt = build_gemini_compose_prompt(
            beat,
            identity_images=[],
            prop_images=[("bucket", "bucket")],
            identity_names={},
            prop_names={"bucket": "bucket"},
        )
        assert "a the" not in prompt
        assert "holding up a bucket (shown in Image 2)" in prompt

    def test_single_image_no_tags_at_all(self):
        prompt = build_gemini_compose_prompt(
            {"visual_description": "An empty park."},
            identity_images=[],
            prop_images=[],
            identity_names={},
            prop_names={},
        )
        assert "Image 1" not in prompt
        assert "No people appear" in prompt
