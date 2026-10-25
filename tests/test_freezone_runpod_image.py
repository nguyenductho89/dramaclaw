"""Unit tests for the 2026-10-22 RunPod Qwen-Image 2.1 addition to
Freezone's plain text-to-image path — previously Freezone image had NO
RunPod option reachable at all, blocked independently by (1) a hardcoded
4-provider allowlist in `freezone/route_helpers.py`, (2) the scoped media
model catalog hard-rejecting any model id that isn't a real catalog row,
and (3) `_generate_image()`'s own dispatch only implementing 4 explicit
providers (+"google" as a bare fallback) with no RunPod branch. See
`.claude/CLAUDE.md`.

No DB, no network, no GPU calls."""

from __future__ import annotations

import novelvideo.config as config_module
from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.freezone import route_helpers


def _set_runpod_qwen_image_configured(monkeypatch, value: bool) -> None:
    monkeypatch.setattr(config_module, "_runpod_qwen_image_configured", lambda: value)


def test_dev_catalog_entry_absent_when_not_configured(monkeypatch):
    _set_runpod_qwen_image_configured(monkeypatch, False)
    entries = freezone_routes._freezone_dev_media_model_catalog_entries("image")
    assert entries == []


def test_dev_catalog_entry_present_when_configured(monkeypatch):
    _set_runpod_qwen_image_configured(monkeypatch, True)
    entries = freezone_routes._freezone_dev_media_model_catalog_entries("image")
    assert len(entries) == 1
    entry = entries[0]
    assert entry["providerId"] == "runpod_qwen"
    assert entry["apiModel"] == "qwen-image-2.1"
    assert entry["catalogId"] == "runpod_qwen_image"
    # Round trip: this exact (providerId, apiModel) pair must resolve
    # back to a real `IMAGE_GENERATION_SELECTIONS` key via
    # `infer_image_generation_selection()` — the mechanism
    # `_start_or_enqueue_freezone_gen_job()` actually uses.
    assert (
        config_module.infer_image_generation_selection(
            entry["providerId"], entry["apiModel"]
        )
        == "runpod_qwen_image"
    )


def test_dev_catalog_entry_absent_for_unknown_media_type(monkeypatch):
    _set_runpod_qwen_image_configured(monkeypatch, True)
    entries = freezone_routes._freezone_dev_media_model_catalog_entries("audio")
    assert entries == []


def test_video_catalog_entry_absent_when_not_configured(monkeypatch):
    monkeypatch.setattr(config_module, "_runpod_h3_video_configured", lambda: False)
    # Isolate the 1-shot gate from the (separately-gated) Multishot entry
    # added 2026-10-25 — see test_freezone_runpod_video.py for its own
    # independent gating tests.
    monkeypatch.setattr(config_module, "_runpod_h3_multishot_configured", lambda: False)
    entries = freezone_routes._freezone_dev_media_model_catalog_entries("video")
    assert entries == []


def test_video_catalog_entry_present_when_configured(monkeypatch):
    # Real bug this fixes: `/freezone/video/models` ALSO checks the scoped
    # media catalog first (same pattern as images), so adding the RunPod
    # H3 backend only to `video_node.get_freezone_video_model_options()`
    # never actually reached the dropdown on a project with a non-empty
    # video catalog — confirmed via a live API call. See `.claude/CLAUDE.md`.
    monkeypatch.setattr(config_module, "_runpod_h3_video_configured", lambda: True)
    monkeypatch.setattr(config_module, "_runpod_h3_multishot_configured", lambda: False)
    entries = freezone_routes._freezone_dev_media_model_catalog_entries("video")
    assert len(entries) == 1
    entry = entries[0]
    assert entry["providerId"] == "runpod"
    assert entry["apiModel"] == "runpod_minimax_h3"
    assert entry["catalogId"] == "runpod_minimax_h3"
    assert entry["minDuration"] == 5
    assert entry["maxDuration"] == 12


def test_request_schema_shape_is_catalog_compatible(monkeypatch):
    _set_runpod_qwen_image_configured(monkeypatch, True)
    entry = freezone_routes._freezone_dev_media_model_catalog_entries("image")[0]
    assert entry["request"]["endpoint"] == "images/generations"
    assert entry["request"]["parameters"] == []


