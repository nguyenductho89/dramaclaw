# Using DramaClaw MCP from a Local Codex / Claude

This document explains how to let external agents installed on your machine, such as Codex, Claude, and OpenClaw, operate a locally running `dramaclaw-ce`. For the general Claude Code setup, see [mcp-claude-code.md](mcp-claude-code.md).

## Design goals

Local mode does not need a complicated external gateway. The recommended chain is:

```text
Codex / Claude / OpenClaw
  -> local MCP server
  -> http://127.0.0.1:8780
  -> dramaclaw-ce API
  -> existing task system / Freezone canvas bridge
```

MCP is only a local tool adapter layer. Projects, tasks, and canvas operations are still executed by the `dramaclaw-ce` API and the frontend canvas.

## Start dramaclaw-ce

Start the local API first:

```bash
cd /path/to/dramaclaw-ce
DRAMACLAW_LOCAL_AGENT_TRUST=1 novelvideo api --host 127.0.0.1 --port 8780
```

`DRAMACLAW_LOCAL_AGENT_TRUST=1` allows local agent requests that originate from `127.0.0.1` / `::1` / `localhost` to skip the token.

Notes:

- Bind to `127.0.0.1` only.
- Do not enable this while listening on `0.0.0.0` or while the port is reachable from the LAN.
- Canvas write operations are still handed to the Freezone frontend by default so that state stays in sync instantly. After the external agent completes approval in its own chat, the frontend executes automatically and does not open the built-in Freezone chat approval.
- High-risk business operations such as overwrite, delete, and re-ingest should still keep a business confirmation.

## MCP Server

Business tools and the read-only Workflow catalog use two explicit boundaries:

```bash
python agent-kit/scripts/launch_mcp.py tools
python agent-kit/scripts/launch_mcp.py workflows
```

The two entry points expose:

- `tools`: authorized `dramaclaw_*` business operations and `freezone_*` canvas writes.
- `workflows`: Workflow Skill/Recipe lookup, validation, and read-only compilation.

`tools` reuses the existing tool implementations in `.hermes/plugins/dramaclaw` and `.hermes/plugins/freezone`.

The default environment fills in the following automatically:

- `DRAMACLAW_API_URL=http://127.0.0.1:8780`
- `DRAMACLAW_LOCAL_AGENT_TRUST=1`
- `DRAMACLAW_EXTERNAL_MCP=1`
- `DRAMACLAW_MCP_DIRECT_CANVAS_APPLY=0`
- `DRAMACLAW_USER=local`
- `DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR=state/<user>/.hermes-freezone/tmp/supertale_canvas_command_bridge`

The bridge directory uses a shared root so that the Freezone session in the current browser can listen and show the approval. Override `DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR` manually only when debugging a specific agent profile.

## Codex configuration example

Using the Python from the repository virtual environment is recommended:

```json
{
  "mcpServers": {
    "dramaclaw": {
      "command": "/path/to/dramaclaw-ce/.venv/bin/python",
      "args": ["/path/to/dramaclaw-ce/agent-kit/scripts/launch_mcp.py", "tools"],
      "cwd": "/path/to/dramaclaw-ce",
      "env": {
        "DRAMACLAW_API_URL": "http://127.0.0.1:8780",
        "DRAMACLAW_LOCAL_AGENT_TRUST": "1",
        "DRAMACLAW_EXTERNAL_MCP": "1",
        "DRAMACLAW_MCP_DIRECT_CANVAS_APPLY": "0",
        "DRAMACLAW_USER": "local"
      }
    },
    "dramaclaw-workflows": {
      "command": "/path/to/dramaclaw-ce/.venv/bin/python",
      "args": ["/path/to/dramaclaw-ce/agent-kit/scripts/launch_mcp.py", "workflows"],
      "cwd": "/path/to/dramaclaw-ce",
      "env": {
        "DRAMACLAW_USERNAME": "local"
      }
    }
  }
}
```

To operate the Freezone canvas, add the current canvas context:

```json
{
  "DRAMACLAW_CHAT_SURFACE": "freezone",
  "DRAMACLAW_CANVAS_ID": "current canvas ID"
}
```

Without `DRAMACLAW_CANVAS_ID`, some Freezone tools require `canvas_id` to be passed explicitly on each call.

## Token mode

If you do not want to enable local trust, use a token:

```json
{
  "env": {
    "DRAMACLAW_API_URL": "http://127.0.0.1:8780",
    "DRAMACLAW_AGENT_TOKEN": "xxx"
  }
}
```

With a token, the plugin sends:

```http
Authorization: Bearer xxx
```

Without a token and without `DRAMACLAW_LOCAL_AGENT_TRUST=1`, the tools reject the call.

## Canvas operation notes

External agents do not modify the backend canvas payload directly by default. Freezone write operations reuse the canvas bridge of the built-in Hermes agent:

```text
MCP freezone tool
  -> confirmation requested in the external chat
  -> user confirms in Codex / Claude / OpenClaw
  -> pending canvas command is written
  -> browser frontend automatically executes the node/edge/workflow operation
  -> result is written back
  -> MCP tool returns the result
```

Therefore, when you operate Freezone with Codex/Claude, the matching Freezone page must be open in a browser. This keeps React Flow state, selection state, node sizes, autosave, and progress display in sync instantly.

`DRAMACLAW_EXTERNAL_MCP=1` is only for external agent entry points. The built-in Hermes agent does not set this variable, so it still uses the approval card inside the Freezone chat; external agents confirm in their own Codex / Claude / OpenClaw chat, and after confirmation the frontend executes the command automatically without showing the Freezone chat approval.

When an external agent actually runs an image or video node, the authorized MCP runs a parameter preflight before approval and canvas write. If the model, aspect ratio, resolution/quality, duration, audio toggle, or count is still missing, it returns `generation_parameters_required`. The agent should use `freezone_request_user_clarification` to ask for all missing items at once, then retry with the same workflow draft or plan; it must not silently adopt defaults. Ordinary empty-node creation, edge creation, grouping, layout, copywriting, and standalone audio settings are not affected by this preflight.

When the user selects "Recommended model" in the clarification card, the agent should pass the standard symbolic value `"recommended"` and must not guess a specific model ID. The authorized MCP removes this symbolic value before submitting to the canvas, and the local canvas uses the currently available default model. There is therefore no need to regenerate the whole workflow graph just to replace the recommended option.

Enable the following explicitly only for headless or test scenarios without a browser:

```bash
DRAMACLAW_MCP_DIRECT_CANVAS_APPLY=1
```

When enabled, MCP bypasses the frontend and writes the backend canvas payload directly; the frontend must pick up changes through a revision refresh.
