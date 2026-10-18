import struct
from pathlib import Path

import pytest

from novelvideo.models import CharacterIdentity, NovelCharacter
from novelvideo.seedance2_i2v.models import Seedance2I2VMode


pytestmark = pytest.mark.m09


def _write_png(path: Path, *, width: int = 512, height: int = 768) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    header = b"\x89PNG\r\n\x1a\n"
    ihdr = b"IHDR" + struct.pack(">II", width, height) + b"\x08\x02\x00\x00\x00"
    path.write_bytes(header + struct.pack(">I", len(ihdr) - 4) + ihdr)


def test_multimodal_assets_use_scene_ref_identity_and_audio(tmp_path, monkeypatch):
    from novelvideo import project_config as pc
    from novelvideo.seedance2_i2v.assets import (
        build_seedance2_project_assets,
        selected_reference_paths,
    )

    monkeypatch.setattr(pc, "OUTPUT_DIR", tmp_path / "state")
    project_dir = tmp_path / "output" / "alice" / "project"
    frame = project_dir / "frames" / "ep001" / "beat_01.png"
    identity = project_dir / "assets" / "characters" / "Qin" / "identities" / "young.png"
    scene = project_dir / "assets" / "scenes" / "living_room_night" / "master.png"
    audio = project_dir / "assets" / "narrator" / "voice.mp3"
    for image_path in (frame, identity, scene):
        _write_png(image_path)
    audio.parent.mkdir(parents=True)
    audio.write_bytes(b"audio")
    pc.set_narrator_reference_audio(
        "alice",
        "project",
        relative_path="assets/narrator/voice.mp3",
        sha256="sha",
        updated_at="2026-05-14T00:00:00+00:00",
    )

    assets = build_seedance2_project_assets(
        project_output=project_dir,
        state_dir=tmp_path / "state" / "alice" / "project",
        episode=1,
        beat={
            "beat_number": 1,
            "detected_identities": ["Qin_young"],
            "scene_ref": {"scene_id": "living_room_night"},
            "location": "legacy scene field must not take priority",
        },
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
    )

    assert selected_reference_paths(assets, "reference_images") == [
        str(frame),
        str(identity),
        str(scene),
    ]
    assert selected_reference_paths(assets, "reference_audios") == [str(audio)]
    scene_asset = next(asset for asset in assets if asset.key == "scene:living_room_night")
    assert scene_asset.path == scene
    assert scene_asset.selected is True


def test_multimodal_assets_resolve_scene_variant_to_derived_scene_master(tmp_path):
    from novelvideo.seedance2_i2v.assets import (
        build_seedance2_project_assets,
        selected_reference_paths,
    )

    project_dir = tmp_path / "output" / "alice" / "project"
    frame = project_dir / "frames" / "ep001" / "beat_01.png"
    base_scene = project_dir / "assets" / "scenes" / "living_room" / "master.png"
    derived_scene = project_dir / "assets" / "scenes" / "living_room_leak" / "master.png"
    for image_path in (frame, base_scene, derived_scene):
        _write_png(image_path)

    assets = build_seedance2_project_assets(
        project_output=project_dir,
        state_dir=tmp_path / "state" / "alice" / "project",
        episode=1,
        beat={
            "beat_number": 1,
            "scene_ref": {"scene_id": "living_room", "variant_id": "leak"},
        },
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
    )

    assert selected_reference_paths(assets, "reference_images") == [
        str(frame),
        str(derived_scene),
    ]
    scene_asset = next(asset for asset in assets if asset.key.startswith("scene:"))
    assert scene_asset.key == "scene:living_room_leak"
    assert scene_asset.label == "Scene anchor · living_room_leak"


