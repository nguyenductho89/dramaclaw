// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { uploadFreezoneImage } from '@/api/ops';
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

import { loadImageElement } from './imageData';

/**
 * The orchestration layer of "Crop". The same family as imageRotate (local canvas transform -> upload -> write back to a
 * **pre-built result node**, with the source image always untouched); the difference is only in the transform itself: rotation expands the canvas, crop takes a sub-rectangle.
 *
 * Pure local computation, not going through generation endpoints - so no compute cost and no task polling.
 */

/** The crop frame, in the source image's **natural pixels** (not display pixels, nor a normalized ratio). */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Crop ratio options (the order is the order in the dropdown, aligned with liblib). `original` is the **original image ratio** -
 * locked to the source image's own aspect ratio, not free cropping; the crop frame is always ratio-locked, and the user only adjusts size and position.
 */
export const CROP_ASPECT_OPTIONS = ['original', '1:1', '4:3', '3:4', '16:9', '9:16'] as const;
export type CropAspectOption = (typeof CROP_ASPECT_OPTIONS)[number];

/**
 * Ratio option -> width/height number. `original` takes the source image's own ratio, so the natural size must be passed in.
 * Returns null when the size has not been measured (image not loaded), and the caller then does not place the crop frame for now.
 */
export function resolveCropAspectRatio(
  option: CropAspectOption,
  natural: { width: number; height: number },
): number | null {
  if (option === 'original') {
    return natural.width > 0 && natural.height > 0 ? natural.width / natural.height : null;
  }
  const [w, h] = option.split(':').map(Number);
  return w > 0 && h > 0 ? w / h : null;
}

/** The largest centered rectangle that fits in the whole image at a given ratio - the crop frame resets here when switching ratios. */
export function maxCenteredCropRect(
  natural: { width: number; height: number },
  ratio: number,
): CropRect {
  let width = natural.width;
  let height = width / ratio;
  if (height > natural.height) {
    height = natural.height;
    width = height * ratio;
  }
  return {
    x: (natural.width - width) / 2,
    y: (natural.height - height) / 2,
    width,
    height,
  };
}

/**
 * Whether the crop frame equals "the whole image". When the user presses "Confirm" without ever dragging the crop frame, this is used to take the "not committed"
 * path: no need to upload a new image pixel-identical to the original, nor to leave a result node from nowhere.
 *
 * Tolerance 1px: the crop frame is dragged out in display pixels, and converting back to natural pixels often leaves sub-pixel error.
 */
export function isFullFrameCrop(rect: CropRect, natural: { width: number; height: number }): boolean {
  return (
    rect.x <= 1
    && rect.y <= 1
    && rect.width >= natural.width - 1
    && rect.height >= natural.height - 1
  );
}

/**
 * Pre-build the "crop result" node (isomorphic with createRotateResultNode): build an exportImage node downstream of the source image node
 * previewing the source image and connect an edge - crop writes back in place onto this new node, and the source image stays untouched.
 *
 * @returns the new result node id; null when the source node does not exist / the type is unsupported / there is no image source.
 */
export function createCropResultNode(
  sourceNodeId: string,
  opts: { displayName: string },
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
  const newNodeId = store.addNode(
    CANVAS_NODE_TYPES.exportImage,
    position,
    {
      displayName: opts.displayName,
      imageUrl: null,
      previewImageUrl: sourceImageUrl,
      aspectRatio: sourceAspectRatio,
      resultKind: 'generic',
      isGenerating: false,
    } as unknown as Parameters<typeof store.addNode>[2],
  );
  store.addEdge(sourceNode.id, newNodeId);
  return newNodeId;
}

/**
 * Discard the pre-built "crop result" node: called when the user exits / presses Esc / confirms without selecting any region,
 * otherwise a node would appear from nowhere (same as discardRotateResultNode).
 */
export function discardCropResultNode(nodeId: string): void {
  useCanvasStore.getState().deleteNode(nodeId);
}

/**
 * Cut the image by the crop frame and write back to the result node in place: local canvas `drawImage` takes the sub-rectangle -> upload PNG ->
 * write the new url / new aspectRatio back to that node; on failure write the error to that node.
 *
 * @param rect the crop frame in natural pixel coordinates; the out-of-bounds part is clamped back into the image (dragging is already confined to the image,
 *   so this is only a defensive gate, avoiding drawImage producing transparent edges).
 * @returns a Promise that resolves when the background chain settles (never rejects); when project is missing it lands no
 *   state and returns null (the caller can use this to keep the editing state or reclaim the pre-built node).
 */
export function cropImageInPlace(
  nodeId: string,
  imageSource: string,
  rect: CropRect,
): Promise<void> | null {
  const project = readUrl().project;
  if (!project) {
    console.error('[crop] no project in URL — cannot persist result');
    return null;
  }

  useCanvasStore.getState().updateNodeData(nodeId, {
    isGenerating: true,
    generationStartedAt: Date.now(),
    generationError: null,
    generationErrorDetails: null,
  });

  return (async () => {
    try {
      const image = await loadImageElement(imageSource);
      const sx = Math.max(0, Math.min(Math.round(rect.x), image.naturalWidth - 1));
      const sy = Math.max(0, Math.min(Math.round(rect.y), image.naturalHeight - 1));
      const sw = Math.max(1, Math.min(Math.round(rect.width), image.naturalWidth - sx));
      const sh = Math.max(1, Math.min(Math.round(rect.height), image.naturalHeight - sy));

      const canvas = document.createElement('canvas');
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2d context unavailable');
      ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);

      const blob: Blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))),
          'image/png',
        );
      });

      const filename = `crop-${nodeId}-${Date.now()}.png`;
      const uploaded = await uploadFreezoneImage(project, blob, filename);

      useCanvasStore.getState().updateNodeData(nodeId, {
        imageUrl: uploaded.url,
        previewImageUrl: uploaded.url,
        aspectRatio: `${sw}:${sh}`,
        isGenerating: false,
        generationStartedAt: null,
        generationError: null,
        generationErrorDetails: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[crop] save failed', err);
      useCanvasStore.getState().updateNodeData(nodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: message,
        generationErrorDetails: message,
      });
    }
  })();
}
