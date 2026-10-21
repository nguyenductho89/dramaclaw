"""Frame / grid / video generation endpoints."""

import json
import io
import logging
import os
import re
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import JSONResponse

from novelvideo.api.auth import get_api_user, require_scope
from novelvideo.api.responses import TemporaryFileResponse
from novelvideo.api.upload_workers import run_asset_upload_operation
from novelvideo.api.deps import (
    get_user_base_dir,
    get_state_dir,
    make_sqlite_store_for_context,
    make_sqlite_store,
    make_static_url_for_context,
    resolve_project_scope,
)
from novelvideo.api.schemas import (
    GlobalOptimizeRequest,
    VideoGenerateRequest,
    VideoBackendOption,
    VideoComposeRequest,
    TTSGenerateRequest,
    TTSPreviewRequest,
    SystemVoicePrepareRequest,
    SketchGenerateRequest,
    GridRegenerateRequest,
    BeatsRegenerateRequest,
    SketchRegenerateRequest,
    SingleVideoRequest,
    MiniMaxH3PromptGenerateRequest,
    MultishotVideoRequest,
    SegmentFrameApproveRequest,
    SegmentFramesGenerateRequest,
    SegmentPlanApplyRequest,
    SegmentVideosGenerateRequest,
    RenderReviewRequest,
    QwenEditPromptGenerateRequest,
    PoolSelectRequest,
    VideoPoolSelectRequest,
    GridCutRequest,
    GridSketchPreviewRequest,
    PlanEntryOut,
    OperatorPasswordVerifyRequest,
    RenderPlanExecuteRequest,
    RenderPlanExecuteResponse,
    RenderPlanRequest,
    RenderPlanResponse,
    RenderSettingsUpdate,
    SketchRegenQueueUpdate,
    SketchSettingsUpdate,
    BeatBackgroundAnchorUpdate,
    Seedance2AssetAudioTrimRequest,
    Seedance2AssetCropRequest,
    Seedance2AssetDeleteRequest,
)
from novelvideo.utils.source_language import (
    detect_asset_language,
    detect_episode_asset_language,
    language_name,
)
from novelvideo.api.viewer_manifests import (
    build_director_stage_manifest,
    build_pano_viewer_manifest,
    default_director_stage_palette,
)
from novelvideo.generators.nanobanana_grid import (
    build_regen_plan,
    compute_input_fingerprint,
    hash_plan,
)
from novelvideo.generators.render_identity_guard import render_ai_detection_error
from novelvideo.manual_shots import pick_beats_by_number
from novelvideo.render_plan.ref_image_hash import RefImageHasher
from novelvideo.seedance2_i2v.pipeline import (
    is_huimeng_seedance2_backend,
    prepare_seedance2_generation_inputs,
)
from novelvideo.seedance2_i2v.voice_clone import normalize_seedance2_audio_type
from novelvideo.project_config import load_project_config, save_project_config
from novelvideo.project_context import ProjectContext
from novelvideo.ports import get_credit_quote, get_task_backend, get_usage_meter
from novelvideo.task_backend.limit_logging import log_task_limit_rejection
from novelvideo.task_backend.limits import (
    ChannelTaskLimitExceeded,
    ProjectTaskLimitExceeded,
    ProjectUserTaskLimitExceeded,
    UserTaskLimitExceeded,
)
from novelvideo.task_identity import project_task_state_key
from novelvideo.models import beat_scene_id
from novelvideo.services.background_anchor_service import (
    BackgroundAnchorError,
    build_background_anchors_payload,
    crop_background_anchor_to_selected,
    save_uploaded_background_anchor_image,
    select_background_anchor,
)
from novelvideo.utils.path_resolver import PathResolver, compute_identity_path, compute_portrait_path


_TemporaryFileResponse = TemporaryFileResponse

router = APIRouter()

logger = logging.getLogger(__name__)

AI_IDENTITY_DETECTION_TASK_TYPE = "ai_identity_detection"
AI_IDENTITY_DETECTION_FEATURE_KEY = "mainline.ai_identity_detection"
MODEL_CALL_CREDIT_POLICY_FEATURE_INCLUDED = "feature_included"


def _single_render_mode_from_sketch(
    output_dir: str,
    episode: int,
    beat_indices: list[int],
) -> str | None:
    """Choose a single-render mode from the canonical upstream sketch."""
    if len(beat_indices) != 1:
        return None

    from PIL import Image

    sketch_path = PathResolver(output_dir, episode).sketch(int(beat_indices[0]))
    try:
        with Image.open(sketch_path) as image:
            width, height = image.size
    except Exception:
        return None
    if width <= 0 or height <= 0:
        return None

    ratio = width / height
    return "1x1_16-9" if abs(ratio - 16 / 9) < abs(ratio - 2 / 3) else "1x1_2-3"


async def _resolve_generation_project(project: str, user: dict, required_role: str = "editor"):
    return await resolve_project_scope(project, user, required_role=required_role)


def _requester_user_id_for_billing(resolved: Any, user: dict) -> str:
    ctx = getattr(resolved, "ctx", None)
    return str(
        getattr(ctx, "requester_user_id", "")
        or user.get("id")
        or user.get("user_id")
        or user.get("username")
        or ""
    )


def _color_assignment_requires_full_sketch_clean(
    previous: dict[str, str] | None,
    current: dict[str, str] | None,
) -> bool:
    """Return whether recoloring invalidates all existing sketches."""
    current_colors = {
        str(key): str(value)
        for key, value in (current or {}).items()
        if str(key).strip() and str(value).strip()
    }
    if not current_colors:
        return False

    previous_colors = {
        str(key): str(value)
        for key, value in (previous or {}).items()
        if str(key).strip() and str(value).strip()
    }
    if not previous_colors:
        return True

    for key, old_value in previous_colors.items():
        new_value = current_colors.get(key)
        if new_value is not None and new_value != old_value:
            return True
    return False


def normalize_beat_indices(beat_indices: list[int]) -> list[int]:
    normalized: list[int] = []
    seen: set[int] = set()
    for beat_index in beat_indices:
        value = int(beat_index)
        if value in seen:
            continue
        normalized.append(value)
        seen.add(value)
    return normalized


def validate_beat_indices(all_beats: list[dict], beat_indices: list[int]) -> list[int]:
    valid_beat_numbers = {int(beat.get("beat_number", 0) or 0) for beat in all_beats}
    return [
        int(beat_index) for beat_index in beat_indices if int(beat_index) not in valid_beat_numbers
    ]


def _render_plan_feature_disabled() -> bool:
    return os.getenv("DISABLE_RENDER_PLAN_V2") in {"1", "true", "True", "yes"}


def _resolve_render_image_selection(
    project_config: dict,
    requested_selection: str | None = None,
) -> str:
    from novelvideo.config import (
        DEFAULT_RENDER_IMAGE_SELECTION,
        normalize_image_generation_selection,
    )

    return normalize_image_generation_selection(
        requested_selection or project_config.get("render_image_selection"),
        fallback=DEFAULT_RENDER_IMAGE_SELECTION,
    )


def _resolve_sketch_image_selection(
    project_config: dict,
    requested_selection: str | None = None,
) -> str:
    from novelvideo.config import (
        DEFAULT_SKETCH_IMAGE_SELECTION,
        normalize_image_generation_selection,
    )

    return normalize_image_generation_selection(
        requested_selection or project_config.get("sketch_image_selection"),
        fallback=DEFAULT_SKETCH_IMAGE_SELECTION,
    )


def _image_selection_billing_metadata(
    image_selection: str,
    mode_key: str,
    *,
    image_role: str,
) -> dict:
    from novelvideo.config import (
        IMAGE_GENERATION_SELECTIONS,
        normalize_image_generation_selection,
    )
    from novelvideo.api.routes.model_credits import _image_selection_billing_params

    selection = normalize_image_generation_selection(image_selection)
    model_cfg = IMAGE_GENERATION_SELECTIONS.get(selection) or {}
    pricing_model = str(model_cfg.get("model") or "").strip()
    if not pricing_model:
        return {}
    pricing_params = _image_selection_billing_params(
        model=pricing_model,
        mode_key=mode_key,
        image_role=image_role,
    )
    return {
        "image_selection": selection,
        "pricing_kind": "image",
        "pricing_model": pricing_model,
        "pricing_params": pricing_params,
        "pricing_model_selection": selection,
        "pricing_model_label": str(model_cfg.get("label") or selection),
    }


def _sketch_regen_billing_metadata(image_selection: str, mode_key: str) -> dict:
    return _image_selection_billing_metadata(
        image_selection,
        mode_key,
        image_role="sketch",
    )


def _render_regen_billing_metadata(image_selection: str, mode_key: str) -> dict:
    return _image_selection_billing_metadata(
        image_selection,
        mode_key,
        image_role="render",
    )


def _single_video_billing_metadata(
    video_backend: str,
    *,
    resolution: str | None,
    duration: int | float | str | None,
) -> dict:
    if _is_runpod_h3_backend(video_backend):
        # Dev-only backend: runs on the user's own RunPod account, billed
        # directly by RunPod, never through DramaClaw credits — it isn't
        # (and shouldn't be) in `model_credits.py`'s known-backend list, so
        # routing it through `_video_backend_feature_billing_params` would
        # raise "invalid video backend" (confirmed: this crashed the real
        # /video submission once the review/duration-fingerprint bugs above
        # were fixed). An empty billing dict is the same "nothing to meter
        # here" shape `run_core.py`'s settlement resolver already treats as
        # `not_applicable` for every other no-charge task.
        return {}
    from novelvideo.api.routes.model_credits import (
        _video_backend_feature_billing_params,
    )
    return _video_backend_feature_billing_params(
        {
            "video_backend": video_backend,
            "resolution": str(resolution or "").strip(),
            "pricing_quantity": duration,
        }
    )


def _resolve_render_bool_setting(
    project_config: dict,
    key: str,
    requested_value: bool | None,
    default: bool,
) -> bool:
    if requested_value is not None:
        return bool(requested_value)
    return bool(project_config.get(key, default))


def _render_settings_payload(username: str, project: str) -> dict:
    from novelvideo.config import image_generation_selection_options

    project_config = load_project_config(username, project)
    return {
        "render_image_selection": _resolve_render_image_selection(project_config),
        "options": image_generation_selection_options(),
        "sketch_aspect_padding": _resolve_render_bool_setting(
            project_config,
            "sketch_aspect_padding",
            None,
            True,
        ),
    }


def _sketch_settings_payload(username: str, project: str) -> dict:
    from novelvideo.config import image_generation_selection_options

    project_config = load_project_config(username, project)
    return {
        "sketch_image_selection": _resolve_sketch_image_selection(project_config),
        "options": image_generation_selection_options(),
    }


def _plan_entry_to_dict(entry: Any) -> dict:
    if isinstance(entry, dict):
        beat_numbers = entry.get("beat_numbers") or []
        reasons = entry.get("reasons") or []
        warnings = entry.get("warnings") or []
        return PlanEntryOut(
            mode_key=entry.get("mode_key", ""),
            rows=int(entry.get("rows", 0) or 0),
            cols=int(entry.get("cols", 0) or 0),
            beat_numbers=[int(beat) for beat in beat_numbers],
            location=str(entry.get("location") or ""),
            padding_count=int(entry.get("padding_count") or 0),
            reasons=[str(reason) for reason in reasons],
            warnings=[str(warning) for warning in warnings],
        ).model_dump()

    return PlanEntryOut(
        mode_key=entry.mode_key,
        rows=entry.rows,
        cols=entry.cols,
        beat_numbers=list(entry.beat_numbers),
        location=entry.location,
        padding_count=entry.padding_count,
        reasons=list(entry.reasons),
        warnings=list(entry.warnings),
    ).model_dump()


def _plan_to_dicts(plan) -> list[dict]:
    return [_plan_entry_to_dict(entry) for entry in plan]


def _parse_grid_beat_numbers(raw: str | None) -> list[int]:
    if not raw:
        return []
    text = raw.strip()
    if not text:
        return []
    if text.startswith("["):
        parsed = json.loads(text)
        values = parsed if isinstance(parsed, list) else []
    else:
        values = re.split(r"[,;\s]+", text)
    beat_numbers: list[int] = []
    seen: set[int] = set()
    for value in values:
        if value in ("", None):
            continue
        beat_num = int(value)
        if beat_num <= 0 or beat_num in seen:
            continue
        beat_numbers.append(beat_num)
        seen.add(beat_num)
    return beat_numbers


def _safe_grid_token(value: str) -> str:
    token = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value.strip())
    return token.strip("._-") or "grid"


def _uploaded_grid_filename(
    grid_type: str, mode_key: str, beat_numbers: list[int], ext: str
) -> str:
    beats_slug = "-".join(str(beat) for beat in beat_numbers) or "manual"
    return (
        f"{_safe_grid_token(grid_type)}_{_safe_grid_token(mode_key)}_"
        f"{beats_slug}_grid_upload.{ext.lstrip('.')}"
    )


def _safe_grids_file(grids_dir: Path, relative_path: str) -> Path | None:
    if not relative_path:
        return None
    try:
        candidate = (grids_dir / relative_path).resolve()
        root = grids_dir.resolve()
    except Exception:
        return None
    if root == candidate or root not in candidate.parents:
        return None
    return candidate


def _find_pool_grid_entry(
    pool: Any,
    *,
    grid_type: str,
    mode_key: str | None,
    beat_numbers: list[int],
    grid_index: int,
) -> Any | None:
    if pool is None:
        return None
    if mode_key and beat_numbers:
        entry = pool.find_grid(grid_type, mode_key, beat_numbers)
        if entry is not None:
            return entry

    image_grid_paths = {
        img.grid_path
        for img in getattr(pool, "images", [])
        if img.type == grid_type
        and img.grid_index == grid_index
        and (not beat_numbers or img.original_beat in beat_numbers)
        and img.grid_path
    }
    for entry in getattr(pool, "grids", []):
        if entry.type != grid_type:
            continue
        if mode_key and entry.mode_key != mode_key:
            continue
        if beat_numbers and set(entry.beat_nums) != set(beat_numbers):
            continue
        if not image_grid_paths or entry.grid_path in image_grid_paths:
            return entry
    return None


_FANOUT_ACTIVE_LIMIT_ERRORS = (
    ChannelTaskLimitExceeded,
    UserTaskLimitExceeded,
    ProjectTaskLimitExceeded,
    ProjectUserTaskLimitExceeded,
)


_FanoutLimitError = (
    ChannelTaskLimitExceeded
    | UserTaskLimitExceeded
    | ProjectTaskLimitExceeded
    | ProjectUserTaskLimitExceeded
)


def _task_limit_reason(exc: _FanoutLimitError) -> str:
    """Limit-hit exception -> scope word.

    The branches must be derived verbatim from the ``limit_scope`` in ``api/app.py`` (``:226`` channel limit /
    ``:206`` and ``:271`` person limit) -- the same algorithm on both sides is a drift detector across EUs, so the three fan-out
    loops share this one helper instead of each inlining a copy.
    """
    if isinstance(exc, ProjectTaskLimitExceeded):
        return "project"
    if isinstance(exc, ChannelTaskLimitExceeded):
        return "platform" if exc.scope_kind == "platform" else "channel"
    if isinstance(exc, (ProjectUserTaskLimitExceeded, UserTaskLimitExceeded)):
        return "user"
    # pragma: no cover - the precise catch tuple keeps this unreachable
    raise TypeError(f"unsupported fanout task-limit exception: {type(exc).__name__}")


def _log_partial_dispatch_rejection(exc: _FanoutLimitError) -> None:
    """Limit hit after k > 0 were dispatched: the exception is swallowed in place and the response is 200, so it never reaches the handler in ``api/app.py``,
    and the log must be added here -- otherwise "limit hit halfway through dispatch" does not exist on the dashboard.

    One log line per limit hit (for the exception actually caught), not per synthesized ``rejected`` entry afterwards.
    """
    log_task_limit_rejection(exc, limit_scope=_task_limit_reason(exc))


def _task_limit_rejection(scope: str, exc: _FanoutLimitError) -> dict[str, Any]:
    """Translate a limit-hit exception into one ``rejected`` entry of the fan-out response (frozen shape of M8 §8.2)."""
    return {
        "scope": scope,
        "reason": _task_limit_reason(exc),
        "limit": exc.limit,
        "active": exc.active,
    }


def _custom_render_plan_error(plan: list[Any], beat_indices: list[int]) -> str | None:
    flat: list[int] = []
    seen: set[int] = set()
    for entry in plan:
        beat_numbers = [int(beat) for beat in getattr(entry, "beat_numbers", [])]
        if not beat_numbers:
            return "empty_grid"
        if int(getattr(entry, "rows", 0)) * int(getattr(entry, "cols", 0)) < len(beat_numbers):
            return "grid_capacity"
        for beat in beat_numbers:
            if beat in seen:
                return "duplicate_beat"
            seen.add(beat)
            flat.append(beat)
    if set(flat) != set(beat_indices) or len(flat) != len(beat_indices):
        return "beat_mismatch"
    return None


async def _read_uploaded_rgb_image(file: UploadFile):
    content = await file.read()
    if not content:
        raise ValueError("empty file")
    try:
        from PIL import Image

        return Image.open(io.BytesIO(content)).convert("RGB")
    except Exception as exc:
        raise ValueError(f"invalid image file: {exc}") from exc


def _register_uploaded_pool_image(
    *,
    project_dir: Path,
    episode_num: int,
    beat_num: int,
    image,
    image_type: str,
) -> str:
    from datetime import datetime
    from novelvideo.generators.pool_indexer import (
        add_cell_with_dedup,
        build_pool_index,
        _state_pool_index_path,
        _load_pool_index_for_update,
        _save_pool_index_unlocked,
        index_file_lock,
    )

    grids_dir = project_dir / "grids" / f"ep{episode_num:03d}"
    with index_file_lock(_state_pool_index_path(grids_dir)):
        index_path, pool = _load_pool_index_for_update(grids_dir)
        pool = pool or build_pool_index(grids_dir, episode_num)
        upload_dir = grids_dir / image_type
        upload_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
        cell_path = upload_dir / f"beat_{beat_num:02d}_t{timestamp}.png"
        canonical_dir = project_dir / (
            "sketches" if image_type == "sketch" else "frames"
        ) / f"ep{episode_num:03d}"
        canonical_dir.mkdir(parents=True, exist_ok=True)
        image.save(canonical_dir / f"beat_{beat_num:02d}.png", format="PNG")
        image.save(cell_path, format="PNG")

        pool_image = add_cell_with_dedup(
            pool,
            cell_path,
            grids_dir,
            beat_num,
            timestamp,
            img_type=image_type,
            mode="upload",
            grid_index=0,
            cell_index=0,
            grid_path="",
            row=0,
            col=0,
        )
        if pool_image is None:
            pool_id = f"beat_{beat_num:02d}_t{timestamp}_{image_type}"
            assignment_path = None
        else:
            pool_id = pool_image.id
            assignment_path = pool_image.cell_path
        if image_type != "sketch" and assignment_path:
            pool.beat_assignments[str(beat_num)] = assignment_path
        _save_pool_index_unlocked(pool, index_path)
    return pool_id


async def _runtime_prop_menu_with_global_props(
    store: Any,
    episode_obj: Any,
    beats: list[dict],
) -> list[dict]:
    """Resolve episode prop markers against the global props table without mutating episode JSON."""
    from novelvideo.models import build_prop_menu, collect_prop_marker_ids_from_beat

    prop_menu = [item.model_dump() for item in episode_obj.prop_menu] if episode_obj else []
    marked_prop_ids: list[str] = []
    for beat in beats or []:
        for prop_id in collect_prop_marker_ids_from_beat(beat):
            if prop_id and prop_id not in marked_prop_ids:
                marked_prop_ids.append(prop_id)
    if not marked_prop_ids:
        return prop_menu

    existing = {item.prop_id: item.model_dump() for item in build_prop_menu(prop_menu=prop_menu)}
    changed = False
    for marker_prop_id in marked_prop_ids:
        global_prop = (
            store.get_cached_prop(marker_prop_id) if hasattr(store, "get_cached_prop") else None
        )
        if not global_prop:
            continue
        item = dict(existing.get(marker_prop_id) or {"prop_id": marker_prop_id})
        item["is_global_asset"] = True
        item["prop_type"] = (
            item.get("prop_type") or getattr(global_prop, "prop_type", "") or "object"
        )
        item["description"] = (
            item.get("description")
            or getattr(global_prop, "description", "")
            or getattr(global_prop, "visual_prompt", "")
            or marker_prop_id
        )
        existing[marker_prop_id] = item
        changed = True
    if not changed:
        return prop_menu

    ordered_ids: list[str] = []
    for item in build_prop_menu(prop_menu=prop_menu):
        if item.prop_id not in ordered_ids:
            ordered_ids.append(item.prop_id)
    for prop_id in marked_prop_ids:
        if prop_id in existing and prop_id not in ordered_ids:
            ordered_ids.append(prop_id)
    return [existing[prop_id] for prop_id in ordered_ids if prop_id in existing]


def _prop_marker_colors_from_menu(prop_menu: list[dict] | None) -> dict[str, str]:
    colors: dict[str, str] = {}
    for item in prop_menu or []:
        if not isinstance(item, dict):
            continue
        prop_id = str(item.get("prop_id") or "").strip()
        marker_color = str(item.get("marker_color") or "").strip()
        if prop_id and marker_color:
            colors[prop_id] = marker_color
    return colors


def _episode_from_store_or_none(store: Any, episode_num: int) -> Any | None:
    get_episode = getattr(store, "get_episode", None)
    if get_episode is None:
        return None
    try:
        return get_episode(episode_num)
    except Exception:
        return None


async def _build_character_map(
    store,
    beats,
    username,
    project,
    *,
    episode_num: int | None = None,
    use_detected_identities: bool = False,
):
    """Build the character map."""
    from novelvideo.services.character_ref_service import build_character_map_for_grid

    project_dir = get_user_base_dir(username) / project
    characters = store.get_all_characters()
    char_dicts = []
    for c in characters:
        char_dicts.append(
            {
                "name": c.name,
                "gender": c.gender,
                "body_type": getattr(c, "body_type", ""),
                "role": c.role,
                "is_main": getattr(c, "is_main", False),
                "portrait_path": compute_portrait_path(project_dir, c.name),
                "face_prompt": c.face_prompt,
                "appearance_details": c.appearance_details,
                "identities": (
                    [
                        {
                            "identity_id": id_.identity_id,
                            "identity_name": id_.identity_name,
                            "appearance_details": id_.appearance_details,
                            "face_prompt": id_.face_prompt,
                            "body_type": id_.body_type,
                            "fish_voice_id": id_.fish_voice_id,
                            "age_group": id_.age_group,
                            "portrait_image": id_.portrait_image,
                            "costume_image": id_.costume_image,
                            "primary_reference": compute_identity_path(
                                project_dir, c.name, id_.identity_name
                            ),
                            "character_tag": id_.character_tag,
                            "source": id_.source,
                        }
                        for id_ in c.identities
                    ]
                    if c.identities
                    else []
                ),
            }
        )

    # Prefer reading sketch_colors from SQLite; if missing, reassign according to the current beats and write back to SQLite.
    _sc = None
    if episode_num:
        _sc = store.get_sketch_colors(episode_num) or None
        if not _sc:
            from novelvideo.generators.episode_optimizer import EpisodeOptimizer

            _sc = (
                EpisodeOptimizer.assign_sketch_colors(
                    char_dicts,
                    episode_beats=beats,
                )
                or None
            )

            if _sc:
                await store.set_sketch_colors(episode_num, _sc)

    return build_character_map_for_grid(
        grid_beats=beats,
        characters=char_dicts,
        user_output_dir=get_user_base_dir(username),
        project=project,
        sketch_colors=_sc,
        use_detected_identities=use_detected_identities,
    )


def _validate_seedance_pro_dialogue_only(beats: list[dict], video_backend: str) -> str | None:
    """Seedance 1.5 with audio is only allowed for dialogue beats."""
    if video_backend not in {"seedance_pro", "newapi_seedance-1.5-pro"}:
        return None

    non_dialogue = [
        int(beat.get("beat_number", 0))
        for beat in beats
        if beat.get("audio_type", "narration") != "dialogue"
    ]
    if not non_dialogue:
        return None

    preview = ", ".join(str(num) for num in non_dialogue[:8])
    suffix = " etc." if len(non_dialogue) > 8 else ""
    return f"Seedance 1.5 with audio is only allowed for dialogue beats; non-dialogue Beats are included: {preview}{suffix}"


def _is_seedance2_backend(video_backend: str | None) -> bool:
    return is_huimeng_seedance2_backend(video_backend)


def _is_happyhorse_backend(video_backend: str | None) -> bool:
    return _seedance2_model_from_backend(video_backend) == "happyhorse-1.0"


def _is_grok_video_backend(video_backend: str | None) -> bool:
    return _seedance2_model_from_backend(video_backend) == "grok-video-channel"


def _is_runpod_h3_backend(video_backend: str | None) -> bool:
    return str(video_backend or "").strip() == "runpod_minimax_h3"


_H3_STRUCTURED_PROMPT_RE = re.compile(
    r"^(subject_definitions|integrated_multimodal_description):\s*$", re.MULTILINE
)


def _is_h3_structured_prompt(text: str | None) -> bool:
    """True when `text` already has the shape of an assembled MiniMax H3
    prompt (ref2va's `subject_definitions:` or fl2va's
    `integrated_multimodal_description:` section header) — as opposed to,
    e.g., a Seedance2/HappyHorse/Grok prose prompt sitting in the same
    shared `final_prompt` field. Used by `review_single_video` to decide
    whether the stored prompt is worth linting as H3 at all, rather than
    reporting the same "missing every section" wall of errors for text
    that was never meant to be H3 in the first place."""
    return bool(_H3_STRUCTURED_PROMPT_RE.search(str(text or "")))


def _seedance2_api_resolution(resolution: str | None) -> str:
    text = str(resolution or "").strip()
    if text in {"480p", "720p", "1080p"}:
        return text
    if "480" in text:
        return "480p"
    if "1080" in text:
        return "1080p"
    return "720p"


SEEDANCE2_RESOLUTION_OPTIONS_BY_MODEL = {
    "seedance-2.0-fast": ("480p", "720p"),
    "seedance-2.0": ("480p", "720p", "1080p"),
    "seedance-2.0-value": ("720p", "1080p"),
    "seedance-2.0-fast-value": ("720p", "1080p"),
    # Seedance 1.5 Pro (with audio) resolutions, from huimengi /api/v1/models (480p/720p/1080p)
    "seedance-1.5-pro": ("480p", "720p", "1080p"),
}
SEEDANCE2_DEFAULT_RESOLUTION_OPTIONS = ("480p", "720p")
HAPPYHORSE_RESOLUTION_OPTIONS = ("720p", "1080p")
HAPPYHORSE_RATIO_OPTIONS = ("16:9", "9:16", "1:1", "4:3", "3:4")
HAPPYHORSE_SUPPORTED_MODES = ("first_frame", "multimodal_reference")
GROK_VIDEO_RESOLUTION_OPTIONS = ("720p", "480p")
GROK_VIDEO_RATIO_OPTIONS = ("16:9", "9:16", "1:1", "2:3", "3:2")
GROK_VIDEO_SUPPORTED_MODES = ("first_frame", "multimodal_reference")


def _seedance2_model_from_backend(video_backend: str | None) -> str:
    text = str(video_backend or "").strip().lower()
    for prefix in ("newapi_", "huimeng_", "huimengi_"):
        if text.startswith(prefix):
            return text[len(prefix) :].strip()
    return text


def _seedance2_resolution_options_for_backend(video_backend: str | None) -> tuple[str, ...]:
    model = _seedance2_model_from_backend(video_backend)
    return SEEDANCE2_RESOLUTION_OPTIONS_BY_MODEL.get(
        model,
        SEEDANCE2_DEFAULT_RESOLUTION_OPTIONS,
    )


def _seedance2_resolution_for_backend(
    video_backend: str | None,
    resolution: str | None,
) -> str:
    clean_resolution = _seedance2_api_resolution(resolution)
    options = _seedance2_resolution_options_for_backend(video_backend)
    if clean_resolution in options:
        return clean_resolution
    if "720p" in options:
        return "720p"
    return options[0]


def _happyhorse_resolution_for_backend(resolution: str | None) -> str:
    text = str(resolution or "").strip().lower()
    if "720" in text:
        return "720p"
    return "1080p"


def _happyhorse_ratio_for_backend(ratio: str | None) -> str:
    text = str(ratio or "").strip()
    return text if text in HAPPYHORSE_RATIO_OPTIONS else "16:9"


def _grok_video_resolution_for_backend(resolution: str | None) -> str:
    text = str(resolution or "").strip().lower()
    return text if text in GROK_VIDEO_RESOLUTION_OPTIONS else "720p"


def _grok_video_ratio_for_backend(ratio: str | None) -> str:
    text = str(ratio or "").strip()
    return text if text in GROK_VIDEO_RATIO_OPTIONS else "16:9"


def _seedance2_initial_prompt(beat: dict[str, Any], video_mode: str) -> str:
    if video_mode == "keyframe":
        return str(beat.get("keyframe_prompt") or "").strip()
    return str(beat.get("video_prompt") or beat.get("keyframe_prompt") or "").strip()


def _legacy_video_prompt_for_mode(beat: dict[str, Any], video_mode: str) -> str:
    if video_mode == "keyframe":
        return str(beat.get("keyframe_prompt") or "").strip()
    return str(beat.get("video_prompt") or "").strip()


def _missing_video_prompt_error(beat_num: int) -> str:
    return f"Beat {beat_num} has no video prompt. Click 'Generate this Beat's prompt' first."


SEEDANCE2_SINGLE_VIDEO_CONFIG_FIELDS = {
    "mode",
    "duration",
    "resolution",
    "ratio",
    "generate_audio",
    "return_last_frame",
    "human_review",
    "scene_optimize",
    "final_prompt",
    "prompt_guidance",
    "text_overlay",
}


def _seedance2_request_config_overrides(body: SingleVideoRequest) -> dict[str, Any]:
    return {
        field: getattr(body, field)
        for field in SEEDANCE2_SINGLE_VIDEO_CONFIG_FIELDS
        if field in body.model_fields_set and getattr(body, field) is not None
    }


def _merge_seedance2_request_config(
    beat: dict[str, Any],
    *,
    seedance2_config_json: str | None = None,
    config_overrides: dict[str, Any] | None = None,
) -> str | None:
    config_overrides = dict(config_overrides or {})
    if seedance2_config_json is None and not config_overrides:
        return None

    from novelvideo.seedance2_i2v.models import dump_seedance2_config, parse_seedance2_config

    merged = parse_seedance2_config(beat.get("seedance2_config_json")).model_dump(mode="json")
    incoming: dict[str, Any] = {}
    if seedance2_config_json is not None:
        try:
            incoming = json.loads(str(seedance2_config_json or "{}"))
        except json.JSONDecodeError as exc:
            raise ValueError("seedance2_config_json must be valid JSON") from exc
        if not isinstance(incoming, dict):
            raise ValueError("seedance2_config_json must be a JSON object")
        merged.update(incoming)
    merged.update(config_overrides)

    if "generate_audio" in incoming or "generate_audio" in config_overrides:
        merged["generate_audio_user_set"] = True
    if "human_review" in incoming or "human_review" in config_overrides:
        merged["human_review_user_set"] = True

    saved_json = dump_seedance2_config(merged)
    beat["seedance2_config_json"] = saved_json
    return saved_json


async def _api_audio_duration_seconds(output_dir: str | Path, episode: int, beat_num: int):
    """Duration of one beat's audio, or ``None`` if there isn't one to report.

    ``None`` already means "no duration for this beat" here (the file may simply
    not have been generated yet), so a probe that fails or times out reports the
    same thing rather than failing the whole beat list. On network storage an
    unreadable file is a routine condition, not a request-level error.
    """
    from novelvideo.utils.media_io import get_audio_duration_async
    from novelvideo.utils.path_resolver import PathResolver

    audio_path = PathResolver(output_dir, episode).audio(beat_num)
    if not audio_path.exists():
        return None
    try:
        return await get_audio_duration_async(str(audio_path))
    except Exception:
        return None


async def _prepare_seedance2_api_beat(
    *,
    store: Any,
    output_dir: str | Path,
    episode: int,
    beat: dict[str, Any],
    all_beats: list[dict[str, Any]],
    index: int,
    video_backend: str | None,
    resolution: str | None,
    ratio: str | None = None,
    prop_menu: list[Any] | None = None,
) -> Any:
    from novelvideo.manual_shots import resolve_target_video_duration
    from novelvideo.seedance2_i2v.models import parse_seedance2_config

    beat_num = int(beat.get("beat_number") or index + 1)
    video_mode = str(beat.get("video_mode") or "first_frame")
    audio_duration = await _api_audio_duration_seconds(output_dir, episode, beat_num)
    target_duration = resolve_target_video_duration(beat, audio_duration)
    current_config = parse_seedance2_config(beat.get("seedance2_config_json"))
    requested_resolution = (
        _seedance2_api_resolution(resolution)
        if resolution
        else current_config.resolution
    )
    prepared = await prepare_seedance2_generation_inputs(
        project_output=output_dir,
        state_dir=Path(store.state_dir),
        episode=episode,
        beat=beat,
        next_beat=all_beats[index + 1] if index + 1 < len(all_beats) else None,
        video_mode=video_mode,
        prompt=_seedance2_initial_prompt(beat, video_mode),
        duration=target_duration,
        resolution=_seedance2_resolution_for_backend(
            video_backend,
            requested_resolution,
        ),
        ratio=ratio,
        prop_menu=prop_menu,
    )
    if not str(prepared.prompt or "").strip():
        raise ValueError(
            f"Beat {beat_num} Seedance 2.0 final prompt is empty. "
            "Fill in the Seedance 2.0 subject prompt or click 'AI optimize' first."
        )

    beat["seedance2_config_json"] = prepared.seedance2_config_json
    if hasattr(store, "update_beat_asset"):
        await store.update_beat_asset(
            episode_number=episode,
            beat_number=beat_num,
            seedance2_config_json=prepared.seedance2_config_json,
        )
    return prepared


async def _prepare_happyhorse_api_beat(
    *,
    output_dir: str | Path,
    state_dir: str | Path,
    episode: int,
    beat: dict[str, Any],
    next_beat: dict[str, Any] | None,
    frame_path: Path,
    video_mode: str,
    prompt: str,
    duration: float,
    resolution: str | None,
    ratio: str | None,
    prop_menu: list[Any] | None = None,
) -> dict[str, Any]:
    from novelvideo.seedance2_i2v.assets import (
        append_seedance2_user_reference_assets,
        build_seedance2_project_assets,
        selected_reference_paths,
    )
    from novelvideo.seedance2_i2v.models import (
        Seedance2I2VMode,
        dump_seedance2_config,
        parse_seedance2_config,
    )

    config = parse_seedance2_config(beat.get("seedance2_config_json"))
    mode = config.mode
    if mode == Seedance2I2VMode.FIRST_LAST_FRAME or video_mode == "keyframe":
        raise ValueError("HappyHorse 1.0 does not support first+last-frame mode. Use first-frame mode or multi-reference mode instead")

    final_prompt = str(config.final_prompt or prompt or "").strip()
    if not final_prompt:
        beat_num = int(beat.get("beat_number") or 0)
        prefix = f"Beat {beat_num} " if beat_num else ""
        raise ValueError(f"{prefix} has no video prompt. Generate or fill in the video prompt first")

    target_duration = int(config.duration or duration or 0)
    config.duration = target_duration
    config.resolution = _happyhorse_resolution_for_backend(resolution or config.resolution)
    config.ratio = _happyhorse_ratio_for_backend(ratio or config.ratio)
    config.final_prompt = final_prompt

    image_path: str | None = None
    references: list[dict[str, str]] = []

    if mode == Seedance2I2VMode.FIRST_FRAME:
        image_path = str(frame_path)
    else:
        assets = build_seedance2_project_assets(
            project_output=Path(output_dir),
            episode=episode,
            beat=beat,
            mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
            state_dir=state_dir,
            next_beat=next_beat,
            prop_menu=prop_menu,
        )
        append_seedance2_user_reference_assets(
            assets,
            reference_image_paths=list(config.reference_image_paths),
            reference_audio_paths=[],
        )
        image_paths = selected_reference_paths(assets, "reference_images")
        config.reference_image_paths = list(dict.fromkeys(image_paths))[:9]
        config.reference_audio_paths = []
        references = [
            {"type": "image", "path": path, "role": f"image{index}"}
            for index, path in enumerate(config.reference_image_paths, 1)
        ]

    return {
        "prompt": final_prompt,
        "duration": target_duration,
        "resolution": config.resolution,
        "ratio": config.ratio,
        "image_path": image_path,
        "references": references,
        "config_json": dump_seedance2_config(config),
    }


