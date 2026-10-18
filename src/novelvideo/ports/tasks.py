"""Task backend and cancellation ports."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True)
class QueuedTask:
    task_state: Any
    backend: str
    queue: str | None = None
    celery_id: str | None = None


def _selected_beat_numbers(payload: dict[str, Any]) -> list[int]:
    """Extract the selected beat numbers from the enqueue payload, de-duplicated and order-preserving.

    Selected-Beats regeneration (``sketch_regen`` / ``selected_regen``) puts the beat list in
    ``payload["config"]["selected_beat_numbers"]``; some callers put it at the top level, and both places are honored.
    """
    for container in (payload, payload.get("config")):
        if not isinstance(container, dict):
            continue
        raw = container.get("selected_beat_numbers")
        if not isinstance(raw, (list, tuple)):
            continue
        seen: set[int] = set()
        beats: list[int] = []
        for value in raw:
            try:
                beat = int(value)
            except (TypeError, ValueError):
                continue
            if beat in seen:
                continue
            seen.add(beat)
            beats.append(beat)
        if beats:
            return beats
    return []


def display_metadata_for_task(task_type: str, payload: dict[str, Any] | None) -> dict[str, Any]:
    if not payload:
        return {}
    metadata: dict[str, Any] = {}

    for key in (
        "display_name",
        "task_label",
        "task_family",
        "source_label",
        "target_label",
        "canvas_id",
        "node_id",
        "skill_id",
        "batch_id",
        "batch_size",
    ):
        value = str(payload.get(key) or "").strip()
        if value:
            metadata[key] = value

    # Boolean flags must not go through the string loop above: str(False) == "False" is truthy,
    # and after strip it would be stored in metadata as the string "False"; _serialize_task would then
    # call bool() on it and get True -- a user-defined name would be judged localizable, exactly backwards.
    if payload.get("display_name_user_content") is True:
        metadata["display_name_user_content"] = True

    if task_type == "stage_asset":
        for key in ("scene_name", "step"):
            value = str(payload.get(key) or "").strip()
            if value:
                metadata[key] = value

    # The task row of a selected-Beats regeneration has beat_num None, and its scope is a sha1 of mode_key + beats,
    # which the frontend cannot reverse. Without keeping this list, every beat's sketch / render panel would
    # claim the same task, and one running beat would make the whole episode spin.
    beat_numbers = _selected_beat_numbers(payload)
    if beat_numbers:
        metadata["beat_numbers"] = beat_numbers
    return metadata


def cancel_key(
    *,
    project_id: str,
    task_type: str,
    episode: int,
    task_id: str,
    beat_num: int | None = None,
    scope: str | None = None,
) -> str:
    parts = ["task", "cancel", project_id, task_type, str(episode)]
    if beat_num is not None:
        parts.append(str(beat_num))
    if scope:
        parts.append(str(scope))
    parts.append(str(task_id))
    return ":".join(parts)


class TaskBackend(Protocol):
    async def enqueue_project_task(
        self,
        ctx,
        *,
        task_type: str,
        product_surface: str,
        queue_kind: str = "default",
        episode: int = 0,
        beat_num: int | None = None,
        scope: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> QueuedTask: ...

    async def cancel_project_task(
        self,
        ctx,
        task_state,
        *,
        force: bool = False,
        acknowledge_no_refund: bool = False,
    ) -> dict[str, Any]: ...


class CancellationStore(Protocol):
    async def request_cancel(
        self,
        *,
        project_id: str,
        task_type: str,
        episode: int,
        task_id: str,
        beat_num: int | None = None,
        scope: str | None = None,
        ttl_seconds: int = 86_400,
    ) -> None: ...

    async def is_cancel_requested(
        self,
        *,
        project_id: str,
        task_type: str,
        episode: int,
        task_id: str,
        beat_num: int | None = None,
        scope: str | None = None,
    ) -> bool: ...
