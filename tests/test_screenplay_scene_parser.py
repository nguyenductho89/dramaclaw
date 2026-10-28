import pytest

from novelvideo.cognee.script_parser import parse_scenes
from novelvideo.time_of_day import normalize_time_of_day
from novelvideo.utils.screenplay_quality import assess_screenplay_scene_headers
from novelvideo.utils.screenplay_quality import check_screenplay_import_quality
from novelvideo.utils.screenplay_scene_parser import parse_scene_blocks
from novelvideo.utils.screenplay_scene_parser import is_scene_start_line
from novelvideo.workflows.literal_script_writing import LiteralScriptWritingWorkflow


@pytest.mark.parametrize("time_of_day", ["清晨", "上午", "正午", "午后", "白天", "黄昏", "夜晚"])
def test_canonical_time_tokens_are_not_part_of_scene_locations(time_of_day):
    blocks = parse_scene_blocks(f"1-1 场景：急诊部 {time_of_day} 内\n△医生停下。")
    assert blocks[0].location == "急诊部"
    assert normalize_time_of_day(blocks[0].time_of_day) == time_of_day


def test_parse_one_line_scene_block_header():
    text = """
SCENE (1) Location: Noodle Shop, NIGHT, INT; Characters: Du Chen, Young Man, Young Woman
Du Chen: Boss, the bill please.
"""

    blocks = parse_scene_blocks(text)

    assert len(blocks) == 1
    assert blocks[0].location == "Noodle Shop"
    assert blocks[0].time_of_day == "night"
    assert blocks[0].interior_exterior == "int"
    assert blocks[0].characters == ["Du Chen", "Young Man", "Young Woman"]
    assert blocks[0].lines == ["Du Chen: Boss, the bill please."]


def test_parse_three_line_scene_block_header():
    text = """
SCENE (1)
Location: Noodle Shop, NIGHT, INT
Characters: Du Chen, Young Man, Young Woman
Du Chen: Boss, the bill please.
"""

    blocks = parse_scene_blocks(text)

    assert len(blocks) == 1
    assert blocks[0].location == "Noodle Shop"
    assert blocks[0].time_of_day == "night"
    assert blocks[0].interior_exterior == "int"
    assert blocks[0].characters == ["Du Chen", "Young Man", "Young Woman"]
    assert blocks[0].lines == ["Du Chen: Boss, the bill please."]


def test_parse_repairable_split_scene_header_without_polluting_body():
    text = """
SCENE: 1
Location: Noodle Shop
Time: NIGHT
INT/EXT: INT
Characters: Du Chen, Young Man
Du Chen: Boss, the bill please.
"""

    blocks = parse_scene_blocks(text)

    assert len(blocks) == 1
    assert blocks[0].scene_no == "1"
    assert blocks[0].location == "Noodle Shop"
    assert normalize_time_of_day(blocks[0].time_of_day) == "night"
    assert blocks[0].interior_exterior == "int"
    assert blocks[0].characters == ["Du Chen", "Young Man"]
    assert blocks[0].lines == ["Du Chen: Boss, the bill please."]


def test_parse_bare_scene_numbers_when_followed_by_location_headers():
    text = """
EPISODE 1 - First Meeting
1
Cafe DAY INT
Characters: Zhang San
Zhang San: I'm here.
(2)
Office NIGHT INT
Characters: Li Si
Li Si: Come in.
"""

    blocks = parse_scene_blocks(text)

    assert [(block.scene_no, block.location) for block in blocks] == [
        ("1", "Cafe"),
        ("2", "Office"),
    ]
    assert blocks[0].lines == ["Zhang San: I'm here."]
    assert blocks[1].lines == ["Li Si: Come in."]


def test_do_not_treat_standalone_number_as_scene_without_location_header():
    text = """
EPISODE 1 - First Meeting
1-1 Cafe DAY INT
Characters: Zhang San
Zhang San: What year is it?
2026
Zhang San: So that's how it is.
"""

    blocks = parse_scene_blocks(text)

    assert len(blocks) == 1
    assert blocks[0].lines == [
        "Zhang San: What year is it?",
        "2026",
        "Zhang San: So that's how it is.",
    ]


