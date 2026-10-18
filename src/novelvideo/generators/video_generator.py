"""Image-to-Video generation module.

Uses an Image-to-Video API to turn a first-frame image into a dynamic video.
"""

import asyncio
import hashlib
import ipaddress
import json
import logging
import math
import os
import random
import re
import subprocess
import urllib.parse
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Optional

from novelvideo.shared.provider_errors import (
    classify_provider_video_task_error,
    provider_video_error_code_from_text,
    provider_video_error_message_from_text,
    provider_video_task_error_message,
)

import aiohttp
import websockets
from dotenv import load_dotenv

from novelvideo.egress_context import ambient_egress_context
from novelvideo.authz_retry import retry_authz_read
from novelvideo.i18n_message import lmsg
from novelvideo.ports import (
    get_usage_meter,
    get_video_result_delivery,
    update_current_model_call_log,
)
from novelvideo.ports.authz import AuthzError, detach_authz_error
from novelvideo.ports.video_delivery import (
    ArchivedVideoSource,
    VideoDeliveryError,
    VideoDeliveryReceipt,
)
from novelvideo.video_request_usage import (
    record_video_request,
    update_video_request_status,
)
from novelvideo.shared.billing_errors import (
    find_billing_error,
    is_insufficient_credits_error,
)
from novelvideo.shared.provider_costs import is_definite_no_cost_http_rejection
from novelvideo.storage.media_relay import (
    IMAGE_TRANSFORM_AI_REFERENCE_JPEG,
    media_relay_ttl_seconds,
    upload_media_bytes,
)
from novelvideo.task_backend.cancel import TaskCancelled, TaskTimedOut
from novelvideo.task_backend.envelope import RunningTaskAuthorityIndeterminate
from novelvideo.task_backend.subprocesses import run_project_subprocess

logger = logging.getLogger(__name__)

# Make sure the .env environment variables are loaded
load_dotenv()

NEWAPI_VIDEO_HTTP_TIMEOUT_SECONDS = 1800.0
NEWAPI_MEDIA_INPUT_MIN_TTL_SECONDS = 2 * 60 * 60
_POST_ACCEPT_AUTHZ_MAX_RETRIES = 5
_POST_ACCEPT_AUTHZ_RETRY_BASE_SECONDS = 2.0
_POST_ACCEPT_AUTHZ_RETRY_CAP_SECONDS = 60.0
_POST_ACCEPT_AUTHZ_RETRY_SLEEP = asyncio.sleep
_POST_ACCEPT_AUTHZ_RETRY_RANDOM = random.random

_VIDEO_EGRESS_ERROR_MESSAGES = {
    "TASK_ENVELOPE_INVALID": "trusted video egress context is invalid",
    "ORG_EGRESS_DENIED": "organization video egress is denied",
    "ORG_SERVICE_EGRESS_DENIED": "organization video service egress is denied",
    "EGRESS_OPERATION_REPLAYED": "video egress operation cannot be replayed",
    "EGRESS_OPERATION_TRANSITION_FAILED": "video egress operation transition failed",
}


class VideoEgressError(RuntimeError):
    """Stable video egress policy failure without endpoint or secret details."""

    def __init__(self, code: str) -> None:
        super().__init__(_VIDEO_EGRESS_ERROR_MESSAGES.get(code, "video egress failed"))
        self.code = code


def _video_egress_context(value: object):
    if value is None:
        return None
    from novelvideo.egress_context import TrustedEgressContext

    if type(value) is not TrustedEgressContext:
        raise VideoEgressError("TASK_ENVELOPE_INVALID")
    return value


def _deny_direct_organization_video(kwargs: dict[str, Any]) -> None:
    context = _video_egress_context(kwargs.get("egress_context"))
    if context is None:
        context = ambient_egress_context()
    if context is not None and context.billing_principal.kind != "platform":
        raise VideoEgressError("ORG_EGRESS_DENIED")


def _direct_video_context_denied(context: object | None) -> bool:
    if context is None:
        context = ambient_egress_context()
    return bool(context is not None and context.billing_principal.kind != "platform")


def _safe_video_error_code(exc: BaseException, fallback: str) -> str:
    code = getattr(exc, "code", "")
    if isinstance(code, str) and code in {
        "P0_GRAY_DISABLED",
        "ORG_CREDENTIAL_MISSING",
        "ORG_CREDENTIAL_DISABLED",
        "ORG_CREDENTIAL_VERSION_MISMATCH",
        "ORG_CREDENTIAL_DECRYPT_FAILED",
        "ORG_MEMBERSHIP_INACTIVE",
        "ORG_AUTHZ_STALE",
        "EGRESS_OPERATION_CONFLICT",
        "EGRESS_OPERATION_REPLAYED",
    }:
        return code
    # When the gateway rejects with a VIDEO_* enum code (size/moderation), let that code through; the original text itself is not passed back.
    provider_code = provider_video_error_code_from_text(str(exc))
    if provider_code:
        return provider_code
    return fallback


def _run_video_subprocess(
    cmd: list[str], *, timeout: int = 30 * 60
) -> subprocess.CompletedProcess:
    return run_project_subprocess(cmd, capture_output=True, text=True, timeout=timeout)


def _video_credit_billing_params(*, resolution: str | None = None) -> dict[str, str]:
    clean_resolution = str(resolution or "").strip().lower()
    return {"resolution": clean_resolution} if clean_resolution else {}


async def _reserve_video_model_call(
    model: str,
    *,
    source: str,
    resolution: str | None = None,
    duration_seconds: int | float | str | None = 1,
) -> str:
    return await get_usage_meter().reserve_current_model_call_credit(
        model=model,
        billing_kind="video",
        billing_params=_video_credit_billing_params(resolution=resolution),
        billing_quantity=duration_seconds,
        metadata={"source": source},
    )


async def _refund_video_model_call(
    reservation_id: str,
    *,
    source: str,
    error: str,
    provider_request_id: str = "",
    provider_task_id: str = "",
) -> None:
    try:
        metadata: dict[str, object] = {"source": source, "error": error[:200]}
        if provider_request_id:
            metadata["request_id"] = provider_request_id
        if provider_task_id:
            metadata["provider_task_id"] = provider_task_id
        await get_usage_meter().refund_model_call_credit_reservation(
            reservation_id,
            metadata=metadata,
        )
    except Exception:
        pass


async def _confirm_video_model_call(
    *,
    model: str,
    reservation_id: str,
    provider_request_id: str = "",
    provider_task_id: str = "",
) -> None:
    try:
        await get_usage_meter().bump_model_call(
            user_id=None,
            model=model,
            provider_request_id=provider_request_id,
            provider_task_id=provider_task_id,
            credit_reservation_id=reservation_id,
        )
    except Exception:
        pass


class VideoGenStatus(Enum):
    """Video generation status."""

    PENDING = "pending"
    PROCESSING = "processing"
    DONE = "done"
    FAILED = "failed"


class VideoBackend(Enum):
    """Video generation backend."""

    SEEDANCE_FAST = "seedance_fast"  # Seedance 1.0 Pro Fast
    SEEDANCE_PRO = "seedance_pro"  # Seedance 1.5 Pro with audio
    SEEDANCE_PRO_SILENT = "seedance_pro_silent"  # Seedance 1.5 Pro silent
    SEEDANCE_2 = "seedance_2"  # Seedance 2.0 (main model of v2.0)
    COMFYUI = "comfyui"  # Claymore 1.0
    LTX23 = "ltx23"  # Lightricks LTX-Video 2.3 22B
    GROK_720 = "grok_720"  # xAI Grok Imagine Video 720p


@dataclass
class VideoGenResult:
    """Video generation result."""

    status: VideoGenStatus
    video_url: Optional[str] = None
    video_path: Optional[str] = None
    last_frame_url: Optional[str] = None
    last_frame_path: Optional[str] = None
    task_id: Optional[str] = None
    provider_task_id: Optional[str] = None
    error: Optional[str] = None
    duration_seconds: float = 0.0


class VideoGeneratorBase(ABC):
    """Video generator base class.

    Defines the standard interface for Image-to-Video generation.
    """

    async def generate(
        self,
        image_path: Optional[str],
        prompt: str,
        output_path: str,
        aspect_ratio: str = "16:9",
        duration: float = 5.0,
        poll_interval: float = 5.0,
        max_polls: int = 60,
    ) -> VideoGenResult:
        """Full generation flow: submit + poll + download.

        Args:
            image_path: first-frame image path
            prompt: motion description
            output_path: output video path
            aspect_ratio: aspect ratio
            duration: target duration (seconds)
            poll_interval: polling interval (seconds)
            max_polls: maximum number of polls

        Returns:
            Generation result
        """
        # Default implementation; subclasses may override
        raise NotImplementedError("Subclass should implement generate()")


class MockVideoGenerator(VideoGeneratorBase):
    """Mock video generator (for testing).

    Uses FFmpeg to turn a still image into a video with a Ken Burns effect,
    used to verify the full flow during development.

    Example:
        >>> generator = MockVideoGenerator()
        >>> result = await generator.generate(
        ...     image_path="frame.png",
        ...     prompt="character smiling",
        ...     output_path="output.mp4",
        ...     duration=5.0
        ... )
    """

    def __init__(self, width: int = 1920, height: int = 1080, fps: int = 30):
        """Initialize the mock generator.

        Args:
            width: video width
            height: video height
            fps: frame rate
        """
        self.width = width
        self.height = height
        self.fps = fps

    async def generate(
        self,
        image_path: str,
        prompt: str,
        output_path: str,
        aspect_ratio: str = "16:9",
        duration: float = 5.0,
        **kwargs,
    ) -> VideoGenResult:
        """Generate a test video: first-frame image + Ken Burns effect.

        Args:
            image_path: first-frame image path
            prompt: motion description (overlaid on the video as debug info)
            output_path: output video path
            aspect_ratio: aspect ratio
            duration: video duration (seconds)

        Returns:
            Generation result
        """
        try:
            # Make sure the output directory exists
            os.makedirs(os.path.dirname(output_path), exist_ok=True)

            # Compute the frame count
            frames = int(duration * self.fps)

            # Clean special characters out of the prompt (avoids FFmpeg command-line problems)
            safe_prompt = (
                prompt[:40].replace("'", "").replace('"', "").replace(":", " ")
            )

            # Generate the video with FFmpeg
            # 1. Ken Burns zoom effect
            # 2. Overlay the prompt text (for debugging)
            video_filter = (
                f"scale=8000:-1,"
                f"zoompan=z='min(zoom+0.0008,1.15)':d={frames}:"
                f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
                f"s={self.width}x{self.height}:fps={self.fps},"
                f"drawtext=text='{safe_prompt}':"
                f"fontsize=20:fontcolor=white@0.7:x=20:y=20"
            )

            cmd = [
                "ffmpeg",
                "-y",
                "-loop",
                "1",
                "-i",
                image_path,
                "-vf",
                video_filter,
                "-t",
                str(duration),
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-pix_fmt",
                "yuv420p",
                "-an",  # no audio
                output_path,
            ]

            result = _run_video_subprocess(cmd)

            if result.returncode != 0:
                return VideoGenResult(
                    status=VideoGenStatus.FAILED,
                    error=f"FFmpeg error: {result.stderr[:500]}",
                )

            return VideoGenResult(
                status=VideoGenStatus.DONE,
                video_path=output_path,
                duration_seconds=duration,
            )

        except (TaskCancelled, TaskTimedOut):
            raise
        except Exception as e:
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=str(e),
            )


class SeedanceVideoGenerator(VideoGeneratorBase):
    """Volcengine Ark Seedance video generator.

    Uses the Volcengine Ark Seedance API to generate dynamic video.
    Supports the Seedance 1.0 Pro Fast and Seedance 1.5 Pro models.

    Example:
        >>> generator = SeedanceVideoGenerator(
        ...     model="doubao-seedance-1-5-pro-251215",
        ...     generate_audio=True,
        ... )
        >>> result = await generator.generate(
        ...     image_path="frame.png",
        ...     prompt="character smiling and waving",
        ...     output_path="output.mp4"
        ... )
    """

    def __init__(
        self,
        model: str,
        generate_audio: bool = False,
        api_key: Optional[str] = None,
        endpoint: Optional[str] = None,
    ):
        """Initialize the Seedance generator.

        Args:
            model: model ID (e.g. doubao-seedance-1-5-pro-251215)
            generate_audio: whether to generate audio (Seedance 1.5 only)
            api_key: API Key (read from the environment by default)
            endpoint: API endpoint (read from the environment by default)
        """
        self.model = model
        self.generate_audio = generate_audio
        self.api_key = (
            api_key
            or os.environ.get("VOLCENGINE_VISUAL_API_KEY")
            or os.environ.get("ARK_API_KEY")
        )
        self.endpoint = endpoint or os.environ.get(
            "VOLCENGINE_VISUAL_ENDPOINT", "https://ark.cn-beijing.volces.com/api/v3"
        )

        if not self.api_key:
            raise ValueError("VOLCENGINE_VISUAL_API_KEY or ARK_API_KEY must be set")

    def _local_to_data_url(self, image_path: str) -> str:
        """Convert a local image to a data URL (base64)."""
        import base64

        if image_path.lower().endswith(".png"):
            mime_type = "image/png"
        elif image_path.lower().endswith((".jpg", ".jpeg")):
            mime_type = "image/jpeg"
        else:
            mime_type = "image/png"

        with open(image_path, "rb") as f:
            image_data = base64.b64encode(f.read()).decode()

        return f"data:{mime_type};base64,{image_data}"

    @staticmethod
    def _normalize_aspect_ratio(value: str | None) -> str:
        """Accept both legacy and canonical follow-input ratio values."""

        ratio = str(value or "").strip().lower()
        return ratio if ":" in ratio or ratio in {"auto", "adaptive"} else "9:16"

    async def _download_video(
        self, url: str, output_path: str, max_retries: int = 3
    ) -> bool:
        """Download the video file, retrying automatically on failure."""
        import httpx

        for attempt in range(1, max_retries + 1):
            try:
                async with httpx.AsyncClient(timeout=120) as client:
                    resp = await client.get(url)
                    if resp.status_code != 200:
                        print(
                            f"[download] attempt {attempt}/{max_retries} failed: HTTP {resp.status_code}"
                        )
                        if attempt < max_retries:
                            await asyncio.sleep(2 * attempt)
                            continue
                        return False

                    os.makedirs(os.path.dirname(output_path), exist_ok=True)
                    with open(output_path, "wb") as f:
                        f.write(resp.content)

                    return True
            except Exception as e:
                print(f"[download] attempt {attempt}/{max_retries} error: {e}")
                if attempt < max_retries:
                    await asyncio.sleep(2 * attempt)
        return False

    async def generate(
        self,
        image_path: str,
        prompt: str,
        output_path: str,
        aspect_ratio: str = "9:16",
        duration: float = 5.0,
        poll_interval: float = 5.0,
        max_polls: int = 120,
        on_log: Optional[Callable[[str], None]] = None,
        on_progress: Optional[Callable[[float], None]] = None,
        last_frame_path: Optional[str] = None,
        **kwargs,
    ) -> VideoGenResult:
        """Full generation flow: submit + poll + download.

        Args:
            image_path: first-frame image path (local path or URL)
            prompt: motion description
            output_path: output video path
            aspect_ratio: aspect ratio (e.g. "9:16")
            duration: target duration (seconds, limited to 4-12)
            poll_interval: polling interval (seconds)
            max_polls: maximum number of polls
            on_log: log callback function
            on_progress: progress callback function (0.0 - 1.0)
            last_frame_path: last-frame image path (optional; enables first/last-frame mode when provided)

        Returns:
            Generation result
        """
        _deny_direct_organization_video(kwargs)

        import httpx

        def log(msg: str):
            if on_log:
                on_log(msg)

        def progress(value: float):
            if on_progress:
                on_progress(value)

        task_id: str | None = None
        project_output_dir = kwargs.get("project_output_dir")
        tracking_episode = kwargs.get("episode")
        tracking_beat_num = kwargs.get("beat_num")
        tracking_task_type = kwargs.get("task_type", "")
        tracking_cost_estimate = kwargs.get("cost_estimate")

        def _record_request_accepted(request_id: str):
            if not project_output_dir or not request_id:
                return
            try:
                record_video_request(
                    project_output_dir=project_output_dir,
                    request_id=request_id,
                    provider="seedance",
                    model_name=self.model,
                    episode=tracking_episode,
                    beat_num=tracking_beat_num,
                    task_type=tracking_task_type,
                    duration_seconds=float(duration),
                    cost_estimate=tracking_cost_estimate,
                )
            except Exception as e:
                log(f"Billing failed (accepted): {e}")

        def _update_request_status(
            request_id: str, status: str, error_message: str | None = None
        ):
            if not project_output_dir or not request_id:
                return
            try:
                update_video_request_status(
                    project_output_dir=project_output_dir,
                    request_id=request_id,
                    status=status,
                    error_message=error_message,
                )
            except Exception as e:
                log(f"Billing failed ({status}): {e}")

        # Share the same duration bounds as quoting/pre-deduction.
        from novelvideo.video_duration import normalize_video_duration_for_backend

        duration = normalize_video_duration_for_backend("seedance_fast", duration)

        # Map the aspect_ratio format
        # Existing direct-Seedance deployments used ``adaptive`` while the
        # canonical media contract uses ``auto``. Accept both at this legacy
        # boundary instead of silently falling back to 9:16.
        ratio = self._normalize_aspect_ratio(aspect_ratio)

        # Handle the first frame
        if image_path.startswith(("http://", "https://", "data:")):
            first_frame_url = image_path
        elif os.path.exists(image_path):
            first_frame_url = self._local_to_data_url(image_path)
            log("First frame converted to a data URL")
        else:
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=f"First frame not found: {image_path}",
            )

        # Handle the last frame (if any)
        last_frame_url = None
        if last_frame_path is not None:
            if last_frame_path.startswith(("http://", "https://", "data:")):
                last_frame_url = last_frame_path
            elif os.path.exists(last_frame_path):
                last_frame_url = self._local_to_data_url(last_frame_path)
                log("Last frame converted to a data URL")
            else:
                return VideoGenResult(
                    status=VideoGenStatus.FAILED,
                    error=f"Last frame not found: {last_frame_path}",
                )

        # Build the content array
        content = [{"type": "text", "text": prompt}]

        # First frame
        first_frame_item = {
            "type": "image_url",
            "image_url": {"url": first_frame_url},
        }
        if last_frame_url is not None:
            first_frame_item["role"] = "first_frame"
        content.append(first_frame_item)

        # Last frame
        if last_frame_url is not None:
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": last_frame_url},
                    "role": "last_frame",
                }
            )

        # Build the request body
        request_body = {
            "model": self.model,
            "content": content,
            "resolution": "720p",
            "ratio": ratio,
            "duration": duration,
            "watermark": False,
        }
        request_body["generate_audio"] = self.generate_audio

        mode_desc = "first/last-frame mode" if last_frame_url else "first-frame mode"
        log(
            f"Submitting Seedance video generation task ({mode_desc}, {self.model}, {duration}s)..."
        )
        progress(0.1)

        # 1. Submit the task
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        try:
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.post(
                    f"{self.endpoint}/contents/generations/tasks",
                    json=request_body,
                    headers=headers,
                )

                if resp.status_code != 200:
                    error_text = resp.text
                    log(f"Task submission failed: HTTP {resp.status_code} - {error_text[:500]}")
                    return VideoGenResult(
                        status=VideoGenStatus.FAILED,
                        error=f"Submit failed: HTTP {resp.status_code} - {error_text[:200]}",
                    )

                data = resp.json()
                task_id = data.get("id")
                if not task_id:
                    log(f"No task_id returned: {data}")
                    return VideoGenResult(
                        status=VideoGenStatus.FAILED,
                        error=f"No task_id in response: {data}",
                    )

                log(f"Task submitted: {task_id}")
                _record_request_accepted(task_id)

        except Exception as e:
            log(f"Task submission error: {e}")
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=f"Submit exception: {e}",
            )

        # 2. Poll for the result
        progress(0.2)
        for poll_count in range(max_polls):
            try:
                async with httpx.AsyncClient(timeout=30) as client:
                    resp = await client.get(
                        f"{self.endpoint}/contents/generations/tasks/{task_id}",
                        headers=headers,
                    )

                    if resp.status_code != 200:
                        log(f"Status query failed: HTTP {resp.status_code}")
                        await asyncio.sleep(poll_interval)
                        continue

                    data = resp.json()
                    status_str = data.get("status", "")

                    # Progress goes from 0.2 to 0.9
                    poll_progress = 0.2 + (poll_count / max_polls) * 0.7
                    progress(poll_progress)

                    if status_str == "succeeded":
                        log("Video generation complete, downloading...")
                        progress(0.9)
                        _update_request_status(task_id, "completed")

                        # Extract the video URL
                        video_url = None
                        resp_content = data.get("content")
                        if isinstance(resp_content, dict):
                            video_url = resp_content.get("video_url")
                        elif isinstance(resp_content, list):
                            for item in resp_content:
                                if isinstance(item, dict) and item.get("video_url"):
                                    video_url = item["video_url"]
                                    break

                        if video_url:
                            success = await self._download_video(video_url, output_path)
                            if success:
                                log(f"Video saved: {output_path}")
                                progress(1.0)
                                _update_request_status(task_id, "downloaded")
                                return VideoGenResult(
                                    status=VideoGenStatus.DONE,
                                    video_path=output_path,
                                    video_url=video_url,
                                    task_id=task_id,
                                    duration_seconds=float(duration),
                                )
                            else:
                                log("Video download failed")
                                _update_request_status(
                                    task_id, "failed", "Download failed"
                                )
                                return VideoGenResult(
                                    status=VideoGenStatus.FAILED,
                                    error="Download failed",
                                    task_id=task_id,
                                )
                        else:
                            log(f"API did not return a video URL: {data}")
                            _update_request_status(
                                task_id, "failed", "No video URL in response"
                            )
                            return VideoGenResult(
                                status=VideoGenStatus.FAILED,
                                error="No video URL in response",
                                task_id=task_id,
                            )

                    elif status_str == "failed":
                        error_msg = data.get("error", {}).get(
                            "message", "Unknown error"
                        )
                        log(f"Video generation failed: {error_msg}")
                        _update_request_status(task_id, "failed", error_msg)
                        return VideoGenResult(
                            status=VideoGenStatus.FAILED,
                            error=f"Generation failed: {error_msg}",
                            task_id=task_id,
                        )

                    # queued / running -> keep polling
                    if poll_count % 6 == 0:
                        log(f"Generating... ({status_str}, {poll_count}/{max_polls})")

            except Exception as e:
                log(f"Status query error: {e}")

            await asyncio.sleep(poll_interval)

        log("Video generation timed out")
        _update_request_status(
            task_id, "failed", "Timeout waiting for video generation"
        )
        return VideoGenResult(
            status=VideoGenStatus.FAILED,
            error="Timeout waiting for video generation",
            task_id=task_id,
        )


