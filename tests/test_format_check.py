from __future__ import annotations

import io
from types import SimpleNamespace

import pytest
from fastapi import UploadFile

from novelvideo.utils.screenplay_quality import build_import_format_check


def _codes(result: dict) -> set[str]:
    return {issue["code"] for issue in result["issues"]}


def _issue(result: dict, code: str) -> dict:
    return next(issue for issue in result["issues"] if issue["code"] == code)


def _dialogue_lines(count: int) -> str:
    return "\n".join(f"Character{i % 3}: This is a line of dialogue used for pre-check statistics." for i in range(count))


def test_complete_split_field_scene_header_is_supported_without_warning():
    result = build_import_format_check(
        "SCENE: 1\nLocation: Human City\nTime: DAY\nINT/EXT: INT\n",
        has_chapters=True,
    )

    assert result["level"] == "ok"
    assert result["scene_header_status"] == "standard"
    assert result["issues"] == []


def test_normative_scene_headers_pass_without_issues():
    text = f"""
1-1, Old Shanghai Sealed Gate Ruins NIGHT EXT
Characters: Lu Yuan, Mysterious Man
{_dialogue_lines(8)}
1-2, Old Shanghai Awning DAY INT
Characters: Lu Yuan, Boss
{_dialogue_lines(8)}
"""

    result = build_import_format_check(text, has_chapters=True)

    assert result["level"] == "ok"
    assert result["issues"] == []
    assert result["scene_header_status"] == "standard"


def test_not_screenplay_like_is_metric_only():
    text = """
1-1, Old Shanghai Sealed Gate Ruins NIGHT EXT
Characters: Lu Yuan, Mysterious Man
Lu Yuan: You came.
"""

    result = build_import_format_check(text, has_chapters=True)

    assert result["level"] == "ok"
    assert result["issues"] == []


def test_missing_interior_exterior_warns():
    result = build_import_format_check(
        "1-1, Old Shanghai Sealed Gate Ruins NIGHT\nLu Yuan: You came.\nMysterious Man: Yes.\n",
        has_chapters=True,
    )

    assert result["level"] == "warning"
    assert "missing_interior_exterior" in _codes(result)


def test_inline_scene_header_with_trailing_character_metadata_keeps_interior_exterior():
    result = build_import_format_check(
        "SCENE (1) Location: Noodle Shop, NIGHT, INT; Characters: Boss\nBoss: Welcome.\n",
        has_chapters=True,
    )

    assert "missing_interior_exterior" not in _codes(result)


def test_missing_scene_headers_is_warning_when_chapters_exist():
    text = _dialogue_lines(8)

    result = build_import_format_check(text, has_chapters=True)

    assert result["level"] == "warning"
    assert "missing_scene_headers" in _codes(result)
    assert result["level"] != "blocking"
    assert result["scene_header_status"] == "missing"


def test_headerless_short_drama_is_blocking_when_scene_headers_are_required():
    text = "EPISODE 1\nSun Wukong walks into the bedroom and sees his master resting."

    result = build_import_format_check(
        text,
        has_chapters=True,
        require_scene_headers=True,
    )

    assert result["level"] == "blocking"
    assert result["scene_header_status"] == "missing"
    assert "missing_scene_headers" in _codes(result)


def test_explicit_english_scene_markers_are_repairable_not_missing():
    text = """Episode 1
SCENE 1 — THE EMPTY PLATFORM
Location: Seoul Subway Station
Time: 11:47 PM
JI-WON: Hello?
SCENE 2 — THE LAST TRAIN
The train stops.
"""

    result = build_import_format_check(
        text,
        has_chapters=True,
        require_scene_headers=True,
    )

    assert result["level"] != "blocking"
    assert result["scene_header_status"] == "repairable"
    assert "missing_scene_headers" not in _codes(result)


@pytest.mark.parametrize(
    "prose_line",
    [
        "Scene 2 was rewritten yesterday.",
        "Chapter 2 explains why the train stopped.",
    ],
)
def test_numbered_english_prose_does_not_bypass_required_scene_headers(prose_line):
    result = build_import_format_check(
        prose_line,
        has_chapters=True,
        require_scene_headers=True,
    )

    assert result["level"] == "blocking"
    assert result["scene_header_status"] == "missing"
    assert "missing_scene_headers" in _codes(result)


