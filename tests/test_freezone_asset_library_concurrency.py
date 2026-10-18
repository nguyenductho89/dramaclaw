"""Asset library concurrent write-back regression: when several API worker processes register assets at once, none may be lost.

Earlier add_video_character_library_item was lock-free "read the whole JSON -> append -> write the whole thing back",
uploading 4 images at once made every worker read the same stale list, with the later write washing out the earlier one, leaving only 1-2 in the library.
"""

import multiprocessing
from pathlib import Path

import pytest

from novelvideo.freezone import video_node
from novelvideo.freezone.video_node import (
    add_video_character_folder,
    add_video_character_library_item,
    load_video_character_folders,
    load_video_character_library,
)

WORKERS = 8


def _add_item(project_dir: str, index: int, barrier) -> None:
    barrier.wait(timeout=30)
    add_video_character_library_item(
        Path(project_dir), name=f"img{index}", image_urls=[f"/static/img{index}.png"]
    )


def _add_folder(project_dir: str, index: int, barrier) -> None:
    barrier.wait(timeout=30)
    add_video_character_folder(Path(project_dir), name=f"folder{index}")


def _run_concurrently(target, project_dir: Path) -> None:
    context = multiprocessing.get_context("spawn")
    barrier = context.Barrier(WORKERS)
    processes = [
        context.Process(target=target, args=(str(project_dir), index, barrier))
        for index in range(WORKERS)
    ]
    for process in processes:
        process.start()
    for process in processes:
        process.join(timeout=60)
        assert not process.is_alive()
        assert process.exitcode == 0


def test_concurrent_library_item_adds_across_processes_keep_every_item(
    tmp_path: Path,
) -> None:
    _run_concurrently(_add_item, tmp_path)

    names = sorted(item["name"] for item in load_video_character_library(tmp_path))
    assert names == sorted(f"img{index}" for index in range(WORKERS))


def test_concurrent_folder_creates_across_processes_keep_every_folder(
    tmp_path: Path,
) -> None:
    _run_concurrently(_add_folder, tmp_path)

    names = sorted(folder["name"] for folder in load_video_character_folders(tmp_path))
    assert names == sorted(f"folder{index}" for index in range(WORKERS))


def test_library_save_leaves_no_temp_files(tmp_path: Path) -> None:
    add_video_character_library_item(tmp_path, name="a", image_urls=["/static/a.png"])
    add_video_character_folder(tmp_path, name="f")

    leftovers = [
        p.name for p in (tmp_path / "freezone").iterdir() if p.suffix == ".tmp"
    ]
    assert leftovers == []


def test_library_write_never_proceeds_without_the_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When the lock is held by someone else, the write must wait until it errors, and must not bypass the lock and write directly.

    Earlier, on platforms without fcntl (Windows), _library_lock was a no-op, and multiple processes still overwrote one another.
    """
    monkeypatch.setattr(video_node, "_LIBRARY_LOCK_TIMEOUT_SECONDS", 0.2)

    with video_node._library_lock(tmp_path):
        with pytest.raises(TimeoutError):
            add_video_character_folder(tmp_path, name="blocked")

    assert load_video_character_folders(tmp_path) == []
    assert not hasattr(video_node, "fcntl")
