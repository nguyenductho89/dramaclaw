"""Unit tests for the previs prompt templates (2026-11-10).

These prompts were ported out of
`previs_h3_test/scripts/skits/science_humor/gravity_test/gen_chains.py` so they
can be run from a Freezone image node. They carry MEASURED constants — camera
height, subject height, "the horizon passes through the subjects' chests" — that
came from measuring real generated frames, so the two flavours must say the same
thing and the Qwen one must pass the repo's own compose lint before any GPU time
is spent.

What each test is actually protecting:

- a template that exists in only one flavour silently changes meaning when the
  user switches image model;
- an unrendered `{slot}` reaching a model is a prompt that reads as literal
  braces, so a missing slot has to raise;
- the Qwen flavour has hard form rules (one paragraph, no double quotes, must
  contain "photorealistic", no aspect-ratio token) that are easy to break by
  editing the manifest and impossible to notice by eye.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from novelvideo.freezone import previs_templates as pt

# Enough slot values to render every template in the built-in manifest.
SLOTS = {
    "location": "the Apollo 11 landing site in 1969",
    "camera": "Eye-level camera, with the horizon two-thirds up the frame",
    "scale_notes": "The lunar module is 7 metres tall, four times a standing person.",
    "light": "Low white sunlight from behind the camera",
    "appearance": "a cheerful 70-year-old with a halo of frizzy white hair",
    "expression": "Friendly closed-mouth expression.",
    "subject_a": "Barnaby",
    "subject_b": "Ambrose",
    "large_object": "the lunar module",
    "large_object_height_m": "7",
    "large_object_multiple": "four",
}


@pytest.fixture(autouse=True)
def _clean_cache():
    pt.reset_previs_template_cache()
    yield
    pt.reset_previs_template_cache()


def _all_templates() -> list[dict]:
    return pt.load_previs_templates()


def test_every_template_has_both_flavours_and_a_known_category():
    templates = _all_templates()
    assert templates, "the built-in manifest must not be empty"
    for template in templates:
        assert template["category"] in pt.CATEGORIES
        assert template["prompt"]["gemini"].strip()
        assert template["prompt"]["qwen"].strip()


@pytest.mark.parametrize("flavor", ["gemini", "qwen"])
def test_every_template_renders_and_lints_clean(flavor):
    for template in _all_templates():
        n_images = max(1, len(template["reference_slots"]))
        prompt = pt.build_previs_prompt(
            template["id"], flavor=flavor, slots=SLOTS, reference_count=n_images
        )
        assert prompt.strip()
        issues = pt.lint_previs_prompt(prompt, flavor, n_images)
        assert issues == [], f"{template['id']} ({flavor}): {issues}"


def test_qwen_flavour_obeys_the_compose_form():
    """The rules `lint_qwen21_compose_prompt` enforces, asserted directly so a
    manifest edit that breaks them fails here rather than on a GPU."""
    prompt = pt.build_previs_prompt(
        "storyboard_two_subjects_in_location",
        flavor="qwen",
        slots=SLOTS,
        reference_count=3,
    )
    assert "\n" not in prompt
    assert '"' not in prompt
    assert "photorealistic" in prompt.lower()
    assert "<image1>" in prompt and "<image2>" in prompt and "<image3>" in prompt
    assert "16:9" not in prompt  # the output size comes from <image1>


def test_gemini_flavour_does_not_use_qwen_image_tags():
    prompt = pt.build_previs_prompt(
        "storyboard_two_subjects_in_location",
        flavor="gemini",
        slots=SLOTS,
        reference_count=3,
    )
    assert "<image" not in prompt
    assert "Image 1" in prompt


def test_measured_scale_sentences_reach_both_flavours():
    """The 2026-11-09 fix. Both flavours must carry the camera height, the subject
    height and the "do not shrink to fit the frame" rule — in Gemini's prose and in
    Qwen's tag form."""
    for flavor, needle in (("gemini", "Image 1"), ("qwen", "<image1>")):
        prompt = pt.build_previs_prompt(
            "storyboard_two_subjects_in_location",
            flavor=flavor,
            slots=SLOTS,
            reference_count=3,
        )
        assert "1.6 metres" in prompt
        assert "1.75 metres" in prompt
        assert "ground plane" in prompt
        assert "several times taller than a standing person" in prompt
        assert needle in prompt


