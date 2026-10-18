"""M8 step 7 · CE error surface of the channel limit / person limit.

This file pins three things:

1. The two new exceptions are **of the same family** as the three existing classes in ``task_backend/limits.py:46-101``
   (dataclass + ``__post_init__`` feeding fields as-is to ``RuntimeError.__init__`` + a custom ``__str__``),
   and **neither carries** a ``limit_scope`` field -- that literal is hard-coded in the handlers (``api/app.py:113/138/159``).
2. The two new handlers in ``api/app.py`` return **429** with ``limit_scope`` on the correct axis
   (M8 §2.9(d): ``scope_kind == "platform"`` -> ``platform``, otherwise ``channel``; person limit -> ``user``).
3. **Core**: through the real freezone routes these exceptions are **not downgraded to 503**.
   The broad ``except RuntimeError`` in ``freezone.py`` (e.g. ``:8565-8571``) wraps every ``RuntimeError`` not claimed by
   ``_raise_if_task_limit_exception`` into
   ``HTTPException(503, ...)`` -- exactly the recurrence path of the Feishu 64-171 bug
   (M8 invariant 7: an over-limit must be 429 with a correct ``limit_scope``, **never 503**).
"""

from __future__ import annotations

import logging
from dataclasses import fields, is_dataclass
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo.api.app import create_app
from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.project_context import ProjectContext
from novelvideo.task_backend.limits import (
    ChannelTaskLimitExceeded,
    GlobalLaneQueueLimitExceeded,
    ProjectTaskLimitExceeded,
    ProjectUserTaskLimitExceeded,
    UserTaskLimitExceeded,
)

# ---------------------------------------------------------------------------
# 1. Exception shape: same family as the three existing classes in limits.py:46-101
# ---------------------------------------------------------------------------

_EXISTING_FAMILY = (
    ProjectTaskLimitExceeded(
        project_id="proj_1", queue_kind="video", limit=4, active=4
    ),
    ProjectUserTaskLimitExceeded(
        project_id="proj_1",
        requester_user_id="user_1",
        queue_kind="video",
        limit=1,
        active=1,
    ),
    GlobalLaneQueueLimitExceeded(
        project_id="proj_1", queue_kind="video", limit=2, queued=2
    ),
)

_NEW_FAMILY = (
    ChannelTaskLimitExceeded(
        scope_kind="organization",
        org_id="org_1",
        queue_kind="video",
        limit=2,
        active=2,
    ),
    UserTaskLimitExceeded(
        requester_user_id="user_1", queue_kind="video", limit=1, active=1
    ),
)


@pytest.mark.parametrize("exc", _NEW_FAMILY, ids=lambda exc: type(exc).__name__)
def test_new_limit_exceptions_share_the_existing_family_shape(exc) -> None:
    """The new classes align one by one with the dataclass / __post_init__ / __str__ shape of the existing three classes."""
    cls = type(exc)
    assert is_dataclass(cls)
    assert issubclass(cls, RuntimeError)

    field_names = [field.name for field in fields(cls)]
    # __post_init__ feeds all fields to RuntimeError.__init__ as-is in declaration order (same as :53-54 / :71-78 / :94-95)
    assert exc.args == tuple(getattr(exc, name) for name in field_names)

    # __str__ is human-readable, not the repr of args (same as :56-60 / :80-84 / :97-101)
    rendered = str(exc)
    assert rendered != repr(exc.args)
    assert "lane is full" in rendered
    assert f"({exc.active}/{exc.limit})" in rendered

    # The existing three classes satisfy the same four points -- the criterion of "same family" closes here
    for existing in _EXISTING_FAMILY:
        existing_names = [field.name for field in fields(type(existing))]
        assert existing.args == tuple(
            getattr(existing, name) for name in existing_names
        )
        assert "lane is full" in str(existing) or "queue is full" in str(existing)


