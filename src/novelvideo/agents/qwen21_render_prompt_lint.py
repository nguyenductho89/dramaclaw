"""Lint for a Qwen-Image 2.1 render prompt — checked before every RunPod
Qwen-Image 2.1 render submission (`runpod_qwen21_render` /
`runpod_qwen21_render_multi`).

Rules come from the official Qwen-Image 2.1 "Edit Prompt Enhancer" rules in
`agents/prompts/qwen21_render_rules.md` (copied verbatim from the official
ComfyUI workflow template) plus the project-specific pitfalls recorded
there and in `.claude/CLAUDE.md`. Reuses `LintIssue`/`LintResult` from
`qwen_edit_render_prompt_lint` (same shape, no need to redefine) — the
*rules* genuinely differ between the two models (different tag convention,
different official prompt standard), which is why this is a separate lint
function rather than a parametrized version of the Edit-2511 one. Never
blocks generation on its own — the caller decides what counts as a hard
error vs. a warning; see `LintResult.ok`.
"""

from __future__ import annotations

import re
from typing import Literal

from novelvideo.agents.qwen_edit_render_prompt_lint import LintIssue, LintResult

MAX_PROMPT_CHARS = 2000  # short single-instruction edit prompts

_IMAGE_TAG_RE = re.compile(r"<image(\d+)>")
# Case/whitespace-insensitive superset of the valid tag — used to find
# near-misses (wrong case, a stray space) that _IMAGE_TAG_RE alone would
# just silently not match, rather than flag.
_IMAGE_TAG_NEAR_RE = re.compile(r"<\s*image\s*\d+\s*>", re.IGNORECASE)
_MALFORMED_WRAPPER_RE = re.compile(r"\[image\d+\]|\{image\d+\}|<img\d+>", re.IGNORECASE)
_LEGACY_TAG_RE = re.compile(
    r"\bPicture\s+\d+\b|\bimage\s+\d\b|\bthe\s+(first|second|third)\s+image\b",
    re.IGNORECASE,
)
_BANNED_LAYOUT_WORDS_RE = re.compile(
    r"\b(grid|panel|panels|storyboard|collage|regions?)\b", re.IGNORECASE
)
_RESOLUTION_TOKEN_RE = re.compile(
    r"\b\d+\s*:\s*\d+\b|\b\d{3,4}\s*[xX]\s*\d{3,4}\b|\b[1-4](\.5)?K\b"
)
_WRAPPER_OUTPUT_RE = re.compile(
    r'^\s*\{|"Rewritten"|```|^\s*#{1,6}\s|</?think>', re.MULTILINE
)
_INSTRUCTION_VERB_RE = re.compile(
    r"^(Replace|Convert|Change|Keep|Restore|Add|Remove|Extend|Perform|Edit|"
    r"Transform|Turn|Make|Render|Apply|Adjust|Recreate)\b",
    re.IGNORECASE,
)
_PHOTOREALISTIC_RE = re.compile(r"photorealistic|photograph", re.IGNORECASE)
# "preserv" (no trailing e), not "preserve" — the literal word misses
# "preserving"/"preserved", a real false positive seen 2026-10-18 on
# BabyStories beat 7's AI-rewritten scene prompt ("strictly preserving
# their exact poses").
_PRESERVATION_RE = re.compile(r"unchanged|keep|preserv|retain", re.IGNORECASE)
_PROHIBITION_RE = re.compile(r"\b(do not|don't|never)\b", re.IGNORECASE)
# Deliberately excludes "slightly" — legitimate for a precise spatial
# degree ("facing slightly left"), not uncertainty, and real AI-rewrite
# output uses it this way often enough to be a pure false positive
# (confirmed 2026-10-18, BabyStories beat 7).
_HEDGING_RE = re.compile(r"\b(maybe|possibly|perhaps)\b|either .* or", re.IGNORECASE)
_CJK_RE = re.compile("[\u4e00-\u9fff]")
_VIETNAMESE_DIACRITICS_RE = re.compile(
    "[ăâđêôơưĂÂĐÊÔƠƯ]|"
    "[àáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]",
    re.IGNORECASE,
)
# Palette-derived list (BRIDGMAN_CHARACTER_PALETTE,
# generators/episode_optimizer.py) — see qwen_edit_render_prompt_lint.py's
# copy of this regex for why common clothing colors (red/blue/green/
# yellow/orange/purple) are deliberately excluded. Confirmed missing
# "cyan" in a real AI-rewrite output before this fix (2026-10-18,
# BabyStories beat 7: "strictly preserving the cyan-colored mannequin
# figure").
_MANNEQUIN_COLOR_WORDS_RE = re.compile(
    r"\b(magenta|fuchsia|chartreuse|crimson|cyan|lime|violet|mint|azure|aqua|indigo)"
    r"(?:-colou?red)?\b",
    re.IGNORECASE,
)
_ACTION_VERB_RE = re.compile(
    r"\b(stand(?:s|ing)?|sit(?:s|ting)?|lectur(?:e|es|ing)|gestur(?:e|es|ing)|"
    r"point(?:s|ing)?|walk(?:s|ing)?|speak(?:s|ing)?|lean(?:s|ing)?|"
    r"kneel(?:s|ing)?|bend(?:s|ing)?|gazing|looking)\b",
    re.IGNORECASE,
)
_VERBAL_FACE_DESCRIPTION_RE = re.compile(
    r"\b(eye color|jawline|nose shape|cheekbone|iris color|eyebrow shape)\b",
    re.IGNORECASE,
)


