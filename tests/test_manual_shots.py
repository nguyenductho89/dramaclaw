import pytest

from novelvideo.task_identity import selection_scope


def test_selection_scope_is_order_sensitive():
    assert selection_scope("2x2_2-3_sketch", [1, 41, 2]) != selection_scope(
        "2x2_2-3_sketch",
        [1, 2, 41],
    )


def test_manual_shot_order_helpers_keep_inserted_beat_between_neighbors():
    from novelvideo.manual_shots import sort_beats_for_display

    beats = [
        {"beat_number": 1, "shot_order": 10},
        {"beat_number": 2, "shot_order": 20},
        {"beat_number": 41, "shot_order": 15, "is_manual_shot": True},
    ]

    assert [beat["beat_number"] for beat in sort_beats_for_display(beats)] == [1, 41, 2]


def test_manual_shot_insert_order_uses_integer_slots():
    from novelvideo.manual_shots import calculate_insert_order

    assert calculate_insert_order(None, 10) == 5
    assert calculate_insert_order(None, 2) == 1
    assert calculate_insert_order(None, 1) is None
    assert calculate_insert_order(10, 20) == 15
    assert calculate_insert_order(10, 15) == 12
    assert calculate_insert_order(10, 12) == 11
    assert calculate_insert_order(10, 11) is None


def test_manual_shot_duration_prefers_user_duration_over_audio():
    from novelvideo.manual_shots import resolve_target_video_duration

    beat = {"beat_number": 41, "duration_seconds": 3.0, "is_manual_shot": True}

    assert resolve_target_video_duration(beat, audio_duration=7.5) == 3.0


def test_manual_shot_segments_only_include_missing_manual_sketches(tmp_path):
    from novelvideo.manual_shots import missing_manual_shot_segments

    def _scene(scene_id):
        return {"scene_id": scene_id}

    beats = [
        {"beat_number": 1, "shot_order": 10, "scene_ref": _scene("basement")},
        {"beat_number": 41, "shot_order": 15, "is_manual_shot": True, "scene_ref": _scene("basement")},
        {"beat_number": 44, "shot_order": 17, "is_manual_shot": True, "scene_ref": _scene("town_entrance")},
        {"beat_number": 42, "shot_order": 18, "is_manual_shot": True, "scene_ref": _scene("basement")},
        {"beat_number": 2, "shot_order": 20, "scene_ref": _scene("basement")},
        {"beat_number": 3, "shot_order": 30, "scene_ref": _scene("town_entrance")},
        {"beat_number": 43, "shot_order": 35, "is_manual_shot": True, "scene_ref": _scene("town_entrance")},
        {"beat_number": 4, "shot_order": 40, "scene_ref": _scene("town_entrance")},
    ]
    (tmp_path / "beat_42.png").write_bytes(b"existing")

    segments = missing_manual_shot_segments(beats, tmp_path)

    assert segments == [[41], [44], [43]]


def test_storyboard_manual_sketch_beats_exclude_manual_space_maps():
    from novelvideo.manual_shots import storyboard_beats_for_manual_sketches

    beats = [
        {"beat_number": 1, "visual_description": "ordinary shot"},
        {
            "beat_number": 41,
            "is_manual_shot": True,
            "visual_description": "[space_map] second-floor plan",
        },
        {
            "beat_number": 42,
            "is_manual_shot": True,
            "visual_description": "manually add an expression",
        },
    ]

    assert [beat["beat_number"] for beat in storyboard_beats_for_manual_sketches(beats)] == [
        1,
        42,
    ]


def test_manual_sketch_mode_reuses_normal_sketch_grid_split():
    from novelvideo.generators.nanobanana_grid import sketch_scene_grid_split as sketch_location_grid_split
    from novelvideo.manual_shots import choose_manual_sketch_mode_key

    for count in range(1, 9):
        beats = [
            {"beat_number": idx, "visual_description": f"manual shot {idx}"}
            for idx in range(1, count + 1)
        ]

        assert choose_manual_sketch_mode_key(count) == sketch_location_grid_split(beats)[0][
            "mode_key"
        ]


