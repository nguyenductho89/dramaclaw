from novelvideo.generators.prompt_builder import PromptComponents
from novelvideo.models import (
    NO_CHARACTER_MARKER,
    NO_PROP_MARKER,
    complete_detected_refs_from_visual_description,
    real_detected_identities,
    real_detected_props,
)


def test_real_detected_identities_filters_no_character_marker():
    assert real_detected_identities([NO_CHARACTER_MARKER]) == []
    assert real_detected_identities([NO_CHARACTER_MARKER, "Alex_young_adult"]) == ["Alex_young_adult"]


def test_real_detected_props_filters_no_prop_marker():
    assert real_detected_props([NO_PROP_MARKER]) == []
    assert real_detected_props([NO_PROP_MARKER, "leather_notebook"]) == ["leather_notebook"]


def test_prompt_character_collection_ignores_no_character_marker():
    result = PromptComponents._collect_char_identity_ids(
        [{"detected_identities": [NO_CHARACTER_MARKER]}],
        use_detected_identities=True,
    )

    assert result == {}


def test_complete_detected_refs_adds_markers_from_visual_description():
    identities, props = complete_detected_refs_from_visual_description(
        visual_description="{{Alex_young_adult}} stands in the rain holding [[leather_notebook]].",
        detected_identities=[],
        detected_props=[],
        allowed_identity_ids={"Alex_young_adult"},
        allowed_prop_ids={"leather_notebook"},
    )

    assert identities == ["Alex_young_adult"]
    assert props == ["leather_notebook"]


def test_complete_detected_refs_writes_empty_markers_when_no_valid_refs():
    identities, props = complete_detected_refs_from_visual_description(
        visual_description="No valid markers.",
        detected_identities=[],
        detected_props=[],
        allowed_identity_ids={"Alex_young_adult"},
        allowed_prop_ids={"leather_notebook"},
    )

    assert identities == [NO_CHARACTER_MARKER]
    assert props == [NO_PROP_MARKER]
