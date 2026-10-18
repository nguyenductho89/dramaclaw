"""Screenplay import quality pre-check."""

from __future__ import annotations

from dataclasses import dataclass, field
import re
from typing import Literal

from novelvideo.utils.screenplay_scene_parser import (
    BARE_ENGLISH_SENSE_SCENE_RE,
    INLINE_LABELED_SCENE_RE,
    INSERT_SCENE_RE,
    INT_EXT_TOKEN_RE,
    INTERIOR_EXTERIOR,
    INTERNATIONAL_SCENE_RE,
    LABELED_CHARACTER_RE,
    LABELED_LOCATION_RE,
    LABELED_TIME_RE,
    NUMBERED_ENGLISH_SCENE_RE,
    NUMBERED_SCENE_RE,
    SCENE_MARKER_RE,
    TIME_TOKEN_RE,
    is_scene_start_line,
    parse_scene_blocks,
)


SCENE_HEADER_WITHOUT_TIME_RE = re.compile(
    rf"^(?:\d+\s*[-–]\s*\d+\s+)?[\w'’\- ]{{2,40}}\s+{INT_EXT_TOKEN_RE}$"
)
SCENE_BLOCK_HEADER_WITHOUT_TIME_RE = re.compile(
    r"^(?:SCENE|SENSE|CẢNH)\s*\(?\d+\)?"
    r"(?:\s*:)?"
    rf".*?(?:Location|Địa điểm)\s*:\s*.+?,\s*{INT_EXT_TOKEN_RE}(?:[;,].*)?$",
    re.IGNORECASE,
)
BLOCK_STYLE_HEADER_RE = re.compile(r"^(?:SCENE|SENSE|CẢNH)\b", re.IGNORECASE)
SPEAKER_LINE_RE = re.compile(r"^[^\n:]{1,20}:(.+)$")
META_SECTION_HEADER_RE = re.compile(
    r"^(Synopsis|Character Bios?|Character Profiles?|Character Introductions?|Cast"
    r"|Tóm tắt|Giới thiệu nhân vật|Tiểu sử nhân vật)\s*:?\s*$",
    re.IGNORECASE,
)
AMBIGUOUS_SPEAKERS = {
    "he", "she", "they", "him", "her", "them", "the other party", "the other person",
    "the man", "the woman", "that person", "someone", "the voice on the phone",
    "on the phone", "voice", "the other end", "anh ấy", "cô ấy", "họ", "đối phương",
    "người đàn ông", "người phụ nữ", "ai đó", "giọng nói",
}
NUMBERED_SCENE_PREFIX_RE = re.compile(r"^\s*\d+\s*[-–.]\s*\d+")
_EXPLICIT_TIME_RE = re.compile(rf"(?:^|[\s,])(?:{TIME_TOKEN_RE})(?:$|[\s,])")

FIX_HINTS = {
    "duplicate_chapter_number": "Check the sentences in the text that look like chapter titles, so the same chapter number is not split into several chapters.",
    "scene_headers_missing_time": "Add an explicit time to the scene heading, such as DAY / NIGHT / MORNING; the system still keeps the scene boundary and normalizes it later.",
    "multi_speaker_lines": "Put each line of dialogue on its own line, with only one speaker per line.",
    "ambiguous_speakers": "Replace vague speakers such as \"he/she/the other party\" with specific character names.",
    "many_long_dialogues": "Split overly long lines of dialogue to shorten each line.",
    "missing_scene_headers": "Write in the standard format: start each episode with \"EPISODE N\", then write each scene heading on its own line as \"scene-number location time INT/EXT\" (or INT. LOCATION - TIME), followed by the characters, actions and dialogue. Example: EPISODE 1 / 1-1 City cafe DAY INT.",
    "nonstandard_scene_headers": "The system recognized the scene boundaries and will fill in or normalize any missing location, time and interior/exterior during scene planning.",
    "non_increasing_chapter_number": "Check whether the chapter numbers increase, or confirm that chapter-like wording in the text is not a mis-split title.",
    "too_few_dialogue_lines": "Add recognizable dialogue lines in the form \"CHARACTER: line\".",
    "sparse_scene_headers": "Add scene headings per scene (one scene heading for each scene).",
}


@dataclass(frozen=True)
class ScreenplayQualityIssue:
    severity: str
    code: str
    message: str


@dataclass
class ScreenplayQualityReport:
    looks_like_screenplay: bool
    metrics: dict[str, int] = field(default_factory=dict)
    blocking_issues: list[ScreenplayQualityIssue] = field(default_factory=list)
    warnings: list[ScreenplayQualityIssue] = field(default_factory=list)

    @property
    def has_blocking_issues(self) -> bool:
        return bool(self.blocking_issues)


