"""Episode list & planning & identity endpoints."""

import asyncio
import logging
import os
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends
from starlette.concurrency import run_in_threadpool

from novelvideo.api.auth import get_api_user
from novelvideo.api.chapter_preview import build_chapter_preview
from novelvideo.api.deps import (
    make_cognee_store,
    make_cognee_store_for_context,
    make_sqlite_store,
    make_sqlite_store_for_context,
    make_static_url_for_context,
    resolve_project_scope,
    sqlite_store_for_context_scope,
    sqlite_store_scope,
)
from novelvideo.api.schemas import EpisodePlanRequest, EpisodeUpdate, InsertManualShotRequest
from novelvideo.novel_source import (
    has_imported_novel,
    novel_import_required_response,
    resolve_uploaded_novel_filename,
)
from novelvideo.identity_prerequisites import (
    IdentityCharactersBuildingError,
    IdentityPlanningPrerequisiteError,
    identity_prerequisite_response,
    require_identity_characters,
)
from novelvideo.knowledge_pipeline import (
    KnowledgePipelineUnsupported,
    is_structured_pipeline,
)
from novelvideo.ports import get_task_backend, get_usage_meter
from novelvideo.project_config import load_project_config_file_from_state_dir
from novelvideo.scene_prerequisites import (
    SceneCatalogBuildingError,
    scene_prerequisite_response,
)
from novelvideo.task_identity import project_task_state_key
from novelvideo.task_state import ACTIVE_PROJECT_TASK_STATUSES, get_task_manager

logger = logging.getLogger("novelvideo.api.episodes")

router = APIRouter()
AssetCompiler = None


def _dir_entry_names(directory: "Path") -> set[str]:
    """Set of file names in a directory; treated as empty if the directory does not exist or is unreadable."""
    try:
        return set(os.listdir(directory))
    except OSError:
        return set()

_EPISODE_ASSET_PLANNER_TASKS = {
    "scene": ("episode_scene_planner", "scene"),
    "prop": ("episode_prop_planner", "prop"),
}


def _dump_episode_items(items):
    data = []
    for item in items or []:
        if hasattr(item, "model_dump"):
            data.append(item.model_dump())
        elif isinstance(item, dict):
            data.append(dict(item))
    return data


def _episode_detail_payload(ep, episode_num: int) -> dict:
    content_summary = getattr(ep, "content_summary", "") or getattr(ep, "summary", "") or ""
    return {
        "number": getattr(ep, "number", episode_num),
        "title": getattr(ep, "title", "") or "",
        "summary": content_summary,
        "raw_content": getattr(ep, "raw_content", "") or "",
        "beat_source_text": getattr(ep, "beat_source_text", "") or "",
        "content_summary": content_summary,
        "character_names": list(getattr(ep, "character_names", []) or []),
        "key_events": list(getattr(ep, "key_events", []) or []),
        "cliffhanger": getattr(ep, "cliffhanger", "") or "",
        "identity_ids": list(getattr(ep, "identity_ids", []) or []),
        "identity_default_map": dict(getattr(ep, "identity_default_map", {}) or {}),
        "scene_menu": _dump_episode_items(getattr(ep, "scene_menu", []) or []),
        "prop_menu": _dump_episode_items(getattr(ep, "prop_menu", []) or []),
    }


def _asset_compiler_cls():
    global AssetCompiler
    if AssetCompiler is None:
        from novelvideo.agents.asset_compiler import AssetCompiler as LoadedAssetCompiler

        AssetCompiler = LoadedAssetCompiler
    return AssetCompiler


def _episode_asset_task_scope(asset_kind: str, episode_num: int) -> str:
    return f"{asset_kind}_run_ep{int(episode_num):03d}"


def _find_episode(episodes, episode_num: int):
    for ep in episodes or []:
        if getattr(ep, "number", None) == episode_num:
            return ep
    return None


