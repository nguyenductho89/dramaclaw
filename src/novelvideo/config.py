"""NovelVideo configuration module.

A standalone configuration system with no dependency on SuperScript.
"""

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from novelvideo.official_defaults import (
    DEFAULT_TEXT_MODEL_BY_ENV,
    OFFICIAL_NEWAPI_BASE_URL,
)
from novelvideo.shared.runtime_env import is_ce_effective, uses_local_ce_runtime

# Load environment variables (must come before any other import)
load_dotenv()

# =============================================================================
# Model provider configuration
# =============================================================================

PROVIDER_PRESETS = {
    "openai": {
        "base_url": None,
        "default_model": "gpt-4o",
        "timeout": 120,
        "api_key_env": "OPENAI_API_KEY",
    },
    "anthropic": {
        "base_url": None,
        "default_model": "claude-sonnet-4-5",
        "timeout": 120,
        "api_key_env": "ANTHROPIC_API_KEY",
    },
    "gemini": {
        "base_url": None,
        "default_model": "gemini-3.5-flash",
        "timeout": 300,
        "api_key_env": "GOOGLE_API_KEY",
    },
    "openrouter": {
        "base_url": "https://openrouter.ai/api/v1",
        "default_model": "gemini-3.5-flash",
        "timeout": 300,
        "api_key_env": "OPENROUTER_API_KEY",
    },
    "volcengine": {
        "base_url": "https://ark.cn-beijing.volces.com/api/v3",
        "default_model": "doubao-seed-1-6-251015",
        "timeout": 1800,
        "api_key_env": "ARK_API_KEY",
    },
}

PROVIDER_ALIASES = {
    "doubao": "volcengine",
    "ark": "volcengine",
    "claude": "anthropic",
    "gpt": "openai",
    "google": "gemini",
    "or": "openrouter",
}


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "no", "n", "off"}:
        return False
    return default


def get_pydantic_model(
    provider_override: str | None = None,
    model_name_override: str | None = None,
    *,
    brainclaw_profile=None,
):
    """Return a PydanticAI model routed through the effective NewAPI gateway.

    This is the compatibility factory used by older Agent call sites. Provider
    settings still select their legacy default model when no model name is
    supplied, but they no longer select a direct-provider transport. CE reads
    credentials from settings.db; EE reads its deployment-level NewAPI env.

    Args:
        provider_override: Select the legacy provider preset used for a default
            model name. The request transport remains NewAPI.
        model_name_override: Override the model name sent to NewAPI.
    """
    provider = (
        provider_override or os.environ.get("MODEL_PROVIDER", "volcengine")
    ).lower()
    provider = PROVIDER_ALIASES.get(provider, provider)

    if provider not in PROVIDER_PRESETS:
        available = list(PROVIDER_PRESETS.keys()) + list(PROVIDER_ALIASES.keys())
        raise ValueError(
            f"Unknown provider: {provider}. Available: {', '.join(available)}"
        )

    preset = PROVIDER_PRESETS[provider]
    model_name = model_name_override or os.environ.get(
        "MODEL_NAME", preset["default_model"]
    )

    if provider == "openrouter" and model_name.startswith("openrouter/"):
        model_name = model_name[len("openrouter/") :]

    return get_newapi_text_pydantic_model(
        "MODEL_NAME",
        preset["default_model"],
        model_name_override=model_name,
        brainclaw_profile=brainclaw_profile,
        capability="text.generate.agent",
        timeout_seconds_override=_env_float(
            "MODEL_TIMEOUT",
            float(preset.get("timeout", 120)),
        ),
    )


