"""First/last-frame transition prompt generation Agent.

Analyzes the difference between two frames and generates a prompt describing the transition motion.
Used for video generation models that accept first/last-frame input.
"""

import io
import os
from typing import Optional

from pydantic_ai import Agent, BinaryContent
from PIL import Image as PILImage

from novelvideo.brainclaw_contract import BrainClawProfile
from novelvideo.utils.logging import log_agent_start, log_agent_end
from novelvideo.utils.source_language import asset_language_instruction, language_name

# First/last-frame transition prompt generator instructions (English SuperPower version)
KEYFRAME_PROMPT_BUILDER_INSTRUCTIONS_EN = """# Cinematic Transition Director (SuperPower)

You craft 5-second transitions between two keyframes. The AI video model interpolates between them; your prompt guides the cinematic journey.

## Input
- Image 1: first frame (starting point)
- Image 2: last frame (ending point)
- Narration: story context and intent

## Prompt Formula
[Camera Movement with displacement] + [Character/Object Transition] + [Audio Layer]

## MUST
✓ Write in the requested output language, **present tense** throughout
✓ 4–6 sentences, with length appropriate for the requested language
✓ Describe the *journey* between frames, not just start/end
✓ Use visible elements from both frames as anchors

## Camera
- Every prompt MUST include a camera direction with displacement or zoom (push-in, dolly, pan, tilt, track, crane, orbit, zoom)
- **BANNED static camera**: holds, stays, remains, static, locked, fixed
- Describe the camera endpoint: what the frame looks like when camera motion finishes

## BANNED
❌ Character names → use visual features ("the woman in black", "the older man")
❌ Abstract emotion labels (sad, haunting, desperate, hopeful, anxious, melancholy) → show via body language
❌ Non-visual senses (smell, temperature, humidity, taste, tactile)
❌ Static primary verbs (freezes, stares, stands, waits, remains, holds still) as main action
❌ Reversing or oscillating motion (steps forward then back, leans in then pulls away, nods then shakes head)
❌ Inventing elements absent from both frames
❌ Multiple conflicting camera movements simultaneously

## Audio Layer (superset — works on audio-capable models, ignored by others)
- Add ONE short ambient sound sentence
- For dialogue beats, also specify voice style (calm, urgent, whisper, etc.)

## Detail ↔ Shot Scale
- Close-up → micro details (pores, thread count, iris dilation)
- Wide shot → broad motion arcs and spatial relationships

## Sustained Motion
The clip is ~5 seconds. Describe a **chain of 2–3 connected actions** that bridge first frame to last frame continuously.
⚠️ **UNIDIRECTIONAL motion only**: every action must move in ONE direction — forward, never back. If the primary action is short, extend it with follow-through motion in the SAME direction.

## Output
Output ONLY the transition prompt in the requested language.
"""


def create_keyframe_prompt_builder_agent(language: str = "en") -> Agent:
    """Create the first/last-frame transition prompt generation Agent."""
    from novelvideo.config import get_newapi_text_pydantic_model
    model = get_newapi_text_pydantic_model(
        "KEYFRAME_PROMPT_MODEL",
        brainclaw_profile=BrainClawProfile.KEYFRAME_TRANSITION_PROMPT_GENERATION,
        capability="text.generate.agent",
    )
    return Agent(
        model,
        system_prompt=build_keyframe_system_prompt(language),
        output_type=str,
        name="Keyframe Prompt Builder",
    )


def keyframe_output_label(language: str) -> str:
    return language_name(language)


def build_keyframe_system_prompt(language: str = "en") -> str:
    return (
        f"{KEYFRAME_PROMPT_BUILDER_INSTRUCTIONS_EN}\n\n"
        f"## Output Language\n{asset_language_instruction(language)}"
    )


