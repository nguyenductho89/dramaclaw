from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from lint_ee_terms import collect_targets, scan  # noqa: E402


def test_repo_has_no_forbidden_package_names() -> None:
    """This repo must not contain package names that do not belong to it (in strings/comments/docs/config).
    Hard zero: any occurrence fails. Complements import-lint; the CI gate is
    .github/workflows/ee-terms.yml."""
    offenders: list[str] = []
    for path in collect_targets([]):
        for lineno, label, _ in scan(path):
            offenders.append(f"{path}:{lineno}: {label}")
    assert offenders == [], "forbidden package names found:\n" + "\n".join(offenders)