def test_supported_freezone_image_providers_includes_runpod_qwen_when_configured():
    # This set is computed once at import time from the real `.env` this
    # test process was started with — on this machine RunPod Qwen-Image
    # is configured (used extensively this session), so it should already
    # be present; this guards against the allowlist line being reverted.
    if config_module._runpod_qwen_image_configured():
        assert "runpod_qwen" in route_helpers.SUPPORTED_FREEZONE_IMAGE_PROVIDERS


def test_resolve_freezone_image_provider_accepts_runpod_qwen_when_allowlisted(
    monkeypatch,
):
    monkeypatch.setattr(
        route_helpers,
        "SUPPORTED_FREEZONE_IMAGE_PROVIDERS",
        route_helpers.SUPPORTED_FREEZONE_IMAGE_PROVIDERS | {"runpod_qwen"},
    )
    assert route_helpers.resolve_freezone_image_provider("runpod_qwen") == "runpod_qwen"


def test_resolve_freezone_image_provider_rejects_runpod_qwen_when_not_allowlisted(
    monkeypatch,
):
    monkeypatch.setattr(
        route_helpers,
        "SUPPORTED_FREEZONE_IMAGE_PROVIDERS",
        {"huimeng", "newapi", "openrouter", "openai"},
    )
    import pytest
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        route_helpers.resolve_freezone_image_provider("runpod_qwen")


# ── _catalog_image_execution_selection: stale `requested_provider` ─────
#
# Real bug caught live (2026-10-23, user report: "model provider does not
# match configured media model" when generating with Qwen Image on
# Freezone). Root cause: `freezoneAiGateway.ts`'s `submitJob` re-derives
# `provider` by splitting `payload.model` on "/" and DISCARDS the form's
# own `payload.provider` whenever the model string has no slash — true
# for every Qwen-Image-2.1 `apiModel` ("qwen-image-2.1") — so a stale/
# unrelated provider guess from a different code path (a capability
# fallback, or simply `null`) can reach the backend paired with a
# correct, unrelated `model_id`. The catalog entry resolved via
# `model_id`/`model` (an authoritative, specific identifier match done
# upstream in `_resolve_catalog_request`) must win over that hint, not
# be rejected by it. See `.claude/CLAUDE.md`.


def test_catalog_execution_selection_ignores_mismatched_requested_provider():
    entry = {
        "catalogId": "runpod_qwen_image",
        "providerId": "runpod_qwen",
        "apiModel": "qwen-image-2.1",
        "aliases": ["runpod_qwen_image"],
    }
    provider, model = freezone_routes._catalog_image_execution_selection(
        entry,
        requested_provider="openai",  # stale/unrelated — must be ignored
        requested_model="qwen-image-2.1",
    )
    assert provider == "runpod_qwen"
    assert model == "qwen-image-2.1"


def test_catalog_execution_selection_ignores_none_requested_provider():
    entry = {
        "catalogId": "runpod_qwen_image",
        "providerId": "runpod_qwen",
        "apiModel": "qwen-image-2.1",
        "aliases": ["runpod_qwen_image"],
    }
    provider, model = freezone_routes._catalog_image_execution_selection(
        entry, requested_provider=None, requested_model="runpod_qwen_image"
    )
    assert provider == "runpod_qwen"
    assert model == "qwen-image-2.1"


def test_catalog_execution_selection_still_rejects_mismatched_requested_model():
    # The `model` check is a DIFFERENT identifier than `provider` — it
    # mirrors the same lookup `_resolve_catalog_request` already used to
    # find `entry` in the first place, so a caller passing a `model` that
    # contradicts the resolved entry is a real, meaningful error, unlike
    # the independently-derived `provider` hint. Must stay strict.
    entry = {
        "catalogId": "runpod_qwen_image",
        "providerId": "runpod_qwen",
        "apiModel": "qwen-image-2.1",
        "aliases": ["runpod_qwen_image"],
    }
    import pytest
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        freezone_routes._catalog_image_execution_selection(
            entry,
            requested_provider="runpod_qwen",
            requested_model="some-other-model",
        )


def test_catalog_execution_selection_passthrough_when_no_entry():
    provider, model = freezone_routes._catalog_image_execution_selection(
        None, requested_provider="openai", requested_model="gpt-image-2"
    )
    assert provider == "openai"
    assert model == "gpt-image-2"
