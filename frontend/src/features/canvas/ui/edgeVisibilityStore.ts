// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { create } from 'zustand';

// Edge visibility: only controls whether the canvas **renders** the edges between nodes. Edge data always stays in
// the canvas store (when hidden, a `hidden` marker is put on the edges handed to ReactFlow, leaving the real edges untouched),
// so hiding is purely visual, and after switching back the edges are still there as they were, with persistence/export unaffected.
// It is its own lightweight store, avoiding mixing with the canvas content store - the button and
// the Canvas derivation logic subscribing to it do not re-render extra because of node/edge content changes.

const STORAGE_KEY = 'canvas.edges.hidden';

function readPersistedHidden(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function persistHidden(value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    // If localStorage cannot be written, so be it; next time start from the default value.
  }
}

interface EdgeVisibilityState {
  hidden: boolean;
  toggle: () => void;
}

export const useEdgeVisibilityStore = create<EdgeVisibilityState>((set, get) => ({
  hidden: readPersistedHidden(),
  toggle: () => {
    const next = !get().hidden;
    persistHidden(next);
    set({ hidden: next });
  },
}));
