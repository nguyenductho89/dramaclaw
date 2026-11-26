#!/usr/bin/env bash
# Clone claude-code-openai-wrapper at a pinned commit, apply the image-input patch, install deps.
# Usage: scripts/claude_wrapper/setup.sh
set -euo pipefail

pinned_commit=aaad0b96a4cd63833003ac340bbcc37f89418acc
wrapper_dir=${CLAUDE_WRAPPER_DIR:-$HOME/.cache/dramaclaw/claude-code-openai-wrapper}
here=$(cd "$(dirname "$0")" && pwd)

if [ ! -d "$wrapper_dir/.git" ]; then
  mkdir -p "$(dirname "$wrapper_dir")"
  git clone https://github.com/RichardAtCT/claude-code-openai-wrapper "$wrapper_dir"
fi

cd "$wrapper_dir"
git fetch -q origin
git checkout -q -f "$pinned_commit"
git apply "$here"/patches/*.patch
# The wrapper's pinned deps only ship wheels for Python 3.10-3.13.
py=$(command -v python3.12 || command -v python3.11 || true)
[ -n "$py" ] || { echo "need python3.12 or python3.11 on PATH" >&2; exit 1; }
poetry env use "$py"
poetry install --only main
echo "wrapper ready at $wrapper_dir ($pinned_commit + image patch)"