def test_parse_fountain_scene_headers_with_characters_and_action_lines():
    text = """
EPISODE 1
EXT. IMPERIAL PALACE TERRACE - NIGHT
Characters: Emperor Zhengde, Attending Eunuch
△ Flames blaze toward the Qianqing Palace.
EMPEROR ZHENGDE: What a magnificent fireworks display.
INT. SIDE HALL GUARD ROOM - NIGHT
Characters: Black-robed Assassin (Li Yan), Official Wang
△ Thick smoke pours in through the window cracks.
LI YAN (O.S.): The Zhu family's empire has long rotted at its roots.
EXT. PALACE WALLS AND ROOFTOPS - NIGHT
Characters: Li Yan, Embroidered Guards, Lu Zheng
△ Li Yan races across the flying eaves.
LU ZHENG: Seal the nine gates at once.
"""

    blocks = parse_scene_blocks(text)

    assert is_scene_start_line("EXT. IMPERIAL PALACE TERRACE - NIGHT") is True
    assert len(blocks) == 3
    assert [
        (
            block.episode,
            block.location,
            block.time_of_day,
            block.interior_exterior,
            block.characters,
        )
        for block in blocks
    ] == [
        (1, "IMPERIAL PALACE TERRACE", "night", "ext", ["Emperor Zhengde", "Attending Eunuch"]),
        (1, "SIDE HALL GUARD ROOM", "night", "int", ["Black-robed Assassin", "Official Wang"]),
        (1, "PALACE WALLS AND ROOFTOPS", "night", "ext", ["Li Yan", "Embroidered Guards", "Lu Zheng"]),
    ]
    assert blocks[0].lines == [
        "△ Flames blaze toward the Qianqing Palace.",
        "EMPEROR ZHENGDE: What a magnificent fireworks display.",
    ]
    assert blocks[1].lines == [
        "△ Thick smoke pours in through the window cracks.",
        "LI YAN (O.S.): The Zhu family's empire has long rotted at its roots.",
    ]
    assert blocks[2].lines == [
        "△ Li Yan races across the flying eaves.",
        "LU ZHENG: Seal the nine gates at once.",
    ]


def test_parse_numbered_legacy_header_with_people_line():
    text = """
1-1, Old Shanghai Sealed Gate Ruins NIGHT EXT
Characters: Lu Yuan, Ghost-Pattern Wood Imp, Mysterious Man

LU YUAN (V.O.): Old beams, old stumps, a century-old gate tower.
△ The ruins are deathly still, the gate tower half collapsed.
"""

    blocks = parse_scene_blocks(text)

    assert len(blocks) == 1
    assert blocks[0].episode == 1
    assert blocks[0].scene_no == "1"
    assert blocks[0].location == "Old Shanghai Sealed Gate Ruins"
    assert blocks[0].time_of_day == "night"
    assert blocks[0].interior_exterior == "ext"
    assert blocks[0].characters == ["Lu Yuan", "Ghost-Pattern Wood Imp", "Mysterious Man"]
    assert blocks[0].lines == [
        "LU YUAN (V.O.): Old beams, old stumps, a century-old gate tower.",
        "△ The ruins are deathly still, the gate tower half collapsed.",
    ]


def test_parse_dot_numbered_scene_with_interior_before_time():
    text = """
EPISODE 11
11.1 Li Family Living Room INT DAY
Characters: Li Mei, Wang Fang
▲ Li Mei puts her schoolbag on the table.
Li Mei: I'm back.
11.2 School Lab EXT NIGHT
Characters: Li Mei, Teacher
▲ The night wind blows past the lab building.
"""

    blocks = parse_scene_blocks(text)

    assert [
        (
            block.episode,
            block.scene_no,
            block.location,
            block.time_of_day,
            block.interior_exterior,
        )
        for block in blocks
    ] == [
        (11, "1", "Li Family Living Room", "day", "int"),
        (11, "2", "School Lab", "night", "ext"),
    ]
    assert blocks[0].lines == ["▲ Li Mei puts her schoolbag on the table.", "Li Mei: I'm back."]


