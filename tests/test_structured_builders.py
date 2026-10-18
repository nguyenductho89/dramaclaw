"""structured_v1 project-level builds: characters, scenes, props.

The rules under test are the conservative ones. A character name is at once a
SQLite primary key, a REST identifier and an asset directory name, so the
merging rules must refuse to guess, and evidence must be verifiable against the
source or the candidate never reaches the table.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.knowledge_pipeline import KNOWLEDGE_PIPELINE_KEY, KNOWLEDGE_PIPELINE_STRUCTURED
from novelvideo.story_analysis import SourceChunk, chunk_source_text
from novelvideo.structured_extraction import (
    CharacterCandidate,
    CharacterEvidence,
    ChunkCharacterOutput,
    extract_characters_from_chunks,
    find_explicit_aliases,
    is_generic_address,
    merge_character_candidates,
    normalize_character_name,
    verify_evidence,
)

NARRATED_TEXT = """Chapter 1 Homecoming

Lin Mo returned to his hometown after ten years away. The streets were just as before.
His mother waited for him at the door.

Chapter 2 Old Friend

Lin Mo, also known as Xiao Mo. The villagers all call him that.
He met Su Qing at the mouth of the alley.

Chapter 3 The Truth

Su Qing told Lin Mo a secret.
His mother fell silent for a long time after hearing it.
"""


def _padded(body: str) -> str:
    """Pad a chapter past the packing target so it stays its own chunk."""
    return body + "\n" + "Filler narration. " * 640 + "\n"


NARRATED_MULTI = (
    "Chapter 1 Homecoming\n\n" + _padded("Lin Mo returned to his hometown after ten years away. His mother waited for him at the door.")
    + "\nChapter 2 Old Friend\n\n" + _padded("Lin Mo, also known as Xiao Mo. The villagers all call him that. He met Su Qing at the mouth of the alley.")
    + "\nChapter 3 The Truth\n\n" + _padded("Su Qing told Lin Mo a secret. His mother fell silent for a long time after hearing it.")
)


def _chunk(text: str, *, chunk_id="c0", start=0) -> SourceChunk:
    return SourceChunk(
        chunk_id=chunk_id,
        chunk_index=0,
        section_type="chapter",
        section_label="Chapter 1",
        source_start=start,
        source_end=start + len(text),
        text=text,
    )


def _candidate(name, *, quotes=(), aliases=(), gender="", description=""):
    return CharacterCandidate(
        name=name,
        aliases=list(aliases),
        gender=gender,
        description=description,
        evidence=[CharacterEvidence(quote=quote) for quote in quotes],
    )


def _disable_appearance_enrichment(monkeypatch) -> None:
    """Keep extraction/run-state tests independent from the appearance model."""

    async def no_appearance_enrichment(*_args, **_kwargs):
        return {}

    monkeypatch.setattr(
        "novelvideo.structured_extraction.enrich_character_appearances",
        no_appearance_enrichment,
    )


# ── name normalization ──────────────────────────────────────────────────────


def test_normalize_strips_punctuation_noise_without_altering_the_name():
    assert normalize_character_name("\u3000Lin Mo:") == "Lin Mo"
    assert normalize_character_name(""Su Qing"") == "Su Qing"
    assert normalize_character_name("Lin  Mo") == "Lin  Mo"


def test_titles_and_kinship_terms_are_generic():
    for term in ("mother", "Your Majesty", "doctor", "he", "boy"):
        assert is_generic_address(term)
    assert not is_generic_address("Lin Mo")


# ── evidence verification ───────────────────────────────────────────────────


def test_evidence_resolves_to_absolute_source_offsets():
    chunk = _chunk("Lin Mo returned to his hometown.", start=100)
    span = verify_evidence("Lin Mo returned to his hometown.", chunk)
    assert span == (100, 100 + len("Lin Mo returned to his hometown."))


def test_evidence_not_present_in_the_chunk_is_rejected():
    """This check is what stops an invented character reaching the table."""
    chunk = _chunk("Lin Mo returned to his hometown.")
    assert verify_evidence("Lin Mo is actually the emperor's illegitimate son.", chunk) is None


def test_evidence_tolerates_whitespace_the_model_normalized():
    chunk = _chunk("Lin Mo  returned   to his hometown.")
    assert verify_evidence("Lin Mo returned to his hometown.", chunk) is not None


def test_empty_quote_is_rejected():
    assert verify_evidence("   ", _chunk("Lin Mo returned to his hometown.")) is None


# ── explicit alias detection ────────────────────────────────────────────────


def test_explicit_alias_statements_are_detected():
    assert ("Lin Mo", "Xiao Mo") in find_explicit_aliases(
        "Lin Mo, also known as Xiao Mo. The villagers all call him that.", ["Lin Mo", "Xiao Mo"]
    )
    assert ("Xiao Jue", "Your Majesty") in find_explicit_aliases("Xiao Jue, better known as His Majesty.", ["Xiao Jue", "Your Majesty"])


def test_an_alias_statement_mid_sentence_does_not_swallow_the_prose():
    """The patterns take 2-6 characters either side and cannot see where a name
    begins, so in running prose the window opens mid-sentence."""
    assert find_explicit_aliases(
        "Everyone knows Lin Mo, also known as Xiao Mo, went home yesterday.", ["Lin Mo", "Xiao Mo"]
    ) == {("Lin Mo", "Xiao Mo")}
    assert find_explicit_aliases("It is said that Lin Mo is also called Xiao Mo.", ["Lin Mo", "Xiao Mo"]) == {
        ("Lin Mo", "Xiao Mo")
    }
    # And forwards, where nothing punctuates the end of the second name.
    assert find_explicit_aliases("Lin Mo also known as Xiao Mo went home yesterday", ["Lin Mo", "Xiao Mo"]) == {
        ("Lin Mo", "Xiao Mo")
    }


def test_a_pair_neither_side_of_which_was_extracted_is_dropped():
    """An unresolved capture is prose, not a name.

    Left in, it reaches the character table as an alias the text never stated —
    "one knows Lin Mo" was being persisted as one.
    """
    assert find_explicit_aliases("Everyone knows Lin Mo, also known as Xiao Mo.") == set()
    assert find_explicit_aliases("Everyone knows Lin Mo, also known as Xiao Mo.", ["Xiao Mo"]) == set()


def test_an_invented_name_cannot_ride_in_on_a_real_quote():
    """The module promises a hallucinated name has no route into the table.

    Verifying the quote alone did not deliver that: a real sentence with a name
    attached that appears nowhere in the source was accepted.
    """
    chunk = _chunk("Lin Mo came home", chunk_id="c0", start=0)
    invented = ChunkCharacterOutput(
        characters=[
            CharacterCandidate(
                name="Wang Wu", evidence=[CharacterEvidence(quote="Lin Mo came home")]
            )
        ]
    )
    assert merge_character_candidates([(chunk, invented)]) == []


def test_a_name_the_source_writes_elsewhere_is_still_accepted():
    """Attestation is against the source, not the chunk.

    A character is named once and called she or Mrs. Zheng for pages after; requiring
    the name in the chunk that mentions her would drop exactly the candidates
    cross-chunk appellation resolution depends on.
    """
    named = _chunk("Zheng Yuqin walked into the living room.", chunk_id="c0", start=0)
    pronoun = _chunk("Mrs. Zheng nodded.", chunk_id="c1", start=8)
    outcomes = [
        (
            named,
            ChunkCharacterOutput(
                characters=[
                    CharacterCandidate(
                        name="Zheng Yuqin",
                        evidence=[CharacterEvidence(quote="Zheng Yuqin walked into the living room.")],
                    )
                ]
            ),
        ),
        (
            pronoun,
            ChunkCharacterOutput(
                characters=[
                    CharacterCandidate(
                        name="Zheng Yuqin",
                        evidence=[CharacterEvidence(quote="Mrs. Zheng nodded.")],
                    )
                ]
            ),
        ),
    ]
    assert [item.name for item in merge_character_candidates(outcomes)] == ["Zheng Yuqin"]


def test_a_name_only_the_scene_heading_lists_is_accepted():
    """A screenplay names its cast in the heading; the body may only say he."""
    chunk = SourceChunk(
        chunk_id="c0",
        chunk_index=0,
        section_type="scene",
        section_label="第1场",
        source_start=0,
        source_end=5,
        text="He pushed open the door.",
        characters=["Lin Mo"],
    )
    outcomes = [
        (
            chunk,
            ChunkCharacterOutput(
                characters=[
                    CharacterCandidate(
                        name="Lin Mo", evidence=[CharacterEvidence(quote="He pushed open the door.")]
                    )
                ]
            ),
        )
    ]
    assert [item.name for item in merge_character_candidates(outcomes)] == ["Lin Mo"]


def test_two_names_merely_appearing_together_is_not_an_alias():
    """Co-occurrence is not identity — that is how wrong merges happen."""
    assert find_explicit_aliases("Lin Mo looked at Su Qing, and neither of them said anything.") == set()


# ── merging ─────────────────────────────────────────────────────────────────


def test_identical_names_across_chunks_merge():
    text_a = "Lin Mo returned to his hometown."
    text_b = "Lin Mo walked into the house."
    outcomes = [
        (
            _chunk(text_a, chunk_id="c0"),
            ChunkCharacterOutput(characters=[_candidate("Lin Mo", quotes=[text_a])]),
        ),
        (
            _chunk(text_b, chunk_id="c1", start=50),
            ChunkCharacterOutput(characters=[_candidate("Lin Mo", quotes=[text_b])]),
        ),
    ]
    merged = merge_character_candidates(outcomes)
    assert [item.name for item in merged] == ["Lin Mo"]
    assert len(merged[0].evidence) == 2
    assert merged[0].chunk_ids == {"c0", "c1"}


def test_candidates_without_verifiable_evidence_are_dropped():
    text = "Lin Mo returned to his hometown."
    outcomes = [
        (
            _chunk(text),
            ChunkCharacterOutput(
                characters=[
                    _candidate("Lin Mo", quotes=[text]),
                    _candidate("Emperor", quotes=["Lin Mo is the emperor's son."]),
                ]
            ),
        )
    ]
    merged = merge_character_candidates(outcomes)
    assert [item.name for item in merged] == ["Lin Mo"]


def test_generic_address_terms_never_become_characters():
    text = "His mother waited for him at the door."
    outcomes = [
        (
            _chunk(text),
            ChunkCharacterOutput(characters=[_candidate("mother", quotes=[text])]),
        )
    ]
    assert merge_character_candidates(outcomes) == []


def test_explicitly_stated_alias_merges_into_one_character():
    text = "Lin Mo, also known as Xiao Mo. The villagers all call him that."
    outcomes = [
        (
            _chunk(text),
            ChunkCharacterOutput(
                characters=[
                    _candidate("Lin Mo", quotes=[text]),
                    _candidate("Xiao Mo", quotes=[text]),
                ]
            ),
        )
    ]
    merged = merge_character_candidates(outcomes)
    assert len(merged) == 1
    assert merged[0].name == "Lin Mo"
    assert "Xiao Mo" in merged[0].aliases


def test_model_proposed_alias_without_textual_support_stays_a_suggestion():
    """A wrong merge destroys data silently; a wrong split is a visible duplicate."""
    text = "Lin Mo looked at Su Qing."
    outcomes = [
        (
            _chunk(text),
            ChunkCharacterOutput(
                characters=[_candidate("Lin Mo", quotes=[text], aliases=["Su Qing"])]
            ),
        )
    ]
    merged = merge_character_candidates(outcomes)
    assert merged[0].aliases == set()
    assert "Su Qing" in merged[0].ambiguous_with


def test_same_generic_term_in_two_chunks_does_not_merge_into_one_person():
    """"mother" in chapter one and chapter three need not be the same woman."""
    outcomes = [
        (
            _chunk("His mother waited for him at the door.", chunk_id="c0"),
            ChunkCharacterOutput(
                characters=[_candidate("mother", quotes=["His mother waited for him at the door."])]
            ),
        ),
        (
            _chunk("His mother fell silent after hearing it.", chunk_id="c1", start=80),
            ChunkCharacterOutput(
                characters=[_candidate("mother", quotes=["His mother fell silent after hearing it."])]
            ),
        ),
    ]
    assert merge_character_candidates(outcomes) == []


def test_alias_merge_keeps_the_better_evidenced_name_as_primary():
    alias_text = "Lin Mo, also known as Xiao Mo."
    outcomes = [
        (
            _chunk(alias_text, chunk_id="c0"),
            ChunkCharacterOutput(
                characters=[
                    _candidate("Xiao Mo", quotes=[alias_text]),
                    _candidate("Lin Mo", quotes=[alias_text]),
                ]
            ),
        ),
        (
            _chunk("Lin Mo walked into the house.", chunk_id="c1", start=60),
            ChunkCharacterOutput(
                characters=[_candidate("Lin Mo", quotes=["Lin Mo walked into the house."])]
            ),
        ),
    ]
    merged = merge_character_candidates(outcomes)
    assert len(merged) == 1
    assert merged[0].name == "Lin Mo"
    assert merged[0].aliases == {"Xiao Mo"}


# ── extraction over chunks ──────────────────────────────────────────────────


class FakeAgent:
    """Returns a scripted output per chunk label, or raises for one of them."""

    def __init__(self, by_label, fail_labels=()):
        self.by_label = by_label
        self.fail_labels = set(fail_labels)
        self.seen = []
        self.prompts = []

    async def run(self, prompt: str):
        label = next(
            (key for key in list(self.by_label) + list(self.fail_labels) if key in prompt),
            "",
        )
        self.seen.append(label)
        self.prompts.append(prompt)
        if label in self.fail_labels:
            raise RuntimeError("boom")
        return SimpleNamespace(
            output=self.by_label.get(label, ChunkCharacterOutput())
        )


async def test_extraction_runs_over_every_chunk():
    chunks = chunk_source_text(NARRATED_MULTI, "narrated")
    agent = FakeAgent(
        {
            "Chapter 1": ChunkCharacterOutput(
                characters=[_candidate("Lin Mo", quotes=["Lin Mo returned to his hometown after ten years away."])]
            ),
            "Chapter 2": ChunkCharacterOutput(
                characters=[_candidate("Su Qing", quotes=["He met Su Qing at the mouth of the alley."])]
            ),
        }
    )
    merged, _ = await extract_characters_from_chunks(chunks, agent=agent, adjudicate=False)
    assert {item.name for item in merged} == {"Lin Mo", "Su Qing"}


async def test_english_extraction_requests_english_descriptions():
    chunk = _chunk("Maya opens the library door.")
    agent = FakeAgent(
        {
            "Chapter 1": ChunkCharacterOutput(
                characters=[
                    _candidate(
                        "Maya",
                        description="A cautious librarian",
                        quotes=["Maya opens the library door."],
                    )
                ]
            )
        }
    )

    merged, _ = await extract_characters_from_chunks(
        [chunk],
        agent=agent,
        source_text=chunk.text,
        adjudicate=False,
    )

    assert [item.name for item in merged] == ["Maya"]
    assert merged[0].description == "A cautious librarian"
    assert "Write every user-visible prose field in English" in agent.prompts[0]


async def test_one_failing_chunk_does_not_discard_the_others():
    """A single unparseable scene must not take the whole build down with it."""
    chunks = chunk_source_text(NARRATED_MULTI, "narrated")
    agent = FakeAgent(
        {
            "Chapter 1": ChunkCharacterOutput(
                characters=[_candidate("Lin Mo", quotes=["Lin Mo returned to his hometown after ten years away."])]
            )
        },
        fail_labels=["Chapter 2"],
    )
    logs: list[str] = []
    merged, failures = await extract_characters_from_chunks(
        chunks, agent=agent, on_log=logs.append, adjudicate=False
    )
    assert [item.name for item in merged] == ["Lin Mo"]
    assert any("failed" in line for line in logs)
    # The failure is reported back so the caller can persist it against the run.
    assert [chunk.section_label for chunk, _ in failures]


async def test_extraction_is_bounded_but_not_serial():
    """Chunks are independent, so they must not run one at a time."""
    import asyncio

    in_flight = 0
    peak = 0

    class SlowAgent:
        async def run(self, prompt: str):
            nonlocal in_flight, peak
            in_flight += 1
            peak = max(peak, in_flight)
            await asyncio.sleep(0.01)
            in_flight -= 1
            return SimpleNamespace(output=ChunkCharacterOutput())

    chunks = [
        _chunk(f"chunk{index}", chunk_id=f"c{index}", start=index * 10)
        for index in range(12)
    ]
    await extract_characters_from_chunks(
        chunks, agent=SlowAgent(), concurrency=4, adjudicate=False
    )
    assert peak > 1
    assert peak <= 4


# ── builders ────────────────────────────────────────────────────────────────


@pytest.fixture
async def structured_store(tmp_path, monkeypatch):
    from novelvideo.sqlite_store import SQLiteStore
    from novelvideo import structured_extraction

    # Build/replay tests exercise extraction evidence and persistence. Optional
    # appearance enrichment must not construct a real credentialed model.
    class EmptyAppearanceAgent:
        async def run(self, _prompt):
            return SimpleNamespace(
                output=structured_extraction.CharacterAppearanceList(characters=[])
            )

    monkeypatch.setattr(
        structured_extraction,
        "_create_character_appearance_agent",
        lambda agent=None: agent if agent is not None else EmptyAppearanceAgent(),
    )

    state_dir = tmp_path / "user" / "structured"
    state_dir.mkdir(parents=True)
    (state_dir / "project_config.json").write_text(
        json.dumps({KNOWLEDGE_PIPELINE_KEY: KNOWLEDGE_PIPELINE_STRUCTURED, "spine_template": "narrated"}),
        encoding="utf-8",
    )
    (state_dir / "novel.txt").write_text(NARRATED_MULTI, encoding="utf-8")
    store = SQLiteStore(
        "user/structured", output_dir=str(state_dir), state_dir=str(state_dir)
    )
    await store.initialize()
    await store.load_graph_state()
    try:
        yield store, state_dir
    finally:
        await store.close()


async def test_atomic_publish_leaves_nothing_behind_on_failure(structured_store):
    """add_character commits per row; a build must publish all or nothing."""
    from novelvideo.cognee.pipeline import NovelCharacter

    store, _ = structured_store
    db = await store._ensure_db()
    original_execute = db.execute
    calls = {"n": 0}

    async def fail_on_second_insert(sql, *args, **kwargs):
        if sql.strip().startswith("INSERT INTO characters"):
            calls["n"] += 1
            if calls["n"] == 2:
                raise RuntimeError("boom")
        return await original_execute(sql, *args, **kwargs)

    db.execute = fail_on_second_insert
    try:
        with pytest.raises(RuntimeError):
            await store.add_characters_atomic(
                [NovelCharacter(name="Lin Mo"), NovelCharacter(name="Su Qing")]
            )
    finally:
        db.execute = original_execute

    # The first insert must not survive the second one's failure.
    assert await store.list_characters() == []


async def test_atomic_publish_never_overwrites_an_existing_character(structured_store):
    """An existing character may already carry portraits, identities and voice."""
    from novelvideo.cognee.pipeline import NovelCharacter

    store, _ = structured_store
    await store.add_character(
        NovelCharacter(name="Lin Mo", description="user-edited description", face_prompt="portrait")
    )

    added = await store.add_characters_atomic(
        [NovelCharacter(name="Lin Mo", description="description generated by the rescan"), NovelCharacter(name="Su Qing")]
    )

    assert added == ["Su Qing"]
    assert store.get_character("Lin Mo").description == "user-edited description"
    assert store.get_character("Lin Mo").face_prompt == "portrait"


async def test_narrated_scene_build_defers_instead_of_guessing(structured_store):
    """Narrated source has no scene headings; a full sweep would invent places."""
    from novelvideo.structured_builders import build_scenes_structured

    store, _ = structured_store
    result = await build_scenes_structured(store)
    assert result["mode"] == "episode_on_demand"
    assert result["added_scenes"] == 0
    assert await store.list_scenes() == []


async def test_prop_build_reports_deferral_rather_than_a_silent_zero(structured_store):
    """"0 props" must not read as "the analysis found nothing"."""
    from novelvideo.structured_builders import build_props_structured

    store, _ = structured_store
    result = await build_props_structured(store)
    assert result["props"] == 0
    assert result["mode"] == "episode_on_demand"
    assert result["message"]


async def test_character_build_propagates_the_full_source_language(
    structured_store, monkeypatch
):
    from novelvideo import structured_builders

    store, state_dir = structured_store
    (state_dir / "novel.txt").write_text(
        "Chapter One\n\nMaya opens the library door and walks inside.",
        encoding="utf-8",
    )
    captured = {}

    async def fake_extract(*args, **kwargs):
        captured["extraction"] = kwargs.get("output_language")
        return [_cast_member("Maya", quotes=("Maya opens the library door.",))], []

    async def fake_publish(*args, **kwargs):
        captured["appearance"] = kwargs.get("output_language")
        return ["Maya"]

    monkeypatch.setattr(
        "novelvideo.structured_extraction.extract_characters_from_chunks",
        fake_extract,
    )
    monkeypatch.setattr(structured_builders, "_publish_characters", fake_publish)

    await structured_builders.build_characters_structured(store)

    assert captured == {"extraction": "en", "appearance": "en"}


async def test_character_build_publishes_and_records_evidence(
    structured_store, monkeypatch
):
    _disable_appearance_enrichment(monkeypatch)
    from novelvideo import structured_builders
    from novelvideo.structured_ingest import ingest_source_text_structured

    store, state_dir = structured_store
    source = state_dir / "source.txt"
    source.write_text(NARRATED_MULTI, encoding="utf-8")
    run = await ingest_source_text_structured(
        store, str(source), spine_template="narrated"
    )

    agent = FakeAgent(
        {
            "Chapter 1": ChunkCharacterOutput(
                characters=[_candidate("Lin Mo", quotes=["Lin Mo returned to his hometown after ten years away."])]
            )
        }
    )

    real_extract = extract_characters_from_chunks

    async def fake_extract(chunks, **kwargs):
        kwargs.pop("agent", None)
        kwargs.setdefault("adjudicate", False)
        return await real_extract(chunks, agent=agent, **kwargs)

    monkeypatch.setattr(
        "novelvideo.structured_extraction.extract_characters_from_chunks",
        fake_extract,
    )

    added = await structured_builders.build_characters_structured(store)
    assert added == ["Lin Mo"]

    evidence = await store.list_entity_evidence("character", "Lin Mo")
    assert evidence
    assert evidence[0]["run_id"] == run["run_id"]
    quoted = NARRATED_MULTI[
        evidence[0]["source_start"] : evidence[0]["source_end"]
    ]
    assert quoted == "Lin Mo returned to his hometown after ten years away."


async def test_character_build_never_touches_cognee(structured_store, monkeypatch):
    import cognee

    from novelvideo import structured_builders

    def _boom(*args, **kwargs):
        raise AssertionError("structured character build must not touch Cognee")

    for name in ("add", "cognify", "memify", "search"):
        monkeypatch.setattr(cognee, name, _boom, raising=False)

    store, _ = structured_store
    agent = FakeAgent({})

    real_extract = extract_characters_from_chunks

    async def fake_extract(chunks, **kwargs):
        kwargs.pop("agent", None)
        kwargs.setdefault("adjudicate", False)
        return await real_extract(chunks, agent=agent, **kwargs)

    monkeypatch.setattr(
        "novelvideo.structured_extraction.extract_characters_from_chunks",
        fake_extract,
    )
    await structured_builders.build_characters_structured(store)


# ── resume, chunk bounds and concurrency defaults ───────────────────────────


async def test_completed_chunks_are_replayed_instead_of_re_billed(
    structured_store, monkeypatch
):
    """A retry or a second click must not pay for every chunk again."""
    _disable_appearance_enrichment(monkeypatch)
    from novelvideo import structured_builders
    from novelvideo.structured_extraction import extract_characters_from_chunks
    from novelvideo.structured_ingest import ingest_source_text_structured

    store, state_dir = structured_store
    source = state_dir / "source.txt"
    source.write_text(NARRATED_MULTI, encoding="utf-8")
    await ingest_source_text_structured(store, str(source), spine_template="narrated")

    outputs = {
        "Chapter 1": ChunkCharacterOutput(
            characters=[_candidate("Lin Mo", quotes=["Lin Mo returned to his hometown after ten years away."])]
        ),
        "Chapter 2": ChunkCharacterOutput(
            characters=[_candidate("Su Qing", quotes=["He met Su Qing at the mouth of the alley."])]
        ),
    }
    agent = FakeAgent(outputs)
    real_extract = extract_characters_from_chunks

    async def fake_extract(chunks, **kwargs):
        kwargs.pop("agent", None)
        kwargs.setdefault("adjudicate", False)
        return await real_extract(chunks, agent=agent, **kwargs)

    monkeypatch.setattr(
        "novelvideo.structured_extraction.extract_characters_from_chunks", fake_extract
    )

    first = await structured_builders.build_characters_structured(store)
    assert set(first) == {"Lin Mo", "Su Qing"}
    first_calls = len(agent.seen)
    assert first_calls > 0

    agent.seen.clear()
    second = await structured_builders.build_characters_structured(store)

    # Everything was replayed from stored results, so no chunk went to the model.
    assert agent.seen == []
    # And the characters are unchanged: they already exist, so nothing is added.
    assert second == []


async def test_a_failed_chunk_leaves_the_run_partial(structured_store, monkeypatch):
    """A partial run must not look finished to the next build."""
    _disable_appearance_enrichment(monkeypatch)
    from novelvideo import structured_builders
    from novelvideo.structured_extraction import extract_characters_from_chunks
    from novelvideo.structured_ingest import ingest_source_text_structured

    store, state_dir = structured_store
    source = state_dir / "source.txt"
    source.write_text(NARRATED_MULTI, encoding="utf-8")
    run = await ingest_source_text_structured(
        store, str(source), spine_template="narrated"
    )

    agent = FakeAgent(
        {
            "Chapter 1": ChunkCharacterOutput(
                characters=[_candidate("Lin Mo", quotes=["Lin Mo returned to his hometown after ten years away."])]
            )
        },
        fail_labels=["Chapter 2"],
    )
    real_extract = extract_characters_from_chunks

    async def fake_extract(chunks, **kwargs):
        kwargs.pop("agent", None)
        kwargs.setdefault("adjudicate", False)
        return await real_extract(chunks, agent=agent, **kwargs)

    monkeypatch.setattr(
        "novelvideo.structured_extraction.extract_characters_from_chunks", fake_extract
    )
    await structured_builders.build_characters_structured(store)

    failed = await store.list_analysis_chunks(run["run_id"], status="failed")
    assert failed, "the failing chunk was not recorded"
    from novelvideo.story_analysis import source_sha256
    from novelvideo.structured_ingest import (
        STRUCTURED_ANALYSIS_VERSION,
        STRUCTURED_SCHEMA_VERSION,
    )

    stored = await store.get_reusable_analysis_run(
        source_sha256=source_sha256(NARRATED_MULTI),
        schema_version=STRUCTURED_SCHEMA_VERSION,
        pipeline_version=STRUCTURED_ANALYSIS_VERSION,
        spine_template="narrated",
    )
    assert stored["status"] == "partial"


async def test_a_partial_run_never_stores_its_cast_as_the_final_result(
    structured_store, monkeypatch
):
    _disable_appearance_enrichment(monkeypatch)
    """The replay guard only checks that nothing is still pending.

    So once the failed chunks succeed on a later attempt, an artifact written by
    the partial run would be replayed instead of the freshly built cast — and it
    is missing exactly the characters those chunks were carrying.
    """
    from novelvideo import structured_builders
    from novelvideo.structured_extraction import extract_characters_from_chunks
    from novelvideo.structured_ingest import ingest_source_text_structured

    store, state_dir = structured_store
    source = state_dir / "source.txt"
    source.write_text(NARRATED_MULTI, encoding="utf-8")
    run = await ingest_source_text_structured(
        store, str(source), spine_template="narrated"
    )

    agent = FakeAgent(
        {
            "Chapter 1": ChunkCharacterOutput(
                characters=[_candidate("Lin Mo", quotes=["Lin Mo returned to his hometown after ten years away."])]
            )
        },
        fail_labels=["Chapter 2"],
    )
    real_extract = extract_characters_from_chunks

    async def fake_extract(chunks, **kwargs):
        kwargs.pop("agent", None)
        kwargs.setdefault("adjudicate", False)
        return await real_extract(chunks, agent=agent, **kwargs)

    monkeypatch.setattr(
        "novelvideo.structured_extraction.extract_characters_from_chunks", fake_extract
    )
    await structured_builders.build_characters_structured(store)

    assert await store.get_analysis_artifact(run["run_id"], "characters") == ""


def test_an_oversized_chapter_is_split_further():
    """A chapter boundary says where to cut, not how big the piece may be."""
    text = "Chapter 1 Homecoming\n\n" + "Lin Mo returned to his hometown." * 3000 + "\n\nChapter 2 Old Friend\n\nShort chapter.\n"
    chunks = chunk_source_text(text, "narrated")

    assert len(chunks) > 2
    assert max(len(chunk.text) for chunk in chunks) <= 6000
    for chunk in chunks:
        assert text[chunk.source_start : chunk.source_end] == chunk.text
    assert [chunk.chunk_index for chunk in chunks] == list(range(len(chunks)))


def test_oversized_parts_keep_a_recognisable_section_label():
    text = "Chapter 1 Homecoming\n\n" + "Lin Mo returned to his hometown." * 3000
    chunks = chunk_source_text(text, "narrated")
    assert all(chunk.chunk_id.startswith("chapter-0000-p") for chunk in chunks)
    assert all("第1章" in chunk.section_label for chunk in chunks)


def test_short_chapters_are_packed_into_one_call():
    """A call costs the same round trip whether it carries 300 or 3000 chars."""
    chunks = chunk_source_text(NARRATED_TEXT, "narrated")
    assert len(chunks) == 1
    assert chunks[0].source_start == 0
    assert chunks[0].text == NARRATED_TEXT


def test_chapters_past_the_target_stay_separate():
    chunks = chunk_source_text(NARRATED_MULTI, "narrated")
    assert len(chunks) == 3
    for chunk in chunks:
        assert NARRATED_MULTI[chunk.source_start : chunk.source_end] == chunk.text


def test_llm_concurrency_defaults_to_the_project_baseline(monkeypatch):
    """A second pool running deeper than COGNEE_LLM_CONCURRENCY would trip the
    same gateway limits that setting exists to avoid."""
    from novelvideo.utils.bounded_concurrency import default_llm_concurrency

    monkeypatch.delenv("STRUCTURED_LLM_CONCURRENCY", raising=False)
    assert default_llm_concurrency() == 2

    monkeypatch.setenv("STRUCTURED_LLM_CONCURRENCY", "5")
    assert default_llm_concurrency() == 5

    monkeypatch.setenv("STRUCTURED_LLM_CONCURRENCY", "0")
    with pytest.raises(ValueError):
        default_llm_concurrency()


async def test_reuse_key_separates_drama_from_narrated(structured_store, tmp_path):
    """The same text chunked two ways must not share a chunk plan."""
    from novelvideo.structured_ingest import ingest_source_text_structured

    store, state_dir = structured_store
    source = state_dir / "source.txt"
    source.write_text(NARRATED_MULTI, encoding="utf-8")

    narrated = await ingest_source_text_structured(
        store, str(source), spine_template="narrated"
    )
    again = await ingest_source_text_structured(
        store, str(source), spine_template="narrated"
    )
    assert again["run_id"] == narrated["run_id"]

    # Same bytes, different spine: a fresh plan, not the chapter-based one.
    drama = await ingest_source_text_structured(
        store, str(source), spine_template=""
    )
    assert drama["run_id"] != narrated["run_id"]


async def test_evidence_is_backfilled_when_the_characters_already_exist(
    structured_store, monkeypatch
):
    _disable_appearance_enrichment(monkeypatch)
    """Publishing characters and writing evidence are two steps.

    If the first succeeds and the second fails, a retry finds the characters
    already present. Keying evidence on "newly added" would leave them without
    provenance forever.
    """
    from novelvideo import structured_builders
    from novelvideo.cognee.pipeline import NovelCharacter
    from novelvideo.structured_extraction import extract_characters_from_chunks
    from novelvideo.structured_ingest import ingest_source_text_structured

    store, state_dir = structured_store
    source = state_dir / "source.txt"
    source.write_text(NARRATED_MULTI, encoding="utf-8")
    await ingest_source_text_structured(store, str(source), spine_template="narrated")

    # Stand in for a previous build that published the character but died
    # before its evidence landed.
    await store.add_character(NovelCharacter(name="Lin Mo"))
    assert await store.list_entity_evidence("character", "Lin Mo") == []

    agent = FakeAgent(
        {
            "Chapter 1": ChunkCharacterOutput(
                characters=[_candidate("Lin Mo", quotes=["Lin Mo returned to his hometown after ten years away."])]
            )
        }
    )
    real_extract = extract_characters_from_chunks

    async def fake_extract(chunks, **kwargs):
        kwargs.pop("agent", None)
        kwargs.setdefault("adjudicate", False)
        return await real_extract(chunks, agent=agent, **kwargs)

    monkeypatch.setattr(
        "novelvideo.structured_extraction.extract_characters_from_chunks", fake_extract
    )

    added = await structured_builders.build_characters_structured(store)
    assert added == []  # nothing new to publish
    assert await store.list_entity_evidence("character", "Lin Mo"), (
        "evidence was never backfilled for an already-published character"
    )


async def test_a_run_with_no_characters_is_still_closed_out(
    structured_store, monkeypatch
):
    """A run left at "pending" tells the next build nothing about what remains."""
    from novelvideo import structured_builders
    from novelvideo.story_analysis import source_sha256
    from novelvideo.structured_extraction import extract_characters_from_chunks
    from novelvideo.structured_ingest import (
        STRUCTURED_ANALYSIS_VERSION,
        STRUCTURED_SCHEMA_VERSION,
        ingest_source_text_structured,
    )

    store, state_dir = structured_store
    source = state_dir / "source.txt"
    source.write_text(NARRATED_MULTI, encoding="utf-8")
    await ingest_source_text_structured(store, str(source), spine_template="narrated")

    agent = FakeAgent({})  # every chunk yields nothing
    real_extract = extract_characters_from_chunks

    async def fake_extract(chunks, **kwargs):
        kwargs.pop("agent", None)
        kwargs.setdefault("adjudicate", False)
        return await real_extract(chunks, agent=agent, **kwargs)

    monkeypatch.setattr(
        "novelvideo.structured_extraction.extract_characters_from_chunks", fake_extract
    )
    assert await structured_builders.build_characters_structured(store) == []

    stored = await store.get_reusable_analysis_run(
        source_sha256=source_sha256(NARRATED_MULTI),
        schema_version=STRUCTURED_SCHEMA_VERSION,
        pipeline_version=STRUCTURED_ANALYSIS_VERSION,
        spine_template="narrated",
    )
    assert stored["status"] == "completed"


# ── ambiguity adjudication ──────────────────────────────────────────────────


def _merged(name, count, *, aliases=()):
    from novelvideo.structured_extraction import MergedCharacter

    return MergedCharacter(
        name=name,
        aliases=set(aliases),
        evidence=[
            {
                "chunk_id": "c0",
                "source_start": index,
                "source_end": index + 1,
                "evidence_kind": "mention",
                "evidence_text": name,
            }
            for index in range(count)
        ],
    )


class AdjudicatorAgent:
    """Returns a scripted adjudication and records the prompt it received."""

    def __init__(self, groups=(), non_characters=(), explode=False):
        from novelvideo.structured_extraction import (
            CharacterAdjudication,
            SamePersonGroup,
        )

        self.explode = explode
        self.prompt = ""
        self.result = CharacterAdjudication(
            groups=[
                SamePersonGroup(canonical_name=c, alias_names=list(a))
                for c, a in groups
            ],
            non_characters=list(non_characters),
        )

    async def run(self, prompt: str):
        self.prompt = prompt
        if self.explode:
            raise RuntimeError("adjudicator unavailable")
        return SimpleNamespace(output=self.result)


async def test_adjudication_merges_a_nickname_into_its_character():
    """Per-chunk extraction cannot see that Xiaoyang is Zheng Xuyang; this step can."""
    from novelvideo.structured_extraction import adjudicate_characters

    merged = [_merged("Zheng Xuyang", 38), _merged("Xiaoyang", 1)]
    agent = AdjudicatorAgent(groups=[("Zheng Xuyang", ["Xiaoyang"])])

    result = await adjudicate_characters(merged, agent=agent)
    assert [item.name for item in result] == ["Zheng Xuyang"]
    assert result[0].aliases == {"Xiaoyang"}
    assert len(result[0].evidence) == 39


async def test_adjudication_cannot_invent_a_character():
    """It may only group names it was given."""
    from novelvideo.structured_extraction import adjudicate_characters

    merged = [_merged("Zheng Xuyang", 38), _merged("Xiaoyang", 1)]
    agent = AdjudicatorAgent(groups=[("No Such Person", ["Xiaoyang"])])

    result = await adjudicate_characters(merged, agent=agent)
    assert {item.name for item in result} == {"Zheng Xuyang", "Xiaoyang"}


async def test_adjudication_never_deletes_a_candidate():
    """Every candidate here already survived verification against the source.

    Discarding one trades a visible duplicate for an invisible omission, which
    is the wrong way round: the user can delete a duplicate but cannot see an
    omission.
    """
    from novelvideo.structured_extraction import adjudicate_characters

    merged = [_merged("Zheng Yuqin", 96), _merged("Zheng Jiayue", 96), _merged("passerby", 1)]
    logs: list[str] = []
    agent = AdjudicatorAgent(non_characters=["Zheng Yuqin", "passerby"])

    result = await adjudicate_characters(merged, agent=agent, on_log=logs.append)
    assert {item.name for item in result} == {"Zheng Yuqin", "Zheng Jiayue", "passerby"}
    assert any("recorded only, not removed" in line for line in logs)


async def test_adjudication_cannot_merge_two_well_attested_characters():
    """The model may not fold one lead into another, however it groups them."""
    from novelvideo.structured_extraction import adjudicate_characters

    merged = [_merged("Zheng Yuqin", 96), _merged("Zheng Jiayue", 96)]
    agent = AdjudicatorAgent(groups=[("Zheng Yuqin", ["Zheng Jiayue"])])

    result = await adjudicate_characters(merged, agent=agent)
    assert {item.name for item in result} == {"Zheng Yuqin", "Zheng Jiayue"}


async def test_a_character_named_in_a_cast_list_is_never_merged_away():
    """A cast list is authored, not inferred, so it outranks the model."""
    from novelvideo.structured_extraction import adjudicate_characters

    merged = [_merged("Zheng Yuqin", 96), _merged("Auntie Wang", 1)]
    agent = AdjudicatorAgent(groups=[("Zheng Yuqin", ["Auntie Wang"])])

    result = await adjudicate_characters(
        merged, roster={"Servant Auntie Wang"}, agent=agent
    )
    assert {item.name for item in result} == {"Zheng Yuqin", "Auntie Wang"}


async def test_the_canonical_name_is_chosen_by_the_code_not_the_model():
    """Left to the model, a formal name can end up folded into a nickname."""
    from novelvideo.structured_extraction import adjudicate_characters

    merged = [_merged("Zheng Xuyang", 38), _merged("Xiaoyang", 1)]
    # The model nominates the nickname as canonical.
    agent = AdjudicatorAgent(groups=[("Xiaoyang", ["Zheng Xuyang"])])

    result = await adjudicate_characters(merged, agent=agent)
    assert [item.name for item in result] == ["Zheng Xuyang"]
    assert result[0].aliases == {"Xiaoyang"}


async def test_adjudication_failure_keeps_the_rule_result():
    """A degraded adjudicator must not lose the characters rules already found."""
    from novelvideo.structured_extraction import adjudicate_characters

    merged = [_merged("Zheng Yuqin", 96), _merged("Mrs. Zheng", 5)]
    logs: list[str] = []

    result = await adjudicate_characters(
        merged, agent=AdjudicatorAgent(explode=True), on_log=logs.append
    )
    assert {item.name for item in result} == {"Zheng Yuqin", "Mrs. Zheng"}
    assert any("adjudication failed" in line for line in logs)


async def test_rarely_seen_candidates_get_source_context():
    """A bare quote rarely proves identity; the surrounding text usually does."""
    from novelvideo.structured_extraction import adjudicate_characters

    source = "▲Zheng Xuyang walked in. Zheng Yuqin frowned.\nZheng Yuqin: Xiaoyang, you got into trouble again.\n"
    start = source.index("Xiaoyang")
    rare = _merged("Xiaoyang", 0)
    rare.evidence.append(
        {
            "chunk_id": "c0",
            "source_start": start,
            "source_end": start + 2,
            "evidence_kind": "dialogue",
            "evidence_text": "Xiaoyang",
        }
    )
    agent = AdjudicatorAgent()

    await adjudicate_characters(
        [_merged("Zheng Xuyang", 38), rare], source_text=source, agent=agent
    )
    assert "context" in agent.prompt
    # The formal name sits next to the nickname, which is what makes the link
    # inferable at all.
    assert "Zheng Xuyang" in agent.prompt


async def test_a_single_candidate_needs_no_adjudication():
    from novelvideo.structured_extraction import adjudicate_characters

    merged = [_merged("Zheng Yuqin", 96)]
    agent = AdjudicatorAgent(non_characters=["Zheng Yuqin"])
    assert await adjudicate_characters(merged, agent=agent) == merged


# ── scene adjudication ──────────────────────────────────────────────────────


def _scene(name, *, aliases=()):
    from novelvideo.models import NovelScene

    return NovelScene(name=name, aliases=list(aliases))


class SceneAdjudicatorAgent:
    def __init__(self, groups=(), explode=False):
        from novelvideo.structured_extraction import (
            SameLocationGroup, SceneAdjudication,
        )

        self.explode = explode
        self.prompt = ""
        self.result = SceneAdjudication(
            groups=[
                SameLocationGroup(canonical_name=c, alias_names=list(a))
                for c, a in groups
            ]
        )

    async def run(self, prompt: str):
        self.prompt = prompt
        if self.explode:
            raise RuntimeError("adjudicator unavailable")
        return SimpleNamespace(output=self.result)


async def test_scene_adjudication_merges_spellings_of_one_location():
    """Hand-written headings spell one room several ways."""
    from novelvideo.structured_extraction import adjudicate_scenes

    scenes = [_scene("Zheng Yuqin's office"), _scene("inside Zheng Yuqin's office")]
    agent = SceneAdjudicatorAgent(groups=[("Zheng Yuqin's office", ["inside Zheng Yuqin's office"])])

    result = await adjudicate_scenes(scenes, agent=agent)
    assert [s.name for s in result] == ["Zheng Yuqin's office"]
    assert "inside Zheng Yuqin's office" in result[0].aliases


async def test_scene_adjudication_never_drops_a_location():
    """A duplicate is redundant art; a missing scene leaves shots with no asset.

    Unlike characters, there is no removal path here at all, so a model that
    proposes nothing simply leaves every scene standing.
    """
    from novelvideo.structured_extraction import adjudicate_scenes

    scenes = [_scene("Zheng Villa living room"), _scene("Zheng Villa dining room"), _scene("outside the Zheng Villa")]
    result = await adjudicate_scenes(scenes, agent=SceneAdjudicatorAgent())
    assert {s.name for s in result} == {name.name for name in scenes}


async def test_scene_adjudication_cannot_invent_a_location():
    from novelvideo.structured_extraction import adjudicate_scenes

    scenes = [_scene("Zheng Yuqin's office"), _scene("inside Zheng Yuqin's office")]
    agent = SceneAdjudicatorAgent(groups=[("No Such Place", ["inside Zheng Yuqin's office"])])

    result = await adjudicate_scenes(scenes, agent=agent)
    assert len(result) == 2


async def test_scene_adjudication_failure_keeps_every_scene():
    from novelvideo.structured_extraction import adjudicate_scenes

    scenes = [_scene("Zheng Yuqin's office"), _scene("inside Zheng Yuqin's office")]
    logs: list[str] = []
    result = await adjudicate_scenes(
        scenes, agent=SceneAdjudicatorAgent(explode=True), on_log=logs.append
    )
    assert len(result) == 2
    assert any("adjudication failed" in line for line in logs)


async def test_scene_prompt_reports_how_often_each_heading_is_used():
    """The most-used spelling is the better canonical name."""
    from novelvideo.structured_extraction import adjudicate_scenes

    scenes = [_scene("Director's office"), _scene("Zheng Villa living room")]
    agent = SceneAdjudicatorAgent()
    await adjudicate_scenes(
        scenes, occurrences={"Director's office": 18, "Zheng Villa living room": 16}, agent=agent
    )
    assert "appears 18 场" in agent.prompt
    assert "appears 16 场" in agent.prompt


def test_scene_heading_counts_come_from_the_script():
    from novelvideo.structured_builders import _scene_heading_counts

    script = (
        "Episode 1\n\n"
        "1-1 Lin family living room DAY INT\nCharacters: Lin Mo\nLin Mo pushed open the door.\n\n"
        "1-2 Alley entrance NIGHT EXT\nCharacters: Lin Mo\nLin Mo walked past the alley entrance.\n\n"
        "1-3 Lin family living room NIGHT INT\nCharacters: Lin Mo\nLin Mo sat down.\n"
    )
    counts = _scene_heading_counts(script)
    assert counts.get("Lin family living room") == 2
    assert counts.get("alley entrance") == 1


# ── resume after an outage, and source-change invalidation ──────────────────


class FlakyAgent:
    """Fails for a set of chunk labels, then can be repaired."""

    def __init__(self, outputs, failing=()):
        self.outputs = outputs
        self.failing = set(failing)
        # Keep the label vocabulary stable across repair, so a recovered agent
        # still recognises the chunk it previously refused.
        self.labels = list(outputs) + list(failing)
        self.calls: list[str] = []

    def repair(self):
        self.failing.clear()

    async def run(self, prompt: str):
        label = next((k for k in self.labels if k in prompt), "")
        self.calls.append(label)
        if label in self.failing:
            raise RuntimeError("gateway down")
        return SimpleNamespace(
            output=self.outputs.get(label, ChunkCharacterOutput())
        )


async def _ingested(store, state_dir, text=NARRATED_MULTI):
    from novelvideo.structured_ingest import ingest_source_text_structured

    source = state_dir / "source.txt"
    source.write_text(text, encoding="utf-8")
    return await ingest_source_text_structured(
        store, str(source), spine_template="narrated"
    )


def _patched_extract(monkeypatch, agent):
    from novelvideo.structured_extraction import extract_characters_from_chunks

    real = extract_characters_from_chunks

    async def fake(chunks, **kwargs):
        kwargs.pop("agent", None)
        kwargs.setdefault("adjudicate", False)
        return await real(chunks, agent=agent, **kwargs)

    monkeypatch.setattr(
        "novelvideo.structured_extraction.extract_characters_from_chunks", fake
    )

    # These tests exercise extraction, evidence, replay, and run-state
    # behavior. Character appearance enrichment has focused tests below.
    _disable_appearance_enrichment(monkeypatch)

async def test_a_chunk_that_failed_is_retried_while_others_are_not(
    structured_store, monkeypatch
):
    """An outage mid-build must cost only the chunks it actually broke."""
    from novelvideo import structured_builders

    store, state_dir = structured_store
    run = await _ingested(store, state_dir, NARRATED_MULTI)

    agent = FlakyAgent(
        outputs={
            "Chapter 1": ChunkCharacterOutput(
                characters=[_candidate("Lin Mo", quotes=["Lin Mo returned to his hometown after ten years away."])]
            ),
            "Chapter 3": ChunkCharacterOutput(
                characters=[_candidate("Su Qing", quotes=["Su Qing told Lin Mo a secret."])]
            ),
        },
        failing=["Chapter 2"],
    )
    _patched_extract(monkeypatch, agent)

    await structured_builders.build_characters_structured(store)
    assert len(agent.calls) == 3
    failed = await store.list_analysis_chunks(run["run_id"], status="failed")
    assert [row["chunk_id"] for row in failed] == ["chapter-0001"]

    # The gateway comes back and the user clicks build again.
    agent.repair()
    agent.calls.clear()
    await structured_builders.build_characters_structured(store)

    assert agent.calls == ["Chapter 2"], "a healthy chunk was paid for twice"
    assert not await store.list_analysis_chunks(run["run_id"], status="failed")


async def test_editing_the_source_discards_the_stored_plan(
    structured_store, monkeypatch
):
    """A result produced from text that has since changed is not a result."""
    from novelvideo import structured_builders

    store, state_dir = structured_store
    await _ingested(store, state_dir, NARRATED_MULTI)

    outputs = {
        "Chapter 1": ChunkCharacterOutput(
            characters=[_candidate("Lin Mo", quotes=["Lin Mo returned to his hometown after ten years away."])]
        )
    }
    agent = FlakyAgent(outputs=outputs)
    _patched_extract(monkeypatch, agent)

    await structured_builders.build_characters_structured(store)
    first_calls = len(agent.calls)
    assert first_calls > 0

    # Rewriting novel.txt without re-importing: the hash no longer matches any
    # recorded run, so nothing may be replayed.
    (Path(store.project_dir) / "novel.txt").write_text(
        NARRATED_MULTI + "\nChapter 4 Ending\n\nHe finally let go.\n", encoding="utf-8"
    )
    agent.calls.clear()
    await structured_builders.build_characters_structured(store)

    assert agent.calls, "stale results were replayed for text that changed"


# ── appellations ────────────────────────────────────────────────────────────


def _candidate_with_appellations(name, quotes, appellations):
    c = _candidate(name, quotes=quotes)
    c.appellations = list(appellations)
    return c


def test_an_appellation_only_one_character_claims_becomes_an_alias():
    """Packed chunks hold several scenes, so nicknames surface alongside names."""
    text = "Zheng Yuqin walked into the living room. Butler Liu called out to Mrs. Zheng."
    outcomes = [
        (
            _chunk(text),
            ChunkCharacterOutput(
                characters=[
                    _candidate_with_appellations("Zheng Yuqin", [text], ["Mrs. Zheng"]),
                    _candidate("Butler Liu", quotes=[text]),
                ]
            ),
        )
    ]
    merged = {m.name: m for m in merge_character_candidates(outcomes)}
    assert merged["Zheng Yuqin"].aliases == {"Mrs. Zheng"}
    assert merged["Butler Liu"].aliases == set()


def _claim(chunk_id, start, name, appellation, text):
    return (
        _chunk(text, chunk_id=chunk_id, start=start),
        ChunkCharacterOutput(
            characters=[_candidate_with_appellations(name, [text], [appellation])]
        ),
    )


def test_a_contested_appellation_goes_to_whoever_the_text_keeps_supporting():
    """Decided by how many independent chunks say so, not by overall evidence.

    Ranking by total evidence would hand every ambiguous form to the lead,
    which is the opposite of evidence-driven.
    """
    text = "Zheng Yuqin walked into the living room. Butler Liu called out to Mrs. Zheng."
    outcomes = [
        _claim("c0", 0, "Zheng Yuqin", "Mrs. Zheng", text),
        _claim("c1", 60, "Zheng Yuqin", "Mrs. Zheng", text),
        _claim("c2", 120, "Zheng Yuqin", "Mrs. Zheng", text),
        _claim("c3", 180, "Butler Liu", "Mrs. Zheng", text),
    ]
    merged = {m.name: m for m in merge_character_candidates(outcomes)}
    assert merged["Zheng Yuqin"].aliases == {"Mrs. Zheng"}
    assert merged["Butler Liu"].aliases == set()


def test_a_contested_appellation_with_a_narrow_lead_is_dropped():
    """Leading is not enough; three-to-two leaves it unassigned.

    A wrong alias resolves confidently to the wrong person, while a missing one
    merely fails to resolve — so a close call is left alone.
    """
    text = "Zheng Yuqin walked into the living room. Butler Liu called out to Mrs. Zheng."
    outcomes = [
        _claim("c0", 0, "Zheng Yuqin", "Mrs. Zheng", text),
        _claim("c1", 60, "Zheng Yuqin", "Mrs. Zheng", text),
        _claim("c2", 120, "Zheng Yuqin", "Mrs. Zheng", text),
        _claim("c3", 180, "Butler Liu", "Mrs. Zheng", text),
        _claim("c4", 240, "Butler Liu", "Mrs. Zheng", text),
    ]
    for item in merge_character_candidates(outcomes):
        assert "Mrs. Zheng" not in item.aliases


def test_a_contested_appellation_seen_in_only_one_chunk_is_dropped():
    """One chunk is one author's phrasing, not grounds to overrule a rival."""
    text = "Zheng Yuqin walked into the living room. Butler Liu called out to Mrs. Zheng."
    outcomes = [
        _claim("c0", 0, "Zheng Yuqin", "Mrs. Zheng", text),
        _claim("c1", 60, "Butler Liu", "Mrs. Zheng", text),
    ]
    for item in merge_character_candidates(outcomes):
        assert "Mrs. Zheng" not in item.aliases


