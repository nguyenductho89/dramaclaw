"""Character extraction straight from source text, without a knowledge graph.

The legacy path asks Cognee for graph context and lets a model name whoever it
finds there.  Structured extraction inverts that: the model only reports what a
specific span of text supports, and every candidate it returns must quote the
span it came from.  A quote that is not in the chunk is dropped, and a name the
imported source never writes is dropped, so a name invented outright has no
route into the character table.

What that does *not* establish is that the right quote was attached to the
right name.  A model can pair a real name with a real sentence about someone
else, and no check here can tell; the guards bound what may enter, not who a
line is about.  Attribution is left to the conservative merging below and to
whoever reads the result.

Merging is deliberately conservative.  A character's name is simultaneously a
SQLite primary key, a REST identifier and an asset directory name, so a wrong
merge is expensive to undo and a wrong split is cheap.  Rules therefore only
merge what the text states outright, and anything genuinely ambiguous is left
as separate candidates rather than guessed at.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, Callable, Iterable, Optional

from pydantic import BaseModel, Field

from novelvideo.story_analysis import SourceChunk
from novelvideo.utils.bounded_concurrency import (
    default_llm_concurrency,
    map_bounded,
)
from novelvideo.utils.source_language import (
    AssetLanguage,
    asset_language_instruction,
    detect_asset_language,
)

# Titles and kinship terms refer to whoever is on stage at the time. The same
# word in two chapters is routinely two different people, so they never merge
# across chunks on their own and never become aliases automatically.
# Stored lower-case; lookups are case-insensitive.
GENERIC_ADDRESS_TERMS = {
    "mother", "father", "mom", "mum", "mama", "dad", "papa", "son", "daughter",
    "brother", "sister", "grandfather", "grandmother", "grandpa", "grandma",
    "doctor", "nurse", "teacher", "driver", "boss", "policeman", "police officer",
    "soldier", "guard", "your majesty", "your highness", "his majesty", "her majesty",
    "my lord", "my lady", "sir", "madam", "ma'am", "miss", "mister", "mr", "mrs", "ms",
    "shopkeeper", "waiter", "passerby", "villager", "maid", "servant", "general",
    "man", "woman", "old man", "old woman", "child", "boy", "girl", "he", "she", "they",
    # Role labels from a treatment or cast list, not names anyone is called by.
    "heroine", "hero", "protagonist", "lead", "supporting role", "villain", "antagonist",
    "young lady", "young master", "bully", "henchman", "bodyguard",
    # Vietnamese kinship terms and role words.
    "mẹ", "má", "bố", "ba", "cha", "con trai", "con gái", "anh trai", "chị gái",
    "em trai", "em gái", "ông nội", "bà nội", "ông ngoại", "bà ngoại",
    "bác sĩ", "y tá", "thầy giáo", "cô giáo", "tài xế", "ông chủ", "cảnh sát",
    "binh lính", "bệ hạ", "điện hạ", "cậu chủ", "tiểu thư", "phu nhân", "ông", "bà",
    "đàn ông", "phụ nữ", "ông lão", "bà lão", "đứa trẻ", "anh ấy", "cô ấy", "nữ chính",
    "nam chính", "nhân vật chính", "nhân vật phụ", "phản diện", "vệ sĩ", "người giúp việc",
}

# Job titles and honorifics that a script attaches to a name: "Principal Wu Xiande",
# "Professor Sun Hai". A name plus only these tokens is the same person under a fuller
# form, so the two may be merged.
#
# Kinship terms are deliberately absent. "Zheng Yuqin's daughter" minus "Zheng Yuqin"
# leaves a kinship remainder, and that names a *different* person -- merging on it would
# collapse a parent and a child into one character.
TITLE_TOKENS = (
    "chairman", "chief executive officer", "ceo", "president", "vice president",
    "general manager", "director", "manager", "supervisor", "principal", "headmaster",
    "professor", "teacher", "doctor", "dr", "nurse", "lawyer", "attorney", "detective",
    "officer", "butler", "secretary", "assistant", "driver", "security guard",
    "shop owner", "boss", "factory manager", "school", "company", "group", "corporation",
    "mister", "mr", "mrs", "ms", "miss", "madam", "sir",
    # Scripts also prefix a name with the role a character plays in the story,
    # as in "Bully Zhang Xiaoqian" or "Servant Auntie Wang".
    "bully", "servant", "bodyguard", "student", "henchman", "project",
    # Vietnamese titles.
    "chủ tịch", "tổng giám đốc", "phó tổng giám đốc", "giám đốc", "quản lý", "hiệu trưởng",
    "giáo sư", "thầy", "cô", "bác sĩ", "y tá", "luật sư", "quản gia", "thư ký", "trợ lý",
    "tài xế", "bảo vệ", "ông chủ", "ông", "bà", "anh", "chị",
)

# Pronouns and possessives a script puts in front of a kinship word, giving
# "your mom" or "his mother". These are the same non-characters as the bare terms.
_POSSESSIVE_PREFIX_RE = re.compile(r"^(?:your|my|his|her|their|our|its)\s+", re.IGNORECASE)

# Explicit alias statements. Only these license an alias link; a model asserting
# two names are the same without the text saying so is not enough.
_ALIAS_NAME = r"[^\W\d_][\w'’.-]*(?:\s+[^\W\d_][\w'’.-]*){0,3}"
_ALIAS_PATTERNS = [
    re.compile(
        rf"(?P<a>{_ALIAS_NAME})\s*,?\s*(?i:also known as|a\.k\.a\.|aka|better known as|formerly known as|"
        rf"real name is|whose real name is|nicknamed|also called|còn gọi là|còn có tên là|tên thật là|"
        rf"bí danh là|biệt danh là|hay gọi là)\s+(?P<b>{_ALIAS_NAME})"
    ),
]


class CharacterEvidence(BaseModel):
    quote: str = Field(description="One complete quote from the source text; must come verbatim from the input text")
    kind: str = Field(default="mention", description="mention / dialogue / description")


class CharacterCandidate(BaseModel):
    name: str = Field(description="How the character is referred to in this chunk, keeping the source spelling")
    aliases: list[str] = Field(default_factory=list, description="Only aliases explicitly written in this chunk's source text")
    appellations: list[str] = Field(
        default_factory=list,
        description="Other ways this chunk refers to the character (nicknames, job titles, honorifics); each must appear verbatim in this chunk's source text",
    )
    gender: str = Field(default="", description="male / female / empty string for unknown")
    description: str = Field(default="", description="Short description supported by this chunk")
    evidence: list[CharacterEvidence] = Field(default_factory=list)


class ChunkCharacterOutput(BaseModel):
    characters: list[CharacterCandidate] = Field(default_factory=list)


CHARACTER_EXTRACTION_SYSTEM_PROMPT = """You are a character extractor for screenplays and novels. The input is one chunk of a work.

Judge from this chunk only; do not speculate about anything outside it.

Rules:
- name is the form used in this chunk's source text; keep the source spelling and do not translate or rewrite it.
- Give every character at least one evidence.quote, which must be a sentence that appears verbatim in this chunk's source text.
- Do not fabricate quotes. Do not output a character you cannot support with source text.
- aliases lists only aliases the chunk's source text explicitly states, e.g. "Lin Mo, also known as Xiao Mo".
- appellations lists other ways this chunk clearly addresses the character: nicknames, job titles, honorifics.
  For example, if the chunk calls her both "Mrs. Zheng" and "Director Zheng" and both mean Zheng Yuqin, put them in Zheng Yuqin's appellations.
  Each one must appear verbatim in this chunk's source text; do not invent them.
  Fill them in only when the context of this chunk shows who they refer to; otherwise leave them out.