async def _plan_episode_assets(
    project: str,
    episode_num: int,
    asset_kind: str,
    user: dict,
):
    resolved = await resolve_project_scope(project, user, required_role="editor")
    await get_usage_meter().set_project_llm_usage_context(
        username=resolved.username,
        project_name=resolved.project_name,
        resource_kind="script",
    )

    store = (
        await make_cognee_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_cognee_store(resolved.username, resolved.project_name)
    )
    if store is None:
        return {"ok": False, "error": "CogneeStore initialization failed"}

    await store.load_graph_state()
    episode = _find_episode(store.get_all_episodes(), episode_num)
    if episode is None:
        return {"ok": False, "error": f"Episode {episode_num} not found"}

    logs: list[str] = []

    def log_fn(message: str) -> None:
        logs.append(message)

    compiler = _asset_compiler_cls()(store)
    state_dir = str(getattr(store, "state_dir", "") or "")
    project_config = (
        load_project_config_file_from_state_dir(state_dir)
        if state_dir
        else {}
    )
    compiler.spine_template = str(project_config.get("spine_template") or "drama")
    try:
        if asset_kind == "scene":
            scene_menu, new_count = await compiler.compile_episode_scenes(episode, on_log=log_fn)
            episode = _find_episode(store.get_all_episodes(), episode_num) or episode
            scene_menu_data = _dump_episode_items(scene_menu)
            return {
                "ok": True,
                "data": {
                    "kind": "scene",
                    "total_count": len(scene_menu_data),
                    "new_count": new_count,
                    "scene_menu": scene_menu_data,
                    "episode": _episode_detail_payload(episode, episode_num),
                    "logs": logs,
                },
            }

        if asset_kind == "prop":
            from novelvideo.services.prop_promotion_service import (
                promote_episode_props_to_global,
            )

            prop_menu = await compiler.compile_episode_props(episode, on_log=log_fn)
            promoted_props = await promote_episode_props_to_global(store, prop_menu)
            episode = _find_episode(store.get_all_episodes(), episode_num) or episode
            prop_menu_data = _dump_episode_items(prop_menu)
            return {
                "ok": True,
                "data": {
                    "kind": "prop",
                    "total_count": len(prop_menu_data),
                    "auto_promoted_props": promoted_props,
                    "prop_menu": prop_menu_data,
                    "episode": _episode_detail_payload(episode, episode_num),
                    "logs": logs,
                },
            }
    except ValueError as e:
        return {"ok": False, "error": str(e)}

    return {"ok": False, "error": f"Unknown asset planning kind: {asset_kind}"}


async def _enqueue_episode_asset_planner(
    project: str,
    episode_num: int,
    asset_kind: str,
    user: dict,
) -> dict:
    task_info = _EPISODE_ASSET_PLANNER_TASKS.get(asset_kind)
    if task_info is None:
        return {"ok": False, "error": f"Unknown asset planning kind: {asset_kind}"}
    task_type, label = task_info
    resolved = await resolve_project_scope(project, user, required_role="editor")
    if resolved.ctx is None:
        return await _plan_episode_assets(
            project=project,
            episode_num=episode_num,
            asset_kind=asset_kind,
            user=user,
        )
    if asset_kind == "scene":
        build_task = await run_in_threadpool(
            get_task_manager().get_task_for_project,
            resolved.ctx,
            "build_scenes",
            0,
        )
        if build_task is not None and build_task.status in ACTIVE_PROJECT_TASK_STATUSES:
            return scene_prerequisite_response(SceneCatalogBuildingError())
    task_scope = _episode_asset_task_scope(asset_kind, episode_num)
    queued = await get_task_backend().enqueue_project_task(
        resolved.ctx,
        product_surface="mainline",
        task_type=task_type,
        queue_kind="default",
        episode=episode_num,
        scope=task_scope,
        payload={"episode": episode_num, "asset_kind": asset_kind},
    )
    return {
        "ok": True,
        "task_type": task_type,
        "scope": task_scope,
        "task_id": queued.task_state.task_id,
        "task_key": project_task_state_key(
            task_type,
            resolved.ctx.project_id,
            episode_num,
            scope=task_scope,
        ),
        "backend": queued.backend,
        "queue": queued.queue,
        "data": {"target_episode": episode_num, "asset_kind": asset_kind},
        "message": f"Episode {episode_num} {label} planning queued",
    }


