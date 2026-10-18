from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo.models import CharacterIdentity, NovelCharacter

pytestmark = pytest.mark.m04


class _CharacterStore:
    def __init__(self, characters: list[NovelCharacter] | None = None):
        self.characters = {character.name: character for character in characters or []}
        # Behind a real SQLiteStore is an aiosqlite connection plus a background thread, and a route that forgets to close leaks one.
        # Bookkeeping happens here, so the cases below can assert that "the route really closed it" rather than only asserting the status code.
        self.close_calls = 0
        self.load_graph_state_flags: list[bool] = []

    def get_all_characters(self):
        return list(self.characters.values())

    async def list_characters(self):
        return list(self.characters.values())

    def get_character(self, name: str):
        return self.characters.get(name)

    async def add_character(self, character: NovelCharacter):
        self.characters[character.name] = character

    async def update_character(self, name: str, **updates):
        character = self.characters[name]
        for key, value in updates.items():
            setattr(character, key, value)

    async def rename_character(self, old_name: str, new_name: str):
        character = self.characters.pop(old_name)
        character.name = new_name
        for identity in character.identities:
            identity.character_name = new_name
            identity.identity_id = f"{new_name}_{identity.identity_name}"
        self.characters[new_name] = character

    async def delete_character(self, name: str):
        self.characters.pop(name, None)

    async def repair_path_unsafe_asset_names(self, kind: str, move_assets=None):
        # All names here are clean, so the legacy self-healing on the list endpoint is a no-op.
        return {}

    async def close(self):
        self.close_calls += 1


def _client(monkeypatch, tmp_path, store: _CharacterStore):
    from novelvideo.api import deps
    from novelvideo.api.routes import characters

    project_dir = tmp_path / "output" / "admin" / "demo"
    project_dir.mkdir(parents=True)
    ctx = SimpleNamespace(project_id="proj_demo", output_dir=project_dir, is_home_node=True)

    # Patch at the resolution layer rather than ``_resolve_character_project``: the latter is only the bare version, and the read paths
    # go through ``_character_project_scope``. With the fake placed at this layer, the
    # ``async with`` / ``try/finally`` on both paths are real code running, and ``store.close()`` is what production
    # code calls, so the ``close_calls`` assertions in the cases are meaningful.
    async def fake_resolve_project_scope(project: str, user: dict, *, required_role: str = "viewer"):
        return SimpleNamespace(
            ctx=ctx,
            username="admin",
            project_name="demo",
            project_dir=project_dir,
            output_dir=str(project_dir),
            state_dir=str(project_dir),
            runtime_dir=str(project_dir),
        )

    async def fake_make_store_for_context(_ctx, *, load_graph_state: bool = True):
        store.load_graph_state_flags.append(load_graph_state)
        return store

    monkeypatch.setattr(characters, "resolve_project_scope", fake_resolve_project_scope)
    # Both places must be patched. The bare ``_resolve_character_project`` uses the name imported
    # into ``characters``; the ``sqlite_store_for_context_scope`` in the scope resolves the factory
    # via module globals on ``deps``, so patching only the route module patches nothing -- this round fixed exactly that pitfall.
    monkeypatch.setattr(characters, "make_sqlite_store_for_context", fake_make_store_for_context)
    monkeypatch.setattr(deps, "make_sqlite_store_for_context", fake_make_store_for_context)
    monkeypatch.setattr(
        characters,
        "make_static_url_for_context",
        lambda ctx, rel, local_path=None: f"/static/projects/{ctx.project_id}/{rel}",
    )

    app = FastAPI()
    app.include_router(characters.router)
    app.dependency_overrides[characters.get_api_user] = lambda: {"username": "admin"}
    return TestClient(app)


