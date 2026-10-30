"""SeedVR2 video upscale on the RunPod Qwen worker, split into one job per segment.

Why one RunPod job per segment instead of `SeedVR2TemporalChunk` inside one
job (measured on A40 48GB, 2026-10-29, SeedVR2 7B int8, 2x, 124 frames):
- whole clip in one pass: VRAM OOM in KSampler (43.35/44.42 GiB);
- `SeedVR2TemporalChunk(auto)`: VRAM fits (53-frame chunks), but the job still
  holds the full-length upscaled video (decoded frames + post-processing copies)
  in host RAM and the worker drops its websocket after ~670s, never recovering
  until `workers.max` is cycled 0 -> 1.

Each job here only ever sees `segment_frames` frames, so both VRAM and host RAM
are bounded by the segment, not by the clip. Adjacent segments overlap by
`overlap_frames` and are crossfaded locally (same Hann-shouldered window as
`SeedVR2TemporalMerge`), then the source audio is muxed back in.

Graph = the core-node part of Comfy-Org's `upscale_video_seedvr2_3b_int8`
blueprint (ComfyUI 0.37.2 core nodes, not the numz custom pack), without the
chunk/merge switch. The lanczos pre-resize is done locally with ffmpeg so the
graph needs no `ResizeImageMaskNode` dynamic-combo inputs.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import tempfile
import uuid
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

SEEDVR2_7B_UNET = "seedvr2_7b_int8_convrot.safetensors"
SEEDVR2_3B_UNET = "seedvr2_3b_int8_convrot.safetensors"
SEEDVR2_VAE = "seedvr2_ema_vae_fp16.safetensors"

# 33 frames at 2x measured OK on A40 with the 7B (196s); auto-chunking picked
# 53 for the same size, so 41 leaves VRAM headroom. Must be 4n+1.
DEFAULT_SEGMENT_FRAMES = 41
DEFAULT_OVERLAP_FRAMES = 8


@dataclass
class Segment:
    start: int
    end: int  # exclusive

    @property
    def length(self) -> int:
        return self.end - self.start


def plan_segments(total_frames: int, segment_frames: int, overlap_frames: int) -> list[Segment]:
    """Cover [0, total_frames) with segments of `segment_frames` frames.

    Adjacent segments share at least `overlap_frames` frames. The last segment
    is shifted back to end exactly at `total_frames` (so it keeps full length
    and full temporal context) — its overlap with the previous one may be
    larger than `overlap_frames`; `stitch_segments` handles any overlap.
    """
    if total_frames < 1:
        raise ValueError("total_frames must be >= 1")
    if segment_frames < 5 or (segment_frames - 1) % 4 != 0:
        raise ValueError(f"segment_frames must be 4n+1 and >= 5; got {segment_frames}")
    if not 0 <= overlap_frames < segment_frames:
        raise ValueError(f"overlap_frames must be in [0, segment_frames); got {overlap_frames}")
    if total_frames <= segment_frames:
        return [Segment(0, total_frames)]
    step = segment_frames - overlap_frames
    segments: list[Segment] = []
    start = 0
    while True:
        if start + segment_frames >= total_frames:
            segments.append(Segment(total_frames - segment_frames, total_frames))
            break
        segments.append(Segment(start, start + segment_frames))
        start += step
    return segments


def crossfade_weights(overlap: int) -> np.ndarray:
    """Weights for the previous segment across an overlap (next gets 1 - w).

    Same shape as ComfyUI's `_seedvr2_chunk_crossfade_weights`: flat shoulders
    on the outer thirds, Hann fade over the middle third.
    """
    if overlap <= 0:
        return np.zeros(0, dtype=np.float32)
    ramp = np.linspace(0.0, 1.0, overlap, dtype=np.float32)
    ramp = np.clip((ramp - 1.0 / 3.0) / (1.0 / 3.0), 0.0, 1.0)
    return (0.5 + 0.5 * np.cos(np.pi * ramp)).astype(np.float32)


def stitch_segments(segments: list[Segment], frames_per_segment: list[np.ndarray]) -> np.ndarray:
    """Merge per-segment frame arrays (T, H, W, C uint8) into one clip."""
    if len(segments) != len(frames_per_segment):
        raise ValueError("segments and frames_per_segment differ in length")
    total = segments[-1].end
    first = frames_per_segment[0]
    out = np.empty((total,) + first.shape[1:], dtype=np.uint8)
    filled = 0
    for seg, frames in zip(segments, frames_per_segment):
        if frames.shape[0] < seg.length:
            raise ValueError(
                f"segment {seg.start}-{seg.end} came back with {frames.shape[0]} frames, expected {seg.length}"
            )
        if frames.shape[1:] != first.shape[1:]:
            raise ValueError(f"segment {seg.start}-{seg.end} has frame shape {frames.shape[1:]}, expected {first.shape[1:]}")
        frames = frames[: seg.length]
        fade = max(0, filled - seg.start)
        if fade:
            w = crossfade_weights(fade).reshape(fade, 1, 1, 1)
            prev = out[seg.start : seg.start + fade].astype(np.float32)
            nxt = frames[:fade].astype(np.float32)
            out[seg.start : seg.start + fade] = np.clip(prev * w + nxt * (1.0 - w) + 0.5, 0, 255).astype(np.uint8)
        out[seg.start + fade : seg.end] = frames[fade:]
        filled = seg.end
    return out


def iter_stitched(segments: list[Segment], frames_per_segment: Iterable[np.ndarray]) -> Iterator[np.ndarray]:
    """Streaming twin of `stitch_segments`: yields the merged clip in order.

    Only one segment plus the not-yet-final overlap tail (`overlap_frames` of
    the previous segment) is alive at a time, so peak RAM is bounded by the
    segment, not by the clip. Concatenating the yielded chunks gives exactly
    `stitch_segments(segments, list(frames_per_segment))`.
    """
    tail: np.ndarray | None = None
    first_shape: tuple[int, ...] | None = None
    count = 0
    for i, frames in enumerate(frames_per_segment):
        seg = segments[i]
        if first_shape is None:
            first_shape = frames.shape[1:]
        if frames.shape[0] < seg.length:
            raise ValueError(
                f"segment {seg.start}-{seg.end} came back with {frames.shape[0]} frames, expected {seg.length}"
            )
        if frames.shape[1:] != first_shape:
            raise ValueError(f"segment {seg.start}-{seg.end} has frame shape {frames.shape[1:]}, expected {first_shape}")
        out = frames[: seg.length].copy()
        fade = max(0, segments[i - 1].end - seg.start) if i else 0
        if fade:
            assert tail is not None and tail.shape[0] == fade
            w = crossfade_weights(fade).reshape(fade, 1, 1, 1)
            out[:fade] = np.clip(tail.astype(np.float32) * w + out[:fade].astype(np.float32) * (1.0 - w) + 0.5, 0, 255).astype(np.uint8)
        next_fade = max(0, seg.end - segments[i + 1].start) if i + 1 < len(segments) else 0
        keep = seg.length - next_fade
        if keep > 0:
            yield out[:keep]
        tail = out[keep:] if next_fade else None
        count += 1
    if count != len(segments):
        raise ValueError("segments and frames_per_segment differ in length")


def build_seedvr2_segment_graph(
    *,
    video_name: str,
    unet_name: str,
    seed: int,
    color_correction: str = "lab",
    tile_size: int = 512,
    tile_overlap: int = 128,
    temporal_size: int = 64,
    temporal_overlap: int = 8,
) -> dict:
    """ComfyUI API graph for one already-resized segment (no audio)."""
    vae_tiling = {
        "tile_size": tile_size,
        "overlap": tile_overlap,
        "temporal_size": temporal_size,
        "temporal_overlap": temporal_overlap,
    }
    return {
        "1": {"class_type": "LoadVideo", "inputs": {"file": video_name}},
        "2": {"class_type": "GetVideoComponents", "inputs": {"video": ["1", 0]}},
        "3": {"class_type": "UNETLoader", "inputs": {"unet_name": unet_name, "weight_dtype": "default"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": SEEDVR2_VAE}},
        "5": {"class_type": "SeedVR2Preprocess", "inputs": {"resized_images": ["2", 0]}},
        "6": {"class_type": "VAEEncodeTiled", "inputs": {"pixels": ["5", 0], "vae": ["4", 0], **vae_tiling}},
        "7": {"class_type": "SeedVR2Conditioning", "inputs": {"model": ["3", 0], "vae_conditioning": ["6", 0]}},
        "8": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["3", 0],
                "positive": ["7", 0],
                "negative": ["7", 1],
                "latent_image": ["6", 0],
                "seed": seed,
                "steps": 1,
                "cfg": 1.0,
                "sampler_name": "euler",
                "scheduler": "simple",
                "denoise": 1.0,
            },
        },
        "9": {"class_type": "VAEDecodeTiled", "inputs": {"samples": ["8", 0], "vae": ["4", 0], **vae_tiling}},
        "10": {
            "class_type": "SeedVR2PostProcessing",
            "inputs": {
                "images": ["9", 0],
                "original_resized_images": ["2", 0],
                "color_correction_method": color_correction,
            },
        },
        "11": {
            "class_type": "CreateVideo",
            "inputs": {
                "images": ["10", 0],
                "fps": ["2", 2],
                "bit_depth": "auto",
                "color_space": "sRGB",
                "codec": "none",
            },
        },
        "12": {
            "class_type": "SaveVideo",
            "inputs": {
                "video": ["11", 0],
                "filename_prefix": "dramaclaw_seedvr2",
                "format": "mp4",
                "format.codec": "h264",
                "format.codec.encoding": "re-encode",
                "format.codec.encoding.crf": 10.0,
                "codec": "auto",
            },
        },
    }


# --- ffmpeg helpers --------------------------------------------------------


def probe_video(path: str | Path) -> tuple[int, int, float, int]:
    """Return (width, height, fps, frame_count) by decoding the frame count."""
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
            "-show_entries", "stream=width,height,r_frame_rate,nb_read_frames",
            "-of", "json", str(path),
        ],
        check=True, capture_output=True, text=True,
    ).stdout
    s = json.loads(out)["streams"][0]
    num, den = s["r_frame_rate"].split("/")
    return int(s["width"]), int(s["height"]), float(num) / float(den), int(s["nb_read_frames"])


def read_frames(path: str | Path, width: int | None = None, height: int | None = None) -> np.ndarray:
    if width is None or height is None:
        width, height, _, _ = probe_video(path)
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.uint8).reshape(-1, height, width, 3)


def cut_resized_segment(src: str | Path, dst: str | Path, seg: Segment, width: int, height: int, fps: float) -> None:
    """Exact frame range, lanczos-resized, near-lossless (crf 0) so the
    upscaler is not fed fresh compression artifacts to "restore"."""
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y", "-i", str(src),
            "-vf", f"select=between(n\\,{seg.start}\\,{seg.end - 1}),setpts=N/({fps}*TB),"
                   f"scale={width}:{height}:flags=lanczos",
            "-r", f"{fps}", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "0",
            "-pix_fmt", "yuv420p", str(dst),
        ],
        check=True,
    )


def write_video(frames: np.ndarray, fps: float, dst: str | Path, audio_src: str | Path | None, crf: int = 14) -> None:
    h, w = frames.shape[1:3]
    cmd = [
        "ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{w}x{h}", "-r", f"{fps}", "-i", "-",
    ]
    if audio_src is not None:
        cmd += ["-i", str(audio_src), "-map", "0:v:0", "-map", "1:a:0?", "-c:a", "copy"]
    # -t instead of -shortest: -shortest drops the last video frame when the
    # audio ends a few ms early.
    cmd += [
        "-c:v", "libx264", "-crf", str(crf), "-preset", "slow", "-pix_fmt", "yuv420p",
        "-t", f"{frames.shape[0] / fps:.6f}", str(dst),
    ]
    subprocess.run(cmd, input=frames.tobytes(), check=True)


def write_video_stream(
    chunks: Iterable[np.ndarray],
    fps: float,
    dst: str | Path,
    audio_src: str | Path | None,
    *,
    width: int,
    height: int,
    total_frames: int,
    crf: int = 14,
) -> None:
    """Pipe frame chunks into one ffmpeg encode (same settings as `write_video`)."""
    cmd = [
        "ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{width}x{height}", "-r", f"{fps}", "-i", "-",
    ]
    if audio_src is not None:
        cmd += ["-i", str(audio_src), "-map", "0:v:0", "-map", "1:a:0?", "-c:a", "copy"]
    cmd += [
        "-c:v", "libx264", "-crf", str(crf), "-preset", "slow", "-pix_fmt", "yuv420p",
        "-t", f"{total_frames / fps:.6f}", str(dst),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    assert proc.stdin is not None
    try:
        for chunk in chunks:
            proc.stdin.write(chunk.tobytes())
        proc.stdin.close()
    except BaseException:
        proc.kill()
        raise
    finally:
        rc = proc.wait()
    if rc != 0:
        raise subprocess.CalledProcessError(rc, cmd)


def _even(x: float) -> int:
    return max(2, int(round(x / 2.0)) * 2)


@dataclass
class UpscaleResult:
    output_path: str | None = None
    error: str = ""
    segments: list[Segment] = field(default_factory=list)


async def upscale_video_chunked(
    src: str | Path,
    dst: str | Path,
    *,
    scale: float = 2.0,
    unet_name: str = SEEDVR2_7B_UNET,
    segment_frames: int = DEFAULT_SEGMENT_FRAMES,
    overlap_frames: int = DEFAULT_OVERLAP_FRAMES,
    seed: int = 42,
    color_correction: str = "lab",
    endpoint_id: str | None = None,
    work_dir: str | Path | None = None,
    on_progress: Callable[[int, int, str], None] | None = None,
) -> UpscaleResult:
    """Upscale `src` to `dst`, one RunPod job per segment, sequentially.

    Segment outputs are cached in `work_dir` (`seg_XXXX.mp4`), so rerunning
    with the same `work_dir` after a failure only pays for the missing ones.
    `on_progress(done, total, message)` fires after each segment (cached ones
    included) and once more before the final local stitch.
    """
    from novelvideo.config import (
        RUNPOD_API_KEY,
        RUNPOD_QWEN_IMAGE_ENDPOINT_ID,
        RUNPOD_QWEN_IMAGE_TIMEOUT_SECONDS,
    )
    from novelvideo.generators.nanobanana_grid import _runpod_run_graph_job

    endpoint = endpoint_id or RUNPOD_QWEN_IMAGE_ENDPOINT_ID
    src_w, src_h, fps, total = probe_video(src)
    out_w, out_h = _even(src_w * scale), _even(src_h * scale)
    segments = plan_segments(total, segment_frames, overlap_frames)

    own_tmp = work_dir is None
    work = Path(work_dir or tempfile.mkdtemp(prefix="seedvr2_"))
    work.mkdir(parents=True, exist_ok=True)
    try:
        seg_outputs: list[Path] = []
        for i, seg in enumerate(segments):
            done = work / f"seg_{i:04d}.mp4"
            seg_outputs.append(done)
            if done.exists() and done.stat().st_size > 0:
                if on_progress:
                    on_progress(i + 1, len(segments), f"segment {i + 1}/{len(segments)} cached")
                continue
            inp = work / f"in_{i:04d}.mp4"
            await asyncio.to_thread(cut_resized_segment, src, inp, seg, out_w, out_h, fps)
            name = f"seedvr2_{uuid.uuid4().hex[:12]}.mp4"
            graph = build_seedvr2_segment_graph(
                video_name=name, unet_name=unet_name, seed=seed, color_correction=color_correction,
            )
            data, _, err = await _runpod_run_graph_job(
                api_key=RUNPOD_API_KEY,
                endpoint_id=endpoint,
                timeout_seconds=RUNPOD_QWEN_IMAGE_TIMEOUT_SECONDS,
                graph=graph,
                upload_batch=[(name, inp.read_bytes(), "video/mp4")],
                label=f"seedvr2 segment {i + 1}/{len(segments)} (frames {seg.start}-{seg.end - 1})",
            )
            if err or data is None:
                return UpscaleResult(error=err or "empty output", segments=segments)
            done.write_bytes(data)
            if on_progress:
                on_progress(i + 1, len(segments), f"segment {i + 1}/{len(segments)} upscaled")

        def _stitch_to_dst() -> None:
            write_video_stream(
                iter_stitched(segments, (read_frames(p) for p in seg_outputs)),
                fps, dst, src, width=out_w, height=out_h, total_frames=total,
            )

        if on_progress:
            on_progress(len(segments), len(segments), "stitching segments and muxing audio")
        await asyncio.to_thread(_stitch_to_dst)
        return UpscaleResult(output_path=str(dst), segments=segments)
    finally:
        if own_tmp:
            shutil.rmtree(work, ignore_errors=True)


__all__ = [
    "DEFAULT_OVERLAP_FRAMES",
    "DEFAULT_SEGMENT_FRAMES",
    "SEEDVR2_3B_UNET",
    "SEEDVR2_7B_UNET",
    "Segment",
    "build_seedvr2_segment_graph",
    "crossfade_weights",
    "iter_stitched",
    "plan_segments",
    "stitch_segments",
    "upscale_video_chunked",
    "write_video_stream",
]
