"""Vietnamese prompt scaffolds for the planning / review / literal-script agents.

For ``vi`` the whole prompt (system prompt, user template, section labels) is
Vietnamese; the only Han characters left are literals code parses back. For
``zh``/``en`` the prompts stay exactly the pre-existing (Chinese) text.
"""

from __future__ import annotations

import re
from types import SimpleNamespace

import pytest

import novelvideo.agents.asset_compiler as asset_compiler
import novelvideo.agents.character_fixer as character_fixer
import novelvideo.agents.character_reviewer as character_reviewer
import novelvideo.agents.content_rewriter as content_rewriter
import novelvideo.agents.episode_fixer as episode_fixer
import novelvideo.agents.episode_planner as episode_planner
import novelvideo.agents.episode_reviewer as episode_reviewer
import novelvideo.agents.identity_planner as identity_planner
from novelvideo.utils.source_language import (
    asset_language_instruction,
    bind_project_language,
)
from novelvideo.workflows import literal_script_writing as lsw
from novelvideo.workflows.literal_script_writing import (
    LiteralBeatMetaOutput,
    LiteralScriptWritingWorkflow,
)

HAN = re.compile(r"[一-鿿]")
VI_INSTRUCTION = asset_language_instruction("vi")


def han(text: str, allowed: tuple[str, ...] = ()) -> str:
    for literal in sorted(allowed, key=len, reverse=True):
        text = text.replace(literal, "")
    return "".join(HAN.findall(text))


@pytest.fixture(autouse=True)
def _reset_project_language():
    bind_project_language({})
    yield
    bind_project_language({})


# --------------------------------------------------------------------------
# character fixer / reviewer
# --------------------------------------------------------------------------


def test_character_fixer_prompt_is_vietnamese_for_vi_and_unchanged_otherwise():
    vi = character_fixer.get_fixer_instructions("vi")
    assert "Bạn là chuyên gia sửa lỗi nhân vật" in vi
    assert "tool_merge_characters(primary_name, alias_names)" in vi
    assert han(vi) == ""
    assert character_fixer.get_fixer_instructions("zh") == character_fixer.FIXER_INSTRUCTIONS
    assert character_fixer.get_fixer_instructions("en") == character_fixer.FIXER_INSTRUCTIONS
    assert character_fixer._fixer_system_prompt("vi").endswith(VI_INSTRUCTION)
    assert character_fixer._fixer_system_prompt("zh") == character_fixer.FIXER_INSTRUCTIONS


def test_character_reviewer_prompt_is_vietnamese_for_vi_and_unchanged_otherwise():
    vi = character_reviewer.get_reviewer_instructions("vi")
    assert "Bạn là chuyên gia rà soát nhân vật" in vi
    assert "duplicate" in vi and "generic" in vi and "identity_error" in vi
    assert han(vi) == ""
    assert (
        character_reviewer.get_reviewer_instructions("en")
        == character_reviewer.REVIEWER_INSTRUCTIONS
    )
    assert character_reviewer._reviewer_system_prompt("vi").endswith(VI_INSTRUCTION)
    assert (
        character_reviewer._reviewer_system_prompt("zh")
        == character_reviewer.REVIEWER_INSTRUCTIONS
    )


def test_character_agents_are_cached_per_language(monkeypatch):
    monkeypatch.setattr(character_fixer, "get_pydantic_model", lambda *a, **k: "test")
    character_fixer._fixer_agents_by_language.clear()
    character_fixer._fixer_agent = None
    zh = character_fixer.get_character_fixer_agent("zh")
    vi = character_fixer.get_character_fixer_agent("vi")
    assert zh is character_fixer.get_character_fixer_agent("en")
    assert vi is character_fixer.get_character_fixer_agent("vi")
    assert zh is not vi


# --------------------------------------------------------------------------
# content rewriter
# --------------------------------------------------------------------------


