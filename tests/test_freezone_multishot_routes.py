"""Unit tests for the Freezone MiniMax H3 Multishot routes
(`/freezone/video/multishot/review`, `/freezone/video/multishot`).

Follows the established pattern in `test_freezone_video_route_modes.py`:
monkeypatch the route module's own catalog/project-resolution helpers and
call the route function directly. The H3 prompt rewriter LLM and worker
status check are monkeypatched too — no network, no RunPod, no DB."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

import novelvideo.agents.minimax_h3_prompt_builder as prompt_builder_module
import novelvideo.config as config_module
import novelvideo.runpod_worker_control as worker_control_module
from novelvideo.agents.minimax_h3_prompt_builder import build_fallback_minimax_h3_prompt
from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.api.schemas import (
    FreezoneMultishotShot,
    FreezoneMultishotShotPrompt,
    FreezoneVideoMultishotRequest,
    FreezoneVideoMultishotReviewRequest,
)

BACKEND = "runpod_minimax_h3_multishot"


def _capabilities(**overrides) -> dict:
    data = {
        "catalog_id": "catalog-multishot",
        "supportedModes": ["multishot"],
        "referenceImageMax": 3,
        "referenceVideoMax": 0,
        "resolutionOptions": ["auto"],
    }
    data.update(overrides)
    return data


def _touch(path: Path) -> str:
    path.write_bytes(b"")
    return str(path)


async def _install_fakes(
    monkeypatch,
    tmp_path: Path,
    *,
    capabilities: dict | None = None,
    library_items: list[dict] | None = None,
) -> dict:
    captured: dict = {}

    async def resolve_project(_project, _user, **_kwargs):
        return (
            SimpleNamespace(requester_user_id="user-1", project_id="proj-1"),
            "admin",
            "project",
            tmp_path,
            str(tmp_path / "output"),
        )

    async def resolve_backend(model, *, requester_user_id):
        assert requester_user_id == "user-1"
        return model

    async def resolve_request(_media_type, _model, _params, *, mode, requester_user_id):
        assert requester_user_id == "user-1"
        captured["request_mode"] = mode
        return None, {}, capabilities if capabilities is not None else _capabilities()

    def resolve_url_list(_project_dir, urls):
        # Real route resolves static URLs to real files; tests pass real
        # tmp_path file paths disguised as "urls" so Path(...).is_file()
        # checks in `_prepare_freezone_multishot` pass without a static
        # URL resolver.
        return [str(u) for u in urls if u]

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", resolve_project)
    monkeypatch.setattr(freezone_routes, "_resolve_catalog_video_backend", resolve_backend)
    monkeypatch.setattr(freezone_routes, "_resolve_catalog_request", resolve_request)
    monkeypatch.setattr(freezone_routes, "_resolve_url_list", resolve_url_list)
    monkeypatch.setattr(
        freezone_routes, "_load_video_character_items_by_ids", lambda *_a, **_k: library_items or []
    )
    monkeypatch.setattr(config_module, "_runpod_h3_multishot_configured", lambda: True)
    monkeypatch.setattr(config_module, "RUNPOD_H3_MULTISHOT_MAX_SHOTS", 2)

    async def fake_get_status(_key):
        return {"workers": 0, "max": 0}

    monkeypatch.setattr(worker_control_module, "get_status", fake_get_status)

    async def fake_generate(context, **kwargs):
        captured.setdefault("prompt_calls", []).append((context, kwargs))
        # The real no-LLM fallback assembler is "guaranteed to pass every
        # structural lint check" (see its own docstring) — using it here
        # means the happy-path tests below exercise the SAME re-lint the
        # enqueue route runs on every hand-edited prompt, with a prompt
        # that's actually supposed to pass it (unlike a hand-rolled
        # string, which would fail lint and make every happy-path test
        # indistinguishable from `test_enqueue_rejects_bad_hand_edited_prompt`).
        result = build_fallback_minimax_h3_prompt(context)
        return result, [], False

    monkeypatch.setattr(
        prompt_builder_module, "generate_minimax_h3_prompt_with_fallback", fake_generate
    )

    return captured


def _two_shots() -> list[FreezoneMultishotShot]:
    return [
        FreezoneMultishotShot(id="s1", description="A red phone rings on the table"),
        FreezoneMultishotShot(id="s2", description="She picks it up and frowns"),
    ]


# ── review route ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_review_does_not_enqueue_and_returns_prompts(monkeypatch, tmp_path: Path):
    start = _touch(tmp_path / "start.png")
    await _install_fakes(monkeypatch, tmp_path)
    monkeypatch.setattr(
        freezone_routes,
        "_enqueue_claimed_workflow_media",
        pytest.fail,  # must never be called by the review route
    )

    result = await freezone_routes.freezone_video_multishot_review(
        "project",
        FreezoneVideoMultishotReviewRequest(
            model=BACKEND,
            start_image_url=start,
            shots=_two_shots(),
        ),
        {"username": "admin"},
    )

    assert result["ok"] is True
    data = result["data"]
    assert data["can_enqueue"] is True
    assert len(data["shots"]) == 2
    assert data["shots"][0]["id"] == "s1"
    assert data["shots"][0]["prompt"]  # non-empty, real assembled prompt
    assert data["checkpoint"] == "fl2va"  # no references
    assert "input_fingerprint" in data and data["input_fingerprint"]


@pytest.mark.asyncio
async def test_review_rejects_wrong_model(monkeypatch, tmp_path: Path):
    start = _touch(tmp_path / "start.png")
    await _install_fakes(monkeypatch, tmp_path)

    with pytest.raises(Exception) as exc_info:
        await freezone_routes.freezone_video_multishot_review(
            "project",
            FreezoneVideoMultishotReviewRequest(
                model="runpod_minimax_h3",  # the 1-shot backend, not multishot
                start_image_url=start,
                shots=_two_shots(),
            ),
            {"username": "admin"},
        )
    assert getattr(exc_info.value, "status_code", None) == 400


@pytest.mark.asyncio
async def test_review_rejects_model_catalog_missing_multishot_mode(monkeypatch, tmp_path: Path):
    start = _touch(tmp_path / "start.png")
    # Catalog entry exists but doesn't declare multishot support.
    await _install_fakes(monkeypatch, tmp_path, capabilities=_capabilities(supportedModes=["text_to_video"]))

    with pytest.raises(Exception) as exc_info:
        await freezone_routes.freezone_video_multishot_review(
            "project",
            FreezoneVideoMultishotReviewRequest(
                model=BACKEND,
                start_image_url=start,
                shots=_two_shots(),
            ),
            {"username": "admin"},
        )
    assert getattr(exc_info.value, "status_code", None) == 400


@pytest.mark.asyncio
async def test_review_rejects_over_max_shots(monkeypatch, tmp_path: Path):
    start = _touch(tmp_path / "start.png")
    await _install_fakes(monkeypatch, tmp_path)  # MAX_SHOTS patched to 2
    shots = _two_shots() + [FreezoneMultishotShot(id="s3", description="A third shot")]

    with pytest.raises(Exception) as exc_info:
        await freezone_routes.freezone_video_multishot_review(
            "project",
            FreezoneVideoMultishotReviewRequest(
                model=BACKEND,
                start_image_url=start,
                shots=shots,
            ),
            {"username": "admin"},
        )
    assert getattr(exc_info.value, "status_code", None) == 400


@pytest.mark.asyncio
async def test_review_includes_canvas_and_library_references(monkeypatch, tmp_path: Path):
    start = _touch(tmp_path / "start.png")
    canvas_ref = _touch(tmp_path / "canvas_ref.png")
    lib_ref = _touch(tmp_path / "lib_ref.png")
    await _install_fakes(
        monkeypatch,
        tmp_path,
        library_items=[
            {"id": "lib-1", "name": "Alice", "category": "character", "image_urls": [lib_ref]}
        ],
    )

    result = await freezone_routes.freezone_video_multishot_review(
        "project",
        FreezoneVideoMultishotReviewRequest(
            model=BACKEND,
            start_image_url=start,
            reference_images=[{"url": canvas_ref, "name": "Canvas1", "kind": "character"}],
            character_ids=["lib-1"],
            shots=_two_shots(),
        ),
        {"username": "admin"},
    )

    data = result["data"]
    assert data["checkpoint"] == "ref2va"
    names = [r["name"] for r in data["references"]]
    assert names == ["Canvas1", "Alice"]
    assert data["references"][0]["tag"] == "<Picture 2>"
    assert data["references"][1]["tag"] == "<Picture 3>"


# ── enqueue route ─────────────────────────────────────────────────────────


async def _review_then_enqueue_kwargs(monkeypatch, tmp_path: Path, *, prompts: list[str] | None = None):
    start = _touch(tmp_path / "start.png")
    captured = await _install_fakes(monkeypatch, tmp_path)

    review = (
        await freezone_routes.freezone_video_multishot_review(
            "project",
            FreezoneVideoMultishotReviewRequest(
                model=BACKEND,
                start_image_url=start,
                shots=_two_shots(),
            ),
            {"username": "admin"},
        )
    )["data"]

    shot_prompts = [
        FreezoneMultishotShotPrompt(
            id=shot["id"],
            final_prompt=(prompts[i] if prompts else shot["prompt"]),
        )
        for i, shot in enumerate(review["shots"])
    ]
    return captured, start, review["input_fingerprint"], shot_prompts


@pytest.mark.asyncio
async def test_enqueue_succeeds_with_matching_fingerprint(monkeypatch, tmp_path: Path):
    captured, start, fingerprint, shot_prompts = await _review_then_enqueue_kwargs(monkeypatch, tmp_path)

    enqueue_calls: list[dict] = []

    async def fake_enqueue(**kwargs):
        enqueue_calls.append(kwargs)
        return {"ok": True, "job_id": kwargs["job_id"], "task_type": kwargs["task_type"]}

    monkeypatch.setattr(freezone_routes, "_enqueue_claimed_workflow_media", fake_enqueue)

    result = await freezone_routes.freezone_video_multishot(
        "project",
        FreezoneVideoMultishotRequest(
            model=BACKEND,
            start_image_url=start,
            shots=_two_shots(),
            review_fingerprint=fingerprint,
            shot_prompts=shot_prompts,
        ),
        {"username": "admin"},
    )

    assert result["ok"] is True
    assert len(enqueue_calls) == 1
    call = enqueue_calls[0]
    assert call["task_type"] == "freezone_video_multishot"
    assert call["queue_kind"] == "video"
    assert call["payload"]["billing"] == {}
    assert call["payload"]["config"]["shot_count"] == 2
    assert call["payload"]["config"]["start_image_path"] == start
    assert call["payload"]["config"]["checkpoint"] == "fl2va"


@pytest.mark.asyncio
async def test_enqueue_rejects_stale_fingerprint(monkeypatch, tmp_path: Path):
    captured, start, _fingerprint, shot_prompts = await _review_then_enqueue_kwargs(monkeypatch, tmp_path)
    monkeypatch.setattr(
        freezone_routes,
        "_enqueue_claimed_workflow_media",
        pytest.fail,  # must never be reached
    )

    with pytest.raises(Exception) as exc_info:
        await freezone_routes.freezone_video_multishot(
            "project",
            FreezoneVideoMultishotRequest(
                model=BACKEND,
                start_image_url=start,
                shots=_two_shots(),
                review_fingerprint="0" * 40,  # deliberately wrong
                shot_prompts=shot_prompts,
            ),
            {"username": "admin"},
        )
    assert getattr(exc_info.value, "status_code", None) == 409


@pytest.mark.asyncio
async def test_enqueue_rejects_bad_hand_edited_prompt(monkeypatch, tmp_path: Path):
    captured, start, fingerprint, shot_prompts = await _review_then_enqueue_kwargs(monkeypatch, tmp_path)
    # Overwrite the first shot's prompt with garbage text that real lint
    # will flag with error-severity issues (see lint_minimax_h3_prompt).
    shot_prompts[0] = FreezoneMultishotShotPrompt(
        id=shot_prompts[0].id, final_prompt="this is not a valid H3 prompt at all"
    )
    monkeypatch.setattr(
        freezone_routes,
        "_enqueue_claimed_workflow_media",
        pytest.fail,  # must never be reached
    )

    with pytest.raises(Exception) as exc_info:
        await freezone_routes.freezone_video_multishot(
            "project",
            FreezoneVideoMultishotRequest(
                model=BACKEND,
                start_image_url=start,
                shots=_two_shots(),
                review_fingerprint=fingerprint,
                shot_prompts=shot_prompts,
            ),
            {"username": "admin"},
        )
    assert getattr(exc_info.value, "status_code", None) == 400


@pytest.mark.asyncio
async def test_enqueue_rejects_mismatched_shot_prompts(monkeypatch, tmp_path: Path):
    captured, start, fingerprint, shot_prompts = await _review_then_enqueue_kwargs(monkeypatch, tmp_path)
    # Same COUNT (passes the schema's min_length=2) but a shot id that
    # doesn't exist in `shots` — the route's own id-matching check, not
    # pydantic's length check, must be what rejects this.
    short_prompts = [
        shot_prompts[0],
        FreezoneMultishotShotPrompt(id="not-a-real-shot-id", final_prompt=shot_prompts[1].final_prompt),
    ]
    monkeypatch.setattr(
        freezone_routes,
        "_enqueue_claimed_workflow_media",
        pytest.fail,  # must never be reached
    )

    with pytest.raises(Exception) as exc_info:
        await freezone_routes.freezone_video_multishot(
            "project",
            FreezoneVideoMultishotRequest(
                model=BACKEND,
                start_image_url=start,
                shots=_two_shots(),
                review_fingerprint=fingerprint,
                shot_prompts=short_prompts,
            ),
            {"username": "admin"},
        )
    assert getattr(exc_info.value, "status_code", None) == 400


@pytest.mark.asyncio
async def test_enqueue_returns_503_when_not_configured(monkeypatch, tmp_path: Path):
    captured, start, fingerprint, shot_prompts = await _review_then_enqueue_kwargs(monkeypatch, tmp_path)
    monkeypatch.setattr(config_module, "_runpod_h3_multishot_configured", lambda: False)
    monkeypatch.setattr(
        freezone_routes,
        "_enqueue_claimed_workflow_media",
        pytest.fail,  # must never be reached
    )

    with pytest.raises(Exception) as exc_info:
        await freezone_routes.freezone_video_multishot(
            "project",
            FreezoneVideoMultishotRequest(
                model=BACKEND,
                start_image_url=start,
                shots=_two_shots(),
                review_fingerprint=fingerprint,
                shot_prompts=shot_prompts,
            ),
            {"username": "admin"},
        )
    assert getattr(exc_info.value, "status_code", None) == 503
