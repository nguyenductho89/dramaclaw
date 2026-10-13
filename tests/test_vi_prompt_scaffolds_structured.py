"""Vietnamese prompt scaffolds for the structured / cognee extraction prompts.

For ``vi`` the whole prompt (system prompt, user template, section labels) is
Vietnamese; the only Han characters left are literals code parses back.  For
``zh``/``en`` the prompts stay exactly the pre-existing (Chinese) text.
"""

from __future__ import annotations

import re
from types import SimpleNamespace

from novelvideo import structured_extraction as se
from novelvideo.cognee import pipeline
from novelvideo.cognee import screenplay_normalizer as sn
from novelvideo.cognee.event_extractor import build_event_extraction_prompt
from novelvideo.cognee.store import build_event_assignment_prompt
from novelvideo.story_analysis import SourceChunk, chunk_source_text
from novelvideo.utils.source_language import asset_language_instruction

HAN = re.compile(r"[一-鿿]")

# Literals the code parses or matches on; they must survive verbatim in vi.
CONTRACT_HEADINGS = ("正面", "左侧", "右侧", "背面", "光源", "材质/风格", "禁止元素")
NORMALIZER_LITERALS = (
    "无", "清晨", "上午", "正午", "午后", "白天", "黄昏", "夜晚", "内", "外",
    "日", "昼", "夜", "深夜", "三更", "亥时", "闪回", "特写", "空镜",
)


def han_outside(text: str, allowed: tuple[str, ...] = ()) -> str:
    for literal in sorted(allowed, key=len, reverse=True):
        text = text.replace(literal, "")
    return "".join(HAN.findall(text))


def _chunk() -> SourceChunk:
    return SourceChunk(
        chunk_id="c0",
        chunk_index=0,
        section_type="window",
        section_label="Đoạn 1",
        source_start=0,
        source_end=4,
        text="Lan về nhà.",
    )


def _member(name: str, quotes=("Lan về nhà.",)):
    return se.MergedCharacter(
        name=name,
        aliases={"Bé Lan"},
        gender="female",
        description="mô tả",
        evidence=[
            {
                "quote": q,
                "evidence_text": q,
                "source_start": 0,
                "source_end": len(q),
            }
            for q in quotes
        ],
    )


# ── structured_extraction ──────────────────────────────────────────────────


def test_extraction_system_prompt_is_vietnamese_for_vi_only():
    vi = se.character_extraction_system_prompt("vi")
    assert vi == se.CHARACTER_EXTRACTION_SYSTEM_PROMPT_VI
    assert "Bạn là bộ trích xuất nhân vật" in vi
    assert "evidence.quote" in vi and "appellations" in vi
    assert han_outside(vi) == ""
    for language in ("zh", "en"):
        assert se.character_extraction_system_prompt(language) is se.CHARACTER_EXTRACTION_SYSTEM_PROMPT


def test_chunk_prompt_label_is_vietnamese_for_vi_and_unchanged_otherwise():
    chunk = _chunk()
    vi = se.build_character_chunk_prompt(chunk, "vi")
    assert vi == f"{asset_language_instruction('vi')}\n\n[Đoạn {chunk.section_label}]\n{chunk.text}"
    assert han_outside(vi) == ""
    for language in ("zh", "en"):
        assert se.build_character_chunk_prompt(chunk, language) == (
            f"{asset_language_instruction(language)}\n\n【片段 {chunk.section_label}】\n{chunk.text}"
        )


def test_agent_factory_receives_language_only_for_vi():
    calls = []

    def factory(agent=None, **kwargs):
        calls.append(kwargs)
        return "agent"

    se._call_agent_factory(factory, None, "zh")
    se._call_agent_factory(factory, None, "en")
    se._call_agent_factory(factory, None, "vi")
    assert calls == [{}, {}, {"language": "vi"}]


