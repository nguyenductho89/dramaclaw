from novelvideo.models import NovelScene, resolve_scene_plate, resolve_scene_plate_from_records
from novelvideo.utils.screenplay_scene_parser import parse_scene_blocks


def test_resolve_scene_plate_prefers_variant_time_plate() -> None:
    record_name, time_baked = resolve_scene_plate(
        "Bathroom",
        "Leak",
        "nighttime",
        {"Bathroom", "Bathroom_Leak", "Bathroom_Leak_nighttime"},
    )

    assert record_name == "Bathroom_Leak_nighttime"
    assert time_baked is True


def test_missing_scene_time_keeps_legacy_day_plate_resolution() -> None:
    block = parse_scene_blocks("1-1 Cafe INT\nZhang San: Hello.")[0]

    assert block.time_of_day == "day"
    assert block.time_inferred is True

    record_name, time_baked = resolve_scene_plate(
        block.location,
        "",
        block.time_of_day,
        {"Cafe", "Cafe_day"},
    )

    assert record_name == "Cafe_day"
    assert time_baked is True


def test_resolve_scene_plate_keeps_variant_before_base_time() -> None:
    record_name, time_baked = resolve_scene_plate(
        "Bathroom",
        "Leak",
        "nighttime",
        {"Bathroom", "Bathroom_nighttime", "Bathroom_Leak"},
    )

    assert record_name == "Bathroom_Leak"
    assert time_baked is False


def test_resolve_scene_plate_uses_base_time_without_variant() -> None:
    record_name, time_baked = resolve_scene_plate(
        "Bathroom",
        "",
        "night",
        {"Bathroom", "Bathroom_nighttime"},
    )

    assert record_name == "Bathroom_nighttime"
    assert time_baked is True


def test_resolve_scene_plate_marks_time_variant_as_time_baked() -> None:
    record_name, time_baked = resolve_scene_plate(
        "Bathroom",
        "nighttime",
        "night",
        {"Bathroom", "Bathroom_nighttime"},
    )

    assert record_name == "Bathroom_nighttime"
    assert time_baked is True


def test_resolve_scene_plate_marks_variant_tail_time_as_time_baked() -> None:
    record_name, time_baked = resolve_scene_plate(
        "Bathroom",
        "Leak_nighttime",
        "night",
        {"Bathroom", "Bathroom_Leak_nighttime"},
    )

    assert record_name == "Bathroom_Leak_nighttime"
    assert time_baked is True


def test_resolve_scene_plate_beat_time_picks_matching_time_plate() -> None:
    record_name, time_baked = resolve_scene_plate(
        "Bathroom",
        "Leak",
        "day",
        {"Bathroom", "Bathroom_Leak", "Bathroom_Leak_night", "Bathroom_Leak_day"},
    )

    assert record_name == "Bathroom_Leak_day"
    assert time_baked is True


def test_resolve_scene_plate_skips_wrong_time_plate_when_beat_time_differs() -> None:
    record_name, time_baked = resolve_scene_plate(
        "Bathroom",
        "Leak",
        "day",
        {"Bathroom", "Bathroom_Leak", "Bathroom_Leak_night"},
    )

    assert record_name == "Bathroom_Leak"
    assert time_baked is False


def test_resolve_scene_plate_ignores_legacy_time_suffix_when_beat_time_empty() -> None:
    record_name, time_baked = resolve_scene_plate(
        "Bathroom",
        "Leak_night",
        "",
        {"Bathroom", "Bathroom_Leak", "Bathroom_Leak_night"},
    )

    assert record_name == "Bathroom_Leak"
    assert time_baked is False


def test_resolve_scene_plate_skips_legacy_time_suffix_when_beat_time_differs() -> None:
    record_name, time_baked = resolve_scene_plate(
        "Bathroom",
        "Leak_night",
        "day",
        {"Bathroom", "Bathroom_Leak", "Bathroom_Leak_night"},
    )

    assert record_name == "Bathroom_Leak"
    assert time_baked is False


def test_resolve_scene_plate_from_records_uses_structured_time_plate() -> None:
    record_name, time_baked = resolve_scene_plate_from_records(
        "Bathroom",
        "Leak",
        "day",
        [
            NovelScene(name="Bathroom"),
            NovelScene(name="Bathroom_Leak", base_scene_id="Bathroom", variant_id="Leak"),
            NovelScene(
                name="Bathroom_Leak_day",
                base_scene_id="Bathroom",
                variant_id="Leak",
                time_of_day="day",
            ),
        ],
    )

    assert record_name == "Bathroom_Leak_day"
    assert time_baked is True


def test_resolve_scene_plate_from_records_normalizes_time_alias_before_lookup() -> None:
    record_name, time_baked = resolve_scene_plate_from_records(
        "Bathroom",
        "Leak",
        "late night",
        [
            NovelScene(name="Bathroom"),
            NovelScene(name="Bathroom_Leak", base_scene_id="Bathroom", variant_id="Leak"),
            NovelScene(
                name="Bathroom_Leak_night",
                base_scene_id="Bathroom",
                variant_id="Leak",
                time_of_day="night",
            ),
        ],
    )

    assert record_name == "Bathroom_Leak_night"
    assert time_baked is True


def test_resolve_scene_plate_from_records_skips_wrong_time_plate() -> None:
    record_name, time_baked = resolve_scene_plate_from_records(
        "Bathroom",
        "Leak",
        "day",
        [
            NovelScene(name="Bathroom"),
            NovelScene(name="Bathroom_Leak", base_scene_id="Bathroom", variant_id="Leak"),
            NovelScene(
                name="Bathroom_Leak_night",
                base_scene_id="Bathroom",
                variant_id="Leak",
                time_of_day="night",
            ),
        ],
    )

    assert record_name == "Bathroom_Leak"
    assert time_baked is False


def test_resolve_scene_plate_from_records_empty_beat_time_does_not_select_time_plate() -> None:
    record_name, time_baked = resolve_scene_plate_from_records(
        "Bathroom",
        "Leak",
        "",
        [
            NovelScene(name="Bathroom"),
            NovelScene(name="Bathroom_Leak", base_scene_id="Bathroom", variant_id="Leak"),
            NovelScene(
                name="Bathroom_Leak_night",
                base_scene_id="Bathroom",
                variant_id="Leak",
                time_of_day="night",
            ),
        ],
    )

    assert record_name == "Bathroom_Leak"
    assert time_baked is False


def test_resolve_scene_plate_empty_time_matches_existing_scene_resolution() -> None:
    record_name, time_baked = resolve_scene_plate(
        "Bathroom",
        "Leak",
        "",
        {"Bathroom", "Bathroom_Leak"},
    )

    assert record_name == "Bathroom_Leak"
    assert time_baked is False


def test_resolve_scene_plate_unknown_names_do_not_assume_time_plate_exists() -> None:
    record_name, time_baked = resolve_scene_plate("Bathroom", "Leak", "nighttime", None)

    assert record_name == "Bathroom_Leak"
    assert time_baked is False
