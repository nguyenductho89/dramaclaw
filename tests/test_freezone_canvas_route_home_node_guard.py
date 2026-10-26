"""Only canvas routes with shared-storage semantics may drop the home node guard.

The plan document (`B2-canvas-placement-free.md` Section 6.4 step 11) says, in its own words, "remove
the home node guard at `api/routes/freezone.py:326`". **Deleting it literally is wrong**:
`TCP-P60` already narrowed the scope to "remove it call site by call site", and this file pins the reasoning down in executable form:

- That line (it has drifted to `:331` on the integration line, inside `_resolve_freezone_project`)
  **is not the guard of the canvas routes, it is the guard of all freezone routes** -- this file's
  `test_only_canvas_routes_opt_out_of_the_home_node_guard` counts on the spot:
  `@router.` currently appears 99 times, of which `tags=[TAG_FREEZONE_CANVAS]` is only 25.
- Deleting that line = opening up, in one go, the other 74 routes that read and write local project files via `Path(ctx.output_dir)` with
  **neither a lease nor a shared-storage handoff**, which directly conflicts with Section 6.3's "remove one by one, never in bulk".

So the landing form is to add to `_resolve_freezone_project` a **keyword argument `require_home_node` with default `True`**
(patterned on the `*, required_role: str = "editor"` already in its own signature),
passing `False` explicitly only at the call sites of placement-free canvas routes in the explicit allowlist. Workflow draft/run routes that still write the project-local
SQLite are not in the allowlist and must keep the default Home Node guard.

Division of labor among the four cases:

1. `test_default_still_rejects_a_non_home_node_project` -- behavior is unchanged to the letter when the new argument is not passed
   (the error body follows the existing assertion convention in `tests/test_project_context.py:35`).
2. `test_canvas_read_route_passes_the_home_node_guard` /
   `test_canvas_write_route_passes_the_home_node_guard` -- pick one read and one write from the allowlist,
   which **get past this guard** on a non-home node. Only this one thing is asserted: actually writing to disk still depends on shared storage,
   which is a handoff item in row 4 of Section 11 of `dispatch-and-branching.md`, outside this EU.
3. `test_non_canvas_freezone_routes_are_still_blocked_on_a_non_home_node` --
   Of the other 76, pick 3, which are **still blocked** with the identical error body.
4. `test_only_placement_free_canvas_routes_opt_out_of_the_home_node_guard` -- an AST static guardrail
   (two-way): call sites passing `require_home_node=False` must be, and may only be, in the explicit allowlist.
   Patterned on the AST invariant of `tests/test_freezone_canvas_route_to_thread.py:180` in the same directory.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest
from fastapi import HTTPException

from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.api.schemas import CanvasPayload
from novelvideo.project_context import ProjectContext

ROUTES_SOURCE = Path("src/novelvideo/api/routes/freezone.py")

# Source of truth for the guard's error body: `project_context.py:50-58`.
HOME_NODE_REJECTION_CODE = "project_not_on_this_node"
# The literal `_resolve_freezone_project` passes to the guard; other cases may be asserting on it.
FREEZONE_OPERATION = "access freezone project files"

USER = {"id": "owner_1", "username": "admin"}


def _remote_ctx(tmp_path: Path) -> ProjectContext:
    """A context of "project not on this node", shaped after `test_freezone_canvas_route_to_thread.py:48`."""

    return ProjectContext(
        project_id="proj_freezone",
        project_name="demo",
        owner_type="user",
        owner_id="owner_1",
        owner_username="admin",
        requester_user_id="owner_1",
        requester_username="admin",
        requester_principals=(("user", "owner_1"),),
        effective_role="editor",
        home_node_id="node_a",
        output_dir=tmp_path / "output" / "admin" / "demo",
        state_dir=tmp_path / "state" / "admin" / "demo",
        runtime_dir=tmp_path / "runtime" / "admin" / "demo",
        is_home_node=False,
    )


def _patch_remote_project(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> ProjectContext:
    """Stub only the control-plane resolution, **leaving the real guard in the chain as is** (this is exactly what is under test)."""

    ctx = _remote_ctx(tmp_path)
    ctx.output_dir.mkdir(parents=True, exist_ok=True)
    ctx.state_dir.mkdir(parents=True, exist_ok=True)

    async def fake_resolve_project_context(**_kwargs) -> ProjectContext:
        return ctx

    monkeypatch.setattr(freezone_routes, "resolve_project_context", fake_resolve_project_context)
    return ctx


def _assert_home_node_rejection(exc: HTTPException, ctx: ProjectContext) -> None:
    assert exc.status_code == 409
    assert exc.detail == {
        "code": HOME_NODE_REJECTION_CODE,
        "message": f"{FREEZONE_OPERATION} must run on the project home node",
        "project_id": ctx.project_id,
        "home_node_id": ctx.home_node_id,
    }


def _assert_not_a_home_node_rejection(exc: BaseException | None) -> None:
    if isinstance(exc, HTTPException) and isinstance(exc.detail, dict):
        assert exc.detail.get("code") != HOME_NODE_REJECTION_CODE, (
            "The canvas route is still blocked by the home node guard"
        )


async def test_default_still_rejects_a_non_home_node_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Not passing the new argument = today's behavior, unchanged to the letter (the 76 non-canvas routes rely on this default without changing a line)."""

    ctx = _patch_remote_project(monkeypatch, tmp_path)

    with pytest.raises(HTTPException) as excinfo:
        await freezone_routes._resolve_freezone_project("proj_freezone", USER)

    _assert_home_node_rejection(excinfo.value, ctx)


