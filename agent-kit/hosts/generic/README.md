# Generic stdio MCP Host

Merge the two servers in `mcp.json` into the host's MCP configuration. The host must support:

- stdio transport
- `command` + `args`
- server-level environment variables
- MCP tools; ideally MCP resources as well

If the host does not support MCP resources, progressive reading is still possible through the
`workflow_skill_get` and `workflow_recipe_get` tools. Install the Skill where the host's own Agent Skill
specification says to.