@pytest.mark.parametrize("exc", _NEW_FAMILY, ids=lambda exc: type(exc).__name__)
def test_new_limit_exceptions_do_not_carry_limit_scope(exc) -> None:
    """limit_scope is hard-coded in the handlers, and the exception classes have no such field (like the existing three classes)."""
    assert "limit_scope" not in {field.name for field in fields(type(exc))}
    assert not hasattr(exc, "limit_scope")
    for existing in _EXISTING_FAMILY:
        assert "limit_scope" not in {
            field.name for field in fields(type(existing))
        }


def test_channel_task_limit_exceeded_declares_the_step7_fields() -> None:
    assert [field.name for field in fields(ChannelTaskLimitExceeded)] == [
        "scope_kind",
        "org_id",
        "queue_kind",
        "limit",
        "active",
    ]
    platform = ChannelTaskLimitExceeded(
        scope_kind="platform", org_id=None, queue_kind="world", limit=1, active=1
    )
    assert platform.org_id is None
    assert "world" in str(platform)


def test_user_task_limit_exceeded_declares_the_step7_fields() -> None:
    assert [field.name for field in fields(UserTaskLimitExceeded)] == [
        "requester_user_id",
        "queue_kind",
        "limit",
        "active",
    ]


# ---------------------------------------------------------------------------
# 2. handler: 429 + correct limit_scope
#    Form follows tests/contract/test_l014_inline_task_backend_concurrency.py:569-597
# ---------------------------------------------------------------------------


def _client_raising(exc: RuntimeError) -> TestClient:
    app = create_app()

    @app.get("/_test/task-limit")
    async def _raise_task_limit():  # pragma: no cover - triggered by TestClient
        raise exc

    return TestClient(app)


def test_channel_limit_organization_scope_maps_to_429_channel() -> None:
    response = _client_raising(
        ChannelTaskLimitExceeded(
            scope_kind="organization",
            org_id="org_9",
            queue_kind="video",
            limit=2,
            active=2,
        )
    ).get("/_test/task-limit")

    assert response.status_code == 429
    body = response.json()
    assert body["ok"] is False
    assert body["data"]["limit_scope"] == "channel"
    assert body["data"]["scope_kind"] == "organization"
    assert body["data"]["org_id"] == "org_9"
    assert body["data"]["queue_kind"] == "video"
    assert body["data"]["limit"] == 2
    assert body["data"]["active"] == 2


def test_channel_limit_platform_scope_maps_to_429_platform() -> None:
    response = _client_raising(
        ChannelTaskLimitExceeded(
            scope_kind="platform",
            org_id=None,
            queue_kind="video",
            limit=8,
            active=8,
        )
    ).get("/_test/task-limit")

    assert response.status_code == 429
    body = response.json()
    assert body["data"]["limit_scope"] == "platform"
    assert body["data"]["scope_kind"] == "platform"
    assert body["data"]["org_id"] is None


def test_user_limit_maps_to_429_user() -> None:
    response = _client_raising(
        UserTaskLimitExceeded(
            requester_user_id="user_7", queue_kind="default", limit=1, active=1
        )
    ).get("/_test/task-limit")

    assert response.status_code == 429
    body = response.json()
    assert body["ok"] is False
    assert body["data"] == {
        "requester_user_id": "user_7",
        "queue_kind": "default",
        "limit": 1,
        "active": 1,
        "limit_scope": "user",
    }


