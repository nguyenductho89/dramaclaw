"""Grid splitting utility module.

Splits a 5x5 grid image into 25 individual storyboard shots.
"""

import io
import os
from pathlib import Path
from typing import List, Optional, Tuple, Union

import numpy as np
from PIL import Image


def _trim_outer_border(
    img: Image.Image,
    gray: np.ndarray,
    brightness_threshold: int = 220,
    min_content_ratio: float = 0.15,
) -> Tuple[Image.Image, np.ndarray]:
    """Detect and crop the outer white border of the whole image.

    Scan inward from the four edges; a row/column is considered to have reached the content area
    when its proportion of dark pixels (< threshold) exceeds min_content_ratio.

    Note: threshold is set to 220 rather than 240, because the brightness of JPEG-compressed white borders
    fluctuates between 235-245, and using 240 would misclassify ~30% of border pixels as dark.
    220 cleanly separates white borders (dark<220 ~ 0) from content (dark<220 > 0.9).

    Returns: (cropped_img, cropped_gray)
    """
    h, w = gray.shape

    # Scan downward from the top
    top = 0
    for y in range(h):
        dark_ratio = np.mean(gray[y, :] < brightness_threshold)
        if dark_ratio >= min_content_ratio:
            top = y
            break

    # Scan upward from the bottom
    bottom = h
    for y in range(h - 1, -1, -1):
        dark_ratio = np.mean(gray[y, :] < brightness_threshold)
        if dark_ratio >= min_content_ratio:
            bottom = y + 1
            break

    # Scan rightward from the left
    left = 0
    for x in range(w):
        dark_ratio = np.mean(gray[:, x] < brightness_threshold)
        if dark_ratio >= min_content_ratio:
            left = x
            break

    # Scan leftward from the right
    right = w
    for x in range(w - 1, -1, -1):
        dark_ratio = np.mean(gray[:, x] < brightness_threshold)
        if dark_ratio >= min_content_ratio:
            right = x + 1
            break

    # Safety check: the cropped amount should not exceed 5% per side (but allow at least 30px to support small panels)
    max_trim = max(max(w, h) * 0.05, 30)
    if top > max_trim:
        top = 0
    if h - bottom > max_trim:
        bottom = h
    if left > max_trim:
        left = 0
    if w - right > max_trim:
        right = w

    if top > 0 or bottom < h or left > 0 or right < w:
        print(f"[GridSplitter] Outer border trimmed: "
              f"top={top}, bottom={h-bottom}, left={left}, right={w-right}")
        cropped = img.crop((left, top, right, bottom))
        return cropped, np.array(cropped.convert("L"))

    return img, gray


