# Route every DramaClaw LLM call to Claude through claude-code-openai-wrapper

## Context
The goal is for the project's LLM work (script, storyboard, planner, reviewer, verification/vision, Cognee extraction, chat agent) to run on Claude through the user's personal Claude login (`claudeT`: `CLAUDE_CONFIG_DIR=/Volumes/ThoND/ClaudeWorkspace/cPersonal`, model `opusplan`) instead of the NewAPI/BrainClaw gateway. Users must also be able to pick a Claude model per task.

What exploration found:
- All pipeline text goes through one factory, `get_newapi_text_pydantic_model()` in `src/novelvideo/config.py:386`. It builds pydantic-ai `OpenAIChatModel` on `AsyncOpenAI(base_url=…)`. The model name is resolved per task from the `*_MODEL` env vars by `get_effective_newapi_text_model_name()` (config.py:162). In CE with BrainClaw active it always forces `"brainclaw"`.
- About 49 agents use `output_type=<BaseModel>`. pydantic-ai implements that with a **tool call**. No agent outside `chat/` registers function tools.
- Vision (`BinaryContent`/`ImageUrl`) is used in `verification/*`, keyframe/video prompt builders, freezone vision, style_analyzer and scene_voxel.
- Cognee/litellm calls `acompletion(response_format=json_object)` and **embeddings** (`DC-cognee-embedding`, 1024 dims).
- The wrapper (`RichardAtCT/claude-code-openai-wrapper`, v2.3, claude-agent-sdk):
  - Serves `/v1/chat/completions` on :8000.
  - **No** `tools`, **no** `response_format`, **no images** (`ContentPart` only accepts text, so image parts get a 422).
  - Forwards the model name unchanged. Rate limit defaults to 10 req/min per IP.
  - Tools are off by default (max_turns=1), so `--dangerously-skip-permissions` is not needed.
  - The SDK subprocess inherits `os.environ`, so `CLAUDE_CONFIG_DIR` passes through.
- The chat agent already has a `claude` backend (`chat/backend_sdk.py`, claude-agent-sdk, `bypassPermissions`). It reads `CLAUDE_MODEL` (service.py:2198), and its env inherits from `os.environ` (service.py:3559). That path does not need the wrapper.

## Approach

### 1. Wrapper runs on the macOS host: `scripts/claude_wrapper/`
- `setup.sh` clones the wrapper into `~/.cache/dramaclaw/claude-code-openai-wrapper` at a **pinned commit**, runs `poetry install`, then applies `patches/0001-image-input.patch`.
- `run.sh` exports:
  - `CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-/Volumes/ThoND/ClaudeWorkspace/cPersonal}`, `CLAUDE_AUTH_METHOD=cli`
  - `RATE_LIMIT_ENABLED=false`, `API_KEY=${CLAUDE_WRAPPER_API_KEY}` (non-interactive), `CLAUDE_CWD=<scratch dir>`
  - `DEFAULT_MODEL=${CLAUDE_WRAPPER_DEFAULT_MODEL:-opusplan}`

  It then starts `poetry run uvicorn src.main:app --host 127.0.0.1 --port ${PORT:-8000}`, or `0.0.0.0` when the API runs in docker and calls `host.docker.internal`.
- `patches/0001-image-input.patch` (small, against the pinned commit):
  - `src/models.py`: `ContentPart` accepts `image_url` (data URL or http).
  - `src/claude_cli.py`: when a message contains an image, pass `prompt` to the SDK as an async iterable of one user message with Anthropic content blocks `[{type:image, source:base64…}, {type:text…}]`.
  - `src/main.py`: build the message list without flattening the image parts.
- `README.md`: how to run it, the env vars, and limitations (no embeddings, no Responses API, opusplan in `-p` mode).

