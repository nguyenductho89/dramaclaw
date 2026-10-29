"""Unit tests for `agents/minimax_h3_prompt_builder.py`'s deterministic
assembler (`assemble_minimax_h3_prompt`) and `build_fallback_minimax_h3_prompt`
— no DB, no network, no LLM calls. These are the tests that back the
2026-10-18 rewrite: the LLM only contributes content, the format itself is
assembled by code, so it should be structurally impossible for the lint's
hard errors (missing sections, `<Picture N>` mismatch, missing `[Shot 1]`,
stray quotes, dropped dialogue) to occur, no matter what a flaky/dirty LLM
response contains."""

from __future__ import annotations

from novelvideo.agents.minimax_h3_prompt_builder import (
    MiniMaxH3BeatContext,
    MiniMaxH3CameraContent,
    MiniMaxH3Content,
    MiniMaxH3Reference,
    MiniMaxH3SubjectContent,
    MiniMaxH3TimelineBeat,
    MiniMaxH3VoiceContent,
    assemble_minimax_h3_prompt,
    build_fallback_minimax_h3_prompt,
)
from novelvideo.agents.minimax_h3_prompt_lint import lint_minimax_h3_prompt
from novelvideo.api.routes.generation import _is_h3_structured_prompt


def _ref(tag: str, name: str, kind: str = "character", appearance: str = "") -> MiniMaxH3Reference:
    return MiniMaxH3Reference(tag=tag, kind=kind, name=name, appearance_details=appearance)


def _content(**overrides) -> MiniMaxH3Content:
    defaults = dict(
        first_frame_description="a man standing in a park, facing the camera",
        style_line="Live-action film footage, soft daylight, realistic detail.",
        framing="a medium shot at eye level",
        subjects=[MiniMaxH3SubjectContent(anchor="dark hair, red jacket")],
        camera=MiniMaxH3CameraContent(movement="static"),
        summary_action="He looks up and reacts to something off-frame.",
        timeline=[
            MiniMaxH3TimelineBeat(t=0.5, action="He shifts his weight and tilts his head."),
            MiniMaxH3TimelineBeat(t=2.0, action="He raises one hand slightly."),
        ],
        voices=[],
        end_state="he stands still, looking off to the side, hand half-raised",
        soundscape="A light breeze, distant traffic.",
        music="N/A",
    )
    defaults.update(overrides)
    return MiniMaxH3Content(**defaults)


def test_ref2va_single_character_no_dialogue_has_zero_lint_errors():
    context = MiniMaxH3BeatContext(
        mode="ref2va",
        duration_seconds=6.0,
        aspect_ratio="9:16",
        references=[_ref("<Picture 2>", "Nikola Tesla", appearance="tall, mustache")],
        first_frame_path="",
    )
    content = _content()
    prompt = assemble_minimax_h3_prompt(context, content)
    lint = lint_minimax_h3_prompt(
        prompt, mode="ref2va", reference_count=2, duration_seconds=6.0, expects_dialogue=False
    )
    assert lint.ok, [i.message for i in lint.issues]
    assert "<Picture 1>" in prompt
    assert "<Picture 2>" in prompt
    assert "[Shot 1]" in prompt
    assert "No costume change, no face change, no second person." in prompt


