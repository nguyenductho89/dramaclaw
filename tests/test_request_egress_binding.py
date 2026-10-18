"""C1 for the request-path trusted egress context factory (OI-54 S0).

This is a **factory-layer** unit test; per handoff prompt §4 a fake `AuthzPort` is allowed here; the chain layer
(S1/S2/S4/S5) forbids mocking authz, which is outside the scope of this slice.

This file deliberately **does not use** `model_gateway_request_scope`: the binding must be done by product code,
and the tests observe the result only through `current_model_gateway_context()`. Binding the context in the test itself is
one of the fake-green patterns recorded in OI-54 (EE `tests/b2b/test_p0g4k_grid_family_egress_integration.py:305`).

The fake port always **echoes** the `user_id` / `root_task_id` passed in by the caller, consistent with the two real implementations:
`_context_from_facts(..., user_id=, root_task_id=)` of the EE-side authz port implementation,
and `LocalAuthz` of CE `src/novelvideo/ports/local/__init__.py:67-79`.
Only C1-9 / C1-10 deliberately break the echo, to pin down the validation branch.
"""

from __future__ import annotations

import pytest

from novelvideo import ports
from novelvideo.api import egress_binding
from novelvideo.api.egress_binding import (
    build_request_egress_context,
    request_egress_scope,
)
from novelvideo.egress_context import TrustedEgressContext
from novelvideo.model_gateway_runtime import current_model_gateway_context
from novelvideo.ports.authz import (
    AdmissionContext,
    AuthzError,
    AuthzServiceFault,
    AuthzServiceUnavailable,
    BillingPrincipal,
)
from novelvideo.ports.local import LocalAuthz
from novelvideo.ports.model_credentials import CredentialReference

_USER_ID = "user-1"
_PROJECT_ID = "project-9"
_TASK_TYPE = "freezone_image_mark_detect"


def _admission(
    *,
    kind: str,
    user_id: str,
    root_task_id: str,
) -> AdmissionContext:
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


class _RecordingAuthz:
    """Echoes the caller's identity back, like both production implementations."""

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
        # Simulate the real implementation: the underlying error is converted to AuthzError inside the except block,
        # so the original exception hangs on `__context__` (EE `admission_repository.py:53-54`
        # mapping any PostgresError to ORG_AUTHZ_STALE is exactly this shape).
        try:
            raise RuntimeError('relation "users" does not exist -- raw pg detail')
        except RuntimeError as exc:
            raise AuthzError(self.code) from exc


class _MismatchingAuthz:
    """Returns an admission that disagrees with what was asked for."""

    def __init__(self, *, user_id: str | None = None, root_task_id: str | None = None):
        self._user_id = user_id
        self._root_task_id = root_task_id

    async def admit_model_task(
        self, *, user_id: str, root_task_id: str
    ) -> AdmissionContext:
        return _admission(
            kind="organization",
            user_id=self._user_id or user_id,
            root_task_id=self._root_task_id or root_task_id,
        )


class _SequencedAuthz:
    def __init__(self, outcomes) -> None:
        self._outcomes = iter(outcomes)
        self.calls: list[tuple[str, str]] = []

    async def admit_model_task(
        self, *, user_id: str, root_task_id: str
    ) -> AdmissionContext:
        self.calls.append((user_id, root_task_id))
        outcome = next(self._outcomes)
        if isinstance(outcome, BaseException):
            raise outcome
        return _admission(
            kind="organization",
            user_id=user_id,
            root_task_id=root_task_id,
        )


def _use(monkeypatch: pytest.MonkeyPatch, port: object) -> None:
    # Same style as `tests/test_p0g4c_video_egress.py:803`; the module under test lazily fetches the port inside the function body
    # following the precedent of `generators/video_generator.py:2733`.
    monkeypatch.setattr(ports, "get_authz_port", lambda: port)


async def _build() -> TrustedEgressContext | None:
    return await build_request_egress_context(
        requester_user_id=_USER_ID,
        project_id=_PROJECT_ID,
        task_type=_TASK_TYPE,
    )


def _disable_retry_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    async def no_wait(_delay: float) -> None:
        return None

    monkeypatch.setattr(egress_binding, "_AUTHZ_RETRY_SLEEP", no_wait)
    monkeypatch.setattr(egress_binding, "_AUTHZ_RETRY_RANDOM", lambda: 0.0)


# --- C1-1 ------------------------------------------------------------------


