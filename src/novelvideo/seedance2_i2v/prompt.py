"""Seedance 2.0 prompt composition helpers."""

from __future__ import annotations


import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from novelvideo.brainclaw_contract import BrainClawProfile
from novelvideo.models import (
    beat_scene_ref,
    real_detected_identities,
    real_detected_props,
)
from novelvideo.seedance2_i2v.models import Seedance2I2VMode
from novelvideo.seedance2_i2v.spoken_dialogue import speaker_display_name
from novelvideo.utils.source_language import (
    AssetLanguage,
    asset_language_instruction,
    detect_asset_language,
)


@dataclass(frozen=True)
class Seedance2PromptGeneration:
    """Result of AI-first prompt generation."""

    prompt: str
    used_ai: bool
    draft_prompt: str
    error: str = ""


Seedance2PromptComposer = Callable[..., Awaitable[str]]


SEEDANCE2_PROMPT_GUIDANCE_TEMPLATES: dict[str, str] = {
    "subject": "Subject: Define the primary character or object, its current action and state, and avoid competing focal subjects.",
    "scene": "Scene: Describe the spatial background, location relationships, key props, and environmental materials while staying consistent with the references.",
    "lighting": "Lighting: Describe the key light, tonal layers, color temperature, and atmosphere while avoiding unintended flicker.",
    "camera": "Camera: Specify shot size, viewpoint, movement speed, and direction so the camera move is clear and executable.",
    "style": "Style: Define visual texture, period, color direction, and realism to prevent style drift.",
    "no_subtitles": "No subtitles: Do not generate any text or subtitles; keep the frame visually clean.",
}


SEEDANCE2_COMPOSER_SYSTEM_PROMPT = """You write image-to-video prompts for Seedance 2.0.
Use the fixed asset manifest, storyboard context, user guidance, and rule-based draft to write the final Seedance 2.0 prompt.
Asset order is fixed. Only use existing reference tokens such as image1 and audio1 from the asset manifest.
Never add or reorder image/audio reference numbers, and do not output @ symbols.
Do not force every asset into the prompt; reference only assets that materially help the current shot.
Duration, resolution, aspect ratio, and human-review controls are API parameters and must not appear in the prompt.
Output the final prompt directly without explaining the generation process."""


def detect_seedance2_prompt_language(beat: dict[str, Any]) -> AssetLanguage:
    """Detect language from authored script fields, excluding generated prompts."""
    source = "\n".join(
        _text(beat.get(field))
        for field in (
            "visual_description",
            "synopsis",
            "dialogue",
            "narration_segment",
            "narration",
            "scene_description",
            "props_description",
        )
        if _text(beat.get(field))
    )
    return detect_asset_language(source)


def _text(value: Any) -> str:
    return str(value or "").strip()


def _sentence_text(value: Any) -> str:
    return _text(value).strip(" \t\r\n.;,")


def _beat_spoken_text(beat: dict[str, Any]) -> str:
    return _text(
        beat.get("dialogue")
        or beat.get("narration_segment")
        or beat.get("narration")
        or ""
    )


def _beat_spoken_label(
    beat: dict[str, Any], language: AssetLanguage = "en"
) -> str:
    if _text(beat.get("audio_type")) == "dialogue" or _text(beat.get("dialogue")):
        return "Dialogue"
    return "Narration"


def _clean_sentence(value: Any, language: AssetLanguage = "en") -> str:
    text = _sentence_text(value)
    if not text:
        return ""
    return f"{text}."


def _asset_value(asset: Any, name: str, default: Any = "") -> Any:
    if isinstance(asset, dict):
        return asset.get(name, default)
    return getattr(asset, name, default)


def _split_identity_label(identity_id: str) -> tuple[str, str]:
    text = _text(identity_id)
    if "_" not in text:
        return text, ""
    return text.split("_", 1)


def _selected_scene_asset_label(assets: list[Any] | None) -> str:
    for asset in assets or []:
        key = _text(_asset_value(asset, "key"))
        if key.startswith("scene:") and bool(_asset_value(asset, "selected")):
            return key.split(":", 1)[1]
    return ""


