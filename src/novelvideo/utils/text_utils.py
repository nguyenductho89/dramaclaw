"""Text-processing helpers."""

import re

# Base color words (matched as whole words, case-insensitive).
_COLOR_WORDS = [
    "red", "crimson", "scarlet", "vermilion", "maroon", "burgundy", "pink",
    "orange", "amber", "yellow", "gold", "golden", "blonde", "green", "emerald",
    "olive", "teal", "cyan", "blue", "navy", "azure", "indigo", "turquoise",
    "purple", "violet", "lavender", "magenta", "brown", "tan", "beige",
    "grey", "gray", "silver", "white", "ivory", "cream", "black", "ebony",
    "bronze", "copper", "rose",
]

# Optional shade modifiers that precede a color word ("dark red", "pale-blue").
_SHADE_MODIFIERS = [
    "dark", "deep", "light", "pale", "bright", "vivid", "dull", "faded",
    "rich", "warm", "cool", "soft", "pure", "snow", "blood",
]

# Longest words first so that alternation prefers the longer match.
_COLOR_WORDS.sort(key=len, reverse=True)

# Match [modifier ]color[-colored|-coloured|ish] as a whole word.
_COLOR_PATTERN = re.compile(
    r"\b(?:(?:" + "|".join(_SHADE_MODIFIERS) + r")[- ])?"
    r"(?:" + "|".join(re.escape(w) for w in _COLOR_WORDS) + r")"
    r"(?:[- ]colou?red|ish)?\b",
    re.IGNORECASE,
)

# Placeholder prefix (a character sequence that cannot occur in normal text).
_PLACEHOLDER_PREFIX = "\x00MARK"


def strip_color_words(text: str) -> str:
    """Strip color modifiers from text, leaving the content inside {{}} markers untouched.

    Strategy: every color word is removed. Sketches only need composition and pose;
    color is carried entirely by the marker system.

    Examples:
        >>> strip_color_words("snow white skin")
        'skin'
        >>> strip_color_words("a red-colored long dress")
        'a long dress'
        >>> strip_color_words("{{Alice_wedding}} bright red wedding gown")
        '{{Alice_wedding}} wedding gown'
    """
    if not text:
        return text

    # 1. Protect {{}} markers by swapping them for placeholders.
    markers: list[str] = []
    def _protect_marker(m: re.Match) -> str:
        idx = len(markers)
        markers.append(m.group(0))
        return f"{_PLACEHOLDER_PREFIX}{idx}\x00"

    protected = re.sub(r"\{\{.*?\}\}", _protect_marker, text)

    # 2. Strip color words, then collapse the gap left behind.
    result = _COLOR_PATTERN.sub("", protected)
    result = re.sub(r"[ \t]{2,}", " ", result)
    result = re.sub(r"^[ \t]+", "", result, flags=re.MULTILINE)

    # 3. Restore the placeholders.
    for idx, marker in enumerate(markers):
        result = result.replace(f"{_PLACEHOLDER_PREFIX}{idx}\x00", marker)

    return result