def test_srt_timing_advances_across_silent_manual_shots():
    from novelvideo.manual_shots import build_subtitle_timing_entries

    beats = [
        {"beat_number": 1, "narration_segment": "first line", "audio_duration": 5.0},
        {
            "beat_number": 41,
            "narration_segment": "",
            "duration_seconds": 3.0,
            "is_manual_shot": True,
        },
        {"beat_number": 2, "narration_segment": "second line", "audio_duration": 4.0},
    ]

    entries = build_subtitle_timing_entries(
        beats,
        duration_lookup=lambda beat: beat.get("audio_duration"),
    )

    assert entries == [
        (1, 0.0, 5.0, "first line"),
        (2, 8.0, 12.0, "second line"),
    ]


def test_video_prereqs_allow_manual_shot_without_audio():
    from novelvideo.manual_shots import split_video_generation_prereqs

    beats = [
        {"beat_number": 1},
        {"beat_number": 41, "is_manual_shot": True, "audio_type": "silence"},
        {"beat_number": 2},
    ]
    statuses = {
        1: {"frame_exists": True, "audio_exists": True},
        41: {"frame_exists": True, "audio_exists": False},
        2: {"frame_exists": True, "audio_exists": False},
    }

    ready, missing_frames, missing_audio = split_video_generation_prereqs(
        beats,
        status_lookup=lambda beat_num: statuses[beat_num],
    )

    assert [beat["beat_number"] for beat in ready] == [1, 41]
    assert missing_frames == []
    assert missing_audio == [2]


def test_video_prereqs_require_audio_for_manual_narration_and_dialogue():
    from novelvideo.manual_shots import split_video_generation_prereqs

    beats = [
        {"beat_number": 41, "is_manual_shot": True, "audio_type": "narration"},
        {"beat_number": 42, "is_manual_shot": True, "audio_type": "dialogue"},
        {"beat_number": 43, "is_manual_shot": True, "audio_type": "silence"},
    ]
    statuses = {
        41: {"frame_exists": True, "audio_exists": False},
        42: {"frame_exists": True, "audio_exists": False},
        43: {"frame_exists": True, "audio_exists": False},
    }

    ready, missing_frames, missing_audio = split_video_generation_prereqs(
        beats,
        status_lookup=lambda beat_num: statuses[beat_num],
    )

    assert [beat["beat_number"] for beat in ready] == [43]
    assert missing_frames == []
    assert missing_audio == [41, 42]


def test_video_prereqs_allow_silence_and_legacy_action_without_audio():
    from novelvideo.manual_shots import split_video_generation_prereqs

    beats = [
        {"beat_number": 1, "audio_type": "silence"},
        {"beat_number": 2, "audio_type": "action"},
        {"beat_number": 3, "audio_type": "narration"},
    ]
    statuses = {
        1: {"frame_exists": True, "audio_exists": False},
        2: {"frame_exists": True, "audio_exists": False},
        3: {"frame_exists": True, "audio_exists": False},
    }

    ready, missing_frames, missing_audio = split_video_generation_prereqs(
        beats,
        status_lookup=lambda beat_num: statuses[beat_num],
    )

    assert [beat["beat_number"] for beat in ready] == [1, 2]
    assert missing_frames == []
    assert missing_audio == [3]


