"""Standalone ASGI app for the 2.0 REST API."""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from collections import Counter
from contextlib import suppress
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse

from novelvideo.api import OPENAPI_TAGS, api_router, register_verification_routes
from novelvideo.api.auth import get_api_user
from novelvideo.api.routes.files import preview_project_media_file
from novelvideo.ports.authz import AuthzError, authz_error_payload
from novelvideo.shared.billing_errors import (
    BILLING_RULE_NOT_CONFIGURED_MESSAGE,
    INSUFFICIENT_CREDITS_MESSAGE,
    BillingError,
    BillingRuleNotConfiguredError,
    InsufficientCreditsError,
    billing_error_payload,
    billing_rule_not_configured_payload,
    insufficient_credits_payload,
)
from novelvideo.shared.api_coverage import mount_api_coverage_middleware
from novelvideo.task_backend.limit_logging import log_task_limit_rejection
from novelvideo.task_backend.limits import (
    ChannelTaskLimitExceeded,
    GlobalLaneQueueLimitExceeded,
    ProjectTaskLimitExceeded,
    ProjectUserTaskLimitExceeded,
    UserTaskLimitExceeded,
)
from novelvideo.utils.upload_safety import MAX_PROJECT_UPLOAD_BYTES

logger = logging.getLogger("novelvideo.api.app")

# Per durability plan §N: reject oversized request bodies before they
# reach a handler. 5 MB covers the largest legitimate freezone canvas
# (50k nodes × ~80 bytes JSON each) with comfortable headroom; anything
# bigger is almost certainly a runaway client / DoS attempt.
MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024
MAX_UPLOAD_REQUEST_BODY_BYTES = MAX_PROJECT_UPLOAD_BYTES
_RESOURCE_REQUEST_COUNTS: Counter[str] = Counter()
_RESOURCE_REQUEST_TOTAL = 0
_RESOURCE_REQUEST_LOCK = threading.Lock()


async def _resume_director_auto_best_effort(application: FastAPI) -> None:
    """Keep the additive Auto coordinator outside the core API startup boundary."""

    try:
        from novelvideo.chat.director_auto import (
            coordinator as director_auto_coordinator,
        )

        await director_auto_coordinator.resume()
    except Exception as exc:
        application.state.director_auto_available = False
        application.state.director_auto_startup_error = str(exc)
        logger.exception("Director Auto recovery failed (non-fatal)")
    else:
        application.state.director_auto_available = True
        application.state.director_auto_startup_error = ""


def _request_body_limit(request: Request) -> int:
    content_type = request.headers.get("content-type", "").lower()
    if (
        request.url.path.startswith("/api/v1/projects/")
        and (
            request.url.path.endswith("/upload")
            or request.url.path.endswith("/reference-file-upload")
        )
        and "multipart/form-data" in content_type
    ):
        return MAX_UPLOAD_REQUEST_BODY_BYTES
    return MAX_REQUEST_BODY_BYTES


def _is_freezone_audio_voice_upload(request: Request) -> bool:
    return (
        request.method.upper() == "POST"
        and request.url.path.startswith("/api/v1/projects/")
        and request.url.path.endswith("/freezone/audio/voices")
    )


def _resource_request_key(path: str) -> str | None:
    if path.startswith("/static/"):
        return path

    if not path.startswith("/api/v1/projects/"):
        return None

    parts = path.split("/")
    if len(parts) >= 6 and parts[4] in {"media", "files"}:
        return path
    return None


def _record_resource_request(resource_key: str) -> tuple[int, int]:
    global _RESOURCE_REQUEST_TOTAL
    with _RESOURCE_REQUEST_LOCK:
        _RESOURCE_REQUEST_TOTAL += 1
        _RESOURCE_REQUEST_COUNTS[resource_key] += 1
        return _RESOURCE_REQUEST_TOTAL, _RESOURCE_REQUEST_COUNTS[resource_key]


