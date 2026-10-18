"""Verification utility functions: image compression, beat data reading, image lookup."""

import io
from pathlib import Path

from PIL import Image as PILImage


def compress_image(image_path: str, quality: int = 60, max_long_edge: int = 1024) -> bytes:
    """Compress an image to JPEG bytes, limiting the long edge to max_long_edge.

    Raises:
        FileNotFoundError: the image file does not exist
        ValueError: the image format is corrupted or unrecognized
    """
    try:
        img = PILImage.open(image_path)
    except FileNotFoundError:
        raise
    except Exception as e:
        raise ValueError(f"Cannot open image {image_path}: {e}") from e
    if img.mode in ("RGBA", "P"):
        img = img.convert("RGB")
    w, h = img.size
    long_edge = max(w, h)
    if long_edge > max_long_edge:
        scale = max_long_edge / long_edge
        img = img.resize((int(w * scale), int(h * scale)), PILImage.LANCZOS)
    buffer = io.BytesIO()
    img.save(buffer, format="JPEG", quality=quality, optimize=True)
    return buffer.getvalue()


async def load_all_beats(
    project_dir: Path,
    episode_num: int,
    *,
    cognee_store=None,
    sqlite_store=None,
) -> list[dict]:
    """Read the data of all beats of the whole episode; reading is only allowed from the SQLite/Cognee store."""
    store = sqlite_store or cognee_store
    if store:
        try:
            beats = await store.get_beats_as_dicts(episode_num)
            if beats:
                return beats
        except Exception:
            pass

    raise FileNotFoundError(f"No beats found in SQLite for episode {episode_num}")

def safe_resolve_under(base_dir: Path, candidate: Path) -> Path | None:
    """Resolve a path and verify it stays within base_dir.

    Returns the resolved path if safe, None if it escapes base_dir (e.g. via symlink).
    """
    resolved = candidate.resolve()
    base_resolved = base_dir.resolve()
    if resolved.is_relative_to(base_resolved):
        return resolved
    return None


def find_sketch_for_beat(project_dir: Path, episode_num: int, beat_num: int) -> Path | None:
    """Find the sketch file of a beat (the latest timestamp version)."""
    sketch_dir = project_dir / "grids" / f"ep{episode_num:03d}" / "sketch"
    if not sketch_dir.exists():
        return None
    # Sketch file name format: beat_{NN}_t{timestamp}.png
    pattern = f"beat_{beat_num:02d}_t*.png"
    matches = sorted(sketch_dir.glob(pattern))
    if matches:
        return matches[-1]  # take the latest
    return None


def find_active_sketch_for_beat(project_dir: Path, episode_num: int, beat_num: int) -> Path | None:
    """Find the currently selected sketch file."""
    sketch = project_dir / "sketches" / f"ep{episode_num:03d}" / f"beat_{beat_num:02d}.png"
    return sketch if sketch.exists() else None


def find_frame_for_beat(project_dir: Path, episode_num: int, beat_num: int) -> Path | None:
    """Find the first-frame file of a beat."""
    frame = project_dir / "frames" / f"ep{episode_num:03d}" / f"beat_{beat_num:02d}.png"
    return frame if frame.exists() else None
