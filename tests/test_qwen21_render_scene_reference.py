"""`_qwen21_first_scene_reference` — picks the scene photo that goes in as the
third image of the single-character Qwen 2.1 render (2026-10-31)."""

from __future__ import annotations

from PIL import Image

from novelvideo.generators.nanobanana_grid import _qwen21_first_scene_reference


def _png(path) -> str:
    Image.new("RGB", (8, 8), (10, 20, 30)).save(path, format="PNG")
    return str(path)


def test_returns_first_scene_ref_with_mime(tmp_path):
    master = _png(tmp_path / "master.png")
    reverse = _png(tmp_path / "reverse.png")
    refs = [
        {"kind": "previous_grid", "path": _png(tmp_path / "sketch.png")},
        {"kind": "scene", "path": master},
        {"kind": "scene", "path": reverse},
        {"kind": "prop", "path": _png(tmp_path / "phone.png")},
    ]
    data, mime = _qwen21_first_scene_reference(refs)
    assert data == open(master, "rb").read()
    assert mime == "image/png"


def test_none_when_no_scene_or_unreadable():
    assert _qwen21_first_scene_reference([]) is None
    assert _qwen21_first_scene_reference([{"kind": "prop", "path": "/x.png"}]) is None
    assert _qwen21_first_scene_reference([{"kind": "scene", "path": "/no/such.png"}]) is None
    assert _qwen21_first_scene_reference([{"kind": "scene"}]) is None


def test_skips_unreadable_scene_and_uses_next(tmp_path):
    good = _png(tmp_path / "good.png")
    data, _mime = _qwen21_first_scene_reference(
        [{"kind": "scene", "path": "/no/such.png"}, {"kind": "scene", "path": good}]
    )
    assert data == open(good, "rb").read()


# --- identity sheet face panel -------------------------------------------------

import io  # noqa: E402

from novelvideo.generators.nanobanana_grid import _qwen21_face_panel_bytes  # noqa: E402
from novelvideo.generators.prompt_builder import build_qwen21_render_prompt  # noqa: E402


def _sheet(widths=(300, 280, 280, 280), height=600) -> bytes:
    """Landscape strip like a real identity sheet: a close-up panel then
    full-body panels, each with its own flat background shade."""
    shades = [(200, 200, 205), (120, 125, 130), (60, 60, 70), (170, 150, 140)]
    img = Image.new("RGB", (sum(widths), height))
    x = 0
    for w, shade in zip(widths, shades):
        img.paste(Image.new("RGB", (w, height), shade), (x, 0))
        x += w
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_face_panel_is_the_first_panel_of_a_sheet():
    out = _qwen21_face_panel_bytes(_sheet())
    assert out is not None
    width, height = Image.open(io.BytesIO(out)).size
    assert height == 600 and abs(width - 300) <= 2


def test_face_panel_none_for_single_portrait_or_weak_seams():
    portrait = io.BytesIO()
    Image.new("RGB", (400, 600), (120, 120, 120)).save(portrait, format="PNG")
    assert _qwen21_face_panel_bytes(portrait.getvalue()) is None  # not landscape
    flat = io.BytesIO()
    Image.new("RGB", (1400, 700), (120, 120, 120)).save(flat, format="PNG")
    assert _qwen21_face_panel_bytes(flat.getvalue()) is None  # no seam at all
    assert _qwen21_face_panel_bytes(b"not an image") is None


def _beat():
    return {"visual_description": "{{Yui}} walks through the [[curtain]]."}


def test_identity_sheet_prompt_numbers_tags_in_attach_order():
    both = build_qwen21_render_prompt(
        [_beat()], stage="full", scene_reference=True, identity_sheet=True
    )
    assert "<image3> is a reference photo of the same location" in both
    assert "<image4> is a character sheet of the same person" in both
    only_sheet = build_qwen21_render_prompt([_beat()], stage="full", identity_sheet=True)
    assert "<image3> is a character sheet of the same person" in only_sheet
    assert "<image4>" not in only_sheet


def test_identity_sheet_moves_outfit_off_image2_and_pins_the_pose():
    with_sheet = build_qwen21_render_prompt([_beat()], stage="full", identity_sheet=True)
    assert "face, ethnicity, gender, age and hairstyle from <image2>" in with_sheet
    assert "outfit from <image2>" not in with_sheet
    plain = build_qwen21_render_prompt([_beat()], stage="full")
    assert "hairstyle and outfit from <image2>" in plain
    for text in (with_sheet, plain):
        assert "come only from the mannequin in <image1>" in text
