"""Asset Compiler — compiles the episode scene and prop assets, one SceneBlock at a time."""

from __future__ import annotations

import re
from typing import Any, Callable, Optional

from pydantic import BaseModel, Field, ValidationError, ValidationInfo, model_validator
from pydantic_ai import Agent
from pydantic_ai.exceptions import UnexpectedModelBehavior

from novelvideo.brainclaw_contract import BrainClawProfile
from novelvideo.config import (
    get_newapi_structured_output_model_settings,
    get_newapi_text_pydantic_model,
)
from novelvideo.model_gateway_runtime import model_gateway_output_retries
from novelvideo.models import (
    NovelProp,
    NovelScene,
    PropMenuItem,
    SceneMenuItem,
)
from novelvideo.sqlite_store import load_episode_planning_content
from novelvideo.cognee.screenplay_normalizer import (
    clean_scene_name_and_time,
    normalize_screenplay_scene_header,
    normalize_time_of_day,
)
from novelvideo.utils.derived_scenes import compose_derived_scene_name
from novelvideo.workflows.literal_script_writing import (
    LiteralScriptWritingWorkflow,
    SceneBlock,
    split_literal_source_text,
)


class DerivedSceneRequirement(BaseModel):
    label: str = Field(
        description="Derived-scene suffix, e.g. 'snow scene', 'post-battle', 'steam-filled'"
    )
    description: str = Field(
        default="",
        description="Short visual note for the derived scene, describing the stable visual features that set it apart from the base scene",
    )
    lighting: str = Field(
        default="",
        description="Lighting conditions specific to the derived scene; leave empty if none",
    )
    atmosphere: str = Field(
        default="",
        description="Atmosphere / weather / air quality specific to the derived scene; leave empty if none",
    )


PROP_OUTPUT_SCHEMA_HINT = (
    "Prop planning structured output validation failed: requirements must be an array of objects, "
    "each containing prop_name and visual_prompt; it must not be an array of strings; "
    "prop_name must come verbatim from the current scene block text or the candidate props"
)


class PropRequirement(BaseModel):
    prop_name: str = Field(
        description="Prop name; must be copied verbatim from the current scene block text or the candidate props, e.g. 'seven-star sword', 'jade pendant'; do not rewrite or substitute synonyms"
    )
    prop_type: str = Field(
        default="",
        description="Prop type: weapon / accessory / artifact / document / furniture",
    )
    owner: str = Field(default="", description="Owning character name (if any)")
    visual_prompt: str = Field(
        default="",
        description="Visual prompt used to generate the reference image; must state shape, material, color and recognizable details, within 80 words",
    )
    description: str = Field(
        default="",
        description="One-sentence narrative description (purpose / story relevance, within 50 words)",
    )


class BlockDerivedSceneOutput(BaseModel):
    derived_scenes: list[DerivedSceneRequirement] = Field(
        default_factory=list,
        description="Stable visual states in the current scene block that should be promoted to independent scenes",
    )


class BlockPropRequirements(BaseModel):
    requirements: list[PropRequirement] = Field(
        default_factory=list,
        description="Array of plot-relevant prop objects in the current scene block; every item must be an object, not a string list",
    )

    @model_validator(mode="after")
    def validate_props(self, info: ValidationInfo) -> "BlockPropRequirements":
        block_text = str((info.context or {}).get("block_text", "") or "")
        allowed_existing_names = {
            str(item or "").strip()
            for item in ((info.context or {}).get("allowed_existing_names") or set())
            if str(item or "").strip()
        }
        normalized: list[PropRequirement] = []
        seen: set[str] = set()
        for req in self.requirements:
            prop_name = str(req.prop_name or "").strip()
            if not prop_name or prop_name in seen:
                continue
            if prop_name not in allowed_existing_names and prop_name not in block_text:
                raise ValueError(
                    f"Prop name '{prop_name}' does not appear in the current scene block text"
                )
            seen.add(prop_name)
            normalized.append(req)
        self.requirements = normalized
        return self


class NarratedSceneRequirement(BaseModel):
    scene_name: str = Field(
        description="Base scene name; must be a reusable physical location"
    )
    scene_type: str = Field(
        default="interior", description="interior / exterior / nature"
    )
    aliases: list[str] = Field(
        default_factory=list,
        description="Natural aliases that appear in the source text",
    )
    description: str = Field(
        default="",
        description="One sentence on the role of this location in the episode",
    )
    evidence_lines: list[str] = Field(
        default_factory=list, description="Source-text evidence supporting this scene"
    )

    @model_validator(mode="after")
    def validate_scene(self, info: ValidationInfo) -> "NarratedSceneRequirement":
        source_text = str((info.context or {}).get("source_text", "") or "")
        existing_scene_names = {
            str(item or "").strip()
            for item in ((info.context or {}).get("existing_scene_names") or set())
            if str(item or "").strip()
        }
        self.scene_name = str(self.scene_name or "").strip()
        self.scene_type = AssetCompiler._normalize_scene_type(self.scene_type)
        self.aliases = [
            str(alias or "").strip()
            for alias in (self.aliases or [])
            if str(alias or "").strip()
        ]
        self.description = str(self.description or "").strip()
        self.evidence_lines = [
            str(line or "").strip()
            for line in (self.evidence_lines or [])
            if str(line or "").strip()
        ]
        if (
            source_text
            and self.scene_name
            and self.scene_name not in existing_scene_names
        ):
            tokens = [self.scene_name, *self.aliases]
            if not any(token and token in source_text for token in tokens):
                raise ValueError(
                    f"Scene name '{self.scene_name}' does not appear in the episode text"
                )
        return self


class NarratedScenePlanOutput(BaseModel):
    scenes: list[NarratedSceneRequirement] = Field(
        default_factory=list,
        description="Stable physical scenes from the narration draft / novel passages of this episode that should enter the 2.0 scene asset library",
    )


class BaseSceneReconcileDecision(BaseModel):
    action: str = Field(description="reuse / create / ignore")
    scene_name: str = Field(
        default="", description="Base scene name to create or reference"
    )
    matched_existing_name: str = Field(
        default="", description="Fill in when reusing an existing base scene"
    )
    scene_type: str = Field(
        default="interior", description="interior / exterior / nature"
    )
    aliases: list[str] = Field(
        default_factory=list,
        description="Natural aliases that appear in the source text",
    )
    description: str = Field(
        default="", description="One sentence describing this physical location"
    )
    evidence_lines: list[str] = Field(
        default_factory=list,
        description="Source-text evidence supporting this decision",
    )
    confidence: float = Field(default=0.0, description="Confidence from 0 to 1")

    @model_validator(mode="after")
    def normalize_action_and_type(self) -> "BaseSceneReconcileDecision":
        self.action = str(self.action or "").strip().lower()
        if self.action not in {"reuse", "create", "ignore"}:
            self.action = "ignore"
        self.scene_name = str(self.scene_name or "").strip()
        self.matched_existing_name = str(self.matched_existing_name or "").strip()
        self.scene_type = AssetCompiler._normalize_scene_type(self.scene_type)
        self.aliases = [
            str(alias or "").strip()
            for alias in (self.aliases or [])
            if str(alias or "").strip()
        ]
        self.description = str(self.description or "").strip()
        self.evidence_lines = [
            str(line or "").strip()
            for line in (self.evidence_lines or [])
            if str(line or "").strip()
        ]
        return self


