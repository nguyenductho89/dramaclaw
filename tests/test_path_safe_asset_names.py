"""A slash in an asset name must be blocked at the write entry, and legacy ones must self-heal.

Background: the ``name`` of a character / scene / prop is at once a SQLite primary key, a REST path segment and a disk directory name.
When the name contains ``/``, uvicorn turns ``%2F`` back into a real slash before route matching, ``{name}`` no longer matches,
and the whole row of delete / rename / generate-source-image endpoints all return FastAPI's 404 -- which shows up as "I clicked delete and the page still has it,
clicking generate source image shows NOT FOUND".
"""

import json
import sqlite3

import pytest

from novelvideo.models import NovelCharacter, NovelProp, NovelScene
from novelvideo.sqlite_store import SQLiteStore
from novelvideo.utils.asset_names import (
    coerce_path_safe_asset_name,
    is_path_safe_asset_name,
    path_safe_asset_name,
    unique_path_safe_asset_name,
)


# ── pure functions ───────────────────────────────────────────────


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Home Living Room/Brother Bedroom", "Home Living Room_Brother Bedroom"),
        ("Home Living Room//Brother Bedroom", "Home Living Room_Brother Bedroom"),
        ("Home Living Room\\Brother Bedroom", "Home Living Room_Brother Bedroom"),
        ("Phòng khách nhà", "Phòng khách nhà"),
        ("", ""),
        (None, ""),
    ],
)
def test_path_safe_asset_name(raw, expected):
    assert path_safe_asset_name(raw) == expected


def test_only_slashes_are_replaced():
    """Spaces, ``#``, ``%``, ``:`` etc. pass safely through routing once percent-encoded, and must not be touched."""
    weird = "Living Room #1 (50%) : night"
    assert path_safe_asset_name(weird) == weird
    assert is_path_safe_asset_name(weird)


def test_coerce_keeps_original_as_alias():
    safe, aliases = coerce_path_safe_asset_name("Home Living Room/Brother Bedroom", ["Bedroom"])
    assert safe == "Home Living Room_Brother Bedroom"
    assert aliases == ["Bedroom", "Home Living Room/Brother Bedroom"]


def test_coerce_leaves_clean_names_untouched():
    safe, aliases = coerce_path_safe_asset_name("Home Living Room", ["Living Room"])
    assert safe == "Home Living Room"
    assert aliases == ["Living Room"]


def test_sanitizing_never_trims_whitespace():
    """Sanitization runs on the model read path, and ``name`` is a primary key -- a casual strip would create rows that cannot be deleted.

    The DB holds ``"Living Room "``; if reading it back turned it into ``"Living Room"``, ``DELETE ... WHERE name = ?`` would again
    delete nothing, exactly like the slash bug. To trim, call strip explicitly at the write entry.
    """
    assert path_safe_asset_name(" Living Room ") == " Living Room "
    assert coerce_path_safe_asset_name(" Living Room ") == (" Living Room ", [])
    assert NovelScene(name=" Living Room ").name == " Living Room "
    assert NovelProp(name=" Wooden Sword ").name == " Wooden Sword "
    assert NovelCharacter(name=" Lin Xiaoman ").name == " Lin Xiaoman "


def test_character_kind_matches_the_character_model_charset():
    """The character rule must be exactly the same as ``NovelCharacter.sanitize_name``.

    Once the two sides' character sets diverge, the route checks duplicates with the narrow rule and lets ``Wang:Xiaoming`` through, while the model layer rewrites it with the wide rule into
    ``Wang_Xiaoming``, and ``INSERT … ON CONFLICT(name)`` then silently overwrites the real ``Wang_Xiaoming``.
    """
    for raw in ('Wang:Xiaoming', 'Wang*Xiaoming', 'Wang?Xiaoming', 'Wang"Xiaoming', "Wang<Xiaoming", "Wang>Xiaoming", "Wang|Xiaoming"):
        assert path_safe_asset_name(raw, kind="character") == NovelCharacter(name=raw).name
        assert not is_path_safe_asset_name(raw, kind="character")
        # The asset rule is deliberately narrower: these characters pass safely through routing and the filesystem once percent-encoded.
        assert is_path_safe_asset_name(raw)
        assert path_safe_asset_name(raw) == raw


def test_unique_name_avoids_collision():
    assert unique_path_safe_asset_name("a/b", {"a_b"}) == "a_b_2"
    assert unique_path_safe_asset_name("a/b", {"a_b", "a_b_2"}) == "a_b_3"
    assert unique_path_safe_asset_name("a/b", set()) == "a_b"


# ── gate in the model layer ────────────────────────────────────────────