def _clean_env_value(name: str | None) -> str | None:
    if not name:
        return None
    value = os.environ.get(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def get_newapi_text_model_name(model_env: str, default_model: str) -> str:
    """Return the logical newAPI text model for a path-specific task."""
    return _clean_env_value(model_env) or DEFAULT_TEXT_MODEL_BY_ENV.get(
        model_env, default_model
    )


def get_effective_newapi_text_model_name(
    model_env: str,
    default_model: str | None = None,
    *,
    model_name_override: str | None = None,
) -> str:
    """Resolve one text route without silently falling back across editions."""
    from novelvideo.model_gateway_settings import get_effective_llm_config
    from novelvideo.official_defaults import ADVANCED_TEXT_MODEL_BY_ENV

    explicit_model = str(model_name_override or "").strip()
    env_model = _clean_env_value(model_env)
    if not uses_local_ce_runtime():
        # EE never binds a route to BrainClaw. The deployment environment owns
        # the choice: each task's model env selects the alias, and BrainClaw is
        # reached by pointing that env at the BrainClaw alias. Fixed EE task
        # call sites omit ``default_model`` so a missing route fails fast;
        # generic/provider entry points may still supply an explicit default as
        # part of their public API.
        selected = explicit_model or env_model or default_model
        if selected:
            return selected
        raise ValueError(f"Missing required EE model route: {model_env}")

    if get_effective_llm_config().is_brainclaw:
        return "brainclaw"
    selected = explicit_model or env_model or ADVANCED_TEXT_MODEL_BY_ENV.get(model_env)
    if selected:
        return selected
    if default_model:
        return default_model
    raise ValueError(f"Missing required CE Advanced model route: {model_env}")


def _get_newapi_text_model_profile(model_name: str):
    """Attach Gemini-compatible model profile while routing through newAPI."""
    normalized = (model_name or "").strip()
    if not normalized.startswith("gemini-") or "image" in normalized:
        return None

    from pydantic_ai.providers.openrouter import OpenRouterProvider

    return OpenRouterProvider.model_profile(f"google/{normalized}")


def _newapi_text_http_client_factory(
    *,
    timeout_seconds: float,
) -> Any:
    trust_env = _env_bool("NEWAPI_TEXT_TRUST_ENV", True)

    def factory():
        import httpx

        from novelvideo.brainclaw_control_context_transport import (
            sign_brainclaw_control_context,
        )
        from novelvideo.brainclaw_outcome_runtime import capture_brainclaw_receipt

        kwargs: dict[str, Any] = {
            "timeout": timeout_seconds,
            # The request hook signs the serialised body; it is the last point
            # where the exact bytes BrainClaw will digest are still visible.
            "event_hooks": {
                "request": [sign_brainclaw_control_context],
                "response": [capture_brainclaw_receipt],
            },
        }
        if not trust_env:
            kwargs["trust_env"] = False
        return httpx.AsyncClient(**kwargs)

    return factory


def _newapi_text_openai_provider(
    *,
    api_key: str,
    base_url: str,
    timeout_seconds: float,
    default_headers: dict[str, str] | None = None,
):
    from openai import AsyncOpenAI
    from pydantic_ai.providers.openai import OpenAIProvider

    class _LifecycleManagedOpenAIProvider(OpenAIProvider):
        def __init__(self) -> None:
            http_client_factory = _newapi_text_http_client_factory(
                timeout_seconds=timeout_seconds,
            )
            http_client = http_client_factory()
            super().__init__(
                openai_client=AsyncOpenAI(
                    api_key=api_key,
                    base_url=base_url,
                    timeout=timeout_seconds,
                    max_retries=0,
                    http_client=http_client,
                    default_headers=default_headers,
                ),
            )
            self._own_http_client = http_client
            self._http_client_factory = http_client_factory

    return _LifecycleManagedOpenAIProvider()


def _newapi_text_openai_model(
    model_name: str,
    *,
    api_key: str,
    base_url: str,
    timeout_seconds: float,
    profile: Any,
    default_headers: dict[str, str] | None = None,
):
    from contextlib import asynccontextmanager

    from pydantic_ai.models.openai import OpenAIChatModel

    class _AutoClosingOpenAIChatModel(OpenAIChatModel):
        async def request(self, *args: Any, **kwargs: Any) -> Any:
            from novelvideo.brainclaw_outcome_runtime import (
                begin_request_outcomes,
                report_request_outcomes,
                reset_request_outcomes,
            )

            token = begin_request_outcomes()
            try:
                async with self:
                    result = await super().request(*args, **kwargs)
                report_request_outcomes(passed=True)
                return result
            except BaseException:
                report_request_outcomes(passed=False)
                raise
            finally:
                reset_request_outcomes(token)

        @asynccontextmanager
        async def request_stream(self, *args: Any, **kwargs: Any):
            from novelvideo.brainclaw_outcome_runtime import (
                begin_request_outcomes,
                report_request_outcomes,
                reset_request_outcomes,
            )

            token = begin_request_outcomes()
            try:
                async with self:
                    async with super().request_stream(*args, **kwargs) as response:
                        yield response
                report_request_outcomes(passed=True)
            except BaseException:
                report_request_outcomes(passed=False)
                raise
            finally:
                reset_request_outcomes(token)

    return _AutoClosingOpenAIChatModel(
        model_name,
        provider=_newapi_text_openai_provider(
            api_key=api_key,
            base_url=base_url,
            timeout_seconds=timeout_seconds,
            default_headers=default_headers,
        ),
        profile=profile,
    )


def get_newapi_text_pydantic_model(
    model_env: str,
    default_model: str | None = None,
    *,
    model_name_override: str | None = None,
    timeout_seconds_override: float | None = None,
    brainclaw_profile=None,
    brainclaw_profile_variant=None,
    capability: str = "text.generate",
):
    """Create a PydanticAI OpenAI-compatible model that routes through newAPI."""
    from novelvideo.brainclaw_contract import brainclaw_profile_headers
    from novelvideo.model_gateway_settings import get_effective_llm_config

    llm_config = get_effective_llm_config()
    model_name = get_effective_newapi_text_model_name(
        model_env,
        default_model,
        model_name_override=model_name_override,
    )
    timeout_seconds = (
        float(timeout_seconds_override)
        if timeout_seconds_override is not None
        else _env_float(
            f"{model_env}_TIMEOUT_SECONDS",
            _env_float("NEWAPI_TEXT_TIMEOUT_SECONDS", 300.0),
        )
    )
    profile = _get_newapi_text_model_profile(model_name)
    # CE resolves its own route from the settings database, so it knows when
    # Advanced mode should stay clean. EE only hands a logical alias to NewAPI
    # and cannot know which upstream NewAPI maps it to, so it always declares
    # the Profile and lets NewAPI/BrainClaw decide whether to act on it.
    default_headers = brainclaw_profile_headers(
        brainclaw_profile,
        profile_variant=brainclaw_profile_variant,
        brainclaw_active=llm_config.is_brainclaw if uses_local_ce_runtime() else True,
    )
    if not uses_local_ce_runtime():
        from novelvideo.model_gateway_runtime import (
            create_request_scoped_gateway_model,
        )

        return create_request_scoped_gateway_model(
            model_name=model_name,
            capability=capability,
            timeout_seconds=timeout_seconds,
            profile=profile,
            default_headers=default_headers,
            delegate_factory=_newapi_text_openai_model,
            platform_credential_factory=lambda: get_newapi_runtime_credentials(
                api_key_override=llm_config.api_key,
                base_url_override=llm_config.base_url,
                env_api_key="MODEL_API_KEY",
                env_base_url="MODEL_BASE_URL",
            ),
        )

    api_key, base_url = get_newapi_runtime_credentials(
        api_key_override=llm_config.api_key,
        base_url_override=llm_config.base_url,
        env_api_key="MODEL_API_KEY",
        env_base_url="MODEL_BASE_URL",
    )
    if not api_key:
        raise ValueError("API key not set. Configure DramaClawAPI credentials.")
    return _newapi_text_openai_model(
        model_name,
        api_key=api_key,
        base_url=base_url,
        timeout_seconds=timeout_seconds,
        profile=profile,
        default_headers=default_headers,
    )


def get_newapi_structured_output_model_settings() -> dict:
    """Disable reasoning for PydanticAI structured output requests.

    DramaClaw sends opaque ``DC-*`` aliases through an OpenAI-compatible
    NewAPI endpoint.  PydanticAI cannot infer thinking capabilities from those
    aliases, so its unified ``thinking=False`` setting is silently ignored.
    Use the explicit OpenAI-compatible wire contract that existing deployments
    already send when their task-level thinking setting is ``none``.
    """
    return {"openai_reasoning_effort": "none"}


def get_newapi_structured_output_litellm_kwargs() -> dict:
    """Disable reasoning for Cognee/Instructor calls routed through LiteLLM."""
    return {
        "reasoning_effort": "none",
        "allowed_openai_params": ["reasoning_effort"],
    }


def get_superpower_pydantic_model(
    *,
    feature_provider_env: str | None = None,
    feature_model_env: str | None = None,
    brainclaw_profile=None,
):
    """Return the multimodal model used by SuperPower prompt builders.

    By default this inherits the normal MODEL_PROVIDER/MODEL_NAME settings.
    Individual prompt builders can override that with feature-specific env vars
    (for example GLOBAL_VIDEO_PROVIDER/GLOBAL_VIDEO_MODEL). Global
    SUPERPOWER_* env vars remain available for deployments that want one shared
    SuperPower provider without hard-coding Google/Gemini in code.
    """

    provider_override = (
        _clean_env_value(feature_provider_env)
        or _clean_env_value("SUPERPOWER_PROVIDER")
        or _clean_env_value("SUPERPOWER_MODEL_PROVIDER")
    )
    model_name_override = (
        _clean_env_value(feature_model_env)
        or _clean_env_value("SUPERPOWER_MODEL")
        or _clean_env_value("SUPERPOWER_MODEL_NAME")
    )
    return get_pydantic_model(
        provider_override=provider_override,
        model_name_override=model_name_override,
        brainclaw_profile=brainclaw_profile,
    )


def get_model_info() -> dict:
    """Get the current model configuration info."""
    provider = os.environ.get("MODEL_PROVIDER", "volcengine").lower()
    provider = PROVIDER_ALIASES.get(provider, provider)
    preset = PROVIDER_PRESETS.get(provider, {})

    return {
        "provider": provider,
        "model": os.environ.get("MODEL_NAME", preset.get("default_model", "unknown")),
        "base_url": os.environ.get("MODEL_BASE_URL", preset.get("base_url")),
        "timeout": int(os.environ.get("MODEL_TIMEOUT", preset.get("timeout", 120))),
    }


# Redis configuration
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")


# =============================================================================
# Basic configuration
# =============================================================================

# Data root directory; the three subdirectory kinds (output/state/runtime) are derived from it by default
DATA_ROOT = os.path.abspath(os.environ.get("NOVELVIDEO_DATA_ROOT", "."))

# Use absolute paths so that task workers also find the right directories
OUTPUT_DIR = os.path.abspath(
    os.environ.get("NOVELVIDEO_OUTPUT_DIR", os.path.join(DATA_ROOT, "output"))
)

# State file directory (data.db, cognee_system/, project_config.json)
STATE_DIR = os.path.abspath(
    os.environ.get("NOVELVIDEO_STATE_DIR", os.path.join(DATA_ROOT, "state"))
)

# Runtime temporary directory (logs, staging, temp panels)
RUNTIME_DIR = os.path.abspath(
    os.environ.get("NOVELVIDEO_RUNTIME_DIR", os.path.join(DATA_ROOT, "runtime"))
)

# =============================================================================
# OSS presign configuration
# =============================================================================

OSS_ENDPOINT = os.environ.get("OSS_ENDPOINT")
OSS_PUBLIC_ENDPOINT = os.environ.get("OSS_PUBLIC_ENDPOINT")
OSS_BUCKET = os.environ.get("OSS_BUCKET")
OSS_ACCESS_KEY_ID = os.environ.get("OSS_ACCESS_KEY_ID")
OSS_ACCESS_KEY_SECRET = os.environ.get("OSS_ACCESS_KEY_SECRET")
OSS_OBJECT_PREFIX = os.environ.get("OSS_OBJECT_PREFIX", "output")
DOWNLOAD_VIA_OSS = os.environ.get("DOWNLOAD_VIA_OSS", "1") not in {
    "0",
    "false",
    "False",
    "",
}
STATIC_VIA_OSS = os.environ.get("STATIC_VIA_OSS", "1") not in {
    "0",
    "false",
    "False",
    "",
}
OSS_STATIC_REQUIRE_READY = os.environ.get("OSS_STATIC_REQUIRE_READY", "1") not in {
    "0",
    "false",
    "False",
    "",
}
OSS_STATIC_READY_PROBE_ATTEMPTS = int(
    os.environ.get("OSS_STATIC_READY_PROBE_ATTEMPTS", "3")
)
OSS_STATIC_READY_PROBE_DELAY_SECONDS = float(
    os.environ.get("OSS_STATIC_READY_PROBE_DELAY_SECONDS", "0.15")
)
OSS_PRESIGN_EXPIRES = int(os.environ.get("OSS_PRESIGN_EXPIRES", "900"))
OSS_STATIC_PRESIGN_EXPIRES = int(os.environ.get("OSS_STATIC_PRESIGN_EXPIRES", "3600"))


# =============================================================================
# IndexTTS2 configuration
# =============================================================================

INDEXTTS2_PROVIDER = (
    os.environ.get("INDEXTTS2_PROVIDER", "newapi").strip().lower() or "newapi"
)
if INDEXTTS2_PROVIDER not in {"newapi", "fal"}:
    INDEXTTS2_PROVIDER = "newapi"
FAL_API_KEY = os.environ.get("FAL_API_KEY", "") or os.environ.get("FAL_KEY", "")
INDEXTTS2_FAL_ENDPOINT = os.environ.get(
    "INDEXTTS2_FAL_ENDPOINT",
    "https://fal.run/fal-ai/index-tts-2/text-to-speech",
)
INDEXTTS2_TIMEOUT_SECONDS = float(os.environ.get("INDEXTTS2_TIMEOUT_SECONDS", "1800"))

NEWAPI_BASE_URL = os.environ.get("NEWAPI_BASE_URL", "")
NEWAPI_API_KEY = os.environ.get("NEWAPI_API_KEY", "")


def get_effective_newapi_gateway_config():
    """Return the selected NewAPI runtime gateway credentials."""
    from novelvideo.model_gateway_settings import get_effective_newapi_config

    return get_effective_newapi_config(
        official_base_url=OFFICIAL_NEWAPI_BASE_URL,
        official_api_key=NEWAPI_API_KEY,
    )


def get_newapi_runtime_credentials(
    *,
    api_key_override: str | None = None,
    base_url_override: str | None = None,
    env_api_key: str = "NEWAPI_API_KEY",
    env_base_url: str = "NEWAPI_BASE_URL",
) -> tuple[str, str]:
    """Resolve NewAPI credentials from the edition's effective gateway.

    CE reads dynamic credentials from settings.db and never falls back to the
    process environment. EE's deployment-time gateway remains environment
    backed. Explicit per-call overrides remain available for isolated tools.
    """

    gateway = get_effective_newapi_gateway_config()
    environment_backed = gateway.source == "environment"
    api_key = (
        str(api_key_override or "").strip()
        or str(gateway.api_key or "").strip()
        or (
            os.environ.get(env_api_key, "").strip()
            or NEWAPI_API_KEY
            or os.environ.get("MODEL_API_KEY", "").strip()
            or os.environ.get("OPENAI_API_KEY", "").strip()
            if environment_backed
            else ""
        )
    )
    base_url = (
        str(base_url_override or "").strip().rstrip("/")
        or str(gateway.base_url or "").strip()
        or (
            os.environ.get(env_base_url, "").strip().rstrip("/")
            or str(NEWAPI_BASE_URL or "").strip().rstrip("/")
            or os.environ.get("MODEL_BASE_URL", "").strip().rstrip("/")
            or OFFICIAL_NEWAPI_BASE_URL
            if environment_backed
            else ""
        )
    )
    return api_key, base_url


INDEXTTS2_NEWAPI_MODEL = os.environ.get("INDEXTTS2_NEWAPI_MODEL", "index-tts-2")
INDEXTTS2_RECORD_PROVIDER = "newapi" if INDEXTTS2_PROVIDER == "newapi" else "fal.ai"
INDEXTTS2_RECORD_MODEL = (
    INDEXTTS2_NEWAPI_MODEL if INDEXTTS2_PROVIDER == "newapi" else "IndexTTS2"
)
NEWAPI_IMAGE_MODEL = os.environ.get("NEWAPI_IMAGE_MODEL", "LingShan-G2")
NEWAPI_NANOBANANA2_MODEL = os.environ.get("NEWAPI_NANOBANANA2_MODEL", "LingShan-NB-2")
# Dev-only bridge to a local WebAI-to-API Gemini server (no OpenAI Images API,
# only /chat/completions returning an `artifacts[].url`; see nanobanana_grid.py
# `_call_webai_chat_image_api`). Never used by the hosted gateway.
GEMINI_WEBAI_MODEL = os.environ.get("GEMINI_WEBAI_MODEL", "gemini6969")
GEMINI_WEBAI_COOKIE_FILE = os.environ.get("GEMINI_WEBAI_COOKIE_FILE", "")
GEMINI_WEBAI_TIMEOUT_SECONDS = _env_float("GEMINI_WEBAI_TIMEOUT_SECONDS", 180.0)
# Dev-only: DashScope's native Qwen-Image API (image generation has no
# OpenAI-compatible endpoint, only `multimodal-generation/generation`; see
# nanobanana_grid.py `_call_qwen_image_api`). QWEN_API_KEY is also used by
# the `DC-qwen-vision` NewAPI channel (text/vision), unrelated to this.
QWEN_API_KEY = os.environ.get("QWEN_API_KEY", "")
QWEN_IMAGE_BASE_URL = os.environ.get(
    "QWEN_IMAGE_BASE_URL", "https://dashscope-intl.aliyuncs.com/api/v1"
)
QWEN_IMAGE_TIMEOUT_SECONDS = _env_float("QWEN_IMAGE_TIMEOUT_SECONDS", 180.0)
# Dev-only: RunPod Serverless endpoint from the `photoreal-short-drama-generator`
# project, running ComfyUI + Qwen-Image 2.1 (not DashScope — a different Qwen
# image stack with its own worker, see nanobanana_grid.py
# `_call_runpod_qwen_image_api`). The worker only accepts/returns files via
# Cloudflare R2 (no base64 path), so this needs its own R2 bucket config,
# independent of any other R2/S3 usage elsewhere in the app.
RUNPOD_API_KEY = os.environ.get("RUNPOD_API_KEY", "")
RUNPOD_QWEN_IMAGE_ENDPOINT_ID = os.environ.get("RUNPOD_QWEN_IMAGE_ENDPOINT_ID", "")
RUNPOD_QWEN_IMAGE_TIMEOUT_SECONDS = _env_float(
    "RUNPOD_QWEN_IMAGE_TIMEOUT_SECONDS", 1500.0
)
RUNPOD_QWEN_IMAGE_UNET = os.environ.get(
    "RUNPOD_QWEN_IMAGE_UNET", "qwen_image_2.1_int8_convrot.safetensors"
)
RUNPOD_QWEN_IMAGE_TEXT_ENCODER = os.environ.get(
    "RUNPOD_QWEN_IMAGE_TEXT_ENCODER", "qwen3vl_8b_int8_convrot.safetensors"
)
RUNPOD_QWEN_IMAGE_VAE = os.environ.get(
    "RUNPOD_QWEN_IMAGE_VAE", "qwen_image_2.1_vae_bf16.safetensors"
)
# How long the endpoint lets a worker sit idle before scaling back to 0 — used
# by the Settings "start worker" control (runpod_worker_control.py), not by
# image generation itself.
RUNPOD_QWEN_IMAGE_IDLE_TIMEOUT_SECONDS = int(
    _env_float("RUNPOD_QWEN_IMAGE_IDLE_TIMEOUT_SECONDS", 90.0)
)
R2_ENDPOINT = os.environ.get("R2_ENDPOINT", "")
R2_BUCKET = os.environ.get("R2_BUCKET", "")
R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "")


