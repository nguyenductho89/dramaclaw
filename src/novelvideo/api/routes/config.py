"""Public runtime configuration for the frontend."""

from __future__ import annotations

import logging
import os
from typing import Literal
from urllib.parse import urlsplit

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from ulid import ULID

from novelvideo.runpod_worker_control import any_runpod_worker_control_configured
from novelvideo.shared import runtime_env

logger = logging.getLogger(__name__)

router = APIRouter()

RuntimeEdition = Literal["ce", "ee"]
_INSTANCE_ID = str(ULID())


def _runtime_edition() -> RuntimeEdition:
    return "ce" if runtime_env.is_ce_effective() else "ee"


def _mcp_direct_canvas_apply_enabled() -> bool:
    return os.environ.get("DRAMACLAW_MCP_DIRECT_CANVAS_APPLY", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _browser_model_url(env_name: str) -> str | None:
    """Read the source URL for a browser-side inference resource (matting, depth motion capture); anything that is not http(s) is ignored.

    When none of the three variables is set, the browser uses the transformers.js
    default sources (Hugging Face Hub + jsDelivr), which are largely unreachable
    from mainland-China networks:
    - BROWSER_MODEL_ASSET_BASE: a self-hosted prefix from which both weights and wasm
      are fetched; see scripts/fetch_browser_models.py for the directory layout and
      how to prepare it.
    - BROWSER_MODEL_HF_ENDPOINT: swaps only the weights source, a mirror whose path
      rules match the Hugging Face Hub.
    - BROWSER_ORT_WASM_BASE: swaps only the onnxruntime wasm source; `{version}` is
      replaced by the frontend with the bundled onnxruntime-web version.
    The latter two each take precedence over ASSET_BASE.
    """
    base = os.environ.get(env_name, "").strip().rstrip("/")
    if not base:
        return None
    parts = urlsplit(base)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        logger.warning("%s is not an http(s) URL and was ignored; browser-side models still use the default source.", env_name)
        return None
    return base


@router.get("/config")
async def get_runtime_config():
    edition = _runtime_edition()
    return JSONResponse(
        {
            "ok": True,
            "data": {
                "edition": edition,
                "auth_required": edition == "ee",
                "instance_id": _INSTANCE_ID,
                "mcp_direct_canvas_apply": _mcp_direct_canvas_apply_enabled(),
                # Was "runpod_qwen_worker_control_enabled" before the
                # 2026-10-19 endpoint split (one shared Qwen+H3 endpoint ->
                # 4 separate ones) — true if ANY of the 4 is configured; the
                # frontend fetches per-key status via
                # GET /api/v1/runpod-worker/keys to decide which sections to
                # actually render.
                "runpod_worker_control_enabled": any_runpod_worker_control_configured(),
                "browser_model_asset_base": _browser_model_url("BROWSER_MODEL_ASSET_BASE"),
                "browser_model_hf_endpoint": _browser_model_url("BROWSER_MODEL_HF_ENDPOINT"),
                "browser_ort_wasm_base": _browser_model_url("BROWSER_ORT_WASM_BASE"),
            },
        }
    )