def _desired_scene_ref_label(beat: dict[str, Any]) -> str:
    scene_ref = beat_scene_ref(beat)
    if not scene_ref:
        return _text(beat.get("scene_description"))
    label = scene_ref.scene_id
    if scene_ref.variant_id:
        label = f"{label}_{scene_ref.variant_id}"
    return label


def _scene_ref_label(
    beat: dict[str, Any],
    assets: list[Any] | None = None,
    language: AssetLanguage = "en",
) -> str:
    asset_label = _selected_scene_asset_label(assets)
    desired_label = _desired_scene_ref_label(beat)
    desired_time = _text(beat.get("time_of_day"))
    if asset_label:
        details: list[str] = []
        if desired_label and desired_label != asset_label:
            details.append(f"target scene state: {desired_label}")
        if desired_time:
            details.append(f"target time: {desired_time}")
        if details:
            return f"{asset_label} ({'; '.join(details)})"
        return asset_label
    if desired_label and desired_time:
        return f"{desired_label} (target time: {desired_time})"
    if desired_time:
        return f"target time: {desired_time}"
    return desired_label


def normalize_seedance2_editor_prompt(prompt: str) -> str:
    """Convert editor-only @ mentions into model-facing reference labels."""

    return re.sub(r"@(image|video|audio)(?=\d)", r"\1", _text(prompt))


def _localized_prompt_guidance(
    guidance: str,
    template_keys: list[str] | tuple[str, ...] | None,
    language: AssetLanguage,
) -> str:
    normalized = normalize_seedance2_editor_prompt(guidance)
    keys = [key for key in template_keys or [] if key in SEEDANCE2_PROMPT_GUIDANCE_TEMPLATES]
    template_texts = {SEEDANCE2_PROMPT_GUIDANCE_TEMPLATES[key] for key in keys}
    freeform = "\n".join(
        line for line in normalized.splitlines() if line.strip() not in template_texts
    ).strip()
    parts = [freeform] if freeform else []
    parts.extend(SEEDANCE2_PROMPT_GUIDANCE_TEMPLATES[key] for key in keys)
    return "\n".join(dict.fromkeys(parts))


def _selected_assets(assets: list[Any] | None) -> list[Any]:
    return [
        asset
        for asset in assets or []
        if bool(_asset_value(asset, "selected"))
        and _text(_asset_value(asset, "reference_label")) not in {"", "not_sent"}
        and _text(_asset_value(asset, "request_field"))
    ]


def _prompt_available_assets(assets: list[Any] | None) -> list[Any]:
    result: list[Any] = []
    for asset in assets or []:
        label = _text(_asset_value(asset, "reference_label"))
        if label in {"", "not_sent"}:
            continue
        if not re.match(r"^(image|audio)\d+$", label):
            continue
        if _text(_asset_value(asset, "request_field")):
            result.append(asset)
            continue
        if (
            _text(_asset_value(asset, "media_type")) == "audio"
            and bool(_asset_value(asset, "exists"))
            and not _text(_asset_value(asset, "validation_error"))
        ):
            result.append(asset)
    return result


def build_seedance2_asset_manifest(assets: list[Any] | None) -> list[dict[str, str]]:
    """Return the fixed asset order visible to the AI composer and prompt editor."""

    manifest: list[dict[str, str]] = []
    for asset in _prompt_available_assets(assets):
        label = _text(_asset_value(asset, "reference_label"))
        manifest.append(
            {
                "label": label,
                "title": _text(_asset_value(asset, "label")),
                "media_type": _text(_asset_value(asset, "media_type")),
                "request_field": _text(_asset_value(asset, "request_field")),
                "note": _text(_asset_value(asset, "note")),
                "identity_id": _text(_asset_value(asset, "identity_id")),
                "prop_id": _text(_asset_value(asset, "prop_id")),
                "prop_scope": _text(_asset_value(asset, "prop_scope")),
                "key": _text(_asset_value(asset, "key")),
            }
        )
    return manifest


