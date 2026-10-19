"""Start/stop control for the dev-only RunPod Serverless workers.

Backs the Settings → Models "RunPod worker" start/stop controls (one section
per endpoint — see `runpod_worker_control.py` for the RunPod API calls and
the 4-endpoint registry: `h3`, `qwen_edit`, `qwen_t2i`, `multishot`).
Dev-only, same gate as that endpoint's own Image/Video source selections —
a given section is invisible unless this machine's `.env` actually has that
endpoint's RUNPOD_*_ENDPOINT_ID/R2_* configured.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
import httpx

from novelvideo.runpod_worker_control import (
    RunpodWorkerControlError,
    endpoint_keys,
    get_status,
    start_worker,
    stop_worker,
)
from novelvideo.service_operation_gate import (
    ServiceOperationExcluded,
    require_legacy_local_service_operation,
)

router = APIRouter(prefix="/runpod-worker")


def _require_ce_local() -> None:
    try:
        require_legacy_local_service_operation()
    except ServiceOperationExcluded as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


async def _call(action, key: str) -> dict[str, Any]:
    try:
        return await action(key)
    except RunpodWorkerControlError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"RunPod API {exc.response.status_code}: {exc.response.text[:500]}",
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"RunPod API request failed: {exc}") from exc


@router.get("/keys")
async def list_runpod_worker_keys() -> dict[str, Any]:
    """Stable list of endpoint keys, in display order — lets the frontend
    render one status section per endpoint without hardcoding the key list."""
    _require_ce_local()
    return {"ok": True, "data": {"keys": endpoint_keys()}}


@router.get("/{key}/status")
async def get_runpod_worker_status(key: str) -> dict[str, Any]:
    _require_ce_local()
    data = await _call(get_status, key)
    return {"ok": True, "data": data}


@router.post("/{key}/start")
async def start_runpod_worker(key: str) -> dict[str, Any]:
    _require_ce_local()
    data = await _call(start_worker, key)
    return {"ok": True, "data": data}


@router.post("/{key}/stop")
async def stop_runpod_worker(key: str) -> dict[str, Any]:
    _require_ce_local()
    data = await _call(stop_worker, key)
    return {"ok": True, "data": data}
