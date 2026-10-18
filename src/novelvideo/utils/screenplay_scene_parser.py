"""Deterministic screenplay scene-header parser.

The parser is intentionally line-oriented and stateful: it does not assume that
scene metadata is one, two, or three lines. It opens a scene block when it sees a
scene-start signal, then consumes following location/character metadata lines
until the first story-content line.

Supported languages are English and Vietnamese. Time of day is reported with the
canonical values of :mod:`novelvideo.time_of_day` (``dawn|morning|noon|afternoon|
day|dusk|night``) and interior/exterior as ``int`` / ``ext`` (empty when unknown).
"""

from __future__ import annotations

from dataclasses import dataclass, field
import re

from novelvideo.time_of_day import (
    TIME_OF_DAY_ALIASES_BY_CANONICAL,
    normalize_time_of_day,
)


# Time words accepted in scene headings: exactly the seven documented English words
# plus their Vietnamese equivalents. Anything else makes the whole heading unrecognizable.
# Longest first so the alternation prefers "bình minh" over a shorter prefix.
_HEADING_TIME_WORDS = sorted(
    (
        "day", "night", "morning", "afternoon", "evening", "dawn", "dusk",
        "ngày", "đêm", "sáng", "trưa", "chiều", "tối", "bình minh", "hoàng hôn",
    ),
    key=len,
    reverse=True,
)
TIME_TOKENS = frozenset(_HEADING_TIME_WORDS)
TIME_TOKEN_RE = (
    r"(?i:(?<!\w)(?:" + "|".join(re.escape(token) for token in _HEADING_TIME_WORDS) + r")(?!\w))"
)
# Looser vocabulary for labeled `Time:` lines and `Location, daytime` inline forms:
# every alias known to :mod:`novelvideo.time_of_day`.
_BROAD_TIME_WORDS = sorted(
    {alias for aliases in TIME_OF_DAY_ALIASES_BY_CANONICAL.values() for alias in aliases},
    key=len,
    reverse=True,
)
BROAD_TIME_TOKEN_RE = (
    r"(?i:(?<!\w)(?:" + "|".join(re.escape(token) for token in _BROAD_TIME_WORDS) + r")(?!\w))"
)
# Trailing interior/exterior token. Vietnamese NỘI/NGOẠI are accepted only in upper
# case here, because lower-case "nội"/"ngoại" are ordinary words ("bà ngoại").
INT_EXT_TOKEN_RE = r"(?:(?i:(?<!\w)(?:interior|exterior|int|ext)(?!\w))|(?<!\w)(?:NỘI|NGOẠI)(?!\w))\.?"
INTERIOR_EXTERIOR = {"int", "ext"}
ROOM_TYPES = {
    "living room",
    "kitchen",
    "bedroom",
    "study",
    "balcony",
    "closet",
    "hallway",
    "entrance",
    "dining room",
    "bathroom",
    "restroom",
    "phòng khách",
    "nhà bếp",
    "phòng ngủ",
    "phòng làm việc",
    "ban công",
    "hành lang",
    "cửa ra vào",
    "phòng ăn",
    "phòng tắm",
    "nhà vệ sinh",
}
_BUILDING_PREFIX_RE = re.compile(
    r"^(.+?\b(?:house|home|apartment|residence|villa|mansion|building))\b",
    re.IGNORECASE,
)

