"""Episode planning Agent.

Uses the PydanticAI Agent framework + Cognee graph search for multi-round iterative episode planning.
Replaces the single LLM call in the original pipeline.py to achieve smarter episode splitting.

Architecture:
    EpisodePlannerAgent
    ├── Toolset (create_episode_planner_tools)
    │   ├── tool_search_plot_points()       # search plot turning points
    │   ├── tool_search_character_arcs()    # search character arcs
    │   ├── tool_search_relationship_changes()  # search relationship changes
    │   ├── tool_search_timeline_events()   # search events by time
    │   ├── tool_get_story_structure()      # get the story structure
    │   └── tool_get_all_characters_for_planning()  # get the character list
    │
    └── Multi-round iteration
        ├── Round 1: search the whole book for climaxes / turning points
        ├── Round 2: identify character relationship change points
        ├── Round 3: plan episode boundaries
        └── Round 4: generate episode outlines
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

if TYPE_CHECKING:
    from novelvideo.cognee import CogneeStore
    from novelvideo.models import NovelEpisode


# =============================================================================
# Output Schema
# =============================================================================


class EpisodePlan(BaseModel):
    """Output for a single episode plan."""

    number: int = Field(description="Episode number (starting from 1)")
    title: str = Field(description="Episode title (engaging, with suspense)", min_length=2)
    chapter_start: int = Field(default=0, description="Corresponding starting chapter (estimate)")
    chapter_end: int = Field(default=0, description="Corresponding ending chapter (estimate)")
    content_summary: str = Field(
        description="Content summary (within 40 words, summarizing the main plot of this episode)",
        min_length=10,
        max_length=300,
    )
    main_conflict: str = Field(
        description="Main conflict (the core point of contention in this episode)",
    )
    cliffhanger: str = Field(
        description="Ending suspense (the hook that makes the audience want the next episode)",
        min_length=5,
    )
    key_events: List[str] = Field(
        description="List of key events (3-5)",
        min_length=1,
    )
    character_names: List[str] = Field(
        description="Characters appearing in this episode (choose from the known character list)",
        min_length=1,
    )


class EpisodePlannerOutput(BaseModel):
    """Episode planning output."""

    episodes: List[EpisodePlan] = Field(description="List of episodes")


# =============================================================================
# Agent Prompt
# =============================================================================


EPISODE_PLANNER_PROMPT = """# You are a professional episode planner

## Task
Plan the novel content into the specified number of episodes. Each episode needs its own conflict and suspense while the overall narrative stays coherent.

## Tool usage strategy (important)

You have several graph search tools; use them fully in the following order:

### Step 1: Understand the overall story structure
1. Call `tool_get_story_structure()` to get the overall story framework
2. Call `tool_get_all_characters_for_planning()` to get the character list

### Step 2: Identify key points
3. Call `tool_search_plot_points("main conflicts and turning points")` to find the climaxes
4. Call `tool_search_timeline_events("main events from the opening to the ending")` to get the timeline

### Step 3: Analyze character development
5. For the main characters call `tool_search_character_arcs(character name)` to understand character arcs
6. Call `tool_search_relationship_changes("relationship changes between main characters")` to understand how relationships evolve

### Step 4: Determine episode boundaries
7. Based on the above, find natural episode split points (for example:
   - A major conflict erupting / being resolved
   - A turn in a character's fate
   - A major change in a relationship
   - A suspense being revealed / a new suspense arising)

### Step 5: Detail each episode
8. For each episode's chapter range call `tool_search_chapter_summary(range)` to get the detailed content
9. Call `tool_search_cliffhanger_candidates(episode content)` to find suitable suspense points

## Episode planning principles

### Structure requirements
- Episode 1: establish the world, introduce the protagonist, plant the main-line foreshadowing
- Episodes 2-3: develop conflicts, unfold subplots
- Middle episodes: advance the main line, character growth, relationship changes
- Third- and second-to-last episodes: main conflict escalates, prelude to the climax
- Final 1-2 episodes: climax, resolution, open space

### Per-episode requirements
1. **Completeness**: each episode has its own beginning - development - climax
2. **Suspense**: each episode must end with suspense that makes the audience want the next one
3. **Conflict**: each episode has a clear main conflict
4. **Characters**: limit the number of characters appearing (3-6 is ideal)
5. **Duration**: the amount of content suits a 3-5 minute video

### Cliffhanger techniques
- Reveal the suspense halfway (e.g. the door is pushed open, the visitor is...)
- A crisis arrives (e.g. a messenger brings bad news...)
- A twist teaser (e.g. what she did not know was...)
- A secret exposed (e.g. a letter slips out of the sleeve...)

## Character reference rules

`character_names` must be chosen from the known character list; do not invent new character names.

## Output requirements

