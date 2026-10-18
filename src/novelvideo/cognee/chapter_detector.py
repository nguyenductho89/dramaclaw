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
    _TAIL = r"(?=$|[\s:(\[\-\u2014\u2013.])"
    _KEYWORDS = ("Chapter", "Chương", "Episode", "Tập", "Part", "Phần")
    PATTERNS = [
        r"^(?:#{1,6}\s*)?" + kw + r"\s*" + r"(\d+)" + _TAIL for kw in _KEYWORDS
    ] + [
        r"^(?:#{1,6}\s*)?" + kw + r"[ \t]+([A-Za-z]+(?:-[A-Za-z]+)?)" + _TAIL for kw in _KEYWORDS
    ]

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
        """检测章节并返回章节列表。

        Args:
            text: 小说全文

        Returns:
            检测到的章节列表，按章节号排序
        """
        lines = text.split("\n")
        chapters = []
        current_start = None
        current_num = None

        for i, line in enumerate(lines):
            chapter_num = self._match_chapter(line.strip())
            if chapter_num is not None:
                # 保存上一章
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

        # 保存最后一章
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
                    title="第1章",
                    start_line=0,
                    end_line=len(fallback_content.splitlines()) or len(lines),
                    content=fallback_content,
                    is_fallback=True,
                ))

        return chapters

    def has_chapters(self, text: str, min_chapters: int = 2) -> bool:
        """快速检测文本是否包含章节结构。

        Args:
            text: 小说全文
            min_chapters: 最少章节数（默认2）

        Returns:
            是否包含至少 min_chapters 个章节
        """
        chapters = self.detect(text)
        return len(chapters) >= min_chapters

    def get_chapter_count(self, text: str) -> int:
        """获取章节数量。

        Args:
            text: 小说全文

        Returns:
            章节数量
        """
        return len(self.detect(text))

    def _match_chapter(self, line: str) -> Optional[int]:
        """匹配章节标记，返回章节号。

        Args:
            line: 去除首尾空格后的行文本

        Returns:
            章节号，如果不是章节标记则返回 None
        """
        for pattern in self.PATTERNS:
            match = re.search(pattern, line, re.IGNORECASE)
            if match and self._is_valid_title_tail(line[match.end():]):
                return self._parse_number(match.group(1))
        return None

    def _is_valid_title_tail(self, tail: str) -> bool:
        """Return whether text after the chapter marker still looks like a title."""
        stripped = tail.strip()
        if not stripped:
            return True
        if stripped[0] in ".。．":
            return not self._looks_like_sentence_tail(stripped[1:].strip())
        if stripped[0] in ":：《（(【[-—–、":
            return True
        return not self._looks_like_sentence_tail(stripped)

    def _looks_like_sentence_tail(self, tail: str) -> bool:
        return bool(re.search(r"[。\.…]\s*$", tail))

    def _parse_number(self, s: str) -> int:
        """解析数字（支持中文数字）。

        支持的格式：
        - 阿拉伯数字: "1", "10", "123"
        - 简单中文数字: "一", "二", "十"
        - 复合中文数字: "十一", "二十", "一百零一"

        Args:
            s: 数字字符串

        Returns:
            整数值
        """
        # 阿拉伯数字
        if s.isdigit():
            return int(s)

        # 单个中文数字
        if s in self.CN_NUM_MAP:
            return self.CN_NUM_MAP[s]

        # 复合中文数字
        return self._parse_chinese_number(s)

    def _parse_chinese_number(self, s: str) -> int:
        """解析复合中文数字。

        支持: 十一, 二十, 二十三, 一百, 一百零一, 一百二十三, 一千零一

        Args:
            s: 中文数字字符串

        Returns:
            整数值
        """
        result = 0
        temp = 0  # 当前累积的数字

        i = 0
        while i < len(s):
            char = s[i]

            if char in self.CN_NUM_MAP:
                num = self.CN_NUM_MAP[char]

                if num == 10:  # 十
                    if temp == 0:
                        temp = 1  # "十" 开头表示 10
                    result += temp * 10
                    temp = 0
                elif num == 100:  # 百
                    if temp == 0:
                        temp = 1
                    result += temp * 100
                    temp = 0
                elif num == 1000:  # 千
                    if temp == 0:
                        temp = 1
                    result += temp * 1000
                    temp = 0
                elif num == 0:  # 零
                    # "零" 通常是占位，继续处理下一个字符
                    pass
                else:
                    temp = num

            i += 1

        result += temp
        return result if result > 0 else 1

    def _prepare_fallback_content(self, text: str) -> str:
        """无章节时的单章回退内容。

        对普通小说保持原文；对 B 档剧本优先裁掉梗概/人物小传等前言区，
        让单章回退只保留正文。
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
