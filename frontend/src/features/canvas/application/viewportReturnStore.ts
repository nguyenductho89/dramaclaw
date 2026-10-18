// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * The way back for "jump over for a look, then jump back".
 *
 * Double-clicking a reference material in the prompt bar throws the viewport onto that upstream node - this step is very useful, but after jumping
 * the user often no longer knows where they were, and has no one-click way back to the node they were writing the prompt on. So before jumping
 * the viewport is saved, and a "Back to node" strip floats at the bottom of the canvas.
 *
 * It is its own lightweight store, for the same reason as [[referencePickStore]]: the only subscriber is the strip at the bottom,
 * which should not re-render because of canvas content changes.
 */
import type { Viewport } from '@xyflow/react';
import { create } from 'zustand';

import { useCanvasStore } from '@/stores/canvasStore';

export interface ViewportReturnRequest {
  /** The viewport before jumping away, which "Back to node" restores as is. */
  originViewport: Viewport;
  /** The node being edited when jumping away; on return it is re-selected too, so the panel opens along with it. */
  originNodeId: string;
}

interface ViewportReturnState {
  request: ViewportReturnRequest | null;
  start: (request: ViewportReturnRequest) => void;
  stop: () => void;
}

export const useViewportReturnStore = create<ViewportReturnState>((set) => ({
  request: null,
  start: (request) => set({ request }),
  stop: () => set((state) => (state.request === null ? state : { request: null })),
}));

/**
 * Jump to a referenced upstream node, leaving a way back to `originNodeId`.
 *
 * The focusing itself reuses canvasStore's pendingFocusNodeId (Canvas does the setCenter uniformly there,
 * and the absolute coordinate conversion of group members is also there); here we only remember "where it came from".
 */
export function focusReferenceNode(referenceNodeId: string, originNodeId: string): void {
  const canvas = useCanvasStore.getState();
  // Store a copy: currentViewport is a live object in the store, and storing the reference directly means the next viewport update
  // could change the "original viewport" along with it, and the return would land in the wrong place.
  const { x, y, zoom } = canvas.currentViewport;
  useViewportReturnStore.getState().start({
    originViewport: { x, y, zoom },
    originNodeId,
  });
  canvas.requestFocusNode(referenceNodeId);
}
