from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.api.schemas import EpisodeUpdate
from novelvideo.models import CharacterIdentity, NovelCharacter, NovelEpisode, NovelProp

pytestmark = pytest.mark.m03


def test_episode_plan_route_precedes_episode_detail_route():
    from novelvideo.api.routes.episodes import router

    paths = [route.path for route in router.routes]

    assert paths.index("/projects/{project}/episodes/plan") < paths.index(
        "/projects/{project}/episodes/{episode_num}"
    )


def test_episode_asset_task_scope_is_stable_per_episode_and_kind():
    from novelvideo.api.routes.episodes import _episode_asset_task_scope

    assert _episode_asset_task_scope("prop", 4) == "prop_run_ep004"
    assert _episode_asset_task_scope("prop", 4) == "prop_run_ep004"
    assert _episode_asset_task_scope("scene", 4) == "scene_run_ep004"
    assert _episode_asset_task_scope("prop", 5) == "prop_run_ep005"


class _EpisodeStore:
    def __init__(
        self,
        episode: NovelEpisode,
        beat_counts: dict[int, int] | None = None,
        count_error: Exception | None = None,
    ):
        self.episode = episode
        self.updates: list[tuple[int, dict]] = []
        self.beat_counts = beat_counts or {}
        self.count_calls = 0
        self.count_error = count_error
        # Behind a real SQLiteStore is an aiosqlite connection plus a background thread, and a route that forgets to close leaks one.
        # Bookkeeping happens here, so the cases below can assert that "the route really closed it" rather than only asserting the status code.
        self.close_calls = 0

    async def count_beats_by_episode(self):
        self.count_calls += 1
        if self.count_error is not None:
            raise self.count_error
        return dict(self.beat_counts)

    async def close(self):
        self.close_calls += 1

    def get_episode(self, number: int):
        if number == self.episode.number:
            return self.episode
        return None

    def get_all_episodes(self):
        return [self.episode]

    async def update_episode(self, episode_number: int, **updates):
        self.updates.append((episode_number, updates))
        for key, value in updates.items():
            if key == "identity_default_map":
                self.episode.identity_default_map = value
            elif hasattr(self.episode, key):
                setattr(self.episode, key, value)
        return None

    async def patch_episode(self, episode_number: int, **updates):
        self.updates.append((episode_number, updates))
        for key, value in updates.items():
            if key == "identity_default_map":
                self.episode.identity_default_map = value
            elif hasattr(self.episode, key):
                setattr(self.episode, key, value)
        return None


class _CogneeEpisodeStore:
    def __init__(self, episode: NovelEpisode):
        self.episode = episode
        self.loaded = False
        self.sqlite_store = _PropRecordingStore()

    async def load_graph_state(self):
        self.loaded = True

    def get_all_episodes(self):
        return [self.episode]

    def get_all_characters(self):
        character = NovelCharacter(name="Qin")
        character.identities = [
            CharacterIdentity(
                character_name="Qin",
                identity_id="Qin_young_adult",
                identity_name="young_adult",
                appearance_details="blue robe",
            )
        ]
        return [character]

    def get_cached_prop(self, name: str):
        return self.sqlite_store.cached_props.get(name)


class _PropRecordingStore:
    def __init__(self):
        self.cached_props: dict[str, NovelProp] = {}
        self.added_props: list[NovelProp] = []

    async def list_props(self):
        return list(self.cached_props.values())

    async def add_prop(self, prop: NovelProp):
        self.cached_props[prop.name] = prop
        self.added_props.append(prop)


class _FakeAssetCompiler:
    def __init__(self, store: _CogneeEpisodeStore):
        self.store = store

    async def compile_episode_scenes(self, episode, on_log=None):
        if on_log:
            on_log("planned scenes")
        scene_menu = [{"scene_id": "PalaceGate"}]
        self.store.episode.scene_menu = scene_menu
        return self.store.episode.scene_menu, 1

    async def compile_episode_props(self, episode, on_log=None):
        if on_log:
            on_log("planned props")
        prop_menu = [{"prop_id": "JadePendant", "prop_type": "object"}]
        self.store.episode.prop_menu = prop_menu
        return self.store.episode.prop_menu


