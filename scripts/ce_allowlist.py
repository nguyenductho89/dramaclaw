#!/usr/bin/env python3
"""Unified allowlist loader for the CE guardrails (zero dependencies, stdlib tomllib).

Each linter takes its "exemption list" from here instead of hardcoding SKIP_PATHS / inline
markers, so every escape hatch is consolidated in ce-allowlist.toml and can be audited in one place.
import-lint / cp-port deliberately do not consume this module -- they allow zero exemptions.
"""
from __future__ import annotations

import sys
import tomllib
from functools import lru_cache
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MANIFEST = REPO_ROOT / "ce-allowlist.toml"


@lru_cache(maxsize=1)
def load() -> dict:
    if not MANIFEST.exists():
        raise SystemExit(f"Allowlist manifest missing: {MANIFEST}")
    return tomllib.loads(MANIFEST.read_text(encoding="utf-8"))


def inline_marker() -> str:
    """Inline exemption marker (a line containing this comment is let through)."""
    return load()["marker"]["inline"]


def known_guards() -> list[str]:
    return list(load().get("guards", {}).get("known", []))


def skip_entries() -> list[dict]:
    return list(load().get("skip", []))


def skip_paths(guard: str) -> set[str]:
    """The set of exempt paths that apply to the given guard."""
    return {e["path"] for e in skip_entries() if guard in e.get("guards", [])}


def _self_check() -> int:
    """CI self-check: the manifest is structurally complete and has no rotten exemptions pointing at nonexistent files."""
    known = set(known_guards())
    if not known:
        print("✖ guards.known is empty", file=sys.stderr)
        return 1
    problems: list[str] = []
    for entry in skip_entries():
        if not ({"path", "guards", "reason"} <= entry.keys()):
            problems.append(f"missing fields: {entry}")
            continue
        if not str(entry["reason"]).strip():
            problems.append(f"missing reason: {entry['path']}")
        if not set(entry["guards"]) <= known:
            problems.append(f"unknown guard: {entry['path']} -> {entry['guards']}")
        if not (REPO_ROOT / entry["path"]).is_file():
            problems.append(f"rotten exemption (file does not exist): {entry['path']}")
    if problems:
        print("✖ ce-allowlist.toml validation failed:", file=sys.stderr)
        for item in problems:
            print(f"  {item}", file=sys.stderr)
        return 1
    print(f"✓ ce-allowlist.toml: all {len(skip_entries())} exemptions are valid, marker={inline_marker()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_self_check())
