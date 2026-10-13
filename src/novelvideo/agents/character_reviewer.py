"""角色审核 Agent。

审核角色列表，检测重复、泛称、身份错误等问题。
"""

from typing import Callable, Optional

from pydantic_ai import Agent
from pydantic import BaseModel, Field

from novelvideo.config import (
    get_newapi_structured_output_model_settings,
    get_pydantic_model,
)
from novelvideo.utils.source_language import (
    asset_language_instruction,
    resolve_asset_language,
    select_by_language,
)


class CharacterIssue(BaseModel):
    """角色问题。"""

    issue_type: str = Field(description="问题类型: duplicate/generic/identity_error")
    names: list[str] = Field(default_factory=list, description="相关角色名")
    reason: str = Field(description="问题原因")
    suggestion: str = Field(default="", description="修复建议")


class CharacterReviewReport(BaseModel):
    """角色审核报告。"""

    issues: list[CharacterIssue] = Field(default_factory=list)
    summary: str = Field(default="", description="审核总结")
    reviewed_count: int = Field(default=0, description="审核的角色数量")

    @property
    def has_issues(self) -> bool:
        """是否有问题。"""
        return len(self.issues) > 0


REVIEWER_INSTRUCTIONS = """你是一个角色审核专家。

## 任务
审核角色列表，找出以下问题：

1. **重复角色 (duplicate)**：
   - 同一角色的不同称呼（如"皇后娘娘"和"皇后"是同一人）
   - 角色名和别名（如"净臻"和"小和尚"可能是同一人）

2. **泛称角色 (generic)**：
   - 不是具体角色的通用称呼（如"娘娘"、"太监"、"宫女"）
   - 这些应该删除或合并到具体角色

3. **身份错误 (identity_error)**：
   - 角色身份与设定不符（如皇帝不应该是和尚）
   - 性别错误、职业错误等

## 工作流程
1. 首先调用 tool_get_all_characters 获取当前角色列表
2. 分析角色名，找出可能重复的组合
3. 对可疑的组合调用 tool_check_duplicate 验证
4. 对可疑身份调用 tool_verify_identity 确认
5. 对需要了解关系的角色调用 tool_search_relations
6. 整理问题，输出审核报告

## 输出格式
返回 JSON 格式的审核报告，包含：
- issues: 问题列表，每个问题包含 issue_type、names、reason、suggestion
- summary: 审核总结
- reviewed_count: 审核的角色数量

## 注意事项
- 重复角色的 names 应包含所有相关的名字
- 泛称角色的 names 只包含该泛称
- 身份错误的 names 只包含错误的角色名
- 每个问题都要有明确的 suggestion
"""


REVIEWER_INSTRUCTIONS_VI = """Bạn là chuyên gia rà soát nhân vật.

## Nhiệm vụ
Rà soát danh sách nhân vật, tìm ra các vấn đề sau:

1. **Nhân vật trùng lặp (duplicate)**:
   - Cùng một nhân vật nhưng có nhiều cách gọi khác nhau (ví dụ "Hoàng hậu nương nương" và "Hoàng hậu" là cùng một người)
   - Tên nhân vật và biệt danh (ví dụ tên riêng của chú tiểu và "chú tiểu" có thể là cùng một người)

2. **Nhân vật xưng hô chung chung (generic)**:
   - Cách gọi chung, không phải một nhân vật cụ thể (ví dụ "Nương nương", "thái giám", "cung nữ")
   - Những nhân vật này nên bị xóa hoặc gộp vào nhân vật cụ thể

3. **Sai lệch thân phận (identity_error)**:
   - Thân phận nhân vật không khớp với thiết lập (ví dụ hoàng đế không thể là nhà sư)
   - Sai giới tính, sai nghề nghiệp, v.v.

## Quy trình làm việc
1. Trước tiên gọi tool_get_all_characters để lấy danh sách nhân vật hiện tại
2. Phân tích tên nhân vật, tìm các cặp có thể trùng lặp
3. Với các cặp đáng ngờ, gọi tool_check_duplicate để xác minh
4. Với thân phận đáng ngờ, gọi tool_verify_identity để xác nhận
5. Với nhân vật cần hiểu quan hệ, gọi tool_search_relations
6. Tổng hợp các vấn đề và xuất báo cáo rà soát

## Định dạng đầu ra
Trả về báo cáo rà soát ở định dạng JSON, gồm:
- issues: danh sách vấn đề, mỗi vấn đề gồm issue_type, names, reason, suggestion
- summary: tổng kết rà soát
- reviewed_count: số nhân vật đã rà soát

## Lưu ý
- names của nhân vật trùng lặp phải bao gồm tất cả các tên liên quan
- names của nhân vật xưng hô chung chung chỉ chứa xưng hô chung đó
- names của lỗi thân phận chỉ chứa tên nhân vật bị sai
- Mỗi vấn đề đều phải có suggestion rõ ràng
- Giá trị issue_type (duplicate/generic/identity_error) phải viết đúng nguyên văn; các trường văn xuôi (reason, suggestion, summary) viết bằng tiếng Việt, tên nhân vật giữ nguyên văn như đã cung cấp
"""


def get_reviewer_instructions(language: str = "zh") -> str:
    """Return the reviewer system prompt written in ``language``."""
    return select_by_language(language, zh=REVIEWER_INSTRUCTIONS, vi=REVIEWER_INSTRUCTIONS_VI)


def _reviewer_system_prompt(language: str | None) -> str:
    language = language or resolve_asset_language("")
    prompt = get_reviewer_instructions(language)
    if language == "vi":
        prompt = f"{prompt}\n{asset_language_instruction('vi')}"
    return prompt


def create_character_reviewer_agent(
    tools: Optional[list[Callable]] = None, language: str | None = None
) -> Agent:
    """创建角色审核 Agent。

    Args:
        tools: 角色审核工具列表
        language: 提示词语言；缺省时取项目声明语言（zh/en 保持原中文提示词，vi 使用越南语提示词）

    Returns:
        Agent: 配置好的角色审核 Agent
    """
    return Agent(
        get_pydantic_model(),
        system_prompt=_reviewer_system_prompt(language),
        output_type=CharacterReviewReport,
        model_settings=get_newapi_structured_output_model_settings(),
        tools=tools or [],
        name="角色审核员",
    )


# 默认实例（延迟初始化，按语言缓存）
_reviewer_agent = None
_reviewer_agents_by_language: dict[str, Agent] = {}


def get_character_reviewer_agent(language: str | None = None) -> Agent:
    """获取角色审核 Agent 单例（无工具版本）。

    Returns:
        Agent: 角色审核 Agent 实例
    """
    global _reviewer_agent
    language = language or resolve_asset_language("")
    if language != "vi":
        if _reviewer_agent is None:
            _reviewer_agent = create_character_reviewer_agent()
        return _reviewer_agent
    if language not in _reviewer_agents_by_language:
        _reviewer_agents_by_language[language] = create_character_reviewer_agent(language=language)
    return _reviewer_agents_by_language[language]
