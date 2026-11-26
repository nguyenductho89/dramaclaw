from __future__ import annotations

import json

import httpx
import pytest
from pydantic import BaseModel
from pydantic_ai import Agent

from novelvideo import config


@pytest.fixture
def wrapper_env(monkeypatch):
    monkeypatch.setenv("TEXT_LLM_BACKEND", "claude_wrapper")
    monkeypatch.setenv("CLAUDE_WRAPPER_BASE_URL", "http://127.0.0.1:8000/v1/")
    monkeypatch.delenv("CLAUDE_WRAPPER_API_KEY", raising=False)
    monkeypatch.delenv("CLAUDE_WRAPPER_DEFAULT_MODEL", raising=False)
    monkeypatch.delenv("CLAUDE_SCENE_BUILD_MODEL", raising=False)


def test_route_is_off_by_default(monkeypatch):
    monkeypatch.delenv("TEXT_LLM_BACKEND", raising=False)
    assert config.claude_wrapper_enabled() is False
    assert config.get_newapi_structured_output_model_settings() == {
        "openai_reasoning_effort": "none"
    }


def test_credentials_default_and_trailing_slash(wrapper_env):
    api_key, base_url = config.get_claude_wrapper_credentials()
    assert base_url == "http://127.0.0.1:8000/v1"
    assert api_key


def test_model_name_precedence(wrapper_env, monkeypatch):
    # Default when nothing is configured.
    assert config.get_effective_newapi_text_model_name("SCENE_BUILD_MODEL") == "opusplan"

    monkeypatch.setenv("CLAUDE_WRAPPER_DEFAULT_MODEL", "sonnet")
    assert config.get_effective_newapi_text_model_name("SCENE_BUILD_MODEL") == "sonnet"

    # Per-task env beats the default; the gateway alias env is ignored.
    monkeypatch.setenv("SCENE_BUILD_MODEL", "DC-scene-builder-LLM")
    monkeypatch.setenv("CLAUDE_SCENE_BUILD_MODEL", "opus")
    assert config.get_effective_newapi_text_model_name("SCENE_BUILD_MODEL") == "opus"

    # A Claude-looking override wins; a gateway model override is ignored.
    assert (
        config.get_effective_newapi_text_model_name(
            "SCENE_BUILD_MODEL", model_name_override="claude-sonnet-4-6"
        )
        == "claude-sonnet-4-6"
    )
    assert (
        config.get_effective_newapi_text_model_name(
            "SCENE_BUILD_MODEL", model_name_override="gemini-3.5-flash"
        )
        == "opus"
    )


def test_structured_output_settings_are_empty(wrapper_env):
    assert config.get_newapi_structured_output_model_settings() == {}


def test_factory_returns_prompted_wrapper_model(wrapper_env, monkeypatch):
    monkeypatch.setenv("CLAUDE_SCENE_BUILD_MODEL", "haiku")
    model = config.get_newapi_text_pydantic_model("SCENE_BUILD_MODEL")

    assert model.model_name == "haiku"
    assert str(model.client.base_url).rstrip("/") == "http://127.0.0.1:8000/v1"
    assert model.profile.supports_tools is False
    assert model.profile.default_structured_output_mode == "prompted"


def test_credential_override_still_bypasses_wrapper(wrapper_env):
    model = config.get_newapi_text_pydantic_model(
        "SCENE_BUILD_MODEL",
        "some-model",
        credential_override=("key", "https://org.example/v1"),
    )
    assert str(model.client.base_url).rstrip("/") == "https://org.example/v1"


class _Plan(BaseModel):
    title: str


async def test_structured_agent_sends_no_tools(wrapper_env, monkeypatch):
    """output_type agents must use prompted JSON, not a tool call."""
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "id": "x",
                "object": "chat.completion",
                "created": 0,
                "model": "opusplan",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": '{"title": "ok"}'},
                    }
                ],
            },
        )

    monkeypatch.setattr(
        config,
        "_newapi_text_http_client_factory",
        lambda *, timeout_seconds: (
            lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))
        ),
    )
    model = config.get_newapi_text_pydantic_model("SCENE_BUILD_MODEL")
    result = await Agent(model, output_type=_Plan).run("plan it")

    assert result.output == _Plan(title="ok")
    assert "tools" not in seen["body"]
    assert "response_format" not in seen["body"]
    assert seen["body"]["model"] == "opusplan"