def test_multimodal_assets_resolve_time_of_day_to_time_plate(tmp_path):
    from novelvideo.seedance2_i2v.assets import (
        build_seedance2_project_assets,
        selected_reference_paths,
    )

    project_dir = tmp_path / "output" / "alice" / "project"
    frame = project_dir / "frames" / "ep001" / "beat_01.png"
    base_scene = project_dir / "assets" / "scenes" / "living_room" / "master.png"
    night_scene = project_dir / "assets" / "scenes" / "living_room_night" / "master.png"
    for image_path in (frame, base_scene, night_scene):
        _write_png(image_path)

    assets = build_seedance2_project_assets(
        project_output=project_dir,
        state_dir=tmp_path / "state" / "alice" / "project",
        episode=1,
        beat={
            "beat_number": 1,
            "scene_ref": {"scene_id": "living_room"},
            "time_of_day": "night",
        },
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
    )

    assert selected_reference_paths(assets, "reference_images") == [
        str(frame),
        str(night_scene),
    ]
    scene_asset = next(asset for asset in assets if asset.key.startswith("scene:"))
    assert scene_asset.key == "scene:living_room_night"
    assert scene_asset.label == "Scene anchor · living_room_night"


def test_multimodal_assets_resolve_variant_time_to_variant_time_plate(tmp_path):
    from novelvideo.seedance2_i2v.assets import (
        build_seedance2_project_assets,
        selected_reference_paths,
    )

    project_dir = tmp_path / "output" / "alice" / "project"
    frame = project_dir / "frames" / "ep001" / "beat_01.png"
    base_scene = project_dir / "assets" / "scenes" / "living_room" / "master.png"
    base_night_scene = project_dir / "assets" / "scenes" / "living_room_night" / "master.png"
    variant_scene = project_dir / "assets" / "scenes" / "living_room_leak" / "master.png"
    variant_night_scene = project_dir / "assets" / "scenes" / "living_room_leak_night" / "master.png"
    for image_path in (frame, base_scene, base_night_scene, variant_scene, variant_night_scene):
        _write_png(image_path)

    assets = build_seedance2_project_assets(
        project_output=project_dir,
        state_dir=tmp_path / "state" / "alice" / "project",
        episode=1,
        beat={
            "beat_number": 1,
            "scene_ref": {"scene_id": "living_room", "variant_id": "leak"},
            "time_of_day": "night",
        },
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
    )

    assert selected_reference_paths(assets, "reference_images") == [
        str(frame),
        str(variant_night_scene),
    ]
    scene_asset = next(asset for asset in assets if asset.key.startswith("scene:"))
    assert scene_asset.key == "scene:living_room_leak_night"
    assert scene_asset.label == "Scene anchor · living_room_leak_night"


def test_multimodal_assets_fall_back_to_base_scene_master_when_variant_image_missing(
    tmp_path,
):
    from novelvideo.seedance2_i2v.assets import (
        build_seedance2_project_assets,
        selected_reference_paths,
    )

    project_dir = tmp_path / "output" / "alice" / "project"
    frame = project_dir / "frames" / "ep001" / "beat_01.png"
    base_scene = project_dir / "assets" / "scenes" / "living_room" / "master.png"
    derived_scene_dir = project_dir / "assets" / "scenes" / "living_room_leak"
    derived_scene_dir.mkdir(parents=True)
    for image_path in (frame, base_scene):
        _write_png(image_path)

    assets = build_seedance2_project_assets(
        project_output=project_dir,
        state_dir=tmp_path / "state" / "alice" / "project",
        episode=1,
        beat={
            "beat_number": 1,
            "scene_ref": {"scene_id": "living_room", "variant_id": "leak"},
        },
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
    )

    assert selected_reference_paths(assets, "reference_images") == [
        str(frame),
        str(base_scene),
    ]
    scene_asset = next(asset for asset in assets if asset.key.startswith("scene:"))
    assert scene_asset.key == "scene:living_room"
    assert scene_asset.label == "Scene anchor · living_room"
    assert scene_asset.path == base_scene