def test_scene_model_sanitizes_name_and_keeps_alias():
    scene = NovelScene(name="Home Living Room/Brother Bedroom", aliases=["Bedroom"])
    assert scene.name == "Home Living Room_Brother Bedroom"
    assert scene.aliases == ["Bedroom", "Home Living Room/Brother Bedroom"]


def test_prop_model_sanitizes_name_and_keeps_alias():
    prop = NovelProp(name="Props/Wooden Sword")
    assert prop.name == "Props_Wooden Sword"
    assert prop.aliases == ["Props/Wooden Sword"]


def test_character_model_already_sanitized_name():
    """Characters have long had this gate (``sanitize_name``); scenes / props got it in this change."""
    assert NovelCharacter(name="Lin/Xiaoman").name == "Lin_Xiaoman"


# ── store write entry ──────────────────────────────────────────


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


def _db_names(project_dir, table):
    conn = sqlite3.connect(project_dir / "data.db")
    try:
        return sorted(row[0] for row in conn.execute(f"SELECT name FROM {table}"))
    finally:
        conn.close()


def _insert_dirty(project_dir, table, name, **columns):
    """Bypass the model and write dirty data directly, simulating this gate plus the legacy data persisted before it."""
    columns.setdefault("aliases_json", json.dumps([], ensure_ascii=False))
    keys = ["name", *columns]
    conn = sqlite3.connect(project_dir / "data.db")
    try:
        conn.execute(
            f"INSERT INTO {table} ({', '.join(keys)}) "
            f"VALUES ({', '.join('?' * len(keys))})",
            (name, *columns.values()),
        )
        conn.commit()
    finally:
        conn.close()


@pytest.mark.asyncio
async def test_add_scene_writes_sanitized_name(store, tmp_path):
    scene = NovelScene(name="Home Living Room/Brother Bedroom")
    await store.add_scene(scene)

    assert _db_names(tmp_path / "user" / "project", "scenes") == ["Home Living Room_Brother Bedroom"]
    # The original name becomes an alias, so existing references in beats / storyboards do not break.
    assert (await store.get_scene("Home Living Room/Brother Bedroom")).name == "Home Living Room_Brother Bedroom"


@pytest.mark.asyncio
async def test_add_prop_writes_sanitized_name(store, tmp_path):
    await store.add_prop(NovelProp(name="Props/Wooden Sword"))

    assert _db_names(tmp_path / "user" / "project", "props") == ["Props_Wooden Sword"]
    assert (await store.get_prop("Props/Wooden Sword")).name == "Props_Wooden Sword"


@pytest.mark.asyncio
async def test_rename_scene_sanitizes_target(store):
    await store.add_scene(NovelScene(name="Living Room"))
    assert await store.rename_scene("Living Room", "Home/Living Room") is True
    assert await store.get_scene("Home_Living Room") is not None


@pytest.mark.asyncio
async def test_rename_prop_sanitizes_target(store):
    await store.add_prop(NovelProp(name="Wooden Sword"))
    assert await store.rename_prop("Wooden Sword", "Props/Wooden Sword") is True
    assert (await store.get_prop("Props_Wooden Sword")) is not None


# ── legacy self-healing ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_repair_is_noop_when_all_names_are_clean(store):
    await store.add_scene(NovelScene(name="Living Room"))

    def move_assets(old_name, new_name):  # pragma: no cover - must not be called
        raise AssertionError("Clean data must not trigger a directory migration")

    assert await store.repair_path_unsafe_asset_names("scene", move_assets) == {}


@pytest.mark.asyncio
async def test_repair_renames_scene_and_keeps_alias(store, tmp_path):
    project_dir = tmp_path / "user" / "project"
    _insert_dirty(project_dir, "scenes", "Home Living Room/Brother Bedroom")

    renamed = await store.repair_path_unsafe_asset_names("scene")

    assert renamed == {"Home Living Room/Brother Bedroom": "Home Living Room_Brother Bedroom"}
    assert _db_names(project_dir, "scenes") == ["Home Living Room_Brother Bedroom"]
    # The original name is kept as an alias -- scenes referenced by the old name in beats can still be found.
    assert (await store.get_scene("Home Living Room/Brother Bedroom")).name == "Home Living Room_Brother Bedroom"


@pytest.mark.asyncio
async def test_repair_remaps_derived_scene_pointers(store, tmp_path):
    project_dir = tmp_path / "user" / "project"
    _insert_dirty(project_dir, "scenes", "Home Living Room/Brother Bedroom")
    _insert_dirty(
        project_dir,
        "scenes",
        "Home Living Room/Brother Bedroom_night",
        base_scene_id="Home Living Room/Brother Bedroom",
    )

    await store.repair_path_unsafe_asset_names("scene")

    derived = await store.get_scene("Home Living Room_Brother Bedroom_night")
    assert derived.base_scene_id == "Home Living Room_Brother Bedroom"


