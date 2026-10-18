"""Freezone text tool helpers.

Currently includes:
- English/Vietnamese prompt translation
- free-text generation
- story script generation
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field
from pydantic_ai import Agent

from novelvideo.egress_context import TrustedEgressContext
from novelvideo.model_gateway_runtime import (
    current_model_gateway_context,
    model_gateway_output_retries,
)

from novelvideo.official_defaults import (
    DEFAULT_FREEZONE_STORY_SCRIPT_MODEL,
    DEFAULT_FREEZONE_TEXT_WRITER_MODEL,
    DEFAULT_FREEZONE_TRANSLATION_MODEL,
)

FREEZONE_TRANSLATION_PROVIDER = "newapi"
FREEZONE_TRANSLATION_MODEL = DEFAULT_FREEZONE_TRANSLATION_MODEL
FREEZONE_TEXT_WRITER_MODEL = DEFAULT_FREEZONE_TEXT_WRITER_MODEL
FREEZONE_STORY_SCRIPT_MODEL = {
    "id": DEFAULT_FREEZONE_STORY_SCRIPT_MODEL,
    "provider": "newapi",
    "model": DEFAULT_FREEZONE_STORY_SCRIPT_MODEL,
    "label": "DramaClawAPI Story Script",
}
LEGACY_FREEZONE_STORY_SCRIPT_MODEL_IDS = {
    "newapi_gemini_flash",
    "openrouter_gemini_flash",
    "OpenRouter Gemini 2.5 Flash",
}

FREEZONE_TRANSLATION_SYSTEM_PROMPT = """# Freezone Prompt Translator

You translate prompting text between English and Vietnamese for creative nodes.

## Goal
- First determine the dominant natural language of the source text.
- If the dominant natural language is English, translate natural-language content into Vietnamese.
- If the dominant natural language is Vietnamese, translate natural-language content into English.
- Translate accurately while preserving prompting intent.
- Keep the output concise, directly usable as a prompt.
- Preserve cinematic, visual, audio, and motion terminology naturally.

## Rules
1. For mixed-language prompts, use the dominant natural language to decide the opposite target language.
2. Translate all natural-language content that should be user-readable into the target language.
3. Preserve line breaks, list structure, tags, and prompt segmentation when possible.
4. Keep IDs, asset markers, variable names, file names, model names, color codes, bracket tags, and technical tokens intact.
   Examples: [CM_6932], [YZSZ_974d], #00FFFF, 16:9, v2.0, fal.ai.
5. Do not add new details not present in the source.
6. For image/video/audio/text prompting, prefer natural creator-facing wording over literal textbook translation.
7. Only return the source directly when the detected source_language is exactly the same as the target_language.
8. If source_language and target_language differ, copying the original prose is a failure.
9. When translating English into Vietnamese, keep technical tokens intact but translate every English instruction sentence, rule sentence, heading, and description into Vietnamese.
10. When translating Vietnamese into English, keep technical tokens intact but translate every Vietnamese instruction sentence, rule sentence, heading, and description into English.
11. Return structured data matching the requested schema. Do not wrap with markdown.
"""

FREEZONE_TEXT_WRITER_SYSTEM_PROMPT = """# Freezone AI Text Writer

You create polished, creator-ready text from a user's instruction.

## Goal
- Write the requested story, scene, character setting, dialogue, outline, or creative prompt.
- Follow the user's requested language, structure, tone, length, and formatting.
- Make the result concrete and directly usable in a creative workflow.

## Rules
1. Preserve names, IDs, technical tokens, ratios, and other constraints supplied by the user.
2. Do not invent constraints that conflict with the user's instruction.
3. Return only the finished text. Do not explain your process.
4. Do not wrap the result in a markdown code fence.
"""

FREEZONE_STORY_SCRIPT_SYSTEM_PROMPT = """# Freezone Story Script Generator

You generate a structured story-script table from an uploaded script excerpt.

## Goal
- Turn the source script into a complete, production-oriented story script.
- Output rows that are directly usable by downstream image and video nodes.
- Keep the result cinematic, concrete, and structured.

