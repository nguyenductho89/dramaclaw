"""Provider-facing business error normalization."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from typing import Any

from novelvideo.utils.error_redaction import redact_secrets

CONTENT_MODERATION_FAILED_CODE = "CONTENT_MODERATION_FAILED"
# Stable snake_case code the frontend branches on (alongside the legacy error_code).
CONTENT_MODERATION_BLOCKED_CODE = "content_moderation_blocked"
CONTENT_MODERATION_FAILED_MESSAGE = "The generated image did not pass content moderation. Adjust the prompt and try again."
INPUT_IMAGE_POLICY_FAILED_MESSAGE = "The reference image did not pass copyright or content safety review. Replace the reference image and try again."
OUTPUT_VIDEO_POLICY_FAILED_MESSAGE = (
    "The generated video did not pass copyright or content safety review. Adjust the prompt or reference assets and try again."
)
COPYRIGHT_POLICY_FAILED_MESSAGE = (
    "The generated content may involve copyright restrictions and did not pass platform review. Adjust the prompt or replace the reference assets and try again."
)
OUTPUT_AUDIO_POLICY_FAILED_MESSAGE = (
    "The generated audio may contain sensitive content and did not pass platform review. Replace the audio or adjust the description and try again."
)

# Enum codes that DramaClawAPI (the video gateway) gives in task-failure payloads. The egress path of organization accounts wipes the vendor
# original text entirely (it may carry signed relay URLs), but these enum codes themselves contain no secrets and must be let through,
# otherwise users only see `EGRESS_OPERATION_UNKNOWN` -- on 2026-08-26 a 338x191 reference image on 3060
# was rejected 8 times in a row by Volcano's HeightTooSmall, and that is how users were left in the dark.
VIDEO_MEDIA_DIMENSIONS_INVALID_CODE = "VIDEO_MEDIA_DIMENSIONS_INVALID"
VIDEO_MEDIA_DIMENSIONS_INVALID_MESSAGE = (
    "Reference asset dimensions are invalid: image width and height must be between 300 and 6000 pixels. "
    "Replace the reference image and try again."
)
VIDEO_CONTENT_COPYRIGHT_RESTRICTED_CODE = "VIDEO_CONTENT_COPYRIGHT_RESTRICTED"
VIDEO_OUTPUT_AUDIO_SENSITIVE_CODE = "VIDEO_OUTPUT_AUDIO_SENSITIVE"

# Only accept VIDEO_* codes in "all-caps enum" form; anything with spaces / lowercase / punctuation is rejected as free text.
_PROVIDER_VIDEO_ERROR_CODE_RE = re.compile(r"VIDEO_[A-Z0-9]+(?:_[A-Z0-9]+)*")
# `"code": "VIDEO_*"` in the gateway HTTP error body (JSON) or a Python repr.
_PROVIDER_VIDEO_ERROR_BODY_CODE_RE = re.compile(
    r"[\"']code[\"']\s*:\s*[\"'](VIDEO_[A-Z0-9_]+)[\"']"
)
_PROVIDER_URL_RE = re.compile(r"https?://[^\s<>{}\[\]\"']+", re.IGNORECASE)
_PROVIDER_SENSITIVE_FRAGMENT_RE = re.compile(
    r"(?i)\b(?:ossaccesskeyid|x-amz-(?:credential|signature)|api[_-]?key|"
    r"access[_-]?key|token|secret)(?:\s*[:=]\s*|[-_/])[^\s,;]+"
)
_PROVIDER_ERROR_MESSAGE_MAX_LENGTH = 1000
# When the gateway only gives free text (`error_message`), classify by keywords in the vendor's original wording.
_PROVIDER_VIDEO_ERROR_TEXT_MARKERS: tuple[tuple[str, str], ...] = (
    ("heighttoosmall", VIDEO_MEDIA_DIMENSIONS_INVALID_CODE),
    ("widthtoosmall", VIDEO_MEDIA_DIMENSIONS_INVALID_CODE),
    ("heighttoolarge", VIDEO_MEDIA_DIMENSIONS_INVALID_CODE),
    ("widthtoolarge", VIDEO_MEDIA_DIMENSIONS_INVALID_CODE),
    ("must be between 300px and 6000px", VIDEO_MEDIA_DIMENSIONS_INVALID_CODE),
    ("copyright restrictions", VIDEO_CONTENT_COPYRIGHT_RESTRICTED_CODE),
    ("output audio may contain sensitive", VIDEO_OUTPUT_AUDIO_SENSITIVE_CODE),
)
# Known code -> (error_code, message) shown to the user. Copyright/sensitive reuse the CONTENT_MODERATION_FAILED
# that the frontend already recognizes; the dimension problem gets its own code so the frontend can offer targeted guidance later.
_PROVIDER_VIDEO_ERROR_PRESENTATION: dict[str, tuple[str, str]] = {
    VIDEO_MEDIA_DIMENSIONS_INVALID_CODE: (
        VIDEO_MEDIA_DIMENSIONS_INVALID_CODE,
        VIDEO_MEDIA_DIMENSIONS_INVALID_MESSAGE,
    ),
    VIDEO_CONTENT_COPYRIGHT_RESTRICTED_CODE: (
        CONTENT_MODERATION_FAILED_CODE,
        COPYRIGHT_POLICY_FAILED_MESSAGE,
    ),
    VIDEO_OUTPUT_AUDIO_SENSITIVE_CODE: (
        CONTENT_MODERATION_FAILED_CODE,
        OUTPUT_AUDIO_POLICY_FAILED_MESSAGE,
    ),
}
_KNOWN_PROVIDER_VIDEO_ERROR_RE = re.compile(
    r"\b(" + "|".join(re.escape(code) for code in _PROVIDER_VIDEO_ERROR_PRESENTATION) + r")\b"
)

_CONTENT_MODERATION_MARKERS = (
    "output_moderation",
    "inputimagesensitivecontentdetected.policyviolation",
    "outputvideosensitivecontentdetected.policyviolation",
    "copyright restrictions",
)


def is_content_moderation_error(
    exc: BaseException | None = None,
    message: str = "",
) -> bool:
    text = " ".join(part for part in (str(exc) if exc else "", message) if part).lower()
    return any(marker in text for marker in _CONTENT_MODERATION_MARKERS)


def content_moderation_message(exc: BaseException | None = None, message: str = "") -> str:
    text = " ".join(part for part in (str(exc) if exc else "", message) if part).lower()
    if "inputimagesensitivecontentdetected.policyviolation" in text:
        return INPUT_IMAGE_POLICY_FAILED_MESSAGE
    if "outputvideosensitivecontentdetected.policyviolation" in text:
        return OUTPUT_VIDEO_POLICY_FAILED_MESSAGE
    if "copyright restrictions" in text:
        return COPYRIGHT_POLICY_FAILED_MESSAGE
    return CONTENT_MODERATION_FAILED_MESSAGE


def content_moderation_payload(exc: BaseException | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "error_code": CONTENT_MODERATION_FAILED_CODE,
        "code": CONTENT_MODERATION_BLOCKED_CODE,
        "message": content_moderation_message(exc),
    }
    if exc is not None:
        payload["provider_error"] = str(exc)[:2000]
    return payload


def safe_provider_video_error_code(code: object) -> str:
    """Return the gateway's `code` field as-is only if it is a pure-enum VIDEO_* code, otherwise an empty string."""
    text = str(code or "").strip()
    if len(text) > 64 or not _PROVIDER_VIDEO_ERROR_CODE_RE.fullmatch(text):
        return ""
    return text


