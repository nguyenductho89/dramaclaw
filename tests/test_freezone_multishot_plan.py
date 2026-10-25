"""Unit tests for `freezone.multishot` — the pure, store-free logic behind
the Freezone MiniMax H3 Multishot routes. No DB, no network, no GPU calls.

See `.claude/CLAUDE.md` / the approved plan for this feature for the design
rationale (why `visual_description` carries the shot text, why the
fingerprint excludes the rewritten prompt, etc.) — these tests assert that
behavior directly rather than re-explaining it."""

from __future__ import annotations

import os

import pytest

from novelvideo.freezone import multishot as m


def _touch(path: str) -> str:
    open(path, "wb").close()
    return path


def _ref(path: str, *, name: str = "", kind: str = "character", source: str = "canvas") -> m.ResolvedReference:
    return m.ResolvedReference(path=path, url=f"/static/{name or path}", name=name, kind=kind, source=source)


def _plan(tmp_path, **overrides) -> m.FreezoneMultishotPlan:
    start = _touch(str(tmp_path / "start.png"))
    defaults = dict(
        backend="runpod_minimax_h3_multishot",
        checkpoint="fl2va",
        sampling={"steps": 20, "pdd_nfe": "", "pdd_file": "", "output_scale": 1.0},
        width=416,
        height=736,
        frames_per_shot=124,
        shot_seconds=5.17,
        start_image_path=start,
        start_image_url="/static/p/start.png",
        references=[],
        shots=[
            m.MultishotShotInput(id="s1", description="A red phone rings on the table"),
            m.MultishotShotInput(id="s2", description="She picks it up and frowns"),
        ],
        director_guidance="moody evening lighting",
        aspect_ratio="9:16",
    )
    defaults.update(overrides)
    return m.FreezoneMultishotPlan(**defaults)


# ── resolve_shared_references ────────────────────────────────────────────


def test_canvas_refs_come_before_library_refs(tmp_path):
    start = _touch(str(tmp_path / "start.png"))
    canvas = [_ref(_touch(str(tmp_path / "c1.png")), name="Canvas1", source="canvas")]
    library = [_ref(_touch(str(tmp_path / "l1.png")), name="Lib1", source="library")]
    out = m.resolve_shared_references(canvas_refs=canvas, library_refs=library, start_image_path=start)
    assert [r.name for r in out] == ["Canvas1", "Lib1"]


def test_dedupes_by_resolved_path_across_sources(tmp_path):
    start = _touch(str(tmp_path / "start.png"))
    shared = _touch(str(tmp_path / "shared.png"))
    canvas = [_ref(shared, name="FromCanvas", source="canvas")]
    library = [_ref(shared, name="FromLibrary", source="library")]
    out = m.resolve_shared_references(canvas_refs=canvas, library_refs=library, start_image_path=start)
    assert len(out) == 1
    assert out[0].name == "FromCanvas"  # first occurrence wins


def test_drops_reference_equal_to_start_image(tmp_path):
    start = _touch(str(tmp_path / "start.png"))
    canvas = [_ref(start, name="SameAsStart", source="canvas")]
    out = m.resolve_shared_references(canvas_refs=canvas, library_refs=[], start_image_path=start)
    assert out == []


def test_raises_hard_error_above_cap_not_silent_truncation(tmp_path):
    start = _touch(str(tmp_path / "start.png"))
    refs = [_ref(_touch(str(tmp_path / f"r{i}.png")), name=f"Ref{i}") for i in range(4)]
    assert m.MULTISHOT_MAX_UNION_REFERENCES == 3
    with pytest.raises(m.TooManyReferencesError) as exc_info:
        m.resolve_shared_references(canvas_refs=refs, library_refs=[], start_image_path=start)
    assert exc_info.value.limit == 3
    assert exc_info.value.names == ["Ref0", "Ref1", "Ref2", "Ref3"]


def test_exactly_at_cap_is_allowed(tmp_path):
    start = _touch(str(tmp_path / "start.png"))
    refs = [_ref(_touch(str(tmp_path / f"r{i}.png")), name=f"Ref{i}") for i in range(3)]
    out = m.resolve_shared_references(canvas_refs=refs, library_refs=[], start_image_path=start)
    assert len(out) == 3


# ── library_category_to_h3_kind ──────────────────────────────────────────


@pytest.mark.parametrize(
    "category,expected",
    [
        ("character", "character"),
        ("scene", "scene"),
        ("prop", "prop"),
        ("other", "character"),
        ("style", "character"),
        ("audio", "character"),
        ("", "character"),
        (None, "character"),
    ],
)
def test_library_category_to_h3_kind(category, expected):
    assert m.library_category_to_h3_kind(category) == expected


# ── build_shot_contexts ──────────────────────────────────────────────────


def test_only_shot_zero_gets_the_start_frame(tmp_path):
    plan = _plan(tmp_path)
    contexts = m.build_shot_contexts(plan)
    assert contexts[0].first_frame_path == plan.start_image_path
    assert contexts[1].first_frame_path == ""


