"""Unit tests for Gemini WebAI as a Freezone image provider (2026-11-10).

`gemini_webai` has been the MAIN pipeline's default image provider for a while
(`IMAGE_GENERATION_SELECTIONS["gemini_webai"]` in config.py, dispatched inside
`NanoBananaGridGenerator.generate_grid()`), but Freezone could never reach it:

1. `SUPPORTED_FREEZONE_IMAGE_PROVIDERS` rejected the provider string before any
   catalog logic ran;
2. there was no catalog row, so it could not appear in `/freezone/image/models`;
3. `_generate_image()` — the function Freezone's jobs actually call — had no
   branch for it, so a request that got that far would fall into the bare
   `else:` and call the Google genai SDK with a gateway key.

Point 3 is the real bug and the first test below is its regression guard.

Also covered: the per-scene `conversation_id` session. Gemini keeps continuity
within one conversation, which is what makes several storyboard frames read as
one place — but a conversation shared across scenes carried one scene's
background figures into another (previs, 2026-11-09), so the scoping is the
point, not an optimisation.

No network: `_call_webai_chat_image_api` / httpx are monkeypatched.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from novelvideo.freezone.webai_sessions import load_session, save_session, session_file
from novelvideo.generators import nanobanana_grid


def _route_helpers():
    """`novelvideo.freezone.route_helpers` imports `novelvideo.api.schemas`, and the
    api package's own `__init__` imports the routes that import route_helpers back —
    so importing route_helpers FIRST in a fresh interpreter hits that cycle. Let the
    api package finish initialising, then import it."""
    import novelvideo.api.routes.freezone  # noqa: F401
    import novelvideo.freezone.route_helpers as route_helpers

    return route_helpers


def _cfg() -> dict:
    return {
        "provider": "gemini_webai",
        "model": "gemini6969",
        "api_key": "k",
        "base_url": "http://127.0.0.1:6969/v1",
        "mode": "1x1",
        "rows": 1,
        "cols": 1,
        "total_panels": 1,
    }


@pytest.mark.asyncio
async def test_generate_dispatches_to_webai_not_google_genai(monkeypatch, tmp_path: Path):
    captured: dict = {}

    async def fake_call(**kwargs):
        captured.update(kwargs)
        return b"fake-image-bytes", "", ""

    monkeypatch.setattr(nanobanana_grid, "_call_webai_chat_image_api", fake_call)

    out = tmp_path / "out.png"
    await nanobanana_grid.generate_text_to_image(
        prompt="a lunar module towering over two men",
        output_path=str(out),
        config=_cfg(),
    )

    assert captured["model"] == "gemini6969"
    assert captured["base_url"] == "http://127.0.0.1:6969/v1"
    assert captured["prompt"].startswith("a lunar module")
    assert out.read_bytes() == b"fake-image-bytes"


@pytest.mark.asyncio
async def test_reference_filenames_follow_their_mime_type(monkeypatch, tmp_path: Path):
    """WebAI-to-API returns HTTP 400 when a filename extension contradicts the
    declared MIME type, so a JPEG reference must not be named .png."""
    captured: dict = {}

    async def fake_call(**kwargs):
        captured.update(kwargs)
        return b"img", "", ""

    monkeypatch.setattr(nanobanana_grid, "_call_webai_chat_image_api", fake_call)

    jpeg = tmp_path / "plate.jpg"
    jpeg.write_bytes(b"\xff\xd8fake")
    png = tmp_path / "sheet.png"
    png.write_bytes(b"\x89PNGfake")

    await nanobanana_grid.generate_reference_edit_image(
        prompt="compose",
        reference_images=[str(jpeg), str(png)],
        output_path=str(tmp_path / "o.png"),
        config=_cfg(),
    )

    names = [name for name, _data, _mime in captured["reference_images"]]
    mimes = [mime for _name, _data, mime in captured["reference_images"]]
    assert names == ["ref_0.jpg", "ref_1.png"]
    assert mimes == ["image/jpeg", "image/png"]


@pytest.mark.asyncio
async def test_quota_reply_surfaces_the_models_own_words(monkeypatch, tmp_path: Path):
    """A daily image-quota reply comes back as a normal 200 with text and no
    artifact. Hiding that text turns "wait for the reset" into an opaque failure."""

    async def fake_call(**_kwargs):
        return None, "I can create more images as soon as your limit resets.", ""

    monkeypatch.setattr(nanobanana_grid, "_call_webai_chat_image_api", fake_call)

    with pytest.raises(ValueError, match="limit resets"):
        await nanobanana_grid.generate_text_to_image(
            prompt="p", output_path=str(tmp_path / "o.png"), config=_cfg()
        )


@pytest.mark.asyncio
async def test_session_round_trips_conversation_id(monkeypatch):
    """The conversation id must go out on the request and come back into the
    session dict, without changing the function's return arity."""
    seen: list[dict] = []

    class FakeResponse:
        status_code = 200

        def json(self):
            return {
                "conversation_id": "conv-xyz",
                "choices": [
                    {"artifacts": [{"type": "image", "url": "https://x/img=s0"}]}
                ],
            }

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, _url, headers=None, json=None):
            seen.append(json)
            return FakeResponse()

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(
        nanobanana_grid, "_download_webai_artifact", lambda _url, _cookie: (b"img", "")
    )

    session: dict = {}
    for _ in range(2):
        data, _text, error = await nanobanana_grid._call_webai_chat_image_api(
            api_key="k",
            model="gemini6969",
            prompt="p",
            base_url="http://127.0.0.1:6969/v1",
            cookie_file="/tmp/cookies.json",
            session=session,
        )
        assert data == b"img" and not error

    # First request opens a conversation, second continues it.
    assert "conversation_id" not in seen[0]
    assert seen[1]["conversation_id"] == "conv-xyz"
    assert session == {"conversation_id": "conv-xyz"}