def test_an_appellation_that_is_itself_a_character_never_becomes_an_alias():
    text = "Zheng Yuqin walked into the living room. Butler Liu followed behind."
    outcomes = [
        (
            _chunk(text),
            ChunkCharacterOutput(
                characters=[
                    _candidate_with_appellations("Zheng Yuqin", [text], ["Butler Liu"]),
                    _candidate("Butler Liu", quotes=[text]),
                ]
            ),
        )
    ]
    merged = {m.name: m for m in merge_character_candidates(outcomes)}
    assert "Butler Liu" in merged
    assert merged["Zheng Yuqin"].aliases == set()


def test_an_appellation_absent_from_the_chunk_is_rejected():
    text = "Zheng Yuqin walked into the living room."
    outcomes = [
        (
            _chunk(text),
            ChunkCharacterOutput(
                characters=[
                    _candidate_with_appellations("Zheng Yuqin", [text], ["Her Majesty the Queen"])
                ]
            ),
        )
    ]
    assert merge_character_candidates(outcomes)[0].aliases == set()


def test_a_generic_appellation_is_not_recorded_as_an_alias():
    text = "Zheng Yuqin walked into the living room. Her mother was at the door."
    outcomes = [
        (
            _chunk(text),
            ChunkCharacterOutput(
                characters=[
                    _candidate_with_appellations("Zheng Yuqin", [text], ["mother"])
                ]
            ),
        )
    ]
    assert merge_character_candidates(outcomes)[0].aliases == set()