def _runpod_qwen_image_configured() -> bool:
    return bool(
        RUNPOD_API_KEY
        and RUNPOD_QWEN_IMAGE_ENDPOINT_ID
        and R2_ENDPOINT
        and R2_BUCKET
        and R2_ACCESS_KEY_ID
        and R2_SECRET_ACCESS_KEY
    )


# Dev-only: Qwen-Image-Edit-2511 on the same RunPod endpoint/worker as
# RUNPOD_QWEN_IMAGE_* above, but a genuinely different model family — built on
# the original 20B Qwen-Image architecture with a Qwen2.5-VL-7B text encoder,
# not Qwen-Image-2.1's 7B/Qwen3-VL-8B pair, so it needs its own UNET/text
# encoder/VAE files (none shared with RUNPOD_QWEN_IMAGE_*) and its own ComfyUI
# node family (TextEncodeQwenImageEditPlus + Flux-Kontext nodes, not
# TextEncodeQwenImage21/QwenImage21Cache). See nanobanana_grid.py
# `_call_runpod_qwen_edit_image_api`. Used only for the "render" stage
# (compositing a character identity onto an existing sketch) — verified
# end-to-end 2026-10-14 to reliably preserve the sketch's pose/composition
# while applying the character's identity, unlike Qwen-Image-2.1's edit mode
# for this same task (see CLAUDE.md).
RUNPOD_QWEN_EDIT_UNET = os.environ.get(
    "RUNPOD_QWEN_EDIT_UNET", "qwen_image_edit_2511_int8_convrot.safetensors"
)
RUNPOD_QWEN_EDIT_TEXT_ENCODER = os.environ.get(
    "RUNPOD_QWEN_EDIT_TEXT_ENCODER", "qwen_2.5_vl_7b_fp8_scaled.safetensors"
)
RUNPOD_QWEN_EDIT_VAE = os.environ.get("RUNPOD_QWEN_EDIT_VAE", "qwen_image_vae.safetensors")


def _runpod_qwen_edit_configured() -> bool:
    return _runpod_qwen_image_configured()


# Dev-only, render-only: Qwen-Image 2.1 (same checkpoint/endpoint as
# RUNPOD_QWEN_IMAGE_* above) used for render/identity-swap, fixing two bugs
# that made the project abandon 2.1 for render on 2026-10-14 (see
# nanobanana_grid.py `_runpod_qwen21_render_image_graph` docstring + CLAUDE.md
# 2026-10-18 entry): (1) the shared sketch/character/scene/prop graph feeds
# KSampler an EmptyLatentImage sized independently of the input image, which
# the official upstream TextEncodeQwenImage21 node's own latent-output
# tooltip warns "shifts the edit" — this path uses that node's own latent
# output instead; (2) the shared render dispatch reused the Gemini-oriented
# storyboard-grid prompt, nonsensical for a single-image edit — this path
# gets its own official-standard prompt (`build_qwen21_render_prompt`,
# `<image1>`/`<image2>` tags, not Edit-2511's "Picture N"). No new model
# files: `_runpod_qwen21_render_configured()` just reuses
# `_runpod_qwen_image_configured()`. Official recipe (ComfyUI template
# `image_qwen_image_2_1_image_edit.json`, fetched 2026-10-18): cfg=1
# (negative prompt unused at cfg=1), steps 40-50 (official pipeline; the
# template itself demos at 25 for speed — kept overridable here for the
# same reason).
RUNPOD_QWEN21_RENDER_STEPS = int(_env_float("RUNPOD_QWEN21_RENDER_STEPS", 40.0))
RUNPOD_QWEN21_RENDER_CFG = _env_float("RUNPOD_QWEN21_RENDER_CFG", 1.0)
RUNPOD_QWEN21_RENDER_IMAGE_SIZE = os.environ.get("RUNPOD_QWEN21_RENDER_IMAGE_SIZE", "1K")
# Masked multi-character inpaint pass ONLY (not the single-character `full`
# path, not `scene_only` — both already verified working well at cfg=1/no
# negative prompt). Added 2026-10-18 after a real test (BabyStories beat 7)
# showed two toddler characters rendered as unrelated adults — the official
# template's own note says cfg=1 works specifically "because negative_prompt
# is unused while cfg is 1" and to raise cfg only once a real negative
# prompt is added; at cfg=1 there is ~no classifier-free guidance pushing
# the masked region away from "generic adult consistent with the rest of
# the already-generated scene" and toward a reference identity that looks
# very different (e.g. a toddler). See nanobanana_grid.py
# `_runpod_qwen21_render_image_graph` and CLAUDE.md 2026-10-18 entry.
RUNPOD_QWEN21_RENDER_INPAINT_CFG = _env_float("RUNPOD_QWEN21_RENDER_INPAINT_CFG", 3.0)
RUNPOD_QWEN21_RENDER_INPAINT_NEGATIVE_PROMPT = os.environ.get(
    "RUNPOD_QWEN21_RENDER_INPAINT_NEGATIVE_PROMPT",
    "adult, wrong age, mismatched body proportions, inconsistent identity, generic unrelated person",
)

# Sketch-free "compose" mode (`runpod_qwen21_compose`, 2026-10-18): the
# scene master background photo has its own aspect ratio (often 16:9,
# landscape) which generally does not match the project's render aspect
# ratio (e.g. 2:3, portrait, for a vertical-video project) — unlike the
# sketch+mask path, there is no sketch file here to naturally pin the
# output's aspect. Default ON: center-crop the scene master to the
# project's render mode aspect ratio before using it as `image_1`, so the
# output stays consistent with what the downstream video step expects, at
# the cost of losing some background width/resolution. Confirmed with the
# user before implementing (2026-10-18) — toggle off only if this turns
# out to hurt quality more than aspect-mismatch would.
RUNPOD_QWEN21_COMPOSE_CROP_TO_MODE_ASPECT = _env_bool(
    "RUNPOD_QWEN21_COMPOSE_CROP_TO_MODE_ASPECT", True
)


def _runpod_qwen21_render_configured() -> bool:
    return _runpod_qwen_image_configured()


# Dev-only: MiniMax-H3 video on the same RunPod endpoint/R2 bucket as
# RUNPOD_QWEN_IMAGE_* (`a31613hf7l83r5`, RunPod display name
# "qwen-t2i-h3-i2v-ref2va" since 2026-10-18 — was "photoreal-drama-h3", id
# unchanged) — the only H3
# path verified end-to-end (first frame + character-card reference images +
# <d>[Vietnamese] dialogue + PDD 8-step acceleration + R2 mp4 with muxed
# audio; see `movies/NgoaiTinhCongSo` in the photoreal project and
# `.claude/CLAUDE.md`). Model files below come from that project's
# `scripts/settings.json`; ported graph lives in `runpod_minimax_h3_video.py`.
RUNPOD_H3_VIDEO_ENDPOINT_ID = os.environ.get(
    "RUNPOD_H3_VIDEO_ENDPOINT_ID", RUNPOD_QWEN_IMAGE_ENDPOINT_ID
)
RUNPOD_H3_VIDEO_TIMEOUT_SECONDS = _env_float("RUNPOD_H3_VIDEO_TIMEOUT_SECONDS", 2400.0)
RUNPOD_H3_UNET_REF2VA = os.environ.get(
    "RUNPOD_H3_UNET_REF2VA", "minimax_h3_ref2va_pruned_int8_convrot.safetensors"
)
RUNPOD_H3_UNET_FL2VA = os.environ.get(
    "RUNPOD_H3_UNET_FL2VA", "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
)
RUNPOD_H3_TEXT_ENCODER = os.environ.get(
    "RUNPOD_H3_TEXT_ENCODER", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
)
RUNPOD_H3_VIDEO_VAE = os.environ.get(
    "RUNPOD_H3_VIDEO_VAE", "minimax_h3_video_vae_fp16.safetensors"
)
RUNPOD_H3_AUDIO_VAE = os.environ.get(
    "RUNPOD_H3_AUDIO_VAE", "minimax_h3_audio_vae_fp32.safetensors"
)
# PDD acceleration (8-step) — only applies to ref2va; fl2va always runs the
# base 20-step res_multistep/simple schedule (no PDD file exists for it).
RUNPOD_H3_PDD_REF2VA = os.environ.get(
    "RUNPOD_H3_PDD_REF2VA", "MiniMax-H3-Ref2VA-Acc-8Step.safetensors"
)


def _runpod_h3_video_configured() -> bool:
    return bool(
        RUNPOD_API_KEY
        and RUNPOD_H3_VIDEO_ENDPOINT_ID
        and R2_ENDPOINT
        and R2_BUCKET
        and R2_ACCESS_KEY_ID
        and R2_SECRET_ACCESS_KEY
    )


