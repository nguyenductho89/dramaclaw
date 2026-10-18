"""Zombie reaping of inline tasks after a service restart.

The worker of the inline backend dies with the API process: an inline task still marked submitting/queued/running
from before the process start time has necessarily been interrupted, and the read path should
mark it failed, so a zombie task does not permanently block new tasks (dedup guard / concurrency limit).
A Celery/EE worker is independent of the API process, and **this process-start-time rule must never apply to it**;
it is reaped by its own 40min TTL, and that axis is in test_task_state_celery_zombie_ttl.py.
"""

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from novelvideo.project_context import ProjectContext
from novelvideo.task_state import TaskStateManager

pytestmark = pytest.mark.m07

_ANCIENT = "2000-01-01T00:00:00.000000Z"


def _ctx(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="proj_reconcile",
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


def _before_process_start_within_celery_ttl() -> str:
    """Older than this process start, but not yet past celery's 40min TTL (CELERY_STALE_TTL).

    Used to separate the two axes: a celery row inside this window is touched only by the "process start time" rule
    -- which must not touch it.
    """
    stamp = (
        datetime.now(timezone.utc) - timedelta(minutes=39)
    ).isoformat().replace("+00:00", "Z")
    if "." not in stamp:
        stamp = stamp.replace("Z", ".000000Z")
    return stamp


def _backdate(
    manager: TaskStateManager,
    ctx: ProjectContext,
    task_id: str,
    when: str = _ANCIENT,
) -> None:
    with manager._connect_context(ctx) as conn:
        conn.execute(
            "UPDATE task_states SET updated_at = ?, created_at = ? WHERE task_id = ?",
            (when, when, task_id),
        )


def _restarted() -> TaskStateManager:
    """The sweep is memoized per DB on the manager instance; a new instance = a process after a restart."""
    return TaskStateManager()


def test_stale_inline_running_task_is_failed_on_read(tmp_path: Path) -> None:
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    created = manager.create_task_for_project(
        ctx, "ingest_fast", 0, scope="job_1", metadata={"backend": "inline"}
    )
    manager.update_progress_for_project(ctx, "ingest_fast", 0, progress=0.1, scope="job_1")
    _backdate(manager, ctx, created.task_id)
    manager = _restarted()

    listed = manager.list_tasks_for_project(ctx)

    assert len(listed) == 1
    assert listed[0].status == "failed"
    assert "restarted" in (listed[0].error or "")

    fetched = manager.get_task_for_project(ctx, "ingest_fast", 0, scope="job_1")
    assert fetched is not None
    assert fetched.status == "failed"


def test_stale_celery_running_task_is_untouched(tmp_path: Path) -> None:
    """A celery row older than the process start must not be touched by this rule either (it has its own TTL axis)."""
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    created = manager.create_task_for_project(
        ctx, "ingest_fast", 0, scope="job_celery", metadata={"backend": "celery"}
    )
    manager.update_progress_for_project(ctx, "ingest_fast", 0, progress=0.1, scope="job_celery")
    _backdate(manager, ctx, created.task_id, when=_before_process_start_within_celery_ttl())
    manager = _restarted()

    listed = manager.list_tasks_for_project(ctx)

    assert len(listed) == 1
    assert listed[0].status == "running"


def test_fresh_inline_running_task_is_untouched(tmp_path: Path) -> None:
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    manager.create_task_for_project(
        ctx, "ingest_fast", 0, scope="job_fresh", metadata={"backend": "inline"}
    )
    manager.update_progress_for_project(ctx, "ingest_fast", 0, progress=0.1, scope="job_fresh")

    listed = manager.list_tasks_for_project(ctx)

    assert len(listed) == 1
    assert listed[0].status == "running"


def test_stale_inline_task_unblocks_reservation(tmp_path: Path) -> None:
    """The admission gate (reserve) must also not see zombies, otherwise retrying a submission after a restart is still rejected by the dedup guard."""
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    created = manager.create_task_for_project(
        ctx, "ingest_fast", 0, scope="job_r", metadata={"backend": "inline"}
    )
    manager.update_progress_for_project(ctx, "ingest_fast", 0, progress=0.1, scope="job_r")
    _backdate(manager, ctx, created.task_id)
    manager = _restarted()

    state, reserved = manager.reserve_task_for_project(
        ctx, "ingest_fast", 0, scope="job_r", metadata={"backend": "inline"}
    )

    assert reserved is True
    assert state.task_id != created.task_id


def test_sweep_runs_once_per_db_by_design(tmp_path: Path) -> None:
    """The sweep is memoized per DB: a newly appeared "expired" row after process start is no longer swept (only leftovers from before start are zombies)."""
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    first = manager.create_task_for_project(
        ctx, "ingest_fast", 0, scope="job_a", metadata={"backend": "inline"}
    )
    _backdate(manager, ctx, first.task_id)
    manager = _restarted()
    assert manager.list_tasks_for_project(ctx)[0].status == "failed"

    second = manager.create_task_for_project(
        ctx, "ingest_fast", 0, scope="job_b", metadata={"backend": "inline"}
    )
    manager.update_progress_for_project(ctx, "ingest_fast", 0, progress=0.1, scope="job_b")
    _backdate(manager, ctx, second.task_id)

    statuses = {t.scope: t.status for t in manager.list_tasks_for_project(ctx)}
    assert statuses["job_b"] == "running"


def test_stale_inline_task_no_longer_blocks_active_count(tmp_path: Path) -> None:
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    created = manager.create_task_for_project(
        ctx, "ingest_fast", 0, scope="job_2", metadata={"backend": "inline"}
    )
    manager.update_progress_for_project(ctx, "ingest_fast", 0, progress=0.1, scope="job_2")
    _backdate(manager, ctx, created.task_id)
    manager = _restarted()

    assert manager.count_active_tasks_for_project(ctx) == 0