async def test_a_frequently_used_location_is_never_merged_away():
    """A place the script keeps returning to is real, not a spelling variant.

    Folding it away would leave those scenes pointing at another room's art.
    """
    from novelvideo.structured_extraction import adjudicate_scenes

    scenes = [_scene("Director's office"), _scene("Zheng Villa living room")]
    agent = SceneAdjudicatorAgent(groups=[("Director's office", ["Zheng Villa living room"])])

    result = await adjudicate_scenes(
        scenes, occurrences={"Director's office": 18, "Zheng Villa living room": 16}, agent=agent
    )
    assert {s.name for s in result} == {"Director's office", "Zheng Villa living room"}


async def test_the_canonical_location_is_the_spelling_the_script_uses_most():
    from novelvideo.structured_extraction import adjudicate_scenes

    scenes = [_scene("Zheng Yuqin's office"), _scene("inside Zheng Yuqin's office")]
    # The model nominates the rarer spelling.
    agent = SceneAdjudicatorAgent(groups=[("inside Zheng Yuqin's office", ["Zheng Yuqin's office"])])

    result = await adjudicate_scenes(
        scenes,
        occurrences={"Zheng Yuqin's office": 2, "inside Zheng Yuqin's office": 1},
        agent=agent,
    )
    assert [s.name for s in result] == ["Zheng Yuqin's office"]
    assert "inside Zheng Yuqin's office" in result[0].aliases


