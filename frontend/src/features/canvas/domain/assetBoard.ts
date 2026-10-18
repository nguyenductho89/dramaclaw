// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { resolveMediaUrl } from '@/lib/media-url';

import { timestampOf } from './canvasAssets';
import {
  CANVAS_NODE_TYPES,
  isImageGenNode,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeData,
} from './canvasNodes';
import { readKeyElementCategory, type KeyElementCategory } from './keyElements';
import { resolveNodeDisplayName } from './nodeDisplay';
import { getStoryboardCellPreview, type StoryboardCellPreview } from './storyboardCellPreview';
import { sortUpstreamByReferenceOrder } from '../nodes/referenceOrdering';

export type AssetBoardColumn = 'text' | 'image' | 'video' | 'audio';

export interface AssetBoardReference {
  /** Id of the referenced upstream node; a node's own reference image (referenceImageUrl) has no separate upstream node and is null
   *  (same convention as the own-image entry in promptReferences). Downstream "Locate" silently degrades and "Edit" falls back to a lightbox view. */
  nodeId: string | null;
  label: string;
  thumbnailUrl: string;
}

export interface AssetBoardItem {
  nodeId: string;
  column: AssetBoardColumn;
  title: string;
  /** Main media address (image original / video mp4 / audio file); always null for the text column. */
  mediaUrl: string | null;
  /** Card thumbnail (image itself / video cover); null -> render a placeholder or the video first frame. */
  thumbnailUrl: string | null;
  /** Preview of the text column body (truncated to 80 characters). */
  textPreview: string | null;
  /** Model badge (the raw id of node data.model). */
  model: string | null;
  /** Duration (seconds, rounded down); video prefers durationSec, audio/uploaded video is converted from durationMs. */
  durationSec: number | null;
  /** Real pixel size. Mostly empty for generated media (a known data gap); shown when present. */
  widthPx: number | null;
  heightPx: number | null;
  /** Video column role: a video compose product is 'final'; others are 'clip'; null for non-video columns. */
  videoRole: 'final' | 'clip' | null;
  /** Upstream reference assets (edge order + referenceOrder reordering), keeping only those with thumbnails. */
  references: AssetBoardReference[];
  /** Timestamp converted from committed_at / generationStartedAt, null if none. An informational field only
   *  (e.g. for showing dates in future); in-column sorting now uses node creation order and no longer depends on it. */
  timestamp: number | null;
  /** In progress: isGenerating or isUploading (uploading a video) or isAnalyzing (analyzing), normalized to Boolean. */
  isGenerating: boolean;
  /** Generation start timestamp (data.generationStartedAt passed through as is; null if non-numeric/missing);
   *  cards/details use it plus an estimated duration for a time-based progress percentage (see useEstimatedProgress). */
  generationStartedAt: number | null;
  /** Reason of the latest failure (generationError ?? analysisError ?? uploadError), null if none. */
  generationError: string | null;
  /** Key element category (the mark set by the user via node "..." -> Set key element); null if unmarked. */
  keyElementCategory: KeyElementCategory | null;
}

export interface AssetBoardData {
  text: AssetBoardItem[];
  image: AssetBoardItem[];
  video: AssetBoardItem[];
  audio: AssetBoardItem[];
}

function asRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Truncate by Unicode code point (not UTF-16 code unit), avoiding a surrogate pair
// (e.g. an emoji) being cut in the middle, producing a lone surrogate and garbled characters.
function clip80(value: string | null): string | null {
  if (!value) return null;
  const codePoints = Array.from(value);
  return codePoints.length > 80 ? `${codePoints.slice(0, 80).join('')}…` : value;
}

function columnOf(node: CanvasNode): AssetBoardColumn | null {
  switch (node.type) {
    case CANVAS_NODE_TYPES.textAnnotation:
    case CANVAS_NODE_TYPES.script:
    case CANVAS_NODE_TYPES.videoStory: // Storyboard table: the content is shot rows, filed under the text column
    case CANVAS_NODE_TYPES.beatContext:
      return 'text';
    case CANVAS_NODE_TYPES.upload:
    case CANVAS_NODE_TYPES.imageEdit:
    case CANVAS_NODE_TYPES.imageGen:
    case CANVAS_NODE_TYPES.exportImage:
    case CANVAS_NODE_TYPES.storyboardSplit:
    case CANVAS_NODE_TYPES.storyboardGen:
      return 'image';
    case CANVAS_NODE_TYPES.video:
    case CANVAS_NODE_TYPES.videoCompose:
      return 'video';
    case CANVAS_NODE_TYPES.audio:
      return 'audio';
    default:
      // group / pano360Viewer / threeDWorld / skill are structural or tool nodes and do not enter the storyboard.
      return null;
  }
}

