"""Rewrites a drama beat into the official MiniMax H3 prompt format.

**2026-10-18 rewrite — the LLM no longer writes the prompt text.** Every
earlier version of this module (see git history / `.claude/CLAUDE.md`'s
"Review video trước khi generate" section for the blow-by-blow) asked the
LLM to produce the final, fully-formatted six-section ref2va / three-section
fl2va prompt text directly — section headers, `<Picture N>` numbering,
`[Shot 1]`, `<d>` dialogue tags, the lot. That is real-world unreliable: a
"thinking mode" vision model drops a section, forgets to cite a reference
image, quotes a `<d>` tag, or outright fails JSON validation on a fraction
of runs. Lint + retries reduced the *frequency* but could never make the
format itself impossible to get wrong, because the model was still the one
writing the format.

This version inverts that: the LLM only returns **content** — short visual
anchors, a handful of timestamped actions, one camera choice, an ending, a
soundscape line. `assemble_minimax_h3_prompt()` is 100% deterministic
Python that stitches those fields into the exact official section layout,
numbers every `<Picture N>`/`<Subject N>` itself (so it can never mismatch
the reference count), and inserts the beat's *actual* dialogue line
verbatim from the beat data — never from the LLM — inside a `<d>` tag it
builds itself. Every free-text field the LLM does return is run through
`_sanitize()` before insertion, which strips stray quotes, `<Picture N>`/
`[Shot N]`/`<d>` tokens, and anything that looks like a rogue section
header, so the model literally cannot corrupt the structural checks
`minimax_h3_prompt_lint.py` runs. A no-LLM fallback
(`build_fallback_minimax_h3_prompt`) goes through the same assembler from
beat text alone, so a flaky LLM call never has to leave the user with
nothing — see `api/routes/generation.py`'s `generate_minimax_h3_prompt`.

**Vision is still the source of truth for appearance** (this is the one
thing carried over unchanged from the previous design, and the reason this
still needs a vision-capable model + one call with images attached): a
character's recorded `appearance_details` text, when present at all, can
drift from what a later-regenerated reference image actually shows, and
when absent the model previously had nothing to go on but invent something
wrong. The real first frame and every reference image are attached
directly to the one LLM call; `subjects[].anchor` must describe what the
model actually sees, not a text hint.

The model/alias this module uses (`MINIMAX_H3_PROMPT_MODEL`, default
`DC-video-h3-prompt-LLM`) is mapped to `DC-qwen-vision`, which runs in
"thinking mode" and needs `output_type=NativeOutput(...)` (JSON-schema
structured output) rather than plain forced tool-calling — see
`docs/adr/0002-identity-planner-and-text-models-deepseek.md`.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator
from pydantic_ai import Agent, BinaryContent, ModelRetry, RunContext
from pydantic_ai.exceptions import UnexpectedModelBehavior
from pydantic_ai.output import NativeOutput

_RULES_PATH = Path(__file__).parent / "prompts" / "minimax_h3_rules.md"


def _load_rules() -> str:
    return _RULES_PATH.read_text(encoding="utf-8")


def _compress_image_bytes(image_path: str, compress_quality: int = 70) -> bytes:
    """JPEG-compress a reference/first-frame image before sending it to the
    vision model — same approach as `global_video_optimizer.py`'s
    `_compress_image` (sketch frames), reused here rather than duplicated
    logic drifting apart."""
    from PIL import Image

    img = Image.open(image_path)
    if img.mode in ("RGBA", "P"):
        img = img.convert("RGB")
    import io

    buffer = io.BytesIO()
    img.save(buffer, format="JPEG", quality=compress_quality, optimize=True)
    return buffer.getvalue()


class MiniMaxH3Reference(BaseModel):
    """One image/audio reference already assigned a `<Picture N>`/`<Audio N>`
    tag by the caller (see `api/routes/generation.py` review endpoint).
    `image_path`, when set, is sent to the (vision-capable) rewriter model
    as an actual image — see module docstring for why this replaced
    relying on `appearance_details` text alone."""

    tag: str = Field(description='e.g. "<Picture 2>" or "<Audio 1>"')
    kind: Literal["first_frame", "character", "scene", "prop", "voice"] = "character"
    name: str = Field(default="", description="Display name, e.g. a character name")
    appearance_details: str = Field(
        default="",
        description=(
            "Optional supplementary hint (e.g. a character's recorded "
            "appearance text) — the attached image, if any, is authoritative"
        ),
    )
    image_path: str = Field(default="", description="Absolute path to the reference image file, if any")


class MiniMaxH3BeatContext(BaseModel):
    """Everything the rewriter needs about one beat. Assembled by the
    caller from the beat/episode data — this module has no store access."""

    mode: Literal["ref2va", "fl2va", "flf2va", "t2va"] = "ref2va"
    # Whether `<Picture 1>` is a real first frame pinned at t=0. False for
    # text-to-video and for reference-only generation (no render needed):
    # the references then start at `<Picture 1>`.
    has_first_frame: bool = True
    # flf2va: the last frame is the picture right after the references
    # (fl2va has none), pinned at the final frame.
    last_frame_path: str = ""
    visual_description: str = ""
    narration_segment: str = ""
    # The beat's actual spoken line(s), verbatim — assembled into the
    # output prompt's `<d>` tag(s) directly by `assemble_minimax_h3_prompt`,
    # never paraphrased or regenerated by the LLM. For a beat with more than
    # one speaker folded in, this is already "Name: line" per line (see
    # `api/routes/generation.py`'s `_h3_parse_dialogue_segment`), joined by
    # "\n", and `dialogue_speaker` is the "/"-joined speaker list.
    dialogue_line: str = ""
    dialogue_speaker: str = ""
    dialogue_language: str = "Vietnamese"
    dialogue_on_screen: bool = True
    scene_description: str = ""
    duration_seconds: float = 6.0
    aspect_ratio: str = "9:16"
    prev_beat_narration: str = ""
    next_beat_narration: str = ""
    existing_video_prompt: str = ""
    # Optional free-text director notes from the user (the review dialog's
    # prompt-guidance box) — advisory only, never a substitute for the
    # attached images on appearance.
    director_guidance: str = ""
    # Set by the caller on a retry after an exception on the previous
    # attempt (malformed JSON, schema-validation failure, ...) — the
    # structural format can no longer be wrong (the LLM doesn't write it),
    # so the only thing left worth retrying is an outright failed call.
    retry_feedback: str = ""
    # `<Picture 1>` — sent to the rewriter as an actual image, same as every
    # other reference, so `subjects`/`first_frame_description` can describe
    # what's really in frame at t=0 instead of only the (possibly stale)
    # `visual_description` text.
    first_frame_path: str = ""
    references: list[MiniMaxH3Reference] = Field(default_factory=list)


class MiniMaxH3ShotPlan(BaseModel):
    """Internal directing plan — shown in the review dialog as "directing
    intent"; not sent to ComfyUI directly."""

    focus_subject: str = Field(description="Which <Subject N> this beat is about")
    objective: str = ""
    tactic: str = ""
    visible_gesture: str = Field(description="The one concrete, observable action/gesture")
    contradictory_cue: str = Field(default="", description="Subtext cue, if any")
    shot_pattern: str = Field(
        description="One of: Static Frame / Push-to-Decision / Reveal-by-Turn / Short Lateral Track"
    )
    camera_reason: str = ""
    beats: list[str] = Field(default_factory=list, description="Timestamped beat-by-beat description")
    dialogue_window: str = Field(default="", description='e.g. "1.20-3.00"')
    voice_description: str = ""
    end_state: str = ""