@dataclass
class ShotReference:
    """Seedance 2.0 asset reference."""

    type: str  # "image" / "video" / "audio" / "file" / "link"
    path: str  # local file path or public URL
    role: str  # "first_frame" / "character_reference" / "scene_reference" / "bgm" / "voice_reference"


class Seedance2VideoGenerator(VideoGeneratorBase):
    """Volcengine Ark Seedance 2.0 omni-reference mode video generator.

    Supports multimodal input: text + up to 9 images + 3 videos + 3 audios.
    Natively generates synchronized audio and video (dialogue, BGM, sound effects).
    Built-in intelligent camera movement system.

    Note: the API format must be confirmed once the API is officially open; the following is inferred from known information.

    Example:
        >>> generator = Seedance2VideoGenerator()
        >>> result = await generator.generate(
        ...     prompt="In an old study, a young woman leafs through ancient books...",
        ...     references=[
        ...         ShotReference("image", "frame.png", "first_frame"),
        ...         ShotReference("image", "char_ref.png", "character_reference"),
        ...     ],
        ...     output_path="output.mp4",
        ...     duration=10,
        ...     audio=True,
        ... )
    """

    MODEL = "seedance-2.0"
    MODEL_I2V = "seedance-2.0-i2v"

    def _select_generation_model(
        self,
        *,
        image_count: int,
        video_count: int,
        audio_count: int,
    ) -> str:
        """Choose the Seedance model variant for the current reference mix.

        Mixed-reference omni generation should stay on the general Seedance 2.0
        model. The i2v variant is only used for pure single-image first-frame
        generation.
        """
        if image_count == 1 and video_count == 0 and audio_count == 0:
            return self.MODEL_I2V
        return self.MODEL

    def __init__(
        self,
        model: Optional[str] = None,
        api_key: Optional[str] = None,
        endpoint: Optional[str] = None,
    ):
        self.model = model or self.MODEL
        self.api_key = (
            api_key
            or os.environ.get("VOLCENGINE_VISUAL_API_KEY")
            or os.environ.get("ARK_API_KEY")
        )
        self.endpoint = endpoint or os.environ.get(
            "VOLCENGINE_VISUAL_ENDPOINT", "https://ark.cn-beijing.volces.com/api/v3"
        )
        if not self.api_key:
            raise ValueError("VOLCENGINE_VISUAL_API_KEY or ARK_API_KEY must be set")

    def _file_to_data_url(self, file_path: str) -> str:
        """Convert a local file to a data URL (base64)."""
        import base64
        import mimetypes

        mime_type, _ = mimetypes.guess_type(file_path)
        if not mime_type:
            ext = file_path.lower().rsplit(".", 1)[-1]
            mime_map = {
                "png": "image/png",
                "jpg": "image/jpeg",
                "jpeg": "image/jpeg",
                "webp": "image/webp",
                "bmp": "image/bmp",
                "gif": "image/gif",
                "mp4": "video/mp4",
                "mov": "video/quicktime",
                "mp3": "audio/mpeg",
                "wav": "audio/wav",
            }
            mime_type = mime_map.get(ext, "application/octet-stream")

        with open(file_path, "rb") as f:
            data = base64.b64encode(f.read()).decode()
        return f"data:{mime_type};base64,{data}"

    async def _download_video(self, url: str, output_path: str) -> bool:
        """Download the video file."""
        try:
            import httpx

            async with httpx.AsyncClient(timeout=120) as client:
                resp = await client.get(url)
                if resp.status_code != 200:
                    return False
                os.makedirs(os.path.dirname(output_path), exist_ok=True)
                with open(output_path, "wb") as f:
                    f.write(resp.content)
                return True
        except Exception:
            return False

    async def submit_task(
        self, image_url: str, prompt: str, aspect_ratio: str = "9:16"
    ) -> str:
        return f"seedance2-{uuid.uuid4().hex[:8]}"

    async def get_result(self, task_id: str) -> VideoGenResult:
        return VideoGenResult(status=VideoGenStatus.PROCESSING, task_id=task_id)

    async def generate(
        self,
        prompt: str,
        output_path: str,
        references: Optional[list[ShotReference]] = None,
        duration: float = 10.0,
        audio: bool = True,
        aspect_ratio: str = "9:16",
        resolution: str = "2k",
        poll_interval: float = 5.0,
        max_polls: int = 120,
        on_log: Optional[Callable[[str], None]] = None,
        on_progress: Optional[Callable[[float], None]] = None,
        # Compatible with the VideoGeneratorBase interface
        image_path: Optional[str] = None,
        **kwargs,
    ) -> VideoGenResult:
        """Seedance 2.0 omni-reference mode generation.

        Args:
            prompt: natural-language description (including @asset references)
            output_path: output video path
            references: list of asset references (image/video/audio)
            duration: target duration (5-15 seconds)
            audio: whether to generate native audio
            aspect_ratio: aspect ratio
            resolution: resolution (720p/1080p/2k)
            poll_interval: polling interval
            max_polls: maximum number of polls
            on_log: log callback
            on_progress: progress callback
            image_path: first-frame image path, for compatibility with the old interface
        """
        _deny_direct_organization_video(kwargs)

        import httpx

        def log(msg: str):
            if on_log:
                on_log(msg)

        def progress(value: float):
            if on_progress:
                on_progress(value)

        refs = references or []

        # Compatible with the old interface: if image_path is passed without references, use it as the first frame automatically
        if image_path and not refs:
            refs = [ShotReference("image", image_path, "first_frame")]

        from novelvideo.video_duration import normalize_video_duration_for_backend

        duration = normalize_video_duration_for_backend("seedance_2", duration)

        # Map the aspect_ratio format
        ratio = aspect_ratio if ":" in aspect_ratio else "9:16"

        # Build the content array
        content = [{"type": "text", "text": prompt}]

        # Add asset references
        image_count, video_count, audio_count = 0, 0, 0
        for ref in refs:
            if not os.path.exists(ref.path):
                log(f"Warning: asset does not exist: {ref.path}")
                continue

            data_url = self._file_to_data_url(ref.path)

            if ref.type == "image" and image_count < 9:
                content.append(
                    {
                        "type": "image_url",
                        "image_url": {"url": data_url},
                        "role": ref.role,
                    }
                )
                image_count += 1
            elif ref.type == "video" and video_count < 3:
                content.append(
                    {
                        "type": "video_url",
                        "video_url": {"url": data_url},
                        "role": ref.role,
                    }
                )
                video_count += 1
            elif ref.type == "audio" and audio_count < 3:
                content.append(
                    {
                        "type": "audio_url",
                        "audio_url": {"url": data_url},
                        "role": ref.role,
                    }
                )
                audio_count += 1

        model = self._select_generation_model(
            image_count=image_count,
            video_count=video_count,
            audio_count=audio_count,
        )

        # Build the request body
        request_body = {
            "model": model,
            "content": content,
            "resolution": resolution,
            "ratio": ratio,
            "duration": duration,
            "watermark": False,
        }
        if audio:
            request_body["audio"] = True

        ref_summary = f"{image_count} images + {video_count} videos + {audio_count} audios"
        log(
            f"Submitting Seedance 2.0 video generation task "
            f"({ref_summary}, model={model}, {duration}s, audio={audio})..."
        )
        progress(0.1)

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        try:
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.post(
                    f"{self.endpoint}/contents/generations/tasks",
                    json=request_body,
                    headers=headers,
                )
                if resp.status_code != 200:
                    error_text = resp.text
                    log(f"Task submission failed: HTTP {resp.status_code} - {error_text[:500]}")
                    return VideoGenResult(
                        status=VideoGenStatus.FAILED,
                        error=f"Submit failed: HTTP {resp.status_code} - {error_text[:200]}",
                    )
                data = resp.json()
                task_id = data.get("id")
                if not task_id:
                    log(f"No task_id returned: {data}")
                    return VideoGenResult(
                        status=VideoGenStatus.FAILED,
                        error=f"No task_id in response: {data}",
                    )
                log(f"Task submitted: {task_id}")
        except Exception as e:
            log(f"Task submission error: {e}")
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=f"Submit exception: {e}",
            )

        # Poll for the result
        progress(0.2)
        for poll_count in range(max_polls):
            try:
                async with httpx.AsyncClient(timeout=30) as client:
                    resp = await client.get(
                        f"{self.endpoint}/contents/generations/tasks/{task_id}",
                        headers=headers,
                    )
                    if resp.status_code != 200:
                        log(f"Status query failed: HTTP {resp.status_code}")
                        await asyncio.sleep(poll_interval)
                        continue

                    data = resp.json()
                    status_str = data.get("status", "")
                    poll_progress = 0.2 + (poll_count / max_polls) * 0.7
                    progress(poll_progress)

                    if status_str == "succeeded":
                        log("Video generation complete, downloading...")
                        progress(0.9)

                        video_url = None
                        resp_content = data.get("content")
                        if isinstance(resp_content, dict):
                            video_url = resp_content.get("video_url")
                        elif isinstance(resp_content, list):
                            for item in resp_content:
                                if isinstance(item, dict) and item.get("video_url"):
                                    video_url = item["video_url"]
                                    break

                        if video_url:
                            success = await self._download_video(video_url, output_path)
                            if success:
                                log(f"Video saved: {output_path}")
                                progress(1.0)
                                return VideoGenResult(
                                    status=VideoGenStatus.DONE,
                                    video_path=output_path,
                                    video_url=video_url,
                                    task_id=task_id,
                                    duration_seconds=float(duration),
                                )
                            else:
                                log("Video download failed")
                                return VideoGenResult(
                                    status=VideoGenStatus.FAILED,
                                    error="Download failed",
                                    task_id=task_id,
                                )
                        else:
                            log(f"API did not return a video URL: {data}")
                            return VideoGenResult(
                                status=VideoGenStatus.FAILED,
                                error="No video URL in response",
                                task_id=task_id,
                            )

                    elif status_str == "failed":
                        error_msg = data.get("error", {}).get(
                            "message", "Unknown error"
                        )
                        log(f"Video generation failed: {error_msg}")
                        return VideoGenResult(
                            status=VideoGenStatus.FAILED,
                            error=f"Generation failed: {error_msg}",
                            task_id=task_id,
                        )

                    if poll_count % 6 == 0:
                        log(f"Generating... ({status_str}, {poll_count}/{max_polls})")

            except Exception as e:
                log(f"Status query error: {e}")

            await asyncio.sleep(poll_interval)

        log("Video generation timed out")
        return VideoGenResult(
            status=VideoGenStatus.FAILED,
            error="Timeout waiting for video generation",
            task_id=task_id,
        )


class GrokVideoGenerator(VideoGeneratorBase):
    """xAI Grok video generator (first-frame image-to-video, fixed 720p)."""

    MODEL = "grok-imagine-video"
    DEFAULT_ENDPOINT = "https://api.x.ai/v1"

    def __init__(
        self,
        api_key: Optional[str] = None,
        endpoint: Optional[str] = None,
        model: str = MODEL,
        resolution: str = "720p",
    ):
        self.api_key = api_key or os.environ.get("XAI_API_KEY")
        self.endpoint = (
            endpoint or os.environ.get("XAI_BASE_URL") or self.DEFAULT_ENDPOINT
        ).rstrip("/")
        self.model = model
        self.resolution = resolution

        if not self.api_key:
            raise ValueError("XAI_API_KEY must be set for Grok video generation")

    def _local_to_data_url(self, image_path: str) -> str:
        import base64

        suffix = Path(image_path).suffix.lower()
        if suffix == ".png":
            mime_type = "image/png"
        elif suffix in {".jpg", ".jpeg"}:
            mime_type = "image/jpeg"
        else:
            mime_type = "image/png"

        with open(image_path, "rb") as f:
            encoded = base64.b64encode(f.read()).decode()
        return f"data:{mime_type};base64,{encoded}"

    async def _download_video(
        self, url: str, output_path: str, max_retries: int = 3
    ) -> bool:
        for attempt in range(1, max_retries + 1):
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.get(url) as resp:
                        if resp.status != 200:
                            if attempt < max_retries:
                                await asyncio.sleep(2 * attempt)
                                continue
                            return False

                        os.makedirs(os.path.dirname(output_path), exist_ok=True)
                        with open(output_path, "wb") as f:
                            f.write(await resp.read())
                        return True
            except Exception:
                if attempt < max_retries:
                    await asyncio.sleep(2 * attempt)
        return False

    async def generate(
        self,
        image_path: str,
        prompt: str,
        output_path: str,
        aspect_ratio: str = "9:16",
        duration: float = 5.0,
        poll_interval: float = 5.0,
        max_polls: int = 180,
        on_log: Optional[Callable[[str], None]] = None,
        on_progress: Optional[Callable[[float], None]] = None,
        last_frame_path: Optional[str] = None,
        **kwargs,
    ) -> VideoGenResult:
        _deny_direct_organization_video(kwargs)

        def log(msg: str):
            if on_log:
                on_log(msg)

        def progress(value: float):
            if on_progress:
                on_progress(value)

        if last_frame_path:
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error="Grok 720 does not support keyframe/first-last-frame mode",
            )

        from novelvideo.video_duration import normalize_video_duration_for_backend

        duration = normalize_video_duration_for_backend("grok_720", duration)
        ratio = aspect_ratio if ":" in aspect_ratio else "9:16"

        if image_path.startswith(("http://", "https://", "data:")):
            image_url = image_path
        elif os.path.exists(image_path):
            image_url = self._local_to_data_url(image_path)
            log("First frame converted to a data URL")
        else:
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=f"First frame not found: {image_path}",
            )

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        request_body = {
            "model": self.model,
            "prompt": prompt,
            "image_url": image_url,
            "duration": duration,
            "aspect_ratio": ratio,
            "resolution": self.resolution,
        }

        log(
            f"Submitting Grok video generation task ({self.model}, {duration}s, {self.resolution})..."
        )
        progress(0.1)

        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{self.endpoint}/videos/generations",
                    json=request_body,
                    headers=headers,
                ) as resp:
                    if resp.status != 200:
                        error_text = await resp.text()
                        return VideoGenResult(
                            status=VideoGenStatus.FAILED,
                            error=f"Submit failed: HTTP {resp.status} - {error_text[:200]}",
                        )
                    data = await resp.json()
        except Exception as e:
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=f"Submit exception: {e}",
            )

        request_id = data.get("request_id")
        if not request_id:
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=f"No request_id in response: {data}",
            )

        log(f"Task submitted: {request_id}")
        progress(0.2)

        for poll_count in range(max_polls):
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.get(
                        f"{self.endpoint}/videos/{request_id}",
                        headers={"Authorization": f"Bearer {self.api_key}"},
                    ) as resp:
                        if resp.status != 200:
                            await asyncio.sleep(poll_interval)
                            continue
                        data = await resp.json()
            except Exception:
                await asyncio.sleep(poll_interval)
                continue

            status_str = (data.get("status") or "").lower()
            progress(0.2 + (poll_count / max_polls) * 0.7)

            if status_str == "done":
                video_info = data.get("video") or {}
                video_url = video_info.get("url")
                if not video_url:
                    return VideoGenResult(
                        status=VideoGenStatus.FAILED,
                        error="No video URL in response",
                        task_id=request_id,
                    )
                log("Video generation complete, downloading...")
                progress(0.9)
                success = await self._download_video(video_url, output_path)
                if not success:
                    return VideoGenResult(
                        status=VideoGenStatus.FAILED,
                        error="Download failed",
                        task_id=request_id,
                    )
                progress(1.0)
                return VideoGenResult(
                    status=VideoGenStatus.DONE,
                    video_url=video_url,
                    video_path=output_path,
                    task_id=request_id,
                    duration_seconds=float(video_info.get("duration") or duration),
                )

            if status_str in {"failed", "expired"}:
                return VideoGenResult(
                    status=VideoGenStatus.FAILED,
                    error=f"Grok video generation {status_str}",
                    task_id=request_id,
                )

            if poll_count % 6 == 0:
                log(
                    f"Generating... ({status_str or 'pending'}, {poll_count}/{max_polls})"
                )
            await asyncio.sleep(poll_interval)

        return VideoGenResult(
            status=VideoGenStatus.FAILED,
            error="Generation timeout",
            task_id=request_id,
        )


