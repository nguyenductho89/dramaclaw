"""C1 for OI-54 S5 (OI-63): the chat WS *home* turn must bind its own egress identity.

S4 (OI-61) closed the project turn. The home scope is the last hole on this line of chat:
`_stream_home_turn` (`api/routes/chat.py`) is a standalone streaming loop that **completely bypasses
`chat/service.py`** and directly calls `hermes_pool.get_for_user`. So when an organization user
sends a message in home chat, nowhere on the request path is an authorization produced, and the hermes subprocess gets the deployment-level
`NEWAPI_API_KEY` (`effective_gateway_credentials()` in `hermes_pool.py`) --
the platform pays for real compute on the organization's behalf.

The project-scope tests cannot block this one: the two paths are two independent implementations. So this file **enters from
the `/api/v1/chat/ws` entry, and the scope is always home**, observing whose Key is actually in the hermes subprocess env.

**The test does not bind the context itself**: this file deliberately does not use `model_gateway_request_scope` /
`build_request_egress_context` -- the binding must be done by product code, and the test only observes the result.
That is a fake-green pattern recorded in OI-54.

**Sentinel**: the egress project identity of the home scope is `HOME_SCOPE_EGRESS_PROJECT_ID == "__home__"`
(`chat/hermes_egress.py`, defined by S3, and this slice is its first consumer). It must be **consistent across two hops**:
the `context.project_id` produced by `request_egress_scope`, the `egress_project_id` of `authorize_hermes_launch`, and the
`egress_project_id` of `get_for_user` all have the same value,
otherwise `_strict_admission` compares once each in `authorize_credentialed_hermes` and
`build_hermes_child_env`, and any inconsistency yields `TASK_ENVELOPE_INVALID`.
At the same time the **session identity is still home** (`project_id=None`), so the sentinel must not leak into the subprocess's
`DRAMACLAW_PROJECT_ID` -- C2-02 pins this.

**Scope statement**: CE single-machine does not register the `egress_operations` port
(it is not in the ports tuple of `ports/local/__init__.py`), so C2-03 uses the in-repo existing
`tests/support/egress_ledger.py` stand-in to pin the claim at the port boundary; the vertical of rows landing in a real database is supplemented by EE
`tests/b2b/`. The chat path has no success-side state transition, so only the claim is asserted, not the terminal state.
"""

from __future__ import annotations

import asyncio
import json
import time
from types import SimpleNamespace

import pytest

from novelvideo import ports
from novelvideo.chat.hermes_egress import HOME_SCOPE_EGRESS_PROJECT_ID
from novelvideo.chat.store import ChatScope
from novelvideo.model_gateway_runtime import current_model_gateway_context
from novelvideo.ports.auth_contract import AgentSessionToken
from novelvideo.ports.authz import AdmissionContext, AuthzError, BillingPrincipal
from novelvideo.ports.model_credentials import CredentialReference, RequestCredential
from support.egress_ledger import LedgerDouble

pytestmark = pytest.mark.m08

# The login name and user_id deliberately differ: identity determination recognizes only user_id (C2-07 pins this).
_USERNAME = "alice"
_USER_ID = "user-id-9"
_PROJECT_ID = "project-chat-71"
_TASK_TYPE = "agent.hermes.text"

PLATFORM_KEY_CANARY = "PLATFORM_KEY_CANARY"
ORG_KEY_CANARY = "ORG_KEY_CANARY"
_PLATFORM_BASE_URL = "https://platform.canary.invalid/v1"
_ORG_BASE_URL = _PLATFORM_BASE_URL


# --- doubles ---------------------------------------------------------------


def _admission(*, kind: str, user_id: str, root_task_id: str) -> AdmissionContext:
    """Echoes the caller's identity back, like both production implementations
    (EE `authz/port.py:169`, CE `ports/local/__init__.py:67-79`)."""
    organization = kind == "organization"
    return AdmissionContext(
        requester_user_id=user_id,
        billing_principal=BillingPrincipal(
            kind=kind,
            id="org-chat-3" if organization else user_id,
        ),
        credential=CredentialReference(
            source="organization" if organization else kind,
            credential_id="credential-chat-1",
            key_version=7,
            org_id="org-chat-3" if organization else None,
        ),
        admission_id="admission-chat-42",
        root_task_id=root_task_id,
        admitted_at="2026-08-13T02:03:04Z",
        membership_id="membership-chat-5" if organization else None,
        authz_version=13,
    )


class _Authz:
    def __init__(self, *, kind: str = "organization") -> None:
        self.kind = kind
        self.calls: list[tuple[str, str]] = []

    async def admit_model_task(self, *, user_id: str, root_task_id: str):
        self.calls.append((user_id, root_task_id))
        return _admission(kind=self.kind, user_id=user_id, root_task_id=root_task_id)


