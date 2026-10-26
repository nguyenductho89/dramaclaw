"""Unit tests for the 2026-10-25 `runpod_qwen_edit` dispatch branch added to
`_generate_image()` (`generators/nanobanana_grid.py`), reached via
`generate_reference_edit_image` — the function Freezone's `/freezone/edit`
and `/freezone/relight` jobs call (`freezone/jobs.py`'s `run_freezone_edit`).

Previously this function only implemented openrouter/huimeng/openai/newapi/
`runpod_qwen` (+"google" as a bare fallback); `runpod_qwen_edit` fell
through to the Google genai branch and would have wrongly tried the
google-genai SDK with a RunPod API key. See `.claude/CLAUDE.md`.

No DB, no network, no GPU calls — `_call_runpod_qwen_edit_image_api` is
monkeypatched."""

from __future__ import annotations

from pathlib import Path

import pytest

from novelvideo.generators import nanobanana_grid


@pytest.mark.asyncio
async def test_generate_reference_edit_image_dispatches_to_runpod_qwen_edit(
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
        nanobanana_grid, "_call_runpod_qwen_edit_image_api", fake_call
    )

    result = await nanobanana_grid.generate_reference_edit_image(
        prompt="relight to golden hour",
        reference_images=[str(canvas_path)],
        output_path=str(output_path),
        config={
            "provider": "runpod_qwen_edit",
            "api_key": "test-runpod-key",
            "model": "qwen-image-edit-2511",
            "mode": "1x1",
            "rows": 1,
            "cols": 1,
            "total_panels": 1,
        },
    )

    assert result == output_path
    assert output_path.read_bytes() == b"fake-image-bytes"
    assert captured["api_key"] == "test-runpod-key"
    assert captured["model"] == "qwen-image-edit-2511"
    assert captured["prompt"] == "relight to golden hour"
    # reference_images[0] must be the canvas (edit target) — the worker
    # sizes its output off this image, see `_call_runpod_qwen_edit_image_api`.
    assert len(captured["reference_images"]) == 1
    assert captured["reference_images"][0][1] == b"not-a-real-png"


@pytest.mark.asyncio
async def test_generate_reference_edit_image_raises_on_runpod_qwen_edit_failure(
    monkeypatch, tmp_path: Path
):
    canvas_path = tmp_path / "canvas.png"
    canvas_path.write_bytes(b"not-a-real-png")
    output_path = tmp_path / "out.png"

    async def fake_call(**_kwargs):
        return None, "", "runpod qwen edit image requires at least the sketch as reference_images[0]"

    monkeypatch.setattr(
        nanobanana_grid, "_call_runpod_qwen_edit_image_api", fake_call
    )

    with pytest.raises(ValueError, match="RunPod Qwen Image Edit generation failed"):
        await nanobanana_grid.generate_reference_edit_image(
            prompt="relight to golden hour",
            reference_images=[str(canvas_path)],
            output_path=str(output_path),
            config={
                "provider": "runpod_qwen_edit",
                "api_key": "test-runpod-key",
                "model": "qwen-image-edit-2511",
                "mode": "1x1",
                "rows": 1,
                "cols": 1,
                "total_panels": 1,
            },
        )
