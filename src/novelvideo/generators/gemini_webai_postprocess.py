# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Remove Gemini's visible sparkle watermark from a WebAI-generated image.

Ported from `previs_h3_test/scripts/gemini_webai_images.py` (2026-11-09) so the
app's Freezone image path can reuse the exact detector the previs CLI validated
against 14 real generations. SynthID (Google's invisible watermark) is
deliberately untouched — only the visible UI overlay is inpainted.

Like `gemini_webai_client`, this module has **no top-level `novelvideo` import**
so the previs CLI can load it by path. `cv2` is imported lazily and its absence
degrades to "return the image unchanged", because `opencv-python-headless` is
NOT a declared dependency of this project (see pyproject.toml — numpy and Pillow
are): the app only calls this when `GEMINI_WEBAI_REMOVE_WATERMARK` is on, and
that flag defaults to off precisely so a missing OpenCV can never break image
generation.

Empirical reasoning behind every constant below, from the 2026-11-09 watermark
entry of `previs_h3_test/science_humor_gravity_test_run.md`:

- The watermark lands at a near-FIXED absolute position on a 1344x768 canvas
  regardless of image content (hand-measured in 6+ unrelated images, all within
  ~15px of WATERMARK_CENTER) — it is a UI overlay, not content-aware placement.
  Detection is therefore anchored to a small window around that centre, NOT a
  free search: an earlier whole-image search found confident-looking but WRONG
  matches on organic texture (grass, lunar regolith), since a soft radial blob
  coincidentally matches natural photo noise.
- On Moon-themed images, grayscale matching scores POORLY even AT the
  hand-confirmed exact location (~-0.3): regolith's fine speckle swamps the weak
  semi-transparent overlay's correlation signal. Those images fall through to
  the "low confidence, leave unchanged" path and need a human to check them.
  This is a known limitation, not a bug to chase.
- Removal uses a shape-fitted mask (the icon's bright core, slightly dilated —
  not a filled rectangle) with a small inpaint radius: a full rectangular mask
  let `cv2.inpaint` bleed nearby strongly-coloured content into the hole, and a
  larger radius created a cross-hatch artifact over fine repetitive texture. An
  algebraic "unscreen" correction was also tried and is cleaner in principle but
  proved too sensitive to sub-pixel misalignment, leaving a faint ghost.
"""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

WATERMARK_TEMPLATE = Path(__file__).resolve().parent / "assets" / "gemini_watermark_template.png"
WATERMARK_CENTER = (1240, 650)  # (x, y) on a 1344x768 canvas
WATERMARK_WINDOW = (90, 90)  # half-extent of the search box around WATERMARK_CENTER
WATERMARK_SCALES = tuple(round(0.85 + 0.02 * i, 2) for i in range(16))  # 0.85..1.15 step 0.02
WATERMARK_SCORE_MIN = 0.45
WATERMARK_ALPHA_THRESHOLD = 0.04  # template pixels lighter than this fraction above background count as "icon"
WATERMARK_MASK_DILATE = 9  # px, grows the shape mask past the alpha threshold to cover soft edge falloff
WATERMARK_INPAINT_RADIUS = 4


def _watermark_shape_mask(template_gray):
    """The icon's own silhouette (not its bounding rectangle): template pixels raised
    WATERMARK_ALPHA_THRESHOLD above the template's own background level, dilated a little to
    cover the soft edge falloff. A shape mask keeps the inpainted hole small, which matters
    twice over — see the module docstring."""
    import cv2
    import numpy as np

    corner = np.concatenate(
        [
            template_gray[:15, :15].ravel(),
            template_gray[:15, -15:].ravel(),
            template_gray[-15:, :15].ravel(),
            template_gray[-15:, -15:].ravel(),
        ]
    ).astype(np.float32)
    bg_level = float(np.median(corner))
    alpha = (template_gray.astype(np.float32) - bg_level) / (255.0 - bg_level)
    mask = (alpha > WATERMARK_ALPHA_THRESHOLD).astype(np.uint8) * 255
    return cv2.dilate(mask, np.ones((WATERMARK_MASK_DILATE, WATERMARK_MASK_DILATE), np.uint8))


def remove_gemini_watermark(im, label: str = ""):
    """Find and inpaint Gemini's visible sparkle watermark in a PIL image.

    Returns `im` unchanged (never raises) when OpenCV is missing, the template is
    missing, or the best match scores below WATERMARK_SCORE_MIN — guessing at a
    weak match is worse than leaving a small watermark in a previs frame.
    """
    try:
        import cv2
        import numpy as np
        from PIL import Image
    except ImportError as exc:
        logger.warning("gemini watermark removal skipped (%s); install opencv-python-headless", exc)
        return im

    if not WATERMARK_TEMPLATE.exists():
        logger.warning("gemini watermark template missing at %s, skipping", WATERMARK_TEMPLATE)
        return im
    template_gray = cv2.cvtColor(cv2.imread(str(WATERMARK_TEMPLATE)), cv2.COLOR_BGR2GRAY)
    th, tw = template_gray.shape
    shape_mask_template = _watermark_shape_mask(template_gray)

    arr = cv2.cvtColor(np.array(im.convert("RGB")), cv2.COLOR_RGB2BGR)
    h, w = arr.shape[:2]
    cx, cy = WATERMARK_CENTER
    wx, wy = WATERMARK_WINDOW
    rx0, ry0 = max(0, cx - wx), max(0, cy - wy)
    rx1, ry1 = min(w, cx + wx), min(h, cy + wy)
    if rx1 - rx0 < 4 or ry1 - ry0 < 4:
        logger.warning("gemini watermark search window falls outside a %dx%d image, skipping", w, h)
        return im
    region_gray = cv2.cvtColor(arr[ry0:ry1, rx0:rx1], cv2.COLOR_BGR2GRAY)

    best = (-1.0, None, None)
    for scale in WATERMARK_SCALES:
        tw_s, th_s = round(tw * scale), round(th * scale)
        if tw_s > region_gray.shape[1] or th_s > region_gray.shape[0] or tw_s < 4 or th_s < 4:
            continue
        tmpl_s = cv2.resize(template_gray, (tw_s, th_s))
        res = cv2.matchTemplate(region_gray, tmpl_s, cv2.TM_CCOEFF_NORMED)
        _, maxval, _, maxloc = cv2.minMaxLoc(res)
        if maxval > best[0]:
            best = (maxval, maxloc, (tw_s, th_s))
    score, loc, size = best
    tag = f" ({label})" if label else ""
    if loc is None or score < WATERMARK_SCORE_MIN:
        logger.info(
            "gemini watermark: no confident match%s (best score %.2f < %s), leaving image as-is",
            tag,
            score,
            WATERMARK_SCORE_MIN,
        )
        return im

    bx0, by0 = rx0 + loc[0], ry0 + loc[1]
    bx1, by1 = bx0 + size[0], by0 + size[1]
    shape_mask = cv2.resize(shape_mask_template, size, interpolation=cv2.INTER_NEAREST)
    full_mask = np.zeros((h, w), dtype=np.uint8)
    full_mask[by0:by1, bx0:bx1] = shape_mask
    cleaned = cv2.inpaint(arr, full_mask, inpaintRadius=WATERMARK_INPAINT_RADIUS, flags=cv2.INPAINT_TELEA)
    logger.info(
        "gemini watermark: inpainted%s at (%d,%d)-(%d,%d), score %.2f", tag, bx0, by0, bx1, by1, score
    )
    return Image.fromarray(cv2.cvtColor(cleaned, cv2.COLOR_BGR2RGB))


def remove_gemini_watermark_bytes(data: bytes, label: str = "") -> bytes:
    """Byte-in/byte-out wrapper for callers holding encoded image data (the app's
    image path). Returns `data` unchanged on any failure, for the same reason as
    `remove_gemini_watermark`."""
    import io

    try:
        from PIL import Image
    except ImportError:
        return data
    try:
        im = Image.open(io.BytesIO(data))
        cleaned = remove_gemini_watermark(im, label)
        if cleaned is im:
            return data
        buf = io.BytesIO()
        cleaned.save(buf, "PNG")
        return buf.getvalue()
    except Exception as exc:  # pragma: no cover - defensive, never fail a generation on cleanup
        logger.warning("gemini watermark removal failed (%s), keeping original bytes", exc)
        return data