SCENE_WORD = r"(?:SCENE|SENSE|CẢNH)"
# "EPISODE 3", "EPISODE 3 - Title" or "EPISODE 3 Title" (a bare title must start with a capital
# letter, so prose such as "Chapter 2 explains why..." is never taken for a heading).
EPISODE_HEADER_RE = re.compile(
    r"^(?i:EPISODE|CHAPTER|TẬP|CHƯƠNG)\s*(\d+)"
    r"(?:\s*[:.\-–—]\s*.*|\s+[A-ZÀ-ỸĐ].*)?\s*$"
)
SCENE_MARKER_RE = re.compile(
    rf"^{SCENE_WORD}\s*[:.]?\s*\(?(?P<scene_no>\d+[A-Za-z]?)\)?"
    r"(?:\s*[:.\-–—]\s*(?P<title>.*))?\s*$",
    re.IGNORECASE,
)
# A bare scene number on its own line; only a boundary when the next line is a
# location heading.
BARE_SCENE_NUMBER_RE = re.compile(r"^\(?(?P<scene_no>\d+)\)?\s*:?\s*$")
NUMBERED_SCENE_RE = re.compile(
    r"^(?P<episode>\d+)\s*(?P<separator>[-–.])\s*(?P<scene>\d+)"
    r"(?:\s*[,\s]\s*)?(?P<rest>.*)$"
)
INSERT_SCENE_RE = re.compile(
    rf"^\+\s*(?i:{SCENE_WORD})\b"
    r"(?:\s*\(?(?P<scene_no>\d+)\)?)?"
    r"(?:\s*:)?\s*(?P<rest>.*)$"
)
LABELED_LOCATION_RE = re.compile(
    r"^(?:Location|Setting|Địa điểm)\s*:\s*(?P<location>.+)$",
    re.IGNORECASE,
)
LABELED_TIME_RE = re.compile(
    r"^(?:Time|Thời gian)\s*:\s*(?P<time>.+)$",
    re.IGNORECASE,
)
LABELED_INTERIOR_EXTERIOR_RE = re.compile(
    rf"^(?:INT/EXT|Interior/Exterior|Nội/Ngoại)\s*:\s*(?P<interior>{INT_EXT_TOKEN_RE})\s*$",
    re.IGNORECASE,
)
LABELED_CHARACTER_RE = re.compile(
    r"^(?:Characters?|Cast|Nhân vật)\s*:\s*(?P<characters>.+)$",
    re.IGNORECASE,
)
NUMBERED_ENGLISH_SCENE_RE = re.compile(
    rf"^(?P<episode>\d+)\s*[-–.]\s*(?P<scene>\d+)\s+"
    rf"{SCENE_WORD}\s*:\s*(?P<rest>.+)$",
    re.IGNORECASE,
)
DESCRIPTIVE_TIME_RE = re.compile(
    rf"^(?P<location>.+?)\s*,\s*(?P<time>{BROAD_TIME_TOKEN_RE})$",
    re.IGNORECASE,
)
BARE_ENGLISH_SENSE_SCENE_RE = re.compile(
    rf"^{SCENE_WORD}\s*:\s*(?P<rest>.+?\s*,\s*"
    rf"{BROAD_TIME_TOKEN_RE})$",
    re.IGNORECASE,
)
CLOCK_TIME_RE = re.compile(
    r"^(?:\d{1,2}(?::\d{2})?\s*(?:AM|PM)|\d{1,2}:\d{2})$",
    re.IGNORECASE,
)
INLINE_LABELED_SCENE_RE = re.compile(
    rf"^{SCENE_WORD}\s*\(?(?P<scene_no>\d+)\)?"
    r"(?:\s*:)?.*?(?:Location|Địa điểm)\s*:\s*(?P<location>.+?)"
    r"(?:;\s*(?:Characters?|Cast|Nhân vật)\s*:\s*(?P<characters>.+))?$",
    re.IGNORECASE,
)
SIMPLE_LOCATION_RE = re.compile(
    rf"^(?P<location>.+?)[\s,]+"
    rf"(?:(?P<time_first>{TIME_TOKEN_RE})[\s,]+(?P<interior_last>{INT_EXT_TOKEN_RE})"
    rf"|(?P<interior_first>{INT_EXT_TOKEN_RE})[\s,]+(?P<time_last>{TIME_TOKEN_RE}))$"
)
INTERNATIONAL_SCENE_RE = re.compile(
    r"^(?P<intro>(?i:I/E|INT\.?/EXT|INT|EXT|EST)|NỘI|NGOẠI)\.?\s+"
    r"(?P<location>.+?)\s*[-–—]\s*"
    rf"(?P<time>{TIME_TOKEN_RE})"
    r"(?:\s+#[A-Za-z0-9.\-]+#)?$"
)
SPEAKER_LINE_RE = re.compile(r"^[^\n:]{1,24}:.+$")
# Lines that open with these markers are action / shot lines, never scene headings.
ACTION_LINE_PREFIXES = ("△", "▲", "[")


@dataclass
class ParsedSceneBlock:
    header_line: str = ""
    location: str = ""
    time_of_day: str = ""
    interior_exterior: str = ""
    characters: list[str] = field(default_factory=list)
    lines: list[str] = field(default_factory=list)
    episode: int = 0
    scene_no: str = ""
    # Keep the legacy runtime default ("day") without hiding that the source
    # omitted its time anchor from import quality checks.
    time_inferred: bool = False