# ── Content the LLM actually produces (no format, no tags, no quotes) ──────


_FORBIDDEN_SYNTAX_RE = re.compile(
    r"<\s*/?\s*(?:Picture|Subject|Audio|d)\b|\[\s*Shot\b|^[a-z_]+:\s*$|[\"\u201c\u201d]",
    re.IGNORECASE | re.MULTILINE,
)
_SLOW_WORDS_RE = re.compile(
    r"\b(slowly|gently|gradually|subtly|lingering|lingers)\b", re.IGNORECASE
)


def _check_plain_text(value: str, *, allow_slow: bool = False) -> str:
    """Format rule shared by every free-text field the LLM fills: plain
    descriptive prose only. A violation raises, which pydantic-ai turns into
    a retry message addressed to the model (it fixes it in the same run)."""
    if _FORBIDDEN_SYNTAX_RE.search(value or ""):
        raise ValueError(
            "contains a tag, [Shot N], a section-header-looking line or a quote mark; "
            "write plain descriptive prose only (the code adds all tags and dialogue)"
        )
    if not allow_slow and _SLOW_WORDS_RE.search(value or ""):
        raise ValueError(
            "uses slow/soft filler (slowly, gently, gradually, subtly, lingering); "
            "describe the concrete motion at natural real-time speed instead"
        )
    return value


class MiniMaxH3SubjectContent(BaseModel):
    """One entry per `MiniMaxH3BeatContext.references[i]`, in the same
    order — NOT a `<Subject N>`/`<Picture N>` tag itself, the assembler
    numbers those."""

    anchor: str = Field(
        description=(
            "2-3 short visual anchors genuinely visible in this reference's "
            "attached image (e.g. hair + one outfit color/item), under ~15 "
            "words, comma-separated. No tags, no quotes, no personality or "
            "backstory. If a supplementary text hint is given and the image "
            "disagrees with it, describe the image, not the hint."
        ),
        min_length=3,
        max_length=220,
    )

    @field_validator("anchor")
    @classmethod
    def _plain_anchor(cls, value: str) -> str:
        return _check_plain_text(value, allow_slow=True)


class MiniMaxH3TimelineBeat(BaseModel):
    t: float = Field(
        ge=0,
        description="Timestamp in seconds from 0.00, strictly increasing across the list",
    )
    action: str = Field(
        description=(
            "One concrete, observable action/gesture at this timestamp — "
            "never a bare emotion word, never the spoken dialogue line, "
            "never a quote."
        ),
        min_length=8,
        max_length=400,
    )

    @field_validator("action")
    @classmethod
    def _plain_action(cls, value: str) -> str:
        # Slow/soft filler is a style issue (the lint warns about it), not a
        # structural one: it must not trigger a retry round-trip.
        return _check_plain_text(value, allow_slow=True)


class MiniMaxH3VoiceContent(BaseModel):
    subject_index: int = Field(
        default=0,
        description=(
            "1-based index into the subjects list for who speaks this line "
            "(matching the reference whose name is this speaker); 0 if the "
            "speaker is off-screen or has no reference image."
        ),
    )
    delivery: str = Field(
        default="",
        description=(
            "Voice description only: gender, age, timbre, accent, delivery "
            "tone/pace (e.g. 'a warm medium-pitched woman, anxious, tense "
            "and quiet, at a normal pace'). Never the words being said."
        ),
    )


class MiniMaxH3CameraContent(BaseModel):
    movement: Literal["static", "push_in", "lateral_track"] = Field(
        default="static",
        description=(
            "Locked static is always safe and preferred. Only choose "
            "push_in or lateral_track when the action clearly calls for it, "
            "and never when the beat has 2+ on-screen characters (identity "
            "tracking risk) — prefer static in that case."
        ),
    )
    reason: str = Field(
        default="",
        description="Short, concrete reason tied to the action — required when movement is not static.",
    )


class MiniMaxH3Content(BaseModel):
    """Everything the LLM contributes — pure content, no section headers,
    no `<Picture N>`/`<Subject N>`/`[Shot N]`/`<d>` tags, no quote marks.
    `assemble_minimax_h3_prompt` turns this into the final prompt text."""

    first_frame_description: str = Field(
        description="What <Picture 1> (the real first frame) actually shows: position, pose, framing."
    )
    style_line: str = Field(
        default="",
        description="One sentence: lighting, lens/shot style, color/mood — matching what the images show.",
    )
    framing: str = Field(
        default="", description="Shot size/angle, e.g. 'a medium shot at eye level from a three-quarter angle'"
    )
    subjects: list[MiniMaxH3SubjectContent] = Field(default_factory=list)
    camera: MiniMaxH3CameraContent = Field(default_factory=MiniMaxH3CameraContent)
    summary_action: str = Field(
        default="", description="One or two sentences summarizing what happens in this shot."
    )
    timeline: list[MiniMaxH3TimelineBeat] = Field(default_factory=list)
    voices: list[MiniMaxH3VoiceContent] = Field(default_factory=list)
    end_state: str = Field(description="The explicit stable pose/gaze/prop state the beat ends on.")
    soundscape: str = Field(default="", description="1-4 sentences of diegetic sound tied to the visible action.")
    music: str = Field(
        default="N/A", description="1-3 sentences of non-diegetic music genre/tempo/mood, or exactly 'N/A'."
    )

    @field_validator(
        "first_frame_description", "style_line", "framing", "summary_action", "end_state",
        "soundscape", "music",
    )
    @classmethod
    def _plain_fields(cls, value: str) -> str:
        return _check_plain_text(value, allow_slow=True)

    @model_validator(mode="after")
    def _timeline_and_camera(self) -> "MiniMaxH3Content":
        times = [beat.t for beat in self.timeline]
        if any(b <= a for a, b in zip(times, times[1:])):
            raise ValueError("timeline timestamps must be strictly increasing")
        if self.camera.movement != "static" and not self.camera.reason.strip():
            raise ValueError("camera.reason is required when camera.movement is not static")
        return self