@pytest.mark.asyncio
async def test_repair_avoids_colliding_with_existing_name(store, tmp_path):
    project_dir = tmp_path / "user" / "project"
    _insert_dirty(project_dir, "scenes", "a_b")
    _insert_dirty(project_dir, "scenes", "a/b")

    assert await store.repair_path_unsafe_asset_names("scene") == {"a/b": "a_b_2"}
    assert _db_names(project_dir, "scenes") == ["a_b", "a_b_2"]


@pytest.mark.asyncio
async def test_repair_skips_record_when_assets_cannot_move(store, tmp_path):
    """If the directory cannot be moved, do not rename: a record pointing at someone else's image is worse than keeping a bad name."""
    project_dir = tmp_path / "user" / "project"
    _insert_dirty(project_dir, "scenes", "a/b")

    def move_assets(old_name, new_name):
        raise ValueError("target exists")

    assert await store.repair_path_unsafe_asset_names("scene", move_assets) == {}
    assert _db_names(project_dir, "scenes") == ["a/b"]


@pytest.mark.asyncio
async def test_repair_moves_asset_dirs_via_scene_route_helper(store, tmp_path):
    from novelvideo.api.routes.scenes import _heal_path_unsafe_scene_names

    project_dir = tmp_path / "user" / "project"
    _insert_dirty(project_dir, "scenes", "Home Living Room/Brother Bedroom")
    legacy_dir = project_dir / "assets" / "scenes" / "Home Living Room" / "Brother Bedroom"
    legacy_dir.mkdir(parents=True)
    (legacy_dir / "master.png").write_bytes(b"png")

    await _heal_path_unsafe_scene_names(store, project_dir)

    assert _db_names(project_dir, "scenes") == ["Home Living Room_Brother Bedroom"]
    # The asset directory moves along, so the source image is not lost because of the rename.
    assert (project_dir / "assets" / "scenes" / "Home Living Room_Brother Bedroom" / "master.png").exists()


@pytest.mark.asyncio
async def test_repair_prop_via_route_helper(store, tmp_path):
    from novelvideo.api.routes.props import _heal_path_unsafe_prop_names

    project_dir = tmp_path / "user" / "project"
    _insert_dirty(project_dir, "props", "Props/Wooden Sword")
    legacy_dir = project_dir / "assets" / "props" / "Props" / "Wooden Sword"
    legacy_dir.mkdir(parents=True)
    (legacy_dir / "reference_3view.png").write_bytes(b"png")

    await _heal_path_unsafe_prop_names(store, project_dir)

    assert _db_names(project_dir, "props") == ["Props_Wooden Sword"]
    assert (
        project_dir / "assets" / "props" / "Props_Wooden Sword" / "reference_3view.png"
    ).exists()


@pytest.mark.asyncio
async def test_repair_character_via_route_helper(store, tmp_path):
    from novelvideo.api.routes.characters import _heal_path_unsafe_character_names

    project_dir = tmp_path / "user" / "project"
    _insert_dirty(project_dir, "characters", "Lin/Xiaoman")

    await _heal_path_unsafe_character_names(store, project_dir)

    # Before the fix the primary key still carried the slash, and DELETE ... WHERE name = 'Lin_Xiaoman' deleted no row.
    assert _db_names(project_dir, "characters") == ["Lin_Xiaoman"]
    assert store.get_character("Lin_Xiaoman") is not None
    assert store.get_character("Lin/Xiaoman") is not None


@pytest.mark.asyncio
async def test_repair_character_remaps_identities(store, tmp_path):
    """An identity record embeds the character name in character_name / identity_id, and a rename must follow.

    If it does not, identity images look under ``assets/characters/Lin_Xiaoman/`` for a file name built from the old name,
    and not a single one can be read. ``rename_character`` has always done this, and so must self-healing.
    """
    from novelvideo.api.routes.characters import _heal_path_unsafe_character_names

    project_dir = tmp_path / "user" / "project"
    identities = [
        {
            "character_name": "Lin/Xiaoman",
            "identity_name": "casual",
            "identity_id": "Lin/Xiaoman_casual",
        }
    ]
    _insert_dirty(
        project_dir,
        "characters",
        "Lin/Xiaoman",
        identities_json=json.dumps(identities, ensure_ascii=False),
    )

    await _heal_path_unsafe_character_names(store, project_dir)

    conn = sqlite3.connect(project_dir / "data.db")
    try:
        raw = conn.execute(
            "SELECT identities_json FROM characters WHERE name = ?", ("Lin_Xiaoman",)
        ).fetchone()[0]
    finally:
        conn.close()
    stored = json.loads(raw)
    assert stored[0]["character_name"] == "Lin_Xiaoman"
    assert stored[0]["identity_id"] == "Lin_Xiaoman_casual"


