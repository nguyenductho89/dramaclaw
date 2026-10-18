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
 * Pre-build the "rotate result" node (moved verbatim out of SelectedNodeOverlay.handleOpenRotate, with zero
 * semantic change): build an exportImage node downstream of the source image node previewing the source image and connect an edge - rotation
 * writes back in place onto this new node (RotateEditorOverlay / the detail flat row then calls
 * {@link rotateImageInPlace} on it), and the source image stays untouched.
 *
 * @returns the new result node id; null when the source node does not exist / the type is unsupported / there is no image source.
 */
export function createRotateResultNode(
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
 * Discard the pre-built "rotate result" node (functionalizing the pre-build / cancel-delete lifecycle): called when the user exits /
 * presses Esc / closes without any transform, otherwise a node would appear from nowhere.
 */
export function discardRotateResultNode(nodeId: string): void {
  useCanvasStore.getState().deleteNode(nodeId);
}

export interface RotateTransform {
  /** Rotation angle (degrees, 0-360, clockwise). */
  angleDeg: number;
  mirrorH: boolean;
  mirrorV: boolean;
}

/** No transform at all (angle 0 and no mirroring) - the caller takes the "not committed" close path accordingly. */
export function isIdentityRotateTransform(transform: RotateTransform): boolean {
  return transform.angleDeg === 0 && !transform.mirrorH && !transform.mirrorV;
}

/**
 * Rotate / mirror and write back in place (moved verbatim out of RotateEditorOverlay.handleSave, with zero semantic change):
 * local canvas rotation (the canvas is enlarged to hold the four corners at any angle) -> upload PNG ->
 * write the new url / new aspectRatio back to that node in place; on failure write the error to that node.
 *
 * @returns a Promise that resolves when the background chain settles (never rejects); when project is missing it lands no
 *   state and returns null (the caller can use this to keep the editing state or reclaim the pre-built node).
 */
export function rotateImageInPlace(
  nodeId: string,
  imageSource: string,
  transform: RotateTransform,
): Promise<void> | null {
  const project = readUrl().project;
  if (!project) {
    console.error('[rotate] no project in URL — cannot persist result');
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
      const sw = image.naturalWidth;
      const sh = image.naturalHeight;

      // The rotated canvas must contain all four corners of the image (at any angle).
      const rad = (transform.angleDeg * Math.PI) / 180;
      const cos = Math.abs(Math.cos(rad));
      const sin = Math.abs(Math.sin(rad));
      const dw = Math.max(1, Math.round(sw * cos + sh * sin));
      const dh = Math.max(1, Math.round(sw * sin + sh * cos));

      const canvas = document.createElement('canvas');
      canvas.width = dw;
      canvas.height = dh;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2d context unavailable');

      ctx.translate(dw / 2, dh / 2);
      ctx.rotate(rad);
      ctx.scale(transform.mirrorH ? -1 : 1, transform.mirrorV ? -1 : 1);
      ctx.drawImage(image, -sw / 2, -sh / 2);

      const blob: Blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))),
          'image/png',
        );
      });

      const filename = `rotate-${nodeId}-${Date.now()}.png`;
      const uploaded = await uploadFreezoneImage(project, blob, filename);

      const newAspectRatio = `${dw}:${dh}`;
      useCanvasStore.getState().updateNodeData(nodeId, {
        imageUrl: uploaded.url,
        previewImageUrl: uploaded.url,
        aspectRatio: newAspectRatio,
        isGenerating: false,
        generationStartedAt: null,
        generationError: null,
        generationErrorDetails: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[rotate] save failed', err);
      useCanvasStore.getState().updateNodeData(nodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: message,
        generationErrorDetails: message,
      });
    }
  })();
}