- When you are unsure whether two forms of address are the same person, output two separate characters and do not merge them.
- Narration, voice-over and camera directions are not characters.
- Groups (the crowd, the soldiers, the villagers) are not characters."""


@dataclass
class MergedCharacter:
    """One character after deterministic merging across chunks."""

    name: str
    aliases: set[str] = field(default_factory=set)
    gender: str = ""
    description: str = ""
    evidence: list[dict] = field(default_factory=list)
    chunk_ids: set[str] = field(default_factory=set)
    # Names seen in the same text that could be this character but were never
    # stated to be. Surfaced as suggestions; never merged automatically.
    ambiguous_with: set[str] = field(default_factory=set)


def describe_output_failure(exc: BaseException, messages: list[Any]) -> str:
    """One line a task log can show for a failed structured run.

    PydanticAI raises ``Exceeded maximum output retries (N)`` for both "the
    model never called the output tool" and "the arguments failed validation",
    and keeps the reason in the retry prompts it sent and in ``__cause__``.
    Surface both; without them the log line is undiagnosable.
    """
    from pydantic_ai.messages import ModelRequest, RetryPromptPart

    parts = [str(exc)]
    cause = exc.__cause__
    if cause is not None and str(cause) and str(cause) != str(exc):
        parts.append(f"cause: {type(cause).__name__}: {cause}")
    retries: list[str] = []
    for message in messages:
        if not isinstance(message, ModelRequest):
            continue
        for part in message.parts:
            if isinstance(part, RetryPromptPart):
                text = " ".join(part.model_response().split())
                retries.append(text[:400])
    if retries:
        parts.append("retry prompts: " + " | ".join(retries[-2:]))
    return "; ".join(parts)


class StructuredOutputFailure(RuntimeError):
    """A structured run failed; ``str()`` carries the diagnosis."""


def _create_character_extraction_agent(agent: Any = None):
    if agent is not None:
        return agent

    from pydantic_ai import Agent

    from novelvideo.config import (
        get_newapi_structured_output_model_settings,
        get_newapi_text_pydantic_model,
    )
    from novelvideo.model_gateway_runtime import model_gateway_output_retries

    return Agent(
        get_newapi_text_pydantic_model(
            "CHARACTER_BUILD_MODEL",
            "gemini-3-flash-preview",
            capability="text.generate.agent",
        ),
        system_prompt=CHARACTER_EXTRACTION_SYSTEM_PROMPT,
        model_settings=get_newapi_structured_output_model_settings(),
        output_type=ChunkCharacterOutput,
        retries={"output": model_gateway_output_retries(2)},
        name="Structured Character Extractor",
    )


async def _run_structured(agent: Any, prompt: str) -> Any:
    """Run ``agent`` and turn an exhausted output retry into a diagnosable error."""
    from pydantic_ai import capture_run_messages
    from pydantic_ai.exceptions import UnexpectedModelBehavior

    with capture_run_messages() as messages:
        try:
            return (await agent.run(prompt)).output
        except UnexpectedModelBehavior as exc:
            raise StructuredOutputFailure(
                describe_output_failure(exc, list(messages))
            ) from exc


def normalize_character_name(value: str) -> str:
    """Collapse spacing and punctuation noise without altering the name."""
    cleaned = (value or "").replace("\u3000", " ").strip()
    cleaned = cleaned.strip(":,.·\"'()[]")
    return " ".join(cleaned.split())


def is_generic_address(name: str) -> bool:
    """Whether a name refers to a role rather than a specific person.

    A possessive prefix does not make a kinship term specific: "your mom" and
    "his mother" name whoever is on stage, exactly as "mother" does.
    """
    normalized = normalize_character_name(name).lower()
    if normalized in GENERIC_ADDRESS_TERMS:
        return True
    stripped = _POSSESSIVE_PREFIX_RE.sub("", normalized, count=1)
    return bool(stripped) and stripped in GENERIC_ADDRESS_TERMS


def title_qualified_of(long_name: str, short_name: str) -> bool:
    """Whether ``long_name`` is ``short_name`` plus only job titles.

    Scripts routinely introduce someone as "Principal Wu Xiande" and then call them
    "Wu Xiande". Treating those as two people would create duplicate characters,
    each with its own primary key and asset directory.
    """
    long_normalized = normalize_character_name(long_name)
    short_normalized = normalize_character_name(short_name)
    if (
        not short_normalized
        or long_normalized == short_normalized
        or short_normalized not in long_normalized
    ):
        return False

    remainder = long_normalized.replace(short_normalized, "", 1).strip(" .,-")
    # Peel off known titles until nothing is left. Anything that survives is not
    # a title, so the two names are not the same person.
    changed = True
    while remainder and changed:
        changed = False
        lowered = remainder.lower()
        for token in sorted(TITLE_TOKENS, key=len, reverse=True):
            if lowered.startswith(token) and (
                len(lowered) == len(token) or not lowered[len(token)].isalnum()
            ):
                remainder = remainder[len(token):].strip(" .,-")
                changed = True
                break
            if lowered.endswith(token) and (
                len(lowered) == len(token) or not lowered[-len(token) - 1].isalnum()
            ):
                remainder = remainder[: -len(token)].strip(" .,-")
                changed = True
                break
    return not remainder


def _resolve_side(capture: str, known: dict[str, str], *, suffix: bool) -> str:
    """Trim one side of an alias match down to a name that was actually found.

    The patterns take up to four words either side of the marker, and in running
