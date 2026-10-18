"""Image pool index management module.

Manages all generated images (1x1, 3x3, 5x5, etc.) and provides unified indexing and lookup.
"""

import hashlib
import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Union

from PIL import Image

from novelvideo.generators.grid_splitter import remove_grid_gaps
from novelvideo.utils.state_index_files import (
    ensure_state_index_from_legacy,
    index_file_lock,
    resolve_state_index_path,
    write_json_atomic,
)
from novelvideo.models import GridEntry, PoolImage, PoolIndex, beat_scene_id


import re

_POOL_INDEX_FILENAME = "pool_index.json"


def compute_beat_content_hash(
    beat: dict,
    sketch_colors: Optional[Dict[str, str]] = None,
) -> str:
    """Compute a content hash of the beat fields that affect sketch generation.

    2.0 no longer depends on set_description; only the fields that still affect the sketch are included here.
    """
    parts = [
        beat.get("visual_description", "") or "",
        beat_scene_id(beat),
        beat.get("time_of_day", "") or "",
    ]
    if sketch_colors:
        from novelvideo.models import extract_char_identities_from_markers

        try:
            char_ids = extract_char_identities_from_markers(
                beat.get("visual_description", "") or "",
                strict=False,
            )
            for identity_id in sorted(char_ids.values()):
                color = sketch_colors.get(identity_id)
                if color:
                    parts.append(f"color:{identity_id}={color}")
        except Exception:
            pass
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def is_pool_image_stale(
    img: PoolImage,
    beat_hashes: Dict[int, str],
    script_mt,
) -> bool:
    """Unified stale check: prefer the content hash, fall back to mtime."""
    if img.type != "sketch":
        return False
    if img.beat_content_hash:
        current_hash = beat_hashes.get(img.original_beat)
        return current_hash is not None and current_hash != img.beat_content_hash
    return bool(script_mt and (not img.generated_at or img.generated_at < script_mt))


def build_beat_sketch_paths(
    episode_grids_dir: Union[str, Path],
    beat_numbers: List[int],
    sketches_dir: Union[str, Path] = None,
) -> Dict[int, str]:
    """Build a beat_num -> absolute path mapping from the sketches/ directory.

    If sketches_dir is passed, look directly in that directory;
    otherwise derive it from episode_grids_dir (go up one level -> sketches/epXXX/).

    Returns:
        {4: "/abs/path/sketches/ep001/beat_04.png", ...}
        Only includes beats whose files actually exist.
    """
    if sketches_dir:
        sd = Path(sketches_dir)
    else:
        # episode_grids_dir = output/grids/ep001 → output/sketches/ep001
        grids_dir = Path(episode_grids_dir)
        ep_name = grids_dir.name  # "ep001"
        sd = grids_dir.parent.parent / "sketches" / ep_name

    result = {}
    for bn in beat_numbers:
        p = sd / f"beat_{bn:02d}.png"
        if p.exists():
            result[bn] = str(p)
    return result