async def test_a_completed_build_replays_without_any_model_call(
    structured_store, monkeypatch
):
    """Caching chunk results is not enough on its own.

    Merging is free, but adjudication is a further model call, and a second
    adjudication can decide differently — an alias could reappear as its own
    character and be inserted as a new row. A finished build therefore replays
    its settled cast.
    """
    from novelvideo import structured_builders
    from novelvideo.structured_extraction import (
        CharacterAdjudication,
    )

    store, state_dir = structured_store
    await _ingested(store, state_dir, NARRATED_MULTI)

    extraction = FlakyAgent(
        outputs={
            "Chapter 1": ChunkCharacterOutput(
                characters=[_candidate("Lin Mo", quotes=["Lin Mo returned to his hometown after ten years away."])]
            ),
            "Chapter 2": ChunkCharacterOutput(
                characters=[_candidate("Su Qing", quotes=["He met Su Qing at the mouth of the alley."])]
            ),
        }
    )

    class CountingAdjudicator:
        def __init__(self):
            self.calls = 0

        async def run(self, prompt: str):
            self.calls += 1
            return SimpleNamespace(
                output=CharacterAdjudication(groups=[])
            )

    adjudicator = CountingAdjudicator()
    from novelvideo.structured_extraction import extract_characters_from_chunks

    real = extract_characters_from_chunks

    async def fake(chunks, **kwargs):
        kwargs.pop("agent", None)
        kwargs.pop("adjudication_agent", None)
        return await real(chunks, agent=extraction, adjudication_agent=adjudicator, **kwargs)

    monkeypatch.setattr(
        "novelvideo.structured_extraction.extract_characters_from_chunks", fake
    )

    async def no_appearance_enrichment(*_args, **_kwargs):
        return {}

    monkeypatch.setattr(
        "novelvideo.structured_extraction.enrich_character_appearances",
        no_appearance_enrichment,
    )

    await structured_builders.build_characters_structured(store)
    assert extraction.calls, "the first build should have done real work"
    assert adjudicator.calls == 1

    extraction.calls.clear()
    await structured_builders.build_characters_structured(store)

    assert extraction.calls == [], "chunks were re-extracted"
    assert adjudicator.calls == 1, "adjudication ran again on a finished build"


