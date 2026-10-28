"""NovelVideo data models.

Extends the SuperScript graph models with video-generation-specific nodes.
"""

import json
import re
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from novelvideo.time_of_day import is_time_of_day_token, time_of_day_name_candidates
from novelvideo.utils.asset_names import coerce_path_safe_asset_name, path_safe_asset_name
from novelvideo.utils.derived_scenes import compose_derived_scene_name


NO_CHARACTER_MARKER = "__NO_CHARACTER__"
NO_PROP_MARKER = "__NO_PROP__"


def _dedupe_non_empty(values: list[Any] | tuple[Any, ...] | None) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values or []:
        item = str(value or "").strip()
        if not item or item in seen:
            continue
        seen.add(item)
        result.append(item)
    return result


def normalize_detected_identities(values: list[Any] | tuple[Any, ...] | None) -> list[str]:
    """Normalize detected identity IDs, preserving the explicit no-character marker."""
    result = _dedupe_non_empty(values)
    real_ids = [item for item in result if item != NO_CHARACTER_MARKER]
    return real_ids or ([NO_CHARACTER_MARKER] if NO_CHARACTER_MARKER in result else [])


def normalize_detected_props(values: list[Any] | tuple[Any, ...] | None) -> list[str]:
    """Normalize detected prop IDs, preserving the explicit no-prop marker."""
    result = _dedupe_non_empty(values)
    real_ids = [item for item in result if item != NO_PROP_MARKER]
    return real_ids or ([NO_PROP_MARKER] if NO_PROP_MARKER in result else [])


def real_detected_identities(values: list[Any] | tuple[Any, ...] | None) -> list[str]:
    """Return only concrete identity IDs from a detected_identities payload."""
    return [item for item in normalize_detected_identities(values) if item != NO_CHARACTER_MARKER]


def real_detected_props(values: list[Any] | tuple[Any, ...] | None) -> list[str]:
    """Return only concrete prop IDs from a detected_props payload."""
    return [item for item in normalize_detected_props(values) if item != NO_PROP_MARKER]


def _extract_identity_marker_ids(visual_description: str) -> list[str]:
    return list(extract_char_identities_from_markers(visual_description, strict=False).values())


def complete_detected_refs_from_visual_description(
    *,
    visual_description: str,
    detected_identities: list[Any] | tuple[Any, ...] | None = None,
    detected_props: list[Any] | tuple[Any, ...] | None = None,
    allowed_identity_ids: set[str] | list[str] | tuple[str, ...] | None = None,
    allowed_prop_ids: set[str] | list[str] | tuple[str, ...] | None = None,
) -> tuple[list[str], list[str]]:
    identity_ids = {str(item or "").strip() for item in (allowed_identity_ids or [])}
    prop_ids = {str(item or "").strip() for item in (allowed_prop_ids or [])}

    completed_identities = real_detected_identities(detected_identities)
    for identity_id in _extract_identity_marker_ids(visual_description):
        if identity_ids and identity_id not in identity_ids:
            continue
        if identity_id and identity_id not in completed_identities:
            completed_identities.append(identity_id)

    completed_props = real_detected_props(detected_props)
    for prop_id in extract_prop_ids_from_markers(visual_description, strict=False):
        if prop_ids and prop_id not in prop_ids:
            continue
        if prop_id and prop_id not in completed_props:
            completed_props.append(prop_id)

    return (
        normalize_detected_identities(completed_identities or [NO_CHARACTER_MARKER]),
        normalize_detected_props(completed_props or [NO_PROP_MARKER]),
    )


def extract_char_identities_from_markers(
    visual_desc: str, *, strict: bool = True
) -> dict[str, str]:
    """Extract {character name: identity_id} from the {{}} markers of visual_description.

    Args:
        strict: when True, raise ValueError for a marker without an identity suffix
    """
    result = {}
    for marker in re.findall(r"\{\{([^}]+)\}\}", visual_desc):
        if "_" in marker:
            char_name = marker.split("_", 1)[0]
            result[char_name] = marker
        elif strict:
            raise ValueError(
                f"marker '{{{{{marker}}}}}' is missing an identity suffix, " f"expected the format '{{{{{marker}_identityName}}}}'"
            )
    return result


def extract_prop_ids_from_markers(visual_desc: str, *, strict: bool = False) -> list[str]:
    """Extract the list of prop_ids from the [[prop_id]] markers of visual_description."""
    result: list[str] = []
    seen: set[str] = set()
    for marker in re.findall(r"\[\[([^\]]+)\]\]", visual_desc):
        prop_id = str(marker or "").strip()
        if not prop_id:
            if strict:
                raise ValueError("marker '[[ ]]' must not be empty")
            continue
        if prop_id in seen:
            continue
        seen.add(prop_id)
        result.append(prop_id)
    return result


class SceneRef(BaseModel):
    """Scene asset referenced inside a Beat."""

    scene_id: str = Field(default="", description="Scene ID")
    variant_id: str = Field(default="", description="Scene look/state selector; empty means the base scene")
    render_anchor_id: str = Field(
        default="",
        description="Background slot the Beat actually renders with; empty means the default scene image, selected_background means the beat's frozen background",
    )
    render_anchor_source_id: str = Field(
        default="",
        description="Records the screenshot source when render_anchor_id=selected_background, e.g. master/reverse/director_env_only",
    )


class SceneMenuItem(BaseModel):
    """Episode-level scene menu item."""

    scene_id: str = Field(default="", description="Scene menu item ID; a derived scene may use the full derived scene name")
    base_scene_id: str = Field(default="", description="ID of the base scene a derived scene belongs to; empty for base scenes")
    variant_id: str = Field(default="", description="Look/state label of a derived scene; empty for base scenes")
    time_of_day: str = Field(default="", description="Time-of-day label of a derived scene; empty for base scenes or non-time variants")


class PropMenuItem(BaseModel):
    """Episode-level prop menu item."""

    prop_id: str = Field(default="", description="Base prop ID")
    prop_type: str = Field(default="object", description="Prop type")
    visual_prompt: str = Field(default="", description="Visual prompt of the prop in this episode")
    description: str = Field(default="", description="Narrative description of the prop in this episode")
    owner_identity_id: str = Field(default="", description="ID of the owning character identity; may be empty")
    marker_color: str = Field(default="", description="Identity marker color of the prop in the sketch stage")


def _coerce_scene_ref(value: Any) -> SceneRef | None:
    if isinstance(value, SceneRef):
        return value if value.scene_id else None
    if isinstance(value, dict):
        scene_id = str(value.get("scene_id", "") or value.get("base_id", "")).strip()
        variant_id = str(value.get("variant_id", "") or "").strip()
        render_anchor_id = str(
            value.get("render_anchor_id", "")
            or value.get("anchor_id", "")
            or value.get("background_ref_id", "")
            or value.get("shot_id", "")
            or ""
        ).strip()
        render_anchor_source_id = str(
            value.get("render_anchor_source_id", "")
            or value.get("anchor_source_id", "")
            or value.get("background_ref_source_id", "")
            or ""
        ).strip()
        return (
            SceneRef(
                scene_id=scene_id,
                variant_id=variant_id,
                render_anchor_id=render_anchor_id,
                render_anchor_source_id=render_anchor_source_id,
            )
            if scene_id
            else None
        )
    return None


def build_scene_ref(
    scene_id: str = "",
    variant_id: str = "",
) -> SceneRef | None:
    scene_id = (scene_id or "").strip()
    variant_id = (variant_id or "").strip()
    return SceneRef(scene_id=scene_id, variant_id=variant_id) if scene_id else None


def parse_scene_ref_json(raw: str | None) -> SceneRef | None:
    """Decode a persisted ``scene_ref_json`` column. Empty/corrupt → ``None``."""
    if not raw:
        return None
    try:
        return _coerce_scene_ref(json.loads(raw))
    except (TypeError, ValueError, json.JSONDecodeError):
        return None


