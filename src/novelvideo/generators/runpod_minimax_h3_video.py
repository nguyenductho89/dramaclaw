"""RunPod Serverless MiniMax-H3 video generator.

Dev-only, gated by `config._runpod_h3_video_configured()`. Ported from the
`photoreal-short-drama-generator` project's `scripts/comfy.py` `h3_ref`/
`h3_i2v` ComfyUI API graph builders (reused model files, reused RunPod
endpoint `a31613hf7l83r5` — RunPod display name `qwen-t2i-h3-i2v-ref2va`
since 2026-10-18, was `photoreal-drama-h3`, id unchanged — and R2 relay;
see `.claude/CLAUDE.md`). That
project has verified this exact graph end-to-end on a real production beat:
first frame + character/scene/prop reference images + a voice-timbre
reference audio + `<d>[Vietnamese] ...</d>` dialogue + PDD 8-step
acceleration, delivered as an R2 mp4 with the H3-generated audio muxed in
(`movies/NgoaiTinhCongSo/_腳本/佇列/S01_t1.json`, 734s).

Two modes, chosen automatically from what the caller attaches:
- **ref2va** (used whenever there is at least one image/audio reference
  besides the first frame — the normal case for a drama beat with a
  character identity): `MiniMaxH3ReferenceToVideo` + PDD 8-step
  acceleration (`MiniMaxH3SigmaShift` + `MiniMaxH3PDDAccApply`, euler
  sampler, sigmas from the PDD node — PDD only works at exactly 4/6/8
  steps with this sampler/sigma combination, any other combination
  produces noise). The first frame is pinned at frame 0 via
  `MiniMaxH3AddGuide` (a soft constraint: a first frame that conflicts
  with the prompt's shot size/content can still be overridden by the
  model).
- **fl2va** (no references): `MiniMaxH3ImageToVideo`, base 20-step
  res_multistep/simple schedule — there is no PDD acceleration file for
  this checkpoint. This node cannot take character/scene/prop reference
  images or a voice-timbre audio reference.

The frame count is forced onto MiniMax H3's 17k+5 grid (24fps: 124, 141,
158, ..., 294) and clamped to the 124-294 range verified not to OOM on an
A40 48GB (`.claude/CLAUDE.md`). Resolution is a fixed portrait/landscape
profile (not computed from the exact aspect ratio): `MiniMaxH3ImageToVideo`
stretches `first_frame` to exactly width x height without preserving
aspect ratio, so the first frame is center-cropped to that exact size
before upload (`photoreal-short-drama-generator`'s `fit_canvas`), same as
`MiniMaxH3ReferenceToVideo`'s `ref_image_size="match"` mode.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import time
import uuid
from typing import Any

from novelvideo.generators.video_generator import (
    ShotReference,
    VideoGenResult,
    VideoGenStatus,
    VideoGeneratorBase,
)

logger = logging.getLogger(__name__)

# MiniMax H3's frame grid: length must equal 17k+5 at 24fps. 124 is the
# shortest usable clip (~5.17s); 294 (~12.25s) is the longest verified not
# to OOM on an A40 48GB with a ref2va graph carrying several reference
# images (`.claude/CLAUDE.md`, `references/規則核心.md §2.2` in the
# photoreal project).
_FRAME_MIN = 124
_FRAME_MAX = 294
_FRAME_STEP = 17
_FRAME_BASE = 5
_FPS = 24.0

_RESOLUTION_PROFILES = {
    # (short edge, long edge) — multiples of 16, matching the photoreal
    # project's "formal" (production) and "draft" (cheap motion/
    # composition check) profiles.
    "formal": (768, 1344),
    "draft": (416, 736),
}


def frames_for_duration(seconds: float) -> int:
    """Round `seconds` onto the 17k+5 frame grid (24fps), clamped to the
    124-294 range."""
    raw = max(_FRAME_MIN, round(float(seconds) * _FPS))
    k = round((raw - _FRAME_BASE) / _FRAME_STEP)
    frames = _FRAME_BASE + k * _FRAME_STEP
    return max(_FRAME_MIN, min(_FRAME_MAX, frames))


def _round32(value: float) -> int:
    """Nearest multiple of 32, minimum 32 — the grid every H3 width/height
    dimension must land on."""
    return max(32, round(value / 32.0) * 32)


def stage1_dims_for_two_stage(width: int, height: int, scale_by: float) -> tuple[int, int]:
    """Pass-1 resolution for `two_stage=True`: the final `width`/`height`
    divided by `scale_by`, rounded to H3's 32px grid. For the `formal`
    profile's 1344x768 (landscape) or 768x1344 (portrait) at the default
    `scale_by=1.5` this divides evenly (896x512 / 512x896) — the exact
    numbers in `runpod-h3-qwen-endpoints.md` section 4a. Other profiles may
    round slightly, in which case `MiniMaxH3AVLatentUpscaleBy`'s actual
    output resolution ends up a little off `width`/`height` — that's fine,
    the final video just comes out at whatever resolution falls out of the
    upscale, nothing downstream enforces an exact match.
    """
    return _round32(width / scale_by), _round32(height / scale_by)


def dims_for_ratio(aspect_ratio: str, profile: str = "formal") -> tuple[int, int]:
    """Portrait profile dims, rotated to landscape when `aspect_ratio` is
    wider than it is tall. H3 only reliably supports this fixed pair of
    profiles (not an arbitrary computed size) — see module docstring."""
    short, long_ = _RESOLUTION_PROFILES.get(profile, _RESOLUTION_PROFILES["formal"])
    try:
        rw, rh = (aspect_ratio or "9:16").split(":", 1)
        landscape = float(rw) > float(rh)
    except (ValueError, ZeroDivisionError):
        landscape = False
    return (long_, short) if landscape else (short, long_)


def _fit_canvas_bytes(data: bytes, width: int, height: int) -> bytes:
    """Scale-to-cover + center-crop to exactly width x height. Mirrors the
    photoreal project's `fit_canvas`: `MiniMaxH3ImageToVideo.first_frame`
    stretches whatever it's given without preserving aspect ratio, so the
    frame has to already be exactly the target size before upload."""
    from PIL import Image

    im = Image.open(io.BytesIO(data)).convert("RGB")
    scale = max(width / im.width, height / im.height)
    im = im.resize(
        (max(1, round(im.width * scale)), max(1, round(im.height * scale))),
        Image.LANCZOS,
    )
    left = max(0, (im.width - width) // 2)
    top = max(0, (im.height - height) // 2)
    im = im.crop((left, top, left + width, top + height))
    out = io.BytesIO()
    im.save(out, format="PNG")
    return out.getvalue()


def _chain_guides(
    graph: dict[str, Any],
    chain: list[tuple[str, int]],
    *,
    cond: list,
    latent: list,
    vae_node: str,
    audio_vae_node: str,
    guider_node: str,
    start_id: int = 40,
) -> None:
    """Chain `MiniMaxH3AddGuide` nodes one after another onto `cond`, then
    wire the final conditioning into `guider_node`. Ported verbatim from
    the photoreal project's `_chain_guides`."""
    for k, (image_node, frame_idx) in enumerate(chain):
        node_id = str(start_id + k)
        graph[node_id] = {
            "class_type": "MiniMaxH3AddGuide",
            "inputs": {
                "positive": cond,
                "latent": latent,
                "frame_idx": frame_idx,
                "vae": [vae_node, 0],
                "audio_vae": [audio_vae_node, 0],
                "image": [image_node, 0],
            },
        }
        cond = [node_id, 0]
    graph[guider_node]["inputs"]["conditioning"] = cond