SceneHeaderStatus = Literal["standard", "repairable", "missing"]


@dataclass(frozen=True)
class SceneHeaderAssessment:
    """Classify whether a drama screenplay has usable scene boundaries."""

    status: SceneHeaderStatus
    detected_headers: int = 0
    standard_headers: int = 0


def assess_screenplay_scene_headers(text: str) -> SceneHeaderAssessment:
    """Return a deterministic scene-header assessment.

    Scene boundaries must come from the source text. AI may normalize an
    already detected block later, but it must never invent scene boundaries
    for headerless prose during import.
    """

    candidate_lines = _extract_screenplay_candidate_lines(text or "")
    blocks = parse_scene_blocks(candidate_lines)
    detected_blocks = [
        block
        for block in blocks
        if block.header_line and _has_source_scene_header_evidence(block.header_line)
    ]
    if not detected_blocks:
        return SceneHeaderAssessment(status="missing")

    standard_headers = 0
    for block in detected_blocks:
        if (
            bool(block.location)
            and bool(block.time_of_day)
            and not block.time_inferred
            and block.interior_exterior in INTERIOR_EXTERIOR
        ):
            standard_headers += 1

    detected_headers = len(detected_blocks)
    status: SceneHeaderStatus = (
        "standard" if standard_headers == detected_headers else "repairable"
    )
    return SceneHeaderAssessment(
        status=status,
        detected_headers=detected_headers,
        standard_headers=standard_headers,
    )


def _has_source_scene_header_evidence(header_line: str) -> bool:
    """Reject scene boundaries inferred solely from prose ending in INT/EXT.

    The shared parser deliberately accepts loose historical formats, but that
    is not proof that the source contained a scene header: ordinary prose such
    as ``Sun Wukong hurried to the door ext`` can otherwise resemble a location
    ending in ``ext``. Import validation therefore requires a structural
    marker/label or an explicit time and INT/EXT pair.
    """

    header = str(header_line or "").strip()
    if not header:
        return False
    header = re.sub(
        r"(?:\s*\([^()]*\))+\s*$",
        "",
        header,
    ).strip()
    if INTERNATIONAL_SCENE_RE.fullmatch(header):
        return True
    if SCENE_MARKER_RE.fullmatch(header):
        return True
    if BARE_ENGLISH_SENSE_SCENE_RE.fullmatch(header):
        return True
    if NUMBERED_ENGLISH_SCENE_RE.fullmatch(header):
        return True
    if INSERT_SCENE_RE.fullmatch(header):
        return True
    if INLINE_LABELED_SCENE_RE.fullmatch(header):
        return True
    numbered = NUMBERED_SCENE_RE.match(header)
    if numbered and (
        bool((numbered.group("rest") or "").strip())
        or NUMBERED_SCENE_PREFIX_RE.fullmatch(header)
    ):
        return True
    if LABELED_LOCATION_RE.match(header):
        return True
    return bool(
        re.search(rf"(?:{TIME_TOKEN_RE})[\s,]*(?:{INT_EXT_TOKEN_RE})\s*$", header)
    )