def test_content_rewriter_prompt_and_task_vi():
    vi = content_rewriter.get_rewrite_prompt("vi")
    assert "Bạn là biên tập viên chuyển thể tiểu thuyết mạng" in vi
    assert "“”" in vi  # the Chinese-style quote contract is kept
    assert han(vi) == ""
    assert content_rewriter.get_rewrite_prompt("zh") == content_rewriter.REWRITE_PROMPT
    assert content_rewriter.get_rewrite_prompt("en") == content_rewriter.REWRITE_PROMPT

    kwargs = dict(
        episode_title="Tập 1",
        protagonist_name="Lan",
        narration_style="first_person",
        target_beats=18,
        min_chars=14,
        max_chars=20,
        source_text="Lan về nhà.",
    )
    task_vi = content_rewriter._build_rewrite_task("vi", **kwargs)
    assert "## Thông tin tập" in task_vi and "Số dòng mục tiêu: 18" in task_vi
    assert han(task_vi) == ""
    assert task_vi.rstrip().endswith(VI_INSTRUCTION)
    task_zh = content_rewriter._build_rewrite_task("zh", **kwargs)
    assert task_zh.startswith("## 剧集信息\n- 标题: Tập 1")
    assert task_zh.endswith("请输出改写后的逐行文本。")


@pytest.mark.asyncio
async def test_rewrite_episode_content_uses_vietnamese_scaffold_for_vi(monkeypatch):
    captured = {}

    class FakeAgent:
        def __init__(self, *args, system_prompt="", **kwargs):
            captured["system"] = system_prompt

        async def run(self, task):
            captured["task"] = task
            return SimpleNamespace(
                output=content_rewriter.AdaptedContentOutput(lines=["Lan về nhà."])
            )

    monkeypatch.setattr(content_rewriter, "Agent", FakeAgent)
    monkeypatch.setattr(
        content_rewriter, "get_newapi_text_pydantic_model", lambda *a, **k: None
    )
    bind_project_language({"content_language": "vi"})
    assert await content_rewriter.rewrite_episode_content("Lan về nhà.") == "Lan về nhà."
    assert captured["system"] == content_rewriter.REWRITE_PROMPT_VI
    assert "## Nguyên tác" in captured["task"]

    bind_project_language({"content_language": "zh"})
    await content_rewriter.rewrite_episode_content("兰回家了。")
    assert captured["system"] == content_rewriter.REWRITE_PROMPT
    assert captured["task"].startswith("## 剧集信息")


# --------------------------------------------------------------------------
# episode planner / reviewer / fixer
# --------------------------------------------------------------------------


def test_episode_planner_prompt_task_and_hint_vi():
    vi = episode_planner.get_episode_planner_prompt("vi")
    assert "Bạn là nhà hoạch định tập phim chuyên nghiệp" in vi
    assert "tool_get_story_structure()" in vi
    assert han(vi) == ""
    assert (
        episode_planner.get_episode_planner_prompt("zh")
        == episode_planner.EPISODE_PLANNER_PROMPT
    )
    assert episode_planner._planner_system_prompt("vi").endswith(VI_INSTRUCTION)
    assert (
        episode_planner._planner_system_prompt("en")
        == episode_planner.EPISODE_PLANNER_PROMPT
    )

    hint_vi = episode_planner._character_hint("vi", ["Lan", "Minh"])
    assert "## Danh sách nhân vật đã biết" in hint_vi and "Lan, Minh" in hint_vi
    assert han(hint_vi) == ""
    assert "## 已知角色列表" in episode_planner._character_hint("zh", ["Lan"])
    assert episode_planner._character_hint("vi", []) == ""

    task_vi = episode_planner._planner_task("vi", 5, hint_vi)
    assert "Hãy hoạch định 5 tập" in task_vi and han(task_vi) == ""
    assert episode_planner._planner_task("zh", 5, "").startswith("请为这部小说规划 5 集")


def test_episode_reviewer_prompt_vi():
    vi = episode_reviewer.get_episode_reviewer_prompt("vi")
    assert "Bạn là biên tập viên thẩm định hoạch định tập phim" in vi
    assert "narrative_discontinuity" in vi and "critical/warning/info" in vi
    assert han(vi) == ""
    assert (
        episode_reviewer.get_episode_reviewer_prompt("en")
        == episode_reviewer.EPISODE_REVIEWER_PROMPT
    )
    assert episode_reviewer._reviewer_system_prompt("vi").endswith(VI_INSTRUCTION)
    assert (
        episode_reviewer._reviewer_system_prompt("zh")
        == episode_reviewer.EPISODE_REVIEWER_PROMPT
    )