def _seedance2_config_mapping(value) -> dict:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return {}
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return {"final_prompt": text}
        return dict(parsed) if isinstance(parsed, dict) else {}
    return {}


def _seedance2_duration_from_config(config: dict, fallback: float) -> float:
    if "duration" not in config:
        return fallback
    try:
        return int(float(config.get("duration") or fallback))
    except (TypeError, ValueError):
        return fallback


class HuimengVideoGenerator(VideoGeneratorBase):
    """HuiMeng async-task video generator."""

    DEFAULT_MODEL = "seedance-1.0-pro-fast"

    def __init__(
        self,
        api_key: Optional[str] = None,
        endpoint: Optional[str] = None,
        model: Optional[str] = None,
        resolution: Optional[str] = None,
        generate_audio: Optional[bool] = None,
        client=None,
    ):
        from novelvideo.config import (
            HUIMENGI_VIDEO_GENERATE_AUDIO,
            HUIMENGI_VIDEO_RESOLUTION,
        )
        from novelvideo.generators.huimengi import HuimengiTaskClient

        self.model = model or self.DEFAULT_MODEL
        self.resolution = resolution or HUIMENGI_VIDEO_RESOLUTION
        self.generate_audio = (
            HUIMENGI_VIDEO_GENERATE_AUDIO if generate_audio is None else generate_audio
        )
        self.client = client or HuimengiTaskClient(api_key=api_key, base_url=endpoint)

    def _duration_bounds(self) -> tuple[int, int]:
        from novelvideo.video_duration import video_duration_bounds_for_backend

        bounds = video_duration_bounds_for_backend(f"huimeng_{self.model}")
        if bounds[0] is None or bounds[1] is None:
            return 2, 12
        return int(bounds[0]), int(bounds[1])

    def _supports_audio_param(self) -> bool:
        return self.model in {"seedance-2.0", "seedance-2.0-fast", "seedance-1.5-pro"}

    def _is_seedance2_model(self) -> bool:
        return self.model.startswith("seedance-2.0")

    def _is_happyhorse_model(self) -> bool:
        return self.model.strip().lower() == "happyhorse-1.0"

    def _to_upload_url(
        self,
        value: str | None,
        *,
        label: str,
        log: Callable[[str], None],
        require_http_url: bool = False,
    ) -> str | None:
        from novelvideo.generators.huimengi import local_file_to_data_url

        text = str(value or "").strip()
        if not text:
            return None
        if text.startswith(("http://", "https://")):
            return text
        if text.startswith("data:"):
            if require_http_url:
                raise ValueError(
                    "human_review requires HTTP/HTTPS media URLs; "
                    f"unsupported direct media reference for {label}: data:"
                )
            return text
        if os.path.exists(text):
            if require_http_url:
                from novelvideo.utils.oss_client import presign_or_upload_output

                oss_url = presign_or_upload_output(text)
                if not oss_url:
                    raise ValueError(
                        "human_review requires OSS presigned HTTP media URLs. "
                        f"Failed to upload or presign local file: {text}"
                    )
                log(f"{label} uploaded/reused OSS URL")
                return oss_url
            log(f"{label} converted to a data URL")
            return local_file_to_data_url(text)
        raise FileNotFoundError(f"{label} not found: {text}")

    def _build_reference_params(
        self,
        references: list["ShotReference"] | None,
        *,
        log: Callable[[str], None],
        require_http_url: bool = False,
    ) -> tuple[dict[str, list[str]], dict[str, int]]:
        params: dict[str, list[str]] = {}
        image_urls: list[str] = []
        video_urls: list[str] = []
        audio_urls: list[str] = []

        for ref in references or []:
            path = str(getattr(ref, "path", "") or "").strip()
            if not path:
                continue
            ref_type = str(getattr(ref, "type", "") or "image").strip().lower()
            role = str(getattr(ref, "role", "") or "").strip()
            label = f"{role or ref_type} reference"
            data_url = self._to_upload_url(
                path,
                label=label,
                log=log,
                require_http_url=require_http_url,
            )
            if not data_url:
                continue
            if ref_type == "image":
                image_urls.append(data_url)
            elif ref_type == "video":
                video_urls.append(data_url)
            elif ref_type == "audio":
                audio_urls.append(data_url)

        if image_urls:
            params["reference_images"] = image_urls[:9]
        if video_urls:
            params["reference_videos"] = video_urls[:3]
        if audio_urls:
            params["reference_audios"] = audio_urls[:3]

        return params, {
            "image_count": len(params.get("reference_images", [])),
            "video_count": len(params.get("reference_videos", [])),
            "audio_count": len(params.get("reference_audios", [])),
        }

    async def generate(
        self,
        image_path: Optional[str],
        prompt: str,
        output_path: str,
        aspect_ratio: str = "adaptive",
        duration: float = 5.0,
        poll_interval: float = 5.0,
        max_polls: int = 120,
        on_log: Optional[Callable[[str], None]] = None,
        on_progress: Optional[Callable[[float], None]] = None,
        last_frame_path: Optional[str] = None,
        **kwargs,
    ) -> VideoGenResult:
        _deny_direct_organization_video(kwargs)

        def log(msg: str):
            if on_log:
                on_log(msg)

        def progress(value: float):
            if on_progress:
                on_progress(value)

        project_output_dir = kwargs.get("project_output_dir")
        tracking_episode = kwargs.get("episode")
        tracking_beat_num = kwargs.get("beat_num")
        tracking_task_type = kwargs.get("task_type", "")
        tracking_cost_estimate = kwargs.get("cost_estimate")

        def record_accepted(request_id: str):
            if not project_output_dir or not request_id:
                return
            try:
                record_video_request(
                    project_output_dir=project_output_dir,
                    request_id=request_id,
                    provider="huimeng",
                    model_name=self.model,
                    episode=tracking_episode,
                    beat_num=tracking_beat_num,
                    task_type=tracking_task_type,
                    duration_seconds=float(duration),
                    cost_estimate=tracking_cost_estimate,
                )
            except Exception as exc:
                log(f"Billing failed (accepted): {exc}")

        def update_request_status(
            request_id: str,
            status: str,
            error_message: str | None = None,
        ):
            if not project_output_dir or not request_id:
                return
            try:
                update_video_request_status(
                    project_output_dir=project_output_dir,
                    request_id=request_id,
                    status=status,
                    error_message=error_message,
                )
            except Exception as exc:
                log(f"Billing failed ({status}): {exc}")

        is_seedance2_model = self._is_seedance2_model()
        seedance2_config = (
            _seedance2_config_mapping(kwargs.get("seedance2_config"))
            if is_seedance2_model
            else {}
        )
        duration = _seedance2_duration_from_config(seedance2_config, duration)
        original_duration = duration
        from novelvideo.video_duration import normalize_video_duration_for_backend

        duration = normalize_video_duration_for_backend(
            f"huimeng_{self.model}",
            duration,
        )
        if duration != original_duration:
            log(f"Duration adjusted: {original_duration:.1f}s -> {duration:.0f}s")

        ratio = aspect_ratio if ":" in aspect_ratio else "adaptive"

        references = kwargs.get("references") or []
        require_http_media = (
            bool(seedance2_config.get("human_review"))
            if "human_review" in seedance2_config
            else bool(kwargs.get("human_review", False))
        )

        try:
            first_frame = self._to_upload_url(
                image_path,
                label="first frame",
                log=log,
                require_http_url=require_http_media,
            )
            last_frame = self._to_upload_url(
                last_frame_path,
                label="last frame",
                log=log,
                require_http_url=require_http_media,
            )
            reference_params, ref_counts = self._build_reference_params(
                references,
                log=log,
                require_http_url=require_http_media,
            )
        except (FileNotFoundError, ValueError) as exc:
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=str(exc),
            )

        has_multimodal_refs = any(ref_counts.values())

        if is_seedance2_model:
            from novelvideo.seedance2_i2v.models import Seedance2I2VMode
            from novelvideo.seedance2_i2v.request import build_seedance2_huimeng_params

            if last_frame:
                mode = Seedance2I2VMode.FIRST_LAST_FRAME
            elif has_multimodal_refs:
                mode = Seedance2I2VMode.MULTIMODAL_REFERENCE
            elif first_frame:
                mode = Seedance2I2VMode.FIRST_FRAME
            else:
                mode = Seedance2I2VMode.TEXT_TO_VIDEO

            config = seedance2_config
            config_resolution = str(
                config.get("resolution") or self.resolution or "720p"
            ).strip()
            config_ratio = str(config.get("ratio") or ratio or "adaptive").strip()
            config.update(
                {
                    "mode": mode.value,
                    "final_prompt": prompt,
                    "duration": duration,
                    "resolution": config_resolution,
                    "ratio": config_ratio,
                }
            )
            if "generate_audio" not in config:
                config["generate_audio"] = bool(self.generate_audio)
                config["generate_audio_user_set"] = True
            elif "generate_audio_user_set" not in config:
                config["generate_audio_user_set"] = True
            if "return_last_frame" not in config:
                config["return_last_frame"] = False
            if "human_review" not in config:
                # Direct generator calls default to no material-review upload unless
                # the caller passes the per-beat Seedance2 config or an explicit kwarg.
                config["human_review"] = bool(kwargs.get("human_review", False))
                config["human_review_user_set"] = True
            elif "human_review_user_set" not in config:
                config["human_review_user_set"] = True
            try:
                params = build_seedance2_huimeng_params(
                    config,
                    first_frame=first_frame or "",
                    last_frame=last_frame or "",
                    reference_images=reference_params.get("reference_images"),
                    reference_videos=reference_params.get("reference_videos"),
                    reference_audios=reference_params.get("reference_audios"),
                )
            except ValueError as exc:
                return VideoGenResult(
                    status=VideoGenStatus.FAILED,
                    error=str(exc),
                )
        else:
            params = {
                "prompt": prompt,
                "duration": duration,
                "resolution": self.resolution,
                "ratio": ratio,
                "return_last_frame": False,
            }

            if last_frame:
                if not first_frame:
                    return VideoGenResult(
                        status=VideoGenStatus.FAILED,
                        error="First frame is required when last_frame_path is provided",
                    )
                params["first_frame_image"] = first_frame
                params["last_frame_image"] = last_frame
            elif has_multimodal_refs:
                params.update(reference_params)
            elif first_frame:
                params["image_url"] = first_frame

            if self._supports_audio_param():
                params["generate_audio"] = bool(self.generate_audio)

        task_id: str | None = None
        try:
            request_resolution = str(
                params.get("resolution") or self.resolution or ""
            ).strip()
            log(
                f"Submitting HuiMeng video task "
                f"({self.model}, refs={ref_counts['image_count']} images/{ref_counts['video_count']} videos/{ref_counts['audio_count']} audios, "
                f"{duration}s, {request_resolution})..."
            )
            progress(0.1)
            submitted = await self.client.submit_task(model=self.model, params=params)
            task_id = submitted["task_id"]
            record_accepted(task_id)
            log(f"Task submitted: {task_id}")
            progress(0.2)

            task = await self.client.wait_for_completion(
                task_id,
                poll_interval=poll_interval,
                max_polls=max_polls,
                on_log=on_log,
                on_progress=on_progress,
            )

            from novelvideo.generators.huimengi import (
                extract_huimeng_result_duration,
                extract_huimeng_result_last_frame_url,
                extract_huimeng_result_url,
            )

            result = task.get("result") or {}
            task_result_payload = {**result, **task}
            video_url = extract_huimeng_result_url(result, "video_url", "video_urls")
            if not video_url:
                update_request_status(
                    task_id, "failed", "No video_url in HuiMeng result"
                )
                return VideoGenResult(
                    status=VideoGenStatus.FAILED,
                    error=f"No video_url in HuiMeng result: {result}",
                    task_id=task_id,
                )

            log("Video generation complete, downloading...")
            await self.client.download_url(video_url, output_path)
            last_frame_url = ""
            last_frame_path = ""
            if bool(params.get("return_last_frame")):
                last_frame_url = extract_huimeng_result_last_frame_url(
                    task_result_payload
                )
                if last_frame_url:
                    video_output_path = Path(output_path)
                    parsed_last_frame_url = urllib.parse.urlparse(last_frame_url)
                    last_frame_suffix = Path(parsed_last_frame_url.path).suffix.lower()
                    if last_frame_suffix not in {
                        ".png",
                        ".jpg",
                        ".jpeg",
                        ".webp",
                        ".gif",
                    }:
                        last_frame_suffix = ".png"
                    last_frame_output_path = (
                        video_output_path.parent
                        / "returned_last_frames"
                        / f"{video_output_path.stem}{last_frame_suffix}"
                    )
                    await self.client.download_image_url(
                        last_frame_url,
                        str(last_frame_output_path),
                    )
                    last_frame_path = last_frame_output_path.as_posix()
                    log("Saved the last frame returned by HuiMeng")
            progress(1.0)
            update_request_status(task_id, "completed")
            return VideoGenResult(
                status=VideoGenStatus.DONE,
                video_url=video_url,
                video_path=output_path,
                last_frame_url=last_frame_url or None,
                last_frame_path=last_frame_path or None,
                task_id=task_id,
                provider_task_id=task_id,
                duration_seconds=extract_huimeng_result_duration(result)
                or float(duration),
            )

        except Exception as exc:
            if task_id:
                update_request_status(task_id, "failed", str(exc))
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=str(exc),
                task_id=task_id,
            )


class NewApiVideoError(RuntimeError):
    """newAPI video request failure with gateway request id when available."""

    def __init__(
        self,
        message: str,
        *,
        request_id: str = "",
        status_code: int | None = None,
    ):
        super().__init__(message)
        self.request_id = request_id
        self.status_code = status_code


