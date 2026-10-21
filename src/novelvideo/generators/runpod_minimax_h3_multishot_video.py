"""RunPod Serverless MiniMax-H3 Multishot video generator.

Dev-only, gated by `config._runpod_h3_multishot_configured()`. Runs on a
SEPARATE RunPod endpoint (`RUNPOD_H3_MULTISHOT_ENDPOINT_ID`, display name
`h3-multishot-i2v-fl2va-ref2va`, shared with the `comfy-trends` project) and
a different worker image/node family entirely from the 1-shot H3 graph in
`runpod_minimax_h3_video.py` — this one uses the
`jlucasmcrell/ComfyUI-H3-Multishot` pack's single `H3MultishotSampler` node
(`H3ModelLoaderAny`/`H3ClipLoaderAny` loaders, not `UNETLoader`/`CLIPLoader`)
to chain N beats into one continuous multi-shot video: each beat becomes one
`---`-separated shot, with the previous shot's last frame relayed into the
next shot's first frame internally by the node.

Added 2026-10-19 after reading the pack's source directly (pinned commit
`RUNPOD_H3_MULTISHOT_PACK_COMMIT` in config.py) to root-cause failures seen
using this endpoint from `comfy-trends`/`photoreal` before integrating it
here — see `runpod-h3-qwen-endpoints.md` section 5a for the full table. Two
fixes encoded directly in this module (not left to call sites to get wrong
again):

- `save_every_shot=True` is ALWAYS forced on `H3MultishotSampler` — real
  host-RAM OOM was observed on a long chain before (`collect_outputs()`
  holding every shot's frames in RAM until the final mux); this writes each
  shot to disk as it decodes, limiting how much is lost if the mux itself
  OOMs. There is no way to turn this off here.
- There is deliberately NO `pin_frames` parameter anywhere in this module.
  That parameter does not exist on `H3MultishotSampler` (only on the
  separate `H3MultishotMemorySampler`, which needs another pack that is not
  installed on this worker image) — ComfyUI silently drops unknown widget
  values, so a caller passing it would get no error and no effect. Don't
  resurrect it without also installing `ComfyUI-H3-Motion-Context` and
  switching to that sampler.

Submit/poll (`run_h3_multishot_job`) measures its timeout deadline from the
job's own first `IN_PROGRESS` status, not from submit time — a real chain
job was auto-cancelled by the old client before while it was seconds from
finishing, because that client measured its deadline from submit and didn't
account for cold start. 409 retry on submit mirrors the 1-shot generator.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
import uuid
from typing import Any, Literal

logger = logging.getLogger(__name__)

Checkpoint = Literal["fl2va", "ref2va"]

# H3MultishotSampler's own grid: width/height must be multiples of 32 (NOT
# 16, unlike the 1-shot H3 graph in runpod_minimax_h3_video.py — a different
# CANVAS_MULTIPLE in this pack). frames_per_shot must be on the same 17k+5
# grid as 1-shot H3, but this node's own range is wider (5-481, "362 =
# trained max ~15.1s; beyond is untested" per the pack's own tooltip).
_SHOT_FRAME_GRID_MIN = 124
_SHOT_FRAME_GRID_MAX = 294
_SHOT_DIALOGUE_FRAME_MIN = 192
_FPS = 24.0
_BASE_STEPS = 20
_PDD_NFE_CHOICES = ("4", "6", "8")


def _round32(value: float) -> int:
    return max(32, round(value / 32.0) * 32)


def dims_for_multishot(aspect_ratio: str, profile: str = "formal") -> tuple[int, int]:
    """Same portrait/landscape profile pair as 1-shot H3
    (`runpod_minimax_h3_video.dims_for_ratio`), re-snapped to this pack's
    32px grid (768x1344/416x736 already satisfy it, so this is a no-op for
    those, but keeps the two modules independent rather than one importing
    the other's private helpers)."""
    from novelvideo.generators.runpod_minimax_h3_video import dims_for_ratio

    width, height = dims_for_ratio(aspect_ratio, profile)
    return _round32(width), _round32(height)


def frames_for_shot(seconds: float, *, is_dialogue: bool) -> int:
    """Round `seconds` onto the 17k+5 frame grid, clamped to
    [124, 294] like 1-shot H3 — v1 deliberately does not use this pack's
    full untested 5-481 range (see `runpod-h3-qwen-endpoints.md` section
    5b). Dialogue beats get a higher floor: the pack's own PROMPTING.md
    says 124 frames (~5.2s) "does not work" for dialogue — the model drops
    the airlock and the join audibly clips — only narration beats may use
    the short end of the grid.
    """
    from novelvideo.generators.runpod_minimax_h3_video import frames_for_duration

    frames = frames_for_duration(seconds)
    if is_dialogue and frames < _SHOT_DIALOGUE_FRAME_MIN:
        frames = _SHOT_DIALOGUE_FRAME_MIN
    return max(_SHOT_FRAME_GRID_MIN, min(_SHOT_FRAME_GRID_MAX, frames))


def join_shots_script(shot_prompts: list[str]) -> str:
    """`H3MultishotSampler.script`, always as the node's JSON form
    `{"prompts": [...]}` — never the plain `---`-separated form.

    The pack's `_parse_script` decides JSON vs plain text by the FIRST
    character of the whole script: anything starting with `[` or `{` is
    parsed as JSON and raises if that fails. Every DramaClaw H3 prompt
    starts with the mandatory `[Shot 1]` tag, so a plain `---` join always
    failed on the worker ("H3 script looks like JSON but does not parse",
    real job ad485558, 2026-10-21). JSON is the node's other documented
    input form and is immune to whatever a prompt contains (`[`, `{`, a
    stray `---` line). Each `shot_prompts[i]` should already independently
    repeat (not abbreviate) character/scene descriptions per the pack's own
    AIRLOCK/LAND SETTLED rules."""
    return json.dumps({"prompts": [p.strip() for p in shot_prompts]}, ensure_ascii=False)

def multishot_sampling_plan(checkpoint: Checkpoint) -> dict[str, Any]:
    """Resolve how a chain on `checkpoint` will be sampled, from config.

    PDD needs a distillation file matching the checkpoint's trunk: ref2va's
    is on the volume, fl2va's only once `RUNPOD_H3_PDD_FL2VA` is set. Without
    one the chain falls back to the base 20-step schedule. Shared by the
    review route (so the dialog shows what will actually run), the enqueue
    route and the runner, so the three can't disagree.
    """
    from novelvideo.config import (
        RUNPOD_H3_MULTISHOT_OUTPUT_SCALE,
        RUNPOD_H3_MULTISHOT_PDD_NFE,
        RUNPOD_H3_PDD_FL2VA,
        RUNPOD_H3_PDD_REF2VA,
    )

    nfe = str(RUNPOD_H3_MULTISHOT_PDD_NFE or "").strip()
    pdd_file = RUNPOD_H3_PDD_REF2VA if checkpoint == "ref2va" else RUNPOD_H3_PDD_FL2VA
    use_pdd = bool(nfe) and bool(pdd_file)
    return {
        "pdd_nfe": nfe if use_pdd else "",
        "pdd_file": pdd_file if use_pdd else "",
        "steps": int(nfe) if use_pdd else _BASE_STEPS,
        "output_scale": max(1.0, float(RUNPOD_H3_MULTISHOT_OUTPUT_SCALE or 1.0)),
    }


def build_h3_multishot_graph(
    *,
    script: str,
    shot_count: int,
    width: int,
    height: int,
    frames_per_shot: int,
    seed: int,
    steps: int,
    checkpoint: Checkpoint = "fl2va",
    sampler_name: str = "euler",
    scheduler: str = "beta",
    seed_per_shot: bool = True,
    start_image_name: str | None = None,
    reference_image_names: list[str] | None = None,
    voice_ref_names: list[str] | None = None,
    self_anchor_voice: bool = False,
    pdd_nfe: str = "",
    pdd_file: str = "",
    output_scale: float = 1.0,
) -> dict[str, Any]:
    """Build the `H3MultishotSampler` API graph.

    `reference_image_names`/`voice_ref_names` (and `self_anchor_voice`) are
    ref2va-only per the node's own docs ("verified on the ref2va checkpoint
    ... fl2va was not trained with reference rows") — passing either with
    `checkpoint="fl2va"` raises. `shot_count` must be 1-8 (this module
    always sets it explicitly rather than relying on the node's own
    auto-count-from-script mode, so the caller's own count and the node's
    rendered shot count can never silently disagree).
    """
    from novelvideo.config import (
        RUNPOD_H3_AUDIO_VAE,
        RUNPOD_H3_TEXT_ENCODER,
        RUNPOD_H3_UNET_FL2VA,
        RUNPOD_H3_UNET_REF2VA,
        RUNPOD_H3_VIDEO_VAE,
    )

    if not (1 <= shot_count <= 8):
        raise ValueError(f"shot_count must be 1-8, got {shot_count}")
    if width % 32 or height % 32:
        raise ValueError(f"width/height must be multiples of 32, got {width}x{height}")
    reference_image_names = reference_image_names or []
    voice_ref_names = voice_ref_names or []
    if checkpoint == "fl2va" and (reference_image_names or voice_ref_names or self_anchor_voice):
        raise ValueError(
            "reference_images/voice_ref/self_anchor_voice need checkpoint='ref2va' "
            "(fl2va was not trained with reference rows)"
        )
    if len(voice_ref_names) > 3:
        raise ValueError("at most 3 voice_ref slots (voice_ref, voice_ref_2, voice_ref_3)")

    if pdd_nfe and pdd_nfe not in _PDD_NFE_CHOICES:
        raise ValueError(f"pdd_nfe only supports '4'/'6'/'8', got {pdd_nfe!r}")
    if pdd_nfe and not pdd_file:
        raise ValueError("pdd_nfe needs a pdd_file matching the checkpoint")
    if output_scale < 1.0:
        raise ValueError(f"output_scale must be >= 1.0, got {output_scale}")

    unet_name = RUNPOD_H3_UNET_REF2VA if checkpoint == "ref2va" else RUNPOD_H3_UNET_FL2VA

    graph: dict[str, Any] = {
        "1": {
            "class_type": "H3ModelLoaderAny",
            "inputs": {"model_name": unet_name, "activation_reserve_gb": 0.0},
        },
        "2": {
            "class_type": "H3ClipLoaderAny",
            "inputs": {"clip_name": RUNPOD_H3_TEXT_ENCODER, "type": "minimax"},
        },
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": RUNPOD_H3_VIDEO_VAE}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": RUNPOD_H3_AUDIO_VAE}},
        "10": {
            "class_type": "H3MultishotSampler",
            "inputs": {
                "model": ["1", 0],
                "clip": ["2", 0],
                "video_vae": ["3", 0],
                "audio_vae": ["4", 0],
                "script": script,
                "shot_count": shot_count,
                "width": width,
                "height": height,
                "frames_per_shot": frames_per_shot,
                "seed": seed,
                "steps": steps,
                "seed_per_shot": seed_per_shot,
                "sampler_name": sampler_name,
                "scheduler": scheduler,
                "self_anchor_voice": self_anchor_voice,
                # Always on — see module docstring. Not exposed as a
                # parameter: there is no safe reason to disable it.
                "save_every_shot": True,
            },
        },
        "20": {
            "class_type": "H3ChainNormalize",
            "inputs": {
                "images": ["10", 0],
                "baseline_seconds": 10.0,
                "skip_seconds": 2.0,
                "fps": _FPS,
                "strength": 1.0,
                "deadband": 1.06,
                "ema": 0.10,
                "colour_match": True,
            },
        },
        "30": {
            "class_type": "CreateVideo",
            "inputs": {
                "images": ["20", 0],
                "audio": ["10", 1],
                "fps": _FPS,
                "bit_depth": "auto",
                "color_space": "sRGB",
                "codec": "none",
            },
        },
        "31": {
            "class_type": "SaveVideo",
            "inputs": {
                "video": ["30", 0],
                "filename_prefix": "dramaclaw_h3_multishot",
                "format": "mp4",
                "format.codec": "h264",
                "format.codec.encoding": "re-encode",
                "format.codec.encoding.crf": 14.0,
                "codec": "auto",
            },
        },
    }

    if pdd_nfe:
        # Same chain as 1-shot H3 (`build_h3_ref2va_graph` nodes "5"/"6").
        # The sampler takes the patched model AND the Apply node's own
        # trained-grid sigmas; with `sigmas` wired it ignores `steps`/
        # `scheduler`. euler is required: PDD was distilled on euler and
        # `on_off_grid="error"` rejects evaluations off the block boundaries
        # (the node's own default sampler, res_multistep, isn't what was
        # trained).
        graph["5"] = {
            "class_type": "MiniMaxH3SigmaShift",
            "inputs": {"model": ["1", 0], "shift_video": 12.0, "shift_audio": 3.0},
        }
        graph["6"] = {
            "class_type": "MiniMaxH3PDDAccApply",
            "inputs": {
                "model": ["5", 0],
                "pdd_file": pdd_file,
                "nfe": pdd_nfe,
                "lora_strength": 1.0,
                "head_strength": 1.0,
                "on_off_grid": "error",
            },
        }
        sampler_inputs = graph["10"]["inputs"]
        sampler_inputs["model"] = ["6", 0]
        sampler_inputs["sigmas"] = ["6", 1]
        sampler_inputs["steps"] = int(pdd_nfe)
        sampler_inputs["sampler_name"] = "euler"

    if output_scale > 1.0:
        graph["10"]["inputs"]["output_scale"] = float(output_scale)

    if start_image_name:
        graph["100"] = {"class_type": "LoadImage", "inputs": {"image": start_image_name}}
        graph["10"]["inputs"]["start_image"] = ["100", 0]

    if reference_image_names:
        for k, name in enumerate(reference_image_names):
            graph[str(110 + k)] = {"class_type": "LoadImage", "inputs": {"image": name}}
        # ImageBatch chains exactly 2 images per node (comfy-trends'
        # `h3_multishot()` does the same) — fold left-to-right so N images
        # end up batched into one IMAGE output.
        batched = ["110", 0]
        for k in range(1, len(reference_image_names)):
            node_id = str(120 + k)
            graph[node_id] = {
                "class_type": "ImageBatch",
                "inputs": {"image1": batched, "image2": [str(110 + k), 0]},
            }
            batched = [node_id, 0]
        graph["10"]["inputs"]["reference_images"] = batched

    voice_slot_keys = ["voice_ref", "voice_ref_2", "voice_ref_3"]
    for k, name in enumerate(voice_ref_names):
        node_id = str(200 + k)
        graph[node_id] = {"class_type": "LoadAudio", "inputs": {"audio": name}}
        graph["10"]["inputs"][voice_slot_keys[k]] = [node_id, 0]

    return graph


