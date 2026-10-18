"""C1 for OI-54 S4 (OI-61): the chat WS project turn must bind its own egress identity.

All production set points of `_MODEL_GATEWAY_CONTEXT` (`model_gateway_runtime.py:30-33`) are on the
worker side, and none is on the request path. So when an organization user sends a message in chat, the egress gate reads
`None`, and the hermes subprocess gets the deployment-level `NEWAPI_API_KEY`
(`effective_gateway_credentials()` at `hermes_pool.py:584`) -- the platform pays for real compute on the organization's behalf.

The organization branch at `service.py:3588` was written by S3 but can never be entered today: nobody passes `egress_context`.
This file **enters from the `/api/v1/chat/ws` entry** and observes whose Key is actually in the hermes subprocess env.

**The test does not bind the context itself**: this file deliberately does not use `model_gateway_request_scope` /
`build_request_egress_context` -- the binding must be done by product code, and the test only observes the result.
That is a fake-green pattern recorded in OI-54.

**Scope statement**: CE single-machine does not register the `egress_operations` port
(it is not in the ports tuple of `ports/local/__init__.py`), so C1-02 uses the in-repo existing
`tests/support/egress_ledger.py` stand-in to pin the claim at the port boundary; the vertical of rows landing in a real database is supplemented by EE
`tests/b2b/`. The chat path has no success-side state transition, so only the claim is asserted, not the terminal state.
"""

from __future__ import annotations

import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo import ports
from novelvideo.model_gateway_runtime import current_model_gateway_context
from novelvideo.ports.auth_contract import AgentSessionToken
from novelvideo.ports.authz import AdmissionContext, AuthzError, BillingPrincipal
from novelvideo.ports.model_credentials import CredentialReference, RequestCredential
from support.egress_ledger import LedgerDouble

pytestmark = pytest.mark.m08

# The login name and user_id deliberately differ: identity determination recognizes only user_id (C1-06 pins this).
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
    only window in which the pool holds a live org slot (see C1-08)."""

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
    exactly what OI-61 is about.
    """
    from novelvideo.api.app import create_app
    from novelvideo.api.routes import chat as chat_routes
    from novelvideo.chat import hermes_pool
    from novelvideo.chat import service as chat_service

    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "")
    monkeypatch.setenv("REDIS_URL", "")
    monkeypatch.setenv("DRAMACLAW_CHAT_BACKEND", "hermes")

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
    monkeypatch.setattr(chat_routes, "resolve_project_context", fake_resolve_project_context)
    monkeypatch.setattr(chat_routes, "_verify_browser_session", fake_verify_browser_session)
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
        hermes_pool,
        "ensure_user_hermes_workspace",
        lambda _u, **_kwargs: workspace,
    )
    monkeypatch.setattr(hermes_pool, "HermesSdkClient", FakeHermesSdkClient)
    monkeypatch.setattr(hermes_pool, "get_auth_session_port", lambda: auth_sessions)
    monkeypatch.setattr(hermes_pool, "gateway_origin_fingerprint", lambda: "gateway-1")
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


