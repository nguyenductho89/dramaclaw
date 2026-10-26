"""NanoBananaPro grid generation module.

Uses Google AI Studio (Gemini Pro Image) to generate grid images.
Sketch mode uses a 3x3 grid (9 panel slots per image), chunked in beat order, automatically producing ceil(N/9) grids.

Generation flow:
1. Build the grid prompt from the beats data
2. Calling NanoBananaPro API to generate grid image
3. Split into individual shots with grid_splitter
4. Use Seedream image-to-image for high-definition restoration
"""

import asyncio
import base64
import contextvars
import hashlib
import io
import json
import logging
import math
import mimetypes
import os
import re
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from pydantic import BaseModel, Field

from novelvideo.config import (
    IMAGE_DEFAULT_STYLE,
    get_grid_generation_config,
    get_style_preset,
)
from novelvideo.ports import get_usage_meter, update_current_model_call_log
from novelvideo.egress_context import (
    TrustedEgressContext,
    ambient_organization_egress_context,
)
from novelvideo.ports.authz import AdmissionContext
from novelvideo.ports.egress import EgressError
from novelvideo.ports.egress_operations import (
    OperationClaimResult,
    HandleKind,
    OperationSpec,
    canonical_request_digest,
)
from novelvideo.ports.model_credentials import ModelCredentialError, RequestCredential
from novelvideo.shared.billing_errors import is_fatal_billing_error
from novelvideo.shared.provider_costs import is_definite_no_cost_http_rejection
from novelvideo.generators.huimengi import (
    HuimengTaskFailed,
    HuimengiTaskClient,
    bytes_to_data_url,
    extract_huimeng_result_url,
    validate_huimeng_media_download,
)
from novelvideo.generators.prompt_builder import (
    PromptComponents,
    PromptContext,
    PromptMode,
    UnifiedPromptBuilder,
    build_gemini_compose_prompt,
    build_qwen21_compose_prompt,
    build_qwen21_render_prompt,
    build_qwen_edit_render_prompt,
    create_prompt_context,
)
from novelvideo.generators.render_identity_guard import render_ai_detection_error
from novelvideo.models import (
    beat_scene_id,
    collect_prop_marker_ids_from_beat,
    real_detected_identities,
    real_detected_props,
)
from novelvideo.manual_shots import beat_order_value
from novelvideo.services.style_service import StyleService
from novelvideo.utils.asset_resolver import AssetResolver
from novelvideo.image_request_usage import (
    infer_episode_from_path,
    infer_project_output_dir,
    record_image_request,
    update_image_request_status,
)
from novelvideo.storage.media_relay import (
    IMAGE_TRANSFORM_AI_REFERENCE_JPEG,
    media_relay_ttl_seconds,
    relay_tenant_image_bytes_from_context,
    upload_image_bytes,
)

_VALID_IMAGE_SIZES = {"512", "1K", "2K", "4K"}
_OPENROUTER_IMAGE_CAPABILITY_CACHE: dict[str, tuple[bool, str]] = {}
_OPENAI_VALID_QUALITIES = {"low", "medium", "high", "auto"}
_OPENAI_MIN_PIXELS = 655_360
_OPENAI_MAX_PIXELS = 8_294_400
_OPENAI_MAX_EDGE = 3840
_OPENAI_MAX_RATIO = 3.0
_HUIMENG_IMAGE_POLL_INTERVAL_SECONDS = 2.0
_HUIMENG_IMAGE_MAX_POLLS = 290
HUIMENG_IMAGE2_SINGLE_CELL_SELECTION = "huimeng_gpt_image2"
HUIMENG_IMAGE2_SINGLE_CELL_REASON = "huimeng-image-2-1k-only"
SINGLE_CELL_RENDER_MODE_KEY = "1x1_2-3"
SINGLE_CELL_RENDER_MODE_BY_ASPECT = {
    "1:1": "1x1_1-1",
    "9:16": "1x1_9-16",
    "16:9": "1x1_16-9",
}
logger = logging.getLogger(__name__)
NEWAPI_MEDIA_INPUT_MIN_TTL_SECONDS = 2 * 60 * 60


@dataclass(frozen=True, slots=True)
class _OrganizationImageEgress:
    credential: RequestCredential
    operation_port: Any
    claim: OperationClaimResult


def _validate_egress_context(
    egress_context: TrustedEgressContext | None,
) -> TrustedEgressContext | None:
    if egress_context is not None and type(egress_context) is not TrustedEgressContext:
        raise TypeError("egress_context must be a TrustedEgressContext")
    return egress_context


async def _prepare_organization_image_egress(
    *,
    egress_context: TrustedEgressContext | None,
    provider: str,
    capability: str,
    request: dict[str, object],
    business_task_id: str | None = None,
) -> _OrganizationImageEgress | None:
    context = _validate_egress_context(egress_context)
    if context is None:
        context = ambient_organization_egress_context()
    if context is None or not context.is_organization:
        return None
    if provider != "newapi":
        raise EgressError("ORG_EGRESS_DENIED")

    from novelvideo.ports import get_egress_operation_port, get_model_credentials

    admission = AdmissionContext(
        requester_user_id=context.requester_user_id,
        billing_principal=context.billing_principal,
        credential=context.credential,
        admission_id=context.admission_id,
        root_task_id=context.root_task_id,
        admitted_at=context.admitted_at,
        membership_id=context.membership_id,
        authz_version=context.authz_version,
    )
    operation_port = get_egress_operation_port()
    claim = await operation_port.claim(
        spec=OperationSpec(
            organization_id=context.billing_principal.id,
            project_id=context.project_id,
            root_task_id=context.root_task_id,
            business_task_id=business_task_id or context.envelope_id,
            capability=capability,
            credential_id=context.credential.credential_id,
            credential_version=context.credential.key_version,
            request_digest=canonical_request_digest(request),
            handle_kind=HandleKind.PROVIDER_JOB,
        )
    )
    if not claim.won:
        raise EgressError("EGRESS_OPERATION_REPLAYED")
    try:
        credential = await get_model_credentials().resolve(admission)
        if (
            type(credential) is not RequestCredential
            or credential.reference != context.credential
        ):
            raise ModelCredentialError("ORG_CREDENTIAL_VERSION_MISMATCH")
    except Exception:
        await operation_port.mark_rejected_before_submit(
            operation_id=claim.operation.operation_id,
            transition_token=claim.transition_token,
            expected_version=claim.operation.version,
        )
        raise
    return _OrganizationImageEgress(
        credential=credential,
        operation_port=operation_port,
        claim=claim,
    )


async def _complete_organization_image_egress(
    state: _OrganizationImageEgress | None,
    *,
    trace: dict[str, str],
    result_ref: str,
) -> None:
    if state is None:
        return
    provider_job_id = str(
        trace.get("request_id") or trace.get("response_id") or ""
    ).strip()
    if not provider_job_id:
        await state.operation_port.mark_unknown(
            operation_id=state.claim.operation.operation_id,
            transition_token=state.claim.transition_token,
            expected_version=state.claim.operation.version,
        )
        raise RuntimeError("gateway response is missing a request id")
    accepted = await state.operation_port.mark_accepted(
        operation_id=state.claim.operation.operation_id,
        transition_token=state.claim.transition_token,
        expected_version=state.claim.operation.version,
        provider_job_id=provider_job_id,
    )
    await state.operation_port.mark_completed(
        operation_id=state.claim.operation.operation_id,
        transition_token=state.claim.transition_token,
        expected_version=accepted.version,
        result_ref=result_ref,
    )


async def _abandon_organization_image_egress(
    state: _OrganizationImageEgress | None,
) -> None:
    """Close out a claim whose outcome we cannot observe.

    Deliberately `mark_unknown` rather than `mark_rejected_before_submit`: once the
    credential is out of our hands we cannot prove the request was never submitted,
    and only the ledger's unknown state is honest about that.
    """

    if state is None:
        return
    await state.operation_port.mark_unknown(
        operation_id=state.claim.operation.operation_id,
        transition_token=state.claim.transition_token,
        expected_version=state.claim.operation.version,
    )


_SCENE_REFERENCE_FEATURE_BILLING = contextvars.ContextVar(
    "scene_reference_feature_billing", default=False
)


class scene_reference_feature_billing:
    """Temporarily delegate scene-reference billing to the EE feature ledger."""

    def __enter__(self):
        self._token = _SCENE_REFERENCE_FEATURE_BILLING.set(True)
        return self

    def __exit__(self, exc_type, exc, tb):
        _SCENE_REFERENCE_FEATURE_BILLING.reset(self._token)


def _scene_reference_feature_billing_active() -> bool:
    return _SCENE_REFERENCE_FEATURE_BILLING.get()


async def _mark_paid_image_attempt_accepted(
    *,
    provider_request_id: str = "",
    response_id: str = "",
) -> None:
    try:
        await get_usage_meter().mark_current_paid_execution_attempt(
            status="accepted",
            provider_request_id=provider_request_id,
            provider_response_id=response_id,
        )
    except Exception:
        pass


def _newapi_request_id_from_headers(headers: Any) -> str:
    if not headers:
        return ""
    return (
        headers.get("x-request-id")
        or headers.get("x-newapi-request-id")
        or headers.get("x-oneapi-request-id")
        or ""
    )


NEWAPI_IMAGE_HTTP_TIMEOUT_SECONDS = 1800.0


def _newapi_safe_header_summary(headers: Any) -> dict[str, str]:
    if not headers:
        return {}
    safe_keys = ("x-request-id", "x-newapi-request-id", "x-oneapi-request-id", "cf-ray", "date")
    summary: dict[str, str] = {}
    for key in safe_keys:
        value = str(headers.get(key) or "").strip()
        if value:
            summary[key] = value
    return summary


def _newapi_safe_request_context(
    *,
    endpoint: str,
    request_path: str,
    model: str,
    payload: dict[str, object],
    prompt: str,
) -> dict[str, object]:
    reference_images = payload.get("image")
    reference_image_count = len(reference_images) if isinstance(reference_images, list) else 0
    raw_metadata = payload.get("metadata")
    metadata = raw_metadata if isinstance(raw_metadata, dict) else {}
    geometry_metadata = {
        key: metadata[key]
        for key in ("ratio", "aspect_ratio", "resolution")
        if key in metadata
    }
    return {
        "endpoint": f"{endpoint}{request_path}",
        "model": model,
        "payload_keys": sorted(payload.keys()),
        "width": payload.get("width") or "",
        "height": payload.get("height") or "",
        "geometry_metadata": geometry_metadata,
        "reference_image_count": reference_image_count,
        "prompt_chars": len(prompt or ""),
        "prompt_sha256": hashlib.sha256((prompt or "").encode("utf-8")).hexdigest()[:16],
    }


def _newapi_context_for_error(context: dict[str, object]) -> str:
    return (
        f"model={context.get('model')}; "
        f"endpoint={context.get('endpoint')}; "
        f"payload_keys={context.get('payload_keys')}; "
        f"width={context.get('width')}; "
        f"height={context.get('height')}; "
        f"geometry_metadata={context.get('geometry_metadata')}; "
        f"reference_image_count={context.get('reference_image_count')}; "
        f"prompt_sha256={context.get('prompt_sha256')}"
    )


def _beat_display_sort_key(beat: dict) -> tuple[int, int]:
    return (beat_order_value(beat), int(beat.get("beat_number", 0) or 0))


def image_generation_selection_forces_single_cell(selection: str | None) -> bool:
    """Whether render planning must split every beat into a 1x1 grid."""
    return str(selection or "").strip() == HUIMENG_IMAGE2_SINGLE_CELL_SELECTION


class _InlineImagePart:
    """Provider-neutral image part used by OpenRouter/OpenAI branches."""

    def __init__(self, data: bytes, mime_type: str = "image/png"):
        self.inline_data = SimpleNamespace(data=data, mime_type=mime_type)


def _infer_project_dir(*paths: str | None) -> Optional[Path]:
    for path_str in paths:
        if not path_str:
            continue
        path = Path(path_str)
        parts = list(path.parts)
        if "grids" in parts:
            grids_idx = parts.index("grids")
            if grids_idx > 0:
                return Path(*parts[:grids_idx])
    return None


def _resolve_scene_prop_asset_refs(
    project_dir: Optional[Path],
    beats: List[dict],
    *,
    episode_number: int | None = None,
    sketch: bool = False,
    use_director_refs: bool = False,
    include_pano_view_refs: bool = False,
    director_ref_beat_numbers: list[int] | None = None,
    director_control_frames_dir: str | Path | None = None,
    scene_menu: list[dict] | list | None = None,
    prop_menu: list[dict] | list | None = None,
    allow_beat_background_anchor: bool | None = None,
) -> tuple[dict[int, list], dict[int, list]]:
    if not project_dir:
        return {}, {}
    resolver = AssetResolver(
        project_dir,
        episode_number=episode_number,
        scene_menu=scene_menu,
        prop_menu=prop_menu,
        scene_reference_kind="sketch" if sketch else "render",
        use_director_refs=use_director_refs,
        include_pano_view_refs=include_pano_view_refs,
        director_ref_beat_numbers=director_ref_beat_numbers,
        director_control_frames_dir=director_control_frames_dir,
        allow_beat_background_anchor=allow_beat_background_anchor,
    )
    return resolver.resolve_all_for_beats(beats)


def _global_prop_marker_colors(
    beats: List[dict],
    prop_menu: list[dict] | list | None = None,
    sketch_colors: dict[str, str] | None = None,
    *,
    assign_missing: bool = False,
) -> dict[str, str]:
    """Return episode-persisted marker colors for global [[prop]] markers.

    Generation/export paths must be WYSIWYG: prop colors come from the episode
    prop_menu marker_color field only. The color assignment UI flow may pass
    assign_missing=True to compute missing colors before persisting them.
    """
    active_prop_ids: list[str] = []
    seen: set[str] = set()
    for beat in beats:
        for prop_id in collect_prop_marker_ids_from_beat(beat):
            if prop_id and prop_id not in seen:
                seen.add(prop_id)
                active_prop_ids.append(prop_id)
    if not active_prop_ids:
        return {}

    colorable_prop_ids: set[str] = set()
    explicit_colors: dict[str, str] = {}
    for raw_item in prop_menu or []:
        if isinstance(raw_item, dict):
            prop_id = str(
                raw_item.get("prop_id") or raw_item.get("base_id") or raw_item.get("name") or ""
            ).strip()
            asset_scope = str(raw_item.get("asset_scope") or "").strip().lower()
            is_global_asset = raw_item.get("is_global_asset") is True
            marker_color = str(raw_item.get("marker_color") or "").strip()
        else:
            prop_id = str(getattr(raw_item, "prop_id", "") or getattr(raw_item, "name", "")).strip()
            asset_scope = str(getattr(raw_item, "asset_scope", "")).strip().lower()
            is_global_asset = getattr(raw_item, "is_global_asset", False) is True
            marker_color = str(getattr(raw_item, "marker_color", "") or "").strip()
        if prop_id and (asset_scope == "global" or is_global_asset or marker_color):
            colorable_prop_ids.add(prop_id)
        if prop_id and marker_color:
            explicit_colors[prop_id] = marker_color
    if not colorable_prop_ids:
        return {}
    if not assign_missing:
        return {
            prop_id: explicit_colors[prop_id]
            for prop_id in active_prop_ids
            if prop_id in explicit_colors
        }

    from novelvideo.generators.episode_optimizer import (
        PROP_MARKER_PALETTE,
        _hex_to_hue,
    )

    used_hexes = {
        str(value or "").strip().split(" ", 1)[0].lower()
        for value in (sketch_colors or {}).values()
        if str(value or "").strip()
    }
    used_hexes.update(
        str(value or "").strip().split(" ", 1)[0].lower()
        for value in explicit_colors.values()
        if str(value or "").strip()
    )
    used_hues = [_hex_to_hue(h) for h in used_hexes if h.startswith("#") and len(h) == 7]

    def _min_hue_gap(candidate_hex: str) -> float:
        if not used_hues:
            return 360.0
        h = _hex_to_hue(candidate_hex)
        gaps = []
        for used_h in used_hues:
            diff = abs(h - used_h) % 360
            gaps.append(min(diff, 360 - diff))
        return min(gaps)

    # Props use the dedicated PROP_MARKER_PALETTE (dark / non-fluorescent), contrasting in value
    # with the character palette (fluorescent, high saturation). Even if hues happen to be close, the brightness/saturation difference keeps props visually distinct from characters.
    not_used = [item for item in PROP_MARKER_PALETTE if item[0].lower() not in used_hexes]
    # Visually "safe" only if the hue differs from used colors by >=60 degrees; otherwise fall back to the full set of unused hex values, and finally to the whole prop palette
    safe = [item for item in not_used if _min_hue_gap(item[0]) >= 60.0]
    available = safe or not_used or list(PROP_MARKER_PALETTE)
    # Sort from farthest to nearest used hue, so the most contrasting colors are picked first
    available = sorted(available, key=lambda it: -_min_hue_gap(it[0]))

    colors: dict[str, str] = {}
    color_index = 0
    for prop_id in active_prop_ids:
        if prop_id not in colorable_prop_ids:
            continue
        if prop_id in explicit_colors:
            colors[prop_id] = explicit_colors[prop_id]
            continue
        hex_code, color_name = available[color_index % len(available)]
        colors[prop_id] = f"{hex_code} {color_name}"
        color_index += 1
    return colors


def normalize_image_size(size: str, provider: str = "google") -> str:
    """Normalize image_size across providers.

    Internal configs may still use 0.5K, but providers expect different values:
    - Gemini direct: 512
    - OpenRouter: 1K (0.5K currently triggers INVALID_ARGUMENT on Gemini image routes)
    """
    if provider in {"huimeng", "newapi"} and size == "0.5K":
        return "1K"
    if size == "0.5K":
        return "1K" if provider == "openrouter" else "512"
    return size


def _newapi_image_model_supports_quality(model: str | None) -> bool:
    model_name = str(model or "").strip().lower()
    return model_name in {
        "lingshan-g2",
        "gpt-image-2",
        "image-2",
        "image-2-official",
    } or "gpt-image" in model_name


def _image_credit_billing_params(
    *,
    image_size: str | None = None,
    quality: str | None = None,
) -> dict[str, str]:
    params: dict[str, str] = {}
    clean_size = str(image_size or "").strip().lower()
    if clean_size:
        params["size"] = clean_size
    clean_quality = str(quality or "").strip().lower()
    if clean_quality:
        params["quality"] = clean_quality
    return params


def _huimeng_image_resolution_for_model(model: str, image_size: str | None) -> str:
    """Map local image_size labels to HuiMeng model resolution params when supported."""
    model_name = (model or "").strip()
    image2_family = model_name in {"image-2", "image-2-official"}
    if not (
        model_name.startswith(("nb-", "seedream-")) or image2_family or "gpt-image" in model_name
    ):
        return ""

    normalized = normalize_image_size(str(image_size or "").strip(), provider="huimeng")
    if image2_family:
        lower = normalized.lower()
        return lower if lower in {"1k", "2k", "4k"} else ""
    return normalized if normalized in {"1K", "2K", "3K", "4K"} else ""


def _round_openai_edge(value: float) -> int:
    return max(16, int(math.ceil(value / 16.0)) * 16)


def resolve_openai_image_size(
    aspect_ratio: str = "1:1",
    image_size: str = "1K",
    model: str | None = None,
    *,
    allow_dynamic_resolution: bool = False,
    min_pixels: int | None = None,
) -> str:
    """Map internal aspect/image_size labels to GPT Image 2 size strings.

    gpt-image-2 supports flexible sizes, but they must satisfy OpenAI's documented
    constraints: both edges are multiples of 16, max edge <= 3840, ratio <= 3:1,
    and total pixels within the valid range. "1K" here means the smallest valid
    draft size near a 1024px long edge.
    """

    ratio_text = str(aspect_ratio or "1:1").replace("-", ":")
    try:
        raw_w, raw_h = [float(part) for part in ratio_text.split(":", 1)]
        if raw_w <= 0 or raw_h <= 0:
            raise ValueError
    except Exception:
        raw_w, raw_h = 1.0, 1.0

    ratio = raw_w / raw_h
    if ratio > _OPENAI_MAX_RATIO:
        ratio = _OPENAI_MAX_RATIO
    elif ratio < 1.0 / _OPENAI_MAX_RATIO:
        ratio = 1.0 / _OPENAI_MAX_RATIO

    normalized_size = normalize_image_size(str(image_size or "1K"), provider="openai")
    long_edges = {
        "512": 1024,
        "0.5K": 1024,
        "0.5k": 1024,
        "1K": 1024,
        "1k": 1024,
        "2K": 2048,
        "2k": 2048,
        "3K": 3072,
        "3k": 3072,
        "4K": 3840,
        "4k": 3840,
    }
    long_edge = long_edges.get(normalized_size)
    dynamic_max_edge = _OPENAI_MAX_EDGE
    dynamic_max_pixels = _OPENAI_MAX_PIXELS
    explicit_dimensions: tuple[int, int] | None = None
    if long_edge is None and allow_dynamic_resolution:
        explicit_size = re.fullmatch(r"(\d+)\s*[xX×]\s*(\d+)", normalized_size)
        if explicit_size:
            width_i, height_i = (int(value) for value in explicit_size.groups())
            if width_i <= 0 or height_i <= 0:
                raise ValueError(f"invalid image resolution: {image_size}")
            explicit_dimensions = (width_i, height_i)
        k_size = re.fullmatch(r"(\d+(?:\.\d+)?)\s*[kK]", normalized_size)
        if explicit_dimensions is not None:
            pass
        elif k_size:
            long_edge = max(16, _round_openai_edge(float(k_size.group(1)) * 1024))
            dynamic_max_edge = long_edge
            dynamic_max_pixels = long_edge * long_edge
        else:
            raise ValueError(
                f"unsupported image resolution: {image_size}; "
                "use a value such as 2K, 3K, 8K, or 2048x2048"
            )
    if long_edge is None:
        long_edge = 1024
    configured_min_pixels = (
        min_pixels
        if type(min_pixels) is int and min_pixels > 0
        else None
    )
    effective_min_pixels = configured_min_pixels or _OPENAI_MIN_PIXELS
    max_pixels = dynamic_max_pixels

    if explicit_dimensions is not None:
        width, height = (float(value) for value in explicit_dimensions)
    elif ratio >= 1:
        width = float(long_edge)
        height = width / ratio
    else:
        height = float(long_edge)
        width = height * ratio

    pixel_count = width * height
    if pixel_count < effective_min_pixels:
        scale = math.sqrt(effective_min_pixels / pixel_count)
        width *= scale
        height *= scale
    elif explicit_dimensions is None and pixel_count > max_pixels:
        scale = math.sqrt(max_pixels / pixel_count)
        width *= scale
        height *= scale

    if explicit_dimensions is not None and configured_min_pixels is None:
        return f"{explicit_dimensions[0]}x{explicit_dimensions[1]}"

    max_edge = (
        max(dynamic_max_edge, _round_openai_edge(width), _round_openai_edge(height))
        if explicit_dimensions is not None
        else dynamic_max_edge
    )
    width_i = min(max_edge, _round_openai_edge(width))
    height_i = min(max_edge, _round_openai_edge(height))

    if width_i * height_i < effective_min_pixels:
        scale = math.sqrt(effective_min_pixels / max(1, width_i * height_i))
        width_i = min(max_edge, _round_openai_edge(width_i * scale))
        height_i = min(max_edge, _round_openai_edge(height_i * scale))

    return f"{width_i}x{height_i}"


def normalize_openai_quality(value: str | None, default: str = "medium") -> str:
    quality = str(value or default or "medium").strip().lower()
    return quality if quality in _OPENAI_VALID_QUALITIES else default


def _extract_openai_unknown_parameter(error_detail: str) -> str:
    match = re.search(r"Unknown parameter:\s*'([^']+)'", error_detail or "")
    if match:
        return match.group(1)
    match = re.search(r'Unknown parameter:\s*"([^"]+)"', error_detail or "")
    if match:
        return match.group(1)
    match = re.search(r"Unsupported parameter:\s*'([^']+)'", error_detail or "")
    if match:
        return match.group(1)
    match = re.search(r'Unsupported parameter:\s*"([^"]+)"', error_detail or "")
    if match:
        return match.group(1)
    match = re.search(r"'param':\s*'([^']+)'", error_detail or "")
    if match:
        return match.group(1)
    match = re.search(r'"param":\s*"([^"]+)"', error_detail or "")
    if match:
        return match.group(1)
    for parameter in ("output_format", "quality", "input_fidelity"):
        if parameter in (error_detail or ""):
            return parameter
    if "input_fidelity" in (error_detail or ""):
        return "input_fidelity"
    return ""


def _truncate_openrouter_debug(value: object, limit: int = 240) -> str:
    """Truncate OpenRouter debug fields to keep logs short."""
    text = str(value or "")
    if len(text) <= limit:
        return text
    return f"{text[:limit]}..."


async def _check_openrouter_image_capability(api_key: str, model: str) -> tuple[bool, str]:
    """Check whether an OpenRouter model declares image output support."""
    import httpx

    cache_key = f"{model}:{hashlib.sha1((api_key or '').encode('utf-8')).hexdigest()[:8]}"
    cached = _OPENROUTER_IMAGE_CAPABILITY_CACHE.get(cache_key)
    if cached is not None:
        return cached

    base_url = "https://openrouter.ai/api/v1"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://novelvideo.ai",
        "X-Title": "NovelVideo Studio",
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(f"{base_url}/models", headers=headers)
            response.raise_for_status()
            result = response.json()

        models = result.get("data", [])
        model_info = next((item for item in models if item.get("id") == model), None)
        if not model_info:
            detail = f"Model {model} is not in the OpenRouter /models list; skipping the image capability pre-check"
            print(f"[OpenRouter] {detail}")
            outcome = (True, detail)
            _OPENROUTER_IMAGE_CAPABILITY_CACHE[cache_key] = outcome
            return outcome

        output_modalities = (model_info.get("architecture") or {}).get("output_modalities") or []
        supports_image = "image" in output_modalities
        detail = (
            f"model={model}, output_modalities={output_modalities}"
            if output_modalities
            else f"model={model}, output_modalities=[]"
        )
        outcome = (supports_image, detail)
        _OPENROUTER_IMAGE_CAPABILITY_CACHE[cache_key] = outcome
        return outcome
    except Exception as exc:
        detail = "image capability pre-check failed, not blocking: " f"{type(exc).__name__}: {exc!r}"
        print(f"[OpenRouter] {detail}")
        outcome = (True, detail)
        _OPENROUTER_IMAGE_CAPABILITY_CACHE[cache_key] = outcome
        return outcome


def clamp_image_size(size: str) -> str:
    """Clamp image_size to values accepted by Gemini image APIs."""
    normalized = normalize_image_size(size, provider="google")
    return normalized if normalized in _VALID_IMAGE_SIZES else "1K"


# =============================================================================
# Sketch mode configuration
# =============================================================================
# Sketch default ratio (backward compatible)
DEFAULT_SKETCH_ASPECT_RATIO = "2:3"

# =============================================================================
# Regen mode configuration table (Regen Mode Configs)
# =============================================================================
# mode_key format: "{rows}x{cols}_{aspect_ratio_normalized}"
# The single global configuration table; all pools reference this table
# When a new ratio is needed later (e.g. 1x1_16-9 landscape), just add it to this table

REGEN_MODE_CONFIGS: Dict[str, dict] = {
    "1x1_1-1": {
        "rows": 1,
        "cols": 1,
        "aspect_ratio": "1:1",
        "image_size": "1K",
        "label": "1x1_1:1 1K",
        "capacity": 1,
        "model": "nanobanana",
    },
    "1x1_9-16": {
        "rows": 1,
        "cols": 1,
        "aspect_ratio": "9:16",
        "image_size": "1K",
        "label": "1x1_9:16 1K",
        "capacity": 1,
        "model": "nanobanana",
    },
    "1x1_2-3": {
        "rows": 1,
        "cols": 1,
        "aspect_ratio": "2:3",
        "image_size": "1K",
        "label": "1x1_2:3 1K",
        "capacity": 1,
        "model": "nanobanana",
    },
    "1x1_16-9": {
        "rows": 1,
        "cols": 1,
        "aspect_ratio": "16:9",
        "image_size": "1K",
        "label": "1x1_16:9 1K",
        "capacity": 1,
        "model": "nanobanana",
    },
    "1x2_4-3": {
        "rows": 1,
        "cols": 2,
        "aspect_ratio": "4:3",
        "image_size": "1K",
        "label": "1x2_4:3 1K",
        "capacity": 2,
        "model": "nanobanana",
    },
    "1x2_16-9": {
        "rows": 1,
        "cols": 2,
        "aspect_ratio": "16:9",
        "image_size": "1K",
        "label": "1x2_16:9 1K",
        "capacity": 2,
        "model": "nanobanana",
    },
    "1x3_16-9": {
        "rows": 1,
        "cols": 3,
        "aspect_ratio": "16:9",
        "image_size": "1K",
        "label": "1x3_16:9 1K",
        "capacity": 3,
        "model": "nanobanana",
    },
    "1x3_21-9": {
        "rows": 1,
        "cols": 3,
        "aspect_ratio": "21:9",
        "image_size": "1K",
        "label": "1x3_21:9 1K",
        "capacity": 3,
        "model": "nanobanana",
    },
    "1x4_21-9": {
        "rows": 1,
        "cols": 4,
        "aspect_ratio": "21:9",
        "image_size": "1K",
        "label": "1x4_21:9 1K",
        "capacity": 4,
        "model": "nanobanana",
    },
    "1x6_4-1": {
        "rows": 1,
        "cols": 6,
        "aspect_ratio": "4:1",
        "image_size": "1K",
        "label": "1x6_4:1 1K",
        "capacity": 6,
        "model": "nanobanana",
    },
    "2x2_1-1": {
        "rows": 2,
        "cols": 2,
        "aspect_ratio": "1:1",
        "image_size": "2K",
        "label": "2x2_1:1 2K",
        "capacity": 4,
        "model": "nanobanana",
    },
    "2x2_9-16": {
        "rows": 2,
        "cols": 2,
        "aspect_ratio": "9:16",
        "image_size": "2K",
        "label": "2x2_9:16 2K",
        "capacity": 4,
        "model": "nanobanana",
    },
    "2x3_1-1": {
        "rows": 2,
        "cols": 3,
        "aspect_ratio": "1:1",
        "image_size": "2K",
        "label": "2x3_1:1 2K",
        "capacity": 6,
        "model": "nanobanana",
    },
    "2x4_4-3": {
        "rows": 2,
        "cols": 4,
        "aspect_ratio": "4:3",
        "image_size": "2K",
        "label": "2x4_4:3 2K",
        "capacity": 8,
        "model": "nanobanana",
    },
    "2x2_2-3": {
        "rows": 2,
        "cols": 2,
        "aspect_ratio": "2:3",
        "image_size": "2K",
        "label": "2x2_2:3 2K",
        "capacity": 4,
        "model": "nanobanana",
    },
    "2x2_16-9": {
        "rows": 2,
        "cols": 2,
        "aspect_ratio": "16:9",
        "image_size": "2K",
        "label": "2x2_16:9 2K",
        "capacity": 4,
        "model": "nanobanana",
    },
    "3x2_9-16": {
        "rows": 3,
        "cols": 2,
        "aspect_ratio": "9:16",
        "image_size": "2K",
        "label": "3x2_9:16 2K",
        "capacity": 6,
        "model": "nanobanana",
    },
    "3x2_2-3": {
        "rows": 3,
        "cols": 2,
        "aspect_ratio": "2:3",
        "image_size": "2K",
        "label": "3x2_2:3 2K",
        "capacity": 6,
        "model": "nanobanana",
    },
    "3x3_1-1": {
        "rows": 3,
        "cols": 3,
        "aspect_ratio": "1:1",
        "image_size": "4K",
        "label": "3x3_1:1 4K",
        "capacity": 9,
        "model": "nanobanana",
    },
    "3x3_9-16": {
        "rows": 3,
        "cols": 3,
        "aspect_ratio": "9:16",
        "image_size": "4K",
        "label": "3x3_9:16 4K",
        "capacity": 9,
        "model": "nanobanana",
    },
    "3x3_2-3": {
        "rows": 3,
        "cols": 3,
        "aspect_ratio": "2:3",
        "image_size": "2K",
        "label": "3x3_2:3 2K",
        "capacity": 9,
        "model": "nanobanana",
    },
    "3x3_16-9": {
        "rows": 3,
        "cols": 3,
        "aspect_ratio": "16:9",
        "image_size": "4K",
        "label": "3x3_16:9 4K",
        "capacity": 9,
        "model": "nanobanana",
    },
    "4x3_9-16": {
        "rows": 4,
        "cols": 3,
        "aspect_ratio": "9:16",
        "image_size": "4K",
        "label": "4x3_9:16 4K",
        "capacity": 12,
        "model": "nanobanana",
    },
    "4x3_3-4": {
        "rows": 4,
        "cols": 3,
        "aspect_ratio": "3:4",
        "image_size": "4K",
        "label": "4x3_3:4 4K",
        "capacity": 12,
        "model": "nanobanana",
    },
    "4x4_1-1": {
        "rows": 4,
        "cols": 4,
        "aspect_ratio": "1:1",
        "image_size": "4K",
        "label": "4x4_1:1 4K",
        "capacity": 16,
        "model": "nanobanana",
    },
    "4x4_16-9": {
        "rows": 4,
        "cols": 4,
        "aspect_ratio": "16:9",
        "image_size": "4K",
        "label": "4x4_16:9 4K",
        "capacity": 16,
        "model": "nanobanana",
    },
    "5x4_9-16": {
        "rows": 5,
        "cols": 4,
        "aspect_ratio": "9:16",
        "image_size": "4K",
        "label": "5x4_9:16 4K",
        "capacity": 20,
        "model": "nanobanana",
    },
    "5x5_1-1": {
        "rows": 5,
        "cols": 5,
        "aspect_ratio": "1:1",
        "image_size": "4K",
        "label": "5x5_1:1 4K",
        "capacity": 25,
        "model": "nanobanana",
    },
    # Sketch-specific
    "1x1_1-1_sketch": {
        "rows": 1,
        "cols": 1,
        "aspect_ratio": "1:1",
        "image_size": "1K",
        "label": "1x1_1:1 Sketch",
        "capacity": 1,
        "model": "nanobanana",
    },
    "1x1_9-16_sketch": {
        "rows": 1,
        "cols": 1,
        "aspect_ratio": "9:16",
        "image_size": "1K",
        "label": "1x1_9:16 Sketch",
        "capacity": 1,
        "model": "nanobanana",
    },
    "1x1_2-3_sketch": {
        "rows": 1,
        "cols": 1,
        "aspect_ratio": "2:3",
        "image_size": "1K",
        "label": "1x1_2:3 Sketch",
        "capacity": 1,
        "model": "nanobanana",
    },
    "1x1_16-9_sketch": {
        "rows": 1,
        "cols": 1,
        "aspect_ratio": "16:9",
        "image_size": "1K",
        "label": "1x1_16:9 Sketch",
        "capacity": 1,
        "model": "nanobanana",
    },
    "1x2_4-3_sketch": {
        "rows": 1,
        "cols": 2,
        "aspect_ratio": "4:3",
        "image_size": "1K",
        "label": "1x2_4:3 Sketch",
        "capacity": 2,
        "model": "nanobanana",
    },
    "2x2_2-3_sketch": {
        "rows": 2,
        "cols": 2,
        "aspect_ratio": "2:3",
        "image_size": "1K",
        "label": "2x2_2:3 Sketch",
        "capacity": 4,
        "model": "nanobanana",
    },
    "2x2_16-9_sketch": {
        "rows": 2,
        "cols": 2,
        "aspect_ratio": "16:9",
        "image_size": "1K",
        "label": "2x2_16:9 Sketch",
        "capacity": 4,
        "model": "nanobanana",
    },
    "2x2_9-16_sketch": {
        "rows": 2,
        "cols": 2,
        "aspect_ratio": "9:16",
        "image_size": "1K",
        "label": "2x2_9:16 Sketch",
        "capacity": 4,
        "model": "nanobanana",
    },
    "3x3_1-1_sketch": {
        "rows": 3,
        "cols": 3,
        "aspect_ratio": "1:1",
        "image_size": "1K",
        "label": "3x3_1:1 Sketch",
        "capacity": 9,
        "model": "nanobanana",
    },
    "3x3_9-16_sketch": {
        "rows": 3,
        "cols": 3,
        "aspect_ratio": "9:16",
        "image_size": "1K",
        "label": "3x3_9:16 Sketch",
        "capacity": 9,
        "model": "nanobanana",
    },
    "3x3_3-4_sketch": {
        "rows": 3,
        "cols": 3,
        "aspect_ratio": "3:4",
        "image_size": "1K",
        "label": "3x3_3:4 Sketch",
        "capacity": 9,
        "model": "nanobanana",
    },
    "3x3_2-3_sketch": {
        "rows": 3,
        "cols": 3,
        "aspect_ratio": "2:3",
        "image_size": "1K",
        "label": "3x3_2:3 Sketch",
        "capacity": 9,
        "model": "nanobanana",
    },
    "3x3_16-9_sketch": {
        "rows": 3,
        "cols": 3,
        "aspect_ratio": "16:9",
        "image_size": "1K",
        "label": "3x3_16:9 Sketch",
        "capacity": 9,
        "model": "nanobanana",
    },
    "2x3_1-1_sketch": {
        "rows": 2,
        "cols": 3,
        "aspect_ratio": "1:1",
        "image_size": "1K",
        "label": "2x3_1:1 Sketch",
        "capacity": 6,
        "model": "nanobanana",
    },
    "2x4_4-3_sketch": {
        "rows": 2,
        "cols": 4,
        "aspect_ratio": "4:3",
        "image_size": "1K",
        "label": "2x4_4:3 Sketch",
        "capacity": 8,
        "model": "nanobanana",
    },
    "4x3_3-4_sketch": {
        "rows": 4,
        "cols": 3,
        "aspect_ratio": "3:4",
        "image_size": "1K",
        "label": "4x3_3:4 Sketch",
        "capacity": 12,
        "model": "nanobanana",
    },
    "4x4_1-1_sketch": {
        "rows": 4,
        "cols": 4,
        "aspect_ratio": "1:1",
        "image_size": "1K",
        "label": "4x4_1:1 Sketch",
        "capacity": 16,
        "model": "nanobanana",
    },
    "4x4_9-16_sketch": {
        "rows": 4,
        "cols": 4,
        "aspect_ratio": "9:16",
        "image_size": "1K",
        "label": "4x4_9:16 Sketch",
        "capacity": 16,
        "model": "nanobanana",
    },
    "4x4_2-3_sketch": {
        "rows": 4,
        "cols": 4,
        "aspect_ratio": "2:3",
        "image_size": "1K",
        "label": "4x4_2:3 Sketch",
        "capacity": 16,
        "model": "nanobanana",
    },
    "4x4_16-9_sketch": {
        "rows": 4,
        "cols": 4,
        "aspect_ratio": "16:9",
        "image_size": "1K",
        "label": "4x4_16:9 Sketch",
        "capacity": 16,
        "model": "nanobanana",
    },
    "5x5_1-1_sketch": {
        "rows": 5,
        "cols": 5,
        "aspect_ratio": "1:1",
        "image_size": "1K",
        "label": "5x5_1:1 Sketch",
        "capacity": 25,
        "model": "nanobanana",
    },
    "5x5_2-3_sketch": {
        "rows": 5,
        "cols": 5,
        "aspect_ratio": "2:3",
        "image_size": "1K",
        "label": "5x5_2:3 Sketch",
        "capacity": 25,
        "model": "nanobanana",
    },
    "5x5_16-9_sketch": {
        "rows": 5,
        "cols": 5,
        "aspect_ratio": "16:9",
        "image_size": "1K",
        "label": "5x5_16:9 Sketch",
        "capacity": 25,
        "model": "nanobanana",
    },
    "5x5_9-16_sketch": {
        "rows": 5,
        "cols": 5,
        "aspect_ratio": "9:16",
        "image_size": "1K",
        "label": "5x5_9:16 Sketch",
        "capacity": 25,
        "model": "nanobanana",
    },
}


def get_sketch_default_mode_key(aspect_ratio: str = DEFAULT_SKETCH_ASPECT_RATIO) -> str:
    target = aspect_ratio.replace(":", "-")
    candidate = f"5x5_{target}_sketch"
    if candidate in REGEN_MODE_CONFIGS:
        return candidate
    return "5x5_2-3_sketch"


def get_sketch_nxn_modes(
    aspect_ratio: str = DEFAULT_SKETCH_ASPECT_RATIO,
) -> list[tuple[int, str, int, int]]:
    result: list[tuple[int, str, int, int]] = []
    for cap, rows, cols in [(1, 1, 1), (4, 2, 2), (9, 3, 3), (16, 4, 4), (25, 5, 5)]:
        matches = [
            mode_key
            for mode_key, cfg in REGEN_MODE_CONFIGS.items()
            if mode_key.endswith("_sketch")
            and cfg.get("rows") == rows
            and cfg.get("cols") == cols
            and cfg.get("aspect_ratio") == aspect_ratio
        ]
        if matches:
            result.append((cap, matches[0], rows, cols))
            continue
        same_size_fallbacks = [
            mode_key
            for mode_key, cfg in REGEN_MODE_CONFIGS.items()
            if mode_key.endswith("_sketch") and cfg.get("rows") == rows and cfg.get("cols") == cols
        ]
        if same_size_fallbacks:
            preferred_same_size = next(
                (
                    mode_key
                    for mode_key in same_size_fallbacks
                    if REGEN_MODE_CONFIGS[mode_key].get("aspect_ratio")
                    == DEFAULT_SKETCH_ASPECT_RATIO
                ),
                same_size_fallbacks[0],
            )
            result.append((cap, preferred_same_size, rows, cols))
            continue
        raise ValueError(f"No sketch mode available for grid size {rows}x{cols}")
    return result


# Sketch default mode_key; other info is looked up from RE/tmp/claude-0/-home-user-dramaclaw/57eb0762-a929-5d0a-b399-64cb7e8d2633/scratchpad/gen_MODE_CONFIGS
SKETCH_DEFAULT_MODE_KEY = get_sketch_default_mode_key()
PLANNER_VERSION = "2026-04-18-v1"


@dataclass(frozen=True)
class PlanEntry:
    """Single grid entry in a server-authoritative render plan."""

    mode_key: str
    rows: int
    cols: int
    beat_numbers: tuple[int, ...]
    location: str = ""
    padding_count: int = 0
    reasons: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()


def hash_plan(plan: list[PlanEntry]) -> str:
    """Canonical SHA1 of plan shape, truncated for task identity."""
    payload = json.dumps(
        [(entry.mode_key, list(entry.beat_numbers)) for entry in plan],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


def compute_input_fingerprint(
    beats: list[dict],
    character_map: dict,
    sketch_colors: dict,
    strategy: str,
    aspect_mode: str,
    force_one_by_one: bool,
    ref_image_hasher: Callable[[str], str],
) -> str:
    """Fingerprint planning inputs that must stay stable between plan and execute."""
    beats_by_num = sorted(beats, key=_beat_display_sort_key)
    beats_payload = [
        {
            "beat_number": beat.get("beat_number"),
            "location": beat_scene_id(beat) or beat.get("location") or "",
            "detected_identities": sorted(
                real_detected_identities(beat.get("detected_identities") or [])
            ),
            "visual_description": beat.get("visual_description") or "",
        }
        for beat in beats_by_num
    ]

    referenced_ids: set[str] = set()
    for beat in beats_by_num:
        for identity_id in real_detected_identities(beat.get("detected_identities") or []):
            referenced_ids.add(str(identity_id))

    character_payload = []
    for identity_id in sorted(referenced_ids):
        info = character_map.get(identity_id) or {}
        ref_path = info.get("ref_path") or info.get("primary_reference") or ""
        ref_mode = info.get("ref_mode") or info.get("mode") or ""
        content_hash = ref_image_hasher(ref_path) if ref_path else ""
        character_payload.append(
            {
                "id": identity_id,
                "ref_path": ref_path,
                "ref_mode": ref_mode,
                "content_hash": content_hash,
            }
        )

    sketch_color_payload = {
        identity_id: sketch_colors.get(identity_id, "") for identity_id in sorted(referenced_ids)
    }
    envelope = {
        "beats": beats_payload,
        "character_map": character_payload,
        "sketch_colors": sketch_color_payload,
        "strategy": strategy,
        "aspect_mode": aspect_mode,
        "force_one_by_one": bool(force_one_by_one),
        "planner_version": PLANNER_VERSION,
    }
    payload = json.dumps(envelope, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


def cell_aspect_ratio(mode_key: str) -> Optional[str]:
    """Compute the actual aspect-ratio string of a single cell in a mode_key.

    Formula: cell ratio = (W x rows) : (H x cols), where W:H is the overall grid ratio.
    """
    from math import gcd

    cfg = REGEN_MODE_CONFIGS.get(mode_key)
    if not cfg or not cfg.get("aspect_ratio"):
        return None
    w, h = map(int, cfg["aspect_ratio"].split(":"))
    rows, cols = cfg["rows"], cfg["cols"]
    cell_w, cell_h = w * rows, h * cols
    g = gcd(cell_w, cell_h)
    return f"{cell_w // g}:{cell_h // g}"


def sketch_pass1_mode_key(target_mode_key: str) -> Optional[str]:
    """Given a target sketch mode_key, return the 1:1 sketch mode_key of the same size (used for two-pass).

    two-pass is disabled: all ratios (including 5x5 2:3) are generated directly in one pass.
    """
    return None


# Derived from SKETCH_DEFAULT_MODE_KEY (backward compatible)
_sketch_cfg = REGEN_MODE_CONFIGS[SKETCH_DEFAULT_MODE_KEY]
SKETCH_GRID_CONFIG = {
    "rows": _sketch_cfg["rows"],
    "cols": _sketch_cfg["cols"],
    "aspect_ratio": _sketch_cfg["aspect_ratio"],
    "image_size": _sketch_cfg["image_size"],
}
# 5x5 holds 25 beats per image, so 1 image covers a whole episode
SKETCH_GRID_PLAN = [SKETCH_GRID_CONFIG] * 1

# Sketch regeneration only allows NxN + 1:1 modes
SKETCH_REGEN_MODE_KEYS = [
    "1x1_1-1",
    "1x1_1-1_sketch",
    "1x1_9-16_sketch",
    "1x1_2-3_sketch",
    "1x1_16-9_sketch",
    "1x2_4-3_sketch",
    "2x2_1-1",
    "2x2_2-3_sketch",
    "2x2_16-9_sketch",
    "2x2_9-16_sketch",
    "2x4_4-3_sketch",
    "3x2_2-3",
    "3x3_1-1_sketch",
    "3x3_9-16_sketch",
    "3x3_3-4_sketch",
    "3x3_2-3_sketch",
    "3x3_16-9_sketch",
    "4x3_3-4_sketch",
    "4x4_1-1_sketch",
    "4x4_16-9_sketch",
    "5x5_1-1_sketch",
    "5x5_2-3_sketch",
    "5x5_16-9_sketch",
    "5x5_9-16_sketch",
    "5x5_1-1",
]

# =============================================================================
# Unified building-block pool: the pool is the resource list, used until exhausted
# =============================================================================
# Preset pool templates (* N produces the actual resource list)
LOCATION_POOL_TEMPLATE = ["2x4_4-3", "2x3_1-1", "2x2_2-3", "1x2_4-3", "1x1_2-3"]
LANDSCAPE_RENDER_POOL_TEMPLATE = [
    "4x4_16-9",
    "3x3_16-9",
    "2x2_16-9",
    "1x1_16-9",
]

# Default mode pool (same as scene grouping)
DEFAULT_POOL_TEMPLATE = ["2x4_4-3", "2x3_1-1", "2x2_2-3", "1x2_4-3", "1x1_2-3"]
# Character grouping pool
CHARACTER_POOL_2 = ["2x4_4-3", "2x3_1-1", "2x2_2-3", "1x2_4-3", "1x1_2-3"]
CHARACTER_POOL_3 = ["2x4_4-3", "2x3_1-1", "2x2_2-3", "1x2_4-3", "1x1_2-3"]

# Iron rule: with >=3 character references that have reference images, only 1x1 may be used (no grid)
MANY_CHARS_REF_THRESHOLD = 3
MANY_CHARS_MAX_CAPACITY = 1


def _cap_pool_for_many_chars(pool: list, composite_count: int) -> list:
    """When the composite character count >= the threshold, filter the pool to capacity <= the limit."""
    if composite_count >= MANY_CHARS_REF_THRESHOLD:
        capped = [
            mk for mk in pool if REGEN_MODE_CONFIGS[mk]["capacity"] <= MANY_CHARS_MAX_CAPACITY
        ]
        return capped if capped else pool
    return pool


def _count_batch_composite_chars(beats: list, character_map: dict) -> int:
    """Count the unique composite characters appearing in a batch of beats."""
    all_chars = set()
    for beat in beats:
        all_chars |= _get_beat_visual_composite_chars(beat, character_map)
    return len(all_chars)


def _smart_repack_beats(
    beats: List[dict],
    character_map: dict,
    pool_template: list,
    overrides: dict = None,
    loc: str = "",
) -> list:
    """Smart split: divide beats into consecutive subgroups by composite character count, each with n_comp < threshold.

    When a batch of beats has a total n_comp >= 3, instead of capping everything to 1x2 at once,
    scan greedily: consecutive beats merge their composite sets, breaking only when the threshold is actually reached.
    Each subgroup is packed with the full pool (since n_comp < 3 within the subgroup),
    and only a single beat that is itself >= 3 uses the capped pool.
    """
    if not beats:
        return []

    groups: List[List[dict]] = []
    current_group: List[dict] = []
    current_chars: set = set()

    for beat in beats:
        beat_chars = _get_beat_visual_composite_chars(beat, character_map)
        merged = current_chars | beat_chars

        if len(merged) >= MANY_CHARS_REF_THRESHOLD and current_group:
            # The current beat would push n_comp over the limit; flush the existing group first
            groups.append(current_group)
            current_group = [beat]
            current_chars = set(beat_chars)
        else:
            current_group.append(beat)
            current_chars = merged

    if current_group:
        groups.append(current_group)

    # Merge subgroups with the same character set (e.g. B1-6{Alice,Bob} and B17-18{Alice,Bob})
    merged_groups: List[List[dict]] = []
    merged_charsets: List[frozenset] = []
    for group in groups:
        chars = frozenset()
        for beat in group:
            chars = chars | _get_beat_visual_composite_chars(beat, character_map)
        # Find an existing group with the same character set to merge into
        found = False
        for i, existing_chars in enumerate(merged_charsets):
            if (
                chars == existing_chars
                or (chars | existing_chars) == existing_chars
                or (chars | existing_chars) == chars
            ):
                # Same character set or a subset; check whether the merged result is still < threshold
                union = chars | existing_chars
                if len(union) < MANY_CHARS_REF_THRESHOLD:
                    merged_groups[i].extend(group)
                    merged_charsets[i] = union
                    found = True
                    break
        if not found:
            merged_groups.append(list(group))
            merged_charsets.append(chars)

    # After merging, sort the beats within each group by first beat_number
    for group in merged_groups:
        group.sort(key=lambda b: b.get("beat_number", 0))

    # Pack each subgroup with a suitable pool
    result = []
    for group in merged_groups:
        n_comp = _count_batch_composite_chars(group, character_map)
        if n_comp >= MANY_CHARS_REF_THRESHOLD:
            # A single beat that is itself >= 3 composite, use the capped pool
            capped = _cap_pool_for_many_chars(list(pool_template), n_comp)
            if loc:
                result.extend(_pack_location_beats(group, loc, capped, overrides or {}))
            else:
                pool = list(capped) * 100
                mode_keys = pack_beats(len(group), pool)
                result.extend(mode_keys)
        else:
            # n_comp < 3, use the full pool
            if loc:
                result.extend(
                    _pack_location_beats(group, loc, list(pool_template), overrides or {})
                )
            else:
                pool = list(pool_template) * 100
                mode_keys = pack_beats(len(group), pool)
                result.extend(mode_keys)

    return result


def pad_to_aspect_ratio(panel, target_aspect: str, fill_color=(220, 220, 220)):
    """Pad the panel top/bottom or left/right with white to the target ratio. No cropping, no stretching.
    If the panel is already wider/taller than the target, return it as-is (no cropping).
    Fills with white, and overlaps a few pixels inward to cover the border lines drawn by the AI."""
    from PIL import Image, ImageDraw

    w, h = panel.size
    aw, ah = map(int, target_aspect.replace(":", "x").split("x"))
    target_ratio = aw / ah
    current_ratio = w / h

    if abs(current_ratio - target_ratio) < 0.08:
        return panel  # already matches (a small 0.5K panel can be a few % off in ratio after trimming)

    white = (255, 255, 255)
    # Number of pixels to overlap inward: covers the border line at the edge of the original image
    overlap = max(6, min(w, h) // 60)

    if current_ratio > target_ratio:
        # Panel is wider -> needs more height (pad top/bottom)
        new_h = int(w / target_ratio)
        result = Image.new("RGB", (w, new_h), white)
        py = (new_h - h) // 2
        result.paste(panel, (0, py))
        # White overlay on the top / bottom overlap rows of the original image
        draw = ImageDraw.Draw(result)
        draw.rectangle([0, py, w - 1, py + overlap - 1], fill=white)
        draw.rectangle([0, py + h - overlap, w - 1, py + h - 1], fill=white)
        return result
    else:
        # Panel is taller -> needs more width (pad left/right)
        new_w = int(h * target_ratio)
        result = Image.new("RGB", (new_w, h), white)
        px = (new_w - w) // 2
        result.paste(panel, (px, 0))
        # White overlay on the left / right overlap columns of the original image
        draw = ImageDraw.Draw(result)
        draw.rectangle([px, 0, px + overlap - 1, h - 1], fill=white)
        draw.rectangle([px + w - overlap, 0, px + w - 1, h - 1], fill=white)
        return result


def pack_beats(total_beats: int, pool: list[str]) -> list[str]:
    """Greedy bin-pack: prefer reducing the number of grids.

    Strategy: first try to find the smallest grid that fits all beats;
    if none is found, take the largest grid, fill it, and recurse on the remainder.
    """
    if total_beats <= 0:
        return [pool[0]] if pool else []

    # Deduplicate and sort by capacity ascending
    unique_modes = list(dict.fromkeys(pool))  # order-preserving dedupe
    by_cap_asc = sorted(unique_modes, key=lambda mk: REGEN_MODE_CONFIGS[mk]["capacity"])

    # 1. Try to fit all beats in a single grid (pick the smallest that fits)
    for mk in by_cap_asc:
        if REGEN_MODE_CONFIGS[mk]["capacity"] >= total_beats:
            return [mk]

    # 2. Does not fit -> take the largest grid, recurse on the remainder
    largest = by_cap_asc[-1]
    largest_cap = REGEN_MODE_CONFIGS[largest]["capacity"]
    remaining = total_beats - largest_cap
    return [largest] + pack_beats(remaining, pool)


# =============================================================================
# Scene grouping ratio override table
# =============================================================================
# aspect_mode → {(rows, cols): (aspect_ratio, image_size)}
# Only list the grid sizes that need to override the default lookup
LOCATION_ASPECT_CONFIGS = {
    "9:16": {
        # 2x2 is not overridden; it uses the SQUARE default 1:1
    },
    "1:1": {
        (2, 2): ("1:1", "2K"),
        (1, 1): ("1:1", "1K"),
    },
}


def parse_regen_mode(mode_key: str) -> tuple:
    """Parse a regeneration mode key and return (rows, cols, aspect_ratio, image_size).

    Args:
        mode_key: e.g. '1x1_9-16', '2x2_1-1'

    Returns:
        (rows, cols, aspect_ratio, image_size)
    """
    cfg = REGEN_MODE_CONFIGS[mode_key]
    return cfg["rows"], cfg["cols"], cfg["aspect_ratio"], cfg["image_size"]


def get_default_mode_for_grid(grid_size: str) -> str:
    """Return the default mode key for a grid size like 1x1 / 2x2 / 3x3."""
    for key in REGEN_MODE_CONFIGS:
        if key.startswith(grid_size + "_"):
            return key
    raise ValueError(f"No regen mode for grid size: {grid_size}")


def get_regen_modes_for_grid(grid_size: str) -> list:
    """Get the list of all mode keys for the given grid_size.

    Args:
        grid_size: e.g. '1x1', '2x2'

    Returns:
        [mode_key, ...]
    """
    return [k for k in REGEN_MODE_CONFIGS if k.startswith(grid_size + "_")]


def grid_mode_to_mode_key(grid_mode: str) -> str:
    """Convert a simple grid_mode (e.g. '3x3') to a mode_key with ratio (e.g. '3x3_1-1').

    Looks up the matching mode_key in RE/tmp/claude-0/-home-user-dramaclaw/57eb0762-a929-5d0a-b399-64cb7e8d2633/scratchpad/gen_MODE_CONFIGS.
    Returns directly if it is already in mode_key format (contains '_').
    """
    # Already contains ratio info (e.g. '3x3_1-1'); return directly
    if "_" in grid_mode:
        return grid_mode
    parts = grid_mode.split("x")
    if len(parts) != 2:
        return grid_mode  # special modes such as loc
    try:
        rows, cols = int(parts[0]), int(parts[1])
    except ValueError:
        return grid_mode
    # Find the first mode_key in RE/tmp/claude-0/-home-user-dramaclaw/57eb0762-a929-5d0a-b399-64cb7e8d2633/scratchpad/gen_MODE_CONFIGS matching (rows, cols)
    for mk, cfg in REGEN_MODE_CONFIGS.items():
        if cfg["rows"] == rows and cfg["cols"] == cols:
            return mk
    return grid_mode  # fallback


def _single_cell_render_mode_key(aspect_mode: str) -> str:
    return SINGLE_CELL_RENDER_MODE_BY_ASPECT.get(
        str(aspect_mode or "").strip(),
        SINGLE_CELL_RENDER_MODE_KEY,
    )


def _render_pool_template_for_aspect(aspect_mode: str) -> list[str]:
    if str(aspect_mode or "").strip() == "16:9":
        # Square 16:9 grids keep every split cell at 16:9 while still combining beats.
        return list(LANDSCAPE_RENDER_POOL_TEMPLATE)
    return list(LOCATION_POOL_TEMPLATE)


# =============================================================================
# Shot-Level Grid configuration (v2.0 Shot-Centric)
# =============================================================================
# N beats in a Shot -> 1 Grid, used as the @image storyboard reference of Seedance 2.0
# Only verified formats are used (Grid layouts understood by Seedance 2.0)

SHOT_GRID_CONFIGS: Dict[int, dict] = {
    1: {
        "rows": 1, "cols": 1, "aspect_ratio": "9:16", "image_size": "1K", "order_hint": "",
    },
    2: {
        "rows": 1, "cols": 2, "aspect_ratio": "16:9", "image_size": "2K", "order_hint": "left to right",
    },
    3: {
        "rows": 1, "cols": 3, "aspect_ratio": "21:9", "image_size": "2K", "order_hint": "left to right",
    },
    4: {
        "rows": 2,
        "cols": 2,
        "aspect_ratio": "1:1",
        "image_size": "2K",
        "order_hint": "left to right, top to bottom",
    },
    5: {
        "rows": 3,
        "cols": 3,
        "aspect_ratio": "1:1",
        "image_size": "4K",
        "order_hint": "left to right, top to bottom, first 5 cells",
    },
}


def get_shot_grid_config(beat_count: int) -> dict:
    """Get the Shot-level Grid configuration.

    Args:
        beat_count: number of beats in the Shot (1-5)

    Returns:
        {"rows", "cols", "aspect_ratio", "image_size", "order_hint"}
    """
    beat_count = max(1, min(5, beat_count))
    return SHOT_GRID_CONFIGS[beat_count]


class GridGenerationRequest(BaseModel):
    """Grid generation request.

    The reference mode is decided upstream by build_character_map_for_grid():
    - composite: composite reference image (Portrait + Fullbody stitched), locks face + clothing
    - portrait_only: face close-up only, locks the face; clothing is controlled by the appearance_details text
    - prompt_only: no reference image, fully controlled by the prompt
    """

    beats: List[dict] = Field(description="List of Beats data (up to 25 per grid; leave empty if fewer)")
    character_map: Dict[str, dict] = Field(
        default_factory=dict,
        description="""Character mapping {character_name: {
            'character_tag': ...,
            'base_prompt': ...,
            'appearance_details': ...,
            'portrait_path': ...,  # face close-up image (used to lock the face)
            'ref_path': ...,  # reference image path
            'reference_mode': ...,  # composite / portrait_only / prompt_only
        }}""",
    )
    style: str = Field(
        default=None,
        description="Global style (chinese_period_drama, anime, realistic); defaults to IMAGE_DEFAULT_STYLE",
    )
    episode: int = Field(description="Episode number")
    ethnicity: str = Field(
        default="Chinese",
        description="Default character ethnicity (Chinese, Korean, Japanese, Western, etc.)",
    )


class GridGenerationResult(BaseModel):
    """Grid generation result."""

    success: bool
    grid_image_path: Optional[str] = None
    grid_image_bytes: Optional[bytes] = None
    error: Optional[str] = None
    generation_time: float = 0.0
    # Metadata used when regenerating a single grid
    beat_start_index: Optional[int] = None  # start beat index of this grid (0-based)
    beat_count: Optional[int] = None  # actual number of beats in this grid (excluding padding)
    grid_rows: Optional[int] = None  # number of grid rows
    grid_cols: Optional[int] = None  # number of grid columns


def filter_character_map_for_beats(
    character_map: dict,
    beats: list,
    scene_refs: dict[int, list[Any]] | None = None,
) -> dict:
    """Filter the character map to the characters that actually appear in the current beats.

    Only keeps characters whose {{character_name}} appears in the beats' visual_description.

    Returns:
        The filtered character_map (a new dict; the original data is not modified)
    """
    panel_chars = PromptComponents.extract_panel_characters(beats, character_map)

    # Keep only characters that appear
    filtered = {k: dict(v) for k, v in character_map.items() if k in panel_chars}

    non_panel = [c for c in character_map if c not in filtered]
    if non_panel:
        print(f"[filter_character_map] Filtering out characters not appearing: {non_panel}")

    return filtered


def _has_director_image_ref(scene_refs: dict[int, list[Any]], panel_idx: int = 1) -> bool:
    for ref in scene_refs.get(panel_idx, []) or []:
        if str(getattr(ref, "source_level", "") or "").strip() != "director_image":
            continue
        image_paths = list(getattr(ref, "image_paths", []) or [])
        if image_paths and all(os.path.exists(path) for path in image_paths):
            return True
    return False


def build_color_map_from_character_map(
    character_map: dict,
    sketch_colors: dict[str, str] | None = None,
) -> dict[str, str]:
    """Build a {key: "#HEX COLOR_NAME"} color map from character_map + sketch_colors.

    Returns:
        {identity_key: "#HEX COLOR_NAME"}.
        Character key format is "char_name_suffix" or "char_name".
    """
    color_map = {}
    for char_name, info in character_map.items():
        identity_colors = info.get("identity_sketch_colors", {})
        if identity_colors:
            for suffix, color_str in identity_colors.items():
                color_map[f"{char_name}_{suffix}"] = color_str
        elif info.get("sketch_color"):
            color_map[char_name] = info["sketch_color"]
    return color_map


def _extract_hex_color(color_str: str, fallback: str) -> str:
    text = str(color_str or "").strip()
    match = re.search(r"#[0-9A-Fa-f]{6}", text)
    return match.group(0) if match else fallback


def _color_for_identity(identity_id: str, character_map: dict, fallback: str) -> str:
    color_map = build_color_map_from_character_map(character_map)
    if identity_id in color_map:
        return _extract_hex_color(color_map[identity_id], fallback)
    for char_name, info in character_map.items():
        if identity_id == char_name or identity_id.startswith(f"{char_name}_"):
            identity_colors = info.get("identity_sketch_colors") or {}
            suffix = (
                identity_id[len(char_name) + 1 :] if identity_id.startswith(f"{char_name}_") else ""
            )
            if suffix and suffix in identity_colors:
                return _extract_hex_color(identity_colors[suffix], fallback)
            return _extract_hex_color(info.get("sketch_color", ""), fallback)
    return fallback


def _draw_blocking_stick_figure(
    draw,
    *,
    x: float,
    y: float,
    scale: float,
    color: str,
    foreground: bool = False,
    seated: bool = False,
) -> None:
    """Draw simple color-coded stick blocking onto a director environment ref."""

    width = max(5, int(scale * 0.08))
    head_r = scale * (0.22 if foreground else 0.16)
    body_len = scale * (0.62 if foreground else (0.34 if seated else 0.48))
    shoulder = scale * (0.22 if foreground else 0.16)
    hip = scale * (0.16 if foreground else 0.12)
    outline = color

    # Head.
    draw.ellipse(
        (x - head_r, y - head_r, x + head_r, y + head_r),
        outline=outline,
        width=width,
    )

    neck_y = y + head_r
    torso_y = neck_y + body_len
    draw.line((x, neck_y, x, torso_y), fill=outline, width=width)
    draw.line(
        (x - shoulder, neck_y + scale * 0.1, x + shoulder, neck_y + scale * 0.1),
        fill=outline,
        width=width,
    )
    draw.line((x - hip, torso_y, x + hip, torso_y), fill=outline, width=width)

    # Arms and rough lower-body cues. Keep it rough: these are placement markers, not anatomy.
    if foreground:
        draw.line(
            (x + shoulder, neck_y + scale * 0.12, x + scale * 0.38, torso_y),
            fill=outline,
            width=width,
        )
        draw.line(
            (x - shoulder, neck_y + scale * 0.12, x - scale * 0.34, torso_y),
            fill=outline,
            width=width,
        )
    elif seated:
        draw.line(
            (x - shoulder, neck_y + scale * 0.1, x - scale * 0.34, torso_y + scale * 0.04),
            fill=outline,
            width=width,
        )
        draw.line(
            (x + shoulder, neck_y + scale * 0.1, x + scale * 0.3, torso_y + scale * 0.02),
            fill=outline,
            width=width,
        )
    else:
        draw.line(
            (x - shoulder, neck_y + scale * 0.12, x - scale * 0.28, torso_y - scale * 0.08),
            fill=outline,
            width=width,
        )
        draw.line(
            (x + shoulder, neck_y + scale * 0.12, x + scale * 0.26, torso_y - scale * 0.1),
            fill=outline,
            width=width,
        )
        draw.line(
            (x - hip, torso_y, x - scale * 0.22, torso_y + scale * 0.24), fill=outline, width=width
        )
        draw.line(
            (x + hip, torso_y, x + scale * 0.24, torso_y + scale * 0.22), fill=outline, width=width
        )


def _prepare_director_blocking_refs(
    *,
    scene_refs: dict[int, list],
    beats: list[dict],
    character_map: dict,
) -> None:
    """Legacy no-op.

    Current 3GS scene sketch submits the PlayCanvas combined.png directly.
    The image already contains the visible actor placeholder and prop/staging
    marker colors; the model edits that single image in place.
    """
    return


def detect_panel_characters(
    character_map: dict,
    sketch_image_path: str,
    rows: int,
    cols: int,
    sketch_colors: dict[str, str] | None = None,
) -> dict[int, set[str]]:
    """Per-panel color detection, returning the character keys detected in each panel.

    Returns:
        {panel_index(0-based): set of detected color_map keys}
    """
    from novelvideo.generators.sketch_color_detector import detect_sketch_colors_per_panel

    color_map = build_color_map_from_character_map(character_map, sketch_colors)
    if not color_map:
        return {}

    return detect_sketch_colors_per_panel(sketch_image_path, color_map, rows=rows, cols=cols)


def filter_character_map_by_sketch(
    character_map: dict,
    sketch_image_path: str,
    sketch_colors: dict[str, str] | None = None,
) -> dict:
    """Detect sketch colors and filter out characters that are absent.

    Keeps prompt_only characters and those without a sketch_color (they cannot be judged by color).
    Only filters characters that have a sketch_color but whose color does not exist in the sketch.

    Returns:
        The filtered character_map (a new dict)
    """
    from novelvideo.generators.sketch_color_detector import detect_sketch_colors

    color_map = build_color_map_from_character_map(character_map, sketch_colors)
    if not color_map:
        return dict(character_map)

    # Build the char_to_keys mapping
    char_to_keys = {}
    for char_name, info in character_map.items():
        keys = []
        identity_colors = info.get("identity_sketch_colors", {})
        if identity_colors:
            keys = [f"{char_name}_{suffix}" for suffix in identity_colors]
        elif info.get("sketch_color"):
            keys = [char_name]
        char_to_keys[char_name] = keys

    detected = detect_sketch_colors(sketch_image_path, color_map, verbose=True)

    filtered = {}
    removed = []
    for char_name, info in character_map.items():
        keys = char_to_keys.get(char_name, [])
        if not keys:
            filtered[char_name] = dict(info)
        elif any(k in detected for k in keys):
            filtered[char_name] = dict(info)
        else:
            removed.append(char_name)

    if removed:
        print(f"[filter_by_sketch] No colors detected in the sketch, removing characters: {removed}")

    return filtered


def load_precomputed_panel_detected(
    beat_numbers: list[int],
    beats_data: list[dict],
) -> dict[int, set[str] | None]:
    """Read detected_identities from the beat data and convert to the panel_detected format.

    Returns:
        {panel_index (0-based): set of identity keys}; panels not detected have the value None
    """
    beat_map = {b.get("beat_number"): b for b in (beats_data or [])}
    result = {}
    for panel_idx, bn in enumerate(beat_numbers):
        beat = beat_map.get(bn, {})
        ids = real_detected_identities(beat.get("detected_identities", []))
        result[panel_idx] = set(ids) if ids else None
    return result


def filter_character_map_by_precomputed(
    character_map: dict,
    panel_detected: dict[int, set[str] | None],
) -> dict:
    """Filter character_map by precomputed results: keep only characters that appear in any panel."""
    if not panel_detected or all(v is None for v in panel_detected.values()):
        return {}

    all_detected = set()
    for ids in panel_detected.values():
        if ids is not None:
            all_detected.update(ids)

    if not all_detected:
        return {}

    filtered = {}
    removed = []
    for char_name, info in character_map.items():
        identity_colors = info.get("identity_sketch_colors", {})
        keys = []
        if identity_colors:
            keys = [f"{char_name}_{suffix}" for suffix in identity_colors]
        elif info.get("sketch_color"):
            keys = [char_name]

        if not keys or any(k in all_detected for k in keys):
            filtered[char_name] = dict(info)
        else:
            removed.append(char_name)

    if removed:
        print(f"[filter_by_precomputed] Not detected by precomputation, removing characters: {removed}")

    return filtered


def resolve_render_reference_order(
    ctx,
    beats: list[dict],
    grid_capacity: int,
    valid_character_map: dict,
) -> list[str]:
    """Unified Render-mode reference image order.

    Single source of truth:
    1. Only reuse the order resolved by prompt_builder during the build() stage
    2. Raise an error if missing; forbid re-deriving at runtime, which would break WYSIWYG
    """
    if not valid_character_map:
        return []

    ordered_chars = list(getattr(ctx, "resolved_render_chars", []) or [])
    if ordered_chars:
        return ordered_chars

    raise RuntimeError(
        "Render reference order missing: ctx.resolved_render_chars was not populated "
        "by prompt_builder. Refusing to recompute attachment order at runtime."
    )


def crop_sketch_panels(
    sketch_path: str,
    beat_numbers: List[int],
    target_rows: int,
    target_cols: int,
    output_path: str,
    label_beats: bool = False,
    beat_sketch_paths: Dict[int, str] = None,
    target_aspect: str = None,
) -> str:
    """Extract panels from the sketch by beat number and stitch them into the target layout.

    Used by both export and generation to ensure WYSIWYG.

    Args:
        sketch_path: sketch file path or sketch directory path
        beat_numbers: list of actual beat numbers (1-based), e.g. [2, 5, 8]
        target_rows: target number of grid rows
        target_cols: target number of grid columns
        output_path: output file path
        label_beats: whether to label the beat number at the top left of each panel
        beat_sketch_paths: {beat_num: full_path} per-beat sketch paths taken from the image pool
        target_aspect: target ratio (e.g. "9:16"); when non-empty, pad with white to that ratio

    Returns:
        Path of the saved image
    """
    from PIL import Image
    from novelvideo.generators.grid_splitter import _trim_outer_border
    import numpy as np

    def _trim_panel(panel_img):
        """Trim the white border of a single panel."""
        gray_arr = np.array(panel_img.convert("L"))
        trimmed, _ = _trim_outer_border(panel_img, gray_arr)
        return trimmed

    panels = []
    panel_width = None
    panel_height = None
    pool_hit = 0

    for beat_num in beat_numbers:
        # Prefer taking the single-beat sketch from the image pool
        if beat_sketch_paths and beat_num in beat_sketch_paths:
            pool_img = Image.open(beat_sketch_paths[beat_num])
            pool_img = _trim_panel(pool_img)
            if target_aspect:
                pool_img = pad_to_aspect_ratio(pool_img, target_aspect)
            if panel_width is None:
                panel_width = pool_img.width
                panel_height = pool_img.height
            else:
                if pool_img.size != (panel_width, panel_height):
                    pool_img = pool_img.resize((panel_width, panel_height), Image.LANCZOS)
            panels.append(pool_img)
            pool_hit += 1
        else:
            # No sketch -> gray placeholder
            if panel_width:
                panels.append(Image.new("RGB", (panel_width, panel_height), (128, 128, 128)))

    if pool_hit > 0:
        now = time.time()
        if now - getattr(crop_sketch_panels, "_last_log_t", 0.0) >= 5.0:
            print(f"[crop_sketch_panels] Took {pool_hit}/{len(beat_numbers)} beat sketches from the image pool")
            crop_sketch_panels._last_log_t = now

    if not panels or panel_width is None:
        raise ValueError(f"Cannot extract beat {beat_numbers} from the sketch")

    target_width = target_cols * panel_width
    target_height = target_rows * panel_height
    result_img = Image.new("RGB", (target_width, target_height), (255, 255, 255))

    for i, panel in enumerate(panels):
        if i >= target_rows * target_cols:
            break
        r = i // target_cols
        c = i % target_cols
        x = c * panel_width
        y = r * panel_height
        result_img.paste(panel, (x, y))

    # Draw the dividing lines between panels
    if target_rows > 1 or target_cols > 1:
        from PIL import ImageDraw as _ImageDraw

        _draw = _ImageDraw.Draw(result_img)
        _line_w = max(1, min(panel_width, panel_height) // 200)
        _line_color = (180, 180, 180)
        for c in range(1, target_cols):
            _x = c * panel_width
            _draw.line([(_x, 0), (_x, target_height)], fill=_line_color, width=_line_w)
        for r in range(1, target_rows):
            _y = r * panel_height
            _draw.line([(0, _y), (target_width, _y)], fill=_line_color, width=_line_w)

    # Label the beat number at the top left of each panel
    if label_beats and beat_numbers:
        from PIL import ImageDraw, ImageFont

        draw = ImageDraw.Draw(result_img)
        font_size = max(16, min(panel_width, panel_height) // 6)
        try:
            font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", font_size)
        except (OSError, IOError):
            font = ImageFont.load_default()
        for i, beat_num in enumerate(beat_numbers):
            if i >= target_rows * target_cols:
                break
            r = i // target_cols
            c = i % target_cols
            x = c * panel_width + 4
            y = r * panel_height + 2
            label = f"B{beat_num}"
            # Black outline + white text to ensure readability
            for dx, dy in [(-1, -1), (-1, 1), (1, -1), (1, 1), (-2, 0), (2, 0), (0, -2), (0, 2)]:
                draw.text((x + dx, y + dy), label, fill="black", font=font)
            draw.text((x, y), label, fill="white", font=font)

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    result_img.save(output_path, quality=85)
    return output_path


def get_optimal_grid_size(beat_count: int, max_grid: int = 16) -> tuple[int, int]:
    """Choose the optimal grid size by beat count, minimizing black padding.

    Note: this function has been replaced by perfect_grid_split() for batch generation.
    Kept for backward compatibility and single-grid regeneration.

    Args:
        beat_count: number of beats to fill
        max_grid: maximum grid capacity

    Returns:
        (rows, cols) tuple
    """
    if beat_count <= 0:
        return (1, 1)  # smallest grid: a single image

    # Available grids (sorted by capacity ascending)
    # Includes portrait-panel modes: 1x4=4, 3x2=6, 4x3=12, 5x4=20
    grid_options = [
        (1, 1),  # 1
        (1, 3),  # 3
        (1, 4),  # 4  portrait panels (21:9 wide)
        (2, 2),  # 4
        (3, 2),  # 6  portrait panels
        (3, 3),  # 9
        (4, 3),  # 12 portrait panels
        (5, 3),  # 15 portrait panels
        (4, 4),  # 16
        (5, 4),  # 20 portrait panels
        (5, 5),  # 25
    ]

    for rows, cols in grid_options:
        capacity = rows * cols
        # Skip grids exceeding the maximum limit
        if capacity > max_grid:
            continue
        if beat_count <= capacity:
            return (rows, cols)

    # Exceeds all available grids; return the largest allowed grid
    for rows, cols in reversed(grid_options):
        if rows * cols <= max_grid:
            return (rows, cols)

    # Default to 1x1
    return (1, 1)


def perfect_grid_split(total_beats: int, max_grid: int = 12) -> list[str]:
    """Perfectly split beats so that every grid is exactly filled, needing no padding panels.

    Delegates internally to pack_beats, using an unlimited pool.

    Args:
        total_beats: total number of beats
        max_grid: maximum grid capacity (e.g. 12 means at most 4x3)

    Returns:
        List of mode_keys, e.g. ["3x2_9-16", "1x1_9-16"]
    """
    template = DEFAULT_POOL_TEMPLATE
    # Filter out those exceeding max_grid, then * 100 to produce an unlimited pool
    pool = [mk for mk in template if REGEN_MODE_CONFIGS[mk]["capacity"] <= max_grid] * 100
    if not pool:
        smallest = min(template, key=lambda mk: REGEN_MODE_CONFIGS[mk]["capacity"])
        pool = [smallest] * 100
    return pack_beats(total_beats, pool)


def scene_grid_split(
    all_beats: List[dict],
    aspect_mode: str = "9:16",
    pool_template: List[str] | None = None,
    character_map: Dict[str, dict] | None = None,
) -> List[dict]:
    """Group beats by scene_id, covering each group with the fewest grids.

    Aggregates beats of the same scene_id into the same grid, reducing cross-grid scene drift.
    Each scene_id group automatically picks the best grid size based on its beat count.

    Building-block sequence: 2x2(4), 1x3(3), 1x2(2), 1x1(1)
    2x2 is the largest grid and works best with 2K 1:1.

    Args:
        all_beats: all beat data (with scene_id / beat_number fields)
        aspect_mode: ratio mode ("9:16", "1:1", etc.), used to override the ratio for specific grid sizes
        pool_template: custom building-block pool template, takes precedence over aspect_mode selection

    Returns:
        List of grid plans, each item:
        {
            "scene_id": "Home - Dining Room",
            "rows": 2, "cols": 2,
            "mode_key": "2x2_1-1",
            "beats": [beat_dict, ...],
            "beat_numbers": [4, 5, 6, ...],
            "padding_count": 0,
        }
    """
    from collections import OrderedDict

    if pool_template:
        template = pool_template
    else:
        template = LOCATION_POOL_TEMPLATE
    overrides = LOCATION_ASPECT_CONFIGS.get(aspect_mode, {})

    # 1. Aggregate by scene_id, keeping first-appearance order
    location_groups: OrderedDict[str, List[dict]] = OrderedDict()
    for beat in all_beats:
        loc = beat_scene_id(beat) or "Unknown scene"
        if loc not in location_groups:
            location_groups[loc] = []
        location_groups[loc].append(beat)

    # 1.5 Coarse merge (Home - Living Room + Home - Dining Room -> Home)
    location_groups = _coalesce_locations(location_groups)

    # 2. For each scene_id group, subdivide by per-beat composite count and pack separately
    result = []
    for loc, beats in location_groups.items():
        if character_map:
            # Split by per-beat composite character count into light groups (<= 2) and heavy groups (>= 3)
            light_beats = []  # <= 2 composite -> use the full pool first, then post-process
            heavy_beats = []  # >= 3 composite -> capped to 2x2
            for beat in beats:
                n = len(_get_beat_visual_composite_chars(beat, character_map))
                if n >= MANY_CHARS_REF_THRESHOLD:
                    heavy_beats.append(beat)
                else:
                    light_beats.append(beat)

            # Light groups: smart repack (group by consecutive composite counts, using larger grids where possible)
            if light_beats:
                light_entries = _pack_location_beats(
                    light_beats,
                    loc,
                    list(template),
                    overrides,
                )
                for entry in light_entries:
                    grid_cc = _count_batch_composite_chars(entry["beats"], character_map)
                    if (
                        grid_cc >= MANY_CHARS_REF_THRESHOLD
                        and len(entry["beats"]) > MANY_CHARS_MAX_CAPACITY
                    ):
                        # Smart split: group by consecutive composite counts; subgroups with <=2 use the full pool
                        result.extend(
                            _smart_repack_beats(
                                entry["beats"],
                                character_map,
                                list(template),
                                overrides,
                                loc,
                            )
                        )
                    else:
                        result.append(entry)
            # Heavy groups: smart repack
            if heavy_beats:
                result.extend(
                    _smart_repack_beats(
                        heavy_beats,
                        character_map,
                        list(template),
                        overrides,
                        loc,
                    )
                )
        else:
            result.extend(
                _pack_location_beats(
                    beats,
                    loc,
                    list(template),
                    overrides,
                )
            )

    # 3. Merge small grids: merge consecutive 1-beat grids into larger grids
    result = _merge_small_grids(result, template, character_map)

    return result


def _merge_small_grids(
    entries: List[dict],
    pool_template: List[str],
    character_map: Dict[str, dict] | None = None,
) -> List[dict]:
    """Merge consecutive small grids (1-2 beats) into larger grids, reducing 1x1 fragments.

    Strategy: scan consecutive small grids (capacity <= 2), accumulate beats, then use pack_beats
    to reassign them to larger grids (preferring 2x3, 2x2, 1x2).
    After merging, the iron rule still applies: with >= 3 composite characters, capacity <= 2.
    """
    merged = []
    small_buffer = []  # temporarily holds consecutive small grids of the same scene_id

    def flush_buffer():
        """Repack the beats of the accumulated small grids into larger grids."""
        if not small_buffer:
            return
        all_beats = []
        for entry in small_buffer:
            all_beats.extend(entry["beats"])

        combined_loc = small_buffer[0].get("scene_id", "")

        # Iron rule check: if the merged beats' composite characters >= threshold, use smart_repack
        if character_map:
            n_comp = _count_batch_composite_chars(all_beats, character_map)
            if n_comp >= MANY_CHARS_REF_THRESHOLD:
                merged.extend(
                    _smart_repack_beats(
                        all_beats,
                        character_map,
                        list(pool_template),
                        overrides={},
                        loc=combined_loc,
                    )
                )
                return

        # Normal merge: reassign with pack_beats
        pool = pool_template * 100
        mode_keys = pack_beats(len(all_beats), pool)

        offset = 0
        for mk in mode_keys:
            cfg = REGEN_MODE_CONFIGS[mk]
            rows, cols = cfg["rows"], cfg["cols"]
            capacity = cfg["capacity"]
            batch = all_beats[offset : offset + capacity]
            beat_numbers = [b.get("beat_number", i + 1) for i, b in enumerate(batch)]
            merged.append(
                {
                    "scene_id": combined_loc,
                    "rows": rows,
                    "cols": cols,
                    "mode_key": mk,
                    "beats": batch,
                    "beat_numbers": beat_numbers,
                    "padding_count": capacity - len(batch),
                }
            )
            offset += capacity

    for entry in entries:
        n_beats = len(entry["beats"])
        entry_scene = entry.get("scene_id", "")
        buffer_scene = small_buffer[0].get("scene_id", "") if small_buffer else None
        if n_beats <= 2:
            if small_buffer and entry_scene != buffer_scene:
                flush_buffer()
                small_buffer = []
            small_buffer.append(entry)
        else:
            # Hit a large grid; flush the previous small grids first
            flush_buffer()
            small_buffer = []
            merged.append(entry)

    # Flush the tail
    flush_buffer()

    return merged


def _pack_location_beats(
    beats: List[dict],
    loc: str,
    pool_template: List[str],
    overrides: dict,
) -> List[dict]:
    """Pack the beats of one scene subgroup into grid entries."""
    pool = pool_template * 100
    mode_keys = pack_beats(len(beats), pool)
    entries = []
    offset = 0
    for mk in mode_keys:
        cfg = REGEN_MODE_CONFIGS[mk]
        rows, cols = cfg["rows"], cfg["cols"]
        capacity = cfg["capacity"]
        batch = beats[offset : offset + capacity]
        beat_numbers = [b.get("beat_number", i + 1) for i, b in enumerate(batch)]
        entry = {
            "scene_id": loc,
            "rows": rows,
            "cols": cols,
            "mode_key": mk,
            "beats": batch,
            "beat_numbers": beat_numbers,
            "padding_count": capacity - len(batch),
        }
        grid_key = (rows, cols)
        if grid_key in overrides:
            ar, isz = overrides[grid_key]
            entry["mode_key"] = f"{rows}x{cols}_{ar.replace(':', '-')}"
        entries.append(entry)
        offset += capacity
    return entries


def build_regen_plan(
    selected_beats: list[dict],
    strategy: str,
    aspect_mode: str,
    character_map: dict | None = None,
    force_one_by_one: bool = False,
    image_generation_selection: str | None = None,
) -> list[PlanEntry]:
    """Build the canonical render plan for a selected beat set."""
    single_cell_reason = ""
    if force_one_by_one:
        single_cell_reason = "force-1x1"
    elif image_generation_selection_forces_single_cell(image_generation_selection):
        single_cell_reason = HUIMENG_IMAGE2_SINGLE_CELL_REASON

    if single_cell_reason:
        mode_key = _single_cell_render_mode_key(aspect_mode)
        return [
            PlanEntry(
                mode_key=mode_key,
                rows=1,
                cols=1,
                beat_numbers=(int(beat["beat_number"]),),
                location=str(beat_scene_id(beat) or beat.get("location") or ""),
                reasons=(single_cell_reason,),
            )
            for beat in selected_beats
        ]

    pool_template = _render_pool_template_for_aspect(aspect_mode)

    if strategy == "location":
        raw_plan = scene_grid_split(
            list(selected_beats),
            aspect_mode=aspect_mode,
            pool_template=pool_template,
            character_map=character_map if character_map else None,
        )
        return [
            PlanEntry(
                mode_key=entry["mode_key"],
                rows=int(entry["rows"]),
                cols=int(entry["cols"]),
                beat_numbers=tuple(int(n) for n in entry["beat_numbers"]),
                location=str(entry.get("scene_id") or entry.get("location") or ""),
                padding_count=int(entry.get("padding_count") or 0),
                reasons=tuple(entry.get("reasons") or ()),
                warnings=tuple(entry.get("warnings") or ()),
            )
            for entry in raw_plan
        ]

    if strategy == "naive":
        mode_keys = pack_beats(len(selected_beats), list(pool_template))
        entries: list[PlanEntry] = []
        offset = 0
        for mode_key in mode_keys:
            cfg = REGEN_MODE_CONFIGS[mode_key]
            capacity = cfg["capacity"]
            batch = selected_beats[offset : offset + capacity]
            if not batch:
                break
            entries.append(
                PlanEntry(
                    mode_key=mode_key,
                    rows=int(cfg["rows"]),
                    cols=int(cfg["cols"]),
                    beat_numbers=tuple(int(beat["beat_number"]) for beat in batch),
                    padding_count=capacity - len(batch),
                )
            )
            offset += capacity
        return entries

    raise ValueError(f"unknown strategy: {strategy!r}")


def _get_beat_visual_composite_chars(beat: dict, character_map: dict) -> frozenset:
    """Extract the characters with reference images that are actually drawn, from the {{}} markers in visual_description.

    Render scenes prefer detected_identities, so the iron-rule split uses the same character source as coloring/export.
    If there is no detected_identities, fall back to the {{}} markers in visual_description.
    Includes both composite and portrait_only modes (both occupy an image slot with a reference image).
    """
    ref_names = sorted(
        [
            name
            for name, info in character_map.items()
            if info.get("reference_mode") != "prompt_only"
            and (info.get("reference_path") or info.get("ref_path") or info.get("portrait_path"))
        ],
        key=len,
        reverse=True,
    )
    detected = real_detected_identities(beat.get("detected_identities") or [])
    if detected:
        markers = list(detected)
    else:
        visual = beat.get("visual_description", "")
        markers = re.findall(r"\{\{([^}]+)\}\}", visual)
    result = set()
    for marker in markers:
        for char_name in ref_names:
            if marker == char_name or marker.startswith(char_name + "_"):
                result.add(char_name)
                break
    return frozenset(result)


def _flush_to_grids(
    beats: List[dict],
    composite_count: int,
) -> List[dict]:
    """Pack a group of beats into one or more grid entries."""
    if not beats:
        return []
    if composite_count <= 2:
        template = CHARACTER_POOL_2  # at most 2x2
    else:
        template = CHARACTER_POOL_3  # at most 2x2
    # Iron rule
    template = _cap_pool_for_many_chars(template, composite_count)
    pool = list(template) * 100
    mode_keys = pack_beats(len(beats), pool)

    entries = []
    offset = 0
    for mk in mode_keys:
        cfg = REGEN_MODE_CONFIGS[mk]
        capacity = cfg["capacity"]
        batch = beats[offset : offset + capacity]
        beat_numbers = [b.get("beat_number", i + 1) for i, b in enumerate(batch)]
        entries.append(
            {
                "rows": cfg["rows"],
                "cols": cfg["cols"],
                "mode_key": mk,
                "beats": batch,
                "beat_numbers": beat_numbers,
                "padding_count": capacity - len(batch),
                "composite_count": composite_count,
            }
        )
        offset += capacity
    return entries


def character_grid_split(
    all_beats: List[dict],
    character_map: Dict[str, dict],
) -> List[dict]:
    """Group beats globally by composite characters, automatically choosing grid sizes.

    Three-phase algorithm:
    1. Classify: extract the composite character count from the {{}} markers in visual_description
       - >2 chars -> overflow (<=2x2 pool)
       - 0 chars  -> empty (absorbed by the nearest group)
       - 1-2 chars -> normal (paired grouping)
    2. Greedy set-cover pairing: globally aggregate all beats of the same character pair
    3. Pack into grids: <=2 chars -> CHARACTER_POOL_2 (at most 2x2), >2 chars -> CHARACTER_POOL_3 (at most 2x2)

    Args:
        all_beats: all beat data (with visual_description / beat_number fields)
        character_map: character mapping {character_name: {reference_mode, ...}}

    Returns:
        List of grid plans, in the same format as scene_grid_split
    """
    if not all_beats:
        return []

    # ── Phase 1: classify ──
    overflow_beats: List[dict] = []  # >2 composite chars
    empty_beats: List[dict] = []  # 0 composite chars
    normal_beats: List[Tuple[int, dict, frozenset]] = []  # (index, beat, chars)

    for idx, beat in enumerate(all_beats):
        chars = _get_beat_visual_composite_chars(beat, character_map)
        if len(chars) > 2:
            overflow_beats.append(beat)
        elif len(chars) == 0:
            empty_beats.append(beat)
        else:
            normal_beats.append((idx, beat, chars))

    # ── Phase 2: greedy set-cover pairing ──
    # Collect all 1-char and 2-char candidate pairs that appear
    all_char_sets: set = set()
    for _, _, chars in normal_beats:
        all_char_sets.add(chars)

    # Enumerate all possible pairs (combinations of 1 or 2 characters)
    all_single_chars = set()
    for cs in all_char_sets:
        all_single_chars |= cs
    candidate_pairs: List[frozenset] = []
    single_list = sorted(all_single_chars)
    for i, c1 in enumerate(single_list):
        candidate_pairs.append(frozenset({c1}))
        for c2 in single_list[i + 1 :]:
            candidate_pairs.append(frozenset({c1, c2}))

    assigned = [False] * len(normal_beats)
    pair_groups: List[Tuple[frozenset, List[dict]]] = []  # (pair, beats)

    while True:
        # Find the pair that covers the most unassigned beats
        best_pair = None
        best_indices = []
        for pair in candidate_pairs:
            indices = [
                i
                for i, (_, _, chars) in enumerate(normal_beats)
                if not assigned[i] and chars <= pair
            ]
            if len(indices) > len(best_indices):
                best_pair = pair
                best_indices = indices
        if not best_indices:
            break
        for i in best_indices:
            assigned[i] = True
        group_beats = [normal_beats[i][1] for i in best_indices]
        pair_groups.append((best_pair, group_beats))

    # ── empty beats are absorbed by the nearest pair group ──
    if empty_beats and pair_groups:
        for eb in empty_beats:
            eb_num = eb.get("beat_number", 0)
            best_group_idx = 0
            best_dist = float("inf")
            for gi, (_, group_beats) in enumerate(pair_groups):
                for gb in group_beats:
                    dist = abs(gb.get("beat_number", 0) - eb_num)
                    if dist < best_dist:
                        best_dist = dist
                        best_group_idx = gi
            pair_groups[best_group_idx][1].append(eb)
    elif empty_beats:
        # No pair group; empty beats form their own group
        pair_groups.append((frozenset(), empty_beats))

    # ── Phase 3: pack into grids ──
    result: List[dict] = []

    # pair groups → 4x4
    for pair, beats in pair_groups:
        # Sort by beat_number to keep order
        beats.sort(key=lambda b: b.get("beat_number", 0))
        result.extend(_flush_to_grids(beats, len(pair)))

    # overflow -> batch flush, letting pack_beats pack automatically
    if overflow_beats:
        overflow_beats.sort(key=lambda b: b.get("beat_number", 0))
        max_cc = max(
            len(_get_beat_visual_composite_chars(ob, character_map)) for ob in overflow_beats
        )
        result.extend(_flush_to_grids(overflow_beats, max_cc))

    # Sort by first beat_number
    result.sort(key=lambda g: g["beat_numbers"][0] if g["beat_numbers"] else 0)

    return result


def sketch_grid_split(total_beats: int) -> list[tuple[int, int]]:
    """Dedicated Sketch-mode split: return 1x one 5x5 grid (25 panel slots in total).

    Allocated in SKETCH_GRID_PLAN order; when beats are insufficient, only the needed number of grids is used.
    """
    plan = []
    remaining = total_beats
    for grid_cfg in SKETCH_GRID_PLAN:
        if remaining <= 0:
            break
        r, c = grid_cfg["rows"], grid_cfg["cols"]
        plan.append((r, c))
        remaining -= r * c
    return plan if plan else [(1, 1)]


def _coalesce_locations(location_groups):
    """Merge fine-grained scene groups into coarse ones by the prefix before the dot.

    "Home - Living Room", "Home - Dining Room" -> "Home"
    Scenes without a dot are kept as-is. First-appearance order is kept.
    """
    from collections import OrderedDict

    coarse: OrderedDict[str, list] = OrderedDict()
    for fine_loc, beats in location_groups.items():
        prefix = fine_loc.split("·")[0].split("・")[0].strip()
        if not prefix:
            prefix = fine_loc
        if prefix not in coarse:
            coarse[prefix] = []
        coarse[prefix].extend(beats)
    return coarse


# (capacity, mode_key, rows, cols) -- sorted by capacity ascending
SKETCH_NXN_MODES = get_sketch_nxn_modes()


async def generate_text_to_image(
    prompt: str,
    output_path: str,
    *,
    aspect_ratio: str = "1:1",
    image_size: str = "2K",
    quality: str | None = None,
    api_key: Optional[str] = None,
    config: Optional[dict] = None,
    egress_context: TrustedEgressContext | None = None,
    egress_capability: str = "image.generate",
) -> Path:
    """Generate one image from a prompt only — no reference images.

    Routes through the same 4 providers as `generate_reference_edit_image`
    (google / openrouter / huimeng / openai). Use `config` to override the
    provider/model picked from env defaults.
    """
    return await _generate_image(
        prompt=prompt,
        reference_image_paths=[],
        output_path=output_path,
        aspect_ratio=aspect_ratio,
        image_size=image_size,
        quality=quality,
        api_key=api_key,
        config=config,
        egress_context=egress_context,
        egress_capability=egress_capability,
    )


async def generate_reference_edit_image(
    prompt: str,
    reference_images: list[str],
    output_path: str,
    *,
    aspect_ratio: str = "2:3",
    image_size: str = "2K",
    quality: str | None = None,
    api_key: Optional[str] = None,
    config: Optional[dict] = None,
    egress_context: TrustedEgressContext | None = None,
    egress_capability: str = "image.edit",
) -> Path:
    """Generate one edited image from reference images plus a free-form edit prompt.

    `config` lets callers override the provider / model selection (passed through
    to `NanoBananaGridGenerator`); when None, falls back to env-var defaults via
    `get_grid_generation_config()`.
    """
    ref_paths = [path for path in reference_images if path and os.path.exists(path)]
    if not ref_paths:
        raise FileNotFoundError("No valid reference images provided for edit generation")
    return await _generate_image(
        prompt=prompt,
        reference_image_paths=ref_paths,
        output_path=output_path,
        aspect_ratio=aspect_ratio,
        image_size=image_size,
        quality=quality,
        api_key=api_key,
        config=config,
        egress_context=egress_context,
        egress_capability=egress_capability,
    )


async def _generate_image(
    *,
    prompt: str,
    reference_image_paths: list[str],
    output_path: str,
    aspect_ratio: str,
    image_size: str,
    quality: str | None,
    api_key: Optional[str],
    config: Optional[dict],
    egress_context: TrustedEgressContext | None,
    egress_capability: str,
) -> Path:
    """Shared body for text-only and image-edit single-image generation."""
    ref_paths = list(reference_image_paths or [])
    context = _validate_egress_context(egress_context)
    if context is None:
        # The claim itself does not leak (`_prepare_organization_image_egress` falls back to the scope on its own); what leaks is
        # the identity forwarded to the leaf: leaving `context` as None makes the reference-image relay silently take the platform branch instead of
        # `relay_tenant_image_bytes_from_context`. Only the organization branch is filled in -- also falling back the platform identity
        # would make platform traffic hit the organization deny gate (the house rule of OI-48).
        context = ambient_organization_egress_context()
    configured_provider = (
        str((config or {}).get("provider") or "newapi").strip().lower()
    )
    request = {
        "model": str((config or {}).get("model") or ""),
        "prompt": prompt,
        "reference_sha256": [
            hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in ref_paths
        ],
        "aspect_ratio": aspect_ratio,
        "image_size": image_size,
        "quality": quality or "",
    }
    organization_egress = await _prepare_organization_image_egress(
        egress_context=context,
        provider=configured_provider,
        capability=egress_capability,
        request=request,
    )
    effective_config = config
    effective_api_key = api_key
    if organization_egress is not None:
        effective_config = dict(config or {})
        effective_config.update(
            {
                "provider": "newapi",
                "api_key": organization_egress.credential.api_key,
                "base_url": organization_egress.credential.base_url,
            }
        )
        effective_api_key = organization_egress.credential.api_key
    generator = NanoBananaGridGenerator(
        api_key=effective_api_key, config=effective_config
    )

    if generator.provider == "openrouter":
        ref_bytes = [Path(path).read_bytes() for path in ref_paths]
        image_bytes, _, error_detail = await _call_openrouter_image_api(
            api_key=generator.api_key,
            model=generator.model,
            prompt=prompt,
            reference_images=ref_bytes,
            image_config={"aspect_ratio": aspect_ratio, "image_size": image_size},
        )
        if not image_bytes:
            raise ValueError(
                f"OpenRouter edit image generation failed: {error_detail or 'empty image'}"
            )
    elif generator.provider == "huimeng":
        ref_bytes = [Path(path).read_bytes() for path in ref_paths]
        image_bytes, _, error_detail = await _call_huimeng_image_api(
            api_key=generator.api_key,
            model=generator.model,
            prompt=prompt,
            reference_images=ref_bytes,
            image_config={
                "aspect_ratio": aspect_ratio,
                "image_size": image_size,
                "quality": quality or generator.huimeng_image_quality,
                "huimeng_image_quality": quality or generator.huimeng_image_quality,
            },
        )
        if not image_bytes:
            raise ValueError(
                f"HuiMeng edit image generation failed: {error_detail or 'empty image'}"
            )
    elif generator.provider == "openai":
        ref_bytes = [Path(path).read_bytes() for path in ref_paths]
        image_bytes, _, error_detail = await _call_openai_image_api(
            api_key=generator.api_key,
            model=generator.model,
            prompt=prompt,
            reference_images=ref_bytes,
            image_config={
                "aspect_ratio": aspect_ratio,
                "image_size": image_size,
                "quality": quality or generator.openai_image_quality,
                "output_format": "png",
            },
        )
        if not image_bytes:
            raise ValueError(
                f"OpenAI edit image generation failed: {error_detail or 'empty image'}"
            )
    elif generator.provider == "newapi":
        ref_bytes = [(Path(path).read_bytes(), path) for path in ref_paths]
        trace: dict[str, str] = {}
        delivery_state: dict[str, bool | str] = {}
        image_bytes, _, error_detail = await _call_newapi_image_api(
            api_key=generator.api_key,
            model=generator.model,
            prompt=prompt,
            reference_images=ref_bytes or None,
            image_config={
                "aspect_ratio": aspect_ratio,
                "image_size": image_size,
                "quality": quality or generator.openai_image_quality,
                "request_schema": generator.newapi_request_schema,
                "model_params": generator.newapi_model_params,
            },
            base_url=generator.base_url,
            trace=trace,
            egress_context=context,
            delivery_path=output_path,
            delivery_state=delivery_state,
            read_copied_bytes=False,
        )
        if not image_bytes and not delivery_state.get("copied"):
            raise ValueError(
                f"DramaClawAPI image generation failed: {error_detail or 'empty image'}"
            )
    elif generator.provider == "runpod_qwen":
        # Added for Freezone's plain text-to-image/reference-edit path
        # (`generate_text_to_image`/`generate_reference_edit_image`,
        # called from `freezone/jobs.py`'s `run_freezone_gen`) — this
        # function previously only implemented openrouter/huimeng/openai/
        # newapi (plus "google" as the bare `else:` below); `runpod_qwen`
        # fell through to that `else:` and would have wrongly tried the
        # Google genai SDK with a RunPod API key. Mirrors the identical
        # branch in `NanoBananaGridGenerator.generate_grid()`'s own
        # `elif self.provider == "runpod_qwen":` dispatch — same helper,
        # same reference-image naming convention. See `.claude/CLAUDE.md`.
        reference_images = [
            (
                _webai_ref_filename(i, mimetypes.guess_type(path)[0] or "image/png"),
                Path(path).read_bytes(),
                mimetypes.guess_type(path)[0] or "image/png",
            )
            for i, path in enumerate(ref_paths)
        ]
        image_bytes, _text, runpod_qwen_error = await _call_runpod_qwen_image_api(
            api_key=generator.api_key,
            model=generator.model,
            prompt=prompt,
            reference_images=reference_images or None,
            image_config={"aspect_ratio": aspect_ratio, "image_size": image_size},
            base_url=generator.base_url,
        )
        if not image_bytes:
            raise ValueError(
                f"RunPod Qwen Image generation failed: {runpod_qwen_error or 'empty image'}"
            )
    elif generator.provider == "runpod_qwen_edit":
        # Added for Freezone's `/freezone/edit` and `/freezone/relight`
        # (`run_freezone_edit`, `freezone/jobs.py`) — same reasoning as the
        # `runpod_qwen` branch above: this function previously had no
        # dispatch for Edit-2511 at all (only the beat-render pipeline
        # called `_call_runpod_qwen_edit_image_api` directly). `ref_paths[0]`
        # is always the edit canvas (`run_freezone_edit` puts `base_path`
        # first) and becomes `image1` — the output keeps `image1`'s own
        # size, so `aspect_ratio`/`image_size` are accepted here for
        # call-site symmetry but genuinely unused by the worker. See
        # `.claude/CLAUDE.md`.
        reference_images = [
            (
                _webai_ref_filename(i, mimetypes.guess_type(path)[0] or "image/png"),
                Path(path).read_bytes(),
                mimetypes.guess_type(path)[0] or "image/png",
            )
            for i, path in enumerate(ref_paths)
        ]
        image_bytes, _text, runpod_qwen_edit_error = await _call_runpod_qwen_edit_image_api(
            api_key=generator.api_key,
            model=generator.model,
            prompt=prompt,
            reference_images=reference_images or None,
        )
        if not image_bytes:
            raise ValueError(
                f"RunPod Qwen Image Edit generation failed: {runpod_qwen_edit_error or 'empty image'}"
            )
    elif generator.provider == "runpod_qwen21_render":
        # Added for Freezone's `/freezone/edit` (compositing a character/
        # prop/reference into an existing canvas image while PRESERVING
        # its composition/scale) — same checkpoint as `runpod_qwen` above
        # (Qwen-Image 2.1) but a different ComfyUI graph
        # (`_runpod_qwen21_render_image_graph`): the KSampler latent comes
        # from `TextEncodeQwenImage21`'s own latent output (sized off
        # `reference_images[0]`, the canvas) instead of an independently
        # sized `EmptyLatentImage` — the fix the main render pipeline
        # already applied on 2026-10-18
        # (`_call_runpod_qwen21_render_image_api`) for exactly this kind
        # of composition-preserving edit, never wired into Freezone until
        # now. `ref_paths[0]` is always the edit canvas (`run_freezone_edit`
        # puts `base_path` first, same convention as `runpod_qwen_edit`
        # above) and becomes `image_1`; every reference (including the
        # canvas) is auto-resized to a shared target area by the callee
        # (`_qwen21_prepare_render_image`), so `aspect_ratio`/`image_size`
        # are accepted here for call-site symmetry but genuinely unused.
        # See `.claude/CLAUDE.md` 2026-10-26 entry.
        reference_images = [
            (
                _webai_ref_filename(i, mimetypes.guess_type(path)[0] or "image/png"),
                Path(path).read_bytes(),
                mimetypes.guess_type(path)[0] or "image/png",
            )
            for i, path in enumerate(ref_paths)
        ]
        image_bytes, _text, runpod_qwen21_render_error = await _call_runpod_qwen21_render_image_api(
            api_key=generator.api_key,
            model=generator.model,
            prompt=prompt,
            reference_images=reference_images or None,
        )
        if not image_bytes:
            raise ValueError(
                f"RunPod Qwen Image 2.1 (render graph) generation failed: {runpod_qwen21_render_error or 'empty image'}"
            )
    else:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=generator.api_key)
        contents = [prompt]
        for ref_path in ref_paths:
            ref_image = generator._load_image_as_part(ref_path)
            if ref_image:
                contents.append(ref_image)

        is_gemini3 = "gemini-3" in generator.model
        if is_gemini3:
            image_config = types.ImageConfig(
                aspect_ratio=aspect_ratio,
                image_size=image_size,
            )
        else:
            image_config = types.ImageConfig(aspect_ratio=aspect_ratio)

        response = await asyncio.to_thread(
            client.models.generate_content,
            model=generator.model,
            contents=contents,
            config=types.GenerateContentConfig(
                response_modalities=["IMAGE", "TEXT"],
                image_config=image_config,
            ),
        )
        image_bytes = None
        if response.candidates and response.candidates[0].content:
            for part in response.candidates[0].content.parts:
                if hasattr(part, "inline_data") and part.inline_data:
                    image_bytes = part.inline_data.data
                    break
        if not image_bytes:
            raise ValueError("Google edit image generation returned no image data")

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    if not (generator.provider == "newapi" and delivery_state.get("copied")):
        output.write_bytes(image_bytes)
    await _complete_organization_image_egress(
        organization_egress,
        trace=trace if generator.provider == "newapi" else {},
        result_ref=str(output),
    )
    return output


def _pick_nxn_mode(n: int, aspect_ratio: str = DEFAULT_SKETCH_ASPECT_RATIO):
    """Pick the smallest NxN mode that fits n beats."""
    modes = get_sketch_nxn_modes(aspect_ratio)
    for cap, mk, r, c in modes:
        if n <= cap:
            return mk, r, c, cap
    # Fall back to the largest mode
    cap, mk, r, c = modes[-1]
    return mk, r, c, cap


def _group_beats_by_location(beats: List[dict]):
    """Group beats by the scene_id field, keeping appearance order. Returns a list of (scene_id, beats_list)."""
    from collections import OrderedDict

    groups: OrderedDict = OrderedDict()
    for b in beats:
        loc = beat_scene_id(b) or "Unknown"
        groups.setdefault(loc, []).append(b)
    return list(groups.items())


def _is_space_map_beat(beat: dict) -> bool:
    visual = str((beat or {}).get("visual_description") or "").strip().lower()
    return (
        visual.startswith("[space_map")
        or visual.startswith("[space_anchor_map]")
        or visual.startswith("[absolute_layout_map]")
    )


def sketch_scene_grid_split(
    all_beats: List[dict],
    aspect_ratio: str = DEFAULT_SKETCH_ASPECT_RATIO,
) -> List[dict]:
    """Sketch: split strictly by scene, then choose the smallest grid that fits for each scene."""
    modes = get_sketch_nxn_modes(aspect_ratio)
    max_cap = modes[-1][0]
    all_beats = [beat for beat in (all_beats or []) if not _is_space_map_beat(beat)]
    if not all_beats:
        cap, mk, r, c = modes[-1]
        return [
            {
                "scene_id": "",
                "rows": r,
                "cols": c,
                "mode_key": mk,
                "beats": [],
                "beat_numbers": [],
                "padding_count": cap,
            }
        ]

    result = []
    for scene_id, scene_beats in _group_beats_by_location(all_beats):
        offset = 0
        total = len(scene_beats)
        while offset < total:
            remaining = min(total - offset, max_cap)
            mk, r, c, cap = _pick_nxn_mode(remaining, aspect_ratio=aspect_ratio)
            chunk = scene_beats[offset : offset + cap]
            beat_numbers = [b.get("beat_number", 0) for b in chunk]
            result.append(
                {
                    "scene_id": scene_id,
                    "rows": r,
                    "cols": c,
                    "mode_key": mk,
                    "beats": list(chunk),
                    "beat_numbers": beat_numbers,
                    "padding_count": cap - len(chunk),
                }
            )
            offset += cap
    return result


def find_sketch_for_beat_range(
    sketch_dir: str, beat_start: int, beat_end: int
) -> Optional[Tuple[str, int, int]]:
    """Find the sketch file covering the given beat range in the sketch directory.

    Args:
        sketch_dir: sketch directory path
        beat_start: starting beat number (1-based)
        beat_end: ending beat number (1-based, inclusive)

    Returns:
        (file path, rows, cols) or None.
        File naming convention: sketch_b{start}-{end}_{rows}x{cols}.jpg
    """
    candidates = []
    for f in Path(sketch_dir).glob("sketch_b*_*x*.jpg"):
        name = f.stem  # e.g., "sketch_b1-25_5x5"
        try:
            parts = name.split("_b")[1].split("_")
            s, e = parts[0].split("-")
            r, c = parts[1].split("x")
            file_start, file_end = int(s), int(e)
            if file_start <= beat_start and beat_end <= file_end:
                span = file_end - file_start
                candidates.append((span, str(f), int(r), int(c)))
        except (IndexError, ValueError):
            continue
    if not candidates:
        return None
    # Choose the one with the smallest coverage range (the most precise match)
    candidates.sort(key=lambda x: x[0])
    _, path, rows, cols = candidates[0]
    return path, rows, cols


async def _call_openrouter_image_api(
    api_key: str,
    model: str,
    prompt: str,
    reference_images: list[bytes] | None = None,
    image_config: dict | None = None,
) -> tuple[bytes | None, str, str]:
    """Call Gemini image generation through the OpenRouter API.

    Returns:
        (image_bytes, text_response, error_detail)
        - image_bytes: generated image bytes; None on failure
        - text_response: text content returned by the provider (e.g. panel hints JSON)
        - error_detail: failure summary; an empty string on success

    Args:
        api_key: OpenRouter API Key
        model: model name (e.g. google/gemini-3-pro-image-preview)
        prompt: image generation prompt
        reference_images: list of reference images (bytes format)
        image_config: image config (aspect_ratio, image_size)
    """
    import httpx

    base_url = "https://openrouter.ai/api/v1"

    # Build the content array (per the official OpenRouter advice: text first, images after)
    content = []

    # Add the text prompt first
    content.append({"type": "text", "text": prompt})

    # Then add the reference images (if any)
    if reference_images:
        for img_bytes in reference_images:
            img_b64 = base64.b64encode(img_bytes).decode("utf-8")
            content.append(
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_b64}"}}
            )

    payload = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "modalities": ["image", "text"],
    }

    # Add image_config
    if image_config:
        effective_image_size = normalize_image_size(
            image_config.get("image_size", "1K"),
            provider="openrouter",
        )
        payload["image_config"] = {
            "aspect_ratio": image_config.get("aspect_ratio", "1:1"),
            "image_size": effective_image_size,
        }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://novelvideo.ai",
        "X-Title": "NovelVideo Studio",
    }

    try:
        supports_image, capability_detail = await _check_openrouter_image_capability(api_key, model)
        if not supports_image:
            detail = f"OpenRouter model does not declare image output support: {capability_detail}"
            print(f"[OpenRouter] {detail}")
            return None, "", detail

        async with httpx.AsyncClient(timeout=300.0) as client:
            response = await client.post(
                f"{base_url}/chat/completions",
                json=payload,
                headers=headers,
            )
            response.raise_for_status()

            result = response.json()

            # Extract the image
            choices = result.get("choices", [])
            if not choices:
                print(f"[OpenRouter] Response has no choices: {_truncate_openrouter_debug(result)}")
                return None, "", "Response has no choices"

            message = choices[0].get("message", {})

            # Extract text and images (compatible with several OpenRouter response formats)
            text_content = ""
            image_data_url = ""

            content = message.get("content", "")
            if isinstance(content, list):
                # content is list[{type, text/image_url}]
                text_parts = []
                for part in content:
                    if not isinstance(part, dict):
                        continue
                    if part.get("type") == "text":
                        text_parts.append(part.get("text", ""))
                    elif part.get("type") == "image_url":
                        url = part.get("image_url", {}).get("url", "")
                        if url.startswith("data:image"):
                            image_data_url = url
                text_content = " ".join(text_parts)
            elif isinstance(content, str):
                text_content = content

            if text_content:
                print(f"[OpenRouter] Text response: {text_content[:500]}")

            # Prefer taking the image from message.images (legacy format)
            images = message.get("images", [])
            if images:
                url = images[0].get("image_url", {}).get("url", "")
                if url.startswith("data:image"):
                    image_data_url = url

            if not image_data_url:
                print(f"[OpenRouter] Response has no image: {_truncate_openrouter_debug(message)}")
                detail = "Model returned no image"
                if text_content:
                    detail = f"{detail}, text only: {text_content[:200]}"
                return None, text_content or "", detail

            # Extract the base64 part
            _, b64_data = image_data_url.split(",", 1)
            return base64.b64decode(b64_data), text_content or "", ""

    except httpx.HTTPStatusError as e:
        print(
            "[OpenRouter] HTTP error: "
            f"{e.response.status_code} - {_truncate_openrouter_debug(e.response.text, limit=500)}"
        )
        body = _truncate_openrouter_debug(e.response.text, limit=280)
        return (
            None,
            "",
            f"HTTP {e.response.status_code}: {body}" if body else f"HTTP {e.response.status_code}",
        )
    except Exception as e:
        if is_fatal_billing_error(e):
            raise
        detail = f"{type(e).__name__}: {e!r}"
        print(f"[OpenRouter] Request error: {detail}")
        return None, "", f"Request error: {detail}"


async def _call_openai_image_api(
    *,
    api_key: str,
    model: str,
    prompt: str,
    reference_images: list[bytes | tuple[bytes, str] | tuple[str, bytes, str]] | None = None,
    image_config: dict | None = None,
) -> tuple[bytes | None, str, str]:
    """Call OpenAI Image API using GPT Image models.

    Returns:
        (image_bytes, text_response, error_detail)
    """

    try:
        from openai import AsyncOpenAI
    except ImportError:
        return None, "", "openai SDK not installed; install openai>=2.14.0"

    if not api_key:
        return None, "", "OPENAI_API_KEY is missing"

    image_config = image_config or {}
    image_size = normalize_image_size(str(image_config.get("image_size") or "1K"), "openai")
    size = resolve_openai_image_size(
        image_config.get("aspect_ratio", "1:1"),
        image_size,
    )
    request_options: dict[str, object] = {"size": size}
    is_gpt_image_2 = str(model or "").strip().lower().startswith("gpt-image-2")
    quality = normalize_openai_quality(str(image_config.get("quality") or ""), default="medium")
    if quality:
        request_options["quality"] = quality
    output_format = str(image_config.get("output_format") or "png").strip().lower()
    # The current Image Edit endpoint rejects output_format for some gpt-image-2
    # reference-image requests. Edits return PNG-compatible b64 output by default.
    if output_format and not reference_images:
        request_options["output_format"] = output_format
    input_fidelity = str(image_config.get("input_fidelity") or "").strip().lower()
    # gpt-image-2 always processes image inputs at high fidelity; the API rejects
    # attempts to change input_fidelity for that model.
    if input_fidelity and not is_gpt_image_2:
        request_options["input_fidelity"] = input_fidelity

    async def _reserve(source: str) -> str:
        return await get_usage_meter().reserve_current_model_call_credit(
            model=model,
            billing_kind="image",
            billing_params=_image_credit_billing_params(
                image_size=image_size,
                quality=quality,
            ),
            metadata={"source": source},
        )

    async def _refund(reservation_id: str, source: str, error: str) -> None:
        try:
            await get_usage_meter().refund_model_call_credit_reservation(
                reservation_id,
                metadata={"source": source, "error": error[:200]},
            )
        except Exception:
            pass

    async def _confirm(
        reservation_id: str,
        *,
        provider_request_id: str = "",
        response_id: str = "",
    ) -> None:
        try:
            if not reservation_id:
                await get_usage_meter().mark_current_paid_execution_attempt(
                    status="completed",
                    provider_request_id=provider_request_id,
                    provider_response_id=response_id,
                )
                return
            await get_usage_meter().bump_model_call(
                user_id=None,
                model=model,
                provider_request_id=provider_request_id,
                credit_reservation_id=reservation_id,
                metadata={"response_id": response_id} if response_id else None,
            )
        except Exception:
            pass

    reservation_id = ""
    try:
        reservation_id = await _reserve("openai_image_api")

        client = AsyncOpenAI(api_key=api_key, timeout=300.0, max_retries=0)
        result = None
        for _attempt in range(4):
            try:
                if reference_images:
                    image_files = []
                    for idx, image_ref in enumerate(reference_images):
                        filename = f"reference_{idx + 1}.png"
                        mime_type = "image/png"
                        image_bytes: bytes
                        if isinstance(image_ref, tuple):
                            if len(image_ref) == 3:
                                filename, image_bytes, mime_type = image_ref
                            elif len(image_ref) == 2:
                                image_bytes, mime_type = image_ref
                                ext = "jpg" if mime_type == "image/jpeg" else "png"
                                filename = f"reference_{idx + 1}.{ext}"
                            else:
                                image_bytes = bytes(image_ref[0])
                        else:
                            image_bytes = bytes(image_ref)
                        image_files.append((filename, bytes(image_bytes), mime_type))
                    result = await client.images.edit(
                        model=model,
                        image=image_files,
                        prompt=prompt,
                        **request_options,
                    )
                else:
                    result = await client.images.generate(
                        model=model,
                        prompt=prompt,
                        **request_options,
                    )
                break
            except Exception as exc:
                detail = f"{type(exc).__name__}: {exc!r}"
                unknown_parameter = _extract_openai_unknown_parameter(detail)
                if unknown_parameter and unknown_parameter in request_options:
                    print(
                        f"[OpenAI Image] Parameter {unknown_parameter!r} is not accepted by the current endpoint, " "retrying after removing it"
                    )
                    request_options.pop(unknown_parameter, None)
                    continue
                transient_error = any(
                    token in detail
                    for token in (
                        "InternalServerError",
                        "APIConnectionError",
                        "APITimeoutError",
                        "server_error",
                        "Connection error",
                    )
                )
                if transient_error and _attempt < 3:
                    wait_seconds = 2**_attempt
                    print(
                        f"[OpenAI Image] Transient error, retrying in {wait_seconds}s "
                        f"({_attempt + 1}/4): {detail}"
                    )
                    await asyncio.sleep(wait_seconds)
                    continue
                raise

        if result is None:
            await _refund(reservation_id, "openai_image_api", "empty_response")
            return None, "", "OpenAI Image API returned no response"

        provider_request_id = str(getattr(result, "_request_id", "") or "").strip()
        response_id = str(getattr(result, "id", "") or "").strip()
        await _mark_paid_image_attempt_accepted(
            provider_request_id=provider_request_id,
            response_id=response_id,
        )
        if not result.data:
            await _refund(reservation_id, "openai_image_api", "missing_data")
            return None, "", "OpenAI Image API returned no data"

        image_item = result.data[0]
        image_base64 = getattr(image_item, "b64_json", None) or ""
        if not image_base64:
            await _refund(reservation_id, "openai_image_api", "missing_b64_json")
            return None, "", f"OpenAI Image API returned no b64_json: {image_item}"

        image_bytes = base64.b64decode(image_base64)
        await _confirm(
            reservation_id,
            provider_request_id=provider_request_id,
            response_id=response_id,
        )
        return image_bytes, "", ""
    except Exception as exc:
        await _refund(reservation_id, "openai_image_api", type(exc).__name__)
        if is_fatal_billing_error(exc):
            raise
        detail = f"{type(exc).__name__}: {exc!r}"
        print(f"[OpenAI Image] Request error: {detail}")
        return None, "", f"Request error: {detail}"


async def _call_newapi_image_api(
    *,
    api_key: str,
    model: str,
    prompt: str,
    reference_images: (
        list[bytes | tuple[bytes, str] | tuple[str, bytes, str]] | None
    ) = None,
    image_config: dict | None = None,
    base_url: str | None = None,
    trace: dict[str, str] | None = None,
    egress_context: TrustedEgressContext | None = None,
    delivery_path: str | Path | None = None,
    delivery_state: dict[str, bool | str] | None = None,
    before_delivery_copy: Callable[[], None] | None = None,
    read_copied_bytes: bool = True,
) -> tuple[bytes | None, str, str]:
    """Call newAPI's OpenAI-compatible Images API."""
    import httpx

    context = _validate_egress_context(egress_context)
    if not api_key:
        return None, "", "DramaClawAPI API key is missing"

    image_config = image_config or {}
    aspect_ratio = str(image_config.get("aspect_ratio") or "1:1").strip().lower() or "1:1"
    image_size = normalize_image_size(str(image_config.get("image_size") or "1K"), "newapi")
    request_schema = image_config.get("request_schema") or {}
    from novelvideo.media_model_request_schema import normalize_media_resolution_value

    resolution = normalize_media_resolution_value(image_size)

    metadata: dict[str, object] = {"resolution": resolution}
    payload: dict[str, object] = {
        "model": model,
        "prompt": prompt,
        "n": 1,
        "response_format": "url",
        "watermark": False,
        "metadata": metadata,
    }
    if aspect_ratio in {"auto", "adaptive"}:
        # Images use ``auto`` as the public follow-input ratio value. Keep
        # resolution independent and let NewAPI infer the geometry.
        metadata["ratio"] = "auto"
    else:
        # Fixed geometry keeps the selected ratio as semantic metadata while
        # width/height carry the pixel expectation. All three values come from
        # this same aspect-ratio/resolution pair.
        metadata["ratio"] = aspect_ratio
        try:
            size = resolve_openai_image_size(
                aspect_ratio,
                image_size,
                model,
                allow_dynamic_resolution=True,
                min_pixels=request_schema.get("minPixels"),
            )
        except ValueError as exc:
            return None, "", str(exc)
        width, height = (int(value) for value in size.split("x", 1))
        payload["width"] = width
        payload["height"] = height
    include_quality = bool(
        request_schema.get("includeQuality")
    ) or _newapi_image_model_supports_quality(model)
    if include_quality and str(image_config.get("quality") or "").strip():
        quality = str(image_config["quality"]).strip()
        payload["quality"] = quality
    else:
        quality = ""

    output_format = str(image_config.get("output_format") or "").strip().lower()
    if output_format:
        payload["output_format"] = output_format
    input_fidelity = str(image_config.get("input_fidelity") or "").strip().lower()
    if input_fidelity and reference_images:
        payload["input_fidelity"] = input_fidelity

    if reference_images:
        try:
            relay_helper = _relay_reference_images_for_newapi
            if relay_helper is _ORIGINAL_RELAY_REFERENCE_IMAGES_FOR_NEWAPI:
                payload["image"] = await relay_helper(
                    reference_images,
                    egress_context=context,
                )
            else:
                payload["image"] = await relay_helper(reference_images)
        except Exception as exc:
            if context is not None and context.is_organization:
                # The organization path hides `exc` because an arbitrary
                # exception may carry a signed URL or a key. The relay's own
                # three failures are secret-free by construction, though, and
                # they need three different fixes — a port registration, a
                # retry, an object-storage policy — so name which one fired
                # (OI-45). Anything else stays opaque.
                code = getattr(type(exc), "code", None)
                reason = getattr(exc, "reason", None)
                if not isinstance(code, str):
                    return None, "", "media relay upload failed"
                logger.warning(
                    "organization media relay failed: code=%s reason=%s "
                    "envelope=%s project=%s",
                    code,
                    reason or "-",
                    context.envelope_id,
                    context.project_id,
                )
                return None, "", f"media relay upload failed ({code})"
            return None, "", f"media relay upload failed: {exc}"
        request_path = "/images/edits"
    else:
        request_path = "/images/generations"

    from novelvideo.media_model_request_schema import (
        apply_media_request_schema,
        enforce_newapi_media_geometry_contract,
    )

    payload = apply_media_request_schema(
        payload,
        request_schema,
        image_config.get("model_params") or {},
    )
    payload = enforce_newapi_media_geometry_contract(payload, media_type="image")

    if base_url:
        endpoint = base_url.rstrip("/")
    else:
        from novelvideo.config import get_effective_newapi_gateway_config

        endpoint = get_effective_newapi_gateway_config().base_url.rstrip("/")
    request_context = _newapi_safe_request_context(
        endpoint=endpoint,
        request_path=request_path,
        model=model,
        payload=payload,
        prompt=prompt,
    )
    logger.info("DramaClawAPI image request: %s", request_context)
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    async def _reserve(source: str) -> str:
        return await get_usage_meter().reserve_current_model_call_credit(
            model=model,
            billing_kind="image",
            billing_params=_image_credit_billing_params(
                image_size=image_size,
                quality=quality,
            ),
            metadata={"source": source},
        )

    async def _refund(
        reservation_id: str,
        source: str,
        error: str,
        *,
        request_id: str = "",
        http_status: int | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        try:
            metadata: dict[str, object] = {"source": source, "error": error[:200]}
            if request_id:
                metadata["request_id"] = request_id
            if http_status is not None:
                metadata["http_status"] = http_status
            if headers:
                metadata["response_headers"] = headers
            await get_usage_meter().refund_model_call_credit_reservation(
                reservation_id,
                metadata=metadata,
            )
        except Exception:
            pass

    async def _confirm(
        reservation_id: str,
        *,
        provider_request_id: str = "",
        response_id: str = "",
    ) -> None:
        try:
            if not reservation_id:
                await get_usage_meter().mark_current_paid_execution_attempt(
                    status="completed",
                    provider_request_id=provider_request_id,
                    provider_response_id=response_id,
                )
                return
            await get_usage_meter().bump_model_call(
                user_id=None,
                model=model,
                provider_request_id=provider_request_id,
                credit_reservation_id=reservation_id,
                metadata={"response_id": response_id} if response_id else None,
            )
        except Exception:
            pass

    def _record_trace(
        *,
        provider_request_id: str = "",
        response_id: str = "",
    ) -> None:
        if trace is None:
            return
        if provider_request_id:
            trace["request_id"] = provider_request_id
        if response_id:
            trace["response_id"] = response_id

    reservation_id = ""
    provider_request_id = ""
    try:
        reservation_id = await _reserve("newapi_image_api")
        await update_current_model_call_log(
            request_payload=payload,
        )

        async with httpx.AsyncClient(
            timeout=NEWAPI_IMAGE_HTTP_TIMEOUT_SECONDS,
            follow_redirects=True,
        ) as client:
            logger.info("DramaClawAPI image POST start: %s", request_context.get("endpoint"))
            response = await client.post(
                f"{endpoint}{request_path}",
                headers=headers,
                json=payload,
            )
            logger.info(
                "DramaClawAPI image POST response: status=%s bytes=%s",
                getattr(response, "status_code", "?"),
                (getattr(response, "headers", None) or {}).get("content-length", "?"),
            )
            response.raise_for_status()
            response_headers = getattr(response, "headers", {}) or {}
            provider_request_id = _newapi_request_id_from_headers(response_headers)
            result = response.json()
            await update_current_model_call_log(
                response_payload=result,
            )
            logger.info(
                "DramaClawAPI image POST parsed: data_count=%d keys=%s",
                len(result.get("data") or []),
                sorted(result.keys())[:5],
            )
            provider_request_id = (
                provider_request_id
                or str(result.get("request_id") or result.get("requestId") or "").strip()
            )
            response_id = str(result.get("id") or "").strip()
            _record_trace(provider_request_id=provider_request_id, response_id=response_id)
            await _mark_paid_image_attempt_accepted(
                provider_request_id=provider_request_id,
                response_id=response_id,
            )

            data = result.get("data") or []
            if not data:
                await _refund(
                    reservation_id,
                    "newapi_image_api",
                    "missing_data",
                    request_id=provider_request_id,
                )
                return None, "", f"DramaClawAPI Images response missing data: {sorted(result.keys())}"

            first = data[0] or {}
            if delivery_path is not None:
                from novelvideo.media_archive_copy import copy_archived_result

                if await copy_archived_result(
                    first.get("archive"), delivery_path, before_copy=before_delivery_copy
                ):
                    await _confirm(
                        reservation_id,
                        provider_request_id=provider_request_id,
                        response_id=response_id,
                    )
                    if not read_copied_bytes:
                        if delivery_state is not None:
                            delivery_state["copied"] = True
                            delivery_state["sha256"] = str(
                                first["archive"].get("sha256") or ""
                            )
                        return None, "", ""
                    image_bytes = Path(delivery_path).read_bytes()
                    if delivery_state is not None:
                        delivery_state["copied"] = True
                    return image_bytes, "", ""
            image_b64 = first.get("b64_json") or ""
            if image_b64:
                image_bytes = base64.b64decode(image_b64)
                await _confirm(
                    reservation_id,
                    provider_request_id=provider_request_id,
                    response_id=response_id,
                )
                return image_bytes, "", ""

            image_url = first.get("url") or first.get("image_url") or ""
            if image_url.startswith("data:image"):
                _, b64_data = image_url.split(",", 1)
                image_bytes = base64.b64decode(b64_data)
                await _confirm(
                    reservation_id,
                    provider_request_id=provider_request_id,
                    response_id=response_id,
                )
                return image_bytes, "", ""
            if image_url:
                # When NewAPI returns a URL instead of b64, a second GET is needed to fetch the image. This await is a common
                # "newapi has generated but the task is still awaiting" hang point -- use a separate short timeout
                # (60s) to avoid falling into the outer client's 600s global timeout and hanging for a long time.
                # Add phase logs so a hang can be located.
                logger.info("DramaClawAPI image GET url start: %s", image_url[:120])
                async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as fetch:
                    image_response = await fetch.get(image_url)
                logger.info(
                    "DramaClawAPI image GET url done: status=%d bytes=%d",
                    image_response.status_code,
                    len(image_response.content),
                )
                image_response.raise_for_status()
                image_bytes = image_response.content
                await _confirm(
                    reservation_id,
                    provider_request_id=provider_request_id,
                    response_id=response_id,
                )
                return image_bytes, "", ""

            await _refund(
                reservation_id,
                "newapi_image_api",
                "missing_image_payload",
                request_id=provider_request_id,
            )
            return None, "", f"DramaClawAPI Images response missing b64_json/url: {first}"
    except httpx.HTTPStatusError as exc:
        body = (exc.response.text or "")[:2000]
        response_headers = getattr(exc.response, "headers", {}) or {}
        safe_headers = _newapi_safe_header_summary(response_headers)
        request_id = _newapi_request_id_from_headers(response_headers) or provider_request_id
        await update_current_model_call_log(
            response_payload={
                "status_code": exc.response.status_code,
                "headers": safe_headers,
                "body": body,
            },
            error_message=f"HTTP {exc.response.status_code}",
        )
        if is_definite_no_cost_http_rejection(exc.response.status_code):
            try:
                await get_usage_meter().mark_current_paid_execution_attempt(
                    status="rejected_no_cost",
                    provider_request_id=request_id,
                    metadata={
                        "source": "newapi_image_api",
                        "http_status": exc.response.status_code,
                        "error": "provider_request_rejected",
                    },
                )
            except Exception:
                pass
        await _refund(
            reservation_id,
            "newapi_image_api",
            f"HTTP {exc.response.status_code}",
            request_id=request_id,
            http_status=exc.response.status_code,
            headers=safe_headers,
        )
        error_context = _newapi_context_for_error(request_context)
        header_context = (
            f"request_id={request_id}; headers={safe_headers}; "
            if request_id or safe_headers
            else ""
        )
        logger.warning(
            "DramaClawAPI image failed: status=%s; %s%s; body=%s",
            exc.response.status_code,
            header_context,
            error_context,
            body,
        )
        return (
            None,
            "",
            f"HTTP {exc.response.status_code}: {header_context}{error_context}; body={body}",
        )
    except Exception as exc:
        await update_current_model_call_log(
            error_message=type(exc).__name__,
        )
        await _refund(
            reservation_id,
            "newapi_image_api",
            type(exc).__name__,
            request_id=provider_request_id,
        )
        if is_fatal_billing_error(exc):
            raise
        error_context = _newapi_context_for_error(request_context)
        detail = f"{type(exc).__name__}: {exc!r}; {error_context}"
        logger.warning("DramaClawAPI image request exception: %s", detail)
        return None, "", f"Request error: {detail}"


def _reference_image_bytes(
    image_ref: bytes | tuple[bytes, str] | tuple[str, bytes, str],
) -> bytes:
    """Unpack the three reference-image shapes the newAPI path accepts."""
    if isinstance(image_ref, tuple):
        if len(image_ref) == 3:
            return bytes(image_ref[1])
        if len(image_ref) == 2:
            return bytes(image_ref[0])
        return bytes(image_ref[0])
    return bytes(image_ref)


async def _call_newapi_image_api_with_egress(
    *,
    capability: str,
    api_key: str,
    model: str,
    prompt: str,
    reference_images: (
        list[bytes | tuple[bytes, str] | tuple[str, bytes, str]] | None
    ) = None,
    image_config: dict | None = None,
    base_url: str | None = None,
    egress_context: TrustedEgressContext | None = None,
    delivery_path: str | Path | None = None,
    delivery_state: dict[str, bool | str] | None = None,
    read_copied_bytes: bool = True,
) -> tuple[bytes | None, str, str]:
    """Egress gate for the grid family (OI-52): wraps the leaf with the shape already verified by `_generate_image`.

    The gate is installed at the **call site** rather than inside the leaf, because the leaf cannot recover `capability`, the
    `image_size` before normalization, the `quality` before fallback, nor obtain the result reference; and `_generate_image`
    and `scene_reference_images.py` already claim above the leaf, and claiming again inside the leaf would collide as
    `EGRESS_OPERATION_CONFLICT` with the same key but a different digest.

    Non-organization identities pass through byte for byte: the leaf receives arguments identical to those without this wrapper,
    so the direct calls in `tests/test_newapi_image_gateway.py` are unaffected.
    """

    context = _validate_egress_context(egress_context)
    if context is None:
        context = ambient_organization_egress_context()
    if context is None or not context.is_organization:
        return await _call_newapi_image_api(
            api_key=api_key,
            model=model,
            prompt=prompt,
            reference_images=reference_images,
            image_config=image_config,
            base_url=base_url,
            delivery_path=delivery_path,
            delivery_state=delivery_state,
            read_copied_bytes=read_copied_bytes,
        )

    from novelvideo.model_gateway_runtime import next_model_gateway_business_task_id

    config = image_config or {}
    request = {
        "model": model,
        "prompt": prompt,
        "reference_sha256": [
            hashlib.sha256(_reference_image_bytes(item)).hexdigest()
            for item in (reference_images or [])
        ],
        "aspect_ratio": str(config.get("aspect_ratio") or ""),
        "image_size": str(config.get("image_size") or ""),
        "quality": str(config.get("quality") or ""),
    }
    # One envelope can contain several image operations with the same capability (`_render_single_panel_gemini`
    # fans out N paths with asyncio.gather); using `envelope_id` as business_task_id would squash them into the same
    # operation key. This helper carries an in-request sequence number and is reproducible when the envelope is redelivered.
    state = await _prepare_organization_image_egress(
        egress_context=context,
        provider="newapi",
        capability=capability,
        request=request,
        business_task_id=next_model_gateway_business_task_id(
            capability,
            request_digest=canonical_request_digest(request),
        ),
    )
    if state is None:
        raise EgressError("ORG_EGRESS_DENIED")

    async def _mark_unknown() -> None:
        await state.operation_port.mark_unknown(
            operation_id=state.claim.operation.operation_id,
            transition_token=state.claim.transition_token,
            expected_version=state.claim.operation.version,
        )

    trace: dict[str, str] = {}
    try:
        image_bytes, text, error = await _call_newapi_image_api(
            api_key=state.credential.api_key,
            model=model,
            prompt=prompt,
            reference_images=reference_images,
            image_config=image_config,
            base_url=state.credential.base_url,
            trace=trace,
            egress_context=context,
            delivery_path=delivery_path,
            delivery_state=delivery_state,
            read_copied_bytes=read_copied_bytes,
        )
    except Exception:
        await _mark_unknown()
        raise
    if not image_bytes and not (delivery_state and delivery_state.get("copied")):
        # The leaf squashes transport failures into `(None, "", error)`; the operation did go out but there is no usable result,
        # so it can only be recorded as unknown -- it cannot be treated as never having happened, or a retry would claim again with the same key.
        await _mark_unknown()
        return image_bytes, text, error
    digest = (
        hashlib.sha256(image_bytes).hexdigest()
        if image_bytes
        else str(delivery_state.get("sha256") or "")
    )
    if len(digest) != 64 or any(
        char not in "0123456789abcdef" for char in digest.lower()
    ):
        with Path(delivery_path).open("rb") as copied_file:
            digest = hashlib.file_digest(copied_file, "sha256").hexdigest()
    await _complete_organization_image_egress(
        state,
        trace=trace,
        result_ref=f"image:sha256:{digest}",
    )
    return image_bytes, text, error


async def _relay_reference_images_for_newapi(
    reference_images: list[bytes | tuple[bytes, str] | tuple[str, bytes, str]],
    *,
    egress_context: TrustedEgressContext | None = None,
) -> list[str]:
    """Upload reference image bytes to OSS relay for URL-only upstream channels."""

    context = _validate_egress_context(egress_context)

    def _image_ext(image_ref) -> str:
        if isinstance(image_ref, tuple):
            if len(image_ref) == 3:
                filename = str(image_ref[0] or "")
                mime_type = str(image_ref[2] or "")
                suffix = Path(filename).suffix.lstrip(".")
                if suffix:
                    return suffix
                if mime_type.startswith("image/"):
                    return mime_type.split("/", 1)[1]
            if len(image_ref) == 2:
                hint = str(image_ref[1] or "")
                if hint.startswith("image/"):
                    return hint.split("/", 1)[1]
                suffix = Path(hint).suffix.lstrip(".")
                if suffix:
                    return suffix
        return "png"

    if context is not None and context.is_organization:
        urls: list[str] = []
        for index, image_ref in enumerate(reference_images):
            data = _reference_image_bytes(image_ref)
            content_digest = hashlib.sha256(data).hexdigest()
            object_id = (
                f"{context.envelope_id}:{context.project_id}:{index}:{content_digest}"
            )
            urls.append(
                await relay_tenant_image_bytes_from_context(
                    data,
                    object_id=object_id,
                    context=context,
                    ext=_image_ext(image_ref),
                    ttl=NEWAPI_MEDIA_INPUT_MIN_TTL_SECONDS,
                )
            )
        return urls

    def upload_all() -> list[str]:
        urls: list[str] = []
        relay_ttl = media_relay_ttl_seconds(
            minimum=NEWAPI_MEDIA_INPUT_MIN_TTL_SECONDS,
        )
        for image_ref in reference_images:
            urls.append(
                upload_image_bytes(
                    _reference_image_bytes(image_ref),
                    ext=_image_ext(image_ref),
                    ttl=relay_ttl,
                    image_transform=IMAGE_TRANSFORM_AI_REFERENCE_JPEG,
                )
            )
        return urls

    return await asyncio.to_thread(upload_all)


_ORIGINAL_RELAY_REFERENCE_IMAGES_FOR_NEWAPI = _relay_reference_images_for_newapi


def _download_webai_artifact(url: str, cookie_file: str) -> tuple[bytes | None, str]:
    """Download a Gemini WebAI-generated image using its Playwright session cookies.

    The artifact URL (from `/chat/completions` → `choices[].artifacts[].url`) is a
    private googleusercontent link gated by the same Google account session the
    WebAI server's browser is logged into — a bare request without those cookies
    gets HTTP 403. `=s0` requests the original resolution instead of Google's
    default 512px thumbnail (same trick as comfy-trends' gemini_client.py).
    """
    import http.cookiejar
    import urllib.request

    try:
        raw = json.loads(Path(cookie_file).expanduser().read_text())
    except OSError as exc:
        return None, f"cannot read GEMINI_WEBAI_COOKIE_FILE: {exc}"
    except ValueError as exc:
        return None, f"GEMINI_WEBAI_COOKIE_FILE is not valid JSON: {exc}"

    jar = http.cookiejar.CookieJar()
    for cookie in raw.get("cookies", []):
        expires = cookie.get("expires", -1)
        jar.set_cookie(
            http.cookiejar.Cookie(
                0,
                cookie["name"],
                cookie["value"],
                None,
                False,
                cookie["domain"],
                True,
                cookie["domain"].startswith("."),
                cookie.get("path", "/"),
                True,
                bool(cookie.get("secure")),
                None if expires is None or expires <= 0 else int(expires),
                False,
                None,
                None,
                {},
            )
        )

    last_segment = url.rsplit("/", 1)[-1]
    full_res_url = url.split("=")[0] + "=s0" if "=s" not in last_segment else url
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    try:
        with opener.open(
            urllib.request.Request(full_res_url, headers={"User-Agent": "Mozilla/5.0"}),
            timeout=180,
        ) as resp:
            data = resp.read()
    except Exception as exc:
        return None, f"failed to download webai image artifact: {exc}"

    if not data.startswith((b"\x89PNG", b"\xff\xd8")):
        return None, "downloaded artifact is not a valid image (cookie expired?)"
    from novelvideo.llm_call_log import record_artifact

    record_artifact("image", data=data, label="gemini_webai", source_url=url)
    return data, ""


def _webai_ref_filename(index: int, mime: str) -> str:
    """Build a reference-image filename whose extension matches its MIME type.

    WebAI-to-API (port 6969) validates that the filename extension matches the
    declared MIME type and returns HTTP 400 ("File extension '.png' is not
    allowed for MIME type 'image/jpeg'") on a mismatch — so the extension must
    be derived from `mime`, never hardcoded.
    """
    ext = mimetypes.guess_extension(mime or "") or ".png"
    return f"ref_{index}{ext}"


async def _call_webai_chat_image_api(
    *,
    api_key: str,
    model: str,
    prompt: str,
    reference_images: list[tuple[str, bytes, str]] | None = None,
    image_config: dict | None = None,
    base_url: str | None = None,
    cookie_file: str = "",
) -> tuple[bytes | None, str, str]:
    """Generate an image via a local WebAI-to-API Gemini bridge (dev-only).

    Unlike `_call_newapi_image_api`, this upstream has no OpenAI Images API — it
    only exposes `/chat/completions`, returning the generated image as a
    Google-hosted URL in `choices[0].artifacts`. That URL is session-gated, so it
    is fetched with the same Playwright storage-state cookies the WebAI server's
    own browser is logged in with (see `_download_webai_artifact`).
    """
    import httpx

    from novelvideo.config import GEMINI_WEBAI_COOKIE_FILE, GEMINI_WEBAI_TIMEOUT_SECONDS

    if not api_key:
        return None, "", "DramaClawAPI API key is missing"
    cookie_file = cookie_file or GEMINI_WEBAI_COOKIE_FILE
    if not cookie_file:
        return None, "", "GEMINI_WEBAI_COOKIE_FILE is not configured"

    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    for name, data, mime in reference_images or []:
        encoded = base64.b64encode(data).decode()
        content.append(
            {
                "type": "file",
                "file": {
                    "filename": name or "reference.png",
                    "file_data": f"data:{mime or 'image/png'};base64,{encoded}",
                },
            }
        )

    if base_url:
        endpoint = base_url.rstrip("/")
    else:
        from novelvideo.config import get_effective_newapi_gateway_config

        endpoint = get_effective_newapi_gateway_config().base_url.rstrip("/")

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {"model": model, "messages": [{"role": "user", "content": content}]}

    try:
        async with httpx.AsyncClient(timeout=GEMINI_WEBAI_TIMEOUT_SECONDS) as client:
            response = await client.post(
                f"{endpoint}/chat/completions", headers=headers, json=payload
            )
    except httpx.HTTPError as exc:
        return None, "", f"webai chat request failed: {exc}"

    if response.status_code >= 400:
        return None, "", f"webai chat HTTP {response.status_code}: {response.text[:500]}"

    try:
        data = response.json()
    except ValueError:
        return None, "", "webai chat returned non-JSON response"

    choices = data.get("choices") or []
    first_choice = choices[0] if choices else {}
    artifacts = first_choice.get("artifacts") or []
    image_url = next(
        (a.get("url") for a in artifacts if a.get("type") == "image" and a.get("url")),
        None,
    )
    if not image_url:
        text = (first_choice.get("message") or {}).get("content") or ""
        return None, text, "webai chat response had no image artifact"

    image_bytes, download_error = await asyncio.to_thread(
        _download_webai_artifact, image_url, cookie_file
    )
    if image_bytes is None:
        return None, "", download_error
    return image_bytes, "", ""


# Gemini's image_config.aspect_ratio only accepts this fixed enum (400
# INVALID_ARGUMENT otherwise) — e.g. equirectangular panoramas ask for "2:1",
# which isn't in it. Values are width/height floats for nearest-match lookup.
_GEMINI_SUPPORTED_ASPECT_RATIOS: dict[str, float] = {
    "1:1": 1.0,
    "1:4": 0.25,
    "1:8": 0.125,
    "2:3": 2 / 3,
    "3:2": 1.5,
    "3:4": 0.75,
    "4:1": 4.0,
    "4:3": 4 / 3,
    "4:5": 0.8,
    "5:4": 1.25,
    "8:1": 8.0,
    "9:16": 9 / 16,
    "16:9": 16 / 9,
    "21:9": 21 / 9,
}


def _nearest_gemini_aspect_ratio(aspect_ratio: str) -> str:
    try:
        w, h = aspect_ratio.split(":", 1)
        target = float(w) / float(h)
    except (ValueError, ZeroDivisionError):
        return "1:1"
    return min(
        _GEMINI_SUPPORTED_ASPECT_RATIOS,
        key=lambda key: abs(_GEMINI_SUPPORTED_ASPECT_RATIOS[key] - target),
    )


def _reshape_image_bytes_to_aspect_ratio(
    data: bytes, aspect_ratio: str
) -> bytes:
    """Stretch-resize to an exact aspect ratio Gemini can't generate natively.

    Stretches rather than crops: cropping would cut real content off the
    edges of an equirectangular panorama, which needs full 360 coverage.
    """
    from io import BytesIO

    from PIL import Image

    try:
        w, h = aspect_ratio.split(":", 1)
        target = float(w) / float(h)
    except (ValueError, ZeroDivisionError):
        return data

    with Image.open(BytesIO(data)) as im:
        current = im.width / im.height
        if abs(current - target) < 1e-3:
            return data
        if target >= current:
            new_width = im.width
            new_height = round(new_width / target)
        else:
            new_height = im.height
            new_width = round(new_height * target)
        resized = im.resize((new_width, new_height), Image.LANCZOS)
        buffer = BytesIO()
        resized.save(buffer, format=im.format or "PNG")
        return buffer.getvalue()


async def _call_google_genai_image_api(
    *,
    api_key: str,
    model: str,
    prompt: str,
    reference_images: list[tuple[str, bytes, str]] | None = None,
    image_config: dict | None = None,
) -> tuple[bytes | None, str, str]:
    """Generate an image via the native Google AI Studio API (google-genai SDK).

    Shared by the asset generators (scene/prop/360) that only build a single
    text+reference request, unlike the grid/character generators which have
    their own inline "google" branches with richer prompt assembly.
    """
    if not api_key:
        return None, "", "GOOGLE_AI_API_KEY is missing"

    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)

    contents: list[Any] = [prompt]
    for _name, data, mime in reference_images or []:
        try:
            contents.append(
                types.Part.from_bytes(data=data, mime_type=mime or "image/png")
            )
        except Exception as exc:
            return None, "", f"google reference image encode failed: {exc}"

    cfg = image_config or {}
    requested_aspect_ratio = cfg.get("aspect_ratio") or "1:1"
    needs_reshape = requested_aspect_ratio not in _GEMINI_SUPPORTED_ASPECT_RATIOS
    gen_aspect_ratio = (
        _nearest_gemini_aspect_ratio(requested_aspect_ratio)
        if needs_reshape
        else requested_aspect_ratio
    )
    is_gemini3 = "gemini-3" in model
    requested_image_size = cfg.get("image_size") or "1K"

    def _build_config(image_size: str | None) -> Any:
        if is_gemini3:
            image_config_kwargs: dict[str, str] = {"aspect_ratio": gen_aspect_ratio}
            if image_size:
                image_config_kwargs["image_size"] = image_size
            gen_image_config = types.ImageConfig(**image_config_kwargs)
        else:
            gen_image_config = types.ImageConfig(aspect_ratio=gen_aspect_ratio)
        return types.GenerateContentConfig(
            response_modalities=["IMAGE", "TEXT"],
            image_config=gen_image_config,
        )

    async def _generate(image_size: str | None):
        return await asyncio.to_thread(
            client.models.generate_content,
            model=model,
            contents=contents,
            config=_build_config(image_size),
        )

    try:
        response = await _generate(requested_image_size)
    except Exception as exc:
        # Some tiers (e.g. gemini-3.1-flash-lite-image) only support 1K and
        # reject 2K/4K with 400 INVALID_ARGUMENT — fall back once.
        if is_gemini3 and "is not supported for this model" in str(exc):
            try:
                response = await _generate("1K")
            except Exception as retry_exc:
                return None, "", f"google genai request failed: {retry_exc}"
        else:
            return None, "", f"google genai request failed: {exc}"

    if not response.candidates or not response.candidates[0].content:
        return None, "", "google genai response had no content"

    image_bytes = None
    text = ""
    for part in response.candidates[0].content.parts:
        if getattr(part, "inline_data", None) is not None:
            image_bytes = part.inline_data.data
        elif getattr(part, "text", None):
            text = part.text
    if not image_bytes:
        return None, text, "google genai response had no image data"

    if needs_reshape:
        try:
            image_bytes = _reshape_image_bytes_to_aspect_ratio(
                image_bytes, requested_aspect_ratio
            )
        except Exception as exc:
            return None, text, f"google genai aspect-ratio reshape failed: {exc}"

    return image_bytes, text, ""


# DashScope's native Qwen-Image API has no 1K/2K/4K enum — just a pixel-area
# range the account is allowed: verified empirically (2026-10-13) as
# [email protected] to [email protected] ("Image area must be between 262144
# (512x512) and 4194304 (2048x2048) pixels"). There's no true "4K" tier, so
# both "2K" and "4K" map to the same max area.
_QWEN_IMAGE_SIZE_TARGET_AREA: dict[str, int] = {
    "0.5K": 512 * 512,
    "1K": 1024 * 1024,
    "2K": 2048 * 2048,
    "4K": 2048 * 2048,
}
_QWEN_IMAGE_MIN_AREA = 512 * 512
_QWEN_IMAGE_MAX_AREA = 2048 * 2048


def _qwen_image_size(aspect_ratio: str, image_size: str) -> str:
    """Map an aspect ratio + size label to DashScope's "W*H" size string."""
    try:
        w_ratio, h_ratio = (aspect_ratio or "1:1").split(":", 1)
        ratio = float(w_ratio) / float(h_ratio)
    except (ValueError, ZeroDivisionError):
        ratio = 1.0
    area = _QWEN_IMAGE_SIZE_TARGET_AREA.get(image_size or "1K", _QWEN_IMAGE_SIZE_TARGET_AREA["1K"])
    area = max(_QWEN_IMAGE_MIN_AREA, min(_QWEN_IMAGE_MAX_AREA, area))
    width = max(1, round((area * ratio) ** 0.5))
    height = max(1, round((area / ratio) ** 0.5))
    # Rounding both dimensions independently can push the actual area just
    # under the min bound (e.g. a 3:4 1K request landed at 591*443=261813,
    # just below the 262144 floor and rejected with 400 INVALID_ARGUMENT) or
    # just over the max bound — nudge one dimension back into range.
    while width * height < _QWEN_IMAGE_MIN_AREA:
        height += 1
    while width * height > _QWEN_IMAGE_MAX_AREA and height > 1:
        height -= 1
    return f"{width}*{height}"


async def _call_qwen_image_api(
    *,
    api_key: str,
    model: str,
    prompt: str,
    reference_images: list[tuple[str, bytes, str]] | None = None,
    image_config: dict | None = None,
    base_url: str | None = None,
) -> tuple[bytes | None, str, str]:
    """Generate an image via DashScope's native Qwen-Image API (dev-only).

    Image generation has no OpenAI-compatible endpoint on DashScope (unlike
    the `DC-qwen-vision` text/vision channel) — only the native
    `multimodal-generation/generation` endpoint. Reference images are sent
    edit-style, as extra `image` entries in the same `content` array as the
    text prompt; the result comes back as a short-lived OSS URL (no
    session/cookie gate, unlike `_call_webai_chat_image_api`) that is
    downloaded directly.
    """
    import httpx

    from novelvideo.config import QWEN_IMAGE_BASE_URL, QWEN_IMAGE_TIMEOUT_SECONDS

    if not api_key:
        return None, "", "QWEN_API_KEY is missing"

    endpoint = (base_url or QWEN_IMAGE_BASE_URL).rstrip("/")

    content: list[dict[str, Any]] = []
    for _name, data, mime in reference_images or []:
        encoded = base64.b64encode(data).decode()
        content.append({"image": f"data:{mime or 'image/png'};base64,{encoded}"})
    content.append({"text": prompt})

    cfg = image_config or {}
    size = _qwen_image_size(cfg.get("aspect_ratio") or "1:1", cfg.get("image_size") or "1K")
    payload = {
        "model": model,
        "input": {"messages": [{"role": "user", "content": content}]},
        "parameters": {
            "size": size,
            "n": 1,
            "watermark": False,
            "prompt_extend": False,
        },
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    try:
        async with httpx.AsyncClient(timeout=QWEN_IMAGE_TIMEOUT_SECONDS) as client:
            response = await client.post(
                f"{endpoint}/services/aigc/multimodal-generation/generation",
                headers=headers,
                json=payload,
            )
    except httpx.HTTPError as exc:
        return None, "", f"qwen image request failed: {exc}"

    if response.status_code >= 400:
        return None, "", f"qwen image HTTP {response.status_code}: {response.text[:500]}"

    try:
        data = response.json()
    except ValueError:
        return None, "", "qwen image returned non-JSON response"

    if data.get("code"):
        return None, "", f"qwen image error {data['code']}: {data.get('message', '')}"

    choices = (data.get("output") or {}).get("choices") or []
    first_choice = choices[0] if choices else {}
    message_content = (first_choice.get("message") or {}).get("content") or []
    image_url = next(
        (item.get("image") for item in message_content if item.get("image")), None
    )
    if not image_url:
        text = next((item.get("text") for item in message_content if item.get("text")), "")
        return None, text, "qwen image response had no image URL"

    try:
        async with httpx.AsyncClient(timeout=QWEN_IMAGE_TIMEOUT_SECONDS) as client:
            download_response = await client.get(image_url)
            download_response.raise_for_status()
    except httpx.HTTPError as exc:
        return None, "", f"qwen image download failed: {exc}"

    return download_response.content, "", ""


# Dev-only: RunPod Serverless worker from the `photoreal-short-drama-generator`
# project (ComfyUI + Qwen-Image 2.1, UNETLoader-loaded int8_convrot checkpoint —
# a different Qwen image stack from the DashScope one above, with its own
# worker and R2 transport). "K" labels follow the same convention already
# established for Google Gemini in this app (1K≈1MP, 2K≈4MP, 4K≈16MP — see
# CLAUDE.md's measured 1376×768/2752×1536/5504×3072), with 0.5K/1.5K/3K
# interpolated; 1.5K is pinned to 1920×1088 (16:9), the resolution the
# photoreal project actually runs this worker at day to day.
_RUNPOD_QWEN_IMAGE_SIZE_TARGET_AREA: dict[str, int] = {
    "0.5K": 512 * 512,
    "1K": 1024 * 1024,
    "1.5K": 1920 * 1088,
    "2K": 2048 * 2048,
    "3K": 3072 * 3072,
    "4K": 4096 * 4096,
}
# Worker VRAM (A40 48GB / A-series 24GB pool) hasn't been measured past 2K for
# this model yet — 3K/4K are provisional until verified (see CLAUDE.md note to
# add once tested); keep a generous but finite ceiling so a bad aspect ratio
# can't request an unbounded latent.
_RUNPOD_QWEN_IMAGE_MIN_AREA = 256 * 256
_RUNPOD_QWEN_IMAGE_MAX_AREA = 4096 * 4096


def _runpod_qwen_image_dims(aspect_ratio: str, image_size: str) -> tuple[int, int]:
    """Map an aspect ratio + size label to ComfyUI EmptyLatentImage width/height.

    Unlike DashScope's "W*H" string, ComfyUI's graph takes explicit integer
    width/height — and prefers multiples of 16 for clean VAE tiling.
    """
    try:
        w_ratio, h_ratio = (aspect_ratio or "1:1").split(":", 1)
        ratio = float(w_ratio) / float(h_ratio)
    except (ValueError, ZeroDivisionError):
        ratio = 1.0
    area = _RUNPOD_QWEN_IMAGE_SIZE_TARGET_AREA.get(
        image_size or "1K", _RUNPOD_QWEN_IMAGE_SIZE_TARGET_AREA["1K"]
    )
    area = max(_RUNPOD_QWEN_IMAGE_MIN_AREA, min(_RUNPOD_QWEN_IMAGE_MAX_AREA, area))
    width = max(16, round(((area * ratio) ** 0.5) / 16) * 16)
    height = max(16, round(((area / ratio) ** 0.5) / 16) * 16)
    return width, height


def _runpod_qwen_image_graph(
    prompt: str,
    width: int,
    height: int,
    seed: int,
    reference_images: list[tuple[str, bytes, str]],
) -> tuple[dict, list[tuple[str, bytes, str]]]:
    """Build the ComfyUI API graph for the RunPod Qwen-Image 2.1 worker.

    Ported from `comfy.qwen_t2i`/`comfy.qwen_edit` in the
    `photoreal-short-drama-generator` project's `scripts/comfy.py` — same
    UNETLoader-loaded int8_convrot checkpoint, same euler/simple/cfg-1
    sampler settings. Returns (graph, reference_images) — the LoadImage node
    names are already baked into the graph, matching the names the RunPod
    job's `inputs` list must upload under.
    """
    from novelvideo.config import (
        RUNPOD_QWEN_IMAGE_TEXT_ENCODER,
        RUNPOD_QWEN_IMAGE_UNET,
        RUNPOD_QWEN_IMAGE_VAE,
    )

    graph: dict[str, Any] = {
        "1": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": RUNPOD_QWEN_IMAGE_UNET, "weight_dtype": "default"},
        },
        "2": {
            "class_type": "CLIPLoader",
            "inputs": {
                "clip_name": RUNPOD_QWEN_IMAGE_TEXT_ENCODER,
                "type": "qwen_image",
                "device": "default",
            },
        },
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": RUNPOD_QWEN_IMAGE_VAE}},
    }
    if reference_images:
        graph["9"] = {
            "class_type": "QwenImage21Cache",
            "inputs": {"model": ["1", 0], "device": "auto", "dtype": "default"},
        }
        graph["4"] = {
            "class_type": "TextEncodeQwenImage21",
            "inputs": {
                "clip": ["2", 0],
                "vae": ["3", 0],
                "prompt": prompt,
                "negative_prompt": "",
                "resolution": 0,
            },
        }
        for k, (name, _data, _mime) in enumerate(reference_images):
            graph[str(100 + k)] = {"class_type": "LoadImage", "inputs": {"image": name}}
            graph["4"]["inputs"][f"images.image_{k + 1}"] = [str(100 + k), 0]
        graph["5"] = {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": width, "height": height, "batch_size": 1},
        }
        graph["6"] = {
            "class_type": "KSampler",
            "inputs": {
                "model": ["9", 0],
                "seed": seed,
                "steps": 25,
                "cfg": 1.0,
                "sampler_name": "euler",
                "scheduler": "simple",
                "positive": ["4", 0],
                "negative": ["4", 1],
                "latent_image": ["5", 0],
                "denoise": 1.0,
            },
        }
    else:
        graph["4"] = {
            "class_type": "TextEncodeQwenImage21",
            "inputs": {
                "clip": ["2", 0],
                "prompt": prompt,
                "negative_prompt": "",
                "resolution": 1024,
            },
        }
        graph["5"] = {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": width, "height": height, "batch_size": 1},
        }
        graph["6"] = {
            "class_type": "KSampler",
            "inputs": {
                "model": ["1", 0],
                "seed": seed,
                "steps": 25,
                "cfg": 1.0,
                "sampler_name": "euler",
                "scheduler": "simple",
                "positive": ["4", 0],
                "negative": ["4", 1],
                "latent_image": ["5", 0],
                "denoise": 1.0,
            },
        }
    graph["7"] = {"class_type": "VAEDecode", "inputs": {"samples": ["6", 0], "vae": ["3", 0]}}
    graph["8"] = {
        "class_type": "SaveImage",
        "inputs": {"images": ["7", 0], "filename_prefix": "dramaclaw"},
    }
    # No SageAttention disable-patch here anymore: this graph now runs on a
    # dedicated Qwen-only endpoint (split 2026-10-19, see config.py) whose
    # worker image has no ComfyUI-KJNodes installed. Sending a
    # PathchSageAttentionKJ node to a worker that doesn't have that pack would
    # 400 as an unknown node class — SageAttention is now H3-endpoint-only,
    # see runpod_minimax_h3_video.py.
    return graph, reference_images


def _runpod_r2_client():
    """Build a boto3 S3 client for the RunPod worker's Cloudflare R2 bucket.

    Sync (boto3 has no async API) — callers must run this off the event loop
    (`asyncio.to_thread`).
    """
    import boto3

    from novelvideo.config import R2_ACCESS_KEY_ID, R2_ENDPOINT, R2_SECRET_ACCESS_KEY

    return boto3.client(
        "s3",
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    )


def _runpod_upload_inputs_sync(
    reference_images: list[tuple[str, bytes, str]],
) -> list[dict[str, str]]:
    """Upload each reference image to R2 (skip if already there, by sha256) and
    return the `inputs` list the RunPod handler expects: `{name, r2_key, sha256}`.
    """
    from novelvideo.config import R2_BUCKET

    s3 = _runpod_r2_client()
    out = []
    for name, data, _mime in reference_images:
        sha = hashlib.sha256(data).hexdigest()
        ext = os.path.splitext(name)[1] or ".png"
        r2_key = f"inputs/{sha}{ext}"
        try:
            s3.head_object(Bucket=R2_BUCKET, Key=r2_key)
        except Exception:
            s3.put_object(Bucket=R2_BUCKET, Key=r2_key, Body=data)
        out.append({"name": name, "r2_key": r2_key, "sha256": sha})
    return out


def _runpod_download_output_sync(r2_key: str) -> bytes:
    from novelvideo.config import R2_BUCKET

    s3 = _runpod_r2_client()
    return s3.get_object(Bucket=R2_BUCKET, Key=r2_key)["Body"].read()


async def _runpod_submit_job_with_409_retry(
    *,
    client: Any,
    base: str,
    endpoint_id: str,
    headers: dict[str, str],
    job_input: dict,
    label: str,
) -> tuple[str | None, str]:
    """POST `/run`, retrying a 409 (`ENDPOINT_PAUSED`) up to 5 times, 10s
    apart — RunPod returns this for a few seconds right after a worker
    transitions `workers.max` 0->1 (the common case: the user just clicked
    "bật worker"), before the endpoint is actually ready to accept jobs.

    Mirrors the retry already proven in `runpod_minimax_h3_video.py`/
    `runpod_minimax_h3_multishot_video.py` for the H3 video callers — the 3
    Qwen image callers (`_call_runpod_qwen_image_api`,
    `_call_runpod_qwen_edit_image_api`, `_runpod_run_graph_job`) each did a
    bare `submit_response.raise_for_status()` with no retry, so this exact
    race surfaced as a hard failure for image generation
    ("... submit failed: Client error '409 Conflict' ..."), real user
    report 2026-10-21. Returns `(job_id, error)` — `job_id` is None on
    failure, with `error` already formatted as `f"{label} submit failed: ..."`.
    """
    import httpx

    for attempt in range(6):
        try:
            resp = await client.post(f"{base}/{endpoint_id}/run", headers=headers, json={"input": job_input})
            if resp.status_code == 409 and attempt < 5:
                await asyncio.sleep(10)
                continue
            resp.raise_for_status()
            return resp.json()["id"], ""
        except httpx.HTTPError as exc:
            if attempt >= 5:
                return None, f"{label} submit failed: {exc}"
            await asyncio.sleep(10)
    return None, f"{label} submit failed: unknown reason"


async def _call_runpod_qwen_image_api(
    *,
    api_key: str,
    model: str,
    prompt: str,
    reference_images: list[tuple[str, bytes, str]] | None = None,
    image_config: dict | None = None,
    base_url: str | None = None,
) -> tuple[bytes | None, str, str]:
    """Generate an image via the RunPod Serverless Qwen-Image 2.1 worker
    (`photoreal-short-drama-generator` project's `runpod/handler.py`).

    The worker has no base64 path: reference images must be uploaded to
    Cloudflare R2 first (by sha256 key, so repeat refs are a cheap
    head_object), and outputs come back only as an R2 key to download. The
    job itself is a ComfyUI API graph, not a simple prompt/params payload —
    `model`/`base_url` are accepted for call-site symmetry with the other
    `_call_*_image_api` helpers but unused (the worker always runs the one
    Qwen-Image 2.1 checkpoint baked into its image).
    """
    import httpx

    from novelvideo.config import (
        RUNPOD_QWEN_IMAGE_ENDPOINT_ID,
        RUNPOD_QWEN_IMAGE_TIMEOUT_SECONDS,
    )

    if not api_key:
        return None, "", "RUNPOD_API_KEY is missing"
    if not RUNPOD_QWEN_IMAGE_ENDPOINT_ID:
        return None, "", "RUNPOD_QWEN_IMAGE_ENDPOINT_ID is missing"

    cfg = image_config or {}
    width, height = _runpod_qwen_image_dims(
        cfg.get("aspect_ratio") or "1:1", cfg.get("image_size") or "1K"
    )
    ref_images = reference_images or []
    graph, ref_images = _runpod_qwen_image_graph(
        prompt, width, height, uuid.uuid4().int & 0xFFFFFFFF, ref_images
    )

    try:
        job_inputs = await asyncio.to_thread(_runpod_upload_inputs_sync, ref_images)
    except Exception as exc:
        return None, "", f"runpod qwen image upload to R2 failed: {exc}"

    base = "https://api.runpod.ai/v2"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    job_input = {"action": "prompt", "workflow": graph, "inputs": job_inputs, "free_first": False}

    async with httpx.AsyncClient(timeout=60.0) as client:
        job_id, submit_error = await _runpod_submit_job_with_409_retry(
            client=client,
            base=base,
            endpoint_id=RUNPOD_QWEN_IMAGE_ENDPOINT_ID,
            headers=headers,
            job_input=job_input,
            label="runpod qwen image",
        )
    if submit_error:
        return None, "", submit_error

    # Poll separately from submit: once a job exists on RunPod it keeps
    # running (and billing) regardless of what this client does, so a
    # transient error here (observed in practice: an occasional 500 from
    # RunPod's own /status endpoint on a long-running job, with the job
    # itself completing normally seconds later) must not abort the whole
    # call and orphan the job — retry status checks until the deadline
    # instead, only giving up (and attempting a cancel) once that's spent.
    deadline = time.monotonic() + RUNPOD_QWEN_IMAGE_TIMEOUT_SECONDS
    status_resp: dict = {}
    last_poll_error = ""
    async with httpx.AsyncClient(timeout=60.0) as client:
        while time.monotonic() < deadline:
            await asyncio.sleep(5)
            try:
                status_response = await client.get(
                    f"{base}/{RUNPOD_QWEN_IMAGE_ENDPOINT_ID}/status/{job_id}",
                    headers=headers,
                )
                status_response.raise_for_status()
                status_resp = status_response.json()
            except httpx.HTTPError as exc:
                last_poll_error = str(exc)
                continue
            if status_resp.get("status") not in ("IN_QUEUE", "IN_PROGRESS"):
                break
        else:
            try:
                await client.post(
                    f"{base}/{RUNPOD_QWEN_IMAGE_ENDPOINT_ID}/cancel/{job_id}",
                    headers=headers,
                )
            except httpx.HTTPError:
                pass
            status_note = status_resp.get("status", "IN_QUEUE")
            poll_note = f"; last poll error: {last_poll_error}" if last_poll_error else ""
            return (
                None,
                "",
                f"runpod qwen image job {job_id} timed out after "
                f"{RUNPOD_QWEN_IMAGE_TIMEOUT_SECONDS:.0f}s (still "
                f"{status_note} — endpoint workers.max may be 0){poll_note}",
            )

    status = status_resp.get("status")
    if status != "COMPLETED":
        return None, "", f"runpod qwen image job {status}: {json.dumps(status_resp)[:800]}"

    output = status_resp.get("output") or {}
    if output.get("error"):
        return None, "", f"runpod qwen image worker error: {output['error']}"
    if output.get("node_errors"):
        return None, "", f"runpod qwen image node_errors: {json.dumps(output['node_errors'])[:800]}"

    image_item = None
    for node_out in (output.get("outputs") or {}).values():
        for lst in node_out.values():
            if not isinstance(lst, list):
                continue
            for item in lst:
                if isinstance(item, dict) and item.get("r2_key"):
                    image_item = item
                    break
            if image_item:
                break
        if image_item:
            break
    if image_item is None:
        return None, "", "runpod qwen image job completed but had no output image"

    try:
        data = await asyncio.to_thread(_runpod_download_output_sync, image_item["r2_key"])
    except Exception as exc:
        return None, "", f"runpod qwen image download from R2 failed: {exc}"

    sha = hashlib.sha256(data).hexdigest()
    if image_item.get("sha256") and sha != image_item["sha256"]:
        return None, "", "runpod qwen image downloaded file sha256 mismatch"

    return data, "", ""


async def _runpod_run_graph_job(
    *,
    api_key: str,
    endpoint_id: str,
    timeout_seconds: float,
    graph: dict,
    upload_batch: list[tuple[str, bytes, str]],
    label: str,
) -> tuple[bytes | None, str, str]:
    """Shared submit/poll/cancel/download/verify logic for a RunPod ComfyUI
    `action: "prompt"` job against one of this project's Qwen worker
    endpoints. `label` prefixes every error message (e.g. "runpod qwen21
    render image") so callers keep their existing error-message shape.

    New callers should use this instead of duplicating the submit/poll loop
    a third time. The two older callers
    (`_call_runpod_qwen_image_api`/`_call_runpod_qwen_edit_image_api`) are
    deliberately left with their own copies of this logic for now, to avoid
    any risk to their already-verified behavior — only
    `_call_runpod_qwen21_render_image_api` below uses this.
    """
    import httpx

    if not api_key:
        return None, "", f"{label}: RUNPOD_API_KEY is missing"
    if not endpoint_id:
        return None, "", f"{label}: endpoint id is missing"

    try:
        job_inputs = await asyncio.to_thread(_runpod_upload_inputs_sync, upload_batch)
    except Exception as exc:
        return None, "", f"{label} upload to R2 failed: {exc}"

    base = "https://api.runpod.ai/v2"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    job_input = {"action": "prompt", "workflow": graph, "inputs": job_inputs, "free_first": False}

    async with httpx.AsyncClient(timeout=60.0) as client:
        job_id, submit_error = await _runpod_submit_job_with_409_retry(
            client=client,
            base=base,
            endpoint_id=endpoint_id,
            headers=headers,
            job_input=job_input,
            label=label,
        )
    if submit_error:
        return None, "", submit_error

    # Same submit/poll split as the other RunPod callers, for the same
    # reason: once the job exists on RunPod it keeps running regardless of
    # what this client does, so a transient poll error must not abort the
    # call and orphan the job.
    deadline = time.monotonic() + timeout_seconds
    status_resp: dict = {}
    last_poll_error = ""
    async with httpx.AsyncClient(timeout=60.0) as client:
        while time.monotonic() < deadline:
            await asyncio.sleep(5)
            try:
                status_response = await client.get(
                    f"{base}/{endpoint_id}/status/{job_id}",
                    headers=headers,
                )
                status_response.raise_for_status()
                status_resp = status_response.json()
            except httpx.HTTPError as exc:
                last_poll_error = str(exc)
                continue
            if status_resp.get("status") not in ("IN_QUEUE", "IN_PROGRESS"):
                break
        else:
            try:
                await client.post(f"{base}/{endpoint_id}/cancel/{job_id}", headers=headers)
            except httpx.HTTPError:
                pass
            status_note = status_resp.get("status", "IN_QUEUE")
            poll_note = f"; last poll error: {last_poll_error}" if last_poll_error else ""
            return (
                None,
                "",
                f"{label} job {job_id} timed out after {timeout_seconds:.0f}s "
                f"(still {status_note} — endpoint workers.max may be 0){poll_note}",
            )

    status = status_resp.get("status")
    if status != "COMPLETED":
        return None, "", f"{label} job {status}: {json.dumps(status_resp)[:800]}"

    output = status_resp.get("output") or {}
    if output.get("error"):
        return None, "", f"{label} worker error: {output['error']}"
    if output.get("node_errors"):
        return None, "", f"{label} node_errors: {json.dumps(output['node_errors'])[:800]}"

    image_item = None
    for node_out in (output.get("outputs") or {}).values():
        for lst in node_out.values():
            if not isinstance(lst, list):
                continue
            for item in lst:
                if isinstance(item, dict) and item.get("r2_key"):
                    image_item = item
                    break
            if image_item:
                break
        if image_item:
            break
    if image_item is None:
        return None, "", f"{label} job completed but had no output image"

    try:
        data = await asyncio.to_thread(_runpod_download_output_sync, image_item["r2_key"])
    except Exception as exc:
        return None, "", f"{label} download from R2 failed: {exc}"

    sha = hashlib.sha256(data).hexdigest()
    if image_item.get("sha256") and sha != image_item["sha256"]:
        return None, "", f"{label} downloaded file sha256 mismatch"

    return data, "", ""


def _qwen21_prepare_render_image(
    data: bytes, target_area: int, *, multiple: int = 32
) -> tuple[bytes, tuple[int, int]]:
    """Resize an image to roughly `target_area` total pixels with both sides
    rounded to an exact multiple of 32 (default), re-encoded as PNG.

    Needed because `TextEncodeQwenImage21`'s `resolution=0` mode only
    ROUNDS each reference to the nearest multiple of 32 — it doesn't resize
    to a fixed target. For the masked multi-character path, a separate
    `VAEEncode` of the canvas must land on EXACTLY the size the node's own
    rounding assumes for that same image, or the resulting latent won't
    match — see `_runpod_qwen21_render_image_graph`'s docstring ("any other
    size shifts the edit"). Pre-resizing to an already-exact multiple of 32
    here means the node's own rounding is a no-op, so the two independently
    computed sizes can never disagree.
    """
    from PIL import Image

    img = Image.open(io.BytesIO(data))
    if img.mode != "RGB":
        img = img.convert("RGB")
    width, height = img.size
    if width <= 0 or height <= 0:
        raise ValueError("invalid image dimensions")
    scale = (target_area / (width * height)) ** 0.5
    new_width = max(multiple, round(width * scale / multiple) * multiple)
    new_height = max(multiple, round(height * scale / multiple) * multiple)
    if (new_width, new_height) != (width, height):
        img = img.resize((new_width, new_height), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue(), (new_width, new_height)


# Dev-only, render-only, added 2026-10-18: Qwen-Image 2.1 (same RunPod
# worker/model files as `_runpod_qwen_image_graph` above), fixed for
# render/identity-swap — see `RUNPOD_QWEN21_RENDER_*` in config.py. Two bugs
# made the project abandon 2.1 for render on 2026-10-14 without ever testing
# both fixes together (see CLAUDE.md 2026-10-18 entry for the full story):
#
# 1. `_runpod_qwen_image_graph()`'s edit-mode branch feeds KSampler an
#    `EmptyLatentImage` sized independently of the actual input image —
#    correct for a fresh portrait at a target size (sketch/character/
#    scene/prop generation, which this graph is NOT used for), wrong for an
#    edit that must preserve an existing sketch's composition. The official
#    upstream `TextEncodeQwenImage21` node (`comfy_extras/nodes_qwen.py`,
#    re-read 2026-10-18) documents its own 3rd output's tooltip verbatim:
#    "Empty latent on the first reference image's size, to match with
#    sampling as any other size shifts the edit." This graph uses that
#    output instead, for the no-mask (single-character) case.
# 2. The shared render dispatch reused the Gemini-oriented storyboard-grid
#    prompt, nonsensical for a single-image edit — fixed separately by
#    `build_qwen21_render_prompt()` in prompt_builder.py, not by this graph.
#
# For the masked multi-character inpaint case, the text encoder's own
# latent output (`["4", 2]`) must NOT be used as `SetLatentNoiseMask`'s
# `samples` input: re-reading `TextEncodeQwenImage21.execute()`'s source
# (upstream, 2026-10-18) shows that output is `torch.zeros(...)` — an EMPTY
# latent, correctly sized, but with no real pixel content. Reference images
# reach the model only via `reference_latents` appended to the conditioning,
# never through this latent output. `SetLatentNoiseMask` only preserves
# non-masked pixels when its `samples` input is a genuine `VAEEncode` of
# the real canvas — feeding it zeros would make the "preserved" region
# decode from nothing, reproducing bug 1 in a new form. So the masked path
# adds an explicit `VAEEncode(canvas)` and masks THAT latent instead,
# mirroring `_runpod_qwen_edit_image_graph`'s `"50"`→`"52"` pattern exactly.
# `canvas_name` MUST already be pre-resized to an exact multiple of 32 (see
# `_qwen21_prepare_render_image`) so this VAEEncode's output matches the
# size `TextEncodeQwenImage21`'s own `resolution=0` rounding assumes for
# the same image.
def _runpod_qwen21_render_image_graph(
    prompt: str,
    canvas_name: str,
    reference_names: list[str],
    seed: int,
    *,
    mask_name: str | None = None,
    steps: int,
    cfg: float,
    negative_prompt: str = "",
) -> dict:
    """Build the ComfyUI API graph for the RunPod Qwen-Image 2.1 worker,
    render/identity-swap mode only (`runpod_qwen21_render(_multi)`
    selections) — see the module-level comment above for why this is a
    separate graph from `_runpod_qwen_image_graph()`.

    `negative_prompt` defaults to `""`, matching the official recipe for
    `cfg=1` ("negative_prompt unused while cfg is 1"). The masked
    multi-character inpaint pass (`_qwen21_multi_character_render`) passes
    a real one together with a raised `cfg` — see `RUNPOD_QWEN21_RENDER_
    INPAINT_CFG`/`_INPAINT_NEGATIVE_PROMPT` in config.py and the 2026-10-18
    CLAUDE.md entry: at `cfg=1` with no negative prompt, classifier-free
    guidance provides ~no push away from a "generic adult" prior toward a
    visually very different (e.g. toddler) reference identity.

    `canvas_name` becomes `image_1` (the edit target, per the official
    template: "image_1 is the edit target. The rest are references.").
    `reference_names` become `image_2`+ — in practice this project only
    ever passes one (the identity portrait). The `images.image_N` dotted
    input-key convention matches `_runpod_qwen_image_graph()`'s own
    (already verified working in production for character/scene/prop refs)
    — `TextEncodeQwenImage21`'s `images` input is a ComfyUI "Autogrow" list
    named `image_1`..`image_16`.
    """
    from novelvideo.config import (
        RUNPOD_QWEN_IMAGE_TEXT_ENCODER,
        RUNPOD_QWEN_IMAGE_UNET,
        RUNPOD_QWEN_IMAGE_VAE,
    )

    graph: dict[str, Any] = {
        "1": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": RUNPOD_QWEN_IMAGE_UNET, "weight_dtype": "default"},
        },
        "2": {
            "class_type": "CLIPLoader",
            "inputs": {
                "clip_name": RUNPOD_QWEN_IMAGE_TEXT_ENCODER,
                "type": "qwen_image",
                "device": "default",
            },
        },
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": RUNPOD_QWEN_IMAGE_VAE}},
        "9": {
            "class_type": "QwenImage21Cache",
            "inputs": {"model": ["1", 0], "device": "auto", "dtype": "default"},
        },
        "10": {"class_type": "LoadImage", "inputs": {"image": canvas_name}},
    }
    images_inputs: dict[str, Any] = {"images.image_1": ["10", 0]}
    for k, name in enumerate(reference_names, start=2):
        node_id = f"11{k}"
        graph[node_id] = {"class_type": "LoadImage", "inputs": {"image": name}}
        images_inputs[f"images.image_{k}"] = [node_id, 0]

    graph["4"] = {
        "class_type": "TextEncodeQwenImage21",
        "inputs": {
            "clip": ["2", 0],
            "vae": ["3", 0],
            "prompt": prompt,
            "negative_prompt": negative_prompt,
            "resolution": 0,
            **images_inputs,
        },
    }

    latent_input = ["4", 2]
    if mask_name:
        graph["50"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["10", 0], "vae": ["3", 0]}}
        graph["90"] = {"class_type": "LoadImage", "inputs": {"image": mask_name}}
        graph["91"] = {
            "class_type": "ImageToMask",
            "inputs": {"image": ["90", 0], "channel": "red"},
        }
        graph["52"] = {
            "class_type": "SetLatentNoiseMask",
            "inputs": {"samples": ["50", 0], "mask": ["91", 0]},
        }
        latent_input = ["52", 0]

    graph["6"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": ["9", 0],
            "seed": seed,
            "steps": steps,
            "cfg": cfg,
            "sampler_name": "euler",
            "scheduler": "simple",
            "positive": ["4", 0],
            "negative": ["4", 1],
            "latent_image": latent_input,
            "denoise": 1.0,
        },
    }
    graph["7"] = {"class_type": "VAEDecode", "inputs": {"samples": ["6", 0], "vae": ["3", 0]}}
    graph["8"] = {
        "class_type": "SaveImage",
        "inputs": {"images": ["7", 0], "filename_prefix": "dramaclaw_qwen21_render"},
    }
    # No SageAttention disable-patch — see the matching comment in
    # `_runpod_qwen_image_graph` above.
    return graph


async def _call_runpod_qwen21_render_image_api(
    *,
    api_key: str,
    model: str,
    prompt: str,
    reference_images: list[tuple[str, bytes, str]] | None = None,
    image_config: dict | None = None,
    base_url: str | None = None,
    mask_image: tuple[str, bytes, str] | None = None,
    cfg: float | None = None,
    negative_prompt: str = "",
) -> tuple[bytes | None, str, str]:
    """Generate an image via the RunPod Qwen-Image 2.1 worker, render/
    identity-swap mode only (see module comment above
    `_runpod_qwen21_render_image_graph`).

    `reference_images[0]` becomes `image_1` — the canvas / size-anchor
    image. For the sketch+mask callers (`runpod_qwen21_render(_multi)`)
    this MUST be the sketch/pose canvas (the edit target); for the
    sketch-free "compose" caller (`runpod_qwen21_compose`, added
    2026-10-18 — see `_build_qwen21_compose_plan()`) it is instead the
    scene's master background photo, since there is no sketch at all in
    that mode — the function itself doesn't care which, it just treats
    `reference_images[0]` as `image_1` generically. The rest become
    `image_2`+ (in practice just one, the identity portrait, for the
    sketch-based callers; any number of identities/props for compose).
    `model`/`base_url` are accepted
    for call-site symmetry with the other `_call_*_image_api` helpers but
    unused, same as the other RunPod Qwen callers — this worker always
    runs the one Qwen-Image 2.1 checkpoint baked into its image.

    `cfg`/`negative_prompt` default to `None`/`""`, which resolve to the
    official single-character recipe (`RUNPOD_QWEN21_RENDER_CFG`, no
    negative prompt). The masked multi-character inpaint pass passes its
    own stronger values explicitly (see `RUNPOD_QWEN21_RENDER_INPAINT_CFG`/
    `_INPAINT_NEGATIVE_PROMPT` in config.py) — added 2026-10-18 to counter
    a real observed failure (toddler identities rendered as adults).

    Every image (canvas, references, mask) is pre-resized to an exact
    multiple of 32 before upload — see `_qwen21_prepare_render_image` and
    the module comment above for why that matters for this specific graph.
    """
    from novelvideo.config import (
        RUNPOD_QWEN21_RENDER_CFG,
        RUNPOD_QWEN21_RENDER_IMAGE_SIZE,
        RUNPOD_QWEN21_RENDER_STEPS,
        RUNPOD_QWEN_IMAGE_ENDPOINT_ID,
        RUNPOD_QWEN_IMAGE_TIMEOUT_SECONDS,
    )

    ref_images = reference_images or []
    if not ref_images:
        return None, "", "runpod qwen21 render image requires at least the canvas as reference_images[0]"

    target_area = _RUNPOD_QWEN_IMAGE_SIZE_TARGET_AREA.get(
        RUNPOD_QWEN21_RENDER_IMAGE_SIZE, _RUNPOD_QWEN_IMAGE_SIZE_TARGET_AREA["1K"]
    )

    canvas_name, canvas_data, _canvas_mime = ref_images[0]
    canvas_bytes, canvas_size = _qwen21_prepare_render_image(canvas_data, target_area)
    prepared: list[tuple[str, bytes, str]] = [(canvas_name, canvas_bytes, "image/png")]
    for name, data, _mime in ref_images[1:]:
        ref_bytes, _ref_size = _qwen21_prepare_render_image(data, target_area)
        prepared.append((name, ref_bytes, "image/png"))

    mask_prepared: tuple[str, bytes, str] | None = None
    if mask_image:
        mask_name, mask_data, _mask_mime = mask_image
        from PIL import Image

        mask_img = (
            Image.open(io.BytesIO(mask_data)).convert("L").resize(canvas_size, Image.NEAREST)
        )
        mask_buf = io.BytesIO()
        mask_img.save(mask_buf, format="PNG")
        mask_prepared = (mask_name, mask_buf.getvalue(), "image/png")

    graph = _runpod_qwen21_render_image_graph(
        prompt,
        prepared[0][0],
        [name for name, _data, _mime in prepared[1:]],
        uuid.uuid4().int & 0xFFFFFFFF,
        mask_name=mask_prepared[0] if mask_prepared else None,
        steps=RUNPOD_QWEN21_RENDER_STEPS,
        cfg=cfg if cfg is not None else RUNPOD_QWEN21_RENDER_CFG,
        negative_prompt=negative_prompt,
    )

    upload_batch = list(prepared)
    if mask_prepared:
        upload_batch.append(mask_prepared)

    return await _runpod_run_graph_job(
        api_key=api_key,
        endpoint_id=RUNPOD_QWEN_IMAGE_ENDPOINT_ID,
        timeout_seconds=RUNPOD_QWEN_IMAGE_TIMEOUT_SECONDS,
        graph=graph,
        upload_batch=upload_batch,
        label="runpod qwen21 render image",
    )


# Dev-only, render-only: Qwen-Image-Edit-2511 on the same RunPod worker as
# the Qwen-Image 2.1 provider above, but a genuinely different model/node
# family (original 20B Qwen-Image architecture + Qwen2.5-VL-7B text
# encoder) — see `RUNPOD_QWEN_EDIT_*` in config.py. Verified end-to-end
# 2026-10-14: this graph reliably preserves a sketch's pose/composition
# while swapping in the character's identity, which Qwen-Image 2.1's edit
# mode (`_call_runpod_qwen_image_api`) could not do consistently for this
# same task (see CLAUDE.md). Graph matches the official
# `image_qwen_image_edit_2511.json` ComfyUI template exactly, confirmed
# against this worker's own node schemas before writing this.
def _runpod_qwen_edit_image_graph(
    prompt: str,
    canvas_name: str,
    reference_names: list[str],
    seed: int,
    mask_name: str | None = None,
) -> dict:
    """Build the ComfyUI API graph for the RunPod Qwen-Image-Edit-2511 worker.

    `canvas_name` is the sketch/pose-reference image — it becomes `image1`,
    the ONE image whose size and composition the output follows (via
    FluxKontextImageScale + VAEEncode, not a forced EmptyLatentImage — that
    forced-size approach is exactly what made the 2.1 render path
    unreliable). `reference_names` are up to 2 more images (`image2`,
    `image3` — typically just the character identity portrait).

    `mask_name`, when given, is a greyscale PNG (255 = regenerate, 0 =
    preserve) the same size as `canvas_name` — wires in
    `ImageToMask` + `SetLatentNoiseMask` so KSampler only denoises the
    masked region and leaves every other pixel exactly as in `canvas_name`
    (standard ComfyUI latent-inpainting; works with a general edit
    checkpoint like this one, not just inpainting-specific weights — unlike
    `InpaintModelConditioning`, which assumes a model trained with an extra
    mask-channel input). This is the mechanism behind
    `_qwen_edit_multi_character_render`'s identity-swap pass: see that
    function's docstring for why it replaced the earlier crop-and-paste
    design (2026-10-14) — that design regenerated a separate small crop
    with its own full `TextEncodeQwenImageEditPlus` call, which produced a
    collage-like "picture in picture" artifact once image1 (the crop) was
    *also* photorealistic, not a flat-color sketch. Masking the full
    pass-1 image here keeps image1 as the whole real scene (so the
    text/vision conditioning the model sees always matches reality) and
    only constrains, at the sampler level, *where* pixels are allowed to
    change — no separate crop image, no collage behavior to trigger.
    """
    from novelvideo.config import (
        RUNPOD_QWEN_EDIT_TEXT_ENCODER,
        RUNPOD_QWEN_EDIT_UNET,
        RUNPOD_QWEN_EDIT_VAE,
    )

    graph: dict[str, Any] = {
        "1": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": RUNPOD_QWEN_EDIT_UNET, "weight_dtype": "default"},
        },
        "2": {
            "class_type": "CLIPLoader",
            "inputs": {
                "clip_name": RUNPOD_QWEN_EDIT_TEXT_ENCODER,
                "type": "qwen_image",
                "device": "default",
            },
        },
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": RUNPOD_QWEN_EDIT_VAE}},
        "10": {"class_type": "LoadImage", "inputs": {"image": canvas_name}},
        "12": {"class_type": "FluxKontextImageScale", "inputs": {"image": ["10", 0]}},
        "40": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0], "shift": 3.1}},
        "41": {"class_type": "CFGNorm", "inputs": {"model": ["40", 0], "strength": 1}},
        "50": {"class_type": "VAEEncode", "inputs": {"pixels": ["12", 0], "vae": ["3", 0]}},
    }
    encode_images: dict[str, Any] = {"image1": ["12", 0]}
    for k, name in enumerate(reference_names[:2]):
        node_id = f"11{k}"
        graph[node_id] = {"class_type": "LoadImage", "inputs": {"image": name}}
        encode_images[f"image{k + 2}"] = [node_id, 0]

    graph["20"] = {
        "class_type": "TextEncodeQwenImageEditPlus",
        "inputs": {"clip": ["2", 0], "vae": ["3", 0], "prompt": prompt, **encode_images},
    }
    graph["21"] = {
        "class_type": "TextEncodeQwenImageEditPlus",
        "inputs": {"clip": ["2", 0], "vae": ["3", 0], "prompt": "", **encode_images},
    }
    graph["30"] = {
        "class_type": "FluxKontextMultiReferenceLatentMethod",
        "inputs": {"conditioning": ["20", 0], "reference_latents_method": "index_timestep_zero"},
    }
    graph["31"] = {
        "class_type": "FluxKontextMultiReferenceLatentMethod",
        "inputs": {"conditioning": ["21", 0], "reference_latents_method": "index_timestep_zero"},
    }

    latent_input = ["50", 0]
    if mask_name:
        graph["90"] = {"class_type": "LoadImage", "inputs": {"image": mask_name}}
        graph["91"] = {
            "class_type": "ImageToMask",
            "inputs": {"image": ["90", 0], "channel": "red"},
        }
        graph["52"] = {
            "class_type": "SetLatentNoiseMask",
            "inputs": {"samples": ["50", 0], "mask": ["91", 0]},
        }
        latent_input = ["52", 0]

    graph["60"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": ["41", 0],
            "seed": seed,
            "steps": 40,
            "cfg": 4.0,
            "sampler_name": "euler",
            "scheduler": "simple",
            "positive": ["30", 0],
            "negative": ["31", 0],
            "latent_image": latent_input,
            "denoise": 1.0,
        },
    }
    graph["70"] = {"class_type": "VAEDecode", "inputs": {"samples": ["60", 0], "vae": ["3", 0]}}
    graph["80"] = {
        "class_type": "SaveImage",
        "inputs": {"images": ["70", 0], "filename_prefix": "dramaclaw_edit2511"},
    }
    # No SageAttention disable-patch — see the matching comment in
    # `_runpod_qwen_image_graph` above. This graph now runs on its own
    # Edit-2511-only endpoint (split 2026-10-19, see config.py).
    return graph


async def _call_runpod_qwen_edit_image_api(
    *,
    api_key: str,
    model: str,
    prompt: str,
    reference_images: list[tuple[str, bytes, str]] | None = None,
    image_config: dict | None = None,
    base_url: str | None = None,
    mask_image: tuple[str, bytes, str] | None = None,
) -> tuple[bytes | None, str, str]:
    """Generate an image via the RunPod Qwen-Image-Edit-2511 worker (render
    stage only — see module docstring above `_runpod_qwen_edit_image_graph`).

    `reference_images[0]` MUST be the sketch/pose-reference (becomes
    `image1`, the edit canvas); the rest (at most 2 more) become
    `image2`/`image3`. `model`/`base_url`/`image_config` are accepted for
    call-site symmetry with the other `_call_*_image_api` helpers but
    unused — there is no size to configure (the canvas follows image1's own
    size) and the worker always runs the one Edit-2511 checkpoint on this
    endpoint.

    `mask_image`, when given, is uploaded alongside `reference_images` and
    wired into `SetLatentNoiseMask` (see `_runpod_qwen_edit_image_graph`) —
    it is NOT counted as one of the 2 `image2`/`image3` reference slots.
    """
    import httpx

    from novelvideo.config import (
        RUNPOD_QWEN_EDIT_ENDPOINT_ID,
        RUNPOD_QWEN_EDIT_TIMEOUT_SECONDS,
    )

    if not api_key:
        return None, "", "RUNPOD_API_KEY is missing"
    if not RUNPOD_QWEN_EDIT_ENDPOINT_ID:
        return None, "", "RUNPOD_QWEN_EDIT_ENDPOINT_ID is missing"

    ref_images = reference_images or []
    if not ref_images:
        return None, "", "runpod qwen edit image requires at least the sketch as reference_images[0]"

    upload_batch = list(ref_images)
    if mask_image:
        upload_batch.append(mask_image)

    try:
        job_inputs = await asyncio.to_thread(_runpod_upload_inputs_sync, upload_batch)
    except Exception as exc:
        return None, "", f"runpod qwen edit image upload to R2 failed: {exc}"

    canvas_name = ref_images[0][0]
    other_names = [name for name, _data, _mime in ref_images[1:]]
    mask_name = mask_image[0] if mask_image else None
    graph = _runpod_qwen_edit_image_graph(
        prompt,
        canvas_name,
        other_names,
        uuid.uuid4().int & 0xFFFFFFFF,
        mask_name=mask_name,
    )

    base = "https://api.runpod.ai/v2"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    job_input = {"action": "prompt", "workflow": graph, "inputs": job_inputs, "free_first": False}

    async with httpx.AsyncClient(timeout=60.0) as client:
        job_id, submit_error = await _runpod_submit_job_with_409_retry(
            client=client,
            base=base,
            endpoint_id=RUNPOD_QWEN_EDIT_ENDPOINT_ID,
            headers=headers,
            job_input=job_input,
            label="runpod qwen edit image",
        )
    if submit_error:
        return None, "", submit_error

    # Same submit/poll split as _call_runpod_qwen_image_api, for the same
    # reason: once the job exists on RunPod it keeps running regardless of
    # what this client does, so a transient poll error must not abort the
    # call and orphan the job.
    deadline = time.monotonic() + RUNPOD_QWEN_EDIT_TIMEOUT_SECONDS
    status_resp: dict = {}
    last_poll_error = ""
    async with httpx.AsyncClient(timeout=60.0) as client:
        while time.monotonic() < deadline:
            await asyncio.sleep(5)
            try:
                status_response = await client.get(
                    f"{base}/{RUNPOD_QWEN_EDIT_ENDPOINT_ID}/status/{job_id}",
                    headers=headers,
                )
                status_response.raise_for_status()
                status_resp = status_response.json()
            except httpx.HTTPError as exc:
                last_poll_error = str(exc)
                continue
            if status_resp.get("status") not in ("IN_QUEUE", "IN_PROGRESS"):
                break
        else:
            try:
                await client.post(
                    f"{base}/{RUNPOD_QWEN_EDIT_ENDPOINT_ID}/cancel/{job_id}",
                    headers=headers,
                )
            except httpx.HTTPError:
                pass
            status_note = status_resp.get("status", "IN_QUEUE")
            poll_note = f"; last poll error: {last_poll_error}" if last_poll_error else ""
            return (
                None,
                "",
                f"runpod qwen edit image job {job_id} timed out after "
                f"{RUNPOD_QWEN_EDIT_TIMEOUT_SECONDS:.0f}s (still "
                f"{status_note} — endpoint workers.max may be 0){poll_note}",
            )

    status = status_resp.get("status")
    if status != "COMPLETED":
        return None, "", f"runpod qwen edit image job {status}: {json.dumps(status_resp)[:800]}"

    output = status_resp.get("output") or {}
    if output.get("error"):
        return None, "", f"runpod qwen edit image worker error: {output['error']}"
    if output.get("node_errors"):
        return None, "", f"runpod qwen edit image node_errors: {json.dumps(output['node_errors'])[:800]}"

    image_item = None
    for node_out in (output.get("outputs") or {}).values():
        for lst in node_out.values():
            if not isinstance(lst, list):
                continue
            for item in lst:
                if isinstance(item, dict) and item.get("r2_key"):
                    image_item = item
                    break
            if image_item:
                break
        if image_item:
            break
    if image_item is None:
        return None, "", "runpod qwen edit image job completed but had no output image"

    try:
        data = await asyncio.to_thread(_runpod_download_output_sync, image_item["r2_key"])
    except Exception as exc:
        return None, "", f"runpod qwen edit image download from R2 failed: {exc}"

    sha = hashlib.sha256(data).hexdigest()
    if image_item.get("sha256") and sha != image_item["sha256"]:
        return None, "", "runpod qwen edit image downloaded file sha256 mismatch"

    return data, "", ""


def _largest_connected_component(mask_bool) -> Any:
    """4-connected largest-blob filter over a boolean numpy array —
    dependency-free (no scipy in this image). Only visits pixels that are
    already True, so it stays fast even though it's plain-Python BFS: a
    character-sized mask region is at most a few tens of thousands of
    pixels. Returns `mask_bool` unchanged if it's empty.

    Needed because a sketch color match can legitimately hit more than one
    disconnected region — observed 2026-10-14 on a beat 6 sketch pool file
    that contained two separate magenta-mannequin figures; unioning both
    into one bbox/mask would crop and paste across both instead of just
    the one actually meant for this identity.
    """
    import numpy as np

    h, w = mask_bool.shape
    ys, xs = np.where(mask_bool)
    if len(ys) == 0:
        return mask_bool

    visited = np.zeros_like(mask_bool, dtype=bool)
    best_coords: list = []
    for seed_y, seed_x in zip(ys.tolist(), xs.tolist()):
        if visited[seed_y, seed_x]:
            continue
        stack = [(seed_y, seed_x)]
        visited[seed_y, seed_x] = True
        comp: list = []
        while stack:
            y, x = stack.pop()
            comp.append((y, x))
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < h and 0 <= nx < w and mask_bool[ny, nx] and not visited[ny, nx]:
                    visited[ny, nx] = True
                    stack.append((ny, nx))
        if len(comp) > len(best_coords):
            best_coords = comp

    out = np.zeros_like(mask_bool, dtype=bool)
    comp_ys = [c[0] for c in best_coords]
    comp_xs = [c[1] for c in best_coords]
    out[comp_ys, comp_xs] = True
    return out


def _qwen_edit_identity_mask(
    canvas_bytes: bytes, hex_color: str, tolerance: int = 70
) -> Optional[tuple]:
    """Locate one character's mannequin region in a render-stage sketch
    canvas by its own BRIDGMAN_CHARACTER_PALETTE color, for the
    multi-character Qwen-Image-Edit-2511 path (see
    `_qwen_edit_multi_character_render`). Reuses the color-match/bbox logic
    already proven for sketch pose editing instead of reimplementing it.

    Returns `(mask, bbox)` where `mask` is a PIL "L" image the same size as
    the canvas (255 = this identity's region, 0 = elsewhere) and `bbox` is
    `(x0, y0, x1, y1)` in the canvas's own pixel coordinates — or `None` if
    the color covers too little of the canvas to trust (under ~0.3% of
    pixels, e.g. a JPEG-reencode artifact or the identity genuinely isn't
    in this beat's sketch). Only the single largest connected blob of that
    color is kept (see `_largest_connected_component`) — if the sketch
    happens to have more than one region of this color, the smaller ones
    are dropped rather than merged into the same mask/bbox.
    """
    import numpy as np
    from PIL import Image, ImageFilter

    from novelvideo.services.sketch_pose_service import (
        _compute_bbox,
        _hex_to_rgb,
        _match_color_mask,
    )

    img = Image.open(io.BytesIO(canvas_bytes)).convert("RGBA")
    arr = np.array(img)
    target_rgb = _hex_to_rgb(hex_color)
    raw_mask = _match_color_mask(arr, target_rgb, tolerance=tolerance)
    total_px = raw_mask.shape[0] * raw_mask.shape[1]
    min_px = max(32, int(total_px * 0.003))
    if raw_mask.sum() < min_px:
        return None

    mask_img = Image.fromarray((raw_mask * 255).astype(np.uint8), mode="L")
    # Morphological opening (erode then dilate) to drop JPEG-reencode
    # speckles before trusting the bbox — a raw per-channel ±70 color match
    # on a JPEG q60/q85 canvas is noisy at edges (see Explore agent report
    # on sketch_color_detector.py / sketch_pose_service.py, 2026-10-14).
    mask_img = mask_img.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
    cleaned = np.array(mask_img) > 0
    if cleaned.sum() < min_px:
        return None
    cleaned = _largest_connected_component(cleaned)
    if cleaned.sum() < min_px:
        return None
    try:
        bbox = _compute_bbox(cleaned)
    except ValueError:
        return None
    mask_img = Image.fromarray((cleaned * 255).astype(np.uint8), mode="L")
    return mask_img, bbox


def _qwen_edit_char_name_for_identity(identity_id: str, character_map: dict) -> str:
    if identity_id in character_map:
        return identity_id
    for char_name in character_map:
        if identity_id == char_name or identity_id.startswith(f"{char_name}_"):
            return char_name
    return identity_id


def qwen_edit_identity_references(character_map: Dict[str, dict], beat: dict) -> list[dict]:
    """Resolve `beat['detected_identities']` into `{identity_id, name, path,
    appearance_details}` entries for the Qwen-Image-Edit-2511 render path
    (single- and multi-character) AND its review endpoint
    (`api/routes/generation.py`'s `render/review`) — the SAME resolution
    both use, so the reference image(s) shown in review are exactly what
    render/execute actually sends (previously the single-character path
    sent whatever reference happened to be first in the Gemini-oriented
    reference-image plan, which is not necessarily the tagged identity's
    own portrait). Mirrors `_h3_identity_references` in
    `api/routes/generation.py` (same identity->character_map matching) —
    kept as a separate copy here because generators must not import from
    api.routes.
    """
    out: list[dict] = []
    for identity_id in real_detected_identities(beat.get("detected_identities")):
        char_name = _qwen_edit_char_name_for_identity(identity_id, character_map)
        info = character_map.get(char_name)
        if not info:
            continue
        identity_name = (
            identity_id[len(char_name) + 1 :] if identity_id.startswith(f"{char_name}_") else ""
        )
        match = next(
            (
                ident
                for ident in info.get("identities") or []
                if ident.get("identity_name") == identity_name
            ),
            None,
        )
        path = (match or {}).get("primary_reference") or ""
        appearance = (match or {}).get("appearance_details") or ""
        if not path or not os.path.exists(path):
            path = info.get("portrait_path") or ""
        if not appearance:
            appearance = info.get("appearance_details") or ""
        if not path or not os.path.exists(path):
            continue
        out.append(
            {
                "identity_id": identity_id,
                "name": char_name,
                "path": str(path),
                "appearance_details": appearance,
            }
        )
    return out


def qwen_edit_subject_body_hints(character_map: Dict[str, dict], beat: dict) -> list[str]:
    """Short, non-identifying body-size/age hints (e.g. "a small child with
    a toddler build") for each identity detected in `beat`, used ONLY by
    `build_qwen21_render_prompt(stage="scene_only")` — see that function's
    docstring for why `scene_only` needs this but must stay identity-blind
    (name, face description and portrait are never included here, only
    `body_type` text).

    Resolves identity -> character the same way `qwen_edit_identity_references`
    does (incl. the identity-level lookup into `info["identities"]` matched
    by `identity_name` — NOT the `identity_body_types`-dict shape
    `agents/global_video_optimizer.py` builds for an unrelated, differently-
    shaped `char_map`; this function's `character_map` comes from
    `api/routes/generation.py:_build_character_map` /
    `services/character_ref_service.py`, confirmed by a real live call
    2026-10-18 after the first version of this function silently returned
    no hints against that shape), then falls back to the character-level
    `body_type`. Added 2026-10-18: a real multi-character render (two
    toddler characters) came out as two unrelated adults, traced to
    `scene_only` having zero body-proportion signal and defaulting to an
    adult statistical prior — see `.claude/CLAUDE.md`.
    """
    hints: list[str] = []
    seen: set[str] = set()
    for identity_id in real_detected_identities(beat.get("detected_identities")):
        char_name = _qwen_edit_char_name_for_identity(identity_id, character_map)
        info = character_map.get(char_name)
        if not info:
            continue
        identity_name = (
            identity_id[len(char_name) + 1 :] if identity_id.startswith(f"{char_name}_") else ""
        )
        match = next(
            (
                ident
                for ident in info.get("identities") or []
                if ident.get("identity_name") == identity_name
            ),
            None,
        )
        body_type = (match or {}).get("body_type") or info.get("body_type", "")
        body_type = str(body_type or "").strip()
        if body_type and body_type not in seen:
            seen.add(body_type)
            hints.append(body_type)
    return hints


def qwen_edit_load_identity_ref_bytes(
    character_map: Dict[str, dict], beat: dict
) -> Optional[tuple]:
    """First identity reference for the single-character
    (`runpod_qwen_edit_render`) path, as `(filename, bytes, mime)` —
    `None` if the beat has no detected identity with a resolvable
    reference image (caller falls back to the old reference-plan-order
    behavior in that case)."""
    refs = qwen_edit_identity_references(character_map, beat)
    if not refs:
        return None
    path = refs[0]["path"]
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        return None
    mime = mimetypes.guess_type(path)[0] or "image/png"
    return os.path.basename(path), data, mime


def _qwen21_compose_identity_name_map(character_map: Dict[str, dict], beat: dict) -> Dict[str, str]:
    """ALL `{{id}}` markers in this beat -> plain character name, for
    `build_qwen21_compose_prompt()`'s `identity_names` param — a superset
    of `real_detected_identities(...)` that also covers identities with
    NO resolvable portrait (named in the scene text, just not imaged).
    Ports the `{{id}}`->name substitution `api/routes/generation.py`'s
    `_h3_replace_identity_markers()` already does for the H3 video-prompt
    rewriter — kept as a separate copy here because generators must not
    import from api.routes (same precedent as
    `qwen_edit_identity_references()`'s own docstring above)."""
    ids = set(real_detected_identities(beat.get("detected_identities")))
    visual_desc = str(beat.get("visual_description") or "")
    ids.update(m.group(1) for m in re.finditer(r"\{\{([^}]*)\}\}", visual_desc))
    return {
        identity_id: _qwen_edit_char_name_for_identity(identity_id, character_map)
        for identity_id in ids
        if identity_id
    }


def _qwen21_compose_normalize_prop_name(value: str) -> str:
    text = (value or "").strip()
    text = re.sub(r"[·•.,:;/()\\-]+", "", text)
    return text.lower()


def _qwen21_compose_prop_name_map(beat: dict, prop_refs: list) -> Dict[str, str]:
    """ALL `[[prop_id]]` markers in this beat -> plain prop display name.
    Unlike identities there is no separate per-prop display-name
    resolver anywhere in the codebase — `ResolvedAssetRef.base_id` IS
    already the display name (the `props.name` DB column stores it
    directly, e.g. "bucket", "Teddy bears" — see
    `AssetResolver.resolve_props_for_beat()`), so this just collects
    every marker/detected prop id and matches it to a resolved ref by
    normalized name, falling back to the marker text itself when nothing
    resolved (prop mentioned in text but has no reference image)."""
    ids: set = set(real_detected_props(beat.get("detected_props")))
    ids.update(collect_prop_marker_ids_from_beat(beat))
    resolved_by_normalized = {
        _qwen21_compose_normalize_prop_name(ref.base_id): ref.base_id
        for ref in (prop_refs or [])
        if getattr(ref, "asset_type", "") == "prop"
    }
    names: Dict[str, str] = {}
    for prop_id in ids:
        if not prop_id:
            continue
        names[prop_id] = resolved_by_normalized.get(
            _qwen21_compose_normalize_prop_name(prop_id), prop_id
        )
    return names


def _qwen21_compose_prop_descriptions(beat: dict, prop_refs: list) -> Dict[str, str]:
    """ALL `[[prop_id]]`/detected prop markers in this beat -> the prop's
    own text description (`ResolvedAssetRef.text_description`, already
    resolved from `visual_prompt`/`description`/base-id fallback by
    `AssetResolver.resolve_props_for_beat()` — crucially, that method
    returns one entry per CANDIDATE prop regardless of whether it has a
    reference image, so this works even for unimaged props). Keyed the
    SAME way `_qwen21_compose_prop_name_map()` keys its own dict (by the
    marker/detected id as written in the beat, normalized-matched against
    `ResolvedAssetRef.base_id`), so a caller can look both dicts up by the
    same key. Feeds `build_qwen21_compose_prompt()`'s `prop_descriptions`
    param — see that function's docstring for why this exists: a prop
    named only by its bare id (no reference image) had its real shape
    invented by the model (real failure, `Parkun` project 2026-10-22 — a
    "toy wall", really a low multicolor plastic-brick wall per its
    `visual_prompt`, rendered as a real brick wall / concrete block / pile
    of bricks depending on the beat — see `.claude/CLAUDE.md`)."""
    ids: set = set(real_detected_props(beat.get("detected_props")))
    ids.update(collect_prop_marker_ids_from_beat(beat))
    desc_by_normalized = {
        _qwen21_compose_normalize_prop_name(ref.base_id): (ref.text_description or "").strip()
        for ref in (prop_refs or [])
        if getattr(ref, "asset_type", "") == "prop"
    }
    out: Dict[str, str] = {}
    for prop_id in ids:
        if not prop_id:
            continue
        desc = desc_by_normalized.get(_qwen21_compose_normalize_prop_name(prop_id), "")
        if desc:
            out[prop_id] = desc
    return out


def _qwen21_compose_subject_scale_hints(character_map: Dict[str, dict], beat: dict) -> Dict[str, str]:
    """`{identity_id: body-type/age hint}` for every identity detected in
    this beat, for `build_qwen21_compose_prompt()`'s `subject_scale` param
    — the same `info["identities"]` lookup-by-`identity_name` as
    `qwen_edit_subject_body_hints()` above (identity-level first, falling
    back to the character-level `body_type`), but keyed by identity_id
    (not deduplicated into one flat list) since the compose prompt
    attaches each hint to its OWN identity's own sentence, not one shared
    identity-blind `scene_only` note the way the sketch+mask path does.
    See `qwen_edit_subject_body_hints()`'s docstring for the real shape of
    `character_map` this must match against."""
    hints: Dict[str, str] = {}
    for identity_id in real_detected_identities(beat.get("detected_identities")):
        char_name = _qwen_edit_char_name_for_identity(identity_id, character_map)
        info = character_map.get(char_name)
        if not info:
            continue
        identity_name = (
            identity_id[len(char_name) + 1 :] if identity_id.startswith(f"{char_name}_") else ""
        )
        match = next(
            (
                ident
                for ident in info.get("identities") or []
                if ident.get("identity_name") == identity_name
            ),
            None,
        )
        body_type = (match or {}).get("body_type") or info.get("body_type", "")
        body_type = str(body_type or "").strip()
        if body_type:
            hints[identity_id] = body_type
    return hints


def _qwen21_compose_parse_aspect_ratio(value: str) -> Optional[float]:
    try:
        w_str, h_str = str(value or "").split(":")
        w, h = float(w_str), float(h_str)
        if w > 0 and h > 0:
            return w / h
    except (ValueError, TypeError):
        pass
    return None


def _qwen21_compose_center_crop_to_aspect(data: bytes, aspect_ratio: str) -> bytes:
    """Center-crop image bytes to the given `W:H` aspect ratio string
    (e.g. "2:3"), re-encoded as PNG. Used by `_build_qwen21_compose_plan`
    to crop the scene master background to the project's render aspect
    before it becomes `<image1>` — see `RUNPOD_QWEN21_COMPOSE_CROP_TO_
    MODE_ASPECT` in config.py for why: the scene master's own aspect
    (often 16:9) is otherwise unrelated to the project's render aspect
    (e.g. 2:3), and unlike the sketch+mask path there is no sketch file
    here to naturally pin the output's aspect. No-op (returns the
    original bytes unchanged) if `aspect_ratio` can't be parsed."""
    target = _qwen21_compose_parse_aspect_ratio(aspect_ratio)
    if target is None:
        return data
    from PIL import Image

    img = Image.open(io.BytesIO(data))
    if img.mode != "RGB":
        img = img.convert("RGB")
    width, height = img.size
    current = width / height if height else 0
    if current > target:
        new_width = max(1, round(height * target))
        left = (width - new_width) // 2
        img = img.crop((left, 0, left + new_width, height))
    elif current < target:
        new_height = max(1, round(width / target))
        top = (height - new_height) // 2
        img = img.crop((0, top, width, top + new_height))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@dataclass
class Qwen21ComposePlan:
    prompt: str
    reference_images: List[tuple]  # [(filename, bytes, mime), ...], image1 first
    audit_refs: List[dict]  # for submitted.json, mirrors other providers' shape


def _resolve_compose_references(
    *,
    beat: dict,
    character_map: Dict[str, dict],
    scene_refs: Dict[int, list],
    prop_refs: Dict[int, list],
    mode_key: Optional[str],
    max_reference_images: int,
) -> tuple:
    """Shared by every sketch-free "compose" render mode — resolve a
    beat's scene master + character identities + prop images into one
    ordered list of (filename, bytes, mime) uploads, with an audit trail.
    Extracted 2026-10-21 (was the body of `_build_qwen21_compose_plan`)
    when Gemini WebAI got its own sketch-free compose selection
    (`gemini_webai_compose`) alongside Qwen's (`runpod_qwen21_compose`) —
    which model will actually read the images doesn't change how they're
    gathered, only how the PROMPT describing them is written (Qwen's
    official `<imageN>`-tag Attribute-Disentanglement style vs Gemini's
    plain "Image N" phrasing), so only the reference-gathering is shared
    here; each caller still builds and lints its own prompt.

    `scene_refs`/`prop_refs` are `generate_grid()`'s own already-resolved
    `AssetResolver.resolve_all_for_beats()` output (1-based panel-index
    dicts — render mode's single beat is always panel 1) — this function
    does not re-resolve them, only picks the right entries out and reads
    their files.

    Reference order is always: scene background first, then every
    identity with a resolvable portrait (`qwen_edit_identity_references()`
    — the SAME resolver the sketch+mask path already uses, so review/
    audit stays consistent), then every prop with a resolvable reference
    image. Each gets a unique filename via `_webai_ref_filename(i, mime)`
    — two references sharing a source basename (e.g. two characters both
    having a file literally named `primary.png`) would otherwise collide
    inside one job, since a ComfyUI `LoadImage`/a multimodal chat
    attachment is read/ordered by name, not by the R2 object's sha256 key.

    Returns `(reference_images, audit_refs, identity_images, prop_images,
    error)` — `reference_images` is `None` on failure, with `error` set.
    `identity_images`/`prop_images` are `(id, display_name)` pairs in the
    same order as `reference_images[1:]`, for the caller's own prompt
    builder to consume. `audit_refs[i]["image_tag"]` is always the Qwen
    `<imageN>` form regardless of caller — it is inert metadata recorded
    for `submitted.json`/debugging, not text that reaches any model, so a
    Gemini-reading caller does not need its own variant.
    """
    beat_scene_refs = (scene_refs or {}).get(1) or []
    beat_prop_refs = (prop_refs or {}).get(1) or []

    scene_ref = next(
        (
            ref
            for ref in beat_scene_refs
            if getattr(ref, "asset_type", "") == "scene"
            and getattr(ref, "source_level", "") != "scene_master_detail"
            and (ref.image_paths or [None])[0]
            and os.path.exists((ref.image_paths or [None])[0])
        ),
        None,
    )
    if scene_ref is None:
        return (
            None,
            [],
            [],
            [],
            "compose requires a scene master image (the scene reference image is not configured or the file is missing)",
        )

    identity_refs = qwen_edit_identity_references(character_map, beat)
    prop_image_refs = [
        ref
        for ref in beat_prop_refs
        if getattr(ref, "asset_type", "") == "prop"
        and (ref.image_paths or [None])[0]
        and os.path.exists((ref.image_paths or [None])[0])
    ]

    total = 1 + len(identity_refs) + len(prop_image_refs)
    if total > max_reference_images:
        keep_props = max(0, max_reference_images - 1 - len(identity_refs))
        dropped = len(prop_image_refs) - keep_props
        print(
            f"[ComposeRefs] Reference images exceed the limit of {max_reference_images}, "
            f"dropping {dropped} prop references (scene + identity are kept first)"
        )
        prop_image_refs = prop_image_refs[:keep_props]

    scene_path = scene_ref.image_paths[0]
    try:
        with open(scene_path, "rb") as f:
            scene_bytes = f.read()
    except OSError as exc:
        return None, [], [], [], f"compose failed to read the scene master image: {exc}"

    from novelvideo.config import RUNPOD_QWEN21_COMPOSE_CROP_TO_MODE_ASPECT

    if RUNPOD_QWEN21_COMPOSE_CROP_TO_MODE_ASPECT and mode_key and mode_key in REGEN_MODE_CONFIGS:
        aspect = REGEN_MODE_CONFIGS[mode_key].get("aspect_ratio") or ""
        if aspect:
            scene_bytes = _qwen21_compose_center_crop_to_aspect(scene_bytes, aspect)

    scene_mime = mimetypes.guess_type(scene_path)[0] or "image/png"
    reference_images: List[tuple] = [(_webai_ref_filename(0, scene_mime), scene_bytes, scene_mime)]
    audit_refs: List[dict] = [
        {"kind": "scene", "base_id": scene_ref.base_id, "path": scene_path, "image_tag": "<image1>"}
    ]
    identity_images: List[tuple] = []
    prop_images: List[tuple] = []
    idx = 1

    for ref in identity_refs:
        path = ref["path"]
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            continue
        mime = mimetypes.guess_type(path)[0] or "image/png"
        reference_images.append((_webai_ref_filename(idx, mime), data, mime))
        audit_refs.append(
            {
                "kind": "identity",
                "base_id": ref["identity_id"],
                "path": path,
                "image_tag": f"<image{idx + 1}>",
            }
        )
        identity_images.append((ref["identity_id"], ref["name"]))
        idx += 1

    for ref in prop_image_refs:
        path = ref.image_paths[0]
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            continue
        mime = mimetypes.guess_type(path)[0] or "image/png"
        reference_images.append((_webai_ref_filename(idx, mime), data, mime))
        audit_refs.append(
            {"kind": "prop", "base_id": ref.base_id, "path": path, "image_tag": f"<image{idx + 1}>"}
        )
        prop_images.append((ref.base_id, ref.base_id))
        idx += 1

    return reference_images, audit_refs, identity_images, prop_images, ""


def _compose_absent_character_names(character_map: Dict[str, dict], beat: dict) -> set:
    """Display names of every known character in the PROJECT who is NOT
    one of THIS beat's own tagged identities — the single source of
    truth for "who must never be named in this beat's compose prompt",
    used to scrub every text source that can carry a cross-character
    reference (staging `blocking`/`set_dressing`, and a prop's own
    narrative `description` field from the database).

    Why this needs to exist at all: a beat's compose prompt only ever
    includes reference images for the identities IT tags (one person's
    portrait for a single-character beat), with a "Show exactly N
    people" guard — but any of the several free-text sources that feed
    the prompt can still have been written with the WHOLE cast or
    project in view, and the guard sentence alone did not stop the model
    from drawing an extra, unreferenced person once the text implied one
    should be there. Three distinct real leaks were caught on real GPU
    renders of `Parkun` (all same underlying class of bug, each via a
    different field): a scene-wide staging `blocking` sentence naming
    the other character; a persistent prop's `set_dressing` note naming
    the character holding it; and — the one THIS function's broader
    character_map-based (not just staging-based) name set exists to
    additionally catch — a prop's own `description` row in the database
    being a narrative blurb ("Little Trump's prized construction...")
    picked up by `_qwen21_compose_prop_descriptions()`, unrelated to
    staging entirely. See `.claude/CLAUDE.md`."""
    this_beat_identities = set(real_detected_identities(beat.get("detected_identities")))
    present_names = {
        _qwen_edit_char_name_for_identity(identity_id, character_map)
        for identity_id in this_beat_identities
    }
    return {name for name in character_map if name not in present_names}


def _compose_scrub_absent_names(text: str, absent_names: set, fallback: str = "") -> str:
    if not text or not absent_names:
        return text
    if any(name and name in text for name in absent_names):
        return fallback
    return text


def _compose_prompt_extras(
    *,
    character_map: Dict[str, dict],
    beat: dict,
    beat_prop_refs: list,
    project_dir: Optional[Path],
    episode_number: Optional[int],
) -> tuple:
    """Shared by `_build_qwen21_compose_plan`/`_build_gemini_compose_plan`
    — resolves the three optional prompt-shaping inputs added 2026-10-22
    (see `generators/prompt_builder.py`'s `build_qwen21_compose_prompt`
    docstring): each beat's prop text descriptions (for any prop with no
    reference image), each identity's body-scale hint, and this beat's
    scene's "staging bible" (camera/blocking/persistent set-dressing), if
    one has been planned (`agents/scene_staging_planner.py`). All three
    are best-effort/silently empty when the data isn't there — none of
    this is required for a compose render to work, only to make it more
    consistent. Every text source is scrubbed against
    `_compose_absent_character_names()` before being handed back — see
    that function's docstring for why. Returns `(prop_descriptions,
    subject_scale, staging_dict)`."""
    absent_names = _compose_absent_character_names(character_map, beat)

    prop_descriptions = {
        prop_id: _compose_scrub_absent_names(desc, absent_names)
        for prop_id, desc in _qwen21_compose_prop_descriptions(beat, beat_prop_refs).items()
    }
    prop_descriptions = {k: v for k, v in prop_descriptions.items() if v}
    subject_scale = list(_qwen21_compose_subject_scale_hints(character_map, beat).items())

    staging_dict: Optional[dict] = None
    if project_dir and episode_number:
        scene_id = str(beat_scene_id(beat) or "").strip()
        if scene_id:
            from novelvideo.generators.staging_store import get_scene_staging

            scene_staging = get_scene_staging(project_dir, episode_number, scene_id)
            if scene_staging is not None:
                beat_number = int(beat.get("beat_number") or 0)
                persistent = scene_staging.persistent_props_as_of(beat_number)
                this_beat_identities = set(real_detected_identities(beat.get("detected_identities")))
                blocking = {
                    identity_id: placement
                    for identity_id, placement in scene_staging.blocking.items()
                    if identity_id in this_beat_identities
                }
                set_dressing_notes = [
                    {
                        "placement_note": _compose_scrub_absent_names(
                            item.placement_note,
                            absent_names,
                            fallback=f"The {item.prop_id} is present in the scene.",
                        )
                    }
                    for item in persistent
                ]
                if scene_staging.camera or blocking or set_dressing_notes or scene_staging.scale_note:
                    staging_dict = {
                        "camera": scene_staging.camera,
                        "blocking": blocking,
                        "set_dressing": set_dressing_notes,
                        "scale_note": scene_staging.scale_note,
                    }
    return prop_descriptions, subject_scale, staging_dict


def _build_qwen21_compose_plan(
    *,
    beat: dict,
    character_map: Dict[str, dict],
    scene_refs: Dict[int, list],
    prop_refs: Dict[int, list],
    mode_key: Optional[str],
    project_dir: Optional[Path] = None,
    episode_number: Optional[int] = None,
) -> tuple:
    """Build the full RunPod-ready plan (prompt + ordered unique-named
    reference images) for the sketch-free "compose" render mode
    (`runpod_qwen21_compose`, added 2026-10-18) — see that selection's
    docstring in config.py for why this mode exists and what it fixes
    over the sketch+mask `runpod_qwen21_render(_multi)` paths. Reference
    gathering is shared (`_resolve_compose_references`); this function
    only adds the Qwen-specific prompt + lint. Returns `(plan, "")` on
    success or `(None, error)`."""
    MAX_REFERENCE_IMAGES = 16  # TextEncodeQwenImage21's images.image_1..image_16 Autogrow cap

    (
        reference_images,
        audit_refs,
        identity_images,
        prop_images,
        error,
    ) = _resolve_compose_references(
        beat=beat,
        character_map=character_map,
        scene_refs=scene_refs,
        prop_refs=prop_refs,
        mode_key=mode_key,
        max_reference_images=MAX_REFERENCE_IMAGES,
    )
    if reference_images is None:
        return None, f"Qwen 2.1 {error}"

    beat_prop_refs = (prop_refs or {}).get(1) or []
    identity_names = _qwen21_compose_identity_name_map(character_map, beat)
    prop_names = _qwen21_compose_prop_name_map(beat, beat_prop_refs)
    prop_descriptions, subject_scale, staging_dict = _compose_prompt_extras(
        character_map=character_map,
        beat=beat,
        beat_prop_refs=beat_prop_refs,
        project_dir=project_dir,
        episode_number=episode_number,
    )

    prompt = build_qwen21_compose_prompt(
        beat,
        identity_images=identity_images,
        prop_images=prop_images,
        identity_names=identity_names,
        prop_names=prop_names,
        prop_descriptions=prop_descriptions,
        subject_scale=subject_scale,
        staging=staging_dict,
    )

    from novelvideo.agents.qwen21_compose_prompt_lint import lint_qwen21_compose_prompt

    lint_issues = lint_qwen21_compose_prompt(prompt, len(reference_images))
    if lint_issues:
        print(f"[Qwen21Compose] prompt lint warnings: {lint_issues}")

    return (
        Qwen21ComposePlan(prompt=prompt, reference_images=reference_images, audit_refs=audit_refs),
        "",
    )


def _build_gemini_compose_plan(
    *,
    beat: dict,
    character_map: Dict[str, dict],
    scene_refs: Dict[int, list],
    prop_refs: Dict[int, list],
    mode_key: Optional[str],
    project_dir: Optional[Path] = None,
    episode_number: Optional[int] = None,
) -> tuple:
    """Gemini WebAI's own sketch-free "compose" render mode
    (`gemini_webai_compose`, added 2026-10-21) — same reference-gathering
    as `_build_qwen21_compose_plan` (`_resolve_compose_references`,
    shared), but a plain-English "Image N" prompt
    (`build_gemini_compose_prompt`) instead of Qwen's official
    `<imageN>`-tag Attribute-Disentanglement style: Gemini WebAI is a
    multimodal chat endpoint (`_call_webai_chat_image_api`, prompt text +
    N ordered image attachments) with no ComfyUI node auto-injecting
    `<imageN>` tokens into conditioning the way `TextEncodeQwenImage21`
    does, so writing Qwen's tag convention into a Gemini prompt would just
    be literal text the model has no special reason to parse — matches
    the plain "Image 1"/"Image 2" phrasing `UnifiedPromptBuilder` already
    uses elsewhere for this same provider (see its "BASE SKETCH LOCK"
    section). No RunPod-specific reference cap applies here (Gemini isn't
    on the `TextEncodeQwenImage21` Autogrow cap of 16) — kept at the same
    16 anyway as a sane, untested-beyond-that default; raise it if a real
    beat ever needs more. Returns `(plan, "")` on success or
    `(None, error)`."""
    MAX_REFERENCE_IMAGES = 16

    (
        reference_images,
        audit_refs,
        identity_images,
        prop_images,
        error,
    ) = _resolve_compose_references(
        beat=beat,
        character_map=character_map,
        scene_refs=scene_refs,
        prop_refs=prop_refs,
        mode_key=mode_key,
        max_reference_images=MAX_REFERENCE_IMAGES,
    )
    if reference_images is None:
        return None, f"Gemini WebAI {error}"

    beat_prop_refs = (prop_refs or {}).get(1) or []
    identity_names = _qwen21_compose_identity_name_map(character_map, beat)
    prop_names = _qwen21_compose_prop_name_map(beat, beat_prop_refs)
    prop_descriptions, subject_scale, staging_dict = _compose_prompt_extras(
        character_map=character_map,
        beat=beat,
        beat_prop_refs=beat_prop_refs,
        project_dir=project_dir,
        episode_number=episode_number,
    )

    prompt = build_gemini_compose_prompt(
        beat,
        identity_images=identity_images,
        prop_images=prop_images,
        identity_names=identity_names,
        prop_names=prop_names,
        prop_descriptions=prop_descriptions,
        subject_scale=subject_scale,
        staging=staging_dict,
    )

    return (
        Qwen21ComposePlan(prompt=prompt, reference_images=reference_images, audit_refs=audit_refs),
        "",
    )


def build_qwen_edit_mask_preview(canvas_bytes: bytes, hex_color: str) -> Optional[bytes]:
    """PNG preview of `_qwen_edit_identity_mask`'s located region, as a red
    translucent overlay on top of the sketch canvas — used by the render
    review endpoint so the multi-character dialog can show, before
    spending ~10 minutes of GPU time, which part of the sketch each
    identity's inpaint pass will actually touch. Returns `None` if the
    color wasn't found (same threshold as the real render path)."""
    from PIL import Image

    located = _qwen_edit_identity_mask(canvas_bytes, hex_color)
    if not located:
        return None
    mask_img, _bbox = located
    base = Image.open(io.BytesIO(canvas_bytes)).convert("RGBA")
    overlay = Image.new("RGBA", base.size, (255, 0, 0, 0))
    red_layer = Image.new("RGBA", base.size, (255, 32, 32, 140))
    overlay.paste(red_layer, (0, 0), mask_img.resize(base.size))
    composed = Image.alpha_composite(base, overlay)
    buf = io.BytesIO()
    composed.convert("RGB").save(buf, format="PNG")
    return buf.getvalue()


async def _two_pass_multi_character_render(
    *,
    call_image_api: Callable[..., Awaitable[tuple]],
    build_prompt: Callable[..., str],
    api_key: str,
    model: str,
    canvas_bytes: bytes,
    canvas_mime: str,
    beats: List[dict],
    grid_capacity: int,
    character_map: Dict[str, dict],
    scene_prompt_override: str = "",
    inpaint_prompts_override: Optional[Dict[str, str]] = None,
) -> tuple:
    """Two-pass masked-inpaint multi-character render, generic over which
    RunPod Qwen image API/prompt-builder pair does the actual work.

    Extracted 2026-10-18 from what was `_qwen_edit_multi_character_render`
    (Qwen-Image-Edit-2511 only) so the same proven design — mechanical,
    mask-based identity disambiguation, not a text-prompt guess — could be
    reused for the Qwen-Image 2.1 render path
    (`_qwen21_multi_character_render`) without copy-pasting ~150 lines.
    `call_image_api` and `build_prompt` are the only provider-specific
    pieces; everything else below (mask location/grow/feather, identity
    resolution) is already provider-agnostic.

    Two earlier single-pass attempts to disambiguate by naming the sketch's
    per-character mannequin color in the text prompt (e.g. "the
    magenta-colored mannequin figure") both failed in real testing on beat
    6 (teacher + Tesla, 2026-10-14, Qwen-Image-Edit-2511): the model kept
    assigning Tesla's face to the visually-dominant standing teacher, and
    the second attempt additionally painted a literal magenta T-shirt onto
    an unrelated student — it read the color as a clothing instruction, not
    a locator.

    Two earlier single-pass attempts to disambiguate by naming the sketch's
    per-character mannequin color in the text prompt (e.g. "the
    magenta-colored mannequin figure") both failed in real testing on beat
    6 (teacher + Tesla, 2026-10-14): the model kept assigning Tesla's face
    to the visually-dominant standing teacher, and the second attempt
    additionally painted a literal magenta T-shirt onto an unrelated
    student — it read the color as a clothing instruction, not a locator.

    This replaces that with a mechanical, graph-free approach in two RunPod
    calls:
    - Pass 1 (`build_prompt(stage="scene_only")`) turns the WHOLE sketch
      into a photorealistic photo with no identity reference at all, so
      every figure becomes a generic period-appropriate person.
    - Pass 2 crops pass 1's result around each detected identity's own
      sketch-mannequin color region (`_qwen_edit_identity_mask`, located in
      the ORIGINAL sketch canvas — the color only exists there, not in
      pass 1's photoreal output) and reruns the single-character prompt
      (`stage="full"`, the exact prompt verified end-to-end for beat 4) on
      just that crop — only one figure remains in the crop, so there is
      nothing left for the model to misidentify — then pastes the result
      back with a feathered mask so pixels outside the crop are untouched.

    Identity portraits are resolved by `qwen_edit_identity_references()` —
    the SAME resolution the render/review endpoint uses to show references
    up front, so what pass 2 actually sends always matches what review
    displayed (previously this looked up a character's portrait through
    the Gemini-oriented `submitted_refs` reference-image audit list, which
    keys only by base character name and could miss/mismatch an identity
    with no entry there).

    `scene_prompt_override`/`inpaint_prompts_override` (keyed by
    identity_id), when given, replace `build_prompt()`'s defaults — set by
    the caller from a saved/AI-rewritten/hand-edited prompt
    (`generators/qwen_edit_prompt_store.py`).
    """
    scoped_beats = beats[:grid_capacity]
    render_beat = (scoped_beats or [None])[0] or {}
    identity_ids = real_detected_identities(render_beat.get("detected_identities"))
    inpaint_prompts_override = inpaint_prompts_override or {}

    subject_hints = qwen_edit_subject_body_hints(character_map, render_beat)
    scene_prompt = scene_prompt_override or build_prompt(
        scoped_beats, stage="scene_only", subject_hints=subject_hints
    )
    prompts_used: dict = {"scene_prompt": scene_prompt, "inpaint_prompts": {}}
    canvas_name = _webai_ref_filename(0, canvas_mime)
    p1_bytes, _p1_text, p1_error = await call_image_api(
        api_key=api_key,
        model=model,
        prompt=scene_prompt,
        reference_images=[(canvas_name, canvas_bytes, canvas_mime)],
    )
    if not p1_bytes:
        return None, "", f"multi-character pass 1 (scene_only) failed: {p1_error}", prompts_used
    if not identity_ids:
        return p1_bytes, "", "", prompts_used

    from PIL import Image, ImageFilter

    result_img = Image.open(io.BytesIO(p1_bytes)).convert("RGB")
    result_w, result_h = result_img.size

    ref_by_identity: dict = {}
    for ref in qwen_edit_identity_references(character_map, render_beat):
        path = ref["path"]
        mime = mimetypes.guess_type(path)[0] or "image/png"
        try:
            with open(path, "rb") as f:
                ref_by_identity[ref["identity_id"]] = (os.path.basename(path), f.read(), mime)
        except OSError:
            continue

    inpaint_prompt_default = build_prompt(scoped_beats, stage="inpaint")
    applied: list = []
    skipped: list = []
    for identity_id in identity_ids:
        ref = ref_by_identity.get(identity_id)
        if not ref:
            skipped.append(f"{identity_id}(no portrait reference)")
            continue
        hex_color = _color_for_identity(identity_id, character_map, "")
        if not hex_color:
            skipped.append(f"{identity_id}(no sketch color)")
            continue
        located = _qwen_edit_identity_mask(canvas_bytes, hex_color)
        if not located:
            skipped.append(f"{identity_id}(color not found in sketch)")
            continue
        mask_img, _bbox = located
        inpaint_prompt = inpaint_prompts_override.get(identity_id) or inpaint_prompt_default
        prompts_used["inpaint_prompts"][identity_id] = inpaint_prompt

        # Mask is detected at the ORIGINAL sketch canvas's resolution (the
        # color only exists there) — resize to match the current result
        # image (pass 1's own output, or a previous identity's inpainted
        # output later in this loop) before feathering/growing it a bit so
        # hair/limb edges just outside the solid color fill are covered.
        full_mask = mask_img.resize((result_w, result_h), Image.NEAREST)
        min_side = min(result_w, result_h)
        grow = max(4, int(min_side * 0.015))
        grow_window = 1 + 2 * (grow // 2)
        full_mask = full_mask.filter(ImageFilter.MaxFilter(grow_window))
        full_mask = full_mask.filter(ImageFilter.GaussianBlur(radius=max(2, grow // 3)))

        result_buf = io.BytesIO()
        result_img.save(result_buf, format="PNG")
        mask_buf = io.BytesIO()
        full_mask.save(mask_buf, format="PNG")
        ref_name, ref_bytes_data, ref_mime = ref

        swap_bytes, _swap_text, swap_error = await call_image_api(
            api_key=api_key,
            model=model,
            prompt=inpaint_prompt,
            reference_images=[
                ("scene.png", result_buf.getvalue(), "image/png"),
                (ref_name, ref_bytes_data, ref_mime),
            ],
            mask_image=("mask.png", mask_buf.getvalue(), "image/png"),
        )
        if not swap_bytes:
            skipped.append(f"{identity_id}(pass 2 failed: {swap_error})")
            continue

        swap_img = Image.open(io.BytesIO(swap_bytes)).convert("RGB")
        if swap_img.size != (result_w, result_h):
            swap_img = swap_img.resize((result_w, result_h), Image.LANCZOS)
        result_img = swap_img
        applied.append(identity_id)

    if skipped:
        print(f"[NanoBananaPro] multi-character render: applied={applied} skipped={skipped}")

    out_buf = io.BytesIO()
    result_img.save(out_buf, format="PNG")
    error_note = f"applied={applied} skipped={skipped}" if skipped else ""
    return out_buf.getvalue(), "", error_note, prompts_used


async def _qwen_edit_multi_character_render(
    *,
    api_key: str,
    model: str,
    canvas_bytes: bytes,
    canvas_mime: str,
    beats: List[dict],
    grid_capacity: int,
    character_map: Dict[str, dict],
    scene_prompt_override: str = "",
    inpaint_prompts_override: Optional[Dict[str, str]] = None,
) -> tuple:
    """Qwen-Image-Edit-2511 multi-character render — thin wrapper over
    `_two_pass_multi_character_render()`. See that function's docstring for
    the design; this just supplies the Edit-2511-specific API caller and
    prompt builder. Kept as its own function (same name, same signature,
    same behavior as before the 2026-10-18 refactor) so every existing
    caller/test keeps working unchanged."""
    return await _two_pass_multi_character_render(
        call_image_api=_call_runpod_qwen_edit_image_api,
        build_prompt=build_qwen_edit_render_prompt,
        api_key=api_key,
        model=model,
        canvas_bytes=canvas_bytes,
        canvas_mime=canvas_mime,
        beats=beats,
        grid_capacity=grid_capacity,
        character_map=character_map,
        scene_prompt_override=scene_prompt_override,
        inpaint_prompts_override=inpaint_prompts_override,
    )


async def _qwen21_render_call_image_api_for_multi_character(
    *,
    api_key: str,
    model: str,
    prompt: str,
    reference_images: list[tuple[str, bytes, str]] | None = None,
    image_config: dict | None = None,
    base_url: str | None = None,
    mask_image: tuple[str, bytes, str] | None = None,
) -> tuple:
    """`call_image_api` passed to `_two_pass_multi_character_render` by
    `_qwen21_multi_character_render` only — identical to
    `_call_runpod_qwen21_render_image_api` for pass 1 (`mask_image=None`,
    the identity-blind `scene_only` call keeps the official `cfg=1`/no
    negative prompt recipe), but for pass 2 (the masked identity-swap call)
    raises `cfg` and adds a real negative prompt
    (`RUNPOD_QWEN21_RENDER_INPAINT_CFG`/`_INPAINT_NEGATIVE_PROMPT` in
    config.py). Added 2026-10-18: at the official `cfg=1`, there is
    effectively no classifier-free guidance pushing the masked region's
    output away from "generic adult, consistent with the rest of the
    already-generated scene" and toward a visually very different
    reference identity — confirmed by a real failure (two toddler
    characters inpainted as unrelated adults). Kept as a separate wrapper
    (not a change to `_call_runpod_qwen21_render_image_api`'s own defaults)
    so the already-verified single-character `full` path is untouched."""
    from novelvideo.config import (
        RUNPOD_QWEN21_RENDER_INPAINT_CFG,
        RUNPOD_QWEN21_RENDER_INPAINT_NEGATIVE_PROMPT,
    )

    extra: dict = {}
    if mask_image is not None:
        extra["cfg"] = RUNPOD_QWEN21_RENDER_INPAINT_CFG
        extra["negative_prompt"] = RUNPOD_QWEN21_RENDER_INPAINT_NEGATIVE_PROMPT
    return await _call_runpod_qwen21_render_image_api(
        api_key=api_key,
        model=model,
        prompt=prompt,
        reference_images=reference_images,
        image_config=image_config,
        base_url=base_url,
        mask_image=mask_image,
        **extra,
    )


async def _qwen21_multi_character_render(
    *,
    api_key: str,
    model: str,
    canvas_bytes: bytes,
    canvas_mime: str,
    beats: List[dict],
    grid_capacity: int,
    character_map: Dict[str, dict],
    scene_prompt_override: str = "",
    inpaint_prompts_override: Optional[Dict[str, str]] = None,
) -> tuple:
    """Qwen-Image 2.1 multi-character render — thin wrapper over
    `_two_pass_multi_character_render()`, supplying the 2.1-specific API
    caller and prompt builder. See `_runpod_qwen21_render_image_graph`'s
    module comment for why 2.1's masked inpaint pass needs a real
    `VAEEncode(canvas)` (handled inside `_call_runpod_qwen21_render_image_api`
    via its `mask_image` parameter), not the text encoder's own zero latent.
    Uses `_qwen21_render_call_image_api_for_multi_character` (not the bare
    API caller) so the masked pass gets the boosted cfg/negative-prompt —
    see that wrapper's docstring."""
    return await _two_pass_multi_character_render(
        call_image_api=_qwen21_render_call_image_api_for_multi_character,
        build_prompt=build_qwen21_render_prompt,
        api_key=api_key,
        model=model,
        canvas_bytes=canvas_bytes,
        canvas_mime=canvas_mime,
        beats=beats,
        grid_capacity=grid_capacity,
        character_map=character_map,
        scene_prompt_override=scene_prompt_override,
        inpaint_prompts_override=inpaint_prompts_override,
    )


async def _call_huimeng_image_api(
    *,
    api_key: str,
    model: str,
    prompt: str,
    reference_images: list[bytes | tuple[bytes, str] | tuple[str, bytes, str]] | None = None,
    image_config: dict | None = None,
) -> tuple[bytes | None, str, str]:
    """Call HuiMeng's async task API for image generation/editing."""
    import httpx

    if not api_key:
        return None, "", "HUIMENGI_API_KEY is missing"

    image_config = image_config or {}
    ratio = str(image_config.get("aspect_ratio") or "1:1").strip() or "1:1"
    resolution = _huimeng_image_resolution_for_model(model, image_config.get("image_size"))
    params: dict[str, object] = {"prompt": prompt, "ratio": ratio}
    if resolution:
        params["resolution"] = resolution
    if model == "image-2-official":
        quality = (
            str(
                image_config.get("quality") or image_config.get("huimeng_image_quality") or "medium"
            )
            .strip()
            .lower()
        )
        params["quality"] = quality if quality in {"low", "medium", "high"} else "medium"
    if reference_images:
        ref_urls = []
        for image_ref in reference_images[:9]:
            if isinstance(image_ref, tuple):
                if len(image_ref) == 3:
                    image_bytes = image_ref[1]
                elif len(image_ref) == 2:
                    image_bytes = image_ref[0]
                else:
                    image_bytes = bytes(image_ref[0])
            else:
                image_bytes = bytes(image_ref)
            ref_urls.append(bytes_to_data_url(bytes(image_bytes)))
        params["image"] = ref_urls[0] if len(ref_urls) == 1 else ref_urls

    request_context = f"model={model}, ratio={ratio}, refs={len(reference_images or [])}"
    try:
        client = HuimengiTaskClient(api_key=api_key)
        submit = await client.submit_task(model=model, params=params)
        task_id = submit["task_id"]
        print(f"[HuiMeng Images] submitted task_id={task_id} ({request_context})")
        task = await client.wait_for_completion(
            task_id,
            poll_interval=_HUIMENG_IMAGE_POLL_INTERVAL_SECONDS,
            max_polls=_HUIMENG_IMAGE_MAX_POLLS,
        )
        result = task.get("result") or {}
        image_url = extract_huimeng_result_url(result, "image_url", "image_urls")
        if not image_url:
            return None, "", f"HuiMeng result missing image_url: {result}"

        async with httpx.AsyncClient(timeout=180.0, follow_redirects=True) as http_client:
            response = await http_client.get(image_url)
        response.raise_for_status()
        validate_huimeng_media_download(
            response.content,
            response.headers.get("content-type"),
            expected_media_type="image",
            url=image_url,
        )
        return response.content, "", ""
    except httpx.HTTPStatusError as exc:
        body = (exc.response.text or "")[:500]
        return None, "", f"{request_context} | HTTP {exc.response.status_code}: {body}"
    except HuimengTaskFailed as exc:
        return None, "", f"{request_context} | HuiMeng task failed: {exc}"
    except Exception as exc:
        return None, "", f"{request_context} | request failed: {exc}"


class NanoBananaGridGenerator:
    """NanoBananaPro grid generator.

    Supports several modes (all use batch generation with dynamic optimization):
    - "1x1": single image generation (1K resolution)
    - "1x3": three cells in a row
    - "2x2": compact four cells
    - "3x3": generate multiple 3x3 grids in batches
    - "4x4": balanced medium size
    - "5x5": batch generation, up to 25 shots (dynamic optimization)

    Uses the Gemini Pro Image model of Google AI Studio to generate storyboard grids.

    Example:
        >>> generator = NanoBananaGridGenerator()
        >>> # 3x3 mode batch generation
        >>> results = await generator.generate_grid_batch(
        ...     all_beats=beats_data,
        ...     character_map=char_map,
        ...     output_dir="output/grids"
        ... )
    """

    def __init__(self, api_key: Optional[str] = None, config: Optional[dict] = None):
        """Initialize the generator.

        Args:
            api_key: Google AI API Key; read from the environment by default
        """
        config = config or get_grid_generation_config()
        self.provider = config.get("provider", "google")
        self.api_key = api_key or config["api_key"]
        self.model = config["model"]
        self.base_url = config.get("base_url", "")
        self.openai_image_quality = config.get("openai_image_quality", "medium")
        self.openai_sketch_image_quality = config.get(
            "openai_sketch_image_quality", "low"
        )
        self.huimeng_image_quality = config.get("huimeng_image_quality", "medium")
        self.default_image_size = config.get("image_size", "1K")
        # Selection-level resolution override (e.g. "Google Gemini (2K)" in
        # the Image source picker) — see generate_grid()'s force_image_size.
        self.force_image_size = config.get("force_image_size") or None
        # runpod_qwen_edit only — see _qwen_edit_multi_character_render().
        self.qwen_edit_multi_character = bool(config.get("multi_character"))
        self.newapi_request_schema = config.get("newapi_request_schema") or {}
        self.newapi_model_params = config.get("newapi_model_params") or {}
        self.mode = config.get("mode", "3x3")
        self.rows = config["rows"]
        self.cols = config["cols"]
        self.batch_size = config.get("batch_size", self.rows * self.cols)
        self.total_panels = config["total_panels"]

        if not self.api_key:
            if self.provider == "openrouter":
                key_name = "OPENROUTER_API_KEY"
            elif self.provider == "huimeng":
                key_name = "HUIMENGI_API_KEY"
            elif self.provider == "openai":
                key_name = "OPENAI_API_KEY"
            elif self.provider == "newapi":
                key_name = "NEWAPI_API_KEY"
            elif self.provider == "qwen":
                key_name = "QWEN_API_KEY"
            elif self.provider == "runpod_qwen":
                key_name = "RUNPOD_API_KEY"
            elif self.provider == "runpod_qwen_edit":
                key_name = "RUNPOD_API_KEY"
            elif self.provider == "runpod_qwen21_render":
                key_name = "RUNPOD_API_KEY"
            elif self.provider == "runpod_qwen21_compose":
                key_name = "RUNPOD_API_KEY"
            else:
                key_name = "GOOGLE_AI_API_KEY"
            raise ValueError(f"API key not set. Set {key_name} environment variable.")

        # EG-09b (OI-52): organizations may only generate images through the gateway. This verdict in `_prepare_organization_image_egress`
        # has long existed, but the call sites of the grid family do not go through it, so it never took effect for entry points like `generate_grid`.
        # It is lifted to the construction point because those 6 entry points share `self.provider` to pick a branch, so one check is enough.
        # Only effective for organization identities -- platform/personal direct provider behavior is unchanged.
        if self.provider != "newapi" and ambient_organization_egress_context() is not None:
            raise EgressError("ORG_EGRESS_DENIED")

        print(f"[NanoBanana Grid] Provider: {self.provider}, Model: {self.model}")

    async def generate_grid(
        self,
        beats: List[dict],
        character_map: Dict[str, dict] = None,
        scene_menu: list[dict] | list | None = None,
        prop_menu: list[dict] | list | None = None,
        sketch_colors: Dict[str, str] = None,
        style: str = None,  # defaults to the global style configuration
        output_path: Optional[str] = None,
        ethnicity: str = "Chinese",
        rows: int = None,  # configurable row count, defaults to the configured value
        cols: int = None,  # configurable column count, defaults to the configured value
        sketch: bool = False,  # whether to generate in sketch mode
        prompt_only: bool = False,  # Dry Run mode: only generate prompts, do not call the API
        beat_start_index: int = 0,  # Render mode: start beat index of the current grid (used to slice the sketch)
        total_episode_beats: int = 0,  # Render mode: total beats in the episode (used to compute the sketch size)
        location_beat_numbers: List[int] = None,  # original beat numbers of the scene group (1-based)
        explicit_episode_number: Optional[
            int
        ] = None,  # episode number known to the caller, avoids deriving it from the path
        scene_refs_override: dict[int, list[Any]] | None = None,
        prop_refs_override: dict[int, list[Any]] | None = None,
        sketch_dir: str = "",  # sketch directory path (computed by the caller via PathResolver)
        aspect_ratio_override: Optional[
            str
        ] = None,  # overrides aspect_ratio (used by regeneration mode)
        image_size_override: Optional[str] = None,  # overrides image_size (used by regeneration mode)
        mode_key: Optional[str] = None,  # mode_key lookup for aspect_ratio/image_size
        prompt_aspect_ratio: Optional[
            str
        ] = None,  # overrides the ratio in the prompt (two-pass: image uses 1:1, prompt uses 9:16)
        beat_sketch_paths: dict = None,  # {beat_num: full_path} per-beat sketch paths taken from the image pool
        sketch_aspect_padding: bool = False,  # pad the sketch with white to the target ratio
        force_image_size: Optional[str] = None,  # force-override image_size (e.g. "0.5K")
        use_director_refs: bool = False,  # whether to prefer beat-level director reference images
        director_sheet_path: Optional[str] = None,  # DirectorWorld sheet of the current grid
        director_ref_beat_numbers: Optional[
            List[int]
        ] = None,  # only these beats use director references
        director_control_frames_dir: str | Path | None = None,
        qwen_edit_prompts: Optional[dict] = None,  # runpod_qwen_edit only — saved/AI-rewritten/hand-edited prompt override, per beat
    ) -> GridGenerationResult:
        """Generate a grid image.

        The reference mode is decided upstream by build_character_map_for_grid():
        - composite: composite reference image (Portrait + Fullbody stitched), locks face + clothing
        - portrait_only: face close-up only, locks the face; clothing is controlled by the appearance_details text
        - prompt_only: no reference image, fully controlled by the prompt

        Args:
            beats: list of Beats data (padded with black when below the grid capacity)
            character_map: character mapping {character_name: {
                'character_tag': ...,
                'base_prompt': ...,
                'appearance_details': ...,
                'portrait_path': ...,  # face close-up image (used to lock the face)
                'ref_path': ...,  # reference image path
                'reference_mode': ...,  # composite / portrait_only / prompt_only
            }}
            style: global style name (chinese_period_drama, anime, realistic),
                   defaults to IMAGE_DEFAULT_STYLE
            output_path: output path
            ethnicity: default character ethnicity (default "Chinese"), used to ensure correct facial features
            rows: number of grid rows (defaults to the configured value)
            cols: number of grid columns (defaults to the configured value)

        Returns:
            GridGenerationResult
        """
        # Use the passed rows/cols or the default configured values
        rows = rows or self.rows
        cols = cols or self.cols
        grid_capacity = rows * cols
        start_time = time.time()
        character_map = character_map or {}
        previous_grid_path = None  # Render mode sets the sketch path internally

        # Use the global default style
        if style is None:
            style = IMAGE_DEFAULT_STYLE
        print(f"[NanoBananaPro] Using style: {style}, grid: {rows}x{cols}")

        if len(beats) < 1:
            return GridGenerationResult(
                success=False,
                error="At least 1 beat is required; there are currently no beats",
                generation_time=time.time() - start_time,
            )

        # If below the grid capacity, black padding is used later
        actual_beat_count = min(len(beats), grid_capacity)
        print(
            f"[NanoBananaPro] Valid beats: {actual_beat_count}/{grid_capacity}, the remainder is padded with black"
        )
        if not sketch and sketch_dir:
            detection_error = render_ai_detection_error(beats[:grid_capacity])
            if detection_error:
                print(f"[NanoBananaPro] ❌ {detection_error}")
                return GridGenerationResult(
                    success=False,
                    error=detection_error,
                    generation_time=time.time() - start_time,
                )

        try:
            types = None
            client = None
            # Initialize the client (only needed for Google direct)
            if self.provider == "google":
                from google.genai import types
                from google import genai

                client = genai.Client(api_key=self.api_key)

            # Verify the reference images exist - trust the upstream reference_mode, only confirm the files exist
            valid_character_map = {}
            for char_name, info in character_map.items():
                char_info = dict(info)
                ref_path = info.get("ref_path") or info.get("portrait_path")
                upstream_mode = info.get("reference_mode", "prompt_only")

                if (
                    upstream_mode == "composite" and ref_path and os.path.exists(ref_path)
                ):
                    char_info["reference_path"] = ref_path
                    char_info["reference_mode"] = "composite"
                    print(f"[NanoBananaPro] {char_name}: composite image mode -> {ref_path}")
                    valid_character_map[char_name] = char_info
                    continue

                if ref_path and os.path.exists(ref_path):
                    char_info["reference_path"] = ref_path
                    char_info["reference_mode"] = "portrait_only"
                    print(
                        f"[NanoBananaPro] {char_name}: Portrait mode (face lock only) -> {ref_path}"
                    )
                    valid_character_map[char_name] = char_info
                    continue

                char_info["reference_path"] = None
                char_info["reference_mode"] = "prompt_only"
                print(f"[NanoBananaPro] {char_name}: prompt mode (no reference image)")
                valid_character_map[char_name] = char_info

            # 1. Build the grid prompt
            # Branch: Sketch mode vs Render mode
            # Always use UnifiedPromptBuilder so export and generation use the same prompt
            is_render_mode = False  # flag marking Render mode
            compose_plan: Optional[Qwen21ComposePlan] = None  # runpod_qwen21_compose / gemini_webai_compose only
            project_dir = _infer_project_dir(output_path, sketch_dir)
            episode_number = (
                int(explicit_episode_number)
                if explicit_episode_number is not None
                else infer_episode_from_path(output_path) or infer_episode_from_path(sketch_dir)
            )
            scene_refs: dict[int, list[Any]] = {}
            prop_asset_refs: dict[int, list[Any]] = {}
            scene_refs, prop_asset_refs = _resolve_scene_prop_asset_refs(
                project_dir,
                beats[:grid_capacity],
                episode_number=episode_number,
                sketch=sketch,
                use_director_refs=use_director_refs,
                include_pano_view_refs=False,
                director_ref_beat_numbers=director_ref_beat_numbers,
                director_control_frames_dir=director_control_frames_dir,
                scene_menu=scene_menu,
                prop_menu=prop_menu,
                allow_beat_background_anchor=(
                    actual_beat_count == 1 and int(rows or 0) == 1 and int(cols or 0) == 1
                ),
            )
            if scene_refs_override is not None:
                scene_refs = {
                    int(panel_idx): list(refs or [])
                    for panel_idx, refs in scene_refs_override.items()
                }
            if prop_refs_override is not None:
                prop_asset_refs = {
                    int(panel_idx): list(refs or [])
                    for panel_idx, refs in prop_refs_override.items()
                }
            if (
                sketch
                and use_director_refs
                and director_sheet_path
                and os.path.exists(director_sheet_path)
            ):
                from novelvideo.utils.asset_resolver import ResolvedAssetRef

                director_sheet_ref = ResolvedAssetRef(
                    asset_type="scene",
                    base_id=beats[0].get("scene_id") or beats[0].get("scene") or "DirectorWorld",
                    variant_id=None,
                    image_paths=[director_sheet_path],
                    text_description="DirectorWorld blocking reference sheet",
                    source_level="director_sheet",
                )
                selected_director_beats = {
                    int(bn) for bn in (director_ref_beat_numbers or []) if bn is not None
                }
                for panel_idx in range(1, actual_beat_count + 1):
                    if selected_director_beats:
                        beat_num = beats[panel_idx - 1].get("beat_number", panel_idx)
                        if int(beat_num or 0) not in selected_director_beats:
                            continue
                    refs = scene_refs.setdefault(panel_idx, [])
                    refs.insert(0, director_sheet_ref)
            # Filter to the characters appearing in the current grid. scene_refs are resolved first; the character set can later be narrowed by the reference-image context.
            if sketch:
                valid_character_map = filter_character_map_for_beats(
                    valid_character_map,
                    beats[:grid_capacity],
                    scene_refs=scene_refs if use_director_refs else None,
                )
            if sketch and use_director_refs:
                has_director_sheet = bool(
                    director_sheet_path and os.path.exists(director_sheet_path)
                )
                if has_director_sheet:
                    print(
                        f"[DirectorSheet] Using DirectorWorld sheet: {director_sheet_path}"
                    )
                elif actual_beat_count != 1 or rows != 1 or cols != 1:
                    return GridGenerationResult(
                        success=False,
                        error=(
                            "Director reference mode only supports a single beat 1x1; "
                            "for batch sketches, export the corresponding DirectorWorld control images first."
                        ),
                        generation_time=time.time() - start_time,
                    )
                if not has_director_sheet and not _has_director_image_ref(
                    scene_refs, panel_idx=1
                ):
                    return GridGenerationResult(
                        success=False,
                        error=(
                            "Director single shot is missing the beat-level 3GS control frame; "
                            "the sketch main line no longer falls back to the old scene reference images."
                        ),
                        generation_time=time.time() - start_time,
                    )
                if not has_director_sheet:
                    _prepare_director_blocking_refs(
                        scene_refs=scene_refs,
                        beats=beats[:grid_capacity],
                        character_map=valid_character_map,
                    )
            style_family, animation_subtype = StyleService.get_style_branch(
                style or IMAGE_DEFAULT_STYLE,
                project_dir=project_dir,
            )

            if sketch:
                # Sketch mode uses UnifiedPromptBuilder (consistent with the export logic)
                print("[NanoBananaPro] Entering Sketch mode")

                # Global beat range of the current grid (1-based)
                grid_beat_start = beat_start_index + 1
                grid_beat_end = beat_start_index + grid_capacity

                # prompt_aspect_ratio takes precedence (in two-pass the image uses 1:1 but the prompt writes 2:3)
                _prompt_ar = prompt_aspect_ratio or (
                    REGEN_MODE_CONFIGS[mode_key]["aspect_ratio"] if mode_key else None
                )
                # image_aspect_ratio = actual output ratio (1:1 in two-pass Pass 1, otherwise the same as prompt_ar)
                _image_ar = (
                    REGEN_MODE_CONFIGS[mode_key]["aspect_ratio"] if mode_key else ""
                )
                ctx = create_prompt_context(
                    mode=PromptMode.SKETCH,
                    beats=beats[:grid_capacity],
                    rows=rows,
                    cols=cols,
                    character_map=valid_character_map,
                    style=style,
                    ethnicity=ethnicity,
                    aspect_ratio=_prompt_ar,
                    image_aspect_ratio=_image_ar,
                    scene_refs=scene_refs,
                    prop_asset_refs=prop_asset_refs,
                    sketch_colors=sketch_colors or {},
                    prop_marker_colors=_global_prop_marker_colors(
                        beats[:grid_capacity],
                        prop_menu,
                        sketch_colors=sketch_colors or {},
                    ),
                    style_family=style_family,
                    animation_subtype=animation_subtype,
                    project_dir=str(project_dir) if project_dir else "",
                    image_provider=self.provider,
                    image_model=self.model,
                )
                from novelvideo.verification.failure_registry import (
                    load_negative_clause_for_project,
                )

                ctx.registry_negative_clause = await load_negative_clause_for_project(
                    str(project_dir) if project_dir else None, "generator"
                )
                builder = UnifiedPromptBuilder(ctx)
                prompt = builder.build()

            elif self.provider == "runpod_qwen21_compose":
                # Sketch-FREE "compose" render mode (added 2026-10-18) — see
                # config.py's RUNPOD_QWEN21_COMPOSE_SELECTION_KEYS docstring
                # and _build_qwen21_compose_plan()'s own docstring. Must be
                # its own branch here, not just in the dispatch switch below
                # (`elif self.provider == "runpod_qwen21_compose":` further
                # down): every other branch in this chain either requires a
                # sketch (`if sketch:`) or a sketch directory
                # (`elif sketch_dir:`, falls through to the hard "generate_grid() requires
                # the sketch or sketch_dir argument" error at the bottom otherwise) -- this mode
                # has neither, by design.
                print("[NanoBananaPro] Entering Qwen 2.1 Compose mode (no sketch)")
                if len(beats[:grid_capacity]) != 1 or grid_capacity != 1:
                    return GridGenerationResult(
                        success=False,
                        error="Qwen 2.1 compose only supports single-beat 1x1 rendering",
                        generation_time=time.time() - start_time,
                    )
                compose_plan, compose_err = _build_qwen21_compose_plan(
                    beat=beats[0],
                    character_map=valid_character_map,
                    scene_refs=scene_refs,
                    prop_refs=prop_asset_refs,
                    mode_key=mode_key,
                    project_dir=project_dir,
                    episode_number=episode_number,
                )
                if compose_plan is None:
                    return GridGenerationResult(
                        success=False,
                        error=compose_err,
                        generation_time=time.time() - start_time,
                    )
                prompt = compose_plan.prompt
                is_render_mode = True

            elif self.provider == "gemini_webai_compose":
                # Gemini WebAI's own sketch-free "compose" render mode
                # (added 2026-10-21) — same reasoning as the Qwen branch
                # just above for why this must be its own chain branch,
                # not only in the dispatch switch further down. See
                # `_build_gemini_compose_plan()`'s docstring.
                print("[NanoBananaPro] entering Gemini WebAI Compose mode (no sketch)")
                if len(beats[:grid_capacity]) != 1 or grid_capacity != 1:
                    return GridGenerationResult(
                        success=False,
                        error="Gemini WebAI compose only supports single-beat 1x1 render",
                        generation_time=time.time() - start_time,
                    )
                compose_plan, compose_err = _build_gemini_compose_plan(
                    beat=beats[0],
                    character_map=valid_character_map,
                    scene_refs=scene_refs,
                    prop_refs=prop_asset_refs,
                    mode_key=mode_key,
                    project_dir=project_dir,
                    episode_number=episode_number,
                )
                if compose_plan is None:
                    return GridGenerationResult(
                        success=False,
                        error=compose_err,
                        generation_time=time.time() - start_time,
                    )
                prompt = compose_plan.prompt
                is_render_mode = True

            elif sketch_dir:
                # Render mode: locate the matching sketch in the sketch directory via find_sketch_for_beat_range
                sketch_dir_path = sketch_dir

                # Determine the beat number list -- always extracted from the beats themselves, to avoid drifting out of sync with external parameters
                actual_beats = beats[:grid_capacity]
                actual_beat_numbers = [
                    _generation_beat_number(b, i) for i, b in enumerate(actual_beats)
                ]

                beat_range_start = min(actual_beat_numbers)
                beat_range_end = max(actual_beat_numbers)

                sketch_result = find_sketch_for_beat_range(
                    sketch_dir_path, beat_range_start, beat_range_end
                )
                has_all_pool_sketches = beat_sketch_paths and all(
                    bn in beat_sketch_paths for bn in actual_beat_numbers
                )
                if sketch_result is None and not has_all_pool_sketches:
                    print(
                        f"[Render] Warning: no sketch found covering beats {beat_range_start}-{beat_range_end}"
                    )

                if sketch_result or has_all_pool_sketches:
                    print("[NanoBananaPro] Entering Render mode (render from sketch)")
                    if has_all_pool_sketches:
                        print(
                            f"[Render] Using image-pool sketches: {len(beat_sketch_paths)} beats"
                        )
                    elif sketch_result:
                        sketch_file, s_rows, s_cols = sketch_result
                        print(f"[Render] Using sketch: {sketch_file} ({s_rows}x{s_cols})")
                    is_render_mode = True

                    # Render mode: slice the sketch first, then filter characters by color detection
                    if output_path:
                        temp_dir = Path(output_path).parent
                    else:
                        temp_dir = Path("output")
                    temp_dir.mkdir(parents=True, exist_ok=True)
                    temp_stem = Path(output_path).stem if output_path else uuid.uuid4().hex[:12]
                    sub_sketch_path = str(temp_dir / f"temp_sub_sketch_{temp_stem}.jpg")

                    target_aspect = None
                    if sketch_aspect_padding and mode_key:
                        target_aspect = cell_aspect_ratio(mode_key)

                    sub_sketch_path = crop_sketch_panels(
                        sketch_path=sketch_dir_path,
                        beat_numbers=actual_beat_numbers,
                        target_rows=rows,
                        target_cols=cols,
                        output_path=sub_sketch_path,
                        beat_sketch_paths=beat_sketch_paths,
                        target_aspect=target_aspect,
                    )
                    print(
                        f"[Render] Sketch sliced: beat_numbers={actual_beat_numbers} -> {rows}x{cols}"
                    )
                    print(f"[Render] Sub-sketch saved: {sub_sketch_path}")

                    # Use the sliced sketch as the reference
                    previous_grid_path = sub_sketch_path

                    # Read the precomputed per-beat identity detection results (already done in the sketch workbench)
                    _panel_det = load_precomputed_panel_detected(
                        actual_beat_numbers, beats
                    )
                    valid_character_map = filter_character_map_by_precomputed(
                        valid_character_map, _panel_det
                    )

                    # Use UnifiedPromptBuilder (consistent with the export logic)
                    ctx = create_prompt_context(
                        mode=PromptMode.RENDER,
                        beats=beats[:grid_capacity],
                        rows=rows,
                        cols=cols,
                        character_map=valid_character_map,
                        style=style,
                        ethnicity=ethnicity,
                        aspect_ratio=(
                            REGEN_MODE_CONFIGS[mode_key]["aspect_ratio"] if mode_key else None
                        ),
                        panel_detected_keys=_panel_det,
                        scene_refs=scene_refs,
                        prop_asset_refs=prop_asset_refs,
                        sketch_colors=sketch_colors or {},
                        style_family=style_family,
                        animation_subtype=animation_subtype,
                        project_dir=str(project_dir) if project_dir else "",
                    )
                    builder = UnifiedPromptBuilder(ctx)
                    prompt = builder.build()
                else:
                    # Sketch not found; fail explicitly (no fallback)
                    msg = f"Render mode requires a sketch, but none was found covering beats {beat_range_start}-{beat_range_end}"
                    print(f"[NanoBananaPro] ❌ {msg}")
                    return GridGenerationResult(
                        success=False,
                        error=msg,
                    )
            else:
                # A sketch or sketch directory is required
                msg = "generate_grid() requires the sketch or sketch_dir argument"
                print(f"[NanoBananaPro] ❌ {msg}")
                return GridGenerationResult(
                    success=False,
                    error=msg,
                )

            print(
                f"[NanoBananaPro] Prompt built, {len(beats[:grid_capacity])} shots in total"
            )

            # Save the prompt to a file (for auditing)
            # Directory structure: grids/ep001/2x2/prompts/grid_01.prompt.txt
            if output_path:
                grid_dir = Path(output_path).parent  # grids/ep001/2x2
                prompts_dir = grid_dir / "prompts"  # grids/ep001/2x2/prompts
                prompts_dir.mkdir(parents=True, exist_ok=True)
                grid_basename = Path(output_path).stem  # "grid_01"
                prompt_file = prompts_dir / f"{grid_basename}.prompt.txt"
                prompt_file.write_text(prompt, encoding="utf-8")
                print(f"[NanoBananaPro] Grid Prompt saved: {prompt_file}")

            # Prompt-Only mode: only generate the prompt, skip the API call
            if prompt_only:
                print("[NanoBananaPro] Prompt-Only mode, skipping the API call")
                # In Render mode, show the sketch slicing info (for verification)
                if is_render_mode:
                    sketch_capacity = (
                        SKETCH_GRID_CONFIG["rows"] * SKETCH_GRID_CONFIG["cols"]
                    )
                    local_offset = beat_start_index % sketch_capacity
                    end_index = local_offset + len(beats[:grid_capacity])
                    print(
                        f"[NanoBananaPro] [Render preview] Sketch {SKETCH_GRID_CONFIG['rows']}x{SKETCH_GRID_CONFIG['cols']}"
                    )
                    print(
                        f"[NanoBananaPro] [Render preview] Local slice: [{local_offset}:{end_index}] ({end_index - local_offset} panels in total)"
                    )
                return GridGenerationResult(
                    success=True,
                    grid_image_path=None,
                    error=None,
                    generation_time=time.time() - start_time,
                )

            usage_request_id = uuid.uuid4().hex
            project_output_dir = infer_project_output_dir(output_path or sketch_dir)
            usage_recorded = False
            scope_beat_numbers = [
                int(b) for b in (location_beat_numbers or []) if b is not None
            ]
            if not scope_beat_numbers:
                scope_beat_numbers = [
                    _generation_beat_number(beat, beat_start_index + idx)
                    for idx, beat in enumerate(beats[:grid_capacity])
                ]
            first_beat_num = scope_beat_numbers[0] if scope_beat_numbers else None
            task_type = "sketch_grid" if sketch else "render_grid"
            scope = f"{task_type}:{mode_key or f'{rows}x{cols}'}:{'-'.join(str(b) for b in scope_beat_numbers)}"

            def _usage_fail(error_message: str) -> GridGenerationResult:
                if usage_recorded and project_output_dir:
                    update_image_request_status(
                        project_output_dir=project_output_dir,
                        request_id=usage_request_id,
                        status="failed",
                        error_message=error_message,
                    )
                return GridGenerationResult(
                    success=False,
                    error=error_message,
                    generation_time=time.time() - start_time,
                )

            def _usage_success(
                final_output_path: str | None, final_bytes: bytes | None
            ) -> GridGenerationResult:
                generation_time = time.time() - start_time
                if usage_recorded and project_output_dir:
                    update_image_request_status(
                        project_output_dir=project_output_dir,
                        request_id=usage_request_id,
                        status="completed",
                    )
                return GridGenerationResult(
                    success=True,
                    grid_image_path=final_output_path,
                    grid_image_bytes=final_bytes,
                    generation_time=generation_time,
                )

            if project_output_dir:
                record_image_request(
                    project_output_dir=project_output_dir,
                    request_id=usage_request_id,
                    provider=self.provider,
                    model_name=self.model,
                    task_type=task_type,
                    scope=scope,
                    episode=infer_episode_from_path(output_path),
                    beat_num=first_beat_num,
                )
                usage_recorded = True

            # =================================================================
            # Render mode / Sketch mode (a single API call for both)
            # =================================================================

            # 2. Prepare the reference images
            # Per the official Google docs: prompt first, images in a row after
            # https://ai.google.dev/gemini-api/docs/image-generation
            contents = [prompt]  # prompt goes first
            submitted_refs: list[dict] = []

            # Render mode: the sketch must be Image 1. It is the only composition base; character/scene/prop only provide identity and materials.
            # Render mode passes character/identity/scene/prop; Sketch mode passes only scene references.
            # In the sketch stage props keep only the name and marker color, and prop reference images are not passed, to avoid the final
            # material/three-view interfering with blocking.
            if not sketch and previous_grid_path and os.path.exists(previous_grid_path):
                previous_grid_image = self._load_image_as_part(previous_grid_path)
                if previous_grid_image:
                    contents.append(previous_grid_image)
                    submitted_refs.append(
                        {
                            "kind": "previous_grid",
                            "base_id": "sketch",
                            "path": previous_grid_path,
                            "bytes": (
                                os.path.getsize(previous_grid_path)
                                if os.path.exists(previous_grid_path)
                                else None
                            ),
                        }
                    )
                    print(
                        "[NanoBananaPro] Added sketch base image (Image 1 composition lock): "
                        f"{previous_grid_path}"
                    )

            if sketch:
                if use_director_refs:
                    self._append_reference_parts_from_plan(
                        contents,
                        ctx,
                        [],
                        valid_character_map,
                        allowed_kinds={"scene"},
                        verbose=True,
                        audit_refs=submitted_refs,
                    )
                elif scene_refs or prop_asset_refs:
                    self._append_reference_parts_from_plan(
                        contents,
                        ctx,
                        [],
                        valid_character_map,
                        allowed_kinds={"scene"},
                        verbose=True,
                        audit_refs=submitted_refs,
                    )
            elif compose_plan is not None:
                # Sketch-free compose mode: no `ctx` was ever built above
                # (that only happens inside the `if sketch:`/`elif sketch_dir:`
                # branches), so `resolve_render_reference_order(ctx, ...)`
                # below would raise NameError for this path — its own plan
                # already carries the full, correctly-ordered reference-image
                # audit trail from `_build_qwen21_compose_plan()`.
                submitted_refs.extend(compose_plan.audit_refs)
            else:
                ordered_chars = resolve_render_reference_order(
                    ctx, beats, grid_capacity, valid_character_map
                )

                print(f"[NanoBananaPro] Character reference image order: {ordered_chars}")
                self._append_reference_parts_from_plan(
                    contents,
                    ctx,
                    ordered_chars,
                    valid_character_map,
                    allowed_kinds=None,
                    verbose=True,
                    audit_refs=submitted_refs,
                )

            if output_path:
                grid_dir = Path(output_path).parent
                prompts_dir = grid_dir / "prompts"
                prompts_dir.mkdir(parents=True, exist_ok=True)
                grid_basename = Path(output_path).stem
                submitted_file = prompts_dir / f"{grid_basename}.submitted.json"
                submitted_payload = {
                    "provider": self.provider,
                    "model": self.model,
                    "prompt": prompt,
                    "reference_images": submitted_refs,
                }
                submitted_file.write_text(
                    json.dumps(submitted_payload, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
                print(f"[NanoBananaPro] Submitted Prompt/Refs saved: {submitted_file}")

            # contents structure:
            # - Render mode: [prompt, char/scene/prop refs..., sketch (last)]
            # - Regular Sketch mode: [prompt]
            # - Director Sketch mode: [prompt, director scene/prop refs...]

            # 3. Call the API
            # Look up the aspect ratio and resolution from mode_key or RE/tmp/claude-0/-home-user-dramaclaw/57eb0762-a929-5d0a-b399-64cb7e8d2633/scratchpad/gen_MODE_CONFIGS
            if aspect_ratio_override:
                # Regeneration mode: use the explicitly specified aspect_ratio and image_size
                aspect_ratio = aspect_ratio_override
                image_size = image_size_override or "2K"
            elif mode_key:
                _cfg = REGEN_MODE_CONFIGS[mode_key]
                aspect_ratio = _cfg["aspect_ratio"]
                image_size = _cfg["image_size"]
            elif sketch:
                # Sketch mode: use a separate configuration
                aspect_ratio = SKETCH_GRID_CONFIG["aspect_ratio"]
                image_size = SKETCH_GRID_CONFIG["image_size"]
            else:
                # Look up in RE/tmp/claude-0/-home-user-dramaclaw/57eb0762-a929-5d0a-b399-64cb7e8d2633/scratchpad/gen_MODE_CONFIGS from (rows, cols)
                _found = False
                for _mk, _cfg in REGEN_MODE_CONFIGS.items():
                    if _cfg["rows"] == rows and _cfg["cols"] == cols:
                        aspect_ratio = _cfg["aspect_ratio"]
                        image_size = _cfg["image_size"]
                        _found = True
                        break
                if not _found:
                    if rows == cols:
                        aspect_ratio = "1:1"
                        image_size = "4K" if rows >= 4 else "2K"
                    elif rows > cols:
                        aspect_ratio = "9:16"
                        image_size = "4K"
                    else:
                        aspect_ratio = "21:9"
                        image_size = "2K"

            # Selection-level resolution (e.g. "Google Gemini (2K)" in the
            # Image source picker) overrides the grid-shape-driven default
            # above, but an explicit per-call force_image_size still wins.
            if self.force_image_size:
                image_size = self.force_image_size
            if force_image_size:
                image_size = force_image_size

            if self.provider == "openrouter":
                # ===== OpenRouter branch =====
                effective_image_size = normalize_image_size(
                    image_size, provider="openrouter"
                )
                print(
                    f"[NanoBananaPro] Calling OpenRouter ({self.model}) to generate grid image (resolution: {effective_image_size}, ratio: {aspect_ratio})..."
                )
                prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(contents)
                image_bytes, or_text, or_error = await _call_openrouter_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt_text,
                    reference_images=ref_bytes or None,
                    image_config={
                        "aspect_ratio": aspect_ratio, "image_size": effective_image_size,
                    },
                )
                if not image_bytes:
                    message = "OpenRouter API returned no image data"
                    if or_error:
                        message = f"{message}: {or_error}"
                    return _usage_fail(message)
            elif self.provider == "huimeng":
                print(
                    f"[HuiMeng Images] Calling {self.model} to generate grid image (ratio: {aspect_ratio})..."
                )
                prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(contents)
                image_bytes, _text, huimeng_error = await _call_huimeng_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt_text,
                    reference_images=ref_bytes or None,
                    image_config={
                        "aspect_ratio": aspect_ratio,
                        "image_size": image_size,
                        "huimeng_image_quality": self.huimeng_image_quality,
                    },
                )
                if not image_bytes:
                    message = "HuiMeng Images returned no image data"
                    if huimeng_error:
                        message = f"{message}: {huimeng_error}"
                    return _usage_fail(message)
            elif self.provider == "openai":
                # ===== OpenAI Image API branch =====
                openai_image_size = "1K" if sketch else image_size
                openai_size = resolve_openai_image_size(aspect_ratio, openai_image_size)
                print(
                    f"[NanoBananaPro] Calling OpenAI Image API ({self.model}) to generate grid image "
                    f"(size: {openai_size}, ratio: {aspect_ratio})..."
                )
                prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(
                    contents,
                    include_mime=True,
                )
                image_bytes, _openai_text, openai_error = await _call_openai_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt_text,
                    reference_images=ref_bytes or None,
                    image_config={
                        "aspect_ratio": aspect_ratio,
                        "image_size": openai_image_size,
                        "quality": (
                            self.openai_sketch_image_quality
                            if sketch
                            else self.openai_image_quality
                        ),
                        "output_format": "png",
                    },
                )
                if not image_bytes:
                    message = "OpenAI Image API returned no image data"
                    if openai_error:
                        message = f"{message}: {openai_error}"
                    return _usage_fail(message)
            elif self.provider == "newapi":
                effective_image_size = normalize_image_size(
                    image_size, provider="newapi"
                )
                print(
                    f"[DramaClawAPI Images] Calling {self.model} to generate grid image "
                    f"(resolution: {effective_image_size}, ratio: {aspect_ratio})..."
                )
                prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(
                    contents,
                    include_mime=True,
                )
                image_bytes, _text, newapi_error = await _call_newapi_image_api_with_egress(
                    capability="image.generate.grid",
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt_text,
                    reference_images=ref_bytes or None,
                    image_config={
                        "aspect_ratio": aspect_ratio,
                        "image_size": effective_image_size,
                        "quality": (
                            self.openai_sketch_image_quality
                            if sketch
                            else self.openai_image_quality
                        ),
                    "request_schema": self.newapi_request_schema,
                        "model_params": self.newapi_model_params,
                    },
                    base_url=self.base_url,
                    delivery_path=output_path,
                    delivery_state=(image_delivery_state := {}),
                )
                if not image_bytes:
                    message = "DramaClawAPI Images returned no image data"
                    if newapi_error:
                        message = f"{message}: {newapi_error}"
                    return _usage_fail(message)
            elif self.provider == "gemini_webai":
                print(
                    f"[NanoBananaPro] Calling Gemini WebAI ({self.model}) to generate grid image (ratio: {aspect_ratio})..."
                )
                prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(
                    contents,
                    include_mime=True,
                )
                reference_images = [
                    (_webai_ref_filename(i, mime), data, mime)
                    for i, (data, mime) in enumerate(ref_bytes)
                ]
                image_bytes, _text, webai_error = await _call_webai_chat_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt_text,
                    reference_images=reference_images or None,
                    base_url=self.base_url,
                )
                if not image_bytes:
                    message = "Gemini WebAI returned no image data"
                    if webai_error:
                        message = f"{message}: {webai_error}"
                    return _usage_fail(message)
            elif self.provider == "gemini_webai_compose":
                # Sketch-free "compose" mode (added 2026-10-21, see
                # GEMINI_WEBAI_COMPOSE_SELECTION_KEYS in config.py and
                # _build_gemini_compose_plan()'s docstring) — mirrors the
                # runpod_qwen21_compose branch below, but calling the
                # plain Gemini WebAI chat-image endpoint instead of a
                # RunPod ComfyUI job. `compose_plan` was already fully
                # built in the prompt-building chain above (scene
                # background first in reference_images, same as every
                # other `_call_webai_chat_image_api` caller expects —
                # that call has no "canvas" concept, so a background photo
                # works exactly like any other reference image here).
                if sketch or compose_plan is None:
                    return _usage_fail("Gemini WebAI compose selection can only be used in the Render stage")
                print(
                    f"[NanoBananaPro] calling Gemini WebAI ({self.model}) (compose, no sketch) to generate image "
                    f"({len(compose_plan.reference_images)} reference image(s))..."
                )
                image_bytes, _text, webai_error = await _call_webai_chat_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=compose_plan.prompt,
                    reference_images=compose_plan.reference_images,
                    base_url=self.base_url,
                )
                if output_path:
                    try:
                        submitted_file.write_text(
                            json.dumps(
                                {
                                    **submitted_payload,
                                    "gemini_compose_prompt": compose_plan.prompt,
                                    "render_provider": "gemini_webai_compose",
                                },
                                ensure_ascii=False,
                                indent=2,
                            ),
                            encoding="utf-8",
                        )
                    except NameError:
                        pass
                if not image_bytes:
                    message = "Gemini WebAI compose did not return image data"
                    if webai_error:
                        message = f"{message}: {webai_error}"
                    return _usage_fail(message)
            elif self.provider == "qwen":
                print(
                    f"[NanoBananaPro] Calling Qwen Image ({self.model}) to generate grid image "
                    f"(resolution: {image_size}, ratio: {aspect_ratio})..."
                )
                prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(
                    contents,
                    include_mime=True,
                )
                reference_images = [
                    (_webai_ref_filename(i, mime), data, mime)
                    for i, (data, mime) in enumerate(ref_bytes)
                ]
                image_bytes, _text, qwen_error = await _call_qwen_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt_text,
                    reference_images=reference_images or None,
                    image_config={"aspect_ratio": aspect_ratio, "image_size": image_size},
                    base_url=self.base_url,
                )
                if not image_bytes:
                    message = "Qwen Image returned no image data"
                    if qwen_error:
                        message = f"{message}: {qwen_error}"
                    return _usage_fail(message)
            elif self.provider == "runpod_qwen":
                print(
                    f"[NanoBananaPro] Calling RunPod Qwen Image 2.1 to generate grid image "
                    f"(resolution: {image_size}, ratio: {aspect_ratio})..."
                )
                prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(
                    contents,
                    include_mime=True,
                )
                reference_images = [
                    (_webai_ref_filename(i, mime), data, mime)
                    for i, (data, mime) in enumerate(ref_bytes)
                ]
                image_bytes, _text, runpod_qwen_error = await _call_runpod_qwen_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt_text,
                    reference_images=reference_images or None,
                    image_config={"aspect_ratio": aspect_ratio, "image_size": image_size},
                    base_url=self.base_url,
                )
                if not image_bytes:
                    message = "RunPod Qwen Image returned no image data"
                    if runpod_qwen_error:
                        message = f"{message}: {runpod_qwen_error}"
                    return _usage_fail(message)
            elif self.provider == "runpod_qwen_edit":
                # Render-only (see config.py RUNPOD_QWEN_EDIT_SELECTION_KEYS):
                # needs the sketch as the edit canvas + exactly one identity
                # reference — extra refs (scene/prop) are dropped here, same
                # as the 2-image setup verified end-to-end 2026-10-14. A
                # Qwen-specific prompt is used instead of the shared
                # storyboard-grid prompt (see build_qwen_edit_render_prompt).
                print(
                    f"[NanoBananaPro] Calling RunPod Qwen Image Edit 2511 to generate grid image "
                    f"(ratio: {aspect_ratio}, multi_character={self.qwen_edit_multi_character})..."
                )
                _prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(
                    contents,
                    include_mime=True,
                )
                if not ref_bytes:
                    return _usage_fail("RunPod Qwen Image Edit 2511 is missing the sketch input")
                _canvas_bytes, _canvas_mime = ref_bytes[0]
                _qwen_edit_prompts_used: dict = {}
                if self.qwen_edit_multi_character:
                    # Two-pass path for beats with more than one character
                    # in the sketch — see _qwen_edit_multi_character_render
                    # module docstring for why a single text-prompt pass
                    # (tried twice, both failed on beat 6) was replaced with
                    # this. Identity portraits are resolved by
                    # qwen_edit_identity_references(), the same lookup the
                    # render/review endpoint uses.
                    (
                        image_bytes,
                        _text,
                        runpod_edit_error,
                        _qwen_edit_prompts_used,
                    ) = await _qwen_edit_multi_character_render(
                        api_key=self.api_key,
                        model=self.model,
                        canvas_bytes=_canvas_bytes,
                        canvas_mime=_canvas_mime,
                        beats=beats,
                        grid_capacity=grid_capacity,
                        character_map=character_map,
                        scene_prompt_override=(qwen_edit_prompts or {}).get("scene_prompt", ""),
                        inpaint_prompts_override=(qwen_edit_prompts or {}).get("inpaint_prompts"),
                    )
                else:
                    edit_prompt = (qwen_edit_prompts or {}).get(
                        "full_prompt"
                    ) or build_qwen_edit_render_prompt(beats[:grid_capacity], stage="full")
                    _qwen_edit_prompts_used = {"full_prompt": edit_prompt}
                    # Prefer the detected identity's own resolved portrait
                    # (same lookup render/review uses) over whatever
                    # happened to be first in the Gemini-oriented
                    # reference-image plan.
                    primary_beat = (beats[:grid_capacity] or [None])[0] or {}
                    picked_ref = qwen_edit_load_identity_ref_bytes(character_map, primary_beat)
                    if picked_ref:
                        reference_images = [
                            (_webai_ref_filename(0, _canvas_mime), _canvas_bytes, _canvas_mime),
                            picked_ref,
                        ]
                    else:
                        reference_images = [
                            (_webai_ref_filename(i, mime), data, mime)
                            for i, (data, mime) in enumerate(ref_bytes[:2])
                        ]
                    image_bytes, _text, runpod_edit_error = await _call_runpod_qwen_edit_image_api(
                        api_key=self.api_key,
                        model=self.model,
                        prompt=edit_prompt,
                        reference_images=reference_images,
                    )
                if output_path:
                    try:
                        submitted_file.write_text(
                            json.dumps(
                                {**submitted_payload, "qwen_edit_prompts_used": _qwen_edit_prompts_used},
                                ensure_ascii=False,
                                indent=2,
                            ),
                            encoding="utf-8",
                        )
                    except NameError:
                        pass
                if not image_bytes:
                    message = "RunPod Qwen Image Edit 2511 returned no image data"
                    if runpod_edit_error:
                        message = f"{message}: {runpod_edit_error}"
                    return _usage_fail(message)
            elif self.provider == "runpod_qwen21_render":
                # Render-only (RUNPOD_QWEN21_RENDER_SELECTION_KEYS, config.py)
                # — Qwen-Image 2.1, fixed for identity-swap-onto-sketch (see
                # module comment above _runpod_qwen21_render_image_graph for
                # the two bugs this fixes vs. the shared `runpod_qwen`
                # sketch/character/scene/prop path). Mirrors the
                # runpod_qwen_edit branch above exactly; only the
                # API caller/prompt builder/multi-character wrapper differ.
                if sketch:
                    return _usage_fail("The Qwen Image 2.1 render selection can only be used in the Render stage")
                print(
                    f"[NanoBananaPro] Calling RunPod Qwen Image 2.1 (render) to generate grid image "
                    f"(ratio: {aspect_ratio}, multi_character={self.qwen_edit_multi_character})..."
                )
                _prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(
                    contents,
                    include_mime=True,
                )
                if not ref_bytes:
                    return _usage_fail("RunPod Qwen Image 2.1 render is missing the sketch input")
                _canvas_bytes, _canvas_mime = ref_bytes[0]
                _qwen21_prompts_used: dict = {}
                if self.qwen_edit_multi_character:
                    (
                        image_bytes,
                        _text,
                        runpod_qwen21_error,
                        _qwen21_prompts_used,
                    ) = await _qwen21_multi_character_render(
                        api_key=self.api_key,
                        model=self.model,
                        canvas_bytes=_canvas_bytes,
                        canvas_mime=_canvas_mime,
                        beats=beats,
                        grid_capacity=grid_capacity,
                        character_map=character_map,
                        scene_prompt_override=(qwen_edit_prompts or {}).get("scene_prompt", ""),
                        inpaint_prompts_override=(qwen_edit_prompts or {}).get("inpaint_prompts"),
                    )
                else:
                    render_prompt = (qwen_edit_prompts or {}).get(
                        "full_prompt"
                    ) or build_qwen21_render_prompt(beats[:grid_capacity], stage="full")
                    _qwen21_prompts_used = {"full_prompt": render_prompt}
                    primary_beat = (beats[:grid_capacity] or [None])[0] or {}
                    picked_ref = qwen_edit_load_identity_ref_bytes(character_map, primary_beat)
                    if picked_ref:
                        reference_images = [
                            (_webai_ref_filename(0, _canvas_mime), _canvas_bytes, _canvas_mime),
                            picked_ref,
                        ]
                    else:
                        reference_images = [
                            (_webai_ref_filename(i, mime), data, mime)
                            for i, (data, mime) in enumerate(ref_bytes[:2])
                        ]
                    (
                        image_bytes,
                        _text,
                        runpod_qwen21_error,
                    ) = await _call_runpod_qwen21_render_image_api(
                        api_key=self.api_key,
                        model=self.model,
                        prompt=render_prompt,
                        reference_images=reference_images,
                    )
                if output_path:
                    try:
                        submitted_file.write_text(
                            json.dumps(
                                {
                                    **submitted_payload,
                                    "qwen_edit_prompts_used": _qwen21_prompts_used,
                                    "render_provider": "runpod_qwen21_render",
                                },
                                ensure_ascii=False,
                                indent=2,
                            ),
                            encoding="utf-8",
                        )
                    except NameError:
                        pass
                if not image_bytes:
                    message = "RunPod Qwen Image 2.1 render returned no image data"
                    if runpod_qwen21_error:
                        message = f"{message}: {runpod_qwen21_error}"
                    return _usage_fail(message)
            elif self.provider == "runpod_qwen21_compose":
                # Sketch-free "compose" mode (added 2026-10-18, see
                # RUNPOD_QWEN21_COMPOSE_SELECTION_KEYS in config.py and
                # _build_qwen21_compose_plan()'s docstring). No mask, no
                # 2-pass inpaint, no canvas-from-sketch — `compose_plan`
                # was already fully built in the prompt-building chain
                # above, so this just makes the one RunPod call with its
                # ordered reference_images (scene background first). No
                # graph/API-level changes were needed for this: today's
                # real-GPU standalone test already exercised exactly this
                # same `_call_runpod_qwen21_render_image_api()` call shape
                # (reference_images[0] generically becomes `image_1`,
                # whether it's a sketch or — here — a scene background).
                if sketch or compose_plan is None:
                    return _usage_fail("The Qwen Image 2.1 compose selection can only be used in the Render stage")
                print(
                    f"[NanoBananaPro] Calling RunPod Qwen Image 2.1 (compose, no sketch) to generate image "
                    f"({len(compose_plan.reference_images)} reference images)..."
                )
                (
                    image_bytes,
                    _text,
                    runpod_qwen21_error,
                ) = await _call_runpod_qwen21_render_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=compose_plan.prompt,
                    reference_images=compose_plan.reference_images,
                )
                if output_path:
                    try:
                        submitted_file.write_text(
                            json.dumps(
                                {
                                    **submitted_payload,
                                    "qwen21_compose_prompt": compose_plan.prompt,
                                    "render_provider": "runpod_qwen21_compose",
                                },
                                ensure_ascii=False,
                                indent=2,
                            ),
                            encoding="utf-8",
                        )
                    except NameError:
                        pass
                if not image_bytes:
                    message = "RunPod Qwen Image 2.1 compose returned no image data"
                    if runpod_qwen21_error:
                        message = f"{message}: {runpod_qwen21_error}"
                    return _usage_fail(message)
            else:
                # ===== Google direct branch =====
                # Pick the config by model: gemini-3 supports image_size, gemini-2.5 does not
                is_gemini3 = "gemini-3" in self.model
                if is_gemini3:
                    effective_image_size = normalize_image_size(
                        image_size, provider="google"
                    )
                    print(
                        f"[NanoBananaPro] Calling {self.model} to generate grid image (resolution: {effective_image_size}, ratio: {aspect_ratio})..."
                    )
                    image_config = types.ImageConfig(
                        aspect_ratio=aspect_ratio,
                        image_size=effective_image_size,
                    )
                else:
                    # gemini-2.5-flash-image does not support the image_size parameter
                    print(
                        f"[NanoBananaPro] Calling {self.model} to generate grid image (ratio: {aspect_ratio})..."
                    )
                    image_config = types.ImageConfig(
                        aspect_ratio=aspect_ratio,
                    )

                # Configure thinking (on by default in the web version; the API needs explicit configuration)
                # Note: image-preview models do not support thinking
                is_image_model = "image-preview" in self.model
                if is_image_model:
                    # image-preview models do not support thinking
                    thinking_config = None
                elif is_gemini3:
                    # Gemini 3 uses thinking_level
                    thinking_config = types.ThinkingConfig(
                        thinking_level=types.ThinkingLevel.HIGH
                    )
                else:
                    # Gemini 2.5 models use thinking_budget (minimum 128)
                    thinking_config = types.ThinkingConfig(thinking_budget=1024)

                # Build the config
                gen_config = types.GenerateContentConfig(
                    response_modalities=["IMAGE", "TEXT"],
                    image_config=image_config,
                )
                if thinking_config:
                    gen_config = types.GenerateContentConfig(
                        response_modalities=["IMAGE", "TEXT"],
                        image_config=image_config,
                        thinking_config=thinking_config,
                    )

                response = await asyncio.to_thread(
                    client.models.generate_content,
                    model=self.model,
                    contents=contents,
                    config=gen_config,
                )

                # 4. Extract the image data
                image_bytes = None

                # Check the response structure
                if not response.candidates:
                    print(f"[NanoBananaPro] API response has no candidates: {response}")
                    return _usage_fail(f"API response has no candidates: {response}")

                candidate = response.candidates[0]
                if not candidate.content:
                    print(
                        f"[NanoBananaPro] candidate has no content: finish_reason={getattr(candidate, 'finish_reason', 'unknown')}"
                    )
                    # Print safety ratings (if any)
                    if (
                        hasattr(candidate, "safety_ratings") and candidate.safety_ratings
                    ):
                        for rating in candidate.safety_ratings:
                            print(f"[NanoBananaPro] safety_rating: {rating}")
                    return _usage_fail(
                        f"API response has no content, finish_reason={getattr(candidate, 'finish_reason', 'unknown')}"
                    )

                if not candidate.content.parts:
                    print(
                        f"[NanoBananaPro] content has no parts: {candidate.content}, finish_reason={getattr(candidate, 'finish_reason', 'unknown')}"
                    )
                    # Print the full candidate object for debugging
                    print(f"[NanoBananaPro] Full candidate: {candidate}")
                    return _usage_fail("API response content has no parts")

                text_parts = []
                for part in candidate.content.parts:
                    if hasattr(part, "inline_data") and part.inline_data:
                        image_bytes = part.inline_data.data
                    # Collect the text response
                    if hasattr(part, "text") and part.text:
                        text_parts.append(part.text)
                        print(f"[NanoBananaPro] API text response: {part.text[:500]}")

                if not image_bytes:
                    return _usage_fail("API returned no image data")

            # 5. Save the file
            if output_path:
                output_dir = os.path.dirname(output_path)
                if output_dir:
                    os.makedirs(output_dir, exist_ok=True)
                if not (self.provider == "newapi" and image_delivery_state.get("copied")):
                    with open(output_path, "wb") as f:
                        f.write(image_bytes)
                print(f"[NanoBananaPro] Grid image saved: {output_path}")

                # 5.1 Post-processing: remove the gaps between panels and overwrite
                try:
                    from novelvideo.generators.grid_splitter import remove_grid_gaps
                    from PIL import Image as PILImage

                    grid_img = PILImage.open(output_path)
                    processed_grid = remove_grid_gaps(grid_img, rows, cols)
                    if processed_grid is not grid_img:
                        processed_grid.save(output_path)
                    # Update image_bytes to keep the return value consistent
                    with open(output_path, "rb") as f:
                        image_bytes = f.read()
                    print(f"[NanoBananaPro] Gap removal post-processing complete: {output_path}")
                except Exception as e:
                    print(f"[NanoBananaPro] Gap removal failed, keeping the original image: {e}")

            generation_time = time.time() - start_time
            print(f"[NanoBananaPro] Generation complete, took {generation_time:.1f}s")

            return _usage_success(output_path, image_bytes)

        except ImportError:
            return GridGenerationResult(
                success=False,
                error="Please install google-genai: pip install google-genai",
                generation_time=time.time() - start_time,
            )
        except Exception as e:
            if (
                "usage_recorded" in locals()
                and usage_recorded
                and "project_output_dir" in locals()
                and project_output_dir
            ):
                update_image_request_status(
                    project_output_dir=project_output_dir,
                    request_id=usage_request_id,
                    status="failed",
                    error_message=str(e),
                )
            if is_fatal_billing_error(e):
                raise
            return GridGenerationResult(
                success=False,
                error=str(e),
                generation_time=time.time() - start_time,
            )

    async def generate_action_grid(
        self,
        action_description: str,
        character_map: Dict[str, dict] = None,
        style: str = None,
        output_path: Optional[str] = None,
        ethnicity: str = "Chinese",
        mode_key: str = "5x5_2-3_sketch",
    ) -> GridGenerationResult:
        """Generate a 5x5 continuous storyboard sketch grid for an action beat.

        Differences from generate_grid:
        - All 25 panels are a continuous storyboard sequence of the same action (not different beats)
        - Uses the ACTION_STORYBOARD prompt mode
        - Fixed 5x5 grid

        Args:
            action_description: action description (with {{identity_id}} markers)
            character_map: character mapping (used for color coding)
            style: style name
            output_path: output path
            ethnicity: character ethnicity
            mode_key: grid mode (default 5x5_2-3_sketch)

        Returns:
            GridGenerationResult
        """
        start_time = time.time()
        character_map = character_map or {}

        if style is None:
            style = IMAGE_DEFAULT_STYLE

        mode_cfg = REGEN_MODE_CONFIGS.get(mode_key, REGEN_MODE_CONFIGS["5x5_2-3_sketch"])
        rows = mode_cfg["rows"]
        cols = mode_cfg["cols"]
        print(f"[ActionGrid] Generating {rows}x{cols} action storyboard, style: {style}")

        # Build a pseudo beat list (a single action beat expanded into 25 panel placeholders)
        action_beat = {
            "beat_number": 1,
            "visual_description": action_description,
            "audio_type": "silence",
            "scene_id": "",
        }
        beats = [action_beat]

        # Filter the character map to the characters appearing in the action description
        valid_character_map = filter_character_map_for_beats(character_map, beats)

        # Build the ACTION_STORYBOARD prompt
        style_family, animation_subtype = StyleService.get_style_branch(
            style or IMAGE_DEFAULT_STYLE
        )
        ctx = create_prompt_context(
            mode=PromptMode.ACTION_STORYBOARD,
            beats=beats,
            rows=rows,
            cols=cols,
            character_map=valid_character_map,
            style=style,
            ethnicity=ethnicity,
            aspect_ratio=mode_cfg.get("aspect_ratio", "2:3"),
            style_family=style_family,
            animation_subtype=animation_subtype,
        )
        builder = UnifiedPromptBuilder(ctx)
        prompt = builder.build()

        # Save the prompt
        if output_path:
            prompts_dir = Path(output_path).parent / "prompts"
            prompts_dir.mkdir(parents=True, exist_ok=True)
            prompt_file = prompts_dir / f"{Path(output_path).stem}.prompt.txt"
            prompt_file.write_text(prompt, encoding="utf-8")

        try:
            # Prepare the reference images (character references)
            contents = [prompt]
            for char_name, info in valid_character_map.items():
                ref_path = info.get("ref_path") or info.get("portrait_path")
                if ref_path and os.path.exists(ref_path):
                    img_part = self._load_image_as_part(ref_path)
                    if img_part:
                        contents.append(img_part)

            # Call the API
            image_size = mode_cfg.get("image_size", "1K")
            aspect_ratio = mode_cfg.get("aspect_ratio", "2:3")
            if self.provider == "openrouter":
                prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(contents)
                image_bytes, _, error_detail = await _call_openrouter_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt_text,
                    reference_images=ref_bytes or None,
                    image_config={
                        "aspect_ratio": aspect_ratio,
                        "image_size": image_size,
                        "huimeng_image_quality": self.huimeng_image_quality,
                    },
                )
                if not image_bytes:
                    return GridGenerationResult(
                        success=False,
                        error=f"OpenRouter API returned no image: {error_detail or ''}".strip(),
                        generation_time=time.time() - start_time,
                    )
            elif self.provider == "huimeng":
                prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(contents)
                image_bytes, _, error_detail = await _call_huimeng_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt_text,
                    reference_images=ref_bytes or None,
                    image_config={"aspect_ratio": aspect_ratio, "image_size": image_size},
                )
                if not image_bytes:
                    return GridGenerationResult(
                        success=False,
                        error=f"HuiMeng Images returned no image: {error_detail or ''}".strip(),
                        generation_time=time.time() - start_time,
                    )
            elif self.provider == "openai":
                prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(
                    contents,
                    include_mime=True,
                )
                image_bytes, _, error_detail = await _call_openai_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt_text,
                    reference_images=ref_bytes or None,
                    image_config={
                        "aspect_ratio": aspect_ratio,
                        "image_size": image_size,
                        "quality": self.openai_sketch_image_quality,
                        "output_format": "png",
                    },
                )
                if not image_bytes:
                    return GridGenerationResult(
                        success=False,
                        error=f"OpenAI Image API returned no image: {error_detail or ''}".strip(),
                        generation_time=time.time() - start_time,
                    )
            elif self.provider == "newapi":
                prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(
                    contents,
                    include_mime=True,
                )
                image_bytes, _, error_detail = await _call_newapi_image_api_with_egress(
                    capability="image.generate.action_grid",
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt_text,
                    reference_images=ref_bytes or None,
                    image_config={
                        "aspect_ratio": aspect_ratio,
                        "image_size": image_size,
                        "quality": self.openai_sketch_image_quality,
                    },
                    base_url=self.base_url,
                    delivery_path=output_path,
                    delivery_state=(image_delivery_state := {}),
                )
                if not image_bytes:
                    return GridGenerationResult(
                        success=False,
                        error=f"DramaClawAPI Images returned no image: {error_detail or ''}".strip(),
                        generation_time=time.time() - start_time,
                    )
            else:
                from google import genai
                from google.genai import types

                client = genai.Client(api_key=self.api_key)
                response = await asyncio.to_thread(
                    client.models.generate_content,
                    model=self.model,
                    contents=contents,
                    config=types.GenerateContentConfig(
                        response_modalities=["TEXT", "IMAGE"],
                        image_generation_config=types.ImageGenerationConfig(
                            image_size=image_size,
                        ),
                    ),
                )

                # Extract the image
                image_bytes = None
                for part in response.candidates[0].content.parts:
                    if part.inline_data and part.inline_data.mime_type.startswith("image/"):
                        image_bytes = part.inline_data.data
                        break

            if not image_bytes:
                return GridGenerationResult(
                    success=False,
                    error="API returned no image",
                    generation_time=time.time() - start_time,
                )

            # Save the grid image
            if output_path:
                os.makedirs(os.path.dirname(output_path), exist_ok=True)
                if not (self.provider == "newapi" and image_delivery_state.get("copied")):
                    with open(output_path, "wb") as f:
                        f.write(image_bytes)

                # Gap removal post-processing
                try:
                    from novelvideo.generators.grid_splitter import remove_grid_gaps
                    from PIL import Image as PILImage

                    grid_img = PILImage.open(output_path)
                    processed_grid = remove_grid_gaps(grid_img, rows, cols)
                    if processed_grid is not grid_img:
                        processed_grid.save(output_path)
                    with open(output_path, "rb") as f:
                        image_bytes = f.read()
                except Exception as e:
                    print(f"[ActionGrid] Gap removal failed, keeping the original image: {e}")

            generation_time = time.time() - start_time
            print(f"[ActionGrid] Generation complete, took {generation_time:.1f}s")

            return GridGenerationResult(
                success=True,
                grid_image_path=output_path,
                grid_image_bytes=image_bytes,
                generation_time=generation_time,
                grid_rows=rows,
                grid_cols=cols,
            )

        except Exception as e:
            return GridGenerationResult(
                success=False,
                error=str(e),
                generation_time=time.time() - start_time,
            )

    async def reformat_sketch(
        self,
        source_path: str,
        output_path: str,
        target_aspect: str = "9:16",
        target_size: str = "1K",
        rows: int = 0,
        cols: int = 0,
    ) -> GridGenerationResult:
        """Second pass: keep the storyboard composition and convert the aspect ratio (1:1 -> 9:16).

        Read the full prompt saved by Pass 1 and send it to Gemini together with the sketch,
        so the model understands the content of each panel and only changes the ratio without losing information.

        Args:
            source_path: 1:1 sketch path generated by Pass 1
            output_path: output 9:16 sketch path
            target_aspect: target aspect ratio
            target_size: target resolution
            rows: number of grid rows (0 = infer from the filename)
            cols: number of grid columns (0 = infer from the filename)

        Returns:
            GridGenerationResult
        """
        start_time = time.time()
        try:
            # Use the passed rows/cols, otherwise infer from the path (format: sketch_g0_5x5_pass1.jpg)
            if rows and cols:
                grid_rows, grid_cols = rows, cols
            else:
                _m = re.search(r"(\d+)x(\d+)", os.path.basename(source_path))
                grid_rows = int(_m.group(1)) if _m else 5
                grid_cols = int(_m.group(2)) if _m else 5

            # Read the full prompt saved by Pass 1 (generate_grid automatically stores it in the prompts/ directory)
            source_dir = Path(source_path).parent
            source_stem = Path(source_path).stem  # e.g. "sketch_g0_5x5_pass1"
            prompt_file = source_dir / "prompts" / f"{source_stem}.prompt.txt"

            original_prompt = ""
            if prompt_file.exists():
                original_prompt = prompt_file.read_text(encoding="utf-8")
                print(
                    f"[Reformat] Read Pass 1 prompt: {prompt_file} ({len(original_prompt)} chars)"
                )

            # reformat_sketch now only handles outpaint (1:1 -> 2:3)
            # 9:16 has switched to direct one-pass generation and no longer goes through two-pass
            reformat_instruction = (
                f"This is a {grid_rows}x{grid_cols} storyboard grid where each panel is 1:1 (square).\n"
                f"OUTPAINT every panel from 1:1 to {target_aspect} — extend each scene vertically "
                f"(add space above and below) while keeping the original content centered.\n"
                f"Do NOT crop, stretch, or rearrange. Just extend each panel's background/environment vertically."
            )
            if original_prompt:
                import re as _re

                structural_prompt = original_prompt
                cut_tail = _re.search(
                    r"\n(?:DIRECTING GUIDELINES|SCENE DESCRIPTIONS)",
                    structural_prompt,
                )
                if cut_tail:
                    structural_prompt = structural_prompt[: cut_tail.start()]
                structural_prompt = _re.sub(
                    r"\nROLE:.*?(?=\nSTYLE:|\nLAYOUT:)",
                    "",
                    structural_prompt,
                    flags=_re.DOTALL,
                )
                prompt = f"{reformat_instruction}\n\n{structural_prompt}"
                print(
                    f"[Reformat] Outpaint mode, prompt trimmed: {len(original_prompt)} -> {len(prompt)} chars"
                )
            else:
                prompt = reformat_instruction

            # Save the Pass 2 prompt to a file (for auditing)
            output_stem = Path(output_path).stem  # e.g. "sketch_g0_5x5"
            pass2_prompt_file = source_dir / "prompts" / f"{output_stem}.prompt.txt"
            pass2_prompt_file.parent.mkdir(parents=True, exist_ok=True)
            pass2_prompt_file.write_text(prompt, encoding="utf-8")
            print(f"[Reformat] Pass 2 Prompt saved: {pass2_prompt_file} ({len(prompt)} chars)")

            ref_image = self._load_image_as_part(source_path)
            contents = [prompt, ref_image]

            if self.provider == "openrouter":
                # ===== OpenRouter branch =====
                print(f"[Reformat] Calling OpenRouter ({self.model}) to convert -> {target_aspect} ...")
                prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(contents)
                image_bytes, _or_text, _or_error = await _call_openrouter_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt_text,
                    reference_images=ref_bytes or None,
                    image_config={
                        "aspect_ratio": target_aspect,
                        "image_size": target_size,
                        "huimeng_image_quality": self.huimeng_image_quality,
                    },
                )
                if not image_bytes:
                    return GridGenerationResult(
                        success=False,
                        error=(
                            f"[Reformat] OpenRouter API returned no image data: {_or_error}"
                            if _or_error
                            else "[Reformat] OpenRouter API returned no image data"
                        ),
                        generation_time=time.time() - start_time,
                    )
            elif self.provider == "huimeng":
                print(f"[Reformat] Calling HuiMeng Images ({self.model}) to convert -> {target_aspect} ...")
                prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(contents)
                image_bytes, _text, huimeng_error = await _call_huimeng_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt_text,
                    reference_images=ref_bytes or None,
                    image_config={"aspect_ratio": target_aspect, "image_size": target_size},
                )
                if not image_bytes:
                    return GridGenerationResult(
                        success=False,
                        error=(
                            f"[Reformat] HuiMeng Images returned no image data: {huimeng_error}"
                            if huimeng_error
                            else "[Reformat] HuiMeng Images returned no image data"
                        ),
                        generation_time=time.time() - start_time,
                    )
            elif self.provider == "openai":
                # ===== OpenAI Image API branch =====
                print(f"[Reformat] Calling OpenAI Image API ({self.model}) to convert -> {target_aspect} ...")
                prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(
                    contents,
                    include_mime=True,
                )
                image_bytes, _openai_text, openai_error = await _call_openai_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt_text,
                    reference_images=ref_bytes or None,
                    image_config={
                        "aspect_ratio": target_aspect,
                        "image_size": target_size,
                        "output_format": "png",
                    },
                )
                if not image_bytes:
                    return GridGenerationResult(
                        success=False,
                        error=(
                            f"[Reformat] OpenAI Image API returned no image data: {openai_error}"
                            if openai_error
                            else "[Reformat] OpenAI Image API returned no image data"
                        ),
                        generation_time=time.time() - start_time,
                    )
            elif self.provider == "newapi":
                print(f"[Reformat] Calling DramaClawAPI Images ({self.model}) to convert -> {target_aspect} ...")
                prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(
                    contents,
                    include_mime=True,
                )
                image_bytes, _text, newapi_error = await _call_newapi_image_api_with_egress(
                    capability="image.edit.sketch_reformat",
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt_text,
                    reference_images=ref_bytes or None,
                    image_config={
                        "aspect_ratio": target_aspect,
                        "image_size": target_size,
                        "quality": self.openai_image_quality,
                    },
                    base_url=self.base_url,
                    delivery_path=output_path,
                    delivery_state=(image_delivery_state := {}),
                )
                if not image_bytes:
                    return GridGenerationResult(
                        success=False,
                        error=(
                            f"[Reformat] DramaClawAPI Images returned no image data: {newapi_error}"
                            if newapi_error
                            else "[Reformat] DramaClawAPI Images returned no image data"
                        ),
                        generation_time=time.time() - start_time,
                    )
            else:
                # ===== Google direct branch =====
                from google import genai
                from google.genai import types

                client = genai.Client(api_key=self.api_key)

                is_gemini3 = "gemini-3" in self.model
                if is_gemini3:
                    image_config = types.ImageConfig(
                        aspect_ratio=target_aspect,
                        image_size=target_size,
                    )
                else:
                    image_config = types.ImageConfig(
                        aspect_ratio=target_aspect,
                    )

                gen_config = types.GenerateContentConfig(
                    response_modalities=["IMAGE", "TEXT"],
                    image_config=image_config,
                )

                print(f"[Reformat] Calling {self.model} to convert -> {target_aspect} ...")
                response = await asyncio.to_thread(
                    client.models.generate_content,
                    model=self.model,
                    contents=contents,
                    config=gen_config,
                )

                # Extract the image
                image_bytes = None
                if not response.candidates or not response.candidates[0].content:
                    return GridGenerationResult(
                        success=False,
                        error="[Reformat] API response has no valid content",
                        generation_time=time.time() - start_time,
                    )

                for part in response.candidates[0].content.parts:
                    if hasattr(part, "inline_data") and part.inline_data:
                        image_bytes = part.inline_data.data
                        break

                if not image_bytes:
                    return GridGenerationResult(
                        success=False,
                        error="[Reformat] API returned no image data",
                        generation_time=time.time() - start_time,
                    )

            # Save
            output_dir = os.path.dirname(output_path)
            if output_dir:
                os.makedirs(output_dir, exist_ok=True)
            if not (self.provider == "newapi" and image_delivery_state.get("copied")):
                with open(output_path, "wb") as f:
                    f.write(image_bytes)

            generation_time = time.time() - start_time
            print(f"[Reformat] Done -> {output_path}, took {generation_time:.1f}s")

            return GridGenerationResult(
                success=True,
                grid_image_path=output_path,
                grid_image_bytes=image_bytes,
                generation_time=generation_time,
            )

        except Exception as e:
            return GridGenerationResult(
                success=False,
                error=f"[Reformat] {e}",
                generation_time=time.time() - start_time,
            )

    async def prepare_batch_request(
        self,
        beats: List[dict],
        character_map: Dict[str, dict] = None,
        scene_menu: list[dict] | list | None = None,
        prop_menu: list[dict] | list | None = None,
        sketch_colors: Dict[str, str] = None,
        style: str = None,
        output_path: str = "",
        ethnicity: str = "Chinese",
        rows: int = None,
        cols: int = None,
        sketch: bool = False,
        beat_start_index: int = 0,
        total_episode_beats: int = 0,
        location_beat_numbers: List[int] = None,
        sketch_dir: str = "",
        mode_key: Optional[str] = None,
        beat_sketch_paths: dict = None,
        sketch_aspect_padding: bool = False,
        force_image_size: Optional[str] = None,
        use_director_refs: bool = False,
        director_control_frames_dir: str | Path | None = None,
    ) -> dict:
        """Prepare a single Batch API request (build the prompt + contents, without calling the API).

        Reuses the prompt building and reference image logic of generate_grid(), returning a dict
        for generate_batch_api() to submit in a batch.

        Returns:
            {
                "contents": [...],       # prompt + reference image Part objects
                "rows": int,
                "cols": int,
                "aspect_ratio": str,
                "image_size": str,
                "output_path": str,
                "beat_start_index": int,
                "actual_beat_count": int,
            }
        """
        # Call generate_grid's prompt_only mode to get the prompt
        # but we need the full contents, so its logic is reused directly
        rows = rows or self.rows
        cols = cols or self.cols
        grid_capacity = rows * cols
        character_map = character_map or {}

        if style is None:
            style = IMAGE_DEFAULT_STYLE

        actual_beat_count = min(len(beats), grid_capacity)
        if not sketch and sketch_dir:
            detection_error = render_ai_detection_error(beats[:grid_capacity])
            if detection_error:
                raise RuntimeError(detection_error)

        # Verify the reference images
        valid_character_map = {}
        for char_name, info in character_map.items():
            char_info = dict(info)
            ref_path = info.get("ref_path") or info.get("portrait_path")
            upstream_mode = info.get("reference_mode", "prompt_only")

            if upstream_mode == "composite" and ref_path and os.path.exists(ref_path):
                char_info["reference_path"] = ref_path
                char_info["reference_mode"] = "composite"
                valid_character_map[char_name] = char_info
            elif ref_path and os.path.exists(ref_path):
                char_info["reference_path"] = ref_path
                char_info["reference_mode"] = "portrait_only"
                valid_character_map[char_name] = char_info
            else:
                char_info["reference_path"] = None
                char_info["reference_mode"] = "prompt_only"
                valid_character_map[char_name] = char_info

        # Build the Prompt (reusing UnifiedPromptBuilder)
        previous_grid_path = None
        project_dir = _infer_project_dir(output_path, sketch_dir)
        episode_number = infer_episode_from_path(output_path) or infer_episode_from_path(sketch_dir)
        scene_refs: dict[int, list[Any]] = {}
        prop_asset_refs: dict[int, list[Any]] = {}
        scene_refs, prop_asset_refs = _resolve_scene_prop_asset_refs(
            project_dir,
            beats[:grid_capacity],
            episode_number=episode_number,
            sketch=sketch,
            use_director_refs=use_director_refs,
            include_pano_view_refs=False,
            director_control_frames_dir=director_control_frames_dir,
            scene_menu=scene_menu,
            prop_menu=prop_menu,
            allow_beat_background_anchor=(
                actual_beat_count == 1 and int(rows or 0) == 1 and int(cols or 0) == 1
            ),
        )
        if sketch and use_director_refs:
            if actual_beat_count != 1 or rows != 1 or cols != 1:
                raise RuntimeError(
                    "Director reference mode only supports a single beat 1x1; for batch sketches, export the corresponding DirectorWorld control images first."
                )
            if not _has_director_image_ref(scene_refs, panel_idx=1):
                raise RuntimeError(
                    "Director single shot is missing the beat-level 3GS control frame; " "the sketch main line no longer falls back to the old scene reference images."
                )
            _prepare_director_blocking_refs(
                scene_refs=scene_refs,
                beats=beats[:grid_capacity],
                character_map=valid_character_map,
            )
        style_family, animation_subtype = StyleService.get_style_branch(
            style or IMAGE_DEFAULT_STYLE,
            project_dir=project_dir,
        )

        if sketch:
            ctx = create_prompt_context(
                mode=PromptMode.SKETCH,
                beats=beats[:grid_capacity],
                rows=rows,
                cols=cols,
                character_map=valid_character_map,
                style=style,
                ethnicity=ethnicity,
                scene_refs=scene_refs,
                prop_asset_refs=prop_asset_refs,
                sketch_colors=sketch_colors or {},
                prop_marker_colors=_global_prop_marker_colors(
                    beats[:grid_capacity],
                    prop_menu,
                    sketch_colors=sketch_colors or {},
                ),
                style_family=style_family,
                animation_subtype=animation_subtype,
                project_dir=str(project_dir) if project_dir else "",
                image_provider=self.provider,
                image_model=self.model,
            )
            from novelvideo.verification.failure_registry import (
                load_negative_clause_for_project,
            )

            ctx.registry_negative_clause = await load_negative_clause_for_project(
                str(project_dir) if project_dir else None, "generator"
            )
            builder = UnifiedPromptBuilder(ctx)
            prompt = builder.build()
        elif sketch_dir:
            # Always extract beat numbers from the beats themselves, to avoid drifting out of sync with external parameters
            actual_beats = beats[:grid_capacity]
            actual_beat_numbers = [
                _generation_beat_number(b, i) for i, b in enumerate(actual_beats)
            ]
            beat_range_start = min(actual_beat_numbers)
            beat_range_end = max(actual_beat_numbers)

            sketch_result = find_sketch_for_beat_range(sketch_dir, beat_range_start, beat_range_end)
            has_all_pool_sketches = beat_sketch_paths and all(
                bn in beat_sketch_paths for bn in actual_beat_numbers
            )

            if sketch_result or has_all_pool_sketches:
                # Slice the sketch first
                if output_path:
                    temp_dir = Path(output_path).parent
                else:
                    temp_dir = Path("output")
                temp_dir.mkdir(parents=True, exist_ok=True)
                sub_sketch_path = str(temp_dir / "temp_sub_sketch_batch.jpg")
                target_aspect_batch = None
                if sketch_aspect_padding and mode_key:
                    target_aspect_batch = cell_aspect_ratio(mode_key)

                sub_sketch_path = crop_sketch_panels(
                    sketch_path=sketch_dir,
                    beat_numbers=actual_beat_numbers,
                    target_rows=rows,
                    target_cols=cols,
                    output_path=sub_sketch_path,
                    beat_sketch_paths=beat_sketch_paths,
                    target_aspect=target_aspect_batch,
                )
                previous_grid_path = sub_sketch_path

                # Read the precomputed per-beat identity detection results (already done in the sketch workbench)
                _panel_det = load_precomputed_panel_detected(actual_beat_numbers, beats)
                valid_character_map = filter_character_map_by_precomputed(
                    valid_character_map, _panel_det
                )

                ctx = create_prompt_context(
                    mode=PromptMode.RENDER,
                    beats=beats[:grid_capacity],
                    rows=rows,
                    cols=cols,
                    character_map=valid_character_map,
                    style=style,
                    ethnicity=ethnicity,
                    panel_detected_keys=_panel_det,
                    scene_refs=scene_refs,
                    prop_asset_refs=prop_asset_refs,
                    sketch_colors=sketch_colors or {},
                    style_family=style_family,
                    animation_subtype=animation_subtype,
                    project_dir=str(project_dir) if project_dir else "",
                )
                builder = UnifiedPromptBuilder(ctx)
                prompt = builder.build()
            else:
                raise RuntimeError(
                    f"Render mode requires a sketch, but none was found covering beats {beat_range_start}-{beat_range_end}"
                )
        else:
            raise RuntimeError("prepare_batch_request() requires the sketch or sketch_dir argument")

        # Build the contents
        contents = [prompt]

        if not sketch and previous_grid_path and os.path.exists(previous_grid_path):
            previous_grid_image = self._load_image_as_part(previous_grid_path)
            if previous_grid_image:
                contents.append(previous_grid_image)

        if sketch:
            if use_director_refs:
                self._append_reference_parts_from_plan(
                    contents,
                    ctx,
                    [],
                    valid_character_map,
                    allowed_kinds={"scene"},
                    verbose=True,
                )
            elif scene_refs or prop_asset_refs:
                self._append_reference_parts_from_plan(
                    contents,
                    ctx,
                    [],
                    valid_character_map,
                    allowed_kinds={"scene"},
                    verbose=True,
                )
        else:
            ordered_chars = resolve_render_reference_order(
                ctx, beats, grid_capacity, valid_character_map
            )
            self._append_reference_parts_from_plan(
                contents,
                ctx,
                ordered_chars,
                valid_character_map,
                allowed_kinds=None,
                verbose=True,
            )

        # Determine aspect_ratio and image_size
        if mode_key:
            _cfg = REGEN_MODE_CONFIGS[mode_key]
            aspect_ratio = _cfg["aspect_ratio"]
            image_size = _cfg["image_size"]
        elif sketch:
            aspect_ratio = SKETCH_GRID_CONFIG["aspect_ratio"]
            image_size = SKETCH_GRID_CONFIG["image_size"]
        else:
            _found = False
            for _mk, _cfg in REGEN_MODE_CONFIGS.items():
                if _cfg["rows"] == rows and _cfg["cols"] == cols:
                    aspect_ratio = _cfg["aspect_ratio"]
                    image_size = _cfg["image_size"]
                    _found = True
                    break
            if not _found:
                if rows == cols:
                    aspect_ratio = "1:1"
                    image_size = "4K" if rows >= 4 else "2K"
                elif rows > cols:
                    aspect_ratio = "9:16"
                    image_size = "4K"
                else:
                    aspect_ratio = "21:9"
                    image_size = "2K"

        if self.force_image_size:
            image_size = self.force_image_size
        if force_image_size:
            image_size = force_image_size

        return {
            "contents": contents,
            "rows": rows,
            "cols": cols,
            "aspect_ratio": aspect_ratio,
            "image_size": image_size,
            "output_path": output_path,
            "beat_start_index": beat_start_index,
            "actual_beat_count": actual_beat_count,
        }

    async def generate_batch_api(
        self,
        requests: List[dict],
        poll_interval: int = 15,
        timeout: int = 3600,
        on_status_change: callable = None,
    ) -> List[GridGenerationResult]:
        """Submit all grid generation requests at once through the Google Batch API.

        Costs 50% of the standard API, but requires waiting for asynchronous processing (usually several minutes to tens of minutes).

        Args:
            requests: list of dicts returned by prepare_batch_request()
            poll_interval: polling interval (seconds)
            timeout: maximum wait time (seconds)
            on_status_change: status change callback

        Returns:
            List of GridGenerationResult, one per request
        """
        if self.provider != "google":
            raise NotImplementedError(
                "The Google Batch API only supports the google provider; please use the standard mode (generate_grid) or switch to the google provider."
            )

        from google import genai
        from google.genai import types

        client = genai.Client(api_key=self.api_key)

        # Build the InlinedRequest list
        is_gemini3 = "gemini-3" in self.model
        is_image_model = "image-preview" in self.model

        batch_requests = []
        for req in requests:
            if is_gemini3:
                image_config = types.ImageConfig(
                    aspect_ratio=req["aspect_ratio"],
                    image_size=req["image_size"],
                )
            else:
                image_config = types.ImageConfig(
                    aspect_ratio=req["aspect_ratio"],
                )

            if is_image_model:
                thinking_config = None
            elif is_gemini3:
                thinking_config = types.ThinkingConfig(thinking_level=types.ThinkingLevel.HIGH)
            else:
                thinking_config = types.ThinkingConfig(thinking_budget=1024)

            gen_config_kwargs = {
                "response_modalities": ["IMAGE", "TEXT"],
                "image_config": image_config,
            }
            if thinking_config:
                gen_config_kwargs["thinking_config"] = thinking_config

            gen_config = types.GenerateContentConfig(**gen_config_kwargs)

            batch_requests.append(
                {
                    "contents": req["contents"],
                    "config": gen_config,
                }
            )

        print(f"[BatchAPI] Submitting {len(batch_requests)} requests to the Google Batch API...")

        # Submit the Batch
        batch_job = client.batches.create(
            model=self.model,
            src=batch_requests,
            config={"display_name": f"grid_batch_{int(time.time())}"},
        )

        print(f"[BatchAPI] Batch submitted: {batch_job.name}")

        # Wait by polling
        elapsed = 0
        last_state = None
        while elapsed < timeout:
            batch = client.batches.get(name=batch_job.name)
            if batch.state != last_state:
                last_state = batch.state
                print(f"[BatchAPI] State: {batch.state}")
                if on_status_change:
                    on_status_change(batch.state)

            if batch.state == "JOB_STATE_SUCCEEDED":
                break
            elif batch.state in ("JOB_STATE_FAILED", "JOB_STATE_CANCELLED"):
                raise RuntimeError(f"Batch failed: {batch.state}")

            await asyncio.sleep(poll_interval)
            elapsed += poll_interval

        if elapsed >= timeout:
            raise RuntimeError(f"Batch timed out ({timeout}s)")

        # Extract the results
        results = []
        for i, response in enumerate(batch.dest.inlined_responses):
            req = requests[i]
            output_path = req["output_path"]

            if hasattr(response, "error") and response.error:
                results.append(
                    GridGenerationResult(
                        success=False,
                        error=str(response.error),
                    )
                )
                continue

            # Extract the image
            image_bytes = None
            if (
                response.response
                and response.response.candidates
                and response.response.candidates[0].content
            ):
                for part in response.response.candidates[0].content.parts:
                    if hasattr(part, "inline_data") and part.inline_data:
                        image_bytes = part.inline_data.data
                        break

            if not image_bytes:
                results.append(
                    GridGenerationResult(
                        success=False,
                        error=f"Batch response {i} returned no image data",
                    )
                )
                continue

            # Save the file
            if output_path:
                output_dir = os.path.dirname(output_path)
                if output_dir:
                    os.makedirs(output_dir, exist_ok=True)
                with open(output_path, "wb") as f:
                    f.write(image_bytes)

                # Post-processing: gap removal
                try:
                    from novelvideo.generators.grid_splitter import remove_grid_gaps
                    from PIL import Image as PILImage

                    grid_img = PILImage.open(output_path)
                    grid_img = remove_grid_gaps(grid_img, req["rows"], req["cols"])
                    grid_img.save(output_path)
                except Exception as e:
                    print(f"[BatchAPI] Grid {i} gap removal failed: {e}")

            results.append(
                GridGenerationResult(
                    success=True,
                    grid_image_path=output_path,
                    grid_image_bytes=image_bytes,
                )
            )

        print(f"[BatchAPI] Done: {sum(1 for r in results if r.success)}/{len(results)} succeeded")
        return results

    async def generate_grid_batch(
        self,
        all_beats: List[dict],
        character_map: Dict[str, dict] = None,
        scene_menu: list[dict] | list | None = None,
        prop_menu: list[dict] | list | None = None,
        sketch_colors: Dict[str, str] = None,
        style: str = None,
        output_dir: str = None,
        ethnicity: str = "Chinese",
        grid_size: int = 9,  # 3x3
        on_grid_complete: callable = None,  # callback when each grid completes
        prompt_only: bool = False,  # Dry Run mode: only generate prompts, do not call the API
        scene_grid_plan: List[dict] = None,  # scene grouping mode: output of scene_grid_split()
        sketch_dir: str = "",  # sketch directory path (computed by the caller via PathResolver)
        force_image_size: Optional[str] = None,  # force-override image_size (e.g. "0.5K")
    ) -> List[GridGenerationResult]:
        """Generate multiple grid images in batch.

        Splits all beats into batches, generating one grid per batch.
        Each grid is split immediately after generation, which is more stable and supports retrying on failure.

        Render mode:
        - If the caller passes sketch_dir and the directory contains sketch files, Render mode is entered automatically
        - The sketch is used as a reference, only adding color and texture

        Args:
            all_beats: all beats data
            character_map: character mapping
            style: style name
            output_dir: output directory (where grid images are saved)
            ethnicity: character ethnicity
            grid_size: number of panels per grid (default 9 = 3x3)
            on_grid_complete: callback invoked when each grid completes (batch_idx, result) -> None
        Returns:
            List[GridGenerationResult] - generation result of each grid
        """
        import math
        from pathlib import Path

        results = []
        character_map = character_map or {}

        # Compute the maximum grid size (upper bound for dynamic selection)
        max_grid_rows = int(math.sqrt(grid_size))
        max_grid_cols = max_grid_rows

        total_beats = len(all_beats)
        print(
            f"[NanoBananaPro Batch] {total_beats} beats in total, max grid: {max_grid_rows}x{max_grid_cols}"
        )
        print("[NanoBananaPro Batch] Dynamic grid optimization enabled (minimizing black padding)")

        # Make sure the output directory exists
        if output_dir:
            Path(output_dir).mkdir(parents=True, exist_ok=True)

        # ===== Scene grouping mode: use the precomputed plan =====
        if scene_grid_plan:
            grid_plan_tuples = [
                e.get("mode_key", f"{e['rows']}x{e['cols']}_1-1") for e in scene_grid_plan
            ]
            plan_beats_list = [e["beats"] for e in scene_grid_plan]
            loc_labels = [e.get("scene_id", "") for e in scene_grid_plan]
            scene_grid_labels = [
                f"{REGEN_MODE_CONFIGS[mk]['rows']}x{REGEN_MODE_CONFIGS[mk]['cols']}({loc})"
                for mk, loc in zip(grid_plan_tuples, loc_labels)
            ]
            print(
                f"[NanoBananaPro Batch] Scene grouping mode: "
                f"{' + '.join(scene_grid_labels)} "
                f"({len(grid_plan_tuples)} grids in total)"
            )
        else:
            # ===== Default split: perfect split =====
            grid_plan_tuples = perfect_grid_split(total_beats, max_grid=grid_size)
            plan_beats_list = None  # marker: take in order from all_beats

            # Iron-rule post-process (only when there are reference images & not prompt_only)
            all_beats_list = list(all_beats)
            if character_map and not prompt_only:
                final_plan = []
                offset = 0
                for mk in grid_plan_tuples:
                    cap = REGEN_MODE_CONFIGS[mk]["capacity"]
                    batch = all_beats_list[offset : offset + cap]
                    n_comp = _count_batch_composite_chars(batch, character_map)
                    if n_comp >= MANY_CHARS_REF_THRESHOLD and cap > MANY_CHARS_MAX_CAPACITY:
                        # Smart split: group by consecutive composite counts; subgroups with <=2 use the full pool
                        final_plan.extend(
                            _smart_repack_beats(
                                batch,
                                character_map,
                                DEFAULT_POOL_TEMPLATE,
                            )
                        )
                    else:
                        final_plan.append(mk)
                    offset += cap
                grid_plan_tuples = final_plan

            grid_capacities = [REGEN_MODE_CONFIGS[mk]["capacity"] for mk in grid_plan_tuples]
            grid_labels = [
                f"{REGEN_MODE_CONFIGS[mk]['rows']}x{REGEN_MODE_CONFIGS[mk]['cols']}"
                for mk in grid_plan_tuples
            ]
            print(
                f"[NanoBananaPro Batch] Perfect split plan: {' + '.join(grid_labels)} "
                f"= {sum(grid_capacities)} ({len(grid_plan_tuples)} grids in total, 0 padding)"
            )

        # Generate the grids one by one following the split plan
        all_beats_list = list(all_beats)  # copy the list
        processed_beats = 0

        for batch_idx, mk in enumerate(grid_plan_tuples):
            cfg = REGEN_MODE_CONFIGS[mk]
            batch_rows, batch_cols = cfg["rows"], cfg["cols"]
            batch_capacity = cfg["capacity"]

            if plan_beats_list is not None:
                # Scene grouping mode: use the beats in the plan (may be non-contiguous)
                batch_beats = plan_beats_list[batch_idx]
            else:
                # Default: take beats in order
                batch_beats = all_beats_list[processed_beats : processed_beats + batch_capacity]

            # Record the actual beat count (for logging)
            actual_beat_count = len(batch_beats)
            start_idx = processed_beats + 1
            end_idx = processed_beats + actual_beat_count

            # Character filtering is left to generate_grid internally, to avoid re-resolving references in the batch stage.
            batch_character_map = character_map
            print(
                f"[NanoBananaPro Batch] Grid {batch_idx + 1} candidate characters: "
                f"{list(batch_character_map.keys())}"
            )

            # A perfect split needs no padding; use batch_beats directly
            # (if for some reason the beat count does not match there would be a problem here, but in theory it cannot happen)
            if len(batch_beats) != batch_capacity:
                print(
                    f"[NanoBananaPro Batch] Warning: grid {batch_idx + 1} beat count mismatch ({len(batch_beats)} vs {batch_capacity})"
                )

            # Grid image output path
            output_path = None
            if output_dir:
                output_path = str(Path(output_dir) / f"grid_{batch_idx + 1:02d}.png")

            print(
                f"[NanoBananaPro Batch] Generating grid {batch_idx + 1} (beats {start_idx}-{end_idx}, grid: {batch_rows}x{batch_cols})"
            )

            # Call single-grid generation (using the filtered character map and the dynamic grid size)
            result = await self.generate_grid(
                beats=batch_beats,
                character_map=batch_character_map,
                scene_menu=scene_menu,
                prop_menu=prop_menu,
                sketch_colors=sketch_colors,
                style=style,
                output_path=output_path,
                ethnicity=ethnicity,
                rows=batch_rows,  # use the dynamically computed row count
                cols=batch_cols,  # use the dynamically computed column count
                prompt_only=prompt_only,
                beat_start_index=processed_beats,  # Render mode: pass the start index for sketch slicing
                total_episode_beats=total_beats,  # Render mode: pass the total beats of the episode
                location_beat_numbers=(
                    scene_grid_plan[batch_idx]["beat_numbers"] if scene_grid_plan else None
                ),
                sketch_dir=sketch_dir,
                mode_key=scene_grid_plan[batch_idx].get("mode_key") if scene_grid_plan else mk,
                force_image_size=force_image_size,
            )

            # Update the counter (batch_idx is managed by enumerate)
            processed_beats += actual_beat_count

            results.append(result)

            # Callback notification
            if on_grid_complete:
                try:
                    on_grid_complete(batch_idx, result)
                except Exception as e:
                    print(f"[NanoBananaPro Batch] Callback error: {e}")

            if not result.success:
                print(f"[NanoBananaPro Batch] Grid {batch_idx + 1} generation failed: {result.error}")
                # Continue generating the next grid without aborting the whole flow

        successful = sum(1 for r in results if r.success)
        total_grids = len(results)
        print(f"[NanoBananaPro Batch] Batch generation complete: {successful}/{total_grids} succeeded")

        return results

    async def regenerate_single_grid(
        self,
        all_beats: List[dict],
        grid_index: int,  # 0-based grid index
        character_map: Dict[str, dict] = None,
        scene_menu: list[dict] | list | None = None,
        prop_menu: list[dict] | list | None = None,
        sketch_colors: Dict[str, str] = None,
        style: str = None,
        output_dir: str = None,
        ethnicity: str = "Chinese",
        grid_size: int = 9,  # 3x3
        prompt_only: bool = False,
        scene_grid_plan: List[dict] = None,  # scene grouping mode: output of scene_grid_split()
        sketch_dir: str = "",  # sketch directory path (computed by the caller via PathResolver)
        beat_sketch_paths: dict = None,  # {beat_num: full_path} per-beat sketch paths taken from the image pool
        sketch_aspect_padding: bool = False,  # pad the sketch with white to the target ratio
        force_image_size: Optional[str] = None,  # force-override image_size (e.g. "0.5K")
    ) -> GridGenerationResult:
        """Regenerate the single grid at the given index.

        Computes the beat range with the same dynamic split logic as generate_grid_batch,
        then regenerates only the grid at the given index.

        Args:
            all_beats: all beats data
            grid_index: index of the grid to regenerate (0-based)
            character_map: character mapping
            sketch_colors: character color mapping of the sketch
            style: style name
            output_dir: output directory
            ethnicity: character ethnicity
            grid_size: number of panels per grid (default 9 = 3x3)
            prompt_only: only generate the prompt, do not call the API
            scene_grid_plan: precomputed plan for scene grouping mode

        Returns:
            GridGenerationResult - the regenerated grid result
        """
        from pathlib import Path

        character_map = character_map or {}

        # ===== Scene grouping mode =====
        if scene_grid_plan:
            if grid_index >= len(scene_grid_plan):
                return GridGenerationResult(
                    success=False,
                    error=f"Grid index {grid_index} out of range (max {len(scene_grid_plan) - 1})",
                    generation_time=0,
                )
            entry = scene_grid_plan[grid_index]
            target_batch_rows = entry["rows"]
            target_batch_cols = entry["cols"]
            target_batch_beats = entry["beats"]
            batch_capacity = target_batch_rows * target_batch_cols
            total_beats = len(all_beats)
            target_start_idx = 0  # scene grouping has no contiguous start index
            loc_name = entry.get("scene_id", "")
            print(
                f"[NanoBananaPro Regen] Scene grouping: grid {grid_index + 1} ({loc_name}, "
                f"{len(target_batch_beats)} beats, "
                f"grid: {target_batch_rows}x{target_batch_cols})"
            )
        else:
            # ===== Default split =====
            total_beats = len(all_beats)
            grid_plan = perfect_grid_split(total_beats, max_grid=grid_size)

            if grid_index >= len(grid_plan):
                return GridGenerationResult(
                    success=False,
                    error=f"Grid index {grid_index} out of range (max {len(grid_plan) - 1})",
                    generation_time=0,
                )

            _mk = grid_plan[grid_index]
            _cfg = REGEN_MODE_CONFIGS[_mk]
            target_batch_rows, target_batch_cols = _cfg["rows"], _cfg["cols"]
            batch_capacity = _cfg["capacity"]
            target_start_idx = sum(
                REGEN_MODE_CONFIGS[m]["capacity"] for m in grid_plan[:grid_index]
            )
            target_batch_beats = list(all_beats)[
                target_start_idx : target_start_idx + batch_capacity
            ]

        actual_beat_count = len(target_batch_beats)
        if not scene_grid_plan:
            print(
                f"[NanoBananaPro Regen] Regenerating grid {grid_index + 1} "
                f"(beats {target_start_idx + 1}-{target_start_idx + actual_beat_count}, "
                f"grid: {target_batch_rows}x{target_batch_cols})"
            )

        # Character filtering is left to generate_grid internally, to avoid re-resolving references in the regeneration stage.
        batch_character_map = character_map
        print(
            f"[NanoBananaPro Regen] Grid {grid_index + 1} candidate characters: "
            f"{list(batch_character_map.keys())}"
        )

        # A perfect split needs no padding, but check just in case
        if len(target_batch_beats) != batch_capacity:
            print(
                f"[NanoBananaPro Regen] Warning: grid {grid_index + 1} beat count mismatch "
                f"({len(target_batch_beats)} vs {batch_capacity})"
            )

        # Grid image output path
        output_path = None
        if output_dir:
            Path(output_dir).mkdir(parents=True, exist_ok=True)
            output_path = str(Path(output_dir) / f"grid_{grid_index + 1:02d}.png")

        # Call single-grid generation
        result = await self.generate_grid(
            beats=target_batch_beats,
            character_map=batch_character_map,
            scene_menu=scene_menu,
            prop_menu=prop_menu,
            sketch_colors=sketch_colors,
            style=style,
            output_path=output_path,
            ethnicity=ethnicity,
            rows=target_batch_rows,
            cols=target_batch_cols,
            prompt_only=prompt_only,
            beat_start_index=target_start_idx,  # Render mode: pass the start index for sketch slicing
            total_episode_beats=total_beats,  # Render mode: pass the total beats of the episode
            location_beat_numbers=entry["beat_numbers"] if scene_grid_plan else None,
            sketch_dir=sketch_dir,
            beat_sketch_paths=beat_sketch_paths,
            mode_key=entry.get("mode_key") if scene_grid_plan else grid_plan[grid_index],
            sketch_aspect_padding=sketch_aspect_padding,
            force_image_size=force_image_size,
        )

        if result.success:
            print(f"[NanoBananaPro Regen] Grid {grid_index + 1} regenerated successfully")
        else:
            print(f"[NanoBananaPro Regen] Grid {grid_index + 1} regeneration failed: {result.error}")

        # Add extra metadata to the result
        result.beat_start_index = target_start_idx
        result.beat_count = actual_beat_count
        result.grid_rows = target_batch_rows
        result.grid_cols = target_batch_cols

        return result

    def _load_image_as_part(
        self,
        image_path: str,
        compress_quality: int = 60,
        min_short_side: int = 0,
    ):
        """Load an image as a Gemini API Part (with JPEG compression).

        Args:
            image_path: image path
            compress_quality: JPEG compression quality (1-100); set to 0 or None to disable compression
            min_short_side: upscale reference images before submission, so small spatial images are not misread by the model

        Returns:
            Gemini Part object
        """
        try:
            from PIL import Image
            import io

            # OpenAI director refs are line-art geometry anchors. JPEG compression can erase
            # subtle table/window/stool lines, so keep those references lossless.
            if self.provider == "openai" and Path(image_path).name in {
                "director_sketch_ref.png",
                "director_color_ref.png",
            }:
                compress_quality = 0

            # Load the image
            img = Image.open(image_path)
            original_size = os.path.getsize(image_path)
            original_dimensions = img.size

            if min_short_side > 0:
                short_side = min(img.size)
                if 0 < short_side < min_short_side:
                    scale = min_short_side / short_side
                    new_size = (
                        max(1, int(round(img.size[0] * scale))),
                        max(1, int(round(img.size[1] * scale))),
                    )
                    img = img.resize(new_size, Image.Resampling.LANCZOS)
                    print(
                        f"[Reference upscale] {os.path.basename(image_path)}: "
                        f"{original_dimensions[0]}x{original_dimensions[1]} → "
                        f"{new_size[0]}x{new_size[1]}"
                    )

            # Compress to JPEG (if enabled)
            if compress_quality and compress_quality > 0:
                # Convert to RGB (JPEG does not support alpha)
                if img.mode in ("RGBA", "P"):
                    img = img.convert("RGB")

                # Compress into memory
                buffer = io.BytesIO()
                img.save(buffer, format="JPEG", quality=compress_quality, optimize=True)
                image_data = buffer.getvalue()
                mime_type = "image/jpeg"

                compressed_size = len(image_data)
                ratio = (1 - compressed_size / original_size) * 100
                print(
                    f"[compress] {os.path.basename(image_path)}: "
                    f"{original_size/1024:.0f}KB → {compressed_size/1024:.0f}KB "
                    f"({ratio:.0f}% compression)"
                )
            else:
                if img.size != original_dimensions:
                    buffer = io.BytesIO()
                    img.save(buffer, format="PNG")
                    image_data = buffer.getvalue()
                    mime_type = "image/png"
                else:
                    # No compression; read the original file directly
                    with open(image_path, "rb") as f:
                        image_data = f.read()

                    if image_path.lower().endswith(".png"):
                        mime_type = "image/png"
                    elif image_path.lower().endswith(".webp"):
                        mime_type = "image/webp"
                    else:
                        mime_type = "image/jpeg"

            if self.provider != "google":
                return _InlineImagePart(image_data, mime_type)

            from google.genai import types

            try:
                return types.Part.from_bytes(
                    data=image_data,
                    mime_type=mime_type,
                    media_resolution=types.MediaResolution.MEDIA_RESOLUTION_HIGH,
                )
            except (TypeError, AttributeError):
                # The Gemini 2.x SDK does not support media_resolution
                return types.Part.from_bytes(data=image_data, mime_type=mime_type)

        except Exception as e:
            print(f"[NanoBananaPro] Failed to load reference image: {image_path}, {e}")
            return None

    def _append_reference_parts_from_plan(
        self,
        contents: list,
        ctx: PromptContext,
        ordered_chars: list[str],
        valid_character_map: dict,
        *,
        allowed_kinds: set[str] | None = None,
        verbose: bool = False,
        audit_refs: list[dict] | None = None,
    ) -> None:
        """Append the actual attachments according to the unified image plan in the prompt."""
        plan = PromptComponents.build_reference_image_plan(ctx, ordered_chars)

        for entry in plan:
            kind = entry.get("kind")
            if allowed_kinds is not None and kind not in allowed_kinds:
                continue
            if kind == "combined_composite":
                sheets = []
                names = []
                try:
                    from PIL import Image

                    for item in entry.get("items", []):
                        char_name = item.get("char_name", "")
                        info = valid_character_map.get(char_name) or {}
                        ref_path = item.get("path") or info.get("reference_path")
                        if not ref_path or not os.path.exists(ref_path):
                            continue
                        sheet = Image.open(ref_path)
                        if sheet.mode in ("RGBA", "P"):
                            sheet = sheet.convert("RGB")
                        sheets.append(sheet)
                        names.append(char_name)
                        if verbose:
                            print(
                                f"[NanoBananaPro] Added full multi-view reference sheet: {char_name} -> "
                                f"{sheet.size[0]}x{sheet.size[1]}px"
                            )
                    if sheets:
                        merged_part = self._merge_character_panels(sheets)
                        if merged_part:
                            contents.append(merged_part)
                            if verbose:
                                print(f"[NanoBananaPro] Multi-character full sheets merged into a reference image: {names}")
                finally:
                    for sheet in sheets:
                        try:
                            sheet.close()
                        except Exception:
                            pass
            elif kind in {"composite", "portrait_only", "identity_portrait"}:
                path = entry.get("path")
                if not path or not os.path.exists(path):
                    continue
                ref_image = self._load_image_as_part(path)
                if not ref_image:
                    continue
                contents.append(ref_image)
                if audit_refs is not None:
                    audit_refs.append(
                        {
                            "kind": kind,
                            "base_id": entry.get("char_name", ""),
                            "path": path,
                            "bytes": os.path.getsize(path) if os.path.exists(path) else None,
                        }
                    )
                if not verbose:
                    continue
                if kind == "composite":
                    print(
                        "[NanoBananaPro] Added reference image (composite): "
                        f"{entry.get('char_name', '')} -> {path}"
                    )
                elif kind == "portrait_only":
                    print(
                        "[NanoBananaPro] Added reference image (Portrait): "
                        f"{entry.get('char_name', '')} -> {path}"
                    )
                else:
                    print(
                        "[NanoBananaPro] Added identity-level Portrait (age variant): "
                        f"{entry.get('char_name', '')}/{entry.get('tag', '')}"
                    )
            elif kind in {"scene", "prop"}:
                ref = entry.get("ref")
                path = (getattr(ref, "image_paths", []) or [""])[0]
                if not path or not os.path.exists(path):
                    continue
                source_level = str(getattr(ref, "source_level", "") or "").strip()
                compress_quality = 0 if source_level == "scene_spatial_layout" else 60
                min_short_side = 720 if source_level == "scene_spatial_layout" else 0
                ref_image = self._load_image_as_part(
                    path,
                    compress_quality=compress_quality,
                    min_short_side=min_short_side,
                )
                if not ref_image:
                    continue
                contents.append(ref_image)
                if audit_refs is not None:
                    audit_refs.append(
                        {
                            "kind": kind,
                            "base_id": getattr(ref, "base_id", ""),
                            "variant_id": getattr(ref, "variant_id", ""),
                            "source_level": getattr(ref, "source_level", ""),
                            "path": path,
                            "bytes": os.path.getsize(path) if os.path.exists(path) else None,
                            "submitted_min_short_side": min_short_side or None,
                        }
                    )
                if verbose:
                    label = "scene" if kind == "scene" else "prop"
                    try:
                        size_bytes = os.path.getsize(path)
                    except OSError:
                        size_bytes = -1
                    print(
                        f"[NanoBananaPro][RefPlan] kind={kind} "
                        f"base_id={getattr(ref, 'base_id', '')} "
                        f"path={path} bytes={size_bytes}"
                    )
                    print(f"[NanoBananaPro] Added {label} reference image: " f"{getattr(ref, 'base_id', '')}")

    def _extract_ref_bytes_from_contents(
        self, contents: list, *, include_mime: bool = False
    ) -> tuple:
        """Extract the prompt text and reference image bytes from the contents list (used for OpenRouter)."""
        prompt_text = ""
        ref_bytes = []
        for item in contents:
            if isinstance(item, str):
                prompt_text = item
            elif hasattr(item, "inline_data") and item.inline_data:
                if include_mime:
                    ref_bytes.append(
                        (
                            item.inline_data.data,
                            getattr(item.inline_data, "mime_type", "image/png") or "image/png",
                        )
                    )
                else:
                    ref_bytes.append(item.inline_data.data)
        return prompt_text, ref_bytes

    def _crop_center_panel(self, image_path: str):
        """Crop the middle panel (front full body) out of a 3-panel sheet."""
        from PIL import Image

        img = Image.open(image_path)
        w, h = img.size
        panel_w = w // 3
        return img.crop((panel_w, 0, panel_w * 2, h))

    def _merge_character_panels(self, panels: list, compress_quality: int = 60):
        """Stitch several character reference images horizontally, compress, and return a Gemini Part."""
        from PIL import Image

        if not panels:
            return None

        # Unify the height (take the largest), scale proportionally.
        max_h = max(p.size[1] for p in panels)
        resized = []
        for p in panels:
            if p.size[1] != max_h:
                ratio = max_h / p.size[1]
                new_w = int(p.size[0] * ratio)
                p = p.resize((new_w, max_h), Image.LANCZOS)
            resized.append(p)

        # Stitch horizontally.
        total_w = sum(p.size[0] for p in resized)
        merged = Image.new("RGB", (total_w, max_h))
        x_offset = 0
        for p in resized:
            if p.mode in ("RGBA", "P"):
                p = p.convert("RGB")
            merged.paste(p, (x_offset, 0))
            x_offset += p.size[0]

        # JPEG compression.
        buffer = io.BytesIO()
        merged.save(buffer, format="JPEG", quality=compress_quality, optimize=True)
        image_data = buffer.getvalue()
        print(
            f"[NanoBananaPro] Merged reference images: {len(panels)} characters, "
            f"{total_w}x{max_h}px, {len(image_data)/1024:.0f}KB"
        )

        if self.provider != "google":
            return _InlineImagePart(image_data, "image/jpeg")

        from google.genai import types

        try:
            return types.Part.from_bytes(
                data=image_data,
                mime_type="image/jpeg",
                media_resolution=types.MediaResolution.MEDIA_RESOLUTION_HIGH,
            )
        except (TypeError, AttributeError):
            return types.Part.from_bytes(data=image_data, mime_type="image/jpeg")

    async def _generate_render_from_sketch(
        self,
        sketch_path: str,
        prompt: str,
        beats: List[dict],
        character_map: Dict[str, dict],
        output_path: str,
        rows: int,
        cols: int,
        style: str,
        total_episode_beats: int = 0,
        beat_start_index: int = 0,
        mode_key: Optional[str] = None,
        sketch_aspect_padding: bool = False,
    ) -> GridGenerationResult:
        """Render mode core logic: split the sketch -> render in parallel -> stitch into a grid.

        Supports multi-sketch mode: find the matching sketch file by beat_start_index,
        then use the local offset to cut out the right panels.
        """
        from PIL import Image

        # 1. Find the sketch file covering the current beat range
        try:
            beat_range_start = beat_start_index + 1  # 1-based
            beat_range_end = beat_start_index + len(beats)

            # Try to find it from the sketch directory
            sketch_dir_path = (
                str(Path(sketch_path).parent) if os.path.isfile(sketch_path) else sketch_path
            )
            sketch_result = find_sketch_for_beat_range(
                sketch_dir_path, beat_range_start, beat_range_end
            )

            if sketch_result:
                actual_sketch_file, s_rows, s_cols = sketch_result
                file_start = int(Path(actual_sketch_file).stem.split("_b")[1].split("-")[0])
                local_offset = beat_start_index - (file_start - 1)
            else:
                # Fallback: use the passed sketch_path directly
                actual_sketch_file = sketch_path
                s_rows = SKETCH_GRID_CONFIG["rows"]
                s_cols = SKETCH_GRID_CONFIG["cols"]
                local_offset = beat_start_index  # single-file fallback
                print(f"[Render] Fallback: using the passed sketch {sketch_path}")

            sketch_img = Image.open(actual_sketch_file)
            sketch_w, sketch_h = sketch_img.size

            panel_w = sketch_w // s_cols
            panel_h = sketch_h // s_rows

            print(f"[Render] Sketch: {actual_sketch_file} ({s_rows}x{s_cols})")
            print(f"[Render] Panel size: {panel_w}x{panel_h}")

            # 2. Split the sketch into all panels
            all_panels = []
            for r in range(s_rows):
                for c in range(s_cols):
                    box = (c * panel_w, r * panel_h, (c + 1) * panel_w, (r + 1) * panel_h)
                    panel = sketch_img.crop(box)
                    all_panels.append(panel)

            # 3. Take the matching panels according to local_offset
            panels = all_panels[local_offset : local_offset + len(beats)]

            print(
                f"[Render] Took [local {local_offset}:{local_offset + len(beats)}] = {len(panels)} panels from {len(all_panels)} sketch panels"
            )

        except Exception as e:
            return GridGenerationResult(success=False, error_message=f"Failed to slice sketch: {e}")

        # 2. Prepare the parallel tasks
        if not output_path:
            # Default path if none provided
            output_path = "output/render_grid_temp.png"
            os.makedirs("output", exist_ok=True)

        temp_dir = os.path.dirname(output_path)
        if not temp_dir:
            temp_dir = "."
        os.makedirs(temp_dir, exist_ok=True)

        # 3. Prepare the parallel tasks (using NanoBanana/Gemini)
        tasks = []

        for i, beat in enumerate(beats):
            if i >= len(panels):
                break

            panel_idx = i + 1
            panel_img = panels[i]

            # Pad the sketch with white to the target ratio (sketch_aspect_padding)
            target_ar = None
            if sketch_aspect_padding and mode_key:
                target_ar = cell_aspect_ratio(mode_key)
                if target_ar:
                    panel_img = pad_to_aspect_ratio(panel_img, target_ar)

            # Save the slice temp file
            slice_path = os.path.join(temp_dir, f"temp_sketch_slice_{panel_idx}.jpg")
            panel_img.convert("RGB").save(slice_path, "JPEG", quality=95)

            # Extract the characters in the current panel and their reference images (core: consistency)
            panel_char_refs = []  # list of character reference image paths
            char_descriptions = []  # list of character descriptions

            vis = beat.get("visual_description", "")
            from novelvideo.models import extract_char_identities_from_markers

            char_identities = extract_char_identities_from_markers(vis, strict=False)
            for char_name, info in character_map.items():
                # Check whether the character appears in the current panel (by name or tag)
                if char_name in vis:
                    # Collect the character reference image
                    ref_path = info.get("reference_path")
                    if ref_path and os.path.exists(ref_path):
                        panel_char_refs.append(ref_path)
                    # Collect the character description (using [CharTag])
                    from novelvideo.utils.identity_resolver import compute_char_tag

                    identity_id = char_identities.get(char_name, None)
                    tag = compute_char_tag(char_name, identity_id=identity_id)
                    base_prompt = info.get("base_prompt", char_name)
                    char_descriptions.append(f"{tag}: {base_prompt}")

            # Build the single-image Prompt (simplified Render version: the sketch already defines composition, only character + environment + style are needed)
            scene_id = beat_scene_id(beat) or "Scene"
            # Replace {{}} markers with identity_id (compatible with {{identity_id}} and {{character_name}})
            from novelvideo.utils.identity_resolver import (
                resolve_visual_description_markers,
                build_identity_to_char_map,
            )

            id_to_char = build_identity_to_char_map(character_map)
            visual_desc = resolve_visual_description_markers(
                vis, character_map, id_to_char, use_identity_id=True
            )

            # Build the prompt: sketch reference + character definitions + scene + style
            char_section = "; ".join(char_descriptions) if char_descriptions else ""
            scene_desc = f"{scene_id}. {visual_desc}"
            panel_project_dir = _infer_project_dir(output_path)
            style_finish = (
                "Dynamic cinematic lighting, stylized animated finish, high detail."
                if StyleService.is_animation_style(style, project_dir=panel_project_dir)
                else "Cinematic lighting, photorealistic, 8k."
            )
            simple_prompt = f"""Render this sketch into high-quality colored image.
CHARACTERS (match face references): {char_section}
SCENE: {scene_desc}
STYLE: {style}. {style_finish}
CRITICAL: Keep exact composition from sketch. Only add color, texture, and lighting."""

            # Output path
            panel_output_path = os.path.join(temp_dir, f"render_panel_{panel_idx}.png")

            print(
                f"[Render] Panel {panel_idx}: {len(panel_char_refs)} character refs, prompt: {simple_prompt[:60]}..."
            )

            # Render a single image with Gemini (passing the character reference images)
            task = self._render_single_panel_gemini(
                sketch_path=slice_path,
                prompt=simple_prompt,
                output_path=panel_output_path,
                character_refs=panel_char_refs,  # core: pass the character reference images
                target_aspect_ratio=target_ar,
            )
            tasks.append(task)

        # 4. Run the parallel rendering (Gemini may be rate-limited; consider controlling with a semaphore)
        # For simplicity, everything runs concurrently for now; adjust if resources are exhausted
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # 5. Collect the results and stitch
        rendered_panels = []
        success_count = 0

        for idx, res in enumerate(results):
            if isinstance(res, Exception):
                print(f"[Render] Panel {idx+1} failed: {res}")
                rendered_panels.append(panels[idx])  # fall back to the sketch
            elif (
                not res
            ):  # res is success bool or path? _render_single_panel_gemini returns path if success
                print(f"[Render] Panel {idx+1} failed (Empty result)")
                rendered_panels.append(panels[idx])
            else:
                # Load the rendered image
                try:
                    img = Image.open(res)
                    rendered_panels.append(img)
                    success_count += 1
                except Exception:
                    rendered_panels.append(panels[idx])

        print(f"[Render] Completed {success_count}/{len(beats)} panels.")

        # 6. Stitch back into a grid (panel sizes may change after padding)
        final_pw, final_ph = panel_w, panel_h
        if sketch_aspect_padding and mode_key:
            pad_ar = cell_aspect_ratio(mode_key)
            if pad_ar:
                sample = pad_to_aspect_ratio(Image.new("RGB", (panel_w, panel_h)), pad_ar)
                final_pw, final_ph = sample.size

        final_grid = Image.new("RGB", (final_pw * cols, final_ph * rows))
        for i, p_img in enumerate(rendered_panels):
            r = i // cols
            c = i % cols
            if p_img.size != (final_pw, final_ph):
                p_img = p_img.resize((final_pw, final_ph), Image.Resampling.LANCZOS)
            final_grid.paste(p_img, (c * final_pw, r * final_ph))

        final_grid.save(output_path)
        print(f"[Render] Final grid assembled: {output_path}")

        return GridGenerationResult(success=True, grid_image_path=output_path)

    async def _render_single_panel_gemini(
        self,
        sketch_path: str,
        prompt: str,
        output_path: str,
        character_refs: List[str] = None,  # list of character reference image paths
        target_aspect_ratio: str = None,  # parameter kept but not passed to ImageConfig (edit mode relies on padding, not resize)
    ) -> Optional[str]:
        """Render a single storyboard slice with Gemini.

        Args:
            sketch_path: sketch slice path
            prompt: render prompt
            output_path: output path
            character_refs: list of reference image paths of the characters appearing in the current panel (for consistency)
            target_aspect_ratio: parameter kept (for future extension), currently unused
        """
        # Load the sketch
        sketch_part = self._load_image_as_part(sketch_path)
        if not sketch_part:
            return None

        # Build contents: [prompt, sketch, character_refs...]
        # Order: prompt first, sketch right after, character reference images last
        contents = [prompt, sketch_part]

        # Add the character reference images (core: achieves consistency)
        if character_refs:
            for ref_path in character_refs:
                ref_part = self._load_image_as_part(ref_path)
                if ref_part:
                    contents.append(ref_part)

        try:
            if self.provider == "openrouter":
                # ===== OpenRouter branch =====
                prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(contents)
                image_bytes, _, _ = await _call_openrouter_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt_text,
                    reference_images=ref_bytes or None,
                )
                if image_bytes:
                    with open(output_path, "wb") as f:
                        f.write(image_bytes)
                    return output_path
                return None
            elif self.provider == "huimeng":
                prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(contents)
                image_bytes, _, error_detail = await _call_huimeng_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt_text,
                    reference_images=ref_bytes or None,
                    image_config={
                        "aspect_ratio": target_aspect_ratio or "9:16",
                        "image_size": "1K",
                    },
                )
                if image_bytes:
                    with open(output_path, "wb") as f:
                        f.write(image_bytes)
                    return output_path
                if error_detail:
                    print(f"[HuiMeng Render] Failed: {error_detail}")
                return None
            elif self.provider == "openai":
                # ===== OpenAI Image API branch =====
                prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(
                    contents,
                    include_mime=True,
                )
                image_bytes, _, error_detail = await _call_openai_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt_text,
                    reference_images=ref_bytes or None,
                    image_config={
                        "aspect_ratio": target_aspect_ratio or "9:16",
                        "image_size": "1K",
                        "output_format": "png",
                    },
                )
                if image_bytes:
                    with open(output_path, "wb") as f:
                        f.write(image_bytes)
                    return output_path
                if error_detail:
                    print(f"[OpenAI Render] Failed: {error_detail}")
                return None
            elif self.provider == "newapi":
                prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(
                    contents,
                    include_mime=True,
                )
                image_bytes, _, error_detail = await _call_newapi_image_api_with_egress(
                    capability="image.generate.render_panel",
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt_text,
                    reference_images=ref_bytes or None,
                    image_config={
                        "aspect_ratio": target_aspect_ratio or "9:16",
                        "image_size": "1K",
                        "quality": self.openai_image_quality,
                    },
                    base_url=self.base_url,
                    delivery_path=output_path,
                    delivery_state=(image_delivery_state := {}),
                    read_copied_bytes=False,
                )
                if image_bytes or image_delivery_state.get("copied"):
                    if not image_delivery_state.get("copied"):
                        with open(output_path, "wb") as f:
                            f.write(image_bytes)
                    return output_path
                if error_detail:
                    print(f"[DramaClawAPI Render] Failed: {error_detail}")
                return None
            elif self.provider == "gemini_webai":
                prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(
                    contents,
                    include_mime=True,
                )
                reference_images = [
                    (_webai_ref_filename(i, mime), data, mime)
                    for i, (data, mime) in enumerate(ref_bytes)
                ]
                image_bytes, _text_response, error_detail = await _call_webai_chat_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt_text,
                    reference_images=reference_images or None,
                    base_url=self.base_url,
                )
                if image_bytes:
                    with open(output_path, "wb") as f:
                        f.write(image_bytes)
                    return output_path
                if error_detail:
                    print(f"[Render] Gemini WebAI failure details: {error_detail}")
                return None
            elif self.provider == "qwen":
                prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(
                    contents,
                    include_mime=True,
                )
                reference_images = [
                    (_webai_ref_filename(i, mime), data, mime)
                    for i, (data, mime) in enumerate(ref_bytes)
                ]
                image_bytes, _text_response, error_detail = await _call_qwen_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt_text,
                    reference_images=reference_images or None,
                    image_config={
                        "aspect_ratio": target_aspect_ratio or "9:16",
                        "image_size": "1K",
                    },
                    base_url=self.base_url,
                )
                if image_bytes:
                    with open(output_path, "wb") as f:
                        f.write(image_bytes)
                    return output_path
                if error_detail:
                    print(f"[Render] Qwen Image failure details: {error_detail}")
                return None
            elif self.provider == "runpod_qwen":
                prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(
                    contents,
                    include_mime=True,
                )
                reference_images = [
                    (_webai_ref_filename(i, mime), data, mime)
                    for i, (data, mime) in enumerate(ref_bytes)
                ]
                image_bytes, _text_response, error_detail = await _call_runpod_qwen_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt_text,
                    reference_images=reference_images or None,
                    image_config={
                        "aspect_ratio": target_aspect_ratio or "9:16",
                        "image_size": "1K",
                    },
                    base_url=self.base_url,
                )
                if image_bytes:
                    with open(output_path, "wb") as f:
                        f.write(image_bytes)
                    return output_path
                if error_detail:
                    print(f"[Render] RunPod Qwen Image failure details: {error_detail}")
                return None
            else:
                # ===== Google direct branch =====
                from google import genai
                from google.genai import types

                client = genai.Client(api_key=self.api_key)
                model_name = self.model

                # Note: edit mode does not pass ImageConfig(aspect_ratio),
                # otherwise Gemini stretches instead of outpainting. The padded sketch is already at the target ratio.
                response = await asyncio.to_thread(
                    client.models.generate_content,
                    model=model_name,
                    contents=contents,
                    config=types.GenerateContentConfig(
                        response_modalities=["IMAGE"],
                    ),
                )

                if response.candidates:
                    # Extract the image
                    for part in response.candidates[0].content.parts:
                        if part.inline_data:
                            image_bytes = base64.b64decode(part.inline_data.data)
                            with open(output_path, "wb") as f:
                                f.write(image_bytes)
                            return output_path
                return None
        except Exception as e:
            print(f"Gemini Render Error: {e}")
            return None

    async def upscale_with_nanobanana(
        self,
        input_path: str,
        output_path: str,
        original_prompt: str,
        style: str = None,
        target_width: int = 720,
        target_height: int = 1280,
    ) -> Path:
        """High-definition restoration with NanoBananaPro.

        Converts the small image cut from the grid (~819x819) into a portrait image (768x1376), then scales it to the target size.

        Args:
            input_path: input image path (small image after grid splitting)
            output_path: output image path
            original_prompt: original scene description (used to guide generation)
            style: style name; defaults to the global config
            target_width: target width (default 720)
            target_height: target height (default 1280)

        Returns:
            Output image path
        """
        from PIL import Image

        # Use the global default style
        if style is None:
            style = IMAGE_DEFAULT_STYLE

        # Get the style preset
        style_preset = get_style_preset(
            style, project_dir=str(_infer_project_dir(output_path, input_path) or "")
        )
        style_keywords = style_preset.get("style_instructions", "")

        # Load the original image as a reference
        ref_image = self._load_image_as_part(input_path)
        if not ref_image:
            raise ValueError(f"Cannot load reference image: {input_path}")

        # Build the high-definition restoration Prompt
        prompt = f"""Based on this reference image, create a high-quality vertical (9:16) version.

REFERENCE IMAGE: The image I provided shows the scene to recreate.

REQUIREMENTS:
- Maintain the EXACT same composition, characters, and scene
- Keep all visual elements identical to the reference
- Output in portrait orientation (9:16)
- Style: {style_keywords}
- Quality: detailed, high quality

SCENE DESCRIPTION: {original_prompt}

CRITICAL: The output must look like a higher-resolution vertical crop/extension of the reference image, NOT a completely new image. Keep the same characters, poses, and scene elements.
"""

        try:
            print(f"[NanoBananaPro Upscale] Processing: {input_path}")

            if self.provider == "openrouter":
                # ===== OpenRouter branch =====
                # Extract the reference image bytes
                ref_bytes = []
                if hasattr(ref_image, "inline_data") and ref_image.inline_data:
                    ref_bytes.append(ref_image.inline_data.data)
                image_bytes, _, or_error = await _call_openrouter_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt,
                    reference_images=ref_bytes or None,
                    image_config={"aspect_ratio": "9:16", "image_size": "1K"},
                )
                if not image_bytes:
                    raise ValueError(
                        f"OpenRouter API returned no image data: {or_error}"
                        if or_error
                        else "OpenRouter API returned no image data"
                    )

                # Save as a temp file and scale
                temp_path = output_path + ".tmp.png"
                with open(temp_path, "wb") as f:
                    f.write(image_bytes)
                img = Image.open(temp_path)
                img = img.resize((target_width, target_height), Image.Resampling.LANCZOS)
                img.save(output_path)
                Path(temp_path).unlink()
                print(f"[NanoBananaPro Upscale] Done: {output_path}")
                return Path(output_path)
            elif self.provider == "huimeng":
                ref_bytes = []
                if hasattr(ref_image, "inline_data") and ref_image.inline_data:
                    ref_bytes.append(ref_image.inline_data.data)
                image_bytes, _, huimeng_error = await _call_huimeng_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt,
                    reference_images=ref_bytes or None,
                    image_config={"aspect_ratio": "9:16", "image_size": "1K"},
                )
                if not image_bytes:
                    raise ValueError(
                        f"HuiMeng Images returned no image data: {huimeng_error}"
                        if huimeng_error
                        else "HuiMeng Images returned no image data"
                    )

                temp_path = output_path + ".tmp.png"
                with open(temp_path, "wb") as f:
                    f.write(image_bytes)
                img = Image.open(temp_path)
                img = img.resize((target_width, target_height), Image.Resampling.LANCZOS)
                img.save(output_path)
                Path(temp_path).unlink()
                print(f"[NanoBananaPro Upscale] Done: {output_path}")
                return Path(output_path)
            elif self.provider == "openai":
                ref_bytes = []
                if hasattr(ref_image, "inline_data") and ref_image.inline_data:
                    ref_bytes.append(
                        (
                            ref_image.inline_data.data,
                            getattr(ref_image.inline_data, "mime_type", "image/png") or "image/png",
                        )
                    )
                image_bytes, _, openai_error = await _call_openai_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt,
                    reference_images=ref_bytes or None,
                    image_config={
                        "aspect_ratio": "9:16",
                        "image_size": "1K",
                        "output_format": "png",
                    },
                )
                if not image_bytes:
                    raise ValueError(
                        f"OpenAI Image API returned no image data: {openai_error}"
                        if openai_error
                        else "OpenAI Image API returned no image data"
                    )

                temp_path = output_path + ".tmp.png"
                with open(temp_path, "wb") as f:
                    f.write(image_bytes)
                img = Image.open(temp_path)
                img = img.resize((target_width, target_height), Image.Resampling.LANCZOS)
                img.save(output_path)
                Path(temp_path).unlink()
                print(f"[NanoBananaPro Upscale] Done: {output_path}")
                return Path(output_path)
            elif self.provider == "newapi":
                ref_bytes = []
                if hasattr(ref_image, "inline_data") and ref_image.inline_data:
                    ref_bytes.append(
                        (
                            ref_image.inline_data.data,
                            getattr(ref_image.inline_data, "mime_type", "image/png") or "image/png",
                        )
                    )
                image_bytes, _, newapi_error = await _call_newapi_image_api_with_egress(
                    capability="image.edit.upscale",
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt,
                    reference_images=ref_bytes or None,
                    image_config={
                        "aspect_ratio": "9:16",
                        "image_size": "1K",
                        "quality": self.openai_image_quality,
                    },
                    base_url=self.base_url,
                    delivery_path=output_path + ".tmp.png",
                    delivery_state=(image_delivery_state := {}),
                    read_copied_bytes=False,
                )
                if not image_bytes and not image_delivery_state.get("copied"):
                    raise ValueError(
                        f"DramaClawAPI Images returned no image data: {newapi_error}"
                        if newapi_error
                        else "DramaClawAPI Images returned no image data"
                    )

                temp_path = output_path + ".tmp.png"
                if not image_delivery_state.get("copied"):
                    with open(temp_path, "wb") as f:
                        f.write(image_bytes)
                img = Image.open(temp_path)
                img = img.resize((target_width, target_height), Image.Resampling.LANCZOS)
                img.save(output_path)
                Path(temp_path).unlink()
                print(f"[NanoBananaPro Upscale] Done: {output_path}")
                return Path(output_path)
            else:
                # ===== Google direct branch =====
                from google import genai
                from google.genai import types

                client = genai.Client(api_key=self.api_key)

                # gemini-3 supports image_size; gemini-2.5 does not
                is_gemini3 = "gemini-3" in self.model
                if is_gemini3:
                    image_config = types.ImageConfig(
                        aspect_ratio="9:16",
                        image_size="1K",  # 768x1376 (close to the target 720x1280)
                    )
                else:
                    image_config = types.ImageConfig(
                        aspect_ratio="9:16",
                    )

                response = await asyncio.to_thread(
                    client.models.generate_content,
                    model=self.model,
                    contents=[prompt, ref_image],
                    config=types.GenerateContentConfig(
                        response_modalities=["IMAGE", "TEXT"],
                        image_config=image_config,
                    ),
                )

                # Extract the image
                for part in response.candidates[0].content.parts:
                    if hasattr(part, "inline_data") and part.inline_data:
                        # Save as a temp file
                        temp_path = output_path + ".tmp.png"
                        with open(temp_path, "wb") as f:
                            f.write(part.inline_data.data)

                        # Scale to the target size (768x1376 -> 720x1280)
                        img = Image.open(temp_path)
                        img = img.resize((target_width, target_height), Image.Resampling.LANCZOS)
                        img.save(output_path)

                        # Delete the temp file
                        Path(temp_path).unlink()

                        print(f"[NanoBananaPro Upscale] Done: {output_path}")
                        return Path(output_path)

                raise ValueError("API returned no image data")

        except Exception as e:
            print(f"[NanoBananaPro Upscale] Failed: {e}")
            raise

    async def generate_single_preview(
        self,
        prompt: str,
        style_config: dict,
        reference_images: List[str] = None,
        output_path: str = None,
    ) -> bytes:
        """Generate a single preview image for style testing.

        Uses the 1x1 grid mode to quickly generate a single image, for style lab testing.

        Args:
            prompt: scene description (Chinese or English)
            style_config: complete style config dict containing:
                - style_instructions: Gemini style instructions
                - avoid_instructions: Gemini avoid instructions
            reference_images: list of reference image paths (optional)
            output_path: output path (optional)

        Returns:
            Generated image bytes
        """
        start_time = time.time()

        # Extract the style instructions
        style_instructions = style_config.get("style_instructions", "")
        avoid_instructions = style_config.get("avoid_instructions", "")

        # Build the full Prompt
        full_prompt = f"""Generate a single portrait image (9:16 aspect ratio).

SCENE DESCRIPTION:
{prompt}

STYLE REQUIREMENTS:
{style_instructions}

AVOID:
{avoid_instructions}

OUTPUT: Single high-quality image, no watermarks, no text overlays.
"""

        try:
            # Prepare the content
            contents = [full_prompt]

            # Add the reference images (if any)
            if reference_images:
                for ref_path in reference_images:
                    if os.path.exists(ref_path):
                        ref_image = self._load_image_as_part(ref_path)
                        if ref_image:
                            contents.append(ref_image)
                            print(f"[StylePreview] Added reference image: {ref_path}")

            if self.provider == "openrouter":
                # ===== OpenRouter branch =====
                print(f"[StylePreview] Calling OpenRouter ({self.model}) to generate the preview image...")
                prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(contents)
                image_bytes, _, _ = await _call_openrouter_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt_text,
                    reference_images=ref_bytes or None,
                    image_config={"aspect_ratio": "9:16", "image_size": "1K"},
                )
            elif self.provider == "huimeng":
                print(f"[StylePreview] Calling HuiMeng Images ({self.model}) to generate the preview image...")
                prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(contents)
                image_bytes, _, error_detail = await _call_huimeng_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt_text,
                    reference_images=ref_bytes or None,
                    image_config={"aspect_ratio": "9:16", "image_size": "1K"},
                )
                if not image_bytes and error_detail:
                    print(f"[StylePreview] HuiMeng failure details: {error_detail}")
            elif self.provider == "openai":
                # ===== OpenAI Image API branch =====
                print(f"[StylePreview] Calling OpenAI Image API ({self.model}) to generate the preview image...")
                prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(
                    contents,
                    include_mime=True,
                )
                image_bytes, _, error_detail = await _call_openai_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt_text,
                    reference_images=ref_bytes or None,
                    image_config={
                        "aspect_ratio": "9:16",
                        "image_size": "1K",
                        "output_format": "png",
                    },
                )
                if not image_bytes and error_detail:
                    print(f"[StylePreview] OpenAI failure details: {error_detail}")
            elif self.provider == "newapi":
                print(f"[StylePreview] Calling DramaClawAPI Images ({self.model}) to generate the preview image...")
                prompt_text, ref_bytes = self._extract_ref_bytes_from_contents(
                    contents,
                    include_mime=True,
                )
                image_bytes, _, error_detail = await _call_newapi_image_api_with_egress(
                    capability="image.generate.preview",
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt_text,
                    reference_images=ref_bytes or None,
                    image_config={
                        "aspect_ratio": "9:16",
                        "image_size": "1K",
                        "quality": self.openai_image_quality,
                    },
                    base_url=self.base_url,
                    delivery_path=output_path,
                    delivery_state=(image_delivery_state := {}),
                )
                if not image_bytes and error_detail:
                    print(f"[StylePreview] DramaClawAPI failure details: {error_detail}")
            else:
                # ===== Google direct branch =====
                from google import genai
                from google.genai import types

                client = genai.Client(api_key=self.api_key)

                # Call the API - use the 1x1 portrait mode
                is_gemini3 = "gemini-3" in self.model
                if is_gemini3:
                    image_config = types.ImageConfig(
                        aspect_ratio="9:16",
                        image_size="1K",
                    )
                else:
                    image_config = types.ImageConfig(
                        aspect_ratio="9:16",
                    )

                print(f"[StylePreview] Calling {self.model} to generate the preview image...")

                response = await asyncio.to_thread(
                    client.models.generate_content,
                    model=self.model,
                    contents=contents,
                    config=types.GenerateContentConfig(
                        response_modalities=["IMAGE", "TEXT"],
                        image_config=image_config,
                    ),
                )

                # Extract the image data
                image_bytes = None
                if response.candidates and response.candidates[0].content:
                    for part in response.candidates[0].content.parts:
                        if hasattr(part, "inline_data") and part.inline_data:
                            image_bytes = part.inline_data.data
                            break

            if not image_bytes:
                raise ValueError("API returned no image data")

            # Save the file (if an output path was specified)
            if output_path:
                output_dir = os.path.dirname(output_path)
                if output_dir:
                    os.makedirs(output_dir, exist_ok=True)
                if not (self.provider == "newapi" and image_delivery_state.get("copied")):
                    with open(output_path, "wb") as f:
                        f.write(image_bytes)
                print(f"[StylePreview] Preview image saved: {output_path}")

            generation_time = time.time() - start_time
            print(f"[StylePreview] Generation complete, took {generation_time:.1f}s")

            return image_bytes

        except Exception as e:
            print(f"[StylePreview] Generation failed: {e}")
            raise

    async def generate_shot_grid(
        self,
        shot_beats: List[dict],
        character_map: Dict[str, dict] = None,
        scene_menu: list[dict] | list | None = None,
        prop_menu: list[dict] | list | None = None,
        style: str = None,
        output_path: Optional[str] = None,
        ethnicity: str = "Chinese",
        sketch_dir: str = "",
        beat_sketch_paths: dict = None,
    ) -> GridGenerationResult:
        """Generate a Shot-level Grid (v2.0 Shot-Centric).

        N beats in one Shot -> 1 Grid image, used as the @image storyboard reference of Seedance 2.0.
        The Grid format is chosen automatically by beat count: 1->1x1, 2->1x2, 3->1x3, 4->2x2, 5->3x3 (first 5 cells filled).

        This Grid is fed to Seedance 2.0 as a whole image, without cropping.

        Args:
            shot_beats: list of beats in the Shot (1-5)
            character_map: character mapping
            style: style name
            output_path: output path
            ethnicity: character ethnicity
            sketch_dir: sketch directory
            beat_sketch_paths: per-beat sketch paths

        Returns:
            GridGenerationResult
        """
        beat_count = len(shot_beats)
        cfg = get_shot_grid_config(beat_count)
        rows, cols = cfg["rows"], cfg["cols"]
        aspect_ratio = cfg["aspect_ratio"]
        image_size = cfg["image_size"]

        print(f"[ShotGrid] Generating Shot Grid: {beat_count} beats -> {rows}x{cols} ({aspect_ratio})")

        return await self.generate_grid(
            beats=shot_beats,
            character_map=character_map,
            scene_menu=scene_menu,
            prop_menu=prop_menu,
            style=style,
            output_path=output_path,
            ethnicity=ethnicity,
            rows=rows,
            cols=cols,
            sketch_dir=sketch_dir,
            aspect_ratio_override=aspect_ratio,
            image_size_override=image_size,
            beat_sketch_paths=beat_sketch_paths,
        )


def _generation_beat_number(beat: dict, fallback_index: int) -> int:
    raw_beat_number = beat.get("beat_number")
    if raw_beat_number is not None:
        try:
            return int(raw_beat_number)
        except (TypeError, ValueError):
            pass
    raw_panel_index = beat.get("panel_index")
    if raw_panel_index is not None:
        try:
            return int(raw_panel_index)
        except (TypeError, ValueError):
            pass
    return fallback_index + 1


async def regenerate_selected_beats(
    selected_beats: List[dict],
    mode_key: str,
    character_map: Dict[str, dict],
    style: str,
    output_dir: str,
    scene_menu: list[dict] | list | None = None,
    prop_menu: list[dict] | list | None = None,
    sketch_colors: dict[str, str] | None = None,
    ethnicity: str = "Chinese",
    is_sketch: bool = False,
    sketch_dir: str = "",
    api_key: Optional[str] = None,
    episode_grids_dir: str = "",
    beat_sketch_paths_override: dict[int, str] | None = None,
    scene_refs_override: dict[int, list[Any]] | None = None,
    prop_refs_override: dict[int, list[Any]] | None = None,
    sketch_aspect_padding: bool = False,
    force_image_size: Optional[str] = None,
    generator_config: Optional[dict] = None,
    progress_callback: Callable[[int, int], None] | None = None,
    qwen_edit_prompts_by_beat: dict[int, dict] | None = None,
) -> List[GridGenerationResult]:
    """Regenerate the selected beats (supports render and sketch modes).

    Reads rows, cols, aspect_ratio, image_size from RE/tmp/claude-0/-home-user-dramaclaw/57eb0762-a929-5d0a-b399-64cb7e8d2633/scratchpad/gen_MODE_CONFIGS[mode_key],
    splits with perfect_grid_split, then calls generate_grid grid by grid.

    Args:
        selected_beats: list of selected beat data
        mode_key: regeneration mode key, e.g. "1x1_9-16", "2x2_1-1"
        character_map: character mapping
        style: style
        output_dir: output directory
        ethnicity: ethnicity
        is_sketch: whether it is sketch mode
        sketch_dir: sketch directory
        api_key: API key
        sketch_aspect_padding: pad the sketch with white to the target ratio

    Returns:
        List of GridGenerationResult
    """
    rows, cols, aspect_ratio, image_size = parse_regen_mode(mode_key)
    capacity = rows * cols

    # Split the beats
    num_grids = math.ceil(len(selected_beats) / capacity)
    grid_splits = [mode_key] * num_grids
    print(
        f"[RegenBeats] mode={mode_key}, beats={len(selected_beats)}, "
        f"splits={grid_splits}, aspect_ratio={aspect_ratio}"
    )

    jobs: list[
        tuple[int, str, list[dict], list[int], str, int, int, int, dict[int, str] | None]
    ] = []
    beat_offset = 0
    regen_id = uuid.uuid4().hex

    for grid_idx, split_mk in enumerate(grid_splits, start=1):
        split_cfg = REGEN_MODE_CONFIGS[split_mk]
        g_rows, g_cols = split_cfg["rows"], split_cfg["cols"]
        grid_beat_count = split_cfg["capacity"]
        grid_beats = selected_beats[beat_offset : beat_offset + grid_beat_count]
        beat_offset += grid_beat_count

        # Output path
        output_path = str(
            Path(output_dir) / f"regen_{mode_key}_g{grid_idx:02d}_{regen_id}.png"
        )

        # Extract beat numbers for location_beat_numbers
        beat_numbers = [_generation_beat_number(b, i) for i, b in enumerate(grid_beats)]

        # Build per-beat sketch paths from the image pool
        grid_beat_sketch_paths = None
        if episode_grids_dir and not is_sketch:
            from novelvideo.generators.pool_indexer import build_beat_sketch_paths

            grid_beat_sketch_paths = build_beat_sketch_paths(episode_grids_dir, beat_numbers)
        if beat_sketch_paths_override and not is_sketch:
            grid_beat_sketch_paths = {
                int(beat_num): str(path)
                for beat_num, path in beat_sketch_paths_override.items()
                if int(beat_num) in {int(value) for value in beat_numbers}
            }

        jobs.append(
            (
                grid_idx,
                split_mk,
                grid_beats,
                beat_numbers,
                output_path,
                beat_offset - grid_beat_count,
                g_rows,
                g_cols,
                grid_beat_sketch_paths,
            )
        )

    async def generate_job(
        job: tuple[int, str, list[dict], list[int], str, int, int, int, dict | None],
    ) -> tuple[int, GridGenerationResult]:
        (
            grid_idx,
            split_mk,
            grid_beats,
            beat_numbers,
            output_path,
            beat_start_index,
            g_rows,
            g_cols,
            grid_beat_sketch_paths,
        ) = job
        generator = create_grid_generator(api_key, config=generator_config)
        temp_sketch_path = (
            Path(output_path).parent / f"temp_sub_sketch_{Path(output_path).stem}.jpg"
        )
        # qwen_edit_prompts_by_beat is keyed by beat_number — this provider
        # is render-only and 1 grid = 1 beat in every real caller, so the
        # first beat's number is the right (and only) key to look up.
        qwen_edit_prompts = None
        if qwen_edit_prompts_by_beat and beat_numbers:
            qwen_edit_prompts = qwen_edit_prompts_by_beat.get(int(beat_numbers[0]))
        try:
            result = await generator.generate_grid(
                beats=grid_beats,
                character_map=character_map,
                scene_menu=scene_menu,
                prop_menu=prop_menu,
                sketch_colors=sketch_colors,
                style=style,
                output_path=output_path,
                ethnicity=ethnicity,
                rows=g_rows,
                cols=g_cols,
                sketch=is_sketch,
                sketch_dir=sketch_dir if not is_sketch else "",
                location_beat_numbers=beat_numbers,
                mode_key=split_mk,
                beat_sketch_paths=grid_beat_sketch_paths,
                scene_refs_override=scene_refs_override,
                prop_refs_override=prop_refs_override,
                sketch_aspect_padding=sketch_aspect_padding,
                force_image_size=force_image_size,
                qwen_edit_prompts=qwen_edit_prompts,
            )
        finally:
            temp_sketch_path.unlink(missing_ok=True)
        result.beat_start_index = beat_start_index
        result.beat_count = len(grid_beats)
        result.grid_rows = g_rows
        result.grid_cols = g_cols

        if result.success:
            print(f"[RegenBeats] Grid {grid_idx} succeeded: {result.grid_image_path}")
        else:
            print(f"[RegenBeats] Grid {grid_idx} failed: {result.error}")
        return grid_idx, result

    indexed_results: list[tuple[int, GridGenerationResult]] = []
    for completed, job in enumerate(jobs, start=1):
        indexed_results.append(await generate_job(job))
        if progress_callback:
            progress_callback(completed, len(jobs))

    indexed_results.sort(key=lambda item: item[0])
    results = [result for _grid_idx, result in indexed_results]

    return results


def create_grid_generator(
    api_key: Optional[str] = None,
    config: Optional[dict] = None,
) -> NanoBananaGridGenerator:
    """Create a grid generator.

    Args:
        api_key: Google AI API Key

    Returns:
        NanoBananaGridGenerator instance
    """
    return NanoBananaGridGenerator(api_key=api_key, config=config)
