from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from novelvideo.agents import qwen_image_prompt_builder as qwen_prompt
from novelvideo.agents.qwen_image_prompt_builder import (
    QWEN_CANVAS_OFFSET,
    QWEN_MAX_REFERENCES,
    build_qwen_render_draft,
    collect_qwen_references,
    compose_qwen_render_prompt,
    validate_qwen_render_prompt,
)
from novelvideo.config import (
    IMAGE_GENERATION_SELECTIONS,
    QWEN_IMAGE_GENERATION_SELECTION,
    image_generation_selection_options,
)


def _png(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (4, 4)).save(path)
    return path


def _asset(tmp_path: Path, key: str, label: str, *, media_type="image", exists=True, selected=True):
    path = tmp_path / "assets" / f"{key.replace(':', '_')}.png"
    if exists:
        _png(path)
    return SimpleNamespace(
        key=key,
        label=label,
        media_type=media_type,
        path=path,
        exists=exists,
        selected=selected,
        fallback_text="",
    )


def _assets(tmp_path: Path):
    return [
        _asset(tmp_path, "first_frame", "当前 render"),
        _asset(tmp_path, "identity:Anna·Coat", "Anna · Coat"),
        _asset(tmp_path, "prop:Sword", "Sword"),
        _asset(tmp_path, "scene:Hall", "Hall"),
        _asset(tmp_path, "voice:Anna", "Anna voice", media_type="audio"),
        _asset(tmp_path, "identity:Bob·Suit", "Bob · Suit", exists=False),
    ]


def test_qwen_selection_is_visible_and_uses_qwen_model():
    assert QWEN_IMAGE_GENERATION_SELECTION in image_generation_selection_options()
    entry = IMAGE_GENERATION_SELECTIONS[QWEN_IMAGE_GENERATION_SELECTION]
    assert entry["provider"] == "newapi"
    assert "qwen" in entry["model"].lower()


def test_collect_references_orders_scene_identity_prop_after_canvas(tmp_path):
    refs = collect_qwen_references(_assets(tmp_path))

    assert [(r.role, r.number) for r in refs] == [
        ("scene", QWEN_CANVAS_OFFSET + 1),
        ("identity", QWEN_CANVAS_OFFSET + 2),
        ("prop", QWEN_CANVAS_OFFSET + 3),
    ]
    assert refs[0].tag == "<image2>"


def test_collect_references_caps_at_gateway_limit(tmp_path):
    assets = [_asset(tmp_path, f"prop:P{i}", f"P{i}") for i in range(QWEN_MAX_REFERENCES + 3)]

    assert len(collect_qwen_references(assets)) == QWEN_MAX_REFERENCES


def test_validate_prompt_flattens_and_enforces_tags(tmp_path):
    refs = collect_qwen_references(_assets(tmp_path))
    good = "```\n<image2> 是场景，\n<image3> 是人物，<image4> 是道具。\n```"

    assert "\n" not in validate_qwen_render_prompt(good, refs)
    with pytest.raises(ValueError, match="unknown tags"):
        validate_qwen_render_prompt("<image2> <image3> <image4> <image9>", refs)
    with pytest.raises(ValueError, match="never mentions"):
        validate_qwen_render_prompt("<image2> <image3>", refs)
    with pytest.raises(ValueError, match="ratio or resolution"):
        validate_qwen_render_prompt("<image2> <image3> <image4> 画幅 16:9", refs)
    with pytest.raises(ValueError, match="ratio or resolution"):
        validate_qwen_render_prompt("<image2> <image3> <image4> 2K 画质", refs)


def test_draft_follows_source_language_and_mentions_every_tag(tmp_path):
    refs = collect_qwen_references(_assets(tmp_path))
    zh = build_qwen_render_draft(beat={"visual_description": "安娜站在大厅中央"}, references=refs)
    en = build_qwen_render_draft(
        beat={"visual_description": "Anna stands in the middle of the hall."}, references=refs
    )

    for draft in (zh, en):
        assert "\n" not in draft
        validate_qwen_render_prompt(draft, refs)
    assert "场景锚点" in zh
    assert "location anchor" in en


