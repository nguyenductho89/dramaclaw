# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Section headings of the scene ``environment_prompt`` 360-degree contract.

The headings are both parser markers and text the user reads, so a stored prompt carries
the set matching the project's asset language and every reader accepts both sets. Code
that works with parsed sections uses the Chinese heading as the section key.
"""

from __future__ import annotations

import re

from novelvideo.utils.source_language import AssetLanguage

# Contract order. The English set is upper case so that ordinary prose such as
# "back:" is not mistaken for a section marker.
SCENE_HEADINGS_EN = {
    "正面": "FRONT",
    "左侧": "LEFT",
    "右侧": "RIGHT",
    "背面": "BACK",
    "光源": "LIGHTING",
    "材质/风格": "MATERIALS/STYLE",
    "禁止元素": "FORBIDDEN",
}
SCENE_HEADINGS = tuple(SCENE_HEADINGS_EN)
_KEY_BY_MARKER = {
    **{heading: heading for heading in SCENE_HEADINGS},
    **{english: heading for heading, english in SCENE_HEADINGS_EN.items()},
}
_MARKERS = "|".join(re.escape(marker) for marker in _KEY_BY_MARKER)

# A heading may open the text or follow a newline or a sentence break. Models routinely
# emit the whole contract on one line, so line starts alone are not enough.
SCENE_HEADING_RE = re.compile(
    r"(?P<lead>(?:^|[\n。；;]|\.(?=[ \t]))[ \t]*)(?P<marker>" + _MARKERS + r")[ \t]*[:：][ \t]*"
)
# Any occurrence, for removing markers from text before inspecting the bodies.
SCENE_HEADING_MARKER_RE = re.compile(r"(?:" + _MARKERS + r")\s*[:：]")


def scene_heading_key(marker: str) -> str:
    """The section key for a marker written in either language."""
    return _KEY_BY_MARKER[marker]


def localize_scene_headings(text: str, language: AssetLanguage) -> str:
    """Rewrite the section markers in ``language``; section bodies are left untouched."""

    def replace(match: re.Match[str]) -> str:
        key = scene_heading_key(match.group("marker"))
        heading = f"{SCENE_HEADINGS_EN[key]}: " if language == "en" else f"{key}："
        return f"{match.group('lead')}{heading}"

    return SCENE_HEADING_RE.sub(replace, str(text or ""))