class EpisodeBaseSceneReconcileOutput(BaseModel):
    scenes: list[BaseSceneReconcileDecision] = Field(
        default_factory=list,
        description="Reuse / create / ignore decisions for the base scenes in the episode text",
    )


BASE_SCENE_RECONCILE_PROMPT = """# You are the base-scene asset reconciler for a film/TV project

Task: given the episode text and the table of existing base scenes, decide whether each physical location in the text should reuse an existing base scene, create a new base scene, or be ignored.

Rules:
- Prefer reusing existing base scenes and their aliases. Do not create a new base scene because of changes in description, time of day, weather or condition.
- A base scene name must be a neutral physical location, such as "apartment building elevator lobby", "city street", "hospital corridor".
- Never put time of day, weather or condition (rainy night / daytime / dusk / leaking / after the explosion / messy / snow) into a base scene name; those are handled later by plate/variant planning.
- Concrete clock times and day-part words must not appear in a base scene name either, for example `11:47 PM`, `DAY`, `NIGHT`, `daytime`, `evening`.
- Only output create when the location is clearly a reusable physical place AND there is evidence in the source text.
- Generic terms such as "indoors", "exterior", "main scene of this episode", "roadside" are always ignore.
- evidence_lines must quote short sentences from the source text.
- Output structured results only; do not output explanatory prose.
"""


DERIVED_SCENE_PROMPT = """# You are a derived-scene analyst

Task: based on the current scene block text, decide whether the base scene shows a stable, reusable visual state in this episode that should be promoted to its own scene.

Rules:
- Only output stable visual states. Do not turn ordinary time of day, camera, shot size or camera position into separate scenes.
- Ordinary "day / night / dusk" belongs to time_of_day only; do not derive mechanically.
- However, if a change in lighting / weather / damage / furnishing is a stable plate that needs approval, is reused across shots, or serves as a video reference image, a derived scene may be output.
- Correct examples: steam-filled, snow scene, post-battle version, messy version, festival-decorated version
- Correct examples: rainstorm neon night version, blackout flashlight version, leaking cold-light version
- Incorrect examples: daytime, night, high angle, close-up, black screen, first person
- If there is none, output an empty list.
"""


BLOCK_PROP_PROMPT = """# You are a key-prop analyst for scene blocks

Task: based only on the current scene block text, extract the props that must be tracked as "the same object" across multiple shots.

## Core criteria
An object is worth listing as a prop if and only if:
- It is an **independent, movable physical object**
- It **appears repeatedly across multiple shots / description lines**, or **is picked up, handed over or operated by a character**
- Later shots need to draw "the same thing" to keep visual continuity

## What is NOT a prop
- **Fixed scene installations**: doors, windows, walls, lamps, giant screens, big displays, billboards, signboards, door locks, wall clocks,
  digital displays — these are part of the scene
- **Environment furnishings**: tables, chairs, stools, sofas, beds, cabinets, railings — unless a character explicitly picks them up or operates them
- **On-screen content**: movie subtitles, LOGOs, popups, prompt text, ad copy — this is picture content, not a physical object
- **Items that flash by in memories / TV / hallucinations**: test papers, paintbrushes, a broken paintbrush — unless they also appear as physical objects in the real scene
- **Effects / virtual elements**: a transparent hand, light effects, digital particles — unless it is an entity physically operated by a character
- **Food / disposable items**: cans, noodle bowls, chopsticks, napkins — gone once eaten, no cross-shot tracking needed

## Reuse rules
- Prefer reusing existing prop names and props already selected earlier in this episode
- A prop name must come from the current scene block text or the given candidate prop list

## Output rules
- requirements must be an array of objects; every element must contain prop_name / visual_prompt; it must not be an array of strings
- Never output `{{"requirements":["flashlight"]}}`
- Correct output example:
  `{{
    "requirements": [
      {{
        "prop_name": "tactical flashlight",
        "prop_type": "object",
        "owner": "Luke",
        "visual_prompt": "black metal tactical flashlight, cold white beam, scratches and wear along the barrel",
        "description": "Luke uses it to light the basement and look for a hidden compartment"
      }}
    ]
  }}`
- Every prop must have a visual_prompt; do not just state its use, write an appearance that can be drawn
- description states the story purpose; it may be left empty if there is no clear purpose
- prop_name must be copied verbatim from the current scene block text or the candidate props; do not rewrite, generalize or add synonyms. If the source says "tactical flashlight", do not write "torch"
"""


NARRATED_SCENE_PROMPT = """# You are a scene-asset planner for narrated dramas

Task: from one episode of novel source text or a line-by-line narration working draft, extract the stable physical scenes that should enter the project asset library.

Rules:
- Only extract reusable places / spaces, such as a hospital corridor, a rented-room living room, a mountain road, a city gate
- Do not turn emotions, camera work, events or character relationships into scenes
- Do not output generic names such as "main scene of this episode", "indoors", "exterior"
- Output each physical location only once; keep the concrete anchor of the original name where possible
- scene_type may only be interior / exterior / nature
- evidence_lines should contain only short sentences from the source text that support the scene
- The output is the 2.0 NovelScene concept; it does not involve the legacy scene_registry or anchor.png
"""


BACKGROUND_PROP_DENYLIST = {
    # Environment furnishings
    "table",
    "chair",
    "stool",
    "door",
    "window",
    "lamp",
    "wall",
    "floor",
    "ceiling",
    "sofa",
    "bed",
    "cabinet",
    "shelf",
    "stairs",
    "railing",
    "folding screen",
    "bookshelf",
    "rack",
    # Fixed scene installations
    "wall clock",
    "door lock",
    "doorbell",
    "elevator",
    "digital display",
    "display",
    "street lamp",
    "billboard",
    "signboard",
    "sign",
    "3d screen",
    "big screen",
    "giant screen",
    # Food / disposable items
    "can",
    "bowl",
    "chopsticks",
    "cup",
    "teacup",
    "napkin",
    "napkin box",
    "plate",
    # On-screen content
    "movie subtitles",
    "logo",
    "subtitles",
    "caption",
    "slogan",
    # One-off elements from memories / hallucinations
    "broken paintbrush",
    "paintbrush",
    "test paper",
    # Effects / virtual elements
    "transparent hand",
}

NON_PROP_KEYWORDS = (
    "subtitle",
    "logo",
    "caption",
    "slogan",
    "prompt text",
    "ad copy",
    "popup",
    "giant screen",
    "big screen",
    "display",
    "screen content",
    "signboard",
    "billboard",
    "transparent hand",
    "light effect",
    "particle",
)