@pytest.mark.asyncio
async def test_sqlite_manual_shot_fields_roundtrip_and_sort(tmp_path):
    from novelvideo.models import NovelEpisode, NovelVisualBeat
    from novelvideo.sqlite_store import SQLiteStore

    project_dir = tmp_path / "user" / "project"
    project_dir.mkdir(parents=True)
    store = SQLiteStore("user/project", output_dir=str(project_dir), state_dir=str(project_dir))
    await store._ensure_db()
    await store.add_episodes([NovelEpisode(number=1, title="Episode One")])

    await store.add_visual_beats(
        [
            NovelVisualBeat(
                beat_number=1,
                episode_number=1,
                narration="first line",
                visual_description="A",
            ),
            NovelVisualBeat(
                beat_number=2,
                episode_number=1,
                narration="second line",
                visual_description="B",
            ),
            NovelVisualBeat(
                beat_number=41,
                episode_number=1,
                narration="",
                visual_description="manually add an eye close-up",
                shot_order=15,
                duration_seconds=3.0,
                is_manual_shot=True,
            ),
        ]
    )

    beats = await store.get_beats_as_dicts(1)

    assert [beat["beat_number"] for beat in beats] == [1, 41, 2]
    manual = beats[1]
    assert manual["narration_segment"] == ""
    assert manual["shot_order"] == 15
    assert manual["duration_seconds"] == 3.0
    assert manual["is_manual_shot"] is True


@pytest.mark.skip(reason="v2.0: location/set_description/dump_set_description do not exist; replaced by scene_ref")
@pytest.mark.asyncio
async def test_insert_manual_shot_inherits_previous_scene_and_uses_new_asset_id(tmp_path):
    from novelvideo.manual_shots import insert_manual_shot
    from novelvideo.models import NovelEpisode, NovelVisualBeat, dump_set_description
    from novelvideo.sqlite_store import SQLiteStore

    project_dir = tmp_path / "user" / "project"
    project_dir.mkdir(parents=True)
    store = SQLiteStore("user/project", output_dir=str(project_dir), state_dir=str(project_dir))
    await store._ensure_db()
    await store.add_episodes([NovelEpisode(number=1, title="Episode One")])
    await store.add_visual_beats(
        [
            NovelVisualBeat(
                beat_number=1,
                episode_number=1,
                narration="first line",
                visual_description="A",
                location="palace_gate",
                location_description="vermilion palace gate",
                time_of_day="dusk",
                set_description=dump_set_description("cold damp stone steps", "jade_pendant"),
            ),
            NovelVisualBeat(
                beat_number=2,
                episode_number=1,
                narration="second line",
                visual_description="B",
                location="palace_gate",
                location_description="vermilion palace gate",
                time_of_day="night",
            ),
        ]
    )

    new_beat = await insert_manual_shot(
        store,
        episode_number=1,
        after_beat_number=1,
        visual_description="Su Qingrou looks up",
        duration_seconds=3.0,
    )
    beats = await store.get_beats_as_dicts(1)

    assert new_beat["beat_number"] == 3
    assert new_beat["shot_order"] == 15
    assert [beat["beat_number"] for beat in beats] == [1, 3, 2]
    assert beats[1]["narration_segment"] == ""
    assert beats[1]["is_manual_shot"] is True
    assert beats[1]["location"] == "palace_gate"
    assert beats[1]["location_description"] == "vermilion palace gate"
    assert beats[1]["time_of_day"] == "dusk"
    assert beats[1]["set_description"] == dump_set_description("cold damp stone steps", "jade_pendant")


@pytest.mark.skip(reason="v2.0: location/set_description/dump_set_description do not exist; replaced by scene_ref")
@pytest.mark.asyncio
async def test_insert_manual_shot_accepts_dialog_defaults_and_overrides(tmp_path):
    from novelvideo.manual_shots import insert_manual_shot
    from novelvideo.models import NovelEpisode, NovelVisualBeat, dump_set_description
    from novelvideo.sqlite_store import SQLiteStore

    project_dir = tmp_path / "user" / "project"
    project_dir.mkdir(parents=True)
    store = SQLiteStore("user/project", output_dir=str(project_dir), state_dir=str(project_dir))
    await store._ensure_db()
    await store.add_episodes([NovelEpisode(number=1, title="Episode One")])
    await store.add_visual_beats(
        [
            NovelVisualBeat(
                beat_number=1,
                episode_number=1,
                narration="first line",
                visual_description="A",
                location="basement",
                time_of_day="night",
            ),
            NovelVisualBeat(
                beat_number=2,
                episode_number=1,
                narration="second line",
                visual_description="B",
            ),
        ]
    )

    await insert_manual_shot(
        store,
        episode_number=1,
        after_beat_number=1,
        visual_description="manually add a medium close-up",
        duration_seconds=4.0,
        location="study",
        location_description="",
        time_of_day="dawn",
        set_description=dump_set_description("wooden study", "old books"),
        detected_identities=["SuQingrou_daily"],
    )

    beats = await store.get_beats_as_dicts(1)
    manual = beats[1]

    assert manual["beat_number"] == 3
    assert manual["narration_segment"] == ""
    assert manual["duration_seconds"] == 4.0
    assert manual["location"] == "study"
    assert manual["time_of_day"] == "dawn"
    assert manual["set_description"] == dump_set_description("wooden study", "old books")
    assert manual["detected_identities"] == ["SuQingrou_daily"]


