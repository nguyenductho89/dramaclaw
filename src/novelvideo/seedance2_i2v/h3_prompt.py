"""MiniMax H3 full-reference (Ref2VA) prompt composition helpers.

The H3 gateway only runs the ``omni_reference`` workflow: every image/audio is a
numbered reference (``<Picture N>`` / ``<Audio N>``), so one prompt format covers
the first-frame and the multi-reference panel modes.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any

from novelvideo.brainclaw_contract import BrainClawProfile
from novelvideo.models import real_detected_identities, real_detected_props
from novelvideo.seedance2_i2v.models import Seedance2I2VMode
from novelvideo.seedance2_i2v.prompt import (
    Seedance2PromptComposer,
    Seedance2PromptGeneration,
    _beat_spoken_text,
    _asset_value,
    _localized_prompt_guidance,
    _prompt_available_assets,
    _sentence_text,
    _text,
    build_seedance2_asset_fallback_manifest,
    build_seedance2_asset_manifest,
    build_text_overlay_prompt_fragment,
    detect_seedance2_prompt_language,
    normalize_seedance2_editor_prompt,
)
from novelvideo.utils.source_language import AssetLanguage

H3_FPS = 24
H3_MIN_SECONDS = 4
H3_MAX_SECONDS = 15
H3_MAX_IMAGES = 9
H3_MAX_AUDIOS = 3
H3_MIN_CUT_GAP_SECONDS = 1.2
H3_RATIO_OPTIONS = ("21:9", "16:9", "4:3", "1:1", "3:4", "9:16")
H3_SUPPORTED_MODES = frozenset(
    {Seedance2I2VMode.FIRST_FRAME, Seedance2I2VMode.MULTIMODAL_REFERENCE}
)
H3_SECTIONS = (
    "subject_definitions",
    "summary",
    "retention_analysis",
    "detailed_description",
    "overall_soundscape",
    "non_diegetic_music",
)

H3_COMPOSER_SYSTEM_PROMPT = """You write MiniMax H3 full-reference (Ref2VA) video prompts.
Use the reference manifest, storyboard context, user guidance, and rule-based draft to write the final prompt.

Output exactly six sections, each starting a line with its name and a colon, in this order:
subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music.

Reference labels:
- Only use <Picture N> and <Audio N> labels listed in the manifest; never add, renumber, or reorder them.
- <Subject N> names visible content (a person, scene, prop) taken from one or more pictures. Define each Subject once in subject_definitions, one line each, and keep its meaning in every later section.
- A picture used as a concrete frame (first_frame_label) gets its own line in subject_definitions, e.g. "<Picture 1> is the first frame of [Shot 1], showing ...".
- Do not force every manifest asset into the prompt; define only what the shot needs. Audio labels you use must start at <Audio 1> and not skip numbers.
- asset_fallbacks are text-only constraints and never receive picture numbers.
- Asset roles by manifest key: identity:*, prop:* and scene:* pictures only define a person, prop or environment, so cite them inside the matching <Subject N> definition ("<Subject 1> is the woman in <Picture 2>, ...") and give them no standalone line. When first_frame_label is empty, the picture with key first_frame is the current storyboard render: give it a standalone line "<Picture N> is a storyboard reference for [Shot 1], defining viewpoint, subject placement and shot order." and use it for composition only, never as a first frame. voice:* audio is a timbre reference for that speaker.
- When has_storyboard_render is false there is no storyboard picture: write no storyboard-reference line and give no picture that role, including <Picture 1>. Every picture only defines a Subject; take viewpoint, subject placement, movement and shot order from the beat text and user guidance.

