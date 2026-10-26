"""Unit tests for the 2026-10-25 fix to `freezone_relight`/`freezone_multi_view`
hardcoding `aspect_ratio="16:9"` when enqueuing the edit job.

Real bug: relighting (or multi-view-ing) a 9:16 (or any non-16:9) source
still silently reshaped the output to 16:9, because the route passed a
literal "16:9" straight through to `_start_or_enqueue_freezone_edit_job`
instead of "original" — the sentinel that function already understands
(`_resolve_outpaint_aspect_ratio()`, used by the outpaint route for the
same purpose) and resolves off the actual source image's own ratio. See
`.claude/CLAUDE.md`.

No DB, no network, no GPU calls — `_resolve_freezone_project` and
`_start_or_enqueue_freezone_edit_job` are monkeypatched so only the route
body's own argument-building logic runs."""

from __future__ import annotations

from pathlib import Path

import pytest

from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.api.schemas import (
    FreezoneCharacterMultiViewRequest,
    FreezoneRelightRequest,
)


async def _fake_resolve_freezone_project(project, user, **_kwargs):
    return (object(), "user", "project", Path("/tmp/project"), "/tmp/project")


@pytest.mark.asyncio
async def test_freezone_relight_passes_original_aspect_ratio(monkeypatch):
    captured: dict = {}

    async def fake_enqueue(**kwargs):
        captured.update(kwargs)
        return {"ok": True, "data": {}}

    monkeypatch.setattr(
        freezone_routes, "_resolve_freezone_project", _fake_resolve_freezone_project
    )
    monkeypatch.setattr(
        freezone_routes, "_start_or_enqueue_freezone_edit_job", fake_enqueue
    )

    body = FreezoneRelightRequest(source_url="/static/foo.png")
    await freezone_routes.freezone_relight("proj", body, user={})

    assert captured["aspect_ratio"] == "original"


@pytest.mark.asyncio
async def test_freezone_multi_view_passes_original_aspect_ratio(monkeypatch):
    captured: dict = {}

    async def fake_enqueue(**kwargs):
        captured.update(kwargs)
        return {"ok": True, "data": {}}

    monkeypatch.setattr(
        freezone_routes, "_resolve_freezone_project", _fake_resolve_freezone_project
    )
    monkeypatch.setattr(
        freezone_routes, "_start_or_enqueue_freezone_edit_job", fake_enqueue
    )

    body = FreezoneCharacterMultiViewRequest(source_url="/static/foo.png")
    await freezone_routes.freezone_multi_view("proj", body, user={})

    assert captured["aspect_ratio"] == "original"