class _FakeIdentityPlanner:
    def __init__(self, store: _CogneeEpisodeStore):
        self.store = store

    async def plan_single_episode(self, episode, on_log=None):
        if on_log:
            on_log("planned identity")
        self.store.episode.identity_ids = ["Qin_young_adult"]
        self.store.episode.character_names = ["Qin"]
        self.store.episode.identity_default_map = {"Qin": "Qin_young_adult"}
        return 0, 1


def _patch_project_and_store(
    monkeypatch: pytest.MonkeyPatch,
    module,
    project_dir: Path,
    store: _EpisodeStore,
) -> None:
    from novelvideo.api import deps

    async def resolve_project_scope(project: str, user: dict, required_role: str = "viewer"):
        return SimpleNamespace(
            ctx=None,
            username=user.get("username", "admin"),
            project_name=project,
            project_dir=project_dir,
            output_dir=str(project_dir),
            state_dir=str(project_dir),
            runtime_dir=str(project_dir),
        )

    async def make_store(username: str, project: str):
        return store

    monkeypatch.setattr(module, "resolve_project_scope", resolve_project_scope)
    monkeypatch.setattr(module, "make_sqlite_store", make_store)
    # The scoped route (``list_episodes``) gets ``deps.sqlite_store_scope`` -- which is
    # wrapped by ``asynccontextmanager`` at import time and looks up ``make_sqlite_store`` through module globals internally.
    # Patching only the name in the route module lets the scope bypass the fake and open the real database. Patch both, so the scope's
    # ``try/finally`` is still real code running and the ``close_calls`` assertions count.
    monkeypatch.setattr(deps, "make_sqlite_store", make_store)


def _patch_project_and_cognee_store(
    monkeypatch: pytest.MonkeyPatch,
    module,
    project_dir: Path,
    store: _CogneeEpisodeStore,
) -> None:
    async def resolve_project_scope(project: str, user: dict, required_role: str = "viewer"):
        return SimpleNamespace(
            ctx=None,
            username=user.get("username", "admin"),
            project_name=project,
            project_dir=project_dir,
            output_dir=str(project_dir),
            state_dir=str(project_dir),
            runtime_dir=str(project_dir),
        )

    async def make_store(username: str, project: str):
        return store

    monkeypatch.setattr(module, "resolve_project_scope", resolve_project_scope)
    monkeypatch.setattr(module, "make_cognee_store", make_store)
    monkeypatch.setattr(module, "AssetCompiler", _FakeAssetCompiler, raising=False)


def _patch_celery_episode_asset_planner(
    monkeypatch: pytest.MonkeyPatch,
    module,
):
    ctx = SimpleNamespace(project_id="proj_123")
    calls: list[dict] = []

    async def resolve_project_scope(project: str, user: dict, required_role: str = "viewer"):
        return SimpleNamespace(
            ctx=ctx,
            username="admin",
            project_name="demo",
            project_dir=Path("/tmp/demo"),
            output_dir="/tmp/demo/output",
            state_dir="/tmp/demo/state",
            runtime_dir="/tmp/demo/runtime",
        )

    async def enqueue_project_task(ctx_arg, **kwargs):
        calls.append({"ctx": ctx_arg, **kwargs})
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task-123"),
            backend="celery",
            queue="node.node_a.default",
        )

    async def fail_if_sync_store_is_used(*args, **kwargs):
        raise AssertionError("episode asset planning must enqueue a Celery task")
    monkeypatch.setattr(module, "resolve_project_scope", resolve_project_scope)
    monkeypatch.setattr(module, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=enqueue_project_task))
    monkeypatch.setattr(
        module,
        "get_task_manager",
        lambda: SimpleNamespace(get_task_for_project=lambda *_args, **_kwargs: None),
    )
    monkeypatch.setattr(module, "make_cognee_store_for_context", fail_if_sync_store_is_used)
    monkeypatch.setattr(
        module,
        "_episode_asset_task_scope",
        lambda kind, episode_num: f"{kind}_run_test",
    )
    return calls