def provider_video_error_code_from_text(text: str) -> str:
    """Extract a safe VIDEO_* code from vendor/gateway free text; return an empty string if unrecognized, and never return the original text."""
    if not text:
        return ""
    match = _PROVIDER_VIDEO_ERROR_BODY_CODE_RE.search(text)
    if match:
        code = safe_provider_video_error_code(match.group(1))
        if code:
            return code
    lowered = text.lower()
    for marker, code in _PROVIDER_VIDEO_ERROR_TEXT_MARKERS:
        if marker in lowered:
            return code
    return ""


def _provider_video_message_from_value(value: object) -> str:
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return ""
        if text[:1] in {"{", "["}:
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                pass
            else:
                nested = _provider_video_message_from_value(parsed)
                if nested:
                    return nested
        return text
    if isinstance(value, Mapping):
        for key in (
            "content",
            "error",
            "message",
            "error_message",
            "fail_reason",
            "detail",
        ):
            nested = _provider_video_message_from_value(value.get(key))
            if nested:
                return nested
        return ""
    if isinstance(value, (list, tuple)):
        for item in value:
            nested = _provider_video_message_from_value(item)
            if nested:
                return nested
    return ""


def _sanitize_provider_video_error_message(value: object) -> str:
    message = _provider_video_message_from_value(value)
    if not message:
        return ""
    message = _PROVIDER_URL_RE.sub("[redacted-url]", message)
    message = redact_secrets(message)
    message = _PROVIDER_SENSITIVE_FRAGMENT_RE.sub("[redacted]", message)
    message = re.sub(r"\s+", " ", message).strip()
    visible = message.replace("[redacted-url]", "").replace("[redacted]", "")
    if not visible.strip(" -:,.;"):
        return ""
    return message[:_PROVIDER_ERROR_MESSAGE_MAX_LENGTH]


