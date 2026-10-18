from __future__ import annotations


import re
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from pydantic import BaseModel, Field, ValidationInfo, field_validator, model_validator
from pydantic_ai import Agent
from pydantic_ai.exceptions import ContentFilterError, UnexpectedModelBehavior

from novelvideo.brainclaw_contract import BrainClawProfile
from novelvideo.config import (
    get_newapi_structured_output_model_settings,
    get_newapi_text_pydantic_model,
)
from novelvideo.model_gateway_runtime import model_gateway_output_retries
from novelvideo.models import (
    NarrationScript,
    SceneRef,
    VisualBeat,
    build_scene_ref,
    extract_char_identities_from_markers,
    extract_prop_ids_from_markers,
)
from novelvideo.sqlite_store import load_episode_planning_content
from novelvideo.time_of_day import normalize_time_of_day
from novelvideo.utils.screenplay_quality import check_screenplay_import_quality
from novelvideo.utils.screenplay_scene_parser import (
    parse_character_line,
    parse_location_header,
    parse_scene_blocks,
    split_screenplay_lines,
)
from novelvideo.utils.source_language import (
    AssetLanguage,
    asset_language_instruction,
    detect_asset_language,
)

_ALTERNATIVE_RE = re.compile(r"\b(?:either|or|hoặc)\b", re.IGNORECASE)
DIALOGUE_RE = re.compile(r"^(?P<speaker>[^:]{1,24}):(?P<speech>.+)$")

CONTENT_FILTER_HINT_TERMS: dict[str, tuple[str, ...]] = {
    "violence/weapons": (
        "máu",
        "chảy máu",
        "xác chết",
        "giết",
        "đâm",
        "dao găm",
        "súng",
        "vụ nổ",
        "blood",
        "bloody",
        "bleeding",
        "corpse",
        "dead",
        "death",
        "kill",
        "murder",
        "stab",
        "knife",
        "dagger",
        "blade",
        "gun",
        "shoot",
        "shot",
        "explosion",
    ),
    "self-harm/life threat": (
        "tự tử",
        "không muốn chết",
        "đi chết đi",
        "suicide",
        "kill myself",
        "i can't die",
        "i cannot die",
        "don't want to die",
        "do not want to die",
        "go die",
    ),
    "coercion/abuse": (
        "ép buộc",
        "bóp cổ",
        "tra tấn",
        "hành quyết",
        "ngược đãi",
        "force",
        "forced",
        "coerce",
        "coerced",
        "choke",
        "strangle",
        "pin down",
        "restrain",
        "abuse",
        "torture",
        "execute",
        "execution",
    ),
    "sexual/nudity": (
        "xâm hại tình dục",
        "khỏa thân",
        "hiếp dâm",
        "nude",
        "naked",
        "sexual assault",
        "rape",
    ),
}


def _short_log_text(text: str, *, limit: int = 120) -> str:
    compact = re.sub(r"\s+", " ", (text or "").strip())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 1] + "…"


def _content_filter_hint_matches(text: str) -> list[str]:
    haystack = (text or "").casefold()
    matches: list[str] = []
    for category, terms in CONTENT_FILTER_HINT_TERMS.items():
        category_matches = []
        for term in terms:
            normalized = term.casefold()
            if normalized and normalized in haystack:
                category_matches.append(term)
        if category_matches:
            matches.append(f"{category}: " + ", ".join(dict.fromkeys(category_matches)))
    return matches


def _is_output_retry_exhaustion(exc: BaseException) -> bool:
    """Return whether PydanticAI exhausted only its output-validation budget."""

    return isinstance(exc, UnexpectedModelBehavior) and str(exc).strip().startswith(
        "Exceeded maximum output retries ("
    )


@dataclass
class SceneBlock:
    header_line: str = ""
    location: str = ""
    time_of_day: str = ""
    interior_exterior: str = ""
    characters: list[str] = field(default_factory=list)
    lines: list[str] = field(default_factory=list)
    context: "SceneBlockContext | None" = None


@dataclass
class SceneBlockContext:
    """Block-level precompiled candidate set for a scene block."""

    candidate_identity_ids: set[str] = field(default_factory=set)
    candidate_prop_ids: set[str] = field(default_factory=set)
    identity_fallback_reason: str = ""
    identity_section: str = ""
    prop_section: str = ""


@dataclass
class SceneLineContext:
    raw_line: str
    scene_block: SceneBlock
    prev_window: list[str] = field(default_factory=list)
    next_line: str = ""
    source_line_number: int = 0


class LiteralBeatMetaOutput(BaseModel):
    """LLM output of the line-by-line script mode."""

    audio_type: str = Field(
        default="silence",
        description="Audio type of the current line; silence = picture beat with no spoken audio, narration = commentary/voice-over, dialogue = line with an explicit speaker",
    )
    speaker: str = Field(
        default="",
        description="Speaker label of the current line; fill only for dialogue. For characters use an identity_id or the character label in the script; non-character sound sources may keep the original label",
    )
    speaker_kind: str = Field(
        default="character",
        description="Speaker type; character = physical or ordinary character, non_character = non-character sound source such as broadcast/voice-over/subtitle/screen",
    )
    visual_description: str = Field(
        min_length=5,
        description="Describe only the visible picture of the current line, keeping the nature of the original line as faithfully as possible",
    )
    scene_id: str = Field(
        default="",
        description="Fallback scene_id: use only when the system has not locked the scene_id of the current scene. It must be chosen exactly (string-equal) from this episode's scene menu, otherwise leave it empty.",
    )

    @field_validator("scene_id")
    @classmethod
    def validate_scene_id(cls, value: str, info: ValidationInfo) -> str:
        scene_id = (value or "").strip()
        if not scene_id:
            return ""
        valid_scene_ids = set((info.context or {}).get("valid_scene_ids") or [])
        if valid_scene_ids and scene_id not in valid_scene_ids:
            return ""
        return scene_id

    @field_validator("visual_description")
    @classmethod
    def validate_visual_description(cls, value: str, info: ValidationInfo) -> str:
        visual_description = cls._validate_marked_text(
            value, info, field_name="visual_description"
        )
        if _ALTERNATIVE_RE.search(visual_description):
            raise ValueError(
                "visual_description must be one definite picture and must not contain alternatives such as 'or / either'"
            )
        return visual_description

    @classmethod
    def _validate_marked_text(
        cls,
        value: str,
        info: ValidationInfo,
        *,
        field_name: str,
    ) -> str:
        text = (value or "").strip()
        if not text:
            return ""
        valid_identity_ids = set((info.context or {}).get("valid_identity_ids") or [])
        valid_prop_ids = set((info.context or {}).get("valid_prop_ids") or [])

        markers = extract_char_identities_from_markers(text, strict=True)
        if valid_identity_ids:
            invalid_identity_ids = sorted(
                identity_id
                for identity_id in markers.values()
                if identity_id not in valid_identity_ids
            )
            if invalid_identity_ids:
                raise ValueError(
                    f"{field_name} contains illegal character markers: {invalid_identity_ids}; {{{{}}}} may only be used for identity_ids in the identity menu"
                )

        prop_marker_ids = extract_prop_ids_from_markers(text, strict=True)
        if valid_prop_ids:
            invalid_prop_ids = sorted(
                prop_id for prop_id in prop_marker_ids if prop_id not in valid_prop_ids
            )
            if invalid_prop_ids:
                raise ValueError(
                    f"{field_name} contains illegal prop markers: {invalid_prop_ids}; [[ ]] may only be used for prop_ids in the prop menu"
                )

        for identity_id in sorted(valid_identity_ids):
            if identity_id in text and f"{{{{{identity_id}}}}}" not in text:
                raise ValueError(
                    f"{field_name} contains a bare identity_id '{identity_id}'; it must be wrapped as {{{{{identity_id}}}}}"
                )

        return text

    @field_validator("audio_type")
    @classmethod
    def validate_audio_type(cls, value: str) -> str:
        audio_type = (value or "").strip()
        if audio_type not in {"silence", "narration", "dialogue"}:
            raise ValueError("audio_type must be silence/narration/dialogue")
        return audio_type

    @field_validator("speaker_kind")
    @classmethod
    def validate_speaker_kind(cls, value: str) -> str:
        speaker_kind = (value or "").strip()
        if speaker_kind not in {"character", "non_character"}:
            raise ValueError("speaker_kind must be character or non_character")
        return speaker_kind

    @model_validator(mode="after")
    def validate_dialogue_speaker(self) -> "LiteralBeatMetaOutput":
        if self.audio_type == "dialogue" and not (self.speaker or "").strip():
            raise ValueError("speaker must be filled in when audio_type=dialogue")
        if self.audio_type in {"silence", "narration"}:
            self.speaker = ""
            self.speaker_kind = "character"
        return self