def build_pool_index(
    episode_grids_dir: Union[str, Path],
    episode: int,
) -> PoolIndex:
    """Build the image pool index.

    Scan the render/ and sketch/ directories (flat, beat-centric naming) and index every candidate version.

    Args:
        episode_grids_dir: grids directory of the episode (e.g. grids/ep001/)
        episode: episode number

    Returns:
        PoolIndex object
    """
    grids_dir = Path(episode_grids_dir)

    pool = PoolIndex(
        episode=episode,
        generated_at=datetime.now(),
        modes={},
        images=[],
    )

    # Scan the render/ directory
    render_items = sorted(
        scan_render_dir(grids_dir),
        key=lambda item: (
            item["beat_number"],
            item["timestamp"] or datetime.min,
            item["path"],
        ),
    )
    for item in render_items:
        bn = item["beat_number"]
        ts = item["timestamp"]
        ts_str = ts.strftime("%Y%m%d%H%M%S") if ts else ""
        pool_id = f"render_beat_{bn:02d}_t{ts_str}" if ts_str else f"render_beat_{bn:02d}"
        pool.images.append(
            PoolImage(
                id=pool_id,
                mode="render",
                grid_index=0,
                cell_index=0,
                grid_path="",
                cell_path=item["path"],
                row=0,
                col=0,
                original_beat=bn,
                generated_at=ts,
                type="render",
            )
        )
    if render_items:
        pool.modes["render"] = {"total_cells": len(render_items)}
        print(f"[PoolIndexer] Scanned {len(render_items)} beat render images")

    # Scan the sketch/ directory
    sketch_items = sorted(
        scan_sketch_dir(grids_dir),
        key=lambda item: (
            item["beat_number"],
            item["timestamp"] or datetime.min,
            item["path"],
        ),
    )
    for item in sketch_items:
        bn = item["beat_number"]
        ts = item["timestamp"]
        ts_str = ts.strftime("%Y%m%d%H%M%S") if ts else ""
        pool_id = f"sketch_beat_{bn:02d}_t{ts_str}" if ts_str else f"sketch_beat_{bn:02d}"
        pool.images.append(
            PoolImage(
                id=pool_id,
                mode="sketch",
                grid_index=0,
                cell_index=bn,
                grid_path="",
                cell_path=item["path"],
                row=0,
                col=0,
                original_beat=bn,
                generated_at=ts,
                type="sketch",
            )
        )
    if sketch_items:
        pool.modes["sketch"] = {"total_cells": len(sketch_items)}
        print(f"[PoolIndexer] Scanned {len(sketch_items)} beat sketches")

    print(f"[PoolIndexer] Index complete: episode={episode}, {len(pool.images)} images total")
    return pool


def _pool_image_assignment_aliases(img: PoolImage) -> set[str]:
    aliases = {img.id}
    if img.cell_path:
        aliases.add(img.cell_path)

    ts_str = img.generated_at.strftime("%Y%m%d%H%M%S") if img.generated_at else ""
    beat = img.original_beat
    if ts_str:
        aliases.add(f"{img.type}_beat_{beat:02d}_t{ts_str}")
        aliases.add(f"beat_{beat:02d}_t{ts_str}_{img.type}")
    else:
        aliases.add(f"{img.type}_beat_{beat:02d}")
        aliases.add(f"beat_{beat:02d}_{img.type}")
    return aliases


def _preserve_rebuilt_assignments(
    old_pool: Optional[PoolIndex],
    new_pool: PoolIndex,
) -> None:
    if old_pool is None or not old_pool.beat_assignments:
        return

    alias_to_id: dict[str, str] = {}
    for img in new_pool.images:
        for alias in _pool_image_assignment_aliases(img):
            alias_to_id[alias] = img.id

    new_pool.beat_assignments = {
        beat: alias_to_id[pool_id]
        for beat, pool_id in old_pool.beat_assignments.items()
        if pool_id in alias_to_id
    }


def _pool_index_payload(pool: PoolIndex) -> dict:
    # Convert to a serializable dict
    def serialize_image(img: PoolImage) -> dict:
        data = img.model_dump()
        # Convert datetime to an ISO-format string
        if data.get("generated_at"):
            data["generated_at"] = data["generated_at"].isoformat()
        return data

    def serialize_grid(g: GridEntry) -> dict:
        d = g.model_dump()
        if d.get("generated_at"):
            d["generated_at"] = d["generated_at"].isoformat()
        return d

    data = {
        "episode": pool.episode,
        "generated_at": pool.generated_at.isoformat(),
        "version": pool.version,
        "modes": pool.modes,
        "grids": [serialize_grid(g) for g in pool.grids],
        "images": [serialize_image(img) for img in pool.images],
        "beat_assignments": pool.beat_assignments,
    }
    return data


def _save_pool_index_unlocked(pool: PoolIndex, index_path: Path) -> Path:
    write_json_atomic(index_path, _pool_index_payload(pool))
    try:
        print(f"[PoolIndexer] Index saved: {index_path}")
    except OSError:
        # The atomic replace has committed. A closed log pipe must not make
        # callers roll back files referenced by this successfully saved index.
        pass
    return index_path


