"""NovelVideo custom Cognee Pipeline.

Implements retrieval and structured extraction over the novel knowledge graph:
- The knowledge graph of the raw novel is built by Cognee
- Product data such as characters, episodes, scenes and props is persisted in SQLite
- Planning and extraction flows only read from Cognee and never write derived product data back to the graph
"""

from __future__ import annotations


import hashlib
import json
import re
from typing import Any, Awaitable, Callable, Dict, List, Literal, Optional, Protocol, TypeVar
from pydantic import BaseModel, Field, field_validator, model_validator

from novelvideo.i18n_message import MessageLike, lmsg
from novelvideo.shared.env_guard import preserve_st_env
from novelvideo.config import get_newapi_structured_output_litellm_kwargs
from novelvideo.utils.bounded_concurrency import (
    default_llm_concurrency,
    map_bounded,
)
from novelvideo.utils.source_language import (
    AssetLanguage,
    asset_language_instruction,
    detect_asset_language,
)
from novelvideo.models import (
    CharacterIdentity,
    NovelCharacter,
    NovelEpisode,
    NovelEvent,
    NovelVisualBeat,
)
from novelvideo.cognee.screenplay_normalizer import (
    NormalizedSceneBlock,
    clean_scene_name_and_time,
    normalize_time_of_day,
    normalize_screenplay_scenes,
)
from novelvideo.time_of_day import LlmTimeOfDay

# Important: config must be imported first so env vars are set before cognee is imported
from . import config as _cognee_config  # noqa: F401
from .ladybug_access import ladybug_graph_access

# Heavy cognee modules are imported lazily (avoids pulling in the whole init chain on reload)
# LLMGateway, Task, run_pipeline, setup
# Imported on demand inside each function

# Business models have moved to novelvideo.models
from novelvideo.models import (
    CharacterIdentity,
    NovelCharacter,
    NovelEvent,
    NovelEpisode,
    NovelVisualBeat,
    NovelScene,
    NovelProp,
)

# ============================================================
# LLM output containers
# ============================================================


class CharacterList(BaseModel):
    """Character list container."""

    characters: List[NovelCharacter]


class EpisodeList(BaseModel):
    """Episode list container."""

    episodes: List[NovelEpisode]


_GraphReadResult = TypeVar("_GraphReadResult")


async def _run_graph_read(
    state_dir: Optional[str],
    operation: Callable[[], Awaitable[_GraphReadResult]],
) -> _GraphReadResult:
    """Run only the actual Ladybug query under the project read scope."""

    if not state_dir:
        # Test doubles can operate without project storage. A real Ladybug
        # adapter fails closed because it requires an explicit access scope.
        return await operation()
    async with ladybug_graph_access(state_dir, read_only=True):
        return await operation()


def _stringify_search_fragment(value) -> str:
    """Normalize heterogeneous Cognee search payloads into plain text."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(
            fragment
            for fragment in (_stringify_search_fragment(item) for item in value)
            if fragment
        )
    if isinstance(value, dict):
        search_result = value.get("search_result")
        if search_result is not None and search_result is not value:
            return _stringify_search_fragment(search_result)
        return json.dumps(value, ensure_ascii=False)
    if hasattr(value, "model_dump"):
        return json.dumps(value.model_dump(), ensure_ascii=False)
    return str(value)


def _clean_aliases(primary_name: str, aliases: List[str]) -> List[str]:
    """Normalize aliases: strip, deduplicate, and drop entries equivalent to the primary name."""
    primary = (primary_name or "").strip()
    cleaned: List[str] = []
    seen: set[str] = set()
    for alias in aliases or []:
        normalized = (alias or "").strip()
        if not normalized or normalized == primary or normalized in seen:
            continue
        cleaned.append(normalized)
        seen.add(normalized)
    return cleaned


# ============================================================
# Custom extraction tasks
# ============================================================


async def extract_episodes_from_text(
    text: str,
    target_episodes: int = 10,
) -> List[NovelEpisode]:
    """Plan episodes from the novel text."""
    with preserve_st_env():
        from cognee.infrastructure.llm.LLMGateway import LLMGateway

    system_prompt = f"""You are a professional episode planner. Plan the novel content into {target_episodes} episodes.

For each episode, generate:
1. number: episode number
2. title: an attractive title
3. content_summary: content summary (within 50 words)
4. main_conflict: the main conflict
5. cliffhanger: an ending cliffhanger (makes the audience want to watch the next episode)
6. key_events: list of key events

Rules:
- Every episode must have a clear conflict and cliffhanger
- The plot must be coherent, with setups and payoffs
- Put the climax in the middle-to-late part"""

    result = await LLMGateway.acreate_structured_output(
        text,
        system_prompt,
        EpisodeList,
        **get_newapi_structured_output_litellm_kwargs(),
    )
    return result.episodes


async def generate_visual_prompts(
    characters: List[NovelCharacter],
) -> List[NovelCharacter]:
    """Generate/optimize face_prompt for characters.

    Note: no style prefix is added; the style is added dynamically at image generation time.
    """
    # Skip if face_prompt already exists
    for char in characters:
        if not char.face_prompt and char.description:
            # Generate pure facial features from the description (simple fallback)
            char.face_prompt = f"{char.name}, {char.gender}, {char.description}"
    return characters


# ============================================================
# Unified Pipeline
# ============================================================


async def _attach_character_metadata(
    characters: List[NovelCharacter],
    project_name: str = "",  # kept for backward compatibility, no longer used
) -> List[NovelCharacter]:
    """Attach metadata to characters.

    Note: project_name is no longer needed because of database-level isolation.
    """
    return characters


async def _attach_episode_metadata(
    episodes: List[NovelEpisode],
    project_name: str = "",  # kept for backward compatibility, no longer used
) -> List[NovelEpisode]:
    """Attach metadata to episodes.

    Note: project_name is no longer needed because of database-level isolation.
    """
    return episodes


async def run_character_extraction_pipeline(
    text: str,
    dataset_name: str = "novel",
    project_name: str = "",
) -> List[NovelCharacter]:
    """Run the character extraction pipeline (deprecated).

    Text extraction has been removed; use build_characters_from_graph() to extract characters from the graph instead.
    """
    raise NotImplementedError(
        "extract_characters_from_text has been removed. "
        "Use CogneeStore.build_characters_from_graph() to extract characters from the graph."
    )


async def run_episode_planning_pipeline(
    text: str,
    target_episodes: int = 10,
    dataset_name: str = "novel",
    project_name: str = "",
) -> List[NovelEpisode]:
    """Run the episode planning pipeline."""
    with preserve_st_env():
        from cognee.modules.pipelines import Task, run_pipeline
        from cognee.modules.engine.operations.setup import setup

    await setup()

    async def extract_with_count(t: str) -> List[NovelEpisode]:
        return await extract_episodes_from_text(t, target_episodes)

    async def attach_metadata(episodes: List[NovelEpisode]) -> List[NovelEpisode]:
        return await _attach_episode_metadata(episodes, project_name)

    # Wrapper function used to capture intermediate results
    captured_episodes: List[NovelEpisode] = []

    async def capture_episodes(episodes: List[NovelEpisode]) -> List[NovelEpisode]:
        """Capture planner output; the caller persists episodes to SQLite."""
        nonlocal captured_episodes
        captured_episodes = episodes
        return episodes

    tasks = [
        Task(extract_with_count),
        Task(attach_metadata),
        Task(capture_episodes),
    ]

    async for result in run_pipeline(tasks=tasks, data=text, datasets=[dataset_name]):
        # Try to get the episodes from the result
        if isinstance(result, list) and result and isinstance(result[0], NovelEpisode):
            captured_episodes = result

    return captured_episodes


# ============================================================
# Staged build: extract characters from the graph
# ============================================================


class CharacterEnrichment(BaseModel):
    """Character information supplemented by the LLM (no identities; identities are planned per episode by IdentityPlanner)."""

    name: str = Field(..., description="Primary character name")
    aliases: List[str] = Field(
        default_factory=list, description="Stable aliases/nicknames/fixed forms of address that actually appear in the source text"
    )
    role: str = Field(default="", description="Character role")
    is_main: bool = Field(default=False, description="Whether this is the protagonist/core character")
    gender: str = Field(default="", description="Gender: male/female/other")
    age_group: Literal["child", "youth", "middle", "elder"] = Field(
        default="youth", description="Age group: child/youth/middle/elder"
    )
    body_type: str = Field(default="", description="Body type description")
    description: str = Field(default="", description="Appearance description")
    face_prompt: str = Field(
        default="",
        description="Pure facial feature description (hairstyle, eyes, skin tone), without clothing",
    )


class CharacterEnrichmentList(BaseModel):
    """List of supplemental character information."""

    characters: List[CharacterEnrichment]


async def extract_characters_from_graph(
    dataset_name: str = "novel",
    project_name: str = "",
    project_dir: Optional[str] = None,
    state_dir: Optional[str] = None,
    novel_text: Optional[str] = None,
    on_progress: Optional[Any] = None,
    on_log: Optional[Any] = None,
) -> List[NovelCharacter]:
    """Extract characters from the cognee graph (staged architecture).

    Flow:
    1. Get the graph context (summary of people + relationships) via cognee.search(only_context=True)
    2. Extract character information with LLM structured output
    3. Post-process and deduplicate
    4. Return to the caller, which persists to SQLite

    Args:
        dataset_name: Cognee dataset name
        project_name: Project name
        project_dir: Project directory (used for fallback full-text extraction)
        on_progress: Progress callback
        on_log: Log callback

    Returns:
        List of extracted characters
    """
    with preserve_st_env():
        import cognee
        from cognee.api.v1.search import SearchType
        from cognee.infrastructure.llm.LLMGateway import LLMGateway

    def report(progress: float, task: MessageLike):
        if on_progress:
            on_progress(progress, task)

    def log(message: MessageLike):
        print(f"[extract_characters] {message}")

    # Step 1: get the graph context via cognee.search
    report(0.1, "Retrieving character information through the graph...")
    log("Using cognee.search(only_context=True) to get the graph context...")

    context_text = ""
    try:
        results = await _run_graph_read(
            state_dir,
            lambda: cognee.search(
                query_text="List all characters in the novel, including their relationships, aliases, identity traits and appearance descriptions",
                query_type=SearchType.GRAPH_COMPLETION,
                datasets=[dataset_name],
                only_context=True,
                top_k=30,
            ),
        )
        if results:
            parts = []
            for item in results:
                if hasattr(item, "search_result"):
                    parts.append(_stringify_search_fragment(item.search_result))
                elif isinstance(item, dict):
                    parts.append(_stringify_search_fragment(item))
                else:
                    parts.append(_stringify_search_fragment(item))
            context_text = "\n".join(parts)
            log(f"Graph context retrieved: {len(context_text)} chars")
    except Exception as e:
        import logging

        logging.warning(f"cognee.search failed: {e}")
        log(f"cognee.search failed: {e}")
        raise RuntimeError("Cognee graph character search failed") from e

    if not context_text.strip():
        log("⚠️ Graph search returned no data; build the graph first (cognify)")
        return []

    # Inject the character setting context (supplements the graph, does not replace it)
    if novel_text:
        from .script_parser import extract_synopsis

        synopsis = extract_synopsis(novel_text)
        if synopsis:
            context_text += f"\n\n[Original screenplay character settings]\n{synopsis}"
            log(f"Injected character setting context: {len(synopsis)} chars")

    # Step 2: LLM structured extraction
    report(0.3, "Extracting characters with LLM structured output...")
    log("Running LLM structured extraction with the graph context...")

    system_prompt = f"""You are a novel character analysis expert. Below are the characters and relationships extracted from the knowledge graph.
