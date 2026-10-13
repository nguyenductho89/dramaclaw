"""分集规划修复 Agent。

使用 LLM 智能修复分集规划问题，同时保留规则修复作为基础。
"""

import copy
import difflib
from typing import TYPE_CHECKING, Callable, Optional

from pydantic_ai import Agent
from pydantic import BaseModel, Field

from novelvideo.config import (
    get_newapi_structured_output_model_settings,
    get_pydantic_model,
)
from novelvideo.agents.episode_reviewer import (
    EpisodePlanIssueType,
    EpisodePlanIssue,
)
from novelvideo.utils.source_language import (
    asset_language_instruction,
    resolve_asset_language,
    select_by_language,
)


# =============================================================================
# LLM Agent Prompt
# =============================================================================


# =============================================================================
# Patch-based Fixer Prompt（新版，精准修复）
# =============================================================================


PATCH_FIXER_PROMPT = """# 你是专业的短视频分集规划修复员

## ⚠️ 核心原则：精准修复

**只输出需要修改的字段！** 不要重新生成整个规划。

对于每个问题，明确指出：
1. 哪一集 (episode_number)
2. 哪个字段 (field)
3. 新值 (new_value)
4. 修复理由 (reason)

## 可修改的字段

| 字段 | 说明 | 示例 |
|------|------|------|
| `title` | 集标题 | "皇后寺庙遇亡夫？" |
| `summary` | 内容摘要 | "皇后在寺庙遇到..." |
| `cliffhanger` | 结尾悬念 | "他究竟是谁？" |
| `characters` | 出场角色（逗号分隔） | "姜裳宁,谢成,冯有章" |
| `chapter_start` | 起始章节 | "3" |
| `chapter_end` | 结束章节 | "5" |
| `key_events` | 关键事件（逗号分隔） | "皇后回宫,揭露真相" |

## 修复流程

### 第一步：分析问题

仔细阅读审核报告中的问题，分类：

| 问题类型 | 修复策略 |
|---------|---------|
| 无效角色名 | 只修改 `characters` 字段，替换为有效名称 |
| 叙事断裂 | 修改 `summary` 添加过渡，或调整 `chapter_start/chapter_end` |
| 悬念较弱 | 只修改 `cliffhanger` 字段 |
| 标题不吸引 | 只修改 `title` 字段 |

### 第二步：生成补丁

对于每个需要修复的字段，生成一个 EpisodePatch：

```json
{
  "episode_number": 2,
  "field": "characters",
  "new_value": "姜裳宁,谢成",
  "reason": "移除无效角色'昭婕妤'"
}
```

### 第三步：验证

- 检查补丁是否足够解决问题
- 不要添加不必要的修改
- 不要改动没问题的字段

## 工具使用

修复前可调用工具确认正确信息：

| 工具 | 用途 |
|------|------|
| `get_all_characters()` | 获取有效角色名列表 |
| `get_chapter_content(start, end)` | 获取章节内容 |
| `check_continuity(ep1, ep2)` | 检查两集连贯性 |

## 输出要求

返回 FixPlan，只包含需要修改的补丁：

```json
{
  "patches": [
    {"episode_number": 2, "field": "characters", "new_value": "姜裳宁,谢成", "reason": "..."},
    {"episode_number": 3, "field": "cliffhanger", "new_value": "...", "reason": "..."}
  ],
  "summary": "修复了2个问题：移除无效角色，加强悬念"
}
```

**重要**:
1. 只输出需要修改的字段
2. 不要重复原有内容
3. 不要引入新问题
"""


