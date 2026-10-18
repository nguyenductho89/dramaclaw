#!/usr/bin/env python3
"""Dependency license admission gate (DEP-11, hard zero).

This repo is distributed under Elastic-2.0 (closed distribution), so the dependency tree must not
introduce strong copyleft licenses (GPL / AGPL / SSPL -- their reach would extend to the whole
distribution). Weak copyleft (LGPL / MPL) used via "dynamic import, no static linking, no source
modification" is allowed and listed as a notice.

The scan target is **all distributions installed in the current environment** (importlib.metadata):
CI first runs `uv sync --frozen` to make the environment match uv.lock exactly, so this is
equivalent to auditing the whole lockfile tree, without depending on GitHub Dependency Graph's
manifest indexing. The complementary PR-incremental review is in
.github/workflows/dependency-review.yml (GitHub dependency-review-action).

License resolution order: License-Expression (PEP 639) -> License classifiers -> License field.
If all three are missing -> UNKNOWN, which also blocks (so "no metadata" cannot become a bypass),
unless listed in EXEMPT.

Exemptions: EXEMPT is consolidated in this file as "distribution name -> reason" (the same
philosophy as the frozen ruff rules in pyproject: changing an exemption must go through a PR).
An exempt package that is no longer in the dependency tree counts as a rotten exemption and also fails.

Usage:
    uv run python scripts/check_dependency_licenses.py

Strong copyleft / UNKNOWN without exemption / rotten exemption -> exit code 1.
"""
from __future__ import annotations

import importlib.metadata as importlib_metadata
import re
import sys

# Exemptions (lowercase distribution name -> reason). Limited to: a) metadata is missing but the
# real license has been verified by hand; b) multi-license (OR) where a non-viral branch can be chosen.
# The reason must state the real license and the evidence.
EXEMPT: dict[str, str] = {
    "tiktoken": "MIT -- the wheel has no License metadata; see the root LICENSE at github.com/openai/tiktoken",
    "wordninja": "MIT -- the distribution has no License metadata; see the root LICENSE at github.com/keredson/wordninja",
}

# Strong copyleft: a hit blocks. Note that LGPL/Lesser/Library are weak copyleft and must be
# excluded first, otherwise the "GPL" substring would wrongly kill LGPL too.
_DENY = re.compile(r"\bAGPL|\bSSPL|Affero", re.IGNORECASE)
_GPL = re.compile(r"GPL", re.IGNORECASE)
_WEAK = re.compile(r"LGPL|Lesser|Library", re.IGNORECASE)
_NOTICE = re.compile(r"LGPL|Lesser|Library|MPL|Mozilla", re.IGNORECASE)

UNKNOWN = "UNKNOWN"


def license_of(dist: importlib_metadata.Distribution) -> str:
    """Resolve the license description from distribution metadata (return UNKNOWN if not found)."""
    md = dist.metadata
    expr = md.get("License-Expression")
    if expr:
        return expr
    classifiers = [
        c.split("::")[-1].strip()
        for c in (md.get_all("Classifier") or [])
        if c.startswith("License")
    ]
    if classifiers:
        return " / ".join(classifiers)
    lic = (md.get("License") or "").strip()
    # Some packages stuff the entire license text into the License field -- only accept short identifiers
    if lic and "\n" not in lic and len(lic) <= 80:
        return lic
    return UNKNOWN


def classify(license_text: str) -> str:
    """Classify: denied (strong copyleft) / unknown / notice (weak copyleft) / ok."""
    if license_text == UNKNOWN:
        return "unknown"
    if _DENY.search(license_text):
        return "denied"
    # GPL hit and the whole string contains no weak-copyleft word -> strong copyleft.
    # ("LGPL-3.0-only" contains the GPL substring but is weak; mixed forms like "GPL-3.0 / LGPL"
    #  are let through as weak, and a real dual-license choice goes through an explicit EXEMPT entry.)
    if _GPL.search(license_text) and not _WEAK.search(license_text):
        return "denied"
    if _NOTICE.search(license_text):
        return "notice"
    return "ok"


def audit() -> tuple[list[str], list[str], list[str]]:
    """Scan the current environment. Returns (violations, notices, rotten_exempts)."""
    violations: list[str] = []
    notices: list[str] = []
    seen: set[str] = set()
    for dist in importlib_metadata.distributions():
        name = (dist.metadata.get("Name") or "").strip()
        if not name:
            continue
        seen.add(name.lower())
        lic = license_of(dist)
        kind = classify(lic)
        if name.lower() in EXEMPT:
            if kind in ("denied", "unknown"):
                continue  # verified by hand, let through
            # Package metadata has been fixed -> the exemption has lost its reason and counts as rotten (see below)
        if kind == "denied":
            violations.append(f"{name}: strong copyleft \"{lic}\"")
        elif kind == "unknown":
            violations.append(f"{name}: no license metadata (UNKNOWN)")
        elif kind == "notice":
            notices.append(f"{name}: {lic}")
    rotten = [
        f"{pkg}: exemption no longer needed (the package is not in the dependency tree, or its metadata can now be resolved) -- remove it from EXEMPT"
        for pkg in EXEMPT
        if pkg not in seen or classify(license_of_by_name(pkg)) not in ("denied", "unknown")
    ]
    return violations, notices, rotten


def license_of_by_name(pkg: str) -> str:
    try:
        return license_of(importlib_metadata.distribution(pkg))
    except importlib_metadata.PackageNotFoundError:
        return UNKNOWN


def main() -> int:
    violations, notices, rotten = audit()
    for line in notices:
        print(f"ℹ weak copyleft (used via dynamic import, allowed): {line}")
    for line in rotten:
        print(f"✖ rotten exemption {line}", file=sys.stderr)
    for line in violations:
        print(f"✖ {line}", file=sys.stderr)
    if violations or rotten:
        print(
            f"\n✖ Dependency license gate failed ({len(violations)} violation(s) / {len(rotten)} rotten exemption(s)).\n"
            "  A strong copyleft dependency conflicts with Elastic-2.0 distribution: swap in an alternative library, or, if it is a "
            "genuine misjudgment / dual license, exempt it with a stated reason in EXEMPT in scripts/check_dependency_licenses.py.",
            file=sys.stderr,
        )
        return 1
    print(f"✓ Dependency license gate passed ({len(notices)} weak-copyleft notice(s), {len(EXEMPT)} exemption(s)).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