Sections:
- summary starts with a bracketed task type: [keyframe completion + reference generation] when first_frame_label is set, otherwise [reference generation] with " + audio reference" when audio is used. One short paragraph; no new labels.
- retention_analysis has one line per label: "<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - ...". Pictures and subjects use fully_preserved, partially_preserved, attribute_transfer, or weak_reference. Audio uses fully_copy, partially_copy, reference, or weak_reference.
- detailed_description opens with one or two sentences of overall style, then one paragraph per shot, each starting a line: "[Shot 1] ..." (no timestamp) and "[Shot 2] At 00:03.500, the camera cuts to ..." for later shots. Cut times strictly increase, stay below duration_seconds, and are at least 1.2 seconds apart. Describe composition, subject appearance and position, environment and lighting, actions, camera, and sound for every shot, and cite labels where referenced content appears. Target 350-500 words; dialogue-heavy shots may run longer.
- Camera motion is natural English: type plus amplitude and speed when they matter ("The camera pushes in with small amplitude at slow speed toward ..."). Every framing sentence needs a motion word or "static shot".
- storyboard_frame_observation, when present, describes <Picture 1> as seen by a vision model. It is ground truth for camera position, direction of travel, framing and screen placement: follow it and never contradict it.
- Speakers get stable IDs: "<Subject 2> (S1) says, <d>[Chinese] ...</d>". Inside <d> put only the language tag and the spoken words, copied verbatim. For voiceover write "says in an off-screen voiceover" and state the lips remain closed. Visible on-screen text goes in double quotes, verbatim.
- overall_soundscape: 1-4 sentences of ambience and physical sounds; do not repeat dialogue or sound already described in a shot.
- non_diegetic_music: 1-3 sentences on instrumentation, tempo, and dynamics, or N/A.

Write every section in English; keep only dialogue, lyrics, and visible text in their original language.
Describe what should appear; never write negative or ban lists.
Duration, resolution, and ratio are API parameters: use duration_seconds only to place cuts.
Output the final prompt directly without explanation."""


def h3_effective_duration(seconds: int | float | str | None) -> float:
    """Seconds the gateway actually renders: clamped, then rounded up to the 17k+5 frame grid."""

    try:
        value = float(seconds if seconds is not None else H3_MIN_SECONDS)
    except (TypeError, ValueError):
        value = float(H3_MIN_SECONDS)
    value = min(max(value, H3_MIN_SECONDS), H3_MAX_SECONDS)
    frames = 17 * math.ceil((value * H3_FPS - 5) / 17) + 5
    return round(frames / H3_FPS, 4)


def h3_reference_label(label: Any) -> str:
    match = re.fullmatch(r"(图片|音频)(\d+)", _text(label))
    if not match:
        return ""
    kind = "Picture" if match.group(1) == "图片" else "Audio"
    return f"<{kind} {match.group(2)}>"


def build_h3_asset_manifest(assets: list[Any] | None) -> list[dict[str, str]]:
    """Seedance asset manifest re-labelled for H3, capped at the gateway's reference limits."""

    manifest: list[dict[str, str]] = []
    counts = {"image": 0, "audio": 0}
    limits = {"image": H3_MAX_IMAGES, "audio": H3_MAX_AUDIOS}
    for item in build_seedance2_asset_manifest(assets):
        h3_label = h3_reference_label(item.get("label"))
        media_type = item.get("media_type") or ""
        if not h3_label or media_type not in counts:
            continue
        if counts[media_type] >= limits[media_type]:
            continue
        counts[media_type] += 1
        manifest.append(
            {
                "h3_label": h3_label,
                "title": item.get("title", ""),
                "media_type": media_type,
                "identity_id": item.get("identity_id", ""),
                "prop_id": item.get("prop_id", ""),
                "prop_scope": item.get("prop_scope", ""),
                "key": item.get("key", ""),
            }
        )
    return manifest


def select_h3_reference_assets(
    assets: list[Any] | None, prompt: str
) -> tuple[list[Any], list[Any]]:
    """Assets sent to H3, in label order so ``<Picture N>`` is ``ref_image_{N-1}`` at the gateway.

    All numbered images go out; audio is sent only up to the highest ``<Audio N>`` the prompt
    uses, which keeps the audio numbering contiguous.
    """

    def number(asset: Any) -> int:
        return int(re.sub(r"\D", "", _text(_asset_value(asset, "reference_label"))) or 0)

    images: list[Any] = []
    audios: list[Any] = []
    for asset in _prompt_available_assets(assets):
        field = _text(_asset_value(asset, "request_field"))
        if _text(_asset_value(asset, "media_type")) == "image" and field in {
            "image_url",
            "reference_images",
        }:
            images.append(asset)
        elif field == "reference_audios":
            audios.append(asset)
    used_audio = max((int(n) for n in _AUDIO_RE.findall(prompt or "")), default=0)
    audios = [a for a in audios if number(a) <= used_audio]
    return (
        sorted(images, key=number)[:H3_MAX_IMAGES],
        sorted(audios, key=number)[:H3_MAX_AUDIOS],
    )