async def test_canvas_read_route_passes_the_home_node_guard(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`get_canvas` (`:11537`) is no longer blocked by the guard on a non-home node."""

    _patch_remote_project(monkeypatch, tmp_path)

    try:
        await freezone_routes.get_canvas(
            project="proj_freezone",
            canvas_id="never_written",
            user=USER,
        )
    except HTTPException as exc:  # pragma: no cover - only reached on regression
        _assert_not_a_home_node_rejection(exc)
        raise


async def test_canvas_write_route_passes_the_home_node_guard(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`put_canvas` (`:11775`) is no longer blocked by the guard on a non-home node.

    Only the one thing of getting past the guard is asserted -- writing to disk itself still depends on shared storage (a handoff item).
    """

    _patch_remote_project(monkeypatch, tmp_path)

    try:
        await freezone_routes.put_canvas(
            project="proj_freezone",
            canvas_id="written_off_home_node",
            body=CanvasPayload(nodes=[{"id": "n1"}], edges=[], metadata={}),
            user=USER,
        )
    except HTTPException as exc:  # pragma: no cover - only reached on regression
        _assert_not_a_home_node_rejection(exc)
        raise


async def test_workflow_run_route_remains_home_node_bound(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ctx = _patch_remote_project(monkeypatch, tmp_path)

    with pytest.raises(HTTPException) as excinfo:
        await freezone_routes.get_canvas_workflow_run(
            project="proj_freezone",
            canvas_id="default",
            run_id="run-1",
            user=USER,
        )

    _assert_home_node_rejection(excinfo.value, ctx)


@pytest.mark.parametrize(
    "handler_name",
    [
        "freezone_image_camera_options",
        "freezone_image_style_templates",
        "freezone_video_camera_templates",
    ],
)
async def test_non_canvas_freezone_routes_are_still_blocked_on_a_non_home_node(
    handler_name: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The other 76 change not a line: still blocked, with the identical error body."""

    ctx = _patch_remote_project(monkeypatch, tmp_path)
    handler = getattr(freezone_routes, handler_name)

    with pytest.raises(HTTPException) as excinfo:
        await handler(project="proj_freezone", user=USER)

    _assert_home_node_rejection(excinfo.value, ctx)


def _is_router_decorator(node: ast.expr) -> bool:
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "router"
    )


def _is_canvas_decorator(node: ast.expr) -> bool:
    if not isinstance(node, ast.Call):
        return False
    for keyword in node.keywords:
        if keyword.arg != "tags" or not isinstance(keyword.value, ast.List):
            continue
        if any(
            isinstance(element, ast.Name) and element.id == "TAG_FREEZONE_CANVAS"
            for element in keyword.value.elts
        ):
            return True
    return False


def _opts_out_of_the_guard(call: ast.Call) -> bool:
    return any(
        keyword.arg == "require_home_node"
        and isinstance(keyword.value, ast.Constant)
        and keyword.value.value is False
        for keyword in call.keywords
    )


PLACEMENT_FREE_CANVAS_ROUTES = {
    "create_canvas_from_preset",
    "build_projection_from_preset",
    "project_canvas_from_preset",
    "remove_canvas_projection",
    "projection_status",
    "list_canvases",
    "get_canvas_revision",
    "get_canvas",
    "list_canvas_history",
    "restore_canvas_history",
    "get_node_generation_history",
    "delete_node_generation_history_record",
    "get_canvas_generation_history",
    "put_canvas",
    "delete_canvas",
}


def test_only_placement_free_canvas_routes_opt_out_of_the_home_node_guard() -> None:
    """Two-way ratchet: opt-out may only appear in the explicit placement-free allowlist."""

    tree = ast.parse(ROUTES_SOURCE.read_text(encoding="utf-8"), filename=str(ROUTES_SOURCE))

    canvas_routes: dict[str, list[ast.Call]] = {}
    opt_outs_inside_routes: set[ast.Call] = set()
    router_decorators = 0

    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        decorators = [dec for dec in node.decorator_list if _is_router_decorator(dec)]
        if not decorators:
            continue
        router_decorators += len(decorators)
        resolver_calls = [
            call
            for call in ast.walk(node)
            if isinstance(call, ast.Call)
            and isinstance(call.func, ast.Name)
            and call.func.id == "_resolve_freezone_project"
        ]
        if any(_is_canvas_decorator(dec) for dec in decorators):
            canvas_routes[node.name] = resolver_calls
            opt_outs_inside_routes.update(call for call in resolver_calls if _opts_out_of_the_guard(call))
        else:
            assert [call.lineno for call in resolver_calls if _opts_out_of_the_guard(call)] == [], (
                f"Non-canvas route {node.name} passed require_home_node=False"
            )

    all_opt_outs = {
        call
        for call in ast.walk(tree)
        if isinstance(call, ast.Call)
        and isinstance(call.func, ast.Name)
        and call.func.id == "_resolve_freezone_project"
        and _opts_out_of_the_guard(call)
    }

    # After the merge, three non-canvas routes were added: video-extend, upscale/quote and upscale/probe.
    # The number of canvas routes stays at staging's 31, and the home-node opt-out allowlist is still checked item by item.
    # 2026-10-25: +2 non-canvas routes for MiniMax H3 Multishot
    # (/freezone/video/multishot/review, /freezone/video/multishot) — both
    # stay guarded (no require_home_node=False), same as every other
    # Freezone video route that reads/writes local project files.
    # 2026-10-26: +1 non-canvas route for the shot-by-shot video breakdown
    # (/freezone/video-breakdown) — same local-ffmpeg-plus-one-vision-call shape
    # as /freezone/analyze-video-story, stays guarded.
    assert router_decorators == 116
    assert len(canvas_routes) == 31

    assert set(canvas_routes) >= PLACEMENT_FREE_CANVAS_ROUTES
    assert "cancel_canvas_workflow_draft" in canvas_routes
    assert canvas_routes["cancel_canvas_workflow_draft"]
    assert not any(_opts_out_of_the_guard(call) for call in canvas_routes["cancel_canvas_workflow_draft"])

    # Forward: allowlisted routes must all opt out, at every call site.
    missing = {
        name: [call.lineno for call in calls if not _opts_out_of_the_guard(call)]
        for name, calls in canvas_routes.items()
        if name in PLACEMENT_FREE_CANVAS_ROUTES
        if not calls or not all(_opts_out_of_the_guard(call) for call in calls)
    }
    assert missing == {}

    # Canvas routes that still write the project-local SQLite must not opt out.
    unexpected = {
        name: [call.lineno for call in calls if _opts_out_of_the_guard(call)]
        for name, calls in canvas_routes.items()
        if name not in PLACEMENT_FREE_CANVAS_ROUTES
        if any(_opts_out_of_the_guard(call) for call in calls)
    }
    assert unexpected == {}

    # Reverse: not a single opt-out in the whole file may fall outside canvas routes (including module-level helpers).
    assert {call.lineno for call in all_opt_outs} == {
        call.lineno for call in opt_outs_inside_routes
    }
