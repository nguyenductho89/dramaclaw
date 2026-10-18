import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from examples.seedance2_fast_demo import (
    ExperimentName,
    build_experiment_request,
    build_seedance2_prompt,
    build_seedance2_prompt_atoms,
    render_seedance2_prompt_from_atoms,
    sanitize_request,
    validate_asset_paths,
)


pytestmark = pytest.mark.m09


def _beat() -> dict:
    return {
        "beat_number": 1,
        "video_prompt": "Wide slow push-in; the character lowers their head and turns the pages of an old book, freezing on the moment something odd is discovered",
        "visual_description": "{{Lu Chen_bookstore_owner}} rummages through a pile of old books in the damp basement.",
        "scene_description": "A dim, damp basement with old bookshelves, brick walls, and a downpour outside the small window.",
        "props_description": "Parchment notebook: thick cover with a red balance-scale emblem.",
        "narration_segment": "The rain pounds the window while I dig through old books in the basement.",
    }


def test_atom_prompt_renders_identity_scene_and_storyboard_reference_roles():
    atoms = build_seedance2_prompt_atoms(
        beat=_beat(),
        include_character_reference=True,
        include_scene_reference=True,
        include_storyboard_reference=True,
        include_first_frame=False,
    )

    assert [atom.atom_type for atom in atoms[:3]] == ["identity", "scene", "storyboard"]
    assert [atom.source_label for atom in atoms[:3]] == ["@image1", "@image2", "@image3"]

    prompt = render_seedance2_prompt_from_atoms(
        atoms=atoms,
        beat=_beat(),
        duration=5,
        ratio="9:16",
    )

    assert '@image1: identity atom, used only to anchor the identity look of Lu Chen "bookstore_owner"' in prompt
    assert "@image2: scene atom, used only for the basement space, old bookshelves, damp brick walls, and cold dim lighting" in prompt
    assert "@image3: storyboard atom, used only for composition, character placement, pose, camera angle, and visual center of gravity" in prompt
    assert "do not inherit the black-and-white line-art style, sketch lines, or simplified facial features" in prompt


def test_seedance2_prompt_binds_reference_roles():
    prompt = build_seedance2_prompt(
        beat=_beat(),
        duration=5,
        ratio="9:16",
        include_character_reference=True,
        include_scene_reference=True,
    )

    assert "Generate a 5-second 9:16 realistic suspense short-drama shot" in prompt
    assert "First frame: use as the opening composition and the character's current position" in prompt
    assert '@image1: identity atom, used only to anchor the identity look of Lu Chen "bookstore_owner"' in prompt
    assert "@image2: scene atom, used only for the basement space, old bookshelves, damp brick walls, and cold dim lighting" in prompt
    assert "Do not generate split screens, collages, ID photos, or a reference-image display wall" in prompt
    assert "[0-1s]" in prompt
    assert "Basement ambience, rain, paper rustling" in prompt


def test_build_atom_reference_experiment_maps_identity_scene_storyboard_images(tmp_path):
    first = tmp_path / "beat_01.png"
    character = tmp_path / "character.png"
    scene = tmp_path / "scene.png"
    storyboard = tmp_path / "storyboard.png"
    for path in (first, character, scene, storyboard):
        path.write_bytes(b"\x89PNG\r\n\x1a\n")

    request = build_experiment_request(
        experiment=ExperimentName.REFERENCE_IDENTITY_SCENE_STORYBOARD_ATOMS_PROMPT,
        beat=_beat(),
        first_frame_path=first,
        last_frame_path=None,
        character_reference_path=character,
        scene_reference_path=scene,
        storyboard_reference_path=storyboard,
        duration=5,
        resolution="720p",
        ratio="9:16",
        generate_audio=True,
    )

    params = request["params"]
    assert "image_url" not in params
    assert len(params["reference_images"]) == 3
    assert all(value.startswith("data:image/png;base64,") for value in params["reference_images"])
    assert "@image1: identity atom" in params["prompt"]
    assert "@image2: scene atom" in params["prompt"]
    assert "@image3: storyboard atom" in params["prompt"]


def test_build_reference_experiment_maps_reference_images(tmp_path):
    first = tmp_path / "beat_01.png"
    character = tmp_path / "character.png"
    scene = tmp_path / "scene.png"
    for path in (first, character, scene):
        path.write_bytes(b"\x89PNG\r\n\x1a\n")

    request = build_experiment_request(
        experiment=ExperimentName.REFERENCE_CHARACTER_SCENE_SEEDANCE2_PROMPT,
        beat=_beat(),
        first_frame_path=first,
        last_frame_path=None,
        character_reference_path=character,
        scene_reference_path=scene,
        duration=5,
        resolution="720p",
        ratio="9:16",
        generate_audio=True,
    )

    assert request["model"] == "seedance-2.0-fast"
    params = request["params"]
    assert "image_url" not in params
    assert len(params["reference_images"]) == 2
    assert all(value.startswith("data:image/png;base64,") for value in params["reference_images"])
    assert "@image1" in params["prompt"]
    assert "@image2" in params["prompt"]
    assert "First frame: use as the opening composition" not in params["prompt"]


