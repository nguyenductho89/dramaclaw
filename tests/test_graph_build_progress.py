"""Progress-reporting semantics of the graph-build task.

The graph-build on_log callback itself carries no progress. An early implementation called _progress with a 0.0 placeholder, so
every ordinary log line reset the progress to 0, and the frontend progress bar jumped back and forth between 10% -> 0% -> 80% -> 0%.
Log lines must pass progress=None so the task state keeps its existing progress.
"""

from pathlib import Path

import pytest

from novelvideo.project_context import ProjectContext
from novelvideo.task_state import TaskStateManager

pytestmark = pytest.mark.m07


def _ctx(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="proj_graph_build",
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


class _RecordingTaskManager:
    def __init__(self) -> None:
        self.updates: list[dict] = []

    def update_progress_for_project(self, ctx, task_type, episode, **kwargs):
        self.updates.append({"task_type": task_type, "episode": episode, **kwargs})


class _FakeStore:
    """Alternate progress and logs in the real call order."""

    def __init__(self) -> None:
        self.closed = False

    async def _emit(self, on_progress, on_log):
        on_progress(0.1, "Read graph")
        on_log("Cache hit")
        on_progress(0.8, "Write to database")
        on_log("Skipped 3 duplicate records")
        return [{"name": "a"}]

    async def build_scenes_from_graph(self, on_progress, on_log):
        return await self._emit(on_progress, on_log)

    async def build_characters_from_graph(self, on_progress, on_log):
        return await self._emit(on_progress, on_log)

    async def close(self) -> None:
        self.closed = True


@pytest.mark.parametrize(
    ("runner_name", "task_type"),
    [
        ("_run_build_scenes", "build_scenes"),
        ("_run_build_characters", "build_characters"),
    ],
)
async def test_log_updates_do_not_reset_progress(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    runner_name: str,
    task_type: str,
) -> None:
    from novelvideo.task_backend.runners import graph_build

    manager = _RecordingTaskManager()
    store = _FakeStore()

    async def fake_load_store(_ctx):
        return store

    monkeypatch.setattr(graph_build, "get_task_manager", lambda: manager)
    monkeypatch.setattr(graph_build, "_load_store", fake_load_store)
    monkeypatch.setattr(graph_build, "require_imported_novel", lambda _dir: None)

    await getattr(graph_build, runner_name)(_ctx(tmp_path))

    assert store.closed
    assert [u["task_type"] for u in manager.updates] == [task_type] * 4
    # Key assertion: log lines pass None (keep the existing progress), not 0.0 (which resets progress to the origin).
    assert [u["progress"] for u in manager.updates] == [0.1, None, 0.8, None]
    # The step text and logs are still updated as usual.
    assert [u["current_task"] for u in manager.updates] == [
        "Read graph",
        "Cache hit",
        "Write to database",
        "Skipped 3 duplicate records",
    ]


def test_update_progress_with_none_keeps_stored_progress(tmp_path: Path) -> None:
    """Manager-side contract the runner relies on: progress=None leaves the stored progress untouched."""
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    manager.create_task_for_project(ctx, "build_scenes", 0)
    manager.update_progress_for_project(
        ctx, "build_scenes", 0, progress=0.8, current_task="Write to database"
    )

    manager.update_progress_for_project(
        ctx, "build_scenes", 0, progress=None, current_task="Skipped 3 duplicate records"
    )

    task = manager.get_task_for_project(ctx, "build_scenes", 0)
    assert task is not None
    assert task.progress == 0.8
    assert task.current_task == "Skipped 3 duplicate records"
