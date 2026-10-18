// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TaskLogEntry } from "@/task-center/types";

export type TaskStatus =
  | "submitting"
  | "queued"
  | "pending"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface Task {
  task_id?: string;
  task_type: string;
  username: string;
  project: string;
  project_id?: string;
  episode: number;
  beat_num?: number;
  scope?: string;
  status: TaskStatus;
  progress: number;
  current_task?: string;
  current_task_code?: string | null;
  current_task_params?: Record<string, unknown> | null;
  result?: unknown;
  metadata?: Record<string, unknown>;
  error?: string;
  logs?: string[];
  /** Logs carrying an i18n code; older backends do not send this field, so reads fall back to `logs`. */
  logs_i18n?: TaskLogEntry[];
  created_at?: string;
  task_type_label?: string;
  display_name?: string;
}

export interface TaskStreamEvent {
  status: TaskStatus;
  progress: number;
  current_task?: string;
  /** i18n key of current_task; call sites the backend has not migrated lack this field. */
  current_task_code?: string | null;
  current_task_params?: Record<string, unknown> | null;
  result?: unknown;
  error?: string;
  error_code?: string | null;
  logs?: string[];
  /** Logs carrying an i18n code; older backends do not send this field, so reads fall back to `logs`. */
  logs_i18n?: TaskLogEntry[];
}

// Re-export the task-center canonical types so new code can import from either
// `@/types/task` or `@/task-center/types` and get the same truth.
export type { TaskLogEntry, TaskState } from "@/task-center/types";