def test_ref2va_two_characters_downgrades_camera_to_static():
    context = MiniMaxH3BeatContext(
        mode="ref2va",
        duration_seconds=8.0,
        references=[
            _ref("<Picture 2>", "Teacher"),
            _ref("<Picture 3>", "Tesla"),
        ],
    )
    content = _content(
        subjects=[
            MiniMaxH3SubjectContent(anchor="tweed jacket, glasses"),
            MiniMaxH3SubjectContent(anchor="dark hair, mustache"),
        ],
        camera=MiniMaxH3CameraContent(movement="push_in", reason="to emphasize the confrontation"),
    )
    prompt = assemble_minimax_h3_prompt(context, content)
    lint = lint_minimax_h3_prompt(
        prompt, mode="ref2va", reference_count=3, duration_seconds=8.0, expects_dialogue=False
    )
    assert lint.ok, [i.message for i in lint.issues]
    assert "<Picture 1>" in prompt and "<Picture 2>" in prompt and "<Picture 3>" in prompt
    # Rule: 2+ on-screen characters -> always downgrade to a locked static
    # shot, regardless of what the LLM picked.
    assert "The camera holds a static shot throughout." in prompt
    assert "push" not in prompt.lower()
    # Only one character total -> no "No costume change..." clause.
    assert "No costume change" not in prompt


def test_fl2va_no_references_has_zero_lint_errors():
    context = MiniMaxH3BeatContext(mode="fl2va", duration_seconds=5.0, references=[])
    content = _content(subjects=[])
    prompt = assemble_minimax_h3_prompt(context, content)
    lint = lint_minimax_h3_prompt(
        prompt, mode="fl2va", reference_count=1, duration_seconds=5.0, expects_dialogue=False
    )
    assert lint.ok, [i.message for i in lint.issues]
    assert prompt.startswith(
        "For the target video, at 0.00 seconds into the target video, "
        "<Picture 1> (from [Shot 1]) is fully referenced."
    )
    assert "integrated_multimodal_description:" in prompt
    assert "subject_definitions:" not in prompt


def test_single_speaker_dialogue_inserted_verbatim_and_lints_clean():
    context = MiniMaxH3BeatContext(
        mode="ref2va",
        duration_seconds=6.0,
        references=[_ref("<Picture 2>", "Lan")],
        dialogue_line="Anh với ai mà nhắn nhớ nhau vậy?",
        dialogue_speaker="Lan",
        dialogue_language="Vietnamese",
    )
    content = _content(
        subjects=[MiniMaxH3SubjectContent(anchor="shoulder-length hair, blue blouse")],
        voices=[MiniMaxH3VoiceContent(subject_index=1, delivery="a tense, worried woman, quiet pace")],
    )
    prompt = assemble_minimax_h3_prompt(context, content)
    lint = lint_minimax_h3_prompt(
        prompt, mode="ref2va", reference_count=2, duration_seconds=6.0, expects_dialogue=True
    )
    assert lint.ok, [i.message for i in lint.issues]
    assert "<d>[Vietnamese] Anh với ai mà nhắn nhớ nhau vậy?</d>" in prompt
    assert "<Subject 1> (S1)" in prompt
    assert "This single line is the only speech in the video." in prompt


def test_multi_speaker_dialogue_each_gets_own_turn_and_sid():
    context = MiniMaxH3BeatContext(
        mode="ref2va",
        duration_seconds=10.0,
        references=[_ref("<Picture 2>", "Nam"), _ref("<Picture 3>", "Ryan")],
        dialogue_line="Nam: You have one bucket, right?\nRyan: Fake news.",
        dialogue_speaker="Nam / Ryan",
        dialogue_language="English",
    )
    content = _content(
        subjects=[
            MiniMaxH3SubjectContent(anchor="toddler build, striped suit"),
            MiniMaxH3SubjectContent(anchor="toddler build, navy coat"),
        ],
        voices=[
            MiniMaxH3VoiceContent(subject_index=1, delivery="a small boy, confident"),
            MiniMaxH3VoiceContent(subject_index=2, delivery="a small boy, dismissive"),
        ],
    )
    prompt = assemble_minimax_h3_prompt(context, content)
    lint = lint_minimax_h3_prompt(
        prompt, mode="ref2va", reference_count=3, duration_seconds=10.0, expects_dialogue=True
    )
    assert lint.ok, [i.message for i in lint.issues]
    assert "<Subject 1> (S1)" in prompt
    assert "<Subject 2> (S2)" in prompt
    assert "<d>[English] You have one bucket, right?</d>" in prompt
    assert "<d>[English] Fake news.</d>" in prompt
    assert "These lines are the only speech in the video." in prompt


