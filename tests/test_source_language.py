import pytest

from novelvideo.utils.source_language import (
    asset_language_instruction,
    detect_asset_language,
    language_name,
)


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("INT. LIVING ROOM - DAY\nMAYA opens the door.", "en"),
        ("INT. CAFÉ - DAY\nChloë enters the room.", "en"),
        ("MAYA: Go!", "en"),
        ("Er geht in das Zimmer.", "en"),
        ("Tu marches.", "en"),
        ("", "en"),
        # Han text is no longer a supported source language: fall back to en.
        ("\u7b2c\u4e00\u573a \u5ba2\u5385 \u65e5 \u5185", "en"),
        ("Nói cho tôi biết bạn đang ở đâu.", "vi"),
        ("Cô bé mở cửa và bước vào phòng khách.", "vi"),
        ("INT. PHÒNG KHÁCH - NGÀY\nNam mở cửa.", "vi"),
        ("Tôi yêu bạn.", "vi"),
    ],
)
def test_detect_asset_language_supports_english_and_vietnamese(source, expected):
    assert detect_asset_language(source) == expected


def test_english_instruction_keeps_prose_english_and_names_verbatim():
    instruction = asset_language_instruction("en")

    assert "English" in instruction
    assert "verbatim" in instruction


def test_vietnamese_instruction_names_vietnamese_and_keeps_names_verbatim():
    instruction = asset_language_instruction("vi")

    assert "Vietnamese" in instruction
    assert "verbatim" in instruction


def test_language_name_defaults_to_english():
    assert language_name("vi") == "Vietnamese"
    assert language_name("en") == "English"
    assert language_name("xx") == "English"
