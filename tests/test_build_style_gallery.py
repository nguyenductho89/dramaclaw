from __future__ import annotations

import importlib.util
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location(
    "build_style_gallery", REPO_ROOT / "scripts" / "build_style_gallery.py"
)
assert _SPEC and _SPEC.loader
build_style_gallery = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(build_style_gallery)


def test_clean_style_prompt_strips_dangling_trailing_punctuation() -> None:
    raw = "  Japanese slice-of-life healing imagery, calm and soothing mood, professional cinematic standard,  "

    assert (
        build_style_gallery.clean_style_prompt(raw)
        == "Japanese slice-of-life healing imagery, calm and soothing mood, professional cinematic standard"
    )


def test_clean_style_prompt_keeps_internal_line_breaks() -> None:
    raw = "Nineties neo-realist film, pure film texture\n\nPlain natural composition, accurate period feel\n"

    assert build_style_gallery.clean_style_prompt(raw) == (
        "Nineties neo-realist film, pure film texture\nPlain natural composition, accurate period feel"
    )


def test_clean_style_prompt_keeps_sentence_ending_period() -> None:
    raw = "A fateful sense of power struggle, premium cinematic texture."

    assert build_style_gallery.clean_style_prompt(raw) == "A fateful sense of power struggle, premium cinematic texture."


def test_style_meta_covers_all_styles_with_unique_ids() -> None:
    meta = build_style_gallery.STYLE_META

    assert len(meta) == 45
    assert len({item["id"] for item in meta}) == 45
    assert len({item["src"] for item in meta}) == 45
    assert {item["category"] for item in meta} == {
        "period", "urban", "era", "lifestyle", "scifi", "genre", "expressive",
        # The three new categories that came with the second asset batch
        "animation", "painting", "myth",
    }


def test_style_meta_order_groups_categories() -> None:
    """Each category must form one contiguous block -- the wall's "All" view lays cards out in this order.

    It asserts "exactly one run per category" rather than enumerating all 45 entries: the
    latter would need rewriting every time a style is added while still asserting the same
    thing. The order in which categories appear is locked too; it is the filter tab order.
    """
    import itertools

    categories = [item["category"] for item in build_style_gallery.STYLE_META]
    runs = [(key, len(list(group))) for key, group in itertools.groupby(categories)]

    assert runs == [
        ("period", 3),
        ("urban", 4),
        ("era", 10),
        ("lifestyle", 2),
        ("scifi", 5),
        ("genre", 5),
        ("expressive", 2),
        ("animation", 4),
        ("painting", 7),
        ("myth", 3),
    ]


def test_style_meta_ids_are_ascii_snake_case() -> None:
    import re

    for item in build_style_gallery.STYLE_META:
        assert re.fullmatch(r"[a-z][a-z0-9_]*", item["id"]), item["id"]


def test_render_manifest_matches_the_loader_format() -> None:
    entries = [
        {
            "id": "demo",
            "label": "Example",
            "category": "urban",
            "cover": "demo/cover.webp",
            "samples": ["demo/female.webp"],
            "style_prompt": "Example prompt",
        }
    ]

    text = build_style_gallery.render_manifest(entries, "2026-08-07")
    parsed = json.loads(text)

    assert text.endswith("\n")
    assert "Example" in text
    assert parsed == {"version": "2026-08-07", "templates": entries}


def test_shipped_manifest_matches_style_meta() -> None:
    """The script's STYLE_META must stay in sync with the built-in manifest in the repo, otherwise rerunning the script silently swaps the style library."""
    shipped = json.loads(
        (
            REPO_ROOT / "src" / "novelvideo" / "freezone" / "style_templates.json"
        ).read_text(encoding="utf-8")
    )

    assert [item["id"] for item in shipped["templates"]] == [
        item["id"] for item in build_style_gallery.STYLE_META
    ]
    assert [item["label"] for item in shipped["templates"]] == [
        item["label"] for item in build_style_gallery.STYLE_META
    ]
    assert [item["category"] for item in shipped["templates"]] == [
        item["category"] for item in build_style_gallery.STYLE_META
    ]


def _make_style_dir(
    root: Path,
    cover_name: str,
    person_names: tuple[str, ...] = (
        "female.png",
        "youth.png",
        "male.png",
        "elder.png",
    ),
) -> Path:
    style_dir = root / "some_style"
    style_dir.mkdir()
    for name in (*person_names, cover_name):
        (style_dir / name).write_bytes(b"")
    return style_dir


def test_sample_files_accept_both_batches_person_naming() -> None:
    """The two batches name character images differently; one output slot must accept both."""
    by_output = {dst: names for names, dst in build_style_gallery.SAMPLE_FILES}

    assert by_output["female.webp"] == ("female.png", "female_young.png")
    assert by_output["male.webp"] == ("male.png", "male_young.png")
    assert "female_young.png" in build_style_gallery.SAMPLE_SOURCE_NAMES


def test_locate_cover_ignores_second_batch_person_images(tmp_path: Path) -> None:
    """Second-batch covers commonly use short names (sixties_poster/poster.png); the only PNG left after excluding character images is the fallback.

    If character images were not recognized after a rename, this would turn into "several
    candidates" and error out -- which is exactly what this test guards against.
    """
    style_dir = _make_style_dir(
        tmp_path,
        "poster.png",
        person_names=("female_young.png", "youth.png", "male_young.png", "elder.png"),
    )

    assert build_style_gallery.locate_cover(style_dir, "sixties_poster").name == "poster.png"


def test_locate_cover_prefers_the_file_named_after_the_style(tmp_path: Path) -> None:
    style_dir = _make_style_dir(tmp_path, "some_style.png")

    assert build_style_gallery.locate_cover(style_dir, "some_style").name == "some_style.png"


def test_locate_cover_falls_back_to_the_only_non_sample_png(tmp_path: Path) -> None:
    """In the Feishu export the documentary_realism cover was misnamed retro_narrative.png; take the only remaining PNG."""
    style_dir = _make_style_dir(tmp_path, "retro_narrative.png")

    assert build_style_gallery.locate_cover(style_dir, "some_style").name == "retro_narrative.png"


def test_locate_cover_refuses_to_guess_between_several_candidates(
    tmp_path: Path,
) -> None:
    import pytest

    style_dir = _make_style_dir(tmp_path, "alpha.png")
    (style_dir / "beta.png").write_bytes(b"")

    with pytest.raises(SystemExit):
        build_style_gallery.locate_cover(style_dir, "some_style")