@router.get("/projects/{project}/episodes")
async def list_episodes(project: str, user: dict = Depends(get_api_user)):
    """Get the project episode list."""
    resolved = await resolve_project_scope(project, user, required_role="viewer")

    # The bare factory leaves closing to the call site, and here neither the normal return nor the error path calls close() --
    # behind every SQLiteStore is an aiosqlite connection plus a background thread, accumulating per request.
    # After this PR added beat_count to this route it is the sole data source of the episode list, and it is hit
    # once per entry into the shot view, so the leak is more evident.
    store_scope = (
        sqlite_store_for_context_scope(resolved.ctx)
        if resolved.ctx
        else sqlite_store_scope(resolved.username, resolved.project_name)
    )
    async with store_scope as store:
        episodes = store.get_all_episodes()
        # Every episode card must show the shot count. Bringing it along in one grouped query spares the frontend from pulling the full
        # beats payload of each episode just to count the length -- that would be "as many requests as episodes", each far more expensive than this integer.
        beat_counts = await store.count_beats_by_episode()

        data = []
        for ep in episodes:
            number = ep.number if hasattr(ep, "number") else 0
            data.append(
                {
                    "number": number,
                    "title": ep.title if hasattr(ep, "title") else "",
                    "summary": (
                        getattr(ep, "content_summary", "") or getattr(ep, "summary", "") or ""
                    ),
                    "identity_ids": list(getattr(ep, "identity_ids", []) or []),
                    "key_events": list(getattr(ep, "key_events", []) or []),
                    "scene_menu": _dump_episode_items(getattr(ep, "scene_menu", []) or []),
                    "prop_menu": _dump_episode_items(getattr(ep, "prop_menu", []) or []),
                    "beat_count": beat_counts.get(number, 0),
                }
            )

    return {"ok": True, "data": data}


@router.post("/projects/{project}/episodes/plan")
async def plan_episodes(project: str, body: EpisodePlanRequest, user: dict = Depends(get_api_user)):
    """Plan episodes."""
    logger.info(
        "[%s] plan_episodes: target=%d, mode=%s",
        project,
        body.target_episodes,
        body.planning_mode,
    )
    resolved = await resolve_project_scope(project, user, required_role="editor")
    ctx = resolved.ctx
    output_dir = resolved.output_dir
    state_dir = resolved.state_dir

    config = {
        "target_episodes": body.target_episodes,
        "planning_mode": body.planning_mode,
    }

    if ctx is not None:
        if not has_imported_novel(resolved.project_dir):
            return novel_import_required_response()
        # The AI planners read the Cognee graph, which structured_v1 projects do
        # not have. Reject before enqueue so the user gets an answer instead of
        # a task that is guaranteed to fail after reserving credit.
        if is_structured_pipeline(state_dir) and body.planning_mode != "chapters":
            return {
                "ok": False,
                "code": KnowledgePipelineUnsupported.error_code,
                "error": "This project only supports deterministic episode splitting by chapter / episode number",
            }
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            product_surface="mainline",
            task_type="build_episodes",
            queue_kind="default",
            episode=0,
            payload={"config": config, "output_dir": output_dir, "state_dir": state_dir},
        )
        return {
            "ok": True,
            "task_type": "build_episodes",
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key("build_episodes", ctx.project_id, 0),
            "backend": queued.backend,
            "queue": queued.queue,
            "message": f"Episode planning task queued (target {body.target_episodes} episodes)",
        }

    return {"ok": False, "error": "Episode planning requires a project context"}


@router.get("/projects/{project}/episodes/{episode_num}")
async def get_episode_detail(project: str, episode_num: int, user: dict = Depends(get_api_user)):
    """Get the full details of a specified episode."""
    resolved = await resolve_project_scope(project, user, required_role="viewer")

    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(resolved.username, resolved.project_name)
    )
    episode = store.get_episode(episode_num)
    if episode is None:
        return {"ok": False, "error": f"Episode {episode_num} not found"}

    return {"ok": True, "data": _episode_detail_payload(episode, episode_num)}