prose that window opens mid-sentence: "Everyone knows Lin Mo, also known as Xiao Mo" captured
"Everyone knows Lin Mo" as a name. Matching against the names extraction really
produced turns that back into "Lin Mo"; ``suffix`` says which end of the
    capture the name sits at, since the left side runs up to the marker and the
    right side away from it.
    """
    text = normalize_character_name(capture)
    if not text:
        return ""
    if text in known:
        return known[text]
    best = ""
    for candidate in known:
        matches = text.endswith(candidate) if suffix else text.startswith(candidate)
        if matches and len(candidate) > len(best):
            best = candidate
    return known.get(best, "")


def find_explicit_aliases(
    text: str, known_names: Iterable[str] = ()
) -> set[tuple[str, str]]:
    """Return alias pairs the text states outright.

    Only an explicit statement licenses an alias link, because merging two names
    rewrites a primary key that assets and REST paths already point at.

    Both sides must resolve to a name the extraction actually found. The
    patterns cannot tell where a name begins in running prose, so an unresolved
    capture is prose, not a name — and an alias built from prose is written to
    the character table as though the text had stated it.

    The cost is a real alias going unrecorded when only one of its two names was
    ever extracted. That is the trade this module makes everywhere: a missing
    alias leaves a visible duplicate someone can merge, a wrong one silently
    renames a character.
    """
    known = {
        normalized: normalized
        for normalized in (
            normalize_character_name(name) for name in known_names
        )
        if normalized
    }
    if not known:
        return set()

    pairs: set[tuple[str, str]] = set()
    for pattern in _ALIAS_PATTERNS:
        for match in pattern.finditer(text or ""):
            first = _resolve_side(match.group("a"), known, suffix=True)
            second = _resolve_side(match.group("b"), known, suffix=False)
            if first and second and first != second:
                pairs.add((first, second))
    return pairs


def verify_evidence(
    quote: str, chunk: SourceChunk
) -> tuple[int, int] | None:
    """Locate a quote inside the chunk and return its absolute source offsets.

    A quote that is not present verbatim is rejected. This establishes that the
    line exists in this span, and nothing more — not that it is about the
    character it was returned for.
    """
    needle = (quote or "").strip()
    if not needle:
        return None
    local = chunk.text.find(needle)
    if local < 0:
        # Whitespace inside a quote is not meaningful here, and
        # models routinely normalize it. Retry ignoring it before rejecting.
        compact_needle = re.sub(r"\s+", "", needle)
        compact_text = re.sub(r"\s+", "", chunk.text)
        if not compact_needle or compact_needle not in compact_text:
            return None
        return (chunk.source_start, chunk.source_end)
    return (chunk.source_start + local, chunk.source_start + local + len(needle))


def build_character_chunk_prompt(chunk: SourceChunk, language: AssetLanguage) -> str:
    """The user message sent with CHARACTER_EXTRACTION_SYSTEM_PROMPT for one chunk."""
    return (
        f"{asset_language_instruction(language)}\n\n"
        f"[Chunk {chunk.section_label}]\n{chunk.text}"
    )


async def extract_characters_from_chunks(
    chunks: list[SourceChunk],
    *,
    agent: Any = None,
    concurrency: int | None = None,
    cached_outcomes: Optional[list] = None,
    source_text: str = "",
    roster: Optional[set] = None,
    adjudicate: bool = True,
    adjudication_agent: Any = None,
    on_log: Optional[Callable[[str], None]] = None,
    on_chunk_done: Optional[Callable[[SourceChunk, ChunkCharacterOutput], Any]] = None,
    on_chunk_failed: Optional[Callable[[SourceChunk, BaseException], Any]] = None,
    output_language: AssetLanguage | None = None,
) -> tuple[list[MergedCharacter], list[tuple[SourceChunk, BaseException]]]:
    """Extract and merge characters across chunks.

    Chunks are independent, so they run in parallel up to ``concurrency``. A
    chunk that fails is reported and skipped rather than failing the build: one
    unparseable scene must not discard every other scene's characters.
    """

    def log(message: str) -> None:
        if on_log:
            on_log(message)

    replayed = list(cached_outcomes or [])
    language = output_language or detect_asset_language(
        source_text
        or "\n".join(
            [
                *(chunk.text for chunk in chunks),
                *(chunk.text for chunk, _ in replayed),
            ]
        )
    )
    if not chunks:
        # Everything was replayed from a previous run; merging still has to run,
        # because merging is what turns per-chunk candidates into characters.
        merged = merge_character_candidates(replayed)
        if adjudicate:
            merged = await adjudicate_characters(
                merged, source_text=source_text, roster=roster,
                agent=adjudication_agent, on_log=log,
            )
        return merged, []

    runner = _create_character_extraction_agent(agent)

    async def analyse(chunk: SourceChunk) -> tuple[SourceChunk, ChunkCharacterOutput]:
        output = await _run_structured(runner, build_character_chunk_prompt(chunk, language))
        if on_chunk_done:
            await _maybe_await(on_chunk_done(chunk, output))
        return chunk, output

    failures: list[tuple[SourceChunk, BaseException]] = []

    def record_failure(chunk: SourceChunk, exc: BaseException) -> None:
        log(f"⚠️ Chunk {chunk.section_label} extraction failed, skipped: {exc}")
        failures.append((chunk, exc))

    outcomes = await map_bounded(
        chunks,
        analyse,
        limit=default_llm_concurrency() if concurrency is None else concurrency,
        on_error=record_failure,
    )
    # Reported after the batch so the callback may be async without turning the
    # error path inside map_bounded into an awaiting one.
    for chunk, exc in failures:
        if on_chunk_failed:
            await _maybe_await(on_chunk_failed(chunk, exc))

    succeeded = [outcome for outcome in outcomes if outcome is not None]
    log(f"Chunk extraction complete: {len(succeeded)}/{len(chunks)} succeeded")

    # Replayed chunks merge alongside fresh ones, so a resumed build produces
    # the same characters as an uninterrupted one.
    merged = merge_character_candidates(replayed + succeeded)
    if adjudicate:
        # Rules cannot see across chunks; this can. One call over the candidate
        # set, not another pass over the source.
        merged = await adjudicate_characters(
            merged, source_text=source_text, roster=roster,
            agent=adjudication_agent, on_log=log,
        )
    return merged, failures


def _source_of(outcomes: list[tuple[SourceChunk, ChunkCharacterOutput]]) -> str:
    """The text a name has to appear in, plus the cast lists the author wrote.

    Joined with a separator so a name cannot be formed across a chunk seam.
    """
    parts: list[str] = []
    for chunk, _output in outcomes:
        parts.append(chunk.text)
        parts.extend(str(listed) for listed in (chunk.characters or []))
    return "\n\x00\n".join(parts)


def name_is_attested(name: str, source: str) -> bool:
    """Whether the imported source writes this name at all.

    Verifying the quote does not establish this. A model can return a real
    sentence and attach a name that appears nowhere:

        text  : Lin Mo came home
        model : name=Wang Wu, evidence="Lin Mo came home"

    The quote verifies, so Wang Wu used to be accepted, and became a row in the
    character table — a primary key, a REST identifier and an asset directory,
    invented out of nothing.

    Checked against the whole source rather than the chunk that proposed the
    name, and that is the deliberate half of it. The stricter rule was measured
    against stored per-chunk outputs on both spines and dropped nothing at all,
    because the extraction prompt already asks for a form used in this span and
    the model obeys — so it buys little. What it changes is the direction of
    failure: in-chunk fails closed, and a misjudgement there deletes a real
    character that someone then has to re-enter. Source-wide fails open, and a
    misjudgement there files one quote against the wrong name — a provenance
    record, not a rename.

    Misattribution is not free, and it is worth naming what it can still do: an
    appellation offered by a single owner is taken at face value, so a name
    bound to the wrong line can put an alias on the wrong character. Only a
    contested appellation has to win a vote. That is a model-quality risk, and
    the way to reduce it is a better prompt or an adjudicator, not a guard that
    deletes characters when it is wrong.

    So the line drawn here is: invention cannot get in, misattribution can.
    Moving it further needs name-entity recognition and would still be wrong sometimes.
    """
    normalized = normalize_character_name(name)
    if not normalized:
        return False
    return normalized in source or str(name or "").strip() in source


def merge_character_candidates(
    outcomes: list[tuple[SourceChunk, ChunkCharacterOutput]],
) -> list[MergedCharacter]:
    """Merge per-chunk candidates using rules only, no model judgement.

    Identical names merge. Explicit alias statements merge. Everything else stays
    separate, because a wrong merge silently destroys data while a wrong split
    is a visible duplicate the user can fix.
    """
    merged: dict[str, MergedCharacter] = {}
    alias_pairs: set[tuple[str, str]] = set()
    # Only names that survive attestation may anchor an alias statement, and
    # they are pooled across chunks so a statement in one chunk can still
    # resolve a name another chunk established. Pooling the raw model output
    # instead would let a bad capture anchor itself: the model proposing
    # "Everyone knows Lin Mo" would license exactly the pair the anchoring exists to stop.
    source = _source_of(outcomes)
    # Only names that survive attestation may anchor an alias statement. Pooling
    # raw model output instead would let a bad capture anchor itself.
    proposed_names = {
        candidate.name
        for _chunk, output in outcomes
        for candidate in output.characters
        if name_is_attested(candidate.name, source)
        and not is_generic_address(normalize_character_name(candidate.name))
    }
    # appellation -> character -> the source positions attributing it there.
    appellation_claims: dict[str, dict[str, set[tuple[int, int]]]] = {}

    for chunk, output in outcomes:
        alias_pairs |= find_explicit_aliases(chunk.text, proposed_names)

        for candidate in output.characters:
            name = normalize_character_name(candidate.name)
            if not name or is_generic_address(name):
                continue

            # The name needs its own attestation, not just a verifiable quote.
            # Otherwise a real sentence can carry an invented name into the
            # table, which is the exact failure the quote check exists to stop.
            if not name_is_attested(name, source):
                continue

            verified: list[dict] = []
            for item in candidate.evidence:
                span = verify_evidence(item.quote, chunk)
                if span is None:
                    continue
                verified.append(
                    {
                        "chunk_id": chunk.chunk_id,
                        "source_start": span[0],
                        "source_end": span[1],
                        "evidence_kind": item.kind or "mention",
                        "evidence_text": item.quote.strip(),
                    }
                )

            # No verifiable quote means nothing in the source supports this
            # character. Drop it rather than trusting the model's assertion.
            if not verified:
                continue

            entry = merged.get(name)
            if entry is None:
                entry = MergedCharacter(name=name)
                merged[name] = entry

            entry.evidence.extend(verified)
            entry.chunk_ids.add(chunk.chunk_id)
            if not entry.gender and candidate.gender in {"male", "female"}:
                entry.gender = candidate.gender
            if not entry.description and candidate.description.strip():
                entry.description = candidate.description.strip()

            # An appellation is asserted with the whole chunk in view, which is
            # far more reliable than guessing across chunks — but it still has
            # to appear in the text, or it is not something anyone was called.
            # Attribution is settled later: a packed chunk holds several
            # characters, and the model does mix up who is called what.
            for appellation in candidate.appellations:
                normalized = normalize_character_name(appellation)
                if (
                    not normalized
                    or normalized == name
                    or is_generic_address(normalized)
                ):
                    continue
                # Votes are counted per position in the source, not per chunk.
                # Chunks overlap, so one occurrence sitting in an overlap would
                # otherwise be counted twice and clear the margin on its own.
                local = chunk.text.find(normalized)
                if local < 0:
                    continue
                span = (
                    chunk.source_start + local,
                    chunk.source_start + local + len(normalized),
                )
                appellation_claims.setdefault(normalized, {}).setdefault(
                    name, set()
                ).add(span)

            for alias in candidate.aliases:
                normalized_alias = normalize_character_name(alias)
                if not normalized_alias or normalized_alias == name:
                    continue
                # A model-proposed alias is only a suggestion unless the text
                # states it. Record it as ambiguity for the user to resolve.
                if (name, normalized_alias) in alias_pairs or (
                    normalized_alias,
                    name,
                ) in alias_pairs:
                    entry.aliases.add(normalized_alias)
                elif not is_generic_address(normalized_alias):
                    entry.ambiguous_with.add(normalized_alias)

    _apply_appellation_claims(merged, appellation_claims)
    _apply_explicit_alias_merges(merged, alias_pairs)
    _apply_title_qualified_merges(merged)
    return sorted(merged.values(), key=lambda item: (-len(item.evidence), item.name))


def _apply_appellation_claims(
    merged: dict[str, MergedCharacter],
    claims: dict[str, dict[str, set[tuple[int, int]]]],
) -> None:
    """Award a contested appellation to whoever the text repeatedly supports.

    One claimant is taken at face value. When several characters are offered the
    same nickname, the winner is decided by how many *distinct positions in the
    source* attributed it there — not by how much evidence each character has
    overall, which would simply hand every ambiguous form to the lead, and not
    by chunk count, since chunks overlap and one occurrence can fall in two.

    A win has to be decisive: at least two distinct occurrences, and a clear
    margin over the runner-up. Anything closer stays unassigned, because a wrong
    alias resolves confidently to the wrong person while a missing one merely
    fails to resolve.
    """
    for appellation, owners in claims.items():
        if appellation in merged:
            # Already a character in its own right, not an alias for anyone.
            continue
        live = {
            name: chunks for name, chunks in owners.items() if name in merged
        }
        if not live:
            continue
        if len(live) == 1:
            merged[next(iter(live))].aliases.add(appellation)
            continue

        ranked = sorted(live.items(), key=lambda kv: len(kv[1]), reverse=True)
        (winner, won), (_, runner_up) = ranked[0], ranked[1]
        if len(won) < _APPELLATION_MIN_OCCURRENCES:
            continue
        if len(won) < max(len(runner_up) * 2, len(runner_up) + 1):
            continue
        merged[winner].aliases.add(appellation)


def _apply_title_qualified_merges(merged: dict[str, MergedCharacter]) -> None:
    """Fold "Principal Wu Xiande" into "Wu Xiande" and keep the fuller form as an alias.

    Unlike the model-proposed aliases held back as suggestions, this is a purely
    textual containment test with a closed title vocabulary, so it cannot merge
    two people who merely share a surname.

    The better-evidenced name wins, which is usually the one the script actually
    uses in dialogue rather than the one-off formal introduction.
    """
    names = sorted(merged, key=len, reverse=True)
    for long_name in names:
        long_entry = merged.get(long_name)
        if long_entry is None:
            continue
        for short_name in names:
            short_entry = merged.get(short_name)
            if (
                short_entry is None
                or short_entry is long_entry
                or not title_qualified_of(long_name, short_name)
            ):
                continue

            primary, secondary = (
                (long_entry, short_entry)
                if len(long_entry.evidence) >= len(short_entry.evidence)
                else (short_entry, long_entry)
            )
            primary.aliases.add(secondary.name)
            primary.aliases |= secondary.aliases
            primary.aliases.discard(primary.name)
            primary.evidence.extend(secondary.evidence)
            primary.chunk_ids |= secondary.chunk_ids
            primary.ambiguous_with |= secondary.ambiguous_with
            primary.ambiguous_with.discard(primary.name)
            primary.ambiguous_with -= primary.aliases
            if not primary.gender:
                primary.gender = secondary.gender
            if not primary.description:
                primary.description = secondary.description
            merged.pop(secondary.name, None)
            break


def _apply_explicit_alias_merges(
    merged: dict[str, MergedCharacter], alias_pairs: set[tuple[str, str]]
) -> None:
    """Fold explicitly-stated aliases into their primary entry.

    The entry with more evidence wins the primary name, so the canonical record
    is the one the text actually develops rather than a passing nickname.
    """
    for first, second in alias_pairs:
        left = merged.get(first)
        right = merged.get(second)
        if left is None or right is None or left is right:
            # An alias statement naming someone who was never extracted still
            # registers on whichever side exists.
            if left is not None and second not in merged:
                left.aliases.add(second)
            elif right is not None and first not in merged:
                right.aliases.add(first)
            continue

        primary, secondary = (
            (left, right) if len(left.evidence) >= len(right.evidence) else (right, left)
        )
        primary.aliases.add(secondary.name)
        primary.aliases |= secondary.aliases
        primary.aliases.discard(primary.name)
        primary.evidence.extend(secondary.evidence)
        primary.chunk_ids |= secondary.chunk_ids
        primary.ambiguous_with |= secondary.ambiguous_with
        primary.ambiguous_with.discard(primary.name)
        primary.ambiguous_with -= primary.aliases
        if not primary.gender:
            primary.gender = secondary.gender
        if not primary.description:
            primary.description = secondary.description
        merged.pop(secondary.name, None)


async def _maybe_await(value: Any) -> Any:
    if hasattr(value, "__await__"):
        return await value
    return value


# ── ambiguity adjudication ──────────────────────────────────────────────────

# A candidate the model may fold into another. Anything better attested than
# this stands on its own: a wrong merge destroys a character silently, while a
# wrong split leaves a visible duplicate the user can remove.
_MERGEABLE_EVIDENCE_CEILING = 2

# Same idea for locations, counted in scenes rather than evidence spans.
_MERGEABLE_SCENE_OCCURRENCES = 2

# Enough of the text to recognise who is being talked about, without resending
# the script.
_ADJUDICATION_SAMPLE_QUOTES = 3

# Below this many mentions, a candidate is more likely an alias than a person in
# its own right, so it gets source context rather than a bare quote.
_CONTEXT_WINDOW_EVIDENCE_THRESHOLD = 6
_CONTEXT_WINDOW_CHARS = 220

# A contested appellation needs this many distinct source positions before it
# is awarded to anyone. A single occurrence is one turn of phrase, which is
# not enough to overrule a competing claim.
_APPELLATION_MIN_OCCURRENCES = 2


class SamePersonGroup(BaseModel):
    canonical_name: str = Field(description="Primary name of the group; must come from the candidate list")
    alias_names: list[str] = Field(
        default_factory=list, description="Other candidate names referring to the same person; must come from the candidate list"
    )
    reason: str = Field(default="", description="Basis for the decision, citing clues from the evidence")


class CharacterAdjudication(BaseModel):
    groups: list[SamePersonGroup] = Field(default_factory=list)
    non_characters: list[str] = Field(
        default_factory=list, description="Candidates that are not people at all, e.g. titles, groups, insults"
    )


ADJUDICATION_SYSTEM_PROMPT = """You are a character-merge adjudicator.

