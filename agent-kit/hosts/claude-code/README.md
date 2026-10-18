# Claude Code

1. Install the Skill to `~/.claude/skills/dramaclaw-workflows` or to the project's `.claude/skills/`.
2. Generate `.mcp.json` with `scripts/render_config.py --host claude-code ...`.
3. Merge the two `mcpServers` entries into the project's `.mcp.json`; do not overwrite existing servers.
4. Restart Claude Code and check the connection with `/mcp`.

For an official release to the Claude Marketplace, the Skill and MCP definitions in this directory can be
packaged as a Claude Plugin; the business MCP launcher should still point at the user's local `dramaclaw-ce`.
