#!/usr/bin/env python3
"""Download the sample clips/images of the H3 template gallery.

Media is not tracked by git (it is third-party material, ~50 MB). Run this
once after cloning to fill docs/h3-templates/media/<template id>/:

    python scripts/fetch_h3_gallery_media.py [--force]

Reads docs/h3-templates/media-sources.json ({id: {"vid": url, "refN": url}}),
re-encodes each clip (long side <= 960px, H.264 crf 28) and cuts a poster at 1s.
Needs ffmpeg and curl.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "docs" / "h3-templates"
SCALE = "scale='if(gt(iw,ih),min(960,iw),-2)':'if(gt(iw,ih),-2,min(960,ih))'"


def curl(url: str, dest: Path) -> None:
    subprocess.run(["curl", "-sSL", "-m", "120", "-o", str(dest), url], check=True)


def fetch(job: tuple[str, str, str, bool]) -> str:
    tid, kind, url, force = job
    d = ROOT / "media" / tid
    d.mkdir(parents=True, exist_ok=True)
    if kind == "vid":
        out = d / "preview.mp4"
        if out.exists() and not force:
            return f"skip {tid}"
        raw = d / "raw.mp4"
        curl(url, raw)
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", str(raw), "-vf", SCALE,
             "-c:v", "libx264", "-crf", "28", "-preset", "medium", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", str(out)],
            check=True,
        )
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-ss", "1", "-i", str(out),
             "-frames:v", "1", "-q:v", "5", str(d / "preview.jpg")],
            check=True,
        )
        raw.unlink()
        return f"ok {tid}"
    dest = d / f"ref-{kind[3:]}.webp"
    if dest.exists() and not force:
        return f"skip {tid}/{kind}"
    curl(url, dest)
    return f"ok {tid}/{kind}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    sources = json.loads((ROOT / "media-sources.json").read_text(encoding="utf-8"))
    jobs = [(t, k, u, args.force) for t, d in sources.items() for k, u in d.items()]
    failed = 0
    with ThreadPoolExecutor(6) as pool:
        futs = [(j, pool.submit(fetch, j)) for j in jobs]
        for j, f in futs:
            try:
                print(f.result())
            except Exception as exc:  # keep going; one dead link must not stop the rest
                failed += 1
                print(f"FAIL {j[0]}/{j[1]}: {exc}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
