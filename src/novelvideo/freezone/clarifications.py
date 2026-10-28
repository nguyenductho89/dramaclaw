"""Server-owned Freezone clarification payloads shared by API and MCP adapters."""

from __future__ import annotations

from typing import Any


def video_model_constraint_adjustment_clarification(
    preflight: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return the fixed user decision used when no video model fits all constraints."""
    result = {
        "ok": True,
        "status": "video_model_clarification_required",
        "code": "no_compatible_video_model",
        "draft_created": False,
        "retryable": False,
        "required_choice": "video_model_constraint_adjustment",
        "next_action": "request_user_clarification",
        "question": {
            "id": "video_model_constraint_adjustment",
            "title": "Choose next step",
            "prompt": (
                "No video model currently satisfies all reference modes, "
                "shot durations and generation parameters at once. "
                "Please choose whether to adjust one kind of constraint."
            ),
            "mode": "single",
            "options": [
                {
                    "id": "keep_requirements",
                    "label": "Keep current requirements and stop",
                    "description": "Leave the current Plan unchanged and do not continue creating a Draft.",
                },
                {
                    "id": "adjust_reference_mode",
                    "label": "Adjust reference mode",
                    "description": "Only confirms the direction of the adjustment; reference edges and media anchors are not modified until a concrete new value is provided.",
                },
                {
                    "id": "adjust_shot_duration",
                    "label": "Adjust shot duration",
                    "description": "Only confirms the direction of the adjustment; the Plan is not modified until a concrete new duration is provided.",
                },
                {
                    "id": "specify_video_model",
                    "label": "Specify a different model",
                    "description": "The user provides a specific model, then preflight is re-run with the original constraints.",
                },
            ],
        },
    }
    if preflight is not None:
        result["preflight"] = preflight
    return result
