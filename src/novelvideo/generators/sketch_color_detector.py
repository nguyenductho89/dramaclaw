"""Sketch color detection and annotation module.

Detects which palette colors actually appear in a sketch, used to:
1. Filter out characters that are absent from the render prompt
2. Annotate character identities when exporting previews
3. Annotate beat number + character identity in the zoomed-in grid view
"""

import colorsys
from pathlib import Path
from typing import Optional

import numpy as np
from PIL import Image, ImageDraw, ImageFont


def _hex_to_hsv(hex_code: str) -> tuple[float, float, float]:
    """Convert #RRGGBB to HSV (h: 0-360, s: 0-1, v: 0-1)."""
    hex_code = hex_code.lstrip("#")
    r = int(hex_code[0:2], 16) / 255
    g = int(hex_code[2:4], 16) / 255
    b = int(hex_code[4:6], 16) / 255
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    return h * 360, s, v


def detect_sketch_colors(
    image_path: str,
    color_map: dict[str, str],
    threshold: float = 0.008,
    region: tuple[int, int, int, int] = None,
    verbose: bool = False,
    verbose_label: str = "",
) -> set[str]:
    """Detect which palette colors actually appear in the image; return the set of keys present.

    Args:
            image_path: image path
            color_map: {identity_id: "#HEX COLOR_NAME"} mapping
            threshold: minimum ratio of color pixels to total pixels (default 1%)
            region: optional crop region (left, top, right, bottom)

    Returns:
            Set of identity_ids present in the image
    """
    img = Image.open(image_path).convert("RGB")
    if region:
        img = img.crop(region)

    pixels = np.array(img).reshape(-1, 3).astype(np.float32) / 255.0

    # Convert to HSV
    # vectorized rgb_to_hsv
    r, g, b = pixels[:, 0], pixels[:, 1], pixels[:, 2]
    maxc = np.maximum(np.maximum(r, g), b)
    minc = np.minimum(np.minimum(r, g), b)
    diff = maxc - minc

    # Exclude black/white/gray/dark pixels (plain gray lines diff~0.02, light color blocks diff~0.08-0.15, saturated color blocks diff>0.22)
    mask = (maxc > 0.15) & (minc < 0.85) & (diff > 0.06)
    if mask.sum() == 0:
        return set()

    # Compute hue (valid pixels only)
    r_m, g_m, b_m = r[mask], g[mask], b[mask]
    maxc_m, diff_m = maxc[mask], diff[mask]

    hue = np.zeros(r_m.shape)
    sat = diff_m / (maxc_m + 1e-10)
    val = maxc_m

    red_mask = maxc_m == r_m
    green_mask = (~red_mask) & (maxc_m == g_m)
    blue_mask = (~red_mask) & (~green_mask)

    hue[red_mask] = (60 * ((g_m[red_mask] - b_m[red_mask]) / (diff_m[red_mask] + 1e-10))) % 360
    hue[green_mask] = 60 * (2 + (b_m[green_mask] - r_m[green_mask]) / (diff_m[green_mask] + 1e-10))
    hue[blue_mask] = 60 * (4 + (r_m[blue_mask] - g_m[blue_mask]) / (diff_m[blue_mask] + 1e-10))
    hue = hue % 360

    total_pixels = len(pixels)
    detected = set()
    hue_tolerance = 25.0

    for key, color_str in color_map.items():
        parts = color_str.split(" ", 1)
        hex_code = parts[0]
        target_h, target_s, target_v = _hex_to_hsv(hex_code)

        # Hue circle distance
        hue_diff = np.minimum(np.abs(hue - target_h), 360 - np.abs(hue - target_h))

        # Saturation + value tolerance (the same character may be drawn lighter/darker in a sketch)
        sat_diff = np.abs(sat - target_s)
        val_diff = np.abs(val - target_v)

        matching = (hue_diff < hue_tolerance) & (sat_diff < 0.55) & (val_diff < 0.45)
        ratio = matching.sum() / total_pixels

        if verbose:
            mark = "✓" if ratio >= threshold else "✗"
            prefix = f"[sketch_detect] {verbose_label} " if verbose_label else "[sketch_detect] "
            color_name = parts[1] if len(parts) > 1 else ""
            hsv_info = f"target=({target_h:.0f}°,{target_s:.2f},{target_v:.2f})"
            print(f"{prefix}{key}: ratio={ratio:.4f} {mark}  {hex_code} {color_name} {hsv_info}")

        if ratio >= threshold:
            detected.add(key)

    return detected


