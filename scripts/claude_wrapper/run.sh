#!/usr/bin/env bash
# Run claude-code-openai-wrapper on the host with the personal Claude login.
# Usage: scripts/claude_wrapper/run.sh   (PORT=8000 by default)
# Set CLAUDE_WRAPPER_HOST=0.0.0.0 when the API runs in docker (host.docker.internal).
set -euo pipefail

wrapper_dir=${CLAUDE_WRAPPER_DIR:-$HOME/.cache/dramaclaw/claude-code-openai-wrapper}
[ -d "$wrapper_dir/src" ] || { echo "run scripts/claude_wrapper/setup.sh first" >&2; exit 1; }

export CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-/Volumes/ThoND/ClaudeWorkspace/cPersonal}
export CLAUDE_AUTH_METHOD=cli
export RATE_LIMIT_ENABLED=false
export DEFAULT_MODEL=${CLAUDE_WRAPPER_DEFAULT_MODEL:-opusplan}
# Non-interactive startup: the wrapper prompts for an API key unless one is set.
export API_KEY=${CLAUDE_WRAPPER_API_KEY:-claude-wrapper}

CLAUDE_CWD=${CLAUDE_CWD:-$(mktemp -d)}
export CLAUDE_CWD

cd "$wrapper_dir"
exec poetry run uvicorn src.main:app \
  --host "${CLAUDE_WRAPPER_HOST:-127.0.0.1}" --port "${PORT:-8000}"