class _RaisingAuthz:
    def __init__(self, code: str) -> None:
        self.code = code
        self.calls: list[tuple[str, str]] = []

    async def admit_model_task(self, *, user_id: str, root_task_id: str):
        self.calls.append((user_id, root_task_id))
        raise AuthzError(self.code)


class _OrgCredentials:
    """Stands in for the control-plane resolver: CE's `LocalModelCredentials`
    refuses any non-`local` credential source."""

    def __init__(self) -> None:
        self.admissions: list[AdmissionContext] = []

    async def resolve(self, admission) -> RequestCredential:
        self.admissions.append(admission)
        return RequestCredential(
            reference=admission.credential,
            api_key=ORG_KEY_CANARY,
            base_url=_ORG_BASE_URL,
        )


class _Meter:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def require_feature_credit_balance(self, **kwargs):
        self.calls.append(kwargs)
        return None


class _FakeAuthSessions:
    def __init__(self) -> None:
        self.created = 0
        self.revoked: list[str] = []
        self.updated: list[tuple[str, dict]] = []

    async def create_agent_session(self, **kwargs) -> AgentSessionToken:
        self.created += 1
        return AgentSessionToken(
            value=f"token-{self.created}",
            session_id=f"agent-session-{self.created}",
            user=str(kwargs["username"]),
            scopes=tuple(kwargs["scopes"]),
            exp=int(time.time()) + 3600,
            worker_id=str(kwargs["worker_id"]),
            agent_kind=str(kwargs["agent_kind"]),
        )

    async def revoke_agent_session(self, raw_token: str) -> bool:
        self.revoked.append(raw_token)
        return True

    async def update_agent_session_scope(self, raw_token: str, **kwargs) -> bool:
        self.updated.append((raw_token, kwargs))
        return True


class _FakeThread:
    """Minimal ACP thread. `on_stream` runs *inside* an active turn, which is the
    only window in which the pool holds a live org slot (see C2-11)."""

    def __init__(self, session_id: str, *, on_stream=None) -> None:
        self.id = session_id
        self.closed = False
        self._on_stream = on_stream
        self.gateway_api_keys: list[str | None] = []

    async def close(self) -> None:
        self.closed = True

    @property
    def is_closed(self) -> bool:
        return self.closed

    async def warm(self) -> None:
        return None

    async def stream(
        self,
        prompt: str,
        *,
        current_project: str | None = None,
        trajectory_id: str | None = None,
        project_id: str | None = None,
        gateway_api_key: str | None = None,
    ):
        del prompt, current_project, trajectory_id, project_id
        self.gateway_api_keys.append(gateway_api_key)
        yield SimpleNamespace(
            type="thread_started", thread_id=self.id, turn_id="turn-1"
        )
        if self._on_stream is not None:
            await self._on_stream()
        yield SimpleNamespace(
            type="complete",
            text="hermes says hello",
            raw=None,
            name=None,
            thread_id=self.id,
            turn_id="turn-1",
        )


# --- harness ---------------------------------------------------------------


