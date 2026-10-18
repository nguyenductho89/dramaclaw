"""Bounded, cancellable local image output conversions."""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path

from PIL import Image, UnidentifiedImageError


async def _convert(
    command: list[str], output: Path, *, timeout: float, max_bytes: int
) -> Path:
    if not shutil.which(command[0]):
        raise RuntimeError("The local conversion service is temporarily unavailable. Please try again later.")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.stem + ".partial" + output.suffix)
    command = [str(temporary) if item == str(output) else item for item in command]
    process = await asyncio.create_subprocess_exec(
        *command, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL
    )
    try:
        await asyncio.wait_for(process.wait(), timeout)
        if (
            process.returncode
            or not temporary.is_file()
            or not 0 < temporary.stat().st_size <= max_bytes
        ):
            raise RuntimeError("Asset conversion failed or the result is too large. Please try a simpler asset.")
        temporary.replace(output)
        return output
    except BaseException:
        if process.returncode is None:
            process.kill()
            await process.wait()
        temporary.unlink(missing_ok=True)
        raise


async def transcode_gif(source: Path, output: Path) -> Path:
    if not source.is_file() or source.stat().st_size > 200 * 1024 * 1024:
        raise ValueError("The video does not exist or exceeds the conversion size limit.")
    filters = "fps=12,scale=480:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3"
    try:
        return await _convert(
            [
                "ffmpeg",
                "-y",
                "-protocol_whitelist",
                "file",
                "-format_whitelist",
                "mov,matroska,webm,avi",
                "-i",
                str(source),
                "-t",
                "15",
                "-vf",
                filters,
                "-an",
                "-loop",
                "0",
                str(output),
            ],
            output,
            timeout=120,
            max_bytes=30 * 1024 * 1024,
        )
    except asyncio.TimeoutError as exc:
        raise ValueError("GIF conversion timed out. Please try again.") from exc


async def vectorize_image(source: Path, output: Path) -> Path:
    if not source.is_file() or source.stat().st_size > 20 * 1024 * 1024:
        raise ValueError("The image does not exist or exceeds the conversion size limit.")
    try:
        with Image.open(source) as image:
            width, height = image.size
            if width * height > 24_000_000:
                raise ValueError("The image is too large. Please use a smaller image.")
    except (OSError, UnidentifiedImageError) as exc:
        raise ValueError("Unable to read the image.") from exc
    try:
        return await _convert(
            [
                "vtracer",
                str(source),
                str(output),
                "--preset",
                "poster",
                "--simplify",
                "1.5",
            ],
            output,
            timeout=90,
            max_bytes=12 * 1024 * 1024,
        )
    except asyncio.TimeoutError as exc:
        raise ValueError("The image is too detailed and conversion timed out. Please use a simpler image.") from exc
