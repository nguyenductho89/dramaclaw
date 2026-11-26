"""MiniMax H3 "v16" omni_reference graph for ComfyUI.

Ported from ad-with-skills tools/h3_workflow_graph.py (V16, build_v16_graph, preflight) and tools/lint_h3_prompts.py
(frames_for). One difference: the ResolutionSelector node (115) is replaced by the width/height computed in
`resolution()`, because its aspect-ratio option labels are only known for 16:9. 16:9 at 1 MP gives the same 1376x768.
"""
from __future__ import annotations

import json
import math
import os
import re

TEXT_ENCODER = os.environ.get("RUNPOD_H3_TEXT_ENCODER", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors")
VIDEO_VAE = os.environ.get("RUNPOD_H3_VIDEO_VAE", "minimax_h3_video_vae_fp16.safetensors")
AUDIO_VAE = os.environ.get("RUNPOD_H3_AUDIO_VAE", "minimax_h3_audio_vae_fp32.safetensors")

FPS = 24
MIN_SECONDS, MAX_SECONDS = 4, 15
MAX_IMAGES, MAX_VOICES = 9, 3

V16 = {
    "unet": "Cobijada_H3_Hybrid_Uncensored_pruned_hybrid_int8_convrot_pruned.safetensors",  # 324
    "weight_dtype": "default",
    "attention_backend": "comfy kitchen attention",  # 168
    "block_sparse": {  # 325
        "selection": "sol-attn", "tau": 1.3, "start_percent": 0.2, "end_percent": 1.0, "dense_blocks": "",
        "min_tokens": 12288, "extra_tokens": 256, "sink_conditioning": "exact_kv_and_rows", "verbose": True},
    "shift_video": 12.2, "shift_audio": 3.0,  # 207
    "loras": [["h3-realism-people-t2v-i2v-r2v.safetensors", 0.7],  # 361 (first applied)
              ["minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors", 0.75]],  # 323
    "sampler_name": "er_sde",  # 332
    "sigmas": "1, .9882, .973, .9524, .9231, .878, .8, .6316, .4737, .1579, 0",  # 326
    "megapixels": 1.0, "multiple": 32,
    "ref_image_size": "match",  # 270
    "crf": 19.0,
}
REMOVABLE = {"160", "168", "325"}  # attention nodes: dropped with a warning when the server cannot run them


def frames_for(seconds: float) -> int:
    """Frame count on the 17k+5 grid for `seconds` at 24 fps."""
    return 17 * math.ceil((seconds * FPS - 5) / 17) + 5


def resolution(ratio: str) -> tuple[int, int]:
    """Same formula as ComfyUI's ResolutionSelector: 1 MP is 1024*1024, each side rounded to a multiple of 32."""
    w, h = (int(x) for x in ratio.split(":"))
    scale = math.sqrt(V16["megapixels"] * 1024 * 1024 / (w * h))
    m = V16["multiple"]
    return max(m, round(w * scale / m) * m), max(m, round(h * scale / m) * m)


def build_v16_graph(prompt: str, frames: int, ratio: str, image_names: list[str], voice_names: list[str], seed: int) -> dict:
    assert 1 <= len(image_names) <= MAX_IMAGES, f"MiniMaxH3Unified takes 1-{MAX_IMAGES} reference images"
    assert len(voice_names) <= MAX_VOICES
    assert (frames - 5) % 17 == 0, f"{frames} frames is not 17k+5"
    wf = V16
    width, height = resolution(ratio)
    g: dict = {}
    g["324"] = {"class_type": "UNETLoader", "inputs": {"unet_name": wf["unet"], "weight_dtype": wf["weight_dtype"]}}
    g["128"] = {"class_type": "CLIPLoader", "inputs": {"clip_name": TEXT_ENCODER, "type": "minimax", "device": "default"}}
    g["119"] = {"class_type": "VAELoader", "inputs": {"vae_name": VIDEO_VAE}}
    g["120"] = {"class_type": "VAELoader", "inputs": {"vae_name": AUDIO_VAE}}
    g["160"] = {"class_type": "MiniMaxH3MemoryEfficientSageAttentionPatch", "inputs": {"model": ["324", 0]}}
    g["168"] = {"class_type": "ModelAttentionBackend", "inputs": {"model": ["160", 0], "attention": wf["attention_backend"]}}
    b = wf["block_sparse"]
    g["325"] = {"class_type": "BlockSparseAttention", "inputs": {
        "model": ["168", 0], "selection": b["selection"], "selection.tau": b["tau"], "start_percent": b["start_percent"],
        "end_percent": b["end_percent"], "dense_blocks": b["dense_blocks"], "min_tokens": b["min_tokens"],
        "extra_tokens": b["extra_tokens"], "sink_conditioning": b["sink_conditioning"], "verbose": b["verbose"]}}
    g["207"] = {"class_type": "MiniMaxH3SigmaShift", "inputs": {"model": ["325", 0], "shift_video": float(wf["shift_video"]), "shift_audio": float(wf["shift_audio"])}}
    last = ["207", 0]
    for nid, (name, strength) in zip(("361", "323"), wf["loras"]):
        g[nid] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": last, "lora_name": name, "strength_model": float(strength)}}
        last = [nid, 0]
    u = {"mode": "omni_reference", "mode.ref_image_size": wf["ref_image_size"], "clip": ["128", 0], "vae": ["119", 0],
         "audio_vae": ["120", 0], "prompt": prompt, "width": width, "height": height,
         "duration": round(frames / FPS, 4), "auto_length_from_audio": False, "media_state": "{}"}
    for k, name in enumerate(image_names):
        g[str(400 + k)] = {"class_type": "LoadImage", "inputs": {"image": name}}
        u[f"mode.ref_images.ref_image_{k}"] = [str(400 + k), 0]
    for k, name in enumerate(voice_names):
        g[str(420 + k)] = {"class_type": "LoadAudio", "inputs": {"audio": name}}
        u[f"mode.ref_audios.ref_audio_{k}"] = [str(420 + k), 0]
    g["270"] = {"class_type": "MiniMaxH3Unified", "inputs": u}
    g["329"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": int(seed)}}
    g["332"] = {"class_type": "KSamplerSelect", "inputs": {"sampler_name": wf["sampler_name"]}}
    g["326"] = {"class_type": "ManualSigmas", "inputs": {"sigmas": wf["sigmas"]}}
    g["331"] = {"class_type": "BasicGuider", "inputs": {"model": last, "conditioning": ["270", 0]}}
    g["328"] = {"class_type": "SamplerCustomAdvanced", "inputs": {
        "noise": ["329", 0], "guider": ["331", 0], "sampler": ["332", 0], "sigmas": ["326", 0], "latent_image": ["270", 1]}}
    g["263"] = {"class_type": "VAEDecode", "inputs": {"samples": ["328", 0], "vae": ["119", 0]}}
    g["256"] = {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["328", 0], "vae": ["120", 0]}}
    g["30"] = {"class_type": "CreateVideo", "inputs": {"images": ["263", 0], "audio": ["256", 0], "fps": FPS, "bit_depth": "auto", "color_space": "sRGB", "codec": "none"}}
    g["31"] = {"class_type": "SaveVideo", "inputs": {
        "video": ["30", 0], "filename_prefix": "photoreal_jzb", "format": "mp4", "format.codec": "h264",
        "format.codec.encoding": "re-encode", "format.codec.encoding.crf": float(wf["crf"]), "codec": "auto"}}
    return g


def _drop(graph: dict, nid: str) -> None:
    """Remove a model-in/model-out node and hand its input to whoever read its output."""
    src = graph[nid]["inputs"]["model"]
    del graph[nid]
    for node in graph.values():
        for k, v in node["inputs"].items():
            if v == [nid, 0]:
                node["inputs"][k] = src


def preflight(graph: dict, object_info: dict, n_images: int, n_voices: int) -> tuple[dict, list[str]]:
    """Check the graph against the server's /object_info before queueing; returns (graph, warnings).
    Unknown attention nodes (160/168/325) are dropped with a warning, any other unknown class_type raises.
    ComfyUI ignores unknown input keys, so image and voice sockets are counted explicitly."""
    warnings = []
    for nid in sorted(graph, key=int):
        ct = graph[nid]["class_type"]
        if ct not in object_info:
            if nid in REMOVABLE:
                _drop(graph, nid)
                warnings.append(f"node {nid} {ct} is not installed on this server: left out")
            else:
                raise RuntimeError(f"node {nid} {ct} is not installed on this server")
    if "168" in graph:
        opts = json.dumps(object_info["ModelAttentionBackend"])
        if graph["168"]["inputs"]["attention"] not in opts:
            warnings.append(f"attention backend {graph['168']['inputs']['attention']!r} is not offered by this server: using pytorch attention")
            graph["168"]["inputs"]["attention"] = "pytorch attention"
    spec = json.dumps(object_info["MiniMaxH3Unified"])
    for needle in ("omni_reference", "ref_images", "ref_image_", "ref_audios", "ref_audio_", "audio_vae"):
        if needle not in spec:
            raise RuntimeError(f"MiniMaxH3Unified on this server has no {needle!r}: the pack version differs from the one this graph was written for")
    u = graph["270"]["inputs"]
    got_i = [k for k in u if re.fullmatch(r"mode\.ref_images\.ref_image_\d+", k)]
    got_a = [k for k in u if re.fullmatch(r"mode\.ref_audios\.ref_audio_\d+", k)]
    if len(got_i) != n_images or len(got_a) != n_voices:
        raise RuntimeError(f"270 has {len(got_i)} image and {len(got_a)} audio sockets, the request needs {n_images} and {n_voices}")
    return graph, warnings
