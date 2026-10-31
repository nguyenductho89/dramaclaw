"""A/B harness for the Qwen-Image 2.1 render (`runpod_qwen21_render`): base vs LoRA
variants on the same inputs with fixed seeds, for judging pose and identity.

Runs INSIDE the dramaclaw-api container (it needs the project data, boto3 and the
R2/RunPod env). Nothing in `.env` or the running API is changed: the endpoint and
LoRA settings are overridden for this process only.

    docker cp scripts/qwen_render_ab.py dramaclaw-api-1:/tmp/
    docker exec dramaclaw-api-1 /app/.venv/bin/python /tmp/qwen_render_ab.py \\
        --project YuiDrama --beats 10 12 --variants base40,turbo8 --seeds 1234 5678
    docker cp dramaclaw-api-1:/tmp/qwen_render_ab ./output/qwen_render_ab
    uv run scripts/face_similarity.py <identity-sheet.png> output/qwen_render_ab/*.png

Inputs per beat mirror the real render: sketch (`<image1>`), the identity sheet's
face close-up (`<image2>`), the scene master (`<image3>`) and the whole sheet for the
outfit (`<image4>`), with the same prompt `build_qwen21_render_prompt` produces.
The LoRA files must exist on the volume's `models/loras/` AND the target endpoint
must map `loras` (the H3 endpoints do through COMFY_EXTRA_ARGS; the Qwen-only image's
baked yaml does not), hence `--endpoint` defaults to the H3 endpoint.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
from pathlib import Path

# name -> (lora file under models/loras, steps). Empty lora = the production recipe.
VARIANTS = {
    "base40": ("", 40),
    "turbo8": ("qwen_image_2.1_turbo_lora_avg_rank_178_bf16.safetensors", 8),
    "pruna8": ("p_q_image_2.1_8_steps_v0.1_comfyui_bf16.safetensors", 8),
    "pruna6": ("p_q_image_2.1_6_steps_v0.2_comfyui_bf16.safetensors", 6),
}


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--project", required=True, help="project name, e.g. YuiDrama")
    p.add_argument("--user", default="local")
    p.add_argument("--episode", type=int, default=1)
    p.add_argument("--beats", type=int, nargs="+", required=True)
    p.add_argument("--variants", default="base40,turbo8", help=f"comma list of {sorted(VARIANTS)}")
    p.add_argument("--seeds", type=int, nargs="+", default=[1234])
    p.add_argument("--endpoint", default="a31613hf7l83r5", help="RunPod endpoint id that maps `loras`")
    p.add_argument("--out", default="/tmp/qwen_render_ab")
    return p.parse_args(argv)


def find_identity_sheet(root: Path, identity_id: str) -> Path | None:
    """`Yui_edo_kosode` -> assets/characters/Yui/identities/edo_kosode.png"""
    chars = root / "assets" / "characters"
    for char_dir in sorted(chars.iterdir()) if chars.is_dir() else []:
        prefix = f"{char_dir.name}_"
        if identity_id.startswith(prefix):
            candidate = char_dir / "identities" / f"{identity_id[len(prefix):]}.png"
            if candidate.is_file():
                return candidate
    return None


async def main(args) -> int:
    os.environ["RUNPOD_QWEN_IMAGE_ENDPOINT_ID"] = args.endpoint
    from novelvideo import config
    from novelvideo.api.deps import make_sqlite_store
    from novelvideo.generators import nanobanana_grid as grid
    from novelvideo.generators.prompt_builder import build_qwen21_render_prompt

    unknown = [v for v in args.variants.split(",") if v not in VARIANTS]
    if unknown:
        print(f"unknown variants: {unknown}", file=sys.stderr)
        return 2

    root = Path(f"/data/output/{args.user}/{args.project}")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    store = await make_sqlite_store(args.user, args.project)
    beats = {b["beat_number"]: b for b in await store.get_beats_as_dicts(args.episode)}

    for number in args.beats:
        beat = beats[number]
        identities = [i for i in beat.get("detected_identities") or [] if i != "__NO_CHARACTER__"]
        if len(identities) != 1:
            print(f"beat {number}: needs exactly one identity (single-character path), got {identities}")
            continue
        sheet_path = find_identity_sheet(root, identities[0])
        scene_id = (beat.get("scene_ref") or {}).get("scene_id") or ""
        sketch_path = root / "sketches" / f"ep{args.episode:03d}" / f"beat_{number:02d}.png"
        scene_path = root / "assets" / "scenes" / scene_id / "master.png"
        missing = [str(p) for p in (sheet_path, sketch_path, scene_path) if not p or not Path(p).is_file()]
        if missing:
            print(f"beat {number}: missing inputs {missing}")
            continue
        sheet = sheet_path.read_bytes()
        face = grid._qwen21_face_panel_bytes(sheet)
        prompt = build_qwen21_render_prompt(
            [beat], stage="full", scene_reference=True, identity_sheet=face is not None
        )
        refs = [
            ("ref_0.png", sketch_path.read_bytes(), "image/png"),
            ("ref_1.png", face or sheet, "image/png"),
            ("ref_2.png", scene_path.read_bytes(), "image/png"),
        ]
        if face is not None:
            refs.append(("ref_3.png", sheet, "image/png"))
        for name in args.variants.split(","):
            lora, steps = VARIANTS[name]
            for seed in args.seeds:
                tag = f"beat{number}_{name}_s{seed}"
                config.RUNPOD_QWEN21_RENDER_SEED = str(seed)
                config.RUNPOD_QWEN21_RENDER_LORA = lora
                config.RUNPOD_QWEN21_RENDER_LORA_STEPS = steps
                started = time.time()
                data, _text, error = await grid._call_runpod_qwen21_render_image_api(
                    api_key=config.RUNPOD_API_KEY,
                    model="qwen-image-2.1",
                    prompt=prompt,
                    reference_images=refs,
                )
                if data:
                    (out / f"{tag}.png").write_bytes(data)
                status = "OK" if data else f"FAIL {str(error)[:200]}"
                print(f"{tag}: {status} {time.time() - started:.0f}s", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(parse_args())))
