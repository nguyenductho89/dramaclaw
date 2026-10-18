"""Request-scoped, secret-free identity for egress adapters."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.model_credentials import CredentialReference

TRUSTED_EGRESS_CONTEXT_KEY = "__trusted_egress_context"


class TrustedRunnerEnvelope(dict[str, Any]):
    """Internal runner envelope constructed by the verified task core."""

    __slots__ = ()


@dataclass(frozen=True, slots=True)
class TrustedEgressContext:
    """Identity copied only from a verified task delivery by the task core."""

    envelope_id: str
    project_id: str
    task_type: str
    requester_user_id: str
    root_task_id: str
    admission_id: str
    admitted_at: str
    membership_id: str | None
    authz_version: int
    billing_principal: BillingPrincipal
    credential: CredentialReference

    def __post_init__(self) -> None:
        for field_name in (
            "envelope_id",
            "project_id",
            "task_type",
            "requester_user_id",
            "root_task_id",
            "admission_id",
        ):
            value = getattr(self, field_name)
            if type(value) is not str or not value:
                raise ValueError(f"{field_name} is required")
        if type(self.admitted_at) is not str:
            raise TypeError("admitted_at must be a string")
        if not self.admitted_at:
            raise ValueError("admitted_at is required")
        if self.membership_id is not None and (
            type(self.membership_id) is not str or not self.membership_id
        ):
            raise ValueError("membership_id must be a non-empty string or None")
        if type(self.authz_version) is not int or self.authz_version < 1:
            raise ValueError("authz_version must be positive")
        if type(self.billing_principal) is not BillingPrincipal:
            raise TypeError("billing_principal must be a BillingPrincipal")
        if type(self.credential) is not CredentialReference:
            raise TypeError("credential must be a CredentialReference")

    @property
    def is_organization(self) -> bool:
        return self.billing_principal.kind == "organization"


def ambient_egress_context() -> TrustedEgressContext | None:
    """Identity bound to the current request scope, used as a fallback when a call site forgets to pass `egress_context=`.

    The egress gate carries identity via an optional argument, so "platform task, allowed" and "call site forgot
    to pass the argument" collapse into the same `None` and the gate cannot tell them apart. Organization traffic
    would then reach upstream with platform credentials and be billed to the platform account, which is exactly what
    this gate exists to prevent. The task dispatcher (`task_backend/run_core.py`) already binds the identity to the
    request scope, so when kwargs carry no context the gate can fall back to it here.

    The fallback applies only when kwargs carry no context; an explicitly passed value still wins, so semantics
    are unchanged. Non-task paths such as the CLI have no binding, so this returns `None` and each call site decides
    whether to allow or reject.

    The import must stay lazy: `model_gateway_runtime` imports this module at module level.
    """

    from novelvideo.model_gateway_runtime import current_model_gateway_context

    return current_model_gateway_context()


def ambient_organization_egress_context() -> TrustedEgressContext | None:
    """Same as above, but falls back only when the scoped identity is an **organization**; otherwise returns `None`.

    Most gates only distinguish "organization / everything else", where a platform identity is equivalent to `None`.
    A few places treat "has an identity and is not an organization" as an error (for example `generate` in
    `generators/indextts2_fal.py` rejects with `ORG_EGRESS_DENIED` as soon as `self.egress_context` is not an
    organization). If the fallback injected the platform identity, platform traffic would be rejected by its own
    organization gate, so fixing fail-open would introduce a fail-closed false positive. The fallback fills only the
    organization branch; platform and personal paths stay byte-for-byte identical.
    """

    context = ambient_egress_context()
    if context is not None and context.is_organization:
        return context
    return None