@pytest.mark.asyncio
async def test_repair_runs_once_per_store(store, tmp_path):
    """The list endpoint is a concurrent entry point; self-healing runs once per asset kind -- two requests moving directories at the same time would trample each other."""
    project_dir = tmp_path / "user" / "project"
    _insert_dirty(project_dir, "scenes", "Home Living Room/Brother Bedroom")

    first = await store.repair_path_unsafe_asset_names("scene")
    assert first == {"Home Living Room/Brother Bedroom": "Home Living Room_Brother Bedroom"}

    _insert_dirty(project_dir, "scenes", "Kitchen/Storage Room")
    moved: list[tuple[str, str]] = []
    second = await store.repair_path_unsafe_asset_names(
        "scene", lambda old, new: moved.append((old, new))
    )
    assert second == {}
    assert moved == []


@pytest.mark.asyncio
async def test_repair_commits_each_row_before_moving_the_next(store, tmp_path):
    """One row of "move directory + rename + re-attach derived scenes" is one transaction and must not be accumulated for a single commit at the end.

    The directory is moved first and the DB written afterwards. If all rows were accumulated for one commit at the end, any row blowing up midway would leave
    the earlier "new name on disk, old name in the DB" rows on disk as a batch -- exactly the inconsistency self-healing wants to avoid.
    """
    project_dir = tmp_path / "user" / "project"
    _insert_dirty(project_dir, "scenes", "Home Living Room/Brother Bedroom")
    _insert_dirty(project_dir, "scenes", "Derived", base_scene_id="Home Living Room/Brother Bedroom")
    _insert_dirty(project_dir, "scenes", "Kitchen/Storage Room")

    def move(old: str, new: str) -> None:
        if old == "Kitchen/Storage Room":
            raise RuntimeError("disk full")

    with pytest.raises(RuntimeError):
        await store.repair_path_unsafe_asset_names("scene", move)

    conn = sqlite3.connect(project_dir / "data.db")
    try:
        rows = dict(
            conn.execute("SELECT name, base_scene_id FROM scenes").fetchall()
        )
    finally:
        conn.close()
    # The row before the blow-up is already persisted, so disk and DB agree.
    assert "Home Living Room_Brother Bedroom" in rows
    assert rows["Derived"] == "Home Living Room_Brother Bedroom"
    # The row that blew up is left as it was, and the next self-healing run will redo it.
    assert "Kitchen/Storage Room" in rows


# ── dot-segment: `.` / `..` also change the path structure ────────────────


@pytest.mark.parametrize("raw", [".", "..", "..."])
def test_dot_only_names_are_not_path_safe(raw):
    """``assets/scenes/..`` is the assets root itself and, like a slash, can escape the asset directory."""
    assert not is_path_safe_asset_name(raw)
    assert not is_path_safe_asset_name(raw, kind="character")


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(".", "_"), ("..", "__"), ("../..", ".._.."), ("..\\..", ".._..")],
)
def test_dot_only_names_are_sanitized(raw, expected):
    assert path_safe_asset_name(raw) == expected


def test_dots_inside_a_real_name_are_kept():
    """Only a name made entirely of dots is dangerous; ``Living Room 1.5`` is a legitimate name and must not be touched."""
    assert path_safe_asset_name("Living Room 1.5") == "Living Room 1.5"
    assert is_path_safe_asset_name("Living Room 1.5")


# ── directory migration must stay inside the asset root ────────────────────────────


def test_asset_dir_within_rejects_traversal(tmp_path):
    from novelvideo.utils.asset_names import asset_dir_within

    root = tmp_path / "assets" / "scenes"
    root.mkdir(parents=True)
    assert asset_dir_within(root, "Living Room") == root / "Living Room"
    assert asset_dir_within(root, "../../config.json") is None
    assert asset_dir_within(root, "..") is None
    assert asset_dir_within(root, "") is None


