"""Tests for the repo-wide no-CJK ratchet (scripts/check_no_cjk.py)."""
from __future__ import annotations

import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check_no_cjk.py"
spec = importlib.util.spec_from_file_location("check_no_cjk", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

HAN = "中文"
FULLWIDTH_COMMA = "，"


def test_detects_han_and_fullwidth_punctuation(tmp_path):
    f = tmp_path / "a.py"
    f.write_text(f"x = 1\ny = '{HAN}'\nz = 'a{FULLWIDTH_COMMA}b'\n", encoding="utf-8")
    hits = mod.scan([f])
    assert [n for n, _ in hits[f.as_posix()]] == [2, 3]


def test_vietnamese_and_english_are_clean(tmp_path):
    f = tmp_path / "vi.md"
    f.write_text("Xin chào, đây là tiếng Việt.\nHello\n", encoding="utf-8")
    assert mod.scan([f]) == {}


def test_exempt_marker_skips_line(tmp_path):
    f = tmp_path / "b.py"
    f.write_text(f"x = '{HAN}'  # no-cjk-exempt\n", encoding="utf-8")
    assert mod.scan([f]) == {}


def test_chinese_file_name_is_a_hit(tmp_path):
    f = tmp_path / f"{HAN}.md"
    f.write_text("hello\n", encoding="utf-8")
    hits = mod.scan([f])
    assert hits[f.as_posix()][0][0] == 0