@pytest.mark.asyncio
async def test_insert_manual_shot_derives_identities_from_own_visual_description(tmp_path):
    from novelvideo.manual_shots import insert_manual_shot
    from novelvideo.models import NovelEpisode, NovelVisualBeat
    from novelvideo.sqlite_store import SQLiteStore

    project_dir = tmp_path / "user" / "project"
    project_dir.mkdir(parents=True)
    store = SQLiteStore("user/project", output_dir=str(project_dir), state_dir=str(project_dir))
    await store._ensure_db()
    await store.add_episodes([NovelEpisode(number=1, title="Episode One")])
    await store.add_visual_beats(
        [
            NovelVisualBeat(
                beat_number=1,
                episode_number=1,
                narration="Grandpa Wang hits the brakes",
                visual_description="{{GrandpaWang_townsfolk}} steadies the tricycle",
                detected_identities_json='["GrandpaWang_townsfolk"]',
            ),
            NovelVisualBeat(
                beat_number=2,
                episode_number=1,
                narration="News arrives from the hospital",
                visual_description="The atmosphere in the ward is oppressive",
            ),
        ]
    )

    await insert_manual_shot(
        store,
        episode_number=1,
        after_beat_number=1,
        visual_description="{{LuChen_bookstore_owner}} looks down at the mechanical watch",
    )

    beats = await store.get_beats_as_dicts(1)
    manual = beats[1]

    assert manual["detected_identities"] == ["LuChen_bookstore_owner"]


@pytest.mark.asyncio
async def test_insert_manual_shot_persists_explicit_detected_props(tmp_path):
    from novelvideo.manual_shots import insert_manual_shot
    from novelvideo.models import NovelEpisode, NovelVisualBeat
    from novelvideo.sqlite_store import SQLiteStore

    project_dir = tmp_path / "user" / "project"
    project_dir.mkdir(parents=True)
    store = SQLiteStore("user/project", output_dir=str(project_dir), state_dir=str(project_dir))
    await store._ensure_db()
    await store.add_episodes([NovelEpisode(number=1, title="Episode One")])
    await store.add_visual_beats(
        [
            NovelVisualBeat(
                beat_number=1,
                episode_number=1,
                narration="first line",
                visual_description="{{LuChen_young_adult}} stands in the warehouse",
            ),
            NovelVisualBeat(
                beat_number=2,
                episode_number=1,
                narration="second line",
                visual_description="The warehouse door closes",
            ),
        ]
    )

    new_beat = await insert_manual_shot(
        store,
        episode_number=1,
        after_beat_number=1,
        visual_description="{{LuChen_young_adult}} picks up [[jade_pendant]]",
        detected_props=["jade_pendant", "voice_recorder"],
    )

    assert new_beat["detected_props"] == ["jade_pendant", "voice_recorder"]