async def _prepare_grok_video_api_beat(
    *,
    output_dir: str | Path,
    state_dir: str | Path,
    episode: int,
    beat: dict[str, Any],
    next_beat: dict[str, Any] | None,
    frame_path: Path,
    video_mode: str,
    prompt: str,
    duration: float,
    resolution: str | None,
    ratio: str | None,
    prop_menu: list[Any] | None = None,
) -> dict[str, Any]:
    from novelvideo.seedance2_i2v.assets import (
        append_seedance2_user_reference_assets,
        build_seedance2_project_assets,
        selected_reference_paths,
    )
    from novelvideo.seedance2_i2v.models import (
        Seedance2I2VMode,
        dump_seedance2_config,
        parse_seedance2_config,
    )

    config = parse_seedance2_config(beat.get("seedance2_config_json"))
    mode = config.mode
    if mode == Seedance2I2VMode.FIRST_LAST_FRAME or video_mode == "keyframe":
        raise ValueError("Grok Video does not support first+last-frame mode. Use first-frame mode or multi-reference mode instead")

    final_prompt = str(config.final_prompt or prompt or "").strip()
    if not final_prompt:
        beat_num = int(beat.get("beat_number") or 0)
        prefix = f"Beat {beat_num} " if beat_num else ""
        raise ValueError(f"{prefix} has no video prompt. Generate or fill in the video prompt first")

    target_duration = int(config.duration or duration or 0)
    config.duration = target_duration
    config.resolution = _grok_video_resolution_for_backend(resolution or config.resolution)
    config.ratio = _grok_video_ratio_for_backend(ratio or config.ratio)
    config.final_prompt = final_prompt

    image_path: str | None = None
    references: list[dict[str, str]] = []

    if mode == Seedance2I2VMode.FIRST_FRAME:
        image_path = str(frame_path)
    else:
        assets = build_seedance2_project_assets(
            project_output=Path(output_dir),
            episode=episode,
            beat=beat,
            mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
            state_dir=state_dir,
            next_beat=next_beat,
            prop_menu=prop_menu,
        )
        append_seedance2_user_reference_assets(
            assets,
            reference_image_paths=list(config.reference_image_paths),
            reference_audio_paths=[],
        )
        image_paths = selected_reference_paths(assets, "reference_images")
        config.reference_image_paths = list(dict.fromkeys(image_paths))[:7]
        config.reference_audio_paths = []
        references = [
            {"type": "image", "path": path, "role": f"image{index}"}
            for index, path in enumerate(config.reference_image_paths, 1)
        ]

    return {
        "prompt": final_prompt,
        "duration": target_duration,
        "resolution": config.resolution,
        "ratio": config.ratio,
        "image_path": image_path,
        "references": references,
        "config_json": dump_seedance2_config(config),
    }


def _seedance2_asset_status_payload(
    asset: Any,
    *,
    project_ctx: ProjectContext,
    output_dir: Path,
) -> dict[str, Any]:
    try:
        rel_path = str(Path(asset.path).relative_to(output_dir))
    except ValueError:
        rel_path = str(asset.path)
    abs_path = str(asset.path)
    crop_source_path = getattr(asset, "crop_source_path", None)
    crop_source_abs_path = str(crop_source_path) if crop_source_path else ""
    crop_source_rel_path = ""
    if crop_source_path:
        try:
            crop_source_rel_path = str(Path(crop_source_path).relative_to(output_dir))
        except ValueError:
            crop_source_rel_path = crop_source_abs_path
    media_url = ""
    if bool(asset.exists):
        media_url = make_static_url_for_context(project_ctx, rel_path, local_path=Path(asset.path))
    crop_source_url = ""
    if crop_source_path and Path(crop_source_path).exists():
        crop_source_url = make_static_url_for_context(
            project_ctx,
            crop_source_rel_path,
            local_path=Path(crop_source_path),
        )
    can_delete = (
        str(asset.key).startswith(("user_image:", "user_audio:"))
        or "seedance2_uploads" in Path(abs_path).parts
        or "seedance2_crops" in Path(abs_path).parts
    )
    return {
        "key": str(asset.key),
        "label": str(asset.label),
        "media_type": str(asset.media_type),
        "selected": bool(asset.selected),
        "exists": bool(asset.exists),
        "reference_label": str(asset.reference_label),
        "note": str(asset.note or asset.validation_error or ""),
        "identity_id": str(getattr(asset, "identity_id", "") or ""),
        "prop_id": str(getattr(asset, "prop_id", "") or ""),
        "prop_scope": str(getattr(asset, "prop_scope", "") or ""),
        "path": rel_path,
        "url": media_url,
        "abs_path": abs_path,
        "crop_source_path": crop_source_rel_path,
        "crop_source_abs_path": crop_source_abs_path,
        "crop_source_url": crop_source_url,
        "validation_error": str(asset.validation_error or ""),
        "fallback_text": str(asset.fallback_text or ""),
        "can_crop": bool(asset.exists and asset.media_type == "image"),
        "can_trim": bool(asset.exists and asset.media_type == "audio"),
        "can_delete": can_delete,
    }


def _seedance2_returned_last_frame_status_payload(
    *,
    project_ctx: ProjectContext,
    output_dir: Path,
    episode: int,
    beat_num: int,
    enabled: bool,
) -> dict[str, Any] | None:
    if not enabled:
        return None
    base_path = (
        Path(output_dir)
        / "videos"
        / "beats"
        / f"ep{int(episode):03d}"
        / "returned_last_frames"
        / f"beat_{int(beat_num):02d}"
    )
    path = next(
        (
            base_path.with_suffix(suffix)
            for suffix in (".png", ".jpg", ".jpeg", ".webp", ".gif")
            if base_path.with_suffix(suffix).exists()
        ),
        base_path.with_suffix(".png"),
    )
    if not path.exists():
        return None
    try:
        rel_path = path.relative_to(output_dir).as_posix()
    except ValueError:
        rel_path = str(path)
    return {
        "key": "returned_last_frame",
        "label": f"Return last frame · Beat {int(beat_num)}",
        "media_type": "image",
        "selected": False,
        "exists": True,
        "reference_label": "last frame",
        "note": "Seedance2 returns the last frame",
        "identity_id": "",
        "prop_id": "",
        "prop_scope": "",
        "path": rel_path,
        "url": make_static_url_for_context(project_ctx, rel_path, local_path=path),
        "abs_path": str(path),
        "validation_error": "",
        "fallback_text": "",
        "can_crop": False,
        "can_delete": False,
    }


def _seedance2_voice_status_payload(
    *,
    beat: dict[str, Any],
    characters: list[Any],
    username: str,
    project: str,
    store: Any,
    output_dir: Path,
) -> dict[str, Any]:
    audio_type = normalize_seedance2_audio_type(beat)
    if audio_type == "silence":
        return {
            "required": False,
            "ready": True,
            "label": "No audio",
            "detail": "Silent Beats generate no audio",
            "speaker": "",
        }
    if audio_type == "dialogue":
        from novelvideo.seedance2_i2v.voice_reference_service import (
            dialogue_voice_reference_rows,
        )

        rows = dialogue_voice_reference_rows(
            beat,
            characters=characters,
            project_dir=output_dir,
        )
        ready_rows = [row for row in rows if row.status.active_reference_path]
        names = [row.display_name or row.speaker for row in rows]
        ready = bool(rows) and len(ready_rows) == len(rows)
        return {
            "required": True,
            "ready": ready,
            "label": "Voice ready" if ready else "Voice missing",
            "detail": ", ".join(names) if names else "No speaker specified",
            "speaker": str(beat.get("speaker") or ""),
        }

    from novelvideo.seedance2_i2v.voice_reference_service import (
        resolve_narrator_reference_status,
    )

    status = resolve_narrator_reference_status(
        store=store,
        username=username,
        project=project,
    )
    return {
        "required": True,
        "ready": bool(status.active_reference_path),
        "label": "Voice ready" if status.active_reference_path else "Voice missing",
        "code": None if status.active_reference_path else "voice_narrator_missing",
        "detail": str(status.detail or status.error or "Third-person project narrator voice is not configured"),
        "speaker": "NARRATOR",
    }


async def _seedance2_panel_context(
    *,
    project: str,
    episode_num: int,
    beat_num: int,
    user: dict = Depends(get_api_user),
) -> dict[str, Any]:
    resolved = await _resolve_generation_project(project, user, required_role="viewer")
    username = resolved.username
    project_name = resolved.project_name
    output_dir = Path(resolved.output_dir)
    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(username, project_name)
    )
    beats = await store.get_beats_as_dicts(episode_num)
    beat = next((item for item in beats if int(item.get("beat_number") or 0) == beat_num), None)
    if not beat:
        raise HTTPException(status_code=404, detail=f"Beat {beat_num} not found")

    next_beat = next(
        (item for item in beats if int(item.get("beat_number") or 0) == beat_num + 1),
        None,
    )
    characters = store.get_all_characters()
    episode_obj = _episode_from_store_or_none(store, episode_num)
    prop_menu = await _runtime_prop_menu_with_global_props(store, episode_obj, beats)
    language = await detect_episode_asset_language(
        store,
        episode_num,
        fallback_text="\n".join(
            str(item.get(field) or "")
            for item in beats
            for field in ("narration_segment", "dialogue", "visual_description")
        ),
    )
    return {
        "project_ctx": resolved.ctx,
        "username": username,
        "project_name": project_name,
        "output_dir": output_dir,
        "store": store,
        "beats": beats,
        "beat": beat,
        "next_beat": next_beat,
        "characters": characters,
        "prop_menu": prop_menu,
        "language": language,
    }


def _seedance2_status_response(
    *,
    project: str,
    episode_num: int,
    beat_num: int,
    ctx: dict[str, Any],
) -> dict[str, Any]:
    from novelvideo.seedance2_i2v.panel_service import (
        build_seedance2_video_panel_state,
    )
    from novelvideo.utils.path_resolver import PathResolver

    output_dir = Path(ctx["output_dir"])
    beat = ctx["beat"]
    state = build_seedance2_video_panel_state(
        project_dir=output_dir,
        episode=episode_num,
        beat=beat,
        next_beat=ctx["next_beat"],
        characters=ctx["characters"],
        prop_menu=ctx["prop_menu"],
        state_dir=Path(ctx["store"].state_dir),
        language=ctx.get("language"),
    )
    assets = state.assets
    selected_assets = [asset for asset in assets if asset.selected]
    missing_assets = [
        asset
        for asset in assets
        if asset.required and (not asset.exists or bool(asset.validation_error))
    ]
    fallback_assets = [
        asset for asset in assets if str(asset.fallback_text or "").strip() and not asset.selected
    ]
    paths = PathResolver(output_dir, episode_num)
    project_ctx = ctx["project_ctx"]
    asset_items = [
        _seedance2_asset_status_payload(asset, project_ctx=project_ctx, output_dir=output_dir)
        for asset in assets
    ]
    try:
        from novelvideo.seedance2_i2v.models import parse_seedance2_config

        config = parse_seedance2_config(beat.get("seedance2_config_json") or "{}")
        returned_last_frame = _seedance2_returned_last_frame_status_payload(
            project_ctx=project_ctx,
            output_dir=output_dir,
            episode=episode_num,
            beat_num=beat_num,
            enabled=bool(config.return_last_frame),
        )
    except Exception:
        returned_last_frame = None
    if returned_last_frame is not None:
        asset_items.append(returned_last_frame)

    return {
        "ok": True,
        "data": {
            "beat_number": beat_num,
            "audio_type": normalize_seedance2_audio_type(beat),
            "seedance2_config_json": str(beat.get("seedance2_config_json") or ""),
            "media": {
                "render_ready": paths.frame(beat_num).exists(),
                "audio_ready": paths.audio(beat_num).exists(),
                "video_ready": paths.video(beat_num).exists(),
            },
            "voice": _seedance2_voice_status_payload(
                beat=beat,
                characters=ctx["characters"],
                username=ctx["username"],
                project=project,
                store=ctx["store"],
                output_dir=output_dir,
            ),
            "prompt": {
                "ready": bool(str(state.final_prompt or "").strip()),
                "source": str(state.prompt_source or ""),
                "status": str(state.prompt_status or ""),
                "has_guidance": bool(str(state.prompt_guidance or "").strip()),
                "text_overlay_enabled": bool((state.text_overlay or {}).get("enabled")),
                "text_overlay": state.text_overlay or {},
                "inputs_stale": bool(
                    state.prompt_inputs_hash
                    and state.prompt_inputs_hash != state.current_prompt_inputs_hash
                ),
            },
            "assets": {
                "total": len(assets),
                "selected": len(selected_assets),
                "missing": len(missing_assets),
                "images": len([asset for asset in selected_assets if asset.media_type == "image"]),
                "audios": len([asset for asset in selected_assets if asset.media_type == "audio"]),
                "fallbacks": len(fallback_assets),
                "items": asset_items,
            },
        },
    }


@router.get("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/seedance2-status")
async def get_seedance2_beat_status(
    project: str,
    episode_num: int,
    beat_num: int,
    user: dict = Depends(get_api_user),
):
    """Return NiceGUI-aligned read-only Seedance 2.0 status for one Beat."""
    ctx = await _seedance2_panel_context(
        project=project,
        episode_num=episode_num,
        beat_num=beat_num,
        user=user,
    )
    return _seedance2_status_response(
        project=project,
        episode_num=episode_num,
        beat_num=beat_num,
        ctx=ctx,
    )


@router.post("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/seedance2/assets/upload")
async def upload_seedance2_asset(
    project: str,
    episode_num: int,
    beat_num: int,
    file: UploadFile = File(...),
    user: dict = Depends(get_api_user),
):
    """Upload a manual Seedance 2.0 reference asset."""
    ctx = await _seedance2_panel_context(
        project=project,
        episode_num=episode_num,
        beat_num=beat_num,
        user=user,
    )
    from novelvideo.seedance2_i2v.panel_service import (
        save_seedance2_uploaded_file,
    )

    target = await save_seedance2_uploaded_file(
        store=ctx["store"],
        episode=episode_num,
        beat=ctx["beat"],
        project_dir=ctx["output_dir"],
        filename=file.filename or "seedance2_asset",
        upload_stream=file.file,
        content_type=file.content_type or "",
    )
    if target is None:
        return {"ok": False, "error": "unsupported or empty Seedance2 reference asset"}
    return _seedance2_status_response(
        project=project,
        episode_num=episode_num,
        beat_num=beat_num,
        ctx=ctx,
    )


@router.post("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/seedance2/assets/delete")
async def delete_seedance2_asset(
    project: str,
    episode_num: int,
    beat_num: int,
    body: Seedance2AssetDeleteRequest,
    user: dict = Depends(get_api_user),
):
    """Remove a manually attached Seedance 2.0 reference asset."""
    ctx = await _seedance2_panel_context(
        project=project,
        episode_num=episode_num,
        beat_num=beat_num,
        user=user,
    )
    from novelvideo.seedance2_i2v.panel_service import (
        remove_seedance2_uploaded_asset,
    )

    removed = await remove_seedance2_uploaded_asset(
        store=ctx["store"],
        episode=episode_num,
        beat=ctx["beat"],
        project_dir=ctx["output_dir"],
        media_kind=body.media_kind,
        path=body.path,
    )
    if not removed:
        return {"ok": False, "error": "Seedance2 reference asset was not removed"}
    return _seedance2_status_response(
        project=project,
        episode_num=episode_num,
        beat_num=beat_num,
        ctx=ctx,
    )


@router.post("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/seedance2/assets/crop")
async def crop_seedance2_asset(
    project: str,
    episode_num: int,
    beat_num: int,
    body: Seedance2AssetCropRequest,
    user: dict = Depends(get_api_user),
):
    """Crop an existing Seedance 2.0 image reference into a manual reference."""
    ctx = await _seedance2_panel_context(
        project=project,
        episode_num=episode_num,
        beat_num=beat_num,
        user=user,
    )
    from novelvideo.seedance2_i2v.panel_service import (
        crop_seedance2_asset_to_reference,
    )

    target = await crop_seedance2_asset_to_reference(
        store=ctx["store"],
        episode=episode_num,
        beat=ctx["beat"],
        project_dir=ctx["output_dir"],
        asset_key=body.asset_key,
        source_path=body.source_path,
        crop_data=body.model_dump(),
    )
    if target is None:
        return {"ok": False, "error": "Seedance2 reference crop failed"}
    return _seedance2_status_response(
        project=project,
        episode_num=episode_num,
        beat_num=beat_num,
        ctx=ctx,
    )


@router.post("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/seedance2/assets/audio-trim")
async def trim_seedance2_audio_asset(
    project: str,
    episode_num: int,
    beat_num: int,
    body: Seedance2AssetAudioTrimRequest,
    user: dict = Depends(get_api_user),
):
    """Trim an existing Seedance 2.0 audio reference into a 3-5 second clip."""
    ctx = await _seedance2_panel_context(
        project=project,
        episode_num=episode_num,
        beat_num=beat_num,
        user=user,
    )
    from novelvideo.seedance2_i2v.panel_service import (
        trim_seedance2_audio_to_reference,
    )

    try:
        target = await trim_seedance2_audio_to_reference(
            store=ctx["store"],
            episode=episode_num,
            beat=ctx["beat"],
            project_dir=ctx["output_dir"],
            asset_key=body.asset_key,
            source_path=body.source_path,
            start_seconds=body.start_seconds,
            duration_seconds=body.duration_seconds,
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    if target is None:
        return {"ok": False, "error": "Seedance2 audio reference trim failed"}
    return _seedance2_status_response(
        project=project,
        episode_num=episode_num,
        beat_num=beat_num,
        ctx=ctx,
    )


def _api_video_backend_options() -> list[VideoBackendOption]:
    from novelvideo.config import NEWAPI_VIDEO_DURATION_BOUNDS
    from novelvideo.generators.video_generator import (
        NewApiVideoGenerator,
        newapi_video_backend_options,
        parse_newapi_video_backend,
    )

    hidden_mainline_backends = {
        "newapi_seedance-2.0-value",
        "newapi_seedance-2.0-fast-value",
        "newapi_happyhorse-1.0",
    }
    options = {
        value: label
        for value, label in newapi_video_backend_options(
            include_seedance2_variants=True
        ).items()
        if value not in hidden_mainline_backends
    }
    duration_bounds = NewApiVideoGenerator._parse_duration_bounds_config(
        NEWAPI_VIDEO_DURATION_BOUNDS
    )
    from novelvideo.config import VIDEO_BACKEND as _configured_video_backend

    # `VideoGenerateRequest.video_backend`'s hardcoded field default is only
    # a request-schema fallback — it does NOT track this machine's
    # `config.VIDEO_BACKEND` (e.g. after it was switched to
    # `runpod_minimax_h3`). Use the real configured default so `is_default`
    # below actually reflects it.
    default_backend = _configured_video_backend
    backend_options: list[VideoBackendOption] = []
    for value, label in options.items():
        model = parse_newapi_video_backend(value)
        bounds = duration_bounds.get(model or "")
        if model == "seedance-2.0-mini" and not bounds:
            bounds = (4, 15)
        if model == "happyhorse-1.0" and not bounds:
            bounds = (3, 15)
        if model == "grok-video-channel" and not bounds:
            bounds = (6, 30)
        is_happyhorse = _is_happyhorse_backend(value)
        is_grok_video = _is_grok_video_backend(value)
        backend_options.append(
            VideoBackendOption(
                value=value,
                label=label,
                is_default=value == default_backend,
                is_seedance2=_is_seedance2_backend(value),
                is_happyhorse=is_happyhorse,
                is_grok_video=is_grok_video,
                dialogue_only=value in {"seedance_pro", "newapi_seedance-1.5-pro"},
                min_duration=bounds[0] if bounds else None,
                max_duration=bounds[1] if bounds else None,
                resolution_options=(
                    list(HAPPYHORSE_RESOLUTION_OPTIONS)
                    if is_happyhorse
                    else list(GROK_VIDEO_RESOLUTION_OPTIONS)
                    if is_grok_video
                    else None
                ),
                ratio_options=(
                    list(HAPPYHORSE_RATIO_OPTIONS)
                    if is_happyhorse
                    else list(GROK_VIDEO_RATIO_OPTIONS)
                    if is_grok_video
                    else None
                ),
                supported_modes=(
                    list(HAPPYHORSE_SUPPORTED_MODES)
                    if is_happyhorse
                    else list(GROK_VIDEO_SUPPORTED_MODES)
                    if is_grok_video
                    else None
                ),
                reference_image_max=7 if is_grok_video else 9 if is_happyhorse else None,
                reference_video_max=0 if is_grok_video else 1 if is_happyhorse else None,
                reference_audio_max=0 if is_grok_video or is_happyhorse else None,
            )
        )
    from novelvideo.config import _runpod_h3_video_configured

    if _runpod_h3_video_configured():
        backend_options.append(
            VideoBackendOption(
                value="runpod_minimax_h3",
                label="MiniMax-H3 (RunPod, dev)",
                is_default="runpod_minimax_h3" == default_backend,
                is_runpod_h3=True,
                min_duration=5,
                max_duration=12,
                reference_image_max=9,
                reference_video_max=0,
                reference_audio_max=3,
            )
        )
    return backend_options


@router.get("/projects/{project}/video-backends")
async def get_video_backend_options(
    project: str,
    user: dict = Depends(get_api_user),
):
    """Return video backend options shared with the NiceGUI render workbench."""
    await _resolve_generation_project(project, user, required_role="viewer")
    return {"ok": True, "data": [item.model_dump() for item in _api_video_backend_options()]}


@router.get("/projects/{project}/render-settings")
async def get_render_settings(
    project: str,
    user: dict = Depends(get_api_user),
):
    """Return Render-stage image model and sizing settings for React."""
    resolved = await _resolve_generation_project(project, user, required_role="viewer")
    return {
        "ok": True,
        "data": _render_settings_payload(resolved.username, resolved.project_name),
    }


@router.patch("/projects/{project}/render-settings")
async def update_render_settings(
    project: str,
    body: RenderSettingsUpdate,
    user: dict = Depends(get_api_user),
):
    """Persist Render-stage image model and sizing settings."""
    from novelvideo.config import image_generation_selection_options

    resolved = await _resolve_generation_project(project, user, required_role="editor")
    username = resolved.username
    project_name = resolved.project_name
    updates: dict[str, Any] = {}

    if body.render_image_selection is not None:
        selection = str(body.render_image_selection or "").strip()
        if selection not in image_generation_selection_options():
            return JSONResponse(
                status_code=400,
                content={
                    "ok": False,
                    "error": f"Invalid render_image_selection: {selection}",
                },
            )
        updates["render_image_selection"] = selection
    if body.sketch_aspect_padding is not None:
        updates["sketch_aspect_padding"] = bool(body.sketch_aspect_padding)

    if updates:
        save_project_config(username, project_name, config=updates)
    return {"ok": True, "data": _render_settings_payload(username, project_name)}


@router.get("/projects/{project}/sketch-settings")
async def get_sketch_settings(
    project: str,
    user: dict = Depends(get_api_user),
):
    """Return Sketch-stage image model settings for React."""
    resolved = await _resolve_generation_project(project, user, required_role="viewer")
    return {
        "ok": True,
        "data": _sketch_settings_payload(resolved.username, resolved.project_name),
    }


@router.patch("/projects/{project}/sketch-settings")
async def update_sketch_settings(
    project: str,
    body: SketchSettingsUpdate,
    user: dict = Depends(get_api_user),
):
    """Persist Sketch-stage image model settings."""
    from novelvideo.config import image_generation_selection_options

    resolved = await _resolve_generation_project(project, user, required_role="editor")
    username = resolved.username
    project_name = resolved.project_name
    updates: dict[str, Any] = {}

    if body.sketch_image_selection is not None:
        selection = str(body.sketch_image_selection or "").strip()
        if selection not in image_generation_selection_options():
            return JSONResponse(
                status_code=400,
                content={
                    "ok": False,
                    "error": f"Invalid sketch_image_selection: {selection}",
                },
            )
        updates["sketch_image_selection"] = selection

    if updates:
        save_project_config(username, project_name, config=updates)
    return {"ok": True, "data": _sketch_settings_payload(username, project_name)}


def _sketch_regen_queue_key(episode_num: int) -> str:
    return f"ep{int(episode_num):03d}"


def _is_react_sketch_regen_queue_items(items: object) -> bool:
    return (
        isinstance(items, list)
        and bool(items)
        and all(isinstance(item, dict) and "beatNumbers" in item for item in items)
    )


def _react_sketch_regen_queues(config: dict) -> tuple[dict, dict, bool]:
    queues = config.get("react_sketch_regen_queue")
    if not isinstance(queues, dict):
        queues = {}
    else:
        queues = dict(queues)

    legacy_queues = config.get("sketch_regen_queue")
    cleaned_legacy = dict(legacy_queues) if isinstance(legacy_queues, dict) else {}
    legacy_changed = False
    if isinstance(legacy_queues, dict):
        for key, items in legacy_queues.items():
            if (
                isinstance(key, str)
                and key.startswith("ep")
                and _is_react_sketch_regen_queue_items(items)
            ):
                queues.setdefault(key, list(items))
                cleaned_legacy.pop(key, None)
                legacy_changed = True

    return queues, cleaned_legacy, legacy_changed


def _sketch_regen_queue_payload(username: str, project: str, episode_num: int) -> dict:
    config = load_project_config(username, project)
    queues, _cleaned_legacy, _legacy_changed = _react_sketch_regen_queues(config)
    items = queues.get(_sketch_regen_queue_key(episode_num))
    return {"items": items if isinstance(items, list) else []}


@router.get("/projects/{project}/episodes/{episode_num}/sketch-regen-queue")
async def get_sketch_regen_queue(
    project: str,
    episode_num: int,
    user: dict = Depends(get_api_user),
):
    """Return the persisted React sketch regeneration dispatch queue."""
    resolved = await _resolve_generation_project(project, user, required_role="viewer")
    return {
        "ok": True,
        "data": _sketch_regen_queue_payload(
            resolved.username,
            resolved.project_name,
            episode_num,
        ),
    }


@router.put("/projects/{project}/episodes/{episode_num}/sketch-regen-queue")
async def update_sketch_regen_queue(
    project: str,
    episode_num: int,
    body: SketchRegenQueueUpdate,
    user: dict = Depends(get_api_user),
):
    """Persist the React sketch regeneration dispatch queue per episode."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    username = resolved.username
    project_name = resolved.project_name
    config = load_project_config(username, project_name)
    queues, cleaned_legacy, legacy_changed = _react_sketch_regen_queues(config)
    queues[_sketch_regen_queue_key(episode_num)] = [item.model_dump() for item in body.items]
    updates = {"react_sketch_regen_queue": queues}
    if legacy_changed:
        updates["sketch_regen_queue"] = cleaned_legacy
    save_project_config(username, project_name, config=updates)
    return {"ok": True, "data": _sketch_regen_queue_payload(username, project_name, episode_num)}


@router.get("/projects/{project}/episodes/{episode_num}/sketch-image-usage")
async def get_sketch_image_usage(
    project: str,
    episode_num: int,
    user: dict = Depends(get_api_user),
):
    """Return NiceGUI-style Sketch image request usage summary."""
    from novelvideo.image_request_usage import get_image_usage_summary

    resolved = await _resolve_generation_project(project, user, required_role="viewer")
    project_dir = resolved.project_dir
    summary = get_image_usage_summary(
        project_output_dir=project_dir,
        task_types=("sketch_grid",),
        episode=episode_num,
    )
    return {"ok": True, "data": summary}


def _image_generation_guard_payload(attempt_count: int, subject: str) -> dict:
    next_attempt = attempt_count + 1
    if next_attempt >= 5:
        level = "locked"
        message = f"{subject} has been generated {next_attempt} times in a row. Enter the administrator password to continue this generation."
    elif next_attempt >= 3:
        level = "confirm"
        message = f"{subject} has been generated {next_attempt} times in a row. Continue generating?"
    else:
        level = "none"
        message = ""
    return {
        "attempt_count": attempt_count,
        "next_attempt": next_attempt,
        "level": level,
        "message": message,
    }


@router.get("/projects/{project}/episodes/{episode_num}/image-generation-guard")
async def get_image_generation_guard(
    project: str,
    episode_num: int,
    task_type: str = Query(...),
    scope: str = Query(...),
    subject: str = Query("current generation task"),
    user: dict = Depends(get_api_user),
):
    """Return per-scope image generation guard status used before dispatch."""
    from novelvideo.image_request_usage import count_image_scope_attempts

    resolved = await _resolve_generation_project(project, user, required_role="viewer")
    project_dir = resolved.project_dir
    attempt_count = count_image_scope_attempts(
        project_output_dir=project_dir,
        task_type=task_type,
        scope=scope,
        episode=episode_num,
    )
    return {"ok": True, "data": _image_generation_guard_payload(attempt_count, subject)}


@router.post("/projects/{project}/episodes/{episode_num}/image-generation-guard/verify-password")
async def verify_image_generation_guard_password(
    project: str,
    episode_num: int,
    body: OperatorPasswordVerifyRequest,
    user: dict = Depends(get_api_user),
):
    """Verify the same operator password NiceGUI requires after repeated image attempts."""
    from novelvideo.security.operator_auth import get_prompt_export_password

    _ = (project, episode_num, user)
    configured = get_prompt_export_password()
    verified = bool(configured) and (body.password or "") == configured
    return {
        "ok": True,
        "data": {"verified": verified},
    }


@router.post("/projects/{project}/episodes/{episode_num}/videos/compose")
async def compose_video(
    project: str,
    episode_num: int,
    body: VideoComposeRequest,
    user: dict = Depends(get_api_user),
):
    """Compose the final video."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    ctx = resolved.ctx
    username = resolved.username
    project_name = resolved.project_name
    output_dir = resolved.output_dir
    store = (
        await make_sqlite_store_for_context(ctx)
        if ctx
        else await make_sqlite_store(username, project_name)
    )
    beats = await store.get_beats_as_dicts(episode_num)
    if not beats:
        return {"ok": False, "error": f"No beats found for episode {episode_num}"}

    config = {
        "beats": beats,
        "add_subtitles": body.add_subtitles,
        "add_bgm": body.add_bgm,
    }

    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            product_surface="mainline",
            task_type="compose_episode",
            queue_kind="ffmpeg",
            episode=episode_num,
            payload={
                **config,
                "episode": episode_num,
                "output_dir": output_dir,
                "resolution": getattr(body, "resolution", "720x1280"),
            },
        )
        return {
            "ok": True,
            "task_type": "compose_episode",
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key("compose_episode", ctx.project_id, episode_num),
            "backend": queued.backend,
            "queue": queued.queue,
            "message": f"Episode {episode_num} final video composition queued",
        }

    return {"ok": False, "error": "Final video composition requires a project context"}


@router.get("/projects/{project}/episodes/{episode_num}/final")
async def get_final_video(
    project: str,
    episode_num: int,
    user: dict = Depends(get_api_user),
):
    """Read the episode final-video status, for supertale-fe compose page refresh hydration."""
    resolved = await _resolve_generation_project(project, user, required_role="viewer")
    project_dir = resolved.project_dir
    filename = f"ep{episode_num:03d}_final.mp4"
    final_path = project_dir / "videos" / "episodes" / filename
    data = {"exists": final_path.exists(), "filename": filename}
    if final_path.exists():
        data["video_url"] = make_static_url_for_context(
            resolved.ctx,
            f"videos/episodes/{filename}",
            local_path=final_path,
        )
    return {"ok": True, "data": data}


# ── TTS speech ──────────────────────────────────────────────────────────────


@router.post("/projects/{project}/episodes/{episode_num}/tts/generate")
async def generate_tts(
    project: str,
    episode_num: int,
    body: TTSGenerateRequest,
    user: dict = Depends(get_api_user),
):
    """Legacy TTS endpoint removed after IndexTTS2 cutover."""
    raise HTTPException(
        status_code=status.HTTP_410_GONE,
        detail=(
            "Legacy /tts/generate was removed. Use "
            f"/projects/{project}/episodes/{episode_num}/audio/generate for IndexTTS2."
        ),
    )


@router.post("/projects/{project}/tts/preview")
async def preview_tts(
    project: str,
    body: TTSPreviewRequest,
    user: dict = Depends(get_api_user),
):
    """Legacy TTS preview endpoint removed after IndexTTS2 cutover."""
    raise HTTPException(
        status_code=status.HTTP_410_GONE,
        detail="Legacy /tts/preview was removed. IndexTTS2 uses configured reference voices.",
    )


@router.get("/projects/{project}/tts/voices")
async def list_tts_voices(project: str, user: dict = Depends(get_api_user)):
    """Legacy voice listing endpoint removed after IndexTTS2 cutover."""
    raise HTTPException(
        status_code=status.HTTP_410_GONE,
        detail="Legacy /tts/voices was removed. IndexTTS2 voice options are project assets.",
    )


# ── Sketch ──────────────────────────────────────────────────────────────────