class MiniMaxH3LLMOutput(BaseModel):
    plan: MiniMaxH3ShotPlan
    content: MiniMaxH3Content
    self_review: list[str] = Field(
        default_factory=list,
        description=(
            "Before answering, re-read the beat's visual description and your own "
            "content. List every place where your content contradicts it or leaves "
            "out one of its concrete elements (era, who fills the place, props, "
            "direction of movement, who is where). Fix each one in `content` first; "
            "this list must be EMPTY in your final answer."
        ),
    )

    @model_validator(mode="after")
    def _self_review_is_clean(self) -> "MiniMaxH3LLMOutput":
        if any(item.strip() for item in self.self_review):
            raise ValueError(
                "self_review still lists unresolved contradictions ("
                + "; ".join(i.strip() for i in self.self_review if i.strip())
                + "). Fix them in `content`, then return an empty self_review."
            )
        return self


class MiniMaxH3PromptResult(BaseModel):
    plan: MiniMaxH3ShotPlan
    final_prompt: str = Field(description="The complete, ready-to-use H3 prompt text")


def _build_agent() -> Agent:
    from novelvideo.config import (
        get_newapi_structured_output_model_settings,
        get_newapi_text_pydantic_model,
    )

    rules = _load_rules()
    system_prompt = (
        "You are a MiniMax H3 video prompt director for a short drama. You "
        "will be given one beat's context (visual description, narration, "
        "duration, aspect ratio, any director guidance) as text, and the "
        "actual first frame plus any character/scene/prop reference images "
        "as attached images, each labeled with its tag (when the beat has a "
        "first frame, <Picture 1> is the first frame and <Picture 2>, "
        "<Picture 3>, ... are references; when it has none, the references "
        "start at <Picture 1>. References are in the order listed, each "
        "corresponding 1:1 to the `subjects` list you return; a reference "
        "of kind scene is a location, a prop is an object). Describe what you genuinely see in "
        "those images — hair, face, clothing, the scene itself — rather "
        "than any text hint that comes with a reference; a text hint is "
        "only ever supplementary, and the image always wins if the two "
        "disagree.\n\n"
        "You do NOT write the final prompt text, section headers, "
        "`<Picture N>`/`<Subject N>`/`[Shot N]` tags, or any `<d>` dialogue "
        "tag — all of that is assembled by code from your structured "
        "answer. Never include quote marks, tags, or section-header-looking "
        "lines (like 'summary:') anywhere in your text fields; just plain "
        "descriptive content. Do not write out any dialogue/spoken line "
        "yourself anywhere — the actual line, if any, is inserted "
        "separately from the real beat data; your `timeline` actions "
        "describe physical behavior only, and `voices` describes HOW a "
        "line is delivered, never WHAT is said. Produce a directing plan, "
        "then the structured content, following every rule below "
        "exactly.\n\n" + rules
    )
    agent = Agent(
        get_newapi_text_pydantic_model(
            "MINIMAX_H3_PROMPT_MODEL",
            default_model="DC-video-h3-prompt-LLM",
            capability="text.generate.agent",
        ),
        system_prompt=system_prompt,
        # `NativeOutput` (JSON-schema structured output via `response_format`),
        # NOT plain `output_type=` (forced tool-calling / `tool_choice:
        # "required"`) — this alias is mapped to a vision-capable channel
        # (Qwen via DashScope, `DC-qwen-vision`), which runs in "thinking
        # mode" and rejects forced tool-calling, but does support
        # `response_format`/JSON schema cleanly. See
        # docs/adr/0002-identity-planner-and-text-models-deepseek.md.
        deps_type=MiniMaxH3BeatContext,
        # Format/consistency failures (see `validate_h3_output` and the field
        # validators) are sent back to the model as retry messages.
        retries=2,
        output_type=NativeOutput(MiniMaxH3LLMOutput),
        # `max_tokens`: a "thinking mode" vision model spends part of its
        # token budget on internal reasoning before the final JSON. The
        # schema is much smaller than the old free-text `final_prompt`
        # design (content only, no multi-section prose), but still generous
        # on purpose.
        model_settings={**get_newapi_structured_output_model_settings(), "max_tokens": 4000},
        name="MiniMax H3 Prompt Director",
    )

    @agent.output_validator
    async def _validate(
        ctx: RunContext[MiniMaxH3BeatContext], output: MiniMaxH3LLMOutput
    ) -> MiniMaxH3LLMOutput:
        problems = validate_h3_output(ctx.deps, output)
        if problems:
            logging.getLogger(__name__).warning(
                "MiniMax H3 output validator retry %d: %s", ctx.retry + 1, "; ".join(problems)
            )
            raise ModelRetry(
                "Fix these problems and answer again: " + "; ".join(problems) + "."
            )
        return output

    return agent


_agent: Optional[Agent] = None


def get_minimax_h3_prompt_agent() -> Agent:
    global _agent
    if _agent is None:
        _agent = _build_agent()
    return _agent


def _picture_order_note(context: MiniMaxH3BeatContext) -> str:
    if context.has_first_frame:
        return (
            "<Picture 1> is the first frame — its image follows this text, then each "
            "reference's image in the order listed below"
        )
    return (
        "there is NO first frame; the reference images follow this text in the order "
        "listed below, starting at <Picture 1>"
    )