class NewApiVideoGenerator(VideoGeneratorBase):
    """newAPI OpenAI-style async video task generator."""

    @staticmethod
    def _model_label(model: str) -> str:
        return NEWAPI_VIDEO_DISPLAY_LABELS.get(model, model)

    @staticmethod
    def _parse_duration_bounds_config(raw: str) -> dict[str, tuple[int, int]]:
        from novelvideo.video_duration import parse_video_duration_bounds

        return parse_video_duration_bounds(raw)

    @classmethod
    def _default_generate_audio_for_model(cls, model: str) -> bool:
        from novelvideo.config import NEWAPI_VIDEO_AUDIO_MODELS

        return model.strip() in set(NEWAPI_VIDEO_AUDIO_MODELS)

    def __init__(
        self,
        api_key: Optional[str] = None,
        endpoint: Optional[str] = None,
        model: Optional[str] = None,
        resolution: Optional[str] = None,
        generate_audio: Optional[bool] = None,
        model_params: Optional[dict[str, Any]] = None,
        request_schema: Optional[dict[str, Any]] = None,
        egress_context: object | None = None,
    ):
        from novelvideo.config import (
            NEWAPI_VIDEO_MODEL,
            NEWAPI_VIDEO_RESOLUTION,
        )

        self.egress_context = _video_egress_context(egress_context)
        if self.egress_context is not None and self.egress_context.is_organization:
            # Organization egress is request-scoped: the credential never lands on
            # the instance, so there is no local gateway to select a mode from.
            self.api_key = ""
            self.base_url = ""
        else:
            from novelvideo.config import get_effective_newapi_gateway_config
            from novelvideo.shared.runtime_env import is_ce_effective

            gateway = get_effective_newapi_gateway_config()
            if is_ce_effective():
                try:
                    from novelvideo.model_gateway_settings import (
                        MODE_CUSTOM,
                        MODE_HYBRID,
                        get_ce_newapi_config_for_mode,
                        get_effective_newapi_config,
                        get_newapi_media_model_mappings,
                    )

                    active_gateway = get_effective_newapi_config()
                    media_mapping = get_newapi_media_model_mappings().get(
                        model or NEWAPI_VIDEO_MODEL,
                        {},
                    )
                    if (
                        active_gateway.mode == MODE_HYBRID
                        and media_mapping.get("provider") == "comfyui"
                    ):
                        gateway = get_ce_newapi_config_for_mode(MODE_CUSTOM)
                except (RuntimeError, ImportError):
                    pass
            self.api_key = api_key if api_key is not None else gateway.api_key
            self.base_url = (endpoint or gateway.base_url).rstrip("/")
        self.model = model or NEWAPI_VIDEO_MODEL
        self.resolution = resolution or NEWAPI_VIDEO_RESOLUTION
        self.model_params = model_params or {}
        self.request_schema = request_schema or {}
        raw_generate_audio = (
            os.environ.get("NEWAPI_VIDEO_GENERATE_AUDIO", "").strip().lower()
        )
        if generate_audio is not None:
            self.generate_audio = generate_audio
        elif raw_generate_audio == "auto" or not raw_generate_audio:
            self.generate_audio = self._default_generate_audio_for_model(self.model)
        else:
            self.generate_audio = raw_generate_audio in {"true", "1", "yes", "on"}

        if not self.api_key and not (
            self.egress_context is not None and self.egress_context.is_organization
        ):
            raise ValueError(
                "DramaClawAPI key must be set for DramaClawAPI video generation"
            )

    @staticmethod
    def _extract_request_id(text: str = "", headers: object | None = None) -> str:
        if headers:
            for header_name in (
                "x-request-id",
                "x-newapi-request-id",
                "x-oneapi-request-id",
            ):
                value = getattr(headers, "get", lambda _name: "")(header_name)
                if value:
                    return str(value)

        if text:
            try:
                data = json.loads(text)
            except json.JSONDecodeError:
                data = None
            if isinstance(data, dict):
                error_obj = (
                    data.get("error") if isinstance(data.get("error"), dict) else {}
                )
                for candidate in (
                    data.get("request_id"),
                    data.get("requestId"),
                    error_obj.get("request_id"),
                    error_obj.get("requestId"),
                ):
                    if isinstance(candidate, str) and candidate:
                        return candidate
                text = str(error_obj.get("message") or text)

            match = re.search(
                r"request[\s_-]*id[:]\s*([A-Za-z0-9_-]+)", text, re.IGNORECASE
            )
            if match:
                return match.group(1)

        return ""

    @property
    def headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    @staticmethod
    def _client_timeout() -> aiohttp.ClientTimeout:
        return aiohttp.ClientTimeout(total=NEWAPI_VIDEO_HTTP_TIMEOUT_SECONDS)

    async def _post_json(
        self,
        url: str,
        payload: dict,
        *,
        headers: dict[str, str] | None = None,
    ) -> dict:
        async with aiohttp.ClientSession(timeout=self._client_timeout()) as session:
            async with session.post(
                url, json=payload, headers=headers or self.headers
            ) as resp:
                text = await resp.text()
                if resp.status < 200 or resp.status >= 300:
                    request_id = self._extract_request_id(text, resp.headers)
                    raise NewApiVideoError(
                        f"DramaClawAPI submit failed: HTTP {resp.status} - {text}",
                        request_id=request_id,
                        status_code=resp.status,
                    )
                try:
                    data = json.loads(text)
                    if isinstance(data, dict):
                        data["_newapi_request_id"] = self._extract_request_id(
                            text, resp.headers
                        )
                    return data
                except json.JSONDecodeError as exc:
                    raise RuntimeError(
                        f"DramaClawAPI submit returned invalid JSON: {text}"
                    ) from exc

    async def _get_json(
        self,
        url: str,
        *,
        headers: dict[str, str] | None = None,
    ) -> dict:
        async with aiohttp.ClientSession(timeout=self._client_timeout()) as session:
            async with session.get(url, headers=headers or self.headers) as resp:
                text = await resp.text()
                if resp.status < 200 or resp.status >= 300:
                    request_id = self._extract_request_id(text, resp.headers)
                    raise NewApiVideoError(
                        f"DramaClawAPI task query failed: HTTP {resp.status} - {text}",
                        request_id=request_id,
                        status_code=resp.status,
                    )
                try:
                    return json.loads(text)
                except json.JSONDecodeError as exc:
                    raise RuntimeError(
                        f"DramaClawAPI task query returned invalid JSON: {text}"
                    ) from exc

    async def _download_video(self, url: str, output_path: str) -> VideoDeliveryReceipt:
        from novelvideo.utils.media_download import download_to_path

        return await download_to_path(url, output_path)

    @staticmethod
    def _archive_state(task: dict) -> tuple[str, bool] | None:
        archive = task.get("archive") if isinstance(task, dict) else None
        if not isinstance(archive, dict):
            return None
        status = str(archive.get("status") or "pending").strip().lower()
        return status, bool(archive.get("retryable"))

    def _archived_video_source(
        self, task: dict, *, fallback_url: str = ""
    ) -> ArchivedVideoSource | None:
        archive = task.get("archive") if isinstance(task, dict) else None
        if not isinstance(archive, dict):
            return None
        if str(archive.get("status") or "").strip().lower() != "success":
            return None
        raw_size = archive.get("size")
        try:
            size = max(0, int(raw_size or 0))
        except (TypeError, ValueError):
            size = 0
        return ArchivedVideoSource(
            asset_id=str(archive.get("asset_id") or ""),
            storage_provider=str(archive.get("storage_provider") or "").strip(),
            bucket=str(archive.get("bucket") or "").strip(),
            object_key=str(archive.get("object_key") or "").strip(),
            url=self._resolve_result_url(
                str(archive.get("url") or fallback_url or "").strip()
            ),
            content_type=str(archive.get("content_type") or "").strip(),
            size=size,
            sha256=str(archive.get("sha256") or "").strip().lower(),
        )

    @staticmethod
    def _ext_from_data_url_header(header: str, default: str = "png") -> str:
        mime_type = header.removeprefix("data:").split(";", 1)[0].strip().lower()
        return {
            "image/jpeg": "jpg",
            "image/jpg": "jpg",
            "image/png": "png",
            "image/webp": "webp",
            "video/mp4": "mp4",
            "video/webm": "webm",
            "audio/mpeg": "mp3",
            "audio/mp3": "mp3",
            "audio/wav": "wav",
            "audio/x-wav": "wav",
            "audio/mp4": "m4a",
        }.get(mime_type, default)

    @classmethod
    async def _relay_frame_input(
        cls, image_value: str, *, default_ext: str = "png"
    ) -> str:
        return await cls._relay_media_input(
            image_value,
            default_ext=default_ext,
            image_transform=IMAGE_TRANSFORM_AI_REFERENCE_JPEG,
        )

    @classmethod
    async def _relay_media_input(
        cls,
        media_value: str,
        *,
        default_ext: str = "png",
        resource_type: str = "image",
        image_transform: str | None = None,
    ) -> str:
        media_value = str(media_value or "").strip()
        if not media_value:
            raise ValueError("empty media input")
        if media_value.startswith(("http://", "https://")):
            return media_value

        if media_value.startswith("data:"):
            header, _, encoded = media_value.partition(",")
            if ";base64" not in header or not encoded:
                raise ValueError("unsupported data URL media input")
            import base64

            data = base64.b64decode(encoded)
            ext = cls._ext_from_data_url_header(header, default_ext)
            return await asyncio.to_thread(
                upload_media_bytes,
                data,
                ext=ext,
                ttl=media_relay_ttl_seconds(
                    minimum=NEWAPI_MEDIA_INPUT_MIN_TTL_SECONDS,
                ),
                resource_type=resource_type,
                image_transform=image_transform,
            )

        media_path = Path(media_value)
        ext = media_path.suffix.lstrip(".") or default_ext
        return await asyncio.to_thread(
            upload_media_bytes,
            media_path.read_bytes(),
            ext=ext,
            ttl=media_relay_ttl_seconds(
                minimum=NEWAPI_MEDIA_INPUT_MIN_TTL_SECONDS,
            ),
            resource_type=resource_type,
            image_transform=image_transform,
        )

    async def _apply_huimeng_protocol_media_inputs(
        self,
        metadata: dict[str, object],
        *,
        mode: str,
        image_path: str,
        last_frame_path: str | None,
        references: object,
        log: Callable[[str], None],
    ) -> None:
        """Populate the stable DramaClaw-to-RelayClaw video media protocol."""

        normalized_mode = {
            "textToVideo": "text_to_video",
            "imageToVideo": "image_reference",
            "firstLastFrame": "first_last_frame",
            "imageReference": "image_reference",
            "allReference": "all_reference",
            "videoEdit": "video_edit",
            "videoExtend": "video_extend",
            "videoUpscale": "video_upscale",
            "videoFrameRate": "video_frame_rate",
        }.get(str(mode or "").strip(), str(mode or "").strip())

        if normalized_mode == "text_to_video":
            return

        if normalized_mode == "first_frame":
            first_frame_path = image_path
            if not first_frame_path:
                first_frame_path = next(
                    (
                        str(getattr(ref, "path", "") or "").strip()
                        for ref in (references if isinstance(references, list) else [])
                        if str(getattr(ref, "type", "") or "image").strip().lower()
                        == "image"
                    ),
                    "",
                )
            if not first_frame_path:
                raise ValueError("first frame is required for first_frame mode")
            metadata["image_url"] = await self._relay_frame_input(first_frame_path)
            return

        if normalized_mode == "first_last_frame":
            if not image_path and not last_frame_path:
                raise ValueError(
                    "at least one keyframe is required for first_last_frame mode"
                )
            if image_path:
                metadata["first_frame_image"] = await self._relay_frame_input(
                    image_path
                )
            if last_frame_path:
                metadata["last_frame_image"] = await self._relay_frame_input(
                    str(last_frame_path)
                )
            return

        raw_items: list[tuple[str, str, str]] = []
        for ref in references if isinstance(references, list) else []:
            media_type = str(getattr(ref, "type", "") or "image").strip().lower()
            path = str(getattr(ref, "path", "") or "").strip()
            role = str(getattr(ref, "role", "") or "").strip()
            if path and media_type in {"image", "video", "audio", "file", "link"}:
                raw_items.append((media_type, path, role))

        seen: set[tuple[str, str]] = set()
        relayed: dict[str, list[tuple[str, str]]] = {
            "image": [],
            "video": [],
            "audio": [],
            "file": [],
            "link": [],
        }
        for media_type, path, role in raw_items:
            identity = (media_type, path)
            if identity in seen:
                continue
            seen.add(identity)
            if media_type == "image":
                url = await self._relay_frame_input(path)
            elif media_type == "link":
                parsed = urllib.parse.urlsplit(path)
                if parsed.scheme not in {"http", "https"} or not parsed.hostname:
                    raise ValueError("reference link must be an HTTP/HTTPS URL")
                url = path
            else:
                url = await self._relay_media_input(
                    path,
                    default_ext=(
                        "mp4"
                        if media_type == "video"
                        else "mp3" if media_type == "audio" else "bin"
                    ),
                    resource_type="raw" if media_type == "file" else "video",
                )
            if not path.startswith(("http://", "https://")):
                log(f"{media_type} reference asset uploaded to media relay")
            relayed[media_type].append((url, role))

        image_urls = [url for url, _role in relayed["image"]]
        video_urls = [url for url, _role in relayed["video"]]
        audio_urls = [url for url, _role in relayed["audio"]]
        file_urls = [url for url, _role in relayed["file"]]
        link_urls = [url for url, _role in relayed["link"]]

        if file_urls and link_urls:
            raise ValueError("reference_file and reference_link are mutually exclusive")

        if normalized_mode in {
            "image_reference",
            "all_reference",
            "video_edit",
            "video_extend",
            "video_upscale",
            "video_frame_rate",
        }:
            if image_urls:
                metadata["reference_images"] = image_urls
            if video_urls:
                metadata["reference_videos"] = video_urls
            if audio_urls:
                metadata["reference_audios"] = audio_urls
            if file_urls:
                metadata["reference_file"] = file_urls[0]
            if link_urls:
                metadata["reference_link"] = link_urls[0]
            return

        raise ValueError(f"unsupported video generation mode: {normalized_mode}")

    def _duration_bounds(self) -> tuple[int, int]:
        from novelvideo.video_duration import video_duration_bounds_for_backend

        bounds = video_duration_bounds_for_backend(f"newapi_{self.model}")
        if bounds[0] is None or bounds[1] is None:
            return 2, 12
        return int(bounds[0]), int(bounds[1])

    def _is_seedance2_model(self) -> bool:
        return self.model.strip().startswith("seedance-2.0")

    def _is_happyhorse_model(self) -> bool:
        return self.model.strip().lower() == "happyhorse-1.0"

    def _is_grok_video_channel_model(self) -> bool:
        return self.model.strip().lower() == "grok-video-channel"

    @staticmethod
    def _happyhorse_ratio(value: str | None) -> str:
        text = str(value or "").strip()
        return text if text in {"16:9", "9:16", "1:1", "4:3", "3:4"} else "16:9"

    @staticmethod
    def _happyhorse_resolution(value: str | None) -> str:
        text = str(value or "").strip().lower()
        if "720" in text:
            return "720P"
        return "1080P"

    @staticmethod
    def _happyhorse_audio_setting(value: str | None) -> str:
        text = str(value or "").strip().lower()
        return text if text in {"auto", "origin"} else "auto"

    @staticmethod
    def _video_dimensions(
        resolution: object,
        ratio: object,
    ) -> tuple[int, int] | None:
        """Convert a resolution tier and aspect ratio to exact pixel dimensions."""

        resolution_text = str(resolution or "").strip().lower()
        p_match = re.fullmatch(r"(\d+)p", resolution_text)
        # Preserve compatibility with older catalogs that stored video tiers
        # as bare values such as "1080" instead of "1080p".
        if p_match is None:
            p_match = re.fullmatch(r"(\d{3,4})", resolution_text)
        video_k_long_edges = {
            "2k": 2560,
            "4k": 3840,
        }
        long_edge = video_k_long_edges.get(resolution_text)
        ratio_text = str(ratio or "").strip().lower()
        if (
            (p_match is None and long_edge is None)
            or ratio_text == "adaptive"
            or ":" not in ratio_text
        ):
            return None
        try:
            ratio_width, ratio_height = (
                float(part.strip()) for part in ratio_text.split(":", 1)
            )
        except (TypeError, ValueError):
            return None
        if ratio_width <= 0 or ratio_height <= 0:
            return None

        if long_edge is not None:
            if ratio_width >= ratio_height:
                width = long_edge
                height = round(long_edge * ratio_height / ratio_width)
            else:
                height = long_edge
                width = round(long_edge * ratio_width / ratio_height)
        else:
            short_edge = int(p_match.group(1))
            if short_edge <= 0:
                return None
            if ratio_width >= ratio_height:
                height = short_edge
                width = round(short_edge * ratio_width / ratio_height)
            else:
                width = short_edge
                height = round(short_edge * ratio_height / ratio_width)

        # Video encoders generally require even dimensions.
        width += width % 2
        height += height % 2
        return width, height

    @classmethod
    def _canonicalize_video_payload(
        cls,
        payload: dict[str, object],
        metadata: dict[str, object],
    ) -> None:
        """Translate legacy channel-shaped fields into the generic NewAPI contract.

        Existing model-specific branches still validate and collect their inputs
        during phase one. Only the final wire representation is normalized here.
        """

        # Keep the model-level semantics in metadata even after deriving the
        # generic width/height fields. NewAPI model adapters may need the
        # original ratio/resolution (notably for image-to-video) and cannot
        # reliably reconstruct them from an input image's exact pixel ratio.
        resolution = metadata.get("resolution", "")
        ratio = metadata.get("ratio", "")
        if resolution:
            metadata["resolution"] = str(resolution).strip().lower()
            resolution = metadata["resolution"]
        if ratio:
            metadata["ratio"] = str(ratio).strip().lower()
            ratio = metadata["ratio"]

        duration_value = payload.pop("duration", None)
        legacy_seconds = payload.pop("seconds", None)
        if duration_value is None:
            duration_value = legacy_seconds
        if str(duration_value or "").strip().lower() == "auto":
            payload["duration"] = "auto"
        else:
            try:
                duration_number = float(str(duration_value))
            except (TypeError, ValueError):
                duration_number = 0
            if duration_number > 0:
                payload["duration"] = (
                    int(duration_number)
                    if duration_number.is_integer()
                    else duration_number
                )

        first_frame = ""
        for key in ("first_frame_image", "image_url"):
            value = metadata.pop(key, "")
            if not first_frame and isinstance(value, str) and value.strip():
                first_frame = value.strip()

        last_frame = metadata.pop("last_frame_image", "")
        if not isinstance(last_frame, str):
            last_frame = ""

        legacy_images = payload.pop("images", None)
        if isinstance(legacy_images, list):
            image_values = [
                str(value).strip()
                for value in legacy_images
                if isinstance(value, str) and str(value).strip()
            ]
            if image_values and not first_frame:
                first_frame = image_values[0]
            if len(image_values) > 1:
                references = metadata.get("reference_images")
                existing = list(references) if isinstance(references, list) else []
                metadata["reference_images"] = [*image_values[1:], *existing]

        content = metadata.pop("content", None)
        if isinstance(content, list):
            for item in content:
                if not isinstance(item, dict) or item.get("type") != "image_url":
                    continue
                image_url = item.get("image_url")
                url = image_url.get("url") if isinstance(image_url, dict) else image_url
                if not isinstance(url, str) or not url.strip():
                    continue
                role = str(item.get("role") or "").strip().lower().replace(" ", "_")
                if role == "last_frame" and not last_frame:
                    last_frame = url.strip()
                elif role == "first_frame" and not first_frame:
                    first_frame = url.strip()

        legacy_video = metadata.pop("video_url", "")
        if isinstance(legacy_video, str) and legacy_video.strip():
            references = metadata.get("reference_videos")
            existing = list(references) if isinstance(references, list) else []
            metadata["reference_videos"] = [legacy_video.strip(), *existing]

        if first_frame:
            payload["image"] = first_frame
        if last_frame.strip():
            metadata["last_frame_image"] = last_frame.strip()

        ratio_text = str(ratio or "").strip().lower()
        if ratio_text in {"auto", "adaptive"}:
            # Video follow-input geometry is expressed by ratio only. Sending
            # width/height as well would turn an automatic request back into a
            # fixed-size request at the NewAPI adapter boundary.
            metadata["ratio"] = "auto"
            metadata.pop("aspect_ratio", None)
            payload.pop("width", None)
            payload.pop("height", None)
        elif dimensions := cls._video_dimensions(resolution, ratio_text):
            payload["width"], payload["height"] = dimensions
            # Keep the selected ratio semantics beside the derived dimensions;
            # resolution remains the independent model/charging tier.
            metadata["ratio"] = ratio_text
            metadata.pop("aspect_ratio", None)
        else:
            resolution_text = str(resolution or "").strip()
            if ratio_text:
                metadata["ratio"] = ratio_text
            if resolution_text:
                metadata["resolution"] = resolution_text

        payload["n"] = 1
        payload["response_format"] = "url"
        if metadata:
            payload["metadata"] = metadata
        else:
            payload.pop("metadata", None)

    @staticmethod
    def _task_response_data(task: dict) -> dict:
        """Accept both flat and wrapped generic task responses."""

        if not isinstance(task, dict):
            return {}
        data = task.get("data")
        if isinstance(data, dict):
            merged = dict(data)
            if "_newapi_request_id" not in merged and task.get("_newapi_request_id"):
                merged["_newapi_request_id"] = task["_newapi_request_id"]
            return merged
        return task

    @classmethod
    def _task_id_from_submit_response(cls, submitted: dict) -> str:
        task = cls._task_response_data(submitted)
        return str(task.get("task_id") or task.get("id") or "").strip()

    async def _relay_seedance2_references(
        self,
        references: list["ShotReference"] | None,
        *,
        log: Callable[[str], None],
    ) -> dict[str, list[str]]:
        reference_urls: dict[str, list[str]] = {}
        for ref in references or []:
            ref_type = str(getattr(ref, "type", "") or "image").strip().lower()
            path = str(getattr(ref, "path", "") or "").strip()
            if not path:
                continue
            if ref_type == "image":
                key = "reference_images"
                default_ext = "png"
                label = "image reference"
                image_transform = IMAGE_TRANSFORM_AI_REFERENCE_JPEG
                resource_type = "image"
            elif ref_type == "video":
                key = "reference_videos"
                default_ext = "mp4"
                label = "video reference"
                image_transform = None
                resource_type = "video"
            elif ref_type == "audio":
                key = "reference_audios"
                default_ext = "mp3"
                label = "audio reference"
                image_transform = None
                resource_type = "video"
            else:
                continue
            url = await self._relay_media_input(
                path,
                default_ext=default_ext,
                resource_type=resource_type,
                image_transform=image_transform,
            )
            if not path.startswith(("http://", "https://")):
                log(f"{label} uploaded to media relay")
            reference_urls.setdefault(key, []).append(url)
        return reference_urls

    @staticmethod
    def _extract_video_url(task: dict) -> str:
        if not isinstance(task, dict):
            return ""

        result_url = task.get("result_url")
        if isinstance(result_url, str) and result_url.strip():
            return result_url.strip()

        metadata = task.get("metadata")
        if isinstance(metadata, dict):
            for key in ("url", "video_url"):
                value = metadata.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        for key in ("url", "video_url"):
            value = task.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return ""

    def _resolve_result_url(self, result_url: str) -> str:
        """Make gateway-local result URLs reachable from this process."""
        value = str(result_url or "").strip()
        parsed = urllib.parse.urlsplit(value)
        if parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
            return value
        gateway = urllib.parse.urlsplit(self.base_url)
        if not gateway.scheme or not gateway.netloc:
            return value
        return urllib.parse.urlunsplit(
            (gateway.scheme, gateway.netloc, parsed.path, parsed.query, parsed.fragment)
        )

    @staticmethod
    def _extract_returned_last_frame_url(task: dict) -> str:
        if not isinstance(task, dict):
            return ""
        from novelvideo.generators.huimengi import extract_huimeng_result_last_frame_url

        containers: list[dict] = []
        for value in (
            task.get("metadata"),
            task.get("response"),
            task.get("result"),
            task.get("output"),
            task.get("data"),
            task,
        ):
            if not isinstance(value, dict):
                continue
            containers.append(value)
            for nested_key in ("result", "output", "data", "response", "metadata"):
                nested = value.get(nested_key)
                if isinstance(nested, dict):
                    containers.append(nested)
        seen: set[int] = set()
        for container in containers:
            ident = id(container)
            if ident in seen:
                continue
            seen.add(ident)
            found = extract_huimeng_result_last_frame_url(container)
            if found:
                return found
        return ""

    @staticmethod
    def _extract_provider_task_id(task: dict, *, fallback: str = "") -> str:
        if not isinstance(task, dict):
            return fallback
        containers = [
            task.get("metadata"),
            task.get("response"),
            task.get("result"),
            task.get("output"),
            task.get("data"),
            task,
        ]
        keys = (
            "provider_task_id",
            "huimeng_task_id",
            "upstream_task_id",
            "upstream_id",
            "task_id",
        )
        for container in containers:
            if not isinstance(container, dict):
                continue
            for key in keys:
                value = container.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        return fallback

    @classmethod
    def _returned_last_frame_output_path(
        cls, output_path: str, last_frame_url: str
    ) -> Path:
        video_output_path = Path(output_path)
        suffix = ""
        if last_frame_url.startswith("data:"):
            header, _, _encoded = last_frame_url.partition(",")
            suffix = f".{cls._ext_from_data_url_header(header, default='png')}"
        else:
            parsed_url = urllib.parse.urlparse(last_frame_url)
            suffix = Path(parsed_url.path).suffix.lower()
        if suffix not in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
            suffix = ".png"
        return (
            video_output_path.parent
            / "returned_last_frames"
            / f"{video_output_path.stem}{suffix}"
        )

    def _request_egress_context(self, kwargs: dict[str, Any]):
        supplied = _video_egress_context(kwargs.get("egress_context"))
        if (
            supplied is not None
            and self.egress_context is not None
            and supplied != self.egress_context
        ):
            raise VideoEgressError("TASK_ENVELOPE_INVALID")
        return supplied or self.egress_context

    @staticmethod
    def _admission_from_egress_context(context):
        from novelvideo.ports.authz import AdmissionContext

        return AdmissionContext(
            requester_user_id=context.requester_user_id,
            billing_principal=context.billing_principal,
            credential=context.credential,
            admission_id=context.admission_id,
            root_task_id=context.root_task_id,
            admitted_at=context.admitted_at,
            membership_id=context.membership_id,
            authz_version=context.authz_version,
        )

    @staticmethod
    def _operation_spec(context, payload: dict[str, object], kwargs: dict[str, Any]):
        from novelvideo.ports.egress_operations import (
            HandleKind,
            OperationSpec,
            canonical_request_digest,
        )

        task_type = str(kwargs.get("task_type") or context.task_type).strip()
        episode = int(kwargs.get("episode") or 0)
        beat_num = int(kwargs.get("beat_num") or 0)
        scope = str(kwargs.get("scope") or "task").strip()
        digest_input = {
            "request": payload,
            "requester_user_id": context.requester_user_id,
            "organization_id": context.billing_principal.id,
            "membership_id": context.membership_id,
            "authz_version": context.authz_version,
            "root_task_id": context.root_task_id,
            "project_id": context.project_id,
            "credential_id": context.credential.credential_id,
            "credential_version": context.credential.key_version,
        }
        return OperationSpec(
            organization_id=context.billing_principal.id,
            project_id=context.project_id,
            root_task_id=context.root_task_id,
            business_task_id=(
                f"{task_type}:episode:{episode}:beat:{beat_num}:scope:{scope}:generate"
            ),
            capability="video.generate.gateway",
            credential_id=context.credential.credential_id,
            credential_version=context.credential.key_version,
            request_digest=canonical_request_digest(digest_input),
            handle_kind=HandleKind.PROVIDER_JOB,
        )

    @staticmethod
    def _media_request_identity(value: object) -> dict[str, object]:
        text = str(value or "").strip()
        if not text:
            return {"kind": "none"}
        if text.startswith(("http://", "https://", "data:")):
            return {"kind": "remote", "value": text}
        path = Path(text)
        try:
            digest = hashlib.sha256()
            size = 0
            with path.open("rb") as media_file:
                while chunk := media_file.read(1024 * 1024):
                    digest.update(chunk)
                    size += len(chunk)
            return {"kind": "local", "sha256": digest.hexdigest(), "size": size}
        except OSError:
            return {"kind": "unreadable", "path": text}

    async def _resolve_organization_request(self, context):
        from novelvideo.ports import get_model_credentials

        resolved = await get_model_credentials().resolve(
            self._admission_from_egress_context(context)
        )
        if resolved.reference != context.credential:
            from novelvideo.ports.model_credentials import ModelCredentialError

            raise ModelCredentialError("ORG_CREDENTIAL_VERSION_MISMATCH")
        return resolved

    async def _revalidate_organization(self, context=None) -> None:
        context = context or self.egress_context
        if context is None or not context.is_organization:
            return
        from novelvideo.ports import get_authz_port
        from novelvideo.ports.authz import AuthzError

        authz = get_authz_port()

        async def read_current():
            return await authz.admit_model_task(
                user_id=context.requester_user_id,
                root_task_id=context.root_task_id,
            )

        try:
            current = await retry_authz_read(
                read_current,
                max_retries=_POST_ACCEPT_AUTHZ_MAX_RETRIES,
                base_delay=_POST_ACCEPT_AUTHZ_RETRY_BASE_SECONDS,
                cap_delay=_POST_ACCEPT_AUTHZ_RETRY_CAP_SECONDS,
                sleep=_POST_ACCEPT_AUTHZ_RETRY_SLEEP,
                random=_POST_ACCEPT_AUTHZ_RETRY_RANDOM,
                call_site="video_post_accept_revalidation",
            )
        except AuthzError as exc:
            if exc.code not in {
                "ORG_CREDENTIAL_MISSING",
                "ORG_CREDENTIAL_DISABLED",
                "ORG_CREDENTIAL_VERSION_MISMATCH",
            }:
                raise

            async def read_authority():
                return await authz.snapshot(user_id=context.requester_user_id)

            snapshot = await retry_authz_read(
                read_authority,
                max_retries=_POST_ACCEPT_AUTHZ_MAX_RETRIES,
                base_delay=_POST_ACCEPT_AUTHZ_RETRY_BASE_SECONDS,
                cap_delay=_POST_ACCEPT_AUTHZ_RETRY_CAP_SECONDS,
                sleep=_POST_ACCEPT_AUTHZ_RETRY_SLEEP,
                random=_POST_ACCEPT_AUTHZ_RETRY_RANDOM,
                call_site="video_post_accept_revalidation",
            )
            snapshot.require_active(expected_authz_version=context.authz_version)
            if (
                snapshot.requester_user_id != context.requester_user_id
                or snapshot.org_id != context.billing_principal.id
                or snapshot.membership_id != context.membership_id
                or snapshot.authz_version != context.authz_version
            ):
                raise AuthzError("ORG_AUTHZ_STALE") from None
            return
        # The provider job is already bound to the exact credential resolved before
        # submit. A later active-Key rotation is not an authorization change: keep
        # polling with the frozen request headers while still enforcing every other
        # organization, membership, and authz-version boundary below.
        if (
            current.requester_user_id != context.requester_user_id
            or current.billing_principal != context.billing_principal
            or current.membership_id != context.membership_id
            or current.authz_version != context.authz_version
        ):
            raise AuthzError("ORG_AUTHZ_STALE")

    @staticmethod
    def _running_authority_error(
        exc: AuthzError,
    ) -> AuthzError | RunningTaskAuthorityIndeterminate:
        if exc.code == "P0_GRAY_DISABLED":
            return detach_authz_error(exc)
        return RunningTaskAuthorityIndeterminate(
            failure_kind=str(getattr(exc, "failure_kind", "drift"))
        )

    @staticmethod
    async def _mark_operation_unknown(
        operation_port, claim, *, expected_version: int
    ) -> None:
        try:
            await operation_port.mark_unknown(
                operation_id=claim.operation.operation_id,
                transition_token=claim.transition_token,
                expected_version=expected_version,
            )
        except Exception as exc:
            raise VideoEgressError("EGRESS_OPERATION_TRANSITION_FAILED") from None

    @staticmethod
    async def _mark_operation_rejected(operation_port, claim) -> None:
        try:
            await operation_port.mark_rejected_before_submit(
                operation_id=claim.operation.operation_id,
                transition_token=claim.transition_token,
                expected_version=claim.operation.version,
            )
        except Exception as exc:
            raise VideoEgressError("EGRESS_OPERATION_TRANSITION_FAILED") from None

    async def generate(
        self,
        image_path: Optional[str],
        prompt: str,
        output_path: str,
        aspect_ratio: str = "9:16",
        duration: float = 5.0,
        poll_interval: float = 5.0,
        max_polls: int = 360,
        on_log: Optional[Callable[[str], None]] = None,
        on_progress: Optional[Callable[[float], None]] = None,
        last_frame_path: Optional[str] = None,
        **kwargs,
    ) -> VideoGenResult:
        def log(msg: str):
            if on_log:
                on_log(msg)

        def progress(value: float):
            if on_progress:
                on_progress(value)

        project_output_dir = kwargs.get("project_output_dir")
        tracking_episode = kwargs.get("episode")
        tracking_beat_num = kwargs.get("beat_num")
        tracking_task_type = kwargs.get("task_type", "")
        tracking_cost_estimate = kwargs.get("cost_estimate")

        def record_accepted(request_id: str):
            if not project_output_dir or not request_id:
                return
            try:
                record_video_request(
                    project_output_dir=project_output_dir,
                    request_id=request_id,
                    provider="newapi",
                    model_name=self.model,
                    episode=tracking_episode,
                    beat_num=tracking_beat_num,
                    task_type=tracking_task_type,
                    duration_seconds=float(duration),
                    cost_estimate=tracking_cost_estimate,
                )
            except Exception as exc:
                log(f"Billing failed (accepted): {exc}")

        def update_request_status(
            request_id: str,
            status: str,
            error_message: str | None = None,
        ):
            if not project_output_dir or not request_id:
                return
            try:
                update_video_request_status(
                    project_output_dir=project_output_dir,
                    request_id=request_id,
                    status=status,
                    error_message=error_message,
                )
            except Exception as exc:
                log(f"Billing failed ({status}): {exc}")

        requested_mode = str(kwargs.get("gen_mode") or "").strip()
        normalized_requested_mode = {
            "videoUpscale": "video_upscale",
            "videoFrameRate": "video_frame_rate",
        }.get(requested_mode, requested_mode)
        is_processing_model = normalized_requested_mode in {
            "video_upscale",
            "video_frame_rate",
        }
        is_seedance2_model = self._is_seedance2_model()
        seedance2_config = (
            _seedance2_config_mapping(kwargs.get("seedance2_config"))
            if is_seedance2_model
            else {}
        )
        duration = _seedance2_duration_from_config(seedance2_config, duration)
        original_duration = duration
        from novelvideo.video_duration import normalize_video_duration_for_backend

        if not is_processing_model:
            duration = normalize_video_duration_for_backend(
                f"newapi_{self.model}",
                duration,
            )
        if duration != original_duration:
            log(f"Duration adjusted: {original_duration:.1f}s -> {duration:.0f}s")

        ratio_text = str(aspect_ratio or "").strip().lower()
        # Seedance I2V uses ``adaptive`` to preserve the first-frame framing.
        # The old colon-only guard accidentally converted it back to 9:16.
        ratio = (
            ratio_text
            if ":" in ratio_text or ratio_text in {"auto", "adaptive"}
            else "9:16"
        )
        image_path = str(image_path or "").strip()
        metadata: dict[str, object] = {
            "resolution": self.resolution,
            "ratio": ratio,
            "watermark": False,
            "generate_audio": bool(self.generate_audio),
        }
        processing_metadata = kwargs.get("processing_metadata")
        if isinstance(processing_metadata, dict):
            metadata.update(processing_metadata)
        payload: dict[str, object] = {
            "model": self.model,
            "prompt": prompt,
            "seconds": str(duration),
            "metadata": metadata,
        }

        egress_context = self._request_egress_context(kwargs)
        organization_request = bool(
            egress_context is not None and egress_context.is_organization
        )
        task_id: str | None = None
        provider_request_id = ""
        reservation_id = ""
        operation_port = None
        operation_claim = None
        operation_version: int | None = None
        operation_terminal = False
        submit_attempted = False
        provider_completed = False
        provider_settled = False
        last_delivery_error = ""
        request_base_url = self.base_url
        request_headers = self.headers if not organization_request else None

        if organization_request:
            from novelvideo.ports import get_egress_operation_port

            references = [
                {
                    "type": str(getattr(ref, "type", "") or "image"),
                    "media": self._media_request_identity(getattr(ref, "path", "")),
                    "role": str(getattr(ref, "role", "") or ""),
                }
                for ref in (kwargs.get("references") or [])
            ]
            logical_request = {
                "model": self.model,
                "prompt": prompt,
                "seconds": str(duration),
                "ratio": ratio,
                "resolution": self.resolution,
                "generate_audio": bool(self.generate_audio),
                "gen_mode": requested_mode,
                "human_review": bool(kwargs.get("human_review", False)),
                "audio_setting": str(kwargs.get("audio_setting") or ""),
                "image": self._media_request_identity(image_path),
                "last_frame": self._media_request_identity(last_frame_path),
                "references": references,
                "seedance2_config": seedance2_config,
                "model_params": self.model_params,
                "request_schema": self.request_schema,
                "processing_metadata": processing_metadata,
            }
            operation_port = get_egress_operation_port()
            try:
                operation_claim = await operation_port.claim(
                    spec=self._operation_spec(egress_context, logical_request, kwargs)
                )
            except Exception as exc:
                raise VideoEgressError(
                    _safe_video_error_code(exc, "EGRESS_OPERATION_TRANSITION_FAILED")
                ) from None
            if not operation_claim.won:
                raise VideoEgressError("EGRESS_OPERATION_REPLAYED")
            operation_version = operation_claim.operation.version
            try:
                resolved = await self._resolve_organization_request(egress_context)
            except Exception as exc:
                await self._mark_operation_rejected(operation_port, operation_claim)
                operation_terminal = True
                raise VideoEgressError(
                    _safe_video_error_code(exc, "ORG_CREDENTIAL_DECRYPT_FAILED")
                ) from None
            request_base_url = resolved.base_url.rstrip("/")
            request_headers = {
                "Authorization": f"Bearer {resolved.api_key}",
                "Content-Type": "application/json",
            }

        async def fail_before_submit(error: str) -> VideoGenResult:
            nonlocal operation_terminal
            if organization_request and not operation_terminal:
                await self._mark_operation_rejected(operation_port, operation_claim)
                operation_terminal = True
            safe_error = (
                "EGRESS_OPERATION_REJECTED_BEFORE_SUBMIT"
                if organization_request
                else error
            )
            return VideoGenResult(status=VideoGenStatus.FAILED, error=safe_error)

        if requested_mode:
            try:
                await self._apply_huimeng_protocol_media_inputs(
                    metadata,
                    mode=requested_mode,
                    image_path=image_path,
                    last_frame_path=last_frame_path,
                    references=kwargs.get("references"),
                    log=log,
                )
            except (ValueError, FileNotFoundError) as exc:
                return await fail_before_submit(str(exc))
            seedance2_config = _seedance2_config_mapping(kwargs.get("seedance2_config"))
            scene_optimize = str(seedance2_config.get("scene_optimize") or "").strip()
            if scene_optimize:
                metadata["scene_optimize"] = scene_optimize
            if kwargs.get("human_review"):
                metadata["human_review"] = True
            audio_setting = str(kwargs.get("audio_setting") or "").strip()
            if audio_setting:
                metadata["audio_setting"] = audio_setting
            metadata["return_last_frame"] = bool(
                seedance2_config.get("return_last_frame", False)
            )
        elif self._is_happyhorse_model():
            if len(prompt) > 2500:
                prompt = prompt[:2500]
                payload["prompt"] = prompt
                log("Prompt truncated to the HappyHorse 1.0 limit of 2500 characters")

            duration_int = int(math.ceil(duration))
            metadata.pop("generate_audio", None)
            metadata["ratio"] = self._happyhorse_ratio(ratio)
            metadata["resolution"] = self._happyhorse_resolution(self.resolution)
            payload["duration"] = duration_int
            payload["seconds"] = str(duration_int)

            first_frame_path = ""
            reference_image_paths: list[str] = []
            video_reference_paths: list[str] = []
            for ref in kwargs.get("references") or []:
                ref_type = str(getattr(ref, "type", "") or "image").strip().lower()
                path = str(getattr(ref, "path", "") or "").strip()
                if not path:
                    continue
                if ref_type == "video":
                    video_reference_paths.append(path)
                    continue
                if ref_type != "image":
                    continue
                role = str(getattr(ref, "role", "") or "").strip().lower().replace(" ", "_")
                if "first_frame" in role and not first_frame_path:
                    first_frame_path = path
                else:
                    reference_image_paths.append(path)

            # image_path is the "first image" that run_freezone_video_gen passes in unconditionally. Only when it
            # does not already exist as a reference image is it passively promoted to the first frame -- otherwise reference mode (all images are in
            # reference_image_paths) would count the first image twice (first-frame slot + reference slot).
            if (
                not first_frame_path
                and image_path
                and image_path not in reference_image_paths
            ):
                first_frame_path = image_path

            # HappyHorse has no last-frame capability, and mixing the last frame into reference_images would wrongly trigger r2v,
            # conflicting with the first frame's image_url (upstream INVALID_PARAMS). The last frame is simply ignored here.
            if last_frame_path:
                log("HappyHorse does not support a last frame; the last-frame input was ignored")

            # HappyHorse's image_url (i2v) and reference_images (r2v/video editing) are mutually exclusive
            # and cannot appear in the same request. Strategy: references first -- whenever reference images or reference videos are present, go
            # r2v/video editing. The first frame then cannot use image_url, but its picture is still a valid reference,
            # so it is downgraded to the first position of reference_images (identity first) instead of being dropped entirely,
            # otherwise "2 images" would send only 1. Only a pure first frame (no other references) goes i2v.
            if (video_reference_paths or reference_image_paths) and first_frame_path:
                log("HappyHorse reference/video-editing mode does not support a first frame; the first frame was downgraded to a reference image")
                reference_image_paths.insert(0, first_frame_path)
                first_frame_path = ""

            # Docs: ratio only takes effect for t2v/r2v. The aspect of a first frame (i2v, image_url) and of video editing (video_url)
            # is determined by the input media and does not accept ratio; passing it triggers upstream INVALID_PARAMS.
            if first_frame_path or video_reference_paths:
                metadata.pop("ratio", None)

            try:
                if video_reference_paths:
                    video_url = await self._relay_media_input(
                        video_reference_paths[0],
                        default_ext="mp4",
                        resource_type="video",
                    )
                    if not video_reference_paths[0].startswith(("http://", "https://")):
                        log("Video reference uploaded to media relay")
                    metadata["video_url"] = video_url
                    metadata["audio_setting"] = self._happyhorse_audio_setting(
                        kwargs.get("audio_setting")
                    )

                relayed_references: list[str] = []
                for path in reference_image_paths[: 5 if video_reference_paths else 9]:
                    url = await self._relay_frame_input(path)
                    if not path.startswith(("http://", "https://")):
                        log("Image reference uploaded to media relay")
                    relayed_references.append(url)

                if first_frame_path:
                    first_frame_url = await self._relay_frame_input(first_frame_path)
                    if not first_frame_path.startswith(("http://", "https://")):
                        log("First frame uploaded to media relay")
                    metadata["image_url"] = first_frame_url
                    payload["images"] = [first_frame_url]

                if relayed_references:
                    metadata["reference_images"] = relayed_references
            except Exception as exc:
                return await fail_before_submit(f"media relay upload failed: {exc}")

        elif self._is_grok_video_channel_model():
            metadata.pop("generate_audio", None)
            metadata.pop("watermark", None)
            duration_int = int(math.ceil(duration))
            payload["duration"] = duration_int
            payload["seconds"] = str(duration_int)
            first_frame_path = image_path
            reference_image_paths: list[str] = []
            for ref in kwargs.get("references") or []:
                ref_type = str(getattr(ref, "type", "") or "image").strip().lower()
                path = str(getattr(ref, "path", "") or "").strip()
                if not path or ref_type != "image":
                    continue
                role = str(getattr(ref, "role", "") or "").strip().lower().replace(" ", "_")
                if not first_frame_path and "first_frame" in role:
                    first_frame_path = path
                    continue
                if path != first_frame_path:
                    reference_image_paths.append(path)

            try:
                if first_frame_path:
                    first_frame_url = await self._relay_frame_input(first_frame_path)
                    if not first_frame_path.startswith(("http://", "https://")):
                        log("First frame uploaded to media relay")
                    metadata["image_url"] = first_frame_url
                    payload["images"] = [first_frame_url]

                relayed_references: list[str] = []
                for path in reference_image_paths[:7]:
                    url = await self._relay_frame_input(path)
                    if not path.startswith(("http://", "https://")):
                        log("Reference image uploaded to media relay")
                    relayed_references.append(url)
                if relayed_references:
                    metadata["reference_images"] = relayed_references
            except Exception as exc:
                return await fail_before_submit(f"media relay upload failed: {exc}")

        elif is_seedance2_model:
            try:
                first_frame = (
                    await self._relay_frame_input(image_path) if image_path else ""
                )
                if image_path and not image_path.startswith(("http://", "https://")):
                    log("First frame uploaded to media relay")
                last_frame = (
                    await self._relay_frame_input(str(last_frame_path))
                    if last_frame_path
                    else ""
                )
                if last_frame_path and not str(last_frame_path).startswith(
                    ("http://", "https://")
                ):
                    log("Last frame uploaded to media relay")
                reference_params = await self._relay_seedance2_references(
                    kwargs.get("references") or [],
                    log=log,
                )
            except Exception as exc:
                return await fail_before_submit(f"media relay upload failed: {exc}")

            from novelvideo.seedance2_i2v.models import Seedance2I2VMode
            from novelvideo.seedance2_i2v.request import build_seedance2_huimeng_params

            has_references = any(reference_params.values())
            if last_frame:
                mode = Seedance2I2VMode.FIRST_LAST_FRAME
            elif has_references:
                mode = Seedance2I2VMode.MULTIMODAL_REFERENCE
            elif first_frame:
                mode = Seedance2I2VMode.FIRST_FRAME
            else:
                mode = Seedance2I2VMode.TEXT_TO_VIDEO

            config_resolution = str(
                seedance2_config.get("resolution") or self.resolution or "720p"
            ).strip()
            config_ratio = str(seedance2_config.get("ratio") or ratio or "9:16").strip()
            seedance2_config.update(
                {
                    "mode": mode.value,
                    "final_prompt": prompt,
                    "duration": duration,
                    "resolution": config_resolution,
                    "ratio": config_ratio,
                }
            )
            if "generate_audio" not in seedance2_config:
                seedance2_config["generate_audio"] = bool(self.generate_audio)
                seedance2_config["generate_audio_user_set"] = True
            elif "generate_audio_user_set" not in seedance2_config:
                seedance2_config["generate_audio_user_set"] = True
            if "return_last_frame" not in seedance2_config:
                seedance2_config["return_last_frame"] = False
            if "human_review" not in seedance2_config:
                seedance2_config["human_review"] = bool(
                    kwargs.get("human_review", False)
                )
                seedance2_config["human_review_user_set"] = True
            elif "human_review_user_set" not in seedance2_config:
                seedance2_config["human_review_user_set"] = True

            try:
                seedance2_params = build_seedance2_huimeng_params(
                    seedance2_config,
                    first_frame=first_frame,
                    last_frame=last_frame,
                    reference_images=reference_params.get("reference_images"),
                    reference_videos=reference_params.get("reference_videos"),
                    reference_audios=reference_params.get("reference_audios"),
                )
            except ValueError as exc:
                return await fail_before_submit(str(exc))

            payload["prompt"] = seedance2_params.pop("prompt")
            payload["seconds"] = str(seedance2_params.pop("duration"))
            metadata.update(seedance2_params)
        else:
            try:
                await self._apply_huimeng_protocol_media_inputs(
                    metadata,
                    mode=(
                        "first_last_frame"
                        if last_frame_path
                        else (
                            "first_frame"
                            if image_path
                            else (
                                "all_reference"
                                if kwargs.get("references")
                                else "text_to_video"
                            )
                        )
                    ),
                    image_path=image_path,
                    last_frame_path=last_frame_path,
                    references=kwargs.get("references"),
                    log=log,
                )
            except Exception as exc:
                return await fail_before_submit(f"media relay upload failed: {exc}")
        try:
            model_label = self._model_label(self.model)
            request_resolution = str(
                metadata.get("resolution") or self.resolution or ""
            ).strip()
            log(
                f"Submitting DramaClawAPI video task ({model_label}, {duration}s, {request_resolution})..."
            )
            progress(0.1)
            from novelvideo.media_model_request_schema import (
                apply_media_request_schema,
                enforce_newapi_media_geometry_contract,
                enforce_newapi_video_duration_contract,
                enforce_newapi_video_mode_contract,
            )

            self._canonicalize_video_payload(payload, metadata)
            payload = apply_media_request_schema(
                payload, self.request_schema, self.model_params
            )
            payload = enforce_newapi_video_mode_contract(
                payload,
                mode=requested_mode,
                fixed_duration=duration,
            )
            payload = enforce_newapi_media_geometry_contract(
                payload, media_type="video"
            )
            payload = enforce_newapi_video_duration_contract(payload)
            reservation_id = await _reserve_video_model_call(
                self.model,
                source="newapi_video_generation",
                resolution=request_resolution,
                duration_seconds=duration,
            )
            await update_current_model_call_log(
                request_payload=payload,
            )
            submit_attempted = True
            if organization_request:
                submitted = await self._post_json(
                    f"{request_base_url}/video/generations",
                    payload,
                    headers=request_headers,
                )
            else:
                submitted = await self._post_json(
                    f"{request_base_url}/video/generations", payload
                )
            await update_current_model_call_log(
                response_payload=submitted,
            )
            task_id = self._task_id_from_submit_response(submitted)
            provider_request_id = str(submitted.get("_newapi_request_id") or "").strip()
            if not task_id:
                if organization_request:
                    await self._mark_operation_unknown(
                        operation_port,
                        operation_claim,
                        expected_version=operation_version,
                    )
                    operation_terminal = True
                await _refund_video_model_call(
                    reservation_id,
                    source="newapi_video_generation",
                    error="missing_task_id",
                    provider_request_id=provider_request_id,
                )
                return VideoGenResult(
                    status=VideoGenStatus.FAILED,
                    error=(
                        "EGRESS_OPERATION_UNKNOWN"
                        if organization_request
                        else f"No task_id in DramaClawAPI response: {submitted}"
                    ),
                )
            if organization_request:
                accepted = await operation_port.mark_accepted(
                    operation_id=operation_claim.operation.operation_id,
                    transition_token=operation_claim.transition_token,
                    expected_version=operation_version,
                    provider_job_id=task_id,
                    requester_user_id=egress_context.requester_user_id,
                    membership_id=egress_context.membership_id,
                    authz_version=egress_context.authz_version,
                )
                operation_version = accepted.version
            try:
                await get_usage_meter().mark_current_paid_execution_attempt(
                    status="accepted",
                    provider_request_id=provider_request_id,
                    provider_task_id=task_id,
                    metadata={"source": "newapi_video_generation"},
                )
            except Exception as exc:  # noqa: BLE001
                log(f"Failed to stage billing call evidence; it will be verified by reconciliation: {exc}")
            record_accepted(task_id)
            log(f"Task submitted: {task_id}")
            progress(0.2)

            for poll_count in range(max_polls):
                if organization_request:
                    running_authority_error = None
                    try:
                        await self._revalidate_organization(egress_context)
                    except AuthzError as exc:
                        await self._mark_operation_unknown(
                            operation_port,
                            operation_claim,
                            expected_version=operation_version,
                        )
                        operation_terminal = True
                        running_authority_error = self._running_authority_error(exc)
                    except Exception as exc:
                        await self._mark_operation_unknown(
                            operation_port,
                            operation_claim,
                            expected_version=operation_version,
                        )
                        operation_terminal = True
                        return VideoGenResult(
                            status=VideoGenStatus.FAILED,
                            error=_safe_video_error_code(exc, "ORG_AUTHZ_STALE"),
                            task_id=task_id,
                        )
                    if running_authority_error is not None:
                        raise running_authority_error from None
                    polled = await self._get_json(
                        f"{request_base_url}/video/generations/{task_id}",
                        headers=request_headers,
                    )
                else:
                    polled = await self._get_json(
                        f"{request_base_url}/video/generations/{task_id}"
                    )
                task = self._task_response_data(polled)
                status = str(task.get("status") or "").lower()
                progress(0.2 + (poll_count / max(max_polls, 1)) * 0.7)

                if status in {"completed", "succeeded", "success", "done"}:
                    await update_current_model_call_log(
                        response_payload=polled,
                    )
                    provider_completed = True
                    if not provider_settled:
                        await _confirm_video_model_call(
                            model=self.model,
                            reservation_id=reservation_id,
                            provider_request_id=provider_request_id,
                            provider_task_id=task_id,
                        )
                        provider_settled = True

                    advertised_archive = self._archive_state(task)
                    archive_delivery = get_video_result_delivery()
                    archive_state = (
                        advertised_archive if archive_delivery is not None else None
                    )
                    if archive_delivery is not None and archive_state is None:
                        last_delivery_error = "VIDEO_ARCHIVE_MISSING"
                        update_request_status(
                            task_id, "delivery_failed", last_delivery_error
                        )
                        if organization_request:
                            await self._mark_operation_unknown(
                                operation_port,
                                operation_claim,
                                expected_version=operation_version,
                            )
                            operation_terminal = True
                        return VideoGenResult(
                            status=VideoGenStatus.FAILED,
                            error=last_delivery_error,
                            task_id=task_id,
                        )
                    if archive_state is not None:
                        archive_status, archive_retryable = archive_state
                        if archive_status != "success":
                            if (
                                archive_status in {"pending", "failed"}
                                and archive_retryable
                            ):
                                last_delivery_error = "VIDEO_ARCHIVE_PENDING"
                                update_request_status(
                                    task_id,
                                    "delivery_pending",
                                    last_delivery_error,
                                )
                                if poll_count % 6 == 0:
                                    log(
                                        lmsg(
                                            "tasks.log.video.waitingForArchive",
                                            "Video generation complete, waiting for the archive service...",
                                        )
                                    )
                                await asyncio.sleep(poll_interval)
                                continue
                            last_delivery_error = "VIDEO_ARCHIVE_FAILED"
                            update_request_status(
                                task_id,
                                "delivery_failed",
                                last_delivery_error,
                            )
                            if organization_request:
                                await self._mark_operation_unknown(
                                    operation_port,
                                    operation_claim,
                                    expected_version=operation_version,
                                )
                                operation_terminal = True
                            return VideoGenResult(
                                status=VideoGenStatus.FAILED,
                                error=last_delivery_error,
                                task_id=task_id,
                            )

                    progress(0.9)
                    video_url = self._resolve_result_url(self._extract_video_url(task))
                    archived_source = (
                        self._archived_video_source(task, fallback_url=video_url)
                        if archive_delivery is not None
                        else None
                    )
                    if archived_source is not None:
                        video_url = archived_source.url
                    if not video_url and archived_source is None:
                        safe_missing_result_error = (
                            "EGRESS_OPERATION_UNKNOWN"
                            if organization_request
                            else "No video url in DramaClawAPI result"
                        )
                        if organization_request:
                            await self._mark_operation_unknown(
                                operation_port,
                                operation_claim,
                                expected_version=operation_version,
                            )
                            operation_terminal = True
                        update_request_status(
                            task_id, "delivery_failed", safe_missing_result_error
                        )
                        return VideoGenResult(
                            status=VideoGenStatus.FAILED,
                            error=(
                                safe_missing_result_error
                                if organization_request
                                else f"No video url in DramaClawAPI result: {task}"
                            ),
                            task_id=task_id,
                        )
                    if organization_request:
                        running_authority_error = None
                        try:
                            await self._revalidate_organization(egress_context)
                        except AuthzError as exc:
                            await self._mark_operation_unknown(
                                operation_port,
                                operation_claim,
                                expected_version=operation_version,
                            )
                            operation_terminal = True
                            running_authority_error = self._running_authority_error(exc)
                        except Exception as exc:
                            await self._mark_operation_unknown(
                                operation_port,
                                operation_claim,
                                expected_version=operation_version,
                            )
                            operation_terminal = True
                            return VideoGenResult(
                                status=VideoGenStatus.FAILED,
                                error=_safe_video_error_code(exc, "ORG_AUTHZ_STALE"),
                                task_id=task_id,
                            )
                        if running_authority_error is not None:
                            raise running_authority_error from None
                    try:
                        if archived_source is not None:
                            log(
                                lmsg(
                                    "tasks.log.video.writingProjectStorage",
                                    "Video archived, writing to project storage...",
                                )
                            )
                            delivery = await archive_delivery.deliver(
                                source=archived_source,
                                output_path=output_path,
                            )
                        else:
                            log(
                                lmsg(
                                    "tasks.log.video.downloading",
                                    "Video generation complete, downloading...",
                                )
                            )
                            delivery = await self._download_video(
                                video_url, output_path
                            )
                    except VideoDeliveryError as exc:
                        last_delivery_error = exc.code
                        update_request_status(
                            task_id,
                            "delivery_pending" if exc.retryable else "delivery_failed",
                            last_delivery_error,
                        )
                        if exc.retryable and poll_count + 1 < max_polls:
                            log(
                                lmsg(
                                    "tasks.log.video.retryingDelivery",
                                    "Project storage is not ready yet, retrying delivery...",
                                )
                            )
                            await asyncio.sleep(poll_interval)
                            continue
                        if organization_request:
                            await self._mark_operation_unknown(
                                operation_port,
                                operation_claim,
                                expected_version=operation_version,
                            )
                            operation_terminal = True
                        return VideoGenResult(
                            status=VideoGenStatus.FAILED,
                            error=last_delivery_error,
                            task_id=task_id,
                        )
                    provider_task_id = self._extract_provider_task_id(
                        task,
                        fallback=task_id,
                    )
                    last_frame_url = ""
                    last_frame_path = ""
                    if bool(metadata.get("return_last_frame")):
                        last_frame_url = self._extract_returned_last_frame_url(task)
                        if last_frame_url:
                            if organization_request:
                                running_authority_error = None
                                try:
                                    await self._revalidate_organization(egress_context)
                                except AuthzError as exc:
                                    await self._mark_operation_unknown(
                                        operation_port,
                                        operation_claim,
                                        expected_version=operation_version,
                                    )
                                    operation_terminal = True
                                    running_authority_error = (
                                        self._running_authority_error(exc)
                                    )
                                except Exception as exc:
                                    await self._mark_operation_unknown(
                                        operation_port,
                                        operation_claim,
                                        expected_version=operation_version,
                                    )
                                    operation_terminal = True
                                    return VideoGenResult(
                                        status=VideoGenStatus.FAILED,
                                        error=_safe_video_error_code(
                                            exc, "ORG_AUTHZ_STALE"
                                        ),
                                        task_id=task_id,
                                    )
                                if running_authority_error is not None:
                                    raise running_authority_error from None
                            last_frame_output_path = (
                                self._returned_last_frame_output_path(
                                    output_path,
                                    last_frame_url,
                                )
                            )
                            await self._download_video(
                                last_frame_url,
                                str(last_frame_output_path),
                            )
                            last_frame_path = last_frame_output_path.as_posix()
                            log("Saved the last frame returned by DramaClawAPI")
                    progress(1.0)
                    update_request_status(task_id, "completed")
                    if organization_request:
                        if isinstance(delivery, VideoDeliveryReceipt):
                            result_sha256 = delivery.sha256
                        elif isinstance(delivery, bytes):
                            # Compatibility for injected/test download seams.
                            result_sha256 = hashlib.sha256(delivery).hexdigest()
                        else:
                            raise VideoDeliveryError(
                                "VIDEO_DELIVERY_RECEIPT_INVALID", retryable=False
                            )
                        result_ref = "video:sha256:" + result_sha256
                        completed = await operation_port.mark_completed(
                            operation_id=operation_claim.operation.operation_id,
                            transition_token=operation_claim.transition_token,
                            expected_version=operation_version,
                            result_ref=result_ref,
                        )
                        operation_version = completed.version
                        operation_terminal = True
                    return VideoGenResult(
                        status=VideoGenStatus.DONE,
                        video_url=video_url,
                        video_path=output_path,
                        last_frame_url=last_frame_url or None,
                        last_frame_path=last_frame_path or None,
                        task_id=task_id,
                        provider_task_id=provider_task_id,
                        duration_seconds=float(duration),
                    )

                if status in {
                    "failure",
                    "failed",
                    "error",
                    "canceled",
                    "cancelled",
                    "expired",
                }:
                    await update_current_model_call_log(
                        response_payload=polled,
                    )
                    error = (
                        task.get("error")
                        or task.get("fail_reason")
                        or "DramaClawAPI video task failed"
                    )
                    safe_task_error = (
                        (
                            classify_provider_video_task_error(task)
                            or provider_video_task_error_message(task)
                            or "EGRESS_OPERATION_UNKNOWN"
                        )
                        if organization_request
                        else str(error)
                    )
                    if organization_request:
                        await self._mark_operation_unknown(
                            operation_port,
                            operation_claim,
                            expected_version=operation_version,
                        )
                        operation_terminal = True
                    update_request_status(task_id, "failed", safe_task_error)
                    await _refund_video_model_call(
                        reservation_id,
                        source="newapi_video_generation",
                        error=safe_task_error,
                        provider_request_id=provider_request_id,
                        provider_task_id=task_id,
                    )
                    return VideoGenResult(
                        status=VideoGenStatus.FAILED,
                        error=safe_task_error,
                        task_id=task_id,
                    )

                if poll_count % 6 == 0:
                    log(
                        f"DramaClawAPI task {task_id} status: "
                        f"{status or 'queued'} ({poll_count}/{max_polls})"
                    )
                await asyncio.sleep(poll_interval)

            timeout_error = (
                last_delivery_error or "Timeout waiting for DramaClawAPI video task"
            )
            update_request_status(
                task_id,
                "delivery_pending" if provider_completed else "failed",
                timeout_error,
            )
            await update_current_model_call_log(
                response_payload={"status": "timeout", "task_id": task_id},
                error_message="video task polling timeout",
            )
            if organization_request:
                await self._mark_operation_unknown(
                    operation_port,
                    operation_claim,
                    expected_version=operation_version,
                )
                operation_terminal = True
            if not provider_completed:
                await _refund_video_model_call(
                    reservation_id,
                    source="newapi_video_generation",
                    error="timeout",
                    provider_request_id=provider_request_id,
                    provider_task_id=task_id,
                )
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=timeout_error,
                task_id=task_id,
            )
        except RunningTaskAuthorityIndeterminate as exc:
            # Provider acceptance is already durable.  This branch must not
            # resubmit the provider request or decide refund/confirm locally.
            if reservation_id and not provider_settled:
                try:
                    await get_usage_meter().mark_model_call_credit_settlement_for_review(
                        reservation_id,
                        metadata={
                            "source": "video_post_accept_authz_indeterminate",
                            "failure_kind": exc.failure_kind,
                            "provider_request_id": provider_request_id,
                            "provider_task_id": task_id or "",
                        },
                    )
                except Exception as review_exc:  # noqa: BLE001
                    logger.error(
                        "model_call_settlement_review_enqueue_failed",
                        extra={
                            "safe_error_type": type(review_exc).__name__,
                            "error_id": uuid.uuid4().hex,
                        },
                    )
            raise
        except VideoEgressError:
            raise
        except NewApiVideoError as exc:
            await update_current_model_call_log(
                response_payload={
                    "status_code": exc.status_code,
                    "request_id": exc.request_id,
                    "error_type": type(exc).__name__,
                },
                error_message=type(exc).__name__,
            )
            safe_exception_error = (
                (
                    _safe_video_error_code(exc, "")
                    or provider_video_error_message_from_text(str(exc))
                    or "EGRESS_OPERATION_UNKNOWN"
                )
                if organization_request
                else str(exc)
            )
            if (
                organization_request
                and operation_claim is not None
                and not operation_terminal
            ):
                if task_id is None and is_definite_no_cost_http_rejection(
                    exc.status_code
                ):
                    # A concrete HTTP rejection without a provider task id proves
                    # that the submit was not accepted.  ``submit_attempted`` only
                    # says that the request crossed our client boundary; it does
                    # not make an explicit 4xx response indeterminate.
                    await self._mark_operation_rejected(operation_port, operation_claim)
                elif submit_attempted:
                    await self._mark_operation_unknown(
                        operation_port,
                        operation_claim,
                        expected_version=operation_version,
                    )
                else:
                    await self._mark_operation_rejected(operation_port, operation_claim)
                operation_terminal = True
            if exc.request_id:
                log(f"DramaClawAPI request_id: {exc.request_id}")
            if task_id:
                log(f"DramaClawAPI task_id: {task_id}")
                update_request_status(task_id, "failed", safe_exception_error)
            elif is_definite_no_cost_http_rejection(exc.status_code):
                try:
                    await get_usage_meter().mark_current_paid_execution_attempt(
                        status="rejected_no_cost",
                        provider_request_id=exc.request_id or provider_request_id,
                        metadata={
                            "source": "newapi_video_generation",
                            "http_status": exc.status_code,
                            "error": "provider_request_rejected",
                        },
                    )
                except Exception as evidence_exc:  # noqa: BLE001
                    log(f"Failed to stage evidence of cost-free billing rejection; it will be verified by reconciliation: {evidence_exc}")
            if not provider_completed:
                await _refund_video_model_call(
                    reservation_id,
                    source="newapi_video_generation",
                    error=safe_exception_error,
                    provider_request_id=exc.request_id or provider_request_id,
                    provider_task_id=task_id or "",
                )
            if find_billing_error(exc) is not None or (
                is_insufficient_credits_error(exc) and not organization_request
            ):
                raise
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=safe_exception_error,
                task_id=task_id,
            )
        except Exception as exc:
            await update_current_model_call_log(
                error_message=type(exc).__name__,
            )
            safe_exception_error = (
                _safe_video_error_code(exc, "EGRESS_OPERATION_UNKNOWN")
                if organization_request
                else str(exc)
            )
            if (
                organization_request
                and operation_claim is not None
                and not operation_terminal
            ):
                if submit_attempted:
                    await self._mark_operation_unknown(
                        operation_port,
                        operation_claim,
                        expected_version=operation_version,
                    )
                else:
                    await self._mark_operation_rejected(operation_port, operation_claim)
                operation_terminal = True
            if task_id:
                update_request_status(task_id, "failed", safe_exception_error)
            if not provider_completed:
                await _refund_video_model_call(
                    reservation_id,
                    source="newapi_video_generation",
                    error=safe_exception_error,
                    provider_request_id=provider_request_id,
                    provider_task_id=task_id or "",
                )
            if find_billing_error(exc) is not None or (
                is_insufficient_credits_error(exc) and not organization_request
            ):
                raise
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=safe_exception_error,
                task_id=task_id,
            )


