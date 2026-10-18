"""Local verification: fact check of a single beat's sketch/first frame."""

import logging
from pathlib import Path
import time
from typing import Any

from pydantic_ai import Agent, BinaryContent

from novelvideo.models import beat_scene_id
from novelvideo.utils.asset_resolver import AssetResolver

from .models import VerificationResult
from .prompts import SKETCH_VERIFY_PROMPT
from .sanitize import sanitize_prompt_input
from .utils import compress_image

logger = logging.getLogger(__name__)


def resolve_verification_scene_context(
    project_dir: str | Path,
    beat: dict[str, Any],
    *,
    episode_number: int | None = None,
    scenes: list[Any] | tuple[Any, ...] | None = None,
) -> dict[str, Any]:
    """Resolve scene context for verification without making the verifier parse assets."""

    refs = AssetResolver(
        Path(project_dir),
        episode_number=episode_number,
        scenes=scenes or [],
    ).resolve_scenes_for_beat(beat)
    primary_ref = refs[0] if refs else None
    return {
        "scene_id": beat_scene_id(beat) or str(beat.get("location", "") or "").strip(),
        "resolved_scene_name": str(getattr(primary_ref, "base_id", "") or "").strip(),
        "time_baked": bool(getattr(primary_ref, "time_baked", False)),
        "prompt_time_of_day": str(beat.get("time_of_day", "") or "").strip(),
    }


class ImageVerifier:
    def __init__(self):
        self._agent: Agent | None = None

    def _get_agent(self) -> Agent:
        if self._agent is None:
            from novelvideo.config import (
                get_newapi_structured_output_model_settings,
                get_pydantic_model,
            )

            self._agent = Agent(
                get_pydantic_model(),
                system_prompt=SKETCH_VERIFY_PROMPT,
                output_type=VerificationResult,
                model_settings=get_newapi_structured_output_model_settings(),
                output_retries=2,
                name="Sketch verifier",
            )
        return self._agent

    async def verify_sketch(
        self,
        image_path: str,
        visual_prompt: str,
        named_characters: list[str],
        scene_id: str,
        time_of_day: str = "",
        camera_context: str = "",
        color_mapping: dict[str, str] | None = None,
        resolved_scene_name: str = "",
        time_baked: bool = False,
        prompt_time_of_day: str = "",
    ) -> VerificationResult:
        """Verify whether the sketch matches the description.

        Args:
            image_path: Sketch file path
            visual_prompt: The beat's visual_description field
            named_characters: List of character names extracted from {{}} markers
            scene_id: The beat's base scene ID
            time_of_day: The beat's target time information, used for lighting contradiction checks
            camera_context: Camera reference information (from keyframe_prompt or video_prompt)
            resolved_scene_name: The scene/plate name actually resolved
            time_baked: True means a scene image with the time already baked in was hit, so its lighting should be locked
            prompt_time_of_day: The target time actually used for prompting/verification; falls back to time_of_day when empty
        """
        safe_visual = sanitize_prompt_input(visual_prompt)
        safe_scene_id = sanitize_prompt_input(scene_id)
        safe_resolved_scene = sanitize_prompt_input(resolved_scene_name)
        safe_time = sanitize_prompt_input(prompt_time_of_day or time_of_day)
        resolved_scene_line = (
            f"\nResolved scene: {safe_resolved_scene}" if safe_resolved_scene else ""
        )
        if safe_time and time_baked:
            time_line = (
                f"\nTime: {safe_time}"
                f"\nTime/lighting verification: a scene image with the time baked in was hit; lock its built-in {safe_time} lighting; "
                "do not require an extra relight; only report a contradiction when the picture clearly does not have that time's lighting."
            )
        elif safe_time:
            time_line = (
                f"\nTime: {safe_time}"
                f"\nTime/lighting verification: the current scene image does not have the time baked in; the picture should present {safe_time} through generation/relight."
            )
        else:
            time_line = "\nTime/lighting verification: time_of_day not specified; skip the time/lighting contradiction check."
        chars_text = f"Known named characters: {', '.join(named_characters)} ({len(named_characters)} in total)" if named_characters else "Known named characters: none"
        camera_line = f"\nCamera reference: {sanitize_prompt_input(camera_context)}" if camera_context else ""
        color_line = ""
        if color_mapping:
            lines = []
            for identity_id, color_str in sorted(color_mapping.items()):
                parts = color_str.split(" ", 1)
                hex_code = parts[0]
                color_name = parts[1] if len(parts) > 1 else ""
                lines.append(f"- {color_name} ({hex_code}) = {identity_id}")
            if lines:
                color_line = "\nCharacter color markers:\n" + "\n".join(lines)
        task = (
            f"Verify whether the sketch matches the following description:\n"
            f"Picture description: {safe_visual}\n"
            f"{chars_text}\n"
            f"Judge from the picture description how many people should appear (possibly more than the number of known named characters).\n"
            f"Scene: {safe_scene_id}{resolved_scene_line}{time_line}{camera_line}{color_line}\n"
            f"Note: 'the other party', 'he' and 'she' mentioned in the description may be off-screen characters and are not required to appear in the picture."
        )
        image_bytes = compress_image(image_path)
        agent = self._get_agent()
        start = time.monotonic()
        result = await agent.run(
            [task, BinaryContent(data=image_bytes, media_type="image/jpeg")]
        )
        elapsed = time.monotonic() - start
        logger.info(
            "Sketch verify: score=%.1f passed=%s elapsed=%.1fs",
            result.output.score, result.output.passed, elapsed,
        )
        return result.output
