"""Freezone video node helpers.

Includes:
- text-to-video camera movement template library
- local persistence of the character asset library
- video prompt assembly
- omni-reference input validation
"""

from __future__ import annotations

import json
import math
import os
import tempfile
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

import portalocker

from novelvideo.freezone.paths import freezone_root
from novelvideo.video_duration import (
    normalize_video_duration_for_backend as normalize_video_duration_for_backend,
    video_duration_bounds_for_backend,
)

VIDEO_CAMERA_TEMPLATES: list[dict[str, str]] = [
    {
        "id": "locked_off",
        "name": "Locked-off shot",
        "prompt": "The camera is locked off with a stable position: no push, pan or move; the performance is carried naturally by the characters and the environment.",
    },
    {
        "id": "follow_tracking",
        "name": "Follow shot",
        "prompt": "The camera continuously follows the subject as it moves, keeping the protagonist at the visual center, with natural and smooth motion.",
    },
    {
        "id": "orbit_up",
        "name": "Orbit and rise",
        "prompt": "The camera orbits the subject while slowly rising, creating a sense of space unfolding and emotional lift.",
    },
    {
        "id": "orbit_down",
        "name": "Orbit and descend",
        "prompt": "The camera orbits the subject while slowly descending, creating a sense of pressure and an immersive enclosure.",
    },
    {
        "id": "tilt_up",
        "name": "Tilt up",
        "prompt": "The camera tilts up smoothly from below, gradually revealing the information above the subject and the height of the space.",
    },
    {
        "id": "tilt_down",
        "name": "Tilt down",
        "prompt": "The camera tilts down smoothly from above, gradually focusing on the subject's action and the details on the ground.",
    },
    {
        "id": "pan_left",
        "name": "Pan left",
        "prompt": "The camera pans smoothly to the left, bringing in the environment and narrative information on the left side of the frame.",
    },
    {
        "id": "pan_right",
        "name": "Pan right",
        "prompt": "The camera pans smoothly to the right, bringing in the environment and narrative information on the right side of the frame.",
    },
    {
        "id": "pedestal_up",
        "name": "Pedestal up",
        "prompt": "The whole camera rises vertically, gradually raising the viewpoint to strengthen spatial layering and a sense of presence.",
    },
    {
        "id": "pedestal_down",
        "name": "Pedestal down",
        "prompt": "The whole camera descends vertically, gradually lowering the viewpoint to intensify the pressure on the character and the immersion.",
    },
    {
        "id": "truck_left",
        "name": "Truck left",
        "prompt": "The whole camera slides to the left, keeping the movement steady and emphasizing the lateral staging of the scene.",
    },
    {
        "id": "truck_right",
        "name": "Truck right",
        "prompt": "The whole camera slides to the right, keeping the movement steady and emphasizing the lateral staging of the scene.",
    },
]

LEGACY_FREEZONE_VIDEO_BACKEND_ALIASES: dict[str, str] = {
    "huimeng_seedance20_fast": "newapi_seedance-2.0-fast",
    "huimeng_seedance-2.0-fast": "newapi_seedance-2.0-fast",
    "seedance_2": "newapi_seedance-2.0-fast",
    "huimeng_seedance10_fast": "newapi_seedance-1.0-pro-fast",
    "huimeng_seedance-1.0-pro-fast": "newapi_seedance-1.0-pro-fast",
    "seedance_fast": "newapi_seedance-1.0-pro-fast",
    "huimeng_seedance15_pro": "newapi_seedance-1.5-pro",
    "huimeng_seedance-1.5-pro": "newapi_seedance-1.5-pro",
    "seedance_pro": "newapi_seedance-1.5-pro",
    "seedance_pro_silent": "newapi_seedance-1.5-pro",
}

LEGACY_FREEZONE_VIDEO_LABEL_ALIASES: dict[str, str] = {
    "huimeng seedance 2.0 fast": "newapi_seedance-2.0-fast",
    "huimeng seedance 1.0 pro fast": "newapi_seedance-1.0-pro-fast",
    "huimeng seedance 1.5 pro": "newapi_seedance-1.5-pro",
    "seedance 1.0 fast": "newapi_seedance-1.0-pro-fast",
}

FREEZONE_DEFAULT_VIDEO_BACKEND = "newapi_seedance-2.0-fast"
FREEZONE_NEWAPI_VIDEO_BACKENDS = {
    "newapi_seedance-2.0",
    "newapi_seedance-2.0-fast",
    "newapi_seedance-2.0-value",
    "newapi_seedance-2.0-fast-value",
    "newapi_seedance-1.0-pro-fast",
    "newapi_seedance-1.5-pro",
    "newapi_happyhorse-1.0",
}
FREEZONE_DISABLED_VIDEO_BACKENDS = {"newapi_grok-video-channel"}


def get_video_camera_templates() -> list[dict[str, str]]:
    return [dict(item) for item in VIDEO_CAMERA_TEMPLATES]


def get_video_camera_template(template_id: str | None) -> dict[str, str] | None:
    if not template_id:
        return None
    for item in VIDEO_CAMERA_TEMPLATES:
        if item["id"] == template_id:
            return dict(item)
    return None


def normalize_video_aspect_ratio(value: str | None) -> str:
    text = str(value or "").strip().lower()
    if text in {"auto", "adaptive"}:
        return "auto"
    if not text:
        return "16:9"
    return text


def supported_image_aspect_ratio(
    frame_path: str, options: list[str] | None
) -> str:
    """Choose the closest supported fixed ratio for the locked first frame.

    NewAPI canonicalizes adaptive to auto, which does not guarantee source
    geometry; a fixed catalog ratio survives the final wire contract.
    """
    size = _read_reference_image_size(Path(frame_path))
    if size is None:
        return "auto"
    supported: list[tuple[str, float]] = []
    for option in options or []:
        try:
            width, height = (float(part) for part in option.split(":"))
        except (ValueError, TypeError):
            continue
        if width > 0 and height > 0:
            supported.append((option, width / height))
    if not supported:
        return "auto"
    source_ratio = size[0] / size[1]
    return min(
        supported,
        key=lambda candidate: abs(math.log(source_ratio / candidate[1])),
    )[0]


def normalize_video_resolution(value: str | None) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return "720p"
    return text


FREEZONE_SEEDANCE2_RESOLUTION_OPTIONS_BY_MODEL: dict[str, tuple[str, ...]] = {
    "seedance-2.0-fast": ("480p", "720p"),
    "seedance-2.0": ("480p", "720p", "1080p"),
    "seedance-2.0-value": ("720p", "1080p"),
    "seedance-2.0-fast-value": ("720p", "1080p"),
}
FREEZONE_DEFAULT_VIDEO_RESOLUTION_OPTIONS = ("480p", "720p", "1080p")
FREEZONE_DEFAULT_SEEDANCE2_RESOLUTION_OPTIONS = ("480p", "720p")
FREEZONE_HAPPYHORSE_RESOLUTION_OPTIONS = ("720p", "1080p")
FREEZONE_GROK_VIDEO_CHANNEL_RESOLUTION_OPTIONS = ("720p", "480p")