/**
 * Model badge text: what the node stores is the channel-internal id (`newapi_seedance-2.0-value`), and putting it on the card as is
 * is long and log-like. Here only the `<channel>_` prefix is stripped (-> `seedance-2.0-value`), with no id -> display name
 * mapping - display names exist only for models in the static table, and server-delivered models (happyhorse etc.) cannot be looked up,
 * and mixing would leave half of one column as "Seedance2.0 Value" and half as `happyhorse-1.0`.
 */
export function modelBadgeLabel(modelId: string): string {
  const separator = modelId.indexOf('_');
  if (separator <= 0 || separator === modelId.length - 1) return modelId;
  return modelId.slice(separator + 1);
}

function textPreviewOf(node: CanvasNode, data: Record<string, unknown>): string | null {
  switch (node.type) {
    case CANVAS_NODE_TYPES.textAnnotation:
    case CANVAS_NODE_TYPES.beatContext:
      return clip80(str(data.content));
    case CANVAS_NODE_TYPES.script:
      return clip80(str(data.scriptTitle) ?? str(data.prompt));
    case CANVAS_NODE_TYPES.videoStory: {
      const rows = Array.isArray(data.rows) ? data.rows.length : 0;
      return rows > 0 ? i18n.t('canvas.assetBoard.storyboardTableSummary', { count: rows }) : null;
    }
    default:
      return null;
  }
}

function mediaUrlOf(column: AssetBoardColumn, data: Record<string, unknown>, thumbnailUrl: string | null): string | null {
  switch (column) {
    case 'video':
      return resolveMediaUrl(str(data.videoUrl) ?? str(data.resultVideoUrl));
    case 'audio':
      return resolveMediaUrl(str(data.audioUrl));
    case 'image':
      // The image's "original" has the same source as the thumbnail (storyboardCellPreview already resolved a display-safe url).
      return thumbnailUrl;
    default:
      return null;
  }
}

function durationSecOf(column: AssetBoardColumn, data: Record<string, unknown>): number | null {
  // durationSec first, durationMs as the fallback, the same convention for video and audio: recognizing only video would leave an audio node with
  // durationSec recorded unable to show a duration, and would make the chip run a metadata probe for nothing.
  const explicit = num(data.durationSec);
  if ((column === 'video' || column === 'audio') && explicit !== null) return Math.floor(explicit);
  const ms = num(data.durationMs);
  if ((column === 'video' || column === 'audio') && ms !== null) return Math.floor(ms / 1000);
  return null;
}

/**
 * Pre-build in a single pass an index of "target node id -> upstream nodes (in edge order)", semantically exactly equivalent to calling
 * `upstreamNodesInEdgeOrder(nodes, edges, targetId)` point by point, but scanning
 * `edges` only once (O(N+E) rather than every downstream node scanning all edges).
 */
function buildUpstreamIndex(nodes: CanvasNode[], edges: CanvasEdge[]): Map<string, CanvasNode[]> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const index = new Map<string, CanvasNode[]>();
  for (const e of edges) {
    const source = byId.get(e.source);
    if (!source) continue;
    const list = index.get(e.target);
    if (list) {
      list.push(source);
    } else {
      index.set(e.target, [source]);
    }
  }
  return index;
}

/** `getStoryboardCellPreview` lazy cache: when one upstream node is referenced by several downstream consumers it is computed only once. */
function getCachedPreview(
  node: CanvasNode,
  cache: Map<string, StoryboardCellPreview>,
): StoryboardCellPreview {
  const cached = cache.get(node.id);
  if (cached) return cached;
  const preview = getStoryboardCellPreview(node);
  cache.set(node.id, preview);
  return preview;
}

