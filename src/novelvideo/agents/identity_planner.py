"""Identity Planner — plan character identities for all episodes in batch.

Runs once in the episode workbench; analyzes each episode and persists the character identities.

Current per-episode flow:
1. Pre-screen the characters appearing in this episode
2. Pass A: analyze each character's default identity on the real-world main storyline
3. Pass B: analyze the other, non-default identities
4. resolve / create, then write back episode.identity_ids + episode.identity_default_map
"""

import re
from typing import Optional, Callable, TYPE_CHECKING

from pydantic import BaseModel, Field, ValidationInfo, field_validator, model_validator

from pydantic_ai import Agent
from novelvideo.brainclaw_contract import BrainClawProfile
from novelvideo.config import (
    get_newapi_structured_output_model_settings,
    get_newapi_text_pydantic_model,
)
from novelvideo.models import CharacterIdentity
from novelvideo.shared.env_guard import preserve_st_env
from novelvideo.cognee.ladybug_access import ladybug_graph_access
from novelvideo.knowledge_pipeline import is_structured_pipeline
from novelvideo.sqlite_store import load_episode_planning_content
from novelvideo.utils.source_language import (
    AssetLanguage,
    asset_language_instruction,
    detect_asset_language,
)

if TYPE_CHECKING:
    from novelvideo.cognee import CogneeStore
    from novelvideo.models import NovelEpisode

# =============================================================================
# Output Schema (AI structured output)
# =============================================================================


_AGE_GROUP_ALIASES = {
    "kid": "child",
    "toddler": "child",
    "infant": "child",
    "childhood": "child",
    "teen": "youth",
    "teenage": "youth",
    "teenager": "youth",
    "adolescent": "youth",
    "young_adult": "youth",
    "young": "youth",
    "adult": "youth",
    "middle_aged": "middle",
    "midlife": "middle",
    "elderly": "elder",
    "old": "elder",
    "senior": "elder",
    "old_age": "elder",
}


def _normalize_age_group_value(v: str) -> str:
    if not v:
        return ""
    v = re.sub(r"[\s\-]+", "_", v.strip().lower())
    if v in ("child", "youth", "middle", "elder"):
        return v
    return _AGE_GROUP_ALIASES.get(v, "")


def _merge_age_group_values(existing: str, incoming: str) -> str:
    existing_norm = _normalize_age_group_value(existing)
    incoming_norm = _normalize_age_group_value(incoming)
    if existing_norm and incoming_norm and existing_norm != incoming_norm:
        raise ValueError(
            f"Conflicting age_group: {existing_norm!r} vs {incoming_norm!r}"
        )
    return existing_norm or incoming_norm


class IdentityRequirement(BaseModel):
    """A single identity requirement produced by the AI analysis."""

    character_name: str = Field(description="Character name (use the primary name)")
    visual_state: str = Field(
        description="Short English slug for the story period or look branch, e.g. 'warlord_era', 'empress_court_dress', 'empress_casual', 'young_lady'"
    )
    age_group: str = Field(
        default="",
        description="Age group of this identity, one of: child/youth/middle/elder. Required for age variants; leave an empty string for ordinary same-age outfit changes",
    )
    reason: str = Field(description="One-sentence reason")

    @field_validator("age_group", mode="before")
    @classmethod
    def normalize_age_group(cls, v: str) -> str:
        return _normalize_age_group_value(v)


class DefaultIdentityRequirement(BaseModel):
    """Pass A: each character's default identity on the real-world main storyline."""

    character_name: str = Field(description="Character name (use the primary name)")
    visual_state: str = Field(
        description="Name of the default visual state on this episode's real-world main storyline (short English slug)"
    )
    age_group: str = Field(
        default="",
        description="Age group of this default identity, one of: child/youth/middle/elder. Required if the identity itself is a clear age stage; otherwise leave an empty string",
    )
    reason: str = Field(description="One-sentence reason")

    @field_validator("age_group", mode="before")
    @classmethod
    def normalize_age_group(cls, v: str) -> str:
        return _normalize_age_group_value(v)


class EpisodeDefaultIdentities(BaseModel):
    """Pass A output: the default identity of each character in the cast."""

    defaults: list[DefaultIdentityRequirement] = Field(
        default_factory=list,
        description="The default identity on the real-world main storyline for each cast character (one per character)",
    )


class EpisodeIdentityRequirements(BaseModel):
    """Pass B output: the other, non-default identities."""

    requirements: list[IdentityRequirement] = Field(
        default_factory=list,
        description="List of other non-default identities needed in this episode (excluding default identities)",
    )


_APPEARANCE_SCHEMA_TOKENS = (
    "appearance_details",
    "face_description",
    "age_group",
    "body_type",
)
_APPEARANCE_REASONING_RE = re.compile(
    r"(?:\blet(?:'s| us)\b|\breason(?:ing)?\b|step by step|\banalysis\s*:|"
    r"\bthinking\s*:|\bcount\s*:|check (?:the )?length|that's about|\bperfect\s*\.)",
    re.IGNORECASE,
)


def _appearance_corruption_reason(value: object, field_name: str) -> str | None:
    """Return a high-confidence reason when an appearance string is polluted."""
    text = str(value or "").strip()
    if not text:
        return None
    lowered = text.casefold()
    if "\ufffd" in text:
        return "contains the Unicode replacement character"
    if any(token in lowered for token in _APPEARANCE_SCHEMA_TOKENS):
        return "contains structured-output field names"
    if lowered == "/* empty */":
        return "contains a model empty-value sentinel"
    if (
        "```" in text
        or "<tool" in lowered
        or "</tool" in lowered
        or "@returns" in lowered
    ):
        return "contains tool-call scaffolding"
    if field_name in {"face_description", "body_type"} and (
        "\n" in text or "\r" in text
    ):
        return "short description contains multiple lines"
    if _APPEARANCE_REASONING_RE.search(text):
        return "contains model reasoning text"
    return None


