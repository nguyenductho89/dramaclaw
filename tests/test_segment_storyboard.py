from pathlib import Path

from PIL import Image

from novelvideo.generators.segment_storyboard import (
    CELL_H,
    CELL_W,
    build_segment_storyboard,
)


def _img(path: Path, color, size=(300, 500)):
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, color).save(path)


def _beats(n):
    return [{"beat_number": i} for i in range(1, n + 1)]


def test_grid_layout_and_order(tmp_path):
    colors = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0)]
    for i, c in enumerate(colors, start=1):
        _img(tmp_path / "sketches" / "ep001" / f"beat_{i:02d}.png", c, (CELL_W, CELL_H))
    ref = build_segment_storyboard(tmp_path, 1, "seg_ep001_a", _beats(4))
    assert ref is not None and ref.panel_count == 4
    grid = Image.open(ref.path)
    assert grid.size == (3 * CELL_W, 2 * CELL_H)
    # row-major order: panel 4 is first cell of row 2
    assert grid.getpixel((CELL_W // 2, CELL_H // 2)) == colors[0]
    assert grid.getpixel((CELL_W + CELL_W // 2, CELL_H // 2)) == colors[1]
    assert grid.getpixel((CELL_W // 2, CELL_H + CELL_H // 2)) == colors[3]


def test_single_panel_is_one_cell(tmp_path):
    _img(tmp_path / "sketches" / "ep001" / "beat_01.png", (9, 9, 9))
    ref = build_segment_storyboard(tmp_path, 1, "c", _beats(1))
    assert Image.open(ref.path).size == (CELL_W, CELL_H)


def test_falls_back_to_frame_when_no_sketch(tmp_path):
    _img(tmp_path / "sketches" / "ep001" / "beat_01.png", (1, 1, 1))
    _img(tmp_path / "frames" / "ep001" / "beat_02.png", (2, 2, 2))
    ref = build_segment_storyboard(tmp_path, 1, "c", _beats(2))
    assert [p.source for p in ref.panels] == ["sketch", "frame"]


def test_none_when_a_beat_has_no_image(tmp_path):
    _img(tmp_path / "sketches" / "ep001" / "beat_01.png", (1, 1, 1))
    assert build_segment_storyboard(tmp_path, 1, "c", _beats(2)) is None


def test_cached_until_source_changes(tmp_path):
    src = tmp_path / "sketches" / "ep001" / "beat_01.png"
    _img(src, (1, 1, 1))
    first = build_segment_storyboard(tmp_path, 1, "c", _beats(1))
    m1 = Path(first.path).stat().st_mtime_ns
    build_segment_storyboard(tmp_path, 1, "c", _beats(1))
    assert Path(first.path).stat().st_mtime_ns == m1
    _img(src, (200, 1, 1))
    build_segment_storyboard(tmp_path, 1, "c", _beats(1))
    assert Path(first.path).stat().st_mtime_ns != m1


def test_reference_plan_skips_storyboard_when_slots_full_or_no_characters(tmp_path, monkeypatch):
    from novelvideo.api.routes import generation as g

    for i in (1, 2):
        _img(tmp_path / "sketches" / "ep001" / f"beat_{i:02d}.png", (5, 5, 5))
    beats = _beats(2)
    chain = "seg_ep001_a"

    def refs(n):
        return [{"identity_id": f"i{k}", "name": f"n{k}", "path": f"/x/{k}.png", "appearance_details": ""} for k in range(n)]

    for n, expect_sb, expect_warn in ((0, False, False), (1, True, False), (3, False, True)):
        monkeypatch.setattr(g, "_multishot_shared_references", lambda *_a, n=n: (refs(n), ""))
        r, sb, err, warn = g._chain_reference_plan({}, beats, str(tmp_path), 1, chain)
        assert (sb is not None) == expect_sb and bool(warn) == expect_warn and not err

    # manual (non-segment) chains never get a storyboard
    monkeypatch.setattr(g, "_multishot_shared_references", lambda *_a: (refs(1), ""))
    assert g._chain_reference_plan({}, beats, str(tmp_path), 1, "manual_chain")[1] is None
