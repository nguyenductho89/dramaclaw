# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""i18n payloads of backend progress/log messages.

The backend still writes English (as a fallback) while also carrying the i18n code/params out, and the frontend renders it with
`t(code, {defaultValue: text})`. This pins the payload shape and the rule that is easiest to trip over:
"a plain string must clear the previous code".
"""

import json

from novelvideo.i18n_message import (
    has_localizable_log,
    lmsg,
    log_entry_payload,
    log_entry_text,
    log_lines_text,
    message_payload,
    message_text,
)
from novelvideo.project_context import ProjectContext
from novelvideo.task_state import TaskState, TaskStateManager


def _manager() -> TaskStateManager:
    # _apply_progress_message only touches the state passed in; no real DB is needed.
    return TaskStateManager.__new__(TaskStateManager)


def _state() -> TaskState:
    return TaskState(task_id="t1", task_type="ingest_fast")


def test_localizable_message_carries_code_and_params():
    msg = lmsg("tasks.log.ingest.readingFile", "Reading file: /a.docx", path="/a.docx")
    assert message_text(msg) == "Reading file: /a.docx"
    assert message_payload(msg) == {
        "code": "tasks.log.ingest.readingFile",
        "params": {"path": "/a.docx"},
    }
    # Used directly as a string (f-string, log concatenation) it is still that fallback text.
    assert f"{msg}" == "Reading file: /a.docx"


def test_plain_string_has_no_payload():
    assert message_text("Task started") == "Task started"
    assert message_payload("Task started") is None
    assert log_entry_payload("Task started") == "Task started"


def test_progress_update_persists_text_and_code():
    state = _state()
    msg = lmsg("tasks.progress.ingest.reading", "Reading and validating source text...")
    _manager()._apply_progress_message(state, msg, [msg])

    # The fallback text still lands in the original column, so old clients are unaffected.
    assert state.current_task == "Reading and validating source text..."
    assert state.metadata["current_task_message"] == {
        "code": "tasks.progress.ingest.reading"
    }
    assert state.logs == [
        {"text": "Reading and validating source text...", "code": "tasks.progress.ingest.reading"}
    ]


def test_plain_string_update_clears_the_previous_code():
    """The easiest one to get wrong: if it is not cleared, the old code is used to translate the new text."""
    state = _state()
    _manager()._apply_progress_message(
        state, lmsg("tasks.progress.ingest.reading", "Reading and validating source text..."), None
    )
    # The next update comes from a call site that has not been migrated yet, with text only.
    _manager()._apply_progress_message(state, "Task started", None)

    assert state.current_task == "Task started"
    assert state.metadata["current_task_message"] is None


def test_merge_logs_dedupes_overlapping_tails_across_mixed_shapes():
    state = _state()
    msg = lmsg("tasks.log.ingest.sourceSaved", "Source text saved")
    _manager()._apply_progress_message(state, None, [msg, "Task started"])
    # The worker resent the tail segment; add one new entry.
    _manager()._apply_progress_message(state, None, ["Task started", "Task completed"])

    assert state.logs == [
        {"text": "Source text saved", "code": "tasks.log.ingest.sourceSaved"},
        "Task started",
        "Task completed",
    ]


def test_state_stays_json_serializable_after_a_localizable_update():
    """A LocalizableMessage must never live on as-is into the storage layer.

    EE's _pg_state_params and CE's SQLite write both do json.dumps(state.logs) and
    json.dumps(state.metadata). If even one place forgets to convert, the task blows up at write time with
    TypeError: Object of type LocalizableMessage is not JSON serializable,
    and it blows up halfway through the task run, so the frontend sees only a red line with no context.
    """
    state = _state()
    _manager()._apply_progress_message(
        state,
        lmsg("tasks.progress.ingest.chunking", "Splitting chapters...", chunkCount=3),
        [lmsg("tasks.log.ingest.chunked", "Split into 3 chunks", chunkCount=3)],
    )

    json.dumps(state.logs)
    json.dumps(state.metadata)
    assert isinstance(state.current_task, str)


def test_stored_logs_flatten_back_to_plain_strings():
    """The public contract of `logs` is `string[]`; structured entries must not leave through this field."""
    entries = [
        "Task started",
        {"text": "Split into 3 chunks", "code": "tasks.log.ingest.chunked", "params": {"chunkCount": 3}},
    ]

    assert log_lines_text(entries) == ["Task started", "Split into 3 chunks"]
    assert log_entry_text("Task started") == "Task started"
    assert has_localizable_log(entries) is True
    assert has_localizable_log(["Task started"]) is False
    # No logs (old rows, a just-created task) must not blow up.
    assert log_lines_text(None) == []
    assert has_localizable_log(None) is False


def test_serialized_task_keeps_logs_as_strings_and_adds_the_i18n_field():
    """Rolling release: new backend + old frontend must not render logs as `[object Object]`.

    The old frontend only does `join("\\n")` / downloads `logs` as a .log file, and degrades immediately when it gets objects.
    The structured copy goes separately through `logs_i18n`, which only a frontend that knows it reads.
    """
    from novelvideo.api.routes.tasks import _serialize_task

    task = TaskState(
        task_id="t1",
        task_type="ingest_fast",
        project_id="proj_123",
        episode=0,
        status="running",
        logs=[
            "Task started",
            {"text": "Split into 3 chunks", "code": "tasks.log.ingest.chunked", "params": {"chunkCount": 3}},
        ],
    )

    payload = _serialize_task(task)

    assert payload["logs"] == ["Task started", "Split into 3 chunks"]
    assert all(isinstance(line, str) for line in payload["logs"])
    assert payload["logs_i18n"][1]["code"] == "tasks.log.ingest.chunked"


def test_serialized_task_omits_the_i18n_field_when_nothing_is_localizable():
    """When there is not a single code, do not send it, so no task carries a duplicate copy of the logs for nothing."""
    from novelvideo.api.routes.tasks import _serialize_task

    payload = _serialize_task(
        TaskState(
            task_id="t2",
            task_type="ingest_fast",
            project_id="proj_123",
            episode=0,
            status="running",
            logs=["Task started"],
        )
    )

    assert payload["logs"] == ["Task started"]
    assert "logs_i18n" not in payload


# ---------------------------------------------------------------------------
# Persistence round trip
#
# review #462: `TaskState.metadata` has no column of its own and is persisted through `result_json.task_metadata`.
# `_apply_progress_message()` changes `state.metadata`, while the manual merges at most call sites
# sit under `if metadata is not None:` -- when the caller does not pass metadata along, the code is lost
# at the write hop, the frontend never gets `current_task_code`, and the whole localization is as good as not taking effect.
# The merge was therefore moved to the write boundary, and these cases pin "the code is still there after a real round trip".
# ---------------------------------------------------------------------------


def _project_ctx(tmp_path) -> ProjectContext:
    return ProjectContext(
        project_id="proj_i18n",
        project_name="demo",
        owner_type="user",
        owner_id="owner",
        owner_username="alice",
        requester_user_id="editor",
        requester_username="bob",
        requester_principals=(("user", "editor"),),
        effective_role="editor",
        home_node_id="node_a",
        output_dir=tmp_path / "output",
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
        is_home_node=True,
    )


def _reread_message(manager: TaskStateManager, ctx) -> dict | None:
    """`current_task_message` read back from the DB again."""
    state = manager.get_task_for_project(ctx, "single_video", 1)
    assert state is not None
    return (state.metadata or {}).get("current_task_message")


def test_reserved_task_keeps_its_submitting_code_across_a_db_round_trip(tmp_path):
    manager = TaskStateManager()
    ctx = _project_ctx(tmp_path)

    manager.reserve_task_for_project(ctx, "single_video", 1)

    assert _reread_message(manager, ctx) == {"code": "tasks.progress.submitting"}


def test_queued_code_survives_without_the_caller_passing_metadata(tmp_path):
    """It is normal for callers not to pass metadata; the code must not depend on it to be carried along."""
    manager = TaskStateManager()
    ctx = _project_ctx(tmp_path)
    state, _ = manager.reserve_task_for_project(ctx, "single_video", 1)

    assert manager.mark_task_enqueued_for_project(
        ctx, "single_video", 1, expected_task_id=state.task_id
    )

    assert _reread_message(manager, ctx) == {"code": "tasks.progress.queued"}


def test_progress_update_keeps_both_code_and_params_across_a_db_round_trip(tmp_path):
    manager = TaskStateManager()
    ctx = _project_ctx(tmp_path)
    manager.reserve_task_for_project(ctx, "single_video", 1)

    manager.update_progress_for_project(
        ctx,
        "single_video",
        1,
        progress=0.5,
        current_task=lmsg("tasks.log.ingest.readingFile", "Reading file: /a.docx", path="/a.docx"),
    )

    assert _reread_message(manager, ctx) == {
        "code": "tasks.log.ingest.readingFile",
        "params": {"path": "/a.docx"},
    }


def test_started_task_no_longer_carries_the_queued_code(tmp_path):
    """When begin assigns current_task directly, the English UI would show running as "Task queued"."""
    manager = TaskStateManager()
    ctx = _project_ctx(tmp_path)
    state, _ = manager.reserve_task_for_project(ctx, "single_video", 1)
    manager.mark_task_enqueued_for_project(
        ctx, "single_video", 1, expected_task_id=state.task_id
    )

    assert manager.begin_task_execution_for_project(
        ctx, "single_video", 1, expected_task_id=state.task_id
    )

    reread = manager.get_task_for_project(ctx, "single_video", 1)
    assert reread.current_task == "Task started"
    assert (reread.metadata or {}).get("current_task_message") == {
        "code": "tasks.progress.started"
    }


def test_cancelled_task_no_longer_carries_the_queued_code(tmp_path):
    manager = TaskStateManager()
    ctx = _project_ctx(tmp_path)
    state, _ = manager.reserve_task_for_project(ctx, "single_video", 1)
    manager.mark_task_enqueued_for_project(
        ctx, "single_video", 1, expected_task_id=state.task_id
    )

    cancelled, _ = manager.cancel_queued_task_for_project(
        ctx, "single_video", 1, expected_task_id=state.task_id
    )
    assert cancelled

    reread = manager.get_task_for_project(ctx, "single_video", 1)
    assert reread.current_task == "Task cancelled"
    assert (reread.metadata or {}).get("current_task_message") == {
        "code": "tasks.progress.cancelled"
    }
    # The refund decision hangs off the same metadata; the boundary merge must not push it out.
    assert reread.metadata["refund_eligible"] is True