def test_scene_boundary_preserves_adjacent_sublocations_for_later_scene_planning():
    blocks = parse_scene_blocks(
        "EPISODE 1\n1.2 Elite Academy Classroom/Stairwell INT DAY\nCharacters: Li Mei\nLi Mei: Hurry."
    )

    assert len(blocks) == 1
    assert blocks[0].location == "Elite Academy Classroom/Stairwell"
    assert blocks[0].time_of_day == "day"
    assert blocks[0].interior_exterior == "int"


def test_parse_insert_scene_and_standalone_insert_annotation():
    text = """
EPISODE 11
+SCENE Li Family Kitchen INT NIGHT
Characters: Grandma
▲ Grandma turns off the stove.
+SCENE
11.2 School Lab INT DAY
Characters: Li Mei
Li Mei: The experiment is done.
"""

    blocks = parse_scene_blocks(text)

    assert len(blocks) == 2
    assert blocks[0].location == "Li Family Kitchen"
    assert blocks[0].time_of_day == "night"
    assert blocks[1].scene_no == "2"
    assert blocks[1].location == "School Lab"


def test_incomplete_insert_scene_keeps_boundary_for_warning_and_normalization():
    blocks = parse_scene_blocks(
        "EPISODE 1\n+SCENE Dance Studio Mirror DAY\nCharacters: Li Mei\n▲ Li Mei looks at herself in the mirror."
    )

    assert len(blocks) == 1
    assert blocks[0].location == "Dance Studio Mirror"
    assert blocks[0].time_of_day == "day"
    assert blocks[0].interior_exterior == ""
    assert is_scene_start_line("+SCENE Dance Studio Mirror DAY") is True


def test_insert_scene_with_handwritten_punctuation_never_drops_the_heading():
    text = """
+SCENE Hospital Corridor.
+SCENE (3) School Auditorium!
+SCENE Playground?
"""

    blocks = parse_scene_blocks(text)

    assert [block.header_line for block in blocks] == [
        "+SCENE Hospital Corridor.",
        "+SCENE (3) School Auditorium!",
        "+SCENE Playground?",
    ]
    assert [block.location for block in blocks] == [
        "Hospital Corridor",
        "School Auditorium",
        "Playground",
    ]
    assert blocks[1].scene_no == "3"


def test_version_number_is_not_treated_as_partial_scene_header():
    blocks = parse_scene_blocks("EPISODE 1\n1.2 release notes\nThis is a plain note.")

    assert len(blocks) == 1
    assert blocks[0].header_line == ""
    assert blocks[0].lines == ["1.2 release notes", "This is a plain note."]


def test_parse_english_and_vietnamese_fountain_scene_headers():
    text = """
INT. LIVING ROOM - NIGHT
Zhang San: I'm back.
EXT. SCHOOL YARD - DAY #2A#
LUCY: WAIT FOR ME.
NỘI. PHÒNG KHÁCH - ĐÊM
An: Anh về rồi.
"""

    blocks = parse_scene_blocks(text)

    assert [
        (block.location, block.time_of_day, block.interior_exterior)
        for block in blocks
    ] == [
        ("LIVING ROOM", "night", "int"),
        ("SCHOOL YARD", "day", "ext"),
        ("PHÒNG KHÁCH", "night", "int"),
    ]


def test_parse_explicit_english_scene_markers_and_metadata():
    text = """Episode 1
SCENE 1 — THE EMPTY PLATFORM
Location: Seoul Subway Station
Time: 11:47 PM
Characters: Ji-won, Old Woman
JI-WON: Hello?
SCENE 2 — THE LAST TRAIN
The train stops.
"""

    blocks = [block for block in parse_scene_blocks(text) if block.header_line]

    assert len(blocks) == 2
    assert blocks[0].episode == 1
    assert blocks[0].scene_no == "1"
    assert blocks[0].location == "Seoul Subway Station"
    assert blocks[0].time_of_day == "11:47 PM"
    assert blocks[0].characters == ["Ji-won", "Old Woman"]
    assert blocks[0].lines == ["JI-WON: Hello?"]
    assert blocks[1].scene_no == "2"
    assert blocks[1].lines == ["The train stops."]