@pytest.fixture()
def harness(monkeypatch, tmp_path):
    """A real `create_app()` WS client wired to a fake hermes worker.

    Only the two ends are faked: who the caller is (auth) and what the hermes
    subprocess is. Everything between — route, egress binding, chat service,
    hermes pool, child-env construction — runs for real, because that middle is
    exactly what OI-63 is about.
    """
    from novelvideo.api.app import create_app
    from novelvideo.api.routes import chat as chat_routes
    from novelvideo.chat import hermes_pool
    from novelvideo.chat import service as chat_service

    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "")
    monkeypatch.setenv("REDIS_URL", "")
    monkeypatch.setenv("DRAMACLAW_CHAT_BACKEND", "hermes")
    # Home-scope session persistence lands in `_state_root()` of `chat/store.py`, which defaults to the in-repo
    # `state/`. Pointing it at tmp keeps this file from writing to the repository working tree.
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "chat-state"))

    output_dir = tmp_path / "out"
    state_dir = tmp_path / "state"
    runtime_dir = tmp_path / "runtime"
    workspace = tmp_path / "hermes-home"
    for path in (output_dir, state_dir, runtime_dir, workspace):
        path.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state_dir))

    ctx = SimpleNamespace(
        project_id=_PROJECT_ID,
        project_name="demo",
        owner_type="user",
        owner_id=_USER_ID,
        owner_username=_USERNAME,
        requester_user_id=_USER_ID,
        requester_username=_USERNAME,
        requester_principals=(),
        effective_role="owner",
        home_node_id="node-1",
        output_dir=output_dir,
        state_dir=state_dir,
        runtime_dir=runtime_dir,
        is_home_node=True,
    )

    async def fake_resolve_project_context(*, user, project_id, required_role="viewer"):
        return ctx

    async def fake_verify_browser_session(_raw_cookie):
        return {"id": _USER_ID, "username": _USERNAME}

    meter = _Meter()
    monkeypatch.setattr(
        chat_routes, "resolve_project_context", fake_resolve_project_context
    )
    monkeypatch.setattr(
        chat_routes, "_verify_browser_session", fake_verify_browser_session
    )
    monkeypatch.setattr(chat_routes, "get_usage_meter", lambda: meter)

    # --- fake hermes worker -------------------------------------------------
    spawned_envs: list[dict[str, str]] = []
    threads: list[_FakeThread] = []
    stream_hook: dict[str, object] = {"fn": None}
    fake_cli = tmp_path / "hermes"
    fake_cli.write_text("#!/bin/sh\n", encoding="utf-8")
    auth_sessions = _FakeAuthSessions()

    class FakeHermesSdkClient:
        def __init__(self, **kwargs) -> None:
            spawned_envs.append(dict(kwargs["env"]))

        def _thread(self, session_id: str) -> _FakeThread:
            async def _hook() -> None:
                fn = stream_hook["fn"]
                if fn is not None:
                    await fn()  # type: ignore[operator]

            thread = _FakeThread(session_id, on_stream=_hook)
            threads.append(thread)
            return thread

        def thread_start(self) -> _FakeThread:
            return self._thread(f"session-{len(threads) + 1}")

        def thread_resume(self, session_id: str) -> _FakeThread:
            return self._thread(session_id)

    monkeypatch.setattr(hermes_pool, "_hermes_cli_path", lambda: fake_cli)
    monkeypatch.setattr(hermes_pool, "require_hermes_fork", lambda _path: None)
    monkeypatch.setattr(
        hermes_pool, "ensure_user_hermes_workspace", lambda _u, **_kwargs: workspace
    )
    monkeypatch.setattr(hermes_pool, "HermesSdkClient", FakeHermesSdkClient)
    monkeypatch.setattr(hermes_pool, "get_auth_session_port", lambda: auth_sessions)
    monkeypatch.setattr(
        hermes_pool, "gateway_origin_fingerprint", lambda: "gateway-1"
    )
    monkeypatch.setattr(
        hermes_pool,
        "effective_gateway_credentials",
        lambda: (PLATFORM_KEY_CANARY, _PLATFORM_BASE_URL),
    )

    pool = hermes_pool.HermesPool(max_workers=5)

    async def fake_project_env(*_args, **_kwargs):
        return {"DRAMACLAW_PROJECT_STATE_DIR": str(tmp_path / "project-state")}

    monkeypatch.setattr(pool, "_project_env", fake_project_env)
    monkeypatch.setattr(hermes_pool, "pool", pool)

    # Observation point: the ambient egress identity seen by the leaf.
    observed_contexts: list[object] = []
    real_get_for_user = pool.get_for_user

    async def spying_get_for_user(*args, **kwargs):
        observed_contexts.append(current_model_gateway_context())
        return await real_get_for_user(*args, **kwargs)

    monkeypatch.setattr(pool, "get_for_user", spying_get_for_user)

    app = create_app()
    from fastapi.testclient import TestClient

    client = TestClient(app)

    return SimpleNamespace(
        app=app,
        client=client,
        chat_routes=chat_routes,
        chat_service=chat_service,
        pool=pool,
        ctx=ctx,
        meter=meter,
        envs=spawned_envs,
        threads=threads,
        stream_hook=stream_hook,
        observed=observed_contexts,
        auth_sessions=auth_sessions,
        monkeypatch=monkeypatch,
        tmp_path=tmp_path,
    )


def _use_authz(monkeypatch, port) -> None:
    # `egress_binding.py:46` lazily fetches the port inside the function body, so patching the module attribute is enough.
    monkeypatch.setattr(ports, "get_authz_port", lambda: port)


def _use_org_credentials(monkeypatch) -> tuple[_OrgCredentials, LedgerDouble]:
    credentials = _OrgCredentials()
    ledger = LedgerDouble()
    monkeypatch.setattr(ports, "get_model_credentials", lambda: credentials)
    monkeypatch.setattr(ports, "get_egress_operation_port", lambda: ledger)
    return credentials, ledger


_DRAIN_EVENT = "__drain__"
_DRAIN_REPLY = f"unsupported event: {_DRAIN_EVENT}"


def _send_home_turn(harness, *, text: str = "Help me think of a story") -> list[dict]:
    """Drive one **home-scope** turn through `/api/v1/chat/ws` and drain its frames.

    Receiving frames must not stop at `chat.done`: the `finally` of `_stream_home_turn` sends `chat.done` first,
    and only afterwards does the exception bubble up to the WS main loop and become an `error` frame. Stopping at `chat.done` would read a rejection as success.
    Here a sentinel event is sent after `chat.done` is received. The active turn has an independent client-event receiver,
    and sending early would be consumed by it; sending after the turn ends lets the WS main loop confirm that all frames were received.
    """
    frames: list[dict] = []
    with harness.client.websocket_connect("/api/v1/chat/ws") as websocket:
        frames.append(websocket.receive_json())  # scope.changed (home)
        websocket.send_json(
            {
                "type": "chat.message",
                "scope": {"kind": "home"},
                "turn_id": "turn-1",
                "text": text,
            }
        )
        drain_sent = False
        while True:
            frame = websocket.receive_json()
            if frame.get("message") == _DRAIN_REPLY:
                break
            frames.append(frame)
            if frame.get("type") in {"chat.done", "error"} and not drain_sent:
                websocket.send_json({"type": _DRAIN_EVENT})
                drain_sent = True
    return frames


