#!/usr/bin/env python3
"""Pre-release banned-word lint (REPO-07).

dramaclaw-ce is licensed under the Elastic License v2 (source-available) and is **not open source**.
Public-facing text must not call this project "open source" (in English or Chinese), to avoid
confusion with the OSI open-source definition.

Usage:
    python scripts/lint_banned_words.py            # scan all tracked docs/text
    python scripts/lint_banned_words.py a.md b.md  # scan only the given files (for pre-commit)

Allow: add the comment marker `banned-word-allow` to a line to exempt it -- for explanatory
text such as the LICENSE-FAQ that must explicitly say "this is not open source".

Any banned word hit -> exit code 1.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

from ce_allowlist import inline_marker, skip_paths

# Banned words (English and Chinese, case-insensitive, allowing open-source / open source / opensource).
# The Chinese term for "open source" is built from unicode escapes so this file contains no literal CJK.
BANNED = [
    ("\u5f00\u6e90", re.compile("\u5f00\u6e90")),
    ("open source", re.compile(r"open[\s\-_]?source", re.IGNORECASE)),
]

# Inline exemption marker (explanatory text may say "not open source") -- taken from ce-allowlist.toml
ALLOW_MARKER = inline_marker()

# Text/doc extensions to scan
TEXT_SUFFIXES = {".md", ".markdown", ".mdx", ".txt", ".rst", ".html", ".htm"}
# Filename prefixes without an extension that still need scanning
TEXT_STEMS = ("README", "LICENSE", "NOTICE", "CONTRIBUTING", "GOVERNANCE", "CHANGELOG")

# Paths that are always skipped (the lint itself and its rule docs "mention" these words) -- taken from ce-allowlist.toml
SKIP_PATHS = skip_paths("banned-words")


def is_text_target(path: Path) -> bool:
    if path.suffix.lower() in TEXT_SUFFIXES:
        return True
    return path.suffix == "" and path.name.upper().startswith(TEXT_STEMS)


def tracked_files() -> list[Path]:
    out = subprocess.run(
        ["git", "ls-files"], capture_output=True, text=True, check=True
    ).stdout.splitlines()
    return [Path(p) for p in out]


def collect_targets(argv: list[str]) -> list[Path]:
    paths = [Path(p) for p in argv] if argv else tracked_files()
    return [
        p
        for p in paths
        if p.is_file() and is_text_target(p) and p.as_posix() not in SKIP_PATHS
    ]


def scan(path: Path) -> list[tuple[int, str, str]]:
    hits: list[tuple[int, str, str]] = []
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return hits
    for lineno, line in enumerate(text.splitlines(), 1):
        if ALLOW_MARKER in line:
            continue
        for label, pattern in BANNED:
            if pattern.search(line):
                hits.append((lineno, label, line.strip()[:100]))
    return hits


def main(argv: list[str]) -> int:
    total = 0
    for path in collect_targets(argv):
        for lineno, label, snippet in scan(path):
            total += 1
            print(f"{path}:{lineno}: banned word \"{label}\"  | {snippet}")
    if total:
        print(
            f"\n✖ {total} banned word hit(s). dramaclaw-ce is not open source (ELv2 source-available); "
            f'use "source-available" in public-facing text instead.\n'
            f'  Explanatory text (such as "this is not open source") may add the comment marker `{ALLOW_MARKER}` to exempt the line.',
            file=sys.stderr,
        )
        return 1
    print("✓ No banned words.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
