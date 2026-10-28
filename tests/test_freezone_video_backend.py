from __future__ import annotations

from pathlib import Path

import pytest

from novelvideo.freezone.jobs import run_freezone_video_gen
from novelvideo.generators.video_generator import (
    HuimengVideoGenerator,
    Seedance2VideoGenerator,
    ShotReference,
    newapi_video_backend_options,
)
from novelvideo.generators.video_generator import VideoGenResult, VideoGenStatus
from novelvideo.video_duration import video_duration_bounds_for_backend
from novelvideo.freezone.video_node import (
    RESERVED_FOLDER_KEYS,
    add_video_character_folder,
    delete_video_character_folder,
    add_video_character_library_item,
    library_folder_keys,
    update_video_character_folder,
    build_freezone_image_to_video_prompt,
    build_freezone_keyframe_video_prompt,
    build_freezone_omni_video_prompt,
    build_freezone_video_prompt,
    delete_video_character_library_item,
    get_freezone_video_model_names,
    get_freezone_video_model_options,
    get_video_camera_template,
    is_freezone_happyhorse_backend,
    is_freezone_seedance2_backend,
    load_video_character_library,
    normalize_video_aspect_ratio,
    normalize_video_duration_for_backend,
    normalize_video_resolution,
    normalize_video_resolution_for_backend,
    supported_image_aspect_ratio,
    rename_video_character_library_item,
    resolve_freezone_video_backend,
    summarize_omni_reference_counts,
    sync_mainline_assets_into_library,
    validate_omni_reference_audio_durations,
    validate_omni_reference_image_dimensions,
    validate_omni_reference_limits,
)


def test_build_freezone_video_prompt_includes_camera_template_and_character_names() -> None:
    prompt = build_freezone_video_prompt(
        user_prompt="A cyberpunk street, the character walks slowly forward",
        camera_template_id="follow_tracking",
        character_names=["Lin_Xiaoman", "A_Qi"],
        marks=[{"label": "old man", "point_x": 0.2, "point_y": 0.5}],
    )

    assert "A cyberpunk street" in prompt
    assert "Follow shot" in prompt
    assert "Lin_Xiaoman, A_Qi" in prompt
    assert "Key element marks" in prompt
    assert "old man" in prompt


def test_video_camera_template_lookup_works() -> None:
    template = get_video_camera_template("locked_off")

    assert template is not None
    assert template["name"] == "Locked-off shot"


def test_locked_frame_selects_nearest_supported_ratio(tmp_path: Path) -> None:
    from PIL import Image

    source = tmp_path / "portrait.png"
    Image.new("RGB", (400, 600)).save(source)
    assert supported_image_aspect_ratio(
        str(source), ["16:9", "1:1", "3:4", "9:16", "auto"]
    ) == "3:4"
    assert supported_image_aspect_ratio(str(source), None) == "auto"


