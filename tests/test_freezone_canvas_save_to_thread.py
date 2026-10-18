"""Verify that the async adapter of the synchronous canvas save does not block the event loop (B2-10).

`save_canvas` synchronously waits for the currently configured canvas write mutex and performs synchronous file I/O; async callers must
move the complete save path off the event loop through `save_canvas_async`. This module uses the fixed-frequency
retry of the CE file lock to create controllable contention; the file lock is only a test device and does not represent the wait algorithm or scope of other mutex implementations.

Test strategy:

1. Use an event-loop heartbeat to stand for work unrelated to the save; the heartbeat must keep advancing during lock contention.
2. Hold the file lock for 0.3 seconds, which both exposes synchronous blocking reliably and does not trigger the file lock's own wait cap.
3. Keep a control group of the synchronous call, proving that the same heartbeat probe is sensitive enough to blocking.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from pathlib import Path

import pytest

from novelvideo.freezone import canvas_store
from novelvideo.freezone.canvas_lock import CanvasLockBusy, canvas_write_lock

HOLD_SECONDS = 0.3
TICK_SECONDS = 0.01


def _seed_canvas(project_dir: Path) -> None:
    canvas_file = project_dir / "freezone" / "canvases" / "default.json"
    canvas_file.parent.mkdir(parents=True, exist_ok=True)
    canvas_file.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "canvas_id": "default",
                "project_id": "proj",
                "revision": 1,
                "nodes": [],
                "edges": [],
            }
        ),
        encoding="utf-8",
    )


def _save_kwargs() -> dict:
    return {
        "base_revision": 1,
        "build_payload": lambda _existing: {
            "schema_version": 2,
            "canvas_id": "default",
            "project_id": "proj",
            "revision": 2,
            "nodes": [{"id": "saved_off_loop"}],
            "edges": [],
        },
    }


def _hold_lock_for(project_dir: Path, seconds: float) -> tuple[threading.Thread, threading.Event]:
    """Another holder occupies the canvas lock for `seconds` seconds, simulating a contended save."""

    acquired = threading.Event()

    def hold() -> None:
        with canvas_write_lock(project_dir, "default"):
            acquired.set()
            time.sleep(seconds)

    holder = threading.Thread(target=hold, name="canvas-lock-holder")
    holder.start()
    assert acquired.wait(timeout=5.0)
    return holder, acquired


class _Heartbeat:
    """Ticks every 10ms on the event loop; when the loop is frozen it cannot tick even once."""

    def __init__(self) -> None:
        self.ticks = 0
        self._task: asyncio.Task | None = None

    async def __aenter__(self) -> "_Heartbeat":
        async def beat() -> None:
            while True:
                await asyncio.sleep(TICK_SECONDS)
                self.ticks += 1

        self._task = asyncio.create_task(beat())
        await asyncio.sleep(TICK_SECONDS * 2)
        return self

    async def __aexit__(self, *_exc) -> None:
        assert self._task is not None
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass


async def test_sync_save_canvas_freezes_the_event_loop(tmp_path: Path) -> None:
    """Control group: the synchronous call freezes the whole loop (the harm itself of Section 3.9 N3).

    This is **not** a behavior to be fixed -- `save_canvas` is still a synchronous function, and the CLI and backup process
    still call it directly as before (B2-8 CE behavior zero change). It is here to prove the heartbeat is measured sensitively enough.
    """

    project_dir = tmp_path / "project"
    _seed_canvas(project_dir)
    holder, _ = _hold_lock_for(project_dir, HOLD_SECONDS)

    async with _Heartbeat() as heartbeat:
        heartbeat.ticks = 0
        started = time.monotonic()
        result = canvas_store.save_canvas(project_dir, "default", **_save_kwargs())
        blocked_seconds = time.monotonic() - started

        assert result.payload["revision"] == 2
        assert blocked_seconds >= HOLD_SECONDS / 2
        assert heartbeat.ticks == 0

    holder.join(timeout=5.0)


async def test_save_canvas_async_keeps_the_event_loop_alive(tmp_path: Path) -> None:
    """The B2-10 criterion: when a save is contended, the event loop keeps advancing other work as usual."""

    project_dir = tmp_path / "project"
    _seed_canvas(project_dir)
    holder, _ = _hold_lock_for(project_dir, HOLD_SECONDS)

    async with _Heartbeat() as heartbeat:
        heartbeat.ticks = 0
        started = time.monotonic()
        result = await canvas_store.save_canvas_async(
            project_dir, "default", **_save_kwargs()
        )
        blocked_seconds = time.monotonic() - started

        assert result.payload["revision"] == 2
        assert blocked_seconds >= HOLD_SECONDS / 2
        # 0.3s / 10ms is about 30 ticks; even pressed down to 10, only "the loop did not stop" can reach it.
        assert heartbeat.ticks >= 10

    holder.join(timeout=5.0)
    assert json.loads(
        (project_dir / "freezone" / "canvases" / "default.json").read_text(encoding="utf-8")
    )["nodes"] == [{"id": "saved_off_loop"}]


async def test_save_canvas_async_returns_the_same_result_as_the_sync_call(
    tmp_path: Path,
) -> None:
    """The seam changes only the execution location, not the return shape (the premise of B2-6 zero HTTP contract change)."""

    async_dir = tmp_path / "async_project"
    sync_dir = tmp_path / "sync_project"
    _seed_canvas(async_dir)
    _seed_canvas(sync_dir)

    from_async = await canvas_store.save_canvas_async(async_dir, "default", **_save_kwargs())
    from_sync = canvas_store.save_canvas(sync_dir, "default", **_save_kwargs())

    assert type(from_async) is type(from_sync)
    assert from_async.payload == from_sync.payload
    assert from_async.response_cache == from_sync.response_cache
    assert from_async.idempotent == from_sync.idempotent


async def test_save_canvas_async_propagates_canvas_lock_busy(
    tmp_path: Path, monkeypatch
) -> None:
    """Negative: the error surface must not be wrapped or rewritten; `CanvasLockBusy` must come through as is.

    The 10 `except (CanvasStoreError, CanvasLockBusy)` in the routes rely on exactly this;
    if the seam replaces it with another exception (or wraps it in an `ExceptionGroup`), the 503 would become a 500.
    Stub the lock acquisition instead of really waiting out the full 3s spin -- the timeout itself is already covered by
    `tests/test_freezone_canvas_store.py:331`, and what is to be proven here is the pass-through.
    (The stubbing technique follows the existing shape of `tests/test_backup_files_sync.py:204`.)

    `TCP-EU-C4` moved lock acquisition behind the `canvas_write_mutex` port (B2 Section 3.8 version seam),
    and the stub point moved to the port accordingly (`TCP-P41`). What is to be proven has not changed by a word: when the lock cannot be acquired, what is thrown
    is still that very `CanvasLockBusy`, neither wrapped nor enclosed in an `ExceptionGroup`.
    """

    project_dir = tmp_path / "project"
    _seed_canvas(project_dir)

    class _BusyMutex:
        def write_mutex(self, *_args, **_kwargs):
            raise CanvasLockBusy("default")

    monkeypatch.setattr(canvas_store, "get_canvas_write_mutex", lambda: _BusyMutex())

    with pytest.raises(CanvasLockBusy) as excinfo:
        await canvas_store.save_canvas_async(project_dir, "default", **_save_kwargs())

    assert excinfo.value.canvas_id == "default"