@router.get("/projects/{project}/episodes/{episode_num}/beats")
async def get_beats(project: str, episode_num: int, user: dict = Depends(get_api_user)):
    """Get the beats of a specified episode."""
    resolved = await resolve_project_scope(project, user, required_role="viewer")
    project_dir = resolved.project_dir

    # Read beats from the graph (unified data source).
    # get_beats_as_dicts only reads the beats table and does not touch the store's in-memory caches of characters/episodes/props,
    # so load_graph_state() is skipped -- it is three whole-table reads, more expensive than the query here.
    store_scope = (
        sqlite_store_for_context_scope(resolved.ctx, load_graph_state=False)
        if resolved.ctx
        else sqlite_store_scope(resolved.username, resolved.project_name)
    )
    async with store_scope as store:
        beats = await store.get_beats_as_dicts(episode_num)

    # Attach sketch_url / frame_url / video_url / audio_url to each beat.
    # Asset files are named by beat_number. Do not use enumerate index here:
    # manually inserted shots can have sparse/non-display-order beat numbers.
    sketches_dir = project_dir / "sketches" / f"ep{episode_num:03d}"
    frames_dir = project_dir / "frames" / f"ep{episode_num:03d}"
    videos_dir = project_dir / "videos" / "beats" / f"ep{episode_num:03d}"
    audio_dir = project_dir / "audio" / f"ep{episode_num:03d}"
    # The whole batch of file-existence probing + URL assembly is moved into a thread at once, leaving no synchronous syscalls on the event loop.
    # It used to be done per beat: 4 Path.exists() calls to find files, and after a hit project_static_url did another
    # exists()+stat() each -- the ?v=mtime at the tail of the static URL needs stat. For an episode with 20
    # beats that is about 160 exists plus 80 stat calls, all executed synchronously inside the async handler. On a local
    # SSD it is imperceptible; on OSSFS/network disks each one is a network round trip, and once it stalls, a single /beats request
    # can hold the Uvicorn worker heartbeat, with other requests in the same process waiting along with it.
    #
    # Now: each directory is listed once (4 listdir calls replace 4N exists calls), the remaining stat is still once per
    # hit file, but all of it happens inside a thread so the event loop can schedule other requests at any time.
    def _attach_asset_urls() -> list[tuple[dict, str]]:
        sketch_names = _dir_entry_names(sketches_dir)
        frame_names = _dir_entry_names(frames_dir)
        video_names = _dir_entry_names(videos_dir)
        audio_names = _dir_entry_names(audio_dir)

        # Collect the existing audio and hand it back to the caller to probe durations concurrently, giving the frontend duration controls their default/lower bound
        # (video duration must be >= audio). The probing is not done in this thread: it forks ffprobe and must go through
        # the bounded concurrency gate in media_io.
        jobs: list[tuple[dict, str]] = []
        for beat in beats:
            beat["audio_duration_seconds"] = None
            beat_num = int(beat.get("beat_number", 0) or 0)
            if beat_num <= 0:
                beat["sketch_url"] = ""
                beat["frame_url"] = ""
                beat["video_url"] = ""
                beat["audio_url"] = ""
                continue
            # sketch
            sketch_file = f"beat_{beat_num:02d}.png"
            if sketch_file in sketch_names:
                rel = f"sketches/ep{episode_num:03d}/{sketch_file}"
                beat["sketch_url"] = make_static_url_for_context(
                    resolved.ctx,
                    rel,
                    local_path=sketches_dir / sketch_file,
                )
            else:
                beat["sketch_url"] = ""
            # frame
            frame_file = f"beat_{beat_num:02d}.png"
            if frame_file in frame_names:
                rel = f"frames/ep{episode_num:03d}/{frame_file}"
                beat["frame_url"] = make_static_url_for_context(
                    resolved.ctx, rel, local_path=frames_dir / frame_file
                )
            else:
                beat["frame_url"] = ""
            # video
            video_file = f"beat_{beat_num:02d}.mp4"
            if video_file in video_names:
                rel = f"videos/beats/ep{episode_num:03d}/{video_file}"
                beat["video_url"] = make_static_url_for_context(
                    resolved.ctx, rel, local_path=videos_dir / video_file
                )
            else:
                beat["video_url"] = ""
            # audio
            audio_file = f"beat_{beat_num:02d}.mp3"
            if audio_file in audio_names:
                rel = f"audio/ep{episode_num:03d}/{audio_file}"
                beat["audio_url"] = make_static_url_for_context(
                    resolved.ctx, rel, local_path=audio_dir / audio_file
                )
                jobs.append((beat, str(audio_dir / audio_file)))
            else:
                beat["audio_url"] = ""
        return jobs

    audio_duration_jobs = await asyncio.to_thread(_attach_asset_urls)

    if audio_duration_jobs:
        from novelvideo.utils.media_io import get_audio_durations_async

        # Bounded concurrency. This used to gather the audio of the whole episode at once -- as many voiced shots as an episode has,
        # that many ffprobe forks at once, and on the default thread pool, so other blocking calls in the process queued along during the drain.
        # The real fix is to write the duration into the database at generation time and read it directly (TTS measured it anyway),
        # and for now the fan-out is merely capped.
        durations = await get_audio_durations_async(
            [path for _, path in audio_duration_jobs]
        )
        for (beat, _), value in zip(audio_duration_jobs, durations):
            if isinstance(value, (int, float)) and value > 0:
                beat["audio_duration_seconds"] = float(value)

    return {"ok": True, "data": beats}