def test_video_character_library_roundtrip(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    item = add_video_character_library_item(
        project_dir,
        name="Lin_Xiaoman",
        image_urls=["/static/admin/58/freezone/_uploads/char.png"],
    )

    items = load_video_character_library(project_dir)
    assert len(items) == 1
    assert items[0]["id"] == item["id"]
    assert items[0]["name"] == "Lin_Xiaoman"

    deleted = delete_video_character_library_item(project_dir, item["id"])
    assert deleted is True
    assert load_video_character_library(project_dir) == []


def test_video_character_library_rename_keeps_everything_else(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    item = add_video_character_library_item(
        project_dir,
        name="Unnamed",
        image_urls=["/static/admin/58/freezone/_uploads/char.png"],
        category="character",
        folder="character",
    )

    renamed = rename_video_character_library_item(project_dir, item["id"], name="  Lin_Xiaoman  ")

    assert renamed is not None
    assert renamed["name"] == "Lin_Xiaoman"
    # Renaming changes only the name: the URL / category / save location must stay as they were, so that canvas nodes referencing it do not break.
    assert renamed["image_urls"] == item["image_urls"]
    assert renamed["category"] == "character"
    assert renamed["folder"] == "character"
    assert [it["name"] for it in load_video_character_library(project_dir)] == ["Lin_Xiaoman"]


def test_video_character_library_rename_rejects_bad_names(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    item = add_video_character_library_item(
        project_dir, name="Old name", image_urls=["/static/a.png"]
    )

    assert rename_video_character_library_item(project_dir, "missing", name="New name") is None
    with pytest.raises(ValueError):
        rename_video_character_library_item(project_dir, item["id"], name="   ")
    with pytest.raises(ValueError):
        rename_video_character_library_item(project_dir, item["id"], name="x" * 61)
    # A validation failure must not dirty the library.
    assert [it["name"] for it in load_video_character_library(project_dir)] == ["Old name"]


def test_video_character_library_category(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"

    # When no category is passed, fall back by source/medium: locally uploaded images go to "other", and audio goes to "sound effects".
    plain = add_video_character_library_item(
        project_dir, name="Reference image", image_urls=["/static/a.png"]
    )
    assert plain["category"] == "other"
    bgm = add_video_character_library_item(
        project_dir, name="Footsteps", media="audio", audio_url="/static/step.mp3"
    )
    assert bgm["category"] == "audio"

    styled = add_video_character_library_item(
        project_dir, name="Cyber Neon", image_urls=["/static/b.png"], category="style"
    )
    assert styled["category"] == "style"

    # Mainline sync classifies by source, and does not wash out categories that are already sorted.
    sync_mainline_assets_into_library(
        project_dir,
        assets=[
            {
                "id": "mainline:scene:kitchen",
                "name": "Kitchen",
                "media": "image",
                "source": "scene",
                "url": "/static/kitchen.png",
            },
            {
                "id": styled["id"],
                "name": "Cyber Neon",
                "media": "image",
                "source": "upload",
                "url": "/static/b.png",
            },
        ],
    )
    items = {str(it["id"]): it for it in load_video_character_library(project_dir)}
    assert items["mainline:scene:kitchen"]["category"] == "scene"
    assert items[styled["id"]]["category"] == "style"


def test_video_character_library_folder(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"

    # When no save location is passed, land by category in the same-named system folder, and everything synced from the mainline goes into mainline.
    plain = add_video_character_library_item(
        project_dir, name="Reference image", image_urls=["/static/a.png"]
    )
    assert plain["folder"] == "other"
    styled = add_video_character_library_item(
        project_dir, name="Cyber Neon", image_urls=["/static/b.png"], category="style"
    )
    assert styled["folder"] == "style"

    # Folders and labels are two independent dimensions: an item can go into a user-created folder and carry the "character" label at the same time.
    folder = add_video_character_folder(project_dir, name="Episode 1 assets")
    assert folder["name"] == "Episode 1 assets"
    assert folder["id"] not in RESERVED_FOLDER_KEYS
    assert folder["id"] in library_folder_keys(project_dir)

    filed = add_video_character_library_item(
        project_dir,
        name="Heroine look test",
        image_urls=["/static/c.png"],
        category="character",
        folder=folder["id"],
    )
    assert filed["folder"] == folder["id"]
    assert filed["category"] == "character"

    # Duplicate names (including system folder names) cannot be created.
    with pytest.raises(ValueError):
        add_video_character_folder(project_dir, name="Episode 1 assets")
    with pytest.raises(ValueError):
        add_video_character_folder(project_dir, name="Unsorted assets")
    with pytest.raises(ValueError):
        add_video_character_folder(project_dir, name="x" * 21)

    # Mainline sync does not wash out positions the user has arranged.
    sync_mainline_assets_into_library(
        project_dir,
        assets=[
            {
                "id": "mainline:scene:kitchen",
                "name": "Kitchen",
                "media": "image",
                "source": "scene",
                "url": "/static/kitchen.png",
            },
            {
                "id": filed["id"],
                "name": "Heroine look test",
                "media": "image",
                "source": "upload",
                "url": "/static/c.png",
            },
        ],
    )
    items = {str(it["id"]): it for it in load_video_character_library(project_dir)}
    assert items["mainline:scene:kitchen"]["folder"] == "mainline"
    assert items[filed["id"]]["folder"] == folder["id"]


def test_video_character_folder_update_and_delete(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    folder = add_video_character_folder(project_dir, name="Episode 1 assets")
    other = add_video_character_folder(project_dir, name="Episode 2 assets")

    # Renaming / changing the cover do not affect each other: when only one field is passed, the other is kept as is.
    renamed = update_video_character_folder(project_dir, folder["id"], name="Episode 1")
    assert renamed is not None and renamed["name"] == "Episode 1"
    covered = update_video_character_folder(
        project_dir, folder["id"], cover="/static/c.png"
    )
    assert covered is not None
    assert covered["cover"] == "/static/c.png"
    assert covered["name"] == "Episode 1"

    # Renaming goes through the same validation as creation; changing to its own current name does not count as a duplicate.
    assert update_video_character_folder(project_dir, folder["id"], name="Episode 1")
    with pytest.raises(ValueError):
        update_video_character_folder(project_dir, folder["id"], name="Episode 2 assets")
    with pytest.raises(ValueError):
        update_video_character_folder(project_dir, folder["id"], name="Mainline")
    assert update_video_character_folder(project_dir, "nope", name="whatever") is None

    inside = add_video_character_library_item(
        project_dir, name="Heroine look test", image_urls=["/static/c.png"], folder=folder["id"]
    )
    outside = add_video_character_library_item(
        project_dir, name="Passerby", image_urls=["/static/d.png"], folder=other["id"]
    )

    # Emptying the whole cabinet: the folder and the assets inside it go together, and other folders are unaffected.
    assert delete_video_character_folder(project_dir, folder["id"]) == 1
    assert folder["id"] not in library_folder_keys(project_dir)
    remaining = {str(it["id"]) for it in load_video_character_library(project_dir)}
    assert inside["id"] not in remaining
    assert outside["id"] in remaining
    assert delete_video_character_folder(project_dir, folder["id"]) is None


def test_video_ratio_and_resolution_normalization() -> None:
    assert normalize_video_aspect_ratio("auto") == "auto"
    assert normalize_video_aspect_ratio("adaptive") == "auto"
    assert normalize_video_aspect_ratio("9:16") == "9:16"
    assert normalize_video_resolution("720P") == "720p"


def test_build_freezone_omni_video_prompt_includes_theme() -> None:
    prompt = build_freezone_omni_video_prompt(
        user_prompt="On a rainy night an old man lies in a hospital bed, and a young man reaches out to adjust the oxygen tube.",
        theme="Oppressive, restrained, documentary feel",
        camera_template_id="orbit_up",
        marks=[{"label": "oxygen tube", "point_x": 0.7, "point_y": 0.6}],
    )

    assert "Oppressive, restrained, documentary feel" in prompt
    assert "Orbit and rise" in prompt
    assert "oxygen tube" in prompt


def test_build_freezone_omni_video_prompt_marks_single_video_as_reference() -> None:
    prompt = build_freezone_omni_video_prompt(
        user_prompt="Reference the character's actions to generate a new shot.",
        reference_items=[{"type": "video", "path": "/tmp/reference.mp4"}],
    )

    assert prompt.count("This is generating a new video from a video reference, not video editing.") == 1


@pytest.mark.parametrize(
    "reference_items",
    [
        [{"type": "video"}, {"type": "video"}],
        [{"type": "video"}, {"type": "image"}],
        [{"type": "video"}, {"type": "audio"}],
        [{"type": "image"}],
    ],
)
def test_build_freezone_omni_video_prompt_does_not_mark_other_inputs(
    reference_items: list[dict[str, str]],
) -> None:
    prompt = build_freezone_omni_video_prompt(
        user_prompt="Generate a new shot from the reference assets.",
        reference_items=reference_items,
    )

    assert "This is generating a new video from a video reference, not video editing." not in prompt


def test_build_freezone_image_to_video_prompt_uses_image_reference_semantics() -> None:
    prompt = build_freezone_image_to_video_prompt(
        user_prompt="The old man slowly raises his eyes, his breathing faint.",
        camera_template_id="pedestal_up",
        marks=[{"label": "old man", "point_x": 0.15, "point_y": 0.45, "note": "main subject"}],
    )

    assert "The old man slowly raises his eyes" in prompt
    assert "Pedestal up" in prompt
    assert "old man" in prompt
    assert "main subject" in prompt
    assert "Image reference constraint" in prompt
    assert "do not force the input image to be locked as the first frame of the video" in prompt
    assert "First frame constraint" not in prompt


def test_build_freezone_image_to_video_prompt_drops_image_clause_without_images() -> None:
    # 视频编辑端点复用这个 builder 且常常一张参考图都没有（片段重拍就是）。
    # 没有图还写「把输入图片作为主体…」= 向模型描述一个不存在的素材。
    prompt = build_freezone_image_to_video_prompt(
        user_prompt="把大猩猩换一个\n00:00-00:04",
        reference_image_count=0,
    )

    assert "图片参考约束" not in prompt
    assert "把大猩猩换一个" in prompt
    assert "输出要求" in prompt


def test_build_freezone_image_to_video_prompt_supports_multi_image_references() -> None:
    prompt = build_freezone_image_to_video_prompt(
        user_prompt="The old man lifts his head slightly, keeping the oppressive atmosphere of the ward.",
        camera_template_id="follow_tracking",
        reference_image_count=3,
    )

    assert "Image reference constraint" in prompt
    assert "multiple input images" in prompt
    assert "Follow shot" in prompt


def test_build_freezone_image_to_video_prompt_supports_box_marks() -> None:
    prompt = build_freezone_image_to_video_prompt(
        user_prompt="The old man turns his head slightly.",
        camera_template_id="locked_off",
        marks=[{"label": "old man", "box_x": 0.05, "box_y": 0.2, "box_width": 0.3, "box_height": 0.5}],
    )

    assert "Key element marks" in prompt
    assert "old man" in prompt
    assert "middle left" in prompt


def test_build_freezone_keyframe_video_prompt_handles_first_and_last_frame() -> None:
    prompt = build_freezone_keyframe_video_prompt(
        user_prompt="After the old man raises his eyes, the camera slowly pushes in to the side of the hospital bed.",
        camera_template_id="pedestal_up",
        marks=[{"label": "old man", "point_x": 0.4, "point_y": 0.4}],
        has_first_frame=True,
        has_last_frame=True,
    )

    assert "After the old man raises his eyes, the camera slowly pushes in to the side of the hospital bed" in prompt
    assert "Pedestal up" in prompt
    assert "First/last frame constraint" in prompt
    assert "old man" in prompt


def test_video_model_options_and_resolution_work() -> None:
    names = get_freezone_video_model_names()
    options = get_freezone_video_model_options()
    ids = {item["id"] for item in options}
    labels = {item["label"] for item in options}
    api_models = {item["apiModel"] for item in options}

    assert names[0] == "newapi_seedance-2.0-fast"
    assert {
        "newapi_seedance-2.0-fast",
        "newapi_seedance-1.0-pro-fast",
        "newapi_seedance-1.5-pro",
    }.issubset(names)
    assert "newapi_grok-video-channel" not in names
    assert ids == set(names)
    assert api_models == set(names)
    # Every option is either a NewAPI backend or (dev-only, only visible
    # when RunPod H3 env vars are configured — may or may not be true in
    # this test environment) the RunPod H3 backend added 2026-10-22, see
    # `.claude/CLAUDE.md`.
    assert all(item["providerId"] in {"newapi", "runpod"} for item in options)
    assert "Seedance1.0 Pro Fast" in labels
    assert "Seedance1.5 Pro" in labels
    assert "Seedance2.0 Fast" in labels
    assert "HappyHorse 1.0" in labels
    assert "Grok Video Channel" not in labels
    assert normalize_video_resolution("720P") == "720p"
    happyhorse = next(item for item in options if item["id"] == "newapi_happyhorse-1.0")
    assert happyhorse["resolutionOptions"] == ["720p", "1080p"]
    assert happyhorse["minDuration"] == 3
    assert happyhorse["maxDuration"] == 15
    assert normalize_video_resolution_for_backend("newapi_happyhorse-1.0", "480p") == "720p"


def test_catalog_resolution_options_override_legacy_video_whitelist() -> None:
    assert (
        normalize_video_resolution_for_backend(
            "newapi_Kling-V2.1",
            "4K",
            ["1080p", "4K"],
        )
        == "4k"
    )


def test_catalog_duration_bounds_override_legacy_video_bounds() -> None:
    assert (
        normalize_video_duration_for_backend(
            "newapi_happyhorse-1.0",
            20,
            2,
            30,
        )
        == 20
    )
    assert (
        normalize_video_duration_for_backend(
            "newapi_happyhorse-1.0",
            1,
            2,
            30,
        )
        == 2
    )


def test_video_duration_normalization_uses_ceiling_and_backend_bounds() -> None:
    assert normalize_video_duration_for_backend(
        "newapi_seedance-1.0-pro-fast",
        1,
    ) == 2
    assert normalize_video_duration_for_backend(
        "newapi_seedance-1.0-pro-fast",
        100,
    ) == 12
    assert normalize_video_duration_for_backend(
        "newapi_seedance-1.0-pro-fast",
        5.1,
    ) == 6


def test_seedance_mini_duration_fallback_with_legacy_env(monkeypatch) -> None:
    from novelvideo import config

    monkeypatch.setattr(
        config,
        "NEWAPI_VIDEO_DURATION_BOUNDS",
        "seedance-1.0-pro-fast:2-12,seedance-2.0:4-15",
    )

    backend = "newapi_seedance-2.0-mini"
    assert video_duration_bounds_for_backend(backend) == (4, 15)
    assert normalize_video_duration_for_backend(backend, 2) == 4
    assert normalize_video_duration_for_backend(backend, 13) == 13
    assert normalize_video_duration_for_backend(backend, 20) == 15


def test_newapi_video_backend_preserves_gateway_model_case() -> None:
    from novelvideo.generators.video_generator import parse_newapi_video_backend

    assert parse_newapi_video_backend("newapi_Kling-V2.1") == "Kling-V2.1"


def test_grok_video_channel_is_not_exposed_even_if_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    from novelvideo import config

    monkeypatch.setattr(
        config,
        "NEWAPI_VIDEO_MODELS",
        ["seedance-2.0-fast", "grok-video-channel"],
    )

    assert "newapi_grok-video-channel" not in newapi_video_backend_options()
    assert "newapi_grok-video-channel" not in get_freezone_video_model_names()
    with pytest.raises(ValueError, match="unknown video model"):
        resolve_freezone_video_backend("newapi_grok-video-channel")


def test_resolve_freezone_video_backend_accepts_id_and_label() -> None:
    assert (
        resolve_freezone_video_backend("newapi_seedance-1.0-pro-fast")
        == "newapi_seedance-1.0-pro-fast"
    )
    assert resolve_freezone_video_backend("Seedance1.5 Pro") == "newapi_seedance-1.5-pro"
    assert resolve_freezone_video_backend("huimeng_seedance20_fast") == "newapi_seedance-2.0-fast"
    assert resolve_freezone_video_backend("seedance_fast") == "newapi_seedance-1.0-pro-fast"
    assert resolve_freezone_video_backend(None) == "newapi_seedance-2.0-fast"


def test_seedance2_backend_detection_accepts_newapi_and_legacy_values() -> None:
    assert is_freezone_seedance2_backend("newapi_seedance-2.0-fast")
    assert is_freezone_seedance2_backend("huimeng_seedance-2.0-fast")
    assert is_freezone_seedance2_backend("seedance_2")
    assert not is_freezone_seedance2_backend("newapi_seedance-1.5-pro")


def test_happyhorse_backend_detection_accepts_newapi_value() -> None:
    assert is_freezone_happyhorse_backend("newapi_happyhorse-1.0")
    assert not is_freezone_happyhorse_backend("newapi_happyhorse-1.1")
    assert not is_freezone_happyhorse_backend("newapi_seedance-2.0-fast")


def test_direct_seedance_ratio_accepts_canonical_and_legacy_auto_values() -> None:
    from novelvideo.generators.video_generator import SeedanceVideoGenerator

    assert SeedanceVideoGenerator._normalize_aspect_ratio("auto") == "auto"
    assert SeedanceVideoGenerator._normalize_aspect_ratio("adaptive") == "adaptive"
    assert SeedanceVideoGenerator._normalize_aspect_ratio("16:9") == "16:9"
    assert SeedanceVideoGenerator._normalize_aspect_ratio("unsupported") == "9:16"


def test_freezone_rejects_removed_wan26_backend() -> None:
    with pytest.raises(ValueError, match="unknown video model"):
        resolve_freezone_video_backend("wan26")


@pytest.mark.asyncio
async def test_freezone_video_gen_allows_newapi_seedance2_text_to_video(
    monkeypatch, tmp_path: Path
):
    captured: dict[str, dict] = {}

    class FakeVideoGenerator:
        async def generate(self, **kwargs):
            captured["generate"] = kwargs
            output_path = Path(kwargs["output_path"])
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"fake mp4")
            return VideoGenResult(status=VideoGenStatus.DONE, video_path=str(output_path))

    def fake_create_video_generator(**kwargs):
        captured["create"] = kwargs
        return FakeVideoGenerator()

    monkeypatch.setattr(
        "novelvideo.generators.video_generator.create_video_generator",
        fake_create_video_generator,
    )

    out = await run_freezone_video_gen(
        project_dir=tmp_path,
        job_id="job_newapi_t2v",
        prompt="A rainy night street, the camera slowly pushes in",
        reference_items=[],
        backend="newapi_seedance-2.0-fast",
    )

    assert out.exists()
    assert captured["create"]["backend"] == "newapi_seedance-2.0-fast"
    assert captured["generate"]["image_path"] is None
    assert captured["generate"]["references"] == []


@pytest.mark.asyncio
async def test_freezone_video_gen_allows_newapi_fast_text_to_video(monkeypatch, tmp_path: Path):
    captured: dict[str, dict] = {}

    class FakeVideoGenerator:
        async def generate(self, **kwargs):
            captured["generate"] = kwargs
            output_path = Path(kwargs["output_path"])
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"fake mp4")
            return VideoGenResult(status=VideoGenStatus.DONE, video_path=str(output_path))

    def fake_create_video_generator(**kwargs):
        captured["create"] = kwargs
        return FakeVideoGenerator()

    monkeypatch.setattr(
        "novelvideo.generators.video_generator.create_video_generator",
        fake_create_video_generator,
    )

    out = await run_freezone_video_gen(
        project_dir=tmp_path,
        job_id="job_newapi_fast_t2v",
        prompt="A rainy night street, the camera slowly pushes in",
        reference_items=[],
        backend="newapi_seedance-1.0-pro-fast",
    )

    assert out.exists()
    assert captured["create"]["backend"] == "newapi_seedance-1.0-pro-fast"
    assert captured["generate"]["image_path"] is None
    assert captured["generate"]["references"] == []


@pytest.mark.asyncio
async def test_freezone_keyframe_tail_only_does_not_promote_tail_to_first_frame(
    monkeypatch, tmp_path: Path
):
    captured: dict[str, dict] = {}

    class FakeVideoGenerator:
        async def generate(self, **kwargs):
            captured["generate"] = kwargs
            output_path = Path(kwargs["output_path"])
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"fake mp4")
            return VideoGenResult(status=VideoGenStatus.DONE, video_path=str(output_path))

    monkeypatch.setattr(
        "novelvideo.generators.video_generator.create_video_generator",
        lambda **_kwargs: FakeVideoGenerator(),
    )

    tail_path = tmp_path / "tail.png"
    tail_path.write_bytes(b"fake image")
    await run_freezone_video_gen(
        project_dir=tmp_path,
        job_id="job_tail_only",
        prompt="Finally settle on the target composition",
        reference_items=[{"type": "image", "path": str(tail_path), "role": "last frame"}],
        backend="newapi_seedance-2.0",
        last_frame_path=str(tail_path),
        gen_mode="first_last_frame",
    )

    assert captured["generate"]["image_path"] is None
    assert captured["generate"]["last_frame_path"] == str(tail_path)


def test_seedance2_model_selection_prefers_omni_model_for_mixed_references() -> None:
    generator = object.__new__(Seedance2VideoGenerator)

    assert (
        generator._select_generation_model(image_count=1, video_count=0, audio_count=0)
        == "seedance-2.0-i2v"
    )
    assert (
        generator._select_generation_model(image_count=1, video_count=1, audio_count=0)
        == "seedance-2.0"
    )
    assert (
        generator._select_generation_model(image_count=0, video_count=1, audio_count=0)
        == "seedance-2.0"
    )


def test_huimeng_multimodal_reference_params_support_images_videos_and_audio(
    tmp_path: Path,
) -> None:
    image_path = tmp_path / "ref.png"
    image_path.write_bytes(b"\x89PNG\r\n\x1a\nfake")
    video_path = tmp_path / "ref.mp4"
    video_path.write_bytes(b"\x00\x00\x00\x18ftypmp42fake")
    audio_path = tmp_path / "ref.wav"
    audio_path.write_bytes(b"RIFFfakeWAVEfmt ")

    generator = object.__new__(HuimengVideoGenerator)
    params, counts = generator._build_reference_params(
        [
            ShotReference("image", str(image_path), "character reference"),
            ShotReference("video", str(video_path), "motion reference"),
            ShotReference("audio", str(audio_path), "audio reference"),
        ],
        log=lambda _msg: None,
    )

    assert counts == {"image_count": 1, "video_count": 1, "audio_count": 1}
    assert params["reference_images"][0].startswith("data:image/png;base64,")
    assert params["reference_videos"][0].startswith("data:video/mp4;base64,")
    assert params["reference_audios"][0].startswith("data:audio/x-wav;base64,")


def test_validate_omni_reference_limits_and_summary() -> None:
    items = [{"type": "image", "url": f"/static/{i}.png"} for i in range(9)]
    items += [{"type": "video", "url": f"/static/{i}.mp4"} for i in range(3)]
    counts = summarize_omni_reference_counts(items)

    assert counts == {
        "image_count": 9,
        "video_count": 3,
        "audio_count": 0,
        "file_count": 0,
        "link_count": 0,
        "total_count": 12,
    }

    validate_omni_reference_limits(items)

    too_many_images = [{"type": "image", "url": f"/static/{i}.png"} for i in range(10)]
    try:
        validate_omni_reference_limits(too_many_images)
        raise AssertionError("expected validate_omni_reference_limits to fail")
    except ValueError as exc:
        assert "<= 9" in str(exc)

    validate_omni_reference_limits(
        [{"type": "image", "url": "/static/a.png"}],
        image_max=1,
        video_max=0,
        audio_max=0,
        total_max=1,
    )
    with pytest.raises(ValueError, match="image references count must be <= 1"):
        validate_omni_reference_limits(
            [
                {"type": "image", "url": "/static/a.png"},
                {"type": "image", "url": "/static/b.png"},
            ],
            image_max=1,
            video_max=0,
            audio_max=0,
            total_max=2,
        )

    validate_omni_reference_limits(
        [
            {"type": "image", "url": "/static/a.png"},
            {"type": "file", "url": "/static/brief.pdf"},
        ],
        image_max=1,
        video_max=0,
        audio_max=0,
        file_max=1,
        link_max=1,
        total_max=2,
    )
    with pytest.raises(ValueError, match="mutually exclusive"):
        validate_omni_reference_limits(
            [
                {"type": "file", "url": "/static/brief.pdf"},
                {"type": "link", "url": "https://example.com/brief"},
            ],
            image_max=0,
            video_max=0,
            audio_max=0,
            file_max=1,
            link_max=1,
            total_max=2,
        )


def test_validate_omni_reference_audio_durations_per_clip_bounds() -> None:
    # Vendor per-item rule: 1.8s <= duration <= 15.2s, with both ends closed.
    validate_omni_reference_audio_durations([("a.wav", 1.8)])
    validate_omni_reference_audio_durations([("a.wav", 15.2)])

    with pytest.raises(ValueError, match=r"must be >= 1\.8s") as short_exc:
        validate_omni_reference_audio_durations([("ok.wav", 5.0), ("tiny.wav", 0.9)])
    # Name only the out-of-range one, and do not list the compliant ones too and make the user guess.
    assert "tiny.wav (0.9s)" in str(short_exc.value)
    assert "ok.wav" not in str(short_exc.value)

    with pytest.raises(ValueError, match=r"must be <= 15\.2s"):
        validate_omni_reference_audio_durations([("long.wav", 15.201)])


def test_validate_omni_reference_audio_durations_total_bound() -> None:
    """3 items of 6s each: every one is compliant, but the total is 18s -- the two 2026-08-06 3060 tasks died exactly here.

    Vendor message: `audio total duration (seconds) ... must be less than or equal to 15.2
    for model doubao-seedance-2-0 in r2v`. Do not delete this as a redundant local rule.
    """
    with pytest.raises(ValueError, match="total duration must be <= 15.2s") as exc:
        validate_omni_reference_audio_durations(
            [("a.wav", 6.0), ("b.wav", 6.0), ("c.wav", 6.0)]
        )
    assert "got 18s" in str(exc.value)

    # Exactly 15.2s must be let through: the floating-point sum drifts to 15.200000000000001, and a bare comparison would block it by mistake.
    validate_omni_reference_audio_durations(
        [("a.wav", 6.0), ("b.wav", 6.0), ("c.wav", 3.2)]
    )
    # A single item at the cap likewise must not be hit by the total rule (the fallback cap equals the per-item cap).
    validate_omni_reference_audio_durations([("a.wav", 15.2)])

    # A per-item out-of-range is reported first: replace that one before talking about trimming the whole.
    with pytest.raises(ValueError, match="must be <= 15.2s"):
        validate_omni_reference_audio_durations([("a.wav", 20.0), ("b.wav", 6.0)])

    # The cap uses the passed-in value (the admin-side referenceAudioTotalMaxSeconds).
    validate_omni_reference_audio_durations(
        [("a.wav", 6.0), ("b.wav", 6.0)], total_max_seconds=30.0
    )
    with pytest.raises(ValueError, match="total duration must be <= 10s"):
        validate_omni_reference_audio_durations(
            [("a.wav", 6.0), ("b.wav", 6.0)], total_max_seconds=10.0
        )


def test_validate_omni_reference_audio_durations_skips_unmeasured() -> None:
    """Entries that cannot be probed do not take part in the judgment -- an omission can only make the sum smaller and cannot cause a false block."""
    validate_omni_reference_audio_durations([("unknown.wav", None)])
    validate_omni_reference_audio_durations(
        [("a.wav", 6.0), ("unknown.wav", None), ("c.wav", 6.0)]
    )
    validate_omni_reference_audio_durations([])
    # 0 / negative values are garbage output of ffprobe and are likewise treated as "could not be probed", not as a too-short 0s audio.
    validate_omni_reference_audio_durations([("weird.wav", 0.0), ("neg.wav", -1.0)])


def test_validate_reference_duration_total_min_requires_complete_measurement() -> None:
    with pytest.raises(ValueError, match="total duration must be >= 10s"):
        validate_omni_reference_audio_durations(
            [("a.wav", 4.0), ("b.wav", 5.0)],
            min_seconds=None,
            max_seconds=None,
            total_min_seconds=10,
            total_max_seconds=None,
        )

    # When one item cannot be probed, the known sum is only a lower bound and must not be used to wrongly judge it below the total-duration minimum.
    validate_omni_reference_audio_durations(
        [("a.wav", 4.0), ("unknown.wav", None)],
        min_seconds=None,
        max_seconds=None,
        total_min_seconds=10,
        total_max_seconds=None,
    )


def test_validate_reference_duration_uses_video_label() -> None:
    with pytest.raises(ValueError, match="video reference duration must be <= 8s"):
        validate_omni_reference_audio_durations(
            [("clip.mp4", 9.0)],
            min_seconds=None,
            max_seconds=8,
            total_max_seconds=None,
            media_label="video",
        )


def _write_png(path: Path, width: int, height: int) -> Path:
    from PIL import Image

    Image.new("RGB", (width, height), (255, 255, 255)).save(path, format="PNG")
    return path


def test_validate_omni_reference_image_dimensions_rejects_small_image(
    tmp_path: Path,
) -> None:
    """3060 instance: a 338x191 reference image was rejected by Volcengine with HeightTooSmall and must be blocked before enqueueing."""
    small = _write_png(tmp_path / "logo.png", 338, 191)
    ok = _write_png(tmp_path / "frame.png", 1280, 720)

    with pytest.raises(ValueError) as exc:
        validate_omni_reference_image_dimensions([str(ok), str(small)])

    message = str(exc.value)
    assert "logo.png" in message
    assert "338x191" in message
    assert "300" in message
    assert "frame.png" not in message


def test_validate_omni_reference_image_dimensions_accepts_valid_and_skips_unreadable(
    tmp_path: Path,
) -> None:
    ok = _write_png(tmp_path / "frame.png", 1280, 720)
    missing = tmp_path / "missing.png"
    not_an_image = tmp_path / "notes.txt"
    not_an_image.write_text("hello", encoding="utf-8")

    validate_omni_reference_image_dimensions(
        [str(ok), str(missing), str(not_an_image), ""]
    )


def test_validate_omni_reference_image_dimensions_rejects_extreme_aspect_ratio(
    tmp_path: Path,
) -> None:
    banner = _write_png(tmp_path / "banner.png", 3000, 400)

    with pytest.raises(ValueError) as exc:
        validate_omni_reference_image_dimensions([str(banner)])

    assert "banner.png" in str(exc.value)
    assert "0.4" in str(exc.value) and "2.5" in str(exc.value)