class AppearanceDescription(BaseModel):
    """AI-generated identity appearance description."""

    appearance_details: str = Field(
        description="Appearance description (clothing, accessories, hairstyle, overall styling; 20-40 words; no actions or expressions)"
    )
    face_description: str = Field(
        default="",
        description="Face description (fill only when the identity involves an age change: age traits, face shape, facial proportions; no clothing)",
    )
    age_group: str = Field(
        default="",
        description="Fill only when the identity involves an age change: the age group of this identity, one of: child/youth/middle/elder; leave an empty string for ordinary outfit changes",
    )
    body_type: str = Field(
        default="",
        description="Fill only when the identity involves an age change: body type description (e.g. 'small, round toddler build', 'stooped, thin elderly build'); leave empty for ordinary outfit changes",
    )

    @field_validator(
        "appearance_details", "face_description", "body_type", mode="before"
    )
    @classmethod
    def strip_description(cls, value: object) -> object:
        if value is None:
            return ""
        if isinstance(value, str):
            return value.strip()
        return value

    @field_validator("appearance_details", "face_description", "body_type")
    @classmethod
    def validate_description(cls, value: str, info) -> str:
        field_name = info.field_name
        if reason := _appearance_corruption_reason(value, field_name):
            raise ValueError(f"{field_name} {reason}")
        if field_name == "appearance_details":
            if not 10 <= len(value) <= 400:
                raise ValueError("appearance_details length must be 10-400 characters")
        elif field_name == "face_description" and value and not 10 <= len(value) <= 300:
            raise ValueError("face_description length must be 10-300 characters")
        elif field_name == "body_type" and value and not 2 <= len(value) <= 160:
            raise ValueError("body_type length must be 2-160 characters")
        return value

    @field_validator("age_group", mode="before")
    @classmethod
    def normalize_age_group(cls, v: str) -> str:
        return _normalize_age_group_value(v)

    @model_validator(mode="after")
    def validate_age_variant_fields(self, info: ValidationInfo):
        variant_fields = (self.face_description, self.age_group, self.body_type)
        if any(variant_fields) and not all(variant_fields):
            raise ValueError(
                "face_description, age_group and body_type must be either all empty or all filled in"
            )
        context = info.context if isinstance(info.context, dict) else {}
        planned_age_group = _normalize_age_group_value(
            context.get("planned_age_group", "")
        )
        if planned_age_group and self.age_group != planned_age_group:
            raise ValueError(
                f"age_group={planned_age_group} was already planned; the appearance output must fill in the matching age-variant fields"
            )
        return self


class EpisodeCastList(BaseModel):
    """List of cast characters the AI selected from the source text."""

    character_names: list[str] = Field(
        description="List of characters who actually appear in this episode (use primary names)"
    )


APPEARANCE_GENERATION_PROMPT = """# You are a professional costume stylist for film and TV

## Task
Design costume and styling plans for characters in a fictional film/TV production.

## Requirements
- appearance_details: describe garment styles, fabric materials, accessories and hairstyle, 20-40 words, **without** the person's physical features, actions or expressions
- face_description: fill in **only when the identity involves an age change** (childhood, adolescence, old age, etc.), a 15-30 word face description
  - Include: age traits, face shape and contour, facial proportions
  - Exclude: clothing, accessories, actions, expressions
  - Do not fill this in for ordinary outfit-change identities (same age group)
- body_type: fill in **only when the identity involves an age change**, a body type description
  - Include: height, build, posture
  - Do not fill this in for ordinary outfit-change identities (same age group)
- Be concrete and visual, suitable as a reference for the film art department

## Examples
- appearance_details: "Moon-white linen monk's robe, coarse hemp rope at the waist, wooden prayer beads around the neck, straw sandals, shaved head"
- appearance_details: "Crimson gold-brocade wedding robe with phoenix crown and embroidered cape, gold tassel hairpin, floral decal on the forehead, hair coiled in a high bun"
- face_description (childhood): "Six- or seven-year-old child, round small face, big bright almond eyes, small nose, chubby baby-fat cheeks"
- face_description (old age): "Man in his seventies, gaunt wrinkled cheeks, deep-set eyes, prominent cheekbones, sparse graying temples"
- body_type (childhood): "Small, round toddler build, only waist-high to an adult"
- body_type (old age): "Stooped, thin elderly build, slightly short, back slightly hunched"
"""


DEFAULT_IDENTITY_PROMPT = """# You are an analyst of film/TV character main-storyline forms

## Task
Determine one **real-world main-storyline default identity** for each character who appears in this episode.

## What is a "default identity"
- The most frequently appearing stable visual form of the character in this episode's **non-memory, non-flashback, non-dream** real-world scenes
- A character has exactly one default identity
- If the character has only one form in this episode, that is the default identity

## Rules
- Prefer reusing existing identity names; do not create near-synonyms
- Name identities with a short English snake_case slug (lowercase letters, digits, underscores; no spaces). Prefer life-stage / social-stage / age-stage names (e.g. "corporate_era", "middle_aged", "student", "child")
- Only use a look-branch name (e.g. "office_attire", "home_attire") when two repeatedly recurring looks exist stably **within the same period**
- Do not use a clothing category directly as a top-level default identity name; if it essentially corresponds to a life stage, name it after that stage
- Do not use plot-semantic words (no "return_era", "awakening_era")
- Do not use short-term situation words (no "down_and_out", "imprisoned")
- Do not include the character name (use "middle_aged", not "Dunstan_middle_aged")
- Also output age_group
  - If visual_state is clearly an age stage (e.g. "child", "teen", "middle_aged", "elderly"), age_group is required
  - Ordinary same-age look branches (e.g. "office_attire", "home_attire") may leave it empty
"""


OTHER_IDENTITY_PROMPT = """# You are a film/TV visual-identity analyst

## Task
Based on the full text of this episode, find the other identities each character needs **in addition to** the default identity.

## What is an "other identity"
- Any form that differs from the default identity and needs its own stable visual base
- Including but not limited to:
  - Different age forms in memories/flashbacks (child, teen, elderly)
  - Another stable look that recurs over a long time within the same period (e.g. court dress vs casual wear, office attire vs home attire)
  - Historical appearances on TV screens / in photographs
  - Another stage form clearly separated over a long span within the same episode

## What is NOT an "other identity"
- One-off states (dirty, injured, soaked)
- Short-term plot situations (about to be married off, down and out, imprisoned)
- A single action or camera language
- Mere changes in emotion, position or composition

## Hard constraints
- **Age variants must be separate identities**: face shape, features and height are entirely different, even if they appear in only one or two scenes
- Do not interpret this step as "only add age identities"
- Whenever it is not the same stable visual base as the default identity, it should be listed
- Prefer period/stage names for naming (short English snake_case slugs such as "child", "teen", "elderly", "1893_chicago"); only use look names like "attire / casual / formal" when distinguishing several long-lived looks within the same period
- Default identities have already been handled; do not output them again
- Prefer reusing existing identity names
- Also output age_group
  - Age variants (child / teen / middle-aged / elderly) must fill in the matching age_group
  - Ordinary same-age look branches may leave it empty
"""


# =============================================================================
# IdentityPlanner
# =============================================================================