def detect_sketch_colors_per_panel(
    image_path: str,
    color_map: dict[str, str],
    rows: int,
    cols: int,
    beat_numbers: list[int] = None,
    threshold: float = 0.008,
) -> dict[int, set[str]]:
    """Detect colors separately for each panel of a grid image.

    Returns:
        {panel_index_or_beat_number: set_of_detected_identity_ids}
    """
    img = Image.open(image_path).convert("RGB")
    w, h = img.size
    panel_w = w // cols
    panel_h = h // rows

    result = {}
    for i in range(rows * cols):
        r_idx = i // cols
        c_idx = i % cols
        region = (c_idx * panel_w, r_idx * panel_h, (c_idx + 1) * panel_w, (r_idx + 1) * panel_h)
        key = beat_numbers[i] if beat_numbers and i < len(beat_numbers) else i
        result[key] = detect_sketch_colors(
            image_path, color_map, threshold=threshold, region=region,
            verbose=True, verbose_label=f"B{key}",
        )

    return result


def annotate_sketch_with_identities(
    image_path: str,
    color_map: dict[str, str],
    beat_numbers: list[int] = None,
    rows: int = 1,
    cols: int = 1,
    output_path: str = None,
    tag_map: dict[str, str] = None,
    per_panel_identities: list[list[str]] = None,
) -> str:
    """Annotate detected character identities on a copy of the sketch. The original image is not modified.

    Each panel:
    - Top left: B{n} (beat number)
    - Top right: detected character color swatch + char tag

    Args:
            image_path: sketch path
        color_map: {identity_id: "#HEX COLOR_NAME"}
            beat_numbers: list of beat numbers, one per panel
            rows: number of grid rows
            cols: number of grid columns
            output_path: output path; auto-generated when None
            tag_map: {identity_id: "[TAG]"} character tag mapping

    Returns:
            Path of the annotated image
    """
    img = Image.open(image_path).convert("RGB")
    annotated = img.copy()
    draw = ImageDraw.Draw(annotated)

    w, h = img.size
    panel_w = w // cols
    panel_h = h // rows

    font_size = max(14, min(panel_w, panel_h) // 10)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", font_size)
    except (OSError, IOError):
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", font_size)
        except (OSError, IOError):
            font = ImageFont.load_default()

    small_font_size = max(11, font_size * 3 // 4)
    try:
        small_font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", small_font_size)
    except (OSError, IOError):
        try:
            small_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", small_font_size)
        except (OSError, IOError):
            small_font = ImageFont.load_default()

    for i in range(rows * cols):
        r_idx = i // cols
        c_idx = i % cols
        px = c_idx * panel_w
        py = r_idx * panel_h
        region = (px, py, px + panel_w, py + panel_h)

        # Top left: beat number
        if beat_numbers and i < len(beat_numbers):
            label = f"B{beat_numbers[i]}"
            x, y = px + 4, py + 2
            for dx, dy in [(-1, -1), (-1, 1), (1, -1), (1, 1), (-2, 0), (2, 0), (0, -2), (0, 2)]:
                draw.text((x + dx, y + dy), label, fill="black", font=font)
            draw.text((x, y), label, fill="white", font=font)

        # Top right: character swatch + identity name (prefer existing detected_identities)
        if per_panel_identities is not None and i < len(per_panel_identities):
            detected = per_panel_identities[i]
        else:
            detected = detect_sketch_colors(image_path, color_map, threshold=0.01, region=region)
        if detected:
            tag_x = px + panel_w - 6  # start from the right edge
            tag_y = py + 4
            for identity_id in sorted(detected):
                color_str = color_map.get(identity_id, "")
                if not color_str:
                    continue
                parts = color_str.split(" ", 1)
                hex_code = parts[0]
                color_name = parts[1] if len(parts) > 1 else ""

                # Show char tag (ASCII, renderable by PIL)
                display_name = (tag_map or {}).get(identity_id, identity_id)

                text = f" {display_name} "
                bbox = draw.textbbox((0, 0), text, font=small_font)
                text_w = bbox[2] - bbox[0]
                text_h = bbox[3] - bbox[1]

                # Swatch position (right-aligned)
                block_x = tag_x - text_w - 14
                block_y = tag_y

                # Rounded-rectangle swatch
                swatch_size = text_h
                draw.rounded_rectangle(
                    [block_x, block_y, block_x + swatch_size, block_y + swatch_size],
                    radius=3, fill=hex_code, outline="white", width=1,
                )

                # Text (black outline + white)
                tx = block_x + swatch_size + 2
                ty = block_y
                for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                    draw.text((tx + dx, ty + dy), text, fill="black", font=small_font)
                draw.text((tx, ty), text, fill="white", font=small_font)

                tag_y += text_h + 4

    if output_path is None:
        p = Path(image_path)
        output_path = str(p.with_name(f"{p.stem}_annotated{p.suffix}"))

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    annotated.save(output_path, quality=90)
    return output_path