def test_create_character_accepts_react_extra_payload(monkeypatch, tmp_path):
    store = _CharacterStore()
    client = _client(monkeypatch, tmp_path, store)

    response = client.post(
        "/projects/demo/characters",
        json={
            "name": "QinZhao",
            "role": "protagonist",
            "is_main": True,
            "gender": "male",
            "age_group": "middle",
            "description": "A calm detective",
            "face_prompt": "sharp eyes, stern face",
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "data": {
            "name": "QinZhao",
            "role": "protagonist",
            "is_main": True,
            "gender": "male",
            "age_group": "middle",
            "description": "A calm detective",
            "face_prompt": "sharp eyes, stern face",
        },
    }
    saved = store.get_character("QinZhao")
    assert saved is not None
    assert saved.is_main is True
    assert saved.gender == "male"
    assert saved.age_group == "middle"
    assert saved.description == "A calm detective"
    assert saved.face_prompt == "sharp eyes, stern face"


def test_create_main_character_unsets_previous_main(monkeypatch, tmp_path):
    store = _CharacterStore(
        [
            NovelCharacter(name="OldLead", role="protagonist", is_main=True),
            NovelCharacter(name="Extra", role="supporting", is_main=False),
        ]
    )
    client = _client(monkeypatch, tmp_path, store)

    response = client.post(
        "/projects/demo/characters",
        json={"name": "NewLead", "role": "protagonist", "is_main": True},
    )

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert store.get_character("OldLead").is_main is False
    assert store.get_character("NewLead").is_main is True


def test_update_main_character_unsets_previous_main(monkeypatch, tmp_path):
    store = _CharacterStore(
        [
            NovelCharacter(name="QinZhao", role="protagonist", is_main=True),
            NovelCharacter(name="ShenQing", role="supporting", is_main=False),
        ]
    )
    client = _client(monkeypatch, tmp_path, store)

    response = client.patch("/projects/demo/characters/ShenQing", json={"is_main": True})

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "data": {"name": "ShenQing", "updated_fields": ["is_main"]},
    }
    assert store.get_character("QinZhao").is_main is False
    assert store.get_character("ShenQing").is_main is True


def test_list_characters_repairs_duplicate_narrator_main(monkeypatch, tmp_path):
    store = _CharacterStore(
        [
            NovelCharacter(name="LuChen", role="protagonist", is_main=True),
            NovelCharacter(name="ShenYuebai", role="protagonist", is_main=True),
            NovelCharacter(name="ZhaoGuangnian", role="supporting", is_main=False),
        ]
    )
    client = _client(monkeypatch, tmp_path, store)

    response = client.get("/projects/demo/characters?summary=true")

    assert response.status_code == 200
    mains = [item["name"] for item in response.json()["data"] if item["is_main"]]
    assert mains == ["LuChen"]
    assert store.get_character("LuChen").is_main is True
    assert store.get_character("ShenYuebai").is_main is False


def test_list_characters_carries_identity_ids_for_deep_link_resolution(
    monkeypatch, tmp_path
):
    """The character list carries the identity ids under each character, and only ids.

    The asset page must resolve a ``?type=identity&id=`` deep link to the character owning it. Previously the frontend called
    ``/characters/{name}/identities`` for each character to build an id -> character-name table -- as many
    requests as there are characters, unconditionally on every page entry. The identity objects are already in memory with the characters, so carrying them out costs no
    extra query; what is carried is a list of ids, so the payload does not grow with identity images/descriptions.
    """
    lin = NovelCharacter(name="LinZhao", role="protagonist")
    lin.identities = [
        CharacterIdentity(
            identity_id="LinZhao_young_adult", character_name="LinZhao", identity_name="young_adult"
        ),
        CharacterIdentity(
            identity_id="LinZhao_teen", character_name="LinZhao", identity_name="teen"
        ),
    ]
    su = NovelCharacter(name="SuQingyan", role="protagonist")
    su.identities = [
        CharacterIdentity(
            identity_id="SuQingyan_teen", character_name="SuQingyan", identity_name="teen"
        )
    ]
    bare = NovelCharacter(name="Passerby", role="supporting")

    store = _CharacterStore([lin, su, bare])
    client = _client(monkeypatch, tmp_path, store)

    response = client.get("/projects/demo/characters")

    assert response.status_code == 200
    by_name = {item["name"]: item for item in response.json()["data"]}

    assert by_name["LinZhao"]["identity_ids"] == ["LinZhao_young_adult", "LinZhao_teen"]
    assert by_name["SuQingyan"]["identity_ids"] == ["SuQingyan_teen"]
    # A character without identities yields an empty list rather than a missing field, so the frontend need not distinguish "none" from "not carried".
    assert by_name["Passerby"]["identity_ids"] == []
    # Only ids. Identity details still go through the on-demand identities endpoint, so the list payload does not grow.
    identity_detail_keys = {"identity_name", "image_url", "appearance_details"}
    for item in by_name.values():
        assert identity_detail_keys.isdisjoint(item.keys())