async def test_prepare_seedance2_generation_inputs_preserves_config_duration(tmp_path):
    from novelvideo.seedance2_i2v.models import dump_seedance2_config
    from novelvideo.seedance2_i2v.pipeline import prepare_seedance2_generation_inputs

    project_dir = tmp_path / "output" / "alice" / "project"
    frame = project_dir / "frames" / "ep001" / "beat_01.png"
    _write_png(frame)

    prepared = await prepare_seedance2_generation_inputs(
        project_output=project_dir,
        state_dir=tmp_path / "state" / "alice" / "project",
        episode=1,
        beat={
            "beat_number": 1,
            "seedance2_config_json": dump_seedance2_config(
                {
                    "mode": Seedance2I2VMode.FIRST_FRAME.value,
                    "duration": 8,
                    "final_prompt": "Generate the video with reference to image1.",
                }
            ),
        },
        video_mode="first_frame",
        prompt="old prompt",
        duration=4,
        resolution=None,
        ratio=None,
    )

    assert prepared.duration == 8
    assert '"duration":8' in prepared.seedance2_config_json


def test_multimodal_assets_merge_detected_identities_with_visual_markers(tmp_path):
    from novelvideo.seedance2_i2v.assets import build_seedance2_project_assets

    project_dir = tmp_path / "project"
    assets = build_seedance2_project_assets(
        project_output=project_dir,
        state_dir=tmp_path / "state" / "alice" / "project",
        episode=1,
        beat={
            "beat_number": 29,
            "visual_description": "{{ShenYuebai_young_adult}} stares at {{Luchen_young_adult}}.",
            "detected_identities": ["ShenYuebai_young_adult"],
        },
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
    )

    identity_keys = [asset.key for asset in assets if asset.key.startswith("identity:")]
    assert identity_keys == [
        "identity:ShenYuebai_young_adult",
        "identity:Luchen_young_adult",
    ]


def test_multimodal_dialogue_assets_use_character_voice_reference_not_beat_audio(tmp_path):
    from novelvideo.seedance2_i2v.assets import (
        build_seedance2_project_assets,
        selected_reference_paths,
    )

    project_dir = tmp_path / "project"
    frame = project_dir / "frames" / "ep001" / "beat_01.png"
    identity_image = (
        project_dir / "assets" / "characters" / "NoodleGuy" / "identities" / "young_adult.png"
    )
    scene = project_dir / "assets" / "scenes" / "noodle_shop" / "master.png"
    voice = project_dir / "assets" / "characters" / "NoodleGuy" / "voices" / "voice_default.mp3"
    stale_beat_audio = project_dir / "audio" / "ep001" / "beat_01.mp3"
    for image_path in (frame, identity_image, scene):
        _write_png(image_path)
    voice.parent.mkdir(parents=True)
    voice.write_bytes(b"voice")
    stale_beat_audio.parent.mkdir(parents=True)
    stale_beat_audio.write_bytes(b"stale generated beat audio")
    character = NovelCharacter(
        name="NoodleGuy",
        reference_audio_path="assets/characters/NoodleGuy/voices/voice_default.mp3",
    )
    character.identities = [
        CharacterIdentity(
            identity_id="NoodleGuy_young_adult",
            character_name="NoodleGuy",
            identity_name="young_adult",
        )
    ]

    assets = build_seedance2_project_assets(
        project_output=project_dir,
        state_dir=tmp_path / "state" / "alice" / "project",
        episode=1,
        beat={
            "beat_number": 1,
            "audio_type": "dialogue",
            "speaker": "NoodleGuy_young_adult",
            "detected_identities": ["NoodleGuy_young_adult"],
            "scene_ref": {"scene_id": "noodle_shop"},
            "narration_segment": "NoodleGuy(looking surprised):Is everything fine now?",
        },
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        characters=[character],
    )

    assert selected_reference_paths(assets, "reference_audios") == [str(voice)]
    audio_asset = next(asset for asset in assets if asset.media_type == "audio")
    assert audio_asset.key == "voice:NoodleGuy_young_adult"
    assert audio_asset.identity_id == "NoodleGuy_young_adult"
    assert audio_asset.label == "NoodleGuy · young_adult voice"