def _assert_worker_env_is_keyless(env: dict[str, str]) -> None:
    assert env.get("NEWAPI_API_KEY") == "dramaclaw-per-turn-placeholder", env
    assert env.get("OPENAI_API_KEY") in {None, "dramaclaw-per-turn-placeholder"}, env
    assert env.get("DRAMACLAW_GATEWAY_CREDENTIAL_MODE") == "per_turn_required", env
    assert ORG_KEY_CANARY not in str(env)
    assert PLATFORM_KEY_CANARY not in str(env)


def _assert_last_turn_key(harness, expected: str) -> None:
    assert harness.threads, "no Hermes thread was created"
    assert harness.threads[-1].gateway_api_keys == [expected]


# --- C2-01 -----------------------------------------------------------------


def test_c2_01_home_turn_launches_hermes_with_the_org_key(harness):
    authz = _Authz(kind="organization")
    _use_authz(harness.monkeypatch, authz)
    credentials, _ledger = _use_org_credentials(harness.monkeypatch)

    frames = _send_home_turn(harness)

    assert [f for f in frames if f.get("type") == "error"] == [], frames
    assert frames[-1]["type"] == "chat.done"
    assert len(harness.envs) == 1, harness.envs
    _assert_worker_env_is_keyless(harness.envs[0])
    _assert_last_turn_key(harness, ORG_KEY_CANARY)
    assert harness.envs[0]["NEWAPI_BASE_URL"] == _ORG_BASE_URL
    # What is fed to admit_model_task must be user_id, not the login name.
    assert [call[0] for call in authz.calls] == [_USER_ID]
    assert len(credentials.admissions) == 1
    assert credentials.admissions[0].requester_user_id == _USER_ID
    # The binding was indeed done by product code: the ambient context is non-empty when the leaf takes its number, and the egress project
    # identity is the home sentinel.
    assert harness.observed and harness.observed[0] is not None
    assert harness.observed[0].task_type == _TASK_TYPE
    assert harness.observed[0].project_id == HOME_SCOPE_EGRESS_PROJECT_ID


# --- C2-02 -----------------------------------------------------------------


def test_c2_02_session_identity_stays_home_and_the_sentinel_never_reaches_the_child(
    harness,
):
    """The sentinel only feeds the egress comparison and must not leak into the subprocess.

    The session identity and the egress identity are two bases: `get_for_user(project_id=None)` is the session side,
    `egress_project_id="__home__"` is the egress side. `build_hermes_child_env` writes `DRAMACLAW_PROJECT_ID` only when
    `project_id` is non-empty, so this variable must **not exist** in the home-scope subprocess --
    once it appears, hermes would treat `__home__` as a real project and operate on it.
    """
    _use_authz(harness.monkeypatch, _Authz(kind="organization"))
    _use_org_credentials(harness.monkeypatch)

    frames = _send_home_turn(harness)

    assert [f for f in frames if f.get("type") == "error"] == [], frames
    env = harness.envs[0]
    # The egress side did use the sentinel...
    _assert_worker_env_is_keyless(env)
    _assert_last_turn_key(harness, ORG_KEY_CANARY)
    assert harness.observed[0].project_id == HOME_SCOPE_EGRESS_PROJECT_ID
    # ...but the session side is still home: the subprocess has no project id, and not a single byte of the sentinel leaked in.
    assert "DRAMACLAW_PROJECT_ID" not in env, env
    assert HOME_SCOPE_EGRESS_PROJECT_ID not in str(env), env


# --- C2-03 -----------------------------------------------------------------


def test_c2_03_home_turn_leaves_a_claim_on_the_egress_ledger(harness):
    """Egress must leave a trace. The chat path has no success-side state transition, so only the claim is asserted, not the terminal state."""
    _use_authz(harness.monkeypatch, _Authz(kind="organization"))
    _credentials, ledger = _use_org_credentials(harness.monkeypatch)

    frames = _send_home_turn(harness)

    assert frames[-1]["type"] == "chat.done", frames
    assert len(ledger.claims) == 1, ledger.claims
    spec = ledger.claims[0]
    # The capability on the ledger side and the task_type on the binding side must be the same string (EG-07 basis).
    assert spec.capability == _TASK_TYPE
    assert spec.organization_id == "org-chat-3"
    # In the ledger the home scope records the sentinel. The project_id of EE-side egress_operations is
    # TEXT NOT NULL with no foreign key to projects, so the sentinel needs no real project record.
    assert spec.project_id == HOME_SCOPE_EGRESS_PROJECT_ID
    assert spec.credential_id == "credential-chat-1"
    assert spec.credential_version == 7


