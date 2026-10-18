"""Task rows of selected-Beats regeneration must be able to say which beats they cover.

The task row of ``sketch_regen`` / ``selected_regen`` has ``beat_num`` None and ``scope`` is
``mode_key__sha1(beats)``, from neither of which can the frontend recover the beat numbers. As a result every beat's sketch /
render panel claims the same task, and while one beat is running the other beats also show "generating".
At enqueue time the beat list is stored in the task metadata, so the frontend can show progress by beat attribution.
"""

import pytest

from novelvideo.ports.tasks import display_metadata_for_task


def test_selected_beats_land_in_metadata_from_config():
    metadata = display_metadata_for_task(
        "sketch_regen",
        {"episode": 1, "config": {"selected_beat_numbers": [9, 10]}},
    )

    assert metadata["beat_numbers"] == [9, 10]


def test_selected_beats_also_read_from_top_level_payload():
    metadata = display_metadata_for_task(
        "selected_regen",
        {"episode": 1, "selected_beat_numbers": [3]},
    )

    assert metadata["beat_numbers"] == [3]


def test_beat_numbers_are_deduped_in_order():
    metadata = display_metadata_for_task(
        "sketch_regen",
        {"config": {"selected_beat_numbers": [9, 9, 7, "7", 8]}},
    )

    assert metadata["beat_numbers"] == [9, 7, 8]


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"config": {}},
        {"config": {"selected_beat_numbers": []}},
        {"config": {"selected_beat_numbers": ["", None]}},
    ],
)
def test_no_beat_numbers_key_when_payload_has_none(payload):
    """Without a list, do not write this key -- the frontend reads "missing" as "covers all", and writing an empty list would hide
    beats that are really running."""
    assert "beat_numbers" not in display_metadata_for_task("sketch_regen", payload)


def test_existing_display_metadata_is_untouched():
    metadata = display_metadata_for_task(
        "stage_asset",
        {"scene_name": "LivingRoom", "step": "pano", "display_name": "Stage assets"},
    )

    assert metadata["scene_name"] == "LivingRoom"
    assert metadata["step"] == "pano"
    assert metadata["display_name"] == "Stage assets"
    assert "beat_numbers" not in metadata