def test_episode_fixer_prompts_vi():
    patch_vi = episode_fixer.get_patch_fixer_prompt("vi")
    legacy_vi = episode_fixer.get_episode_fixer_prompt("vi")
    assert "Bạn là biên tập viên sửa lỗi hoạch định tập phim" in patch_vi
    assert "Bạn là biên tập viên sửa lỗi hoạch định tập phim" in legacy_vi
    assert '"field": "characters"' in patch_vi  # field-name contract kept verbatim
    assert "NARRATIVE_DISCONTINUITY" in legacy_vi
    assert han(patch_vi) == "" and han(legacy_vi) == ""
    assert episode_fixer.get_patch_fixer_prompt("zh") == episode_fixer.PATCH_FIXER_PROMPT
    assert (
        episode_fixer.get_episode_fixer_prompt("en") == episode_fixer.EPISODE_FIXER_PROMPT
    )
    assert episode_fixer._system_prompt(
        episode_fixer.get_patch_fixer_prompt, "vi"
    ).endswith(VI_INSTRUCTION)
    assert (
        episode_fixer._system_prompt(episode_fixer.get_patch_fixer_prompt, "zh")
        == episode_fixer.PATCH_FIXER_PROMPT
    )


# --------------------------------------------------------------------------
# identity planner
# --------------------------------------------------------------------------


def test_identity_planner_prompts_vi():
    for getter, zh_const, phrase in (
        (
            identity_planner.get_default_identity_prompt,
            identity_planner.DEFAULT_IDENTITY_PROMPT,
            "Bạn là nhà phân tích hình thái chính của nhân vật điện ảnh",
        ),
        (
            identity_planner.get_other_identity_prompt,
            identity_planner.OTHER_IDENTITY_PROMPT,
            "Bạn là nhà phân tích danh tính thị giác của điện ảnh",
        ),
        (
            identity_planner.get_appearance_generation_prompt,
            identity_planner.APPEARANCE_GENERATION_PROMPT,
            "Bạn là nhà tạo hình trang phục điện ảnh chuyên nghiệp",
        ),
    ):
        vi = getter("vi")
        assert phrase in vi
        assert han(vi) == ""
        assert getter("zh") == zh_const
        assert getter("en") == zh_const
    # enum values the code normalises stay verbatim
    assert "child/youth/middle/elder" in identity_planner.get_default_identity_prompt("vi")


def test_identity_default_system_prompt_and_task_vi():
    system_vi = identity_planner.build_default_identity_system_prompt("x", "vi")
    assert system_vi.endswith(VI_INSTRUCTION)
    assert "Bạn là nhà phân tích hình thái chính" in system_vi
    assert identity_planner.build_default_identity_system_prompt(
        "原文内容"
    ).startswith("# 你是影视角色主线形态分析师")

    common = dict(
        episode_number=2,
        episode_title="Chia tay",
        cast_names=["Lan", "Minh"],
        identity_info="### Lan\n- (chưa có danh tính nào)\n",
        graph_context="Lan là em gái Minh.",
        content_text="Lan về nhà.",
    )
    task_vi = identity_planner.build_default_identity_task(**common, language="vi")
    assert "## Bối cảnh đồ thị tri thức" in task_vi
    assert "## Nhân vật xuất hiện" in task_vi
    assert han(task_vi) == ""
    task_zh = identity_planner.build_default_identity_task(**common)
    assert task_zh.startswith("分析第 2 集《Chia tay》")
    assert "## 图谱上下文" in task_zh


def test_identity_format_character_info_labels_vi_and_zh():
    char = SimpleNamespace(
        name="Lan",
        gender="female",
        age_group="youth",
        face_prompt="mặt tròn",
        body_type="gầy",
        identities=[
            SimpleNamespace(
                identity_id="Lan_Thời thơ ấu",
                appearance_details="",
                face_prompt="mặt bầu bĩnh",
                age_group="child",
            )
        ],
    )

    def render(language):
        return identity_planner.format_character_info(
            ["Lan", "Ghost"],
            lambda name: name,
            lambda name: char if name == "Lan" else None,
            language,
        )

    vi = render("vi")
    assert "Thông tin cơ bản: Giới tính: female" in vi
    assert "Không có mô tả" in vi and "(chưa có danh tính nào)" in vi
    assert han(vi) == ""
    zh = render("zh")
    assert "基础信息: 性别: female" in zh and "（无已有身份）" in zh and "无描述" in zh