LITERAL_SCRIPT_PROMPT = """# You are a line-by-line storyboard annotator for short-drama screenplays

Your task is not to rewrite the whole episode, but to complete the 2.0 beat metadata strictly around "the current line of the script".

## Core principles
- One line = one beat
- Do not rewrite the original line, do not merge lines, do not summarize the plot
- You must judge and output `audio_type` / `speaker` / `speaker_kind` together; these judgments must strictly follow the text of the original line and must not be filled in from common sense
- The job of `visual_description` is to reproduce, as fully as possible, the visible picture information the current line already gives, without making directorial decisions for the later storyboard stage
- Prefer to faithfully keep the nature of the original line's picture: if the line itself is a composite picture, screen picture, memory dissolve, split-screen live stream, surveillance viewpoint, etc., do not force it into a "single shot" by rewriting
- If a line starts with a shot/camera-position/picture cue, do not misjudge it as a speaker; judge it as dialogue only when it is clearly "character name: spoken line"
- Only when necessary, flesh out the original line into more drawable body actions, postures and spatial relationships; do not arbitrarily expand the original line into a new shot design
- The scene and time of the current beat are determined by the current scene heading; do not rewrite the scene and do not switch to another scene_id
- Only named props that physically appear, are held, are operated or are looked at are marked with `[[prop_id]]` in `visual_description`

## visual_description rules
- Describe only the picture that is really visible in this beat of the current line
- If `audio_type=dialogue`, the default subject of the picture is the speaker's speaking posture, expression or action; turn to the other party only when the original line explicitly says the other party's reaction/action is the focus
- If the current line explicitly contains picture cues such as `[close_up]` / `[first_person]` / `[high_angle]` / `[low_angle]` / `[empty]` / `[black]`, `visual_description` must keep these cues verbatim; do not drop them and do not rewrite them into explanatory sentences
- If the original line itself contains a composite picture device or composite expression, keep that picture nature directly and do not force it into a single shot
- visual_description must be one definite picture; do not write alternatives such as "or / optional / either-or / A or B"
- Do not compress the content of multiple lines into this beat, and do not proactively add new time switches, new space switches or new shot arrangements that the original line does not have
- Do not write a prop/asset into the current beat early just because it is in the candidate menu; write it only when the current line text explicitly mentions it or it is explicitly visible
- For asymmetric interactions such as grab / hold down / force-feed / hand over / choke / support / restrain, you must state clearly the active party/passive party and the hand geometry
- If a field should be left empty, leave it empty directly; do not write explanatory text such as "should theoretically be" or "not noted in the original line, left empty"
- If a dialogue line contains only the spoken content and no parenthesized action, do not invent additional body actions; at most keep the minimal speaking state of "speaking / looking at the other party / opening the mouth"

## Character marker rules
- Character markers in `visual_description` use `{{identity_id}}`, and are given preferentially only to characters who are "physically visible and in the identity menu"
- Character marker priority:
    1. The speaker of a `dialogue` beat preferably uses `{{identity_id}}`
    2. Other physically visible characters in the identity menu should also preferably use `{{identity_id}}`
    3. Characters at the core of the current action take priority over unimportant supporting characters
- If a known character from the identity menu appears in the picture and is physically visible, `visual_description` should preferably use `{{identity_id}}`
- Known characters clearly visible in the background but not the subject should also preferably use `{{identity_id}}`
- If a screen, TV, photo or memory image shows a clearly visible specific person and the context identifies them as a character age-identity in the identity menu, `{{identity_id}}` must also be used
- Do not use `{{identity_id}}` for characters outside the menu, passers-by, generic characters, or people who are only mentioned/recalled without an actual visible picture
- `{{}}` may only be used for character identity_ids; do not put scene names or prop names in `{{}}`

## Prop marker rules
- Known props that are physically visible, held, operated or watched in `visual_description` preferably use `[[prop_id]]`
- `[[ ]]` may only be used for prop_ids in the prop menu
- Do not put characters in `[[ ]]`, and do not put props in `{{}}`
- The state of a prop, its placement and who is holding it all go into `visual_description`

## audio / speaker rules
- Use `audio_type=dialogue` only for an explicit "known character / physically present person: spoken line" or an equivalent explicit character utterance
- If the original line is clearly narration, commentary, voice-over, broadcast, a surveillance-room voice, off-screen sound or a non-character sound source that needs to be read aloud, use `audio_type=narration` and do not output `dialogue`
- Action descriptions, environment descriptions, empty shots, picture notes, time captions, shot cues and stage directions should preferably be judged as `audio_type=silence` even when they contain a colon
- `speaker` must be filled in when `audio_type=dialogue`
- If the speaker of a `dialogue` corresponds to a known character in the identity menu, `speaker` should preferably output the corresponding `identity_id` directly, not just the bare character name
- When `audio_type=narration`, leave `speaker` empty; broadcast/voice-over/screen sound/non-character sound should also be classified as narration with `speaker` left empty
- `speaker_kind=non_character` is used only for non-physical-character sound sources such as broadcasts, voice-overs, subtitles, on-screen text and system announcements

## scene / prop rules
- Props are expressed only through `[[prop_id]]` in `visual_description`; `[[prop_id]]` may only be chosen from the candidate prop menu
- Do not invent new prop_ids or new scene_ids

## scene_id fallback rules (use only when the system has not locked the scene_id)
- The system normally parses the scene_id from the "current scene heading" and gives it in the context. When the "current scene_id" is locked, the `scene_id` field must be left empty; do not output it again.
- Only when "current scene_id: not locked" do you need to **exactly** choose one scene_id from the "scene menu of this episode" and fill it into the `scene_id` field.
- Basis for choosing: the location field of the current scene heading, the raw label of the scene, and the visible spatial clues in the current line's visual_description (front door / elevator / street / noodle shop / home / cyberspace / 3D big screen...).
- It must be **string-equal** to a scene_id in the scene menu of this episode; do not invent new names and do not abbreviate loosely.
- If the current line explicitly takes place in a void / black screen / no scene and the menu has no matching entry, leave it empty.

## Output
- Output only the structured metadata of the current line
- Do not explain and do not restate the original line
"""