The input is the character candidates extracted chunk by chunk from the same work; each candidate comes with its number of occurrences in the source text and a few source quotes.

You have exactly two tasks:
1. Decide which candidates actually refer to the same person, group them, and pick the primary name.
2. Point out which candidates are not people at all.

Rules:
- Use only candidate names that appear in the input; never invent new names.
- canonical_name must be one of the candidates in the group; prefer the one that occurs most often in the source text and looks most like a formal full name.
- Merge only when the evidence really supports it. "Director Chen" and "Chen Qing" can be merged only if there are clues that they are the same person.
- Do not merge two candidates that both have plenty of independent evidence and show no link.
- Titles, job titles, groups and insults (such as "young lady", "campus bully", "jinx"), if they are only used to address a known character,
  should be folded into that character; if you cannot tell who they point to, put them in non_characters.
- If unsure, do not merge and do not put the candidate in non_characters. A missed merge only leaves a duplicate; a wrong merge destroys data."""


def _create_adjudication_agent(agent: Any = None):
    if agent is not None:
        return agent

    from pydantic_ai import Agent

    from novelvideo.config import (
        get_newapi_structured_output_model_settings,
        get_newapi_text_pydantic_model,
    )

    return Agent(
        get_newapi_text_pydantic_model(
            "CHARACTER_BUILD_MODEL",
            "gemini-3-flash-preview",
            capability="text.generate.agent",
        ),
        system_prompt=ADJUDICATION_SYSTEM_PROMPT,
        model_settings=get_newapi_structured_output_model_settings(),
        output_type=CharacterAdjudication,
        name="Structured Character Adjudicator",
    )


def _adjudication_prompt(
    merged: list[MergedCharacter], source_text: str = ""
) -> str:
    """Describe every candidate, with enough context to link nicknames to names.

    A quote on its own rarely proves identity: "Xiaoyang, you got into trouble again" does not
    contain "Zheng Xuyang". What does prove it is the surrounding text, where the
    formal name almost always appears nearby. Rarely-seen candidates therefore
    get a window of the source around their occurrences — the same co-occurrence
    signal a graph search would surface, taken straight from the text.
    """
    lines: list[str] = []
    for item in merged:
        detail = f"- {item.name} (appears {len(item.evidence)} times)"
        if item.gender:
            detail += f", gender {item.gender}"
        if item.description:
            detail += f", {item.description}"
        lines.append(detail)

        rare = len(item.evidence) <= _CONTEXT_WINDOW_EVIDENCE_THRESHOLD
        shown = item.evidence if rare else item.evidence[:_ADJUDICATION_SAMPLE_QUOTES]
        for evidence in shown:
            if rare and source_text:
                start = max(0, int(evidence["source_start"]) - _CONTEXT_WINDOW_CHARS)
                end = min(len(source_text), int(evidence["source_end"]) + _CONTEXT_WINDOW_CHARS)
                window = source_text[start:end].replace("\n", " ")
                lines.append(f"    Context: ...{window}...")
            else:
                lines.append(f"    Source: {evidence['evidence_text']}")
    return (
        "Below are the character candidates from the same work. Candidates with few occurrences are usually a nickname, "
        "job title or honorific of a major character; use the context to decide who each one points to:\n" + "\n".join(lines)
    )


def _roster_protects(name: str, roster: set[str]) -> bool:
    """Whether a scene's cast list names this character.

    A cast list is written by the author, not inferred, so a name appearing in
    one is a fact about the script. Such a character is never merged away.
    """
    if not name:
        return False
    return any(name == entry or name in entry for entry in roster)


async def adjudicate_characters(
    merged: list[MergedCharacter],
    *,
    source_text: str = "",
    roster: Optional[set[str]] = None,
    agent: Any = None,
    on_log: Optional[Callable[[str], None]] = None,
) -> list[MergedCharacter]:
    """Resolve cross-chunk identity that per-chunk extraction cannot see.

    Rules can merge identical names and stated aliases, but nothing in a single
    chunk reveals that "Mrs. Zheng" is "Zheng Yuqin" -- that only shows up when the whole
    candidate set is considered at once. This is one call over the candidates
    and their evidence, not another pass over the source.

    The adjudicator may only group names it was given, so it cannot invent a
    character, and it cannot delete a well-evidenced one.
    """

    def log(message: str) -> None:
        if on_log:
            on_log(message)

    if len(merged) < 2:
        return merged

    by_name = {item.name: item for item in merged}
    try:
        result = (await _create_adjudication_agent(agent).run(
            _adjudication_prompt(merged, source_text)
        )).output
    except Exception as exc:  # noqa: BLE001 - degrade to the rule-only result
        log(f"⚠️ Adjudication failed, keeping the rule-based merge result: {exc}")
        return merged

    cast = roster or set()
    removed: set[str] = set()

    def may_merge_away(candidate: MergedCharacter) -> bool:
        """Whether this candidate is weak enough to be folded into another."""
        if _roster_protects(candidate.name, cast):
            return False
        return len(candidate.evidence) <= _MERGEABLE_EVIDENCE_CEILING

    for group in result.groups:
        members = [
            by_name[name]
            for name in (
                normalize_character_name(n)
                for n in [group.canonical_name, *group.alias_names]
            )
            if name in by_name and by_name[name].name not in removed
        ]
        if len(members) < 2:
            continue

        # The canonical name is decided here, not by the model: a cast-list name
        # wins, then the best-attested one. Left to the model, a formal name can
        # end up folded into a passing nickname.
        primary = max(
            members,
            key=lambda item: (
                _roster_protects(item.name, cast),
                len(item.evidence),
            ),
        )
        for secondary in members:
            if secondary is primary or secondary.name in removed:
                continue
            if not may_merge_away(secondary):
                log(
                    f"  Refused to merge {secondary.name} → {primary.name}: "
                    f"{len(secondary.evidence)} piece(s) of evidence"
                    f"{', and appears in the scene cast list' if _roster_protects(secondary.name, cast) else ''}"
                )
                continue
            primary.aliases.add(secondary.name)
            primary.aliases |= secondary.aliases
            primary.aliases.discard(primary.name)
            primary.evidence.extend(secondary.evidence)
            primary.chunk_ids |= secondary.chunk_ids
            primary.ambiguous_with |= secondary.ambiguous_with
            primary.ambiguous_with -= primary.aliases
            primary.ambiguous_with.discard(primary.name)
            if not primary.gender:
                primary.gender = secondary.gender
            if not primary.description:
                primary.description = secondary.description
            removed.add(secondary.name)
            log(f"  Merged {secondary.name} → {primary.name}")

    # Reported, never acted on. Every candidate here already survived
    # verification against the source, so discarding one trades a visible
    # duplicate for an invisible omission — the wrong way round for a first
    # release. Surfacing the call lets the rule be tuned on real data first.
    for name in result.non_characters:
        item = by_name.get(normalize_character_name(name))
        if item is not None and item.name not in removed:
            log(f"  Adjudicator considers this not a character (recorded only, not removed): {item.name}")

    survivors = [item for item in merged if item.name not in removed]
    log(f"Adjudication complete: {len(merged)} → {len(survivors)} characters")
    return sorted(survivors, key=lambda item: (-len(item.evidence), item.name))


# ── character appearance ────────────────────────────────────────────────────
#
# Extraction and appearance are two different contracts, deliberately kept
# apart.  Extraction is evidence-bound: every field it reports has to appear
# verbatim in the span it came from, which is what stops an invented character
# from entering the table.  A face prompt, a role, a build and an age band are
    # none of them quotable -- a screenplay writes "ZHENG JIAYUE" and what she does, not
# what her jaw looks like — so folding them into CharacterCandidate would mean
# relaxing the very guard that makes extraction trustworthy.
#
# So this stage runs after the cast is settled, takes only names that already
# survived verification, and is allowed to write what the source implies rather
# than what it states.  It is the half of legacy's CharacterEnrichment that
# structured extraction never carried over; scenes have had their equivalent
# since the beginning (``enrich_scene_environments_batched``), which is why
# scene builds produce usable prompts and character builds did not.


class CharacterAppearance(BaseModel):
    name: str = Field(description="Primary character name; must exactly match the given character name")
    role: str = Field(default="", description="Character role, e.g. protagonist, best friend, ex-boyfriend, empress")
    is_main: bool = Field(default=False, description="Whether this is the narration protagonist / first-person narrator")
    age_group: str = Field(
        default="youth", description="Age group; must be one of child / youth / middle / elder"
    )
    body_type: str = Field(default="", description="Body type description, e.g. slender and tall, sturdy and muscular, petite and delicate")
    face_prompt: str = Field(
        default="", description="Pure facial feature description (hairstyle, eyes, skin tone, face shape), no clothing"
    )


class CharacterAppearanceList(BaseModel):
    characters: list[CharacterAppearance] = Field(default_factory=list)


CHARACTER_APPEARANCE_SYSTEM_PROMPT = """You are a character appearance designer. The input is a set of characters already confirmed in a work, together with source-text excerpts about them.

