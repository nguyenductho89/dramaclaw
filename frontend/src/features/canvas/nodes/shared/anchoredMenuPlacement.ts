// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Placement computation for popovers (portal + fixed) that pop up against a trigger element.
 *
 * Clamping only horizontally with the vertical position constantly `rect.bottom + gap` is a recurring pitfall: the node operations panel already
 * perpetually hugs the bottom edge of the viewport, and a chip on the prompt bar is only a few dozen pixels from the bottom, so the menu lands entirely outside the viewport,
 * and the user sees "clicked and nothing happened". CameraMovementChip wrote its own up/down flip long ago; here
 * that strategy is extracted so the "+ Reference" menu and the @ replace menu share the same basis.
 *
 * When space is insufficient it does not only flip but also computes the available height: the side against the edge gets whatever it has left, and the popover
 * scrolls internally rather than forcing itself out of the viewport.
 */

/** The popover must show at least this much height, otherwise flipping over merely moves it to another place where it cannot be seen. */
const MIN_VISIBLE_HEIGHT = 96;

export interface AnchoredMenuGeometry {
  top: number;
  left: number;
  /** Actual available height; the popover should set it as maxHeight and allow internal scrolling. */
  maxHeight: number;
  /** Whether it finally lands below or above the trigger element. */
  placement: 'below' | 'above';
}

export interface AnchoredMenuInput {
  /** Position of the trigger element, taken from getBoundingClientRect(). */
  anchorRect: Pick<DOMRect, 'top' | 'bottom' | 'left'>;
  width: number;
  /** Height cap when content fills it. Given as is when space is enough, shrunk otherwise. */
  preferredHeight: number;
  /** Gap between the popover and the trigger element. */
  gap?: number;
  /** Minimum margin between the popover and the viewport edge. */
  edgeGap?: number;
  /** Easy to inject in unit tests; defaults to window. */
  viewportWidth?: number;
  viewportHeight?: number;
}

export function placeAnchoredMenu({
  anchorRect,
  width,
  preferredHeight,
  gap = 4,
  edgeGap = 8,
  viewportWidth,
  viewportHeight,
}: AnchoredMenuInput): AnchoredMenuGeometry {
  const vw = viewportWidth ?? window.innerWidth;
  const vh = viewportHeight ?? window.innerHeight;
  const left = Math.max(edgeGap, Math.min(anchorRect.left, vw - width - edgeGap));

  const roomBelow = Math.max(0, vh - anchorRect.bottom - gap - edgeGap);
  const roomAbove = Math.max(0, anchorRect.top - gap - edgeGap);

  // Put it below if it fits; when it does not, flip only if above is really roomier — when both sides are cramped,
  // flipping back and forth only makes the menu jump up and down, so staying stably below is better.
  if (roomBelow >= preferredHeight || roomBelow >= roomAbove) {
    const maxHeight = Math.max(MIN_VISIBLE_HEIGHT, Math.min(preferredHeight, roomBelow));
    // When neither side is enough (an extremely narrow viewport) we would rather cover the trigger element than let it fall entirely outside the viewport.
    const top = Math.max(edgeGap, Math.min(anchorRect.bottom + gap, vh - edgeGap - maxHeight));
    return { top, left, maxHeight, placement: 'below' };
  }

  const maxHeight = Math.max(MIN_VISIBLE_HEIGHT, Math.min(preferredHeight, roomAbove));
  const top = Math.max(edgeGap, anchorRect.top - gap - maxHeight);
  return { top, left, maxHeight, placement: 'above' };
}
