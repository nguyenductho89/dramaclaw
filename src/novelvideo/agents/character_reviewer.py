"""Character reviewer Agent.

Reviews the character list and detects duplicates, generic names, identity errors and similar problems.
"""

from typing import Callable, Optional

from pydantic_ai import Agent
from pydantic import BaseModel, Field

from novelvideo.config import (
    get_newapi_structured_output_model_settings,
    get_pydantic_model,
)


class CharacterIssue(BaseModel):
    """Character issue."""

    issue_type: str = Field(description="Issue type: duplicate/generic/identity_error")
    names: list[str] = Field(default_factory=list, description="Related character names")
    reason: str = Field(description="Reason for the issue")
    suggestion: str = Field(default="", description="Fix suggestion")


class CharacterReviewReport(BaseModel):
    """Character review report."""

    issues: list[CharacterIssue] = Field(default_factory=list)
    summary: str = Field(default="", description="Review summary")
    reviewed_count: int = Field(default=0, description="Number of characters reviewed")

    @property
    def has_issues(self) -> bool:
        """Whether there are issues."""
        return len(self.issues) > 0


REVIEWER_INSTRUCTIONS = """You are a character review expert.

## Task
Review the character list and find the following problems:

1. **Duplicate characters (duplicate)**:
   - Different forms of address for the same character (e.g. "the Empress" and "Empress Dowager" are the same person)
   - A character name and an alias (e.g. "Jingzhen" and "the young monk" may be the same person)

2. **Generic characters (generic)**:
   - Generic terms that are not specific characters (e.g. "Your Majesty", "the eunuch", "the palace maid")
   - These should be deleted or merged into specific characters

3. **Identity errors (identity_error)**:
   - A character identity that does not match the setting (e.g. the emperor should not be a monk)
   - Wrong gender, wrong occupation, etc.

## Workflow
1. First call tool_get_all_characters to get the current character list
2. Analyze the character names and find combinations that may be duplicates
3. For suspicious combinations call tool_check_duplicate to verify
4. For suspicious identities call tool_verify_identity to confirm
5. For characters whose relationships you need to understand call tool_search_relations
6. Compile the issues and output the review report

## Output format
Return a review report in JSON format, containing:
- issues: list of issues, each containing issue_type, names, reason, suggestion
- summary: review summary
- reviewed_count: number of characters reviewed

## Notes
- The names of a duplicate-character issue should include all the related names
- The names of a generic-character issue contain only that generic term
- The names of an identity-error issue contain only the wrongly identified character name
- Every issue must have a clear suggestion
"""


def create_character_reviewer_agent(tools: Optional[list[Callable]] = None) -> Agent:
    """Create the character reviewer Agent.

    Args:
        tools: List of character review tools

    Returns:
        Agent: a configured character reviewer Agent
    """
    return Agent(
        get_pydantic_model(),
        system_prompt=REVIEWER_INSTRUCTIONS,
        output_type=CharacterReviewReport,
        model_settings=get_newapi_structured_output_model_settings(),
        tools=tools or [],
        name="Character reviewer",
    )


# Default instance (lazily initialized)
_reviewer_agent = None


def get_character_reviewer_agent() -> Agent:
    """Get the character reviewer Agent singleton (version without tools).

    Returns:
        Agent: the character reviewer Agent instance
    """
    global _reviewer_agent
    if _reviewer_agent is None:
        _reviewer_agent = create_character_reviewer_agent()
    return _reviewer_agent