Extract all characters based on the graph context.

⚠️ Core rules:
1. **Extract human characters only** (male and female characters)
2. **Do not extract**: animals, pets, divine beasts, monsters, spirits, robots or other non-human entities
3. Aliases/forms of address in the graph (e.g. "Your Majesty" -> Xiao Jue, "Prince Jing" -> some person) must be merged into the same character
4. **Do not extract identity/costume information** — identities are planned separately by a later step
5. **Age variants are the same character**: the childhood/teen/young adult/middle-aged/elderly forms of the same person must be merged into a single character, and age_group is the age group of the character's **dominant period** in the story. Appearance differences at different ages are handled by the later identity system and are not split in this step. For example: if the novel contains "Little Xie Zheng" (childhood flashback) and "Xie Zheng" (adult main storyline), merge them into one character "Xie Zheng", age_group="youth", with "Little Xie Zheng" in aliases

For each character, generate:
1. name: the primary character name (the most formal form of address)
2. aliases: other forms of address/titles/nicknames that actually appear in the source text for this character (stable aliases discovered through graph relations)
3. role: character role (e.g. protagonist, best friend, ex-boyfriend, queen)
4. is_main: whether this is the narrating protagonist/first-person narrator (only 1 character in the whole novel may have is_main=True)
5. gender: gender (male/female/other)
6. age_group: age group classification, must be one of: child / youth / middle / elder
7. body_type: body type description (e.g. slender and tall, sturdy and muscular, petite and delicate)
8. description: appearance and personality traits

9. **face_prompt**: pure facial feature description (⚠️ critical! no clothing!)
      Format: [gender], [age range], [hairstyle and hair color], [eye features], [skin tone], [face shape/bone structure]
      Example: "Female, in her twenties, long black ponytail, black almond eyes, wheat-toned skin, oval face"
      ⚠️ Do not describe clothing in face_prompt!

Rules:
- face_prompt must be pure facial features and must never contain clothing descriptions
- Different forms of address for the same person in the graph must be merged (use relations such as is_alias_of and same_as)
- aliases only keep forms of address that actually appear in the source text and stably point to this character
- Do not put overly generic, context-dependent forms of address into aliases, e.g. highly ambiguous terms such as "the man / the woman / the boss / dad / the daughter / the clerk" should not be included by default, unless the graph context clearly shows that it stably refers to the same character
- If information is insufficient, you may only make conservative guesses for role / body_type / description; do not invent forms of address for aliases that do not appear in the source"""

    try:
        result = await LLMGateway.acreate_structured_output(
            context_text,
            system_prompt,
            CharacterEnrichmentList,
            **get_newapi_structured_output_litellm_kwargs(),
        )
        characters = []
        for enriched in result.characters:
            # Automatically map the Fish Audio voice ID
            from novelvideo.config import get_fish_voice_id

            fish_voice_id = get_fish_voice_id(enriched.age_group, enriched.gender)
            char = NovelCharacter(
                name=enriched.name,
                aliases=_clean_aliases(enriched.name, enriched.aliases or []),
                role=enriched.role,
                is_main=enriched.is_main,
                gender=enriched.gender,
                age_group=enriched.age_group,
                body_type=enriched.body_type,
                fish_voice_id=fish_voice_id,
                description=enriched.description,
                face_prompt=enriched.face_prompt,
            )
            char.ensure_tag()
            characters.append(char)
        main_count = sum(1 for c in characters if c.is_main)
        if main_count > 1:
            found_first = False
            for character in characters:
                if not character.is_main:
                    continue
                if found_first:
                    character.is_main = False
                else:
                    found_first = True
            narrator_main = next((c.name for c in characters if c.is_main), "")
            log(f"⚠️ LLM returned {main_count} narrator protagonists; kept only the first: {narrator_main}")
        log(f"LLM structured extraction complete: {len(characters)} characters")
    except Exception as e:
        import logging

        logging.error(f"LLM structured extraction failed: {e}")
        log(f"⚠️ LLM structured extraction failed: {e}")
        raise RuntimeError("LLM graph character extraction failed") from e

    report(0.9, "Extraction complete")

    report(1.0, "Done")
    return characters


# ============================================================
# Staged build: enhanced episode planning
# ============================================================


# Legacy-only: reached from build_episodes(), which runs only when
# planning_mode="ai". No current frontend workflow selects that mode.
# Structured-v2 projects must not enter this path.
async def extract_episodes_with_characters(
    text: str,
    target_episodes: int = 10,
    known_characters: Optional[List[str]] = None,
    dataset_name: str = "novel",
    project_name: str = "",
    on_log: Optional[Any] = None,
) -> List[NovelEpisode]:
    """Plan episodes (supports a known character list).

    Differences from extract_episodes_from_text:
    - Accepts a confirmed character list so the characters referenced in episodes stay consistent
    - Injects the character list into the prompt

    Args:
        text: Full novel text
        target_episodes: Target number of episodes
        known_characters: List of confirmed character names
        dataset_name: Dataset name
        project_name: Project name
        on_log: Log callback

    Returns:
        List of planned episodes
    """
    with preserve_st_env():
        from cognee.infrastructure.llm.LLMGateway import LLMGateway
        from cognee.modules.engine.operations.setup import setup

    def log(message: MessageLike):
        # Only print to the console; do not call on_log (log callbacks are managed centrally by store.py)
        print(f"[extract_episodes] {message}")

    await setup()
    log(f"Planning {target_episodes} episodes...")

    character_hint = ""
    if known_characters:
        character_hint = f"""
Confirmed character list:
{', '.join(known_characters)}

