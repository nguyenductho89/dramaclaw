from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from novelvideo.project_context import ProjectContext

pytestmark = pytest.mark.m07


def _ctx(tmp_path: Path, *, role: str = "viewer") -> ProjectContext:
    return ProjectContext(
        project_id="proj_123",
        project_name="demo",
        owner_type="user",
        owner_id="user_owner",
        owner_username="admin",
        requester_user_id="user_viewer",
        requester_username="admin",
        requester_principals=(("user", "user_viewer"),),
        effective_role=role,
        home_node_id="node_a",
        output_dir=tmp_path / "output" / "admin" / "demo",
        state_dir=tmp_path / "state" / "admin" / "demo",
        runtime_dir=tmp_path / "runtime" / "admin" / "demo",
        is_home_node=True,
    )


def _install_fake_project_context(monkeypatch, ctx: ProjectContext) -> None:
    from novelvideo.api.routes import tasks as tasks_routes

    async def fake_resolve_project_context(**kwargs):
        assert kwargs["project_id"] == ctx.project_id
        return ctx

    monkeypatch.setattr(tasks_routes, "resolve_project_context", fake_resolve_project_context)


def _install_fake_task_manager(monkeypatch, tasks=None, task=None) -> None:
    from novelvideo.api.routes import tasks as tasks_routes

    class _FakeTaskManager:
        def __init__(self, payload, single):
            self._payload = payload or []
            self._single = single

        def list_tasks_for_project(self, ctx):
            return list(self._payload)

        def get_task_for_project(self, ctx, task_type, episode, beat_num=None, scope=None):
            return self._single

    monkeypatch.setattr(tasks_routes, "get_task_manager", lambda: _FakeTaskManager(tasks, task))


def test_stage_asset_task_display_name_includes_scene_and_step():
    from novelvideo.api.routes.tasks import _serialize_task
    from novelvideo.task_state import TaskState

    task = TaskState(
        task_id="task-1",
        task_type="stage_asset",
        project_id="proj_123",
        episode=0,
        scope="stage_asset__hash",
        status="queued",
        metadata={"scene_name": "Cafe", "step": "pano_from_master"},
    )

    payload = _serialize_task(task)

    assert payload["task_type_label"] == "Scene assets"
    assert payload["display_name"] == "Scene assets · Cafe · Panorama from Master"


def test_backend_authored_display_name_stays_localizable():
    """The display_name passed by freezone / scripts is system hard-coded text, not business content.

    review #447: this was once written as "display_name in metadata means localizable=False",
    so "Generate sketch · EP1 / Beat 3" was treated as a user-defined name, the frontend displayLabel passed it through as-is,
    and the task center, completion notices, and companion bubbles of the English UI kept showing the wrong language.
    """
    from novelvideo.api.routes.tasks import _serialize_task
    from novelvideo.task_state import TaskState

    task = TaskState(
        task_id="task-1",
        task_type="sketch_regen",
        project_id="proj_123",
        episode=1,
        beat_num=3,
        status="queued",
        # The real shape at freezone.py:2053
        metadata={
            "task_family": "mainline_skill",
            "task_label": "Generate sketch",
            "display_name": "Generate sketch · EP1 / Beat 3",
        },
    )

    payload = _serialize_task(task)

    assert payload["display_name"] == "Generate sketch · EP1 / Beat 3"
    assert payload["display_name_localizable"] is True


def test_user_authored_display_name_opts_out_of_localization():
    """A genuinely user-defined name is explicitly marked by the producer to opt out of localization; translating it would be wrong."""
    from novelvideo.api.routes.tasks import _serialize_task
    from novelvideo.task_state import TaskState

    task = TaskState(
        task_id="task-2",
        task_type="freezone_gen",
        project_id="proj_123",
        episode=0,
        status="queued",
        metadata={"display_name": "Rainy Alley Entrance · Second Edition", "display_name_user_content": True},
    )

    payload = _serialize_task(task)

    assert payload["display_name"] == "Rainy Alley Entrance · Second Edition"
    assert payload["display_name_localizable"] is False


def test_user_content_flag_survives_the_real_enqueue_projection():
    """Take the real chain: display_metadata_for_task -> TaskState -> _serialize_task.

    review #447 re-review: reading the opt-out marker only in _serialize_task is not enough; at enqueue time the projection whitelist of
    display_metadata_for_task would drop it, and the marker would be nominal only.
    """
    from novelvideo.api.routes.tasks import _serialize_task
    from novelvideo.ports.tasks import display_metadata_for_task
    from novelvideo.task_state import TaskState

    payload = {
        "display_name": "Rainy Alley Entrance · Second Edition",
        "display_name_user_content": True,
        "task_label": "Free image generation",
    }
    metadata = display_metadata_for_task("freezone_gen", payload)

    assert metadata["display_name_user_content"] is True

    payload_out = _serialize_task(
        TaskState(
            task_id="task-3",
            task_type="freezone_gen",
            project_id="proj_123",
            episode=0,
            status="queued",
            metadata=metadata,
        )
    )
    assert payload_out["display_name_localizable"] is False


