// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { create } from 'zustand';

/**
 * "Pick from canvas" picking mode.
 *
 * When a node (currently only the frame-by-frame breakdown node) needs to reference existing material on the canvas,
 * it enters picking mode: a banner hangs from the top of the canvas, candidate nodes float a "select xxx" overlay, and
 * clicking one backfills it.
 *
 * Deliberately kept independent of `canvasStore`: this is purely transient UI state that should not be mixed into
 * canvas data that gets persisted / pushed onto the history stack (writing it into canvasStore would dirty the canvas
 * every time picking mode is entered or exited).
 */

/** Material kinds picking mode accepts. Only video for now, kept as a union type for easy future extension. */
export type CanvasPickKind = 'video';

export interface CanvasPickRequest {
  /** The id of the node that started the pick - the "back to node" button focuses it, and the picked result backfills it. */
  requesterNodeId: string;
  kind: CanvasPickKind;
}

interface CanvasPickState {
  request: CanvasPickRequest | null;
  startPick: (request: CanvasPickRequest) => void;
  cancelPick: () => void;
  /** Only cancel a pick belonging to this node (clears the field when the node is deleted, avoiding collateral damage to someone else's pick). */
  cancelPickFor: (requesterNodeId: string) => void;
}

export const useCanvasPickStore = create<CanvasPickState>((set, get) => ({
  request: null,
  startPick: (request) => set({ request }),
  cancelPick: () => set({ request: null }),
  cancelPickFor: (requesterNodeId) => {
    if (get().request?.requesterNodeId === requesterNodeId) {
      set({ request: null });
    }
  },
}));

/** Whether material is currently being picked "for this kind" (used by nodes when rendering their overlay). */
export function useIsPickingKind(kind: CanvasPickKind): boolean {
  return useCanvasPickStore((state) => state.request?.kind === kind);
}
