"""MiniMax H3 (Ref2VA) prompt composer."""

from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.seedance2_i2v import h3_prompt
from novelvideo.seedance2_i2v.assets import Seedance2ResolvedAsset
from novelvideo.seedance2_i2v.models import Seedance2I2VMode

VALID_PROMPT = """subject_definitions:
<Picture 1> is the first frame of [Shot 1], showing a woman at a window.
<Subject 1> is the wooden desk from <Picture 2>.

summary:
[keyframe completion + reference generation] A woman looks up from a desk.

retention_analysis:
<Picture 1> ([Shot 1] first frame): fully_preserved - the opening composition is kept.
<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - the desk is kept.

detailed_description:
The target video is live-action and cinematic.
[Shot 1] A medium shot frames the woman. The camera pushes in with small amplitude at slow speed.
[Shot 2] At 00:03.000, the camera cuts to a close-up of the desk <Subject 1>.

overall_soundscape:
Soft room tone continues throughout.

non_diegetic_music:
N/A"""


def _image(n: int, key: str, field: str = "reference_images") -> Seedance2ResolvedAsset:
    return Seedance2ResolvedAsset(
        key=key,
        label=f"asset {n}",
        media_type="image",
        path=Path(f"/tmp/img{n}.png"),
        exists=True,
        selected=True,
        request_field=field,
        reference_label=f"图片{n}",
        image_number=n,
    )


def _audio(n: int) -> Seedance2ResolvedAsset:
    return Seedance2ResolvedAsset(
        key=f"voice:{n}",
        label=f"voice {n}",
        media_type="audio",
        path=Path(f"/tmp/voice{n}.mp3"),
        exists=True,
        selected=True,
        request_field="reference_audios",
        reference_label=f"音频{n}",
        audio_number=n,
    )


def _validate(prompt: str, **kwargs) -> str:
    params = {"n_pictures": 2, "n_audios": 0, "duration": 5.0}
    params.update(kwargs)
    return h3_prompt.validate_h3_prompt(prompt, **params)


def test_reference_label_maps_seedance_tokens():
    assert h3_prompt.h3_reference_label("图片3") == "<Picture 3>"
    assert h3_prompt.h3_reference_label("音频1") == "<Audio 1>"
    assert h3_prompt.h3_reference_label("未发送") == ""


def test_effective_duration_matches_gateway_frame_grid():
    assert h3_prompt.h3_effective_duration(8) == 8.0
    assert h3_prompt.h3_effective_duration(5) == pytest.approx(124 / 24, abs=1e-3)
    assert h3_prompt.h3_effective_duration(1) == h3_prompt.h3_effective_duration(4)
    assert h3_prompt.h3_effective_duration(99) == h3_prompt.h3_effective_duration(15)


def test_manifest_uses_h3_labels_and_caps_references():
    assets = [_image(n, f"img:{n}") for n in range(1, 12)] + [_audio(n) for n in range(1, 6)]

    manifest = h3_prompt.build_h3_asset_manifest(assets)

    assert [i["h3_label"] for i in manifest if i["media_type"] == "image"] == [
        f"<Picture {n}>" for n in range(1, 10)
    ]
    assert [i["h3_label"] for i in manifest if i["media_type"] == "audio"] == [
        f"<Audio {n}>" for n in range(1, 4)
    ]
    assert all("label" not in item for item in manifest)


def test_composer_task_carries_duration_and_first_frame_label():
    task = h3_prompt.build_h3_prompt_composer_task(
        mode=Seedance2I2VMode.FIRST_FRAME,
        beat={"visual_description": "A woman at a window."},
        assets=[_image(1, "first_frame", "image_url")],
        text_overlay={},
        prompt_guidance="",
        draft_prompt="draft",
        duration=5,
    )

    assert '"first_frame_label": "<Picture 1>"' in task
    assert '"duration_seconds": 5.1667' in task
    assert "图片" not in task.split("{", 1)[1]