def test_slots_can_be_overridden_per_request():
    prompt = pt.build_previs_prompt(
        "storyboard_two_subjects_in_location",
        flavor="gemini",
        slots={**SLOTS, "camera_height_m": "1.2", "subject_height_m": "2.1"},
        reference_count=3,
    )
    assert "1.2 metres" in prompt and "2.1 metres" in prompt
    assert "1.6 metres" not in prompt


def test_missing_slot_raises_instead_of_leaking_braces():
    with pytest.raises(pt.PrevisManifestError, match="location"):
        pt.build_previs_prompt("plate_empty_location", flavor="gemini", slots={})


def test_unknown_template_id_raises():
    with pytest.raises(pt.PrevisTemplateNotFound):
        pt.build_previs_prompt("no_such_template", flavor="gemini", slots=SLOTS)


def test_flavor_follows_the_provider():
    assert pt.previs_flavor_for_provider("runpod_qwen21_render") == "qwen"
    assert pt.previs_flavor_for_provider("runpod_qwen_edit") == "qwen"
    assert pt.previs_flavor_for_provider("gemini_webai") == "gemini"
    assert pt.previs_flavor_for_provider("newapi") == "gemini"
    assert pt.previs_flavor_for_provider(None) == "gemini"


def test_manifest_override_degrades_to_builtin(tmp_path: Path, monkeypatch, caplog):
    """A broken external manifest must not take the image endpoint down with it —
    same contract as the style gallery."""
    broken = tmp_path / "broken.json"
    broken.write_text("{ not json")
    monkeypatch.setenv(pt.MANIFEST_ENV, str(broken))
    pt.reset_previs_template_cache()

    assert _all_templates(), "must fall back to the built-in manifest"


def test_manifest_rejects_a_single_flavour_template(tmp_path: Path, monkeypatch):
    partial = tmp_path / "partial.json"
    partial.write_text(
        json.dumps(
            {
                "templates": [
                    {
                        "id": "x",
                        "label": "X",
                        "category": "plate",
                        "prompt": {"gemini": "only prose"},
                    }
                ]
            }
        )
    )
    with pytest.raises(pt.PrevisManifestError, match="prompt.gemini and prompt.qwen"):
        pt._read_manifest(partial)


def test_manifest_rejects_an_unknown_fragment(tmp_path: Path):
    bad = tmp_path / "bad.json"
    bad.write_text(
        json.dumps(
            {
                "templates": [
                    {
                        "id": "x",
                        "label": "X",
                        "category": "plate",
                        "fragments": ["not_a_real_fragment"],
                        "prompt": {"gemini": "a", "qwen": "b"},
                    }
                ]
            }
        )
    )
    with pytest.raises(pt.PrevisManifestError, match="unknown fragment"):
        pt._read_manifest(bad)


def test_merge_puts_the_template_first():
    """The Qwen flavour's `<imageN>` role sentences have to lead; a user note
    reads as an extra instruction after them, never in place of them."""
    # `route_helpers` imports `novelvideo.api.schemas`, whose package __init__
    # imports the routes that import route_helpers back — so let the api package
    # finish initialising first, exactly as `test_freezone_gemini_webai_provider`
    # does.
    import novelvideo.api.routes.freezone  # noqa: F401
    from novelvideo.freezone.route_helpers import merge_prompt_with_previs_template

    assert merge_prompt_with_previs_template("", "TEMPLATE") == "TEMPLATE"
    assert merge_prompt_with_previs_template("note", "") == "note"
    assert merge_prompt_with_previs_template("note", "TEMPLATE") == "TEMPLATE note"
