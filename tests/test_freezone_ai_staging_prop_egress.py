"""C1 for OI-54 S2: request-path egress identity on freezone/ai-staging-prop.

Enter from the HTTP entry point (`create_app()` + `TestClient`), and do **not** call `_run_ai_staging_prop` directly
or the underlying gate -- the current illness is exactly "units green, chain leaking": the EG-17 unit test at `tests/test_p0_gray_execution_boundaries.py:509`
has long been green, because it hand-feeds `egress_context=` to `generate_ai_staging_prop`;
while the HTTP request path never binds the ambient context, so
the gate at `task_backend/subprocesses.py:122-128` always reads `None` and always lets it through.

About the fake `AuthzPort`: the real CE single-node implementation `LocalAuthz` (`ports/local/__init__.py:63-78`)
only ever produces `kind="local"` and **cannot** produce an organization identity, so within CE the organization branch has no way to be reached other than replacing
the authz port. The replacement point is the same seam as S0's `tests/test_request_egress_binding.py:113` and
`tests/test_p0g4c_video_egress.py:803`, and only the **identity source** is replaced:
`request_egress_scope`, the `require_direct_model_egress_allowed` gate,
the contextvar copy of `asyncio.to_thread`, and the app-level `AuthzError` handler are all real.
The vertical of an organization identity going through a real DB and real ciphertext is covered on the EE side.

This file deliberately **does not use** `model_gateway_request_scope`: the binding must be done by product code, and the test only
observes the result through `current_model_gateway_context()` (having the test bind the context itself is exactly the
false-green pattern recorded in OI-54).
"""

from __future__ import annotations

import subprocess
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from novelvideo import ports
from novelvideo.model_gateway_runtime import current_model_gateway_context
from novelvideo.ports.authz import AdmissionContext, AuthzError, BillingPrincipal
from novelvideo.ports.model_credentials import CredentialReference

_USER_ID = "u-alice"
_PROJECT_ID = "proj_demo"
_ENDPOINT = f"/api/v1/projects/{_PROJECT_ID}/freezone/ai-staging-prop"
_TASK_TYPE = "freezone_ai_staging_prop"


# --- Fake authz port (replaces only the identity source, see the module docstring) -----------------------


def _admission(*, kind: str, user_id: str, root_task_id: str) -> AdmissionContext:
    """Echo the id passed in by the caller, consistent with the two real implementations (EE port.py:169, CE LocalAuthz)."""
    organization = kind == "organization"
    return AdmissionContext(
        requester_user_id=user_id,
        billing_principal=BillingPrincipal(
            kind=kind,
            id="org-7" if organization else user_id,
        ),
        credential=CredentialReference(
            source="organization" if organization else kind,
            credential_id="credential-3",
            key_version=4,
            org_id="org-7" if organization else None,
        ),
        admission_id="admission-42",
        root_task_id=root_task_id,
        admitted_at="2026-08-13T02:03:04Z",
        membership_id="membership-5" if organization else None,
        authz_version=11,
    )


class _StubAuthz:
    def __init__(self, *, kind: str = "organization") -> None:
        self.kind = kind
        self.calls: list[tuple[str, str]] = []

    async def admit_model_task(
        self, *, user_id: str, root_task_id: str
    ) -> AdmissionContext:
        self.calls.append((user_id, root_task_id))
        return _admission(kind=self.kind, user_id=user_id, root_task_id=root_task_id)


class _RaisingAuthz:
    def __init__(self, code: str) -> None:
        self.code = code

    async def admit_model_task(
        self, *, user_id: str, root_task_id: str
    ) -> AdmissionContext:
        raise AuthzError(self.code)


def _use_authz(monkeypatch: pytest.MonkeyPatch, port: object) -> None:
    monkeypatch.setattr(ports, "get_authz_port", lambda: port)


# --- HTTP fixtures --------------------------------------------------------------


@pytest.fixture(autouse=True)
def no_real_network(monkeypatch) -> dict[str, int]:
    """Safety net: no test in this file may actually go out to the network.

    Measured in the RED phase (before the fix): the C1-02 **organization-identity** request really hit the NewAPI gateway and got back
    `status_code: 401 ... new_api_error` -- that is empirical proof of fail-open, and it also means one
    regression would make CI issue real, metered calls. Process-level interception is done here.

    It **does not replace** the C1-04 assertion: C1-04 reads exactly the counter here. `TestClient` goes through
    `ASGITransport` itself and is unaffected.
    """
    counters = {"transport": 0}

    def blocked(*_args, **_kwargs):
        counters["transport"] += 1
        raise RuntimeError("test attempted real network egress")

    async def blocked_async(*_args, **_kwargs):
        counters["transport"] += 1
        raise RuntimeError("test attempted real network egress")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", blocked)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", blocked_async)
    return counters


