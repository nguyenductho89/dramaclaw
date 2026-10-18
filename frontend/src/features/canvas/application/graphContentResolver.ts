// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  isAudioNode,
  isExportImageNode,
  isImageEditNode,
  isImageGenNode,
  isScriptNode,
  isStoryboardGenNode,
  isTextAnnotationNode,
  isUploadNode,
  isVideoNode,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeType,
} from '../domain/canvasNodes';
import type { GraphContentResolver, UpstreamContent } from './ports';
import { isExecutionDependencyEdge } from '../nodes/referenceOrdering';

/**
 * A generic "downstream node -> upstream node content" traverser. One hop deep, finding all source nodes with
 * `edge.target === selfId` by edges and extracting the known content fields of each kind of node into the unified
 * {@link UpstreamContent} shape.
 *
 * Why only one hop: the UI semantics are "whoever I connect to, I take their output". Multiple hops would make the data
 * source inexplicable; add a recursive option when needed.
 */
export class DefaultGraphContentResolver implements GraphContentResolver {
  collectInputContents(
    nodeId: string,
    nodes: CanvasNode[],
    edges: CanvasEdge[]
  ): UpstreamContent[] {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const sourceIds = edges
      .filter((edge) => edge.target === nodeId && !isExecutionDependencyEdge(edge))
      .map((edge) => edge.source);

    return sourceIds
      .map((sourceId) => nodeById.get(sourceId))
      .filter((node): node is CanvasNode => node !== undefined)
      .map((node) => extractUpstreamContent(node));
  }
}

/**
 * Pure projection of a single node into its {@link UpstreamContent}. Exported so
 * the per-node subscription hook (`useUpstreamContents`) can map a shallow-
 * selected slice of upstream nodes without re-walking the whole graph.
 */
export function extractUpstreamContent(node: CanvasNode): UpstreamContent {
  const displayNameRaw = (node.data as { displayName?: unknown } | undefined)?.displayName;
  const workflowCatalog = (node.data as { workflowCatalog?: unknown } | undefined)?.workflowCatalog;
  const workflowStepIdRaw = workflowCatalog && typeof workflowCatalog === 'object'
    ? (workflowCatalog as { stepId?: unknown }).stepId
    : undefined;
  const base: UpstreamContent = {
    nodeId: node.id,
    nodeType: node.type as CanvasNodeType,
    displayName:
      typeof displayNameRaw === 'string' && displayNameRaw.length > 0
        ? displayNameRaw
        : undefined,
    workflowStepId:
      typeof workflowStepIdRaw === 'string' && workflowStepIdRaw.length > 0
        ? workflowStepIdRaw
        : undefined,
  };

  if (isTextAnnotationNode(node)) {
    return { ...base, text: nonEmpty(node.data.content) };
  }
  if (isUploadNode(node)) {
    // An upload node does not necessarily hold an image: in early versions a video picked from the asset library is an upload node, with the address written in
    // data.videoUrl (same basis as VideoNode.referenceVideoUrl). So look at videoUrl first - such
    // nodes often also carry previewImageUrl (a poster) at the same time, and looking only at image fields would dispatch a video to downstream as an
    // image: an image node would take it as a reference image, and it could not be found in "material references" either.
    const rawVideoUrl = (node.data as { videoUrl?: unknown }).videoUrl;
    const videoUrl = typeof rawVideoUrl === 'string' ? nonEmpty(rawVideoUrl) : undefined;
    if (videoUrl) return { ...base, videoUrl };
    return {
      ...base,
      imageUrl:
        nonEmpty(node.data.imageUrl)
        ?? nonEmpty(node.data.previewImageUrl ?? undefined)
        ?? nonEmpty((node.data as { source_url?: string }).source_url),
    };
  }
  if (isExportImageNode(node)) {
    return {
      ...base,
      imageUrl:
        nonEmpty(node.data.imageUrl) ?? nonEmpty(node.data.previewImageUrl ?? undefined),
    };
  }
  if (isImageEditNode(node) || isImageGenNode(node)) {
    // Downstream consumption needs "which image this node is showing right now": prefer the generation result imageUrl,
    // falling back to previewImageUrl / referenceImageUrl, covering the case of not yet generated with only a reference image attached.
    //
    // Does not carry `text`: an image node's prompt is "the instruction that generates this image", not text content to pass to
    // downstream. When downstream references an image node it should get only this image (image-to-image semantics),
    // otherwise the upstream prompt would be mixed into the downstream prompt (polluting both the input box chips and the submission).
    const referenceImageUrl = isImageGenNode(node)
      ? nonEmpty(node.data.referenceImageUrl ?? undefined)
      : undefined;
    return {
      ...base,
      imageUrl:
        nonEmpty(node.data.imageUrl)
        ?? nonEmpty(node.data.previewImageUrl ?? undefined)
        ?? referenceImageUrl,
    };
  }
  if (isStoryboardGenNode(node)) {
    return {
      ...base,
      imageUrl:
        nonEmpty(node.data.imageUrl) ?? nonEmpty(node.data.previewImageUrl ?? undefined),
    };
  }
  if (isVideoNode(node)) {
    // Same as image nodes: a video node's prompt is its own generation instruction, and when downstream references a video node
    // it takes only the video itself (videoUrl), without carrying the upstream prompt into downstream.
    return {
      ...base,
      videoUrl: nonEmpty(node.data.videoUrl),
    };
  }
  if (isAudioNode(node)) {
    return { ...base, audioUrl: nonEmpty(node.data.audioUrl) };
  }
  if (isScriptNode(node)) {
    const promptRaw = (node.data as { prompt?: unknown }).prompt;
    return {
      ...base,
      text: typeof promptRaw === 'string' ? nonEmpty(promptRaw) : undefined,
    };
  }
  return base;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > 0 ? value : undefined;
}

/**
 * Join all upstream `text` fields into a single prompt context, in order of appearance, filtering empty segments.
 * Callers generally prepend it to their own prompt before sending the request.
 */
export function joinUpstreamText(contents: UpstreamContent[]): string {
  return contents
    .map((content) => (typeof content.text === 'string' ? content.text.trim() : ''))
    .filter((text) => text.length > 0)
    .join('\n\n');
}

/**
 * Collect the URLs of all upstream nodes usable as "material references" - images and videos.
 * The backend `reference_urls` accepts image / video mixed in the same array.
 * Audio is not collected (image generation nodes do not use it).
 *
 * Return order: all imageUrl first, then all videoUrl, in upstream node connection order;
 * with built-in dedup, avoiding the same URL being fed in repeatedly by several resolvers.
 */
export function collectUpstreamReferenceUrls(contents: UpstreamContent[]): string[] {
  const out: string[] = [];
  for (const content of contents) {
    if (typeof content.imageUrl === 'string' && content.imageUrl.length > 0) {
      out.push(content.imageUrl);
    }
  }
  for (const content of contents) {
    if (typeof content.videoUrl === 'string' && content.videoUrl.length > 0) {
      out.push(content.videoUrl);
    }
  }
  return Array.from(new Set(out));
}
