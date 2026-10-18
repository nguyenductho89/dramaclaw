// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  isExportImageNode,
  isImageEditNode,
  isImageGenNode,
  isStoryboardGenNode,
  isUploadNode,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';

/**
 * Rule for picking images from upstream "image references" (formerly a private VideoNode helper, extracted to a shared module so the @imageN chips
 * in storyboard details reuse it — numbering and image picking must follow the same rule as the workflow, otherwise a chip would point to
 * a different image).
 */
export function referenceImageUrl(node: CanvasNode | undefined | null): string | null {
  if (!node) return null;
  if (isImageGenNode(node)) {
    const data = node.data;
    // The "reference image" an imageGen node uploads for generation is written to data.referenceImageUrl;
    // until the imageGen node has its own result it is the image the node presents,
    // so a video node should treat it as an upstream image reference as well.
    const ref =
      typeof data.referenceImageUrl === 'string' && data.referenceImageUrl.length > 0
        ? data.referenceImageUrl
        : null;
    return data.previewImageUrl || data.imageUrl || ref;
  }
  if (
    isUploadNode(node) ||
    isImageEditNode(node) ||
    isExportImageNode(node) ||
    isStoryboardGenNode(node)
  ) {
    const data = node.data;
    return data.previewImageUrl || data.imageUrl || null;
  }
  return null;
}

/**
 * Upstream "video references": a video node carries its own videoUrl, but a video picked from the asset library is an upload node
 * whose address is likewise stored in data.videoUrl. So "is this a video upstream" should be decided by
 * "a non-empty data.videoUrl exists", not by node type — otherwise library videos are missed (HappyHorse does not auto-switch to videoEdit,
 * submission finds no videoUrl), and they get mistaken for images by referenceImageUrl / isUploadNode.
 */
export function referenceVideoUrl(node: CanvasNode | undefined | null): string | null {
  if (!node) return null;
  const url = (node.data as { videoUrl?: unknown }).videoUrl;
  return typeof url === 'string' && url.length > 0 ? url : null;
}