def test_adjudication_and_appearance_and_scene_prompts_have_vi_variants():
    adj = se.adjudication_system_prompt("vi")
    assert "Bạn là bộ phân xử hợp nhất nhân vật" in adj and "canonical_name" in adj
    appearance = se.character_appearance_system_prompt("vi")
    assert "Bạn là nhà thiết kế hình tượng nhân vật" in appearance
    # The age bands are an enum the code normalises against.
    assert all(band in appearance for band in se.AGE_GROUPS)
    scene = se.scene_adjudication_system_prompt("vi")
    assert "Bạn là bộ phân xử hợp nhất cảnh" in scene
    for text in (adj, appearance, scene):
        assert han_outside(text) == ""
    assert se.adjudication_system_prompt("zh") is se.ADJUDICATION_SYSTEM_PROMPT
    assert se.adjudication_system_prompt("en") is se.ADJUDICATION_SYSTEM_PROMPT
    assert se.character_appearance_system_prompt("en") is se.CHARACTER_APPEARANCE_SYSTEM_PROMPT
    assert se.scene_adjudication_system_prompt("zh") is se.SCENE_ADJUDICATION_SYSTEM_PROMPT


def test_adjudication_user_prompt_vi_and_zh():
    merged = [_member("Lan"), _member("Bé")]
    vi = se._adjudication_prompt(merged, "", "vi")
    assert "Dưới đây là các ứng viên nhân vật" in vi
    assert "xuất hiện 1 lần" in vi and "Nguyên văn:" in vi
    assert han_outside(vi) == ""
    zh = se._adjudication_prompt(merged, "")
    assert zh == se._adjudication_prompt(merged, "", "zh") == se._adjudication_prompt(merged, "", "en")
    assert "（出现 1 次）" in zh and "原文：" in zh


class _Capture:
    def __init__(self, output):
        self.output = output
        self.prompt = ""

    async def run(self, prompt):
        self.prompt = prompt
        return SimpleNamespace(output=self.output)


async def test_appearance_user_prompt_vi_and_zh():
    merged = [_member("Lan")]
    out = se.CharacterAppearanceList(
        characters=[se.CharacterAppearance(name="Lan", face_prompt="Nữ, tóc đen")]
    )
    vi_agent = _Capture(out)
    await se.enrich_character_appearances(
        merged, synopsis="Tóm tắt", agent=vi_agent, output_language="vi"
    )
    assert "Hãy bổ sung thiết lập hình tượng cho từng nhân vật" in vi_agent.prompt
    assert "### Nhân vật: Lan" in vi_agent.prompt and "Biệt danh:" in vi_agent.prompt
    assert "[Tóm tắt kịch bản và nguyên văn thiết lập nhân vật]" in vi_agent.prompt
    assert han_outside(vi_agent.prompt) == ""

    zh_agent = _Capture(out)
    await se.enrich_character_appearances(
        merged, synopsis="Tóm tắt", agent=zh_agent, output_language="zh"
    )
    assert "请为下面每一个角色补全形象设定" in zh_agent.prompt
    assert "### 角色：Lan" in zh_agent.prompt
    assert "【剧本梗概与人物设定原文】" in zh_agent.prompt


async def test_adjudicate_characters_vi_prompt_is_vietnamese():
    agent = _Capture(se.CharacterAdjudication())
    await se.adjudicate_characters(
        [_member("Lan"), _member("Bé")], agent=agent, output_language="vi"
    )
    assert agent.prompt.startswith("Dưới đây là các ứng viên nhân vật")


async def test_scene_adjudication_vi_prompt_and_cache_separation():
    scenes = [
        SimpleNamespace(name="Phòng khách", aliases=[]),
        SimpleNamespace(name="Phòng ăn", aliases=["Bếp"]),
    ]
    vi_agent = _Capture(se.SceneAdjudication())
    await se.adjudicate_scenes(scenes, agent=vi_agent, output_language="vi")
    assert vi_agent.prompt.startswith("Dưới đây là các ứng viên địa điểm")
    assert "xuất hiện 0 cảnh" in vi_agent.prompt and "biệt danh Bếp" in vi_agent.prompt
    assert han_outside(vi_agent.prompt) == ""

    zh_agent = _Capture(se.SceneAdjudication())
    await se.adjudicate_scenes(scenes, agent=zh_agent, output_language="zh")
    assert zh_agent.prompt.startswith("以下是同一部剧本的地点候选：\n")
    assert "（出现 0 场）" in zh_agent.prompt and "，别名 Bếp" in zh_agent.prompt


