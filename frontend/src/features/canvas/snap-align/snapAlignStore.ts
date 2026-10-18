// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { create } from 'zustand';

// Snap alignment: when a node is dragged, local smart guide lines are shown, indicating the same-edge, center-line or adjacent-edge
// relationship between the current node and the target node.
// The state is its own lightweight store, avoiding mixing with the canvas content store, so that
// subscribing components (buttons, the guide line overlay) do not re-render because of canvas node changes.

const STORAGE_KEY = 'canvas.snapAlign.enabled';
const STORAGE_VERSION_KEY = 'canvas.snapAlign.preferenceVersion';
const STORAGE_VERSION = '2';

function readPersistedEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    // v2 is this usability rework: the old version defaulted to off and might leave a `0`, which would keep the new feature out of
    // the computation chain entirely. On first upgrade turn it on once uniformly; after that the user's explicit choice in v2 is still respected.
    if (window.localStorage.getItem(STORAGE_VERSION_KEY) !== STORAGE_VERSION) {
      window.localStorage.setItem(STORAGE_VERSION_KEY, STORAGE_VERSION);
      window.localStorage.setItem(STORAGE_KEY, '1');
      return true;
    }
    const persisted = window.localStorage.getItem(STORAGE_KEY);
    return persisted === null ? true : persisted === '1';
  } catch {
    return true;
  }
}

function persistEnabled(value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_VERSION_KEY, STORAGE_VERSION);
    window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    // If localStorage cannot be written, so be it; next time start from the default value.
  }
}

export interface SnapAlignGuideSegment {
  /** The fixed axis coordinate in Flow coordinates: x for a vertical line, y for a horizontal line. */
  coordinate: number;
  /** The start and end positions of the segment along the other axis in Flow coordinates. */
  start: number;
  end: number;
  targetNodeId: string;
  relation: 'align' | 'adjacent';
}

export interface SnapAlignGuides {
  /** A local vertical guide line in Flow coordinates. */
  vertical: SnapAlignGuideSegment[];
  /** A local horizontal guide line in Flow coordinates. */
  horizontal: SnapAlignGuideSegment[];
}

const EMPTY_GUIDES: SnapAlignGuides = { vertical: [], horizontal: [] };

interface SnapAlignState {
  enabled: boolean;
  guides: SnapAlignGuides;
  toggle: () => void;
  setGuides: (guides: SnapAlignGuides) => void;
  clearGuides: () => void;
}

export const useSnapAlignStore = create<SnapAlignState>((set, get) => ({
  enabled: readPersistedEnabled(),
  guides: EMPTY_GUIDES,
  toggle: () => {
    const next = !get().enabled;
    persistEnabled(next);
    set({ enabled: next, guides: EMPTY_GUIDES });
  },
  setGuides: (guides) => set({ guides }),
  clearGuides: () => {
    const cur = get().guides;
    if (cur.vertical.length === 0 && cur.horizontal.length === 0) return;
    set({ guides: EMPTY_GUIDES });
  },
}));