def test_silent_beat_has_no_dialogue_tag():
    context = MiniMaxH3BeatContext(
        mode="ref2va", duration_seconds=5.0, references=[_ref("<Picture 2>", "Someone")]
    )
    content = _content(subjects=[MiniMaxH3SubjectContent(anchor="short hair")])
    prompt = assemble_minimax_h3_prompt(context, content)
    lint = lint_minimax_h3_prompt(
        prompt, mode="ref2va", reference_count=2, duration_seconds=5.0, expects_dialogue=False
    )
    assert lint.ok, [i.message for i in lint.issues]
    assert "<d>" not in prompt


def test_dirty_llm_fields_are_sanitized_and_still_lint_clean():
    """Simulates a messy LLM response: stray quotes, a `</think>` leak, and
    tags the model is explicitly told never to write (`<Picture N>`,
    `[Shot N]`, `<d>`, and a fake 'summary:' section header). None of this
    should survive into the final prompt or break the lint."""
    context = MiniMaxH3BeatContext(
        mode="ref2va",
        duration_seconds=7.0,
        references=[_ref("<Picture 2>", "Someone")],
    )
    dirty = (
        '</think>He says "hello" <Picture 9> [Shot 2] <d>[English] fake</d> '
        "summary:\n   leaked line"
    )
    # `model_construct` skips the schema validators on purpose: this test is
    # about the assembler's last-line sanitizing of whatever slips through
    # (the schema itself rejects this text, see test_schema_rejects_dirty_text).
    content = MiniMaxH3Content.model_construct(
        first_frame_description=dirty,
        style_line=dirty,
        framing=dirty,
        subjects=[MiniMaxH3SubjectContent.model_construct(anchor=dirty)],
        camera=MiniMaxH3CameraContent(movement="static"),
        summary_action=dirty,
        timeline=[MiniMaxH3TimelineBeat.model_construct(t=1.0, action=dirty)],
        voices=[],
        end_state=dirty,
        soundscape=dirty,
        music=dirty,
    )
    prompt = assemble_minimax_h3_prompt(context, content)
    lint = lint_minimax_h3_prompt(
        prompt, mode="ref2va", reference_count=2, duration_seconds=7.0, expects_dialogue=False
    )
    assert lint.ok, [i.message for i in lint.issues]
    assert '"' not in prompt
    assert "</think>" not in prompt
    assert "<Picture 9>" not in prompt
    assert "[Shot 2]" not in prompt
    # The literal (legitimate) tags the assembler itself writes must still
    # be present and correctly numbered.
    assert prompt.count("<Picture 1>") >= 1
    assert prompt.count("<Picture 2>") >= 1
    assert "[Shot 1]" in prompt


def test_fallback_prompt_lints_clean_without_any_llm_content():
    context = MiniMaxH3BeatContext(
        mode="ref2va",
        duration_seconds=6.0,
        visual_description="She walks into the kitchen and sets down a bag.",
        references=[_ref("<Picture 2>", "Mai", appearance="long black hair, yellow dress")],
    )
    result = build_fallback_minimax_h3_prompt(context)
    lint = lint_minimax_h3_prompt(
        result.final_prompt,
        mode="ref2va",
        reference_count=2,
        duration_seconds=6.0,
        expects_dialogue=False,
    )
    assert lint.ok, [i.message for i in lint.issues]
    assert "long black hair, yellow dress" in result.final_prompt


def test_fallback_prompt_fl2va_lints_clean():
    context = MiniMaxH3BeatContext(mode="fl2va", duration_seconds=5.0, references=[])
    result = build_fallback_minimax_h3_prompt(context)
    lint = lint_minimax_h3_prompt(
        result.final_prompt,
        mode="fl2va",
        reference_count=1,
        duration_seconds=5.0,
        expects_dialogue=False,
    )
    assert lint.ok, [i.message for i in lint.issues]


