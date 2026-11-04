"""Batch Qwen-Image 2.1 keyframes against a LOCAL ComfyUI, one candidate set per skit chain.

  python previs_h3_test/scripts/qwen_keyframes_local.py previs_h3_test/scripts/skits/newton_pov
  python previs_h3_test/scripts/qwen_keyframes_local.py <dir> --dry-run   # validate and print one graph, no server

Reads `keyframe_prompt` and `aspect_ratio` from every chain_*.json in <dir>. Writes
<dir>/keyframes/candidates/chain_NN_sK.png, a contact_sheet.jpg and timing.json. Copy the chosen candidate to
<dir>/keyframes/chain_NN.png, the chain's `start_image`.
Env: COMFY_URL (default http://127.0.0.1:8188), KEYFRAME_CANDIDATES (4), KEYFRAME_SEED (1000).
The graph matches the t2i branch of `_runpod_qwen_image_graph` (nanobanana_grid.py), rebuilt here so the box does not
need that module's dependencies. cfg is 1, so negative_prompt does nothing: state every constraint positively.
"""
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
CANDIDATES = int(os.environ.get("KEYFRAME_CANDIDATES", "4"))
BASE_SEED = int(os.environ.get("KEYFRAME_SEED", "1000"))
TIMEOUT = 1800
# Same pixel sizes H3 multishot renders at, so the start image needs no rescale.
DIMS = {"9:16": (768, 1344), "16:9": (1344, 768)}


def graph(prompt: str, width: int, height: int, seed: int, prefix: str) -> dict:
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": RUNPOD_QWEN_IMAGE_UNET, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": RUNPOD_QWEN_IMAGE_TEXT_ENCODER, "type": "qwen_image", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": RUNPOD_QWEN_IMAGE_VAE}},
        "4": {"class_type": "TextEncodeQwenImage21", "inputs": {"clip": ["2", 0], "prompt": prompt, "negative_prompt": "", "resolution": 1024}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "6": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "seed": seed, "steps": 25, "cfg": 1.0, "sampler_name": "euler",
                                                   "scheduler": "simple", "positive": ["4", 0], "negative": ["4", 1],
                                                   "latent_image": ["5", 0], "denoise": 1.0}},
        "7": {"class_type": "VAEDecode", "inputs": {"samples": ["6", 0], "vae": ["3", 0]}},
        "8": {"class_type": "SaveImage", "inputs": {"images": ["7", 0], "filename_prefix": prefix}},
    }


def http(path: str, data: bytes | None = None, raw: bool = False):
    req = urllib.request.Request(URL + path, data=data, headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=120) as r:
        body = r.read()
    return body if raw else json.loads(body)


def render(g: dict) -> bytes:
    resp = http("/prompt", json.dumps({"prompt": g, "client_id": uuid.uuid4().hex}).encode())
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
            raise RuntimeError(json.dumps(status)[:1000])
        for item in hist[pid].get("outputs", {}).get("8", {}).get("images", []):
            q = urllib.parse.urlencode({k: item.get(k, "") for k in ("filename", "subfolder", "type")})
            return http(f"/view?{q}", raw=True)
        raise RuntimeError("finished without an image")
    raise TimeoutError(f"prompt {pid} not done after {TIMEOUT}s")


def contact_sheet(paths: list[list[Path]], out: Path, thumb_w: int = 240) -> None:
    from PIL import Image

    thumbs = [[Image.open(p).convert("RGB") for p in row] for row in paths]
    w, h = thumbs[0][0].size
    th = round(h * thumb_w / w)
    sheet = Image.new("RGB", (thumb_w * max(map(len, thumbs)), th * len(thumbs)), "white")
    for y, row in enumerate(thumbs):
        for x, im in enumerate(row):
            sheet.paste(im.resize((thumb_w, th)), (x * thumb_w, y * th))
    sheet.save(out, quality=88)


def main() -> None:
    skit_dir = Path(sys.argv[1])
    dry = "--dry-run" in sys.argv
    chains = sorted(skit_dir.glob("chain_*.json"))
    if not chains:
        sys.exit(f"no chain_*.json in {skit_dir}")
    out = skit_dir / "keyframes" / "candidates"
    timing, rows = [], []
    for chain in chains:
        data = json.loads(chain.read_text())
        width, height = DIMS[data.get("aspect_ratio") or "9:16"]
        row = []
        for k in range(1, CANDIDATES + 1):
            g = graph(data["keyframe_prompt"], width, height, BASE_SEED + k, f"{chain.stem}_s{k}")
            if dry:
                continue
            out.mkdir(parents=True, exist_ok=True)
            t0 = time.time()
            path = out / f"{chain.stem}_s{k}.png"
            path.write_bytes(render(g))
            secs = round(time.time() - t0, 1)
            timing.append({"chain": chain.stem, "candidate": k, "seed": BASE_SEED + k, "seconds": secs})
            print(path.name, f"{secs}s", flush=True)
            row.append(path)
        rows.append(row)
        if dry:
            print(chain.name, f"{width}x{height}", f"{CANDIDATES} candidates", len(data["keyframe_prompt"]), "chars")
    if dry:
        print(json.dumps(g["6"]["inputs"], indent=0)[:200])
        return
    (skit_dir / "keyframes" / "timing.json").write_text(json.dumps(timing, indent=1) + "\n")
    contact_sheet(rows, skit_dir / "keyframes" / "contact_sheet.jpg")
    print("contact sheet: rows = chains, columns = candidates")


main()