@pytest.mark.parametrize(
    "action_line",
    [
        "Sun Wukong hurried to the door EXT",
        "Sun Wukong pushed open the door and walked INT",
        "Sun Wukong hurried to the door EXT (flashback)",
        "Sun Wukong pushed open the door and walked INT (rain)",
    ],
)
def test_prose_ending_in_interior_or_exterior_is_not_a_repairable_scene_header(
    action_line,
):
    text = f"""
EPISODE 1
{action_line}
He found that his master had already left.
"""

    result = build_import_format_check(
        text,
        has_chapters=True,
        require_scene_headers=True,
    )

    assert result["level"] == "blocking"
    assert result["scene_header_status"] == "missing"
    assert "missing_scene_headers" in _codes(result)


def test_unnumbered_header_with_explicit_time_and_commas_is_supported():
    text = """
EPISODE 1
Bodhi Bedroom, NIGHT, INT
Sun Wukong: Master.
"""

    result = build_import_format_check(
        text,
        has_chapters=True,
        require_scene_headers=True,
    )

    assert result["level"] == "ok"
    assert result["scene_header_status"] == "standard"


@pytest.mark.parametrize(
    "header",
    [
        "Bodhi Bedroom NIGHT INT (flashback)",
        "Bodhi Bedroom, NIGHT, INT (dream)",
        "Bodhi Bedroom NIGHT INT (flashback) (rain)",
    ],
)
def test_unnumbered_header_with_trailing_parenthetical_is_supported(header):
    text = f"""
EPISODE 1
{header}
Sun Wukong: Master.
"""

    result = build_import_format_check(
        text,
        has_chapters=True,
        require_scene_headers=True,
    )

    assert result["level"] == "ok"
    assert result["scene_header_status"] == "standard"


def test_bare_numbered_labeled_scene_header_is_supported():
    text = """
EPISODE 1
SCENE 1 Location: Bodhi Bedroom
Time: NIGHT
INT/EXT: INT
Sun Wukong: Master.
"""

    result = build_import_format_check(
        text,
        has_chapters=True,
        require_scene_headers=True,
    )

    assert result["level"] == "ok"
    assert result["scene_header_status"] == "standard"
    assert result["issues"] == []


def test_fountain_scene_header_with_characters_is_standard():
    text = """
EPISODE 1
EXT. IMPERIAL PALACE TERRACE - NIGHT
Characters: Emperor Zhengde, Attending Eunuch
△ Flames blaze toward the Qianqing Palace.
EMPEROR ZHENGDE: What a magnificent fireworks display.
"""

    result = build_import_format_check(
        text,
        has_chapters=True,
        require_scene_headers=True,
    )

    assert result["level"] == "ok"
    assert result["scene_header_status"] == "standard"
    assert result["issues"] == []


@pytest.mark.parametrize(
    "header",
    [
        "1.1 Li Family Living Room INT DAY",
        "1-1 Li Family Living Room DAY INT",
        "NỘI. PHÒNG KHÁCH NHÀ LÝ - ĐÊM",
        "INT. LI FAMILY LIVING ROOM - NIGHT",
        "+SCENE Li Family Living Room INT DAY",
    ],
)
def test_supported_scene_header_dialects_are_standard(header):
    text = f"""
EPISODE 1
{header}
Characters: Li Mei, Wang Fang
Li Mei: I'm back.
"""

    result = build_import_format_check(
        text,
        has_chapters=True,
        require_scene_headers=True,
    )

    assert result["scene_header_status"] == "standard"
    assert result["level"] == "ok"
    assert result["issues"] == []


def test_recognizable_scene_header_with_missing_time_warns_but_does_not_block():
    result = build_import_format_check(
        "EPISODE 1\n1.1 Li Family Living Room INT\nCharacters: Li Mei\nLi Mei: I'm back.",
        has_chapters=True,
        require_scene_headers=True,
    )

    assert result["scene_header_status"] == "repairable"
    assert result["level"] == "warning"
    assert "nonstandard_scene_headers" in _codes(result)
    assert "scene_headers_missing_time" in _codes(result)
    issue = _issue(result, "scene_headers_missing_time")
    assert issue["line"] == 2
    assert issue["message"] == 'Scene heading "1.1 Li Family Living Room INT" is missing: time.'
    assert "1.1 Li Family Living Room INT [DAY/NIGHT]" in issue["fix"]