@pytest.mark.asyncio
async def test_compose_falls_back_to_draft_when_agent_output_is_invalid(monkeypatch, tmp_path):
    refs = collect_qwen_references(_assets(tmp_path))

    class _Agent:
        async def run(self, task):
            return SimpleNamespace(output="no tags here")

    monkeypatch.setattr(qwen_prompt, "create_qwen_render_prompt_agent", lambda: _Agent())

    prompt, used_ai = await compose_qwen_render_prompt(
        beat={"visual_description": "安娜站在大厅"}, references=refs
    )

    assert used_ai is False
    validate_qwen_render_prompt(prompt, refs)


@pytest.mark.asyncio
async def test_compose_keeps_valid_agent_output(monkeypatch, tmp_path):
    refs = collect_qwen_references(_assets(tmp_path))

    class _Agent:
        async def run(self, task):
            assert "<image3>" in task
            return SimpleNamespace(output="<image2> 场景。<image3> 人物。<image4> 道具。")

    monkeypatch.setattr(qwen_prompt, "create_qwen_render_prompt_agent", lambda: _Agent())

    prompt, used_ai = await compose_qwen_render_prompt(beat={"visual_description": "x"}, references=refs)

    assert used_ai is True
    assert prompt.startswith("<image2>")


@pytest.mark.asyncio
async def test_generate_beat_render_sends_ordered_refs_and_writes_prompt(monkeypatch, tmp_path):
    from novelvideo.generators import qwen_beat_render

    captured: dict = {}

    async def fake_call(**kwargs):
        captured.update(kwargs)
        return b"png-bytes", "", ""

    async def fake_compose(*, beat, references, style=""):
        return " ".join(ref.tag for ref in references), True

    monkeypatch.setattr(qwen_beat_render, "_call_newapi_image_api", fake_call)
    monkeypatch.setattr(qwen_beat_render, "compose_qwen_render_prompt", fake_compose)
    monkeypatch.setattr(
        qwen_beat_render, "build_seedance2_project_assets", lambda **kwargs: _assets(tmp_path)
    )

    out = tmp_path / "grids" / "ep001" / "render" / "qwen_beat_01.png"
    result = await qwen_beat_render.generate_qwen_beat_render(
        project_output=tmp_path,
        state_dir=tmp_path / "state",
        episode=1,
        beat={"beat_number": 1},
        generator_config={"provider": "newapi", "model": "Qwen-Image-2.1", "api_key": "k", "base_url": "http://gw"},
        aspect_ratio="9:16",
        output_path=out,
    )

    assert out.read_bytes() == b"png-bytes"
    assert out.with_suffix(".prompt.txt").read_text(encoding="utf-8") == "<image2> <image3> <image4>"
    assert len(captured["reference_images"]) == 3
    assert captured["model"] == "Qwen-Image-2.1"
    assert captured["image_config"]["aspect_ratio"] == "9:16"
    assert captured["base_url"] == "http://gw"
    assert result.used_ai_prompt is True


@pytest.mark.asyncio
async def test_generate_beat_render_surfaces_gateway_error(monkeypatch, tmp_path):
    from novelvideo.generators import qwen_beat_render

    async def fake_call(**kwargs):
        return None, "", "boom"

    async def fake_compose(*, beat, references, style=""):
        return "<image2> <image3> <image4>", False

    monkeypatch.setattr(qwen_beat_render, "_call_newapi_image_api", fake_call)
    monkeypatch.setattr(qwen_beat_render, "compose_qwen_render_prompt", fake_compose)
    monkeypatch.setattr(
        qwen_beat_render, "build_seedance2_project_assets", lambda **kwargs: _assets(tmp_path)
    )

    with pytest.raises(RuntimeError, match="boom"):
        await qwen_beat_render.generate_qwen_beat_render(
            project_output=tmp_path,
            state_dir=tmp_path / "state",
            episode=1,
            beat={"beat_number": 1},
            generator_config={"provider": "newapi", "model": "Qwen-Image-2.1", "api_key": "k"},
            aspect_ratio="9:16",
            output_path=tmp_path / "out.png",
        )
    assert not (tmp_path / "out.png").exists()


