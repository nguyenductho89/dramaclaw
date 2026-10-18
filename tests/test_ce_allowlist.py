from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import ce_allowlist  # noqa: E402


def test_manifest_well_formed() -> None:
    """Every exemption must state path / guards / reason, and guards must come from the known set."""
    data = ce_allowlist.load()
    assert data["marker"]["inline"].strip()
    known = set(ce_allowlist.known_guards())
    assert known, "guards.known must not be empty"
    for entry in ce_allowlist.skip_entries():
        assert {"path", "guards", "reason"} <= entry.keys(), f"exemption missing fields: {entry}"
        assert entry["reason"].strip(), f"exemption missing reason: {entry}"
        assert entry["guards"], f"exemption missing guards: {entry}"
        assert set(entry["guards"]) <= known, f"unknown guard: {entry}"


def test_no_stale_skip_paths() -> None:
    """Registered exemption paths must really exist - keeps the allowlist from rotting as files are deleted or renamed."""
    stale = [
        entry["path"]
        for entry in ce_allowlist.skip_entries()
        if not (REPO_ROOT / entry["path"]).is_file()
    ]
    assert stale == [], "allowlist points to files that do not exist (please clean up):\n" + "\n".join(stale)


def test_linters_consume_manifest() -> None:
    """Drift guard: the effective exemptions of both linters must come from the manifest, and the key self-referential entries must be registered."""
    from lint_banned_words import ALLOW_MARKER as BW_MARKER
    from lint_banned_words import SKIP_PATHS as BW_SKIPS
    from lint_ee_terms import ALLOW_MARKER as EE_MARKER
    from lint_ee_terms import SKIP_PATHS as EE_SKIPS

    marker = ce_allowlist.inline_marker()
    assert BW_MARKER == marker
    assert EE_MARKER == marker
    assert BW_SKIPS == ce_allowlist.skip_paths("banned-words")
    assert EE_SKIPS == ce_allowlist.skip_paths("ee-terms")
    # The rule files and the manifest itself must self-exempt, otherwise they hit themselves
    assert "scripts/lint_ee_terms.py" in EE_SKIPS
    assert "ce-allowlist.toml" in EE_SKIPS
    assert "scripts/lint_banned_words.py" in BW_SKIPS
