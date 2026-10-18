"""How identity_id references scattered across the DB follow a character rename.

The format of ``identity_id`` is ``<character name>_<identity name>``, with the character name embedded, so when a character is renamed every
persisted identity_id becomes invalid at once -- identity images cannot be found, the sketch color assignment no longer lines up, and the identities
detected from storyboard markers are not in the identity table.

The references are scattered more widely than expected. The list below was produced by going through every column of the CREATE TABLE SQL -- the last round
patched only the columns named in the review, and as a result ``prop_menu_json`` was missed entirely and bounced back once more. Before changing this area,
go back and check ``SQLITE_SCHEMA_SQL``; do not patch from intuition again.

**The parenthesis after each entry is the source of that semantic; please carry it along when adding a new column.** ``_cascade_character_rename``
explicitly treats this list as authoritative, so a semantic written down without checking becomes a premise others trust in the next round:
``beats.speaker`` was once assumed to be a "character name", so the cascade was written as ``== old_name``, and the actual value
``Lin/Xiaoman_casual`` could not be migrated at all -- the wrong thing was this comment, not that implementation.

- ``episodes.character_names`` -- array of character names (``Episode.character_names`` "names of appearing characters")
- ``episodes.identity_ids`` -- array of identity_ids (``Episode.identity_ids``,
  e.g. ``['Su Qingyan_daily']``)
- ``episodes.identity_default_map_json`` -- ``{character name: identity_id}``, with the name embedded in both key and value
  (e.g. ``{"Du Chen": "Du Chen_middle_aged"}``; ``literal_script_writing`` takes the key by character name)
- ``episodes.sketch_colors_json`` -- ``{identity_id: color}``, with the name embedded only in the key
  (e.g. ``{"Su Qingyan_daily": "red"}``)
- ``episodes.prop_menu_json`` -- the ``owner_identity_id`` of each item in the array
  (``PropMenuItem.owner_identity_id`` "ID of the owning character identity")
- ``beats.detected_identities_json`` -- array of identity_ids
  (``models.real_detected_identities`` "concrete identity IDs")
- ``beats.visual_description`` -- ``{{character name_identity name}}`` text markers. Inside the braces is usually an
  identity_id (``models.extract_char_identities_from_markers`` counts only markers that fall in the
  ``identity.identity_id`` set as detected identities), but a bare ``{{character name}}`` also really
  exists (``freezone.slots`` matches both), so the regex of ``remap_identity_markers`` makes the
  ``_identity name`` suffix optional
- ``beats.speaker`` -- **identity_id**, only when ``speaker_kind`` is ``character``.
  ``BeatUpdate.speaker`` is documented as "speaker identity ID", and ``resolve_dialogue_reference_audio``
  and ``indextts2_beat_audio_task`` both do ``speaker.startswith(character name)`` and then
  match ``identity.identity_id == speaker`` exactly. Bare character names, and plain labels for crowd/passersby, are
  legacy compatibility (``Beat.speaker`` "main characters may use identity_id, crowd/passersby may use plain labels"),
  and ``remap_identity_id`` handles both, so go through it instead of comparing with ``== old_name``
- ``props.owner`` -- a character name **or** an identity_id; both exist: the field is declared as "owning character name",
  while ``prop_promotion_service`` copies ``owner_identity_id``
  verbatim when promoting a menu item to a global prop
- ``seedance2_voice_audio_records.speaker`` -- **identity_id**, the same contract as ``beats.speaker``
  (``voice_audio_task`` passes the beat's speaker all the way down and writes it into this table),
  and also part of the primary key

Explicitly **not** in the list: ``episodes.scene_menu_json`` (scene IDs only),
``beats.detected_props_json`` (prop IDs only), and the cross-project shared global prop table of ``director_world``
(renaming in one project must not rewrite the shared library).

Only pure functions live here: given an old JSON (or text), return the rewritten new value, and **return ``None`` if nothing changed**.
Callers take ``None`` as the signal "this row need not be written", so rows that never referenced this character do not get
a needless ``updated_at`` bump.
"""

