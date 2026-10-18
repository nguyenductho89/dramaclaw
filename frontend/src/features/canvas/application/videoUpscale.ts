// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  fetchFreezoneJobResult,
  submitFreezoneVideoUpscale,
  type FreezoneVideoUpscaleResolution,
} from '@/api/ops';
import { awaitTaskCompletion, isTaskPollTimeoutError } from '@/api/tasks';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { generationTaskDescriptor } from './resumeGeneration';
import { notifyTaskStillRunning } from './errorDialog';

export const VIDEO_UPSCALE_RESOLUTIONS: FreezoneVideoUpscaleResolution[] = [
  '1080p',
  '2k',
  '4k',
];
export const VIDEO_UPSCALE_RESOLUTION_LABEL: Record<FreezoneVideoUpscaleResolution, string> = {
  '1080p': '1080P',
  '2k': '2K',
  '4k': '4K',
};

/**
 * Build the "upscale" result node downstream of the source video (the payload matches NodeActionToolbar.handleVideoUpscale:
 * reusing the video node's player/badge/size, with the isUpscaleNode marker). Selection is not switched -
 * the workflow entry selects the new node to expand the VideoUpscaleEditorOverlay config panel; the storyboard detail's
 * config is submitted directly after being completed in the detail, with no need for that panel.
 *
 * @returns the new result node id; null when the source node no longer exists.
 */
export function createVideoUpscaleResultNode(
  sourceNodeId: string,
  opts: {
    sourceUrl: string;
    displayName: string;
    resolution: FreezoneVideoUpscaleResolution;
  },
): string | null {
  const store = useCanvasStore.getState();
  const node = store.nodes.find((candidate) => candidate.id === sourceNodeId);
  if (!node) {
    return null;
  }
  const videoData = node.data as Record<string, unknown>;
  const position = store.findNodePosition(node.id, 580, 380);
  const upscaleNodeId = store.addNode(
    CANVAS_NODE_TYPES.video,
    position,
    {
      displayName: opts.displayName,
      videoUrl: null,
      previewImageUrl:
        typeof videoData.previewImageUrl === 'string' ? videoData.previewImageUrl : null,
      aspectRatio:
        typeof videoData.aspectRatio === 'string' ? videoData.aspectRatio : '16:9',
      isUpscaleNode: true,
      upscaleSourceUrl: opts.sourceUrl,
      upscaleResolution: opts.resolution,
      isGenerating: false,
    } as unknown as Parameters<typeof store.addNode>[2],
  );
  store.addEdge(node.id, upscaleNodeId);
  return upscaleNodeId;
}

/**
 * Video upscale submission orchestration (moved verbatim out of VideoUpscaleEditorOverlay.handleSubmit, with zero semantic change):
 * set isGenerating on the isUpscaleNode result node -> submit /freezone/video/upscale ->
 * wait for the task to complete (falling back to the job result when output_url is missing) -> backfill the product videoUrl into that node;
 * on failure write the error to that node. project/canvasId are taken from the current URL.
 */
export async function submitVideoUpscale(
  nodeId: string,
  opts: {
    sourceUrl: string;
    resolution: FreezoneVideoUpscaleResolution;
  },
): Promise<void> {
  const project = readUrl().project;
  if (!project) {
    console.error('[video-upscale] no project in URL — cannot submit');
    return;
  }
  const canvasId = readUrl().canvas ?? 'default';

  useCanvasStore.getState().updateNodeData(nodeId, {
    isGenerating: true,
    generationStartedAt: Date.now(),
    generationError: null,
  });

  try {
    const ref = await submitFreezoneVideoUpscale(project, {
      sourceUrl: opts.sourceUrl.split('?')[0],
      resolution: opts.resolution,
      canvasId,
      nodeId,
    });
    useCanvasStore.getState().updateNodeData(nodeId, generationTaskDescriptor(ref));
    const completed = await awaitTaskCompletion(ref.task_key, project, {
      taskType: ref.task_type,
    });
    const directUrl = completed.result?.['output_url'] as string | undefined;
    let url = directUrl;
    if (!url) {
      const fallback = await fetchFreezoneJobResult(project, ref.task_type, ref.job_id);
      url = fallback.url;
    }
    useCanvasStore.getState().updateNodeData(nodeId, {
      videoUrl: url,
      isGenerating: false,
      generationStartedAt: null,
      generationError: null,
    });
  } catch (err) {
    if (isTaskPollTimeoutError(err)) {
      notifyTaskStillRunning();
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error('[video-upscale] generation failed', err);
    useCanvasStore.getState().updateNodeData(nodeId, {
      isGenerating: false,
      generationStartedAt: null,
      generationError: message,
    });
  }
}
