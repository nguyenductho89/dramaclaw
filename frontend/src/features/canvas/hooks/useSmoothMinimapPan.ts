// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, type RefObject } from 'react';
import type { ReactFlowInstance, Viewport } from '@xyflow/react';

/**
 * Takes over minimap drag panning, replacing React Flow's built-in `pannable`.
 *
 * The reason for replacing it is that the built-in implementation has a positive-feedback defect. React Flow computes the minimap range using
 * "node bounding box ∪ current viewport box" (the @xyflow/react MiniMap selector), and the drag gain
 * moveScale is proportional to the size of that union. So once the viewport is dragged out of the content area, the union starts to grow,
 * the gain grows with it, the next frame drags further, and the union grows again - compounding divergence with no upper bound.
 *
 * Measured (335 nodes, bounding box width 35638, zoom 0.1): with a fixed +20px input dragged 8 times in a row,
 * the gain stays steady at 17.8 px/px for the first 3 times, and from the 4th drag past the content edge becomes
 * 18.6 -> 20.5 -> 22.7 -> 25.1 -> 27.7, about +10% each time; continued dragging can fling the viewport to the 1e8 range,
 * and this bad viewport gets persisted and survives a refresh. The hand motion does not change while the canvas drags faster and faster -
 * this is the real source of "the minimap drag does not follow the hand", unrelated to frame rate.
 *
 * Three changes here:
 * 1. The gain is computed only from the absolute bounding box of **visible** nodes, without the viewport box - the gain is constant within one gesture,
 *    no longer diverging, and aligned with the range the built-in MiniMap actually renders (it also draws only visible nodes).
 * 2. The viewport follows the target with rAF easing instead of hard-jumping every frame, smoothing out pointer sampling jitter and abrupt starts/stops.
 * 3. The easing start/convergence/end are all reported to the outer layer: the outer layer skips per-frame viewport commits during easing,
 *    and only collapses the minimap after real convergence (otherwise the cleanup function would cut the easing off midway).
 */

/** Same as the xyflow MiniMap offsetScale default, used to back out the viewBox it renders with. */
const MINIMAP_FALLBACK_WIDTH = 200;
const MINIMAP_FALLBACK_HEIGHT = 150;

/**
 * The fraction moved toward the target each frame, calibrated at 60fps. 0.3 means about 8 frames (130ms) to cover 95%,
 * which feels like following the hand without amplifying pointer jitter 17x as is and flinging it onto the canvas.
 */
const FOLLOW_PER_FRAME = 0.3;
const REFERENCE_FRAME_MS = 1000 / 60;
/** Settle threshold: when this close, snap directly, avoiding exponential approach running rAF forever. */
const SETTLE_EPSILON_PX = 0.4;
/** Maximum compensated duration per frame, preventing one frame from finishing the whole jump after switching back from another tab. */
const MAX_FRAME_MS = 64;

interface SmoothMinimapPanOptions {
  /** Whether the minimap is currently mounted. When false the whole effect wires nothing. */
  enabled: boolean;
  /** The canvas container, used to find the minimap's svg. */
  wrapperRef: RefObject<HTMLDivElement | null>;
  instance: ReactFlowInstance;
  /**
   * Drag start. The caller must use it to pin the minimap so it is not unmounted - the minimap is shown on hover by default,
   * and once the pointer leaves, onMouseLeave unmounts the MiniMap after 180ms,
   * which takes this hook's cleanup function with it, removing the window listeners and suddenly cutting the drag off.
   */
  onPanStart?: () => void;
  /**
   * The drag **fully** ends: the pointer is released **and** the easing has converged (or the hook is unmounted mid-drag).
   * The caller uses it to release the minimap's mount protection - it must wait for convergence, not use a fixed delay: the convergence time
   * depends on the remaining distance at the moment of release (about 260ms with 100px left, about 360ms with 1000px left),
   * both exceeding the auto-hide 180ms, and the minimap would unmount before the easing arrives, with rAF cancelled by the cleanup function.
   *
   * `pointerInsideMinimap` indicates whether the pointer is still inside the minimap at release: during the drag the hover state
   * has mostly been set to false, and the caller decides accordingly whether to keep showing it or collapse.
   */
  onPanEnd?: (pointerInsideMinimap: boolean) => void;
  /**
   * The easing converges to the target (the pointer may still be held still at this moment). The caller uses it to commit the final viewport once.
   *
   * This callback exists because: `instance.setViewport` runs the complete
   * `onMoveStart -> onMove -> onMoveEnd` every time (d3 zoom transform, with no internal marker),
   * while React Flow only coalesces the end event for `panOnScroll` (`panOnScroll ? 150 : 0`).
   * After the user turns off "trackpad pan" there is no coalescing, and every easing frame would commit the viewport once -
   * exactly the store storm this hook wants to eliminate. The caller should skip the `onMoveEnd` commit during easing,
   * and have it committed once here on convergence.
   */
  onViewportSettled?: (viewport: Viewport) => void;
}

