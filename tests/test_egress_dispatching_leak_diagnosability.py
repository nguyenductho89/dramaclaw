"""OI-58 layer C: when `mark_unknown` fails, that leaked row must leave a trace.

The closing shape of the two service egress paths (relay / newapi management plane) is verbatim identical:

    except Exception:
        try:
            await operations.mark_unknown(...)
        except Exception:
                        pass          # <- here
        raise XxxFailed() from None

That empty `except` is the direct reason this fault went **unnoticed**. `mark_unknown` raises on the real DB
P0001 (the service principal has no transition authorization, see OI-58 layer A); the exception is swallowed by these three lines, the row stays
at `dispatching` forever, and the log only has a vague `XxxFailed` - "the ledger cannot be written" and "the upstream call failed"
are two completely different things that look identical from the outside.

**The swallowing itself is correct and stays.** The egress already failed; failing to write the ledger should not turn it into another kind of failure;
convergence is backstopped by the in-DB reaper (EE `0066_egress_operation_reaper`). What must change is that it is **silent**:
the reaper only reaches that row after a whole lease period (default 60 minutes), and until then the only clue is this log line.

Guardrail (carried over from OI-45, `test_org_relay_failure_diagnosability.py`): the log carries only
`operation_id` / `capability` / the exception type name. The receipt is the write authorization of the row; printing it is like taping the key
to the wall; the swallowed exception itself may carry a signed URL or a secret, so only the type name is taken, never `str(exc)`.

Assertions are on `caplog.text`, not on record attributes: the default formatter does not print `extra=` (the whole CE tree
uses it in only one place), and asserting on attributes would stay green even when the log printed nothing at all.
"""

from __future__ import annotations

import logging

import pytest

from novelvideo.egress_context import TrustedEgressContext
from novelvideo.newapi_provisioner import (
    NewApiAdminServiceIdentity,
    ServiceInvocationFailed as NewApiInvocationFailed,
    run_newapi_admin_operation,
)
from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.egress_operations import (
    OperationClaimResult,
    OperationSnapshot,
    OperationState,
)
from novelvideo.ports.model_credentials import CredentialReference
from novelvideo.storage.media_relay import (
    ServiceInvocationFailed,
    StorageRelayIdentity,
    relay_tenant_image_bytes,
)

CANARY = "transition-token-and-signed-url-canary"
LEDGER_LOGGER = "novelvideo.ports.egress_operations"


class _Operations:
    """Claimable but unable to write a terminal state - the shape of the service principal on the real DB (before OI-58 layer A)."""

    def __init__(self, *, unknown_error: BaseException | None = None) -> None:
        self._unknown_error = unknown_error
        self.unknown_calls: list[dict] = []

    async def claim(self, *, spec):
        return OperationClaimResult(
            won=True,
            operation=OperationSnapshot(
                operation_id="operation-oi58",
                operation_key=spec.operation_key,
                state=OperationState.DISPATCHING,
                version=1,
            ),
            transition_token=CANARY,
        )

    async def mark_unknown(self, **kwargs):
        self.unknown_calls.append(kwargs)
        if self._unknown_error is not None:
            raise self._unknown_error
        return OperationSnapshot(
            operation_id=kwargs["operation_id"],
            operation_key="0" * 64,
            state=OperationState.UNKNOWN,
            version=2,
        )

    async def mark_accepted(self, **kwargs):  # pragma: no cover - this file only exercises the failure path
        raise AssertionError("the invocation failed; nothing may be accepted")

    async def mark_completed(self, **kwargs):  # pragma: no cover - same as above
        raise AssertionError("the invocation failed; nothing may be completed")

    async def mark_rejected_before_submit(self, **kwargs):  # pragma: no cover - same as above
        raise AssertionError("unused")


class _ExplodingRelay:
    def upload_bytes(self, *_args, **_kwargs):
        raise RuntimeError(f"PUT https://bucket.invalid/x?sig={CANARY} -> 403")


def _org_context() -> TrustedEgressContext:
    return TrustedEgressContext(
        envelope_id="envelope-oi58",
        project_id="project-oi58",
        task_type="image.edit",
        requester_user_id="user-oi58",
        root_task_id="root-oi58",
        admission_id="admission-oi58",
        admitted_at="2026-08-12T04:05:00Z",
        membership_id="membership-oi58",
        authz_version=4,
        billing_principal=BillingPrincipal(kind="organization", id="org-oi58"),
        credential=CredentialReference(
            source="organization",
            credential_id="credential-oi58",
            key_version=9,
            org_id="org-oi58",
        ),
    )