def _freezone_video_model_from_backend(backend: str | None) -> str:
    text = str(backend or "").strip().lower()
    for prefix in ("newapi_", "huimeng_", "huimengi_"):
        if text.startswith(prefix):
            return text[len(prefix) :].strip()
    return text


def freezone_video_resolution_options(backend: str | None) -> tuple[str, ...]:
    if is_freezone_runpod_h3_backend(backend):
        # H3 ignores the `resolution` parameter entirely (fixed output
        # size) — see `get_freezone_video_model_options()`'s comment on
        # the same backend.
        return ("auto",)
    model = _freezone_video_model_from_backend(backend)
    if model == "grok-video-channel":
        return FREEZONE_GROK_VIDEO_CHANNEL_RESOLUTION_OPTIONS
    if model == "happyhorse-1.0":
        return FREEZONE_HAPPYHORSE_RESOLUTION_OPTIONS
    if model.startswith("seedance-2.0"):
        return FREEZONE_SEEDANCE2_RESOLUTION_OPTIONS_BY_MODEL.get(
            model,
            FREEZONE_DEFAULT_SEEDANCE2_RESOLUTION_OPTIONS,
        )
    return FREEZONE_DEFAULT_VIDEO_RESOLUTION_OPTIONS


def is_freezone_seedance2_value_backend(backend: str | None) -> bool:
    model = _freezone_video_model_from_backend(backend)
    return model in {"seedance-2.0-value", "seedance-2.0-fast-value"}


def default_freezone_seedance2_scene_optimize(backend: str | None) -> str:
    model = _freezone_video_model_from_backend(backend)
    return "realistic" if model == "seedance-2.0-fast-value" else "anime"


def normalize_freezone_seedance2_scene_optimize(
    backend: str | None,
    value: str | None,
) -> str:
    if not is_freezone_seedance2_value_backend(backend):
        return ""
    text = str(value or "").strip().lower()
    if text in {"anime", "realistic"}:
        return text
    return default_freezone_seedance2_scene_optimize(backend)


def normalize_video_resolution_for_backend(
    backend: str | None,
    value: str | None,
    configured_options: list[str] | tuple[str, ...] | None = None,
) -> str:
    resolution = normalize_video_resolution(value)
    configured = tuple(
        str(option).strip()
        for option in (configured_options or ())
        if str(option).strip()
    )
    if configured:
        matched = next(
            (option for option in configured if option.lower() == resolution.lower()),
            None,
        )
        if matched is not None:
            return normalize_video_resolution(matched)
        preferred = next(
            (option for option in configured if option.lower() == "720p"),
            None,
        )
        return normalize_video_resolution(preferred or configured[0])
    options = freezone_video_resolution_options(backend)
    if resolution in options:
        return resolution
    if "720p" in options:
        return "720p"
    return options[0]


def freezone_video_duration_bounds(
    backend: str | None,
) -> tuple[int | None, int | None]:
    return video_duration_bounds_for_backend(backend)


def _freezone_newapi_video_options() -> dict[str, str]:
    from novelvideo.generators.video_generator import newapi_video_backend_options

    options = {
        key: value
        for key, value in newapi_video_backend_options().items()
        if key in FREEZONE_NEWAPI_VIDEO_BACKENDS
    }
    options.setdefault("newapi_happyhorse-1.0", "HappyHorse 1.0")
    if FREEZONE_DEFAULT_VIDEO_BACKEND not in options:
        return options
    ordered = {FREEZONE_DEFAULT_VIDEO_BACKEND: options[FREEZONE_DEFAULT_VIDEO_BACKEND]}
    ordered.update(
        (key, value)
        for key, value in options.items()
        if key != FREEZONE_DEFAULT_VIDEO_BACKEND
    )
    return ordered


FREEZONE_RUNPOD_H3_BACKEND = "runpod_minimax_h3"


def _freezone_runpod_video_options() -> dict[str, str]:
    """RunPod-backed video options for Freezone, dev-only — same visibility
    gate as the main pipeline's own RunPod H3 option (`generation.py`'s
    `/video-backends` route, `_runpod_h3_video_configured()`). Kept
    separate from `_freezone_newapi_video_options()` since these aren't
    `newapi_*` strings and don't come from `newapi_video_backend_options()`
    at all — see `.claude/CLAUDE.md`: Freezone video previously had NO
    RunPod option wired in anywhere, unlike the main pipeline."""
    from novelvideo.config import _runpod_h3_video_configured

    if not _runpod_h3_video_configured():
        return {}
    return {FREEZONE_RUNPOD_H3_BACKEND: "MiniMax-H3 (RunPod, dev)"}


def _freezone_video_options() -> dict[str, str]:
    """All Freezone video options, NewAPI + RunPod, in that order."""
    return {**_freezone_newapi_video_options(), **_freezone_runpod_video_options()}


def is_freezone_runpod_h3_backend(backend: str | None) -> bool:
    return str(backend or "").strip() == FREEZONE_RUNPOD_H3_BACKEND


# MiniMax H3 Multishot (long continuous video, 2026-10-25) — a SEPARATE
# backend id from the 1-shot one above, on a separate RunPod endpoint
# (`RUNPOD_H3_MULTISHOT_ENDPOINT_ID`, gated by
# `config._runpod_h3_multishot_configured()`). Deliberately NOT added to
# `_freezone_runpod_video_options()` (the no-catalog fallback list, which
# emits no `supportedModes` and would make frontend heuristics treat it as
# supporting every mode) — it's only ever exposed via the dev media-model
# catalog entry in `api/routes/freezone.py`'s
# `_freezone_dev_media_model_catalog_entries()`, which DOES declare
# `supportedModes: ["multishot"]`. See `freezone/multishot.py`.
FREEZONE_RUNPOD_H3_MULTISHOT_BACKEND = "runpod_minimax_h3_multishot"


def is_freezone_runpod_h3_multishot_backend(backend: str | None) -> bool:
    return str(backend or "").strip() == FREEZONE_RUNPOD_H3_MULTISHOT_BACKEND


# Smart extend on H3 (2026-10-31). H3 has no "extend this video" task, so the
# continuation is expressed the way the model already understands: the LAST
# frame of the (already trimmed) source clip becomes `<Picture 1>`, pinned at
# frame 0, and the images connected to the extend node stay as the character
# sheets (`<Picture 2..N>`). The source video itself is not sent. A/B on a
# two-character clip showed the preceding-video reference (`<Video 1>`) did
# not improve identity and made the job ~2.7x slower, so it is not used; see
# `.claude/CLAUDE.md` ("H3 extend").
H3_EXTEND_MAX_REFERENCE_IMAGES = 8  # the model takes 9 images, one is the first frame