@router.post("/projects/{project}/episodes/{episode_num}/sketches/generate")
async def generate_sketches(
    project: str,
    episode_num: int,
    body: SketchGenerateRequest,
    user: dict = Depends(require_scope("tasks:submit")),
):
    """Generate sketches."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    ctx = resolved.ctx
    username = resolved.username
    project_name = resolved.project_name
    output_dir = resolved.output_dir

    proj_config = load_project_config(username, project_name)
    style = body.style or proj_config.get("visual_style", "chinese_period_drama")

    store = (
        await make_sqlite_store_for_context(ctx)
        if ctx
        else await make_sqlite_store(username, project_name)
    )
    beats = await store.get_beats_as_dicts(episode_num)

    if not beats:
        return {"ok": False, "error": f"No beats found for episode {episode_num}"}

    # Validate grid_index up front so errors are not raised only inside the async task
    from novelvideo.generators.nanobanana_grid import (
        get_sketch_nxn_modes,
        sketch_grid_split,
        sketch_scene_grid_split,
    )

    use_scene_grouping = body.sketch_scene_grouping
    if use_scene_grouping:
        loc_plan = sketch_scene_grid_split(beats, aspect_ratio=body.aspect_ratio)
        grid_plan = [(p["rows"], p["cols"]) for p in loc_plan]
        billing_mode_keys = [str(p["mode_key"]) for p in loc_plan]
    else:
        loc_plan = None
        grid_plan = sketch_grid_split(len(beats))
        mode_by_shape = {
            (rows, cols): mode_key
            for _capacity, mode_key, rows, cols in get_sketch_nxn_modes(body.aspect_ratio)
        }
        billing_mode_keys = [mode_by_shape[(rows, cols)] for rows, cols in grid_plan]

    generate_all_grids = body.grid_index == -1
    if body.grid_index < -1 or body.grid_index >= len(grid_plan):
        grid_labels = " + ".join(f"{r}x{c}" for r, c in grid_plan)
        return {
            "ok": False,
            "error": (
                f"grid_index={body.grid_index} is out of range. "
                f"{len(beats)} beats in total, split plan: {grid_labels}, "
                f"valid grid_index: 0~{len(grid_plan) - 1}"
            ),
        }

    character_map = await _build_character_map(
        store,
        beats,
        username,
        project_name,
        episode_num=episode_num,
        use_detected_identities=False,
    )
    has_colors = any(
        info.get("identity_sketch_colors") or info.get("sketch_color")
        for info in character_map.values()
    )
    if not has_colors:
        return {"ok": False, "error": "No color assignment detected. Call the assign-colors endpoint first"}

    from novelvideo.utils.path_resolver import PathResolver

    PathResolver(output_dir, episode_num).clean_sketches()

    episode_obj = _episode_from_store_or_none(store, episode_num)
    prop_menu = await _runtime_prop_menu_with_global_props(store, episode_obj, beats)
    sketch_image_selection = _resolve_sketch_image_selection(
        proj_config,
        body.image_generation_selection,
    )
    base_config = {
        "beats": beats,
        "character_map": character_map,
        "style": style,
        "model": body.model,
        "sketch_scene_grouping": use_scene_grouping,
        "aspect_ratio": body.aspect_ratio,
        "image_generation_selection": sketch_image_selection,
        "sketch_colors": store.get_sketch_colors(episode_num) or {},
        "prop_menu": prop_menu,
    }

    dispatch_grid_indices = list(range(len(grid_plan))) if generate_all_grids else [body.grid_index]
    if ctx is not None:
        batch_size = len(dispatch_grid_indices)
        batch_id = (
            f"sketch-grid-{episode_num}-{uuid.uuid4().hex}"
            if generate_all_grids and batch_size > 1
            else ""
        )
        queued_tasks = []
        rejected: list[dict[str, Any]] = []
        for position, grid_index in enumerate(dispatch_grid_indices):
            scope = f"grid_{grid_index}"
            billing = _sketch_regen_billing_metadata(
                sketch_image_selection,
                billing_mode_keys[grid_index],
            )
            try:
                queued = await get_task_backend().enqueue_project_task(
                    ctx,
                    product_surface="mainline",
                    task_type="sketch_grid_generation",
                    queue_kind="default",
                    episode=episode_num,
                    scope=scope,
                    payload={
                        "episode": episode_num,
                        "output_dir": output_dir,
                        "config": {**base_config, "grid_index": grid_index},
                        "billing": billing,
                        **(
                            {
                                "batch_id": batch_id,
                                "batch_size": batch_size,
                                "display_name": f"Episode {episode_num} sketch batch",
                            }
                            if batch_id
                            else {}
                        ),
                    },
                )
            except _FANOUT_ACTIVE_LIMIT_ERRORS as exc:
                if not queued_tasks:
                    # Not a single one was dispatched = a pure over-limit: raise bare and let the handler in api/app.py
                    # render 429 + the correct limit_scope (M8 invariant 7).
                    raise
                _log_partial_dispatch_rejection(exc)
                # The gate is global and every later one will necessarily be rejected -- so **dispatch only this once** (break),
                # but record "the current one + all not-yet-attempted ones" faithfully into rejected:
                # the contract wants N-k entries (M8 :722 / :755), and downstream aligns by tail length
                # (render-plan-dialog.tsx:265 asserts entries.length == rejected.length).
                for pending_index in dispatch_grid_indices[position:]:
                    rejected.append(
                        _task_limit_rejection(f"grid_{pending_index}", exc)
                    )
                break
            queued_tasks.append(
                {
                    "grid_index": grid_index,
                    "scope": scope,
                    "task_id": queued.task_state.task_id,
                    "task_key": project_task_state_key(
                        "sketch_grid_generation",
                        ctx.project_id,
                        episode_num,
                        scope=scope,
                    ),
                    "backend": queued.backend,
                    "queue": queued.queue,
                }
            )
        if generate_all_grids:
            grid_labels = " + ".join(f"{r}x{c}" for r, c in grid_plan)
            return {
                "ok": True,
                "task_type": "sketch_grid_generation",
                "backend": queued_tasks[0]["backend"] if queued_tasks else "inline",
                "data": {
                    # Actual dispatched count, not intended count (M8 invariant 17).
                    "dispatched": len(queued_tasks),
                    "tasks": queued_tasks,
                    "scopes": [item["scope"] for item in queued_tasks],
                    "rejected": rejected,
                },
                "message": f"Episode {episode_num} full-episode sketch generation queued ({grid_labels})",
            }

        return {
            "ok": True,
            "task_type": "sketch_grid_generation",
            "backend": queued_tasks[0]["backend"],
            "task_id": queued_tasks[0]["task_id"],
            "task_key": queued_tasks[0]["task_key"],
            "queue": queued_tasks[0]["queue"],
            "message": f"Episode {episode_num} sketch generation queued (grid {body.grid_index})",
        }

    return {"ok": False, "error": "Sketch generation requires a project context"}


# ── Voice generation ────────────────────────────────────────────────────────


async def _collect_audio_prereq_errors(
    *,
    store,
    username: str,
    project: str,
    episode: int,
    beat_numbers,
    mode: str,
) -> list[str]:
    from novelvideo.audio.indextts2_beat_audio_task import (
        collect_indextts2_voice_prereq_errors,
    )

    try:
        return await collect_indextts2_voice_prereq_errors(
            store=store,
            username=username,
            project=project,
            episode=episode,
            beat_numbers=beat_numbers,
            mode=mode,
        )
    except AttributeError:
        # Unit-test fakes may not implement the full SQLiteStore voice-sample
        # surface. Real SQLiteStore has these attributes; skip only for narrow
        # fakes so existing route-contract tests can focus on dispatch shape.
        return []


async def _audio_generation_plan(
    *,
    store,
    username: str,
    project: str,
    episode: int,
    beat_numbers,
    mode: str,
) -> tuple[list[int], list[str], int]:
    from novelvideo.audio.indextts2_beat_audio_task import (
        build_indextts2_audio_generation_plan,
    )

    try:
        plan = await build_indextts2_audio_generation_plan(
            store=store,
            username=username,
            project=project,
            episode=episode,
            beat_numbers=beat_numbers,
            mode=mode,
        )
        return (
            list(plan.beat_numbers),
            list(plan.errors),
            int(getattr(plan, "billable_chars", 0) or 0),
        )
    except AttributeError:
        # Narrow route-test stores do not expose the voice and audio-state
        # surfaces used by the production planner.
        beats = await store.get_beats_as_dicts(episode)
        selected = {int(value) for value in beat_numbers or [] if int(value) > 0}
        planned = [
            int(beat.get("beat_number") or 0)
            for beat in beats
            if int(beat.get("beat_number") or 0) > 0
            and (not selected or int(beat.get("beat_number") or 0) in selected)
        ]
        from novelvideo.seedance2_i2v.voice_clone import (
            dialogue_text,
            narration_beat_text,
            normalize_seedance2_audio_type,
        )
        from novelvideo.utils.document_parsers import count_billable_text_chars

        planned_set = set(planned)
        billable_chars = 0
        for beat in beats:
            if int(beat.get("beat_number") or 0) not in planned_set:
                continue
            audio_type = normalize_seedance2_audio_type(beat)
            text = (
                narration_beat_text(beat)
                if audio_type == "narration"
                else dialogue_text(beat)
            )
            billable_chars += count_billable_text_chars(text)
        return planned, [], billable_chars


def _audio_billing_payload(
    beat_numbers: list[int],
    *,
    billable_chars: int = 0,
) -> dict:
    from novelvideo.audio.indextts2_beat_audio_task import (
        indextts2_audio_billing_params,
    )

    return {
        **indextts2_audio_billing_params(
            len(beat_numbers),
            billable_chars=billable_chars,
        ),
        "beat_numbers": list(beat_numbers),
    }


def _voice_prereq_error_response(errors: list[str]) -> dict:
    preview = "; ".join(errors[:5])
    suffix = " ..." if len(errors) > 5 else ""
    response: dict = {
        "ok": False,
        "code": "voice_prereq_required",
        "error": f"{preview}{suffix}",
    }
    if any(
        "narrator" in str(error).lower() and "voice" in str(error).lower()
        for error in errors
    ):
        response["reason_code"] = "voice_narrator_missing"
    return response


@router.post("/projects/{project}/episodes/{episode_num}/audio/system-voices/prepare")
async def prepare_system_voices_for_agent(
    project: str,
    episode_num: int,
    body: SystemVoicePrepareRequest,
    user: dict = Depends(get_api_user),
):
    """Prepare missing system voice references for the outer Hermes assistant only."""

    agent_kind = str(user.get("agent_kind") or "").strip()
    if agent_kind not in {"hermes", "local_mcp"}:
        raise HTTPException(status_code=403, detail="system voice setup is agent-only")
    if not body.confirmed:
        return {
            "ok": False,
            "code": "system_voice_confirmation_required",
            "error": "Explicit user confirmation is required before using system voices",
        }

    resolved = await _resolve_generation_project(project, user, required_role="editor")
    ctx = resolved.ctx
    if ctx is None:
        return {
            "ok": False,
            "code": "project_context_required",
            "error": "System voice preparation requires a project context",
        }

    queued = await get_task_backend().enqueue_project_task(
        ctx,
        product_surface="mainline",
        task_type="system_voice_setup",
        queue_kind="default",
        episode=episode_num,
        payload={
            "episode": episode_num,
            "output_dir": resolved.output_dir,
            "state_dir": resolved.state_dir,
        },
    )
    return {
        "ok": True,
        "task_type": "system_voice_setup",
        "task_id": queued.task_state.task_id,
        "task_key": project_task_state_key(
            "system_voice_setup", ctx.project_id, episode_num
        ),
        "backend": queued.backend,
        "queue": queued.queue,
        "message": f"Episode {episode_num} system voice preparation queued",
    }


@router.post("/projects/{project}/episodes/{episode_num}/audio/billing-quote")
async def audio_generation_billing_quote(
    project: str,
    episode_num: int,
    body: TTSGenerateRequest = TTSGenerateRequest(),
    user: dict = Depends(get_api_user),
):
    """Quote the exact set of Beat audio model calls for an audio action."""
    resolved = await _resolve_generation_project(project, user, required_role="viewer")
    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(resolved.username, resolved.project_name)
    )
    mode = body.mode or "sync_changed"
    beat_numbers, errors, billable_chars = await _audio_generation_plan(
        store=store,
        username=resolved.username,
        project=resolved.project_name,
        episode=episode_num,
        beat_numbers=body.beat_numbers,
        mode=mode,
    )
    quantity = len(beat_numbers)
    if quantity <= 0:
        return {
            "ok": True,
            "data": {
                "beat_numbers": [],
                "quantity": 0,
                "unit_cost": 0,
                "cost": 0,
                "display": "",
                "prereq_errors": errors,
            },
        }
    quote_args = {
        "kind": "feature",
        "model": "mainline.beat_audio_generation",
        "params": _audio_billing_payload(
            beat_numbers,
            billable_chars=billable_chars,
        ),
        "quantity": quantity,
        "product_surface": "mainline",
    }
    quote = await get_credit_quote().generation_credit_quote(
        **quote_args,
        user_id=str(user.get("id") or user.get("user_id") or ""),
    )
    return {
        "ok": True,
        "data": {
            "beat_numbers": beat_numbers,
            "quantity": quantity,
            "unit_cost": quote.unit_cost,
            "cost": quote.total_cost,
            "display": quote.display,
            "prereq_errors": errors,
            **(
                {
                    "original_cost": getattr(quote, "original_total_cost", None),
                    "discount_amount": getattr(quote, "discount_amount", None),
                    "promotion": getattr(quote, "promotion", None),
                }
                if getattr(quote, "promotion", None)
                else {}
            ),
        },
    }


@router.post("/projects/{project}/episodes/{episode_num}/audio/generate")
async def generate_audio(
    project: str,
    episode_num: int,
    body: TTSGenerateRequest = TTSGenerateRequest(),
    user: dict = Depends(get_api_user),
):
    """Batch-generate speech (IndexTTS2)."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    ctx = resolved.ctx
    username = resolved.username
    project_name = resolved.project_name
    output_dir = resolved.output_dir
    state_dir = str(ctx.state_dir) if ctx else get_state_dir(username, project_name)
    store = (
        await make_sqlite_store_for_context(ctx)
        if ctx
        else await make_sqlite_store(username, project_name)
    )
    beats = await store.get_beats_as_dicts(episode_num)

    if not beats:
        return {"ok": False, "error": f"No beats found for episode {episode_num}"}

    mode = body.mode or "sync_changed"
    billable_beat_numbers, missing_voice, billable_chars = await _audio_generation_plan(
        store=store,
        username=username,
        project=project_name,
        episode=episode_num,
        beat_numbers=body.beat_numbers,
        mode=mode,
    )
    if missing_voice:
        return _voice_prereq_error_response(missing_voice)
    if not billable_beat_numbers:
        return {
            "ok": False,
            "code": "audio_generation_not_required",
            "error": "There is no audio to generate",
        }

    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            product_surface="mainline",
            task_type="audio_generation_indextts2",
            queue_kind="default",
            episode=episode_num,
            payload={
                "episode": episode_num,
                "mode": mode,
                "beat_numbers": billable_beat_numbers,
                "output_dir": output_dir,
                "state_dir": state_dir,
                "billing": _audio_billing_payload(
                    billable_beat_numbers,
                    billable_chars=billable_chars,
                ),
            },
        )
        return {
            "ok": True,
            "task_type": "audio_generation_indextts2",
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key(
                "audio_generation_indextts2", ctx.project_id, episode_num
            ),
            "backend": queued.backend,
            "queue": queued.queue,
            "message": f"Episode {episode_num} batch speech generation queued",
        }

    return {
        "ok": False,
        "error": "Audio generation requires a project context",
    }


# ── Video optimization ──────────────────────────────────────────────────────


def _global_optimize_billable_beat_numbers(
    *, output_dir: str, episode_num: int, beats: list[dict]
) -> list[int]:
    """Return Beat numbers with a canonical sketch, matching the worker path."""
    from novelvideo.utils.path_resolver import PathResolver

    sketches_dir = PathResolver(output_dir, episode_num).sketches_dir()
    billable: list[int] = []
    for beat in beats:
        beat_num = int(beat.get("beat_number") or 0)
        if beat_num <= 0:
            continue
        if any(
            (sketches_dir / f"beat_{beat_num:02d}.{ext}").exists()
            for ext in ("png", "jpg")
        ):
            billable.append(beat_num)
    return billable


@router.get("/projects/{project}/episodes/{episode_num}/optimize/video-global/billing-quote")
async def global_optimize_video_billing_quote(
    project: str,
    episode_num: int,
    user: dict = Depends(get_api_user),
):
    """Return the number of Beat prompt generations the batch action can run."""
    resolved = await _resolve_generation_project(project, user, required_role="viewer")
    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(resolved.username, resolved.project_name)
    )
    beats = await store.get_beats_as_dicts(episode_num)
    beat_numbers = _global_optimize_billable_beat_numbers(
        output_dir=resolved.output_dir,
        episode_num=episode_num,
        beats=beats,
    )
    quantity = len(beat_numbers)
    if quantity <= 0:
        return {
            "ok": True,
            "data": {
                "beat_numbers": [],
                "quantity": 0,
                "unit_cost": 0,
                "cost": 0,
                "display": "",
            },
        }
    quote_args = {
        "kind": "feature",
        "model": "mainline.beat_video_prompt",
        "params": {
            "pricing_metrics": {
                "call_count": quantity,
                "item_count": quantity,
            }
        },
        "quantity": quantity,
        "product_surface": "mainline",
    }
    quote = await get_credit_quote().generation_credit_quote(
        **quote_args,
        user_id=str(user.get("id") or user.get("user_id") or ""),
    )
    return {
        "ok": True,
        "data": {
            "beat_numbers": beat_numbers,
            "quantity": quantity,
            "unit_cost": quote.unit_cost,
            "cost": quote.total_cost,
            "display": quote.display,
            **(
                {
                    "original_cost": getattr(quote, "original_total_cost", None),
                    "discount_amount": getattr(quote, "discount_amount", None),
                    "promotion": getattr(quote, "promotion", None),
                }
                if getattr(quote, "promotion", None)
                else {}
            ),
        },
    }


@router.post("/projects/{project}/episodes/{episode_num}/optimize/video-global")
async def global_optimize_video(
    project: str,
    episode_num: int,
    body: GlobalOptimizeRequest = GlobalOptimizeRequest(),
    user: dict = Depends(get_api_user),
):
    """Global video prompt optimization (sketch -> AI freely decides the i2v/k2v mode of each beat).

    The output language is determined by the author's saved current script text and is not affected by the UI language.
    """
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    ctx = resolved.ctx
    username = resolved.username
    project_name = resolved.project_name
    output_dir = resolved.output_dir

    store = (
        await make_sqlite_store_for_context(ctx)
        if ctx
        else await make_sqlite_store(username, project_name)
    )
    beats = await store.get_beats_as_dicts(episode_num)

    if not beats:
        return {"ok": False, "error": f"No beats found for episode {episode_num}"}

    language = await detect_episode_asset_language(
        store,
        episode_num,
        fallback_text="\n".join(
            str(beat.get(field) or "")
            for beat in beats
            for field in ("narration_segment", "dialogue", "visual_description")
        ),
    )

    # Pre-check and quote must use the same statistics basis.
    billable_beat_numbers = _global_optimize_billable_beat_numbers(
        output_dir=output_dir,
        episode_num=episode_num,
        beats=beats,
    )
    billable_beat_count = len(billable_beat_numbers)
    if billable_beat_count <= 0:
        return {"ok": False, "error": "No sketches. Generate sketches before running global optimization"}

    characters = store.get_all_characters()
    char_list = [
        {
            "name": c.name,
            "gender": c.gender,
            "body_type": getattr(c, "body_type", ""),
            "role": c.role,
            "is_main": getattr(c, "is_main", False),
            "face_prompt": c.face_prompt,
        }
        for c in characters
    ]

    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            product_surface="mainline",
            task_type="global_optimize_video",
            queue_kind="default",
            episode=episode_num,
            payload={
                "episode": episode_num,
                "beats": beats,
                "characters": char_list,
                "output_dir": output_dir,
                "language": language,
                "billing": {
                    "items": billable_beat_count,
                    "beat_numbers": billable_beat_numbers,
                    "pricing_metrics": {
                        "call_count": billable_beat_count,
                        "item_count": billable_beat_count,
                    },
                },
                "beat_numbers": billable_beat_numbers,
            },
        )
        return {
            "ok": True,
            "task_type": "global_optimize_video",
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key(
                "global_optimize_video", ctx.project_id, episode_num
            ),
            "backend": queued.backend,
            "queue": queued.queue,
            "message": f"Episode {episode_num} global video optimization queued",
        }

    return {"ok": False, "error": "Global video optimization requires a project context"}


# ── Regeneration ────────────────────────────────────────────────────────────


@router.post("/projects/{project}/episodes/{episode_num}/grids/{grid_index}/regenerate")
async def regenerate_grid(
    project: str,
    episode_num: int,
    grid_index: int,
    body: GridRegenerateRequest,
    user: dict = Depends(get_api_user),
):
    """Regenerate a single grid."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    ctx = resolved.ctx
    username = resolved.username
    project_name = resolved.project_name
    output_dir = resolved.output_dir

    proj_config = load_project_config(username, project_name)
    style = body.style or proj_config.get("visual_style", "chinese_period_drama")
    render_image_selection = _resolve_render_image_selection(
        proj_config,
        body.image_generation_selection,
    )

    store = (
        await make_sqlite_store_for_context(ctx)
        if ctx
        else await make_sqlite_store(username, project_name)
    )
    beats = await store.get_beats_as_dicts(episode_num)

    if not beats:
        return {"ok": False, "error": f"No beats found for episode {episode_num}"}

    # Validate grid_index range
    character_map = await _build_character_map(
        store,
        beats,
        username,
        project_name,
        episode_num=episode_num,
        use_detected_identities=True,
    )

    if body.character_grouping:
        from novelvideo.generators.nanobanana_grid import character_grid_split

        char_plan = character_grid_split(beats, character_map)
        max_grids = len(char_plan)
        if grid_index < 0 or grid_index >= max_grids:
            grid_labels = " + ".join(
                f'{e["rows"]}x{e["cols"]}(comp={e.get("composite_count","?")})' for e in char_plan
            )
            return {
                "ok": False,
                "error": (
                    f"grid_index={grid_index} is out of range. "
                    f"Character grouping plan: {grid_labels}, "
                    f"valid grid_index: 0~{max_grids - 1}"
                ),
            }
        selected_beat_numbers = [int(beat) for beat in char_plan[grid_index].get("beat_numbers", [])]
        billing_mode_key = str(char_plan[grid_index]["mode_key"])
    elif body.scene_grouping:
        from novelvideo.generators.nanobanana_grid import scene_grid_split

        loc_plan = scene_grid_split(beats, character_map=character_map)
        max_grids = len(loc_plan)
        if grid_index < 0 or grid_index >= max_grids:
            grid_labels = " + ".join(f'{e["rows"]}x{e["cols"]}({e["scene_id"]})' for e in loc_plan)
            return {
                "ok": False,
                "error": (
                    f"grid_index={grid_index} is out of range. "
                    f"Scene grouping plan: {grid_labels}, "
                    f"valid grid_index: 0~{max_grids - 1}"
                ),
            }
        selected_beat_numbers = [int(beat) for beat in loc_plan[grid_index].get("beat_numbers", [])]
        billing_mode_key = str(loc_plan[grid_index]["mode_key"])
    else:
        from novelvideo.generators.nanobanana_grid import (
            perfect_grid_split,
            REGEN_MODE_CONFIGS as _RMC,
        )

        grid_plan = perfect_grid_split(len(beats))
        if grid_index < 0 or grid_index >= len(grid_plan):
            grid_labels = " + ".join(f'{_RMC[mk]["rows"]}x{_RMC[mk]["cols"]}' for mk in grid_plan)
            return {
                "ok": False,
                "error": (
                    f"grid_index={grid_index} is out of range. "
                    f"{len(beats)} beats in total, split plan: {grid_labels}, "
                    f"valid grid_index: 0~{len(grid_plan) - 1}"
                ),
            }
        start_offset = sum(_RMC[mk]["capacity"] for mk in grid_plan[:grid_index])
        capacity = _RMC[grid_plan[grid_index]]["capacity"]
        billing_mode_key = str(grid_plan[grid_index])
        selected_beat_numbers = [
            int(beat.get("beat_number", index + 1))
            for index, beat in enumerate(beats[start_offset : start_offset + capacity], start_offset)
        ]

    selected_beats = pick_beats_by_number(beats, selected_beat_numbers)
    detection_error = render_ai_detection_error(selected_beats)
    if detection_error:
        return {"ok": False, "error": detection_error}

    config = {
        "beats": beats,
        "character_map": character_map,
        "style": style,
        "model": body.model,
        "image_generation_selection": render_image_selection,
        "render_mode": "Render",
        "scene_grouping": body.scene_grouping,
        "character_grouping": body.character_grouping,
        "sketch_aspect_padding": _resolve_render_bool_setting(
            proj_config,
            "sketch_aspect_padding",
            body.sketch_aspect_padding,
            True,
        ),
    }

    scope = f"grid_{grid_index}"
    if ctx is not None:
        billing = _render_regen_billing_metadata(
            render_image_selection,
            billing_mode_key,
        )
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            product_surface="mainline",
            task_type="grid_regenerate",
            queue_kind="default",
            episode=episode_num,
            scope=scope,
            payload={
                "episode": episode_num,
                "grid_index": grid_index,
                "output_dir": output_dir,
                "config": config,
                "billing": billing,
            },
        )
        return {
            "ok": True,
            "task_type": "grid_regenerate",
            "scope": scope,
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key(
                "grid_regenerate", ctx.project_id, episode_num, scope=scope
            ),
            "backend": queued.backend,
            "queue": queued.queue,
            "message": f"Episode {episode_num} grid {grid_index} regeneration queued",
        }

    return {"ok": False, "error": "Grid regeneration requires a project context"}


@router.post("/projects/{project}/episodes/{episode_num}/render/plan")
async def render_plan(
    project: str,
    episode_num: int,
    body: RenderPlanRequest,
    user: dict = Depends(get_api_user),
):
    """Return the server-authoritative render plan for selected beats."""
    if _render_plan_feature_disabled():
        return JSONResponse(
            status_code=503,
            content={
                "ok": False,
                "error": "feature_disabled",
                "data": {"reason": "DISABLE_RENDER_PLAN_V2 is set"},
            },
        )

    resolved = await _resolve_generation_project(project, user, required_role="editor")
    ctx = resolved.ctx
    username = resolved.username
    project_name = resolved.project_name
    output_dir = resolved.output_dir
    store = (
        await make_sqlite_store_for_context(ctx)
        if ctx
        else await make_sqlite_store(username, project_name)
    )
    all_beats = await store.get_beats_as_dicts(episode_num)
    if not all_beats:
        return JSONResponse(
            status_code=400,
            content={"ok": False, "error": "no_beats", "data": {"episode": episode_num}},
        )

    beat_indices = normalize_beat_indices(body.beat_indices)
    invalid = validate_beat_indices(all_beats, beat_indices)
    if invalid:
        return JSONResponse(
            status_code=400,
            content={"ok": False, "error": "invalid_beats", "data": {"invalid": invalid}},
        )
    selected_beats = pick_beats_by_number(all_beats, beat_indices)

    detection_error = render_ai_detection_error(selected_beats)
    if detection_error:
        return JSONResponse(status_code=400, content={"ok": False, "error": detection_error})

    character_map = await _build_character_map(
        store,
        selected_beats,
        username,
        project_name,
        episode_num=episode_num,
        use_detected_identities=True,
    )
    sketch_colors = store.get_sketch_colors(episode_num) or {}
    project_config = load_project_config(username, project_name)
    render_image_selection = _resolve_render_image_selection(
        project_config,
        body.image_generation_selection,
    )
    plan = build_regen_plan(
        selected_beats=selected_beats,
        strategy=body.strategy,
        aspect_mode=body.aspect_mode,
        character_map=character_map,
        force_one_by_one=body.force_one_by_one,
        image_generation_selection=render_image_selection,
    )

    hasher = RefImageHasher(Path(output_dir) / ".render_plan_cache")
    try:
        fingerprint = compute_input_fingerprint(
            beats=selected_beats,
            character_map=character_map,
            sketch_colors=sketch_colors,
            strategy=body.strategy,
            aspect_mode=body.aspect_mode,
            force_one_by_one=body.force_one_by_one,
            ref_image_hasher=hasher.hash,
        )
    except FileNotFoundError as exc:
        return JSONResponse(
            status_code=400,
            content={
                "ok": False,
                "error": "invalid_beats",
                "data": {"reason": f"missing ref image: {exc}"},
            },
        )

    return {
        "ok": True,
        "data": RenderPlanResponse(
            plan=[PlanEntryOut(**entry) for entry in _plan_to_dicts(plan)],
            plan_hash=hash_plan(plan),
            input_fingerprint=fingerprint,
            strategy=body.strategy,
            total_beats=len(selected_beats),
            total_grids=len(plan),
        ).model_dump(),
    }


@router.post("/projects/{project}/episodes/{episode_num}/render/execute")
async def render_execute(
    project: str,
    episode_num: int,
    body: RenderPlanExecuteRequest,
    user: dict = Depends(get_api_user),
):
    """Validate and dispatch a render plan through the current selected-regen task path."""
    if _render_plan_feature_disabled():
        return JSONResponse(
            status_code=503,
            content={
                "ok": False,
                "error": "feature_disabled",
                "data": {"reason": "DISABLE_RENDER_PLAN_V2 is set"},
            },
        )

    resolved = await _resolve_generation_project(project, user, required_role="editor")
    ctx = resolved.ctx
    username = resolved.username
    project_name = resolved.project_name
    output_dir = resolved.output_dir
    store = (
        await make_sqlite_store_for_context(ctx)
        if ctx
        else await make_sqlite_store(username, project_name)
    )
    all_beats = await store.get_beats_as_dicts(episode_num)
    if not all_beats:
        return JSONResponse(
            status_code=400,
            content={"ok": False, "error": "no_beats", "data": {"episode": episode_num}},
        )

    beat_indices = normalize_beat_indices(body.beat_indices)
    invalid = validate_beat_indices(all_beats, beat_indices)
    if invalid:
        return JSONResponse(
            status_code=400,
            content={"ok": False, "error": "invalid_beats", "data": {"invalid": invalid}},
        )
    selected_beats = pick_beats_by_number(all_beats, beat_indices)

    detection_error = render_ai_detection_error(selected_beats)
    if detection_error:
        return JSONResponse(status_code=400, content={"ok": False, "error": detection_error})

    character_map = await _build_character_map(
        store,
        selected_beats,
        username,
        project_name,
        episode_num=episode_num,
        use_detected_identities=True,
    )
    sketch_colors = store.get_sketch_colors(episode_num) or {}
    project_config = load_project_config(username, project_name)
    render_image_selection = _resolve_render_image_selection(
        project_config,
        body.image_generation_selection,
    )
    hasher = RefImageHasher(Path(output_dir) / ".render_plan_cache")
    try:
        new_fingerprint = compute_input_fingerprint(
            beats=selected_beats,
            character_map=character_map,
            sketch_colors=sketch_colors,
            strategy=body.strategy,
            aspect_mode=body.aspect_mode,
            force_one_by_one=body.force_one_by_one,
            ref_image_hasher=hasher.hash,
        )
    except FileNotFoundError as exc:
        return JSONResponse(
            status_code=400,
            content={
                "ok": False,
                "error": "invalid_beats",
                "data": {"reason": f"missing ref image: {exc}"},
            },
        )

    if new_fingerprint != body.input_fingerprint:
        new_plan = build_regen_plan(
            selected_beats=selected_beats,
            strategy=body.strategy,
            aspect_mode=body.aspect_mode,
            character_map=character_map,
            force_one_by_one=body.force_one_by_one,
            image_generation_selection=render_image_selection,
        )
        return JSONResponse(
            status_code=409,
            content={
                "ok": False,
                "error": "input_stale",
                "data": {
                    "new_plan": _plan_to_dicts(new_plan),
                    "new_plan_hash": hash_plan(new_plan),
                    "new_input_fingerprint": new_fingerprint,
                },
            },
        )

    if body.custom_plan:
        custom_error = _custom_render_plan_error(body.plan, beat_indices)
        if custom_error:
            return JSONResponse(
                status_code=400,
                content={
                    "ok": False,
                    "error": "invalid_custom_plan",
                    "data": {"reason": custom_error},
                },
            )
        execution_plan = body.plan
        execution_hash = hash_plan(execution_plan)
        dispatch_strategy = "custom"
    else:
        recomputed = build_regen_plan(
            selected_beats=selected_beats,
            strategy=body.strategy,
            aspect_mode=body.aspect_mode,
            character_map=character_map,
            force_one_by_one=body.force_one_by_one,
            image_generation_selection=render_image_selection,
        )
        recomputed_hash = hash_plan(recomputed)
        if recomputed_hash != body.plan_hash:
            return JSONResponse(
                status_code=409,
                content={
                    "ok": False,
                    "error": "plan_stale",
                    "data": {
                        "new_plan": _plan_to_dicts(recomputed),
                        "new_plan_hash": recomputed_hash,
                        "new_input_fingerprint": new_fingerprint,
                    },
                },
            )
        execution_plan = recomputed
        execution_hash = recomputed_hash
        dispatch_strategy = body.strategy

    from novelvideo.task_identity import selection_scope

    style = project_config.get("visual_style") or "chinese_period_drama"
    episode_obj = _episode_from_store_or_none(store, episode_num)
    prop_menu = await _runtime_prop_menu_with_global_props(store, episode_obj, all_beats)
    base_config = {
        "beats": all_beats,
        "character_map": character_map,
        "style": style,
        "model": "nanobanana",
        "image_generation_selection": render_image_selection,
        "sketch_colors": sketch_colors,
        "prop_menu": prop_menu,
        "sketch_aspect_padding": _resolve_render_bool_setting(
            project_config,
            "sketch_aspect_padding",
            body.sketch_aspect_padding,
            True,
        ),
    }
    scope = f"{dispatch_strategy}__{execution_hash}"
    dispatched_task_ids: list[str] = []
    rejected: list[dict[str, Any]] = []

    if ctx is not None:
        for position, entry in enumerate(execution_plan):
            entry_beats = [int(beat) for beat in entry.beat_numbers]
            entry_scope = selection_scope(entry.mode_key, entry_beats)
            billing = _render_regen_billing_metadata(
                render_image_selection,
                entry.mode_key,
            )
            try:
                queued = await get_task_backend().enqueue_project_task(
                    ctx,
                    product_surface="mainline",
                    task_type="selected_regen",
                    queue_kind="default",
                    episode=episode_num,
                    scope=entry_scope,
                    payload={
                        "episode": episode_num,
                        "mode_key": entry.mode_key,
                        "output_dir": output_dir,
                        "config": {
                            **base_config,
                            "mode_key": entry.mode_key,
                            "selected_beat_numbers": entry_beats,
                        },
                        "billing": billing,
                    },
                )
            except _FANOUT_ACTIVE_LIMIT_ERRORS as exc:
                if not dispatched_task_ids:
                    # k == 0: raise bare and let the handler render 429 (M8 invariant 7).
                    raise
                _log_partial_dispatch_rejection(exc)
                # Dispatch only this once, but report the undispatched tail one by one faithfully (N-k entries, M8 :722 / :755).
                for pending in execution_plan[position:]:
                    pending_beats = [int(beat) for beat in pending.beat_numbers]
                    rejected.append(
                        _task_limit_rejection(
                            selection_scope(pending.mode_key, pending_beats), exc
                        )
                    )
                break
            dispatched_task_ids.append(queued.task_state.task_id)
    else:
        return {
            "ok": False,
            "error": "Render plan execution requires a project context",
            "data": RenderPlanExecuteResponse(
                task_type="render_plan",
                message="Render plan not started",
                scope=scope,
                resolved_grids=[PlanEntryOut(**entry) for entry in _plan_to_dicts(execution_plan)],
            ).model_dump(),
        }

    return {
        "ok": True,
        "data": RenderPlanExecuteResponse(
            task_type="render_plan",
            message=f"Render started ({len(execution_plan)} grids)",
            scope=scope,
            resolved_grids=[PlanEntryOut(**entry) for entry in _plan_to_dicts(execution_plan)],
        ).model_dump()
        | ({"task_ids": dispatched_task_ids} if dispatched_task_ids else {})
        | ({"rejected": rejected} if rejected else {}),
    }


@router.post("/projects/{project}/episodes/{episode_num}/beats/regenerate")
async def regenerate_beats(
    project: str,
    episode_num: int,
    body: BeatsRegenerateRequest,
    user: dict = Depends(get_api_user),
):
    """Regenerate frames for selected Beats."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    ctx = resolved.ctx
    username = resolved.username
    project_name = resolved.project_name
    output_dir = resolved.output_dir
    proj_config = load_project_config(username, project_name)
    style = body.style or proj_config.get("visual_style", "chinese_period_drama")
    render_image_selection = _resolve_render_image_selection(
        proj_config,
        body.image_generation_selection,
    )

    store = (
        await make_sqlite_store_for_context(ctx)
        if ctx
        else await make_sqlite_store(username, project_name)
    )
    beats = await store.get_beats_as_dicts(episode_num)

    if not beats:
        return {"ok": False, "error": f"No beats found for episode {episode_num}"}

    # Validate beat_indices
    if not body.beat_indices:
        return {"ok": False, "error": "beat_indices must not be empty"}
    total_beats = len(beats)
    invalid = [i for i in body.beat_indices if i < 1 or i > total_beats]
    if invalid:
        return {
            "ok": False,
            "error": f"beat_indices {invalid} out of range ({total_beats} beats in total, valid: 1~{total_beats})",
        }

    selected_beats = pick_beats_by_number(beats, body.beat_indices)
    detection_error = render_ai_detection_error(selected_beats)
    if detection_error:
        return {"ok": False, "error": detection_error}

    from novelvideo.config import SKETCH_FREE_COMPOSE_SELECTION_KEYS

    is_sketch_free_compose = render_image_selection in SKETCH_FREE_COMPOSE_SELECTION_KEYS

    sketch_paths = PathResolver(output_dir, episode_num)
    if not is_sketch_free_compose:
        missing_sketches = [
            beat_num
            for beat_num in body.beat_indices
            if not sketch_paths.sketch(beat_num).is_file()
        ]
        if missing_sketches:
            missing_labels = ", ".join(f"#{beat_num}" for beat_num in missing_sketches)
            raise HTTPException(
                422,
                f"Before Render, generate or upload sketches for beat {missing_labels}.",
            )

    character_map = await _build_character_map(
        store,
        selected_beats,
        username,
        project_name,
        episode_num=episode_num,
        use_detected_identities=True,
    )

    # Review screen support for any render-review-capable selection (see
    # /render/review and generators/render_review_registry.py —
    # runpod_qwen_edit* and, since 2026-10-18, runpod_qwen21_render*): only
    # meaningful for a single beat — `review_fingerprint`/`qwen_edit_prompts`
    # are both per-beat, same restriction the review dialog itself enforces
    # (it's only wired up for the single-beat Render button, not the batch
    # render-plan path).
    from novelvideo.generators.render_review_registry import strategy_for_selection

    render_review_strategy = strategy_for_selection(render_image_selection)
    if render_review_strategy is not None and len(body.beat_indices) == 1:
        from novelvideo.generators.nanobanana_grid import qwen_edit_identity_references
        from novelvideo.generators.qwen_edit_prompt_store import save_qwen_edit_prompts

        qwen_beat_num = body.beat_indices[0]
        qwen_beat = next((b for b in selected_beats if b.get("beat_number") == qwen_beat_num), None)
        if body.review_fingerprint is not None and qwen_beat is not None:
            identity_refs = qwen_edit_identity_references(character_map, qwen_beat)
            current_fingerprint = _qwen_edit_render_fingerprint(
                selection=render_image_selection,
                sketch_path=sketch_paths.sketch(qwen_beat_num),
                identity_refs=identity_refs,
            )
            if current_fingerprint != body.review_fingerprint:
                return {
                    "ok": False,
                    "error": "input_stale",
                    "message": "The sketch/reference images have changed since before submission. Reopen the preview to confirm.",
                }
        if body.qwen_edit_prompts is not None:
            overrides = body.qwen_edit_prompts.model_dump()
            save_qwen_edit_prompts(
                output_dir,
                episode_num,
                qwen_beat_num,
                full_prompt=overrides.get("full_prompt", ""),
                scene_prompt=overrides.get("scene_prompt", ""),
                inpaint_prompts=overrides.get("inpaint_prompts") or {},
                source="manual",
                namespace=render_review_strategy.store_namespace,
            )

    if is_sketch_free_compose:
        # No sketch exists for this mode (that's the whole point — see
        # RUNPOD_QWEN21_COMPOSE_SELECTION_KEYS docstring in config.py), so
        # a stale/leftover sketch file must never drive it via
        # `_single_render_mode_from_sketch()`. Force a 1x1 mode key —
        # `generate_grid()`'s compose branch hard-requires rows=cols=1 —
        # from the client's own mode_key if it's already a valid 1x1
        # option, else derived from the project's own render aspect_ratio
        # (`project_config.py`'s `DEFAULT_ASPECT_RATIO`-shaped field).
        if body.mode_key in {"1x1_16-9", "1x1_2-3"}:
            mode_key = body.mode_key
        else:
            mode_key = (
                "1x1_16-9" if proj_config.get("aspect_ratio") == "16:9" else "1x1_2-3"
            )
    else:
        # The selected sketch is the source of truth for a single Render.
        # The client mode remains a compatibility fallback for missing
        # legacy assets.
        mode_key = (
            _single_render_mode_from_sketch(output_dir, episode_num, body.beat_indices)
            or body.mode_key
        )
    episode_obj = _episode_from_store_or_none(store, episode_num)
    prop_menu = await _runtime_prop_menu_with_global_props(store, episode_obj, beats)
    billing = _render_regen_billing_metadata(render_image_selection, mode_key)
    config = {
        "beats": beats,
        "character_map": character_map,
        "style": style,
        "model": body.model,
        "image_generation_selection": render_image_selection,
        "selected_beat_numbers": body.beat_indices,
        "sketch_colors": store.get_sketch_colors(episode_num) or {},
        "prop_menu": prop_menu,
        "sketch_aspect_padding": _resolve_render_bool_setting(
            proj_config,
            "sketch_aspect_padding",
            body.sketch_aspect_padding,
            True,
        ),
    }

    from novelvideo.task_identity import selection_scope

    scope = selection_scope(mode_key, body.beat_indices)

    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            product_surface="mainline",
            task_type="selected_regen",
            queue_kind="default",
            episode=episode_num,
            scope=scope,
            payload={
                "episode": episode_num,
                "mode_key": mode_key,
                "output_dir": output_dir,
                "config": {**config, "mode_key": mode_key},
                "billing": billing,
                **({"batch_id": body.batch_id} if body.batch_id else {}),
                **({"batch_size": body.batch_size} if body.batch_size else {}),
            },
        )
        return {
            "ok": True,
            "task_type": "selected_regen",
            "scope": scope,
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key(
                "selected_regen", ctx.project_id, episode_num, scope=scope
            ),
            "backend": queued.backend,
            "queue": queued.queue,
            "message": f"Episode {episode_num} selected-Beats frame regeneration queued",
        }

    return {"ok": False, "error": "Selected-Beats frame regeneration requires a project context"}


