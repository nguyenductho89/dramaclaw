"""Shared API dependencies.

Provides common helpers such as path computation and Store creation.
Project-level APIs must first resolve a ProjectContext; username/project are kept only for path display and script tooling.
"""

import contextlib
import re
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, AsyncIterator

from fastapi import Depends, HTTPException

from novelvideo.api.auth import get_api_user
from novelvideo.config import OUTPUT_DIR, RUNTIME_DIR, STATE_DIR
from novelvideo.project_context import (
    ProjectContext,
    require_project_home_node,
    resolve_project_context,
)
from novelvideo.ports.project import PROJECT_ROLE_EDITOR, role_allows
from novelvideo.utils.project_paths import ProjectPaths
from novelvideo.utils.static_urls import project_static_url

if TYPE_CHECKING:
    from novelvideo.cognee import CogneeStore
    from novelvideo.sqlite_store import SQLiteStore

PROJECT_TRASH_DIRNAME = "_trash"
ACCOUNT_ASSET_DIRNAME = "_account"
RESERVED_PROJECT_PREFIX = "_"


@dataclass(frozen=True)
class ProjectResolution:
    """Resolved project scope for project_id-based API routes."""

    ctx: ProjectContext
    username: str
    project_name: str
    project_dir: Path
    output_dir: str
    state_dir: str
    runtime_dir: str


def get_user_base_dir(username: str) -> Path:
    """Get the user root directory."""
    return Path(OUTPUT_DIR) / username


def get_user_project_roots(username: str) -> tuple[Path, Path]:
    """Get the user's project root directory (state first, output kept for compatibility)."""
    return (
        Path(STATE_DIR) / username,
        Path(OUTPUT_DIR) / username,
    )


def list_user_projects(username: str) -> list[str]:
    """List all project names of the user (state first, output kept for compatibility)."""
    project_names: set[str] = set()
    for user_root in get_user_project_roots(username):
        if not user_root.exists():
            continue
        for entry in user_root.iterdir():
            if not entry.is_dir():
                continue
            if entry.name.startswith(".") or entry.name in {
                PROJECT_TRASH_DIRNAME,
                ACCOUNT_ASSET_DIRNAME,
            }:
                continue
            project_names.add(entry.name)
    return sorted(name for name in project_names if get_project_paths(username, name).exists())


def get_project_paths(username: str, project: str) -> ProjectPaths:
    return ProjectPaths(username, project)


def get_project_paths_for_context(ctx: ProjectContext) -> ProjectPaths:
    return ProjectPaths.from_context(ctx)


def project_exists(username: str, project: str) -> bool:
    paths = get_project_paths(username, project)
    return paths.exists()


def get_project_dir(username: str, project: str) -> Path:
    """Get the project directory; raise 404 if it does not exist."""
    project_dir = get_project_paths(username, project).output_dir
    if not project_exists(username, project):
        raise HTTPException(status_code=404, detail=f"Project '{project}' not found")
    return project_dir


async def resolve_project_scope(
    project: str,
    user: dict,
    *,
    required_role: str = "viewer",
    media_read: bool = False,
) -> ProjectResolution:
    """Resolve a route project_id to ProjectContext-backed local paths."""
    ctx = await resolve_project_context(
        user=user,
        project_id=project,
        required_role=required_role,
        **({"media_read": True} if media_read else {}),
    )
    require_project_home_node(ctx, operation="resolve project files")
    return ProjectResolution(
        ctx=ctx,
        username=ctx.owner_username,
        project_name=ctx.project_name,
        project_dir=Path(ctx.output_dir),
        output_dir=str(ctx.output_dir),
        state_dir=str(ctx.state_dir),
        runtime_dir=str(ctx.runtime_dir),
    )


def may_run_asset_repair(ctx: ProjectContext | None) -> bool:
    """Whether existing-asset-name self-healing may run within this request.

    Self-healing does ``shutil.move`` on asset directories, rewrites SQLite primary keys, and refreshes ``updated_at`` -- this is a write operation,
    yet it hangs off a list endpoint with ``required_role="viewer"``: a read-only collaborator opening the asset page once would migrate the whole
    project. Restrict it to editor and above; read-only users still see things as they were (they could not delete or generate
    images anyway), and the first user with write permission to open the asset page heals everything in one go.

    ``ctx`` being ``None`` is the single-machine / CE path, which has no collaborator concept and is treated as having write permission.
    """

    if ctx is None:
        return True
    return role_allows(getattr(ctx, "effective_role", "") or "", PROJECT_ROLE_EDITOR)