Fill in the appearance design for each character. Reasonable inference is allowed in this step, but it must be consistent with the given source excerpts and must not contradict the source text.
role, body_type and face_prompt must use the output language specified in the user message.

For each character give:
1. name: must match the character name given in the input verbatim; do not rewrite, translate or merge it.
2. role: the character's role (e.g. protagonist, best friend, ex-boyfriend, empress, homeroom teacher).
3. is_main: whether this is the narration protagonist / first-person narrator. At most one in the whole batch may be true; if you cannot tell, fill false for all.
4. age_group: must be one of child / youth / middle / elder.
   Do not split a character's childhood/old-age forms; use the age group of the period that matters most in the story.
5. body_type: body type description.
6. face_prompt: pure facial feature description.
   Format: [gender], [age group], [hairstyle and color], [eye features], [skin tone], [face shape / bone structure]
   Example: "Female, in her twenties, long black ponytail, black almond eyes, wheat-colored skin, oval face"
   ⚠️ Never describe clothing, accessories or scenes in face_prompt. Clothing is handled separately by later identity planning.

Do not add, remove or merge characters. Return exactly as many as the input gives."""


def _create_character_appearance_agent(agent: Any = None):
    if agent is not None:
        return agent

    from pydantic_ai import Agent

    from novelvideo.config import (
        get_newapi_structured_output_model_settings,
        get_newapi_text_pydantic_model,
    )

    return Agent(
        get_newapi_text_pydantic_model(
            "CHARACTER_BUILD_MODEL",
            "gemini-3-flash-preview",
            capability="text.generate.agent",
        ),
        system_prompt=CHARACTER_APPEARANCE_SYSTEM_PROMPT,
        model_settings=get_newapi_structured_output_model_settings(),
        output_type=CharacterAppearanceList,
        name="Structured Character Appearance",
    )


# Bump whenever the prompt, the accepted age bands, or the way an answer is
# turned into stored fields changes.  It is part of every cache key, so a bump
# retires stored results rather than mixing two contracts.
#
# 2: ``is_main`` left the payload for the cast-level key below.
CHARACTER_APPEARANCE_CACHE_VERSION = 3

CHARACTER_APPEARANCE_CACHE_TYPE = "character_appearance"

AGE_GROUPS = ("child", "youth", "middle", "elder")

_APPEARANCE_BATCH_SIZE = 5

# How many evidence quotes one character contributes to the prompt. Enough to
# place them in the story, few enough that a batch of five stays short.
_APPEARANCE_SAMPLE_QUOTES = 4


def normalize_age_group(value: str) -> str:
    """Coerce a model answer to one of the four bands stored on a character.

    The band is not free text: ``get_fish_voice_id`` selects a voice from it
    and identity planning derives per-identity bands from it, so an unknown
    value would silently disable both rather than fail loudly.
    """
    cleaned = str(value or "").strip().lower()
    return cleaned if cleaned in AGE_GROUPS else "youth"


def character_appearance_cache_key(
    item: "MergedCharacter",
    synopsis: str = "",
    output_language: AssetLanguage | None = None,
) -> str:
    """Hash the exact input one character's appearance call is made from.

    Every field the model sees, plus the contract version.  Quotes are included
    in the order and count the prompt actually sends: a character whose
    evidence changed is a character the model would answer differently about.
    The synopsis is project-wide, so editing a script's character bios retires
    every stored appearance — which is right, since that block is what most of
    them were written from.
    """
    language = output_language or detect_asset_language(
        "\n".join(
            [
                item.name,
                item.description,
                *sorted(item.aliases),
                *_appearance_quotes(item),
                str(synopsis or ""),
            ]
        )
    )
    payload = {
        "v": CHARACTER_APPEARANCE_CACHE_VERSION,
        "language": language,
        "name": item.name,
        "aliases": sorted(item.aliases),
        "gender": item.gender,
        "description": item.description,
        "quotes": _appearance_quotes(item),
        "synopsis": str(synopsis or ""),
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _appearance_quotes(item: "MergedCharacter") -> list[str]:
    quotes: list[str] = []
    for entry in item.evidence:
        quote = str((entry or {}).get("quote") or "").strip()
        if quote:
            quotes.append(quote)
        if len(quotes) >= _APPEARANCE_SAMPLE_QUOTES:
            break
    return quotes


def appearance_to_cache_payload(appearance: CharacterAppearance) -> str:
    """Store everything about a character except who the narrator is.

    Every other field is a property of one character and is keyed on that
    character's own inputs, so a stored answer stays true for as long as those
    inputs do.  ``is_main`` is not: it ranks one character against the whole
    cast, and the key cannot see the cast.  Adding, removing or re-adjudicating
    somebody else would leave the key identical and replay a nomination that
    the new cast may have overtaken — and ``_enforce_single_main`` would then
    keep the stale one, because it settles ties rather than re-deciding.

    So the nomination is never stored.  A character served from the cache
    abstains, and only characters actually asked this run can claim it.
    """
    return json.dumps(
        {
            "name": appearance.name,
            "role": appearance.role,
            "age_group": appearance.age_group,
            "body_type": appearance.body_type,
            "face_prompt": appearance.face_prompt,
        },
        ensure_ascii=False,
    )


def is_usable_appearance(appearance: CharacterAppearance) -> bool:
    """Whether an answer is worth storing and publishing.

    The face prompt is the field the portrait runner refuses to work without
    (``task_backend/runners/character_image.py``), so an answer that omits it
    has not done the job.  Caching one would make the omission permanent, the
    same trap ``is_cacheable_scene_prompt`` guards against on the scene side.
    """
    return bool(str(appearance.face_prompt or "").strip())


def appearance_from_cache_payload(payload: str) -> CharacterAppearance | None:
    """Rebuild an appearance from a stored row, or None if it is unusable.

    A row that no longer parses, or that carries an answer the current contract
    would reject, is treated as a miss: a cache must never publish something
    the live path would have thrown away.
    """
    try:
        data = json.loads(payload)
    except (TypeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    appearance = CharacterAppearance(
        name=str(data.get("name") or ""),
        role=str(data.get("role") or ""),
        # Stated rather than left to a missing key: a nomination never comes
        # from a per-character row, for the reason the payload docstring gives.
        is_main=False,
        age_group=normalize_age_group(data.get("age_group", "")),
        body_type=str(data.get("body_type") or ""),
        face_prompt=str(data.get("face_prompt") or ""),
    )
    return appearance if is_usable_appearance(appearance) else None


CHARACTER_NARRATOR_CACHE_TYPE = "character_narrator"


def narrator_cache_key(fingerprints: list[str]) -> str:
    """Hash every input the cast decision was made from, in cast order.

    The per-character cache keys, not the names.  Names alone survive a changed
    description, a changed quote and an edited character bible, so a run whose
    fresh answers happened to nominate nobody could fall back on a decision
    made from inputs that no longer exist.  Each fingerprint already covers one
    character's whole input including the shared synopsis, so the ordered list
    of them is the cast decision's full dependency.
    """
    payload = {"v": CHARACTER_APPEARANCE_CACHE_VERSION, "cast": list(fingerprints)}
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _nominee(appearances: dict[str, CharacterAppearance], order: list[str]) -> str:
    """The nominated character earliest in cast order, or "" for none."""
    for name in order:
        appearance = appearances.get(name)
        if appearance is not None and appearance.is_main:
            return name
    return ""


def narrator_vote_key(cast_key: str, character_key: str) -> str:
    """One key per (cast, nominee), so batches cannot overwrite each other.

    A single shared key made the surviving nomination a function of which
    batch finished last.  Batches run concurrently and each sees only its own
    five characters, so more than one may legitimately nominate; the last
    writer is not the cast-order winner, and a crash before the run could
    settle them would recover whoever happened to be last.

    Giving every nominee its own key removes the race instead of resolving it
    afterwards: nothing is overwritten, and the reduce happens on read, in
    cast order, which is the same rule ``_enforce_single_main`` applies in
    memory.  The cast fingerprint is part of the key, so a changed cast retires
    every vote with it.
    """
    payload = {
        "v": CHARACTER_APPEARANCE_CACHE_VERSION,
        "cast": cast_key,
        "character": character_key,
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


async def _record_narrator_votes(
    cache: Any,
    cast_key: str,
    keys: dict[str, str],
    produced: dict[str, CharacterAppearance],
    order: list[str],
) -> None:
    """Persist this batch's nominations, ahead of the rows that replay it."""
    rows = {
        narrator_vote_key(cast_key, keys[name]): json.dumps(
            {"name": name}, ensure_ascii=False
        )
        for name in order
        if name in produced and produced[name].is_main
    }
    if rows:
        await _maybe_await(cache.save(CHARACTER_NARRATOR_CACHE_TYPE, rows))


