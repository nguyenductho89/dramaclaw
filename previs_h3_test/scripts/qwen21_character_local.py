"""Character portrait and identity-keeping keyframes with Qwen-Image 2.1 on a LOCAL ComfyUI.

  python previs_h3_test/scripts/qwen21_character_local.py portrait <prompt.txt> <out_dir> [--n 3] [--dry-run]
  python previs_h3_test/scripts/qwen21_character_local.py keyframes <skit_dir> <portrait.png> [--dry-run]

portrait: text-to-image at 1344x768, writes portrait_sK.png.
keyframes: edits the portrait using each chain's `keyframe_edit_prompt` and writes <skit_dir>/keyframes/chain_NN.png, the chain's
`start_image`. The sampled latent comes from TextEncodeQwenImage21, so the output keeps the portrait's size, as the node's own
tooltip requires for edits. Edits run at resolution 1536, then shrink to 1344x768: at about 1 megapixel this edit path leaves a
painterly texture and a halo, whatever the steps, quantisation or Sage setting (keyframes/artifact_test*, 2026-11-05). Same recipe as `_runpod_qwen21_render_image_graph` (nanobanana_grid.py), rebuilt here so the box does
not need that module's dependencies.

Qwen-Image 2.1 is licensed for research and evaluation only: test output only, not for a monetised release.
"""
import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

R = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(R / "src"))
from novelvideo.config import RUNPOD_QWEN_IMAGE_TEXT_ENCODER, RUNPOD_QWEN_IMAGE_UNET, RUNPOD_QWEN_IMAGE_VAE  # noqa: E402

URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
TIMEOUT = 1800
WIDTH, HEIGHT = 1344, 768
T2I_STEPS = 25
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
        "8": {"class_type": "SaveImage", "inputs": {"images": ["7", 0], "filename_prefix": "science_humor"}},
    }


def t2i_graph(prompt: str, seed: int) -> dict:
    return {**loaders(),
            "4": {"class_type": "TextEncodeQwenImage21", "inputs": {"clip": ["2", 0], "prompt": prompt, "negative_prompt": "", "resolution": 1024}},
            "5": {"class_type": "EmptyLatentImage", "inputs": {"width": WIDTH, "height": HEIGHT, "batch_size": 1}},
            **sampler(["1", 0], ["5", 0], seed, T2I_STEPS)}


def edit_graph(prompt: str, image_name: str, seed: int) -> dict:
    return {**loaders(),
            "9": {"class_type": "QwenImage21Cache", "inputs": {"model": ["1", 0], "device": "auto", "dtype": "default"}},
            "10": {"class_type": "LoadImage", "inputs": {"image": image_name}},
            "4": {"class_type": "TextEncodeQwenImage21", "inputs": {"clip": ["2", 0], "vae": ["3", 0], "prompt": prompt, "negative_prompt": "",
                                                                    "resolution": EDIT_RESOLUTION, "images.image_1": ["10", 0]}},
            **sampler(["9", 0], ["4", 2], seed, EDIT_STEPS)}


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


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("mode", choices=["portrait", "keyframes"])
    p.add_argument("a")
    p.add_argument("b")
    p.add_argument("--n", type=int, default=3)
    p.add_argument("--seed", type=int, default=1000)
    p.add_argument("--dry-run", action="store_true")
    o = p.parse_args()
    timing = []
    if o.mode == "portrait":
        prompt, out = Path(o.a).read_text().strip(), Path(o.b)
        jobs = [(t2i_graph(prompt, o.seed + k), out / f"portrait_s{k}.png", o.seed + k) for k in range(o.n)]
        log = out / "portrait_timing.json"
    else:
        skit, portrait = Path(o.a), Path(o.b)
        name = "dry-run.png" if o.dry_run else upload(portrait)
        jobs = []
        for f in sorted(skit.glob("chain_*.json")):
            jobs.append((edit_graph(json.loads(f.read_text())["keyframe_edit_prompt"], name, o.seed), skit / "keyframes" / f"{f.stem}.png", o.seed))
        log = skit / "keyframes" / "timing.json"
    if not jobs:
        sys.exit("nothing to do")
    for graph, dest, seed in jobs:
        if o.dry_run:
            print(dest, "nodes", sorted(graph), "steps", graph["6"]["inputs"]["steps"], "latent", graph["6"]["inputs"]["latent_image"])
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        data = render(graph)
        dest.write_bytes(data)
        if o.mode == "keyframes":
            import io
            from PIL import Image
            Image.open(io.BytesIO(data)).convert("RGB").resize((WIDTH, HEIGHT), Image.LANCZOS).save(dest)
        timing.append({"file": dest.name, "seed": seed, "seconds": round(time.time() - t0, 1)})
        print(dest.name, f"{timing[-1]['seconds']}s", flush=True)
        log.write_text(json.dumps(timing, indent=1) + "\n")


if __name__ == "__main__":
    main()