After using the tools to search thoroughly, output JSON in the EpisodePlannerOutput format.
Make sure:
1. Numbering starts at 1 and is contiguous
2. Every episode has a cliffhanger
3. Character names match the known list
"""


# =============================================================================
# Agent Factory
# =============================================================================


def create_episode_planner_agent(tools: List[Callable]) -> Agent:
    """Create the episode planner Agent.

    Args:
        tools: List of episode planning tools

    Returns:
        A configured Agent
    """
    return Agent(
        get_pydantic_model(brainclaw_profile=BrainClawProfile.EPISODE_STORY_PLANNING),
        system_prompt=EPISODE_PLANNER_PROMPT,
        tools=tools,
        output_type=EpisodePlannerOutput,
        model_settings=get_newapi_structured_output_model_settings(),
        output_retries=3,
        name="Episode planner",
    )


# =============================================================================
# EpisodePlannerAgent class
# =============================================================================


# Legacy-only AI episode planner.
# No current frontend workflow selects this mode: the "plan episodes" button
# posts an empty body (frontend/src/routes/_app/projects.$project/episodes.tsx),
# so planning_mode falls back to the "chapters" default in api/schemas.py.
# Reaching this code still requires an explicit planning_mode="ai" from an API
# client. Structured-v2 projects must not enter this path.
class EpisodePlannerAgent:
    """Episode planner Agent - multi-round iterative planning using graph search.

    Makes full use of the Cognee graph search capabilities to produce a higher-quality episode plan.

    Example:
        >>> planner = EpisodePlannerAgent(cognee_store)
        >>> episodes = await planner.plan_episodes(target_episodes=10)
    """

    def __init__(self, store: "CogneeStore"):
        """Initialize the episode planner Agent.

        Args:
            store: CogneeStore instance (used for graph search)
        """
        self.store = store
        self.tools = create_episode_planner_tools(store)

    async def plan_episodes(
        self,
        target_episodes: int,
        known_characters: Optional[List[str]] = None,
        on_progress: Optional[Callable[[float, str], None]] = None,
        on_log: Optional[Callable[[str], None]] = None,
    ) -> List["NovelEpisode"]:
        """Plan the episodes.

        Uses the Agent for multi-round iterative planning:
        1. Search the story structure and climaxes
        2. Identify character relationship change points
        3. Plan the episode boundaries
        4. Generate the episode outlines

        Args:
            target_episodes: Target number of episodes
            known_characters: List of known character names (to restrict character references)
            on_progress: Progress callback
            on_log: Log callback

        Returns:
            The list of planned episodes
        """
        from novelvideo.models import NovelEpisode

        def report(progress: float, task: str):
            if on_progress:
                on_progress(progress, task)

        def log(message: str):
            if on_log:
                on_log(message)
            print(f"[EpisodePlanner] {message}")

        log_agent_start("Episode planner", f"Planning {target_episodes} episodes")
        report(0.1, "Initializing planning...")

        # Get the known character list
        if known_characters is None:
            characters = await self.store.list_characters()
            known_characters = [c.name for c in characters]
        log(f"Known characters: {len(known_characters)}")

        # Build the character hint
        character_hint = ""
        if known_characters:
            character_hint = f"""

## Known character list
These are the confirmed characters; the character_names field may only be chosen from this list:
{", ".join(known_characters)}
"""

        # Create the Agent
        agent = create_episode_planner_agent(self.tools)

        # Build the task
        task = f"""Plan {target_episodes} episodes for this novel.
{character_hint}

Follow these steps:

1. First call tool_get_story_structure() to understand the overall story structure
2. Call tool_get_all_characters_for_planning() to confirm the character list
3. Call tool_search_plot_points("main conflicts and climaxes") to find key points
4. Call tool_search_timeline_events("from the opening to the ending") to get the timeline
5. Plan {target_episodes} episodes based on the search results

Make sure:
- Each episode has its own conflict and suspense
- Character names come only from the known list
- The cliffhanger makes the audience want to watch the next episode
"""

        report(0.2, "Agent searching story information...")
        log("Starting multi-round search...")

        try:
            # Run the Agent (it makes multiple tool calls automatically)
            result = await agent.run(task)

            report(0.7, "Parsing the planning result...")

            # Parse the output
            output = result.output

            log(f"Agent returned a plan of {len(output.episodes)} episodes")

            # Convert to NovelEpisode
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

            # Validate and fix numbering
            episodes = self._validate_and_fix_episodes(episodes, target_episodes, log)

            log_agent_end("Episode planner", success=True, result=f"Planned {len(episodes)} episodes")
            report(1.0, "Done")

            return episodes

        except Exception as e:
            log_agent_end("Episode planner", success=False, result=str(e))
            log(f"Agent planning failed: {e}")
            raise

    def _validate_and_fix_episodes(
        self,
        episodes: List["NovelEpisode"],
        target_count: int,
        log: Callable[[str], None],
    ) -> List["NovelEpisode"]:
        """Validate and fix the episode list.

        Ensures:
        - Numbering starts at 1
        - Numbering is contiguous
        - The count matches the expectation

        Args:
            episodes: The original episode list
            target_count: The target count
            log: Log function

        Returns:
            The corrected episode list
        """
        if not episodes:
            return episodes

        # Sort by number
        episodes.sort(key=lambda ep: ep.number)

        # Check that numbering starts at 1
        if episodes[0].number != 1:
            log(f"Renumbering: starting from 1 instead of {episodes[0].number}")
            for i, ep in enumerate(episodes, start=1):
                ep.number = i

        # Check that numbering is contiguous
        for i, ep in enumerate(episodes, start=1):
            if ep.number != i:
                log(f"Renumbering {ep.number} -> {i}")
                ep.number = i

        # Check the count
        if len(episodes) < target_count:
            log(f"Warning: planned episode count ({len(episodes)}) is below the target ({target_count})")
        elif len(episodes) > target_count:
            log(f"Warning: planned episode count ({len(episodes)}) is above the target ({target_count})")

        return episodes

# =============================================================================
# Factory function
# =============================================================================


def create_episode_planner(store: "CogneeStore") -> EpisodePlannerAgent:
    """Create the episode planner Agent.

    Args:
        store: CogneeStore instance

    Returns:
        An EpisodePlannerAgent instance
    """
    return EpisodePlannerAgent(store)