def test_existing_three_limit_handlers_response_bodies_are_unchanged() -> None:
    """The response bodies of the existing three exceptions are verbatim unchanged (project / user / global_lane_queue)."""
    project = _client_raising(
        ProjectTaskLimitExceeded(
            project_id="proj_1", queue_kind="video", limit=4, active=4
        )
    ).get("/_test/task-limit")
    assert project.status_code == 429
    assert project.json()["data"] == {
        "project_id": "proj_1",
        "queue_kind": "video",
        "limit": 4,
        "active": 4,
        "limit_scope": "project",
    }

    project_user = _client_raising(
        ProjectUserTaskLimitExceeded(
            project_id="proj_1",
            requester_user_id="user_1",
            queue_kind="video",
            limit=1,
            active=1,
        )
    ).get("/_test/task-limit")
    assert project_user.status_code == 429
    assert project_user.json()["data"] == {
        "project_id": "proj_1",
        "requester_user_id": "user_1",
        "queue_kind": "video",
        "limit": 1,
        "active": 1,
        "limit_scope": "user",
    }

    global_lane = _client_raising(
        GlobalLaneQueueLimitExceeded(
            project_id="proj_1", queue_kind="world", limit=1, queued=1
        )
    ).get("/_test/task-limit")
    assert global_lane.status_code == 429
    assert global_lane.json()["data"] == {
        "project_id": "proj_1",
        "queue_kind": "world",
        "limit": 1,
        "queued": 1,
        "limit_scope": "global_lane_queue",
    }


# ---------------------------------------------------------------------------
# 3. Core: through the real freezone routes, not downgraded to 503
#    harness follows tests/test_freezone_image_backend.py:224-253
# ---------------------------------------------------------------------------


def _project_ctx(tmp_path: Path) -> ProjectContext:
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


def _patch_freezone_project(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ctx = _project_ctx(tmp_path)
    project_dir = tmp_path / "project"
    output_dir = tmp_path / "output"

    async def fake_resolve_freezone_project(*_args, **_kwargs):
        return ctx, "admin", "58", project_dir, str(output_dir)

    monkeypatch.setattr(
        freezone_routes, "_resolve_freezone_project", fake_resolve_freezone_project
    )


def _patch_enqueue_raising(
    monkeypatch: pytest.MonkeyPatch, exc: RuntimeError
) -> None:
    async def fake_enqueue_project_task(_ctx: ProjectContext, **_kwargs):
        raise exc

    monkeypatch.setattr(
        freezone_routes,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task),
    )


def _freezone_client() -> TestClient:
    production_app = create_app()
    # Same method as test_freezone_image_backend.py: borrow only the production app's exception handlers,
    # and mount the route on a clean app, avoiding the shared router/port state accumulated in full serial runs.
    app = FastAPI()
    app.exception_handlers.update(production_app.exception_handlers)
    app.include_router(freezone_routes.router, prefix="/api/v1")

    async def fake_user():
        return {"id": "owner_1", "username": "admin"}

    app.dependency_overrides[freezone_routes.get_api_user] = fake_user
    return TestClient(app)


def _post_omni_gen(client: TestClient):
    return client.post(
        "/api/v1/projects/58/freezone/video/omni-gen",
        json={"prompt": "A rainy street at night, the character slowly turns around."},
    )


@pytest.mark.parametrize(
    ("exc", "expected_scope"),
    [
        (
            ChannelTaskLimitExceeded(
                scope_kind="organization",
                org_id="org_9",
                queue_kind="video",
                limit=2,
                active=2,
            ),
            "channel",
        ),
        (
            ChannelTaskLimitExceeded(
                scope_kind="platform",
                org_id=None,
                queue_kind="video",
                limit=8,
                active=8,
            ),
            "platform",
        ),
        (
            UserTaskLimitExceeded(
                requester_user_id="owner_1",
                queue_kind="video",
                limit=1,
                active=1,
            ),
            "user",
        ),
    ],
    ids=["channel", "platform", "user"],
)
def test_new_limit_exceptions_are_not_downgraded_to_503_on_real_route(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    exc: RuntimeError,
    expected_scope: str,
) -> None:
    """Without adding to _raise_if_task_limit_exception, this is what you get: 503 (the recurrence path of Feishu 64-171)."""
    _patch_freezone_project(monkeypatch, tmp_path)
    _patch_enqueue_raising(monkeypatch, exc)

    response = _post_omni_gen(_freezone_client())

    assert response.status_code != 503
    assert response.status_code == 429
    assert response.json()["data"]["limit_scope"] == expected_scope