def test_continuity_text_threads_between_shots(tmp_path):
    plan = _plan(tmp_path)
    contexts = m.build_shot_contexts(plan)
    assert contexts[0].prev_beat_narration == ""
    assert contexts[0].next_beat_narration == plan.shots[1].description
    assert contexts[1].prev_beat_narration == (
        "(continuing immediately from the previous shot, same scene and subjects) "
        + plan.shots[0].description
    )
    assert contexts[1].next_beat_narration == ""


def test_shot_text_goes_into_visual_description_not_director_guidance(tmp_path):
    plan = _plan(tmp_path)
    contexts = m.build_shot_contexts(plan)
    for ctx, shot in zip(contexts, plan.shots):
        assert ctx.visual_description == shot.description
        assert ctx.director_guidance == plan.director_guidance


def test_no_dialogue_in_v1(tmp_path):
    plan = _plan(tmp_path)
    for ctx in m.build_shot_contexts(plan):
        assert ctx.narration_segment == ""
        assert ctx.dialogue_line == ""


def test_references_tagged_starting_at_picture_2(tmp_path):
    refs = [
        _ref(_touch(str(tmp_path / "r0.png")), name="Alice", kind="character"),
        _ref(_touch(str(tmp_path / "r1.png")), name="Park", kind="scene"),
    ]
    plan = _plan(tmp_path, references=refs, checkpoint="ref2va")
    contexts = m.build_shot_contexts(plan)
    tags = [r.tag for r in contexts[0].references]
    assert tags == ["<Picture 2>", "<Picture 3>"]
    assert contexts[0].references[0].kind == "character"
    assert contexts[0].references[1].kind == "scene"
    # Every shot shares the SAME reference list/tags (one union batch for
    # the whole chain, not resolved per shot).
    assert [r.tag for r in contexts[1].references] == tags


def test_single_shot_has_no_continuity_text(tmp_path):
    plan = _plan(tmp_path, shots=[m.MultishotShotInput(id="s1", description="Only shot")])
    contexts = m.build_shot_contexts(plan)
    assert len(contexts) == 1
    assert contexts[0].prev_beat_narration == ""
    assert contexts[0].next_beat_narration == ""
    assert contexts[0].first_frame_path == plan.start_image_path


# ── multishot_input_fingerprint ──────────────────────────────────────────


def test_fingerprint_is_stable_for_identical_plan(tmp_path):
    plan = _plan(tmp_path)
    assert m.multishot_input_fingerprint(plan) == m.multishot_input_fingerprint(plan)


def test_fingerprint_unaffected_by_rewritten_prompt_text(tmp_path):
    """The whole point of excluding `final_prompt` from the fingerprint:
    hand-editing an AI-rewritten prompt in the review dialog must not make
    a later enqueue reject it as `input_stale`. Since `FreezoneMultishotPlan`
    never carries prompt text at all, this is really a guard against ever
    adding it to the fingerprint inputs — not a thing the plan today would
    let us test any other way."""
    plan = _plan(tmp_path)
    fields = {f for f in plan.__dataclass_fields__}
    assert "final_prompt" not in fields
    assert "shot_prompts" not in fields


def test_fingerprint_changes_when_shot_description_changes(tmp_path):
    plan_a = _plan(tmp_path)
    plan_b = _plan(
        tmp_path,
        shots=[
            m.MultishotShotInput(id="s1", description="A DIFFERENT phone rings"),
            plan_a.shots[1],
        ],
    )
    assert m.multishot_input_fingerprint(plan_a) != m.multishot_input_fingerprint(plan_b)


def test_fingerprint_changes_when_director_guidance_changes(tmp_path):
    plan_a = _plan(tmp_path, director_guidance="bright daylight")
    plan_b = _plan(tmp_path, director_guidance="moody night")
    assert m.multishot_input_fingerprint(plan_a) != m.multishot_input_fingerprint(plan_b)


def test_fingerprint_changes_when_checkpoint_or_dims_change(tmp_path):
    plan_a = _plan(tmp_path, checkpoint="fl2va")
    plan_b = _plan(tmp_path, checkpoint="ref2va")
    assert m.multishot_input_fingerprint(plan_a) != m.multishot_input_fingerprint(plan_b)

    plan_c = _plan(tmp_path, width=768, height=1344)
    assert m.multishot_input_fingerprint(plan_a) != m.multishot_input_fingerprint(plan_c)


def test_fingerprint_changes_when_start_image_mtime_changes(tmp_path):
    plan = _plan(tmp_path)
    fp_before = m.multishot_input_fingerprint(plan)
    # Bump mtime without changing content.
    os.utime(plan.start_image_path, None)
    import time

    time.sleep(0.01)
    with open(plan.start_image_path, "ab") as f:
        f.write(b"x")
    fp_after = m.multishot_input_fingerprint(plan)
    assert fp_before != fp_after


def test_fingerprint_changes_when_reference_set_changes(tmp_path):
    plan_a = _plan(tmp_path)
    ref = _ref(_touch(str(tmp_path / "r0.png")), name="Alice")
    plan_b = _plan(tmp_path, references=[ref], checkpoint="ref2va")
    assert m.multishot_input_fingerprint(plan_a) != m.multishot_input_fingerprint(plan_b)
