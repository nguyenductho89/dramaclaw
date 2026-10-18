"""Handle kinds of `egress_operations`: make "illegal states" unrepresentable instead of papering over with placeholder strings.

`egress_operations_output_check` at `0039_p0_gray_egress_operations.py:138-146`
reads like "egress must leave an upstream handle", but actually only checks `btrim(...) <> ''`. So four write sites could satisfy it by stuffing in placeholder
strings: `"sync-audio"` at `tts_generator.py:141`, `"service-operation-completed"` on the two service paths,
and `model_gateway_runtime.py` using `operation_id` as a self-referencing
handle. The constraint, the write sites, and a green case that pinned the placeholder as the expected value vouched for each other - the guarantee was fake.

The fix is to add a kind column `handle_kind` to the row, one of three, each with its terminal-state shape enforced by a DB discriminated constraint:

| handle_kind    | accepted                | completed                            |
|----------------|-------------------------|--------------------------------------|
| `provider_job` | provider_job_id non-empty | provider_job_id non-empty + result_ref non-empty |
| `local_result` | provider_job_id IS NULL | provider_job_id NULL + result_ref non-empty |
| `none`         | provider_job_id IS NULL | both columns IS NULL                  |

The kind is declared **at claim time**: the shape is the caller's own business, known at claim time, and the constraint must hold
from row creation. The field is **required with no default** - a default would collapse "I declare it has no handle" and "I forgot to write it"
into the same value, which is exactly the lesson of OI-48.

It also fixes a real defect nobody had hit before this file: the two service paths call
`mark_completed` directly in the `dispatching` state, while `transition_egress_operation` at `0039:294-338` requires
`completed` to come from `accepted` - which always raises P0001 on the real DB. It stayed green only because the stand-in
`FakeOperations` had no `mark_accepted` at all and modeled no state machine. So the stand-in must be completed too:
without a state machine in the stand-in, the new constraint is still bypassed, which would replay OI-49.
"""

from __future__ import annotations

import ast
import inspect
from pathlib import Path

import pytest

from novelvideo.ports.egress_operations import (
    EgressOperationError,
    HandleKind,
    OperationClaimResult,
    OperationSnapshot,
    OperationSpec,
    OperationState,
)

SRC_ROOT = Path(__file__).resolve().parents[1] / "src" / "novelvideo"

# The two placeholder strings that were written into the DB before `0039`. They must not return once cleared.
PLACEHOLDER_HANDLES = ("sync-audio", "service-operation-completed")


def _spec(**overrides) -> OperationSpec:
    values = {
        "organization_id": "org_1",
        "project_id": "project_1",
        "root_task_id": "root_1",
        "business_task_id": "episode:1:beat:2:image",
        "capability": "image.generate",
        "credential_id": "credential_1",
        "credential_version": 3,
        "request_digest": "a" * 64,
        "handle_kind": HandleKind.PROVIDER_JOB,
    }
    values.update(overrides)
    return OperationSpec(**values)