def remove_grid_gaps(
    grid_image: Image.Image,
    rows: int,
    cols: int,
    search_radius: int = 15,
    gap_brightness_threshold: int = 200,
    min_gap_width: int = 2,
) -> Image.Image:
    """Detect and remove blank/shadow gaps between panels in a grid image.

    Algorithm:
    1. Convert the image to a grayscale numpy array
    2. Scan within +/-search_radius of each expected divider line to find the brightest contiguous pixel band (gap)
    3. Crop out each panel (excluding gap pixels)
    4. Resize all panels to the same size and stitch them seamlessly

    Args:
        grid_image: PIL Image object
        rows: number of grid rows
        cols: number of grid columns
        search_radius: pixel radius to search around the expected divider line
        gap_brightness_threshold: pixels brighter than this are considered possible gap
        min_gap_width: minimum gap width (pixels); anything narrower is ignored

    Returns:
        The processed seamless PIL Image
    """
    if rows <= 1 and cols <= 1:
        return grid_image

    width, height = grid_image.size
    gray = np.array(grid_image.convert("L"))

    # Crop the outer white border
    grid_image, gray = _trim_outer_border(grid_image, gray)
    width, height = grid_image.size

    def _find_gap_range(arr_2d: np.ndarray, expected_pos: int, axis: int) -> Tuple[int, int]:
        """Find the start and end of the gap near the expected divider line.

        Args:
            arr_2d: grayscale array
            expected_pos: expected divider position
            axis: 0=horizontal line (scan along y), 1=vertical line (scan along x)

        Returns:
            (gap_start, gap_end); returns (expected_pos, expected_pos) if no gap is found
        """
        dim_size = arr_2d.shape[1] if axis == 1 else arr_2d.shape[0]
        lo = max(0, expected_pos - search_radius)
        hi = min(dim_size, expected_pos + search_radius + 1)

        # Compute the mean brightness of each line within the search range
        if axis == 1:  # vertical line: average each column along the row direction
            brightness = np.mean(arr_2d[:, lo:hi], axis=0)
        else:  # horizontal line: average each row along the column direction
            brightness = np.mean(arr_2d[lo:hi, :], axis=1)

        # Find contiguous regions whose brightness exceeds the threshold
        is_bright = brightness >= gap_brightness_threshold
        if not np.any(is_bright):
            # No obvious bright gap; fall back to the region with the lowest variance
            # Low variance means uniform color (possibly a solid-color gap)
            if axis == 1:
                variance = np.var(arr_2d[:, lo:hi].astype(float), axis=0)
            else:
                variance = np.var(arr_2d[lo:hi, :].astype(float), axis=1)

            # Look near the lowest-variance position
            min_var_idx = np.argmin(variance)
            center = lo + min_var_idx

            # Expand to both sides to find the contiguous low-variance region
            var_threshold = max(variance[min_var_idx] * 3, 100)  # variance threshold
            gap_start = center
            gap_end = center

            while gap_start > lo and variance[gap_start - lo - 1] < var_threshold:
                gap_start -= 1
            while gap_end < hi - 1 and variance[gap_end - lo + 1] < var_threshold:
                gap_end += 1

            if gap_end - gap_start + 1 < min_gap_width:
                return (expected_pos, expected_pos)
            return (gap_start, gap_end + 1)

        # Find the largest bright contiguous region near expected_pos
        # Mark contiguous regions
        regions = []
        start = None
        for i, bright in enumerate(is_bright):
            if bright and start is None:
                start = i
            elif not bright and start is not None:
                regions.append((lo + start, lo + i))
                start = None
        if start is not None:
            regions.append((lo + start, lo + len(is_bright)))

        if not regions:
            return (expected_pos, expected_pos)

        # Choose the region closest to expected_pos
        best_region = min(regions, key=lambda r: abs((r[0] + r[1]) / 2 - expected_pos))

        if best_region[1] - best_region[0] < min_gap_width:
            return (expected_pos, expected_pos)

        return best_region

    # Detect vertical gaps (cols - 1 of them)
    v_gaps = []
    for c in range(1, cols):
        expected_x = c * width // cols
        gap_start, gap_end = _find_gap_range(gray, expected_x, axis=1)
        v_gaps.append((gap_start, gap_end))

    # Detect horizontal gaps (rows - 1 of them)
    h_gaps = []
    for r in range(1, rows):
        expected_y = r * height // rows
        gap_start, gap_end = _find_gap_range(gray, expected_y, axis=0)
        h_gaps.append((gap_start, gap_end))

    # Compute the crop region of each panel (excluding gaps)
    # X boundaries
    x_boundaries = [0]
    for gap_start, gap_end in v_gaps:
        x_boundaries.append(gap_start)  # right edge of the previous panel
        x_boundaries.append(gap_end)    # left edge of the next panel
    x_boundaries.append(width)

    # Y boundaries
    y_boundaries = [0]
    for gap_start, gap_end in h_gaps:
        y_boundaries.append(gap_start)
        y_boundaries.append(gap_end)
    y_boundaries.append(height)

    # Extract panels
    panels = []
    for r in range(rows):
        y_start = y_boundaries[r * 2]
        y_end = y_boundaries[r * 2 + 1]
        for c in range(cols):
            x_start = x_boundaries[c * 2]
            x_end = x_boundaries[c * 2 + 1]
            panel = grid_image.crop((x_start, y_start, x_end, y_end))
            panels.append(panel)

    if not panels:
        return grid_image

    # Resize all to the same size
    target_w = width // cols
    target_h = height // rows
    resized_panels = [p.resize((target_w, target_h), Image.Resampling.LANCZOS) for p in panels]

    # Stitch seamlessly
    result = Image.new(grid_image.mode, (target_w * cols, target_h * rows))
    for idx, panel in enumerate(resized_panels):
        r = idx // cols
        c = idx % cols
        result.paste(panel, (c * target_w, r * target_h))

    print(f"[GridSplitter] Gap removal: {rows}x{cols} grid, "
          f"v_gaps={[(s, e) for s, e in v_gaps if s != e]}, "
          f"h_gaps={[(s, e) for s, e in h_gaps if s != e]}")

    return result


