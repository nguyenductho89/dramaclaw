"""Per-beat identity image resolution for a `character_map` built from a batch of beats.

Regression (YuiDrama beats 12-14, 2026-10-31): the map holds ONE default image per
character, taken from the first identity among the batch's beats, and no `identities`
list. Rendering beats 10-14 together therefore gave the kosode beats the schoolgirl
face (bangs, wrong outfit) while a single-beat render was right.
"""

from __future__ import annotations

from pathlib import Path

from novelvideo.generators.nanobanana_grid import (
    qwen_edit_identity_references,
    resolve_identity_image_path,
)


def _assets(tmp_path: Path) -> Path:
    char_dir = tmp_path / "assets" / "characters" / "Yui"
    (char_dir / "identities").mkdir(parents=True)
    for name in ("modern_schoolgirl", "edo_kosode"):
        (char_dir / "identities" / f"{name}.png").write_bytes(b"png")
    (char_dir / "portrait.png").write_bytes(b"png")
    return char_dir


def _batch_shaped_map(char_dir: Path) -> dict:
    """What `_build_character_map` returns for beats [10..14]: default image = the
    FIRST identity's, no `identities` list, empty `identity_ref_images`."""
    first = str(char_dir / "identities" / "modern_schoolgirl.png")
    return {
        "Yui": {
            "portrait_path": first,
            "ref_path": first,
            "identity_ref_images": {},
            "identity_appearances": {"edo_kosode": "indigo kosode"},
        }
    }


def test_kosode_beat_gets_its_own_image_in_a_mixed_batch(tmp_path):
    char_dir = _assets(tmp_path)
    cmap = _batch_shaped_map(char_dir)
    refs = qwen_edit_identity_references(cmap, {"detected_identities": ["Yui_edo_kosode"]})
    assert [Path(r["path"]).name for r in refs] == ["edo_kosode.png"]
    assert refs[0]["appearance_details"] == "indigo kosode"


def test_first_identity_still_resolves_to_its_own_image(tmp_path):
    cmap = _batch_shaped_map(_assets(tmp_path))
    refs = qwen_edit_identity_references(cmap, {"detected_identities": ["Yui_modern_schoolgirl"]})
    assert [Path(r["path"]).name for r in refs] == ["modern_schoolgirl.png"]


def test_resolver_order_rows_then_identity_ref_images_then_assets_dir(tmp_path):
    char_dir = _assets(tmp_path)
    row_image = tmp_path / "row.png"
    row_image.write_bytes(b"png")
    ref_image = tmp_path / "ref.png"
    ref_image.write_bytes(b"png")
    base = {"portrait_path": str(char_dir / "portrait.png")}
    # 1. explicit identity row wins
    info = dict(base, identities=[{"identity_name": "edo_kosode", "primary_reference": str(row_image)}],
                identity_ref_images={"edo_kosode": str(ref_image)})
    assert resolve_identity_image_path(info, "edo_kosode") == str(row_image)
    # 2. then identity_ref_images
    info = dict(base, identity_ref_images={"edo_kosode": str(ref_image)})
    assert resolve_identity_image_path(info, "edo_kosode") == str(ref_image)
    # 3. then the assets directory next to a plain portrait.png
    assert resolve_identity_image_path(base, "edo_kosode") == str(char_dir / "identities" / "edo_kosode.png")


def test_resolver_returns_empty_when_nothing_matches(tmp_path):
    char_dir = _assets(tmp_path)
    info = {"portrait_path": str(char_dir / "portrait.png")}
    assert resolve_identity_image_path(info, "no_such_identity") == ""
    assert resolve_identity_image_path(info, "") == ""
    assert resolve_identity_image_path({}, "edo_kosode") == ""


def test_unknown_identity_still_falls_back_to_the_default_image(tmp_path):
    cmap = _batch_shaped_map(_assets(tmp_path))
    refs = qwen_edit_identity_references(cmap, {"detected_identities": ["Yui_ghost"]})
    assert [Path(r["path"]).name for r in refs] == ["modern_schoolgirl.png"]
