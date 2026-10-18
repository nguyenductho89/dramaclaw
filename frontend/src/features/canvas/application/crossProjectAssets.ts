// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { copyFreezoneAssets } from '@/api/ops';
import type { CanvasNodeData } from '@/features/canvas/domain/canvasNodes';

/**
 * Asset migration on cross-project paste.
 *
 * Canvas copy/paste is only a deep copy of node data, and media URLs (videoUrl / imageUrl / audioUrl ...)
 * are kept as they are, still pointing at the static paths of the "source project". After pasting into another project these assets do not belong to the
 * target project (not in the asset library, they stop working once the source project is deleted, and non-members of the source project get a 403 when opening them).
 *
 * Constraint: **the source project's URLs never enter the store or the persisted data at any time.** On paste, first use
 * `withholdForeignAssetUrls` to blank these fields and record their positions, and the node enters the store with
 * `assetMigration: 'copying'` (the node shell renders an "Assets copying" placeholder); then hand the recorded
 * URLs to the backend `freezone/assets/copy`, where the backend copies the files into the target project server-side (CopyObject under OSS deployment,
 * bytes do not pass through the browser); on success fill the target project's new address back into the original position and remove the marker, and the node
 * is then complete; on failure the fields stay empty and are marked `'failed'`, so the user deletes and pastes again. Even if autosave is
 * resumed by a timeout during migration, what gets persisted is only a "placeholder node without URLs", never the source project address.
 *
 * Identification strategy: recursively traverse node data, and migrate any string whose key ends with `Url` and whose value is a "same-origin /static/projects/<pid>/...
 * or /api/v1/projects/<pid>/media/... path". This needs no field whitelist,
 * and nested structures such as stacked-card albums / storyboard frames are covered automatically.
 */

// Maximum number of URLs per request: the backend limit per request is 200; leave headroom, and let large batch pastes return results in batches.
const COPY_BATCH_SIZE = 64;

const STATIC_PROJECT_PREFIX = '/static/projects/';
const MEDIA_PROJECT_RE = /^\/api\/v1\/projects\/([^/]+)\/media\/.+/;

export interface CopyableAsset {
  /** The same-origin path sent to the backend (including the query string; the backend maps back by the original string). */
  source: string;
  /** The project id the URL points to (decoded). */
  project: string;
}

/**
 * Normalize a stored raw URL into "a same-origin project path the backend can copy".
 *
 * Key point: do **not** go through `resolveMediaUrl` - it would re-anchor legacy `/static/<user>/<project>/...`
 * to the current route's project. Only the canonical form with a project id is accepted here; the legacy form already returns 410 from the backend
 * and cannot be authorized by project, so it is simply not accepted.
 */
export function toCopyableAsset(raw: string): CopyableAsset | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  // data: / blob: are not cross-project static assets; protocol-relative is always rejected.
  if (trimmed.startsWith('data:') || trimmed.startsWith('blob:') || trimmed.startsWith('//')) {
    return null;
  }
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
  let parsed: URL;
  try {
    parsed = new URL(trimmed, origin);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  // Cross-origin media is not supported in this deployment (the backend /static is always same-origin via the edge proxy).
  if (typeof window !== 'undefined' && parsed.origin !== window.location.origin) {
    return null;
  }
  const project = projectIdFromPath(parsed.pathname);
  if (!project) {
    return null;
  }
  return { source: parsed.pathname + parsed.search, project };
}

function projectIdFromPath(pathname: string): string | null {
  let encoded: string | null = null;
  if (pathname.startsWith(STATIC_PROJECT_PREFIX)) {
    const rest = pathname.slice(STATIC_PROJECT_PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash > 0 && slash < rest.length - 1) {
      encoded = rest.slice(0, slash);
    }
  } else {
    const match = MEDIA_PROJECT_RE.exec(pathname);
    if (match) {
      encoded = match[1];
    }
  }
  if (!encoded) {
    return null;
  }
  try {
    return decodeURIComponent(encoded) || null;
  } catch {
    return null;
  }
}

/** The migration state field in node data; only nodes pasted across projects and carrying out-of-project media have it. */
export const ASSET_MIGRATION_KEY = 'assetMigration';

export type AssetMigrationState = 'copying' | 'failed';

