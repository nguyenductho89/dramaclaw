"""Voxel screenshot → restyled image using project visual_style preset.

Architecture (after experimentation):
    voxel_shot.png          ← single image input: defines composition + camera
    project.visual_style    ← text: defines visual style (guoman_fantasy / anime / photoreal / etc.)
        ↓ HuiMeng image-2 (1K, low) — cheap + supports single-image edit
    <ts>_styled.png

Why NOT use master.png as a second image ref:
    HuiMeng image-2 rejects array `params.image` (despite docs); image-2-official
    accepts arrays but multi-image fusion makes the model treat master as primary
    and ignore the voxel's composition. Sending voxel ALONE + style as TEXT is
    the only path where composition reliably locks.

Inputs are deliberately minimal:
    - voxel screenshot (required, the camera anchor)
    - project visual_style id (optional, loaded from project_config.json)
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

from novelvideo.config import get_grid_generation_config
from novelvideo.generators.nanobanana_grid import generate_reference_edit_image

_log = logging.getLogger(__name__)

# Cheap defaults. Each restyle = 1 call to image-2 @ 1K low.
# image-2-official supports multi-image (up to 10). image-2 rejects array.
# Default = official so we can send voxel + master pair as "repair" task.
_DEFAULT_SELECTION = os.environ.get("VOXEL_RESTYLE_SELECTION", "huimeng_image2_official")
_DEFAULT_IMAGE_QUALITY = os.environ.get("VOXEL_RESTYLE_QUALITY", "low")
_DEFAULT_IMAGE_SIZE = os.environ.get("VOXEL_RESTYLE_SIZE", "1K")

_PRESETS_DIR = Path(__file__).parent.parent / "styles" / "presets"


def _load_visual_style_preset(style_id: str) -> dict:
    """Read a preset .json from src/novelvideo/styles/presets/."""
    if not style_id:
        return {}
    p = _PRESETS_DIR / f"{style_id}.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _build_prompt(scene_id: str, preset: dict, extra_context: str = "", has_master: bool = False) -> str:
    """Build a Chinese-language "image repair" prompt.

    Empirically validated: HuiMeng image-2-official responds best to a
    repair / inpainting framing — it treats image 1 as the structural source
    to preserve and image 2 as the material reference to match 1:1.

    `has_master`=True means the call site is sending master.png as image 2.
    `has_master`=False falls back to preset style text.
    """
    # Do not fall back to label: the label contains era words (e.g. photoreal period drama), which would push genre content back into the repaint prompt.
    style_tag = preset.get("style_tag") or "PHOTOREALISTIC"
    style_instructions = preset.get("style_instructions") or ""

    scene_line = f"Scene: {scene_id} interior." if scene_id else ""

    if has_master:
        return f"""[Image repair task] Use the material quality of Image 2 (the master reference image) to repair Image 1 (a low-resolution voxel render).

▸ This is image inpainting / image restoration — not regeneration, not a camera change, not fusion.

▸ Image 1 = the damaged image: composition, camera, aspect ratio, and the position and size of every object are all correct, but the surfaces are covered by coarse voxel blocks that must be "repaired" into real materials.
▸ Image 2 = the high-quality reference: it tells you what the result should look like after repair — materials, textures, colors, lighting, prop details, wear/grime.

▸ Hard repair rules (follow strictly, no exceptions):
  1. **Preserve the camera/composition/object positions of Image 1 — do not move a single pixel.**
  2. **Every repaired material must be identical to Image 2**:
     - Whatever tile, wood grain, stainless steel, menu-board paper, red dish-name blocks, or color palette Image 2 has — your output must match Image 2 1:1 in all of these respects.
     - Not "similar in style", not "inspired by" — "exactly the same as the master".
     - Do not invent any material or color that is not in Image 2.
     - Do not change the material saturation, contrast, or texture coarseness of Image 2.
     - Imagine every surface of Image 2 as a texture map, "pasted" onto the geometry of Image 1.

