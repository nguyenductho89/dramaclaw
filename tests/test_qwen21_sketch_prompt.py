"""Qwen-Image 2.1 t2i sketch prompt (`runpod_qwen`, sketch mode, added
2026-10-31) — the pure prompt builder plus the real
`NanoBananaGridGenerator.generate_grid()` dispatch. No DB, no network, no GPU:
`_resolve_scene_prop_asset_refs` and `_call_runpod_qwen_image_api` are
monkeypatched, same pattern as `test_qwen21_compose_dispatch.py`.

Regression target: the shared Gemini storyboard-grid prompt (~15k chars,
"MANDATORY GRID FORMAT") made Qwen draw a numbered multi-cell sheet with
gibberish text and dozens of stick figures (YuiDrama beats 10-14).
"""

from __future__ import annotations

import pytest
from PIL import Image

from novelvideo.generators import nanobanana_grid as grid
from novelvideo.generators.prompt_builder import build_qwen21_sketch_prompt
from novelvideo.utils.asset_resolver import ResolvedAssetRef

ORANGE = "#FF6B00 FLUORESCENT ORANGE"
CYAN = "#00FFFF FLUORESCENT CYAN"

BEAT = {
    "beat_number": 12,
    "visual_description": (
        "{{Yui_edo_kosode}} steps back out through the [[dark blue noren curtain]], "
        "now dressed in an [[indigo cotton kosode robe]], her hair gathered into a low bun."
    ),
    "detected_identities": ["Yui_edo_kosode"],
}


def _prompt(beat=BEAT, colors=None, has_scene_ref=True) -> str:
    return build_qwen21_sketch_prompt(
        beat,
        identity_colors={"Yui_edo_kosode": ORANGE} if colors is None else colors,
        has_scene_ref=has_scene_ref,
    )


def test_prompt_has_no_grid_or_panel_wording():
    text = _prompt().lower()
    # The only allowed mention is the closing "no grid, no panels" negation.
    stripped = text.replace("no grid, no panels, no borders", "")
    for banned in ("grid", "panel", "storyboard grid", "rows", "columns", "16"):
        assert banned not in stripped, banned


def test_prompt_is_short_and_has_no_tag_codes():
    text = _prompt()
    assert len(text) < 1500
    assert "[YUI" not in text and "{{" not in text and "[[" not in text
    assert "<image" not in text  # single input image: official rule says no tags


def test_markers_replaced_and_color_applied():
    text = _prompt()
    assert "the fluorescent orange figure steps back out" in text
    assert "dark blue noren curtain" in text
    assert "(#FF6B00)" in text
    assert "ignore any clothing, hair or accessory details" in text


def test_scene_reference_changes_the_opening_sentence():
    with_scene = _prompt(has_scene_ref=True)
    without = _prompt(has_scene_ref=False)
    assert with_scene.startswith("Redraw the location in the image")
    assert "in the image" not in without.split("The people")[0]


def test_two_characters_list_both_colors():
    beat = {
        "visual_description": "{{A}} talks to {{B}}.",
        "detected_identities": ["A", "B"],
    }
    text = build_qwen21_sketch_prompt(
        beat, identity_colors={"A": ORANGE, "B": CYAN}, has_scene_ref=True
    )
    assert "the fluorescent orange figure talks to the fluorescent cyan figure" in text
    assert "(#FF6B00)" in text and "(#00FFFF)" in text
    assert "The people are plain featureless mannequins" in text
    assert "Fill each one's head and body" in text


def test_single_character_uses_singular_wording():
    text = _prompt()
    assert "The person is a plain featureless mannequin" in text
    assert "Fill its head and body" in text


def test_identity_without_color_is_gray():
    beat = {"visual_description": "{{Nobody}} waits.", "detected_identities": ["Nobody"]}
    text = build_qwen21_sketch_prompt(beat, identity_colors={}, has_scene_ref=False)
    assert "a gray figure waits" in text
    assert "gray featureless mannequin" in text


@pytest.mark.parametrize(
    "description, expected, absent",
    [
        # beat 11: expression clause dropped, facing clause kept
        (
            "{{Yui_edo_kosode}} stands just inside the shop doorway, a resigned look "
            "on her face, speaking as she looks back toward the entrance.",
            "stands just inside the shop doorway, speaking as she looks back toward the entrance",
            ("resigned", "face"),
        ),
        # beat 12: outfit / hair / bracelet clauses dropped
        (
            "{{Yui_edo_kosode}} steps back out through the [[dark blue noren curtain]], "
            "now dressed in an [[indigo cotton kosode robe]] tied with a [[red obi sash]], "
            "her hair gathered into a low bun, the [[red kumihimo cord bracelet]] still "
            "visible on her left wrist.",
            "steps back out through the dark blue noren curtain",
            ("kosode", "obi", "bun", "bracelet", "dressed"),
        ),
        # beat 13: two moments -> first one only
        (
            "{{Yui_edo_kosode}} stands at the cloth shop doorway holding her [[phone]] up "
            "in a selfie pose, then tilts it downward to show off her new indigo cotton "
            "kosode robe and red obi sash.",
            "stands at the cloth shop doorway holding her phone up in a selfie pose",
            ("tilts", "kosode", "sash"),
        ),
        # beat 14: keeps the pose clauses, drops wearing + bracelet
        (
            "{{Yui_edo_kosode}} stands in the cloth shop doorway, still holding her [[phone]] "
            "up, wearing the indigo cotton kosode robe with a red obi sash, the red kumihimo "
            "cord bracelet on her left wrist, her head tilted playfully as she speaks.",
            "stands in the cloth shop doorway, still holding her phone up, her head tilted "
            "playfully as she speaks",
            ("wearing", "kosode", "bracelet"),
        ),
    ],
)
def test_action_keeps_first_moment_and_drops_outfit_and_expression(description, expected, absent):
    beat = {"visual_description": description, "detected_identities": ["Yui_edo_kosode"]}
    text = build_qwen21_sketch_prompt(
        beat, identity_colors={"Yui_edo_kosode": ORANGE}, has_scene_ref=True
    )
    action = text.split("Action: ")[1].split(". Use this only")[0]
    assert action == f"the fluorescent orange figure {expected}"
    for word in absent:
        assert word not in action, word