from __future__ import annotations

import json
import re
from typing import Any


def remap_identity_id(identity_id: Any, old_name: str, new_name: str) -> str:
    """``<old character name>_<identity name>`` → ``<new character name>_<identity name>``; anything else is returned unchanged.

    The prefix comparison must include the separating underscore: renaming ``Lin Xiaoman`` must not also rewrite ``Lin Xiaoman Yue_casual``.
    Sentinel values such as ``__NO_CHARACTER__`` carry no character-name prefix and so naturally pass through here untouched.
    """

    value = str(identity_id or "")
    if value == old_name:
        return new_name
    prefix = f"{old_name}_"
    if value.startswith(prefix):
        return f"{new_name}_{value[len(prefix) :]}"
    return value


def remap_object_field(
    raw_json: str | None, field: str, old_name: str, new_name: str
) -> str | None:
    """Remap a field of every object in ``[{...}, ...]`` (``prop_menu_json.owner_identity_id``).

    Only the named field is touched; ``prop_id`` / ``visual_prompt`` in the same object are kept as they are -- nothing in a prop menu item
    other than the owner embeds a character name.
    """

    try:
        items = json.loads(raw_json or "[]")
    except (TypeError, ValueError):
        return None
    if not isinstance(items, list):
        return None
    remapped: list[Any] = []
    for item in items:
        if not isinstance(item, dict) or field not in item:
            remapped.append(item)
            continue
        updated = dict(item)
        updated[field] = remap_identity_id(item[field], old_name, new_name)
        remapped.append(updated)
    if remapped == items:
        return None
    return json.dumps(remapped, ensure_ascii=False)


def remap_id_list(raw_json: str | None, old_name: str, new_name: str) -> str | None:
    """Remap a JSON array ``[identity_id, ...]`` or ``[character name, ...]``."""

    try:
        values = json.loads(raw_json or "[]")
    except (TypeError, ValueError):
        return None
    if not isinstance(values, list):
        return None
    remapped = [remap_identity_id(item, old_name, new_name) for item in values]
    if remapped == values:
        return None
    return json.dumps(remapped, ensure_ascii=False)


def remap_default_map(raw_json: str | None, old_name: str, new_name: str) -> str | None:
    """``{character name: identity_id}`` -- the character name is embedded in both key and value, so both sides must change."""

    try:
        mapping = json.loads(raw_json or "{}")
    except (TypeError, ValueError):
        return None
    if not isinstance(mapping, dict):
        return None
    remapped = {
        (new_name if str(key) == old_name else str(key)): remap_identity_id(
            value, old_name, new_name
        )
        for key, value in mapping.items()
    }
    if remapped == mapping:
        return None
    return json.dumps(remapped, ensure_ascii=False)


def remap_keyed_by_identity(
    raw_json: str | None, old_name: str, new_name: str
) -> str | None:
    """``{identity_id: any value}`` -- the character name is embedded only in the key (``sketch_colors_json``)."""

    try:
        mapping = json.loads(raw_json or "{}")
    except (TypeError, ValueError):
        return None
    if not isinstance(mapping, dict):
        return None
    remapped = {
        remap_identity_id(key, old_name, new_name): value
        for key, value in mapping.items()
    }
    if remapped == mapping:
        return None
    return json.dumps(remapped, ensure_ascii=False)


def remap_identity_markers(text: str | None, old_name: str, new_name: str) -> str | None:
    """Rewrite the ``{{character name_identity name}}`` markers in ``visual_description``.

    Markers are the anchors of the storyboard and coloring chain (see ``models.extract_char_identities_from_markers``):
    if the text still carries the old character name, the detected identity no longer matches the identity table and the whole color assignment chain breaks.
    """

    value = str(text or "")
    if not value:
        return None
    pattern = re.compile(r"\{\{" + re.escape(old_name) + r"(_[^}]*)?\}\}")

    def _sub(match: re.Match[str]) -> str:
        return "{{" + new_name + (match.group(1) or "") + "}}"

    remapped = pattern.sub(_sub, value)
    return remapped if remapped != value else None
