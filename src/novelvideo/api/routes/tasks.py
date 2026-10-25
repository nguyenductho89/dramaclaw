"""Task list / status / terminate endpoints."""

import asyncio
import json
import logging
from dataclasses import asdict
from pathlib import Path
from typing import Any

import anyio
from fastapi import APIRouter, Depends, Query, Request
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse

from novelvideo.api.auth import (
    get_api_user,
    get_api_user_or_query,
    verify_credential_for_request,
)
from novelvideo.api.sse_shutdown import (
    shutdown_aware_sse_response,
    wait_interval_or_shutdown,
)
from novelvideo.i18n_message import has_localizable_log, log_lines_text
from novelvideo.ports import get_project_access, get_task_backend
from novelvideo.project_context import ProjectContext, resolve_project_context
from novelvideo.task_backend.limits import (
    project_lane_effective_active_limit,
    project_user_lane_active_limit,
)
from novelvideo.task_backend.queues import QUEUE_KINDS
from novelvideo.task_identity import project_task_state_key, task_state_key
from novelvideo.task_state import TaskState, get_task_manager, parse_task_timestamp
from novelvideo.utils.static_urls import project_static_url

logger = logging.getLogger("novelvideo.api.tasks")

router = APIRouter()

_SSE_REVERIFY_INTERVAL_S = 30.0
_TASK_NOT_FOUND_GRACE_S = 10.0
_TASK_TYPE_LABELS = {
    "ingest_fast": "Fast import",
    "build_characters": "Build characters",
    "build_scenes": "Build scenes",
    "build_props": "Build props",
    "build_episodes": "Plan episodes",
    "identity_planner": "Plan identities",
    "script_writer": "Generate script",
    "beat_video_prompt": "Generate prompt",
    "literal_script_writer": "Generate narration script",
    "director_notes": "Director notes",
    "episode_scene_planner": "Plan scenes",
    "episode_prop_planner": "Plan props",
    "character_portrait": "Character portrait",
    "identity_image": "Identity portrait",
    "scene_reference_asset": "Scene reference image",
    "prop_reference_asset": "Prop reference image",
    "sketch_generation": "Generate sketch",
    "director_control_to_sketch": "Director desk to sketch",
    "sketch_grid_generation": "Generate sketch grid",
    "sketch_regen": "Regenerate sketch",
    "mainline_sketch_from_context": "Generate sketch",
    "mainline_frame_from_context": "Render shots",
    "selected_regen": "Regenerate selection",
    "grid_regenerate": "Regenerate grid",
    "single_video": "Generate single-shot video",
    "global_optimize_video": "Global video optimization",
    "compose_episode": "Compose episode",
    "audio_generation": "Generate audio",
    "indextts2_audio_generation": "Generate audio",
    "audio_generation_indextts2": "Generate audio",
    "system_voice_setup": "Prepare system voice",
    "freezone_video_gen": "Freezone video",
    "freezone_video_multishot": "Freezone multishot video",
    "stage_asset": "Scene assets",
    "freezone_gen": "Freezone generation",
    "freezone_edit": "Freezone edit",
    "freezone_mask_edit": "Local edit",
    "freezone_extract": "Video frame extraction",
    "freezone_analyze": "Video analysis",
    "freezone_video_story": "Video interpretation",
    "freezone_video_erase": "Video erase",
    "freezone_video_upscale": "Video upscale",
    "freezone_audio_separate": "Audio separation",
    "freezone_video_compose": "Video composition",
    "freezone_text_translate": "Subtitle translation",
    "freezone_text_generate": "AI text generation",
    "freezone_skill_import": "External Skill conversion",
    "freezone_story_script": "Generate story script",
    "freezone_script_to_video_plan": "Script to video plan",
    "freezone_audio_speech": "Generate speech",
    "freezone_audio_eleven_music": "Generate music",
    "freezone_image_to_3gs": "Image to world",
    "freezone_image_reverse_prompt": "Image reverse prompt",
}
_STAGE_ASSET_STEP_LABELS = {
    "pano_from_master": "Panorama from Master",
    "pano_from_text": "Text-to-panorama",
    "pano_sharp": "Panorama to SOG",
    "single_face_sharp": "Single face to SOG",
    "voxel_world_from_360": "Panorama to voxels",
    "scene_360": "Generate 360 panorama",
    "upload_package": "Upload scene package",
    "splat_collision": "Generate collision body",
}