def test_multimodal_dialogue_assets_follow_multi_speaker_text_order(tmp_path):
    from novelvideo.seedance2_i2v.assets import (
        build_seedance2_project_assets,
        selected_reference_paths,
    )

    project_dir = tmp_path / "project"
    _write_png(project_dir / "frames" / "ep001" / "beat_01.png")
    _write_png(project_dir / "assets" / "scenes" / "noodle_shop" / "master.png")
    man_voice = (
        project_dir / "assets" / "characters" / "NoodleGuy" / "voices" / "voice_default.mp3"
    )
    woman_voice = (
        project_dir / "assets" / "characters" / "NoodleGirl" / "voices" / "voice_default.mp3"
    )
    for path in (man_voice, woman_voice):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(path.name.encode())
    man = NovelCharacter(
        name="NoodleGuy",
        reference_audio_path="assets/characters/NoodleGuy/voices/voice_default.mp3",
    )
    woman = NovelCharacter(
        name="NoodleGirl",
        reference_audio_path="assets/characters/NoodleGirl/voices/voice_default.mp3",
    )

    assets = build_seedance2_project_assets(
        project_output=project_dir,
        state_dir=tmp_path / "state" / "alice" / "project",
        episode=1,
        beat={
            "beat_number": 1,
            "audio_type": "dialogue",
            "scene_ref": {"scene_id": "noodle_shop"},
            "narration_segment": (
                "NoodleGuy(opens the can):Is everything fine now?" "NoodleGirl(looks up):Do you know Du Chen?"
            ),
        },
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        characters=[woman, man],
    )

    assert selected_reference_paths(assets, "reference_audios") == [
        str(man_voice),
        str(woman_voice),
    ]


def test_multimodal_narration_assets_use_project_narrator_voice_not_beat_audio(
    tmp_path, monkeypatch
):
    from novelvideo import project_config as pc
    from novelvideo.seedance2_i2v.assets import (
        build_seedance2_project_assets,
        selected_reference_paths,
    )

    monkeypatch.setattr(pc, "OUTPUT_DIR", tmp_path / "state")
    project_dir = tmp_path / "output" / "alice" / "project"
    _write_png(project_dir / "frames" / "ep001" / "beat_01.png")
    _write_png(project_dir / "assets" / "scenes" / "noodle_shop" / "master.png")
    narrator_voice = project_dir / "assets" / "narrator" / "voice.mp3"
    narrator_voice.parent.mkdir(parents=True, exist_ok=True)
    narrator_voice.write_bytes(b"narrator voice")
    stale_beat_audio = project_dir / "audio" / "ep001" / "beat_01.mp3"
    stale_beat_audio.parent.mkdir(parents=True)
    stale_beat_audio.write_bytes(b"stale generated beat audio")
    pc.set_narrator_reference_audio(
        "alice",
        "project",
        relative_path="assets/narrator/voice.mp3",
        sha256="sha",
        updated_at="2026-05-14T00:00:00+00:00",
    )

    assets = build_seedance2_project_assets(
        project_output=project_dir,
        state_dir=tmp_path / "state" / "alice" / "project",
        episode=1,
        beat={
            "beat_number": 1,
            "audio_type": "narration",
            "scene_ref": {"scene_id": "noodle_shop"},
            "narration_segment": "The noodle shop still has its lights on in the night.",
        },
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
    )

    assert selected_reference_paths(assets, "reference_audios") == [str(narrator_voice)]
    audio_asset = next(asset for asset in assets if asset.media_type == "audio")
    assert audio_asset.key == "voice:narrator"
    assert audio_asset.identity_id == "__narrator__"
    assert audio_asset.label == "Project narrator voice"