def extract_last_frame_png(video_path: str | Path, out_path: str | Path) -> Path:
    """Write the final frame of `video_path` to `out_path` (PNG) with ffmpeg."""
    import shutil
    import subprocess

    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg not found on PATH")
    video_path = Path(video_path)
    out_path = Path(out_path)
    if not video_path.exists():
        raise FileNotFoundError(f"video not found: {video_path}")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # No `-frames:v 1`: that would stop after the FIRST frame past the seek point (~0.2s
    # before the end). `-update 1` keeps overwriting the single output file, so the file
    # ends up holding the last decoded frame.
    cmd = [
        "ffmpeg", "-v", "error", "-y", "-sseof", "-0.2", "-i", str(video_path),
        "-update", "1", str(out_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0 or not out_path.exists() or out_path.stat().st_size == 0:
        raise RuntimeError(f"ffmpeg could not extract the last frame: {proc.stderr[-300:]}")
    return out_path


def h3_extend_aspect_ratio(frame_path: str | Path) -> str:
    """H3 only takes 16:9 or 9:16; pick the one matching the source frame."""
    from PIL import Image

    with Image.open(frame_path) as im:
        return "9:16" if im.height >= im.width else "16:9"


def get_freezone_video_model_options() -> list[dict[str, Any]]:
    data: list[dict[str, Any]] = []
    for backend, label in _freezone_newapi_video_options().items():
        duration_bounds = freezone_video_duration_bounds(backend)
        item = {
            "id": backend,
            "providerId": "newapi",
            "provider": "newapi",
            "apiModel": backend,
            "api_model": backend,
            "label": label,
            "backend": backend,
            "resolutionOptions": list(freezone_video_resolution_options(backend)),
            "resolution_options": list(freezone_video_resolution_options(backend)),
            "minDuration": duration_bounds[0],
            "min_duration": duration_bounds[0],
            "maxDuration": duration_bounds[1],
            "max_duration": duration_bounds[1],
        }
        if is_freezone_seedance2_value_backend(backend):
            item.update(
                {
                    "sceneOptimizeOptions": ["anime", "realistic"],
                    "scene_optimize_options": ["anime", "realistic"],
                    "defaultSceneOptimize": default_freezone_seedance2_scene_optimize(
                        backend
                    ),
                    "default_scene_optimize": default_freezone_seedance2_scene_optimize(
                        backend
                    ),
                }
            )
        data.append(item)
    for backend, label in _freezone_runpod_video_options().items():
        duration_bounds = freezone_video_duration_bounds(backend)
        data.append(
            {
                "id": backend,
                "providerId": "runpod",
                "provider": "runpod",
                "apiModel": backend,
                "api_model": backend,
                "label": label,
                "backend": backend,
                # H3 ignores the `resolution` parameter entirely (fixed
                # output size — see `generators/runpod_minimax_h3_video.py`);
                # a single placeholder option keeps the picker from
                # offering a 480p/720p/1080p choice that does nothing,
                # same as the main pipeline leaving `resolution_options`
                # unset for this backend (`generation.py`'s `/video-backends`).
                "resolutionOptions": ["auto"],
                "resolution_options": ["auto"],
                "minDuration": duration_bounds[0],
                "min_duration": duration_bounds[0],
                "maxDuration": duration_bounds[1],
                "max_duration": duration_bounds[1],
            }
        )
    return data


def get_freezone_video_model_names() -> list[str]:
    return list(_freezone_video_options().keys())


def resolve_freezone_video_backend(model: str | None) -> str:
    text = str(model or "").strip()
    options = _freezone_video_options()
    if not text:
        return (
            FREEZONE_DEFAULT_VIDEO_BACKEND
            if FREEZONE_DEFAULT_VIDEO_BACKEND in options
            else next(iter(options))
        )
    if text in options:
        return text
    if text in FREEZONE_DISABLED_VIDEO_BACKENDS:
        raise ValueError(f"unknown video model: {text}")

    folded = text.casefold()
    for backend, label in options.items():
        if label.casefold() == folded:
            return backend

    alias = LEGACY_FREEZONE_VIDEO_BACKEND_ALIASES.get(text)
    if alias:
        return alias
    label_alias = LEGACY_FREEZONE_VIDEO_LABEL_ALIASES.get(folded)
    if label_alias:
        return label_alias

    from novelvideo.generators.video_generator import parse_newapi_video_backend

    if (
        parse_newapi_video_backend(text)
        and text not in FREEZONE_DISABLED_VIDEO_BACKENDS
    ):
        return text
    raise ValueError(f"unknown video model: {text}")


def is_freezone_seedance2_backend(backend: str | None) -> bool:
    text = str(backend or "").strip()
    if text == "seedance_2":
        return True

    from novelvideo.generators.huimengi import parse_huimeng_video_backend
    from novelvideo.generators.video_generator import parse_newapi_video_backend

    model = parse_newapi_video_backend(text) or parse_huimeng_video_backend(text)
    return bool(model and model.startswith("seedance-2.0"))


def is_freezone_seedance_backend(backend: str | None) -> bool:
    """Seedance of any generation (1.0/1.5/2.x) -- the reference image size rules only hold for them."""
    text = str(backend or "").strip()
    if text in {"seedance_2", "seedance_fast"}:
        return True

    from novelvideo.generators.huimengi import parse_huimeng_video_backend
    from novelvideo.generators.video_generator import parse_newapi_video_backend

    model = parse_newapi_video_backend(text) or parse_huimeng_video_backend(text)
    return bool(model and model.startswith("seedance"))


def is_freezone_happyhorse_backend(backend: str | None) -> bool:
    from novelvideo.generators.video_generator import parse_newapi_video_backend

    model = parse_newapi_video_backend(backend) or _freezone_video_model_from_backend(
        backend
    )
    return model == "happyhorse-1.0"


def _coarse_mark_region(mark: dict[str, Any]) -> str:
    px = mark.get("point_x")
    py = mark.get("point_y")
    if not isinstance(px, (int, float)) or not isinstance(py, (int, float)):
        box_x = mark.get("box_x")
        box_y = mark.get("box_y")
        box_width = mark.get("box_width")
        box_height = mark.get("box_height")
        if all(
            isinstance(value, (int, float))
            for value in [box_x, box_y, box_width, box_height]
        ):
            px = float(box_x) + float(box_width) / 2.0
            py = float(box_y) + float(box_height) / 2.0
    if isinstance(px, (int, float)) and isinstance(py, (int, float)):
        horizontal = "left" if px < 0.33 else "right" if px > 0.66 else "center"
        vertical = "top" if py < 0.33 else "bottom" if py > 0.66 else "middle"
        return f"{vertical} {horizontal}"
    return ""


def format_video_marks(marks: list[dict[str, Any]] | None) -> str:
    clean_marks = [
        mark for mark in (marks or []) if str(mark.get("label") or "").strip()
    ]
    if not clean_marks:
        return ""

    lines: list[str] = []
    for mark in clean_marks:
        label = str(mark.get("label") or "").strip()
        region = _coarse_mark_region(mark)
        note = str(mark.get("note") or "").strip()
        suffix_parts = [part for part in [region, note] if part]
        suffix = f" ({', '.join(suffix_parts)})" if suffix_parts else ""
        lines.append(f"- {label}{suffix}")
    return "Key element marks:\n" + "\n".join(lines)


def build_freezone_video_prompt(
    *,
    user_prompt: str,
    camera_template_id: str | None = None,
    character_names: list[str] | None = None,
    marks: list[dict[str, Any]] | None = None,
) -> str:
    parts = [str(user_prompt or "").strip()]

    template = get_video_camera_template(camera_template_id)
    if template:
        parts.append(f"Camera movement template: {template['name']}. {template['prompt']}")

    if character_names:
        joined = ", ".join(name for name in character_names if name)
        if joined:
            parts.append(
                f"Character consistency requirement: keep the appearance, clothing and identity traits of {joined} stable and consistent."
            )

    marks_block = format_video_marks(marks)
    if marks_block:
        parts.append(marks_block)

    parts.append(
        "Output requirement: generate a single coherent video shot with natural action and smooth motion, avoiding flicker, deformation, frame skipping and subject identity drift."
    )
    return "\n".join(part for part in parts if part)


def build_freezone_image_to_video_prompt(
    *,
    user_prompt: str = "",
    camera_template_id: str | None = None,
    marks: list[dict[str, Any]] | None = None,
    reference_image_count: int = 1,
) -> str:
    parts: list[str] = []

    if user_prompt and user_prompt.strip():
        parts.append(user_prompt.strip())

    template = get_video_camera_template(camera_template_id)
    if template:
        parts.append(f"Camera movement template: {template['name']}. {template['prompt']}")

    marks_block = format_video_marks(marks)
    if marks_block:
        parts.append(marks_block)

    # With 0 images, add nothing: video editing reuses this builder (the video-edit
    # endpoint in routes/freezone.py), and writing "use the input image as the subject..."
    # when there is no reference image describes material that does not exist -- the
    # vendor infers the task type from the prompt, so such made-up wording only misleads it.
    image_count = 1 if reference_image_count is None else int(reference_image_count)
    if image_count > 1:
        parts.append(
            "Image reference constraint: combine the multiple input images, prioritizing consistent subject identity, appearance, clothing, scene cues and overall style, "
            "and do not collage the images into a multi-panel picture."
        )
    elif image_count == 1:
        parts.append(
            "Image reference constraint: use the input images as references for subject, appearance, color tone, texture and overall style, with the prompt driving the video content; "
            "do not force the input image to be locked as the first frame of the video."
        )
    parts.append(
        "Output requirement: generate a single coherent video shot with natural action and smooth motion, avoiding flicker, deformation, frame skipping and subject identity drift."
    )
    return "\n".join(part for part in parts if part)


# "Video extension" and the canvas "smart continuation" share the same requirement sentence: to the vendor they are the same kind of task.
VIDEO_EXTEND_REQUIREMENT = (
    "Video extension requirement: continue generating from the end of the input video, keeping subject identity, scene, lighting, camera movement, "
    "sound and narrative continuous, without redoing or editing what the input video already contains."
)


def build_freezone_video_extend_prompt(
    *,
    user_prompt: str,
    camera_template_id: str | None = None,
) -> str:
    """Build an explicit continuation prompt without reference/edit wording."""

    parts = [str(user_prompt or "").strip()]
    template = get_video_camera_template(camera_template_id)
    if template:
        parts.append(f"Camera movement template: {template['name']}. {template['prompt']}")
    parts.append(VIDEO_EXTEND_REQUIREMENT)
    return "\n".join(part for part in parts if part)


def build_freezone_keyframe_video_prompt(
    *,
    user_prompt: str = "",
    camera_template_id: str | None = None,
    marks: list[dict[str, Any]] | None = None,
    has_first_frame: bool = True,
    has_last_frame: bool = True,
) -> str:
    parts: list[str] = []

    if user_prompt and user_prompt.strip():
        parts.append(user_prompt.strip())

    template = get_video_camera_template(camera_template_id)
    if template:
        parts.append(f"Camera movement template: {template['name']}. {template['prompt']}")

    marks_block = format_video_marks(marks)
    if marks_block:
        parts.append(marks_block)

    if has_first_frame and has_last_frame:
        parts.append(
            "First/last frame constraint: transition strictly and naturally from the first frame to the last frame, keeping subject identity, compositional logic, lighting and scene continuous."
        )
    elif has_first_frame:
        parts.append(
            "First frame constraint: strictly inherit the subject, composition, clothing, lighting and scene information of the input image, and use the input image as the first-frame reference of the video."
        )
    elif has_last_frame:
        parts.append(
            "Last frame constraint: use the input image as the target closing frame, making sure the shot finally lands naturally on that subject state and composition."
        )

    parts.append(
        "Output requirement: generate a single coherent video shot with natural action and smooth motion, avoiding flicker, deformation, frame skipping, subject identity drift and first/last frame jumps."
    )
    return "\n".join(part for part in parts if part)


def build_freezone_omni_video_prompt(
    *,
    user_prompt: str,
    theme: str = "",
    camera_template_id: str | None = None,
    marks: list[dict[str, Any]] | None = None,
    reference_items: list[dict[str, Any]] | None = None,
    continuation: bool = False,
) -> str:
    """continuation: canvas "smart continuation". The requirement matches "video extension"
    and omits the omni-reference wording (whose "this is a video reference for generating a
    new video" is the opposite of continuation)."""

    parts = [str(user_prompt or "").strip()]

    if theme and theme.strip():
        parts.append(f"Theme requirement: {theme.strip()}")

    template = get_video_camera_template(camera_template_id)
    if template:
        parts.append(f"Camera movement template: {template['name']}. {template['prompt']}")

    marks_block = format_video_marks(marks)
    if marks_block:
        parts.append(marks_block)

    if continuation:
        parts.append(VIDEO_EXTEND_REQUIREMENT)
        return "\n".join(part for part in parts if part)

    parts.append(
        "Omni-reference mode requirement: model the text, image, video, audio, file and web link references together, "
        "prioritizing subject identity, scene continuity, style consistency and natural action."
    )
    counts = summarize_omni_reference_counts(reference_items or [])
    single_video_reference_instruction = "This is generating a new video from a video reference, not video editing."
    if (
        counts["video_count"] == 1
        and counts["image_count"] == 0
        and counts["audio_count"] == 0
        and counts["file_count"] == 0
        and counts["link_count"] == 0
        and single_video_reference_instruction not in "\n".join(parts)
    ):
        parts.append(single_video_reference_instruction)
    parts.append(
        "Output requirement: generate a single coherent video shot with natural action and smooth motion, avoiding flicker, deformation, frame skipping and subject identity drift."
    )
    return "\n".join(part for part in parts if part)


def summarize_omni_reference_counts(items: list[dict[str, Any]]) -> dict[str, int]:
    image_count = sum(1 for item in items if str(item.get("type")) == "image")
    video_count = sum(1 for item in items if str(item.get("type")) == "video")
    audio_count = sum(1 for item in items if str(item.get("type")) == "audio")
    file_count = sum(1 for item in items if str(item.get("type")) == "file")
    link_count = sum(1 for item in items if str(item.get("type")) == "link")
    return {
        "image_count": image_count,
        "video_count": video_count,
        "audio_count": audio_count,
        "file_count": file_count,
        "link_count": link_count,
        "total_count": image_count + video_count + audio_count + file_count + link_count,
    }


def validate_omni_reference_limits(
    items: list[dict[str, Any]],
    *,
    image_max: int = 9,
    video_max: int = 3,
    audio_max: int = 3,
    file_max: int = 0,
    link_max: int = 0,
    total_max: int = 12,
) -> None:
    counts = summarize_omni_reference_counts(items)
    if counts["total_count"] > total_max:
        raise ValueError(f"references total count must be <= {total_max}")
    if counts["image_count"] > image_max:
        raise ValueError(f"image references count must be <= {image_max}")
    if counts["video_count"] > video_max:
        raise ValueError(f"video references count must be <= {video_max}")
    if counts["audio_count"] > audio_max:
        raise ValueError(f"audio references count must be <= {audio_max}")
    if counts["file_count"] > file_max:
        raise ValueError(f"file references count must be <= {file_max}")
    if counts["link_count"] > link_max:
        raise ValueError(f"link references count must be <= {link_max}")
    if counts["file_count"] and counts["link_count"]:
        raise ValueError("reference_file and reference_link are mutually exclusive")


# Hard rules of Volcengine Seedance for reference images (measured from 400 responses):
#   `[InvalidParameter.HeightTooSmall] Height must be between 300px and 6000px.`
# Aspect ratio 0.4~2.5 is the same pair of numbers used by the storyboard path in seedance2_i2v/assets.py.
MIN_OMNI_REFERENCE_IMAGE_PX = 300
MAX_OMNI_REFERENCE_IMAGE_PX = 6000
MIN_OMNI_REFERENCE_IMAGE_ASPECT = 0.4
MAX_OMNI_REFERENCE_IMAGE_ASPECT = 2.5


def _read_reference_image_size(path: Path) -> tuple[int, int] | None:
    """Read only the file header to get the size; if it cannot be read (file missing / not an image), return None and leave it to the vendor to judge."""
    try:
        from PIL import Image

        with Image.open(path) as img:
            width, height = img.size
    except Exception:  # noqa: BLE001 - never block a request on behalf of the vendor because of any read failure
        return None
    if width <= 0 or height <= 0:
        return None
    return int(width), int(height)


def validate_omni_reference_image_dimensions(
    paths: list[str | Path | None],
    *,
    min_px: int = MIN_OMNI_REFERENCE_IMAGE_PX,
    max_px: int = MAX_OMNI_REFERENCE_IMAGE_PX,
    min_aspect: float = MIN_OMNI_REFERENCE_IMAGE_ASPECT,
    max_aspect: float = MAX_OMNI_REFERENCE_IMAGE_ASPECT,
) -> None:
    """Fallback validation of reference image sizes: block images the vendor will certainly reject before enqueueing, saving one pre-deduction + upload + refund.

    Same convention as `validate_omni_reference_audio_durations`: entries whose size cannot be read **do not take part in the judgment**.
    Out-of-range side length is reported first, then aspect ratio; when both occur, only the former is reported.
    """
    out_of_range: list[str] = []
    bad_aspect: list[str] = []
    for raw in paths:
        text = str(raw or "").strip()
        if not text:
            continue
        path = Path(text)
        size = _read_reference_image_size(path)
        if size is None:
            continue
        width, height = size
        label = path.name or text
        if not (min_px <= width <= max_px and min_px <= height <= max_px):
            out_of_range.append(f"{label} ({width}x{height})")
            continue
        aspect = width / height
        if not (min_aspect <= aspect <= max_aspect):
            bad_aspect.append(f"{label} ({width}x{height}, {aspect:.2f})")
    if out_of_range:
        raise ValueError(
            f"Reference image size does not meet the requirements: width and height must be between {min_px} and {max_px} pixels: "
            + ", ".join(out_of_range)
        )
    if bad_aspect:
        raise ValueError(
            f"Reference image aspect ratio must be between {min_aspect:g} and {max_aspect:g}: "
            + ", ".join(bad_aspect)
        )


def effective_video_human_review(
    requested: bool,
    *,
    gen_mode: str | None,
    reference_items: list[dict] | None,
    last_frame_path: str | None = None,
) -> bool:
    """Review applies to visual input materials, never text-to-video requests."""
    if not requested or gen_mode in {"textToVideo", "text_to_video"}:
        return False
    return bool(last_frame_path and last_frame_path.strip()) or any(
        str(item.get("type") or "image") in {"image", "video"}
        and bool(str(item.get("path") or "").strip())
        for item in (reference_items or [])
    )


async def run_trusted_freezone_video_gen(
    *,
    project_dir: Path,
    job_id: str,
    prompt: str,
    egress_context: object,
    task_type: str,
    episode: int,
    beat_num: int,
    scope: str,
    reference_items: list[dict[str, str]] | None = None,
    aspect_ratio: str = "16:9",
    resolution: str = "720p",
    duration_seconds: int = 5,
    generate_audio: bool = False,
    human_review: bool = False,
    scene_optimize: str | None = None,
    backend: str = "newapi_seedance-2.0-fast",
    last_frame_path: str | None = None,
    audio_setting: str | None = None,
    gen_mode: str | None = None,
    model_params: dict[str, Any] | None = None,
    request_schema: dict[str, Any] | None = None,
) -> Path:
    """Run the Freezone video leaf without losing its verified egress context."""

    from novelvideo.freezone.jobs import outputs_dir
    from novelvideo.generators.video_generator import (
        ShotReference,
        VideoGenStatus,
        create_video_generator,
    )

    output_path = outputs_dir(project_dir, "freezone_video_gen") / f"{job_id}.mp4"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    references = [
        ShotReference(
            str(item.get("type") or "image"),
            str(item.get("path") or ""),
            str(item.get("role") or ""),
        )
        for item in (reference_items or [])
        if str(item.get("path") or "").strip()
    ]
    generator = create_video_generator(
        backend=backend,
        resolution=resolution,
        generate_audio=generate_audio,
        model_params=model_params,
        request_schema=request_schema,
        egress_context=egress_context,
    )
    first_image = next((ref for ref in references if ref.type == "image"), None)
    generate_kwargs: dict[str, Any] = {
        "image_path": first_image.path if first_image is not None else None,
        "prompt": prompt,
        "output_path": str(output_path),
        "aspect_ratio": aspect_ratio,
        "duration": float(duration_seconds),
        "last_frame_path": last_frame_path,
        "references": references,
        "human_review": effective_video_human_review(
            human_review,
            gen_mode=gen_mode,
            reference_items=reference_items,
            last_frame_path=last_frame_path,
        ),
        "seedance2_config": (
            {"scene_optimize": scene_optimize} if scene_optimize else None
        ),
        "gen_mode": gen_mode,
        "egress_context": egress_context,
        "task_type": task_type,
        "episode": episode,
        "beat_num": beat_num,
        "scope": scope,
    }
    if audio_setting:
        generate_kwargs["audio_setting"] = audio_setting
    result = await generator.generate(**generate_kwargs)
    if not result or result.status is not VideoGenStatus.DONE:
        error = result.error if result else "video generation failed"
        raise RuntimeError(f"freezone video generation failed: {error}")
    if not output_path.exists():
        raise RuntimeError("video generation returned success without output")
    return output_path

# Omni-reference audio duration: the vendor (doubao-seedance-2-0 / r2v) has **two independent** rules,
# both rejected with a 400, so checking only one of them is as good as checking neither:
#   1. Per item: `[InvalidParameter.DurationTooShort] Duration must be between 1.8s and 15.2s`
#   2. Total: `the parameter audio total duration (seconds) specified in the request must
#      be less than or equal to 15.2 for model doubao-seedance-2-0 in r2v`
#
# Rule 2 was measured on 2026-08-06 from two failed tasks in the 3060 environment
# (freezone_video_gen/01KZ5R8ZZZY9M8T9F01H159RP7, gen_mode=allReference). Before that,
# both frontend and backend judged only by rule 1: three clips of 6s each are all individually legal, yet the 18s total is certain to be rejected by the vendor -- the user waited for nothing.
# Do not delete the total-duration rule again as "a rule we imagined ourselves".
MIN_OMNI_REFERENCE_AUDIO_SECONDS = 1.8
MAX_OMNI_REFERENCE_AUDIO_SECONDS = 15.2
MAX_OMNI_REFERENCE_AUDIO_TOTAL_SECONDS = 15.2


def _format_seconds(value: float) -> str:
    """Display with millisecond precision, dropping meaningless trailing zeros: 15.2 -> `15.2`, 6.0 -> `6`, 1.799 -> `1.799`.

    Do not use `round(x, 1)`: when 15.201 is displayed as "15.2", the user sees exactly the legal boundary value yet is told
    it is out of range, and can only suspect that we miscalculated. The frontend `formatClipSeconds` follows the same convention.
    """
    return f"{value:.3f}".rstrip("0").rstrip(".")


def _exceeds(value: float, limit: float) -> bool:
    """`value > limit`, but first normalized to milliseconds.

    Floating-point sums drift on their own: 6 + 6 + 3.2 == 15.200000000000001, and a bare comparison would judge a set of legal audio that exactly hits the
    15.2s cap as over the limit.
    """
    return round(value - limit, 3) > 0


def validate_omni_reference_audio_durations(
    durations: list[tuple[str, float | None]],
    *,
    min_seconds: float | None = MIN_OMNI_REFERENCE_AUDIO_SECONDS,
    max_seconds: float | None = MAX_OMNI_REFERENCE_AUDIO_SECONDS,
    total_min_seconds: float | None = None,
    total_max_seconds: float | None = MAX_OMNI_REFERENCE_AUDIO_TOTAL_SECONDS,
    media_label: str = "audio",
) -> None:
    """Fallback validation of omni-reference audio durations; the input is `(label, seconds)`, with seconds None = could not be probed.

    Entries that cannot be probed **do not take part in the judgment**: when ffprobe is missing or a file cannot be read, better to let it through and let the vendor decide
    than to block a normal submission out of thin air. This makes the total a **lower bound**, but the direction of the judgment stays safe -- an omission can only
    make the sum smaller, so "computed to exceed" is certainly a true excess, and no false block can result.

    Each of the three limits may be passed as `None` = **this item is not judged**. The per-item bound (1.8~15.2s) was measured from the Seedance 2.0
    responses and only holds for it; when an admin configures a total duration in the catalog but the model is not 2.0, the caller
    should pass None for min/max -- applying the 2.0 numbers to other vendors' models would be a made-up 400.

    Too short -> a single item too long -> total too long, reported by category; when several are out of range at once, reporting one category at a time reads better than listing them mixed together.
    """
    measured = [
        (label, float(seconds))
        for label, seconds in durations
        if isinstance(seconds, (int, float))
        and not isinstance(seconds, bool)
        and seconds > 0
    ]
    if not measured:
        return

    def _clips(items: list[tuple[str, float]]) -> str:
        return ", ".join(f"{label} ({_format_seconds(value)}s)" for label, value in items)

    too_short = (
        [item for item in measured if _exceeds(min_seconds, item[1])]
        if min_seconds is not None
        else []
    )
    if too_short:
        raise ValueError(
            f"{media_label} reference duration must be >= {_format_seconds(min_seconds)}s: "
            + _clips(too_short)
        )
    too_long = (
        [item for item in measured if _exceeds(item[1], max_seconds)]
        if max_seconds is not None
        else []
    )
    if too_long:
        raise ValueError(
            f"{media_label} reference duration must be <= {_format_seconds(max_seconds)}s: "
            + _clips(too_long)
        )
    total = sum(value for _, value in measured)
    # The lower bound on total duration can only be judged when every clip was probed successfully; a missed probe makes the sum smaller and must not cause a false block.
    if (
        total_min_seconds is not None
        and len(measured) == len(durations)
        and _exceeds(total_min_seconds, total)
    ):
        raise ValueError(
            f"{media_label} references total duration must be >= "
            f"{_format_seconds(total_min_seconds)}s, got {_format_seconds(total)}s: "
            + _clips(measured)
        )
    if total_max_seconds is not None and _exceeds(total, total_max_seconds):
        raise ValueError(
            f"{media_label} references total duration must be <= "
            f"{_format_seconds(total_max_seconds)}s, got {_format_seconds(total)}s: "
            + _clips(measured)
        )


def video_character_library_path(project_dir: Path) -> Path:
    return freezone_root(project_dir) / "video_character_library.json"


# The critical section is just a read-modify-write of two small JSON files, normally milliseconds; if the lock still cannot be acquired after this long, the holder is stuck.
_LIBRARY_LOCK_TIMEOUT_SECONDS = 30.0
_LIBRARY_LOCK_RETRY_INTERVAL_SECONDS = 0.02


@contextmanager
def _library_lock(project_dir: Path) -> Iterator[None]:
    """Serialize the "read -> modify -> write" of the two asset-library JSON files (items + folders).

    With multiple API worker processes, concurrent registrations each read the same stale list and write the whole list back, so the later write
    wipes out the earlier one -- upload 4 and only 2 remain. Items and folders share one lock, because deleting a folder
    has to change both files at once. The lock is not reentrant: while holding it, do not call other locking functions in this module.

    portalocker is used rather than fcntl: Windows has no fcntl, and failing to take the lock must raise, never
    be silently let through. Non-blocking + retry is used because Windows blocking locks carry a fixed timeout, which behaves differently from POSIX.
    """
    lock_path = freezone_root(project_dir) / "video_character_library.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + _LIBRARY_LOCK_TIMEOUT_SECONDS
    with open(lock_path, "a+", encoding="utf-8") as lock_file:
        while True:
            try:
                portalocker.lock(lock_file, portalocker.LOCK_EX | portalocker.LOCK_NB)
                break
            except portalocker.exceptions.AlreadyLocked as exc:
                # Retry only on contention; other lock failures (e.g. a mount that does not support locks) are re-raised immediately.
                if time.monotonic() >= deadline:
                    raise TimeoutError(
                        f"asset library lock busy: {lock_path}"
                    ) from exc
                time.sleep(_LIBRARY_LOCK_RETRY_INTERVAL_SECONDS)
        try:
            yield
        finally:
            portalocker.unlock(lock_file)


def _write_json_atomic(path: Path, data: Any) -> None:
    """Write a temp file first, then os.replace, so readers never see a half-written JSON.

    load_* returns an empty list on a parse failure, and once a truncated file is read and written back, the whole library is wiped.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix=f"{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_path, path)
    except BaseException:
        Path(temp_path).unlink(missing_ok=True)
        raise


def load_video_character_library(project_dir: Path) -> list[dict[str, Any]]:
    path = video_character_library_path(project_dir)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict)]


def save_video_character_library(
    project_dir: Path, items: list[dict[str, Any]]
) -> None:
    _write_json_atomic(video_character_library_path(project_dir), items)


LIBRARY_CATEGORIES = ("other", "character", "scene", "prop", "style", "audio")

# Asset library directory tree. Folders (save location) and categories (labels) are two independent dimensions: a category only says
# "what this asset is for", while a folder says "where it is put". There are two system folders -- everything synced from the mainline always goes
# into mainline; local uploads default to other (the frontend shows it as "Unsorted assets"). A category key
# also serves as the key of the same-named system folder, so old items (with no folder field) can be placed by category,
# with no data migration. User-created folders use random ids and cannot collide with these reserved keys.
MAINLINE_FOLDER_KEY = "mainline"
RESERVED_FOLDER_KEYS = (MAINLINE_FOLDER_KEY, *LIBRARY_CATEGORIES)
# Keep in sync with the system folder names in the frontend assetLibraryItems.ts, to prevent users from creating folders with the same names.
RESERVED_FOLDER_NAMES = ("Mainline", "Unsorted assets", "Other", "Characters", "Scenes", "Props", "Style", "Sound effects")
FOLDER_NAME_MAX_LEN = 20


def video_character_folders_path(project_dir: Path) -> Path:
    return freezone_root(project_dir) / "video_character_folders.json"


def load_video_character_folders(project_dir: Path) -> list[dict[str, Any]]:
    """Read the user-created asset library folders (system folders are not persisted; the frontend generates them from reserved keys)."""
    path = video_character_folders_path(project_dir)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict) and item.get("id")]


def save_video_character_folders(project_dir: Path, folders: list[dict[str, Any]]) -> None:
    _write_json_atomic(video_character_folders_path(project_dir), folders)


def add_video_character_folder(project_dir: Path, *, name: str) -> dict[str, Any]:
    """Create an asset library folder. A duplicate name (including system folder names) is rejected outright, to avoid two same-named entries in the directory."""
    clean = name.strip()
    with _library_lock(project_dir):
        folders = load_video_character_folders(project_dir)
        _validate_folder_name(clean, folders)
        folder = {
            "id": uuid.uuid4().hex[:12],
            "name": clean,
            "created_at": datetime.now().isoformat(),
        }
        folders.append(folder)
        save_video_character_folders(project_dir, folders)
    return folder


def _validate_folder_name(clean: str, folders: list[dict[str, Any]], *, skip_id: str = "") -> None:
    """Validation shared by create/rename: non-empty, not too long, not colliding with system names, not duplicating another folder."""
    if not clean:
        raise ValueError("folder name is required")
    if len(clean) > FOLDER_NAME_MAX_LEN:
        raise ValueError(f"folder name must be <= {FOLDER_NAME_MAX_LEN} characters")
    if clean in RESERVED_FOLDER_NAMES:
        raise ValueError(f"folder name is reserved: {clean}")
    for folder in folders:
        if skip_id and str(folder.get("id")) == skip_id:
            continue
        if str(folder.get("name") or "").strip() == clean:
            raise ValueError(f"folder already exists: {clean}")


def update_video_character_folder(
    project_dir: Path,
    folder_id: str,
    *,
    name: str | None = None,
    cover: str | None = None,
) -> dict[str, Any] | None:
    """Rename / change the cover. Only the passed fields are touched; passing neither is treated as a no-op.

    The cover stores the URL of the asset itself (the frontend picks one from the folder), so no extra file management is needed;
    after the asset is deleted the cover points to a dead URL, and the frontend simply renders the default cover.
    """
    with _library_lock(project_dir):
        folders = load_video_character_folders(project_dir)
        target = next((f for f in folders if str(f.get("id")) == folder_id), None)
        if target is None:
            return None
        if name is not None:
            clean = name.strip()
            _validate_folder_name(clean, folders, skip_id=folder_id)
            target["name"] = clean
        if cover is not None:
            target["cover"] = cover.strip() or None
        save_video_character_folders(project_dir, folders)
    return target


def delete_video_character_folder(project_dir: Path, folder_id: str) -> int | None:
    """Empty the whole cabinet: delete the folder itself along with the asset items inside it.

    Returns the number of asset items deleted; returns ``None`` if the folder does not exist. System folders (the mainline / same-named category
    directories) are not persisted, so they never reach here -- the route layer finds no such id and returns 404 directly.
    """
    with _library_lock(project_dir):
        folders = load_video_character_folders(project_dir)
        kept_folders = [f for f in folders if str(f.get("id")) != folder_id]
        if len(kept_folders) == len(folders):
            return None
        items = load_video_character_library(project_dir)
        kept_items = [item for item in items if str(item.get("folder") or "") != folder_id]
        removed = len(items) - len(kept_items)
        if removed:
            save_video_character_library(project_dir, kept_items)
        save_video_character_folders(project_dir, kept_folders)
    return removed


def library_folder_keys(project_dir: Path) -> set[str]:
    """Folder keys currently usable as a "save location": the reserved system keys + user-created folder ids."""
    keys = set(RESERVED_FOLDER_KEYS)
    for folder in load_video_character_folders(project_dir):
        keys.add(str(folder.get("id")))
    return keys


def _resolve_library_folder(
    folder: str | None,
    *,
    existing: dict[str, Any] | None,
    source: str,
    category: str,
) -> str:
    """Decide which folder an item lands in, consistent with the placement logic of the frontend assetLibraryItems.ts.

    An explicit value takes priority; next, keep the position the item already has (repeated sync/registration must not wash out a
    position the user has arranged); finally the fallback -- items synced from the mainline go into mainline, local uploads go by category into the same-named system
    folder (unclassified ones are other, i.e. "Unsorted assets").
    """
    if folder:
        return str(folder)
    if existing is not None:
        kept = existing.get("folder")
        if kept:
            return str(kept)
    if source != "upload":
        return MAINLINE_FOLDER_KEY
    return category


def _resolve_library_category(
    category: str | None,
    *,
    existing: dict[str, Any] | None,
    source: str,
    media: str,
) -> str:
    """Decide the usage category of an item, consistent with deriveCategory in the frontend assetLibraryItems.ts.

    An explicitly passed category takes priority; next, keep the category the item already has (repeated mainline sync must not wash out a category the user has
    sorted); finally fall back by source/medium -- characters/scenes/props match their kind, audio goes to sound effects, the rest goes to other.
    """
    if category in LIBRARY_CATEGORIES:
        return str(category)
    if existing is not None:
        kept = existing.get("category")
        if kept in LIBRARY_CATEGORIES:
            return str(kept)
    if source in ("character", "scene", "prop"):
        return source
    return "audio" if media == "audio" else "other"


def _upsert_library_item(
    items: list[dict[str, Any]],
    *,
    name: str,
    image_urls: list[str] | None,
    media: str,
    source: str,
    video_url: str | None,
    audio_url: str | None,
    item_id: str | None,
    category: str | None = None,
    folder: str | None = None,
) -> dict[str, Any]:
    """Pure in-memory upsert: update in place by id or append to ``items``, returning the written item.

    Does no disk IO, shared by single registration and batch sync (the latter needs only one read and one write).
    """
    now = datetime.now().isoformat()
    urls = list(image_urls or [])
    if media == "video":
        cover = video_url
    elif media == "audio":
        cover = None
    else:
        cover = urls[0] if urls else None
    resolved_id = item_id or uuid.uuid4().hex[:12]
    existing_idx = next(
        (i for i, it in enumerate(items) if it.get("id") == resolved_id), None
    )
    existing = items[existing_idx] if existing_idx is not None else None
    resolved_category = _resolve_library_category(
        category, existing=existing, source=source, media=media
    )
    item = {
        "id": resolved_id,
        "name": name.strip(),
        "media": media,
        "source": source,
        "category": resolved_category,
        "folder": _resolve_library_folder(
            folder, existing=existing, source=source, category=resolved_category
        ),
        "image_urls": urls,
        "video_url": video_url,
        "audio_url": audio_url,
        "cover_url": cover,
        "created_at": existing.get("created_at") if existing else now,
        "updated_at": now,
    }
    if existing_idx is not None:
        items[existing_idx] = item
    else:
        items.append(item)
    return item


def add_video_character_library_item(
    project_dir: Path,
    *,
    name: str,
    image_urls: list[str] | None = None,
    media: str = "image",
    source: str = "upload",
    video_url: str | None = None,
    audio_url: str | None = None,
    item_id: str | None = None,
    category: str | None = None,
    folder: str | None = None,
) -> dict[str, Any]:
    """Register one asset in the asset library.

    Images go through ``image_urls``, video/audio go through ``video_url`` / ``audio_url``. When ``item_id`` is
    non-empty, upsert by id (mainline sync uses stable synthetic ids, so repeated sync updates rather than adds).
    ``category`` is the usage category (label) and ``folder`` is the save location; the two do not affect each other, and when omitted they are
    derived by source/medium and by category respectively.
    """
    with _library_lock(project_dir):
        items = load_video_character_library(project_dir)
        item = _upsert_library_item(
            items,
            name=name,
            image_urls=image_urls,
            media=media,
            source=source,
            video_url=video_url,
            audio_url=audio_url,
            item_id=item_id,
            category=category,
            folder=folder,
        )
        save_video_character_library(project_dir, items)
    return item


# Asset names are for display only; give a generous cap so that nobody can paste a whole block of copy and blow up the list.
LIBRARY_ITEM_NAME_MAX_LEN = 60


def rename_video_character_library_item(
    project_dir: Path, item_id: str, *, name: str
) -> dict[str, Any] | None:
    """Rename an asset library item. Returns ``None`` if the item does not exist; raises ``ValueError`` if the name is invalid.

    Only ``name`` and ``updated_at`` are touched: URL / category / save location are left alone, and nodes on the canvas that already reference
    the asset are unaffected. Unlike folder renaming, asset names need not be unique -- same-named assets in the library are
    normal (multiple reference images of the same character).
    """
    clean = name.strip()
    if not clean:
        raise ValueError("item name is required")
    if len(clean) > LIBRARY_ITEM_NAME_MAX_LEN:
        raise ValueError(f"item name must be <= {LIBRARY_ITEM_NAME_MAX_LEN} characters")
    with _library_lock(project_dir):
        items = load_video_character_library(project_dir)
        target = next((item for item in items if str(item.get("id")) == item_id), None)
        if target is None:
            return None
        target["name"] = clean
        target["updated_at"] = datetime.now().isoformat()
        save_video_character_library(project_dir, items)
    return target


def delete_video_character_library_item(project_dir: Path, item_id: str) -> bool:
    with _library_lock(project_dir):
        items = load_video_character_library(project_dir)
        kept = [item for item in items if item.get("id") != item_id]
        if len(kept) == len(items):
            return False
        save_video_character_library(project_dir, kept)
    return True


def sync_mainline_assets_into_library(
    project_dir: Path,
    *,
    assets: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Idempotently write mainline assets (name/url/media/source/id already resolved) into the asset library.

    Each entry of ``assets`` looks like ``{"id","name","media","source","url"}``. Upsert by stable synthetic id,
    so repeated sync only updates URLs and produces no duplicate items. Returns the full library after the sync.

    The whole batch reads the library file once and writes it once (per-item upsert in memory), avoiding the O(N^2) IO of
    N assets triggering N full load+save cycles.
    """
    with _library_lock(project_dir):
        items = load_video_character_library(project_dir)
        changed = False
        for asset in assets:
            media = str(asset.get("media") or "image")
            url = asset.get("url") or ""
            if not url:
                continue
            _upsert_library_item(
                items,
                name=str(asset.get("name") or ""),
                media=media,
                source=str(asset.get("source") or "upload"),
                item_id=str(asset.get("id") or "") or None,
                category=str(asset.get("category") or "") or None,
                image_urls=[url] if media == "image" else None,
                video_url=url if media == "video" else None,
                audio_url=url if media == "audio" else None,
            )
            changed = True
        if changed:
            save_video_character_library(project_dir, items)
    return items
