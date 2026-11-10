"""Freezone's MiniMax H3 Multishot (long continuous video) support.

Pure, store-free logic for the Freezone multishot video routes
(`api/routes/freezone.py`'s `/freezone/video/multishot` and
`/freezone/video/multishot/review`) — kept separate from the routes so it
is unit-testable without FastAPI or the task backend. Mirrors the
main-pipeline's beat-chain multishot flow (`api/routes/generation.py`'s
`_multishot_shared_references`/`_build_segment_shot_prompts`), but built
from a Freezone node's own freeform shot list plus canvas-connected and
Character-Library reference images instead of beats — Freezone has no
narration/dialogue/script concept, so shot text always goes into
`MiniMaxH3BeatContext.visual_description` (see `build_shot_contexts`).

Added 2026-10-25 — see `.claude/CLAUDE.md` and the approved plan for this
feature for the full design rationale, including why this is a dedicated
route+runner bypassing `VideoGeneratorBase.generate()` (multishot needs a
whole chain's worth of shots in one call, not one prompt/one call).
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from novelvideo.agents.minimax_h3_prompt_builder import (
    MiniMaxH3BeatContext,
    MiniMaxH3Reference,
)
from novelvideo.generators.runpod_minimax_h3_multishot_video import (
    MULTISHOT_MAX_UNION_REFERENCES,
    Checkpoint,
)

H3ReferenceKind = Literal["character", "scene", "prop"]

#: Freezone's Character Library items carry a `category` field from
#: `LIBRARY_CATEGORIES` (`freezone/video_node.py`) — only these three map
#: onto `MiniMaxH3Reference.kind`; everything else (other/style/audio)
#: falls back to "character", same default the field itself uses.
LIBRARY_CATEGORY_TO_H3_KIND: dict[str, H3ReferenceKind] = {
    "character": "character",
    "scene": "scene",
    "prop": "prop",
}


def library_category_to_h3_kind(category: str | None) -> H3ReferenceKind:
    return LIBRARY_CATEGORY_TO_H3_KIND.get(str(category or "").strip(), "character")


@dataclass(frozen=True)
class MultishotShotInput:
    """One shot's raw, user-authored text — before any AI rewriting."""

    id: str
    description: str
    #: What the on-screen subject says in this shot, if anything. Only ref2va
    #: chains with voice references can actually speak it. Non-empty dialogue
    #: changes three things downstream: the prompt builder is told to expect it
    #: (`expects_dialogue`), the lint stops flagging the `<d>...</d>` block as
    #: stray text, and the shot gets the dialogue frame floor so the line is not
    #: cut off mid-word.
    dialogue: str = ""


@dataclass(frozen=True)
class ResolvedReference:
    """One shared reference image, already resolved to a local file path
    (the route does URL→path resolution; this module only dedupes/caps)."""

    path: str
    url: str
    name: str
    kind: H3ReferenceKind
    source: Literal["canvas", "library"]


@dataclass(frozen=True)
class FreezoneMultishotPlan:
    """Everything resolved and ready to either (a) generate AI-rewritten
    prompts for review, or (b) enqueue the real RunPod job, for one
    multishot node submission."""

    backend: str
    checkpoint: Checkpoint
    sampling: dict
    width: int
    height: int
    frames_per_shot: int
    shot_seconds: float
    start_image_path: str
    start_image_url: str
    references: list[ResolvedReference]
    #: Local paths of the voice reference clips (`<Audio N>`), in order. Only
    #: meaningful for `ref2va`; `build_h3_multishot_graph` raises above 3.
    voice_ref_paths: list[str]
    shots: list[MultishotShotInput]
    director_guidance: str
    aspect_ratio: str


class TooManyReferencesError(ValueError):
    """Raised instead of silently truncating — a chain needing more shared
    references than `H3MultishotSampler` can carry in one batch should fail
    loudly (the user picks fewer references), not quietly lose an
    identity the review dialog never warned about."""

    def __init__(self, names: list[str], limit: int):
        self.names = names
        self.limit = limit
        super().__init__(
            f"at most {limit} shared reference images are supported for a "
            f"multishot chain, got {len(names)}: {', '.join(names) or '(unnamed)'}"
        )