async def run_h3_multishot_job(
    *,
    api_key: str,
    endpoint_id: str,
    timeout_seconds: float,
    graph: dict[str, Any],
    upload_payloads: list[tuple[str, bytes, str]],
    on_log: Any = None,
) -> tuple[bytes | None, dict[str, Any], str]:
    """Upload inputs to R2, submit the graph, poll to completion, download
    the result. Returns `(video_bytes, status_info, error)` — `video_bytes`
    is `None` on any failure, with `error` describing why.

    Reuses the R2 upload/download helpers from `nanobanana_grid.py` (shared
    R2 bucket, same sha256-keyed cache) — only the submit/poll loop here is
    new, specifically to fix the deadline-from-IN_PROGRESS bug (see module
    docstring).
    """
    from novelvideo.generators.nanobanana_grid import (
        _runpod_download_output_sync,
        _runpod_upload_inputs_sync,
    )

    def log(msg: str) -> None:
        logger.info("[runpod_minimax_h3_multishot] %s", msg)
        if on_log:
            on_log(msg)

    try:
        job_inputs = await asyncio.to_thread(_runpod_upload_inputs_sync, upload_payloads)
    except Exception as exc:  # noqa: BLE001
        return None, {}, f"upload to R2 failed: {exc}"

    import httpx

    base = "https://api.runpod.ai/v2"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    job_input = {"action": "prompt", "workflow": graph, "inputs": job_inputs, "free_first": False}

    job_id: str | None = None
    async with httpx.AsyncClient(timeout=60.0) as client:
        for attempt in range(6):
            try:
                resp = await client.post(
                    f"{base}/{endpoint_id}/run", headers=headers, json={"input": job_input}
                )
                if resp.status_code == 409 and attempt < 5:
                    log("RunPod endpoint just started (409 ENDPOINT_PAUSED), retrying submit in 10s...")
                    await asyncio.sleep(10)
                    continue
                resp.raise_for_status()
                job_id = resp.json()["id"]
                break
            except httpx.HTTPError as exc:
                if attempt >= 5:
                    return None, {}, f"submit failed: {exc}"
                await asyncio.sleep(10)
    if not job_id:
        return None, {}, "submit failed: unknown reason"

    log(f"RunPod job {job_id} submitted, polling (up to {timeout_seconds:.0f}s, counted from IN_PROGRESS)...")

    # Fix for the real "cancelled near completion" bug: the deadline starts
    # counting from submit time but gets PUSHED BACK once (not reset
    # repeatedly) the first time we observe IN_PROGRESS, so a slow cold
    # start doesn't eat into the budget meant for actual sampling time.
    deadline = time.monotonic() + timeout_seconds
    seen_in_progress = False
    status_resp: dict[str, Any] = {}
    last_poll_error = ""
    async with httpx.AsyncClient(timeout=60.0) as client:
        while time.monotonic() < deadline:
            await asyncio.sleep(5)
            try:
                status_response = await client.get(f"{base}/{endpoint_id}/status/{job_id}", headers=headers)
                status_response.raise_for_status()
                status_resp = status_response.json()
            except httpx.HTTPError as exc:
                last_poll_error = str(exc)
                continue
            current_status = status_resp.get("status")
            if current_status == "IN_PROGRESS" and not seen_in_progress:
                seen_in_progress = True
                deadline = time.monotonic() + timeout_seconds
                log(f"job {job_id} entered IN_PROGRESS, restarting the {timeout_seconds:.0f}s timer")
            if current_status not in ("IN_QUEUE", "IN_PROGRESS"):
                break
        else:
            try:
                await client.post(f"{base}/{endpoint_id}/cancel/{job_id}", headers=headers)
            except httpx.HTTPError:
                pass
            status_note = status_resp.get("status", "IN_QUEUE")
            poll_note = f"; last poll error: {last_poll_error}" if last_poll_error else ""
            return (
                None,
                status_resp,
                f"job {job_id} timed out after {timeout_seconds:.0f}s "
                f"(still {status_note} — endpoint workers.max may be 0){poll_note}",
            )

    status = status_resp.get("status")
    output = status_resp.get("output") or {}
    inner_status = output.get("status") if isinstance(output, dict) else None
    if status != "COMPLETED" or (isinstance(inner_status, dict) and inner_status.get("completed") is False):
        return None, status_resp, f"job {status}: {json.dumps(status_resp)[:1200]}"
    if output.get("error"):
        return None, status_resp, f"worker error: {output['error']}"
    if output.get("node_errors"):
        return None, status_resp, f"node_errors: {json.dumps(output['node_errors'])[:1200]}"

    video_item = None
    for node_out in (output.get("outputs") or {}).values():
        for lst in node_out.values() if isinstance(node_out, dict) else []:
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
        return None, status_resp, "job completed but had no output video"

    try:
        data = await asyncio.to_thread(_runpod_download_output_sync, video_item["r2_key"])
    except Exception as exc:  # noqa: BLE001
        return None, status_resp, f"download from R2 failed: {exc}"

    sha = hashlib.sha256(data).hexdigest()
    if video_item.get("sha256") and sha != video_item["sha256"]:
        return None, status_resp, "downloaded video sha256 mismatch"

    return data, status_resp, ""


def new_seed() -> int:
    return uuid.uuid4().int & 0xFFFFFFFF
