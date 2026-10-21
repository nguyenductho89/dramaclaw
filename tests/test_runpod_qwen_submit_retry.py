"""Unit tests for `_runpod_submit_job_with_409_retry` (added 2026-10-21).

Real user report: a Qwen-Image 2.1 "compose" render failed with
`runpod qwen21 render image submit failed: Client error '409 Conflict'`
right after the worker was turned on — RunPod returns 409
(`ENDPOINT_PAUSED`) for a few seconds while `workers.max` is still
propagating 0->1. The H3 video callers already retried this (see
`runpod_minimax_h3_video.py`/`runpod_minimax_h3_multishot_video.py`), but
all 3 Qwen image submit paths did a bare `raise_for_status()` with no
retry at all. These tests cover the shared retry helper in isolation
(mocked httpx client, no real network/GPU), mirroring the established
pattern of unit-testing pure logic and leaving the actual HTTP round trip
to real GPU verification.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from novelvideo.generators.nanobanana_grid import _runpod_submit_job_with_409_retry


class _FakeResponse:
    def __init__(self, status_code: int, body: dict | None = None):
        self.status_code = status_code
        self._body = body or {}

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"Client error '{self.status_code}'", request=None, response=self  # type: ignore[arg-type]
            )

    def json(self) -> dict:
        return self._body


class _FakeClient:
    """Stands in for `httpx.AsyncClient` — only `.post` is used."""

    def __init__(self, responses: list):
        self._responses = list(responses)
        self.calls = 0

    async def post(self, *_args, **_kwargs):
        self.calls += 1
        item = self._responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


@pytest.fixture(autouse=True)
def _no_real_sleep(monkeypatch):
    """6 retries * 10s would make this suite take a minute for no reason —
    the retry *count* is what matters, not wall-clock time."""
    sleeps: list[float] = []

    async def _fast_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    monkeypatch.setattr(asyncio, "sleep", _fast_sleep)
    return sleeps


async def _call(client, label="runpod qwen image"):
    return await _runpod_submit_job_with_409_retry(
        client=client,
        base="https://api.runpod.ai/v2",
        endpoint_id="ep123",
        headers={},
        job_input={},
        label=label,
    )


@pytest.mark.asyncio
async def test_succeeds_on_first_try_no_retry():
    client = _FakeClient([_FakeResponse(200, {"id": "job-1"})])
    job_id, error = await _call(client)
    assert job_id == "job-1"
    assert error == ""
    assert client.calls == 1


@pytest.mark.asyncio
async def test_retries_409_then_succeeds():
    client = _FakeClient(
        [_FakeResponse(409), _FakeResponse(409), _FakeResponse(200, {"id": "job-2"})]
    )
    job_id, error = await _call(client)
    assert job_id == "job-2"
    assert error == ""
    assert client.calls == 3


@pytest.mark.asyncio
async def test_exhausts_409_retries_and_fails_with_labeled_error():
    client = _FakeClient([_FakeResponse(409)] * 6)
    job_id, error = await _call(client, label="runpod qwen21 render image")
    assert job_id is None
    assert client.calls == 6
    # The 6th 409 is attempt index 5 (not < 5), so it falls through to
    # raise_for_status() -> httpx.HTTPStatusError -> the except branch,
    # not the "unknown reason" fallback.
    assert error.startswith("runpod qwen21 render image submit failed:")


@pytest.mark.asyncio
async def test_non_409_http_error_retries_then_fails():
    client = _FakeClient([httpx.ConnectError("boom")] * 6)
    job_id, error = await _call(client, label="runpod qwen edit image")
    assert job_id is None
    assert client.calls == 6
    assert error == "runpod qwen edit image submit failed: boom"


@pytest.mark.asyncio
async def test_non_409_http_error_then_success_recovers():
    client = _FakeClient([httpx.ConnectError("boom"), _FakeResponse(200, {"id": "job-3"})])
    job_id, error = await _call(client)
    assert job_id == "job-3"
    assert error == ""
    assert client.calls == 2


@pytest.mark.asyncio
async def test_sleeps_10s_between_each_409_retry(_no_real_sleep):
    client = _FakeClient([_FakeResponse(409), _FakeResponse(409), _FakeResponse(200, {"id": "j"})])
    await _call(client)
    assert _no_real_sleep == [10, 10]