def build_h3_ref2va_graph(
    *,
    prompt: str,
    image_names: list[str],
    audio_names: list[str],
    seed: int,
    width: int,
    height: int,
    frames: int,
    pdd_steps: int = 8,
    end_frame_name: str | None = None,
    two_stage: bool = False,
    stage2_scale_by: float = 1.5,
    stage2_upscale_method: str = "bislerp",
    stage2_nfe: str = "6",
    stage2_denoise: float = 0.35,
    audio_refine: bool = False,
    audio_refine_steps: int = 4,
    audio_refine_cfg: float = 1.0,
    audio_refine_denoise: float = 0.5,
) -> dict[str, Any]:
    """`MiniMaxH3ReferenceToVideo` + PDD 8-step acceleration. `image_names[0]`
    is always the first frame (`<Picture 1>`, pinned at frame 0 via
    `MiniMaxH3AddGuide`); `image_names[1:]` are character/scene/prop
    reference images (`<Picture 2>`, `<Picture 3>`, ...); `audio_names` are
    voice-timbre reference clips (`<Audio 1>`, ...). `end_frame_name`, if
    given, is appended as one more `ref_image` and pinned at the last frame
    (`frame_idx=-1`) for keyframe (first+last frame) mode.

    `two_stage` (added 2026-10-19, see `runpod-h3-qwen-endpoints.md` section
    4a): render pass 1 at `width/height` already pre-scaled down by
    `stage2_scale_by` by the caller — wait, no: THIS function takes the
    FINAL target `width`/`height` and does the pass-1 downscale itself, then
    `MiniMaxH3AVLatentUpscaleBy(scale_by=stage2_scale_by)` back up, then a
    short partial-denoise redraw pass (`MiniMaxH3PDDAccScheduler`,
    `nfe=stage2_nfe`, `denoise=stage2_denoise`) on a SEPARATE
    `MiniMaxH3PDDAccApply` model branch off the same sigma-shifted base as
    pass 1 (node "5") — pass 1's own nfe=8 branch (node "6") and its
    sigmas/sampler (nodes 9/11/12) are completely untouched by this, so
    enabling `two_stage` cannot change pass-1's own quality/timing, only add
    a stage 2 after it.

    `audio_refine` (same section): `MiniMaxH3ChainAudioRefineSampler` from
    pack `ethanfel/ComfyUI-MiniMaxH3-Context-Loop` (NOT the PDD-Acc pack —
    must be installed separately on the worker image). Freezes video,
    re-denoises only audio. Its required `context_latent` input is wired to
    a plain pre-sample AV latent that never gets a `noise_mask` key (node
    "7"'s own latent output when `two_stage` is off, or the upscaled latent
    "60" when it's on — either way just needs the right SHAPE, not real
    "emptiness": `_existing_mask_streams` in that pack only inspects the
    `noise_mask` key, not the data) — the node then treats this as "nothing
    is protected yet", producing an all-ones (full-repaint) audio mask with
    no need for the pack's full "Chain Context" machinery. `negative`
    conditioning is wired to the SAME conditioning as `positive`: this
    sampler runs at `cfg=1.0` like the rest of this pipeline, and CFG at
    cfg=1 is mathematically `negative + 1.0*(positive-negative) = positive`,
    i.e. negative has zero effect on the result at that cfg value.
    """
    from novelvideo.config import (
        RUNPOD_H3_AUDIO_VAE,
        RUNPOD_H3_PDD_REF2VA,
        RUNPOD_H3_TEXT_ENCODER,
        RUNPOD_H3_UNET_REF2VA,
        RUNPOD_H3_VIDEO_VAE,
    )

    if pdd_steps not in (4, 6, 8):
        raise ValueError(f"PDD acceleration only supports 4/6/8 steps, got {pdd_steps}")
    if two_stage and stage2_nfe not in ("4", "6", "8"):
        raise ValueError(f"stage2_nfe only supports '4'/'6'/'8', got {stage2_nfe!r}")

    all_image_names = list(image_names) + ([end_frame_name] if end_frame_name else [])

    pass1_width, pass1_height = (
        stage1_dims_for_two_stage(width, height, stage2_scale_by) if two_stage else (width, height)
    )

    graph: dict[str, Any] = {
        "1": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": RUNPOD_H3_UNET_REF2VA, "weight_dtype": "default"},
        },
        "2": {
            "class_type": "CLIPLoader",
            "inputs": {
                "clip_name": RUNPOD_H3_TEXT_ENCODER,
                "type": "minimax",
                "device": "default",
            },
        },
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": RUNPOD_H3_VIDEO_VAE}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": RUNPOD_H3_AUDIO_VAE}},
        "7": {
            "class_type": "MiniMaxH3ReferenceToVideo",
            "inputs": {
                "clip": ["2", 0],
                "vae": ["3", 0],
                "audio_vae": ["4", 0],
                "prompt": prompt,
                "width": pass1_width,
                "height": pass1_height,
                "length": frames,
                "ref_image_size": "match",
            },
        },
        "8": {"class_type": "BasicGuider", "inputs": {"model": ["1", 0], "conditioning": ["7", 0]}},
        "9": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "11": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "12": {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {
                "noise": ["11", 0],
                "guider": ["8", 0],
                "sampler": ["9", 0],
                "sigmas": ["6", 1],
                "latent_image": ["7", 1],
            },
        },
        "13": {"class_type": "VAEDecode", "inputs": {"samples": ["12", 0], "vae": ["3", 0]}},
        "14": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["12", 0], "vae": ["4", 0]}},
        "15": {
            "class_type": "CreateVideo",
            "inputs": {
                "images": ["13", 0],
                "audio": ["14", 0],
                "fps": _FPS,
                "bit_depth": "auto",
                "color_space": "sRGB",
                "codec": "none",
            },
        },
        "16": {
            "class_type": "SaveVideo",
            "inputs": {
                "video": ["15", 0],
                "filename_prefix": "dramaclaw_h3",
                "format": "mp4",
                "format.codec": "h264",
                "format.codec.encoding": "re-encode",
                "format.codec.encoding.crf": 14.0,
                "codec": "auto",
            },
        },
        "5": {
            "class_type": "MiniMaxH3SigmaShift",
            "inputs": {"model": ["1", 0], "shift_video": 12.0, "shift_audio": 3.0},
        },
        "6": {
            "class_type": "MiniMaxH3PDDAccApply",
            "inputs": {
                "model": ["5", 0],
                "pdd_file": RUNPOD_H3_PDD_REF2VA,
                "nfe": str(pdd_steps),
                "lora_strength": 1.0,
                "head_strength": 1.0,
                "on_off_grid": "error",
            },
        },
    }
    graph["8"]["inputs"]["model"] = ["6", 0]

    for k, name in enumerate(all_image_names):
        graph[str(100 + k)] = {"class_type": "LoadImage", "inputs": {"image": name}}
        graph["7"]["inputs"][f"ref_images.ref_image_{k}"] = [str(100 + k), 0]
    for k, name in enumerate(audio_names):
        graph[str(200 + k)] = {"class_type": "LoadAudio", "inputs": {"audio": name}}
        graph["7"]["inputs"][f"ref_audios.ref_audio_{k}"] = [str(200 + k), 0]

    chain: list[tuple[str, int]] = [("100", 0)]  # pin the first frame at frame 0
    if end_frame_name:
        chain.append((str(100 + len(all_image_names) - 1), -1))
    _chain_guides(
        graph, chain, cond=["7", 0], latent=["7", 1], vae_node="3", audio_vae_node="4", guider_node="8"
    )
    # Final conditioning after AddGuide pinning — stage 2 / audio refine
    # reuse this exact conditioning rather than re-deriving it, so a first
    # (and optional last) frame pin applies identically to every stage.
    final_cond = list(graph["8"]["inputs"]["conditioning"])

    final_latent_node = "12"  # pass-1 sampler output, the default
    # The AV latent fed as `context_latent` to the audio-refine sampler
    # below: any latent with the same SHAPE as whatever is being refined and
    # no `noise_mask` key works (see docstring) — node "7"'s own pre-sample
    # latent output when there's no stage 2, or the upscaled stage-2 input
    # latent "60" when there is (same resolution as stage 2's output).
    audio_refine_context_latent = ["7", 1]

    if two_stage:
        graph["60"] = {
            "class_type": "MiniMaxH3AVLatentUpscaleBy",
            "inputs": {
                "samples": ["12", 0],
                "upscale_method": stage2_upscale_method,
                "scale_by": stage2_scale_by,
            },
        }
        graph["61"] = {
            "class_type": "MiniMaxH3PDDAccApply",
            "inputs": {
                # Same sigma-shifted base as pass 1 (node "5"), a SEPARATE
                # Apply branch at stage2_nfe — pass 1's own "6" branch
                # (nfe=8) is untouched.
                "model": ["5", 0],
                "pdd_file": RUNPOD_H3_PDD_REF2VA,
                "nfe": stage2_nfe,
                "lora_strength": 1.0,
                "head_strength": 1.0,
                "on_off_grid": "error",
            },
        }
        graph["62"] = {
            "class_type": "MiniMaxH3PDDAccScheduler",
            "inputs": {"nfe": stage2_nfe, "denoise": stage2_denoise},
        }
        graph["63"] = {
            "class_type": "BasicGuider",
            "inputs": {"model": ["61", 0], "conditioning": final_cond},
        }
        graph["64"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}}
        graph["65"] = {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {
                "noise": ["64", 0],
                "guider": ["63", 0],
                "sampler": ["9", 0],
                "sigmas": ["62", 0],
                "latent_image": ["60", 0],
            },
        }
        final_latent_node = "65"
        audio_refine_context_latent = ["60", 0]

    if audio_refine:
        # Reuse pass-1's own model branch ("6") for a single-stage refine;
        # stage 2's branch ("61") when two_stage is also on — matches
        # whichever branch actually produced `final_latent_node`.
        refine_model = ["61", 0] if two_stage else ["6", 0]
        graph["66"] = {
            "class_type": "MiniMaxH3ChainAudioRefineSampler",
            "inputs": {
                "model": refine_model,
                "positive": final_cond,
                "negative": final_cond,
                "latent": [final_latent_node, 0],
                "context_latent": audio_refine_context_latent,
                "seed": seed,
                "steps": audio_refine_steps,
                "cfg": audio_refine_cfg,
                "sampler_name": "euler",
                "scheduler": "simple",
                "audio_denoise": audio_refine_denoise,
            },
        }
        final_latent_node = "66"

    graph["13"]["inputs"]["samples"] = [final_latent_node, 0]
    graph["14"]["inputs"]["samples"] = [final_latent_node, 0]

    from novelvideo.generators.comfy_sage import apply_sage_patch, sage_mode_requested

    apply_sage_patch(graph, "1", sage_mode_requested())
    return graph


