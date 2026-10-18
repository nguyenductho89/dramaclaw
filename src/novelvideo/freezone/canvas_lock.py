"""File lock helpers for Freezone canvas state."""

from __future__ import annotations

import os
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import portalocker

from novelvideo.freezone.paths import CANVAS_ID_RE, canvases_dir

# Switch for timing instrumentation of the critical section; off by default (in single-node CE every save would add a stdout line of noise).
# The channel is print(flush=True) rather than logging: the api process root logger is never configured,
# so INFO is dropped at the logger layer, and celery only takes over root inside the worker. stdout is the only channel that behaves identically
# across the three processes that take the lock (api / celery worker / backup CLI).
_TIMING = os.environ.get("ST_CANVAS_LOCK_TIMING") == "1"


class CanvasLockBusy(RuntimeError):
    """Raised when a canvas write lock cannot be acquired quickly."""

    def __init__(self, canvas_id: str):
        super().__init__(f"canvas lock busy: {canvas_id}")
        self.canvas_id = canvas_id


def canvas_locks_dir(project_dir: Path) -> Path:
    return canvases_dir(project_dir) / "_locks"


def canvas_lock_path(project_dir: Path, canvas_id: str) -> Path:
    if not CANVAS_ID_RE.match(canvas_id):
        raise ValueError(f"invalid canvas_id: {canvas_id!r}")
    return canvas_locks_dir(project_dir) / f"{canvas_id}.lock"


@contextmanager
def canvas_write_lock(
    project_dir: Path,
    canvas_id: str,
    *,
    timeout_seconds: float = 3.0,
    retry_interval_seconds: float = 0.02,
) -> Iterator[None]:
    """Acquire a short-lived exclusive lock for one canvas.

    Lock files are intentionally left in place. Removing a lock file while
    another process may hold it can create a second inode for the same logical
    canvas lock.
    """

    path = canvas_lock_path(project_dir, canvas_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    deadline = started + timeout_seconds
    with path.open("a+", encoding="utf-8") as fh:
        while True:
            try:
                portalocker.lock(fh, portalocker.LOCK_EX | portalocker.LOCK_NB)
                break
            except portalocker.exceptions.AlreadyLocked as exc:
                # Retry only on contention (EAGAIN/ERROR_LOCK_VIOLATION); other lock failures
                # (e.g. a mount that does not support locks) are re-raised immediately and must not be disguised as CanvasLockBusy.
                if time.monotonic() >= deadline:
                    raise CanvasLockBusy(canvas_id) from exc
                time.sleep(retry_interval_seconds)
        acquired = time.monotonic()
        try:
            yield
        finally:
            portalocker.unlock(fh)
            if _TIMING:
                print(
                    f"canvas.lock canvas_id={canvas_id} "
                    f"wait_ms={(acquired - started) * 1000:.1f} "
                    f"held_ms={(time.monotonic() - acquired) * 1000:.1f}",
                    flush=True,
                )
