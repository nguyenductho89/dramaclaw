"""Episode plan fixer Agent.

Uses an LLM to intelligently fix episode plan issues, while keeping rule-based fixes as the baseline.
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


# =============================================================================
# LLM Agent Prompt
# =============================================================================


# =============================================================================
# Patch-based Fixer Prompt (new version, precise fixes)
# =============================================================================


PATCH_FIXER_PROMPT = """# You are a professional short-video episode plan fixer

## ⚠️ Core principle: precise fixes

**Output only the fields that need changing!** Do not regenerate the entire plan.

For each issue, state clearly:
1. Which episode (episode_number)
2. Which field (field)
3. The new value (new_value)
4. The reason for the fix (reason)

## Fields that can be changed

| Field | Description | Example |
|-------|-------------|---------|
| `title` | Episode title | "The Empress Meets Her Dead Husband at the Temple?" |
| `summary` | Content summary | "At the temple the Empress runs into..." |
| `cliffhanger` | Ending suspense | "Who on earth is he?" |
| `characters` | Characters appearing (comma-separated) | "Jiang Shangning,Xie Cheng,Feng Youzhang" |
| `chapter_start` | Starting chapter | "3" |
| `chapter_end` | Ending chapter | "5" |
| `key_events` | Key events (comma-separated) | "Empress returns to the palace,Truth is revealed" |

## Fix workflow

### Step 1: Analyze the issues

Read the issues in the review report carefully and classify them:

| Issue type | Fix strategy |
|------------|--------------|
| Invalid character name | Change only the `characters` field, replacing with a valid name |
| Narrative discontinuity | Change `summary` to add a transition, or adjust `chapter_start/chapter_end` |
| Weak suspense | Change only the `cliffhanger` field |
| Unappealing title | Change only the `title` field |

### Step 2: Generate patches

For each field that needs fixing, generate one EpisodePatch:

```json
{
  "episode_number": 2,
  "field": "characters",
  "new_value": "Jiang Shangning,Xie Cheng",
  "reason": "Removed the invalid character 'Consort Zhao'"
}
```

### Step 3: Verify

- Check that the patches are sufficient to solve the problem
- Do not add unnecessary changes
- Do not touch fields that have no problem

## Tool usage

Before fixing you may call tools to confirm correct information:

| Tool | Purpose |
|------|---------|
| `get_all_characters()` | Get the list of valid character names |
| `get_chapter_content(start, end)` | Get chapter content |
| `check_continuity(ep1, ep2)` | Check continuity between two episodes |

## Output requirements

Return a FixPlan containing only the patches that need changing:

```json
{
  "patches": [
    {"episode_number": 2, "field": "characters", "new_value": "Jiang Shangning,Xie Cheng", "reason": "..."},
    {"episode_number": 3, "field": "cliffhanger", "new_value": "...", "reason": "..."}
  ],
  "summary": "Fixed 2 issues: removed an invalid character, strengthened the suspense"
}
```

**Important**:
1. Output only the fields that need changing
2. Do not repeat existing content
3. Do not introduce new problems
"""


# =============================================================================
# Legacy prompt (kept for backward compatibility)
# =============================================================================


EPISODE_FIXER_PROMPT = """# You are a professional short-video episode plan fixer

## Fix priorities

| Priority | Issue type | Description |
|----------|------------|-------------|
| 1 | Narrative coherence | The storyline must flow; this matters most |
| 2 | Character arcs | Keep character development logically consistent |
| 3 | Suspense | Each episode's ending must hold the audience |
| 4 | Pacing | Balanced tension and release, well-distributed climaxes |
| 5 | Format | Technical issues such as chapter ranges and character names |

## Fix principles

1. **Minimal-change principle**: fix only the problem parts and keep the existing strengths
2. **Keep the style consistent**: fixed content must match the style of the original plan
3. **Verify the fix**: a fix must not introduce new problems
4. **Give the reason**: explain why it was fixed this way

## Tool usage

During fixing you may call the following tools for context:

| Tool | Purpose |
|------|---------|
| `get_chapter_content(start, end)` | Get chapter content, to write accurate titles/summaries |
| `get_character_state(name, episode)` | Get a character's state in a given episode |
| `generate_cliffhanger(episode, context)` | Generate a suitable cliffhanger for an episode |
| `improve_title(episode, context)` | Improve an episode's title |
| `check_continuity(ep1, ep2)` | Check continuity between two episodes |