def test_multimodal_narration_keeps_project_narrator_mentionable_when_duration_needs_trim(
    tmp_path, monkeypatch
):
    from novelvideo import project_config as pc
    from novelvideo.seedance2_i2v import assets as asset_mod
    from novelvideo.seedance2_i2v.assets import (
        build_seedance2_project_assets,
        selected_reference_paths,
    )

    monkeypatch.setattr(pc, "OUTPUT_DIR", tmp_path / "state")
    monkeypatch.setattr(asset_mod, "probe_voice_sample_duration_seconds", lambda _path: 12.0)
    project_dir = tmp_path / "output" / "alice" / "project"
    _write_png(project_dir / "frames" / "ep001" / "beat_01.png")
    narrator_voice = project_dir / "assets" / "narrator" / "voice.mp3"
    narrator_voice.parent.mkdir(parents=True, exist_ok=True)
    narrator_voice.write_bytes(b"narrator voice")
    pc.set_narrator_reference_audio(
        "alice",
        "project",
        relative_path="assets/narrator/voice.mp3",
        sha256="sha",
        updated_at="2026-05-14T00:00:00+00:00",
    )

    assets = build_seedance2_project_assets(
        project_output=project_dir,
        state_dir=tmp_path / "state" / "alice" / "project",
        episode=1,
        beat={
            "beat_number": 1,
            "audio_type": "narration",
            "narration_segment": "The noodle shop still has its lights on in the night.",
        },
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
    )

    assert selected_reference_paths(assets, "reference_audios") == [str(narrator_voice)]
    audio_asset = next(asset for asset in assets if asset.key == "voice:narrator")
    assert audio_asset.selected is True
    assert audio_asset.reference_label == "audio1"
    assert audio_asset.validation_error == ""
    assert "trimming to 3-5 seconds is recommended" in audio_asset.note


def test_prompt_audio_selection_sends_only_referenced_audio(tmp_path):
    from novelvideo.seedance2_i2v.assets import (
        apply_prompt_audio_selection,
        append_seedance2_user_reference_assets,
        build_seedance2_project_assets,
        selected_reference_paths,
    )

    project_dir = tmp_path / "project"
    first_audio = project_dir / "assets" / "narrator" / "voice.mp3"
    second_audio = project_dir / "seedance2_uploads" / "ep001" / "beat_01" / "audios" / "alt.wav"
    first_audio.parent.mkdir(parents=True, exist_ok=True)
    second_audio.parent.mkdir(parents=True, exist_ok=True)
    first_audio.write_bytes(b"default narrator")
    second_audio.write_bytes(b"custom narrator")

    assets = build_seedance2_project_assets(
        project_output=project_dir,
        state_dir=tmp_path / "state" / "alice" / "project",
        episode=1,
        beat={
            "beat_number": 1,
            "audio_type": "narration",
            "narration_segment": "The noodle shop still has its lights on in the night.",
        },
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
    )
    append_seedance2_user_reference_assets(
        assets,
        reference_image_paths=[],
        reference_audio_paths=[str(second_audio)],
    )

    selected = apply_prompt_audio_selection(assets, "Visual reference image1, do not use audio.")
    assert selected_reference_paths(selected, "reference_audios") == []
    audio_assets = [asset for asset in selected if asset.media_type == "audio"]
    assert [asset.reference_label for asset in audio_assets] == ["audio1", "audio2"]

    selected = apply_prompt_audio_selection(assets, "Generate with reference to the @audio2 voice.")
    assert selected_reference_paths(selected, "reference_audios") == [str(second_audio)]