async def _recover_narrator(
    cache: Any,
    cast_key: str,
    keys: dict[str, str],
    order: list[str],
    answered: dict[str, CharacterAppearance],
) -> str:
    """The earliest nominee in cast order that any attempt ever recorded.

    Restricted to characters this run actually has an appearance for: a vote
    for somebody adjudication has since merged away, or whose own row failed
    this time, must not resurrect them.
    """
    by_name = {
        name: narrator_vote_key(cast_key, keys[name])
        for name in order
        if name in answered
    }
    stored = await _maybe_await(
        cache.get(CHARACTER_NARRATOR_CACHE_TYPE, list(by_name.values()))
    )
    for name in order:
        if name in by_name and by_name[name] in (stored or {}):
            return name
    return ""


async def _settle_narrator_nomination(
    appearances: dict[str, CharacterAppearance],
    order: list[str],
    cache: Any,
    cast_key: str,
    keys: dict[str, str],
) -> None:
    """Decide the narrator from every vote this cast has ever attracted.

    Nominations are not kept in the per-character rows, so a character
    replayed from the cache abstains in memory however loudly an earlier
    attempt nominated it.  Reading the votes only when this run happens to
    nominate nobody is therefore not enough: a build stopped partway records
    an early character's vote and its row, and the retry pairs that silent
    replay with a freshly nominated later character.  Taking the in-memory
    answer there would hand a resumed build a different narrator from an
    uninterrupted one, for no reason the source text supports.

    Batches write their votes ahead of the rows that make them look finished,
    so by the time this runs the votes are a superset of what is in memory.
    Reducing over them in cast order — the same rule ``_enforce_single_main``
    applies — is what makes the answer independent of where a build was
    interrupted, and of the order its batches happened to finish in.
    """
    _enforce_single_main(appearances, order)
    if cache is None or not order:
        return
    winner = await _recover_narrator(cache, cast_key, keys, order, appearances)
    for name, appearance in appearances.items():
        appearance.is_main = name == winner