def _send_project_turn(harness, *, text: str = "Draw a storyboard") -> list[dict]:
    """Drive one project-scope turn through `/api/v1/chat/ws` and drain its frames.

    Receiving frames must not stop at `chat.done`: the `finally` of `_stream_project_turn` sends `chat.done` first,
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
                "scope": {"kind": "project", "id": _PROJECT_ID},
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


# --- C1-01 -----------------------------------------------------------------


def test_c1_01_project_turn_launches_hermes_with_the_org_key(harness):
    authz = _Authz(kind="organization")
    _use_authz(harness.monkeypatch, authz)
    credentials, _ledger = _use_org_credentials(harness.monkeypatch)

    frames = _send_project_turn(harness)

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
    # The binding was indeed done by product code: the ambient context is non-empty when the leaf takes its number.
    assert harness.observed and harness.observed[0] is not None
    assert harness.observed[0].task_type == _TASK_TYPE
    assert harness.observed[0].project_id == _PROJECT_ID


# --- C1-02 -----------------------------------------------------------------


def test_c1_02_project_turn_leaves_a_claim_on_the_egress_ledger(harness):
    """Egress must leave a trace. The chat path has no success-side state transition, so only the claim is asserted, not the terminal state."""
    _use_authz(harness.monkeypatch, _Authz(kind="organization"))
    _credentials, ledger = _use_org_credentials(harness.monkeypatch)

    frames = _send_project_turn(harness)

    assert frames[-1]["type"] == "chat.done", frames
    assert len(ledger.claims) == 1, ledger.claims
    spec = ledger.claims[0]
    # The capability on the ledger side and the task_type on the binding side must be the same string (EG-07 basis).
    assert spec.capability == _TASK_TYPE
    assert spec.organization_id == "org-chat-3"
    assert spec.project_id == _PROJECT_ID
    assert spec.credential_id == "credential-chat-1"
    assert spec.credential_version == 7


# --- C1-03 -----------------------------------------------------------------


def test_c1_03_platform_identity_path_is_unchanged(harness):
    """Watchdog test: under a non-organization identity nothing is bound, and the subprocess env follows the existing platform path."""
    _use_authz(harness.monkeypatch, _Authz(kind="platform"))
    credentials, ledger = _use_org_credentials(harness.monkeypatch)

    frames = _send_project_turn(harness)

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


# --- C1-04 -----------------------------------------------------------------


def test_c1_04_gray_disabled_behaves_exactly_like_the_platform_path(harness):
    """Gray rollout off = platform semantics: no binding, no rejection, same result as C1-03."""
    authz = _RaisingAuthz("P0_GRAY_DISABLED")
    _use_authz(harness.monkeypatch, authz)
    credentials, ledger = _use_org_credentials(harness.monkeypatch)

    frames = _send_project_turn(harness)

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


# --- C1-05 -----------------------------------------------------------------


def test_c1_05_real_denial_is_not_squashed_into_the_platform_path(harness):
    """`ORG_MEMBERSHIP_INACTIVE` is a real rejection and must not be squashed into `None` and treated as "not an organization, allow"."""
    authz = _RaisingAuthz("ORG_MEMBERSHIP_INACTIVE")
    _use_authz(harness.monkeypatch, authz)
    _use_org_credentials(harness.monkeypatch)

    frames = _send_project_turn(harness)

    assert len(authz.calls) == 1
    errors = [f for f in frames if f.get("type") == "error"]
    assert len(errors) == 1, frames
    assert errors[0]["message"] == str(AuthzError("ORG_MEMBERSHIP_INACTIVE"))
    # A rejection is a rejection: not a single hermes worker may be started.
    assert harness.envs == []
    assert current_model_gateway_context() is None


# --- C1-06 -----------------------------------------------------------------


def test_c1_06_identity_is_decided_by_user_id_not_by_login_name(harness):
    """The login name and user_id are two different values. Determination recognizes only user_id; the env holds the login name."""
    authz = _Authz(kind="organization")
    _use_authz(harness.monkeypatch, authz)
    credentials, ledger = _use_org_credentials(harness.monkeypatch)
    assert _USERNAME != _USER_ID

    frames = _send_project_turn(harness)

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


# --- C1-07 -----------------------------------------------------------------
#
# These two are **seam-guard tests**, not chain tests (the chain is covered by C1-01/02/06/08).
# Deliberately called directly, because the route cannot construct this shape: `TrustedEgressContext.__post_init__`
# (`egress_context.py:36-47`) requires `requester_user_id` to be non-empty, while the route feeds the same
# `project_ctx.requester_user_id` to both the binding factory and the service, so the two sides are always equal.
# The value of defense in depth is exactly in blocking "someday upstream changes", so it must be pinned at the seam.


def _org_context() -> object:
    from novelvideo.egress_context import TrustedEgressContext

    admission = _admission(kind="organization", user_id=_USER_ID, root_task_id="rt-1")
    return TrustedEgressContext(
        envelope_id="req-rt-1",
        project_id=_PROJECT_ID,
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
async def test_c1_07a_missing_requester_user_id_is_refused_not_backfilled(harness):
    """`egress_context` non-None while `requester_user_id` is empty -> reject, must not fall back to the login name."""
    from novelvideo.chat.hermes_egress import EgressBoundaryError

    _use_authz(harness.monkeypatch, _Authz(kind="organization"))
    credentials, ledger = _use_org_credentials(harness.monkeypatch)

    async def _on_event(_event):
        return None

    with pytest.raises(EgressBoundaryError) as excinfo:
        await harness.chat_service.stream_assistant_reply(
            _USERNAME,
            _PROJECT_ID,
            "Draw a storyboard",
            _on_event,
            project_dir=harness.ctx.output_dir,
            project_state_dir=harness.ctx.state_dir,
            egress_context=_org_context(),
            requester_user_id="",
        )

    assert excinfo.value.code == "TASK_ENVELOPE_INVALID"
    # Did not fall back to username: no credentials resolved, no worker started, and nothing written to the ledger.
    assert credentials.admissions == []
    assert ledger.claims == []
    assert harness.envs == []


@pytest.mark.asyncio
async def test_c1_07b_pool_rechecks_identity_against_an_independent_source(harness):
    """The pool-layer identity re-check must have an independent source, otherwise that `_strict_admission` is `x != x`."""
    from novelvideo.chat import hermes_pool
    from novelvideo.chat.hermes_egress import (
        EgressBoundaryError,
        HermesTurnAuthorization,
    )
    from novelvideo.ports.model_credentials import RequestCredential

    context = _org_context()
    authorization = HermesTurnAuthorization.for_test(
        context=context,
        credential=RequestCredential(
            reference=context.credential,
            api_key=ORG_KEY_CANARY,
            base_url=_ORG_BASE_URL,
        ),
    )
    token = (await harness.auth_sessions.create_agent_session(
        username=_USERNAME,
        scopes=["projects:read"],
        ttl_seconds=60,
        agent_kind="hermes",
        worker_id="worker-1",
    ))
    home = Path(harness.tmp_path / "hermes-home")

    def _build(**overrides):
        kwargs = {
            "project_id": _PROJECT_ID,
            "egress_project_id": _PROJECT_ID,
            "requester_user_id": _USER_ID,
            "project_env": None,
            "authorization": authorization,
        }
        kwargs.update(overrides)
        return harness.pool._build_env(home, _USERNAME, token, **kwargs)

    # Call probe of `build_hermes_child_env`.
    # Merely asserting "TASK_ENVELOPE_INVALID was raised" cannot pin the pool's own two guards:
    # `_strict_admission` inside `build_hermes_child_env` (`hermes_egress.py:78-82`)
    # raises the **same error code** for the same input, and behavior is identical once the guard is deleted.
    # The semantics of defense in depth is "reject before reaching downstream", so what is pinned here is the **order**:
    # when the identity is incomplete, downstream must not be called at all.
    real_build_child_env = hermes_pool.build_hermes_child_env
    child_env_calls: list[dict] = []

    def _spy(**kwargs):
        child_env_calls.append(kwargs)
        return real_build_child_env(**kwargs)

    harness.monkeypatch.setattr(hermes_pool, "build_hermes_child_env", _spy)

    # Positive: with consistent sources it constructs as usual and does reach downstream.
    _assert_worker_env_is_keyless(_build())
    assert len(child_env_calls) == 1

    # Missing egress_project_id -> the S3 fail-closed guard, and it must fire **before** downstream.
    with pytest.raises(EgressBoundaryError) as missing_project:
        _build(egress_project_id=None)
    assert missing_project.value.code == "TASK_ENVELOPE_INVALID"
    assert len(child_env_calls) == 1, "build_hermes_child_env must not be called when the identity is incomplete"

    # Missing requester_user_id -> reject, must not fall back to the value of authorization.context itself.
    # It must likewise fire before downstream.
    with pytest.raises(EgressBoundaryError) as missing_user:
        _build(requester_user_id="")
    assert missing_user.value.code == "TASK_ENVELOPE_INVALID"
    assert len(child_env_calls) == 1, "build_hermes_child_env must not be called when the identity is incomplete"

    # Inconsistent sources -> reject. This is the only evidence of "the re-check no longer vouches for itself":
    # if `requester_user_id` were still taken from `authorization.context`, this would silently pass here.
    with pytest.raises(EgressBoundaryError) as mismatched_user:
        _build(requester_user_id="user-id-somebody-else")
    assert mismatched_user.value.code == "TASK_ENVELOPE_INVALID"

    with pytest.raises(EgressBoundaryError) as mismatched_project:
        _build(egress_project_id="project-somebody-else")
    assert mismatched_project.value.code == "TASK_ENVELOPE_INVALID"


# --- C1-08 -----------------------------------------------------------------


def test_c1_08_worker_prewarm_does_not_replace_the_active_org_turn(harness):
    """Concurrent prewarm reuses the keyless worker and must not change the organization credentials of the active turn."""
    _use_authz(harness.monkeypatch, _Authz(kind="organization"))
    _use_org_credentials(harness.monkeypatch)

    async def second_tab_prewarm() -> None:
        # Exactly what the route does when a second tab connects.
        await harness.chat_service.prewarm_chat_backend(
            _USERNAME, project=_PROJECT_ID
        )

    harness.stream_hook["fn"] = second_tab_prewarm

    frames = _send_project_turn(harness)

    assert [f for f in frames if f.get("type") == "error"] == [], frames
    # Credentials are now passed per turn, so same-source prewarm needs no worker rotation.
    assert len(harness.envs) == 1, harness.envs
    assert harness.auth_sessions.created == 1
    _assert_worker_env_is_keyless(harness.envs[0])
    assert harness.threads[0].gateway_api_keys == [ORG_KEY_CANARY]


# --- C1-09 -----------------------------------------------------------------


def test_c1_09_scope_does_not_leak_out_of_the_turn(harness):
    _use_authz(harness.monkeypatch, _Authz(kind="organization"))
    _use_org_credentials(harness.monkeypatch)
    assert current_model_gateway_context() is None

    frames = _send_project_turn(harness)

    assert frames[-1]["type"] == "chat.done", frames
    assert harness.observed[0] is not None
    assert current_model_gateway_context() is None


def test_c1_09b_scope_does_not_leak_on_the_exception_path(harness):
    _use_authz(harness.monkeypatch, _Authz(kind="organization"))
    _use_org_credentials(harness.monkeypatch)

    async def blow_up() -> None:
        raise RuntimeError("hermes exploded mid-turn")

    harness.stream_hook["fn"] = blow_up

    frames = _send_project_turn(harness)

    errors = [f for f in frames if f.get("type") == "error"]
    assert len(errors) == 1, frames
    assert "hermes exploded mid-turn" in errors[0]["message"]
    assert harness.observed[0] is not None
    assert current_model_gateway_context() is None


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
