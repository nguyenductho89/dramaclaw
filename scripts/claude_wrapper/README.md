# Claude wrapper (text LLM via the local Claude login)

Routes DramaClaw's text/vision LLM calls to Claude through
[claude-code-openai-wrapper](https://github.com/RichardAtCT/claude-code-openai-wrapper),
using the Claude login in `CLAUDE_CONFIG_DIR` (default `/Volumes/ThoND/ClaudeWorkspace/cPersonal`,
the same one `claudeT` uses).

## Run

```bash
scripts/claude_wrapper/setup.sh   # once: pinned clone + image-input patch + poetry install
scripts/claude_wrapper/run.sh     # serves http://127.0.0.1:8000/v1
```

Then start the API with:

```bash
TEXT_LLM_BACKEND=claude_wrapper
CLAUDE_WRAPPER_BASE_URL=http://127.0.0.1:8000/v1   # host.docker.internal when the API is in docker
CLAUDE_WRAPPER_API_KEY=claude-wrapper               # must match run.sh's API_KEY
CLAUDE_WRAPPER_DEFAULT_MODEL=opusplan               # only for tasks not in the table below
CLAUDE_SCENE_BUILD_MODEL=opus                       # per-task override: CLAUDE_<task *_MODEL env name>
```

Chat agent (does not use the wrapper): `DRAMACLAW_CHAT_BACKEND=claude`, `CLAUDE_MODEL=opusplan`,
`CLAUDE_CONFIG_DIR=...`.

## Default model per task

`config.py::CLAUDE_WRAPPER_MODEL_BY_ENV` picks the tier when no `CLAUDE_<task>_MODEL` is set:

| Tier | Tasks |
|---|---|
| `opus` | identity analysis, episode scene/prop planners, scene reconcile, scene spatial contract, story script, content rewriter, Seedance2 prompt composer, global video optimizer |
| `sonnet` | scene/character build, identity cast/appearance, beat meta, screenplay normalizer, narrated scene asset, staging prop, scene overlap, keyframe/video prompts, style analyzer, video identity detector, freezone text writer/recipe/vision, Cognee LLM |
| `haiku` | freezone translation |

Order: explicit Claude override → `CLAUDE_<task>_MODEL` → this table → `CLAUDE_WRAPPER_DEFAULT_MODEL`.

## How it works / limits

- The wrapper has no tool calling or `response_format`, so the text route forces pydantic-ai's
  *prompted* JSON output (`config.py::_claude_wrapper_model_profile`).
- `patches/0001-image-input-and-system-prompt.patch` fixes two stock-wrapper gaps: `image_url` parts are rejected, and system messages are silently dropped (the SDK ignores the `{"type":"text"}` shape).
- No embeddings and no Responses API: legacy Cognee projects (embeddings) and the Codex/Hermes
  chat backends keep using the gateway.
- In `-p` single-turn mode `opusplan` most likely runs as Sonnet; set `CLAUDE_<TASK>_MODEL=opus`
  for heavy tasks.
- Upgrading the pinned commit means regenerating the patch.