def _effective_task_status(t: TaskState) -> str:
    if (
        t.status in {"submitting", "queued", "running"}
        and t.progress >= 1.0
        and str(t.current_task or "").strip().lower() in {"completed", "done"}
    ):
        return "completed"
    return t.status


def _serialize_task_timestamp(value: str) -> str:
    parsed = parse_task_timestamp(value)
    if parsed is None:
        return str(value or "")
    return parsed.isoformat().replace("+00:00", "Z")


async def _sse_token_still_valid(
    request: Request, last_check: float
) -> tuple[bool, float]:
    now = asyncio.get_event_loop().time()
    if now - last_check < _SSE_REVERIFY_INTERVAL_S:
        return True, last_check
    try:
        user = await verify_credential_for_request(request)
    except Exception:
        logger.debug("SSE credential recheck failed")
        return False, now
    return (user is not None), now


def _is_result_path_key(key: str) -> bool:
    lowered = str(key or "").lower()
    if lowered in {"path", "paths"}:
        return True
    return lowered.endswith("_path") or lowered.endswith("_paths")


def _url_key_for_path_key(key: str) -> str:
    if key == "path":
        return "url"
    if key == "paths":
        return "urls"
    if key.endswith("_paths"):
        return f"{key[:-6]}_urls"
    if key.endswith("_path"):
        return f"{key[:-5]}_url"
    return "url"


def _is_public_url_value(value: str) -> bool:
    lowered = value.strip().lower()
    return (
        lowered.startswith("/static/")
        or lowered.startswith("http://")
        or lowered.startswith("https://")
        or lowered.startswith("blob:")
        or lowered.startswith("data:")
    )


def _project_static_url_for_abs_path(ctx: ProjectContext, value: str) -> str | None:
    raw = str(value or "").strip()
    if not raw or _is_public_url_value(raw):
        return None
    path = Path(raw)
    if not path.is_absolute():
        return None
    try:
        resolved = path.resolve()
        rel = resolved.relative_to(Path(ctx.output_dir).resolve()).as_posix()
    except (OSError, ValueError):
        return None
    return project_static_url(ctx.project_id, rel, local_path=resolved)


def _is_local_abs_path_value(value: str) -> bool:
    raw = str(value or "").strip()
    return bool(raw) and not _is_public_url_value(raw) and Path(raw).is_absolute()


def _sanitize_task_result_for_client(value: Any, *, ctx: ProjectContext | None) -> Any:
    if ctx is None:
        return value
    if isinstance(value, list):
        return [_sanitize_task_result_for_client(item, ctx=ctx) for item in value]
    if not isinstance(value, dict):
        return value

    sanitized: dict[str, Any] = {}
    for key, item in value.items():
        key_text = str(key)
        if _is_result_path_key(key_text):
            url_key = _url_key_for_path_key(key_text)
            if isinstance(item, str):
                url = _project_static_url_for_abs_path(ctx, item)
                if url:
                    sanitized.setdefault(url_key, url)
                    continue
            if isinstance(item, list):
                urls = [
                    url
                    for url in (
                        _project_static_url_for_abs_path(ctx, path)
                        for path in item
                        if isinstance(path, str)
                    )
                    if url
                ]
                if urls:
                    sanitized.setdefault(url_key, urls)
                    continue
            if isinstance(item, str) and _is_local_abs_path_value(item):
                continue
            if isinstance(item, list) and any(
                isinstance(path, str) and _is_local_abs_path_value(path)
                for path in item
            ):
                continue
        sanitized[key_text] = _sanitize_task_result_for_client(item, ctx=ctx)
    return sanitized


