"""Source text, rewritten script, and narration adapter endpoints."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from novelvideo.api.auth import get_api_user, require_project_scope
from novelvideo.api.deps import get_sqlite_store, resolve_project_scope
from novelvideo.api.schemas import ContentUpdateRequest, RewriteGenerateRequest
from novelvideo.ports import get_usage_meter
from novelvideo.sqlite_store import SQLiteStore

logger = logging.getLogger("novelvideo.api.content")

router = APIRouter()

CONTENT_REWRITE_FEATURE_KEY = "mainline.content_rewrite"
CONTENT_REWRITE_TASK_TYPE = "content_rewrite"
MODEL_CALL_CREDIT_POLICY_FEATURE_INCLUDED = "feature_included"


def _requester_user_id_for_billing(resolved: Any, user: dict) -> str:
    ctx = getattr(resolved, "ctx", None)
    return str(
        getattr(ctx, "requester_user_id", "")
        or user.get("id")
        or user.get("user_id")
        or user.get("username")
        or ""
    )


@router.get("/projects/{project}/episodes/{episode_num}/raw-content")
async def get_raw_content(
    project: str,
    episode_num: int,
    user: dict = Depends(get_api_user),
    store: SQLiteStore = Depends(get_sqlite_store),
):
    """Read the source text of a specified episode."""
    content = await store.load_episode_content(episode_num) or ""
    return {"ok": True, "data": {"episode": episode_num, "content": content}}


@router.put("/projects/{project}/episodes/{episode_num}/raw-content")
async def put_raw_content(
    project: str,
    episode_num: int,
    body: ContentUpdateRequest,
    user: dict = Depends(require_project_scope("projects:write")),
    store: SQLiteStore = Depends(get_sqlite_store),
):
    """Save the source text of a specified episode."""
    logger.info("[%s] EP%d put_raw_content: %d chars", project, episode_num, len(body.content))
    await store.save_episode_content(episode_num, body.content)
    return {"ok": True, "data": {"episode": episode_num, "length": len(body.content)}}


@router.get("/projects/{project}/episodes/{episode_num}/adapted-content")
async def get_adapted_content(
    project: str,
    episode_num: int,
    user: dict = Depends(get_api_user),
    store: SQLiteStore = Depends(get_sqlite_store),
):
    """Read the rewritten script of a specified episode. Returns an empty string if not saved."""
    content = await store.load_adapted_content(episode_num)
    return {"ok": True, "data": {"episode": episode_num, "content": content}}


@router.put("/projects/{project}/episodes/{episode_num}/adapted-content")
async def put_adapted_content(
    project: str,
    episode_num: int,
    body: ContentUpdateRequest,
    user: dict = Depends(require_project_scope("projects:write")),
    store: SQLiteStore = Depends(get_sqlite_store),
):
    """Save the rewritten script of a specified episode. Returns 400 if the episode does not exist."""
    logger.info(
        "[%s] EP%d put_adapted_content: %d chars",
        project,
        episode_num,
        len(body.content),
    )
    try:
        await store.save_adapted_content(episode_num, body.content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "data": {"episode": episode_num, "length": len(body.content)}}


@router.delete("/projects/{project}/episodes/{episode_num}/adapted-content")
async def delete_adapted_content(
    project: str,
    episode_num: int,
    user: dict = Depends(require_project_scope("projects:write")),
    store: SQLiteStore = Depends(get_sqlite_store),
):
    """Clear the rewritten script of a specified episode, falling back to the source text."""
    logger.info("[%s] EP%d delete_adapted_content", project, episode_num)
    try:
        await store.save_adapted_content(episode_num, "")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "data": {"episode": episode_num}}


@router.post("/projects/{project}/episodes/{episode_num}/rewrite/generate")
async def generate_rewrite(
    project: str,
    episode_num: int,
    body: RewriteGenerateRequest,
    user: dict = Depends(require_project_scope("projects:write")),
    store: SQLiteStore = Depends(get_sqlite_store),
):
    """Synchronously run "source text -> line-by-line narration working draft" and save it to adapted_content.

    The old task implementation is deliberately not carried over here; 2.0 can later wrap this adapter into
    the new task system, but the adapter and storage contract are stabilized first.
    """
    raw_content = (await store.load_episode_content(episode_num) or "").strip()
    if not raw_content:
        return {
            "ok": False,
            "error": f"Episode {episode_num} has no source text yet. Fill in raw-content first",
        }

    resolved = await resolve_project_scope(project, user, required_role="editor")
    ctx = getattr(resolved, "ctx", None)
    project_id = str(getattr(ctx, "project_id", "") or "")
    billing_user_id = _requester_user_id_for_billing(resolved, user)
    usage_meter = get_usage_meter()
    billing_context = {
        "source": "sync_api",
        "endpoint": "generate_content_rewrite",
        "episode": episode_num,
        "target_beats": body.target_beats,
        "beat_chars_min": body.beat_chars_min,
        "beat_chars_max": body.beat_chars_max,
    }
    reservation = await usage_meter.reserve_feature_start_credits(
        user_id=billing_user_id,
        feature_key=CONTENT_REWRITE_FEATURE_KEY,
        product_surface="mainline",
        project_id=project_id,
        resource_kind="script",
        task_type=CONTENT_REWRITE_TASK_TYPE,
        metadata=billing_context,
        require_price_rule=True,
        require_positive_cost=True,
    )
    reservation_id = str(reservation.get("id") or "")
    model_billing_metadata: dict[str, Any] = {
        "model_call_credit_policy": MODEL_CALL_CREDIT_POLICY_FEATURE_INCLUDED,
        "feature_key": CONTENT_REWRITE_FEATURE_KEY,
        "source": "sync_api",
    }
    if reservation_id:
        model_billing_metadata.update(
            {
                "feature_credit_reservation_id": reservation_id,
                "feature_credit_charge_id": reservation_id,
                "feature_credit_cost": str(reservation.get("cost") or 0),
            }
        )

    try:
        usage_meter.set_llm_usage_context(
            billing_user_id,
            project_id=project_id,
            resource_kind="script",
            billing_metadata=model_billing_metadata,
        )
        await store.load_graph_state()
        episode = store.get_episode(episode_num)
        episode_title = getattr(episode, "title", "") if episode else ""
        narrator_main_name = _resolve_narrator_main_name(store)

        from novelvideo.agents.content_rewriter import rewrite_episode_content

        rewritten = await rewrite_episode_content(
            raw_content,
            episode_title=episode_title,
            protagonist_name=narrator_main_name,
            target_beats=body.target_beats,
            beat_chars_range=(body.beat_chars_min, body.beat_chars_max),
            narration_style=body.narration_style or "first_person",
        )
        normalized = rewritten.strip()
        if normalized == raw_content:
            normalized = ""
        await store.save_adapted_content(episode_num, normalized)
        # Column-level: rewriting the working text must not re-serialise the
        # scene and prop menus that planning may have written meanwhile.
        await store.patch_episode(episode_num, beat_source_text=normalized)
    except Exception as exc:
        if reservation_id:
            try:
                await usage_meter.settle_cancelled_feature_credit_reservation(
                    reservation_id,
                    metadata={**billing_context, "error": str(exc)},
                )
            except Exception:
                logger.exception(
                    "Failed to settle interrupted content rewrite feature credit reservation"
                )
        if isinstance(exc, ValueError):
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        raise
    finally:
        usage_meter.clear_llm_usage_context()

    if reservation_id:
        try:
            await usage_meter.settle_feature_credit_reservation(
                reservation_id,
                action="confirm",
                metadata=billing_context,
            )
        except Exception:
            logger.exception(
                "Content rewrite succeeded but credit confirmation remains pending"
            )

    lines = [line for line in normalized.splitlines() if line.strip()]
    return {
        "ok": True,
        "data": {
            "episode": episode_num,
            "line_count": len(lines),
            "adapted_content": normalized,
            "used_fallback": not bool(normalized),
        },
    }


def _resolve_narrator_main_name(store: SQLiteStore) -> str:
    """Find the name of the is_main=True narration protagonist from the store; return an empty string if none."""
    for character in store.get_all_characters():
        if getattr(character, "is_main", False):
            return character.name or ""
    return ""