# --- C2-04 -----------------------------------------------------------------


def test_c2_04_platform_identity_path_is_unchanged(harness):
    """Watchdog test: under a non-organization identity nothing is bound, and the subprocess env follows the existing platform path."""
    _use_authz(harness.monkeypatch, _Authz(kind="platform"))
    credentials, ledger = _use_org_credentials(harness.monkeypatch)

    frames = _send_home_turn(harness)

    assert [f for f in frames if f.get("type") == "error"] == [], frames
    assert frames[-1]["type"] == "chat.done"
    assert len(harness.envs) == 1
    _assert_worker_env_is_keyless(harness.envs[0])
    _assert_last_turn_key(harness, PLATFORM_KEY_CANARY)
    assert ORG_KEY_CANARY not in str(harness.envs[0])
    # The platform path is byte-for-byte unchanged: no context bound, no organization credentials resolved, no ledger touched.
    assert harness.observed == [None]
    assert credentials.admissions == []
    assert ledger.claims == []
    assert current_model_gateway_context() is None


# --- C2-05 -----------------------------------------------------------------


def test_c2_05_gray_disabled_behaves_exactly_like_the_platform_path(harness):
    """Gray rollout off = platform semantics: no binding, no rejection, same result as C2-04."""
    authz = _RaisingAuthz("P0_GRAY_DISABLED")
    _use_authz(harness.monkeypatch, authz)
    credentials, ledger = _use_org_credentials(harness.monkeypatch)

    frames = _send_home_turn(harness)

    assert [f for f in frames if f.get("type") == "error"] == [], frames
    assert frames[-1]["type"] == "chat.done"
    assert len(authz.calls) == 1
    assert len(harness.envs) == 1
    _assert_worker_env_is_keyless(harness.envs[0])
    _assert_last_turn_key(harness, PLATFORM_KEY_CANARY)
    assert ORG_KEY_CANARY not in str(harness.envs[0])
    assert harness.observed == [None]
    assert credentials.admissions == []
    assert ledger.claims == []


# --- C2-06 -----------------------------------------------------------------


def test_c2_06_real_denial_is_not_squashed_into_the_platform_path(harness):
    """`ORG_MEMBERSHIP_INACTIVE` is a real rejection and must not be squashed into `None` and treated as "not an organization, allow"."""
    authz = _RaisingAuthz("ORG_MEMBERSHIP_INACTIVE")
    _use_authz(harness.monkeypatch, authz)
    _use_org_credentials(harness.monkeypatch)

    frames = _send_home_turn(harness)

    assert len(authz.calls) == 1
    errors = [f for f in frames if f.get("type") == "error"]
    assert len(errors) == 1, frames
    assert errors[0]["message"] == str(AuthzError("ORG_MEMBERSHIP_INACTIVE"))
    # A rejection is a rejection: not a single hermes worker may be started.
    assert harness.envs == []
    assert current_model_gateway_context() is None


# --- C2-07 -----------------------------------------------------------------


def test_c2_07_identity_is_decided_by_user_id_not_by_login_name(harness):
    """The login name and user_id are two different values. Determination recognizes only user_id; the env holds the login name."""
    authz = _Authz(kind="organization")
    _use_authz(harness.monkeypatch, authz)
    credentials, ledger = _use_org_credentials(harness.monkeypatch)
    assert _USERNAME != _USER_ID

    frames = _send_home_turn(harness)

    assert frames[-1]["type"] == "chat.done", frames
    _assert_worker_env_is_keyless(harness.envs[0])
    _assert_last_turn_key(harness, ORG_KEY_CANARY)
    # The determination side always uses user_id; the login name must never appear in the identity determination inputs.
    assert [call[0] for call in authz.calls] == [_USER_ID]
    assert _USERNAME not in [call[0] for call in authz.calls]
    assert [a.requester_user_id for a in credentials.admissions] == [_USER_ID]
    assert harness.observed[0].requester_user_id == _USER_ID
    assert ledger.claims[0].organization_id == "org-chat-3"
    # DRAMACLAW_USER in the subprocess env is still the login name -- that is the workspace basis, not the identity basis.
    assert harness.envs[0]["DRAMACLAW_USER"] == _USERNAME


# --- C2-08 -----------------------------------------------------------------
#
# Seam-guard test, not a chain test (the chain is covered by C2-01/02/03/07/11).
# Deliberately calls the helper directly, because the route cannot construct this shape: `TrustedEgressContext.__post_init__`
# requires `requester_user_id` to be non-empty, while the route feeds the same `requester_user_id` to both the binding
# factory and the helper, so the two sides are always equal. The value of defense in depth is exactly in blocking "someday upstream changes".