def test_incomplete_scene_headers_identify_each_source_line_and_missing_field():
    result = build_import_format_check(
        """EPISODE 1
1.1 Zheng Family Living Room INT DAY
Characters: Zheng Yuqin, Butler Liu
Zheng Yuqin: You're here.
11.2 School Lab DAY
Characters: Xiaoyu
Xiaoyu: The experiment succeeded.
+SCENE Dance Studio Mirror
Characters: Xiaoyu
Xiaoyu: Practice once more.
""",
        has_chapters=True,
        require_scene_headers=True,
    )

    incomplete = _issue(result, "incomplete_scene_header")
    missing_interior = _issue(result, "missing_interior_exterior")
    assert (incomplete["line"], incomplete["message"]) == (
        8,
        'Scene heading "+SCENE Dance Studio Mirror" is missing: time, INT/EXT.',
    )
    assert (missing_interior["line"], missing_interior["message"]) == (
        5,
        'Scene heading "11.2 School Lab DAY" is missing: INT/EXT.',
    )
    assert "+SCENE Dance Studio Mirror [DAY/NIGHT] [INT/EXT]" in incomplete["fix"]
    assert "11.2 School Lab DAY [INT/EXT]" in missing_interior["fix"]


def test_parenthetical_dialogue_directions_do_not_warn():
    dialogue = "\n".join(
        f"Character{i % 2} (chuckles, calm tone): This is line {i + 1} of dialogue."
        for i in range(8)
    )
    text = f"""
EPISODE 1
EXT. IMPERIAL PALACE TERRACE - NIGHT
Characters: Character0, Character1
{dialogue}
"""

    result = build_import_format_check(
        text,
        has_chapters=True,
        require_scene_headers=True,
    )

    assert result["level"] == "ok"
    assert "heavy_parenthetical_dialogue" not in _codes(result)


def test_complete_multiline_scene_headers_are_supported():
    text = """
SCENE (1)
Location: Noodle Shop, NIGHT, INT
Characters: Du Chen
Du Chen: Boss, the bill please.
"""

    result = build_import_format_check(text, has_chapters=True)

    assert result["scene_header_status"] == "standard"
    assert result["level"] == "ok"
    assert result["issues"] == []


def test_no_chapters_is_blocking():
    result = build_import_format_check("No recognizable chapters", has_chapters=False)

    assert result["level"] == "blocking"
    assert "No valid chapters" in result["summary"]


def test_duplicate_chapter_numbers_warn():
    result = build_import_format_check(
        "EPISODE 1\nBody\nEPISODE 1 has ended.\nEPISODE 2\nBody",
        has_chapters=True,
        chapters=[
            {"number": 1, "title": "EPISODE 1", "start_line": 0},
            {"number": 1, "title": "EPISODE 1 has ended.", "start_line": 2},
            {"number": 2, "title": "EPISODE 2", "start_line": 3},
        ],
    )

    assert result["level"] == "warning"
    assert "duplicate_chapter_number" in _codes(result)
    assert "non_increasing_chapter_number" in _codes(result)
    assert _issue(result, "duplicate_chapter_number")["line"] == 3


def test_missing_interior_exterior_suppresses_legacy_missing_time():
    result = build_import_format_check("Location: Human City, DAY\n", has_chapters=True)

    assert "missing_interior_exterior" in _codes(result)
    assert "scene_headers_missing_time" not in _codes(result)


def test_sparse_scene_headers_only_for_long_scripts():
    long_text = f"""
1-1, Old Shanghai Sealed Gate Ruins NIGHT EXT
Characters: Lu Yuan, Mysterious Man
{_dialogue_lines(24)}
"""
    short_text = f"""
1-1, Old Shanghai Sealed Gate Ruins NIGHT EXT
Characters: Lu Yuan, Mysterious Man
{_dialogue_lines(12)}
"""

    long_result = build_import_format_check(long_text, has_chapters=True)
    short_result = build_import_format_check(short_text, has_chapters=True)

    assert "sparse_scene_headers" in _codes(long_result)
    assert "sparse_scene_headers" not in _codes(short_result)