def test_identity_special_and_appearance_tasks_vi():
    task_vi = identity_planner._special_identity_task(
        "vi",
        episode_number=1,
        episode_title="T",
        cast_names=["Lan"],
        identity_info="info",
        already_section="\n## Danh tính mặc định đã xác định (không lặp lại)\n- `Lan_x`\n",
        graph_section="",
        content_text="Lan về nhà.",
    )
    assert "**các danh tính khác**" in task_vi and han(task_vi) == ""
    task_zh = identity_planner._special_identity_task(
        "zh",
        episode_number=1,
        episode_title="T",
        cast_names=["Lan"],
        identity_info="info",
        already_section="",
        graph_section="",
        content_text="x",
    )
    assert task_zh.startswith("分析第 1 集《T》中各角色在默认身份之外还需要的**其他身份**")

    appearance_vi = identity_planner._appearance_task(
        "vi",
        character_name="Lan",
        visual_state="Thời thơ ấu",
        default_info="",
        base_info="",
        planned_age_info="",
        reason="hồi tưởng",
    )
    assert "Thiết kế phương án trang phục cho nhân vật điện ảnh hư cấu" in appearance_vi
    assert han(appearance_vi) == ""
    assert identity_planner._appearance_task(
        "zh",
        character_name="Lan",
        visual_state="x",
        default_info="",
        base_info="",
        planned_age_info="",
        reason="r",
    ).startswith("为虚构影视角色「Lan」的「x」造型设计服装方案。")


@pytest.mark.asyncio
async def test_identity_planner_sends_vietnamese_scaffold_for_vi(monkeypatch):
    captured = []

    class FakeAgent:
        def __init__(self, *args, system_prompt="", output_type=None, **kwargs):
            captured.append(("system", system_prompt))
            self.output_type = output_type

        async def run(self, task):
            captured.append(("task", task))
            if self.output_type is identity_planner.AppearanceDescription:
                return SimpleNamespace(
                    output=identity_planner.AppearanceDescription(
                        appearance_details="Áo dài lụa màu xanh ngọc, thắt lưng bạc, tóc búi thấp"
                    )
                )
            if self.output_type is identity_planner.EpisodeDefaultIdentities:
                return SimpleNamespace(
                    output=identity_planner.EpisodeDefaultIdentities(
                        defaults=[
                            identity_planner.DefaultIdentityRequirement(
                                character_name="Lan",
                                visual_state="Thời thanh niên",
                                age_group="youth",
                                reason="tuyến hiện thực",
                            )
                        ]
                    )
                )
            return SimpleNamespace(output=identity_planner.EpisodeIdentityRequirements())

    monkeypatch.setattr(identity_planner, "Agent", FakeAgent)
    monkeypatch.setattr(
        identity_planner.IdentityPlanner,
        "_identity_model",
        staticmethod(lambda _env, **_kwargs: None),
    )
    char = SimpleNamespace(
        name="Lan",
        gender="female",
        age_group="youth",
        face_prompt="",
        body_type="",
        identities=[],
    )
    store = SimpleNamespace(
        resolve_name=lambda n: n,
        get_character=lambda n: char if n == "Lan" else None,
        get_all_characters=lambda: [char],
    )
    planner = identity_planner.IdentityPlanner(store)
    episode = SimpleNamespace(number=1, title="Chia tay")
    bind_project_language({"content_language": "vi"})
    text = "Lan đứng một mình trên sân ga."

    await planner._analyze_default_identities(episode, cast_names=["Lan"], content_text=text)
    await planner._analyze_special_identities(episode, cast_names=["Lan"], content_text=text)
    await planner._generate_appearance("Lan", "Thời thơ ấu", "", "hồi tưởng")

    systems = [v for kind, v in captured if kind == "system"]
    tasks = [v for kind, v in captured if kind == "task"]
    assert len(systems) == 3 and len(tasks) == 3
    for prompt in (*systems, *tasks):
        assert han(prompt) == ""
    for system in systems:
        assert system.endswith(VI_INSTRUCTION)
    assert "Bạn là nhà phân tích hình thái chính" in systems[0]
    assert "Bạn là nhà phân tích danh tính thị giác" in systems[1]
    assert "Bạn là nhà tạo hình trang phục" in systems[2]
    assert "Độ tuổi mặc định: youth" in tasks[0]