PATCH_FIXER_PROMPT_VI = """# Bạn là biên tập viên sửa lỗi hoạch định tập phim video ngắn chuyên nghiệp

## ⚠️ Nguyên tắc cốt lõi: sửa chính xác

**Chỉ xuất những trường cần sửa!** Không tạo lại toàn bộ bản hoạch định.

Với mỗi vấn đề, chỉ rõ:
1. Tập nào (episode_number)
2. Trường nào (field)
3. Giá trị mới (new_value)
4. Lý do sửa (reason)

## Các trường có thể sửa

| Trường | Mô tả | Ví dụ |
|------|------|------|
| `title` | Tiêu đề tập | "Hoàng hậu gặp lại vong phu ở chùa?" |
| `summary` | Tóm tắt nội dung | "Hoàng hậu gặp ở chùa..." |
| `cliffhanger` | Nút thắt cuối tập | "Rốt cuộc hắn là ai?" |
| `characters` | Nhân vật xuất hiện (ngăn cách bằng dấu phẩy) | "Khương Thường Ninh,Tạ Thành,Phùng Hữu Chương" |
| `chapter_start` | Chương bắt đầu | "3" |
| `chapter_end` | Chương kết thúc | "5" |
| `key_events` | Sự kiện then chốt (ngăn cách bằng dấu phẩy) | "Hoàng hậu hồi cung,vạch trần sự thật" |

## Quy trình sửa

### Bước 1: Phân tích vấn đề

Đọc kỹ các vấn đề trong báo cáo thẩm định và phân loại:

| Loại vấn đề | Chiến lược sửa |
|---------|---------|
| Tên nhân vật không hợp lệ | Chỉ sửa trường `characters`, thay bằng tên hợp lệ |
| Đứt gãy tự sự | Sửa `summary` để thêm chuyển tiếp, hoặc điều chỉnh `chapter_start/chapter_end` |
| Nút thắt yếu | Chỉ sửa trường `cliffhanger` |
| Tiêu đề kém hấp dẫn | Chỉ sửa trường `title` |

### Bước 2: Tạo bản vá

Với mỗi trường cần sửa, tạo một EpisodePatch:

```json
{
  "episode_number": 2,
  "field": "characters",
  "new_value": "Khương Thường Ninh,Tạ Thành",
  "reason": "Loại bỏ nhân vật không hợp lệ 'Chiêu Tiệp Dư'"
}
```

### Bước 3: Kiểm chứng

- Kiểm tra bản vá đã đủ để giải quyết vấn đề chưa
- Không thêm những chỉnh sửa không cần thiết
- Không động vào những trường không có vấn đề

## Sử dụng công cụ

Trước khi sửa có thể gọi công cụ để xác nhận thông tin chính xác:

| Công cụ | Công dụng |
|------|------|
| `get_all_characters()` | Lấy danh sách tên nhân vật hợp lệ |
| `get_chapter_content(start, end)` | Lấy nội dung chương |
| `check_continuity(ep1, ep2)` | Kiểm tra tính liền mạch giữa hai tập |

## Yêu cầu đầu ra

Trả về FixPlan, chỉ chứa các bản vá cần sửa:

```json
{
  "patches": [
    {"episode_number": 2, "field": "characters", "new_value": "Khương Thường Ninh,Tạ Thành", "reason": "..."},
    {"episode_number": 3, "field": "cliffhanger", "new_value": "...", "reason": "..."}
  ],
  "summary": "Đã sửa 2 vấn đề: loại bỏ nhân vật không hợp lệ, tăng cường nút thắt"
}
```

**Quan trọng**:
1. Chỉ xuất những trường cần sửa
2. Không lặp lại nội dung gốc
3. Không tạo ra vấn đề mới
4. Giá trị field phải viết đúng nguyên văn như bảng trên (title/summary/cliffhanger/characters/chapter_start/chapter_end/key_events); new_value, reason, summary viết bằng tiếng Việt; tên nhân vật giữ nguyên văn
"""


# =============================================================================
# 旧版 Prompt（保留向后兼容）
# =============================================================================