def validate_project_name(name: str):
    """Validate the project name format."""
    if len(name) > 64:
        raise HTTPException(
            status_code=400,
            detail="Project name must be at most 64 characters long",
        )
    if not name or not re.match(r"^[a-zA-Z0-9_]+$", name):
        raise HTTPException(
            status_code=400,
            detail="Project name must contain only letters, digits, and underscores",
        )
    if name.startswith(RESERVED_PROJECT_PREFIX):
        raise HTTPException(
            status_code=400,
            detail="Project name must not start with underscore",
        )


def get_output_dir(username: str, project: str) -> str:
    """Get the project output directory (absolute path string, for the task backend)."""
    return str(Path(OUTPUT_DIR) / username / project)


def get_state_dir(username: str, project: str) -> str:
    """Get the project state directory (absolute path string, for the task backend)."""
    return str(Path(STATE_DIR) / username / project)


def get_runtime_dir(username: str, project: str) -> str:
    """Get the project runtime directory (absolute path string, for the task backend)."""
    return str(Path(RUNTIME_DIR) / username / project)


async def _close_on_init_failure(store: "Any", *steps: "Any") -> "Any":
    """Run a freshly constructed store's init steps, closing it if one raises.

    ``SQLiteStore.initialize()`` opens the aiosqlite connection and starts its
    background thread; ``load_graph_state()`` runs after that and can fail on a
    corrupt or half-migrated database. Between those two points the store is
    live but has never been handed to anyone — the ``*_scope`` wrappers below
    only take ownership of what the factory *returns*, so their ``finally`` never
    sees a store whose init blew up. Raising without closing here therefore
    leaks the connection and its thread for the rest of the process, silently.

    Errors from ``close()`` are swallowed on purpose: the init failure is the
    one worth reporting, and a close that fails on a store that never finished
    opening tells the caller nothing useful.
    """
    try:
        for step in steps:
            await step()
    except BaseException:
        close = getattr(store, "close", None)
        if close is not None:
            with contextlib.suppress(Exception):
                await close()
        raise
    return store


async def make_cognee_store(username: str, project: str) -> "CogneeStore":
    """Create a CogneeStore instance per request.

    Legacy API/task paths still await this function directly; FastAPI dependencies use the
    ``*_store_scope`` wrappers below, to avoid changing every call site at once.
    """
    from novelvideo.cognee import CogneeStore

    project_name = f"{username}/{project}"
    output_dir = get_output_dir(username, project)
    state_dir = get_state_dir(username, project)
    store = CogneeStore(project_name, output_dir=output_dir, state_dir=state_dir)
    return await _close_on_init_failure(store, store.initialize)


async def make_sqlite_store(
    username: str,
    project: str,
    *,
    load_graph_state: bool = True,
) -> "SQLiteStore":
    """Create a SQLiteStore instance per request."""
    from novelvideo.sqlite_store import SQLiteStore

    project_name = f"{username}/{project}"
    output_dir = get_output_dir(username, project)
    state_dir = get_state_dir(username, project)
    store = SQLiteStore(project_name, output_dir=output_dir, state_dir=state_dir)
    steps = [store.initialize]
    if load_graph_state:
        steps.append(store.load_graph_state)
    return await _close_on_init_failure(store, *steps)


async def make_sqlite_store_for_context(
    ctx: ProjectContext,
    *,
    load_graph_state: bool = True,
) -> "SQLiteStore":
    """Create a SQLiteStore from the resolved project owner/home paths.

    ``load_graph_state()`` hydrates the in-memory character/episode/prop caches
    with three full-table reads. Callers that use direct ``list_*`` queries or
    only touch ``beats`` (and never ``get_character`` / ``get_episode`` /
    ``get_cached_prop`` / ``resolve_name``) should pass
    ``load_graph_state=False`` — otherwise unrelated tables can cost more than
    the query they precede. Default stays ``True`` so existing callers keep the
    hydrated behaviour they rely on.
    """
    from novelvideo.sqlite_store import SQLiteStore

    require_project_home_node(ctx, operation="open project SQLite store")
    project_name = ctx.owner_project_label
    store = SQLiteStore(
        project_name,
        output_dir=str(ctx.output_dir),
        state_dir=str(ctx.state_dir),
    )
    steps = [store.initialize]
    if load_graph_state:
        steps.append(store.load_graph_state)
    return await _close_on_init_failure(store, *steps)