def test_is_h3_structured_prompt_distinguishes_seedance_prose_from_h3():
    seedance_prose = (
        "A young woman stands in a softly lit apartment, holding her phone, "
        "looking worried as she waits for a reply."
    )
    assert _is_h3_structured_prompt(seedance_prose) is False
    assert _is_h3_structured_prompt("") is False

    ref2va_prompt = (
        "subject_definitions:\n<Subject 1> is ...\n\n"
        "summary:\n...\n\n"
        "retention_analysis:\n...\n\n"
        "detailed_description:\n[Shot 1] ...\n\n"
        "overall_soundscape:\n...\n\n"
        "non_diegetic_music:\nN/A"
    )
    assert _is_h3_structured_prompt(ref2va_prompt) is True

    fl2va_prompt = (
        "For the target video, at 0.00 seconds into the target video, "
        "<Picture 1> (from [Shot 1]) is fully referenced.\n\n"
        "integrated_multimodal_description:\n...\n\n"
        "overall_soundscape:\n...\n\n"
        "non_diegetic_music:\nN/A"
    )
    assert _is_h3_structured_prompt(fl2va_prompt) is True


def _action_body(prompt: str) -> str:
    return prompt.split("detailed_description:", 1)[1].split("overall_soundscape:", 1)[0]


def _three_refs() -> list[MiniMaxH3Reference]:
    return [
        _ref("<Picture 1>", "Yui"),
        _ref("<Picture 2>", "phone", kind="prop"),
        _ref("<Picture 3>", "Nihonbashi Bridge", kind="scene"),
    ]


def test_selected_scene_and_prop_are_tied_to_the_action_text():
    context = MiniMaxH3BeatContext(
        mode="ref2va", has_first_frame=False, duration_seconds=5.0, references=_three_refs()
    )
    content = _content(subjects=[MiniMaxH3SubjectContent(anchor="black hair, sailor uniform")] * 3)
    body = _action_body(assemble_minimax_h3_prompt(context, content))
    assert "Nihonbashi Bridge shown in <Picture 3>" in body
    assert "the prop phone from <Picture 2>" in body


def test_removing_a_reference_removes_it_from_the_action_text():
    refs = [r for r in _three_refs() if r.kind != "prop"]
    refs[1] = refs[1].model_copy(update={"tag": "<Picture 2>"})
    context = MiniMaxH3BeatContext(
        mode="ref2va", has_first_frame=False, duration_seconds=5.0, references=refs
    )
    content = _content(subjects=[MiniMaxH3SubjectContent(anchor="black hair, sailor uniform")] * 2)
    body = _action_body(assemble_minimax_h3_prompt(context, content))
    assert "Nihonbashi Bridge shown in <Picture 2>" in body
    assert "phone" not in body
    assert "<Picture 3>" not in body


def test_no_scene_or_prop_reference_adds_no_usage_sentence():
    context = MiniMaxH3BeatContext(
        mode="ref2va", has_first_frame=False, duration_seconds=5.0,
        references=[_ref("<Picture 1>", "Yui")],
    )
    body = _action_body(assemble_minimax_h3_prompt(context, _content()))
    assert "The whole shot takes place" not in body
    assert "the prop" not in body


def test_fallback_does_not_repeat_the_scene_premise_or_use_clumsy_anchors():
    context = MiniMaxH3BeatContext(
        mode="ref2va", has_first_frame=False, duration_seconds=5.0,
        visual_description="Yui walks in holding a phone.", references=_three_refs(),
    )
    prompt = build_fallback_minimax_h3_prompt(context).final_prompt
    assert _action_body(prompt).count("Yui walks in holding a phone.") == 1
    assert "with matching" not in prompt
    assert "Nihonbashi Bridge shown in <Picture 3>" in prompt
