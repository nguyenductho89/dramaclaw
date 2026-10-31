"""StuckWorkerWatchdog: recycle a RunPod worker when a job sits IN_QUEUE too long."""

from __future__ import annotations

import asyncio

import pytest

import novelvideo.config as config
import novelvideo.runpod_worker_control as rwc


class _Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def api(monkeypatch):
    calls: list = []
    state = {
        "cfg": {"workers": {"max": 1, "min": 0, "idleTimeout": 90}},
        "health": {"workers": {"running": 0, "initializing": 1}, "jobs": {"inProgress": 0, "inQueue": 1}},
        "patch_error": None,
    }

    async def ctrl_get(endpoint_id):
        calls.append(("get", endpoint_id))
        return state["cfg"]

    async def job_health(endpoint_id):
        calls.append(("health", endpoint_id))
        return state["health"]

    async def patch(endpoint_id, max_workers, idle_timeout):
        calls.append(("patch", max_workers, idle_timeout))
        if state["patch_error"]:
            raise state["patch_error"]
        return {}

    async def no_sleep(_s):
        return None

    monkeypatch.setattr(rwc, "_ctrl_get", ctrl_get)
    monkeypatch.setattr(rwc, "_job_health", job_health)
    monkeypatch.setattr(rwc, "_ctrl_patch_workers", patch)
    monkeypatch.setattr(asyncio, "sleep", no_sleep)
    monkeypatch.setattr(config, "RUNPOD_STUCK_WORKER_RECYCLE_SECONDS", 900.0)
    monkeypatch.setattr(config, "RUNPOD_STUCK_WORKER_MAX_RECYCLES", 1)
    return calls, state


def _run(coro):
    return asyncio.run(coro)


def _dog(clock):
    return rwc.StuckWorkerWatchdog("ep", clock=clock)


def test_no_api_calls_before_threshold(api):
    calls, _ = api
    clock = _Clock()
    dog = _dog(clock)
    assert _run(dog.observe("IN_QUEUE")) is False
    clock.now = 899
    assert _run(dog.observe("IN_QUEUE")) is False
    assert calls == []


def test_recycles_after_threshold_keeping_idle_timeout(api):
    calls, _ = api
    clock = _Clock()
    dog = _dog(clock)
    _run(dog.observe("IN_QUEUE"))
    clock.now = 901
    assert _run(dog.observe("IN_QUEUE")) is True
    assert [c for c in calls if c[0] == "patch"] == [("patch", 0, 90), ("patch", 1, 90)]


def test_skips_when_worker_turned_off(api):
    calls, state = api
    state["cfg"] = {"workers": {"max": 0, "min": 0, "idleTimeout": 90}}
    clock = _Clock()
    dog = _dog(clock)
    _run(dog.observe("IN_QUEUE"))
    clock.now = 1000
    assert _run(dog.observe("IN_QUEUE")) is False
    assert not [c for c in calls if c[0] == "patch"]


@pytest.mark.parametrize(
    "health",
    [
        {"workers": {"running": 1}, "jobs": {"inProgress": 0}},
        {"workers": {"running": 0}, "jobs": {"inProgress": 1}},
    ],
)
def test_skips_when_endpoint_busy(api, health):
    calls, state = api
    state["health"] = health
    clock = _Clock()
    dog = _dog(clock)
    _run(dog.observe("IN_QUEUE"))
    clock.now = 1000
    assert _run(dog.observe("IN_QUEUE")) is False
    assert not [c for c in calls if c[0] == "patch"]


def test_respects_max_recycles_and_resets_on_progress(api):
    calls, _ = api
    clock = _Clock()
    dog = _dog(clock)
    _run(dog.observe("IN_QUEUE"))
    clock.now = 1000
    assert _run(dog.observe("IN_QUEUE")) is True
    clock.now = 3000
    _run(dog.observe("IN_QUEUE"))
    clock.now = 5000
    assert _run(dog.observe("IN_QUEUE")) is False  # budget spent
    assert len([c for c in calls if c == ("patch", 0, 90)]) == 1


def test_in_progress_resets_wait(api):
    calls, _ = api
    clock = _Clock()
    dog = _dog(clock)
    _run(dog.observe("IN_QUEUE"))
    clock.now = 800
    _run(dog.observe("IN_PROGRESS"))
    clock.now = 1000
    assert _run(dog.observe("IN_QUEUE")) is False  # wait restarted at 1000
    assert calls == []


def test_patch_error_never_raises(api):
    import httpx

    calls, state = api
    state["patch_error"] = httpx.HTTPError("boom")
    clock = _Clock()
    dog = _dog(clock)
    _run(dog.observe("IN_QUEUE"))
    clock.now = 1000
    assert _run(dog.observe("IN_QUEUE")) is False


def test_threshold_zero_disables(api, monkeypatch):
    calls, _ = api
    monkeypatch.setattr(config, "RUNPOD_STUCK_WORKER_RECYCLE_SECONDS", 0.0)
    clock = _Clock()
    dog = _dog(clock)
    _run(dog.observe("IN_QUEUE"))
    clock.now = 10_000
    assert _run(dog.observe("IN_QUEUE")) is False
    assert calls == []