def _first_frame_label(mode: Seedance2I2VMode | str, manifest: list[dict[str, str]]) -> str:
    if Seedance2I2VMode(mode) != Seedance2I2VMode.FIRST_FRAME:
        return ""
    return next(
        (item["h3_label"] for item in manifest if item["key"] == "first_frame"), ""
    )


def _has_storyboard_render(manifest: list[dict[str, str]]) -> bool:
    return any(item["key"] == "first_frame" for item in manifest)


def _require_h3_mode(mode: Seedance2I2VMode | str) -> Seedance2I2VMode:
    resolved = Seedance2I2VMode(mode)
    if resolved not in H3_SUPPORTED_MODES:
        raise ValueError(
            "MiniMax H3 needs at least one reference image and has no last-frame input: "
            "use first-frame or multi-reference mode"
        )
    return resolved


def build_h3_prompt_composer_task(
    *,
    mode: Seedance2I2VMode | str,
    beat: dict[str, Any],
    assets: list[Any] | None,
    text_overlay: dict[str, Any] | None,
    prompt_guidance: str,
    draft_prompt: str,
    duration: int | float | None = None,
    request_params: dict[str, Any] | None = None,
    manual_prompt_reference: str = "",
    frame_observation: str = "",
) -> str:
    mode = _require_h3_mode(mode)
    manifest = build_h3_asset_manifest(assets)
    payload = {
        "mode": mode.value,
        "duration_seconds": h3_effective_duration(duration),
        "first_frame_label": _first_frame_label(mode, manifest),
        "has_storyboard_render": _has_storyboard_render(manifest),
        "asset_manifest": manifest,
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
        "storyboard_frame_observation": _text(frame_observation),
        "asset_fallbacks": build_seedance2_asset_fallback_manifest(assets),
        "text_overlay": text_overlay or {},
        "user_prompt_guidance": _text(prompt_guidance),
        "manual_prompt_reference": normalize_seedance2_editor_prompt(
            manual_prompt_reference
        ),
        "request_params_for_context_only": request_params or {},
        "rule_based_draft_prompt": draft_prompt,
    }
    return (
        "Write the final MiniMax H3 prompt from the JSON below.\n\n"
        "Hard requirements:\n"
        "- Six sections in the required order; English except dialogue and visible text.\n"
        "- Only use <Picture N> and <Audio N> labels present in asset_manifest.\n"
        "- Cut times stay inside duration_seconds, strictly increasing and at least 1.2 seconds apart.\n"
        "- If first_frame_label is set, <Picture 1> is the first frame of [Shot 1].\n"
        "- Spoken dialogue and narration_segment must be kept verbatim inside <d>.\n"
        "- Follow the asset-role rule: identity/prop/scene pictures live inside <Subject N> definitions."
        + (
            " The first_frame picture is a storyboard anchor unless first_frame_label is set.\n"
            if _has_storyboard_render(manifest)
            else " There is no storyboard picture: cite every picture inside a <Subject N> definition and write no storyboard-reference line.\n"
        )
        +
        "- If storyboard_frame_observation is set, it is ground truth for camera position, direction of travel and framing; never contradict it.\n"
        "- If user guidance conflicts with the asset manifest or asset_fallbacks, the manifest wins.\n"
        "- Output only the final prompt.\n\n"
        f"{json.dumps(payload, ensure_ascii=False, indent=2, default=str)}"
    )


