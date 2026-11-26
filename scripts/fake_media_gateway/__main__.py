"""uv run python -m scripts.fake_media_gateway --port 8790

Vast.ai cost of the renders (credit before renting minus credit after the instance is deleted):
  uv run python -m scripts.fake_media_gateway billing start      # before renting the instance
  uv run python -m scripts.fake_media_gateway billing close      # after the instance is deleted
  uv run python -m scripts.fake_media_gateway billing report [SESSION_ID]
"""
from __future__ import annotations

import argparse
import os
import sys

import uvicorn

from . import vast_billing
from .server import create_app

DEFAULT_OUTPUT_DIR = "output/fake_media_gateway"


def _credit(flag: float | None) -> float:
    if flag is not None:
        return flag
    key = os.environ.get("VAST_API_KEY", "").strip()
    if not key:
        sys.exit("set VAST_API_KEY, or pass the balance with --credit-before / --credit-after")
    return vast_billing.fetch_vast_credit(key)


def _billing(args: argparse.Namespace) -> None:
    ledger = vast_billing.Ledger(args.billing_dir or f"{DEFAULT_OUTPUT_DIR}_billing")
    try:
        if args.action == "start":
            session = ledger.start(_credit(args.credit_before))
            print(f"session {session['session_id']} open, credit before: {session['credit_before']}")
            return
        if args.action == "close":
            print(vast_billing.format_report(ledger.close(_credit(args.credit_after))))
            return
        session = ledger.get(args.session) if args.session else (ledger.open_session() or (ledger.sessions() or [None])[-1])
        print(vast_billing.format_report(session) if session else "no billing sessions")
    except (ValueError, KeyError) as exc:
        sys.exit(str(exc))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--comfy-url", default=None, help="default: $COMFY_URL or http://127.0.0.1:8188")
    sub = parser.add_subparsers(dest="command")
    billing = sub.add_parser("billing", help="Vast.ai credit ledger for the renders")
    billing.add_argument("action", choices=["start", "close", "report"])
    billing.add_argument("session", nargs="?", help="report: session id (default: open or latest)")
    billing.add_argument("--credit-before", type=float, default=None, help="skip the Vast API call")
    billing.add_argument("--credit-after", type=float, default=None, help="skip the Vast API call")
    billing.add_argument("--billing-dir", default=None, help=f"default: {DEFAULT_OUTPUT_DIR}_billing")
    args = parser.parse_args()
    if args.command == "billing":
        _billing(args)
        return
    uvicorn.run(create_app(comfy_url=args.comfy_url, output_dir=args.output_dir), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