def build_seedance2_asset_fallback_manifest(
    assets: list[Any] | None,
) -> list[dict[str, str]]:
    """Return text-only reference constraints for assets that are not sent to the API."""

    manifest: list[dict[str, str]] = []
    for asset in assets or []:
        fallback_text = _text(_asset_value(asset, "fallback_text"))
        if not fallback_text or bool(_asset_value(asset, "selected")):
            continue
        manifest.append(
            {
                "title": _text(_asset_value(asset, "label")),
                "media_type": _text(_asset_value(asset, "media_type")),
                "note": _text(_asset_value(asset, "note")),
                "identity_id": _text(_asset_value(asset, "identity_id")),
                "prop_id": _text(_asset_value(asset, "prop_id")),
                "prop_scope": _text(_asset_value(asset, "prop_scope")),
                "key": _text(_asset_value(asset, "key")),
                "fallback_text": fallback_text,
            }
        )
    return manifest


def _identity_reference_labels(assets: list[Any] | None) -> dict[str, str]:
    labels: dict[str, str] = {}
    for asset in _selected_assets(assets):
        identity_id = _text(_asset_value(asset, "identity_id"))
        reference_label = _text(_asset_value(asset, "reference_label"))
        if identity_id and reference_label.startswith("image"):
            labels[identity_id] = reference_label
    return labels


def _identity_prompt_fallbacks(assets: list[Any] | None) -> dict[str, str]:
    fallbacks: dict[str, str] = {}
    for asset in assets or []:
        identity_id = _text(_asset_value(asset, "identity_id"))
        fallback_text = _text(_asset_value(asset, "fallback_text"))
        if identity_id and fallback_text:
            fallbacks[identity_id] = fallback_text
    return fallbacks


def _prop_reference_labels(assets: list[Any] | None) -> dict[str, str]:
    labels: dict[str, str] = {}
    for asset in _selected_assets(assets):
        prop_id = _text(_asset_value(asset, "prop_id"))
        reference_label = _text(_asset_value(asset, "reference_label"))
        if prop_id and reference_label.startswith("image"):
            labels[prop_id] = reference_label
    return labels


def _prop_prompt_fallbacks(assets: list[Any] | None) -> dict[str, str]:
    fallbacks: dict[str, str] = {}
    for asset in assets or []:
        prop_id = _text(_asset_value(asset, "prop_id"))
        fallback_text = _text(_asset_value(asset, "fallback_text"))
        if prop_id and fallback_text:
            fallbacks[prop_id] = fallback_text
    return fallbacks


def _beat_spoken_prompt_fragment(
    beat: dict[str, Any],
    assets: list[Any] | None,
    language: AssetLanguage = "en",
) -> str:
    spoken = _beat_spoken_text(beat)
    if not spoken:
        return ""

    voice_references: list[str] = []
    for asset in _selected_assets(assets):
        label = _text(_asset_value(asset, "reference_label"))
        if not label.startswith("audio"):
            continue
        identity_id = _text(_asset_value(asset, "identity_id"))
        title = speaker_display_name(identity_id) or _text(_asset_value(asset, "label"))
        voice_references.append(
            f"{title} uses the voice from {label}"
            if title
            else f"use the voice from {label}"
        )

    speaker = speaker_display_name(_text(beat.get("speaker")))
    context: list[str] = []
    if speaker:
        context.append(f"the speaking character in this Beat is {speaker}")
    if voice_references:
        context.append("voice mapping: " + ", ".join(dict.fromkeys(voice_references)))
    context_text = "; ".join(context)
    if context_text:
        context_text = f"; {context_text}"
    return (
        "Original dialogue and performance text (distinguish action directions "
        "from spoken dialogue; preserve every spoken word verbatim"
        f"{context_text}): {spoken}"
    )


