// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { resolveMediaUrl } from '@/lib/media-url';

import { CANVAS_NODE_TYPES, type CanvasNode } from './canvasNodes';

export type CanvasAssetKind = 'image' | 'video' | 'audio' | 'model';

export interface CanvasAsset {
  /** Stable key, unique per (node, media url). */
  id: string;
  kind: CanvasAssetKind;
  /** Resolved, render-safe media url. */
  url: string;
  /** Poster / thumbnail for video & audio cards (resolved); null when none. */
  previewUrl: string | null;
  nodeId: string;
  /** Display name from the node, falls back to a kind label upstream. */
  label: string | null;
  /**
   * Generation prompt recorded on this asset. Only populated in the
   * generation-history source (where each record carries the exact prompt that
   * produced it); left undefined for live-canvas assets whose `label` is a node
   * display name, not a prompt. Used to seed a new node's prompt box on Use.
   */
  prompt?: string | null;
  /** Registry model id of the original generation (for restoration). undefined for old records. */
  model?: string | null;
  /** Original generation mode (for restoration). undefined for old records. */
  genMode?: string | null;
  /** Best-effort creation time in ms epoch; null when the node carries none. */
  timestamp: number | null;
}

export interface CanvasAssetBuckets {
  image: CanvasAsset[];
  video: CanvasAsset[];
  audio: CanvasAsset[];
  /** Director-world (3GS / 360 pano) assets. `url` is the .sog/.ply package or
   *  pano image; `previewUrl` is the cover used as a card thumbnail. */
  model: CanvasAsset[];
}

/**
 * Case-insensitive substring matching field by field. Deliberately `.some()` per field rather than concatenating prompt/label into one string:
 * concatenation would produce hits that do not exist out of "end of the previous field + start of the next" (e.g. prompt "kit" + label
 * "ten" hit by "kitten"), and in generation history prompt and label are often the same prompt text, so concatenation doubles
 * the scan volume of every asset.
 *
 * The same semantics as `filterBySearch` (components/assets/asset-search-box.tsx), but it is not imported here
 * - that is a .tsx component module, and importing it in the domain layer would drag in the whole React/shadcn graph.
 */
function matchesNeedle(asset: CanvasAsset, needle: string): boolean {
  return [asset.prompt, asset.label].some(
    (value) => typeof value === 'string' && value.toLowerCase().includes(needle),
  );
}

/**
 * Keyword search hit check (issue #175): match the asset's prompt and display name.
 *
 * The field meanings differ by source: in generation history prompt/label are both that generation's prompt (a world record's label
 * falls back to the upstream node name); for live-canvas picking prompt is always empty and label is the node name/file name (see the
 * `CanvasAsset.prompt` note) - so on that path only names are searchable, and the caller's placeholder should change its wording accordingly,
 * without promising "search prompts".
 *
 * Both ends of query are trimmed and it is case-insensitive; the query term is also normalized once here, so "must be lowercased in advance" is not
 * an implicit precondition (otherwise when callers pass the user's raw text directly, uppercase input would silently hit zero).
 */
export function assetMatchesQuery(asset: CanvasAsset, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return matchesNeedle(asset, needle);
}

/**
 * Filter the four asset buckets by keyword. An empty query returns the same object as is (no copy). All four buckets are filtered (not just
 * the current tab), so each tab's count directly reflects hits and the user can see which tab to look in. needle is normalized
 * only once, not recomputed on every asset.
 */
export function filterAssetBuckets(
  buckets: CanvasAssetBuckets,
  query: string,
): CanvasAssetBuckets {
  const needle = query.trim().toLowerCase();
  if (!needle) return buckets;
  const match = (asset: CanvasAsset) => matchesNeedle(asset, needle);
  return {
    image: buckets.image.filter(match),
    video: buckets.video.filter(match),
    audio: buckets.audio.filter(match),
    model: buckets.model.filter(match),
  };
}

function asRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** First non-empty string among the candidates. */
function firstStr(...values: unknown[]): string | null {
  for (const value of values) {
    const resolved = str(value);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

/**
 * Best-effort creation timestamp. Image nodes carry an ISO `committed_at`;
 * generative nodes keep a numeric `generationStartedAt`. Returns null when the
 * node has neither so the caller can bucket it under an "unknown date" group.
 *
 * Exported so other domain modules (e.g. `assetBoard.ts`) can reuse the exact
 * same rule instead of maintaining a copy.
 */
export function timestampOf(data: Record<string, unknown>): number | null {
  const committed = str(data.committed_at);
  if (committed) {
    const parsed = Date.parse(committed);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  const started = data.generationStartedAt;
  if (typeof started === 'number' && Number.isFinite(started)) {
    return started;
  }
  return null;
}

function labelOf(data: Record<string, unknown>): string | null {
  return firstStr(data.displayName, data.sourceFileName);
}

/** A raw asset on a node (not normalized by `resolveMediaUrl`). */
export interface CanvasNodeAsset {
  kind: CanvasAssetKind;
  /** Original file address - what a download should fetch, not the cover. */
  url: string;
  /** Cover used for cards/thumbnails; only has a value for assets without a still frame such as videos and 3D worlds. */
  previewUrl: string | null;
  /** Discriminator when the same node has several (grid cells). */
  suffix?: string;
}

/**
 * Which **raw** assets a node carries. This is the single source of truth for "node -> downloadable files": the asset
 * library ({@link extractCanvasAssets}) and the sidebar canvas outline both read it.
 *
 * It is extracted separately because this table is very easy to miss: the finished video of a video compose is in `resultVideoUrl`, the source
 * clip of a video story is in `sourceVideoUrl`, and a 3D world's package is in `plyUrl`, while all three kinds of nodes also carry
 * `previewImageUrl`. Anyone who writes their own version of "take videoUrl, otherwise fall back to the cover" would hand the poster to the user as
 * the finished video. The cover and the original are two fields here, kept semantically apart.
 */
export function resolveNodeAssets(node: CanvasNode): CanvasNodeAsset[] {
  const data = asRecord(node.data);
  const one = (
    kind: CanvasAssetKind,
    url: string | null,
    previewUrl: string | null = null,
  ): CanvasNodeAsset[] => (url ? [{ kind, url, previewUrl }] : []);

  switch (node.type) {
    case CANVAS_NODE_TYPES.upload:
    case CANVAS_NODE_TYPES.imageEdit:
    case CANVAS_NODE_TYPES.imageGen:
    case CANVAS_NODE_TYPES.exportImage:
      return one('image', firstStr(data.imageUrl, data.committed_slot_url, data.previewImageUrl));
    case CANVAS_NODE_TYPES.pano360Viewer:
      // The panorama viewer carries that spherical texture itself, so the original is imageUrl.
      return one('image', firstStr(data.imageUrl, data.previewImageUrl));
    case CANVAS_NODE_TYPES.storyboardSplit:
    case CANVAS_NODE_TYPES.storyboardGen: {
      const frames = Array.isArray(data.frames) ? data.frames : [];
      return frames.flatMap((frame, index) => {
        const frameData = asRecord(frame);
        const url = firstStr(frameData.imageUrl, frameData.previewImageUrl);
        return url
          ? [{ kind: 'image' as const, url, previewUrl: null, suffix: `frame-${index}` }]
          : [];
      });
    }
    case CANVAS_NODE_TYPES.video:
    case CANVAS_NODE_TYPES.videoStory:
      return one(
        'video',
        firstStr(data.videoUrl, data.sourceVideoUrl),
        str(data.previewImageUrl),
      );
    case CANVAS_NODE_TYPES.videoCompose:
      return one('video', firstStr(data.resultVideoUrl), str(data.previewImageUrl));
    case CANVAS_NODE_TYPES.videoBreakdown:
      // The breakdown node doesn't produce a finished clip itself, but a locally uploaded source video
      // only lives here — without registering it, the history panel can't reach it.
      return one('video', firstStr(data.sourceVideoUrl), str(data.previewImageUrl));
    case CANVAS_NODE_TYPES.audio:
      return one('audio', firstStr(data.audioUrl));
    case CANVAS_NODE_TYPES.threeDWorld:
      // The world's "asset" is its 3GS package (plyUrl, preferred) or a 360
      // pano image. The cover image is what we actually show on the card.
      return one('model', firstStr(data.plyUrl, data.panoUrl), str(data.previewImageUrl));
    default:
      return [];
  }
}

/**
 * A node's primary asset - what "download it" should get when only one item is allowed per node. Grid-type nodes have several images,
 * and the first is taken (bulk download of a whole node is traversed by the caller itself with {@link resolveNodeAssets}).
 */
export function resolveNodePrimaryAsset(node: CanvasNode): CanvasNodeAsset | null {
  return resolveNodeAssets(node)[0] ?? null;
}

/**
 * Pull every image / video / audio asset out of the live canvas nodes.
 *
 * The history panel reads straight from the in-memory canvas (no backend
 * round-trip): we walk each node, pick the media url that matches its kind, and
 * dedupe by resolved url so the same asset referenced twice shows once.
 */
export function extractCanvasAssets(nodes: CanvasNode[]): CanvasAssetBuckets {
  const buckets: CanvasAssetBuckets = { image: [], video: [], audio: [], model: [] };
  const seen = new Set<string>();

  for (const node of nodes) {
    const data = asRecord(node.data);
    const timestamp = timestampOf(data);
    const label = labelOf(data);

    for (const asset of resolveNodeAssets(node)) {
      const url = resolveMediaUrl(asset.url);
      if (!url || seen.has(url)) {
        continue;
      }
      seen.add(url);
      buckets[asset.kind].push({
        id: `${node.id}:${asset.suffix ?? ''}:${url}`,
        kind: asset.kind,
        url,
        previewUrl: resolveMediaUrl(asset.previewUrl),
        nodeId: node.id,
        label,
        timestamp,
      });
    }
  }

  return buckets;
}

export interface CanvasAssetDateGroup {
  /** `YYYY-MM-DD`, or null for assets without a usable timestamp. */
  date: string | null;
  assets: CanvasAsset[];
}

function dateKey(timestamp: number | null): string | null {
  if (timestamp === null) {
    return null;
  }
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Group assets by calendar day and sort. Dated groups come first (ordered by
 * `direction`); the undated bucket always sinks to the end.
 */
export function groupAssetsByDate(
  assets: CanvasAsset[],
  direction: 'desc' | 'asc',
): CanvasAssetDateGroup[] {
  const groups = new Map<string | null, CanvasAsset[]>();
  for (const asset of assets) {
    const key = dateKey(asset.timestamp);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(asset);
    } else {
      groups.set(key, [asset]);
    }
  }

  const sortByTime = (a: CanvasAsset, b: CanvasAsset) => {
    const ta = a.timestamp ?? 0;
    const tb = b.timestamp ?? 0;
    return direction === 'desc' ? tb - ta : ta - tb;
  };

  const dated: CanvasAssetDateGroup[] = [];
  let undated: CanvasAsset[] | null = null;
  for (const [key, bucket] of groups) {
    bucket.sort(sortByTime);
    if (key === null) {
      undated = bucket;
    } else {
      dated.push({ date: key, assets: bucket });
    }
  }

  dated.sort((a, b) =>
    direction === 'desc' ? (a.date! < b.date! ? 1 : -1) : a.date! < b.date! ? -1 : 1,
  );

  if (undated) {
    dated.push({ date: null, assets: undated });
  }
  return dated;
}
