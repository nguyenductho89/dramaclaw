"""Vietnamese scaffolds for verifier/judge prompts and related prompt builders."""

from __future__ import annotations

import asyncio
import re
from types import SimpleNamespace

import pytest

from novelvideo.verification import prompts as vp

HAN = re.compile(r"[㐀-鿿]")


class _RecAgent:
    def __init__(self, output):
        self.output = output
        self.payload = None

    async def run(self, payload):
        self.payload = payload
        return SimpleNamespace(output=self.output)


@pytest.mark.parametrize("key", sorted(vp._VERIFY_PROMPTS))
def test_verification_prompts_per_language(key):
    zh, vi = vp._VERIFY_PROMPTS[key]
    assert vp.verification_prompt(key, "zh") is zh
    assert vp.verification_prompt(key, "en") is zh  # en keeps the original judge prompt
    assert vp.verification_prompt(key, "vi") is vi
    assert HAN.search(zh)
    assert not HAN.search(vi)


def test_verification_vi_keeps_machine_tokens():
    vi = vp.SKETCH_VERIFY_PROMPT_VI
    for token in ("critical", "warning", "passed = true", '"none"', '"regenerate"', '"edit_script"', "time_of_day", "{{A}}"):
        assert token in vi
    assert "Bạn là người kiểm tra" in vi
    for token in ("face_score", "clothing_score", "appearance_details"):
        assert token in vp.CONSISTENCY_VERIFY_PROMPT_VI
    for token in ("selected_index", "ranking", "comparison_summary"):
        assert token in vp.SKETCH_COMPARE_PROMPT_VI


def test_verifier_language_explicit_wins(monkeypatch):
    assert vp.verifier_language("vi", "你好") == "vi"
    assert vp.verifier_language(None, "你好") == "zh"
    assert vp.verifier_language(None, "Cô gái mở cửa bước vào căn phòng tối.") == "vi"


def test_agents_are_built_per_language(monkeypatch):
    import novelvideo.config as config_module
    import novelvideo.verification.image_verifier as module

    built = []

    class FakeAgent:
        def __init__(self, _model, **kwargs):
            built.append(kwargs["system_prompt"])

    monkeypatch.setattr(module, "Agent", FakeAgent)
    monkeypatch.setattr(config_module, "get_pydantic_model", lambda: object())
    monkeypatch.setattr(config_module, "get_newapi_structured_output_model_settings", lambda: {})

    verifier = module.ImageVerifier()
    zh = verifier._get_agent("zh")
    vi = verifier._get_agent("vi")
    assert zh is not vi
    assert verifier._get_agent("vi") is vi
    assert built == [vp.SKETCH_VERIFY_PROMPT, vp.SKETCH_VERIFY_PROMPT_VI]


@pytest.mark.asyncio
async def test_image_verifier_vi_task(monkeypatch, tmp_path):
    import novelvideo.verification.image_verifier as module
    from novelvideo.verification.models import VerificationResult

    monkeypatch.setattr(module, "compress_image", lambda _p: b"jpeg")
    verifier = module.ImageVerifier(language="vi")
    agent = _RecAgent(
        VerificationResult(passed=True, score=9, issues=[], summary="ok", suggested_action="none")
    )
    verifier._agent = agent
    await verifier.verify_sketch(
        str(tmp_path / "a.png"), "Cô gái mở cửa.", ["Lan"], "Phòng khách", "đêm",
        "cận cảnh", color_mapping={"Lan": "#FF0000 RED"}, resolved_scene_name="Phòng khách",
        time_baked=True, prompt_time_of_day="đêm",
    )
    task = agent.payload[0]
    assert "Kiểm tra phác thảo có khớp với mô tả sau" in task
    assert "khóa theo ánh sáng đêm" in task
    assert "Dấu màu nhân vật" in task and "Tham chiếu ống kính" in task
    assert not HAN.search(task)