def test_list_characters_summary_uses_convention_urls_without_filesystem_probes(
    monkeypatch, tmp_path
):
    from novelvideo.api.routes import characters

    store = _CharacterStore([NovelCharacter(name="LinZhao", role="protagonist")])
    client = _client(monkeypatch, tmp_path, store)

    def fail_probe(*_args, **_kwargs):
        raise AssertionError("the character summary must not probe asset files")

    monkeypatch.setattr(characters, "compute_portrait_path", fail_probe)
    monkeypatch.setattr(characters, "tree_updated_at", fail_probe)
    monkeypatch.setattr(characters, "_asset_url", fail_probe)

    response = client.get("/projects/demo/characters?summary=true")

    assert response.status_code == 200
    asset = response.json()["data"][0]
    assert asset["portrait_url"].endswith(
        "/assets/characters/LinZhao/portrait.png"
    ) or asset["portrait_url"].endswith("/assets/characters/LinZhao/portrait.png")
    assert store.load_graph_state_flags == [False]


def test_character_details_probe_only_the_requested_character(monkeypatch, tmp_path):
    store = _CharacterStore(
        [NovelCharacter(name="LinZhao"), NovelCharacter(name="SuQingyan")]
    )
    client = _client(monkeypatch, tmp_path, store)
    project_dir = tmp_path / "output" / "admin" / "demo"
    portrait = project_dir / "assets" / "characters" / "SuQingyan" / "portrait.png"
    portrait.parent.mkdir(parents=True)
    portrait.write_bytes(b"portrait")

    response = client.get(
        "/projects/demo/characters",
        params={"summary": "false", "names": "SuQingyan"},
    )

    assert response.status_code == 200
    assert [item["name"] for item in response.json()["data"]] == ["SuQingyan"]
    assert response.json()["data"][0]["portrait_url"]
    assert store.load_graph_state_flags == [False]


def test_character_and_identity_lists_expose_asset_history_links(monkeypatch, tmp_path):
    character = NovelCharacter(name="LinZhao", role="protagonist")
    character.identities = [
        CharacterIdentity(
            identity_id="LinZhao_young_adult",
            character_name="LinZhao",
            identity_name="young_adult",
        )
    ]
    store = _CharacterStore([character])
    client = _client(monkeypatch, tmp_path, store)

    characters_response = client.get("/projects/demo/characters")
    identities_response = client.get("/projects/demo/characters/LinZhao/identities")

    assert characters_response.status_code == 200
    char_item = characters_response.json()["data"][0]
    assert char_item["history_url"] == (
        "/api/v1/projects/proj_demo/characters/LinZhao/asset-history?kind=portrait"
    )
    assert char_item["restore_url"] == (
        "/api/v1/projects/proj_demo/characters/LinZhao/asset-history/restore"
    )

    assert identities_response.status_code == 200
    identity_item = identities_response.json()["data"][0]
    assert identity_item["history_url"] == (
        "/api/v1/projects/proj_demo/characters/LinZhao/"
        "asset-history?kind=identity&identity_id=LinZhao_young_adult"
    )
    assert identity_item["restore_url"] == (
        "/api/v1/projects/proj_demo/characters/LinZhao/asset-history/restore"
    )