def build_h3_fl2va_graph(
    *,
    prompt: str,
    first_frame_name: str,
    seed: int,
    width: int,
    height: int,
    frames: int,
    last_frame_name: str | None = None,
    steps: int = 20,
    scheduler: str = "simple",
) -> dict[str, Any]:
    """`MiniMaxH3ImageToVideo` — first frame only (no character/scene/prop
    reference images, no voice-timbre audio). Base model, no PDD file
    exists for this checkpoint."""
    from novelvideo.config import (
        RUNPOD_H3_AUDIO_VAE,
        RUNPOD_H3_TEXT_ENCODER,
        RUNPOD_H3_UNET_FL2VA,
        RUNPOD_H3_VIDEO_VAE,
    )

    graph: dict[str, Any] = {
        "20": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": RUNPOD_H3_UNET_FL2VA, "weight_dtype": "default"},
        },
        "21": {
            "class_type": "CLIPLoader",
            "inputs": {
                "clip_name": RUNPOD_H3_TEXT_ENCODER,
                "type": "minimax",
                "device": "default",
            },
        },
        "22": {"class_type": "VAELoader", "inputs": {"vae_name": RUNPOD_H3_VIDEO_VAE}},
        "23": {"class_type": "VAELoader", "inputs": {"vae_name": RUNPOD_H3_AUDIO_VAE}},
        "24": {
            "class_type": "MiniMaxH3ImageToVideo",
            "inputs": {
                "clip": ["21", 0],
                "vae": ["22", 0],
                "prompt": prompt,
                "width": width,
                "height": height,
                "length": frames,
            },
        },
        "25": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "26": {"class_type": "BasicGuider", "inputs": {"model": ["20", 0], "conditioning": ["24", 0]}},
        "27": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "28": {
            "class_type": "BasicScheduler",
            "inputs": {"model": ["20", 0], "scheduler": scheduler, "steps": steps, "denoise": 1.0},
        },
        "29": {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {
                "noise": ["25", 0],
                "guider": ["26", 0],
                "sampler": ["27", 0],
                "sigmas": ["28", 0],
                "latent_image": ["24", 1],
            },
        },
        "31": {"class_type": "VAEDecode", "inputs": {"samples": ["29", 0], "vae": ["22", 0]}},
        "32": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["29", 0], "vae": ["23", 0]}},
        "34": {
            "class_type": "CreateVideo",
            "inputs": {
                "images": ["31", 0],
                "audio": ["32", 0],
                "fps": _FPS,
                "bit_depth": "auto",
                "color_space": "sRGB",
                "codec": "none",
            },
        },
        "35": {
            "class_type": "SaveVideo",
            "inputs": {
                "video": ["34", 0],
                "filename_prefix": "dramaclaw_h3",
                "format": "mp4",
                "format.codec": "h264",
                "format.codec.encoding": "re-encode",
                "format.codec.encoding.crf": 14.0,
                "codec": "auto",
            },
        },
        "100": {"class_type": "LoadImage", "inputs": {"image": first_frame_name}},
    }
    graph["24"]["inputs"]["first_frame"] = ["100", 0]
    if last_frame_name:
        graph["101"] = {"class_type": "LoadImage", "inputs": {"image": last_frame_name}}
        graph["24"]["inputs"]["last_frame"] = ["101", 0]
    from novelvideo.generators.comfy_sage import apply_sage_patch, sage_mode_requested

    apply_sage_patch(graph, "20", sage_mode_requested())
    return graph