def split_literal_source_text(source_text: str) -> list[str]:
    return split_screenplay_lines(source_text)


def _parse_scene_characters(character_text: str) -> list[str]:
    return parse_character_line(character_text)


def _parse_scene_block_location(location_text: str) -> tuple[str, str, str]:
    parsed = parse_location_header(location_text)
    if parsed:
        return parsed
    return (location_text or "").strip(), "", ""


class LiteralScriptWritingWorkflow:
    """Line-by-line script workflow adapted to the 2.0 beat schema."""

    def __init__(
        self,
        cognee_store: Any,
        sqlite_store: Any | None = None,
        output_dir: str = "",
        audio_type_mode: str = "literal",
    ) -> None:
        self.cognee_store = cognee_store
        self.sqlite_store = sqlite_store or cognee_store
        self.output_dir = output_dir
        self.audio_type_mode = (
            "narrated" if audio_type_mode == "narrated" else "literal"
        )
        self._current_episode = 1
        self._agent: Agent | None = None
        self._valid_identity_ids: set[str] = set()
        self._valid_scene_ids: set[str] = set()
        self._scene_menu_split: dict[str, tuple[str, str, str]] = {}
        self._valid_prop_ids: set[str] = set()
        self._identity_section = ""
        self._scene_section = ""
        self._prop_section = ""
        self._output_language: AssetLanguage = "en"
        self.last_review_passed = True
        self.last_review_summary = "Line-by-line script mode"
        self.last_degraded_lines: list[int] = []

    @property
    def agent(self) -> Agent:
        if self._agent is None:
            self._agent = Agent(
                get_newapi_text_pydantic_model(
                    "LITERAL_BEAT_META_MODEL",
                    brainclaw_profile=BrainClawProfile.LITERAL_BEAT_METADATA,
                    capability="text.generate.workflow",
                ),
                system_prompt=(
                    f"{LITERAL_SCRIPT_PROMPT}\n"
                    f"{asset_language_instruction(self._output_language)}"
                ),
                model_settings=get_newapi_structured_output_model_settings(),
                output_type=LiteralBeatMetaOutput,
                output_retries=model_gateway_output_retries(2),
                validation_context={
                    "valid_identity_ids": self._valid_identity_ids,
                    "valid_scene_ids": self._valid_scene_ids,
                    "valid_prop_ids": self._valid_prop_ids,
                },
                name="Line-by-line script storyboard annotator",
            )
        return self._agent

    async def run(
        self,
        *,
        episode_num: int,
        source_text: str | None = None,
        target_duration: float | None = None,
        narration_style: str = "first_person",
        visual_style: str = "chinese_period_drama",
        protagonist_name: str = "",
        on_progress: Optional[Callable[[float, str], None]] = None,
        on_log: Optional[Callable[[str], None]] = None,
        **_: Any,
    ) -> NarrationScript:
        del target_duration, narration_style, protagonist_name

        def report_progress(progress: float, task: str) -> None:
            if on_progress:
                on_progress(progress, task)

        def log(message: str) -> None:
            if on_log:
                on_log(message)

        self._current_episode = episode_num
        self._agent = None
        self._identity_section = ""
        self._scene_section = ""
        self._prop_section = ""
        self.last_review_passed = True
        self.last_review_summary = "Line-by-line script mode"
        self.last_degraded_lines = []

        await self.cognee_store.load_graph_state()
        episode = await self.sqlite_store.get_episode_from_graph(episode_num)
        if not episode:
            raise ValueError(f"No plan found for episode {episode_num}")

        if source_text is None:
            source_text = await load_episode_planning_content(
                self.cognee_store,
                episode,
            )
        if not source_text.strip():
            raise ValueError("The source text of the current episode is empty; cannot generate the script line by line")
        self._output_language = detect_asset_language(source_text)

        quality_report = check_screenplay_import_quality(source_text)
        for issue in quality_report.blocking_issues:
            log(
                f"[Literal][Quality][blocking-as-warning] {issue.code}: {issue.message}"
            )
        for issue in quality_report.warnings:
            log(f"[Literal][Quality][warning] {issue.code}: {issue.message}")

        # These calls are currently used mainly to populate the episode-level valid sets (_valid_*),
        # the block compiler and fallback still depend on these full-set truths; the returned *_section text is kept only as a debugging leftover.
        self._identity_section, self._valid_identity_ids = (
            self._build_identity_menu_for_episode(episode_num)
        )
        self._scene_section = self._build_scene_menu_for_episode(episode)
        self._prop_section = self._build_prop_menu_for_episode(episode)
        episode_identity_ids = set(self._valid_identity_ids)
        episode_identity_default_map = dict(
            getattr(episode, "identity_default_map", {}) or {}
        )
        episode_prop_ids = set(self._valid_prop_ids)
        identity_metadata = self._build_identity_metadata(episode_identity_ids)
        prop_metadata = self._build_prop_metadata(episode)

        lines = split_literal_source_text(source_text)
        if not lines:
            raise ValueError("The source text could not be split into valid lines")

        scene_blocks = self._build_scene_blocks(lines)
        for block_index, block in enumerate(scene_blocks):
            block.context = self._compile_scene_block_context(
                block,
                block_index,
                episode,
                episode_identity_ids,
                episode_identity_default_map,
                episode_prop_ids,
                identity_metadata,
                prop_metadata,
                on_log=log,
            )
        line_contexts = self._build_scene_line_contexts(
            scene_blocks, source_lines=lines
        )
        if not line_contexts:
            raise ValueError("The source text could not be split into valid scene content")

        report_progress(0.05, "Splitting the script by line...")
        log(f"[Literal] Split into {len(lines)} lines, identified {len(scene_blocks)} scene blocks")

        beats: list[VisualBeat] = []
        total = max(1, len(line_contexts))
        current_block: SceneBlock | None = None
        episode_sticky_identities: dict[str, str] = dict(episode_identity_default_map)
        block_sticky_identities: dict[str, str] = {}
        safe_prompt_history: list[str] = []

        for content_index, line_ctx in enumerate(line_contexts, start=1):
            raw_line = line_ctx.raw_line
            content_filtered = False
            block = line_ctx.scene_block
            if block is not current_block:
                current_block = block
                block_sticky_identities = dict(episode_sticky_identities)
                safe_prompt_history = []
                block_ctx = block.context
                narrowed_identity_ids = (
                    set(block_ctx.candidate_identity_ids)
                    if block_ctx and block_ctx.candidate_identity_ids
                    else set(episode_identity_ids)
                )
                if (
                    block_ctx
                    and not block_ctx.candidate_identity_ids
                    and block_ctx.identity_fallback_reason
                ):
                    log(f"[Literal Block] {block_ctx.identity_fallback_reason}")
                narrowed_prop_ids = (
                    set(block_ctx.candidate_prop_ids)
                    if block_ctx and block_ctx.candidate_prop_ids
                    else set(episode_prop_ids)
                )
                self._valid_identity_ids.clear()
                self._valid_identity_ids.update(narrowed_identity_ids)
                self._valid_prop_ids.clear()
                self._valid_prop_ids.update(narrowed_prop_ids)

            current_scene_label = block.location
            current_scene_id = self._resolve_scene_id(block.location, episode)
            current_allowed_scene_ids = self._allowed_scene_ids_for_block(
                current_scene_id
            )
            current_time_of_day = block.time_of_day

            report_progress(
                0.08 + ((content_index - 1) / total) * 0.82,
                f"Generating line {content_index}/{total}...",
            )

            block_ctx = block.context
            block_menu_sections = [
                section.strip()
                for section in (
                    block_ctx.identity_section if block_ctx else "",
                    block_ctx.prop_section if block_ctx else "",
                )
                if section and section.strip()
            ]
            block_menu_text = (
                "\n\n".join(block_menu_sections)
                if block_menu_sections
                else "(no candidate assets, falling back to the episode menu)"
            )

            scene_id_fallback_section = ""
            if current_scene_id and current_allowed_scene_ids:
                scene_id_fallback_section = (
                    "\n\n## Current scene scene_id candidates\n"
                    f"The current base scene_id is locked to `{current_scene_id}`; "
                    "choose exactly one of the scene_ids below, or leave it empty to let the system fall back to the base scene.\n"
                    + "\n".join(
                        f"- `{sid}`" for sid in sorted(current_allowed_scene_ids)
                    )
                )
            elif self._valid_scene_ids:
                scene_id_fallback_section = (
                    "\n\n## Scene menu of this episode (scene_id fallback candidates)\n"
                    "The current scene_id is not locked; choose exactly one of the scene_ids below and fill it into the `scene_id` field; "
                    "leave it empty if nothing matches.\n"
                    + "\n".join(f"- `{sid}`" for sid in sorted(self._valid_scene_ids))
                )

            prev_beat_anchor = ""
            if beats:
                last = beats[-1]
                prev_identities = re.findall(
                    r"\{\{(.+?)\}\}", last.visual_description or ""
                )
                prev_props = extract_prop_ids_from_markers(
                    last.visual_description or "", strict=False
                )
                anchor_parts = []
                if prev_identities:
                    anchor_parts.append(f"Identities: {', '.join(prev_identities)}")
                if prev_props:
                    anchor_parts.append(f"Props: {', '.join(prev_props)}")
                if anchor_parts:
                    prev_beat_anchor = "- Previous beat selected: " + " | ".join(anchor_parts)

            sticky_lines = []
            if block_sticky_identities:
                for char_name, identity_id in sorted(block_sticky_identities.items()):
                    sticky_lines.append(f"  - {char_name} → `{identity_id}`")
            sticky_section = ""
            if sticky_lines:
                sticky_section = (
                    "- Results already locked for the current scene (keep using them unless there is strong evidence to switch):\n"
                    + "\n".join(sticky_lines)
                )

            prompt = f"""{asset_language_instruction(self._output_language)}

Complete the beat metadata for the current line of the script of episode {episode_num}.

## Episode information
- Title: {episode.title}
- Visual style config: {visual_style}

## Current scene candidate menu
{block_menu_text}{scene_id_fallback_section}

## Current scene context
- Raw text of the current scene heading: {block.header_line or "none"}
- Raw label of the current scene: {current_scene_label or "not locked"}
- Current scene_id: {current_scene_id or "not locked"}
- Current time_of_day: {current_time_of_day or "not locked"}
- Characters present in the current scene: {", ".join(block.characters) if block.characters else "not annotated"}
- Preceding lines of the current scene (at most 2 lines):
{chr(10).join(f"  - {item}" for item in safe_prompt_history) if safe_prompt_history else "  - none"}
{prev_beat_anchor or "- Previous beat selected: none"}
{sticky_section or "- Results already locked for the current scene: none"}
## Current line
- Line index: {content_index}/{total}
- Previous line: {safe_prompt_history[-1] if safe_prompt_history else "none"}
- Current line: {raw_line}
## Constraints
- narration_segment is shaped by the system from audio_type: dialogue extracts the spoken line, narration keeps the commentary text, silence leaves it empty; do not output narration_segment
{self._audio_type_mode_instruction()}
- The scene_id and time_of_day of the current beat are already locked by the current scene; do not rewrite them
- Props visible in the current line are marked with `[[prop_id]]` in visual_description
- Within the same scene block the same character keeps using the locked identity_id by default; switch only when the current line has strong evidence
- If the original line contains cues such as `[close_up]` / `[first_person]` / `[high_angle]` / `[low_angle]` / `[empty]` / `[black]`, they must be kept directly in visual_description
- Characters are marked only with `{{identity_id}}`, props only with `[[prop_id]]`
- visual_description must pick one definite picture; do not output "or / optional / either-or"
- The candidate asset menu is not a list of what is visible in the current line; do not write props/assets that do not explicitly appear in the current line into visual_description early
- `scene_id` field: current scene_id {"is already locked as a base; leave it empty or choose exactly from the current scene scene_id candidates" if current_scene_id else "is not locked; choose exactly one scene_id from the scene menu of this episode and fill it in; leave it empty if nothing matches"}
"""

            try:
                output, degraded = await self._run_line_metadata_with_resilience(
                    prompt=prompt,
                    raw_line=raw_line,
                    content_index=content_index,
                    total=total,
                    log=log,
                )
            except ContentFilterError as exc:
                for message in self._content_filter_log_messages(
                    content_index=content_index,
                    total=total,
                    line_ctx=line_ctx,
                    error=exc,
                ):
                    log(message)
                log(
                    f"[Literal][WARN] Line {content_index}/{total} was not retried, "
                    "a safe placeholder Beat was used and processing continues with the following lines."
                )
                output = self._build_placeholder_line_metadata()
                degraded = True
                content_filtered = True
            if degraded:
                self.last_degraded_lines.append(content_index)

            resolved_scene_id = (current_scene_id or "").strip()
            llm_scene_id = (output.scene_id or "").strip()
            if resolved_scene_id:
                if llm_scene_id and llm_scene_id in current_allowed_scene_ids:
                    resolved_scene_id = llm_scene_id
                elif llm_scene_id and llm_scene_id != current_scene_id:
                    log(
                        f"[Literal][WARN] beat {len(beats) + 1} scene_id `{llm_scene_id}` "
                        f"is not among the current scene candidates, falling back to `{current_scene_id}`"
                    )
            else:
                if llm_scene_id and llm_scene_id in self._valid_scene_ids:
                    resolved_scene_id = llm_scene_id
                    log(
                        f"[Literal] beat {len(beats) + 1} scene_id string match failed, "
                        f"LLM fallback chose `{llm_scene_id}` (block.location={current_scene_label!r})"
                    )
                else:
                    log(
                        f"[Literal][WARN] beat {len(beats) + 1} scene_id left empty "
                        f"(block.location={current_scene_label!r}, LLM output={llm_scene_id!r})"
                    )
            time_of_day = (current_time_of_day or "").strip()
            visual_description = output.visual_description.strip()
            audio_type = (
                "silence"
                if content_filtered
                else self._normalize_audio_type_for_mode(output.audio_type)
            )
            speaker_kind = (output.speaker_kind or "character").strip()
            speaker = (output.speaker or "").strip()
            audio_type, speaker = self._normalize_audio_metadata(
                audio_type=audio_type,
                speaker_kind=speaker_kind,
                speaker=speaker,
            )
            if audio_type != "dialogue":
                speaker_kind = "character"
            if audio_type == "dialogue" and speaker_kind == "character" and speaker:
                speaker = self._resolve_unit_speaker_label(speaker)
            narration_segment = (
                ""
                if content_filtered
                else self._derive_narration_segment(raw_line, audio_type)
            )

            beats.append(
                VisualBeat(
                    beat_number=len(beats) + 1,
                    narration_segment=narration_segment,
                    visual_description=visual_description,
                    time_of_day=time_of_day,
                    scene_ref=self._canonical_scene_ref_for_menu_choice(
                        resolved_scene_id
                    ),
                    audio_type=audio_type,
                    speaker=speaker,
                    speaker_kind=speaker_kind,
                    estimated_duration=0.0,
                )
            )

            identities_in_beat = re.findall(r"\{\{(.+?)\}\}", visual_description)
            for identity_id in identities_in_beat:
                char_name = (
                    identity_id.split("_", 1)[0] if "_" in identity_id else identity_id
                )
                if char_name and char_name not in block_sticky_identities:
                    block_sticky_identities[char_name] = identity_id
                if char_name and char_name not in episode_sticky_identities:
                    episode_sticky_identities[char_name] = identity_id
            safe_prompt_history.append(
                "[previous line not provided due to content moderation]" if content_filtered else raw_line
            )
            safe_prompt_history = safe_prompt_history[-2:]
            log(f"[Literal] line {content_index}/{total} -> {audio_type}")

        if self.last_degraded_lines:
            self.last_review_passed = False
            degraded_text = ", ".join(str(index) for index in self.last_degraded_lines)
            self.last_review_summary = (
                f"Line-by-line script completed; {len(self.last_degraded_lines)} lines could not be generated normally by the model, "
                f"a degraded Beat was used (content lines: {degraded_text}); review them and retry individually if needed."
            )

        self._valid_identity_ids.clear()
        self._valid_identity_ids.update(episode_identity_ids)
        self._valid_prop_ids.clear()
        self._valid_prop_ids.update(episode_prop_ids)

        script = NarrationScript(
            episode_number=episode_num,
            title=getattr(episode, "title", f"Episode {episode_num}"),
            beats=beats,
            total_duration_seconds=0.0,
        )
        report_progress(0.93, "Saving the script...")
        await self.cognee_store.persist_narration_script(script)
        report_progress(1.0, "Done")
        return script

    async def _run_line_metadata_with_resilience(
        self,
        *,
        prompt: str,
        raw_line: str,
        content_index: int,
        total: int,
        log: Callable[[str], None],
    ) -> tuple[LiteralBeatMetaOutput, bool]:
        """Retry an exhausted structured output once, then preserve the source line."""

        try:
            result = await self.agent.run(prompt)
            return result.output, False
        except ContentFilterError:
            raise
        except UnexpectedModelBehavior as first_error:
            if not _is_output_retry_exhaustion(first_error):
                raise
            log(
                f"[Literal][WARN] Line {content_index}/{total} structured output failed, "
                f"calling the model again: {_short_log_text(str(first_error), limit=180)}"
            )

        try:
            result = await self.agent.run(prompt)
            return result.output, False
        except ContentFilterError:
            raise
        except UnexpectedModelBehavior as second_error:
            if not _is_output_retry_exhaustion(second_error):
                raise
            log(
                f"[Literal][WARN] Line {content_index}/{total} still failed after retry, "
                "a local fallback Beat was generated from the source text and processing continues with the following lines."
            )
            log(
                f"[Literal][WARN] Line {content_index}/{total} final model error: "
                f"{_short_log_text(str(second_error), limit=180)}"
            )
            return self._build_fallback_line_metadata(raw_line), True

    def _build_placeholder_line_metadata(self) -> LiteralBeatMetaOutput:
        """Build a safe beat without reusing content rejected by the provider."""

        return LiteralBeatMetaOutput(
            audio_type="silence",
            speaker="",
            speaker_kind="character",
            visual_description="This line could not be generated; please complete it manually.",
            scene_id="",
        )

    def _build_fallback_line_metadata(self, raw_line: str) -> LiteralBeatMetaOutput:
        """Build a minimal usable beat without inventing story information."""

        line = (raw_line or "").strip()
        speaker, speech = self._split_dialogue_line(line)
        non_character_tokens = (
            "narrator",
            "narration",
            "voice-over",
            "voiceover",
            "off-screen",
            "broadcast",
            "announcement",
            "subtitle",
            "caption",
            "lời dẫn",
            "người dẫn chuyện",
            "giọng ngoài khung hình",
            "phát thanh",
            "phụ đề",
        )
        is_non_character = bool(
            speaker and any(token in speaker.lower() for token in non_character_tokens)
        )
        if speaker and not is_non_character:
            audio_type = "dialogue"
            fallback_speaker = speaker
            visual_description = f"{speaker} speaks."
        elif speaker and is_non_character:
            audio_type = "narration"
            fallback_speaker = ""
            visual_description = speech or line
        else:
            audio_type = (
                "narration" if self.audio_type_mode == "narrated" else "silence"
            )
            fallback_speaker = ""
            visual_description = line

        # Keep unvalidated asset markers out of later generation, but keep the source semantics.
        visual_description = (
            visual_description.replace("{{", "")
            .replace("}}", "")
            .replace("[[", "")
            .replace("]]", "")
            .strip()
        )
        if len(visual_description) < 5:
            visual_description = (
                f"Visual source line: {visual_description or 'blank line'}"
            )

        return LiteralBeatMetaOutput.model_construct(
            audio_type=audio_type,
            speaker=fallback_speaker,
            speaker_kind="non_character" if is_non_character else "character",
            visual_description=visual_description,
            scene_id="",
        )

    async def run_all_episodes(self) -> list[NarrationScript]:
        episodes = await self.sqlite_store.list_episodes()
        scripts: list[NarrationScript] = []
        for episode in episodes:
            scripts.append(await self.run(episode_num=episode.number))
        return scripts

    def _build_identity_menu_for_episode(
        self, episode_number: int
    ) -> tuple[str, set[str]]:
        episode = self.sqlite_store.get_episode(episode_number)
        ep_identity_ids = (
            set(episode.identity_ids) if episode and episode.identity_ids else set()
        )
        if not ep_identity_ids:
            return "", set()

        lines = ["\n## Identity menu available for this episode"]
        valid_ids: set[str] = set()
        by_character: dict[str, list[str]] = {}
        for identity_id in sorted(ep_identity_ids):
            char_name = (
                identity_id.split("_", 1)[0] if "_" in identity_id else identity_id
            )
            by_character.setdefault(char_name, []).append(identity_id)
            valid_ids.add(identity_id)

        for char_name, ids in by_character.items():
            lines.append(f"### {char_name}")
            for identity_id in ids:
                lines.append(f"- `{identity_id}`")
        return "\n".join(lines) + "\n", valid_ids

    def _build_scene_menu_for_episode(self, episode: Any) -> str:
        scene_menu = list(getattr(episode, "scene_menu", []) or [])
        self._valid_scene_ids.clear()
        self._scene_menu_split.clear()
        for item in scene_menu:
            scene_id = str(getattr(item, "scene_id", "") or "").strip()
            if not scene_id:
                continue
            self._valid_scene_ids.add(scene_id)
            base_scene_id = str(getattr(item, "base_scene_id", "") or "").strip()
            variant_id = str(getattr(item, "variant_id", "") or "").strip()
            time_of_day = str(getattr(item, "time_of_day", "") or "").strip()
            if base_scene_id and (variant_id or time_of_day):
                self._scene_menu_split[scene_id] = (
                    base_scene_id,
                    variant_id,
                    time_of_day,
                )
        if not scene_menu:
            return "\n## Scene menu available for this episode\n- none\n"
        lines = ["\n## Scene menu available for this episode"]
        for item in scene_menu:
            lines.append(f"- `{item.scene_id}`")
        return "\n".join(lines) + "\n"

    def _base_ids(self) -> set[str]:
        derived_ids = set(self._scene_menu_split)
        return {
            scene_id
            for scene_id in self._valid_scene_ids
            if scene_id not in derived_ids
        }

    def _allowed_scene_ids_for_block(self, base_id: str) -> set[str]:
        base_id = str(base_id or "").strip()
        if not base_id:
            return set()
        allowed = {base_id} if base_id in self._valid_scene_ids else set()
        allowed.update(
            scene_id
            for scene_id, (item_base, _variant, _time) in self._scene_menu_split.items()
            if item_base == base_id
        )
        return allowed

    def _canonical_scene_ref_for_menu_choice(self, scene_id: str) -> SceneRef | None:
        scene_id = str(scene_id or "").strip()
        if not scene_id:
            return None
        base_scene_id, variant_id, time_of_day = self._scene_menu_split.get(
            scene_id, ("", "", "")
        )
        if base_scene_id and (variant_id or time_of_day):
            return build_scene_ref(base_scene_id, variant_id)
        return build_scene_ref(scene_id)

    def _build_prop_menu_for_episode(self, episode: Any) -> str:
        prop_menu = list(getattr(episode, "prop_menu", []) or [])
        self._valid_prop_ids.clear()
        self._valid_prop_ids.update(item.prop_id for item in prop_menu if item.prop_id)
        if not prop_menu:
            return "\n## Prop menu available for this episode\n- none\n"
        lines = ["\n## Prop menu available for this episode"]
        for item in prop_menu:
            scope = str(getattr(item, "scope", "") or "episode").strip()
            description = str(getattr(item, "description", "") or "").strip()
            meta = []
            if scope:
                meta.append(f"scope={scope}")
            suffix = f" ({', '.join(meta)})" if meta else ""
            desc_suffix = f" — {description}" if description else ""
            lines.append(f"- `{item.prop_id}`{suffix}{desc_suffix}")
        return "\n".join(lines) + "\n"

    @staticmethod
    def _normalize_match_text(value: str) -> str:
        text = str(value or "").strip()
        return re.sub(
            r"[\s\u3000\u00b7\u2022.,:/()\\\-_\[\]{}]+", "", text
        ).lower()

    @classmethod
    def _contains_text(cls, haystack: str, needle: str) -> bool:
        normalized_needle = cls._normalize_match_text(needle)
        if not normalized_needle:
            return False
        return normalized_needle in cls._normalize_match_text(haystack)

    def _build_identity_metadata(
        self, episode_identity_ids: set[str]
    ) -> dict[str, dict[str, Any]]:
        metadata: dict[str, dict[str, Any]] = {}
        for character in self.cognee_store.get_all_characters():
            aliases = [
                str(alias or "").strip()
                for alias in (getattr(character, "aliases", []) or [])
                if str(alias or "").strip()
            ]
            for identity in getattr(character, "identities", []) or []:
                identity_id = str(getattr(identity, "identity_id", "") or "").strip()
                if not identity_id or identity_id not in episode_identity_ids:
                    continue
                metadata[identity_id] = {
                    "character_name": str(getattr(character, "name", "") or "").strip(),
                    "character_aliases": aliases,
                    "identity_name": str(
                        getattr(identity, "identity_name", "") or ""
                    ).strip(),
                }
        return metadata

    def _build_prop_metadata(self, episode: Any) -> dict[str, dict[str, Any]]:
        global_props = {
            str(prop.name or "").strip(): prop
            for prop in self.cognee_store._props.values()
            if str(getattr(prop, "name", "") or "").strip()
        }
        metadata: dict[str, dict[str, Any]] = {}
        for item in list(getattr(episode, "prop_menu", []) or []):
            prop_id = str(getattr(item, "prop_id", "") or "").strip()
            if not prop_id:
                continue
            prop_obj = global_props.get(prop_id)
            aliases = []
            if prop_obj:
                aliases = [
                    str(alias or "").strip()
                    for alias in (getattr(prop_obj, "aliases", []) or [])
                    if str(alias or "").strip()
                ]
            metadata[prop_id] = {
                "aliases": aliases,
                "description": str(getattr(item, "description", "") or "").strip(),
            }
        return metadata

    def _format_identity_section(
        self, candidate_identity_ids: set[str], episode_identity_ids: set[str]
    ) -> str:
        if not candidate_identity_ids:
            return ""
        lines = ["## Candidate identities of the current scene"]
        grouped: dict[str, list[str]] = {}
        for identity_id in sorted(candidate_identity_ids):
            character_name = (
                identity_id.split("_", 1)[0] if "_" in identity_id else identity_id
            )
            grouped.setdefault(character_name, []).append(identity_id)
        for character_name in sorted(grouped):
            lines.append(f"### {character_name}")
            for identity_id in grouped[character_name]:
                marker = "" if identity_id in episode_identity_ids else " (not an identity of this episode)"
                lines.append(f"- `{identity_id}`{marker}")
        return "\n".join(lines)

    def _format_prop_section(self, candidate_prop_ids: set[str]) -> str:
        if not candidate_prop_ids:
            return ""
        lines = ["## Candidate props of the current scene"]
        for prop_id in sorted(candidate_prop_ids):
            lines.append(f"- `{prop_id}`")
        return "\n".join(lines)

    def _compile_scene_block_context(
        self,
        block: SceneBlock,
        block_index: int,
        episode: Any,
        episode_identity_ids: set[str],
        episode_identity_default_map: dict[str, str],
        episode_prop_ids: set[str],
        identity_metadata: dict[str, dict[str, Any]],
        prop_metadata: dict[str, dict[str, Any]],
        on_log: Optional[Callable[[str], None]] = None,
    ) -> SceneBlockContext:
        block_text = "\n".join(
            item
            for item in [block.header_line, *block.lines]
            if str(item or "").strip()
        )
        matched_identities_by_character: dict[str, list[str]] = {}
        speaker_candidates: set[str] = set()
        for line in block.lines:
            speaker, _ = self._split_dialogue_line(line)
            if speaker:
                speaker_candidates.add(speaker)
        explicit_character_tokens = set(block.characters) | speaker_candidates
        explicit_character_tokens = {
            str(token or "").strip()
            for token in explicit_character_tokens
            if str(token or "").strip()
        }

        for identity_id in sorted(episode_identity_ids):
            meta = identity_metadata.get(identity_id, {})
            character_name = str(meta.get("character_name", "") or "").strip()
            aliases = list(meta.get("character_aliases", []) or [])
            identity_name = str(meta.get("identity_name", "") or "").strip()
            tokens = [character_name, *aliases, identity_id, identity_name]
            matched = any(
                self._contains_text(block_text, token) for token in tokens if token
            )
            matched = matched or any(
                self._contains_text(token, character_name)
                or any(self._contains_text(token, alias) for alias in aliases)
                for token in explicit_character_tokens
                if character_name
            )
            if not matched or not character_name:
                continue
            matched_identities_by_character.setdefault(character_name, []).append(
                identity_id
            )

        candidate_identity_ids: set[str] = set()
        for character_name, identity_ids in matched_identities_by_character.items():
            if len(identity_ids) == 1:
                candidate_identity_ids.update(identity_ids)
                continue
            scored = []
            for identity_id in identity_ids:
                meta = identity_metadata.get(identity_id, {})
                identity_name = str(meta.get("identity_name", "") or "").strip()
                score = 0
                if identity_name and self._contains_text(block_text, identity_name):
                    score += 2
                if identity_name and self._contains_text(
                    block.header_line, identity_name
                ):
                    score += 1
                scored.append((score, identity_id))
            max_score = max(score for score, _ in scored)
            narrowed = [
                identity_id
                for score, identity_id in scored
                if score == max_score and score > 0
            ]
            if narrowed:
                candidate_identity_ids.update(narrowed)
            else:
                default_identity_id = str(
                    episode_identity_default_map.get(character_name, "") or ""
                ).strip()
                if default_identity_id and default_identity_id in identity_ids:
                    candidate_identity_ids.add(default_identity_id)
                    if on_log:
                        on_log(
                            f"[Literal Block] Default identity fallback: "
                            f"{character_name} -> {default_identity_id}"
                        )
                else:
                    candidate_identity_ids.update(identity_ids)
                    if on_log:
                        on_log(
                            f"[Literal Block] Identity cannot be distinguished (no identity_name text evidence): "
                            f"{character_name} -> {', '.join(sorted(identity_ids))}"
                        )

        identity_fallback_reason = ""
        if not candidate_identity_ids and explicit_character_tokens:
            identity_fallback_reason = "Identity candidates are empty, falling back to the episode identity pool: " + ", ".join(
                sorted(explicit_character_tokens)
            )

        candidate_prop_ids: set[str] = set()
        for prop_id in sorted(episode_prop_ids):
            meta = prop_metadata.get(prop_id, {})
            aliases = list(meta.get("aliases", []) or [])
            tokens = [prop_id, *aliases]
            if any(self._contains_text(block_text, token) for token in tokens if token):
                candidate_prop_ids.add(prop_id)

        return SceneBlockContext(
            candidate_identity_ids=candidate_identity_ids,
            candidate_prop_ids=candidate_prop_ids,
            identity_fallback_reason=identity_fallback_reason,
            identity_section=self._format_identity_section(
                candidate_identity_ids, episode_identity_ids
            ),
            prop_section=self._format_prop_section(candidate_prop_ids),
        )

    @staticmethod
    def _parse_scene_block_header(line: str) -> dict[str, Any] | None:
        blocks = parse_scene_blocks([(line or "").strip()])
        if not blocks:
            return None
        block = blocks[0]
        if not block.header_line or not block.location:
            return None
        return {
            "header_line": block.header_line,
            "location": block.location,
            "time_of_day": normalize_time_of_day(block.time_of_day),
            "interior_exterior": block.interior_exterior,
            "characters": list(block.characters),
        }

    @staticmethod
    def _parse_scene_header(line: str) -> dict[str, str] | None:
        block_header = LiteralScriptWritingWorkflow._parse_scene_block_header(line)
        if block_header:
            return {
                "location": str(block_header.get("location") or "").strip(),
                "time_of_day": str(block_header.get("time_of_day") or "").strip(),
            }

        parsed = parse_location_header((line or "").strip())
        if not parsed:
            return None
        location, time_of_day, _interior_exterior = parsed
        return {
            "location": location,
            "time_of_day": normalize_time_of_day(time_of_day),
        }

    @classmethod
    def _build_scene_blocks(cls, lines: list[str]) -> list[SceneBlock]:
        parsed_blocks = parse_scene_blocks(lines)
        return [
            SceneBlock(
                header_line=block.header_line,
                location=block.location,
                time_of_day=normalize_time_of_day(block.time_of_day),
                interior_exterior=block.interior_exterior,
                characters=list(block.characters),
                lines=list(block.lines),
            )
            for block in parsed_blocks
            if block.header_line or block.lines
        ]

    @staticmethod
    def _build_scene_line_contexts(
        blocks: list[SceneBlock],
        window: int = 2,
        source_lines: list[str] | None = None,
    ) -> list[SceneLineContext]:
        entries: list[SceneLineContext] = []
        source_cursor = 0
        source_lines = list(source_lines or [])
        for block in blocks:
            scene_lines = [line for line in block.lines if line.strip()]
            for idx, raw_line in enumerate(scene_lines):
                source_line_number = 0
                if source_lines:
                    for source_idx in range(source_cursor, len(source_lines)):
                        if source_lines[source_idx] == raw_line:
                            source_line_number = source_idx + 1
                            source_cursor = source_idx + 1
                            break
                prev_window = scene_lines[max(0, idx - window) : idx]
                next_line = scene_lines[idx + 1] if idx + 1 < len(scene_lines) else ""
                entries.append(
                    SceneLineContext(
                        raw_line=raw_line,
                        scene_block=block,
                        prev_window=prev_window,
                        next_line=next_line,
                        source_line_number=source_line_number,
                    )
                )
        return entries

    @staticmethod
    def _split_dialogue_line(line: str) -> tuple[str, str]:
        match = DIALOGUE_RE.match((line or "").strip())
        if not match:
            return "", ""
        speaker = re.sub(r"\(.*?\)", "", match.group("speaker")).strip()
        speech = (match.group("speech") or "").strip()
        return speaker, speech

    @classmethod
    def _derive_narration_segment(cls, raw_line: str, audio_type: str) -> str:
        line = (raw_line or "").strip()
        if audio_type == "silence":
            return ""
        if audio_type == "dialogue":
            _, speech = cls._split_dialogue_line(line)
            if speech:
                return speech
        return line

    def _normalize_audio_type_for_mode(self, audio_type: str) -> str:
        normalized = (audio_type or "silence").strip()
        if self.audio_type_mode == "narrated" and normalized == "silence":
            return "narration"
        return normalized

    @staticmethod
    def _normalize_audio_metadata(
        *,
        audio_type: str,
        speaker_kind: str,
        speaker: str,
    ) -> tuple[str, str]:
        normalized_type = (audio_type or "silence").strip()
        normalized_speaker_kind = (speaker_kind or "character").strip()
        normalized_speaker = (speaker or "").strip()
        if normalized_type == "dialogue" and normalized_speaker_kind == "non_character":
            return "narration", ""
        if normalized_type in {"silence", "narration"}:
            return normalized_type, ""
        return normalized_type, normalized_speaker

    @staticmethod
    def _content_filter_log_messages(
        *,
        content_index: int,
        total: int,
        line_ctx: SceneLineContext,
        error: BaseException,
    ) -> list[str]:
        prev_line = line_ctx.prev_window[-1] if line_ctx.prev_window else ""
        current_line = line_ctx.raw_line
        next_line = line_ctx.next_line
        source_line_number = int(getattr(line_ctx, "source_line_number", 0) or 0)
        block = line_ctx.scene_block
        source_line_label = (
            f"Source text line {source_line_number}, " if source_line_number > 0 else ""
        )
        context_text = "\n".join([prev_line, current_line, next_line])
        hint_matches = _content_filter_hint_matches(context_text)
        messages = [
            (
                f"[Literal][ERROR] Line {content_index}/{total} generation failed: "
                "the upstream text model triggered the content safety filter (content_filter) and returned no parseable script content."
            ),
            (
                f"[Literal][ERROR] Line to modify ({source_line_label}content line {content_index}/{total}): "
                f"{_short_log_text(current_line, limit=300)}"
            ),
        ]
        if block.header_line or block.location:
            messages.append(
                "[Literal][ERROR] Scene it belongs to: "
                f"{_short_log_text(block.header_line or block.location, limit=180)}"
            )
        if prev_line or next_line:
            messages.append(
                "[Literal][ERROR] Context: "
                f"previous line={_short_log_text(prev_line, limit=180) or 'none'}; "
                f"next line={_short_log_text(next_line, limit=180) or 'none'}"
            )
        if hint_matches:
            messages.append(
                f"[Literal][ERROR] Possibly risky expressions found near line {content_index}/{total}: "
                + "; ".join(hint_matches)
            )
        else:
            messages.append(
                f"[Literal][ERROR] No clearly suspicious terms identified near line {content_index}/{total}, "
                "but the model still judged the input or potential output to violate the safety policy."
            )
        messages.append(
            "[Literal][ERROR] Suggestion: tone down the bloody, violent, coercive, nudity and similar expressions in this line and its surrounding lines, "
            "or switch this internal text model in RelayClaw to an upstream model better suited to screenplay writing and retry."
        )
        messages.append(
            "[Literal][ERROR] Note: the upstream model does not return the exact violated rule; the line numbers and suspected expressions above "
            "are located locally by Dramaclaw from the context of this request, for reference when editing the script."
        )
        messages.append(
            f"[Literal][ERROR] Original model error: {_short_log_text(str(error), limit=180)}"
        )
        return messages

    def _audio_type_mode_instruction(self) -> str:
        if self.audio_type_mode != "narrated":
            return (
                "- The current project uses the 2.0 short-drama line-by-line mode: "
                "you may output silence / narration / dialogue according to the nature of the original line."
            )
        return (
            "- The current project is a narrated drama: keep the 1.0 audio convention, audio_type may only be narration / dialogue, "
            "do not output silence; narration-script lines that are not explicit character dialogue must always output narration."
        )

    def _resolve_scene_id(self, location_label: str, episode: Any) -> str:
        location = (location_label or "").strip()
        if not location:
            return ""
        if not self._valid_scene_ids:
            scene_menu = list(getattr(episode, "scene_menu", []) or [])
            self._valid_scene_ids.update(
                item.scene_id for item in scene_menu if item.scene_id
            )
        base_ids = self._base_ids()
        for scene_id in base_ids:
            if scene_id == location:
                return scene_id
        for scene_id in base_ids:
            if location in scene_id or scene_id in location:
                return scene_id
        return ""

    def _resolve_unit_speaker_label(self, speaker: str) -> str:
        normalized = re.sub(r"\(.*?\)", "", (speaker or "")).strip()
        if not normalized:
            return ""
        if normalized in self._valid_identity_ids:
            return normalized
        exact_base = [
            iid
            for iid in self._valid_identity_ids
            if iid.split("_", 1)[0] == normalized
        ]
        if exact_base:
            for candidate in exact_base:
                if candidate.endswith("_default"):
                    return candidate
            return exact_base[0]
        return normalized


def create_literal_script_writing_workflow(
    cognee_store: Any,
    sqlite_store: Any | None = None,
    output_dir: str = "",
    genre: str = "",
    story_setting: str = "",
    audio_type_mode: str = "literal",
) -> LiteralScriptWritingWorkflow:
    del genre, story_setting
    return LiteralScriptWritingWorkflow(
        cognee_store=cognee_store,
        sqlite_store=sqlite_store or cognee_store,
        output_dir=output_dir,
        audio_type_mode=audio_type_mode,
    )