def _enforce_single_main(
    appearances: dict[str, CharacterAppearance],
    order: list[str],
) -> None:
    """Keep at most one narrator, in a batch-independent order.

    Characters are enriched in batches that run concurrently, so "the first one
    the model marked" is not a stable answer.  Resolving in the caller's order
    makes a rebuild pick the same narrator a fresh build did.
    """
    seen = False
    for name in order:
        appearance = appearances.get(name)
        if appearance is None or not appearance.is_main:
            continue
        if seen:
            appearance.is_main = False
        else:
            seen = True


async def enrich_character_appearances(
    merged: list["MergedCharacter"],
    *,
    synopsis: str = "",
    agent: Any = None,
    cache: Any = None,
    on_log: Optional[Callable[[str], None]] = None,
    concurrency: Optional[int] = None,
    output_language: AssetLanguage | None = None,
) -> dict[str, CharacterAppearance]:
    """Write the creative half of a character: face, role, build, age band.

    Returns one entry per character the stage could answer for.  A character
    the model failed on is simply absent rather than filled with a placeholder:
    an empty face prompt is a visible, fixable gap, while boilerplate is an
    invisible one that every later rebuild would replay.

    With a ``cache``, a character whose input already produced a usable answer
    is served from it and never sent to the model, so an interrupted build
    keeps everything it has already paid for.
    """

    def log(message: str) -> None:
        if on_log:
            on_log(message)

    if not merged:
        return {}

    language = output_language or detect_asset_language(
        "\n".join(
            [
                str(synopsis or ""),
                *(
                    value
                    for item in merged
                    for value in [
                        item.name,
                        item.description,
                        *sorted(item.aliases),
                        *_appearance_quotes(item),
                    ]
                ),
            ]
        )
    )
    order = [item.name for item in merged]
    keys = {
        item.name: character_appearance_cache_key(item, synopsis, language)
        for item in merged
    }
    results: dict[str, CharacterAppearance] = {}

    if cache is not None:
        stored = await _maybe_await(
            cache.get(CHARACTER_APPEARANCE_CACHE_TYPE, list(keys.values()))
        )
        for item in merged:
            payload = (stored or {}).get(keys[item.name])
            appearance = appearance_from_cache_payload(payload) if payload else None
            if appearance is not None:
                results[item.name] = appearance
        if results:
            log(f"Reusing {len(results)} character appearance designs, no model call")

    pending = [item for item in merged if item.name not in results]
    narrator_key = narrator_cache_key([keys[name] for name in order])

    if not pending:
        await _settle_narrator_nomination(results, order, cache, narrator_key, keys)
        return results

    llm = _create_character_appearance_agent(agent)
    # A screenplay's pre-scene block is its character bible — it names hair,
    # build and bearing outright. Extraction already chunks it, but only as one
    # span among many; handing it to this stage whole is what legacy did, and
    # it is the densest appearance source the source text has.
    synopsis_section = f"\n\n[Original synopsis and character-setting text of the script]\n{synopsis}" if synopsis else ""

    def describe(item: "MergedCharacter") -> str:
        aliases = ", ".join(sorted(item.aliases)) or "none"
        quotes = "\n".join(f"- {quote}" for quote in _appearance_quotes(item)) or "- none"
        return (
            f"### Character: {item.name}\n"
            f"Aliases: {aliases}\n"
            f"Gender: {item.gender or 'unknown'}\n"
            f"Known description: {item.description or 'none'}\n"
            f"Source excerpts:\n{quotes}"
        )

    async def run_batch(batch: list["MergedCharacter"]) -> dict[str, CharacterAppearance]:
        prompt = (
            asset_language_instruction(language)
            + "\n\nFill in the appearance design for each of the characters below. "
            "name must exactly match the given character name; do not merge or omit any:\n\n"
            + "\n\n".join(describe(item) for item in batch)
            + synopsis_section
        )
        produced: dict[str, CharacterAppearance] = {}
        try:
            result = (await llm.run(prompt)).output
            by_name = {
                normalize_character_name(entry.name): entry
                for entry in (result.characters or [])
            }
        except Exception as exc:  # noqa: BLE001 - a failed batch degrades, never raises
            log(f"⚠️ Character appearance design failed ({len(batch)} characters): {exc}")
            return produced

        for item in batch:
            entry = by_name.get(normalize_character_name(item.name))
            if entry is None:
                continue
            # The model answers under whatever spelling it echoed back; the
            # stored row is keyed by the settled name, which is a primary key.
            appearance = CharacterAppearance(
                name=item.name,
                role=entry.role,
                is_main=entry.is_main,
                age_group=normalize_age_group(entry.age_group),
                body_type=entry.body_type,
                face_prompt=entry.face_prompt,
            )
            if is_usable_appearance(appearance):
                produced[item.name] = appearance

        if cache is not None and produced:
            # Order matters between these two writes. A batch's rows are what
            # make it look finished to the next run, and the nomination is not
            # in them, so writing the rows first opens a window where a crash
            # leaves every character replayable and the answer gone — the retry
            # then abstains with nothing left to consult. Writing the
            # nomination first inverts that: a crash in between leaves the
            # batch pending, and the retry asks the question again.
            await _record_narrator_votes(cache, narrator_key, keys, produced, order)
            # Written per batch rather than once at the end, so a build killed
            # halfway keeps what it already paid for.
            await _maybe_await(
                cache.save(
                    CHARACTER_APPEARANCE_CACHE_TYPE,
                    {
                        keys[name]: appearance_to_cache_payload(appearance)
                        for name, appearance in produced.items()
                    },
                )
            )
        return produced

    batches = [
        pending[start : start + _APPEARANCE_BATCH_SIZE]
        for start in range(0, len(pending), _APPEARANCE_BATCH_SIZE)
    ]
    outcomes = await map_bounded(
        batches,
        run_batch,
        limit=default_llm_concurrency() if concurrency is None else concurrency,
    )
    for outcome in outcomes:
        if isinstance(outcome, dict):
            results.update(outcome)

    missing = [item.name for item in merged if item.name not in results]
    if missing:
        log(f"⚠️ {len(missing)} characters got no appearance design; face prompts left empty: {', '.join(missing[:5])}")
    log(f"Appearance design complete: {len(results)}/{len(merged)} characters")

    await _settle_narrator_nomination(results, order, cache, narrator_key, keys)
    return results