export function readAssetMigrationState(data: unknown): AssetMigrationState | null {
  if (!data || typeof data !== 'object') {
    return null;
  }
  const value = (data as Record<string, unknown>)[ASSET_MIGRATION_KEY];
  return value === 'copying' || value === 'failed' ? value : null;
}

/** A blanked media field: its path in the node data + the original URL pointing to the source project. */
export interface WithheldAssetRef {
  path: Array<string | number>;
  url: string;
}

function withholdInto(
  value: unknown,
  targetProject: string,
  path: Array<string | number>,
  out: WithheldAssetRef[],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => withholdInto(item, targetProject, [...path, index], out));
  }
  if (value && typeof value === 'object') {
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (typeof child === 'string' && /url$/i.test(key)) {
        const asset = toCopyableAsset(child);
        if (asset && asset.project !== targetProject) {
          out.push({ path: [...path, key], url: child });
          next[key] = null;
          continue;
        }
        next[key] = child;
        continue;
      }
      next[key] = withholdInto(child, targetProject, [...path, key], out);
    }
    return next;
  }
  return value;
}

/**
 * Called **before** pasting into the store: blank all media URLs in the node data that point to other projects and record their positions.
 * The returned data can go straight into the store / be persisted - it no longer contains any source project address. When there is no out-of-project media,
 * `withheld` is empty and the data is unchanged (no marker added).
 */
export function withholdForeignAssetUrls(
  data: CanvasNodeData,
  targetProject: string,
): { data: CanvasNodeData; withheld: WithheldAssetRef[] } {
  const withheld: WithheldAssetRef[] = [];
  const stripped = withholdInto(data, targetProject, [], withheld) as Record<string, unknown>;
  if (withheld.length === 0) {
    return { data, withheld };
  }
  stripped[ASSET_MIGRATION_KEY] = 'copying';
  return { data: stripped as unknown as CanvasNodeData, withheld };
}

export function readAtPath(root: unknown, path: Array<string | number>): unknown {
  let cursor: unknown = root;
  for (const segment of path) {
    if (!cursor || typeof cursor !== 'object') {
      return undefined;
    }
    cursor = (cursor as Record<string | number, unknown>)[segment];
  }
  return cursor;
}

/** Pure function: write `value` at `path` of `root`, shallow-copying containers along the way, and return the new root. */
export function writeAtPath(root: unknown, path: Array<string | number>, value: unknown): unknown {
  if (path.length === 0) {
    return value;
  }
  const [head, ...rest] = path;
  if (Array.isArray(root)) {
    const next = [...root];
    next[head as number] = writeAtPath(root[head as number], rest, value);
    return next;
  }
  const source = (root && typeof root === 'object' ? root : {}) as Record<string, unknown>;
  return { ...source, [head]: writeAtPath(source[head as string], rest, value) };
}

// --- Registry of migrations in progress: the placeholder rendering uses it to tell "copying" from "marker still there but the task is gone" ---
// The latter happens on refresh (the store has the persisted copying marker, and the task is gone along with the page) or when the migration unexpectedly throws,
// and is always rendered as a failure placeholder, so the spinner never spins forever. This PR does not do resume across refresh.
const inFlightNodeIds = new Set<string>();
const inFlightListeners = new Set<() => void>();

function setInFlight(nodeIds: readonly string[], active: boolean): void {
  let changed = false;
  for (const nodeId of nodeIds) {
    if (active ? !inFlightNodeIds.has(nodeId) : inFlightNodeIds.has(nodeId)) {
      changed = true;
    }
    if (active) {
      inFlightNodeIds.add(nodeId);
    } else {
      inFlightNodeIds.delete(nodeId);
    }
  }
  if (!changed) {
    return;
  }
  for (const listener of [...inFlightListeners]) {
    listener();
  }
}

export function isAssetMigrationInFlight(nodeId: string): boolean {
  return inFlightNodeIds.has(nodeId);
}

/** For useSyncExternalStore: notify when the registry changes; the snapshot uses `isAssetMigrationInFlight`. */
export function subscribeAssetMigrations(listener: () => void): () => void {
  inFlightListeners.add(listener);
  return () => {
    inFlightListeners.delete(listener);
  };
}