async def test_c1_01_organization_admission_maps_every_field(monkeypatch):
    port = _RecordingAuthz(kind="organization")
    _use(monkeypatch, port)

    context = await _build()

    assert type(context) is TrustedEgressContext
    assert len(port.calls) == 1
    called_user_id, root_task_id = port.calls[0]
    assert called_user_id == _USER_ID
    admission = _admission(
        kind="organization", user_id=_USER_ID, root_task_id=root_task_id
    )
    # The 11 required fields correspond one by one (the field table of `egress_context.py:24-34`).
    assert context.envelope_id == f"req-{root_task_id}"
    assert context.project_id == _PROJECT_ID
    assert context.task_type == _TASK_TYPE
    assert context.requester_user_id == admission.requester_user_id
    assert context.root_task_id == admission.root_task_id
    assert context.admission_id == admission.admission_id
    assert context.admitted_at == admission.admitted_at
    assert context.membership_id == admission.membership_id
    assert context.authz_version == admission.authz_version
    assert context.billing_principal == admission.billing_principal
    assert context.credential == admission.credential
    assert context.is_organization is True


# --- C1-2 ------------------------------------------------------------------


async def test_c1_02_platform_admission_returns_none(monkeypatch):
    _use(monkeypatch, _RecordingAuthz(kind="platform"))

    assert await _build() is None


# --- C1-3 ------------------------------------------------------------------


async def test_c1_03_ce_local_admission_returns_none(monkeypatch):
    # The real CE single-machine fallback implementation, not a hand-rolled fake port.
    _use(monkeypatch, LocalAuthz())

    assert await _build() is None


# --- C1-4 ------------------------------------------------------------------


async def test_c1_04_gray_disabled_returns_none(monkeypatch):
    _use(monkeypatch, _RaisingAuthz("P0_GRAY_DISABLED"))

    assert await _build() is None


# --- C1-5 ------------------------------------------------------------------


async def test_c1_05_membership_inactive_is_raised(monkeypatch):
    _use(monkeypatch, _RaisingAuthz("ORG_MEMBERSHIP_INACTIVE"))

    with pytest.raises(AuthzError) as excinfo:
        await _build()

    assert excinfo.value.code == "ORG_MEMBERSHIP_INACTIVE"


# --- C1-6 ------------------------------------------------------------------


async def test_c1_06_model_access_denied_is_raised_not_admitted(monkeypatch):
    # Squashing to None would build yet another OI-48-shaped fail-open: a real rejection would be read as "not an organization, allow".
    _use(monkeypatch, _RaisingAuthz("MODEL_ACCESS_DENIED"))

    with pytest.raises(AuthzError) as excinfo:
        await _build()

    assert excinfo.value.code == "MODEL_ACCESS_DENIED"


# --- C1-7 ------------------------------------------------------------------


async def test_c1_07_authz_stale_is_raised_not_downgraded(monkeypatch):
    # Consistent with today's semantics of `task_backend/producer.py:137-138` for all users; it must not be "kindly" downgraded.
    _use(monkeypatch, _RaisingAuthz("ORG_AUTHZ_STALE"))

    with pytest.raises(AuthzError) as excinfo:
        await _build()

    assert excinfo.value.code == "ORG_AUTHZ_STALE"


# --- C1-8 ------------------------------------------------------------------


async def test_c1_08_raised_authz_error_carries_no_exception_chain(monkeypatch):
    _use(monkeypatch, _RaisingAuthz("ORG_AUTHZ_STALE"))

    with pytest.raises(AuthzError) as excinfo:
        await _build()

    exc = excinfo.value
    # `__cause__` alone is not enough to discriminate: `raise AuthzError(code)` inside an except block (without from None)
    # likewise gives `__cause__ is None`, but the original PG error text hangs on `__context__` and leaks out with the exception.
    # Asserting both together is what truly pins `producer.py:137-138`'s "raise ... from None after leaving the except block".
    assert exc.__cause__ is None
    assert exc.__context__ is None
    assert exc.__suppress_context__ is True
    assert "does not exist" not in str(exc)


async def test_request_authz_read_recovers_within_short_retry_budget(monkeypatch):
    port = _SequencedAuthz(
        [
            AuthzServiceUnavailable(),
            AuthzServiceUnavailable(),
            object(),
        ]
    )
    _use(monkeypatch, port)
    _disable_retry_wait(monkeypatch)

    context = await _build()

    assert type(context) is TrustedEgressContext
    assert len(port.calls) == 3
    assert {root_task_id for _, root_task_id in port.calls} == {context.root_task_id}