def _text_with_identity_references(
    text: Any,
    assets: list[Any] | None,
    language: AssetLanguage = "en",
) -> str:
    identity_labels = _identity_reference_labels(assets)
    identity_fallbacks = _identity_prompt_fallbacks(assets)

    def replace_marker(match: re.Match[str]) -> str:
        identity_id = match.group(1)
        character, _identity = _split_identity_label(identity_id)
        image_label = identity_labels.get(identity_id)
        if image_label:
            return f"{character} from {image_label}"
        fallback_text = identity_fallbacks.get(identity_id)
        if fallback_text:
            return f"{character} ({fallback_text})"
        return character

    return re.sub(r"\{\{([^}]+)\}\}", replace_marker, _text(text))


def _text_with_asset_references(
    text: Any,
    assets: list[Any] | None,
    language: AssetLanguage = "en",
) -> str:
    prop_labels = _prop_reference_labels(assets)
    prop_fallbacks = _prop_prompt_fallbacks(assets)

    def replace_prop_marker(match: re.Match[str]) -> str:
        prop_id = _text(match.group(1))
        image_label = prop_labels.get(prop_id)
        if image_label:
            return f"the {prop_id} prop from {image_label}"
        fallback_text = prop_fallbacks.get(prop_id)
        if fallback_text:
            return f"{prop_id} ({fallback_text})"
        return prop_id

    text_with_identities = _text_with_identity_references(text, assets, language)
    return re.sub(r"\[\[([^\]]+)\]\]", replace_prop_marker, text_with_identities)


def _reference_sentence_for_assets(
    *,
    mode: Seedance2I2VMode | str,
    assets: list[Any] | None,
    language: AssetLanguage = "en",
) -> str:
    mode = Seedance2I2VMode(mode)
    image_parts: list[str] = []
    audio_parts: list[str] = []

    for asset in _selected_assets(assets):
        label = _text(_asset_value(asset, "reference_label"))
        title = _text(_asset_value(asset, "label"))
        key = _text(_asset_value(asset, "key"))
        note = _text(_asset_value(asset, "note"))
        media_type = _text(_asset_value(asset, "media_type"))
        identity_id = _text(_asset_value(asset, "identity_id"))
        prop_id = _text(_asset_value(asset, "prop_id"))

        if media_type == "audio" or label.startswith("audio"):
            audio_parts.append(f"{label} as {title or 'an audio reference'}")
            continue

        if mode == Seedance2I2VMode.FIRST_FRAME:
            image_parts.append(f"{label} as the first frame")
            continue
        if mode == Seedance2I2VMode.FIRST_LAST_FRAME and key == "last_frame":
            image_parts.append(f"{label} as the last frame")
            continue
        if key == "first_frame":
            image_parts.append(
                f"{label} as the starting state and overall composition reference"
            )
            continue
        if identity_id:
            character, _identity = _split_identity_label(identity_id)
            image_parts.append(
                f"keep the appearance of {character} consistent with {label}"
            )
            continue
        if prop_id:
            image_parts.append(
                f"keep the shape, material, and details of the {prop_id} prop consistent with {label}"
            )
            continue
        if key.startswith("scene:"):
            image_parts.append(f"{label} as the reference for {title or 'the scene'}")
            continue
        if note:
            image_parts.append(f"{label} for {note}")
            continue
        image_parts.append(f"{label} as {title or 'a visual reference'}")

    for asset in assets or []:
        if bool(_asset_value(asset, "selected")):
            continue
        identity_id = _text(_asset_value(asset, "identity_id"))
        prop_id = _text(_asset_value(asset, "prop_id"))
        fallback_text = _text(_asset_value(asset, "fallback_text"))
        if not fallback_text:
            continue
        if identity_id:
            character, _identity = _split_identity_label(identity_id)
            image_parts.append(
                f"generate {character}'s appearance from this description: {fallback_text}"
            )
        elif prop_id:
            image_parts.append(
                f"generate the {prop_id} prop from this description: {fallback_text}"
            )

    if mode == Seedance2I2VMode.FIRST_LAST_FRAME and len(image_parts) >= 2:
        base = f"Use {image_parts[0]} and {image_parts[1]}, with a natural video transition"
    elif mode == Seedance2I2VMode.FIRST_FRAME and image_parts:
        base = f"Use {image_parts[0]} to generate an image-to-video clip"
    else:
        base = (
            "Use " + ", ".join(image_parts)
            if image_parts
            else "Generate an image-to-video clip from the provided reference assets"
        )
    if audio_parts:
        base = f"{base}, using {', '.join(audio_parts)}"
    return base


