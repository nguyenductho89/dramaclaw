// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Persisting + resuming task_key-based generations across page reloads.
//
// Most canvas generations (image / video / audio / 3D / script / reverse-prompt) submit
// a freezone job, get a `FreezoneJobRef`, then `await awaitTaskCompletion(task_key)`.
// That promise lives only in memory, so a page refresh used to drop the progress
// bar and stop polling entirely. We fix this by persisting the task identity on the
// node (so the "generating" overlay re-appears from `generationStartedAt`) and re-attaching
// to the task API on reload via {@link resumeNodeGeneration}.

// This uses the default i18next instance (the one `@/i18n` initializes). `@/i18n` itself is not imported,
// because that module also pulls in react-i18next / HttpBackend, and putting it on this widely imported low-level chain
// would make every test that mocks react-i18next blow up at import time.
import i18n from 'i18next';
import { completeDerivedMedia } from './derivedMedia';
import type { CanvasNode, CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import {
  fetchFreezoneJobResult,
  fetchFreezoneReversePromptResult,
  fetchFreezoneStoryScriptResult,
  fetchFreezoneTextGenerateResult,
  type FreezoneJobRef,
} from '@/api/ops';
import {
  awaitTaskCompletion,
  isTaskCancelledError,
  isTaskPollTimeoutError,
  listTasks,
  type TaskState,
} from '@/api/tasks';
import { resolveErrorContent } from '@/features/canvas/application/errorDialog';
import { providerErrorMessage } from '@/lib/api-errors';
import {
  CURRENT_RUNTIME_SESSION_ID,
  extractRequestId,
} from '@/features/canvas/application/generationErrorReport';
import {
  shouldWriteGenerationError,
} from '@/features/canvas/application/generationTaskArbitration';
import { sessionOwnsGenerationTask } from './generationTaskDescriptor';
import { resumePersistedHtmlGeneration } from './workflowHtmlRuntime';

export { generationTaskDescriptor } from './generationTaskDescriptor';
export type { GenerationTaskDescriptor } from './generationTaskDescriptor';

type FreezoneTaskType = FreezoneJobRef['task_type'];

/**
 * The persisted handle that lets a refreshed page re-attach to a running job.
 * `generationTaskJobId` is intentionally separate from `generationJobId` — the
 * latter belongs to the canvasAiGateway image-job poller in Canvas.tsx and must
 * not be confused with a freezone task job id.
 */
/**
 * The patch written back to the node when polling is detached.
 *
 * Only release `generationJobId` - it is the key of canvasAiGateway's in-process Map and never survives a refresh,
 * so clearing it is exactly what lets Canvas.tsx's polling loop wind down. `isGenerating` and the handle trio
 * must be left intact: {@link nodeNeedsGenerationResume} relies on them to decide, and missing even one would make
 * "refresh the page later to see the result" an empty promise.
 *
 * It is extracted separately so tests can assert it directly - if it were inlined in Canvas.tsx's effect and changed wrongly nobody could stop it.
 */
export const DETACHED_GENERATION_PATCH: Record<string, unknown> = {
  generationJobId: null,
};

/**
 * Whether this node's `generationJobId` is worth polling this session.
 *
 * `generationJobId` is the key of the module-level `jobs` Map in canvasAiGateway and is only meaningful in the JS session that wrote it.
 * After a refresh the Map is empty, and polling would necessarily get `not_found`, which
 * Canvas.tsx's error branch treats as a generation failure: writing `generationError` and clearing
 * `isGenerating` to false. Then two paths fight on the same node - the descriptor one
 * is resuming while the jobId one is writing the failure, and the failure branch usually arrives first (checking the in-memory Map is faster than sending a
 * listTasks). Once it writes first, {@link nodeNeedsGenerationResume} no longer holds next time,
 * and the recovery path is permanently cut.
 *
 * So the precondition for polling is that this id was written by this runtime session. Leftover ids from other sessions are left to
 * {@link staleGenerationJobPatch} to clean up.
 */
export function nodeOwnsLiveGenerationJob(node: CanvasNode): boolean {
  const data = node.data as Record<string, unknown>;
  const jobId = typeof data.generationJobId === 'string' ? data.generationJobId : '';
  return (
    data.isGenerating === true
    && jobId.length > 0
    && data.generationClientSessionId === CURRENT_RUNTIME_SESSION_ID
  );
}

/**
 * How to handle a `generationJobId` left over from the previous session. Returning null means this node needs no attention.
 *
 * The two kinds of leftover nodes have different fates:
 * - **With a descriptor**: clear the dead id, and leave `isGenerating` and the handle in place so
 *   {@link resumeNodeGeneration} owns the recovery path exclusively - the patch is exactly
 *   {@link DETACHED_GENERATION_PATCH}, the same one as the detached branch.
 * - **Without a descriptor** (old nodes submitted before this PR): the backend handle was never persisted, and nobody can reconnect it.
 *   The previous behavior was to poll until `not_found` and then write a failure, the same conclusion just with a wasted round; here we
 *   give the terminal state directly, so the node does not spin forever.
 */
export function staleGenerationJobPatch(node: CanvasNode): Record<string, unknown> | null {
  const data = node.data as Record<string, unknown>;
  const jobId = typeof data.generationJobId === 'string' ? data.generationJobId : '';
  if (data.isGenerating !== true || jobId.length === 0) {
    return null;
  }
  if (data.generationClientSessionId === CURRENT_RUNTIME_SESSION_ID) {
    return null;
  }
  const taskKey = typeof data.generationTaskKey === 'string' ? data.generationTaskKey : '';
  if (taskKey.length > 0) {
    return DETACHED_GENERATION_PATCH;
  }
  return buildErrorPatch('image', new Error(i18n.t('canvas.resumeGeneration.taskGone')));
}

/** The number of consecutive misses needed to judge "the task does not exist", and the interval between each. */
export const TASK_MISS_CONFIRM_ATTEMPTS = 3;
export const TASK_MISS_CONFIRM_INTERVAL_MS = 5000;

/**
 * Repeatedly confirm whether the task has really disappeared from the list.
 *
 * Returns true in only one case: `TASK_MISS_CONFIRM_ATTEMPTS` consecutive list calls all
 * succeeded and none contained this task_key. Any hit means false (the task is still there, handed to
 * awaitTaskCompletion to wait within the budget); any list call that throws is also false - being unable to list
 * does not mean the task is gone, and better to go through the full polling than to write a failure.
 */
async function confirmTaskMissing(projectId: string, taskKey: string): Promise<boolean> {
  for (let attempt = 0; attempt < TASK_MISS_CONFIRM_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, TASK_MISS_CONFIRM_INTERVAL_MS);
      });
    }
    let tasks: TaskState[];
    try {
      tasks = await listTasks(projectId);
    } catch {
      return false;
    }
    if (tasks.some((task) => task.task_key === taskKey)) {
      return false;
    }
  }
  return true;
}

