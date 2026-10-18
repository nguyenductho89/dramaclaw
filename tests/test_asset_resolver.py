from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from novelvideo.models import sync_beat_asset_refs
from novelvideo.utils.asset_resolver import AssetResolver
from novelvideo.utils.background_anchor import (
    background_crop_ratio_choices,
    copy_to_beat_selected_background,
    crop_to_beat_selected_background,
)


def _touch(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"png")


def test_background_crop_ratio_choices_puts_preferred_first() -> None:
    assert background_crop_ratio_choices("2:3")[:2] == ["2:3", "16:9"]


def test_render_scene_refs_ignore_director_control_frames(tmp_path: Path) -> None:
    scene_dir = tmp_path / "assets" / "scenes" / "Noodle Shop"
    master_path = scene_dir / "master.png"
    director_path = (
        tmp_path / "director_control_frames" / "ep001" / "beat_03" / "combined.png"
    )
    legacy_director_color_ref = (
        tmp_path / "assets" / "director_refs" / "ep001" / "beat_03" / "director_color_ref.png"
    )
    _touch(master_path)
    _touch(director_path)
    _touch(legacy_director_color_ref)

    beat = {"beat_number": 3, "scene_ref": {"scene_id": "Noodle Shop"}}
    resolver = AssetResolver(
        tmp_path,
        episode_number=1,
        scene_reference_kind="render",
        use_director_refs=True,
        director_ref_beat_numbers=[3],
    )

    refs = resolver.resolve_scenes_for_beat(beat)

    assert len(refs) == 1
    assert refs[0].source_level == "base_image"
    assert refs[0].image_paths == [str(master_path)]


def test_sketch_scene_refs_use_director_control_frame(tmp_path: Path) -> None:
    scene_dir = tmp_path / "assets" / "scenes" / "Noodle Shop"
    master_path = scene_dir / "master.png"
    director_path = (
        tmp_path / "director_control_frames" / "ep001" / "beat_03" / "combined.png"
    )
    _touch(master_path)
    _touch(director_path)

    beat = {"beat_number": 3, "scene_ref": {"scene_id": "Noodle Shop"}}
    resolver = AssetResolver(
        tmp_path,
        episode_number=1,
        scene_reference_kind="sketch",
        use_director_refs=True,
        director_ref_beat_numbers=[3],
    )

    refs = resolver.resolve_scenes_for_beat(beat)

    assert len(refs) == 1
    assert refs[0].source_level == "director_image"
    assert refs[0].image_paths == [str(director_path)]


def test_sketch_scene_refs_use_master_by_default(tmp_path: Path) -> None:
    scene_dir = tmp_path / "assets" / "scenes" / "Noodle Shop"
    master_path = scene_dir / "master.png"
    _touch(master_path)

    beat = {"beat_number": 3, "scene_ref": {"scene_id": "Noodle Shop"}}
    resolver = AssetResolver(tmp_path, episode_number=1, scene_reference_kind="sketch")

    refs = resolver.resolve_scenes_for_beat(beat)

    assert len(refs) == 1
    assert refs[0].source_level == "base_image"
    assert refs[0].image_paths == [str(master_path)]


def test_scene_variant_master_falls_back_to_base_when_derived_image_missing(
    tmp_path: Path,
) -> None:
    base_master_path = tmp_path / "assets" / "scenes" / "Bathroom" / "master.png"
    _touch(base_master_path)

    resolver = AssetResolver(
        tmp_path,
        episode_number=1,
        scene_reference_kind="render",
        scenes=[SimpleNamespace(name="Bathroom"), SimpleNamespace(name="Bathroom_Leak")],
    )

    refs = resolver.resolve_scenes_for_beat(
        {"beat_number": 3, "scene_ref": {"scene_id": "Bathroom", "variant_id": "Leak"}}
    )

    assert len(refs) == 1
    assert refs[0].base_id == "Bathroom_Leak"
    assert refs[0].source_level == "base_image"
    assert refs[0].image_paths == [str(base_master_path)]