def _home_context() -> object:
    """A trusted context whose `project_id` is the home sentinel.

    Incidentally pins §6.3: the sentinel passes the non-empty invariant of `TrustedEgressContext.__post_init__`,
    without relaxing any validation for it.
    """
    from novelvideo.egress_context import TrustedEgressContext

    admission = _admission(kind="organization", user_id=_USER_ID, root_task_id="rt-1")
    return TrustedEgressContext(
        envelope_id="req-rt-1",
        project_id=HOME_SCOPE_EGRESS_PROJECT_ID,
        task_type=_TASK_TYPE,
        requester_user_id=admission.requester_user_id,
        root_task_id=admission.root_task_id,
        admission_id=admission.admission_id,
        admitted_at=admission.admitted_at,
        membership_id=admission.membership_id,
        authz_version=admission.authz_version,
        billing_principal=admission.billing_principal,
        credential=admission.credential,
    )


@pytest.mark.asyncio
async def test_c2_08_missing_requester_user_id_is_refused_not_backfilled(harness):
    """`egress_context` non-None while `requester_user_id` is empty -> reject, must not fall back to the login name."""
    from novelvideo.chat.hermes_egress import EgressBoundaryError

    _use_authz(harness.monkeypatch, _Authz(kind="organization"))
    credentials, ledger = _use_org_credentials(harness.monkeypatch)

    with pytest.raises(EgressBoundaryError) as excinfo:
        await harness.chat_service.authorize_hermes_launch(
            egress_context=_home_context(),
            username=_USERNAME,
            requester_user_id="",
            egress_project_id=HOME_SCOPE_EGRESS_PROJECT_ID,
            prompt="Help me think of a story",
        )

    assert excinfo.value.code == "TASK_ENVELOPE_INVALID"
    # Did not fall back to username: no credentials resolved, no worker started, and nothing written to the ledger.
    assert credentials.admissions == []
    assert ledger.claims == []
    assert harness.envs == []


@pytest.mark.asyncio
async def test_c2_08b_sentinel_must_agree_across_both_hops(harness):
    """Sentinel consistent across two hops: reject if the hop that exchanges the authorization does not match the hop that binds."""
    from novelvideo.chat.hermes_egress import EgressBoundaryError

    _use_authz(harness.monkeypatch, _Authz(kind="organization"))
    credentials, ledger = _use_org_credentials(harness.monkeypatch)

    with pytest.raises(EgressBoundaryError) as excinfo:
        await harness.chat_service.authorize_hermes_launch(
            egress_context=_home_context(),  # context.project_id == "__home__"
            username=_USERNAME,
            requester_user_id=_USER_ID,
            egress_project_id="project-somebody-else",
            prompt="Help me think of a story",
        )

    assert excinfo.value.code == "TASK_ENVELOPE_INVALID"
    assert credentials.admissions == []
    assert ledger.claims == []

    # Positive control: with equal values it passes as usual, proving that the red above is "inconsistency" and not "the sentinel itself is illegal".
    authorization = await harness.chat_service.authorize_hermes_launch(
        egress_context=_home_context(),
        username=_USERNAME,
        requester_user_id=_USER_ID,
        egress_project_id=HOME_SCOPE_EGRESS_PROJECT_ID,
        prompt="Help me think of a story",
    )
    assert authorization is not None
    assert authorization.credential.api_key == ORG_KEY_CANARY
    assert len(ledger.claims) == 1


@pytest.mark.asyncio
async def test_c2_08c_non_org_context_yields_no_authorization(harness):
    """`egress_context is None` -> return None; the platform path resolves no credentials and writes nothing to the ledger."""
    credentials, ledger = _use_org_credentials(harness.monkeypatch)

    authorization = await harness.chat_service.authorize_hermes_launch(
        egress_context=None,
        username=_USERNAME,
        requester_user_id=_USER_ID,
        egress_project_id=HOME_SCOPE_EGRESS_PROJECT_ID,
        prompt="Help me think of a story",
    )

    assert authorization is None
    assert credentials.admissions == []
    assert ledger.claims == []


# --- C2-09 -----------------------------------------------------------------


def test_c2_09_scope_does_not_leak_out_of_the_turn(harness):
    _use_authz(harness.monkeypatch, _Authz(kind="organization"))
    _use_org_credentials(harness.monkeypatch)
    assert current_model_gateway_context() is None

    frames = _send_home_turn(harness)

    assert frames[-1]["type"] == "chat.done", frames
    assert harness.observed[0] is not None
    assert current_model_gateway_context() is None