### 2. `claude_wrapper` route in the factory: `src/novelvideo/config.py`
- New env vars:
  - `TEXT_LLM_BACKEND=claude_wrapper` (empty means today's behaviour)
  - `CLAUDE_WRAPPER_BASE_URL` (default `http://127.0.0.1:8000/v1`)
  - `CLAUDE_WRAPPER_API_KEY`
  - `CLAUDE_WRAPPER_DEFAULT_MODEL` (default `opusplan`)
- Helper `_claude_wrapper_enabled()`. In `get_newapi_text_pydantic_model()`, when it is on and there is no `credential_override`, skip the CE/EE gateway resolution and call the existing `_newapi_text_openai_model(...)` with the wrapper's base_url and key.
- The profile is an `OpenAIModelProfile` with `supports_tools=False`, `supports_json_schema_output=False`, `supports_json_object_output=False` and `default_structured_output_mode="prompted"`. With that one change all 49 `output_type` agents automatically switch to prompted JSON and send no `tools`.
- Model name: in `get_effective_newapi_text_model_name()`, when the wrapper is on, the order is `override` → **`CLAUDE_<MODEL_ENV>`** (e.g. `CLAUDE_SCENE_BUILD_MODEL=opus`) → `CLAUDE_WRAPPER_DEFAULT_MODEL`. It skips the brainclaw override and the `DC-*` aliases, so the existing gateway `*_MODEL` values are not overwritten. This is how a model is chosen per task: `opus`, `sonnet`, `haiku`, `opusplan` or a full ID.
- `get_newapi_structured_output_model_settings()` returns `{}` when the wrapper is on (the wrapper ignores `reasoning_effort`, so this just keeps the payload clean).
- BrainClaw profile headers are skipped on this route.

### 3. Cognee: legacy only, no change; one litellm call to fix
Checked (`src/novelvideo/knowledge_pipeline.py`, `api/routes/projects.py:760-770`, commit feb32d41): **every new project is created with `knowledge_pipeline=structured_v1`**. It has no graph, no embeddings and no Cognee. The `cognee_legacy` track only covers old projects that lack the field, and `_require_cognee()` blocks every graph operation on structured projects. `CogneeStore` is still used everywhere, but only as a SQLite facade.
- Do **not** touch the Cognee graph or embedding code (`cognee/config.py`, `cognee/store.py::_assign_events_to_episodes`, which only runs for the `ai_events` mode that structured projects reject). Old projects keep using the gateway.
- The structured path still has **one direct litellm call**: `SQLiteStore._generate_episode_metadata` (`sqlite_store.py:1994`). It runs when `graph_build` has `generate_metadata=True` (default False). When the wrapper is on, pass `api_base`, `api_key` and `model=f"openai/{claude model}"` (from `CLAUDE_LLM_MODEL` or the default) straight to `litellm.acompletion`, and drop `response_format` and the reasoning kwargs. The prompt already asks for "JSON only". Strip ```json fences before `json.loads`.
- Agents in `cognee/event_extractor.py` and `screenplay_normalizer.py` use pydantic-ai through the factory, so section 2 covers them automatically.

### 4. Chat agent
No code change. The setup in `.env` / README is `DRAMACLAW_CHAT_BACKEND=claude`, `CLAUDE_MODEL=opusplan`, `CLAUDE_CONFIG_DIR=/Volumes/ThoND/ClaudeWorkspace/cPersonal`. The existing `_build_claude_env` inherits these. Codex needs the Responses API and Hermes needs tool calling, so neither can use the wrapper.

### 5. Config and docs
- `.env.example`: a "Claude wrapper" block with the new variables and some `CLAUDE_*_MODEL` examples.
- A short section in `docs/en/getting-started/configuring-models.md` (and zh).

## Notes and risks
- **`opusplan` in `-p`/max_turns=1 mode** most likely behaves as **Sonnet**, because Opus is only used in plan mode. For heavy tasks, set `CLAUDE_<TASK>_MODEL=opus`.
- Concurrency: each request spawns one CLI process and counts against the personal account's quota. Long timeouts are already covered by `NEWAPI_TEXT_TIMEOUT_SECONDS`.
- The wrapper replaces Claude Code's system prompt with the request's system message, which suits a pipeline.
- The patch only works against the pinned commit. Upgrading the wrapper means regenerating the patch.

## Critical files
- `src/novelvideo/config.py` (factory, name resolution, structured settings)
- `src/novelvideo/sqlite_store.py` (`_generate_episode_metadata` → wrapper)
- `scripts/claude_wrapper/{setup.sh,run.sh,patches/0001-image-input.patch,README.md}` (new)
- `.env.example`, `docs/en|zh/getting-started/configuring-models.md`
- `tests/test_claude_wrapper_route.py` (new)

## Verification
1. `uv run pytest tests/test_claude_wrapper_route.py` checks:
   - With the wrapper on, the factory returns a model with base_url = wrapper and a prompted profile.
   - `CLAUDE_X_MODEL` takes precedence and brainclaw is skipped.
   - With the flag off, behaviour is unchanged.
   - One pydantic-ai Agent with `output_type=BaseModel` run against a mocked transport sends no `tools`.
2. Then `uv run pytest` (default suite) passes.
3. Real smoke test: `scripts/claude_wrapper/setup.sh && scripts/claude_wrapper/run.sh`, then:
   - `curl /v1/chat/completions` with text, and with a base64 `image_url`.
   - A short Python script calls `get_newapi_text_pydantic_model("SCENE_BUILD_MODEL")` plus an Agent with a structured `output_type`, and one vision call to `verification`.
4. Start the API (`uv run novelvideo api --port 8780`) with `TEXT_LLM_BACKEND=claude_wrapper` and `DRAMACLAW_CHAT_BACKEND=claude`. Run one short episode step and one chat message, and check the wrapper log to confirm the requests went through Claude.

## Implementation notes (deviations from the plan)
- The patch is `scripts/claude_wrapper/patches/0001-image-input-and-system-prompt.patch`. Besides image input it fixes the stock wrapper dropping every system message: claude-agent-sdk 0.2.159 only honors a plain-string `system_prompt`, not `{"type": "text", ...}`. Without the fix prompted JSON passed 0/6 on the first try; with it, 6/6.
- `setup.sh` pins Python 3.12/3.11 for the wrapper's venv (its `pydantic-core` pin has no wheel for 3.15).
- Model-name resolution ignores non-Claude overrides (`DC-*`, `gemini-*`) on this route; a Claude-looking override still wins.
- Legacy Cognee projects (embeddings) were left untouched; new projects are `structured_v1` and never reach Cognee.
- Verified against a live Claude login: text (`opusplan`), image (`sonnet`), structured output and vision through `get_newapi_text_pydantic_model`.
