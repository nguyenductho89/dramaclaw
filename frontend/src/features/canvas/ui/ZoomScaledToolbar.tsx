// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CSSProperties, ReactNode } from 'react';

interface ZoomScaledToolbarProps {
  children: ReactNode;
  /**
   * Scale anchor. When the toolbar floats above a node, the anchor takes the edge hugging the node (the bottom edge), and on scaling the
   * toolbar shrinks toward the node without drifting away. align center -> 'bottom center', align start ->
   * 'bottom left'.
   */
  origin?: CSSProperties['transformOrigin'];
  /**
   * Scale lower bound. No lower bound by default (shrinks all the way with zoom, consistent with the top action toolbar). The side
   * button bar (NodeSideActionRail) passes a lower bound, avoiding the buttons being too small to hit accurately when the canvas is zoomed to minZoom (0.1).
   */
  min?: number;
  /**
   * Scale mode:
   * - `follow` (default): scale = zoom, the toolbar scales in the same direction as the canvas (smaller when zoomed out).
   * - `counter`: scale = clamp(counterMin, 1/zoom, counterMax), scaling in reverse - when the canvas
   *   is zoomed in the toolbar gets smaller and when zoomed out it gets larger, with its on-screen size roughly constant and capped, avoiding menus/action areas
   *   shrinking to unreadable at extreme zoom-out, or growing to cover neighboring nodes.
   */
  mode?: 'follow' | 'counter';
  /** Scale lower bound in counter mode (it stops shrinking when the canvas is zoomed in a lot). */
  counterMin?: number;
  /** Scale upper bound in counter mode (it stops growing when the canvas is zoomed out a lot, i.e. "capped"). */
  counterMax?: number;
}

/**
 * Scale the floating toolbar in sync with the canvas zoom ratio.
 *
 * React Flow's `<NodeToolbar>` is by default a fixed screen size that does not change with zoom - when the canvas is zoomed out
 * the node gets smaller but the toolbar does not, looking large and abrupt. Here the current viewport.zoom is read and a `scale(zoom)` layer is wrapped around
 * the toolbar content, so buttons/text zoom in and out along with the canvas.
 *
 * Note that transform does not change the layout box size, so NodeToolbar is still positioned by its original size; together with an edge-hugging
 * transform-origin, the scaled toolbar visually still stays on the corresponding edge of the node.
 *
 * The zoom ratio comes from the root element's `--st-canvas-zoom` CSS variable (maintained by Canvas's single writer),
 * following purely via CSS, no longer subscribing to zoom with useStore - this component does not re-render when zoom changes.
 */
export function ZoomScaledToolbar({
  children,
  origin = 'bottom center',
  min,
  mode = 'follow',
  counterMin = 0.7,
  counterMax = 1.6,
}: ZoomScaledToolbarProps) {
  const scale =
    mode === 'counter'
      ? `clamp(${counterMin}, calc(1 / var(--st-canvas-zoom, 1)), ${counterMax})`
      : min !== undefined
        ? `max(${min}, var(--st-canvas-zoom, 1))`
        : 'var(--st-canvas-zoom, 1)';
  return (
    <div style={{ transform: `scale(${scale})`, transformOrigin: origin }}>
      {children}
    </div>
  );
}