def test_scene_variant_text_fallback_combines_base_prompt_and_variant_delta(
    tmp_path: Path,
) -> None:
    resolver = AssetResolver(
        tmp_path,
        episode_number=1,
        scene_reference_kind="render",
        scenes=[
            SimpleNamespace(
                name="Bathroom",
                environment_prompt="White tile walls, the front is a sink.",
                description="",
            ),
            SimpleNamespace(
                name="Bathroom_Leak",
                base_scene_id="Bathroom",
                variant_id="Leak",
                variant_prompt="Standing water on the floor, the ceiling keeps dripping.",
                environment_prompt="",
                description="",
            ),
        ],
    )

    refs = resolver.resolve_scenes_for_beat(
        {"beat_number": 3, "scene_ref": {"scene_id": "Bathroom", "variant_id": "Leak"}}
    )

    assert len(refs) == 1
    assert "White tile walls" in refs[0].text_description
    assert "Standing water" in refs[0].text_description


def test_scene_time_plate_marks_anchor_as_time_baked(tmp_path: Path) -> None:
    night_master_path = tmp_path / "assets" / "scenes" / "Bathroom_nighttime" / "master.png"
    _touch(night_master_path)

    resolver = AssetResolver(
        tmp_path,
        episode_number=1,
        scene_reference_kind="render",
        scenes=[SimpleNamespace(name="Bathroom"), SimpleNamespace(name="Bathroom_nighttime")],
    )

    refs = resolver.resolve_scenes_for_beat(
        {"beat_number": 3, "scene_ref": {"scene_id": "Bathroom"}, "time_of_day": "night"}
    )

    assert len(refs) == 1
    assert refs[0].base_id == "Bathroom_nighttime"
    assert refs[0].time_baked is True
    assert refs[0].image_paths == [str(night_master_path)]


def test_scene_time_plate_can_resolve_from_asset_directory_without_scene_record(
    tmp_path: Path,
) -> None:
    night_master_path = tmp_path / "assets" / "scenes" / "Bathroom_nighttime" / "master.png"
    _touch(night_master_path)

    resolver = AssetResolver(
        tmp_path,
        episode_number=1,
        scene_reference_kind="render",
        scenes=[SimpleNamespace(name="Bathroom")],
    )

    refs = resolver.resolve_scenes_for_beat(
        {"beat_number": 3, "scene_ref": {"scene_id": "Bathroom"}, "time_of_day": "night"}
    )

    assert len(refs) == 1
    assert refs[0].base_id == "Bathroom_nighttime"
    assert refs[0].source_level == "base_image"
    assert refs[0].image_paths == [str(night_master_path)]
    assert refs[0].time_baked is True


def test_scene_time_plate_missing_master_falls_back_to_base_and_relit(
    tmp_path: Path,
) -> None:
    base_master_path = tmp_path / "assets" / "scenes" / "Bathroom" / "master.png"
    derived_scene_dir = tmp_path / "assets" / "scenes" / "Bathroom_nighttime"
    derived_scene_dir.mkdir(parents=True)
    _touch(base_master_path)

    resolver = AssetResolver(
        tmp_path,
        episode_number=1,
        scene_reference_kind="render",
        scenes=[SimpleNamespace(name="Bathroom"), SimpleNamespace(name="Bathroom_nighttime")],
    )

    refs = resolver.resolve_scenes_for_beat(
        {"beat_number": 3, "scene_ref": {"scene_id": "Bathroom"}, "time_of_day": "night"}
    )

    assert len(refs) == 1
    assert refs[0].base_id == "Bathroom_nighttime"
    assert refs[0].time_baked is False
    assert refs[0].image_paths == [str(base_master_path)]


def test_scene_variant_time_plate_keeps_variant_and_marks_time_baked(
    tmp_path: Path,
) -> None:
    variant_night_master_path = (
        tmp_path / "assets" / "scenes" / "Bathroom_Leak_nighttime" / "master.png"
    )
    _touch(variant_night_master_path)

    resolver = AssetResolver(
        tmp_path,
        episode_number=1,
        scene_reference_kind="render",
        scenes=[
            SimpleNamespace(name="Bathroom"),
            SimpleNamespace(name="Bathroom_nighttime"),
            SimpleNamespace(name="Bathroom_Leak"),
            SimpleNamespace(name="Bathroom_Leak_nighttime"),
        ],
    )

    refs = resolver.resolve_scenes_for_beat(
        {
            "beat_number": 3,
            "scene_ref": {"scene_id": "Bathroom", "variant_id": "Leak"},
            "time_of_day": "night",
        }
    )

    assert len(refs) == 1
    assert refs[0].base_id == "Bathroom_Leak_nighttime"
    assert refs[0].time_baked is True
    assert refs[0].image_paths == [str(variant_night_master_path)]