@pytest.mark.asyncio
async def test_no_session_builds_the_pre_existing_request(monkeypatch):
    """Every caller that predates sessions passes nothing; their request must be
    byte-identical to before, i.e. carry no conversation_id key at all."""
    seen: list[dict] = []

    class FakeResponse:
        status_code = 200

        def json(self):
            return {
                "conversation_id": "conv-1",
                "choices": [{"artifacts": [{"type": "image", "url": "https://x/i"}]}],
            }

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, _url, headers=None, json=None):
            seen.append(json)
            return FakeResponse()

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(
        nanobanana_grid, "_download_webai_artifact", lambda _url, _cookie: (b"img", "")
    )

    await nanobanana_grid._call_webai_chat_image_api(
        api_key="k", model="m", prompt="p", base_url="http://x/v1", cookie_file="/tmp/c"
    )
    assert set(seen[0]) == {"model", "messages"}


def test_session_store_is_scoped_per_scene(tmp_path: Path):
    """One conversation per scene. A shared conversation was observed putting the
    Garden of Eden's background figures onto the Moon."""
    save_session(tmp_path, "moon", {"conversation_id": "c-moon"})
    save_session(tmp_path, "orchard", {"conversation_id": "c-orchard"})

    assert load_session(tmp_path, "moon") == {"conversation_id": "c-moon"}
    assert load_session(tmp_path, "orchard") == {"conversation_id": "c-orchard"}
    assert json.loads(session_file(tmp_path).read_text()) == {
        "moon": "c-moon",
        "orchard": "c-orchard",
    }


def test_empty_scene_key_means_no_session(tmp_path: Path):
    """The documented opt-out, and the behaviour of every pre-existing caller."""
    assert load_session(tmp_path, "") == {}
    save_session(tmp_path, "", {"conversation_id": "c"})
    assert not session_file(tmp_path).exists()


def test_session_store_survives_a_corrupt_file(tmp_path: Path):
    """Losing continuity is acceptable; failing a generated image is not."""
    path = session_file(tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not json")

    assert load_session(tmp_path, "moon") == {}
    save_session(tmp_path, "moon", {"conversation_id": "c-new"})
    assert load_session(tmp_path, "moon") == {"conversation_id": "c-new"}


def test_allowlist_is_gated_on_the_cookie_file():
    """Layer 1. The set is built at import time, so assert the invariant that ties
    it to the env var rather than reloading the module (reloading drags in the
    whole api package)."""
    import novelvideo.config as config

    route_helpers = _route_helpers()

    allowed = "gemini_webai" in route_helpers.SUPPORTED_FREEZONE_IMAGE_PROVIDERS
    assert allowed == bool(config.GEMINI_WEBAI_COOKIE_FILE)
    # Never silently added: the compose variant lives in RENDER_ONLY_SELECTION_KEYS
    # and generate_grid() rejects it without a beat compose_plan, which Freezone
    # has no concept of.
    assert (
        "gemini_webai_compose" not in route_helpers.SUPPORTED_FREEZONE_IMAGE_PROVIDERS
    )


def test_provider_resolution_matches_the_allowlist():
    from fastapi import HTTPException

    route_helpers = _route_helpers()

    if "gemini_webai" in route_helpers.SUPPORTED_FREEZONE_IMAGE_PROVIDERS:
        assert (
            route_helpers.resolve_freezone_image_provider("gemini_webai")
            == "gemini_webai"
        )
        return
    with pytest.raises(HTTPException) as excinfo:
        route_helpers.resolve_freezone_image_provider("gemini_webai")
    assert excinfo.value.status_code == 400


def test_catalog_row_is_gated_and_keyed_on_the_resolved_model(monkeypatch):
    """Layer 2. The catalog builder imports its config inside the function, so
    patching the constant is enough — no reload needed."""
    import novelvideo.config as config
    from novelvideo.api.routes import freezone as freezone_routes

    def _rows() -> list[dict]:
        return [
            row
            for row in freezone_routes._freezone_dev_media_model_catalog_entries("image")
            if row["catalogId"] == "gemini_webai"
        ]

    monkeypatch.setattr(config, "GEMINI_WEBAI_COOKIE_FILE", "")
    assert _rows() == []

    monkeypatch.setattr(config, "GEMINI_WEBAI_COOKIE_FILE", "/tmp/cookies.json")
    (row,) = _rows()
    # apiModel must be the RESOLVED model: the enqueue path calls
    # `_require_scoped_media_model("image", model)` with that value, so a row keyed
    # only on the selection name would 409 every job.
    assert row["apiModel"] == config.GEMINI_WEBAI_MODEL
    assert row["api_model"] == config.GEMINI_WEBAI_MODEL
    assert row["providerId"] == "gemini_webai"
    assert "gemini_webai" in row["aliases"]
    # The bridge drives a browser session; it has no size parameter at all.
    assert "resolutionOptions" not in row
