// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  fetchFreezoneJobResult,
  submitFreezoneScene360,
  type FreezoneScene360AspectRatio,
} from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import {
  CANVAS_NODE_TYPES,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
} from '@/features/canvas/domain/canvasNodes';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { generationTaskDescriptor } from './resumeGeneration';

const PANO_VIEWER_LAYOUT_WIDTH = 720;
const PANO_VIEWER_LAYOUT_HEIGHT = 420;

export interface Scene360ImageResult {
  /** The id of the newly built exportImage panorama candidate node. */
  nodeId: string;
  /** Resolves when the background chain (submit -> poll -> backfill + build the 360 viewer / write error) settles (never rejects). */
  completion: Promise<void>;
}

/**
 * Panorama generation orchestration (moved verbatim out of Scene360Overlay.handleSubmit, with zero semantic change):
 * synchronously build an isGenerating exportImage panorama candidate node downstream of the source node
 * (output_role:'scene_360_candidate' / media_kind:'pano360') and connect an edge, then submit
 * /freezone/scene-360 -> wait for the task to complete -> backfill the product url, and build a
 * pano360Viewer viewer node downstream of the candidate node and connect an edge; on failure write the error to the candidate node.
 *
 * @returns the candidate node id + the background chain completion; null when project is missing or the source node no longer exists.
 */
export function scene360Image(
  sourceNodeId: string,
  imageSource: string,
  opts: {
    displayName: string;
    aspectRatio: FreezoneScene360AspectRatio;
  },
): Scene360ImageResult | null {
  const project = readUrl().project;
  if (!project) {
    console.error('[scene-360] no project in URL — cannot submit');
    return null;
  }
  const store = useCanvasStore.getState();
  const node = store.nodes.find((candidate) => candidate.id === sourceNodeId);
  if (!node) {
    return null;
  }

  const position = store.findNodePosition(
    node.id,
    EXPORT_RESULT_NODE_DEFAULT_WIDTH,
    EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  );
  const generationStartedAt = Date.now();
  const nextNodeId = store.addNode(
    CANVAS_NODE_TYPES.exportImage,
    position,
    {
      displayName: opts.displayName,
      imageUrl: null,
      previewImageUrl: null,
      aspectRatio: opts.aspectRatio,
      resultKind: 'generic',
      output_role: 'scene_360_candidate',
      media_kind: 'pano360',
      isGenerating: true,
      generationStartedAt,
    } as unknown as Parameters<typeof store.addNode>[2],
  );
  store.addEdge(node.id, nextNodeId);

  const completion = (async () => {
    try {
      const ref = await submitFreezoneScene360(project, {
        referenceUrl: imageSource.split('?')[0],
        aspectRatio: opts.aspectRatio,
      });
      useCanvasStore.getState().updateNodeData(nextNodeId, generationTaskDescriptor(ref));
      const completed = await awaitTaskCompletion(ref.task_key, project);
      const directUrl = completed.result?.['output_url'] as string | undefined;
      let url = directUrl;
      if (!url) {
        const fallback = await fetchFreezoneJobResult(project, ref.task_type, ref.job_id);
        url = fallback.url;
      }
      const doneStore = useCanvasStore.getState();
      doneStore.updateNodeData(nextNodeId, {
        imageUrl: url,
        previewImageUrl: url,
        aspectRatio: opts.aspectRatio,
        output_role: 'scene_360_candidate',
        media_kind: 'pano360',
        isGenerating: false,
        generationStartedAt: null,
        generationError: null,
      });

      const viewerPosition = doneStore.findNodePosition(
        nextNodeId,
        PANO_VIEWER_LAYOUT_WIDTH,
        PANO_VIEWER_LAYOUT_HEIGHT,
      );
      const viewerNodeId = doneStore.addNode(
        CANVAS_NODE_TYPES.pano360Viewer,
        viewerPosition,
      );
      doneStore.addEdge(nextNodeId, viewerNodeId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[scene-360] generation failed', err);
      useCanvasStore.getState().updateNodeData(nextNodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: message,
      });
    }
  })();

  return { nodeId: nextNodeId, completion };
}
