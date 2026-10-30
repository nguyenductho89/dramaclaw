#!/usr/bin/env python3
"""Copy the gallery's posters and reference images into the frontend.

The Freezone "H3 templates" picker shows a poster (frame of the sample clip) and
the reference images published on the source pages. They are third-party
material, so frontend/public/h3-templates/ is gitignored; run this after
`python scripts/fetch_h3_gallery_media.py` and before building the web image:

    python scripts/sync_h3_picker_media.py

Writes frontend/public/h3-templates/<id>/{poster.jpg,ref-N.webp} and a
manifest.json ({id: {"poster": bool, "refs": N}}) the picker reads.
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "docs" / "h3-templates" / "media"
DEST = ROOT / "frontend" / "public" / "h3-templates"


def main() -> int:
    if not SRC.is_dir():
        print("no media: run scripts/fetch_h3_gallery_media.py first")
        return 1
    shutil.rmtree(DEST, ignore_errors=True)
    manifest: dict[str, dict[str, object]] = {}
    for d in sorted(p for p in SRC.iterdir() if p.is_dir()):
        out = DEST / d.name
        poster = d / "preview.jpg"
        refs = sorted(
            (f for f in d.iterdir() if re.fullmatch(r"ref-\d+\.webp", f.name)),
            key=lambda f: int(f.stem.split("-")[1]),
        )
        if not poster.exists() and not refs:
            continue
        out.mkdir(parents=True, exist_ok=True)
        if poster.exists():
            shutil.copyfile(poster, out / "poster.jpg")
        for f in refs:
            shutil.copyfile(f, out / f.name)
        manifest[d.name] = {"poster": poster.exists(), "refs": len(refs)}
    DEST.mkdir(parents=True, exist_ok=True)
    (DEST / "manifest.json").write_text(
        json.dumps(manifest, separators=(",", ":")), encoding="utf-8"
    )
    print(f"{len(manifest)} templates -> {DEST.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