async def test_replaying_a_build_cannot_split_an_alias_back_into_a_character(
    structured_store, monkeypatch
):
    """A second, differently-deciding adjudication must not add a row.

    Without a stored final result, an alias folded in on the first run could
    come back as its own candidate, and add_characters_atomic — which only
    checks primary names — would insert it alongside the character that already
    lists it as an alias.
    """
    from novelvideo import structured_builders
    from novelvideo.structured_extraction import (
        CharacterAdjudication, SamePersonGroup, extract_characters_from_chunks,
    )

    store, state_dir = structured_store
    await _ingested(store, state_dir, NARRATED_MULTI)

    extraction = FlakyAgent(
        outputs={
            "Chapter 1": ChunkCharacterOutput(
                characters=[_candidate("Lin Mo", quotes=["Lin Mo returned to his hometown after ten years away."])]
            ),
            "Chapter 2": ChunkCharacterOutput(
                characters=[_candidate("Su Qing", quotes=["He met Su Qing at the mouth of the alley."])]
            ),
        }
    )

    class DriftingAdjudicator:
        """Merges on the first call, then changes its mind."""

        def __init__(self):
            self.calls = 0

        async def run(self, prompt: str):
            self.calls += 1
            groups = (
                [SamePersonGroup(canonical_name="Lin Mo", alias_names=["Su Qing"])]
                if self.calls == 1
                else []
            )
            return SimpleNamespace(output=CharacterAdjudication(groups=groups))

    real = extract_characters_from_chunks

    async def fake(chunks, **kwargs):
        kwargs.pop("agent", None)
        kwargs.pop("adjudication_agent", None)
        return await real(
            chunks, agent=extraction, adjudication_agent=DriftingAdjudicator(), **kwargs
        )

    monkeypatch.setattr(
        "novelvideo.structured_extraction.extract_characters_from_chunks", fake
    )

    async def no_appearance_enrichment(*_args, **_kwargs):
        return {}

    monkeypatch.setattr(
        "novelvideo.structured_extraction.enrich_character_appearances",
        no_appearance_enrichment,
    )

    await structured_builders.build_characters_structured(store)
    first = {c.name for c in await store.list_characters()}

    await structured_builders.build_characters_structured(store)
    second = {c.name for c in await store.list_characters()}

    assert second == first, "a rebuild changed the cast for unchanged source"
    assert "Su Qing" not in second


def test_one_occurrence_in_an_overlap_counts_once():
    """Chunks overlap, so a single mention can appear in two of them.

    Counting chunks would let that one occurrence clear the two-to-one margin by
    itself and hand the appellation to whoever happened to sit on the seam.
    """
    source = "Zheng Yuqin walked into the living room. Butler Liu called out to Mrs. Zheng. She did not look back."
    seam = source.index("Mrs. Zheng")
    # Two chunks whose spans overlap across the mention, exactly as
    # _split_oversized produces them.
    left = SourceChunk(
        chunk_id="c0", chunk_index=0, section_type="chapter", section_label="上",
        source_start=0, source_end=seam + 6, text=source[: seam + 6],
    )
    right = SourceChunk(
        chunk_id="c1", chunk_index=1, section_type="chapter", section_label="下",
        source_start=seam - 4, source_end=len(source), text=source[seam - 4 :],
    )
    assert right.source_start < left.source_end, "the fixture must overlap"

    def claim(chunk, owner):
        return (
            chunk,
            ChunkCharacterOutput(
                characters=[
                    _candidate_with_appellations(owner, [chunk.text], ["Mrs. Zheng"])
                ]
            ),
        )

    # Zheng Yuqin is claimed twice, but both are the same mention seen from either
    # side of the seam. Butler Liu is claimed once, elsewhere.
    elsewhere = _chunk("Butler Liu watched Mrs. Zheng leave.", chunk_id="c2", start=400)
    outcomes = [
        claim(left, "Zheng Yuqin"),
        claim(right, "Zheng Yuqin"),
        claim(elsewhere, "Butler Liu"),
    ]

    for item in merge_character_candidates(outcomes):
        assert "Mrs. Zheng" not in item.aliases, (
            "an overlapped mention was counted twice and won the vote"
        )


def test_the_same_appellation_at_two_real_positions_still_wins():
    """Deduplicating by position must not silently disable voting."""
    source = "Zheng Yuqin walked into the living room. Mrs. Zheng nodded. Later Mrs. Zheng spoke again."
    first = _chunk(source[:12], chunk_id="c0", start=0)
    second = _chunk(source[12:], chunk_id="c1", start=12)

    def claim(chunk, owner):
        return (
            chunk,
            ChunkCharacterOutput(
                characters=[
                    _candidate_with_appellations(owner, [chunk.text], ["Mrs. Zheng"])
                ]
            ),
        )

    outcomes = [
        claim(first, "Zheng Yuqin"),
        claim(second, "Zheng Yuqin"),
        claim(_chunk("Butler Liu was at the door. Mrs. Zheng left.", chunk_id="c2", start=400), "Butler Liu"),
    ]
    merged = {m.name: m for m in merge_character_candidates(outcomes)}
    assert merged["Zheng Yuqin"].aliases == {"Mrs. Zheng"}


