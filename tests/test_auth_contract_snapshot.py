"""T0-7 one of the characterization baselines: auth legacy-dict key-set snapshot.

The hot-path contract named by the technical plan -- dozens of places across the codebase read the user dict returned by auth by key name.
When T4 creates the new FileAuthPort this key set is the easiest thing to silently deform, so this test pins down the "before the split" shape:
both implementations (the EE implementation of control_plane / the future FileAuthPort) must produce the same key set.

Note: after T2 moved the auth DTOs out to the engine-side auth_contract, the import paths of this file
were updated accordingly (behavior assertions unchanged).
"""

from __future__ import annotations

from novelvideo.api.auth import AUTH_COOKIE_NAME
from novelvideo.ports.auth_contract import AgentAuthenticatedUser, AuthenticatedUser

import pytest

pytestmark = pytest.mark.m01

# Contract measured before the split (2026-06-11, HEAD 4f9481a4); must not drift:
BROWSER_LEGACY_KEYS = {"id", "user_id", "username", "role"}
AGENT_LEGACY_KEYS = BROWSER_LEGACY_KEYS | {
    "credential_kind",
    "agent_session_id",
    "agent_kind",
    "worker_id",
    "scopes",
    "current_scope_kind",
    "current_project_id",
    "parent_session_id",
}


def test_auth_cookie_name_is_st_session() -> None:
    assert AUTH_COOKIE_NAME == "st_session"


def test_browser_legacy_dict_key_set() -> None:
    user = AuthenticatedUser(id="u1", username="alice", role="owner")
    data = user.to_legacy_dict()
    assert set(data) == BROWSER_LEGACY_KEYS
    assert data["id"] == data["user_id"], "id and user_id must be aliases with the same value"


def test_agent_legacy_dict_key_set() -> None:
    user = AgentAuthenticatedUser(
        id="u1",
        username="alice",
        role="owner",
        agent_session_id="as1",
        scopes=("projects:write",),
    )
    data = user.to_legacy_dict()
    assert set(data) == AGENT_LEGACY_KEYS
    assert data["credential_kind"] == "agent_session"
    assert isinstance(data["scopes"], list), "scopes must be serialized as a list"
    assert data["current_scope_kind"] == "home", "default scope kind is home"