@pytest.mark.parametrize(
    "prose_line",
    [
        "Scene 2 was rewritten yesterday.",
        "Chapter 2 explains why the train stopped.",
    ],
)
def test_numbered_english_prose_is_preserved_as_body_content(prose_line):
    blocks = parse_scene_blocks(prose_line)

    assert len(blocks) == 1
    assert blocks[0].header_line == ""
    assert blocks[0].lines == [prose_line]


def test_parse_numbered_english_scene_and_constrained_sense_compatibility():
    text = """Episode 1
1-1 Scene: Living room at home, daytime
Characters: Me, Father, Mother
ME: Stop.
1-2 Sense: Brother's bedroom, nighttime
Characters: Sister, Brother
SISTER: Listen.
"""

    blocks = [block for block in parse_scene_blocks(text) if block.header_line]

    assert [block.scene_no for block in blocks] == ["1", "2"]
    assert [block.location for block in blocks] == [
        "Living room at home",
        "Brother's bedroom",
    ]
    assert [block.time_of_day for block in blocks] == ["daytime", "nighttime"]
    assert blocks[0].characters == ["Me", "Father", "Mother"]
    assert blocks[1].characters == ["Sister", "Brother"]


def test_parse_bare_sense_only_with_structured_location_and_time():
    text = """Episode 1
Sense: Living room at home, daytime
Time: First Grade
Characters: Me, Father, Mother
ME: Stop.
1-2 Sense: Brother's bedroom, nighttime
Characters: Sister, Brother
SISTER: Listen.
"""

    blocks = [block for block in parse_scene_blocks(text) if block.header_line]

    assert len(blocks) == 2
    assert blocks[0].location == "Living room at home"
    assert blocks[0].time_of_day == "daytime"
    assert blocks[0].characters == ["Me", "Father", "Mother"]
    assert blocks[0].lines == ["Time: First Grade", "ME: Stop."]
    assert blocks[1].scene_no == "2"


def test_bare_sense_and_production_labels_remain_body_content():
    text = """SCENE 1 — PLATFORM
Sense: something is wrong.
Sense 2 people entered.
NARRATOR:
The station is empty.
SFX:
Metal scraping.
VISUAL PROMPT:
Dark tunnel.
"""

    blocks = [block for block in parse_scene_blocks(text) if block.header_line]

    assert len(blocks) == 1
    assert blocks[0].lines == [
        "Sense: something is wrong.",
        "Sense 2 people entered.",
        "NARRATOR:",
        "The station is empty.",
        "SFX:",
        "Metal scraping.",
        "VISUAL PROMPT:",
        "Dark tunnel.",
    ]


def test_parse_vietnamese_fountain_headings():
    blocks = parse_scene_blocks(
        "NỘI. QUÁN CÀ PHÊ - NGÀY\nAn: Xin chào.\nNỘI. PHÒNG TRÀ - ĐÊM\nBình: Mời ngồi."
    )

    assert [
        (block.location, block.time_of_day, block.interior_exterior)
        for block in blocks
    ] == [
        ("QUÁN CÀ PHÊ", "day", "int"),
        ("PHÒNG TRÀ", "night", "int"),
    ]


def test_fountain_short_prefix_does_not_match_prose():
    blocks = parse_scene_blocks("Interior monologue - DAY\nZhang San recalls the past.")

    assert len(blocks) == 1
    assert blocks[0].header_line == ""
    assert blocks[0].lines == ["Interior monologue - DAY", "Zhang San recalls the past."]


def test_mixed_international_heading_is_repairable_by_design():
    blocks = parse_scene_blocks("INT./EXT. CAR - NIGHT\nThe car crosses a tunnel.")

    assert len(blocks) == 1
    assert blocks[0].location == "CAR"
    assert blocks[0].time_of_day == "night"
    assert blocks[0].interior_exterior == ""


