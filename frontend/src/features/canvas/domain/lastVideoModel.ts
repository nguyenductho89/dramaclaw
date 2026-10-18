// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

// Remember the model the user last chose for video nodes, so "new video nodes" inherit that choice rather than falling back to the hard-coded
// DEFAULT_VIDEO_MODEL_ID every time. When the choice is stored only in the node's own data.model, a new node
// has no way of knowing what was chosen last time, so it is additionally mirrored to localStorage. If the id read has become invalid,
// VideoNode's selectedVideoModel logic falls back to the first available model by itself, so no validation is done here.

const STORAGE_KEY = 'canvas.lastVideoModel';

/** Returns the video model id chosen last time; null when there is no record or it is unavailable. */
export function readLastVideoModel(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Record the video model id chosen this time, for later new nodes to inherit. */
export function writeLastVideoModel(modelId: string): void {
  if (typeof window === 'undefined') return;
  if (!modelId) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, modelId);
  } catch {
    // If localStorage cannot be written, so be it; new nodes start from the default value.
  }
}
