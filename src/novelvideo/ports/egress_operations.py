"""Minimal durable egress operation contracts."""

from __future__ import annotations

import hashlib
import json
import logging
import math
from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol

logger = logging.getLogger(__name__)

_ERROR_MESSAGES = {
    "EGRESS_OPERATION_CONFLICT": "egress operation conflicts with an existing claim",
    "EGRESS_OPERATION_INVALID_TRANSITION": "egress operation transition is invalid",
}


def _require_non_empty_string(value: Any, field_name: str) -> None:
    if type(value) is not str:
        raise TypeError(f"{field_name} must be a string")
    if not value.strip():
        raise ValueError(f"{field_name} is required")


def _validate_json_value(value: Any) -> None:
    if value is None or type(value) in {str, bool, int}:
        return
    if type(value) is float:
        if math.isfinite(value):
            return
        raise ValueError("request must be canonical JSON")
    if type(value) is list:
        for item in value:
            _validate_json_value(item)
        return
    if type(value) is dict:
        for key, item in value.items():
            if type(key) is not str:
                raise ValueError("request must be canonical JSON")
            _validate_json_value(item)
        return
    raise ValueError("request must be canonical JSON")


def _canonical_json(value: Any) -> bytes:
    _validate_json_value(value)
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
            allow_nan=False,
        )
    except (TypeError, ValueError):
        raise ValueError("request must be canonical JSON") from None
    return encoded.encode("utf-8")


def canonical_request_digest(request: Any) -> str:
    """Return a deterministic SHA-256 digest for an exact JSON request."""

    return hashlib.sha256(_canonical_json(request)).hexdigest()


class OperationState(str, Enum):
    DISPATCHING = "dispatching"
    REJECTED_BEFORE_SUBMIT = "rejected_before_submit"
    ACCEPTED = "accepted"
    COMPLETED = "completed"
    UNKNOWN = "unknown"


class HandleKind(str, Enum):
    """What kind of handle an outbound operation **can obtain** -- declared by the caller at claim time.

    This is a discriminator: which shapes `provider_job_id` / `result_ref` may take in a terminal state is
    decided by the kind, and the DB-side `egress_operations_output_check` judges accordingly. Previously there was only a "non-empty"
    check, which a placeholder string could satisfy, amounting to no guarantee at all.
    """

    PROVIDER_JOB = "provider_job"
    """Has an upstream async job: from accepted on, the upstream job id must be kept, and completed also needs a result reference."""

    LOCAL_RESULT = "local_result"
    """No upstream job, but a real result reference (e.g. the path of synchronously written audio)."""

    NONE = "none"
    """Purely service-internal side effect: neither column has a real value to fill, so both columns must be NULL."""


class EgressOperationError(RuntimeError):
    """Stable operation failure without database or provider details."""

    def __init__(self, code: str, _unsafe_detail: str | None = None) -> None:
        if code not in _ERROR_MESSAGES:
            raise ValueError("unsupported egress operation error")
        super().__init__(_ERROR_MESSAGES[code])
        self.code = code


@dataclass(frozen=True)
class OperationSpec:
    organization_id: str
    project_id: str
    root_task_id: str
    business_task_id: str
    capability: str
    credential_id: str
    credential_version: int
    request_digest: str
    # Required, no default: a default would collapse "I declare it has no handle" and "I forgot to write it" into the same
    # value, and the new constraint would degrade back into the OI-49 kind of "reads like a guarantee".
    handle_kind: HandleKind

    def __post_init__(self) -> None:
        for field_name in (
            "organization_id",
            "project_id",
            "root_task_id",
            "business_task_id",
            "capability",
            "credential_id",
            "request_digest",
        ):
            _require_non_empty_string(getattr(self, field_name), field_name)
        if type(self.credential_version) is not int:
            raise TypeError("credential_version must be a positive integer")
        if self.credential_version < 1:
            raise ValueError("credential_version must be positive")
        if type(self.handle_kind) is not HandleKind:
            raise TypeError("handle_kind must be a HandleKind")

    @property
    def operation_key(self) -> str:
        # handle_kind is deliberately **not** part of the identity: it describes what handle this operation leaves behind, not which
        # operation it is. Including it would make replay of existing rows mismatch wholesale.
        identity = {
            "organization_id": self.organization_id,
            "project_id": self.project_id,
            "root_task_id": self.root_task_id,
            "business_task_id": self.business_task_id,
            "capability": self.capability,
        }
        return hashlib.sha256(_canonical_json(identity)).hexdigest()