def split_grid(
    grid_image: Union[bytes, str, Path],
    output_dir: Union[str, Path],
    rows: int = 5,
    cols: int = 5,
    output_format: str = "png",
    prefix: str = "",
) -> List[Path]:
    """Split a grid image into individual storyboard shots.

    Args:
        grid_image: grid image (bytes, file path, or Path object)
        output_dir: output directory
        rows: number of rows (default 5)
        cols: number of columns (default 5)
        output_format: output format (png/jpg)
        prefix: filename prefix (distinguishes different grids in batch mode)

    Returns:
        List of split image paths (in order, beat_01 to beat_N)

    Example:
        >>> # Single-grid mode
        >>> paths = split_grid(
        ...     grid_image="grid.png",
        ...     output_dir="output/frames/ep001",
        ... )
        >>> print(paths[0])  # output/frames/ep001/panel_01_raw.png

        >>> # Batch mode (with prefix)
        >>> paths = split_grid(
        ...     grid_image="grid_01.png",
        ...     output_dir="output/raw",
        ...     rows=3, cols=3,
        ...     prefix="grid1_",
        ... )
        >>> print(paths[0])  # output/raw/grid1_panel_01_raw.png
    """
    # Load the image
    if isinstance(grid_image, bytes):
        img = Image.open(io.BytesIO(grid_image))
    else:
        img = Image.open(grid_image)

    # Post-processing: remove gaps between panels
    try:
        img = remove_grid_gaps(img, rows, cols)
    except Exception as e:
        print(f"[GridSplitter] Gap removal failed, using the original image: {e}")

    width, height = img.size
    print(f"[GridSplitter] Grid image size: {width}x{height}")

    # Compute the size of each cell
    cell_width = width // cols
    cell_height = height // rows
    print(f"[GridSplitter] Shot size: {cell_width}x{cell_height}, grid: {rows}x{cols}")

    # Make sure the output directory exists
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    output_paths = []

    for row in range(rows):
        for col in range(cols):
            beat_num = row * cols + col + 1

            # Compute the crop region
            left = col * cell_width
            upper = row * cell_height
            right = left + cell_width
            lower = upper + cell_height

            # Crop
            cell = img.crop((left, upper, right, lower))

            # Save (prefix supported)
            output_path = output_dir / f"{prefix}panel_{beat_num:02d}_raw.{output_format}"
            cell.save(output_path)
            output_paths.append(output_path)

            print(f"[GridSplitter] Shot {beat_num}/{rows * cols}: {output_path}")

    print(f"[GridSplitter] Split complete, {len(output_paths)} shots in total")
    return output_paths


def split_grid_with_padding(
    grid_image: Union[bytes, str, Path],
    output_dir: Union[str, Path],
    rows: int = 5,
    cols: int = 5,
    padding: int = 2,
    output_format: str = "png",
) -> List[Path]:
    """Split a grid image into individual storyboard shots (accounting for padding).

    Some grid images are generated with padding between cells; this function handles that case.

    Args:
        grid_image: grid image
        output_dir: output directory
        rows: number of rows
        cols: number of columns
        padding: padding between cells (pixels)
        output_format: output format

    Returns:
        List of split image paths
    """
    # Load the image
    if isinstance(grid_image, bytes):
        img = Image.open(io.BytesIO(grid_image))
    else:
        img = Image.open(grid_image)

    width, height = img.size

    # Compute the size of each cell accounting for padding
    # Total width = cols * cell_width + (cols - 1) * padding
    # cell_width = (width - (cols - 1) * padding) / cols
    cell_width = (width - (cols - 1) * padding) // cols
    cell_height = (height - (rows - 1) * padding) // rows

    print(f"[GridSplitter] Grid image size: {width}x{height}, padding={padding}")
    print(f"[GridSplitter] Shot size: {cell_width}x{cell_height}")

    # Make sure the output directory exists
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    output_paths = []

    for row in range(rows):
        for col in range(cols):
            beat_num = row * cols + col + 1

            # Compute the crop region (accounting for padding)
            left = col * (cell_width + padding)
            upper = row * (cell_height + padding)
            right = left + cell_width
            lower = upper + cell_height

            # Crop
            cell = img.crop((left, upper, right, lower))

            # Save
            output_path = output_dir / f"beat_{beat_num:02d}_raw.{output_format}"
            cell.save(output_path)
            output_paths.append(output_path)

    print(f"[GridSplitter] Split complete, {len(output_paths)} shots in total")
    return output_paths


