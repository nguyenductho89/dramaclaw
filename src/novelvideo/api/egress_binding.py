"""Produce and bind trusted egress identity on the HTTP/WS request path.

`_MODEL_GATEWAY_CONTEXT` (`model_gateway_runtime.py:30-33`) is the only carrier
in the whole system for "who does the current outbound request belong to", and all
of its production set points are on the worker side
(`task_backend/run_core.py:710`, 5 runners, `freezone/text_node.py`).
There is none on the request path, so the egress gate reads `None` and treats it as
"platform identity, allow" -- model calls that organization users start from
chat/freezone are therefore paid for with real compute on the platform's key.

This module only adds the missing infrastructure: it produces a trusted identity in
place in the request process and binds it to the ContextVar. It **does not wire any
route**; wiring is the job of the OI-54 family S1/S2/S4/S5.

Trust chain: identity **can only** come from `get_authz_port().admit_model_task`
(abstract `ports/authz.py:191`; the EE authz port implementation goes through PG
`product_admit_model_task`; the CE single-machine fallback `ports/local/__init__.py:64-79`
produces `kind="local"`). No separate identity resolution is invented here -- a
second trust chain is a second vulnerability surface.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import random
from typing import AsyncIterator
from uuid import uuid4

from novelvideo.authz_retry import retry_authz_read
from novelvideo.egress_context import TrustedEgressContext
from novelvideo.model_gateway_runtime import model_gateway_request_scope
from novelvideo.ports.authz import AdmissionContext, AuthzError

_AUTHZ_RETRY_MAX_RETRIES = 2
_AUTHZ_RETRY_BASE_DELAY = 0.1
_AUTHZ_RETRY_CAP_DELAY = 0.5
_AUTHZ_RETRY_SLEEP = asyncio.sleep
_AUTHZ_RETRY_RANDOM = random.random


async def build_request_egress_context(
    *,
    requester_user_id: str,
    project_id: str,
    task_type: str,
) -> TrustedEgressContext | None:
    """Return this request's organization identity, or `None` if it has none.

    All three inputs are passed explicitly by the caller: the factory does not guess, parse, or fall back.

    `None` has **exactly one** meaning: this request is not an organization identity
    (platform / personal / CE local / gray rollout off). It never means "something went wrong" --
    errors always propagate. Giving `None` a second meaning would recreate the
    OI-48 fail-open as-is.
    """

    # Fetch the port lazily inside the function body, following the precedent of `generators/video_generator.py:2733`:
    # independent of process startup order and bootstrap, and call sites can be replaced independently.
    from novelvideo.ports import get_authz_port

    # Generate a one-time id first and then feed it to admit_model_task, following the established shape in `ports/local/tasks.py:139-150`
    # (there `state.task_id` exists before `sign_top_level` is called).
    root_task_id = uuid4().hex

    # Only retry authz reads that have no side effects. root_task_id is generated outside the retry so that all attempts
    # request the same admission identity; the provider call has not happened yet.
    authz_failure: AuthzError | None = None
    admission: AdmissionContext | None = None
    try:
        authz_port = get_authz_port()
        admission = await retry_authz_read(
            lambda: authz_port.admit_model_task(
                user_id=requester_user_id,
                root_task_id=root_task_id,
            ),
            max_retries=_AUTHZ_RETRY_MAX_RETRIES,
            base_delay=_AUTHZ_RETRY_BASE_DELAY,
            cap_delay=_AUTHZ_RETRY_CAP_DELAY,
            sleep=_AUTHZ_RETRY_SLEEP,
            random=_AUTHZ_RETRY_RANDOM,
            call_site="request_egress_scope",
        )
    except AuthzError as exc:
        authz_failure = exc
        admission = None
    if authz_failure is not None:
        # Branch 1: gray rollout off = platform semantics, path byte-for-byte unchanged.
        # When `ST_P0_GRAY_ENABLED` is off by default, the first statement of `admit_model_task`, require_enabled(),
        # raises this code (EE-side authz port implementation and its gray-switch configuration).
        if authz_failure.code == "P0_GRAY_DISABLED":
            return None
        # Branch 2: any other AuthzError propagates as-is, fail-closed.
        #
        # It must not be squashed into `None`. The **platform branch of EE `0038:405-449` has four rejection exits**
        # (user_missing / membership_changed / user_inactive / entitlement_mismatch),
        # so "platform users are never rejected" is wrong; squashing to None would read a real rejection as "not an organization, allow".
        # Propagating ORG_AUTHZ_STALE does affect platform users, but that is already today's production semantics:
        # `producer.sign_top_level` raises exactly this for all users in the same situation.
        authz_failure.__cause__ = None
        authz_failure.__context__ = None
        authz_failure.__traceback__ = None
        raise authz_failure from None

    # Non-AuthzError exceptions are not caught here. The producer converts them to `_invalid()`
    # because it must hand back an envelope; there is no envelope to hand back here, so letting them propagate as-is is fail-closed.
    # Catching them as `None` would give `None` a second meaning, exactly what is forbidden above.

    # Validation follows the shape of `run_core.py:210-218`. Any mismatch raises; it never returns `None`.
    # It sits before the identity branch: a mismatch means the authz implementation itself is broken, and then no identity reading can be trusted.
    # Reuse the existing vocabulary ORG_AUTHZ_STALE rather than minting a new error code -- same-shape precedent:
    # `generators/video_generator.py:2736-2747` (fields mismatch after re-admit means stale).
    if (
        admission.requester_user_id != requester_user_id
        or admission.root_task_id != root_task_id
    ):
        raise AuthzError("ORG_AUTHZ_STALE") from None

    # Branch 3: non-organization identity -> None. Platform / personal / CE local path byte-for-byte unchanged.
    if admission.billing_principal.kind != "organization":
        return None

    # Field mapping is copied field by field from `run_core.py:220-231`, not redesigned.
    # envelope_id is unique per request: the downstream `egress_operations` claim relies on it for replay protection,
    # so it must not be reused per connection or per session (see `model_gateway_runtime.py:164`).
    return TrustedEgressContext(
        envelope_id=f"req-{root_task_id}",
        project_id=project_id,
        task_type=task_type,
        requester_user_id=requester_user_id,
        root_task_id=admission.root_task_id,
        admission_id=admission.admission_id,
        admitted_at=admission.admitted_at,
        membership_id=admission.membership_id,
        authz_version=admission.authz_version,
        billing_principal=admission.billing_principal,
        credential=admission.credential,
    )


@asynccontextmanager
async def request_egress_scope(
    *,
    requester_user_id: str,
    project_id: str,
    task_type: str,
) -> AsyncIterator[TrustedEgressContext | None]:
    """Bind this request's organization identity for the duration of the block.

    Under a non-organization identity **nothing is bound** (ambient stays `None`) and `None` is yielded;
    the platform path is byte-for-byte unchanged.
    """

    context = await build_request_egress_context(
        requester_user_id=requester_user_id,
        project_id=project_id,
        task_type=task_type,
    )
    if context is None:
        yield None
        return
    # `model_gateway_request_scope` is a **synchronous** `@contextmanager`
    # (`model_gateway_runtime.py:100-114`), so this uses `with` rather than
    # `async with`. Its finally resets the ContextVar, so nothing leaks
    # when an exception is raised inside the scope. **Do not** switch to `model_gateway_scope_for_runner`
    # (`:117-130`) -- that one only accepts `TrustedRunnerEnvelope` and is the worker-side entry point.
    with model_gateway_request_scope(context):
        yield context
