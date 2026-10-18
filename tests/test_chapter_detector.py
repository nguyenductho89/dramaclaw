import pytest

from novelvideo.cognee.chapter_detector import ChapterDetector


def _numbers(text: str) -> list[int]:
    return [chapter.number for chapter in ChapterDetector().detect(text)]


def test_detects_latin_chapter_markers():
    text = "Chapter 1\nThe king enters the palace.\nChapter 2\nWind rises at the gate."

    assert _numbers(text) == [1, 2]


@pytest.mark.parametrize(
    "marker",
    ["Chương 3: Gió nổi", "Episode 3", "Tập 3", "Part 3", "Phần 3", "# Chapter 3", "Chapter three"],
)
def test_supported_marker_keywords_and_number_words(marker):
    assert _numbers(f"{marker}\nBody text.") == [3]


def test_number_words_are_parsed():
    assert _numbers("Chapter twenty-one\nBody.") == [21]
    assert _numbers("Chapter Twelve\nBody.") == [12]


def test_non_numeric_words_after_a_keyword_are_not_chapters():
    detector = ChapterDetector()

    assert detector._match_chapter("Part Time Job") is None
    assert detector._match_chapter("Chapter Summary") is None
    # With no real marker the text falls back to a single chapter.
    assert all(c.is_fallback for c in detector.detect("Part Time Job\nBody."))


def test_sentences_that_mention_a_chapter_are_not_split():
    text = (
        "Chapter 1\n"
        "He whispered: I remember chapter 7 differently.\n"
        "Episode 1 Ends here.\n"
        "Chapter 2\n"
        "Narrator: This happened before chapter 18 of the original book."
    )

    chapters = ChapterDetector().detect(text)

    assert [chapter.number for chapter in chapters] == [1, 2]
    assert "chapter 7" in chapters[0].content
    assert "chapter 18" in chapters[1].content


def test_text_without_markers_falls_back_to_a_single_chapter():
    chapters = ChapterDetector().detect("Just one long story without any markers.")

    assert len(chapters) == 1
    assert chapters[0].is_fallback is True
    assert chapters[0].title == "Chapter 1"
