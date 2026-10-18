#!/usr/bin/env python3
"""Frontend hard-coded CJK text check (i18n ratchet) plus locale key parity.

Usage:
    python scripts/check_frontend_i18n.py            # check against the allowlist
    python scripts/check_frontend_i18n.py --write    # regenerate the allowlist (only for deliberate exemptions)
    python scripts/check_frontend_i18n.py --list     # print every hit without comparing to the allowlist

Scan scope: after stripping comments, **any** remaining CJK character in .ts/.tsx
files under `frontend/src` counts as one hit. The UI only ships English (en) and
Vietnamese (vi), so CJK text in source is always a leak.

An earlier version only recognized three patterns (JSX text / UI attributes / the
first toast argument) and missed more than half of the canvas hits, e.g. setStatus
calls, ternaries inside title props, module-level label constants and template
literals. It is better to over-report than to let non-English text leak into the
UI; lines that must keep CJK on purpose (parser field aliases, CJK punctuation in
regexes) get `// i18n-exempt`.

The allowlist is a ratchet: the count already in a file may only go down, never up,
and a new file with any hit fails immediately.

The existing backlog has been cleared, so the repo has no allowlist file: a missing
file means an empty allowlist and any hit fails. Only generate it with `--write` for
a temporary exemption, and do not run it casually.

Locale parity: `frontend/public/locales/en/translation.json` and
`frontend/public/locales/vi/translation.json` must define identical key sets,
otherwise i18next renders the raw key.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

FRONTEND_SRC = os.path.join("frontend", "src")
ALLOWLIST = os.path.join("scripts", "frontend_i18n_allowlist.json")
LOCALES_DIR = os.path.join("frontend", "public", "locales")
LOCALES = ("en", "vi")

CJK = re.compile(r"[\u4e00-\u9fff]")
# `/*` starts a block comment only when not preceded by an identifier/quote/slash;
# otherwise a MIME wildcard such as `'image/*'` would be taken as a comment start and
# swallow hundreds of real hits after it.
BLOCK_COMMENT = re.compile(r"(?<![\w'\"/])/\*.*?\*/", re.S)
COMMENT_LINE = re.compile(r"^\s*(//|\*)")
# The marker is either `// i18n-exempt` or, in JSX where only block comments work,
# `{/* i18n-exempt */}`. The latter is erased by BLOCK_COMMENT, so markers are always
# searched in the raw text (see scan()).
EXEMPT = re.compile(r"(?://|/\*)\s*i18n-exempt(?!-)")
# Protocol value tables (enums the backend mirrors verbatim, canonical defaults
# written into saved JSON) keep CJK as a whole block; tagging every line with
# `// i18n-exempt` would make the table unreadable, so there is a pair of range markers.
EXEMPT_START = re.compile(r"(?://|/\*)\s*i18n-exempt-start")
EXEMPT_END = re.compile(r"(?://|/\*)\s*i18n-exempt-end")
# t(key, { defaultValue: "..." }): the key exists and the default is only a fallback.
DEFAULT_VALUE = re.compile(r"defaultValue:\s*([\"'])(?:(?!\1).)*\1")



def scan() -> tuple[dict[str, list[tuple[int, str]]], list[str]]:
    """Return (hits, exemption marker errors).

    Marker errors are returned separately instead of being merged into hits: a broken
    range marker makes the scanner **under-report**, which silently disables the gate,
    so it must fail unconditionally and cannot be offset by the allowlist.
    """
    hits: dict[str, list[tuple[int, str]]] = {}
    marker_errors: list[str] = []
    for root, dirs, files in os.walk(FRONTEND_SRC):
        dirs[:] = [d for d in dirs if d != "node_modules"]
        if "__tests__" in root.split(os.sep):
            continue
        for name in sorted(files):
            if not name.endswith((".ts", ".tsx")):
                continue
            if name.endswith((".test.ts", ".test.tsx", ".d.ts")):
                continue
            path = os.path.join(root, name).replace(os.sep, "/")
            with open(path, encoding="utf-8") as handle:
                raw = handle.read()
            # Erase block comments whole but keep the newlines so line numbers still match.
            source = BLOCK_COMMENT.sub(lambda m: "\n" * m.group(0).count("\n"), raw)
            found: list[tuple[int, str]] = []
            in_exempt_block = False
            exempt_start_line = 0
            # Markers are searched in the raw text, hits in the comment-stripped text; line numbers match one to one.
            for lineno, (raw_line, line) in enumerate(
                zip(raw.split("\n"), source.split("\n")), 1
            ):
                if EXEMPT_START.search(raw_line):
                    if in_exempt_block:
                        marker_errors.append(
                            f"{path}:{lineno}: i18n-exempt-start is nested inside the exempt block "
                            f"opened on line {exempt_start_line} (ranges cannot be nested)"
                        )
                    in_exempt_block = True
                    exempt_start_line = lineno
                    continue
                if EXEMPT_END.search(raw_line):
                    if not in_exempt_block:
                        marker_errors.append(
                            f"{path}:{lineno}: i18n-exempt-end has no matching i18n-exempt-start"
                        )
                    in_exempt_block = False
                    exempt_start_line = 0
                    continue
                if in_exempt_block:
                    continue
                if COMMENT_LINE.match(line) or EXEMPT.search(raw_line):
                    continue
                # Drop trailing line comments to avoid false positives from CJK in comments (URLs like `://` are not cut).
                stripped = re.sub(r"(?<![:\"'])//[^\"']*$", "", line)
                # `t(key, { defaultValue: "..." })` is an i18n-wired fallback, not hard-coded text.
                stripped = DEFAULT_VALUE.sub("", stripped)
                if CJK.search(stripped):
                    found.append((lineno, line.strip()[:120]))
            if in_exempt_block:
                # With a missing end marker, all CJK after that line is skipped and the scan still
                # passes with 0 hits. That silently disables the ratchet, which is far worse
                # than missing one string, so report it as an error.
                marker_errors.append(
                    f"{path}:{exempt_start_line}: i18n-exempt-start has no i18n-exempt-end before "
                    "the end of the file, so all CJK after it was silently skipped"
                )
            if found:
                hits[path] = found
    return hits, marker_errors


def load_allowlist() -> dict[str, int]:
    if not os.path.exists(ALLOWLIST):
        return {}
    with open(ALLOWLIST, encoding="utf-8") as handle:
        return json.load(handle)


def _flatten_keys(value: object, prefix: str = "") -> set[str]:
    if isinstance(value, dict) and value:
        keys: set[str] = set()
        for key, child in value.items():
            keys |= _flatten_keys(child, f"{prefix}.{key}" if prefix else key)
        return keys
    return {prefix} if prefix else set()


def check_locale_parity() -> list[str]:
    """Compare the key sets of the en and vi translation files; return error lines."""
    key_sets: dict[str, set[str]] = {}
    errors: list[str] = []
    for lang in LOCALES:
        path = os.path.join(LOCALES_DIR, lang, "translation.json")
        try:
            with open(path, encoding="utf-8") as handle:
                key_sets[lang] = _flatten_keys(json.load(handle))
        except (OSError, ValueError) as exc:
            errors.append(f"{path}: cannot be read ({exc})")
    if len(key_sets) == len(LOCALES):
        reference, other = LOCALES
        for key in sorted(key_sets[reference] - key_sets[other]):
            errors.append(f"locales/{other}: missing key {key} (present in {reference})")
        for key in sorted(key_sets[other] - key_sets[reference]):
            errors.append(f"locales/{reference}: missing key {key} (present in {other})")
    return errors


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args(argv)

    hits, marker_errors = scan()
    counts = {path: len(v) for path, v in sorted(hits.items())}

    # A broken marker makes the scanner under-report, so fail first in every mode:
    # `--write` in particular must not freeze the under-reported counts into the
    # allowlist while a range is broken.
    if marker_errors:
        print("FAIL: i18n exemption range markers are invalid (the check would silently skip CJK):", file=sys.stderr)
        for line in marker_errors:
            print(f"  {line}", file=sys.stderr)
        print(
            "\n`// i18n-exempt-start` must have a matching `// i18n-exempt-end`, and ranges cannot be nested.",
            file=sys.stderr,
        )
        return 1

    if args.list:
        for path, entries in sorted(hits.items()):
            for lineno, text in entries:
                print(f"{path}:{lineno}  {text}")
        print(f"\nTotal {sum(counts.values())} hits / {len(counts)} files")
        return 0

    if args.write:
        with open(ALLOWLIST, "w", encoding="utf-8") as handle:
            json.dump(counts, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
        print(f"Wrote {ALLOWLIST}: {sum(counts.values())} hits / {len(counts)} files")
        return 0

    parity_errors = check_locale_parity()
    if parity_errors:
        print("FAIL: locale files are out of sync (i18next would render the raw key):", file=sys.stderr)
        for line in parity_errors:
            print(f"  {line}", file=sys.stderr)
        return 1

    allowed = load_allowlist()
    regressions: list[str] = []
    for path, count in counts.items():
        budget = allowed.get(path)
        if budget is None:
            regressions.append(f"{path}: {count} new hard-coded CJK hit(s) (file is not in the allowlist)")
        elif count > budget:
            regressions.append(f"{path}: {budget} -> {count}, hard-coded CJK text increased")

    if regressions:
        print("FAIL: hard-coded CJK text in the frontend increased (it would leak into the English/Vietnamese UI):", file=sys.stderr)
        for line in regressions:
            print(f"  {line}", file=sys.stderr)
        print(
            "\nUse `t(\"...\")` and add the key to both frontend/public/locales/en/translation.json"
            " and frontend/public/locales/vi/translation.json."
            "\nA single line that must keep CJK can carry `// i18n-exempt`; wrap a whole protocol value"
            " table in `// i18n-exempt-start` / `// i18n-exempt-end`.",
            file=sys.stderr,
        )
        return 1

    shrunk = {p: (allowed[p], counts.get(p, 0)) for p in allowed if counts.get(p, 0) < allowed[p]}
    stale = [p for p in allowed if p not in counts]
    print(f"OK: hard-coded CJK did not increase (currently {sum(counts.values())} hits / {len(counts)} files); locales en/vi are in sync.")
    if shrunk or stale:
        print(
            "Note: the entries below shrank or reached zero; run "
            "`python scripts/check_frontend_i18n.py --write` to tighten the ratchet:"
        )
        for path, (before, after) in sorted(shrunk.items()):
            print(f"  {path}: {before} -> {after}")
        for path in sorted(stale):
            print(f"  {path}: cleared")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
