# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` is the authoritative guide for structure, style, commit conventions, the Hermes sandbox and the engineering principle ("industrial-grade solutions, no over-engineering"). Read it first; this file only adds commands and cross-file architecture.

## Commands

Backend (Python 3.11–3.12, `uv`):

```bash
uv sync --group dev                                   # install (CI uses `uv sync --frozen`; `uv lock --check` must pass)
uv run novelvideo api --port 8780                     # REST API only
scripts/start-ce.sh                                   # API :8780 + frontend :5173 (downloads pinned Codex runtime on first run)
uv run pytest                                         # default suite; `ee` and `e2e` markers are excluded via addopts
uv run pytest tests/test_api_assets.py::test_name     # single test
uv run ruff check .                                   # lint (rules frozen to E4/E7/E9/F; legacy per-file ignores live in pyproject.toml)
pre-commit run --all-files                            # gitleaks + banned-words lint
```

Frontend (`frontend/`, pnpm, Node 22): `pnpm dev`, `pnpm build:ce`, `pnpm test` (vitest), `pnpm test:e2e` (playwright). For any visual change read `DESIGN.md` first.

CI also runs guard scripts you should run when touching the relevant area: `scripts/check_ce_port_closure.py`, `scripts/check_workflow_agent_contracts.py`, `scripts/check_env_config.py` (every key in an env template must be read by the runtime or allowlisted), `scripts/check_backend_i18n.py` / `check_frontend_i18n.py`, `scripts/lint_ce_imports.py`, `scripts/lint_ee_terms.py`, `scripts/lint_banned_words.py`.

## Architecture

**Editions.** One codebase ships Community Edition (CE, single tenant, SQLite + files, no Postgres/Redis/Celery) and Enterprise (EE, control-plane DSN). `shared/runtime_env.py` (`is_ce_effective`, `uses_local_ce_runtime`) decides which; many modules branch on it. CE code must not import EE modules (`lint_ce_imports.py`), and EE-only tests carry `@pytest.mark.ee`.

**Layers under `src/novelvideo/`.**
- `api/` — FastAPI app and thin route handlers (`api/routes/`); heavy work is not done in the request.
- `task_backend/` — long jobs. Routes enqueue a task (`task_type` + scope, e.g. `episode_scene_planner`), a runner in `task_backend/runners/` executes it (CE runs `inline` in-process), and state is projected back for the UI. Runners register via `register_project_task_runner`. Task status is not exposed at a simple `/tasks/{id}` URL; poll the project's data or the API log (`Project task completed: ...`).
- `agents/` — pydantic-ai agents with Chinese system prompts (asset compiler, identity planner, prompt builders). `cognee/` holds the knowledge-graph store and the screenplay normalizer. `generators/` is media generation, `ports/` the interface boundaries, `verification/` quality gates.
- `config.py` — central env/model resolution; per-task model variables (`SCENE_BUILD_MODEL`, `SCREENPLAY_NORMALIZER_MODEL`, …) are read here and in the agents via `get_newapi_text_pydantic_model("<ENV_NAME>", ...)`.

**Env precedence.** The process environment beats `.env` (`env.py`). `cognee` calls `load_dotenv(override=True)` when imported; its first import in `cognee/config.py` is wrapped in `keep_existing_env()` to undo that. Do not import `cognee` from outside `novelvideo.cognee` before that module has loaded.

**Model gateway and credentials (non-obvious).** Text LLM calls go through an OpenAI-compatible "NewAPI" gateway and default to opaque `DC-*-LLM` aliases that only the gateway understands. In CE the gateway key/base URL are read from `state/local/settings.db` (`model_gateway_settings.py`, e.g. `save_custom_newapi_gateway`), **not** from `MODEL_API_KEY`/`.env`; with nothing saved you get "API key not set. Configure DramaClawAPI credentials." To use a direct provider, save it as a custom gateway and set the per-task `*_MODEL` env vars to that provider's real model names. `TEXT_LLM_BACKEND=claude_wrapper` is an alternative route to a local Claude wrapper (`scripts/claude_wrapper/`).

**Series pipeline order.** Ingest → knowledge graph → characters (`POST /projects/{id}/characters/build`) → per-episode scene plan (`/episodes/{n}/scenes/plan`) and prop plan (`/props/plan`) → identity plan (`/identities/plan-async`, refuses with `IDENTITY_CHARACTERS_REQUIRED` until characters exist) → scripts, sketches, video. Projects are addressed by ULID in the API, not by name. Project state lives under `state/<owner>/<project>/` (`project_config.json`, SQLite).

**Output language.** Generated asset text follows the source text's language via `utils/source_language.py` (`detect_asset_language` + `asset_language_instruction`, zh/en only; ties and unknown default to zh). Agent prompts are written in Chinese, so every agent call that produces names or labels must append this instruction — and short labels (e.g. identity `visual_state`) need their own explicit rule because they are not "prose". A new agent without it will answer in Chinese for English scripts.

**Docs.** `docs/` holds design notes (e.g. `episode-asset-planning.md`, `freezone-*.md`); user docs are in `docs/en/`. Frontend i18n and backend i18n each have an allowlist JSON in `scripts/` that the checkers enforce.
