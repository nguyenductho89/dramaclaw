"""celery/EE zombie reaping: by a 40-minute TTL, not by process start time.

A celery worker is independent of the API process; once it is killed, the task stays in running forever, permanently holding that
task_key's dedup guard and concurrency quota, with neither reaping nor alerting. The inline axis (anything older than this process
start has necessarily been interrupted) does not hold for it, so a separate TTL axis is set up:
40min = task_time_limit 35min (EE celery_app.py:53) + 5min margin.

The inline axis behavior is in test_task_state_restart_reconcile.py; this file pins only the TTL axis,
and pins one by one that it must **not** spill over onto inline rows or terminal-state rows.
"""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sqlite3
import threading

import pytest
from fastapi import HTTPException

from novelvideo import task_state as task_state_module
from novelvideo.project_context import ProjectContext
from novelvideo.task_state import TaskStateManager

pytestmark = pytest.mark.m07

_ANCIENT = "2000-01-01T00:00:00.000000Z"


def _minutes_ago(minutes: int) -> str:
    """Same shape as utc_now_iso() (task_state.py:141-142), fractional digits not omitted."""
    stamp = (
        datetime.now(timezone.utc) - timedelta(minutes=minutes)
    ).isoformat().replace("+00:00", "Z")
    if "." not in stamp:
        stamp = stamp.replace("Z", ".000000Z")
    return stamp


def _ctx(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="proj_celery_ttl",
        project_name="demo",
        owner_type="user",
        owner_id="owner",
        owner_username="alice",
        requester_user_id="editor",
        requester_username="bob",
        requester_principals=(("user", "editor"),),
        effective_role="editor",
        home_node_id="node_a",
        output_dir=tmp_path / "output",
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
        is_home_node=True,
    )


def _backdate(
    manager: TaskStateManager,
    ctx: ProjectContext,
    task_id: str,
    minutes: int,
) -> None:
    stamp = _minutes_ago(minutes)
    with manager._connect_context(ctx) as conn:
        conn.execute(
            "UPDATE task_states SET updated_at = ?, created_at = ? WHERE task_id = ?",
            (stamp, stamp, task_id),
        )


def _restarted() -> TaskStateManager:
    """The sweep is memoized per DB on the manager instance; a new instance = simulating the first connection of a new process."""
    return TaskStateManager()


def _running_celery_task(
    manager: TaskStateManager,
    ctx: ProjectContext,
    scope: str,
) -> str:
    created = manager.create_task_for_project(
        ctx, "ingest_fast", 0, scope=scope, metadata={"backend": "celery"}
    )
    manager.update_progress_for_project(ctx, "ingest_fast", 0, progress=0.1, scope=scope)
    return created.task_id


def test_celery_running_task_past_ttl_is_failed(tmp_path: Path) -> None:
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    task_id = _running_celery_task(manager, ctx, "job_stale")
    _backdate(manager, ctx, task_id, minutes=41)
    manager = _restarted()

    listed = manager.list_tasks_for_project(ctx)

    assert len(listed) == 1
    assert listed[0].status == "failed"
    assert listed[0].error


def test_celery_running_task_within_ttl_is_untouched(tmp_path: Path) -> None:
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    task_id = _running_celery_task(manager, ctx, "job_fresh")
    _backdate(manager, ctx, task_id, minutes=39)
    manager = _restarted()

    listed = manager.list_tasks_for_project(ctx)

    assert len(listed) == 1
    assert listed[0].status == "running"


def test_celery_zombie_no_longer_blocks_reservation(tmp_path: Path) -> None:
    """This is the symptom in production: a zombie row holds the dedup guard and that business task can never be submitted again."""
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    task_id = _running_celery_task(manager, ctx, "job_reserve")
    _backdate(manager, ctx, task_id, minutes=41)
    manager = _restarted()

    state, reserved = manager.reserve_task_for_project(
        ctx, "ingest_fast", 0, scope="job_reserve", metadata={"backend": "celery"}
    )

    assert reserved is True
    assert state.task_id != task_id