EPISODE_FIXER_PROMPT = """# 你是专业的短视频分集规划修复员

## 修复优先级

| 优先级 | 问题类型 | 说明 |
|--------|----------|------|
| 1 | 叙事连贯性 | 故事线必须通顺，这是最重要的 |
| 2 | 人物弧线 | 保持角色发展逻辑一致 |
| 3 | 悬念设置 | 每集结尾要能留住观众 |
| 4 | 节奏控制 | 张弛有度，高潮分布合理 |
| 5 | 格式规范 | 章节范围、角色名等技术问题 |

## 修复原则

1. **最小修改原则**: 只修复问题部分，保持原有优点
2. **保持风格一致**: 修复内容要与原规划风格统一
3. **验证修复效果**: 修复后不能引入新问题
4. **给出修复理由**: 说明为什么这样修复

## 工具使用

在修复过程中，你可以调用以下工具获取上下文：

| 工具 | 用途 |
|------|------|
| `get_chapter_content(start, end)` | 获取章节内容，用于生成准确的标题/摘要 |
| `get_character_state(name, episode)` | 获取角色在某集的状态 |
| `generate_cliffhanger(episode, context)` | 为某集生成合适的悬念 |
| `improve_title(episode, context)` | 改进某集的标题 |
| `check_continuity(ep1, ep2)` | 检查两集之间的连贯性 |

## 常见问题修复策略

### 1. 叙事断裂 (NARRATIVE_DISCONTINUITY)
- 调用 `get_chapter_content` 理解情节
- 调整集与集之间的章节划分
- 添加过渡内容到摘要中

### 2. 节奏问题 (PACING_ISSUE)
- 分析高潮点分布
- 重新分配章节，让高潮更均匀
- 确保不连续出现多个平淡集

### 3. 人物弧线断裂 (CHARACTER_ARC_BROKEN)
- 调用 `get_character_state` 检查角色发展
- 调整角色出场安排
- 修改摘要以体现角色发展

### 4. 悬念较弱 (WEAK_CLIFFHANGER)
- 调用 `generate_cliffhanger` 生成新悬念
- 悬念要具体、有画面感
- 要能引发观众好奇心

### 5. 标题不吸引人 (POOR_TITLE / MISSING_TITLE)
- 调用 `improve_title` 获取建议
- 标题要体现冲突或悬念
- 使用疑问句或感叹句效果更好

### 6. 章节问题 (CHAPTER_GAP / OVERLAP)
- 调整 chapter_start 和 chapter_end
- 确保覆盖所有章节
- 不要有重叠

### 7. 角色名问题 (INVALID_CHARACTER)
- 使用已分析的角色名替换
- 如果找不到匹配，尝试模糊匹配
- 实在无法匹配则删除该角色

## 输出要求

返回修复后的 SeriesPlan，包含所有剧集的完整信息。
每个 EpisodePlan 应包含：
- number: 集数
- title: 标题（修复后）
- chapter_start, chapter_end: 章节范围（修复后）
- summary: 摘要（修复后）
- key_events: 关键事件
- characters: 出场角色（使用有效名称）
- cliffhanger: 结尾悬念（修复后）

**重要**:
1. 保持原有优点不变
2. 只修改有问题的部分
3. 修复后检查是否引入新问题
"""