# ── story_analysis labels ───────────────────────────────────────────────────


def test_chunk_labels_follow_language_and_default_is_unchanged():
    window = "Lan về nhà. " * 20
    zh = chunk_source_text(window, "narrated")
    vi = chunk_source_text(window, "narrated", "vi")
    assert zh[0].section_label == "片段 1"
    assert vi[0].section_label == "Đoạn 1"
    assert [c.chunk_id for c in zh] == [c.chunk_id for c in vi]

    chapters = "第一章\n林默回到了家。\n第二章\n他离开了。"
    assert chunk_source_text(chapters, "narrated")[0].section_label == "第1章 等 2 段"
    assert chunk_source_text(chapters, "narrated", "vi")[0].section_label == (
        "Chương 1 và 1 đoạn khác"
    )


def test_packed_label_is_localised():
    chapters = "".join(f"第{n}章\n短。\n" for n in range(1, 4))
    vi = chunk_source_text(chapters, "narrated", "vi")
    assert any("đoạn khác" in c.section_label for c in vi)
    zh = chunk_source_text(chapters, "narrated")
    assert any(" 等 " in c.section_label for c in zh)


# ── cognee pipeline: scene enrichment ──────────────────────────────────────


def test_scene_enrichment_system_prompt_keeps_machine_headings_verbatim():
    vi = pipeline.scene_enrichment_system_prompt("vi")
    assert "Bạn là chuyên gia thiết kế môi trường cảnh" in vi
    for heading in CONTRACT_HEADINGS:
        assert f"{heading}：" in vi
    assert han_outside(vi, CONTRACT_HEADINGS) == ""
    assert pipeline.scene_enrichment_system_prompt("zh") is pipeline.SCENE_ENRICHMENT_SYSTEM_PROMPT
    assert pipeline.scene_enrichment_system_prompt("en") is pipeline.SCENE_ENRICHMENT_SYSTEM_PROMPT


def test_vietnamese_fallback_contract_is_valid_detectable_and_vietnamese():
    text = pipeline._ensure_directional_environment_prompt(
        prompt="",
        scene_name="Phòng khách",
        scene_type="interior",
        time_of_day="",
        context_lines=[],
        output_language="vi",
    )
    assert pipeline._has_required_scene_environment_headings(text)
    assert [h for h, _ in pipeline.parse_scene_environment_sections(text)] == list(
        CONTRACT_HEADINGS
    )
    assert pipeline.SCENE_FALLBACK_FINGERPRINT_VI in text
    assert not pipeline.is_cacheable_scene_prompt(text)
    assert han_outside(text, CONTRACT_HEADINGS) == ""
    good = "\n".join(f"{h}：nội dung" for h in CONTRACT_HEADINGS)
    assert pipeline.should_repair_scene_placeholder(text, good)


def test_zh_and_en_fallback_contract_unchanged():
    zh = pipeline._ensure_directional_environment_prompt(
        prompt="", scene_name="客厅", scene_type="interior", time_of_day="",
        context_lines=[], output_language="zh",
    )
    assert zh.startswith("正面：以“客厅”最能代表地点身份的主入口")
    en = pipeline._ensure_directional_environment_prompt(
        prompt="", scene_name="Hall", scene_type="interior", time_of_day="",
        context_lines=[], output_language="en",
    )
    assert pipeline.SCENE_FALLBACK_FINGERPRINT_EN in en


def test_scene_cache_key_only_changes_for_vi():
    candidate = {"name": "客厅", "context_lines": ["x"]}
    base = pipeline.scene_enrichment_cache_key(candidate, "")
    assert pipeline.scene_enrichment_cache_key(candidate, "", "zh") == base
    assert pipeline.scene_enrichment_cache_key(candidate, "", "en") == base
    assert pipeline.scene_enrichment_cache_key(candidate, "", "vi") != base


