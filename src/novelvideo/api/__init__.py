"""NovelVideo Studio - REST API module.

Provides /api/v1/ endpoints for external agents such as OpenClaw.
"""

import logging
from importlib.metadata import entry_points
from logging.handlers import RotatingFileHandler
from pathlib import Path

from fastapi import APIRouter

from novelvideo.config import RUNTIME_DIR
from novelvideo.shared import runtime_env

_api_logger = logging.getLogger("novelvideo.api")
_api_logger.setLevel(logging.INFO)
_api_logger.propagate = True
_log_path = f"{RUNTIME_DIR}/api.log"
try:
    Path(RUNTIME_DIR).mkdir(parents=True, exist_ok=True)
    _existing_handler = next(
        (
            handler
            for handler in _api_logger.handlers
            if isinstance(handler, RotatingFileHandler)
            and getattr(handler, "baseFilename", "") == _log_path
        ),
        None,
    )
    if _existing_handler is None:
        _fh = RotatingFileHandler(
            _log_path,
            maxBytes=10 * 1024 * 1024,
            backupCount=3,
            encoding="utf-8",
        )
        _fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        _api_logger.addHandler(_fh)
except Exception:
    pass

from novelvideo.api.routes import (  # noqa: E402
    assets,
    auth,
    characters,
    chat,
    config,
    content,
    diagnostics,
    episodes,
    files,
    freezone,
    skill_imports,
    html_artifacts,
    generation,
    ingest,
    model_gateway,
    model_credits,
    pipeline,
    product_surfaces,
    projects,
    prompt_preview,
    props,
    release_notifications,
    runpod_worker,
    scenes,
    scripts,
    styles,
    tasks,
)

api_router = APIRouter(prefix="/api/v1")

OPENAPI_TAGS = [
    {"name": "freezone-bootstrap", "description": "Freezone startup, initialization, and provider capability discovery."},
    {"name": "freezone-media", "description": "Freezone candidate media inputs, such as uploads and external file imports."},
    {
        "name": "freezone-audio",
        "description": "Freezone audio node endpoints, including reference audio and text-to-speech.",
    },
    {
        "name": "freezone-image",
        "description": "Freezone image node endpoints, including generation, editing, outpainting, inpainting, and prompt reverse-engineering.",
    },
    {
        "name": "freezone-video",
        "description": "Freezone video node endpoints, including text-to-video, image-to-video, camera-move templates, and character library.",
    },
    {"name": "freezone-text", "description": "Freezone text node endpoints, including translation and story script generation."},
    {"name": "freezone-canvas", "description": "Freezone canvas document endpoints."},
    {"name": "freezone-assets", "description": "Freezone canonical asset and context endpoints."},
    {
        "name": "freezone-commit",
        "description": "Endpoints that write a Freezone candidate back to a canonical asset slot.",
    },
    {"name": "freezone-jobs", "description": "Freezone async job result query endpoints."},
]

api_router.include_router(auth.router, tags=["auth"])
if not runtime_env.is_ce_effective():
    for ep in entry_points(group="novelvideo.api_routes"):
        ep.load()(api_router)
api_router.include_router(config.router, tags=["config"])
api_router.include_router(diagnostics.router, tags=["diagnostics"])
api_router.include_router(product_surfaces.router, tags=["product-surfaces"])
api_router.include_router(chat.router, tags=["chat"])
api_router.include_router(projects.router, tags=["projects"])
api_router.include_router(ingest.router, tags=["ingest"])
api_router.include_router(characters.router, tags=["characters"])
api_router.include_router(assets.router, tags=["assets"])
api_router.include_router(scenes.router, tags=["scenes"])
api_router.include_router(props.router, tags=["props"])
api_router.include_router(episodes.router, tags=["episodes"])
api_router.include_router(scripts.router, tags=["scripts"])
api_router.include_router(content.router, tags=["content"])
api_router.include_router(generation.router, tags=["generation"])
api_router.include_router(tasks.router, tags=["tasks"])
api_router.include_router(files.router, tags=["files"])
api_router.include_router(styles.router, tags=["styles"])
api_router.include_router(pipeline.router, tags=["pipeline"])
api_router.include_router(prompt_preview.router, tags=["prompt-preview"])
api_router.include_router(model_gateway.router, tags=["model-gateway"])
api_router.include_router(model_credits.router, tags=["model-credits"])
api_router.include_router(runpod_worker.router, tags=["runpod-worker"])
api_router.include_router(freezone.router)
api_router.include_router(skill_imports.router)
api_router.include_router(html_artifacts.router)
api_router.include_router(release_notifications.router, tags=["release-notifications"])
_verification_routes_registered = False


def register_verification_routes():
    """Lazily register the verification routes to avoid circular imports."""
    global _verification_routes_registered
    if _verification_routes_registered:
        return
    from novelvideo.verification.routes import router as verification_router

    api_router.include_router(verification_router, tags=["verification"])
    _verification_routes_registered = True