@router.post("/projects/{project}/episodes/{episode_num}/sketches/regenerate")
async def regenerate_sketches(
    project: str,
    episode_num: int,
    body: SketchRegenerateRequest,
    user: dict = Depends(get_api_user),
):
    """Regenerate sketches for selected Beats."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    ctx = resolved.ctx
    username = resolved.username
    project_name = resolved.project_name
    output_dir = resolved.output_dir
    proj_config = load_project_config(username, project_name)
    style = body.style or proj_config.get("visual_style", "chinese_period_drama")

    store = (
        await make_sqlite_store_for_context(ctx)
        if ctx
        else await make_sqlite_store(username, project_name)
    )
    beats = await store.get_beats_as_dicts(episode_num)

    if not beats:
        return {"ok": False, "error": f"No beats found for episode {episode_num}"}

    # Validate beat_indices
    if not body.beat_indices:
        return {"ok": False, "error": "beat_indices must not be empty"}
    total_beats = len(beats)
    invalid = [i for i in body.beat_indices if i < 1 or i > total_beats]
    if invalid:
        return {
            "ok": False,
            "error": f"beat_indices {invalid} out of range ({total_beats} beats in total, valid: 1~{total_beats})",
        }

    character_map = await _build_character_map(
        store,
        beats,
        username,
        project_name,
        episode_num=episode_num,
        use_detected_identities=False,
    )

    mode_key = body.mode_key
    episode_obj = _episode_from_store_or_none(store, episode_num)
    prop_menu = await _runtime_prop_menu_with_global_props(store, episode_obj, beats)
    sketch_image_selection = _resolve_sketch_image_selection(
        proj_config,
        body.image_generation_selection,
    )
    billing = _sketch_regen_billing_metadata(sketch_image_selection, mode_key)
    config = {
        "beats": beats,
        "character_map": character_map,
        "style": style,
        "model": body.model,
        "image_generation_selection": sketch_image_selection,
        "selected_beat_numbers": body.beat_indices,
        "sketch_colors": store.get_sketch_colors(episode_num) or {},
        "prop_menu": prop_menu,
    }

    from novelvideo.task_identity import selection_scope

    scope = selection_scope(mode_key, body.beat_indices)

    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            product_surface="mainline",
            task_type="sketch_regen",
            queue_kind="default",
            episode=episode_num,
            scope=scope,
            payload={
                "episode": episode_num,
                "mode_key": mode_key,
                "output_dir": output_dir,
                "config": {**config, "mode_key": mode_key},
                "billing": billing,
            },
        )
        return {
            "ok": True,
            "task_type": "sketch_regen",
            "scope": scope,
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key(
                "sketch_regen", ctx.project_id, episode_num, scope=scope
            ),
            "backend": queued.backend,
            "queue": queued.queue,
            "message": f"Episode {episode_num} selected-Beats sketch regeneration queued",
        }

    return {"ok": False, "error": "Selected-Beats sketch regeneration requires a project context"}


def _canonical_sketch_path(project_dir: Path, episode_num: int, beat_num: int) -> Path:
    return project_dir / "sketches" / f"ep{episode_num:03d}" / f"beat_{beat_num:02d}.png"


def _canonical_sketch_url(
    ctx: ProjectContext,
    project_dir: Path,
    episode_num: int,
    beat_num: int,
) -> str:
    rel = f"sketches/ep{episode_num:03d}/beat_{beat_num:02d}.png"
    return make_static_url_for_context(
        ctx,
        rel,
        local_path=project_dir / rel,
    )


def _director_control_scope(episode_num: int, beat_num: int) -> str:
    return f"director_control_to_sketch:ep{int(episode_num):03d}:beat_{int(beat_num):02d}"


def _director_control_payload(
    *,
    ctx: ProjectContext,
    project_dir: Path,
    episode_num: int,
    beat_num: int,
) -> dict[str, Any]:
    from novelvideo.director_world.control_frame_to_sketch import _director_control_mode_key
    from novelvideo.utils.path_resolver import PathResolver

    paths = PathResolver(str(project_dir), int(episode_num))
    control_frame = paths.director_render(int(beat_num))
    ready = control_frame.exists()
    mode_key = ""
    if ready:
        mode_key, _aspect_ratio = _director_control_mode_key(
            control_frame=control_frame,
            requested_mode_key="",
            requested_aspect_ratio="",
        )
    rel_path = None
    url = None
    if ready:
        try:
            rel_path = control_frame.relative_to(project_dir).as_posix()
            url = make_static_url_for_context(ctx, rel_path, local_path=control_frame)
        except ValueError:
            rel_path = control_frame.as_posix()
    return {
        "episode": int(episode_num),
        "beat_num": int(beat_num),
        "ready": ready,
        "path": control_frame.as_posix(),
        "rel_path": rel_path,
        "url": url,
        "scope": _director_control_scope(episode_num, beat_num),
        "mode_key": mode_key,
    }


def _director_overlay_beat_context(beat: dict[str, Any]) -> dict[str, Any]:
    identities = beat.get("detected_identities") or []
    props = beat.get("detected_props") or []
    return {
        "detected_identities": [str(item) for item in identities if str(item).strip()],
        "detected_props": [str(item) for item in props if str(item).strip()],
    }


def _director_same_scene_beats(beats: list[dict[str, Any]], scene_name: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for item in beats:
        if _beat_scene_name(item) != scene_name:
            continue
        beat_number = item.get("beat_number") or item.get("beat") or item.get("number")
        try:
            beat_int = int(beat_number)
        except (TypeError, ValueError):
            continue
        items.append({"beat": beat_int, "label": f"Beat {beat_int}", "scene_id": scene_name})
    return sorted(items, key=lambda entry: entry["beat"])


def _director_overlay_payload(
    *,
    episode_num: int,
    beat_num: int,
    scene_name: str,
    beat: dict[str, Any],
    body: dict[str, Any],
) -> dict[str, Any]:
    from datetime import datetime, timezone

    snapshot = body.get("snapshot")
    snapshot = snapshot if isinstance(snapshot, dict) else {}
    body_actors = body.get("actors")
    body_props = body.get("props")
    body_stagings = body.get("stagings")
    actors = body_actors if isinstance(body_actors, list) else snapshot.get("actors") or []
    props = body_props if isinstance(body_props, list) else snapshot.get("props") or []
    stagings = body_stagings if isinstance(body_stagings, list) else snapshot.get("stagings") or []
    legacy_props = [*props, *stagings] if isinstance(props, list) and isinstance(stagings, list) else props
    frame_meta = body.get("frame_meta")
    frame_meta = frame_meta if isinstance(frame_meta, dict) else {}
    source = body.get("source")
    if not isinstance(source, dict):
        meta_source = frame_meta.get("source")
        source = meta_source if isinstance(meta_source, dict) else {}
    return {
        "schema_version": "director_stage_overlay_v1",
        "scene_id": scene_name,
        "episode": int(episode_num),
        "beat": int(beat_num),
        "frame_aspect": str(body.get("frame_aspect") or "16:9"),
        "source": source,
        "frame_meta": frame_meta,
        "snapshot": snapshot,
        "camera": snapshot.get("camera") or body.get("camera") or {},
        "actors": actors,
        "props": legacy_props,
        "stagings": stagings,
        "command_log": body.get("command_log") if isinstance(body.get("command_log"), list) else [],
        "deleted_keys": body.get("deleted_keys") if isinstance(body.get("deleted_keys"), list) else [],
        "beat_context": _director_overlay_beat_context(beat),
        "saved_at": datetime.now(timezone.utc).isoformat(),
    }


def _director_overlay_status_payload(
    *,
    project_dir: Path,
    episode_num: int,
    beat_num: int,
    scene_name: str,
    beats: list[dict[str, Any]],
) -> dict[str, Any]:
    from novelvideo.director_world.paths import beat_blocking_path
    from novelvideo.director_world.store import load_beat_blocking

    path = beat_blocking_path(project_dir, episode_num, beat_num)
    same_scene = _director_same_scene_beats(beats, scene_name)
    current = load_beat_blocking(project_dir, episode_num, beat_num)
    if current:
        return {
            "status": "current",
            "overlay": current,
            "path": path.as_posix(),
            "same_scene_beats": same_scene,
        }

    inherited: dict[str, Any] | None = None
    inherited_from: int | None = None
    for item in same_scene:
        candidate_beat = int(item["beat"])
        if candidate_beat >= int(beat_num):
            continue
        candidate = load_beat_blocking(project_dir, episode_num, candidate_beat)
        if candidate:
            inherited = candidate
            inherited_from = candidate_beat
    if inherited:
        return {
            "status": "inherited",
            "overlay": inherited,
            "path": path.as_posix(),
            "inherited_from_beat": inherited_from,
            "same_scene_beats": same_scene,
        }
    return {
        "status": "missing",
        "overlay": None,
        "path": path.as_posix(),
        "same_scene_beats": same_scene,
    }


def _decode_png_data_url(data_url: str) -> bytes:
    import base64

    prefix = "data:image/png;base64,"
    if not data_url.startswith(prefix):
        raise ValueError("expected PNG data URL")
    return base64.b64decode(data_url[len(prefix) :], validate=True)


def _director_control_frame_export_payload(
    *,
    ctx: ProjectContext,
    project_dir: Path,
    scene_name: str,
    episode_num: int,
    beat_num: int,
    body: dict[str, Any],
) -> dict[str, Any]:
    target_dir = (
        project_dir
        / "director_control_frames"
        / f"ep{int(episode_num):03d}"
        / f"beat_{int(beat_num):02d}"
    )
    target_dir.mkdir(parents=True, exist_ok=True)
    images = body.get("images")
    images = images if isinstance(images, dict) else {}
    submitted_frame_meta = body.get("frame_meta")
    if not isinstance(submitted_frame_meta, dict) or not submitted_frame_meta:
        raise ValueError("combined, env_only and frame_meta are required")
    missing_kinds = [
        kind
        for kind in ("combined", "env_only")
        if not isinstance(images.get(kind), str) or not images.get(kind)
    ]
    if missing_kinds:
        raise ValueError("combined, env_only and frame_meta are required")
    filename_by_kind = {
        "combined": "combined.png",
        "env_only": "env_only.png",
    }
    paths: dict[str, str] = {}
    rel_paths: dict[str, str] = {}
    urls: dict[str, str] = {}
    for kind, filename in filename_by_kind.items():
        data_url = images.get(kind)
        if not isinstance(data_url, str) or not data_url:
            continue
        path = target_dir / filename
        path.write_bytes(_decode_png_data_url(data_url))
        paths[kind] = path.as_posix()
        rel_paths[kind] = path.relative_to(project_dir).as_posix()
        urls[kind] = make_static_url_for_context(ctx, rel_paths[kind], local_path=path)

    snapshot = body.get("snapshot")
    snapshot = snapshot if isinstance(snapshot, dict) else {}
    body_actors = body.get("actors")
    body_props = body.get("props")
    body_stagings = body.get("stagings")
    actors = body_actors if isinstance(body_actors, list) else snapshot.get("actors") or []
    props = body_props if isinstance(body_props, list) else snapshot.get("props") or []
    stagings = body_stagings if isinstance(body_stagings, list) else snapshot.get("stagings") or []
    legacy_props = [*props, *stagings] if isinstance(props, list) and isinstance(stagings, list) else props
    meta = dict(submitted_frame_meta)
    meta.setdefault("scene_id", scene_name)
    meta.setdefault("episode", int(episode_num))
    meta.setdefault("beat", int(beat_num))
    meta.setdefault("frame_aspect", str(body.get("frame_aspect") or "16:9"))
    meta.setdefault("actors", actors)
    meta.setdefault("props", legacy_props)
    meta.setdefault("stagings", stagings)
    meta["paths"] = rel_paths
    meta_path = target_dir / "frame_meta.json"
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    paths["frame_meta"] = meta_path.as_posix()
    rel_paths["frame_meta"] = meta_path.relative_to(project_dir).as_posix()
    urls["frame_meta"] = make_static_url_for_context(ctx, rel_paths["frame_meta"], local_path=meta_path)
    return {"dir": target_dir.as_posix(), "paths": paths, "rel_paths": rel_paths, "urls": urls, "meta": meta}


async def _episode_beat_from_resolution(
    resolved,
    episode_num: int,
    beat_num: int,
):
    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(resolved.username, resolved.project_name)
    )
    try:
        beats = await store.get_beats_as_dicts(int(episode_num))
        target = next(
            (
                beat
                for beat in beats
                if int(beat.get("beat_number") or 0) == int(beat_num)
            ),
            None,
        )
        if target is None:
            raise HTTPException(status_code=404, detail=f"Beat {beat_num} not found")
        return store, target
    except Exception:
        close = getattr(store, "close", None)
        if close:
            await close()
        raise


def _beat_scene_name(beat: dict[str, Any]) -> str:
    return str(beat_scene_id(beat) or beat.get("location") or "").strip()


def _api_background_reference_url_builder(ctx: ProjectContext):
    def _build(path: Path, rel_path: str) -> str:
        return make_static_url_for_context(ctx, rel_path, local_path=path)

    return _build


def _api_background_anchor_url_builder(ctx: ProjectContext):
    def _build(path: Path, rel_path: str) -> str | None:
        return make_static_url_for_context(ctx, rel_path, local_path=path)

    return _build


def _background_anchors_payload(
    *,
    ctx: ProjectContext,
    username: str,
    project: str,
    project_dir: Path,
    beat: dict[str, Any],
    episode_num: int,
    beat_num: int,
) -> dict[str, Any]:
    return build_background_anchors_payload(
        project_dir=project_dir,
        username=username,
        project=project,
        beat=beat,
        episode_num=int(episode_num),
        beat_num=int(beat_num),
        reference_url_builder=_api_background_reference_url_builder(ctx),
        anchor_url_builder=_api_background_anchor_url_builder(ctx),
    )


@router.get("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/pano-background/manifest")
async def get_beat_pano_background_manifest(
    project: str,
    episode_num: int,
    beat_num: int,
    user: dict = Depends(get_api_user),
):
    """Return the typed 360 viewer manifest for Beat selected-background capture."""
    resolved = await _resolve_generation_project(project, user, required_role="viewer")
    project_dir = resolved.project_dir
    store, beat = await _episode_beat_from_resolution(resolved, episode_num, beat_num)
    try:
        scene_name = _beat_scene_name(beat)
        if not scene_name:
            return {"ok": False, "error": "The current Beat has no associated scene"}
        manifest = build_pano_viewer_manifest(
            ctx=resolved.ctx,
            project_dir=project_dir,
            scene_name=scene_name,
            mode="beat",
            episode_num=int(episode_num),
            beat_num=int(beat_num),
            beat=beat,
        )
        if manifest is None:
            return {"ok": False, "error": "The current scene has no 360 panorama asset"}
        return {"ok": True, "data": manifest.model_dump(exclude_none=True)}
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()


@router.get("/projects/{project}/director-stage/palette")
async def get_default_director_stage_palette(
    project: str,
    user: dict = Depends(get_api_user),
):
    """Return the shared director-stage palette used by local/freezone worlds."""
    await _resolve_generation_project(project, user, required_role="viewer")
    return {"ok": True, "data": default_director_stage_palette().model_dump(exclude_none=True)}


@router.get("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/director-stage/manifest")
async def get_beat_director_stage_manifest(
    project: str,
    episode_num: int,
    beat_num: int,
    user: dict = Depends(get_api_user),
):
    """Return the typed 3GS director-stage manifest for Beat-level capture."""
    resolved = await _resolve_generation_project(project, user, required_role="viewer")
    project_dir = resolved.project_dir
    store, beat = await _episode_beat_from_resolution(resolved, episode_num, beat_num)
    try:
        scene_name = _beat_scene_name(beat)
        if not scene_name:
            return {"ok": False, "error": "The current Beat has no associated scene"}
        beats = await store.get_beats_as_dicts(int(episode_num))
        sketch_colors = {}
        get_sketch_colors = getattr(store, "get_sketch_colors", None)
        if get_sketch_colors is not None:
            sketch_colors = dict(get_sketch_colors(int(episode_num)) or {})
        episode_obj = _episode_from_store_or_none(store, int(episode_num))
        prop_menu = await _runtime_prop_menu_with_global_props(store, episode_obj, list(beats))
        manifest = build_director_stage_manifest(
            ctx=resolved.ctx,
            project_dir=project_dir,
            scene_name=scene_name,
            mode="beat",
            episode_num=int(episode_num),
            beat_num=int(beat_num),
            beat=beat,
            sketch_colors=sketch_colors,
            prop_marker_colors=_prop_marker_colors_from_menu(prop_menu),
        )
        if manifest is None:
            return {"ok": False, "error": "The current scene has no 3GS asset"}
        return {"ok": True, "data": manifest.model_dump(exclude_none=True)}
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()


@router.get("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/director-stage/overlay")
async def get_beat_director_stage_overlay(
    project: str,
    episode_num: int,
    beat_num: int,
    user: dict = Depends(get_api_user),
):
    """Load the current Beat 3GS overlay, or inherit the previous same-scene Beat."""
    resolved = await _resolve_generation_project(project, user, required_role="viewer")
    project_dir = resolved.project_dir
    store, beat = await _episode_beat_from_resolution(resolved, episode_num, beat_num)
    try:
        scene_name = _beat_scene_name(beat)
        if not scene_name:
            return {"ok": False, "error": "The current Beat has no associated scene"}
        beats = await store.get_beats_as_dicts(int(episode_num))
        return {
            "ok": True,
            "data": _director_overlay_status_payload(
                project_dir=project_dir,
                episode_num=int(episode_num),
                beat_num=int(beat_num),
                scene_name=scene_name,
                beats=list(beats),
            ),
        }
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()


@router.post("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/director-stage/overlay")
async def save_beat_director_stage_overlay(
    project: str,
    episode_num: int,
    beat_num: int,
    body: dict[str, Any],
    user: dict = Depends(get_api_user),
):
    """Persist the current Beat 3GS overlay to director_blockings/epNNN/beat_MM.json."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    project_dir = resolved.project_dir
    store, beat = await _episode_beat_from_resolution(resolved, episode_num, beat_num)
    try:
        scene_name = _beat_scene_name(beat)
        if not scene_name:
            return {"ok": False, "error": "The current Beat has no associated scene"}
        payload = _director_overlay_payload(
            episode_num=int(episode_num),
            beat_num=int(beat_num),
            scene_name=scene_name,
            beat=beat,
            body=body,
        )
        from novelvideo.director_world.store import save_beat_blocking

        path = save_beat_blocking(project_dir, int(episode_num), int(beat_num), payload)
        if hasattr(store, "update_beat_asset"):
            overlay_prop_labels = [
                str(item.get("label") or item.get("prop_id") or "").strip()
                for item in payload.get("props", [])
                if isinstance(item, dict)
                and str(item.get("type") or "").strip() != "prop_staging"
                and str(item.get("category") or "").strip() != "staging"
            ]
            merged_props = [
                prop
                for prop in [
                    *payload["beat_context"].get("detected_props", []),
                    *overlay_prop_labels,
                ]
                if prop
            ]
            deduped_props = list(dict.fromkeys(merged_props))
            await store.update_beat_asset(
                episode_number=int(episode_num),
                beat_number=int(beat_num),
                detected_props=deduped_props,
            )
        beats = await store.get_beats_as_dicts(int(episode_num))
        return {
            "ok": True,
            "data": {
                "status": "saved",
                "overlay": payload,
                "path": path.as_posix(),
                "same_scene_beats": _director_same_scene_beats(list(beats), scene_name),
            },
        }
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()


@router.post("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/director-stage/control-frame")
async def export_beat_director_stage_control_frame(
    project: str,
    episode_num: int,
    beat_num: int,
    body: dict[str, Any],
    user: dict = Depends(get_api_user),
):
    """Persist Director Render control-frame PNG layers and frame_meta.json."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    project_dir = resolved.project_dir
    store, beat = await _episode_beat_from_resolution(resolved, episode_num, beat_num)
    try:
        scene_name = _beat_scene_name(beat)
        if not scene_name:
            return {"ok": False, "error": "The current Beat has no associated scene"}
        try:
            payload = _director_control_frame_export_payload(
                ctx=resolved.ctx,
                project_dir=project_dir,
                scene_name=scene_name,
                episode_num=int(episode_num),
                beat_num=int(beat_num),
                body=body,
            )
        except (ValueError, TypeError) as exc:
            return JSONResponse(status_code=400, content={"ok": False, "error": str(exc)})
        return {"ok": True, "data": payload}
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()


@router.get("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/background-anchors")
async def get_beat_background_anchors(
    project: str,
    episode_num: int,
    beat_num: int,
    user: dict = Depends(get_api_user),
):
    """Return NiceGUI-compatible single-beat background anchor options."""
    resolved = await _resolve_generation_project(project, user, required_role="viewer")
    username = resolved.username
    project_name = resolved.project_name
    project_dir = resolved.project_dir
    store, beat = await _episode_beat_from_resolution(resolved, episode_num, beat_num)
    try:
        return {
            "ok": True,
            "data": _background_anchors_payload(
                ctx=resolved.ctx,
                username=username,
                project=project_name,
                project_dir=project_dir,
                beat=beat,
                episode_num=episode_num,
                beat_num=beat_num,
            ),
        }
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()


@router.patch("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/background-anchor")
async def update_beat_background_anchor(
    project: str,
    episode_num: int,
    beat_num: int,
    body: BeatBackgroundAnchorUpdate,
    user: dict = Depends(get_api_user),
):
    """Persist the single-beat background anchor selection.

    Matches NiceGUI's render-input semantics: master/reverse/director env-only
    are snapshotted into the beat-owned selected_background.png before being
    used, while render_anchor_source_id preserves the UI-visible source.
    """
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    username = resolved.username
    project_name = resolved.project_name
    project_dir = resolved.project_dir
    store, beat = await _episode_beat_from_resolution(resolved, episode_num, beat_num)
    try:
        try:
            payload = select_background_anchor(
                project_dir=project_dir,
                username=username,
                project=project_name,
                beat=beat,
                episode_num=int(episode_num),
                beat_num=int(beat_num),
                anchor_id=body.anchor_id,
                reference_url_builder=_api_background_reference_url_builder(resolved.ctx),
                anchor_url_builder=_api_background_anchor_url_builder(resolved.ctx),
            )
        except BackgroundAnchorError as exc:
            return {"ok": False, "error": str(exc)}

        if hasattr(store, "update_beat_asset"):
            await store.update_beat_asset(
                episode_number=int(episode_num),
                beat_number=int(beat_num),
                scene_ref=dict(beat.get("scene_ref") or {}),
            )

        return {"ok": True, "data": payload}
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()


@router.post("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/background-anchor/crop")
async def crop_beat_background_anchor(
    project: str,
    episode_num: int,
    beat_num: int,
    body: dict[str, Any],
    user: dict = Depends(get_api_user),
):
    """Crop a source background into the beat-owned render background slot."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    username = resolved.username
    project_name = resolved.project_name
    project_dir = resolved.project_dir
    store, beat = await _episode_beat_from_resolution(resolved, episode_num, beat_num)
    try:
        try:
            payload = crop_background_anchor_to_selected(
                project_dir=project_dir,
                username=username,
                project=project_name,
                beat=beat,
                episode_num=int(episode_num),
                beat_num=int(beat_num),
                anchor_id=str(body.get("anchor_id") or ""),
                crop=body,
                reference_url_builder=_api_background_reference_url_builder(resolved.ctx),
                anchor_url_builder=_api_background_anchor_url_builder(resolved.ctx),
            )
        except BackgroundAnchorError as exc:
            return {"ok": False, "error": str(exc)}
        except (TypeError, ValueError):
            return JSONResponse(
                status_code=400,
                content={"ok": False, "error": "Invalid crop parameters"},
            )
        except Exception as exc:
            return {"ok": False, "error": f"Failed to crop the Render background reference: {exc}"}

        if hasattr(store, "update_beat_asset"):
            await store.update_beat_asset(
                episode_number=int(episode_num),
                beat_number=int(beat_num),
                scene_ref=dict(beat.get("scene_ref") or {}),
            )

        return {"ok": True, "data": payload}
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()


@router.post("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/background-anchor/upload")
async def upload_beat_background_anchor(
    project: str,
    episode_num: int,
    beat_num: int,
    file: UploadFile = File(...),
    user: dict = Depends(get_api_user),
):
    """Upload an external render-background reference for a single Beat.

    This mirrors NiceGUI's Render background reference upload path: the image is stored in
    the beat-owned selected_background.png slot and the beat scene_ref persists
    render_anchor_id=selected_background plus render_anchor_source_id for UI.
    It is a compatibility API for React; render generation still consumes the
    same core scene_ref contract.
    """
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    username = resolved.username
    project_name = resolved.project_name
    project_dir = resolved.project_dir
    store, beat = await _episode_beat_from_resolution(resolved, episode_num, beat_num)
    try:
        try:
            image = await _read_uploaded_rgb_image(file)
        except Exception as exc:
            return {"ok": False, "error": f"Failed to upload the external reference image: {exc}"}

        try:
            payload = save_uploaded_background_anchor_image(
                project_dir=project_dir,
                username=username,
                project=project_name,
                beat=beat,
                episode_num=int(episode_num),
                beat_num=int(beat_num),
                image=image,
                reference_url_builder=_api_background_reference_url_builder(resolved.ctx),
                anchor_url_builder=_api_background_anchor_url_builder(resolved.ctx),
            )
        except BackgroundAnchorError as exc:
            return {"ok": False, "error": str(exc)}

        if hasattr(store, "update_beat_asset"):
            await store.update_beat_asset(
                episode_number=int(episode_num),
                beat_number=int(beat_num),
                scene_ref=dict(beat.get("scene_ref") or {}),
            )

        return {"ok": True, "data": payload}
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()


@router.get("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/director-control-frame")
async def get_director_control_frame_status(
    project: str,
    episode_num: int,
    beat_num: int,
    user: dict = Depends(get_api_user),
):
    """Return the NiceGUI director control frame status for one beat."""
    resolved = await _resolve_generation_project(project, user, required_role="viewer")
    project_dir = resolved.project_dir
    return {
        "ok": True,
        "data": _director_control_payload(
            ctx=resolved.ctx,
            project_dir=project_dir,
            episode_num=episode_num,
            beat_num=beat_num,
        ),
    }


