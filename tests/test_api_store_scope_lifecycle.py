"""Store lifecycle: the factory must close on init failure, and the scope must always close on leaving ``async with``.

Behind every ``SQLiteStore`` is an aiosqlite connection plus a background thread. A missed close does not raise an error immediately;
it only shows up in load tests or long runs as monotonically rising connection and thread counts -- so all assertions here land on
"how many times ``close()`` was called", not on return values.

The factory path is especially easy to miss: the ``try/finally`` of ``*_scope`` is responsible only for instances the **factory returned successfully**.
When ``initialize()`` has already opened the connection and ``load_graph_state()`` then raises, the instance has not been handed to anyone yet,
and the scope's ``finally`` cannot see it at all.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest


class _FakeStore:
    """Bookkeeping fake store: only cares whether the init step raises and how many times close is called."""

    instances: list["_FakeStore"] = []

    def __init__(self, *_args, fail_on: str | None = None, **_kwargs):
        self.fail_on = fail_on
        self.initialized = False
        self.graph_loaded = False
        self.close_calls = 0
        _FakeStore.instances.append(self)

    async def initialize(self):
        if self.fail_on == "initialize":
            raise RuntimeError("boom in initialize")
        self.initialized = True

    async def load_graph_state(self):
        if self.fail_on == "load_graph_state":
            raise RuntimeError("boom in load_graph_state")
        self.graph_loaded = True

    async def close(self):
        self.close_calls += 1


def _install_fake_store(monkeypatch, *, fail_on: str | None = None):
    """Replace the ``from novelvideo.sqlite_store import SQLiteStore`` inside the factory with a fake."""
    import novelvideo.sqlite_store as sqlite_store_module

    _FakeStore.instances.clear()
    monkeypatch.setattr(
        sqlite_store_module,
        "SQLiteStore",
        lambda *a, **kw: _FakeStore(*a, fail_on=fail_on, **kw),
    )


def _ctx(tmp_path: Path):
    return SimpleNamespace(
        project_id="proj_demo",
        owner_project_label="demo",
        output_dir=tmp_path,
        state_dir=tmp_path,
        is_home_node=True,
    )


@pytest.fixture
def deps_module(monkeypatch):
    # Import inside the function: ``tests/contract/test_m01_auth.py`` pops ``novelvideo.api.*``
    # wholesale out of ``sys.modules`` and rebuilds the app in CE mode, so a module-level binding is by then a
    # dead object, and a patch applied to it silently misses.
    from novelvideo.api import deps

    # This step in the factory only does ownership validation and is unrelated to the lifecycle verified in this file.
    monkeypatch.setattr(deps, "require_project_home_node", lambda ctx, operation="": None)
    return deps


async def test_context_factory_closes_store_when_load_graph_state_raises(
    deps_module, monkeypatch, tmp_path
):
    """Initialization window: the connection is already open, the second step raises, and the instance has not been handed out -- it must close itself."""
    _install_fake_store(monkeypatch, fail_on="load_graph_state")

    with pytest.raises(RuntimeError, match="boom in load_graph_state"):
        await deps_module.make_sqlite_store_for_context(_ctx(tmp_path))

    (store,) = _FakeStore.instances
    assert store.initialized is True, "Precondition: the connection was really opened, otherwise this case is not testing what it intends to"
    assert store.close_calls == 1


async def test_context_factory_closes_store_when_initialize_raises(
    deps_module, monkeypatch, tmp_path
):
    _install_fake_store(monkeypatch, fail_on="initialize")

    with pytest.raises(RuntimeError, match="boom in initialize"):
        await deps_module.make_sqlite_store_for_context(_ctx(tmp_path))

    (store,) = _FakeStore.instances
    assert store.close_calls == 1


async def test_context_factory_skips_graph_state_but_still_closes_on_init_failure(
    deps_module, monkeypatch, tmp_path
):
    """``load_graph_state=False`` is the branch taken by ``/beats``; do not miss the closing on this one."""
    _install_fake_store(monkeypatch, fail_on="initialize")

    with pytest.raises(RuntimeError):
        await deps_module.make_sqlite_store_for_context(
            _ctx(tmp_path), load_graph_state=False
        )

    (store,) = _FakeStore.instances
    assert store.graph_loaded is False
    assert store.close_calls == 1


async def test_ce_factory_closes_store_when_load_graph_state_raises(
    deps_module, monkeypatch, tmp_path
):
    """The CE path (opening the database by username/project) enjoys the same guarantee."""
    _install_fake_store(monkeypatch, fail_on="load_graph_state")
    monkeypatch.setattr(deps_module, "get_output_dir", lambda u, p: str(tmp_path))
    monkeypatch.setattr(deps_module, "get_state_dir", lambda u, p: str(tmp_path))

    with pytest.raises(RuntimeError, match="boom in load_graph_state"):
        await deps_module.make_sqlite_store("admin", "demo")

    (store,) = _FakeStore.instances
    assert store.close_calls == 1


async def test_successful_factory_does_not_close_the_store_it_returns(
    deps_module, monkeypatch, tmp_path
):
    """Reverse sentinel: do not write "close on error" as "always close", otherwise the caller gets a dead connection."""
    _install_fake_store(monkeypatch)

    store = await deps_module.make_sqlite_store_for_context(_ctx(tmp_path))

    assert store.initialized is True
    assert store.graph_loaded is True
    assert store.close_calls == 0


async def test_context_scope_closes_on_normal_exit(deps_module, monkeypatch, tmp_path):
    _install_fake_store(monkeypatch)

    async with deps_module.sqlite_store_for_context_scope(_ctx(tmp_path)) as store:
        assert store.close_calls == 0

    assert store.close_calls == 1


async def test_context_scope_closes_when_the_body_raises(deps_module, monkeypatch, tmp_path):
    _install_fake_store(monkeypatch)

    with pytest.raises(RuntimeError, match="body blew up"):
        async with deps_module.sqlite_store_for_context_scope(_ctx(tmp_path)) as store:
            raise RuntimeError("body blew up")

    assert store.close_calls == 1


async def test_context_scope_leaves_no_store_open_when_init_fails(
    deps_module, monkeypatch, tmp_path
):
    """The scope's ``finally`` cannot see an instance whose initialization failed; this guards the fallback at the factory layer."""
    _install_fake_store(monkeypatch, fail_on="load_graph_state")

    with pytest.raises(RuntimeError, match="boom in load_graph_state"):
        async with deps_module.sqlite_store_for_context_scope(_ctx(tmp_path)):
            pytest.fail("Should not reach the body: the factory already raised")

    (store,) = _FakeStore.instances
    assert store.close_calls == 1