▸ Pixel-level mapping (Image 1 voxels → Image 2 materials):
   · Cyan/dark-blue walls in Image 1 → use the tile texture + grout of Image 2
   · Wood-colored tables, cabinets, benches in Image 1 → use the wood grain of Image 2
   · Gray kitchen counters in Image 1 → use the stainless steel of Image 2
   · Red/blue small stools in Image 1 → use the stool colors and materials of Image 2
   · Beige/red menu boards in Image 1 → use the menu-board paper + font + red blocks of Image 2
   · White strips at the top of Image 1 → use the fluorescent tubes/lights of Image 2

▸ Forbidden:
   · Do not adopt the camera angle of Image 2 (Image 2 provides materials only, not composition)
   · Do not add, remove, or move any object
   · Do not drift material details (if the menu board in Image 2 has a few red blocks, it has exactly that many red blocks)

▸ {scene_line}

▸ Output: one image. The exact composition of Image 1 + the exact materials of Image 2."""

    # No-master fallback: use preset style instructions instead.
    return f"""[Image repair task] Repair Image 1 (a voxel render) into a realistic image in {style_tag} style.

▸ Preserve the composition, camera, and the position and size of every object in Image 1 — do not move a single pixel.
▸ Replace the coarse voxel-block surfaces in Image 1 with real materials (wood, metal, tile, fabric, glass), following this style guide:

STYLE TAG: {style_tag}
{style_instructions}

{scene_line}

▸ Do not change the camera; do not add/remove/move any object.
▸ Output: the exact composition of Image 1, with fine {style_tag}-style materials."""


async def render_voxel_shot_styled(
    voxel_shot_path: Path,
    master_path: Path | None = None,
    reverse_path: Path | None = None,
    *,
    output_path: Path,
    scene_id: str = "",
    visual_style: str = "",
    project_config_path: Path | None = None,
    extra_context: str = "",
    aspect_ratio: str = "16:9",
    image_size: str | None = None,
    selection: str | None = None,
) -> Path:
    """Restyle a voxel screenshot using the project's preset visual style.

    `master_path` / `reverse_path` are accepted for compat with the previous
    signature but are NOT sent as image refs (see module docstring for why).

    Resolution order for `visual_style`:
        1. explicit `visual_style` param
        2. `project_config_path` JSON's `visual_style` field
        3. environment VOXEL_RESTYLE_STYLE
        4. fallback "realistic"
    """
    voxel_shot_path = Path(voxel_shot_path)
    output_path = Path(output_path)
    if not voxel_shot_path.exists():
        raise FileNotFoundError(f"voxel_shot_path does not exist: {voxel_shot_path}")

    # Resolve style id
    style_id = (visual_style or "").strip()
    if not style_id and project_config_path:
        try:
            cfg = json.loads(Path(project_config_path).read_text(encoding="utf-8"))
            style_id = (cfg.get("visual_style") or cfg.get("style") or "").strip()
        except Exception:
            pass
    if not style_id:
        style_id = os.environ.get("VOXEL_RESTYLE_STYLE", "").strip() or "realistic"

    preset = _load_visual_style_preset(style_id)

    # Build image-ref list. Default: voxel + master (repair task).
    # Falls back to single-image (voxel only) when master is unavailable.
    refs = [str(voxel_shot_path)]
    has_master = False
    if master_path and Path(master_path).exists():
        refs.append(str(master_path))
        has_master = True

    prompt = _build_prompt(scene_id, preset, extra_context, has_master=has_master)

    sel = selection or _DEFAULT_SELECTION
    size = image_size or _DEFAULT_IMAGE_SIZE
    quality = _DEFAULT_IMAGE_QUALITY
    config = get_grid_generation_config(
        selection_override=sel,
        image_size_override=size,
    )
    config["openai_image_quality"] = quality
    config["openai_sketch_image_quality"] = quality
    config["huimeng_image_quality"] = quality
    config["image_size"] = size

    _log.info(
        "voxel restyle: voxel=%s master=%s style=%s selection=%s size=%s quality=%s → %s",
        voxel_shot_path.name,
        Path(master_path).name if has_master else "—",
        style_id,
        sel,
        size,
        quality,
        output_path,
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    await generate_reference_edit_image(
        prompt=prompt,
        reference_images=refs,
        output_path=str(output_path),
        aspect_ratio=aspect_ratio,
        image_size=size,
        config=config,
    )
    return output_path


__all__ = ["render_voxel_shot_styled"]
