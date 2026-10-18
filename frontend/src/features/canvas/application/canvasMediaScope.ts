// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  ASSET_MIGRATION_KEY,
  copyAssetsInBatches,
  toCopyableAsset,
  readAtPath,
  writeAtPath,
} from '@/features/canvas/application/crossProjectAssets';
import type { CanvasNodeData } from '@/features/canvas/domain/canvasNodes';

/**
 * Self-healing after a save is rejected by the backend with `canvas_media_scope_mismatch`.
 *
 * Static resources are authorized independently by the project id in the URL, so one canvas cannot store media addresses of another project: members of the
 * source project see everything normal, but another equally valid member of this project who opens it gets 403 across the board (SuperTale#192). The backend
 * therefore blocks the **newly introduced** out-of-project references at PUT time and returns a `refs` list (node id + field
 * path + original URL).
 *
 * This turns that list into a repair: copy the assets into this project (server-side CopyObject, bytes do not pass through the browser),
 * fill the new addresses back into the nodes by field path, and then the caller retries the save. For ones that cannot be copied (no permission on the source project / deleted /
 * network down), blank the field and mark `assetMigration: 'failed'` - keeping the original URL means saving the 403 again,
 * the backend rejects it again next round, and saving is stuck forever.
 *
 * Cross-project **paste** takes another, earlier route (`crossProjectAssets`: the URL never enters the store at all).
 * This module covers all the other paths that put an out-of-project URL into the canvas - undo/redo of old data, template/projection insertion,
 * and any new approach in future.
 */

export interface ForeignMediaRef {
  node_id: string;
  /** Field path inside the node `data`, e.g. `cells[1].imageUrl`. */
  field: string;
  url: string;
  source_project_id: string;
}

export const CANVAS_MEDIA_SCOPE_CODE = 'canvas_media_scope_mismatch';

function isForeignMediaRef(value: unknown): value is ForeignMediaRef {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const ref = value as Record<string, unknown>;
  return (
    typeof ref.node_id === 'string' &&
    typeof ref.field === 'string' &&
    typeof ref.url === 'string' &&
    ref.url.length > 0 &&
    typeof ref.source_project_id === 'string'
  );
}

/**
 * Extract the out-of-project references reported by the backend from a save error; returns `null` if it is not this error or there is not a single repairable one
 * (so the caller treats it as an ordinary error, rather than spinning a round of copy + retry for an empty list).
 */
export function parseCanvasMediaScopeRefs(
  status: number | null,
  body: unknown,
): ForeignMediaRef[] | null {
  if (status !== 422 || !body || typeof body !== 'object') {
    return null;
  }
  const detail = (body as { detail?: unknown }).detail;
  if (!detail || typeof detail !== 'object') {
    return null;
  }
  const record = detail as Record<string, unknown>;
  if (record.code !== CANVAS_MEDIA_SCOPE_CODE) {
    return null;
  }
  const refs = Array.isArray(record.refs) ? record.refs.filter(isForeignMediaRef) : [];
  return refs.length > 0 ? refs : null;
}

/** `cells[1].imageUrl` -> `['cells', 1, 'imageUrl']`. Returns `null` if it cannot be parsed. */
export function parseFieldPath(field: string): Array<string | number> | null {
  const path: Array<string | number> = [];
  const pattern = /([^.[\]]+)|\[(\d+)\]/g;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(field)) !== null) {
    if (match.index !== consumed && field[match.index - 1] !== '.') {
      return null;
    }
    consumed = match.index + match[0].length;
    path.push(match[2] !== undefined ? Number(match[2]) : match[1]);
  }
  if (consumed !== field.length || path.length === 0) {
    return null;
  }
  return path;
}

export interface ForeignMediaRepairResult {
  /** Original URL -> new URL in this project; before retrying the save the caller also needs it to change the node snapshot it holds. */
  urlMap: Map<string, string>;
  /** Original URLs that were not copied; the matching fields have been blanked. */
  failedUrls: Set<string>;
  /**
   * Not copied this time but may succeed next time (network down / backend 5xx / canvas switched midway). When true **not a single field was touched**:
   * the caller should report the error to the user and wait for them to retry, rather than trading a blip for the user permanently losing images.
   */
  retryable: boolean;
}

/**
 * Copy the out-of-project references reported by the backend into `targetProject` and fill them back into the nodes.
 *
 * Only change fields whose "current value is still exactly the URL the backend rejected": if the user swapped the image between the rejection and the retry,
 * that is their choice, and the copy result does not overwrite it; if the node has been deleted the whole thing is skipped. The same URL is copied only once.
 */