def test_drama_narration_assets_ignore_first_person_protagonist_voice(tmp_path, monkeypatch):
    from novelvideo import project_config as pc
    from novelvideo.seedance2_i2v.assets import (
        build_seedance2_project_assets,
        selected_reference_paths,
    )

    monkeypatch.setattr(pc, "OUTPUT_DIR", tmp_path / "state")
    project_dir = tmp_path / "output" / "alice" / "project"
    _write_png(project_dir / "frames" / "ep001" / "beat_01.png")
    _write_png(project_dir / "assets" / "scenes" / "old_bookstore" / "master.png")
    protagonist_voice = project_dir / "assets" / "characters" / "Luchen" / "voice_sample.wav"
    protagonist_voice.parent.mkdir(parents=True, exist_ok=True)
    protagonist_voice.write_bytes(b"protagonist voice")
    narrator_voice = project_dir / "assets" / "narrator" / "voice.mp3"
    narrator_voice.parent.mkdir(parents=True, exist_ok=True)
    narrator_voice.write_bytes(b"project narrator voice")
    pc.update_project_config_file(
        "alice",
        "project",
        lambda config: config.update(
            {"spine_template": "drama", "narration_style": "first_person"}
        ),
    )
    pc.set_narrator_reference_audio(
        "alice",
        "project",
        relative_path="assets/narrator/voice.mp3",
        sha256="narrator-sha",
        updated_at="2026-05-29T00:00:00+00:00",
    )
    character = NovelCharacter(
        name="Luchen",
        is_main=True,
        reference_audio_path="assets/characters/Luchen/voice_sample.wav",
        reference_audio_sha256="protagonist-sha",
    )
    character.identities = [
        CharacterIdentity(
            identity_id="Luchen_young_adult",
            character_name="Luchen",
            identity_name="young_adult",
        )
    ]

    assets = build_seedance2_project_assets(
        project_output=project_dir,
        state_dir=tmp_path / "state" / "alice" / "project",
        episode=1,
        beat={
            "beat_number": 1,
            "audio_type": "narration",
            "scene_ref": {"scene_id": "old_bookstore"},
            "narration_segment": "A voice-over begins.",
        },
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        characters=[character],
    )

    assert selected_reference_paths(assets, "reference_audios") == [str(narrator_voice)]
    audio_asset = next(asset for asset in assets if asset.media_type == "audio")
    assert audio_asset.key == "voice:narrator"
    assert audio_asset.identity_id == "__narrator__"
    assert audio_asset.label == "Project narrator voice"


def test_multimodal_assets_skip_auto_audio_for_silence_beat(tmp_path):
    from novelvideo.seedance2_i2v.assets import (
        build_seedance2_project_assets,
        selected_reference_paths,
    )

    project_dir = tmp_path / "project"
    frame = project_dir / "frames" / "ep001" / "beat_01.png"
    scene = project_dir / "assets" / "scenes" / "living_room_night" / "master.png"
    audio = project_dir / "audio" / "ep001" / "beat_01.mp3"
    for image_path in (frame, scene):
        _write_png(image_path)
    audio.parent.mkdir(parents=True)
    audio.write_bytes(b"stale-audio")

    assets = build_seedance2_project_assets(
        project_output=project_dir,
        state_dir=tmp_path / "state" / "alice" / "project",
        episode=1,
        beat={
            "beat_number": 1,
            "audio_type": "silence",
            "scene_ref": {"scene_id": "living_room_night"},
        },
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
    )

    assert selected_reference_paths(assets, "reference_images") == [
        str(frame),
        str(scene),
    ]
    assert selected_reference_paths(assets, "reference_audios") == []


def test_multimodal_assets_skip_auto_audio_for_legacy_action_beat(tmp_path):
    from novelvideo.seedance2_i2v.assets import (
        build_seedance2_project_assets,
        selected_reference_paths,
    )

    project_dir = tmp_path / "project"
    frame = project_dir / "frames" / "ep001" / "beat_01.png"
    audio = project_dir / "audio" / "ep001" / "beat_01.mp3"
    _write_png(frame)
    audio.parent.mkdir(parents=True)
    audio.write_bytes(b"stale-audio")

    assets = build_seedance2_project_assets(
        project_output=project_dir,
        state_dir=tmp_path / "state" / "alice" / "project",
        episode=1,
        beat={"beat_number": 1, "audio_type": "action"},
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
    )

    assert selected_reference_paths(assets, "reference_audios") == []


def test_first_frame_mode_only_sends_current_frame(tmp_path):
    from novelvideo.seedance2_i2v.assets import (
        build_seedance2_project_assets,
        selected_reference_paths,
    )

    project_dir = tmp_path / "project"
    frame = project_dir / "frames" / "ep001" / "beat_02.png"
    _write_png(frame)

    assets = build_seedance2_project_assets(
        project_output=project_dir,
        state_dir=tmp_path / "state" / "alice" / "project",
        episode=1,
        beat={"beat_number": 2, "detected_identities": ["Qin_young"]},
        mode=Seedance2I2VMode.FIRST_FRAME,
    )

    assert selected_reference_paths(assets, "image_url") == [str(frame)]
    assert selected_reference_paths(assets, "reference_images") == []
    assert selected_reference_paths(assets, "reference_audios") == []


