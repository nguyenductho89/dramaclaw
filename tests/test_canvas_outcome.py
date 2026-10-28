import json

import pytest
from jsonschema import Draft202012Validator

from novelvideo.chat.canvas_outcome import (
    CANVAS_FORMAT_REPAIR_PROMPT,
    CANVAS_REPLY_SCHEMA,
    finalize_canvas_reply,
    needs_canvas_format_repair,
)


def reply(mode="read_only", claims=None, message="I suggest keeping the current layout."):
    return json.dumps(
        {"message": message, "mode": mode, "canvas_receipts": claims or []}
    )


def test_reply_schema_accepts_read_only_and_mutation_results():
    validator = Draft202012Validator(CANVAS_REPLY_SCHEMA)
    validator.validate(json.loads(reply()))
    validator.validate(
        json.loads(reply("mutation", [{"bridge_key": "bridge-a", "revision": None}]))
    )


def test_read_only_answer_needs_no_canvas_receipt():
    assert (
        finalize_canvas_reply(reply(), attempts={}, receipts=set())
        == "I suggest keeping the current layout."
    )


def test_requested_canvas_write_cannot_end_as_read_only_without_receipt():
    result = finalize_canvas_reply(
        reply(
            message=(
                "正在通过节点绑定的 drama-background-music Recipe 编译提示词并执行 "
                "generate_audio。"
            )
        ),
        attempts={},
        receipts=set(),
        write_requested=True,
    )

    assert result == "画布操作未完成：本轮没有可验证的画布写入回执，请重试。"


def test_freezone_instructions_embed_schema_and_valid_greeting_example():
    from novelvideo.chat import service

    instructions = service._codex_developer_instructions("freezone_canvas")
    schema = json.loads(instructions.rsplit("\n", 1)[1])
    assert schema == CANVAS_REPLY_SCHEMA
    example, _ = json.JSONDecoder().raw_decode(
        instructions.split("For a greeting, return ", 1)[1]
    )
    Draft202012Validator(schema).validate(example)
    assert (
        finalize_canvas_reply(json.dumps(example), attempts={}, receipts=set())
        == example["message"]
    )
    assert example["mode"] == "read_only"
    assert example["canvas_receipts"] == []
    assert "not plain text or Markdown" in instructions
    assert "ordinary conversation" in instructions
    assert "canvas_receipts" not in service._codex_developer_instructions("default")


def test_plain_success_claim_is_still_rejected_without_receipts():
    assert "No structured result was returned" in finalize_canvas_reply(
        "The image node was created successfully.", attempts={}, receipts=set()
    )


def test_catalog_only_success_needs_no_canvas_receipt():
    assert (
        finalize_canvas_reply(
            reply(message="The Skill has been saved and not run yet."), attempts={}, receipts=set()
        )
        == "The Skill has been saved and not run yet."
    )


def test_canvas_success_requires_actual_same_turn_receipts():
    text = reply("mutation", [{"bridge_key": "bridge-a", "revision": None}])
    assert "no verifiable" in finalize_canvas_reply(text, attempts={}, receipts=set())
    assert "does not match" in finalize_canvas_reply(
        text, attempts={"call-a": "succeeded"}, receipts={("bridge-other", None)}
    )


def test_canvas_success_accepts_verified_browser_receipt():
    assert (
        finalize_canvas_reply(
            reply(
                "mutation",
                [{"bridge_key": "bridge-a", "revision": None}],
                "Node created.",
            ),
            attempts={"call-a": "succeeded"},
            receipts={("bridge-a", None)},
        )
        == "Node created."
    )


def test_canvas_success_accepts_verified_direct_revision():
    assert (
        finalize_canvas_reply(
            reply("mutation", [{"bridge_key": None, "revision": 3}], "Node updated."),
            attempts={"call-a": "succeeded"},
            receipts={("", 3)},
        )
        == "Node updated."
    )


def test_one_success_cannot_mask_another_failed_write():
    assert (
        finalize_canvas_reply(
            reply("mutation", [{"bridge_key": "bridge-a", "revision": None}]),
            attempts={"call-a": "succeeded", "call-b": "failed"},
            receipts={("bridge-a", None)},
            failure="the second node was not saved.",
        )
        == "Canvas operation incomplete: the second node was not saved."
    )