class StateMachineOperations:
    """A stand-in with a real state machine: `completed` can only come from `accepted`, the same rule as the real definer.

    The SECURITY DEFINER function at `0039:294-338` judges exactly this way. If the stand-in is not built to match, illegal transitions
    on the service path are never seen in tests - which is exactly why this defect survived to today."""
    """

    def __init__(self) -> None:
        self.state = OperationState.DISPATCHING
        self.version = 1
        self.claims: list[OperationSpec] = []
        self.transitions: list[tuple[str, dict]] = []

    async def claim(self, *, spec: OperationSpec) -> OperationClaimResult:
        self.claims.append(spec)
        return OperationClaimResult(
            won=True,
            operation=OperationSnapshot(
                operation_id="op-1",
                operation_key=spec.operation_key,
                state=self.state,
                version=self.version,
            ),
            transition_token="transition-1",
        )

    def _apply(
        self,
        verb: str,
        kwargs: dict,
        *,
        allowed_from: set[OperationState],
        target: OperationState,
    ) -> OperationSnapshot:
        if self.state not in allowed_from:
            raise EgressOperationError("EGRESS_OPERATION_INVALID_TRANSITION")
        if kwargs["expected_version"] != self.version:
            raise EgressOperationError("EGRESS_OPERATION_INVALID_TRANSITION")
        self.transitions.append((verb, dict(kwargs)))
        self.state = target
        self.version += 1
        return OperationSnapshot(
            operation_id=kwargs["operation_id"],
            operation_key="operation-key",
            state=target,
            version=self.version,
        )

    async def mark_accepted(self, **kwargs) -> OperationSnapshot:
        return self._apply(
            "accepted",
            kwargs,
            allowed_from={OperationState.DISPATCHING},
            target=OperationState.ACCEPTED,
        )

    async def mark_completed(self, **kwargs) -> OperationSnapshot:
        return self._apply(
            "completed",
            kwargs,
            allowed_from={OperationState.ACCEPTED},
            target=OperationState.COMPLETED,
        )

    async def mark_rejected_before_submit(self, **kwargs) -> OperationSnapshot:
        return self._apply(
            "rejected_before_submit",
            kwargs,
            allowed_from={OperationState.DISPATCHING},
            target=OperationState.REJECTED_BEFORE_SUBMIT,
        )

    async def mark_unknown(self, **kwargs) -> OperationSnapshot:
        return self._apply(
            "unknown",
            kwargs,
            allowed_from={OperationState.DISPATCHING, OperationState.ACCEPTED},
            target=OperationState.UNKNOWN,
        )


def test_operation_spec_requires_an_explicitly_declared_handle_kind() -> None:
    """Omitting handle_kind is a TypeError. There is no default - a default would be a new placeholder string."""

    values = {
        "organization_id": "org_1",
        "project_id": "project_1",
        "root_task_id": "root_1",
        "business_task_id": "task_1",
        "capability": "image.generate",
        "credential_id": "credential_1",
        "credential_version": 3,
        "request_digest": "a" * 64,
    }
    with pytest.raises(TypeError, match="handle_kind"):
        OperationSpec(**values)

    for bad in ("provider_job", None, 1, True):
        with pytest.raises(TypeError, match="handle_kind"):
            _spec(handle_kind=bad)

    assert {kind.value for kind in HandleKind} == {
        "provider_job",
        "local_result",
        "none",
    }


def test_operation_key_ignores_handle_kind() -> None:
    """The kind **must not** enter the identity dict, otherwise the replay of existing claims would mismatch as a whole.

    Pin the digest constant already at `tests/ports/test_egress_operations.py:57`: that it did not change
    shows the replay semantics of existing rows were not moved by this change."""
    """

    assert (
        _spec(handle_kind=HandleKind.PROVIDER_JOB).operation_key
        == _spec(handle_kind=HandleKind.NONE).operation_key
    )
    assert _spec().operation_key == (
        "6364e3f1e602b759bbecf2a8fccc6c119bed41c263c30b25b8b98cc6fb40b1b2"
    )


def test_every_claim_site_declares_a_handle_kind() -> None:
    """Each of the 8 production construction sites declares it explicitly; adding one that does not declare is red.

    Only literal `HandleKind.X` is accepted: indirect lookup defers the kind to runtime, and then you cannot tell here
    what it actually declares."""
    """

    declared: dict[str, str] = {}
    for path in sorted(SRC_ROOT.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if not (isinstance(func, ast.Name) and func.id == "OperationSpec"):
                continue
            kinds = [kw for kw in node.keywords if kw.arg == "handle_kind"]
            site = f"{path.relative_to(SRC_ROOT)}:{node.lineno}"
            assert kinds, f"{site} constructs OperationSpec without declaring handle_kind"
            value = kinds[0].value
            assert (
                isinstance(value, ast.Attribute)
                and isinstance(value.value, ast.Name)
                and value.value.id == "HandleKind"
            ), f"handle_kind of {site} is not a HandleKind literal"
            declared[site] = value.attr

    assert len(declared) == 8, declared


@pytest.mark.asyncio
async def test_service_paths_reach_completed_through_accepted() -> None:
    """The NewAPI service path must go through dispatching->accepted->completed in full, with no fake value left in either column.

    Right now they `mark_completed` straight from `dispatching`, which is P0001 on the real DB."""
    """

    from novelvideo.newapi_provisioner import (
        NewApiAdminServiceIdentity,
        run_newapi_admin_operation,
    )

    newapi_ops = StateMachineOperations()
    await run_newapi_admin_operation(
        identity=NewApiAdminServiceIdentity(
            credential_id="svc-newapi-admin",
            credential_version=2,
            admin_base_url="http://new-api:3000",
        ),
        admin_base_url="http://new-api:3000",
        capability="gateway.provisioning.setup",
        business_task_id="setup-default",
        request={"action": "setup", "channel": "default"},
        operations=newapi_ops,
        invoke=lambda: {"ok": True},
    )

    verbs = [verb for verb, _kwargs in newapi_ops.transitions]
    assert verbs == ["accepted", "completed"]
    assert newapi_ops.claims[0].handle_kind is HandleKind.NONE
    accepted_kwargs = newapi_ops.transitions[0][1]
    completed_kwargs = newapi_ops.transitions[1][1]
    assert accepted_kwargs["provider_job_id"] is None
    assert completed_kwargs["result_ref"] is None
    # expected_version must follow the return of accepted: after inserting one step the version is already +1,
    # and continuing with the claim-time version would be blocked by the optimistic lock.
    assert (
        completed_kwargs["expected_version"] == accepted_kwargs["expected_version"] + 1
    )