@router.delete("/projects/{project}/episodes/{episode_num}/beats/{beat_number}/manual-shot")
async def delete_manual_shot_route(
    project: str,
    episode_num: int,
    beat_number: int,
    user: dict = Depends(get_api_user),
):
    """Delete a manually inserted beat. Regular mainline beats may not be deleted here."""
    resolved = await resolve_project_scope(project, user, required_role="editor")

    from novelvideo.manual_shots import delete_manual_shot

    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(resolved.username, resolved.project_name)
    )
    logger.info("[%s] EP%d delete_manual_shot beat=%d", project, episode_num, beat_number)
    try:
        beats = await delete_manual_shot(
            store,
            episode_number=episode_num,
            beat_number=beat_number,
        )
    except ValueError as e:
        return {"ok": False, "error": str(e)}

    return {"ok": True, "data": {"beats": beats}}


@router.post("/projects/{project}/episodes/{episode_num}/beats/insert-manual")
async def insert_manual_shot_route(
    project: str,
    episode_num: int,
    body: InsertManualShotRequest,
    user: dict = Depends(get_api_user),
):
    """Insert a manual beat; after_beat_number=None means insert before the first one."""
    resolved = await resolve_project_scope(project, user, required_role="editor")

    visual_description = (body.visual_description or "").strip()
    if not visual_description:
        return {"ok": False, "error": "visual_description must not be empty"}

    from novelvideo.manual_shots import insert_manual_shot

    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(resolved.username, resolved.project_name)
    )
    scene_ref = body.scene_ref.model_dump(exclude_none=True) if body.scene_ref else None
    logger.info(
        "[%s] EP%d insert_manual_shot: after=%s, has_scene_ref=%s",
        project,
        episode_num,
        body.after_beat_number,
        bool(scene_ref),
    )
    try:
        new_beat = await insert_manual_shot(
            store,
            episode_number=episode_num,
            after_beat_number=body.after_beat_number,
            visual_description=visual_description,
            duration_seconds=body.duration_seconds,
            scene_ref=scene_ref,
            time_of_day=body.time_of_day,
            detected_identities=body.detected_identities,
            detected_props=body.detected_props,
            audio_type=body.audio_type,
            speaker=body.speaker,
            narration_segment=body.narration_segment,
        )
    except ValueError as e:
        return {"ok": False, "error": str(e)}

    return {"ok": True, "data": new_beat}


@router.post("/projects/{project}/episodes/{episode_num}/identities/plan")
async def plan_episode_identities(
    project: str, episode_num: int, user: dict = Depends(get_api_user)
):
    """Plan the character identities of a single episode."""
    logger.info("[%s] EP%d plan_episode_identities", project, episode_num)
    resolved = await resolve_project_scope(project, user, required_role="editor")
    if resolved.ctx is not None:
        try:
            build_task = await run_in_threadpool(
                get_task_manager().get_task_for_project,
                resolved.ctx,
                "build_characters",
                0,
            )
            if (
                build_task is not None
                and build_task.status in ACTIVE_PROJECT_TASK_STATUSES
            ):
                raise IdentityCharactersBuildingError()

            store = await make_sqlite_store_for_context(resolved.ctx)
            try:
                require_identity_characters(store.get_all_characters())
            finally:
                await store.close()
        except IdentityPlanningPrerequisiteError as exc:
            return identity_prerequisite_response(exc)

        queued = await get_task_backend().enqueue_project_task(
            resolved.ctx,
            product_surface="mainline",
            task_type="identity_planner",
            queue_kind="default",
            episode=episode_num,
            payload={"episode": episode_num},
        )
        return {
            "ok": True,
            "task_type": "identity_planner",
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key(
                "identity_planner", resolved.ctx.project_id, episode_num
            ),
            "backend": queued.backend,
            "queue": queued.queue,
            "data": {"target_episode": episode_num},
            "message": f"Episode {episode_num} identity planning queued",
        }

    await get_usage_meter().set_project_llm_usage_context(
        username=resolved.username,
        project_name=resolved.project_name,
        resource_kind="portrait",
    )

    store = (
        await make_cognee_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_cognee_store(resolved.username, resolved.project_name)
    )
    await store.load_graph_state()
    try:
        require_identity_characters(store.get_all_characters())
    except IdentityPlanningPrerequisiteError as exc:
        return identity_prerequisite_response(exc)
    episodes = store.get_all_episodes()

    episode = None
    for ep in episodes:
        if ep.number == episode_num:
            episode = ep
            break

    if episode is None:
        return {"ok": False, "error": f"Episode {episode_num} not found"}

    from novelvideo.agents.identity_planner import IdentityPlanner

    planner = IdentityPlanner(store)
    logs = []
    new_count, resolved_count = await planner.plan_single_episode(
        episode, on_log=lambda msg: logs.append(msg)
    )
    episode = _find_episode(store.get_all_episodes(), episode_num) or episode

    # Collect identity information
    characters = store.get_all_characters()
    identities = []
    for c in characters:
        if not hasattr(c, "identities"):
            continue
        for ident in c.identities:
            if hasattr(ident, "identity_id") and ident.identity_id in (episode.identity_ids or []):
                identity_name = (
                    ident.identity_id.split("_", 1)[-1]
                    if "_" in ident.identity_id
                    else ident.identity_id
                )
                appearance_details = (
                    ident.appearance_details if hasattr(ident, "appearance_details") else ""
                )
                identities.append(
                    {
                        "character_name": c.name,
                        "identity_id": ident.identity_id,
                        "identity_name": identity_name,
                        "appearance_details": appearance_details,
                    }
                )

    return {
        "ok": True,
        "task_type": "identity_planner",
        "data": {"target_episode": episode_num},
        "message": f"Episode {episode_num} identity planning task started",
    }


