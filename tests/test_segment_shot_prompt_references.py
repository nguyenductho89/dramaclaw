"""Multishot chain prompts: per-shot subjects, first frame only on shot 1, and
the lint's explicit expected-picture override."""

from __future__ import annotations

from novelvideo.agents.minimax_h3_prompt_builder import (
    MiniMaxH3BeatContext,
    MiniMaxH3Content,
    MiniMaxH3Reference,
    assemble_minimax_h3_prompt,
)
from novelvideo.agents.minimax_h3_prompt_lint import lint_minimax_h3_prompt


def _ref(tag: str, identity: str) -> MiniMaxH3Reference:
    return MiniMaxH3Reference(tag=tag, kind="character", name="Yui", identity_id=identity)


def _prompt(*, has_first_frame: bool, refs: list[MiniMaxH3Reference]) -> str:
    context = MiniMaxH3BeatContext(
        mode="ref2va",
        has_first_frame=has_first_frame,
        visual_description="Yui stands at the doorway.",
        references=refs,
        duration_seconds=5.0,
        storyboard_tag="<Picture 4>",
        storyboard_panel=3,
        storyboard_panel_count=5,
    )
    return assemble_minimax_h3_prompt(context, MiniMaxH3Content(first_frame_description="the doorway", end_state="she holds still"))


def test_later_shot_has_no_first_frame_picture():
    text = _prompt(has_first_frame=False, refs=[_ref("<Picture 3>", "Yui_edo_kosode")])
    assert "<Picture 1> is the first frame" not in text
    assert "begins from <Picture 1>" not in text
    assert "<Subject 1> is Yui, shown in <Picture 3>" in text
    assert "<Picture 2>" not in text


def test_first_shot_keeps_first_frame():
    text = _prompt(has_first_frame=True, refs=[_ref("<Picture 2>", "Yui_modern")])
    assert "<Picture 1> is the first frame" in text


def test_lint_accepts_explicit_expected_pictures():
    text = _prompt(has_first_frame=False, refs=[_ref("<Picture 3>", "Yui_edo_kosode")])
    strict = lint_minimax_h3_prompt(text, reference_count=3)
    assert any(i.code == "picture_tags_mismatch" for i in strict.issues)
    relaxed = lint_minimax_h3_prompt(text, reference_count=3, expected_picture_numbers=[3, 4])
    assert not any(i.code == "picture_tags_mismatch" for i in relaxed.issues)
