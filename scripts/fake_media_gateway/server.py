"""FastAPI app that mimics the NewAPI media contract dramaclaw talks to and renders on a ComfyUI server.

  POST /images/generations, /images/edits   -> Qwen-Image 2.1, synchronous, returns data[0].b64_json
  POST /video/generations                   -> MiniMax H3 v16, queued, returns task_id
  GET  /video/generations/{task_id}         -> status / result_url
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import math
import os
import random
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import h3_graph, qwen_graph
from .comfy_client import ComfyClient
from .vast_billing import Ledger

DEFAULT_IMAGE_RATIO = "1:1"
DEFAULT_VIDEO_RATIO = "16:9"
DEFAULT_VIDEO_SECONDS = 5


class RequestError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


@dataclass
class VideoTask:
    id: str
    prompt: str
    frames: int
    ratio: str
    seed: int
    images: list[str]
    voices: list[str]
    context: dict = field(default_factory=dict)
    status: str = "queued"
    error: str = ""
    gpu_seconds: float = 0.0
    created: int = field(default_factory=lambda: int(time.time()))


def _ratio_from(payload: dict, default: str) -> str:
    meta = payload.get("metadata") or {}
    ratio = str(meta.get("ratio") or "").strip()
    if not ratio and payload.get("width") and payload.get("height"):
        w, h = int(payload["width"]), int(payload["height"])
        g = math.gcd(w, h)
        ratio = f"{w // g}:{h // g}"
    ratio = ratio or default
    if not re.fullmatch(r"\d{1,2}:\d{1,2}", ratio) or 0 in (int(x) for x in ratio.split(":")):
        raise RequestError(f"invalid ratio {ratio!r}")
    return ratio


def _billing_context(value) -> dict:
    """The caller's `metadata.dc_context` (project/episode/beat), reduced to short scalar values."""
    if not isinstance(value, dict):
        return {}
    return {
        str(k)[:32]: v if isinstance(v, (int, float)) else str(v)[:64]
        for k, v in list(value.items())[:8]
        if isinstance(v, (str, int, float)) and not isinstance(v, bool)
    }


def _str_list(value) -> list[str]:
    if not value:
        return []
    return [str(v).strip() for v in value if isinstance(v, str) and v.strip()]


def _image_refs(payload: dict) -> list[str]:
    """Reference images, as `image: [url]` or `images: [{image_url}]` (NEWAPI_IMAGE_EDIT_REFERENCE_FORMAT)."""
    refs = payload.get("image")
    refs = [refs] if isinstance(refs, str) else refs
    out = _str_list(refs)
    for item in payload.get("images") or []:
        url = item.get("image_url") if isinstance(item, dict) else item
        if isinstance(url, dict):
            url = url.get("url")
        if isinstance(url, str) and url.strip():
            out.append(url.strip())
    return out


async def _download(ref: str) -> tuple[bytes, str]:
    """Bytes and file extension of an http(s) URL or a data: URI."""
    if ref.startswith("data:"):
        head, _, body = ref.partition(",")
        mime = head[5:].split(";")[0] or "application/octet-stream"
        data = base64.b64decode(body) if ";base64" in head else body.encode()
        return data, "." + (mime.split("/")[-1].split("+")[0] or "bin")
    if not ref.startswith(("http://", "https://")):
        raise RequestError(f"only http(s) and data: references are supported, got {ref[:40]!r}")
    async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
        resp = await client.get(ref)
    resp.raise_for_status()
    ext = Path(ref.split("?")[0]).suffix or "." + resp.headers.get("content-type", "image/png").split("/")[-1]
    return resp.content, ext


async def _upload_refs(comfy: ComfyClient, refs: list[str], prefix: str) -> list[str]:
    names = []
    for k, ref in enumerate(refs):
        data, ext = await _download(ref)
        names.append(await comfy.upload(f"{prefix}_{k}{ext}", data))
    return names