EPISODE_FIXER_PROMPT_VI = """# Bạn là biên tập viên sửa lỗi hoạch định tập phim video ngắn chuyên nghiệp

## Thứ tự ưu tiên sửa lỗi

| Ưu tiên | Loại vấn đề | Mô tả |
|--------|----------|------|
| 1 | Tính mạch lạc của tự sự | Mạch truyện phải thông suốt, đây là điều quan trọng nhất |
| 2 | Cung phát triển nhân vật | Giữ logic phát triển nhân vật nhất quán |
| 3 | Thiết lập hồi hộp | Cuối mỗi tập phải giữ chân được khán giả |
| 4 | Kiểm soát nhịp điệu | Chặt - lỏng hợp lý, cao trào phân bố hợp lý |
| 5 | Quy phạm định dạng | Các vấn đề kỹ thuật như phạm vi chương, tên nhân vật |

## Nguyên tắc sửa lỗi

1. **Nguyên tắc sửa tối thiểu**: chỉ sửa phần có vấn đề, giữ nguyên những ưu điểm sẵn có
2. **Giữ nhất quán phong cách**: nội dung sửa phải thống nhất với phong cách của bản hoạch định gốc
3. **Kiểm chứng hiệu quả sửa**: sau khi sửa không được tạo ra vấn đề mới
4. **Nêu lý do sửa**: giải thích vì sao sửa như vậy

## Sử dụng công cụ

Trong quá trình sửa, bạn có thể gọi các công cụ sau để lấy ngữ cảnh:

| Công cụ | Công dụng |
|------|------|
| `get_chapter_content(start, end)` | Lấy nội dung chương, dùng để viết tiêu đề/tóm tắt chính xác |
| `get_character_state(name, episode)` | Lấy trạng thái của nhân vật ở một tập |
| `generate_cliffhanger(episode, context)` | Tạo nút thắt phù hợp cho một tập |
| `improve_title(episode, context)` | Cải thiện tiêu đề của một tập |
| `check_continuity(ep1, ep2)` | Kiểm tra tính liền mạch giữa hai tập |

## Chiến lược sửa các vấn đề thường gặp

### 1. Đứt gãy tự sự (NARRATIVE_DISCONTINUITY)
- Gọi `get_chapter_content` để hiểu cốt truyện
- Điều chỉnh cách chia chương giữa các tập
- Thêm nội dung chuyển tiếp vào tóm tắt

### 2. Vấn đề nhịp điệu (PACING_ISSUE)
- Phân tích phân bố các điểm cao trào
- Phân bổ lại các chương để cao trào đều hơn
- Đảm bảo không xuất hiện liên tiếp nhiều tập nhạt nhòa

### 3. Đứt gãy cung nhân vật (CHARACTER_ARC_BROKEN)
- Gọi `get_character_state` để kiểm tra sự phát triển của nhân vật
- Điều chỉnh việc sắp xếp nhân vật xuất hiện
- Sửa tóm tắt để thể hiện sự phát triển của nhân vật

### 4. Nút thắt yếu (WEAK_CLIFFHANGER)
- Gọi `generate_cliffhanger` để tạo nút thắt mới
- Nút thắt phải cụ thể, giàu hình ảnh
- Phải khơi dậy sự tò mò của khán giả

### 5. Tiêu đề kém hấp dẫn (POOR_TITLE / MISSING_TITLE)
- Gọi `improve_title` để lấy đề xuất
- Tiêu đề phải thể hiện xung đột hoặc hồi hộp
- Dùng câu hỏi hoặc câu cảm thán sẽ hiệu quả hơn

### 6. Vấn đề chương (CHAPTER_GAP / OVERLAP)
- Điều chỉnh chapter_start và chapter_end
- Đảm bảo bao phủ tất cả các chương
- Không để chồng lấn

### 7. Vấn đề tên nhân vật (INVALID_CHARACTER)
- Thay bằng tên nhân vật đã được phân tích
- Nếu không tìm thấy tên khớp, thử so khớp mờ
- Thực sự không khớp được thì xóa nhân vật đó

## Yêu cầu đầu ra

Trả về SeriesPlan sau khi sửa, gồm đầy đủ thông tin của tất cả các tập.
Mỗi EpisodePlan cần gồm:
- number: số tập
- title: tiêu đề (sau khi sửa)
- chapter_start, chapter_end: phạm vi chương (sau khi sửa)
- summary: tóm tắt (sau khi sửa)
- key_events: sự kiện then chốt
- characters: nhân vật xuất hiện (dùng tên hợp lệ)
- cliffhanger: nút thắt cuối tập (sau khi sửa)

**Quan trọng**:
1. Giữ nguyên những ưu điểm sẵn có
2. Chỉ sửa phần có vấn đề
3. Sau khi sửa kiểm tra xem có tạo ra vấn đề mới không
"""


