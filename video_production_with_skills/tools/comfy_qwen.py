"""ComfyUI helpers for Qwen-Image 2.1 on a LOCAL ComfyUI (rented GPU box): model loaders, sampler, image upload, render.
Used by qwen_images.py. Qwen-Image 2.1 is licensed for research and evaluation only: test output only, not for a
monetised release.

Edits run at resolution 1536, then shrink to the frame size: at about 1 megapixel this edit path leaves a painterly
texture and a halo, whatever the steps, quantisation or Sage setting. The sampled latent comes from
TextEncodeQwenImage21 output 2, so an edit keeps the size of its first image, as the node's own tooltip requires.
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

R = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(R / "src"))
from novelvideo.config import RUNPOD_QWEN_IMAGE_TEXT_ENCODER, RUNPOD_QWEN_IMAGE_UNET, RUNPOD_QWEN_IMAGE_VAE  # noqa: E402

URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
TIMEOUT = 1800
WIDTH, HEIGHT = 1344, 768
EDIT_STEPS = 40
EDIT_RESOLUTION = 1536


def loaders() -> dict:
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": RUNPOD_QWEN_IMAGE_UNET, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": RUNPOD_QWEN_IMAGE_TEXT_ENCODER, "type": "qwen_image", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": RUNPOD_QWEN_IMAGE_VAE}},
    }


def sampler(model: list, latent: list, seed: int, steps: int) -> dict:
    return {
        "6": {"class_type": "KSampler", "inputs": {"model": model, "seed": seed, "steps": steps, "cfg": 1.0, "sampler_name": "euler",
                                                   "scheduler": "simple", "positive": ["4", 0], "negative": ["4", 1],
                                                   "latent_image": latent, "denoise": 1.0}},
        "7": {"class_type": "VAEDecode", "inputs": {"samples": ["6", 0], "vae": ["3", 0]}},
        "8": {"class_type": "SaveImage", "inputs": {"images": ["7", 0], "filename_prefix": "keyframe"}},
    }


def http(path: str, data: bytes | None = None, headers: dict | None = None, raw: bool = False):
    req = urllib.request.Request(URL + path, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=300) as r:
        body = r.read()
    return body if raw else json.loads(body)


def upload(path: Path) -> str:
    b = uuid.uuid4().hex
    body = (f'--{b}\r\nContent-Disposition: form-data; name="image"; filename="{path.name}"\r\nContent-Type: image/png\r\n\r\n').encode() \
        + path.read_bytes() + (f'\r\n--{b}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n--{b}--\r\n').encode()
    return http("/upload/image", body, {"Content-Type": f"multipart/form-data; boundary={b}"})["name"]


def render(graph: dict) -> bytes:
    resp = http("/prompt", json.dumps({"prompt": graph, "client_id": uuid.uuid4().hex}).encode(), {"Content-Type": "application/json"})
    if resp.get("node_errors"):
        raise RuntimeError(f"node_errors: {json.dumps(resp['node_errors'])[:1000]}")
    pid = resp["prompt_id"]
    t0 = time.time()
    while time.time() - t0 < TIMEOUT:
        time.sleep(2)
        hist = http(f"/history/{pid}")
        if pid not in hist:
            continue
        status = hist[pid].get("status", {})
        if status.get("status_str") == "error":
            raise RuntimeError(json.dumps(status)[:1500])
        for item in hist[pid].get("outputs", {}).get("8", {}).get("images", []):
            q = urllib.parse.urlencode({k: item.get(k, "") for k in ("filename", "subfolder", "type")})
            return http(f"/view?{q}", raw=True)
        raise RuntimeError("finished without an image")
    raise TimeoutError(f"prompt {pid} not done after {TIMEOUT}s")
