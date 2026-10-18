# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Convert the short-drama style assets exported from Feishu into style-gallery static assets plus a style manifest.

Usage:

    .venv/bin/python scripts/build_style_gallery.py \\
        --source ~/Downloads/feishu-export-1/golden_age \\
        --source ~/Downloads/feishu-export-2/atompunk \\
        --source ~/Downloads/styles-batch-2 \\
        --out frontend/public/style-gallery \\
        --emit-manifest src/novelvideo/freezone/style_templates.json

--source may be passed multiple times; each must directly contain several style subfolders
(named after the style ids in STYLE_META), and each subfolder holds a prompt.txt.
The top-level folders of a Feishu export are complete duplicate copies of each other, so
pick any one of them per batch; an asset pack handed over later (styles-batch-2) is already
that level itself.
Every style in STYLE_META is looked up by id across all --source directories; a missing
one aborts with an error.

The output is a pair: an image directory plus one JSON manifest. The whole image directory
can be uploaded to OSS (set `STYLE_GALLERY_ASSET_BASE` on the backend); when the manifest is
regenerated, overwrite the built-in one, or save it elsewhere and point
`STYLE_GALLERY_MANIFEST` at it. Neither side needs a code change.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

from PIL import Image

# Dangling punctuation: meaningless at the end of a prompt, so strip it. The full stop is
# not in the list; it is a normal sentence ending.
TRAILING_PUNCTUATION = ",;\uff0c\uff1b\u3001 \t\u3000"

COVER_MAX_EDGE = 720
COVER_QUALITY = 78
# After the style count grew from 11 to 24 the sample images doubled, so the spec is a bit
# lower than the first design; a single image shows at about 350px in the detail view, and
# a 1120 long edge still has headroom on 2x screens.
SAMPLE_MAX_EDGE = 1120
SAMPLE_QUALITY = 74