def split_screenplay_lines(text: str) -> list[str]:
    normalized = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    return [line.strip() for line in normalized.split("\n") if line.strip()]


def parse_scene_blocks(text_or_lines: str | list[str]) -> list[ParsedSceneBlock]:
    lines = (
        split_screenplay_lines(text_or_lines)
        if isinstance(text_or_lines, str)
        else [str(line or "").strip() for line in text_or_lines if str(line or "").strip()]
    )
    blocks: list[ParsedSceneBlock] = []
    current = ParsedSceneBlock()
    current_episode = 0
    collecting_header = False

    def flush_current() -> None:
        nonlocal current, collecting_header
        if current.header_line or current.lines:
            blocks.append(current)
        current = ParsedSceneBlock()
        collecting_header = False

    def start_block(
        line: str,
        *,
        scene_no: str = "",
        location_line: str = "",
        chars: str = "",
    ) -> None:
        nonlocal current, collecting_header, current_episode
        flush_current()
        current = ParsedSceneBlock(
            header_line=line,
            episode=current_episode,
            scene_no=scene_no,
        )
        if location_line:
            _apply_location(current, location_line)
            if not current.location:
                _apply_partial_location(current, location_line)
        if chars:
            _extend_unique(current.characters, parse_character_line(chars))
        collecting_header = True

    for line_index, raw_line in enumerate(lines):
        line = raw_line.strip()
        if not line:
            continue

        episode_match = EPISODE_HEADER_RE.match(line)
        if episode_match:
            current_episode = int(episode_match.group(1))
            if current.header_line or current.lines:
                current.episode = current.episode or current_episode
            continue

        bare_english_sense = BARE_ENGLISH_SENSE_SCENE_RE.fullmatch(line)
        if bare_english_sense:
            if current_episode <= 0:
                current_episode = 1
            start_block(line)
            _apply_inline_location(
                current,
                bare_english_sense.group("rest") or "",
            )
            continue

        numbered_english = NUMBERED_ENGLISH_SCENE_RE.fullmatch(line)
        if numbered_english:
            current_episode = int(numbered_english.group("episode"))
            start_block(
                line,
                scene_no=numbered_english.group("scene") or "",
            )
            _apply_inline_location(
                current,
                numbered_english.group("rest") or "",
            )
            continue

        scene_marker = SCENE_MARKER_RE.fullmatch(line)
        if scene_marker:
            if current_episode <= 0:
                current_episode = 1
            start_block(
                line,
                scene_no=scene_marker.group("scene_no") or "",
            )
            continue

        international = _parse_international_scene_header(line)
        if international:
            if current_episode <= 0:
                current_episode = 1
            location, time_of_day, interior_exterior = international
            start_block(line)
            current.location = location
            current.time_of_day = time_of_day
            current.interior_exterior = interior_exterior
            collecting_header = True
            continue

        insert_scene = INSERT_SCENE_RE.fullmatch(line)
        if insert_scene:
            rest = (insert_scene.group("rest") or "").strip()
            next_line = lines[line_index + 1] if line_index + 1 < len(lines) else ""
            if rest:
                if current_episode <= 0:
                    current_episode = 1
                location_line = _strip_handwritten_heading_punctuation(rest)
                start_block(
                    line,
                    scene_no=insert_scene.group("scene_no") or "",
                    location_line=location_line,
                )
            elif not is_scene_start_line(next_line):
                if current_episode <= 0:
                    current_episode = 1
                start_block(
                    line,
                    scene_no=insert_scene.group("scene_no") or "",
                )
            # A standalone "+SCENE" immediately before a complete scene heading is
            # only a production annotation. The following heading owns the block.
            continue

        inline = INLINE_LABELED_SCENE_RE.match(line)
        if inline:
            if current_episode <= 0:
                current_episode = 1
            start_block(
                line,
                scene_no=inline.group("scene_no") or "",
                location_line=inline.group("location") or "",
                chars=inline.group("characters") or "",
            )
            continue

        numbered = NUMBERED_SCENE_RE.match(line)
        if numbered and _looks_like_scene_number_line(numbered):
            ep = int(numbered.group("episode"))
            if current_episode <= 0 or ep != current_episode:
                current_episode = ep
            rest = _numbered_rest(numbered)
            numbered_fountain = _parse_international_scene_header(rest)
            if numbered_fountain:
                # "1-1. INT. KITCHEN - NIGHT": a scene number in front of a Fountain heading.
                start_block(line, scene_no=numbered.group("scene") or "")
                (
                    current.location,
                    current.time_of_day,
                    current.interior_exterior,
                ) = numbered_fountain
                continue
            start_block(line, scene_no=numbered.group("scene") or "", location_line=rest)
            continue

        bare_number = BARE_SCENE_NUMBER_RE.match(line)
        next_line = lines[line_index + 1] if line_index + 1 < len(lines) else ""
        if bare_number and bool(parse_location_header(next_line)):
            if current_episode <= 0:
                current_episode = 1
            start_block(line, scene_no=bare_number.group("scene_no") or "")
            continue

        labeled_location = LABELED_LOCATION_RE.match(line)
        if labeled_location:
            if current.header_line and (collecting_header or not current.lines):
                _apply_location(current, labeled_location.group("location") or "")
                if not current.location:
                    current.location = (labeled_location.group("location") or "").strip()
                collecting_header = True
            else:
                start_block(line, location_line=labeled_location.group("location") or "")
                if not current.location:
                    current.location = (labeled_location.group("location") or "").strip()
            continue

        labeled_time = LABELED_TIME_RE.match(line)
        if labeled_time and current.header_line and (collecting_header or not current.lines):
            time_hint = (labeled_time.group("time") or "").strip()
            if _is_time_hint(time_hint):
                current.time_of_day = time_hint
                current.time_inferred = False
            else:
                current.lines.append(line)
            collecting_header = True
            continue

        labeled_interior_exterior = LABELED_INTERIOR_EXTERIOR_RE.match(line)
        if (
            labeled_interior_exterior
            and current.header_line
            and (collecting_header or not current.lines)
        ):
            current.interior_exterior = _canonical_interior_exterior(
                labeled_interior_exterior.group("interior") or ""
            )
            collecting_header = True
            continue

        labeled_chars = LABELED_CHARACTER_RE.match(line)
        if labeled_chars and current.header_line and (collecting_header or not current.lines):
            _extend_unique(current.characters, parse_character_line(labeled_chars.group("characters") or ""))
            collecting_header = True
            continue

        simple_location = parse_location_header(line)
        if simple_location and not _looks_like_content_line(line):
            if current.header_line and (collecting_header or not current.lines) and not current.location:
                _apply_location(current, line)
                collecting_header = True
                continue
            start_block(line, location_line=line)
            continue

        if collecting_header:
            collecting_header = False
        current.lines.append(line)

    flush_current()
    return [block for block in blocks if block.header_line or block.lines]


