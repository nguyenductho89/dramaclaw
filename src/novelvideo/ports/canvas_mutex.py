"""Canvas write mutex port.

A canvas may have only one writer at any moment. Today this mutual exclusion is provided by the `flock` in `freezone/canvas_lock.py`,
which holds on **a single machine**: in a single-machine deployment that is the whole answer, but in a multi-pod deployment
two processes each `flock` their own mounted view and neither can stop the other -- two saves each write their own temp file and
each `os.replace`, the later rename wins, and the earlier update silently disappears.

So "what to use for mutual exclusion" is a **deployment question**, not a runtime question: installing the file lock gives today's behavior,
and installing an implementation that holds across machines (EE's Postgres short-transaction lease) gives cross-machine mutual exclusion. Hence it is
a port, and it **must keep the `PortNotRegistered` fallback** and **must not enter `_EE_REQUIRED_PORTS`**:
"not injected" is the rollback action, and it must always remain a legal state.

## Why the guard has an extra `reassert`

A file lock does not get lost midway: as long as the process is alive, the `flock` is there. A lease can -- it has a TTL, and after it expires someone else
can take over in place. So the critical section has a state a file lock does not: **"I think I still hold it, but it is no longer
mine"**. `reassert()` is that on-disk fence (B2-11), placed between "temp file fsynced,
`os.replace` not yet happened": past that point the write is irreversible, and if it cannot pass, nothing has happened.
In the CE implementation it is a no-op -- there is nothing to lose, hence nothing to re-verify.
"""

from __future__ import annotations

from pathlib import Path
from typing import ContextManager, Protocol

from novelvideo.freezone.canvas_lock import CanvasLockBusy


class CanvasLeaseLost(CanvasLockBusy):
    """The lease no longer belongs to us midway through the critical section (could not be acquired, or was taken over mid-write).

    Inheriting `CanvasLockBusy` is intentional: for callers the **handling of these two cases is exactly the same** --
    this write did not happen, just retry. So the error surface of `api/routes/freezone.py` needs no changes,
    and the existing 503 + `canvas_lock_busy` + `Retry-After: 1` picks it up automatically.

    They remain distinguishable by type, so logs and test cases can count "could not wait" and "lost mid-write" separately.
    """

    def __init__(self, canvas_id: str):
        # Bypass the message of `CanvasLockBusy.__init__`, but keep its `canvas_id` contract.
        RuntimeError.__init__(self, f"canvas write lease lost: {canvas_id}")
        self.canvas_id = canvas_id


class CanvasWriteGuard(Protocol):
    def reassert(self) -> None:
        """Confirm the mutex still belongs to us right now, otherwise raise `CanvasLeaseLost`.

        The call site is the line **right before** the irreversible write to disk. An implementation may be a no-op (file lock).
        """
        ...


class CanvasWriteMutex(Protocol):
    def write_mutex(
        self,
        project_dir: Path,
        canvas_id: str,
        *,
        actor: str | None = None,
        timeout_seconds: float | None = None,
    ) -> ContextManager[CanvasWriteGuard]:
        """Take exclusive write access to this canvas; raise `CanvasLockBusy` / `CanvasLeaseLost` on timeout.

        `timeout_seconds=None` means use the implementation's own default wait cap -- the defaults of CE and EE
        differ (file lock 3.0s vs `CANVAS_LOCK_WAIT_SECONDS`), and callers should not choose for them.
        """
        ...