def test_ttl_axis_does_not_reach_inline_rows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The TTL axis recognizes only celery. inline is still judged solely by the process start time axis (invariant 10).

    Backdate the process start time so a 41-minute-old inline row is **later** than the process start -- the inline axis
    must not touch it, and if the TTL axis forgot its backend filter it would sweep it away.
    """
    monkeypatch.setattr(task_state_module, "_PROCESS_STARTED_AT", _ANCIENT)
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    created = manager.create_task_for_project(
        ctx, "ingest_fast", 0, scope="job_inline", metadata={"backend": "inline"}
    )
    manager.update_progress_for_project(ctx, "ingest_fast", 0, progress=0.1, scope="job_inline")
    _backdate(manager, ctx, created.task_id, minutes=41)
    manager = _restarted()

    listed = manager.list_tasks_for_project(ctx)

    assert len(listed) == 1
    assert listed[0].status == "running"


def test_terminal_celery_row_past_ttl_is_untouched(tmp_path: Path) -> None:
    """Reaping targets only in-flight states; completed rows must not be rewritten as failed."""
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    created = manager.create_task_for_project(
        ctx, "ingest_fast", 0, scope="job_done", metadata={"backend": "celery"}
    )
    manager.complete_task_for_project(
        ctx, "ingest_fast", 0, result={"ok": True}, scope="job_done"
    )
    _backdate(manager, ctx, created.task_id, minutes=41)
    manager = _restarted()

    fetched = manager.get_task_for_project(ctx, "ingest_fast", 0, scope="job_done")

    assert fetched is not None
    assert fetched.status == "completed"


def test_ordinary_connections_still_auto_sweep_only_once(tmp_path: Path) -> None:
    class TrackingManager(TaskStateManager):
        def __init__(self) -> None:
            super().__init__()
            self.sweep_calls = 0

        def _sweep_stale_tasks_on_connection(self, conn) -> int | None:
            self.sweep_calls += 1
            return super()._sweep_stale_tasks_on_connection(conn)

    manager = TrackingManager()
    ctx = _ctx(tmp_path)

    manager.list_tasks_for_project(ctx)
    manager.list_tasks_for_project(ctx)

    assert manager.sweep_calls == 1


def test_explicit_project_sweep_rechecks_after_first_connection(tmp_path: Path) -> None:
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    manager.list_tasks_for_project(ctx)
    task_id = _running_celery_task(manager, ctx, "job_late_stale")
    _backdate(manager, ctx, task_id, minutes=41)

    changed = manager.sweep_stale_tasks_for_project(ctx)

    fetched = manager.get_task_for_project(ctx, "ingest_fast", 0, scope="job_late_stale")
    assert changed == 1
    assert fetched is not None
    assert fetched.status == "failed"


def test_explicit_sweep_rolls_back_partial_update_and_retries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    manager.list_tasks_for_project(ctx)
    inline_id = manager.create_task_for_project(
        ctx, "ingest_fast", 0, scope="job_partial_inline", metadata={"backend": "inline"}
    ).task_id
    manager.update_progress_for_project(
        ctx, "ingest_fast", 0, progress=0.1, scope="job_partial_inline"
    )
    celery_id = _running_celery_task(manager, ctx, "job_partial_celery")
    _backdate(manager, ctx, inline_id, minutes=41)
    _backdate(manager, ctx, celery_id, minutes=41)
    original = manager._sweep_stale_tasks_on_connection
    attempts = 0

    class OperationalErrorOnSecondExecuteConnection:
        def __init__(self, conn) -> None:
            self._conn = conn
            self._execute_calls = 0

        def execute(self, *args, **kwargs):
            self._execute_calls += 1
            if self._execute_calls == 2:
                raise sqlite3.OperationalError("database is busy")
            return self._conn.execute(*args, **kwargs)

        def __getattr__(self, name):
            return getattr(self._conn, name)

    def fail_once(conn) -> int | None:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return original(OperationalErrorOnSecondExecuteConnection(conn))
        return original(conn)

    monkeypatch.setattr(manager, "_sweep_stale_tasks_on_connection", fail_once)

    first_changed = manager.sweep_stale_tasks_for_project(ctx)

    assert first_changed is None
    assert manager.get_task_for_project(
        ctx, "ingest_fast", 0, scope="job_partial_inline"
    ).status == "running"
    assert manager.get_task_for_project(
        ctx, "ingest_fast", 0, scope="job_partial_celery"
    ).status == "running"

    second_changed = manager.sweep_stale_tasks_for_project(ctx)

    assert attempts == 2
    assert second_changed == 2
    assert manager.get_task_for_project(
        ctx, "ingest_fast", 0, scope="job_partial_inline"
    ).status == "failed"
    assert manager.get_task_for_project(
        ctx, "ingest_fast", 0, scope="job_partial_celery"
    ).status == "failed"


def test_concurrent_explicit_project_sweeps_are_serialized(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    manager.list_tasks_for_project(ctx)
    task_id = _running_celery_task(manager, ctx, "job_concurrent_stale")
    _backdate(manager, ctx, task_id, minutes=41)
    original = manager._sweep_stale_tasks_on_connection
    counters_lock = threading.Lock()
    first_entered = threading.Event()
    later_entered = threading.Event()
    release_first = threading.Event()
    active = 0
    max_active = 0
    calls = 0

    def tracked(conn) -> int | None:
        nonlocal active, calls, max_active
        with counters_lock:
            calls += 1
            call_number = calls
            active += 1
            max_active = max(max_active, active)
        if call_number == 1:
            first_entered.set()
            assert release_first.wait(timeout=2)
        else:
            later_entered.set()
        try:
            return original(conn)
        finally:
            with counters_lock:
                active -= 1

    monkeypatch.setattr(manager, "_sweep_stale_tasks_on_connection", tracked)

    with ThreadPoolExecutor(max_workers=4) as pool:
        first = pool.submit(manager.sweep_stale_tasks_for_project, ctx)
        assert first_entered.wait(timeout=2)
        remaining = [pool.submit(manager.sweep_stale_tasks_for_project, ctx) for _ in range(3)]
        assert not later_entered.wait(timeout=0.2)
        release_first.set()
        results = [first.result(timeout=2), *(future.result(timeout=2) for future in remaining)]

    fetched = manager.get_task_for_project(ctx, "ingest_fast", 0, scope="job_concurrent_stale")
    assert max_active == 1
    assert sorted(results) == [0, 0, 0, 1]
    assert fetched is not None
    assert fetched.status == "failed"


def test_busy_project_does_not_block_already_swept_other_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = TaskStateManager()
    ctx_a = replace(_ctx(tmp_path / "a"), project_id="project_a")
    ctx_b = replace(_ctx(tmp_path / "b"), project_id="project_b")
    manager.list_tasks_for_project(ctx_b)
    original = manager._sweep_stale_tasks_on_connection
    a_started = threading.Event()
    release_a = threading.Event()

    def block_project_a(conn) -> int | None:
        db_path = Path(conn.execute("PRAGMA database_list").fetchone()[2]).resolve()
        if db_path == (ctx_a.state_dir / "data.db").resolve():
            a_started.set()
            assert release_a.wait(timeout=2)
        return original(conn)

    monkeypatch.setattr(manager, "_sweep_stale_tasks_on_connection", block_project_a)

    with ThreadPoolExecutor(max_workers=2) as pool:
        sweep_a = pool.submit(manager.sweep_stale_tasks_for_project, ctx_a)
        assert a_started.wait(timeout=2)
        read_b = pool.submit(manager.list_tasks_for_project, ctx_b)
        try:
            assert read_b.result(timeout=0.5) == []
        finally:
            release_a.set()
            assert sweep_a.result(timeout=2) == 0


def test_explicit_project_sweep_requires_home_node(tmp_path: Path) -> None:
    manager = TaskStateManager()
    ctx = replace(_ctx(tmp_path), is_home_node=False)

    with pytest.raises(HTTPException) as exc_info:
        manager.sweep_stale_tasks_for_project(ctx)

    assert exc_info.value.status_code == 409