def is_scene_start_line(line: str) -> bool:
    stripped = (line or "").strip()
    if not stripped:
        return False
    if NUMBERED_ENGLISH_SCENE_RE.fullmatch(stripped):
        return True
    if BARE_ENGLISH_SENSE_SCENE_RE.fullmatch(stripped):
        return True
    if SCENE_MARKER_RE.fullmatch(stripped):
        return True
    if _parse_international_scene_header(stripped):
        return True
    insert_scene = INSERT_SCENE_RE.fullmatch(stripped)
    if insert_scene:
        return True
    if INLINE_LABELED_SCENE_RE.match(stripped):
        return True
    numbered = NUMBERED_SCENE_RE.match(stripped)
    if numbered and _looks_like_scene_number_line(numbered):
        return True
    if LABELED_LOCATION_RE.match(stripped):
        return True
    return parse_location_header(stripped) is not None


def parse_location_header(line: str) -> tuple[str, str, str] | None:
    locs = parse_location_line(line)
    if not locs:
        return None
    if len(locs) == 1:
        name, time_of_day, interior = locs[0]
        return name, time_of_day, "int" if interior else "ext"

    # A slash in a production scene heading commonly means that one written
    # scene spans adjacent sub-locations (for example "Classroom/Stairwell").
    # Preserve that composite boundary here; Cognee may split it into physical
    # places later through parse_location_line().
    times = {time_of_day for _, time_of_day, _ in locs}
    interiors = {interior for _, _, interior in locs}
    if len(times) != 1 or len(interiors) != 1:
        return None
    name = "/".join(name for name, _, _ in locs)
    time_of_day = next(iter(times))
    interior = next(iter(interiors))
    return name, time_of_day, "int" if interior else "ext"