export async function repairForeignMediaRefs(params: {
  refs: ForeignMediaRef[];
  targetProject: string;
  getLiveNodeData: (id: string) => CanvasNodeData | null;
  updateNodeData: (id: string, patch: Partial<CanvasNodeData>) => void;
  /**
   * Whether to blank the field and mark `failed` when it cannot be copied. The save path must blank it (keeping the source project URL means saving
   * the 403 again, the backend rejects it again next round, and saving is stuck forever); a manual repair at read time must not blank it - that
   * data is a historical leftover that the backend already lets through, and if it cannot be repaired the user's last remaining clue should not be deleted in passing.
   */
  blankOnFailure?: boolean;
}): Promise<ForeignMediaRepairResult> {
  const { refs, targetProject, getLiveNodeData, updateNodeData } = params;
  const blankOnFailure = params.blankOnFailure ?? true;
  const scope = foreignMediaScope;
  // The guard scans with browser semantics, but `ref.url` is the raw string in the canvas (it may be a same-origin full URL, or contain `..`).
  // The copy endpoint only recognizes relative canonical paths, and sending the raw string would get invalid_source back, and the self-heal would delete
  // the reference instead. So normalize first into the form the copy endpoint recognizes, and keep "original URL -> normalized source" to map results back.
  const sourceByUrl = new Map<string, string>();
  for (const ref of refs) {
    if (sourceByUrl.has(ref.url)) {
      continue;
    }
    const asset = toCopyableAsset(ref.url);
    // Ones that cannot be normalized (cross-origin, protocol-relative): that is a false block by the guard and was never a resource of this site,
    // so failing to copy it should not touch it either. Skip entirely - when not a single one is changed, the caller takes the "please delete these nodes" path,
    // at least not deleting a user's normal external image.
    if (asset) {
      sourceByUrl.set(ref.url, asset.source);
    }
  }
  const sources = [...new Set(sourceByUrl.values())];
  const { mapping, failed, unavailable } = await copyAssetsInBatches(targetProject, sources);
  // The user switched away from the canvas/project during the copy: these refs no longer describe the image on screen, and changing anything would be wrong.
  if (foreignMediaScope !== scope) {
    return { urlMap: new Map(), failedUrls: new Set(), retryable: true };
  }
  // If even one was just "not copied this time", do nothing overall. Half changed and half kept would make retries not reconcile, and blanking is irreversible.
  if (unavailable.size > 0) {
    return { urlMap: new Map(), failedUrls: new Set(), retryable: true };
  }
  // The backend maps back by the string that was sent; anything in neither the mapping nor failed (should not happen) counts as
  // failed, so a field does not stay in place carrying the source project URL and get rejected again on the next save. Externally the original URL is always the key.
  const failedUrls = new Set<string>();
  for (const [url, source] of sourceByUrl) {
    if (!mapping.has(source) || failed.has(source)) {
      failedUrls.add(url);
    }
  }

  const byNode = new Map<string, ForeignMediaRef[]>();
  for (const ref of refs) {
    const bucket = byNode.get(ref.node_id);
    if (bucket) {
      bucket.push(ref);
    } else {
      byNode.set(ref.node_id, [ref]);
    }
  }

  for (const [nodeId, nodeRefs] of byNode) {
    const liveData = getLiveNodeData(nodeId);
    if (!liveData) {
      continue;
    }
    let nextData: unknown = liveData;
    let nodeFailed = false;
    for (const ref of nodeRefs) {
      const path = parseFieldPath(ref.field);
      if (!path) {
        nodeFailed = true;
        continue;
      }
      if (readAtPath(nextData, path) !== ref.url) {
        continue;
      }
      const source = sourceByUrl.get(ref.url);
      if (source === undefined) {
        // Cannot be normalized: not a resource of this site, leave it alone.
        continue;
      }
      const newUrl = mapping.get(source);
      if (newUrl) {
        nextData = writeAtPath(nextData, path, newUrl);
        continue;
      }
      nodeFailed = true;
      if (blankOnFailure) {
        nextData = writeAtPath(nextData, path, null);
      }
    }
    const previousData = liveData as unknown as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(nextData as Record<string, unknown>)) {
      if (value !== previousData[key]) {
        patch[key] = value;
      }
    }
    if (nodeFailed && blankOnFailure && previousData[ASSET_MIGRATION_KEY] !== 'failed') {
      patch[ASSET_MIGRATION_KEY] = 'failed';
    }
    if (Object.keys(patch).length > 0) {
      updateNodeData(nodeId, patch as Partial<CanvasNodeData>);
    }
  }

  // The caller uses it to change the node snapshot it holds, and the key must be the original URL string in the canvas.
  const urlMap = new Map<string, string>();
  for (const [url, source] of sourceByUrl) {
    const newUrl = mapping.get(source);
    if (newUrl) {
      urlMap.set(url, newUrl);
    }
  }
  return { urlMap, failedUrls, retryable: false };
}

/**
 * Apply the result of a repair to "the node snapshot about to be retried".
 *
 * The repair has been written into the store, but the save flow holds the snapshot from when this PUT was initiated - without changing one in sync, the retry
 * would send out the same rejected URLs and loop forever in place. Anything not copied is blanked + marked failed, for the same reason as above.
 * When no node is changed the input is returned as is, avoiding needless re-rendering downstream.
 */
export function applyForeignMediaRepairToNodes<
  T extends { id: string; data?: unknown },
