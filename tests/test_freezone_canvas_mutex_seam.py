"""TCP-EU-C4 · the version seam of the canvas mutex + the write-to-disk fence (CE half).

Design source of truth `docs/org-billing-ai-development/task-control-plane/B2-canvas-placement-free.md`
Section 3.3.3 (write-to-disk fence), Section 3.7 (swap the context manager, do not rewrite `save_canvas`), Section 3.8 (version seam).

This module proves only three things on the **CE side**, touching not a single Postgres:

1. The seam exists and **degrades by default to today's file lock** -- the rollback action is "do not inject the EE implementation" (Section 6.4 step 5),
   so "not injected" must be a legal state with behavior identical to today to the letter (B2-8/B2-9).
2. The `fence=` of `atomic_write_json` lands between "the temp file has been fsynced" and "`os.replace` has not happened yet"
   (Section 3.3.3). Moving it one line means no fence at all, so this uses **observing the landing point** rather than observing the call count.
3. A **static assertion** of fence coverage: every write path of `atomic_write_json` either carries `fence=`,
   or is explicitly exempted in the table of Section 3.3.3; in addition, `soft_delete_canvas`'s
   `path.replace(target)` (the irreversible write that does not go through `atomic_write_json`) must be explicitly fenced beforehand.

The EE lease implementation, spin contract and cross-process criteria are in the EE repo `tests/b2b/test_canvas_write_lease_client.py`.
"""

from __future__ import annotations

import ast
import inspect
import json
from contextlib import contextmanager
from pathlib import Path

import pytest

from novelvideo.freezone import canvas_store
from novelvideo.freezone.canvas_lock import CanvasLockBusy, canvas_write_lock
from novelvideo.ports import get_canvas_write_mutex
from novelvideo.ports import registry as ports_registry
from novelvideo.ports.canvas_mutex import CanvasLeaseLost
from novelvideo.ports.local.canvas_mutex import FileLockCanvasWriteMutex


# ---------------------------------------------------------------------------
# Test stand-in: a bookkeeping mutex port. It does no mutual exclusion -- what this module proves is "the seam calls everything
# it should", while the real mutual exclusion semantics belong to the cases in the EE repo.
# ---------------------------------------------------------------------------


class _RecordingGuard:
    def __init__(self, mutex: "_RecordingMutex", canvas_id: str) -> None:
        self._mutex = mutex
        self._canvas_id = canvas_id

    def reassert(self) -> None:
        self._mutex.fence_calls.append(self._canvas_id)
        if self._mutex.fence_error is not None:
            raise self._mutex.fence_error


class _RecordingMutex:
    def __init__(self, *, fence_error: Exception | None = None) -> None:
        self.entered: list[tuple[Path, str]] = []
        self.exited: list[tuple[Path, str]] = []
        self.fence_calls: list[str] = []
        self.fence_error = fence_error

    @contextmanager
    def write_mutex(self, project_dir: Path, canvas_id: str, **_kwargs):
        self.entered.append((Path(project_dir), canvas_id))
        try:
            yield _RecordingGuard(self, canvas_id)
        finally:
            self.exited.append((Path(project_dir), canvas_id))


@pytest.fixture()
def injected_mutex():
    """Inject a bookkeeping port, and restore the registry to its original state after the test."""

    previous = ports_registry._PORTS.get("canvas_write_mutex")

    def _install(mutex: _RecordingMutex) -> _RecordingMutex:
        ports_registry.register_port("canvas_write_mutex", mutex)
        return mutex

    try:
        yield _install
    finally:
        if previous is None:
            ports_registry._PORTS.pop("canvas_write_mutex", None)
        else:
            ports_registry.register_port("canvas_write_mutex", previous)


def _seed_canvas(
    project_dir: Path, canvas_id: str = "default", revision: int = 1
) -> Path:
    path = project_dir / "freezone" / "canvases" / f"{canvas_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"revision": revision, "nodes": [{"id": "seed"}], "edges": []}),
        encoding="utf-8",
    )
    return path