def provider_video_task_error_message(task: Mapping[str, Any]) -> str:
    """Return a redacted provider message from a definitive failed-task response."""
    for value in (
        task.get("content"),
        task.get("error"),
        task.get("fail_reason"),
        task.get("error_message"),
    ):
        message = _sanitize_provider_video_error_message(value)
        if message:
            return message
    return ""


def provider_video_error_message_from_text(text: str) -> str:
    """Extract a redacted message from an embedded JSON provider error body."""
    decoder = json.JSONDecoder()
    for index, char in enumerate(text):
        if char not in "{[":
            continue
        try:
            payload, _end = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        message = _sanitize_provider_video_error_message(payload)
        if message:
            return message
    return ""


def classify_provider_video_task_error(task: Mapping[str, Any]) -> str:
    """Classify a gateway "task failed" payload into a safe VIDEO_* code; return an empty string if unrecognized.

    The payload has two shapes: `error: {code, message}`, or only an `error_message` free text
    (which may carry signed relay URLs). Only enum codes are returned; the text is only used to recognize keywords.
    """
    error = task.get("error")
    if isinstance(error, Mapping):
        code = safe_provider_video_error_code(error.get("code"))
        if code:
            return code
        message = error.get("message")
    else:
        message = error
    text = " ".join(
        str(part)
        for part in (message, task.get("fail_reason"), task.get("error_message"))
        if part
    )
    return provider_video_error_code_from_text(text)


def provider_video_error_payload(exc: BaseException) -> dict[str, Any] | None:
    """When the exception text carries a known VIDEO_* code, return a structured user-readable failure; otherwise None."""
    match = _KNOWN_PROVIDER_VIDEO_ERROR_RE.search(str(exc))
    if not match:
        return None
    error_code, message = _PROVIDER_VIDEO_ERROR_PRESENTATION[match.group(1)]
    return {
        "error_code": error_code,
        "code": (
            CONTENT_MODERATION_BLOCKED_CODE
            if error_code == CONTENT_MODERATION_FAILED_CODE
            else error_code
        ),
        "message": message,
        "provider_error": str(exc)[:2000],
    }


__all__ = [
    "CONTENT_MODERATION_BLOCKED_CODE",
    "CONTENT_MODERATION_FAILED_CODE",
    "CONTENT_MODERATION_FAILED_MESSAGE",
    "COPYRIGHT_POLICY_FAILED_MESSAGE",
    "INPUT_IMAGE_POLICY_FAILED_MESSAGE",
    "OUTPUT_AUDIO_POLICY_FAILED_MESSAGE",
    "OUTPUT_VIDEO_POLICY_FAILED_MESSAGE",
    "VIDEO_CONTENT_COPYRIGHT_RESTRICTED_CODE",
    "VIDEO_MEDIA_DIMENSIONS_INVALID_CODE",
    "VIDEO_MEDIA_DIMENSIONS_INVALID_MESSAGE",
    "VIDEO_OUTPUT_AUDIO_SENSITIVE_CODE",
    "classify_provider_video_task_error",
    "content_moderation_message",
    "content_moderation_payload",
    "is_content_moderation_error",
    "provider_video_error_code_from_text",
    "provider_video_error_message_from_text",
    "provider_video_error_payload",
    "provider_video_task_error_message",
    "safe_provider_video_error_code",
]
