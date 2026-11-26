"""Cost of H3 renders on a rented Vast.ai pod: account credit before renting minus credit after the instance is gone.

The gateway times every render (`gpu_seconds`) and records it in the open session. `billing close` spreads the
credit drop over the session's tasks in proportion to gpu_seconds, so idle/boot time and storage are included.
Sessions live as one JSON file each in the billing directory; start/close run in a separate process from the server.
"""
from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path

import httpx

VAST_USER_URL = "https://console.vast.ai/api/v0/users/current/"
USD_DECIMALS = 6


def fetch_vast_credit(api_key: str, *, url: str = VAST_USER_URL) -> float:
    """Current account credit in USD (the `credit` field of the Vast user record)."""
    resp = httpx.get(url, headers={"Authorization": f"Bearer {api_key}"}, timeout=30.0)
    resp.raise_for_status()
    body = resp.json()
    if "credit" not in body:
        raise RuntimeError("Vast user response has no 'credit' field")
    return float(body["credit"])


def allocate(total_usd: float, gpu_seconds: list[float]) -> list[float]:
    """Split `total_usd` in proportion to `gpu_seconds`; the last share absorbs rounding so the sum is exact."""
    if not gpu_seconds:
        return []
    weight = sum(gpu_seconds)
    shares = [s / weight if weight > 0 else 1 / len(gpu_seconds) for s in gpu_seconds]
    out = [round(total_usd * share, USD_DECIMALS) for share in shares[:-1]]
    out.append(round(total_usd - sum(out), USD_DECIMALS))
    return out


class Ledger:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)

    def _path(self, session_id: str) -> Path:
        return self.root / f"{session_id}.json"

    def _write(self, session: dict) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        tmp = self._path(session["session_id"]).with_suffix(".tmp")
        tmp.write_text(json.dumps(session, ensure_ascii=False, indent=2))
        os.replace(tmp, self._path(session["session_id"]))

    def sessions(self) -> list[dict]:
        if not self.root.is_dir():
            return []
        return sorted(
            (json.loads(p.read_text()) for p in self.root.glob("*.json")), key=lambda s: s["started_at"]
        )

    def open_session(self) -> dict | None:
        return next((s for s in self.sessions() if s["status"] == "open"), None)

    def get(self, session_id: str) -> dict:
        path = self._path(session_id)
        if not path.is_file():
            raise KeyError(f"no billing session {session_id!r}")
        return json.loads(path.read_text())

    def start(self, credit_before: float) -> dict:
        if (current := self.open_session()) is not None:
            raise ValueError(f"session {current['session_id']} is still open: close it first")
        session = {
            "session_id": f"vast_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:4]}",
            "status": "open",
            "started_at": int(time.time()),
            "credit_before": credit_before,
            "tasks": [],
        }
        self._write(session)
        return session

    def record(self, task_id: str, gpu_seconds: float, context: dict) -> bool:
        """Add a finished render to the open session; False (and nothing written) when no session is open."""
        session = self.open_session()
        if session is None:
            return False
        session["tasks"].append({"task_id": task_id, "gpu_seconds": round(gpu_seconds, 3), "context": context})
        self._write(session)
        return True

    def close(self, credit_after: float) -> dict:
        session = self.open_session()
        if session is None:
            raise ValueError("no open billing session")
        total = round(session["credit_before"] - credit_after, USD_DECIMALS)
        if total < 0:
            raise ValueError(
                f"credit rose from {session['credit_before']} to {credit_after} (top-up?): "
                "pass --credit-before with the balance after the top-up and start a new session"
            )
        shares = allocate(total, [t["gpu_seconds"] for t in session["tasks"]])
        for task, usd in zip(session["tasks"], shares):
            task["usd"] = usd
        session.update(status="closed", closed_at=int(time.time()), credit_after=credit_after, total_usd=total)
        self._write(session)
        return session

    def task(self, task_id: str) -> dict | None:
        for session in reversed(self.sessions()):
            for task in session["tasks"]:
                if task["task_id"] == task_id:
                    return {
                        "task_id": task_id,
                        "session_id": session["session_id"],
                        "status": session["status"],
                        "gpu_seconds": task["gpu_seconds"],
                        "usd": task.get("usd"),
                        "context": task["context"],
                    }
        return None


def format_report(session: dict) -> str:
    rows = [f"session {session['session_id']} ({session['status']})", f"credit before: {session['credit_before']}"]
    if session["status"] == "closed":
        rows += [f"credit after:  {session['credit_after']}", f"total:         ${session['total_usd']:.4f}"]
    rows.append(f"{'task':<22}{'project':<16}{'ep':>4}{'beat':>5}{'gpu_s':>9}{'usd':>11}")
    for t in session["tasks"]:
        ctx = t["context"]
        usd = f"{t['usd']:.4f}" if t.get("usd") is not None else "-"
        rows.append(
            f"{t['task_id']:<22}{str(ctx.get('project', '-')):<16}{str(ctx.get('episode', '-')):>4}"
            f"{str(ctx.get('beat_num', '-')):>5}{t['gpu_seconds']:>9.1f}{usd:>11}"
        )
    if not session["tasks"]:
        rows.append("(no renders recorded)")
    return "\n".join(rows)