# --------------------------------------------------------------------------
# asset compiler
# --------------------------------------------------------------------------


def test_asset_compiler_prompts_vi():
    expected = (
        (
            asset_compiler.BASE_SCENE_RECONCILE_PROMPT,
            asset_compiler.BASE_SCENE_RECONCILE_PROMPT_VI,
            "Bạn là biên tập viên đối chiếu tài sản cảnh nền",
        ),
        (
            asset_compiler.DERIVED_SCENE_PROMPT,
            asset_compiler.DERIVED_SCENE_PROMPT_VI,
            "Bạn là nhà phân tích cảnh phái sinh",
        ),
        (
            asset_compiler.BLOCK_PROP_PROMPT,
            asset_compiler.BLOCK_PROP_PROMPT_VI,
            "Bạn là nhà phân tích đạo cụ then chốt của khối cảnh",
        ),
        (
            asset_compiler.NARRATED_SCENE_PROMPT,
            asset_compiler.NARRATED_SCENE_PROMPT_VI,
            "Bạn là nhà hoạch định tài sản cảnh cho phim thuyết minh",
        ),
    )
    for zh, vi, phrase in expected:
        assert phrase in vi
        assert han(vi) == ""
        assert asset_compiler._system_prompt(zh, vi, "zh") == zh
        assert asset_compiler._system_prompt(zh, vi, "en") == zh
        assert asset_compiler._system_prompt(zh, vi, "vi") == f"{vi}\n{VI_INSTRUCTION}"
    # structured-output contract keys stay verbatim
    assert "prop_name / visual_prompt" in asset_compiler.BLOCK_PROP_PROMPT_VI
    assert "reuse / create / ignore" in asset_compiler.BASE_SCENE_RECONCILE_PROMPT_VI


def test_prop_output_schema_hint_vi():
    assert asset_compiler.get_prop_output_schema_hint("zh") == asset_compiler.PROP_OUTPUT_SCHEMA_HINT
    assert asset_compiler.get_prop_output_schema_hint("en") == asset_compiler.PROP_OUTPUT_SCHEMA_HINT
    hint = asset_compiler.get_prop_output_schema_hint("vi")
    assert "prop_name" in hint and "visual_prompt" in hint and han(hint) == ""


@pytest.mark.asyncio
async def test_asset_compiler_block_props_use_vietnamese_scaffold(monkeypatch):
    captured = {}

    class FakeAgent:
        def __init__(self, model, **kwargs):
            captured["kwargs"] = kwargs

        async def run(self, task):
            captured["task"] = task
            return SimpleNamespace(
                output=asset_compiler.BlockPropRequirements(requirements=[])
            )

    monkeypatch.setattr(asset_compiler, "Agent", FakeAgent)
    monkeypatch.setattr(
        asset_compiler, "get_newapi_text_pydantic_model", lambda *a, **k: "m"
    )
    monkeypatch.setattr(
        asset_compiler, "get_newapi_structured_output_model_settings", lambda: {}
    )
    compiler = asset_compiler.AssetCompiler(SimpleNamespace())
    block = asset_compiler.SceneBlock(
        header_line="Cảnh 1 Hầm nhà đêm trong",
        location="Hầm nhà",
        time_of_day="夜晚",
        interior_exterior="内",
        characters=["Lan"],
        lines=["Lan cầm đèn pin cường độ cao.", "Lan soi vào góc tối."],
    )
    bind_project_language({"content_language": "vi"})
    await compiler._analyze_block_props(block, [], [])

    system = captured["kwargs"]["system_prompt"]
    assert system.startswith(asset_compiler.BLOCK_PROP_PROMPT_VI)
    assert system.endswith(VI_INSTRUCTION)
    assert "Phân tích các đạo cụ then chốt" in captured["task"]
    assert "(không có ứng viên lọc sẵn)" in captured["task"]
    assert captured["kwargs"]["validation_context"]["language"] == "vi"
    # only the verbatim time_of_day literal from the block header remains in the user task
    assert han(captured["task"]) == ""


