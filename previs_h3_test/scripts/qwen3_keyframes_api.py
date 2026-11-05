# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx", "python-dotenv"]
# ///
"""Character sheet and chain keyframes through the hosted Qwen Image 3.0 API (not the research-licensed Qwen-Image 2.1).

  uv run previs_h3_test/scripts/qwen3_keyframes_api.py sheet <out_dir> "<prompt>" [--n 3]
  uv run previs_h3_test/scripts/qwen3_keyframes_api.py keyframes <skit_dir> <sheet.png> [--n 2]

`keyframes` reads `keyframe_prompt` from every chain_*.json and writes <skit_dir>/keyframes/candidates/chain_NN_sK.png.
Copy the chosen candidate to keyframes/chain_NN.png. Key: QWEN_API_KEY from the environment or the repo .env; never printed.
"""
import argparse
import base64
import json
import os
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

R = Path(__file__).resolve().parents[2]
ENDPOINT = "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
MODEL = os.environ.get("QWEN3_MODEL", "qwen-image-3.0")
SIZE = {"16:9": "1344*768", "9:16": "768*1344"}
REF_LINE = ("The man in this image is the exact same person as the man in the reference image: same face, hair, glasses and "
            "clothes. Do not copy the reference layout; show him once. ")


def generate(key: str, prompt: str, size: str, seed: int, ref: Path | None, out: Path) -> dict:
    content = []
    if ref:
        content.append({"image": "data:image/png;base64," + base64.b64encode(ref.read_bytes()).decode()})
    content.append({"text": prompt})
    payload = {"model": MODEL, "input": {"messages": [{"role": "user", "content": content}]},
               "parameters": {"size": size, "n": 1, "watermark": False, "prompt_extend": False, "seed": seed}}
    t0 = time.time()
    r = httpx.post(ENDPOINT, headers={"Authorization": f"Bearer {key}"}, json=payload, timeout=300)
    if r.status_code >= 400:
        raise SystemExit(f"HTTP {r.status_code}: {r.text[:500]}")
    data = r.json()
    if data.get("code"):
        raise SystemExit(f"{data['code']}: {data.get('message')}")
    url = next(c["image"] for c in data["output"]["choices"][0]["message"]["content"] if c.get("image"))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(httpx.get(url, timeout=120).content)
    rec = {"file": out.name, "seed": seed, "size": size, "model": MODEL, "seconds": round(time.time() - t0, 1)}
    print(json.dumps(rec), flush=True)
    return rec


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("mode", choices=["sheet", "keyframes"])
    p.add_argument("target")
    p.add_argument("arg")
    p.add_argument("--n", type=int, default=2)
    p.add_argument("--seed", type=int, default=1000)
    a = p.parse_args()
    load_dotenv(R / ".env")
    key = os.environ["QWEN_API_KEY"]
    out = Path(a.target)
    recs = []
    if a.mode == "sheet":
        for k in range(a.n):
            recs.append(generate(key, a.arg, SIZE["16:9"], a.seed + k, None, out / f"sheet_s{k}.png"))
        (out / "sheet_prompt.txt").write_text(a.arg + "\n")
    else:
        ref = Path(a.arg)
        for f in sorted(out.glob("chain_*.json")):
            d = json.loads(f.read_text())
            for k in range(a.n):
                dest = out / "keyframes" / "candidates" / f"{f.stem}_s{k}.png"
                recs.append(generate(key, REF_LINE + d["keyframe_prompt"], SIZE[d["aspect_ratio"]], a.seed + k, ref, dest))
    (out / ("sheet_timing.json" if a.mode == "sheet" else "keyframes/timing.json")).write_text(json.dumps(recs, indent=1) + "\n")


if __name__ == "__main__":
    main()
