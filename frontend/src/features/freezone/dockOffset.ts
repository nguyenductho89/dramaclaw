// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CSSProperties } from "react";

/**
 * The "global yield" protocol of the canvas agent drawer.
 *
 * The drawer itself is a full-height fixed overlay (like liblib: when open it spans from the very top of the screen to the very bottom, above
 * the top bar), so it can no longer squeeze others narrower via flex - it can only broadcast, conversely, "how much of the right side I occupy",
 * and the full-width global bars shrink left by themselves:
 * - the top bar (including the top-right settings/notifications/buddy/compute/avatar group, and the Canvas/Market navigation)
 * - the bottom task status bar / the expanded task panel
 *
 * The variable is set on `<html>` rather than via React context: while dragging the drawer width only this one string changes per frame,
 * so the top bar can follow the hand without re-rendering the whole component tree. When the drawer is not open, or not on the free-canvas page, the variable
 * does not exist and the `var(..., 0px)` fallback leaves every host unchanged.
 */
export const FREEZONE_DOCK_WIDTH_VAR = "--freezone-dock-width";

/**
 * Yield animation duration. 300ms when opening/closing the drawer (same easing as the drawer itself); while dragging the width the drawer compresses it to
 * 0ms - otherwise a 300ms easing is scheduled every frame and the top-bar edge trails behind the hand like a rubber band.
 */
export const FREEZONE_DOCK_TRANSITION_VAR = "--freezone-dock-transition";

/** Yield only, do not take over the transition: for hosts that already have their own transition (the task panel's expand animation). */
export const FREEZONE_DOCK_OFFSET_STYLE: CSSProperties = {
  marginRight: `var(${FREEZONE_DOCK_WIDTH_VAR}, 0px)`,
};

/**
 * Yield + the same easing as the drawer. `transitionProperty` additionally includes background-color, because
 * inline styles override the host class's `transition-colors` wholesale (the bottom status bar's hover color change
 * relies on it).
 */
export const FREEZONE_DOCK_OFFSET_ANIMATED_STYLE: CSSProperties = {
  ...FREEZONE_DOCK_OFFSET_STYLE,
  transitionProperty: "margin, background-color",
  transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
  transitionDuration: `var(${FREEZONE_DOCK_TRANSITION_VAR}, 300ms)`,
};

/**
 * The CSS expression for the drawer width: it uses the same clamp as the drawer's own `maxWidth`, ensuring that when "the window is too narrow and
 * squeezes it back" the room the top bar gives up is never wider than the drawer actually is. The clamp is left to CSS, so changing the window size needs
 * no JS involvement.
 */
export function freezoneDockOffsetCss(dockWidth: number, minContentWidth: number): string {
  return `min(${dockWidth}px, calc(100vw - ${minContentWidth}px))`;
}