def build_text_overlay_prompt_fragment(
    text_overlay: dict[str, Any] | None,
    language: AssetLanguage = "en",
) -> str:
    overlay = text_overlay or {}
    if not overlay.get("enabled"):
        return ""
    content = _sentence_text(overlay.get("content"))
    if not content:
        return ""
    speaker = _text(overlay.get("speaker"))
    kind_label = {
        "ad_copy": "advertising copy",
        "subtitle": "subtitle",
        "speech_bubble": "speech-bubble text",
    }.get(_text(overlay.get("kind")) or "subtitle", "subtitle")
    placement = _sentence_text(overlay.get("placement")) or "bottom center"
    timing = _sentence_text(overlay.get("timing")) or "throughout the clip"
    style = _sentence_text(overlay.get("style")) or "clean and readable"
    speaker_text = f", spoken by {speaker_display_name(speaker) or speaker}" if speaker else ""
    return (
        f'Use {kind_label} text "{content}" at {placement}, visible {timing}, '
        f"with a {style} style{speaker_text}."
    )


def build_seedance2_prompt_draft(
    *,
    mode: Seedance2I2VMode | str,
    beat: dict[str, Any],
    assets: list[Any] | None,
    text_overlay: dict[str, Any] | None,
    prompt_guidance: str = "",
    prompt_guidance_template_keys: list[str] | tuple[str, ...] | None = None,
    manual_prompt_reference: str = "",
    language: AssetLanguage = "en",
) -> str:
    """Build a model-facing draft prompt without API-only video params."""

    reference = _reference_sentence_for_assets(
        mode=mode, assets=assets, language=language
    )
    visual = _text_with_asset_references(
        beat.get("visual_description") or beat.get("synopsis") or "",
        assets,
        language,
    )
    scene = _text_with_asset_references(
        _scene_ref_label(beat, assets, language), assets, language
    )
    props = _text_with_asset_references(
        beat.get("props_description") or "", assets, language
    )
    legacy_motion = _text_with_asset_references(
        beat.get("video_prompt") or beat.get("keyframe_prompt") or "",
        assets,
        language,
    )
    spoken = _beat_spoken_prompt_fragment(beat, assets, language)
    spoken_label = _beat_spoken_label(beat, language)
    overlay = build_text_overlay_prompt_fragment(text_overlay, language)
    guidance = _localized_prompt_guidance(
        prompt_guidance, prompt_guidance_template_keys, language
    )
    manual = normalize_seedance2_editor_prompt(manual_prompt_reference)

    lines = [_clean_sentence(reference, language)]
    if visual:
        lines.append(_clean_sentence(f"The scene shows {_sentence_text(visual)}", language))
    if scene:
        lines.append(_clean_sentence(f"The environment is {_sentence_text(scene)}", language))
    if props:
        lines.append(_clean_sentence(f"Keep these key props consistent: {_sentence_text(props)}", language))
    if legacy_motion:
        lines.append(_clean_sentence(f"Motion: {_sentence_text(legacy_motion)}", language))
    if spoken:
        lines.append(_clean_sentence(f"{spoken_label}: {_sentence_text(spoken)}", language))
    if overlay:
        lines.append(overlay)
    if guidance:
        lines.append(_clean_sentence(guidance, language))
    if manual:
        lines.append(
            _clean_sentence(
                f"Use this manual version as a rewrite reference: {_sentence_text(manual)}",
                language,
            )
        )
    return normalize_seedance2_editor_prompt(" ".join(line for line in lines if line))


