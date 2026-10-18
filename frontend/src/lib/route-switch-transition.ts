// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useSyncExternalStore } from "react";

/**
 * Loading gate for page switches from the top bar menu.
 *
 * A page switch here is one **synchronous** re-render: all tanstack router state goes through
 * useSyncExternalStore, and React downgrades updates inside startTransition to a synchronous flush,
 * so from "button pressed" to "new page committed" is one uninterruptible long task - the browser
 * cannot paint a single frame in between. So just mounting an `isLoading` overlay is useless: it appears and disappears
 * in the same commit as the new page, and the user still sees the screen freeze for a moment and then suddenly switch.
 *
 * The approach here is to split the long task on purpose: update only the overlay first, and start the navigation
 * once the browser has really painted it. The cost is waiting two extra frames (about 30ms, imperceptible), in exchange for
 * "click -> loading -> new page" instead of a one-frame hitch. The overlay's fade-in and spinner only animate opacity / transform;
 * during the few hundred milliseconds the navigation blocks the main thread, the compositor keeps playing them,
 * so the loading indicator itself does not freeze.
 * Fast switches do not flash: the overlay fade-in has a 150ms delay (see routes/_app.tsx), and if the page
 * is already switched before that, it stays fully transparent the whole time.
 */
type Phase = "idle" | "armed" | "navigating";

/** Fallback duration when navigation never lands - better to dismiss the overlay early than to blur the UI forever. */
const SAFETY_TIMEOUT_MS = 5000;

let phase: Phase = "idle";
const listeners = new Set<() => void>();
let firstFrame = 0;
let secondFrame = 0;
let safetyTimer = 0;

function setPhase(next: Phase): void {
  if (phase === next) return;
  phase = next;
  for (const listener of listeners) listener();
}

function clearScheduled(): void {
  if (firstFrame) {
    window.cancelAnimationFrame(firstFrame);
    firstFrame = 0;
  }
  if (secondFrame) {
    window.cancelAnimationFrame(secondFrame);
    secondFrame = 0;
  }
  if (safetyTimer) {
    window.clearTimeout(safetyTimer);
    safetyTimer = 0;
  }
}

/**
 * Show loading first, then navigate. Put the actual router navigation call in `navigate`.
 *
 * Only use this for navigations that replace the whole page content (top bar "Freezone / Library", Library sub-page menu). Do not use it for
 * in-place updates such as changing search params; waiting two frames for nothing and flashing the overlay is wasteful.
 */
export function beginRouteSwitch(navigate: () => void): void {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    navigate();
    return;
  }
  clearScheduled();
  setPhase("armed");
  firstFrame = window.requestAnimationFrame(() => {
    firstFrame = 0;
    // The two rAF layers are not a precaution: the first layer's callback runs "before this frame is painted", so the overlay
    // is in the DOM but not on screen yet, and navigating then would be wasted groundwork. Only the second layer guarantees it was painted
    // and the compositor has picked up this layer.
    secondFrame = window.requestAnimationFrame(() => {
      secondFrame = 0;
      setPhase("navigating");
      safetyTimer = window.setTimeout(endRouteSwitch, SAFETY_TIMEOUT_MS);
      navigate();
    });
  });
}

/**
 * The new page has rendered (or navigation failed); remove the overlay.
 *
 * Only handles the navigation that has already departed (`navigating`). `armed` means a newer click is waiting
 * to depart: the caller is the "route landed" event, and at the instant the previous navigation lands the user may well have just
 * clicked a second menu item and still be in those two frames of waiting - cancelling the rAF then would
 * silently swallow the click they just made, leaving them on the previous page with no feedback.
 */
export function endRouteSwitch(): void {
  if (phase !== "navigating") return;
  clearScheduled();
  setPhase("idle");
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Phase {
  return phase;
}

/** Whether the overlay should be shown. */
export function useRouteSwitchPending(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot) !== "idle";
}