def build_keyframe_task(
    *,
    narration: str,
    next_narration: str = "",
    language: str = "en",
    color_map_text: str = "",
    visual_description: str = "",
    next_visual_description: str = "",
    audio_type: str = "narration",
    dialogue_line: str = "",
) -> str:
    """User message sent with the two keyframe images (the images themselves are attached)."""
    # Build the dialogue hint
    dialogue_hint = ""
    if audio_type == "dialogue" and dialogue_line:
        dialogue_hint = "\n⚠️ This Beat is DIALOGUE — speaking is the primary motion. Describe lips moving, gestures while talking. Dialogue text is appended by the system; only describe physical action.\n"

    # Build the task prompt
    output_label = language_name(language)
    length_target = "4-6 sentences, ~50-90 words"
    language_instruction = asset_language_instruction(language)

    if color_map_text:
        # English + color map mode (SuperPower)
        task = f"""Craft a 5-second transition between these two sketches in {output_label} ({length_target}).

## Images
- Image 1: First sketch (starting point)
- Image 2: Last sketch (ending point)

## Character Color Map (sketch color marks → character appearance)
{color_map_text}

## First Frame Visual Description
{visual_description if visual_description else "N/A"}
## Last Frame Visual Description
{next_visual_description if next_visual_description else "N/A"}

## Narration (Story Intent)
{narration}
"""
        if next_narration:
            task += f"\n## Next Narration (Emotional Direction)\n{next_narration}\n"
        task += f"""{dialogue_hint}
## Rules
- Identify characters by color marks, NEVER use character names
- Camera must have displacement/zoom, describe camera endpoint
- NO emotion labels → use body language
- Include ambient audio layer
- {length_target}

## Output Language
{language_instruction}

Output the transition prompt in {output_label} directly."""
    else:
        task = f"""Craft an imaginative 5-second transition between these two frames in {output_label} ({length_target}).

## Images
- Image 1: First frame (starting point)
- Image 2: Last frame (ending point)

## Narration (Story Intent)
{narration}
"""
        if next_narration:
            task += f"\n## Next Narration (Emotional Direction)\n{next_narration}\n"
        task += f"""{dialogue_hint}
## Rules
- Describe visible element transitions from the frames
- Camera must have displacement/zoom, describe camera endpoint
- NO character names → use visual features
- NO emotion labels → use body language
- Include ambient audio layer
- {length_target}

## Output Language
{language_instruction}

Output the transition prompt in {output_label} directly."""
    return task