def test_render_regen_with_qwen_does_not_require_sketch(monkeypatch, tmp_path):
    from tests.test_api_render_regenerate import _client

    client, calls = _client(monkeypatch, tmp_path)
    (tmp_path / "sketches" / "ep002" / "beat_02.png").unlink()

    response = client.post(
        "/api/v1/projects/demo/episodes/2/beats/regenerate",
        json={
            "beat_indices": [1, 2],
            "mode_key": "1x1_9-16",
            "image_generation_selection": QWEN_IMAGE_GENERATION_SELECTION,
        },
    )

    assert response.status_code == 200, response.text
    payload = calls[0]["payload"]
    assert payload["mode_key"] == "1x1_9-16"
    assert payload["config"]["image_generation_selection"] == QWEN_IMAGE_GENERATION_SELECTION


@pytest.mark.asyncio
async def test_runner_promotes_qwen_render_to_frames_without_sketch(monkeypatch, tmp_path):
    from novelvideo.generators import qwen_beat_render
    from novelvideo.task_backend.runners import render
    from novelvideo.utils.path_resolver import PathResolver

    async def fake_generate(*, output_path, beat, **kwargs):
        _png(output_path)
        return SimpleNamespace(
            image_path=output_path, prompt="<image2>", used_ai_prompt=True, references=[1]
        )

    monkeypatch.setattr(qwen_beat_render, "generate_qwen_beat_render", fake_generate)
    paths = PathResolver(str(tmp_path), 1)
    logs: list[str] = []

    result = await render._render_beats_with_qwen(
        envelope={},
        ctx=SimpleNamespace(state_dir=tmp_path / "state"),
        output_dir=str(tmp_path),
        episode=1,
        mode_key="1x1_9-16",
        config={"style": "cinematic"},
        generator_config={"provider": "newapi", "model": "Qwen-Image-2.1"},
        beats=[{"beat_number": 1}, {"beat_number": 2}],
        beat_numbers=[1, 2],
        paths=paths,
        episode_grids_dir=tmp_path / "grids" / "ep001",
        promote_dir=paths.frames_dir(),
        log=lambda message, **kwargs: logs.append(message),
    )

    assert result["updated_beats"] == [1, 2]
    assert paths.frame(1).is_file() and paths.frame(2).is_file()
    assert not paths.sketches_dir().exists()


@pytest.mark.asyncio
async def test_runner_fails_when_every_beat_fails(monkeypatch, tmp_path):
    from novelvideo.generators import qwen_beat_render
    from novelvideo.task_backend.runners import render
    from novelvideo.utils.path_resolver import PathResolver

    async def fake_generate(**kwargs):
        raise RuntimeError("gateway down")

    monkeypatch.setattr(qwen_beat_render, "generate_qwen_beat_render", fake_generate)
    paths = PathResolver(str(tmp_path), 1)

    with pytest.raises(RuntimeError, match="gateway down"):
        await render._render_beats_with_qwen(
            envelope={},
            ctx=SimpleNamespace(state_dir=tmp_path / "state"),
            output_dir=str(tmp_path),
            episode=1,
            mode_key="1x1_9-16",
            config={},
            generator_config={"provider": "newapi", "model": "Qwen-Image-2.1"},
            beats=[{"beat_number": 1}],
            beat_numbers=[1],
            paths=paths,
            episode_grids_dir=tmp_path / "grids" / "ep001",
            promote_dir=paths.frames_dir(),
            log=lambda message, **kwargs: None,
        )
