"""剧集规划 Agent。

使用 PydanticAI Agent 框架 + Cognee 图谱搜索能力进行多轮迭代式剧集规划。
替代原来 pipeline.py 中的单次 LLM 调用，实现更智能的剧集划分。

架构：
    EpisodePlannerAgent
    ├── 工具集 (create_episode_planner_tools)
    │   ├── tool_search_plot_points()       # 搜索情节转折点
    │   ├── tool_search_character_arcs()    # 搜索角色弧线
    │   ├── tool_search_relationship_changes()  # 搜索关系变化
    │   ├── tool_search_timeline_events()   # 按时间搜索事件
    │   ├── tool_get_story_structure()      # 获取故事结构
    │   └── tool_get_all_characters_for_planning()  # 获取角色列表
    │
    └── 多轮迭代
        ├── 第1轮: 搜索全书高潮点/转折点
        ├── 第2轮: 识别角色关系变化节点
        ├── 第3轮: 规划剧集边界
        └── 第4轮: 生成剧集大纲
"""

from typing import Optional, List, Callable, TYPE_CHECKING

from pydantic_ai import Agent
from pydantic import BaseModel, Field

from novelvideo.config import (
    get_newapi_structured_output_model_settings,
    get_pydantic_model,
)
from novelvideo.brainclaw_contract import BrainClawProfile
from novelvideo.cognee.tools import create_episode_planner_tools
from novelvideo.shared.env_guard import preserve_st_env
from novelvideo.utils.logging import log_agent_start, log_agent_end
from novelvideo.utils.source_language import (
    asset_language_instruction,
    resolve_asset_language,
    select_by_language,
)

if TYPE_CHECKING:
    from novelvideo.cognee import CogneeStore
    from novelvideo.models import NovelEpisode


# =============================================================================
# Output Schema
# =============================================================================


class EpisodePlan(BaseModel):
    """单集规划输出。"""

    number: int = Field(description="集数（从1开始）")
    title: str = Field(description="集标题（吸引人、有悬念）", min_length=2)
    chapter_start: int = Field(default=0, description="对应的起始章节（估计值）")
    chapter_end: int = Field(default=0, description="对应的结束章节（估计值）")
    content_summary: str = Field(
        description="内容摘要（50字以内，概括本集主要情节）",
        min_length=10,
        max_length=100,
    )
    main_conflict: str = Field(
        description="主要冲突（本集核心矛盾点）",
    )
    cliffhanger: str = Field(
        description="结尾悬念（让观众想看下一集的钩子）",
        min_length=5,
    )
    key_events: List[str] = Field(
        description="关键事件列表（3-5个）",
        min_length=1,
    )
    character_names: List[str] = Field(
        description="本集出场角色（从已知角色列表中选择）",
        min_length=1,
    )


class EpisodePlannerOutput(BaseModel):
    """剧集规划输出。"""

    episodes: List[EpisodePlan] = Field(description="剧集列表")


# =============================================================================
# Agent Prompt
# =============================================================================


EPISODE_PLANNER_PROMPT = """# 你是专业的剧集规划师

## 任务
将小说内容规划为指定数量的剧集。每集要有独立的冲突和悬念，同时保持整体叙事连贯。

## 工具使用策略（重要）

你有多种图谱搜索工具，请按以下顺序充分使用：

### 第一步：了解故事整体结构
1. 调用 `tool_get_story_structure()` 获取故事整体框架
2. 调用 `tool_get_all_characters_for_planning()` 获取角色列表

### 第二步：识别关键节点
3. 调用 `tool_search_plot_points("主要冲突和转折")` 找出高潮点
4. 调用 `tool_search_timeline_events("从开篇到结局的主要事件")` 获取时间线

### 第三步：分析角色发展
5. 对主要角色调用 `tool_search_character_arcs(角色名)` 了解角色弧线
6. 调用 `tool_search_relationship_changes("主要角色之间的关系变化")` 了解关系演变

### 第四步：确定剧集边界
7. 根据以上信息，找出自然的剧集切分点（如：
   - 重大冲突爆发/解决
   - 角色命运转折
   - 关系重大变化
   - 悬念揭示/新悬念产生）

### 第五步：细化每集内容
8. 对每集的章节范围调用 `tool_search_chapter_summary(范围)` 获取详细内容
9. 调用 `tool_search_cliffhanger_candidates(本集内容)` 找到合适的悬念点

## 剧集规划原则

### 结构要求
- 第1集：建立世界观、引入主角、埋下主线伏笔
- 第2-3集：发展冲突、展开支线
- 中间集：推进主线、角色成长、关系变化
- 倒数2-3集：主要冲突激化、高潮前奏
- 最后1-2集：高潮、结局、留白

### 单集要求
1. **完整性**：每集有独立的开始-发展-高潮
2. **悬念**：每集结尾必须有悬念，让观众想看下一集
3. **冲突**：每集有明确的主要冲突
4. **角色**：限制出场角色数量（3-6人为宜）
5. **时长**：内容量适合 3-5 分钟视频

### cliffhanger 技巧
- 悬念揭示一半（如：门被推开，来人是...）
- 危机降临（如：信使带来坏消息...）
- 反转预告（如：而她不知道的是...）
- 秘密暴露（如：一封信从袖中滑落...）

## 角色引用规范

`character_names` 必须从已知角色列表中选择，不要创造新角色名。

## 输出要求

使用工具充分搜索信息后，输出 EpisodePlannerOutput 格式的 JSON。
确保：
1. 编号从 1 开始连续
2. 每集都有 cliffhanger
3. 角色名与已知列表一致
"""