@pytest.fixture()
def client(monkeypatch, tmp_path) -> TestClient:
    """Real `create_app()`: the app-level `AuthzError` handler (app.py:210-233) must be in the chain."""
    from novelvideo.api.app import create_app
    from novelvideo.api.auth import get_api_user
    from novelvideo.api.routes import freezone

    project_dir = tmp_path / "project"
    project_dir.mkdir(parents=True, exist_ok=True)

    ctx = SimpleNamespace(
        project_id=_PROJECT_ID,
        requester_user_id=_USER_ID,
        owner_username="alice",
        project_name="demo",
        output_dir=str(project_dir),
        is_home_node=True,
    )

    async def fake_resolve(project: str, user: dict, *, required_role: str = "editor"):
        return ctx, "alice", "demo", project_dir, str(project_dir)

    monkeypatch.setattr(freezone, "_resolve_freezone_project", fake_resolve)

    app = create_app()
    app.dependency_overrides[get_api_user] = lambda: {
        "id": _USER_ID,
        "username": "alice",
    }
    return TestClient(app, raise_server_exceptions=False)


def _probe(monkeypatch, *, result: dict | None = None) -> dict:
    """Replace `generate_ai_staging_prop`, recording the ambient context **inside the thread**."""
    from novelvideo.api.routes import freezone

    seen: dict[str, object] = {"calls": 0, "context": "<never called>", "request": None}

    def probe(request: dict[str, object]) -> dict[str, object]:
        seen["calls"] = int(seen["calls"]) + 1
        seen["context"] = current_model_gateway_context()
        seen["request"] = dict(request)
        return result if result is not None else {"ok": True, "prop": {"id": "p1"}}

    monkeypatch.setattr(freezone, "generate_ai_staging_prop", probe)
    return seen


# --- C1-01 ------------------------------------------------------------------


def test_c1_01_organization_identity_crosses_to_thread(client, monkeypatch) -> None:
    """The binding must cross `asyncio.to_thread` (freezone.py:4542-4543) to reach the egress side."""
    _use_authz(monkeypatch, _StubAuthz(kind="organization"))
    seen = _probe(monkeypatch)

    response = client.post(_ENDPOINT, json={"user_hint": "a horse"})

    assert seen["calls"] == 1, response.json()
    context = seen["context"]
    assert context is not None
    assert context.is_organization is True
    assert context.requester_user_id == _USER_ID
    assert context.project_id == _PROJECT_ID
    assert context.task_type == _TASK_TYPE


# --- C1-02 ------------------------------------------------------------------


def test_c1_02_organization_is_denied_with_contracted_code(client, monkeypatch) -> None:
    """Real gate + real handler: under an organization identity the endpoint rejects stably, with code ORG_EGRESS_DENIED."""
    _use_authz(monkeypatch, _StubAuthz(kind="organization"))

    response = client.post(_ENDPOINT, json={"user_hint": "a horse"})
    body = response.json()

    assert response.status_code == 403, body
    assert body["ok"] is False
    assert body["data"]["error_code"] == "ORG_EGRESS_DENIED"


# --- C1-03 ------------------------------------------------------------------


def test_c1_03_denial_is_not_a_bare_502(client, monkeypatch) -> None:
    """Pin down Section 2.4: `EgressBoundaryError` is a `RuntimeError` subclass and must not be flattened into a bare 502."""
    _use_authz(monkeypatch, _StubAuthz(kind="organization"))

    response = client.post(_ENDPOINT, json={"user_hint": "a horse"})
    body = response.json()

    assert response.status_code != 502, body
    assert "data" in body and "error_code" in body["data"], body


# --- C1-04 ------------------------------------------------------------------


def test_c1_04_denied_before_any_egress_side_effect(
    client, monkeypatch, no_real_network
) -> None:
    """The pre-submit side-effect contract of `egress-inventory.md:17-23`: the rejection must happen before submission."""
    from novelvideo.director_world import staging_prop_ai

    _use_authz(monkeypatch, _StubAuthz(kind="organization"))

    counters = {"agent": 0, "run": 0, "popen": 0}

    def count_agent(*_args, **_kwargs):
        counters["agent"] += 1
        raise AssertionError("provider client must not be created")

    async def count_run(*_args, **_kwargs):
        counters["run"] += 1
        raise AssertionError("model must not be invoked")

    def count_popen(*_args, **_kwargs):
        counters["popen"] += 1
        raise AssertionError("no subprocess on this path")

    monkeypatch.setattr(staging_prop_ai, "create_staging_prop_agent", count_agent)
    monkeypatch.setattr(staging_prop_ai, "run_staging_prop_agent", count_run)
    monkeypatch.setattr(subprocess, "Popen", count_popen)

    response = client.post(_ENDPOINT, json={"user_hint": "a horse"})

    assert response.status_code == 403, response.text
    assert counters == {"agent": 0, "run": 0, "popen": 0}
    assert no_real_network["transport"] == 0


# --- C1-05 ------------------------------------------------------------------


