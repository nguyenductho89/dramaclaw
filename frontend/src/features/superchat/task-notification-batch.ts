import i18n from "i18next";
import { isTerminal } from "@/task-center/derivations";
import type { TaskState } from "@/task-center/types";

export interface ChatTaskBatchSummary {
  batchId: string;
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  episode: number;
  taskType: string;
}

function metadataString(task: TaskState, key: string): string {
  const value = task.metadata?.[key];
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

export function taskBatchId(task: TaskState): string {
  return metadataString(task, "batch_id");
}

export function taskBatchSize(task: TaskState): number {
  const value = Number(metadataString(task, "batch_size"));
  return Number.isInteger(value) && value > 1 && value <= 100 ? value : 0;
}

export function resolveChatTaskBatchSummary(
  tasks: Iterable<TaskState>,
  changedTask: TaskState,
): ChatTaskBatchSummary | null {
  const batchId = taskBatchId(changedTask);
  const total = taskBatchSize(changedTask);
  if (!batchId || !total || !isTerminal(changedTask)) return null;

  const batchTasks = [...tasks].filter((task) =>
    taskBatchId(task) === batchId &&
    (task.project_id ?? task.project) === (changedTask.project_id ?? changedTask.project)
  );
  if (batchTasks.length < total || batchTasks.some((task) => !isTerminal(task))) {
    return null;
  }

  const terminalTasks = batchTasks.slice(0, total);
  return {
    batchId,
    total,
    completed: terminalTasks.filter((task) => task.status === "completed").length,
    failed: terminalTasks.filter((task) => task.status === "failed").length,
    cancelled: terminalTasks.filter((task) => task.status === "cancelled").length,
    episode: changedTask.episode,
    taskType: changedTask.task_type,
  };
}

export function buildChatTaskBatchNotification(summary: ChatTaskBatchSummary): string {
  const episodeLabel = summary.episode > 0
    ? i18n.t("superchat.panel.taskBatch.episode", { episode: summary.episode })
    : "";
  const labelKey = summary.taskType === "single_video"
    ? "superchat.panel.taskBatch.label.video"
    : summary.taskType === "selected_regen"
      ? "superchat.panel.taskBatch.label.firstFrame"
      : summary.taskType === "sketch_grid_generation"
        ? "superchat.panel.taskBatch.label.sketchGrid"
        : "superchat.panel.taskBatch.label.task";
  if (summary.completed === summary.total) {
    const prefix = episodeLabel ? `${episodeLabel}: ` : "";
    return i18n.t("superchat.panel.taskBatch.allDone", {
      prefix,
      count: summary.total,
      label: i18n.t(labelKey, { count: summary.total }),
    });
  }

  const details = [
    i18n.t("superchat.panel.taskBatch.completedOf", { completed: summary.completed, total: summary.total }),
    summary.failed > 0 ? i18n.t("superchat.panel.taskBatch.failedCount", { count: summary.failed }) : "",
    summary.cancelled > 0 ? i18n.t("superchat.panel.taskBatch.cancelledCount", { count: summary.cancelled }) : "",
  ].filter(Boolean).join(", ");
  const prefix = episodeLabel ? `${episodeLabel}: ` : "";
  return i18n.t("superchat.panel.taskBatch.ended", {
    prefix,
    label: i18n.t(labelKey, { count: 1 }),
    details,
  });
}