def _format_references(context: MiniMaxH3BeatContext) -> str:
    lines = []
    for i, ref in enumerate(context.references, start=1):
        details = ref.appearance_details.strip()
        hint = f" (supplementary text hint, image is authoritative: {details})" if details else ""
        attached_note = " [image attached below]" if ref.image_path else " [no image available]"
        lines.append(
            f"- subjects[{i - 1}] <- {ref.tag} ({ref.kind}){f' — {ref.name}' if ref.name else ''}{attached_note}{hint}"
        )
    if lines:
        return "\n".join(lines)
    return "(no reference images — describe everything from the text)"


def _build_user_prompt(context: MiniMaxH3BeatContext) -> str:
    dialogue_note = "(no dialogue in this beat — leave `voices` empty)"
    if context.dialogue_line.strip():
        onscreen_note = "on-screen" if context.dialogue_on_screen else "off-screen"
        speaker_note = context.dialogue_speaker or "(unnamed)"
        dialogue_note = (
            f"This beat HAS dialogue ({onscreen_note}), spoken by: {speaker_note}. "
            "The actual line(s) are inserted by code from the real beat data — "
            "do not write them yourself anywhere. Just make sure `voices` "
            "describes each speaker's delivery (matching them to the right "
            "`subjects` index by name when there's a reference for them), and "
            "that your `timeline` leaves room for them to speak."
        )

    return f"""## Mode
{context.mode}

## Duration / aspect ratio
{context.duration_seconds:.1f}s, {context.aspect_ratio}

## Visual description ({"first frame / scene" if context.has_first_frame else "AUTHORITATIVE — there is no first frame; everything in it must appear, nothing may be contradicted"})
{context.visual_description or "(none provided)"}

## Scene
{context.scene_description or "(none provided)"}

## Narration
Previous beat: {context.prev_beat_narration or "(none)"}
This beat: {context.narration_segment or "(none)"}
Next beat: {context.next_beat_narration or "(none)"}

## Dialogue
{dialogue_note}

## References (subjects[i] corresponds to this list's entry i, in order; {_picture_order_note(context)})
{_format_references(context)}

## Existing motion hint (optional, may be stale — treat only as a hint, not authoritative)
{context.existing_video_prompt or "(none)"}

## Director guidance (optional, from the user — advisory, never a substitute for what the attached images actually show)
{context.director_guidance or "(none)"}
{f'''
## Fix this specific problem from your previous attempt at this beat
{context.retry_feedback}
''' if context.retry_feedback.strip() else ""}
Now produce the directing plan and the structured content for this beat, describing every subject's appearance from the attached images, not from any text hint."""


def _load_reference_image_content(image_path: str) -> Optional[BinaryContent]:
    if not image_path or not os.path.exists(image_path):
        return None
    try:
        return BinaryContent(data=_compress_image_bytes(image_path), media_type="image/jpeg")
    except OSError:
        return None


# ── Deterministic assembly (no LLM involved past this point) ───────────────

_STRIP_THINK_RE = re.compile(r"</?think>", re.IGNORECASE)
_STRIP_PICTURE_RE = re.compile(r"<Picture\s*\d+>", re.IGNORECASE)
_STRIP_SUBJECT_RE = re.compile(r"<Subject\s*\d+>", re.IGNORECASE)
_STRIP_SHOT_RE = re.compile(r"\[Shot\s*\d+\]", re.IGNORECASE)
_STRIP_AUDIO_RE = re.compile(r"<Audio\s*\d+>", re.IGNORECASE)
_STRIP_DIALOGUE_TAG_RE = re.compile(r"</?d>", re.IGNORECASE)
_STRIP_SECTION_HEADER_RE = re.compile(r"^[a-z_]+:\s*$", re.MULTILINE)
_QUOTE_CHARS_RE = re.compile(r'["\u201c\u201d]')
_DEFAULT_VOICE_DESC = "a natural voice, speaking at a normal pace"


def _sanitize(text: str | None) -> str:
    """Strip anything an LLM-returned free-text field could use to corrupt
    the structural checks in `minimax_h3_prompt_lint.py` — a stray quote
    (would trip `stray_quotes`), a `<Picture N>`/`<Subject N>`/`[Shot N]`/
    `<d>` tag the model isn't supposed to write at all (would desync the
    numbering the assembler controls), a `</think>` leak from a "thinking
    mode" model, or a line that merely looks like one of our own section
    headers (would break `_section_body`'s next-header scan)."""
    value = str(text or "")
    value = _STRIP_THINK_RE.sub(" ", value)
    value = _STRIP_PICTURE_RE.sub("", value)
    value = _STRIP_SUBJECT_RE.sub("", value)
    value = _STRIP_SHOT_RE.sub("", value)
    value = _STRIP_AUDIO_RE.sub("", value)
    value = _STRIP_DIALOGUE_TAG_RE.sub("", value)
    value = _QUOTE_CHARS_RE.sub("", value)
    value = _STRIP_SECTION_HEADER_RE.sub("", value)
    return re.sub(r"\s+", " ", value).strip()


def _camera_sentence(camera: MiniMaxH3CameraContent, character_count: int) -> str:
    movement = camera.movement
    if character_count >= 2:
        # Rule: a camera move risks losing track of identity with 2+
        # on-screen characters — always downgrade to locked static,
        # regardless of what the LLM chose.
        movement = "static"
    if movement == "push_in":
        reason = _sanitize(camera.reason) or "to draw attention to the key action"
        return f"The camera executes a single push-in {reason}, otherwise holding the frame static."
    if movement == "lateral_track":
        reason = _sanitize(camera.reason) or "to follow the subject's movement"
        return f"The camera performs a single brief lateral track {reason}, otherwise holding the frame static."
    return "The camera holds a static shot throughout."


def _clamped_timeline(
    timeline: list[MiniMaxH3TimelineBeat], duration: float
) -> list[tuple[float, str]]:
    out: list[tuple[float, str]] = []
    for item in timeline or []:
        try:
            t = float(item.t)
        except (TypeError, ValueError):
            continue
        t = max(0.0, min(t, duration))
        out.append((t, _sanitize(item.action)))
    out = [(t, action) for t, action in out if action]
    out.sort(key=lambda pair: pair[0])
    if not out:
        out = [(round(duration * 0.5, 2), "The subject performs the described action.")]
    return out