class KeyframePromptBuilder:
    """First/last-frame transition prompt builder.

    Analyzes the difference between two frames and generates a prompt describing the transition motion.
    Supports multimodal input: analyzes the first-frame and last-frame images together.

    Example:
        >>> builder = KeyframePromptBuilder()
        >>> prompt = await builder.build(
        ...     first_frame_path="beat_04.png",
        ...     last_frame_path="beat_05.png",
        ...     narration="That familiar profile made my heart skip a beat",
        ... )
    """

    def __init__(self):
        self._agents: dict[str, Agent] = {}  # agents cached per language
        self._last_context: str = ""  # stores the context of the last generation

    @property
    def last_context(self) -> str:
        """Return the context used the last time a prompt was generated."""
        return self._last_context

    def _get_agent(self, language: str = "en") -> Agent:
        """Get the Agent for the given language (lazily loaded)."""
        if language not in self._agents:
            self._agents[language] = create_keyframe_prompt_builder_agent(language)
        return self._agents[language]

    def _compress_image(self, image_path: str, compress_quality: int = 60) -> bytes:
        """Compress the image and return bytes.

        Args:
            image_path: image file path
            compress_quality: JPEG compression quality (1-100)

        Returns:
            The compressed image bytes
        """
        img = PILImage.open(image_path)
        original_size = os.path.getsize(image_path)

        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")

        buffer = io.BytesIO()
        img.save(buffer, format="JPEG", quality=compress_quality, optimize=True)
        image_bytes = buffer.getvalue()

        compressed_size = len(image_bytes)
        ratio = (1 - compressed_size / original_size) * 100
        print(
            f"[KeyframePromptBuilder] Compressed image: {os.path.basename(image_path)}: "
            f"{original_size / 1024:.0f}KB → {compressed_size / 1024:.0f}KB "
            f"({ratio:.0f}% smaller)"
        )

        return image_bytes

    async def build(
        self,
        first_frame_path: str,
        last_frame_path: str,
        narration: str,
        next_narration: str = "",
        language: str = "en",
        color_map_text: str = "",
        visual_description: str = "",
        next_visual_description: str = "",
        audio_type: str = "narration",
        dialogue_line: str = "",
        allow_fallback: bool = True,
    ) -> str:
        """Generate the first/last-frame transition prompt.

        Args:
            first_frame_path: first-frame path of the current beat
            last_frame_path: first-frame path of the next beat
            narration: narration of the current beat
            next_narration: narration of the next beat (optional, gives more context)
            language: output language ("en" or "vi")
            allow_fallback: whether to fall back to the default transition prompt when the model call fails.
                When False the exception is raised directly, so a generic template is not
                silently saved as this beat's prompt.
        Returns:
            The first/last-frame transition prompt
        """
        # Verify that the images exist
        if not os.path.exists(first_frame_path):
            raise FileNotFoundError(f"First frame not found: {first_frame_path}")
        if not os.path.exists(last_frame_path):
            raise FileNotFoundError(f"Last frame not found: {last_frame_path}")

        # Compress the first/last-frame images
        first_frame_bytes = self._compress_image(first_frame_path)
        last_frame_bytes = self._compress_image(last_frame_path)

        first_frame_image = BinaryContent(
            data=first_frame_bytes, media_type="image/jpeg"
        )  # first frame
        last_frame_image = BinaryContent(
            data=last_frame_bytes, media_type="image/jpeg"
        )  # last frame

        task = build_keyframe_task(
            narration=narration,
            next_narration=next_narration,
            language=language,
            color_map_text=color_map_text,
            visual_description=visual_description,
            next_visual_description=next_visual_description,
            audio_type=audio_type,
            dialogue_line=dialogue_line,
        )
        lang_hint = keyframe_output_label(language)

        log_agent_start("Keyframe transition prompt builder", f"Generating transition description ({lang_hint})")

        # Store the context for debugging
        self._last_context = task

        try:
            agent = self._get_agent(language)
            response = await agent.run([task, first_frame_image, last_frame_image])

            # Extract the transition description
            result = (
                response.output.strip() if response.output else str(response).strip()
            )

            # Detect error responses
            error_indicators = [
                "ClientResponse",
                "Service Unavailable",
                "503",
                "500",
                "UNAVAILABLE",
                "overloaded",
            ]
            if any(indicator in result for indicator in error_indicators):
                raise RuntimeError(f"API returned an error response: {result[:200]}")

            log_agent_end(
                "Keyframe transition prompt builder",
                success=True,
                result=f"{len(result)} characters",
            )
            # dialogue beat: append the dialogue line
            if audio_type == "dialogue" and dialogue_line:
                result = f'{result} Says: "{dialogue_line}"'
            return result

        except Exception as e:
            log_agent_end(
                "Keyframe transition prompt builder", success=False, result=str(e)
            )
            if not allow_fallback:
                raise
            # On failure fall back to the default prompt
            return self._fallback_build(language)

    def _fallback_build(
        self,
        language: str = "en",
    ) -> str:
        """Fallback: generate a default transition prompt."""
        return (
            "The character adjusts their posture naturally as the camera "
            "tracks the movement into a smooth transition."
        )


# Module-level singleton
_keyframe_prompt_builder: Optional[KeyframePromptBuilder] = None


def get_keyframe_prompt_builder() -> KeyframePromptBuilder:
    """Get the KeyframePromptBuilder singleton."""
    global _keyframe_prompt_builder
    if _keyframe_prompt_builder is None:
        _keyframe_prompt_builder = KeyframePromptBuilder()
    return _keyframe_prompt_builder
