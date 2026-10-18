// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TaskLogEntry, TaskState, TaskStatus } from "./types";
import { stageForTaskType } from "@/lib/episode-stage-registry";
import type { TFn } from "@/lib/i18n-types";

export const isTerminal = (t: TaskState): boolean =>
  t.status === "completed" || t.status === "failed" || t.status === "cancelled";

export const isActive = (t: TaskState): boolean =>
  t.status === "submitting" ||
  t.status === "queued" ||
  t.status === "pending" ||
  t.status === "starting" ||
  t.status === "running";

export const ageMs = (t: TaskState, now: number = Date.now()): number =>
  now - Date.parse(t.updated_at);

function isInternalRunScope(scope: string | null | undefined): boolean {
  return /^scene_run_[a-z0-9]+$/i.test(scope ?? "") || /^prop_run_[a-z0-9]+$/i.test(scope ?? "");
}

function metaString(t: TaskState, key: string): string {
  const value = t.metadata?.[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Task type name. The backend `task_type_label` / `display_name` are both English fallbacks and cannot be used directly in other UI languages;
 * if the locale has `tasks.types.<task_type>` the entry wins, and only otherwise does it fall back to the backend text (when a new task type goes live
 * before the frontend adds an entry, better to show the English text than a bare key).
 */
export const taskTypeLabel = (t: TaskState, tFn: TFn): string =>
  tFn(`tasks.types.${t.task_type}`, { defaultValue: t.task_type_label || t.task_type });

export const displayLabel = (t: TaskState, tFn: TFn): string => {
  // display_name_localizable === false means the string is a user-defined name (canvas name, asset name and the like),
  // where translating would be wrong, so it is shown as is. The backend defaults to true: both what it builds itself and what freezone/scripts'
  // task_display passes in are fixed English, so it has to be rebuilt here from task_type / metadata.
  if (t.display_name && t.display_name_localizable === false) return t.display_name;

  const typeLabel = taskTypeLabel(t, tFn);
  if (t.task_type === "freezone_workflow_confirm") {
    // The draft id in scope is an internal coordination key; never expose it
    // as the task title. Keep it available in task details for diagnostics.
    return typeLabel;
  }
  if (["freezone_video_gen", "freezone_image_vectorize", "freezone_image_animate_gif"].includes(t.task_type)) {
    // scope is the opaque generation job id (for example 043a1944...); it is
    // useful in details but not meaningful as a task title.
    return typeLabel;
  }
  if (t.task_type === "freezone_agent_workflow_result" || t.task_type === "freezone_agent_recipe_result") {
    const name = metaString(t, t.task_type === "freezone_agent_workflow_result" ? "workflow_name" : "recipe_name");
    // The scope is an internal operation ID, not a user-facing workflow name.
    // Keep it in task details; never change the task identity for presentation.
    return name ? `${typeLabel} · ${name}` : typeLabel;
  }
  const sceneName = metaString(t, "scene_name");

  if (t.task_type === "stage_asset") {
    const step = metaString(t, "step");
    const parts = [typeLabel, sceneName];
    if (step) parts.push(tFn(`tasks.stageAssetSteps.${step}`, { defaultValue: step }));
    return parts.filter(Boolean).join(" · ");
  }

  const parts = [typeLabel];
  // The display_name of scene tasks (360 panorama etc.) was originally "Generate 360 panorama - scene name", and rebuilding
  // without scene_name would lose the scene name. scene_name is a scene identifier and is not translated.
  if (sceneName) parts.push(sceneName);
  if (t.episode > 0) parts.push(`ep${t.episode}`);
  if (t.beat_num != null) parts.push(`beat ${t.beat_num}`);
  if (t.scope && !isInternalRunScope(t.scope)) parts.push(t.scope);
  return parts.join(" · ");
};

/**
 * When run_core finishes it writes current_task as "Completed" (and historically completed/done),
 * and echoing it as is would put untranslated text in other UI languages. For terminal states only the status entry is used; these sentinel values are not echoed;
 * other progress text is still whatever the backend provides in real time, shown as is.
 */
const TERMINAL_CURRENT_TASK_SENTINELS = new Set(["completed", "done"]);

export const currentTaskText = (
  t: {
    status: TaskStatus;
    current_task?: string | null;
    current_task_code?: string | null;
    current_task_params?: Record<string, unknown> | null;
  },
  tFn: TFn,
): string => {
  const raw = String(t.current_task ?? "").trim();
  if (!raw) return "";
  const terminal =
    t.status === "completed" || t.status === "failed" || t.status === "cancelled";
  if (terminal && TERMINAL_CURRENT_TASK_SENTINELS.has(raw.toLowerCase())) {
    return tFn(`taskCenter.status.${t.status}`);
  }
  // If the backend gives a code it is translated through the locale entries; otherwise (historical tasks, call sites not yet migrated) the
  // backend text is echoed as before, so migration can be done one place at a time instead of changing all 415 at once.
  if (t.current_task_code) {
    return tFn(t.current_task_code, {
      defaultValue: raw,
      ...(t.current_task_params ?? {}),
    });
  }
  return raw;
};

/**
 * Compresses a batch of logs into a translated string array.
 *
 * Structured entries only exist at the "backend -> frontend entry" layer: when the response is parsed they are immediately translated into strings,
 * and all downstream consumers (join, line-by-line comparison, rolling buffer) keep treating it as string[] with no need
 * to change. The cost is that old logs already in hand are not re-translated when switching language - progress logs are streamed anyway,
 * lines arriving after the switch are in the new language, and the task center refetches as well.
 */
export const taskLogLines = (logs: unknown, tFn: TFn): string[] =>
  Array.isArray(logs)
    ? logs
        .filter((x): x is TaskLogEntry => typeof x === "string" || !!x)
        .map((entry) => taskLogText(entry, tFn))
    : [];

/**
 * Entry point for reading task logs: prefer the structured `logs_i18n`, and fall back to `logs` otherwise.
 *
 * The public contract of `logs` has always been `string[]` (old frontends do `logs.join("\n")` directly), so the backend
 * must not stuff `{text, code, params}` back into that field - during a rolling deploy a new backend with an old frontend would
 * display `[object Object]`. The version with a code goes through `logs_i18n`, which only frontends that know it read.
 * Conversely, an old backend does not send `logs_i18n`, and here `logs` is used directly, so atomic deploys are not needed either.
 */
export const taskLogLinesOf = (
  source: { logs?: unknown; logs_i18n?: unknown } | null | undefined,
  tFn: TFn,
): string[] =>
  taskLogLines(
    Array.isArray(source?.logs_i18n) ? source.logs_i18n : source?.logs,
    tFn,
  );

export const taskLogText = (entry: TaskLogEntry, tFn: TFn): string => {
  if (typeof entry === "string") return entry;
  const text = String(entry?.text ?? "");
  if (!entry?.code) return text;
  return tFn(entry.code, { defaultValue: text, ...(entry.params ?? {}) });
};

export interface OriginDeepLink {
  to: string;
  params: Record<string, string>;
}

export const originDeepLink = (t: TaskState): OriginDeepLink | null => {
  const stage = stageForTaskType(t.task_type);
  if (!stage) return null;
  // stage.routeSegment already starts with "/" (e.g., "/sketches")
  return {
    to: `/projects/$project/episodes/$episode${stage.routeSegment}`,
    params: { project: t.project_id ?? t.project, episode: String(t.episode) },
  };
};