def _parse_dialogue_turns(context: MiniMaxH3BeatContext) -> list[tuple[str, str]]:
    """(speaker_name_or_empty, verbatim_line) pairs, in order. Mirrors the
    multi-turn detection `_build_user_prompt` used to do inline — a beat
    whose `narration_segment` folded more than one character's line
    together arrives here as `dialogue_speaker="Name1 / Name2"` and
    `dialogue_line="Name1: line one\\nName2: line two"` (see
    `api/routes/generation.py`'s `_h3_parse_dialogue_segment`)."""
    raw = context.dialogue_line.strip()
    if not raw:
        return []
    is_multi_turn = " / " in context.dialogue_speaker and "\n" in raw
    if not is_multi_turn:
        return [(context.dialogue_speaker.strip(), raw)]
    turns: list[tuple[str, str]] = []
    for line in raw.split("\n"):
        line = line.strip()
        if not line:
            continue
        if ":" in line:
            name, text = line.split(":", 1)
            turns.append((name.strip(), text.strip()))
        else:
            turns.append(("", line))
    return turns


def _match_subject_index(name: str, references: list[MiniMaxH3Reference]) -> int | None:
    if not name:
        return None
    name_l = name.strip().lower()
    for i, ref in enumerate(references, start=1):
        if ref.name and ref.name.strip().lower() == name_l:
            return i
    for i, ref in enumerate(references, start=1):
        ref_name_l = ref.name.strip().lower()
        if ref_name_l and (name_l in ref_name_l or ref_name_l in name_l):
            return i
    return None


def _voice_description(content: MiniMaxH3Content, subject_idx: int | None) -> str:
    target = subject_idx or 0
    for voice in content.voices:
        if voice.subject_index == target:
            desc = _sanitize(voice.delivery)
            if desc:
                return desc
    return _DEFAULT_VOICE_DESC


def _dialogue_block(context: MiniMaxH3BeatContext, content: MiniMaxH3Content) -> str:
    """Builds the `<d>` dialogue sentence(s) straight from the beat's real
    dialogue data (`context.dialogue_line`/`dialogue_speaker`) — never from
    anything the LLM returned. This is the one part of the final prompt
    that is never run through `_sanitize()`, since it must stay exactly
    verbatim (rule 7's "copy this EXACTLY character-for-character")."""
    turns = _parse_dialogue_turns(context)
    if not turns:
        return ""

    lang = context.dialogue_language or "English"
    sid_by_key: dict[str, str] = {}
    sentences: list[str] = []
    for name, text in turns:
        if not text:
            continue
        key = name or "__offscreen__"
        if key not in sid_by_key:
            sid_by_key[key] = f"S{len(sid_by_key) + 1}"
        sid = sid_by_key[key]
        subject_idx = _match_subject_index(name, context.references)
        subject_desc = (
            f"<Subject {subject_idx}> ({sid})" if subject_idx else f"an off-screen voice ({sid})"
        )
        voice_desc = _voice_description(content, subject_idx)
        sentences.append(f"{subject_desc} says it in {voice_desc}: <d>[{lang}] {text}</d>")

    if not sentences:
        return ""
    if len(sentences) == 1:
        closing = (
            "Exactly as the voice stops, the lips close and the jaw ceases all "
            "speaking motion. This single line is the only speech in the video."
        )
    else:
        closing = (
            "Exactly as each line finishes, that speaker's lips close and their "
            "jaw ceases all speaking motion. These lines are the only speech in "
            "the video."
        )
    return " ".join(sentences) + " " + closing


def _reference_usage_sentences(references: list) -> str:
    """Tie every scene/prop reference into the shot description itself, not
    only into `subject_definitions`: the model was seen to define a prop or
    location image and then never use it in the action."""
    subject_no = 0
    parts: list[str] = []
    for ref in references:
        name = _sanitize(ref.name) or f"the item in {ref.tag}"
        if ref.kind == "scene":
            parts.append(
                f"The whole shot takes place in the setting {name} shown in {ref.tag}, "
                "keeping its architecture and layout."
            )
            continue
        subject_no += 1
        if ref.kind == "prop":
            parts.append(
                f"<Subject {subject_no}>, the prop {name} from {ref.tag}, stays visible "
                "in the shot and is used in the action exactly as it looks in the reference."
            )
    return " ".join(parts)