def parse_location_line(line: str) -> list[tuple[str, str, bool]]:
    text = _strip_location_prefix(line)
    text = _strip_numbered_scene_prefix(text)
    text = re.sub(r"\([^)]*\)", "", text).strip()
    if not text:
        return []

    tod = ""
    interior_exterior = ""

    comma_tokens = [token.strip() for token in text.split(",") if token.strip()]
    if len(comma_tokens) >= 3 and _canonical_interior_exterior(comma_tokens[-1]):
        maybe_time = comma_tokens[-2]
        if _is_time_token(maybe_time):
            tod = normalize_time_of_day(maybe_time)
            interior_exterior = _canonical_interior_exterior(comma_tokens[-1])
            text = ", ".join(comma_tokens[:-2]).strip()

    if not tod:
        simple = SIMPLE_LOCATION_RE.match(text)
        if simple:
            raw_time = simple.group("time_first") or simple.group("time_last") or ""
            tod = normalize_time_of_day(raw_time)
            interior_exterior = _canonical_interior_exterior(
                simple.group("interior_last") or simple.group("interior_first") or ""
            )
            text = simple.group("location").strip()

    if not interior_exterior:
        int_ext_match = re.search(rf"(?:^|[\s,])({INT_EXT_TOKEN_RE})\s*$", text)
        if int_ext_match:
            interior_exterior = _canonical_interior_exterior(int_ext_match.group(1))
            text = text[: int_ext_match.start()].strip()

    if not tod:
        time_match = re.search(rf"(?:^|[\s,]+)({TIME_TOKEN_RE})\s*$", text)
        if time_match:
            tod = normalize_time_of_day(time_match.group(1))
            text = text[: time_match.start()].strip()

    text = text.strip(" ,")
    if not interior_exterior:
        return []
    if not tod:
        # Preserve the historical scene-plate behavior for headings that omit
        # time. ParsedSceneBlock.time_inferred keeps validation honest.
        tod = "day"
    if not text:
        return []

    parts = [part.strip() for part in re.split(r"\s*/\s*", text) if part.strip()]
    parts = _inherit_building_prefix(parts)
    return [(name, tod, interior_exterior == "int") for name in parts]


def parse_character_line(line: str) -> list[str]:
    text = (line or "").strip()
    labeled = LABELED_CHARACTER_RE.match(text)
    if labeled:
        text = labeled.group("characters").strip()
    if not text:
        return []

    result: list[str] = []
    for part in re.split(r"[,;]", text):
        item = part.strip()
        if not item:
            continue
        # "Alice (V.O.)" -> "Alice"; "(Alice)" -> "Alice".
        paren_match = re.search(r"\(([^)]+)\)", item)
        if paren_match:
            outside = re.sub(r"\([^)]*\)", "", item).strip()
            item = outside or paren_match.group(1).strip()
        if re.search(r"\d", item):
            continue
        result.append(item)
    return result


def _apply_location(block: ParsedSceneBlock, location_line: str) -> None:
    loc = parse_location_header(location_line)
    if not loc:
        return
    block.location, block.time_of_day, block.interior_exterior = loc
    block.time_inferred = not _has_explicit_time_token(location_line)


def _apply_partial_location(block: ParsedSceneBlock, location_line: str) -> None:
    """Keep incomplete metadata after an explicit scene marker.

    This helper is never used to discover a boundary by itself. It only
    extracts best-effort hints once a numbered/``+SCENE`` marker has already made
    the boundary explicit, leaving missing fields empty for the warning and AI
    normalization path.
    """

    text = _strip_location_prefix(location_line)
    text = _strip_numbered_scene_prefix(text)
    int_ext_match = re.search(rf"(?:^|[\s,(])({INT_EXT_TOKEN_RE})(?=$|[\s,)])", text)
    if int_ext_match:
        block.interior_exterior = _canonical_interior_exterior(int_ext_match.group(1))
        text = (text[: int_ext_match.start(1)] + text[int_ext_match.end(1) :]).strip()

    text = re.sub(r"\([^)]*\)", "", text).strip()
    time_match = re.search(rf"(?:^|[\s,]+)({TIME_TOKEN_RE})\s*$", text)
    if time_match:
        block.time_of_day = normalize_time_of_day(time_match.group(1))
        block.time_inferred = False
        text = text[: time_match.start()].strip()

    text = text.strip(" ,")
    if text:
        block.location = text


def _apply_inline_location(
    block: ParsedSceneBlock,
    location_line: str,
) -> None:
    text = (location_line or "").strip()
    descriptive_time = DESCRIPTIVE_TIME_RE.fullmatch(text)
    if descriptive_time:
        block.location = (descriptive_time.group("location") or "").strip()
        block.time_of_day = (descriptive_time.group("time") or "").strip()
        block.time_inferred = False
        return
    block.location = text