/**
 * Which reasons in the backend's `failed[].reason` do not mean "this source cannot be copied".
 *
 * `unavailable` = an error other than 403/404 when resolving the source project (5xx); `copy_failed` = an OSError while copying or preparing the target
 * file. The remaining `forbidden` / `not_found` / `invalid_source` are conclusions about the source itself.
 */
const RETRYABLE_COPY_REASONS = new Set(['unavailable', 'copy_failed']);

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

/**
 * Have the backend copy in batches, returning a mapping of normalized path -> new URL, plus two kinds of paths that were not copied.
 *
 * `failed` is the backend's conclusion about the **source itself** (no permission / source gone / URL invalid), which is the same however many times it is retried;
 * `unavailable` means this time it did not get copied but may next time - network down, backend 5xx, the source project temporarily unresolvable,
 * and `copy_failed`: that is an OSError while copying or creating the target file, a storage-side problem, not that this source cannot be copied.
 * They are separated because callers treat the two in opposite ways: the former can be cleared to converge, while clearing the latter trades a network
 * blip for the user permanently losing images. The failure of a whole batch only affects that batch.
 */
export async function copyAssetsInBatches(
  targetProject: string,
  sources: string[],
): Promise<{ mapping: Map<string, string>; failed: Set<string>; unavailable: Set<string> }> {
  const mapping = new Map<string, string>();
  const failed = new Set<string>();
  const unavailable = new Set<string>();
  for (const batch of chunk(sources, COPY_BATCH_SIZE)) {
    try {
      const result = await copyFreezoneAssets(targetProject, batch);
      for (const [source, newUrl] of Object.entries(result.mapping ?? {})) {
        if (typeof newUrl === 'string' && newUrl && newUrl !== source) {
          mapping.set(source, newUrl);
        }
      }
      for (const item of result.failed ?? []) {
        if (RETRYABLE_COPY_REASONS.has(item.reason)) {
          unavailable.add(item.source);
          console.warn('[cross-project-assets] copy unavailable, will not touch the field', item);
          continue;
        }
        failed.add(item.source);
        console.warn('[cross-project-assets] copy failed, field stays empty', item);
      }
    } catch (error) {
      // The request itself did not go through: there is no evidence that these sources really cannot be copied.
      for (const source of batch) {
        unavailable.add(source);
      }
      console.warn('[cross-project-assets] copy request failed, fields left untouched', {
        count: batch.length,
        error,
      });
    }
  }
  return { mapping, failed, unavailable };
}

export interface PastedNodeForMigration {
  id: string;
  /** The media positions recorded by `withholdForeignAssetUrls` that are waiting to be filled back. */
  withheld: WithheldAssetRef[];
}

export interface AssetMigrationSummary {
  /** Number of deduplicated assets successfully copied into the target project. */
  migrated: number;
  /** Number of deduplicated assets that failed to copy (the matching fields stay empty). */
  failed: number;
  /** Ids of nodes with at least one media not copied that are marked `'failed'`. */
  failedNodeIds: string[];
}

/**
 * Copy the withheld media assets of a set of just-pasted nodes into `targetProject`, then fill them back into the nodes.
 *
 * Three steps: (1) collect the deduplicated asset URLs from the positions recorded on each node; (2) hand them to the backend in batches to copy, getting an old -> new
 * URL mapping; (3) use `getLiveNodeData` to read the **current** node data (not the snapshot at paste time), writing the new
 * address only to original positions that are "still empty" - if the user put something in that slot during the copy it is not overwritten; nodes already
 * deleted / after switching projects are skipped. Nodes fully filled back have `assetMigration` removed, and ones with failures are marked `'failed'`.
 * The same URL is copied only once.
 */