# ── repairing placeholder environment prompts ───────────────────────────────


DRAMA_SCRIPT = (
    "Episode 1\n\n"
    "1-1 Lin family living room DAY INT\nCharacters: Lin Mo\nLin Mo pushed open the door.\n"
)


async def _drama_project(tmp_path, script):
    from novelvideo.knowledge_pipeline import (
        KNOWLEDGE_PIPELINE_KEY, KNOWLEDGE_PIPELINE_STRUCTURED,
    )
    from novelvideo.sqlite_store import SQLiteStore

    state = tmp_path / "user" / "drama"
    state.mkdir(parents=True)
    (state / "project_config.json").write_text(
        json.dumps(
            {KNOWLEDGE_PIPELINE_KEY: KNOWLEDGE_PIPELINE_STRUCTURED,
             "spine_template": "drama"}
        ),
        encoding="utf-8",
    )
    (state / "novel.txt").write_text(script, encoding="utf-8")
    store = SQLiteStore("user/drama", output_dir=str(state), state_dir=str(state))
    await store.initialize()
    await store.load_graph_state()
    return store


def _fresh_scene(name):
    from novelvideo.models import NovelScene

    return NovelScene(
        name=name,
        scene_type="interior",
        environment_prompt="Front: flat main wall\nLeft: wooden door\nRight: window\nBack: file cabinet",
    )


async def test_a_placeholder_prompt_is_replaced_on_rebuild(tmp_path, monkeypatch):
    """A prompt this code generated is a placeholder, not an asset fact.

    Skipping every existing scene would leave projects built while the contract
    validator was broken on boilerplate for good, since nothing else rewrites
    those prompts.
    """
    from novelvideo import structured_builders
    from novelvideo.cognee.pipeline import _ensure_directional_environment_prompt
    from novelvideo.models import NovelScene

    store = await _drama_project(tmp_path, DRAMA_SCRIPT)
    try:
        placeholder = _ensure_directional_environment_prompt(
            prompt="", scene_name="Lin family living room", scene_type="interior",
            time_of_day="", context_lines=["▲Lin Mo pushed open the door."],
        )
        await store.add_scene(
            NovelScene(name="Lin family living room", environment_prompt=placeholder)
        )

        async def fake_extract(text, **kwargs):
            return [_fresh_scene("Lin family living room")]

        monkeypatch.setattr(
            "novelvideo.cognee.pipeline.extract_scenes_from_script", fake_extract
        )
        # Imported inside the builder, so it is patched at its source.
        monkeypatch.setattr(
            "novelvideo.structured_extraction.adjudicate_scenes",
            lambda scenes, **kwargs: _async_value(scenes),
        )

        result = await structured_builders.build_scenes_structured(store)
        assert result["repaired_scenes"] == 1

        stored = await store.get_scene("Lin family living room")
        assert "flat main wall" in stored.environment_prompt
    finally:
        await store.close()


async def test_a_user_written_prompt_is_never_replaced(tmp_path, monkeypatch):
    """Only the known generated placeholder is overwritten."""
    from novelvideo import structured_builders
    from novelvideo.models import NovelScene

    store = await _drama_project(tmp_path, DRAMA_SCRIPT)
    try:
        mine = "Front: a description I wrote myself\nLeft: also written by me\nRight: written by me\nBack: written by me"
        await store.add_scene(NovelScene(name="Lin family living room", environment_prompt=mine))

        async def fake_extract(text, **kwargs):
            return [_fresh_scene("Lin family living room")]

        monkeypatch.setattr(
            "novelvideo.cognee.pipeline.extract_scenes_from_script", fake_extract
        )
        # Imported inside the builder, so it is patched at its source.
        monkeypatch.setattr(
            "novelvideo.structured_extraction.adjudicate_scenes",
            lambda scenes, **kwargs: _async_value(scenes),
        )

        result = await structured_builders.build_scenes_structured(store)
        assert result["repaired_scenes"] == 0

        stored = await store.get_scene("Lin family living room")
        assert stored.environment_prompt == mine
    finally:
        await store.close()


def _async_value(value):
    async def _call():
        return value

    return _call()


# ── character appearance ────────────────────────────────────────────────────
#
# Extraction settles who exists; this stage settles what they look like. It is
# the half of legacy's CharacterEnrichment that structured extraction shipped
# without, which is why every structured project's characters carried an empty
# face prompt and the portrait runner refused to draw them.


class FakeAppearanceAgent:
    """Returns scripted appearances, recording every prompt it was sent."""

    def __init__(self, by_name, fail=False):
        self.by_name = by_name
        self.fail = fail
        self.prompts = []

    async def run(self, prompt: str):
        from novelvideo.structured_extraction import CharacterAppearanceList

        self.prompts.append(prompt)
        if self.fail:
            raise RuntimeError("boom")
        return SimpleNamespace(
            output=CharacterAppearanceList(
                characters=[
                    item for name, item in self.by_name.items() if name in prompt
                ]
            )
        )


def _appearance(name, *, face="Female, in her twenties, long black hair, almond eyes", **kwargs):
    from novelvideo.structured_extraction import CharacterAppearance

    return CharacterAppearance(name=name, face_prompt=face, **kwargs)


def _cast_member(name, *, gender="female", description="", quotes=("He came back.",)):
    from novelvideo.structured_extraction import MergedCharacter

    return MergedCharacter(
        name=name,
        gender=gender,
        description=description,
        evidence=[{"quote": quote} for quote in quotes],
    )


class RecordingCache:
    def __init__(self, rows=None):
        self.rows = dict(rows or {})
        self.saved = []

    async def get(self, artifact_type, cache_keys):
        return {
            key: self.rows[(artifact_type, key)]
            for key in cache_keys
            if (artifact_type, key) in self.rows
        }

    async def save(self, artifact_type, results):
        self.saved.append((artifact_type, dict(results)))
        for key, payload in results.items():
            self.rows[(artifact_type, key)] = payload


async def test_appearance_stage_fills_the_fields_extraction_cannot_quote():
    """A face, a role and a build are inferred, not quoted, so extraction skips them."""
    from novelvideo.structured_extraction import enrich_character_appearances

    agent = FakeAppearanceAgent(
        {
            "Zheng Jiayue": _appearance(
                "Zheng Jiayue", role="protagonist", body_type="slender and tall", age_group="youth"
            )
        }
    )
    result = await enrich_character_appearances([_cast_member("Zheng Jiayue")], agent=agent)

    assert result["Zheng Jiayue"].face_prompt == "Female, in her twenties, long black hair, almond eyes"
    assert result["Zheng Jiayue"].role == "protagonist"
    assert result["Zheng Jiayue"].body_type == "slender and tall"


async def test_english_appearance_requests_english_prose_and_keeps_the_source_name():
    from novelvideo.structured_extraction import enrich_character_appearances

    agent = FakeAppearanceAgent(
        {
            "Maya": _appearance(
                "Maya",
                face="woman, late twenties, dark wavy hair, brown eyes",
                role="librarian",
                body_type="slender",
                age_group="youth",
            )
        }
    )

    result = await enrich_character_appearances(
        [
            _cast_member(
                "Maya",
                description="A cautious librarian",
                quotes=("Maya opens the library door.",),
            )
        ],
        agent=agent,
    )

    assert result["Maya"].name == "Maya"
    assert result["Maya"].role == "librarian"
    assert "Write every user-visible prose field in English" in agent.prompts[0]


async def test_pre_language_contract_appearance_cache_keys_are_retired(monkeypatch):
    from novelvideo import structured_extraction
    from novelvideo.structured_extraction import character_appearance_cache_key

    current = character_appearance_cache_key(_cast_member("Maya"))
    monkeypatch.setattr(structured_extraction, "CHARACTER_APPEARANCE_CACHE_VERSION", 2)
    old = character_appearance_cache_key(_cast_member("Maya"))

    assert current != old


async def test_an_answer_without_a_face_is_dropped_rather_than_published():
    """An empty face prompt is a visible gap; boilerplate would be an invisible one."""
    from novelvideo.structured_extraction import enrich_character_appearances

    agent = FakeAppearanceAgent({"Zheng Jiayue": _appearance("Zheng Jiayue", face="  ", role="protagonist")})
    cache = RecordingCache()
    result = await enrich_character_appearances(
        [_cast_member("Zheng Jiayue")], agent=agent, cache=cache
    )

    assert result == {}
    assert cache.saved == []


async def test_an_unusable_age_band_falls_back_instead_of_reaching_the_column():
    """The band drives voice selection, so an unknown value would silently disable it."""
    from novelvideo.structured_extraction import enrich_character_appearances

    agent = FakeAppearanceAgent({"Zheng Jiayue": _appearance("Zheng Jiayue", age_group="middle-aged")})
    result = await enrich_character_appearances([_cast_member("Zheng Jiayue")], agent=agent)

    assert result["Zheng Jiayue"].age_group == "youth"


async def test_a_cached_appearance_is_never_sent_to_the_model_again():
    from novelvideo.structured_extraction import enrich_character_appearances

    cache = RecordingCache()
    item = _cast_member("Zheng Jiayue")
    first = FakeAppearanceAgent({"Zheng Jiayue": _appearance("Zheng Jiayue", role="protagonist")})
    await enrich_character_appearances([item], agent=first, cache=cache)
    assert len(first.prompts) == 1

    second = FakeAppearanceAgent({})
    result = await enrich_character_appearances([item], agent=second, cache=cache)
    assert second.prompts == []
    assert result["Zheng Jiayue"].role == "protagonist"


async def test_a_changed_description_retires_the_cached_appearance():
    """The description is in the prompt, so a changed one is a different question."""
    from novelvideo.structured_extraction import character_appearance_cache_key

    before = character_appearance_cache_key(_cast_member("Zheng Jiayue", description="suffered campus bullying"))
    after = character_appearance_cache_key(_cast_member("Zheng Jiayue", description="has graduated and is working"))
    assert before != after


async def test_a_changed_quote_retires_the_cached_appearance():
    from novelvideo.structured_extraction import character_appearance_cache_key

    before = character_appearance_cache_key(_cast_member("Zheng Jiayue", quotes=("She lowered her head.",)))
    after = character_appearance_cache_key(_cast_member("Zheng Jiayue", quotes=("She raised her head.",)))
    assert before != after


async def test_only_one_narrator_survives_a_batch_split():
    """Batches run concurrently, so "whoever answered first" is not a stable answer."""
    from novelvideo.structured_extraction import enrich_character_appearances

    agent = FakeAppearanceAgent(
        {
            "Zheng Jiayue": _appearance("Zheng Jiayue", is_main=True),
            "Zheng Yuqin": _appearance("Zheng Yuqin", is_main=True),
        }
    )
    result = await enrich_character_appearances(
        [_cast_member("Zheng Jiayue"), _cast_member("Zheng Yuqin")], agent=agent
    )

    assert [name for name, item in result.items() if item.is_main] == ["Zheng Jiayue"]


async def test_a_failed_appearance_call_still_leaves_the_cast_published(
    structured_store, monkeypatch
):
    """Losing a face must not lose the character it belonged to."""
    from novelvideo import structured_builders

    store, _ = structured_store
    monkeypatch.setattr(
        "novelvideo.structured_extraction._create_character_appearance_agent",
        lambda agent=None: FakeAppearanceAgent({}, fail=True),
    )
    added = await structured_builders._publish_characters(
        store, [_cast_member("Zheng Jiayue")], "", lambda *_: None, lambda *_: None
    )

    assert added == ["Zheng Jiayue"]
    assert store.get_character("Zheng Jiayue").face_prompt == ""


async def test_a_new_character_is_published_with_its_face_and_voice(
    structured_store, monkeypatch
):
    from novelvideo import structured_builders

    store, _ = structured_store
    monkeypatch.setenv("FISH_VOICE_YOUTH_FEMALE", "voice-yf")
    monkeypatch.setattr(
        "novelvideo.config.FISH_VOICE_PRESETS",
        {"youth_female": "voice-yf", "youth_male": "voice-ym"},
    )
    monkeypatch.setattr(
        "novelvideo.structured_extraction._create_character_appearance_agent",
        lambda agent=None: FakeAppearanceAgent(
            {"Zheng Jiayue": _appearance("Zheng Jiayue", role="protagonist", body_type="slender and tall")}
        ),
    )
    await structured_builders._publish_characters(
        store, [_cast_member("Zheng Jiayue")], "", lambda *_: None, lambda *_: None
    )

    character = store.get_character("Zheng Jiayue")
    assert character.face_prompt == "Female, in her twenties, long black hair, almond eyes"
    assert character.role == "protagonist"
    assert character.body_type == "slender and tall"
    # "female", not "女": the structured extractor writes the English form, and
    # a lookup that only knows the Chinese one gives every woman a male voice.
    assert character.fish_voice_id == "voice-yf"


