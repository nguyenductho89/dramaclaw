#!/usr/bin/env python3
"""DCO check (REPO-19): every commit in the PR range must carry a Signed-off-by trailer.

Usage:
    python scripts/check_dco.py <base>..<head> [--not <trusted-ref>]
    python scripts/check_dco.py                   # defaults to origin/main..HEAD

Merge commits are skipped. Any commit missing `Signed-off-by:` -> exit code 1.
See CONTRIBUTING.md and DCO for contributor sign-off instructions.
"""
from __future__ import annotations

import re
import subprocess
import sys

# Of the form: Signed-off-by: Jane Doe <jane@example.com>
SIGNOFF = re.compile(r"^\s*Signed-off-by: .+ <.+@.+>\s*$", re.MULTILINE)


def _git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], capture_output=True, text=True, check=True
    ).stdout


def commit_shas(revisions: list[str]) -> list[str]:
    # --no-merges skips merge commits (their author is not the contributor)
    return _git("log", "--no-merges", "--format=%H", *revisions).split()


def main(argv: list[str]) -> int:
    revisions = argv if argv else ["origin/main..HEAD"]
    offenders: list[str] = []
    for sha in commit_shas(revisions):
        body = _git("log", "-1", "--format=%B", sha)
        if not SIGNOFF.search(body):
            subject = _git("log", "-1", "--format=%s", sha).strip()
            offenders.append(f"{sha[:12]} {subject}")
    if offenders:
        print(
            "✖ The following commits lack Signed-off-by (DCO sign-off):",
            file=sys.stderr,
        )
        for line in offenders:
            print(f"  {line}", file=sys.stderr)
        print(
            "\nEvery commit must contain `Signed-off-by: Your Name <email>` -- add `-s` when committing "
            "(`git commit -s`); to sign off existing history use `git rebase --signoff <base>`. See CONTRIBUTING.md.",
            file=sys.stderr,
        )
        return 1
    print("✓ All commits are DCO signed off.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
