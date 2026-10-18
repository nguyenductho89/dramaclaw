"""Cognee tool functions.

Provide query capabilities for planning and review agents that still use graph retrieval.
Agents run inside the task runner, and the tools are plain async def, reusing the current event loop.

Tool sets:
- create_episode_planner_tools: episode planning agent tools
- create_reviewer_tools: script review/fix agent tools (for identity validation)
"""

from typing import Callable, List

from novelvideo.cognee import CogneeStore
from novelvideo.utils.logging import tool_logger

# Legacy-only AI episode planner.
# No current frontend workflow selects this mode: the "plan episodes" button
# posts an empty body (frontend/src/routes/_app/projects.$project/episodes.tsx),
# so planning_mode falls back to the "chapters" default in api/schemas.py.
# Reaching this code still requires an explicit planning_mode="ai" from an API
# client. Structured-v2 projects must not enter this path.
# These tools all run cognee.search() and therefore require an embedding index.
def create_episode_planner_tools(store: CogneeStore) -> List[Callable]:
    """Create the Cognee tool set for EpisodePlanner.

    Give the episode planning agent graph search capability, used to:
    - identify plot climaxes and turning points
    - find character relationship change points
    - get events in chronological order
    - get the character list

    All tools are async def and reuse the current event loop directly.
    """

    @tool_logger("search_plot_points")
    async def tool_search_plot_points(query: str) -> str:
        """Search for plot turning points and climaxes.

        Used to identify key plot nodes in the story, such as:
        - major conflict outbreaks
        - turning points in a character's fate
        - suspense reveals
        - emotional climaxes

        Args:
            query: Plot query, e.g. "the main conflict events", "turning points in a character's fate"
        """
        enhanced_query = f"Important turning points and climaxes in the story: {query}"
        return await store.search(enhanced_query, mode="graph")

    @tool_logger("search_character_arcs")
    async def tool_search_character_arcs(character_name: str) -> str:
        """Search for a character's growth arc and key changes.

        Find the main change points of a character in the story, such as:
        - identity changes
        - personality shifts
        - relationship changes
        - fate turning points

        Args:
            character_name: Character name
        """
        query = f"The main changes and growth points of {character_name} in the story, including identity changes, important decisions and relationship shifts"
        return await store.search(query, mode="triplet")

    @tool_logger("search_relationship_changes")
    async def tool_search_relationship_changes(query: str) -> str:
        """Search for character relationship changes.

        Find major changes in relationships between characters, such as:
        - from hostile to friendly
        - betrayal
        - alliance
        - separation

        Args:
            query: Relationship query, e.g. "how the protagonist's relationship with the antagonist changes"
        """
        return await store.search(query, mode="triplet")

    @tool_logger("get_story_structure")
    async def tool_get_story_structure() -> str:
        """Get an overview of the overall story structure.

        Return high-level information such as the story's setup, development, turn and resolution, main conflicts and character factions.
        """
        query = "The overall structure of the story, including beginning, development, climax and ending, as well as the main conflicts and character factions"
        return await store.search(query, mode="summaries")

    @tool_logger("get_all_characters_for_planning")
    async def tool_get_all_characters_for_planning() -> str:
        """Get the list of all characters (for episode planning).

        Return the character name, role, importance and other information.
        """
        characters = await store.list_characters()
        if not characters:
            return "No character information yet"

        lines = ["## Character list (for episode planning)"]
        for char in characters:
            role_info = f"({char.role})" if char.role else ""
            lines.append(
                f"- {char.name} {role_info}: {char.description[:50]}..."
                if char.description
                else f"- {char.name} {role_info}"
            )
        return "\n".join(lines)

    @tool_logger("search_chapter_summary")
    async def tool_search_chapter_summary(chapter_range: str) -> str:
        """Get a summary of the specified chapter range.

        Args:
            chapter_range: Chapter range, e.g. "1-10", "first 5 chapters", "middle chapters"
        """
        query = f"The main plot, conflicts and character performance of chapters {chapter_range}"
        return await store.search(query, mode="summaries")

    @tool_logger("search_conflict_events")
    async def tool_search_conflict_events(query: str) -> str:
        """Search for conflict events.

        Find conflicts, confrontations and contradictions in the story.

        Args:
            query: Conflict query, e.g. "the conflict between the queen and the concubines", "court power struggles"
        """
        enhanced_query = f"Conflicts and confrontations: {query}"
        return await store.search(enhanced_query, mode="graph_cot")

    @tool_logger("search_cliffhanger_candidates")
    async def tool_search_cliffhanger_candidates(context: str) -> str:
        """Search for plot points suitable as a cliffhanger at the end of an episode.

        Args:
            context: Context of the current episode, used to find a suitable cliffhanger point
        """
        query = f"After {context}, which events can serve as a cliffhanger or hook that makes the audience look forward to the next episode"
        return await store.search(query, mode="context_ext")

    return [
        tool_search_plot_points,
        tool_search_character_arcs,
        tool_search_relationship_changes,
        tool_get_story_structure,
        tool_get_all_characters_for_planning,
        tool_search_chapter_summary,
        tool_search_conflict_events,
        tool_search_cliffhanger_candidates,
    ]


