"""Unit tests for the 2026-10-22 RunPod H3 video addition to Freezone —
previously Freezone video had NO RunPod option reachable anywhere,
independent of whether env vars were configured, unlike the main
render/sketch/segments pipeline. See `.claude/CLAUDE.md`.

No DB, no network, no GPU calls — `_runpod_h3_video_configured()` is
monkeypatched directly."""

from __future__ import annotations

import pytest

import novelvideo.config as config_module
from novelvideo.freezone import video_node


def _set_runpod_h3_configured(monkeypatch: "pytest.MonkeyPatch", value: bool) -> None:
    monkeypatch.setattr(config_module, "_runpod_h3_video_configured", lambda: value)


def test_runpod_h3_absent_from_options_when_not_configured(monkeypatch):
    _set_runpod_h3_configured(monkeypatch, False)
    names = video_node.get_freezone_video_model_names()
    options = video_node.get_freezone_video_model_options()
    assert video_node.FREEZONE_RUNPOD_H3_BACKEND not in names
    assert all(item["id"] != video_node.FREEZONE_RUNPOD_H3_BACKEND for item in options)


def test_runpod_h3_present_in_options_when_configured(monkeypatch):
    _set_runpod_h3_configured(monkeypatch, True)
    names = video_node.get_freezone_video_model_names()
    options = video_node.get_freezone_video_model_options()
    assert video_node.FREEZONE_RUNPOD_H3_BACKEND in names

    entry = next(
        item for item in options if item["id"] == video_node.FREEZONE_RUNPOD_H3_BACKEND
    )
    assert entry["providerId"] == "runpod"
    assert entry["apiModel"] == "runpod_minimax_h3"
    # Matches `video_duration_bounds_for_backend("runpod_minimax_h3")`
    # (`video_duration.py`), already shared site-wide.
    assert entry["minDuration"] == 5
    assert entry["maxDuration"] == 12


def test_runpod_h3_resolution_options_are_a_safe_placeholder(monkeypatch):
    # H3 ignores the `resolution` parameter entirely (fixed output size) —
    # must not offer a 480p/720p/1080p picker that does nothing.
    _set_runpod_h3_configured(monkeypatch, True)
    options = video_node.freezone_video_resolution_options(
        video_node.FREEZONE_RUNPOD_H3_BACKEND
    )
    assert options == ("auto",)


def test_resolve_freezone_video_backend_accepts_runpod_h3_when_configured(monkeypatch):
    _set_runpod_h3_configured(monkeypatch, True)
    assert (
        video_node.resolve_freezone_video_backend("runpod_minimax_h3")
        == "runpod_minimax_h3"
    )


def test_resolve_freezone_video_backend_rejects_runpod_h3_when_not_configured(
    monkeypatch,
):
    _set_runpod_h3_configured(monkeypatch, False)
    with pytest.raises(ValueError):
        video_node.resolve_freezone_video_backend("runpod_minimax_h3")


def test_resolve_freezone_video_backend_default_unaffected_by_runpod(monkeypatch):
    # The default (first/no-arg) backend must stay the NewAPI default —
    # RunPod is additive, never the implicit choice.
    _set_runpod_h3_configured(monkeypatch, True)
    assert video_node.resolve_freezone_video_backend(None) == "newapi_seedance-2.0-fast"
    assert video_node.resolve_freezone_video_backend("") == "newapi_seedance-2.0-fast"


def test_is_freezone_runpod_h3_backend():
    assert video_node.is_freezone_runpod_h3_backend("runpod_minimax_h3")
    assert not video_node.is_freezone_runpod_h3_backend("newapi_seedance-2.0-fast")
    assert not video_node.is_freezone_runpod_h3_backend(None)
    assert not video_node.is_freezone_runpod_h3_backend("")


def test_video_generate_billing_short_circuits_for_runpod_h3():
    # Real bug this fixes: routing `runpod_minimax_h3` through
    # `_video_backend_cost_model()` (which only knows `newapi_*`/
    # `huimeng_*`/`VideoBackend` enum strings) raised `HTTPException(400,
    # "invalid video backend")` — the exact same bug class the main
    # pipeline's `_single_video_billing_metadata()` already fixed for its
    # own RunPod H3 submission. See `.claude/CLAUDE.md`.
    from novelvideo.api.routes.model_credits import freezone_video_generate_billing_params

    result = freezone_video_generate_billing_params(
        {
            "video_backend": "runpod_minimax_h3",
            "resolution": "auto",
            "pricing_quantity": 8,
        }
    )
    assert result == {}