⚠️ Important: the character_names field may only be chosen from the list above; do not add new character names.
"""
        log(f"Known characters: {len(known_characters)}")

    system_prompt = f"""You are a professional episode planner. Plan the novel content into {target_episodes} episodes.
{character_hint}
For each episode, generate:
1. number: episode number
2. title: an attractive title
3. chapter_start: the corresponding start chapter (estimate)
4. chapter_end: the corresponding end chapter (estimate)
5. content_summary: content summary (within 50 words)
6. main_conflict: the main conflict
7. cliffhanger: an ending cliffhanger (makes the audience want to watch the next episode)
8. key_events: list of key events (3-5)
9. character_names: characters appearing in this episode (chosen from the confirmed characters)

Rules:
- Every episode must have a clear conflict and cliffhanger
- The plot must be coherent, with setups and payoffs
- Put the climax in the middle-to-late part
- Make sure character names match the confirmed list"""

    log("Calling LLM to plan episodes...")
    result = await LLMGateway.acreate_structured_output(
        text,
        system_prompt,
        EpisodeList,
        **get_newapi_structured_output_litellm_kwargs(),
    )
    log(f"LLM returned {len(result.episodes)} episodes")

    # Validate the episode numbers
    episode_numbers = [ep.number for ep in result.episodes]
    log(f"Episode numbers: {episode_numbers}")

    if len(result.episodes) < target_episodes:
        log(
            f"⚠️ Warning: LLM returned fewer episodes ({len(result.episodes)}) than the target ({target_episodes})"
        )

    # Check whether numbering starts at 1; if not, fix it automatically
    if episode_numbers and min(episode_numbers) != 1:
        log(
            f"⚠️ Warning: episode numbering does not start at 1, smallest number: {min(episode_numbers)}, fixing automatically..."
        )
        result.episodes.sort(key=lambda ep: ep.number)
        for i, ep in enumerate(result.episodes, start=1):
            if ep.number != i:
                log(f"  Fixed episode number: {ep.number} -> {i}")
                ep.number = i

    # Check whether the numbers are contiguous
    sorted_numbers = sorted(episode_numbers)
    expected_numbers = list(range(1, len(result.episodes) + 1))
    if sorted_numbers != expected_numbers:
        log("⚠️ Warning: episode numbers are not contiguous, fixing automatically...")
        result.episodes.sort(key=lambda ep: ep.number)
        for i, ep in enumerate(result.episodes, start=1):
            if ep.number != i:
                log(f"  Fixed episode number: {ep.number} -> {i}")
                ep.number = i

    log(
        f"Episode planning complete: {len(result.episodes)} episodes, numbers: {[ep.number for ep in result.episodes]}"
    )

    return result.episodes


# ============================================================
# Scene extraction Pipeline
# ============================================================


class SceneEnrichment(BaseModel):
    """Scene information supplemented by the LLM."""

    name: str = Field(..., description="Primary scene name")
    aliases: List[str] = Field(default_factory=list, description="Alias list")
    scene_type: str = Field(default="interior", description="interior/exterior/nature")
    environment_prompt: str = Field(
        default="",
        description="Spatial visual description of the scene (describe layout by direction, light source direction, architectural style and material texture, 80-120 words, no people)",
    )
    description: str = Field(default="", description="Narrative description of the scene")


class SceneEnrichmentList(BaseModel):
    """List of supplemental scene information."""

    scenes: List[SceneEnrichment]


class GraphSceneCandidate(BaseModel):
    """Stable physical scene discovered from Cognee graph context."""

    name: str = Field(
        ..., description="Stable physical location name, without time, characters, events or camera words"
    )
    aliases: List[str] = Field(default_factory=list, description="Location aliases that appear in the graph")
    scene_type: str = Field(default="interior", description="interior/exterior/nature")
    evidence_lines: List[str] = Field(
        default_factory=list,
        description="Short sentences in the graph context that support the existence of this location and its fixed environmental features",
    )


class GraphSceneCandidateList(BaseModel):
    """Stable physical scenes extracted from Cognee graph context."""

    scenes: List[GraphSceneCandidate] = Field(default_factory=list)


SCENE_ENVIRONMENT_REQUIRED_HEADINGS = ("Front", "Left", "Right", "Back")


SCENE_ENRICHMENT_SYSTEM_PROMPT = """You are a scene environment design expert.
Based on the provided scene name and screenplay source text, generate a visual environment description of the scene.

Generate:
1. name: use the provided scene name directly (return it unchanged)
2. aliases: empty list
3. scene_type: judge interior/exterior/nature from the scene
4. environment_prompt: you must output a "complete 360 spatial contract" using the fixed headings below, without omitting, renaming or merging any of them:
   Front:
   Left:
   Right:
   Back:
   Lighting:
   Material/Style:
   Forbidden elements:

