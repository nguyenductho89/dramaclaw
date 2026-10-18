"""Automatically detect the chapter structure of a novel."""
import re
from dataclasses import dataclass
from typing import List, Optional

from novelvideo.utils.screenplay_quality import extract_screenplay_candidate_lines


@dataclass
class ChapterInfo:
    """Chapter information."""
    number: int           # chapter number
    title: Optional[str]  # chapter title (if any)
    start_line: int       # first line index
    end_line: int         # end line index
    content: str          # chapter content
    is_fallback: bool = False  # True when no chapters were detected and the text fell back to a single chapter


_TITLE_TAIL = r"(?=$|[\s:(\[\-\u2014\u2013.])"
_KEYWORDS = ("Chapter", "Chương", "Episode", "Tập", "Part", "Phần")


def _build_patterns() -> List[str]:
    prefix = r"^(?:#{1,6}\s*)?"
    numeric = [prefix + kw + r"\s*(\d+)" + _TITLE_TAIL for kw in _KEYWORDS]
    worded = [
        prefix + kw + r"[ \t]+([A-Za-z]+(?:-[A-Za-z]+)?)" + _TITLE_TAIL
        for kw in _KEYWORDS
    ]
    return numeric + worded


class ChapterDetector:
    """Detect the chapter structure of a novel.

    Supported chapter marker formats:
    - Chapter N: "Chapter 1", "Chapter 10", "Chapter One"
    - Chương N: "Chương 1"
    - Episode N: "Episode 1"
    - Tập N: "Tập 1"
    - Part N / Phần N: "Part 2", "Phần 2"

    Example:
        detector = ChapterDetector()
        chapters = detector.detect(novel_text)
        print(f"Detected {len(chapters)} chapters")
        for ch in chapters:
            print(f"Chapter {ch.number}: {len(ch.content)} chars")
    """

    # Chapter title patterns (highest priority first).
    # Only the beginning of a title line is matched, so "the original Chapter 3"
    # inside dialogue/narration is not mistaken for a new chapter.
    # The number must be followed by end-of-line, whitespace or a common title
    # separator; after whitespace, sentence-like tails are rejected so that body
    # sentences such as "Episode 1 Ends here." are not split as chapters.
    PATTERNS = _build_patterns()

    _UNITS = {
        "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
        "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
        "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
        "nineteen": 19,
    }
    _TENS = {
        "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
        "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
    }

    def detect(self, text: str) -> List[ChapterInfo]:
        """Detect chapters and return the chapter list.

        Args:
            text: Full novel text

        Returns:
            Detected chapters, in document order
        """
        lines = text.split("\n")
        chapters = []
        current_start = None
        current_num = None

        for i, line in enumerate(lines):
            chapter_num = self._match_chapter(line.strip())
            if chapter_num is not None:
                # Save the previous chapter
                if current_start is not None:
                    chapters.append(ChapterInfo(
                        number=current_num,
                        title=None,
                        start_line=current_start,
                        end_line=i,
                        content="\n".join(lines[current_start:i])
                    ))
                current_start = i
                current_num = chapter_num

        # Save the last chapter
        if current_start is not None:
            chapters.append(ChapterInfo(
                number=current_num,
                title=None,
                start_line=current_start,
                end_line=len(lines),
                content="\n".join(lines[current_start:])
            ))

        if not chapters:
            fallback_content = self._prepare_fallback_content(text or "")
            if fallback_content:
                chapters.append(ChapterInfo(
                    number=1,
                    title="Chapter 1",
                    start_line=0,
                    end_line=len(fallback_content.splitlines()) or len(lines),
                    content=fallback_content,
                    is_fallback=True,
                ))

        return chapters

    def has_chapters(self, text: str, min_chapters: int = 2) -> bool:
        """Quickly check whether the text contains a chapter structure.

        Args:
            text: Full novel text
            min_chapters: Minimum number of chapters (default 2)

        Returns:
            Whether at least min_chapters chapters were found
        """
        chapters = self.detect(text)
        return len(chapters) >= min_chapters

    def get_chapter_count(self, text: str) -> int:
        """Return the number of chapters.

        Args:
            text: Full novel text

        Returns:
            Number of chapters
        """
        return len(self.detect(text))

    def _match_chapter(self, line: str) -> Optional[int]:
        """Match a chapter marker and return the chapter number.

        Args:
            line: Line text with leading/trailing whitespace stripped

        Returns:
            The chapter number, or None if the line is not a chapter marker
        """
        for pattern in self.PATTERNS:
            match = re.search(pattern, line, re.IGNORECASE)
            if match and self._is_valid_title_tail(line[match.end():]):
                number = self._parse_number(match.group(1))
                if number is not None:
                    return number
        return None

    def _is_valid_title_tail(self, tail: str) -> bool:
        """Return whether text after the chapter marker still looks like a title."""
        stripped = tail.strip()
        if not stripped:
            return True
        if stripped[0] == ".":
            return not self._looks_like_sentence_tail(stripped[1:].strip())
        if stripped[0] in ":([-\u2014\u2013":
            return True
        return not self._looks_like_sentence_tail(stripped)

    def _looks_like_sentence_tail(self, tail: str) -> bool:
        return bool(re.search(r"[.\u2026]\s*$", tail))

    def _parse_number(self, s: str) -> Optional[int]:
        """Parse a chapter number (digits or English number words).

        Supported formats:
        - Digits: "1", "10", "123"
        - English words: "one", "twelve", "twenty-one"

        Args:
            s: Number string

        Returns:
            The integer value, or None if the string is not a number
        """
        if s.isdigit():
            return int(s)

        word = s.strip().lower()
        if word in self._UNITS:
            return self._UNITS[word]
        if word in self._TENS:
            return self._TENS[word]
        if "-" in word:
            tens, _, unit = word.partition("-")
            if tens in self._TENS and unit in self._UNITS and self._UNITS[unit] < 10:
                return self._TENS[tens] + self._UNITS[unit]
        return None

    def _prepare_fallback_content(self, text: str) -> str:
        """Single-chapter fallback content when no chapters are detected.

        Ordinary novels keep the original text; for tier-B screenplays the
        preface (synopsis, character bios, etc.) is trimmed first so the
        single-chapter fallback keeps only the body.
        """
        raw = (text or "").strip()
        if not raw:
            return ""
        candidate_lines = extract_screenplay_candidate_lines(text)
        candidate_text = "\n".join(candidate_lines).strip()
        if not candidate_text:
            return raw
        if candidate_text != raw:
            return candidate_text
        return raw
