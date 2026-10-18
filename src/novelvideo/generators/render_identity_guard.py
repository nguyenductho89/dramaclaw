"""Render preflight checks for sketch AI identity detection."""

from collections.abc import Iterable
from typing import Any

from novelvideo.models import NO_CHARACTER_MARKER, real_detected_identities


def _beat_get(beat: Any, key: str, default: Any = None) -> Any:
    if isinstance(beat, dict):
        return beat.get(key, default)
    return getattr(beat, key, default)


def _has_identity_detection_state(beat: Any) -> bool:
    identities = _beat_get(beat, "detected_identities", None)
    if isinstance(identities, str):
        identities = [identities]
    try:
        values = [str(item or "").strip() for item in (identities or [])]
    except TypeError:
        return False
    return NO_CHARACTER_MARKER in values or bool(real_detected_identities(values))


class RenderIdentityDetectionRequired(RuntimeError):
    """A render beat has no identity detection state; the user must mark it first."""

    error_code = "RENDER_IDENTITY_DETECTION_REQUIRED"


def render_ai_detection_error(
    beats: Iterable[Any] | None = None,
    *,
    standalone_beat_context: bool = False,
) -> str | None:
    """Return an error when any render beat has no explicit identity detection state."""
    beat_list = list(beats or [])
    missing = [beat for beat in beat_list if not _has_identity_detection_state(beat)]
    if not missing:
        return None
    if standalone_beat_context:
        # Standalone canvas shots have no episode beat to run sketch detection on; the beat number is always 0, so the fix has to happen on the node.
        return (
            "Before rendering the storyboard, select the appearing characters under \"Appearing identities\" on the \"Shot context\" node. "
            "If no character appears, select \"No characters appear\"."
        )
    beat_numbers = ", ".join(f"#{_beat_get(beat, 'beat_number', '?')}" for beat in missing)
    return (
        "Before Render, go to \"Sketch\" and click \"AI detect\" to identify the appearing identities, "
        "or annotate them manually under \"More > Appearing identities\". "
        f"These beats are not yet detected/annotated: {beat_numbers}. "
        "If no character appears, select \"No characters appear\"."
    )
