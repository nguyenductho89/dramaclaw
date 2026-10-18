"""After a character rename, character-name / identity_id references scattered across the DB must follow.

The format of ``identity_id`` is ``<character name>_<identity name>``, so as soon as a character is renamed, every stored
identity_id becomes invalid at once. The full list of references is in the module docstring of
``novelvideo.utils.identity_refs`` (produced by going through every column of the CREATE TABLE SQL),
and each of them is covered here:

* ``episodes.character_names``         -- character names
* ``episodes.identity_ids``            -- identities appearing in the episode
* ``episodes.identity_default_map_json`` -- ``{character name: identity_id}``, with the character name in both key and value
* ``episodes.sketch_colors_json``      -- ``{identity_id: color}``
* ``episodes.prop_menu_json``          -- the ``owner_identity_id`` of each item
* ``beats.detected_identities_json``   -- identities detected in this beat
* ``beats.visual_description``         -- ``{{character name_identity name}}`` text markers
* ``beats.speaker``                    -- identity_id (a bare character name is legacy compatibility)
* ``props.owner``                      -- a character name **or** an identity_id; both formats are in use
* ``seedance2_voice_audio_records.speaker`` -- identity_id, and part of the primary key

Missing any one of them breaks the chain for identity images and color assignment: ``rename_character`` is a low-frequency manual operation,
while legacy-name self-healing runs automatically as soon as the user opens the character list, so a broken chain would spread all at once.
"""

import json
import sqlite3

import pytest

from novelvideo.models import NovelCharacter
from novelvideo.sqlite_store import SQLiteStore


@pytest.fixture
async def store(tmp_path):
    project_dir = tmp_path / "user" / "project"
    project_dir.mkdir(parents=True)
    store = SQLiteStore(
        "user/project", output_dir=str(project_dir), state_dir=str(project_dir)
    )
    await store._ensure_db()
    try:
        yield store
    finally:
        await store.close()


