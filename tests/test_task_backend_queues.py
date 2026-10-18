"""B2 §6.4 step 7: the silent fallback of `normalize_queue_kind` becomes an exception.

Basis: B2 §2.6 (`task_backend/queues.py:8-10` silently falls back to `"default"` for unknown values,
so a misspelled lane name quietly runs in the default pool) and the RED of B2 §6.4 step 7
("a misspelled lane name -> raise, instead of silently landing in `default`").
The behavior for valid values must stay exactly the same.
"""

from __future__ import annotations

import pytest

from novelvideo.task_backend.queues import (
    QUEUE_KINDS,
    normalize_queue_kind,
    queue_name,
)


@pytest.mark.parametrize("bogus", ["vidoe", "canvas", "worlds", "DEFAULTS", "ffmpeg2"])
def test_normalize_queue_kind_rejects_unknown_lane(bogus: str) -> None:
    with pytest.raises(ValueError) as excinfo:
        normalize_queue_kind(bogus)
    assert bogus in str(excinfo.value)


@pytest.mark.parametrize("lane", sorted(QUEUE_KINDS))
def test_normalize_queue_kind_keeps_known_lanes_verbatim(lane: str) -> None:
    assert normalize_queue_kind(lane) == lane
    assert normalize_queue_kind(f"  {lane.upper()}  ") == lane


@pytest.mark.parametrize("absent", [None, "", "   "])
def test_normalize_queue_kind_treats_absent_as_default(absent: str | None) -> None:
    """A missing value still falls back to `default` - that is today's `(kind or "default")` semantics.

    Raising targets a 'misspelled lane name', not a 'lane not given'.
    """
    assert normalize_queue_kind(absent) == "default"


def test_queue_name_propagates_unknown_lane() -> None:
    with pytest.raises(ValueError):
        queue_name("node-1", "vidoe")


@pytest.mark.parametrize("lane", sorted(QUEUE_KINDS))
def test_queue_name_for_known_lane_unchanged(lane: str) -> None:
    assert queue_name("node-1", lane) == f"node.node-1.{lane}"


def test_queue_name_without_lane_uses_default() -> None:
    assert queue_name("node-1") == "node.node-1.default"