## Common fix strategies

### 1. Narrative discontinuity (NARRATIVE_DISCONTINUITY)
- Call `get_chapter_content` to understand the plot
- Adjust the chapter split between episodes
- Add transitional content to the summary

### 2. Pacing issues (PACING_ISSUE)
- Analyze the distribution of climaxes
- Reallocate chapters so climaxes are more even
- Make sure several bland episodes do not occur in a row

### 3. Broken character arc (CHARACTER_ARC_BROKEN)
- Call `get_character_state` to check character development
- Adjust character appearance arrangements
- Revise the summary to reflect character development

### 4. Weak cliffhanger (WEAK_CLIFFHANGER)
- Call `generate_cliffhanger` to generate a new cliffhanger
- The suspense should be concrete and visual
- It should provoke audience curiosity

### 5. Unappealing title (POOR_TITLE / MISSING_TITLE)
- Call `improve_title` for suggestions
- The title should convey conflict or suspense
- Questions or exclamations work better

### 6. Chapter issues (CHAPTER_GAP / OVERLAP)
- Adjust chapter_start and chapter_end
- Make sure all chapters are covered
- No overlaps

### 7. Character name issues (INVALID_CHARACTER)
- Replace with analyzed character names
- If no match is found, try fuzzy matching
- If it truly cannot be matched, remove the character

## Output requirements

Return the fixed SeriesPlan, containing the complete information of all episodes.
Each EpisodePlan should contain:
- number: episode number
- title: title (after fixing)
- chapter_start, chapter_end: chapter range (after fixing)
- summary: summary (after fixing)
- key_events: key events
- characters: characters appearing (using valid names)
- cliffhanger: ending cliffhanger (after fixing)