def detect_grid_layout(
    grid_image: Union[bytes, str, Path],
    expected_rows: int = 5,
    expected_cols: int = 5,
) -> Tuple[int, int, int]:
    """Detect grid layout parameters.

    Tries to detect the padding between cells by analyzing the image.

    Args:
        grid_image: grid image
        expected_rows: expected number of rows
        expected_cols: expected number of columns

    Returns:
        (cell_width, cell_height, padding) tuple
    """
    # Load the image
    if isinstance(grid_image, bytes):
        img = Image.open(io.BytesIO(grid_image))
    else:
        img = Image.open(grid_image)

    width, height = img.size

    # Simple calculation: assume no padding
    cell_width = width // expected_cols
    cell_height = height // expected_rows
    padding = 0

    # TODO: padding could be identified more precisely via edge detection
    # but grids generated by NanoBananaPro usually have no padding

    return (cell_width, cell_height, padding)


def resize_frames_to_portrait(
    input_paths: List[Path],
    output_dir: Union[str, Path],
    target_width: int = 720,
    target_height: int = 1280,
    output_format: str = "png",
) -> List[Path]:
    """Resize square shots to portrait aspect ratio.

    Shots split from a grid are usually square and need to be resized to portrait aspect ratio (9:16).
    Uses center crop or padding to adjust.

    Args:
        input_paths: list of input image paths
        output_dir: output directory
        target_width: target width
        target_height: target height
        output_format: output format

    Returns:
        List of resized image paths
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    output_paths = []

    for input_path in input_paths:
        img = Image.open(input_path)
        orig_width, orig_height = img.size

        # Compute the target aspect ratio
        target_ratio = target_width / target_height  # 0.5625 for 9:16
        orig_ratio = orig_width / orig_height

        if orig_ratio > target_ratio:
            # Source is wider; crop left and right
            new_width = int(orig_height * target_ratio)
            left = (orig_width - new_width) // 2
            img = img.crop((left, 0, left + new_width, orig_height))
        else:
            # Source is taller; crop top and bottom
            new_height = int(orig_width / target_ratio)
            top = (orig_height - new_height) // 2
            img = img.crop((0, top, orig_width, top + new_height))

        # Scale to the target size
        img = img.resize((target_width, target_height), Image.Resampling.LANCZOS)

        # Save
        output_path = output_dir / f"{input_path.stem}_resized.{output_format}"
        img.save(output_path)
        output_paths.append(output_path)

    print(f"[GridSplitter] Portrait resize complete, {len(output_paths)} images")
    return output_paths


def combine_to_grid(
    images: List[Union[str, Path, bytes]],
    output_path: Union[str, Path],
    rows: int = 5,
    cols: int = 5,
    cell_size: Optional[Tuple[int, int]] = None,
) -> Path:
    """Merge multiple images into a grid image.

    For debugging or preview.

    Args:
        images: list of images (paths or bytes)
        output_path: output path
        rows: number of rows
        cols: number of columns
        cell_size: size of each cell (width, height); computed automatically if None

    Returns:
        Output path
    """
    # Load all images
    loaded_images = []
    for img_data in images:
        if isinstance(img_data, bytes):
            img = Image.open(io.BytesIO(img_data))
        else:
            img = Image.open(img_data)
        loaded_images.append(img)

    if not loaded_images:
        raise ValueError("No images to merge")

    # Determine the cell size
    if cell_size is None:
        # Use the size of the first image
        cell_size = loaded_images[0].size

    cell_width, cell_height = cell_size

    # Create the canvas
    grid_width = cols * cell_width
    grid_height = rows * cell_height
    grid_img = Image.new("RGB", (grid_width, grid_height), color=(0, 0, 0))

    # Paste the images
    for i, img in enumerate(loaded_images):
        if i >= rows * cols:
            break

        row = i // cols
        col = i % cols

        # Resize
        img = img.resize((cell_width, cell_height), Image.Resampling.LANCZOS)

        # Paste
        x = col * cell_width
        y = row * cell_height
        grid_img.paste(img, (x, y))

    # Save
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    grid_img.save(output_path)

    print(f"[GridSplitter] Merge complete: {output_path}")
    return output_path