SCENE_MASTER_IMAGE_PROVIDER = (
    os.environ.get("SCENE_MASTER_IMAGE_PROVIDER", "").strip().lower() or "newapi"
)
SCENE_MASTER_IMAGE_MODEL = os.environ.get("SCENE_MASTER_IMAGE_MODEL", "")
SCENE_REVERSE_MASTER_IMAGE_PROVIDER = (
    os.environ.get("SCENE_REVERSE_MASTER_IMAGE_PROVIDER", "").strip().lower()
    or "newapi"
)
SCENE_REVERSE_MASTER_IMAGE_MODEL = os.environ.get(
    "SCENE_REVERSE_MASTER_IMAGE_MODEL", ""
)
SCENE_360_IMAGE_PROVIDER = (
    os.environ.get("SCENE_360_IMAGE_PROVIDER", "").strip().lower() or "newapi"
)
SCENE_360_IMAGE_MODEL = os.environ.get("SCENE_360_IMAGE_MODEL", "")
PROP_REF_IMAGE_PROVIDER = (
    os.environ.get("PROP_REF_IMAGE_PROVIDER", "").strip().lower() or "newapi"
)
PROP_REF_IMAGE_MODEL = os.environ.get("PROP_REF_IMAGE_MODEL", "")


# =============================================================================
# Volcano Engine image generation configuration
# =============================================================================

VOLCENGINE_VISUAL_API_KEY = os.environ.get(
    "VOLCENGINE_VISUAL_API_KEY"
) or os.environ.get("ARK_API_KEY")
VOLCENGINE_VISUAL_ENDPOINT = os.environ.get(
    "VOLCENGINE_VISUAL_ENDPOINT", "https://ark.cn-beijing.volces.com/api/v3"
)

SEEDREAM_MODEL = os.environ.get("SEEDREAM_MODEL", "doubao-seedream-4-5-251128")
SEEDEDIT_MODEL = os.environ.get("SEEDEDIT_MODEL", "doubao-seededit-3-0-i2i-250628")

IMAGE_DEFAULT_WIDTH = int(os.environ.get("IMAGE_DEFAULT_WIDTH", "1440"))
IMAGE_DEFAULT_HEIGHT = int(os.environ.get("IMAGE_DEFAULT_HEIGHT", "2560"))
IMAGE_DEFAULT_STYLE = os.environ.get("IMAGE_DEFAULT_STYLE", "chinese_period_drama")

# Model selection for character reference image generation
# "nanobanana" - use Nano Banana Pro (Gemini), the same model as grid generation, for better consistency
# "seedream" - use Seedream 4.5 (Volcano Engine), high quality but a different model from grid generation
CHARACTER_IMAGE_MODEL = os.environ.get("CHARACTER_IMAGE_MODEL", "nanobanana")

# Style presets are provided uniformly by src/novelvideo/styles/presets/*.json.


def get_style_preset(
    style: str = None,
    *,
    username: str | None = None,
    project: str | None = None,
    project_dir: str | None = None,
    state_dir: str | Path | None = None,
) -> dict:
    """Get the visual style preset configuration.

    Args:
        style: style name; defaults to IMAGE_DEFAULT_STYLE

    Returns:
        Style preset dict
    """
    style = style or IMAGE_DEFAULT_STYLE

    from novelvideo.services.style_service import StyleService

    config = StyleService.get_style(
        style,
        username=username,
        project=project,
        project_dir=project_dir,
        state_dir=state_dir,
    )
    if not config:
        raise KeyError(f"Style '{style}' not found")
    return config.to_legacy_dict()


# =============================================================================
# Temporary LLM media relay (lets newAPI / vision models fetch local reference images)
# =============================================================================

MEDIA_RELAY_PROVIDER = (
    os.environ.get("MEDIA_RELAY_PROVIDER", "aliyun_oss").strip().lower()
)
MEDIA_RELAY_TTL_SECONDS = int(os.environ.get("MEDIA_RELAY_TTL_SECONDS", "1800"))

OSS_RELAY_ENDPOINT = os.environ.get("OSS_RELAY_ENDPOINT", "oss-cn-chengdu.aliyuncs.com")
OSS_RELAY_BUCKET = os.environ.get("OSS_RELAY_BUCKET", "claymore-llm-relay")
OSS_RELAY_AK = os.environ.get("OSS_RELAY_AK", "")
OSS_RELAY_SK = os.environ.get("OSS_RELAY_SK", "")

CLOUDINARY_RELAY_CLOUD_NAME = os.environ.get("CLOUDINARY_RELAY_CLOUD_NAME", "")
CLOUDINARY_RELAY_API_KEY = os.environ.get("CLOUDINARY_RELAY_API_KEY", "")
CLOUDINARY_RELAY_API_SECRET = os.environ.get("CLOUDINARY_RELAY_API_SECRET", "")
CLOUDINARY_RELAY_FOLDER = os.environ.get("CLOUDINARY_RELAY_FOLDER", "")


def get_style_labels() -> dict[str, str]:
    """Get the style ID -> display label mapping.

    Returns:
        {style_id: label} dict
    """
    from novelvideo.services.style_service import StyleService

    return StyleService.get_style_labels()


def list_available_styles() -> list[dict]:
    """List all available styles (presets + custom).

    Returns:
        Style list; each item contains {id, name, label, type}
    """
    from novelvideo.services.style_service import StyleService

    return StyleService.list_all_styles()


def get_image_config() -> dict:
    """Get the image generation configuration."""
    from novelvideo.services.style_service import StyleService

    all_styles = StyleService.list_all_styles()
    style_presets = {
        s["id"]: StyleService.get_legacy_style_preset(s["id"]) for s in all_styles
    }

    return {
        "api_key": VOLCENGINE_VISUAL_API_KEY,
        "endpoint": VOLCENGINE_VISUAL_ENDPOINT,
        "seedream_model": SEEDREAM_MODEL,
        "seededit_model": SEEDEDIT_MODEL,
        "default_width": IMAGE_DEFAULT_WIDTH,
        "default_height": IMAGE_DEFAULT_HEIGHT,
        "default_style": IMAGE_DEFAULT_STYLE,
        "style_presets": style_presets,
        "character_image_model": CHARACTER_IMAGE_MODEL,
        "character_image_selection": get_character_image_selection(),
    }


def get_character_image_model() -> str:
    """Get the character reference image generation model type.

    Returns:
        "nanobanana" or "seedream"
    """
    return CHARACTER_IMAGE_MODEL


# =============================================================================
# TTS configuration
# =============================================================================

TTS_PROVIDER = os.environ.get("TTS_PROVIDER", "cosyvoice")  # defaults to CosyVoice
EDGE_TTS_VOICE = os.environ.get("EDGE_TTS_VOICE", "en-US-AriaNeural")
VOLCENGINE_TTS_ENDPOINT = os.environ.get(
    "VOLCENGINE_TTS_ENDPOINT", "https://openspeech.bytedance.com/api/v1/tts"
)

# CosyVoice configuration (Alibaba Cloud DashScope)
COSYVOICE_MODEL = os.environ.get("COSYVOICE_MODEL", "cosyvoice-v3-flash")
COSYVOICE_VOICE = os.environ.get("COSYVOICE_VOICE", "longxiaoxia_v3")
DASHSCOPE_API_KEY = os.environ.get("DASHSCOPE_API_KEY")

# CosyVoice speech-rate multiplier (range [0.5, 2.0]; 1.0 is standard speed)
COSYVOICE_SPEECH_RATE = float(os.environ.get("COSYVOICE_SPEECH_RATE", "1.2"))

# TTS pace estimate in spoken words per second (narration, accelerated).
TTS_WORDS_PER_SECOND = float(os.environ.get("TTS_WORDS_PER_SECOND", "3.0"))

# Dialogue beat TTS configuration (character lines use a different speech rate)
COSYVOICE_DIALOGUE_SPEECH_RATE = float(
    os.environ.get("COSYVOICE_DIALOGUE_SPEECH_RATE", "1.0")
)
TTS_DIALOGUE_WORDS_PER_SECOND = float(
    os.environ.get("TTS_DIALOGUE_WORDS_PER_SECOND", "2.5")
)


def get_tts_config() -> dict:
    """Get the TTS configuration."""
    return {
        "provider": TTS_PROVIDER,
        # Edge TTS
        "default_voice": EDGE_TTS_VOICE,
        "rate": os.environ.get("TTS_RATE", "+0%"),
        "pitch": os.environ.get("TTS_PITCH", "+0Hz"),
        "volcengine_endpoint": VOLCENGINE_TTS_ENDPOINT,
        "volcengine_api_key": VOLCENGINE_VISUAL_API_KEY,
        # CosyVoice
        "cosyvoice_model": COSYVOICE_MODEL,
        "cosyvoice_voice": COSYVOICE_VOICE,
        "cosyvoice_speech_rate": COSYVOICE_SPEECH_RATE,
        "dashscope_api_key": DASHSCOPE_API_KEY,
    }


# =============================================================================
# Fish Audio S2 configuration (emotional speech synthesis)
# =============================================================================

FISH_AUDIO_API_KEY = os.environ.get("FISH_AUDIO_API_KEY")
FISH_AUDIO_SPEED = float(os.environ.get("FISH_AUDIO_SPEED", "1.0"))

# Fish Audio voice presets (8 kinds: age_group x gender)
FISH_VOICE_PRESETS = {
    "child_male": os.environ.get("FISH_VOICE_CHILD_MALE", ""),
    "child_female": os.environ.get("FISH_VOICE_CHILD_FEMALE", ""),
    "youth_male": os.environ.get("FISH_VOICE_YOUTH_MALE", ""),
    "youth_female": os.environ.get("FISH_VOICE_YOUTH_FEMALE", ""),
    "middle_male": os.environ.get("FISH_VOICE_MIDDLE_MALE", ""),
    "middle_female": os.environ.get("FISH_VOICE_MIDDLE_FEMALE", ""),
    "elder_male": os.environ.get("FISH_VOICE_ELDER_MALE", ""),
    "elder_female": os.environ.get("FISH_VOICE_ELDER_FEMALE", ""),
}


def get_fish_voice_id(age_group: str, gender: str) -> str:
    """Get the preset voice ID by age group + gender.

    The two extraction paths write gender differently: the legacy character-completion prompt asks for "male/female"
    in a localized form, while the structured_v1 extractor asks for ``male``/``female``. Recognizing only one spelling would give every
    female character of a structured project a male voice, so both spellings are recognized.
    """
    text = str(gender or "").strip().lower()
    gender_key = "female" if ("nữ" in text or "female" in text) else "male"
    return FISH_VOICE_PRESETS.get(f"{age_group}_{gender_key}", "")


# =============================================================================
# Video composition configuration
# =============================================================================

FFMPEG_PATH = os.environ.get("FFMPEG_PATH", "ffmpeg")
VIDEO_FPS = int(os.environ.get("VIDEO_FPS", "30"))
VIDEO_WIDTH = int(os.environ.get("VIDEO_WIDTH", "1080"))
VIDEO_HEIGHT = int(os.environ.get("VIDEO_HEIGHT", "1920"))
VIDEO_CODEC = os.environ.get("VIDEO_CODEC", "libx264")
VIDEO_AUDIO_CODEC = os.environ.get("VIDEO_AUDIO_CODEC", "aac")
VIDEO_BITRATE = os.environ.get("VIDEO_BITRATE", "4M")

KEN_BURNS_ZOOM_RANGE = (1.0, 1.15)
KEN_BURNS_PAN_SPEED = 0.02

# =============================================================================
# AI video generation configuration (image-to-video)
# =============================================================================


def _csv_env(name: str, default: str) -> list[str]:
    values = [item.strip() for item in os.environ.get(name, default).split(",")]
    return [item for item in values if item]