export function useSmoothMinimapPan({
  enabled,
  wrapperRef,
  instance,
  onPanStart,
  onPanEnd,
  onViewportSettled,
}: SmoothMinimapPanOptions): void {
  // Callbacks go through refs: changes in their identity should not re-attach listeners (re-attaching would remove the window listeners mid-drag).
  const onPanStartRef = useRef(onPanStart);
  const onPanEndRef = useRef(onPanEnd);
  const onViewportSettledRef = useRef(onViewportSettled);
  onPanStartRef.current = onPanStart;
  onPanEndRef.current = onPanEnd;
  onViewportSettledRef.current = onViewportSettled;

  useEffect(() => {
    if (!enabled) return;
    const minimap = wrapperRef.current?.querySelector<HTMLElement>(
      '.react-flow__minimap',
    );
    const svg = minimap?.querySelector<SVGSVGElement>('svg');
    if (!minimap || !svg) return;
    // After narrowing, make a separate non-null const: endPan below is a function declaration and cannot see the narrowed result in its closure.
    const minimapEl: HTMLElement = minimap;

    let activePointerId: number | null = null;
    let startClientX = 0;
    let startClientY = 0;
    let startViewportX = 0;
    let startViewportY = 0;
    /** Fixed within one gesture, see the file header comment. */
    let moveScale = 1;
    let targetX = 0;
    let targetY = 0;
    let rafId = 0;
    let lastFrameTime = 0;
    /**
     * After the pointer is released and only the easing wrap-up remains, record whether the release point was inside the minimap; the end notification
     * is sent only after convergence (see the comment of onPanEnd). null means there is currently no pending end notification.
     */
    let pendingPanEndInside: boolean | null = null;

    function flushPanEnd() {
      if (pendingPanEndInside === null) return;
      const inside = pendingPanEndInside;
      pendingPanEndInside = null;
      onPanEndRef.current?.(inside);
    }

    const stopLoop = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      lastFrameTime = 0;
    };

    const startLoop = () => {
      if (rafId) return;
      lastFrameTime = 0;
      rafId = requestAnimationFrame(step);
    };

    function step(now: number) {
      const viewport = instance.getViewport();
      const deltaMs = lastFrameTime
        ? Math.min(MAX_FRAME_MS, now - lastFrameTime)
        : REFERENCE_FRAME_MS;
      lastFrameTime = now;

      // Exponential approach compensated by actual frame length: following does not get slower when frames drop.
      const t = 1 - Math.pow(1 - FOLLOW_PER_FRAME, deltaMs / REFERENCE_FRAME_MS);
      let nextX = viewport.x + (targetX - viewport.x) * t;
      let nextY = viewport.y + (targetY - viewport.y) * t;

      const settled =
        Math.abs(targetX - nextX) < SETTLE_EPSILON_PX &&
        Math.abs(targetY - nextY) < SETTLE_EPSILON_PX;
      if (settled) {
        nextX = targetX;
        nextY = targetY;
      }

      // Already on the target, so do not write again: when held still, setViewport every frame would needlessly trigger
      // React Flow's move lifecycle and the canvas viewport store commit.
      if (viewport.x !== nextX || viewport.y !== nextY) {
        instance.setViewport({ x: nextX, y: nextY, zoom: viewport.zoom });
      }

      // Stop on convergence, regardless of whether the pointer is still held. The next pointermove restarts startLoop(),
      // so following the hand is unaffected; when held still it is fully silent.
      if (settled) {
        stopLoop();
        // The final viewport is committed once here - during easing the outer layer skips the per-frame commits of onMoveEnd.
        onViewportSettledRef.current?.({ x: nextX, y: nextY, zoom: viewport.zoom });
        // Only arriving after release counts as the drag really ending, and only then is the outer layer allowed to collapse the minimap.
        flushPanEnd();
        return;
      }
      rafId = requestAnimationFrame(step);
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || activePointerId !== null) return;

      const viewport = instance.getViewport();
      // Must go through getNodesBounds on the instance (it carries nodeLookup); the same-named static
      // utility must not be used: the static version takes `node.position` directly for plain nodes, while a group member's position is
      // **relative to the parent**. A storyboard group turns members into `parentId + hidden: true` with position being
      // in-group cell coordinates (near the origin), while the group itself may be at x=10000 - the static version would stretch the bounding box from the
      // origin all the way to the group's position, and the gain would be far larger than the minimap's visual mapping.
      // Hidden must also be filtered: the built-in MiniMap's bounding box is getInternalNodesBounds(..., {
      // filter: filterHidden }), counting only visible nodes, and we must align with it to follow the hand.
      const visibleNodes = instance.getNodes().filter((node) => !node.hidden);
      const bounds = instance.getNodesBounds(visibleNodes);
      const rect = svg.getBoundingClientRect();
      const elementWidth = rect.width || MINIMAP_FALLBACK_WIDTH;
      const elementHeight = rect.height || MINIMAP_FALLBACK_HEIGHT;

      // Replicates xyflow's viewScale, the only difference being that the viewport box is not merged in (see the file header).
      // For an empty canvas degrade to 1, avoiding division by zero turning the gain into 0 and making it undraggable.
      const viewScale =
        bounds.width > 0 && bounds.height > 0
          ? Math.max(bounds.width / elementWidth, bounds.height / elementHeight)
          : 1;
      // xyflow's original is viewScale * Math.max(zoom, Math.log(zoom)), and ln(z) < z
      // holds for all z > 0, so that Math.max always takes zoom; here it is written directly as zoom.
      moveScale = viewScale * viewport.zoom;

      // The previous gesture's easing may not have wrapped up when it is pressed again: drop the pending end notification,
      // otherwise this convergence would flush it out and the outer layer would collapse mid-drag.
      pendingPanEndInside = null;

      activePointerId = event.pointerId;
      startClientX = event.clientX;
      startClientY = event.clientY;
      startViewportX = viewport.x;
      startViewportY = viewport.y;
      targetX = viewport.x;
      targetY = viewport.y;

      // Listeners are attached to window rather than the svg: during a drag the pointer often leaves the minimap,
      // and attaching to the svg would lose events midway (the built-in implementation's d3-drag is also window-level).
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', endPan);
      window.addEventListener('pointercancel', endPan);

      // Notify the outer layer to pin the minimap: in the default non-pinned mode once the pointer leaves the minimap,
      // onMouseLeave unmounts the MiniMap after 180ms, and this effect's cleanup function
      // would take the three window listeners above with it, cutting the drag off midway.
      onPanStartRef.current?.();

      event.preventDefault();
      event.stopPropagation();
    };

    function handlePointerMove(event: PointerEvent) {
      if (activePointerId !== event.pointerId) return;
      targetX = startViewportX - (event.clientX - startClientX) * moveScale;
      targetY = startViewportY - (event.clientY - startClientY) * moveScale;
      startLoop();
      event.preventDefault();
    }

    function endPan(event: PointerEvent) {
      if (activePointerId !== event.pointerId) return;
      activePointerId = null;
      detachWindowListeners();

      const rect = minimapEl.getBoundingClientRect();
      pendingPanEndInside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;

      // After release let the easing finish on its own, no hard cut; push the end notification until after convergence (see onPanEnd's
      // comment: the convergence time varies with the remaining distance, and a fixed delay would cut the easing off).
      // If already on the target at this moment, the frame scheduled by startLoop immediately judges settled and flushes it out.
      startLoop();
    }

    function detachWindowListeners() {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', endPan);
      window.removeEventListener('pointercancel', endPan);
    }

    svg.addEventListener('pointerdown', handlePointerDown);

    return () => {
      svg.removeEventListener('pointerdown', handlePointerDown);
      detachWindowListeners();
      stopLoop();
      // Fallback: when really unmounted (enabled becomes false / instance changes) the "dragging" state must be returned,
      // otherwise the outer layer would think it is still dragging forever and the minimap could never collapse. The case where the easing is unmounted before wrapping up
      // (pendingPanEndInside still pending) is the same, and is flushed out together.
      if (activePointerId !== null) {
        activePointerId = null;
        pendingPanEndInside = false;
      }
      flushPanEnd();
    };
  }, [enabled, wrapperRef, instance]);
}