export async function migratePastedNodeAssets(params: {
  nodes: PastedNodeForMigration[];
  targetProject: string;
  getLiveNodeData: (id: string) => CanvasNodeData | null;
  updateNodeData: (id: string, patch: Partial<CanvasNodeData>) => void;
}): Promise<AssetMigrationSummary> {
  const { nodes, targetProject, getLiveNodeData, updateNodeData } = params;
  const pending = nodes.filter((node) => node.withheld.length > 0);
  if (pending.length === 0) {
    return { migrated: 0, failed: 0, failedNodeIds: [] };
  }
  const nodeIds = pending.map((node) => node.id);
  setInFlight(nodeIds, true);
  try {
    return await runMigration(pending, targetProject, getLiveNodeData, updateNodeData);
  } catch (error) {
    // Unexpected throw (should not happen: single-batch failure is already swallowed in copyAssetsInBatches): mark all nodes still hanging
    // on copying as failed, so the placeholder does not spin forever.
    console.warn('[cross-project-assets] migration crashed, marking nodes failed', error);
    const failedNodeIds: string[] = [];
    const failedUrls = new Set<string>();
    for (const { id, withheld } of pending) {
      for (const { url } of withheld) {
        failedUrls.add(url);
      }
      const liveData = getLiveNodeData(id);
      if (!liveData) {
        continue;
      }
      failedNodeIds.push(id);
      if (readAssetMigrationState(liveData) === 'copying') {
        updateNodeData(id, { [ASSET_MIGRATION_KEY]: 'failed' } as Partial<CanvasNodeData>);
      }
    }
    return { migrated: 0, failed: failedUrls.size, failedNodeIds };
  } finally {
    setInFlight(nodeIds, false);
  }
}

async function runMigration(
  nodes: PastedNodeForMigration[],
  targetProject: string,
  getLiveNodeData: (id: string) => CanvasNodeData | null,
  updateNodeData: (id: string, patch: Partial<CanvasNodeData>) => void,
): Promise<AssetMigrationSummary> {
  // 1. Collect the deduplicated asset URLs (raw string -> normalized path).
  const rawToSource = new Map<string, string>();
  for (const { withheld } of nodes) {
    for (const { url } of withheld) {
      if (rawToSource.has(url)) {
        continue;
      }
      const asset = toCopyableAsset(url);
      if (asset && asset.project !== targetProject) {
        rawToSource.set(url, asset.source);
      }
    }
  }

  // 2. Have the backend copy in batches, building a raw string -> new URL mapping.
  const sources = [...new Set(rawToSource.values())];
  const copied =
    sources.length > 0
      ? await copyAssetsInBatches(targetProject, sources)
      : {
          mapping: new Map<string, string>(),
          failed: new Set<string>(),
          unavailable: new Set<string>(),
        };
  const { mapping } = copied;
  // On the paste path the original URL was long removed by `withholdForeignAssetUrls`, so there is no "keep as is" option:
  // both kinds are treated alike here, the node is marked failed and the user pastes again.
  const failedSources = new Set([...copied.failed, ...copied.unavailable]);
  const urlMap = new Map<string, string>();
  for (const [raw, source] of rawToSource) {
    const newUrl = mapping.get(source);
    if (newUrl) {
      urlMap.set(raw, newUrl);
    }
  }

  // 3. Fill new addresses only into original positions that are still empty in the "current" node data; skip if the node is gone.
  const failedNodeIds: string[] = [];
  for (const { id, withheld } of nodes) {
    const liveData = getLiveNodeData(id);
    if (!liveData) {
      continue;
    }
    let nextData: unknown = liveData;
    let nodeFailed = false;
    for (const { path, url } of withheld) {
      const newUrl = urlMap.get(url);
      if (!newUrl) {
        nodeFailed = true;
        continue;
      }
      if (readAtPath(nextData, path) !== null) {
        // The user filled this slot themselves during the copy (or changed the structure), so do not overwrite.
        continue;
      }
      nextData = writeAtPath(nextData, path, newUrl);
    }
    const previousData = liveData as unknown as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(nextData as Record<string, unknown>)) {
      if (value !== previousData[key]) {
        patch[key] = value;
      }
    }
    const nextState: AssetMigrationState | undefined = nodeFailed ? 'failed' : undefined;
    if (previousData[ASSET_MIGRATION_KEY] !== nextState) {
      patch[ASSET_MIGRATION_KEY] = nextState;
    }
    if (nodeFailed) {
      failedNodeIds.push(id);
    }
    if (Object.keys(patch).length > 0) {
      updateNodeData(id, patch as Partial<CanvasNodeData>);
    }
  }

  return { migrated: mapping.size, failed: failedSources.size, failedNodeIds };
}