@pytest.mark.asyncio
async def test_insert_manual_shot_derives_props_from_visual_description_markers(tmp_path):
    from novelvideo.manual_shots import insert_manual_shot
    from novelvideo.models import NovelEpisode, NovelVisualBeat
    from novelvideo.sqlite_store import SQLiteStore

    project_dir = tmp_path / "user" / "project"
    project_dir.mkdir(parents=True)
    store = SQLiteStore("user/project", output_dir=str(project_dir), state_dir=str(project_dir))
    await store._ensure_db()
    await store.add_episodes([NovelEpisode(number=1, title="Episode One")])
    await store.add_visual_beats(
        [
            NovelVisualBeat(
                beat_number=1,
                episode_number=1,
                narration="first line",
                visual_description="[[voice_recorder]] lies on the table",
            ),
            NovelVisualBeat(
                beat_number=2,
                episode_number=1,
                narration="second line",
                visual_description="The lights go out",
            ),
        ]
    )

    new_beat = await insert_manual_shot(
        store,
        episode_number=1,
        after_beat_number=1,
        visual_description="An empty shot sweeps over [[voice_recorder]] and [[jade_pendant]], then returns to [[voice_recorder]]",
    )

    assert new_beat["detected_props"] == ["voice_recorder", "jade_pendant"]


@pytest.mark.asyncio
async def test_insert_manual_shot_accepts_scene_ref_and_optional_narration(tmp_path):
    from novelvideo.manual_shots import insert_manual_shot
    from novelvideo.models import NovelEpisode, NovelVisualBeat
    from novelvideo.sqlite_store import SQLiteStore

    project_dir = tmp_path / "user" / "project"
    project_dir.mkdir(parents=True)
    store = SQLiteStore("user/project", output_dir=str(project_dir), state_dir=str(project_dir))
    await store._ensure_db()
    await store.add_episodes([NovelEpisode(number=1, title="Episode One")])
    await store.add_visual_beats(
        [
            NovelVisualBeat(
                beat_number=1,
                episode_number=1,
                narration="first line",
                visual_description="A",
            ),
            NovelVisualBeat(
                beat_number=2,
                episode_number=1,
                narration="second line",
                visual_description="B",
            ),
        ]
    )

    await insert_manual_shot(
        store,
        episode_number=1,
        after_beat_number=1,
        visual_description="manually add an insert shot",
        scene_ref={"scene_id": "lanzhou_noodle_shop_night"},
        audio_type="narration",
        narration_segment="insert shot narration",
    )

    beats = await store.get_beats_as_dicts(1)
    manual = beats[1]

    assert manual["narration_segment"] == "insert shot narration"
    assert manual["scene_ref"]["scene_id"] == "lanzhou_noodle_shop_night"


@pytest.mark.asyncio
async def test_insert_manual_shot_persists_audio_type_and_speaker(tmp_path):
    from novelvideo.manual_shots import insert_manual_shot
    from novelvideo.models import NovelEpisode, NovelVisualBeat
    from novelvideo.sqlite_store import SQLiteStore

    project_dir = tmp_path / "user" / "project"
    project_dir.mkdir(parents=True)
    store = SQLiteStore("user/project", output_dir=str(project_dir), state_dir=str(project_dir))
    await store._ensure_db()
    await store.add_episodes([NovelEpisode(number=1, title="Episode One")])
    await store.add_visual_beats(
        [
            NovelVisualBeat(
                beat_number=1,
                episode_number=1,
                narration="first line",
                visual_description="A",
            ),
            NovelVisualBeat(
                beat_number=2,
                episode_number=1,
                narration="second line",
                visual_description="B",
            ),
        ]
    )

    await insert_manual_shot(
        store,
        episode_number=1,
        after_beat_number=1,
        visual_description="Xie Zheng looks up and speaks",
        audio_type="dialogue",
        speaker="XieZheng_young_adult",
        narration_segment="Go.",
    )

    beats = await store.get_beats_as_dicts(1)
    manual = beats[1]

    assert manual["is_manual_shot"] is True
    assert manual["audio_type"] == "dialogue"
    assert manual["speaker"] == "XieZheng_young_adult"
    assert manual["narration_segment"] == "Go."


