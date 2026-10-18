// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { submitFreezoneAnalyzeVideoStory } from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { normalizeVideoStoryRows } from './videoStoryNormalizer';

/** Landing size of the video story node (consistent with NodeActionToolbar.handleVideoAnalyze). */
const STORY_LAYOUT_WIDTH = 720;
const STORY_LAYOUT_HEIGHT = 360;

export interface VideoAnalyzeStoryResult {
  /** The id of the synchronously built videoStory node (loading state, backfilled in place when data comes back). */
  nodeId: string;
  /** Resolves when the background chain (submit -> poll -> normalize backfill / write error) settles (never rejects). */
  completion: Promise<void>;
}

/**
 * The background chain of submit -> poll -> normalize -> backfill (shared by first-time analysis and re-analysis).
 *
 * @param storyNodeId the videoStory node carrying the result (for first-time analysis it was just built; for re-analysis it is itself).
 * @param sourceNodeId the source video node that triggered the analysis; null on re-analysis (there is no separate source node to sync
 *   loading/error state with - the story node itself is the source).
 */
function runStoryAnalysis(
  projectId: string,
  storyNodeId: string,
  sourceNodeId: string | null,
  opts: { videoUrl: string; durationSec?: number },
): Promise<void> {
  return (async () => {
    try {
      const submitResp = (await submitFreezoneAnalyzeVideoStory(projectId, {
        videoUrl: opts.videoUrl,
        durationSec: opts.durationSec,
      })) as unknown;
      console.info('[video-analyze] submit response', submitResp);

      const submitRecord =
        submitResp && typeof submitResp === 'object'
          ? (submitResp as Record<string, unknown>)
          : {};
      const taskKey =
        typeof submitRecord.task_key === 'string' ? submitRecord.task_key : null;

      let rawResult: Record<string, unknown>;
      if (taskKey) {
        const completed = await awaitTaskCompletion(taskKey, projectId);
        console.info('[video-analyze] task completed', completed.result);
        rawResult = (completed.result ?? {}) as Record<string, unknown>;
      } else {
        // Endpoint returned the result synchronously (OpenAPI 200 is `{}` —
        // not guaranteed to be the async FreezoneJobAcceptedResponse).
        console.info('[video-analyze] no task_key, treating response as inline result');
        rawResult = submitRecord;
      }

      const rows = normalizeVideoStoryRows(rawResult);
      console.info('[video-analyze] normalized rows', rows.length, rows);

      // Backfill the analysis result into the story node carrying the result.
      const done = useCanvasStore.getState();
      done.updateNodeData(storyNodeId, {
        rows,
        rawResult,
        isAnalyzing: false,
        analysisError: null,
      } as unknown as Parameters<typeof done.updateNodeData>[1]);
      if (sourceNodeId) {
        done.updateNodeData(sourceNodeId, {
          isAnalyzing: false,
          analysisError: null,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[video-analyze] failed', error);
      // Write the error to the story node and clear its loading state.
      const failed = useCanvasStore.getState();
      failed.updateNodeData(storyNodeId, {
        isAnalyzing: false,
        analysisError: message,
      });
      if (sourceNodeId) {
        failed.updateNodeData(sourceNodeId, {
          isAnalyzing: false,
          analysisError: message,
        });
      }
    }
  })();
}

/**
 * Video analysis (generate storyboard story) orchestration (moved verbatim out of NodeActionToolbar's handleVideoAnalyze inline
 * closure, with zero semantic change):
 * the source node sets isAnalyzing -> immediately build a loading-state videoStory node downstream and connect an edge (without waiting for the
 * backend to return) -> submit /freezone/analyze-video-story -> if there is a task_key wait for the task to complete, otherwise
 * treat the response itself as a synchronous result -> after normalizeVideoStoryRows backfill the story node; on failure write the error to both
 * the story node and the source node.
 *
 * @returns the story node id + background chain; null when project is missing or the source node no longer exists.
 */
export function analyzeVideoStory(
  sourceNodeId: string,
  opts: {
    videoUrl: string;
    /** Source video duration (seconds) - not sent if absent, letting the backend probe by itself. */
    durationSec?: number;
  },
): VideoAnalyzeStoryResult | null {
  const projectId = readUrl().project;
  if (!projectId) {
    console.error('[video-analyze] no project in URL');
    return null;
  }
  const store = useCanvasStore.getState();
  const node = store.nodes.find((candidate) => candidate.id === sourceNodeId);
  if (!node) return null;

  store.updateNodeData(sourceNodeId, {
    isAnalyzing: true,
    analysisError: null,
  });

  // Immediately build a loading-state video story node downstream - without waiting for the backend to return.
  // After the data comes back, updateNodeData fills the storyboard in; on failure the error is written to that node.
  const storyPosition = store.findNodePosition(
    sourceNodeId,
    STORY_LAYOUT_WIDTH,
    STORY_LAYOUT_HEIGHT,
  );
  const storyNodeId = store.addNode(CANVAS_NODE_TYPES.videoStory, storyPosition, {
    sourceVideoUrl: opts.videoUrl,
    rows: [],
    rawResult: null,
    isAnalyzing: true,
    analysisStartedAt: Date.now(),
    analysisError: null,
  } as unknown as Parameters<typeof store.addNode>[2]);
  store.addEdge(sourceNodeId, storyNodeId);

  return {
    nodeId: storyNodeId,
    completion: runStoryAnalysis(projectId, storyNodeId, sourceNodeId, opts),
  };
}

/**
 * Re-analyze an existing video story node: build no new node and no new edge, reset itself directly to the loading state and run the same chain again with
 * **the source clip it remembers** (data.sourceVideoUrl), with the result
 * overwriting rows/rawResult in place.
 *
 * Shares runStoryAnalysis with {@link analyzeVideoStory} - first-time analysis builds a node, re-analysis
 * reuses the node, and apart from that submit/poll/normalize/backfill are exactly the same implementation.
 *
 * @returns the story node id + background chain; null when project is missing, the node no longer exists, or it does not remember its source clip.
 */
export function reanalyzeVideoStory(
  storyNodeId: string,
  opts?: { durationSec?: number },
): VideoAnalyzeStoryResult | null {
  const projectId = readUrl().project;
  if (!projectId) {
    console.error('[video-analyze] no project in URL');
    return null;
  }
  const store = useCanvasStore.getState();
  const node = store.nodes.find((candidate) => candidate.id === storyNodeId);
  if (!node) return null;
  const sourceVideoUrl = (node.data as { sourceVideoUrl?: unknown }).sourceVideoUrl;
  if (typeof sourceVideoUrl !== 'string' || sourceVideoUrl.length === 0) {
    console.warn('[video-analyze] reanalyze: story node has no sourceVideoUrl', storyNodeId);
    return null;
  }

  store.updateNodeData(storyNodeId, {
    isAnalyzing: true,
    analysisStartedAt: Date.now(),
    analysisError: null,
  });

  return {
    nodeId: storyNodeId,
    completion: runStoryAnalysis(projectId, storyNodeId, null, {
      videoUrl: sourceVideoUrl,
      durationSec: opts?.durationSec,
    }),
  };
}
