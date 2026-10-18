"""Local canvas write mutex adapter: today's file lock, verbatim unchanged.

CE is a single-machine deployment, where `flock` is the complete answer (B2-9: lock semantics unchanged, `canvas_lock.py`
not deleted). This adapter merely fits the existing `canvas_write_lock` into the shape of the port and adds
no behavior at all: the same lock file, the same spin, the same `CanvasLockBusy`.
"""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from novelvideo.freezone.canvas_lock import canvas_write_lock

# Default wait cap of `canvas_write_lock`. It is written here so that "no timeout passed" has a readable
# source; changing this number does not change CE behavior, because what is explicitly passed below is the same value.
FILE_LOCK_WAIT_SECONDS = 3.0


class FileLockCanvasWriteGuard:
    """A file lock is not lost midway, so the fence has nothing to do."""

    def reassert(self) -> None:
        return None


class FileLockCanvasWriteMutex:
    @contextmanager
    def write_mutex(
        self,
        project_dir: Path,
        canvas_id: str,
        *,
        actor: str | None = None,
        timeout_seconds: float | None = None,
    ) -> Iterator[FileLockCanvasWriteGuard]:
        _ = actor  # A file lock does not record who holds it: the lifetime of the lock is the lifetime of the process.
        with canvas_write_lock(
            project_dir,
            canvas_id,
            timeout_seconds=(
                FILE_LOCK_WAIT_SECONDS if timeout_seconds is None else timeout_seconds
            ),
        ):
            yield FileLockCanvasWriteGuard()
