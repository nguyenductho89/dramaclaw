// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useSyncExternalStore } from 'react';

/**
 * The current device pixel ratio; it changes when the window is dragged across screens.
 *
 * Reading window.devicePixelRatio once is not enough: dragging the window from a built-in Retina screen to an external 1x
 * monitor (or the reverse) does not remount any component, and this number is exactly the multiplier for "pixels per cell"
 * - reading it wrong means the whole canvas is either permanently blurry or decodes twice the data forever.
 *
 * There is no event to listen to besides resize; the standard approach is to build a (resolution: Ndppx) media
 * query from the current value: once the value changes the query stops matching, change fires, and a new one is built from the new value.
 */
const listeners = new Set<() => void>();
let watched: MediaQueryList | null = null;

function currentRatio(): number {
  if (typeof window === 'undefined') return 1;
  const value = window.devicePixelRatio;
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function handleChange(): void {
  watch();
  for (const listener of listeners) listener();
}

function watch(): void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  watched?.removeEventListener('change', handleChange);
  watched = window.matchMedia(`(resolution: ${currentRatio()}dppx)`);
  watched.addEventListener('change', handleChange);
}

function unwatch(): void {
  watched?.removeEventListener('change', handleChange);
  watched = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) watch();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) unwatch();
  };
}

export function useDevicePixelRatio(): number {
  // The server snapshot is fixed at 1: there is no screen there, and this value only affects which tier of copy gets picked.
  return useSyncExternalStore(subscribe, currentRatio, () => 1);
}