def get_patch_fixer_prompt(language: str = "zh") -> str:
    """Return the patch-fixer system prompt written in ``language``."""
    return select_by_language(language, zh=PATCH_FIXER_PROMPT, vi=PATCH_FIXER_PROMPT_VI)


def get_episode_fixer_prompt(language: str = "zh") -> str:
    """Return the legacy full-plan fixer system prompt written in ``language``."""
    return select_by_language(language, zh=EPISODE_FIXER_PROMPT, vi=EPISODE_FIXER_PROMPT_VI)


def _system_prompt(getter: Callable[[str], str], language: str | None) -> str:
    language = language or resolve_asset_language("")
    prompt = getter(language)
    if language == "vi":
        return f"{prompt}\n{asset_language_instruction('vi')}"
    return prompt


# =============================================================================
# Patch-based 修复模型（精准修复，只改需要改的部分）
# =============================================================================


class EpisodePatch(BaseModel):
    """单集修复补丁。

    只描述需要修改的字段，未提及的字段保持不变。
    """

    episode_number: int = Field(description="要修复的集数")
    field: str = Field(
        description="要修改的字段: title/summary/cliffhanger/characters/chapter_start/chapter_end/key_events"
    )
    new_value: str = Field(
        description="新值（对于 characters/key_events，用逗号分隔多个值）"
    )
    reason: str = Field(description="修复理由（简短说明）")


class FixPlan(BaseModel):
    """修复计划（只包含需要修改的部分）。

    比 FixedSeriesPlan 更精准，只输出变更的字段，
    避免 LLM 在生成完整规划时引入新问题。
    """

    patches: list[EpisodePatch] = Field(
        description="修复补丁列表（只列出需要修改的字段）"
    )
    summary: str = Field(default="", description="修复总结")


# =============================================================================
# 旧模型（保留用于向后兼容）
# =============================================================================


class FixedEpisodePlan(BaseModel):
    """修复后的单集规划（旧模型，向后兼容）。"""

    number: int
    title: str
    chapter_start: int
    chapter_end: int
    summary: str
    key_events: list[str] = Field(default_factory=list)
    characters: list[str] = Field(default_factory=list)
    cliffhanger: str = ""


class FixedSeriesPlan(BaseModel):
    """修复后的系列规划（旧模型，向后兼容）。"""

    total_episodes: int
    episodes: list[FixedEpisodePlan] = Field(default_factory=list)
    fix_notes: str = Field(default="", description="修复说明")


# =============================================================================
# LLM Agent 创建
# =============================================================================


def create_episode_fixer_agent(
    tools: Optional[list[Callable]] = None, language: str | None = None
) -> Agent:
    """创建分集规划修复 Agent（旧版，输出完整规划）。

    Args:
        tools: 修复工具函数列表
        language: 提示词语言；缺省取项目声明语言（vi 使用越南语提示词，其余保持原中文）

    Returns:
        配置好的 Agent
    """
    return Agent(
        get_pydantic_model(),
        system_prompt=_system_prompt(get_episode_fixer_prompt, language),
        tools=tools or [],
        output_type=FixedSeriesPlan,
        model_settings=get_newapi_structured_output_model_settings(),
        name="分集规划修复员",
    )


def create_patch_fixer_agent(
    tools: Optional[list[Callable]] = None, language: str | None = None
) -> Agent:
    """创建 Patch-based 修复 Agent（新版，只输出补丁）。

    优点：
    - 精准修复，只改需要改的字段
    - 避免重新生成时引入新问题
    - 输出更小，响应更快

    Args:
        tools: 修复工具函数列表
        language: 提示词语言；缺省取项目声明语言（vi 使用越南语提示词，其余保持原中文）

    Returns:
        配置好的 Agent
    """
    return Agent(
        get_pydantic_model(),
        system_prompt=_system_prompt(get_patch_fixer_prompt, language),
        tools=tools or [],
        output_type=FixPlan,
        model_settings=get_newapi_structured_output_model_settings(),
        name="分集规划修复员",
    )