def _current_task_message_fields(metadata: dict | None) -> dict:
    """Flatten the i18n code/params of current_task to the top level of the response.

    To avoid adding columns to the CE tasks table and the EE ee_task_states, the storage layer tucks code/params into
    metadata; externally independent fields are still provided, so the frontend need not know this storage detail.
    When there is no code the fields are not sent, and the frontend falls back directly to the English text of current_task.
    """
    if not isinstance(metadata, dict):
        return {}
    message = metadata.get("current_task_message")
    if not isinstance(message, dict) or not message.get("code"):
        return {}
    return {
        "current_task_code": message["code"],
        "current_task_params": message.get("params") or {},
    }


def _task_log_fields(entries: list | None) -> dict:
    """External shape of `logs`.

    `logs` has been a `string[]` from the start, and old frontends do `logs.join("\\n")` on it, so storage-layer
    `{text, code, params}` entries **must not** leave through this field -- during a rolling release a new backend with an old frontend,
    or a user with a cached old page still open, would see logs displayed/downloaded as a string of `[object Object]`.
    Here they are flattened back into plain strings, and structured entries go through `logs_i18n` separately; new frontends read it first and fall back
    to `logs`. This way frontend and backend need no atomic deployment, and external callers are not disrupted.
    """
    fields: dict = {"logs": log_lines_text(entries)}
    # When no entry carries a code the field is not sent, to avoid attaching a duplicate copy of the logs to every task.
    if has_localizable_log(entries):
        fields["logs_i18n"] = list(entries or [])
    return fields


def _serialize_task(t: TaskState, *, ctx: ProjectContext | None = None) -> dict:
    metadata = t.metadata if isinstance(t.metadata, dict) else {}
    if t.project_id:
        key = project_task_state_key(
            task_type=t.task_type,
            project_id=t.project_id,
            episode=t.episode,
            beat_num=t.beat_num,
            scope=t.scope,
        )
    else:
        key = task_state_key(
            task_type=t.task_type,
            username=t.username,
            project=t.project,
            episode=t.episode,
            beat_num=t.beat_num,
            scope=t.scope,
        )
    task_type_label = _TASK_TYPE_LABELS.get(t.task_type, t.task_type)
    metadata_display_name = str(metadata.get("display_name") or "").strip()
    episode_label = f" · ep{t.episode}" if t.episode else ""
    display_name = metadata_display_name or f"{task_type_label}{episode_label}"
    if t.task_type == "stage_asset":
        scene_name = str(metadata.get("scene_name") or "").strip()
        step = str(metadata.get("step") or "").strip()
        step_label = _STAGE_ASSET_STEP_LABELS.get(step, step)
        display_parts = [task_type_label]
        if scene_name:
            display_parts.append(scene_name)
        if step_label:
            display_parts.append(step_label)
        display_name = " · ".join(display_parts)
    payload = asdict(t)
    for field in ("created_at", "updated_at", "completed_at", "expires_at"):
        payload[field] = _serialize_task_timestamp(payload.get(field, ""))
    payload.update(_task_log_fields(payload.get("logs")))
    payload["result"] = _sanitize_task_result_for_client(payload.get("result"), ctx=ctx)
    payload["status"] = _effective_task_status(t)
    return {
        **payload,
        "error_code": metadata.get("error_code"),
        "task_key": key,
        "task_type_label": task_type_label,
        "display_name": display_name,
        # display_name is always English: either assembled here from task_type, or hard-coded text passed by the caller
        # (task_display of freezone / scripts); neither can be used directly in a localized UI,
        # so it is localizable by default and the frontend reassembles it from task_type / metadata.
        #
        # Only genuine user-defined names (canvas names, asset names, etc.) must not be translated; those are opted out of localization by the producer
        # explicitly marking `display_name_user_content: True` in metadata. Note that
        # task_display is entirely constructed server-side and cannot be injected through the request body, so this marker must be set by the backend
        # itself and must not be changed to read a client field.
        "display_name_localizable": not bool(metadata.get("display_name_user_content")),
        **_current_task_message_fields(t.metadata),
    }