@dataclass(frozen=True, slots=True)
class BeatAssetRefRow:
    """One beat reduced to the columns the asset-reference scan actually reads.

    That scan walks every beat in the project to answer "which beats use this
    asset". Materialising a full :class:`NovelVisualBeat` per row to read six
    fields is the expensive half: ~20 columns off ``SELECT *`` plus a pydantic
    validator that re-serialises ``scene_ref_json`` and back-fills narration and
    visual_description defaults — work whose only output is discarded.

    Attribute names match :class:`NovelVisualBeat` (including the ``scene_ref``
    property), so ``beat_scene_id`` and the scan's field readers treat both
    shapes identically.
    """

    episode_number: int
    beat_number: int
    visual_description: str
    detected_identities_json: str
    detected_props_json: str
    scene_ref_json: str

    @property
    def scene_ref(self) -> SceneRef | None:
        return parse_scene_ref_json(self.scene_ref_json)

    @property
    def scene_id(self) -> str:
        scene_ref = self.scene_ref
        return scene_ref.scene_id if scene_ref else ""


def beat_scene_ref(value: Any) -> SceneRef | None:
    if isinstance(value, dict):
        scene_ref = _coerce_scene_ref(value.get("scene_ref"))
        if scene_ref:
            return scene_ref
        return build_scene_ref(
            str(value.get("scene_id", "") or ""),
            str(value.get("scene_variant_id", "") or ""),
        )
    scene_ref = _coerce_scene_ref(getattr(value, "scene_ref", None))
    if scene_ref:
        return scene_ref
    return build_scene_ref(
        str(getattr(value, "scene_id", "") or ""),
        str(getattr(value, "scene_variant_id", "") or ""),
    )


def beat_scene_id(value: Any) -> str:
    scene_ref = beat_scene_ref(value)
    return scene_ref.scene_id if scene_ref else ""


def beat_scene_variant_id(value: Any) -> str:
    scene_ref = beat_scene_ref(value)
    return scene_ref.variant_id if scene_ref else ""


def resolve_scene_record_name(
    scene_id: str,
    variant_id: str | None = "",
    known_names: list[str] | set[str] | tuple[str, ...] | None = None,
) -> str:
    """Resolve a canonical scene ref to the concrete scene record name.

    Writes should use canonical {base scene_id, variant_id}; reads stay lenient:
    when variant_id is empty, scene_id is already the concrete record name.
    """

    base = str(scene_id or "").strip()
    variant = str(variant_id or "").strip()
    if not base:
        return ""
    if not variant:
        return base
    derived = compose_derived_scene_name(base, variant)
    names = {str(name or "").strip() for name in known_names or []}
    if not names or derived in names:
        return derived
    return base


def _time_of_day_name_candidates(time_of_day: str) -> list[str]:
    return time_of_day_name_candidates(time_of_day)


def _is_time_of_day_token(value: str) -> bool:
    return is_time_of_day_token(value)


def _split_scene_ref_time_suffix(
    scene_id: str,
    variant_id: str,
    *,
    split_base_time_suffix: bool = False,
) -> tuple[str, str, str]:
    base = str(scene_id or "").strip()
    variant = str(variant_id or "").strip()

    if variant:
        if _is_time_of_day_token(variant):
            return base, "", variant
        if "_" in variant:
            variant_head, variant_tail = variant.rsplit("_", 1)
            if variant_head and _is_time_of_day_token(variant_tail):
                return base, variant_head, variant_tail
        return base, variant, ""

    if split_base_time_suffix and "_" in base:
        base_head, base_tail = base.rsplit("_", 1)
        if base_head and _is_time_of_day_token(base_tail):
            return base_head, "", base_tail
    return base, variant, ""


def resolve_scene_plate(
    scene_id: str,
    variant_id: str | None = "",
    time_of_day: str | None = "",
    known_names: list[str] | set[str] | tuple[str, ...] | None = None,
) -> tuple[str, bool]:
    """Resolve scene ref + time into a concrete plate name.

    The returned bool is True only when an existing time-of-day plate was found.
    Unknown names never imply that a time plate exists; they fall back to the
    existing scene/variant resolution with ``time_baked=False``.
    """

    base, variant, _legacy_ref_time = _split_scene_ref_time_suffix(
        str(scene_id or "").strip(),
        str(variant_id or "").strip(),
        split_base_time_suffix=bool(str(time_of_day or "").strip()),
    )
    if not base:
        return "", False

    names = {str(name or "").strip() for name in known_names or [] if str(name or "").strip()}
    if not names:
        return resolve_scene_record_name(base, variant, known_names), False

    # Beat.time_of_day is the only target time.  Any time suffix found in
    # scene_id/variant_id is legacy compatibility data and is only stripped out
    # so it cannot force the wrong plate.
    target_time = str(time_of_day or "").strip()
    time_candidates = _time_of_day_name_candidates(target_time)
    if time_candidates:
        if variant:
            variant_name = compose_derived_scene_name(base, variant)
            for time_name in time_candidates:
                plate_name = compose_derived_scene_name(variant_name, time_name)
                if plate_name in names:
                    return plate_name, True
            if variant_name in names:
                return variant_name, False
            return base, False

        for time_name in time_candidates:
            plate_name = compose_derived_scene_name(base, time_name)
            if plate_name in names:
                return plate_name, True
        return base, False

    return resolve_scene_record_name(base, variant, known_names), False


def resolve_scene_plate_from_records(
    scene_id: str,
    variant_id: str | None = "",
    time_of_day: str | None = "",
    scene_records: list[Any] | tuple[Any, ...] | None = None,
) -> tuple[str, bool]:
    base, variant, _legacy_ref_time = _split_scene_ref_time_suffix(
        str(scene_id or "").strip(),
        str(variant_id or "").strip(),
        split_base_time_suffix=bool(str(time_of_day or "").strip()),
    )
    if not base:
        return "", False

    by_key: dict[tuple[str, str, str], str] = {}
    names: set[str] = set()
    for scene in scene_records or []:
        name = str(getattr(scene, "name", "") or "").strip()
        if not name:
            continue
        names.add(name)
        record_base = str(getattr(scene, "base_scene_id", "") or "").strip() or name
        record_variant = str(getattr(scene, "variant_id", "") or "").strip()
        record_time = str(getattr(scene, "time_of_day", "") or "").strip()
        by_key[(record_base, record_variant, record_time)] = name

    time_candidates = _time_of_day_name_candidates(str(time_of_day or ""))
    if time_candidates:
        for time_name in time_candidates:
            found = by_key.get((base, variant, time_name))
            if found:
                return found, True
        fallback_name, fallback_baked = resolve_scene_plate(base, variant, time_of_day, names)
        if fallback_name != base or fallback_baked:
            return fallback_name, fallback_baked
        found = by_key.get((base, variant, ""))
        if found:
            return found, False
        found = by_key.get((base, "", ""))
        if found:
            return found, False
        return fallback_name, fallback_baked

    fallback_name, fallback_baked = resolve_scene_plate(base, variant, "", names)
    if fallback_name != base or fallback_baked:
        return fallback_name, fallback_baked
    found = by_key.get((base, variant, ""))
    if found:
        return found, False
    found = by_key.get((base, "", ""))
    if found:
        return found, False
    return fallback_name, fallback_baked


def collect_prop_marker_ids_from_beat(value: Any) -> list[str]:
    """Collect the on-screen prop marker keys from a single beat.

    Prop anchors and identity anchors stay consistent: only the [[prop_id]] in visual_description is read.
    """
    if isinstance(value, dict):
        visual_desc = str(value.get("visual_description", "") or "")
    else:
        visual_desc = str(getattr(value, "visual_description", "") or "")
    return extract_prop_ids_from_markers(visual_desc, strict=False)