def create_h3_prompt_composer_agent():
    from pydantic_ai import Agent

    from novelvideo.config import get_newapi_text_pydantic_model

    return Agent(
        get_newapi_text_pydantic_model(
            "H3_PROMPT_COMPOSER_MODEL",
            brainclaw_profile=BrainClawProfile.H3_PROMPT_COMPOSITION,
            capability="text.generate.workflow",
        ),
        system_prompt=H3_COMPOSER_SYSTEM_PROMPT,
        output_type=str,
        name="MiniMax H3 Prompt Composer",
    )


_SECTION_RE = re.compile(r"(?m)^(" + "|".join(H3_SECTIONS) + r"):")
_SHOT_RE = re.compile(r"(?m)^\s*\[Shot (\d+)\](?: At (\d{2}):(\d{2})\.(\d{3}))?")
_PICTURE_RE = re.compile(r"<Picture (\d+)>")
_AUDIO_RE = re.compile(r"<Audio (\d+)>")
_STORYBOARD_LINE_RE = re.compile(
    r"<Picture \d+> is (?:a |the )?(?:current )?storyboard", re.IGNORECASE
)


def _strip_code_fence(prompt: str) -> str:
    text = _text(prompt)
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*\n", "", text)
        text = re.sub(r"\n```\s*$", "", text)
    return text.strip()


def validate_h3_prompt(
    prompt: str,
    *,
    n_pictures: int,
    n_audios: int,
    duration: float,
    require_picture_1: bool = False,
    allow_storyboard_line: bool = True,
) -> str:
    """Return the cleaned prompt, or raise ValueError when it breaks the H3 contract."""

    text = _strip_code_fence(prompt)
    found = [(m.group(1), m.start(), m.end()) for m in _SECTION_RE.finditer(text)]
    if [name for name, _, _ in found] != list(H3_SECTIONS):
        raise ValueError("H3 prompt must contain the six sections once each, in order")
    bodies = {
        name: text[end : found[i + 1][1] if i + 1 < len(found) else len(text)].strip()
        for i, (name, _, end) in enumerate(found)
    }
    if not bodies["detailed_description"]:
        raise ValueError("H3 prompt has an empty detailed_description")

    for number in map(int, _PICTURE_RE.findall(text)):
        if not 1 <= number <= n_pictures:
            raise ValueError(f"<Picture {number}> is not in the reference manifest")
    for number in map(int, _AUDIO_RE.findall(text)):
        if not 1 <= number <= n_audios:
            raise ValueError(f"<Audio {number}> is not in the reference manifest")
    if re.search(r"图片\d+|音频\d+|@(?:图片|音频|Picture|Audio)", text):
        raise ValueError("H3 prompt must not use Seedance reference tokens")
    if require_picture_1 and "<Picture 1>" not in text:
        raise ValueError("first-frame prompt must reference <Picture 1>")
    if not allow_storyboard_line and _STORYBOARD_LINE_RE.search(text):
        raise ValueError("H3 prompt cites a storyboard picture but no render is sent")

    shots = _SHOT_RE.findall(bodies["detailed_description"])
    if not shots or [int(n) for n, *_ in shots] != list(range(1, len(shots) + 1)):
        raise ValueError("shots must be numbered [Shot 1], [Shot 2], ... in order")
    previous = 0.0
    for index, (_, minutes, seconds, millis) in enumerate(shots, 1):
        if index == 1:
            if minutes:
                raise ValueError("[Shot 1] must not carry a timestamp")
            continue
        if not minutes:
            raise ValueError(f"[Shot {index}] needs an 'At MM:SS.mmm' cut time")
        cut = int(minutes) * 60 + int(seconds) + int(millis) / 1000
        if cut - previous < H3_MIN_CUT_GAP_SECONDS:
            raise ValueError(f"[Shot {index}] cut is closer than 1.2 seconds to the previous one")
        if cut >= duration:
            raise ValueError(f"[Shot {index}] cut is outside the {duration:g}s video")
        previous = cut
    return text