async def make_cognee_store_for_context(ctx: ProjectContext) -> "CogneeStore":
    """Create a CogneeStore from the resolved project owner/home paths."""
    from novelvideo.cognee import CogneeStore

    require_project_home_node(ctx, operation="open project graph store")
    store = CogneeStore(
        ctx.owner_project_label,
        output_dir=str(ctx.output_dir),
        state_dir=str(ctx.state_dir),
    )
    return await _close_on_init_failure(store, store.initialize)


async def _make_cognee_store_scope(username: str, project: str) -> AsyncIterator["CogneeStore"]:
    store = await make_cognee_store(username, project)
    try:
        yield store
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()


async def _make_sqlite_store_scope(
    username: str,
    project: str,
    *,
    load_graph_state: bool = True,
) -> AsyncIterator["SQLiteStore"]:
    store = (
        await make_sqlite_store(username, project)
        if load_graph_state
        else await make_sqlite_store(
            username,
            project,
            load_graph_state=False,
        )
    )
    try:
        yield store
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()


async def _make_sqlite_store_for_context_scope(
    ctx: ProjectContext,
    *,
    load_graph_state: bool = True,
) -> AsyncIterator["SQLiteStore"]:
    store = await make_sqlite_store_for_context(ctx, load_graph_state=load_graph_state)
    try:
        yield store
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()


sqlite_store_scope = asynccontextmanager(_make_sqlite_store_scope)
cognee_store_scope = asynccontextmanager(_make_cognee_store_scope)

#: ``async with`` scoped version of :func:`make_sqlite_store_for_context`.
#:
#: The bare factory leaves the responsibility of closing to each call site, so routes are littered with hand-copied
#: ``try/finally`` + ``getattr(store, "close", None)`` -- miss one copy and you leak a
#: SQLite connection, silently. Read paths that already resolved a ``ProjectContext`` should use this,
#: which also passes through ``load_graph_state``: read-only beats paths pass ``False``, saving three whole-table
#: reads that hydrate the character/episode/prop caches.
sqlite_store_for_context_scope = asynccontextmanager(_make_sqlite_store_for_context_scope)


async def get_sqlite_store(
    project: str,
    user: dict = Depends(get_api_user),
) -> AsyncIterator["SQLiteStore"]:
    """FastAPI dependency: SQLiteStore scoped to the current project_id."""
    ctx = await resolve_project_context(
        user=user,
        project_id=project,
        required_role="viewer",
    )
    store = await make_sqlite_store_for_context(ctx)
    try:
        yield store
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()


async def get_cognee_store(
    project: str,
    user: dict = Depends(get_api_user),
) -> AsyncIterator["CogneeStore"]:
    """FastAPI dependency: CogneeStore scoped to the current project_id."""
    ctx = await resolve_project_context(
        user=user,
        project_id=project,
        required_role="viewer",
    )
    store = await make_cognee_store_for_context(ctx)
    try:
        yield store
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()


async def get_project_context_dependency(
    project_id: str,
    user: dict = Depends(get_api_user),
) -> ProjectContext:
    return await resolve_project_context(user=user, project_id=project_id)


def make_project_static_url(
    ctx: ProjectContext,
    relative_path: str,
    local_path: str | Path | None = None,
) -> str:
    """Build the canonical protected project static URL."""
    resolved_local_path = (
        local_path if local_path is not None else Path(ctx.output_dir) / relative_path
    )
    return project_static_url(ctx.project_id, relative_path, local_path=resolved_local_path)


def make_static_url_for_context(
    ctx: ProjectContext,
    relative_path: str,
    local_path: str | Path | None = None,
) -> str:
    return make_project_static_url(ctx, relative_path, local_path=local_path)
