"""Freezone image node helpers."""

from __future__ import annotations

from pathlib import Path

from novelvideo.freezone.vision_gateway import (
    FREEZONE_IMAGE_REVERSE_PROMPT_TIMEOUT_SECONDS,
    VisionInput,
    call_freezone_vision_model,
    image_media_type,
)
from novelvideo.egress_context import TrustedEgressContext
from novelvideo.official_defaults import DEFAULT_FREEZONE_VISION_MODEL

DEFAULT_IMAGE_REVERSE_PROMPT_INSTRUCTION = (
    "Generate a structured prompt from the image, including subject description, environment, lighting, camera language and style keywords."
)


def build_image_reverse_prompt_task(instruction: str = "") -> str:
    lines = [
            "You are an image-node prompt reverse-engineering assistant.",
            "I will give you an image. Reverse-engineer from its content a prompt that can be used directly for text-to-image or image-to-image generation, written in the same language as the user's supplementary requirements (English if none are given).",
            "Requirements:",
            "- Output only the final prompt: no explanation, no markdown, no quotation marks.",
            "- The prompt should cover: subject, scene, composition/shot size, lighting, color tone, material/detail, atmosphere, style.",
            "- Write it the way a creator naturally writes prompts, not like an analysis report.",
            "- Do not invent key subjects or plot actions that are not in the image.",
            "- Keep it concise but information-dense, suitable for pasting directly into an image model.",
    ]
    clean_instruction = str(instruction or "").strip()
    if clean_instruction:
        lines.extend(["User supplementary requirements:", clean_instruction])
    return "\n".join(lines)


async def reverse_prompt_from_image(
    *,
    image_path: Path,
    instruction: str = "",
    egress_context: TrustedEgressContext | None = None,
) -> str:
    prompt = build_image_reverse_prompt_task(instruction)
    image_bytes = image_path.read_bytes()
    from novelvideo.freezone.presets import (
        complete_freezone_vision_egress,
        prepare_freezone_vision_egress,
    )

    vision_egress = await prepare_freezone_vision_egress(
        egress_context=egress_context,
        model_name=DEFAULT_FREEZONE_VISION_MODEL,
        prompt=prompt,
        images=[image_bytes],
        timeout_seconds=FREEZONE_IMAGE_REVERSE_PROMPT_TIMEOUT_SECONDS,
    )
    _model, prompt_text = await call_freezone_vision_model(
        prompt=prompt,
        images=[
            VisionInput(
                data=image_bytes,
                media_type=image_media_type(image_path.name),
            )
        ],
        timeout_seconds=FREEZONE_IMAGE_REVERSE_PROMPT_TIMEOUT_SECONDS,
        transport_context=vision_egress.transport_context if vision_egress else None,
    )
    prompt_text = prompt_text.strip()
    if prompt_text.startswith("```"):
        prompt_text = "\n".join(
            line for line in prompt_text.splitlines() if not line.strip().startswith("```")
        ).strip()
    if not prompt_text:
        raise RuntimeError("reverse prompt model returned empty prompt")
    await complete_freezone_vision_egress(vision_egress, result=prompt_text)
    return prompt_text
