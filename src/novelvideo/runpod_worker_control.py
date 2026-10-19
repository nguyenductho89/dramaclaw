"""Start/stop control for the dev-only RunPod Serverless endpoints.

Lets the Settings UI flip an endpoint's `workers.max` between 0 and 1 without
needing the `photoreal-short-drama-generator` project's own `rp.py` CLI.
Mirrors that project's `scripts/rp.py` transport (same two RunPod hosts, same
Cloudflare-dodging User-Agent on the CTRL host — see its module docstring)
but only the pieces this UI needs: read an endpoint's current `workers`
config plus live worker/job counts, and PATCH `workers.max`.

Split 2026-10-19 from a single-endpoint module into a small registry of 4
endpoints (`_ENDPOINTS` below), one per RunPod Serverless endpoint this app
now talks to — see `config.py`'s `RUNPOD_*_ENDPOINT_ID` block and
`runpod-h3-qwen-endpoints.md` for why each one is now separate. Every public
function here takes a `key` identifying which endpoint to act on; there is no
default, callers (the API routes) must always say which one.

`qwen_t2i` (`RUNPOD_QWEN_IMAGE_ENDPOINT_ID`, display name
`qwen-image-t2i-fast`) is shared with `~/Xuongphim/trends/comfy-trends` and
`multishot` (`RUNPOD_H3_MULTISHOT_ENDPOINT_ID`, display name
`h3-multishot-i2v-fl2va-ref2va`) likewise — those projects only use them for
ad hoc testing, not production, so there is no conflicting owner to
coordinate with. Don't match on endpoint name strings anywhere;
`_status_payload()` below reads the name live from the RunPod API precisely
so a future rename doesn't need a code change.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

import httpx

import novelvideo.config as config

_JOB_HOST = "https://api.runpod.ai/v2"
_CTRL_HOST = "https://api.runpod.io/v2"
# CTRL host (api.runpod.io) sits behind Cloudflare, which blocks the default
# httpx/urllib User-Agent as a bot (error 1010) — same workaround as
# photoreal's scripts/rp.py `workers()`.
_CTRL_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


class RunpodWorkerControlError(RuntimeError):
    """Unknown endpoint key, missing RUNPOD_API_KEY/endpoint id, or a RunPod API call failed."""


@dataclass(frozen=True)
class _EndpointSpec:
    key: str
    display_name: str
    # Attribute names on `novelvideo.config`, looked up with getattr() at
    # call time (not bound here) so test monkeypatching of the config module
    # still takes effect.
    endpoint_id_attr: str
    idle_timeout_attr: str
    configured_fn: Callable[[], bool]


_ENDPOINTS: dict[str, _EndpointSpec] = {
    "h3": _EndpointSpec(
        key="h3",
        display_name="MiniMax H3 (1-shot ref2va/fl2va)",
        endpoint_id_attr="RUNPOD_H3_VIDEO_ENDPOINT_ID",
        idle_timeout_attr="RUNPOD_H3_VIDEO_IDLE_TIMEOUT_SECONDS",
        configured_fn=config._runpod_h3_video_configured,
    ),
    "qwen_edit": _EndpointSpec(
        key="qwen_edit",
        display_name="Qwen-Image-Edit-2511 (render/relight)",
        endpoint_id_attr="RUNPOD_QWEN_EDIT_ENDPOINT_ID",
        idle_timeout_attr="RUNPOD_QWEN_EDIT_IDLE_TIMEOUT_SECONDS",
        configured_fn=config._runpod_qwen_edit_configured,
    ),
    "qwen_t2i": _EndpointSpec(
        key="qwen_t2i",
        display_name="Qwen-Image 2.1 (t2i / background / prop / render)",
        endpoint_id_attr="RUNPOD_QWEN_IMAGE_ENDPOINT_ID",
        idle_timeout_attr="RUNPOD_QWEN_IMAGE_IDLE_TIMEOUT_SECONDS",
        configured_fn=config._runpod_qwen_image_configured,
    ),
    "multishot": _EndpointSpec(
        key="multishot",
        display_name="MiniMax H3 Multishot (long continuous video)",
        endpoint_id_attr="RUNPOD_H3_MULTISHOT_ENDPOINT_ID",
        idle_timeout_attr="RUNPOD_H3_MULTISHOT_IDLE_TIMEOUT_SECONDS",
        configured_fn=config._runpod_h3_multishot_configured,
    ),
}


def endpoint_keys() -> list[str]:
    """Stable order for the frontend to render one section per endpoint."""
    return ["h3", "qwen_edit", "qwen_t2i", "multishot"]


def _spec(key: str) -> _EndpointSpec:
    try:
        return _ENDPOINTS[key]
    except KeyError:
        raise RunpodWorkerControlError(f"unknown runpod worker endpoint key: {key!r}") from None


def runpod_worker_control_configured(key: str) -> bool:
    """Same gate as that endpoint's own Image/Video source selections — see
    `_visible_image_generation_selection()` in config.py. Worker start/stop
    only needs RUNPOD_API_KEY + the endpoint id, but requiring the full set
    (R2 too) keeps this control from appearing when the provider itself
    couldn't actually generate anything yet.
    """
    return _spec(key).configured_fn()


def any_runpod_worker_control_configured() -> bool:
    """Used by `GET /api/v1/config` to decide whether to show the Settings
    section at all — true if ANY of the 4 endpoints is configured."""
    return any(spec.configured_fn() for spec in _ENDPOINTS.values())


def _require_configured(key: str) -> _EndpointSpec:
    spec = _spec(key)
    if not spec.configured_fn():
        raise RunpodWorkerControlError(
            f"RunPod worker control for {key!r} is not configured "
            f"(RUNPOD_API_KEY / {spec.endpoint_id_attr} / R2_* missing)"
        )
    return spec


async def _ctrl_get(endpoint_id: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"{_CTRL_HOST}/serverless/{endpoint_id}",
            headers={
                "Authorization": f"Bearer {config.RUNPOD_API_KEY}",
                "User-Agent": _CTRL_USER_AGENT,
            },
        )
        resp.raise_for_status()
        return resp.json()


async def _ctrl_patch_workers(endpoint_id: str, max_workers: int, idle_timeout: int) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.patch(
            f"{_CTRL_HOST}/serverless/{endpoint_id}",
            headers={
                "Authorization": f"Bearer {config.RUNPOD_API_KEY}",
                "User-Agent": _CTRL_USER_AGENT,
                "Content-Type": "application/json",
            },
            json={"workers": {"max": max_workers, "min": 0, "idleTimeout": idle_timeout}},
        )
        resp.raise_for_status()
        return resp.json()


async def _job_health(endpoint_id: str) -> dict[str, Any] | None:
    """Live worker/job counts — best-effort, so a transient RunPod hiccup
    degrades the status payload instead of failing the whole request."""
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{_JOB_HOST}/{endpoint_id}/health",
                headers={"Authorization": f"Bearer {config.RUNPOD_API_KEY}"},
            )
            resp.raise_for_status()
            return resp.json()
    except httpx.HTTPError:
        return None


def _status_payload(
    spec: _EndpointSpec,
    endpoint_id: str,
    endpoint_cfg: dict[str, Any],
    health: dict[str, Any] | None,
) -> dict[str, Any]:
    workers_cfg = endpoint_cfg.get("workers") or {}
    max_workers = int(workers_cfg.get("max") or 0)
    return {
        "key": spec.key,
        "displayName": spec.display_name,
        "configured": True,
        "running": max_workers > 0,
        "endpointId": endpoint_id,
        "endpointName": endpoint_cfg.get("name"),
        "workers": {
            "max": max_workers,
            "min": int(workers_cfg.get("min") or 0),
            "idleTimeoutSeconds": int(workers_cfg.get("idleTimeout") or 0),
        },
        # {idle, initializing, ready, running, throttled, unhealthy} — None
        # when the health call itself failed, not when the endpoint is cold.
        "live": (health or {}).get("workers"),
        "jobs": (health or {}).get("jobs"),
    }


async def get_status(key: str) -> dict[str, Any]:
    spec = _spec(key)
    if not spec.configured_fn():
        return {"key": spec.key, "displayName": spec.display_name, "configured": False, "running": False}
    endpoint_id = getattr(config, spec.endpoint_id_attr)
    endpoint_cfg = await _ctrl_get(endpoint_id)
    health = await _job_health(endpoint_id)
    return _status_payload(spec, endpoint_id, endpoint_cfg, health)


async def start_worker(key: str) -> dict[str, Any]:
    spec = _require_configured(key)
    endpoint_id = getattr(config, spec.endpoint_id_attr)
    idle_timeout = getattr(config, spec.idle_timeout_attr)
    endpoint_cfg = await _ctrl_patch_workers(endpoint_id, 1, idle_timeout)
    health = await _job_health(endpoint_id)
    return _status_payload(spec, endpoint_id, endpoint_cfg, health)


async def stop_worker(key: str) -> dict[str, Any]:
    spec = _require_configured(key)
    endpoint_id = getattr(config, spec.endpoint_id_attr)
    idle_timeout = getattr(config, spec.idle_timeout_attr)
    endpoint_cfg = await _ctrl_patch_workers(endpoint_id, 0, idle_timeout)
    health = await _job_health(endpoint_id)
    return _status_payload(spec, endpoint_id, endpoint_cfg, health)