# ── scene adjudication ──────────────────────────────────────────────────────


class SameLocationGroup(BaseModel):
    canonical_name: str = Field(description="Primary name of the group; must come from the candidate list")
    alias_names: list[str] = Field(
        default_factory=list, description="Other candidate names referring to the same location; must come from the candidate list"
    )
    reason: str = Field(default="", description="Basis for the decision")


class SceneAdjudication(BaseModel):
    groups: list[SameLocationGroup] = Field(default_factory=list)


SCENE_ADJUDICATION_SYSTEM_PROMPT = """You are a scene-merge adjudicator.

The input is the location candidates parsed from the scene headings of the same screenplay; each comes with the number of scenes it appears in.

You have exactly one task: decide which candidates are actually the same physical location, group them, and pick the primary name.

Rules:
- Use only candidate names that appear in the input; never invent new names.
- canonical_name must be one of the candidates in the group; prefer the one that appears in the most scenes and is the most complete and specific.
- Merge different spellings of the same location, e.g. "dance studio in front of the mirror" and "dance studio at the mirror",
  "Zheng Yuqin's office" and "inside Zheng Yuqin's office", "school classroom" and "Mingmen Advanced Talent Academy classroom".
- Different rooms in the same building are different locations and must never be merged:
  "Zheng family villa living room" and "Zheng family villa dining room" are two scenes, and so are "outside the Zheng family villa" and "Zheng family villa living room".
- Time, weather and damage state do not make a new location, but the candidates here are already base locations, so ignore those.
- If unsure, do not merge. Keeping one extra duplicate scene only costs redundant assets; a wrong merge makes two different dramatic locations share one scene image."""


def _create_scene_adjudication_agent(agent: Any = None):
    if agent is not None:
        return agent

    from pydantic_ai import Agent

    from novelvideo.config import (
        get_newapi_structured_output_model_settings,
        get_newapi_text_pydantic_model,
    )

    return Agent(
        get_newapi_text_pydantic_model(
            "SCENE_BUILD_MODEL",
            "gemini-3-flash-preview",
            capability="text.generate.agent",
        ),
        system_prompt=SCENE_ADJUDICATION_SYSTEM_PROMPT,
        model_settings=get_newapi_structured_output_model_settings(),
        output_type=SceneAdjudication,
        name="Structured Scene Adjudicator",
    )


SCENE_ADJUDICATION_CACHE_VERSION = 1

SCENE_ADJUDICATION_CACHE_TYPE = "scene_adjudication"


async def adjudicate_scenes(
    scenes: list,
    *,
    occurrences: Optional[dict] = None,
    agent: Any = None,
    on_log: Optional[Callable[[str], None]] = None,
    cache: Any = None,
) -> list:
    """Fold differently-written spellings of one location into a single scene.

    Scene headings are written by hand, so the same room appears as
    "Zheng Yuqin's office" and "inside Zheng Yuqin's office". Each spelling otherwise becomes its own
    base scene with its own generated art.

    Unlike character adjudication this never drops a candidate. A duplicate
    scene is redundant art; a missing one leaves shots with no location asset,
    and nothing in the UI would show what went missing.
    """

    def log(message: str) -> None:
        if on_log:
            on_log(message)

    if len(scenes) < 2:
        return scenes

    counts = occurrences or {}
    by_name = {scene.name: scene for scene in scenes}
    listing = "\n".join(
        f"- {scene.name} (appears in {counts.get(scene.name, 0)} scenes)"
        f"{', aliases ' + ', '.join(scene.aliases) if scene.aliases else ''}"
        for scene in scenes
    )

    # Only the model's grouping is cached, never the merge that follows it. The
    # occurrence ceiling and the canonical-name choice are code, so re-applying
    # them to a cached grouping is free and always uses the current rules.
    cache_key = hashlib.sha256(
        json.dumps(
            {"v": SCENE_ADJUDICATION_CACHE_VERSION, "listing": listing},
            ensure_ascii=False,
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()

    groups: list | None = None
    if cache is not None:
        payload = (
            await cache.get(SCENE_ADJUDICATION_CACHE_TYPE, [cache_key])
        ).get(cache_key)
        if payload:
            try:
                groups = [
                    SimpleNamespace(
                        canonical_name=str(item.get("canonical_name") or ""),
                        alias_names=list(item.get("alias_names") or []),
                    )
                    for item in json.loads(payload)
                ]
            except (TypeError, ValueError, AttributeError):
                groups = None
            if groups is not None:
                log(f"Reusing the previous scene adjudication grouping: {len(groups)} groups, no model call")

    if groups is None:
        try:
            result = (await _create_scene_adjudication_agent(agent).run(
                "Below are the location candidates from the same screenplay:\n" + listing
            )).output
        except Exception as exc:  # noqa: BLE001 - degrade to the unmerged result
            log(f"⚠️ Scene adjudication failed, keeping the original scenes: {exc}")
            return scenes
        groups = list(result.groups)
        if cache is not None:
            await cache.save(
                SCENE_ADJUDICATION_CACHE_TYPE,
                {
                    cache_key: json.dumps(
                        [
                            {
                                "canonical_name": group.canonical_name,
                                "alias_names": list(group.alias_names or []),
                            }
                            for group in groups
                        ],
                        ensure_ascii=False,
                    )
                },
            )

    removed: set[str] = set()
    for group in groups:
        members = [
            by_name[name]
            for name in (
                str(n or "").strip()
                for n in [group.canonical_name, *group.alias_names]
            )
            if name in by_name and by_name[name].name not in removed
        ]
        if len(members) < 2:
            continue

        # Decided here rather than by the model: the spelling the script uses
        # most is the canonical one.
        primary = max(members, key=lambda s: counts.get(s.name, 0))
        for secondary in members:
            if secondary is primary or secondary.name in removed:
                continue
            # A location the script keeps returning to is a real place, not a
            # spelling variant. Folding one away would leave those scenes
            # pointing at another room's art.
            if counts.get(secondary.name, 0) > _MERGEABLE_SCENE_OCCURRENCES:
                log(
                    f"  Refused to merge scene {secondary.name} → {primary.name}: "
                    f"appears in {counts.get(secondary.name, 0)} scenes"
                )
                continue
            merged_aliases = list(primary.aliases)
            for candidate in [secondary.name, *secondary.aliases]:
                if candidate != primary.name and candidate not in merged_aliases:
                    merged_aliases.append(candidate)
            primary.aliases = merged_aliases
            removed.add(secondary.name)
            log(f"  Merged scene {secondary.name} → {primary.name}")

    survivors = [scene for scene in scenes if scene.name not in removed]
    log(f"Scene adjudication complete: {len(scenes)} → {len(survivors)}")
    return survivors