async def test_request_authz_retry_exhaustion_preserves_service_subtype(monkeypatch):
    failures = [
        AuthzServiceUnavailable(),
        AuthzServiceUnavailable(),
        AuthzServiceUnavailable(),
    ]
    port = _SequencedAuthz(failures)
    _use(monkeypatch, port)
    _disable_retry_wait(monkeypatch)

    with pytest.raises(AuthzServiceUnavailable) as caught:
        await _build()

    assert caught.value is failures[-1]
    assert caught.value.http_status == 503
    assert len(port.calls) == 3
    assert len({root_task_id for _, root_task_id in port.calls}) == 1


async def test_request_authz_service_fault_fails_fast_with_http_semantics(monkeypatch):
    failure = AuthzServiceFault()
    port = _SequencedAuthz([failure])
    _use(monkeypatch, port)
    _disable_retry_wait(monkeypatch)

    with pytest.raises(AuthzServiceFault) as caught:
        await _build()

    assert caught.value is failure
    assert caught.value.http_status == 503
    assert len(port.calls) == 1


# --- C1-9 ------------------------------------------------------------------


async def test_c1_09_requester_mismatch_raises_instead_of_none(monkeypatch):
    _use(monkeypatch, _MismatchingAuthz(user_id="someone-else"))

    with pytest.raises(Exception) as excinfo:
        await _build()

    # `None` has only one meaning: a non-organization identity. It never means "something went wrong".
    assert excinfo.value is not None


# --- C1-10 -----------------------------------------------------------------


async def test_c1_10_root_task_id_mismatch_raises_instead_of_none(monkeypatch):
    _use(monkeypatch, _MismatchingAuthz(root_task_id="not-the-generated-id"))

    with pytest.raises(Exception) as excinfo:
        await _build()

    assert excinfo.value is not None


# --- C1-11 -----------------------------------------------------------------


async def test_c1_11_envelope_id_is_derived_and_unique_per_request(monkeypatch):
    port = _RecordingAuthz(kind="organization")
    _use(monkeypatch, port)

    first = await _build()
    second = await _build()

    assert first is not None and second is not None
    assert first.envelope_id == f"req-{first.root_task_id}"
    assert second.envelope_id == f"req-{second.root_task_id}"
    # The downstream `egress_operations` claim relies on envelope_id for replay protection,
    # so it must not be reused per connection or per session.
    assert first.envelope_id != second.envelope_id
    assert first.root_task_id != second.root_task_id
    assert len(port.calls) == 2


# --- C1-12 -----------------------------------------------------------------


async def test_c1_12_scope_binds_organization_identity_and_unbinds_on_exit(monkeypatch):
    _use(monkeypatch, _RecordingAuthz(kind="organization"))
    assert current_model_gateway_context() is None

    async with request_egress_scope(
        requester_user_id=_USER_ID,
        project_id=_PROJECT_ID,
        task_type=_TASK_TYPE,
    ) as context:
        assert type(context) is TrustedEgressContext
        assert current_model_gateway_context() is context

    assert current_model_gateway_context() is None

    # The platform path must be byte-for-byte unchanged: nothing is bound under a non-organization identity.
    _use(monkeypatch, _RecordingAuthz(kind="platform"))
    async with request_egress_scope(
        requester_user_id=_USER_ID,
        project_id=_PROJECT_ID,
        task_type=_TASK_TYPE,
    ) as platform_context:
        assert platform_context is None
        assert current_model_gateway_context() is None

    assert current_model_gateway_context() is None


# --- C1-13 -----------------------------------------------------------------


async def test_c1_13_scope_does_not_leak_context_var_on_exception(monkeypatch):
    _use(monkeypatch, _RecordingAuthz(kind="organization"))
    assert current_model_gateway_context() is None

    class _Boom(RuntimeError):
        pass

    with pytest.raises(_Boom):
        async with request_egress_scope(
            requester_user_id=_USER_ID,
            project_id=_PROJECT_ID,
            task_type=_TASK_TYPE,
        ) as context:
            # It must assert that "the organization identity was indeed bound", and not merely write `is context`:
            # when nothing is bound `None is None` also holds, in which case this case provides not
            # a single line of evidence for non-leakage (a tautology).
            assert type(context) is TrustedEgressContext
            assert current_model_gateway_context() is context
            raise _Boom("caller blew up inside the scope")

    assert current_model_gateway_context() is None