environment_prompt rules:
- Front/Left/Right/Back must each describe the fixed space in that direction, walls/boundaries, doors/windows/entrances, fixed furnishings or exterior extension.
- Front is the main direction seen by the master image; Back is the direction seen by the reverse image; Left and Right are the spaces at the edges of both that must stitch together continuously.
- If the screenplay does not state a direction explicitly, you must reasonably fill it in based on the scene type and source evidence; never leave it empty and never write "not mentioned".
- Describe the neutral default state; do not treat temporary plot actions, weather or character emotions as the fixed environment.
- No people, no temporary plot props, no camera direction.
- Total length about 150-220 words, exceeding 130 words if needed so all four directions are complete.
5. description: narrative description of the scene (in the output language specified for this request, short, no more than about 30 words)"""


# Every heading the contract may carry, in the order they must appear.
SCENE_ENVIRONMENT_ALL_HEADINGS = (
    "Front", "Left", "Right", "Back", "Lighting", "Material/Style", "Forbidden elements",
)

# A heading may open the text or follow a newline or a sentence break. Models
# routinely emit the whole contract on one line, and rejecting that discards a
# perfectly good description in favour of boilerplate.
_SCENE_HEADING_RE = re.compile(
    r"(?:^|[\n.;])\s*(" + "|".join(re.escape(h) for h in SCENE_ENVIRONMENT_ALL_HEADINGS) + r")\s*:"
)

# The first line of the generated fallback. Distinctive enough to recognise a
# prompt the system wrote when it could not use the model's.
SCENE_FALLBACK_FINGERPRINT_EN = "Use the main entrance, main wall, main fixture, or primary activity area"
SCENE_FALLBACK_FINGERPRINTS = (SCENE_FALLBACK_FINGERPRINT_EN,)


def parse_scene_environment_sections(prompt: str) -> list[tuple[str, str]]:
    """Split a 360 contract into (heading, body) pairs, wherever they sit.

    Returns an empty list when the text is not a contract, so callers can tell
    "no sections" from "sections with empty bodies".
    """
    text = str(prompt or "").strip()
    if not text:
        return []

    matches = list(_SCENE_HEADING_RE.finditer(text))
    if not matches:
        return []

    sections: list[tuple[str, str]] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        body = text[match.end() : end].strip().strip(".;")
        sections.append((match.group(1), body))
    return sections


def _has_required_scene_environment_headings(prompt: str) -> bool:
    """Whether the text is a usable 360 contract.

    Presence alone is not enough: a body that merely mentions "Left:" in passing
    would pass a substring test. The four directions must each open a section,
    appear in order, and actually say something.
    """
    sections = parse_scene_environment_sections(prompt)
    if not sections:
        return False

    seen = [heading for heading, body in sections if body]
    position = 0
    for required in SCENE_ENVIRONMENT_REQUIRED_HEADINGS:
        try:
            position = seen.index(required, position) + 1
        except ValueError:
            return False
    return True


def normalize_scene_environment_prompt(prompt: str) -> str:
    """Rewrite a valid contract as one section per line.

    Downstream readers and human reviewers both expect the sectioned form; the
    model's single-line output carries the same content in a shape that is hard
    to read and easy to mis-parse later.
    """
    sections = parse_scene_environment_sections(prompt)
    if not sections:
        return str(prompt or "").strip()
    return "\n".join(f"{heading}: {body}" for heading, body in sections if body)


def should_repair_scene_placeholder(existing_prompt: str, new_prompt: str) -> bool:
    """Whether a stored environment prompt is boilerplate worth replacing.

    Both tracks wrote the generated fallback for every scene while the contract
    validator rejected valid single-line model output, so both need the same
    narrow repair on rebuild. All three conditions matter:

    * the stored prompt carries the fallback fingerprint, so it is something
      this code wrote, never something a user typed or edited;
    * the replacement does not carry it, so a rebuild that fell back again does
      not churn the row;
    * the replacement is itself a valid 360 contract, so a malformed or empty
      model response can never overwrite a stored prompt with something worse.
    """
    existing = str(existing_prompt or "")
    replacement = str(new_prompt or "")
    if not any(fingerprint in existing for fingerprint in SCENE_FALLBACK_FINGERPRINTS):
        return False
    if any(fingerprint in replacement for fingerprint in SCENE_FALLBACK_FINGERPRINTS):
        return False
    return _has_required_scene_environment_headings(replacement)


def _compact_scene_context(
    lines: list[str] | tuple[str, ...] | str, *, limit: int = 180
) -> str:
    if isinstance(lines, str):
        raw = lines
    else:
        raw = " ".join(str(line).strip() for line in lines if str(line).strip())
    raw = re.sub(r"\s+", " ", raw).strip()
    return raw[:limit].rstrip()


def _ensure_directional_environment_prompt(
    *,
    prompt: str,
    scene_name: str,
    scene_type: str,
    time_of_day: str,
    context_lines: list[str],
    output_language: AssetLanguage = "en",
) -> str:
    """Ensure graph-built scene prompts are usable as a 360 spatial contract."""
    text = str(prompt or "").strip()
    if _has_required_scene_environment_headings(text):
        return normalize_scene_environment_prompt(text)
    # Evidence comes from the script, never from the prompt that just failed
    # validation. Quoting a rejected description back as "source evidence" produced a
    # self-referential contract that cited itself as its own source.
    evidence = _compact_scene_context(context_lines)
    if not evidence:
        evidence = f"{scene_name}, {scene_type or 'interior'} scene"
    type_label = scene_type or "interior"
    return "\n".join(
        [
            f"Front: Use the main entrance, main wall, main fixture, or primary activity area that best identifies \"{scene_name}\" as the front view; use the source evidence \"{evidence}\" to define fixed structures and visual anchors.",
            f"Left: From the front-facing view, extend left into side walls, passages, doors, windows, fixed furnishings, or exterior boundaries appropriate to \"{scene_name}\"; keep materials, scale, and depth continuous with the front and include no people.",
            "Right: From the front-facing view, extend right into the opposing side space, wall corners, corridors, streets, adjoining rooms, or fixed facilities; maintain spatial continuity without duplicating the front subject.",
            "Back: Show the rear half of the location when facing away from the front, such as the reverse side of an entrance, a corridor end, courtyard, rear wall, windows, street continuation, or secondary functional area; close the full 360-degree space consistently.",
            "Lighting: Use stable, neutral environmental lighting from fixed lamps, windows, skylight, or ceiling fixtures; do not bake a temporary story time or mood into the reusable environment.",
            f"Material/Style: Keep the fixed architectural style, surfaces, door and window structure, furnishing materials, and wear level appropriate to an {type_label} scene; describe only the reusable environment and no character actions.",
            "Forbidden elements: No people, temporary story props, subtitles, watermarks, UI, or historical, modern, or science-fiction elements that conflict with the location name and source evidence.",
        ]
    )



def _create_scene_build_agent(system_prompt: str, output_type: Any, name: str):
    """Create the scene-build business LLM agent.

    This intentionally does not use Cognee's LLMGateway: scene construction uses
    Cognee project context, but its two structured LLM calls are business logic,
    not Cognee graph ingest/cognify/memify work.
    """
    from pydantic_ai import Agent
    from novelvideo.config import (
        get_newapi_structured_output_model_settings,
        get_newapi_text_pydantic_model,
    )

    return Agent(
        get_newapi_text_pydantic_model(
            "SCENE_BUILD_MODEL",
            "gemini-3-flash-preview",
            capability="cognee.llm",
        ),
        system_prompt=system_prompt,
        model_settings=get_newapi_structured_output_model_settings(),
        output_type=output_type,
        name=name,
    )


async def enrich_scene_environment_from_context(
    *,
    scene_name: str,
    scene_type: str = "interior",
    time_of_day: str = "",
    interior: bool = True,
    episodes: list[int] | None = None,
    characters: list[str] | None = None,
    context_lines: list[str] | None = None,
    aliases: list[str] | None = None,
    synopsis: str = "",
    enrichment_agent: Any | None = None,
    output_language: AssetLanguage | None = None,
) -> NovelScene:
    """Generate the canonical 360 environment prompt for one scene.

    Used by both project-level scene construction and episode-level scene planning
    so they do not drift into separate prompt contracts.
    """
    scene_name = str(scene_name or "").strip()
    context_lines = [
        str(line) for line in (context_lines or []) if str(line or "").strip()
    ]
    aliases = list(aliases or [])
    characters = list(characters or [])
    episodes = list(episodes or [])
    scene_type = str(
        scene_type or ("interior" if interior else "exterior") or "interior"
    )
    language = output_language or detect_asset_language(
        "\n".join([scene_name, *context_lines, synopsis])
    )

    agent = enrichment_agent or _create_scene_build_agent(
        SCENE_ENRICHMENT_SYSTEM_PROMPT,
        SceneEnrichmentList,
        "Scene Build Enricher",
    )
    context = "\n".join(context_lines[:50])
    synopsis_section = f"\n\n[Story synopsis and character settings]\n{synopsis}" if synopsis else ""
    user_text = f"""{asset_language_instruction(language)}

Scene name: {scene_name}
Time-of-day hint: {time_of_day or "none"} (only for understanding when the scene occurs in the plot; do not bake daytime, night, dusk, moonlight or other time-of-day lighting into the base scene)
Interior/exterior: {"interior" if interior else "exterior"}
Episodes it appears in: {episodes}
Characters present: {", ".join(characters) if characters else "none"}

