from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import anthropic
import httpx
import pytest
from PIL import Image

from novelvideo import config
from novelvideo.generators import claude_vision
from novelvideo.generators.claude_vision import (
    ClaudeVisionError,
    describe_frame_layout,
    describe_frame_layout_or_empty,
)
from novelvideo.seedance2_i2v import h3_prompt
from novelvideo.seedance2_i2v.models import Seedance2I2VMode

SECRET = "sk-ant-test-secret"


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setattr(config, "CLAUDE_API_KEY", SECRET)
    monkeypatch.setattr(claude_vision, "uses_local_ce_runtime", lambda: True)


@pytest.fixture
def frame(tmp_path) -> Path:
    path = tmp_path / "beat_01.png"
    Image.new("RGB", (64, 96), "gray").save(path)
    return path


class _FakeClient:
    def __init__(self, *, response=None, error: Exception | None = None) -> None:
        self.calls: list[dict] = []
        self.closed = False
        self._response, self._error = response, error
        self.messages = SimpleNamespace(create=self._create)

    async def _create(self, **kwargs):
        self.calls.append(kwargs)
        if self._error:
            raise self._error
        return self._response

    async def close(self) -> None:
        self.closed = True


def _reply(text: str = "Camera is low; she runs toward it.", stop_reason: str = "end_turn"):
    return SimpleNamespace(stop_reason=stop_reason, content=[SimpleNamespace(type="text", text=text)])


def _status_error(status: int) -> anthropic.APIStatusError:
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    response = httpx.Response(status, request=request)
    return anthropic.APIStatusError("denied", response=response, body=None)


def test_vision_model_is_haiku_only():
    assert config.CLAUDE_VISION_MODEL == "claude-haiku-5-5"


@pytest.mark.asyncio
async def test_describe_sends_haiku_request_with_the_image(enabled, frame):
    client = _FakeClient(response=_reply())

    text = await describe_frame_layout(frame, action_text="Maya runs down the stairs.", client=client)

    assert text == "Camera is low; she runs toward it."
    call = client.calls[0]
    assert call["model"] == "claude-haiku-5-5"
    assert call["output_config"] == {"effort": "low"}
    assert "temperature" not in call and "thinking" not in call
    image, prompt = call["messages"][0]["content"]
    assert image["source"]["type"] == "base64" and image["source"]["media_type"] == "image/jpeg"
    assert "Maya runs down the stairs." in prompt["text"]
    assert client.closed is False  # an injected client is not closed by the callee


@pytest.mark.asyncio
async def test_http_error_keeps_status_and_never_the_key(enabled, frame):
    client = _FakeClient(error=_status_error(403))

    with pytest.raises(ClaudeVisionError) as exc_info:
        await describe_frame_layout(frame, action_text="x", client=client)

    assert exc_info.value.status == 403
    assert "403" in str(exc_info.value) and SECRET not in str(exc_info.value)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [_reply(stop_reason="refusal"), SimpleNamespace(stop_reason="end_turn", content=[])],
)
async def test_refusal_or_empty_reply_is_an_error(enabled, frame, response):
    with pytest.raises(ClaudeVisionError):
        await describe_frame_layout(frame, action_text="x", client=_FakeClient(response=response))


@pytest.mark.asyncio
async def test_unconfigured_or_enterprise_is_disabled(enabled, frame, monkeypatch):
    monkeypatch.setattr(config, "CLAUDE_API_KEY", "")
    assert await describe_frame_layout_or_empty(frame, action_text="x") == ""
    with pytest.raises(ClaudeVisionError):
        await describe_frame_layout(frame, action_text="x")

    monkeypatch.setattr(config, "CLAUDE_API_KEY", SECRET)
    monkeypatch.setattr(claude_vision, "uses_local_ce_runtime", lambda: False)
    assert await describe_frame_layout_or_empty(frame, action_text="x") == ""


@pytest.mark.asyncio
async def test_or_empty_swallows_provider_failures(enabled, frame, monkeypatch):
    async def boom(*args, **kwargs):
        raise ClaudeVisionError("Claude vision HTTP 429", 429)

    monkeypatch.setattr(claude_vision, "describe_frame_layout", boom)

    assert await describe_frame_layout_or_empty(frame, action_text="x") == ""


def _assets(frame: Path):
    return [
        SimpleNamespace(
            key="first_frame", label="current render", media_type="image", path=frame, exists=True,
            selected=True, request_field="reference_images", reference_label="图片1", image_number=1,
        )
    ]


def _fake_agent(captured: list[str]):
    class _Agent:
        async def run(self, task):
            captured.append(task)
            return SimpleNamespace(output="prompt")

    return _Agent()


@pytest.mark.asyncio
async def test_composer_task_carries_the_frame_observation(frame, monkeypatch):
    captured: list[str] = []
    monkeypatch.setattr(h3_prompt, "create_h3_prompt_composer_agent", lambda: _fake_agent(captured))

    async def fake_describe(path, *, action_text):
        assert Path(path) == frame and action_text == "Maya runs down the stairs."
        return "Camera is low; Maya moves toward the camera."

    monkeypatch.setattr(claude_vision, "describe_frame_layout_or_empty", fake_describe)

    await h3_prompt.compose_h3_prompt_with_agent(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat={"visual_description": "Maya runs down the stairs."},
        assets=_assets(frame),
        text_overlay={},
        prompt_guidance="",
        draft_prompt="draft",
    )

    task = captured[0]
    assert '"storyboard_frame_observation": "Camera is low; Maya moves toward the camera."' in task
    assert "never contradict it" in task


@pytest.mark.asyncio
async def test_composer_still_runs_when_vision_is_unavailable(frame, monkeypatch):
    captured: list[str] = []
    monkeypatch.setattr(h3_prompt, "create_h3_prompt_composer_agent", lambda: _fake_agent(captured))
    monkeypatch.setattr(config, "CLAUDE_API_KEY", "")

    await h3_prompt.compose_h3_prompt_with_agent(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat={"visual_description": "Maya runs down the stairs."},
        assets=_assets(frame),
        text_overlay={},
        prompt_guidance="",
        draft_prompt="draft",
    )

    assert '"storyboard_frame_observation": ""' in captured[0]