def split_detected_marker_keys(
    detected_keys: list[str],
    beats: list[Any],
    characters: list[Any],
    allowed_prop_ids: set[str] | list[str] | tuple[str, ...] | None = None,
) -> tuple[list[str], list[str]]:
    """Split AI/color detection results by the legal marker set of this episode.

    `[[prop]]` is a semantic anchor and does not necessarily have a color marker. Only props passed in
    `allowed_prop_ids` are classified as detected_props; callers should pass the set of
    global props that already have a marker color assigned.

    Returns:
        (detected_identities, prop_marker_ids)
    """
    identity_ids: set[str] = set()
    for char in characters or []:
        identities = (
            char.get("identities", [])
            if isinstance(char, dict)
            else getattr(char, "identities", [])
        ) or []
        for identity in identities:
            identity_id = str(
                identity.get("identity_id", "")
                if isinstance(identity, dict)
                else getattr(identity, "identity_id", "")
            ).strip()
            if identity_id:
                identity_ids.add(identity_id)

    semantic_prop_ids = {
        prop_id
        for beat in beats or []
        for prop_id in collect_prop_marker_ids_from_beat(beat)
        if prop_id
    }
    allowed_props = {
        str(prop_id or "").strip()
        for prop_id in (allowed_prop_ids or [])
        if str(prop_id or "").strip()
    }
    prop_ids = semantic_prop_ids & allowed_props if allowed_props else set()

    detected_identities: list[str] = []
    prop_marker_ids: list[str] = []
    for key in detected_keys or []:
        marker = str(key or "").strip()
        if not marker:
            continue
        if marker in identity_ids:
            detected_identities.append(marker)
        elif marker in prop_ids:
            prop_marker_ids.append(marker)

    return (
        list(dict.fromkeys(detected_identities)),
        list(dict.fromkeys(prop_marker_ids)),
    )


def build_scene_menu(
    scene_ids: list[str] | None = None,
    scene_menu: list[Any] | None = None,
) -> list[SceneMenuItem]:
    normalized: list[SceneMenuItem] = []
    seen: set[str] = set()
    for item in scene_menu or []:
        if isinstance(item, SceneMenuItem):
            scene_id = item.scene_id.strip()
            base_scene_id = item.base_scene_id.strip()
            variant_id = item.variant_id.strip()
            time_of_day = item.time_of_day.strip()
        elif isinstance(item, dict):
            scene_id = str(item.get("scene_id", "") or item.get("base_id", "")).strip()
            base_scene_id = str(item.get("base_scene_id", "") or "").strip()
            variant_id = str(item.get("variant_id", "") or "").strip()
            time_of_day = str(item.get("time_of_day", "") or "").strip()
        else:
            continue
        if not scene_id or scene_id in seen:
            continue
        seen.add(scene_id)
        normalized.append(
            SceneMenuItem(
                scene_id=scene_id,
                base_scene_id=base_scene_id,
                variant_id=variant_id,
                time_of_day=time_of_day,
            )
        )
    if normalized:
        return normalized
    for scene_id in scene_ids or []:
        scene_id = str(scene_id or "").strip()
        if not scene_id or scene_id in seen:
            continue
        seen.add(scene_id)
        normalized.append(SceneMenuItem(scene_id=scene_id))
    return normalized


def build_prop_menu(
    prop_ids: list[str] | None = None,
    prop_menu: list[Any] | None = None,
) -> list[PropMenuItem]:
    def _coerce_prop_menu_item(item: Any) -> PropMenuItem | None:
        if isinstance(item, PropMenuItem):
            prop_id = item.prop_id.strip()
            if not prop_id:
                return None
            return PropMenuItem(
                prop_id=prop_id,
                prop_type=(item.prop_type or "object").strip() or "object",
                visual_prompt=item.visual_prompt.strip(),
                description=item.description.strip(),
                owner_identity_id=item.owner_identity_id.strip(),
                marker_color=item.marker_color.strip(),
            )
        if isinstance(item, dict):
            prop_id = str(item.get("prop_id", "") or item.get("base_id", "")).strip()
            if not prop_id:
                return None
            return PropMenuItem(
                prop_id=prop_id,
                prop_type=str(item.get("prop_type", "") or "object").strip() or "object",
                visual_prompt=str(
                    item.get("visual_prompt", "") or item.get("description", "") or ""
                ).strip(),
                description=str(item.get("description", "") or "").strip(),
                owner_identity_id=str(item.get("owner_identity_id", "") or "").strip(),
                marker_color=str(item.get("marker_color") or "").strip(),
            )
        return None

    normalized: list[PropMenuItem] = []
    seen: set[str] = set()
    for item in prop_menu or []:
        menu_item = _coerce_prop_menu_item(item)
        if not menu_item:
            continue
        prop_id = menu_item.prop_id
        if not prop_id or prop_id in seen:
            continue
        seen.add(prop_id)
        normalized.append(menu_item)
    if normalized:
        return normalized
    for prop_id in prop_ids or []:
        prop_id = str(prop_id or "").strip()
        if not prop_id or prop_id in seen:
            continue
        seen.add(prop_id)
        normalized.append(PropMenuItem(prop_id=prop_id))
    return normalized


def sync_beat_asset_refs(beat: dict[str, Any]) -> dict[str, Any]:
    """Normalize the scene reference fields in a beat.

    Canonical structure:
    - scene_ref.scene_id: scene ID
    - scene_ref.render_anchor_id: background slot the Beat actually renders with; empty or selected_background
    - scene_ref.render_anchor_source_id: source of selected_background, used only for UI display/tracking
    """

    scene_ref = _coerce_scene_ref(beat.get("scene_ref"))
    if not scene_ref:
        scene_ref = build_scene_ref(str(beat.get("scene_id", "") or ""))
    beat["scene_ref"] = scene_ref.model_dump() if scene_ref else None
    beat.pop("scene_id", None)

    return beat


# =============================================================================
# Style configuration model
# =============================================================================


class StyleConfig(BaseModel):
    """Style configuration model - One Source of Truth for style settings.

    Supports system presets (loaded from JSON files) and custom styles (loaded from Redis).

    Field notes:
    - style_instructions / avoid_instructions: project style instructions shared by all image models
    - style_tag: short tag injected into every panel in Render mode
    """

    id: str = Field(description="Unique style identifier, e.g. 'realistic_period_drama'")
    name: str = Field(description="Display name, e.g. 'Realistic Period Drama'")
    base: Optional[str] = Field(
        default=None,
        description="Which preset style this inherits from (optional, for custom style inheritance)",
    )

    style_instructions: str = Field(
        default="",
        description="General style instructions, e.g. 'Create a cinematic scene...'",
    )
    avoid_instructions: str = Field(
        default="",
        description="General avoid instructions, e.g. 'Do not create anime style...'",
    )
    style_tag: str = Field(
        default="",
        description="Per-panel short tag, e.g. 'PHOTOREALISTIC LIVE-ACTION', injected into every Panel in Render mode",
    )

    # Common fields
    label: str = Field(
        default="",
        description="UI display label, e.g. 'Realistic Period Drama'",
    )
    style_family: str = Field(
        default="live_action",
        description="Style category: live_action | animation",
    )
    animation_subtype: str = Field(
        default="",
        description="Animation subtype: 2d | 3d | hybrid; empty for live-action styles",
    )

    # Metadata
    is_preset: bool = Field(
        default=False,
        description="Whether this is a system preset (True = cannot be deleted, False = custom style)",
    )
    created_at: Optional[datetime] = Field(default=None, description="Creation time (custom styles only)")
    created_by: Optional[str] = Field(default=None, description="Creator (custom styles only)")
    preview_path: Optional[str] = Field(
        default=None,
        description="Path of the custom style reference image relative to the project directory; empty for preset styles",
    )

    def to_legacy_dict(self) -> dict:
        """Return the runtime style dict used by all generation paths."""
        result = {
            "style_instructions": self.style_instructions,
            "avoid_instructions": self.avoid_instructions,
            "style_family": self.style_family,
            "animation_subtype": self.animation_subtype,
            "label": self.label or self.name,
        }
        if self.style_tag:
            result["style_tag"] = self.style_tag
        return result

    @classmethod
    def from_legacy_dict(cls, style_id: str, data: dict, name: str = "") -> "StyleConfig":
        """Create a StyleConfig from the legacy STYLE_PRESETS format.

        Args:
            style_id: style ID
            data: legacy config dict
            name: display name

        Returns:
            StyleConfig instance
        """
        return cls(
            id=style_id,
            name=name or style_id,
            style_instructions=data.get("style_instructions", ""),
            avoid_instructions=data.get("avoid_instructions", ""),
            style_tag=data.get("style_tag", ""),
            label=data.get("label", name or style_id),
            style_family=data.get("style_family", "live_action"),
            animation_subtype=data.get("animation_subtype", ""),
            is_preset=True,
        )