def assemble_minimax_h3_prompt(context: MiniMaxH3BeatContext, content: MiniMaxH3Content) -> str:
    """Deterministically builds the final, ready-to-submit H3 prompt text
    from `context` (ground truth: references, dialogue, duration) and
    `content` (the LLM's descriptive contribution). Every LLM-sourced
    string is sanitized before insertion — see module docstring."""
    duration = max(float(context.duration_seconds or 5.0), 0.1)
    references = context.references
    mode = context.mode
    if mode == "ref2va" and not references:
        mode = "fl2va" if context.has_first_frame else "t2va"
    has_first_frame = context.has_first_frame and mode != "t2va"
    character_count = sum(1 for ref in references if ref.kind == "character")

    first_frame_desc = _sanitize(content.first_frame_description) or "the scene and subjects as shown"
    style_line = _sanitize(content.style_line) or (
        "Live-action film footage, naturalistic lighting, realistic detail, natural skin tones."
    )
    framing = _sanitize(content.framing) or "a medium shot at eye level"
    camera_sentence = _camera_sentence(content.camera, character_count)
    end_state = _sanitize(content.end_state) or "the scene settles into a stable final pose"
    soundscape = _sanitize(content.soundscape) or "A quiet, natural room tone matching the scene."
    music = _sanitize(content.music) or "N/A"

    timeline = _clamped_timeline(content.timeline, duration)
    action_sentences = " ".join(
        f"At {t:.2f} seconds, {action}." for t, action in timeline
    )
    dialogue_sentence = _dialogue_block(context, content)

    opening = (
        f"[Shot 1] The shot begins from <Picture 1>: {framing}."
        if has_first_frame
        else f"[Shot 1] {framing[:1].upper()}{framing[1:]}."
    )
    if not has_first_frame:
        # No first frame carries the scene, so the beat's own description (era,
        # crowd, props, who does what) is the ground truth and goes in verbatim
        # — the LLM's paraphrase alone drifted from it (dropped the period
        # crowd and the held prop, invented a camera position).
        premise = _sanitize(context.visual_description)
        if premise:
            if premise[-1] not in ".!?":
                premise += "."
            opening = f"{opening} Scene premise: {premise}"
    if mode == "flf2va":
        closing = (
            f"The camera holds this framing until the final frame. At {duration:.2f} seconds, "
            f"the shot settles into the composition of <Picture 2> and holds to the end."
        )
    else:
        closing = f"The camera holds this framing until the final frame. At {duration:.2f} seconds, {end_state}."
    body_parts = [
        opening,
        camera_sentence,
        _reference_usage_sentences(references) if mode == "ref2va" else "",
        action_sentences,
        dialogue_sentence,
        (
            "Do not replace character action with camera movement, lighting "
            "changes, particles, fog, or environmental effects. All motion "
            "happens at natural real-time speed, not slow motion."
        ),
        closing,
        "There are no subtitles, captions, on-screen text, logos or watermarks anywhere in frame.",
    ]
    description_body = style_line + "\n" + " ".join(p for p in body_parts if p)

    if mode in ("fl2va", "flf2va", "t2va"):
        alignment = ""
        if mode != "t2va":
            alignment = (
                "For the target video, at 0.00 seconds into the target video, "
                "<Picture 1> (from [Shot 1]) is fully referenced."
            )
            if mode == "flf2va":
                alignment += (
                    f" At {duration:.2f} seconds, <Picture 2> (from [Shot 1]) is fully "
                    "referenced as the last frame."
                )
            alignment += "\n\n"
        return (
            f"{alignment}"
            f"integrated_multimodal_description:\n{description_body}\n\n"
            f"overall_soundscape:\n{soundscape}\n\n"
            f"non_diegetic_music:\n{music}"
        )

    # ref2va
    subject_lines: list[str] = []
    retention_lines: list[str] = []
    subject_no = 0
    for i, ref in enumerate(references, start=1):
        subject_content = content.subjects[i - 1] if i - 1 < len(content.subjects) else None
        anchor = _sanitize(subject_content.anchor) if subject_content else ""
        display_name = _sanitize(ref.name) or f"the subject in {ref.tag}"
        if ref.kind == "scene":
            # A location, not a cast member: no <Subject N>, just a setting line.
            anchor = anchor or "matching the reference image closely"
            subject_lines.append(f"{ref.tag} shows the setting {display_name}, with {anchor}.")
            retention_lines.append(
                f"{ref.tag} (setting): partially_preserved - {anchor}, used as the location for the whole video."
            )
            continue
        subject_no += 1
        if not anchor:
            anchor = "matching the reference image closely, with no changes"
        noun = f"the prop {display_name}" if ref.kind == "prop" else display_name
        subject_lines.append(f"<Subject {subject_no}> is {noun}, shown in {ref.tag}, with {anchor}.")
        retention_lines.append(
            f"<Subject {subject_no}> (appears in [Shot 1]): fully_preserved - {anchor}, consistent for the whole video."
        )
    if has_first_frame:
        subject_lines.append(f"<Picture 1> is the first frame of [Shot 1], showing {first_frame_desc}.")
        retention_lines.append(
            "<Picture 1> ([Shot 1] first frame): fully_preserved - the video starts exactly from its framing, pose and lighting."
        )
    subject_definitions = "\n".join(subject_lines)

    summary_action = (
        _sanitize(content.summary_action) or "The subject performs the described action."
    )
    summary_start = " that begins from <Picture 1>." if has_first_frame else "."
    summary = (
        f"A {duration:.0f}-second {context.aspect_ratio} {framing} shot{summary_start} "
        f"{summary_action} Ends with {end_state}."
    )
    if character_count == 1:
        retention_lines.append("No costume change, no face change, no second person.")
    retention_analysis = "\n".join(retention_lines)

    return (
        f"subject_definitions:\n{subject_definitions}\n\n"
        f"summary:\n{summary}\n\n"
        f"retention_analysis:\n{retention_analysis}\n\n"
        f"detailed_description:\n{description_body}\n\n"
        f"overall_soundscape:\n{soundscape}\n\n"
        f"non_diegetic_music:\n{music}"
    )


def _fallback_shot_plan(context: MiniMaxH3BeatContext) -> MiniMaxH3ShotPlan:
    focus = context.references[0].name if context.references else "the scene"
    gesture = (context.visual_description or context.narration_segment or "").strip()[:160]
    return MiniMaxH3ShotPlan(
        focus_subject=f"<Subject 1> ({focus})" if context.references else focus,
        visible_gesture=gesture or "The subject performs the described action.",
        shot_pattern="Static Frame",
        end_state="the scene settles into a stable final pose",
    )


def build_fallback_minimax_h3_prompt(context: MiniMaxH3BeatContext) -> MiniMaxH3PromptResult:
    """No-LLM fallback — built straight from beat text (no vision), run
    through the exact same deterministic assembler. Used when the LLM call
    fails outright (bad network, quota, malformed JSON) so the review
    dialog never has to leave the user with nothing: the result is still
    guaranteed to pass every structural lint check, just with plainer
    content than a successful vision call would produce. See
    `api/routes/generation.py`'s `generate_minimax_h3_prompt`."""
    # `model_construct`: the fallback text comes straight from the beat (quotes,
    # short actions, ...) and is cleaned by the assembler, so it must skip the
    # LLM-facing format validators.
    subjects = [
        MiniMaxH3SubjectContent.model_construct(
            anchor=(ref.appearance_details.strip()[:140] if ref.appearance_details.strip() else "")
            or "matching the reference image closely"
        )
        for ref in context.references
    ]
    base_action = (context.visual_description or context.narration_segment or "").strip()[:220]
    content = MiniMaxH3Content.model_construct(
        first_frame_description=context.visual_description.strip()[:220] or "the scene as described",
        style_line="Live-action film footage, naturalistic lighting, realistic detail, natural skin tones.",
        framing="a medium shot at eye level",
        subjects=subjects,
        camera=MiniMaxH3CameraContent.model_construct(movement="static"),
        summary_action=base_action or "The subject performs the described action.",
        timeline=[
            MiniMaxH3TimelineBeat.model_construct(
                t=round(max(float(context.duration_seconds or 5.0), 0.1) * 0.5, 2),
                action=base_action or "The subject performs the described action.",
            )
        ],
        voices=[],
        end_state="the scene settles into a stable final pose matching the description",
        soundscape="A quiet, natural room tone matching the scene.",
        music="N/A",
    )
    final_prompt = assemble_minimax_h3_prompt(context, content)
    return MiniMaxH3PromptResult(plan=_fallback_shot_plan(context), final_prompt=final_prompt)