def create_app(
    *,
    comfy_url: str | None = None,
    output_dir: str | Path = "output/fake_media_gateway",
    api_key: str | None = None,
    comfy: ComfyClient | None = None,
    billing_dir: str | Path | None = None,
) -> FastAPI:
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    # Next to the output dir, not inside it: /files serves the output dir.
    ledger = Ledger(billing_dir if billing_dir is not None else out.with_name(f"{out.name}_billing"))
    comfy = comfy or ComfyClient(
        comfy_url or os.environ.get("COMFY_URL", "http://127.0.0.1:8188"),
        timeout_s=float(os.environ.get("FAKE_GATEWAY_RENDER_TIMEOUT_S", "1800")),
    )
    expected_key = api_key if api_key is not None else os.environ.get("FAKE_GATEWAY_API_KEY", "")
    tasks: dict[str, VideoTask] = {}
    queue: asyncio.Queue[str] = asyncio.Queue()

    async def worker() -> None:
        while True:
            task = tasks[await queue.get()]
            task.status = "in_progress"
            try:
                names = await _upload_refs(comfy, task.images, f"{task.id}_img")
                voices = await _upload_refs(comfy, task.voices, f"{task.id}_voice")
                graph = h3_graph.build_v16_graph(task.prompt, task.frames, task.ratio, names, voices, task.seed)
                graph, _ = h3_graph.preflight(graph, await comfy.object_info(), len(names), len(voices))
                started = time.monotonic()
                try:
                    video = await comfy.render_video(graph)
                finally:
                    task.gpu_seconds = time.monotonic() - started
                (out / f"{task.id}.mp4").write_bytes(video)
                task.status = "completed"
            except Exception as exc:  # noqa: BLE001 - any failure is reported through the task status
                task.status, task.error = "failed", f"{type(exc).__name__}: {exc}"
            if task.gpu_seconds > 0:  # a failed render still held the GPU
                ledger.record(task.id, task.gpu_seconds, task.context)

    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI):
        runner = asyncio.create_task(worker())
        yield
        runner.cancel()

    async def require_key(request: Request) -> None:
        if expected_key and request.headers.get("authorization") != f"Bearer {expected_key}":
            raise RequestError("invalid api key", 401)

    app = FastAPI(title="fake media gateway", lifespan=lifespan)
    app.mount("/files", StaticFiles(directory=out), name="files")

    @app.exception_handler(RequestError)
    async def _request_error(_: Request, exc: RequestError) -> JSONResponse:
        return JSONResponse({"error": {"message": exc.message}}, status_code=exc.status)

    async def image_endpoint(request: Request) -> JSONResponse:
        payload = await request.json()
        prompt = str(payload.get("prompt") or "").strip()
        if not prompt:
            raise RequestError("prompt is required")
        refs = _image_refs(payload)
        if len(refs) > qwen_graph.MAX_IMAGES - 1:
            raise RequestError(f"at most {qwen_graph.MAX_IMAGES - 1} reference images")
        ratio = _ratio_from(payload, DEFAULT_IMAGE_RATIO)
        try:
            canvas = await comfy.upload(f"canvas_{uuid.uuid4().hex[:8]}.png", qwen_graph.canvas_png(ratio))
            names = [canvas, *await _upload_refs(comfy, refs, f"ref_{uuid.uuid4().hex[:8]}")]
            graph = qwen_graph.compose_graph(prompt, names, random.randrange(2**32))
            data = await comfy.render_image(graph)
        except RequestError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise RequestError(f"render failed: {type(exc).__name__}: {exc}", 502) from exc
        return JSONResponse({"created": int(time.time()), "data": [{"b64_json": base64.b64encode(data).decode()}]})

    app.post("/images/generations", dependencies=[Depends(require_key)])(image_endpoint)
    app.post("/images/edits", dependencies=[Depends(require_key)])(image_endpoint)

    @app.post("/video/generations", dependencies=[Depends(require_key)])
    async def create_video(request: Request) -> JSONResponse:
        payload = await request.json()
        meta = payload.get("metadata") or {}
        prompt = str(payload.get("prompt") or "").strip()
        if not prompt:
            raise RequestError("prompt is required")
        if str(meta.get("last_frame_image") or "").strip():
            raise RequestError("last_frame_image is not supported by the H3 omni_reference workflow")
        if _str_list(meta.get("reference_videos")):
            raise RequestError("reference_videos are not supported by the H3 omni_reference workflow")
        raw = payload.get("duration")
        if raw in (None, "", "auto"):
            seconds = DEFAULT_VIDEO_SECONDS
        else:
            try:
                seconds = float(raw)
            except (TypeError, ValueError):
                raise RequestError(f"invalid duration {raw!r}") from None
        if not h3_graph.MIN_SECONDS <= seconds <= h3_graph.MAX_SECONDS:
            raise RequestError(f"duration must be {h3_graph.MIN_SECONDS}-{h3_graph.MAX_SECONDS} seconds")
        images = [*_str_list([payload.get("image")]), *_str_list(meta.get("reference_images"))]
        voices = _str_list(meta.get("reference_audios"))
        if not 1 <= len(images) <= h3_graph.MAX_IMAGES:
            raise RequestError(f"H3 v16 needs 1-{h3_graph.MAX_IMAGES} reference images (image or metadata.reference_images), got {len(images)}")
        if len(voices) > h3_graph.MAX_VOICES:
            raise RequestError(f"at most {h3_graph.MAX_VOICES} reference audios")
        task = VideoTask(
            id=f"task_{uuid.uuid4().hex[:16]}", prompt=prompt, frames=h3_graph.frames_for(seconds),
            ratio=_ratio_from(payload, DEFAULT_VIDEO_RATIO), seed=int(meta.get("seed") or random.randrange(2**32)),
            images=images, voices=voices, context=_billing_context(meta.get("dc_context")))
        tasks[task.id] = task
        queue.put_nowait(task.id)
        return JSONResponse({"task_id": task.id, "id": task.id, "status": task.status, "created_at": task.created})

    @app.get("/video/generations/{task_id}", dependencies=[Depends(require_key)])
    async def get_video(task_id: str, request: Request) -> JSONResponse:
        task = tasks.get(task_id)
        if task is None:
            raise RequestError("task not found", 404)
        body: dict = {"task_id": task.id, "status": task.status}
        if task.gpu_seconds > 0:
            body["usage"] = {"gpu_seconds": round(task.gpu_seconds, 3)}
        if task.status == "completed":
            body["result_url"] = f"{str(request.base_url).rstrip('/')}/files/{task.id}.mp4"
        if task.status == "failed":
            body["error"] = task.error
        return JSONResponse(body)

    @app.get("/billing/tasks/{task_id}", dependencies=[Depends(require_key)])
    async def get_billing(task_id: str) -> JSONResponse:
        """gpu_seconds right away; usd only once `billing close` has spread the Vast credit drop."""
        if (billed := ledger.task(task_id)) is not None:
            return JSONResponse(billed)
        task = tasks.get(task_id)
        if task is None:
            raise RequestError("task not found", 404)
        return JSONResponse({"task_id": task.id, "session_id": None, "status": "unbilled",
                             "gpu_seconds": round(task.gpu_seconds, 3), "usd": None, "context": task.context})

    @app.get("/healthz")
    async def healthz() -> JSONResponse:
        try:
            await comfy.system_stats()
        except Exception as exc:  # noqa: BLE001
            return JSONResponse({"ok": False, "comfy": f"{type(exc).__name__}: {exc}"}, status_code=503)
        return JSONResponse({"ok": True})

    return app