@pytest.mark.parametrize(
    "mode", [Seedance2I2VMode.TEXT_TO_VIDEO, Seedance2I2VMode.FIRST_LAST_FRAME]
)
def test_unsupported_modes_are_rejected(mode):
    with pytest.raises(ValueError, match="MiniMax H3"):
        h3_prompt.build_h3_prompt_composer_task(
            mode=mode,
            beat={},
            assets=[],
            text_overlay={},
            prompt_guidance="",
            draft_prompt="",
        )


def test_validate_accepts_well_formed_prompt():
    assert _validate(VALID_PROMPT, require_picture_1=True) == VALID_PROMPT


def test_validate_strips_code_fence():
    assert _validate(f"```text\n{VALID_PROMPT}\n```") == VALID_PROMPT


@pytest.mark.parametrize(
    ("prompt", "message"),
    [
        (VALID_PROMPT.replace("summary:", "overview:"), "six sections"),
        (
            VALID_PROMPT.replace("summary:", "TMP:").replace(
                "retention_analysis:", "summary:"
            ).replace("TMP:", "retention_analysis:"),
            "six sections",
        ),
        (VALID_PROMPT + "\n<Picture 3>", "<Picture 3>"),
        (VALID_PROMPT.replace("<Picture 2>", "图片2"), "Seedance reference tokens"),
        (VALID_PROMPT.replace("[Shot 1]", "[Shot 1] At 00:00.500,"), "must not carry a timestamp"),
        (VALID_PROMPT.replace("At 00:03.000, ", ""), "needs an 'At MM:SS.mmm'"),
        (VALID_PROMPT.replace("00:03.000", "00:00.800"), "closer than 1.2 seconds"),
        (VALID_PROMPT.replace("00:03.000", "00:05.000"), "outside"),
        (VALID_PROMPT.replace("[Shot 2]", "[Shot 3]"), "numbered"),
    ],
)
def test_validate_rejects_contract_violations(prompt, message):
    with pytest.raises(ValueError, match=message):
        _validate(prompt)


def test_validate_requires_picture_1_for_first_frame():
    with pytest.raises(ValueError, match="<Picture 1>"):
        _validate(VALID_PROMPT.replace("<Picture 1>", "<Picture 2>"), require_picture_1=True)


def test_draft_is_structurally_valid_for_both_modes():
    first = h3_prompt.build_h3_prompt_draft(
        mode=Seedance2I2VMode.FIRST_FRAME,
        beat={"visual_description": "A woman at a window.", "dialogue": "Hello there."},
        assets=[_image(1, "first_frame", "image_url")],
        text_overlay={},
    )
    multi = h3_prompt.build_h3_prompt_draft(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat={"visual_description": "Ji-won walks.", "scene_description": "A subway corridor."},
        assets=[_image(1, "first_frame"), _image(2, "scene:subway"), _audio(1)],
        text_overlay={},
    )

    _validate(first, n_pictures=1, require_picture_1=True)
    _validate(multi, n_pictures=2, n_audios=1)
    assert "[keyframe completion + reference generation]" in first
    assert "<d>[English] Hello there.</d>" in first
    assert "[reference generation + audio reference]" in multi


def test_multi_reference_draft_anchors_render_and_cites_pictures_in_subjects():
    draft = h3_prompt.build_h3_prompt_draft(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat={"visual_description": "Ji-won walks."},
        assets=[_image(1, "first_frame"), _image(2, "identity:Ji-won"), _image(3, "scene:subway")],
        text_overlay={},
    )

    _validate(draft, n_pictures=3)
    assert "<Picture 1> is a storyboard reference for [Shot 1]" in draft
    assert "<Picture 1> (anchors [Shot 1]): partially_preserved" in draft
    assert "<Subject 1> is " in draft and "taken from <Picture 2>" in draft
    assert "<Picture 2> is" not in draft