def test_scene_variant_time_plate_missing_master_falls_back_and_relit(
    tmp_path: Path,
) -> None:
    base_master_path = tmp_path / "assets" / "scenes" / "Bathroom" / "master.png"
    variant_night_dir = tmp_path / "assets" / "scenes" / "Bathroom_Leak_nighttime"
    variant_night_dir.mkdir(parents=True)
    _touch(base_master_path)

    resolver = AssetResolver(
        tmp_path,
        episode_number=1,
        scene_reference_kind="render",
        scenes=[
            SimpleNamespace(name="Bathroom"),
            SimpleNamespace(name="Bathroom_Leak_nighttime"),
        ],
    )

    refs = resolver.resolve_scenes_for_beat(
        {
            "beat_number": 3,
            "scene_ref": {"scene_id": "Bathroom", "variant_id": "Leak"},
            "time_of_day": "night",
        }
    )

    assert len(refs) == 1
    assert refs[0].base_id == "Bathroom_Leak_nighttime"
    assert refs[0].time_baked is False
    assert refs[0].image_paths == [str(base_master_path)]


def test_scene_selected_background_anchor_clears_time_baked(tmp_path: Path) -> None:
    night_master_path = tmp_path / "assets" / "scenes" / "Bathroom_nighttime" / "master.png"
    selected_background = (
        tmp_path / "director_control_frames" / "ep001" / "beat_03" / "selected_background.png"
    )
    _touch(night_master_path)
    _touch(selected_background)

    resolver = AssetResolver(
        tmp_path,
        episode_number=1,
        scene_reference_kind="render",
        scenes=[SimpleNamespace(name="Bathroom"), SimpleNamespace(name="Bathroom_nighttime")],
    )

    refs = resolver.resolve_scenes_for_beat(
        {
            "beat_number": 3,
            "scene_ref": {
                "scene_id": "Bathroom",
                "render_anchor_id": "selected_background",
            },
            "time_of_day": "night",
        }
    )

    assert len(refs) == 1
    assert refs[0].base_id == "Bathroom_nighttime"
    assert refs[0].time_baked is False
    assert refs[0].image_paths == [str(selected_background)]


def test_render_scene_refs_use_beat_selected_anchor_id(tmp_path: Path) -> None:
    scene_dir = tmp_path / "assets" / "scenes" / "Noodle Shop"
    master_path = scene_dir / "master.png"
    shot_path = (
        tmp_path / "director_control_frames" / "ep001" / "beat_03" / "selected_background.png"
    )
    _touch(master_path)
    _touch(shot_path)

    beat = {
        "beat_number": 3,
        "scene_ref": {
            "scene_id": "Noodle Shop",
            "render_anchor_id": "selected_background",
        },
    }
    resolver = AssetResolver(tmp_path, episode_number=1, scene_reference_kind="render")

    refs = resolver.resolve_scenes_for_beat(beat)

    assert len(refs) == 1
    assert refs[0].source_level == "selected_background_image"
    assert refs[0].image_paths == [str(shot_path)]


def test_copy_to_beat_selected_background_uses_canonical_beat_slot(tmp_path: Path) -> None:
    source_path = tmp_path / "assets" / "scenes" / "Noodle Shop" / "reverse_master.png"
    source_path.parent.mkdir(parents=True, exist_ok=True)
    source_path.write_bytes(b"reverse-png")

    target_path = copy_to_beat_selected_background(tmp_path, 1, 15, source_path)

    assert target_path == (
        tmp_path
        / "director_control_frames"
        / "ep001"
        / "beat_15"
        / "selected_background.png"
    )
    assert target_path.read_bytes() == b"reverse-png"