# newAPI video gateway. When VIDEO_BACKEND uses newapi_<model>, calls go through NEWAPI_BASE_URL.
NEWAPI_VIDEO_MODELS = _csv_env(
    "NEWAPI_VIDEO_MODELS",
    "seedance-1.0-pro-fast,seedance-1.5-pro,seedance-2.0,seedance-2.0-fast,seedance-2.0-value,seedance-2.0-fast-value,happyhorse-1.0,seedance-2.0-mini",
)
DEFAULT_VIDEO_MODEL = os.environ.get(
    "DEFAULT_VIDEO_MODEL",
    os.environ.get("NEWAPI_VIDEO_MODEL", NEWAPI_VIDEO_MODELS[0]),
).strip()
NEWAPI_VIDEO_MODEL = os.environ.get("NEWAPI_VIDEO_MODEL", DEFAULT_VIDEO_MODEL).strip()
NEWAPI_VIDEO_RESOLUTION = os.environ.get("NEWAPI_VIDEO_RESOLUTION", "720p")
NEWAPI_VIDEO_AUDIO_MODELS = _csv_env(
    "NEWAPI_VIDEO_AUDIO_MODELS",
    "seedance-1.5-pro,seedance-2.0,seedance-2.0-fast,seedance-2.0-value,seedance-2.0-fast-value,seedance-2.0-mini",
)
NEWAPI_VIDEO_DURATION_BOUNDS = os.environ.get(
    "NEWAPI_VIDEO_DURATION_BOUNDS",
    "seedance-1.0-pro-fast:2-12,seedance-1.5-pro:4-12,seedance-2.0:4-15,seedance-2.0-fast:4-15,seedance-2.0-value:4-15,seedance-2.0-fast-value:4-15,happyhorse-1.0:3-15,seedance-2.0-mini:4-15",
).strip()

# Video generation backend: newapi_seedance-1.0-pro-fast (default), newapi_seedance-2.0-fast,
# comfyui, seedance_fast, seedance_pro, seedance_pro_silent, grok_720
VIDEO_BACKEND = os.environ.get("VIDEO_BACKEND", f"newapi_{DEFAULT_VIDEO_MODEL}")

# Seedance models (Volcano Ark)
SEEDANCE_FAST_MODEL = os.environ.get(
    "SEEDANCE_FAST_MODEL", "doubao-seedance-1-0-pro-fast-251015"
)
SEEDANCE_PRO_MODEL = os.environ.get(
    "SEEDANCE_PRO_MODEL", "doubao-seedance-1-5-pro-251215"
)

# HuiMeng video aggregation API
HUIMENGI_BASE_URL = os.environ.get("HUIMENGI_BASE_URL", "https://api.huimengi.com")
HUIMENGI_VIDEO_RESOLUTION = os.environ.get("HUIMENGI_VIDEO_RESOLUTION", "720p")
HUIMENGI_VIDEO_GENERATE_AUDIO = os.environ.get(
    "HUIMENGI_VIDEO_GENERATE_AUDIO", "false"
).lower() in ("true", "1", "yes")

# ComfyUI local video generation service
COMFYUI_VIDEO_URL = os.environ.get("COMFYUI_VIDEO_URL", "http://localhost:9527")

# ComfyUI workflow type: gguf (low VRAM, ~8GB) or fp8 (high quality, ~16GB)
# - gguf: uses GGUF-quantized models, suited to GPUs with less VRAM
# - fp8: uses fp8-precision models, better quality, supports FLF (first/last frame) mode
COMFYUI_WORKFLOW = os.environ.get("COMFYUI_WORKFLOW", "gguf")

# Whether ComfyUI uses SSL (HTTPS/WSS); cloud servers usually need it enabled
COMFYUI_USE_SSL = os.environ.get("COMFYUI_USE_SSL", "false").lower() in (
    "true",
    "1",
    "yes",
)

# Default video resolution (portrait)
VIDEO_RESOLUTION = os.environ.get("VIDEO_RESOLUTION", "720x1280")

# Resolution presets
VIDEO_RESOLUTION_PRESETS = {
    "720x1280": {"width": 720, "height": 1280, "label": "720p portrait"},
    "1080x1920": {"width": 1080, "height": 1920, "label": "1080p portrait"},
}


def get_video_generation_config() -> dict:
    """Get the AI video generation (image-to-video) configuration."""
    resolution = VIDEO_RESOLUTION_PRESETS.get(
        VIDEO_RESOLUTION, VIDEO_RESOLUTION_PRESETS["720x1280"]
    )
    return {
        "backend": VIDEO_BACKEND,
        "huimengi_base_url": HUIMENGI_BASE_URL,
        "huimengi_video_resolution": HUIMENGI_VIDEO_RESOLUTION,
        "newapi_base_url": NEWAPI_BASE_URL,
        "newapi_video_models": list(NEWAPI_VIDEO_MODELS),
        "newapi_video_model": NEWAPI_VIDEO_MODEL,
        "newapi_video_resolution": NEWAPI_VIDEO_RESOLUTION,
        "comfyui_url": COMFYUI_VIDEO_URL,
        "comfyui_workflow": COMFYUI_WORKFLOW,
        "comfyui_use_ssl": COMFYUI_USE_SSL,
        "resolution": VIDEO_RESOLUTION,
        "width": resolution["width"],
        "height": resolution["height"],
        "resolution_presets": VIDEO_RESOLUTION_PRESETS,
    }


def get_video_config() -> dict:
    """Get the video configuration."""
    return {
        "ffmpeg_path": FFMPEG_PATH,
        "fps": VIDEO_FPS,
        "width": VIDEO_WIDTH,
        "height": VIDEO_HEIGHT,
        "codec": VIDEO_CODEC,
        "audio_codec": VIDEO_AUDIO_CODEC,
        "bitrate": VIDEO_BITRATE,
        "ken_burns_zoom_range": KEN_BURNS_ZOOM_RANGE,
        "ken_burns_pan_speed": KEN_BURNS_PAN_SPEED,
    }


# =============================================================================
# Image generation configuration (Google / OpenRouter / OpenAI / HuiMeng)
# =============================================================================

GOOGLE_AI_API_KEY = os.environ.get("GOOGLE_AI_API_KEY")
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
HUIMENGI_API_KEY = os.environ.get("HUIMENGI_API_KEY")
OPENROUTER_GPT_IMAGE2_MODEL = os.environ.get(
    "OPENROUTER_GPT_IMAGE2_MODEL", "openai/gpt-5.4-image-2"
)
OPENROUTER_NANOBANANA2_MODEL = os.environ.get(
    "OPENROUTER_NANOBANANA2_MODEL", "google/gemini-3.1-flash-image-preview"
)

# Image generation Provider: "google" / "openrouter" / "openai" / "huimeng"
# OpenRouter price: $0.002/image (2K) vs official Google $0.134/image (2K)
_NANOBANANA_PROVIDER_EXPLICIT = "NANOBANANA_PROVIDER" in os.environ
NANOBANANA_PROVIDER = os.environ.get("NANOBANANA_PROVIDER", "openrouter")


NANOBANANA_MODEL = os.environ.get("NANOBANANA_MODEL", "gemini-3.1-flash-image-preview")
# Cheapest non-deprecated Google AI Studio image model ($0.034/1K image vs
# $0.067 for gemini-3.1-flash-image(-preview)); kept separate from
# NANOBANANA_MODEL since that constant is shared with the openrouter provider.
GOOGLE_AI_IMAGE_MODEL = os.environ.get(
    "GOOGLE_AI_IMAGE_MODEL", "gemini-3.1-flash-lite-image"
)
# Non-lite sibling: supports 1K/2K/4K (lite is 1K-only, rejects 2K/4K with
# 400 INVALID_ARGUMENT), at a higher price ($0.067-$0.151/image vs lite's
# flat $0.034). Used by the resolution-specific google_gemini_* selections.
GOOGLE_AI_IMAGE_MODEL_FULL = os.environ.get(
    "GOOGLE_AI_IMAGE_MODEL_FULL", "gemini-3.1-flash-image"
)
OPENAI_IMAGE_MODEL = os.environ.get("OPENAI_IMAGE_MODEL", "gpt-image-2")
HUIMENG_IMAGE_MODEL = os.environ.get("HUIMENG_IMAGE_MODEL", "image-2")
HUIMENG_IMAGE_OFFICIAL_MODEL = os.environ.get(
    "HUIMENG_IMAGE_OFFICIAL_MODEL", "image-2-official"
)
HUIMENG_NANOBANANA2_MODEL = os.environ.get("HUIMENG_NANOBANANA2_MODEL", "nb-2")
SCENE_360_PROVIDER = os.environ.get("SCENE_360_PROVIDER") or NANOBANANA_PROVIDER
SCENE_360_HUIMENG_MODEL = os.environ.get("SCENE_360_HUIMENG_MODEL", HUIMENG_IMAGE_MODEL)
SCENE_ASSET_PROVIDER = os.environ.get("SCENE_ASSET_PROVIDER") or NANOBANANA_PROVIDER
SCENE_ASSET_MODEL = os.environ.get("SCENE_ASSET_MODEL", "")
OPENAI_IMAGE_QUALITY = os.environ.get("OPENAI_IMAGE_QUALITY", "medium")
OPENAI_SKETCH_IMAGE_QUALITY = os.environ.get("OPENAI_SKETCH_IMAGE_QUALITY", "low")
_DEFAULT_SKETCH_SELECTION_EXPLICIT = "DEFAULT_SKETCH_IMAGE_SELECTION" in os.environ
_DEFAULT_RENDER_SELECTION_EXPLICIT = "DEFAULT_RENDER_IMAGE_SELECTION" in os.environ
DEFAULT_SKETCH_IMAGE_SELECTION = os.environ.get(
    "DEFAULT_SKETCH_IMAGE_SELECTION", "newapi_gpt_image2"
)
DEFAULT_RENDER_IMAGE_SELECTION = os.environ.get(
    "DEFAULT_RENDER_IMAGE_SELECTION", "newapi_gpt_image2"
)
CHARACTER_IMAGE_SELECTION = os.environ.get(
    "CHARACTER_IMAGE_SELECTION"
) or os.environ.get("DEFAULT_CHARACTER_IMAGE_SELECTION")

