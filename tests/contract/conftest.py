"""Shared test wiring for the contract layer."""

from datetime import datetime, timezone
from itertools import count

import pytest

from novelvideo.ports.authz import AdmissionContext, BillingPrincipal
from novelvideo.ports.local.tasks import InlineTaskBackend
from novelvideo.ports.model_credentials import CredentialReference
from novelvideo.task_backend.consumer import TaskEnvelopeConsumer
from novelvideo.task_backend.producer import TaskEnvelopeProducer

_ENVELOPE_NOW = datetime(2026, 8, 3, 4, 5, 6, tzinfo=timezone.utc)
_ENVELOPE_SIGNING_KEY = b"contract-task-envelope-test-key1"


class _StubAuthz:
    async def admit_model_task(self, *, user_id: str, root_task_id: str):
        return AdmissionContext(
            requester_user_id=user_id,
            billing_principal=BillingPrincipal(kind="local", id=user_id),
            credential=CredentialReference("local", "local-newapi", 1),
            admission_id=f"admission-{root_task_id}",
            root_task_id=root_task_id,
            admitted_at="2026-08-03T04:05:00Z",
            authz_version=1,
        )


@pytest.fixture
def signed_inline_backend():
    """Build an InlineTaskBackend with a complete signing chain.

    The producer and consumer are both real implementations, sharing the test keyring and a fixed clock; only authz
    is a stub -- signing and verification really run, it is not a stand-in that bypasses validation.

    It must be wired up: when the consumer is None, InlineTaskBackend by design directly judges
    InvalidTaskEnvelope (fail-closed), so a bare-constructed backend executes no tasks and a case would only hang
    and time out while waiting. The only production construction point, ports/local/__init__.py, necessarily passes both as well.
    """

    def _build() -> InlineTaskBackend:
        authz = _StubAuthz()
        envelope_ids = count(1)
        keyring = {"contract-v1": _ENVELOPE_SIGNING_KEY}
        producer = TaskEnvelopeProducer(
            authz=authz,
            active_key_id="contract-v1",
            keyring=keyring,
            clock=lambda: _ENVELOPE_NOW,
            envelope_id_factory=lambda: f"contract-envelope-{next(envelope_ids)}",
        )
        consumer = TaskEnvelopeConsumer(
            keyring=keyring,
            authz=authz,
            clock=lambda: _ENVELOPE_NOW,
        )
        return InlineTaskBackend(producer=producer, consumer=consumer)

    return _build