def lint_qwen21_render_prompt(
    prompt: str,
    *,
    stage: Literal["full", "scene_only", "inpaint"] = "full",
) -> LintResult:
    """`stage` controls which `<imageN>` tags are expected:
    - `full`/`inpaint`: Multi-Image input (N=2) — the prompt must use both
      `<image1>` and `<image2>`.
    - `scene_only`: single-image input (N=1) — the official rule says NOT
      to tag at all; any `<imageN>` tag here is an error.
    """
    result = LintResult()
    text = prompt or ""
    if not text.strip():
        result.issues.append(LintIssue("error", "empty", "Prompt is empty"))
        return result

    if "\n" in text:
        result.issues.append(
            LintIssue(
                "error",
                "newline",
                "Prompt contains a line break — per the official standard, the output must be one continuous paragraph",
            )
        )

    if len(text) > MAX_PROMPT_CHARS:
        result.issues.append(
            LintIssue("error", "too_long", f"Prompt is too long ({len(text)}/{MAX_PROMPT_CHARS} characters)")
        )

    tags = [int(n) for n in _IMAGE_TAG_RE.findall(text)]
    has_image1 = 1 in tags
    has_image2 = 2 in tags
    out_of_range = [n for n in tags if n > 2]

    if stage in ("full", "inpaint"):
        if not has_image1:
            result.issues.append(
                LintIssue("error", "missing_image1_tag", "Missing <image1> — this stage needs Multi-Image input (N=2)")
            )
        if not has_image2:
            result.issues.append(
                LintIssue("error", "missing_image2_tag", "Missing <image2> — this stage needs Multi-Image input (N=2)")
            )
    elif stage == "scene_only" and tags:
        result.issues.append(
            LintIssue(
                "error",
                "unexpected_tag",
                'stage="scene_only" has only 1 attached image — official rule: single-image input must NOT carry <imageN> tags',
            )
        )

    if out_of_range:
        result.issues.append(
            LintIssue("error", "tag_out_of_range", f"Tags out of range (only <image1>/<image2> are allowed): {out_of_range}")
        )

    has_malformed = bool(_MALFORMED_WRAPPER_RE.search(text)) or len(
        _IMAGE_TAG_NEAR_RE.findall(text)
    ) != len(_IMAGE_TAG_RE.findall(text))
    if has_malformed:
        result.issues.append(
            LintIssue("error", "malformed_tag", 'Malformed tag — it must be exactly "<image1>"/"<image2>" (lowercase, no spaces)')
        )

    if _LEGACY_TAG_RE.search(text):
        result.issues.append(
            LintIssue(
                "error",
                "legacy_tag",
                'Uses "Picture N"/"image 1"/"the first image"/... — Qwen-Image 2.1 does not auto-insert tokens like Edit-2511, and the official rule requires exactly "<image1>"/"<image2>"',
            )
        )

    if _BANNED_LAYOUT_WORDS_RE.search(text):
        result.issues.append(
            LintIssue("error", "layout_word", "Contains grid/panel/storyboard/collage/region wording — this is a single image, not a multi-frame layout")
        )

    if _RESOLUTION_TOKEN_RE.search(text):
        result.issues.append(
            LintIssue("error", "resolution_token", 'Contains an aspect-ratio/resolution token (e.g. "9:16", "2K") — official rule: "output size is decided downstream, not by you"')
        )

    if _WRAPPER_OUTPUT_RE.search(text):
        result.issues.append(
            LintIssue("error", "wrapper_output", 'Output looks wrapped in JSON/a code fence/a heading/a leftover <think> tag — official rule: a single plain paragraph with no wrapper (unlike Edit-2511\'s {"Rewritten":...})')
        )

    if not _INSTRUCTION_VERB_RE.search(text.strip()):
        result.issues.append(
            LintIssue("warning", "missing_lead_verb", "The first sentence does not start with an instruction verb (Replace/Convert/Change/...)")
        )

    if not _PHOTOREALISTIC_RE.search(text):
        result.issues.append(
            LintIssue("warning", "missing_medium_conversion", "No 'photorealistic'/'photograph' wording found — the sketch-to-photo conversion should be stated explicitly")
        )

    if not _PRESERVATION_RE.search(text):
        result.issues.append(
            LintIssue("warning", "missing_preservation_clause", "No preservation clause (unchanged/keep/preserve) found for the content that is not being edited")
        )

    if '"' in text:
        result.issues.append(
            LintIssue("warning", "quoted_text", 'Contains double quotes — per the official rule, quotes are only for text that will be DISPLAYED in the image, and a render beat needs no text in the image')
        )

    if _CJK_RE.search(text) or _VIETNAMESE_DIACRITICS_RE.search(text):
        result.issues.append(
            LintIssue("warning", "non_english_prose", "Non-English text (CJK characters or Vietnamese diacritics) in the description — write it in English (language decision A)")
        )

    if _PROHIBITION_RE.search(text):
        result.issues.append(
            LintIssue("warning", "prohibition_phrasing", 'Uses negative phrasing (do not/never) — the official rule recommends affirmative wording ("keep X unchanged")')
        )

    if _HEDGING_RE.search(text):
        result.issues.append(
            LintIssue("warning", "hedging", "Contains hedging words (maybe/possibly/either...or) — official rule: be decisive and do not leave options open")
        )

    if _MANNEQUIN_COLOR_WORDS_RE.search(text):
        result.issues.append(
            LintIssue("warning", "mannequin_color_word", "Contains a mannequin tracking color name (magenta/fuchsia/...) — the model may mistake it for a real clothing color")
        )

    if stage == "inpaint" and _ACTION_VERB_RE.search(text):
        result.issues.append(
            LintIssue("warning", "inpaint_describes_action", "The inpaint prompt describes actions/poses — the pose is already locked by the mask, and this description risks assigning another person's action")
        )

    if _VERBAL_FACE_DESCRIPTION_RE.search(text):
        result.issues.append(
            LintIssue("warning", "verbal_face_description", "Describes the face in words (eye color/jawline/...) — official rule: identity should point to <image2>, not be described verbally")
        )

    return result