def test_crop_to_beat_selected_background_uses_requested_crop(tmp_path: Path) -> None:
    from PIL import Image

    source_path = tmp_path / "assets" / "scenes" / "Noodle Shop" / "master.png"
    source_path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (100, 60), (10, 20, 30)).save(source_path)

    target_path = crop_to_beat_selected_background(
        tmp_path,
        1,
        15,
        source_path,
        x=10,
        y=5,
        width=40,
        height=20,
    )

    with Image.open(target_path) as image:
        assert image.size == (40, 20)


def test_batch_scene_refs_ignore_per_beat_selected_anchor_paths(tmp_path: Path) -> None:
    scene_dir = tmp_path / "assets" / "scenes" / "Noodle Shop"
    master_path = scene_dir / "master.png"
    reverse_path = scene_dir / "reverse_master.png"
    anchor_1 = scene_dir / "render_anchors" / "latest.png"
    anchor_2 = tmp_path / "director_control_frames" / "ep001" / "beat_03" / "env_only.png"
    _touch(master_path)
    _touch(reverse_path)
    _touch(anchor_1)
    _touch(anchor_2)

    beats = [
        {
            "beat_number": 1,
            "scene_ref": {
                "scene_id": "Noodle Shop",
                "render_anchor_path": str(anchor_1),
            },
        },
        {
            "beat_number": 2,
            "scene_ref": {
                "scene_id": "Noodle Shop",
                "background_ref_path": str(anchor_2),
            },
        },
    ]
    resolver = AssetResolver(tmp_path, episode_number=1, scene_reference_kind="render")

    scene_refs, _ = resolver.resolve_all_for_beats(beats)

    for refs in scene_refs.values():
        assert [ref.source_level for ref in refs] == ["base_image"]
        assert refs[0].image_paths == [str(master_path)]


def test_batch_scene_refs_use_derived_scene_master_only(tmp_path: Path) -> None:
    scene_dir = tmp_path / "assets" / "scenes" / "Noodle Shop_Rainy Night"
    master_path = scene_dir / "master.png"
    _touch(master_path)

    beats = [
        {
            "beat_number": 1,
            "scene_ref": {"scene_id": "Noodle Shop_Rainy Night"},
        },
        {
            "beat_number": 2,
            "scene_ref": {"scene_id": "Noodle Shop_Rainy Night"},
        }
    ]
    resolver = AssetResolver(
        tmp_path,
        episode_number=1,
        scene_reference_kind="render",
    )

    scene_refs, _ = resolver.resolve_all_for_beats(beats)

    for refs in scene_refs.values():
        assert [ref.source_level for ref in refs] == ["base_image"]
        assert refs[0].image_paths == [str(master_path)]


def test_scene_refs_resolve_variant_id_to_derived_scene_master(tmp_path: Path) -> None:
    base_path = tmp_path / "assets" / "scenes" / "Noodle Shop" / "master.png"
    derived_path = tmp_path / "assets" / "scenes" / "Noodle Shop_Rainy Night" / "master.png"
    _touch(base_path)
    _touch(derived_path)

    beat = {
        "beat_number": 1,
        "scene_ref": {"scene_id": "Noodle Shop", "variant_id": "Rainy Night"},
    }
    resolver = AssetResolver(tmp_path, episode_number=1, scene_reference_kind="render")

    refs = resolver.resolve_scenes_for_beat(beat)

    assert len(refs) == 1
    assert refs[0].base_id == "Noodle Shop_Rainy Night"
    assert refs[0].image_paths == [str(derived_path)]


def test_sync_beat_asset_refs_preserves_render_anchor_id() -> None:
    beat = {
        "scene_ref": {
            "scene_id": "Noodle Shop_Rainy Night",
            "render_anchor_id": "selected_background",
        }
    }

    sync_beat_asset_refs(beat)

    assert beat["scene_ref"]["scene_id"] == "Noodle Shop_Rainy Night"
    assert "render_anchor_path" not in beat["scene_ref"]
    assert beat["scene_ref"]["render_anchor_id"] == "selected_background"