def _extend_unique(items: list[str], new_items: list[str]) -> None:
    for item in new_items:
        if item and item not in items:
            items.append(item)


def _strip_location_prefix(line: str) -> str:
    text = (line or "").strip()
    labeled = LABELED_LOCATION_RE.match(text)
    if labeled:
        return labeled.group("location").strip()
    return text


def _strip_numbered_scene_prefix(line: str) -> str:
    match = NUMBERED_SCENE_RE.match((line or "").strip())
    if match and _looks_like_scene_number_line(match):
        return _numbered_rest(match)
    return line


def _numbered_rest(match: re.Match[str]) -> str:
    """Text after a scene number, without the separator punctuation ("1-1. INT. X" -> "INT. X")."""
    return (match.group("rest") or "").strip().lstrip(".:;,-– ").strip()


def _looks_like_scene_number_line(match: re.Match[str]) -> bool:
    rest = _numbered_rest(match)
    if not rest:
        return True
    return (
        bool(_parse_international_scene_header(rest))
        or bool(parse_location_line(rest))
        or _looks_like_partial_location(rest)
    )


def _looks_like_partial_location(text: str) -> bool:
    """A numbered line with only part of a heading: a time or an INT/EXT marker."""
    candidate = (text or "").strip()
    if not candidate or len(candidate) > 60:
        return False
    if SPEAKER_LINE_RE.match(candidate) or candidate.startswith(ACTION_LINE_PREFIXES):
        return False
    if candidate.endswith((".", "!", "?")):
        return False
    return bool(
        re.search(rf"(?:^|[\s,(])(?:{TIME_TOKEN_RE}|{INT_EXT_TOKEN_RE})(?=$|[\s,)])", candidate)
    )


def _strip_handwritten_heading_punctuation(text: str) -> str:
    return (text or "").strip().rstrip(".!?,;:").strip()


def _has_explicit_time_token(text: str) -> bool:
    candidate = _strip_location_prefix(text)
    candidate = _strip_numbered_scene_prefix(candidate)
    return bool(
        re.search(
            rf"(?:^|[\s,])(?:{TIME_TOKEN_RE})(?=$|[\s,])",
            candidate,
        )
    )


def _looks_like_content_line(line: str) -> bool:
    stripped = (line or "").strip()
    if not stripped:
        return False
    if stripped.startswith(ACTION_LINE_PREFIXES):
        return True
    return bool(SPEAKER_LINE_RE.match(stripped))


def _canonical_interior_exterior(token: str) -> str:
    text = (token or "").strip().rstrip(".").lower()
    if text in {"int", "interior", "nội"}:
        return "int"
    if text in {"ext", "exterior", "ngoại"}:
        return "ext"
    return ""


def _parse_international_scene_header(line: str) -> tuple[str, str, str] | None:
    """Parse supported English/Vietnamese Fountain-style scene headings.

    Mixed INT/EXT and EST headings are valid boundaries but do not provide a
    single reliable interior/exterior value. They are intentionally returned
    with an empty value so the import check can mark them repairable.
    """

    text = (line or "").strip()
    international = INTERNATIONAL_SCENE_RE.fullmatch(text)
    if not international:
        return None
    interior = _canonical_interior_exterior(international.group("intro") or "")
    return (
        (international.group("location") or "").strip(),
        normalize_time_of_day(international.group("time") or ""),
        interior,
    )


def _is_time_token(text: str) -> bool:
    return bool(re.fullmatch(TIME_TOKEN_RE, (text or "").strip()))


def _is_time_hint(text: str) -> bool:
    candidate = (text or "").strip()
    return bool(re.fullmatch(BROAD_TIME_TOKEN_RE, candidate)) or bool(
        CLOCK_TIME_RE.fullmatch(candidate)
    )


def _inherit_building_prefix(parts: list[str]) -> list[str]:
    if not parts:
        return parts
    prefix_match = _BUILDING_PREFIX_RE.match(parts[0])
    if not prefix_match:
        return parts
    prefix = prefix_match.group(1)
    result = [parts[0]]
    for part in parts[1:]:
        if part.lower() in ROOM_TYPES:
            result.append(f"{prefix} {part}")
        else:
            result.append(part)
    return result
