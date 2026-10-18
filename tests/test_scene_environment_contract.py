"""The 360 environment contract: what counts as one, and what to do otherwise.

The validator used to require each heading at the start of a line. Models emit
the whole contract on one line, so every scene in every project was failing
validation and being replaced with generated boilerplate — which then quoted
the rejected description back as its own source evidence.
"""

from __future__ import annotations

import pytest

from novelvideo.cognee.pipeline import (
    SCENE_FALLBACK_FINGERPRINT_EN,
    _ensure_directional_environment_prompt,
    _has_required_scene_environment_headings,
    normalize_scene_environment_prompt,
    should_repair_scene_placeholder,
)

SINGLE_LINE = (
    "Front: The main wall is flat and plain, with the unit emblem hung in the center and a desk below. "
    "Left: A light solid wall connects front to back, with a frosted-glass wooden door near the front. "
    "Right: The wall extends to the rear, with a large window and venetian blinds. "
    "Back: The wall opposite the main wall is complete and flat, with a built-in filing cabinet. "
    "Lighting: Stable daytime ambient light from the window and ceiling lamps. "
    "Material/Style: Plain walls and wooden furniture of an office space. "
    "Forbidden elements: No people or temporary props."
)

MULTI_LINE = "Front: a\nLeft: b\nRight: c\nBack: d"


def test_a_single_line_contract_is_accepted():
    """This is what the model actually produces, and it was being thrown away."""
    assert _has_required_scene_environment_headings(SINGLE_LINE)


def test_a_single_line_contract_is_stored_one_section_per_line():
    normalized = normalize_scene_environment_prompt(SINGLE_LINE)
    assert normalized.splitlines()[0].startswith("Front:")
    assert len(normalized.splitlines()) == 7
    # The description survives; only its shape changes.
    assert "frosted-glass wooden door" in normalized
    assert "built-in filing cabinet" in normalized


def test_an_already_sectioned_contract_is_unchanged():
    assert _has_required_scene_environment_headings(MULTI_LINE)
    assert normalize_scene_environment_prompt(MULTI_LINE) == MULTI_LINE


@pytest.mark.parametrize(
    ("label", "prompt"),
    [
        ("missing one direction", "Front: a. Left: b. Right: c."),
        ("directions out of order", "Front: a. Right: c. Left: b. Back: d."),
        ("empty section", "Front: a. Left: . Right: c. Back: d."),
        ("only mentioned in the body", "Front: the room Left: has a window, Right: has a door, Back: is a wall"),
        ("not a contract at all", "A quiet office."),
        ("empty string", ""),
    ],
)
def test_text_that_is_not_a_contract_is_rejected(label, prompt):
    """Presence of the words is not enough; each must open a real section."""
    assert not _has_required_scene_environment_headings(prompt), label


def test_a_valid_contract_reaches_storage_intact():
    kept = _ensure_directional_environment_prompt(
        prompt=SINGLE_LINE,
        scene_name="Director's Office",
        scene_type="interior",
        time_of_day="",
        context_lines=["Zhang Bingquan sits behind the desk reading documents."],
    )
    assert "frosted-glass wooden door" in kept
    assert SCENE_FALLBACK_FINGERPRINT_EN not in kept


def test_the_fallback_never_quotes_the_rejected_prompt():
    """Quoting a rejected description back made the contract cite itself."""
    rejected = "This room is quiet and has no directional description."
    generated = _ensure_directional_environment_prompt(
        prompt=rejected,
        scene_name="Director's Office",
        scene_type="interior",
        time_of_day="",
        context_lines=["Zhang Bingquan sits behind the desk reading documents."],
    )
    assert SCENE_FALLBACK_FINGERPRINT_EN in generated
    assert rejected not in generated
    # Evidence comes from the script instead.
    assert "reading documents" in generated


def test_the_fallback_still_applies_without_any_usable_text():
    generated = _ensure_directional_environment_prompt(
        prompt="",
        scene_name="Director's Office",
        scene_type="interior",
        time_of_day="",
        context_lines=[],
    )
    assert SCENE_FALLBACK_FINGERPRINT_EN in generated


def test_english_fallback_keeps_fixed_headings_but_uses_english_bodies():
    generated = _ensure_directional_environment_prompt(
        prompt="",
        scene_name="Central Library",
        scene_type="interior",
        time_of_day="",
        context_lines=["Maya walks between the shelves."],
        output_language="en",
    )

    assert generated.startswith("Front: Use the main entrance")
    assert "Left: From the front-facing view" in generated
    assert "Maya walks between the shelves" in generated


# ── the repair predicate both tracks share ──────────────────────────────────

PLACEHOLDER = _ensure_directional_environment_prompt(
    prompt="",
    scene_name="Director's Office",
    scene_type="interior",
    time_of_day="",
    context_lines=["Zhang Bingquan sits behind the desk reading documents."],
)


def test_boilerplate_is_replaced_by_a_valid_contract():
    assert should_repair_scene_placeholder(PLACEHOLDER, SINGLE_LINE)


def test_a_prompt_a_user_wrote_is_never_touched():
    """Only prompts this code generated carry the fingerprint."""
    assert not should_repair_scene_placeholder(SINGLE_LINE, MULTI_LINE)
    assert not should_repair_scene_placeholder("A scene description I wrote myself", SINGLE_LINE)


def test_boilerplate_is_not_churned_into_more_boilerplate():
    assert not should_repair_scene_placeholder(PLACEHOLDER, PLACEHOLDER)


@pytest.mark.parametrize("replacement", ["", "   ", "Front: a", "A description without sections"])
def test_boilerplate_is_never_replaced_by_something_worse(replacement):
    """A malformed or empty model response must not overwrite what is stored."""
    assert not should_repair_scene_placeholder(PLACEHOLDER, replacement)