def test_user_content_flag_is_not_coerced_through_the_string_loop():
    """The marker must be a boolean projection: str(False) == "False" is truthy and would invert the whole judgment."""
    from novelvideo.api.routes.tasks import _serialize_task
    from novelvideo.ports.tasks import display_metadata_for_task
    from novelvideo.task_state import TaskState

    for falsy in (False, None, "", 0):
        metadata = display_metadata_for_task(
            "freezone_gen",
            {"display_name": "Generate sketch · EP1 / Beat 3", "display_name_user_content": falsy},
        )
        assert "display_name_user_content" not in metadata, falsy
        payload = _serialize_task(
            TaskState(
                task_id="task-4",
                task_type="freezone_gen",
                project_id="proj_123",
                episode=1,
                status="queued",
                metadata=metadata,
            )
        )
        assert payload["display_name_localizable"] is True, falsy


def test_serialize_task_rewrites_internal_result_paths_to_project_static_urls(tmp_path):
    from novelvideo.api.routes.tasks import _serialize_task
    from novelvideo.task_state import TaskState

    ctx = _ctx(tmp_path)
    project_dir = Path(ctx.output_dir)
    output_path = project_dir / "freezone" / "_outputs" / "freezone_gen" / "job.png"
    frame_path = project_dir / "freezone" / "_outputs" / "freezone_extract" / "frame_001.png"
    last_frame_path = project_dir / "videos" / "beats" / "ep001" / "last.png"
    for path in (output_path, frame_path, last_frame_path):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"asset")

    task = TaskState(
        task_id="task-1",
        task_type="freezone_gen",
        project_id=ctx.project_id,
        episode=0,
        scope="job",
        status="completed",
        result={
            "output_path": str(output_path),
            "frame_paths": [str(frame_path)],
            "nested": {"last_frame_path": str(last_frame_path)},
            "target_path": "director_control_frames/ep001/beat_01/combined.png",
            "public_path": "/static/projects/proj_123/freezone/_outputs/public.png",
        },
    )

    payload = _serialize_task(task, ctx=ctx)
    result = payload["result"]

    assert "output_path" not in result
    assert "frame_paths" not in result
    assert "last_frame_path" not in result["nested"]
    assert result["target_path"] == "director_control_frames/ep001/beat_01/combined.png"
    assert result["output_url"].startswith("/static/projects/proj_123/freezone/_outputs/")
    assert result["frame_urls"][0].startswith("/static/projects/proj_123/freezone/_outputs/")
    assert result["nested"]["last_frame_url"].startswith("/static/projects/proj_123/videos/")
    assert result["public_path"] == "/static/projects/proj_123/freezone/_outputs/public.png"
    assert "/admin/demo/" not in str(result)


@pytest.mark.asyncio
async def test_project_stream_emits_heartbeat_immediately(tmp_path, monkeypatch):
    ctx = _ctx(tmp_path)
    _install_fake_project_context(monkeypatch, ctx)
    _install_fake_task_manager(monkeypatch, tasks=[])

    from novelvideo.api.routes.tasks import stream_project_tasks

    resp = await stream_project_tasks(
        project=ctx.project_id,
        request=None,  # type: ignore[arg-type]
        interval=0.5,
        heartbeat_sec=1.0,
        snapshot=False,
        user={"username": "admin", "role": "admin"},
    )

    gen = resp.body_iterator
    try:
        first = await asyncio.wait_for(gen.__anext__(), timeout=3.0)
    finally:
        aclose = getattr(gen, "aclose", None)
        if aclose is not None:
            await aclose()

    assert isinstance(first, dict)
    assert first.get("event") == "heartbeat"
    assert "ts" in json.loads(first["data"])