@pytest.mark.asyncio
async def test_get_episode_detail_returns_nicegui_fields(tmp_path, monkeypatch):
    from novelvideo.api.routes import episodes

    episode = NovelEpisode(
        number=1,
        title="Episode One",
        raw_content="raw text",
        beat_source_text="beat source text",
        content_summary="summary",
        character_names=["Qin"],
        key_events=["Enter palace"],
        cliffhanger="cliffhanger",
        identity_ids=["Qin_child"],
        identity_default_map={"Qin": "Qin_child"},
        scene_menu=[{"scene_id": "PalaceGate", "scene_name": "PalaceGate"}],
        prop_menu=[{"prop_id": "JadePendant", "prop_name": "JadePendant"}],
    )
    _patch_project_and_store(
        monkeypatch,
        episodes,
        tmp_path,
        _EpisodeStore(episode),
    )

    response = await episodes.get_episode_detail(
        project="demo",
        episode_num=1,
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert response["data"] == {
        "number": 1,
        "title": "Episode One",
        "summary": "summary",
        "raw_content": "raw text",
        "beat_source_text": "beat source text",
        "content_summary": "summary",
        "character_names": ["Qin"],
        "key_events": ["Enter palace"],
        "cliffhanger": "cliffhanger",
        "identity_ids": ["Qin_child"],
        "identity_default_map": {"Qin": "Qin_child"},
        "scene_menu": [
            {
                "scene_id": "PalaceGate",
                "base_scene_id": "",
                "variant_id": "",
                "time_of_day": "",
            }
        ],
        "prop_menu": [
            {
                "prop_id": "JadePendant",
                "prop_type": "object",
                "visual_prompt": "",
                "description": "",
                "owner_identity_id": "",
                "marker_color": "",
            }
        ],
    }


@pytest.mark.asyncio
async def test_list_episodes_returns_fields_needed_by_react_workbench(tmp_path, monkeypatch):
    from novelvideo.api.routes import episodes

    episode = NovelEpisode(
        number=1,
        title="Episode One",
        content_summary="summary",
        identity_ids=["Qin_child", "Zhao_young_adult"],
        key_events=["Enter palace", "Confrontation"],
        scene_menu=[{"scene_id": "PalaceGate"}],
        prop_menu=[{"prop_id": "JadePendant", "prop_type": "object"}],
    )
    _patch_project_and_store(
        monkeypatch,
        episodes,
        tmp_path,
        _EpisodeStore(episode),
    )

    response = await episodes.list_episodes(
        project="demo",
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert response["data"] == [
        {
            "number": 1,
            "title": "Episode One",
            "summary": "summary",
            "identity_ids": ["Qin_child", "Zhao_young_adult"],
            "key_events": ["Enter palace", "Confrontation"],
            "scene_menu": [
                {
                    "scene_id": "PalaceGate",
                    "base_scene_id": "",
                    "variant_id": "",
                    "time_of_day": "",
                }
            ],
            "prop_menu": [
                {
                    "prop_id": "JadePendant",
                    "prop_type": "object",
                    "visual_prompt": "",
                    "description": "",
                    "owner_identity_id": "",
                    "marker_color": "",
                }
            ],
            "beat_count": 0,
        }
    ]


@pytest.mark.asyncio
async def test_list_episodes_carries_beat_count_from_one_grouped_query(tmp_path, monkeypatch):
    """The episode list carries the shot count itself, so the frontend need not pull the full beats of each episode to take the length.

    This was the root cause of the episode page fan-out: for as many episodes as the list had, the frontend sent as many
    ``GET /episodes/{n}/beats`` requests, each resolving the project context, opening the database, assembling
    sketch/frame/video URLs for every beat and forking ffprobe once per audio -- just to get one integer.
    """
    from novelvideo.api.routes import episodes

    episode = NovelEpisode(number=1, title="Episode One")
    store = _EpisodeStore(episode, beat_counts={1: 7})
    _patch_project_and_store(monkeypatch, episodes, tmp_path, store)

    response = await episodes.list_episodes(project="demo", user={"username": "admin"})

    assert response["data"][0]["beat_count"] == 7
    # One grouped query covers the whole list, not one per episode.
    assert store.count_calls == 1


@pytest.mark.asyncio
async def test_list_episodes_reports_zero_for_unsplit_episode(tmp_path, monkeypatch):
    """An episode not yet split into shots must report 0 rather than a missing field -- the badge reads undefined and does not render."""
    from novelvideo.api.routes import episodes

    episode = NovelEpisode(number=2, title="Episode Two")
    store = _EpisodeStore(episode, beat_counts={1: 7})
    _patch_project_and_store(monkeypatch, episodes, tmp_path, store)

    response = await episodes.list_episodes(project="demo", user={"username": "admin"})

    assert response["data"][0]["beat_count"] == 0


@pytest.mark.asyncio
async def test_list_episodes_closes_the_store_on_the_normal_path(tmp_path, monkeypatch):
    """The episode list is a mandatory hop into the shot view, and the cost of a leaked connection accumulates per visit.

    What is asserted here is that ``close()`` was called once, not the status code -- the bare factory version returns the same status code
    200, it just leaves behind an aiosqlite connection and a background thread each time.
    """
    from novelvideo.api.routes import episodes

    episode = NovelEpisode(number=1, title="Episode One")
    store = _EpisodeStore(episode, beat_counts={1: 7})
    _patch_project_and_store(monkeypatch, episodes, tmp_path, store)

    response = await episodes.list_episodes(project="demo", user={"username": "admin"})

    assert response["ok"] is True
    assert store.close_calls == 1


@pytest.mark.asyncio
async def test_list_episodes_closes_the_store_when_the_query_raises(tmp_path, monkeypatch):
    """The error path is where the bare factory hurts most: it leaks even on errors.

    ``count_beats_by_episode`` is the query newly added in this PR and the step in this route most likely to
    raise (database lock, schema not migrated). When it raises, the connection must still be closed.
    """
    from novelvideo.api.routes import episodes

    episode = NovelEpisode(number=1, title="Episode One")
    boom = RuntimeError("database is locked")
    store = _EpisodeStore(episode, count_error=boom)
    _patch_project_and_store(monkeypatch, episodes, tmp_path, store)

    with pytest.raises(RuntimeError, match="database is locked"):
        await episodes.list_episodes(project="demo", user={"username": "admin"})

    assert store.close_calls == 1


@pytest.mark.asyncio
async def test_list_episodes_closes_the_store_on_the_context_branch(tmp_path, monkeypatch):
    """When ``resolved.ctx`` is non-empty a different scope is used; do not cover only the CE half."""
    from novelvideo.api import deps
    from novelvideo.api.routes import episodes

    episode = NovelEpisode(number=1, title="Episode One")
    store = _EpisodeStore(episode, beat_counts={1: 3})
    ctx = SimpleNamespace(project_id="proj_demo", output_dir=tmp_path, is_home_node=True)

    async def resolve_project_scope(project: str, user: dict, required_role: str = "viewer"):
        return SimpleNamespace(
            ctx=ctx,
            username="admin",
            project_name=project,
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path),
            runtime_dir=str(tmp_path),
        )

    async def make_store_for_context(_ctx, *, load_graph_state: bool = True):
        return store

    monkeypatch.setattr(episodes, "resolve_project_scope", resolve_project_scope)
    monkeypatch.setattr(deps, "make_sqlite_store_for_context", make_store_for_context)

    response = await episodes.list_episodes(project="demo", user={"username": "admin"})

    assert response["data"][0]["beat_count"] == 3
    assert store.close_calls == 1


@pytest.mark.asyncio
async def test_patch_episode_source_fields_persists_and_returns_detail(tmp_path, monkeypatch):
    from novelvideo.api.routes import episodes

    episode = NovelEpisode(number=1, title="Episode One")
    store = _EpisodeStore(episode)
    _patch_project_and_store(monkeypatch, episodes, tmp_path, store)

    response = await episodes.update_episode(
        project="demo",
        episode_num=1,
        body=EpisodeUpdate(
            beat_source_text="new beat source text",
            identity_default_map={"Qin": "Qin_young_adult"},
        ),
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert response["data"]["beat_source_text"] == "new beat source text"
    assert response["data"]["identity_default_map"] == {"Qin": "Qin_young_adult"}
    assert store.updates == [
        (
            1,
            {
                "beat_source_text": "new beat source text",
                "identity_default_map": {"Qin": "Qin_young_adult"},
            },
        )
    ]


@pytest.mark.asyncio
async def test_plan_episode_identities_enqueues_celery_task(monkeypatch):
    from novelvideo.api.routes import episodes

    ctx = SimpleNamespace(project_id="proj_123")
    calls: list[dict] = []

    async def resolve_project_scope(project: str, user: dict, required_role: str = "viewer"):
        return SimpleNamespace(
            ctx=ctx,
            username="admin",
            project_name="demo",
            project_dir=Path("/tmp/demo"),
            output_dir="/tmp/demo/output",
            state_dir="/tmp/demo/state",
            runtime_dir="/tmp/demo/runtime",
        )

    async def enqueue_project_task(ctx_arg, **kwargs):
        calls.append({"ctx": ctx_arg, **kwargs})
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task-identity"),
            backend="celery",
            queue="node.node_a.default",
        )

    async def fail_if_sync_store_is_used(*args, **kwargs):
        raise AssertionError("identity planning API must enqueue a Celery task")
    class ReadyCharacterStore:
        def get_all_characters(self):
            return [SimpleNamespace(name="Qin")]

        async def close(self):
            pass

    class IdleTaskManager:
        def get_task_for_project(self, *_args, **_kwargs):
            return None

    monkeypatch.setattr(episodes, "resolve_project_scope", resolve_project_scope)
    monkeypatch.setattr(episodes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=enqueue_project_task))
    monkeypatch.setattr(episodes, "make_cognee_store", fail_if_sync_store_is_used)
    monkeypatch.setattr(
        episodes,
        "make_sqlite_store_for_context",
        lambda _ctx: _async_value(ReadyCharacterStore()),
    )
    monkeypatch.setattr(episodes, "get_task_manager", IdleTaskManager)

    response = await episodes.plan_episode_identities(
        project="proj_123",
        episode_num=1,
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert response["task_type"] == "identity_planner"
    assert response["task_id"] == "task-identity"
    assert response["task_key"] == "task:identity_planner:project:proj_123:1"
    assert response["backend"] == "celery"
    assert response["queue"] == "node.node_a.default"
    assert response["data"] == {"target_episode": 1}
    assert calls == [
        {
            "ctx": ctx,
            "product_surface": "mainline",
            "task_type": "identity_planner",
            "queue_kind": "default",
            "episode": 1,
            "payload": {"episode": 1},
        }
    ]


async def _async_value(value):
    return value


@pytest.mark.asyncio
async def test_plan_episode_identities_rejects_empty_character_library_before_enqueue(
    monkeypatch,
):
    from novelvideo.api.routes import episodes
    from novelvideo.identity_prerequisites import (
        IDENTITY_CHARACTERS_REQUIRED_CODE,
        IDENTITY_CHARACTERS_REQUIRED_MESSAGE,
    )

    ctx = SimpleNamespace(project_id="proj_123")

    async def resolve_project_scope(
        project: str, user: dict, required_role: str = "viewer"
    ):
        return SimpleNamespace(ctx=ctx)

    class EmptyCharacterStore:
        def get_all_characters(self):
            return []

        async def close(self):
            pass

    class IdleTaskManager:
        def get_task_for_project(self, *_args, **_kwargs):
            return None

    async def reject_enqueue(*_args, **_kwargs):
        raise AssertionError("identity planning must not enqueue without characters")

    monkeypatch.setattr(episodes, "resolve_project_scope", resolve_project_scope)
    monkeypatch.setattr(episodes, "get_task_manager", IdleTaskManager)
    monkeypatch.setattr(
        episodes,
        "make_sqlite_store_for_context",
        lambda _ctx: _async_value(EmptyCharacterStore()),
    )
    monkeypatch.setattr(
        episodes,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=reject_enqueue),
    )

    response = await episodes.plan_episode_identities(
        project="proj_123",
        episode_num=1,
        user={"username": "admin"},
    )

    assert response == {
        "ok": False,
        "code": IDENTITY_CHARACTERS_REQUIRED_CODE,
        "error": IDENTITY_CHARACTERS_REQUIRED_MESSAGE,
    }