class ComfyUIVideoGenerator(VideoGeneratorBase):
    """ComfyUI Wan2.2 5B video generator.

    Communicates directly with the ComfyUI server for image-to-video.
    Uses WebSocket to listen to generation progress in real time.

    Supports three workflow modes:
    - GGUF: low-VRAM mode, using GGUF quantized models (~8GB VRAM)
    - fp8 I2V: standard quality mode, single-frame input generates video (~16GB VRAM)
    - fp8 FLF: first/last-frame mode, two-frame input generates a transition video (~16GB VRAM)

    Example:
        >>> # GGUF mode (default, low VRAM)
        >>> generator = ComfyUIVideoGenerator(workflow_type="gguf")
        >>> result = await generator.generate(
        ...     image_path="frame.png",
        ...     prompt="The character smiles and nods",
        ...     output_path="output.mp4",
        ...     duration=5.0,
        ... )

        >>> # fp8 I2V mode (high quality)
        >>> generator = ComfyUIVideoGenerator(workflow_type="fp8")
        >>> result = await generator.generate(
        ...     image_path="frame.png",
        ...     prompt="The character smiles and nods",
        ...     output_path="output.mp4",
        ...     duration=5.0,
        ... )

        >>> # fp8 FLF mode (first/last-frame transition)
        >>> generator = ComfyUIVideoGenerator(workflow_type="fp8")
        >>> result = await generator.generate(
        ...     image_path="frame_start.png",
        ...     prompt="smooth transition",
        ...     output_path="output.mp4",
        ...     last_frame_path="frame_end.png",  # triggers FLF mode
        ... )
    """

    # ComfyUI server configuration
    DEFAULT_ADDRESS = "u864639-76942a5c8e3b.westd.seetacloud.com:8443"
    LTX23_DEFAULT_ADDRESS = "u864639-7730b46a98f9.westd.seetacloud.com:8443"
    DEFAULT_USE_SSL = True  # cloud servers use HTTPS/WSS
    FPS = 24

    # FLF mode fixed frame count (~3.3 seconds)
    FLF_FRAMES = 81

    # LTX 2.3 frame rate (differs from the 24fps of Wan 2.2)
    LTX23_FPS = 25

    # Workflow template paths
    GGUF_WORKFLOW_PATH = Path(__file__).parent / "wan2-2-I2V-GGUF-LightX2V.json"
    FP8_I2V_WORKFLOW_PATH = Path(__file__).parent / "wan2-2-I2V-LightX2V.json"
    FP8_FLF_WORKFLOW_PATH = Path(__file__).parent / "wan2-2-FLF-LightX2V.json"
    LTX23_I2V_WORKFLOW_PATH = Path(__file__).parent / "ltx2-3-I2V.json"

    # Node mapping configuration (node IDs of the different workflows)
    NODE_MAPPING = {
        "gguf": {
            "input_image": "62",
            "frame_count": "63",  # WanImageToVideo.length
            "positive_prompt": "6",
            "negative_prompt": "7",
            "seed": "57",
            "video_output": "61",
        },
        "fp8_i2v": {
            "input_image": "34",
            "frame_count": "20",  # Int node
            "positive_prompt": "29",
            "negative_prompt": "3",
            "seed_high": "94",
            "seed_low": "96",
            "video_output": "19",
        },
        "fp8_flf": {
            "first_image": "119",
            "last_image": "125",
            "positive_prompt": "6",
            "negative_prompt": "7",
            "seed": "57",
            "video_output": "67",
        },
        "ltx23": {
            "input_image": "98",
            "frame_count": "167:146",  # PrimitiveInt.value
            "positive_prompt": "167:164",  # TextGenerateLTX2Prompt.prompt
            "negative_prompt": "167:159",  # CLIPTextEncode.text
            "seed_high": "167:135",  # RandomNoise
            "seed_low": "167:165",  # RandomNoise
            "video_output": "75",  # SaveVideo
        },
    }

    def __init__(
        self,
        server_address: Optional[str] = None,
        timeout: float = 600.0,
        workflow_type: str = "gguf",
        use_ssl: Optional[bool] = None,
    ):
        """Initialize the ComfyUI generator.

        Args:
            server_address: ComfyUI server address (read from the environment by default)
            timeout: request timeout (seconds)
            workflow_type: workflow type ("gguf" or "fp8"), default "gguf"
            use_ssl: whether to use HTTPS/WSS (read from the environment by default)
        """
        # LTX 2.3 uses a separate ComfyUI server (with LTX nodes)
        if server_address:
            self.server_address = server_address
        elif workflow_type.lower() == "ltx23":
            self.server_address = os.environ.get(
                "COMFYUI_LTX23_ADDRESS", self.LTX23_DEFAULT_ADDRESS
            )
        else:
            self.server_address = os.environ.get(
                "COMFYUI_ADDRESS", self.DEFAULT_ADDRESS
            )
        self.timeout = timeout
        self.workflow_type = workflow_type.lower()

        # SSL configuration
        if use_ssl is None:
            use_ssl_env = os.environ.get("COMFYUI_USE_SSL", "").lower()
            self.use_ssl = use_ssl_env in ("true", "1", "yes")
        else:
            self.use_ssl = use_ssl

        # Build the URL
        http_scheme = "https" if self.use_ssl else "http"
        ws_scheme = "wss" if self.use_ssl else "ws"
        self.http_url = f"{http_scheme}://{self.server_address}"
        self.ws_url = f"{ws_scheme}://{self.server_address}"

        # Pick the workflow path by type
        if self.workflow_type == "fp8":
            workflow_path = self.FP8_I2V_WORKFLOW_PATH
        elif self.workflow_type == "ltx23":
            workflow_path = self.LTX23_I2V_WORKFLOW_PATH
        else:
            workflow_path = self.GGUF_WORKFLOW_PATH

        # Load the workflow template
        self._workflow_templates = {}
        for name, path in [
            ("gguf", self.GGUF_WORKFLOW_PATH),
            ("fp8_i2v", self.FP8_I2V_WORKFLOW_PATH),
            ("fp8_flf", self.FP8_FLF_WORKFLOW_PATH),
            ("ltx23", self.LTX23_I2V_WORKFLOW_PATH),
        ]:
            if path.exists():
                with open(path, "r") as f:
                    self._workflow_templates[name] = json.load(f)

        # Compatible with old code
        if self.workflow_type == "ltx23":
            self._workflow_template = self._workflow_templates.get("ltx23")
        else:
            self._workflow_template = self._workflow_templates.get(
                "fp8_i2v" if self.workflow_type == "fp8" else "gguf"
            )

    async def _upload_image(self, image_bytes: bytes, filename: str) -> dict:
        """Upload an image to the ComfyUI input folder."""
        async with aiohttp.ClientSession() as session:
            data = aiohttp.FormData()
            data.add_field(
                "image", image_bytes, filename=filename, content_type="image/png"
            )
            async with session.post(
                f"{self.http_url}/upload/image", data=data
            ) as response:
                if response.status != 200:
                    raise Exception(f"Failed to upload image: {await response.text()}")
                return await response.json()

    async def _queue_prompt(self, workflow: dict, client_id: str) -> dict:
        """Submit a workflow to the ComfyUI queue."""
        p = {"prompt": workflow, "client_id": client_id}
        async with aiohttp.ClientSession() as session:
            async with session.post(f"{self.http_url}/prompt", json=p) as response:
                if response.status != 200:
                    raise Exception(f"Failed to submit workflow: {await response.text()}")
                return await response.json()

    async def _get_history(self, prompt_id: str) -> dict:
        """Get the execution history."""
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{self.http_url}/history/{prompt_id}") as response:
                if response.status != 200:
                    raise Exception(f"Failed to get history: {await response.text()}")
                return await response.json()

    async def _download_video(self, filename: str, subfolder: str = "") -> bytes:
        """Download the video file from ComfyUI."""
        params = {"filename": filename, "subfolder": subfolder, "type": "output"}
        url = f"{self.http_url}/view?{urllib.parse.urlencode(params)}"
        async with aiohttp.ClientSession() as session:
            async with session.get(url) as response:
                if response.status != 200:
                    raise Exception(f"Failed to download video: {await response.text()}")
                return await response.read()

    async def generate(
        self,
        image_path: str,
        prompt: str,
        output_path: str,
        aspect_ratio: str = "9:16",
        duration: float = 5.0,
        on_log: Optional[Callable[[str], None]] = None,
        on_progress: Optional[Callable[[float], None]] = None,
        last_frame_path: Optional[str] = None,
        **kwargs,
    ) -> VideoGenResult:
        """Generate a video.

        Communicates directly with ComfyUI and listens to progress over WebSocket.
        Automatically picks the workflow:
        - With last_frame_path -> FLF mode (fp8_flf)
        - Without last_frame_path -> I2V mode (gguf or fp8_i2v)

        Args:
            image_path: first-frame image path
            prompt: motion description
            output_path: output video path
            aspect_ratio: aspect ratio (unused, kept for compatibility)
            duration: video duration (seconds), default 5.0, max 10.0 (FLF mode is fixed at ~3.3s)
            on_log: log callback function
            on_progress: progress callback function (0.0 ~ 1.0)
            last_frame_path: last-frame image path (optional; enables FLF mode when provided)

        Returns:
            Generation result
        """

        context = _video_egress_context(kwargs.get("egress_context"))
        if context is not None and context.billing_principal.kind in {
            "organization",
            "local",
        }:
            loopback = _is_loopback_server_address(self.server_address)
            allowed_remote = self.server_address in {
                self.DEFAULT_ADDRESS,
                self.LTX23_DEFAULT_ADDRESS,
            }
            if (loopback and context.billing_principal.kind != "local") or (
                not loopback
                and (
                    context.billing_principal.kind != "organization"
                    or not allowed_remote
                    or not self.use_ssl
                )
            ):
                raise VideoEgressError("ORG_SERVICE_EGRESS_DENIED")

        def log(msg: str):
            if on_log:
                on_log(msg)

        def progress(value: float):
            if on_progress:
                on_progress(value)

        # Decide whether to use FLF mode
        use_flf_mode = last_frame_path is not None

        # Pick the workflow
        if use_flf_mode:
            workflow_key = "fp8_flf"
            mode_desc = "FLF (first/last-frame transition)"
        elif self.workflow_type == "ltx23":
            workflow_key = "ltx23"
            mode_desc = "LTX 2.3 I2V"
        elif self.workflow_type == "fp8":
            workflow_key = "fp8_i2v"
            mode_desc = "fp8 I2V"
        else:
            workflow_key = "gguf"
            mode_desc = "GGUF I2V"

        # Check the workflow template
        workflow_template = self._workflow_templates.get(workflow_key)
        if workflow_template is None:
            workflow_path = {
                "gguf": self.GGUF_WORKFLOW_PATH,
                "fp8_i2v": self.FP8_I2V_WORKFLOW_PATH,
                "fp8_flf": self.FP8_FLF_WORKFLOW_PATH,
                "ltx23": self.LTX23_I2V_WORKFLOW_PATH,
            }.get(workflow_key, "unknown")
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=f"Workflow template does not exist: {workflow_path}",
            )

        # Get the node mapping
        node_map = self.NODE_MAPPING.get(workflow_key, {})

        # Check the first-frame image
        if not os.path.exists(image_path):
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=f"First-frame image does not exist: {image_path}",
            )

        # Check the last-frame image (FLF mode)
        if use_flf_mode and not os.path.exists(last_frame_path):
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=f"Last-frame image does not exist: {last_frame_path}",
            )

        client_id = str(uuid.uuid4())
        first_image_filename = f"first_{client_id}.png"
        last_image_filename = f"last_{client_id}.png" if use_flf_mode else None

        # FLF mode fixed frame count
        if use_flf_mode:
            frames = self.FLF_FRAMES
            actual_duration = frames / self.FPS
            log(
                f"Starting video generation | mode: {mode_desc} | fixed frames: {frames} (~{actual_duration:.1f}s)"
            )
        else:
            fps = self.LTX23_FPS if workflow_key == "ltx23" else self.FPS
            frames = int(duration * fps) + 1  # +1 to make sure the duration is sufficient
            log(f"Starting video generation | mode: {mode_desc} | duration: {duration}s")

        try:
            # 1. Read and upload the images
            log("Uploading images to ComfyUI...")
            with open(image_path, "rb") as f:
                first_image_bytes = f.read()
            await self._upload_image(first_image_bytes, first_image_filename)
            log(f"First frame uploaded: {first_image_filename}")

            # FLF mode: upload the last frame
            if use_flf_mode:
                with open(last_frame_path, "rb") as f:
                    last_image_bytes = f.read()
                await self._upload_image(last_image_bytes, last_image_filename)
                log(f"Last frame uploaded: {last_image_filename}")

            # 2. Prepare the workflow
            log("Preparing workflow...")
            workflow = json.loads(json.dumps(workflow_template))

            # Set the input images (by workflow type)
            if workflow_key == "fp8_flf":
                # FLF mode: set the first and last frames
                workflow[node_map["first_image"]]["inputs"][
                    "image"
                ] = first_image_filename
                workflow[node_map["last_image"]]["inputs"][
                    "image"
                ] = last_image_filename
            elif workflow_key == "ltx23":
                # LTX 2.3 I2V mode
                workflow[node_map["input_image"]]["inputs"][
                    "image"
                ] = first_image_filename
                # Set the frame count (PrimitiveInt.value)
                workflow[node_map["frame_count"]]["inputs"]["value"] = frames
                log(f"Frames: {frames} (duration={duration}s, fps={self.LTX23_FPS})")
            elif workflow_key == "fp8_i2v":
                # fp8 I2V mode
                workflow[node_map["input_image"]]["inputs"][
                    "image"
                ] = first_image_filename
                # Set the frame count
                workflow[node_map["frame_count"]]["inputs"]["Number"] = frames
                log(f"Frames: {frames} (duration={duration}s, fps={self.FPS})")
            else:
                # GGUF mode
                workflow[node_map["input_image"]]["inputs"][
                    "image"
                ] = first_image_filename
                # Set the frame count (WanImageToVideo.length)
                workflow[node_map["frame_count"]]["inputs"]["length"] = frames
                log(f"Frames: {frames} (duration={duration}s, fps={self.FPS})")

            # Set the prompt (LTX23 uses the "prompt" field, the rest use "text")
            prompt_field = "prompt" if workflow_key == "ltx23" else "text"
            workflow[node_map["positive_prompt"]]["inputs"][prompt_field] = prompt or ""
            # The negative prompt keeps its default (already set in the template)
            if prompt:
                log(f"Prompt: {prompt[:80]}{'...' if len(prompt) > 80 else ''}")

            # Set the random seed
            seed = random.randint(0, 0xFFFFFFFFFFFF)
            if workflow_key in ("fp8_i2v", "ltx23"):
                # fp8 I2V / LTX 2.3 have two samplers
                workflow[node_map["seed_high"]]["inputs"]["noise_seed"] = seed
                workflow[node_map["seed_low"]]["inputs"]["noise_seed"] = seed
            else:
                workflow[node_map["seed"]]["inputs"]["noise_seed"] = seed
            log(f"Random seed: {seed}")

            # 3. Connect the WebSocket
            log("Connecting WebSocket...")
            ws_connect_url = f"{self.ws_url}/ws?clientId={client_id}"
            ws = await websockets.connect(
                ws_connect_url,
                max_size=500 * 1024 * 1024,
                ping_interval=None,
                ping_timeout=None,
                proxy=None,  # disable proxy detection
            )

            try:
                # 4. Submit the workflow
                log("Submitting workflow to the queue...")
                result = await self._queue_prompt(workflow, client_id)
                prompt_id = result.get("prompt_id")
                if not prompt_id:
                    raise Exception("No prompt_id returned")
                log(f"prompt_id: {prompt_id}")

                # 5. Listen for WebSocket messages
                log("Waiting for ComfyUI to execute...")
                current_node = None
                while True:
                    out = await ws.recv()
                    if isinstance(out, str):
                        message = json.loads(out)
                        msg_type = message.get("type")

                        if msg_type == "executing":
                            data = message.get("data", {})
                            if data.get("prompt_id") == prompt_id:
                                node = data.get("node")
                                if node is None:
                                    log("Inference complete!")
                                    break
                                elif node != current_node:
                                    current_node = node
                                    node_title = (
                                        workflow.get(node, {})
                                        .get("_meta", {})
                                        .get("title", node)
                                    )
                                    log(f"Executing node: {node_title}")

                        elif msg_type == "progress":
                            data = message.get("data", {})
                            value = data.get("value", 0)
                            max_val = data.get("max", 100)
                            pct = value / max_val * 100 if max_val > 0 else 0
                            log(f"Progress: {value}/{max_val} ({pct:.0f}%)")
                            # Update progress (0.0 ~ 1.0)
                            progress(value / max_val if max_val > 0 else 0)

                        elif msg_type == "execution_error":
                            error_data = message.get("data", {})
                            raise Exception(f"Execution error: {error_data}")

            finally:
                await ws.close()

            # 6. Get the output file name
            log("Getting output files...")
            await asyncio.sleep(0.5)

            # Get the output node ID
            output_node_id = node_map.get("video_output", "61")

            for retry in range(3):
                history = await self._get_history(prompt_id)
                if prompt_id in history:
                    outputs = history[prompt_id].get("outputs", {})
                    # The output of VHS_VideoCombine is in the "gifs" field
                    video_output = outputs.get(output_node_id, {}).get("gifs", [])
                    # The output of SaveVideo is in the "images" field
                    if not video_output:
                        video_output = outputs.get(output_node_id, {}).get("images", [])
                    if video_output:
                        break
                log(f"Retry {retry + 1}/3: waiting for history...")
                await asyncio.sleep(1)
            else:
                raise Exception(f"No video output found (node {output_node_id})")

            video_info = video_output[0]
            video_filename = video_info.get("filename")
            video_subfolder = video_info.get("subfolder", "")
            log(
                f"Output file: {video_subfolder}/{video_filename}"
                if video_subfolder
                else f"Output file: {video_filename}"
            )

            if not video_filename:
                raise Exception("No video filename found")

            # 7. Download the video
            log("Downloading video...")
            video_bytes = await self._download_video(video_filename, video_subfolder)

            # 8. Save locally
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            with open(output_path, "wb") as f:
                f.write(video_bytes)

            log(f"Video saved: {output_path} ({len(video_bytes) / 1024 / 1024:.2f} MB)")

            return VideoGenResult(
                status=VideoGenStatus.DONE,
                video_path=output_path,
                duration_seconds=duration,
            )

        except Exception as e:
            log(f"Error: {e}")
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=str(e),
            )