@router.post("/projects/{project}/episodes/{episode_num}/identities/plan-async")
async def plan_episode_identities_async(
    project: str, episode_num: int, user: dict = Depends(get_api_user)
):
    """Async identity planning entry compatible with 1.0 / legacy frontends."""
    return await plan_episode_identities(project=project, episode_num=episode_num, user=user)


@router.post("/projects/{project}/episodes/{episode_num}/scenes/plan")
async def plan_episode_scenes(project: str, episode_num: int, user: dict = Depends(get_api_user)):
    """Plan the scene menu of a single episode."""
    logger.info("[%s] EP%d plan_episode_scenes", project, episode_num)
    return await _enqueue_episode_asset_planner(
        project=project,
        episode_num=episode_num,
        asset_kind="scene",
        user=user,
    )


@router.post("/projects/{project}/episodes/{episode_num}/props/plan")
async def plan_episode_props(project: str, episode_num: int, user: dict = Depends(get_api_user)):
    """Plan the prop menu of a single episode."""
    logger.info("[%s] EP%d plan_episode_props", project, episode_num)
    return await _enqueue_episode_asset_planner(
        project=project,
        episode_num=episode_num,
        asset_kind="prop",
        user=user,
    )


@router.patch("/projects/{project}/episodes/{episode_num}")
async def update_episode(
    project: str,
    episode_num: int,
    body: EpisodeUpdate,
    user: dict = Depends(get_api_user),
):
    """Edit the metadata of a specified episode."""
    resolved = await resolve_project_scope(project, user, required_role="editor")

    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(resolved.username, resolved.project_name)
    )

    # Confirm the episode exists
    episode = store.get_episode(episode_num)
    if episode is None:
        return {"ok": False, "error": f"Episode {episode_num} not found"}

    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"ok": True, "data": {"message": "No fields to update"}}

    # Column-level: a user editing a title while planning runs must not roll
    # back the menus that planning just wrote.
    await store.patch_episode(episode_num, **updates)

    # Return the updated episode info
    ep = store.get_episode(episode_num)
    return {"ok": True, "data": _episode_detail_payload(ep, episode_num)}


@router.get("/projects/{project}/chapters")
async def detect_chapters(
    project: str,
    spine_template: Literal["drama", "narrated"] | None = None,
    user: dict = Depends(get_api_user),
):
    """Detect the chapter structure of an uploaded novel."""
    resolved = await resolve_project_scope(project, user, required_role="viewer")

    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(resolved.username, resolved.project_name)
    )
    novel_text = store.load_novel_content()
    if not novel_text:
        return {"ok": False, "error": "No novel file found. Upload a novel first."}

    config = load_project_config_file_from_state_dir(resolved.state_dir)
    requested_spine_template = spine_template or str(
        config.get("spine_template") or "drama"
    ).strip()
    preview = build_chapter_preview(
        novel_text,
        include_scene_blocks=requested_spine_template != "narrated",
    )
    source_filename = resolve_uploaded_novel_filename(
        resolved.project_dir,
        novel_text,
        preferred_filename=str(config.get("ingest_source_filename") or ""),
    )
    # Old projects may predate persistent source tracking and only retain the
    # canonical parsed novel.  ``ingest/start`` recognizes this fallback and
    # first copies it into uploads/, keeping subsequent retries durable.
    preview["source_filename"] = source_filename or "novel.txt"

    return {"ok": True, "data": preview}