@pytest.mark.asyncio
async def test_insert_manual_shot_accepts_dialogue_without_speaker(tmp_path):
    from novelvideo.manual_shots import insert_manual_shot
    from novelvideo.models import NovelEpisode, NovelVisualBeat
    from novelvideo.sqlite_store import SQLiteStore

    project_dir = tmp_path / "user" / "project"
    project_dir.mkdir(parents=True)
    store = SQLiteStore("user/project", output_dir=str(project_dir), state_dir=str(project_dir))
    await store._ensure_db()
    await store.add_episodes([NovelEpisode(number=1, title="Episode One")])
    await store.add_visual_beats(
        [
            NovelVisualBeat(
                beat_number=1,
                episode_number=1,
                narration="first line",
                visual_description="A",
            ),
            NovelVisualBeat(
                beat_number=2,
                episode_number=1,
                narration="second line",
                visual_description="B",
            ),
        ]
    )

    await insert_manual_shot(
        store,
        episode_number=1,
        after_beat_number=1,
        visual_description="Lu Chen looks back at the warehouse door",
        audio_type="dialogue",
        speaker=None,
        narration_segment="Do not look back.",
    )

    beats = await store.get_beats_as_dicts(1)
    manual = beats[1]

    assert manual["is_manual_shot"] is True
    assert manual["audio_type"] == "dialogue"
    assert manual["speaker"] == ""
    assert manual["narration_segment"] == "Do not look back."


@pytest.mark.asyncio
async def test_insert_manual_shot_at_front_allocates_order_before_first_beat(tmp_path):
    from novelvideo.manual_shots import insert_manual_shot
    from novelvideo.models import NovelEpisode, NovelVisualBeat
    from novelvideo.sqlite_store import SQLiteStore

    project_dir = tmp_path / "user" / "project"
    project_dir.mkdir(parents=True)
    store = SQLiteStore("user/project", output_dir=str(project_dir), state_dir=str(project_dir))
    await store._ensure_db()
    await store.add_episodes([NovelEpisode(number=1, title="Episode One")])
    await store.add_visual_beats(
        [
            NovelVisualBeat(
                beat_number=1,
                episode_number=1,
                narration="first line",
                visual_description="A",
                shot_order=10,
            ),
            NovelVisualBeat(
                beat_number=2,
                episode_number=1,
                narration="second line",
                visual_description="B",
                shot_order=20,
            ),
        ]
    )

    new_beat = await insert_manual_shot(
        store,
        episode_number=1,
        after_beat_number=None,
        visual_description="manually add an establishing empty shot at the opening",
        duration_seconds=3.0,
    )
    beats = await store.get_beats_as_dicts(1)

    assert new_beat["shot_order"] == 5
    assert [beat["beat_number"] for beat in beats] == [3, 1, 2]


@pytest.mark.asyncio
async def test_insert_manual_shot_does_not_reuse_existing_asset_number(tmp_path):
    from novelvideo.manual_shots import insert_manual_shot
    from novelvideo.models import NovelEpisode, NovelVisualBeat
    from novelvideo.sqlite_store import SQLiteStore

    project_dir = tmp_path / "user" / "project"
    project_dir.mkdir(parents=True)
    (project_dir / "sketches" / "ep001").mkdir(parents=True)
    (project_dir / "sketches" / "ep001" / "beat_03.png").write_bytes(b"stale")
    store = SQLiteStore("user/project", output_dir=str(project_dir), state_dir=str(project_dir))
    await store._ensure_db()
    await store.add_episodes([NovelEpisode(number=1, title="Episode One")])
    await store.add_visual_beats(
        [
            NovelVisualBeat(
                beat_number=1,
                episode_number=1,
                narration="first line",
                visual_description="A",
            ),
            NovelVisualBeat(
                beat_number=2,
                episode_number=1,
                narration="second line",
                visual_description="B",
            ),
        ]
    )

    new_beat = await insert_manual_shot(
        store,
        episode_number=1,
        after_beat_number=1,
        visual_description="manually add a shot",
        duration_seconds=3.0,
    )

    assert new_beat["beat_number"] == 4


