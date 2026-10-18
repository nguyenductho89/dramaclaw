"""Injection seam of the TaskStateManager singleton.

EE overrides the *_for_project family with an inheriting store, while the legacy half is inherited as is;
all 58 _for_project call sites call methods on the object returned by get_task_manager(),
so the CE side only needs an injection point beside the singleton, not a port/Protocol.
"""

import pytest

from novelvideo import task_state as task_state_module
from novelvideo.task_state import (
    TaskStateManager,
    get_task_manager,
    set_task_manager,
)

pytestmark = pytest.mark.m07


@pytest.fixture(autouse=True)
def _restore_singleton():
    """The seam changes a module-level singleton, so it must be restored between cases, otherwise it pollutes later tests in the same process."""
    original = task_state_module._task_manager
    yield
    task_state_module._task_manager = original


class _StubManager(TaskStateManager):
    pass


def test_injected_manager_is_returned_by_get_task_manager() -> None:
    stub = _StubManager()

    set_task_manager(stub)

    assert get_task_manager() is stub


def test_reset_falls_back_to_the_default_singleton() -> None:
    stub = _StubManager()
    set_task_manager(stub)

    set_task_manager(None)

    restored = get_task_manager()
    assert restored is not stub
    assert type(restored) is TaskStateManager
    # After the reset it is still a singleton, not newly created on every call.
    assert get_task_manager() is restored