def test_video_generate_billing_unaffected_for_newapi_backend():
    from novelvideo.api.routes.model_credits import freezone_video_generate_billing_params

    result = freezone_video_generate_billing_params(
        {
            "video_backend": "newapi_seedance-2.0-fast",
            "resolution": "720p",
            "pricing_quantity": 5,
        }
    )
    assert result != {}
    assert result["pricing_kind"] == "video"


def test_video_generate_task_billing_still_sets_feature_key_when_short_circuited():
    from novelvideo.api.routes.model_credits import freezone_video_generate_task_billing

    result = freezone_video_generate_task_billing(
        {"video_backend": "runpod_minimax_h3", "pricing_quantity": 8}
    )
    assert result == {"feature_key": "freezone.video_generate"}


# ── MiniMax H3 Multishot (2026-10-25) — SEPARATE backend/endpoint/gate ──────
# from the 1-shot entry above; see freezone/multishot.py and
# api/routes/freezone.py's _prepare_freezone_multishot.


def _set_runpod_h3_multishot_configured(monkeypatch: "pytest.MonkeyPatch", value: bool) -> None:
    monkeypatch.setattr(config_module, "_runpod_h3_multishot_configured", lambda: value)


def test_multishot_absent_from_options_when_not_configured(monkeypatch):
    _set_runpod_h3_multishot_configured(monkeypatch, False)
    names = video_node.get_freezone_video_model_names()
    assert video_node.FREEZONE_RUNPOD_H3_MULTISHOT_BACKEND not in names


def test_multishot_catalog_entry_absent_when_not_configured(monkeypatch):
    from novelvideo.api.routes import freezone as freezone_routes

    _set_runpod_h3_configured(monkeypatch, False)
    _set_runpod_h3_multishot_configured(monkeypatch, False)
    entries = freezone_routes._freezone_dev_media_model_catalog_entries("video")
    assert entries == []


def test_multishot_catalog_entry_present_and_independent_of_1shot_gate(monkeypatch):
    from novelvideo.api.routes import freezone as freezone_routes

    # 1-shot entry's own gate stays OFF — the multishot entry must still
    # appear; the two are gated independently.
    _set_runpod_h3_configured(monkeypatch, False)
    _set_runpod_h3_multishot_configured(monkeypatch, True)
    monkeypatch.setattr(config_module, "RUNPOD_H3_MULTISHOT_MAX_SHOTS", 2)
    entries = freezone_routes._freezone_dev_media_model_catalog_entries("video")
    assert len(entries) == 1
    entry = entries[0]
    assert entry["catalogId"] == video_node.FREEZONE_RUNPOD_H3_MULTISHOT_BACKEND
    assert entry["providerId"] == "runpod"
    assert entry["apiModel"] == "runpod_minimax_h3_multishot"
    assert entry["supportedModes"] == ["multishot"]
    assert entry["referenceVideoMax"] == 0
    assert entry["maxShots"] == 2


def test_multishot_catalog_entry_reference_image_max_matches_sampler_cap(monkeypatch):
    from novelvideo.api.routes import freezone as freezone_routes
    from novelvideo.generators.runpod_minimax_h3_multishot_video import (
        MULTISHOT_MAX_UNION_REFERENCES,
    )

    _set_runpod_h3_configured(monkeypatch, False)
    _set_runpod_h3_multishot_configured(monkeypatch, True)
    entries = freezone_routes._freezone_dev_media_model_catalog_entries("video")
    entry = next(e for e in entries if e["catalogId"] == video_node.FREEZONE_RUNPOD_H3_MULTISHOT_BACKEND)
    assert entry["referenceImageMax"] == MULTISHOT_MAX_UNION_REFERENCES


def test_is_freezone_runpod_h3_multishot_backend_predicate():
    assert video_node.is_freezone_runpod_h3_multishot_backend("runpod_minimax_h3_multishot")
    assert not video_node.is_freezone_runpod_h3_multishot_backend("runpod_minimax_h3")
    assert not video_node.is_freezone_runpod_h3_multishot_backend(None)
    assert not video_node.is_freezone_runpod_h3_multishot_backend("")


def test_multishot_video_generate_billing_short_circuits():
    from novelvideo.api.routes.model_credits import freezone_video_generate_billing_params

    result = freezone_video_generate_billing_params(
        {
            "video_backend": "runpod_minimax_h3_multishot",
            "resolution": "auto",
            "pricing_quantity": 10,
        }
    )
    assert result == {}