def test_incomplete_split_field_scene_header_warns_without_blocking():
    result = build_import_format_check(
        "Synopsis\nThis is the story.\nSCENE: 1\nLocation: Human City\n",
        has_chapters=True,
        require_scene_headers=True,
    )

    assert result["level"] == "warning"
    assert result["scene_header_status"] == "repairable"
    assert "nonstandard_scene_headers" in _codes(result)


def test_time_detection_requires_delimiters():
    split_result = build_import_format_check(
        "Location: Night Market\nTime: DAY\nCharacters: A\nA: Arrived.\n",
        has_chapters=True,
    )
    false_time_result = build_import_format_check(
        "1-1, Daytona Bay INT\nA: Arrived.\n",
        has_chapters=True,
    )

    assert split_result["scene_header_status"] == "repairable"
    assert "nonstandard_scene_headers" in _codes(split_result)
    assert "missing_interior_exterior" not in _codes(false_time_result)


def _legacy_resolution(project_dir):
    return SimpleNamespace(
        ctx=None,
        username="admin",
        project_name="demo",
        project_dir=project_dir,
        output_dir=str(project_dir / "output"),
        state_dir=str(project_dir / "state"),
        runtime_dir=str(project_dir / "runtime"),
    )


def _project_scope_resolver(project_dir):
    async def resolve(*args, **kwargs):
        return _legacy_resolution(project_dir)

    return resolve


@pytest.mark.asyncio
async def test_upload_success_includes_format_check_in_data(tmp_path, monkeypatch):
    from novelvideo.api.routes import ingest

    monkeypatch.setattr(ingest, "resolve_project_scope", _project_scope_resolver(tmp_path))
    text = "Chapter 1 Beginning\nSCENE: 1\nLocation: Human City\nTime: DAY\nCharacters: A\nA: Arrived."
    raw = text.encode("utf-8")
    upload = UploadFile(file=io.BytesIO(raw), filename="script.txt")

    response = await ingest.upload_novel(project="demo", file=upload, user={"username": "admin"})

    assert response["ok"] is True
    assert response["data"]["format_check"]["level"] == "warning"
    assert _codes(response["data"]["format_check"]) == {
        "nonstandard_scene_headers",
        "missing_interior_exterior",
    }
    assert "format_check" not in response


@pytest.mark.asyncio
async def test_upload_empty_preview_includes_blocking_format_check_at_top_level(tmp_path, monkeypatch):
    from novelvideo.api.routes import ingest

    monkeypatch.setattr(ingest, "resolve_project_scope", _project_scope_resolver(tmp_path))
    upload = UploadFile(file=io.BytesIO(b""), filename="empty.txt")

    response = await ingest.upload_novel(project="demo", file=upload, user={"username": "admin"})

    assert response["ok"] is False
    assert response["format_check"]["level"] == "blocking"
    assert "format_check" not in response.get("data", {})


# The frontend looks up i18n by code + params (frontend/src/lib/format-check-copy.ts); the English
# summary/message/fix serve only as a fallback. Without summary_code or params, a localized UI would show English text.
def test_format_check_carries_machine_readable_codes_for_i18n():
    result = build_import_format_check(
        "1-1 City Cafe DAY\n" + _dialogue_lines(30),
        has_chapters=True,
    )

    assert result["summary_code"]
    assert isinstance(result["summary_params"], dict)
    assert result["issues"]
    for issue in result["issues"]:
        assert issue["code"]
        assert isinstance(issue.get("params"), dict), issue["code"]


def test_line_aware_scene_header_issue_exposes_slots_not_localized_words():
    result = build_import_format_check(
        "1-1 City Cafe DAY\n" + _dialogue_lines(30),
        has_chapters=True,
    )
    issue = next(i for i in result["issues"] if i["params"].get("header"))

    assert issue["params"]["header"] == "1-1 City Cafe DAY"
    assert set(issue["params"]["missing_slots"]) <= {
        "location",
        "time",
        "interior_exterior",
    }
    assert issue["params"]["missing_slots"]


def test_blocking_summary_code_is_reported_for_missing_scene_headers():
    result = build_import_format_check("", has_chapters=False)

    assert result["summary_code"] == "no_chapters"
    assert result["summary_params"] == {}
