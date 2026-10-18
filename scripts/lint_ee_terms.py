#!/usr/bin/env python3
"""Banned package-name lint (REPO-10, hard zero).

The packages below do not belong to this repository and must not appear in any form (code,
comments, docstrings, docs, configuration). This guard scans source + configuration + docs and
complements import-lint (lint_ce_imports.py, which only catches import statements) -- it catches
references at the "string / comment / doc / path" level.

Note: the word list only includes package names with "0 hits measured"; it excludes this repo's
normal dependencies (asyncpg / psycopg / oss2 / celery / litestream), runtime switches
(control_plane / ST_CONTROL_PLANE_DSN), brand names (supertale-ce), etc. -- those are legitimate
uses, and putting them in the list would cause false positives.

Usage:
    python scripts/lint_ee_terms.py            # scan all tracked files (CI default)
    python scripts/lint_ee_terms.py a.py b.md  # scan only the given files (for pre-commit)

Allow: add the comment marker `banned-word-allow` to a line (same convention as lint_banned_words.py).

Any banned package-name hit -> exit code 1.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

from ce_allowlist import inline_marker, skip_paths

# Banned package names (substring match; all measured at 0 hits in this repo).
# Of the form (label, compiled_pattern). Package names are case-sensitive, so no IGNORECASE.
# Only the "package namespace" level is covered; finer internal identifiers are scanned in reverse by the private side, not in this repo.
EE_TERMS = [
    (term, re.compile(re.escape(term)))
    for term in (
        "novelvideo_ee",    # external package namespace (import-lint also forbids importing it)
        "supertale_admin",  # external admin package
        "supertale-admin",  # same as above, hyphenated variant
        "supertale_ee",     # external package variant
    )
]

# Inline exemption marker + skip paths: taken from ce-allowlist.toml (no longer hardcoded)
ALLOW_MARKER = inline_marker()
SKIP_PATHS = skip_paths("ee-terms")

# Source/config/doc extensions to scan
SCAN_SUFFIXES = {
    ".py", ".md", ".markdown", ".mdx", ".txt", ".rst",
    ".yaml", ".yml", ".toml", ".cfg", ".ini", ".sh", ".env",
}
# Filename prefixes / exact names without an extension that still need scanning
SCAN_STEMS = ("README", "LICENSE", "NOTICE", "CONTRIBUTING", "GOVERNANCE", "CHANGELOG")
SCAN_NAMES = {"Dockerfile", "Dockerfile.ce"}


def is_scan_target(path: Path) -> bool:
    if path.suffix.lower() in SCAN_SUFFIXES:
        return True
    if path.name in SCAN_NAMES:
        return True
    return path.suffix == "" and path.name.upper().startswith(SCAN_STEMS)


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
        if p.is_file() and is_scan_target(p) and p.as_posix() not in SKIP_PATHS
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
        for label, pattern in EE_TERMS:
            if pattern.search(line):
                hits.append((lineno, label, line.strip()[:100]))
    return hits


def main(argv: list[str]) -> int:
    total = 0
    for path in collect_targets(argv):
        for lineno, label, snippet in scan(path):
            total += 1
            print(f"{path}:{lineno}: banned package name \"{label}\"  | {snippet}")
    if total:
        print(
            f"\n✖ {total} banned package-name hit(s). These packages do not belong to this repository.\n"
            f"  The related capabilities should be consumed through the novelvideo.ports.* abstractions rather than by referencing external packages.\n"
            f"  A genuinely legitimate reference (e.g. a cross-repo note) may add the comment marker `{ALLOW_MARKER}` to exempt the line.",
            file=sys.stderr,
        )
        return 1
    print("✓ No banned package names.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