def _remaining(limit: int | None, active: int) -> int | None:
    if limit is None:
        return None
    return max(limit - active, 0)


@router.get("/projects/{project}/tasks")
async def list_project_tasks(project: str, user: dict = Depends(get_api_user)):
    """List the tasks of a single project. In production multi-node paths OpenResty routes to the project's home node."""
    ctx = await resolve_project_context(
        user=user, project_id=project, required_role="viewer"
    )
    mgr = get_task_manager()
    tasks = await run_in_threadpool(mgr.list_tasks_for_project, ctx)
    tasks.sort(key=lambda task: task.updated_at or task.created_at or "", reverse=True)
    return {"ok": True, "data": [_serialize_task(t, ctx=ctx) for t in tasks]}


@router.get("/projects/{project}/tasks/limits")
async def get_project_task_limits(project: str, user: dict = Depends(get_api_user)):
    """Query the project pools of each queue and the current user's quota for a single project."""
    ctx = await resolve_project_context(
        user=user, project_id=project, required_role="viewer"
    )
    mgr = get_task_manager()
    eligible_user_count = await get_project_access().count_project_task_eligible_users(
        project_id=ctx.project_id,
        owner_type=ctx.owner_type,
        owner_id=ctx.owner_id,
    )
    data = {}
    for queue_kind in sorted(QUEUE_KINDS):
        limit = project_lane_effective_active_limit(
            queue_kind,
            eligible_user_count=eligible_user_count,
        )
        user_limit = project_user_lane_active_limit(queue_kind)
        active, user_active = await run_in_threadpool(
            lambda: (
                mgr.count_active_tasks_for_project_lane(ctx, queue_kind),
                mgr.count_active_tasks_for_project_user_lane(ctx, queue_kind),
            )
        )
        data[queue_kind] = {
            "limit": limit,
            "active": active,
            "remaining": _remaining(limit, active),
            "user_limit": user_limit,
            "user_active": user_active,
            "user_remaining": _remaining(user_limit, user_active),
        }
    return {"ok": True, "data": data}


@router.delete("/projects/{project}/tasks/completed")
async def clear_project_completed_tasks(
    project: str, user: dict = Depends(get_api_user)
):
    """Delete the completed task records of a single project."""
    ctx = await resolve_project_context(
        user=user, project_id=project, required_role="editor"
    )
    mgr = get_task_manager()

    def clear_completed() -> int:
        deleted = 0
        for task in mgr.list_tasks_for_project(ctx):
            if _effective_task_status(task) == "completed":
                was_deleted = mgr.delete_task_for_project(
                    ctx,
                    task.task_type,
                    task.episode,
                    beat_num=task.beat_num,
                    scope=task.scope,
                    expected_task_id=task.task_id,
                )
                if was_deleted:
                    deleted += 1
        return deleted

    deleted = await run_in_threadpool(clear_completed)
    return {"ok": True, "data": {"deleted": deleted}}


@router.get("/projects/{project}/tasks/{task_type}/{episode}")
async def get_project_task(
    project: str,
    task_type: str,
    episode: int,
    beat_num: int = Query(
        None, description="Beat number (needed for per-beat tasks such as single_video)"
    ),
    scope: str | None = Query(
        None, description="Task scope (mode_key, grid_index, etc.)"
    ),
    user: dict = Depends(get_api_user),
):
    """Query the status of a specified task within a single project."""
    ctx = await resolve_project_context(
        user=user, project_id=project, required_role="viewer"
    )
    mgr = get_task_manager()
    task = await run_in_threadpool(
        mgr.get_task_for_project,
        ctx,
        task_type,
        episode,
        beat_num=beat_num,
        scope=scope,
    )
    if not task:
        return {"ok": True, "data": None, "message": "Task not found"}
    return {"ok": True, "data": _serialize_task(task, ctx=ctx)}