def test_experiment_requests_do_not_mix_strict_frames_with_reference_images(tmp_path):
    first = tmp_path / "beat_01.png"
    last = tmp_path / "beat_02.png"
    character = tmp_path / "character.png"
    scene = tmp_path / "scene.png"
    second_scene = tmp_path / "second_scene.png"
    storyboard = tmp_path / "storyboard.png"
    for path in (first, last, character, scene, second_scene, storyboard):
        path.write_bytes(b"\x89PNG\r\n\x1a\n")

    for experiment in ExperimentName:
        request = build_experiment_request(
            experiment=experiment,
            beat=_beat(),
            first_frame_path=first,
            last_frame_path=last,
            character_reference_path=character,
            scene_reference_path=scene,
            second_scene_reference_path=second_scene,
            storyboard_reference_path=storyboard,
            duration=5,
            resolution="720p",
            ratio="9:16",
            generate_audio=True,
        )

        params = request["params"]
        has_strict_frame = any(
            key in params for key in ("image_url", "first_frame_image", "last_frame_image")
        )
        assert not ("reference_images" in params and has_strict_frame), experiment.value


def test_build_scene_reference_experiment_uses_reference_images_without_first_frame(tmp_path):
    first = tmp_path / "beat_01.png"
    scene = tmp_path / "scene.png"
    second_scene = tmp_path / "second_scene.png"
    for path in (first, scene, second_scene):
        path.write_bytes(b"\x89PNG\r\n\x1a\n")

    request = build_experiment_request(
        experiment=ExperimentName.REFERENCE_SCENES_SEEDANCE2_PROMPT,
        beat=_beat(),
        first_frame_path=first,
        last_frame_path=None,
        character_reference_path=None,
        scene_reference_path=scene,
        second_scene_reference_path=second_scene,
        duration=5,
        resolution="720p",
        ratio="9:16",
        generate_audio=True,
    )

    params = request["params"]
    assert "image_url" not in params
    assert len(params["reference_images"]) == 2
    assert params["reference_images"][0].startswith("data:image/png;base64,")
    assert params["reference_images"][1].startswith("data:image/png;base64,")
    assert "@image1: scene atom, used only for the basement space" in params["prompt"]
    assert "@image2: scene supplement atom, used only for old wooden structures, the flagstone road, and damp aged texture" in params["prompt"]


def test_build_human_review_request_sets_flag(tmp_path):
    first = tmp_path / "beat_01.png"
    first.write_bytes(b"\x89PNG\r\n\x1a\n")

    request = build_experiment_request(
        experiment=ExperimentName.I2V_SEEDANCE2_PROMPT,
        beat=_beat(),
        first_frame_path=first,
        last_frame_path=None,
        character_reference_path=None,
        scene_reference_path=None,
        second_scene_reference_path=None,
        duration=5,
        resolution="720p",
        ratio="9:16",
        generate_audio=True,
        human_review=True,
    )

    assert request["params"]["human_review"] is True


def test_build_flf_experiment_uses_first_and_last_frame(tmp_path):
    first = tmp_path / "beat_01.png"
    last = tmp_path / "beat_02.png"
    first.write_bytes(b"\x89PNG\r\n\x1a\n")
    last.write_bytes(b"\x89PNG\r\n\x1a\n")

    request = build_experiment_request(
        experiment=ExperimentName.FLF_SEEDANCE2_PROMPT,
        beat=_beat(),
        first_frame_path=first,
        last_frame_path=last,
        character_reference_path=None,
        scene_reference_path=None,
        second_scene_reference_path=None,
        duration=5,
        resolution="720p",
        ratio="9:16",
        generate_audio=False,
    )

    params = request["params"]
    assert "image_url" not in params
    assert params["first_frame_image"].startswith("data:image/png;base64,")
    assert params["last_frame_image"].startswith("data:image/png;base64,")
    assert params["generate_audio"] is False


def test_sanitize_request_replaces_data_urls():
    request = {
        "model": "seedance-2.0-fast",
        "params": {
            "image_url": "data:image/png;base64,abcdef",
            "reference_images": ["data:image/png;base64,123456"],
            "prompt": "short prompt",
        },
    }

    sanitized = sanitize_request(
        request,
        source_paths={
            "image_url": Path("frame.png"),
            "reference_images[0]": Path("character.png"),
        },
    )

    assert sanitized["params"]["image_url"] == "<data-url image_url: frame.png>"
    assert sanitized["params"]["reference_images"] == [
        "<data-url reference_images[0]: character.png>"
    ]
    assert sanitized["params"]["prompt"] == "short prompt"


def test_validate_asset_paths_reports_missing_files(tmp_path):
    existing = tmp_path / "frame.png"
    missing = tmp_path / "missing.png"
    existing.write_bytes(b"\x89PNG\r\n\x1a\n")

    with pytest.raises(FileNotFoundError) as exc:
        validate_asset_paths({"first_frame": existing, "last_frame": missing})

    assert "last_frame" in str(exc.value)
    assert str(missing) in str(exc.value)
