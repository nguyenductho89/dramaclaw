"""Writes a short "staging bible" per scene — camera framing, where each
character stands, and where persistent set-dressing sits — consumed by
the sketch-free "compose" render prompts (`build_qwen21_compose_prompt`/
`build_gemini_compose_prompt` in `generators/prompt_builder.py`) so every
beat of the same scene renders with consistent blocking, instead of each
first frame being composed independently from scratch.

Why this exists: real renders of the `Parkun` project
(`runpod_qwen21_compose`, 2026-10-22) showed the same scene's props and
character positions drifting beat to beat — a toy wall at a different
spot in each frame, missing entirely from one beat even though the
beat's own narration still refers to it as standing there, characters
swapping left/right with no textual reason. See `.claude/CLAUDE.md`'s
"Parkun" entry and `docs/adr/0006-compose-staging-bible.md`.

**The LLM proposes, Python disposes** — same contract as
`segment_planner.py`: `plan_scene_staging()` asks the model for a
staging bible per scene, but every entry gets validated against the
scene's own real identity/prop ids and beat-number range before being
handed back; invalid/unmatched entries are dropped, not trusted
verbatim. A model call that fails outright (network, quota, malformed
output) falls back to a deterministic staging (fixed camera sentence,
identities placed left/right/center in order of first appearance, any
prop appearing in 2+ beats of the scene marked persistent from its first
appearance) rather than leaving the caller with nothing.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, Field
from pydantic_ai import Agent

from novelvideo.generators.staging_store import SceneStaging, SetDressingItem

_RULES_PATH = Path(__file__).parent / "prompts" / "scene_staging_rules.md"

_FALLBACK_CAMERA = (
    "Fixed medium shot at eye level: each character is framed from "
    "roughly head to mid-thigh, occupying about 35-45% of the frame's "
    "height, with the location's own background (per its reference "
    "image) filling the rest of the frame behind them."
)
_FALLBACK_POSITIONS = [
    "stands on the left side of frame.",
    "stands on the right side of frame.",
    "stands in the center of frame.",
    "stands slightly behind and to the side of the others, still clearly visible.",
]


def _load_rules() -> str:
    return _RULES_PATH.read_text(encoding="utf-8")


# ── What the caller gives the planner ───────────────────────────────────


@dataclass
class StagingBeatInput:
    beat_number: int
    visual_description: str = ""
    identities: list[str] = field(default_factory=list)
    props: list[str] = field(default_factory=list)


@dataclass
class StagingCharacterInput:
    identity_id: str
    name: str
    body_type: str = ""


@dataclass
class StagingPropInput:
    prop_id: str
    visual_prompt: str = ""


@dataclass
class StagingSceneInput:
    scene_id: str
    scene_prompt: str = ""
    beats: list[StagingBeatInput] = field(default_factory=list)
    characters: list[StagingCharacterInput] = field(default_factory=list)
    props: list[StagingPropInput] = field(default_factory=list)

    @property
    def beat_numbers(self) -> list[int]:
        return [b.beat_number for b in self.beats]

    @property
    def identity_ids(self) -> set[str]:
        return {c.identity_id for c in self.characters}

    @property
    def prop_ids(self) -> set[str]:
        return {p.prop_id for p in self.props}


# ── LLM output shape ────────────────────────────────────────────────────


class BlockingEntryProposal(BaseModel):
    identity_id: str
    placement: str = Field(
        default="",
        description="One short sentence placing this identity in frame, e.g. "
        "'Little Trump stands on the left side of frame.'",
    )


class SetDressingProposal(BaseModel):
    prop_id: str
    placement_note: str = Field(
        default="",
        description="One short sentence placing this prop in frame, e.g. "
        "'The toy wall sits on the ground between the two children.'",
    )
    persistent: bool = Field(
        default=False,
        description="True if this prop should remain visible/mentioned in every "
        "later beat of this scene, not just the beats that tag it.",
    )
    from_beat: int = Field(
        default=0, description="First beat number (in this scene) where this prop appears."
    )


class SceneStagingProposal(BaseModel):
    scene_id: str
    camera: str = Field(default="")
    blocking: list[BlockingEntryProposal] = Field(default_factory=list)
    set_dressing: list[SetDressingProposal] = Field(default_factory=list)
    scale_note: str = Field(default="")


class StagingPlanLLMOutput(BaseModel):
    scenes: list[SceneStagingProposal] = Field(default_factory=list)


# ── Deterministic fallback / repair ─────────────────────────────────────


def _rotation_blocking_for_scene(scene: StagingSceneInput) -> dict[str, str]:
    """Deterministic left/right/center placement, one identity per
    rotation slot, in order of first appearance across the scene's own
    beats. Shared by `_fallback_scene_staging()` (no usable LLM output at
    all) and `_repair_scene_staging()` (LLM wrote a `blocking` sentence
    that failed the cross-reference check below, for one identity only —
    everyone else's LLM-written sentence is kept)."""
    first_seen: list[str] = []
    seen_ids: set[str] = set()
    for b in scene.beats:
        for identity_id in b.identities:
            if identity_id in scene.identity_ids and identity_id not in seen_ids:
                seen_ids.add(identity_id)
                first_seen.append(identity_id)

    blocking: dict[str, str] = {}
    for i, identity_id in enumerate(first_seen):
        position = _FALLBACK_POSITIONS[min(i, len(_FALLBACK_POSITIONS) - 1)]
        blocking[identity_id] = position[0].upper() + position[1:]
    return blocking


# ── Cross-reference guard ───────────────────────────────────────────────
#
# A beat's compose prompt only ever includes the ONE identity it actually
# tags (see `_compose_prompt_extras()` in `nanobanana_grid.py`, which
# filters `blocking` down to this beat's own identities before the
# prompt is built) — but a staging bible is written ONCE for a whole
# scene with its full cast in view. A sentence that names or implies a
# second person (another character's own display name, or a generic
# phrase like "both children"/"the other child") still reaches the
# prompt of a single-character beat even after that dict-level filter,
# because the filter only drops the *other identity's own entry*, not
# cross-references baked into the text of the SURVIVING entries. Real
# bug, caught on a real GPU render (`Parkun` beats 1 and 7, both
# single-character): the model drew a second, unreferenced person into
# frame because the camera sentence said "both children ... fully in
# frame" and Trump's own blocking sentence ended "...facing right toward
# Little Kim." — see `.claude/CLAUDE.md`.
_GENERIC_CROSS_REFERENCE_RE = re.compile(
    r"\b(both (children|kids)|(the|another) (other |second )?(child|kid)\b|"
    r"each other|facing each other|together with|two (children|kids))\b",
    re.IGNORECASE,
)


def _mentions_cross_reference(text: str, forbidden_names: set[str]) -> bool:
    if not text:
        return False
    if _GENERIC_CROSS_REFERENCE_RE.search(text):
        return True
    lowered = text.lower()
    return any(name.lower() in lowered for name in forbidden_names if name)


def _fallback_scene_staging(scene: StagingSceneInput) -> SceneStaging:
    """No LLM / no usable LLM output for this scene — a plain, order-based
    staging that is always at least internally consistent across the
    scene's own beats (unlike having no staging at all, which was the
    status quo before this feature and is what produced the drift this
    feature exists to fix)."""
    blocking = _rotation_blocking_for_scene(scene)

    beat_count_by_prop: dict[str, int] = {}
    first_beat_by_prop: dict[str, int] = {}
    for b in scene.beats:
        for prop_id in b.props:
            if prop_id not in scene.prop_ids:
                continue
            beat_count_by_prop[prop_id] = beat_count_by_prop.get(prop_id, 0) + 1
            if prop_id not in first_beat_by_prop:
                first_beat_by_prop[prop_id] = b.beat_number

    set_dressing = [
        SetDressingItem(
            prop_id=prop_id,
            placement_note=f"The {prop_id} is present in the scene.",
            persistent=True,
            from_beat=first_beat_by_prop[prop_id],
        )
        for prop_id, count in beat_count_by_prop.items()
        if count >= 2
    ]

    return SceneStaging(
        scene_id=scene.scene_id,
        camera=_FALLBACK_CAMERA,
        blocking=blocking,
        set_dressing=set_dressing,
        scale_note="",
        source="fallback",
    )


def _repair_scene_staging(
    scene: StagingSceneInput, proposal: SceneStagingProposal
) -> SceneStaging:
    """Keeps only blocking/set-dressing entries whose id is a REAL
    identity/prop of this scene, clamps `from_beat` into the scene's own
    beat-number range, and rejects any `camera`/`blocking`/`set_dressing`
    text that cross-references another character (see
    `_mentions_cross_reference()`'s docstring for why) — replacing just
    that one field with a safe generic fallback rather than discarding
    the whole scene. Never trusts the LLM's ids, numbers or prose
    verbatim."""
    min_beat = min(scene.beat_numbers) if scene.beat_numbers else 0
    max_beat = max(scene.beat_numbers) if scene.beat_numbers else 0
    names_by_identity = {c.identity_id: c.name for c in scene.characters}

    blocking: dict[str, str] = {}
    for entry in proposal.blocking:
        if entry.identity_id not in scene.identity_ids or not entry.placement.strip():
            continue
        other_names = {
            name for identity_id, name in names_by_identity.items() if identity_id != entry.identity_id
        }
        placement = entry.placement.strip()
        if _mentions_cross_reference(placement, other_names):
            # This one identity's sentence names/implies someone else —
            # replace just this entry with a safe rotation-based
            # fallback rather than dropping the whole scene's blocking.
            placement = _rotation_blocking_for_scene(scene).get(
                entry.identity_id, f"{entry.identity_id} stands in frame."
            )
        blocking[entry.identity_id] = placement

    all_names = set(names_by_identity.values())

    set_dressing: list[SetDressingItem] = []
    for entry in proposal.set_dressing:
        if entry.prop_id not in scene.prop_ids:
            continue
        from_beat = entry.from_beat or min_beat
        from_beat = max(min_beat, min(max_beat, from_beat)) if scene.beat_numbers else from_beat
        placement_note = entry.placement_note.strip()
        # Only the GENERIC phrases ("the other child", "both children")
        # are checked here, not every character name — a prop's own
        # placement legitimately naming a character it belongs to (e.g.
        # "sits beside Little Trump") is informative positioning text,
        # not a false claim that a second person is in frame.
        if _GENERIC_CROSS_REFERENCE_RE.search(placement_note):
            placement_note = f"The {entry.prop_id} is present in the scene."
        set_dressing.append(
            SetDressingItem(
                prop_id=entry.prop_id,
                placement_note=placement_note,
                persistent=bool(entry.persistent),
                from_beat=from_beat,
            )
        )

    camera = proposal.camera.strip() or _FALLBACK_CAMERA
    if _mentions_cross_reference(camera, all_names):
        # Camera framing must hold for EVERY beat of the scene,
        # including ones with only one of the cast present — a sentence
        # asserting a specific person-count ("both children...") is
        # simply wrong for those beats.
        camera = _FALLBACK_CAMERA

    scale_note = proposal.scale_note.strip()
    if _mentions_cross_reference(scale_note, all_names):
        # Same reasoning as `camera` — "both children are X height"
        # breaks for a beat where only one of them is in frame. No
        # dedicated fallback sentence exists for this field (the rules
        # doc marks it optional), so simply dropping it is safe.
        scale_note = ""

    if not blocking and not set_dressing and not proposal.camera.strip():
        # Nothing usable survived validation — safer to fall back wholesale
        # than to hand back an almost-empty staging that silently drops
        # the model's (possibly fine) camera/scale guidance.
        return _fallback_scene_staging(scene)

    return SceneStaging(
        scene_id=scene.scene_id,
        camera=camera,
        blocking=blocking,
        set_dressing=set_dressing,
        scale_note=scale_note,
        source="llm_repaired",
    )


def validate_and_repair_staging_plan(
    scenes: list[StagingSceneInput], llm_output: Optional[StagingPlanLLMOutput]
) -> dict[str, SceneStaging]:
    """Always returns one `SceneStaging` per input scene. Each scene is
    independently repaired (or falls back) — one scene's bad LLM output
    never discards another scene's good one."""
    by_scene_id = {str(p.scene_id): p for p in (llm_output.scenes if llm_output else [])}
    out: dict[str, SceneStaging] = {}
    for scene in scenes:
        proposal = by_scene_id.get(scene.scene_id)
        out[scene.scene_id] = (
            _repair_scene_staging(scene, proposal)
            if proposal is not None
            else _fallback_scene_staging(scene)
        )
    return out


# ── LLM call ─────────────────────────────────────────────────────────────


def _build_user_prompt(scenes: list[StagingSceneInput]) -> str:
    lines: list[str] = []
    for scene in scenes:
        lines.append(f"\n## Scene: {scene.scene_id}")
        if scene.scene_prompt:
            lines.append(f"Location reference image prompt: {scene.scene_prompt[:400]}")
        lines.append("Characters:")
        for c in scene.characters:
            hint = f" ({c.body_type})" if c.body_type else ""
            lines.append(f"- {c.identity_id}: {c.name}{hint}")
        lines.append("Props:")
        for p in scene.props:
            hint = f" — {p.visual_prompt[:150]}" if p.visual_prompt else ""
            lines.append(f"- {p.prop_id}{hint}")
        lines.append("Beats, in script order:")
        for b in scene.beats:
            lines.append(
                f"- beat {b.beat_number} (identities={b.identities or '(none)'}, "
                f"props={b.props or '(none)'}): {b.visual_description[:250]}"
            )
    lines.append(
        "\nWrite one staging entry per scene above, following every rule. "
        "Use each scene's `scene_id` exactly as given."
    )
    return "\n".join(lines)


def _build_agent() -> Agent:
    from novelvideo.config import get_newapi_structured_output_model_settings, get_newapi_text_pydantic_model

    rules = _load_rules()
    system_prompt = (
        "You are a short-drama staging/continuity planner. You write a "
        "short staging bible per scene so independently generated first "
        "frames stay consistent in blocking, following the rules below "
        "exactly.\n\n" + rules
    )
    return Agent(
        get_newapi_text_pydantic_model(
            "SCENE_STAGING_PLANNER_MODEL",
            default_model="DC-scene-staging-LLM",
            capability="text.generate.agent",
        ),
        system_prompt=system_prompt,
        output_type=StagingPlanLLMOutput,
        model_settings={**get_newapi_structured_output_model_settings(), "max_tokens": 4000},
        name="Scene Staging Planner",
    )


_agent: Optional[Agent] = None


def get_scene_staging_agent() -> Agent:
    global _agent
    if _agent is None:
        _agent = _build_agent()
    return _agent


async def plan_scene_staging(scenes: list[StagingSceneInput]) -> dict[str, SceneStaging]:
    """Main entry point: ask the LLM for a staging bible across every
    scene given, then always run the result through
    `validate_and_repair_staging_plan` before returning. A failed LLM
    call (network, quota, malformed output) falls back to deterministic
    staging for every scene rather than leaving the caller with
    nothing."""
    if not scenes:
        return {}
    try:
        agent = get_scene_staging_agent()
        response = await agent.run(_build_user_prompt(scenes))
        llm_output: Optional[StagingPlanLLMOutput] = response.output
    except Exception:  # noqa: BLE001
        llm_output = None
    return validate_and_repair_staging_plan(scenes, llm_output)