def review_h3_prompt(prompt: str, assets: list[Any] | None) -> list[dict[str, Any]]:
    """Reference problems of a saved or hand-edited prompt against the assets that will be sent.

    Only references are checked (not the section layout), so hand-written prompts stay usable.
    """

    text = normalize_seedance2_editor_prompt(prompt)
    if not text:
        return []
    manifest = build_h3_asset_manifest(assets)
    sent = {item["h3_label"] for item in manifest}
    issues: list[dict[str, Any]] = []
    if not _has_storyboard_render(manifest) and _STORYBOARD_LINE_RE.search(text):
        issues.append({"code": "storyboard_without_render", "refs": []})
    for code, pattern in (("unknown_picture", _PICTURE_RE), ("unknown_audio", _AUDIO_RE)):
        refs = list(
            dict.fromkeys(m.group(0) for m in pattern.finditer(text) if m.group(0) not in sent)
        )
        if refs:
            issues.append({"code": code, "refs": refs})
    return issues


def _language_tag(beat: dict[str, Any]) -> str:
    language: AssetLanguage = detect_seedance2_prompt_language(beat)
    return "English" if language == "en" else "Chinese"


def build_h3_prompt_draft(
    *,
    mode: Seedance2I2VMode | str,
    beat: dict[str, Any],
    assets: list[Any] | None,
    text_overlay: dict[str, Any] | None,
) -> str:
    """Structurally valid rule-based prompt; beat text is carried over untranslated."""

    mode = _require_h3_mode(mode)
    manifest = build_h3_asset_manifest(assets)
    first_frame = _first_frame_label(mode, manifest)
    pictures = [i for i in manifest if i["media_type"] == "image"]
    audios = [i for i in manifest if i["media_type"] == "audio"]
    visual = _sentence_text(beat.get("visual_description") or beat.get("synopsis"))
    scene = _sentence_text(beat.get("scene_description"))
    motion = _sentence_text(beat.get("video_prompt") or beat.get("keyframe_prompt"))
    spoken = _beat_spoken_text(beat)
    overlay = build_text_overlay_prompt_fragment(text_overlay, "en")

    definitions: list[str] = []
    retention: list[str] = []
    subjects: list[str] = []
    for item in pictures:
        label, title = item["h3_label"], item["title"] or "reference image"
        if label == first_frame:
            definitions.append(f"{label} is the first frame of [Shot 1], showing {visual or title}.")
            retention.append(f"{label} ([Shot 1] first frame): fully_preserved - the opening composition is kept.")
            continue
        if item["key"] == "first_frame":
            definitions.append(
                f"{label} is a storyboard reference for [Shot 1], defining viewpoint, "
                "subject placement and shot order."
            )
            retention.append(
                f"{label} (anchors [Shot 1]): partially_preserved - composition is followed."
            )
            continue
        subject = f"<Subject {len(subjects) + 1}>"
        subjects.append(subject)
        definitions.append(f"{subject} is {title}, taken from {label}.")
        retention.append(f"{subject} (appears in [Shot 1]): fully_preserved - appearance follows {label}.")
    for item in audios:
        label, title = item["h3_label"], item["title"] or "voice"
        definitions.append(f"{label} is the voice-timbre reference for {title}.")
        retention.append(f"{label}: reference - its timbre guides delivery without copying the signal.")

    task = "keyframe completion + reference generation" if first_frame else "reference generation"
    if audios:
        task += " + audio reference"
    shot = [visual or "The scene plays out as described by the storyboard."]
    if scene:
        shot.append(f"Environment: {scene}.")
    if motion:
        shot.append(f"Motion: {motion}.")
    shot.append("The camera holds a static shot.")
    if spoken:
        shot.append(f"The speaker (S1) says, <d>[{_language_tag(beat)}] {spoken}</d>")
    if overlay:
        shot.append(overlay)

    return "\n".join(
        [
            "subject_definitions:",
            *(definitions or ["N/A"]),
            "",
            "summary:",
            f"[{task}] {visual or 'A single-shot clip built from the listed references.'}",
            "",
            "retention_analysis:",
            *(retention or ["N/A"]),
            "",
            "detailed_description:",
            "The target video is live-action and cinematic with natural lighting.",
            "[Shot 1] " + " ".join(shot),
            "",
            "overall_soundscape:",
            "Soft ambient room tone continues throughout the video.",
            "",
            "non_diegetic_music:",
            "N/A",
        ]
    )


