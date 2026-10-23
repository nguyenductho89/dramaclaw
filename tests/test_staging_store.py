"""Unit tests for `generators/staging_store.py` — the scene "staging
bible" sidecar. Real files on `tmp_path`, no DB, no network."""

from __future__ import annotations

from novelvideo.generators.staging_store import (
    SceneStaging,
    SetDressingItem,
    get_scene_staging,
    load_episode_staging,
    save_episode_staging,
)


def test_round_trip_save_and_load(tmp_path):
    staging = SceneStaging(
        scene_id="PRESCHOOL PLAYGROUND",
        camera="eye-level medium-wide shot",
        blocking={"Nam": "Nam stands on the left."},
        set_dressing=[
            SetDressingItem(
                prop_id="toy wall",
                placement_note="The toy wall sits between them.",
                persistent=True,
                from_beat=1,
            )
        ],
        scale_note="Both children are toddler height.",
        source="llm",
    )
    save_episode_staging(tmp_path, 1, {"PRESCHOOL PLAYGROUND": staging})

    loaded = load_episode_staging(tmp_path, 1)
    assert set(loaded) == {"PRESCHOOL PLAYGROUND"}
    got = loaded["PRESCHOOL PLAYGROUND"]
    assert got.camera == staging.camera
    assert got.blocking == staging.blocking
    assert len(got.set_dressing) == 1
    assert got.set_dressing[0].prop_id == "toy wall"
    assert got.set_dressing[0].persistent is True
    assert got.set_dressing[0].from_beat == 1
    assert got.scale_note == staging.scale_note
    assert got.source == "llm"


def test_load_missing_sidecar_returns_empty_dict(tmp_path):
    assert load_episode_staging(tmp_path, 1) == {}


def test_load_corrupt_sidecar_returns_empty_dict(tmp_path):
    path = tmp_path / "staging" / "ep001.json"
    path.parent.mkdir(parents=True)
    path.write_text("not json", encoding="utf-8")
    assert load_episode_staging(tmp_path, 1) == {}


def test_get_scene_staging_single_lookup(tmp_path):
    save_episode_staging(
        tmp_path,
        1,
        {
            "A": SceneStaging(scene_id="A", camera="cam A"),
            "B": SceneStaging(scene_id="B", camera="cam B"),
        },
    )
    got = get_scene_staging(tmp_path, 1, "B")
    assert got is not None
    assert got.camera == "cam B"
    assert get_scene_staging(tmp_path, 1, "nonexistent") is None
    assert get_scene_staging(tmp_path, 1, "") is None


def test_persistent_props_as_of_filters_by_persistent_and_from_beat():
    staging = SceneStaging(
        scene_id="A",
        set_dressing=[
            SetDressingItem(prop_id="toy wall", persistent=True, from_beat=1),
            SetDressingItem(prop_id="held toy", persistent=False, from_beat=3),
            SetDressingItem(prop_id="candy box", persistent=True, from_beat=5),
        ],
    )
    assert [i.prop_id for i in staging.persistent_props_as_of(1)] == ["toy wall"]
    assert [i.prop_id for i in staging.persistent_props_as_of(4)] == ["toy wall"]
    assert [i.prop_id for i in staging.persistent_props_as_of(5)] == ["toy wall", "candy box"]


def test_save_overwrites_whole_episode_sidecar(tmp_path):
    save_episode_staging(tmp_path, 1, {"A": SceneStaging(scene_id="A", camera="old")})
    save_episode_staging(tmp_path, 1, {"B": SceneStaging(scene_id="B", camera="new")})
    loaded = load_episode_staging(tmp_path, 1)
    assert set(loaded) == {"B"}


def test_different_episodes_use_different_sidecar_files(tmp_path):
    save_episode_staging(tmp_path, 1, {"A": SceneStaging(scene_id="A", camera="ep1")})
    save_episode_staging(tmp_path, 2, {"A": SceneStaging(scene_id="A", camera="ep2")})
    assert load_episode_staging(tmp_path, 1)["A"].camera == "ep1"
    assert load_episode_staging(tmp_path, 2)["A"].camera == "ep2"
