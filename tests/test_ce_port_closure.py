from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "check_ce_port_closure.py"

sys.path.insert(0, str(REPO_ROOT / "scripts"))

from check_ce_port_closure import _classify  # noqa: E402


def test_ce_port_closure_passes() -> None:
    """In pure CE mode all 11 ports must be satisfied by novelvideo.ports.local.* with no EE dependency.
    Run in a subprocess to isolate ensure_bootstrap()'s changes to the module-level _BOOTSTRAPPED/_PORTS
    so other tests in the same process are not polluted. The CI gate is in .github/workflows/ci.yml."""
    proc = subprocess.run(
        [sys.executable, str(SCRIPT)],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )
    assert proc.returncode == 0, f"CE port closure failed:\n{proc.stdout}\n{proc.stderr}"


@pytest.mark.parametrize(
    "module",
    [
        "novelvideo_ee.auth_service",
        "supertale_admin.main",
        "novelvideo.control_plane.auth",
        "novelvideo.services.foo",  # a non-local prefix also counts as a violation
    ],
)
def test_classify_flags_non_ce_impl(module: str) -> None:
    assert _classify(module) is not None


@pytest.mark.parametrize(
    "module",
    ["novelvideo.ports.local", "novelvideo.ports.local.auth"],
)
def test_classify_allows_ce_local_impl(module: str) -> None:
    assert _classify(module) is None
