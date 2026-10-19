"""Unit tests for the 4-endpoint `runpod_worker_control.py` registry (split
2026-10-19 from a single shared endpoint). No network — `_ctrl_*`/`_job_health`
are monkeypatched to assert the right endpoint id/idle-timeout is used per
key, not to exercise real HTTP."""

from __future__ import annotations

import pytest

from novelvideo import config, runpod_worker_control as rwc


def test_endpoint_keys_stable_order():
    assert rwc.endpoint_keys() == ["h3", "qwen_edit", "qwen_t2i", "multishot"]


def test_unknown_key_raises():
    with pytest.raises(rwc.RunpodWorkerControlError):
        rwc._spec("nope")


@pytest.mark.parametrize(
    "key,endpoint_attr,idle_attr,configured_attr",
    [
        ("h3", "RUNPOD_H3_VIDEO_ENDPOINT_ID", "RUNPOD_H3_VIDEO_IDLE_TIMEOUT_SECONDS", "_runpod_h3_video_configured"),
        (
            "qwen_edit",
            "RUNPOD_QWEN_EDIT_ENDPOINT_ID",
            "RUNPOD_QWEN_EDIT_IDLE_TIMEOUT_SECONDS",
            "_runpod_qwen_edit_configured",
        ),
        (
            "qwen_t2i",
            "RUNPOD_QWEN_IMAGE_ENDPOINT_ID",
            "RUNPOD_QWEN_IMAGE_IDLE_TIMEOUT_SECONDS",
            "_runpod_qwen_image_configured",
        ),
        (
            "multishot",
            "RUNPOD_H3_MULTISHOT_ENDPOINT_ID",
            "RUNPOD_H3_MULTISHOT_IDLE_TIMEOUT_SECONDS",
            "_runpod_h3_multishot_configured",
        ),
    ],
)
def test_spec_points_at_the_right_config_names(key, endpoint_attr, idle_attr, configured_attr):
    spec = rwc._spec(key)
    assert spec.endpoint_id_attr == endpoint_attr
    assert spec.idle_timeout_attr == idle_attr
    # Compare by __name__/__module__ rather than identity: under pytest's
    # import machinery `novelvideo.config` can be bound to 2 distinct
    # module objects (one imported as part of the package, one imported
    # bare) depending on collection order, so the *same* top-level function
    # can legitimately come back as two different function objects.
    assert spec.configured_fn.__name__ == configured_attr
    assert spec.configured_fn.__module__.endswith("novelvideo.config")


def test_each_endpoint_configured_independently(monkeypatch):
    # All 4 default to unconfigured (no .env in test env) — flipping just
    # RUNPOD_H3_MULTISHOT_ENDPOINT_ID on must not make the others report
    # configured, and vice versa.
    monkeypatch.setattr(config, "RUNPOD_API_KEY", "k")
    monkeypatch.setattr(config, "R2_ENDPOINT", "e")
    monkeypatch.setattr(config, "R2_BUCKET", "b")
    monkeypatch.setattr(config, "R2_ACCESS_KEY_ID", "a")
    monkeypatch.setattr(config, "R2_SECRET_ACCESS_KEY", "s")
    monkeypatch.setattr(config, "RUNPOD_H3_VIDEO_ENDPOINT_ID", "")
    monkeypatch.setattr(config, "RUNPOD_QWEN_EDIT_ENDPOINT_ID", "")
    monkeypatch.setattr(config, "RUNPOD_QWEN_IMAGE_ENDPOINT_ID", "")
    monkeypatch.setattr(config, "RUNPOD_H3_MULTISHOT_ENDPOINT_ID", "multishot-ep")

    assert rwc.runpod_worker_control_configured("multishot") is True
    assert rwc.runpod_worker_control_configured("h3") is False
    assert rwc.runpod_worker_control_configured("qwen_edit") is False
    assert rwc.runpod_worker_control_configured("qwen_t2i") is False
    assert rwc.any_runpod_worker_control_configured() is True


def test_get_status_unconfigured_short_circuits_without_network(monkeypatch):
    monkeypatch.setattr(config, "RUNPOD_H3_VIDEO_ENDPOINT_ID", "")

    async def _boom(*_a, **_kw):  # pragma: no cover - must never be called
        raise AssertionError("should not hit the network when unconfigured")

    monkeypatch.setattr(rwc, "_ctrl_get", _boom)
    import asyncio

    result = asyncio.run(rwc.get_status("h3"))
    assert result == {
        "key": "h3",
        "displayName": rwc._spec("h3").display_name,
        "configured": False,
        "running": False,
    }


def test_start_worker_uses_that_endpoints_own_id_and_idle_timeout(monkeypatch):
    monkeypatch.setattr(config, "RUNPOD_API_KEY", "k")
    monkeypatch.setattr(config, "R2_ENDPOINT", "e")
    monkeypatch.setattr(config, "R2_BUCKET", "b")
    monkeypatch.setattr(config, "R2_ACCESS_KEY_ID", "a")
    monkeypatch.setattr(config, "R2_SECRET_ACCESS_KEY", "s")
    monkeypatch.setattr(config, "RUNPOD_QWEN_EDIT_ENDPOINT_ID", "edit-ep-123")
    monkeypatch.setattr(config, "RUNPOD_QWEN_EDIT_IDLE_TIMEOUT_SECONDS", 42)

    calls = {}

    async def _fake_patch(endpoint_id, max_workers, idle_timeout):
        calls["endpoint_id"] = endpoint_id
        calls["max_workers"] = max_workers
        calls["idle_timeout"] = idle_timeout
        return {"workers": {"max": max_workers, "min": 0, "idleTimeout": idle_timeout}, "name": "n"}

    async def _fake_health(_endpoint_id):
        return None

    monkeypatch.setattr(rwc, "_ctrl_patch_workers", _fake_patch)
    monkeypatch.setattr(rwc, "_job_health", _fake_health)

    import asyncio

    result = asyncio.run(rwc.start_worker("qwen_edit"))
    assert calls == {"endpoint_id": "edit-ep-123", "max_workers": 1, "idle_timeout": 42}
    assert result["endpointId"] == "edit-ep-123"
    assert result["running"] is True


def test_start_worker_on_unconfigured_endpoint_raises_without_network(monkeypatch):
    monkeypatch.setattr(config, "RUNPOD_H3_MULTISHOT_ENDPOINT_ID", "")

    async def _boom(*_a, **_kw):  # pragma: no cover - must never be called
        raise AssertionError("should not hit the network when unconfigured")

    monkeypatch.setattr(rwc, "_ctrl_patch_workers", _boom)

    import asyncio

    with pytest.raises(rwc.RunpodWorkerControlError):
        asyncio.run(rwc.start_worker("multishot"))