def test_parse_numbered_marker_then_location_line():
    text = """
1-1
Old Shanghai Sealed Gate Ruins NIGHT EXT
Characters: Lu Yuan, Ghost-Pattern Wood Imp, Mysterious Man
LU YUAN (V.O.): Old beams, old stumps, a century-old gate tower.
"""

    blocks = parse_scene_blocks(text)

    assert len(blocks) == 1
    assert blocks[0].header_line == "1-1"
    assert blocks[0].location == "Old Shanghai Sealed Gate Ruins"
    assert blocks[0].time_of_day == "night"
    assert blocks[0].interior_exterior == "ext"
    assert blocks[0].characters == ["Lu Yuan", "Ghost-Pattern Wood Imp", "Mysterious Man"]
    assert blocks[0].lines == ["LU YUAN (V.O.): Old beams, old stumps, a century-old gate tower."]


def test_cognee_scene_parser_uses_shared_scene_blocks():
    text = """
1-1, Old Shanghai Sealed Gate Ruins NIGHT EXT
Characters: Lu Yuan, Ghost-Pattern Wood Imp, Mysterious Man
LU YUAN (V.O.): Old beams, old stumps, a century-old gate tower.
"""

    scenes = parse_scenes(text)

    assert len(scenes) == 1
    assert scenes[0].name == "Old Shanghai Sealed Gate Ruins"
    assert scenes[0].time_of_day == "night"
    assert scenes[0].interior is False
    assert scenes[0].characters == ["Lu Yuan", "Ghost-Pattern Wood Imp", "Mysterious Man"]
    assert scenes[0].context_lines == ["LU YUAN (V.O.): Old beams, old stumps, a century-old gate tower."]


def test_literal_scene_blocks_accept_multiline_headers():
    lines = [
        "SCENE (1)",
        "Location: Noodle Shop, NIGHT, INT",
        "Characters: Du Chen, Young Man",
        "Du Chen: Boss, the bill please.",
    ]

    blocks = LiteralScriptWritingWorkflow._build_scene_blocks(lines)

    assert len(blocks) == 1
    assert blocks[0].location == "Noodle Shop"
    assert blocks[0].time_of_day == "night"
    assert blocks[0].characters == ["Du Chen", "Young Man"]
    assert blocks[0].lines == ["Du Chen: Boss, the bill please."]


def test_literal_scene_blocks_normalize_vietnamese_time_to_closed_choice():
    lines = [
        "3-1, Phòng ngủ cung điện ĐÊM NỘI",
        "Characters: Tô Đường, Thẩm Vãn",
        "△ Ánh nến chập chờn.",
    ]

    blocks = LiteralScriptWritingWorkflow._build_scene_blocks(lines)

    assert len(blocks) == 1
    assert blocks[0].location == "Phòng ngủ cung điện"
    assert blocks[0].time_of_day == "night"


def test_literal_parse_scene_header_normalizes_time_to_closed_choice():
    header = LiteralScriptWritingWorkflow._parse_scene_header("Phoenix Palace Bedchamber NIGHT INT")

    assert header == {
        "location": "Phoenix Palace Bedchamber",
        "time_of_day": "night",
    }


def test_screenplay_quality_accepts_legacy_numbered_headers():
    text = """
1-1, Old Shanghai Sealed Gate Ruins NIGHT EXT
Characters: Lu Yuan, Ghost-Pattern Wood Imp, Mysterious Man
LU YUAN (V.O.): Old beams, old stumps, a century-old gate tower.
Mysterious Man: You should not have come here.
Lu Yuan: I am already here.
Mysterious Man: Then stay.
Lu Yuan: Try me.
"""

    report = check_screenplay_import_quality(text)

    assert report.metrics["total_scene_headers"] == 1
    assert not any(issue.code == "missing_scene_headers" for issue in report.blocking_issues)


def test_parse_vietnamese_time_scene_header():
    text = """
3-1, Phòng ngủ cung điện ĐÊM NỘI
Characters: Tô Đường, Thẩm Vãn
△ Ánh nến chập chờn.
"""

    blocks = parse_scene_blocks(text)

    assert len(blocks) == 1
    assert blocks[0].location == "Phòng ngủ cung điện"
    assert blocks[0].time_of_day == "night"
    assert blocks[0].interior_exterior == "int"