type ResumeKind =
  | 'derived-media'
  | 'image'
  | 'video'
  | 'video-compose'
  | 'audio'
  | 'ply'
  | 'script'
  | 'reverse-prompt'
  | 'text-generate'
  | 'html';

function resumeKindForNode(type: CanvasNodeType, taskType: FreezoneTaskType): ResumeKind | null {
  switch (type) {
    case CANVAS_NODE_TYPES.vectorSvg:
    case CANVAS_NODE_TYPES.animatedGif:
      return 'derived-media';
    case CANVAS_NODE_TYPES.imageGen:
    case CANVAS_NODE_TYPES.imageEdit:
    case CANVAS_NODE_TYPES.exportImage:
      return 'image';
    case CANVAS_NODE_TYPES.video:
      return 'video';
    case CANVAS_NODE_TYPES.videoCompose:
      return taskType === 'freezone_video_compose' ? 'video-compose' : null;
    case CANVAS_NODE_TYPES.audio:
      return 'audio';
    case CANVAS_NODE_TYPES.threeDWorld:
      return 'ply';
    case CANVAS_NODE_TYPES.script:
      return 'script';
    case CANVAS_NODE_TYPES.textAnnotation:
      return taskType === 'freezone_text_generate' ? 'text-generate' : 'reverse-prompt';
    case CANVAS_NODE_TYPES.htmlArtifact:
      return taskType === 'freezone_text_generate' ? 'html' : null;
    default:
      return null;
  }
}

