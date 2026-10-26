"""Unit tests for the 2026-10-26 `runpod_qwen21_render` dispatch branch added
to `_generate_image()` (`generators/nanobanana_grid.py`), reached via
`generate_reference_edit_image` — the function Freezone's `/freezone/edit`
jobs call (`freezone/jobs.py`'s `run_freezone_edit`).

Root cause this wires a fix for: Freezone's existing `runpod_qwen` dispatch
calls `_call_runpod_qwen_image_api`, whose ComfyUI graph
(`_runpod_qwen_image_graph`) feeds `KSampler` an `EmptyLatentImage` sized
independently of any reference image — exactly the "sample at a different
size" case the official `TextEncodeQwenImage21` node's own latent-output
tooltip warns "shifts the edit" for. The main render pipeline already fixed
this on 2026-10-18 for composition-preserving edits
(`_runpod_qwen21_render_image_graph`/`_call_runpod_qwen21_render_image_api`,
which wires the KSampler latent to `TextEncodeQwenImage21`'s own latent
output instead) but it was never reachable from Freezone until now. See
`.claude/CLAUDE.md`.

No DB, no network, no GPU calls — `_call_runpod_qwen21_render_image_api` is
monkeypatched."""

from __future__ import annotations

from pathlib import Path

import pytest

from novelvideo.generators import nanobanana_grid


@pytest.mark.asyncio
async def test_generate_reference_edit_image_dispatches_to_runpod_qwen21_render(
    monkeypatch, tmp_path: Path
):
    canvas_path = tmp_path / "canvas.png"
    canvas_path.write_bytes(b"not-a-real-png")
    output_path = tmp_path / "out.png"

    captured: dict = {}

    async def fake_call(*, api_key, model, prompt, reference_images=None, **_kwargs):
        captured["api_key"] = api_key
        captured["model"] = model
        captured["prompt"] = prompt
        captured["reference_images"] = reference_images
        return b"fake-image-bytes", "", ""

    monkeypatch.setattr(
        nanobanana_grid, "_call_runpod_qwen21_render_image_api", fake_call
    )

    result = await nanobanana_grid.generate_reference_edit_image(
        prompt="<image1> is the location still. <image2> is Yui's reference sheet. Compose a new photorealistic photograph placing Yui from <image2> into the scene of <image1>, keeping <image1>'s composition, camera framing and scale unchanged.",
        reference_images=[str(canvas_path)],
        output_path=str(output_path),
        config={
            "provider": "runpod_qwen21_render",
            "api_key": "test-runpod-key",
            "model": "qwen-image-2.1",
            "mode": "1x1",
            "rows": 1,
            "cols": 1,
            "total_panels": 1,
        },
    )

    assert result == output_path
    assert output_path.read_bytes() == b"fake-image-bytes"
    assert captured["api_key"] == "test-runpod-key"
    assert captured["model"] == "qwen-image-2.1"
    # reference_images[0] must be the canvas (size-anchor image) — the
    # callee resizes every reference to match it via
    # `_qwen21_prepare_render_image`, see `_call_runpod_qwen21_render_image_api`.
    assert len(captured["reference_images"]) == 1
    assert captured["reference_images"][0][1] == b"not-a-real-png"


@pytest.mark.asyncio
async def test_generate_reference_edit_image_raises_on_runpod_qwen21_render_failure(
    monkeypatch, tmp_path: Path
):
    canvas_path = tmp_path / "canvas.png"
    canvas_path.write_bytes(b"not-a-real-png")
    output_path = tmp_path / "out.png"

    async def fake_call(**_kwargs):
        return (
            None,
            "",
            "runpod qwen21 render image requires at least the canvas as reference_images[0]",
        )

    monkeypatch.setattr(
        nanobanana_grid, "_call_runpod_qwen21_render_image_api", fake_call
    )

    with pytest.raises(
        ValueError, match="RunPod Qwen Image 2.1 \\(render graph\\) generation failed"
    ):
        await nanobanana_grid.generate_reference_edit_image(
            prompt="compose",
            reference_images=[str(canvas_path)],
            output_path=str(output_path),
            config={
                "provider": "runpod_qwen21_render",
                "api_key": "test-runpod-key",
                "model": "qwen-image-2.1",
                "mode": "1x1",
                "rows": 1,
                "cols": 1,
                "total_panels": 1,
            },
        )
