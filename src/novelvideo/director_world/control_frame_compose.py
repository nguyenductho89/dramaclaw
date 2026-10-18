"""Compose legacy/debug Director Render layers from PlayCanvas raw control PNGs.

PlayCanvas exports three raw frames into
`<control_frames_dir>/ep<NNN>/beat_<MM>/`:

    env_only.png             3GS scene only (no actors / props)
    actor_overlay_black.png  black background + actors / props meshes
    actor_mask.png           white-on-black mask covering actor / prop pixels

The legacy/debug composite is:

    combined = paste(actor_overlay_black, into=env_only, mask=actor_mask)

i.e. wherever the actor mask is opaque, the actor overlay pixels are
copied over the env_only background.

The PlayCanvas stage now writes `combined.png` directly from the live renderer so
viewport occlusion is preserved. This module should write a debug output such as
`combined_layered_debug.png` and refresh helper layers; it should not overwrite
the live `combined.png` during normal export.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from PIL import Image

from novelvideo.director_world.control_frame_layers import create_control_frame_layers


def beat_dir(control_frames_dir: Path, episode: int, beat: int) -> Path:
    return Path(control_frames_dir) / f"ep{int(episode):03d}" / f"beat_{int(beat):02d}"


def _binary_mask(mask_img: Image.Image, *, threshold: int = 8) -> Image.Image:
    """Normalize PlayCanvas mask screenshots to data masks.

    Browser color management/tone mapping can export white emissive mask pixels
    as gray (for example 226). The mask is a data layer, not a beauty layer:
    any visible actor/prop pixel should fully overwrite the environment.
    """

    return mask_img.convert("L").point(lambda p: 255 if p >= threshold else 0)


def compose_combined(
    control_frames_dir: Path,
    episode: int,
    beat: int,
    *,
    output_name: str = "combined.png",
) -> Path:
    target_dir = beat_dir(control_frames_dir, episode, beat)
    env_only_path = target_dir / "env_only.png"
    overlay_path = target_dir / "actor_overlay_black.png"
    mask_path = target_dir / "actor_mask.png"
    if not env_only_path.exists():
        raise FileNotFoundError(f"missing env_only: {env_only_path}")
    if not overlay_path.exists():
        raise FileNotFoundError(f"missing actor_overlay_black: {overlay_path}")
    if not mask_path.exists():
        raise FileNotFoundError(f"missing actor_mask: {mask_path}")

    env_only = Image.open(env_only_path).convert("RGB")
    overlay = Image.open(overlay_path).convert("RGB")
    mask_img = _binary_mask(Image.open(mask_path))

    # Pillow Image.paste with a single-channel mask treats white as 255 (full
    # overwrite) and black as 0 (keep original) — matches our actor_mask
    # convention (white = actor pixels).
    if overlay.size != env_only.size:
        overlay = overlay.resize(env_only.size, Image.LANCZOS)
    if mask_img.size != env_only.size:
        mask_img = mask_img.resize(env_only.size, Image.LANCZOS)
        mask_img = _binary_mask(mask_img)

    composite = env_only.copy()
    composite.paste(overlay, (0, 0), mask_img)

    out_path = target_dir / output_name
    mask_img.save(mask_path, optimize=True)
    composite.save(out_path, optimize=True)
    create_control_frame_layers(target_dir)

    # Mirror env_only → selected_background.png. selected_background.png is this
    # beat's single outward-facing "current background slot"; downstream
    # (sketch_from_context / frame coloring / freezone canvas projection)
    # all read from here.
    # env_only.png is kept as an internal input artifact of the compose pipeline
    # (control_frame_layers etc. still read it directly), but the user/freezone
    # view of the "current background" is this mirrored selected_background.png.
    # That way the cropper paths (master/reverse/360-snap/3GS director-desk export)
    # and the director compose path all write the same canonical slot, avoiding
    # the consistency problems of keeping two copies side by side.
    selected_bg_path = target_dir / "selected_background.png"
    try:
        shutil.copyfile(env_only_path, selected_bg_path)
    except Exception:
        # Do not block the main compose flow; combined.png stays usable even if the mirror fails.
        # When downstream readers cannot get selected_background they naturally fall back to the old value or a missing state.
        pass

    return out_path


def _cli() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--control-frames-dir", required=True)
    parser.add_argument("--episode", type=int, required=True)
    parser.add_argument("--beat", type=int, required=True)
    parser.add_argument("--output-name", default="combined.png")
    args = parser.parse_args()

    try:
        out = compose_combined(
            Path(args.control_frames_dir),
            args.episode,
            args.beat,
            output_name=args.output_name,
        )
    except Exception as e:
        json.dump({"ok": False, "error": str(e)}, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return 1
    json.dump({"ok": True, "path": str(out)}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