IMAGE_GENERATION_SELECTIONS: dict[str, dict[str, str]] = {
    "huimeng_gpt_image2": {
        "label": "HuiMeng GPT Image 2",
        "provider": "huimeng",
        "model": HUIMENG_IMAGE_MODEL,
    },
    "huimeng_image2_official": {
        "label": "HuiMeng Image 2 Official",
        "provider": "huimeng",
        "model": HUIMENG_IMAGE_OFFICIAL_MODEL,
    },
    "huimeng_nanobanana2": {
        "label": "HuiMeng NanoBanana 2",
        "provider": "huimeng",
        "model": HUIMENG_NANOBANANA2_MODEL,
    },
    "openai_gpt_image2": {
        "label": "OpenAI GPT Image 2",
        "provider": "openai",
        "model": OPENAI_IMAGE_MODEL,
    },
    "openrouter_gpt_image2": {
        "label": "OpenRouter GPT Image 2",
        "provider": "openrouter",
        "model": OPENROUTER_GPT_IMAGE2_MODEL,
    },
    "openrouter_nanobanana2": {
        "label": "OpenRouter NanoBanana 2",
        "provider": "openrouter",
        "model": OPENROUTER_NANOBANANA2_MODEL,
    },
    "newapi_gpt_image2": {
        "label": "LingShan-G2",
        "provider": "newapi",
        "model": NEWAPI_IMAGE_MODEL,
    },
    "newapi_nanobanana2": {
        "label": "LingShan-NB-2",
        "provider": "newapi",
        "model": NEWAPI_NANOBANANA2_MODEL,
    },
    # Dev-only: local Gemini WebAI bridge, never shown in the hosted-gateway UI.
    "gemini_webai": {
        "label": "Gemini WebAI (local dev)",
        "provider": "gemini_webai",
        "model": GEMINI_WEBAI_MODEL,
    },
    # Dev-only: direct Google AI Studio key, never shown in the hosted-gateway
    # UI. "image_size" here is a forced override (see NanoBananaGridGenerator.
    # force_image_size) — it wins over the grid-shape-driven resolution that
    # other providers use, since resolution is a property of which of these
    # entries was picked, not of the grid mode.
    "google_gemini": {
        "label": "Google Gemini Lite (1K)",
        "provider": "google",
        "model": GOOGLE_AI_IMAGE_MODEL,
        "image_size": "1K",  # the lite model only supports 1K
    },
    "google_gemini_1k": {
        "label": "Google Gemini (1K)",
        "provider": "google",
        "model": GOOGLE_AI_IMAGE_MODEL_FULL,
        "image_size": "1K",
    },
    "google_gemini_2k": {
        "label": "Google Gemini (2K)",
        "provider": "google",
        "model": GOOGLE_AI_IMAGE_MODEL_FULL,
        "image_size": "2K",
    },
    "google_gemini_4k": {
        "label": "Google Gemini (4K)",
        "provider": "google",
        "model": GOOGLE_AI_IMAGE_MODEL_FULL,
        "image_size": "4K",
    },
    # Dev-only: direct DashScope key, never shown in the hosted-gateway UI.
    # No forced "image_size" here — DashScope's native API has no 1K/2K/4K
    # concept, just a pixel-area range ([email protected], [email protected]), so
    # `_call_qwen_image_api` maps the grid-shape-driven size label itself.
    "qwen_image_2": {
        "label": "Qwen Image 2.0 (local dev)",
        "provider": "qwen",
        "model": "qwen-image-2.0",
    },
    "qwen_image_2_pro": {
        "label": "Qwen Image 2.0 Pro (local dev)",
        "provider": "qwen",
        "model": "qwen-image-2.0-pro",
    },
    "qwen_image_3": {
        "label": "Qwen Image 3.0 (local dev)",
        "provider": "qwen",
        "model": "qwen-image-3.0",
    },
    "qwen_image_3_pro": {
        "label": "Qwen Image 3.0 Pro (local dev)",
        "provider": "qwen",
        "model": "qwen-image-3.0-pro",
    },
    # Dev-only: RunPod Serverless worker from the `photoreal-short-drama-
    # generator` project (ComfyUI + Qwen-Image 2.1, not DashScope — see
    # `_call_runpod_qwen_image_api`). "image_size" here is a forced override
    # (same mechanism as google_gemini_1k/2k/4k) mapped to a target pixel
    # area by `_runpod_qwen_image_dims`, since ComfyUI's own EmptyLatentImage
    # takes explicit width/height, not a size label. "auto" leaves it unset
    # so the grid-shape-driven resolution (force_image_size unset) applies.
    "runpod_qwen_image": {
        "label": "Qwen Image 2.1 RunPod (auto)",
        "provider": "runpod_qwen",
        "model": "qwen-image-2.1",
    },
    "runpod_qwen_image_0_5k": {
        "label": "Qwen Image 2.1 RunPod (0.5K)",
        "provider": "runpod_qwen",
        "model": "qwen-image-2.1",
        "image_size": "0.5K",
    },
    "runpod_qwen_image_1k": {
        "label": "Qwen Image 2.1 RunPod (1K)",
        "provider": "runpod_qwen",
        "model": "qwen-image-2.1",
        "image_size": "1K",
    },
    "runpod_qwen_image_1_5k": {
        "label": "Qwen Image 2.1 RunPod (1.5K)",
        "provider": "runpod_qwen",
        "model": "qwen-image-2.1",
        "image_size": "1.5K",
    },
    "runpod_qwen_image_2k": {
        "label": "Qwen Image 2.1 RunPod (2K)",
        "provider": "runpod_qwen",
        "model": "qwen-image-2.1",
        "image_size": "2K",
    },
    "runpod_qwen_image_3k": {
        "label": "Qwen Image 2.1 RunPod (3K, chậm ~9-10 phút/ảnh)",
        "provider": "runpod_qwen",
        "model": "qwen-image-2.1",
        "image_size": "3K",
    },
    "runpod_qwen_image_4k": {
        "label": "Qwen Image 2.1 RunPod (4K, rất chậm — VRAM swap, ~20+ phút/ảnh, có thể vượt timeout)",
        "provider": "runpod_qwen",
        "model": "qwen-image-2.1",
        "image_size": "4K",
    },
    # Dev-only, render-only: Qwen-Image-Edit-2511, not Qwen-Image-2.1 — a
    # different checkpoint/node family, see `_runpod_qwen_edit_configured()`.
    # No "image_size" here: the output canvas is the sketch's own size via
    # VAEEncode, not a forced EmptyLatentImage (that's exactly what made the
    # 2.1 render path unreliable — see CLAUDE.md). Not offered for
    # sketch/character/scene/prop: Edit-2511 is an edit model, not a good
    # fit for pure text-to-image generation.
    "runpod_qwen_edit_render": {
        "label": "Qwen Image Edit 2511 RunPod (render only)",
        "provider": "runpod_qwen_edit",
        "model": "qwen-image-edit-2511",
    },
    # Multi-character variant of the entry above: beats with more than one
    # figure in the sketch need a mechanical, not text-prompt, way to pick
    # which figure gets which identity — two single-pass color-in-the-prompt
    # attempts both failed real testing on beat 6 (see
    # `_qwen_edit_multi_character_render` in nanobanana_grid.py and
    # CLAUDE.md). This runs two RunPod calls per detected identity instead
    # of one, so it's roughly 2x the time/cost of `runpod_qwen_edit_render`
    # — kept as a separate selection rather than auto-detecting "multiple
    # figures" so the slower path is opt-in per beat.
    "runpod_qwen_edit_render_multi": {
        "label": "Qwen Image Edit 2511 RunPod (render, multi-character, ~2x thời gian)",
        "provider": "runpod_qwen_edit",
        "model": "qwen-image-edit-2511",
        "multi_character": True,
    },
    # Dev-only, render-only, added 2026-10-18: Qwen-Image 2.1 (same
    # checkpoint/endpoint as `runpod_qwen_image*` above), fixed for
    # render/identity-swap — see `_runpod_qwen21_render_configured()` and
    # `_runpod_qwen21_render_image_graph` in nanobanana_grid.py. 2.5-5x
    # faster per call than Edit-2511 in this project's own measurements, so
    # multi-character beats (sequential scene + N identity passes) have a
    # real chance of finishing inside the 30-minute task timeout where
    # Edit-2511 does not. No "image_size": the latent is sized from the
    # canvas image itself (TextEncodeQwenImage21's own latent output), same
    # reasoning as Edit-2511's VAEEncode-based sizing just above.
    "runpod_qwen21_render": {
        "label": "Qwen Image 2.1 RunPod (render only, nhanh)",
        "provider": "runpod_qwen21_render",
        "model": "qwen-image-2.1",
    },
    # Multi-character variant, same reasoning as runpod_qwen_edit_render_multi
    # above (mechanical two-pass masked inpaint, not a single text-prompt
    # pass) — ported from the Edit-2511 design, same mask-location machinery.
    "runpod_qwen21_render_multi": {
        "label": "Qwen Image 2.1 RunPod (render, multi-character)",
        "provider": "runpod_qwen21_render",
        "model": "qwen-image-2.1",
        "multi_character": True,
    },
    # Dev-only, render-only, added 2026-10-18: sketch-FREE composition —
    # no mannequin-figure sketch, no mask, no 2-pass inpaint at all. Built
    # after the sketch+mask `runpod_qwen21_render_multi` path above fixed
    # render timing and age/body-proportions but still failed to transfer
    # identity faithfully (faces/outfits came out blended). A real-GPU
    # standalone test (not this provider yet, a one-off script) composing
    # directly from the scene's master background photo + each character's
    # identity portrait + each prop's reference photo + the beat's own
    # text (no sketch at all) produced the best result of the day: correct
    # background, near-perfect identity match for 2 characters, an exact
    # prop match, fully photorealistic, correct toddler proportions. This
    # selection formalizes that into the real pipeline — see
    # `_build_qwen21_compose_plan()`/`build_qwen21_compose_prompt()`.
    # Uses the SAME RunPod worker/credential as `runpod_qwen21_render*`
    # above (`_runpod_qwen21_render_configured()`), no new secret.
    "runpod_qwen21_compose": {
        "label": "Qwen Image 2.1 RunPod (render không cần sketch: background + identity)",
        "provider": "runpod_qwen21_compose",
        "model": "qwen-image-2.1",
    },
}

GOOGLE_GEMINI_SELECTION_KEYS = (
    "google_gemini",
    "google_gemini_1k",
    "google_gemini_2k",
    "google_gemini_4k",
)

QWEN_IMAGE_SELECTION_KEYS = (
    "qwen_image_2",
    "qwen_image_2_pro",
    "qwen_image_3",
    "qwen_image_3_pro",
)

RUNPOD_QWEN_IMAGE_SELECTION_KEYS = (
    "runpod_qwen_image",
    "runpod_qwen_image_0_5k",
    "runpod_qwen_image_1k",
    "runpod_qwen_image_1_5k",
    "runpod_qwen_image_2k",
    "runpod_qwen_image_3k",
    "runpod_qwen_image_4k",
)

RUNPOD_QWEN_EDIT_SELECTION_KEYS = (
    "runpod_qwen_edit_render",
    "runpod_qwen_edit_render_multi",
)

RUNPOD_QWEN21_RENDER_SELECTION_KEYS = (
    "runpod_qwen21_render",
    "runpod_qwen21_render_multi",
)

# Sketch-free "compose" mode (2026-10-18) — background + identity + prop
# refs only, no sketch, no mask, no 2-pass inpaint. Deliberately NOT in
# RUNPOD_QWEN21_RENDER_SELECTION_KEYS (that tuple's provider string is
# "runpod_qwen21_render", a different provider than this one) and
# deliberately NOT in RENDER_REVIEW_SELECTION_KEYS below for v1 — the
# review dialog's prompt-rewrite machinery is hardcoded to exactly 2
# images (sketch + 1 identity); this mode's image count varies with the
# beat (1 background + N identities + M props). A free dry-run script
# (see .claude/CLAUDE.md) gives equivalent pre-GPU visibility instead.
RUNPOD_QWEN21_COMPOSE_SELECTION_KEYS = ("runpod_qwen21_compose",)