def test_first_frame_for_video_uses_matching_video_input_override(tmp_path):
    from novelvideo.utils.path_resolver import PathResolver

    project_dir = tmp_path / "project"
    paths = PathResolver(project_dir, 1)
    frame = paths.frame(2)
    override = paths.video_input_frame(2, slot="first_frame")
    _write_png(frame)
    _write_png(override, width=720, height=1280)
    paths.write_video_input_frame_meta(2, slot="first_frame", source_path=frame)

    assert paths.first_frame_for_video(2) == override

    frame.write_bytes(frame.read_bytes() + b"changed")
    assert paths.first_frame_for_video(2) == frame


def test_first_frame_mode_uses_matching_video_input_override(tmp_path):
    from novelvideo.seedance2_i2v.assets import (
        build_seedance2_project_assets,
        selected_reference_paths,
    )
    from novelvideo.utils.path_resolver import PathResolver

    project_dir = tmp_path / "project"
    paths = PathResolver(project_dir, 1)
    frame = paths.frame(2)
    override = paths.video_input_frame(2, slot="first_frame")
    _write_png(frame)
    _write_png(override, width=720, height=1280)
    paths.write_video_input_frame_meta(2, slot="first_frame", source_path=frame)

    assets = build_seedance2_project_assets(
        project_output=project_dir,
        state_dir=tmp_path / "state" / "alice" / "project",
        episode=1,
        beat={"beat_number": 2},
        mode=Seedance2I2VMode.FIRST_FRAME,
    )

    assert selected_reference_paths(assets, "image_url") == [str(override)]
    first_asset = next(asset for asset in assets if asset.key == "first_frame")
    assert first_asset.crop_source_path == frame


def test_first_last_frame_mode_sends_both_frame_slots(tmp_path):
    from novelvideo.seedance2_i2v.assets import (
        build_seedance2_project_assets,
        selected_reference_paths,
    )

    project_dir = tmp_path / "project"
    first = project_dir / "frames" / "ep001" / "beat_02.png"
    last = project_dir / "frames" / "ep001" / "beat_03.png"
    _write_png(first)
    _write_png(last)

    assets = build_seedance2_project_assets(
        project_output=project_dir,
        state_dir=tmp_path / "state" / "alice" / "project",
        episode=1,
        beat={"beat_number": 2},
        next_beat={"beat_number": 3},
        mode=Seedance2I2VMode.FIRST_LAST_FRAME,
    )

    assert selected_reference_paths(assets, "first_frame_image") == [str(first)]
    assert selected_reference_paths(assets, "last_frame_image") == [str(last)]


def test_first_last_frame_mode_uses_matching_video_input_overrides(tmp_path):
    from novelvideo.seedance2_i2v.assets import (
        build_seedance2_project_assets,
        selected_reference_paths,
    )
    from novelvideo.utils.path_resolver import PathResolver

    project_dir = tmp_path / "project"
    paths = PathResolver(project_dir, 1)
    first = paths.frame(2)
    last = paths.frame(3)
    first_override = paths.video_input_frame(2, slot="first_frame")
    last_override = paths.video_input_frame(2, slot="last_frame")
    _write_png(first)
    _write_png(last)
    _write_png(first_override, width=720, height=1280)
    _write_png(last_override, width=720, height=1280)
    paths.write_video_input_frame_meta(2, slot="first_frame", source_path=first)
    paths.write_video_input_frame_meta(2, slot="last_frame", source_path=last)

    assets = build_seedance2_project_assets(
        project_output=project_dir,
        state_dir=tmp_path / "state" / "alice" / "project",
        episode=1,
        beat={"beat_number": 2},
        next_beat={"beat_number": 3},
        mode=Seedance2I2VMode.FIRST_LAST_FRAME,
    )

    assert selected_reference_paths(assets, "first_frame_image") == [str(first_override)]
    assert selected_reference_paths(assets, "last_frame_image") == [str(last_override)]
    by_key = {asset.key: asset for asset in assets}
    assert by_key["first_frame"].crop_source_path == first
    assert by_key["last_frame"].crop_source_path == last