@pytest.mark.asyncio
async def test_media_relay_reaches_completed_through_accepted() -> None:
    from novelvideo.egress_context import TrustedEgressContext
    from novelvideo.ports.authz import BillingPrincipal
    from novelvideo.ports.model_credentials import CredentialReference
    from novelvideo.storage.media_relay import (
        StorageRelayIdentity,
        relay_tenant_image_bytes,
    )

    class _Relay:
        def upload_bytes(self, _data, *, ext, ttl, object_key):
            return f"https://cdn.example/{object_key}?ttl={ttl}&ext={ext}"

    context = TrustedEgressContext(
        envelope_id="envelope-1",
        project_id="project-a",
        task_type="image.generate",
        requester_user_id="user-1",
        root_task_id="root-1",
        admission_id="admission-1",
        admitted_at="2026-08-11T04:05:00Z",
        membership_id="membership-1",
        authz_version=1,
        billing_principal=BillingPrincipal(kind="organization", id="org-a"),
        credential=CredentialReference(
            source="organization",
            credential_id="credential-1",
            key_version=2,
            org_id="org-a",
        ),
    )
    operations = StateMachineOperations()

    url = await relay_tenant_image_bytes(
        b"image-bytes",
        object_id="object-1",
        context=context,
        identity=StorageRelayIdentity(
            credential_id="svc-relay",
            credential_version=1,
            organization_id="org-a",
            project_id="project-a",
        ),
        operations=operations,
        relay=_Relay(),
    )

    assert url.startswith("https://cdn.example/")
    assert [verb for verb, _kwargs in operations.transitions] == [
        "accepted",
        "completed",
    ]
    assert operations.claims[0].handle_kind is HandleKind.NONE
    assert operations.transitions[0][1]["provider_job_id"] is None
    assert operations.transitions[1][1]["result_ref"] is None


@pytest.mark.asyncio
async def test_state_machine_double_refuses_completed_straight_from_dispatching() -> (
    None
):
    """The stand-in itself must first be able to refuse, otherwise the cases above prove nothing."""

    operations = StateMachineOperations()
    with pytest.raises(EgressOperationError) as excinfo:
        await operations.mark_completed(
            operation_id="op-1",
            transition_token="transition-1",
            expected_version=1,
            result_ref=None,
        )

    assert excinfo.value.code == "EGRESS_OPERATION_INVALID_TRANSITION"


def test_no_placeholder_operation_handles_remain() -> None:
    """Placeholder strings are cleared under src - including any occurrence outside this file's own constants."""

    offenders = [
        f"{path.relative_to(SRC_ROOT)}:{number}"
        for path in sorted(SRC_ROOT.rglob("*.py"))
        for number, line in enumerate(
            path.read_text(encoding="utf-8").splitlines(), start=1
        )
        if any(placeholder in line for placeholder in PLACEHOLDER_HANDLES)
    ]

    assert offenders == []


def test_no_operation_id_is_reused_as_its_own_upstream_handle() -> None:
    """`model_gateway_runtime.py` once used `operation_id` as a self-referencing handle - that is not a handle.

    A self-reference passes the "non-empty" check but carries zero information; it was the fifth place missed when OI-49 was registered."""
    """

    from novelvideo import model_gateway_runtime

    source = Path(inspect.getsourcefile(model_gateway_runtime)).read_text(
        encoding="utf-8"
    )
    tree = ast.parse(source)

    offenders: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        for keyword in node.keywords:
            if keyword.arg not in {"provider_job_id", "result_ref"}:
                continue
            value = keyword.value
            if isinstance(value, ast.Attribute) and value.attr == "operation_id":
                offenders.append(f"{keyword.arg}@{node.lineno}")

    assert offenders == []