NEWAPI_VIDEO_BACKEND_PREFIX = "newapi_"
NEWAPI_VIDEO_DISPLAY_LABELS = {
    "seedance-1.0-pro-fast": "Seedance1.0 Pro Fast",
    "seedance-1.5-pro": "Seedance1.5 Pro",
    "seedance-2.0": "Seedance2.0",
    "seedance-2.0-fast": "Seedance2.0 Fast",
    "seedance-2.0-value": "Seedance2.0 Value",
    "seedance-2.0-fast-value": "Seedance2.0 Fast Value",
    "seedance-2.0-mini": "Seedance2.0 Mini",
    "happyhorse-1.0": "HappyHorse 1.0",
    "grok-video-channel": "Grok Video Channel",
}
NEWAPI_MAINLINE_SEEDANCE2_MODELS = (
    "seedance-2.0",
    "seedance-2.0-fast",
    "seedance-2.0-mini",
)
NEWAPI_DISABLED_VIDEO_MODELS = {"grok-video-channel"}


def parse_newapi_video_backend(backend: str | None) -> str | None:
    value = str(backend or "").strip()
    lowered = value.lower()
    if lowered == "newapi":
        from novelvideo.config import NEWAPI_VIDEO_MODEL

        return NEWAPI_VIDEO_MODEL
    if lowered.startswith(NEWAPI_VIDEO_BACKEND_PREFIX):
        model = value[len(NEWAPI_VIDEO_BACKEND_PREFIX) :].strip()
        return model or None
    return None


