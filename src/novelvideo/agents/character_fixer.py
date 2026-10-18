"""Character fixer Agent.

Fixes character problems according to the review report: merge duplicates, delete generic names, correct identities.
"""

from typing import Callable, Optional

from pydantic_ai import Agent
from pydantic import BaseModel, Field

from novelvideo.config import (
    get_newapi_structured_output_model_settings,
    get_pydantic_model,
)


class FixAction(BaseModel):
    """Fix action record."""

    action: str = Field(description="Action type: merge/delete/update")
    target: str = Field(description="Action target")
    result: str = Field(description="Action result")
    success: bool = Field(default=True, description="Whether it succeeded")


class CharacterFixReport(BaseModel):
    """Character fix report."""
    fixed: list[FixAction] = Field(default_factory=list)
    summary: str = Field(default="", description="Fix summary")
    total_actions: int = Field(default=0, description="Total number of actions")
    success_count: int = Field(default=0, description="Number of successes")

    @property
    def all_success(self) -> bool:
        """Whether everything succeeded."""
        return all(f.success for f in self.fixed)


FIXER_INSTRUCTIONS = """You are a character fixing expert.

## Task
Fix character problems according to the review report.

## Tools
- tool_merge_characters(primary_name, alias_names): merge duplicate characters
  - primary_name: the primary character name to keep
  - alias_names: the aliases to merge, comma-separated (e.g. "the Empress,Your Majesty")

- tool_delete_character(name): delete a character
  - Used to delete generic or invalid characters

- tool_update_character_field(name, field, value): update a character field
  - field can be: gender, role, personality, etc.

- tool_get_character_detail(name): get character details
  - Used to confirm the state before fixing

## Workflow
1. Read the issues in the review report
2. For each issue:
   - duplicate: call tool_merge_characters to merge
   - generic: call tool_delete_character to delete
   - identity_error: call tool_update_character_field to correct
3. Confirm the result after each action
4. Output the fix report

## Output format
Return a fix report in JSON format:
- fixed: list of actions, each containing action, target, result, success
- summary: fix summary
- total_actions: total number of actions
- success_count: number of successes

## Notes
- When merging characters, pick the more specific name as primary (e.g. "Jingzhen" rather than "the young monk")
- Confirm with tool_get_character_detail before deleting
- Record whether every action succeeded
"""


def create_character_fixer_agent(tools: Optional[list[Callable]] = None) -> Agent:
    """Create the character fixer Agent.

    Args:
        tools: List of character fixing tools

    Returns:
        Agent: a configured character fixer Agent
    """
    return Agent(
        get_pydantic_model(),
        system_prompt=FIXER_INSTRUCTIONS,
        output_type=CharacterFixReport,
        model_settings=get_newapi_structured_output_model_settings(),
        tools=tools or [],
        name="Character fixer",
    )


# Default instance (lazily initialized)
_fixer_agent = None


def get_character_fixer_agent() -> Agent:
    """Get the character fixer Agent singleton (version without tools).

    Returns:
        Agent: the character fixer Agent instance
    """
    global _fixer_agent
    if _fixer_agent is None:
        _fixer_agent = create_character_fixer_agent()
    return _fixer_agent
