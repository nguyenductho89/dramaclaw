// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useState } from 'react';

/** Canvas view mode: Workflow (React Flow canvas) or Storyboard (AssetBoard three-column projection). */
export type FreezoneViewMode = 'workflow' | 'board';

// Follows the "supertale.freezone." localStorage namespace of lib/url-params.ts.
// The view mode deliberately stays out of the URL (like liblib: asset_board_mode lives in localStorage),
// to avoid touching the tanstack router throttle queue (see the no-raw-window-history convention).
export const FREEZONE_VIEW_MODE_KEY = 'supertale.freezone.viewMode';

export function readStoredViewMode(): FreezoneViewMode {
  try {
    return window.localStorage.getItem(FREEZONE_VIEW_MODE_KEY) === 'board' ? 'board' : 'workflow';
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
    return 'workflow';
  }
}

export function writeStoredViewMode(mode: FreezoneViewMode): void {
  try {
    window.localStorage.setItem(FREEZONE_VIEW_MODE_KEY, mode);
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}

/**
 * Canvas view mode state + localStorage write-through.
 * Single call site convention: currently only FreezoneShell uses it; if a second component needs to read/write this state,
 * upgrade it to a shared store (following the Zustand pattern of edgeVisibilityStore) to avoid copies drifting out of sync.
 */
export function useFreezoneViewMode(): [FreezoneViewMode, (mode: FreezoneViewMode) => void] {
  const [mode, setMode] = useState<FreezoneViewMode>(readStoredViewMode);
  const update = useCallback((next: FreezoneViewMode) => {
    setMode(next);
    writeStoredViewMode(next);
  }, []);
  return [mode, update];
}