class _SceneAgent:
    def __init__(self):
        self.prompts = []

    async def run(self, prompt):
        self.prompts.append(prompt)
        return SimpleNamespace(output=pipeline.SceneEnrichmentList(scenes=[]))


async def test_scene_enrichment_user_prompts_vi():
    agent = _SceneAgent()
    candidate = {
        "name": "Phòng khách",
        "interior": True,
        "characters": ["Lan"],
        "context_lines": ["Lan bước vào phòng khách."],
    }
    await pipeline.enrich_scene_environments_batched(
        [candidate], synopsis="Tóm tắt", enrichment_agent=agent, output_language="vi"
    )
    batch = agent.prompts[0]
    assert "Hãy tạo environment_prompt riêng cho từng cảnh" in batch
    assert "### Cảnh: Phòng khách" in batch and "Trong nhà/ngoài trời: trong nhà" in batch
    assert "[Tóm tắt câu chuyện và thiết lập nhân vật]" in batch
    assert han_outside(batch) == ""
    single = agent.prompts[1]
    assert "Tên cảnh: Phòng khách" in single and "Nhân vật xuất hiện: Lan" in single
    assert han_outside(single) == ""


async def test_scene_enrichment_user_prompts_zh_unchanged():
    agent = _SceneAgent()
    candidate = {"name": "客厅", "interior": True, "characters": ["林默"], "context_lines": ["林默走进客厅。"]}
    await pipeline.enrich_scene_environments_batched(
        [candidate], enrichment_agent=agent, output_language="zh"
    )
    assert "请为下面每一个场景分别生成 environment_prompt" in agent.prompts[0]
    assert "### 场景：客厅\n室内外：内\n出场人物：林默" in agent.prompts[0]
    assert "场景名称：客厅" in agent.prompts[1] and "室内外：内" in agent.prompts[1]


def test_legacy_graph_prompts_vi_variants():
    for text in (
        pipeline.LEGACY_CHARACTER_GRAPH_SYSTEM_PROMPT_VI,
        pipeline.LEGACY_PROP_GRAPH_SYSTEM_PROMPT_VI,
        pipeline.GRAPH_SCENE_SYSTEM_PROMPT_VI,
    ):
        # 男/女 is the gender literal get_fish_voice_id matches on.
        assert han_outside(text, ("男", "女")) == ""
    assert "男" in pipeline.LEGACY_CHARACTER_GRAPH_SYSTEM_PROMPT_VI
    for value in ("child", "youth", "middle", "elder"):
        assert value in pipeline.LEGACY_CHARACTER_GRAPH_SYSTEM_PROMPT_VI
    for value in ("weapon", "accessory", "artifact", "document", "furniture"):
        assert value in pipeline.LEGACY_PROP_GRAPH_SYSTEM_PROMPT_VI
    for value in ("interior", "exterior", "nature"):
        assert value in pipeline.GRAPH_SCENE_SYSTEM_PROMPT_VI


# ── screenplay normalizer ──────────────────────────────────────────────────


def test_normalizer_system_prompt_vi_keeps_enum_literals():
    vi = sn.screenplay_normalizer_system_prompt("vi")
    assert "Bạn là chuyên viên chuẩn hóa tiêu đề cảnh" in vi
    for literal in ("无", "清晨", "上午", "正午", "午后", "白天", "黄昏", "夜晚"):
        assert literal in vi
    assert han_outside(vi, NORMALIZER_LITERALS) == ""
    batch = sn.screenplay_normalizer_system_prompt("vi", batch=True)
    assert batch.startswith(vi) and "index" in batch
    assert han_outside(batch, NORMALIZER_LITERALS) == ""
    for language in ("zh", "en"):
        assert sn.screenplay_normalizer_system_prompt(language) == sn.SCREENPLAY_NORMALIZER_SYSTEM_PROMPT
        assert sn.screenplay_normalizer_system_prompt(language, batch=True).endswith(
            "并用 index 标明它对应输入中的哪一条。不要遗漏任何一条。"
        )


