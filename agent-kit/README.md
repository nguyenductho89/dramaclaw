# DramaClaw Agent Kit

A cross-Agent Skill + MCP release package for a locally available `dramaclaw-ce` source checkout. It lets
Codex, Claude Code, OpenClaw, Hermes, WorkBuddy, and other Agents that support standard stdio MCP reuse the
same Workflow Skill, Recipe compiler, business approval, and Freezone canvas write chain.

## Boundary

This directory is a host adapter package; it does not duplicate DramaClaw's business implementation:

```text
Third-party Agent
├── dramaclaw-workflows Skill
├── dramaclaw-workflows MCP (read-only: query, validate, compile)
└── dramaclaw MCP (local authorization, drafts, approval, canvas commit, run)
                              │
                              ▼
                    Local dc/dramaclaw-ce
```

- `scripts/launch_mcp.py workflows` starts the public Workflow MCP.
- `scripts/launch_mcp.py tools` starts the authorized DramaClaw MCP and reuses the existing Hermes tool implementations inside CE.
- All project, task, and canvas writes are still performed by the local CE API and the Freezone frontend bridge.
- It contains no API keys, Agent Tokens, user projects, SQLite, canvas state, or generated media.
- The built-in Hermes needs no chain change; it keeps using its native plugins. This package only provides an equivalent entry point for external Agents.

## Prerequisites

1. A local `dramaclaw-ce` source checkout that satisfies the capability contract in `manifest.json`, with
   `uv sync` already run. Validation only reads the contract markers and required files in the current tree,
   and supports shallow checkouts and source archives without relying on Git history. A release lower bound
   can be added once an official release is published.
2. The API listens only on the loopback address:

   ```bash
   cd /path/to/dramaclaw-ce
   DRAMACLAW_LOCAL_AGENT_TRUST=1 uv run novelvideo api --host 127.0.0.1 --port 8780
   ```

3. When operating the Freezone canvas, keep the corresponding project/canvas page open in the browser; it is used to show approvals and execute batched canvas commands.

The local token-free mode is allowed only for `127.0.0.1`, `::1`, or `localhost`. If the API is reachable
from the LAN or the public internet, do not enable `DRAMACLAW_LOCAL_AGENT_TRUST`; use a short-lived Agent
Token issued by CE instead.

## Install the Skill

First install `skills/dramaclaw-workflows` into the Agent's Skill directory:

```bash
python3 scripts/install_skill.py --host codex
python3 scripts/install_skill.py --host claude-code
```

Default locations:

| Host | Skill directory |
|---|---|
| Codex | `~/.agents/skills/dramaclaw-workflows` |
| Claude Code | `~/.claude/skills/dramaclaw-workflows` |
| Hermes | `~/.hermes/skills/dramaclaw-workflows` |
| OpenClaw / WorkBuddy / others | Use `--target /path/to/skills/dramaclaw-workflows` |

The installer does not overwrite an existing directory. When upgrading, check any existing customizations
first, then pass `--replace` explicitly.

## Generate the MCP configuration

The configuration templates contain no secrets. Render them for your local paths:

```bash
python3 scripts/render_config.py \
  --host codex \
  --ce-dir /path/to/dramaclaw-ce \
  --project-id PROJECT_ID \
  --canvas-id CANVAS_ID \
  --output /tmp/dramaclaw-codex.toml
```

Supported `--host` values:

- `codex`
- `claude-code`
- `openclaw`
- `workbuddy`
- `generic`

The rendered output is a fragment to be merged; it never overwrites the Agent's existing global configuration. See `hosts/` for host-specific notes.

## Self-check

```bash
python3 scripts/doctor.py --ce-dir /path/to/dramaclaw-ce
```

The self-check confirms: the CE checkout, the virtual environment, the two MCP modules, the Hermes tool
plugins, the shared Skill, and the local `/healthz`. It does not perform any canvas writes.

## MCP launch commands

The configuration templates all end up calling the same launcher:

```bash
python3 /path/to/dramaclaw-agent-kit/scripts/launch_mcp.py workflows
python3 /path/to/dramaclaw-agent-kit/scripts/launch_mcp.py tools
```

The launcher locates the local CE through `DRAMACLAW_CE_DIR` and prefers CE's `.venv`. Important environment variables:

| Variable | Purpose |
|---|---|
| `DRAMACLAW_CE_DIR` | Absolute path of the `dramaclaw-ce` checkout |
| `DRAMACLAW_API_URL` | Defaults to `http://127.0.0.1:8780` |
| `DRAMACLAW_USERNAME` | Local CE username, defaults to `local` |
| `DRAMACLAW_PROJECT_ID` | The current project; must be set correctly in canvas mode |
| `DRAMACLAW_CANVAS_ID` | The current Freezone canvas |
| `DRAMACLAW_AGENT_PROFILE` | Defaults to `freezone:main` |
| `DRAMACLAW_AGENT_TOKEN_FILE` | Optional short-lived Token file, takes priority over the token-free mode |

Do not enable `DRAMACLAW_MCP_DIRECT_CANVAS_APPLY=1` as a regular integration method. The default value `0`
preserves frontend approval, React Flow state sync, autosave, and execution receipts.

## Before release

Run from the `dramaclaw-ce` root:

```bash
python3 agent-kit/scripts/sync_skill.py --check
python3 agent-kit/scripts/doctor.py --ce-dir . --skip-api
python3 agent-kit/scripts/render_config.py --host codex --ce-dir . --project-id demo --canvas-id demo
```

Publish the whole `agent-kit/` directory. See `LICENSES/Elastic-2.0.txt` for the license and `NOTICE` for third-party notices.