def test_prop_validator_error_is_localized_by_context_language():
    from pydantic import ValidationError

    payload = {"requirements": [{"prop_name": "đèn", "visual_prompt": "đèn pin"}]}
    with pytest.raises(ValidationError, match="không xuất hiện trong văn bản"):
        asset_compiler.BlockPropRequirements.model_validate(
            payload,
            context={"block_text": "Lan đi", "allowed_existing_names": set(), "language": "vi"},
        )
    with pytest.raises(ValidationError, match="未在当前场景块文本中出现"):
        asset_compiler.BlockPropRequirements.model_validate(
            payload,
            context={"block_text": "Lan đi", "allowed_existing_names": set()},
        )


# --------------------------------------------------------------------------
# literal script writing
# --------------------------------------------------------------------------


def test_literal_script_prompt_vi():
    vi = lsw.get_literal_script_prompt("vi")
    assert "Bạn là biên tập viên chú thích phân cảnh từng dòng" in vi
    for token in ("{{identity_id}}", "[[prop_id]]", "audio_type=dialogue", "scene_id"):
        assert token in vi
    assert han(vi) == ""
    assert lsw.get_literal_script_prompt("zh") == lsw.LITERAL_SCRIPT_PROMPT
    assert lsw.get_literal_script_prompt("en") == lsw.LITERAL_SCRIPT_PROMPT


class _Store:
    output_dir = ""
    _props = {}

    def __init__(self):
        self.episode = SimpleNamespace(
            number=1,
            title="Tập 1",
            identity_ids=[],
            identity_default_map={},
            scene_menu=[],
            prop_menu=[],
        )

    async def load_graph_state(self):
        return None

    async def get_episode_from_graph(self, episode_num):
        return self.episode

    def get_episode(self, episode_num):
        return self.episode

    def get_all_characters(self):
        return []

    async def persist_narration_script(self, script):
        self.persisted = script


class _Agent:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.prompts = []

    async def run(self, prompt):
        self.prompts.append(prompt)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return SimpleNamespace(output=outcome)


@pytest.mark.asyncio
async def test_literal_workflow_user_prompt_is_vietnamese_for_vi(monkeypatch):
    agent = _Agent(
        [
            LiteralBeatMetaOutput(
                audio_type="silence",
                speaker="",
                speaker_kind="character",
                visual_description="Lan đứng một mình trên sân ga.",
                scene_id="",
            )
        ]
    )
    monkeypatch.setattr(
        LiteralScriptWritingWorkflow, "agent", property(lambda _w: agent)
    )
    bind_project_language({"content_language": "vi"})
    store = _Store()
    workflow = LiteralScriptWritingWorkflow(cognee_store=store, sqlite_store=store)
    await workflow.run(
        episode_num=1,
        source_text="SCENE 1 - SÂN GA\nLocation: Sân ga\nLan đứng một mình trên sân ga.",
    )

    prompt = agent.prompts[0]
    assert prompt.startswith(VI_INSTRUCTION)
    assert "Hãy bổ sung siêu dữ liệu beat cho dòng kịch bản hiện tại" in prompt
    assert "## Ngữ cảnh phân cảnh hiện tại" in prompt
    assert "- Số thứ tự dòng: 1/1" in prompt
    assert "Dự án hiện dùng chế độ từng dòng của phim ngắn 2.0" in prompt
    assert han(prompt) == ""


@pytest.mark.asyncio
async def test_literal_workflow_zh_user_prompt_unchanged(monkeypatch):
    agent = _Agent(
        [
            LiteralBeatMetaOutput(
                audio_type="silence",
                speaker="",
                speaker_kind="character",
                visual_description="屋内烛火轻轻摇晃。",
                scene_id="",
            )
        ]
    )
    monkeypatch.setattr(
        LiteralScriptWritingWorkflow, "agent", property(lambda _w: agent)
    )
    store = _Store()
    workflow = LiteralScriptWritingWorkflow(cognee_store=store, sqlite_store=store)
    await workflow.run(episode_num=1, source_text="第1场 苏鸾寝殿 夜 内\n△烛火摇晃。")
    prompt = agent.prompts[0]
    assert "请为第 1 集当前这一行剧本补全 beat 元数据。" in prompt
    assert "- 当前 scene_id: 未锁定" in prompt
    assert "- 当前项目使用 2.0 短剧逐行模式：" in prompt