@router.get("/projects/{project}/tasks/stream")
async def stream_project_tasks(
    project: str,
    request: Request,
    interval: float = Query(2.0, ge=0.5, le=10.0),
    heartbeat_sec: float = Query(15.0, ge=1.0, le=60.0),
    snapshot: bool = Query(
        True,
        description=(
            "If false, skip initial task_updated burst on connect "
            "(client has already hydrated via GET project tasks)."
        ),
    ),
    user: dict = Depends(get_api_user_or_query),
):
    """Project-level SSE task stream. OpenResty can route by project_id to the home node."""
    ctx = await resolve_project_context(
        user=user, project_id=project, required_role="viewer"
    )

    async def event_generator(shutdown: anyio.Event):
        mgr = get_task_manager()
        last: dict[str, tuple[str, float, str]] = {}
        last_heartbeat = asyncio.get_event_loop().time()
        last_auth_check = last_heartbeat

        for t in await run_in_threadpool(mgr.list_tasks_for_project, ctx):
            payload = _serialize_task(t, ctx=ctx)
            key = payload["task_key"]
            last[key] = (t.status, round(t.progress, 3), t.updated_at)
            if snapshot:
                yield {
                    "event": "task_updated",
                    "data": json.dumps(payload, ensure_ascii=False),
                }

        yield {
            "event": "heartbeat",
            "data": json.dumps({"ts": last_heartbeat}, ensure_ascii=False),
        }

        while True:
            try:
                still_valid, last_auth_check = await _sse_token_still_valid(
                    request, last_auth_check
                )
            except Exception:
                logger.debug("SSE credential recheck failed")
                still_valid = False
            if not still_valid:
                yield {
                    "event": "auth_revoked",
                    "data": json.dumps({"reason": "unauthorized"}),
                }
                return

            tasks = await run_in_threadpool(mgr.list_tasks_for_project, ctx)
            seen: set[str] = set()
            for t in tasks:
                payload = _serialize_task(t, ctx=ctx)
                key = payload["task_key"]
                seen.add(key)
                fp = (t.status, round(t.progress, 3), t.updated_at)
                if last.get(key) != fp:
                    yield {
                        "event": "task_updated",
                        "data": json.dumps(payload, ensure_ascii=False),
                    }
                    last[key] = fp

            for key in list(last.keys()):
                if key not in seen:
                    yield {
                        "event": "deleted",
                        "data": json.dumps({"task_key": key}, ensure_ascii=False),
                    }
                    del last[key]

            now = asyncio.get_event_loop().time()
            if now - last_heartbeat >= heartbeat_sec:
                yield {
                    "event": "heartbeat",
                    "data": json.dumps({"ts": now}, ensure_ascii=False),
                }
                last_heartbeat = now

            if await wait_interval_or_shutdown(shutdown, interval):
                return

    return shutdown_aware_sse_response(event_generator)