function resolveUrlFromResult(
  result: Record<string, unknown> | null | undefined,
  keys: string[],
): string | null {
  if (!result) return null;
  for (const key of keys) {
    const value = result[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

// Mirror ThreeDWorldNode's pickPlyUrlFromResult so 3D scenes resume the same way.
function pickPlyUrlFromResult(result: TaskState['result'] | undefined): string | null {
  if (!result) return null;
  const candidates: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 4) return;
    if (typeof value === 'string') {
      if (/\.(ply|sog|splat|ksplat|spz)(\?|#|$)/i.test(value) || /scene_3gs|ply_fs|splat/i.test(value)) {
        candidates.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      for (const v of Object.values(value as Record<string, unknown>)) visit(v, depth + 1);
    }
  };
  visit(result, 0);
  const sog = candidates.find((c) => /\.sog(\?|#|$)/i.test(c));
  if (sog) return sog;
  const packaged = candidates.find((c) => /\.(ksplat|splat|spz)(\?|#|$)/i.test(c));
  if (packaged) return packaged;
  const ply = candidates.find((c) => /\.ply(\?|#|$)/i.test(c));
  if (ply) return ply;
  return candidates[0] ?? null;
}

/** Fields cleared on every settle so the node leaves the "generating" state cleanly. */
export const CLEARED_GENERATION_TASK_FIELDS = {
  isGenerating: false,
  generationStartedAt: null,
  generationTaskKey: null,
  generationTaskType: null,
  generationTaskJobId: null,
} as const;

async function buildSuccessPatch(
  kind: ResumeKind,
  completed: TaskState,
  taskType: FreezoneTaskType,
  jobId: string,
  projectId: string,
): Promise<Record<string, unknown>> {
  switch (kind) {
    case 'derived-media': return {};
    case 'image': {
      let url = resolveUrlFromResult(completed.result, ['output_url', 'image_url', 'url']);
      if (!url && jobId) {
        url = await fetchFreezoneJobResult(projectId, taskType, jobId).then((r) => r.url).catch(() => null);
      }
      if (!url) {
        return { ...CLEARED_GENERATION_TASK_FIELDS, generationError: i18n.t('canvas.resumeGeneration.noImageResult') };
      }
      return { ...CLEARED_GENERATION_TASK_FIELDS, imageUrl: url, previewImageUrl: url, generationError: null };
    }
    case 'video': {
      let url = resolveUrlFromResult(completed.result, ['video_url', 'output_url', 'url']);
      if (!url && jobId) {
        url = await fetchFreezoneJobResult(projectId, taskType, jobId).then((r) => r.url).catch(() => null);
      }
      if (!url) {
        return { ...CLEARED_GENERATION_TASK_FIELDS, generationError: i18n.t('canvas.resumeGeneration.noVideoResult') };
      }
      return {
        ...CLEARED_GENERATION_TASK_FIELDS,
        videoUrl: url,
        sourceFileName: null,
        generationError: null,
        generationErrorDetails: null,
        generationErrorRequestId: null,
      };
    }
    case 'video-compose': {
      let url = resolveUrlFromResult(completed.result, ['video_url', 'output_url', 'url']);
      let coverUrl = resolveUrlFromResult(completed.result, ['cover_url', 'preview_image_url']);
      if (!url && jobId) {
        const result = await fetchFreezoneJobResult(projectId, taskType, jobId).catch(() => null);
        url = result?.url ?? null;
        coverUrl = coverUrl ?? result?.cover_url ?? null;
      }
      if (!url) {
        return { ...CLEARED_GENERATION_TASK_FIELDS, generationError: i18n.t('canvas.resumeGeneration.noVideoResult') };
      }
      return {
        ...CLEARED_GENERATION_TASK_FIELDS,
        resultVideoUrl: url,
        ...(coverUrl ? { previewImageUrl: coverUrl } : {}),
        resultVideoTaskKey: completed.task_key,
        resultVideoJobId: jobId,
        generationError: null,
        generationErrorDetails: null,
        generationErrorRequestId: null,
      };
    }
    case 'audio': {
      let url = resolveUrlFromResult(completed.result, ['audio_url', 'output_url', 'url']);
      if (!url && jobId) {
        url = await fetchFreezoneJobResult(projectId, taskType, jobId).then((r) => r.url).catch(() => null);
      }
      if (!url) {
        return { ...CLEARED_GENERATION_TASK_FIELDS };
      }
      return { ...CLEARED_GENERATION_TASK_FIELDS, audioUrl: url, durationMs: null };
    }
    case 'ply': {
      const plyUrl = pickPlyUrlFromResult(completed.result);
      if (!plyUrl) {
        return { ...CLEARED_GENERATION_TASK_FIELDS, taskKey: null, errorMessage: i18n.t('canvas.resumeGeneration.noWorldUrl') };
      }
      return { ...CLEARED_GENERATION_TASK_FIELDS, plyUrl, taskKey: null, errorMessage: null };
    }
    case 'script': {
      const result = await fetchFreezoneStoryScriptResult(projectId, jobId);
      return { ...CLEARED_GENERATION_TASK_FIELDS, scriptResult: result, scriptTitle: result.title ?? null };
    }
    case 'reverse-prompt': {
      const { prompt } = await fetchFreezoneReversePromptResult(projectId, jobId);
      if (prompt && prompt.trim().length > 0) {
        return { ...CLEARED_GENERATION_TASK_FIELDS, content: prompt };
      }
      return { ...CLEARED_GENERATION_TASK_FIELDS };
    }
    case 'text-generate': {
      const result = await fetchFreezoneTextGenerateResult(projectId, jobId);
      if (!result.generated_text.trim()) {
        return { ...CLEARED_GENERATION_TASK_FIELDS };
      }
      return {
        ...CLEARED_GENERATION_TASK_FIELDS,
        content: result.generated_text,
        model: result.model,
      };
    }
    default:
      return { ...CLEARED_GENERATION_TASK_FIELDS };
  }
}

function buildErrorPatch(kind: ResumeKind, error: unknown): Record<string, unknown> {
  if (isTaskCancelledError(error)) {
    // For a task the user actively terminated, resuming only clears the generating state and does not show an error.
    return { ...CLEARED_GENERATION_TASK_FIELDS };
  }
  if (kind === 'ply') {
    const message = error instanceof Error ? error.message : String(error);
    return { ...CLEARED_GENERATION_TASK_FIELDS, taskKey: null, errorMessage: i18n.t('canvas.resumeGeneration.failedWithMessage', { message }) };
  }
  if (kind === 'image' || kind === 'video' || kind === 'video-compose' || kind === 'derived-media') {
    const resolved = resolveErrorContent(error, kind === 'video' || kind === 'video-compose'
      ? i18n.t('canvas.resumeGeneration.videoFailed')
      : i18n.t('canvas.resumeGeneration.imageFailed'));
    const rawMessage = resolved.message;
    return {
      ...CLEARED_GENERATION_TASK_FIELDS,
      generationError: providerErrorMessage(rawMessage) ?? rawMessage,
      generationErrorDetails: resolved.details ?? rawMessage,
      generationErrorRequestId:
        extractRequestId(rawMessage) ?? extractRequestId(resolved.details),
    };
  }
  if (kind === 'html') {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...CLEARED_GENERATION_TASK_FIELDS,
      generationError: message,
      htmlGenerationPhase: 'generation_failed',
    };
  }
  // audio / script / reverse-prompt / text-generate surface their own inline errors elsewhere;
  // just leave the "generating" state.
  return { ...CLEARED_GENERATION_TASK_FIELDS };
}

/**
 * Re-attach to a running freezone task for a node that came back from storage
 * still flagged `isGenerating`. Resolves the result and writes it onto the node,
 * or records the failure — mirroring each flow's own success/error handling.
 *
 * Returns once the task settles (or is found to no longer exist). Safe to call
 * once per node; callers should dedupe.
 */
export async function resumeNodeGeneration(params: {
  node: CanvasNode;
  projectId: string;
  canvasId?: string;
  updateNodeData: (id: string, patch: Record<string, unknown>) => void;
  getNodeData?: (id: string) => Record<string, unknown> | null | undefined;
}): Promise<void> {
  const { node, projectId, canvasId, updateNodeData, getNodeData } = params;
  const data = node.data as Record<string, unknown>;
  const taskKey = typeof data.generationTaskKey === 'string' ? data.generationTaskKey : '';
  const taskType =
    typeof data.generationTaskType === 'string' ? (data.generationTaskType as FreezoneTaskType) : null;
  const jobId = typeof data.generationTaskJobId === 'string' ? data.generationTaskJobId : '';
  const kind = taskType
    ? resumeKindForNode(node.type as CanvasNodeType, taskType)
    : null;

  if (!taskKey || !taskType || !kind) {
    return;
  }

  const readLatestNodeData = () =>
    getNodeData?.(node.id)
    ?? (node.data as Record<string, unknown>);
  const stillOwnsTask = () => readLatestNodeData().generationTaskKey === taskKey;

  // Quick pre-check: if the task no longer exists server-side (expired/cleaned),
  // avoid hanging on the full poll budget — clear the stuck "generating" state now.
  //
  // But a single miss does not count. The list endpoint silently drops rows: the backend list_tasks_for_project runs _row_to_state on each row
  // separately, and a parse exception only logs one warning and skips it (task_state.py),
  // while the task is actually still running in the DB. Add the visibility window after submission, and judging "does not exist" on a single miss would write
  // a live task as failed - exactly the kind of misjudgment this PR aims to eliminate, which must not be replayed on the recovery path.
  // Only consecutive misses count: the confirmation window is about 10 seconds, negligible against the full budget of 20~35 minutes,
  // yet enough to cover a transient omission.
  if (await confirmTaskMissing(projectId, taskKey)) {
    if (!stillOwnsTask()) {
      return;
    }

    updateNodeData(node.id, buildErrorPatch(kind, new Error(i18n.t('canvas.resumeGeneration.taskGone'))));
    return;
  }

  try {
    // Take the budget by task type, the same basis as the submit side (see pollTimeoutForTaskType).
    if (kind === 'derived-media') {
      await completeDerivedMedia(projectId, { task_key: taskKey, task_type: taskType, job_id: jobId }, (patch) => updateNodeData(node.id, patch));
      return;
    }
    const completed = await awaitTaskCompletion(taskKey, projectId, { taskType });
    if (kind === 'html') {
      if (!stillOwnsTask()) return;
      if (!canvasId) {
        updateNodeData(node.id, buildErrorPatch(kind, new Error('HTML canvas identity is unavailable')));
        return;
      }
      await resumePersistedHtmlGeneration({
        nodeId: node.id,
        projectId,
        canvasId,
        taskKey,
        jobId,
      });
      return;
    }
    const patch = await buildSuccessPatch(kind, completed, taskType, jobId, projectId);
    if (!stillOwnsTask()) return;
    updateNodeData(node.id, patch);
  } catch (error) {
    console.warn('[resume-generation] task resume failed', { nodeId: node.id, taskKey, error });
    // A poll timeout only says this round stops waiting, and the task is still running on the backend: keep isGenerating and the handle,
    // pick it up again on the next refresh, and do not write a live task as failed.
    if (isTaskPollTimeoutError(error)) {
      return;
    }
    if (!stillOwnsTask()) return;
    if (kind === 'image' || kind === 'video' || kind === 'video-compose') {
      const latestNodeData = readLatestNodeData();
      if (!shouldWriteGenerationError({ nodeData: latestNodeData, taskKey, error })) {
        updateNodeData(node.id, { ...CLEARED_GENERATION_TASK_FIELDS });
        return;
      }
    }

    updateNodeData(node.id, buildErrorPatch(kind, error));
  }
}

/**
 * Whether a node restored from storage needs {@link resumeNodeGeneration}. Returns
 * false for tasks already being awaited by an in-session flow (see
 * {@link sessionOwnedTaskKeys}).
 */
export function nodeNeedsGenerationResume(node: CanvasNode): boolean {
  const data = node.data as Record<string, unknown>;
  const taskKey = typeof data.generationTaskKey === 'string' ? data.generationTaskKey : '';
  return data.isGenerating === true && taskKey.length > 0 && !sessionOwnsGenerationTask(taskKey);
}