**Important**:
1. Keep the existing strengths unchanged
2. Change only the problematic parts
3. After fixing, check whether new problems were introduced
"""


# =============================================================================
# Patch-based fix models (precise fixes, change only what needs changing)
# =============================================================================


class EpisodePatch(BaseModel):
    """Fix patch for a single episode.

    Describes only the fields that need changing; unmentioned fields stay as they are.
    """

    episode_number: int = Field(description="Episode number to fix")
    field: str = Field(
        description="Field to change: title/summary/cliffhanger/characters/chapter_start/chapter_end/key_events"
    )
    new_value: str = Field(
        description="New value (for characters/key_events, separate multiple values with commas)"
    )
    reason: str = Field(description="Fix reason (brief)")


class FixPlan(BaseModel):
    """Fix plan (contains only the parts that need changing).

    More precise than FixedSeriesPlan: outputs only the changed fields,
    avoiding new problems the LLM could introduce when generating a complete plan.
    """

    patches: list[EpisodePatch] = Field(
        description="List of fix patches (only the fields that need changing)"
    )
    summary: str = Field(default="", description="Fix summary")


# =============================================================================
# Legacy models (kept for backward compatibility)
# =============================================================================


class FixedEpisodePlan(BaseModel):
    """Fixed single-episode plan (legacy model, backward compatible)."""

    number: int
    title: str
    chapter_start: int
    chapter_end: int
    summary: str
    key_events: list[str] = Field(default_factory=list)
    characters: list[str] = Field(default_factory=list)
    cliffhanger: str = ""


class FixedSeriesPlan(BaseModel):
    """Fixed series plan (legacy model, backward compatible)."""

    total_episodes: int
    episodes: list[FixedEpisodePlan] = Field(default_factory=list)
    fix_notes: str = Field(default="", description="Fix notes")


# =============================================================================
# LLM Agent creation
# =============================================================================


def create_episode_fixer_agent(tools: Optional[list[Callable]] = None) -> Agent:
    """Create the episode plan fixer Agent (legacy version, outputs the full plan).

    Args:
        tools: List of fix tool functions

    Returns:
        A configured Agent
    """
    return Agent(
        get_pydantic_model(),
        system_prompt=EPISODE_FIXER_PROMPT,
        tools=tools or [],
        output_type=FixedSeriesPlan,
        model_settings=get_newapi_structured_output_model_settings(),
        name="Episode plan fixer",
    )


def create_patch_fixer_agent(tools: Optional[list[Callable]] = None) -> Agent:
    """Create a patch-based fixer Agent (new version, outputs patches only).

    Advantages:
    - Precise fixes: only changes the fields that need changing
    - Avoids introducing new problems when regenerating
    - Smaller output, faster response

    Args:
        tools: List of fix tool functions

    Returns:
        A configured Agent
    """
    return Agent(
        get_pydantic_model(),
        system_prompt=PATCH_FIXER_PROMPT,
        tools=tools or [],
        output_type=FixPlan,
        model_settings=get_newapi_structured_output_model_settings(),
        name="Episode plan fixer",
    )


def apply_patches(plan: "SeriesPlan", fix_plan: FixPlan) -> "SeriesPlan":
    """Apply patches to a plan.

    Args:
        plan: The original plan
        fix_plan: The fix plan (containing the list of patches)

    Returns:
        The fixed plan (deep copy)
    """
    fixed = copy.deepcopy(plan)

    # Index by episode number
    episode_map = {ep.number: ep for ep in fixed.episodes}

    for patch in fix_plan.patches:
        ep = episode_map.get(patch.episode_number)
        if not ep:
            print(f"  [Patch] Warning: episode {patch.episode_number} does not exist, skipping")
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
                # Comma-separated character list
                ep.characters = [c.strip() for c in value.split(",") if c.strip()]
            elif field == "key_events":
                # Comma-separated event list
                ep.key_events = [e.strip() for e in value.split(",") if e.strip()]
            elif field == "chapter_start":
                ep.chapter_start = int(value)
            elif field == "chapter_end":
                ep.chapter_end = int(value)
            else:
                print(f"  [Patch] Warning: unknown field '{field}', skipping")
                continue

            print(f"  [Patch] Episode {patch.episode_number}.{field} <- {value[:30]}{'...' if len(value) > 30 else ''}")

        except Exception as e:
            print(f"  [Patch] Error: failed to apply patch to episode {patch.episode_number}.{field}: {e}")

    return fixed


# =============================================================================
# Rule-based fixer (kept, used for basic fixes)
# =============================================================================


class EpisodePlanFixer:
    """Rule-based episode plan fixer.

    Provides basic rule-based fixes, complementing the LLM fix.
    Main fixes: chapter gaps/overlaps, character name mapping, filling missing fields.
    """

    FUZZY_MATCH_THRESHOLD = 0.6

    def fix(
        self,
        plan: "SeriesPlan",
        issues: list[EpisodePlanIssue],
        available_characters: set[str],
        total_chapters: Optional[int] = None,
    ) -> "SeriesPlan":
        """Rule-based fix of the episode plan.

        Args:
            plan: The episode plan to fix
            issues: List of issues
            available_characters: Set of analyzed character names
            total_chapters: Total number of chapters in the novel

        Returns:
            The fixed plan (deep copy)
        """
        fixed = copy.deepcopy(plan)

        # Group by issue type
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

        # 1. Fix chapter issues
        if chapter_issues:
            self._fix_chapter_issues(fixed, total_chapters)

        # 2. Fix character name issues
        if character_issues:
            self._fix_character_names(fixed, available_characters)

        # 3. Fix structural issues
        if structure_issues:
            self._fix_structure_issues(fixed, structure_issues)

        return fixed

    def _fix_chapter_issues(
        self,
        plan: "SeriesPlan",
        total_chapters: Optional[int],
    ) -> None:
        """Fix chapter issues."""
        if not plan.episodes:
            return

        # Sort by chapter start
        plan.episodes.sort(key=lambda e: e.chapter_start)

        # Fix out-of-range chapters
        if total_chapters:
            for ep in plan.episodes:
                if ep.chapter_start < 1:
                    ep.chapter_start = 1
                if ep.chapter_end > total_chapters:
                    ep.chapter_end = total_chapters

        # Fix invalid chapter ranges
        for ep in plan.episodes:
            if ep.chapter_start > ep.chapter_end:
                ep.chapter_start, ep.chapter_end = ep.chapter_end, ep.chapter_start

        # Fix gaps and overlaps
        for i in range(len(plan.episodes) - 1):
            current = plan.episodes[i]
            next_ep = plan.episodes[i + 1]

            # Fix gaps
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

            # Fix overlaps
            if next_ep.chapter_start <= current.chapter_end:
                next_ep.chapter_start = current.chapter_end + 1

        # Ensure the first episode starts at chapter 1
        if plan.episodes and plan.episodes[0].chapter_start > 1:
            plan.episodes[0].chapter_start = 1

        # Ensure the last episode covers through the last chapter
        if plan.episodes and total_chapters:
            if plan.episodes[-1].chapter_end < total_chapters:
                plan.episodes[-1].chapter_end = total_chapters

        # Renumber
        for i, ep in enumerate(plan.episodes):
            ep.number = i + 1

    def _fix_character_names(
        self,
        plan: "SeriesPlan",
        available_characters: set[str],
    ) -> None:
        """Fix character name issues."""
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

            # Deduplicate while preserving order
            seen = set()
            ep.characters = [c for c in fixed_characters if not (c in seen or seen.add(c))]

    def _fuzzy_match_character(
        self,
        name: str,
        available_characters: set[str],
    ) -> Optional[str]:
        """Fuzzy-match a character name."""
        if not available_characters:
            return None

        if name in available_characters:
            return name

        # Containment match
        for char in available_characters:
            if name in char or char in name:
                return char

        # Similarity match
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
        """Fix structural issues."""
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
        """Fix a missing title."""
        if (
            ep.title
            and ep.title.strip()
            and ep.title != f"Episode {ep.number}"
        ):
            return

        # Generate from summary
        if ep.summary and len(ep.summary) > 10:
            # Extract keywords from the summary as the title
            title = self._extract_title_from_summary(ep.summary)
            if title:
                ep.title = title
                return

        # Generate from key_events
        if ep.key_events:
            event = ep.key_events[0]
            title = event[:40].strip()
            while title and title[-1] in ",.!?;: ":
                title = title[:-1]
            if title:
                ep.title = title
                return

        # Generate from cliffhanger
        if ep.cliffhanger:
            title = ep.cliffhanger[:40].strip()
            while title and title[-1] in ",.!?;: ":
                title = title[:-1]
            if title:
                ep.title = title + "?"
                return

        ep.title = f"Episode {ep.number}: Storm Rising"

    def _extract_title_from_summary(self, summary: str) -> Optional[str]:
        """Extract a title from the summary."""
        # Try to extract a phrase with a sense of conflict
        keywords = [
            "discover",
            "decide",
            "reveal",
            "face",
            "encounter",
            "secret",
            "truth",
            "crisis",
            "turning point",
        ]

        lowered = summary.lower()
        for kw in keywords:
            if kw in lowered:
                # Find the keyword position and take the surrounding text
                idx = lowered.find(kw)
                start = max(0, idx - 20)
                end = min(len(summary), idx + 40)
                title = summary[start:end].strip()

                # Clean up punctuation
                while title and title[0] in ",.!?;: ":
                    title = title[1:]
                while title and title[-1] in ",.!?;: ":
                    title = title[:-1]

                if len(title) >= 4:
                    return title

        # Otherwise take the first 40 characters directly
        title = summary[:40].strip()
        while title and title[-1] in ",.!?;: ":
            title = title[:-1]

        return title if len(title) >= 4 else None

    def _fix_missing_summary(self, ep: "EpisodePlan") -> None:
        """Fix a missing summary."""
        if ep.summary and len(ep.summary.strip()) >= 10:
            return

        if ep.key_events:
            ep.summary = ". ".join(ep.key_events[:3])
            if not ep.summary.endswith("."):
                ep.summary += "."
            return

        ep.summary = f"Content of chapters {ep.chapter_start}-{ep.chapter_end}."

    def _fix_missing_cliffhanger(self, ep: "EpisodePlan") -> None:
        """Fix a missing cliffhanger."""
        if ep.cliffhanger and len(ep.cliffhanger.strip()) >= 5:
            return

        # Build from the last key event
        if ep.key_events:
            last_event = ep.key_events[-1]
            ep.cliffhanger = last_event + ", what will happen next?"
            return

        # Build from the last sentence of the summary
        if ep.summary:
            sentences = ep.summary.replace("!", ".").replace("?", ".").split(".")
            sentences = [s.strip() for s in sentences if s.strip()]
            if sentences:
                ep.cliffhanger = sentences[-1] + "..."
                return

        ep.cliffhanger = "How will the story unfold? Stay tuned..."


def create_episode_plan_fixer() -> EpisodePlanFixer:
    """Create the rule-based episode plan fixer."""
    return EpisodePlanFixer()


if TYPE_CHECKING:
    from novelvideo.agents.episode_planner import SeriesPlan, EpisodePlan
