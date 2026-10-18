// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useState } from 'react';

/** Width shares of the three columns (text / image / video), always normalized to sum to 1. */
export type ColumnFractions = readonly [number, number, number];

// Reuse the "supertale.freezone." localStorage namespace of lib/url-params.ts and useFreezoneViewMode. The column width ratios are deliberately not in the URL
// (matches liblib: asset_board_bottom_layout_v1 is stored in localStorage), to avoid touching the
// tanstack route throttle queue (see the no-raw-window-history convention).
export const ASSET_BOARD_COLUMN_FRACTIONS_KEY = 'supertale.freezone.assetBoardColumnFractions';

/** Fallback for missing / dirty values: three equal-width columns. */
export const DEFAULT_COLUMN_FRACTIONS: ColumnFractions = [1 / 3, 1 / 3, 1 / 3];

/**
 * Read the persisted shares. Any exception (no window / not JSON / invalid structure or values) falls back to equal widths.
 * A valid value must be an array of length 3 with every item a positive finite number; after reading it is re-normalized, tolerating
 * non-normalized values written historically.
 */
export function readStoredFractions(): ColumnFractions {
  try {
    const raw = window.localStorage.getItem(ASSET_BOARD_COLUMN_FRACTIONS_KEY);
    if (!raw) return DEFAULT_COLUMN_FRACTIONS;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 3) return DEFAULT_COLUMN_FRACTIONS;
    const nums = parsed.map((n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : NaN));
    if (nums.some((n) => Number.isNaN(n))) return DEFAULT_COLUMN_FRACTIONS;
    const sum = nums[0] + nums[1] + nums[2];
    if (!Number.isFinite(sum) || sum <= 0) return DEFAULT_COLUMN_FRACTIONS;
    return [nums[0] / sum, nums[1] / sum, nums[2] / sum];
  } catch {
    // localStorage can be unavailable in restricted browser contexts / SSR.
    return DEFAULT_COLUMN_FRACTIONS;
  }
}

export function writeStoredFractions(fractions: ColumnFractions): void {
  try {
    window.localStorage.setItem(
      ASSET_BOARD_COLUMN_FRACTIONS_KEY,
      JSON.stringify([fractions[0], fractions[1], fractions[2]]),
    );
  } catch {
    // localStorage can be unavailable in restricted browser contexts / SSR.
  }
}

/**
 * Pure function: convert one divider drag (pixel displacement) into the new three-column shares.
 * @param start        the shares at drag start (sum to 1).
 * @param handleIndex  divider index: 0 = between text/image; 1 = between image/video.
 * @param deltaPx      the pointer's horizontal displacement from the starting point (px), positive to the right.
 * @param width        total container width (px), from getBoundingClientRect.
 * @param minPx        minimum width of a single column (px), so it does not collapse when dragged to the end.
 *
 * Only transfer share between the two adjacent columns (the other column does not move, so the sum is always 1). Neither column may go below minFrac;
 * if the container is so narrow that there is no usable space (upper < lower), degrade to pinning column i at the minimum width.
 */
export function applyColumnResize(
  start: ColumnFractions,
  handleIndex: 0 | 1,
  deltaPx: number,
  width: number,
  minPx: number,
): ColumnFractions {
  const i = handleIndex;
  const j = handleIndex + 1;
  const minFrac = width > 0 ? minPx / width : 0;
  const rawDelta = width > 0 ? deltaPx / width : 0;
  // new_i = start[i] + d >= minFrac  -> d >= minFrac - start[i] (lower)
  // new_j = start[j] - d >= minFrac  -> d <= start[j] - minFrac (upper)
  const lower = minFrac - start[i];
  const upper = start[j] - minFrac;
  const delta = Math.min(Math.max(rawDelta, lower), Math.max(upper, lower));
  const result: [number, number, number] = [start[0], start[1], start[2]];
  // In the degraded branch of an extremely narrow container (width < ~3 x minPx) upper < lower, and the clamped delta may make an adjacent column
  // compute a negative fraction; although backed up by CSS minWidth + read validation, clamping non-negative once more at the exit is cleaner.
  result[i] = Math.max(0, start[i] + delta);
  result[j] = Math.max(0, start[j] - delta);
  return result;
}

/**
 * Three-column share state + localStorage write-through.
 * - setFractions: live updates during dragging (only changes state, not persisted).
 * - commitFractions: persist on release (changes state and writes localStorage).
 *
 * Single call site convention: currently used only by AssetBoardColumns; the component mounts/unmounts when entering/leaving detail state,
 * and restores from localStorage by remounting, so no cross-instance sync is needed. If a second place needs to read/write, upgrade it to a
 * shared store (see the same note on useFreezoneViewMode).
 */
export function useAssetBoardColumnFractions(): {
  fractions: ColumnFractions;
  setFractions: (next: ColumnFractions) => void;
  commitFractions: (next: ColumnFractions) => void;
} {
  const [fractions, setFractionsState] = useState<ColumnFractions>(readStoredFractions);
  const setFractions = useCallback((next: ColumnFractions) => setFractionsState(next), []);
  const commitFractions = useCallback((next: ColumnFractions) => {
    setFractionsState(next);
    writeStoredFractions(next);
  }, []);
  return { fractions, setFractions, commitFractions };
}
