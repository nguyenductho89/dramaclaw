// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// This uses the default i18next instance (the one `@/i18n` initializes). `@/i18n` itself is not imported,
// because that module also pulls in react-i18next / HttpBackend, and putting it on this widely imported low-level chain
// would make every test that mocks react-i18next blow up at import time.
import i18n from 'i18next';

import {
  isAudioNode,
  isExportImageNode,
  isImageEditNode,
  isImageGenNode,
  isStoryboardGenNode,
  isUploadNode,
  isVideoNode,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';

/**
 * The **material connection limit** of a video node - blocked at edge creation rather than reported only at submission.
 *
 * What is capped here is the hard ceiling that "no model / no mode can consume", not the slot of the current mode:
 * first frame consumes only 1 image and first+last frame only 2, but on connecting a 2nd / 3rd image VideoNode's effect
 * automatically switches the mode to omni-reference / image reference; likewise connecting audio to Seedance 1.x automatically swaps the model to
 * 2.0. Blocking by the current mode's slot would block all these automatic rescues - the user could not connect a second image, and would
 * never trigger the automatic "first frame -> omni-reference" switch.
 *
 * So the basis is the **capability envelope**: 9 images / 3 videos / 3 audios / 12 total, matching the backend omni-gen's
 * `validate_omni_reference_limits` (src/novelvideo/freezone/video_node.py:522)
 * item by item. Beyond this line no switchable mode or model can consume, and blocking is what helps the user.
 *
 * The smaller numbers in the table (first frame 1 / first+last frame 2 / video edit 5 reference images) continue to be handled by "automatic mode switching"
 * and the submit guard, and are not blocked at the edge creation layer.
 *
 * 9/3/3/12 are only the **default values when no media catalog is configured**, not a hard ceiling for all models -
 * see `videoReferenceEnvelopeForModel`.
 */
export const VIDEO_REFERENCE_ENVELOPE = {
  image: 9,
  video: 3,
  audio: 3,
  total: 12,
} as const;

export interface VideoReferenceEnvelope {
  image: number;
  video: number;
  audio: number;
  total: number;
}

/** The fields in the media catalog related to reference limits (a subset of `ModelOption`). */
export interface VideoReferenceLimitModel {
  referenceImageMax?: number | null;
  referenceVideoMax?: number | null;
  referenceAudioMax?: number | null;
}

/**
 * The **effective** envelope of the selected model: media catalog config first, and 9/3/3/12 only if not configured.
 *
 * Aligned item by item with the backend `_catalog_reference_limits` (api/routes/freezone.py:7004), including how
 * total is computed: as soon as any one of the three comes from the catalog, total takes the sum of the three; only if none is configured is it 12.
 * Otherwise a legal model with image=10 configured in the catalog would be blocked by the frontend at the 10th image, and the request would never
 * reach the backend that would have accepted it - a limit stricter than the backend swallows the capability the admin configured.
 *
 * Only non-negative integers are accepted, the same basis as the backend `type(value) is int and value >= 0`: null / negative /
 * decimals are all treated as not configured.
 */
export function videoReferenceEnvelopeForModel(
  model: VideoReferenceLimitModel | null | undefined,
): VideoReferenceEnvelope {
  const fromCatalog = (value: number | null | undefined): number | null =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

  const image = fromCatalog(model?.referenceImageMax);
  const video = fromCatalog(model?.referenceVideoMax);
  const audio = fromCatalog(model?.referenceAudioMax);
  const resolved = {
    image: image ?? VIDEO_REFERENCE_ENVELOPE.image,
    video: video ?? VIDEO_REFERENCE_ENVELOPE.video,
    audio: audio ?? VIDEO_REFERENCE_ENVELOPE.audio,
  };
  const hasCatalogValue = image !== null || video !== null || audio !== null;
  return {
    ...resolved,
    total: hasCatalogValue
      ? resolved.image + resolved.video + resolved.audio
      : VIDEO_REFERENCE_ENVELOPE.total,
  };
}

/**
 * Edge validation has no React context, so the model can only be resolved by the caller and fed in. The default stays 9/3/3/12:
 * when no model can be passed in (tests, catalog not loaded yet) the behavior matches that before this change.
 */
export type VideoReferenceEnvelopeResolver = (
  videoNode: CanvasNode,
) => VideoReferenceEnvelope;

const DEFAULT_ENVELOPE_RESOLVER: VideoReferenceEnvelopeResolver = () => ({
  ...VIDEO_REFERENCE_ENVELOPE,
});

export type VideoReferenceMediaKind = 'image' | 'video' | 'audio';

/**
 * Classify an upstream node as an image / video / audio material; non-material nodes (text, script...) return null.
 *
 * The same basis as `upstreamTypeCounts` in VideoNode: **counted by node type, empty nodes count too**
 * (connecting the node first and filling in the material later is the normal order). The only exception is that `data.videoUrl` takes priority - a video
 * picked from the asset library is an upload node, and looking only at the type would mistake it for an image.
 */
export function classifyVideoReferenceMedia(
  node: CanvasNode | null | undefined,
): VideoReferenceMediaKind | null {
  if (!node) return null;
  const videoUrl = (node.data as { videoUrl?: unknown }).videoUrl;
  if (isVideoNode(node) || (typeof videoUrl === 'string' && videoUrl.length > 0)) {
    return 'video';
  }
  if (isAudioNode(node)) return 'audio';
  if (
    isImageGenNode(node) ||
    isUploadNode(node) ||
    isImageEditNode(node) ||
    isExportImageNode(node) ||
    isStoryboardGenNode(node)
  ) {
    return 'image';
  }
  return null;
}

/** The entry key of the prompt when each kind of material exceeds its limit - the whole sentence is in the entry, do not stitch half sentences in source. */
const KIND_LIMIT_KEYS: Record<VideoReferenceMediaKind, string> = {
  image: 'canvas.videoReference.limitImage',
  video: 'canvas.videoReference.limitVideo',
  audio: 'canvas.videoReference.limitAudio',
};

/**
 * Would this edge push the video node's materials past the capability envelope? Returns a non-empty reason, in which case the edge should be rejected.
 *
 * Shared by all edge creation paths (the manual drag `isValidConnection` greys out the drop target, the store's `onConnect`
 * is the fallback for the other paths), and the basis must have the same source: blocking in only one place would show as "highlighted as valid while
 * dragging, but nothing happens on release".
 *
 * A target that is not a video node, a source that is not a material node, or a source already connected (duplicate connection) is always let through.
 */
export function videoReferenceConnectionRejection(
  nodes: readonly CanvasNode[],
  edges: readonly { source: string; target: string }[],
  connection: { source?: string | null; target?: string | null },
  resolveEnvelope: VideoReferenceEnvelopeResolver = DEFAULT_ENVELOPE_RESOLVER,
): string | null {
  const { source, target } = connection;
  if (!source || !target) return null;
  const targetNode = nodes.find((node) => node.id === target);
  if (!isVideoNode(targetNode)) return null;
  const envelope = resolveEnvelope(targetNode);
  const incoming = classifyVideoReferenceMedia(
    nodes.find((node) => node.id === source),
  );
  if (!incoming) return null;

  const counted = new Set<string>();
  const counts = { image: 0, video: 0, audio: 0 };
  for (const edge of edges) {
    if (edge.target !== target) continue;
    // A duplicate connection from the same source does not add to the count; it could not create a second edge anyway.
    if (edge.source === source) return null;
    if (counted.has(edge.source)) continue;
    counted.add(edge.source);
    const kind = classifyVideoReferenceMedia(
      nodes.find((node) => node.id === edge.source),
    );
    if (kind) counts[kind] += 1;
  }

  if (counts[incoming] + 1 > envelope[incoming]) {
    return i18n.t(KIND_LIMIT_KEYS[incoming], { limit: envelope[incoming] });
  }
  const total = counts.image + counts.video + counts.audio;
  if (total + 1 > envelope.total) {
    return i18n.t('canvas.videoReference.limitTotal', { limit: envelope.total });
  }
  return null;
}

/**
 * Incoming edges of a video node that **already** exceed the envelope (returns the edge ids to clear).
 *
 * Edge-creation validation cannot catch cases where the type changes afterwards: external file import is "first build an empty Upload and connect it, then
 * convert it to a video/audio node by MIME"; at the moment of connecting, an empty Upload can only be counted as an image, so 4 video files all fall
 * within the image limit (9) - and once converted they become 4 video references, exceeding the video limit (3). So
 * after an operation that changes the material type such as `convertNodeType`, this function must be used to recompute.
 *
 * The retention policy is **first come, first served**: bucket by edge insertion order, and only those that do not fit overflow. The edge just converted is the
 * newest, so the one cleared is it - the user sees "the last one dragged in did not connect", rather than
 * an old edge randomly disappearing.
 */
export function overflowingVideoReferenceEdgeIds(
  nodes: readonly CanvasNode[],
  edges: readonly { id: string; source: string; target: string }[],
  videoTargetId: string,
  resolveEnvelope: VideoReferenceEnvelopeResolver = DEFAULT_ENVELOPE_RESOLVER,
): string[] {
  const targetNode = nodes.find((node) => node.id === videoTargetId);
  if (!isVideoNode(targetNode)) return [];
  const envelope = resolveEnvelope(targetNode);

  const counts = { image: 0, video: 0, audio: 0 };
  let total = 0;
  const counted = new Set<string>();
  const overflow: string[] = [];
  for (const edge of edges) {
    if (edge.target !== videoTargetId) continue;
    if (counted.has(edge.source)) continue;
    counted.add(edge.source);
    const kind = classifyVideoReferenceMedia(
      nodes.find((node) => node.id === edge.source),
    );
    if (!kind) continue;
    if (counts[kind] + 1 > envelope[kind] || total + 1 > envelope.total) {
      overflow.push(edge.id);
      continue;
    }
    counts[kind] += 1;
    total += 1;
  }
  return overflow;
}