def test_select_reference_assets_sends_audio_up_to_highest_mentioned():
    assets = [_image(1, "first_frame"), _image(2, "scene:a"), _audio(1), _audio(2), _audio(3)]

    none_used = h3_prompt.select_h3_reference_assets(assets, "no audio here")
    second_used = h3_prompt.select_h3_reference_assets(assets, "voice from <Audio 2>")

    assert [a.reference_label for a in none_used[0]] == ["图片1", "图片2"]
    assert none_used[1] == []
    assert [a.reference_label for a in second_used[1]] == ["音频1", "音频2"]


def test_select_reference_assets_includes_first_frame_image_url():
    images, audios = h3_prompt.select_h3_reference_assets(
        [_image(1, "first_frame", "image_url")], ""
    )

    assert [a.key for a in images] == ["first_frame"]
    assert audios == []


async def test_generate_uses_ai_prompt_when_valid():
    seen = {}

    async def composer(**kwargs):
        seen.update(kwargs)
        return VALID_PROMPT

    result = await h3_prompt.generate_h3_prompt(
        mode=Seedance2I2VMode.FIRST_FRAME,
        beat={"visual_description": "A woman."},
        assets=[_image(1, "first_frame", "image_url"), _image(2, "scene:a", "reference_images")],
        text_overlay={},
        prompt_guidance="",
        duration=5,
        composer=composer,
    )

    assert result.used_ai and result.prompt == VALID_PROMPT and result.error == ""
    assert seen["duration"] == 5


async def test_generate_falls_back_to_draft_on_invalid_or_failed_composer():
    async def invalid(**_kwargs):
        return "just some prose"

    async def boom(**_kwargs):
        raise RuntimeError("model down")

    kwargs = dict(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat={"visual_description": "A woman."},
        assets=[_image(1, "first_frame")],
        text_overlay={},
        prompt_guidance="",
        duration=5,
    )
    bad = await h3_prompt.generate_h3_prompt(composer=invalid, **kwargs)
    down = await h3_prompt.generate_h3_prompt(composer=boom, **kwargs)

    assert not bad.used_ai and bad.prompt == bad.draft_prompt and "six sections" in bad.error
    assert not down.used_ai and down.error == "model down"


async def test_agent_run_returns_plain_text(monkeypatch):
    class FakeAgent:
        async def run(self, task):
            assert "Output only the final prompt" in task
            return SimpleNamespace(output=VALID_PROMPT)

    monkeypatch.setattr(h3_prompt, "create_h3_prompt_composer_agent", lambda: FakeAgent())

    out = await h3_prompt.compose_h3_prompt_with_agent(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat={},
        assets=[],
        text_overlay={},
        prompt_guidance="",
        draft_prompt="",
    )

    assert out == VALID_PROMPT


def test_composer_agent_uses_h3_model_env(monkeypatch):
    import novelvideo.config as config

    calls = []
    agent_kwargs = {}

    def fake_model(model_env, default_model=None, **kwargs):
        calls.append((model_env, default_model, kwargs["capability"]))
        return "h3-model"

    class FakeAgent:
        def __init__(self, model, **kwargs):
            agent_kwargs["model"] = model
            agent_kwargs.update(kwargs)

    monkeypatch.setattr(config, "get_newapi_text_pydantic_model", fake_model)
    monkeypatch.setattr("pydantic_ai.Agent", FakeAgent)

    h3_prompt.create_h3_prompt_composer_agent()

    assert calls == [("H3_PROMPT_COMPOSER_MODEL", None, "text.generate.workflow")]
    assert agent_kwargs["model"] == "h3-model"
    assert "six sections" in agent_kwargs["system_prompt"] or "Ref2VA" in agent_kwargs["system_prompt"]


def test_composer_leaf_declares_workflow_capability():
    tree = ast.parse(Path("src/novelvideo/seedance2_i2v/h3_prompt.py").read_text(encoding="utf-8"))
    composer = next(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "create_h3_prompt_composer_agent"
    )
    calls = [
        node
        for node in ast.walk(composer)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "get_newapi_text_pydantic_model"
    ]

    assert len(calls) == 1
    capability = next(k.value for k in calls[0].keywords if k.arg == "capability")
    assert isinstance(capability, ast.Constant) and capability.value == "text.generate.workflow"