def compute_seedance2_prompt_inputs_hash(
    *,
    mode: Seedance2I2VMode | str,
    beat: dict[str, Any],
    assets: list[Any] | None,
    text_overlay: dict[str, Any] | None,
    prompt_guidance: str = "",
    prompt_guidance_template_keys: list[str] | tuple[str, ...] | None = None,
    language: AssetLanguage = "en",
) -> str:
    """Hash only prompt-relevant inputs, excluding request-only video controls."""

    payload = {
        "mode": Seedance2I2VMode(mode).value,
        "beat": {
            "visual_description": beat.get("visual_description") or "",
            "scene_ref": beat.get("scene_ref") or {},
            "scene_description": beat.get("scene_description") or "",
            "props_description": beat.get("props_description") or "",
            "video_prompt": beat.get("video_prompt") or "",
            "keyframe_prompt": beat.get("keyframe_prompt") or "",
            "synopsis": beat.get("synopsis") or "",
            "dialogue": beat.get("dialogue") or "",
            "narration_segment": beat.get("narration_segment") or "",
            "detected_identities": real_detected_identities(
                beat.get("detected_identities") or []
            ),
            "detected_props": real_detected_props(beat.get("detected_props") or []),
        },
        "assets": build_seedance2_asset_manifest(assets),
        "asset_fallbacks": build_seedance2_asset_fallback_manifest(assets),
        "text_overlay": text_overlay or {},
        "prompt_guidance": _localized_prompt_guidance(
            prompt_guidance, prompt_guidance_template_keys, language
        ),
        "language": language,
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def build_seedance2_prompt_composer_task(
    *,
    mode: Seedance2I2VMode | str,
    beat: dict[str, Any],
    assets: list[Any] | None,
    text_overlay: dict[str, Any] | None,
    prompt_guidance: str,
    draft_prompt: str,
    request_params: dict[str, Any] | None = None,
    manual_prompt_reference: str = "",
    language: AssetLanguage = "en",
) -> str:
    payload = {
        "mode": Seedance2I2VMode(mode).value,
        "asset_manifest": build_seedance2_asset_manifest(assets),
        "beat": {
            "visual_description": beat.get("visual_description") or "",
            "scene_ref": beat.get("scene_ref") or {},
            "scene_description": beat.get("scene_description") or "",
            "props_description": beat.get("props_description") or "",
            "video_prompt": beat.get("video_prompt") or "",
            "keyframe_prompt": beat.get("keyframe_prompt") or "",
            "dialogue": beat.get("dialogue") or "",
            "narration_segment": beat.get("narration_segment") or "",
            "detected_identities": real_detected_identities(
                beat.get("detected_identities") or []
            ),
            "detected_props": real_detected_props(beat.get("detected_props") or []),
        },
        "asset_fallbacks": build_seedance2_asset_fallback_manifest(assets),
        "text_overlay": text_overlay or {},
        "user_prompt_guidance": _text(prompt_guidance),
        "manual_prompt_reference": normalize_seedance2_editor_prompt(
            manual_prompt_reference
        ),
        "request_params_for_context_only": request_params or {},
        "rule_based_draft_prompt": normalize_seedance2_editor_prompt(draft_prompt),
    }
    language_rule = asset_language_instruction(language)
    return (
        "Write the final Seedance 2.0 image-to-video prompt from the JSON below.\n\n"
        "Hard requirements:\n"
        "- Follow the official reference syntax using tokens such as image1 and audio1.\n"
        "- Only use numbered tokens present in asset_manifest; never add or reorder them.\n"
        "- Do not force every manifest asset into the prompt; reference only the images or audio "
        "the current shot actually needs.\n"
        "- Audio assets are optional voice references; omit them from the prompt when not needed.\n"
        "- asset_fallbacks are text-only constraints for assets that are not sent; use their "
        "fallback_text to describe the prop or character, but never give them image numbers.\n"
        "- Do not describe the request JSON or output @.\n"
        "- Keep duration, resolution, ratio, generate_audio, return_last_frame, and human_review "
        "out of the prompt; they are API request parameters only.\n"
        "- If the user's writing guidance conflicts with the asset manifest or fallbacks, "
        "the manifest and fallbacks win.\n"
        "- Preserve spoken dialogue verbatim while action directions may be rewritten naturally; "
        "never trim or summarize actual spoken lines.\n"
        f"- {language_rule}\n"
        "- Output only the final prompt.\n\n"
        f"{json.dumps(payload, ensure_ascii=False, indent=2, default=str)}"
    )


def create_seedance2_prompt_composer_agent(language: AssetLanguage = "en"):
    from pydantic_ai import Agent

    from novelvideo.config import get_newapi_text_pydantic_model

    return Agent(
        get_newapi_text_pydantic_model(
            "SEEDANCE2_PROMPT_COMPOSER_MODEL",
            brainclaw_profile=BrainClawProfile.SEEDANCE2_PROMPT_COMPOSITION,
            capability="text.generate.workflow",
        ),
        system_prompt=(
            f"{SEEDANCE2_COMPOSER_SYSTEM_PROMPT}\n\n"
            f"## Output Language\n{asset_language_instruction(language)}"
        ),
        output_type=str,
        name="Seedance 2.0 Prompt Composer",
    )


async def compose_seedance2_prompt_with_agent(
    *,
    mode: Seedance2I2VMode | str,
    beat: dict[str, Any],
    assets: list[Any] | None,
    text_overlay: dict[str, Any] | None,
    prompt_guidance: str,
    draft_prompt: str,
    request_params: dict[str, Any] | None = None,
    manual_prompt_reference: str = "",
    language: AssetLanguage = "en",
) -> str:
    agent = create_seedance2_prompt_composer_agent(language)
    result = await agent.run(
        build_seedance2_prompt_composer_task(
            mode=mode,
            beat=beat,
            assets=assets,
            text_overlay=text_overlay,
            prompt_guidance=prompt_guidance,
            draft_prompt=draft_prompt,
            request_params=request_params,
            manual_prompt_reference=manual_prompt_reference,
            language=language,
        )
    )
    prompt = normalize_seedance2_editor_prompt(result.output)
    if not prompt:
        raise ValueError("AI composer returned an empty prompt")
    return prompt


async def generate_seedance2_prompt(
    *,
    mode: Seedance2I2VMode | str,
    beat: dict[str, Any],
    assets: list[Any] | None,
    text_overlay: dict[str, Any] | None,
    prompt_guidance: str,
    prompt_guidance_template_keys: list[str] | tuple[str, ...] | None = None,
    request_params: dict[str, Any] | None = None,
    manual_prompt_reference: str = "",
    composer: Seedance2PromptComposer | None = None,
    language: AssetLanguage = "en",
) -> Seedance2PromptGeneration:
    """Generate a Seedance 2.0 prompt, preferring AI and falling back to rules."""

    localized_guidance = _localized_prompt_guidance(
        prompt_guidance, prompt_guidance_template_keys, language
    )
    draft_prompt = build_seedance2_prompt_draft(
        mode=mode,
        beat=beat,
        assets=assets,
        text_overlay=text_overlay,
        prompt_guidance=localized_guidance,
        manual_prompt_reference=manual_prompt_reference,
        language=language,
    )
    try:
        compose = composer or compose_seedance2_prompt_with_agent
        prompt = await compose(
            mode=mode,
            beat=beat,
            assets=assets,
            text_overlay=text_overlay,
            prompt_guidance=localized_guidance,
            draft_prompt=draft_prompt,
            request_params=request_params or {},
            manual_prompt_reference=manual_prompt_reference,
            language=language,
        )
        prompt = normalize_seedance2_editor_prompt(prompt)
        if not prompt:
            raise ValueError("AI composer returned an empty prompt")
        return Seedance2PromptGeneration(
            prompt=prompt,
            used_ai=True,
            draft_prompt=draft_prompt,
            error="",
        )
    except Exception as exc:
        return Seedance2PromptGeneration(
            prompt=draft_prompt,
            used_ai=False,
            draft_prompt=draft_prompt,
            error=str(exc),
        )