def apply_patches(plan: "SeriesPlan", fix_plan: FixPlan) -> "SeriesPlan":
    """将补丁应用到规划上。

    Args:
        plan: 原规划
        fix_plan: 修复计划（包含补丁列表）

    Returns:
        修复后的规划（深拷贝）
    """
    fixed = copy.deepcopy(plan)

    # 按集数建立索引
    episode_map = {ep.number: ep for ep in fixed.episodes}

    for patch in fix_plan.patches:
        ep = episode_map.get(patch.episode_number)
        if not ep:
            print(f"  [Patch] 警告: 第 {patch.episode_number} 集不存在，跳过")
            continue

        field = patch.field.lower()
        value = patch.new_value

        try:
            if field == "title":
                ep.title = value
            elif field == "summary":
                ep.summary = value
            elif field == "cliffhanger":
                ep.cliffhanger = value
            elif field == "characters":
                # 逗号分隔的角色列表
                ep.characters = [c.strip() for c in value.split(",") if c.strip()]
            elif field == "key_events":
                # 逗号分隔的事件列表
                ep.key_events = [e.strip() for e in value.split(",") if e.strip()]
            elif field == "chapter_start":
                ep.chapter_start = int(value)
            elif field == "chapter_end":
                ep.chapter_end = int(value)
            else:
                print(f"  [Patch] 警告: 未知字段 '{field}'，跳过")
                continue

            print(f"  [Patch] 第 {patch.episode_number} 集.{field} ← {value[:30]}{'...' if len(value) > 30 else ''}")

        except Exception as e:
            print(f"  [Patch] 错误: 应用补丁到第 {patch.episode_number} 集.{field} 失败: {e}")

    return fixed


# =============================================================================
# 规则修复器（保留，用于基础修复）
# =============================================================================