EPISODE_PLANNER_PROMPT_VI = """# Bạn là nhà hoạch định tập phim chuyên nghiệp

## Nhiệm vụ
Hoạch định nội dung tiểu thuyết thành số tập được chỉ định. Mỗi tập phải có xung đột và nút thắt (hồi hộp) riêng, đồng thời giữ cho toàn bộ mạch kể liền lạc.

## Chiến lược sử dụng công cụ (quan trọng)

Bạn có nhiều công cụ tìm kiếm đồ thị tri thức, hãy sử dụng đầy đủ theo thứ tự sau:

### Bước 1: Nắm cấu trúc tổng thể của câu chuyện
1. Gọi `tool_get_story_structure()` để lấy khung tổng thể của câu chuyện
2. Gọi `tool_get_all_characters_for_planning()` để lấy danh sách nhân vật

### Bước 2: Nhận diện các nút then chốt
3. Gọi `tool_search_plot_points("xung đột chính và các bước ngoặt")` để tìm các điểm cao trào
4. Gọi `tool_search_timeline_events("các sự kiện chính từ mở đầu đến kết thúc")` để lấy dòng thời gian

### Bước 3: Phân tích sự phát triển nhân vật
5. Với các nhân vật chính, gọi `tool_search_character_arcs(tên nhân vật)` để hiểu cung phát triển nhân vật
6. Gọi `tool_search_relationship_changes("thay đổi quan hệ giữa các nhân vật chính")` để hiểu diễn biến quan hệ

### Bước 4: Xác định ranh giới các tập
7. Dựa trên các thông tin trên, tìm ra các điểm cắt tập tự nhiên (ví dụ:
   - Xung đột lớn bùng nổ/được giải quyết
   - Bước ngoặt số phận nhân vật
   - Thay đổi lớn trong quan hệ
   - Bí mật được tiết lộ/xuất hiện nút thắt mới)

### Bước 5: Chi tiết hóa nội dung từng tập
8. Với phạm vi chương của mỗi tập, gọi `tool_search_chapter_summary(phạm vi)` để lấy nội dung chi tiết
9. Gọi `tool_search_cliffhanger_candidates(nội dung tập này)` để tìm điểm hồi hộp phù hợp

## Nguyên tắc hoạch định tập phim

### Yêu cầu về cấu trúc
- Tập 1: xây dựng thế giới quan, giới thiệu nhân vật chính, gieo mầm cho tuyến chính
- Tập 2-3: phát triển xung đột, mở rộng tuyến phụ
- Các tập giữa: đẩy tuyến chính tiến lên, nhân vật trưởng thành, quan hệ thay đổi
- 2-3 tập áp chót: xung đột chính leo thang, dạo đầu cho cao trào
- 1-2 tập cuối: cao trào, kết thúc, chừa khoảng lặng

### Yêu cầu cho mỗi tập
1. **Tính trọn vẹn**: mỗi tập có mở đầu - phát triển - cao trào riêng
2. **Hồi hộp**: cuối mỗi tập phải có nút thắt khiến khán giả muốn xem tập sau
3. **Xung đột**: mỗi tập có xung đột chính rõ ràng
4. **Nhân vật**: hạn chế số nhân vật xuất hiện (3-6 người là hợp lý)
5. **Thời lượng**: lượng nội dung phù hợp với video 3-5 phút

### Kỹ thuật cliffhanger
- Tiết lộ một nửa nút thắt (ví dụ: cánh cửa bị đẩy ra, người bước vào là...)
- Khủng hoảng ập đến (ví dụ: sứ giả mang tin xấu tới...)
- Báo trước đảo ngược (ví dụ: nhưng cô không biết rằng...)
- Bí mật bị phơi bày (ví dụ: một lá thư rơi ra từ tay áo...)

## Quy phạm tham chiếu nhân vật

`character_names` bắt buộc chọn từ danh sách nhân vật đã biết, không được tạo tên nhân vật mới.

## Yêu cầu đầu ra

Sau khi dùng công cụ tìm kiếm đầy đủ thông tin, xuất JSON theo định dạng EpisodePlannerOutput.
Đảm bảo:
1. Số thứ tự bắt đầu từ 1 và liên tục
2. Mỗi tập đều có cliffhanger
3. Tên nhân vật khớp với danh sách đã biết
"""


