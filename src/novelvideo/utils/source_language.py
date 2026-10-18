"""Small, deterministic language policy for generated asset prose.

DramaClaw supports English and Vietnamese. Anything that is not recognisably
Vietnamese is treated as English.
"""

from __future__ import annotations

import inspect
import re
from typing import Literal

from langdetect import DetectorFactory, LangDetectException, detect

AssetLanguage = Literal["en", "vi"]

DetectorFactory.seed = 0

# Letters that only occur in Vietnamese among the Latin scripts we meet:
# d-stroke, the circumflex/breve/horn vowels, and every tone-marked vowel
# in Latin Extended Additional (U+1EA0-U+1EF9). Plain a/e/i/o/u/y with an
# acute or grave accent are shared with French/Spanish and are NOT decisive.
_VI_STRONG_CHAR_RE = re.compile(
    "[\u0111\u0110\u0103\u0102\u00e2\u00c2\u00ea\u00ca\u00f4\u00d4"
    "\u01a1\u01a0\u01b0\u01af\u1ea0-\u1ef9]"
)
_WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)
_VI_WORD_RATIO = 0.15

# Languages whose prose templates are the English ones (Vietnamese output is
# produced by the language instruction, not by separate templates).
EN_LIKE_LANGUAGES: tuple[str, ...] = ("en", "vi")

LANGUAGE_NAMES: dict[str, str] = {"en": "English", "vi": "Vietnamese"}


def _looks_vietnamese(text: str) -> bool:
    words = _WORD_RE.findall(text)
    if not words:
        return False
    strong = sum(1 for word in words if _VI_STRONG_CHAR_RE.search(word))
    if strong and strong / len(words) >= _VI_WORD_RATIO:
        return True
    # Short or tone-light lines ("Xin chao", "La ban toi") fall back to the
    # statistical detector, which knows Vietnamese well.
    try:
        return bool(strong) and detect(text) == "vi"
    except LangDetectException:
        return False


def detect_asset_language(text: str) -> AssetLanguage:
    """Choose ``vi`` for Vietnamese prose, ``en`` for everything else."""
    return "vi" if _looks_vietnamese(str(text or "")) else "en"


def language_name(language: str) -> str:
    """Human-readable language name used in prompts and dialogue tags."""
    return LANGUAGE_NAMES.get(language, "English")


def asset_language_instruction(language: AssetLanguage) -> str:
    """Return the shared language rule appended to model requests."""
    name = language_name(language)
    return (
        f"Write every user-visible prose field in {name}. "
        "Keep every supplied character and location name verbatim; "
        "never translate, romanize, or rewrite a name."
    )


async def detect_episode_asset_language(
    store: object,
    episode_number: int,
    *,
    fallback_text: str = "",
) -> AssetLanguage:
    """Resolve language from the persisted author-controlled episode text.

    Generated Beat fields are accepted only as a last-resort compatibility
    fallback for detached stores that do not expose episode source content.
    """
    content_store = getattr(store, "sqlite_store", None) or store
    episode_getter = getattr(content_store, "get_episode", None)
    if callable(episode_getter):
        episode = episode_getter(episode_number)
        if inspect.isawaitable(episode):
            episode = await episode
        if episode is not None:
            from novelvideo.sqlite_store import load_episode_planning_content

            content = await load_episode_planning_content(store, episode)
            if content.strip():
                return detect_asset_language(content)

    for candidate_store in (content_store, store):
        loader = getattr(candidate_store, "load_working_content", None)
        if not callable(loader):
            continue
        content = loader(episode_number)
        if inspect.isawaitable(content):
            content = await content
        if str(content or "").strip():
            return detect_asset_language(str(content))

    return detect_asset_language(fallback_text)