# Order is the card order on the image wall, grouped by genre. Each style's source folder
# is named after its `id` (rename the folders of the external Feishu export to these ids).
# The second batch is organized by technique/medium: styles that fit an existing category
# follow that category, and the three new categories (animation/painting/myth) come last.
STYLE_META: list[dict[str, str]] = [
    {"src": "period_idol", "id": "period_idol", "label": "Period Idol", "category": "period"},
    {"src": "palace_intrigue", "id": "palace_intrigue", "label": "Palace Intrigue", "category": "period"},
    {"src": "wuxia", "id": "wuxia", "label": "Wuxia", "category": "period"},
    {"src": "cn_urban", "id": "cn_urban", "label": "Chinese Urban", "category": "urban"},
    {"src": "urban_romance", "id": "urban_romance", "label": "Urban Romance", "category": "urban"},
    {"src": "crime_suspense", "id": "crime_suspense", "label": "Crime Suspense", "category": "urban"},
    {"src": "korean_muted", "id": "korean_muted", "label": "Korean Muted", "category": "urban"},
    {"src": "nineties", "id": "nineties", "label": "The Nineties", "category": "era"},
    {"src": "golden_age", "id": "golden_age", "label": "Golden Age", "category": "era"},
    {"src": "documentary_realism", "id": "documentary_realism", "label": "Documentary Realism", "category": "era"},
    {"src": "retro_narrative", "id": "retro_narrative", "label": "Retro Narrative", "category": "era"},
    {"src": "american_nineties", "id": "american_nineties", "label": "American Nineties", "category": "era"},
    {"src": "showa_monochrome", "id": "showa_monochrome", "label": "Showa Monochrome", "category": "era"},
    {"src": "vintage_industrial", "id": "vintage_industrial", "label": "Vintage Industrial", "category": "era"},
    {"src": "sixties_poster", "id": "sixties_poster", "label": "Sixties Poster", "category": "era"},
    {"src": "hk_retro", "id": "hk_retro", "label": "Retro Hong Kong Cinema", "category": "era"},
    {"src": "retro_film", "id": "retro_film", "label": "Retro Film", "category": "era"},
    {"src": "healing_life", "id": "healing_life", "label": "Healing Life", "category": "lifestyle"},
    {"src": "youth_film", "id": "youth_film", "label": "Youth Film", "category": "lifestyle"},
    {"src": "atompunk", "id": "atompunk", "label": "Atompunk", "category": "scifi"},
    {"src": "neon_punk", "id": "neon_punk", "label": "Neon Punk", "category": "scifi"},
    {"src": "hard_scifi", "id": "hard_scifi", "label": "Hard Sci-Fi", "category": "scifi"},
    {"src": "steampunk", "id": "steampunk", "label": "Steampunk", "category": "scifi"},
    {"src": "biopunk", "id": "biopunk", "label": "Biopunk", "category": "scifi"},
    {"src": "psychological_horror", "id": "psychological_horror", "label": "Psychological Horror", "category": "genre"},
    {"src": "cult_film", "id": "cult_film", "label": "Cult Film", "category": "genre"},
    {"src": "modern_warfare", "id": "modern_warfare", "label": "Modern Warfare", "category": "genre"},
    {"src": "wasteland_road", "id": "wasteland_road", "label": "Wasteland Road", "category": "genre"},
    {"src": "western_cowboy", "id": "western_cowboy", "label": "Western Cowboy", "category": "genre"},
    {"src": "neo_chinese", "id": "neo_chinese", "label": "Neo-Chinese", "category": "expressive"},
    {"src": "high_key_absurd", "id": "high_key_absurd", "label": "High-Key Absurd", "category": "expressive"},
    {"src": "shanghai_animation", "id": "shanghai_animation", "label": "Shanghai Animation", "category": "animation"},
    {"src": "otomo_akira", "id": "otomo_akira", "label": "Otomo Akira", "category": "animation"},
    {"src": "stop_motion", "id": "stop_motion", "label": "Stop Motion", "category": "animation"},
    {"src": "claymation", "id": "claymation", "label": "Claymation", "category": "animation"},
    {"src": "chinese_ink", "id": "chinese_ink", "label": "Chinese Ink", "category": "painting"},
    {"src": "ukiyo_e", "id": "ukiyo_e", "label": "Ukiyo-e", "category": "painting"},
    {"src": "shadow_puppet", "id": "shadow_puppet", "label": "Shadow Puppet", "category": "painting"},
    {"src": "egyptian_mural", "id": "egyptian_mural", "label": "Egyptian Mural", "category": "painting"},
    {"src": "minimal_illustration", "id": "minimal_illustration", "label": "Minimal Illustration", "category": "painting"},
    {"src": "dali_surreal", "id": "dali_surreal", "label": "Dali Surreal", "category": "painting"},
    {"src": "game_concept", "id": "game_concept", "label": "Game Concept", "category": "painting"},
    {"src": "chinese_myth", "id": "chinese_myth", "label": "Chinese Mythology", "category": "myth"},
    {"src": "greek_myth", "id": "greek_myth", "label": "Greek Mythology", "category": "myth"},
    {"src": "western_fantasy", "id": "western_fantasy", "label": "Western Fantasy", "category": "myth"},
]

# Source file name -> output file name. The two batches name the character images differently
# (batch 1: female/male, batch 2: female_young/male_young), so each slot lists several candidate
# names and the first one that exists is used.
SAMPLE_FILES: list[tuple[tuple[str, ...], str]] = [
    (("female.png", "female_young.png"), "female.webp"),
    (("youth.png",), "youth.webp"),
    (("male.png", "male_young.png"), "male.webp"),
    (("elder.png",), "elder.webp"),
]
# locate_cover falls back to "the only PNG left after excluding the character images", so
# the candidate names must be complete.
SAMPLE_SOURCE_NAMES = {name for names, _ in SAMPLE_FILES for name in names}


def clean_style_prompt(raw: str) -> str:
    """Do only two things to a prompt: strip surrounding whitespace and trailing dangling punctuation. Leave everything else untouched."""
    lines = [line.strip() for line in raw.strip().splitlines()]
    text = "\n".join(line for line in lines if line)
    return text.rstrip(TRAILING_PUNCTUATION)


def convert_image(src: Path, dst: Path, *, max_edge: int, quality: int) -> None:
    with Image.open(src) as image:
        rgb = image.convert("RGB")
        width, height = rgb.size
        scale = max_edge / max(width, height)
        if scale < 1:
            rgb = rgb.resize(
                (round(width * scale), round(height * scale)), Image.LANCZOS
            )
        dst.parent.mkdir(parents=True, exist_ok=True)
        rgb.save(dst, "WEBP", quality=quality, method=6)