@pytest.mark.parametrize(
    ("backend", "expected"),
    [
        ("newapi_MiniMax-H3", True),
        ("newapi_MiniMax-H3-local", True),
        ("MiniMax-H3", True),
        ("newapi_seedance-2.0", False),
        ("comfyui", False),
        (None, False),
    ],
)
def test_is_minimax_h3_backend(backend, expected):
    from novelvideo.seedance2_i2v.pipeline import is_minimax_h3_backend

    assert is_minimax_h3_backend(backend) is expected


def _prepare(monkeypatch, assets, config: dict, **overrides):
    import json

    from novelvideo.seedance2_i2v import panel_service

    monkeypatch.setattr(
        panel_service, "build_seedance2_project_assets", lambda **_kwargs: list(assets)
    )
    monkeypatch.setattr(
        panel_service, "_append_seedance2_user_reference_assets", lambda _assets, _config: None
    )
    params = dict(
        project_dir="/tmp/out",
        state_dir="/tmp/state",
        episode=1,
        beat={"beat_number": 3, "seedance2_config_json": json.dumps(config)},
        next_beat=None,
        prompt="",
        duration=5,
        ratio=None,
    )
    params.update(overrides)
    return panel_service.prepare_h3_beat_request(**params)


def test_prepare_first_frame_sends_only_labelled_images(monkeypatch):
    out = _prepare(
        monkeypatch,
        [_image(1, "first_frame", "image_url")],
        {"mode": "first_frame", "final_prompt": "<Picture 1> prompt", "duration": 8, "ratio": "9:16"},
    )

    assert out["references"] == [{"type": "image", "path": "/tmp/img1.png", "role": "<Picture 1>"}]
    assert out["prompt"] == "<Picture 1> prompt"
    assert (out["duration"], out["ratio"]) == (8, "9:16")


def test_prepare_multi_reference_orders_images_then_used_audio(monkeypatch):
    out = _prepare(
        monkeypatch,
        [_image(2, "scene:a"), _image(1, "first_frame"), _audio(1), _audio(2)],
        {"mode": "multimodal_reference", "final_prompt": "voice from <Audio 1>"},
    )

    assert [(r["type"], r["role"]) for r in out["references"]] == [
        ("image", "<Picture 1>"),
        ("image", "<Picture 2>"),
        ("audio", "<Audio 1>"),
    ]


def test_prepare_clamps_duration_and_falls_back_on_unknown_ratio(monkeypatch):
    out = _prepare(
        monkeypatch,
        [_image(1, "first_frame")],
        {"mode": "multimodal_reference", "final_prompt": "p", "duration": 40, "ratio": "2:3"},
    )

    assert (out["duration"], out["ratio"]) == (15, "16:9")
    assert _prepare(
        monkeypatch,
        [_image(1, "first_frame")],
        {"mode": "multimodal_reference", "final_prompt": "p", "duration": 1},
        ratio="1:1",
    )["ratio"] == "1:1"


def test_prepare_uses_legacy_prompt_when_config_has_none(monkeypatch):
    out = _prepare(
        monkeypatch,
        [_image(1, "first_frame")],
        {"mode": "multimodal_reference"},
        prompt="legacy video prompt",
    )

    assert out["prompt"] == "legacy video prompt"


@pytest.mark.parametrize(
    ("assets", "config", "message"),
    [
        ([_image(1, "first_frame")], {"mode": "text_to_video", "final_prompt": "p"}, "MiniMax H3"),
        ([_image(1, "first_frame")], {"mode": "first_last_frame", "final_prompt": "p"}, "MiniMax H3"),
        ([_image(1, "first_frame")], {"mode": "multimodal_reference"}, "Beat 3"),
        ([], {"mode": "multimodal_reference", "final_prompt": "p"}, "至少一张参考图"),
    ],
)
def test_prepare_rejects_unrunnable_requests(monkeypatch, assets, config, message):
    with pytest.raises(ValueError, match=message):
        _prepare(monkeypatch, assets, config)