# ---------------------------------------------------------------------------
# Error surface: `CanvasLeaseLost` inherits `CanvasLockBusy`, so the routes need zero changes (Section 3.3.3)
# ---------------------------------------------------------------------------


def test_canvas_lease_lost_is_a_canvas_lock_busy() -> None:
    assert issubclass(CanvasLeaseLost, CanvasLockBusy)

    exc = CanvasLeaseLost("default")

    assert exc.canvas_id == "default"
    # Still distinguishable by type: logs and cases must be able to count "could not get the lease" separately from "lost the lease halfway through the write".
    assert str(exc) != str(CanvasLockBusy("default"))


# ---------------------------------------------------------------------------
# Seam: degrades by default to today's file lock (rollback = do not inject)
# ---------------------------------------------------------------------------


def test_canvas_write_mutex_defaults_to_the_file_lock() -> None:
    assert isinstance(get_canvas_write_mutex(), FileLockCanvasWriteMutex)


def test_ce_canvas_mutex_signature_has_no_catch_all_kwargs() -> None:
    parameters = inspect.signature(
        FileLockCanvasWriteMutex.write_mutex
    ).parameters.values()

    assert all(
        parameter.kind is not inspect.Parameter.VAR_KEYWORD for parameter in parameters
    )


def test_canvas_write_mutex_is_not_an_ee_required_port() -> None:
    # Being put into `_EE_REQUIRED_PORTS` would mean "a build without the EE adapter refuses to start",
    # which directly conflicts with the rollback convention of Section 6.4 step 5 (do not inject the EE implementation).
    assert "canvas_write_mutex" not in ports_registry._EE_REQUIRED_PORTS