@router.get("/projects/{project}/tasks/{task_type}/{episode}/stream")
async def stream_project_task(
    project: str,
    task_type: str,
    episode: int,
    request: Request,
    beat_num: int = Query(None),
    scope: str | None = Query(None),
    interval: float = Query(2.0, ge=0.5, le=10.0),
    user: dict = Depends(get_api_user_or_query),
):
    """Project-level single-task SSE endpoint."""
    ctx = await resolve_project_context(
        user=user, project_id=project, required_role="viewer"
    )

    async def event_generator(shutdown: anyio.Event):
        last_progress = -1.0
        last_task = ""
        last_auth_check = asyncio.get_event_loop().time()
        not_found_deadline = None
        while True:
            try:
                still_valid, last_auth_check = await _sse_token_still_valid(
                    request, last_auth_check
                )
            except Exception:
                logger.debug("SSE credential recheck failed")
                still_valid = False
            if not still_valid:
                yield {
                    "event": "auth_revoked",
                    "data": json.dumps({"reason": "unauthorized"}),
                }
                return

            mgr = get_task_manager()
            task = await run_in_threadpool(
                mgr.get_task_for_project,
                ctx,
                task_type,
                episode,
                beat_num=beat_num,
                scope=scope,
            )

            if not task:
                import time

                now = time.monotonic()
                if not_found_deadline is None:
                    not_found_deadline = now + _TASK_NOT_FOUND_GRACE_S
                if now < not_found_deadline:
                    if await wait_interval_or_shutdown(shutdown, interval):
                        return
                    continue
                yield {
                    "event": "error",
                    "data": json.dumps({"error": "Task not found"}, ensure_ascii=False),
                }
                return
            not_found_deadline = None

            effective_status = _effective_task_status(task)
            changed = (task.progress != last_progress) or (
                task.current_task != last_task
            )
            is_terminal = effective_status in ("completed", "failed", "cancelled")

            if changed or is_terminal:
                payload = {
                    "status": effective_status,
                    "progress": round(task.progress, 3),
                    "current_task": task.current_task,
                    **_task_log_fields(task.logs[-100:]),
                    **_current_task_message_fields(task.metadata),
                }
                if is_terminal:
                    payload["result"] = task.result
                    payload["error"] = task.error
                    if isinstance(task.metadata, dict):
                        payload["error_code"] = task.metadata.get("error_code")

                yield {
                    "event": effective_status,
                    "data": json.dumps(payload, ensure_ascii=False),
                }
                last_progress = task.progress
                last_task = task.current_task

            if is_terminal:
                return

            if await wait_interval_or_shutdown(shutdown, interval):
                return

    return shutdown_aware_sse_response(event_generator)


@router.delete("/projects/{project}/tasks/{task_type}/{episode}")
async def cancel_project_task_route(
    project: str,
    task_type: str,
    episode: int,
    beat_num: int = Query(
        None, description="Beat number (needed for per-beat tasks such as single_video)"
    ),
    scope: str | None = Query(
        None, description="Task scope (mode_key, grid_index, etc.)"
    ),
    force: bool = Query(False, description="Confirm terminating a task that has already started executing"),
    acknowledge_no_refund: bool = Query(False, description="Confirm that terminating while running does not refund credits"),
    user: dict = Depends(get_api_user),
):
    """Terminate a project task.

    Queued tasks are cancelled with an atomic state transition and refunded. For a running task the first request returns 409,
    and the cooperative-cancel marker and Celery revoke are sent only after the 'no refund' is explicitly confirmed again.
    """
    ctx = await resolve_project_context(
        user=user, project_id=project, required_role="editor"
    )
    logger.info(
        "[%s] EP%d cancel_project_task: type=%s, beat=%s, scope=%s",
        project,
        episode,
        task_type,
        beat_num,
        scope,
    )
    mgr = get_task_manager()
    task = await run_in_threadpool(
        mgr.get_task_for_project,
        ctx,
        task_type,
        episode,
        beat_num=beat_num,
        scope=scope,
    )
    if not task:
        logger.warning(
            "[%s] cancel_project_task: task not found (type=%s episode=%s beat=%s scope=%s)",
            project,
            task_type,
            episode,
            beat_num,
            scope,
        )
        return {"ok": False, "error": "Task not found"}
    result = await get_task_backend().cancel_project_task(
        ctx,
        task,
        force=force,
        acknowledge_no_refund=acknowledge_no_refund,
    )
    if result.get("requires_confirmation"):
        return JSONResponse(status_code=409, content=result)
    return result
