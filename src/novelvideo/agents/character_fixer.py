"""角色修复 Agent。

根据审核报告修复角色问题：合并重复、删除泛称、修正身份。
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


class FixAction(BaseModel):
    """修复操作记录。"""

    action: str = Field(description="操作类型: merge/delete/update")
    target: str = Field(description="操作目标")
    result: str = Field(description="操作结果")
    success: bool = Field(default=True, description="是否成功")


class CharacterFixReport(BaseModel):
    """角色修复报告。"""

    fixed: list[FixAction] = Field(default_factory=list)
    summary: str = Field(default="", description="修复总结")
    total_actions: int = Field(default=0, description="总操作数")
    success_count: int = Field(default=0, description="成功数")

    @property
    def all_success(self) -> bool:
        """是否全部成功。"""
        return all(f.success for f in self.fixed)


FIXER_INSTRUCTIONS = """你是一个角色修复专家。

## 任务
根据审核报告修复角色问题。

## 工具
- tool_merge_characters(primary_name, alias_names): 合并重复角色
  - primary_name: 保留的主角色名
  - alias_names: 要合并的别名，逗号分隔（如 "皇后娘娘,娘娘"）

- tool_delete_character(name): 删除角色
  - 用于删除泛称或无效角色

- tool_update_character_field(name, field, value): 更新角色字段
  - field 可以是: gender, role, personality 等

- tool_get_character_detail(name): 获取角色详情
  - 用于确认修复前的状态

## 工作流程
1. 读取审核报告中的问题
2. 对每个问题：
   - duplicate: 调用 tool_merge_characters 合并
   - generic: 调用 tool_delete_character 删除
   - identity_error: 调用 tool_update_character_field 修正
3. 每个操作后确认结果
4. 输出修复报告

## 输出格式
返回 JSON 格式的修复报告：
- fixed: 操作列表，每个操作包含 action、target、result、success
- summary: 修复总结
- total_actions: 总操作数
- success_count: 成功数

## 注意事项
- 合并角色时，选择更具体的名字作为 primary（如"净臻"而非"小和尚"）
- 删除前先用 tool_get_character_detail 确认
- 每个操作都要记录是否成功
"""


FIXER_INSTRUCTIONS_VI = """Bạn là chuyên gia sửa lỗi nhân vật.

## Nhiệm vụ
Dựa trên báo cáo rà soát để sửa các vấn đề của nhân vật.

## Công cụ
- tool_merge_characters(primary_name, alias_names): gộp các nhân vật trùng lặp
  - primary_name: tên nhân vật chính được giữ lại
  - alias_names: các tên gọi khác cần gộp, ngăn cách bằng dấu phẩy (ví dụ "Hoàng hậu nương nương,Nương nương")

- tool_delete_character(name): xóa nhân vật
  - Dùng để xóa xưng hô chung chung hoặc nhân vật không hợp lệ

- tool_update_character_field(name, field, value): cập nhật trường của nhân vật
  - field có thể là: gender, role, personality, v.v.

- tool_get_character_detail(name): lấy chi tiết nhân vật
  - Dùng để xác nhận trạng thái trước khi sửa

## Quy trình làm việc
1. Đọc các vấn đề trong báo cáo rà soát
2. Với từng vấn đề:
   - duplicate: gọi tool_merge_characters để gộp
   - generic: gọi tool_delete_character để xóa
   - identity_error: gọi tool_update_character_field để sửa
3. Xác nhận kết quả sau mỗi thao tác
4. Xuất báo cáo sửa lỗi

## Định dạng đầu ra
Trả về báo cáo sửa lỗi ở định dạng JSON:
- fixed: danh sách thao tác, mỗi thao tác gồm action, target, result, success
- summary: tổng kết việc sửa
- total_actions: tổng số thao tác
- success_count: số thao tác thành công

## Lưu ý
- Khi gộp nhân vật, chọn tên cụ thể hơn làm primary (ví dụ chọn tên riêng của nhân vật thay vì "chú tiểu")
- Trước khi xóa, dùng tool_get_character_detail để xác nhận
- Mỗi thao tác đều phải ghi lại thành công hay không
- Các trường văn xuôi (result, summary) viết bằng tiếng Việt; tên nhân vật giữ nguyên văn như đã cung cấp
"""


def _fixer_system_prompt(language: str | None) -> str:
    language = language or resolve_asset_language("")
    prompt = get_fixer_instructions(language)
    if language == "vi":
        prompt = f"{prompt}\n{asset_language_instruction('vi')}"
    return prompt


def get_fixer_instructions(language: str = "zh") -> str:
    """Return the fixer system prompt written in ``language``."""
    return select_by_language(language, zh=FIXER_INSTRUCTIONS, vi=FIXER_INSTRUCTIONS_VI)


def create_character_fixer_agent(
    tools: Optional[list[Callable]] = None, language: str | None = None
) -> Agent:
    """创建角色修复 Agent。

    Args:
        tools: 角色修复工具列表
        language: 提示词语言；缺省时取项目声明语言（zh/en 保持原中文提示词，vi 使用越南语提示词）

    Returns:
        Agent: 配置好的角色修复 Agent
    """
    return Agent(
        get_pydantic_model(),
        system_prompt=_fixer_system_prompt(language),
        output_type=CharacterFixReport,
        model_settings=get_newapi_structured_output_model_settings(),
        tools=tools or [],
        name="角色修复员",
    )


# 默认实例（延迟初始化，按语言缓存）
_fixer_agent = None
_fixer_agents_by_language: dict[str, Agent] = {}


def get_character_fixer_agent(language: str | None = None) -> Agent:
    """获取角色修复 Agent 单例（无工具版本）。

    Returns:
        Agent: 角色修复 Agent 实例
    """
    global _fixer_agent
    language = language or resolve_asset_language("")
    if language != "vi":
        if _fixer_agent is None:
            _fixer_agent = create_character_fixer_agent()
        return _fixer_agent
    if language not in _fixer_agents_by_language:
        _fixer_agents_by_language[language] = create_character_fixer_agent(language=language)
    return _fixer_agents_by_language[language]