def _seed_episode_and_beat(project_dir, char_name: str) -> None:
    """Write to the DB directly, bypassing the sanitization of the model layer, to simulate legacy references under the old character name."""
    identity_id = f"{char_name}_casual"
    conn = sqlite3.connect(project_dir / "data.db")
    try:
        conn.execute(
            "INSERT INTO episodes (number, title, character_names, identity_ids, "
            "identity_default_map_json, sketch_colors_json, prop_menu_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                1,
                "Episode One",
                json.dumps([char_name], ensure_ascii=False),
                json.dumps([identity_id], ensure_ascii=False),
                json.dumps({char_name: identity_id}, ensure_ascii=False),
                json.dumps({identity_id: "#ff0000"}, ensure_ascii=False),
                json.dumps(
                    [
                        {
                            "prop_id": "Pocket Watch",
                            "prop_type": "object",
                            "owner_identity_id": identity_id,
                        },
                        # A prop item with no owner: it must not be touched, nor make the whole menu be judged "changed".
                        {"prop_id": "Street Lamp", "prop_type": "object", "owner_identity_id": ""},
                    ],
                    ensure_ascii=False,
                ),
            ),
        )
        # props.owner must cover both formats: ``Pocket Watch`` is promoted via prop_promotion_service, so the owner
        # holds an identity_id; ``Key`` is filled in by hand through the API, so it holds the character name.
        conn.execute(
            "INSERT INTO props (name, owner) VALUES (?, ?)", ("Pocket Watch", identity_id)
        )
        conn.execute("INSERT INTO props (name, owner) VALUES (?, ?)", ("Key", char_name))
        conn.execute("INSERT INTO props (name, owner) VALUES (?, ?)", ("Street Lamp", ""))
        # speaker stores an identity_id, not a character name -- ``BeatUpdate.speaker`` is documented as "speaker
        # identity ID", and voice resolution matches exactly by ``identity.identity_id == speaker``. The speaker of a voice record
        # is in turn passed down from the beat, the same contract.
        conn.execute(
            "INSERT INTO seedance2_voice_audio_records (episode_number, beat_number, "
            "speaker, audio_path, voice_sha256, mode, provider, model, generated_at, "
            "status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (1, 1, identity_id, "a.wav", "sha", "clone", "indextts2", "m", "now", "ok"),
        )
        conn.execute(
            "INSERT INTO beats (episode_number, beat_number, visual_description, "
            "detected_identities_json, speaker) VALUES (?, ?, ?, ?, ?)",
            (
                1,
                1,
                f"{{{{{identity_id}}}}} walked into the living room",
                json.dumps([identity_id], ensure_ascii=False),
                identity_id,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def _read_refs(project_dir) -> dict:
    conn = sqlite3.connect(project_dir / "data.db")
    conn.row_factory = sqlite3.Row
    try:
        ep = conn.execute("SELECT * FROM episodes WHERE number = 1").fetchone()
        beat = conn.execute(
            "SELECT * FROM beats WHERE episode_number = 1 AND beat_number = 1"
        ).fetchone()
        props = conn.execute("SELECT name, owner FROM props").fetchall()
        voice = conn.execute(
            "SELECT speaker FROM seedance2_voice_audio_records"
        ).fetchall()
    finally:
        conn.close()
    refs = {
        "character_names": json.loads(ep["character_names"] or "[]"),
        "identity_ids": json.loads(ep["identity_ids"] or "[]"),
        "identity_default_map": json.loads(ep["identity_default_map_json"] or "{}"),
        "sketch_colors": json.loads(ep["sketch_colors_json"] or "{}"),
        "prop_menu": json.loads(ep["prop_menu_json"] or "[]"),
        "prop_owners": {row["name"]: row["owner"] for row in props},
        "voice_speakers": sorted(row["speaker"] for row in voice),
    }
    if beat is not None:
        refs.update(
            {
                "detected_identities": json.loads(
                    beat["detected_identities_json"] or "[]"
                ),
                "visual_description": beat["visual_description"],
                "speaker": beat["speaker"],
            }
        )
    return refs


def _assert_remapped_to(refs: dict, new_name: str) -> None:
    identity_id = f"{new_name}_casual"
    assert refs["character_names"] == [new_name]
    assert refs["identity_ids"] == [identity_id]
    assert refs["identity_default_map"] == {new_name: identity_id}
    assert refs["sketch_colors"] == {identity_id: "#ff0000"}
    assert refs["detected_identities"] == [identity_id]
    assert refs["visual_description"] == f"{{{{{identity_id}}}}} walked into the living room"
    assert refs["speaker"] == identity_id
    assert refs["prop_menu"] == [
        {"prop_id": "Pocket Watch", "prop_type": "object", "owner_identity_id": identity_id},
        {"prop_id": "Street Lamp", "prop_type": "object", "owner_identity_id": ""},
    ]
    assert refs["prop_owners"] == {"Pocket Watch": identity_id, "Key": new_name, "Street Lamp": ""}
    assert refs["voice_speakers"] == [identity_id]


@pytest.mark.asyncio
async def test_rename_character_cascades_identity_refs(store, tmp_path):
    project_dir = tmp_path / "user" / "project"
    await store.add_character(NovelCharacter(name="Lin Xiaoman"))
    _seed_episode_and_beat(project_dir, "Lin Xiaoman")
    await store.load_graph_state()

    await store.rename_character("Lin Xiaoman", "Lin Man")

    _assert_remapped_to(_read_refs(project_dir), "Lin Man")


@pytest.mark.asyncio
async def test_path_repair_cascades_identity_refs(store, tmp_path):
    """Self-healing runs raw SQL, so the cascade cannot hang only off rename_character."""
    from novelvideo.api.routes.characters import _heal_path_unsafe_character_names

    project_dir = tmp_path / "user" / "project"
    conn = sqlite3.connect(project_dir / "data.db")
    try:
        conn.execute(
            "INSERT INTO characters (name, identities_json) VALUES (?, ?)",
            (
                "Lin/Xiaoman",
                json.dumps(
                    [
                        {
                            "character_name": "Lin/Xiaoman",
                            "identity_name": "casual",
                            "identity_id": "Lin/Xiaoman_casual",
                        }
                    ],
                    ensure_ascii=False,
                ),
            ),
        )
        conn.commit()
    finally:
        conn.close()
    _seed_episode_and_beat(project_dir, "Lin/Xiaoman")

    await _heal_path_unsafe_character_names(store, project_dir)

    _assert_remapped_to(_read_refs(project_dir), "Lin_Xiaoman")


@pytest.mark.asyncio
async def test_cascade_leaves_other_characters_alone(store, tmp_path):
    """Renaming ``Lin Xiaoman_casual`` must not also rewrite ``Lin Xiaomanyue_casual`` along the way."""
    project_dir = tmp_path / "user" / "project"
    await store.add_character(NovelCharacter(name="Lin Xiaoman"))
    await store.add_character(NovelCharacter(name="Lin Xiaomanyue"))
    conn = sqlite3.connect(project_dir / "data.db")
    try:
        conn.execute(
            "INSERT INTO episodes (number, identity_ids, identity_default_map_json) "
            "VALUES (?, ?, ?)",
            (
                1,
                json.dumps(["Lin Xiaoman_casual", "Lin Xiaomanyue_casual"], ensure_ascii=False),
                json.dumps(
                    {"Lin Xiaoman": "Lin Xiaoman_casual", "Lin Xiaomanyue": "Lin Xiaomanyue_casual"},
                    ensure_ascii=False,
                ),
            ),
        )
        conn.commit()
    finally:
        conn.close()
    await store.load_graph_state()

    await store.rename_character("Lin Xiaoman", "Lin Man")

    refs = _read_refs(project_dir)
    assert refs["identity_ids"] == ["Lin Man_casual", "Lin Xiaomanyue_casual"]
    assert refs["identity_default_map"] == {
        "Lin Man": "Lin Man_casual",
        "Lin Xiaomanyue": "Lin Xiaomanyue_casual",
    }


@pytest.mark.asyncio
async def test_cascade_survives_reload(store, tmp_path):
    """After the change it must be readable back from the DB; do not change only the memory."""
    project_dir = tmp_path / "user" / "project"
    await store.add_character(NovelCharacter(name="Lin Xiaoman"))
    _seed_episode_and_beat(project_dir, "Lin Xiaoman")
    await store.load_graph_state()

    await store.rename_character("Lin Xiaoman", "Lin Man")
    await store.load_graph_state()

    episode = store.get_episode(1)
    assert episode is not None
    assert episode.identity_ids == ["Lin Man_casual"]


@pytest.mark.asyncio
async def test_bare_character_name_speaker_still_remaps(store, tmp_path):
    """The speaker contract is identity_id, but legacy data holds bare character names, and both must be migrated."""
    project_dir = tmp_path / "user" / "project"
    await store.add_character(NovelCharacter(name="Lin Xiaoman"))
    conn = sqlite3.connect(project_dir / "data.db")
    try:
        conn.execute(
            "INSERT INTO beats (episode_number, beat_number, speaker) VALUES (?, ?, ?)",
            (1, 1, "Lin Xiaoman"),
        )
        conn.execute(
            "INSERT INTO seedance2_voice_audio_records (episode_number, beat_number, "
            "speaker, audio_path, voice_sha256, mode, provider, model, generated_at, "
            "status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (1, 1, "Lin Xiaoman", "a.wav", "sha", "clone", "indextts2", "m", "now", "ok"),
        )
        conn.commit()
    finally:
        conn.close()
    await store.load_graph_state()

    await store.rename_character("Lin Xiaoman", "Lin Man")

    conn = sqlite3.connect(project_dir / "data.db")
    try:
        speaker = conn.execute("SELECT speaker FROM beats").fetchone()[0]
        voice = conn.execute(
            "SELECT speaker FROM seedance2_voice_audio_records"
        ).fetchone()[0]
    finally:
        conn.close()
    assert speaker == "Lin Man"
    assert voice == "Lin Man"


@pytest.mark.asyncio
async def test_non_character_speaker_is_left_alone(store, tmp_path):
    """The speaker of broadcasts / voice-overs is not a character; do not change it along the way."""
    project_dir = tmp_path / "user" / "project"
    await store.add_character(NovelCharacter(name="Lin Xiaoman"))
    conn = sqlite3.connect(project_dir / "data.db")
    try:
        conn.execute(
            "INSERT INTO beats (episode_number, beat_number, speaker, speaker_kind) "
            "VALUES (?, ?, ?, ?)",
            (1, 1, "Lin Xiaoman_broadcast", "non_character"),
        )
        conn.commit()
    finally:
        conn.close()
    await store.load_graph_state()

    await store.rename_character("Lin Xiaoman", "Lin Man")

    conn = sqlite3.connect(project_dir / "data.db")
    try:
        speaker = conn.execute("SELECT speaker FROM beats").fetchone()[0]
    finally:
        conn.close()
    assert speaker == "Lin Xiaoman_broadcast"


@pytest.mark.asyncio
async def test_voice_record_conflict_drops_the_stale_row(store, tmp_path):
    """speaker is in the primary key; a collision must neither blow up nor overwrite the row already under the new name."""
    project_dir = tmp_path / "user" / "project"
    await store.add_character(NovelCharacter(name="Lin Xiaoman"))
    conn = sqlite3.connect(project_dir / "data.db")
    try:
        for speaker, audio in (("Lin Xiaoman_casual", "old.wav"), ("Lin Man_casual", "new.wav")):
            conn.execute(
                "INSERT INTO seedance2_voice_audio_records (episode_number, "
                "beat_number, speaker, audio_path, voice_sha256, mode, provider, "
                "model, generated_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (1, 1, speaker, audio, "sha", "clone", "indextts2", "m", "now", "ok"),
            )
        conn.commit()
    finally:
        conn.close()
    await store.load_graph_state()

    await store.rename_character("Lin Xiaoman", "Lin Man")

    conn = sqlite3.connect(project_dir / "data.db")
    try:
        rows = conn.execute(
            "SELECT speaker, audio_path FROM seedance2_voice_audio_records"
        ).fetchall()
    finally:
        conn.close()
    # The row already under the new name stays and the old one is dropped -- not the other way round.
    assert rows == [("Lin Man_casual", "new.wav")]
