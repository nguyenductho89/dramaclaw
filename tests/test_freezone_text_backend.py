from __future__ import annotations

import io
import json
from pathlib import Path

import pytest
from PIL import Image

from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.api.schemas import (
    FreezoneStoryScriptGenerateData,
    FreezoneStoryScriptRow,
)
from novelvideo.freezone.text_node import (
    FREEZONE_TEXT_WRITER_MODEL,
    FREEZONE_TRANSLATION_MODEL,
    FREEZONE_TRANSLATION_PROVIDER,
    FreezoneTranslationResult,
    bind_story_script_assets,
    build_freezone_character_story_script_task,
    build_freezone_story_script_task,
    build_freezone_translation_task,
    build_freezone_video_story_script_task,
    create_freezone_text_writer_agent,
    generate_freezone_text,
    generate_freezone_story_script_with_vision,
    translate_freezone_text,
)


def _patch_project_resolution(
    monkeypatch: pytest.MonkeyPatch,
    project_dir: Path,
    *,
    username: str = "admin",
):
    async def _fake_resolve(project: str, user: dict, *, required_role: str = "editor"):
        del user, required_role
        return None, username, project, project_dir, str(project_dir)

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", _fake_resolve)


def test_build_freezone_translation_task_mentions_languages_and_node_type() -> None:
    task = build_freezone_translation_task(
        text="Handheld shot, a rainy night street, the character walks slowly forward.",
        node_type="video",
    )

    assert "Video node prompt" in task
    assert "Vietnamese" in task
    assert "English" in task
    assert "You must decide whether the dominant natural language" in task
    assert "Handheld shot" in task


@pytest.mark.asyncio
async def test_translate_freezone_text_trusts_model_detected_direction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, str] = {}

    class FakeAgent:
        async def run(self, task: str):
            captured["task"] = task

            class Response:
                output = FreezoneTranslationResult(
                    translated_text="Tạo một khung phác thảo storyboard cho nhịp NovelVideo.",
                    source_language="en",
                    target_language="vi",
                )

            return Response()

    monkeypatch.setattr(
        "novelvideo.freezone.text_node.get_freezone_translation_agent", FakeAgent
    )

    translated, source_language, target_language = await translate_freezone_text(
        text="Generate ONE storyboard sketch panel for this NovelVideo beat. Color rule: keep [CM_6932]",
        node_type="image",
    )

    assert "You must decide whether the dominant natural language" in captured["task"]
    assert "[CM_6932]" in captured["task"]
    assert translated == "Tạo một khung phác thảo storyboard cho nhịp NovelVideo."
    assert source_language == "en"
    assert target_language == "vi"


@pytest.mark.asyncio
async def test_translate_freezone_text_flips_invalid_same_language_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeAgent:
        async def run(self, _task: str):
            class Response:
                output = FreezoneTranslationResult(
                    translated_text="Đường phố đêm mưa",
                    source_language="vi",
                    target_language="vi",
                )

            return Response()

    monkeypatch.setattr(
        "novelvideo.freezone.text_node.get_freezone_translation_agent", FakeAgent
    )

    translated, source_language, target_language = await translate_freezone_text(
        text="Đường phố đêm mưa",
        node_type="image",
    )

    assert translated == "Đường phố đêm mưa"
    assert source_language == "vi"
    assert target_language == "en"


def test_translation_official_default_uses_brainclaw() -> None:
    assert FREEZONE_TRANSLATION_PROVIDER == "newapi"
    assert FREEZONE_TRANSLATION_MODEL == "brainclaw"


def test_text_writer_uses_plain_text_agent_without_structured_output_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import novelvideo.config as config
    import novelvideo.freezone.text_node as text_node
    from novelvideo.brainclaw_contract import BrainClawProfile

    agent_kwargs: dict[str, object] = {}
    model_kwargs: dict[str, object] = {}

    class FakeAgent:
        def __init__(self, model, **kwargs):
            agent_kwargs["model"] = model
            agent_kwargs.update(kwargs)

    def fake_model(model_env: str, default_model: str | None = None, **kwargs):
        model_kwargs.update(kwargs)
        return model_env, default_model

    monkeypatch.setattr(config, "get_newapi_text_pydantic_model", fake_model)
    monkeypatch.setattr(text_node, "Agent", FakeAgent)

    create_freezone_text_writer_agent()

    assert agent_kwargs["model"] == (
        "FREEZONE_TEXT_WRITER_MODEL",
        None,
    )
    assert model_kwargs == {
        "brainclaw_profile": BrainClawProfile.FREEZONE_TEXT_GENERATION,
    }
    assert "model_settings" not in agent_kwargs


