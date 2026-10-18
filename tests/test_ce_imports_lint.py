from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from lint_ce_imports import scan  # noqa: E402


def test_ce_has_no_ee_imports() -> None:
    """This repo must not import packages that do not belong to it (novelvideo_ee / supertale_admin /
    novelvideo.control_plane). Hard zero: any occurrence fails. The CI gate is
    .github/workflows/ce-import-lint.yml."""
    findings = scan(REPO_ROOT)
    assert findings == [], "CE contains forbidden EE imports:\n" + "\n".join(
        f.describe() for f in findings
    )