async def test_normalizer_user_prompts_follow_language():
    header = sn.NormalizedSceneHeader(location="Phòng khách", time_of_day="夜晚", interior_exterior="内")
    agent = _Capture(header)
    await sn.normalize_screenplay_scene_header(
        "Cảnh 1. NỘI. Phòng khách - ĐÊM",
        location_hint="Phòng khách",
        context_lines=["Lan về nhà. Đêm đã khuya."],
        agent=agent,
    )
    assert "Hãy chuẩn hóa siêu dữ liệu của khối cảnh" in agent.prompt
    assert "<scene_header>" in agent.prompt
    assert han_outside(agent.prompt) == ""

    zh_agent = _Capture(header)
    await sn.normalize_screenplay_scene_header(
        "1-1 客厅 夜 内", location_hint="客厅", context_lines=["林默回家。"], agent=zh_agent
    )
    assert "请按系统规则规范化下面这一个场景块的场景元数据。" in zh_agent.prompt
    assert "- scene_no: 无" in zh_agent.prompt


async def test_normalizer_batch_prompt_vi():
    text = "Cảnh 1. Phòng khách\nLan về nhà.\nCảnh 2. Sân vườn\nLan ra ngoài."
    agent = _Capture(sn.NormalizedSceneHeaderBatch(scenes=[]))
    await sn.normalize_screenplay_scenes(text, agent=agent)
    if agent.prompt:
        assert "Hãy chuẩn hóa từng tiêu đề cảnh dưới đây" in agent.prompt
        assert "Tiêu đề cảnh:" in agent.prompt
        assert han_outside(agent.prompt) == ""


# ── event extractor / events -> episodes ───────────────────────────────────


def test_event_extraction_prompt_vi_and_zh():
    vi = build_event_extraction_prompt("Nội dung chương.", "vi")
    assert "Phân tích nội dung chương dưới đây" in vi
    for role in ("exposition", "rising_action", "climax", "falling_action", "resolution", "narrative"):
        assert role in vi
    assert han_outside(vi) == ""
    zh = build_event_extraction_prompt("正文。")
    assert zh == build_event_extraction_prompt("正文。", "en")
    assert zh.startswith("分析以下章节内容，识别其中的独立事件/场景。\n\n章节内容：\n正文。")
    assert zh.endswith("5. 每章通常有 3-8 个事件")


def test_event_assignment_prompt_vi_and_zh():
    vi = build_event_assignment_prompt("[]", 6, 3, "vi")
    assert "Hãy phân bổ 6 sự kiện dưới đây vào 3 tập." in vi
    assert '"assignments"' in vi and "ch1_e1" in vi and "trung bình 2 sự kiện" in vi
    assert han_outside(vi) == ""
    zh = build_event_assignment_prompt("[]", 6, 3)
    assert zh.startswith("将以下 6 个事件分配到 3 集中。")
    assert "平均 2 个" in zh and zh.endswith("只返回 JSON，不要有其他内容。")


# ── prompt preview mirrors the real prompt ─────────────────────────────────


def test_prompt_preview_characters_uses_the_vietnamese_scaffold(monkeypatch, tmp_path):
    import asyncio

    from novelvideo.prompt_preview.registry import PreviewScope, get_step
    from novelvideo.prompt_preview.steps import llm as preview_llm
    from novelvideo.utils.source_language import bind_project_language

    novel = "Lan về nhà. Mẹ đang nấu cơm ở trong bếp. " * 4
    monkeypatch.setattr(preview_llm, "_novel_text", lambda scope: novel)
    bind_project_language({"content_language": "vi"})
    try:
        scope = PreviewScope(
            project_dir=tmp_path,
            state_dir=str(tmp_path / "state"),
            store=SimpleNamespace(),
            config={"spine_template": "narrated"},
            episode=None,
        )
        spec = get_step("characters")
        targets = asyncio.run(spec.targets_fn(scope))
        assert targets and targets[0].label.startswith("Đoạn")
        preview = asyncio.run(spec.build_fn(scope, targets[0].id))
    finally:
        bind_project_language({})
    system, user = preview.parts
    assert system.text == se.CHARACTER_EXTRACTION_SYSTEM_PROMPT_VI
    assert user.text.startswith(asset_language_instruction("vi"))
    assert "[Đoạn " in user.text