def validate_h3_output(context: "MiniMaxH3BeatContext", output: "MiniMaxH3LLMOutput") -> list[str]:
    """Context-dependent checks a schema alone cannot express: fidelity to the
    beat's description, one `subjects` entry per reference, and a timeline
    that fits the clip. Pure and deterministic (unit-tested without an LLM)."""
    content = output.content
    problems = description_fidelity_problems(context.visual_description, content)
    if len(content.subjects) != len(context.references):
        problems.append(
            f"`subjects` has {len(content.subjects)} entries but there are "
            f"{len(context.references)} references; return exactly one per reference, in order"
        )
    written = " ".join(
        [content.summary_action, content.end_state, *(b.action for b in content.timeline)]
    ).lower()
    for ref in context.references:
        if ref.kind != "prop":
            continue
        words = [w for w in re.split(r"[^a-z0-9]+", (ref.name or "").lower()) if len(w) >= 3]
        if words and not any(w in written for w in words):
            problems.append(
                f"the prop '{ref.name}' ({ref.tag}) is never used in the summary or timeline; "
                "show where it is and what is done with it"
            )
    duration = float(context.duration_seconds or 0)
    if duration and content.timeline and content.timeline[-1].t > duration:
        problems.append(
            f"the last timeline timestamp {content.timeline[-1].t:.2f}s is past the clip length {duration:.2f}s"
        )
    if len(content.timeline) < 2:
        problems.append("the timeline needs at least two timestamped actions")
    if not context.has_first_frame and re.search(
        r"\b(already in frame|still in frame|as in the first frame)\b",
        " ".join([content.summary_action, *(b.action for b in content.timeline)]),
        re.IGNORECASE,
    ):
        problems.append("there is no first frame, so nobody is already in frame at 0.00s")
    return problems


class MiniMaxH3ReviewVerdict(BaseModel):
    consistent: bool = Field(
        description="True only if the draft contradicts nothing and omits no concrete element of the beat description"
    )
    issues: list[str] = Field(
        default_factory=list,
        description=(
            "At most 5 issues, each naming the draft sentence and the fact it conflicts with "
            "or the description element it leaves out. Empty when consistent."
        ),
    )


_REVIEW_SYSTEM_PROMPT = (
    "You are a strict continuity editor for a short-drama video prompt. You get a "
    "beat's ground truth (visual description, who is in it, which reference images "
    "exist, whether there is a first frame) and a DRAFT of the shot written from it. "
    "Find contradictions and omissions only: the draft saying a place is empty when "
    "the description says it is crowded; a different era, camera position, direction "
    "of movement or number of people than the description gives; a prop that is "
    "dropped or used differently; a character appearing before she can (no first frame "
    "means nobody is in frame at 0.00 s); actions that contradict each other across "
    "timestamps; a subject anchor that does not match its reference name. Ignore "
    "style and wording. Do not invent problems: if the draft is faithful, return "
    "consistent=true with no issues."
)
_review_agent: Optional[Agent] = None


def _get_review_agent() -> Agent:
    global _review_agent
    if _review_agent is None:
        from novelvideo.config import (
            get_newapi_structured_output_model_settings,
            get_newapi_text_pydantic_model,
        )

        _review_agent = Agent(
            # Text-only and independent of the writer model: its own alias
            # (`DC-video-h3-review-LLM`, mapped to channel `DC-deepseek`).
            get_newapi_text_pydantic_model(
                "MINIMAX_H3_REVIEW_MODEL",
                default_model="DC-video-h3-review-LLM",
                capability="text.generate.agent",
            ),
            system_prompt=_REVIEW_SYSTEM_PROMPT,
            # Plain output type (forced tool-calling): deepseek-chat rejects
            # NativeOutput/response_format with a 400 (ADR 0002).
            output_type=MiniMaxH3ReviewVerdict,
            model_settings={**get_newapi_structured_output_model_settings(), "max_tokens": 1500},
            name="MiniMax H3 Prompt Reviewer",
        )
    return _review_agent


def _review_input(context: "MiniMaxH3BeatContext", content: "MiniMaxH3Content") -> str:
    refs = "\n".join(f"- {r.tag} ({r.kind}) {r.name}" for r in context.references) or "(none)"
    timeline = "\n".join(f"- {b.t:.2f}s: {b.action}" for b in content.timeline)
    anchors = "\n".join(
        f"- subjects[{i}] ({context.references[i].name if i < len(context.references) else '?'}): {sub.anchor}"
        for i, sub in enumerate(content.subjects)
    )
    return (
        f"## Beat ground truth\nVisual description: {context.visual_description or '(none)'}\n"
        f"First frame present: {context.has_first_frame}\nClip length: {context.duration_seconds:.1f}s\n"
        f"References:\n{refs}\n\n## Draft\nOpening frame: {content.first_frame_description}\n"
        f"Framing: {content.framing}\nCamera: {content.camera.movement}\n"
        f"Summary: {content.summary_action}\nTimeline:\n{timeline}\nEnds: {content.end_state}\n"
        f"Subject anchors:\n{anchors}"
    )


async def review_h3_draft(context: "MiniMaxH3BeatContext", content: "MiniMaxH3Content") -> list[str]:
    """Independent AI pass: does the draft contradict or drop anything in the
    beat's own description? A failed review call never blocks generation."""
    try:
        verdict = (await _get_review_agent().run(_review_input(context, content))).output
    except Exception as exc:  # noqa: BLE001
        logging.getLogger(__name__).warning("MiniMax H3 draft review skipped: %r", exc)
        return []
    return [] if verdict.consistent else [i.strip() for i in verdict.issues if i.strip()][:5]


# Nouns that name who fills a place; if the beat's description has one, the
# rewritten action must too (and must not call the place empty).
_CROWD_TERMS = (
    "crowd", "crowds", "townspeople", "samurai", "villagers", "merchants",
    "pedestrians", "passersby", "commuters", "soldiers", "monks", "peasants",
    "bystanders", "onlookers", "vendors", "customers", "students",
)
_EMPTY_PLACE_RE = re.compile(
    r"\b(empty|deserted|devoid of (?:people|anyone|life)|no one|nobody|unoccupied)\b",
    re.IGNORECASE,
)