@pytest.mark.asyncio
async def test_delete_manual_shot_removes_only_manual_beat(tmp_path):
    from novelvideo.manual_shots import delete_manual_shot
    from novelvideo.models import NovelEpisode, NovelVisualBeat
    from novelvideo.sqlite_store import SQLiteStore

    project_dir = tmp_path / "user" / "project"
    project_dir.mkdir(parents=True)
    store = SQLiteStore("user/project", output_dir=str(project_dir), state_dir=str(project_dir))
    await store._ensure_db()
    await store.add_episodes([NovelEpisode(number=1, title="Episode One")])
    await store.add_visual_beats(
        [
            NovelVisualBeat(
                beat_number=1,
                episode_number=1,
                narration="first line",
                visual_description="A",
                shot_order=10,
            ),
            NovelVisualBeat(
                beat_number=41,
                episode_number=1,
                narration="",
                visual_description="manually add a shot",
                shot_order=15,
                duration_seconds=3.0,
                is_manual_shot=True,
            ),
            NovelVisualBeat(
                beat_number=2,
                episode_number=1,
                narration="second line",
                visual_description="B",
                shot_order=20,
            ),
        ]
    )

    refreshed = await delete_manual_shot(store, episode_number=1, beat_number=41)

    assert [beat["beat_number"] for beat in refreshed] == [1, 2]
    assert [beat["beat_number"] for beat in await store.get_beats_as_dicts(1)] == [1, 2]


@pytest.mark.asyncio
async def test_delete_manual_shot_rejects_normal_beat(tmp_path):
    from novelvideo.manual_shots import delete_manual_shot
    from novelvideo.models import NovelEpisode, NovelVisualBeat
    from novelvideo.sqlite_store import SQLiteStore

    project_dir = tmp_path / "user" / "project"
    project_dir.mkdir(parents=True)
    store = SQLiteStore("user/project", output_dir=str(project_dir), state_dir=str(project_dir))
    await store._ensure_db()
    await store.add_episodes([NovelEpisode(number=1, title="Episode One")])
    await store.add_visual_beats(
        [
            NovelVisualBeat(
                beat_number=1,
                episode_number=1,
                narration="first line",
                visual_description="A",
                shot_order=10,
            ),
            NovelVisualBeat(
                beat_number=2,
                episode_number=1,
                narration="second line",
                visual_description="B",
                shot_order=20,
            ),
        ]
    )

    with pytest.raises(ValueError, match="Only manual shots"):
        await delete_manual_shot(store, episode_number=1, beat_number=1)

    assert [beat["beat_number"] for beat in await store.get_beats_as_dicts(1)] == [1, 2]


@pytest.mark.skip(reason="v2.0: the SketchModeStrategy prompt template was rewritten; the feature-branch assertions no longer apply")
def test_sketch_prompt_treats_manual_panels_as_normal_visual_descriptions():
    from novelvideo.generators.prompt_builder import (
        GridConfig,
        PromptComponents,
        PromptContext,
        PromptMode,
        SketchModeStrategy,
        StyleConfig,
    )

    ctx = PromptContext(
        grid=GridConfig(rows=1, cols=2, aspect_ratio="4:3"),
        characters={},
        style=StyleConfig(style_keywords="test", avoid_keywords=""),
        beats=[
            {"beat_number": 1, "visual_description": "ordinary frame"},
            {
                "beat_number": 41,
                "visual_description": "manually add a gaze",
                "is_manual_shot": True,
            },
        ],
        mode=PromptMode.SKETCH,
    )

    prompt = SketchModeStrategy().build(ctx, PromptComponents())

    assert "Read each panel's scene description, then DIRECT the shot yourself" in prompt
    assert "Panel 1**: ordinary frame" in prompt
    assert "Panel 1** [MANDATORY SHOT DIRECTIVE]" not in prompt
    assert "Panel 2** [MANDATORY SHOT DIRECTIVE]" not in prompt
    assert "Panel 2**: manually add a gaze" in prompt
    assert "DIRECT the shot yourself" in prompt
