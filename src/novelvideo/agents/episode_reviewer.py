"""Episode plan quality review Agent.

Uses an LLM to evaluate the narrative quality, pacing, character arcs, etc. of the episode plan.
Rule-based checks are kept as the baseline validation.
"""

from enum import Enum
from typing import TYPE_CHECKING, Callable, Optional, Union

from pydantic_ai import Agent
from pydantic import BaseModel, Field

from novelvideo.config import (
    get_newapi_structured_output_model_settings,
    get_pydantic_model,
)


# =============================================================================
# Data models
# =============================================================================


class EpisodePlanIssueType(str, Enum):
    """Episode plan issue types.

    Note: the following checks have been moved up into the Pydantic model validation layer (validated automatically when an EpisodePlan is generated):
    - missing_title → Field(min_length=2)
    - missing_summary → Field(min_length=10)
    - missing_cliffhanger → Field(min_length=5)
    - empty_key_events → Field(min_length=1)
    - empty_characters → Field(min_length=1)
    """

    # Chapter issues (critical)
    CHAPTER_GAP = "chapter_gap"
    CHAPTER_OVERLAP = "chapter_overlap"
    CHAPTER_OUT_OF_RANGE = "chapter_out_of_range"

    # Character issues (warning)
    INVALID_CHARACTER = "invalid_character"

    # Narrative issues (LLM evaluation)
    NARRATIVE_DISCONTINUITY = "narrative_discontinuity"
    PACING_ISSUE = "pacing_issue"
    CHARACTER_ARC_BROKEN = "character_arc_broken"
    WEAK_CLIFFHANGER = "weak_cliffhanger"
    POOR_TITLE = "poor_title"


class EpisodePlanIssue(BaseModel):
    """Episode plan issue."""

    issue_type: EpisodePlanIssueType
    severity: str = Field(
        default="warning",
        description="Issue severity: critical/warning/info",
    )
    episode_number: Optional[Union[int, list[int]]] = Field(
        default=None,
        description="Related episode number(s) (a single integer or a list of integers)",
    )
    message: str = Field(description="Issue description")
    suggestion: str = Field(default="", description="Fix suggestion")


class EpisodePlanReport(BaseModel):
    """Episode plan quality report."""

    score: float = Field(ge=0, le=10, description="Quality score 0-10")
    issues: list[EpisodePlanIssue] = Field(default_factory=list)
    summary: str = Field(default="", description="Summary")

    # Statistics
    total_episodes: int = Field(default=0)
    chapter_coverage: str = Field(default="")
    covered_chapters: int = Field(default=0)
    missing_chapters: list[int] = Field(default_factory=list)

    # LLM evaluation dimension scores - new
    narrative_score: float = Field(default=0.0, description="Narrative coherence score 0-10")
    pacing_score: float = Field(default=0.0, description="Pacing score 0-10")
    character_arc_score: float = Field(default=0.0, description="Character arc score 0-10")
    cliffhanger_score: float = Field(default=0.0, description="Suspense score 0-10")

    @property
    def passed(self) -> bool:
        """Whether the quality check passes.

        Pass conditions:
        1. No critical issues (all must be fixed)
        2. Score >= 8.0 (overall quality meets the bar)

        info issues do not affect the pass decision.
        """
        has_critical = any(i.severity == "critical" for i in self.issues)
        return self.score >= 8.0 and not has_critical

    @property
    def critical_issues(self) -> list[EpisodePlanIssue]:
        """Get the critical issues."""
        return [i for i in self.issues if i.severity == "critical"]

    @property
    def warnings(self) -> list[EpisodePlanIssue]:
        """Get the warnings."""
        return [i for i in self.issues if i.severity == "warning"]


# =============================================================================
# LLM Agent Prompt
# =============================================================================


