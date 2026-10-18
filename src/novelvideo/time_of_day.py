from __future__ import annotations

import re
from typing import Literal

CanonicalTimeOfDay = Literal["dawn", "morning", "noon", "afternoon", "day", "dusk", "night"]
TimeOfDayOrEmpty = Literal["", "dawn", "morning", "noon", "afternoon", "day", "dusk", "night"]
LlmTimeOfDay = Literal["none", "dawn", "morning", "noon", "afternoon", "day", "dusk", "night"]

CANONICAL_TIME_OF_DAY_VALUES: tuple[str, ...] = (
    "dawn",
    "morning",
    "noon",
    "afternoon",
    "day",
    "dusk",
    "night",
)
TIME_OF_DAY_VALUES_WITH_EMPTY: tuple[str, ...] = ("", *CANONICAL_TIME_OF_DAY_VALUES)

# Small English/Vietnamese alias table for LLM / screenplay output.
TIME_OF_DAY_ALIASES_BY_CANONICAL: dict[str, tuple[str, ...]] = {
    "dawn": ("dawn", "daybreak", "sunrise", "early morning", "bình minh", "sáng sớm", "rạng sáng"),
    "morning": ("morning", "buổi sáng", "sáng"),
    "noon": ("noon", "midday", "buổi trưa", "trưa"),
    "afternoon": ("afternoon", "buổi chiều", "chiều"),
    "day": ("day", "daytime", "ngày", "ban ngày"),
    "dusk": ("dusk", "evening", "twilight", "sunset", "hoàng hôn", "chiều tối", "buổi tối"),
    "night": (
        "night",
        "nighttime",
        "midnight",
        "late night",
        "ban đêm",
        "đêm",
        "tối",
        "khuya",
        "nửa đêm",
    ),
}

_NORMALIZED_TIME_OF_DAY: dict[str, str] = {
    alias: canonical
    for canonical, aliases in TIME_OF_DAY_ALIASES_BY_CANONICAL.items()
    for alias in aliases
}
_CLOCK_TIME_RE = re.compile(
    r"^(?P<hour>\d{1,2})(?::(?P<minute>\d{2}))?\s*(?P<meridiem>AM|PM)?$",
    re.IGNORECASE,
)


def _clock_hour_to_time_of_day(hour: int) -> str:
    if hour < 5:
        return "night"
    if hour < 8:
        return "dawn"
    if hour < 12:
        return "morning"
    if hour == 12:
        return "noon"
    if hour < 17:
        return "afternoon"
    if hour < 20:
        return "dusk"
    return "night"


def normalize_time_of_day(value: str | None) -> str:
    """Normalize extracted screenplay time words into the closed beat-time set."""

    text = str(value or "").strip()
    if not text:
        return ""
    direct = _NORMALIZED_TIME_OF_DAY.get(text.lower())
    if direct:
        return direct
    clock_match = _CLOCK_TIME_RE.match(text)
    if clock_match and (clock_match.group("minute") or clock_match.group("meridiem")):
        hour = int(clock_match.group("hour"))
        minute = int(clock_match.group("minute") or 0)
        meridiem = str(clock_match.group("meridiem") or "").upper()
        if minute < 60 and (
            (meridiem and 1 <= hour <= 12) or (not meridiem and 0 <= hour <= 23)
        ):
            if meridiem:
                hour = hour % 12 + (12 if meridiem == "PM" else 0)
            return _clock_hour_to_time_of_day(hour)
    return text


def time_of_day_name_candidates(value: str | None) -> list[str]:
    """Return likely plate-name suffixes for a canonical or legacy time token."""

    text = str(value or "").strip()
    if not text:
        return []
    canonical = normalize_time_of_day(text)
    if canonical not in TIME_OF_DAY_ALIASES_BY_CANONICAL:
        return []
    candidates: list[str] = []
    for item in (canonical, *TIME_OF_DAY_ALIASES_BY_CANONICAL[canonical]):
        item = str(item or "").strip()
        if item and item not in candidates:
            candidates.append(item)
    return candidates


def is_time_of_day_token(value: str | None) -> bool:
    return bool(time_of_day_name_candidates(value))
