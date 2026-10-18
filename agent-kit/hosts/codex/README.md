# Codex

1. Install the Skill to `~/.agents/skills/dramaclaw-workflows` or to the project's `.agents/skills/`.
2. Generate a config snippet with `scripts/render_config.py --host codex ...`.
3. Merge it into `~/.codex/config.toml` or a trusted project's `.codex/config.toml`.
4. Restart Codex, run `codex mcp list`, and check both servers in a session with `/mcp`.

Do not replace an existing `config.toml` wholesale with the template.