def save_pool_index(
    pool: PoolIndex,
    episode_grids_dir: Union[str, Path],
) -> Path:
    """Save the image pool index to the state JSON file.

    The legacy output/grids/epXXX/pool_index.json is moved to state on first access;
    afterwards only the sidecar in state is maintained, so output never becomes the state source.
    """
    grids_dir = Path(episode_grids_dir)
    index_path = resolve_state_index_path(grids_dir, _POOL_INDEX_FILENAME)
    with index_file_lock(index_path):
        index_path = ensure_state_index_from_legacy(grids_dir, _POOL_INDEX_FILENAME)
        return _save_pool_index_unlocked(pool, index_path)


def _load_pool_index_unlocked(index_path: Path) -> Optional[PoolIndex]:
    if not index_path.exists():
        return None

    with open(index_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    # Check for the legacy format (simple key-value mapping)
    if "episode" not in data:
        # Legacy format: return None so the caller rebuilds the index
        print(f"[load_pool_index] Legacy-format pool_index.json, index needs to be rebuilt")
        return None

    # Parse images and handle the generated_at field
    def parse_image(img_data: dict) -> PoolImage:
        # Convert ISO-format strings to datetime
        if img_data.get("generated_at") and isinstance(img_data["generated_at"], str):
            img_data["generated_at"] = datetime.fromisoformat(img_data["generated_at"])
        return PoolImage(**img_data)

    def parse_grid(g_data: dict) -> GridEntry:
        if g_data.get("generated_at") and isinstance(g_data["generated_at"], str):
            g_data["generated_at"] = datetime.fromisoformat(g_data["generated_at"])
        return GridEntry(**g_data)

    # Rebuild the PoolIndex object
    pool = PoolIndex(
        episode=data["episode"],
        generated_at=datetime.fromisoformat(data["generated_at"]),
        version=data.get("version", 1),
        modes=data.get("modes", {}),
        grids=[parse_grid(g) for g in data.get("grids", [])],
        images=[parse_image(img) for img in data.get("images", [])],
        beat_assignments=data.get("beat_assignments", {}),
    )

    return pool


def _state_pool_index_path(episode_grids_dir: Union[str, Path]) -> Path:
    return resolve_state_index_path(episode_grids_dir, _POOL_INDEX_FILENAME)


def _load_pool_index_for_update(
    episode_grids_dir: Union[str, Path],
) -> tuple[Path, Optional[PoolIndex]]:
    grids_dir = Path(episode_grids_dir)
    index_path = ensure_state_index_from_legacy(grids_dir, _POOL_INDEX_FILENAME)
    return index_path, _load_pool_index_unlocked(index_path)


def load_pool_index(
    episode_grids_dir: Union[str, Path],
) -> Optional[PoolIndex]:
    """Load the image pool index from the state JSON file."""
    grids_dir = Path(episode_grids_dir)
    index_path = resolve_state_index_path(grids_dir, _POOL_INDEX_FILENAME)
    with index_file_lock(index_path):
        index_path = ensure_state_index_from_legacy(grids_dir, _POOL_INDEX_FILENAME)
        return _load_pool_index_unlocked(index_path)


def rebuild_pool_index(
    episode_grids_dir: Union[str, Path],
    episode: int,
    split_cells: bool = False,
) -> PoolIndex:
    """Rebuild the image pool index.

    Scan the render/ and sketch/ directories, build the index and save it.

    Args:
        episode_grids_dir: grids directory of the episode
        episode: episode number
        split_cells: deprecated, kept for compatibility

    Returns:
        Newly built PoolIndex object
    """
    grids_dir = Path(episode_grids_dir)

    old_pool = load_pool_index(grids_dir)
    pool = build_pool_index(grids_dir, episode)
    _preserve_rebuilt_assignments(old_pool, pool)

    # Save the index
    save_pool_index(pool, grids_dir)

    return pool


def select_frame_from_pool(
    pool_id: str,
    episode_grids_dir: Union[str, Path],
    pool: Optional[PoolIndex] = None,
) -> Optional[str]:
    """Pick an image from the pool for a beat and return the actual file path.

    Args:
        pool_id: image pool ID (e.g. "3x3_01_05")
        episode_grids_dir: grids directory of the episode
        pool: optional PoolIndex object (if already loaded)

    Returns:
        Full path of the cell, or None if it does not exist
    """
    if pool is None:
        pool = load_pool_index(episode_grids_dir)

    if pool is None:
        print(f"[PoolIndexer] Warning: cannot load pool index {episode_grids_dir}")
        return None

    cell_path = pool.get_cell_path(pool_id)
    if cell_path is None:
        print(f"[PoolIndexer] Warning: image not found {pool_id}")
        return None

    full_path = Path(episode_grids_dir) / cell_path
    if not full_path.exists():
        print(f"[PoolIndexer] Warning: file does not exist {full_path}")
        return None

    return str(full_path)


def delete_cell_from_pool(
    episode_grids_dir: Union[str, Path],
    pool_id: str,
) -> bool:
    """Delete the specified cell from the image pool.

    Args:
        episode_grids_dir: grids directory path
        pool_id: image pool ID (e.g. "3x3_01_05")

    Returns:
        Whether the deletion succeeded
    """
    grids_dir = Path(episode_grids_dir)
    index_path = _state_pool_index_path(grids_dir)

    with index_file_lock(index_path):
        # 1. Load the index
        index_path, pool = _load_pool_index_for_update(grids_dir)
        if pool is None:
            print(f"[PoolIndexer] Warning: cannot load pool index {grids_dir}")
            return False

        # 2. Find the image
        img = pool.get_image(pool_id)
        if img is None:
            print(f"[PoolIndexer] Warning: image not found {pool_id}")
            return False

        # 3. Delete the cell file (if it exists)
        if img.cell_path:
            cell_path = grids_dir / img.cell_path
            if cell_path.exists():
                cell_path.unlink()
                print(f"[PoolIndexer] Deleted file: {cell_path}")

        # 4. Remove from the index
        pool.images = [i for i in pool.images if i.id != pool_id]

        # 5. Update mode statistics
        for mode in pool.modes:
            pool.modes[mode]["total_cells"] = len([i for i in pool.images if i.mode == mode])

        # 6. Save the updated index
        _save_pool_index_unlocked(pool, index_path)
    print(f"[PoolIndexer] Removed from pool: {pool_id}")

    return True


# =============================================================================
# Beat-centric naming format support (render/beat_NN_t{ts}.png, sketch/{ratio}/beat_NN_t{ts}.jpg)
# =============================================================================


def _parse_beat_timestamp(filename: str) -> Optional[datetime]:
    """Parse the timestamp from a beat-centric filename.

    Supported format: beat_{NN}_t{YYYYMMDDHHMMSS}.{ext}

    Returns:
        datetime object, or None if parsing fails
    """
    match = re.search(r"beat_\d+_t(\d{14})\.", filename)
    if match:
        try:
            return datetime.strptime(match.group(1), "%Y%m%d%H%M%S")
        except ValueError:
            return None
    return None


def _parse_beat_number(filename: str) -> Optional[int]:
    """Parse the beat number from a filename.

    Supported formats: beat_{NN}_t{ts}.{ext} or beat_{NN}_raw.{ext}
    """
    match = re.match(r"beat_(\d+)", filename)
    if match:
        return int(match.group(1))
    return None


def scan_render_dir(episode_grids_dir: Union[str, Path]) -> list[dict]:
    """Scan beat-centric files under the render/ directory.

    Returns:
        [{"path": "render/beat_01_t...", "beat_number": 1, "timestamp": datetime, "type": "render"}, ...]
    """
    grids_dir = Path(episode_grids_dir)
    render_dir = grids_dir / "render"
    results = []

    if not render_dir.exists():
        return results

    for f in sorted(render_dir.glob("beat_*_t*.png")):
        beat_num = _parse_beat_number(f.name)
        ts = _parse_beat_timestamp(f.name)
        if beat_num is not None:
            results.append(
                {
                    "path": f.relative_to(grids_dir).as_posix(),
                    "beat_number": beat_num,
                    "timestamp": ts,
                    "type": "render",
                }
            )

    return results


def scan_sketch_dir(episode_grids_dir: Union[str, Path]) -> list[dict]:
    """Scan beat-centric files under the sketch/ directory (flat directory).

    Returns:
        [{"path": "sketch/beat_01_t...", "beat_number": 1, "timestamp": datetime, "type": "sketch"}, ...]
    """
    grids_dir = Path(episode_grids_dir)
    sketch_base = grids_dir / "sketch"
    results = []

    if not sketch_base.exists():
        return results

    for ext in ("jpg", "png"):
        for f in sorted(sketch_base.glob(f"beat_*_t*.{ext}")):
            beat_num = _parse_beat_number(f.name)
            ts = _parse_beat_timestamp(f.name)
            if beat_num is not None:
                results.append(
                    {
                        "path": f.relative_to(grids_dir).as_posix(),
                        "beat_number": beat_num,
                        "timestamp": ts,
                        "type": "sketch",
                    }
                )

    return results


def add_beat_images_to_pool(
    pool: PoolIndex,
    episode_grids_dir: Union[str, Path],
) -> int:
    """Add beat-centric images from render/ and sketch/ to the image pool.

    Only adds images not already in the pool (deduplicated by path).

    Returns:
        Number of images added
    """
    grids_dir = Path(episode_grids_dir)
    existing_paths = {img.cell_path for img in pool.images if img.cell_path}
    added = 0

    for scan_fn in [scan_render_dir, scan_sketch_dir]:
        for item in scan_fn(grids_dir):
            if item["path"] in existing_paths:
                continue

            beat_num = item["beat_number"]
            ts = item["timestamp"]
            img_type = item["type"]

            if ts:
                ts_str = ts.strftime("%Y%m%d%H%M%S")
                pool_id = f"beat_{beat_num:02d}_t{ts_str}_{img_type}"
            else:
                pool_id = f"beat_{beat_num:02d}_{img_type}"

            pool_image = PoolImage(
                id=pool_id,
                mode="regen" if "regen" in item["path"] else img_type,
                grid_index=0,
                cell_index=0,
                grid_path="",
                cell_path=item["path"],
                row=0,
                col=0,
                original_beat=beat_num,
                generated_at=ts,
                type=img_type,
            )
            pool.images.append(pool_image)
            existing_paths.add(item["path"])
            added += 1

    if added > 0:
        print(f"[PoolIndexer] Added {added} beat-centric images to the pool")

    return added


def save_grid_and_split(
    grid_image_path: Union[str, Path],
    episode_grids_dir: Union[str, Path],
    grid_type: str,
    mode_key: str,
    beat_nums: list[int],
    preset: str,
    rows: int,
    cols: int,
    ts: str,
    pool: Optional[PoolIndex] = None,
    promote_dir: Optional[Union[str, Path]] = None,
    prompt_text: str = "",
    force_promote: bool = False,
    beats: Optional[list[dict]] = None,
    sketch_colors: Optional[Dict[str, str]] = None,
) -> dict:
    """Save the full grid image to the preset directory, split cells into cells/, and register them in the pool.

    Full grid -> cells flow:
    1. Move/copy the full image to {preset}/{type}_{mode}_{beats}_grid_{ts}.png
    2. Save the prompt to {preset}/{type}_{mode}_{beats}_prompt.txt
    3. Split into cells -> cells/beat_{NN}_t{ts}.png
    4. Compare and deduplicate when adding to the pool
    5. Promote to frames/ or sketches/

    Args:
        grid_image_path: path of the generated full image
        episode_grids_dir: grids/ep001 directory
        grid_type: "render" | "sketch"
        mode_key: e.g. "3x3", "1x1_9-16"
        beat_nums: list of beat numbers (in cell order)
        preset: "scene" | "char" | "loc" | "custom"
        rows, cols: number of grid rows and columns
        ts: timestamp string
        pool: pool index (auto-loaded if not passed)
        promote_dir: target promote directory (e.g. frames/ or sketches/)
        prompt_text: prompt text

    Returns:
        {"grid_path": str, "cell_paths": [Path], "added": int, "skipped": int}
    """
    import shutil
    from novelvideo.generators.grid_splitter import split_grid

    grids_dir = Path(episode_grids_dir)
    src_path = Path(grid_image_path)

    # 1. Prepare the preset directory + filename
    beats_str = "-".join(str(b) for b in beat_nums)
    grid_filename = f"{grid_type}_{mode_key}_{beats_str}_grid_{ts}.png"
    preset_dir = grids_dir / preset
    preset_dir.mkdir(parents=True, exist_ok=True)
    dst_grid = preset_dir / grid_filename

    # Move/copy the full image
    if src_path.exists() and src_path != dst_grid:
        shutil.copy2(str(src_path), str(dst_grid))

    # 2. Save the prompt
    prompt_path = ""
    if prompt_text:
        prompt_filename = f"{grid_type}_{mode_key}_{beats_str}_prompt.txt"
        prompt_file = preset_dir / prompt_filename
        prompt_file.write_text(prompt_text, encoding="utf-8")
        prompt_path = prompt_file.relative_to(grids_dir).as_posix()

    grid_rel = dst_grid.relative_to(grids_dir).as_posix()

    # 4. Split into the render/ or sketch/ directory (flat, beat-centric naming)
    target_dir = grids_dir / grid_type  # "render" or "sketch"
    target_dir.mkdir(parents=True, exist_ok=True)

    cell_paths_raw = split_grid(
        grid_image=str(dst_grid),
        output_dir=str(target_dir),
        rows=rows,
        cols=cols,
        output_format="png",
        prefix=f"tmp_{ts}_{uuid.uuid4().hex}_",
    )

    # 5. Precompute the beat content hash (used for sketch stale checks)
    beat_hash_map: Dict[int, str] = {}
    if beats:
        for beat in beats:
            beat_num = beat.get("beat_number")
            if beat_num is not None:
                beat_hash_map[beat_num] = compute_beat_content_hash(
                    beat, sketch_colors=sketch_colors
                )

    # 6. The index update must complete under the same lock to prevent concurrent tasks from overwriting each other's entries.
    index_path = _state_pool_index_path(grids_dir)
    with index_file_lock(index_path):
        index_path, latest_pool = _load_pool_index_for_update(grids_dir)
        if latest_pool is not None:
            pool = latest_pool
        elif pool is None:
            import re as _re

            match = _re.search(r"ep(\d+)", grids_dir.name)
            episode = int(match.group(1)) if match else 1
            pool = build_pool_index(grids_dir, episode)

        register_grid_entry(
            pool=pool,
            grid_type=grid_type,
            mode_key=mode_key,
            beat_nums=beat_nums,
            preset=preset,
            grid_path=grid_rel,
            prompt_path=prompt_path,
        )

        # 6. Rename to beat-centric + dedupe into the pool
        added = 0
        skipped = 0
        final_cell_paths = []
        for i, raw_path in enumerate(cell_paths_raw):
            if i >= len(beat_nums):
                # padding cell
                raw_path.unlink(missing_ok=True)
                continue
            beat_num = beat_nums[i]
            cell_name = f"beat_{beat_num:02d}_t{ts}.png"
            cell_path = target_dir / cell_name
            raw_path.replace(cell_path)

            result = add_cell_with_dedup(
                pool=pool,
                cell_path=cell_path,
                episode_grids_dir=grids_dir,
                beat_num=beat_num,
                ts=ts,
                img_type=grid_type,
                mode=mode_key,
                grid_index=0,
                cell_index=i + 1,
                grid_path=grid_rel,
                row=i // cols,
                col=i % cols,
                beat_content_hash=beat_hash_map.get(beat_num, ""),
            )
            if result:
                added += 1
            else:
                skipped += 1

            final_cell_paths.append(cell_path)

            # 7. Promote
            # force_promote=True: explicit user actions such as regen/render overwrite existing ones
            # force_promote=False: batch sketch draws do not overwrite the user's manual image choice
            if promote_dir and cell_path.exists():
                promote = Path(promote_dir)
                promote.mkdir(parents=True, exist_ok=True)
                dst = promote / f"beat_{beat_num:02d}.png"
                if force_promote or not dst.exists():
                    shutil.copy2(str(cell_path), str(dst))

            # If duplicate, delete the new cell (after promote)
            if not result:
                cell_path.unlink(missing_ok=True)

        _save_pool_index_unlocked(pool, index_path)

    return {
        "grid_path": str(dst_grid),
        "cell_paths": final_cell_paths,
        "added": added,
        "skipped": skipped,
    }


def assign_beat_image(
    episode_grids_dir: Union[str, Path],
    beat_num: int,
    image_path: str,
    img_type: str = "render",
) -> bool:
    """Assign an image to a beat (render or sketch) and also copy it to frames/.

    Args:
        episode_grids_dir: grids directory
        beat_num: beat number
        image_path: relative image path (relative to grids_dir)
        img_type: "render" or "sketch"

    Returns:
        Whether it succeeded
    """
    import shutil

    grids_dir = Path(episode_grids_dir)
    index_path = _state_pool_index_path(grids_dir)
    with index_file_lock(index_path):
        index_path, pool = _load_pool_index_for_update(grids_dir)
        if pool is None:
            print(f"[PoolIndexer] Warning: cannot load pool index {grids_dir}")
            return False

        if img_type != "sketch":
            pool.beat_assignments[str(beat_num)] = image_path
            # Also copy to frames/beat_XX.png for downstream compatibility
            src = grids_dir / image_path
            if src.exists():
                # grids_dir format: output/{user}/{project}/grids/ep001
                # frames directory: output/{user}/{project}/frames/ep001
                frames_dir = grids_dir.parent.parent / "frames" / grids_dir.name
                frames_dir.mkdir(parents=True, exist_ok=True)
                dst = frames_dir / f"beat_{beat_num:02d}.png"
                shutil.copy2(str(src), str(dst))
                print(f"[PoolIndexer] Copied to frames: {dst}")

        _save_pool_index_unlocked(pool, index_path)
    print(f"[PoolIndexer] Beat {beat_num} ({img_type}) → {image_path}")
    return True


# =============================================================================
# Phase 2: content hash + dedupe
# =============================================================================


def compute_image_hash(image_path: Union[str, Path]) -> str:
    """Compute the image content hash (used for deduplication).

    Uses an MD5 hash of the file content. Fast and sufficient for dedupe checks.

    Args:
        image_path: image file path

    Returns:
        MD5 hash string
    """
    path = Path(image_path)
    if not path.exists():
        return ""
    return hashlib.md5(path.read_bytes()).hexdigest()


def add_cell_with_dedup(
    pool: PoolIndex,
    cell_path: Path,
    episode_grids_dir: Path,
    beat_num: int,
    ts: str,
    img_type: str = "render",
    mode: str = "",
    grid_index: int = 0,
    cell_index: int = 0,
    grid_path: str = "",
    row: int = 0,
    col: int = 0,
    beat_content_hash: str = "",
) -> Optional[PoolImage]:
    """Add a cell to the pool, checking for duplicates first.

    Compare against existing images at the same beat position:
    - If the pool already has an image for the same beat with identical content -> skip
    - Otherwise add a new entry

    Args:
        pool: pool index object
        cell_path: absolute path of the cell file
        episode_grids_dir: grids root directory
        beat_num: beat number
        ts: timestamp string
        img_type: render | sketch
        mode: generation mode
        grid_index: grid index
        cell_index: cell index
        grid_path: relative path of the grid image
        row: row number
        col: column number

    Returns:
        Newly added PoolImage, or None if it is a duplicate
    """
    content_hash = compute_image_hash(cell_path)

    if content_hash and pool.has_duplicate_cell(beat_num, content_hash):
        print(f"[PoolIndexer] Dedupe: Beat {beat_num} already has an image with identical content, skipping")
        return None

    rel_path = cell_path.relative_to(episode_grids_dir).as_posix()
    pool_id = f"beat_{beat_num:02d}_t{ts}_{img_type}"

    pool_image = PoolImage(
        id=pool_id,
        mode=mode or img_type,
        grid_index=grid_index,
        cell_index=cell_index,
        grid_path=grid_path,
        cell_path=rel_path,
        row=row,
        col=col,
        original_beat=beat_num,
        generated_at=datetime.now(),
        type=img_type,
        content_hash=content_hash,
        beat_content_hash=beat_content_hash or None,
    )
    pool.images.append(pool_image)
    return pool_image


def persist_uploaded_grid(
    grids_dir: Path,
    episode_num: int,
    grid_index: int,
    grid_type: str,
    mode_key: str,
    parsed_beats: list[int],
    filename: str,
    content: bytes,
) -> Path:
    """Publish an upload and its index under one cross-process index lock.

    Ordinary write failures restore the prior image. Cancellation is handled by
    the bounded upload worker, which waits for this transaction before returning.
    """
    import os
    import shutil
    import tempfile

    upload_dir = grids_dir / "custom"
    upload_dir.mkdir(parents=True, exist_ok=True)
    grid_path = upload_dir / filename
    grid_rel = grid_path.relative_to(grids_dir).as_posix()
    # Stage outside the index lock so large writes do not hold up index readers.
    with tempfile.TemporaryDirectory(prefix=".grid-upload-", dir=upload_dir) as staging:
        staged = Path(staging) / "image"
        staged.write_bytes(content)
        backup = Path(staging) / "previous"
        with index_file_lock(_state_pool_index_path(grids_dir)):
            index_path, pool = _load_pool_index_for_update(grids_dir)
            pool = pool or build_pool_index(grids_dir, episode_num)
            entry = pool.find_grid(grid_type, mode_key, parsed_beats) if parsed_beats else None
            if entry is None:
                entry = register_grid_entry(
                    pool=pool,
                    grid_type=grid_type,
                    mode_key=mode_key,
                    beat_nums=parsed_beats,
                    preset="custom",
                    grid_path=grid_rel,
                    prompt_path="",
                )
            else:
                entry.grid_path = grid_rel
                entry.preset = "custom"
                entry.generated_at = datetime.now()

            for image in pool.images:
                if image.type != grid_type or image.grid_index != grid_index:
                    continue
                if parsed_beats and image.original_beat not in parsed_beats:
                    continue
                image.grid_path = grid_rel
                image.mode = mode_key

            existed = grid_path.exists()
            if existed:
                shutil.copyfile(grid_path, backup)
            os.replace(staged, grid_path)
            try:
                _save_pool_index_unlocked(pool, index_path)
            except BaseException:
                if existed:
                    os.replace(backup, grid_path)
                else:
                    grid_path.unlink(missing_ok=True)
                raise
    return grid_path


def register_grid_entry(
    pool: PoolIndex,
    grid_type: str,
    mode_key: str,
    beat_nums: list[int],
    preset: str,
    grid_path: str,
    prompt_path: str = "",
) -> GridEntry:
    """Register full-grid metadata in the pool index.

    Args:
        pool: pool index object
        grid_type: render | sketch
        mode_key: e.g. 3x3, 1x1_9-16
        beat_nums: list of included beat numbers
        preset: scene / char / loc / custom
        grid_path: relative path of the full image
        prompt_path: relative path of the prompt

    Returns:
        Newly added GridEntry
    """
    entry = GridEntry(
        type=grid_type,
        mode_key=mode_key,
        beat_nums=beat_nums,
        preset=preset,
        grid_path=grid_path,
        prompt_path=prompt_path,
        generated_at=datetime.now(),
    )
    pool.add_grid(entry)
    return entry


def scan_preset_dirs(episode_grids_dir: Union[str, Path]) -> list[dict]:
    """Scan the full-grid files under the preset directory.

    Returns:
        [{"path": "scene/render_3x3_1-2-3_grid_ts.png", "type": "render",
          "mode_key": "3x3", "beat_nums": [1,2,3], "preset": "scene"}, ...]
    """
    grids_dir = Path(episode_grids_dir)
    results = []
    preset_names = ("scene", "char", "loc", "custom")

    grid_pattern = re.compile(r"^(render|sketch)_(.+?)_([\d-]+)_grid_(\d{14})\.png$")

    for preset in preset_names:
        preset_dir = grids_dir / preset
        if not preset_dir.exists():
            continue
        for f in sorted(preset_dir.glob("*_grid_*.png")):
            m = grid_pattern.match(f.name)
            if m:
                grid_type = m.group(1)
                mode_key = m.group(2)
                beats_str = m.group(3)
                ts_str = m.group(4)
                beat_nums = [int(b) for b in beats_str.split("-")]
                try:
                    ts = datetime.strptime(ts_str, "%Y%m%d%H%M%S")
                except ValueError:
                    ts = None
                results.append(
                    {
                        "path": f.relative_to(grids_dir).as_posix(),
                        "type": grid_type,
                        "mode_key": mode_key,
                        "beat_nums": beat_nums,
                        "preset": preset,
                        "timestamp": ts,
                    }
                )

    return results
