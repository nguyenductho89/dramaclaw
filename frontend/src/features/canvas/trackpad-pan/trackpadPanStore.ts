// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { create } from 'zustand';

// Trackpad pan: laptop users have no mouse middle button (the canvas pans by middle-button drag by default); when enabled, a two-finger swipe on the trackpad
// pans the canvas (ReactFlow panOnScroll), and pinch still zooms. The state is its own lightweight
// store, isomorphic with the snap alignment switch, so the button / Canvas subscribing to it does not re-render because of canvas node changes.

const STORAGE_KEY = 'canvas.trackpadPan.enabled';

function readPersistedEnabled(): boolean {
  // On by default: laptop users have no mouse middle button, so a two-finger swipe on the trackpad pans the canvas out of the box.
  // Only when the user explicitly turned it off (persisted as '0') does it stay off, respecting their choice.
  if (typeof window === 'undefined') return true;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === null) return true;
    return stored === '1';
  } catch {
    return true;
  }
}

function persistEnabled(value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    // If localStorage cannot be written, so be it; next time start from the default value.
  }
}

interface TrackpadPanState {
  enabled: boolean;
  toggle: () => void;
}

export const useTrackpadPanStore = create<TrackpadPanState>((set, get) => ({
  enabled: readPersistedEnabled(),
  toggle: () => {
    const next = !get().enabled;
    persistEnabled(next);
    set({ enabled: next });
  },
}));
