"""B2 step 1 - wait/hold timing instrumentation of `canvas_write_lock`.

The criteria come from `B2-canvas-placement-free.md` Section 3.3.1 step B + Section 6.4 step 1:

- The switch `ST_CANVAS_LOCK_TIMING` is **off by default**, and produces zero output when off (B2-8 / master figure F8 "zero CE behavior change");
- When on, **one line per lock acquisition** with all fields (`canvas_id` / `wait_ms` / `held_ms`);
- The channel must be **stdout `print(flush=True)`**, not `logging` -- measured in the Section 3.3.1 warning box:
  the api process root logger is bare, `logger.info` is dropped at the logger layer, and not a single line reaches Loki.
  So the two checks "off by default / output when on" are **verified in a subprocess**, which covers both env parsing and the stdout channel.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

from novelvideo.freezone import canvas_lock
from novelvideo.freezone.canvas_lock import canvas_write_lock

TIMING_LINE_RE = re.compile(
    r"^canvas\.lock canvas_id=(?P<canvas_id>\S+) "
    r"wait_ms=(?P<wait_ms>[0-9.]+) held_ms=(?P<held_ms>[0-9.]+)$"
)

_CHILD_SCRIPT = """
import sys
from pathlib import Path

from novelvideo.freezone.canvas_lock import canvas_write_lock

project_dir = Path(sys.argv[1])
for _ in range(2):
    with canvas_write_lock(project_dir, "default"):
        pass
print("child_done", flush=True)
"""


def _run_child(tmp_path: Path, *, timing: str | None) -> list[str]:
    env = dict(os.environ)
    env.pop("ST_CANVAS_LOCK_TIMING", None)
    if timing is not None:
        env["ST_CANVAS_LOCK_TIMING"] = timing
    proc = subprocess.run(
        [sys.executable, "-c", _CHILD_SCRIPT, str(tmp_path / "project")],
        capture_output=True,
        text=True,
        env=env,
        timeout=180,
        check=True,
    )
    assert "child_done" in proc.stdout, proc.stderr
    return [line for line in proc.stdout.splitlines() if line.startswith("canvas.lock ")]


def test_canvas_lock_timing_is_silent_when_switch_is_unset(tmp_path: Path) -> None:
    """Switch unset -> zero output (CE single-node default path, B2-8)."""

    assert _run_child(tmp_path, timing=None) == []


def test_canvas_lock_timing_is_silent_when_switch_is_not_one(tmp_path: Path) -> None:
    """Only an exact `1` turns it on; `0` always counts as off (leaving no ambiguous switch surface)."""

    assert _run_child(tmp_path, timing="0") == []


def test_canvas_lock_timing_emits_one_complete_line_per_acquire(tmp_path: Path) -> None:
    """When on, one line per lock acquisition with all fields, going through stdout (logging cannot capture it in the subprocess)."""

    lines = _run_child(tmp_path, timing="1")

    assert len(lines) == 2
    for line in lines:
        match = TIMING_LINE_RE.match(line)
        assert match is not None, line
        assert match.group("canvas_id") == "default"
        assert float(match.group("wait_ms")) >= 0.0
        assert float(match.group("held_ms")) >= 0.0


def test_canvas_lock_timing_measures_wait_and_held_separately(
    tmp_path: Path, capsys, monkeypatch
) -> None:
    """`wait_ms` measures contention and `held_ms` measures the critical section -- each number decides one thing (Section 3.3.1, fourth decision).

    `held_ms` sets the TTL, and `wait_ms` decides "is the 3s spin cap enough", so they must be two independent numbers.
    """

    monkeypatch.setattr(canvas_lock, "_TIMING", True)
    project_dir = tmp_path / "project"
    holder_acquired = threading.Event()

    def hold() -> None:
        with canvas_write_lock(project_dir, "default"):
            holder_acquired.set()
            time.sleep(0.15)

    holder = threading.Thread(target=hold)
    holder.start()
    assert holder_acquired.wait(timeout=5.0)

    with canvas_write_lock(project_dir, "default"):
        time.sleep(0.05)
    holder.join(timeout=5.0)

    parsed = [
        TIMING_LINE_RE.match(line)
        for line in capsys.readouterr().out.splitlines()
        if line.startswith("canvas.lock ")
    ]
    assert len(parsed) == 2
    assert all(match is not None for match in parsed)
    waits = sorted(float(match.group("wait_ms")) for match in parsed)
    helds = sorted(float(match.group("held_ms")) for match in parsed)

    # The holder waits zero; the contender waits until the holder lets go (0.15s minus the short stretch before set()).
    assert waits[0] < 50.0
    assert waits[1] >= 80.0
    # Critical-section time: the contender sleeps 0.05s and the holder sleeps 0.15s; the two numbers must not be blurred into one.
    assert helds[0] >= 40.0
    assert helds[1] >= 140.0
