#!/usr/bin/env python3
"""Repo-wide "no Chinese" ratchet.

DramaClaw supports English and Vietnamese only. This gate counts every tracked
text line that still contains CJK characters (comments and docs included).

Usage:
    python scripts/check_no_cjk.py            # compare against the allowlist
    python scripts/check_no_cjk.py --write    # regenerate the allowlist (ratchet down)
    python scripts/check_no_cjk.py --list     # print every hit, ignore the allowlist

The allowlist (scripts/no_cjk_allowlist.json) maps file -> number of lines with
CJK. Counts may only shrink; a file that is not listed must have zero hits.
A line that must keep CJK on purpose carries the marker ``no-cjk-exempt``.
This file is written with \\u escapes so it never trips itself.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ALLOWLIST = Path("scripts") / "no_cjk_allowlist.json"
EXEMPT_MARKER = "no-cjk-exempt"
MAX_BYTES = 2_000_000

# Han (basic, ext A, compatibility), CJK symbols/punctuation, fullwidth forms.
CJK = re.compile("[㐀-䶿一-鿿豈-﫿　-〿＀-￯]")

SKIP_SUFFIXES = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".mp4", ".mp3", ".wav",
    ".woff", ".woff2", ".ttf", ".otf", ".pdf", ".zip", ".gz", ".lock",
    ".svg", ".spdx.json",
}
SKIP_NAMES = {"uv.lock", "package-lock.json", "pnpm-lock.yaml", "no_cjk_allowlist.json"}


def tracked_files() -> list[Path]:
    out = subprocess.run(
        ["git", "ls-files", "-z"], capture_output=True, check=True
    ).stdout.decode("utf-8")
    return [Path(p) for p in out.split("\0") if p]


def skipped(path: Path) -> bool:
    name = path.name.lower()
    return (
        name in SKIP_NAMES
        or name.endswith(".spdx.json")
        or path.suffix.lower() in SKIP_SUFFIXES
    )


def scan(paths: list[Path] | None = None) -> dict[str, list[tuple[int, str]]]:
    hits: dict[str, list[tuple[int, str]]] = {}
    for path in paths if paths is not None else tracked_files():
        # The path itself counts: a Chinese file name is a hit on line 0.
        found: list[tuple[int, str]] = []
        if CJK.search(str(path)):
            found.append((0, f"<file name> {path}"))
        if not path.is_file() or skipped(path):
            if found:
                hits[path.as_posix()] = found
            continue
        try:
            if path.stat().st_size > MAX_BYTES:
                continue
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            if EXEMPT_MARKER in line:
                continue
            if CJK.search(line):
                found.append((lineno, line.strip()[:120]))
        if found:
            hits[path.as_posix()] = found
    return hits


def load_allowlist() -> dict[str, int]:
    if not ALLOWLIST.exists():
        return {}
    return json.loads(ALLOWLIST.read_text(encoding="utf-8"))


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args(argv)

    hits = scan()
    counts = {p: len(v) for p, v in sorted(hits.items())}

    if args.list:
        for path, entries in sorted(hits.items()):
            for lineno, text in entries:
                print(f"{path}:{lineno}  {text}")
        print(f"\nTotal {sum(counts.values())} lines / {len(counts)} files")
        return 0

    if args.write:
        ALLOWLIST.write_text(
            json.dumps(counts, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        print(f"Wrote {ALLOWLIST}: {sum(counts.values())} lines / {len(counts)} files")
        return 0

    allowed = load_allowlist()
    regressions = []
    for path, count in counts.items():
        budget = allowed.get(path)
        if budget is None:
            regressions.append(f"{path}: {count} line(s) with CJK (file not in allowlist)")
        elif count > budget:
            regressions.append(f"{path}: {budget} -> {count} line(s) with CJK")
    if regressions:
        print("FAIL: Chinese text increased (only English/Vietnamese are supported):", file=sys.stderr)
        for line in regressions:
            print(f"  {line}", file=sys.stderr)
        print(
            f"\nTranslate the text. If a line must keep CJK on purpose, add `{EXEMPT_MARKER}` to it.",
            file=sys.stderr,
        )
        return 1

    shrunk = {p: (allowed[p], counts.get(p, 0)) for p in allowed if counts.get(p, 0) < allowed[p]}
    print(f"OK: no new CJK (now {sum(counts.values())} lines / {len(counts)} files).")
    if shrunk:
        print("Hint: run `python scripts/check_no_cjk.py --write` to tighten the ratchet:")
        for path, (before, after) in sorted(shrunk.items())[:20]:
            print(f"  {path}: {before} -> {after}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
