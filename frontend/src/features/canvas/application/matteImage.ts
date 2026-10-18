// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';
import { uploadFreezoneImage } from '@/api/ops';
import {
  CANVAS_NODE_TYPES,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
} from '@/features/canvas/domain/canvasNodes';
import { inheritMainlineFields } from '@/features/canvas/domain/inheritMainlineFields';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { matteInWorker } from './matteClient';

export interface MatteImageResult {
  /** The id of the newly built exportImage result node. */
  nodeId: string;
  /** Resolves when the background matting chain (fetch -> worker -> upload -> backfill/write error) settles (never rejects). */
  completion: Promise<void>;
}

/**
 * Matting orchestration (moved verbatim out of NodeActionToolbar.handleMatteImage, with zero semantic change):
 * immediately build an isGenerating exportImage result node downstream of the source node, connect the edge and select it, then
 * matte in the self-built Worker -> upload -> backfill the result url into the result node; on failure write the error to that node.
 * The workflow node toolbar and the storyboard detail toolbar share this one path.
 *
 * @param nodeId the source image node id (used to take aspectRatio / mainline inherited fields and positioning).
 * @param imageSource the source image url (already resolved by the caller with resolveNodeSourceImageUrl).
 * @param options.displayName the result node title (the workflow passes t('nodeToolbar.matting')).
 * @returns the result node id + the background chain completion (the detail toolbar uses it to collect the busy state);
 *   returns null when project is missing or the source node no longer exists.
 */
export function matteImage(
  nodeId: string,
  imageSource: string,
  options?: { displayName?: string },
): MatteImageResult | null {
  const store = useCanvasStore.getState();
  const node = store.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    return null;
  }
  const projectId = readUrl().project;
  if (!projectId) {
    console.warn(
      '[matte] no project_id in URL (?p=<project_id>) — cannot persist matted PNG',
    );
    return null;
  }

  const sourceAspectRatio =
    typeof (node.data as { aspectRatio?: unknown }).aspectRatio === 'string'
      ? ((node.data as { aspectRatio?: string }).aspectRatio ?? '1:1')
      : '1:1';
  const position = store.findNodePosition(
    node.id,
    EXPORT_RESULT_NODE_DEFAULT_WIDTH,
    EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  );
  // Same inheritance contract as the spawn-style overlays — matting produces a
  // user_spawned exportImage child that still represents the same canonical
  // slot at Push time.
  const matteInitialData = inheritMainlineFields(
    { data: node.data as Record<string, unknown> },
    {
      displayName: options?.displayName ?? i18n.t('canvas.matte.defaultTitle'),
      imageUrl: null,
      previewImageUrl: null,
      aspectRatio: sourceAspectRatio,
      resultKind: 'matte',
      isGenerating: true,
      generationStartedAt: Date.now(),
    },
  );
  const nextNodeId = store.addNode(
    CANVAS_NODE_TYPES.exportImage,
    position,
    matteInitialData as unknown as Parameters<typeof store.addNode>[2],
  );
  store.addEdge(node.id, nextNodeId);
  store.setSelectedNode(nextNodeId);
  store.requestFocusNode(nextNodeId);

  const sourceUrl = imageSource;
  const completion = (async () => {
    try {
      const sourceResp = await fetch(sourceUrl);
      if (!sourceResp.ok) {
        throw new Error(`fetch source failed: ${sourceResp.status}`);
      }
      const sourceBlob = await sourceResp.blob();
      // The whole matting runs inside the self-built Worker (see matteClient / matteWorker): whether or not WebGPU
      // is available, the main thread is not blocked, and the canvas stays smooth after clicking matting.
      const mattedBlob = await matteInWorker(sourceBlob);
      const filename = `matte-${node.id}-${Date.now()}.png`;
      const uploaded = await uploadFreezoneImage(projectId, mattedBlob, filename);
      useCanvasStore.getState().updateNodeData(nextNodeId, {
        imageUrl: uploaded.url,
        previewImageUrl: uploaded.url,
        isGenerating: false,
        generationStartedAt: null,
        generationError: null,
        generationErrorDetails: null,
      });
    } catch (error) {
      console.error('[matte] failed', error);
      const message = error instanceof Error ? error.message : String(error);
      useCanvasStore.getState().updateNodeData(nextNodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: message,
        generationErrorDetails: message,
      });
    }
  })();

  return { nodeId: nextNodeId, completion };
}