# Every selection that gets the render-review dialog (dry-run preview, AI
# rewrite, lint) — api/routes/generation.py's render/review and
# qwen-edit-prompt/generate routes dispatch on this, not on either tuple
# alone, so a new render-review-capable provider only needs adding here.
RENDER_REVIEW_SELECTION_KEYS = RUNPOD_QWEN_EDIT_SELECTION_KEYS + RUNPOD_QWEN21_RENDER_SELECTION_KEYS

VISIBLE_IMAGE_GENERATION_SELECTION_KEYS = (
    "newapi_gpt_image2",
    "newapi_nanobanana2",
)

LEGACY_IMAGE_GENERATION_SELECTION_ALIASES = {
    "huimeng_gpt_image2": "newapi_gpt_image2",
    "huimeng_image2_official": "newapi_gpt_image2",
    "openai_gpt_image2": "newapi_gpt_image2",
    "openrouter_gpt_image2": "newapi_gpt_image2",
    "huimeng_nanobanana2": "newapi_nanobanana2",
    "openrouter_nanobanana2": "newapi_nanobanana2",
    "nanobanana": "newapi_nanobanana2",
    "seedream": "newapi_gpt_image2",
}

# Grid generation mode configuration
# Portrait panel modes (each cell is portrait, suited to I2V):
# "1x1" - single image (1K resolution, panel height 1376)
# "1x3" - three cells in a row (panel height 877, portrait 0.78)
# "1x4" - four cells in a row (panel height 1097, portrait 0.58), officially recommended 3-4 panel comic
# "3x2" - 6 panels (panel height 1365 ✓, portrait 0.84)
# "4x3" - 12 panels (panel height 1024 ✓, portrait 0.75), optimal
# "5x4" - 20 panels (panel height 819, portrait 0.70)
# Square panel modes:
# "2x2" - compact four cells
# "3x3" - batched generation (more stable)
# "4x4" - batched generation (medium, panel height 1024 ✓)
# "5x5" - bulk generation, at most 25 panels
GRID_MODE = os.environ.get("GRID_MODE", "1x1")

# Grid size configuration table
# Format: mode -> (rows, cols, batch_size)
MODE_CONFIG = {
    # Portrait panel modes (each cell is portrait, suited to I2V)
    "1x1": (1, 1, 1),
    "1x2": (1, 2, 2),  # panel 0.89 portrait
    "1x3": (1, 3, 3),  # panel 0.78 portrait ✓
    "1x4": (1, 4, 4),  # panel 0.58 portrait ✓ officially recommended
    "3x2": (3, 2, 6),  # panel 0.84 portrait, height 1365 ✓
    "4x3": (4, 3, 12),  # panel 0.75 portrait ✓ optimal
    "5x4": (5, 4, 20),  # panel 0.70 portrait ✓
    # Square panel modes
    "2x2": (2, 2, 4),
    "3x3": (3, 3, 9),
    "4x4": (4, 4, 16),
    "5x5": (5, 5, 25),
}

# Grid size configuration (set automatically from GRID_MODE)
if GRID_MODE in MODE_CONFIG:
    GRID_ROWS, GRID_COLS, GRID_BATCH_SIZE = MODE_CONFIG[GRID_MODE]
else:
    # Default to 1x1
    GRID_ROWS, GRID_COLS, GRID_BATCH_SIZE = 1, 1, 1
GRID_TOTAL_PANELS = 25  # maximum number of panels for dynamic optimization


def image_generation_selection_options() -> dict[str, str]:
    """Return UI labels for configured image-generation selections."""
    options = {
        key: IMAGE_GENERATION_SELECTIONS[key]["label"]
        for key in VISIBLE_IMAGE_GENERATION_SELECTION_KEYS
        if key in IMAGE_GENERATION_SELECTIONS
    }
    # Dev-only entries: only listed once their local credential is configured,
    # same gates as _visible_image_generation_selection(). gemini_webai must be
    # listed here too (not just special-cased in the visibility check) — once
    # any other entry is explicitly picked in the UI, the choice is persisted
    # per-project and there is no way back to gemini_webai unless it is also
    # a selectable menu option.
    if GEMINI_WEBAI_COOKIE_FILE:
        options["gemini_webai"] = IMAGE_GENERATION_SELECTIONS["gemini_webai"]["label"]
    if GOOGLE_AI_API_KEY:
        for key in GOOGLE_GEMINI_SELECTION_KEYS:
            options[key] = IMAGE_GENERATION_SELECTIONS[key]["label"]
    if QWEN_API_KEY:
        for key in QWEN_IMAGE_SELECTION_KEYS:
            options[key] = IMAGE_GENERATION_SELECTIONS[key]["label"]
    if _runpod_qwen_image_configured():
        for key in RUNPOD_QWEN_IMAGE_SELECTION_KEYS:
            options[key] = IMAGE_GENERATION_SELECTIONS[key]["label"]
    if _runpod_qwen_edit_configured():
        for key in RUNPOD_QWEN_EDIT_SELECTION_KEYS:
            options[key] = IMAGE_GENERATION_SELECTIONS[key]["label"]
    if _runpod_qwen21_render_configured():
        for key in RUNPOD_QWEN21_RENDER_SELECTION_KEYS:
            options[key] = IMAGE_GENERATION_SELECTIONS[key]["label"]
        for key in RUNPOD_QWEN21_COMPOSE_SELECTION_KEYS:
            options[key] = IMAGE_GENERATION_SELECTIONS[key]["label"]
    return options


def character_image_selection_options() -> dict[str, str]:
    """Return UI labels for character/identity image generation."""
    return image_generation_selection_options()


def _visible_image_generation_selection(value: str | None) -> str:
    candidate = str(value or "").strip()
    if (
        candidate in VISIBLE_IMAGE_GENERATION_SELECTION_KEYS
        and candidate in IMAGE_GENERATION_SELECTIONS
    ):
        return candidate
    # Dev-only selection: only "visible" on a machine that has actually set up
    # the local WebAI-to-API cookie bridge. Everywhere else it stays unreachable,
    # so it never becomes an accidental fallback.
    if candidate == "gemini_webai" and GEMINI_WEBAI_COOKIE_FILE:
        return candidate
    if candidate in GOOGLE_GEMINI_SELECTION_KEYS and GOOGLE_AI_API_KEY:
        return candidate
    if candidate in QWEN_IMAGE_SELECTION_KEYS and QWEN_API_KEY:
        return candidate
    if candidate in RUNPOD_QWEN_IMAGE_SELECTION_KEYS and _runpod_qwen_image_configured():
        return candidate
    if candidate in RUNPOD_QWEN_EDIT_SELECTION_KEYS and _runpod_qwen_edit_configured():
        return candidate
    if candidate in RUNPOD_QWEN21_RENDER_SELECTION_KEYS and _runpod_qwen21_render_configured():
        return candidate
    if candidate in RUNPOD_QWEN21_COMPOSE_SELECTION_KEYS and _runpod_qwen21_render_configured():
        return candidate
    alias = LEGACY_IMAGE_GENERATION_SELECTION_ALIASES.get(candidate)
    if (
        alias in VISIBLE_IMAGE_GENERATION_SELECTION_KEYS
        and alias in IMAGE_GENERATION_SELECTIONS
    ):
        return alias
    return ""


def _default_image_generation_selection(fallback: str | None = None) -> str:
    for candidate in (
        fallback,
        DEFAULT_SKETCH_IMAGE_SELECTION,
        DEFAULT_RENDER_IMAGE_SELECTION,
        "newapi_gpt_image2",
        *VISIBLE_IMAGE_GENERATION_SELECTION_KEYS,
    ):
        selection = _visible_image_generation_selection(candidate)
        if selection:
            return selection
    raise ValueError("No visible image generation selection configured.")


def normalize_image_generation_selection(
    value: str | None,
    *,
    fallback: str | None = None,
) -> str:
    selection = _visible_image_generation_selection(value)
    if selection:
        return selection
    return _default_image_generation_selection(fallback)


def image_generation_selection_label(
    value: str | None, *, fallback: str | None = None
) -> str:
    selection = normalize_image_generation_selection(value, fallback=fallback)
    return IMAGE_GENERATION_SELECTIONS[selection]["label"]


def get_character_image_selection() -> str:
    """Return the configured character/identity image source selection."""
    candidate = _visible_image_generation_selection(CHARACTER_IMAGE_SELECTION)
    if candidate:
        return candidate

    legacy_model = str(CHARACTER_IMAGE_MODEL or "").strip()
    legacy_selection = _visible_image_generation_selection(legacy_model)
    if legacy_selection:
        return legacy_selection

    return normalize_image_generation_selection(
        DEFAULT_RENDER_IMAGE_SELECTION,
        fallback=DEFAULT_SKETCH_IMAGE_SELECTION,
    )


def normalize_character_image_selection(value: str | None) -> str:
    candidate = _visible_image_generation_selection(value)
    if candidate:
        return candidate
    return get_character_image_selection()


def infer_image_generation_selection(
    provider: str | None,
    model: str | None,
    *,
    fallback: str | None = None,
) -> str:
    provider_norm = str(provider or "").strip().lower()
    model_norm = str(model or "").strip()
    for key, entry in IMAGE_GENERATION_SELECTIONS.items():
        if entry["provider"] == provider_norm and entry["model"] == model_norm:
            return key
    if provider_norm == "openrouter" and model_norm in {
        NANOBANANA_MODEL,
        f"google/{NANOBANANA_MODEL}",
    }:
        return "openrouter_nanobanana2"
    if provider_norm == "huimeng" and model_norm == "image-2":
        return "huimeng_gpt_image2"
    if provider_norm == "huimeng" and model_norm == "image-2-official":
        return "huimeng_image2_official"
    return normalize_image_generation_selection(
        fallback, fallback=DEFAULT_SKETCH_IMAGE_SELECTION
    )


