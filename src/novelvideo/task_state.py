"""Task state persistence management.

Persists task state in the project-local SQLite so results remain available after a worker exits.

Core flow:
1. The API side reserves the task state (submitting)
2. After the broker accepts the message, the task enters the queue (queued)
3. Once a worker starts executing, it updates progress (running)
4. When a worker completes/fails/cancels, it writes the final result (completed/failed/cancelled)

Key improvements:
- A worker writes SQLite first when it finishes, then exits
- The frontend reads the final result from SQLite first
- A worker dying does not affect result retrieval
"""

import json
import logging
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional

from novelvideo.i18n_message import (
    MessageLike,
    lmsg,
    log_entry_payload,
    message_payload,
    message_text,
)

from novelvideo.config import OUTPUT_DIR, STATE_DIR
from novelvideo.project_context import ProjectContext, require_project_home_node
from novelvideo.sqlite_pragmas import configure_sqlite_connection
from novelvideo.sqlite_schema import ensure_sqlite_schema
from novelvideo.task_backend.queues import normalize_queue_kind
from novelvideo.task_identity import (
    project_task_scope_from_key,
    project_task_state_key,
    task_scope_from_key,
    task_state_key,
)

logger = logging.getLogger(__name__)

ACTIVE_PROJECT_TASK_STATUSES = {"submitting", "queued", "running"}
TERMINAL_TASK_STATUSES = {"completed", "failed", "cancelled"}
_PROJECT_LANE_LIMIT_UNSET = object()
_CURRENT_PROJECT_TASK_ID: ContextVar[str | None] = ContextVar(
    "novelvideo_current_project_task_id",
    default=None,
)


@contextmanager
def project_task_run_context(task_id: str):
    """Bind project task state updates in this call stack to one Celery run."""
    token = _CURRENT_PROJECT_TASK_ID.set(str(task_id))
    try:
        yield
    finally:
        _CURRENT_PROJECT_TASK_ID.reset(token)


def get_current_project_task_id() -> str:
    return str(_CURRENT_PROJECT_TASK_ID.get() or "").strip()


def _queue_kind_from_metadata(metadata: dict | None, fallback: str | None = None) -> str:
    raw = None
    if metadata:
        raw = metadata.get("queue_kind")
    return normalize_queue_kind(str(raw) if raw is not None else fallback)


def _env_int(name: str, default: int, *, fallback_name: str | None = None) -> int:
    raw_value = os.environ.get(name)
    if raw_value is None and fallback_name is not None:
        raw_value = os.environ.get(fallback_name)
    if raw_value is None:
        return default
    try:
        return max(1, int(raw_value))
    except (TypeError, ValueError):
        return default


