"""Qwen-Image 2.1 edit graph for ComfyUI.

Ported from ad-with-skills tools/comfy_qwen.py (loaders, sampler) and tools/qwen_images.py (compose_graph, canvas_image).
Qwen-Image 2.1 is licensed for research and evaluation only: test output only.
"""
from __future__ import annotations

import io
import os

from PIL import Image

UNET = os.environ.get("RUNPOD_QWEN_IMAGE_UNET", "qwen_image_2.1_int8_convrot.safetensors")
TEXT_ENCODER = os.environ.get("RUNPOD_QWEN_IMAGE_TEXT_ENCODER", "qwen3vl_8b_int8_convrot.safetensors")
VAE = os.environ.get("RUNPOD_QWEN_IMAGE_VAE", "qwen_image_2.1_vae_bf16.safetensors")

EDIT_STEPS = 40
EDIT_RESOLUTION = 1536
MAX_IMAGES = 10
MID_GREY = (128, 128, 128)


def loaders() -> dict:
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": UNET, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": TEXT_ENCODER, "type": "qwen_image", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
    }


def sampler(model: list, latent: list, seed: int, steps: int) -> dict:
    return {
        "6": {"class_type": "KSampler", "inputs": {
            "model": model, "seed": seed, "steps": steps, "cfg": 1.0, "sampler_name": "euler",
            "scheduler": "simple", "positive": ["4", 0], "negative": ["4", 1],
            "latent_image": latent, "denoise": 1.0}},
        "7": {"class_type": "VAEDecode", "inputs": {"samples": ["6", 0], "vae": ["3", 0]}},
        "8": {"class_type": "SaveImage", "inputs": {"images": ["7", 0], "filename_prefix": "keyframe"}},
    }


def compose_graph(prompt: str, image_names: list[str], seed: int, steps: int = EDIT_STEPS) -> dict:
    """image_names[0] is the edit target (image_1) and sets the output size; the rest are references."""
    if not 1 <= len(image_names) <= MAX_IMAGES:
        raise ValueError(f"TextEncodeQwenImage21 takes 1..{MAX_IMAGES} images, got {len(image_names)}")
    graph = loaders()
    graph["9"] = {"class_type": "QwenImage21Cache", "inputs": {"model": ["1", 0], "device": "auto", "dtype": "default"}}
    images_inputs = {}
    for k, name in enumerate(image_names, start=1):
        node = str(100 + k)
        graph[node] = {"class_type": "LoadImage", "inputs": {"image": name}}
        images_inputs[f"images.image_{k}"] = [node, 0]
    graph["4"] = {"class_type": "TextEncodeQwenImage21", "inputs": {
        "clip": ["2", 0], "vae": ["3", 0], "prompt": prompt, "negative_prompt": "",
        "resolution": EDIT_RESOLUTION, **images_inputs}}
    return {**graph, **sampler(["9", 0], ["4", 2], seed, steps)}


def canvas_png(ratio: str, long_side: int = EDIT_RESOLUTION) -> bytes:
    """Plain grey first image: the node sizes its output to image_1, so this sets the requested aspect ratio."""
    w, h = (int(x) for x in ratio.split(":"))
    if w >= h:
        size = (long_side, round(long_side * h / w / 32) * 32)
    else:
        size = (round(long_side * w / h / 32) * 32, long_side)
    buf = io.BytesIO()
    Image.new("RGB", size, MID_GREY).save(buf, "PNG")
    return buf.getvalue()
