"""Runtime degradation behavior of "the binary is installed but the sandbox must actually be buildable" on the Linux sandbox.

#346 P1(1): the CE image now installs codex-linux-sandbox + bubblewrap per TARGETARCH. But "binary present"
does not mean "sandbox can be built" - bwrap only fails at runtime when the host kernel lacks unprivileged user namespaces.
This test pins the runtime execution boundary:
- the one-time probe of ``_wrap_linux``: binary missing / binary present but probe failing both go through the same
    ``_fallback_or_raise`` decision (EE refuses, CE single-tenant opt-in degrades).

Platform independent: call ``_wrap_linux`` directly and monkeypatch the probe; no real Linux sandbox is run.
"""

from pathlib import Path

import pytest

from novelvideo.security import sandbox_wrap
from novelvideo.security.sandbox_wrap import SandboxSpec

@pytest.fixture(autouse=True)
def _clear_probe_cache():
    sandbox_wrap._SANDBOX_PROBE_CACHE.clear()
    yield
    sandbox_wrap._SANDBOX_PROBE_CACHE.clear()


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    # Each case defines its own sandbox-required / opt-in / Linux activation; clear them first to avoid interference from the host .env / CI runner.
    # Especially SUPERTALE_LINUX_SANDBOX: a machine that has set it would make the "not activated by default" cases lose their default semantics;
    # cases that need activation setenv it explicitly themselves.
    monkeypatch.delenv("SUPERTALE_ENV", raising=False)
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    monkeypatch.delenv("SUPERTALE_ALLOW_UNSANDBOXED", raising=False)
    monkeypatch.delenv("SUPERTALE_LINUX_SANDBOX", raising=False)


def _spec(tmp_path: Path) -> SandboxSpec:
    return SandboxSpec(user="probe", hermes_home=tmp_path / ".hermes")


def _present_binary(monkeypatch, tmp_path: Path) -> Path:
    """Make `_wrap_linux` think the binary exists: which returns a real existing file."""
    fake = tmp_path / "codex-linux-sandbox"
    fake.write_text("#!/bin/true\n")
    monkeypatch.setattr(sandbox_wrap.shutil, "which", lambda _n: str(fake))
    return fake


# ---- _wrap_linux: the Linux sandbox is "explicitly activated" (not active by default, #346 P1(2)) ----

def test_wrap_linux_not_activated_by_default_failcloses_on_ee(monkeypatch, tmp_path):
    # SUPERTALE_LINUX_SANDBOX is not set by default: even if the binary is present and the probe would succeed, no wrapping -
    # because codex restricted's root:read makes same-host peer data readable, so read isolation can only be turned off at the deployment layer
    # (mounting only the current user's slice). EE prefers fail-close over going live with "fake read isolation".
    _present_binary(monkeypatch, tmp_path)
    monkeypatch.setattr(sandbox_wrap, "_sandbox_can_run", lambda _b: True)
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgres://cp/db")  # EE / multi-tenant
    with pytest.raises(RuntimeError, match="sandbox required"):
        sandbox_wrap._wrap_linux(["hermes", "run"], _spec(tmp_path))


def test_wrap_linux_not_activated_by_default_degrades_on_ce_optin(monkeypatch, tmp_path):
    # Not activated + CE single-tenant + opt-in: goes through the same _fallback_or_raise -> degrades to running bare (single tenant has no cross-user risk).
    _present_binary(monkeypatch, tmp_path)
    monkeypatch.setattr(sandbox_wrap, "_sandbox_can_run", lambda _b: True)
    monkeypatch.setenv("SUPERTALE_ALLOW_UNSANDBOXED", "1")
    with pytest.warns(RuntimeWarning, match="UNSANDBOXED"):
        out = sandbox_wrap._wrap_linux(["hermes", "run"], _spec(tmp_path))
    assert out == ["hermes", "run"]


# ---- _wrap_linux: activated + binary present + probe succeeds -> really wrapped ----

def test_wrap_linux_wraps_when_sandbox_usable(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPERTALE_LINUX_SANDBOX", "1")  # explicit activation (deployment has mounted a single-user slice)
    fake = _present_binary(monkeypatch, tmp_path)
    monkeypatch.setattr(sandbox_wrap, "_sandbox_can_run", lambda _b: True)
    out = sandbox_wrap._wrap_linux(["hermes", "run"], _spec(tmp_path))
    assert out[0] == str(fake)
    assert "--" in out
    assert out[-2:] == ["hermes", "run"]


# ---- _wrap_linux: activated but probe fails -> same degrade/refuse as "binary missing" ----

def test_present_but_unusable_degrades_on_ce_optin(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPERTALE_LINUX_SANDBOX", "1")
    _present_binary(monkeypatch, tmp_path)
    monkeypatch.setattr(sandbox_wrap, "_sandbox_can_run", lambda _b: False)
    monkeypatch.setenv("SUPERTALE_ALLOW_UNSANDBOXED", "1")  # CE single-tenant degrade valve
    with pytest.warns(RuntimeWarning, match="UNSANDBOXED"):
        out = sandbox_wrap._wrap_linux(["hermes", "run"], _spec(tmp_path))
    assert out == ["hermes", "run"]  # not wrapped: degrades to running bare


def test_present_but_unusable_failcloses_on_ee(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPERTALE_LINUX_SANDBOX", "1")
    _present_binary(monkeypatch, tmp_path)
    monkeypatch.setattr(sandbox_wrap, "_sandbox_can_run", lambda _b: False)
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgres://cp/db")  # EE / multi-tenant
    monkeypatch.setenv("SUPERTALE_ALLOW_UNSANDBOXED", "1")  # no effect on EE
    with pytest.raises(RuntimeError, match="sandbox required"):
        sandbox_wrap._wrap_linux(["hermes", "run"], _spec(tmp_path))


def test_missing_binary_still_failcloses_on_ce_without_optin(monkeypatch, tmp_path):
    # A missing binary short-circuits before the activation check, independent of the activation switch.
    monkeypatch.setattr(sandbox_wrap.shutil, "which", lambda _n: None)
    # /usr/local/bin/codex-linux-sandbox does not exist on mac -> treated as missing; not opted in -> refuse
    with pytest.raises(RuntimeError, match="SUPERTALE_ALLOW_UNSANDBOXED"):
        sandbox_wrap._wrap_linux(["hermes"], _spec(tmp_path))


# ---- _sandbox_can_run: one-time probe + cache ----

def test_sandbox_can_run_caches_by_binary(monkeypatch):
    calls = {"n": 0}

    class _Proc:
        returncode = 0

    def _fake_run(*_a, **_k):
        calls["n"] += 1
        return _Proc()

    monkeypatch.setattr(sandbox_wrap.subprocess, "run", _fake_run)
    assert sandbox_wrap._sandbox_can_run("/x/codex-linux-sandbox") is True
    assert sandbox_wrap._sandbox_can_run("/x/codex-linux-sandbox") is True
    assert calls["n"] == 1  # the second call hits the cache, no more spawn


def test_sandbox_can_run_false_when_probe_nonzero(monkeypatch):
    class _Proc:
        returncode = 1

    monkeypatch.setattr(sandbox_wrap.subprocess, "run", lambda *_a, **_k: _Proc())
    assert sandbox_wrap._sandbox_can_run("/y/codex-linux-sandbox") is False


def test_sandbox_can_run_false_on_oserror(monkeypatch):
    def _boom(*_a, **_k):
        raise OSError("no such kernel feature")

    monkeypatch.setattr(sandbox_wrap.subprocess, "run", _boom)
    assert sandbox_wrap._sandbox_can_run("/z/codex-linux-sandbox") is False
