// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';
import {
  submitFreezoneVideoGen,
  type FreezoneVideoAspectRatio,
  type FreezoneVideoResolution,
} from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import {
  CANVAS_NODE_TYPES,
  type VideoGenCount,
  type VideoGenQuality,
  type VideoNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { generationTaskDescriptor } from './resumeGeneration';

/** The backend no longer supports producing several at once - call N times concurrently per the "generation count" chosen on the video node, capped at 4. */
const MAX_PARALLEL_COUNT = 4;

function resolveVideoOutputUrl(
  result: Record<string, unknown> | null | undefined,
): string | null {
  if (!result) return null;
  for (const key of ['video_url', 'output_url', 'url']) {
    const value = result[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function qualityToResolution(q: VideoGenQuality): FreezoneVideoResolution {
  return q.toLowerCase() as FreezoneVideoResolution;
}

/** Take the video node pointed to by the text node's first downstream edge (the parameters and products of text-to-video both land on it). */
export function resolveTextNodeDownstreamVideoNodeId(nodeId: string): string | null {
  const state = useCanvasStore.getState();
  const downstreamEdge = state.edges.find((edge) => edge.source === nodeId);
  if (!downstreamEdge) return null;
  const targetNode = state.nodes.find((node) => node.id === downstreamEdge.target);
  if (!targetNode || targetNode.type !== CANVAS_NODE_TYPES.video) return null;
  return targetNode.id;
}

export interface TextToVideoSubmitResult {
  /** The video node ids carrying the products this time (the first is the original downstream node, the rest are copies placed side by side). */
  nodeIds: string[];
  /** The first error reason when any one fails; null when all succeed. */
  error: string | null;
}

/**
 * Text-to-video submission orchestration (moved verbatim out of TextAnnotationNode.runTextToVideo, with zero semantic change):
 *
 * The parameters are **read from the downstream video node** (aspect/quality/duration/audio track/count/model), not from the text node - the text
 * node only provides the prompt. Call the endpoint N times concurrently per "generation count": the 1st backfills the downstream video node, and the rest
 * are copied with duplicateNodeAsSibling into same-type video nodes placed side by side.
 *
 * A failure only clears the loading state of the matching video node (errors go to the console), consistent with the original implementation; the return value lets the caller
 * (storyboard detail) show the failure text on the source text node's toolbar.
 */
export async function submitTextToVideo(
  nodeId: string,
  opts: {
    /** The prompt used for submission (the workflow passes the node's current body; the detail uses the same source). */
    content: string;
    /** Fallback id when the downstream video node has not chosen a model (resolved by the caller from useFreezoneVideoModels). */
    fallbackModelId: string;
  },
): Promise<TextToVideoSubmitResult> {
  const promptText = opts.content.trim();
  if (promptText.length === 0) return { nodeIds: [], error: null };
  const projectId = readUrl().project;
  if (!projectId) {
    console.error('[text-node] no project in URL');
    return { nodeIds: [], error: i18n.t('canvas.errors.missingProjectParam') };
  }
  const targetNodeId = resolveTextNodeDownstreamVideoNodeId(nodeId);
  if (!targetNodeId) {
    console.warn('[text-node] textToVideo: no downstream video node');
    return { nodeIds: [], error: i18n.t('canvas.errors.noDownstreamVideoNode') };
  }
  const store = useCanvasStore.getState();
  const targetNode = store.nodes.find((node) => node.id === targetNodeId);
  if (!targetNode) return { nodeIds: [], error: i18n.t('canvas.errors.noDownstreamVideoNode') };
  const videoData = targetNode.data as VideoNodeData;
  const aspectRatio = (videoData.aspectRatio ?? '16:9') as FreezoneVideoAspectRatio;
  const quality: VideoGenQuality = videoData.quality ?? '720P';
  const durationSec = typeof videoData.durationSec === 'number' ? videoData.durationSec : 5;
  const generateAudio = Boolean(videoData.generateAudio);
  const count: VideoGenCount = (videoData.count ?? 1) as VideoGenCount;
  const videoModel =
    typeof videoData.model === 'string' && videoData.model.length > 0
      ? videoData.model
      : opts.fallbackModelId;

  const total = Math.min(Math.max(count, 1), MAX_PARALLEL_COUNT);
  store.updateNodeData(targetNodeId, {
    prompt: promptText,
    isGenerating: true,
    generationStartedAt: Date.now(),
    // The target node may carry an album from the last batch generation; after this single backfill the album is decoupled from the main video - clear it.
    generationBatch: null,
  });
  const targetIds: string[] = [targetNodeId];
  for (let i = 1; i < total; i += 1) {
    const siblingId = useCanvasStore.getState().duplicateNodeAsSibling(targetNodeId, i, {
      prompt: promptText,
      isGenerating: true,
      generationStartedAt: Date.now(),
      count: 1,
      videoUrl: null,
      sourceFileName: null,
      // duplicateNodeAsSibling spreads the whole source node data, so the album fields must be cleared explicitly,
      // otherwise the sibling node would inherit the source node's old album (card edge + badge showing someone else's result).
      generationBatch: null,
    });
    if (siblingId) targetIds.push(siblingId);
  }

  const errors: string[] = [];
  const runOne = async (videoNodeId: string) => {
    const updateNodeData = useCanvasStore.getState().updateNodeData;
    try {
      const ref = await submitFreezoneVideoGen(projectId, {
        prompt: promptText,
        genMode: "textToVideo",
        aspectRatio,
        resolution: qualityToResolution(quality),
        durationSeconds: durationSec,
        generateAudio,
        model: videoModel,
        canvasId: readUrl().canvas ?? 'default',
        nodeId: videoNodeId,
      });
      // Persist the task handle so a page refresh can resume this job.
      updateNodeData(videoNodeId, generationTaskDescriptor(ref));
      const completed = await awaitTaskCompletion(ref.task_key, projectId);
      const url = resolveVideoOutputUrl(completed.result);
      const done = useCanvasStore.getState().updateNodeData;
      if (url) {
        done(videoNodeId, {
          videoUrl: url,
          isGenerating: false,
          generationStartedAt: null,
          sourceFileName: null,
        });
      } else {
        console.warn('[text-node] textToVideo completed without output url', completed);
        done(videoNodeId, { isGenerating: false, generationStartedAt: null });
      }
    } catch (error) {
      console.error('[text-node] textToVideo failed', error);
      errors.push(error instanceof Error ? error.message : String(error));
      useCanvasStore
        .getState()
        .updateNodeData(videoNodeId, { isGenerating: false, generationStartedAt: null });
    }
  };

  await Promise.allSettled(targetIds.map(runOne));
  return { nodeIds: targetIds, error: errors[0] ?? null };
}