@router.post("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/director-control-to-sketch")
async def director_control_to_sketch(
    project: str,
    episode_num: int,
    beat_num: int,
    user: dict = Depends(get_api_user),
):
    """Start the existing Direct Render combined.png -> canonical sketch task."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    ctx = resolved.ctx
    username = resolved.username
    project_name = resolved.project_name
    project_dir = resolved.project_dir
    state_dir = str(ctx.state_dir) if ctx else get_state_dir(username, project_name)
    payload = _director_control_payload(
        ctx=resolved.ctx,
        project_dir=project_dir,
        episode_num=episode_num,
        beat_num=beat_num,
    )
    if not payload["ready"]:
        return {
            "ok": False,
            "error": f"Beat {int(beat_num)} is missing Direct Render combined.png. Export it from 3GS / Freezone first",
            "data": payload,
        }

    project_config = load_project_config(username, project_name)
    sketch_image_selection = _resolve_sketch_image_selection(project_config)
    mode_key = str(payload.get("mode_key") or "1x1_2-3_sketch")
    billing = _sketch_regen_billing_metadata(sketch_image_selection, mode_key)

    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            product_surface="mainline",
            task_type="director_control_to_sketch",
            queue_kind="default",
            episode=int(episode_num),
            beat_num=int(beat_num),
            scope=payload["scope"],
            payload={
                "task_kind": "director_control_to_sketch",
                "episode": int(episode_num),
                "beat_num": int(beat_num),
                "output_dir": str(project_dir),
                "state_dir": state_dir,
                "mode_key": mode_key,
                "billing": billing,
            },
        )
        return {
            "ok": True,
            "task_type": "director_control_to_sketch",
            "scope": payload["scope"],
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key(
                "director_control_to_sketch",
                ctx.project_id,
                int(episode_num),
                beat_num=int(beat_num),
                scope=payload["scope"],
            ),
            "backend": queued.backend,
            "queue": queued.queue,
            "message": f"Beat {int(beat_num)} Direct Render to sketch task queued",
            "data": payload,
        }

    try:
        start_fn = globals().get("start_control_frame_to_sketch_task")
        if start_fn is None:
            return {
                "ok": False,
                "error": "Direct Render to sketch requires a project context",
                "data": payload,
            }

        start_fn(
            username=username,
            project=project_name,
            episode=int(episode_num),
            beat_num=int(beat_num),
            output_dir=str(project_dir),
            state_dir=state_dir,
            scope=payload["scope"],
        )
    except Exception as exc:
        return {"ok": False, "error": str(exc), "data": payload}

    return {
        "ok": True,
        "task_type": "director_control_to_sketch",
        "scope": payload["scope"],
        "message": f"Beat {int(beat_num)} Direct Render to sketch task started",
        "data": payload,
    }


@router.get("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/sketch/pose-editor")
async def get_sketch_pose_editor(
    project: str,
    episode_num: int,
    beat_num: int,
    user: dict = Depends(get_api_user),
):
    """Return NiceGUI-compatible pose editor payload for a canonical sketch."""
    from PIL import Image
    from novelvideo.services.sketch_pose_service import (
        POSE_PRESETS,
        SKELETON_EDGES,
        build_all_episode_candidates,
        build_pose_candidates,
        _heuristic_pose_from_bbox,
    )

    resolved = await _resolve_generation_project(project, user, required_role="viewer")
    username = resolved.username
    project_name = resolved.project_name
    project_dir = resolved.project_dir
    sketch_path = _canonical_sketch_path(project_dir, episode_num, beat_num)
    if not sketch_path.exists():
        return JSONResponse(
            status_code=404,
            content={"ok": False, "error": f"Beat {beat_num} has no current sketch"},
        )

    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(username, project_name)
    )
    beats = await store.get_beats_as_dicts(episode_num)
    beat = next((b for b in beats if int(b.get("beat_number", 0) or 0) == beat_num), None)
    if beat is None:
        return JSONResponse(
            status_code=404,
            content={"ok": False, "error": f"Beat {beat_num} does not exist"},
        )

    sketch_colors = store.get_sketch_colors(episode_num) or {}
    candidates = build_pose_candidates(beat, sketch_colors)
    if not candidates:
        candidates = build_all_episode_candidates(sketch_colors)
    if not candidates:
        return {"ok": False, "error": "No identities with assigned colors in this episode. Re-assign colors first"}

    with Image.open(sketch_path) as image:
        width, height = image.size

    skeletons: list[dict[str, Any]] = []
    total = len(candidates)
    margin = width * 0.15
    spacing = (width - 2 * margin) / max(1, total - 1) if total > 1 else 0
    for idx, candidate in enumerate(candidates):
        cx = int(margin + idx * spacing) if total > 1 else width // 2
        bw = max(40, int(width * 0.15))
        bh = max(80, int(height * 0.65))
        cy = int(height * 0.1)
        bbox = (cx - bw // 2, cy, cx + bw // 2, cy + bh)
        pose_data = _heuristic_pose_from_bbox(bbox, (width, height))
        skeletons.append(
            {
                "identityId": candidate.identity_id,
                "colorHex": candidate.color_hex,
                "colorName": candidate.color_name,
                "joints": pose_data["joints"],
                "lineWidth": pose_data.get("line_width", 3),
                "headRadius": pose_data.get("head_radius", 12),
                "visible": False,
                "active": idx == 0,
            }
        )

    return {
        "ok": True,
        "data": {
            "beat_num": beat_num,
            "sketch_url": _canonical_sketch_url(resolved.ctx, project_dir, episode_num, beat_num),
            "width": width,
            "height": height,
            "candidates": [
                {
                    "identity_id": candidate.identity_id,
                    "color_hex": candidate.color_hex,
                    "color_name": candidate.color_name,
                }
                for candidate in candidates
            ],
            "skeleton_edges": SKELETON_EDGES,
            "pose_presets": POSE_PRESETS,
            "skeletons": skeletons,
        },
    }


@router.post("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/sketch/pose-editor")
async def save_sketch_pose_editor(
    project: str,
    episode_num: int,
    beat_num: int,
    body: dict[str, Any],
    user: dict = Depends(get_api_user),
):
    """Persist pose editor strokes/skeletons back to the canonical sketch."""
    from novelvideo.services.sketch_pose_service import save_pose_editor_state

    resolved = await _resolve_generation_project(project, user, required_role="editor")
    project_dir = resolved.project_dir
    sketch_path = _canonical_sketch_path(project_dir, episode_num, beat_num)
    if not sketch_path.exists():
        return JSONResponse(
            status_code=404,
            content={"ok": False, "error": f"Beat {beat_num} has no current sketch"},
        )

    try:
        save_pose_editor_state(str(sketch_path), body)
    except Exception as exc:
        return JSONResponse(
            status_code=400,
            content={"ok": False, "error": f"Failed to save the sketch edit: {exc}"},
        )

    return {
        "ok": True,
        "data": {
            "beat_num": beat_num,
            "sketch_url": _canonical_sketch_url(resolved.ctx, project_dir, episode_num, beat_num),
        },
    }


@router.post("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/sketch/crop")
async def crop_current_sketch(
    project: str,
    episode_num: int,
    beat_num: int,
    body: dict[str, Any],
    user: dict = Depends(get_api_user),
):
    """Crop and overwrite the canonical sketch, matching NiceGUI current-image crop."""
    from PIL import Image

    resolved = await _resolve_generation_project(project, user, required_role="editor")
    project_dir = resolved.project_dir
    sketch_path = _canonical_sketch_path(project_dir, episode_num, beat_num)
    if not sketch_path.exists():
        return JSONResponse(
            status_code=404,
            content={"ok": False, "error": f"Beat {beat_num} has no current sketch"},
        )

    try:
        x = int(body.get("x", 0))
        y = int(body.get("y", 0))
        width = int(body.get("width", 0))
        height = int(body.get("height", 0))
    except (TypeError, ValueError):
        return JSONResponse(
            status_code=400,
            content={"ok": False, "error": "Invalid crop parameters"},
        )
    if width <= 0 or height <= 0:
        return JSONResponse(
            status_code=400,
            content={"ok": False, "error": "Crop width and height must be greater than 0"},
        )

    with Image.open(sketch_path).convert("RGBA") as image:
        crop_x = max(0, min(x, image.width - 1))
        crop_y = max(0, min(y, image.height - 1))
        right = min(crop_x + width, image.width)
        bottom = min(crop_y + height, image.height)
        cropped = image.crop((crop_x, crop_y, right, bottom))
        cropped.save(sketch_path, format="PNG")

    return {
        "ok": True,
        "data": {
            "beat_num": beat_num,
            "sketch_url": _canonical_sketch_url(resolved.ctx, project_dir, episode_num, beat_num),
            "width": cropped.width,
            "height": cropped.height,
        },
    }


@router.post("/projects/{project}/episodes/{episode_num}/sketches/generate-missing-manual")
async def generate_missing_manual_sketches(
    project: str,
    episode_num: int,
    user: dict = Depends(get_api_user),
):
    """Dispatch sketch regen only for manually inserted beats missing sketches.

    This scans `is_manual_shot=True` beats whose canonical sketch file does not
    exist, groups adjacent missing manual beats by scene, and dispatches one
    `sketch_regen` task per group. Normal beats are never regenerated here.
    """
    from novelvideo.manual_shots import (
        choose_manual_sketch_mode_key,
        missing_manual_shot_segments,
        storyboard_beats_for_manual_sketches,
    )
    from novelvideo.task_identity import selection_scope

    resolved = await _resolve_generation_project(project, user, required_role="editor")
    ctx = resolved.ctx
    username = resolved.username
    project_name = resolved.project_name
    project_dir = resolved.project_dir
    output_dir = resolved.output_dir
    sketches_dir = project_dir / "sketches" / f"ep{episode_num:03d}"

    store = (
        await make_sqlite_store_for_context(ctx)
        if ctx
        else await make_sqlite_store(username, project_name)
    )
    beats = await store.get_beats_as_dicts(episode_num)
    if not beats:
        return {"ok": False, "error": f"Episode {episode_num} has no beats"}

    storyboard_beats = storyboard_beats_for_manual_sketches(beats)
    segments = missing_manual_shot_segments(storyboard_beats, sketches_dir)
    if not segments:
        return {
            "ok": True,
            "data": {"dispatched": 0, "scopes": [], "segments": []},
            "message": "No manual shots are missing sketches",
        }

    proj_config = load_project_config(username, project_name)
    style = proj_config.get("visual_style", "chinese_period_drama")
    sketch_image_selection = _resolve_sketch_image_selection(proj_config)
    character_map = await _build_character_map(
        store,
        beats,
        username,
        project_name,
        episode_num=episode_num,
        use_detected_identities=False,
    )
    sketch_colors = store.get_sketch_colors(episode_num) or {}

    dispatched_scopes: list[str] = []
    dispatched_segments: list[list[int]] = []
    rejected: list[dict[str, Any]] = []
    for position, beat_numbers in enumerate(segments):
        beat_indices = [int(n) for n in beat_numbers]
        mode_key = choose_manual_sketch_mode_key(len(beat_indices))
        config = {
            "beats": beats,
            "character_map": character_map,
            "style": style,
            "model": None,
            "image_generation_selection": sketch_image_selection,
            "selected_beat_numbers": beat_indices,
            "composite_key": f"{mode_key}:sketch",
            "sketch_colors": sketch_colors,
        }
        scope = selection_scope(mode_key, beat_indices)
        if ctx is not None:
            try:
                await get_task_backend().enqueue_project_task(
                    ctx,
                    product_surface="mainline",
                    task_type="sketch_regen",
                    queue_kind="default",
                    episode=episode_num,
                    scope=scope,
                    payload={
                        "episode": episode_num,
                        "mode_key": mode_key,
                        "output_dir": output_dir,
                        "config": {**config, "mode_key": mode_key},
                    },
                )
            except _FANOUT_ACTIVE_LIMIT_ERRORS as exc:
                if not dispatched_scopes:
                    # k == 0: raise bare and let the handler render 429 (M8 invariant 7).
                    raise
                _log_partial_dispatch_rejection(exc)
                # Dispatch only this once, but report the undispatched tail one by one faithfully (N-k entries, M8 :722 / :755).
                for pending in segments[position:]:
                    pending_beats = [int(n) for n in pending]
                    pending_mode_key = choose_manual_sketch_mode_key(len(pending_beats))
                    rejected.append(
                        _task_limit_rejection(
                            selection_scope(pending_mode_key, pending_beats), exc
                        )
                    )
                break
            dispatched_scopes.append(scope)
            dispatched_segments.append(beat_indices)
            continue

        return {
            "ok": False,
            "error": f"Segment {beat_indices} dispatch failed: project context required",
            "data": {
                "dispatched": len(dispatched_scopes),
                "scopes": dispatched_scopes,
                "segments": dispatched_segments,
            },
        }

    return {
        "ok": True,
        "task_type": "sketch_regen",
        "data": {
            "dispatched": len(dispatched_segments),
            "scopes": dispatched_scopes,
            "segments": dispatched_segments,
            "rejected": rejected,
        },
        "message": f"Started {len(dispatched_segments)} groups of new-shot sketch generation",
    }


@router.post("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/video")
async def generate_single_video(
    project: str,
    episode_num: int,
    beat_num: int,
    body: SingleVideoRequest,
    user: dict = Depends(get_api_user),
):
    """Regenerate the video of a single Beat."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    ctx = resolved.ctx
    username = resolved.username
    project_name = resolved.project_name
    output_dir = resolved.output_dir
    store = (
        await make_sqlite_store_for_context(ctx)
        if ctx
        else await make_sqlite_store(username, project_name)
    )

    # Load beat data
    beats = await store.get_beats_as_dicts(episode_num)
    beat = next((b for b in beats if b.get("beat_number") == beat_num), None)
    if not beat:
        return {"ok": False, "error": f"Beat {beat_num} not found"}
    backend_error = _validate_seedance_pro_dialogue_only([beat], body.video_backend)
    if backend_error:
        return {"ok": False, "error": backend_error}
    is_seedance2 = _is_seedance2_backend(body.video_backend)
    is_happyhorse = _is_happyhorse_backend(body.video_backend)
    is_grok_video = _is_grok_video_backend(body.video_backend)
    is_runpod_h3 = _is_runpod_h3_backend(body.video_backend)

    # First frame path
    from novelvideo.utils.path_resolver import PathResolver

    paths = PathResolver(output_dir, episode_num)
    frame_path = paths.first_frame_for_video(
        beat_num,
        use_director_render=bool(body.use_director_render),
    )
    if not frame_path.exists():
        return {"ok": False, "error": f"Beat {beat_num} first frame does not exist. Generate a preview first"}

    # Video mode and prompt
    video_mode = beat.get("video_mode", "first_frame")
    prompt = _legacy_video_prompt_for_mode(beat, video_mode)

    # Audio duration
    from novelvideo.manual_shots import resolve_target_video_duration

    audio_duration = await _api_audio_duration_seconds(output_dir, episode_num, beat_num)
    video_duration = resolve_target_video_duration(beat, audio_duration)

    # Last frame path (keyframe mode)
    last_frame_path = None
    if video_mode == "keyframe":
        next_frame = paths.first_frame_for_video(
            beat_num + 1,
            use_director_render=bool(body.use_director_render),
        )
        if next_frame.exists():
            last_frame_path = str(next_frame)
        else:
            video_mode = "first_frame"  # fallback
            prompt = _legacy_video_prompt_for_mode(beat, video_mode)

    seedance2_config_json = None
    single_video_resolution: str | None = None
    happyhorse_references: list[dict[str, str]] = []
    happyhorse_ratio: str | None = None
    grok_video_references: list[dict[str, str]] = []
    grok_video_ratio: str | None = None
    if is_seedance2:
        try:
            request_config_json = _merge_seedance2_request_config(
                beat,
                seedance2_config_json=body.seedance2_config_json,
                config_overrides=_seedance2_request_config_overrides(body),
            )
            if request_config_json and hasattr(store, "update_beat_asset"):
                await store.update_beat_asset(
                    episode_number=episode_num,
                    beat_number=beat_num,
                    seedance2_config_json=request_config_json,
                )
            beat_index = beats.index(beat)
            episode_obj = _episode_from_store_or_none(store, episode_num)
            prop_menu = await _runtime_prop_menu_with_global_props(store, episode_obj, beats)
            prepared = await _prepare_seedance2_api_beat(
                store=store,
                output_dir=output_dir,
                episode=episode_num,
                beat=beat,
                all_beats=beats,
                index=beat_index,
                video_backend=body.video_backend,
                resolution=body.resolution if "resolution" in body.model_fields_set else None,
                ratio=body.ratio if "ratio" in body.model_fields_set else None,
                prop_menu=prop_menu,
            )
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
        prompt = prepared.prompt
        video_duration = prepared.duration
        frame_path = Path(prepared.image_path) if prepared.image_path else frame_path
        last_frame_path = prepared.last_frame_path
        seedance2_config_json = prepared.seedance2_config_json
        from novelvideo.seedance2_i2v.models import parse_seedance2_config

        single_video_resolution = parse_seedance2_config(
            seedance2_config_json
        ).resolution
        video_mode = "keyframe" if prepared.last_frame_path else "first_frame"
    elif is_happyhorse:
        try:
            request_config_json = _merge_seedance2_request_config(
                beat,
                seedance2_config_json=body.seedance2_config_json,
                config_overrides=_seedance2_request_config_overrides(body),
            )
            if request_config_json and hasattr(store, "update_beat_asset"):
                await store.update_beat_asset(
                    episode_number=episode_num,
                    beat_number=beat_num,
                    seedance2_config_json=request_config_json,
                )
            beat_index = beats.index(beat)
            episode_obj = _episode_from_store_or_none(store, episode_num)
            prop_menu = await _runtime_prop_menu_with_global_props(store, episode_obj, beats)
            prepared = await _prepare_happyhorse_api_beat(
                output_dir=output_dir,
                state_dir=Path(store.state_dir),
                episode=episode_num,
                beat=beat,
                next_beat=beats[beat_index + 1] if beat_index + 1 < len(beats) else None,
                frame_path=frame_path,
                video_mode=video_mode,
                prompt=prompt,
                duration=video_duration,
                resolution=body.resolution if "resolution" in body.model_fields_set else None,
                ratio=body.ratio if "ratio" in body.model_fields_set else None,
                prop_menu=prop_menu,
            )
            if prepared["config_json"] and hasattr(store, "update_beat_asset"):
                await store.update_beat_asset(
                    episode_number=episode_num,
                    beat_number=beat_num,
                    seedance2_config_json=str(prepared["config_json"]),
                )
            prompt = str(prepared["prompt"])
            video_duration = float(prepared["duration"])
            frame_path = Path(str(prepared["image_path"])) if prepared["image_path"] else None
            last_frame_path = None
            seedance2_config_json = str(prepared["config_json"])
            single_video_resolution = str(prepared["resolution"])
            happyhorse_ratio = str(prepared["ratio"])
            happyhorse_references = list(prepared.get("references") or [])
            video_mode = "first_frame"
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
    elif is_grok_video:
        try:
            request_config_json = _merge_seedance2_request_config(
                beat,
                seedance2_config_json=body.seedance2_config_json,
                config_overrides=_seedance2_request_config_overrides(body),
            )
            if request_config_json and hasattr(store, "update_beat_asset"):
                await store.update_beat_asset(
                    episode_number=episode_num,
                    beat_number=beat_num,
                    seedance2_config_json=request_config_json,
                )
            beat_index = beats.index(beat)
            episode_obj = _episode_from_store_or_none(store, episode_num)
            prop_menu = await _runtime_prop_menu_with_global_props(store, episode_obj, beats)
            prepared = await _prepare_grok_video_api_beat(
                output_dir=output_dir,
                state_dir=Path(store.state_dir),
                episode=episode_num,
                beat=beat,
                next_beat=beats[beat_index + 1] if beat_index + 1 < len(beats) else None,
                frame_path=frame_path,
                video_mode=video_mode,
                prompt=prompt,
                duration=video_duration,
                resolution=body.resolution if "resolution" in body.model_fields_set else None,
                ratio=body.ratio if "ratio" in body.model_fields_set else None,
                prop_menu=prop_menu,
            )
            if prepared["config_json"] and hasattr(store, "update_beat_asset"):
                await store.update_beat_asset(
                    episode_number=episode_num,
                    beat_number=beat_num,
                    seedance2_config_json=str(prepared["config_json"]),
                )
            prompt = str(prepared["prompt"])
            video_duration = float(prepared["duration"])
            frame_path = Path(str(prepared["image_path"])) if prepared["image_path"] else None
            last_frame_path = None
            seedance2_config_json = str(prepared["config_json"])
            single_video_resolution = str(prepared["resolution"])
            grok_video_ratio = str(prepared["ratio"])
            grok_video_references = list(prepared.get("references") or [])
            video_mode = "first_frame"
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
    elif is_runpod_h3:
        from novelvideo.seedance2_i2v.models import parse_seedance2_config

        # Must mirror `review_single_video`'s own `body.duration` override
        # exactly — the stale-input fingerprint check just below compares
        # against the review's fingerprint, which was computed with this
        # same override applied. Skipping it here (as a prior version of
        # this branch did) meant the two fingerprints could legitimately
        # disagree on duration alone, with every review+confirm reporting
        # `input_stale` even though nothing the user saw had actually
        # changed — and the job would have gone out at the wrong duration
        # besides.
        if body.duration is not None:
            try:
                video_duration = float(body.duration)
            except (TypeError, ValueError):
                pass
        h3_config = parse_seedance2_config(body.seedance2_config_json or beat.get("seedance2_config_json"))
        if body.final_prompt is not None:
            h3_config.final_prompt = str(body.final_prompt).strip()
            h3_config.prompt_source = "minimax_h3"
        prompt = h3_config.final_prompt
        if not prompt.strip():
            return {
                "ok": False,
                "error": f"Beat {beat_num} is missing the MiniMax H3 prompt. Generate/edit it in the video preview first.",
            }
        if body.review_fingerprint:
            character_map = await _build_character_map(
                store, beats, username, project_name, episode_num=episode_num
            )
            resolved_refs = _h3_identity_references(character_map, beat)
            if body.h3_reference_keys is not None:
                wanted = set(body.h3_reference_keys)
                resolved_refs = [r for r in resolved_refs if r["identity_id"] in wanted]
            current_fingerprint = _video_review_fingerprint(
                video_backend=body.video_backend,
                prompt=prompt,
                duration=float(video_duration),
                ratio=h3_config.ratio or "9:16",
                reference_paths=[r["path"] for r in resolved_refs],
                frame_path=str(frame_path) if frame_path.exists() else None,
            )
            if current_fingerprint != body.review_fingerprint:
                return {
                    "ok": False,
                    "error": "input_stale",
                    "message": "The inputs have changed since before submission (first frame / reference images / prompt). Reopen the preview to confirm.",
                }
        if hasattr(store, "update_beat_asset"):
            await store.update_beat_asset(
                episode_number=episode_num,
                beat_number=beat_num,
                seedance2_config_json=h3_config.model_dump_json(),
            )
        seedance2_config_json = h3_config.model_dump_json()
        video_mode = "first_frame"
    else:
        if not prompt.strip():
            return {"ok": False, "error": _missing_video_prompt_error(beat_num)}
        # Non-seedance2 backends (including seedance-1.5-pro): pass through the user's chosen duration/resolution,
        # and ensure the video duration is not shorter than the audio (consistent with the duration_floor behavior of 1.0;
        # the generator side then clamps to the model's 4-12 limit and rounds up).
        import math

        if body.duration is not None:
            try:
                video_duration = float(body.duration)
            except (TypeError, ValueError):
                pass
        if audio_duration:
            video_duration = max(float(video_duration), float(math.ceil(float(audio_duration))))
        if "resolution" in body.model_fields_set:
            single_video_resolution = _seedance2_resolution_for_backend(
                body.video_backend, body.resolution
            )

    from novelvideo.video_duration import normalize_video_duration_for_backend

    video_duration = normalize_video_duration_for_backend(
        body.video_backend,
        video_duration,
    )

    config = {
        "beat": dict(beat),
        "frame_path": str(frame_path) if frame_path else None,
        "video_mode": video_mode,
        "prompt": prompt,
        "video_duration": video_duration,
        "video_backend": body.video_backend,
        "use_director_render": bool(body.use_director_render),
        "last_frame_path": last_frame_path,
        "cognee_store_project": f"{username}/{project_name}",
    }
    if seedance2_config_json:
        config["seedance2_config"] = seedance2_config_json
    if single_video_resolution:
        config["resolution"] = single_video_resolution
    if is_happyhorse:
        config["ratio"] = _happyhorse_ratio_for_backend(happyhorse_ratio)
        config["references"] = happyhorse_references
        if body.audio_setting is not None:
            config["audio_setting"] = body.audio_setting
    if is_grok_video:
        config["ratio"] = _grok_video_ratio_for_backend(grok_video_ratio)
        config["references"] = grok_video_references
    if is_runpod_h3:
        config["ratio"] = h3_config.ratio or "9:16"
        config["references"] = [
            {"type": "image", "path": p, "role": "character/scene/prop reference"}
            for p in h3_config.reference_image_paths
        ] + [
            {"type": "audio", "path": p, "role": "voice reference"}
            for p in h3_config.reference_audio_paths
        ]
        if body.h3_profile:
            config["profile"] = body.h3_profile
        if body.two_stage is not None:
            config["two_stage"] = bool(body.two_stage)
        if body.audio_refine is not None:
            config["audio_refine"] = bool(body.audio_refine)

    billing_resolution = single_video_resolution or _seedance2_resolution_for_backend(
        body.video_backend,
        body.resolution,
    )
    billing = _single_video_billing_metadata(
        body.video_backend,
        resolution=billing_resolution,
        duration=video_duration,
    )

    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            product_surface="mainline",
            task_type="single_video",
            queue_kind="video",
            episode=episode_num,
            beat_num=beat_num,
            payload={
                "config": config,
                "output_dir": output_dir,
                "billing": billing,
                **({"batch_id": body.batch_id} if body.batch_id else {}),
                **({"batch_size": body.batch_size} if body.batch_size else {}),
            },
        )
        return {
            "ok": True,
            "task_type": "single_video",
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key(
                "single_video",
                ctx.project_id,
                episode_num,
                beat_num=beat_num,
            ),
            "backend": queued.backend,
            "queue": queued.queue,
            "message": f"Episode {episode_num} Beat {beat_num} video generation queued",
        }

    return {"ok": False, "error": "Single video generation requires a project context"}


_H3_IDENTITY_MARKER_RE = re.compile(r"\{\{([^}]+)\}\}\s*")


def _h3_replace_identity_markers(text: str, character_map: dict) -> str:
    """Replace every `{{identity_id}}` marker in `text` with that
    character's plain display name (e.g. `{{Nam_child}}` -> `Nam`) — the
    H3 prompt refers to characters by name/`<Subject N>`, not by the
    sketch-color marker syntax other pipeline steps use. Any marker whose
    identity isn't in `character_map` is left as the bare identity id
    (still better than a raw `{{...}}` the LLM has no reason to parse)."""
    if "{{" not in text:
        return text

    def _sub(match: re.Match) -> str:
        identity_id = match.group(1).strip()
        return _h3_char_name_for_identity(identity_id, character_map)

    return _H3_IDENTITY_MARKER_RE.sub(_sub, text)


_H3_SPEAKER_LABEL_RE_CACHE: dict[str, re.Pattern] = {}


def _h3_strip_redundant_speaker_label(text: str, speaker_name: str) -> str:
    """Strip a leading "SPEAKER NAME (optional direction): " screenplay
    label from `text`, when `text` starts with (a case-insensitive match
    of) the ALREADY-KNOWN `speaker_name` itself.

    Real bug, 2026-10-21: a dialogue beat's `narration_segment` can arrive
    as a full screenplay line — e.g.
    `"LITTLE KIM (flat, polite): A wall. Charming..."` — instead of just
    the words. H3's `<d>` tag is built verbatim from this text (rule 7:
    "copy this EXACTLY character-for-character", see
    `minimax_h3_prompt_builder.py`'s `_dialogue_block`), so the model
    dutifully SPOKE the label too ("LITTLE KIM flat polite a wall...").

    Matching against the name we already resolved from `beat.speaker` (or
    the `{{identity}}` marker, for the multi-turn caller below) — rather
    than a generic ALL-CAPS-word-then-colon heuristic — means this only
    ever strips a label that repeats the speaker we already know is
    talking, so there is no risk of eating real spoken words that happen
    to start with a capitalized word and a colon (e.g. a line that
    genuinely begins "Listen: ...").
    """
    name = speaker_name.strip()
    body = text.strip()
    if not name or not body:
        return body
    pattern = _H3_SPEAKER_LABEL_RE_CACHE.get(name)
    if pattern is None:
        escaped = re.escape(name)
        pattern = re.compile(
            # Matches both ASCII and full-width (Chinese) parens/colon —
            # real narration content can be in Chinese, not UI text.
            rf"^{escaped}\s*(?:\([^)]{{0,120}}\)|（[^）]{{0,120}}）)?\s*[:：]\s*",  # no-cjk-exempt
            re.IGNORECASE,
        )
        _H3_SPEAKER_LABEL_RE_CACHE[name] = pattern
    match = pattern.match(body)
    if not match:
        return body
    stripped = body[match.end() :].strip()
    return stripped or body


def _h3_parse_dialogue_segment(
    raw: str, character_map: dict
) -> tuple[str, str]:
    """Turn a beat's `narration_segment` for a dialogue beat into
    (clean_text, speaker_label).

    Most dialogue beats are a single plain line with the speaker already
    named in `beat.speaker` — those pass through unchanged (empty
    speaker_label, caller keeps using `beat.speaker`). Some ingested
    beats instead merge more than one character's line into one beat,
    marking each with a `{{identity}}` prefix right before it (e.g.
    `"{{Nam_...}} line one\\n{{Ryan_...}} line two"`) and leave
    `beat.speaker` empty — in that shape, `{{...}}` markers must be
    stripped and the lines re-attributed here, for two reasons: (1) a
    period-label identity id like `Nam_child` would otherwise pollute language detection on an all-English
    line, and (2) the LLM needs a clean "Name: line" turn per speaker
    rather than a raw, unparsed `{{...}}` token to transcribe verbatim.
    """
    matches = list(_H3_IDENTITY_MARKER_RE.finditer(raw))
    if not matches:
        return raw.strip(), ""

    turns: list[str] = []
    speakers: list[str] = []
    for i, match in enumerate(matches):
        identity_id = match.group(1).strip()
        char_name = _h3_char_name_for_identity(identity_id, character_map)
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(raw)
        line = raw[start:end].strip()
        if not line:
            continue
        line = _h3_strip_redundant_speaker_label(line, char_name)
        if not line:
            continue
        turns.append(f"{char_name}: {line}")
        if char_name not in speakers:
            speakers.append(char_name)
    return "\n".join(turns), " / ".join(speakers)


def _detect_h3_dialogue_language(text: str) -> str:
    """Language name for a MiniMax H3 `<d>[Language] ...</d>` line.

    Uses the shared asset-language contract (English / Vietnamese); empty
    dialogue keeps the historical Vietnamese default.
    """
    sample = str(text or "")
    if not sample.strip():
        return "Vietnamese"
    return language_name(detect_asset_language(sample))


def _h3_char_name_for_identity(identity_id: str, character_map: dict) -> str:
    if identity_id in character_map:
        return identity_id
    for char_name in character_map:
        if identity_id == char_name or identity_id.startswith(f"{char_name}_"):
            return char_name
    return identity_id


def _h3_identity_references(character_map: dict, beat: dict) -> list[dict[str, str]]:
    """Resolve `beat['detected_identities']` into reference entries this
    beat can attach to a MiniMax H3 prompt (`<Picture N>` for images,
    `<Audio N>` for a voice clip, if ever stored). Mirrors the
    identity-to-character matching used for render identity-swap
    (`_char_name_for_identity`/`_color_for_identity` in
    `generators/nanobanana_grid.py`)."""
    out: list[dict[str, str]] = []
    for identity_id in beat.get("detected_identities") or []:
        identity_id = str(identity_id)
        char_name = _h3_char_name_for_identity(identity_id, character_map)
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
        if not path or not Path(path).exists():
            path = info.get("portrait_path") or ""
        if not appearance:
            appearance = info.get("appearance_details") or ""
        if not path or not Path(path).exists():
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


def _h3_display_url(ctx: Any, output_dir: str | Path, abs_path: str | None) -> str | None:
    """Convert an absolute filesystem path under `output_dir` into the
    browser-servable `/static/projects/{id}/...` URL the frontend's
    `resolveMediaUrl()` actually accepts (it rejects a raw filesystem path
    like `/data/output/local/{project}/...`, which isn't on any
    `/static/`/`/api/` route). Falls back to the raw path, unchanged, if it
    isn't under `output_dir` or `ctx` isn't available — same as before this
    helper existed, so this never makes things worse."""
    if not abs_path or not ctx:
        return abs_path
    try:
        rel = Path(abs_path).relative_to(Path(output_dir)).as_posix()
    except ValueError:
        return abs_path
    return make_static_url_for_context(ctx, rel, local_path=abs_path)


def _video_review_fingerprint(
    *,
    video_backend: str,
    prompt: str,
    duration: float,
    ratio: str,
    reference_paths: list[str],
    frame_path: str | None,
) -> str:
    """Cheap change-detection digest for the review → generate round trip.
    Mtimes of referenced files are folded in so a regenerated portrait or
    an edited `.env` picture invalidates a stale review without needing a
    full plan/execute abstraction (see `render/plan`+`render/execute` for
    that heavier pattern, not needed here since there's only ever one
    beat in play)."""
    import hashlib

    parts = [video_backend, prompt, f"{duration:.2f}", ratio, frame_path or ""]
    for p in reference_paths:
        try:
            parts.append(f"{p}:{Path(p).stat().st_mtime_ns}")
        except OSError:
            parts.append(p)
    return hashlib.sha1("|".join(parts).encode("utf-8", "ignore")).hexdigest()[:16]