async def enrich_scene_environment_from_context(**kwargs) -> NovelScene:
    from novelvideo.cognee.pipeline import (
        enrich_scene_environment_from_context as enrich,
    )

    return await enrich(**kwargs)


INTERACTION_VERBS = (
    "take",
    "hand",
    "look",
    "open",
    "close",
    "throw",
    "hold",
    "carry",
    "drag",
    "pull",
    "push",
    "grab",
    "pick up",
    "put down",
    "pass",
    "give",
    "operate",
    "stare",
    "point",
    "grip",
    "clutch",
    "toss",
    "lift",
    "press",
    "slam",
    "hug",
)


class AssetCompiler:
    """Compile the episode scene and prop assets, one SceneBlock at a time."""

    def __init__(self, cognee_store: Any):
        self.cognee_store = cognee_store
        # Reads that need no graph go straight to SQLite. Accepting either a
        # CogneeStore or a SQLiteStore keeps legacy callers working while
        # structured callers pass SQLiteStore directly.
        self.store = getattr(cognee_store, "sqlite_store", cognee_store)
        self.spine_template = "drama"

    async def _write_menus(self, episode_number: int, **menus: Any) -> None:
        """Persist episode menus with a column-level write.

        Scene, prop and identity planning run at once for the same episode. Any
        whole-row write re-serialises the menus this planner loaded earlier, so
        a menu written meanwhile is lost. Writing only the named columns removes
        that race rather than narrowing it.

        Both tracks take this route: the normalization behind it is the same
        code the legacy whole-row write uses, so an existing project's menus
        come out byte-identical.
        """
        await self.store.patch_episode(episode_number, **menus)

    async def compile_single_episode(
        self,
        episode: Any,
        on_log: Optional[Callable[[str], None]] = None,
        on_progress: Optional[Callable[[float, str], None]] = None,
    ) -> tuple[list[SceneMenuItem], list[PropMenuItem], int]:
        """Legacy entry point: compile scenes and props in one go. New UI should prefer the split entry points."""

        def log(message: str) -> None:
            if on_log:
                on_log(message)

        def report(progress: float, task: str) -> None:
            if on_progress:
                on_progress(progress, task)

        source_text = await self._load_source_text(episode)
        if not source_text.strip():
            raise ValueError(
                "The current episode source text is empty; cannot compile assets"
            )

        lines = split_literal_source_text(source_text)
        if not lines:
            raise ValueError("The source text cannot be split into valid lines")

        scene_blocks = LiteralScriptWritingWorkflow._build_scene_blocks(lines)
        if not scene_blocks:
            raise ValueError("The source text cannot be split into valid scene blocks")

        report(0.05, "Parsing scene blocks...")
        log(f"[AssetCompiler] Identified {len(scene_blocks)} scene blocks")

        report(0.12, "AI reconciling base scenes...")
        await self._reconcile_base_scenes_from_text(source_text, episode, log)

        report(0.2, "Compiling scene assets...")
        scene_menu, pending_scenes = await self._compile_scenes(
            scene_blocks, episode, log
        )
        if not scene_menu:
            report(0.3, "Planning scene assets from the narration draft...")
            scene_menu, pending_scenes = await self._compile_narrated_scenes(
                source_text, episode, log
            )
        if not scene_menu:
            raise ValueError(
                "No scenes were identified; generate the line-by-line narration draft first or add scene locations"
            )

        report(0.55, "Compiling prop assets...")
        prop_menu = await self._compile_props(scene_blocks, episode, log)

        report(0.9, "Writing episode assets...")
        for scene in pending_scenes:
            await self.store.add_scene(scene)
        await self._write_menus(
            episode.number,
            scene_menu=scene_menu,
            prop_menu=prop_menu,
        )

        report(1.0, "Done")
        return scene_menu, prop_menu, len(pending_scenes)

    async def compile_episode_scenes(
        self,
        episode: Any,
        on_log: Optional[Callable[[str], None]] = None,
        on_progress: Optional[Callable[[float, str], None]] = None,
    ) -> tuple[list[SceneMenuItem], int]:
        """Compile and write only this episode's scene_menu without overwriting prop_menu."""

        def log(message: str) -> None:
            if on_log:
                on_log(message)

        def report(progress: float, task: str) -> None:
            if on_progress:
                on_progress(progress, task)

        source_text = await self._load_source_text(episode)
        if str(self.spine_template or "drama").strip() == "narrated":
            report(0.2, "Planning scene assets from the narration draft...")
            scene_menu, pending_scenes = await self._compile_narrated_scenes(
                source_text, episode, log
            )
        else:
            report(0.08, "Parsing episode script scenes...")
            scene_blocks = await self._load_scene_blocks(episode)
            has_scene_headers = any(
                str(block.header_line or "").strip() for block in scene_blocks
            )
            if not has_scene_headers:
                log(
                    "[AssetCompiler] No valid scene headers were found in this drama episode; "
                    "falling back to semantic scene planning from the body text; the project type stays drama."
                )
                report(0.2, "Planning scene assets semantically from the body text...")
                scene_menu, pending_scenes = await self._compile_narrated_scenes(
                    source_text, episode, log
                )
            else:
                report(0.1, "AI verifying scene metadata scene by scene...")
                scene_blocks = await self._normalize_scene_block_headers(
                    scene_blocks, log
                )
                log(f"[AssetCompiler] Identified {len(scene_blocks)} scene blocks")

                report(0.18, "AI reconciling base scenes...")
                await self._reconcile_base_scenes_from_text(source_text, episode, log)

                report(0.25, "Compiling scene assets...")
                scene_menu, pending_scenes = await self._compile_scenes(
                    scene_blocks,
                    episode,
                    log,
                )
        if not scene_menu:
            raise ValueError(
                "No scenes were identified; generate the line-by-line narration draft first or add scene locations"
            )

        report(0.85, "Writing episode scene plan...")
        for scene in pending_scenes:
            await self.store.add_scene(scene)
        await self._write_menus(episode.number, scene_menu=scene_menu)

        report(1.0, "Done")
        return scene_menu, len(pending_scenes)

    async def _normalize_scene_block_headers(
        self,
        scene_blocks: list[SceneBlock],
        log: Callable[[str], None],
    ) -> list[SceneBlock]:
        """Normalize one parsed scene at a time while preserving local body data."""

        normalized_blocks: list[SceneBlock] = []
        for index, block in enumerate(scene_blocks, start=1):
            header_line = str(block.header_line or "").strip()
            if not header_line:
                continue
            try:
                normalized = await normalize_screenplay_scene_header(
                    header_line,
                    location_hint=block.location,
                    time_of_day_hint=block.time_of_day,
                    interior_exterior_hint=block.interior_exterior,
                    context_lines=block.lines,
                )
            except Exception as exc:
                log(f"  AI normalization of scene header #{index} failed: {exc}")
                raise ValueError(
                    f"AI normalization of scene header #{index} failed; please retry"
                ) from exc
            if not normalized:
                raise ValueError(
                    f"AI did not recognize a valid scene header for scene #{index}; check the episode script and retry"
                )
            normalized_blocks.append(
                SceneBlock(
                    header_line=block.header_line,
                    location=normalized.location,
                    time_of_day=normalize_time_of_day(normalized.time_of_day),
                    interior_exterior=normalized.interior_exterior,
                    characters=list(block.characters),
                    lines=list(block.lines),
                )
            )
        if not normalized_blocks:
            raise ValueError(
                "AI did not recognize any valid scene; check the episode script and retry"
            )
        return normalized_blocks

    async def compile_episode_props(
        self,
        episode: Any,
        on_log: Optional[Callable[[str], None]] = None,
        on_progress: Optional[Callable[[float, str], None]] = None,
    ) -> list[PropMenuItem]:
        """Compile and write only this episode's prop_menu without overwriting scene_menu."""

        def log(message: str) -> None:
            if on_log:
                on_log(message)

        def report(progress: float, task: str) -> None:
            if on_progress:
                on_progress(progress, task)

        scene_blocks = await self._load_scene_blocks(episode)
        report(0.1, "Parsing scene blocks...")
        log(f"[AssetCompiler] Identified {len(scene_blocks)} scene blocks")

        report(0.25, "Compiling prop assets...")
        prop_menu = await self._compile_props(scene_blocks, episode, log)

        report(0.9, "Writing episode prop plan...")
        await self._write_menus(episode.number, prop_menu=prop_menu)

        report(1.0, "Done")
        return prop_menu

    async def _reconcile_base_scenes_from_text(
        self,
        source_text: str,
        episode: Any,
        log: Callable[[str], None],
    ) -> list[str]:
        source_text = str(source_text or "").strip()
        if not source_text:
            return []
        existing_scenes = await self.store.list_scenes()
        base_scenes = [
            scene
            for scene in existing_scenes
            if not str(getattr(scene, "base_scene_id", "") or "").strip()
        ]
        existing_lines: list[str] = []
        for scene in base_scenes:
            aliases = ", ".join(getattr(scene, "aliases", []) or [])
            prompt = str(
                getattr(scene, "environment_prompt", "")
                or getattr(scene, "description", "")
                or ""
            ).strip()
            parts = [str(getattr(scene, "name", "") or "").strip()]
            if aliases:
                parts.append(f"aliases: {aliases}")
            scene_type = str(getattr(scene, "scene_type", "") or "").strip()
            if scene_type:
                parts.append(f"type: {scene_type}")
            if prompt:
                parts.append(f"description: {prompt[:120]}")
            existing_lines.append("; ".join(part for part in parts if part))

        agent = Agent(
            get_newapi_text_pydantic_model(
                "EPISODE_SCENE_RECONCILE_MODEL",
                brainclaw_profile=BrainClawProfile.EPISODE_SCENE_RECONCILIATION,
                capability="text.generate.agent",
            ),
            system_prompt=BASE_SCENE_RECONCILE_PROMPT,
            model_settings=get_newapi_structured_output_model_settings(),
            output_type=EpisodeBaseSceneReconcileOutput,
            output_retries=model_gateway_output_retries(2),
            name="Base scene asset reconciler",
        )
        result = await agent.run(f"""## Existing base scenes
{chr(10).join(existing_lines) if existing_lines else "(none)"}

## Episode {episode.number} text
{source_text}
""")
        return await self._apply_base_scene_reconcile_output(
            result.output, source_text, episode, log
        )

    async def _apply_base_scene_reconcile_output(
        self,
        output: EpisodeBaseSceneReconcileOutput,
        source_text: str,
        episode: Any,
        log: Callable[[str], None],
    ) -> list[str]:
        created: list[str] = []
        generic_names = {
            "interior",
            "indoors",
            "exterior",
            "outdoors",
            "roadside",
            "street side",
            "main scene",
            "main scene of this episode",
        }
        for decision in output.scenes:
            if decision.action != "create":
                continue
            scene_name, _ = clean_scene_name_and_time(decision.scene_name)
            if not scene_name or scene_name.lower() in generic_names:
                continue
            if await self._find_existing_base_scene_by_name_or_alias(
                [scene_name, decision.matched_existing_name, *(decision.aliases or [])]
            ):
                continue
            evidence_lines = [
                str(line or "").strip()
                for line in (decision.evidence_lines or [])
                if str(line or "").strip()
            ]
            if not evidence_lines:
                continue
            if source_text and not any(line in source_text for line in evidence_lines):
                continue
            scene = await enrich_scene_environment_from_context(
                scene_name=scene_name,
                scene_type=decision.scene_type,
                context_lines=evidence_lines,
            )
            scene.aliases = list(
                dict.fromkeys(
                    str(alias or "").strip()
                    for alias in (decision.aliases or [])
                    if str(alias or "").strip()
                    and str(alias or "").strip() != scene_name
                )
            )
            if decision.description and not str(scene.description or "").strip():
                scene.description = decision.description
            scene.notes = (
                f"Created by AssetCompiler AI reconciliation (ep{episode.number})"
            )
            await self.store.add_scene(scene)
            created.append(scene.name)
            log(f"  AI completed base scene: {scene.name}")
        return created

    async def _find_existing_base_scene_by_name_or_alias(
        self,
        names: list[str],
    ) -> NovelScene | None:
        """Return an existing base scene when any candidate matches a name or alias."""

        candidates = [
            str(name or "").strip() for name in (names or []) if str(name or "").strip()
        ]
        for name in candidates:
            scene = await self.store.get_scene(name)
            if scene:
                return scene

        candidate_set = set(candidates)
        all_scenes = await self.store.list_scenes()
        for scene in all_scenes:
            if str(getattr(scene, "base_scene_id", "") or "").strip():
                continue
            tokens = [
                str(getattr(scene, "name", "") or "").strip(),
                *[
                    str(alias or "").strip()
                    for alias in (getattr(scene, "aliases", []) or [])
                ],
            ]
            if any(token and token in candidate_set for token in tokens):
                return scene
        return None

    async def _load_scene_blocks(self, episode: Any) -> list[SceneBlock]:
        source_text = await self._load_source_text(episode)
        if not source_text.strip():
            raise ValueError(
                "The current episode source text is empty; cannot compile assets"
            )

        lines = split_literal_source_text(source_text)
        if not lines:
            raise ValueError("The source text cannot be split into valid lines")

        scene_blocks = LiteralScriptWritingWorkflow._build_scene_blocks(lines)
        if not scene_blocks:
            raise ValueError("The source text cannot be split into valid scene blocks")

        return scene_blocks

    async def _load_source_text(self, episode: Any) -> str:
        return await load_episode_planning_content(self.store, episode)

    async def _compile_scenes(
        self,
        scene_blocks: list[SceneBlock],
        episode: Any,
        log: Callable[[str], None],
    ) -> tuple[list[SceneMenuItem], list[NovelScene]]:
        scene_menu: list[SceneMenuItem] = []
        seen_scene_ids: set[str] = set()
        pending_scenes: list[NovelScene] = []
        pending_scene_map: dict[str, NovelScene] = {}
        time_plate_counts = self._time_plate_counts(scene_blocks)

        for block in scene_blocks:
            location = str(block.location or "").strip()
            if not location:
                continue

            existing = pending_scene_map.get(
                location
            ) or await self._find_matching_scene(location)
            if not existing:
                log(
                    f"  Skipping missing base scene: {location} (AI reconciliation neither created nor reused it)"
                )
                continue
            else:
                existing = await self._enrich_scene_prompt_from_block(
                    existing,
                    block,
                    episode,
                    persist=True,
                    log=log,
                )

            derived_requirements = await self._analyze_derived_scenes(
                existing.name, block
            )
            normalized_derived = self._build_derived_scene_specs(derived_requirements)
            self._add_to_scene_menu(existing.name, scene_menu, seen_scene_ids)
            for scene_time, count in sorted(
                time_plate_counts.get(location, {}).items()
            ):
                if count < 2:
                    continue
                time_plate = self._build_time_plate_scene(existing, scene_time, episode)
                existing_time_plate = pending_scene_map.get(
                    time_plate.name
                ) or await self.store.get_scene(time_plate.name)
                if not existing_time_plate:
                    pending_scene_map[time_plate.name] = time_plate
                    pending_scenes.append(time_plate)
                self._add_to_scene_menu(
                    time_plate.name,
                    scene_menu,
                    seen_scene_ids,
                    base_scene_id=existing.name,
                    time_of_day=scene_time,
                )
            for requirement in normalized_derived:
                derived_scene = self._build_derived_scene(existing, requirement)
                existing_derived = pending_scene_map.get(
                    derived_scene.name
                ) or await self.store.get_scene(derived_scene.name)
                if not existing_derived:
                    pending_scene_map[derived_scene.name] = derived_scene
                    pending_scenes.append(derived_scene)
                self._add_to_scene_menu(
                    derived_scene.name,
                    scene_menu,
                    seen_scene_ids,
                    base_scene_id=existing.name,
                    variant_id=requirement.label,
                )
            extra = (
                f" ({len(normalized_derived)} derived scenes)"
                if normalized_derived
                else ""
            )
            log(f"  Scene: {existing.name}{extra}")

        return scene_menu, pending_scenes

    async def _compile_narrated_scenes(
        self,
        source_text: str,
        episode: Any,
        log: Callable[[str], None],
    ) -> tuple[list[SceneMenuItem], list[NovelScene]]:
        scene_menu: list[SceneMenuItem] = []
        seen_scene_ids: set[str] = set()
        pending_scenes: list[NovelScene] = []
        pending_scene_map: dict[str, NovelScene] = {}

        scenes = await self._extract_narrated_episode_scenes(source_text, episode, log)
        for scene in scenes:
            scene_name = str(getattr(scene, "name", "") or "").strip()
            if not scene_name:
                continue
            existing = pending_scene_map.get(
                scene_name
            ) or await self._find_matching_scene(scene_name)
            canonical_name = scene_name
            if existing:
                canonical_name = existing.name
                if not str(getattr(existing, "environment_prompt", "") or "").strip():
                    await self.store.update_scene(
                        existing.name,
                        scene_type=scene.scene_type or existing.scene_type,
                        environment_prompt=scene.environment_prompt,
                        description=scene.description or existing.description,
                    )
                    log(
                        f"  Filled in narrated scene environment description: {existing.name}"
                    )
            else:
                pending_scenes.append(scene)
                pending_scene_map[scene.name] = scene
                log(f"  Created narrated scene: {scene.name}")
            self._add_to_scene_menu(canonical_name, scene_menu, seen_scene_ids)
            log(f"  Scene: {canonical_name}")

        return scene_menu, pending_scenes

    async def _extract_narrated_episode_scenes(
        self,
        source_text: str,
        episode: Any,
        log: Callable[[str], None],
    ) -> list[NovelScene]:
        source_text = str(source_text or "").strip()
        if not source_text:
            return []

        requirements = await self._analyze_narrated_scene_requirements(
            source_text, episode, log
        )
        if not requirements:
            requirements = self._heuristic_narrated_scene_requirements(source_text)
        if not requirements:
            return []

        source_lines = split_literal_source_text(source_text)
        scenes: list[NovelScene] = []
        seen: set[str] = set()
        for req in requirements[:8]:
            scene_name = str(req.scene_name or "").strip()
            if not scene_name or scene_name in seen:
                continue
            seen.add(scene_name)
            context_lines = [
                line for line in req.evidence_lines if str(line or "").strip()
            ]
            if not context_lines:
                context_lines = source_lines[:12]
            scene_type = self._normalize_scene_type(req.scene_type)
            enriched = await enrich_scene_environment_from_context(
                scene_name=scene_name,
                aliases=req.aliases,
                scene_type=scene_type,
                interior=scene_type == "interior",
                episodes=[int(getattr(episode, "number", 1) or 1)],
                context_lines=context_lines,
                synopsis=str(getattr(episode, "content_summary", "") or ""),
            )
            if not str(enriched.description or "").strip():
                enriched.description = str(req.description or "").strip()
            enriched.notes = (
                str(enriched.notes or "").strip()
                or f"Auto-created by AssetCompiler from the narration draft (ep{episode.number})"
            )
            scenes.append(enriched)

        return scenes

    async def _analyze_narrated_scene_requirements(
        self,
        source_text: str,
        episode: Any,
        log: Callable[[str], None],
    ) -> list[NarratedSceneRequirement]:
        existing_scenes = await self.store.list_scenes()
        existing_scene_names = {
            str(getattr(scene, "name", "") or "").strip()
            for scene in existing_scenes
            if str(getattr(scene, "name", "") or "").strip()
        }
        excerpt = source_text[:12000]
        task = f"""Plan the 2.0 scene assets for the current episode.

## Episode
Episode {getattr(episode, "number", "")} {getattr(episode, "title", "") or ""}

## Existing scene assets
{", ".join(sorted(existing_scene_names)) if existing_scene_names else "(none)"}

## Episode text
{excerpt}
"""
        agent = Agent(
            get_newapi_text_pydantic_model(
                "NARRATED_SCENE_ASSET_MODEL",
                brainclaw_profile=BrainClawProfile.NARRATED_SCENE_ASSET_PLANNING,
                capability="text.generate.agent",
            ),
            system_prompt=NARRATED_SCENE_PROMPT,
            model_settings=get_newapi_structured_output_model_settings(),
            output_type=NarratedScenePlanOutput,
            output_retries=model_gateway_output_retries(2),
            validation_context={
                "source_text": source_text,
                "existing_scene_names": existing_scene_names,
            },
            name="Narrated-drama scene asset planner",
        )
        try:
            result = await agent.run(task)
            return list(result.output.scenes or [])
        except Exception as exc:
            log(f"  Narrated scene analysis failed; falling back to text rules: {exc}")
            return []

    async def _enrich_scene_prompt_from_block(
        self,
        scene: NovelScene,
        block: SceneBlock,
        episode: Any,
        *,
        persist: bool,
        log: Callable[[str], None],
    ) -> NovelScene:
        if str(scene.environment_prompt or "").strip():
            return scene

        enriched = await enrich_scene_environment_from_context(
            scene_name=scene.name,
            aliases=scene.aliases,
            scene_type=scene.scene_type,
            time_of_day=str(getattr(block, "time_of_day", "") or ""),
            interior=str(getattr(block, "interior_exterior", "") or "int") != "ext",
            episodes=[int(getattr(episode, "number", 1) or 1)],
            characters=list(getattr(block, "characters", []) or []),
            context_lines=list(getattr(block, "lines", []) or []),
        )
        scene.scene_type = enriched.scene_type or scene.scene_type
        scene.environment_prompt = enriched.environment_prompt
        if str(enriched.description or "").strip():
            scene.description = enriched.description

        if persist:
            await self.store.update_scene(
                scene.name,
                scene_type=scene.scene_type,
                environment_prompt=scene.environment_prompt,
                description=scene.description,
            )
            log(f"  Filled in scene environment description: {scene.name}")

        return scene

    async def _analyze_derived_scenes(
        self,
        scene_name: str,
        block: SceneBlock,
    ) -> list[DerivedSceneRequirement]:
        content_lines = [line for line in block.lines if str(line or "").strip()]
        has_env_desc = any(
            str(line or "").strip().startswith("△") for line in content_lines
        )
        if len(content_lines) < 3 and not has_env_desc:
            return []
        block_text = "\n".join(content_lines)
        if not block_text:
            return []
        task = f"""Analyze the visual states of scene `{scene_name}` in the current scene block.

## Scene header
{block.header_line or "none"}

## Current scene block text
{block_text}
"""
        agent = Agent(
            get_newapi_text_pydantic_model(
                "EPISODE_SCENE_PLANNER_MODEL",
                brainclaw_profile=BrainClawProfile.EPISODE_SCENE_PLANNING,
                capability="text.generate.agent",
            ),
            system_prompt=DERIVED_SCENE_PROMPT,
            model_settings=get_newapi_structured_output_model_settings(),
            output_type=BlockDerivedSceneOutput,
            output_retries=model_gateway_output_retries(2),
            name="Derived scene analyst",
        )
        result = await agent.run(task)
        return result.output.derived_scenes

    async def _compile_props(
        self,
        scene_blocks: list[SceneBlock],
        episode: Any,
        log: Callable[[str], None],
    ) -> list[PropMenuItem]:
        prop_menu: list[PropMenuItem] = []
        seen_prop_ids: set[str] = set()
        existing_props = await self.store.list_props()
        episode_selected_props: dict[str, str] = {}

        for block_index, block in enumerate(scene_blocks):
            block_text = "\n".join(
                item
                for item in [block.header_line, *block.lines]
                if str(item or "").strip()
            )
            if not block_text.strip():
                continue

            preselected = self._preselect_existing_props(block_text, existing_props)
            prior_reuse = self._prior_selected_props_in_block(
                block, episode_selected_props
            )
            if prior_reuse and self._is_short_prior_prop_reuse_block(
                block, preselected
            ):
                requirements = prior_reuse
            else:
                try:
                    requirements = await self._analyze_block_props(
                        block,
                        preselected,
                        sorted(set(episode_selected_props.values())),
                    )
                except ValueError as exc:
                    log(f"  Prop [{block_index + 1}]: {exc}")
                    raise
            requirements = self._filter_background_props(requirements, block_text)
            for req in requirements:
                existing = await self._find_matching_prop(req.prop_name)
                if existing:
                    prop_id = existing.name
                    source = "reused"
                else:
                    prop_id = self._match_selected_prop(
                        req.prop_name, episode_selected_props
                    )
                    source = "episode-reused" if prop_id else "episode-local"
                prop_id = prop_id or str(req.prop_name or "").strip()
                if not prop_id:
                    continue
                episode_selected_props[str(req.prop_name or "").strip()] = prop_id
                episode_selected_props[prop_id] = prop_id
                self._add_to_prop_menu(prop_id, prop_menu, seen_prop_ids, existing, req)
                log(f"  Prop [{block_index + 1}]: {prop_id} [{source}]")

        return prop_menu

    @classmethod
    def _prior_selected_props_in_block(
        cls,
        block: SceneBlock,
        episode_selected_props: dict[str, str],
    ) -> list[PropRequirement]:
        block_text = "\n".join(
            item
            for item in [block.header_line, *block.lines]
            if str(item or "").strip()
        )
        result: list[PropRequirement] = []
        seen: set[str] = set()
        prior_ids = sorted(
            {
                value
                for value in episode_selected_props.values()
                if str(value or "").strip()
            }
        )
        for prop_id in prior_ids:
            if prop_id in seen:
                continue
            if cls._contains_text(block_text, prop_id) or cls._contains_text(
                prop_id, block_text
            ):
                seen.add(prop_id)
                result.append(PropRequirement(prop_name=prop_id))
        return result

    @staticmethod
    def _is_short_prior_prop_reuse_block(
        block: SceneBlock,
        preselected: list[NovelProp],
    ) -> bool:
        content_lines = [line for line in block.lines if str(line or "").strip()]
        has_env_desc = any(
            str(line or "").strip().startswith("△") for line in content_lines
        )
        return len(content_lines) <= 3 and not has_env_desc and not preselected

    def _preselect_existing_props(
        self,
        block_text: str,
        existing_props: list[NovelProp],
    ) -> list[NovelProp]:
        result: list[NovelProp] = []
        seen: set[str] = set()
        for prop in existing_props:
            name = str(prop.name or "").strip()
            if not name or name in seen:
                continue
            tokens = [name, *(prop.aliases or [])]
            if any(
                LiteralScriptWritingWorkflow._contains_text(block_text, token)
                for token in tokens
                if str(token or "").strip()
            ):
                seen.add(name)
                result.append(prop)
        return result

    async def _analyze_block_props(
        self,
        block: SceneBlock,
        preselected: list[NovelProp],
        prior_selected_prop_ids: list[str],
    ) -> list[PropRequirement]:
        block_text = "\n".join(
            item
            for item in [block.header_line, *block.lines]
            if str(item or "").strip()
        )
        content_lines = [line for line in block.lines if str(line or "").strip()]
        has_env_desc = any(
            str(line or "").strip().startswith("△") for line in content_lines
        )
        if (
            len(content_lines) < 2
            and not preselected
            and not prior_selected_prop_ids
            and not has_env_desc
        ):
            return []
        candidate_lines = []
        allowed_existing_names: set[str] = set()
        for prop in preselected:
            candidate_lines.append(f"- {prop.name}")
            allowed_existing_names.add(str(prop.name or "").strip())
            for alias in prop.aliases or []:
                alias_text = str(alias or "").strip()
                if alias_text:
                    allowed_existing_names.add(alias_text)
        if prior_selected_prop_ids:
            candidate_lines.append("## Props already selected earlier in this episode")
            for prop_id in prior_selected_prop_ids:
                candidate_lines.append(f"- {prop_id}")
                allowed_existing_names.add(str(prop_id or "").strip())

        candidate_section = (
            "\n".join(candidate_lines)
            if candidate_lines
            else "(no pre-screened candidates)"
        )
        task = f"""Analyze the key props in the current scene block.

## Scene header
{block.header_line or "none"}

## Current scene block text
{block_text}

## Pre-screened matching existing props
{candidate_section}
"""
        agent = Agent(
            get_newapi_text_pydantic_model(
                "EPISODE_PROP_PLANNER_MODEL",
                brainclaw_profile=BrainClawProfile.EPISODE_PROP_PLANNING,
                capability="text.generate.agent",
            ),
            system_prompt=BLOCK_PROP_PROMPT,
            model_settings=get_newapi_structured_output_model_settings(),
            output_type=BlockPropRequirements,
            output_retries=model_gateway_output_retries(2),
            validation_context={
                "block_text": block_text,
                "allowed_existing_names": allowed_existing_names,
            },
            name="Scene block prop analyst",
        )
        try:
            result = await agent.run(task)
        except (UnexpectedModelBehavior, ValidationError) as exc:
            raise ValueError(
                f"{PROP_OUTPUT_SCHEMA_HINT}; original error: {exc}"
            ) from exc
        return result.output.requirements

    @classmethod
    def _has_interaction_evidence(cls, prop_name: str, block_text: str) -> bool:
        name = str(prop_name or "").strip()
        if not name:
            return False
        lines = [
            str(line or "").strip()
            for line in block_text.splitlines()
            if str(line or "").strip()
        ]
        for line in lines:
            for verb in INTERACTION_VERBS:
                escaped_name = re.escape(name)
                escaped_verb = re.escape(verb)
                if re.search(
                    rf"{escaped_name}.{{0,40}}\b{escaped_verb}\w*",
                    line,
                    re.IGNORECASE,
                ):
                    return True
                if re.search(
                    rf"\b{escaped_verb}\w*.{{0,40}}{escaped_name}",
                    line,
                    re.IGNORECASE,
                ):
                    return True
        return False

    @classmethod
    def _filter_background_props(
        cls,
        requirements: list[PropRequirement],
        block_text: str,
    ) -> list[PropRequirement]:
        filtered: list[PropRequirement] = []
        for req in requirements:
            name = str(req.prop_name or "").strip()
            if not name:
                continue
            if any(token in name.lower() for token in NON_PROP_KEYWORDS):
                continue
            if (
                name.lower() in BACKGROUND_PROP_DENYLIST
                and not cls._has_interaction_evidence(name, block_text)
            ):
                continue
            filtered.append(req)
        return filtered

    @classmethod
    def _match_selected_prop(
        cls, prop_name: str, episode_selected_props: dict[str, str]
    ) -> str:
        normalized_name = str(prop_name or "").strip()
        if not normalized_name:
            return ""
        exact = episode_selected_props.get(normalized_name, "")
        if exact:
            return exact
        canonical_ids = sorted(
            {
                value
                for value in episode_selected_props.values()
                if str(value or "").strip()
            }
        )
        for canonical in canonical_ids:
            if cls._contains_text(canonical, normalized_name) or cls._contains_text(
                normalized_name, canonical
            ):
                return canonical
        return ""

    @staticmethod
    def _contains_text(haystack: str, needle: str) -> bool:
        return LiteralScriptWritingWorkflow._contains_text(haystack, needle)

    @staticmethod
    def _normalize_scene_type(value: str) -> str:
        normalized = str(value or "").strip().lower()
        if normalized in {"exterior", "ext", "outdoor", "outdoors", "outside"}:
            return "exterior"
        if normalized in {"nature", "natural", "wilderness", "outdoors nature"}:
            return "nature"
        return "interior"

    @classmethod
    def _guess_scene_type_from_name(cls, name: str) -> str:
        lowered = str(name or "").lower()
        if any(
            token in lowered
            for token in (
                "mountain",
                "forest",
                "river",
                "lake",
                "sea",
                "valley",
                "wilderness",
            )
        ):
            return "nature"
        if any(
            token in lowered
            for token in (
                "street",
                "road",
                "alley",
                "square",
                "plaza",
                "dock",
                "city gate",
                "highway",
            )
        ):
            return "exterior"
        return "interior"

    @classmethod
    def _heuristic_narrated_scene_requirements(
        cls,
        source_text: str,
    ) -> list[NarratedSceneRequirement]:
        suffixes = (
            "nurses station",
            "emergency room",
            "meeting room",
            "office",
            "elevator lobby",
            "apartment",
            "cafe",
            "hallway",
            "corridor",
            "stairwell",
            "living room",
            "bedroom",
            "study",
            "kitchen",
            "hospital ward",
            "doorway",
            "street corner",
            "alley",
            "mountain road",
            "highway",
            "courtyard",
            "great hall",
            "square",
            "plaza",
            "dock",
            "train station",
            "airport",
            "bar",
            "restaurant",
            "rooftop",
            "school",
            "hospital",
            "police station",
            "villa",
            "palace",
            "city gate",
            "valley",
            "forest",
            "riverbank",
        )
        suffix_pattern = "|".join(
            re.escape(suffix) for suffix in sorted(suffixes, key=len, reverse=True)
        )
        pattern = re.compile(
            rf"\b(?:[A-Za-z][A-Za-z'\-]*\s+){{0,2}}(?:{suffix_pattern})(?:\s+(?:{suffix_pattern}))?\b",
            re.IGNORECASE,
        )
        seen: set[str] = set()
        requirements: list[NarratedSceneRequirement] = []
        for line in split_literal_source_text(source_text):
            text = str(line or "").strip()
            if not text:
                continue
            for match in pattern.finditer(text):
                name = match.group(0).strip(",.!?;: ")
                name = re.sub(
                    r"^(?:.*\s)?(?:into|to|at|in|through|from|the|a|an)\s+",
                    "",
                    name,
                    flags=re.IGNORECASE,
                ).strip(",.!?;: ")
                if len(name) < 2 or name.lower() in seen:
                    continue
                seen.add(name.lower())
                requirements.append(
                    NarratedSceneRequirement(
                        scene_name=name,
                        scene_type=cls._guess_scene_type_from_name(name),
                        evidence_lines=[text],
                    )
                )
                break
            if len(requirements) >= 8:
                break
        return requirements

    @staticmethod
    def _add_to_prop_menu(
        prop_id: str,
        prop_menu: list[PropMenuItem],
        seen_prop_ids: set[str],
        existing: NovelProp | None = None,
        requirement: PropRequirement | None = None,
    ) -> None:
        if prop_id not in seen_prop_ids:
            description = str(getattr(requirement, "description", "") or "").strip()
            visual_prompt = str(getattr(requirement, "visual_prompt", "") or "").strip()
            prop_type = (
                str(getattr(requirement, "prop_type", "") or "").strip() or "object"
            )
            existing_visual = str(getattr(existing, "visual_prompt", "") or "").strip()
            existing_description = str(
                getattr(existing, "description", "") or ""
            ).strip()
            fallback_visual = visual_prompt or description or prop_id
            prop_menu.append(
                PropMenuItem(
                    prop_id=prop_id,
                    prop_type=(
                        getattr(existing, "prop_type", "") if existing else prop_type
                    ),
                    visual_prompt=existing_visual
                    or existing_description
                    or fallback_visual,
                    description=description or existing_description or existing_visual,
                    owner_identity_id=(
                        getattr(existing, "owner", "") if existing else ""
                    ),
                )
            )
            seen_prop_ids.add(prop_id)

    @staticmethod
    def _normalize_alias_lookup(value: str) -> str:
        return " ".join((value or "").replace("\u3000", " ").strip().lower().split())

    async def _find_matching_scene(self, name: str) -> Optional[NovelScene]:
        scene = await self.store.get_scene(name)
        if scene:
            return scene

        all_scenes = await self.store.list_scenes()
        base_candidates = [
            item
            for item in all_scenes
            if str(getattr(item, "name", "") or "").strip()
            and not str(getattr(item, "base_scene_id", "") or "").strip()
        ]
        for item in base_candidates:
            if name in item.aliases:
                return item
        for item in base_candidates:
            if name in item.name or item.name in name:
                return item

        return None

    @staticmethod
    def _build_derived_scene(
        parent_scene: NovelScene, requirement: DerivedSceneRequirement
    ) -> NovelScene:
        label = str(requirement.label or "").strip()
        derived_name = compose_derived_scene_name(parent_scene.name, label)
        variant_prompt_parts = [
            str(requirement.description or "").strip(),
            str(requirement.lighting or "").strip(),
            str(requirement.atmosphere or "").strip(),
        ]
        variant_prompt = "\n".join(part for part in variant_prompt_parts if part)
        description = str(requirement.description or "").strip()
        return NovelScene(
            name=derived_name,
            aliases=[parent_scene.name],
            scene_type=parent_scene.scene_type,
            base_scene_id=parent_scene.name,
            variant_id=label,
            environment_prompt="",
            variant_prompt=variant_prompt,
            description=description,
            notes=f"Derived by AssetCompiler from scene {parent_scene.name}",
        )

    @staticmethod
    def _time_plate_counts(scene_blocks: list[SceneBlock]) -> dict[str, dict[str, int]]:
        counts: dict[str, dict[str, int]] = {}
        for block in scene_blocks or []:
            location = str(getattr(block, "location", "") or "").strip()
            scene_time = normalize_time_of_day(
                str(getattr(block, "time_of_day", "") or "")
            )
            if not location or not scene_time:
                continue
            counts.setdefault(location, {})
            counts[location][scene_time] = counts[location].get(scene_time, 0) + 1
        return counts

    @staticmethod
    def _build_time_plate_scene(
        parent_scene: NovelScene,
        time_of_day: str,
        episode: Any,
    ) -> NovelScene:
        scene_time = normalize_time_of_day(time_of_day)
        plate_name = compose_derived_scene_name(parent_scene.name, scene_time)
        return NovelScene(
            name=plate_name,
            aliases=[parent_scene.name],
            scene_type=parent_scene.scene_type,
            base_scene_id=parent_scene.name,
            variant_id="",
            time_of_day=scene_time,
            environment_prompt="",
            description="",
            notes=f"Empty plate slot created by AssetCompiler from scene {parent_scene.name} (ep{episode.number})",
        )

    @staticmethod
    def _normalize_derived_scenes(
        derived_scenes: list[DerivedSceneRequirement],
    ) -> list[DerivedSceneRequirement]:
        forbidden_exact = {
            "day",
            "night",
            "morning",
            "evening",
            "noon",
            "afternoon",
            "dawn",
            "dusk",
            "int",
            "ext",
            "interior",
            "exterior",
            "indoor",
            "outdoor",
            "indoors",
            "outdoors",
            "pov",
            "first person",
            "first-person",
            "black screen",
            "black",
            "empty shot",
            "empty",
            "close up",
            "close-up",
            "close_up",
            "medium close",
            "medium_close",
            "medium shot",
            "medium",
            "long shot",
            "long",
            "wide shot",
            "wide",
            "high angle",
            "high_angle",
            "low angle",
            "low_angle",
            "eye level",
            "eye_level",
            "over the shoulder",
            "over_shoulder",
        }
        forbidden_contains = (
            "interior",
            "exterior",
            "first person",
            "first-person",
            "pov",
        )
        normalized: list[DerivedSceneRequirement] = []
        seen: set[str] = set()
        for raw in derived_scenes or []:
            label = str(getattr(raw, "label", "") or "").strip()
            if not label:
                continue
            if label.lower() in forbidden_exact:
                continue
            if any(token in label.lower() for token in forbidden_contains):
                continue
            if label in seen:
                continue
            seen.add(label)
            description = str(getattr(raw, "description", "") or "").strip()
            lighting = str(getattr(raw, "lighting", "") or "").strip()
            atmosphere = str(getattr(raw, "atmosphere", "") or "").strip()
            normalized.append(
                DerivedSceneRequirement(
                    label=label,
                    description=description or label,
                    lighting=lighting,
                    atmosphere=atmosphere,
                )
            )
        return normalized

    @classmethod
    def _build_derived_scene_specs(
        cls, derived_scenes: list[DerivedSceneRequirement]
    ) -> list[DerivedSceneRequirement]:
        return cls._normalize_derived_scenes(derived_scenes)

    @staticmethod
    def _add_to_scene_menu(
        scene_id: str,
        scene_menu: list[SceneMenuItem],
        seen_scene_ids: set[str],
        *,
        base_scene_id: str = "",
        variant_id: str = "",
        time_of_day: str = "",
    ) -> None:
        if scene_id not in seen_scene_ids:
            scene_menu.append(
                SceneMenuItem(
                    scene_id=scene_id,
                    base_scene_id=str(base_scene_id or "").strip(),
                    variant_id=str(variant_id or "").strip(),
                    time_of_day=str(time_of_day or "").strip(),
                )
            )
            seen_scene_ids.add(scene_id)
            return

    async def _find_matching_prop(self, name: str) -> Optional[NovelProp]:
        prop = await self.store.get_prop(name)
        if prop:
            return prop

        lookup = self._normalize_alias_lookup(name)
        all_props = await self.store.list_props()
        for item in all_props:
            if any(
                self._normalize_alias_lookup(alias) == lookup for alias in item.aliases
            ):
                return item
            if name in item.name or item.name in name:
                return item

        return None