@dataclass(frozen=True)
class OperationSnapshot:
    operation_id: str
    operation_key: str
    state: OperationState
    version: int

    def __post_init__(self) -> None:
        _require_non_empty_string(self.operation_id, "operation_id")
        _require_non_empty_string(self.operation_key, "operation_key")
        if type(self.state) is not OperationState:
            raise TypeError("state must be an OperationState")
        if type(self.version) is not int or self.version < 1:
            raise ValueError("version must be positive")


@dataclass(frozen=True)
class OperationClaimResult:
    won: bool
    operation: OperationSnapshot
    transition_token: str | None = None

    def __post_init__(self) -> None:
        if type(self.won) is not bool:
            raise TypeError("won must be a boolean")
        if type(self.operation) is not OperationSnapshot:
            raise TypeError("operation must be an OperationSnapshot")
        if self.won:
            _require_non_empty_string(self.transition_token, "transition_token")
        elif self.transition_token is not None:
            raise ValueError("existing operations cannot expose transition_token")


class EgressOperationPort(Protocol):
    async def claim(self, *, spec: OperationSpec) -> OperationClaimResult: ...

    async def mark_rejected_before_submit(
        self,
        *,
        operation_id: str,
        transition_token: str,
        expected_version: int,
    ) -> OperationSnapshot: ...

    async def mark_accepted(
        self,
        *,
        operation_id: str,
        transition_token: str,
        expected_version: int,
        # None is not "forgot to pass": the kind is written on the row and the DB is authoritative; `local_result` and `none`
        # simply have no upstream job id to fill. This is not the same thing as the "optional parameter as identity carrier" condemned by OI-48
        # -- there None meant lost information, here None is a declaration checked by a constraint.
        provider_job_id: str | None,
        requester_user_id: str | None = None,
        membership_id: str | None = None,
        authz_version: int | None = None,
    ) -> OperationSnapshot: ...

    async def mark_completed(
        self,
        *,
        operation_id: str,
        transition_token: str,
        expected_version: int,
        result_ref: str | None,
    ) -> OperationSnapshot: ...

    async def mark_unknown(
        self,
        *,
        operation_id: str,
        transition_token: str,
        expected_version: int,
    ) -> OperationSnapshot: ...


async def record_unknown_outcome(
    operations: EgressOperationPort,
    *,
    claim: OperationClaimResult,
    capability: str,
) -> None:
    """After an outbound call fails, make a best effort to converge the row to `unknown`; if it cannot, log a line and never change control flow.

    It lives here rather than at each call site because the epilogue code of the three service egress paths (relay / newapi admin plane / backup sync)
    was originally **verbatim identical**, and their own comments already record that the same class of missed check was hit once
    ("previously jumped straight from `dispatching` to completed"). Copying the same passage three times means missing two of the three edits.

    **Does not raise**: the outbound call has already failed, and being unable to write the ledger should not turn it into a different failure -- the caller can do nothing about the ledger,
    and splitting into two kinds of errors would only make it harder for upper layers. Row convergence is backstopped by the in-DB reaper (EE
    `0066_egress_operation_reaper`), but that takes a whole lease period, and until then this log line is the only clue.

    The log emits only `operation_id` / `capability` / the exception type name (OI-45 guardrail): the receipt is this row's write
    authorization, and the swallowed exception itself may carry signed URLs or secrets, so take the type rather than `str(exc)`.
    """

    try:
        await operations.mark_unknown(
            operation_id=claim.operation.operation_id,
            transition_token=claim.transition_token,
            expected_version=claim.operation.version,
        )
    except Exception as error:
        # Fields go into the message rather than `extra=`: the default formatter does not print extra, so such a log would read
        # no differently from today's "nothing at all".
        logger.warning(
            "egress operation %s (%s) stays in dispatching: "
            "mark_unknown failed with %s; it will be collected by the reaper",
            claim.operation.operation_id,
            capability,
            type(error).__name__,
        )