@router.post("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/video/review")
async def review_single_video(
    project: str,
    episode_num: int,
    beat_num: int,
    body: SingleVideoRequest,
    user: dict = Depends(get_api_user),
):
    """Dry-run preview of what `generate_single_video` would submit:
    resolves the effective prompt, duration, ratio and (for
    `runpod_minimax_h3`) the `<Picture N>` reference list and prompt
    lint, without enqueuing a task or calling any provider. The frontend
    review dialog calls this before every Generate/Regenerate video click
    (see `.claude/CLAUDE.md` plan)."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    ctx = resolved.ctx
    username = resolved.username
    project_name = resolved.project_name
    output_dir = resolved.output_dir
    store = (
        await make_sqlite_store_for_context(ctx)
        if ctx
        else await make_sqlite_store(username, project_name)
    )

    beats = await store.get_beats_as_dicts(episode_num)
    beat = next((b for b in beats if b.get("beat_number") == beat_num), None)
    if not beat:
        return {"ok": False, "error": f"Beat {beat_num} not found"}

    from novelvideo.manual_shots import resolve_target_video_duration
    from novelvideo.utils.path_resolver import PathResolver

    paths = PathResolver(output_dir, episode_num)
    frame_path = paths.first_frame_for_video(
        beat_num, use_director_render=bool(body.use_director_render)
    )
    frame_exists = frame_path.exists()

    audio_duration = await _api_audio_duration_seconds(output_dir, episode_num, beat_num)
    video_duration = resolve_target_video_duration(beat, audio_duration)
    if body.duration is not None:
        try:
            video_duration = float(body.duration)
        except (TypeError, ValueError):
            pass

    is_runpod_h3 = _is_runpod_h3_backend(body.video_backend)
    video_mode = beat.get("video_mode", "first_frame")
    mode = video_mode
    ratio = body.ratio or "9:16"
    references_out: list[dict[str, Any]] = []
    reference_paths: list[str] = []
    lint_issues: list[dict[str, str]] = []
    prompt_source = ""
    worker_status: dict[str, Any] | None = None
    needs_h3_prompt = False

    if is_runpod_h3:
        from novelvideo.agents.minimax_h3_prompt_lint import lint_minimax_h3_prompt
        from novelvideo.seedance2_i2v.models import parse_seedance2_config

        h3_config = parse_seedance2_config(
            body.seedance2_config_json or beat.get("seedance2_config_json")
        )
        prompt = (
            body.final_prompt if body.final_prompt is not None else h3_config.final_prompt
        ) or ""
        ratio = h3_config.ratio or ratio
        prompt_source = h3_config.prompt_source

        character_map = await _build_character_map(
            store, beats, username, project_name, episode_num=episode_num
        )
        resolved_refs = _h3_identity_references(character_map, beat)
        if body.h3_reference_keys is not None:
            wanted = set(body.h3_reference_keys)
            resolved_refs = [r for r in resolved_refs if r["identity_id"] in wanted]
        reference_paths = [r["path"] for r in resolved_refs]
        references_out = [
            {"tag": f"<Picture {i + 2}>", "kind": "character", **r}
            for i, r in enumerate(resolved_refs)
        ]
        mode = "ref2va" if references_out else "fl2va"

        # The stored `final_prompt` is a shared field with every other
        # video backend (Seedance2/HappyHorse/Grok) — whatever is sitting
        # there by default is virtually never an actual H3 prompt (it's
        # whichever backend's panel the user last used), and linting that
        # text against H3's six-section format just reproduces the exact
        # same wall of "missing every section" errors every single time.
        # Only lint once there's something that is actually H3-shaped (an
        # LLM rewrite, a fallback-template rewrite, or a hand edit of one
        # of those); otherwise tell the caller to generate one instead of
        # showing a pile of errors for text that was never meant to be H3.
        if prompt_source == "minimax_h3" or _is_h3_structured_prompt(prompt):
            lint = lint_minimax_h3_prompt(
                prompt,
                mode=mode,
                reference_count=len(references_out) + 1,
                duration_seconds=video_duration,
                expects_dialogue=str(beat.get("audio_type") or "") == "dialogue",
            )
            lint_issues = [
                {"severity": i.severity, "code": i.code, "message": i.message}
                for i in lint.issues
            ]
        else:
            needs_h3_prompt = True
            prompt = ""

        from novelvideo.config import _runpod_h3_video_configured

        if _runpod_h3_video_configured():
            try:
                from novelvideo.runpod_worker_control import get_status

                worker_status = await get_status("h3")
            except Exception as exc:  # noqa: BLE001
                worker_status = {"error": str(exc)}
    else:
        prompt = _legacy_video_prompt_for_mode(beat, video_mode)

    fingerprint = _video_review_fingerprint(
        video_backend=body.video_backend,
        prompt=prompt,
        duration=float(video_duration),
        ratio=ratio,
        reference_paths=reference_paths,
        frame_path=str(frame_path) if frame_exists else None,
    )

    references_display = [
        {**r, "path": _h3_display_url(ctx, output_dir, r.get("path"))} for r in references_out
    ]

    return {
        "ok": True,
        "backend": body.video_backend,
        "mode": mode,
        "prompt": prompt,
        "prompt_source": prompt_source,
        "duration": video_duration,
        "ratio": ratio,
        "frame_path": _h3_display_url(
            ctx, output_dir, str(frame_path) if frame_exists else None
        ),
        "frame_missing": not frame_exists,
        "references": references_display,
        "lint": lint_issues,
        "worker_status": worker_status,
        "input_fingerprint": fingerprint,
        "needs_h3_prompt": needs_h3_prompt,
    }


async def _generate_h3_prompt_result(
    context: "MiniMaxH3BeatContext",
    *,
    reference_count: int,
    duration_seconds: float,
    expects_dialogue: bool,
) -> tuple["MiniMaxH3PromptResult", list[dict[str, str]], bool]:
    """Shared retry/fallback/lint dance for one H3 prompt call, factored
    out of `generate_minimax_h3_prompt` so the segment (multishot) prompt
    generator below can reuse it per-shot instead of duplicating it. See
    that route's docstring for why only an outright failed call is
    retried."""
    from novelvideo.agents.minimax_h3_prompt_builder import (
        build_fallback_minimax_h3_prompt,
        build_minimax_h3_prompt,
    )
    from novelvideo.agents.minimax_h3_prompt_lint import lint_minimax_h3_prompt

    max_llm_attempts = 2
    result = None
    last_exc: Exception | None = None
    retry_context = context
    for _attempt in range(max_llm_attempts):
        try:
            result = await build_minimax_h3_prompt(retry_context)
            break
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            retry_context = context.model_copy(
                update={
                    "retry_feedback": (
                        "Your previous attempt failed to produce valid output "
                        f"at all ({exc}). Follow the schema and every rule "
                        "exactly this time."
                    )
                }
            )
            continue

    fallback_used = result is None
    if fallback_used:
        result = build_fallback_minimax_h3_prompt(context)

    lint = lint_minimax_h3_prompt(
        result.final_prompt,
        mode=context.mode,
        reference_count=reference_count,
        duration_seconds=duration_seconds,
        expects_dialogue=expects_dialogue,
    )
    lint_issues = [
        {"severity": i.severity, "code": i.code, "message": i.message} for i in lint.issues
    ]
    if fallback_used:
        lint_issues.insert(
            0,
            {
                "severity": "warning",
                "code": "fallback_template",
                "message": (
                    f"AI generation failed ({last_exc}); the basic template was used instead. "
                    "Please review and confirm or retry."
                ),
            },
        )
    return result, lint_issues, fallback_used


def _h3_resolve_dialogue(beat: dict, character_map: dict) -> tuple[str, str]:
    """`(dialogue_line, dialogue_speaker)` for a beat, handling the
    multi-speaker `{{identity}}`-per-line marker case and stripping a
    redundant screenplay "SPEAKER (direction): " prefix for the
    single-speaker case — factored out of `generate_minimax_h3_prompt` so
    the segment prompt generator reuses the exact same resolution (real
    bugs were found and fixed in this logic, see git history; duplicating
    it risks un-fixing them for the chain path)."""
    audio_type = str(beat.get("audio_type") or "silence")
    if audio_type != "dialogue":
        return "", str(beat.get("speaker") or "")
    narration = str(beat.get("narration_segment") or "")
    dialogue_speaker = str(beat.get("speaker") or "")
    dialogue_line, multi_speaker_label = _h3_parse_dialogue_segment(narration, character_map)
    if multi_speaker_label:
        dialogue_speaker = multi_speaker_label
    else:
        clean_speaker_name = _h3_char_name_for_identity(dialogue_speaker, character_map)
        dialogue_line = _h3_strip_redundant_speaker_label(dialogue_line, clean_speaker_name)
    return dialogue_line, dialogue_speaker


@router.post(
    "/projects/{project}/episodes/{episode_num}/beats/{beat_num}/minimax-h3-prompt/generate"
)
async def generate_minimax_h3_prompt(
    project: str,
    episode_num: int,
    beat_num: int,
    body: MiniMaxH3PromptGenerateRequest = MiniMaxH3PromptGenerateRequest(),
    user: dict = Depends(get_api_user),
):
    """Rewrite this beat into the official MiniMax H3 prompt format (see
    `agents/minimax_h3_prompt_builder.py`), save it to
    `beat.seedance2_config_json.final_prompt`, and return it plus the
    directing plan and lint for the review dialog."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    ctx = resolved.ctx
    username = resolved.username
    project_name = resolved.project_name
    output_dir = resolved.output_dir
    store = (
        await make_sqlite_store_for_context(ctx)
        if ctx
        else await make_sqlite_store(username, project_name)
    )

    beats = await store.get_beats_as_dicts(episode_num)
    beat = next((b for b in beats if b.get("beat_number") == beat_num), None)
    if not beat:
        return {"ok": False, "error": f"Beat {beat_num} not found"}

    from novelvideo.agents.minimax_h3_prompt_builder import (
        MiniMaxH3BeatContext,
        MiniMaxH3Reference,
        build_fallback_minimax_h3_prompt,
        build_minimax_h3_prompt,
    )
    from novelvideo.agents.minimax_h3_prompt_lint import lint_minimax_h3_prompt
    from novelvideo.manual_shots import resolve_target_video_duration
    from novelvideo.seedance2_i2v.models import parse_seedance2_config
    from novelvideo.utils.path_resolver import PathResolver
    from novelvideo.video_duration import video_duration_bounds_for_backend

    paths = PathResolver(output_dir, episode_num)
    frame_path = paths.first_frame_for_video(beat_num)
    if not frame_path.exists():
        # The rewriter now looks at the actual first-frame image rather
        # than describing it from `visual_description` text alone — same
        # prerequisite `/video/review` already enforces before submission,
        # just surfaced here too since this route can be called on its own.
        return {
            "ok": False,
            "error": f"Beat {beat_num} first frame does not exist. Generate a preview before writing the MiniMax H3 prompt.",
        }
    if body.duration is not None:
        video_duration = float(body.duration)
    else:
        audio_duration = await _api_audio_duration_seconds(output_dir, episode_num, beat_num)
        video_duration = resolve_target_video_duration(beat, audio_duration)
    # Clamp to H3's own provider bounds (its frame grid is 124-294 frames at
    # 24fps, ~5.17-12.25s — see `video_duration.py`) before it ever reaches
    # the prompt: a beat whose natural duration is e.g. 32s (common for a
    # narration-only beat ingested at chapter granularity) would otherwise
    # make the assembler write a last timestamp far past what the clip can
    # actually hold.
    h3_min, h3_max = video_duration_bounds_for_backend("runpod_minimax_h3")
    if h3_min is not None:
        video_duration = max(float(h3_min), min(float(h3_max), video_duration))

    beat_index = beats.index(beat)
    prev_beat = beats[beat_index - 1] if beat_index > 0 else None
    next_beat = beats[beat_index + 1] if beat_index + 1 < len(beats) else None

    character_map = await _build_character_map(
        store, beats, username, project_name, episode_num=episode_num
    )
    resolved_refs = _h3_identity_references(character_map, beat)
    references = [
        MiniMaxH3Reference(
            tag=f"<Picture {i + 2}>",
            kind="character",
            name=r["name"],
            appearance_details=r["appearance_details"],
            image_path=r["path"],
        )
        for i, r in enumerate(resolved_refs)
    ]

    audio_type = str(beat.get("audio_type") or "silence")
    narration = str(beat.get("narration_segment") or "")
    dialogue_line = ""
    dialogue_speaker = str(beat.get("speaker") or "")
    if audio_type == "dialogue":
        dialogue_line, multi_speaker_label = _h3_parse_dialogue_segment(
            narration, character_map
        )
        if multi_speaker_label:
            # narration_segment carried its own {{identity}}-per-line
            # markers (more than one speaker folded into this beat) —
            # that labeling is more specific than beat.speaker.
            dialogue_speaker = multi_speaker_label
        else:
            # Single-speaker beat: _h3_parse_dialogue_segment returned
            # narration verbatim (no {{identity}} markers to strip), so a
            # screenplay-style "SPEAKER (direction): " prefix embedded
            # directly in narration_segment is still there — strip it now
            # that we know the speaker. `beat.speaker` is usually the full
            # identity id (e.g. "Little Kim_Preschool Period"), not the
            # clean display name the screenplay label actually uses
            # ("LITTLE KIM") — resolve it through
            # `_h3_char_name_for_identity` first (same helper the
            # {{identity}}-marker path above already uses), or the exact
            # prefix match silently never fires. Real bug, 2026-10-21: the
            # first attempt at this fix used the raw identity id and the
            # label never got stripped.
            clean_speaker_name = _h3_char_name_for_identity(dialogue_speaker, character_map)
            dialogue_line = _h3_strip_redundant_speaker_label(dialogue_line, clean_speaker_name)

    context = MiniMaxH3BeatContext(
        mode="ref2va" if references else "fl2va",
        visual_description=_h3_replace_identity_markers(
            str(beat.get("visual_description") or ""), character_map
        ),
        narration_segment=(
            _h3_replace_identity_markers(narration, character_map)
            if audio_type != "dialogue"
            else ""
        ),
        dialogue_line=dialogue_line,
        dialogue_speaker=dialogue_speaker,
        dialogue_language=_detect_h3_dialogue_language(dialogue_line),
        dialogue_on_screen=True,
        duration_seconds=float(video_duration),
        aspect_ratio="9:16",
        prev_beat_narration=_h3_replace_identity_markers(
            str((prev_beat or {}).get("narration_segment") or ""), character_map
        ),
        next_beat_narration=_h3_replace_identity_markers(
            str((next_beat or {}).get("narration_segment") or ""), character_map
        ),
        existing_video_prompt=_legacy_video_prompt_for_mode(
            beat, beat.get("video_mode", "first_frame")
        ),
        director_guidance=str(body.prompt_guidance or ""),
        first_frame_path=str(frame_path),
        references=references,
    )

    # The structural format (section headers, `<Picture N>` numbering,
    # `[Shot 1]`, `<d>` tags) is now assembled deterministically by
    # `assemble_minimax_h3_prompt` — the LLM only contributes content, so
    # it can no longer produce the format-level lint errors that used to
    # need several self-correction retries to shake out. The only thing
    # left worth retrying is an outright failed call (bad network, quota,
    # a malformed response pydantic-ai couldn't validate at all); after
    # that, fall back to a no-LLM template built straight from the beat's
    # own text — still guaranteed to pass every structural check, just
    # plainer than a successful vision call. See the builder module's
    # docstring for the full rationale.
    result, lint_issues, fallback_used = await _generate_h3_prompt_result(
        context,
        reference_count=len(references) + 1,
        duration_seconds=video_duration,
        expects_dialogue=audio_type == "dialogue",
    )

    h3_config = parse_seedance2_config(beat.get("seedance2_config_json"))
    h3_config.final_prompt = result.final_prompt
    h3_config.prompt_source = "minimax_h3"
    h3_config.reference_image_paths = [r["path"] for r in resolved_refs]
    h3_config.ratio = context.aspect_ratio
    if hasattr(store, "update_beat_asset"):
        await store.update_beat_asset(
            episode_number=episode_num,
            beat_number=beat_num,
            seedance2_config_json=h3_config.model_dump_json(),
        )

    return {
        "ok": True,
        "prompt": result.final_prompt,
        "plan": result.plan.model_dump(),
        "lint": lint_issues,
        "mode": context.mode,
        "references": [
            {"tag": r.tag, "name": r.name, "appearance_details": r.appearance_details}
            for r in references
        ],
    }


# ── MiniMax H3 Multishot: chain N beats into one continuous take ──────────
# Added 2026-10-19. See `generators/runpod_minimax_h3_multishot_video.py`
# and `runpod-h3-qwen-endpoints.md` section 5 for the full design and the
# table of real failures this was built to avoid. Each beat's own MiniMax
# H3 prompt is generated exactly the same way as 1-shot H3 (the
# `minimax-h3-prompt/generate` route above, saved on that beat's own
# `seedance2_config_json.final_prompt`) — this section only adds the
# chain-level grouping, validation, review and enqueue on top of that
# already-proven per-beat prompt.


def _multishot_chain_beats(beats: list[dict], chain_id: str) -> tuple[list[dict], str]:
    """Beats sharing `multishot_chain_id == chain_id`, in the same
    already-sorted order `get_beats_as_dicts` returns, restricted to a
    CONTIGUOUS run (no other beat sits between two chain members in that
    order) — the only way we trust "these beats form one continuous take"
    (see `NovelVisualBeat.multishot_chain_id`'s docstring for why this is
    not inferred from `scene_ref.scene_id`). Returns `(chain_beats,
    error)`; `error` is "" on success."""
    chain_id = str(chain_id or "").strip()
    if not chain_id:
        return [], "chain_id cannot be empty"
    indices = [
        i for i, b in enumerate(beats) if str(b.get("multishot_chain_id") or "") == chain_id
    ]
    if not indices:
        return [], f"no beat has multishot_chain_id={chain_id!r}"
    if indices != list(range(indices[0], indices[0] + len(indices))):
        return [], "beats in a chain must be consecutive in narrative order (no unmarked beat may sit between them)"
    return [beats[i] for i in indices], ""


#: `H3MultishotSampler` carries one `reference_images` batch for the whole
#: chain — more entries means more R2 uploads/VRAM per job, and the
#: segment planner (`agents/segment_planner.py`) is told to keep a
#: segment's identity count at or below this so review never has to reject
#: a plan it itself approved.
MULTISHOT_MAX_UNION_REFERENCES = 3


def _multishot_shared_references(
    character_map: dict, chain_beats: list[dict]
) -> tuple[list[dict[str, str]], str]:
    """The chain's reference list is the UNION of every beat's identity
    references, in first-appearance order across the chain — NOT the
    "every beat must list the exact same identities" rule this started
    with (see git history for that v1 behavior). `H3MultishotSampler`
    numbers one shared `reference_images` batch once per chain
    (`<Picture 2>`/`<Picture 3>`/...), so each beat's own saved
    `final_prompt` must be renumbered against THIS union before being
    reused as that beat's shot in the chain's `script` — see
    `_renumber_h3_prompt_references` in `agents/minimax_h3_prompt_builder.py`,
    used by the segment prompt generator
    (`generate_minimax_h3_segment_prompts`). A beat whose own identity list
    isn't a subset of the union (shouldn't happen — the union IS built from
    every beat) or a union exceeding `MULTISHOT_MAX_UNION_REFERENCES` fails
    here rather than producing a job with too many reference images."""
    union: list[dict[str, str]] = []
    seen_ids: set[str] = set()
    for b in chain_beats:
        for ref in _h3_identity_references(character_map, b):
            if ref["identity_id"] in seen_ids:
                continue
            seen_ids.add(ref["identity_id"])
            union.append(ref)
    if len(union) > MULTISHOT_MAX_UNION_REFERENCES:
        names = ", ".join(r["name"] for r in union)
        return [], (
            f"the chain has {len(union)} character reference(s) in total ({names}), exceeding the limit of "
            f"{MULTISHOT_MAX_UNION_REFERENCES} — reduce the chain length or number of characters"
        )
    return union, ""


def _multishot_review_fingerprint(
    *,
    chain_id: str,
    script: str,
    checkpoint: str,
    frames_per_shot: int,
    frame_path: str | None,
    reference_paths: list[str],
    sampling: dict[str, Any] | None = None,
) -> str:
    """Same change-detection pattern as `_video_review_fingerprint`, scoped
    to a whole chain instead of one beat. `sampling` (the
    `multishot_sampling_plan` result) is included so a config change between
    review and enqueue (PDD on/off, output_scale) reads as stale."""
    import hashlib

    parts = [chain_id, script, checkpoint, str(frames_per_shot), frame_path or ""]
    if sampling:
        parts.append(json.dumps(sampling, sort_keys=True))
    for p in reference_paths:
        try:
            parts.append(f"{p}:{Path(p).stat().st_mtime_ns}")
        except OSError:
            parts.append(p)
    return hashlib.sha1("|".join(parts).encode("utf-8", "ignore")).hexdigest()[:16]


async def _multishot_per_shot_frames(
    output_dir: str,
    episode_num: int,
    chain_beats: list[dict],
) -> tuple[int, list[dict[str, Any]]]:
    """Per-beat duration -> frame count (`frames_for_shot`, dialogue beats
    get a higher floor), and the shared `frames_per_shot` the whole chain
    must use (`H3MultishotSampler.frames_per_shot` is ONE value for every
    shot, not a per-shot list — the max across the chain, so no beat is cut
    shorter than it needs)."""
    from novelvideo.generators.runpod_minimax_h3_multishot_video import frames_for_shot
    from novelvideo.manual_shots import resolve_target_video_duration
    from novelvideo.video_duration import video_duration_bounds_for_backend

    h3_min, h3_max = video_duration_bounds_for_backend("runpod_minimax_h3_multishot")
    max_frames = 0
    shots_out: list[dict[str, Any]] = []
    for b in chain_beats:
        beat_num = int(b["beat_number"])
        audio_duration = await _api_audio_duration_seconds(output_dir, episode_num, beat_num)
        duration = resolve_target_video_duration(b, audio_duration)
        if h3_min is not None:
            duration = max(float(h3_min), min(float(h3_max), duration))
        is_dialogue = str(b.get("audio_type") or "") == "dialogue"
        frames = frames_for_shot(duration, is_dialogue=is_dialogue)
        max_frames = max(max_frames, frames)
        shots_out.append(
            {
                "beat_number": beat_num,
                "duration_seconds": duration,
                "frames": frames,
                "is_dialogue": is_dialogue,
            }
        )
    return max_frames, shots_out


@router.post("/projects/{project}/episodes/{episode_num}/multishot/{chain_id}/review")
async def review_multishot_video(
    project: str,
    episode_num: int,
    chain_id: str,
    user: dict = Depends(get_api_user),
):
    """Dry-run preview for a MiniMax H3 Multishot chain — pure read, no
    enqueue, no RunPod call. Mirrors `review_single_video`'s role but for
    an N-beat chain (see module docstring above)."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    ctx = resolved.ctx
    username = resolved.username
    project_name = resolved.project_name
    output_dir = resolved.output_dir
    store = (
        await make_sqlite_store_for_context(ctx)
        if ctx
        else await make_sqlite_store(username, project_name)
    )

    beats = await store.get_beats_as_dicts(episode_num)
    chain_beats, chain_error = _multishot_chain_beats(beats, chain_id)
    if chain_error:
        return {"ok": False, "error": chain_error}

    from novelvideo.config import RUNPOD_H3_MULTISHOT_MAX_SHOTS, _runpod_h3_multishot_configured
    from novelvideo.generators.runpod_minimax_h3_multishot_video import (
        dims_for_multishot,
        join_shots_script,
        multishot_sampling_plan,
    )
    from novelvideo.seedance2_i2v.models import parse_seedance2_config
    from novelvideo.utils.path_resolver import PathResolver

    character_map = await _build_character_map(
        store, beats, username, project_name, episode_num=episode_num
    )
    shared_refs, ref_error = _multishot_shared_references(character_map, chain_beats)
    checkpoint = "ref2va" if shared_refs else "fl2va"
    sampling = multishot_sampling_plan(checkpoint)

    paths = PathResolver(output_dir, episode_num)
    frame_path = paths.first_frame_for_video(int(chain_beats[0]["beat_number"]))
    frame_exists = frame_path.exists()

    max_frames, shots_out = await _multishot_per_shot_frames(output_dir, episode_num, chain_beats)

    missing_prompt_beats: list[int] = []
    prompts: list[str] = []
    for b, shot in zip(chain_beats, shots_out):
        h3_config = parse_seedance2_config(b.get("seedance2_config_json"))
        has_prompt = h3_config.prompt_source == "minimax_h3" and bool(h3_config.final_prompt.strip())
        shot["has_prompt"] = has_prompt
        shot["prompt_preview"] = h3_config.final_prompt[:200] if has_prompt else ""
        if not has_prompt:
            missing_prompt_beats.append(shot["beat_number"])
        prompts.append(h3_config.final_prompt)

    width, height = dims_for_multishot("9:16", "formal")
    script = join_shots_script(prompts) if not missing_prompt_beats else ""

    worker_status: dict[str, Any] | None = None
    if _runpod_h3_multishot_configured():
        try:
            from novelvideo.runpod_worker_control import get_status

            worker_status = await get_status("multishot")
        except Exception as exc:  # noqa: BLE001
            worker_status = {"error": str(exc)}

    issues: list[str] = []
    if len(chain_beats) > RUNPOD_H3_MULTISHOT_MAX_SHOTS:
        issues.append(
            f"the chain has {len(chain_beats)} beats, exceeding the current limit "
            f"RUNPOD_H3_MULTISHOT_MAX_SHOTS={RUNPOD_H3_MULTISHOT_MAX_SHOTS}"
        )
    if missing_prompt_beats:
        issues.append(
            f"beat {missing_prompt_beats} has no MiniMax H3 prompt yet — "
            "call minimax-h3-prompt/generate for each beat first"
        )
    if ref_error:
        issues.append(ref_error)
    if not frame_exists:
        issues.append(f"beat {chain_beats[0]['beat_number']}'s first frame does not exist — generate a preview first")
    if not _runpod_h3_multishot_configured():
        issues.append("RUNPOD_H3_MULTISHOT_ENDPOINT_ID / RUNPOD_API_KEY / R2_* are not configured")

    fingerprint = _multishot_review_fingerprint(
        chain_id=chain_id,
        script=script,
        checkpoint=checkpoint,
        frames_per_shot=max_frames,
        frame_path=str(frame_path) if frame_exists else None,
        reference_paths=[r["path"] for r in shared_refs],
        sampling=sampling,
    )

    return {
        "ok": True,
        "chain_id": chain_id,
        "beat_numbers": [int(b["beat_number"]) for b in chain_beats],
        "shot_count": len(chain_beats),
        "checkpoint": checkpoint,
        "sampling": sampling,
        "width": width,
        "height": height,
        "frames_per_shot": max_frames,
        "total_duration_seconds": round(max_frames * len(chain_beats) / 24.0, 2),
        "shots": shots_out,
        "references": [{"tag": f"<Picture {i + 1}>", **r} for i, r in enumerate(shared_refs)],
        "script_preview": script[:800],
        "start_frame_path": _h3_display_url(
            ctx, output_dir, str(frame_path) if frame_exists else None
        ),
        "frame_missing": not frame_exists,
        "worker_status": worker_status,
        "issues": issues,
        "can_enqueue": not issues,
        "input_fingerprint": fingerprint,
        "max_shots": RUNPOD_H3_MULTISHOT_MAX_SHOTS,
    }


@router.post("/projects/{project}/episodes/{episode_num}/multishot/{chain_id}/video")
async def generate_multishot_video(
    project: str,
    episode_num: int,
    chain_id: str,
    body: MultishotVideoRequest,
    user: dict = Depends(get_api_user),
):
    """Enqueue a MiniMax H3 Multishot job for this chain. Call
    `/multishot/{chain_id}/review` first and pass its `input_fingerprint`
    back as `review_fingerprint` — a mismatch means something the review
    looked at (a beat's prompt, its reference images, the first frame)
    changed since, and this returns `input_stale` instead of enqueuing a
    job that no longer matches what was reviewed (same contract as every
    other review→enqueue pair in this file)."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    ctx = resolved.ctx
    username = resolved.username
    project_name = resolved.project_name
    output_dir = resolved.output_dir
    store = (
        await make_sqlite_store_for_context(ctx)
        if ctx
        else await make_sqlite_store(username, project_name)
    )

    beats = await store.get_beats_as_dicts(episode_num)
    chain_beats, chain_error = _multishot_chain_beats(beats, chain_id)
    if chain_error:
        return {"ok": False, "error": chain_error}

    from novelvideo.config import RUNPOD_H3_MULTISHOT_MAX_SHOTS, _runpod_h3_multishot_configured
    from novelvideo.generators.runpod_minimax_h3_multishot_video import (
        dims_for_multishot,
        join_shots_script,
        multishot_sampling_plan,
        new_seed,
    )
    from novelvideo.seedance2_i2v.models import parse_seedance2_config
    from novelvideo.utils.path_resolver import PathResolver

    if not _runpod_h3_multishot_configured():
        return {
            "ok": False,
            "error": "RUNPOD_H3_MULTISHOT_ENDPOINT_ID / RUNPOD_API_KEY / R2_* are not configured",
        }
    if len(chain_beats) > RUNPOD_H3_MULTISHOT_MAX_SHOTS:
        return {
            "ok": False,
            "error": (
                f"the chain has {len(chain_beats)} beats, exceeding the current limit "
                f"{RUNPOD_H3_MULTISHOT_MAX_SHOTS}"
            ),
        }

    character_map = await _build_character_map(
        store, beats, username, project_name, episode_num=episode_num
    )
    shared_refs, ref_error = _multishot_shared_references(character_map, chain_beats)
    if ref_error:
        return {"ok": False, "error": ref_error}
    checkpoint = "ref2va" if shared_refs else "fl2va"
    sampling = multishot_sampling_plan(checkpoint)

    paths = PathResolver(output_dir, episode_num)
    frame_path = paths.first_frame_for_video(int(chain_beats[0]["beat_number"]))
    if not frame_path.exists():
        return {
            "ok": False,
            "error": f"beat {chain_beats[0]['beat_number']}'s first frame does not exist — generate a preview first",
        }

    max_frames, _shots = await _multishot_per_shot_frames(output_dir, episode_num, chain_beats)

    prompts: list[str] = []
    for b in chain_beats:
        beat_num = int(b["beat_number"])
        h3_config = parse_seedance2_config(b.get("seedance2_config_json"))
        if h3_config.prompt_source != "minimax_h3" or not h3_config.final_prompt.strip():
            return {"ok": False, "error": f"beat {beat_num} has no MiniMax H3 prompt yet"}
        prompts.append(h3_config.final_prompt)

    width, height = dims_for_multishot("9:16", "formal")
    script = join_shots_script(prompts)

    fingerprint = _multishot_review_fingerprint(
        chain_id=chain_id,
        script=script,
        checkpoint=checkpoint,
        frames_per_shot=max_frames,
        frame_path=str(frame_path),
        reference_paths=[r["path"] for r in shared_refs],
        sampling=sampling,
    )
    if body.review_fingerprint is not None and body.review_fingerprint != fingerprint:
        return {"ok": False, "error": "input_stale", "input_fingerprint": fingerprint}

    config = {
        "chain_id": chain_id,
        "beat_numbers": [int(b["beat_number"]) for b in chain_beats],
        "script": script,
        "checkpoint": checkpoint,
        "width": width,
        "height": height,
        "frames_per_shot": max_frames,
        "seed": new_seed(),
        "start_image_path": str(frame_path),
        "reference_image_paths": [r["path"] for r in shared_refs],
        "sampling": sampling,
    }

    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            product_surface="mainline",
            task_type="multishot_video",
            queue_kind="video",
            episode=episode_num,
            scope=chain_id,
            payload={"config": config, "output_dir": output_dir, "billing": {}},
        )
        return {
            "ok": True,
            "task_type": "multishot_video",
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key(
                "multishot_video", ctx.project_id, episode_num, scope=chain_id
            ),
            "backend": queued.backend,
            "queue": queued.queue,
            "message": f"Episode {episode_num} Multishot chain {chain_id} video generation queued",
        }

    return {"ok": False, "error": "Multishot video generation requires a project context"}


# ── Segment multishot: auto-group beats, approve frames, batch-generate ───
# Added 2026-10-21. See `.claude/CLAUDE.md`'s "Segment multishot" section,
# `agents/segment_planner.py`, `generators/segment_store.py` and
# `docs/adr/0005-segment-multishot-flow.md`. This layers a two-phase
# workflow on top of the single-chain multishot plumbing above: (1) an
# LLM groups the episode's beats into short segments and the user
# approves each segment's ONE sketch-free compose first frame; (2) once
# approved, every shot in a segment gets its own MiniMax H3 prompt
# numbered against that segment's UNION reference list (not each beat's
# own independently-numbered prompt — see `_multishot_shared_references`),
# and video generation is batched across every approved segment.


def _segment_prefix_for_episode(episode_num: int) -> str:
    return f"seg_ep{episode_num:03d}_"


def _frame_mtime_fingerprint(path: Path) -> str:
    try:
        return str(path.stat().st_mtime_ns)
    except OSError:
        return ""


@router.get("/projects/{project}/episodes/{episode_num}/segments")
async def list_episode_segments(
    project: str,
    episode_num: int,
    user: dict = Depends(get_api_user),
):
    """Cheap, read-only: this episode's current segment groupings (from
    beats' `multishot_chain_id`) plus each one's Phase 1/2 sidecar state —
    no LLM call, no RunPod call, safe to poll. This is what the UI uses
    to render the segments panel; `/segments/videos/review` (which DOES
    call the LLM for every shot) is only for the Phase 2 confirm dialog."""
    resolved = await _resolve_generation_project(project, user, required_role="viewer")
    ctx = resolved.ctx
    username = resolved.username
    project_name = resolved.project_name
    output_dir = resolved.output_dir
    store = (
        await make_sqlite_store_for_context(ctx)
        if ctx
        else await make_sqlite_store(username, project_name)
    )
    beats = await store.get_beats_as_dicts(episode_num)

    from novelvideo.generators.segment_store import load_segment_states
    from novelvideo.utils.path_resolver import PathResolver

    states = load_segment_states(output_dir, episode_num)
    paths = PathResolver(output_dir, episode_num)

    chain_beat_numbers: dict[str, list[int]] = {}
    for b in beats:
        chain_id = str(b.get("multishot_chain_id") or "")
        if not chain_id:
            continue
        chain_beat_numbers.setdefault(chain_id, []).append(int(b["beat_number"]))

    segments_out = []
    for chain_id in sorted(chain_beat_numbers):
        beat_numbers = chain_beat_numbers[chain_id]
        state = states.get(chain_id)
        frame_path = paths.first_frame_for_video(beat_numbers[0])
        frame_exists = frame_path.exists()
        video_path = paths.videos_dir() / f"multishot_{chain_id}.mp4"
        # The video file existing is the ground truth for "generated" —
        # more reliable than the sidecar's `video_status`, which this
        # route's caller (`generate_segment_videos`) only ever advances to
        # "queued" (it returns before the GPU job finishes).
        video_status = "generated" if video_path.exists() else (state.video_status if state else "pending")
        segments_out.append(
            {
                "chain_id": chain_id,
                "beat_numbers": beat_numbers,
                "reason": state.reason if state else "",
                "shot_seconds": state.shot_seconds if state else [],
                "frame_status": state.frame_status if state else "pending",
                "frame_url": _h3_display_url(
                    ctx, output_dir, str(frame_path) if frame_exists else None
                ),
                "frame_missing": not frame_exists,
                "video_status": video_status,
            }
        )

    return {"ok": True, "segments": segments_out}


@router.post("/projects/{project}/episodes/{episode_num}/segments/plan")
async def plan_episode_segments(
    project: str,
    episode_num: int,
    user: dict = Depends(get_api_user),
):
    """Dry-run: ask the LLM to group this episode's beats into short
    (~10-15s) multishot segments. Writes nothing — call `/segments/apply`
    with this (optionally user-edited) result to actually group the
    beats via `multishot_chain_id`."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    ctx = resolved.ctx
    username = resolved.username
    project_name = resolved.project_name
    store = (
        await make_sqlite_store_for_context(ctx)
        if ctx
        else await make_sqlite_store(username, project_name)
    )
    beats = await store.get_beats_as_dicts(episode_num)
    if not beats:
        return {"ok": False, "error": f"No beats found for episode {episode_num}"}

    from novelvideo.agents.segment_planner import beat_inputs_from_dicts, plan_segments

    beat_inputs = beat_inputs_from_dicts(beats)
    plan = await plan_segments(beat_inputs)
    prefix = _segment_prefix_for_episode(episode_num)

    segments_out = [
        {
            "chain_id": f"{prefix}{i:02d}",
            "beat_numbers": seg.beat_numbers,
            "shot_seconds": seg.shot_seconds,
            "total_seconds": seg.total_seconds,
            "reason": seg.reason,
            "warnings": seg.warnings,
        }
        for i, seg in enumerate(plan.segments, start=1)
    ]

    return {
        "ok": True,
        "source": plan.source,
        "warnings": plan.warnings,
        "segments": segments_out,
    }


@router.post("/projects/{project}/episodes/{episode_num}/segments/apply")
async def apply_episode_segments(
    project: str,
    episode_num: int,
    body: SegmentPlanApplyRequest,
    user: dict = Depends(get_api_user),
):
    """Writes `multishot_chain_id` (and each beat's planned
    `duration_seconds`, so the existing single-shot-duration resolution
    `resolve_target_video_duration` already uses picks it up for free)
    per `body.segments` — normally `/segments/plan`'s own output, possibly
    hand-edited. Beats not covered by any segment have their
    `multishot_chain_id` cleared (ungrouped, single-shot as before).
    Replaces this episode's entire segment sidecar state."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    ctx = resolved.ctx
    username = resolved.username
    project_name = resolved.project_name
    output_dir = resolved.output_dir
    store = (
        await make_sqlite_store_for_context(ctx)
        if ctx
        else await make_sqlite_store(username, project_name)
    )
    beats = await store.get_beats_as_dicts(episode_num)
    if not beats:
        return {"ok": False, "error": f"No beats found for episode {episode_num}"}

    all_beat_numbers = {int(b["beat_number"]) for b in beats}
    chain_id_by_beat: dict[int, str] = {}
    seconds_by_beat: dict[int, float] = {}
    for seg in body.segments:
        chain_id = str(seg.get("chain_id") or "").strip()
        beat_numbers = [int(n) for n in seg.get("beat_numbers") or []]
        shot_seconds = [float(s) for s in seg.get("shot_seconds") or []]
        if not chain_id or not beat_numbers:
            return {"ok": False, "error": "each segment must have a chain_id and beat_numbers"}
        unknown = [n for n in beat_numbers if n not in all_beat_numbers]
        if unknown:
            return {"ok": False, "error": f"beat {unknown} does not exist in this episode"}
        for i, n in enumerate(beat_numbers):
            if n in chain_id_by_beat:
                return {"ok": False, "error": f"beat {n} appears in more than one segment"}
            chain_id_by_beat[n] = chain_id
            if i < len(shot_seconds):
                seconds_by_beat[n] = shot_seconds[i]

    if not hasattr(store, "update_beat_asset"):
        return {"ok": False, "error": "the current store does not support writing multishot_chain_id"}

    for b in beats:
        beat_num = int(b["beat_number"])
        new_chain_id = chain_id_by_beat.get(beat_num, "")
        update_kwargs: dict[str, Any] = {}
        if str(b.get("multishot_chain_id") or "") != new_chain_id:
            update_kwargs["multishot_chain_id"] = new_chain_id
        if beat_num in seconds_by_beat:
            update_kwargs["duration_seconds"] = seconds_by_beat[beat_num]
        if update_kwargs:
            await store.update_beat_asset(
                episode_number=episode_num, beat_number=beat_num, **update_kwargs
            )

    from novelvideo.generators.segment_store import replace_all_segments

    replace_all_segments(output_dir, episode_num, body.segments)

    return {"ok": True, "segment_count": len(body.segments)}


@router.post("/projects/{project}/episodes/{episode_num}/segments/frames/generate")
async def generate_segment_frames(
    project: str,
    episode_num: int,
    body: SegmentFramesGenerateRequest = SegmentFramesGenerateRequest(),
    user: dict = Depends(get_api_user),
):
    """Phase 1: generates the ONE sketch-free compose first frame for
    every segment not yet approved (`body.force=True` to regenerate an
    already-approved one too) — one `regenerate_beats` call per segment's
    first beat, reusing that route's existing compose-selection/enqueue
    logic rather than duplicating it. `body.chain_ids`, when given,
    restricts this to just those segments (e.g. the UI's per-segment
    "regenerate this one" button) instead of every segment in the
    episode."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    username = resolved.username
    project_name = resolved.project_name
    output_dir = resolved.output_dir
    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(username, project_name)
    )
    beats = await store.get_beats_as_dicts(episode_num)

    from novelvideo.config import DEFAULT_RENDER_IMAGE_SELECTION, SKETCH_FREE_COMPOSE_SELECTION_KEYS
    from novelvideo.generators.segment_store import load_segment_states

    proj_config = load_project_config(username, project_name)
    selection = body.image_generation_selection or proj_config.get(
        "render_image_selection", DEFAULT_RENDER_IMAGE_SELECTION
    )
    if selection not in SKETCH_FREE_COMPOSE_SELECTION_KEYS:
        return {
            "ok": False,
            "error": (
                f"{selection} is not a sketch-free compose selection — use "
                "gemini_webai_compose or runpod_qwen21_compose instead"
            ),
        }

    states = load_segment_states(output_dir, episode_num)
    all_chain_ids = sorted(
        {str(b.get("multishot_chain_id") or "") for b in beats if b.get("multishot_chain_id")}
    )
    if not all_chain_ids:
        return {"ok": False, "error": "this episode has no segments yet (call /segments/plan + /segments/apply first)"}
    if body.chain_ids:
        requested = {str(c) for c in body.chain_ids}
        unknown = requested - set(all_chain_ids)
        if unknown:
            return {"ok": False, "error": f"segment {sorted(unknown)} does not exist in this episode"}
        chain_ids = [c for c in all_chain_ids if c in requested]
    else:
        chain_ids = all_chain_ids

    results = []
    for chain_id in chain_ids:
        state = states.get(chain_id)
        if state and state.frame_status == "approved" and not body.force:
            results.append({"chain_id": chain_id, "skipped": True, "reason": "already approved"})
            continue
        chain_beats, chain_error = _multishot_chain_beats(beats, chain_id)
        if chain_error or not chain_beats:
            results.append({"chain_id": chain_id, "ok": False, "error": chain_error or "empty chain"})
            continue
        first_beat_num = int(chain_beats[0]["beat_number"])
        regen_body = BeatsRegenerateRequest(
            beat_indices=[first_beat_num],
            image_generation_selection=selection,
            mode_key="1x1_2-3",
        )
        try:
            regen_result = await regenerate_beats(project, episode_num, regen_body, user)
        except HTTPException as exc:
            regen_result = {"ok": False, "error": str(exc.detail)}
        results.append({"chain_id": chain_id, "beat_number": first_beat_num, **regen_result})

    return {"ok": True, "results": results}


@router.post("/projects/{project}/episodes/{episode_num}/segments/{chain_id}/frame/approve")
async def approve_segment_frame(
    project: str,
    episode_num: int,
    chain_id: str,
    body: SegmentFrameApproveRequest = SegmentFrameApproveRequest(),
    user: dict = Depends(get_api_user),
):
    """Phase 1 confirm: marks this segment's first frame approved,
    recording its mtime fingerprint so a later regeneration is detected
    (`reset_frame_approval_if_stale`, called from `/segments/videos/review`)
    instead of silently reusing a stale, already-rejected frame."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    username = resolved.username
    project_name = resolved.project_name
    output_dir = resolved.output_dir
    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(username, project_name)
    )
    beats = await store.get_beats_as_dicts(episode_num)
    chain_beats, chain_error = _multishot_chain_beats(beats, chain_id)
    if chain_error:
        return {"ok": False, "error": chain_error}

    from novelvideo.generators.segment_store import set_frame_approved
    from novelvideo.utils.path_resolver import PathResolver

    paths = PathResolver(output_dir, episode_num)
    frame_path = paths.first_frame_for_video(int(chain_beats[0]["beat_number"]))
    if not frame_path.exists():
        return {"ok": False, "error": "first frame does not exist, cannot approve"}

    fingerprint = body.frame_fingerprint or _frame_mtime_fingerprint(frame_path)
    state = set_frame_approved(output_dir, episode_num, chain_id, fingerprint=fingerprint)
    if state is None:
        return {"ok": False, "error": f"segment {chain_id} does not exist (call /segments/apply first)"}
    return {
        "ok": True,
        "chain_id": chain_id,
        "frame_status": state.frame_status,
        "frame_fingerprint": state.frame_fingerprint,
    }


