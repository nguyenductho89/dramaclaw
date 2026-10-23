"""Unit tests for the 2026-10-22 additions to
`generators/prompt_builder.build_qwen21_compose_prompt()`/
`build_gemini_compose_prompt()` — `prop_descriptions`, `subject_scale`,
`staging`, and the always-on identity-sheet/scale/no-extra-objects
sentences. See `.claude/CLAUDE.md`'s "Parkun" entry for the real renders
that motivated these. No DB, no network, no LLM/GPU calls."""

from __future__ import annotations

import pytest

from novelvideo.agents.qwen21_compose_prompt_lint import lint_qwen21_compose_prompt
from novelvideo.generators.prompt_builder import (
    build_gemini_compose_prompt,
    build_qwen21_compose_prompt,
)

BUILDERS = [build_qwen21_compose_prompt, build_gemini_compose_prompt]


def _beat(visual_description: str) -> dict:
    return {"visual_description": visual_description}


@pytest.mark.parametrize("builder", BUILDERS)
def test_missing_prop_gets_its_text_description(builder):
    beat = _beat("{{Nam}} stands beside the [[toy wall]].")
    prompt = builder(
        beat,
        identity_images=[("Nam", "Nam")],
        prop_images=[],  # toy wall has no reference image yet
        identity_names={"Nam": "Nam"},
        prop_names={"toy wall": "toy wall"},
        prop_descriptions={
            "toy wall": "low wall built of chunky colorful plastic toy bricks, five bricks high"
        },
    )
    assert "The toy wall is low wall built of chunky colorful plastic toy bricks" in prompt


@pytest.mark.parametrize("builder", BUILDERS)
def test_imaged_prop_still_gets_its_size_detail_inline(builder):
    beat = _beat("{{Nam}} holds a [[bucket]].")
    prompt = builder(
        beat,
        identity_images=[("Nam", "Nam")],
        prop_images=[("bucket", "bucket")],
        identity_names={"Nam": "Nam"},
        prop_names={"bucket": "bucket"},
        prop_descriptions={"bucket": "small red plastic bucket, about the size of a child's hand"},
    )
    assert "It is small red plastic bucket, about the size of a child's hand." in prompt


@pytest.mark.parametrize("builder", BUILDERS)
def test_missing_prop_lines_absent_when_no_prop_descriptions_given(builder):
    # Backward-compat: a beat naming an unimaged prop, but with no
    # `prop_descriptions` supplied at all, must not fabricate a
    # description sentence for it.
    beat = _beat("{{Nam}} stands beside the [[toy wall]].")
    prompt = builder(
        beat,
        identity_images=[("Nam", "Nam")],
        prop_images=[],
        identity_names={"Nam": "Nam"},
        prop_names={"toy wall": "toy wall"},
    )
    assert "The toy wall is" not in prompt


@pytest.mark.parametrize("builder", BUILDERS)
def test_subject_scale_hint_attached_to_right_identity(builder):
    beat = _beat("{{Nam}} and {{Ryan}} stand together.")
    prompt = builder(
        beat,
        identity_images=[("Nam", "Nam"), ("Ryan", "Ryan")],
        prop_images=[],
        identity_names={"Nam": "Nam", "Ryan": "Ryan"},
        subject_scale=[("Nam", "a small toddler build with round cheeks")],
    )
    assert "Nam has a small toddler build with round cheeks." in prompt
    # Ryan has no scale hint given — must not invent one.
    assert "Ryan has" not in prompt


@pytest.mark.parametrize("builder", BUILDERS)
def test_identity_sheet_note_present_for_every_imaged_identity(builder):
    beat = _beat("{{Nam}} stands.")
    prompt = builder(
        beat,
        identity_images=[("Nam", "Nam")],
        prop_images=[],
        identity_names={"Nam": "Nam"},
    )
    assert "the same single person, not different people" in prompt


@pytest.mark.parametrize("builder", BUILDERS)
def test_scale_and_no_extra_objects_notes_always_present_with_images(builder):
    beat = _beat("{{Nam}} stands.")
    prompt = builder(
        beat,
        identity_images=[("Nam", "Nam")],
        prop_images=[],
        identity_names={"Nam": "Nam"},
    )
    assert "real-world scale" in prompt
    assert "Do not add any object" in prompt


@pytest.mark.parametrize("builder", BUILDERS)
def test_scale_and_no_extra_objects_notes_present_in_background_only_branch(builder):
    beat = _beat("The park sits empty.")
    prompt = builder(
        beat,
        identity_images=[],
        prop_images=[],
        identity_names={},
    )
    assert "real-world scale" in prompt
    assert "Do not add any object" in prompt


@pytest.mark.parametrize("builder", BUILDERS)
def test_staging_camera_blocking_and_set_dressing_lines(builder):
    beat = _beat("{{Nam}} and {{Ryan}} talk.")
    staging = {
        "camera": "eye-level medium-wide shot",
        "blocking": {"Ryan": "Ryan stands on the right side of frame."},
        "set_dressing": [{"placement_note": "The toy wall sits between them."}],
        "scale_note": "Both children are the same small toddler height.",
    }
    prompt = builder(
        beat,
        identity_images=[("Nam", "Nam"), ("Ryan", "Ryan")],
        prop_images=[],
        identity_names={"Nam": "Nam", "Ryan": "Ryan"},
        staging=staging,
    )
    assert "Camera: eye-level medium-wide shot." in prompt
    assert "Ryan stands on the right side of frame." in prompt
    assert "The toy wall sits between them." in prompt
    assert "Both children are the same small toddler height." in prompt


@pytest.mark.parametrize("builder", BUILDERS)
def test_no_staging_is_a_silent_no_op(builder):
    beat = _beat("{{Nam}} stands.")
    prompt = builder(
        beat,
        identity_images=[("Nam", "Nam")],
        prop_images=[],
        identity_names={"Nam": "Nam"},
        staging=None,
    )
    assert "Camera:" not in prompt


def test_qwen_prompt_with_all_extras_still_lints_clean():
    beat = _beat("{{Nam}} stands beside the [[toy wall]] facing {{Ryan}}.")
    prompt = build_qwen21_compose_prompt(
        beat,
        identity_images=[("Nam", "Nam"), ("Ryan", "Ryan")],
        prop_images=[],
        identity_names={"Nam": "Nam", "Ryan": "Ryan"},
        prop_names={"toy wall": "toy wall"},
        prop_descriptions={"toy wall": "low wall of colorful plastic bricks"},
        subject_scale=[("Nam", "a small toddler build"), ("Ryan", "a small toddler build")],
        staging={
            "camera": "eye-level medium-wide shot",
            "blocking": {"Nam": "Nam stands on the left.", "Ryan": "Ryan stands on the right."},
            "set_dressing": [{"placement_note": "The toy wall sits between them."}],
            "scale_note": "",
        },
    )
    issues = lint_qwen21_compose_prompt(prompt, n_images=3)
    assert issues == [], issues