def test_home_codex_uses_backend_neutral_service_without_hermes_worker(harness):
    captured: dict[str, object] = {}

    async def fake_stream(username, project, prompt, on_event, **kwargs):
        captured.update(
            username=username,
            project=project,
            prompt=prompt,
            egress_project_id=kwargs.get("egress_project_id"),
            store_scope=kwargs.get("store_scope"),
        )
        await on_event(
            {"type": "thread_started", "thread_id": "codex-thread", "turn_id": "turn-1"}
        )
        await on_event({"type": "assistant_delta", "text": "codex says hello"})
        message = {
            "id": 1,
            "role": "assistant",
            "content": "codex says hello",
            "media": [],
        }
        await on_event({"type": "done", "message": message})
        return message

    harness.monkeypatch.setattr(
        harness.chat_service, "get_chat_backend_name", lambda: "codex"
    )
    harness.monkeypatch.setattr(
        harness.chat_service, "stream_assistant_reply", fake_stream
    )
    _use_authz(harness.monkeypatch, _Authz(kind="platform"))

    frames = _send_home_turn(harness)

    assert [frame for frame in frames if frame.get("type") == "error"] == []
    assert any(frame.get("type") == "thread.started" for frame in frames)
    assert any(frame.get("type") == "assistant.delta" for frame in frames)
    assert any(frame.get("type") == "assistant.message" for frame in frames)
    assert any(frame.get("type") == "chat.done" for frame in frames)
    assert captured["username"] == _USERNAME
    assert captured["project"] == ""
    assert captured["egress_project_id"] == HOME_SCOPE_EGRESS_PROJECT_ID
    assert captured["store_scope"] == ChatScope(kind="home")
    assert harness.envs == []


def test_c2_09b_scope_does_not_leak_on_the_exception_path(harness):
    _use_authz(harness.monkeypatch, _Authz(kind="organization"))
    _use_org_credentials(harness.monkeypatch)

    async def blow_up() -> None:
        raise RuntimeError("hermes exploded mid-turn")

    harness.stream_hook["fn"] = blow_up

    frames = _send_home_turn(harness)

    errors = [f for f in frames if f.get("type") == "error"]
    assert len(errors) == 1, frames
    assert "hermes exploded mid-turn" in errors[0]["message"]
    assert harness.observed[0] is not None
    assert current_model_gateway_context() is None


# --- C2-11 -----------------------------------------------------------------


async def _home_turn_via_asgi(harness, *, text: str, turn_id: str) -> list[dict]:
    """Drive a home turn through `/api/v1/chat/ws` from *inside* the app event loop.

    C2-11 wants the concurrency window "while a project turn is streaming output", but `TestClient`'s
    `websocket_connect` is blocking and can be driven only by the test thread, so it cannot enter that window.
    Here the same app is connected directly per the ASGI protocol: the entry is still the product route `/api/v1/chat/ws` itself,
    and middleware, auth, event dispatch, and `_stream_home_turn` all run in full; what is missing is only the TestClient
    thread wrapper. This is **not** bypassing the route to call `_stream_home_turn` directly.
    """
    inbound: asyncio.Queue = asyncio.Queue()
    await inbound.put({"type": "websocket.connect"})
    for payload in (
        {
            "type": "chat.message",
            "scope": {"kind": "home"},
            "turn_id": turn_id,
            "text": text,
        },
        {"type": _DRAIN_EVENT},
    ):
        await inbound.put({"type": "websocket.receive", "text": json.dumps(payload)})

    frames: list[dict] = []
    drained = asyncio.Event()

    async def receive() -> dict:
        if inbound.empty():
            await drained.wait()
            return {"type": "websocket.disconnect", "code": 1000}
        return await inbound.get()

    async def send(message: dict) -> None:
        if message["type"] == "websocket.send" and message.get("text"):
            frame = json.loads(message["text"])
            frames.append(frame)
            if frame.get("message") == _DRAIN_REPLY:
                drained.set()
        elif message["type"] == "websocket.close":
            drained.set()

    scope = {
        "type": "websocket",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "scheme": "ws",
        "server": ("testserver", 80),
        "client": ("testclient", 50001),
        "root_path": "",
        "path": "/api/v1/chat/ws",
        "raw_path": b"/api/v1/chat/ws",
        "query_string": b"",
        "headers": [(b"host", b"testserver")],
        "subprotocols": [],
        "state": {},
    }
    await harness.app(scope, receive, send)
    return frames


def _send_project_turn(harness, *, text: str = "Draw a storyboard") -> list[dict]:
    frames: list[dict] = []
    with harness.client.websocket_connect("/api/v1/chat/ws") as websocket:
        frames.append(websocket.receive_json())  # scope.changed (home)
        websocket.send_json(
            {
                "type": "chat.message",
                "scope": {"kind": "project", "id": _PROJECT_ID},
                "turn_id": "turn-project-1",
                "text": text,
            }
        )
        drain_sent = False
        while True:
            frame = websocket.receive_json()
            if frame.get("message") == _DRAIN_REPLY:
                break
            frames.append(frame)
            if frame.get("type") in {"chat.done", "error"} and not drain_sent:
                websocket.send_json({"type": _DRAIN_EVENT})
                drain_sent = True
    return frames