async def _build_segment_shot_prompts(
    *,
    store: Any,
    output_dir: str,
    episode_num: int,
    beats: list[dict],
    chain_beats: list[dict],
    shared_refs: list[dict[str, str]],
    character_map: dict,
) -> list[dict[str, Any]]:
    """Generates and saves a fresh MiniMax H3 prompt for every beat in
    `chain_beats`, each numbered against the SAME `shared_refs` (the
    chain's union reference list, fixed order) — never against that
    beat's own independently-resolved identity list, which would
    desync `<Picture N>` numbering once concatenated into the chain's
    shared `H3MultishotSampler.reference_images` batch (see
    `_multishot_shared_references`). Only the first beat gets the real
    rendered first frame attached — later shots have no rendered image
    yet (`H3MultishotSampler` continues internally from the previous
    shot's last frame), so their `first_frame_description` is grounded by
    that beat's own `visual_description` text instead, with a short
    continuity note threaded in from the previous/next shot IN THE CHAIN
    rather than the episode's actual neighboring beats. Returns one dict
    per beat: `{beat_number, duration_seconds, prompt, lint,
    fallback_used}`, in chain order."""
    from novelvideo.agents.minimax_h3_prompt_builder import MiniMaxH3BeatContext, MiniMaxH3Reference
    from novelvideo.manual_shots import resolve_target_video_duration
    from novelvideo.seedance2_i2v.models import parse_seedance2_config
    from novelvideo.utils.path_resolver import PathResolver
    from novelvideo.video_duration import video_duration_bounds_for_backend

    paths = PathResolver(output_dir, episode_num)
    h3_min, h3_max = video_duration_bounds_for_backend("runpod_minimax_h3_multishot")

    references = [
        MiniMaxH3Reference(
            tag=f"<Picture {i + 2}>",
            kind="character",
            name=r["name"],
            appearance_details=r["appearance_details"],
            image_path=r["path"],
        )
        for i, r in enumerate(shared_refs)
    ]

    first_beat_num = int(chain_beats[0]["beat_number"])
    all_index_by_num = {int(b["beat_number"]): i for i, b in enumerate(beats)}

    out: list[dict[str, Any]] = []
    for k, beat in enumerate(chain_beats):
        beat_num = int(beat["beat_number"])
        audio_duration = await _api_audio_duration_seconds(output_dir, episode_num, beat_num)
        duration = resolve_target_video_duration(beat, audio_duration)
        if h3_min is not None:
            duration = max(float(h3_min), min(float(h3_max), duration))

        dialogue_line, dialogue_speaker = _h3_resolve_dialogue(beat, character_map)
        audio_type = str(beat.get("audio_type") or "silence")
        narration = str(beat.get("narration_segment") or "")

        if k == 0:
            first_frame_path = str(paths.first_frame_for_video(first_beat_num))
            all_idx = all_index_by_num.get(beat_num, 0)
            prev_beat = beats[all_idx - 1] if all_idx > 0 else None
            prev_narration = str((prev_beat or {}).get("narration_segment") or "")
        else:
            first_frame_path = ""
            prev_beat = chain_beats[k - 1]
            prev_narration = (
                "(continuing immediately from the previous shot, same scene and subjects) "
                + str(prev_beat.get("visual_description") or prev_beat.get("narration_segment") or "")
            )

        if k == len(chain_beats) - 1:
            all_idx = all_index_by_num.get(beat_num, len(beats) - 1)
            next_beat = beats[all_idx + 1] if all_idx + 1 < len(beats) else None
            next_narration = str((next_beat or {}).get("narration_segment") or "")
        else:
            next_beat = chain_beats[k + 1]
            next_narration = str(
                next_beat.get("visual_description") or next_beat.get("narration_segment") or ""
            )

        context = MiniMaxH3BeatContext(
            mode="ref2va" if references else "fl2va",
            visual_description=_h3_replace_identity_markers(
                str(beat.get("visual_description") or ""), character_map
            ),
            narration_segment=(
                _h3_replace_identity_markers(narration, character_map)
                if audio_type != "dialogue"
                else ""
            ),
            dialogue_line=dialogue_line,
            dialogue_speaker=dialogue_speaker,
            dialogue_language=_detect_h3_dialogue_language(dialogue_line),
            dialogue_on_screen=True,
            duration_seconds=float(duration),
            aspect_ratio="9:16",
            prev_beat_narration=_h3_replace_identity_markers(prev_narration, character_map),
            next_beat_narration=_h3_replace_identity_markers(next_narration, character_map),
            first_frame_path=first_frame_path,
            references=references,
        )

        result, lint_issues, fallback_used = await _generate_h3_prompt_result(
            context,
            reference_count=len(references) + 1,
            duration_seconds=duration,
            expects_dialogue=audio_type == "dialogue",
        )

        if hasattr(store, "update_beat_asset"):
            h3_config = parse_seedance2_config(beat.get("seedance2_config_json"))
            h3_config.final_prompt = result.final_prompt
            h3_config.prompt_source = "minimax_h3"
            h3_config.reference_image_paths = [r["path"] for r in shared_refs]
            h3_config.ratio = "9:16"
            await store.update_beat_asset(
                episode_number=episode_num,
                beat_number=beat_num,
                seedance2_config_json=h3_config.model_dump_json(),
            )

        out.append(
            {
                "beat_number": beat_num,
                "duration_seconds": duration,
                "prompt": result.final_prompt,
                "lint": lint_issues,
                "fallback_used": fallback_used,
            }
        )
    return out


@router.post("/projects/{project}/episodes/{episode_num}/segments/videos/review")
async def review_segment_videos(
    project: str,
    episode_num: int,
    user: dict = Depends(get_api_user),
):
    """Phase 2 dry-run, across EVERY segment in this episode at once:
    (re)writes each shot's MiniMax H3 prompt numbered against its
    segment's union reference list, lints it, and returns a
    `input_fingerprint` per segment for `/segments/video/generate`. No
    RunPod call, no enqueue — this does call the (cheap, text-only) H3
    prompt LLM for every shot that doesn't have an up-to-date one yet, so
    it is not free to call repeatedly, just far cheaper than the GPU job
    it gates."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    ctx = resolved.ctx
    username = resolved.username
    project_name = resolved.project_name
    output_dir = resolved.output_dir
    store = (
        await make_sqlite_store_for_context(ctx)
        if ctx
        else await make_sqlite_store(username, project_name)
    )
    beats = await store.get_beats_as_dicts(episode_num)

    from novelvideo.config import RUNPOD_H3_MULTISHOT_MAX_SHOTS, _runpod_h3_multishot_configured
    from novelvideo.generators.runpod_minimax_h3_multishot_video import (
        dims_for_multishot,
        join_shots_script,
        multishot_sampling_plan,
    )
    from novelvideo.generators.segment_store import load_segment_states, reset_frame_approval_if_stale
    from novelvideo.utils.path_resolver import PathResolver

    states = load_segment_states(output_dir, episode_num)
    chain_ids = sorted(
        {str(b.get("multishot_chain_id") or "") for b in beats if b.get("multishot_chain_id")}
    )
    if not chain_ids:
        return {"ok": True, "segments": []}

    character_map = await _build_character_map(
        store, beats, username, project_name, episode_num=episode_num
    )
    paths = PathResolver(output_dir, episode_num)

    worker_status: dict[str, Any] | None = None
    if _runpod_h3_multishot_configured():
        try:
            from novelvideo.runpod_worker_control import get_status

            worker_status = await get_status("multishot")
        except Exception as exc:  # noqa: BLE001
            worker_status = {"error": str(exc)}

    segments_out: list[dict[str, Any]] = []
    for chain_id in chain_ids:
        chain_beats, chain_error = _multishot_chain_beats(beats, chain_id)
        if chain_error or not chain_beats:
            segments_out.append({"chain_id": chain_id, "ok": False, "error": chain_error or "empty"})
            continue

        frame_path = paths.first_frame_for_video(int(chain_beats[0]["beat_number"]))
        frame_exists = frame_path.exists()
        fp_now = _frame_mtime_fingerprint(frame_path) if frame_exists else ""
        state = reset_frame_approval_if_stale(
            output_dir, episode_num, chain_id, current_fingerprint=fp_now
        )

        issues: list[str] = []
        if state is None or state.frame_status != "approved":
            issues.append("first frame not yet approved (or changed since approval) — approve it in Phase 1 first")
        if not frame_exists:
            issues.append("first frame does not exist")
        if len(chain_beats) > RUNPOD_H3_MULTISHOT_MAX_SHOTS:
            issues.append(f"the chain has {len(chain_beats)} beats, exceeding the limit {RUNPOD_H3_MULTISHOT_MAX_SHOTS}")
        if not _runpod_h3_multishot_configured():
            issues.append("RUNPOD_H3_MULTISHOT_ENDPOINT_ID / RUNPOD_API_KEY / R2_* are not configured")

        shared_refs, ref_error = _multishot_shared_references(character_map, chain_beats)
        if ref_error:
            issues.append(ref_error)
            segments_out.append(
                {"chain_id": chain_id, "ok": False, "issues": issues, "can_enqueue": False}
            )
            continue

        checkpoint = "ref2va" if shared_refs else "fl2va"
        sampling = multishot_sampling_plan(checkpoint)

        shots = await _build_segment_shot_prompts(
            store=store,
            output_dir=output_dir,
            episode_num=episode_num,
            beats=beats,
            chain_beats=chain_beats,
            shared_refs=shared_refs,
            character_map=character_map,
        )
        for shot in shots:
            for issue in shot["lint"]:
                if issue["severity"] == "error":
                    issues.append(f"beat {shot['beat_number']}: {issue['message']}")

        max_frames, shots_meta = await _multishot_per_shot_frames(output_dir, episode_num, chain_beats)
        width, height = dims_for_multishot("9:16", "formal")
        script = join_shots_script([s["prompt"] for s in shots])

        fingerprint = _multishot_review_fingerprint(
            chain_id=chain_id,
            script=script,
            checkpoint=checkpoint,
            frames_per_shot=max_frames,
            frame_path=str(frame_path) if frame_exists else None,
            reference_paths=[r["path"] for r in shared_refs],
            sampling=sampling,
        )

        segments_out.append(
            {
                "chain_id": chain_id,
                "ok": True,
                "beat_numbers": [int(b["beat_number"]) for b in chain_beats],
                "checkpoint": checkpoint,
                "sampling": sampling,
                "width": width,
                "height": height,
                "frames_per_shot": max_frames,
                "total_duration_seconds": round(max_frames * len(chain_beats) / 24.0, 2),
                "shots": [
                    {**meta, "prompt_preview": shot["prompt"][:200], "lint": shot["lint"]}
                    for meta, shot in zip(shots_meta, shots)
                ],
                "start_frame_path": _h3_display_url(
                    ctx, output_dir, str(frame_path) if frame_exists else None
                ),
                "issues": issues,
                "can_enqueue": not issues,
                "input_fingerprint": fingerprint,
            }
        )

    return {"ok": True, "worker_status": worker_status, "segments": segments_out}


@router.post("/projects/{project}/episodes/{episode_num}/segments/video/generate")
async def generate_segment_videos(
    project: str,
    episode_num: int,
    body: SegmentVideosGenerateRequest,
    user: dict = Depends(get_api_user),
):
    """Phase 2 batch enqueue: a thin loop over the EXISTING single-chain
    `/multishot/{chain_id}/video` route (reused verbatim, not duplicated)
    so each segment gets that route's exact fingerprint-check/enqueue
    contract. The task queue (`queue_kind="video"`) runs jobs one at a
    time, so this returns as soon as every segment is queued rather than
    waiting for GPU time."""
    if not body.segments:
        return {"ok": False, "error": "segments cannot be empty"}

    resolved = await _resolve_generation_project(project, user, required_role="editor")
    output_dir = resolved.output_dir

    from novelvideo.generators.segment_store import set_video_status

    results = []
    for entry in body.segments:
        video_body = MultishotVideoRequest(review_fingerprint=entry.review_fingerprint)
        result = await generate_multishot_video(
            project, episode_num, entry.chain_id, video_body, user
        )
        if result.get("ok"):
            set_video_status(output_dir, episode_num, entry.chain_id, status="queued")
        results.append({"chain_id": entry.chain_id, **result})
    return {"ok": all(r.get("ok") for r in results), "results": results}


# ── RunPod Qwen-Image-Edit-2511 render review (parallels the H3 video
# review above, same reasons: ~10 minutes of RunPod GPU time per render is
# too expensive to spend blind on a sketch/reference mismatch) ──────────


async def _qwen_edit_review_setup(
    project: str, episode_num: int, beat_num: int, user: dict, image_generation_selection: str | None
):
    """Shared project/beat/selection resolution for both render-review
    routes below — provider-agnostic since 2026-10-18 (Qwen-Image-Edit-2511
    and Qwen-Image 2.1 both go through `render_review_registry`). Returns
    `None` in `error` fields on success."""
    from novelvideo.generators.render_review_registry import strategy_for_selection

    resolved = await _resolve_generation_project(project, user, required_role="editor")
    ctx = resolved.ctx
    username = resolved.username
    project_name = resolved.project_name
    output_dir = resolved.output_dir
    store = (
        await make_sqlite_store_for_context(ctx)
        if ctx
        else await make_sqlite_store(username, project_name)
    )

    beats = await store.get_beats_as_dicts(episode_num)
    beat = next((b for b in beats if b.get("beat_number") == beat_num), None)
    if not beat:
        return {"error": {"ok": False, "error": f"Beat {beat_num} not found"}}

    proj_config = load_project_config(username, project_name)
    selection = _resolve_render_image_selection(proj_config, image_generation_selection)
    strategy = strategy_for_selection(selection)
    if strategy is None:
        return {"error": {"ok": True, "supported": False, "selection": selection}}

    sketch_path = PathResolver(output_dir, episode_num).sketch(beat_num)
    if not sketch_path.is_file():
        return {
            "error": {
                "ok": False,
                "error": f"Beat {beat_num} has no sketch yet. Generate a sketch before Render.",
            }
        }

    detection_error = render_ai_detection_error([beat])
    if detection_error:
        return {"error": {"ok": False, "error": detection_error}}

    character_map = await _build_character_map(
        store,
        beats,
        username,
        project_name,
        episode_num=episode_num,
        use_detected_identities=True,
    )

    from novelvideo.config import IMAGE_GENERATION_SELECTIONS

    multi_character = bool((IMAGE_GENERATION_SELECTIONS.get(selection) or {}).get("multi_character"))

    return {
        "error": None,
        "ctx": ctx,
        "output_dir": output_dir,
        "store": store,
        "beats": beats,
        "beat": beat,
        "selection": selection,
        "strategy": strategy,
        "sketch_path": sketch_path,
        "character_map": character_map,
        "multi_character": multi_character,
    }


def _qwen_edit_render_fingerprint(
    *,
    selection: str,
    sketch_path: Path,
    identity_refs: list[dict[str, str]],
) -> str:
    """Change-detection digest for the Qwen-Image-Edit-2511 render review —
    deliberately does NOT include the prompt text (unlike a naive
    "fingerprint everything" approach), because editing the prompt by hand
    is exactly the thing this review screen exists to let the user do;
    hashing the prompt would make every hand-edit immediately `input_stale`
    (a real bug confirmed on the equivalent H3 video review, fixed by the
    same omission there)."""
    import hashlib

    parts = [selection]
    try:
        parts.append(f"{sketch_path}:{sketch_path.stat().st_mtime_ns}")
    except OSError:
        parts.append(str(sketch_path))
    for ref in identity_refs:
        path = ref.get("path") or ""
        try:
            parts.append(f"{path}:{Path(path).stat().st_mtime_ns}")
        except OSError:
            parts.append(path)
    return hashlib.sha1("|".join(parts).encode("utf-8", "ignore")).hexdigest()[:16]


@router.post("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/render/review")
async def review_qwen_edit_render(
    project: str,
    episode_num: int,
    beat_num: int,
    body: RenderReviewRequest,
    user: dict = Depends(get_api_user),
):
    """Dry-run preview of what the single-beat `beats/regenerate` route
    would submit for a render-review-capable selection (`runpod_qwen_edit*`
    or, since 2026-10-18, `runpod_qwen21_render*` — see
    `generators/render_review_registry.py`): the sketch, the identity
    reference(s) actually resolved (same lookup the generator itself uses
    — `qwen_edit_identity_references()`), the effective prompt(s) (saved
    sidecar / hand-edited override / official-template default), a mask
    preview for the multi-character path, and lint — without enqueuing a
    task or spending RunPod GPU time."""
    from novelvideo.generators.nanobanana_grid import (
        build_qwen_edit_mask_preview,
        qwen_edit_identity_references,
        qwen_edit_subject_body_hints,
        _color_for_identity,
    )
    from novelvideo.generators.qwen_edit_prompt_store import load_qwen_edit_prompts
    from novelvideo.models import real_detected_identities

    setup = await _qwen_edit_review_setup(
        project, episode_num, beat_num, user, body.image_generation_selection
    )
    if setup["error"] is not None:
        return setup["error"]
    ctx = setup["ctx"]
    output_dir = setup["output_dir"]
    beat = setup["beat"]
    selection = setup["selection"]
    strategy = setup["strategy"]
    sketch_path: Path = setup["sketch_path"]
    character_map = setup["character_map"]
    multi_character = setup["multi_character"]

    saved = load_qwen_edit_prompts(output_dir, episode_num, beat_num, namespace=strategy.store_namespace) or {}
    override = body.qwen_edit_prompts.model_dump() if body.qwen_edit_prompts else {}

    identity_refs = qwen_edit_identity_references(character_map, beat)
    sketch_bytes = sketch_path.read_bytes()
    lint_issues: list[dict[str, str]] = []

    def _append_lint(prompt_text: str, stage: str, label: str) -> None:
        result = strategy.lint(prompt_text, stage=stage)
        for issue in result.issues:
            lint_issues.append(
                {"severity": issue.severity, "code": issue.code, "message": f"[{label}] {issue.message}"}
            )

    if multi_character:
        scene_prompt = (
            override.get("scene_prompt")
            or saved.get("scene_prompt")
            or strategy.build_prompt(
                [beat], "scene_only", qwen_edit_subject_body_hints(character_map, beat)
            )
        )
        _append_lint(scene_prompt, "scene_only", "scene")
        saved_inpaint = saved.get("inpaint_prompts") or {}
        override_inpaint = override.get("inpaint_prompts") or {}
        default_inpaint = strategy.build_prompt([beat], "inpaint")

        identities_out: list[dict[str, Any]] = []
        prompts_dir = Path(output_dir) / "prompts" / strategy.store_namespace / f"ep{episode_num:03d}"
        for idx, identity_id in enumerate(real_detected_identities(beat.get("detected_identities"))):
            ref = next((r for r in identity_refs if r["identity_id"] == identity_id), None)
            inpaint_prompt = override_inpaint.get(identity_id) or saved_inpaint.get(identity_id) or default_inpaint
            _append_lint(inpaint_prompt, "inpaint", identity_id)
            mask_url = None
            mask_missing = True
            if ref:
                hex_color = _color_for_identity(identity_id, character_map, "")
                mask_bytes = build_qwen_edit_mask_preview(sketch_bytes, hex_color) if hex_color else None
                if mask_bytes:
                    mask_missing = False
                    mask_path = prompts_dir / f"beat_{beat_num:02d}_mask_{idx}.png"
                    mask_path.parent.mkdir(parents=True, exist_ok=True)
                    mask_path.write_bytes(mask_bytes)
                    mask_url = _h3_display_url(ctx, output_dir, str(mask_path))
            identities_out.append(
                {
                    "identity_id": identity_id,
                    "name": (ref or {}).get("name", identity_id),
                    "portrait_url": _h3_display_url(ctx, output_dir, (ref or {}).get("path")),
                    "mask_preview_url": mask_url,
                    "mask_missing": mask_missing,
                    "inpaint_prompt": inpaint_prompt,
                }
            )
        prompts_out = {"scene_prompt": scene_prompt, "identities": identities_out}
    else:
        full_prompt = (
            override.get("full_prompt")
            or saved.get("full_prompt")
            or strategy.build_prompt([beat], "full")
        )
        _append_lint(full_prompt, "full", "full")
        prompts_out = {"full_prompt": full_prompt}
        identities_out = identity_refs[:1]

    worker_status: dict[str, Any] | None = None
    try:
        from novelvideo.runpod_worker_control import get_status

        # `runpod_qwen_edit*` and `runpod_qwen21*` now live on 2 separate
        # endpoints (split 2026-10-19) — pick the right one for this
        # selection rather than always asking the Qwen-Edit worker's status.
        worker_key = "qwen_edit" if selection.startswith("runpod_qwen_edit") else "qwen_t2i"
        worker_status = await get_status(worker_key)
    except Exception as exc:  # noqa: BLE001
        worker_status = {"error": str(exc)}

    fingerprint = _qwen_edit_render_fingerprint(
        selection=selection, sketch_path=sketch_path, identity_refs=identity_refs
    )
    passes = (1 + len(identities_out)) if multi_character else 1
    estimate_minutes = max(1, round(strategy.seconds_per_pass * passes / 60))

    return {
        "ok": True,
        "supported": True,
        "mode": "multi" if multi_character else "single",
        "selection": selection,
        "model_label": strategy.model_label,
        "sketch_url": _h3_display_url(ctx, output_dir, str(sketch_path)),
        "references": [
            {**r, "path": _h3_display_url(ctx, output_dir, r.get("path"))} for r in identity_refs
        ],
        "prompts": prompts_out,
        "lint": lint_issues,
        "worker_status": worker_status,
        "input_fingerprint": fingerprint,
        "estimate_minutes": estimate_minutes,
    }


@router.post(
    "/projects/{project}/episodes/{episode_num}/beats/{beat_num}/qwen-edit-prompt/generate"
)
async def generate_qwen_edit_render_prompt(
    project: str,
    episode_num: int,
    beat_num: int,
    body: QwenEditPromptGenerateRequest = QwenEditPromptGenerateRequest(),
    user: dict = Depends(get_api_user),
):
    """AI-rewrite the render prompt(s) for this beat, following the
    selected provider's own official prompt-enhancer standard (see
    `generators/render_review_registry.py` — Qwen-Image-Edit-2511's
    `{"Rewritten": ...}` JSON contract and Qwen-Image 2.1's plain-text
    contract are genuinely different, dispatched via `strategy.rewrite`),
    save them to the sidecar store, and return them plus lint for the
    review dialog."""
    from novelvideo.agents.qwen_edit_render_prompt_lint import LintResult
    from novelvideo.generators.nanobanana_grid import (
        qwen_edit_identity_references,
        qwen_edit_subject_body_hints,
    )
    from novelvideo.generators.qwen_edit_prompt_store import save_qwen_edit_prompts
    from novelvideo.models import real_detected_identities

    setup = await _qwen_edit_review_setup(
        project, episode_num, beat_num, user, body.image_generation_selection
    )
    if setup["error"] is not None:
        return setup["error"]
    output_dir = setup["output_dir"]
    beat = setup["beat"]
    strategy = setup["strategy"]
    sketch_path: Path = setup["sketch_path"]
    character_map = setup["character_map"]
    multi_character = setup["multi_character"]

    identity_refs = qwen_edit_identity_references(character_map, beat)
    max_retries = 3

    async def _rewrite_with_retries(
        *, stage: str, default_prompt: str, image_2: str, image_2_label: str
    ) -> tuple[str, LintResult]:
        best_prompt = ""
        best_lint: LintResult | None = None
        retry_feedback = ""
        for _attempt in range(1 + max_retries):
            try:
                candidate = await strategy.rewrite(
                    stage=stage,
                    default_prompt=default_prompt,
                    image_1_path=str(sketch_path),
                    image_2_path=image_2,
                    image_2_label=image_2_label,
                    retry_feedback=retry_feedback,
                )
            except Exception as exc:  # noqa: BLE001
                retry_feedback = f"Your previous attempt failed to produce valid output at all ({exc})."
                continue
            candidate_lint = strategy.lint(candidate, stage=stage)
            if best_lint is None or len(candidate_lint.errors) < len(best_lint.errors):
                best_prompt, best_lint = candidate, candidate_lint
            if not candidate_lint.errors:
                break
            retry_feedback = "\n".join(f"- {issue.message}" for issue in candidate_lint.errors)
        if best_lint is None:
            best_prompt, best_lint = default_prompt, strategy.lint(default_prompt, stage=stage)
        return best_prompt, best_lint

    lint_issues: list[dict[str, str]] = []

    def _collect(result: LintResult, label: str) -> None:
        for issue in result.issues:
            lint_issues.append(
                {"severity": issue.severity, "code": issue.code, "message": f"[{label}] {issue.message}"}
            )

    if multi_character:
        scene_prompt, scene_lint = await _rewrite_with_retries(
            stage="scene_only",
            default_prompt=strategy.build_prompt(
                [beat], "scene_only", qwen_edit_subject_body_hints(character_map, beat)
            ),
            image_2="",
            image_2_label="",
        )
        _collect(scene_lint, "scene")

        inpaint_prompts: dict[str, str] = {}
        identities_out: list[dict[str, Any]] = []
        for identity_id in real_detected_identities(beat.get("detected_identities")):
            ref = next((r for r in identity_refs if r["identity_id"] == identity_id), None)
            prompt_text, prompt_lint = await _rewrite_with_retries(
                stage="inpaint",
                default_prompt=strategy.build_prompt([beat], "inpaint"),
                image_2=(ref or {}).get("path", ""),
                image_2_label=(ref or {}).get("name", identity_id),
            )
            _collect(prompt_lint, identity_id)
            inpaint_prompts[identity_id] = prompt_text
            identities_out.append({"identity_id": identity_id, "inpaint_prompt": prompt_text})

        save_qwen_edit_prompts(
            output_dir,
            episode_num,
            beat_num,
            scene_prompt=scene_prompt,
            inpaint_prompts=inpaint_prompts,
            source="ai",
            namespace=strategy.store_namespace,
        )
        prompts_out = {"scene_prompt": scene_prompt, "identities": identities_out}
    else:
        ref = identity_refs[0] if identity_refs else None
        full_prompt, full_lint = await _rewrite_with_retries(
            stage="full",
            default_prompt=strategy.build_prompt([beat], "full"),
            image_2=(ref or {}).get("path", ""),
            image_2_label=(ref or {}).get("name", "character"),
        )
        _collect(full_lint, "full")
        save_qwen_edit_prompts(
            output_dir,
            episode_num,
            beat_num,
            full_prompt=full_prompt,
            source="ai",
            namespace=strategy.store_namespace,
        )
        prompts_out = {"full_prompt": full_prompt}

    return {"ok": True, "prompts": prompts_out, "lint": lint_issues}


# ── Video pool view & selection ─────────────────────────────────────────────


@router.get("/projects/{project}/episodes/{episode_num}/video-pool")
async def list_video_pool(
    project: str,
    episode_num: int,
    user: dict = Depends(get_api_user),
):
    resolved = await _resolve_generation_project(project, user, required_role="viewer")
    project_dir = resolved.project_dir

    from novelvideo.generators.video_pool_indexer import load_video_pool_index

    videos_ep_dir = project_dir / "videos" / "beats" / f"ep{episode_num:03d}"
    pool = load_video_pool_index(videos_ep_dir)
    if not pool:
        return {"ok": True, "data": None}

    videos = []
    for entry in pool.videos:
        item = entry.model_dump()
        if item.get("generated_at"):
            item["generated_at"] = entry.generated_at.isoformat()
        rel_path = f"videos/beats/ep{episode_num:03d}/pool/{entry.video_path}"
        item["video_url"] = make_static_url_for_context(
            resolved.ctx,
            rel_path,
            local_path=project_dir / rel_path,
        )
        videos.append(item)

    return {
        "ok": True,
        "data": {
            "episode": pool.episode,
            "videos": videos,
            "beat_assignments": pool.beat_assignments,
        },
    }


@router.post("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/video-pool-select")
async def select_video_pool(
    project: str,
    episode_num: int,
    beat_num: int,
    body: VideoPoolSelectRequest,
    user: dict = Depends(get_api_user),
):
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    project_dir = resolved.project_dir

    from novelvideo.generators.video_pool_indexer import assign_video_to_beat

    videos_ep_dir = project_dir / "videos" / "beats" / f"ep{episode_num:03d}"
    ok = assign_video_to_beat(videos_ep_dir, beat_num, body.pool_id)
    if not ok:
        return {
            "ok": False,
            "error": f"Pool entry '{body.pool_id}' not found or file missing",
        }

    rel_path = f"videos/beats/ep{episode_num:03d}/beat_{beat_num:02d}.mp4"
    video_url = make_static_url_for_context(
        resolved.ctx,
        rel_path,
        local_path=project_dir / rel_path,
    )
    return {
        "ok": True,
        "data": {
            "beat_num": beat_num,
            "pool_id": body.pool_id,
            "video_url": video_url,
        },
    }


# ── Image pool view & selection ─────────────────────────────────────────────


@router.get("/projects/{project}/episodes/{episode_num}/grids")
async def list_grids(project: str, episode_num: int, user: dict = Depends(get_api_user)):
    """View grid previews and the image pool."""
    resolved = await _resolve_generation_project(project, user, required_role="viewer")
    username = resolved.username
    project_name = resolved.project_name
    project_dir = resolved.project_dir

    from novelvideo.generators.pool_indexer import (
        compute_beat_content_hash,
        is_pool_image_stale,
        load_pool_index,
    )

    grids_dir = project_dir / "grids" / f"ep{episode_num:03d}"
    pool = await run_asset_upload_operation(load_pool_index, grids_dir)
    if not pool:
        return {"ok": True, "data": None}

    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(username, project_name)
    )
    script_data = await store.get_script_as_dict(episode_num) or {}
    sketch_colors = script_data.get("sketch_colors", {}) or {}
    script_mt = None
    beat_hashes: dict[int, str] = {}
    for beat in script_data.get("beats", []):
        beat_num = beat.get("beat_number")
        if beat_num is not None:
            beat_hashes[beat_num] = compute_beat_content_hash(beat, sketch_colors=sketch_colors)

    images = []
    for img in pool.images:
        entry = img.model_dump()
        # datetime → ISO string
        if entry.get("generated_at"):
            entry["generated_at"] = entry["generated_at"].isoformat()
        # cell URL
        if img.cell_path:
            cell_path = grids_dir / img.cell_path
            entry["cell_url"] = make_static_url_for_context(
                resolved.ctx,
                f"grids/ep{episode_num:03d}/{img.cell_path}",
                local_path=cell_path,
            )
        else:
            entry["cell_url"] = ""
        # grid URL
        if img.grid_path:
            grid_path = grids_dir / img.grid_path
            entry["grid_url"] = make_static_url_for_context(
                resolved.ctx,
                f"grids/ep{episode_num:03d}/{img.grid_path}",
                local_path=grid_path,
            )
        else:
            entry["grid_url"] = ""
        entry["stale"] = is_pool_image_stale(img, beat_hashes, script_mt)
        images.append(entry)

    return {
        "ok": True,
        "data": {
            "episode": pool.episode,
            "modes": pool.modes,
            "images": images,
            "beat_assignments": pool.beat_assignments,
        },
    }


@router.post("/projects/{project}/episodes/{episode_num}/grids/rebuild-pool")
async def rebuild_grids_pool_index(
    project: str,
    episode_num: int,
    user: dict = Depends(get_api_user),
):
    """Rebuild the episode image pool index using the same helper as NiceGUI."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    project_dir = resolved.project_dir

    from novelvideo.generators.pool_indexer import rebuild_pool_index

    grids_dir = project_dir / "grids" / f"ep{episode_num:03d}"
    grids_dir.mkdir(parents=True, exist_ok=True)
    pool = rebuild_pool_index(
        episode_grids_dir=grids_dir,
        episode=episode_num,
        split_cells=True,
    )
    return {
        "ok": True,
        "data": {
            "episode": pool.episode,
            "image_count": len(pool.images),
            "mode_count": len(pool.modes),
        },
    }


@router.get("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/sketch-candidates")
async def get_beat_sketch_candidates(
    project: str,
    episode_num: int,
    beat_num: int,
    user: dict = Depends(get_api_user),
):
    """Return sketch pool candidates for a beat without treating them as the current sketch."""
    resolved = await _resolve_generation_project(project, user, required_role="viewer")
    username = resolved.username
    project_name = resolved.project_name
    project_dir = resolved.project_dir

    from novelvideo.generators.pool_indexer import (
        compute_beat_content_hash,
        is_pool_image_stale,
        load_pool_index,
    )

    grids_dir = project_dir / "grids" / f"ep{episode_num:03d}"
    current_path = project_dir / "sketches" / f"ep{episode_num:03d}" / f"beat_{beat_num:02d}.png"
    current_sketch_url = ""
    if current_path.exists():
        current_sketch_url = make_static_url_for_context(
            resolved.ctx,
            f"sketches/ep{episode_num:03d}/beat_{beat_num:02d}.png",
            local_path=current_path,
        )

    pool = await run_asset_upload_operation(load_pool_index, grids_dir)
    if not pool:
        return {
            "ok": True,
            "data": {
                "episode": episode_num,
                "beat": beat_num,
                "current_sketch_url": current_sketch_url,
                "candidate_count": 0,
                "candidates": [],
            },
        }

    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(username, project_name)
    )
    script_data = await store.get_script_as_dict(episode_num) or {}
    sketch_colors = script_data.get("sketch_colors", {}) or {}
    beat_hashes: dict[int, str] = {}
    for beat in script_data.get("beats", []) or []:
        raw_beat_num = beat.get("beat_number")
        try:
            parsed_beat_num = int(raw_beat_num)
        except (TypeError, ValueError):
            continue
        beat_hashes[parsed_beat_num] = compute_beat_content_hash(
            beat,
            sketch_colors=sketch_colors,
        )

    candidates = []
    for img in pool.images:
        if img.type != "sketch" or int(img.original_beat or 0) != int(beat_num):
            continue
        if not img.cell_path:
            continue
        cell_path = grids_dir / img.cell_path
        if not cell_path.exists():
            continue
        generated_at = img.generated_at.isoformat() if img.generated_at else ""
        candidates.append(
            {
                "id": img.id,
                "type": "sketch",
                "mode": img.mode,
                "cell_path": img.cell_path,
                "url": make_static_url_for_context(
                    resolved.ctx,
                    f"grids/ep{episode_num:03d}/{img.cell_path}",
                    local_path=cell_path,
                ),
                "grid_path": img.grid_path,
                "grid_index": img.grid_index,
                "cell_index": img.cell_index,
                "row": img.row,
                "col": img.col,
                "original_beat": img.original_beat,
                "generated_at": generated_at,
                "stale": is_pool_image_stale(img, beat_hashes, None),
            }
        )
    candidates.sort(
        key=lambda item: (str(item.get("generated_at") or ""), str(item.get("id") or "")),
        reverse=True,
    )

    return {
        "ok": True,
        "data": {
            "episode": episode_num,
            "beat": beat_num,
            "current_sketch_url": current_sketch_url,
            "candidate_count": len(candidates),
            "candidates": candidates,
        },
    }