def resolve_shared_references(
    *,
    canvas_refs: list[ResolvedReference],
    library_refs: list[ResolvedReference],
    start_image_path: str,
) -> list[ResolvedReference]:
    """Union canvas-connected images and Character Library picks into one
    ordered, deduped reference list, capped at
    `MULTISHOT_MAX_UNION_REFERENCES`.

    Canvas references come first (the user's own on-canvas order — the
    route resolves this from `referenceOrder` before calling in), library
    picks follow in request order. A reference equal to the start image
    (same resolved path) is dropped — it is already `<Picture 1>`, citing
    it again as a shared reference would duplicate the upload and confuse
    the `<Picture N>` numbering. Duplicate paths across the two sources are
    also dropped, keeping the first occurrence."""
    resolved: list[ResolvedReference] = []
    seen_paths: set[str] = set()
    start_resolved = _resolved_path(start_image_path) if start_image_path else ""

    def _add(ref: ResolvedReference) -> None:
        if not ref.path:
            return
        key = _resolved_path(ref.path)
        if not key or key == start_resolved or key in seen_paths:
            return
        seen_paths.add(key)
        resolved.append(ref)

    for ref in canvas_refs:
        _add(ref)
    for ref in library_refs:
        _add(ref)

    if len(resolved) > MULTISHOT_MAX_UNION_REFERENCES:
        raise TooManyReferencesError(
            [r.name or Path(r.path).name for r in resolved], MULTISHOT_MAX_UNION_REFERENCES
        )
    return resolved


MULTISHOT_MAX_VOICE_REFS = 3


class TooManyVoiceRefsError(ValueError):
    """Raised instead of silently dropping a voice: `build_h3_multishot_graph`
    only wires `voice_ref`, `voice_ref_2` and `voice_ref_3`, so a fourth speaker
    would vanish without a word and the chain would render in the wrong voice."""

    def __init__(self, names: list[str], limit: int):
        self.names = names
        self.limit = limit
        super().__init__(
            f"at most {limit} voice reference clips are supported for a multishot "
            f"chain, got {len(names)}: {', '.join(names) or '(unnamed)'}"
        )


def resolve_voice_refs(
    *,
    canvas_voice_paths: list[str],
    library_voice_paths: list[str],
) -> list[str]:
    """Union canvas-connected audio and Character Library audio picks into one
    ordered, deduped list of voice reference paths, capped at
    `MULTISHOT_MAX_VOICE_REFS`.

    Order is `<Audio 1>`, `<Audio 2>`, ... and it is load-bearing: a shot's prompt
    names the speaker by that tag, so reordering the list changes who speaks.
    Canvas order first, then library picks in request order — the same convention
    `resolve_shared_references` uses for images.

    This is a SEPARATE budget from `MULTISHOT_MAX_UNION_REFERENCES`: an audio
    library item must never consume one of the 3 image reference slots.
    """
    resolved: list[str] = []
    seen: set[str] = set()
    for path in [*canvas_voice_paths, *library_voice_paths]:
        if not path:
            continue
        key = _resolved_path(path)
        if not key or key in seen:
            continue
        seen.add(key)
        resolved.append(path)
    if len(resolved) > MULTISHOT_MAX_VOICE_REFS:
        raise TooManyVoiceRefsError(
            [Path(p).name for p in resolved], MULTISHOT_MAX_VOICE_REFS
        )
    return resolved


def _resolved_path(path: str) -> str:
    try:
        return str(Path(path).resolve())
    except OSError:
        return str(path)