function referencesOf(
  node: CanvasNode,
  upstreamIndex: Map<string, CanvasNode[]>,
  previewCache: Map<string, StoryboardCellPreview>,
): AssetBoardReference[] {
  const upstream = upstreamIndex.get(node.id) ?? [];
  const referenceOrder = asRecord(node.data).referenceOrder;
  const ordered = sortUpstreamByReferenceOrder(
    upstream,
    Array.isArray(referenceOrder) ? (referenceOrder as string[]) : undefined,
  );
  const refs: AssetBoardReference[] = [];
  const seenUrls = new Set<string>();

  // The node's own reference image (imageGen: the one the user picked straight from the asset library / replace-material into data.referenceImageUrl,
  // with no upstream edge) comes first, aligned with the @image1 numbering (orderedReferenceUrlsWithOwnFirst:
  // own image first, URLs deduplicated). It has no separate upstream node, so nodeId is null (aligned with the own-image entry
  // in promptReferences); "Locate" has nowhere to scroll -> silent, "Edit" -> lightbox view, both degrading gracefully without errors.
  // Only imageGen has the referenceImageUrl concept (consistent with promptReferences's precondition on isImageGenNode only).
  if (isImageGenNode(node)) {
    const rawOwn = asRecord(node.data).referenceImageUrl;
    const ownUrl =
      typeof rawOwn === 'string' && rawOwn.length > 0 ? resolveImageDisplayUrl(rawOwn) : null;
    if (ownUrl) {
      refs.push({ nodeId: null, label: i18n.t('canvas.assetBoard.referenceImage'), thumbnailUrl: ownUrl });
      seenUrls.add(ownUrl);
    }
  }

  for (const up of ordered) {
    if (!up.type) continue;
    const preview = getCachedPreview(up, previewCache);
    if (!preview.imageUrl) continue; // The reference row holds only upstreams with thumbnails (same as liblib)
    if (seenUrls.has(preview.imageUrl)) continue; // Same URL as the own image -> keep only the earliest one (same as orderedReferenceUrlsWithOwnFirst)
    seenUrls.add(preview.imageUrl);
    refs.push({
      nodeId: up.id,
      label: resolveNodeDisplayName(up.type, asRecord(up.data) as Partial<CanvasNodeData>),
      thumbnailUrl: preview.imageUrl,
    });
  }
  return refs;
}

/**
 * Data derivation of the storyboard view: sort canvas nodes into four buckets text/image/video/audio by media type.
 * A pure function (matches the liblib mechanism "storyboard = the second projection of graph data"), subscribed by callers with
 * `useMemo(() => buildAssetBoard(nodes, edges), [nodes, edges])`.
 */
export function buildAssetBoard(nodes: CanvasNode[], edges: CanvasEdge[]): AssetBoardData {
  const board: AssetBoardData = { text: [], image: [], video: [], audio: [] };
  const upstreamIndex = buildUpstreamIndex(nodes, edges);
  const previewCache = new Map<string, StoryboardCellPreview>();

  // Creation order of a node on the canvas: nodes array order (canvasStore.addNode appends to the end),
  // a larger index is newer. Serves as the recency signal for in-column sorting, see the newestFirst note below.
  const creationOrder = new Map<string, number>();
  nodes.forEach((node, index) => creationOrder.set(node.id, index));

  for (const node of nodes) {
    if (!node.type) continue;
    const column = columnOf(node);
    if (!column) continue;
    const data = asRecord(node.data);
    const preview = getCachedPreview(node, previewCache);
    const thumbnailUrl = preview.imageUrl;

    board[column].push({
      nodeId: node.id,
      column,
      title: resolveNodeDisplayName(node.type, data as Partial<CanvasNodeData>),
      mediaUrl: mediaUrlOf(column, data, thumbnailUrl),
      thumbnailUrl,
      textPreview: column === 'text' ? textPreviewOf(node, data) : null,
      model: str(data.model),
      durationSec: durationSecOf(column, data),
      widthPx: num(data.widthPx),
      heightPx: num(data.heightPx),
      videoRole:
        column !== 'video' ? null : node.type === CANVAS_NODE_TYPES.videoCompose ? 'final' : 'clip',
      references:
        column === 'image' || column === 'video'
          ? referencesOf(node, upstreamIndex, previewCache)
          : [],
      timestamp: timestampOf(data),
      isGenerating: Boolean(data.isGenerating) || Boolean(data.isUploading) || Boolean(data.isAnalyzing),
      generationError: str(data.generationError) ?? str(data.analysisError) ?? str(data.uploadError),
      generationStartedAt: num(data.generationStartedAt),
      keyElementCategory: readKeyElementCategory(data),
    });
  }

  // In-column sorting: by node creation order (nodes array order) newest to oldest, so the most recently created/generated node comes first
  // (matches liblib). Deliberately not sorted by committed_at / generationStartedAt timestamps:
  //   1) ordinary generation nodes have no committed_at, and generationStartedAt is cleared to null when generation completes
  //      - relying on timestamps would make a "just-finished node" sink with a null timestamp (exactly the bug the user reported);
  //   2) generationStartedAt exists only during generation, and sorting by it would make the same node jump up and down between "generating <-> done".
  //      Creation order is stable across the whole generation lifecycle, so positions do not jump.
  const newestFirst = (a: AssetBoardItem, b: AssetBoardItem) =>
    (creationOrder.get(b.nodeId) ?? -1) - (creationOrder.get(a.nodeId) ?? -1);
  board.text.sort(newestFirst);
  board.image.sort(newestFirst);
  board.video.sort(newestFirst);
  board.audio.sort(newestFirst);
  return board;
}
