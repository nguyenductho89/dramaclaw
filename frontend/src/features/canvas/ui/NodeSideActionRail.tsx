// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { NodeToolbar as ReactFlowNodeToolbar, Position, useStore } from '@xyflow/react';
import { useState, type ReactNode } from 'react';

import { useCanvasStore } from '@/stores/canvasStore';
import { ZoomScaledToolbar } from '@/features/canvas/ui/ZoomScaledToolbar';

interface NodeSideActionRailProps {
  nodeId: string;
  position?: Position.Left | Position.Right;
  children: ReactNode;
  /**
   * Show this button bar only when the node is hovered or selected (default false = always shown, keeping the existing behavior
   * of upload/audio nodes where upload is the primary action). The upload buttons of video/image nodes opt into it,
   * to avoid being conspicuous on the canvas all the time.
   */
  autoHide?: boolean;
  /** Whether the node is selected (used for "also show when selected" under autoHide). */
  selected?: boolean;
}

// NodeToolbar is by default a constant screen size (not changing with zoom), so after tidying and zooming out the nodes become thumbnails
// while this upload/replace button bar stays at its original size, looking particularly abrupt. Use ZoomScaledToolbar to follow the canvas
// zoom: no upper clamp anymore (the earlier clamp at 1 stopped it growing when zoomed in, out of step with the rest of the UI), and when zoomed in it grows together,
// consistent with the top action toolbar; only a min=0.6 lower bound is kept, avoiding imprecise hits when shrunk to minZoom (0.1).

export const NODE_SIDE_ACTION_BUTTON_CLASS =
  'nodrag inline-flex h-8 items-center gap-1.5 rounded-[12px] border border-white/10 bg-[#242426]/95 px-3 text-xs font-medium text-text-dark backdrop-blur-xl transition-colors hover:border-white/18 hover:bg-[#29292b]/95 hover:text-white disabled:cursor-not-allowed disabled:opacity-50';

export const NODE_SIDE_ACTION_ICON_CLASS = 'h-3.5 w-3.5 text-text-muted/90';

export function NodeSideActionRail({
  nodeId,
  position = Position.Right,
  children,
  autoHide = false,
  selected = false,
}: NodeSideActionRailProps) {
  const isLeft = position === Position.Left;
  // The node hover maintained by Canvas (leaving has a 400ms delay, bridging the gap of "moving from the node to the buttons above");
  // railHovered further ensures that the bar is not hidden by that delay being cleared while the mouse rests on the button bar.
  const nodeHovered = useCanvasStore((state) => state.hoveredNodeId === nodeId);
  const [railHovered, setRailHovered] = useState(false);
  const isVisible = !autoHide || selected || nodeHovered || railHovered;
  // Lift this button bar above the same node's spawn "+" (NodeSpawnPlusOverlay). Both are
  // NodeToolbars of the same node, and xyflow gives them the same zIndex (node.internals.z + 1);
  // the "+" is rendered later in the Canvas layer, and on a tie the later DOM order sits on top, so its 80px invisible
  // magnet hit area would cover the "Upload" button and swallow clicks (the magnet would also pull the "+" onto the button). Here the button bar gets
  // +2, ensuring the buttons always receive hover/clicks above the "+" (when the cursor lands on a button the "+" retreats automatically).
  const nodeZ = useStore((state) => state.nodeLookup.get(nodeId)?.internals.z ?? 0);
  return (
    <ReactFlowNodeToolbar
      nodeId={nodeId}
      isVisible={isVisible}
      position={position}
      align="start"
      offset={18}
      className="pointer-events-auto"
      style={{ zIndex: nodeZ + 2 }}
    >
      {/*
        Right rail (upload): lift it just above the node's top-right corner. The
        spawn "+" (NodeSpawnPlusOverlay) lives on the same right edge but
        vertically centered, so a top-aligned rail collides with it on short
        nodes (audio) — worse now that the "+" scales with zoom. Anchoring above
        the top edge keeps it clear of the centered "+" at any zoom/height.

        Left rail (replace material): do NOT lift above the top edge. This rail AND the
        centered top action toolbar both now scale with zoom, so a lifted left
        rail grows up into the toolbar's band and overlaps it at high zoom (the
        toolbar's left end reaches the rail's column). Anchoring at the node's
        top-left corner and growing downward keeps the rail below the toolbar —
        which sits entirely above the node's top edge — at any zoom.
      */}
      <div
        style={isLeft ? undefined : { transform: "translateY(calc(-100% - 2px))" }}
        onMouseEnter={() => setRailHovered(true)}
        onMouseLeave={() => setRailHovered(false)}
      >
        {/* Follows the canvas zoom, with the same logic as the top action toolbar. The anchor hugs the corner next to the node
        (right rail bottom-left lifts upward, left rail top-right goes downward), expanding away from the
        node when scaling and always hugging the node corner. */}
        <ZoomScaledToolbar origin={isLeft ? 'top right' : 'bottom left'} min={0.6}>
          <div className={`flex flex-col gap-2 ${isLeft ? 'items-end' : 'items-start'}`}>
            {children}
          </div>
        </ZoomScaledToolbar>
      </div>
    </ReactFlowNodeToolbar>
  );
}