def test_literal_agent_is_rebuilt_per_language(monkeypatch):
    built = []

    class FakeAgent:
        def __init__(self, *args, system_prompt="", **kwargs):
            built.append(system_prompt)

    monkeypatch.setattr(lsw, "Agent", FakeAgent)
    monkeypatch.setattr(lsw, "get_newapi_text_pydantic_model", lambda *a, **k: None)
    store = _Store()
    workflow = LiteralScriptWritingWorkflow(cognee_store=store, sqlite_store=store)
    workflow._output_language = "zh"
    first = workflow.agent
    assert workflow.agent is first
    workflow._output_language = "vi"
    second = workflow.agent
    assert second is not first
    assert built[0].startswith(lsw.LITERAL_SCRIPT_PROMPT)
    assert built[1].startswith(lsw.LITERAL_SCRIPT_PROMPT_VI)
    assert built[1].endswith(VI_INSTRUCTION)


def test_literal_fallback_texts_vi_and_menus():
    store = _Store()
    workflow = LiteralScriptWritingWorkflow(cognee_store=store, sqlite_store=store)
    workflow._output_language = "vi"
    assert (
        workflow._build_placeholder_line_metadata().visual_description
        == "Dòng này chưa thể tạo được, vui lòng bổ sung thủ công."
    )
    dialogue = workflow._build_fallback_line_metadata("Lan: Đi thôi.")
    assert dialogue.visual_description == "Lan cất lời."
    assert dialogue.audio_type == "dialogue"
    narrator = workflow._build_fallback_line_metadata("Lời dẫn: Đêm xuống.")
    assert narrator.audio_type == "narration"
    assert narrator.speaker_kind == "non_character"
    short = workflow._build_fallback_line_metadata("Ừ.")
    assert short.visual_description == "Hình ảnh giữ nguyên dòng gốc: Ừ."
    blank = workflow._build_fallback_line_metadata("")
    assert blank.visual_description == "Hình ảnh giữ nguyên dòng gốc: dòng trống"

    assert "Menu cảnh khả dụng" in workflow._build_scene_menu_for_episode(store.episode)
    assert "Menu đạo cụ khả dụng" in workflow._build_prop_menu_for_episode(store.episode)
    assert "Danh tính ứng viên" in workflow._format_identity_section({"Lan_x"}, set())
    assert "Đạo cụ ứng viên" in workflow._format_prop_section({"đèn"})
    assert "không thuộc danh tính của tập này" in workflow._format_identity_section(
        {"Lan_x"}, set()
    )
    assert "phim thuyết minh" in _narrated_vi(store)._audio_type_mode_instruction()

    workflow._output_language = "zh"
    assert workflow._build_placeholder_line_metadata().visual_description == "该行未能生成，请手动补充。"
    assert workflow._build_fallback_line_metadata("谢铮：走。").visual_description == "谢铮开口说话。"
    assert (
        workflow._build_fallback_line_metadata("好").visual_description == "画面保留原文：好"
    )
    workflow._output_language = "en"
    assert workflow._build_fallback_line_metadata("MAYA: Go.").visual_description == "MAYA speaks."


def _narrated_vi(store):
    workflow = LiteralScriptWritingWorkflow(
        cognee_store=store, sqlite_store=store, audio_type_mode="narrated"
    )
    workflow._output_language = "vi"
    return workflow


def test_literal_validator_feedback_is_localized():
    from pydantic import ValidationError

    payload = {
        "audio_type": "bogus",
        "visual_description": "Lan đứng đó.",
    }
    with pytest.raises(ValidationError, match="audio_type phải là"):
        LiteralBeatMetaOutput.model_validate(payload, context={"language": "vi"})
    with pytest.raises(ValidationError, match="audio_type 必须是"):
        LiteralBeatMetaOutput.model_validate(payload)
    with pytest.raises(ValidationError, match="phải là một hình ảnh xác định"):
        LiteralBeatMetaOutput.model_validate(
            {"visual_description": "Lan đứng đó 或者 ngồi."}, context={"language": "vi"}
        )