# =============================================================================
# Node type enum
# =============================================================================


class NodeType(str, Enum):
    """NovelVideo node types."""

    # Core entities
    CHARACTER = "character"
    LOCATION = "location"
    PROP = "prop"
    EVENT = "event"

    # Novel structure
    CHAPTER = "chapter"
    EPISODE = "episode"

    # Video generation specific
    CHARACTER_ASSET = "character_asset"

    # Constraints
    WORLD_RULE = "world_rule"
    GENRE_STYLE = "genre_style"


class RelationType(str, Enum):
    """Relationship types."""

    # Character relationships
    FAMILY_OF = "FAMILY_OF"
    LOVER_OF = "LOVER_OF"
    FRIEND_OF = "FRIEND_OF"
    ENEMY_OF = "ENEMY_OF"
    MENTOR_OF = "MENTOR_OF"
    SUBORDINATE_OF = "SUBORDINATE_OF"

    # Event relationships
    PARTICIPATES_IN = "PARTICIPATES_IN"
    CAUSES = "CAUSES"
    HAPPENS_AT = "HAPPENS_AT"

    # Structural relationships
    BELONGS_TO_CHAPTER = "BELONGS_TO_CHAPTER"
    BELONGS_TO_EPISODE = "BELONGS_TO_EPISODE"

    # Asset relationships
    HAS_ASSET = "HAS_ASSET"
    REFERENCED_IN = "REFERENCED_IN"


# =============================================================================
# Episode related
# =============================================================================


class EpisodeNode(BaseModel):
    """Video episode node."""

    number: int = Field(description="Episode number")
    title: str = Field(default="", description="Title")

    # Content range
    chapter_start: int = Field(default=1, description="Starting chapter")
    chapter_end: int = Field(default=1, description="Ending chapter")

    # Core content
    summary: str = Field(default="", description="Content summary")
    key_events: list[str] = Field(default_factory=list, description="Key events")
    characters: list[str] = Field(default_factory=list, description="Appearing characters")

    # Cliffhanger
    cliffhanger: str = Field(default="", description="Ending cliffhanger")

    # Generation status
    script_generated: bool = Field(default=False)
    images_generated: bool = Field(default=False)
    audio_generated: bool = Field(default=False)
    video_generated: bool = Field(default=False)


class NarrationScript(BaseModel):
    """Narration script - flat structure.

    beats are the core unit (a flat list); shots are a lightweight grouping (storyboard grids, used for video generation planning).
    """

    episode_number: int
    title: str = ""

    # Core: flat beats list
    beats: list["VisualBeat"] = Field(default_factory=list, description="List of visual beats")

    # Metadata
    total_duration_seconds: float = Field(default=120.0, description="Estimated total duration (seconds)")
    created_at: datetime = Field(default_factory=datetime.now)

    def get_total_duration(self) -> float:
        """Get the total duration of all beats."""
        return sum(b.estimated_duration for b in self.beats)


class VisualBeat(BaseModel):
    """Visual beat - one segment of narration and its matching picture.

    Each VisualBeat represents one line of narration plus its matching picture description,
    keeping picture and narration precisely in sync.

    Duration constraints (novel narration style):
    - The word count of each beat is determined by the rhythm preset (corresponding to 4-6 seconds of TTS)
    - The Jimeng API always generates 5-second videos, which are trimmed/concatenated to the actual TTS duration
    - Style requirement: tell the story in a flowing manner, and do not use interjections
    """

    beat_number: int = Field(description="Beat number (starting from 1)")
    narration_segment: str = Field(description="This segment of narration")
    visual_description: str = Field(description="Matching picture description (creative intent description)")
    source_text_sha256: str = Field(default="", description="SHA256 of the text actually fed in when this shot was generated")

    time_of_day: str = Field(
        default="",
        description="Time of day (dawn/morning/noon/afternoon/day/dusk/night); an independent time condition, not appended to the scene name",
    )
    scene_ref: Optional[SceneRef] = Field(
        default=None,
        description="Normalized scene reference; the new flow mainly uses scene_id",
    )
    # Dialogue support
    audio_type: str = Field(
        default="narration",
        description="silence = picture beat with no spoken audio / narration = voice-over narration / dialogue = character line",
    )
    speaker: str = Field(
        default="", description="Speaker label (main characters may use identity_id; crowd/passersby may use a plain label)"
    )
    speaker_kind: str = Field(
        default="character",
        description="speaker type: character = physical or ordinary character, non_character = non-character sound source such as broadcast/voice-over/subtitle/on-screen text",
    )

    # Duration info (estimated from word count at generation time, not persisted to the DB)
    estimated_duration: float = Field(default=0.0, description="Estimated duration (seconds), computed from word count")

    # Manual shot insertion support
    shot_order: Optional[int] = Field(
        default=None, description="Display/narrative order (fractional ordering)"
    )
    duration_seconds: Optional[float] = Field(default=None, description="User-specified target duration (seconds)")
    is_manual_shot: bool = Field(default=False, description="Whether this is a shot manually inserted by the user")

    # ==========================================================================
    # Asset generation status (added in Phase 5)
    # ==========================================================================

    # First-frame selected image ID
    frame_pool_id: Optional[str] = Field(
        default=None,
        description="Selected pool image ID, format: {mode}_{grid_idx:02d}_{cell_idx:02d}, e.g. '3x3_01_05'",
    )

    # Video version history
    video_versions: list[str] = Field(default_factory=list, description="List of historical version paths")

    # Video pool entry ID
    video_pool_id: Optional[str] = Field(default=None, description="Selected video pool entry ID")

    # Video generation mode (aligned with the persistence layer NovelVisualBeat / DB beats.video_mode)
    video_mode: str = Field(
        default="first_frame",
        description=(
            "Video generation mode: "
            "first_frame = plain I2V (first frame only)"
            " | keyframe = first/last frame transition"
            " (text_to_video / extend / loop etc. may be added in the future)"
        ),
    )

    # Video prompt (used in First Frame mode)
    video_prompt: Optional[str] = Field(
        default=None,
        description="Video motion prompt (describes the action and motion in the video)",
    )

    # First/last frame transition prompt (used in Keyframe mode)
    keyframe_prompt: Optional[str] = Field(
        default=None,
        description="First/last frame transition prompt (describes the change between the first and last frames)",
    )
    # Note: the last-frame path need not be stored; the next beat's frame_path is fetched dynamically

    # ==========================================================================
    # Action Beat specific fields (2.0 short-drama mode)
    # ==========================================================================

    action_description: str = Field(
        default="",
        description="Original action description (action beats only, for UI display and sketch regeneration)",
    )
    # action grid/panel paths and selection state are all computed by PathResolver by convention, not stored

    @model_validator(mode="after")
    def sync_asset_refs(self) -> "VisualBeat":
        self.scene_ref = _coerce_scene_ref(self.scene_ref)
        return self

    @property
    def scene_id(self) -> str:
        return self.scene_ref.scene_id if self.scene_ref else ""

    @scene_id.setter
    def scene_id(self, value: str):
        self.scene_ref = build_scene_ref(value)


def format_beat_narration(audio_type: str, speaker: str, narration: str) -> str:
    """Uniformly format the narration display text of a beat.

    dialogue beat → [Dialogue: {speaker}] {narration}
    narration beat → {narration}
    silence/action beat → ""
    """
    if audio_type in {"silence", "action"}:
        return ""
    if audio_type == "dialogue" and narration:
        if speaker:
            return f"[Dialogue: {speaker}] {narration}"
        return f"[Dialogue] {narration}"
    return narration


# =============================================================================
# Cognee business entities (moved out of cognee/pipeline.py)
# =============================================================================


