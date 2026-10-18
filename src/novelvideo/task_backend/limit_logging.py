"""Unified logging seam for rate-limit rejections.

Lives here rather than in ``api/app.py``: a limit hit has two exits - the global exception handler
(which renders a 429) and the fan-out loop's local catch (which swallows the exception and returns 200 +
``rejected`` once k > 0 items have already been dispatched). Hooking the log only on the former misses the latter, and the latter is exactly the kind of event most worth seeing:
the user gets a 200 and not a single record shows up on the panel.

This module depends only on the exception definitions in ``limits``, so both exits can import it without creating a cycle.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# Field order is fixed so it can be grepped and split by pattern; missing values are filled with "-" instead of being omitted,
# so downstream positional parsing does not shift. Apart from ``limit_scope``, every name corresponds verbatim to an exception attribute.
_LOG_FIELDS = (
    "limit_scope",
    "scope_kind",
    "org_id",
    "queue_kind",
    "limit",
    "active",
    "queued",
    "requester_user_id",
    "project_id",
)


def _render(value: object) -> str:
    return "-" if value is None else str(value)


def log_task_limit_rejection(exc: BaseException, *, limit_scope: str) -> None:
    """Write one limit hit as a single greppable WARNING line.

    ``limit_scope`` is supplied by the caller: it has one algorithm at each of the two exits (the handler's
    ``limit_scope`` and the fan-out's ``rejected.reason``), and the same algorithm on both sides is a
    drift detector between them, so it must not be merged away here. All other fields are taken from the exception itself, so the lines
    logged by the two exits have exactly the same shape. Only business IDs are logged, never user or project names.
    """
    rendered = " ".join(
        "%s=%s"
        % (
            name,
            _render(limit_scope if name == "limit_scope" else getattr(exc, name, None)),
        )
        for name in _LOG_FIELDS
    )
    logger.warning("task lane limit rejected %s", rendered)