Source text passages of this scene in the screenplay:
{context}{synopsis_section}"""

    try:
        result = (await agent.run(user_text)).output
        if result.scenes:
            enriched = result.scenes[0]
            resolved_type = enriched.scene_type or scene_type
            return NovelScene(
                name=scene_name,
                aliases=_clean_aliases(scene_name, aliases),
                scene_type=resolved_type,
                environment_prompt=_ensure_directional_environment_prompt(
                    prompt=enriched.environment_prompt,
                    scene_name=scene_name,
                    scene_type=resolved_type,
                    time_of_day="",
                    context_lines=context_lines,
                    output_language=language,
                ),
                description=enriched.description,
            )
    except Exception as exc:
        import logging

        logging.error(f"LLM scene description generation failed ({scene_name}): {exc}")

    return NovelScene(
        name=scene_name,
        aliases=_clean_aliases(scene_name, aliases),
        scene_type=scene_type,
        environment_prompt=_ensure_directional_environment_prompt(
            prompt="",
            scene_name=scene_name,
            scene_type=scene_type,
            time_of_day="",
            context_lines=context_lines,
            output_language=language,
        ),
    )


# Several scenes fit in one enrichment call. Each description runs 150-200
# characters, so a batch stays well inside a useful response length.
class SceneBuildCache(Protocol):
    """What a scene build needs from a store to be resumable.

    A protocol rather than the store itself: this code sits below the store
    layer, and tests drive it with a dict.  ``artifact_type`` is per call
    because a scene build caches several independent stages and none of them
    may read another's rows.
    """

    async def get(
        self, artifact_type: str, cache_keys: list[str]
    ) -> dict[str, str]: ...

    async def save(self, artifact_type: str, results: dict[str, str]) -> None: ...


class StoreAnalysisItemCache:
    """Adapter binding the protocol to a project's SQLite store.

    Nothing about it is scene-specific: ``artifact_type`` is per call, so the
    character build stores its appearance answers in the same table under its
    own type without either stage seeing the other's rows.
    """

    def __init__(self, store: Any) -> None:
        self._store = store

    async def get(self, artifact_type: str, cache_keys: list[str]) -> dict[str, str]:
        return await self._store.get_analysis_item_cache(artifact_type, cache_keys)

    async def save(self, artifact_type: str, results: dict[str, str]) -> None:
        await self._store.save_analysis_item_cache(artifact_type, results)


# The scene build named this adapter first and imports it by that name.
StoreSceneBuildCache = StoreAnalysisItemCache


_ENRICHMENT_BATCH_SIZE = 5

# Bump whenever the enrichment prompt, the contract validator, or the way a
# model answer is turned into a NovelScene changes.  It is part of every cache
# key, so a bump retires every stored result rather than mixing contracts.
SCENE_ENRICHMENT_CACHE_VERSION = 2

SCENE_ENRICHMENT_CACHE_TYPE = "scene_environment"

# Bump alongside the screenplay normalizer or the way its blocks are folded
# into candidates.
SCENE_BLOCKS_CACHE_VERSION = 2

SCENE_BLOCKS_CACHE_TYPE = "scene_blocks"


def scene_enrichment_cache_key(candidate: dict[str, Any], synopsis: str = "") -> str:
    """Hash the exact input one scene's enrichment call is made from.

    Every field the model sees, plus every field used to build the NovelScene
    from its answer, plus the contract version.  Anything left out would let a
    changed input silently reuse a result produced from the old one.

    A scene can be answered by either of two calls — the batch, or the
    per-scene retry it falls through to — and they do not read the same fields.
    The batch sends 24 context lines and no time or episode list; the per-scene
    call sends 50 lines plus both. The key is the *union*, because the result
    is stored under one key whichever call produced it, so a field either call
    reads has to be able to invalidate it. Keying on the batch's inputs alone
    meant a changed time of day, episode list, or context line 25 onwards left
    the key identical and replayed a result built from the old input.

    The cost of the union is an occasional needless rebuild. The cost of the
    intersection is serving a wrong answer, which does not announce itself.
    """
    payload = {
        "v": SCENE_ENRICHMENT_CACHE_VERSION,
        "name": str(candidate.get("name") or ""),
        "aliases": list(candidate.get("aliases") or []),
        "scene_type": str(candidate.get("scene_type") or ""),
        "interior": bool(candidate.get("interior", True)),
        "characters": list(candidate.get("characters") or []),
        "time_of_day": str(candidate.get("time_of_day") or ""),
        "episodes": list(candidate.get("episodes") or []),
        # 50, the larger of the two truncations, for the same reason.
        "context": [
            str(line) for line in (candidate.get("context_lines") or [])[:50]
        ],
        "synopsis": str(synopsis or ""),
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def scene_to_cache_payload(scene: NovelScene) -> str:
    return json.dumps(
        {
            "name": scene.name,
            "aliases": list(scene.aliases or []),
            "scene_type": scene.scene_type,
            "environment_prompt": scene.environment_prompt,
            "description": scene.description,
        },
        ensure_ascii=False,
    )


def is_cacheable_scene_prompt(prompt: str) -> bool:
    """Whether a produced prompt is a real answer worth keeping.

    Two conditions, and the second is the one that is easy to miss: the
    generated fallback satisfies the 360 contract by construction, so a
    validity check alone would freeze boilerplate in as the permanent answer
    and every later rebuild would replay it instead of retrying the model.
    """
    text = str(prompt or "")
    if any(fingerprint in text for fingerprint in SCENE_FALLBACK_FINGERPRINTS):
        return False
    return _has_required_scene_environment_headings(text)


def scene_from_cache_payload(payload: str) -> NovelScene | None:
    """Rebuild a scene from a stored payload, or None if it is unusable.

    A stored row that no longer parses, or that carries a prompt the current
    contract rejects, is treated as a miss rather than trusted: a cache must
    never be able to publish something the live path would have rejected.
    """
    try:
        data = json.loads(payload)
    except (TypeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    prompt = str(data.get("environment_prompt") or "")
    if not is_cacheable_scene_prompt(prompt):
        return None
    return NovelScene(
        name=str(data.get("name") or ""),
        aliases=list(data.get("aliases") or []),
        scene_type=str(data.get("scene_type") or ""),
        environment_prompt=prompt,
        description=str(data.get("description") or ""),
    )


async def enrich_scene_environments_batched(
    candidates: list[dict[str, Any]],
    *,
    synopsis: str = "",
    enrichment_agent: Any | None = None,
    on_scene: Optional[Any] = None,
    cache: Optional[SceneBuildCache] = None,
    output_language: AssetLanguage | None = None,
) -> list[NovelScene]:
    """Generate environment prompts for several scenes per request.

    The enrichment agent already returns a list, but was being asked for one
    scene at a time. A screenplay yields dozens of base scenes, and each call
    costs the same few seconds of round trip regardless of how many it carries.

    A batch that fails or comes back short falls through to per-scene calls for
    exactly the scenes it missed, so batching can only cost time, never scenes.

    With a ``cache``, scenes whose input already produced a real answer are
    served from it and never sent to the model.  That is what makes an
    interrupted build resumable: each scene is an independent call, and the ones
    that finished stay finished.
    """
    if not candidates:
        return []
    language = output_language or detect_asset_language(
        "\n".join(
            [
                synopsis,
                *(
                    str(value)
                    for candidate in candidates
                    for value in [
                        candidate.get("name") or "",
                        *(candidate.get("context_lines") or []),
                    ]
                ),
            ]
        )
    )

    keys = {
        id(candidate): scene_enrichment_cache_key(candidate, synopsis)
        for candidate in candidates
    }
    hits: dict[int, NovelScene] = {}
    if cache is not None:
        stored = await cache.get(SCENE_ENRICHMENT_CACHE_TYPE, list(keys.values()))
        for candidate in candidates:
            payload = stored.get(keys[id(candidate)])
            scene = scene_from_cache_payload(payload) if payload else None
            if scene is not None:
                hits[id(candidate)] = scene

    pending = [candidate for candidate in candidates if id(candidate) not in hits]
    if hits and on_scene:
        # Reported before any model call, so a resumed build shows the work it
        # is skipping instead of appearing to stall at zero.
        for candidate in candidates:
            scene = hits.get(id(candidate))
            if scene is not None:
                on_scene(candidate, scene)

    agent = enrichment_agent or _create_scene_build_agent(
        SCENE_ENRICHMENT_SYSTEM_PROMPT,
        SceneEnrichmentList,
        "Scene Build Enricher",
    )
    synopsis_section = f"\n\n[Story synopsis and character settings]\n{synopsis}" if synopsis else ""

    def describe(candidate: dict[str, Any]) -> str:
        context = "\n".join(
            str(line) for line in (candidate.get("context_lines") or [])[:24]
        )
        interior = bool(candidate.get("interior", True))
        return (
            f"### Scene: {candidate['name']}\n"
            f"Interior/exterior: {'interior' if interior else 'exterior'}\n"
            f"Characters present: {', '.join(candidate.get('characters') or []) or 'none'}\n"
            f"Source passages:\n{context}"
        )

    async def run_batch(batch: list[dict[str, Any]]) -> list[NovelScene]:
        prompt = (
            asset_language_instruction(language)
            + "\n\nGenerate an environment_prompt for each of the scenes below separately; "
            "name must exactly match the given scene name; do not merge or omit any scene:\n\n"
            + "\n\n".join(describe(candidate) for candidate in batch)
            + synopsis_section
        )
        produced: dict[str, NovelScene] = {}
        try:
            result = (await agent.run(prompt)).output
            by_name = {
                str(item.name or "").strip(): item for item in (result.scenes or [])
            }
            for candidate in batch:
                item = by_name.get(candidate["name"])
                if item is None:
                    continue
                scene_type = item.scene_type or candidate.get("scene_type") or (
                    "interior" if candidate.get("interior", True) else "exterior"
                )
                produced[candidate["name"]] = NovelScene(
                    name=candidate["name"],
                    aliases=_clean_aliases(
                        candidate["name"], candidate.get("aliases") or []
                    ),
                    scene_type=scene_type,
                    environment_prompt=_ensure_directional_environment_prompt(
                        prompt=item.environment_prompt,
                        scene_name=candidate["name"],
                        scene_type=scene_type,
                        time_of_day="",
                        context_lines=list(candidate.get("context_lines") or []),
                        output_language=language,
                    ),
                    description=item.description,
                )
        except Exception as exc:  # noqa: BLE001 - falls back per scene below
            import logging

            logging.warning("Batch scene description generation failed, retrying one by one: %s", exc)

        answered: list[tuple[dict[str, Any], NovelScene]] = []
        for candidate in batch:
            scene = produced.get(candidate["name"])
            if scene is None:
                scene = await enrich_scene_environment_from_context(
                    scene_name=candidate["name"],
                    aliases=candidate.get("aliases") or [],
                    scene_type=candidate.get("scene_type") or "",
                    time_of_day=candidate.get("time_of_day") or "",
                    interior=bool(candidate.get("interior", True)),
                    episodes=candidate.get("episodes") or [],
                    characters=candidate.get("characters") or [],
                    context_lines=candidate.get("context_lines") or [],
                    synopsis=synopsis,
                    enrichment_agent=agent,
                    output_language=language,
                )
            if not str(scene.environment_prompt or "").strip():
                continue
            if on_scene:
                on_scene(candidate, scene)
            answered.append((candidate, scene))
        if cache is not None and answered:
            # Written per batch, not once at the end: a build killed halfway
            # must keep everything it already paid for.  Only real answers are
            # stored — a generated fallback would otherwise become permanent.
            await cache.save(
                SCENE_ENRICHMENT_CACHE_TYPE,
                {
                    keys[id(candidate)]: scene_to_cache_payload(scene)
                    for candidate, scene in answered
                    if is_cacheable_scene_prompt(scene.environment_prompt)
                },
            )
        return [scene for _, scene in answered]

    batches = [
        pending[start : start + _ENRICHMENT_BATCH_SIZE]
        for start in range(0, len(pending), _ENRICHMENT_BATCH_SIZE)
    ]
    results = await map_bounded(batches, run_batch, limit=default_llm_concurrency())
    fresh = {scene.name: scene for batch in results if batch for scene in batch}

    # Rebuilt in the caller's original order, so a resumed build publishes the
    # same catalogue in the same order as a fresh one.
    ordered: list[NovelScene] = []
    for candidate in candidates:
        scene = hits.get(id(candidate)) or fresh.get(candidate["name"])
        if scene is not None:
            ordered.append(scene)
    return ordered


_DEFAULT_ENRICH_SCENE_ENVIRONMENT_FROM_CONTEXT = enrich_scene_environment_from_context


def _scene_candidates_from_normalized_blocks(
    blocks: list[NormalizedSceneBlock],
) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for block in blocks:
        scene_name = str(block.location or "").strip()
        if not scene_name:
            continue
        existing = merged.get(scene_name)
        episode = _episode_number_from_normalized_block(block)
        normalized_time = normalize_time_of_day(block.time_of_day)
        if not existing:
            merged[scene_name] = {
                "name": scene_name,
                "aliases": _clean_aliases(scene_name, block.aliases),
                "scene_type": block.scene_type or "interior",
                "time_of_day": normalized_time,
                "time_counts": {normalized_time: 1} if normalized_time else {},
                "interior": block.interior_exterior != "ext",
                "episodes": [episode],
                "characters": list(dict.fromkeys(block.characters)),
                "context_lines": list(block.content_lines or block.evidence_lines),
            }
            continue
        if episode not in existing["episodes"]:
            existing["episodes"].append(episode)
        existing["episodes"] = sorted(existing["episodes"])
        existing["aliases"] = _clean_aliases(
            scene_name,
            list(existing["aliases"]) + list(block.aliases),
        )
        existing["characters"] = list(
            dict.fromkeys(list(existing["characters"]) + list(block.characters))
        )
        existing["context_lines"].extend(block.content_lines or block.evidence_lines)
        if normalized_time:
            existing["time_counts"][normalized_time] = (
                existing["time_counts"].get(
                    normalized_time,
                    0,
                )
                + 1
            )
        if not existing["time_of_day"] and normalized_time:
            existing["time_of_day"] = normalized_time
    return list(merged.values())


def _format_observed_times_note(time_counts: dict[str, int] | None) -> str:
    counts = {
        str(key or "").strip(): int(value or 0)
        for key, value in (time_counts or {}).items()
        if str(key or "").strip() and int(value or 0) > 0
    }
    if not counts:
        return ""
    parts = [f"{time}×{counts[time]}" for time in sorted(counts)]
    return "observed_times: " + " / ".join(parts)


def _append_scene_note(existing: str, note: str) -> str:
    existing = str(existing or "").strip()
    note = str(note or "").strip()
    if not note:
        return existing
    if not existing:
        return note
    if note in existing:
        return existing
    return f"{existing}\n{note}"


def _episode_number_from_normalized_block(block: NormalizedSceneBlock) -> int:
    try:
        episode = int(block.episode_number or 0)
    except (TypeError, ValueError):
        episode = 0
    if episode > 0:
        return episode

    raw_header = str(block.raw_header or "").strip()
    header_match = re.match(r"^\s*(?P<episode>\d+)\s*[-—]", raw_header)
    if header_match:
        return int(header_match.group("episode"))
    return 1


async def extract_scenes_from_graph(
    dataset_name: str = "novel",
    project_name: str = "",
    project_dir: Optional[str] = None,
    state_dir: Optional[str] = None,
    on_progress: Optional[Any] = None,
    on_log: Optional[Any] = None,
) -> List[NovelScene]:
    """Discover reusable base scenes from Cognee graph context.

    Project-level scene discovery must mirror character/prop discovery. Script
    normalization belongs to per-episode drama planning, not this graph path.
    """
    with preserve_st_env():
        import cognee
        from cognee.api.v1.search import SearchType
        from cognee.infrastructure.llm.LLMGateway import LLMGateway

    def report(progress: float, task: MessageLike) -> None:
        if on_progress:
            on_progress(progress, task)

    def log(message: MessageLike) -> None:
        print(f"[extract_scenes] {message}")
        if on_log:
            on_log(message)

    report(0.1, "Retrieving scene information through the graph...")
    context_text = ""
    try:
        results = await _run_graph_read(
            state_dir,
            lambda: cognee.search(
                query_text=(
                    "List the stable physical locations that recur in the work or matter to the plot, including location aliases, "
                    "spatial environment, architectural structure and the relationships between locations; do not list characters, events, emotions or abstract concepts"
                ),
                query_type=SearchType.GRAPH_COMPLETION,
                datasets=[dataset_name],
                only_context=True,
                top_k=50,
            ),
        )
        if results:
            context_text = "\n".join(
                _stringify_search_fragment(
                    item.search_result if hasattr(item, "search_result") else item
                )
                for item in results
            )
            log(f"Graph scene context retrieved: {len(context_text)} chars")
    except Exception as exc:
        import logging

        logging.warning("cognee scene search failed: %s", exc)
        log(f"Graph scene search failed: {exc}")
        raise RuntimeError("Cognee graph scene search failed") from exc

    if not context_text.strip():
        log("⚠️ Graph search returned no scene data; finish building the knowledge graph first")
        return []

    report(0.3, "Extracting base scenes from the graph with structured output...")
    system_prompt = """You are a global scene asset analyst for a film and TV project.