@pytest.mark.asyncio
async def test_project_stream_completes_when_server_shuts_down(tmp_path, monkeypatch):
    """On server shutdown the stream must end on its own and *complete* the
    response (final empty chunk), so uvicorn does not log a truncated response.
    The 10 s poll interval must not delay that."""
    from sse_starlette import sse as sse_module
    from sse_starlette.sse import AppStatus

    ctx = _ctx(tmp_path)
    _install_fake_project_context(monkeypatch, ctx)
    _install_fake_task_manager(monkeypatch, tasks=[])
    monkeypatch.setattr(AppStatus, "should_exit", False)
    monkeypatch.setattr(sse_module._thread_state, "shutdown_state", None, raising=False)

    from novelvideo.api.routes.tasks import stream_project_tasks

    resp = await stream_project_tasks(
        project=ctx.project_id,
        request=None,  # type: ignore[arg-type]
        interval=10.0,
        heartbeat_sec=60.0,
        snapshot=False,
        user={"username": "admin", "role": "admin"},
    )

    sent: list[dict] = []
    first_chunk = asyncio.Event()

    async def send(message):
        sent.append(message)
        if message["type"] == "http.response.body":
            first_chunk.set()

    async def receive():
        await asyncio.sleep(3600)  # the client never disconnects
        return {"type": "http.disconnect"}

    scope = {"type": "http", "method": "GET", "path": "/", "headers": []}
    call = asyncio.create_task(resp(scope, receive, send))
    try:
        await asyncio.wait_for(first_chunk.wait(), timeout=3.0)
        AppStatus.should_exit = True
        await asyncio.wait_for(call, timeout=5.0)
    finally:
        AppStatus.should_exit = False
        if not call.done():
            call.cancel()

    assert sent[-1] == {"type": "http.response.body", "body": b"", "more_body": False}


@pytest.mark.asyncio
async def test_project_stream_rejects_missing_auth():
    from novelvideo.api import api_router
    from novelvideo.ports import registry

    old_ports = dict(registry._PORTS)
    old_bootstrapped = registry._BOOTSTRAPPED
    registry._PORTS.clear()
    registry._BOOTSTRAPPED = False

    app = FastAPI()
    app.include_router(api_router)
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/v1/projects/proj_123/tasks/stream")
    finally:
        registry._PORTS.clear()
        registry._PORTS.update(old_ports)
        registry._BOOTSTRAPPED = old_bootstrapped

    assert response.status_code in (401, 403, 422, 503)
    if response.status_code == 503:
        assert response.json()["detail"] == "auth backend not initialised"


@pytest.mark.asyncio
async def test_project_task_stream_includes_logs(tmp_path, monkeypatch):
    from novelvideo.task_state import TaskState

    ctx = _ctx(tmp_path)
    _install_fake_project_context(monkeypatch, ctx)
    _install_fake_task_manager(
        monkeypatch,
        task=TaskState(
            task_id="t1",
            task_type="sketch_regen",
            username="admin",
            project="demo",
            project_id=ctx.project_id,
            episode=1,
            scope="scope-a",
            status="running",
            progress=0.5,
            current_task="Generating sketch",
            logs=["start", "step"],
        ),
    )

    from novelvideo.api.routes.tasks import stream_project_task

    resp = await stream_project_task(
        project=ctx.project_id,
        task_type="sketch_regen",
        episode=1,
        request=None,  # type: ignore[arg-type]
        scope="scope-a",
        interval=0.5,
        user={"username": "admin", "role": "admin"},
    )

    gen = resp.body_iterator
    try:
        first = await asyncio.wait_for(gen.__anext__(), timeout=3.0)
    finally:
        aclose = getattr(gen, "aclose", None)
        if aclose is not None:
            await aclose()

    payload = json.loads(first["data"])
    assert payload["logs"] == ["start", "step"]


@pytest.mark.asyncio
async def test_project_task_stream_keeps_logs_as_strings(tmp_path, monkeypatch):
    """The SSE `logs` must also uphold the `string[]` contract.

    Structured entries come out of the storage layer as `{text, code, params}`; pushed as-is to a frontend not yet upgraded
    (during a rolling release, or a stale cached page in the user's hands), the log panel becomes a string of
    `[object Object]`. The copy carrying a code goes through `logs_i18n`.
    """
    from novelvideo.task_state import TaskState

    ctx = _ctx(tmp_path)
    _install_fake_project_context(monkeypatch, ctx)
    _install_fake_task_manager(
        monkeypatch,
        task=TaskState(
            task_id="t1",
            task_type="ingest_fast",
            username="admin",
            project="demo",
            project_id=ctx.project_id,
            episode=0,
            status="running",
            progress=0.5,
            current_task="Splitting chapters...",
            logs=[
                "Task started",
                {
                    "text": "Split into 3 segments",
                    "code": "tasks.log.ingest.chunked",
                    "params": {"chunkCount": 3},
                },
            ],
        ),
    )

    from novelvideo.api.routes.tasks import stream_project_task

    resp = await stream_project_task(
        project=ctx.project_id,
        task_type="ingest_fast",
        episode=0,
        request=None,  # type: ignore[arg-type]
        interval=0.5,
        user={"username": "admin", "role": "admin"},
    )

    gen = resp.body_iterator
    try:
        first = await asyncio.wait_for(gen.__anext__(), timeout=3.0)
    finally:
        aclose = getattr(gen, "aclose", None)
        if aclose is not None:
            await aclose()

    payload = json.loads(first["data"])
    assert payload["logs"] == ["Task started", "Split into 3 segments"]
    assert payload["logs_i18n"][1]["code"] == "tasks.log.ingest.chunked"