@pytest.mark.asyncio
async def test_scorer_comparer_frame_vi_tasks(monkeypatch, tmp_path):
    from novelvideo.verification import frame_verifier, sketch_comparer, sketch_scorer
    from novelvideo.verification.models import CompareResult, ObjectiveScore, VerificationResult

    for mod in (frame_verifier, sketch_comparer, sketch_scorer):
        monkeypatch.setattr(mod, "compress_image", lambda _p, **_k: b"jpeg")

    scorer = sketch_scorer.SketchScorer(language="vi")
    agent = _RecAgent(ObjectiveScore(script_match=8, identity_clarity=8, total=8, issues=[], summary="ok"))
    scorer._agent = agent
    await scorer.score_sketch("x.png", "Cô gái mở cửa.", color_mapping={"Lan": "#F00 RED"})
    assert "Đánh giá mức độ phác thảo tái hiện" in agent.payload[0]
    assert "Dấu màu nhân vật" in agent.payload[0]
    assert not HAN.search(agent.payload[0])

    frame = frame_verifier.FrameVerifier(language="vi")
    agent = _RecAgent(VerificationResult(passed=True, score=9, issues=[], summary="ok", suggested_action="none"))
    frame._agent = agent
    await frame.verify_frame("f.png", "s.png", "Cô gái mở cửa.", "realistic")
    assert "Kiểm tra chất lượng render khung hình đầu" in agent.payload[0]
    assert "Phong cách hình ảnh dự án" in agent.payload[0]
    assert not HAN.search(agent.payload[0])

    comparer = sketch_comparer.SketchComparer(language="vi")
    agent = _RecAgent(CompareResult(selected_index=1, ranking=[], comparison_summary="ok"))
    comparer._agent = agent
    await comparer.compare_sketches([("a", "a.png"), ("b", "b.png")], "Cô gái.", reference_paths=["r.png"])
    texts = [p for p in agent.payload if isinstance(p, str)]
    assert any("So sánh các phác thảo ứng viên" in t for t in texts)
    assert any("Ứng viên 1 (ID: a)" in t for t in texts)
    assert any("Hình tham chiếu 1" in t for t in texts)
    assert not any(HAN.search(t) for t in texts)


@pytest.mark.parametrize("module_name", ["video_prompt_builder", "keyframe_prompt_builder"])
def test_agent_builder_vi_fallbacks(module_name):
    from novelvideo.agents.keyframe_prompt_builder import KeyframePromptBuilder
    from novelvideo.agents.video_prompt_builder import VideoPromptBuilder

    if module_name == "video_prompt_builder":
        vi, zh = VideoPromptBuilder()._fallback_build(5, "vi"), VideoPromptBuilder()._fallback_build(5, "zh")
    else:
        vi, zh = KeyframePromptBuilder()._fallback_build("vi"), KeyframePromptBuilder()._fallback_build("zh")
    assert "Nhân vật" in vi and not HAN.search(vi)
    assert HAN.search(zh)


def test_prompt_builder_environment_reference_vi(monkeypatch):
    from novelvideo.generators.prompt_builder import PromptComponents
    from novelvideo.utils import source_language as sl

    zh = PromptComponents.format_environment_reference("老旧的厨房，木桌")
    assert zh.startswith("环境参考：")
    token = sl._PROJECT_LANGUAGE.set("vi")
    try:
        vi = PromptComponents.format_environment_reference("bếp cũ, bàn gỗ")
    finally:
        sl._PROJECT_LANGUAGE.reset(token)
    assert vi.startswith("Environment reference: bếp cũ, bàn gỗ")
    assert not HAN.search(vi)


def test_voxel_restyle_prompt_vi():
    from novelvideo.generators.voxel_restyle import _build_prompt

    preset = {"style_tag": "PHOTOREALISTIC", "style_instructions": "Create a clean look."}
    for has_master in (True, False):
        zh = _build_prompt("bếp", preset, has_master=has_master)
        assert "图像修复任务" in zh
        assert _build_prompt("bếp", preset, has_master=has_master, language="en") == zh
        vi = _build_prompt("bếp", preset, has_master=has_master, language="vi")
        assert "IMAGE REPAIR TASK" in vi and "bếp" in vi
        assert not HAN.search(vi)


def test_style_analyzer_label_language():
    from novelvideo.generators.style_analyzer import StyleAnalyzer

    analyzer = object.__new__(StyleAnalyzer)
    analyzer.language = None
    assert analyzer.build_analysis_prompt("zh") is StyleAnalyzer.ANALYSIS_PROMPT
    assert analyzer.build_analysis_prompt("en") is StyleAnalyzer.ANALYSIS_PROMPT
    vi = analyzer.build_analysis_prompt("vi")
    assert "A Vietnamese display label" in vi
    assert "水彩幻想风" not in vi
    analyzer.language = "vi"
    assert "A Vietnamese display label" in analyzer.build_analysis_prompt()
