"""Prompt input sanitizer - removes possible injected instructions."""

import re


# Common injection patterns
_INJECTION_PATTERNS = [
    # System/role instruction override (English)
    re.compile(r"\[?\s*(SYSTEM|ASSISTANT|USER|HUMAN)\s*[:\]]\s*", re.IGNORECASE),
    # Common injected instructions (English)
    re.compile(
        r"(?:ignore|disregard|forget|override|bypass)\s+"
        r"(?:(?:all|previous|above|prior|earlier)\s+)+"
        r"(?:instructions?|rules?|prompts?|constraints?)",
        re.IGNORECASE,
    ),
    # XML-style tag injection
    re.compile(r"<\s*/?\s*(?:system|instruction|prompt|role)\s*>", re.IGNORECASE),
    # Vietnamese injected instructions: ignore/skip/override + instructions/rules/review/checks
    re.compile(
        r"(?:hãy\s+|vui lòng\s+|bạn phải\s+)?"
        r"(?:bỏ qua|phớt lờ|lờ đi|bỏ qua hết|vượt qua|ghi đè)\s+"
        r"(?:(?:tất cả|mọi|toàn bộ|các|những|trước đó|ở trên|phía trên)\s+)*"
        r"(?:hướng dẫn|chỉ dẫn|chỉ thị|quy tắc|luật|ràng buộc|yêu cầu|giới hạn|kiểm tra|kiểm duyệt)",
        re.IGNORECASE,
    ),
    # Vietnamese injection: directly output/return passed/true/pass
    re.compile(
        r"(?:hãy\s+|vui lòng\s+|bạn phải\s+)?"
        r"(?:trực tiếp|bắt buộc|vô điều kiện)\s+"
        r"(?:xuất|trả về|trả lời|báo cáo|in ra)"
        r".*?"
        r"(?:passed|true|đạt|hợp lệ|điểm tối đa|10 điểm)",
        re.IGNORECASE,
    ),
]


def sanitize_prompt_input(text: str | None) -> str:
    """Remove potentially injected instructions from user-controlled text.

    Applies basic sanitization to fields spliced into LLM prompts, such as
    visual_description, scene_id, time_of_day, visual_style and
    appearance_details.

    Note: this is a line of defense, not a silver bullet. The core protection
    relies on the structured-output constraints in the LLM system prompt and
    the forced parsing of output_type.

    Args:
        text: Raw text (may be None)

    Returns:
        The sanitized text
    """
    if not text:
        return ""

    result = text
    for pattern in _INJECTION_PATTERNS:
        result = pattern.sub("", result)

    return result.strip()
