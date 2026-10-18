// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { currentTaskText, isActive as isActiveTask, isTerminal } from "./derivations";
import { useTaskCenterStore } from "./store";
import type { TaskState } from "./types";

/**
 * Fallback duration for the gap where the API has accepted the request but the task has not entered the task center yet.
 *
 * After the enqueue API returns, the task takes one SSE/polling round trip to appear in the store; if this gap is not recognized,
 * the button's loading flashes and drops back. Conversely, if the task never appears because events were lost / trimmed,
 * loading must also be released when the time is up, otherwise the button would spin forever.
 */
const OPTIMISTIC_GRACE_MS = 15_000;

/** The first still-running task of this type in the task center; null if none. */
export function useActiveTaskOfType(
  taskType: string,
  options: { episode?: number } = {},
): TaskState | null {
  const { episode } = options;
  return useTaskCenterStore(
    useCallback(
      (state) => {
        for (const task of state.tasks.values()) {
          if (task.task_type !== taskType) continue;
          if (episode !== undefined && task.episode !== episode) continue;
          if (isActiveTask(task)) return task;
        }
        return null;
      },
      [taskType, episode],
    ),
  );
}

export interface TaskActivity {
  /** The active task record in the task center; null during the optimistic gap. */
  task: TaskState | null;
  /** Whether loading should be shown. */
  isActive: boolean;
  /**
   * The task center has taken over this project but the first `GET /tasks` has not come back, so `isActive` cannot be trusted at this moment
   * (after a hard refresh the store starts empty and any task would be judged "not running"). Trigger controls should
   * be disabled together, to avoid duplicate enqueues.
   *
   * Constantly false when no TaskCenterProvider is running - in that situation hydration never arrives,
   * and honoring it would disable the button permanently.
   */
  isRestoring: boolean;
  /** 0~1. */
  progress: number;
  /**
   * The current step text, already localized by `current_task_code`.
   *
   * The display layer renders this string directly; do not go back and read `task.current_task` - that is the backend's English fallback,
   * and rendering it in other UI languages is a missed translation (the scene build page once did exactly this).
   */
  currentTask: string;
  /**
   * Called after the enqueue API returns successfully, to cover the gap before the task enters the task center.
   *
   * Pass the `task_id` from the enqueue response whenever possible: as soon as the task center sees a terminal record with the same id it can
   * close the gap immediately, instead of waiting a full 15 seconds. If not passed, it falls back to pure timeout cover.
   */
  markStarted: (override?: { taskId?: string }) => void;
}

/**
 * Binds the loading state of a project-level task of some kind to the task center.
 *
 * Compared with writing it using only component-local state, the key difference is that it stays accurate after a refresh - the task center starts by
 * pulling the full list from `GET /tasks` once, so tasks still running in the background can be recognized again.
 */
export function useTaskActivity(
  taskType: string,
  options: { episode?: number } = {},
): TaskActivity {
  const task = useActiveTaskOfType(taskType, options);
  const { t } = useTranslation();
  // The provider calls setProject before it starts hydrating, so a non-empty projectId means "someone is managing it,
  // hydration will definitely arrive"; if empty, no provider is mounted at all and this flag must not be used to disable buttons.
  const isRestoring = useTaskCenterStore(
    (state) => state.projectId != null && !state.isHydrated,
  );
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [startedTaskId, setStartedTaskId] = useState<string | null>(null);
  // Whether this round of the optimistic window has already claimed a task center record.
  const sawTaskRef = useRef(false);

  const clearOptimistic = useCallback(() => {
    setStartedAt(null);
    setStartedTaskId(null);
  }, []);

  // Whether this round's task has already appeared in the task center as a terminal state.
  //
  // The `task` above only recognizes active tasks, so when "the very first sample hits a terminal state" it is null both before and after,
  // and the closing branch of sawTaskRef below never triggers. Here it watches the terminal state directly by task_id:
  // task_key is reused across rounds, only task_id uniquely identifies this particular run, and using it avoids being
  // fooled by the terminal record left over from the previous round (trimmed only after 1 hour) into thinking this round has ended.
  //
  // The selector can only return primitives: returning an object would trigger infinite re-renders from a new reference every time.
  const startedTaskSettled = useTaskCenterStore(
    useCallback(
      (state) => {
        if (startedTaskId == null) return false;
        for (const candidate of state.tasks.values()) {
          if (candidate.task_id === startedTaskId) return isTerminal(candidate);
        }
        return false;
      },
      [startedTaskId],
    ),
  );

  useEffect(() => {
    if (task) {
      // When the task really appears in the task center, the local optimistic marker steps down, and from then on the task center is the sole authority.
      sawTaskRef.current = true;
      clearOptimistic();
      return;
    }
    // A claimed task disappearing again = it has finished / failed / been cancelled. It must be closed out actively here:
    // SSE may arrive before the enqueue API response, in which case markStarted() is called after the task appeared,
    // `task` never changes again, and the branch above alone cannot clear the optimistic marker, so the button would keep spinning
    // until the 15s timeout.
    if (sawTaskRef.current) {
      sawTaskRef.current = false;
      clearOptimistic();
    }
  }, [task, clearOptimistic]);

  useEffect(() => {
    if (startedTaskSettled) clearOptimistic();
  }, [startedTaskSettled, clearOptimistic]);

  useEffect(() => {
    if (startedAt == null) return;
    const timer = window.setTimeout(clearOptimistic, OPTIMISTIC_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [startedAt, clearOptimistic]);

  const markStarted = useCallback((override?: { taskId?: string }) => {
    setStartedTaskId(override?.taskId ?? null);
    setStartedAt(Date.now());
  }, []);

  return {
    task,
    isActive: task != null || startedAt != null,
    isRestoring,
    progress: task?.progress ?? 0,
    currentTask: task ? currentTaskText(task, t) : "",
    markStarted,
  };
}
