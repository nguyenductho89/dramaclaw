#!/usr/bin/env python3
"""Port-closure guard (cp-port).

This repository must run standalone under ST_EDITION=ce / without a DSN -- every ports.*
capability is satisfied by a local implementation (novelvideo.ports.local.*), with no
dependency on any external adapter. This guard performs the port-closure check:

  1. ensure_bootstrap() succeeds (no missing ports, no contradictory configuration);
  2. All 11 facade getters resolve, and the implementation classes live under novelvideo.ports.local.*
     (hitting novelvideo_ee / supertale_admin / novelvideo.control_plane means an external implementation);
  3. The entry-point group novelvideo.ports_bootstrap is empty -- no external adapter package may be mixed into the install.

Any failure -> exit code 1. Complements import-lint (lint_ce_imports.py):
import-lint prevents direct imports at the "source level", while this guard prevents ports from
being backed by an external implementation at the "runtime / packaging level".
"""
from __future__ import annotations

import os
import sys
from importlib.metadata import entry_points

# Port implementations must live under this prefix (local implementations)
EXPECTED_LOCAL_PREFIX = "novelvideo.ports.local"
# An implementation class module matching any prefix below is judged an external implementation
FORBIDDEN_IMPL_PREFIXES = (
    "novelvideo_ee",
    "supertale_admin",
    "novelvideo.control_plane",
)
# The 11 facade getters exposed by novelvideo.ports.__all__ (one-to-one with _EE_REQUIRED_PORTS)
FACADE_GETTERS = (
    "get_auth_port",
    "get_auth_session_port",
    "get_project_registry",
    "get_project_access",
    "get_usage_meter",
    "get_provider_instrumentation",
    "get_task_backend",
    "get_cancellation_store",
    "get_audit_sink",
    "get_credit_quote",
    "get_lifecycle_port",
)


def _impl_module(impl: object) -> str:
    return type(impl).__module__


def _classify(module: str) -> str | None:
    """Return the violation reason; return None if compliant."""
    for prefix in FORBIDDEN_IMPL_PREFIXES:
        if module == prefix or module.startswith(f"{prefix}."):
            return f"external implementation ({module})"
    if module != EXPECTED_LOCAL_PREFIX and not module.startswith(f"{EXPECTED_LOCAL_PREFIX}."):
        return f"non-local implementation ({module}, expected {EXPECTED_LOCAL_PREFIX}.*)"
    return None


def main() -> int:
    # Force pure CE mode for determinism (unaffected by the caller's env)
    os.environ["ST_EDITION"] = "ce"
    os.environ.pop("ST_CONTROL_PLANE_DSN", None)

    import novelvideo.ports as ports
    from novelvideo.ports.registry import ensure_bootstrap

    try:
        ensure_bootstrap()
    except Exception as exc:  # noqa: BLE001 -- a bootstrap failure is itself a closure failure
        print(f"✖ ensure_bootstrap() failed in pure CE mode: {exc}", file=sys.stderr)
        return 1

    failures: list[str] = []
    for name in FACADE_GETTERS:
        getter = getattr(ports, name, None)
        if getter is None:
            failures.append(f"{name}: facade missing (not exposed by novelvideo.ports)")
            continue
        try:
            impl = getter()
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{name}: resolution raised {exc.__class__.__name__}: {exc}")
            continue
        module = _impl_module(impl)
        reason = _classify(module)
        if reason:
            failures.append(f"{name}: {reason}")
        else:
            print(f"  ✓ {name} → {type(impl).__name__} ({module})")

    eps = list(entry_points(group="novelvideo.ports_bootstrap"))
    if eps:
        joined = ", ".join(f"{ep.name}={ep.value}" for ep in eps)
        failures.append(
            f"entry-point group novelvideo.ports_bootstrap is non-empty (external adapters mixed into the install): {joined}"
        )

    if failures:
        print(f"\n✖ Port closure failed, {len(failures)} item(s):", file=sys.stderr)
        for item in failures:
            print(f"  {item}", file=sys.stderr)
        print(
            "\nAll ports must be satisfied by novelvideo.ports.local.*, "
            "with no dependency on external adapters or the novelvideo.ports_bootstrap entry point.",
            file=sys.stderr,
        )
        return 1

    print(f"\n✓ Port closure: all {len(FACADE_GETTERS)} ports are satisfied by local implementations, with no external dependencies.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