@pytest.mark.asyncio
async def test_plan_episode_identities_rejects_active_character_build_before_enqueue(
    monkeypatch,
):
    from novelvideo.api.routes import episodes
    from novelvideo.identity_prerequisites import (
        IDENTITY_CHARACTERS_BUILDING_CODE,
        IDENTITY_CHARACTERS_BUILDING_MESSAGE,
    )

    ctx = SimpleNamespace(project_id="proj_123")

    async def resolve_project_scope(
        project: str, user: dict, required_role: str = "viewer"
    ):
        return SimpleNamespace(ctx=ctx)

    class BuildingTaskManager:
        def get_task_for_project(self, *_args, **_kwargs):
            return SimpleNamespace(status="running")

    async def reject_store_open(*_args, **_kwargs):
        raise AssertionError(
            "active character build must be rejected before reading characters"
        )

    async def reject_enqueue(*_args, **_kwargs):
        raise AssertionError(
            "identity planning must not enqueue during character build"
        )

    monkeypatch.setattr(episodes, "resolve_project_scope", resolve_project_scope)
    monkeypatch.setattr(episodes, "get_task_manager", BuildingTaskManager)
    monkeypatch.setattr(episodes, "make_sqlite_store_for_context", reject_store_open)
    monkeypatch.setattr(
        episodes,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=reject_enqueue),
    )

    response = await episodes.plan_episode_identities(
        project="proj_123",
        episode_num=1,
        user={"username": "admin"},
    )

    assert response == {
        "ok": False,
        "code": IDENTITY_CHARACTERS_BUILDING_CODE,
        "error": IDENTITY_CHARACTERS_BUILDING_MESSAGE,
    }