class CharacterIdentity(BaseModel):
    """Character identity - represents one specific form of a character.

    Core idea: the identity is the essence. One character can have several identities,
    each with its own appearance, outfit, prompt and reference images.

    For example:
    - Xie Zheng's "monk" identity: shaved head, monk's robe, prayer beads
    - Xie Zheng's "emperor" identity: dragon robe, tall crown, imperial bearing
    """

    identity_id: str = Field(..., description="Unique identity ID, e.g. Xie Zheng_emperor, Xie Zheng_monk")
    character_name: str = Field(..., description="Associated main character name")
    identity_name: str = Field(..., description="Identity name, e.g. 'emperor', 'monk'")

    # Unique short character tag (used for Nano Banana Pro Identity Locking)
    character_tag: str = Field(
        default="",
        description="Unique short character tag, e.g. '[JiangSN]', '[XieZ]', used for identity locking in prompts",
    )

    # Outfit description (specific to this identity)
    appearance_details: str = Field(
        default="",
        description="Outfit, accessories and hairstyle of this identity (no actions or expressions)",
    )

    # Reference images (specific to this identity)
    reference_images: List[str] = Field(
        default_factory=list,
        description="List of reference image paths for this identity",
    )

    # Facial features (identities such as age variants that need a different face)
    face_prompt: str = Field(
        default="",
        description="Identity-level facial features (for identities whose faces differ a lot, such as childhood/old age), falling back to the character-level face_prompt",
    )

    # Age group (filled only for age-variant identities, used to map voice presets automatically)
    age_group: str = Field(
        default="",
        description="Age group of this identity: child/youth/middle/elder (filled only for age variants)",
    )

    # Body type (identities such as age variants that need a different body type)
    body_type: str = Field(
        default="",
        description="Identity-level body type description (for identities whose build differs a lot, such as childhood/old age), falling back to the character-level body_type",
    )

    # Voice (manually specified by the user, highest priority)
    fish_voice_id: str = Field(
        default="",
        description="DEPRECATED — Fish Audio voice ID. IndexTTS2 cutover uses reference_audio_path instead; field retained until magnetic data migration completes.",
    )
    reference_audio_path: str = Field(
        default="",
        description="Identity-level IndexTTS2 reference audio path (project-relative), takes priority over the character-level reference_audio_path",
    )
    reference_audio_updated_at: str = Field(
        default="",
        description="ISO string of the last content change of the identity-level voice",
    )
    reference_audio_sha256: str = Field(
        default="",
        description="SHA256 of the identity-level reference audio content, used for IndexTTS2 voice provenance checks",
    )

    # Identity-level portrait (uploaded by the user or AI-generated)
    portrait_image: str = Field(
        default="",
        description="Identity-level face reference image path (used when face_prompt is non-empty)",
    )

    # Outfit reference image (uploaded by the user, used to anchor the outfit when generating four views)
    costume_image: str = Field(
        default="",
        description="Outfit reference image path (uploaded by the user, used to anchor the outfit when generating four views)",
    )

    # Source
    source: str = Field(
        default="extracted",
        description="Source: 'extracted' (extracted from the novel) or 'user_created' (created manually)",
    )
    updated_at: str = Field(default="", description="ISO string of the last content change of the identity asset")

    @model_validator(mode="after")
    def sanitize_names(self):
        """Remove filesystem-unsafe characters from an identity name."""
        self.identity_name = re.sub(r'[/\\:*?"<>|]', "_", self.identity_name)
        self.identity_id = re.sub(r'[/\\:*?"<>|]', "_", self.identity_id)
        return self

    @field_validator("age_group", mode="before")
    @classmethod
    def normalize_age_group(cls, value):
        """Tolerate legacy null and normalize to a string."""
        if value is None:
            return ""
        return str(value)

    def __setattr__(self, name, value):
        if name == "age_group" and value is None:
            value = ""
        super().__setattr__(name, value)


class NovelCharacter(BaseModel):
    """Novel character entity.

    Two-layer reference architecture (Portrait + Identity):
    - Layer 1 Portrait (required): a pure face close-up on a neutral background, used to lock the facial identity
    - Layer 2 Identity (optional): a full character image including outfit, used to fix the outfit

    Usage strategy:
    - With an active identity → dual-reference mode (lock face + lock outfit)
    - Without an active identity → single-reference mode (lock face; the outfit is controlled by text description)

    Core idea (prompt separation):
    - face_prompt: pure facial features (hairstyle, eyes, skin tone), used for Portrait generation
    - identity.appearance_details: outfit and styling, used for Identity generation
    - By default all identities share one face_prompt, to keep the face consistent
    - Age variants (childhood/old age etc.) can provide separate facial features through identity.face_prompt

    identities is stored as a JSON string.
    Use the get_identities() / set_identities() methods to access it.
    """

    name: str = Field(..., description="Full character name")
    aliases: List[str] = Field(default_factory=list, description="List of aliases")
    role: str = Field(default="", description="Character role (protagonist/supporting/antagonist)")
    is_main: bool = Field(default=False, description="Whether this is the protagonist / core character")
    gender: str = Field(default="", description="Gender: male | female | other")
    age_group: str = Field(default="youth", description="Age group: child/youth/middle/elder")
    body_type: str = Field(default="", description="Body type description, e.g. 'slender and tall', 'sturdy and muscular'")
    fish_voice_id: str = Field(
        default="",
        description="DEPRECATED — Fish Audio voice ID. IndexTTS2 cutover uses reference_audio_path / voice_samples_by_age_group instead; field retained until magnetic data migration completes.",
    )
    reference_audio_path: str = Field(
        default="",
        description="Character-level IndexTTS2 reference audio path (project-relative, default slot)",
    )
    reference_audio_sha256: str = Field(
        default="",
        description="SHA256 of the character-level reference audio content",
    )
    reference_audio_updated_at: str = Field(
        default="",
        description="ISO string of the last content change of the character-level default voice",
    )
    voice_samples_by_age_group_json: str = Field(
        default="{}",
        description="IndexTTS2 voice samples per age group (child/youth/middle/elder) as JSON: {slot: {path, sha256, updated_at}}",
    )
    description: str = Field(default="", description="Character description")

    # ============================================================
    # Layer 1: Portrait (required) - pure face close-up
    # ============================================================

    # Pure facial features (used for Portrait generation)
    face_prompt: str = Field(
        default="",
        description="Pure facial feature description (hairstyle, eyes, skin tone, bone structure), used for Portrait generation",
    )

    appearance_details: str = Field(
        default="",
        description="Default outfit description (text), used when there is no active identity",
    )

    # ============================================================
    # Layer 2: Identity (optional) - full character image (including outfit)
    # ============================================================
    # Identity system - stored as a JSON string for Neo4j compatibility
    identities_json: str = Field(
        default="[]",
        description="JSON string of the identity list",
    )
    updated_at: str = Field(default="", description="ISO string of the last content change of the character asset")

    model_config = ConfigDict(arbitrary_types_allowed=True)

    @model_validator(mode="before")
    @classmethod
    def _coerce_voice_samples_kwarg(cls, data):
        """Accept ``voice_samples_by_age_group=dict(...)`` kwarg and stash to JSON.

        Source-branch voice_clone tests construct ``NovelCharacter(...,
        voice_samples_by_age_group={...})`` directly. We persist the field as
        ``voice_samples_by_age_group_json`` (mirrors ``identities_json``), so
        this pre-validator translates the dict kwarg into the JSON column.
        """
        if isinstance(data, dict) and "voice_samples_by_age_group" in data:
            samples = data.pop("voice_samples_by_age_group") or {}
            if isinstance(samples, dict):
                import json as _json

                data.setdefault(
                    "voice_samples_by_age_group_json",
                    _json.dumps(samples, ensure_ascii=False),
                )
        return data

    @model_validator(mode="after")
    def sanitize_name(self):
        """Remove filesystem-unsafe characters from a character name.

        The character set is defined in :mod:`novelvideo.utils.asset_names`, and the route layer uses the same function for duplicate checks --
        if each side wrote its own regex, the narrower side would let through a name the wider side would rewrite, and ``ON CONFLICT``
        would then silently overwrite the same-named row.
        """
        self.name = path_safe_asset_name(self.name, kind="character")
        return self

    @property
    def identities(self) -> List[CharacterIdentity]:
        """Get the identity list (parsed from JSON, no caching)."""
        if not self.identities_json or self.identities_json == "[]":
            return []

        import json

        try:
            data = json.loads(self.identities_json)
            return [CharacterIdentity(**item) for item in data]
        except (json.JSONDecodeError, TypeError):
            return []

    @property
    def voice_samples_by_age_group(self) -> dict[str, dict]:
        """IndexTTS2 voice samples per age group (dict view, parsed from the JSON field)."""
        if not self.voice_samples_by_age_group_json:
            return {}
        import json

        try:
            data = json.loads(self.voice_samples_by_age_group_json)
            return data if isinstance(data, dict) else {}
        except (json.JSONDecodeError, TypeError):
            return {}

    @voice_samples_by_age_group.setter
    def voice_samples_by_age_group(self, value: dict[str, dict]) -> None:
        import json

        self.voice_samples_by_age_group_json = json.dumps(value or {}, ensure_ascii=False)

    @identities.setter
    def identities(self, value: List[CharacterIdentity]):
        """Set the identity list (serialized to JSON)."""
        import json

        if not value:
            self.identities_json = "[]"
        else:
            self.identities_json = json.dumps(
                [item.model_dump() for item in value],
                ensure_ascii=False,
            )

    def get_identity(self, identity_name: str) -> Optional[CharacterIdentity]:
        """Get an identity by identity name."""
        for identity in self.identities:
            if identity.identity_name == identity_name:
                return identity
        return None

    def migrate_to_identity_format(self) -> None:
        """Migrate legacy-format data to the identity format."""
        if self.identities:
            return

        from novelvideo.utils.identity_resolver import compute_char_tag

        default_id = f"{self.name}_default"
        default_identity = CharacterIdentity(
            identity_id=default_id,
            character_name=self.name,
            identity_name="default",
            character_tag=compute_char_tag(self.name, identity_id=default_id),
            appearance_details=self.appearance_details or self.description,
        )
        self.identities = [default_identity]

    def ensure_tag(self) -> None:
        """Ensure every identity has its own tag."""
        from novelvideo.utils.identity_resolver import compute_char_tag

        identities = self.identities
        if identities:
            for identity in identities:
                if not identity.character_tag:
                    identity.character_tag = compute_char_tag(
                        self.name,
                        identity_id=identity.identity_id,
                    )
            self.identities = identities


