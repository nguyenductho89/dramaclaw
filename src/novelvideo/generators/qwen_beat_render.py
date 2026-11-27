"""Sketch-free beat render: Qwen-Image 2.1 builds the frame from scene/identity/prop refs."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from novelvideo.agents.qwen_image_prompt_builder import (
    QwenReference,
    collect_qwen_references,
    compose_qwen_render_prompt,
)
from novelvideo.generators.nanobanana_grid import _call_newapi_image_api
from novelvideo.generators.scene_reference_images import _reference_tuple_from_path
from novelvideo.seedance2_i2v.assets import build_seedance2_project_assets
from novelvideo.seedance2_i2v.models import Seedance2I2VMode
from novelvideo.shared.failure_signals import with_upstream_status

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class QwenBeatRender:
    image_path: Path
    prompt: str
    used_ai_prompt: bool
    references: list[QwenReference]


async def generate_qwen_beat_render(
    *,
    project_output: str | Path,
    state_dir: str | Path,
    episode: int,
    beat: dict[str, Any],
    generator_config: dict[str, Any],
    aspect_ratio: str,
    output_path: Path,
    style: str = "",
    egress_context: Any = None,
) -> QwenBeatRender:
    """Render one beat straight from its reference images; no sketch is read."""

    assets = build_seedance2_project_assets(
        project_output=Path(project_output),
        episode=episode,
        beat=beat,
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        state_dir=state_dir,
    )
    references = collect_qwen_references(assets)
    reference_images = []
    for ref in references:
        item = _reference_tuple_from_path(ref.path)
        if item is None:
            raise RuntimeError(f"参考图无法读取: {ref.path}")
        reference_images.append(item)

    prompt, used_ai = await compose_qwen_render_prompt(
        beat=beat, references=references, style=style
    )
    if generator_config.get("provider") != "newapi":
        raise RuntimeError("Qwen 免草图 Render 只支持 newapi 网关")

    image_bytes, _text, error = await _call_newapi_image_api(
        api_key=str(generator_config.get("api_key") or ""),
        model=str(generator_config["model"]),
        prompt=prompt,
        reference_images=reference_images or None,
        image_config={
            "aspect_ratio": aspect_ratio,
            "image_size": "1K",
            "output_format": "png",
        },
        base_url=generator_config.get("base_url"),
        egress_context=egress_context,
    )
    if error or not image_bytes:
        raise with_upstream_status(
            RuntimeError(str(error or "Qwen image API returned no image bytes")), error
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(image_bytes)
    output_path.with_suffix(".prompt.txt").write_text(prompt, encoding="utf-8")
    logger.info(
        "Qwen beat render done: episode=%s beat=%s refs=%d ai_prompt=%s",
        episode,
        beat.get("beat_number"),
        len(references),
        used_ai,
    )
    return QwenBeatRender(
        image_path=output_path,
        prompt=prompt,
        used_ai_prompt=used_ai,
        references=references,
    )