The input is context retrieved from the knowledge graph. Extract only stable physical locations that can be reused across shots.

Rules:
- name must be a specific physical location, e.g. "Bodhi Bedchamber" or "Front Courtyard of the Duke's Mansion", never a generic term such as "home", "the scene" or "flashback".
- Merge aliases of the same location; do not split different times, weather or damage states into new base scenes.
- Exclude characters, organizations, events, actions, emotions, chapter titles and abstract concepts.
- scene_type must be one of interior, exterior, nature.
- evidence_lines must come from the input graph context and must not be fabricated.
- When graph evidence is insufficient, prefer omission over guessing locations."""
    try:
        result = await LLMGateway.acreate_structured_output(
            context_text,
            system_prompt,
            GraphSceneCandidateList,
            **get_newapi_structured_output_litellm_kwargs(),
        )
    except Exception as exc:
        import logging

        logging.error("LLM graph scene extraction failed: %s", exc)
        log(f"LLM graph scene extraction failed: {exc}")
        raise RuntimeError("LLM graph scene extraction failed") from exc

    candidates: list[GraphSceneCandidate] = []
    seen: set[str] = set()
    generic_names = {"scene", "location", "interior", "exterior", "indoors", "outdoors", "on site", "home", "flashback", "cảnh", "địa điểm", "nhà", "hồi tưởng"}
    for candidate in result.scenes:
        name = str(candidate.name or "").strip()
        if not name or name in seen or name.lower() in generic_names:
            continue
        aliases = _clean_aliases(name, candidate.aliases)
        evidence_lines = [
            str(line or "").strip()
            for line in candidate.evidence_lines
            if str(line or "").strip() and str(line or "").strip() in context_text
        ]
        if not evidence_lines:
            location_tokens = [name, *aliases]
            evidence_lines = [
                line.strip()
                for line in context_text.splitlines()
                if line.strip()
                and any(token and token in line for token in location_tokens)
            ][:8]
        if not evidence_lines:
            log(f"  Skipping scene candidate without graph evidence: {name}")
            continue
        candidate.aliases = aliases
        candidate.evidence_lines = evidence_lines
        seen.add(name)
        candidates.append(candidate)

    if not candidates:
        log("⚠️ No stable physical scenes were extracted from the graph context")
        return []

    report(0.5, "Generating scene environment descriptions...")
    enrichment_agent = _create_scene_build_agent(
        SCENE_ENRICHMENT_SYSTEM_PROMPT,
        SceneEnrichmentList,
        "Scene Build Enricher",
    )
    scenes: list[NovelScene] = []
    total = len(candidates)
    for index, candidate in enumerate(candidates, start=1):
        report(
            0.5 + 0.45 * ((index - 1) / max(total, 1)),
            f"Generating scene description ({index}/{total}): {candidate.name}",
        )
        scene_type = str(candidate.scene_type or "interior").strip().lower()
        if scene_type not in {"interior", "exterior", "nature"}:
            scene_type = "interior"
        scene = await enrich_scene_environment_from_context(
            scene_name=candidate.name,
            aliases=candidate.aliases,
            scene_type=scene_type,
            interior=scene_type == "interior",
            context_lines=list(candidate.evidence_lines),
            enrichment_agent=enrichment_agent,
        )
        scene.notes = _append_scene_note(scene.notes, "Base scene extracted from the Cognee graph")
        scenes.append(scene)
        log(f"  ✓ {scene.name}")

    report(1.0, "Done")
    log(f"Graph scene extraction complete: {len(scenes)} scenes")
    return scenes


async def _normalized_scene_blocks_cached(
    novel_text: str, cache: Optional[SceneBuildCache]
) -> list[dict[str, Any]]:
    """Run the screenplay normalizer once per source text, then reuse it.

    The normalizer is a model call and its answer varies between runs. Left
    uncached it does not just cost its own few seconds again — it reshuffles the
    candidates, which changes every downstream cache key, so a rebuild would
    re-pay for every scene description too. Keyed on the source text, so an
    unchanged script always yields the same candidates.
    """
    key = hashlib.sha256(
        json.dumps(
            {"v": SCENE_BLOCKS_CACHE_VERSION, "source": novel_text},
            ensure_ascii=False,
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()

    if cache is not None:
        stored = (await cache.get(SCENE_BLOCKS_CACHE_TYPE, [key])).get(key)
        if stored:
            try:
                restored = json.loads(stored)
            except (TypeError, ValueError):
                restored = None
            if isinstance(restored, list) and restored:
                return restored

    blocks = await normalize_screenplay_scenes(novel_text)
    candidates = _scene_candidates_from_normalized_blocks(blocks)
    if cache is not None and candidates:
        await cache.save(
            SCENE_BLOCKS_CACHE_TYPE,
            {key: json.dumps(candidates, ensure_ascii=False)},
        )
    return candidates


def strip_scene_heading_suffix(name: str) -> str:
    """Drop the heading markers the parser left on a location name.

    "Zheng's Office INT" is the same room as "Zheng's Office": the INT is the heading's
    interior marker, which the parser also returns as its own field. Removing it
    is the whole of what a per-block model call used to buy here.

    The rules already exist — ``clean_scene_name_and_time`` handles the attached,
    separated and spaced forms and refuses to strip when the result would not be
    a name any more — so this only discards the time it also returns.
    """
    cleaned, _time_of_day = clean_scene_name_and_time(str(name or "").strip(), "")
    return cleaned or str(name or "").strip()


def _candidate_from_parsed_block(candidate: Any) -> dict[str, Any]:
    """Turn one parser-located block into a candidate, without a model call.

    A standard scene heading already states the location, the time and whether
    it is interior — the parser reads all three. Asking a model to restate them
    was one round trip per block, run one at a time, and on a feature-length
    screenplay the single largest cost in the whole build. Measured against the
    model path on a real 33k-char script it produces the same catalogue: 25
    scenes either way, 24 of them identical, and the one difference is which
    spelling of a merged pair wins.

    Deciding that two spellings are one room is the part worth a model, and
    ``adjudicate_scenes`` already does it downstream — with every candidate in
    view at once and occurrence counts to choose the canonical spelling, which
    a per-block call looking at one heading in isolation cannot have.
    """
    name = strip_scene_heading_suffix(candidate.name)
    normalized_time = normalize_time_of_day(candidate.time_of_day)
    return {
        "name": name,
        "aliases": _clean_aliases(name, [candidate.name]),
        "scene_type": "interior" if candidate.interior else "exterior",
        "time_of_day": normalized_time,
        "time_counts": {normalized_time: 1} if normalized_time else {},
        "interior": candidate.interior,
        "episodes": list(candidate.episodes),
        "characters": list(candidate.characters),
        "context_lines": list(candidate.context_lines),
    }


def _scene_recall_is_covered(
    normalized: list[dict[str, Any]], parsed: list[Any]
) -> tuple[bool, str]:
    """Whether the normalizer accounted for every location the parser found.

    The old test compared distinct-location *counts* and rejected the result
    whenever the normalizer returned fewer. But folding two spellings of one
    room into a single scene is the normalizer working correctly, and it always
    lowers the count — so a correct merge was punished as lost recall, and the
    whole result was thrown away for a per-block model loop that cost minutes.

    What actually matters is that nothing was dropped: every location the parser
    located must still be reachable, as a name, an alias, or the same name with
    its heading markers stripped.

    The test stays strict — an attached "INT" is genuinely ambiguous ("Van INT"
    is a place, "Zheng's Office INT" is a marker) so a merge across one is not
    recognised here and does send the build down the fallback. That is now
    affordable: the fallback is deterministic and costs no model call, and
    adjudication performs the same merge downstream with occurrence counts to
    decide it on.
    """
    known: set[str] = set()
    for candidate in normalized:
        for value in [candidate.get("name"), *(candidate.get("aliases") or [])]:
            text = str(value or "").strip()
            if text:
                known.add(text)
                known.add(strip_scene_heading_suffix(text))

    missing = [
        candidate.name
        for candidate in parsed
        if candidate.name not in known
        and strip_scene_heading_suffix(candidate.name) not in known
    ]
    if missing:
        return False, f"AI normalizer missed {len(missing)} locations: {missing[:5]}"
    return True, ""


async def extract_scenes_from_script(
    novel_text: str,
    on_progress: Optional[Any] = None,
    on_log: Optional[Any] = None,
    cache: Optional[SceneBuildCache] = None,
) -> List[NovelScene]:
    """Extract scenes from a formatted screenplay (AI normalizer first + parser fallback + LLM enrichment).

    Flow:
    1. The program parser locates scene blocks with high recall, as a recall sanity check for the AI normalizer
    2. Prefer the NormalizedSceneBlock output of the AI normalizer
    3. When the AI raises, returns empty, or yields fewer base scenes than the parser, fall back to parser + LLM normalization
    4. The LLM generates environment_prompt scene by scene
    """
    from .script_parser import parse_scenes, extract_synopsis

    def report(progress: float, task: MessageLike):
        if on_progress:
            on_progress(progress, task)

    def log(message: MessageLike):
        print(f"[extract_scenes] {message}")

    synopsis = extract_synopsis(novel_text)
    output_language = detect_asset_language(novel_text)
    if synopsis:
        log(f"Extracted synopsis + character settings: {len(synopsis)} chars")

    legacy_candidates = parse_scenes(novel_text)
    log(
        lmsg(
            "tasks.log.pipeline.legacyRecall",
            "Program recall sanity check found "
            f"{len(legacy_candidates)} scene blocks: {[c.name for c in legacy_candidates]}",
            sceneCount=len(legacy_candidates),
            sceneNames=str([c.name for c in legacy_candidates]),
        )
    )

    normalized_scene_candidates: list[dict[str, Any]] = []
    fallback_reason = ""

    report(
        0.1,
        lmsg("tasks.progress.pipeline.normalizingScenes", "AI normalizing screenplay scene blocks..."),
    )
    try:
        normalized_scene_candidates = await _normalized_scene_blocks_cached(
            novel_text, cache
        )
        covered, gap = _scene_recall_is_covered(
            normalized_scene_candidates, legacy_candidates
        )
        if not covered:
            fallback_reason = gap
            normalized_scene_candidates = []
        if normalized_scene_candidates:
            log(
                "AI normalization produced "
                f"{len(normalized_scene_candidates)} base scenes: "
                f"{[c['name'] for c in normalized_scene_candidates]}"
            )
        elif not fallback_reason:
            fallback_reason = "AI normalizer returned empty"
    except Exception as e:
        import logging

        logging.error(f"AI scene normalization failed: {e}")
        fallback_reason = f"AI normalizer failed ({e})"

    if not normalized_scene_candidates:
        if fallback_reason:
            log(f"⚠️ {fallback_reason}, falling back to program location + local normalization")

        report(0.15, "Locating screenplay scene blocks...")
        candidates = legacy_candidates
        log(f"Program location found {len(candidates)} scene blocks: {[c.name for c in candidates]}")

        if not candidates:
            log("⚠️ No scenes could be parsed from the screenplay")
            return []

        # Deterministic, and no model call: a standard heading already states
        # everything a candidate needs, and the name cleanup a model used to do
        # here is a suffix strip. What is left — deciding that two spellings are
        # one room — belongs to adjudication, which sees all of them at once.
        normalized_candidates = [
            _candidate_from_parsed_block(candidate) for candidate in candidates
        ]

        merged_candidates: dict[str, dict[str, Any]] = {}
        for cand in normalized_candidates:
            scene_name = (cand["name"] or "").strip()
            if not scene_name:
                continue
            existing = merged_candidates.get(scene_name)
            if not existing:
                merged_candidates[scene_name] = {
                    "name": scene_name,
                    "aliases": list(dict.fromkeys(cand["aliases"])),
                    "scene_type": cand["scene_type"],
                    "time_of_day": cand["time_of_day"],
                    "time_counts": dict(cand.get("time_counts") or {}),
                    "interior": cand["interior"],
                    "episodes": list(cand["episodes"]),
                    "characters": list(dict.fromkeys(cand["characters"])),
                    "context_lines": list(cand["context_lines"]),
                }
                continue
            existing["aliases"] = list(
                dict.fromkeys(existing["aliases"] + cand["aliases"])
            )
            existing["episodes"] = sorted(set(existing["episodes"] + cand["episodes"]))
            existing["characters"] = list(
                dict.fromkeys(existing["characters"] + cand["characters"])
            )
            existing["context_lines"].extend(cand["context_lines"])
            for time_key, count in (cand.get("time_counts") or {}).items():
                time_key = str(time_key or "").strip()
                if not time_key:
                    continue
                existing["time_counts"][time_key] = existing["time_counts"].get(
                    time_key,
                    0,
                ) + int(count or 0)
            if not existing["time_of_day"] and cand["time_of_day"]:
                existing["time_of_day"] = cand["time_of_day"]

        normalized_scene_candidates = list(merged_candidates.values())
        log(
            "Normalization produced "
            f"{len(normalized_scene_candidates)} base scenes: "
            f"{[c['name'] for c in normalized_scene_candidates]}"
        )

    # Step 3: LLM generates environment_prompt scene by scene
    report(0.5, "LLM generating scene environment descriptions...")
    scenes: List[NovelScene] = []
    total = len(normalized_scene_candidates)
    if not normalized_scene_candidates:
        log("⚠️ No scenes left after scene normalization")
        return []

    enrichment_is_default = (
        enrich_scene_environment_from_context
        is _DEFAULT_ENRICH_SCENE_ENVIRONMENT_FROM_CONTEXT
    )
    enrichment_agent = None
    if enrichment_is_default:
        enrichment_agent = _create_scene_build_agent(
            SCENE_ENRICHMENT_SYSTEM_PROMPT,
            SceneEnrichmentList,
            "Scene Build Enricher",
        )

    # Each candidate's enrichment is an independent round trip. A feature-length
    # screenplay carries well over a hundred scenes, so running them one at a
    # time makes the build minutes of pure latency.
    completed = 0

    def note_progress(cand: dict, scene) -> None:
        nonlocal completed
        scene.time_of_day = ""
        scene.notes = _append_scene_note(
            scene.notes,
            _format_observed_times_note(cand.get("time_counts")),
        )
        completed += 1
        report(
            0.5 + 0.4 * (completed / max(total, 1)),
            f"Generating scene description ({completed}/{total}): {cand['name']}",
        )
        log(f"  ✓ {cand['name']}: environment_prompt={len(scene.environment_prompt)} chars")

    if enrichment_is_default:
        scenes.extend(
            await enrich_scene_environments_batched(
                normalized_scene_candidates,
                synopsis=synopsis,
                enrichment_agent=enrichment_agent,
                cache=cache,
                on_scene=note_progress,
                output_language=output_language,
            )
        )
    else:
        # Preserve the long-standing injection seam used by embedders and unit
        # tests. The batching implementation owns the default model path, but a
        # replaced enrichment callable must remain authoritative.
        for candidate in normalized_scene_candidates:
            scene = await enrich_scene_environment_from_context(
                scene_name=candidate["name"],
                aliases=candidate.get("aliases") or [],
                scene_type=candidate.get("scene_type") or "",
                time_of_day=candidate.get("time_of_day") or "",
                interior=bool(candidate.get("interior", True)),
                episodes=candidate.get("episodes") or [],
                characters=candidate.get("characters") or [],
                context_lines=candidate.get("context_lines") or [],
                synopsis=synopsis,
            )
            note_progress(candidate, scene)
            scenes.append(scene)

    log(f"Scene extraction complete: {len(scenes)} scenes")
    report(1.0, "Done")
    return scenes


# ============================================================
# Prop extraction Pipeline
# ============================================================


class PropEnrichment(BaseModel):
    """Prop information supplemented by the LLM."""

    name: str = Field(..., description="Primary prop name")
    aliases: List[str] = Field(
        default_factory=list, description="Aliases/short names/natural forms of address that actually appear in the source text"
    )
    prop_type: str = Field(
        default="object", description="weapon/accessory/artifact/document/furniture"
    )
    visual_prompt: str = Field(
        default="",
        description="Visual description of the prop's inherent appearance (material, craftsmanship, size, color, ornamentation, 50-80 words, without people or temporary state changes)",
    )
    owner: str = Field(default="", description="Name of the owning character")


class PropEnrichmentList(BaseModel):
    """List of supplemental prop information."""

    props: List[PropEnrichment]


async def extract_props_from_graph(
    dataset_name: str = "novel",
    project_name: str = "",
    project_dir: Optional[str] = None,
    state_dir: Optional[str] = None,
    novel_text: Optional[str] = None,
    on_progress: Optional[Any] = None,
    on_log: Optional[Any] = None,
) -> List[NovelProp]:
    """Extract props from the cognee graph.

    Only props with plot significance (tokens, weapons, etc. that drive the plot) are extracted, not ordinary objects.
    """
    with preserve_st_env():
        import cognee
        from cognee.api.v1.search import SearchType
        from cognee.infrastructure.llm.LLMGateway import LLMGateway

    def report(progress: float, task: MessageLike):
        if on_progress:
            on_progress(progress, task)

    def log(message: MessageLike):
        print(f"[extract_props] {message}")

    report(0.1, "Retrieving prop information through the graph...")

    context_text = ""
    try:
        results = await _run_graph_read(
            state_dir,
            lambda: cognee.search(
                query_text="List all important props and objects in the novel, including weapons, tokens, documents, magic artifacts and other items with plot significance",
                query_type=SearchType.GRAPH_COMPLETION,
                datasets=[dataset_name],
                only_context=True,
                top_k=30,
            ),
        )
        if results:
            parts = []
            for item in results:
                if hasattr(item, "search_result"):
                    parts.append(_stringify_search_fragment(item.search_result))
                elif isinstance(item, dict):
                    parts.append(_stringify_search_fragment(item))
                else:
                    parts.append(_stringify_search_fragment(item))
            context_text = "\n".join(parts)
            log(f"Graph context retrieved: {len(context_text)} chars")
    except Exception as e:
        import logging

        logging.warning(f"cognee.search failed: {e}")
        raise RuntimeError("Cognee graph prop search failed") from e

    if not context_text.strip():
        log("⚠️ Graph search returned no data; build the graph first")
        return []

    if novel_text:
        context_text += f"\n\n[Full original screenplay text]\n{novel_text}"
        log(f"Injected the full original text as auxiliary context: {len(novel_text)} chars")

    report(0.3, "Extracting props with LLM structured output...")

    system_prompt = """You are a novel prop analysis expert. Below is the item information extracted from the knowledge graph.