def get_episode_planner_prompt(language: str = "zh") -> str:
    """Return the planner system prompt written in ``language``."""
    return select_by_language(
        language, zh=EPISODE_PLANNER_PROMPT, vi=EPISODE_PLANNER_PROMPT_VI
    )


def _planner_system_prompt(language: str | None) -> str:
    language = language or resolve_asset_language("")
    prompt = get_episode_planner_prompt(language)
    if language == "vi":
        prompt = f"{prompt}\n{asset_language_instruction('vi')}"
    return prompt


def _character_hint(language: str, known_characters: List[str]) -> str:
    if not known_characters:
        return ""
    names = ", ".join(known_characters)
    if language == "vi":
        return f"""

## Danh sách nhân vật đã biết
Dưới đây là các nhân vật đã được xác nhận, trường character_names chỉ được chọn từ danh sách này:
{names}
"""
    return f"""

## 已知角色列表
以下是已确认的角色，character_names 字段只能从此列表选择：
{names}
"""


def _planner_task(language: str, target_episodes: int, character_hint: str) -> str:
    if language == "vi":
        return f"""Hãy hoạch định {target_episodes} tập cho cuốn tiểu thuyết này.
{character_hint}

Hãy thực hiện theo các bước sau:

1. Trước hết gọi tool_get_story_structure() để nắm cấu trúc tổng thể của câu chuyện
2. Gọi tool_get_all_characters_for_planning() để xác nhận danh sách nhân vật
3. Gọi tool_search_plot_points("xung đột chính và cao trào") để tìm các nút then chốt
4. Gọi tool_search_timeline_events("từ mở đầu đến kết thúc") để lấy dòng thời gian
5. Dựa trên kết quả tìm kiếm để hoạch định {target_episodes} tập

Đảm bảo:
- Mỗi tập có xung đột và nút thắt riêng
- Tên nhân vật chỉ dùng tên trong danh sách đã biết
- cliffhanger phải khiến khán giả muốn xem tập sau
"""
    return f"""请为这部小说规划 {target_episodes} 集。
{character_hint}

请按照以下步骤操作：

1. 首先调用 tool_get_story_structure() 了解故事整体结构
2. 调用 tool_get_all_characters_for_planning() 确认角色列表
3. 调用 tool_search_plot_points("主要冲突和高潮") 找出关键节点
4. 调用 tool_search_timeline_events("从开篇到结局") 获取时间线
5. 根据搜索结果规划 {target_episodes} 集

确保：
- 每集有独立的冲突和悬念
- 角色名只使用已知列表中的名字
- cliffhanger 要吸引观众想看下一集
"""


# =============================================================================
# Agent Factory
# =============================================================================


def create_episode_planner_agent(
    tools: List[Callable], language: str | None = None
) -> Agent:
    """创建剧集规划 Agent。

    Args:
        tools: 剧集规划工具列表
        language: 提示词语言；缺省取项目声明语言（vi 使用越南语提示词，其余保持原中文）

    Returns:
        配置好的 Agent
    """
    return Agent(
        get_pydantic_model(brainclaw_profile=BrainClawProfile.EPISODE_STORY_PLANNING),
        system_prompt=_planner_system_prompt(language),
        tools=tools,
        output_type=EpisodePlannerOutput,
        model_settings=get_newapi_structured_output_model_settings(),
        output_retries=3,
        name="剧集规划师",
    )


# =============================================================================
# EpisodePlannerAgent 类
# =============================================================================