## Requirements
1. Break the story into clear numbered shots with sequential `shot_no`, starting from 1.
2. Each row must include all schema fields. Do not omit fields.
3. Prefer concrete visual language over vague abstraction. Every shot should feel filmable.
4. Dialogue should be short and only present when appropriate. If no dialogue is needed, output `none`.
5. If a field has no meaningful content, prefer `none` instead of vague placeholders.
6. Write all fields in the same language as the source script (English if the source gives no clear language), except technical tokens when naturally needed.
7. Output only structured data matching the schema. Do not wrap with markdown.

## Table style target
- The result should resemble a production storyboard table, not a prose summary.
- `visual_description` should describe one clear beat of action or state, usually in one concise sentence.
- `shot` should use concise combinations like `close-up / macro`, `medium / low angle`, `wide / high-angle long shot`.
- `emotion` should be compact and specific, often 2-3 short phrases joined by commas.
- `scene_tags`, `lighting_mood`, `sound` should all be concrete and film-facing.
- `character_1` should prefer a stable role identifier if inferable, such as `Mia_modern` or `Mia_period`.
- `character_description_1` should prefer bracketed character-card format, e.g. `[Mia_modern: 28-year-old woman, pale face, tired expression, wearing a simple modern business outfit...]`.

## Duration guidance
- Default to short cinematic shots.
- Most rows should fall in the 2-5 second range unless the source clearly calls for a longer beat.
- Keep the pacing readable and dramatic rather than mechanically uniform.

## Prompt formatting rules
`shot_prompt` must be image-generation friendly and must be written as a chained bracket structure using ` + ` separators.

Preferred order for `shot_prompt`:
1. `[Frame composition: shot size, camera position, viewpoint, compositional relationships]`
2. `[Character card / subject description: if character 1 exists, reuse or lightly adapt the character-card format of character_description_1; if there is no character, describe the subject / core object]`
3. `[Spatial and interaction relationships of subjects / characters: who is in the foreground, who is in the midground, who relates to which environment or prop]`
4. `[Highly specific micro-expressions, subject state or key visual information: must be concrete down to visible details such as eyes, mouth corners, body tension, clothing state, wounds, sweat, blood, gaze direction]`
5. `[Clear scene environment elements and foreground / background props: office, palace, screen, throne, blue computer glow, flying dust, light through a door gap, etc.]`
6. `[Light-and-shadow geometry and atmospheric effects: key light direction, warm/cool color temperature, rim light, fog, backlight, top light, volumetric light, etc.]`
7. `[Visual style / texture: realistic cinematic, documentary feel, oppressive cold feel, epic grandeur, etc.]`
8. `[Technical parameters: lens focal length, aperture, depth of field, shutter feel, grain or resolution characteristics; try not to omit this segment]`

Example style for `shot_prompt`:
- `[Frame composition: close-up, eye-level camera] + [Character card / subject description: [Mia_modern: 28-year-old woman, pale face, tired expression, wearing a simple modern business outfit]] + [Spatial and interaction relationships: she sits alone at the desk, the blue glow of the computer screen lighting her face from the front side] + [Highly specific micro-expressions, subject state or key visual information: dark circles under the eyes, trembling fingers, unfocused gaze, lips slightly parted] + [Clear scene environment elements and props: late-night office, blue computer glow, scattered documents, a cold cup of coffee] + [Light-and-shadow geometry and atmosphere: cold blue dominant tone, screen side light pressing down facial shadows, a slight gray haze in the background] + [Visual style / texture: urban suspense, realistic cinematic] + [Technical parameters: 85mm lens, f/1.8, shallow depth of field]`

`video_motion_prompt` must focus on motion and should also use a chained bracket structure.

Preferred order for `video_motion_prompt`:
1. `[Explicit camera movement trajectory and speed: must state push / pull / pan / truck / follow / rise / descend / handheld, plus speed, force and stability]`
2. `[Highly specific physical action details or state changes of the subject: must state exactly how the person or subject moves; do not write only "emotional change"]`
3. `[Environmental physical dynamics: wind, rain, clothing hems, dust, curtains, screen flicker, firelight, falling snow, etc.]`
4. `[Sound effects and atmosphere: ambient sound, object sounds, breathing, footsteps, thunder, etc.]`
5. `[Dialogue lines and tone: write the specific lines and tone if there is dialogue, otherwise write none]`
6. `[Duration: 4.0s]`