async def _drive_relay(operations) -> None:
    context = _org_context()
    await relay_tenant_image_bytes(
        b"image-bytes",
        object_id="object-oi58",
        context=context,
        identity=StorageRelayIdentity(
            credential_id="svc-media-relay",
            credential_version=1,
            organization_id=context.billing_principal.id,
            project_id=context.project_id,
        ),
        operations=operations,
        relay=_ExplodingRelay(),
    )


async def _drive_newapi_admin(operations) -> None:
    def _boom():
        raise RuntimeError(f"admin call failed with token {CANARY}")

    await run_newapi_admin_operation(
        identity=NewApiAdminServiceIdentity(
            credential_id="svc-newapi-admin",
            credential_version=1,
            admin_base_url="https://newapi.invalid",
        ),
        admin_base_url="https://newapi.invalid",
        capability="gateway.provisioning.channel.create",
        business_task_id="task-oi58",
        request={"channel": "oi58"},
        operations=operations,
        invoke=_boom,
    )


# `capability` is hard-coded per case rather than read back from the driver: these two strings are the only thing in the log that tells
# "which service path leaked" apart; reading them back from the code under test would have it prove itself.
CALL_SITES = [
    pytest.param(
        _drive_relay, ServiceInvocationFailed, "storage.media.relay", id="relay"
    ),
    pytest.param(
        _drive_newapi_admin,
        NewApiInvocationFailed,
        "gateway.provisioning.channel.create",
        id="newapi-admin",
    ),
]


@pytest.mark.asyncio
@pytest.mark.parametrize(("drive", "expected_error", "capability"), CALL_SITES)
async def test_a_swallowed_mark_unknown_names_the_operation_it_left_behind(
    caplog, drive, expected_error, capability
):
    """The row is stuck at `dispatching`; the log must say which row, which capability, and what blocked it."""

    operations = _Operations(
        unknown_error=RuntimeError("egress operation transition is invalid")
    )

    with caplog.at_level(logging.WARNING, logger=LEDGER_LOGGER):
        with pytest.raises(expected_error):
            await drive(operations)

    assert operations.unknown_calls, "mark_unknown must still be attempted - the reaper is not a replacement for it"
    assert "operation-oi58" in caplog.text
    assert capability in caplog.text
    assert "RuntimeError" in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize(("drive", "expected_error", "capability"), CALL_SITES)
async def test_neither_the_transition_token_nor_the_upstream_message_reaches_the_log(
    caplog, drive, expected_error, capability
):
    """Neither the receipt nor the body of the swallowed exception leaves the process (OI-45 guardrail).

    The canary here is both the `transition_token` **and** the signed URL in the upstream exception body - one
    assertion pins both leak surfaces.
    """

    operations = _Operations(unknown_error=RuntimeError(f"denied for {CANARY}"))

    with caplog.at_level(logging.WARNING, logger=LEDGER_LOGGER):
        with pytest.raises(expected_error):
            await drive(operations)

    assert caplog.text, "the previous case guarantees there is a log; this one only checks that it carries no secret"
    assert CANARY not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize(("drive", "expected_error", "capability"), CALL_SITES)
async def test_a_mark_unknown_that_succeeded_says_nothing(
    caplog, drive, expected_error, capability
):
    """Successful convergence is the normal path. Warning on it too would turn this log into noise."""

    operations = _Operations()

    with caplog.at_level(logging.WARNING, logger=LEDGER_LOGGER):
        with pytest.raises(expected_error):
            await drive(operations)

    assert operations.unknown_calls
    assert caplog.text == ""


@pytest.mark.asyncio
@pytest.mark.parametrize(("drive", "expected_error", "capability"), CALL_SITES)
async def test_the_swallowing_itself_is_unchanged(
    caplog, drive, expected_error, capability
):
    """This change only adds logging: even if the ledger cannot be written, the failure the caller sees must **still** not change.

    Turning this into a re-raise would split one egress failure into two kinds of error depending on "whether the ledger could be written",
    and the caller can do nothing about it.
    """

    operations = _Operations(unknown_error=RuntimeError("boom"))

    with pytest.raises(expected_error) as exc_info:
        await drive(operations)

    # `from None`: the swallowed exception must not escape by hanging on __cause__ (it may carry a secret).
    assert exc_info.value.__cause__ is None