def test_ce_fence_is_a_no_op(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    mutex = FileLockCanvasWriteMutex()

    with mutex.write_mutex(project_dir, "default") as guard:
        # flock is never lost midway, so the CE fence does nothing (Section 3.7).
        assert guard.reassert() is None
        assert guard.reassert() is None


def test_ce_still_excludes_with_the_file_lock(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    mutex = FileLockCanvasWriteMutex()

    with mutex.write_mutex(project_dir, "default", timeout_seconds=0.01):
        with pytest.raises(CanvasLockBusy):
            with canvas_write_lock(
                project_dir,
                "default",
                timeout_seconds=0.01,
                retry_interval_seconds=0.001,
            ):
                pass


def test_save_canvas_behaviour_is_byte_identical_without_injection(
    tmp_path: Path,
) -> None:
    project_dir = tmp_path / "project"
    canvas_file = _seed_canvas(project_dir)

    result = canvas_store.save_canvas(
        project_dir,
        "default",
        base_revision=1,
        build_payload=lambda _existing: {
            "revision": 2,
            "nodes": [{"id": "n"}],
            "edges": [],
        },
    )

    assert result.payload["revision"] == 2
    assert json.loads(canvas_file.read_text(encoding="utf-8"))["revision"] == 2
    # When not injected, the lock file is still the CE one (B2-9).
    assert (project_dir / "freezone" / "canvases" / "_locks" / "default.lock").exists()


# ---------------------------------------------------------------------------
# Seam: all four lock acquisition points are switched to go through the port
# ---------------------------------------------------------------------------


def test_save_canvas_takes_the_injected_mutex(tmp_path: Path, injected_mutex) -> None:
    project_dir = tmp_path / "project"
    _seed_canvas(project_dir)
    mutex = injected_mutex(_RecordingMutex())

    canvas_store.save_canvas(
        project_dir,
        "default",
        base_revision=1,
        build_payload=lambda _existing: {
            "revision": 2,
            "nodes": [{"id": "n"}],
            "edges": [],
        },
    )

    assert mutex.entered == [(project_dir, "default")]
    assert mutex.exited == [(project_dir, "default")]
    # After injection the CE lock file is no longer created -- the port replaces the whole mutual exclusion mechanism, not layered on top.
    assert not (project_dir / "freezone" / "canvases" / "_locks").exists()


def test_ensure_default_canvas_takes_the_injected_mutex(
    tmp_path: Path, injected_mutex
) -> None:
    project_dir = tmp_path / "project"
    mutex = injected_mutex(_RecordingMutex())

    canvas_store.ensure_default_canvas(
        project_dir, project_id="proj", actor_id="owner_1"
    )

    assert mutex.entered == [(project_dir, "default")]


def test_restore_canvas_version_takes_the_injected_mutex(
    tmp_path: Path, injected_mutex
) -> None:
    project_dir = tmp_path / "project"
    canvas_file = _seed_canvas(project_dir)
    history = (
        canvas_file.parent / "_history" / "default.rev1.20260813_101010_000001.json"
    )
    history.parent.mkdir(parents=True, exist_ok=True)
    history.write_text(
        json.dumps({"revision": 1, "nodes": [{"id": "old"}], "edges": []}),
        encoding="utf-8",
    )
    mutex = injected_mutex(_RecordingMutex())

    canvas_store.restore_canvas_version(
        project_dir,
        "default",
        history_id=history.stem,
        base_revision=1,
        build_payload=lambda _existing, snapshot: {**snapshot, "revision": 2},
    )

    assert mutex.entered == [(project_dir, "default")]


def test_soft_delete_canvas_takes_the_injected_mutex(
    tmp_path: Path, injected_mutex
) -> None:
    project_dir = tmp_path / "project"
    _seed_canvas(project_dir)
    mutex = injected_mutex(_RecordingMutex())

    canvas_store.soft_delete_canvas(project_dir, "default", deleted_by="alice")

    assert mutex.entered == [(project_dir, "default")]


# ---------------------------------------------------------------------------
# Fence: landing point, hit, lost lease
# ---------------------------------------------------------------------------


def test_fence_runs_after_fsync_and_before_replace(tmp_path: Path) -> None:
    path = tmp_path / "canvas.json"
    path.write_text(json.dumps({"revision": 1}), encoding="utf-8")
    observed: dict[str, object] = {}

    def fence() -> None:
        observed["target"] = json.loads(path.read_text(encoding="utf-8"))
        observed["tmp_files"] = sorted(
            p.name for p in tmp_path.glob(".canvas.json.*.tmp")
        )

    canvas_store.atomic_write_json(path, {"revision": 2}, fence=fence)

    # While the fence runs: the temp file is already on disk (fsynced), and the real file has not been touched by a single byte.
    assert observed["target"] == {"revision": 1}
    assert len(observed["tmp_files"]) == 1
    assert json.loads(path.read_text(encoding="utf-8")) == {"revision": 2}


def test_fence_that_raises_leaves_no_write_and_no_residue(tmp_path: Path) -> None:
    path = tmp_path / "canvas.json"
    path.write_text(json.dumps({"revision": 1}), encoding="utf-8")

    def fence() -> None:
        raise CanvasLeaseLost("default")

    with pytest.raises(CanvasLeaseLost):
        canvas_store.atomic_write_json(path, {"revision": 2}, fence=fence)

    assert json.loads(path.read_text(encoding="utf-8")) == {"revision": 1}
    assert sorted(p.name for p in tmp_path.glob(".canvas.json.*.tmp")) == []


def test_save_canvas_fences_and_a_lost_lease_does_not_land(
    tmp_path: Path, injected_mutex
) -> None:
    project_dir = tmp_path / "project"
    canvas_file = _seed_canvas(project_dir)
    mutex = injected_mutex(_RecordingMutex(fence_error=CanvasLeaseLost("default")))

    with pytest.raises(CanvasLeaseLost):
        canvas_store.save_canvas(
            project_dir,
            "default",
            base_revision=1,
            build_payload=lambda _existing: {
                "revision": 2,
                "nodes": [{"id": "n"}],
                "edges": [],
            },
        )

    assert mutex.fence_calls == ["default"]
    assert json.loads(canvas_file.read_text(encoding="utf-8"))["revision"] == 1
    # Even if the lease is lost, the lease must be released (`finally`).
    assert mutex.exited == [(project_dir, "default")]


def test_soft_delete_fences_before_the_irreversible_replace(
    tmp_path: Path, injected_mutex
) -> None:
    project_dir = tmp_path / "project"
    canvas_file = _seed_canvas(project_dir)
    injected_mutex(_RecordingMutex(fence_error=CanvasLeaseLost("default")))

    with pytest.raises(CanvasLeaseLost):
        canvas_store.soft_delete_canvas(project_dir, "default", deleted_by="alice")

    # `path.replace(target)` is irreversible: the fence must be hooked **before** it (Section 3.3.3).
    assert canvas_file.exists()
    assert not canvas_file.with_name("default.deleted.json").exists()


# ---------------------------------------------------------------------------
# Fence coverage: static assertion (the criterion is "will this step make someone else's write vanish permanently", B2-11)
# ---------------------------------------------------------------------------


# The table of Section 3.3.3: only these two places **deliberately** have no fence, each with a reason.
_UNFENCED_BY_DESIGN = {
    # The ledger is written after the canvas rename: at this point the race is already won, and a fence would only turn "won but ledger not recorded"
    # into "won and raised". Losing one ledger entry = the next replay degrades into one real save.
    "append_idempotency_entry",
    # The tombstone follows `path.replace(target)`, and within the same critical section it has already passed the irreversible point.
    "soft_delete_canvas",
}
_MUST_BE_FENCED = {"ensure_default_canvas", "save_canvas", "restore_canvas_version"}


def _canvas_store_functions() -> dict[str, ast.FunctionDef]:
    tree = ast.parse(
        Path(canvas_store.__file__).read_text(encoding="utf-8"),
        filename=canvas_store.__file__,
    )
    return {
        node.name: node
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


def _atomic_write_calls() -> list[tuple[str, ast.Call]]:
    calls: list[tuple[str, ast.Call]] = []
    for name, func in _canvas_store_functions().items():
        for node in ast.walk(func):
            if not isinstance(node, ast.Call):
                continue
            target = node.func
            called = (
                target.attr
                if isinstance(target, ast.Attribute)
                else getattr(target, "id", "")
            )
            if called == "atomic_write_json":
                calls.append((name, node))
    return calls


def test_every_atomic_write_json_call_site_is_fenced_or_exempt() -> None:
    unfenced = {
        name
        for name, call in _atomic_write_calls()
        if not any(kw.arg == "fence" for kw in call.keywords)
    }

    assert unfenced == _UNFENCED_BY_DESIGN, (
        "Every `atomic_write_json` write path either carries `fence=`, or is in the exemption table of Section 3.3.3"
    )


def test_the_three_fenced_write_paths_are_all_present() -> None:
    fenced = {
        name
        for name, call in _atomic_write_calls()
        if any(kw.arg == "fence" for kw in call.keywords)
    }

    assert _MUST_BE_FENCED <= fenced


def test_soft_delete_reasserts_before_path_replace() -> None:
    func = _canvas_store_functions()["soft_delete_canvas"]

    replace_lines = [
        node.lineno
        for node in ast.walk(func)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "replace"
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "path"
    ]
    reassert_lines = [
        node.lineno
        for node in ast.walk(func)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "reassert"
    ]

    assert len(replace_lines) == 1, "This case assumes `path.replace(target)` appears in only one place"
    assert reassert_lines, "`soft_delete_canvas` must explicitly hook a fence before the irreversible write to disk"
    assert min(reassert_lines) < replace_lines[0]