# Legacy-only AI episode planner.
# No current frontend workflow selects this mode: the "plan episodes" button
# posts an empty body (frontend/src/routes/_app/projects.$project/episodes.tsx),
# so planning_mode falls back to the "chapters" default in api/schemas.py.
# Reaching this code still requires an explicit planning_mode="ai" from an API
# client. Structured-v2 projects must not enter this path.
class EpisodePlannerAgent:
    """剧集规划 Agent - 使用图谱搜索进行多轮迭代式规划。

    通过充分利用 Cognee 图谱搜索能力，生成更高质量的剧集规划。

    示例:
        >>> planner = EpisodePlannerAgent(cognee_store)
        >>> episodes = await planner.plan_episodes(target_episodes=10)
    """

    def __init__(self, store: "CogneeStore"):
        """初始化剧集规划 Agent。

        Args:
            store: CogneeStore 实例（用于图谱搜索）
        """
        self.store = store
        self.tools = create_episode_planner_tools(store)

    async def plan_episodes(
        self,
        target_episodes: int,
        known_characters: Optional[List[str]] = None,
        on_progress: Optional[Callable[[float, str], None]] = None,
        on_log: Optional[Callable[[str], None]] = None,
        language: Optional[str] = None,
    ) -> List["NovelEpisode"]:
        """规划剧集。

        使用 Agent 进行多轮迭代式规划：
        1. 搜索故事结构和高潮点
        2. 识别角色关系变化节点
        3. 规划剧集边界
        4. 生成剧集大纲

        Args:
            target_episodes: 目标剧集数
            known_characters: 已知角色名称列表（用于限制角色引用）
            on_progress: 进度回调
            on_log: 日志回调

        Returns:
            规划的剧集列表
        """
        from novelvideo.models import NovelEpisode

        def report(progress: float, task: str):
            if on_progress:
                on_progress(progress, task)

        def log(message: str):
            if on_log:
                on_log(message)
            print(f"[EpisodePlanner] {message}")

        log_agent_start("剧集规划师", f"规划 {target_episodes} 集")
        report(0.1, "初始化规划...")

        # 获取已知角色列表
        if known_characters is None:
            characters = await self.store.list_characters()
            known_characters = [c.name for c in characters]
        log(f"已知角色: {len(known_characters)} 个")

        language = language or resolve_asset_language("")

        # 构建角色提示
        character_hint = _character_hint(language, known_characters)

        # 创建 Agent
        agent = create_episode_planner_agent(self.tools, language=language)

        # 构建任务
        task = _planner_task(language, target_episodes, character_hint)

        report(0.2, "Agent 搜索故事信息...")
        log("开始多轮搜索...")

        try:
            # 运行 Agent（会自动进行多轮工具调用）
            result = await agent.run(task)

            report(0.7, "解析规划结果...")

            # 解析输出
            output = result.output

            log(f"Agent 返回 {len(output.episodes)} 集规划")

            # 转换为 NovelEpisode
            episodes = []
            for plan in output.episodes:
                episode = NovelEpisode(
                    number=plan.number,
                    title=plan.title,
                    chapter_start=plan.chapter_start,
                    chapter_end=plan.chapter_end,
                    content_summary=plan.content_summary,
                    main_conflict=plan.main_conflict,
                    cliffhanger=plan.cliffhanger,
                    key_events=plan.key_events,
                    character_names=plan.character_names,
                    project_name=self.store.project_name,
                )
                episodes.append(episode)

            # 验证和修正编号
            episodes = self._validate_and_fix_episodes(episodes, target_episodes, log)

            log_agent_end("剧集规划师", success=True, result=f"规划 {len(episodes)} 集")
            report(1.0, "完成")

            return episodes

        except Exception as e:
            log_agent_end("剧集规划师", success=False, result=str(e))
            log(f"Agent 规划失败: {e}")
            raise

    def _validate_and_fix_episodes(
        self,
        episodes: List["NovelEpisode"],
        target_count: int,
        log: Callable[[str], None],
    ) -> List["NovelEpisode"]:
        """验证并修正剧集列表。

        确保：
        - 编号从 1 开始
        - 编号连续
        - 数量符合预期

        Args:
            episodes: 原始剧集列表
            target_count: 目标数量
            log: 日志函数

        Returns:
            修正后的剧集列表
        """
        if not episodes:
            return episodes

        # 按编号排序
        episodes.sort(key=lambda ep: ep.number)

        # 检查编号是否从 1 开始
        if episodes[0].number != 1:
            log(f"修正编号：从 {episodes[0].number} 改为从 1 开始")
            for i, ep in enumerate(episodes, start=1):
                ep.number = i

        # 检查编号是否连续
        for i, ep in enumerate(episodes, start=1):
            if ep.number != i:
                log(f"修正编号 {ep.number} → {i}")
                ep.number = i

        # 检查数量
        if len(episodes) < target_count:
            log(f"警告：规划的集数 ({len(episodes)}) 少于目标 ({target_count})")
        elif len(episodes) > target_count:
            log(f"警告：规划的集数 ({len(episodes)}) 多于目标 ({target_count})")

        return episodes

# =============================================================================
# 工厂函数
# =============================================================================


def create_episode_planner(store: "CogneeStore") -> EpisodePlannerAgent:
    """创建剧集规划 Agent。

    Args:
        store: CogneeStore 实例

    Returns:
        EpisodePlannerAgent 实例
    """
    return EpisodePlannerAgent(store)
