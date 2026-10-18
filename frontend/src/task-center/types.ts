// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * One task log entry. A string is what call sites not yet migrated write directly; the object form carries an i18n code,
 * and text is still the English fallback (used when the locale entry is missing, or an old client reads a new backend).
 */
export type TaskLogEntry =
  | string
  | { text: string; code?: string | null; params?: Record<string, unknown> | null };

export type TaskStatus =
  | "submitting"
  | "queued"
  | "pending"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskState {
  task_key: string;
  task_id: string;
  task_type: string;
  username: string;
  project: string;
  project_id?: string;
  episode: number;
  beat_num: number | null;
  scope: string | null;
  status: TaskStatus;
  progress: number;
  current_task: string;
  /** The i18n entry key of current_task; call sites the backend has not migrated have no such field. */
  current_task_code?: string | null;
  current_task_params?: Record<string, unknown> | null;
  result: unknown | null;
  metadata?: Record<string, unknown> | null;
  error: string | null;
  error_code?: string | null;
  /**
   * The public contract has always been `string[]`. The structured version with an i18n code goes through `logs_i18n` separately,
   * so a new backend with an old frontend does not render logs as `[object Object]`. When reading use
   * `taskLogLinesOf(task, t)` instead of picking fields directly.
   */
  logs: string[];
  logs_i18n?: TaskLogEntry[];
  task_type_label?: string;
  display_name?: string;
  /** false = display_name is a business name supplied by the caller; true/default = English assembled by the backend from task_type, rebuilt by the frontend. */
  display_name_localizable?: boolean;
  created_at: string;
  updated_at: string;
  completed_at: string;
  expires_at?: string | null;
}

export type StreamHealth = "connecting" | "connected" | "reconnecting" | "polling" | "failed";

export type TaskEvent =
  | { type: "task_updated"; task: TaskState; previous: TaskState | null }
  | { type: "task_complete"; task: TaskState; previous: TaskState | null }
  | { type: "task_failed"; task: TaskState; previous: TaskState | null }
  | { type: "task_removed"; taskKey: string };

export type TaskEventType = TaskEvent["type"];
export type TaskEventListener = (e: TaskEvent) => void;