def locate_style_dir(sources: list[Path], name: str) -> Path:
    """Find the asset folder by style id across all --source directories."""
    for source in sources:
        candidate = source / name
        if candidate.is_dir():
            return candidate
    raise SystemExit(f"Asset folder missing: {name} (searched {[str(s) for s in sources]})")


def locate_cover(style_dir: Path, name: str) -> Path:
    """Find the cover image.

    Normally it is named `<style id>.png`. But in the Feishu export the cover of
    `documentary_realism` was mistakenly named `retro_narrative.png` (the content really is the
    documentary_realism cover, and its md5 differs from the real retro_narrative cover in the
    other batch); the second batch commonly used short names too (`sixties_poster/poster.png`,
    `shanghai_animation/shanghai.png`, `otomo_akira/akira.png`). So fall back to the only
    non-character-sample PNG in the folder. With several candidates, error out rather than guess.
    """
    expected = style_dir / f"{name}.png"
    if expected.is_file():
        return expected

    candidates = sorted(
        path for path in style_dir.glob("*.png") if path.name not in SAMPLE_SOURCE_NAMES
    )
    if len(candidates) == 1:
        return candidates[0]
    raise SystemExit(
        f"Cannot determine cover: {style_dir} (candidates {[path.name for path in candidates]})"
    )


def build(sources: list[Path], out: Path) -> list[dict[str, object]]:
    entries: list[dict[str, object]] = []
    for meta in STYLE_META:
        style_dir = locate_style_dir(sources, meta["src"])

        prompt_file = style_dir / "prompt.txt"
        if not prompt_file.is_file():
            raise SystemExit(f"Prompt missing: {prompt_file}")

        cover_src = locate_cover(style_dir, meta["src"])

        convert_image(
            cover_src,
            out / meta["id"] / "cover.webp",
            max_edge=COVER_MAX_EDGE,
            quality=COVER_QUALITY,
        )

        samples: list[str] = []
        for src_names, dst_name in SAMPLE_FILES:
            sample_src = next(
                (style_dir / src_name for src_name in src_names
                 if (style_dir / src_name).is_file()),
                None,
            )
            if sample_src is None:
                raise SystemExit(
                    f"Sample image missing: none of {' / '.join(src_names)} found in {style_dir}"
                )
            convert_image(
                sample_src,
                out / meta["id"] / dst_name,
                max_edge=SAMPLE_MAX_EDGE,
                quality=SAMPLE_QUALITY,
            )
            samples.append(f"{meta['id']}/{dst_name}")

        entries.append(
            {
                "id": meta["id"],
                "label": meta["label"],
                "category": meta["category"],
                "cover": f"{meta['id']}/cover.webp",
                "samples": samples,
                "style_prompt": clean_style_prompt(
                    prompt_file.read_text(encoding="utf-8")
                ),
            }
        )
    return entries


def render_manifest(entries: list[dict[str, object]], version: str) -> str:
    """The manifest format maps one-to-one to the loader in `novelvideo.freezone.style_templates`."""
    manifest = {"version": version, "templates": entries}
    return json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        required=True,
        action="append",
        type=Path,
        help="Asset directory; may be passed multiple times (once per asset batch)",
    )
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument(
        "--emit-manifest",
        type=Path,
        help="Write the style manifest JSON to this file; print to stdout if omitted",
    )
    parser.add_argument(
        "--manifest-version",
        default=date.today().isoformat(),
        help="Version string written into the manifest; defaults to today's date",
    )
    args = parser.parse_args()

    entries = build(
        [source.expanduser() for source in args.source], args.out.expanduser()
    )
    manifest = render_manifest(entries, args.manifest_version)
    if args.emit_manifest:
        args.emit_manifest.write_text(manifest, encoding="utf-8")
        print(f"Manifest written to {args.emit_manifest}", file=sys.stderr)
    else:
        print(manifest)
    print(f"Processed {len(entries)} styles", file=sys.stderr)


if __name__ == "__main__":
    main()
