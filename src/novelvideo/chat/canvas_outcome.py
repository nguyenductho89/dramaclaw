"""Structured final-response contract for receipt-backed canvas operations."""

from __future__ import annotations

import json
from typing import Any

CANVAS_FINAL_RESPONSE_INSTRUCTIONS = (
    "Your final response must be exactly one JSON object with message, mode, and "
    "canvas_receipts. No Markdown fences, headings, or prose outside that object. "
    "Put all user-facing explanations and success summaries in the message field. "
    "Instructions from tools to report success apply only to the message field; "
    "they never change the final response format. For a successful canvas mutation, "
    "use mode=mutation and include every exact same-turn successful receipt as "
    "{\"bridge_key\":\"actual returned key\",\"revision\":null}, or "
    "{\"bridge_key\":null,\"revision\":actual_returned_integer} for direct apply. "
    "Never invent receipts. For read_only or blocked, use canvas_receipts=[]. "
    "A creation receipt does not prove media generation or parameter persistence."
)

# Sent once, on the same thread, when a turn with no canvas write attempt ended
# in a reply that is not a well-formed envelope (#680). The answer is rewritten
# from this turn's evidence rather than repeated: prose from the malformed
# reply may claim a change that never happened.
CANVAS_FORMAT_REPAIR_PROMPT = (
    "Your previous final response was not the required JSON object. This turn "
    "made zero canvas writes: no node, edge, parameter, or run was created, "
    "changed, deleted, or started. Do not call any tools. Rewrite your answer to "
    "the user using only this turn's tool results. If your previous answer said "
    "or implied that anything on the canvas was created, changed, saved, or run, "
    "that statement is false: do not repeat it, and say instead that the canvas "
    "was not changed. Use mode=read_only (or blocked if the request could not be "
    "completed) and canvas_receipts=[]."
)

_REPLY_CONTRACT_FAILURE = "The reply did not pass operation result validation: "

CANVAS_REPLY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "message": {"type": "string"},
        "mode": {"type": "string", "enum": ["read_only", "mutation", "blocked"]},
        "canvas_receipts": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "bridge_key": {"type": ["string", "null"]},
                    "revision": {"type": ["integer", "null"]},
                },
                "required": ["bridge_key", "revision"],
            },
        },
    },
    "required": ["message", "mode", "canvas_receipts"],
}


def receipt_reference(payload: dict[str, Any]) -> tuple[str, int | None]:
    """Identify a browser receipt or a direct saved revision, never tool status."""
    key = str(payload.get("bridge_key") or "").strip()
    revision = payload.get("revision")
    if not isinstance(revision, int) or isinstance(revision, bool):
        revision = None
    if payload.get("canvas_apply_status") == "direct_applied":
        return "", revision
    return (key, None) if key else ("", revision)


def _claim_reference(value: Any) -> tuple[str, int | None] | None:
    if not isinstance(value, dict) or set(value) != {"bridge_key", "revision"}:
        return None
    key, revision = value["bridge_key"], value["revision"]
    if isinstance(key, str) and key.strip() and revision is None:
        return key.strip(), None
    if (
        key is None
        and isinstance(revision, int)
        and not isinstance(revision, bool)
        and revision >= 0
    ):
        return "", revision
    return None


def _parse_canvas_envelope(text: str) -> tuple[dict[str, Any] | None, str]:
    """Check only the reply's shape; claims are judged against evidence later."""
    try:
        reply = json.loads(text)
    except (TypeError, ValueError):
        return None, _REPLY_CONTRACT_FAILURE + "No structured result was returned; please retry."
    if not isinstance(reply, dict):
        return None, _REPLY_CONTRACT_FAILURE + "The result format is invalid; please retry."
    message = reply.get("message")
    mode = reply.get("mode")
    if (
        set(reply) != {"message", "mode", "canvas_receipts"}
        or not isinstance(message, str)
        or not message.strip()
        or not isinstance(mode, str)
        or mode not in {"read_only", "mutation", "blocked"}
        or not isinstance(reply.get("canvas_receipts"), list)
    ):
        return None, _REPLY_CONTRACT_FAILURE + "The result format is invalid; please retry."
    return reply, ""


def finalize_canvas_reply(
    text: str,
    *,
    attempts: dict[str, str],
    receipts: set[tuple[str, int | None]],
    failure: str = "",
    draft_ready: bool = False,
) -> str:
    """Validate claims against same-turn evidence without interpreting user prose.

    Every attempted write must succeed; one successful operation cannot mask
    another failed operation. Catalog-only and read-only answers need no canvas
    receipt. A prepared workflow remains a pending user approval, not a write.
    """
    states = set(attempts.values())
    if "failed" in states:
        return "Canvas operation incomplete: " + (
            failure or "Not every operation received a successful canvas write receipt; please retry."
        )
    if "timeout" in states:
        return "Canvas operation timed out: no execution receipt was received; check the canvas connection and retry."
    if "cancelled" in states:
        return "Canvas operation cancelled; not all operations were completed."
    if states - {"succeeded"}:
        return "Canvas operation is waiting for confirmation or an execution receipt and is not complete yet."
    if draft_ready and not attempts:
        return "The workflow draft is ready; it is waiting for your confirmation before canvas nodes are created. Nothing has been generated yet."
    reply, envelope_error = _parse_canvas_envelope(text)
    if reply is None:
        return envelope_error
    message, mode, claims = reply["message"], reply["mode"], reply["canvas_receipts"]
    if mode == "mutation":
        if not attempts or not claims:
            return "Canvas operation incomplete: this turn has no verifiable canvas write receipt; please retry."
        references = set()
        for claim in claims:
            reference = _claim_reference(claim)
            if reference is None or reference not in receipts:
                return "Canvas operation incomplete: the success claim does not match this turn's write receipts; please retry."
            references.add(reference)
        if references != receipts:
            return "Canvas operation incomplete: the success claim does not cover all of this turn's write receipts; please retry."
    elif claims or attempts:
        return _REPLY_CONTRACT_FAILURE + "The operation claim is inconsistent with the tool results; please retry."
    return message.strip()


def needs_canvas_format_repair(
    text: str,
    *,
    attempts: dict[str, str],
    receipts: set[tuple[str, int | None]],
    draft_ready: bool = False,
) -> bool:
    """Whether a no-write turn's reply failed the envelope shape, not the evidence.

    Turns with any write attempt, receipt, or pending draft are settled by the
    receipt checks alone. A well-formed envelope whose claims contradict the
    evidence (for example read_only with invented receipts) is a false claim,
    not a format slip, and is never given a second attempt.
    """
    if attempts or receipts or draft_ready:
        return False
    return _parse_canvas_envelope(text)[0] is None