def format_character_info(characters: list[str], resolve_name, get_character) -> str:
    """Basic info + existing identities text (shared by Pass A/B)."""
    lines = []
    for char_name in characters:
        resolved = resolve_name(char_name)
        char = get_character(resolved)
        if char:
            lines.append(f"### {char.name}")
            base_attrs = []
            if char.gender:
                base_attrs.append(f"gender: {char.gender}")
            if char.age_group:
                base_attrs.append(f"default age group: {char.age_group}")
            if char.face_prompt:
                base_attrs.append(f"default face: {char.face_prompt}")
            if char.body_type:
                base_attrs.append(f"body type: {char.body_type}")
            if base_attrs:
                lines.append(f"Basic info: {', '.join(base_attrs)}")
            if char.identities:
                for ident in char.identities:
                    desc = ident.appearance_details or "no description"
                    extra = ""
                    if ident.face_prompt:
                        extra = f" [identity-level face: {ident.face_prompt[:30]}, age_group={ident.age_group}]"
                    lines.append(f"- `{ident.identity_id}`: {desc}{extra}")
            else:
                lines.append("- (no existing identities)")
            lines.append("")
        else:
            lines.append(f"### {resolved or char_name}")
            lines.append("- (no existing identities)")
            lines.append("")
    return "\n".join(lines)


def build_default_identity_system_prompt(content_text: str) -> str:
    return f"{DEFAULT_IDENTITY_PROMPT}\n{asset_language_instruction(detect_asset_language(content_text))}"


def build_default_identity_task(
    *,
    episode_number: int,
    episode_title: str,
    cast_names: list[str],
    identity_info: str,
    graph_context: str | None,
    content_text: str,
) -> str:
    """Pass A user message: each cast member's default identity for the episode."""
    graph_section = ""
    if graph_context and graph_context.strip():
        graph_section = f"\n## Graph context\n{graph_context[:3000]}\n"
    return f"""Analyze the **real-world main-storyline default identity** of each character in episode {episode_number} "{episode_title}".

## Cast
{", ".join(cast_names)}

## Existing identities (prefer reuse)
{identity_info}
{graph_section}
## Episode source text
{content_text}

---
Determine one default identity for each cast character (the stable form that appears most often on the real-world main storyline).
- Where an existing identity covers it, use the same visual_state name (reuse)
- Use the character's primary name for character_name
- Output exactly one default identity per character
- Also output age_group
  - If visual_state is clearly an age stage, fill in the matching age_group
  - If it is only a same-age look branch, leave it empty
"""