async def test_crop_seedance2_asset_to_first_frame_writes_video_input_override(
    tmp_path,
    monkeypatch,
):
    from novelvideo.seedance2_i2v import panel_service
    from novelvideo.utils.path_resolver import PathResolver

    project_dir = tmp_path / "project"
    paths = PathResolver(project_dir, 1)
    source = paths.frame(2)
    _write_png(source)

    def fake_crop_image_to_path(_source, *, output_path, **_kwargs):
        _write_png(Path(output_path), width=720, height=1280)

    monkeypatch.setattr(panel_service, "_crop_image_to_path_sync", fake_crop_image_to_path)
    monkeypatch.setattr(panel_service, "validate_seedance2_reference_image", lambda _path: "")

    class Store:
        async def update_beat_asset(self, **_kwargs):
            raise AssertionError("video input crops must not mutate reference_image_paths")

    result = await panel_service.crop_seedance2_asset_to_reference(
        store=Store(),
        episode=1,
        beat={"beat_number": 2},
        project_dir=project_dir,
        asset_key="first_frame",
        source_path=source,
        crop_data={"target": "first_frame", "x": 0, "y": 0, "width": 512, "height": 768},
    )

    expected = paths.video_input_frame(2, slot="first_frame")
    assert result == expected
    assert paths.valid_video_input_frame(2, slot="first_frame", source_path=source) == expected


def test_validate_reference_audio_request_rejects_out_of_range_clips(monkeypatch):
    """Audio duration guard of the beat pipeline: 1.8-15.2s per clip + a 15s total, judged by the same rules as the canvas.

    Earlier this only judged the total with no lower bound, so a 0.5s voice would be sent to the vendor and hit
    `InvalidParameter.DurationTooShort` - a wasted round trip before we find out.
    """
    from novelvideo.seedance2_i2v import pipeline

    durations = {"a.wav": 0.5, "b.wav": 6.0}
    monkeypatch.setattr(
        pipeline,
        "probe_voice_sample_duration_seconds",
        lambda path: durations[Path(path).name],
    )

    with pytest.raises(ValueError, match="audio1"):
        pipeline._validate_reference_audio_request(["a.wav", "b.wav"])

    durations["a.wav"] = 6.0
    pipeline._validate_reference_audio_request(["a.wav", "b.wav"])


def test_validate_reference_audio_request_total_bound_and_probe_failures(monkeypatch):
    """An over-limit total must report a message + the specific entries; entries that cannot be measured do not take part in the judgment (passed through to the vendor)."""
    from novelvideo.seedance2_i2v import pipeline

    monkeypatch.setattr(
        pipeline, "probe_voice_sample_duration_seconds", lambda _path: 6.0
    )
    with pytest.raises(ValueError, match="go back to the character workbench"):
        pipeline._validate_reference_audio_request(["a.wav", "b.wav", "c.wav"])

    # 1.8+8.3+4.9 == 15.000000000000002: a naive float comparison would misjudge a set that is exactly at the 15s limit as over the limit.
    exact = {"a.wav": 1.8, "b.wav": 8.3, "c.wav": 4.9}
    monkeypatch.setattr(
        pipeline,
        "probe_voice_sample_duration_seconds",
        lambda path: exact[Path(path).name],
    )
    pipeline._validate_reference_audio_request(["a.wav", "b.wav", "c.wav"])

    def boom(_path):
        raise ValueError("ffprobe crashed")

    monkeypatch.setattr(pipeline, "probe_voice_sample_duration_seconds", boom)
    pipeline._validate_reference_audio_request(["a.wav", "b.wav", "c.wav"])