@pytest.mark.parametrize(
    ("exc", "expected_scope"),
    [
        (
            ProjectTaskLimitExceeded(
                project_id="proj_freezone", queue_kind="video", limit=4, active=4
            ),
            "project",
        ),
        (
            ProjectUserTaskLimitExceeded(
                project_id="proj_freezone",
                requester_user_id="owner_1",
                queue_kind="video",
                limit=1,
                active=1,
            ),
            "user",
        ),
        (
            GlobalLaneQueueLimitExceeded(
                project_id="proj_freezone", queue_kind="video", limit=2, queued=2
            ),
            "global_lane_queue",
        ),
    ],
    ids=["project", "project_user", "global_lane_queue"],
)
def test_existing_limit_exceptions_are_not_downgraded_to_503_on_real_route(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    exc: RuntimeError,
    expected_scope: str,
) -> None:
    """The existing three exceptions have not regressed.

    The ``global_lane_queue`` one is **red** today: the handler at ``app.py:143-162`` has long been there,
    but ``_raise_if_task_limit_exception`` does not recognize it, and the broad ``except RuntimeError`` swallows it
    into 503 first -- M8 §4 step 7 calls this "a live specimen, fix it in passing"; for disposal see register entry ``TCP-P44``.
    """
    _patch_freezone_project(monkeypatch, tmp_path)
    _patch_enqueue_raising(monkeypatch, exc)

    response = _post_omni_gen(_freezone_client())

    assert response.status_code != 503
    assert response.status_code == 429
    assert response.json()["data"]["limit_scope"] == expected_scope


# ---------------------------------------------------------------------------
# 4. Copy forks by scope
#    The shared pool (``scope_kind == "platform"``) rejects requests that belong to no channel,
#    to whom the concept of "channel" means nothing, and the accompanying wait guidance cannot be carried out either.
# ---------------------------------------------------------------------------


def test_platform_scope_message_avoids_channel_wording() -> None:
    response = _client_raising(
        ChannelTaskLimitExceeded(
            scope_kind="platform",
            org_id=None,
            queue_kind="default",
            limit=32,
            active=32,
        )
    ).get("/_test/task-limit")

    message = response.json()["error"]
    assert "channel" not in message
    assert "organization" not in message
    assert "platform" in message
    assert "default" in message
    # The shared pool is shared platform-wide, and the blocked user may not have any task running at all --
    # telling them to "wait for existing tasks to finish" is non-actionable guidance.
    assert "wait for existing tasks" not in message.lower()


def test_organization_scope_message_keeps_channel_wording() -> None:
    response = _client_raising(
        ChannelTaskLimitExceeded(
            scope_kind="organization",
            org_id="org_9",
            queue_kind="video",
            limit=2,
            active=2,
        )
    ).get("/_test/task-limit")

    assert response.json()["error"] == (
        "The video queue for this channel is full. Wait for existing tasks to finish before submitting again."
    )


def test_message_split_leaves_channel_handler_data_untouched() -> None:
    """The fork only touches the error copy, and data is verbatim unchanged in both scopes."""
    platform = _client_raising(
        ChannelTaskLimitExceeded(
            scope_kind="platform",
            org_id=None,
            queue_kind="world",
            limit=8,
            active=8,
        )
    ).get("/_test/task-limit")
    assert platform.json()["data"] == {
        "scope_kind": "platform",
        "org_id": None,
        "queue_kind": "world",
        "limit": 8,
        "active": 8,
        "limit_scope": "platform",
    }

    organization = _client_raising(
        ChannelTaskLimitExceeded(
            scope_kind="organization",
            org_id="org_9",
            queue_kind="world",
            limit=8,
            active=8,
        )
    ).get("/_test/task-limit")
    assert organization.json()["data"] == {
        "scope_kind": "organization",
        "org_id": "org_9",
        "queue_kind": "world",
        "limit": 8,
        "active": 8,
        "limit_scope": "channel",
    }