def build_shot_contexts(plan: FreezoneMultishotPlan) -> list[MiniMaxH3BeatContext]:
    """One `MiniMaxH3BeatContext` per shot, in order — the input to
    `agents.minimax_h3_prompt_builder.generate_minimax_h3_prompt_with_fallback`,
    one call per shot.

    Dialogue is per shot (added 2026-11-10 with voice references): a shot whose
    `dialogue` is set passes it as `dialogue_line`, and callers must then pass
    `expects_dialogue=True` to the prompt generator for that chain — otherwise the
    builder omits the `<d>...</d>` block and the lint treats a hand-written one as
    stray text. Shots with no dialogue keep the previous behaviour exactly.
    `narration_segment` is still unused.

    Field choice for the user's shot text — `visual_description`, not
    `director_guidance`: `_build_user_prompt` gives `visual_description`
    its own section in the LLM prompt, and the no-LLM fallback
    (`build_fallback_minimax_h3_prompt`) builds the ENTIRE fallback prompt
    from `visual_description or narration_segment`, explicitly ignoring
    `director_guidance` ("advisory only"). Putting the shot text in
    `director_guidance` would mean a failed LLM call produces an empty,
    generic fallback prompt instead of one grounded in what the user
    actually asked for. `director_guidance` instead carries the node's
    OVERALL direction (style/mood notes that apply to every shot, plus any
    camera-template fragment) — see the route layer for how that's built."""
    references = [
        MiniMaxH3Reference(
            tag=f"<Picture {i + 2}>",
            kind=ref.kind,
            name=ref.name,
            image_path=ref.path,
        )
        for i, ref in enumerate(plan.references)
    ]
    shot_count = len(plan.shots)
    contexts: list[MiniMaxH3BeatContext] = []
    for k, shot in enumerate(plan.shots):
        if k == 0:
            first_frame_path = plan.start_image_path
            prev_narration = ""
        else:
            first_frame_path = ""
            prev_narration = (
                "(continuing immediately from the previous shot, same scene and subjects) "
                + plan.shots[k - 1].description
            )
        next_narration = plan.shots[k + 1].description if k < shot_count - 1 else ""
        contexts.append(
            MiniMaxH3BeatContext(
                mode=plan.checkpoint,
                visual_description=shot.description,
                duration_seconds=plan.shot_seconds,
                aspect_ratio=plan.aspect_ratio,
                prev_beat_narration=prev_narration,
                next_beat_narration=next_narration,
                director_guidance=plan.director_guidance,
                first_frame_path=first_frame_path,
                references=references,
                dialogue_line=shot.dialogue,
            )
        )
    return contexts


def multishot_input_fingerprint(plan: FreezoneMultishotPlan) -> str:
    """SHA-1 over everything that determines WHAT gets rendered: backend,
    checkpoint, dims/sampling, the start image and every reference file by
    path:mtime, each shot's raw description, and the overall director
    guidance.

    Deliberately EXCLUDES the AI-rewritten prompt text itself, so
    hand-editing a prompt in the review dialog never makes the enqueue
    route reject it as stale — the same fix already applied to the H3 beat
    review and Qwen render-review flows (see `.claude/CLAUDE.md`)."""

    def _mtime(path: str) -> str:
        try:
            return str(Path(path).stat().st_mtime_ns)
        except OSError:
            return "missing"

    parts: list[str] = [
        plan.backend,
        plan.checkpoint,
        str(plan.frames_per_shot),
        str(plan.width),
        str(plan.height),
        json.dumps(plan.sampling, sort_keys=True),
        f"{plan.start_image_path}:{_mtime(plan.start_image_path)}",
    ]
    for ref in plan.references:
        parts.append(f"{ref.path}:{_mtime(ref.path)}:{ref.kind}:{ref.name}")
    for voice_path in plan.voice_ref_paths:
        parts.append(f"voice:{voice_path}:{_mtime(voice_path)}")
    for shot in plan.shots:
        parts.append(shot.description.strip())
        parts.append(f"dialogue:{shot.dialogue.strip()}")
    parts.append(plan.director_guidance.strip())
    digest_input = "\x1f".join(parts)
    return hashlib.sha1(digest_input.encode("utf-8")).hexdigest()


# ── chain JSON import (2026-11-10) ───────────────────────────────────────


