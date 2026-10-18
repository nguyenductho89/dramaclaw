"""Unified {{}} marker parsing helpers.

Two formats are supported:
- {{identity_id}} (new format): e.g. {{Alice_teen}}
- {{character name}} (legacy format, backward compatible): e.g. {{Alice}}

Used by:
- prompt_builder.py: replaced with character_tag
- nanobanana_grid.py: replaced with character_tag
- state.py: replaced with the character appearance description or real name
"""

import hashlib
import re
import unicodedata
from typing import Optional


def resolve_marker(
    marker: str,
    character_map: dict[str, dict],
    identity_to_char: dict[str, str] | None = None,
) -> tuple[str | None, str | None]:
    """Resolve a single {{}} marker.

    Args:
        marker: marker content (without the braces), e.g. "Alice_teen" or "Alice"
        character_map: {character name: {character_tag, ...}} character config
        identity_to_char: {identity_id: character name} reverse mapping (optional)

    Returns:
        (character name, character_tag), or (None, None) if nothing matched
    """
    # 1. Match the character name directly (legacy format {{character name}})
    if marker in character_map:
        char_cfg = character_map[marker]
        char_tag = _get_char_tag(marker, char_cfg)
        return (marker, char_tag)

    # 2. Look up the character name through identity_to_char (new format {{identity_id}})
    if identity_to_char and marker in identity_to_char:
        char_name = identity_to_char[marker]
        if char_name in character_map:
            char_cfg = character_map[char_name]
            char_tag = _get_char_tag(char_name, char_cfg)
            return (char_name, char_tag)

    # 3. Prefix match: identity_id is usually "{character name}_{state}"
    for char_name in character_map:
        if marker.startswith(char_name + "_") or marker.startswith(char_name + "·"):
            char_cfg = character_map[char_name]
            char_tag = _get_char_tag(char_name, char_cfg)
            return (char_name, char_tag)

    return (None, None)


def resolve_visual_description_markers(
    visual_description: str,
    character_map: dict[str, dict],
    identity_to_char: dict[str, str] | None = None,
    use_names: bool = False,
    keep_identity_suffix: bool = False,
    use_identity_id: bool = False,
    append_char_name: bool = False,
) -> str:
    """Replace {{}} markers in visual_description with character_tag or the character name.

    Supports:
    - {{identity_id}} → resolve the character name → char_tag / character name / identity_id
    - {{character name}} → char_tag / character name (backward compatible)
    - {{unknown}} → drop the braces and keep the text

    Args:
        visual_description: picture description containing {{}} markers
        character_map: {character name: {character_tag, ...}} or {character name: CharConfig}
        identity_to_char: {identity_id: character name} reverse mapping (optional)
        use_names: when True, return the character name instead of the tag (used in Sketch mode)
        keep_identity_suffix: when True, keep the identity suffix, e.g. Alice(adult) (used in Sketch mode)
        use_identity_id: when True, return the identity_id verbatim (e.g. Alice_adult)
        append_char_name: when True, append the character name after the identity tag,
            e.g. [TRY_2ec7·Alice] (only effective when use_identity_id=True, used in Sketch mode)

    Returns:
        The text after replacement
    """
    if not visual_description:
        return visual_description

    def replace_match(m: re.Match) -> str:
        marker = m.group(1)
        char_name, char_tag = resolve_marker(marker, character_map, identity_to_char)
        if char_tag:
            if use_identity_id:
                # Identity-level tag: different identities of the same character produce different hashes
                identity_tag = compute_char_tag(char_name, identity_id=marker)
                if append_char_name and char_name:
                    # [TRY_2ec7] → [TRY_2ec7·Alice]
                    identity_tag = identity_tag[:-1] + f"·{char_name}]"
                return f"{identity_tag} "
            if use_names:
                # Keep the identity suffix: {{Alice_adult}} → Alice(adult)
                if keep_identity_suffix and marker != char_name and marker.startswith(char_name + "_"):
                    suffix = marker[len(char_name) + 1:]
                    return f"{char_name}({suffix})"
                return char_name
            return char_tag
        # Unmatched: keep as is (do not drop the braces)
        return m.group(0)

    return re.sub(r'\{?\{([^}]+)\}\}?', replace_match, visual_description)


def build_identity_to_char_map(
    character_map: dict[str, dict],
    valid_identity_ids: set[str] | None = None,
) -> dict[str, str]:
    """Build the identity_id → character name reverse mapping from character_map.

    Iterate over the identities of each character in character_map (if present)
    and build the identity_id → char_name mapping.

    For a simple character_map (with only character_tag),
    use the "character name_*" prefix matching rule.

    Args:
        character_map: {character name: {...}} character config
        valid_identity_ids: set of valid identity_ids (optional)

    Returns:
        {identity_id: character name}
    """
    result = {}

    if valid_identity_ids:
        # Map identity_id to a character name by prefix matching
        for identity_id in valid_identity_ids:
            for char_name in character_map:
                if identity_id.startswith(char_name + "_") or identity_id == char_name:
                    result[identity_id] = char_name
                    break

    return result


def _get_char_tag(char_name: str, char_cfg) -> str:
    """Get the character_tag from a character config.

    Compatible with both dict and object config formats.
    """
    if isinstance(char_cfg, dict):
        tag = char_cfg.get("character_tag", "")
        if not tag:
            tag = compute_char_tag(char_name)
        return tag
    else:
        # Object format (CharConfig)
        tag = getattr(char_cfg, "character_tag", None) or ""
        if not tag:
            tag = compute_char_tag(char_name)
        return tag


def compute_char_tag(char_name: str, identity_id: str | None = None) -> str:
    """Compute the character tag (uppercase initials + hash suffix).

    When identity_id is provided, the hash is computed from identity_id,
    so different identities of the same character produce different tags.

    Args:
        char_name: character name (used to build the initials prefix)
        identity_id: identity ID (optional, used to distinguish the hash of different identities of the same character)

    Returns:
        e.g. "[TRY_a1b2]"
    """
    initials = []
    # Fold accents (e.g. Vietnamese diacritics) to plain ASCII letters first.
    folded = unicodedata.normalize("NFKD", char_name.replace("đ", "d").replace("Đ", "D"))
    for char in folded:
        if re.match(r'[a-zA-Z0-9]', char):
            initials.append(char.upper())

    pinyin_initials = ''.join(initials) if initials else 'CHAR'
    hash_source = identity_id if identity_id else char_name
    name_hash = hashlib.md5(hash_source.encode('utf-8')).hexdigest()[:4]
    return f"[{pinyin_initials}_{name_hash}]"