Example style for `video_motion_prompt`:
- `[Explicit camera movement trajectory and speed: extremely slow push-in, the camera pressing almost against the face, steady with a slight breathing feel] + [Highly specific physical action details or state changes: Mia's eyes first lose focus, then her pupils contract slightly, her fingertips twitch lightly on the desk, her throat bobs in a suppressed swallow] + [Environmental physical dynamics: the cold screen light flickers slightly, the edges of the papers lift in the air-conditioning breeze, the coffee surface trembles faintly] + [Sound effects and atmosphere: hurried typing, repeated phone notifications, low-frequency electrical hum in the room] + [Dialogue lines and tone: none] + [Duration: 4.0s]`

## Quality bar
- Avoid generic outputs like `a person standing`, `camera pushes in`, `complex emotions`.
- Prefer highly specific physical action, facial detail, scene detail, and camera-language wording.
- Preserve story logic and character-state progression across rows.

## Asset fields you must NOT invent
- `character_image_1`, `character_image_2`, `reference` are asset URL slots filled in by the
  backend after generation. Always output them as an empty string.
- Never write `none`, a file name, or a made-up URL into those three fields.
- When two distinct characters appear in one shot, fill `character_2` /
  `character_description_2` the same way as `character_1` / `character_description_1`.
  Reuse the exact same character identifier across rows so the same person keeps one name.
"""

FREEZONE_VIDEO_STORY_SCRIPT_SYSTEM_PROMPT = (
    FREEZONE_STORY_SCRIPT_SYSTEM_PROMPT
    + """
## Vision-reference modes
Images may be attached to the request. The task message states which mode applies; follow that
mode and ignore the other one.

### Video-keyframe mode
You are given an ordered set of keyframes sampled from a reference video.
- The story script MUST describe what is actually visible in those frames. Do not invent an
  unrelated story, and do not fall back on the examples in this prompt.
- Read the frames as one continuous clip: identify the real subject(s), setting, wardrobe or
  species, palette, and what physically changes from frame to frame.
- If the subject is not human (animal, object, mascot, animation), say so plainly in
  `character_1` and `character_description_1`. Do not substitute a human character.
- Group consecutive frames into narrative shots rather than describing every frame.
- Set `keyframe_index` on every row to the 1-based index of the input frame that best
  represents that shot. This is how the backend attaches the reference thumbnail.
- Total duration across rows should stay close to the stated video duration.

### Character-reference mode
You are given one portrait-style reference image per character, in the order the task message
lists them. There is no reference video.
- Read every character's real appearance off their image — face, hair, wardrobe, era, species —
  and write `character_description_1` / `character_description_2` from what you actually see.
  Do not describe a character the images do not show.
- Reuse the exact character names given in the task message so the backend can attach each
  character's reference image.
- The story itself comes from the user's request (and the source script, when one is supplied),
  not from the images. The images only fix who the characters are.