def test_update_character_can_rename_like_nicegui(monkeypatch, tmp_path):
    store = _CharacterStore([NovelCharacter(name="QinZhao", role="protagonist")])
    client = _client(monkeypatch, tmp_path, store)

    response = client.patch(
        "/projects/demo/characters/QinZhao",
        json={"name": "QinZhao2", "face_prompt": "calm eyes"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "data": {
            "name": "QinZhao2",
            "updated_fields": ["name", "face_prompt"],
            "renamed_from": "QinZhao",
        },
    }
    assert store.get_character("QinZhao") is None
    renamed = store.get_character("QinZhao2")
    assert renamed is not None
    assert renamed.face_prompt == "calm eyes"


def test_delete_character_route_removes_character(monkeypatch, tmp_path):
    store = _CharacterStore([NovelCharacter(name="QinZhao", role="protagonist")])
    client = _client(monkeypatch, tmp_path, store)

    response = client.post("/projects/demo/characters/QinZhao/delete")

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "data": {"name": "QinZhao", "deleted": True},
    }
    assert store.get_character("QinZhao") is None


# The two actual read paths of the character page: entering the page fetches the character list, selecting a character fetches identities. They used to get
# the bare store returned by ``_resolve_character_project()``; on normal return, on the early return for "character does not exist",
# and on a mid-way error, nobody called ``close()`` -- every request left behind an aiosqlite connection plus a background thread,
# and relying on GC is neither timely nor guaranteed. Below, one case pins each of the three paths.
def test_list_characters_closes_the_store_on_the_normal_path(monkeypatch, tmp_path):
    store = _CharacterStore([NovelCharacter(name="QinZhao", role="protagonist")])
    client = _client(monkeypatch, tmp_path, store)

    response = client.get("/projects/demo/characters")

    assert response.status_code == 200
    assert store.close_calls == 1


def test_identities_closes_the_store_on_the_normal_path(monkeypatch, tmp_path):
    store = _CharacterStore(
        [
            NovelCharacter(
                name="QinZhao",
                role="protagonist",
                identities=[
                    CharacterIdentity(
                        character_name="QinZhao",
                        identity_name="young_adult",
                        identity_id="QinZhao_young_adult",
                    )
                ],
            )
        ]
    )
    client = _client(monkeypatch, tmp_path, store)

    response = client.get("/projects/demo/characters/QinZhao/identities")

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert store.close_calls == 1


def test_identities_closes_the_store_before_the_character_not_found_return(
    monkeypatch, tmp_path
):
    """The early-return path is the easiest to miss: the function ``return``s midway and the closing code below is never reached."""
    store = _CharacterStore([NovelCharacter(name="QinZhao", role="protagonist")])
    client = _client(monkeypatch, tmp_path, store)

    response = client.get("/projects/demo/characters/Nobody/identities")

    assert response.status_code == 200
    assert response.json()["ok"] is False
    assert store.close_calls == 1


def test_list_characters_closes_the_store_when_the_handler_raises(monkeypatch, tmp_path):
    """Error path: the database read blew up, and the connection must be closed all the more -- this is exactly the path where a retry storm piles up connection counts."""
    store = _CharacterStore([NovelCharacter(name="QinZhao", role="protagonist")])

    async def boom():
        raise RuntimeError("store read blew up")

    monkeypatch.setattr(store, "list_characters", boom)
    client = _client(monkeypatch, tmp_path, store)

    with pytest.raises(RuntimeError, match="store read blew up"):
        client.get("/projects/demo/characters")

    assert store.close_calls == 1


def test_identities_closes_the_store_when_the_handler_raises(monkeypatch, tmp_path):
    store = _CharacterStore([NovelCharacter(name="QinZhao", role="protagonist")])

    async def boom():
        raise RuntimeError("store read blew up")

    monkeypatch.setattr(store, "list_characters", boom)
    client = _client(monkeypatch, tmp_path, store)

    with pytest.raises(RuntimeError, match="store read blew up"):
        client.get("/projects/demo/characters/QinZhao/identities")

    assert store.close_calls == 1