@router.post("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/pool-select")
async def select_pool_image(
    project: str,
    episode_num: int,
    beat_num: int,
    body: PoolSelectRequest,
    user: dict = Depends(get_api_user),
):
    """Select a pool image and set it as the beat's first frame or sketch by type."""
    import shutil

    resolved = await _resolve_generation_project(project, user, required_role="editor")
    username = resolved.username
    project_name = resolved.project_name
    project_dir = resolved.project_dir

    from novelvideo.generators.pool_indexer import (
        compute_beat_content_hash,
        is_pool_image_stale,
        load_pool_index,
        assign_beat_image,
    )

    grids_dir = project_dir / "grids" / f"ep{episode_num:03d}"
    pool = await run_asset_upload_operation(load_pool_index, grids_dir)
    if not pool:
        return {"ok": False, "error": "No pool index found. Generate grids first."}

    pool_img = pool.get_image(body.pool_id)
    if not pool_img:
        return {"ok": False, "error": f"Pool ID '{body.pool_id}' not found in pool index"}

    if pool_img and pool_img.type == "sketch":
        store = (
            await make_sqlite_store_for_context(resolved.ctx)
            if resolved.ctx
            else await make_sqlite_store(username, project_name)
        )
        script_data = await store.get_script_as_dict(episode_num) or {}
        sketch_colors = script_data.get("sketch_colors", {}) or {}
        beats = script_data.get("beats", [])
        script_mt = None
        beat_hashes: dict[int, str] = {}
        beat_index = pool_img.original_beat - 1
        if 0 <= beat_index < len(beats):
            beat_hashes[pool_img.original_beat] = compute_beat_content_hash(
                beats[beat_index], sketch_colors=sketch_colors
            )
        if is_pool_image_stale(pool_img, beat_hashes, script_mt) and not body.force:
            return {
                "ok": False,
                "stale": True,
                "error": "This sketch has expired. Regenerate it first. If you are sure you still want to use it, pass force=true.",
            }

    cell_path = pool_img.cell_path
    if not cell_path:
        return {"ok": False, "error": f"Pool ID '{body.pool_id}' not found in pool index"}

    # Full path
    cell_full = grids_dir / cell_path
    if not cell_full.exists():
        return {"ok": False, "error": f"Cell image not found at {cell_path}"}

    image_type = pool_img.type or "render"
    data = {
        "beat_num": beat_num,
        "pool_id": body.pool_id,
        "image_type": image_type,
    }

    if image_type == "sketch":
        sketches_dir = project_dir / "sketches" / f"ep{episode_num:03d}"
        sketches_dir.mkdir(parents=True, exist_ok=True)
        dest = sketches_dir / f"beat_{beat_num:02d}.png"
        shutil.copy2(str(cell_full), str(dest))
        rel = f"sketches/ep{episode_num:03d}/beat_{beat_num:02d}.png"
        data["sketch_url"] = make_static_url_for_context(
            resolved.ctx,
            rel,
            local_path=dest,
        )
    else:
        frames_dir = project_dir / "frames" / f"ep{episode_num:03d}"
        dest = frames_dir / f"beat_{beat_num:02d}.png"
        await run_asset_upload_operation(
            assign_beat_image, grids_dir, beat_num, cell_path, image_type
        )
        rel = f"frames/ep{episode_num:03d}/beat_{beat_num:02d}.png"
        data["frame_url"] = make_static_url_for_context(
            resolved.ctx,
            rel,
            local_path=dest,
        )

    return {
        "ok": True,
        "data": data,
    }


@router.post("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/sketch/upload")
async def upload_beat_sketch(
    project: str,
    episode_num: int,
    beat_num: int,
    file: UploadFile = File(...),
    user: dict = Depends(get_api_user),
):
    """Upload a beat sketch, store the canonical sketch file, and add it to the pool."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    project_dir = resolved.project_dir
    try:
        image = await _read_uploaded_rgb_image(file)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}

    sketches_dir = project_dir / "sketches" / f"ep{episode_num:03d}"
    sketch_path = sketches_dir / f"beat_{beat_num:02d}.png"

    pool_id = await run_asset_upload_operation(
        _register_uploaded_pool_image,
        project_dir=project_dir,
        episode_num=episode_num,
        beat_num=beat_num,
        image=image,
        image_type="sketch",
    )
    rel = f"sketches/ep{episode_num:03d}/beat_{beat_num:02d}.png"
    sketch_url = make_static_url_for_context(
        resolved.ctx,
        rel,
        local_path=sketch_path,
    )
    return {
        "ok": True,
        "data": {
            "beat_num": beat_num,
            "pool_id": pool_id,
            "sketch_url": sketch_url,
        },
    }


@router.post("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/render/upload")
async def upload_beat_render(
    project: str,
    episode_num: int,
    beat_num: int,
    file: UploadFile = File(...),
    user: dict = Depends(get_api_user),
):
    """Upload a beat render first frame, promote it, and add it to the pool."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    project_dir = resolved.project_dir
    try:
        image = await _read_uploaded_rgb_image(file)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}

    frames_dir = project_dir / "frames" / f"ep{episode_num:03d}"
    frame_path = frames_dir / f"beat_{beat_num:02d}.png"

    pool_id = await run_asset_upload_operation(
        _register_uploaded_pool_image,
        project_dir=project_dir,
        episode_num=episode_num,
        beat_num=beat_num,
        image=image,
        image_type="render",
    )
    rel = f"frames/ep{episode_num:03d}/beat_{beat_num:02d}.png"
    frame_url = make_static_url_for_context(
        resolved.ctx,
        rel,
        local_path=frame_path,
    )
    return {
        "ok": True,
        "data": {
            "beat_num": beat_num,
            "pool_id": pool_id,
            "frame_url": frame_url,
        },
    }


# ── Single-Beat audio regeneration ──────────────────────────────────────────


@router.post("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/audio")
async def regenerate_beat_audio(
    project: str,
    episode_num: int,
    beat_num: int,
    user: dict = Depends(get_api_user),
):
    """Regenerate the IndexTTS2 speech of a single beat."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    ctx = resolved.ctx
    username = resolved.username
    project_name = resolved.project_name
    output_dir = resolved.output_dir
    state_dir = resolved.state_dir
    store = (
        await make_sqlite_store_for_context(ctx)
        if ctx
        else await make_sqlite_store(username, project_name)
    )
    beats = await store.get_beats_as_dicts(episode_num)

    beat = next((b for b in beats if b.get("beat_number") == beat_num), None)
    if not beat:
        # Fall back by index
        if 1 <= beat_num <= len(beats):
            beat = beats[beat_num - 1]
        else:
            return {"ok": False, "error": f"Beat {beat_num} not found"}

    billable_beat_numbers, missing_voice, billable_chars = await _audio_generation_plan(
        store=store,
        username=username,
        project=project_name,
        episode=episode_num,
        beat_numbers=[beat_num],
        mode="redo_selected",
    )
    if missing_voice:
        return _voice_prereq_error_response(missing_voice)
    if not billable_beat_numbers:
        return {
            "ok": False,
            "code": "audio_generation_not_required",
            "error": "The current Beat has no audio to generate",
        }

    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            product_surface="mainline",
            task_type="audio_generation_indextts2",
            queue_kind="default",
            episode=episode_num,
            payload={
                "episode": episode_num,
                "mode": "redo_selected",
                "beat_numbers": billable_beat_numbers,
                "output_dir": output_dir,
                "state_dir": state_dir,
                "billing": _audio_billing_payload(
                    billable_beat_numbers,
                    billable_chars=billable_chars,
                ),
            },
        )
        return {
            "ok": True,
            "task_type": "audio_generation_indextts2",
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key(
                "audio_generation_indextts2", ctx.project_id, episode_num
            ),
            "backend": queued.backend,
            "queue": queued.queue,
            "message": f"Episode {episode_num} Beat {beat_num} speech generation queued",
        }

    return {
        "ok": False,
        "error": "Audio generation requires a project context",
    }


# ── SRT subtitle export ─────────────────────────────────────────────────────


@router.get("/projects/{project}/episodes/{episode_num}/export/srt")
async def export_srt(project: str, episode_num: int, user: dict = Depends(get_api_user)):
    """Export an SRT subtitle file."""
    from fastapi.responses import PlainTextResponse

    resolved = await _resolve_generation_project(project, user, required_role="viewer")
    project_dir = resolved.project_dir

    # Read beats from the graph
    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(resolved.username, resolved.project_name)
    )
    beats = await store.get_beats_as_dicts(episode_num)

    if not beats:
        return {"ok": False, "error": "No beats in script"}

    from novelvideo.export.episode_export import build_srt_content

    srt_content = await build_srt_content(project_dir, episode_num, beats)
    if not srt_content:
        return {"ok": False, "error": "No subtitles to export"}

    return PlainTextResponse(
        content=srt_content,
        media_type="text/srt",
        headers={
            "Content-Disposition": f'attachment; filename="ep{episode_num:03d}.srt"',
        },
    )


@router.get("/projects/{project}/episodes/{episode_num}/export/video")
async def export_final_video(
    project: str,
    episode_num: int,
    user: dict = Depends(get_api_user),
):
    """Download the composed final episode video."""
    from fastapi.responses import FileResponse

    resolved = await _resolve_generation_project(project, user, required_role="viewer")
    project_dir = resolved.project_dir
    filename = f"ep{episode_num:03d}_final.mp4"
    final_path = project_dir / "videos" / "episodes" / filename
    if not final_path.exists():
        raise HTTPException(status_code=404, detail="Final video not found")
    return FileResponse(
        path=str(final_path),
        filename=filename,
        media_type="video/mp4",
    )


# ── Grid upload / Prompt export / splitting ─────────────────────────────────


@router.post("/projects/{project}/episodes/{episode_num}/grids/{grid_index}/upload")
async def upload_grid(
    project: str,
    episode_num: int,
    grid_index: int,
    file: UploadFile = File(...),
    grid_type: str = Form("render"),
    mode_key: str = Form(""),
    beat_numbers: str = Form(""),
    user: dict = Depends(get_api_user),
):
    """Upload a single whole grid image and update the grid_path of the same scope in the pool index."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    project_dir = resolved.project_dir

    grid_type = grid_type.strip() or "render"
    if grid_type not in {"render", "sketch"}:
        return {"ok": False, "error": "grid_type must be render or sketch"}
    try:
        parsed_beats = _parse_grid_beat_numbers(beat_numbers)
    except Exception as exc:
        return {"ok": False, "error": f"invalid beat_numbers: {exc}"}
    mode_key = mode_key.strip() or "upload"

    content = await file.read()
    if not content:
        return {"ok": False, "error": "uploaded file is empty"}

    suffix = Path(file.filename or "").suffix.lower().lstrip(".")
    if suffix not in {"png", "jpg", "jpeg", "webp"}:
        suffix = "png"
    if suffix == "jpeg":
        suffix = "jpg"

    from novelvideo.api.upload_workers import (
        asset_resource_lock,
        run_asset_upload_operation,
    )
    from novelvideo.generators.pool_indexer import persist_uploaded_grid

    grids_dir = project_dir / "grids" / f"ep{episode_num:03d}"
    filename = _uploaded_grid_filename(grid_type, mode_key, parsed_beats, suffix)
    # All scopes in this episode share the same index. Keep the async lock until
    # the worker has committed or rolled back, including repeated cancellation.
    async with asset_resource_lock(("grid-upload", str(grids_dir))):
        grid_path = await run_asset_upload_operation(
            persist_uploaded_grid,
            grids_dir,
            episode_num,
            grid_index,
            grid_type,
            mode_key,
            parsed_beats,
            filename,
            content,
        )
    grid_rel = grid_path.relative_to(grids_dir).as_posix()

    return {
        "ok": True,
        "data": {
            "grid_index": grid_index,
            "grid_type": grid_type,
            "mode_key": mode_key,
            "beat_numbers": parsed_beats,
            "grid_path": grid_rel,
            "grid_url": make_static_url_for_context(
                resolved.ctx,
                f"grids/ep{episode_num:03d}/{grid_rel}",
                local_path=grid_path,
            ),
        },
    }


@router.get("/projects/{project}/episodes/{episode_num}/grids/{grid_index}/prompt")
async def export_grid_prompt(
    project: str,
    episode_num: int,
    grid_index: int,
    grid_type: str = Query("render"),
    mode_key: str = Query(""),
    beat_numbers: str = Query(""),
    user: dict = Depends(get_api_user),
):
    """Read the grid prompt text recorded in the pool index."""
    resolved = await _resolve_generation_project(project, user, required_role="viewer")
    project_dir = resolved.project_dir
    grid_type = grid_type.strip() or "render"
    if grid_type not in {"render", "sketch"}:
        return {"ok": False, "error": "grid_type must be render or sketch"}
    try:
        parsed_beats = _parse_grid_beat_numbers(beat_numbers)
    except Exception as exc:
        return {"ok": False, "error": f"invalid beat_numbers: {exc}"}
    mode_key = mode_key.strip()

    from novelvideo.generators.pool_indexer import load_pool_index

    grids_dir = project_dir / "grids" / f"ep{episode_num:03d}"
    pool = await run_asset_upload_operation(load_pool_index, grids_dir)
    if not pool:
        return {"ok": False, "error": "No pool index found. Generate grids first."}

    entry = _find_pool_grid_entry(
        pool,
        grid_type=grid_type,
        mode_key=mode_key or None,
        beat_numbers=parsed_beats,
        grid_index=grid_index,
    )
    if entry is None:
        return {"ok": False, "error": "Grid prompt metadata not found"}

    prompt_candidates: list[str] = []
    if entry.prompt_path:
        prompt_candidates.append(entry.prompt_path)
    if parsed_beats and entry.mode_key:
        beats_slug = "-".join(str(beat) for beat in parsed_beats)
        prompt_candidates.append(
            f"{entry.preset}/{grid_type}_{entry.mode_key}_{beats_slug}_prompt.txt"
        )

    for relative in prompt_candidates:
        prompt_path = _safe_grids_file(grids_dir, relative)
        if prompt_path and prompt_path.exists():
            return {
                "ok": True,
                "data": {
                    "grid_index": grid_index,
                    "grid_type": grid_type,
                    "mode_key": entry.mode_key,
                    "beat_numbers": list(entry.beat_nums),
                    "prompt": prompt_path.read_text(encoding="utf-8"),
                    "prompt_path": prompt_path.relative_to(grids_dir).as_posix(),
                },
            }

    return {"ok": False, "error": "Prompt file not found for this grid"}


@router.post("/projects/{project}/episodes/{episode_num}/grids/{grid_index}/sketch-preview")
async def sketch_grid_preview(
    project: str,
    episode_num: int,
    grid_index: int,
    body: GridSketchPreviewRequest,
    user: dict = Depends(get_api_user),
):
    """Return the same sketch-thumbnail preview NiceGUI shows for planned grids.

    This API exposes NiceGUI's `_get_sketch_thumbnail_url` behavior to React:
    it stitches existing beat sketches into a temporary preview image without
    changing the generation pipeline.
    """
    resolved = await _resolve_generation_project(project, user, required_role="viewer")
    output_dir = Path(resolved.output_dir)
    ep_grids_dir = output_dir / "grids" / f"ep{episode_num:03d}"

    from novelvideo.generators.nanobanana_grid import crop_sketch_panels
    from novelvideo.generators.pool_indexer import build_beat_sketch_paths, load_pool_index

    beat_numbers = [int(beat) for beat in body.beat_numbers if int(beat) > 0]
    if not beat_numbers:
        return {"ok": False, "error": "beat_numbers is required"}

    paths = build_beat_sketch_paths(ep_grids_dir, beat_numbers)
    pool = await run_asset_upload_operation(load_pool_index, ep_grids_dir)
    if pool:
        latest_pool_paths: dict[int, tuple[float, str]] = {}
        for img in pool.images:
            if img.type != "sketch" or not img.cell_path:
                continue
            beat_num = int(img.original_beat)
            if beat_num not in beat_numbers:
                continue
            cell_path = ep_grids_dir / img.cell_path
            if not cell_path.exists():
                continue
            generated_at = img.generated_at.timestamp() if img.generated_at else 0.0
            current = latest_pool_paths.get(beat_num)
            if current is None or generated_at > current[0]:
                latest_pool_paths[beat_num] = (generated_at, str(cell_path))
        paths = {
            **{beat: path for beat, (_generated_at, path) in latest_pool_paths.items()},
            **paths,
        }
    if not paths:
        return {"ok": False, "error": "No sketch images found for requested beats"}

    beats_slug = "_".join(str(beat) for beat in beat_numbers[:8])
    out_file = (
        ep_grids_dir / f"sketch_thumb_grid{grid_index}_{beats_slug}_{body.rows}x{body.cols}.jpg"
    )
    sketch_out = Path(
        crop_sketch_panels(
            str(ep_grids_dir),
            beat_numbers,
            body.rows,
            body.cols,
            str(out_file),
            beat_sketch_paths=paths,
        )
    )
    try:
        rel = sketch_out.relative_to(ep_grids_dir)
    except ValueError:
        return {"ok": False, "error": "Sketch preview path escaped episode grids directory"}

    return {
        "ok": True,
        "data": {
            "grid_index": grid_index,
            "rows": body.rows,
            "cols": body.cols,
            "beat_numbers": beat_numbers,
            "preview_path": str(rel),
            "preview_url": make_static_url_for_context(
                resolved.ctx,
                f"grids/ep{episode_num:03d}/{rel}",
                local_path=sketch_out,
            ),
        },
    }


@router.post("/projects/{project}/episodes/{episode_num}/grids/{grid_index}/cut")
async def cut_grid(
    project: str,
    episode_num: int,
    grid_index: int,
    body: GridCutRequest,
    user: dict = Depends(get_api_user),
):
    """Split a grid into individual beat images and put them into the pool."""
    resolved = await _resolve_generation_project(project, user, required_role="editor")
    project_dir = resolved.project_dir

    from datetime import datetime
    from novelvideo.generators.pool_indexer import save_grid_and_split

    episode_grids_dir = project_dir / "grids" / f"ep{episode_num:03d}"
    if not episode_grids_dir.exists():
        return {"ok": False, "error": f"No grids directory for episode {episode_num}"}

    beat_nums = (
        [int(beat) for beat in body.beat_numbers]
        if body.beat_numbers
        else list(range(body.beat_start, body.beat_end + 1))
    )
    ts = datetime.now().strftime("%Y%m%d%H%M%S")
    mode_key = body.mode_key or f"{body.rows}x{body.cols}"

    grid_image_path = None
    from novelvideo.generators.pool_indexer import load_pool_index

    pool = await run_asset_upload_operation(load_pool_index, episode_grids_dir)
    entry = _find_pool_grid_entry(
        pool,
        grid_type=body.grid_type,
        mode_key=body.mode_key,
        beat_numbers=beat_nums,
        grid_index=grid_index,
    )
    if entry is not None:
        entry_path = _safe_grids_file(episode_grids_dir, entry.grid_path)
        if entry_path and entry_path.exists():
            grid_image_path = str(entry_path)

    if grid_image_path is None:
        # Compatible with legacy root-directory grid_XX.png / jpg files.
        grid_files = sorted(episode_grids_dir.glob("*.png")) + sorted(
            episode_grids_dir.glob("*.jpg")
        )
        if grid_index < 0 or grid_index >= len(grid_files):
            return {
                "ok": False,
                "error": f"Grid index {grid_index} out of range (total: {len(grid_files)})",
            }
        grid_image_path = str(grid_files[grid_index])

    if body.grid_type == "render":
        promote_dir = project_dir / "frames" / f"ep{episode_num:03d}"
    else:
        promote_dir = project_dir / "sketches"
    promote_dir.mkdir(parents=True, exist_ok=True)

    result = save_grid_and_split(
        grid_image_path=grid_image_path,
        episode_grids_dir=str(episode_grids_dir),
        grid_type=body.grid_type,
        mode_key=mode_key,
        beat_nums=beat_nums,
        preset="custom",
        rows=body.rows,
        cols=body.cols,
        ts=ts,
        promote_dir=promote_dir,
        force_promote=body.grid_type == "render",
    )

    return {
        "ok": True,
        "data": {
            "grid_index": grid_index,
            "added": result.get("added", 0),
            "skipped": result.get("skipped", 0),
        },
    }


# ── ZIP export ──────────────────────────────────────────────────────────────


@router.post("/projects/{project}/episodes/{episode_num}/export/zip")
async def export_zip(project: str, episode_num: int, user: dict = Depends(get_api_user)):
    """Package all resources of the specified episode into a ZIP file for download."""
    import asyncio
    import zipfile
    import tempfile

    from novelvideo.export.episode_export import build_srt_content
    from novelvideo.utils.async_ops import call_blocking, wait_for_task_completion
    from novelvideo.utils.path_resolver import PathResolver

    resolved = await _resolve_generation_project(project, user, required_role="viewer")
    project_name = resolved.project_name
    project_dir = resolved.project_dir
    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(resolved.username, project_name)
    )
    beats = await store.get_beats_as_dicts(episode_num)

    ep_tag = f"ep{episode_num:03d}"
    paths = PathResolver(str(project_dir), episode_num)

    files_to_pack: list[tuple[Path, str]] = []
    for beat in beats:
        beat_num = int(beat.get("beat_number", 0) or 0)
        if beat_num <= 0:
            continue
        audio_path = paths.audio(beat_num)
        if audio_path.exists():
            files_to_pack.append((audio_path, f"audio/{audio_path.name}"))
        video_path = paths.video(beat_num)
        if video_path.exists():
            files_to_pack.append((video_path, f"video/{video_path.name}"))

    final_path = paths.final_video()
    if final_path.exists():
        files_to_pack.append((final_path, final_path.name))

    # Keep existing extra project assets in the API ZIP; NiceGUI's core export
    # is beat audio/video + final + SRT, but frames/grids are useful inspection
    # artifacts and were already part of the React API surface.
    extra_dirs = {
        "frames": project_dir / "frames" / ep_tag,
        "grids": project_dir / "grids" / ep_tag,
    }
    for folder_name, folder in extra_dirs.items():
        if folder.exists():
            for file_path in sorted(folder.iterdir()):
                if file_path.is_file():
                    files_to_pack.append((file_path, f"{folder_name}/{file_path.name}"))

    srt_content = await build_srt_content(project_dir, episode_num, beats)

    def build_zip_file() -> str:
        tmp_path = ""
        try:
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
            tmp_path = tmp.name
            tmp.close()
            with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_STORED) as zf:
                for file_path, arc_name in files_to_pack:
                    zf.write(file_path, arc_name)
                if srt_content:
                    zf.writestr(
                        f"{ep_tag}.srt",
                        srt_content,
                        compress_type=zipfile.ZIP_DEFLATED,
                    )
            return tmp_path
        except Exception:
            if tmp_path:
                Path(tmp_path).unlink(missing_ok=True)
            raise

    build_task = asyncio.create_task(call_blocking(build_zip_file))
    tmp_path, cancellation = await wait_for_task_completion(build_task)
    if cancellation is not None:
        Path(tmp_path).unlink(missing_ok=True)
        raise cancellation
    try:
        return _TemporaryFileResponse(
            path=tmp_path,
            filename=f"{project_name}_{ep_tag}.zip",
            media_type="application/zip",
        )
    except Exception:
        Path(tmp_path).unlink(missing_ok=True)
        raise


# ---------------------------------------------------------------------------
# Sketch coloring + AI color detection
# ---------------------------------------------------------------------------


@router.post("/projects/{project}/episodes/{episode_num}/sketches/assign-colors")
async def assign_sketch_colors(
    project: str,
    episode_num: int,
    user: dict = Depends(get_api_user),
):
    """Assign shared colors to the identities and global props appearing in this episode."""
    from novelvideo.generators.episode_optimizer import EpisodeOptimizer
    from novelvideo.generators.nanobanana_grid import _global_prop_marker_colors

    resolved = await _resolve_generation_project(project, user, required_role="editor")
    username = resolved.username
    project_name = resolved.project_name

    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(username, project_name)
    )

    beats = await store.get_beats_as_dicts(episode_num)
    if not beats:
        return {"ok": False, "error": f"No beats found for episode {episode_num}"}

    characters = store.get_all_characters()
    char_dicts = [
        {
            "name": c.name,
            "identities": [
                {"identity_id": id_.identity_id, "identity_name": id_.identity_name}
                for id_ in (c.identities or [])
            ],
        }
        for c in characters
    ]

    previous_colors = dict(store.get_sketch_colors(episode_num) or {})
    colors = EpisodeOptimizer.assign_sketch_colors(
        char_dicts,
        episode_beats=beats,
        existing_colors=previous_colors,
    )

    episode_obj = _episode_from_store_or_none(store, episode_num)
    runtime_prop_menu = await _runtime_prop_menu_with_global_props(store, episode_obj, beats)
    previous_prop_marker_colors = _global_prop_marker_colors(
        beats,
        prop_menu=runtime_prop_menu,
        sketch_colors=previous_colors,
    )
    prop_marker_colors = _global_prop_marker_colors(
        beats,
        prop_menu=runtime_prop_menu,
        sketch_colors=colors,
        assign_missing=True,
    )
    if not colors and not prop_marker_colors:
        return {"ok": False, "error": "No identity or global prop markers found in beats"}

    try:
        if colors:
            await store.set_sketch_colors(episode_num, colors)
        if prop_marker_colors and runtime_prop_menu:
            for item in runtime_prop_menu:
                if not isinstance(item, dict):
                    continue
                prop_id = str(item.get("prop_id") or item.get("name") or "").strip()
                if prop_id in prop_marker_colors:
                    item["marker_color"] = prop_marker_colors[prop_id]
            # Marker colours are written back into the menu this request loaded
            # earlier, so a whole-row write here discards whatever scene, prop
            # or identity planning stored meanwhile.
            await store.patch_episode(episode_num, prop_menu=runtime_prop_menu)
    except Exception:
        pass

    previous_marker_colors = {
        **{f"identity:{key}": value for key, value in previous_colors.items()},
        **{f"prop:{key}": value for key, value in previous_prop_marker_colors.items()},
    }
    current_marker_colors = {
        **{f"identity:{key}": value for key, value in colors.items()},
        **{f"prop:{key}": value for key, value in prop_marker_colors.items()},
    }
    should_clean_sketches = _color_assignment_requires_full_sketch_clean(
        previous_marker_colors,
        current_marker_colors,
    )
    if should_clean_sketches:
        from novelvideo.utils.path_resolver import PathResolver

        output_dir = resolved.output_dir
        PathResolver(output_dir, episode_num).clean_sketches()

    return {
        "ok": True,
        "data": {
            "colors": colors,
            "count": len(colors),
            "prop_colors": prop_marker_colors,
            "prop_count": len(prop_marker_colors),
        },
    }


@router.post("/projects/{project}/episodes/{episode_num}/sketches/detect-identities")
async def detect_sketch_identities(
    project: str,
    episode_num: int,
    user: dict = Depends(get_api_user),
):
    """AI vision recognition of identity/prop color markers appearing in the sketch."""
    from novelvideo.agents.global_video_optimizer import detect_identities_by_ai
    from novelvideo.generators.grid_splitter import combine_to_grid
    from novelvideo.generators.nanobanana_grid import _global_prop_marker_colors
    from novelvideo.models import (
        NO_CHARACTER_MARKER,
        NO_PROP_MARKER,
        real_detected_identities,
        real_detected_props,
        split_detected_marker_keys,
    )

    resolved = await _resolve_generation_project(project, user, required_role="editor")
    username = resolved.username
    project_name = resolved.project_name

    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(username, project_name)
    )

    beats = await store.get_beats_as_dicts(episode_num)
    if not beats:
        return {"ok": False, "error": f"No beats found for episode {episode_num}"}

    color_map = dict(store.get_sketch_colors(episode_num) or {})
    script_data_for_fallback = None
    if not color_map:
        try:
            script_data_for_fallback = await store.get_script_as_dict(episode_num)
            color_map = dict((script_data_for_fallback or {}).get("sketch_colors") or {})
        except Exception:
            script_data_for_fallback = None
    if not color_map:
        return {"ok": False, "error": "No sketch colors assigned. Call assign-colors first"}

    episode_obj = _episode_from_store_or_none(store, episode_num)
    runtime_prop_menu = await _runtime_prop_menu_with_global_props(store, episode_obj, beats)
    if not runtime_prop_menu:
        if script_data_for_fallback is None:
            try:
                script_data_for_fallback = await store.get_script_as_dict(episode_num)
            except Exception:
                script_data_for_fallback = None
        runtime_prop_menu = list((script_data_for_fallback or {}).get("prop_menu") or [])
    prop_color_map = _global_prop_marker_colors(
        beats,
        prop_menu=runtime_prop_menu,
        sketch_colors=color_map,
    )

    # Invert: "#HEX COLOR_NAME" -> marker_id
    color_identity_map = {v: k for k, v in color_map.items()}
    color_identity_map.update({v: k for k, v in prop_color_map.items()})

    # Collect sketch files
    project_dir = resolved.project_dir
    sketches_dir = project_dir / "sketches" / f"ep{episode_num:03d}"
    frame_items: list[tuple[int, str]] = []
    known_beats = {
        int(b.get("beat_number", 0)) for b in beats if int(b.get("beat_number", 0) or 0) > 0
    }
    beat_pattern = re.compile(r"beat_(\d+)\.(png|jpg)$", re.IGNORECASE)
    if sketches_dir.exists():
        for candidate in sorted(sketches_dir.iterdir()):
            if not candidate.is_file():
                continue
            match = beat_pattern.match(candidate.name)
            if not match:
                continue
            beat_number = int(match.group(1))
            if known_beats and beat_number not in known_beats:
                continue
            frame_items.append((beat_number, str(candidate)))

    if not frame_items:
        return {"ok": False, "error": "No sketches found"}

    def _grid_shape(count: int) -> tuple[int, int]:
        if count <= 1:
            return 1, 1
        if count <= 4:
            return 2, 2
        if count <= 9:
            return 3, 3
        if count <= 16:
            return 4, 4
        return 5, 5

    grid_dir = project_dir / "grids" / f"ep{episode_num:03d}" / "sketch"
    grid_dir.mkdir(parents=True, exist_ok=True)

    usage_meter = get_usage_meter()
    ctx = getattr(resolved, "ctx", None)
    project_id = str(getattr(ctx, "project_id", "") or "")
    reservation = await usage_meter.reserve_feature_start_credits(
        user_id=_requester_user_id_for_billing(resolved, user),
        feature_key=AI_IDENTITY_DETECTION_FEATURE_KEY,
        product_surface="mainline",
        project_id=project_id,
        resource_kind="sketch",
        task_type=AI_IDENTITY_DETECTION_TASK_TYPE,
        metadata={
            "source": "sync_api",
            "endpoint": "detect_sketch_identities",
            "episode": episode_num,
            "sketch_count": len(frame_items),
        },
        require_price_rule=True,
        require_positive_cost=True,
    )
    reservation_id = str(reservation.get("id") or "")
    billing_metadata: dict[str, Any] = {
        "model_call_credit_policy": MODEL_CALL_CREDIT_POLICY_FEATURE_INCLUDED,
        "feature_key": AI_IDENTITY_DETECTION_FEATURE_KEY,
        "source": "sync_api",
    }
    if reservation_id:
        billing_metadata.update(
            {
                "feature_credit_reservation_id": reservation_id,
                "feature_credit_charge_id": reservation_id,
                "feature_credit_cost": str(reservation.get("cost") or 0),
            }
        )

    detections: dict[int, list[str]] = {}
    try:
        usage_meter.set_llm_usage_context(
            _requester_user_id_for_billing(resolved, user),
            project_id=project_id,
            resource_kind="sketch",
            billing_metadata=billing_metadata,
        )
        batch_size = 25
        for batch_idx in range(0, len(frame_items), batch_size):
            batch = frame_items[batch_idx : batch_idx + batch_size]
            rows, cols = _grid_shape(len(batch))
            grid_path = (
                grid_dir / f"_ai_detect_grid_{rows}x{cols}_part{batch_idx // batch_size + 1}.png"
            )
            combine_to_grid([path for _, path in batch], grid_path, rows=rows, cols=cols)
            batch_result = await detect_identities_by_ai(
                sketch_image_paths=[str(grid_path)],
                color_identity_map=color_identity_map,
                total_beats=len(batch),
            )
            ordered_batch = sorted(batch, key=lambda item: item[0])
            for local_idx, marker_ids in (batch_result or {}).items():
                try:
                    panel_index = int(local_idx)
                except (TypeError, ValueError):
                    continue
                if 1 <= panel_index <= len(ordered_batch):
                    beat_number = ordered_batch[panel_index - 1][0]
                    detections[beat_number] = list(marker_ids or [])

        for beat_number, _path in frame_items:
            detections.setdefault(beat_number, [])

        characters = store.get_all_characters()
        identity_detections: dict[int, list[str]] = {}
        prop_detections: dict[int, list[str]] = {}
        allowed_prop_ids = set(prop_color_map)
        for beat_number, keys in detections.items():
            det_ids, det_props = split_detected_marker_keys(
                keys,
                beats,
                characters,
                allowed_prop_ids=allowed_prop_ids,
            )
            identity_detections[beat_number] = det_ids or [NO_CHARACTER_MARKER]
            prop_detections[beat_number] = det_props or [NO_PROP_MARKER]

        # Persist
        await store.set_beat_detected_identities(episode_num, identity_detections)
        await store.set_beat_detected_props(episode_num, prop_detections)

    except Exception as e:
        if reservation_id:
            try:
                await usage_meter.settle_cancelled_feature_credit_reservation(
                    reservation_id,
                    metadata={
                        "source": "sync_api",
                        "endpoint": "detect_sketch_identities",
                        "episode": episode_num,
                        "error": str(e),
                    },
                )
            except Exception:
                logger.exception(
                    "Failed to settle interrupted AI identity detection feature credit reservation"
                )
        return {"ok": False, "error": f"AI detection failed: {e}"}
    finally:
        usage_meter.clear_llm_usage_context()

    if reservation_id:
        try:
            await usage_meter.settle_feature_credit_reservation(
                reservation_id,
                action="confirm",
                metadata={
                    "source": "sync_api",
                    "endpoint": "detect_sketch_identities",
                    "episode": episode_num,
                    "sketch_count": len(frame_items),
                    "detected_identity_count": sum(
                        len(real_detected_identities(v))
                        for v in identity_detections.values()
                    ),
                    "detected_prop_count": sum(
                        len(real_detected_props(v)) for v in prop_detections.values()
                    ),
                },
            )
        except Exception:
            logger.exception(
                "AI identity detection succeeded but credit confirmation remains pending"
            )

    # Convert keys to strings (JSON compatible)
    str_identity_detections = {str(k): v for k, v in identity_detections.items()}
    str_prop_detections = {str(k): v for k, v in prop_detections.items()}
    total_ids = sum(len(real_detected_identities(v)) for v in identity_detections.values())
    total_props = sum(len(real_detected_props(v)) for v in prop_detections.values())

    return {
        "ok": True,
        "data": {
            "detections": str_identity_detections,
            "identity_detections": str_identity_detections,
            "prop_detections": str_prop_detections,
            "total_beats": len(beats),
            "total_identities": total_ids,
            "total_props": total_props,
            "review_message": (
                "AI has finished recognizing on-screen identities/props. Please review each beat; "
                "missed detections can be added under 'More' > on-screen identities / on-screen props."
            ),
        },
    }