async def test_a_rebuild_fills_a_face_an_existing_character_never_had(
    structured_store, monkeypatch
):
    """Characters built before this stage existed would otherwise stay faceless."""
    from novelvideo import structured_builders
    from novelvideo.cognee.pipeline import NovelCharacter

    store, _ = structured_store
    await store.add_characters_atomic(
        [NovelCharacter(name="Zheng Jiayue", gender="female")], skip_existing=False
    )
    assert store.get_character("Zheng Jiayue").face_prompt == ""

    monkeypatch.setattr(
        "novelvideo.config.FISH_VOICE_PRESETS",
        {"elder_female": "voice-ef", "elder_male": "voice-em"},
    )
    monkeypatch.setattr(
        "novelvideo.structured_extraction._create_character_appearance_agent",
        lambda agent=None: FakeAppearanceAgent(
            {"Zheng Jiayue": _appearance("Zheng Jiayue", role="protagonist", age_group="elder")}
        ),
    )
    added = await structured_builders._publish_characters(
        store, [_cast_member("Zheng Jiayue")], "", lambda *_: None, lambda *_: None
    )

    assert added == []
    repaired = store.get_character("Zheng Jiayue")
    assert repaired.face_prompt == "Female, in her twenties, long black hair, almond eyes"
    assert repaired.role == "protagonist"
    assert repaired.age_group == "elder"
    assert repaired.fish_voice_id == "voice-ef"


async def test_a_rebuild_leaves_an_age_band_a_bound_voice_depends_on(
    structured_store, monkeypatch
):
    """A bound voice means somebody chose the band; the repair must not move it."""
    from novelvideo import structured_builders
    from novelvideo.cognee.pipeline import NovelCharacter

    store, _ = structured_store
    await store.add_characters_atomic(
        [
            NovelCharacter(
                name="Zheng Jiayue",
                gender="female",
                age_group="youth",
                fish_voice_id="chosen-by-hand",
            )
        ],
        skip_existing=False,
    )
    monkeypatch.setattr(
        "novelvideo.structured_extraction._create_character_appearance_agent",
        lambda agent=None: FakeAppearanceAgent(
            {"Zheng Jiayue": _appearance("Zheng Jiayue", age_group="elder")}
        ),
    )
    await structured_builders._publish_characters(
        store, [_cast_member("Zheng Jiayue")], "", lambda *_: None, lambda *_: None
    )

    repaired = store.get_character("Zheng Jiayue")
    assert repaired.face_prompt == "Female, in her twenties, long black hair, almond eyes"
    assert repaired.age_group == "youth"
    assert repaired.fish_voice_id == "chosen-by-hand"


async def test_a_rebuild_never_overwrites_a_face_the_user_wrote(
    structured_store, monkeypatch
):
    from novelvideo import structured_builders
    from novelvideo.cognee.pipeline import NovelCharacter

    store, _ = structured_store
    await store.add_characters_atomic(
        [
            NovelCharacter(
                name="Zheng Jiayue", gender="female", face_prompt="a face I wrote myself", role="supporting"
            )
        ],
        skip_existing=False,
    )
    monkeypatch.setattr(
        "novelvideo.structured_extraction._create_character_appearance_agent",
        lambda agent=None: FakeAppearanceAgent(
            {"Zheng Jiayue": _appearance("Zheng Jiayue", role="protagonist")}
        ),
    )
    await structured_builders._publish_characters(
        store, [_cast_member("Zheng Jiayue")], "", lambda *_: None, lambda *_: None
    )

    assert store.get_character("Zheng Jiayue").face_prompt == "a face I wrote myself"
    assert store.get_character("Zheng Jiayue").role == "supporting"


def test_the_voice_lookup_reads_both_spellings_of_a_gender(monkeypatch):
    """legacy writes 男/女, structured_v1 writes male/female; both select a voice."""
    from novelvideo.config import get_fish_voice_id

    monkeypatch.setattr(
        "novelvideo.config.FISH_VOICE_PRESETS",
        {"youth_female": "voice-yf", "youth_male": "voice-ym"},
    )
    assert get_fish_voice_id("youth", "female") == "voice-yf"
    assert get_fish_voice_id("youth", "女") == "voice-yf"
    assert get_fish_voice_id("youth", "male") == "voice-ym"
    assert get_fish_voice_id("youth", "男") == "voice-ym"


async def test_the_character_bible_reaches_the_stage_that_writes_faces():
    """A screenplay's pre-scene block names hair and build outright; legacy sent it."""
    from novelvideo.structured_extraction import enrich_character_appearances

    agent = FakeAppearanceAgent({"Zheng Jiayue": _appearance("Zheng Jiayue")})
    await enrich_character_appearances(
        [_cast_member("Zheng Jiayue")], synopsis="Zheng Jiayue: short hair, slim.", agent=agent
    )

    assert "Zheng Jiayue: short hair, slim." in agent.prompts[0]


async def test_an_edited_character_bible_retires_every_stored_appearance():
    from novelvideo.structured_extraction import character_appearance_cache_key

    item = _cast_member("Zheng Jiayue")
    before = character_appearance_cache_key(item, "Zheng Jiayue: short hair, slim.")
    after = character_appearance_cache_key(item, "Zheng Jiayue: long hair, round face.")
    assert before != after


async def test_a_drama_build_reads_the_bible_from_the_imported_source(
    structured_store, monkeypatch
):
    """_publish_characters reaches publication without the source text in hand."""
    from novelvideo import structured_builders

    store, state_dir = structured_store
    (state_dir / "novel.txt").write_text(
        "Zheng Jiayue: short hair, slim.\n\n1-1 Classroom DAY INT\n\nZheng Jiayue sat down.\n", encoding="utf-8"
    )
    agent = FakeAppearanceAgent({"Zheng Jiayue": _appearance("Zheng Jiayue")})
    monkeypatch.setattr(
        "novelvideo.structured_extraction._create_character_appearance_agent",
        lambda a=None: agent,
    )
    await structured_builders._publish_characters(
        store, [_cast_member("Zheng Jiayue")], "", lambda *_: None, lambda *_: None
    )

    assert "Zheng Jiayue: short hair, slim." in agent.prompts[0]


async def test_a_rebuild_marks_the_narrator_an_existing_project_never_had(
    structured_store, monkeypatch
):
    """Without it, first-person narration fails with narrator protagonist not found forever."""
    from novelvideo import structured_builders
    from novelvideo.cognee.pipeline import NovelCharacter

    store, _ = structured_store
    await store.add_characters_atomic(
        [NovelCharacter(name="Zheng Jiayue", gender="female")], skip_existing=False
    )
    monkeypatch.setattr(
        "novelvideo.structured_extraction._create_character_appearance_agent",
        lambda agent=None: FakeAppearanceAgent(
            {"Zheng Jiayue": _appearance("Zheng Jiayue", is_main=True)}
        ),
    )
    await structured_builders._publish_characters(
        store, [_cast_member("Zheng Jiayue")], "", lambda *_: None, lambda *_: None
    )

    assert store.get_character("Zheng Jiayue").is_main is True


async def test_a_narrator_marked_by_hand_is_not_joined_by_a_second_one(
    structured_store, monkeypatch
):
    """Nothing binds to is_main, so an unclaimed narrator is the only signal."""
    from novelvideo import structured_builders
    from novelvideo.cognee.pipeline import NovelCharacter

    store, _ = structured_store
    await store.add_characters_atomic(
        [
            NovelCharacter(name="Zheng Yuqin", gender="female", is_main=True),
            NovelCharacter(name="Zheng Jiayue", gender="female"),
        ],
        skip_existing=False,
    )
    monkeypatch.setattr(
        "novelvideo.structured_extraction._create_character_appearance_agent",
        lambda agent=None: FakeAppearanceAgent(
            {"Zheng Jiayue": _appearance("Zheng Jiayue", is_main=True)}
        ),
    )
    await structured_builders._publish_characters(
        store, [_cast_member("Zheng Jiayue")], "", lambda *_: None, lambda *_: None
    )

    assert store.get_character("Zheng Jiayue").is_main is False
    assert store.get_character("Zheng Yuqin").is_main is True


async def test_a_face_written_by_hand_does_not_lock_out_the_other_fields(
    structured_store, monkeypatch
):
    """Gating the whole repair on a missing face punished the one field filled in."""
    from novelvideo import structured_builders
    from novelvideo.cognee.pipeline import NovelCharacter

    store, _ = structured_store
    await store.add_characters_atomic(
        [NovelCharacter(name="Zheng Jiayue", gender="female", face_prompt="a face I wrote myself")],
        skip_existing=False,
    )
    monkeypatch.setattr(
        "novelvideo.config.FISH_VOICE_PRESETS",
        {"elder_female": "voice-ef", "elder_male": "voice-em"},
    )
    monkeypatch.setattr(
        "novelvideo.structured_extraction._create_character_appearance_agent",
        lambda agent=None: FakeAppearanceAgent(
            {
                "Zheng Jiayue": _appearance(
                    "Zheng Jiayue", role="protagonist", body_type="slender and tall", age_group="elder"
                )
            }
        ),
    )
    await structured_builders._publish_characters(
        store, [_cast_member("Zheng Jiayue")], "", lambda *_: None, lambda *_: None
    )

    repaired = store.get_character("Zheng Jiayue")
    assert repaired.face_prompt == "a face I wrote myself"
    assert repaired.role == "protagonist"
    assert repaired.body_type == "slender and tall"
    assert repaired.fish_voice_id == "voice-ef"


async def test_a_character_with_nothing_missing_is_left_untouched(
    structured_store, monkeypatch
):
    """Every field guarded, so a settled character costs no write at all."""
    from novelvideo import structured_builders
    from novelvideo.cognee.pipeline import NovelCharacter

    store, _ = structured_store
    await store.add_characters_atomic(
        [
            NovelCharacter(
                name="Zheng Jiayue",
                gender="female",
                face_prompt="existing face",
                role="existing role",
                body_type="existing build",
                fish_voice_id="existing voice",
            )
        ],
        skip_existing=False,
    )
    writes = []
    original = store.update_character

    async def recording(name, **updates):
        writes.append((name, updates))
        await original(name, **updates)

    monkeypatch.setattr(store, "update_character", recording)
    monkeypatch.setattr(
        "novelvideo.structured_extraction._create_character_appearance_agent",
        lambda agent=None: FakeAppearanceAgent(
            {"Zheng Jiayue": _appearance("Zheng Jiayue", role="protagonist", body_type="slender and tall")}
        ),
    )
    await structured_builders._publish_characters(
        store, [_cast_member("Zheng Jiayue")], "", lambda *_: None, lambda *_: None
    )

    assert writes == []


async def test_a_newly_discovered_character_cannot_become_a_second_narrator(
    structured_store, monkeypatch
):
    """The insert lands before the repair path ever looks for a narrator."""
    from novelvideo import structured_builders
    from novelvideo.cognee.pipeline import NovelCharacter

    store, _ = structured_store
    await store.add_characters_atomic(
        [NovelCharacter(name="Zheng Yuqin", gender="female", is_main=True)],
        skip_existing=False,
    )
    monkeypatch.setattr(
        "novelvideo.structured_extraction._create_character_appearance_agent",
        lambda agent=None: FakeAppearanceAgent(
            {"Lin Mou": _appearance("Lin Mou", is_main=True)}
        ),
    )
    await structured_builders._publish_characters(
        store, [_cast_member("Lin Mou")], "", lambda *_: None, lambda *_: None
    )

    narrators = [c.name for c in store.get_all_characters() if c.is_main]
    assert narrators == ["Zheng Yuqin"]


async def test_a_stale_narrator_opinion_is_not_replayed_from_the_cache():
    """is_main depends on the whole cast; a per-character key cannot invalidate it."""
    from novelvideo.structured_extraction import enrich_character_appearances

    cache = RecordingCache()
    old = FakeAppearanceAgent({"Zheng Jiayue": _appearance("Zheng Jiayue", is_main=True)})
    await enrich_character_appearances([_cast_member("Zheng Jiayue")], agent=old, cache=cache)

    # The cast changed: someone else is the narrator now, and Zheng Jiayue's own
    # inputs are untouched, so her row is served straight from the cache.
    new = FakeAppearanceAgent({"Lin Mou": _appearance("Lin Mou", is_main=True)})
    result = await enrich_character_appearances(
        [_cast_member("Zheng Jiayue"), _cast_member("Lin Mou")], agent=new, cache=cache
    )

    assert [name for name, item in result.items() if item.is_main] == ["Lin Mou"]