class NovelEvent(BaseModel):
    """Novel event (scene level)."""

    event_id: str = Field(..., description="Unique ID, e.g. ch1_e1")
    chapter_num: int = Field(..., description="Chapter it belongs to")
    description: str = Field(..., description="Event description (within 20 words)")
    location: str = Field(default="", description="Location")
    time_marker: str = Field(default="", description="Time marker (e.g. evening, the next day)")
    characters: List[str] = Field(default_factory=list, description="Participating characters")
    text_start: int = Field(default=0, description="Start position in the source text (character offset)")
    text_end: int = Field(default=0, description="End position in the source text")
    content: str = Field(default="", description="Source text corresponding to the event")
    causes: List[str] = Field(default_factory=list, description="Causal relations (IDs of preceding events)")


class NovelEpisode(BaseModel):
    """Episode entity."""

    number: int = Field(..., description="Episode number")
    title: str = Field(..., description="Title")
    chapter_start: int = Field(default=0, description="Starting chapter")
    chapter_end: int = Field(default=0, description="Ending chapter")
    raw_content: str = Field(default="", description="Source text of this episode")
    adapted_content: str = Field(default="", description="Rewritten working copy")
    beat_source_text: str = Field(default="", description="Working text used for line-by-line storyboard generation")
    content_summary: str = Field(default="", description="Content summary")
    main_conflict: str = Field(default="", description="Main conflict")
    cliffhanger: str = Field(default="", description="Cliffhanger / hook")
    key_events: List[str] = Field(default_factory=list, description="Key events")
    character_names: List[str] = Field(default_factory=list, description="Names of appearing characters")
    identity_ids: List[str] = Field(
        default_factory=list, description="List of identity IDs planned for this episode, e.g. ['Su Qingyan_daily']"
    )
    sketch_colors_json: str = Field(
        default="{}",
        description='Sketch color mapping as a JSON string, e.g. {"Su Qingyan_daily": "red"}',
    )

    # Event-level planning support (AI planning mode)
    event_ids: List[str] = Field(default_factory=list, description="List of associated event IDs")
    scene_menu_json: str = Field(default="[]", description="JSON: list of SceneMenuItem")
    prop_menu_json: str = Field(default="[]", description="JSON: list of PropMenuItem")
    identity_default_map_json: str = Field(
        default="{}",
        description='JSON: default identity mapping of the characters in this episode, e.g. {"Du Chen": "Du Chen_middle_aged"}',
    )
    updated_at: str = Field(default="", description="ISO string of the last content change of the episode plan")

    @model_validator(mode="before")
    @classmethod
    def _migrate_episode_asset_menu(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        payload = dict(data)
        if not payload.get("scene_menu_json"):
            payload["scene_menu_json"] = json.dumps(
                [
                    item.model_dump()
                    for item in build_scene_menu(
                        scene_menu=payload.get("scene_menu") or [],
                    )
                ],
                ensure_ascii=False,
            )
        if not payload.get("prop_menu_json"):
            payload["prop_menu_json"] = json.dumps(
                [
                    item.model_dump()
                    for item in build_prop_menu(
                        prop_menu=payload.get("prop_menu") or [],
                    )
                ],
                ensure_ascii=False,
            )
        if not payload.get("identity_default_map_json"):
            payload["identity_default_map_json"] = json.dumps(
                payload.get("identity_default_map") or {},
                ensure_ascii=False,
            )
        return payload

    @property
    def scene_menu(self) -> List[SceneMenuItem]:
        if not self.scene_menu_json or self.scene_menu_json == "[]":
            return []
        try:
            data = json.loads(self.scene_menu_json)
            return build_scene_menu(scene_menu=data)
        except (json.JSONDecodeError, TypeError, ValueError):
            return []

    @scene_menu.setter
    def scene_menu(self, value: List[SceneMenuItem] | List[dict]):
        self.scene_menu_json = (
            json.dumps(
                [item.model_dump() for item in build_scene_menu(scene_menu=value)],
                ensure_ascii=False,
            )
            if value
            else "[]"
        )

    @property
    def prop_menu(self) -> List[PropMenuItem]:
        if not self.prop_menu_json or self.prop_menu_json == "[]":
            return []
        try:
            data = json.loads(self.prop_menu_json)
            return build_prop_menu(prop_menu=data)
        except (json.JSONDecodeError, TypeError, ValueError):
            return []

    @prop_menu.setter
    def prop_menu(self, value: List[PropMenuItem] | List[dict]):
        self.prop_menu_json = (
            json.dumps(
                [item.model_dump() for item in build_prop_menu(prop_menu=value)],
                ensure_ascii=False,
            )
            if value
            else "[]"
        )

    @property
    def identity_default_map(self) -> dict[str, str]:
        if not self.identity_default_map_json or self.identity_default_map_json == "{}":
            return {}
        try:
            data = json.loads(self.identity_default_map_json)
            if not isinstance(data, dict):
                return {}
            return {
                str(name or "").strip(): str(identity_id or "").strip()
                for name, identity_id in data.items()
                if str(name or "").strip() and str(identity_id or "").strip()
            }
        except (json.JSONDecodeError, TypeError, ValueError):
            return {}

    @identity_default_map.setter
    def identity_default_map(self, value: dict[str, str] | None):
        normalized = {
            str(name or "").strip(): str(identity_id or "").strip()
            for name, identity_id in (value or {}).items()
            if str(name or "").strip() and str(identity_id or "").strip()
        }
        self.identity_default_map_json = (
            json.dumps(normalized, ensure_ascii=False) if normalized else "{}"
        )


class NovelVisualBeat(BaseModel):
    """Visual beat entity."""

    beat_number: int = Field(..., description="Beat number (1-based)")
    episode_number: int = Field(..., description="Episode it belongs to")
    narration: str = Field(default="", description="TTS text (narration or dialogue, used for embedding index)")
    visual_description: str = Field(default="", description="Picture description (creative intent)")
    source_text_sha256: str = Field(default="", description="SHA256 of the text actually fed in when this shot was generated")

    time_of_day: str = Field(
        default="",
        description="Time of day (dawn/morning/noon/afternoon/day/dusk/night); empty means unspecified",
    )

    # Sketch color detection
    detected_identities_json: str = Field(
        default="[]", description="List of on-screen identity IDs detected by sketch color (JSON serialized)"
    )
    detected_props_json: str = Field(
        default="[]", description="List of on-screen global prop IDs detected by sketch color (JSON serialized)"
    )
    scene_ref_json: str = Field(
        default="",
        description="Normalized scene reference JSON of the current beat",
    )
    # Video generation parameters (Beat level)
    video_mode: str = Field(default="first_frame", description="first_frame / keyframe")
    video_prompt: str = Field(default="", description="Video motion prompt")
    keyframe_prompt: str = Field(default="", description="First/last frame transition prompt")

    # Seedance 2.0 per-beat config overrides (Stage B; Stage A persists '{}' default)
    seedance2_config_json: str = Field(
        default="{}",
        description="Seedance 2.0 per-beat override JSON (actually used in Stage B; Stage A only persists a placeholder)",
    )

    # Dialogue support
    audio_type: str = Field(default="narration", description="silence/narration/dialogue")
    speaker: str = Field(default="", description="Speaker label")
    speaker_kind: str = Field(
        default="character",
        description="speaker type: character/non_character",
    )

    # Manual shot insertion support
    shot_order: Optional[int] = Field(
        default=None, description="Display/narrative order (fractional ordering)"
    )
    duration_seconds: Optional[float] = Field(default=None, description="User-specified target duration (seconds)")
    is_manual_shot: bool = Field(default=False, description="Whether this is a shot manually inserted by the user")

    # MiniMax H3 Multishot support (2026-10-19): a non-empty, user-chosen
    # opaque string groups N CONSECUTIVE beats (by shot_order) into one
    # continuous multi-shot take — see
    # `generators/runpod_minimax_h3_multishot_video.py` and
    # `api/routes/generation.py`'s multishot review/enqueue routes.
    # Deliberately a separate, explicit field rather than inferring a chain
    # from `scene_ref.scene_id`: that grouping can merge non-consecutive
    # beats sharing a scene (see `generators/nanobanana_grid.py`'s
    # `_group_beats_by_location`), which is not a safe proxy for "these
    # beats form one continuous take".
    multishot_chain_id: str = Field(
        default="", description="Grouping ID for one continuous multi-shot (H3 Multishot) sequence; empty means it does not belong to any sequence"
    )

    @model_validator(mode="after")
    def ensure_fields_not_empty(self) -> "NovelVisualBeat":
        """Ensure key fields are not empty."""
        scene_ref = None
        if self.scene_ref_json:
            try:
                scene_ref = _coerce_scene_ref(json.loads(self.scene_ref_json))
            except (TypeError, ValueError, json.JSONDecodeError):
                scene_ref = None
        self.scene_ref_json = (
            json.dumps(scene_ref.model_dump(), ensure_ascii=False) if scene_ref else ""
        )

        if not self.narration or not self.narration.strip():
            if not self.is_manual_shot and self.audio_type not in {"silence", "action"}:
                self.narration = "(empty)"
        if not self.visual_description or not self.visual_description.strip():
            if not self.is_manual_shot:
                self.visual_description = f"Scene picture: {self.narration[:50]}"
        return self

    @property
    def scene_ref(self) -> SceneRef | None:
        return parse_scene_ref_json(self.scene_ref_json)

    @property
    def scene_id(self) -> str:
        scene_ref = self.scene_ref
        return scene_ref.scene_id if scene_ref else ""


class NovelScene(BaseModel):
    """Scene entity -- a location/environment in the story."""

    name: str = Field(description="Scene name, e.g. 'Imperial Palace · Great Hall'")
    aliases: List[str] = Field(default_factory=list, description="Aliases")
    scene_type: str = Field(default="interior", description="interior/exterior/nature")
    base_scene_id: str = Field(default="", description="ID of the base scene a derived scene belongs to; empty for base scenes")
    variant_id: str = Field(default="", description="State/look label of a derived scene; empty for base scenes")
    time_of_day: str = Field(default="", description="Time of day of the scene reference image itself; empty means generic time")

    environment_prompt: str = Field(default="", description="Environment description prompt (used to generate the reference image)")
    variant_prompt: str = Field(default="", description="Incremental visual description of a derived scene relative to the base scene")
    description: str = Field(default="", description="Narrative description of the scene")
    spatial_layout_image: str = Field(default="", description="Scene-level spatial layout reference image path")
    notes: str = Field(default="")
    updated_at: str = Field(default="", description="ISO string of the last content change of the scene asset")

    @model_validator(mode="after")
    def sanitize_name(self):
        """Remove path-unsafe characters from a scene name, keeping the original name as an alias.

        A scene name is at the same time a SQLite primary key, a REST path segment and a disk directory name; a slash would make the whole row of this scene's
        ``{name}`` endpoints 404 (see :mod:`novelvideo.utils.asset_names`).
        ``NovelCharacter.sanitize_name`` has long done this; scenes / props now get the same gate.
        """
        self.name, self.aliases = coerce_path_safe_asset_name(self.name, self.aliases)
        return self


def build_scene_effective_prompt(scene: NovelScene, base_scene: NovelScene | None = None) -> str:
    """Build the display/generation fallback prompt for a scene record.

    New derived scenes store only sparse deltas in variant_prompt.  Old derived
    scenes may still carry a fused environment_prompt; keep that readable.
    """

    own_prompt = str(
        getattr(scene, "environment_prompt", "") or getattr(scene, "description", "") or ""
    ).strip()
    variant_prompt = str(getattr(scene, "variant_prompt", "") or "").strip()
    base_scene_id = str(getattr(scene, "base_scene_id", "") or "").strip()
    variant_id = str(getattr(scene, "variant_id", "") or "").strip()
    time_of_day = str(getattr(scene, "time_of_day", "") or "").strip()
    if not base_scene_id:
        return own_prompt or str(scene.name or "").strip()
    if own_prompt and not variant_prompt and not time_of_day:
        return own_prompt

    base_prompt = ""
    if base_scene is not None:
        base_prompt = str(
            getattr(base_scene, "environment_prompt", "")
            or getattr(base_scene, "description", "")
            or ""
        ).strip()

    lines: list[str] = []
    if base_prompt:
        lines.extend(["[Base Scene Prompt]", base_prompt])
    else:
        lines.extend(["[Base Scene]", base_scene_id])
    if variant_id:
        lines.extend(["", f"[Variant] {variant_id}"])
    if variant_prompt:
        lines.extend(["", "[Variant Delta]", variant_prompt])
    if time_of_day:
        lines.extend(
            [
                "",
                "[Time-of-Day Plate]",
                f"Overall lighting is for the {time_of_day} period; structure, furnishings and materials not declared as changed are inherited from the base scene.",
            ]
        )
    if own_prompt and own_prompt != base_prompt and not variant_prompt:
        lines.extend(["", "[Stored Scene Prompt]", own_prompt])
    return "\n".join(part for part in lines if part is not None).strip()


class NovelProp(BaseModel):
    """Prop entity -- an important object/weapon/token in the story."""

    name: str = Field(description="Prop name, e.g. 'Seven-Star Sword'")
    aliases: List[str] = Field(default_factory=list, description="Aliases")
    prop_type: str = Field(
        default="object", description="weapon/accessory/artifact/document/furniture"
    )

    visual_prompt: str = Field(default="", description="Prop visual prompt (used to generate the reference image)")
    description: str = Field(default="", description="Narrative description of the prop (material, size, use)")

    owner: str = Field(default="", description="Owning character name")
    notes: str = Field(default="")
    updated_at: str = Field(default="", description="ISO string of the last content change of the prop asset")

    @model_validator(mode="after")
    def sanitize_name(self):
        """Remove path-unsafe characters from a prop name, keeping the original name as an alias. See NovelScene.sanitize_name."""
        self.name, self.aliases = coerce_path_safe_asset_name(self.name, self.aliases)
        return self


# =============================================================================
# First-frame generation context
# =============================================================================


# =============================================================================
# Genre style
# =============================================================================


class GenreStyle(BaseModel):
    """Genre style definition."""

    genre: str = Field(description="Genre, e.g. 'romance', 'fantasy', 'suspense', 'urban'")

    # Visual style (default: realistic period drama style)
    art_style: str = Field(
        default="realistic period drama style", description="Art style, e.g. 'realistic period drama style', 'shoujo manga style', 'shonen manga style'"
    )
    color_palette: list[str] = Field(default_factory=list, description="List of main colors")

    # Default character appearance style
    default_appearance_style: str = Field(default="refined realism")

    # Scene style
    background_style: str = Field(default="classical imperial palace")

    # Narrative style
    narration_tone: str = Field(default="gentle and lyrical", description="Narration tone")
    pacing: str = Field(default="slow and delicate", description="Pacing")


# =============================================================================
# Image pool related
# =============================================================================


class GridEntry(BaseModel):
    """Grid image metadata - tracks the 3 elements of a whole image (type + mode_key + beat_nums).

    File name pattern: {type}_{mode_key}_{beats_str}_grid_{ts}.png
    Example: render_3x3_1-2-3-4-5-6-7-8-9_grid_20260227143052.png
    """

    type: str = Field(description="Image type: render or sketch")
    mode_key: str = Field(description="Generation mode, e.g. 3x3, 1x1_9-16, 2x2_1-1")
    beat_nums: list[int] = Field(description="List of included beat numbers")
    preset: str = Field(default="scene", description="preset group: scene / char / loc / custom")
    grid_path: str = Field(description="Relative path of the whole image file")
    prompt_path: str = Field(default="", description="Relative path of the prompt file")
    generated_at: Optional[datetime] = Field(default=None, description="Generation time")

    @property
    def beats_str(self) -> str:
        """Hyphen-separated string of beat numbers."""
        return "-".join(str(b) for b in self.beat_nums)


class PoolImage(BaseModel):
    """Image pool entry - used by the flexible image selection system.

    All generated images (1x1, 3x3, 5x5, etc.) go into one image pool,
    and the user can freely pick any image from the pool and assign it to any beat.

    Two types are supported:
    - render: rendered image (high-definition final image)
    - sketch: sketch (composition reference)

    Version management:
    - cell files are all stored in the cells/ directory, with beat-centered names: cells/beat_01_t20260213143052.png
    - generated_at records the generation time, used for version ordering
    """

    id: str = Field(description="Unique identifier, format: beat_{NN}_t{timestamp}[_render|_sketch]")
    mode: str = Field(description="Generation mode: 1x1, 3x3, 5x5, regen, etc.")
    grid_index: int = Field(description="Index of the grid it belongs to (starting from 1)")
    cell_index: int = Field(description="Cell index within the grid (starting from 1, row-major)")
    grid_path: str = Field(description="Original grid image path")
    cell_path: Optional[str] = Field(default=None, description="Path of the cell image after cutting")
    row: int = Field(description="Row number within the grid (starting from 0)")
    col: int = Field(description="Column number within the grid (starting from 0)")
    original_beat: int = Field(description="Beat number it corresponded to at original generation")
    generated_at: Optional[datetime] = Field(default=None, description="Generation time (used for version management)")
    type: str = Field(default="render", description="Image type: render (rendered image) or sketch (sketch)")
    content_hash: Optional[str] = Field(default=None, description="Content hash (used for de-duplication)")
    beat_content_hash: Optional[str] = Field(
        default=None, description="SHA256 of the beat content at generation time (used for stale detection)"
    )


class PoolIndex(BaseModel):
    """Image pool index - manages all image pool entries of one episode."""

    episode: int = Field(description="Episode number")
    generated_at: datetime = Field(default_factory=datetime.now, description="Generation time")
    version: int = Field(default=2, description="Index version: 1 = old format, 2 = new format")
    modes: dict[str, dict] = Field(
        default_factory=dict,
        description="Statistics per mode, e.g. {'3x3': {'total_grids': 3, 'total_cells': 27}}",
    )
    grids: list[GridEntry] = Field(default_factory=list, description="Metadata of all whole images")
    images: list[PoolImage] = Field(default_factory=list, description="All image pool entries")
    beat_assignments: dict[str, str] = Field(
        default_factory=dict,
        description="beat → render cell mapping, e.g. {'1': '3x3_g01_c01', '2': '3x3_g01_c02'}",
    )

    def get_cell_path(self, pool_id: str) -> Optional[str]:
        """Get the cell path by pool_id."""
        for img in self.images:
            if img.id == pool_id:
                return img.cell_path
        return None

    def get_image(self, pool_id: str) -> Optional[PoolImage]:
        """Get the image entry by pool_id."""
        for img in self.images:
            if img.id == pool_id:
                return img
        return None

    def filter_by_mode(self, mode: str) -> list[PoolImage]:
        """Filter images by mode."""
        return [img for img in self.images if img.mode == mode]

    def filter_by_beat(self, beat: int) -> list[PoolImage]:
        """Filter images by original beat."""
        return [img for img in self.images if img.original_beat == beat]

    def get_recommended_for_beat(self, beat: int) -> list[PoolImage]:
        """Get the recommended images of a beat (from different modes)."""
        return self.filter_by_beat(beat)

    def filter_by_type(self, img_type: str) -> list[PoolImage]:
        """Filter images by type (render or sketch)."""
        return [img for img in self.images if img.type == img_type]

    def filter_by_beat_and_type(self, beat: int, img_type: str) -> list[PoolImage]:
        """Filter images by beat and type."""
        return [img for img in self.images if img.original_beat == beat and img.type == img_type]

    def find_grid(self, grid_type: str, mode_key: str, beat_nums: list[int]) -> Optional[GridEntry]:
        """Find a whole image by its 3 elements."""
        beat_set = set(beat_nums)
        for g in self.grids:
            if g.type == grid_type and g.mode_key == mode_key and set(g.beat_nums) == beat_set:
                return g
        return None

    def add_grid(self, entry: GridEntry) -> None:
        """Add whole-image metadata."""
        self.grids.append(entry)

    def has_duplicate_cell(self, beat_num: int, content_hash: str) -> bool:
        """Check whether the pool already has an image of the same beat with identical content."""
        for img in self.images:
            if img.original_beat == beat_num and img.content_hash == content_hash:
                return True
        return False


# =============================================================================
# Video pool model
# =============================================================================


class VideoPoolEntry(BaseModel):
    """Video pool entry."""

    id: str  # "beat_01_20260226_143052"
    beat_num: int
    video_path: str  # relative path inside the pool "beat_01_20260226_143052.mp4"
    generated_at: datetime
    duration: float = 5.0
    video_mode: str = "first_frame"
    backend: str = "comfyui"
    prompt: str = ""


class VideoPoolIndex(BaseModel):
    """Video pool index."""

    episode: int
    generated_at: datetime = Field(default_factory=datetime.now)
    videos: list[VideoPoolEntry] = Field(default_factory=list)
    beat_assignments: dict[str, str] = Field(default_factory=dict)

    def get_entry(self, pool_id: str) -> Optional[VideoPoolEntry]:
        """Get the video entry by pool_id."""
        for v in self.videos:
            if v.id == pool_id:
                return v
        return None

    def filter_by_beat(self, beat_num: int) -> list[VideoPoolEntry]:
        """Filter videos by beat number."""
        return [v for v in self.videos if v.beat_num == beat_num]

    def get_latest_for_beat(self, beat_num: int) -> Optional[VideoPoolEntry]:
        """Get the latest video of a beat."""
        entries = self.filter_by_beat(beat_num)
        if not entries:
            return None
        return max(entries, key=lambda v: v.generated_at)
