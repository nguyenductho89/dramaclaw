"""Video pool index management module.

Manages every generated video version and provides unified indexing and lookup.
Follows the pool_indexer.py pattern but has no grid/cell logic, so it is much simpler.
"""

import json
import shutil
from datetime import datetime
from pathlib import Path
from typing import Optional

from novelvideo.utils.state_index_files import (
    ensure_state_index_from_legacy,
    index_file_lock,
    resolve_state_index_path,
    write_json_atomic,
)
from novelvideo.models import VideoPoolEntry, VideoPoolIndex

_VIDEO_POOL_INDEX_FILENAME = "video_pool_index.json"


def _state_video_pool_index_path(videos_ep_dir: Path) -> Path:
    return resolve_state_index_path(videos_ep_dir, _VIDEO_POOL_INDEX_FILENAME)


def _load_video_pool_index_unlocked(index_path: Path) -> Optional[VideoPoolIndex]:
    if not index_path.exists():
        return None
    try:
        data = json.loads(index_path.read_text(encoding="utf-8"))
        return VideoPoolIndex.model_validate(data)
    except Exception:
        return None


def _save_video_pool_index_unlocked(pool: VideoPoolIndex, index_path: Path) -> None:
    write_json_atomic(index_path, pool.model_dump(mode="json"))


def load_video_pool_index(videos_ep_dir: Path) -> Optional[VideoPoolIndex]:
    """Read the video pool index.

    Args:
        videos_ep_dir: episode video directory, e.g. output/user/project/videos/beats/ep001

    Returns:
        VideoPoolIndex object; None if it does not exist
    """
    index_path = _state_video_pool_index_path(videos_ep_dir)
    with index_file_lock(index_path):
        index_path = ensure_state_index_from_legacy(
            videos_ep_dir,
            _VIDEO_POOL_INDEX_FILENAME,
        )
        return _load_video_pool_index_unlocked(index_path)


def save_video_pool_index(pool: VideoPoolIndex, videos_ep_dir: Path) -> None:
    """Serialize and write the video pool index.

    Args:
        pool: VideoPoolIndex object
        videos_ep_dir: episode video directory
    """
    index_path = _state_video_pool_index_path(videos_ep_dir)
    with index_file_lock(index_path):
        index_path = ensure_state_index_from_legacy(
            videos_ep_dir,
            _VIDEO_POOL_INDEX_FILENAME,
        )
        _save_video_pool_index_unlocked(pool, index_path)


def add_video_to_pool(
    videos_ep_dir: Path,
    episode: int,
    beat_num: int,
    source_video_path: Path,
    duration: float = 5.0,
    video_mode: str = "first_frame",
    backend: str = "comfyui",
    prompt: str = "",
) -> VideoPoolEntry:
    """Add a video to the video pool.

    1. Create the pool/ directory
    2. Generate a timestamp ID
    3. Copy the source video into pool/
    4. Update the index

    Args:
        videos_ep_dir: episode video directory
        episode: episode number
        beat_num: beat number
        source_video_path: source video path (canonical location)
        duration: video duration
        video_mode: video mode
        backend: backend name
        prompt: prompt text

    Returns:
        The newly created VideoPoolEntry
    """
    source_video_path = Path(source_video_path)
    pool_dir = videos_ep_dir / "pool"
    pool_dir.mkdir(parents=True, exist_ok=True)

    # Generate timestamp and ID
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    entry_id = f"beat_{beat_num:02d}_{timestamp}"
    pool_filename = f"{entry_id}.mp4"
    pool_path = pool_dir / pool_filename

    # Copy the source video into the pool (the source file stays in its canonical location)
    shutil.copy2(str(source_video_path), str(pool_path))

    # Create the entry
    entry = VideoPoolEntry(
        id=entry_id,
        beat_num=beat_num,
        video_path=pool_filename,
        generated_at=datetime.now(),
        duration=duration,
        video_mode=video_mode,
        backend=backend,
        prompt=prompt,
    )

    index_path = _state_video_pool_index_path(videos_ep_dir)
    with index_file_lock(index_path):
        index_path = ensure_state_index_from_legacy(
            videos_ep_dir,
            _VIDEO_POOL_INDEX_FILENAME,
        )
        pool_index = _load_video_pool_index_unlocked(index_path)
        if pool_index is None:
            pool_index = VideoPoolIndex(episode=episode)

        # Add the entry and update beat_assignments
        pool_index.videos.append(entry)
        pool_index.beat_assignments[str(beat_num)] = entry_id

        # Save
        _save_video_pool_index_unlocked(pool_index, index_path)

    return entry


def assign_video_to_beat(
    videos_ep_dir: Path,
    beat_num: int,
    pool_entry_id: str,
) -> bool:
    """Called when the user picks an older version from the pool.

    1. Load the index and find the entry
    2. Copy pool/{entry.video_path} -> beat_{NN}.mp4 (overwriting the canonical file)
    3. Update beat_assignments

    Args:
        videos_ep_dir: episode video directory
        beat_num: beat number
        pool_entry_id: pool entry ID

    Returns:
        Whether it succeeded
    """
    index_path = _state_video_pool_index_path(videos_ep_dir)
    with index_file_lock(index_path):
        index_path = ensure_state_index_from_legacy(
            videos_ep_dir,
            _VIDEO_POOL_INDEX_FILENAME,
        )
        pool_index = _load_video_pool_index_unlocked(index_path)
        if pool_index is None:
            return False

        entry = pool_index.get_entry(pool_entry_id)
        if entry is None:
            return False

        pool_path = videos_ep_dir / "pool" / entry.video_path
        if not pool_path.exists():
            return False

        # Overwrite the canonical location
        canonical_path = videos_ep_dir / f"beat_{beat_num:02d}.mp4"
        shutil.copy2(str(pool_path), str(canonical_path))

        # Update the assignment
        pool_index.beat_assignments[str(beat_num)] = pool_entry_id
        _save_video_pool_index_unlocked(pool_index, index_path)

    return True


def delete_video_from_pool(
    videos_ep_dir: Path,
    pool_entry_id: str,
) -> bool:
    """Delete a video version from the pool.

    Args:
        videos_ep_dir: episode video directory
        pool_entry_id: pool entry ID

    Returns:
        Whether it succeeded
    """
    index_path = _state_video_pool_index_path(videos_ep_dir)
    with index_file_lock(index_path):
        index_path = ensure_state_index_from_legacy(
            videos_ep_dir,
            _VIDEO_POOL_INDEX_FILENAME,
        )
        pool_index = _load_video_pool_index_unlocked(index_path)
        if pool_index is None:
            return False

        entry = pool_index.get_entry(pool_entry_id)
        if entry is None:
            return False

        # Delete the pool file
        pool_path = videos_ep_dir / "pool" / entry.video_path
        if pool_path.exists():
            pool_path.unlink()

        # Remove from the index
        pool_index.videos = [v for v in pool_index.videos if v.id != pool_entry_id]

        # If this entry is the current assignment, clear it
        for beat_key, assigned_id in list(pool_index.beat_assignments.items()):
            if assigned_id == pool_entry_id:
                del pool_index.beat_assignments[beat_key]

        _save_video_pool_index_unlocked(pool_index, index_path)
    return True
