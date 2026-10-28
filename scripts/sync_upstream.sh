#!/usr/bin/env bash
# Merge dramaclaw/dramaclaw (upstream) into the current branch.
#
# This repo translated code comments/strings to English while upstream still
# edits the Chinese originals, so merges conflict on translated lines. This
# script prepares the merge and lists what is left to resolve; it never commits.
#
#   scripts/sync_upstream.sh [upstream-ref]     (default: upstream/main)
set -euo pipefail

ref="${1:-upstream/main}"
cd "$(git rev-parse --show-toplevel)"

git remote get-url upstream >/dev/null 2>&1 \
  || git remote add upstream https://github.com/dramaclaw/dramaclaw.git
# A shallow clone has no common ancestor with upstream ("unrelated histories").
[ "$(git rev-parse --is-shallow-repository)" = true ] && git fetch --unshallow origin
git fetch upstream --tags

# Remember each resolution so the same conflict is not solved twice.
git config rerere.enabled true
git config rerere.autoupdate true

if git merge --no-commit --no-ff "$ref"; then
  echo "Clean merge. Run: python scripts/check_no_cjk.py"
else
  echo; echo "== Conflicted files =="
  git diff --name-only --diff-filter=U
  echo
  echo "Resolve rule: keep OUR English text / i18n keys, take upstream's logic,"
  echo "translate any new Chinese from upstream to English (or add 'no-cjk-exempt'"
  echo "on lines that must stay Chinese). zh locale/docs/README_zh are exempt."
fi
echo; echo "== New CJK introduced by the merge =="
python scripts/check_no_cjk.py || true
echo; echo "Next: fix the above, then 'git add -A && git commit' (do not stash mid-merge)."