_TASK_STATE_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS task_states (
    task_key TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    task_type TEXT NOT NULL,
    queue_kind TEXT NOT NULL DEFAULT 'default',
    project_id TEXT NOT NULL DEFAULT '',
    requester_user_id TEXT NOT NULL DEFAULT '',
    owner_username TEXT NOT NULL DEFAULT '',
    project_name TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL,
    project TEXT NOT NULL,
    episode INTEGER NOT NULL,
    beat_num INTEGER,
    status TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0.0,
    current_task TEXT NOT NULL DEFAULT '',
    result_json TEXT,
    error TEXT,
    logs_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT '',
    completed_at TEXT NOT NULL DEFAULT '',
    expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_states_user_updated
ON task_states(username, updated_at DESC);
"""

_TASK_STATE_COLUMN_UPGRADES = {
    "queue_kind": "ALTER TABLE task_states ADD COLUMN queue_kind TEXT NOT NULL DEFAULT 'default'",
    "project_id": "ALTER TABLE task_states ADD COLUMN project_id TEXT NOT NULL DEFAULT ''",
    "requester_user_id": (
        "ALTER TABLE task_states ADD COLUMN requester_user_id TEXT NOT NULL DEFAULT ''"
    ),
    "owner_username": "ALTER TABLE task_states ADD COLUMN owner_username TEXT NOT NULL DEFAULT ''",
    "project_name": "ALTER TABLE task_states ADD COLUMN project_name TEXT NOT NULL DEFAULT ''",
}

_TASK_STATE_SCHEMA_COMPONENT = "task_state"
# MIGRATION CONTRACT: increment this whenever _TASK_STATE_SCHEMA_SQL,
# _TASK_STATE_COLUMN_UPGRADES, or schema indexes change. Existing databases
# skip the initializer after this version has been recorded.
_TASK_STATE_SCHEMA_VERSION = 1


def compute_expiry(ttl_seconds: int | None) -> str | None:
    """Compute the expiry time from a TTL."""
    if ttl_seconds is None:
        return None
    return (
        datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)
    ).isoformat().replace("+00:00", "Z")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# For the inline backend the worker shares the API process: an inline task still marked ACTIVE from before this process started
# has necessarily been interrupted (see _sweep_interrupted_inline_tasks_once).
_PROCESS_STARTED_AT = utc_now_iso()
if "." not in _PROCESS_STARTED_AT:
    # isoformat omits fractional digits on whole seconds; within the same second "...:56Z" sorts after "...:56.4Z",
    # which would misjudge a live task updated after startup in the same second as expired. Pad the fractional digits to remove that inversion.
    _PROCESS_STARTED_AT = _PROCESS_STARTED_AT.replace("Z", ".000000Z")


def parse_task_timestamp(value: str | None) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def get_project_task_db_path(username: str, project: str) -> Path:
    """Get the project-level task state SQLite path."""
    from novelvideo.utils.project_paths import ProjectPaths

    ProjectPaths(username, project).bootstrap_from_legacy_output()
    return (Path(STATE_DIR) / username / project / "data.db").resolve()


def get_project_task_db_path_for_context(ctx: ProjectContext) -> Path:
    """Project-local task state DB path for project_id based execution."""
    return (Path(ctx.state_dir) / "data.db").resolve()


@dataclass
class TaskState:
    """Task state data class.

    Attributes:
        task_id: unique task identifier
        task_type: task type (e.g. video_composer, script_writer)
        username: user name
        project: project name
        episode: episode number
        beat_num: Beat number (optional, for single-Beat tasks)
        scope: task scope (optional, for multiple parallel tasks within one episode)
        status: task status (submitting|queued|running|completed|failed|cancelled)
        progress: progress (0.0 - 1.0)
        current_task: description of the sub-task currently running
        result: task result (JSON-serializable dict)
        error: error message
        logs: the most recent N log lines
        created_at: creation time
        updated_at: update time
        completed_at: completion time
    """

    task_id: str
    task_type: str
    queue_kind: str = "default"
    username: str = ""
    project: str = ""
    episode: int = 0
    project_id: str = ""
    requester_user_id: str = ""
    owner_username: str = ""
    project_name: str = ""
    beat_num: Optional[int] = None
    scope: Optional[str] = None

    status: str = "pending"  # legacy default; Celery path uses submitting|queued|running
    progress: float = 0.0
    current_task: str = ""
    result: Optional[dict] = None
    metadata: Optional[dict] = None
    error: Optional[str] = None
    # Each entry is either a plain string (legacy / not-yet-migrated call sites) or {text, code, params}.
    logs: List = field(default_factory=list)

    created_at: str = ""
    updated_at: str = ""
    completed_at: str = ""
    expires_at: str = ""

    def is_starting_stale(self, timeout_seconds: int) -> bool:
        if self.status != "starting":
            return False
        last_update = parse_task_timestamp(self.updated_at or self.created_at)
        if last_update is None:
            return False
        return (datetime.now(timezone.utc) - last_update).total_seconds() >= timeout_seconds


class TaskStateManager:
    """Task state manager - persisted in SQLite.

    Key design:
        task:{task_type}:project:{project_id}:{episode}[:beat_num][:scope]

    TTL policy:
        - submitting/queued/running: no TTL (maintained by the worker/backend)
        - completed/failed/cancelled: TTL = 1 hour (lets the frontend fetch results)
    """

    MAX_LOGS = 100  # keep the most recent 100 log lines
    COMPLETED_TTL = 3600  # keep for 1 hour after completion

    def __init__(self) -> None:
        # The zombie sweep runs only once per DB (see _sweep_interrupted_inline_tasks_once)
        self._swept_dbs: set[str] = set()
        self._sweep_db_locks: dict[str, threading.Lock] = {}
        self._sweep_lock = threading.Lock()
    STARTING_TIMEOUT = _env_int(
        "NOVELVIDEO_TASK_STARTING_TIMEOUT",
        180,
    )

    @staticmethod
    def _merge_metadata_into_result(
        result: dict | None,
        metadata: dict | None,
    ) -> dict | None:
        """Merge task metadata into result_json without changing the table schema."""
        if not metadata:
            return result
        if result is None:
            return {"task_metadata": metadata}
        if not isinstance(result, dict):
            return {"value": result, "task_metadata": metadata}
        merged = dict(result)
        merged["task_metadata"] = metadata
        return merged

    @staticmethod
    def _merge_task_metadata(existing: dict | None, incoming: dict | None) -> dict | None:
        if not existing:
            return incoming
        if not incoming:
            return existing
        return {**existing, **incoming}

    def _apply_progress_message(
        self,
        state: "TaskState",
        current_task: MessageLike,
        logs: Optional[List[MessageLike]],
    ) -> None:
        """Write the progress text and logs while preserving the i18n code/params.

        current_task / logs may be plain str (legacy call sites) or
        LocalizableMessage. The English fallback text stays in the existing columns, while code/params go into
        the structured entries of metadata and logs_json, so neither the CE tasks table nor the EE
        ee_task_states mirror needs a new column.
        """
        if current_task is not None:
            state.current_task = message_text(current_task)
            # Write even when the payload is None: a plain-string update must clear the previous message's
            # code, otherwise the frontend would use the stale code to translate the new text and show unrelated copy.
            state.metadata = self._merge_task_metadata(
                state.metadata,
                {"current_task_message": message_payload(current_task)},
            )
        if logs:
            state.logs = self._merge_logs(
                state.logs,
                [log_entry_payload(entry) for entry in logs],
                self.MAX_LOGS,
            )

    @staticmethod
    def _merge_logs(existing: List, incoming: List, max_logs: int) -> List:
        """Merge logs and remove the overlapping tail.

        The Actor side usually uploads `status.logs[-N:]`, not a pure increment.
        Drop the largest overlap between the suffix of existing and the prefix of incoming,
        so the same tail is not persisted repeatedly.
        """
        if not incoming:
            return existing[-max_logs:]
        if not existing:
            return incoming[-max_logs:]

        max_overlap = min(len(existing), len(incoming))
        overlap = 0
        for size in range(max_overlap, 0, -1):
            if existing[-size:] == incoming[:size]:
                overlap = size
                break

        merged = existing + incoming[overlap:]
        return merged[-max_logs:]

    def _key(
        self,
        task_type: str,
        username: str,
        project: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
    ) -> str:
        return task_state_key(
            task_type,
            username,
            project,
            episode,
            beat_num=beat_num,
            scope=scope,
        )

    def _project_key(
        self,
        task_type: str,
        project_id: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
    ) -> str:
        return project_task_state_key(
            task_type,
            project_id,
            episode,
            beat_num=beat_num,
            scope=scope,
        )

    @contextmanager
    def _connect_path(self, db_path: Path, *, skip_auto_sweep: bool = False):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_task_schema(db_path)
        conn = sqlite3.connect(db_path, timeout=10, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        # journal_mode is persistent and was established by the coordinated
        # schema initializer. Normal read/write connections must not request a
        # journal-mode transition or execute DDL.
        configure_sqlite_connection(conn, set_journal_mode=False)
        if not skip_auto_sweep:
            self._sweep_interrupted_inline_tasks_once(conn, db_path)
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    @staticmethod
    def _ensure_task_schema(db_path: Path) -> None:
        """Initialize/upgrade task tables once, serialized across processes."""

        def initialize(conn: sqlite3.Connection) -> None:
            conn.row_factory = sqlite3.Row
            conn.executescript(_TASK_STATE_SCHEMA_SQL)
            existing_columns = {
                str(row[1])
                for row in conn.execute("PRAGMA table_info(task_states)").fetchall()
            }
            for column, sql in _TASK_STATE_COLUMN_UPGRADES.items():
                if column not in existing_columns:
                    conn.execute(sql)
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_task_states_project_updated "
                "ON task_states(project_id, updated_at DESC)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_task_states_project_queue_status "
                "ON task_states(project_id, queue_kind, status)"
            )

        ensure_sqlite_schema(
            db_path,
            component=_TASK_STATE_SCHEMA_COMPONENT,
            version=_TASK_STATE_SCHEMA_VERSION,
            initialize=initialize,
        )

    @contextmanager
    def _connect(self, username: str, project: str):
        with self._connect_path(get_project_task_db_path(username, project)) as conn:
            yield conn

    @contextmanager
    def _connect_context(self, ctx: ProjectContext, *, skip_auto_sweep: bool = False):
        require_project_home_node(ctx, operation="open project task state")
        with self._connect_path(
            get_project_task_db_path_for_context(ctx),
            skip_auto_sweep=skip_auto_sweep,
        ) as conn:
            yield conn

    @staticmethod
    def _row_to_state(row) -> TaskState:
        result = json.loads(row["result_json"]) if row["result_json"] else None
        metadata = result.get("task_metadata") if isinstance(result, dict) else None
        logs = json.loads(row["logs_json"]) if row["logs_json"] else []
        project_id = row["project_id"] if "project_id" in row.keys() else ""
        if project_id:
            scope = project_task_scope_from_key(
                row["task_key"],
                task_type=row["task_type"],
                project_id=project_id,
                episode=row["episode"],
                beat_num=row["beat_num"],
            )
        else:
            scope = task_scope_from_key(
                row["task_key"],
                task_type=row["task_type"],
                username=row["username"],
                project=row["project"],
                episode=row["episode"],
                beat_num=row["beat_num"],
            )
        return TaskState(
            task_id=row["task_id"],
            task_type=row["task_type"],
            queue_kind=row["queue_kind"] if "queue_kind" in row.keys() else "default",
            project_id=project_id,
            requester_user_id=row["requester_user_id"] if "requester_user_id" in row.keys() else "",
            owner_username=row["owner_username"] if "owner_username" in row.keys() else "",
            project_name=row["project_name"] if "project_name" in row.keys() else "",
            username=row["username"],
            project=row["project"],
            episode=row["episode"],
            beat_num=row["beat_num"],
            scope=scope,
            status=row["status"],
            progress=row["progress"],
            current_task=row["current_task"],
            result=result,
            metadata=metadata,
            error=row["error"],
            logs=logs,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            completed_at=row["completed_at"],
            expires_at=row["expires_at"] if "expires_at" in row.keys() else "",
        )

    @staticmethod
    def _is_expired(expires_at: str | None) -> bool:
        expires = parse_task_timestamp(expires_at)
        if expires is None:
            return False
        return expires <= datetime.now(timezone.utc)

    def _delete_expired_key(self, task_key: str) -> None:
        username, project = self._project_from_task_key(task_key)
        with self._connect(username, project) as conn:
            conn.execute("DELETE FROM task_states WHERE task_key = ?", (task_key,))

    def _delete_expired_project_key(self, ctx: ProjectContext, task_key: str) -> None:
        with self._connect_context(ctx) as conn:
            conn.execute(
                "DELETE FROM task_states WHERE task_key = ? AND project_id = ?",
                (task_key, ctx.project_id),
            )

    @staticmethod
    def _project_from_task_key(task_key: str) -> tuple[str, str]:
        """Recover username/project from a task_key."""
        parts = task_key.split(":")
        if len(parts) < 5:
            raise ValueError(f"Invalid task key: {task_key}")
        _, _task_type, username, project, *_rest = parts
        return username, project

    @staticmethod
    def _list_project_db_paths(username: str) -> list[Path]:
        project_db_paths: dict[str, Path] = {}
        for user_dir in (
            (Path(STATE_DIR) / username).resolve(),
            (Path(OUTPUT_DIR) / username).resolve(),
        ):
            if not user_dir.exists():
                continue
            for project_dir in user_dir.iterdir():
                if not project_dir.is_dir():
                    continue
                project_name = project_dir.name
                if project_name in project_db_paths:
                    continue
                db_path = project_dir / "data.db"
                if db_path.exists():
                    project_db_paths[project_name] = db_path
        return sorted(project_db_paths.values())

    def create_task(
        self,
        task_type: str,
        username: str,
        project: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
        metadata: dict | None = None,
        status: str = "pending",
    ) -> TaskState:
        """Create a new task.

        Called from the Actor's __init__ to mark the task as started.

        Args:
            task_type: task type (e.g. video_composer)
            username: user name
            project: project name
            episode: episode number
            beat_num: Beat number (optional)
            scope: task scope (optional, for extra dimensions such as mode_key and grid_index)
            metadata: extra task metadata (kept for legacy callers; written to result_json.task_metadata)

        Returns:
            The newly created TaskState
        """
        state = TaskState(
            task_id=str(uuid.uuid4()),
            task_type=task_type,
            username=username,
            project=project,
            episode=episode,
            beat_num=beat_num,
            scope=scope,
            status=status,
            result=self._merge_metadata_into_result(None, metadata),
            metadata=metadata,
            created_at=utc_now_iso(),
            updated_at=utc_now_iso(),
        )
        self._save(state)
        logger.info(f"Task created: {task_type}/{username}/{project}/{episode}")
        return state

    def create_task_for_project(
        self,
        ctx: ProjectContext,
        task_type: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
        metadata: dict | None = None,
        status: str = "queued",
        queue_kind: str = "default",
    ) -> TaskState:
        """Create a project_id based task state row.

        This is the canonical path for Celery/new API execution.
        """
        normalized_queue_kind = normalize_queue_kind(queue_kind)
        now = utc_now_iso()
        state = TaskState(
            task_id=str(uuid.uuid4()),
            task_type=task_type,
            queue_kind=normalized_queue_kind,
            project_id=ctx.project_id,
            requester_user_id=ctx.requester_user_id,
            owner_username=ctx.owner_username,
            project_name=ctx.project_name,
            username=ctx.requester_username,
            project=ctx.project_name,
            episode=episode,
            beat_num=beat_num,
            scope=scope,
            status=status,
            result=self._merge_metadata_into_result(None, metadata),
            metadata=metadata,
            created_at=now,
            updated_at=now,
        )
        ttl = self.COMPLETED_TTL if status in TERMINAL_TASK_STATUSES else None
        self._save_for_context(ctx, state, ttl=ttl)
        logger.info("Project task created: %s/%s/%s", task_type, ctx.project_id, episode)
        return state

    def reserve_task_for_project(
        self,
        ctx: ProjectContext,
        task_type: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
        metadata: dict | None = None,
        queue_kind: str = "default",
        project_lane_limit=_PROJECT_LANE_LIMIT_UNSET,
    ) -> tuple[TaskState, bool]:
        """Reserve an active project task slot atomically.

        The reservation is the product-layer idempotency lock. It prevents two
        concurrent HTTP requests from delivering the same business task twice.
        """
        task_key = project_task_state_key(
            task_type,
            ctx.project_id,
            episode,
            beat_num=beat_num,
            scope=scope,
        )
        from novelvideo.task_backend.limits import (
            ProjectTaskLimitExceeded,
            ProjectUserTaskLimitExceeded,
            project_lane_active_limit,
            project_user_lane_active_limit,
        )

        normalized_queue_kind = normalize_queue_kind(queue_kind)
        now = utc_now_iso()
        with self._connect_context(ctx) as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM task_states WHERE task_key = ? AND project_id = ?",
                (task_key, ctx.project_id),
            ).fetchone()
            if row:
                if self._is_expired(row["expires_at"]):
                    conn.execute(
                        "DELETE FROM task_states WHERE task_key = ? AND project_id = ?",
                        (task_key, ctx.project_id),
                    )
                else:
                    existing = self._row_to_state(row)
                    if existing.status in ACTIVE_PROJECT_TASK_STATUSES:
                        return existing, False

            limit = (
                project_lane_active_limit(normalized_queue_kind)
                if project_lane_limit is _PROJECT_LANE_LIMIT_UNSET
                else project_lane_limit
            )
            if limit is not None:
                active = self._count_active_project_tasks_on_connection(
                    conn,
                    project_id=ctx.project_id,
                    queue_kind=normalized_queue_kind,
                )
                if active >= limit:
                    raise ProjectTaskLimitExceeded(
                        project_id=ctx.project_id,
                        queue_kind=normalized_queue_kind,
                        limit=limit,
                        active=active,
                    )

            user_limit = project_user_lane_active_limit(normalized_queue_kind)
            if user_limit is not None:
                user_active = self._count_active_project_tasks_on_connection(
                    conn,
                    project_id=ctx.project_id,
                    queue_kind=normalized_queue_kind,
                    requester_user_id=ctx.requester_user_id,
                )
                if user_active >= user_limit:
                    raise ProjectUserTaskLimitExceeded(
                        project_id=ctx.project_id,
                        requester_user_id=ctx.requester_user_id,
                        queue_kind=normalized_queue_kind,
                        limit=user_limit,
                        active=user_active,
                    )

            state = TaskState(
                task_id=str(uuid.uuid4()),
                task_type=task_type,
                queue_kind=normalized_queue_kind,
                project_id=ctx.project_id,
                requester_user_id=ctx.requester_user_id,
                owner_username=ctx.owner_username,
                project_name=ctx.project_name,
                username=ctx.requester_username,
                project=ctx.project_name,
                episode=episode,
                beat_num=beat_num,
                scope=scope,
                status="submitting",
                progress=0.0,
                current_task="",
                result=self._merge_metadata_into_result(None, metadata),
                metadata=metadata,
                created_at=now,
                updated_at=now,
            )
            # The initial text does not go through update_progress_for_project; writing the fields directly would leave no code to translate.
            # Add it here so the English UI does not flash a non-English line.
            self._apply_progress_message(
                state, lmsg("tasks.progress.submitting", "Task is being submitted"), None
            )
            self._save_on_connection(conn, task_key, state, None)
            return state, True

    def begin_task_execution_for_project(
        self,
        ctx: ProjectContext,
        task_type: str,
        episode: int,
        *,
        beat_num: int | None = None,
        scope: str | None = None,
        expected_task_id: str,
        metadata: dict | None = None,
    ) -> bool:
        """Atomically move one queued task into ``running``.

        The cancellation API uses the inverse compare-and-set operation.  A
        worker and a queued-task cancellation therefore cannot both win the
        queued state, even when they arrive at the same instant.
        """
        task_key = project_task_state_key(
            task_type,
            ctx.project_id,
            episode,
            beat_num=beat_num,
            scope=scope,
        )
        with self._connect_context(ctx) as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM task_states WHERE task_key = ? AND project_id = ?",
                (task_key, ctx.project_id),
            ).fetchone()
            if row is None:
                return False
            state = self._row_to_state(row)
            if state.task_id != expected_task_id:
                return False
            if state.status == "running":
                return True
            if state.status not in {"submitting", "queued"}:
                return False
            state.status = "running"
            state.progress = max(float(state.progress or 0.0), 0.01)
            # Go through the helper instead of assigning directly: a direct assignment only replaces the fallback text, and the previous
            # tasks.progress.queued code would stay in metadata, making the English UI show a
            # running task as "Task queued".
            self._apply_progress_message(
                state, lmsg("tasks.progress.started", "Task started"), None
            )
            if metadata is not None:
                state.metadata = self._merge_task_metadata(state.metadata, metadata)
                state.result = self._merge_metadata_into_result(state.result, state.metadata)
            state.updated_at = utc_now_iso()
            self._save_on_connection(conn, task_key, state, None)
            return True

    def cancel_queued_task_for_project(
        self,
        ctx: ProjectContext,
        task_type: str,
        episode: int,
        *,
        beat_num: int | None = None,
        scope: str | None = None,
        expected_task_id: str,
    ) -> tuple[bool, TaskState | None]:
        """Atomically cancel only a task that has not started executing."""
        task_key = project_task_state_key(
            task_type,
            ctx.project_id,
            episode,
            beat_num=beat_num,
            scope=scope,
        )
        with self._connect_context(ctx) as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM task_states WHERE task_key = ? AND project_id = ?",
                (task_key, ctx.project_id),
            ).fetchone()
            if row is None:
                return False, None
            state = self._row_to_state(row)
            if state.task_id != expected_task_id:
                return False, state
            if state.status not in {"submitting", "queued"}:
                return False, state
            state.status = "cancelled"
            self._apply_progress_message(
                state, lmsg("tasks.progress.cancelled", "Task cancelled"), None
            )
            state.completed_at = state.completed_at or utc_now_iso()
            state.updated_at = utc_now_iso()
            state.metadata = self._merge_task_metadata(
                state.metadata,
                {
                    "cancel_requested": True,
                    "cancelled_before_execution": True,
                    "refund_eligible": True,
                },
            )
            state.result = self._merge_metadata_into_result(state.result, state.metadata)
            self._save_on_connection(conn, task_key, state, self.COMPLETED_TTL)
            return True, state

    def mark_task_enqueued_for_project(
        self,
        ctx: ProjectContext,
        task_type: str,
        episode: int,
        *,
        beat_num: int | None = None,
        scope: str | None = None,
        expected_task_id: str,
        metadata: dict | None = None,
    ) -> bool:
        """Persist broker metadata without regressing ``running`` to ``queued``."""
        task_key = project_task_state_key(
            task_type,
            ctx.project_id,
            episode,
            beat_num=beat_num,
            scope=scope,
        )
        with self._connect_context(ctx) as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM task_states WHERE task_key = ? AND project_id = ?",
                (task_key, ctx.project_id),
            ).fetchone()
            if row is None:
                return False
            state = self._row_to_state(row)
            if state.task_id != expected_task_id or state.status in TERMINAL_TASK_STATUSES:
                return False
            if state.status in {"submitting", "queued"}:
                state.status = "queued"
                state.progress = 0.0
                self._apply_progress_message(
                    state, lmsg("tasks.progress.queued", "Task queued"), None
                )
            if metadata is not None:
                state.metadata = self._merge_task_metadata(state.metadata, metadata)
                state.result = self._merge_metadata_into_result(state.result, state.metadata)
            state.updated_at = utc_now_iso()
            self._save_on_connection(conn, task_key, state, None)
            return True

    def _count_active_project_tasks_on_connection(
        self,
        conn: sqlite3.Connection,
        *,
        project_id: str,
        queue_kind: str | None = None,
        requester_user_id: str | None = None,
    ) -> int:
        predicates = ["project_id = ?"]
        params: list[str] = [project_id]
        if queue_kind is not None:
            predicates.append("queue_kind = ?")
            params.append(normalize_queue_kind(queue_kind))
            # These tasks only wait for externally produced delivery receipts.
            # Counting them as generation slots makes a workflow block itself
            # before the node that produces those receipts can start.
            predicates.append(
                "task_type NOT IN ('freezone_agent_workflow_result', "
                "'freezone_agent_recipe_result', 'freezone_agent_workflow_generate', "
                "'freezone_agent_recipe_generate')"
            )
        if requester_user_id is not None:
            predicates.append("requester_user_id = ?")
            params.append(requester_user_id)
        placeholders = ",".join("?" for _ in ACTIVE_PROJECT_TASK_STATUSES)
        params.extend(ACTIVE_PROJECT_TASK_STATUSES)
        row = conn.execute(
            "SELECT COUNT(*) FROM task_states "
            f"WHERE {' AND '.join(predicates)} "
            f"AND status IN ({placeholders})",
            tuple(params),
        ).fetchone()
        return int(row[0]) if row else 0

    def update_progress(
        self,
        task_type: str,
        username: str,
        project: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
        progress: float = None,
        current_task: MessageLike = None,
        logs: List[MessageLike] | None = None,
        metadata: dict | None = None,
    ):
        """Update task progress (called by the Actor).

        Called periodically from the Actor's run method to update progress information.

        Args:
            task_type: task type
            username: user name
            project: project name
            episode: episode number
            beat_num: Beat number (optional)
            scope: task scope (optional)
            progress: progress (0.0 - 1.0)
            current_task: current sub-task description
            logs: newly added log list
            metadata: extra task metadata (written to result_json.task_metadata)
        """
        state = self.get_task(task_type, username, project, episode, beat_num, scope)
        if not state:
            # Rebuild the state when the task record is lost
            logger.warning(
                f"Task state missing, recreating: {task_type}/{username}/{project}/{episode}"
            )
            state = self.create_task(
                task_type, username, project, episode, beat_num, scope, metadata=None
            )

        if state.status in {"completed", "failed"}:
            logger.warning(
                "Ignore progress update for terminal task: %s/%s/%s/%s status=%s",
                task_type,
                username,
                project,
                episode,
                state.status,
            )
            return

        state.status = "running"
        if progress is not None:
            state.progress = progress
        self._apply_progress_message(state, current_task, logs)
        if metadata is not None:
            state.metadata = self._merge_task_metadata(state.metadata, metadata)
            state.result = self._merge_metadata_into_result(state.result, state.metadata)
        state.updated_at = utc_now_iso()
        self._save(state)

    def update_progress_for_project(
        self,
        ctx: ProjectContext,
        task_type: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
        progress: float = None,
        current_task: MessageLike = None,
        logs: List[MessageLike] | None = None,
        metadata: dict | None = None,
        status: str = "running",
        expected_task_id: str | None = None,
        queue_kind: str | None = None,
    ):
        expected_task_id = expected_task_id or _CURRENT_PROJECT_TASK_ID.get()
        state = self.get_task_for_project(ctx, task_type, episode, beat_num, scope)
        if not state:
            if expected_task_id:
                logger.warning(
                    "Ignore stale project task update for missing row: "
                    "%s/%s/%s expected_task_id=%s scope=%s",
                    task_type,
                    ctx.project_id,
                    episode,
                    expected_task_id,
                    scope,
                )
                return
            state = self.create_task_for_project(
                ctx,
                task_type,
                episode,
                beat_num,
                scope,
                metadata=metadata,
                status=status,
                queue_kind=_queue_kind_from_metadata(metadata, queue_kind),
            )
        if expected_task_id and state.task_id != expected_task_id:
            logger.warning(
                "Ignore stale project task update: %s/%s/%s expected_task_id=%s current_task_id=%s",
                task_type,
                ctx.project_id,
                episode,
                expected_task_id,
                state.task_id,
            )
            return
        if state.status in TERMINAL_TASK_STATUSES:
            logger.warning(
                "Ignore progress update for terminal project task: %s/%s/%s status=%s",
                task_type,
                ctx.project_id,
                episode,
                state.status,
            )
            return

        state.status = status
        if status in {"completed", "failed", "cancelled"} and not state.completed_at:
            state.completed_at = utc_now_iso()
        if progress is not None:
            state.progress = progress
        self._apply_progress_message(state, current_task, logs)
        if metadata is not None:
            state.metadata = self._merge_task_metadata(state.metadata, metadata)
            state.result = self._merge_metadata_into_result(state.result, state.metadata)
        state.updated_at = utc_now_iso()
        ttl = self.COMPLETED_TTL if status in TERMINAL_TASK_STATUSES else None
        self._save_for_context(ctx, state, ttl=ttl)

    def complete_task(
        self,
        task_type: str,
        username: str,
        project: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
        result: dict = None,
        progress: float | None = None,
        current_task: MessageLike = None,
        logs: List[MessageLike] | None = None,
        metadata: dict | None = None,
    ):
        """Mark a task as completed (called by the Actor before exiting).

        Key: must be called before the Actor exits, so the result is persisted.

        Args:
            task_type: task type
            username: user name
            project: project name
            episode: episode number
            beat_num: Beat number (optional)
            scope: task scope (optional)
            result: task result
            progress: final progress
            current_task: final current-task description
            logs: final log snapshot
            metadata: extra task metadata (kept for legacy callers; written to result_json.task_metadata)
        """
        state = self.get_task(task_type, username, project, episode, beat_num, scope)
        if not state:
            # Record the completed state even if the record is lost
            logger.warning(
                "Task state missing on complete, creating: %s/%s/%s/%s",
                task_type,
                username,
                project,
                episode,
            )
            state = self.create_task(
                task_type, username, project, episode, beat_num, scope, metadata=metadata
            )

        state.status = "completed"
        state.progress = 1.0 if progress is None else progress
        self._apply_progress_message(state, current_task, logs)
        merged_metadata = self._merge_task_metadata(state.metadata, metadata)
        state.result = self._merge_metadata_into_result(result, merged_metadata)
        state.error = None
        if merged_metadata is not None:
            state.metadata = merged_metadata
        state.completed_at = utc_now_iso()
        state.updated_at = utc_now_iso()
        self._save(state, ttl=self.COMPLETED_TTL)
        logger.info(f"Task completed: {task_type}/{username}/{project}/{episode}")

    def complete_task_for_project(
        self,
        ctx: ProjectContext,
        task_type: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
        result: dict = None,
        progress: float | None = None,
        current_task: MessageLike = None,
        logs: List[MessageLike] | None = None,
        metadata: dict | None = None,
        expected_task_id: str | None = None,
        queue_kind: str | None = None,
    ) -> bool:
        expected_task_id = expected_task_id or _CURRENT_PROJECT_TASK_ID.get()
        state = self.get_task_for_project(ctx, task_type, episode, beat_num, scope)
        if not state:
            if expected_task_id:
                logger.warning(
                    "Ignore stale project task complete for missing row: "
                    "%s/%s/%s expected_task_id=%s scope=%s",
                    task_type,
                    ctx.project_id,
                    episode,
                    expected_task_id,
                    scope,
                )
                return False
            state = self.create_task_for_project(
                ctx,
                task_type,
                episode,
                beat_num,
                scope,
                metadata=metadata,
                queue_kind=_queue_kind_from_metadata(metadata, queue_kind),
            )
        if expected_task_id and state.task_id != expected_task_id:
            logger.warning(
                "Ignore stale project task complete: "
                "%s/%s/%s expected_task_id=%s current_task_id=%s",
                task_type,
                ctx.project_id,
                episode,
                expected_task_id,
                state.task_id,
            )
            return False
        if state.status == "cancelled":
            logger.warning(
                "Ignore complete update for cancelled project task: %s/%s/%s",
                task_type,
                ctx.project_id,
                episode,
            )
            return False
        state.status = "completed"
        state.progress = 1.0 if progress is None else progress
        self._apply_progress_message(state, current_task, logs)
        merged_metadata = self._merge_task_metadata(state.metadata, metadata)
        state.result = self._merge_metadata_into_result(result, merged_metadata)
        state.error = None
        if merged_metadata is not None:
            state.metadata = merged_metadata
        state.completed_at = utc_now_iso()
        state.updated_at = utc_now_iso()
        self._save_for_context(ctx, state, ttl=self.COMPLETED_TTL)
        logger.info("Project task completed: %s/%s/%s", task_type, ctx.project_id, episode)
        return True

    def fail_task(
        self,
        task_type: str,
        username: str,
        project: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
        error: str = None,
        progress: float | None = None,
        current_task: MessageLike = None,
        logs: List[MessageLike] | None = None,
        metadata: dict | None = None,
    ):
        """Mark a task as failed (called by the Actor on exception).

        Args:
            task_type: task type
            username: user name
            project: project name
            episode: episode number
            beat_num: Beat number (optional)
            scope: task scope (optional)
            error: error message
        """
        state = self.get_task(task_type, username, project, episode, beat_num, scope)
        if not state:
            # Record the failed state even if the record is lost
            logger.warning(
                f"Task state missing on fail, creating: {task_type}/{username}/{project}/{episode}"
            )
            state = self.create_task(
                task_type, username, project, episode, beat_num, scope, metadata=metadata
            )

        state.status = "failed"
        if error is not None:
            state.error = error
        if progress is not None:
            state.progress = progress
        self._apply_progress_message(state, current_task, logs)
        if metadata is not None:
            state.metadata = self._merge_task_metadata(state.metadata, metadata)
            state.result = self._merge_metadata_into_result(state.result, state.metadata)
        state.completed_at = utc_now_iso()
        state.updated_at = utc_now_iso()
        self._save(state, ttl=self.COMPLETED_TTL)
        logger.warning(f"Task failed: {task_type}/{username}/{project}/{episode}: {error}")

    def fail_task_for_project(
        self,
        ctx: ProjectContext,
        task_type: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
        error: str = None,
        progress: float | None = None,
        current_task: MessageLike = None,
        logs: List[MessageLike] | None = None,
        metadata: dict | None = None,
        expected_task_id: str | None = None,
        queue_kind: str | None = None,
    ):
        expected_task_id = expected_task_id or _CURRENT_PROJECT_TASK_ID.get()
        state = self.get_task_for_project(ctx, task_type, episode, beat_num, scope)
        if not state:
            if expected_task_id:
                logger.warning(
                    "Ignore stale project task fail for missing row: "
                    "%s/%s/%s expected_task_id=%s scope=%s",
                    task_type,
                    ctx.project_id,
                    episode,
                    expected_task_id,
                    scope,
                )
                return
            state = self.create_task_for_project(
                ctx,
                task_type,
                episode,
                beat_num,
                scope,
                metadata=metadata,
                queue_kind=_queue_kind_from_metadata(metadata, queue_kind),
            )
        if expected_task_id and state.task_id != expected_task_id:
            logger.warning(
                "Ignore stale project task fail: %s/%s/%s expected_task_id=%s current_task_id=%s",
                task_type,
                ctx.project_id,
                episode,
                expected_task_id,
                state.task_id,
            )
            return
        if state.status == "cancelled":
            logger.warning(
                "Ignore fail update for cancelled project task: %s/%s/%s",
                task_type,
                ctx.project_id,
                episode,
            )
            return
        state.status = "failed"
        if error is not None:
            state.error = error
        if progress is not None:
            state.progress = progress
        self._apply_progress_message(state, current_task, logs)
        if metadata is not None:
            state.metadata = self._merge_task_metadata(state.metadata, metadata)
            state.result = self._merge_metadata_into_result(state.result, state.metadata)
        state.completed_at = utc_now_iso()
        state.updated_at = utc_now_iso()
        self._save_for_context(ctx, state, ttl=self.COMPLETED_TTL)
        logger.warning(
            "Project task failed: %s/%s/%s: %s",
            task_type,
            ctx.project_id,
            episode,
            error,
        )

    def get_task(
        self,
        task_type: str,
        username: str,
        project: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
    ) -> Optional[TaskState]:
        """Get the task state (called by the frontend).

        Args:
            task_type: task type
            username: user name
            project: project name
            episode: episode number
            beat_num: Beat number (optional)
            scope: task scope (optional)

        Returns:
            TaskState, or None (if it does not exist)
        """
        key = self._key(task_type, username, project, episode, beat_num, scope)
        with self._connect(username, project) as conn:
            row = conn.execute(
                "SELECT * FROM task_states WHERE task_key = ?",
                (key,),
            ).fetchone()

        if not row:
            return None
        if self._is_expired(row["expires_at"]):
            self._delete_expired_key(key)
            return None
        return self._row_to_state(row)

    # celery/EE workers are independent of this process, so "interrupted before the process started" cannot be judged; only a TTL can reap them:
    # 40min = task_time_limit 35min (celery config in EE celery_app.py)
    # + 5min margin. An in-flight row not updated within that has had its worker hard-killed by the timeout.
    CELERY_STALE_TTL = 40 * 60

    def _sweep_stale_tasks_on_connection(self, conn) -> int | None:
        """Mark ACTIVE tasks that can no longer be running as failed (zombie reaping), on two axes:

        - inline: the worker dies with the API process, so anything older than this process start has necessarily been interrupted;
        - celery/EE: the worker is independent of this process; judged by CELERY_STALE_TTL (see its comment).

        The two axes are mutually exclusive by backend marker and do not leak into each other.
        Timestamps are compared as strings: both sides come from utc_now_iso and are guaranteed to carry fractional digits.
        """
        now = utc_now_iso()
        celery_stale_before = (
            datetime.now(timezone.utc) - timedelta(seconds=self.CELERY_STALE_TTL)
        ).isoformat().replace("+00:00", "Z")
        if "." not in celery_stale_before:
            # Same padding as _PROCESS_STARTED_AT: on whole seconds isoformat omits fractional digits,
            # "...:56Z" sorts after "...:56.4Z", which would sweep up live tasks within the same second.
            celery_stale_before = celery_stale_before.replace("Z", ".000000Z")
        try:
            inline_result = conn.execute(
                "UPDATE task_states SET status = 'failed', "
                "error = COALESCE(NULLIF(error, ''), ?), "
                "completed_at = ?, updated_at = ?, expires_at = ? "
                "WHERE status IN ('submitting', 'queued', 'running') "
                "AND updated_at < ? "
                "AND json_valid(result_json) "
                "AND json_extract(result_json, '$.task_metadata.backend') = 'inline'",
                (
                    "Service restarted, task interrupted; please start it again",
                    now,
                    now,
                    compute_expiry(self.COMPLETED_TTL),
                    _PROCESS_STARTED_AT,
                ),
            )
            celery_result = conn.execute(
                "UPDATE task_states SET status = 'failed', "
                "error = COALESCE(NULLIF(error, ''), ?), "
                "completed_at = ?, updated_at = ?, expires_at = ? "
                "WHERE status IN ('submitting', 'queued', 'running') "
                "AND updated_at < ? "
                "AND json_valid(result_json) "
                "AND json_extract(result_json, '$.task_metadata.backend') = 'celery'",
                (
                    "Task timed out without updates, worker interrupted; please start it again",
                    now,
                    now,
                    compute_expiry(self.COMPLETED_TTL),
                    celery_stale_before,
                ),
            )
            conn.commit()
        except sqlite3.OperationalError as exc:
            conn.rollback()
            logger.warning("stale task sweep skipped: %s", exc)
            return None
        return inline_result.rowcount + celery_result.rowcount

    def _sweep_interrupted_inline_tasks_once(self, conn, db_path: Path) -> None:
        """On the first open of each DB by a normal connection, run the sweep; on failure, leave it for the next connection to retry."""
        key = str(db_path.resolve())
        with self._sweep_lock:
            if key in self._swept_dbs:
                return
            db_lock = self._sweep_db_locks.setdefault(key, threading.Lock())
        with db_lock:
            with self._sweep_lock:
                if key in self._swept_dbs:
                    return
            changed = self._sweep_stale_tasks_on_connection(conn)
            if changed is not None:
                with self._sweep_lock:
                    self._swept_dbs.add(key)

    def sweep_stale_tasks_for_project(self, ctx: ProjectContext) -> int | None:
        """Explicitly and repeatably sweep in-flight tasks in the project DB that have lost their worker."""
        require_project_home_node(ctx, operation="sweep stale project tasks")
        db_path = get_project_task_db_path_for_context(ctx).resolve()
        key = str(db_path)
        with self._sweep_lock:
            db_lock = self._sweep_db_locks.setdefault(key, threading.Lock())
        with self._connect_path(db_path, skip_auto_sweep=True) as conn:
            with db_lock:
                return self._sweep_stale_tasks_on_connection(conn)

    def get_task_for_project(
        self,
        ctx: ProjectContext,
        task_type: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
    ) -> Optional[TaskState]:
        key = self._project_key(task_type, ctx.project_id, episode, beat_num, scope)
        with self._connect_context(ctx) as conn:
            row = conn.execute(
                "SELECT * FROM task_states WHERE task_key = ? AND project_id = ?",
                (key, ctx.project_id),
            ).fetchone()

        if not row:
            return None
        if self._is_expired(row["expires_at"]):
            self._delete_expired_project_key(ctx, key)
            return None
        return self._row_to_state(row)

    def delete_task(
        self,
        task_type: str,
        username: str,
        project: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
    ):
        """Delete the task state.

        Called when restarting a task or cleaning up old state.

        Args:
            task_type: task type
            username: user name
            project: project name
            episode: episode number
            beat_num: Beat number (optional)
            scope: task scope (optional)
        """
        key = self._key(task_type, username, project, episode, beat_num, scope)
        with self._connect(username, project) as conn:
            conn.execute("DELETE FROM task_states WHERE task_key = ?", (key,))
        logger.debug(f"Task deleted: {key}")

    def delete_task_for_project(
        self,
        ctx: ProjectContext,
        task_type: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
        expected_task_id: str | None = None,
    ) -> bool:
        if not expected_task_id:
            raise ValueError("expected_task_id is required to delete project task state")
        key = self._project_key(task_type, ctx.project_id, episode, beat_num, scope)
        with self._connect_context(ctx) as conn:
            cursor = conn.execute(
                """DELETE FROM task_states
                   WHERE task_key = ? AND project_id = ? AND task_id = ?""",
                (key, ctx.project_id, expected_task_id),
            )
        deleted = cursor.rowcount > 0
        if deleted:
            logger.debug("Project task deleted: %s", key)
        return deleted

    def list_tasks_for_project(self, ctx: ProjectContext) -> List[TaskState]:
        tasks: list[TaskState] = []
        expired_keys: list[str] = []
        with self._connect_context(ctx) as conn:
            rows = conn.execute(
                "SELECT * FROM task_states WHERE project_id = ? ORDER BY updated_at DESC",
                (ctx.project_id,),
            ).fetchall()

            for row in rows:
                if self._is_expired(row["expires_at"]):
                    expired_keys.append(row["task_key"])
                    continue
                try:
                    tasks.append(self._row_to_state(row))
                except Exception as e:
                    logger.warning(
                        "Failed to parse project task state for key %s: %s",
                        row["task_key"],
                        e,
                    )

            if expired_keys:
                conn.executemany(
                    "DELETE FROM task_states WHERE task_key = ? AND project_id = ?",
                    [(key, ctx.project_id) for key in expired_keys],
                )

        tasks.sort(key=lambda task: task.updated_at or task.created_at or "", reverse=True)
        return tasks

    def count_active_tasks_for_project(self, ctx: ProjectContext) -> int:
        try:
            with self._connect_context(ctx) as conn:
                    return self._count_active_project_tasks_on_connection(
                    conn,
                    project_id=ctx.project_id,
                )
        except Exception:
            return 0

    def count_active_tasks_for_project_lane(
        self,
        ctx: ProjectContext,
        queue_kind: str | None,
    ) -> int:
        try:
            with self._connect_context(ctx) as conn:
                return self._count_active_project_tasks_on_connection(
                    conn,
                    project_id=ctx.project_id,
                    queue_kind=queue_kind,
                )
        except Exception:
            return 0

    def count_active_tasks_for_project_user_lane(
        self,
        ctx: ProjectContext,
        queue_kind: str | None,
    ) -> int:
        try:
            with self._connect_context(ctx) as conn:
                return self._count_active_project_tasks_on_connection(
                    conn,
                    project_id=ctx.project_id,
                    queue_kind=queue_kind,
                    requester_user_id=ctx.requester_user_id,
                )
        except Exception:
            return 0

    def list_tasks_for_user(self, username: str) -> List[TaskState]:
        """List all tasks of a user.

        Args:
            username: user name

        Returns:
            List of tasks sorted by update time, newest first
        """
        tasks = []
        for db_path in self._list_project_db_paths(username):
            project = db_path.parent.name
            expired_keys = []
            with self._connect(username, project) as conn:
                rows = conn.execute(
                    "SELECT * FROM task_states WHERE username = ? ORDER BY updated_at DESC",
                    (username,),
                ).fetchall()

                for row in rows:
                    if self._is_expired(row["expires_at"]):
                        expired_keys.append(row["task_key"])
                        continue
                    try:
                        tasks.append(self._row_to_state(row))
                    except Exception as e:
                        logger.warning(f"Failed to parse task state for key {row['task_key']}: {e}")

                if expired_keys:
                    conn.executemany(
                        "DELETE FROM task_states WHERE task_key = ?",
                        [(key,) for key in expired_keys],
                    )

        tasks.sort(key=lambda task: task.updated_at or task.created_at or "", reverse=True)
        return tasks

    def count_active_tasks_for_user(self, username: str) -> int:
        """Count active tasks across all of a user's projects (lightweight COUNT query; rows are not deserialized)."""
        count = 0
        for db_path in self._list_project_db_paths(username):
            project = db_path.parent.name
            try:
                with self._connect(username, project) as conn:
                    placeholders = ",".join("?" for _ in ACTIVE_PROJECT_TASK_STATUSES)
                    row = conn.execute(
                        "SELECT COUNT(*) FROM task_states "
                        f"WHERE username = ? AND status IN ({placeholders})",
                        (username, *ACTIVE_PROJECT_TASK_STATUSES),
                    ).fetchone()
                    count += row[0]
            except Exception:
                continue
        return count

    def _save(self, state: TaskState, ttl: int = None):
        """Save the task state to SQLite.

        Args:
            state: task state
            ttl: expiry in seconds; None means no expiry
        """
        task_key = self._task_key_for_state(state)
        expires_at = compute_expiry(ttl)
        with self._connect(state.username, state.project) as conn:
            self._save_on_connection(conn, task_key, state, expires_at)

    def _save_for_context(self, ctx: ProjectContext, state: TaskState, ttl: int = None):
        state.project_id = state.project_id or ctx.project_id
        state.requester_user_id = state.requester_user_id or ctx.requester_user_id
        state.owner_username = state.owner_username or ctx.owner_username
        state.project_name = state.project_name or ctx.project_name
        state.username = state.username or ctx.requester_username
        state.project = state.project or ctx.project_name
        task_key = self._task_key_for_state(state)
        expires_at = compute_expiry(ttl)
        with self._connect_context(ctx) as conn:
            self._save_on_connection(conn, task_key, state, expires_at)

    @staticmethod
    def _task_key_for_state(state: TaskState) -> str:
        if state.project_id:
            return project_task_state_key(
                state.task_type,
                state.project_id,
                state.episode,
                beat_num=state.beat_num,
                scope=state.scope,
            )
        return task_state_key(
            state.task_type,
            state.username,
            state.project,
            state.episode,
            beat_num=state.beat_num,
            scope=state.scope,
        )

    @staticmethod
    def _save_on_connection(conn, task_key: str, state: TaskState, expires_at: str | None) -> None:
        # metadata has no column of its own and is persisted via result_json.task_metadata (see _row_to_state).
        # The merge must happen at the write boundary rather than relying on each call site to sync: _apply_progress_message
        # changes state.metadata, and most call sites' manual merges sit under `if metadata is not None`,
        # so when the caller does not pass metadata the progress text's i18n code is lost at this hop --
        # the tasks.progress.submitting written by reserve and the
        # LocalizableMessage passed into update_progress were both lost this way, so the English UI still rendered the fallback text.
        result = TaskStateManager._merge_metadata_into_result(state.result, state.metadata)
        conn.execute(
            """
            INSERT INTO task_states (
                task_key, task_id, task_type, queue_kind, project_id, requester_user_id,
                owner_username, project_name, username, project, episode, beat_num,
                status, progress, current_task, result_json, error, logs_json,
                created_at, updated_at, completed_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(task_key) DO UPDATE SET
                task_id = excluded.task_id,
                task_type = excluded.task_type,
                queue_kind = excluded.queue_kind,
                project_id = excluded.project_id,
                requester_user_id = excluded.requester_user_id,
                owner_username = excluded.owner_username,
                project_name = excluded.project_name,
                username = excluded.username,
                project = excluded.project,
                episode = excluded.episode,
                beat_num = excluded.beat_num,
                status = excluded.status,
                progress = excluded.progress,
                current_task = excluded.current_task,
                result_json = excluded.result_json,
                error = excluded.error,
                logs_json = excluded.logs_json,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                completed_at = excluded.completed_at,
                expires_at = excluded.expires_at
            """,
            (
                task_key,
                state.task_id,
                state.task_type,
                state.queue_kind,
                state.project_id,
                state.requester_user_id,
                state.owner_username,
                state.project_name,
                state.username,
                state.project,
                state.episode,
                state.beat_num,
                state.status,
                state.progress,
                state.current_task,
                (json.dumps(result, ensure_ascii=False) if result is not None else None),
                state.error,
                json.dumps(state.logs, ensure_ascii=False),
                state.created_at,
                state.updated_at,
                state.completed_at,
                expires_at,
            ),
        )


# Global singleton
_task_manager: Optional[TaskStateManager] = None


def get_task_manager() -> TaskStateManager:
    """Get the TaskStateManager singleton.

    Returns:
        TaskStateManager instance
    """
    global _task_manager
    if _task_manager is None:
        _task_manager = TaskStateManager()
    return _task_manager


def set_task_manager(manager: Optional[TaskStateManager]) -> None:
    """Inject a TaskStateManager implementation (EE overrides the singleton at bootstrap).

    Args:
        manager: implementation instance; pass None to clear it so the default singleton is rebuilt on the next get_task_manager()
    """
    global _task_manager
    _task_manager = manager