class IdentityPlanner:
    """Plan character identities for all episodes in batch.

    Episodes are processed in order, so later episodes see the identities created by earlier ones and reuse them naturally.

    Example:
        >>> planner = IdentityPlanner(cognee_store)
        >>> results = await planner.plan_all_episodes(episodes)
        >>> # results = {1: 2, 2: 0, 3: 1}  # {episode number: number of new identities}
    """

    def __init__(self, cognee_store: "CogneeStore"):
        self.cognee_store = cognee_store
        # Reads and writes that need no graph go to the SQLite store directly.
        self.store = getattr(cognee_store, "sqlite_store", cognee_store)
        self._structured = is_structured_pipeline(
            getattr(cognee_store, "state_dir", None)
        )
        self.auto_promoted_characters: list[str] = []

    @staticmethod
    def _normalize_visual_state_for_char(char_name: str, visual_state: str) -> str:
        """Normalize a visual_state carrying a character prefix like `Dunstan_middle_aged` to `middle_aged`."""
        normalized_char = str(char_name or "").strip()
        normalized_state = str(visual_state or "").strip()
        prefix = normalized_char + "_"
        if normalized_char and normalized_state.startswith(prefix):
            return normalized_state[len(prefix) :].strip()
        return normalized_state

    @staticmethod
    def _infer_age_group_from_visual_state(visual_state: str) -> str:
        """Infer an explicit age variant from the identity name alone."""
        text = str(visual_state or "").strip().lower()
        if not text:
            return ""

        normalized = re.sub(r"[^a-z0-9]+", "_", text).strip("_")
        tokens = set(normalized.split("_"))

        child_tokens = {"child", "childhood", "kid", "toddler", "infant"}
        youth_tokens = {"teen", "teens", "teenage", "teenager", "student", "adolescent"}
        middle_tokens = {"middle", "midlife"}
        elder_tokens = {"elderly", "elder", "senior"}

        if tokens & child_tokens:
            return "child"
        if tokens & youth_tokens or "young_adult" in normalized:
            return "youth"
        if tokens & middle_tokens:
            return "middle"
        if tokens & elder_tokens or any(
            phrase in normalized for phrase in ("old_age", "old_man", "old_woman")
        ):
            return "elder"
        return ""

    def _seed_identity_structured_fields(
        self,
        char,
        visual_state: str,
        age_group: str = "",
    ) -> tuple[str, str]:
        """Use the AI-provided age_group, with a minimal consistency check."""
        normalized_age_group = _normalize_age_group_value(age_group)
        inferred_age_group = self._infer_age_group_from_visual_state(visual_state)
        if (
            inferred_age_group
            and normalized_age_group
            and inferred_age_group != normalized_age_group
        ):
            raise ValueError(
                f"age_group conflict for identity `{visual_state}`: AI={normalized_age_group}, inferred from name={inferred_age_group}"
            )
        final_age_group = normalized_age_group or inferred_age_group
        if not inferred_age_group and final_age_group == getattr(char, "age_group", ""):
            final_age_group = ""
        inferred_fish_voice = ""
        if final_age_group:
            from novelvideo.config import get_fish_voice_id

            inferred_fish_voice = get_fish_voice_id(final_age_group, char.gender)
        return final_age_group, inferred_fish_voice

    @staticmethod
    def _identity_model(
        model_env: str,
        *,
        brainclaw_profile: BrainClawProfile | None = None,
    ):
        profile_by_env = {
            "IDENTITY_PLANNER_CAST_MODEL": BrainClawProfile.IDENTITY_CAST_PLANNING,
            "IDENTITY_PLANNER_APPEARANCE_MODEL": BrainClawProfile.IDENTITY_APPEARANCE_WRITING,
        }
        return get_newapi_text_pydantic_model(
            model_env,
            brainclaw_profile=brainclaw_profile or profile_by_env.get(model_env),
            capability="text.generate.agent",
        )

    @staticmethod
    def _identity_model_settings() -> dict:
        return get_newapi_structured_output_model_settings()

    async def plan_single_episode(
        self,
        episode: "NovelEpisode",
        on_log: Optional[Callable] = None,
    ) -> tuple[int, int]:
        """Plan the identities of a single episode. Saves the cache automatically when done.

        Returns:
            (new_count, resolved_count): number of newly created identities and total resolved identities
        """
        self.auto_promoted_characters = []
        content_text = await load_episode_planning_content(self.cognee_store, episode)
        if not content_text or not content_text.strip():
            return 0, 0
        output_language = detect_asset_language(content_text)

        # Pre-screen the cast (called once, reused afterwards)
        all_chars = self.cognee_store.get_all_characters()
        all_names = [c.name for c in all_chars]
        cast_names, graph_context = await self._filter_cast(
            all_names, content_text, episode, on_log
        )
        if not cast_names:
            raise ValueError(
                "Pass 0 could not reliably identify this episode's cast; planning aborted to avoid polluting existing identity results"
            )

        # Pass A: default identity analysis + resolve
        default_requirements = await self._analyze_default_identities(
            episode,
            on_log,
            cast_names=cast_names,
            content_text=content_text,
            graph_context=graph_context,
        )
        new_count = 0
        resolved_ids: list[str] = []
        identity_default_map: dict[str, str] = {}

        if default_requirements.defaults:
            default_as_requirements = EpisodeIdentityRequirements(
                requirements=[
                    IdentityRequirement(
                        character_name=d.character_name,
                        visual_state=d.visual_state,
                        age_group=d.age_group,
                        reason=d.reason,
                    )
                    for d in default_requirements.defaults
                ]
            )
            (
                default_new,
                resolved_ids,
                resolved_identity_map,
            ) = await self._resolve_requirements(
                episode.number,
                default_as_requirements,
                on_log,
                output_language=output_language,
            )
            new_count += default_new
            for d in default_requirements.defaults:
                char_name = (
                    self.cognee_store.resolve_name(d.character_name) or d.character_name
                )
                normalized_visual_state = self._normalize_visual_state_for_char(
                    char_name,
                    d.visual_state,
                )
                identity_id = resolved_identity_map.get(
                    (char_name, normalized_visual_state)
                )
                if identity_id:
                    identity_default_map[char_name] = identity_id
                    if on_log:
                        on_log(f"  Default identity: {char_name} -> {identity_id}")

        canonical_cast_names = list(
            dict.fromkeys(
                (self.cognee_store.resolve_name(name) or name).strip()
                for name in cast_names
                if str(name or "").strip()
            )
        )
        missing_default_chars = [
            char_name
            for char_name in canonical_cast_names
            if not identity_default_map.get(char_name)
        ]
        if missing_default_chars:
            if on_log:
                on_log(
                    f"[EP{episode.number:03d}] Pass A missing default identities: "
                    + ", ".join(missing_default_chars)
                )
            raise ValueError(
                "Pass A default identity coverage is incomplete: "
                + ", ".join(missing_default_chars)
            )

        # Pass B: other non-default identity analysis + resolve
        special_requirements = await self._analyze_special_identities(
            episode,
            on_log,
            cast_names=cast_names,
            content_text=content_text,
            graph_context=graph_context,
            already_resolved=resolved_ids,
        )
        if special_requirements.requirements:
            special_new, special_ids, _ = await self._resolve_requirements(
                episode.number,
                special_requirements,
                on_log,
                output_language=output_language,
            )
            new_count += special_new
            resolved_seen = set(resolved_ids)
            for identity_id in special_ids:
                if identity_id in resolved_seen:
                    continue
                resolved_ids.append(identity_id)
                resolved_seen.add(identity_id)

        # Save
        if resolved_ids:
            char_names = list(
                dict.fromkeys(iid.split("_", 1)[0] for iid in resolved_ids)
            )
            await self._write_episode_identities(
                episode.number,
                identity_ids=resolved_ids,
                character_names=char_names,
                identity_default_map=identity_default_map,
            )

        return new_count, len(resolved_ids)

    async def plan_all_episodes(
        self,
        episodes: list["NovelEpisode"],
        on_log: Optional[Callable] = None,
        on_progress: Optional[Callable] = None,
    ) -> dict[int, int]:
        """Plan the identities of all episodes in batch, processing them in episode order.

        Returns:
            {episode number: number of new identities; -1 on failure}
        """
        results = {}
        sorted_eps = sorted(episodes, key=lambda e: e.number)

        for i, episode in enumerate(sorted_eps):
            if on_progress:
                on_progress(
                    (i + 1) / len(sorted_eps),
                    f"Planning identities for episode {episode.number}...",
                )
            try:
                new_count, resolved_count = await self.plan_single_episode(
                    episode, on_log
                )
                results[episode.number] = new_count
                if on_log:
                    on_log(
                        f"[EP{episode.number:03d}] Done, {new_count} new / {resolved_count - new_count} reused identities"
                    )
            except Exception as e:
                results[episode.number] = -1
                if on_log:
                    on_log(f"[EP{episode.number:03d}] Failed: {e}")

        return results

    async def _write_episode_identities(self, episode_number: int, **fields) -> None:
        """Persist this episode's identities with a column-level write.

        Identity planning runs alongside scene and prop planning for the same
        episode, so a whole-row write here would re-serialise — and lose — a
        menu written meanwhile.
        """
        await self.store.patch_episode(episode_number, **fields)

    def _alias_context_from_sqlite(self, all_names: list[str]) -> str:
        """Build alias context from the character table instead of the graph.

        Structured builds record every alias they could prove from the source
        text, so the same "Your Majesty -> Xiao Jue" resolution the graph query provided is
        already on disk and needs no search to retrieve.
        """
        lines: list[str] = []
        for name in all_names:
            character = self.store.get_character(self.store.resolve_name(name))
            if character is None:
                continue
            if character.aliases:
                lines.append(
                    f"{character.name}: aliases/forms of address {', '.join(character.aliases)}"
                )
            else:
                lines.append(f"{character.name}: no known aliases")
        return "\n".join(lines)

    async def _graph_alias_context(
        self, episode: "NovelEpisode", on_log: Optional[Callable] = None
    ) -> str:
        """Legacy-only: read alias context from the Cognee graph.

        Failure is non-fatal, as it always was here: the cast filter still runs
        on the episode text alone, just without alias hints.
        """

        with preserve_st_env():
            import cognee
            from cognee.api.v1.search import SearchType

        try:
            async with ladybug_graph_access(
                self.cognee_store.state_dir,
                read_only=True,
            ):
                with self.cognee_store.embedding_model_scope():
                    graph_results = await cognee.search(
                        query_text=(
                            f"Characters appearing in episode {episode.number}, "
                            "and their aliases, forms of address and relationships"
                        ),
                        query_type=SearchType.GRAPH_COMPLETION,
                        datasets=[self.cognee_store.dataset_name],
                        only_context=True,
                        top_k=20,
                    )
        except Exception as exc:
            if on_log:
                on_log(
                    f"[EP{episode.number:03d}] Failed to fetch graph context (non-fatal): {exc}"
                )
            return ""

        if not graph_results:
            return ""
        parts = []
        for item in graph_results:
            if hasattr(item, "search_result"):
                parts.append(str(item.search_result))
            elif isinstance(item, dict):
                parts.append(str(item.get("search_result", item)))
            else:
                parts.append(str(item))
        return "\n".join(parts)

    async def _filter_cast(
        self,
        all_names: list[str],
        content_text: str,
        episode: "NovelEpisode",
        on_log: Optional[Callable] = None,
    ) -> tuple[list[str], str]:
        """Use the cognee graph + AI to select the characters who actually appear in this episode from the source text (including alias resolution).

        Relies on cognee.search graph capabilities to resolve alias relationships automatically (e.g. "Your Majesty" -> Xiao Jue).

        Returns:
            (filtered_names, graph_context) — the filtered character name list + graph context text
        """
        graph_context = ""
        try:
            if self._structured:
                # structured_v1 has no graph. Alias resolution comes from the
                # SQLite alias index and the evidence recorded when characters
                # were built, both of which are derived from the source text
                # rather than from a vector search over it.
                graph_context = self._alias_context_from_sqlite(all_names)
            else:
                graph_context = await self._graph_alias_context(episode, on_log)

            graph_section = ""
            if graph_context:
                graph_section = f"""

Known character relationships and alias information (including forms-of-address resolution, e.g. "Your Majesty" -> a character name):
---
{graph_context[:4000]}
---
Use the above to resolve forms of address / aliases in the source text to the character's primary name.
"""

            cast_agent = Agent(
                self._identity_model("IDENTITY_PLANNER_CAST_MODEL"),
                model_settings=self._identity_model_settings(),
                output_type=EpisodeCastList,
            )
            cast_result = await cast_agent.run(f"""All known characters:
{chr(10).join(all_names)}
{graph_section}
Based on the source text of episode {episode.number}, list the characters **mentioned** in this episode.
A character counts as appearing whenever the character name or an alias / form of address occurs in the source text (whether on screen, in a memory, in a flashback, or mentioned by the narrator).
Note: return primary names, not aliases.

Source text:
{content_text}""")
            cast = cast_result.output
            filtered = self._normalize_cast_names(cast.character_names)
            if on_log:
                on_log(
                    f"[EP{episode.number:03d}] Graph+AI selected cast: {', '.join(filtered)}"
                )
            return filtered, graph_context
        except Exception as e:
            if on_log:
                on_log(f"[EP{episode.number:03d}] AI cast selection failed: {e}")
            raise RuntimeError(f"Pass 0 cast selection failed: {e}") from e

    def _build_character_info(self, characters: list[str]) -> str:
        """Build the text of character basic info + existing identities."""
        return format_character_info(
            characters, self.cognee_store.resolve_name, self.cognee_store.get_character
        )

    def _normalize_cast_names(self, names: list[str]) -> list[str]:
        """Map primary names/aliases to primary names and deduplicate."""
        normalized: list[str] = []
        seen: set[str] = set()
        for raw_name in names:
            name = str(raw_name or "").strip()
            if not name:
                continue
            resolved = (self.cognee_store.resolve_name(name) or name).strip()
            if not resolved or resolved in seen:
                continue
            if self.cognee_store.get_character(resolved) is None:
                continue
            normalized.append(resolved)
            seen.add(resolved)
        return normalized

    def _validate_default_requirements(
        self,
        defaults: list[DefaultIdentityRequirement],
        cast_names: list[str],
        on_log: Optional[Callable] = None,
    ) -> list[DefaultIdentityRequirement]:
        """Ensure the Pass A output gives each character exactly one default identity."""
        canonical_cast_names = self._normalize_cast_names(cast_names)
        cast_set = set(canonical_cast_names)
        seen_char_to_item: dict[str, DefaultIdentityRequirement] = {}

        for item in defaults:
            char_name = (
                self.cognee_store.resolve_name(item.character_name)
                or item.character_name
            ).strip()
            visual_state = self._normalize_visual_state_for_char(
                char_name,
                str(item.visual_state or "").strip(),
            )
            if not char_name or not visual_state:
                continue
            if cast_set and char_name not in cast_set:
                continue
            existing_item = seen_char_to_item.get(char_name)
            if existing_item and existing_item.visual_state != visual_state:
                raise ValueError(
                    f"Pass A output multiple default identities for character {char_name}: {existing_item.visual_state}, {visual_state}"
                )
            if existing_item:
                try:
                    merged_age_group = _merge_age_group_values(
                        existing_item.age_group, item.age_group
                    )
                except ValueError:
                    if on_log:
                        on_log(
                            f"[Pass A] {char_name}_{visual_state} age_group conflict: "
                            f"{existing_item.age_group!r} vs {item.age_group!r}, keeping the former"
                        )
                    merged_age_group = existing_item.age_group
                if merged_age_group != existing_item.age_group:
                    existing_item.age_group = merged_age_group
                continue
            seen_char_to_item[char_name] = DefaultIdentityRequirement(
                character_name=char_name,
                visual_state=visual_state,
                age_group=item.age_group,
                reason=item.reason,
            )

        missing_chars = [
            char_name
            for char_name in canonical_cast_names
            if char_name not in seen_char_to_item
        ]
        if missing_chars:
            raise ValueError(
                "Pass A default identity coverage is incomplete: "
                + ", ".join(missing_chars)
            )
        return list(seen_char_to_item.values())

    def _normalize_other_requirements(
        self,
        requirements: list[IdentityRequirement],
        cast_names: list[str],
        default_identity_ids: list[str] | None = None,
        on_log: Optional[Callable] = None,
    ) -> list[IdentityRequirement]:
        """Normalize the Pass B output, filtering out characters outside the cast, duplicates and duplicates of default identities."""
        canonical_cast_names = self._normalize_cast_names(cast_names)
        cast_set = set(canonical_cast_names)
        default_states_by_char: dict[str, set[str]] = {}
        for identity_id in default_identity_ids or []:
            normalized_id = str(identity_id or "").strip()
            if not normalized_id or "_" not in normalized_id:
                continue
            char_name, identity_name = normalized_id.split("_", 1)
            default_states_by_char.setdefault(char_name, set()).add(identity_name)

        seen_pairs: dict[tuple[str, str], IdentityRequirement] = {}
        for item in requirements:
            char_name = (
                self.cognee_store.resolve_name(item.character_name)
                or item.character_name
            ).strip()
            visual_state = self._normalize_visual_state_for_char(
                char_name,
                str(item.visual_state or "").strip(),
            )
            if not char_name or not visual_state:
                continue
            if cast_set and char_name not in cast_set:
                continue
            if visual_state in default_states_by_char.get(char_name, set()):
                continue
            pair = (char_name, visual_state)
            existing_item = seen_pairs.get(pair)
            if existing_item:
                try:
                    merged_age_group = _merge_age_group_values(
                        existing_item.age_group, item.age_group
                    )
                except ValueError:
                    if on_log:
                        on_log(
                            f"[Pass B] {char_name}_{visual_state} age_group conflict: "
                            f"{existing_item.age_group!r} vs {item.age_group!r}, keeping the former"
                        )
                    merged_age_group = existing_item.age_group
                if merged_age_group != existing_item.age_group:
                    existing_item.age_group = merged_age_group
                continue
            seen_pairs[pair] = IdentityRequirement(
                character_name=char_name,
                visual_state=visual_state,
                age_group=item.age_group,
                reason=item.reason,
            )
        return list(seen_pairs.values())

    async def _analyze_default_identities(
        self,
        episode: "NovelEpisode",
        on_log: Optional[Callable] = None,
        *,
        cast_names: list[str] | None = None,
        content_text: str | None = None,
        graph_context: str | None = None,
    ) -> EpisodeDefaultIdentities:
        """Pass A: analyze each character's default identity on the real-world main storyline."""
        if content_text is None:
            content_text = await self.cognee_store.load_episode_content(episode.number)
        if not content_text:
            return EpisodeDefaultIdentities()
        if cast_names is None:
            cast_names = [c.name for c in self.cognee_store.get_all_characters()]

        identity_info = self._build_character_info(cast_names)
        task = build_default_identity_task(
            episode_number=episode.number,
            episode_title=episode.title,
            cast_names=cast_names,
            identity_info=identity_info,
            graph_context=graph_context,
            content_text=content_text,
        )
        try:
            agent = Agent(
                self._identity_model(
                    "IDENTITY_PLANNER_ANALYSIS_MODEL",
                    brainclaw_profile=BrainClawProfile.IDENTITY_DEFAULT_ANALYSIS,
                ),
                system_prompt=build_default_identity_system_prompt(content_text),
                model_settings=self._identity_model_settings(),
                output_type=EpisodeDefaultIdentities,
            )
            result = await agent.run(task)
            result.output.defaults = self._validate_default_requirements(
                result.output.defaults,
                cast_names,
                on_log=on_log,
            )
            if on_log:
                for d in result.output.defaults:
                    age_suffix = f", age_group={d.age_group}" if d.age_group else ""
                    on_log(
                        f"  [Pass A] {d.character_name} -> {d.visual_state}{age_suffix} ({d.reason})"
                    )
            return result.output
        except Exception as e:
            if on_log:
                on_log(
                    f"[EP{episode.number:03d}] Pass A default identity analysis failed: {e}"
                )
            raise RuntimeError(f"Pass A default identity analysis failed: {e}") from e

    async def _analyze_special_identities(
        self,
        episode: "NovelEpisode",
        on_log: Optional[Callable] = None,
        *,
        cast_names: list[str] | None = None,
        content_text: str | None = None,
        graph_context: str | None = None,
        already_resolved: list[str] | None = None,
    ) -> EpisodeIdentityRequirements:
        """Pass B: analyze, over the full text, the other non-default identities beyond the default identities."""
        if content_text is None:
            content_text = await self.cognee_store.load_episode_content(episode.number)
        if not content_text:
            return EpisodeIdentityRequirements()
        if cast_names is None:
            cast_names = [c.name for c in self.cognee_store.get_all_characters()]

        canonical_cast_names = self._normalize_cast_names(cast_names)
        identity_info = self._build_character_info(canonical_cast_names)
        graph_section = ""
        if graph_context and graph_context.strip():
            graph_section = f"\n## Graph context\n{graph_context[:3000]}\n"

        resolved_default_ids = list(dict.fromkeys(already_resolved or []))
        already_section = ""
        if resolved_default_ids:
            already_section = (
                "\n## Already-determined default identities (do not repeat)\n"
                + "\n".join(f"- `{iid}`" for iid in resolved_default_ids)
                + "\n"
            )

        task = f"""Analyze the **other identities** each character in episode {episode.number} "{episode.title}" needs beyond the default identity.

## Cast
{", ".join(canonical_cast_names)}

## Existing identities (prefer reuse)
{identity_info}
{already_section}{graph_section}
## Episode source text
{content_text}

---
List the other non-default identities in this episode that have strong textual evidence.
- Do not repeat default identities
- Age variants (child / teen / elderly) must be separate identities, even if they appear only in one or two memory/flashback scenes
- Another stable long-lived look/stage should also be listed separately
- Where an existing identity covers it, use the same visual_state name (reuse)
- Also output age_group
  - Age variants must fill in the matching age_group
  - Ordinary same-age look branches may leave it empty
- If there are no other identity needs, return an empty list
"""
        try:
            language_instruction = asset_language_instruction(
                detect_asset_language(content_text)
            )
            agent = Agent(
                self._identity_model(
                    "IDENTITY_PLANNER_ANALYSIS_MODEL",
                    brainclaw_profile=BrainClawProfile.IDENTITY_SPECIAL_ANALYSIS,
                ),
                system_prompt=f"{OTHER_IDENTITY_PROMPT}\n{language_instruction}",
                model_settings=self._identity_model_settings(),
                output_type=EpisodeIdentityRequirements,
            )
            result = await agent.run(task)
            result.output.requirements = self._normalize_other_requirements(
                result.output.requirements,
                canonical_cast_names,
                resolved_default_ids,
                on_log=on_log,
            )
            for req in result.output.requirements:
                if on_log:
                    age_suffix = f", age_group={req.age_group}" if req.age_group else ""
                    on_log(
                        f"  [Pass B] {req.character_name} -> {req.visual_state}{age_suffix} ({req.reason})"
                    )
            return result.output
        except Exception as e:
            if on_log:
                on_log(
                    f"[EP{episode.number:03d}] Pass B other-identity analysis failed: {e}"
                )
            return EpisodeIdentityRequirements()

    @staticmethod
    def _is_pending_planner_identity(identity: CharacterIdentity) -> bool:
        return (
            identity.source == "identity_planner"
            and not str(identity.appearance_details or "").strip()
            and not str(identity.face_prompt or "").strip()
            and not str(identity.body_type or "").strip()
        )

    @staticmethod
    def _corrupted_identity_fields(identity: CharacterIdentity) -> dict[str, str]:
        if identity.source != "identity_planner":
            return {}
        field_specs = {
            "appearance_details": (identity.appearance_details, "appearance_details"),
            "face_prompt": (identity.face_prompt, "face_description"),
            "body_type": (identity.body_type, "body_type"),
        }
        return {
            storage_field: reason
            for storage_field, (value, schema_field) in field_specs.items()
            if (reason := _appearance_corruption_reason(value, schema_field))
        }

    async def _generate_identity_appearance_updates(
        self,
        char,
        visual_state: str,
        resolved_age_group: str,
        explicit_age_group: str,
        inferred_fish_voice: str,
        reason: str,
        on_log: Optional[Callable] = None,
        output_language: AssetLanguage | None = None,
    ) -> dict[str, str]:
        appearance_result = await self._generate_appearance(
            char.name,
            visual_state,
            resolved_age_group,
            reason,
            on_log,
            output_language=output_language,
        )

        if isinstance(appearance_result, str):
            appearance = appearance_result.strip()
            face_description = ""
            voice_age_group = resolved_age_group
            identity_body_type = ""
        else:
            appearance = appearance_result.appearance_details
            face_description = appearance_result.face_description or ""
            appearance_age_group = _normalize_age_group_value(
                appearance_result.age_group
            )
            if (
                resolved_age_group
                and appearance_age_group
                and appearance_age_group != resolved_age_group
            ):
                if on_log:
                    on_log(
                        f"  ⚠ {char.name}_{visual_state}: appearance stage age_group={appearance_age_group} "
                        f"conflicts with identity-planned age_group={resolved_age_group}; using the identity-planned value"
                    )
                appearance_age_group = resolved_age_group
            voice_age_group = appearance_age_group or resolved_age_group
            identity_body_type = appearance_result.body_type or ""

        identity_fish_voice = inferred_fish_voice
        if voice_age_group:
            from novelvideo.config import get_fish_voice_id

            identity_fish_voice = get_fish_voice_id(voice_age_group, char.gender)
        else:
            identity_body_type = ""

        if (
            voice_age_group
            and voice_age_group == char.age_group
            and not explicit_age_group
        ):
            if on_log:
                on_log(
                    f"  ⚠ {char.name}_{visual_state}: age_group={voice_age_group} "
                    "is the same as the character's; clearing age-variant fields"
                )
            face_description = ""
            voice_age_group = ""
            identity_body_type = ""
            identity_fish_voice = ""

        reconciled = AppearanceDescription(
            appearance_details=appearance,
            face_description=face_description,
            age_group=voice_age_group,
            body_type=identity_body_type,
        )
        return {
            "appearance_details": reconciled.appearance_details,
            "face_prompt": reconciled.face_description,
            "age_group": reconciled.age_group,
            "body_type": reconciled.body_type,
            "fish_voice_id": identity_fish_voice,
        }

    async def _recover_identity_appearance(
        self,
        *,
        char,
        identity: CharacterIdentity,
        visual_state: str,
        resolved_age_group: str,
        explicit_age_group: str,
        inferred_fish_voice: str,
        reason: str,
        pending: bool,
        corrupted_fields: dict[str, str],
        on_log: Optional[Callable] = None,
        output_language: AssetLanguage | None = None,
    ) -> bool:
        try:
            generated = await self._generate_identity_appearance_updates(
                char,
                visual_state,
                resolved_age_group,
                explicit_age_group,
                inferred_fish_voice,
                reason,
                on_log,
                output_language=output_language,
            )
        except Exception:
            if corrupted_fields:
                sanitized = {field: "" for field in corrupted_fields}
                await self.cognee_store.update_character_identity(
                    char.name,
                    identity.identity_id,
                    **sanitized,
                )
                if on_log:
                    on_log(
                        f"  ⚠ Repair failed; cleared corrupted fields: {identity.identity_id} "
                        f"({', '.join(sorted(corrupted_fields))})"
                    )
            elif on_log:
                on_log(f"  Kept: {identity.identity_id} created, appearance pending")
            return False

        if pending:
            await self.cognee_store.update_character_identity(
                char.name,
                identity.identity_id,
                **generated,
            )
            if on_log:
                on_log(
                    f"  Filled in: {identity.identity_id} — "
                    f"{generated['appearance_details'][:40]}..."
                )
            return True

        repair_updates = {field: generated[field] for field in corrupted_fields}
        merged_age_group = str(identity.age_group or "").strip()
        merged = {
            "appearance_details": repair_updates.get(
                "appearance_details", identity.appearance_details
            ),
            "face_description": repair_updates.get("face_prompt", identity.face_prompt),
            "age_group": merged_age_group,
            "body_type": repair_updates.get("body_type", identity.body_type),
        }
        try:
            AppearanceDescription(**merged)
        except ValueError:
            repair_updates = {field: "" for field in corrupted_fields}
            if on_log:
                on_log(
                    f"  ⚠ Could not repair {identity.identity_id} while keeping the valid fields; "
                    "cleared corrupted fields and using the character-level fallback"
                )

        await self.cognee_store.update_character_identity(
            char.name,
            identity.identity_id,
            **repair_updates,
        )
        if on_log:
            on_log(
                f"  Repaired: {identity.identity_id} "
                f"({', '.join(sorted(corrupted_fields))})"
            )
        return True

    async def _resolve_requirements(
        self,
        episode_number: int,
        requirements: EpisodeIdentityRequirements,
        on_log: Optional[Callable] = None,
        output_language: AssetLanguage | None = None,
    ) -> tuple[int, list[str], dict[tuple[str, str], str]]:
        """Phase 2: match existing identities -> create missing identities.

        Returns:
            (new_count, resolved_ids, resolved_identity_map):
            number of new identities, list of all resolved identity_ids, and a mapping from (character_name, visual_state) to identity_id
        """
        new_count = 0
        resolved_ids: list[str] = []
        resolved_identity_map: dict[tuple[str, str], str] = {}

        for req in requirements.requirements:
            resolved_name = self.cognee_store.resolve_name(req.character_name)
            char = self.cognee_store.get_character(resolved_name)
            if not char:
                if on_log:
                    on_log(f"  Skipped: character {req.character_name} does not exist")
                continue

            # Build the candidate identity_id (strip a duplicated character-name prefix from visual_state)
            vs = self._normalize_visual_state_for_char(char.name, req.visual_state)
            candidate_id = f"{char.name}_{vs}"
            explicit_age_group = self._infer_age_group_from_visual_state(vs)
            try:
                resolved_age_group, inferred_fish_voice = (
                    self._seed_identity_structured_fields(char, vs, req.age_group)
                )
            except ValueError as e:
                if on_log:
                    on_log(f"  Skipped: {candidate_id} field conflict ({e})")
                continue

            # 1. Exact match on identity_id
            matched = self._find_matching_identity(char, vs, candidate_id)

            if matched:
                resolved_ids.append(matched.identity_id)
                resolved_identity_map[(char.name, vs)] = matched.identity_id
                pending = self._is_pending_planner_identity(matched)
                corrupted_fields = self._corrupted_identity_fields(matched)
                if pending or corrupted_fields:
                    repair_age_group = (
                        _normalize_age_group_value(getattr(matched, "age_group", ""))
                        or resolved_age_group
                    )
                    await self._recover_identity_appearance(
                        char=char,
                        identity=matched,
                        visual_state=vs,
                        resolved_age_group=repair_age_group,
                        explicit_age_group=explicit_age_group,
                        inferred_fish_voice=inferred_fish_voice,
                        reason=req.reason,
                        pending=pending,
                        corrupted_fields=corrupted_fields,
                        on_log=on_log,
                        output_language=output_language,
                    )
                else:
                    updates = {}
                    existing_age_group = getattr(matched, "age_group", "")
                    if existing_age_group != resolved_age_group:
                        updates["age_group"] = resolved_age_group
                    if inferred_fish_voice and not getattr(
                        matched, "fish_voice_id", ""
                    ):
                        updates["fish_voice_id"] = inferred_fish_voice
                    if updates:
                        try:
                            await self.cognee_store.update_character_identity(
                                char.name,
                                matched.identity_id,
                                **updates,
                            )
                            if on_log:
                                on_log(
                                    f"  Backfilled structural fields: {matched.identity_id}"
                                    f" age_group={updates.get('age_group', getattr(matched, 'age_group', ''))}"
                                )
                        except Exception as e:
                            if on_log:
                                on_log(
                                    f"  Failed to backfill structural fields ({matched.identity_id}): {e}"
                                )
                    if on_log:
                        on_log(f"  Reused: {matched.identity_id} (ep{episode_number})")
            else:
                from novelvideo.utils.identity_resolver import compute_char_tag

                identity = CharacterIdentity(
                    identity_id=candidate_id,
                    character_name=char.name,
                    identity_name=vs,
                    character_tag=compute_char_tag(char.name, identity_id=candidate_id),
                    age_group=resolved_age_group,
                    fish_voice_id=inferred_fish_voice,
                    source="identity_planner",
                )

                try:
                    await self.cognee_store.add_character_identity(char.name, identity)
                    new_count += 1
                    resolved_ids.append(candidate_id)
                    resolved_identity_map[(char.name, vs)] = candidate_id
                    if on_log:
                        on_log(f"  Created: {candidate_id} — appearance pending")
                except ValueError as e:
                    # Identity already exists (idempotency)
                    if "already exists" in str(e).lower():
                        resolved_ids.append(candidate_id)
                        resolved_identity_map[(char.name, vs)] = candidate_id
                        if on_log:
                            on_log(f"  Skipped: {candidate_id} already exists")
                    else:
                        if on_log:
                            on_log(f"  Error: {e}")
                        continue

                try:
                    await self._recover_identity_appearance(
                        char=char,
                        identity=identity,
                        visual_state=vs,
                        resolved_age_group=resolved_age_group,
                        explicit_age_group=explicit_age_group,
                        inferred_fish_voice=inferred_fish_voice,
                        reason=req.reason,
                        pending=True,
                        corrupted_fields={},
                        on_log=on_log,
                        output_language=output_language,
                    )
                except Exception as e:
                    if on_log:
                        on_log(
                            f"  Failed to save appearance ({candidate_id}): {e}; identity kept"
                        )

        return new_count, resolved_ids, resolved_identity_map

    def _find_matching_identity(
        self,
        char,
        visual_state: str,
        candidate_id: str,
    ) -> Optional[CharacterIdentity]:
        """Find a match among the character's existing identities (exact match only).

        In Phase 1 the AI saw the complete list of existing identities and was told to reuse the same names;
        outputting a different name means a new identity is needed. Substring/synonym fallbacks would cause false matches.
        """
        if not char.identities:
            return None

        # 1. Exact match on identity_id
        for ident in char.identities:
            if ident.identity_id == candidate_id:
                return ident

        # 2. Exact match on identity_name
        for ident in char.identities:
            if ident.identity_name == visual_state:
                return ident

        return None

    async def _generate_appearance(
        self,
        character_name: str,
        visual_state: str,
        planned_age_group: str,
        reason: str,
        on_log: Optional[Callable] = None,
        output_language: AssetLanguage | None = None,
    ) -> AppearanceDescription:
        """Use the AI to generate the identity's costume/styling description (with an optional face description)."""
        # Fetch the character's existing looks as reference (face_prompt is not sent, to avoid triggering safety filters)
        char = self.cognee_store.get_character(character_name)
        base_info = ""
        default_info = ""
        if char:
            # The character's default face, age group and body type — the AI compares them to decide whether to override
            default_parts = []
            if char.face_prompt:
                default_parts.append(f"Default facial features: {char.face_prompt}")
            if char.age_group:
                default_parts.append(f"Default age group: {char.age_group}")
            if char.body_type:
                default_parts.append(f"Default body type: {char.body_type}")
            if char.gender:
                default_parts.append(f"Gender: {char.gender}")
            if default_parts:
                default_info = "\n".join(default_parts) + "\n"
            if char.identities:
                existing_desc = "\n".join(
                    f"- {i.identity_name}: {i.appearance_details[:40]}"
                    for i in char.identities
                    if i.appearance_details
                )
                if existing_desc:
                    base_info = f"Existing look references:\n{existing_desc}\n"

        planned_age_info = ""
        if planned_age_group:
            planned_age_info = f"The age group of this identity was determined in the previous planning stage: {planned_age_group}\n"

        task = f"""Design a costume plan for the "{visual_state}" look of the fictional film/TV character "{character_name}".

{default_info}{base_info}{planned_age_info}
Story context: {reason}

Design a 20-40 word costume plan (style, fabric, accessories, hairstyle; excluding the person's physical features and expressions).

⚠️ Rules for face_description, age_group and body_type:
- If an "age group already determined" is given above, the output should stay consistent with it
- Fill these in only when the identity's age is **clearly different** from the character's default age group (e.g. childhood memory, elderly form)
- If the identity's age is the same as or close to the default above, face_description, age_group and body_type must be left empty
- face_description format: a 15-30 word face description (age traits, face shape, facial proportions; no clothing)
- body_type format: a short body type description (e.g. "small, round toddler build", "stooped, thin elderly build")
"""

        try:
            language = output_language or detect_asset_language(
                "\n".join((character_name, visual_state, reason))
            )
            language_instruction = asset_language_instruction(language)
            appearance_agent = Agent(
                self._identity_model("IDENTITY_PLANNER_APPEARANCE_MODEL"),
                system_prompt=(
                    f"{APPEARANCE_GENERATION_PROMPT}\n{language_instruction}"
                ),
                model_settings=self._identity_model_settings(),
                output_type=AppearanceDescription,
                retries={"output": 2},
                validation_context={"planned_age_group": planned_age_group},
            )
            ai_result = await appearance_agent.run(task)
            return ai_result.output
        except Exception as e:
            if on_log:
                on_log(
                    f"  Appearance generation failed ({character_name}/{visual_state}): {e}"
                )
            raise
