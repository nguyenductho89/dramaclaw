// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useSyncExternalStore } from "react";

/**
 * Module-level registry of in-flight "frame crop" operations. It is not kept in
 * component state because:
 * 1. When a node is panned out of the viewport by onlyRenderVisibleElements, or
 *    swapped for an LOD shell, it unmounts and remounts and useState resets to
 *    zero. If the crop request has not returned yet, the user could submit again
 *    on the remounted node and get two crops.
 * 2. The toolbar (NodeActionToolbar) must ask "is this node cropping?" before
 *    writing isCropMode when switching modes. It does not share state with the
 *    node component, so it can only read the module-level registry.
 *
 * Each in-flight node is bound to an AbortController so the user can cancel
 * midway: cancelVideoCrop only sends the abort signal and does not remove the
 * entry. The entry is removed by clearVideoCropInFlight in the submit flow's
 * finally, so during the window "aborted but finally not reached yet",
 * isVideoCropInFlight still returns true and the user is not led to believe they
 * can submit again immediately.
 */
const inFlight = new Map<string, AbortController>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Returns null when registration fails (this node is already cropping), rather
 * than quietly handing back the existing signal. If a caller treated that as
 * "registered", two consumers would register for the same crop, whichever
 * finally runs first would clear the entry, and the other still-running request
 * would finish against an already-cleared registry. A caller that sees null must
 * abandon this submission.
 */
export function markVideoCropInFlight(nodeId: string): AbortSignal | null {
  if (inFlight.has(nodeId)) return null;
  const controller = new AbortController();
  inFlight.set(nodeId, controller);
  emit();
  return controller.signal;
}

export function cancelVideoCrop(nodeId: string): void {
  inFlight.get(nodeId)?.abort();
}

export function clearVideoCropInFlight(nodeId: string): void {
  if (!inFlight.delete(nodeId)) return;
  emit();
}

export function isVideoCropInFlight(nodeId: string): boolean {
  return inFlight.has(nodeId);
}

export function useVideoCropInFlight(nodeId: string): boolean {
  return useSyncExternalStore(subscribe, () => inFlight.has(nodeId));
}

/**
 * Registry for "one-shot focus grab": registered only when the toolbar actively
 * enters crop mode. The overlay grabs focus once if it sees it was registered,
 * then immediately unregisters. We do not grab on every mount because:
 * 1. When a Radix dropdown menu closes it returns focus to the button that
 *    triggered it, and a single grab at overlay mount time would still lose that
 *    race; the dropdown has to yield via onCloseAutoFocus and this side has to
 *    actually win the focus.
 * 2. The overlay remounts whenever a node is unmounted and remounted by
 *    onlyRenderVisibleElements. If every mount grabbed focus, a user typing in
 *    another input would have their cursor silently stolen by the remount.
 */
const pendingFocus = new Set<string>();

export function requestVideoCropFocus(nodeId: string): void {
  pendingFocus.add(nodeId);
}

/** Consume the one-shot registration; on a hit it is removed and true is returned, which the overlay uses to decide whether to grab focus. */
export function consumeVideoCropFocus(nodeId: string): boolean {
  return pendingFocus.delete(nodeId);
}