@pytest.mark.asyncio
async def test_generate_freezone_text_returns_configured_model_and_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeAgent:
        async def run(self, prompt: str):
            assert prompt == "Write a short story about a reunion on a rainy night"

            class Response:
                output = "Rain fell on the rails of the old station, and she finally caught the delayed train."

            return Response()

    monkeypatch.setattr("novelvideo.freezone.text_node.get_freezone_text_writer_agent", FakeAgent)

    model, text = await generate_freezone_text(prompt="  Write a short story about a reunion on a rainy night  ")

    assert model == FREEZONE_TEXT_WRITER_MODEL == "brainclaw"
    assert text.startswith("Rain fell on the rails")


def test_build_freezone_story_script_task_mentions_required_columns() -> None:
    task = build_freezone_story_script_task(
        source_text="Mia wakes up in the office late at night.",
        prompt="Fast pace, strong sense of pressure",
    )

    assert "shot number" in task
    assert "visual description" in task
    assert "video motion prompt" in task
    assert "character image 1" in task
    assert "Mia" in task
    assert "Fast pace" in task
    assert "bracketed-segments format" in task
    assert "The shot prompt must read like a high-quality image-generation prompt" in task
    assert "write the shot prompt strictly in 8 segments" in task
    assert "write the video motion prompt strictly in 6 segments" in task
    assert "the second segment of the shot prompt should directly use or lightly adapt character description 1" in task
    assert "keep the technical parameters segment of the shot prompt" in task