EPISODE_REVIEWER_PROMPT = """# You are a professional short-video episode plan reviewer

## Evaluation dimensions (ordered by weight)

| Dimension | Weight | Description |
|-----------|--------|-------------|
| Narrative coherence | 30% | Does the storyline flow? Are plot turns reasonable? |
| Pacing | 25% | Does each episode balance tension and release? Are climaxes well placed? |
| Character arcs | 20% | Is character development coherent? Are motivations clear? |
| Suspense | 15% | Are the ending cliffhangers engaging? Can they retain the audience? |
| Format | 10% | Are chapter ranges contiguous? Are character names valid? |

## Tool usage

During the review you may call the following tools for more context:

| Tool | Purpose |
|------|---------|
| `get_character_evolution(name)` | Look up a character's development across the novel |
| `get_chapter_content(start, end)` | Get a content summary of the specified chapters |
| `get_novel_themes()` | Get the novel's themes and core conflicts |
| `check_plot_continuity(ep1, ep2)` | Check plot continuity between two episodes |

## Review checklist

### 1. Narrative coherence check
- [ ] Does the plot transition naturally between episodes?
- [ ] Are there plot jumps or breaks?
- [ ] Is causality clear?

### 2. Pacing check
- [ ] Does each episode have setup, development, turn and resolution?
- [ ] Are climaxes/conflicts well distributed?
- [ ] Are there several consecutive bland episodes without a climax?

### 3. Character arc check
- [ ] Do the main characters develop and change?
- [ ] Are character motivations clear and consistent?
- [ ] Do character appearances fit the plot needs?

### 4. Suspense check
- [ ] Does each episode end with a cliffhanger?
- [ ] Is the cliffhanger engaging enough?
- [ ] Is the cliffhanger answered in later episodes?

### 5. Format check
- [ ] Are chapter ranges contiguous without gaps?
- [ ] Are the analyzed, valid character names used?
- [ ] Are the titles attractive?

## Scoring standard

| Score | Grade | Description |
|-------|-------|-------------|
| 9-10 | Excellent | Fluent narrative, tight pacing, clever suspense |
| 8-8.9 | Good | Good overall, with minor points to optimize |
| 7-7.9 | Acceptable | Basically usable, but with clear problems to fix |
| 6-6.9 | Passing | Quite a few problems; substantial changes needed |
| <6 | Failing | Serious problems; needs re-planning |

## Issue severity

- **critical**: must be fixed or the plan cannot be used (e.g. chapter gaps, characters that cannot appear)
- **warning**: should be fixed, affects quality (e.g. narrative breaks, pacing problems)
- **info**: suggested optimization (e.g. the title could be more engaging)

## Output requirements

Output an EpisodePlanReport containing:
1. score: overall score (0-10)
2. issues: list of issues found
3. summary: review summary
4. Per-dimension scores: narrative_score, pacing_score, character_arc_score, cliffhanger_score

**Important**: when giving issues and suggestions, make sure to:
1. Call tools to verify your judgment
2. Give specific episode numbers and content
3. Provide actionable fix suggestions
"""


# =============================================================================
# LLM Agent creation
# =============================================================================


def create_episode_reviewer_agent(tools: Optional[list[Callable]] = None) -> Agent:
    """Create the episode plan review Agent.

    Args:
        tools: List of review tool functions

    Returns:
        A configured Agent
    """
    return Agent(
        get_pydantic_model(),
        system_prompt=EPISODE_REVIEWER_PROMPT,
        output_type=EpisodePlanReport,
        model_settings=get_newapi_structured_output_model_settings(),
        tools=tools or [],
        name="Episode plan reviewer",
    )


# =============================================================================
# Rule-based checker (kept, used for baseline validation)
# =============================================================================