- Set `keyframe_index` to 0 on every row: there are no keyframes to attach.
"""
)

FREEZONE_NODE_TYPE_LABELS: dict[str, str] = {
    "generic": "Generic prompt",
    "image": "Image node prompt",
    "video": "Video node prompt",
    "audio": "Audio node prompt",
    "text": "Text node prompt",
}

_translation_agent: Optional[Agent] = None
_text_writer_agent: Optional[Agent] = None
_story_script_agent: Optional[Agent] = None
_video_story_script_agent: Optional[Agent] = None


class FreezoneTranslationResult(BaseModel):
    """Structured translation result produced by the LLM."""

    translated_text: str = Field(description="Translated prompt text.")
    source_language: Literal["en", "vi"] = Field(
        description="Dominant natural language detected from the source text."
    )
    target_language: Literal["en", "vi"] = Field(
        description="Opposite target language used for translation."
    )


def create_freezone_translation_agent() -> Agent:
    """Create the Freezone English/Vietnamese translation Agent."""
    from novelvideo.config import (
        get_newapi_structured_output_model_settings,
        get_newapi_text_pydantic_model,
    )
    from novelvideo.brainclaw_contract import BrainClawProfile

    model = get_newapi_text_pydantic_model(
        "FREEZONE_TRANSLATION_MODEL",
        brainclaw_profile=BrainClawProfile.FREEZONE_TRANSLATION,
        capability="freezone.text.generate",
    )
    return Agent(
        model,
        system_prompt=FREEZONE_TRANSLATION_SYSTEM_PROMPT,
        model_settings=get_newapi_structured_output_model_settings(),
        output_type=FreezoneTranslationResult,
        name="Freezone Prompt Translator",
    )


def get_freezone_translation_agent() -> Agent:
    """Get the translation Agent singleton."""
    global _translation_agent
    context = current_model_gateway_context()
    if context is not None and context.is_organization:
        return create_freezone_translation_agent()
    if _translation_agent is None:
        _translation_agent = create_freezone_translation_agent()
    return _translation_agent


def create_freezone_text_writer_agent() -> Agent:
    """Create the Freezone free-text generation Agent."""
    from novelvideo.config import get_newapi_text_pydantic_model
    from novelvideo.brainclaw_contract import BrainClawProfile

    model = get_newapi_text_pydantic_model(
        "FREEZONE_TEXT_WRITER_MODEL",
        brainclaw_profile=BrainClawProfile.FREEZONE_TEXT_GENERATION,
    )
    return Agent(
        model,
        system_prompt=FREEZONE_TEXT_WRITER_SYSTEM_PROMPT,
        output_type=str,
        name="Freezone AI Text Writer",
    )


def get_freezone_text_writer_agent() -> Agent:
    """Get the free-text generation Agent singleton."""
    global _text_writer_agent
    if _text_writer_agent is None:
        _text_writer_agent = create_freezone_text_writer_agent()
    return _text_writer_agent


def resolve_freezone_text_writer_model() -> str:
    """Return the logical model name of the current free-text generation, for results and audit records."""
    from novelvideo.config import get_newapi_text_model_name

    return get_newapi_text_model_name(
        "FREEZONE_TEXT_WRITER_MODEL",
        FREEZONE_TEXT_WRITER_MODEL,
    )


def resolve_freezone_story_script_model(model: str | None) -> dict[str, str]:
    model_text = str(model or "").strip()
    if not model_text:
        return dict(FREEZONE_STORY_SCRIPT_MODEL)
    if model_text == FREEZONE_STORY_SCRIPT_MODEL["id"]:
        return dict(FREEZONE_STORY_SCRIPT_MODEL)
    if model_text.casefold() == FREEZONE_STORY_SCRIPT_MODEL["label"].casefold():
        return dict(FREEZONE_STORY_SCRIPT_MODEL)
    if model_text in LEGACY_FREEZONE_STORY_SCRIPT_MODEL_IDS:
        return dict(FREEZONE_STORY_SCRIPT_MODEL)
    raise ValueError(f"unsupported story script model: {model_text}")


def create_freezone_story_script_agent(model: str | None = None) -> Agent:
    """Create the story script generation Agent."""
    from novelvideo.api.schemas import FreezoneStoryScriptGenerateData
    from novelvideo.config import (
        get_newapi_structured_output_model_settings,
        get_newapi_text_pydantic_model,
    )
    from novelvideo.brainclaw_contract import BrainClawProfile

    resolve_freezone_story_script_model(model)
    llm_model = get_newapi_text_pydantic_model(
        "FREEZONE_STORY_SCRIPT_MODEL",
        brainclaw_profile=BrainClawProfile.FREEZONE_STORY_SCRIPT_WRITING,
        capability="freezone.text.generate",
    )
    return Agent(
        llm_model,
        system_prompt=FREEZONE_STORY_SCRIPT_SYSTEM_PROMPT,
        model_settings=get_newapi_structured_output_model_settings(),
        output_type=FreezoneStoryScriptGenerateData,
        # The structured script table has many fields, and shot_no/duration are strict ints, so the model occasionally writes the duration as
        # "2-5"/"3 sec" and fails validation. The default output_retries=1 gives only one correction chance, which is not enough,
        # and raises "Exceeded maximum output retries (1)". Align with the other complex structured agents in this repo
        # (episode_planner / content_rewriter) and raise it to 3, so the model self-corrects from the validation errors fed back.
        output_retries=model_gateway_output_retries(3),
        name="Freezone Story Script Generator",
    )


def get_freezone_story_script_agent(model: str | None = None) -> Agent:
    """Get the story script generation Agent singleton."""
    global _story_script_agent
    resolved = resolve_freezone_story_script_model(model)
    context = current_model_gateway_context()
    if context is not None and context.is_organization:
        return create_freezone_story_script_agent(resolved["id"])
    if _story_script_agent is None:
        _story_script_agent = create_freezone_story_script_agent(resolved["id"])
    return _story_script_agent


def build_freezone_translation_task(
    *,
    text: str,
    node_type: Literal["generic", "image", "video", "audio", "text"],
) -> str:
    """Build the translation task."""
    node_label = FREEZONE_NODE_TYPE_LABELS[node_type]

    parts = [
        f"Translate the following {node_label}.",
        "You must decide whether the dominant natural language is English or Vietnamese.",
        "If dominant language is English, translate into Vietnamese.",
        "If dominant language is Vietnamese, translate into English.",
        "Do not copy the original prose when translating between different languages.",
        "Preserve IDs, file names, bracket tags, color codes, ratios, and model names exactly, but translate the surrounding natural-language instructions.",
        "Keep it directly usable as a creative prompt.",
    ]
    parts.append(f"Source text:\n{text.strip()}")
    return "\n\n".join(parts)


async def translate_freezone_text(
    *,
    text: str,
    node_type: Literal["generic", "image", "video", "audio", "text"] = "generic",
    egress_context: TrustedEgressContext | None = None,
) -> tuple[str, Literal["en", "vi"], Literal["en", "vi"]]:
    """Run the Freezone English/Vietnamese translation."""
    if not text or not text.strip():
        return "", "en", "vi"

    task = build_freezone_translation_task(
        text=text,
        node_type=node_type,
    )
    from novelvideo.model_gateway_runtime import model_gateway_request_scope

    with model_gateway_request_scope(egress_context):
        response = await get_freezone_translation_agent().run(task)
    result = response.output
    target_language: Literal["en", "vi"] = result.target_language
    if target_language == result.source_language:
        target_language = "vi" if result.source_language == "en" else "en"
    return (
        result.translated_text.strip(),
        result.source_language,
        target_language,
    )


async def generate_freezone_text(
    *,
    prompt: str,
    egress_context: TrustedEgressContext | None = None,
) -> tuple[str, str]:
    """Generate free text from a user instruction, returning the logical model name and the final text. **Goes out to the network**.

    The parameters and `model_gateway_request_scope` are written after `translate_freezone_text`:
    `runners/freezone.py:FREEZONE_LEAF_EGRESS` classifies this function as NETWORK precisely on that basis.
    """
    clean_prompt = str(prompt or "").strip()
    if not clean_prompt:
        raise ValueError("prompt is required")

    from novelvideo.model_gateway_runtime import model_gateway_request_scope

    with model_gateway_request_scope(egress_context):
        response = await get_freezone_text_writer_agent().run(clean_prompt)
    generated_text = str(response.output or "").strip()
    if not generated_text:
        raise ValueError("text generation returned empty output")
    return resolve_freezone_text_writer_model(), generated_text


_STORY_SCRIPT_COMMON_RULES = (
    "The output fields must cover: shot number, duration, visual description, character 1, character description 1, character image 1, character 2, character description 2, "
    "character image 2, reference, shot size, character action, emotion, scene tags, lighting mood, sound, dialogue, shot prompt, video motion prompt.",
    "If the user gave extra requirements, follow them as well.",
    "Follow the film production table approach strictly; do not output a prose summary.",
    "Write both the shot prompt and the video motion prompt in the bracketed-segments format joined by +.",
    "Write `none` when there is no dialogue.",
    "Always output empty strings for the three fields character image 1, character image 2 and reference -- the backend backfills the asset URLs, "
    "so do not write `none` and do not invent file names or links.",
    "The shot prompt must read like a high-quality image-generation prompt and the video motion prompt like a high-quality video motion prompt, not a one-sentence summary.",
)

_STORY_SCRIPT_STYLE_HINT = (
    "Style reference points:\n"
    "- shot numbers increase consecutively\n"
    "- most durations are 2-5 seconds\n"
    "- shot size is written like `close-up / macro`, `medium / low angle`\n"
    "- write character descriptions in the form `[character ID: ...]` where possible\n"
    "- the same person must use exactly the same character name in all rows, so the character reference image can be backfilled\n"
    "- when two characters appear in one shot, put the second into character 2 / character description 2\n"
    "- write the shot prompt strictly in 8 segments if possible: composition, character card / subject description, spatial relationships, micro-expression / state, environment and props, light-and-shadow geometry, visual style, technical parameters\n"
    "- if character 1 exists, the second segment of the shot prompt should directly use or lightly adapt character description 1, not switch to a vague pronoun\n"
    "- keep the technical parameters segment of the shot prompt, do not omit it\n"
    "- write the video motion prompt strictly in 6 segments if possible: camera trajectory, subject action, environment dynamics, sound atmosphere, dialogue tone, duration\n"
    "- the subject action in the video motion prompt must be a visible physical action, not just an emotional change"
)


def _character_ref_block(
    character_refs: Sequence[Mapping[str, Any]] | None,
) -> str | None:
    """Render the character reference images into a character-card list inside the task.

    The model is given only "name + description + role", never a URL -- the images themselves are passed as multimodal attachments,
    and the URLs are backfilled by the backend by character name after generation, so the model cannot mis-copy or fabricate links.
    """
    if not character_refs:
        return None
    lines: list[str] = []
    for index, ref in enumerate(character_refs, start=1):
        name = str(ref.get("name") or "").strip() or f"Character {index}"
        description = str(ref.get("description") or "").strip()
        role = str(ref.get("role") or "").strip()
        detail = ", ".join(part for part in (role, description) if part)
        lines.append(f"{index}. {name}" + (f" ({detail})" if detail else ""))
    return (
        "Character references provided (in order, matching the attached character reference images):\n"
        + "\n".join(lines)
        + "\nUse exactly the same character names as above in the character 1 / character 2 fields you generate, "
        "so the backend can backfill the matching character reference images."
    )


def build_freezone_story_script_task(
    *,
    source_text: str,
    prompt: str,
    character_refs: Sequence[Mapping[str, Any]] | None = None,
) -> str:
    """Build the story script generation task."""
    parts = [
        "Generate a complete story script table from the uploaded script content below.",
        *_STORY_SCRIPT_COMMON_RULES,
    ]
    if prompt.strip():
        parts.append(f"User requirements:\n{prompt.strip()}")
    character_block = _character_ref_block(character_refs)
    if character_block:
        parts.append(character_block)
    parts.append(_STORY_SCRIPT_STYLE_HINT)
    parts.append(f"Source script content:\n{source_text.strip()}")
    return "\n\n".join(parts)


def build_freezone_video_story_script_task(
    *,
    frame_count: int,
    prompt: str,
    duration_sec: float | None = None,
    character_refs: Sequence[Mapping[str, Any]] | None = None,
) -> str:
    """Build the "video-reference storyboard script" task.

    It shares the same output table as text mode; the difference is that the source material is keyframes extracted in chronological order,
    and the model is required to give ``keyframe_index`` so the backend can backfill the reference image of each shot.
    """
    duration_hint = (
        f"The video lasts about {duration_sec:.2f} seconds in total, and all shot durations should add up to close to this value."
        if duration_sec and duration_sec > 0
        else "The total video duration is unknown; give reasonable durations based on the density of the keyframes."
    )
    parts = [
        f"Below, in chronological order, are {frame_count} keyframes extracted from the reference video. "
        "Break this video down into a complete story script table.",
        "This is a video breakdown task, not an original-writing task: the table content must faithfully describe the subjects, scenes, actions and style "
        "that really appear in these keyframes. Never reuse the example characters or example scenes from the system prompt.",
        "First read through all the keyframes to judge what this content actually is (a person? an animal? animation? live action?), "
        "then decide the character names and descriptions. When the subject is not a person, write it as the animal / object / figure it really is; do not replace it with a person.",
        duration_hint,
        "Group consecutive keyframes into a few narrative shots; do not list them frame by frame mechanically.",
        "Every row must give keyframe_index: the sequence number of the input keyframe that best represents this shot "
        f"(an integer between 1 and {frame_count}). The backend uses it to backfill the reference image of this shot.",
        *_STORY_SCRIPT_COMMON_RULES,
    ]
    if prompt.strip():
        parts.append(f"Extra user requirements:\n{prompt.strip()}")
    character_block = _character_ref_block(character_refs)
    if character_block:
        parts.append(character_block)
    parts.append(_STORY_SCRIPT_STYLE_HINT)
    return "\n\n".join(parts)


def build_freezone_character_story_script_task(
    *,
    image_count: int,
    prompt: str,
    source_text: str = "",
    character_refs: Sequence[Mapping[str, Any]] | None = None,
) -> str:
    """Build the "character-reference-image storyboard script" task.

    This path has no reference video, only character reference images: the plot comes from the user prompt (and the optional source script),
    and the images only pin down the character looks, so ``keyframe_index`` is always 0.
    """
    parts = [
        f"Below, in order, are {image_count} character reference images; generate a complete story script table from them.",
        "This is character-reference mode with no reference video: the appearance, clothing, era and temperament of character 1 / character 2 "
        "must be written according to the corresponding character reference image; do not describe people who are not in the images.",
        "The plot itself comes from the user requirements (and the optional source script); do not copy the example plot from the system prompt out of thin air.",
        "Always put 0 in keyframe_index of every row: this mode has no keyframes to backfill.",
        *_STORY_SCRIPT_COMMON_RULES,
    ]
    if prompt.strip():
        parts.append(f"User requirements:\n{prompt.strip()}")
    else:
        parts.append("The user gave no extra requirements; compose a structurally complete short drama around these characters on your own.")
    character_block = _character_ref_block(character_refs)
    if character_block:
        parts.append(character_block)
    parts.append(_STORY_SCRIPT_STYLE_HINT)
    if source_text.strip():
        parts.append(f"Source script content:\n{source_text.strip()}")
    return "\n\n".join(parts)


async def generate_freezone_story_script(
    *,
    source_text: str,
    prompt: str = "",
    model: str | None = None,
    character_refs: Sequence[Mapping[str, Any]] | None = None,
    egress_context: TrustedEgressContext | None = None,
):
    """Run story script generation (text / character-image mode)."""
    if not source_text or not source_text.strip():
        raise ValueError("source_text is required")

    task = build_freezone_story_script_task(
        source_text=source_text,
        prompt=prompt,
        character_refs=character_refs,
    )
    from novelvideo.model_gateway_runtime import model_gateway_request_scope

    with model_gateway_request_scope(egress_context):
        response = await get_freezone_story_script_agent(model).run(task)
    return response.output


def create_freezone_video_story_script_agent() -> Agent:
    """Create the vision Agent for the "video-reference storyboard script".

    It uses ``FREEZONE_VISION_MODEL`` (``DC-freezone-vision-LLM``) rather than the text-only
    story-script alias -- only a vision channel can accept requests with images.
    """
    from novelvideo.api.schemas import FreezoneStoryScriptGenerateData
    from novelvideo.config import (
        get_newapi_structured_output_model_settings,
        get_newapi_text_pydantic_model,
    )
    from novelvideo.brainclaw_contract import BrainClawProfile
    return Agent(
        get_newapi_text_pydantic_model(
            "FREEZONE_VISION_MODEL",
            timeout_seconds_override=300.0,
            brainclaw_profile=BrainClawProfile.FREEZONE_VISION_ANALYSIS,
            capability="vision.analyze",
        ),
        system_prompt=FREEZONE_VIDEO_STORY_SCRIPT_SYSTEM_PROMPT,
        model_settings=get_newapi_structured_output_model_settings(),
        output_type=FreezoneStoryScriptGenerateData,
        output_retries=model_gateway_output_retries(3),
        name="Freezone Video Story Script Generator",
    )


def get_freezone_video_story_script_agent() -> Agent:
    """Get the video storyboard script Agent singleton."""
    global _video_story_script_agent
    context = current_model_gateway_context()
    if context is not None and context.is_organization:
        return create_freezone_video_story_script_agent()
    if _video_story_script_agent is None:
        _video_story_script_agent = create_freezone_video_story_script_agent()
    return _video_story_script_agent


async def generate_freezone_story_script_with_vision(
    *,
    frame_paths: Sequence[str | Path] | None = None,
    character_image_paths: Sequence[str | Path] | None = None,
    source_text: str = "",
    prompt: str = "",
    duration_sec: float | None = None,
    character_refs: Sequence[Mapping[str, Any]] | None = None,
    egress_context: TrustedEgressContext | None = None,
):
    """Storyboard script generation with images: video keyframes / character reference images -> structured script table.

    Covers two entry points:

    - "Video-reference storyboard script": ``frame_paths`` are the extracted keyframes, using the video breakdown task brief.
    - "Character storyboard script": only ``character_image_paths``, using the character reference task brief --
      the plot comes from ``prompt`` (and the optional ``source_text``), and the character images only pin down the character looks.
    This path does not require ``source_text``: when the frontend attaches assets it sends only the prompt.
    """
    from pydantic_ai import BinaryContent

    from novelvideo.freezone.vision_gateway import load_compact_vision_inputs

    frames = [Path(path) for path in (frame_paths or []) if Path(path).exists()]
    character_images = [
        Path(path) for path in (character_image_paths or []) if Path(path).exists()
    ]
    if not frames and not character_images:
        raise ValueError(
            "vision story script requires at least one keyframe or character image"
        )

    if frames:
        task = build_freezone_video_story_script_task(
            frame_count=len(frames),
            prompt=prompt,
            duration_sec=duration_sec,
            character_refs=character_refs,
        )
    else:
        # Character images only: the plot comes from the prompt / optional source script, and the images only pin down the character looks.
        # source_text must not be required here -- when assets are attached the frontend sends only the prompt.
        task = build_freezone_character_story_script_task(
            image_count=len(character_images),
            prompt=prompt,
            source_text=source_text,
            character_refs=character_refs,
        )

    vision_inputs = await load_compact_vision_inputs((*frames, *character_images))
    attachments: list[Any] = [
        BinaryContent(data=image.data, media_type=image.media_type)
        for image in vision_inputs
    ]
    from novelvideo.model_gateway_runtime import model_gateway_request_scope

    with model_gateway_request_scope(egress_context):
        response = await get_freezone_video_story_script_agent().run(
            [task, *attachments]
        )
    return response.output


def bind_story_script_assets(
    data: Any,
    *,
    frame_urls: Sequence[str] | None = None,
    character_refs: Sequence[Mapping[str, Any]] | None = None,
) -> Any:
    """Backfill the URLs of keyframes / character reference images into the generated script rows.

    The model only writes the character name and ``keyframe_index``; asset URLs are always filled in here --
    so the model has no chance to fabricate a 404 link (the other half of why the character image column was always empty in issue #207).
    """
    frames = [url for url in (frame_urls or []) if url]
    by_name: dict[str, str] = {}
    for ref in character_refs or []:
        name = str(ref.get("name") or "").strip()
        image_url = str(ref.get("image_url") or "").strip()
        if name and image_url:
            by_name[name.casefold()] = image_url
    ordered_images = [
        str(ref.get("image_url") or "").strip()
        for ref in character_refs or []
        if str(ref.get("image_url") or "").strip()
    ]

    def _match(name: str) -> str:
        clean = str(name or "").strip()
        if not clean:
            return ""
        folded = clean.casefold()
        if folded in by_name:
            return by_name[folded]
        # The model often writes the character name as a stable ID with a state suffix such as `Mia_modern`,
        # falls back to containment matching when an exact match fails, and gives up only when that still fails.
        for candidate, url in by_name.items():
            if candidate in folded or folded in candidate:
                return url
        return ""

    for index, row in enumerate(getattr(data, "rows", []) or []):
        keyframe_index = int(getattr(row, "keyframe_index", 0) or 0)
        if not (1 <= keyframe_index <= len(frames)):
            # When the model gives no or a wrong index, fall back to taking frames by row order, so the reference column is not entirely empty.
            keyframe_index = index + 1 if index < len(frames) else 0
        row.reference = frames[keyframe_index - 1] if keyframe_index else ""
        row.keyframe_index = keyframe_index

        row.character_image_1 = _match(getattr(row, "character_1", ""))
        row.character_image_2 = _match(getattr(row, "character_2", ""))
        # With only one character image and no matchable character name from the model, bind that single one directly,
        # otherwise the "character storyboard script" would degrade to an empty column again after the model rewrites the character name.
        if not row.character_image_1 and len(ordered_images) == 1:
            row.character_image_1 = ordered_images[0]

    return data