def test_parse_vietnamese_time_scene_header_for_planner():
    text = """
2-1, Tường ngoài võ trường CHIỀU NGOẠI
Characters: Tô Đường, Thẩm Vãn
△ Gió đêm cuốn lá rụng.
"""

    scenes = parse_scenes(text)

    assert len(scenes) == 1
    assert scenes[0].name == "Tường ngoài võ trường"
    assert scenes[0].time_of_day == "afternoon"
    assert scenes[0].interior is False


# The block below is word for word the same as DRAMA_FORMAT_EXAMPLE_EN in
# frontend/src/components/ingest/NovelFormatDialog.tsx. It is the template English-UI users copy,
# and what is copied must be a standard format the parser recognizes -- otherwise the docs teach people to write scripts that fail to import.
DOCUMENTED_ENGLISH_FORMAT_EXAMPLE = """EPISODE 1

INT. SEOUL SUBWAY STATION - NIGHT
Characters: Ji-won, Old Woman

△ Rainwater drips from the ceiling. The platform is completely empty.

JI-WON: Is anyone here?

OLD WOMAN: You should not have come this late.


INT. SUBWAY CAR - NIGHT
Characters: Ji-won, Old Woman, Boy

△ The train doors close. The lights flicker above the empty seats.

JI-WON: Where is this train going?

OLD WOMAN: To the last station.


EXT. SEOUL STREET - DAWN
Characters: Ji-won

△ Ji-won steps onto the deserted street as the first morning light appears.

JI-WON: I made it back.
"""


def test_documented_english_format_example_parses_as_standard():
    blocks = parse_scene_blocks(DOCUMENTED_ENGLISH_FORMAT_EXAMPLE)

    assert [
        (b.episode, b.location, b.time_of_day, b.interior_exterior, b.characters)
        for b in blocks
    ] == [
        (1, "SEOUL SUBWAY STATION", "night", "int", ["Ji-won", "Old Woman"]),
        (1, "SUBWAY CAR", "night", "int", ["Ji-won", "Old Woman", "Boy"]),
        (1, "SEOUL STREET", "dawn", "ext", ["Ji-won"]),
    ]
    # The time is written in the source, not inferred as a fallback; an inferred time is not inherited by scene variants.
    assert not any(b.time_inferred for b in blocks)

    assessment = assess_screenplay_scene_headers(DOCUMENTED_ENGLISH_FORMAT_EXAMPLE)
    assert assessment.status == "standard"
    assert assessment.standard_headers == 3

    report = check_screenplay_import_quality(DOCUMENTED_ENGLISH_FORMAT_EXAMPLE)
    assert report.blocking_issues == []
    assert report.warnings == []


def test_documented_english_time_line_keeps_clock_out_of_the_location():
    """The docs promise: write the clock time as a separate `Time:` line, the location stays clean, and the time normalizes to "night"."""
    text = (
        "EPISODE 1\n"
        "INT. SEOUL SUBWAY STATION - NIGHT\n"
        "Time: 11:47 PM\n"
        "Characters: Ji-won, Old Woman\n"
        "△ Rainwater drips from the ceiling.\n"
        "JI-WON: Is anyone here?\n"
    )

    (block,) = parse_scene_blocks(text)

    assert block.location == "SEOUL SUBWAY STATION"
    assert block.time_of_day == "11:47 PM"
    assert normalize_time_of_day(block.time_of_day) == "night"
    assert assess_screenplay_scene_headers(text).status == "standard"


def test_documented_english_repairable_format_is_warned_not_blocked():
    """The docs mark `SCENE 1 - TITLE` as "repairable": the boundary is found but the time is missing, so it only warns and does not block."""
    text = (
        "EPISODE 1\n"
        "\n"
        "SCENE 1 - SEOUL SUBWAY STATION\n"
        "Characters: Ji-won, Old Woman\n"
        "△ Rainwater drips from the ceiling.\n"
        "JI-WON: Is anyone here?\n"
    )

    assessment = assess_screenplay_scene_headers(text)
    assert assessment.status == "repairable"
    assert assessment.detected_headers == 1
    assert assessment.standard_headers == 0

    report = check_screenplay_import_quality(text)
    assert report.blocking_issues == []
    assert "scene_headers_missing_time" in {w.code for w in report.warnings}