class EpisodePlanReviewer:
    """Rule-based episode plan checker.

    Provides baseline rule validation, complementing the LLM review.
    Main checks: chapter continuity, character name validity, structural integrity.
    """

    WEIGHTS = {
        "chapter_continuity": 0.35,
        "chapter_coverage": 0.25,
        "character_validity": 0.20,
        "structure": 0.20,
    }

    def review(
        self,
        plan: "SeriesPlan",
        available_characters: set[str],
        total_chapters: int,
    ) -> EpisodePlanReport:
        """Rule-based review of the episode plan.

        Args:
            plan: The episode plan to review
            available_characters: Set of analyzed character names
            total_chapters: Total number of chapters in the novel

        Returns:
            EpisodePlanReport
        """
        issues: list[EpisodePlanIssue] = []
        scores: dict[str, float] = {}

        # 1. Check chapter continuity
        cont_score, cont_issues, coverage_info = self._check_chapter_continuity(
            plan, total_chapters
        )
        scores["chapter_continuity"] = cont_score
        issues.extend(cont_issues)

        # 2. Check chapter coverage completeness
        cov_score, cov_issues = self._check_chapter_coverage(
            plan, total_chapters, coverage_info
        )
        scores["chapter_coverage"] = cov_score
        issues.extend(cov_issues)

        # 3. Check character name consistency
        char_score, char_issues = self._check_character_names(plan, available_characters)
        scores["character_validity"] = char_score
        issues.extend(char_issues)

        # 4. Check structural integrity
        struct_score, struct_issues = self._check_structure(plan)
        scores["structure"] = struct_score
        issues.extend(struct_issues)

        # Compute the weighted score
        final_score = sum(scores[k] * self.WEIGHTS[k] for k in self.WEIGHTS)

        # Generate the chapter coverage description
        chapter_coverage_str = self._format_chapter_coverage(coverage_info, total_chapters)

        # Generate the summary
        summary = self._generate_summary(scores, issues)

        return EpisodePlanReport(
            score=round(final_score, 1),
            issues=issues,
            summary=summary,
            total_episodes=len(plan.episodes),
            chapter_coverage=chapter_coverage_str,
            covered_chapters=coverage_info.get("covered_count", 0),
            missing_chapters=coverage_info.get("missing", []),
        )

    def _check_chapter_continuity(
        self,
        plan: "SeriesPlan",
        total_chapters: int,
    ) -> tuple[float, list[EpisodePlanIssue], dict]:
        """Check chapter continuity."""
        issues = []
        coverage_info: dict = {"covered": set(), "missing": [], "covered_count": 0}

        if not plan.episodes:
            return 0, [
                EpisodePlanIssue(
                    issue_type=EpisodePlanIssueType.CHAPTER_GAP,
                    severity="critical",
                    message="The episode plan is empty",
                    suggestion="An episode plan needs to be generated",
                )
            ], coverage_info

        sorted_episodes = sorted(plan.episodes, key=lambda e: e.chapter_start)
        penalty = 0.0

        for i, ep in enumerate(sorted_episodes):
            for ch in range(ep.chapter_start, ep.chapter_end + 1):
                coverage_info["covered"].add(ch)

            if ep.chapter_start > ep.chapter_end:
                issues.append(
                    EpisodePlanIssue(
                        issue_type=EpisodePlanIssueType.CHAPTER_GAP,
                        severity="critical",
                        episode_number=ep.number,
                        message=f"Episode {ep.number} has an invalid chapter range: {ep.chapter_start}-{ep.chapter_end}",
                        suggestion="chapter_start should be <= chapter_end",
                    )
                )
                penalty += 2.0

            if ep.chapter_end > total_chapters:
                issues.append(
                    EpisodePlanIssue(
                        issue_type=EpisodePlanIssueType.CHAPTER_OUT_OF_RANGE,
                        severity="critical",
                        episode_number=ep.number,
                        message=f"Episode {ep.number} ends at chapter {ep.chapter_end}, beyond the total of {total_chapters} chapters",
                        suggestion=f"Adjust the chapter range to not exceed {total_chapters}",
                    )
                )
                penalty += 1.5

            if ep.chapter_start < 1:
                issues.append(
                    EpisodePlanIssue(
                        issue_type=EpisodePlanIssueType.CHAPTER_OUT_OF_RANGE,
                        severity="critical",
                        episode_number=ep.number,
                        message=f"Episode {ep.number} starts at chapter {ep.chapter_start}, which is less than 1",
                        suggestion="Chapter numbering starts at 1",
                    )
                )
                penalty += 1.5

            if i < len(sorted_episodes) - 1:
                next_ep = sorted_episodes[i + 1]

                if next_ep.chapter_start > ep.chapter_end + 1:
                    gap_start = ep.chapter_end + 1
                    gap_end = next_ep.chapter_start - 1
                    issues.append(
                        EpisodePlanIssue(
                            issue_type=EpisodePlanIssueType.CHAPTER_GAP,
                            severity="critical",
                            episode_number=ep.number,
                            message=f"Chapters {gap_start}-{gap_end} are missing between episode {ep.number} and episode {next_ep.number}",
                            suggestion="Extend the chapter range of the adjacent episodes",
                        )
                    )
                    penalty += 2.0

                if next_ep.chapter_start <= ep.chapter_end:
                    issues.append(
                        EpisodePlanIssue(
                            issue_type=EpisodePlanIssueType.CHAPTER_OVERLAP,
                            severity="critical",
                            episode_number=ep.number,
                            message=f"Episode {ep.number} and episode {next_ep.number} have overlapping chapters",
                            suggestion="Adjust the chapter boundaries to avoid overlap",
                        )
                    )
                    penalty += 2.0

        coverage_info["covered_count"] = len(coverage_info["covered"])
        all_chapters = set(range(1, total_chapters + 1))
        coverage_info["missing"] = sorted(all_chapters - coverage_info["covered"])

        score = max(0, 10 - penalty)
        return score, issues, coverage_info

    def _check_chapter_coverage(
        self,
        plan: "SeriesPlan",
        total_chapters: int,
        coverage_info: dict,
    ) -> tuple[float, list[EpisodePlanIssue]]:
        """Check chapter coverage completeness."""
        issues = []

        covered = coverage_info.get("covered_count", 0)
        missing = coverage_info.get("missing", [])

        if total_chapters <= 0:
            return 10.0, []

        coverage_ratio = covered / total_chapters

        if missing:
            missing_ranges = self._ranges_to_str(missing)
            severity = "critical" if len(missing) > 5 else "warning"
            issues.append(
                EpisodePlanIssue(
                    issue_type=EpisodePlanIssueType.CHAPTER_GAP,
                    severity=severity,
                    message=f"Missing {len(missing)} chapters of content: {missing_ranges}",
                    suggestion="Extend the chapter range of the adjacent episodes to cover the missing chapters",
                )
            )

        score = coverage_ratio * 10
        return score, issues

    def _check_character_names(
        self,
        plan: "SeriesPlan",
        available_characters: set[str],
    ) -> tuple[float, list[EpisodePlanIssue]]:
        """Check character name consistency."""
        issues = []

        if not available_characters:
            return 10.0, []

        all_plan_chars: set[str] = set()
        char_to_episodes: dict[str, list[int]] = {}

        for ep in plan.episodes:
            for char in ep.characters:
                all_plan_chars.add(char)
                if char not in char_to_episodes:
                    char_to_episodes[char] = []
                char_to_episodes[char].append(ep.number)

        invalid_chars = all_plan_chars - available_characters
        valid_count = len(all_plan_chars) - len(invalid_chars)

        for char in invalid_chars:
            episodes_str = ", ".join(str(e) for e in char_to_episodes[char][:3])
            if len(char_to_episodes[char]) > 3:
                episodes_str += "..."

            issues.append(
                EpisodePlanIssue(
                    issue_type=EpisodePlanIssueType.INVALID_CHARACTER,
                    severity="warning",
                    message=f"Character '{char}' is not in the analyzed character list (appears in episode(s) {episodes_str})",
                    suggestion="Use the analyzed character names",
                )
            )

        if not all_plan_chars:
            return 10.0, []

        score = (valid_count / len(all_plan_chars)) * 10
        return score, issues

    def _check_structure(
        self,
        plan: "SeriesPlan",
    ) -> tuple[float, list[EpisodePlanIssue]]:
        """Check structural integrity.

        Note: the non-empty checks for title/summary/cliffhanger/key_events/characters
        have been moved up into the Pydantic Field constraints of EpisodePlan and are not repeated here.
        """
        # All structure checks have been moved up into the Pydantic model validation layer
        return 10.0, []

    def _ranges_to_str(self, numbers: list[int]) -> str:
        """Convert a list of numbers into a range string."""
        if not numbers:
            return ""

        ranges = []
        start = numbers[0]
        end = numbers[0]

        for n in numbers[1:]:
            if n == end + 1:
                end = n
            else:
                if start == end:
                    ranges.append(str(start))
                else:
                    ranges.append(f"{start}-{end}")
                start = end = n

        if start == end:
            ranges.append(str(start))
        else:
            ranges.append(f"{start}-{end}")

        return ", ".join(ranges)

    def _format_chapter_coverage(
        self,
        coverage_info: dict,
        total_chapters: int,
    ) -> str:
        """Format the chapter coverage description."""
        covered = coverage_info.get("covered", set())
        missing = coverage_info.get("missing", [])

        if not covered:
            return "no coverage"

        min_ch = min(covered)
        max_ch = max(covered)

        if not missing:
            return f"{min_ch}-{max_ch}"
        else:
            missing_str = self._ranges_to_str(missing)
            return f"{min_ch}-{max_ch} (missing {missing_str})"

    def _generate_summary(
        self,
        scores: dict[str, float],
        issues: list[EpisodePlanIssue],
    ) -> str:
        """Generate the review summary."""
        critical_count = len([i for i in issues if i.severity == "critical"])
        warning_count = len([i for i in issues if i.severity == "warning"])

        parts = []

        avg_score = sum(scores.values()) / len(scores) if scores else 0
        if avg_score >= 8:
            parts.append("Rule checks passed")
        elif avg_score >= 6:
            parts.append("Rule checks fair")
        else:
            parts.append("Rule checks poor")

        if critical_count > 0:
            parts.append(f"{critical_count} critical issue(s)")
        if warning_count > 0:
            parts.append(f"{warning_count} warning(s)")

        return ", ".join(parts) + "." if parts else "Review complete."


def create_episode_plan_reviewer() -> EpisodePlanReviewer:
    """Create the rule-based episode plan checker."""
    return EpisodePlanReviewer()


if TYPE_CHECKING:
    from novelvideo.agents.episode_planner import SeriesPlan
