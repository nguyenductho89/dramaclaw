// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { isActive as isActiveTask } from '@/task-center/derivations';
import { useTaskCenterStore } from '@/task-center/store';
import type { TaskState } from '@/task-center/types';

export interface NodeGenerationTaskState {
  taskKey: string;
  task: TaskState | null;
  taskIsActive: boolean;
  waitingForTaskRecord: boolean;
  optimisticOnly: boolean;
  isGenerating: boolean;
}

// Right after submission the node has written taskKey, but the task only appears in the task-center after an endpoint round trip + SSE/polling.
// In this gap `task` is still null, and if it counts neither as optimistic (taskKey
// already present) nor as waiting (task-center long hydrated), isGenerating would instantly drop back to
// false, and the loading mask would flash before coming back. A "just started" grace window based on generationStartedAt fills this gap -
// once the task really appears in the store its real active state is used, and the grace no longer
// takes part; outside the window (e.g. refresh-resuming an old task long since pruned) the stale local flag is no longer trusted.
const RECENTLY_STARTED_GRACE_MS = 10_000;

export function useNodeGenerationTaskState(data: unknown): NodeGenerationTaskState {
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const taskKey =
    typeof record.generationTaskKey === 'string' ? record.generationTaskKey.trim() : '';
  const task = useTaskCenterStore((state) =>
    taskKey ? state.tasks.get(taskKey) ?? null : null,
  );
  const taskCenterHydrated = useTaskCenterStore((state) => state.isHydrated);
  const taskIsActive = task ? isActiveTask(task) : false;
  const localGenerating = record.isGenerating === true;
  const startedAt =
    typeof record.generationStartedAt === 'number' ? record.generationStartedAt : null;
  const recentlyStarted =
    startedAt != null && Date.now() - startedAt < RECENTLY_STARTED_GRACE_MS;
  const waitingForTaskRecord =
    localGenerating &&
    taskKey.length > 0 &&
    !task &&
    (!taskCenterHydrated || recentlyStarted);
  const optimisticOnly = localGenerating && taskKey.length === 0;

  return {
    taskKey,
    task,
    taskIsActive,
    waitingForTaskRecord,
    optimisticOnly,
    isGenerating: taskIsActive || waitingForTaskRecord || optimisticOnly,
  };
}