@pytest.mark.parametrize("bad_time", ["MIDNIGHT", "LATE NIGHT", "11:47 PM"])
def test_undocumented_english_time_tokens_lose_the_scene_boundary(bad_time):
    """The docs list only 7 time words because anything else makes the whole line unrecognizable, not just the time.

    If the parser later supports more time words, this test turns red -- then relax the list given to users in
    `ingest.novelFormat.ruleTimeTokens` accordingly, instead of deleting this test.
    """
    text = (
        "EPISODE 1\n"
        f"INT. SEOUL SUBWAY STATION - {bad_time}\n"
        "Characters: Ji-won\n"
        "△ Rainwater drips from the ceiling.\n"
        "JI-WON: Is anyone here?\n"
    )

    assert assess_screenplay_scene_headers(text).status == "missing"


def test_clock_time_inside_the_location_name_pollutes_the_location():
    """The docs forbid putting a clock time in the location name: the pre-check will not complain, but the location carries the clock time all the way down."""
    text = (
        "EPISODE 1\n"
        "INT. SEOUL SUBWAY STATION 11:47 PM - NIGHT\n"
        "Characters: Ji-won\n"
        "△ Rainwater drips from the ceiling.\n"
        "JI-WON: Is anyone here?\n"
    )

    (block,) = parse_scene_blocks(text)

    assert block.location == "SEOUL SUBWAY STATION 11:47 PM"
    assert assess_screenplay_scene_headers(text).status == "standard"


# English scene headings listed in the dialog "Supported complete scene headings". Listing them there
# means "copying this line will not raise a warning", so every line must really assess as standard.
DOCUMENTED_COMPLETE_ENGLISH_HEADINGS = [
    "INT. SEOUL SUBWAY STATION - NIGHT",
    "EXT. SEOUL STREET - DAWN",
]


@pytest.mark.parametrize("heading", DOCUMENTED_COMPLETE_ENGLISH_HEADINGS)
def test_documented_complete_english_headings_assess_as_standard(heading):
    text = (
        "EPISODE 1\n"
        f"{heading}\n"
        "Characters: Ji-won\n"
        "△ Rainwater drips from the ceiling.\n"
        "JI-WON: Is anyone here?\n"
    )

    assert assess_screenplay_scene_headers(text).status == "standard"


def test_int_ext_heading_is_repairable_not_complete():
    """`INT./EXT.` cannot be listed under "complete formats": it does not land on a single interior/exterior value.

    `interior_exterior` only takes the values "int" and "ext" and cannot express a mixed heading, so it is left empty
    and the quality check judges it repairable. Once this value is really supported, this test turns red -- only then may
    `INT./EXT.` move from the dialog's "repairable formats" back to "complete formats".
    """
    text = (
        "EPISODE 1\n"
        "INT./EXT. MOVING TAXI - DAY\n"
        "Characters: Ji-won\n"
        "△ The taxi weaves through traffic.\n"
        "JI-WON: Faster, please.\n"
    )

    (block,) = parse_scene_blocks(text)
    assert block.location == "MOVING TAXI"
    assert block.time_of_day == "day"
    assert block.interior_exterior == ""

    assert assess_screenplay_scene_headers(text).status == "repairable"


def test_one_int_ext_scene_downgrades_the_whole_script():
    """One INT./EXT. scene pulls the whole script from standard to repairable; it does not only affect itself."""
    complete = (
        "EPISODE 1\n"
        "INT. SEOUL SUBWAY STATION - NIGHT\n"
        "Characters: Ji-won\n"
        "△ Rainwater drips from the ceiling.\n"
        "JI-WON: Is anyone here?\n"
        "\n"
        "EXT. MOVING TAXI - DAY\n"
        "Characters: Ji-won\n"
        "△ The taxi weaves through traffic.\n"
        "JI-WON: Faster, please.\n"
    )
    assert assess_screenplay_scene_headers(complete).status == "standard"

    with_int_ext = complete.replace("EXT. MOVING TAXI", "INT./EXT. MOVING TAXI")
    assessment = assess_screenplay_scene_headers(with_int_ext)
    assert assessment.status == "repairable"
    assert assessment.detected_headers == 2
    assert assessment.standard_headers == 1