def check_screenplay_import_quality(text: str) -> ScreenplayQualityReport:
    lines = _extract_screenplay_candidate_lines(text or "")
    non_empty_lines = [line for line in lines if line]
    scene_blocks = parse_scene_blocks(non_empty_lines)
    scene_header_assessment = assess_screenplay_scene_headers(text)

    scene_block_header_count = len(
        [
            block
            for block in scene_blocks
            if block.header_line and BLOCK_STYLE_HEADER_RE.match(block.header_line)
        ]
    )
    scene_header_count = len([block for block in scene_blocks if block.header_line]) - scene_block_header_count
    dialogue_line_count = 0
    multi_speaker_line_count = 0
    ambiguous_speaker_count = 0
    parenthetical_dialogue_count = 0
    long_dialogue_count = 0
    scene_headers_missing_time_count = len(
        [
            block
            for block in scene_blocks
            if block.header_line
            and (not block.time_of_day or block.time_inferred)
        ]
    )

    for line in non_empty_lines:
        if is_scene_start_line(line):
            continue
        if LABELED_LOCATION_RE.match(line):
            continue
        if LABELED_CHARACTER_RE.match(line):
            continue
        if LABELED_TIME_RE.match(line):
            continue
        if SCENE_HEADER_WITHOUT_TIME_RE.match(line) or SCENE_BLOCK_HEADER_WITHOUT_TIME_RE.match(line):
            scene_headers_missing_time_count += 1
            continue

        match = SPEAKER_LINE_RE.match(line)
        if not match:
            continue

        dialogue_line_count += 1
        dialogue_text = match.group(1).strip()
        speaker_label = line.split(":", 1)[0].strip()
        speaker_label = re.sub(r"\(.*?\)", "", speaker_label).strip()

        colon_count = line.count(":")
        if colon_count >= 2:
            multi_speaker_line_count += 1
        if speaker_label.lower() in AMBIGUOUS_SPEAKERS:
            ambiguous_speaker_count += 1
        if "(" in line:
            parenthetical_dialogue_count += 1
        if len(dialogue_text) >= 40:
            long_dialogue_count += 1

    total_scene_headers = scene_header_count + scene_block_header_count
    looks_like_screenplay = total_scene_headers >= 2 or dialogue_line_count >= 8
    report = ScreenplayQualityReport(
        looks_like_screenplay=looks_like_screenplay,
        metrics={
            "non_empty_lines": len(non_empty_lines),
            "scene_headers": scene_header_count,
            "scene_block_headers": scene_block_header_count,
            "total_scene_headers": total_scene_headers,
            "dialogue_lines": dialogue_line_count,
            "multi_speaker_lines": multi_speaker_line_count,
            "ambiguous_speakers": ambiguous_speaker_count,
            "parenthetical_dialogues": parenthetical_dialogue_count,
            "long_dialogue_lines": long_dialogue_count,
            "scene_headers_missing_time": scene_headers_missing_time_count,
            "standard_scene_headers": scene_header_assessment.standard_headers,
        },
    )

    if scene_headers_missing_time_count > 0:
        report.warnings.append(
            ScreenplayQualityIssue(
                severity="warning",
                code="scene_headers_missing_time",
                message="Detected scene headings with no explicit time anchor; later time_of_day and scene variant inheritance may be unstable.",
            )
        )

    if not looks_like_screenplay:
        report.warnings.append(
            ScreenplayQualityIssue(
                severity="warning",
                code="not_screenplay_like",
                message="The text reads more like novel prose than a scene-by-scene screenplay. This pre-check does not block the import, but later structuring may work less well.",
            )
        )
        return report

    if total_scene_headers == 0:
        report.blocking_issues.append(
            ScreenplayQualityIssue(
                severity="blocking",
                code="missing_scene_headers",
                message="No recognizable scene headings were detected (for example \"Mall ground floor entrance DAY INT\" or \"SCENE 1 Location: Noodle shop, night, INT\"), which does not meet the 2.0 screenplay import requirements.",
            )
        )
    elif total_scene_headers < max(1, dialogue_line_count // 12):
        report.warnings.append(
            ScreenplayQualityIssue(
                severity="warning",
                code="sparse_scene_headers",
                message="Few scene headings; continuous scenes and time inheritance may be unstable.",
            )
        )

    if dialogue_line_count < 5:
        report.warnings.append(
            ScreenplayQualityIssue(
                severity="warning",
                code="too_few_dialogue_lines",
                message="Few valid dialogue lines; if this is a scene with no dialogue or driven by action, you can continue the import.",
            )
        )

    if multi_speaker_line_count >= 3:
        report.warnings.append(
            ScreenplayQualityIssue(
                severity="warning",
                code="multi_speaker_lines",
                message="Several lines mix multiple speakers or multiple colons on one line. The system will try to normalize them as a tier-B screenplay, but it is better to first put each line of dialogue on its own line.",
            )
        )

    if ambiguous_speaker_count >= max(3, dialogue_line_count // 5):
        report.warnings.append(
            ScreenplayQualityIssue(
                severity="warning",
                code="ambiguous_speakers",
                message="Many vague speakers (such as \"he/she/the other party/the voice on the phone\"); later identity normalization may be unstable.",
            )
        )

    if long_dialogue_count >= max(3, dialogue_line_count // 4):
        report.warnings.append(
            ScreenplayQualityIssue(
                severity="warning",
                code="many_long_dialogues",
                message="Many overly long single lines of dialogue; this can easily cause long-dialogue problems within a single unit later.",
            )
        )

    return report


def build_import_format_check(
    text: str,
    *,
    has_chapters: bool,
    chapters: list[dict] | None = None,
    require_scene_headers: bool = False,
) -> dict:
    report = check_screenplay_import_quality(text)
    scene_header_assessment = assess_screenplay_scene_headers(text)
    metrics = dict(report.metrics)
    summary_params: dict = {}
    issues = _build_line_aware_format_issues(text or "")
    if chapters:
        issues.extend(_build_chapter_structure_issues(chapters))
    has_missing_interior_exterior = any(
        issue["code"] == "missing_interior_exterior" for issue in issues
    )
    has_specific_missing_time = any(
        issue["code"] in {"incomplete_scene_header", "scene_headers_missing_time"}
        for issue in issues
    )

    for issue in [*report.blocking_issues, *report.warnings]:
        if issue.code == "not_screenplay_like":
            continue
        if issue.code == "scene_headers_missing_time" and (
            has_missing_interior_exterior or has_specific_missing_time
        ):
            continue
        if issue.code == "sparse_scene_headers" and metrics.get("dialogue_lines", 0) < 24:
            continue
        fix = FIX_HINTS.get(issue.code)
        if fix is None:
            continue
        issues.append(
            {
                "code": issue.code,
                "line": None,
                "message": issue.message,
                "fix": fix,
                "params": {},
            }
        )

    if require_scene_headers and scene_header_assessment.status == "missing":
        if not any(issue["code"] == "missing_scene_headers" for issue in issues):
            issues.insert(
                0,
                {
                    "code": "missing_scene_headers",
                    "line": None,
                    "message": "No scene headings were recognized, so the system cannot tell where each scene starts.",
                    "fix": FIX_HINTS["missing_scene_headers"],
                    "params": {},
                },
            )
        level = "blocking"
        summary_code = "missing_scene_headers"
        summary = "A premium drama must contain scene headings: the system could not recognize where each scene starts. Add them and re-import."
    elif not has_chapters:
        level = "blocking"
        summary_code = "no_chapters"
        summary = "No valid chapters or recognizable body text were detected, so the script cannot be structured."
    elif scene_header_assessment.status == "repairable":
        if not any(issue["code"] == "nonstandard_scene_headers" for issue in issues):
            issues.insert(
                0,
                {
                    "code": "nonstandard_scene_headers",
                    "line": None,
                    "message": "Scene boundaries were recognized, but some scene metadata is incomplete.",
                    "fix": FIX_HINTS["nonstandard_scene_headers"],
                    "params": {},
                },
            )
        level = "warning"
        summary_code = "repairable_scene_headers"
        summary = "Scene boundaries were recognized; missing scene metadata will be filled in during scene planning."
    elif issues:
        level = "warning"
        summary_code = "format_risks"
        summary_params = {"count": len(issues)}
        summary = f"Upload succeeded, but {len(issues)} format risk(s) were detected that may affect scene recognition."
    else:
        level = "ok"
        summary_code = "passed"
        summary = "Upload succeeded and the screenplay format check passed."

    return {
        "level": level,
        # summary/message/fix are English-only, kept as a fallback for old clients and logs;
        # the frontend uses summary_code / issue.code for i18n, see formatCheckCopy.ts in the frontend.
        "summary": summary,
        "summary_code": summary_code,
        "summary_params": summary_params,
        "issues": issues,
        "metrics": metrics,
        "scene_header_status": scene_header_assessment.status,
    }


def _build_line_aware_format_issues(text: str) -> list[dict]:
    lines = text.splitlines()
    issues: list[dict] = []

    blocks = parse_scene_blocks(_extract_screenplay_candidate_lines(text))
    search_start = 0
    diagnosed_lines: set[int] = set()
    for block in blocks:
        header = str(block.header_line or "").strip()
        if not header or not _has_source_scene_header_evidence(header):
            continue

        line_number = None
        for line_index in range(search_start, len(lines)):
            if lines[line_index].strip() == header:
                line_number = line_index + 1
                search_start = line_index + 1
                break

        missing: list[str] = []
        missing_slots: list[str] = []
        placeholders: list[str] = []
        if not block.location:
            missing.append("location")
            missing_slots.append("location")
            placeholders.append("[LOCATION]")
        if not block.time_of_day or block.time_inferred:
            missing.append("time")
            missing_slots.append("time")
            placeholders.append("[DAY/NIGHT]")
        if block.interior_exterior not in INTERIOR_EXTERIOR:
            missing.append("INT/EXT")
            missing_slots.append("interior_exterior")
            placeholders.append("[INT/EXT]")
        if not missing:
            continue

        if line_number is not None:
            diagnosed_lines.add(line_number)
        if BLOCK_STYLE_HEADER_RE.match(header) and block.location:
            suggestion = (
                f"{header}; Location: {block.location}, "
                f"{block.time_of_day if block.time_of_day and not block.time_inferred else '[DAY/NIGHT]'}, "
                f"{block.interior_exterior or '[INT/EXT]'}"
            )
        else:
            suggestion = " ".join([header, *placeholders])
        if len(missing) > 1:
            code = "incomplete_scene_header"
        elif missing[0] == "time":
            code = "scene_headers_missing_time"
        elif missing[0] == "INT/EXT":
            code = "missing_interior_exterior"
        else:
            code = "incomplete_scene_header"
        issues.append(
            {
                "code": code,
                "line": line_number,
                "message": f"Scene heading \"{header}\" is missing: {', '.join(missing)}.",
                "fix": f"Fill it in according to the actual scene, for example \"{suggestion}\".",
                # Slot names rather than words: the UI assembles its own sentence from
                # missing_slots, and the suggested heading is rebuilt with localized
                # placeholders, so the raw fields are carried along as well.
                "params": {
                    "header": header,
                    "missing_slots": missing_slots,
                    "location": block.location or "",
                    "time_of_day": (
                        block.time_of_day
                        if block.time_of_day and not block.time_inferred
                        else ""
                    ),
                    "interior_exterior": block.interior_exterior or "",
                    "labeled_form": bool(
                        BLOCK_STYLE_HEADER_RE.match(header) and block.location
                    ),
                },
            }
        )

    for idx, raw_line in enumerate(lines, start=1):
        line = raw_line.strip()
        if not line or idx in diagnosed_lines:
            continue

        location_slot = _format_check_location_slot(line)
        if (
            location_slot
            and _EXPLICIT_TIME_RE.search(location_slot)
            and not _has_interior_exterior_slot(location_slot)
        ):
            issues.append(
                {
                    "code": "missing_interior_exterior",
                    "line": idx,
                    "message": "The scene heading is missing INT/EXT.",
                    "fix": "Add INT/EXT, for example \"location time INT/EXT\".",
                    "params": {},
                }
            )

    return issues


def _build_chapter_structure_issues(chapters: list[dict]) -> list[dict]:
    issues: list[dict] = []
    seen_numbers: set[int] = set()
    previous_number: int | None = None

    for chapter in chapters:
        number = chapter.get("number")
        if not isinstance(number, int):
            continue
        line = chapter.get("start_line")
        line_number = line + 1 if isinstance(line, int) else None
        title = str(chapter.get("title") or "").strip()

        if number in seen_numbers:
            issues.append(
                {
                    "code": "duplicate_chapter_number",
                    "line": line_number,
                    "message": f"Duplicate chapter number {number}: {title or 'untitled chapter'}.",
                    "fix": FIX_HINTS["duplicate_chapter_number"],
                    "params": {"number": number, "title": title},
                }
            )
        seen_numbers.add(number)

        if previous_number is not None and number <= previous_number:
            issues.append(
                {
                    "code": "non_increasing_chapter_number",
                    "line": line_number,
                    "message": f"The chapter number went back or repeated from {previous_number} to {number}.",
                    "fix": FIX_HINTS["non_increasing_chapter_number"],
                    "params": {"previous_number": previous_number, "number": number},
                }
            )
        previous_number = number

    return issues


def _format_check_location_slot(line: str) -> str:
    inline = INLINE_LABELED_SCENE_RE.match(line)
    if inline:
        return inline.group("location") or ""
    labeled = LABELED_LOCATION_RE.match(line)
    if labeled:
        return labeled.group("location") or ""
    if NUMBERED_SCENE_PREFIX_RE.match(line):
        return line
    return ""


def _has_interior_exterior_slot(line: str) -> bool:
    return bool(
        re.search(rf"(?:^|[\s,])(?:{INT_EXT_TOKEN_RE})(?:$|[\s,])", line)
    )


def extract_screenplay_candidate_lines(text: str) -> list[str]:
    lines = [line.strip() for line in text.splitlines()]
    if not lines:
        return []

    first_scene_idx = None
    for idx, line in enumerate(lines):
        if is_scene_start_line(line):
            first_scene_idx = idx
            break
    if first_scene_idx is not None:
        return lines[first_scene_idx:]

    filtered: list[str] = []
    in_meta_section = False
    for line in lines:
        if not line:
            continue
        if META_SECTION_HEADER_RE.match(line):
            in_meta_section = True
            continue
        if in_meta_section:
            if is_scene_start_line(line):
                in_meta_section = False
                filtered.append(line)
                continue
            if re.match(r"^(?:SCENE|CẢNH)\s*\(?\d+\)?", line, re.IGNORECASE):
                in_meta_section = False
                filtered.append(line)
                continue
            if re.match(r"^\(?\d+\)\s*[\w·]{1,20}\s*:", line):
                continue
            if line == "END":
                continue
            continue
        filtered.append(line)
    return filtered


def _extract_screenplay_candidate_lines(text: str) -> list[str]:
    """Backward-compatible private alias."""
    return extract_screenplay_candidate_lines(text)
