"""M8 step 9 (G3) · partial dispatch of fan-out endpoints (TCP-EU-B4a).

When the three fan-out loops (``:2124`` / ``:3078`` / ``:4448`` of ``api/routes/generation.py``) hit a limit, they must
**stop at the hit point and faithfully report what was dispatched and what was rejected**, rather than "the first k-1 already consumed compute and the client only gets a single 429".

This file pins the contract frozen in M8 §8.2 loop by loop:

1. **Catch only the four active limit exceptions** (channel / user / project / project-user) -> record, then
   **``break``**; other exceptions still propagate (a broad catch of ``Exception`` is the very
   503 recurrence path that ``TCP-P44`` just plugged).
2. **k == 0 must raise bare** -- hand it to the handler in ``api/app.py`` to render 429 + the correct ``limit_scope``
   (M8 invariant 7); the single-grid branch ``:2178`` of loop 1 reads ``queued_tasks[0]`` directly and would crash at k=0.
3. The response body gains ``rejected: [{scope, reason, limit, active}]``, **exactly N-k entries**
   (M8 ``:722``; verification matrix ``:755`` has cap=3 / N=5 -> ``rejected`` exactly 2 entries): the hit-point entry
   **and every not-yet-attempted entry after it**, each with its own scope and in plan order.
   "Dispatch only once" and "report N-k entries" do not contradict -- ``break`` saves **dispatch**, not **reporting**.
   Downstream ``TCP-EU-B4b`` (``render-plan-dialog.tsx:265``) aligns the undispatched tail by
   ``entries.length === rejected.length``; under-reporting by one degrades the whole thing to no auto re-dispatch.
4. Change ``dispatched`` at ``:2166`` from the **intended count** to the **actual dispatched count** (M8 invariant 17).

The algorithm of ``reason`` and the ``limit_scope`` of ``api/app.py`` **are the same set of branches**
(``:183-185`` channel limit / ``:209`` person limit) -- the same algorithm on both sides is the cross-EU (``TCP-EU-B2``) drift detector,
so this file hits all four ``reason`` values, and one more case matches the two sides verbatim.

The real limit lives in EE (``ee_reserve_task()`` of ``TCP-EU-B1``), so exceptions are **injected by hand** here for evidence.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo.api.app import create_app
from novelvideo.task_backend.limits import (
    ChannelTaskLimitExceeded,
    GlobalLaneQueueLimitExceeded,
    ProjectTaskLimitExceeded,
    ProjectUserTaskLimitExceeded,
    UserTaskLimitExceeded,
)
from novelvideo.task_identity import selection_scope

# ---------------------------------------------------------------------------
# Shared: fake task backend that injects limit exceptions
# ---------------------------------------------------------------------------

_CHANNEL_GATE = ChannelTaskLimitExceeded(
    scope_kind="organization", org_id="org_9", queue_kind="default", limit=3, active=3
)
_PLATFORM_GATE = ChannelTaskLimitExceeded(
    scope_kind="platform", org_id=None, queue_kind="default", limit=8, active=8
)
_USER_GATE = UserTaskLimitExceeded(
    requester_user_id="user_7", queue_kind="default", limit=2, active=2
)
_PROJECT_GATE = ProjectTaskLimitExceeded(
    project_id="project_7", queue_kind="default", limit=3, active=3
)
_PROJECT_USER_GATE = ProjectUserTaskLimitExceeded(
    project_id="project_7",
    requester_user_id="user_7",
    queue_kind="default",
    limit=2,
    active=2,
)
_GLOBAL_QUEUE_GATE = GlobalLaneQueueLimitExceeded(
    project_id="project_7", queue_kind="default", limit=8, queued=8
)

# (exception, expected rejected.reason, expected 429 limit_scope)
_GATE_CASES = [
    (_CHANNEL_GATE, "channel", "channel"),
    (_PLATFORM_GATE, "platform", "platform"),
    (_USER_GATE, "user", "user"),
    (_PROJECT_GATE, "project", "project"),
    (_PROJECT_USER_GATE, "user", "user"),
]
_GATE_IDS = ["channel", "platform", "user", "project", "project-user"]


class _GateBackend:
    """Raise ``exc`` from the ``fail_from``-th call on; ``fail_from=None`` never raises."""

    def __init__(self, exc: Exception | None = None, fail_from: int | None = None):
        self.exc = exc
        self.fail_from = fail_from
        self.calls: list[dict] = []
        # The tasks that really entered the queue (M8 :755's "exactly 3 tasks in Celery").
        self.succeeded: list[dict] = []

    async def enqueue_project_task(self, ctx, **kwargs):
        self.calls.append(kwargs)
        if self.fail_from is not None and len(self.calls) >= self.fail_from:
            assert self.exc is not None
            raise self.exc
        self.succeeded.append(kwargs)
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id=f"task-{len(self.calls)}"),
            backend="celery",
            queue=kwargs.get("queue_kind") or "default",
        )


def _app_with_production_handlers(router) -> FastAPI:
    """Borrow the production app's exception handlers and mount the route on a clean app.

    The form follows ``tests/test_channel_task_limit_error_surface.py:307-310`` verbatim
    (laid down by ``TCP-EU-B2``); the bare raise at k==0 must pass through the real handler for 429 and ``limit_scope`` to be asserted.
    """
    production_app = create_app()
    app = FastAPI()
    app.exception_handlers.update(production_app.exception_handlers)
    app.include_router(router, prefix="/api/v1")
    return app


# ---------------------------------------------------------------------------
# Loop 1: generate_sketches (:2124 for grid_index in dispatch_grid_indices)
#   harness follows tests/test_api_generation_sketches.py:29-116
# ---------------------------------------------------------------------------

_SKETCH_BEATS = [
    {"beat_number": n, "narration_segment": chr(96 + n), "location": chr(64 + n)}
    for n in range(1, 7)
]


class _SketchStore:
    async def get_beats_as_dicts(self, episode_num: int):
        assert episode_num == 2
        return _SKETCH_BEATS

    def get_episode(self, episode_num: int):
        return SimpleNamespace(prop_menu=[])

    def get_cached_prop(self, prop_id: str):
        return None

    def get_sketch_colors(self, episode_num: int):
        return {"hero_main": "#ffffff"}


def _sketch_client(monkeypatch, tmp_path, backend: _GateBackend, grids: int):
    from novelvideo.api.deps import ProjectResolution
    from novelvideo.api.routes import generation
    from novelvideo.generators import nanobanana_grid
    from novelvideo.utils.path_resolver import PathResolver

    store = _SketchStore()

    async def fake_make_sqlite_store_for_context(ctx):
        return store

    async def fake_make_sqlite_store(username: str, project: str):
        return store

    async def fake_character_map(*args, **kwargs):
        return {"hero": {"identity_sketch_colors": {"hero_main": "#ffffff"}}}

    async def fake_prop_menu(*args, **kwargs):
        return []

    def fake_scene_split(beats, aspect_ratio="2:3"):
        return [
            {
                "rows": 1,
                "cols": 1,
                "mode_key": "1x1_2-3_sketch",
                "scene_id": chr(65 + idx),
                "beat_numbers": [beats[idx]["beat_number"]],
                "beats": [beats[idx]],
            }
            for idx in range(grids)
        ]

    async def fake_resolve_project_scope(project, user, *, required_role="viewer"):
        return ProjectResolution(
            ctx=SimpleNamespace(project_id="proj", state_dir=tmp_path / "state"),
            username="alice",
            project_name="demo",
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
        )

    monkeypatch.setattr(generation, "resolve_project_scope", fake_resolve_project_scope)
    monkeypatch.setattr(generation, "load_project_config", lambda username, project: {})
    monkeypatch.setattr(generation, "make_sqlite_store", fake_make_sqlite_store)
    monkeypatch.setattr(
        generation, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    monkeypatch.setattr(generation, "_build_character_map", fake_character_map)
    monkeypatch.setattr(generation, "_runtime_prop_menu_with_global_props", fake_prop_menu)
    monkeypatch.setattr(generation, "get_task_backend", lambda: backend)
    monkeypatch.setattr(PathResolver, "clean_sketches", lambda self: [])
    monkeypatch.setattr(nanobanana_grid, "sketch_scene_grid_split", fake_scene_split)

    app = _app_with_production_handlers(generation.router)
    app.dependency_overrides[generation.get_api_user] = lambda: {"username": "alice"}
    app.dependency_overrides[generation.require_scope("tasks:submit")] = lambda: {
        "username": "alice"
    }
    return TestClient(app, raise_server_exceptions=False)


def _post_sketches(client: TestClient, grid_index: int = -1):
    return client.post(
        "/api/v1/projects/demo/episodes/2/sketches/generate",
        json={"grid_index": grid_index, "sketch_scene_grouping": True},
    )


@pytest.mark.parametrize(("exc", "reason", "_scope"), _GATE_CASES, ids=_GATE_IDS)
def test_loop1_partial_dispatch_reports_dispatched_and_rejected(
    monkeypatch, tmp_path, exc, reason, _scope
) -> None:
    """N=6, the 4th hits the limit: the first 3 are still dispatched, dispatched==3, rejected exactly N-k==3 entries.

    The three rejected = the hit-point entry + the two after it not yet attempted, each with its own scope and in plan order.
    """
    backend = _GateBackend(exc, fail_from=4)
    response = _post_sketches(_sketch_client(monkeypatch, tmp_path, backend, grids=6))

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["dispatched"] == 3
    assert len(data["tasks"]) == 3
    assert data["scopes"] == ["grid_0", "grid_1", "grid_2"]
    assert data["rejected"] == [
        {"scope": f"grid_{n}", "reason": reason, "limit": exc.limit, "active": exc.active}
        for n in (3, 4, 5)
    ]


def test_loop1_m8_755_cap3_n5(monkeypatch, tmp_path) -> None:
    """The M8 verification matrix :755 row verbatim: cap=3, N=5 -> 200, dispatched=3, rejected exactly 2 entries."""
    backend = _GateBackend(_CHANNEL_GATE, fail_from=4)
    response = _post_sketches(_sketch_client(monkeypatch, tmp_path, backend, grids=5))

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["dispatched"] == 3
    assert len(data["rejected"]) == 2
    assert [item["scope"] for item in data["rejected"]] == ["grid_3", "grid_4"]
    # "Exactly 3 tasks in Celery": only 3 really entered the queue (the 4th call hit the limit, the 5th was never tried).
    assert len(backend.succeeded) == 3
    assert len(backend.calls) == 4


def test_loop1_stops_at_the_gate_instead_of_retrying_every_remaining_item(
    monkeypatch, tmp_path
) -> None:
    """Stop at the hit point: the backend is called only 3 times (2 succeed + 1 hit), not N=6 -- yet all 4 are still reported.

    This is the nail for "break saves dispatch, not reporting": rejected has 4 entries, yet the backend did not dispatch
    once for each of the last 3.
    """
    backend = _GateBackend(_CHANNEL_GATE, fail_from=3)
    response = _post_sketches(_sketch_client(monkeypatch, tmp_path, backend, grids=6))

    assert response.status_code == 200
    assert len(backend.calls) == 3
    assert len(backend.succeeded) == 2
    data = response.json()["data"]
    assert data["dispatched"] == 2
    assert [item["scope"] for item in data["rejected"]] == [
        "grid_2",
        "grid_3",
        "grid_4",
        "grid_5",
    ]


@pytest.mark.parametrize(("exc", "_reason", "scope"), _GATE_CASES, ids=_GATE_IDS)
def test_loop1_k_zero_raises_bare_and_renders_429(
    monkeypatch, tmp_path, exc, _reason, scope
) -> None:
    """Not a single one dispatched -> 429 + the correct limit_scope, not 200 + empty rejected."""
    backend = _GateBackend(exc, fail_from=1)
    response = _post_sketches(_sketch_client(monkeypatch, tmp_path, backend, grids=4))

    assert response.status_code == 429
    body = response.json()
    assert body["ok"] is False
    assert body["data"]["limit_scope"] == scope
    assert "rejected" not in body.get("data", {})


def test_loop1_single_grid_path_still_429s_instead_of_indexerror(
    monkeypatch, tmp_path
) -> None:
    """Single-grid branch N=1: a limit hit always falls on k==0 -> 429 (queued_tasks[0] at :2178 must not raise IndexError)."""
    backend = _GateBackend(_USER_GATE, fail_from=1)
    response = _post_sketches(
        _sketch_client(monkeypatch, tmp_path, backend, grids=4), grid_index=1
    )

    assert response.status_code == 429
    assert response.json()["data"]["limit_scope"] == "user"


def test_loop1_non_gate_exception_is_not_swallowed(monkeypatch, tmp_path) -> None:
    """A plain RuntimeError propagates as-is: not put into rejected, not broken into a 200."""
    backend = _GateBackend(RuntimeError("boom"), fail_from=3)
    response = _post_sketches(_sketch_client(monkeypatch, tmp_path, backend, grids=6))

    assert response.status_code == 500
    assert len(backend.calls) == 3


def test_loop1_global_queue_limit_is_not_treated_as_active_limit(
    monkeypatch, tmp_path
) -> None:
    """TCP-P99: queued is not active; CE-2 must not stuff queue-depth exceptions into rejected."""
    backend = _GateBackend(_GLOBAL_QUEUE_GATE, fail_from=4)
    response = _post_sketches(_sketch_client(monkeypatch, tmp_path, backend, grids=6))

    assert response.status_code == 429
    assert response.json()["data"] == {
        "project_id": "project_7",
        "queue_kind": "default",
        "limit": 8,
        "queued": 8,
        "limit_scope": "global_lane_queue",
    }
    assert len(backend.succeeded) == 3


def test_loop1_dispatched_is_the_real_count_not_the_intended_one(
    monkeypatch, tmp_path
) -> None:
    """The lie at :2166: 3 dispatched, 1 rejected -> dispatched==3 (it would have been 4 before the change)."""
    backend = _GateBackend(_CHANNEL_GATE, fail_from=4)
    response = _post_sketches(_sketch_client(monkeypatch, tmp_path, backend, grids=4))

    data = response.json()["data"]
    assert data["dispatched"] == 3
    assert data["dispatched"] == len(data["tasks"]) == len(data["scopes"])


def test_loop1_happy_path_body_is_unchanged_plus_empty_rejected(
    monkeypatch, tmp_path
) -> None:
    """Without a limit hit: existing keys verbatim unchanged, rejected is an empty list (this EU chooses "always present", pinned here)."""
    backend = _GateBackend()
    response = _post_sketches(_sketch_client(monkeypatch, tmp_path, backend, grids=4))

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"ok", "task_type", "backend", "data", "message"}
    assert body["ok"] is True
    assert body["task_type"] == "sketch_grid_generation"
    assert body["backend"] == "celery"
    assert set(body["data"]) == {"dispatched", "tasks", "scopes", "rejected"}
    assert body["data"]["dispatched"] == 4
    assert body["data"]["scopes"] == ["grid_0", "grid_1", "grid_2", "grid_3"]
    assert body["data"]["rejected"] == []
    assert len(backend.calls) == 4


def test_loop1_single_grid_happy_path_body_has_no_rejected_key(
    monkeypatch, tmp_path
) -> None:
    """The single-grid branch response body is verbatim unchanged (N=1 has no fan-out, no rejected attached)."""
    backend = _GateBackend()
    response = _post_sketches(
        _sketch_client(monkeypatch, tmp_path, backend, grids=4), grid_index=1
    )

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {
        "ok",
        "task_type",
        "backend",
        "task_id",
        "task_key",
        "queue",
        "message",
    }
    assert "rejected" not in body


# ---------------------------------------------------------------------------
# Loop 2: render_execute (:3078 for entry in execution_plan)
#   harness follows tests/test_api_render_regenerate.py:32-104
# ---------------------------------------------------------------------------

_RENDER_BEATS = [
    {"beat_number": n, "narration_segment": chr(96 + n), "location": chr(64 + n)}
    for n in range(1, 7)
]


class _RenderStore:
    async def get_beats_as_dicts(self, episode_num: int):
        assert episode_num == 2
        return _RENDER_BEATS

    def get_sketch_colors(self, episode_num: int):
        return {"hero_main": "#ffffff"}

    def get_cached_prop(self, prop_id: str):
        return None


def _render_client(monkeypatch, tmp_path, backend: _GateBackend):
    from novelvideo.api.routes import generation

    async def fake_make_sqlite_store_for_context(ctx):
        return _RenderStore()

    async def fake_make_sqlite_store(username: str, project: str):
        return _RenderStore()

    async def fake_resolve_generation_project(project: str, user: dict, required_role: str):
        return SimpleNamespace(
            username="alice",
            project_name="demo",
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            ctx=SimpleNamespace(
                project_id="proj",
                state_dir=tmp_path / "state",
                runtime_dir=tmp_path / "runtime",
            ),
        )

    async def fake_character_map(store, beats, username, project, **kwargs):
        return {"hero": {"ref_path": ""}}

    async def fake_prop_menu(*args, **kwargs):
        return []

    monkeypatch.setattr(
        generation, "_resolve_generation_project", fake_resolve_generation_project
    )
    monkeypatch.setattr(generation, "load_project_config", lambda username, project: {})
    monkeypatch.setattr(generation, "make_sqlite_store", fake_make_sqlite_store)
    monkeypatch.setattr(
        generation, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    monkeypatch.setattr(generation, "_build_character_map", fake_character_map)
    monkeypatch.setattr(generation, "_runtime_prop_menu_with_global_props", fake_prop_menu)
    monkeypatch.setattr(generation, "render_ai_detection_error", lambda beats: None)
    monkeypatch.setattr(generation, "get_task_backend", lambda: backend)

    app = _app_with_production_handlers(generation.router)
    app.dependency_overrides[generation.get_api_user] = lambda: {"username": "alice"}
    return TestClient(app, raise_server_exceptions=False)


def _render_execute(client: TestClient, beat_indices: list[int]):
    """Two steps: /render/plan gets the fingerprint, then /render/execute (force_one_by_one -> one beat per grid)."""
    plan_response = client.post(
        "/api/v1/projects/demo/episodes/2/render/plan",
        json={
            "beat_indices": beat_indices,
            "strategy": "naive",
            "aspect_mode": "9:16",
            "force_one_by_one": True,
        },
    )
    assert plan_response.status_code == 200, plan_response.text
    plan = plan_response.json()["data"]
    assert len(plan["plan"]) == len(beat_indices)

    return plan, client.post(
        "/api/v1/projects/demo/episodes/2/render/execute",
        json={
            "plan": plan["plan"],
            "plan_hash": plan["plan_hash"],
            "input_fingerprint": plan["input_fingerprint"],
            "strategy": plan["strategy"],
            "aspect_mode": "9:16",
            "force_one_by_one": True,
            "beat_indices": beat_indices,
        },
    )


def _expected_scopes(plan: dict) -> list[str]:
    return [
        selection_scope(entry["mode_key"], [int(b) for b in entry["beat_numbers"]])
        for entry in plan["plan"]
    ]


@pytest.mark.parametrize(("exc", "reason", "_scope"), _GATE_CASES, ids=_GATE_IDS)
def test_loop2_partial_dispatch_reports_task_ids_and_rejected(
    monkeypatch, tmp_path, exc, reason, _scope
) -> None:
    backend = _GateBackend(exc, fail_from=4)
    plan, response = _render_execute(
        _render_client(monkeypatch, tmp_path, backend), [1, 2, 3, 4, 5, 6]
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert len(data["task_ids"]) == 3
    assert data["rejected"] == [
        {
            "scope": _expected_scopes(plan)[idx],
            "reason": reason,
            "limit": exc.limit,
            "active": exc.active,
        }
        for idx in (3, 4, 5)
    ]


def test_loop2_m8_755_cap3_n5(monkeypatch, tmp_path) -> None:
    """M8 :755: cap=3, N=5 -> 200, actually dispatched 3 (3 task_ids), rejected exactly 2 entries."""
    backend = _GateBackend(_CHANNEL_GATE, fail_from=4)
    plan, response = _render_execute(
        _render_client(monkeypatch, tmp_path, backend), [1, 2, 3, 4, 5]
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert len(data["task_ids"]) == 3
    assert len(data["rejected"]) == 2
    assert [item["scope"] for item in data["rejected"]] == _expected_scopes(plan)[3:]
    assert len(backend.succeeded) == 3
    assert len(backend.calls) == 4


def test_loop2_stops_at_the_gate(monkeypatch, tmp_path) -> None:
    """Only 3 dispatches (2 succeed + 1 hit), but all 4 undispatched tail entries are reported."""
    backend = _GateBackend(_PLATFORM_GATE, fail_from=3)
    plan, response = _render_execute(
        _render_client(monkeypatch, tmp_path, backend), [1, 2, 3, 4, 5, 6]
    )

    assert response.status_code == 200, response.text
    assert len(backend.calls) == 3
    assert len(backend.succeeded) == 2
    data = response.json()["data"]
    assert len(data["task_ids"]) == 2
    assert [item["scope"] for item in data["rejected"]] == _expected_scopes(plan)[2:]


def test_loop2_rejected_length_matches_the_untried_tail_the_frontend_slices(
    monkeypatch, tmp_path
) -> None:
    """Downstream alignment: the length of ``resolved_grids[len(task_ids):]`` must equal the length of ``rejected``.

    This is exactly ``render-plan-dialog.tsx:265`` of ``TCP-EU-B4b``
    (``entries = grids.slice(taskIds.length)``; ``shapeOk: entries.length ===
    rejected.length``) -- if they do not match the frontend does not auto re-dispatch, and the failure count on the banner is under-reported.
    """
    backend = _GateBackend(_USER_GATE, fail_from=3)
    _plan, response = _render_execute(
        _render_client(monkeypatch, tmp_path, backend), [1, 2, 3, 4, 5, 6]
    )

    data = response.json()["data"]
    entries = data["resolved_grids"][len(data["task_ids"]) :]
    assert len(entries) == len(data["rejected"]) == 4
    assert [item["scope"] for item in data["rejected"]] == [
        selection_scope(entry["mode_key"], [int(b) for b in entry["beat_numbers"]])
        for entry in entries
    ]


@pytest.mark.parametrize(("exc", "_reason", "scope"), _GATE_CASES, ids=_GATE_IDS)
def test_loop2_k_zero_raises_bare_and_renders_429(
    monkeypatch, tmp_path, exc, _reason, scope
) -> None:
    backend = _GateBackend(exc, fail_from=1)
    _plan, response = _render_execute(
        _render_client(monkeypatch, tmp_path, backend), [1, 2, 3, 4]
    )

    assert response.status_code == 429
    assert response.json()["data"]["limit_scope"] == scope


def test_loop2_non_gate_exception_is_not_swallowed(monkeypatch, tmp_path) -> None:
    backend = _GateBackend(RuntimeError("boom"), fail_from=3)
    _plan, response = _render_execute(
        _render_client(monkeypatch, tmp_path, backend), [1, 2, 3, 4, 5, 6]
    )

    assert response.status_code == 500
    assert len(backend.calls) == 3


def test_loop2_global_queue_limit_is_not_treated_as_active_limit(
    monkeypatch, tmp_path
) -> None:
    """TCP-P99: render execute must also keep the queued shape, left for a later contract fix."""
    backend = _GateBackend(_GLOBAL_QUEUE_GATE, fail_from=4)
    _plan, response = _render_execute(
        _render_client(monkeypatch, tmp_path, backend), [1, 2, 3, 4, 5, 6]
    )

    assert response.status_code == 429
    assert response.json()["data"]["limit_scope"] == "global_lane_queue"
    assert response.json()["data"]["queued"] == 8
    assert len(backend.succeeded) == 3


def test_loop2_happy_path_body_is_unchanged_and_has_no_rejected_key(
    monkeypatch, tmp_path
) -> None:
    """Verbatim unchanged without a limit hit: ``rejected`` appears only when non-empty (attached the way the existing ``task_ids`` is)."""
    backend = _GateBackend()
    plan, response = _render_execute(
        _render_client(monkeypatch, tmp_path, backend), [1, 2, 3, 4]
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"ok", "data"}
    data = body["data"]
    assert set(data) == {
        "task_type",
        "message",
        "scope",
        "resolved_grids",
        "task_ids",
    }
    assert "rejected" not in data
    assert len(data["task_ids"]) == 4
    assert [entry["beat_numbers"] for entry in data["resolved_grids"]] == [
        entry["beat_numbers"] for entry in plan["plan"]
    ]


def test_loop2_response_model_field_set_is_unchanged() -> None:
    """RenderPlanExecuteResponse gained not a single field (rejected is attached only to the outer dict)."""
    from novelvideo.api.schemas import RenderPlanExecuteResponse

    assert set(RenderPlanExecuteResponse.model_fields) == {
        "task_type",
        "message",
        "scope",
        "resolved_grids",
    }


# ---------------------------------------------------------------------------
# Loop 3: generate_missing_manual_sketches (:4448 for beat_numbers in segments)
# ---------------------------------------------------------------------------


class _ManualStore:
    async def get_beats_as_dicts(self, episode_num: int):
        return _SKETCH_BEATS

    def get_sketch_colors(self, episode_num: int):
        return {"hero_main": "#ffffff"}


def _manual_client(monkeypatch, tmp_path, backend: _GateBackend, segments):
    from novelvideo import manual_shots
    from novelvideo.api.routes import generation

    async def fake_make_sqlite_store_for_context(ctx):
        return _ManualStore()

    async def fake_make_sqlite_store(username: str, project: str):
        return _ManualStore()

    async def fake_resolve_generation_project(project: str, user: dict, required_role: str):
        return SimpleNamespace(
            username="alice",
            project_name="demo",
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            ctx=SimpleNamespace(
                project_id="proj",
                state_dir=tmp_path / "state",
                runtime_dir=tmp_path / "runtime",
            ),
        )

    async def fake_character_map(*args, **kwargs):
        return {"hero": {"ref_path": ""}}

    monkeypatch.setattr(
        generation, "_resolve_generation_project", fake_resolve_generation_project
    )
    monkeypatch.setattr(generation, "load_project_config", lambda username, project: {})
    monkeypatch.setattr(generation, "make_sqlite_store", fake_make_sqlite_store)
    monkeypatch.setattr(
        generation, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    monkeypatch.setattr(generation, "_build_character_map", fake_character_map)
    monkeypatch.setattr(generation, "get_task_backend", lambda: backend)
    monkeypatch.setattr(
        manual_shots, "storyboard_beats_for_manual_sketches", lambda beats: list(beats)
    )
    monkeypatch.setattr(
        manual_shots,
        "missing_manual_shot_segments",
        lambda beats, sketches_dir: [list(seg) for seg in segments],
    )
    monkeypatch.setattr(manual_shots, "choose_manual_sketch_mode_key", lambda n: "1x1_2-3_sketch")

    app = _app_with_production_handlers(generation.router)
    app.dependency_overrides[generation.get_api_user] = lambda: {"username": "alice"}
    return TestClient(app, raise_server_exceptions=False)


def _post_missing_manual(client: TestClient):
    return client.post(
        "/api/v1/projects/demo/episodes/2/sketches/generate-missing-manual"
    )


def _manual_scope(beat_numbers: list[int]) -> str:
    return selection_scope("1x1_2-3_sketch", beat_numbers)


@pytest.mark.parametrize(("exc", "reason", "_scope"), _GATE_CASES, ids=_GATE_IDS)
def test_loop3_partial_dispatch_reports_dispatched_and_rejected(
    monkeypatch, tmp_path, exc, reason, _scope
) -> None:
    backend = _GateBackend(exc, fail_from=4)
    segments = [[1], [2], [3], [4], [5], [6]]
    response = _post_missing_manual(
        _manual_client(monkeypatch, tmp_path, backend, segments)
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["dispatched"] == 3
    assert data["segments"] == [[1], [2], [3]]
    assert data["scopes"] == [_manual_scope(seg) for seg in segments[:3]]
    assert data["rejected"] == [
        {
            "scope": _manual_scope(seg),
            "reason": reason,
            "limit": exc.limit,
            "active": exc.active,
        }
        for seg in segments[3:]
    ]


def test_loop3_m8_755_cap3_n5(monkeypatch, tmp_path) -> None:
    """M8 :755: cap=3, N=5 -> 200, dispatched=3, rejected exactly 2 entries."""
    backend = _GateBackend(_CHANNEL_GATE, fail_from=4)
    segments = [[1], [2], [3], [4], [5]]
    response = _post_missing_manual(
        _manual_client(monkeypatch, tmp_path, backend, segments)
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["dispatched"] == 3
    assert len(data["rejected"]) == 2
    assert [item["scope"] for item in data["rejected"]] == [
        _manual_scope(seg) for seg in segments[3:]
    ]
    assert len(backend.succeeded) == 3
    assert len(backend.calls) == 4


def test_loop3_stops_at_the_gate(monkeypatch, tmp_path) -> None:
    """Only 3 dispatches (2 succeed + 1 hit), the 4 undispatched tail entries are all reported."""
    backend = _GateBackend(_USER_GATE, fail_from=3)
    segments = [[1], [2], [3], [4], [5], [6]]
    response = _post_missing_manual(
        _manual_client(monkeypatch, tmp_path, backend, segments)
    )

    assert response.status_code == 200, response.text
    assert len(backend.calls) == 3
    assert len(backend.succeeded) == 2
    data = response.json()["data"]
    assert data["dispatched"] == 2
    assert [item["scope"] for item in data["rejected"]] == [
        _manual_scope(seg) for seg in segments[2:]
    ]


@pytest.mark.parametrize(("exc", "_reason", "scope"), _GATE_CASES, ids=_GATE_IDS)
def test_loop3_k_zero_raises_bare_and_renders_429(
    monkeypatch, tmp_path, exc, _reason, scope
) -> None:
    backend = _GateBackend(exc, fail_from=1)
    response = _post_missing_manual(
        _manual_client(monkeypatch, tmp_path, backend, [[1], [2], [3], [4]])
    )

    assert response.status_code == 429
    assert response.json()["data"]["limit_scope"] == scope


def test_loop3_non_gate_exception_is_not_swallowed(monkeypatch, tmp_path) -> None:
    backend = _GateBackend(RuntimeError("boom"), fail_from=3)
    response = _post_missing_manual(
        _manual_client(monkeypatch, tmp_path, backend, [[1], [2], [3], [4], [5], [6]])
    )

    assert response.status_code == 500
    assert len(backend.calls) == 3


def test_loop3_global_queue_limit_is_not_treated_as_active_limit(
    monkeypatch, tmp_path
) -> None:
    """TCP-P99: the missing-manual fan-out must not pass queued off as active."""
    backend = _GateBackend(_GLOBAL_QUEUE_GATE, fail_from=4)
    response = _post_missing_manual(
        _manual_client(
            monkeypatch,
            tmp_path,
            backend,
            [[1], [2], [3], [4], [5], [6]],
        )
    )

    assert response.status_code == 429
    assert response.json()["data"]["limit_scope"] == "global_lane_queue"
    assert response.json()["data"]["queued"] == 8
    assert len(backend.succeeded) == 3


def test_loop3_happy_path_keeps_its_existing_shape(monkeypatch, tmp_path) -> None:
    """The semantics of the dispatched / scopes / segments keys are verbatim unchanged, and rejected is an empty list."""
    backend = _GateBackend()
    segments = [[1], [2], [3]]
    response = _post_missing_manual(
        _manual_client(monkeypatch, tmp_path, backend, segments)
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"ok", "task_type", "data", "message"}
    assert body["task_type"] == "sketch_regen"
    assert body["message"] == "Started 3 groups of new-shot sketch generation"
    assert set(body["data"]) == {"dispatched", "scopes", "segments", "rejected"}
    assert body["data"]["dispatched"] == 3
    assert body["data"]["segments"] == segments
    assert body["data"]["scopes"] == [_manual_scope(seg) for seg in segments]
    assert body["data"]["rejected"] == []


def test_loop3_empty_segments_early_return_is_untouched(monkeypatch, tmp_path) -> None:
    """The early return for an empty set (:4426-4430) is unaffected: the three keys verbatim unchanged, no rejected grown."""
    backend = _GateBackend()
    response = _post_missing_manual(_manual_client(monkeypatch, tmp_path, backend, []))

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"] == {"dispatched": 0, "scopes": [], "segments": []}
    assert body["message"] == "No manual shots are missing sketches"
    assert backend.calls == []


# ---------------------------------------------------------------------------
# Cross-EU drift detector: rejected.reason uses the same algorithm as limit_scope in api/app.py
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(("exc", "reason", "scope"), _GATE_CASES, ids=_GATE_IDS)
def test_rejected_reason_matches_the_handler_limit_scope_verbatim(
    monkeypatch, tmp_path, exc, reason, scope
) -> None:
    """Same exception: ``rejected[0]["reason"]`` and the 429 ``limit_scope`` must be equal.

    The same algorithm on both sides is the only drift detector between ``TCP-EU-B4a`` and ``TCP-EU-B2``
    (``api/app.py:183-185`` / ``:209``).
    """
    assert reason == scope

    partial = _post_sketches(
        _sketch_client(monkeypatch, tmp_path, _GateBackend(exc, fail_from=4), grids=4)
    )
    assert partial.status_code == 200
    from_loop = partial.json()["data"]["rejected"][0]["reason"]

    refused = _post_sketches(
        _sketch_client(monkeypatch, tmp_path, _GateBackend(exc, fail_from=1), grids=4)
    )
    assert refused.status_code == 429
    from_handler = refused.json()["data"]["limit_scope"]

    assert from_loop == from_handler == reason


# ---------------------------------------------------------------------------
# A partial-dispatch limit hit must also leave an attributable log
#   When k > 0 the exception is swallowed locally, the response is 200 + ``rejected``, and it never reaches the handler in ``api/app.py``.
#   If the log hangs only on the handler, what is missed is exactly the "limit hit halfway through dispatch" online event --
#   the user gets a 200 and there is not a single record on the dashboard.
# ---------------------------------------------------------------------------

_LIMIT_LOGGER = "novelvideo.task_backend.limit_logging"


def _limit_log_records(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [
        record
        for record in caplog.records
        if record.name == _LIMIT_LOGGER
        and "task lane limit rejected" in record.getMessage()
    ]


def _assert_single_rejection_log(
    caplog: pytest.LogCaptureFixture, exc, reason: str
) -> None:
    records = _limit_log_records(caplog)
    assert len(records) == 1, "Log once for the one exception actually caught, rather than flooding per rejected entry"
    message = records[0].getMessage()
    assert records[0].levelno == logging.WARNING
    assert f"limit_scope={reason}" in message
    assert f"queue_kind={exc.queue_kind}" in message
    assert f"limit={exc.limit}" in message


@pytest.mark.parametrize(("exc", "reason", "_scope"), _GATE_CASES, ids=_GATE_IDS)
def test_loop1_partial_dispatch_logs_one_attributable_rejection(
    caplog, monkeypatch, tmp_path, exc, reason, _scope
) -> None:
    caplog.set_level(logging.WARNING, logger=_LIMIT_LOGGER)
    backend = _GateBackend(exc, fail_from=4)

    response = _post_sketches(_sketch_client(monkeypatch, tmp_path, backend, grids=6))

    assert response.status_code == 200
    assert len(response.json()["data"]["rejected"]) == 3
    _assert_single_rejection_log(caplog, exc, reason)


@pytest.mark.parametrize(("exc", "reason", "_scope"), _GATE_CASES, ids=_GATE_IDS)
def test_loop2_partial_dispatch_logs_one_attributable_rejection(
    caplog, monkeypatch, tmp_path, exc, reason, _scope
) -> None:
    caplog.set_level(logging.WARNING, logger=_LIMIT_LOGGER)
    backend = _GateBackend(exc, fail_from=4)

    _plan, response = _render_execute(
        _render_client(monkeypatch, tmp_path, backend), [1, 2, 3, 4, 5, 6]
    )

    assert response.status_code == 200, response.text
    assert len(response.json()["data"]["rejected"]) == 3
    _assert_single_rejection_log(caplog, exc, reason)


@pytest.mark.parametrize(("exc", "reason", "_scope"), _GATE_CASES, ids=_GATE_IDS)
def test_loop3_partial_dispatch_logs_one_attributable_rejection(
    caplog, monkeypatch, tmp_path, exc, reason, _scope
) -> None:
    caplog.set_level(logging.WARNING, logger=_LIMIT_LOGGER)
    backend = _GateBackend(exc, fail_from=4)
    segments = [[1], [2], [3], [4], [5], [6]]

    response = _post_missing_manual(
        _manual_client(monkeypatch, tmp_path, backend, segments)
    )

    assert response.status_code == 200, response.text
    assert len(response.json()["data"]["rejected"]) == 3
    _assert_single_rejection_log(caplog, exc, reason)


def test_partial_dispatch_log_carries_the_gate_identity_not_the_tail_length(
    caplog, monkeypatch, tmp_path
) -> None:
    """One line per limit hit, fields from the exception itself (org_id / active), independent of the number of ``rejected`` entries."""
    caplog.set_level(logging.WARNING, logger=_LIMIT_LOGGER)
    backend = _GateBackend(_CHANNEL_GATE, fail_from=2)

    response = _post_sketches(_sketch_client(monkeypatch, tmp_path, backend, grids=6))

    assert response.status_code == 200
    assert len(response.json()["data"]["rejected"]) == 5
    records = _limit_log_records(caplog)
    assert len(records) == 1
    message = records[0].getMessage()
    assert "limit_scope=channel" in message
    assert "scope_kind=organization" in message
    assert f"org_id={_CHANNEL_GATE.org_id}" in message
    assert f"active={_CHANNEL_GATE.active}" in message


@pytest.mark.parametrize(("exc", "_reason", "scope"), _GATE_CASES, ids=_GATE_IDS)
def test_k_zero_still_logs_exactly_once_through_the_handler(
    caplog, monkeypatch, tmp_path, exc, _reason, scope
) -> None:
    """k == 0 raises bare: only the handler logs that once; the fan-out side must not log it again before the ``raise``."""
    caplog.set_level(logging.WARNING, logger=_LIMIT_LOGGER)
    backend = _GateBackend(exc, fail_from=1)

    response = _post_sketches(_sketch_client(monkeypatch, tmp_path, backend, grids=4))

    assert response.status_code == 429
    records = _limit_log_records(caplog)
    assert len(records) == 1, "The bare-raise path should be logged only once, by the handler"
    assert f"limit_scope={scope}" in records[0].getMessage()
