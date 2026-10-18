"""Deterministically parse the scene list from a formatted screenplay.

Parsing rules:
- An X-Y line matches the scene number; location info is at the end of the X-Y
  line or on the next line.
- Location line = the line between X-Y and the characters line (exactly 1 line).
- context_lines = all lines after the characters line up to the next scene.
- "/" separates multiple locations.
- Short room names inherit the building prefix of the first location.
"""

from dataclasses import dataclass, field

from novelvideo.utils.screenplay_scene_parser import (
    EPISODE_HEADER_RE,
    is_scene_start_line,
    parse_scene_blocks,
    parse_character_line,
    parse_location_line,
)


@dataclass
class SceneCandidate:
    name: str
    time_of_day: str = "day"
    interior: bool = True
    episodes: list[int] = field(default_factory=list)
    context_lines: list[str] = field(default_factory=list)
    characters: list[str] = field(default_factory=list)


def extract_synopsis(text: str) -> str:
    """Extract the synopsis and character settings that precede the first episode."""
    for i, line in enumerate(text.splitlines()):
        stripped = line.strip()
        if EPISODE_HEADER_RE.match(stripped) or is_scene_start_line(stripped):
            return "\n".join(text.splitlines()[:i]).strip()
    return ""


def parse_scenes(text: str) -> list[SceneCandidate]:
    """Parse the scene list from a formatted screenplay.

    Two formats are supported:
    - Scene number and location on the same line: `1-2 Mall ground floor entrance DAY INT`
    - Scene number on its own line, location on the next line:
      `1-1\nMall ground floor entrance DAY INT`
    """
    blocks = parse_scene_blocks(text)
    scenes_by_name: dict[str, SceneCandidate] = {}
    for block in blocks:
        if not block.location:
            continue
        episode = block.episode or 1
        loc_info = parse_location_line(
            f"{block.location} {block.time_of_day or 'day'} {block.interior_exterior or 'int'}"
        )
        if not loc_info:
            loc_info = [
                (
                    block.location,
                    block.time_of_day or "day",
                    block.interior_exterior != "ext",
                )
            ]
        for name, tod, interior in loc_info:
            sc = scenes_by_name.get(name)
            if not sc:
                sc = SceneCandidate(name=name, time_of_day=tod, interior=interior)
                scenes_by_name[name] = sc
            if episode not in sc.episodes:
                sc.episodes.append(episode)
            for ch in block.characters:
                if ch not in sc.characters:
                    sc.characters.append(ch)
            sc.context_lines.extend(block.lines)

    return list(scenes_by_name.values())


def _parse_character_line(line: str) -> list[str]:
    """Parse a characters line and extract the character names.

    Rules:
    - Split on commas
    - A name in parentheses is taken as the character name: Clerk (Li) -> Li
    - Names without parenthesized notes are kept as-is
    """
    return parse_character_line(line)


def get_episode_characters(text: str) -> dict[int, list[str]]:
    """Parse the characters appearing in each episode. Returns {episode: [names]}."""
    scenes = parse_scenes(text)
    result: dict[int, set[str]] = {}
    for sc in scenes:
        for ep in sc.episodes:
            result.setdefault(ep, set()).update(sc.characters)
    return {ep: sorted(chars) for ep, chars in result.items()}


def _parse_location_line(line: str) -> list[tuple[str, str, bool]]:
    """Parse a location line and return [(name, time_of_day, interior), ...]."""
    return parse_location_line(line)