>(nodes: readonly T[], refs: ForeignMediaRef[], repair: ForeignMediaRepairResult): T[] {
  const byNode = new Map<string, ForeignMediaRef[]>();
  for (const ref of refs) {
    const bucket = byNode.get(ref.node_id);
    if (bucket) {
      bucket.push(ref);
    } else {
      byNode.set(ref.node_id, [ref]);
    }
  }
  let changed = false;
  const next = nodes.map((node) => {
    const nodeRefs = byNode.get(node.id);
    if (!nodeRefs) {
      return node;
    }
    let data: unknown = node.data;
    let nodeChanged = false;
    let nodeFailed = false;
    for (const ref of nodeRefs) {
      const path = parseFieldPath(ref.field);
      if (!path || readAtPath(data, path) !== ref.url) {
        continue;
      }
      const newUrl = repair.urlMap.get(ref.url);
      if (!newUrl && !repair.failedUrls.has(ref.url)) {
        // Neither copied nor counted as failed = the repair never touched it (a non-site address that could not be normalized).
        // Blanking it here would not match the original value kept in the store, and would delete a user's normal external image.
        continue;
      }
      data = writeAtPath(data, path, newUrl ?? null);
      nodeChanged = true;
      if (!newUrl) {
        nodeFailed = true;
      }
    }
    if (nodeFailed) {
      const record = data as Record<string, unknown>;
      if (record?.[ASSET_MIGRATION_KEY] !== 'failed') {
        data = { ...record, [ASSET_MIGRATION_KEY]: 'failed' };
        nodeChanged = true;
      }
    }
    if (!nodeChanged) {
      return node;
    }
    changed = true;
    return { ...node, data };
  });
  return changed ? next : (nodes as T[]);
}

// --- Read-time diagnostics registry ------------------------------------------------
// On GET of a canvas the backend hangs "out-of-project references still being served" in `foreign_media` (historical data saved before the guard
// went live, which the save side lets through, otherwise one dirty node would lock the whole old canvas). Here an index is kept per node,
// the node mask subscribes to it, and replaces a broken image with an explanation plus a one-click repair.
//
// Deliberately **not** written into node data: this is diagnostic information, not canvas content, and should not be persisted, should not enter the undo stack, and should not
// let a purely read operation mark the canvas as "modified".

let foreignMediaProject = '';
// Which canvas the current diagnostics belong to. `repairForeignMediaRefs` reads it once before and once after await: the copy takes several seconds,
// and if the canvas/project changes in between, the refs in hand no longer describe the image on screen.
let foreignMediaScope = '';
const foreignMediaByNode = new Map<string, ForeignMediaRef[]>();
const foreignMediaListeners = new Set<() => void>();
const NO_REFS: ForeignMediaRef[] = [];

function notifyForeignMedia(): void {
  for (const listener of [...foreignMediaListeners]) {
    listener();
  }
}

/** Replace the whole table on canvas switch / re-hydrate: the previous canvas's diagnostics must never carry over to the next. */
export function publishForeignMediaRefs(
  targetProject: string,
  canvasId: string,
  refs: readonly ForeignMediaRef[],
): void {
  foreignMediaProject = targetProject;
  // Re-hydrating the same canvas does not count as a scope change, otherwise one background refresh could interrupt a repair the user is running.
  foreignMediaScope = `${targetProject}:${canvasId}`;
  foreignMediaByNode.clear();
  for (const ref of refs) {
    const bucket = foreignMediaByNode.get(ref.node_id);
    if (bucket) {
      bucket.push(ref);
    } else {
      foreignMediaByNode.set(ref.node_id, [ref]);
    }
  }
  notifyForeignMedia();
}

export function clearForeignMediaRefs(): void {
  foreignMediaProject = '';
  foreignMediaScope = '';
  foreignMediaByNode.clear();
  notifyForeignMedia();
}

/** The snapshot must be a stable reference: clean nodes always return the same empty array, otherwise useSyncExternalStore loops forever. */
export function readForeignMediaRefsForNode(nodeId: string): ForeignMediaRef[] {
  return foreignMediaByNode.get(nodeId) ?? NO_REFS;
}

export function foreignMediaTargetProject(): string {
  return foreignMediaProject;
}

export function subscribeForeignMediaRefs(listener: () => void): () => void {
  foreignMediaListeners.add(listener);
  return () => {
    foreignMediaListeners.delete(listener);
  };
}

/** Once one is repaired remove it from the registry; the rest stay (partial success must also be shown honestly). */
export function resolveForeignMediaRefs(nodeId: string, urls: Iterable<string>): void {
  const bucket = foreignMediaByNode.get(nodeId);
  if (!bucket) {
    return;
  }
  const done = new Set(urls);
  const left = bucket.filter((ref) => !done.has(ref.url));
  if (left.length === bucket.length) {
    return;
  }
  if (left.length === 0) {
    foreignMediaByNode.delete(nodeId);
  } else {
    foreignMediaByNode.set(nodeId, left);
  }
  notifyForeignMedia();
}