class RunPodMiniMaxH3VideoGenerator(VideoGeneratorBase):
    """MiniMax H3 video generation on the user's own RunPod serverless
    ComfyUI endpoint (`RUNPOD_H3_VIDEO_ENDPOINT_ID`, same worker/R2 bucket
    as the RunPod Qwen image providers)."""

    def __init__(self, **_kwargs: Any) -> None:
        # Accept and ignore kwargs other generators get (resolution,
        # egress_context, ...) that don't apply to this dev-only backend.
        pass

    async def generate(
        self,
        image_path: str | None,
        prompt: str,
        output_path: str,
        aspect_ratio: str = "9:16",
        duration: float = 5.0,
        last_frame_path: str | None = None,
        references: list[ShotReference] | None = None,
        profile: str = "formal",
        pdd_steps: int = 8,
        two_stage: bool | None = None,
        audio_refine: bool | None = None,
        on_log: Any = None,
        on_progress: Any = None,
        **_kwargs: Any,
    ) -> VideoGenResult:
        from novelvideo.config import (
            RUNPOD_API_KEY,
            RUNPOD_H3_AUDIO_REFINE_CFG,
            RUNPOD_H3_AUDIO_REFINE_DENOISE,
            RUNPOD_H3_AUDIO_REFINE_ENABLED,
            RUNPOD_H3_AUDIO_REFINE_STEPS,
            RUNPOD_H3_STAGE2_DENOISE,
            RUNPOD_H3_STAGE2_NFE,
            RUNPOD_H3_STAGE2_SCALE_BY,
            RUNPOD_H3_STAGE2_UPSCALE_METHOD,
            RUNPOD_H3_TWO_STAGE_ENABLED,
            RUNPOD_H3_VIDEO_ENDPOINT_ID,
            RUNPOD_H3_VIDEO_TIMEOUT_SECONDS,
        )

        # None means "use the .env default" — a caller (task runner, API
        # route) can still force either on/off per call.
        two_stage = RUNPOD_H3_TWO_STAGE_ENABLED if two_stage is None else two_stage
        audio_refine = RUNPOD_H3_AUDIO_REFINE_ENABLED if audio_refine is None else audio_refine

        def log(msg: str) -> None:
            logger.info("[runpod_minimax_h3] %s", msg)
            if on_log:
                on_log(msg)

        if not RUNPOD_API_KEY:
            return VideoGenResult(status=VideoGenStatus.FAILED, error="RUNPOD_API_KEY is missing")
        if not RUNPOD_H3_VIDEO_ENDPOINT_ID:
            return VideoGenResult(
                status=VideoGenStatus.FAILED, error="RUNPOD_H3_VIDEO_ENDPOINT_ID is missing"
            )
        if not image_path:
            return VideoGenResult(status=VideoGenStatus.FAILED, error="H3 需要首帧图像")
        if not str(prompt or "").strip():
            return VideoGenResult(status=VideoGenStatus.FAILED, error="H3 prompt 为空")

        import mimetypes
        from pathlib import Path

        width, height = dims_for_ratio(aspect_ratio, profile)
        frames = frames_for_duration(duration)

        def _read(path: str) -> bytes:
            return Path(path).read_bytes()

        first_frame_raw = await asyncio.to_thread(_read, image_path)
        first_frame_png = await asyncio.to_thread(
            _fit_canvas_bytes, first_frame_raw, width, height
        )

        image_refs = [item for item in (references or []) if item.type == "image"]
        audio_refs = [item for item in (references or []) if item.type == "audio"]

        image_payloads: list[tuple[str, bytes, str]] = [
            ("h3_first_frame.png", first_frame_png, "image/png")
        ]
        for idx, ref in enumerate(image_refs):
            try:
                data = await asyncio.to_thread(_read, ref.path)
            except OSError as exc:
                log(f"跳过无法读取的参考图 {ref.path}: {exc}")
                continue
            ext = Path(ref.path).suffix or ".png"
            image_payloads.append((f"h3_ref_image_{idx}{ext}", data, mimetypes.guess_type(ref.path)[0] or "image/png"))

        audio_payloads: list[tuple[str, bytes, str]] = []
        for idx, ref in enumerate(audio_refs):
            try:
                data = await asyncio.to_thread(_read, ref.path)
            except OSError as exc:
                log(f"跳过无法读取的音色参考 {ref.path}: {exc}")
                continue
            ext = Path(ref.path).suffix or ".wav"
            audio_payloads.append((f"h3_ref_audio_{idx}{ext}", data, mimetypes.guess_type(ref.path)[0] or "audio/wav"))

        end_frame_payload: tuple[str, bytes, str] | None = None
        if last_frame_path:
            try:
                raw = await asyncio.to_thread(_read, last_frame_path)
                cropped = await asyncio.to_thread(_fit_canvas_bytes, raw, width, height)
                end_frame_payload = ("h3_last_frame.png", cropped, "image/png")
            except OSError as exc:
                log(f"跳过无法读取的尾帧 {last_frame_path}: {exc}")

        seed = uuid.uuid4().int & 0xFFFFFFFF
        mode = "ref2va" if (len(image_payloads) > 1 or audio_payloads) else "fl2va"

        if mode == "ref2va":
            image_names = [name for name, _d, _m in image_payloads]
            audio_names = [name for name, _d, _m in audio_payloads]
            graph = build_h3_ref2va_graph(
                prompt=prompt,
                image_names=image_names,
                audio_names=audio_names,
                seed=seed,
                width=width,
                height=height,
                frames=frames,
                pdd_steps=pdd_steps,
                end_frame_name=end_frame_payload[0] if end_frame_payload else None,
                two_stage=two_stage,
                stage2_scale_by=RUNPOD_H3_STAGE2_SCALE_BY,
                stage2_upscale_method=RUNPOD_H3_STAGE2_UPSCALE_METHOD,
                stage2_nfe=RUNPOD_H3_STAGE2_NFE,
                stage2_denoise=RUNPOD_H3_STAGE2_DENOISE,
                audio_refine=audio_refine,
                audio_refine_steps=RUNPOD_H3_AUDIO_REFINE_STEPS,
                audio_refine_cfg=RUNPOD_H3_AUDIO_REFINE_CFG,
                audio_refine_denoise=RUNPOD_H3_AUDIO_REFINE_DENOISE,
            )
            upload_payloads = list(image_payloads) + ([end_frame_payload] if end_frame_payload else []) + audio_payloads
        else:
            # two_stage/audio_refine only apply to ref2va for now (see
            # module docstring) — fl2va is unaffected even if the .env
            # flags are on.
            graph = build_h3_fl2va_graph(
                prompt=prompt,
                first_frame_name=image_payloads[0][0],
                seed=seed,
                width=width,
                height=height,
                frames=frames,
                last_frame_name=end_frame_payload[0] if end_frame_payload else None,
            )
            upload_payloads = [image_payloads[0]] + ([end_frame_payload] if end_frame_payload else [])

        stage_note = ""
        if mode == "ref2va" and (two_stage or audio_refine):
            parts = []
            if two_stage:
                parts.append("two-stage")
            if audio_refine:
                parts.append("audio-refine")
            stage_note = f" [{'+'.join(parts)}]"
        log(f"MiniMax H3 ({mode}{stage_note}, {width}x{height}, {frames}帧/{frames / _FPS:.1f}s) 提交中...")

        from novelvideo.generators.nanobanana_grid import (
            _runpod_download_output_sync,
            _runpod_upload_inputs_sync,
        )

        try:
            job_inputs = await asyncio.to_thread(_runpod_upload_inputs_sync, upload_payloads)
        except Exception as exc:  # noqa: BLE001
            return VideoGenResult(status=VideoGenStatus.FAILED, error=f"上传参考文件到 R2 失败: {exc}")

        import httpx

        base = "https://api.runpod.ai/v2"
        headers = {"Authorization": f"Bearer {RUNPOD_API_KEY}", "Content-Type": "application/json"}
        job_input = {"action": "prompt", "workflow": graph, "inputs": job_inputs, "free_first": False}

        job_id: str | None = None
        async with httpx.AsyncClient(timeout=60.0) as client:
            for attempt in range(6):
                try:
                    resp = await client.post(
                        f"{base}/{RUNPOD_H3_VIDEO_ENDPOINT_ID}/run",
                        headers=headers,
                        json={"input": job_input},
                    )
                    if resp.status_code == 409 and attempt < 5:
                        log("RunPod endpoint 刚启动 (409 ENDPOINT_PAUSED)，10秒后重试提交...")
                        await asyncio.sleep(10)
                        continue
                    resp.raise_for_status()
                    job_id = resp.json()["id"]
                    break
                except httpx.HTTPError as exc:
                    if attempt >= 5:
                        return VideoGenResult(status=VideoGenStatus.FAILED, error=f"提交 RunPod H3 任务失败: {exc}")
                    await asyncio.sleep(10)
        if not job_id:
            return VideoGenResult(status=VideoGenStatus.FAILED, error="提交 RunPod H3 任务失败: 未知原因")

        log(f"RunPod job {job_id} 已提交，轮询中 (最长 {RUNPOD_H3_VIDEO_TIMEOUT_SECONDS:.0f}s)...")

        deadline = time.monotonic() + RUNPOD_H3_VIDEO_TIMEOUT_SECONDS
        status_resp: dict = {}
        last_poll_error = ""
        async with httpx.AsyncClient(timeout=60.0) as client:
            while time.monotonic() < deadline:
                await asyncio.sleep(5)
                try:
                    status_response = await client.get(
                        f"{base}/{RUNPOD_H3_VIDEO_ENDPOINT_ID}/status/{job_id}",
                        headers=headers,
                    )
                    status_response.raise_for_status()
                    status_resp = status_response.json()
                except httpx.HTTPError as exc:
                    last_poll_error = str(exc)
                    continue
                if status_resp.get("status") not in ("IN_QUEUE", "IN_PROGRESS"):
                    break
                if on_progress:
                    on_progress(0.5)
            else:
                try:
                    await client.post(f"{base}/{RUNPOD_H3_VIDEO_ENDPOINT_ID}/cancel/{job_id}", headers=headers)
                except httpx.HTTPError:
                    pass
                status_note = status_resp.get("status", "IN_QUEUE")
                poll_note = f"; 最后一次轮询错误: {last_poll_error}" if last_poll_error else ""
                return VideoGenResult(
                    status=VideoGenStatus.FAILED,
                    error=(
                        f"RunPod H3 任务 {job_id} 超时 ({RUNPOD_H3_VIDEO_TIMEOUT_SECONDS:.0f}s)，"
                        f"仍为 {status_note}（endpoint workers.max 可能是 0）{poll_note}"
                    ),
                )

        status = status_resp.get("status")
        output = status_resp.get("output") or {}
        # RunPod `COMPLETED` only means the handler returned — a mid-graph
        # failure still shows up as `status.completed=False` plus an
        # `execution_error` inside the handler's own result.
        inner_status = output.get("status") if isinstance(output, dict) else None
        if status != "COMPLETED" or (isinstance(inner_status, dict) and inner_status.get("completed") is False):
            detail = json.dumps(status_resp)[:1200]
            return VideoGenResult(status=VideoGenStatus.FAILED, error=f"RunPod H3 任务 {status}: {detail}")
        if output.get("error"):
            return VideoGenResult(status=VideoGenStatus.FAILED, error=f"RunPod H3 worker 错误: {output['error']}")
        if output.get("node_errors"):
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=f"RunPod H3 node_errors: {json.dumps(output['node_errors'])[:1200]}",
            )

        video_item = None
        for node_out in (output.get("outputs") or {}).values():
            for lst in (node_out.values() if isinstance(node_out, dict) else []):
                if not isinstance(lst, list):
                    continue
                for item in lst:
                    if isinstance(item, dict) and item.get("r2_key"):
                        video_item = item
                        break
                if video_item:
                    break
            if video_item:
                break
        if video_item is None:
            return VideoGenResult(status=VideoGenStatus.FAILED, error="RunPod H3 任务完成但没有输出视频")

        try:
            data = await asyncio.to_thread(_runpod_download_output_sync, video_item["r2_key"])
        except Exception as exc:  # noqa: BLE001
            return VideoGenResult(status=VideoGenStatus.FAILED, error=f"从 R2 下载视频失败: {exc}")

        sha = hashlib.sha256(data).hexdigest()
        if video_item.get("sha256") and sha != video_item["sha256"]:
            return VideoGenResult(status=VideoGenStatus.FAILED, error="下载的视频文件 sha256 校验不匹配")

        out_path = Path(output_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(out_path.write_bytes, data)
        log(f"完成，已保存到 {output_path}")

        return VideoGenResult(
            status=VideoGenStatus.DONE,
            video_path=str(output_path),
            duration_seconds=frames / _FPS,
        )
