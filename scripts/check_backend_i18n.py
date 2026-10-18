#!/usr/bin/env python3
"""i18n ratchet for user-facing backend text.

Usage:
    python scripts/check_backend_i18n.py            # check against the allowlist
    python scripts/check_backend_i18n.py --write    # regenerate the allowlist (use only for deliberate exemptions)
    python scripts/check_backend_i18n.py --list     # print all hits without comparing to the allowlist

`scripts/check_frontend_i18n.py` only looks at frontend/, so CJK text written directly in the
backend slipped through everywhere: task progress bars, task log panels, and queue toasts are all
finished strings the backend hands to the frontend to echo verbatim.

The scan scope is **not** "any CJK in the backend" -- the backend has plenty of legitimate CJK
(LLM prompts, server-side logs, literals used for parsing, exception messages), and a blanket rule
would only drown the signal. It recognizes only the four places that flow to the frontend:

  * the `current_task=` keyword argument
  * the `logs=[...]` keyword argument
  * the arguments of `report(...)` / `update_progress(...)` / `log(...)`
  * the `"message"` value in a returned dict

The fix is to wrap the text in `lmsg("<code>", "<English text>", **params)` (see
novelvideo/i18n_message.py), then add the entry to both sides of
frontend/public/locales/{en,vi}/translation.json. The text inside `lmsg(...)` is the **fallback
text** and does not count as a hit; the scan does not descend into lmsg calls.

The allowlist is a ratchet: the count already in the file may only go down, never up, and a new
file that hits fails immediately.
"""
from __future__ import annotations

import argparse
import ast
import json
import os
import re
import sys

BACKEND_SRC = os.path.join("src", "novelvideo")
ALLOWLIST = os.path.join("scripts", "backend_i18n_allowlist.json")

CJK = re.compile(r"[\u4e00-\u9fff]")
# These callbacks write their arguments straight into task state, and users see them verbatim in the progress bar / log panel.
PROGRESS_CALLS = {"report", "update_progress", "log"}
# Legitimate containers of fallback text: on a hit, the whole subtree is skipped.
LOCALIZABLE = {"lmsg", "LocalizableMessage"}


def _call_name(node: ast.Call) -> str:
    func = node.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return ""


def _has_cjk(node: ast.AST) -> bool:
    """Whether the node contains a CJK literal (including the literal fragments of an f-string).

    `ast.walk` cannot be used: it would dive into `lmsg("code", "text")` and count the already
    migrated fallback text as a hit again, so the correct `report(0.1, lmsg(...))` form would be
    flagged. So recurse by hand and skip the whole subtree on an lmsg / LocalizableMessage call.
    """
    if isinstance(node, ast.Call) and _call_name(node) in LOCALIZABLE:
        return False
    if isinstance(node, ast.Constant):
        return isinstance(node.value, str) and bool(CJK.search(node.value))
    return any(_has_cjk(child) for child in ast.iter_child_nodes(node))


class Scanner(ast.NodeVisitor):
    def __init__(self) -> None:
        self.hits: list[tuple[int, str]] = []

    def _record(self, node: ast.AST, what: str) -> None:
        self.hits.append((node.lineno, what))

    def visit_Call(self, node: ast.Call) -> None:
        if _call_name(node) in LOCALIZABLE:
            # Already a localized message; the text inside is the fallback text itself.
            return
        name = _call_name(node)
        for kw in node.keywords:
            if kw.arg in ("current_task", "logs") and _has_cjk(kw.value):
                self._record(node, f"{kw.arg}= was passed a CJK literal")
        if name in PROGRESS_CALLS:
            for arg in node.args:
                if _has_cjk(arg):
                    self._record(node, f"the argument of {name}() is a CJK literal")
                    break
        self.generic_visit(node)

    def visit_Dict(self, node: ast.Dict) -> None:
        for key, value in zip(node.keys, node.values):
            if (
                isinstance(key, ast.Constant)
                and key.value == "message"
                and _has_cjk(value)
            ):
                self._record(value, 'the returned "message" is a CJK literal')
        self.generic_visit(node)


def scan() -> dict[str, list[tuple[int, str]]]:
    hits: dict[str, list[tuple[int, str]]] = {}
    for root, dirs, files in os.walk(BACKEND_SRC):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for name in sorted(files):
            if not name.endswith(".py"):
                continue
            path = os.path.join(root, name).replace(os.sep, "/")
            with open(path, encoding="utf-8") as handle:
                source = handle.read()
            try:
                tree = ast.parse(source, filename=path)
            except SyntaxError:
                continue
            scanner = Scanner()
            scanner.visit(tree)
            # A trailing `# i18n-exempt` exempts the few spots that are genuinely not user-facing.
            lines = source.split("\n")
            kept = [
                (lineno, what)
                for lineno, what in scanner.hits
                if "i18n-exempt" not in lines[lineno - 1]
            ]
            if kept:
                hits[path] = sorted(set(kept))
    return hits


def load_allowlist() -> dict[str, int]:
    if not os.path.exists(ALLOWLIST):
        return {}
    with open(ALLOWLIST, encoding="utf-8") as handle:
        return json.load(handle)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args(argv)

    hits = scan()
    counts = {path: len(v) for path, v in sorted(hits.items())}

    if args.list:
        for path, entries in sorted(hits.items()):
            for lineno, what in entries:
                print(f"{path}:{lineno}  {what}")
        print(f"\nTotal {sum(counts.values())} hit(s) / {len(counts)} file(s)")
        return 0

    if args.write:
        with open(ALLOWLIST, "w", encoding="utf-8") as handle:
            json.dump(counts, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
        print(f"Wrote {ALLOWLIST}: {sum(counts.values())} hit(s) / {len(counts)} file(s)")
        return 0

    allowed = load_allowlist()
    regressions: list[str] = []
    for path, count in counts.items():
        budget = allowed.get(path)
        if budget is None:
            regressions.append(f"{path}: {count} new hardcoded CJK hit(s) (this file is not in the allowlist)")
        elif count > budget:
            regressions.append(f"{path}: {budget} -> {count}, hardcoded CJK increased")

    if regressions:
        print(
            "✖ Hardcoded CJK in user-facing backend text increased (it would leak through verbatim in the English UI):",
            file=sys.stderr,
        )
        for line in regressions:
            print(f"  {line}", file=sys.stderr)
        print(
            '\nReplace the CJK text with English wrapped in `lmsg("<code>", "<English text>", **params)` (novelvideo/i18n_message.py), '
            "\nand add the entry to both sides of frontend/public/locales/{en,vi}/translation.json."
            "\nSpots that are genuinely not user-facing may add `# i18n-exempt` at the end of the line.",
            file=sys.stderr,
        )
        return 1

    shrunk = {p: (allowed[p], counts.get(p, 0)) for p in allowed if counts.get(p, 0) < allowed[p]}
    stale = [p for p in allowed if p not in counts]
    print(f"✓ Hardcoded CJK in user-facing backend text did not increase (currently {sum(counts.values())} hit(s) / {len(counts)} file(s)).")
    if shrunk or stale:
        print(
            "Note: the entries below have decreased or reached zero; run "
            "`python scripts/check_backend_i18n.py --write` to tighten the ratchet:"
        )
        for path, (before, after) in sorted(shrunk.items()):
            print(f"  {path}: {before} -> {after}")
        for path in sorted(stale):
            print(f"  {path}: cleared")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