def newapi_video_backend_options(
    *, include_seedance2_variants: bool = False
) -> dict[str, str]:
    from novelvideo.config import NEWAPI_VIDEO_MODELS
    from novelvideo.shared.runtime_env import is_ce_effective

    models = [
        model
        for model in NEWAPI_VIDEO_MODELS
        if model not in NEWAPI_DISABLED_VIDEO_MODELS
    ]
    if is_ce_effective():
        try:
            from novelvideo.model_gateway_settings import (
                get_newapi_media_model_mappings,
            )

            for model, mapping in get_newapi_media_model_mappings().items():
                media_type = str(mapping.get("mediaType") or "video").strip().lower()
                if (
                    mapping.get("provider") == "comfyui"
                    and mapping.get("enabled") is not False
                    and media_type == "video"
                    and model not in models
                ):
                    models.append(model)
        except (RuntimeError, ImportError):
            pass
    if include_seedance2_variants:
        for model in NEWAPI_MAINLINE_SEEDANCE2_MODELS:
            if model not in models:
                models.append(model)
    return {
        f"{NEWAPI_VIDEO_BACKEND_PREFIX}{model}": NEWAPI_VIDEO_DISPLAY_LABELS.get(
            model, model
        )
        for model in models
    }


def _coerce_video_backend_value(backend: VideoBackend | str | None) -> str:
    if backend is None:
        backend = os.environ.get("VIDEO_BACKEND", "comfyui")
    if isinstance(backend, VideoBackend):
        return backend.value
    value = str(backend).strip()
    lowered = value.lower()
    if lowered.startswith(NEWAPI_VIDEO_BACKEND_PREFIX):
        return (
            f"{NEWAPI_VIDEO_BACKEND_PREFIX}{value[len(NEWAPI_VIDEO_BACKEND_PREFIX) :]}"
        )
    return "comfyui" if lowered == "jimeng" else lowered