def test_first_clause_is_kept_even_if_it_mentions_an_accessory():
    beat = {
        "visual_description": "The red cord bracelet on {{Yui_edo_kosode}}'s left wrist "
        "catches the light, then glows faintly.",
        "detected_identities": ["Yui_edo_kosode"],
    }
    text = build_qwen21_sketch_prompt(
        beat, identity_colors={"Yui_edo_kosode": ORANGE}, has_scene_ref=True
    )
    assert "Action: The red cord bracelet" in text and "glows" not in text


def test_no_instruction_invites_extra_people_or_colored_objects():
    text = _prompt()
    assert "Any other person is a plain gray mannequin" not in text
    assert "Draw only the people named in the action" in text
    assert "never filled with any color or tint" in text
    assert "blank oval head with no facial features or expression" in text


def test_no_character_beat_does_not_crash():
    beat = {
        "visual_description": "Haze drifts over the rooftops.",
        "detected_identities": ["__NO_CHARACTER__"],
    }
    text = build_qwen21_sketch_prompt(beat, identity_colors={}, has_scene_ref=True)
    assert "Haze drifts over the rooftops" in text
    assert "no text, letters or numbers" in text


# --- dispatch through generate_grid ---------------------------------------


def _make_png(path) -> str:
    Image.new("RGB", (64, 64), (200, 200, 200)).save(path, format="PNG")
    return str(path)


def _generator() -> grid.NanoBananaGridGenerator:
    return grid.NanoBananaGridGenerator(
        api_key="test-key",
        config={
            "provider": "runpod_qwen",
            "api_key": "test-key",
            "model": "qwen-image-2.1",
            "rows": 1,
            "cols": 1,
            "batch_size": 1,
            "total_panels": 1,
            "mode": "1x1",
        },
    )


def _patch_scene_refs(monkeypatch, master: str, reverse: str):
    refs = [
        ResolvedAssetRef(
            asset_type="scene",
            base_id="shop",
            variant_id=None,
            image_paths=[master, reverse],
            text_description="",
            source_level="scene_master",
        )
    ]
    monkeypatch.setattr(grid, "_resolve_scene_prop_asset_refs", lambda *a, **k: ({1: refs}, {}))


@pytest.mark.asyncio
async def test_generate_grid_uses_short_prompt_and_single_reference(tmp_path, monkeypatch):
    master = _make_png(tmp_path / "master.png")
    reverse = _make_png(tmp_path / "reverse.png")
    _patch_scene_refs(monkeypatch, master, reverse)
    captured: dict = {}

    async def fake_call(**kwargs):
        captured.update(kwargs)
        return b"fake-png", "", ""

    monkeypatch.setattr(grid, "_call_runpod_qwen_image_api", fake_call)

    character_map = {
        "Yui": {
            "name": "Yui",
            "appearance_details": "",
            "identities": [{"identity_name": "Yui_edo_kosode"}],
            "identity_sketch_colors": {"edo_kosode": ORANGE},
            "sketch_color": ORANGE,
        }
    }
    result = await _generator().generate_grid(
        beats=[dict(BEAT)],
        character_map=character_map,
        style="chinese_period_drama",
        output_path=str(tmp_path / "out" / "sketch.png"),
        rows=1,
        cols=1,
        sketch=True,
        sketch_colors={"Yui_edo_kosode": ORANGE},
        mode_key="1x1_2-3_sketch",
    )

    assert result.success is True, result.error
    assert len(captured["prompt"]) < 1500
    assert "MANDATORY GRID FORMAT" not in captured["prompt"]
    assert "the fluorescent orange figure" in captured["prompt"]
    # master only: the reverse view is dropped so the prompt can stay tag-free
    assert len(captured["reference_images"]) == 1
    name, data, _mime = captured["reference_images"][0]
    assert name.startswith("ref_0") and data  # recompressed by the ref loader


@pytest.mark.asyncio
async def test_generate_grid_rejects_multi_panel_sketch(tmp_path, monkeypatch):
    master = _make_png(tmp_path / "master.png")
    reverse = _make_png(tmp_path / "reverse.png")
    _patch_scene_refs(monkeypatch, master, reverse)
    called = False

    async def fake_call(**kwargs):
        nonlocal called
        called = True
        return b"fake-png", "", ""

    monkeypatch.setattr(grid, "_call_runpod_qwen_image_api", fake_call)

    generator = grid.NanoBananaGridGenerator(
        api_key="test-key",
        config={
            "provider": "runpod_qwen",
            "api_key": "test-key",
            "model": "qwen-image-2.1",
            "rows": 2,
            "cols": 2,
            "batch_size": 4,
            "total_panels": 4,
            "mode": "2x2",
        },
    )
    result = await generator.generate_grid(
        beats=[dict(BEAT, beat_number=n) for n in (10, 11, 12, 13)],
        character_map={},
        style="chinese_period_drama",
        output_path=None,
        rows=2,
        cols=2,
        sketch=True,
        sketch_colors={},
        mode_key="2x2_2-3_sketch",
    )

    assert result.success is False
    assert "single-beat 1x1" in result.error
    assert called is False
