# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Turn Freezone's red-highlight annotation mask into a real binary latent mask.

Freezone's three mask producers (`RedrawOverlay`, `EraseOverlay`, `MaskEditor`)
all export the same PNG via `frontend/src/lib/mask-highlight.ts`:
**the source image with a uniform translucent red overlay** on the painted
region. That format exists for vision models — red marks *where* to work while
the surrounding RGB still carries real content — and every provider without a
latent mask keeps using it unchanged.

It cannot be fed to ComfyUI as a mask. Both RunPod Qwen graphs read the mask
with `ImageToMask(channel="red")` (`nanobanana_grid.py:5554` and `:5793`), so a
blue sky, a red jacket or lit skin would all be read as "regenerate this" — the
unpainted majority of the frame would be denoised. Hence this derivation step.

**The blend is exact and known**, which is what makes recovery reliable rather
than a guess. `buildRedHighlightMaskBlob` draws the base image, then composites
an overlay that `binarizeMaskToRed` has already flattened to a *constant*
rgba(255, 0, 0, 153) — never the brush's own uneven alpha. Standard source-over
with a = 153/255 = 0.6 therefore gives, per channel:

    painted_R = base_R * 0.4 + 153
    painted_G = base_G * 0.4
    painted_B = base_B * 0.4
    unpainted = base, bit for bit

So a pixel is painted iff it matches the first form and not the second.

Ambiguity, deliberately resolved toward "keep": a base pixel that is already
exactly (255, 0, 0) maps to itself under the blend, so painted and unpainted are
indistinguishable there. Such pixels are classified **unpainted** — leaving a
few saturated-red pixels untouched is a far smaller error than denoising a
region the user never painted. `grow_px` recovers them when they sit inside a
painted area, since the dilation pulls the surrounding painted verdict over them.
"""

from __future__ import annotations

import io
import logging

logger = logging.getLogger(__name__)

# Mirrors MASK_HIGHLIGHT_RGBA in frontend/src/lib/mask-highlight.ts — if that
# constant ever changes, this one must change with it or every derived mask
# silently becomes empty (and `red_highlight_to_binary_mask` will raise rather
# than render an unmasked full-denoise).
MASK_HIGHLIGHT_RGBA = (255, 0, 0, 153)

# Providers whose ComfyUI graph has a real SetLatentNoiseMask input
# (`mask_name` in `_runpod_qwen_edit_image_graph` / `_runpod_qwen21_render_image_graph`).
# Everything else — newapi, huimeng, openai, openrouter, gemini_webai — only ever
# sees the red-highlight annotation as a second reference image.
LATENT_MASK_PROVIDERS = frozenset({"runpod_qwen_edit", "runpod_qwen21_render"})


class MaskDerivationError(ValueError):
    """The uploaded highlight PNG is not a red-highlight overlay of this base image.

    Raised instead of returning an empty mask: an all-zero mask reaching
    `SetLatentNoiseMask` denoises nothing, but a mask that is wrong in the other
    direction repaints the whole frame — and silently handing back "no edit"
    would look like the inpaint simply did not work.
    """


def provider_supports_latent_mask(provider: str | None) -> bool:
    """True when `provider`'s graph can take a real binary mask."""
    return str(provider or "").strip().lower() in LATENT_MASK_PROVIDERS


def red_highlight_to_binary_mask(
    base_bytes: bytes,
    highlight_bytes: bytes,
    *,
    tolerance: int = 24,
    grow_px: int = 0,
) -> bytes:
    """Derive an L-mode PNG mask (255 = regenerate, 0 = keep) from the base image
    and Freezone's red-highlight overlay of it.

    `tolerance` absorbs PNG round-tripping and the brush's anti-aliased rim, whose
    pixels land between the two exact states. `grow_px` dilates the result with
    `MaxFilter`, the same widening the beat-render path applies to its own masks
    (`nanobanana_grid.py:6991`) — a slightly generous mask edge blends, a slightly
    tight one leaves a seam.

    Raises `MaskDerivationError` when the two images disagree in size, when no
    pixel is painted, or when the differing pixels do not follow the blend (the
    tell-tale of a highlight uploaded against a since-edited base).
    """
    import numpy as np
    from PIL import Image

    try:
        base_im = Image.open(io.BytesIO(base_bytes)).convert("RGB")
        high_im = Image.open(io.BytesIO(highlight_bytes)).convert("RGB")
    except Exception as exc:
        raise MaskDerivationError(f"cannot read mask images: {exc}") from exc

    if base_im.size != high_im.size:
        # The overlay is always produced at the mask canvas size, which is the
        # displayed source size; a mismatch means the two came from different images.
        raise MaskDerivationError(
            f"mask does not match source: base is {base_im.size[0]}x{base_im.size[1]}, "
            f"mask is {high_im.size[0]}x{high_im.size[1]}"
        )

    base = np.asarray(base_im, dtype=np.int16)
    high = np.asarray(high_im, dtype=np.int16)

    r, g, b, a = MASK_HIGHLIGHT_RGBA
    alpha = a / 255.0
    expected = base * (1.0 - alpha) + np.array([r, g, b], dtype=np.float32) * alpha

    # Nearest-of-the-two, not two independent thresholds. A base pixel that is
    # already reddish lands close to BOTH states — e.g. a (220, 40, 30) jacket
    # blends to (241, 16, 12), only 24 away from itself — so an absolute
    # "within tolerance of base ⇒ unpainted" test discards genuinely painted
    # pixels over exactly the red-dominant content this derivation exists to
    # protect. Comparing distances keeps the verdict correct wherever the two
    # states are distinguishable at all, and ties (base already == the overlay
    # colour) fall to "keep", per the module docstring.
    dist_painted = np.abs(high - expected).max(axis=2)
    dist_base = np.abs(high - base).max(axis=2)
    painted = (dist_painted <= tolerance) & (dist_painted < dist_base)
    matches_base = dist_base <= tolerance

    if not painted.any():
        differing = int((~matches_base).sum())
        if differing == 0:
            raise MaskDerivationError(
                "mask has no painted region: the uploaded mask is identical to the source image"
            )
        raise MaskDerivationError(
            "mask does not match source: "
            f"{differing} pixel(s) differ from the base image but none follow the "
            "red-highlight blend (was the source edited after the mask was drawn?)"
        )

    mask_im = Image.fromarray((painted * 255).astype(np.uint8)).convert("L")
    if grow_px > 0:
        from PIL import ImageFilter

        mask_im = mask_im.filter(ImageFilter.MaxFilter(2 * grow_px + 1))

    logger.info(
        "derived latent mask: %d/%d px painted (%.1f%%), grow=%d",
        int(painted.sum()),
        painted.size,
        100.0 * float(painted.sum()) / float(painted.size),
        grow_px,
    )
    buf = io.BytesIO()
    mask_im.save(buf, "PNG")
    return buf.getvalue()