Based on the graph context, extract all props/objects with plot significance; if the full original text is provided it may be used to supplement natural names and short names, but do not add details that appear in neither the graph nor the original text.

⚠️ Extract only important items that drive the plot (tokens, weapons, magic artifacts, documents, etc.), not ordinary daily items.

For each prop, generate:
1. name: primary prop name (e.g. 'Seven-Star Sword', 'Imperial Jade Seal')
2. aliases: other names, short names or natural forms of address that actually appear in the source text
3. prop_type: weapon/accessory/artifact/document/furniture
4. visual_prompt: visual description of the prop's inherent appearance, 50-80 words, requirements:
      - Include details such as **material, craftsmanship, size, color and ornamentation**
      - Describe the **inherent appearance** (a broken blade is broken, a rusty sword is rusty)
      - **Do not include** people, usage scenes or temporary state changes (such as blood stains or being on fire)
      - Organize it from the graph description; do not invent details
      Example: "A three-chi blue-steel longsword, its blade forged from cold iron with a cold blue sheen and seven star patterns engraved along the spine. The hilt is wrapped in dark brown shark skin, ending in a round white-jade pommel. Fitted with a rosewood scabbard carved in relief with cloud patterns and gilded at the mouth"
5. owner: name of the owning character (if any)

Rules:
- Extract only props with a clear plot function
- Organize visual_prompt from the graph description; do not invent details
- Merge different names for the same item (aliases)
- The graph is the main basis; the full original text is only supplementary evidence, used mainly to complete aliases and confirm that the prop really recurs in the original text
- aliases should prefer natural names or short names that actually appear in the source text, e.g. when the formal name is long, add the short name that recurs in the body text
- Do not invent aliases; do not add words that are too generic and easily match other objects
- Do not put overly short, generic or highly colliding category words into aliases, e.g. "box / case / sword / knife / document / car" should not be included by default, unless the graph context clearly shows that the source text stably refers to that specific prop that way
- If an alias is merely a repeated spelling of the primary name, do not output it again"""

    try:
        result = await LLMGateway.acreate_structured_output(
            context_text,
            system_prompt,
            PropEnrichmentList,
            **get_newapi_structured_output_litellm_kwargs(),
        )
        props = [
            NovelProp(
                name=p.name,
                aliases=_clean_aliases(p.name, p.aliases or []),
                prop_type=p.prop_type,
                visual_prompt=p.visual_prompt,
                owner=p.owner,
            )
            for p in result.props
        ]
        log(f"LLM structured extraction complete: {len(props)} props")
    except Exception as e:
        import logging

        logging.error(f"LLM prop extraction failed: {e}")
        raise RuntimeError("LLM graph prop extraction failed") from e

    report(1.0, "Done")
    return props
