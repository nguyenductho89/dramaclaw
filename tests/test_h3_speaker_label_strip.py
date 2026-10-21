"""Unit tests for `_h3_strip_redundant_speaker_label` (added 2026-10-21).

Real user report: MiniMax H3's `<d>` dialogue tag included the speaker's
screenplay-style label, e.g.

    <d>[English] LITTLE KIM (flat, polite): A wall. Charming. I brought a
    rocket, just in case.</d>

so the model literally spoke "LITTLE KIM flat polite a wall..." — the
beat's `narration_segment` arrived as a full screenplay line (character
name + parenthetical performance note + colon) instead of just the words,
and `<d>` is built verbatim from that text (never sanitized — rule 7 says
"copy this EXACTLY character-for-character"), so the label went straight
into the model's mouth.

The fix matches against the speaker name DramaClaw already resolved
(`beat.speaker`, or the `{{identity}}` marker's character name for a
multi-turn beat) rather than a generic ALL-CAPS-word-then-colon
heuristic, specifically so real spoken lines that happen to start with a
capitalized word and a colon (e.g. "Listen: I mean it.") are never
touched unless they actually repeat the known speaker's own name.
"""

from __future__ import annotations

from novelvideo.api.routes.generation import (
    _h3_char_name_for_identity,
    _h3_parse_dialogue_segment,
    _h3_strip_redundant_speaker_label,
)


def test_strips_the_exact_reported_bug():
    text = (
        "LITTLE KIM (flat, polite): A wall. Charming. I brought a rocket, "
        "just in case."
    )
    assert _h3_strip_redundant_speaker_label(text, "Little Kim") == (
        "A wall. Charming. I brought a rocket, just in case."
    )


def test_strips_plain_name_colon_no_parenthetical():
    assert _h3_strip_redundant_speaker_label("KIM: Hello there.", "Kim") == "Hello there."


def test_case_insensitive_name_match():
    assert (
        _h3_strip_redundant_speaker_label("little kim: hi.", "LITTLE KIM") == "hi."
    )


def test_strips_full_width_chinese_label():
    assert (
        _h3_strip_redundant_speaker_label("小金（平淡，礼貌）：一堵墙。真迷人。", "小金")
        == "一堵墙。真迷人。"
    )


def test_leaves_real_dialogue_untouched_when_it_does_not_repeat_the_speaker():
    # Starts with a capitalized word + colon, but it is not the speaker's
    # own name — must survive verbatim, not be mistaken for a label.
    text = "Listen: I mean it."
    assert _h3_strip_redundant_speaker_label(text, "Little Kim") == text


def test_leaves_text_untouched_when_speaker_name_is_empty():
    text = "LITTLE KIM (flat): hi"
    assert _h3_strip_redundant_speaker_label(text, "") == text


def test_leaves_text_untouched_when_it_does_not_start_with_the_label():
    text = "He said, LITTLE KIM: hi, to no one in particular."
    assert _h3_strip_redundant_speaker_label(text, "Little Kim") == text


def test_does_not_blank_out_a_label_with_nothing_after_the_colon():
    # Degenerate input: stripping would leave nothing, so keep the label
    # text (surrounding whitespace trimmed) rather than handing the
    # caller an empty dialogue line.
    text = "LITTLE KIM (flat, polite):   "
    assert _h3_strip_redundant_speaker_label(text, "Little Kim") == text.strip()


def test_multi_turn_identity_marker_path_strips_each_speakers_own_label():
    character_map = {"Little Kim": {}, "Mom": {}}
    raw = (
        "{{Little Kim}} LITTLE KIM (flat, polite): A wall. Charming.\n"
        "{{Mom}} MOM (sighs): Oh honey."
    )
    dialogue_line, speaker_label = _h3_parse_dialogue_segment(raw, character_map)
    assert dialogue_line == "Little Kim: A wall. Charming.\nMom: Oh honey."
    assert speaker_label == "Little Kim / Mom"


def test_period_suffixed_identity_id_must_be_resolved_before_stripping():
    """Regression for the real "Kim" project beat (2026-10-21, second
    report — the first fix pass stripped nothing on this exact beat):
    `beat.speaker` is the full identity id with its period suffix
    ("Little Kim_Preschool Period"), never the clean display name the
    screenplay label in narration_segment actually uses ("LITTLE KIM").
    Passing the raw identity id straight to
    `_h3_strip_redundant_speaker_label` silently matches nothing (exact
    prefix match, no error) — the caller in `generate_minimax_h3_prompt`
    must resolve it through `_h3_char_name_for_identity` first, same as
    the {{identity}}-marker path already does."""
    character_map = {"Little Kim": {}, "Little Trump": {}}
    narration = (
        "LITTLE KIM (flat, polite): A wall. Charming. I brought a rocket, "
        "just in case."
    )
    raw_speaker = "Little Kim_Preschool Period"

    # The bug: stripping against the unresolved identity id is a no-op.
    assert _h3_strip_redundant_speaker_label(narration, raw_speaker) == narration

    # The fix: resolve to the display name first.
    clean_speaker = _h3_char_name_for_identity(raw_speaker, character_map)
    assert clean_speaker == "Little Kim"
    assert _h3_strip_redundant_speaker_label(narration, clean_speaker) == (
        "A wall. Charming. I brought a rocket, just in case."
    )


def test_single_speaker_beat_with_no_marker_returns_raw_unstripped():
    """`_h3_parse_dialogue_segment` itself only handles the {{identity}}
    marker shape — the single-speaker strip (using `beat.speaker`) happens
    at its call site in `generate_minimax_h3_prompt`, not here. This just
    pins the existing, unchanged contract for that no-marker path."""
    raw = "LITTLE KIM (flat, polite): A wall. Charming."
    dialogue_line, speaker_label = _h3_parse_dialogue_segment(raw, {})
    assert dialogue_line == raw
    assert speaker_label == ""
