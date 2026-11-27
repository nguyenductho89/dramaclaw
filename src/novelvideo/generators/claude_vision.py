"""Claude Haiku reads a storyboard frame for the H3 prompt composer.

The H3 composer is a text model, so it cannot see ``<Picture 1>`` and used to invent
camera position and direction of travel. This module asks Claude Haiku to describe only
what the frame shows; the composer receives that as ground truth.
"""

from __future__ import annotations

import base64
import logging
from pathlib import Path

import anthropic

from novelvideo import config
from novelvideo.shared.runtime_env import uses_local_ce_runtime
from novelvideo.utils.reference_image import encode_reference_image_file

logger = logging.getLogger(__name__)

FRAME_LAYOUT_PROMPT = """You are looking at ONE storyboard frame that will anchor a video shot. \
Report only what is visible, in English, in at most 90 words, with no speculation and no story interpretation:
- camera: position and height relative to the subject (below / level / above) and the viewing angle;
- subject: where it sits in the frame (left / center / right, near / far) and which way it faces;
- movement: using the action text, say whether the subject moves toward or away from the camera and toward screen-left or screen-right, judged from the pose and the scene geometry; write "no movement" when the action is static;
- framing: close-up / medium / wide / full body;
- setting geometry: where stairs, tracks, walls and openings run relative to the camera.
Action text: {action}"""


class ClaudeVisionError(RuntimeError):
    """The vision call failed; ``status`` is the HTTP status when there is one."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def claude_vision_enabled() -> bool:
    """Configured, and running as the single-tenant CE (EE keeps its egress policy)."""
    return bool(config.CLAUDE_API_KEY) and uses_local_ce_runtime()


async def describe_frame_layout(
    image_path: str | Path,
    *,
    action_text: str,
    client: anthropic.AsyncAnthropic | None = None,
    timeout_s: float = 60.0,
) -> str:
    """Return Haiku's description of one frame; raise ``ClaudeVisionError`` on failure."""

    if not claude_vision_enabled():
        raise ClaudeVisionError("CLAUDE_API_KEY is not configured")
    image = base64.standard_b64encode(encode_reference_image_file(image_path)).decode("ascii")
    owns_client = client is None
    api = client or anthropic.AsyncAnthropic(api_key=config.CLAUDE_API_KEY, timeout=timeout_s)
    try:
        response = await api.messages.create(
            model=config.CLAUDE_VISION_MODEL,
            max_tokens=2000,
            output_config={"effort": "low"},
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {"type": "base64", "media_type": "image/jpeg", "data": image},
                        },
                        {
                            "type": "text",
                            "text": FRAME_LAYOUT_PROMPT.format(action=action_text.strip() or "none"),
                        },
                    ],
                }
            ],
        )
    except anthropic.APIStatusError as exc:
        raise ClaudeVisionError(f"Claude vision HTTP {exc.status_code}", exc.status_code) from exc
    except anthropic.APIConnectionError as exc:
        raise ClaudeVisionError(f"Claude vision request failed: {type(exc).__name__}") from exc
    finally:
        if owns_client:
            await api.close()

    if response.stop_reason == "refusal":
        raise ClaudeVisionError("Claude vision declined the request")
    text = "".join(block.text for block in response.content if block.type == "text").strip()
    if not text:
        raise ClaudeVisionError("Claude vision returned no text")
    return text


async def describe_frame_layout_or_empty(image_path: str | Path, *, action_text: str) -> str:
    """Best effort for callers that can do without it: any failure yields an empty string."""

    if not claude_vision_enabled():
        return ""
    try:
        return await describe_frame_layout(image_path, action_text=action_text)
    except Exception as exc:  # noqa: BLE001 - the composer must still run without vision
        logger.warning("Claude frame layout skipped: %s", exc)
        return ""
