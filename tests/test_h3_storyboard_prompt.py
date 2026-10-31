from novelvideo.agents.minimax_h3_prompt_builder import (
    MiniMaxH3BeatContext,
    MiniMaxH3Reference,
    build_fallback_minimax_h3_prompt,
)
from novelvideo.agents.minimax_h3_prompt_lint import lint_minimax_h3_prompt


def _ctx(**kw):
    refs = [MiniMaxH3Reference(tag="<Picture 2>", kind="character", name="Yui")]
    base = dict(
        mode="ref2va",
        visual_description="Yui walks along the path.",
        duration_seconds=6.0,
        references=refs,
    )
    base.update(kw)
    return MiniMaxH3BeatContext(**base)


def test_storyboard_lines_and_numbering():
    ctx = _ctx(storyboard_tag="<Picture 3>", storyboard_panel=2, storyboard_panel_count=4)
    prompt = build_fallback_minimax_h3_prompt(ctx).final_prompt
    assert "<Picture 3> is the storyboard sheet: 4 panels" in prompt
    assert "attribute_transfer" in prompt
    assert "panel 2 of <Picture 3>" in prompt
    assert "<Subject 2>" not in prompt  # the grid is not a subject
    assert "no grid lines or panel borders" in prompt
    res = lint_minimax_h3_prompt(prompt, mode="ref2va", reference_count=3, duration_seconds=6.0)
    assert not [i for i in res.issues if i.severity == "error"], res.issues


def test_no_storyboard_leaves_prompt_unchanged():
    prompt = build_fallback_minimax_h3_prompt(_ctx()).final_prompt
    assert "storyboard" not in prompt and "panel" not in prompt


def test_storyboard_ignored_without_ref2va():
    ctx = _ctx(mode="fl2va", references=[], storyboard_tag="<Picture 2>", storyboard_panel=1, storyboard_panel_count=2)
    assert "storyboard" not in build_fallback_minimax_h3_prompt(ctx).final_prompt
