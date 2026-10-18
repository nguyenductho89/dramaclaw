"""Canvas saves on the HTTP path must move off the event loop through the async adapter.

`save_canvas` synchronously waits for the currently configured canvas write mutex and performs synchronous file I/O. The four async HTTP
handlers must `await canvas_store.save_canvas_async(...)` and must not call the synchronous
`save_canvas` directly; the mutex wait algorithm and scope are decided by the injected port implementation and are not part of this module's contract.

Division of labor between the two cases:

1. `test_put_canvas_keeps_the_event_loop_alive_while_lock_is_held` -- real lock contention
   + the real handler, proving that the place at `:11639` really goes through a thread. The heartbeat probe reuses the shape of
   `tests/test_freezone_canvas_save_to_thread.py`, whose control group
   `test_sync_save_canvas_freezes_the_event_loop` has already proven it sensitive enough
   (under the synchronous path the heartbeat is exactly 0 ticks).
2. `test_freezone_routes_never_call_save_canvas_synchronously` -- an AST invariant,
   pinning down the other three places as well (`:10868` / `:11055` / `:11193`, whose request bodies have to run through the whole preset /
   projection assembly before they reach the save) and guarding against regression. Patterned on
   `tests/test_billing_fatal_predicate_invariant.py:19`.
"""

from __future__ import annotations

import ast
import asyncio
import json
import threading
import time
from pathlib import Path

import pytest

from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.api.schemas import CanvasPayload
from novelvideo.freezone.canvas_lock import canvas_write_lock
from novelvideo.project_context import ProjectContext

HOLD_SECONDS = 0.3
TICK_SECONDS = 0.01

ROUTES_SOURCE = Path("src/novelvideo/api/routes/freezone.py")


def _project_ctx(tmp_path: Path) -> ProjectContext:
    """Follows the existing shape of `tests/test_freezone_image_backend.py:53`."""

    return ProjectContext(
        project_id="proj_freezone",
        project_name="demo",
        owner_type="user",
        owner_id="owner_1",
        owner_username="admin",
        requester_user_id="owner_1",
        requester_username="admin",
        requester_principals=(("user", "owner_1"),),
        effective_role="editor",
        home_node_id="node_a",
        output_dir=tmp_path / "output" / "admin" / "demo",
        state_dir=tmp_path / "state" / "admin" / "demo",
        runtime_dir=tmp_path / "runtime" / "admin" / "demo",
        is_home_node=True,
    )


def _patch_freezone_project(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Stub project resolution, returning the directory where the canvas is really written (`:9581` takes `ctx.state_dir`)."""

    ctx = _project_ctx(tmp_path)

    async def fake_resolve_freezone_project(*_args, **_kwargs):
        return ctx, "admin", "58", tmp_path / "project", str(tmp_path / "output")

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", fake_resolve_freezone_project)
    return Path(ctx.state_dir)


def _seed_canvas(canvas_project_dir: Path) -> Path:
    canvas_file = canvas_project_dir / "freezone" / "canvases" / "default.json"
    canvas_file.parent.mkdir(parents=True, exist_ok=True)
    canvas_file.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "canvas_id": "default",
                "project_id": "proj_freezone",
                "canvas_scope": "default",
                "revision": 1,
                "nodes": [{"id": "old"}],
                "edges": [],
                "metadata": {},
            }
        ),
        encoding="utf-8",
    )
    return canvas_file


def _hold_lock_for(canvas_project_dir: Path, seconds: float) -> threading.Thread:
    """Another holder occupies the canvas lock, simulating a contended save."""

    acquired = threading.Event()

    def hold() -> None:
        with canvas_write_lock(canvas_project_dir, "default"):
            acquired.set()
            time.sleep(seconds)

    holder = threading.Thread(target=hold, name="canvas-lock-holder")
    holder.start()
    assert acquired.wait(timeout=5.0)
    return holder


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


async def test_put_canvas_keeps_the_event_loop_alive_while_lock_is_held(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The `:11639` criterion: when a save is contended, other work on the same worker keeps advancing as usual."""

    canvas_project_dir = _patch_freezone_project(monkeypatch, tmp_path)
    canvas_file = _seed_canvas(canvas_project_dir)
    holder = _hold_lock_for(canvas_project_dir, HOLD_SECONDS)

    async with _Heartbeat() as heartbeat:
        heartbeat.ticks = 0
        started = time.monotonic()
        result = await freezone_routes.put_canvas(
            project="proj_freezone",
            canvas_id="default",
            body=CanvasPayload(
                nodes=[{"id": "saved_off_loop"}],
                edges=[],
                metadata={},
                base_revision=1,
            ),
            user={"username": "admin", "id": "owner_1"},
        )
        blocked_seconds = time.monotonic() - started

        assert result["data"]["revision"] == 2
        assert blocked_seconds >= HOLD_SECONDS / 2
        # 0.3s / 10ms is about 30 ticks; even pressed down to 10, only "the loop did not stop" can reach it.
        assert heartbeat.ticks >= 10

    holder.join(timeout=5.0)
    assert json.loads(canvas_file.read_text(encoding="utf-8"))["nodes"] == [
        {"id": "saved_off_loop"}
    ]


def test_freezone_routes_never_call_save_canvas_synchronously() -> None:
    """All four call sites must be `await canvas_store.save_canvas_async(...)`.

    The `save_canvas` itself remains and is still a synchronous function (B2-8: the CLI / backup process still call it directly),
    and this case concerns only the route module.
    """

    tree = ast.parse(ROUTES_SOURCE.read_text(encoding="utf-8"), filename=str(ROUTES_SOURCE))

    sync_calls: list[int] = []
    awaited_async_calls: list[int] = []
    bare_async_calls: list[int] = []

    awaited = {
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Await) and isinstance(node.value, ast.Call)
    }
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        if node.func.attr == "save_canvas":
            sync_calls.append(node.lineno)
        elif node.func.attr == "save_canvas_async":
            (awaited_async_calls if node in awaited else bare_async_calls).append(node.lineno)

    assert sync_calls == []
    assert bare_async_calls == []
    assert len(awaited_async_calls) == 4
