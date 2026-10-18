# OpenClaw

The configuration entry point may differ between OpenClaw distributions, so this package provides a standard
stdio `mcpServers` object and does not assume any private configuration path. After generating it with
`scripts/render_config.py --host openclaw ...`, import the two servers in the current OpenClaw's MCP settings.

Install the Skill into the Agent Skills directory declared by that distribution. If it does not support
automatic Skill discovery, import `skills/dramaclaw-workflows/SKILL.md` as project instructions, but still
keep both MCP servers.