def _server_address_host(server_address: object) -> str:
    text = str(server_address or "").strip()
    parsed = urllib.parse.urlsplit(text if "://" in text else f"//{text}")
    return str(parsed.hostname or "").strip().lower()


def _is_loopback_server_address(server_address: object) -> bool:
    host = _server_address_host(server_address)
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _trusted_comfy_kwargs(context, workflow_type: str | None, kwargs: dict[str, Any]):
    protected = {"api_key", "authorization", "token", "credential", "headers"}
    if any(kwargs.get(name) for name in protected):
        raise VideoEgressError("ORG_SERVICE_EGRESS_DENIED")

    resolved_workflow = str(workflow_type or "gguf").strip().lower()
    server_address = kwargs.get("server_address")
    if not server_address:
        if context.billing_principal.kind != "organization":
            raise VideoEgressError("ORG_SERVICE_EGRESS_DENIED")
        server_address = (
            ComfyUIVideoGenerator.LTX23_DEFAULT_ADDRESS
            if resolved_workflow == "ltx23"
            else ComfyUIVideoGenerator.DEFAULT_ADDRESS
        )
        kwargs["server_address"] = server_address
        kwargs["use_ssl"] = True

    if _is_loopback_server_address(server_address):
        if context.billing_principal.kind != "local":
            raise VideoEgressError("ORG_SERVICE_EGRESS_DENIED")
        kwargs.setdefault("use_ssl", False)
        return resolved_workflow, kwargs

    allowed = {
        ComfyUIVideoGenerator.DEFAULT_ADDRESS,
        ComfyUIVideoGenerator.LTX23_DEFAULT_ADDRESS,
    }
    if (
        context.billing_principal.kind != "organization"
        or str(server_address).strip() not in allowed
        or kwargs.get("use_ssl") is not True
    ):
        raise VideoEgressError("ORG_SERVICE_EGRESS_DENIED")
    return resolved_workflow, kwargs


def create_video_generator(
    backend: Optional[VideoBackend | str] = None,
    use_mock: bool = False,
    workflow_type: Optional[str] = None,
    **kwargs,
) -> VideoGeneratorBase:
    """Create a video generator.

    Args:
        backend: video backend choice
            - newapi_<model>: newAPI video model, e.g. newapi_seedance-1.0-pro-fast
            - huimeng_<model>: HuiMeng video model, e.g. huimeng_seedance-2.0-fast
            - SEEDANCE_FAST: Seedance 1.0 Pro Fast (Volcengine Ark)
            - SEEDANCE_PRO: Seedance 1.5 Pro with audio (Volcengine Ark)
            - SEEDANCE_PRO_SILENT: Seedance 1.5 Pro silent (Volcengine Ark)
            - COMFYUI: Claymore 1.0 local service
            - GROK_720: xAI Grok Imagine Video 720p
        use_mock: compatible with the old interface; when True use MockVideoGenerator
        workflow_type: ComfyUI workflow type ("gguf" or "fp8"); read from the environment by default
        **kwargs: arguments passed to the concrete generator

    Returns:
        Video generator instance

    Environment variables:
        VIDEO_BACKEND: default backend
            (newapi_seedance-1.0-pro-fast/huimeng_seedance-2.0-fast/comfyui/...)
        HUIMENGI_API_KEY: HuiMeng API key
        COMFYUI_WORKFLOW: ComfyUI workflow type (gguf/fp8)
        VOLCENGINE_VISUAL_API_KEY: Seedance API key
        COMFYUI_ADDRESS: ComfyUI server address
        XAI_API_KEY: Grok video generation API key
    """
    from novelvideo.config import SEEDANCE_FAST_MODEL, SEEDANCE_PRO_MODEL

    egress_context = _video_egress_context(kwargs.get("egress_context"))

    # Compatible with the old interface
    if use_mock:
        return MockVideoGenerator(**kwargs)

    backend_str = _coerce_video_backend_value(backend)
    newapi_model = parse_newapi_video_backend(backend_str)
    if newapi_model:
        return NewApiVideoGenerator(model=newapi_model, **kwargs)

    from novelvideo.generators.huimengi import parse_huimeng_video_backend

    huimeng_model = parse_huimeng_video_backend(backend_str)
    if huimeng_model:
        if _direct_video_context_denied(egress_context):
            raise VideoEgressError("ORG_EGRESS_DENIED")
        kwargs.pop("egress_context", None)
        return HuimengVideoGenerator(model=huimeng_model, **kwargs)

    if backend_str == "runpod_minimax_h3":
        # Dev-only: the user's own RunPod serverless endpoint, not an
        # org-billed path, so it is exempt from the org-egress checks the
        # other direct-API backends above go through.
        from novelvideo.generators.runpod_minimax_h3_video import (
            RunPodMiniMaxH3VideoGenerator,
        )

        kwargs.pop("egress_context", None)
        return RunPodMiniMaxH3VideoGenerator(**kwargs)

    try:
        backend_enum = VideoBackend(backend_str)
    except ValueError:
        if backend is None:
            backend_enum = VideoBackend.COMFYUI
        else:
            raise ValueError(f"Unknown video backend: {backend_str}") from None

    # Create the matching generator
    if backend_enum == VideoBackend.SEEDANCE_FAST:
        if _direct_video_context_denied(egress_context):
            raise VideoEgressError("ORG_EGRESS_DENIED")
        kwargs.pop("egress_context", None)
        return SeedanceVideoGenerator(
            model=SEEDANCE_FAST_MODEL, generate_audio=False, **kwargs
        )
    elif backend_enum == VideoBackend.SEEDANCE_PRO:
        if _direct_video_context_denied(egress_context):
            raise VideoEgressError("ORG_EGRESS_DENIED")
        kwargs.pop("egress_context", None)
        return SeedanceVideoGenerator(
            model=SEEDANCE_PRO_MODEL, generate_audio=True, **kwargs
        )
    elif backend_enum == VideoBackend.SEEDANCE_PRO_SILENT:
        if _direct_video_context_denied(egress_context):
            raise VideoEgressError("ORG_EGRESS_DENIED")
        kwargs.pop("egress_context", None)
        return SeedanceVideoGenerator(
            model=SEEDANCE_PRO_MODEL, generate_audio=False, **kwargs
        )
    elif backend_enum == VideoBackend.COMFYUI:
        if egress_context is not None and egress_context.billing_principal.kind in {
            "organization",
            "local",
        }:
            kwargs.pop("egress_context", None)
            workflow_type, kwargs = _trusted_comfy_kwargs(
                egress_context, workflow_type, kwargs
            )
            return ComfyUIVideoGenerator(workflow_type=workflow_type, **kwargs)
        kwargs.pop("egress_context", None)
        # Read the workflow type from the environment
        if workflow_type is None:
            workflow_type = os.environ.get("COMFYUI_WORKFLOW", "gguf")
        return ComfyUIVideoGenerator(workflow_type=workflow_type, **kwargs)
    elif backend_enum == VideoBackend.SEEDANCE_2:
        if _direct_video_context_denied(egress_context):
            raise VideoEgressError("ORG_EGRESS_DENIED")
        kwargs.pop("egress_context", None)
        return Seedance2VideoGenerator(**kwargs)
    elif backend_enum == VideoBackend.LTX23:
        if egress_context is not None and egress_context.billing_principal.kind in {
            "organization",
            "local",
        }:
            kwargs.pop("egress_context", None)
            trusted_workflow, kwargs = _trusted_comfy_kwargs(
                egress_context, "ltx23", kwargs
            )
            return ComfyUIVideoGenerator(workflow_type=trusted_workflow, **kwargs)
        kwargs.pop("egress_context", None)
        return ComfyUIVideoGenerator(workflow_type="ltx23", **kwargs)
    elif backend_enum == VideoBackend.GROK_720:
        if _direct_video_context_denied(egress_context):
            raise VideoEgressError("ORG_EGRESS_DENIED")
        kwargs.pop("egress_context", None)
        return GrokVideoGenerator(**kwargs)
    else:
        raise ValueError(f"Unknown video backend: {backend_str}")
