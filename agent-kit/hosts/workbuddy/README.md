# WorkBuddy

The MCP configuration location may differ between WorkBuddy versions. This directory only provides a standard
stdio `mcpServers` object. Render it with `scripts/render_config.py --host workbuddy ...`, then merge it into
the MCP settings provided by that version. Do not overwrite its existing tool configuration.

If the current version supports Agent Skills, install `dramaclaw-workflows`; otherwise load `SKILL.md` as
on-demand workflow instructions. MCP remains the necessary boundary for actually operating the local DramaClaw.