def test_c2_11_concurrent_home_turn_runs_its_own_admission(harness):
    """A concurrent home turn must go through **its own** admission and must not inherit the authorization of the project turn.

    S4 added egress-identity inheritance to `_rotate_slot_locked`, fixing "an organization user's own in-flight turn being
    taken over by a concurrent call and falling back to the platform Key". But this left a narrow gap: a concurrent call **without authorization**
    hits the rotation branch where `gateway_fingerprint` does not match
    (the fingerprint of an organization slot is `""`), and so `_rotate_slot_locked(authorization=slot.authorization)`
    **inherits** the organization credentials to a call that never went through admission.

    Before S5, the home turn was exactly such a call without authorization.
    After S5 it brings its own authorization, and so takes the **tear-down-and-rebuild** path at the start of `get_for_user`
    (`slot is not None and authorization is not None`) rather than rotation, and the gap closes.
    This case is the gatekeeper of that closure.

    Counter-proof form: on the authz fake assert that `admit_model_task` was called **twice**
    (the two root_task_ids differ), and verify that the two workers created because of different scopes contain no
    real secret, each turn receiving its own organization credentials only through per-turn parameters.
    """
    authz = _Authz(kind="organization")
    _use_authz(harness.monkeypatch, authz)
    _credentials, ledger = _use_org_credentials(harness.monkeypatch)

    home_frames: list[dict] = []

    async def concurrent_home_turn() -> None:
        # While the project turn is streaming output (slot.active_turns == 1), another tab sends
        # a home message. It takes the same WS route of the same app.
        # The hook fires only once; if a concurrent request creates its own thread it must not recursively send the same request again.
        harness.stream_hook["fn"] = None
        home_frames.extend(
            await _home_turn_via_asgi(
                harness, text="By the way, tell a joke", turn_id="turn-home-concurrent"
            )
        )

    harness.stream_hook["fn"] = concurrent_home_turn

    project_frames = _send_project_turn(harness)

    # The project turn itself was not broken by the concurrent call, and is still the organization Key.
    assert [f for f in project_frames if f.get("type") == "error"] == [], project_frames
    assert project_frames[-1]["type"] == "chat.done"
    _assert_worker_env_is_keyless(harness.envs[0])
    assert harness.threads[0].gateway_api_keys == [ORG_KEY_CANARY]

    # Counter-proof one: the home turn ran **its own** admit, and the two root_task_ids differ.
    assert len(authz.calls) == 2, authz.calls
    assert authz.calls[0][1] != authz.calls[1][1], authz.calls
    assert [call[0] for call in authz.calls] == [_USER_ID, _USER_ID]

    # Counter-proof two: the home turn switched to **its own** authorization -- two claims on the ledger,
    # with different business_task_id (envelope_id), and the home one records the home sentinel.
    assert len(ledger.claims) == 2, ledger.claims
    assert ledger.claims[0].business_task_id != ledger.claims[1].business_task_id
    assert {spec.project_id for spec in ledger.claims} == {
        _PROJECT_ID,
        HOME_SCOPE_EGRESS_PROJECT_ID,
    }

    # Different scopes create independent workers, but real credentials must not land in any worker environment.
    assert len(harness.envs) == 2, harness.envs
    assert harness.auth_sessions.created == 2
    for env in harness.envs:
        _assert_worker_env_is_keyless(env)
    assert [thread.gateway_api_keys for thread in harness.threads] == [
        [ORG_KEY_CANARY],
        [ORG_KEY_CANARY],
    ]

    # Both turns completed, with no inheritance/concurrency boundary errors.
    home_errors = [
        f
        for f in home_frames
        if f.get("type") == "error" and f.get("message") != _DRAIN_REPLY
    ]
    assert home_errors == [], home_frames
    assert any(f.get("type") == "chat.done" for f in home_frames)
    assert ORG_KEY_CANARY not in str(home_frames)


# --- guard: the harness must really be going through the WS route ----------


def test_route_and_backend_fixture_are_wired(harness):
    from novelvideo.chat.service import _chat_backend

    assert _chat_backend() == "hermes"
    # The entry is the product route itself, not an app the test built on its own.
    ws_routes = [
        route
        for route in harness.chat_routes.router.routes
        if getattr(route, "path", "") == "/chat/ws"
    ]
    assert len(ws_routes) == 1
    assert ws_routes[0].endpoint is harness.chat_routes.chat_ws
    # And `/api/v1/chat/ws` can really be connected (all the other cases go through this route).
    with harness.client.websocket_connect("/api/v1/chat/ws") as websocket:
        assert websocket.receive_json()["type"] == "scope.changed"