async def test_the_build_still_seeds_a_narrator_when_the_project_has_none(
    structured_store, monkeypatch
):
    """Refusing to fight an existing choice must not mean never making one."""
    from novelvideo import structured_builders

    store, _ = structured_store
    monkeypatch.setattr(
        "novelvideo.structured_extraction._create_character_appearance_agent",
        lambda agent=None: FakeAppearanceAgent(
            {"Zheng Jiayue": _appearance("Zheng Jiayue", is_main=True)}
        ),
    )
    await structured_builders._publish_characters(
        store, [_cast_member("Zheng Jiayue")], "", lambda *_: None, lambda *_: None
    )

    assert [c.name for c in store.get_all_characters() if c.is_main] == ["Zheng Jiayue"]


async def test_a_retry_after_the_cache_landed_still_finds_its_narrator():
    """Interrupted between the appearance rows and the characters, retry abstains."""
    from novelvideo.structured_extraction import enrich_character_appearances

    cache = RecordingCache()
    cast = [_cast_member("Zheng Jiayue"), _cast_member("Lin Mou")]
    agent = FakeAppearanceAgent(
        {
            "Zheng Jiayue": _appearance("Zheng Jiayue", is_main=True),
            "Lin Mou": _appearance("Lin Mou"),
        }
    )
    first = await enrich_character_appearances(cast, agent=agent, cache=cache)
    assert [n for n, a in first.items() if a.is_main] == ["Zheng Jiayue"]

    # The process died before _publish_characters ran: every appearance row is
    # on disk, no character is. Every character now replays as an abstention.
    replay = FakeAppearanceAgent({})
    second = await enrich_character_appearances(cast, agent=replay, cache=cache)

    assert replay.prompts == []
    assert [n for n, a in second.items() if a.is_main] == ["Zheng Jiayue"]


async def test_a_changed_cast_puts_the_narrator_question_back_to_the_model():
    """The cast-level entry must not become the stale nomination it replaced."""
    from novelvideo.structured_extraction import enrich_character_appearances

    cache = RecordingCache()
    await enrich_character_appearances(
        [_cast_member("Zheng Jiayue")],
        agent=FakeAppearanceAgent({"Zheng Jiayue": _appearance("Zheng Jiayue", is_main=True)}),
        cache=cache,
    )

    # Lin Mou joins the cast and is nominated; Zheng Jiayue is served from her own row.
    result = await enrich_character_appearances(
        [_cast_member("Zheng Jiayue"), _cast_member("Lin Mou")],
        agent=FakeAppearanceAgent({"Lin Mou": _appearance("Lin Mou", is_main=True)}),
        cache=cache,
    )

    assert [n for n, a in result.items() if a.is_main] == ["Lin Mou"]


class OrderedCache(RecordingCache):
    """A cache that records the order writes arrive in, and can fail on one."""

    def __init__(self, rows=None, fail_on=None):
        super().__init__(rows)
        self.fail_on = fail_on
        self.writes: list[str] = []

    async def save(self, artifact_type, results):
        self.writes.append(artifact_type)
        if artifact_type == self.fail_on:
            raise RuntimeError("killed")
        await super().save(artifact_type, results)


async def test_a_batch_writes_its_nomination_before_the_rows_that_replay_it():
    """The rows are what make a batch look finished; the answer is not in them."""
    from novelvideo.structured_extraction import (
        CHARACTER_APPEARANCE_CACHE_TYPE,
        CHARACTER_NARRATOR_CACHE_TYPE,
        enrich_character_appearances,
    )

    cache = OrderedCache()
    await enrich_character_appearances(
        [_cast_member("Zheng Jiayue")],
        agent=FakeAppearanceAgent({"Zheng Jiayue": _appearance("Zheng Jiayue", is_main=True)}),
        cache=cache,
    )

    first = cache.writes.index(CHARACTER_NARRATOR_CACHE_TYPE)
    rows = cache.writes.index(CHARACTER_APPEARANCE_CACHE_TYPE)
    assert first < rows


async def test_a_crash_between_the_two_writes_leaves_the_batch_replayable():
    """Killed after the nomination but before the rows, the retry asks again."""
    from novelvideo.structured_extraction import (
        CHARACTER_APPEARANCE_CACHE_TYPE,
        enrich_character_appearances,
    )

    cache = OrderedCache(fail_on=CHARACTER_APPEARANCE_CACHE_TYPE)
    dying = FakeAppearanceAgent({"Zheng Jiayue": _appearance("Zheng Jiayue", is_main=True)})
    await enrich_character_appearances(
        [_cast_member("Zheng Jiayue")], agent=dying, cache=cache
    )

    # Nothing about that character survived, so the retry pays for it again
    # rather than replaying a row whose answer was never stored.
    cache.fail_on = None
    retry = FakeAppearanceAgent({"Zheng Jiayue": _appearance("Zheng Jiayue", is_main=True)})
    result = await enrich_character_appearances(
        [_cast_member("Zheng Jiayue")], agent=retry, cache=cache
    )

    assert retry.prompts != []
    assert [n for n, a in result.items() if a.is_main] == ["Zheng Jiayue"]


async def test_an_edited_description_retires_the_cast_decision_too():
    """Names alone survive an edit that changes what the model was asked."""
    from novelvideo.structured_extraction import (
        character_appearance_cache_key,
        narrator_cache_key,
    )

    before = character_appearance_cache_key(
        _cast_member("Zheng Jiayue", description="suffered campus bullying")
    )
    after = character_appearance_cache_key(
        _cast_member("Zheng Jiayue", description="has graduated and is working")
    )
    assert narrator_cache_key([before]) != narrator_cache_key([after])


async def test_a_cast_decision_is_not_replayed_across_edited_inputs():
    """End to end: the fallback must not answer from inputs that are gone."""
    from novelvideo.structured_extraction import enrich_character_appearances

    cache = RecordingCache()
    await enrich_character_appearances(
        [_cast_member("Zheng Jiayue", description="suffered campus bullying")],
        agent=FakeAppearanceAgent({"Zheng Jiayue": _appearance("Zheng Jiayue", is_main=True)}),
        cache=cache,
    )

    # Same cast, same order, different description — and this time the model
    # nominates nobody. The old decision must not stand in for an answer.
    result = await enrich_character_appearances(
        [_cast_member("Zheng Jiayue", description="has graduated and is working")],
        agent=FakeAppearanceAgent({"Zheng Jiayue": _appearance("Zheng Jiayue")}),
        cache=cache,
    )

    assert [n for n, a in result.items() if a.is_main] == []

class CrashBeforeSettlementCache(RecordingCache):
    """Dies at exactly the point the review named.

    Every appearance row is on disk — so every character replays as an
    abstention — and the run has not yet stored the decision it settled on.
    """

    def __init__(self, expected_row_writes):
        super().__init__()
        self.expected_row_writes = expected_row_writes
        self.row_writes = 0

    async def save(self, artifact_type, results):
        from novelvideo.structured_extraction import (
            CHARACTER_APPEARANCE_CACHE_TYPE,
            CHARACTER_NARRATOR_CACHE_TYPE,
        )

        if (
            artifact_type == CHARACTER_NARRATOR_CACHE_TYPE
            and self.row_writes >= self.expected_row_writes
        ):
            raise RuntimeError("killed before the settlement landed")
        if artifact_type == CHARACTER_APPEARANCE_CACHE_TYPE:
            self.row_writes += 1
        await super().save(artifact_type, results)


async def test_the_recovered_narrator_is_the_one_an_uninterrupted_run_would_pick(
    monkeypatch,
):
    """Two batches may both nominate, and the last to write is not the winner."""
    from novelvideo import structured_extraction
    from novelvideo.structured_extraction import enrich_character_appearances

    # One character per batch, run in sequence, so Lin Mou's batch writes last.
    monkeypatch.setattr(structured_extraction, "_APPEARANCE_BATCH_SIZE", 1)
    cache = CrashBeforeSettlementCache(expected_row_writes=2)
    cast = [_cast_member("Zheng Jiayue"), _cast_member("Lin Mou")]
    agent = FakeAppearanceAgent(
        {
            "Zheng Jiayue": _appearance("Zheng Jiayue", is_main=True),
            "Lin Mou": _appearance("Lin Mou", is_main=True),
        }
    )
    try:
        await enrich_character_appearances(
            cast, agent=agent, cache=cache, concurrency=1
        )
    except RuntimeError:
        pass

    # Whatever survived, the retry can only answer off disk: every appearance
    # is a cache hit and therefore abstains.
    replay = FakeAppearanceAgent({})
    recovered = await enrich_character_appearances(
        cast, agent=replay, cache=cache, concurrency=1
    )

    assert replay.prompts == []
    assert [n for n, a in recovered.items() if a.is_main] == ["Zheng Jiayue"]





async def test_two_batches_nominating_do_not_overwrite_each_other():
    """Separate keys, so the reduce happens on read rather than by race."""
    from novelvideo.structured_extraction import (
        CHARACTER_APPEARANCE_CACHE_VERSION,
        character_appearance_cache_key,
        narrator_cache_key,
        narrator_vote_key,
    )

    assert CHARACTER_APPEARANCE_CACHE_VERSION >= 2
    cast_key = narrator_cache_key(
        [
            character_appearance_cache_key(_cast_member("Zheng Jiayue")),
            character_appearance_cache_key(_cast_member("Lin Mou")),
        ]
    )
    assert narrator_vote_key(
        cast_key, character_appearance_cache_key(_cast_member("Zheng Jiayue"))
    ) != narrator_vote_key(
        cast_key, character_appearance_cache_key(_cast_member("Lin Mou"))
    )


async def test_a_resumed_build_keeps_the_narrator_the_first_attempt_nominated(
    monkeypatch,
):
    """A replayed character abstains in memory however loudly it once nominated."""
    from novelvideo import structured_extraction
    from novelvideo.structured_extraction import enrich_character_appearances

    monkeypatch.setattr(structured_extraction, "_APPEARANCE_BATCH_SIZE", 1)
    cache = RecordingCache()
    cast = [_cast_member("Zheng Jiayue"), _cast_member("Lin Mou")]

    # First attempt gets through Zheng Jiayue and stops before Lin Mou is answered.
    stopped = FakeAppearanceAgent({"Zheng Jiayue": _appearance("Zheng Jiayue", is_main=True)})
    first = await enrich_character_appearances(
        cast, agent=stopped, cache=cache, concurrency=1
    )
    assert [n for n, a in first.items() if a.is_main] == ["Zheng Jiayue"]
    assert "Lin Mou" not in first

    # The retry replays Zheng Jiayue from cache — silently — and answers Lin Mou fresh,
    # who nominates himself. Cast order still decides.
    resumed = FakeAppearanceAgent({"Lin Mou": _appearance("Lin Mou", is_main=True)})
    second = await enrich_character_appearances(
        cast, agent=resumed, cache=cache, concurrency=1
    )

    assert set(second) == {"Zheng Jiayue", "Lin Mou"}
    assert [n for n, a in second.items() if a.is_main] == ["Zheng Jiayue"]


# ── structured output failures: diagnostics ────────────────────────────────


class ExplodingAgent:
    """Raises PydanticAI's output-retry error, optionally with a cause."""

    def __init__(self, cause: BaseException | None = None):
        self.cause = cause
        self.calls = 0

    async def run(self, prompt: str):
        from pydantic_ai.exceptions import UnexpectedModelBehavior

        self.calls += 1
        exc = UnexpectedModelBehavior("Exceeded maximum output retries (2)")
        if self.cause is not None:
            raise exc from self.cause
        raise exc


async def test_failure_log_names_the_underlying_cause():
    """'Exceeded maximum output retries' alone is useless; the cause must be logged."""
    chunk = _chunk("Lin Mo walked into the house.")
    primary = ExplodingAgent(cause=ValueError("characters.0.evidence: Field required"))
    logs: list[str] = []

    merged, failures = await extract_characters_from_chunks(
        [chunk], agent=primary, source_text=chunk.text, on_log=logs.append, adjudicate=False
    )

    assert merged == [] and len(failures) == 1
    assert any("characters.0.evidence: Field required" in line for line in logs)
    assert any("Exceeded maximum output retries" in line for line in logs)


def test_describe_output_failure_includes_retry_prompts():
    from pydantic_ai.exceptions import UnexpectedModelBehavior
    from pydantic_ai.messages import ModelRequest, RetryPromptPart

    from novelvideo.structured_extraction import describe_output_failure

    messages = [
        ModelRequest(parts=[RetryPromptPart(content="Please call the final_result tool")]),
        ModelRequest(
            parts=[
                RetryPromptPart(
                    content=[
                        {
                            "type": "missing",
                            "loc": ("characters", 0, "evidence"),
                            "msg": "Field required",
                            "input": {},
                        }
                    ]
                )
            ]
        ),
    ]
    exc = UnexpectedModelBehavior("Exceeded maximum output retries (2)")

    text = describe_output_failure(exc, messages)

    assert "Exceeded maximum output retries (2)" in text
    assert "final_result" in text
    assert "Field required" in text
