// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';
import { fetchFreezoneJobResult, submitFreezoneVideoCompose } from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

/** Landing size of the result video node (consistent with VideoNode's DEFAULT_WIDTH/HEIGHT). */
const CLIP_RESULT_LAYOUT_WIDTH = 580;
const CLIP_RESULT_LAYOUT_HEIGHT = 380;

/** The hint when the clip finished but the backend gave no product address (identical to the original text of VideoNode.handleClipSubmit). */
export function videoClipNoUrlMessage(): string {
  return i18n.t('canvas.videoClip.noUrl');
}

export interface VideoClipSubmitResult {
  /** The id of the newly built clip result video node; null on failure. */
  nodeId: string | null;
  /** Failure reason; null on success. */
  error: string | null;
}

/**
 * Video clip submission orchestration (moved verbatim out of VideoNode.handleClipSubmit, with zero semantic change):
 * use a single-track single-clip compose task to cut out the [startMs, endMs) interval -> wait for the task to complete ->
 * take the job result -> build a video node downstream of the source node to carry the product and connect an edge.
 *
 * Unlike spawn-type orchestrations (imageScene360 etc.), the result node here is only built after the task successfully returns
 * the product address - the original implementation had this order, kept unchanged (a failure leaves no empty node on the canvas).
 *
 * UI state (isComposingClip / clipError / exiting clip mode) is held by the caller: the workflow's
 * VideoNode and the storyboard detail's "Clip track" share this one submission path.
 */
export async function submitVideoClip(
  sourceNodeId: string,
  opts: {
    sourceUrl: string;
    startMs: number;
    endMs: number;
    /** The source node's quality tier (VideoNode's data.quality) - compose only supports 720p/1080p. */
    quality?: string | null;
    /** Result node title, default "Clip" (identical to the original text of VideoNode). */
    displayName?: string;
  },
): Promise<VideoClipSubmitResult> {
  if (!opts.sourceUrl) return { nodeId: null, error: null };
  if (opts.endMs <= opts.startMs) return { nodeId: null, error: null };
  const projectId = readUrl().project;
  if (!projectId) {
    console.error('[video-clip] no project in URL');
    return { nodeId: null, error: null };
  }
  // Compose only supports 720p / 1080p — fall back to 720p for 480p sources.
  // Case-insensitive: tiers in the media catalog are now lowercase ("1080p"), while old nodes may still store
  // "1080P", and a hard comparison would quietly downgrade a 1080p source to 720p.
  const composeResolution =
    (opts.quality ?? '').toLowerCase() === '1080p' ? '1080p' : '720p';
  const sourceStart = opts.startMs / 1000;
  const sourceEnd = opts.endMs / 1000;

  try {
    const ref = await submitFreezoneVideoCompose(projectId, {
      resolution: composeResolution,
      tracks: [
        {
          trackId: `track_${sourceNodeId}_video`,
          kind: 'video',
          items: [
            {
              itemId: `item_${sourceNodeId}_${Date.now()}`,
              sourceUrl: opts.sourceUrl,
              timelineStart: 0,
              sourceStart,
              sourceEnd,
            },
          ],
        },
      ],
    });
    await awaitTaskCompletion(ref.task_key, projectId);
    const result = await fetchFreezoneJobResult(
      projectId,
      'freezone_video_compose',
      ref.job_id,
    );
    if (!result.url) {
      console.warn('[video-clip] compose completed without url', result);
      return { nodeId: null, error: videoClipNoUrlMessage() };
    }
    const store = useCanvasStore.getState();
    const position = store.findNodePosition(
      sourceNodeId,
      CLIP_RESULT_LAYOUT_WIDTH,
      CLIP_RESULT_LAYOUT_HEIGHT,
    );
    const newNodeId = store.addNode(CANVAS_NODE_TYPES.video, position, {
      videoUrl: result.url,
      durationMs: Math.round((sourceEnd - sourceStart) * 1000),
      displayName: opts.displayName ?? i18n.t('canvas.videoClip.defaultTitle'),
    } as unknown as Parameters<typeof store.addNode>[2]);
    store.addEdge(sourceNodeId, newNodeId);
    return { nodeId: newNodeId, error: null };
  } catch (error) {
    console.error('[video-clip] compose failed', error);
    return {
      nodeId: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