def create_app() -> FastAPI:
    register_verification_routes()

    application = FastAPI(title="NovelVideo API", openapi_tags=OPENAPI_TAGS)
    mount_api_coverage_middleware(application)

    @application.exception_handler(ProjectTaskLimitExceeded)
    async def _project_task_limit_exceeded(
        request: Request,
        exc: ProjectTaskLimitExceeded,
    ) -> JSONResponse:
        _ = request
        log_task_limit_rejection(exc, limit_scope="project")
        return JSONResponse(
            status_code=429,
            content={
                "ok": False,
                "error": f"The {exc.queue_kind} queue for this project is full. Wait for existing tasks to finish before submitting again.",
                "data": {
                    "project_id": exc.project_id,
                    "queue_kind": exc.queue_kind,
                    "limit": exc.limit,
                    "active": exc.active,
                    "limit_scope": "project",
                },
            },
        )

    @application.exception_handler(ProjectUserTaskLimitExceeded)
    async def _project_user_task_limit_exceeded(
        request: Request,
        exc: ProjectUserTaskLimitExceeded,
    ) -> JSONResponse:
        _ = request
        log_task_limit_rejection(exc, limit_scope="user")
        return JSONResponse(
            status_code=429,
            content={
                "ok": False,
                "error": (
                    f"Your {exc.queue_kind} queue for this project is full. "
                    "Wait for your own tasks to finish before submitting again."
                ),
                "data": {
                    "project_id": exc.project_id,
                    "requester_user_id": exc.requester_user_id,
                    "queue_kind": exc.queue_kind,
                    "limit": exc.limit,
                    "active": exc.active,
                    "limit_scope": "user",
                },
            },
        )

    @application.exception_handler(GlobalLaneQueueLimitExceeded)
    async def _global_lane_queue_limit_exceeded(
        request: Request,
        exc: GlobalLaneQueueLimitExceeded,
    ) -> JSONResponse:
        _ = request
        log_task_limit_rejection(exc, limit_scope="global_lane_queue")
        return JSONResponse(
            status_code=429,
            content={
                "ok": False,
                "error": f"The {exc.queue_kind} queue for this node is full. Please try again later.",
                "data": {
                    "project_id": exc.project_id,
                    "queue_kind": exc.queue_kind,
                    "limit": exc.limit,
                    "queued": exc.queued,
                    "limit_scope": "global_lane_queue",
                },
            },
        )

    @application.exception_handler(ChannelTaskLimitExceeded)
    async def _channel_task_limit_exceeded(
        request: Request,
        exc: ChannelTaskLimitExceeded,
    ) -> JSONResponse:
        _ = request
        limit_scope = "platform" if exc.scope_kind == "platform" else "channel"
        log_task_limit_rejection(exc, limit_scope=limit_scope)
        if exc.scope_kind == "platform":
            # The shared pool (``org_id is None``) rejects requests that belong to no channel; the concept of
            # "channel" means nothing to them, and the pool is shared platform-wide, so "wait for existing tasks to finish"
            # makes no sense either -- the blocked user may not have any task running at all.
            message = f"The platform {exc.queue_kind} queue is full. Please try again later."
        else:
            message = (
                f"The {exc.queue_kind} queue for this channel is full. Wait for existing tasks to finish before submitting again."
            )
        return JSONResponse(
            status_code=429,
            content={
                "ok": False,
                "error": message,
                "data": {
                    "scope_kind": exc.scope_kind,
                    "org_id": exc.org_id,
                    "queue_kind": exc.queue_kind,
                    "limit": exc.limit,
                    "active": exc.active,
                    "limit_scope": limit_scope,
                },
            },
        )

    @application.exception_handler(UserTaskLimitExceeded)
    async def _user_task_limit_exceeded(
        request: Request,
        exc: UserTaskLimitExceeded,
    ) -> JSONResponse:
        _ = request
        log_task_limit_rejection(exc, limit_scope="user")
        return JSONResponse(
            status_code=429,
            content={
                "ok": False,
                "error": (
                    f"Your in-flight tasks in the {exc.queue_kind} queue are at the limit. "
                    "Wait for your own tasks to finish before submitting again."
                ),
                "data": {
                    "requester_user_id": exc.requester_user_id,
                    "queue_kind": exc.queue_kind,
                    "limit": exc.limit,
                    "active": exc.active,
                    "limit_scope": "user",
                },
            },
        )

    @application.exception_handler(InsufficientCreditsError)
    async def _insufficient_credits(
        request: Request,
        exc: InsufficientCreditsError,
    ) -> JSONResponse:
        _ = request
        payload = insufficient_credits_payload(exc)
        return JSONResponse(
            status_code=402,
            content={
                "ok": False,
                "error": INSUFFICIENT_CREDITS_MESSAGE,
                "data": payload,
            },
        )

    @application.exception_handler(BillingRuleNotConfiguredError)
    async def _billing_rule_not_configured(
        request: Request,
        exc: BillingRuleNotConfiguredError,
    ) -> JSONResponse:
        _ = request
        return JSONResponse(
            status_code=409,
            content={
                "ok": False,
                "error": BILLING_RULE_NOT_CONFIGURED_MESSAGE,
                "data": billing_rule_not_configured_payload(exc),
            },
        )

    @application.exception_handler(BillingError)
    async def _billing_error(
        request: Request,
        exc: BillingError,
    ) -> JSONResponse:
        _ = request
        return JSONResponse(
            status_code=exc.http_status,
            content={
                "ok": False,
                "error": exc.user_message,
                "data": billing_error_payload(exc),
            },
        )

    @application.exception_handler(AuthzError)
    async def _authz_error(
        request: Request,
        exc: AuthzError,
    ) -> JSONResponse:
        # Without this handler the denial escaped to Starlette's
        # ServerErrorMiddleware, which answers text/plain 500 — no machine code
        # for the frontend and, because nothing on this path logged, no trace
        # for whoever triages it.
        logger.warning(
            "organization authorization denied: code=%s status=%s method=%s path=%s",
            exc.code,
            exc.http_status,
            request.method,
            request.url.path,
        )
        return JSONResponse(
            status_code=exc.http_status,
            content={
                "ok": False,
                "error": exc.user_message,
                "data": authz_error_payload(exc),
            },
        )

    @application.middleware("http")
    async def _limit_body_size(request: Request, call_next):
        cl = request.headers.get("content-length")
        if cl:
            try:
                limit = _request_body_limit(request)
                if int(cl) > limit:
                    if _is_freezone_audio_voice_upload(request):
                        return JSONResponse(
                            status_code=200,
                            content={
                                "ok": False,
                                "error": "Reference audio exceeds the 5MB limit. Compress or trim it and upload again.",
                                "data": {
                                    "code": "freezone_audio_voice_too_large",
                                    "field": "file",
                                    "limit": limit,
                                    "got": int(cl),
                                },
                            },
                        )
                    return JSONResponse(
                        status_code=413,
                        content={
                            "detail": {
                                "code": "canvas_payload_too_large",
                                "field": "body",
                                "limit": limit,
                                "got": int(cl),
                            }
                        },
                    )
            except ValueError:
                pass
        return await call_next(request)

    @application.middleware("http")
    async def _log_resource_requests(request: Request, call_next):
        resource_key = _resource_request_key(request.url.path)
        if resource_key is None:
            return await call_next(request)

        started_at = time.perf_counter()
        response = await call_next(request)
        duration_ms = (time.perf_counter() - started_at) * 1000
        total_count, same_resource_count = _record_resource_request(resource_key)

        query = request.url.query
        range_header = request.headers.get("range", "")
        content_length = response.headers.get("content-length", "")
        content_type = response.headers.get("content-type", "")
        logger.info(
            "resource request total=%s same_resource=%s method=%s status=%s "
            "duration_ms=%.1f path=%s query=%s range=%s bytes=%s content_type=%s",
            total_count,
            same_resource_count,
            request.method,
            response.status_code,
            duration_ms,
            resource_key,
            query or "-",
            range_header or "-",
            content_length or "-",
            content_type or "-",
        )
        return response

    @application.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @application.on_event("startup")
    async def startup() -> None:
        try:
            from novelvideo.ports.registry import ensure_bootstrap, get_port

            ensure_bootstrap()
            await get_port("lifecycle").on_startup(register_as_worker=True)

            from novelvideo.sqlite_pragmas import litestream_enabled

            if litestream_enabled():
                from novelvideo.backup.wal_migrator import migrate_state_tree
                from novelvideo.config import STATE_DIR

                try:
                    await asyncio.to_thread(migrate_state_tree, Path(STATE_DIR))
                except Exception:
                    logger.exception("WAL migration sweep failed (non-fatal)")

            from novelvideo.official_media_catalog_remote import (
                run_official_media_catalog_updater,
            )
            from novelvideo.shared.runtime_env import is_ce_effective

            if is_ce_effective():
                application.state.official_media_catalog_updater = (
                    asyncio.create_task(
                        run_official_media_catalog_updater(),
                        name="official-media-catalog-updater",
                    )
                )

        except Exception:
            logger.exception("API startup failed while connecting to control-plane")
            raise

        await _resume_director_auto_best_effort(application)

    @application.on_event("shutdown")
    async def shutdown() -> None:
        from novelvideo.ports.registry import PortNotRegistered, get_port

        updater = getattr(application.state, "official_media_catalog_updater", None)
        if updater is not None:
            updater.cancel()
            with suppress(asyncio.CancelledError):
                await updater

        from novelvideo.chat.director_auto import coordinator as director_auto_coordinator

        await director_auto_coordinator.shutdown()

        try:
            lifecycle = get_port("lifecycle")
        except PortNotRegistered:
            return
        await lifecycle.on_shutdown()

    application.include_router(api_router)

    @application.get(
        "/static/projects/{project}/{file_path:path}", include_in_schema=False
    )
    async def static_project_media(
        project: str,
        file_path: str,
        request: Request,
        st_thumb: str | None = None,
        user: dict = Depends(get_api_user),
    ):
        return await preview_project_media_file(
            project, file_path, user, st_thumb=st_thumb, request=request
        )

    @application.get("/static/{legacy_path:path}", include_in_schema=False)
    async def legacy_static_media(legacy_path: str):
        _ = legacy_path
        return PlainTextResponse(
            "legacy static path; use /static/projects/<project_id>/...\n",
            status_code=410,
        )

    # Native/portable deployment (no nginx): the backend serves the SPA directly. Mount only when DRAMACLAW_FRONTEND_DIST
    # points at the frontend build output directory; Docker/EE paths do not set this variable, so behavior is unchanged.
    # Mounted after all routes, so /api, /healthz, /static still match first.
    frontend_dist = os.environ.get("DRAMACLAW_FRONTEND_DIST", "").strip()
    if frontend_dist and Path(frontend_dist).is_dir():
        from fastapi.staticfiles import StaticFiles
        from starlette.exceptions import HTTPException as _StarletteHTTPException

        class _SpaStaticFiles(StaticFiles):
            """SPA fallback: unknown extensionless paths serve index.html.

            When StaticFiles misses it raises HTTPException(404) (a 404 response is returned only if dist
            contains 404.html), so the fallback must catch the exception; missing assets with an extension still 404 as usual.
            """

            async def get_response(self, path: str, scope):  # type: ignore[override]
                try:
                    return await super().get_response(path, scope)
                except _StarletteHTTPException as exc:
                    if exc.status_code == 404 and "." not in Path(path).name:
                        return await super().get_response("index.html", scope)
                    raise

        application.mount(
            "/", _SpaStaticFiles(directory=frontend_dist, html=True), name="spa"
        )

    return application


app = create_app()
