"""Exemption range marker validation for `scripts/check_frontend_i18n.py`, plus locale parity.

review #447: after `i18n-exempt-start` the scanner did not verify it was closed, so a
missing `-end` silently skipped all CJK after it in that file while the check still
passed with 0 hits, silently disabling the ratchet.

CJK samples are written as \\u escapes so this file itself stays free of CJK.
"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path

import pytest

pytestmark = pytest.mark.m07

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "check_frontend_i18n.py"


def _load_scanner():
    spec = importlib.util.spec_from_file_location("check_frontend_i18n", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _run_scan_in(tmp_path: Path, source: str):
    """Build a frontend/src tree in a temp dir and scan it; the scanner reads relative paths."""
    src = tmp_path / "frontend" / "src"
    src.mkdir(parents=True)
    (src / "sample.ts").write_text(source, encoding="utf-8")
    module = _load_scanner()
    cwd = os.getcwd()
    os.chdir(tmp_path)
    try:
        return module.scan()
    finally:
        os.chdir(cwd)


def test_unclosed_exempt_block_is_reported(tmp_path):
    hits, errors = _run_scan_in(
        tmp_path,
        'const a = "x";\n'
        "// i18n-exempt-start\n"
        'const table = { \u65e5: "day" };\n'
        'const leaked = "\u8fd9\u884c\u662f\u771f\u7684\u786c\u7f16\u7801";\n',
    )
    # With the block unclosed, the CJK after it really is skipped (that is exactly the danger)...
    assert hits == {}
    # ...so the marker validation has to catch it.
    assert len(errors) == 1
    assert "i18n-exempt-start" in errors[0]
    assert "sample.ts:2" in errors[0]


def test_stray_exempt_end_is_reported(tmp_path):
    _, errors = _run_scan_in(tmp_path, 'const a = "x";\n// i18n-exempt-end\n')
    assert len(errors) == 1
    assert "has no matching i18n-exempt-start" in errors[0]


def test_nested_exempt_start_is_reported(tmp_path):
    _, errors = _run_scan_in(
        tmp_path,
        "// i18n-exempt-start\n// i18n-exempt-start\n// i18n-exempt-end\n",
    )
    assert any("nested" in e for e in errors)


def test_balanced_exempt_block_is_clean(tmp_path):
    hits, errors = _run_scan_in(
        tmp_path,
        "// i18n-exempt-start\n"
        'const table = { \u65e5: "day" };\n'
        "// i18n-exempt-end\n"
        'const leaked = "\u8fd9\u884c\u8981\u88ab\u6293\u5230";\n',
    )
    assert errors == []
    assert [lineno for lineno, _ in hits["frontend/src/sample.ts"]] == [4]


def test_marker_error_fails_the_check_even_with_write(tmp_path, capsys):
    """With broken markers even `--write` must fail, otherwise the under-reported counts would be frozen into the allowlist."""
    src = tmp_path / "frontend" / "src"
    src.mkdir(parents=True)
    (src / "sample.ts").write_text("// i18n-exempt-start\n", encoding="utf-8")
    module = _load_scanner()
    cwd = os.getcwd()
    os.chdir(tmp_path)
    try:
        assert module.main([]) == 1
        assert module.main(["--write"]) == 1
        assert not (tmp_path / "scripts" / "frontend_i18n_allowlist.json").exists()
    finally:
        os.chdir(cwd)


def test_en_and_vi_locale_key_sets_match():
    """The real locale files must define identical key sets (no raw keys rendered)."""
    module = _load_scanner()
    cwd = os.getcwd()
    os.chdir(REPO_ROOT)
    try:
        assert module.check_locale_parity() == []
    finally:
        os.chdir(cwd)


def test_locale_parity_reports_missing_keys(tmp_path):
    for lang, body in (("en", '{"a": {"b": "x"}, "c": "y"}'), ("vi", '{"a": {"b": "x"}}')):
        folder = tmp_path / "frontend" / "public" / "locales" / lang
        folder.mkdir(parents=True)
        (folder / "translation.json").write_text(body, encoding="utf-8")
    module = _load_scanner()
    cwd = os.getcwd()
    os.chdir(tmp_path)
    try:
        errors = module.check_locale_parity()
    finally:
        os.chdir(cwd)
    assert errors == ["locales/vi: missing key c (present in en)"]