class EpisodePlanFixer:
    """分集规划规则修复器。

    提供基础的规则修复，作为 LLM 修复的补充。
    主要修复：章节间隔/重叠、角色名映射、缺失字段填充。
    """

    FUZZY_MATCH_THRESHOLD = 0.6

    def fix(
        self,
        plan: "SeriesPlan",
        issues: list[EpisodePlanIssue],
        available_characters: set[str],
        total_chapters: Optional[int] = None,
    ) -> "SeriesPlan":
        """规则修复分集规划。

        Args:
            plan: 待修复的分集规划
            issues: 问题列表
            available_characters: 已分析的角色名集合
            total_chapters: 小说总章节数

        Returns:
            修复后的规划（深拷贝）
        """
        fixed = copy.deepcopy(plan)

        # 按问题类型分组
        chapter_issues = [
            i for i in issues
            if i.issue_type in (
                EpisodePlanIssueType.CHAPTER_GAP,
                EpisodePlanIssueType.CHAPTER_OVERLAP,
                EpisodePlanIssueType.CHAPTER_OUT_OF_RANGE,
            )
        ]
        character_issues = [
            i for i in issues
            if i.issue_type == EpisodePlanIssueType.INVALID_CHARACTER
        ]
        structure_issues = [
            i for i in issues
            if i.issue_type in (
                EpisodePlanIssueType.MISSING_TITLE,
                EpisodePlanIssueType.MISSING_SUMMARY,
                EpisodePlanIssueType.MISSING_CLIFFHANGER,
                EpisodePlanIssueType.EMPTY_KEY_EVENTS,
                EpisodePlanIssueType.EMPTY_CHARACTERS,
            )
        ]

        # 1. 修复章节问题
        if chapter_issues:
            self._fix_chapter_issues(fixed, total_chapters)

        # 2. 修复角色名问题
        if character_issues:
            self._fix_character_names(fixed, available_characters)

        # 3. 修复结构问题
        if structure_issues:
            self._fix_structure_issues(fixed, structure_issues)

        return fixed

    def _fix_chapter_issues(
        self,
        plan: "SeriesPlan",
        total_chapters: Optional[int],
    ) -> None:
        """修复章节问题。"""
        if not plan.episodes:
            return

        # 按章节起始排序
        plan.episodes.sort(key=lambda e: e.chapter_start)

        # 修复超出范围的章节
        if total_chapters:
            for ep in plan.episodes:
                if ep.chapter_start < 1:
                    ep.chapter_start = 1
                if ep.chapter_end > total_chapters:
                    ep.chapter_end = total_chapters

        # 修复章节范围无效的问题
        for ep in plan.episodes:
            if ep.chapter_start > ep.chapter_end:
                ep.chapter_start, ep.chapter_end = ep.chapter_end, ep.chapter_start

        # 修复间隔和重叠
        for i in range(len(plan.episodes) - 1):
            current = plan.episodes[i]
            next_ep = plan.episodes[i + 1]

            # 修复间隔
            if next_ep.chapter_start > current.chapter_end + 1:
                gap_start = current.chapter_end + 1
                gap_end = next_ep.chapter_start - 1
                gap_size = gap_end - gap_start + 1

                if gap_size == 1:
                    current.chapter_end = gap_end
                else:
                    mid = gap_start + gap_size // 2
                    current.chapter_end = mid - 1
                    next_ep.chapter_start = mid

            # 修复重叠
            if next_ep.chapter_start <= current.chapter_end:
                next_ep.chapter_start = current.chapter_end + 1

        # 确保第一集从第 1 章开始
        if plan.episodes and plan.episodes[0].chapter_start > 1:
            plan.episodes[0].chapter_start = 1

        # 确保最后一集覆盖到最后一章
        if plan.episodes and total_chapters:
            if plan.episodes[-1].chapter_end < total_chapters:
                plan.episodes[-1].chapter_end = total_chapters

        # 重新编号
        for i, ep in enumerate(plan.episodes):
            ep.number = i + 1

    def _fix_character_names(
        self,
        plan: "SeriesPlan",
        available_characters: set[str],
    ) -> None:
        """修复角色名问题。"""
        if not available_characters:
            return

        char_mapping: dict[str, Optional[str]] = {}

        for ep in plan.episodes:
            fixed_characters = []
            for char in ep.characters:
                if char in available_characters:
                    fixed_characters.append(char)
                elif char in char_mapping:
                    if char_mapping[char]:
                        fixed_characters.append(char_mapping[char])
                else:
                    match = self._fuzzy_match_character(char, available_characters)
                    char_mapping[char] = match
                    if match:
                        fixed_characters.append(match)

            # 去重并保持顺序
            seen = set()
            ep.characters = [c for c in fixed_characters if not (c in seen or seen.add(c))]

    def _fuzzy_match_character(
        self,
        name: str,
        available_characters: set[str],
    ) -> Optional[str]:
        """模糊匹配角色名。"""
        if not available_characters:
            return None

        if name in available_characters:
            return name

        # 包含匹配
        for char in available_characters:
            if name in char or char in name:
                return char

        # 相似度匹配
        matches = difflib.get_close_matches(
            name,
            list(available_characters),
            n=1,
            cutoff=self.FUZZY_MATCH_THRESHOLD,
        )

        if matches:
            return matches[0]

        return None

    def _fix_structure_issues(
        self,
        plan: "SeriesPlan",
        issues: list[EpisodePlanIssue],
    ) -> None:
        """修复结构问题。"""
        issues_by_ep: dict[int, list[EpisodePlanIssue]] = {}
        for issue in issues:
            if issue.episode_number:
                if issue.episode_number not in issues_by_ep:
                    issues_by_ep[issue.episode_number] = []
                issues_by_ep[issue.episode_number].append(issue)

        for ep in plan.episodes:
            ep_issues = issues_by_ep.get(ep.number, [])

            for issue in ep_issues:
                if issue.issue_type == EpisodePlanIssueType.MISSING_TITLE:
                    self._fix_missing_title(ep)
                elif issue.issue_type == EpisodePlanIssueType.MISSING_SUMMARY:
                    self._fix_missing_summary(ep)
                elif issue.issue_type == EpisodePlanIssueType.MISSING_CLIFFHANGER:
                    self._fix_missing_cliffhanger(ep)

    def _fix_missing_title(self, ep: "EpisodePlan") -> None:
        """修复缺失的标题。"""
        if ep.title and ep.title.strip() and ep.title != f"第{ep.number}集":
            return

        # 从 summary 生成
        if ep.summary and len(ep.summary) > 10:
            # 提取摘要中的关键词作为标题
            title = self._extract_title_from_summary(ep.summary)
            if title:
                ep.title = title
                return

        # 从 key_events 生成
        if ep.key_events:
            event = ep.key_events[0]
            title = event[:15].strip()
            while title and title[-1] in "，。！？、；：":
                title = title[:-1]
            if title:
                ep.title = title
                return

        # 从 cliffhanger 生成
        if ep.cliffhanger:
            title = ep.cliffhanger[:15].strip()
            while title and title[-1] in "，。！？、；：":
                title = title[:-1]
            if title:
                ep.title = title + "？"
                return

        ep.title = f"第{ep.number}集：风云再起"

    def _extract_title_from_summary(self, summary: str) -> Optional[str]:
        """从摘要中提取标题。"""
        # 尝试提取有冲突感的短语
        keywords = ["发现", "决定", "揭示", "面对", "遭遇", "秘密", "真相", "危机", "转折"]

        for kw in keywords:
            if kw in summary:
                # 找到关键词位置，截取前后内容
                idx = summary.find(kw)
                start = max(0, idx - 5)
                end = min(len(summary), idx + 10)
                title = summary[start:end].strip()

                # 清理标点
                while title and title[0] in "，。！？、；：":
                    title = title[1:]
                while title and title[-1] in "，。！？、；：":
                    title = title[:-1]

                if len(title) >= 4:
                    return title

        # 直接取前 12 个字
        title = summary[:12].strip()
        while title and title[-1] in "，。！？、；：":
            title = title[:-1]

        return title if len(title) >= 4 else None

    def _fix_missing_summary(self, ep: "EpisodePlan") -> None:
        """修复缺失的摘要。"""
        if ep.summary and len(ep.summary.strip()) >= 10:
            return

        if ep.key_events:
            ep.summary = "。".join(ep.key_events[:3])
            if not ep.summary.endswith("。"):
                ep.summary += "。"
            return

        ep.summary = f"第 {ep.chapter_start}-{ep.chapter_end} 章内容。"

    def _fix_missing_cliffhanger(self, ep: "EpisodePlan") -> None:
        """修复缺失的悬念。"""
        if ep.cliffhanger and len(ep.cliffhanger.strip()) >= 5:
            return

        # 从 key_events 的最后一个事件生成
        if ep.key_events:
            last_event = ep.key_events[-1]
            ep.cliffhanger = last_event + "，接下来会发生什么？"
            return

        # 从 summary 的最后一句生成
        if ep.summary:
            sentences = ep.summary.replace("！", "。").replace("？", "。").split("。")
            sentences = [s.strip() for s in sentences if s.strip()]
            if sentences:
                ep.cliffhanger = sentences[-1] + "..."
                return

        ep.cliffhanger = "故事将如何发展？敬请期待..."


def create_episode_plan_fixer() -> EpisodePlanFixer:
    """创建分集规划规则修复器。"""
    return EpisodePlanFixer()


if TYPE_CHECKING:
    from novelvideo.agents.episode_planner import SeriesPlan, EpisodePlan