async def observe_storyboard_frame(beat: dict[str, Any], assets: list[Any] | None) -> str:
    """What a vision model sees in the beat's render, or "" when it cannot be read."""

    from novelvideo.generators.claude_vision import describe_frame_layout_or_empty

    frame = next(
        (
            asset
            for asset in assets or []
            if _text(_asset_value(asset, "key")) == "first_frame"
            and _asset_value(asset, "exists")
        ),
        None,
    )
    if frame is None:
        return ""
    return await describe_frame_layout_or_empty(
        _asset_value(frame, "path"),
        action_text=_text(beat.get("visual_description") or beat.get("synopsis")),
    )


async def compose_h3_prompt_with_agent(
    *,
    mode: Seedance2I2VMode | str,
    beat: dict[str, Any],
    assets: list[Any] | None,
    text_overlay: dict[str, Any] | None,
    prompt_guidance: str,
    draft_prompt: str,
    duration: int | float | None = None,
    request_params: dict[str, Any] | None = None,
    manual_prompt_reference: str = "",
) -> str:
    agent = create_h3_prompt_composer_agent()
    frame_observation = await observe_storyboard_frame(beat, assets)
    result = await agent.run(
        build_h3_prompt_composer_task(
            mode=mode,
            beat=beat,
            assets=assets,
            text_overlay=text_overlay,
            prompt_guidance=prompt_guidance,
            draft_prompt=draft_prompt,
            duration=duration,
            request_params=request_params,
            manual_prompt_reference=manual_prompt_reference,
            frame_observation=frame_observation,
        )
    )
    return str(result.output or "")


async def generate_h3_prompt(
    *,
    mode: Seedance2I2VMode | str,
    beat: dict[str, Any],
    assets: list[Any] | None,
    text_overlay: dict[str, Any] | None,
    prompt_guidance: str,
    prompt_guidance_template_keys: list[str] | tuple[str, ...] | None = None,
    duration: int | float | None = None,
    request_params: dict[str, Any] | None = None,
    manual_prompt_reference: str = "",
    composer: Seedance2PromptComposer | None = None,
) -> Seedance2PromptGeneration:
    """Generate an H3 prompt, preferring AI and falling back to the rule-based draft."""

    mode = _require_h3_mode(mode)
    manifest = build_h3_asset_manifest(assets)
    draft_prompt = build_h3_prompt_draft(
        mode=mode, beat=beat, assets=assets, text_overlay=text_overlay
    )
    has_render = _has_storyboard_render(manifest)
    if not has_render and _STORYBOARD_LINE_RE.search(
        normalize_seedance2_editor_prompt(manual_prompt_reference)
    ):
        # Written while the render was still sent: its role line and picture numbers are stale.
        manual_prompt_reference = ""
    try:
        compose = composer or compose_h3_prompt_with_agent
        prompt = await compose(
            mode=mode,
            beat=beat,
            assets=assets,
            text_overlay=text_overlay,
            prompt_guidance=_localized_prompt_guidance(
                prompt_guidance, prompt_guidance_template_keys, "en"
            ),
            draft_prompt=draft_prompt,
            duration=duration,
            request_params=request_params or {},
            manual_prompt_reference=manual_prompt_reference,
        )
        prompt = validate_h3_prompt(
            prompt,
            n_pictures=sum(i["media_type"] == "image" for i in manifest),
            n_audios=sum(i["media_type"] == "audio" for i in manifest),
            duration=h3_effective_duration(duration),
            require_picture_1=bool(_first_frame_label(mode, manifest)),
            allow_storyboard_line=has_render,
        )
        return Seedance2PromptGeneration(
            prompt=prompt, used_ai=True, draft_prompt=draft_prompt, error=""
        )
    except Exception as exc:
        return Seedance2PromptGeneration(
            prompt=draft_prompt, used_ai=False, draft_prompt=draft_prompt, error=str(exc)
        )