@pytest.mark.asyncio
async def test_repair_never_touches_files_outside_the_asset_root(store, tmp_path):
    """Legacy dirty values are joined straight into the source path: ``../../config.json`` must not let the migration touch anything outside the asset root."""
    from novelvideo.api.routes.scenes import _heal_path_unsafe_scene_names

    project_dir = tmp_path / "user" / "project"
    outsider = project_dir / "config.json"
    outsider.write_text("{}", encoding="utf-8")
    (project_dir / "assets" / "scenes").mkdir(parents=True)
    _insert_dirty(project_dir, "scenes", "../../config.json")

    await _heal_path_unsafe_scene_names(store, project_dir)

    # Files outside the asset root are left untouched.
    assert outsider.exists()
    # The record itself still has to be healed, otherwise its {name} endpoints stay 404 forever.
    assert _db_names(project_dir, "scenes") == [".._.._config.json"]


# ── concurrency: the store is created per request ──────────────────────────────


@pytest.mark.asyncio
async def test_repair_guard_survives_a_new_store_instance(tmp_path):
    """The "run once" of self-healing must be recorded on the process; recording it on the store instance is as good as not recording it.

    ``make_sqlite_store`` in ``api/deps.py`` creates a new store instance per request, so an instance-level
    lock and done set cannot stop anyone: two concurrent list requests each take their own lock and both enter the migration; one moves
    the directory, and the other's ``shutil.move`` raises and is swallowed by ``except (OSError, ValueError)``, so that row
    is stuck in the "renamed on disk, still the old name in the DB" inconsistency. Incidentally, instance level also means every request does
    a full-table scan.

    Here two independent stores test the same invariant serially -- the race itself is timing dependent and cannot be tested reliably.
    """
    from novelvideo.sqlite_store import reset_path_repair_state

    reset_path_repair_state()
    project_dir = tmp_path / "user" / "project"
    project_dir.mkdir(parents=True)

    def open_store() -> SQLiteStore:
        return SQLiteStore(
            "user/project", output_dir=str(project_dir), state_dir=str(project_dir)
        )

    first = open_store()
    await first._ensure_db()
    try:
        _insert_dirty(project_dir, "scenes", "Home Living Room/Brother Bedroom")
        assert await first.repair_path_unsafe_asset_names("scene") == {
            "Home Living Room/Brother Bedroom": "Home Living Room_Brother Bedroom"
        }
    finally:
        await first.close()

    _insert_dirty(project_dir, "scenes", "Kitchen/Storage Room")
    moved: list[tuple[str, str]] = []
    second = open_store()
    await second._ensure_db()
    try:
        assert (
            await second.repair_path_unsafe_asset_names(
                "scene", lambda old, new: moved.append((old, new))
            )
            == {}
        )
    finally:
        await second.close()

    assert moved == []
    reset_path_repair_state()


@pytest.mark.asyncio
async def test_repair_guard_is_scoped_per_project(tmp_path):
    """One process serves many projects; having run for project A must not mark project B as done too."""
    from novelvideo.sqlite_store import reset_path_repair_state

    reset_path_repair_state()
    stores = []
    try:
        for name in ("alpha", "beta"):
            project_dir = tmp_path / "user" / name
            project_dir.mkdir(parents=True)
            store = SQLiteStore(
                f"user/{name}", output_dir=str(project_dir), state_dir=str(project_dir)
            )
            await store._ensure_db()
            stores.append((project_dir, store))
            _insert_dirty(project_dir, "scenes", "Home Living Room/Brother Bedroom")

        for project_dir, store in stores:
            assert await store.repair_path_unsafe_asset_names("scene") == {
                "Home Living Room/Brother Bedroom": "Home Living Room_Brother Bedroom"
            }
            assert _db_names(project_dir, "scenes") == ["Home Living Room_Brother Bedroom"]
    finally:
        for _project_dir, store in stores:
            await store.close()
        reset_path_repair_state()


# ── read-only collaborators must not trigger a migration ──────────────────────────────────


@pytest.mark.parametrize(
    ("role", "expected"),
    [("viewer", False), ("editor", True), ("admin", True), ("owner", True)],
)
def test_only_write_roles_may_run_asset_repair(role, expected):
    """Self-healing is a write operation (move directories + change primary keys + refresh updated_at) and must not hang off a read-only identity.

    All three list endpoints are ``required_role="viewer"``, so a read-only collaborator opening the asset page once would migrate the whole
    project. Receiving editor and above: read-only people still see the original (they could not delete or generate
    images anyway), and the first person with write permission to open the asset page heals everything.
    """
    from types import SimpleNamespace

    from novelvideo.api.deps import may_run_asset_repair

    assert may_run_asset_repair(SimpleNamespace(effective_role=role)) is expected


def test_asset_repair_allowed_without_project_context():
    """The single-machine / CE path has no ctx and therefore no collaborator concept, so it is treated as having write permission."""
    from novelvideo.api.deps import may_run_asset_repair

    assert may_run_asset_repair(None) is True