@pytest.mark.parametrize(
    "state", ["waiting_approval", "in_progress", "cancelled", "timeout"]
)
def test_non_success_operation_keeps_its_state(state):
    result = finalize_canvas_reply(
        reply("mutation"), attempts={"call-a": state}, receipts=set()
    )
    expected = {"cancelled": "cancelled", "timeout": "timed out"}.get(state, "waiting for confirmation")
    assert expected in result


def test_workflow_draft_is_pending_approval_not_success_or_failure():
    result = finalize_canvas_reply(
        "Node created.", attempts={}, receipts=set(), draft_ready=True
    )
    assert "waiting for your confirmation" in result
    assert "operation incomplete" not in result


@pytest.mark.parametrize(
    "text",
    [
        "Node created.",
        "[]",
        "null",
        "{}",
        json.dumps({"message": "Explanation", "mode": [], "canvas_receipts": []}),
        json.dumps(
            {"message": "Explanation", "mode": "read_only", "canvas_receipts": [], "extra": 1}
        ),
    ],
)
def test_missing_or_invalid_structured_reply_fails_closed(text):
    assert "did not pass operation result validation" in finalize_canvas_reply(
        text, attempts={}, receipts=set()
    )


def test_read_only_mode_cannot_hide_actual_canvas_writes():
    assert "inconsistent" in finalize_canvas_reply(
        reply(), attempts={"call-a": "succeeded"}, receipts={("bridge-a", None)}
    )


def test_claims_must_cover_all_successful_writes():
    assert "does not cover" in finalize_canvas_reply(
        reply("mutation", [{"bridge_key": "bridge-a", "revision": None}]),
        attempts={"call-a": "succeeded", "call-b": "succeeded"},
        receipts={("bridge-a", None), ("bridge-b", None)},
    )


@pytest.mark.parametrize("revision", [True, "3", 3.5])
def test_invalid_revision_claims_fail_closed(revision):
    assert "does not match" in finalize_canvas_reply(
        reply("mutation", [{"bridge_key": None, "revision": revision}]),
        attempts={"call-a": "succeeded"},
        receipts={("", 3)},
    )


def test_read_only_plain_text_needs_format_repair():
    # #680: a no-write turn that answered in prose is repaired, not replaced.
    assert needs_canvas_format_repair(
        "The workflow failed; no video was generated.", attempts={}, receipts=set()
    )
    assert needs_canvas_format_repair("{}", attempts={}, receipts=set())


@pytest.mark.parametrize(
    ("text", "attempts", "receipts", "draft_ready"),
    [
        (reply(), {}, set(), False),
        ("Node created.", {"call-a": "succeeded"}, {("bridge-a", None)}, False),
        ("Node created.", {}, {("", 7)}, False),
        ("Node created.", {"call-a": "failed"}, set(), False),
        ("The draft is ready.", {}, set(), True),
        (reply("mutation", [{"bridge_key": "bridge-a", "revision": None}]), {}, set(), False),
        # A well-formed envelope with invented receipts is a false claim, not a
        # format slip: a retry could drop the receipts and keep the claim.
        (
            reply(
                "read_only",
                [{"bridge_key": "forged", "revision": None}],
                message="The image node was created successfully.",
            ),
            {},
            set(),
            False,
        ),
        (
            reply("blocked", [{"bridge_key": None, "revision": 3}]),
            {},
            set(),
            False,
        ),
    ],
)
def test_format_repair_never_applies_to_write_evidence_or_false_mutation(
    text, attempts, receipts, draft_ready
):
    assert not needs_canvas_format_repair(
        text, attempts=attempts, receipts=receipts, draft_ready=draft_ready
    )


def test_format_repair_prompt_rewrites_from_evidence_instead_of_repeating():
    assert "same answer" not in CANVAS_FORMAT_REPAIR_PROMPT
    assert "zero canvas writes" in CANVAS_FORMAT_REPAIR_PROMPT
    assert "do not repeat it" in CANVAS_FORMAT_REPAIR_PROMPT
    assert "canvas_receipts=[]" in CANVAS_FORMAT_REPAIR_PROMPT