@pytest.mark.asyncio
async def test_plan_episode_scenes_returns_updated_episode_detail(tmp_path, monkeypatch):
    from novelvideo.api.routes import episodes

    episode = NovelEpisode(number=1, title="Episode One", beat_source_text="First line")
    store = _CogneeEpisodeStore(episode)
    _patch_project_and_cognee_store(monkeypatch, episodes, tmp_path, store)

    response = await episodes.plan_episode_scenes(
        project="demo",
        episode_num=1,
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert store.loaded is True
    assert response["data"]["kind"] == "scene"
    assert response["data"]["new_count"] == 1
    assert response["data"]["total_count"] == 1
    expected_menu_item = {
        "scene_id": "PalaceGate",
        "base_scene_id": "",
        "variant_id": "",
        "time_of_day": "",
    }
    assert response["data"]["scene_menu"] == [expected_menu_item]
    assert response["data"]["episode"]["scene_menu"] == [expected_menu_item]
    assert response["data"]["logs"] == ["planned scenes"]


@pytest.mark.asyncio
async def test_plan_episode_scenes_enqueues_celery_task(monkeypatch):
    from novelvideo.api.routes import episodes

    calls = _patch_celery_episode_asset_planner(monkeypatch, episodes)

    response = await episodes.plan_episode_scenes(
        project="proj_123",
        episode_num=4,
        user={"username": "admin"},
    )

    assert response == {
        "ok": True,
        "task_type": "episode_scene_planner",
        "scope": "scene_run_test",
        "task_id": "task-123",
        "task_key": "task:episode_scene_planner:project:proj_123:4:scene_run_test",
        "backend": "celery",
        "queue": "node.node_a.default",
        "data": {"target_episode": 4, "asset_kind": "scene"},
        "message": "Episode 4 scene planning queued",
    }
    assert calls == [
        {
            "ctx": calls[0]["ctx"],
            "product_surface": "mainline",
            "task_type": "episode_scene_planner",
            "queue_kind": "default",
            "episode": 4,
            "scope": "scene_run_test",
            "payload": {"episode": 4, "asset_kind": "scene"},
        }
    ]


@pytest.mark.asyncio
async def test_plan_episode_scenes_rejects_active_scene_build_before_enqueue(
    monkeypatch,
):
    from novelvideo.api.routes import episodes
    from novelvideo.scene_prerequisites import (
        SCENE_CATALOG_BUILDING_CODE,
        SCENE_CATALOG_BUILDING_MESSAGE,
    )

    calls = _patch_celery_episode_asset_planner(monkeypatch, episodes)
    monkeypatch.setattr(
        episodes,
        "get_task_manager",
        lambda: SimpleNamespace(
            get_task_for_project=lambda *_args, **_kwargs: SimpleNamespace(
                status="running"
            )
        ),
    )

    response = await episodes.plan_episode_scenes(
        project="proj_123",
        episode_num=4,
        user={"username": "admin"},
    )

    assert response == {
        "ok": False,
        "code": SCENE_CATALOG_BUILDING_CODE,
        "error": SCENE_CATALOG_BUILDING_MESSAGE,
    }
    assert calls == []


@pytest.mark.asyncio
async def test_plan_episode_props_returns_updated_episode_detail(tmp_path, monkeypatch):
    from novelvideo.api.routes import episodes
    episode = NovelEpisode(number=1, title="Episode One", beat_source_text="First line")
    store = _CogneeEpisodeStore(episode)
    _patch_project_and_cognee_store(monkeypatch, episodes, tmp_path, store)

    response = await episodes.plan_episode_props(
        project="demo",
        episode_num=1,
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert store.loaded is True
    assert response["data"]["kind"] == "prop"
    assert response["data"]["total_count"] == 1
    assert response["data"]["prop_menu"] == [
        {
            "prop_id": "JadePendant",
            "prop_type": "object",
            "visual_prompt": "",
            "description": "",
            "owner_identity_id": "",
            "marker_color": "",
        }
    ]
    assert response["data"]["episode"]["prop_menu"] == [
        {
            "prop_id": "JadePendant",
            "prop_type": "object",
            "visual_prompt": "",
            "description": "",
            "owner_identity_id": "",
            "marker_color": "",
        }
    ]
    assert response["data"]["logs"] == ["planned props"]
    assert [prop.name for prop in store.sqlite_store.added_props] == ["JadePendant"]
    assert store.sqlite_store.cached_props["JadePendant"].prop_type == "object"
    assert store.get_cached_prop("JadePendant") is not None


@pytest.mark.asyncio
async def test_plan_episode_props_enqueues_celery_task(monkeypatch):
    from novelvideo.api.routes import episodes

    calls = _patch_celery_episode_asset_planner(monkeypatch, episodes)

    response = await episodes.plan_episode_props(
        project="proj_123",
        episode_num=4,
        user={"username": "admin"},
    )

    assert response == {
        "ok": True,
        "task_type": "episode_prop_planner",
        "scope": "prop_run_test",
        "task_id": "task-123",
        "task_key": "task:episode_prop_planner:project:proj_123:4:prop_run_test",
        "backend": "celery",
        "queue": "node.node_a.default",
        "data": {"target_episode": 4, "asset_kind": "prop"},
        "message": "Episode 4 prop planning queued",
    }
    assert calls == [
        {
            "ctx": calls[0]["ctx"],
            "product_surface": "mainline",
            "task_type": "episode_prop_planner",
            "queue_kind": "default",
            "episode": 4,
            "scope": "prop_run_test",
            "payload": {"episode": 4, "asset_kind": "prop"},
        }
    ]