_LIMIT_LOGGER = "novelvideo.task_backend.limit_logging"

# ---------------------------------------------------------------------------
# 5. Rate-limit logs
#    The 429 limit_scope used to live only in the response body and nothing was logged -- in production after a limit hit
#    there was no way to attribute which of the five gates it was. These five handlers cover the exit of "the exception escapes to the HTTP layer";
#    the exit where a fan-out loop swallows the exception is covered separately in tests/test_fanout_partial_dispatch.py.
# ---------------------------------------------------------------------------

_LIMIT_LOG_CASES = (
    (
        ProjectTaskLimitExceeded(
            project_id="proj_1", queue_kind="video", limit=4, active=4
        ),
        (
            "limit_scope=project",
            "queue_kind=video",
            "limit=4",
            "active=4",
            "project_id=proj_1",
        ),
    ),
    (
        ProjectUserTaskLimitExceeded(
            project_id="proj_1",
            requester_user_id="user_1",
            queue_kind="video",
            limit=1,
            active=1,
        ),
        (
            "limit_scope=user",
            "requester_user_id=user_1",
            "project_id=proj_1",
        ),
    ),
    (
        GlobalLaneQueueLimitExceeded(
            project_id="proj_1", queue_kind="world", limit=2, queued=2
        ),
        (
            "limit_scope=global_lane_queue",
            "queued=2",
            "project_id=proj_1",
        ),
    ),
    (
        ChannelTaskLimitExceeded(
            scope_kind="platform",
            org_id=None,
            queue_kind="default",
            limit=32,
            active=32,
        ),
        (
            "limit_scope=platform",
            "scope_kind=platform",
            "org_id=-",
            "queue_kind=default",
            "limit=32",
            "active=32",
        ),
    ),
    (
        ChannelTaskLimitExceeded(
            scope_kind="organization",
            org_id="org_9",
            queue_kind="video",
            limit=2,
            active=2,
        ),
        (
            "limit_scope=channel",
            "scope_kind=organization",
            "org_id=org_9",
        ),
    ),
    (
        UserTaskLimitExceeded(
            requester_user_id="user_7", queue_kind="default", limit=1, active=1
        ),
        (
            "limit_scope=user",
            "requester_user_id=user_7",
            "queue_kind=default",
        ),
    ),
)


@pytest.mark.parametrize(
    ("exc", "expected_fragments"),
    _LIMIT_LOG_CASES,
    ids=[
        "project",
        "project_user",
        "global_lane_queue",
        "channel_platform",
        "channel_organization",
        "user",
    ],
)
def test_every_limit_handler_emits_one_attributable_warning(
    caplog: pytest.LogCaptureFixture,
    exc: RuntimeError,
    expected_fragments: tuple[str, ...],
) -> None:
    caplog.set_level(logging.WARNING, logger=_LIMIT_LOGGER)

    _client_raising(exc).get("/_test/task-limit")

    records = [
        record
        for record in caplog.records
        if record.name == _LIMIT_LOGGER
        and "task lane limit rejected" in record.getMessage()
    ]
    assert len(records) == 1, "Exactly one per rejection, no more, no less"

    message = records[0].getMessage()
    assert records[0].levelno == logging.WARNING
    for fragment in expected_fragments:
        assert fragment in message, f"{fragment!r} is not in {message!r}"


def test_limit_log_never_carries_names_only_ids(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """May log business IDs, never user names / project names."""
    caplog.set_level(logging.WARNING, logger=_LIMIT_LOGGER)

    _client_raising(
        ChannelTaskLimitExceeded(
            scope_kind="organization",
            org_id="org_9",
            queue_kind="video",
            limit=2,
            active=2,
        )
    ).get("/_test/task-limit")

    message = next(
        record.getMessage()
        for record in caplog.records
        if "task lane limit rejected" in record.getMessage()
    )
    assert "username" not in message
    assert "project_name" not in message