@pytest.mark.asyncio
async def test_freezone_text_translate_route_returns_task_id(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir = tmp_path / "project"
    _patch_project_resolution(monkeypatch, project_dir)
    captured: dict[str, object] = {}

    def _fake_start_text_translate_task(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(
        freezone_routes,
        "_start_freezone_text_translate_task",
        _fake_start_text_translate_task,
    )

    result = await freezone_routes.freezone_text_translate(
        project="58",
        body=freezone_routes.FreezoneTextTranslateRequest(
            text="Cinematic close-up, a rainy night street",
            node_type="image",
        ),
        user={"username": "admin"},
    )

    assert result["ok"] is True
    assert result["data"]["task_type"] == "freezone_text_translate"
    assert captured["text"] == "Cinematic close-up, a rainy night street"
    assert captured["node_type"] == "image"


@pytest.mark.asyncio
async def test_freezone_text_generate_route_returns_task_id(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir = tmp_path / "project"
    _patch_project_resolution(monkeypatch, project_dir)
    captured: dict[str, object] = {}

    def _fake_start_text_generate_task(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(
        freezone_routes, "_start_freezone_text_generate_task", _fake_start_text_generate_task
    )

    result = await freezone_routes.freezone_text_generate(
        project="58",
        body=freezone_routes.FreezoneTextGenerateRequest(
            prompt="Write a short story about a reunion on a rainy night",
            canvas_id="canvas_a",
            node_id="node_text",
        ),
        user={"username": "admin"},
    )

    assert result["ok"] is True
    assert result["data"]["task_type"] == "freezone_text_generate"
    assert captured["prompt"] == "Write a short story about a reunion on a rainy night"
    assert captured["canvas_id"] == "canvas_a"
    assert captured["node_id"] == "node_text"


@pytest.mark.asyncio
async def test_freezone_image_reverse_prompt_route_returns_task_id(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir = tmp_path / "project"
    source = project_dir / "freezone" / "_uploads" / "sample.png"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b"fake")

    _patch_project_resolution(monkeypatch, project_dir)
    captured: dict[str, object] = {}

    def _fake_start_image_reverse_prompt_task(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(
        freezone_routes,
        "_start_freezone_image_reverse_prompt_task",
        _fake_start_image_reverse_prompt_task,
    )

    result = await freezone_routes.freezone_image_reverse_prompt(
        project="58",
        body=freezone_routes.FreezoneImageReversePromptRequest(
            source_url="/static/admin/58/freezone/_uploads/sample.png"
        ),
        user={"username": "admin"},
    )

    assert result["ok"] is True
    assert result["data"]["task_type"] == "freezone_image_reverse_prompt"
    assert captured["source_path"] == source


@pytest.mark.asyncio
async def test_freezone_story_script_route_uses_source_text(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir = tmp_path / "project"
    _patch_project_resolution(monkeypatch, project_dir)
    captured: dict[str, object] = {}

    def _fake_start_story_script_task(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(
        freezone_routes,
        "_start_freezone_story_script_task",
        _fake_start_story_script_task,
    )

    result = await freezone_routes.freezone_story_script_generate(
        project="58",
        body=freezone_routes.FreezoneStoryScriptGenerateRequest(
            source_text="Mia wakes up in the office late at night."
        ),
        user={"username": "admin"},
    )

    assert result["ok"] is True
    assert result["data"]["task_type"] == "freezone_story_script"
    assert captured["source_text"] == "Mia wakes up in the office late at night."
    assert captured["prompt"] == "Generate a complete story script from the script I uploaded"
    assert captured["model"] == "newapi_gemini_flash"


@pytest.mark.asyncio
async def test_freezone_story_script_route_reads_source_url_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir = tmp_path / "project"
    source = project_dir / "freezone" / "_uploads" / "script.txt"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text("Mia wakes up in the office late at night.", encoding="utf-8")

    _patch_project_resolution(monkeypatch, project_dir)
    monkeypatch.setattr(
        freezone_routes,
        "resolve_static_url_to_path",
        lambda *_args, **_kwargs: source,
    )
    captured: dict[str, object] = {}

    def _fake_start_story_script_task(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(
        freezone_routes,
        "_start_freezone_story_script_task",
        _fake_start_story_script_task,
    )

    result = await freezone_routes.freezone_story_script_generate(
        project="58",
        body=freezone_routes.FreezoneStoryScriptGenerateRequest(
            source_url="/static/admin/58/freezone/_uploads/script.txt"
        ),
        user={"username": "admin"},
    )

    assert result["ok"] is True
    assert result["data"]["task_type"] == "freezone_story_script"
    assert captured["source_text"] == "Mia wakes up in the office late at night."


def test_story_script_request_keeps_video_and_character_fields() -> None:
    """issue #207 regression: the video / character reference fields sent by the frontend must no longer be silently dropped by Pydantic.

    These fields used to be undeclared in the model, and ``extra="ignore"`` swallowed them together with duration_sec,
    so the "video-reference storyboard script" never handed the video to the model from start to finish.
    """
    body = freezone_routes.FreezoneStoryScriptGenerateRequest.model_validate(
        {
            "video_url": "/static/admin/58/freezone/_uploads/clip.mp4",
            "duration_sec": 15.0,
            "character_refs": [
                {
                    "name": "Mia",
                    "image_url": "/static/admin/58/freezone/_uploads/shen.png",
                    "role": "female lead",
                }
            ],
            "prompt": "Generate a video script",
        }
    )

    assert body.video_url == "/static/admin/58/freezone/_uploads/clip.mp4"
    assert body.duration_sec == 15.0
    assert body.character_refs[0].name == "Mia"
    assert body.character_refs[0].image_url.endswith("shen.png")


@pytest.mark.asyncio
async def test_freezone_story_script_route_enqueues_video_reference(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir = tmp_path / "project"
    video = project_dir / "freezone" / "_uploads" / "clip.mp4"
    video.parent.mkdir(parents=True, exist_ok=True)
    video.write_bytes(b"fake-mp4")

    async def _fake_resolve(project: str, user: dict, *, required_role: str = "editor"):
        del user, required_role
        return object(), "admin", project, project_dir, str(project_dir)

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", _fake_resolve)
    captured: dict[str, object] = {}

    async def _fake_enqueue(**kwargs):
        captured.update(kwargs)
        return {"ok": True, "data": {"task_type": kwargs["task_type"]}}

    monkeypatch.setattr(
        freezone_routes, "_enqueue_freezone_background_job", _fake_enqueue
    )

    result = await freezone_routes.freezone_story_script_generate(
        project="58",
        body=freezone_routes.FreezoneStoryScriptGenerateRequest(
            video_url="/static/admin/58/freezone/_uploads/clip.mp4",
            duration_sec=15.0,
            prompt="Generate a video script",
        ),
        user={"username": "admin"},
    )

    assert result["ok"] is True
    payload = captured["payload"]
    assert payload["video_path"] == video.as_posix()
    assert payload["duration_sec"] == 15.0
    assert payload["max_frames"] == 20
    assert payload["prompt"] == "Generate a video script"
    # The video is the main input, and the frontend is no longer required to disguise the prompt as script body text.
    assert payload["source_text"] == ""


@pytest.mark.asyncio
async def test_freezone_story_script_route_forwards_character_refs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir = tmp_path / "project"
    portrait = project_dir / "freezone" / "_uploads" / "shen.png"
    portrait.parent.mkdir(parents=True, exist_ok=True)
    portrait.write_bytes(b"png")

    _patch_project_resolution(monkeypatch, project_dir)
    captured: dict[str, object] = {}

    def _fake_start_story_script_task(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(
        freezone_routes,
        "_start_freezone_story_script_task",
        _fake_start_story_script_task,
    )

    result = await freezone_routes.freezone_story_script_generate(
        project="58",
        body=freezone_routes.FreezoneStoryScriptGenerateRequest(
            character_refs=[
                freezone_routes.FreezoneStoryScriptCharacterRef(
                    name="Mia",
                    image_url="/static/admin/58/freezone/_uploads/shen.png",
                    role="female lead",
                )
            ],
            prompt="Generate a workplace comeback script",
        ),
        user={"username": "admin"},
    )

    assert result["ok"] is True
    assert captured["character_refs"][0]["name"] == "Mia"
    assert captured["character_image_paths"] == [portrait.as_posix()]


@pytest.mark.asyncio
async def test_freezone_story_script_route_rejects_empty_input(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from fastapi import HTTPException

    _patch_project_resolution(monkeypatch, tmp_path / "project")

    with pytest.raises(HTTPException) as excinfo:
        await freezone_routes.freezone_story_script_generate(
            project="58",
            body=freezone_routes.FreezoneStoryScriptGenerateRequest(),
            user={"username": "admin"},
        )

    assert excinfo.value.status_code == 400


def test_build_freezone_video_story_script_task_describes_the_real_video() -> None:
    task = build_freezone_video_story_script_task(
        frame_count=6,
        prompt="Generate a video script",
        duration_sec=15.0,
    )

    assert "6" in task
    assert "15" in task
    assert "keyframe_index" in task
    assert "Generate a video script" in task


@pytest.mark.asyncio
async def test_generate_story_script_with_vision_attaches_frames(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frames = []
    for index in range(3):
        frame = tmp_path / f"frame_{index}.png"
        Image.new("RGB", (1600, 900), (index * 40, 48, 96)).save(frame)
        frames.append(frame)
    captured: dict[str, object] = {}

    class FakeAgent:
        async def run(self, messages):
            captured["messages"] = messages

            class Response:
                output = FreezoneStoryScriptGenerateData(title="", rows=[])

            return Response()

    monkeypatch.setattr(
        "novelvideo.freezone.text_node.get_freezone_video_story_script_agent",
        FakeAgent,
    )

    await generate_freezone_story_script_with_vision(
        frame_paths=frames,
        prompt="Generate a video script",
        duration_sec=15.0,
    )

    messages = captured["messages"]
    assert isinstance(messages[0], str)
    # The three keyframes must really be sent to the model as attachments, not merely mentioned in the prompt.
    assert len(messages) == 1 + len(frames)
    assert all(
        getattr(item, "media_type", None) == "image/jpeg" for item in messages[1:]
    )
    for item in messages[1:]:
        with Image.open(io.BytesIO(item.data)) as compacted:
            assert compacted.size == (1280, 720)


def test_build_freezone_character_story_script_task_uses_prompt_as_story() -> None:
    task = build_freezone_character_story_script_task(
        image_count=2,
        prompt="Generate a snow mountain duel with these two characters",
        character_refs=[{"name": "Nora"}, {"name": "Blue Swordsman"}],
    )

    assert "2 character reference images" in task
    assert "Generate a snow mountain duel with these two characters" in task
    # Character-image mode has no keyframes, so it must explicitly require keyframe_index to be 0, and not point at frames arbitrarily.
    assert "Always put 0 in keyframe_index" in task
    assert "Nora" in task
    assert "Blue Swordsman" in task
    assert "keyframes" not in task.replace("this mode has no keyframes to backfill", "")


@pytest.mark.asyncio
async def test_generate_story_script_with_vision_accepts_character_images_only(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Once the frontend attaches assets it sends only the prompt and leaves source_text empty;
    # the "character images only" path used to throw ValueError here, and the task was bound to fail.
    portrait = tmp_path / "ningyao.png"
    Image.new("RGB", (640, 960), (24, 48, 96)).save(portrait)
    captured: dict[str, object] = {}

    class FakeAgent:
        async def run(self, messages):
            captured["messages"] = messages

            class Response:
                output = FreezoneStoryScriptGenerateData(title="", rows=[])

            return Response()

    monkeypatch.setattr(
        "novelvideo.freezone.text_node.get_freezone_video_story_script_agent",
        FakeAgent,
    )

    await generate_freezone_story_script_with_vision(
        character_image_paths=[portrait],
        source_text="",
        prompt="Generate a snow mountain duel with this character",
        character_refs=[{"name": "Nora", "image_url": "/static/ningyao.png"}],
    )

    messages = captured["messages"]
    task = messages[0]
    assert isinstance(task, str)
    assert "character reference images" in task
    assert "Generate a snow mountain duel with this character" in task
    assert len(messages) == 2
    assert getattr(messages[1], "media_type", None) == "image/jpeg"
    with Image.open(io.BytesIO(messages[1].data)) as compacted:
        assert compacted.size == (640, 960)


def test_bind_story_script_assets_fills_frames_and_character_images() -> None:
    data = FreezoneStoryScriptGenerateData(
        title="Cat Takes a Walk",
        rows=[
            FreezoneStoryScriptRow(
                shot_no=1,
                duration=4,
                visual_description="The cat walks in from the left of the frame",
                character_1="Banana Cat",
                keyframe_index=2,
            ),
            FreezoneStoryScriptRow(
                shot_no=2,
                duration=4,
                visual_description="The cat stops and looks back",
                character_1="Banana Cat_closeup",
                character_2="Passerby",
                keyframe_index=1,
            ),
        ],
    )

    bind_story_script_assets(
        data,
        frame_urls=["/static/f1.png", "/static/f2.png"],
        character_refs=[
            {"name": "Banana Cat", "image_url": "/static/cat.png"},
            {"name": "Passerby", "image_url": "/static/passerby.png"},
        ],
    )

    assert data.rows[0].reference == "/static/f2.png"
    assert data.rows[1].reference == "/static/f1.png"
    assert data.rows[0].character_image_1 == "/static/cat.png"
    # It must still match when the model writes the character name as a stable ID with a suffix.
    assert data.rows[1].character_image_1 == "/static/cat.png"
    assert data.rows[1].character_image_2 == "/static/passerby.png"


def test_bind_story_script_assets_falls_back_to_row_order_on_bad_index() -> None:
    data = FreezoneStoryScriptGenerateData(
        title="",
        rows=[
            FreezoneStoryScriptRow(
                shot_no=1, duration=3, visual_description="First shot", keyframe_index=99
            ),
            FreezoneStoryScriptRow(
                shot_no=2, duration=3, visual_description="Second shot", keyframe_index=0
            ),
            FreezoneStoryScriptRow(
                shot_no=3, duration=3, visual_description="Third shot", keyframe_index=0
            ),
        ],
    )

    bind_story_script_assets(data, frame_urls=["/static/f1.png", "/static/f2.png"])

    assert data.rows[0].reference == "/static/f1.png"
    assert data.rows[1].reference == "/static/f2.png"
    # When there are not enough frames, the extra shots are left empty, rather than reusing one image cyclically.
    assert data.rows[2].reference == ""


def test_bind_story_script_assets_binds_sole_character_image() -> None:
    data = FreezoneStoryScriptGenerateData(
        title="",
        rows=[
            FreezoneStoryScriptRow(
                shot_no=1, duration=3, visual_description="First shot", character_1="Heroine"
            )
        ],
    )

    bind_story_script_assets(
        data, character_refs=[{"name": "Mia", "image_url": "/static/shen.png"}]
    )

    assert data.rows[0].character_image_1 == "/static/shen.png"


@pytest.mark.asyncio
async def test_freezone_story_script_job_result_returns_json_payload(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir = tmp_path / "project"
    job_id = "storyjob1"
    out = (
        project_dir
        / "freezone"
        / "_outputs"
        / "freezone_story_script"
        / f"{job_id}.json"
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "title": "Writing the World in the Tang Dynasty",
        "rows": [
            {
                "shot_no": 1,
                "duration": 4,
                "visual_description": "Late at night in the modern day, Mia is overworked in the office.",
                "character_1": "",
                "character_description_1": "",
                "character_image_1": "",
                "reference": "",
                "shot": "",
                "character_action": "",
                "emotion": "",
                "scene_tags": "",
                "lighting_mood": "",
                "sound": "",
                "dialogue": "",
                "shot_prompt": "close-up",
                "video_motion_prompt": "slow push-in",
            }
        ],
    }
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    class FakeManager:
        def get_task(self, *args, **kwargs):
            return None

    _patch_project_resolution(monkeypatch, project_dir)
    monkeypatch.setattr(freezone_routes, "get_task_manager", lambda: FakeManager())

    result = await freezone_routes.freezone_job_result(
        project="58",
        task_type="freezone_story_script",
        job_id=job_id,
        user={"username": "admin"},
    )

    assert result["ok"] is True
    assert result["data"]["title"] == "Writing the World in the Tang Dynasty"
    assert result["data"]["rows"][0]["shot_no"] == 1


@pytest.mark.asyncio
async def test_freezone_text_translate_job_result_returns_json_payload(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir = tmp_path / "project"
    job_id = "translatejob1"
    out = (
        project_dir
        / "freezone"
        / "_outputs"
        / "freezone_text_translate"
        / f"{job_id}.json"
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "translated_text": "Today is Monday",
        "source_language": "zh",
        "target_language": "en",
        "node_type": "generic",
    }
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    class FakeManager:
        def get_task(self, *args, **kwargs):
            return None

    _patch_project_resolution(monkeypatch, project_dir)
    monkeypatch.setattr(freezone_routes, "get_task_manager", lambda: FakeManager())

    result = await freezone_routes.freezone_job_result(
        project="58",
        task_type="freezone_text_translate",
        job_id=job_id,
        user={"username": "admin"},
    )

    assert result["ok"] is True
    assert result["data"]["translated_text"] == "Today is Monday"
    assert result["data"]["target_language"] == "en"


@pytest.mark.asyncio
async def test_freezone_text_generate_job_result_returns_json_payload(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir = tmp_path / "project"
    job_id = "textgenerate1"
    out = project_dir / "freezone" / "_outputs" / "freezone_text_generate" / f"{job_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_text": "In the old station on a rainy night, a belated letter changed everyone's choices.",
        "model": "DC-freezone-text-writer-LLM",
    }
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    class FakeManager:
        def get_task(self, *args, **kwargs):
            return None

    _patch_project_resolution(monkeypatch, project_dir)
    monkeypatch.setattr(freezone_routes, "get_task_manager", lambda: FakeManager())

    result = await freezone_routes.freezone_job_result(
        project="58",
        task_type="freezone_text_generate",
        job_id=job_id,
        user={"username": "admin"},
    )

    assert result["ok"] is True
    assert result["data"] == payload


@pytest.mark.asyncio
async def test_freezone_image_reverse_prompt_job_result_returns_json_payload(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir = tmp_path / "project"
    job_id = "reverseprompt1"
    out = (
        project_dir
        / "freezone"
        / "_outputs"
        / "freezone_image_reverse_prompt"
        / f"{job_id}.json"
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "prompt": "A rainy night street, cinematic close-up, the character's profile lit by neon",
    }
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    class FakeManager:
        def get_task(self, *args, **kwargs):
            return None

    _patch_project_resolution(monkeypatch, project_dir)
    monkeypatch.setattr(freezone_routes, "get_task_manager", lambda: FakeManager())

    result = await freezone_routes.freezone_job_result(
        project="58",
        task_type="freezone_image_reverse_prompt",
        job_id=job_id,
        user={"username": "admin"},
    )

    assert result["ok"] is True
    assert result["data"]["prompt"].startswith("A rainy night street")
