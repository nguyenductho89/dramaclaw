# Hermes

The Hermes built into `dramaclaw-ce` already loads `.hermes/plugins/dramaclaw`,
`.hermes/plugins/freezone`, and the corresponding Skills natively. Do not mount this package's MCP on top of
it, or you may get duplicate tools or duplicate approvals.

For a standalone third-party Hermes:

1. Prefer installing the Hermes plugins bundled with CE, to keep the native approval chain.
2. If that Hermes distribution supports only standard MCP, register the two stdio servers according to
   `hosts/generic/mcp.json`.
3. Install the shared Skill into its Skill directory.

Do not enable both the native Freezone plugin and the external `dramaclaw` MCP in a built-in Hermes session.