def _image_provider_config(
    provider: str,
    *,
    model_override: str | None = None,
    selection_override: str | None = None,
) -> dict:
    force_image_size: str | None = None
    multi_character = False
    if selection_override:
        selection = normalize_image_generation_selection(selection_override)
        entry = IMAGE_GENERATION_SELECTIONS[selection]
        provider = entry["provider"]
        model = model_override or entry["model"]
        force_image_size = entry.get("image_size")
        multi_character = bool(entry.get("multi_character"))
    else:
        provider = (provider or "openrouter").lower()
        model = model_override or ""

    if provider == "openrouter":
        resolved_model = model or (
            f"google/{NANOBANANA_MODEL}"
            if not NANOBANANA_MODEL.startswith("google/")
            else NANOBANANA_MODEL
        )
        return {
            "provider": provider,
            "api_key": OPENROUTER_API_KEY,
            "model": resolved_model,
            "force_image_size": force_image_size,
        }
    if provider in {"huimeng", "huimengi"}:
        return {
            "provider": "huimeng",
            "api_key": HUIMENGI_API_KEY,
            "model": model or HUIMENG_IMAGE_MODEL,
            "force_image_size": force_image_size,
        }
    if provider == "openai":
        return {
            "provider": provider,
            "api_key": OPENAI_API_KEY,
            "model": model or OPENAI_IMAGE_MODEL,
            "force_image_size": force_image_size,
        }
    if provider == "newapi":
        gateway = get_effective_newapi_gateway_config()
        return {
            "provider": provider,
            "api_key": gateway.api_key,
            "model": model or NEWAPI_IMAGE_MODEL,
            "base_url": gateway.base_url,
            "force_image_size": force_image_size,
        }
    if provider == "gemini_webai":
        gateway = get_effective_newapi_gateway_config()
        return {
            "provider": provider,
            "api_key": gateway.api_key,
            "model": model or GEMINI_WEBAI_MODEL,
            "base_url": gateway.base_url,
            "force_image_size": force_image_size,
        }
    if provider == "qwen":
        return {
            "provider": provider,
            "api_key": QWEN_API_KEY,
            "model": model or "qwen-image-2.0",
            "base_url": QWEN_IMAGE_BASE_URL,
            "force_image_size": force_image_size,
        }
    if provider == "runpod_qwen":
        return {
            "provider": provider,
            "api_key": RUNPOD_API_KEY,
            "model": model or "qwen-image-2.1",
            "base_url": None,
            "force_image_size": force_image_size,
        }
    if provider == "runpod_qwen_edit":
        return {
            "provider": provider,
            "api_key": RUNPOD_API_KEY,
            "model": model or "qwen-image-edit-2511",
            "base_url": None,
            "force_image_size": force_image_size,
            "multi_character": multi_character,
        }
    if provider == "runpod_qwen21_render":
        return {
            "provider": provider,
            "api_key": RUNPOD_API_KEY,
            "model": model or "qwen-image-2.1",
            "base_url": None,
            "force_image_size": force_image_size,
            "multi_character": multi_character,
        }
    if provider == "runpod_qwen21_compose":
        return {
            "provider": provider,
            "api_key": RUNPOD_API_KEY,
            "model": model or "qwen-image-2.1",
            "base_url": None,
        }

    return {
        "provider": "google",
        "api_key": GOOGLE_AI_API_KEY,
        "model": model or NANOBANANA_MODEL,
        "force_image_size": force_image_size,
    }


def get_grid_generation_config(
    selection_override: str | None = None,
    provider_override: str | None = None,
    model_override: str | None = None,
    image_size_override: str | None = None,
) -> dict:
    """Get the grid generation configuration.

    Four Providers are supported:
    - google: direct Google AI Studio (GOOGLE_AI_API_KEY)
    - openrouter: via the OpenRouter proxy (OPENROUTER_API_KEY), 60x lower cost
    - openai: via the OpenAI Image API (OPENAI_API_KEY), default gpt-image-2
    - huimeng: via the HuiMeng Tasks API (HUIMENGI_API_KEY)

    Environment variables:
    - NANOBANANA_PROVIDER: "google" / "openrouter" / "openai" / "huimeng"
    - GOOGLE_AI_API_KEY: Google AI Studio API Key
    - OPENROUTER_API_KEY: OpenRouter API Key
    - OPENAI_API_KEY: OpenAI API Key
    - HUIMENGI_API_KEY: HuiMeng API Key
    - OPENAI_IMAGE_MODEL: OpenAI Image API model, default gpt-image-2
    - HUIMENG_IMAGE_MODEL: HuiMeng image model, default image-2
    - DEFAULT_SKETCH_IMAGE_SELECTION / DEFAULT_RENDER_IMAGE_SELECTION: default image source in the UI
    """
    if (
        selection_override is None
        and provider_override is None
        and _DEFAULT_RENDER_SELECTION_EXPLICIT
    ):
        selection_override = DEFAULT_RENDER_IMAGE_SELECTION

    provider_config = _image_provider_config(
        provider_override or NANOBANANA_PROVIDER,
        model_override=model_override,
        selection_override=selection_override,
    )

    return {
        "provider": provider_config["provider"],
        "api_key": provider_config["api_key"],
        "model": provider_config["model"],
        "base_url": provider_config.get("base_url", ""),
        "openai_image_quality": OPENAI_IMAGE_QUALITY,
        "openai_sketch_image_quality": OPENAI_SKETCH_IMAGE_QUALITY,
        "huimeng_image_quality": os.environ.get("HUIMENG_IMAGE_QUALITY", "medium"),
        "image_size": image_size_override or "1K",
        "force_image_size": provider_config.get("force_image_size"),
        "multi_character": provider_config.get("multi_character", False),
        "mode": GRID_MODE,
        "rows": GRID_ROWS,
        "cols": GRID_COLS,
        "batch_size": GRID_BATCH_SIZE,
        "total_panels": GRID_TOTAL_PANELS,
    }


def get_sketch_generation_config(
    selection_override: str | None = None,
    model_override: str | None = None,
) -> dict:
    """Get the sketch workbench grid generation configuration.

    Priority:
    1. Explicit DEFAULT_SKETCH_IMAGE_SELECTION (new selection table)
    2. Explicit NANOBANANA_PROVIDER / NANOBANANA_MODEL (legacy environment variable compatibility)
    3. The generic get_grid_generation_config()
    """
    selection = selection_override
    if selection is None:
        selection = (
            DEFAULT_SKETCH_IMAGE_SELECTION
            if (_DEFAULT_SKETCH_SELECTION_EXPLICIT or not _NANOBANANA_PROVIDER_EXPLICIT)
            else None
        )
    provider_override = None if selection else NANOBANANA_PROVIDER
    config = get_grid_generation_config(
        selection_override=selection,
        provider_override=provider_override,
        model_override=model_override,
    )
    config["openai_image_quality"] = OPENAI_SKETCH_IMAGE_QUALITY
    config["huimeng_image_quality"] = "low"
    config["image_size"] = "1K"
    return config


def get_render_generation_config(
    selection_override: str | None = None,
    model_override: str | None = None,
) -> dict:
    """Get the first-frame render image configuration."""
    selection = selection_override
    if selection is None:
        selection = (
            DEFAULT_RENDER_IMAGE_SELECTION
            if (_DEFAULT_RENDER_SELECTION_EXPLICIT or not _NANOBANANA_PROVIDER_EXPLICIT)
            else None
        )
    provider_override = None if selection else NANOBANANA_PROVIDER
    return get_grid_generation_config(
        selection_override=selection,
        provider_override=provider_override,
        model_override=model_override,
    )


# =============================================================================
# Sketch path management
# =============================================================================


def get_sketch_dir(project_name: str, episode: int) -> str:
    """Get the directory holding the whole-episode sketches.

    Args:
        project_name: project name (e.g. admin/test1)
        episode: episode number

    Returns:
        Sketch directory path, e.g. output/admin/test1/grids/ep001/sketch
    """
    base_dir = os.path.abspath(os.path.join(OUTPUT_DIR, project_name))
    return os.path.join(base_dir, "grids", f"ep{episode:03d}", "sketch")


def get_sketch_path(project_name: str, episode: int, sketch_index: int = 1) -> str:
    """Get the whole-episode sketch path (deprecated, kept for backward compatibility).

    In the new mode the sketch file name is sketch_b{start}-{end}_{rows}x{cols}.jpg;
    use list_sketch_files() to walk the sketch directory.

    Args:
        project_name: project name (e.g. admin/test1)
        episode: episode number
        sketch_index: sketch index (1-based), defaults to 1

    Returns:
        Sketch directory path (in the new mode a directory is returned rather than a specific file)
    """
    return get_sketch_dir(project_name, episode)


def list_sketch_files(project_name: str, episode: int) -> list[str]:
    """List all sketch files of the given episode.

    Supports the new naming convention: sketch_b{start}-{end}_{rows}x{cols}.jpg

    Args:
        project_name: project name
        episode: episode number

    Returns:
        List of sketch file paths (sorted by file name)
    """
    sketch_dir = get_sketch_dir(project_name, episode)
    if not os.path.exists(sketch_dir):
        return []

    import glob

    pattern = os.path.join(sketch_dir, "sketch_b*_*x*.jpg")
    files = glob.glob(pattern)
    return sorted(files)


# =============================================================================
# Project management
# =============================================================================


def get_project_dir(project_name: str) -> str:
    """Get the project output directory."""
    return os.path.join(OUTPUT_DIR, project_name)


def ensure_project_dirs(project_name: str) -> dict[str, str]:
    """Ensure the project directory structure exists and return the assets directory path.

    `project_name` may be `username/project` or the legacy single-directory format `project`.
    When it contains a username, the output/state/runtime directories are all ensured to exist.
    """
    base_dir = os.path.abspath(get_project_dir(project_name))

    parts = project_name.split("/", 1)
    if len(parts) == 2:
        from novelvideo.utils.project_paths import ProjectPaths

        paths = ProjectPaths(parts[0], parts[1])
        paths.ensure_dirs()
        paths.bootstrap_from_legacy_output()

    dirs = {
        "base": base_dir,
        "graph": os.path.join(base_dir, "graph"),
        "assets": os.path.join(base_dir, "assets"),
        "characters": os.path.join(base_dir, "assets", "characters"),
        "scripts": os.path.join(base_dir, "scripts"),
        "images": os.path.join(base_dir, "images"),
        "frames": os.path.join(base_dir, "frames"),  # first-frame images
        "audio": os.path.join(base_dir, "audio"),
        "videos": os.path.join(base_dir, "videos"),
    }

    for path in dirs.values():
        os.makedirs(path, exist_ok=True)

    return dirs


def ensure_project_dirs_at_paths(
    *,
    output_dir: str | os.PathLike[str],
    state_dir: str | os.PathLike[str],
    runtime_dir: str | os.PathLike[str],
) -> dict[str, str]:
    """Ensure project directories from registry paths without legacy bootstrap."""
    base_dir = os.path.abspath(os.fspath(output_dir))
    dirs = {
        "base": base_dir,
        "graph": os.path.join(base_dir, "graph"),
        "assets": os.path.join(base_dir, "assets"),
        "characters": os.path.join(base_dir, "assets", "characters"),
        "scripts": os.path.join(base_dir, "scripts"),
        "images": os.path.join(base_dir, "images"),
        "frames": os.path.join(base_dir, "frames"),
        "audio": os.path.join(base_dir, "audio"),
        "videos": os.path.join(base_dir, "videos"),
        "state": os.path.abspath(os.fspath(state_dir)),
        "runtime": os.path.abspath(os.fspath(runtime_dir)),
        "logs": os.path.join(os.path.abspath(os.fspath(runtime_dir)), "logs"),
        "staging": os.path.join(os.path.abspath(os.fspath(runtime_dir)), "staging"),
        "temp_sketch_panels": os.path.join(
            os.path.abspath(os.fspath(runtime_dir)),
            "temp_sketch_panels",
        ),
    }

    for path in dirs.values():
        os.makedirs(path, exist_ok=True)

    return dirs
