// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  fetchFreezoneJobResult,
  submitFreezoneUpscale,
  type FreezoneUpscaleScaleFactor,
} from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  isExportImageNode,
  isImageEditNode,
  isImageGenNode,
  isUploadNode,
  resolveNodeSourceImageUrl,
} from '@/features/canvas/domain/canvasNodes';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { generationTaskDescriptor } from './resumeGeneration';

export const UPSCALE_IMAGE_SIZES = ['1K', '2K', '4K'] as const;
export type UpscaleImageSize = (typeof UPSCALE_IMAGE_SIZES)[number];
export const DEFAULT_UPSCALE_IMAGE_SIZE: UpscaleImageSize = '2K';

export const UPSCALE_SCALE_FACTORS: readonly FreezoneUpscaleScaleFactor[] = [2, 4, 6];
export const DEFAULT_UPSCALE_SCALE_FACTOR: FreezoneUpscaleScaleFactor = 2;

/** The model id written by default by the workflow pre-built node (the original hard-coded value of SelectedNodeOverlay). */
export const DEFAULT_UPSCALE_MODEL_ID = 'newapi_gpt_image2';

/**
 * Pre-build the "Upscale" result node (moved verbatim out of SelectedNodeOverlay.handleOpenUpscale, with
 * zero semantic change): build a resultKind:'upscale' exportImage placeholder
 * node downstream of the source image node and connect an edge - without submitting the task. The workflow entry then selects it to expand the UpscaleEditorOverlay configuration
 * panel; the storyboard detail, after choosing the configuration in the detail, directly calls {@link submitImageUpscale} on it.
 *
 * @returns the new placeholder node id; null when the source node does not exist / the type is unsupported / there is no image source.
 */
export function createUpscaleResultNode(
  sourceNodeId: string,
  opts: {
    displayName: string;
    modelId?: string;
    imageSize?: UpscaleImageSize;
    scaleFactor?: FreezoneUpscaleScaleFactor;
  },
): string | null {
  const store = useCanvasStore.getState();
  const sourceNode = store.nodes.find((candidate) => candidate.id === sourceNodeId);
  if (!sourceNode) {
    return null;
  }
  if (
    !isUploadNode(sourceNode)
    && !isImageEditNode(sourceNode)
    && !isImageGenNode(sourceNode)
    && !isExportImageNode(sourceNode)
  ) {
    return null;
  }
  // Consistent with the toolbar's canHandleImage / other image tools, use the unified helper to get the image source
  // - it recognizes imageGen nodes (including the referenceImageUrl fallback).
  const sourceImageUrl = resolveNodeSourceImageUrl(sourceNode);
  if (!sourceImageUrl) {
    return null;
  }

  const sourceAspectRatio =
    typeof (sourceNode.data as { aspectRatio?: unknown }).aspectRatio === 'string'
      ? ((sourceNode.data as { aspectRatio?: string }).aspectRatio ?? DEFAULT_ASPECT_RATIO)
      : DEFAULT_ASPECT_RATIO;
  const position = store.findNodePosition(
    sourceNode.id,
    EXPORT_RESULT_NODE_DEFAULT_WIDTH,
    EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  );
  const placeholderNodeId = store.addNode(
    CANVAS_NODE_TYPES.exportImage,
    position,
    {
      displayName: opts.displayName,
      imageUrl: null,
      previewImageUrl: sourceImageUrl,
      aspectRatio: sourceAspectRatio,
      resultKind: 'upscale',
      isGenerating: false,
      // Persist enough to (re-)run the upscale and to drive the always-attached panel.
      upscaleSourceUrl: sourceImageUrl,
      upscaleModelId: opts.modelId ?? DEFAULT_UPSCALE_MODEL_ID,
      upscaleImageSize: opts.imageSize ?? DEFAULT_UPSCALE_IMAGE_SIZE,
      upscaleScaleFactor: opts.scaleFactor ?? DEFAULT_UPSCALE_SCALE_FACTOR,
    } as unknown as Parameters<typeof store.addNode>[2],
  );
  store.addEdge(sourceNode.id, placeholderNodeId);
  return placeholderNodeId;
}

/**
 * Upscale submission orchestration (moved verbatim out of UpscaleEditorOverlay.handleSubmit, with zero semantic change):
 * set isGenerating on the result node -> submit /freezone/upscale -> wait for the task to complete (falling back to the job result when
 * output_url is missing) -> backfill the product url into that node; on failure write the error to that node.
 *
 * @returns a Promise that resolves when the background chain settles (never rejects); when sourceUrl or
 *   project is missing it lands no state and returns null.
 */
export function submitImageUpscale(
  nodeId: string,
  opts: {
    sourceUrl: string;
    scaleFactor: FreezoneUpscaleScaleFactor;
    imageSize: string;
    model: string;
  },
): Promise<void> | null {
  if (!opts.sourceUrl) {
    console.error('[upscale] missing source url — cannot submit');
    return null;
  }
  const project = readUrl().project;
  if (!project) {
    console.error('[upscale] no project in URL — cannot submit');
    return null;
  }

  const generationStartedAt = Date.now();
  useCanvasStore.getState().updateNodeData(nodeId, {
    isGenerating: true,
    generationStartedAt,
    generationError: null,
  });

  return (async () => {
    try {
      const ref = await submitFreezoneUpscale(project, {
        sourceUrl: opts.sourceUrl.split('?')[0],
        scaleFactor: opts.scaleFactor,
        imageSize: opts.imageSize,
        model: opts.model,
      });
      useCanvasStore.getState().updateNodeData(nodeId, generationTaskDescriptor(ref));
      const completed = await awaitTaskCompletion(ref.task_key, project);
      const directUrl = completed.result?.['output_url'] as string | undefined;
      let url = directUrl;
      if (!url) {
        const fallback = await fetchFreezoneJobResult(project, ref.task_type, ref.job_id);
        url = fallback.url;
      }
      useCanvasStore.getState().updateNodeData(nodeId, {
        imageUrl: url,
        previewImageUrl: url,
        isGenerating: false,
        generationStartedAt: null,
        generationError: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[upscale] generation failed', err);
      useCanvasStore.getState().updateNodeData(nodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: message,
      });
    }
  })();
}
