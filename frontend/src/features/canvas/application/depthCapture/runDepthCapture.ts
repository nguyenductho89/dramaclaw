// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Depth motion-capture orchestration: fetch source video → worker computation → upload → write back to the node.
//
// The task table is module-level, not attached to a React component: canvas LOD and switching canvases both unmount node components, but a task should only be cancelled once
// the node has really disappeared from the store. After a page refresh the table is empty, and any leftover node in the running state
// is shown as "Interrupted" accordingly (see DepthCaptureBody).
import { uploadFreezoneVideo } from "@/api/ops";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import type { DepthCaptureState } from "@/features/canvas/domain/canvasNodes";
import { useCanvasStore } from "@/stores/canvasStore";
import {
  DepthCaptureError,
  runDepthCaptureInWorker,
  type DepthCaptureJob,
} from "./depthCaptureClient";

const activeJobs = new Map<string, { sourceVideoUrl: string; cancel: () => void }>();

// Each task gets its own worker and model session; running several at once just fights for the local GPU/VRAM,
// nobody gets faster, and low-end machines may even run out of memory. So only one is allowed globally and the rest queue in click order.
const MAX_CONCURRENT_JOBS = 1;
let runningJobs = 0;
const slotWaiters: Array<(granted: boolean) => void> = [];

function acquireSlot(): { granted: Promise<boolean>; abandon: () => void } {
  if (runningJobs < MAX_CONCURRENT_JOBS) {
    runningJobs += 1;
    return { granted: Promise.resolve(true), abandon: () => {} };
  }
  let waiter: (granted: boolean) => void = () => {};
  const granted = new Promise<boolean>((resolve) => {
    waiter = resolve;
  });
  slotWaiters.push(waiter);
  return {
    granted,
    // Cancelled while still queued: dequeue it directly instead of waiting for its turn to give up.
    abandon: () => {
      const index = slotWaiters.indexOf(waiter);
      if (index >= 0) {
        slotWaiters.splice(index, 1);
        waiter(false);
      }
    },
  };
}

function releaseSlot(): void {
  const next = slotWaiters.shift();
  if (next) {
    // The slot is handed straight to the next one; runningJobs is unchanged.
    next(true);
  } else {
    runningJobs -= 1;
  }
}

export function isDepthCaptureActive(nodeId: string): boolean {
  return activeJobs.has(nodeId);
}

/** Whether any task is running or queued; a new task is placed behind them. */
export function hasActiveDepthCapture(): boolean {
  return activeJobs.size > 0;
}

/** Result node of an in-flight (including queued) task for the same source video; null if none. */
export function findActiveDepthCaptureNodeId(sourceVideoUrl: string): string | null {
  for (const [nodeId, job] of activeJobs) {
    if (job.sourceVideoUrl === sourceVideoUrl) {
      return nodeId;
    }
  }
  return null;
}

export function cancelDepthCapture(nodeId: string): void {
  activeJobs.get(nodeId)?.cancel();
}

function nodeExists(nodeId: string): boolean {
  return useCanvasStore.getState().nodes.some((node) => node.id === nodeId);
}

export interface StartDepthCaptureOptions {
  nodeId: string;
  projectId: string;
  sourceVideoUrl: string;
}

export async function startDepthCapture({
  nodeId,
  projectId,
  sourceVideoUrl,
}: StartDepthCaptureOptions): Promise<void> {
  if (activeJobs.has(nodeId)) {
    return;
  }
  let cancelled = false;
  let job: DepthCaptureJob | null = null;
  const slot = acquireSlot();
  let holdsSlot = false;
  // Fetching the source video and uploading the result can both be very slow; on cancel the request must really be cut off, otherwise this task nobody wants any more
  // would hold the only slot forever and block everything queued behind it.
  const abort = new AbortController();
  // The worker has not been created yet while queued and fetching the source video, so the task table must be claimed first, otherwise the node would wrongly show "Interrupted".
  activeJobs.set(nodeId, {
    sourceVideoUrl,
    cancel: () => {
      cancelled = true;
      slot.abandon();
      abort.abort();
      job?.cancel();
    },
  });
  const unsubscribe = useCanvasStore.subscribe((state) => {
    if (!state.nodes.some((node) => node.id === nodeId)) {
      cancelDepthCapture(nodeId);
    }
  });

  const { updateNodeData } = useCanvasStore.getState();
  const writeState = (state: DepthCaptureState) =>
    // Progress is written very frequently; it does not go on the undo stack.
    updateNodeData(nodeId, { depthCapture: state }, { recordHistory: false });
  const running = (progress: number): DepthCaptureState => ({
    status: "running",
    progress,
    sourceVideoUrl,
    errorCode: null,
    errorDetail: null,
  });

  try {
    writeState(running(0));
    // The source video is also fetched only once it is this task's turn, so queued tasks hold no memory.
    holdsSlot = await slot.granted;
    if (!holdsSlot || cancelled) {
      return;
    }
    const response = await fetch(resolveImageDisplayUrl(sourceVideoUrl), {
      signal: abort.signal,
    });
    if (!response.ok) {
      throw new DepthCaptureError("failed", `source video HTTP ${response.status}`);
    }
    const sourceBlob = await response.blob();
    if (cancelled) {
      return;
    }

    let lastPercent = 0;
    job = runDepthCaptureInWorker(sourceBlob, (progress) => {
      const percent = Math.round(progress * 100);
      if (percent === lastPercent) {
        return;
      }
      lastPercent = percent;
      writeState(running(percent));
    });
    const result = await job.promise;
    if (cancelled) {
      return;
    }

    const { url } = await uploadFreezoneVideo(
      projectId,
      result.blob,
      `depth-capture-${Date.now()}.mp4`,
      { signal: abort.signal },
    );
    if (cancelled || !nodeExists(nodeId)) {
      return;
    }
    updateNodeData(nodeId, {
      videoUrl: url,
      previewImageUrl: null,
      widthPx: result.width,
      heightPx: result.height,
      durationMs: result.durationMs,
      depthCapture: null,
    });
  } catch (err) {
    if (cancelled || !nodeExists(nodeId)) {
      return;
    }
    writeState({
      status: "failed",
      progress: 0,
      sourceVideoUrl,
      errorCode: err instanceof DepthCaptureError ? err.code : "failed",
      errorDetail: err instanceof Error ? err.message : String(err),
    });
  } finally {
    unsubscribe();
    activeJobs.delete(nodeId);
    if (holdsSlot) {
      releaseSlot();
    }
  }
}