#: Keys a previs chain JSON is expected to carry. Written by
#: `previs_h3_test/scripts/skits/science_humor/gravity_test/gen_chains.py` and
#: already the interchange format between the authoring scripts, the local bench
#: and the review skills — so Freezone reads it rather than inventing a second one.
CHAIN_JSON_KEYS = (
    "scene",
    "aspect_ratio",
    "frames",
    "checkpoint",
    "voice_refs",
    "storyboard_prompts",
    "name",
    "start_image",
    "reference_images",
    "shots",
)

_DIALOGUE_RE = re.compile(r"<d>(?:\[[^\]]*\]\s*)?(.*?)</d>", re.DOTALL)


class ChainImportError(ValueError):
    """The JSON is not a usable H3 chain."""


def extract_chain_dialogue(shot_text: str) -> str:
    """Pull the spoken line(s) out of a shot's H3 prompt block.

    A chain's shot text already contains the finished prompt, dialogue included
    (`<d>[English] ...</d>`). Freezone does not need to parse it to RENDER — the
    text is passed through verbatim — but it does need to know whether a shot
    speaks, because that drives the dialogue frame floor and `expects_dialogue`.
    Returning the words themselves (not just a flag) also lets the review UI show
    what is said per shot.
    """
    lines = [m.group(1).strip() for m in _DIALOGUE_RE.finditer(shot_text or "")]
    return "\n".join(line for line in lines if line)


def chain_json_to_multishot_request(chain: dict) -> dict:
    """Map a previs chain JSON onto the `/freezone/video/multishot` request shape.

    Pure: no filesystem access, no URL resolution. Paths come back exactly as the
    chain wrote them (repo-relative) — the caller uploads the files and swaps in
    static URLs, because only it knows the project.

    `turbo_lora`/`turbo_steps` are deliberately NOT carried over: sampling is
    resolved server-side by `multishot_sampling_plan()` from config, and letting a
    JSON file override it would reintroduce exactly the env-mutation-by-input
    pattern the local bench uses and that must not reach the app.
    """
    if not isinstance(chain, dict):
        raise ChainImportError("chain JSON must be an object")

    shots = chain.get("shots")
    if not isinstance(shots, list) or not shots:
        raise ChainImportError("chain JSON has no shots")
    if not all(isinstance(s, str) and s.strip() for s in shots):
        raise ChainImportError("every shot must be a non-empty prompt string")

    start_image = str(chain.get("start_image") or "")
    if not start_image:
        raise ChainImportError(
            "chain JSON has no start_image — a `_refs_only` variant cannot be "
            "imported, Freezone's multishot node always needs a start frame"
        )

    aspect_ratio = str(chain.get("aspect_ratio") or "9:16")
    if aspect_ratio not in ("16:9", "9:16"):
        raise ChainImportError(f"unsupported aspect_ratio {aspect_ratio!r}")

    frames = int(chain.get("frames") or 0)
    shot_seconds = round(frames / 24.0) if frames else 8

    shot_entries = []
    for index, text in enumerate(shots, start=1):
        shot_entries.append(
            {
                "id": f"shot{index}",
                # The chain's shot text IS the final H3 prompt. It goes into
                # `description` so the review route can show and re-lint it, and is
                # echoed as `final_prompt` so an unedited import renders verbatim.
                "description": text.strip(),
                "dialogue": extract_chain_dialogue(text),
                "final_prompt": text.strip(),
            }
        )

    return {
        "name": str(chain.get("name") or ""),
        "scene": str(chain.get("scene") or ""),
        "aspect_ratio": aspect_ratio,
        "shot_duration_seconds": max(5, min(12, shot_seconds)),
        "start_image": start_image,
        "reference_images": [str(p) for p in (chain.get("reference_images") or [])],
        "voice_refs": [str(p) for p in (chain.get("voice_refs") or [])],
        "storyboard_prompts": [str(p) for p in (chain.get("storyboard_prompts") or [])],
        "storyboard_prompts_qwen": [
            str(p) for p in (chain.get("storyboard_prompts_qwen") or [])
        ],
        "shots": shot_entries,
    }
