// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  isAudioNode,
  isImageEditNode,
  isImageGenNode,
  isVideoNode,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { extractUpstreamContent } from '@/features/canvas/application/graphContentResolver';
import {
  referenceImageUrl,
  referenceVideoUrl,
} from '@/features/canvas/nodes/referenceMedia';
import {
  orderedReferenceUrlsWithOwnFirst,
  sortUpstreamByReferenceOrder,
} from '@/features/canvas/nodes/referenceOrdering';

/** The target resolved from one `@image1` / `@video2` / `@audio1` reference in a prompt. */
export interface PromptReferenceTarget {
  /** The mention label (without @), such as "image1". */
  label: string;
  kind: 'image' | 'video' | 'audio';
  /** Thumbnail / image body url; null when audio has no thumbnail. */
  thumbnailUrl: string | null;
  /** The matching upstream node id; a node's own reference image has no upstream node and is null. */
  nodeId: string | null;
}

function asRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
}

/**
 * Resolve which material each `@imageN` / `@videoN` / `@audioN` in a node's prompt points to.
 *
 * **The numbering rules fully reuse the workflow's two sets** (writing a separate set would misalign):
 *
 * - Image generation family (imageGen and same-family image nodes): `orderedReferenceUrlsWithOwnFirst(
 *   own referenceImageUrl, upstream image urls deduplicated in edge order)` - the node's own reference image takes position 1,
 *   and the backend also interprets imageN at this position (see the comment in referenceOrdering and ImageGenNode's
 *   mentionCandidates). It does **not** go through referenceOrder: ImageGenNode uses
 *   useUpstreamContents (pure edge order).
 * - Video family (VideoNode): first `sortUpstreamByReferenceOrder(upstream, data.referenceOrder)`,
 *   then count independently by *each own type* (three counters for image/video/audio), consistent with VideoNode's
 *   referenceMedia -> mentionCandidates. Note that in VideoNode the cap filter happens after
 *   the index increments, only affecting candidate visibility and not numbering, so the cap logic need not be copied here.
 *
 * @param node the node carrying the prompt.
 * @param upstreamNodes the node's one-hop upstream, **which must be in edge order**
 *   (`upstreamNodesInEdgeOrder`), consistent with how the workflow fetches data.
 * @returns label (without @) -> target. References that cannot be resolved do not appear in the map,
 *   and the caller degrades them to plain text accordingly.
 */
export function resolvePromptReferences(
  node: CanvasNode,
  upstreamNodes: CanvasNode[],
): Map<string, PromptReferenceTarget> {
  const out = new Map<string, PromptReferenceTarget>();
  if (isVideoNode(node)) {
    const ordered = sortUpstreamByReferenceOrder(
      upstreamNodes,
      asRecord(node.data).referenceOrder as string[] | undefined,
    );
    let imageIdx = 0;
    let videoIdx = 0;
    let audioIdx = 0;
    for (const upstream of ordered) {
      const videoUrl = referenceVideoUrl(upstream);
      if (videoUrl) {
        videoIdx += 1;
        const previewImageUrl = asRecord(upstream.data).previewImageUrl;
        out.set(`video${videoIdx}`, {
          label: `video${videoIdx}`,
          kind: 'video',
          thumbnailUrl:
            typeof previewImageUrl === 'string' && previewImageUrl.length > 0
              ? previewImageUrl
              : null,
          nodeId: upstream.id,
        });
        continue;
      }
      if (isAudioNode(upstream)) {
        const audioUrl = asRecord(upstream.data).audioUrl;
        if (typeof audioUrl !== 'string' || audioUrl.length === 0) continue;
        audioIdx += 1;
        out.set(`audio${audioIdx}`, {
          label: `audio${audioIdx}`,
          kind: 'audio',
          thumbnailUrl: null,
          nodeId: upstream.id,
        });
        continue;
      }
      const url = referenceImageUrl(upstream);
      if (url) {
        imageIdx += 1;
        out.set(`image${imageIdx}`, {
          label: `image${imageIdx}`,
          kind: 'image',
          thumbnailUrl: url,
          nodeId: upstream.id,
        });
      }
    }
    return out;
  }

  // Image family: the node's own reference image takes position 1, and upstream images follow in edge order (URL dedup).
  // Both ImageEditNode and the others use the `imageN` label; the numbering baseline is pure upstream images
  // (useUpstreamImages, see ImageEditNode's useReferenceMentionSync), with no slot for an own reference image.
  const labelPrefix = 'image';
  const ownReferenceUrl = isImageGenNode(node)
    ? ((): string | null => {
        const raw = asRecord(node.data).referenceImageUrl;
        return typeof raw === 'string' && raw.length > 0 ? raw : null;
      })()
    : null;
  // Isomorphic with ImageGenNode's upstreamImageContents: take upstream imageUrl in edge order and dedup by url.
  const upstreamImageEntries: Array<{ url: string; nodeId: string }> = [];
  const seen = new Set<string>();
  for (const upstream of upstreamNodes) {
    const content = extractUpstreamContent(upstream);
    const url = typeof content.imageUrl === 'string' ? content.imageUrl : '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    upstreamImageEntries.push({ url, nodeId: upstream.id });
  }
  const orderedUrls = orderedReferenceUrlsWithOwnFirst(
    ownReferenceUrl,
    upstreamImageEntries.map((entry) => entry.url),
  );
  orderedUrls.forEach((url, index) => {
    const label = `${labelPrefix}${index + 1}`;
    out.set(label, {
      label,
      kind: 'image',
      thumbnailUrl: url,
      nodeId: upstreamImageEntries.find((entry) => entry.url === url)?.nodeId ?? null,
    });
  });
  return out;
}