def create_reviewer_tools(store: CogneeStore) -> List[Callable]:
    """Create the tool set dedicated to ScriptReviewer/ScriptFixer.

    Give the reviewer and fixer character identity lookup and validation capabilities,
    solving the "blind men and the elephant" problem of Reviewer/Fixer - being unable to access identity metadata.

    Tool list:
    - tool_get_character: look up character details and all identities
    - tool_validate_identity: validate whether an identity ID is valid
    - tool_list_all_identities: list the identities of all characters
    """

    @tool_logger("get_character")
    async def tool_get_character(name: str) -> str:
        """Look up all identity information of a character.

        Return the detailed information of the character, including all available identities and their appearance descriptions.
        Used to verify that the identity IDs used in the script are correct.

        Args:
            name: Character name (aliases are resolved)

        Returns:
            Character details string, including the identity list
        """
        # Resolve aliases
        resolved_name = store.resolve_name(name)
        char = await store.get_character_from_graph(resolved_name)
        if not char:
            return f"Character not found: {name}"
        return store.format_character_context(char)

    @tool_logger("validate_identity")
    async def tool_validate_identity(identity_id: str) -> str:
        """Validate whether an identity ID is valid.

        Check whether the given identity ID exists in the system;
        if it is invalid, return all available identities of that character.

        Args:
            identity_id: Identity ID, in the format "character_name_identity_name"

        Returns:
            Validation result:
            - valid: returns the identity appearance description
            - invalid: returns the list of available identities
        """
        if "_" not in identity_id:
            return f"❌ Invalid format: {identity_id}, expected 'character_name_identity_name'"

        # Try to resolve the character name (it may contain several underscores)
        parts = identity_id.split("_")
        char = None
        char_name = None

        # Try to match the character name from longest to shortest
        for i in range(len(parts) - 1, 0, -1):
            candidate_name = "_".join(parts[:i])
            resolved = store.resolve_name(candidate_name)
            candidate_char = await store.get_character_from_graph(resolved)
            if candidate_char:
                char = candidate_char
                char_name = resolved
                break

        if not char:
            # Use the part before the first underscore as the character name
            char_name = parts[0]
            resolved = store.resolve_name(char_name)
            char = await store.get_character_from_graph(resolved)

        if not char:
            return f"❌ Character not found: {char_name}"

        # Check whether the identity is valid
        for identity in char.identities:
            if identity.identity_id == identity_id:
                desc = (
                    identity.appearance_details[:100]
                    if identity.appearance_details
                    else "No appearance description"
                )
                return f"✅ Valid identity: {identity_id}\nAppearance: {desc}"

        # Identity is invalid; return the available list
        valid_ids = [i.identity_id for i in char.identities]
        return f"❌ Invalid identity: {identity_id}\nAvailable identities: {', '.join(valid_ids)}"

    @tool_logger("list_all_identities")
    async def tool_list_all_identities() -> str:
        """List the identities of all characters.

        Return the complete list of all characters in the system and their identities,
        so the reviewer can check by lookup whether the identity choice is correct.

        Returns:
            Formatted character identity list
        """
        characters = await store.list_characters()
        if not characters:
            return "No character information yet"

        lines = ["## All character identities"]
        for char in characters:
            if char.identities:
                lines.append(f"\n### {char.name}")
                for identity in char.identities:
                    desc = identity.appearance_details
                    if desc:
                        desc = desc[:60] + "..." if len(desc) > 60 else desc
                    else:
                        desc = "No appearance description"
                    lines.append(f"- {identity.identity_id}: {desc}")

        return "\n".join(lines)

    @tool_logger("search_plot_context")
    async def tool_search_plot_context(query: str) -> str:
        """Search the source plot to verify that the narration matches the original work.

        Used when reviewing a script to verify plot details and character interactions against the source text.

        Args:
            query: Plot query, e.g. "what the protagonist did in episode 3", "the relationship between characters A and B"
        """
        return await store.search(query, mode="graph")

    @tool_logger("search_background")
    async def tool_search_background(query: str) -> str:
        """Extended context search to get the story background needed for fixes.

        Automatically link related entities and events to provide richer context.
        Used when fixing a script to understand character background and plot context.

        Args:
            query: Background query, e.g. "a character's growth experience", "the causes and effects of an event"
        """
        return await store.search(query, mode="context_ext")

    return [
        # Identity validation
        tool_get_character,
        tool_validate_identity,
        tool_list_all_identities,
        # Graph search
        tool_search_plot_context,
        tool_search_background,
    ]
