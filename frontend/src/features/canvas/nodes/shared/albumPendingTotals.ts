// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useSyncExternalStore } from 'react';

/**
 * Module-level registry of the stacked-card album's "expected count" (nodeId → total of this batch generation).
 *
 * Why not in component state: the canvas enables onlyRenderVisibleElements, and panning a node out of the viewport during batch generation
 * unmounts the component; on return useState resets to zero and the skeleton placeholders vanish. A module-level
 * Map survives unmount/remount; deliberately not persisted — unfinished tasks are not resumed after refresh (each node keeps only
 * the first task handle), and persisting would only leave placeholders that spin forever.
 */
const totals = new Map<string, number>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setAlbumPendingTotal(nodeId: string, total: number): void {
  if (total <= 0) {
    if (!totals.delete(nodeId)) return;
  } else {
    if (totals.get(nodeId) === total) return;
    totals.set(nodeId, total);
  }
  emit();
}

export function useAlbumPendingTotal(nodeId: string): number {
  return useSyncExternalStore(subscribe, () => totals.get(nodeId) ?? 0);
}
