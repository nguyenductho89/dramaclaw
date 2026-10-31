"""Smart extend on MiniMax H3 (2026-10-31): last frame of the source clip -> first frame."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi import HTTPException

from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.api.schemas import FreezoneVideoOmniGenRequest
from novelvideo.freezone.video_node import (
    H3_EXTEND_MAX_REFERENCE_IMAGES,
    extract_last_frame_png,
    h3_extend_aspect_ratio,
)
from tests.test_freezone_video_route_modes import _install_route_fakes

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")

H3_CATALOG = {
    "catalog_id": "runpod_minimax_h3",
    "supportedModes": ["first_frame", "image_reference"],
    "referenceImageMax": 9,
    "referenceVideoMax": 0,
    "referenceAudioMax": 3,
    "resolutionOptions": ["auto"],
    "minDuration": 5,
    "maxDuration": 12,
}


def _make_clip(path: Path, width: int, height: int, frames: int = 12) -> Path:
    """Clip whose red channel is 20 * frame index, so every frame is distinguishable."""
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-f", "lavfi", "-i", f"color=c=black:s={width}x{height}:r=24",
            "-vf", "geq=r='N*20':g=0:b=0", "-frames:v", str(frames),
            "-pix_fmt", "yuv444p", "-c:v", "libx264", "-crf", "0", str(path),
        ],
        check=True,
    )
    return path


def test_extract_last_frame_png_takes_the_final_frame(tmp_path: Path) -> None:
    from PIL import Image

    clip = _make_clip(tmp_path / "clip.mp4", 64, 96, frames=12)
    out = extract_last_frame_png(clip, tmp_path / "sub" / "last.png")
    r = Image.open(out).convert("RGB").getpixel((10, 10))[0]
    # frame index 11 -> r = 220. A frame ~0.2s before the end (index 6-7) would give 120-140.
    assert r > 200, f"not the last frame, red={r}"


def test_extract_last_frame_png_missing_video(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        extract_last_frame_png(tmp_path / "nope.mp4", tmp_path / "out.png")


def test_h3_extend_aspect_ratio_follows_frame_orientation(tmp_path: Path) -> None:
    from PIL import Image

    Image.new("RGB", (768, 1344)).save(tmp_path / "p.png")
    Image.new("RGB", (1344, 768)).save(tmp_path / "l.png")
    assert h3_extend_aspect_ratio(tmp_path / "p.png") == "9:16"
    assert h3_extend_aspect_ratio(tmp_path / "l.png") == "16:9"


async def _h3_fakes(monkeypatch, tmp_path: Path) -> dict:
    captured = await _install_route_fakes(monkeypatch, tmp_path, H3_CATALOG)

    async def resolve_backend(_model, *, requester_user_id):
        return "runpod_minimax_h3"

    monkeypatch.setattr(freezone_routes, "_resolve_catalog_video_backend", resolve_backend)
    return captured


@pytest.mark.asyncio
async def test_continuation_on_h3_uses_last_frame_as_first_frame(monkeypatch, tmp_path: Path) -> None:
    captured = await _h3_fakes(monkeypatch, tmp_path)
    clip = _make_clip(tmp_path / "source.mp4", 64, 96)
    sheet_a, sheet_b = tmp_path / "man.png", tmp_path / "woman.png"
    sheet_a.write_bytes(b"x")
    sheet_b.write_bytes(b"y")

    await freezone_routes.freezone_video_omni_gen(
        "project",
        FreezoneVideoOmniGenRequest(
            prompt="subject_definitions:\n<Picture 1> is the first frame.",
            references=[
                {"type": "video", "url": str(clip)},
                {"type": "image", "url": str(sheet_a)},
                {"type": "image", "url": str(sheet_b)},
            ],
            aspect_ratio="auto",
            model="runpod_minimax_h3",
            continuation=True,
        ),
        {"username": "admin"},
    )

    start = captured["start"]
    items = start["reference_items"]
    assert [i["type"] for i in items] == ["image", "image", "image"]  # video was consumed
    assert items[0]["role"] == "first frame"
    assert Path(items[0]["path"]).exists() and items[0]["path"].endswith("_extend_first.png")
    assert [i["path"] for i in items[1:]] == [str(sheet_a), str(sheet_b)]  # sheets keep their order
    assert start["aspect_ratio"] == "9:16"  # portrait source, H3 only knows 16:9 / 9:16
    assert start["gen_mode"] == "image_reference"  # not video_extend: H3 has no such task
    assert start["requested_gen_mode"] == "allReference"
    assert start["prompt"] == "subject_definitions:\n<Picture 1> is the first frame."  # no Seedance wording
    assert "Video extension requirement" not in start["prompt"]


@pytest.mark.asyncio
async def test_continuation_on_h3_keeps_an_explicit_ratio(monkeypatch, tmp_path: Path) -> None:
    captured = await _h3_fakes(monkeypatch, tmp_path)
    clip = _make_clip(tmp_path / "source.mp4", 64, 96)

    await freezone_routes.freezone_video_omni_gen(
        "project",
        FreezoneVideoOmniGenRequest(
            prompt="go on",
            references=[{"type": "video", "url": str(clip)}],
            aspect_ratio="16:9",
            model="runpod_minimax_h3",
            continuation=True,
        ),
        {"username": "admin"},
    )
    assert captured["start"]["aspect_ratio"] == "16:9"


@pytest.mark.asyncio
async def test_continuation_on_h3_requires_a_video(monkeypatch, tmp_path: Path) -> None:
    await _h3_fakes(monkeypatch, tmp_path)
    with pytest.raises(HTTPException, match="continuation requires a video reference"):
        await freezone_routes.freezone_video_omni_gen(
            "project",
            FreezoneVideoOmniGenRequest(
                prompt="go on",
                references=[{"type": "image", "url": str(tmp_path / "a.png")}],
                model="runpod_minimax_h3",
                continuation=True,
            ),
            {"username": "admin"},
        )


@pytest.mark.asyncio
async def test_continuation_on_h3_caps_reference_images(monkeypatch, tmp_path: Path) -> None:
    await _h3_fakes(monkeypatch, tmp_path)
    clip = _make_clip(tmp_path / "source.mp4", 64, 96)
    images = [{"type": "image", "url": str(tmp_path / f"{i}.png")} for i in range(H3_EXTEND_MAX_REFERENCE_IMAGES + 1)]
    with pytest.raises(HTTPException, match="at most"):
        await freezone_routes.freezone_video_omni_gen(
            "project",
            FreezoneVideoOmniGenRequest(
                prompt="go on",
                references=[{"type": "video", "url": str(clip)}, *images],
                model="runpod_minimax_h3",
                continuation=True,
            ),
            {"username": "admin"},
        )


@pytest.mark.asyncio
async def test_h3_without_continuation_still_rejects_omni(monkeypatch, tmp_path: Path) -> None:
    """The bypass is only for continuation; plain omni on H3 keeps its old 'not supported' error."""
    await _h3_fakes(monkeypatch, tmp_path)
    with pytest.raises(HTTPException):
        await freezone_routes.freezone_video_omni_gen(
            "project",
            FreezoneVideoOmniGenRequest(
                prompt="x",
                references=[{"type": "image", "url": str(tmp_path / "a.png")}],
                model="runpod_minimax_h3",
            ),
            {"username": "admin"},
        )


def test_h3_catalog_entry_advertises_continuation(monkeypatch) -> None:
    monkeypatch.setattr("novelvideo.config._runpod_h3_video_configured", lambda: True)
    monkeypatch.setattr("novelvideo.config._runpod_h3_multishot_configured", lambda: False)
    entries = freezone_routes._freezone_dev_media_model_catalog_entries("video")
    h3 = next(e for e in entries if e["id"] == "runpod_minimax_h3")
    assert h3["supportsContinuation"] is True
    assert h3["referenceVideoMax"] == 0  # the video is consumed server-side, never a model reference