def description_fidelity_problems(
    visual_description: str, content: "MiniMaxH3Content"
) -> list[str]:
    """What the rewritten action dropped or contradicted from the beat's own
    visual description: a hyphenated period/era tag (e.g. `Edo-period`), a
    crowd noun, or an empty-place claim when the description has a crowd.
    Deterministic — the LLM paraphrases freely and was seen to turn a crowded
    Edo bridge into an empty one."""
    description = (visual_description or "").lower()
    if not description.strip():
        return []
    written = " ".join(
        [
            content.first_frame_description,
            content.summary_action,
            content.end_state,
            *(beat.action for beat in content.timeline),
        ]
    ).lower()
    problems: list[str] = []
    written_flat = written.replace("-", " ")
    for tag in sorted(set(re.findall(r"[a-z]+-[a-z]+", description))):
        if tag not in written and tag.replace("-", " ") not in written_flat:
            problems.append(f"the era/setting tag '{tag}' is never mentioned")
    crowd = [term for term in _CROWD_TERMS if term in description]
    if crowd and not any(term in written for term in _CROWD_TERMS):
        problems.append(
            f"the description says the place is filled with {', '.join(crowd)} but your text never shows them"
        )
    if crowd and _EMPTY_PLACE_RE.search(written):
        problems.append(
            "your text calls the place empty/deserted although the description says it is crowded"
        )
    return problems


def review_enabled() -> bool:
    """`MINIMAX_H3_REVIEW=0` turns the extra reviewer call off."""
    return os.getenv("MINIMAX_H3_REVIEW", "1").strip().lower() not in ("0", "false", "off", "no")


async def build_minimax_h3_prompt(context: MiniMaxH3BeatContext) -> MiniMaxH3PromptResult:
    agent = get_minimax_h3_prompt_agent()

    images: list = []
    first_frame_content = _load_reference_image_content(context.first_frame_path)
    if first_frame_content is not None:
        images.append(first_frame_content)
    if context.last_frame_path:
        last_frame_content = _load_reference_image_content(context.last_frame_path)
        if last_frame_content is not None:
            images.append(last_frame_content)
    for ref in context.references:
        ref_content = _load_reference_image_content(ref.image_path)
        if ref_content is not None:
            images.append(ref_content)

    output: MiniMaxH3LLMOutput | None = None
    attempt_context = context
    for attempt in range(2):
        # The agent's own output validator already sent format / fidelity
        # failures back to the model; this loop adds the independent review.
        response = await agent.run(
            [_build_user_prompt(attempt_context), *images], deps=attempt_context
        )
        output = response.output
        if not review_enabled():
            break
        issues = await review_h3_draft(context, output.content)
        if not issues:
            break
        logging.getLogger(__name__).warning(
            "MiniMax H3 reviewer found contradictions (attempt %d): %s",
            attempt + 1,
            "; ".join(issues),
        )
        attempt_context = context.model_copy(
            update={
                "retry_feedback": (
                    "An independent reviewer found contradictions with the beat description "
                    "in your previous answer: " + "; ".join(issues) + ". Fix every one of them."
                )
            }
        )
    assert output is not None
    final_prompt = assemble_minimax_h3_prompt(context, output.content)
    return MiniMaxH3PromptResult(plan=output.plan, final_prompt=final_prompt)


async def generate_minimax_h3_prompt_with_fallback(
    context: MiniMaxH3BeatContext,
    *,
    reference_count: int,
    duration_seconds: float,
    expects_dialogue: bool,
) -> tuple[MiniMaxH3PromptResult, list[dict[str, str]], bool]:
    """Shared retry/fallback/lint dance for one H3 prompt call.

    Moved here (2026-10-25, formerly `api/routes/generation.py`'s private
    `_generate_h3_prompt_result`) so BOTH `generation.py` (the main-pipeline
    beat/segment review routes) and `freezone/multishot.py` (the Freezone
    multishot review route) can call it per-shot without one route module
    importing a private helper from another — this module already declares
    itself store-free, which is exactly what a second caller with its own,
    non-beat shot data needs. `generation.py` keeps its own
    `_generate_h3_prompt_result` name as a thin alias to this function so
    its existing call sites are unchanged.

    Only an outright failed call is retried (3 attempts total); a call that
    succeeds but fails lint is NOT retried — lint issues are surfaced to the
    caller instead, same as the original behavior this was copied from
    verbatim."""
    from novelvideo.agents.minimax_h3_prompt_lint import lint_minimax_h3_prompt

    max_llm_attempts = 3
    result = None
    last_exc: Exception | None = None
    retry_context = context
    for _attempt in range(max_llm_attempts):
        try:
            result = await build_minimax_h3_prompt(retry_context)
            break
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            logging.getLogger(__name__).warning(
                "MiniMax H3 prompt LLM attempt %d/%d failed: %r",
                _attempt + 1,
                max_llm_attempts,
                exc,
            )
            if isinstance(exc, UnexpectedModelBehavior):
                # Output retries already ran inside the agent (each with the
                # concrete validation message); repeating the whole run only
                # multiplies latency, so go straight to the fallback template.
                break
            retry_context = context.model_copy(
                update={
                    "retry_feedback": (
                        "Your previous attempt failed to produce valid output "
                        f"at all ({exc}). Follow the schema and every rule "
                        "exactly this time."
                    )
                }
            )
            continue

    fallback_used = result is None
    if fallback_used:
        result = build_fallback_minimax_h3_prompt(context)

    lint = lint_minimax_h3_prompt(
        result.final_prompt,
        mode=context.mode,
        reference_count=reference_count,
        duration_seconds=duration_seconds,
        expects_dialogue=expects_dialogue,
    )
    lint_issues = [
        {"severity": i.severity, "code": i.code, "message": i.message} for i in lint.issues
    ]
    if fallback_used:
        lint_issues.insert(
            0,
            {
                "severity": "warning",
                "code": "fallback_template",
                "message": (
                    f"AI generation failed ({last_exc}); the basic template was used instead. "
                    "Please review and confirm or retry."
                ),
            },
        )
    return result, lint_issues, fallback_used