def test_c1_05_platform_path_is_unchanged(client, monkeypatch) -> None:
    """Watchdog test: under a platform identity nothing is bound, and the endpoint behavior is byte-for-byte unchanged."""
    _use_authz(monkeypatch, _StubAuthz(kind="platform"))
    seen = _probe(monkeypatch, result={"ok": True, "prop": {"id": "p1"}})

    response = client.post(_ENDPOINT, json={"user_hint": "a horse"})
    body = response.json()

    assert response.status_code == 200, body
    assert seen["calls"] == 1
    assert seen["context"] is None
    assert body == {"ok": True, "data": {"ok": True, "prop": {"id": "p1"}}}


def test_c1_05b_platform_passes_the_real_gate(client, monkeypatch) -> None:
    """Same as above, but going through the **real** `generate_ai_staging_prop`: the real gate must let the platform identity through."""
    from novelvideo.director_world import staging_prop_ai

    _use_authz(monkeypatch, _StubAuthz(kind="platform"))
    # This is the deployment-owned platform credential path, not CE SQLite.
    monkeypatch.setenv("ST_EDITION", "ee")
    monkeypatch.setenv("MODEL_API_KEY", "platform-key")
    monkeypatch.setenv("NEWAPI_API_KEY", "platform-key")

    async def fake_run(_request, **_kwargs):
        return {"name": "a horse"}

    monkeypatch.setattr(staging_prop_ai, "run_staging_prop_agent", fake_run)

    response = client.post(
        _ENDPOINT, json={"user_hint": "let him ride a horse", "crosshair_target": {}}
    )
    body = response.json()

    assert response.status_code == 200, body
    assert body["ok"] is True
    assert body["data"]["ok"] is True


# --- C1-06 ------------------------------------------------------------------


def test_c1_06_gray_disabled_binds_nothing(client, monkeypatch) -> None:
    """Gray switch off = platform semantics (egress_binding.py:70-71): no raise, no binding."""
    _use_authz(monkeypatch, _RaisingAuthz("P0_GRAY_DISABLED"))
    seen = _probe(monkeypatch, result={"ok": True, "prop": {"id": "p1"}})

    response = client.post(_ENDPOINT, json={"user_hint": "a horse"})
    body = response.json()

    assert response.status_code == 200, body
    assert seen["calls"] == 1
    assert seen["context"] is None
    assert body == {"ok": True, "data": {"ok": True, "prop": {"id": "p1"}}}


# --- C1-07 ------------------------------------------------------------------


def test_c1_07_real_authz_denial_propagates(client, monkeypatch) -> None:
    """A rejection at the identity resolution stage is thrown up as a contractual 403, and never enters egress at all."""
    from novelvideo.api.routes import freezone

    _use_authz(monkeypatch, _RaisingAuthz("ORG_MEMBERSHIP_INACTIVE"))

    calls = {"n": 0}

    async def spy(request: dict[str, object]) -> dict[str, object]:
        calls["n"] += 1
        return {"ok": True}

    monkeypatch.setattr(freezone, "_run_ai_staging_prop", spy)

    response = client.post(_ENDPOINT, json={"user_hint": "a horse"})
    body = response.json()

    assert response.status_code == 403, body
    assert body["data"]["error_code"] == "ORG_MEMBERSHIP_INACTIVE"
    assert calls["n"] == 0


# --- C1-08 (negative: unrelated errors must not be changed by this slice) ----------------------------


def test_c1_08_unrelated_runtime_error_still_502(client, monkeypatch) -> None:
    from novelvideo.api.routes import freezone

    _use_authz(monkeypatch, _StubAuthz(kind="platform"))

    async def boom(_request: dict[str, object]) -> dict[str, object]:
        raise RuntimeError("boom")

    monkeypatch.setattr(freezone, "_run_ai_staging_prop", boom)

    response = client.post(_ENDPOINT, json={"user_hint": "a horse"})
    body = response.json()

    assert response.status_code == 502, body
    assert "boom" in str(body.get("detail"))


# --- C1-09 (negative: a false `ok` still goes through the original 502 branch) ----------------------------


def test_c1_09_not_ok_result_still_502(client, monkeypatch) -> None:
    _use_authz(monkeypatch, _StubAuthz(kind="platform"))
    _probe(monkeypatch, result={"ok": False, "error": "nope"})

    response = client.post(_ENDPOINT, json={"user_hint": "a horse"})
    body = response.json()

    assert response.status_code == 502, body
    assert "nope" in str(body.get("detail"))


# --- C1-10 (negative: the credential-stripping defense is not broken by this slice) ------------------------------


def test_c1_10_credentials_are_still_stripped(client, monkeypatch) -> None:
    """The "never accept credentials from an HTTP payload" of freezone.py:4553-4558."""
    _use_authz(monkeypatch, _StubAuthz(kind="platform"))
    seen = _probe(monkeypatch)

    response = client.post(
        _ENDPOINT,
        json={
            "api_key": "attacker-key",
            "base_url": "http://attacker.test/v1",
            "user_hint": "a horse",
        },
    )

    assert response.status_code == 200, response.json()
    forwarded = seen["request"]
    assert forwarded is not None
    assert "api_key" not in forwarded
    assert "base_url" not in forwarded
    assert forwarded["user_hint"] == "a horse"
