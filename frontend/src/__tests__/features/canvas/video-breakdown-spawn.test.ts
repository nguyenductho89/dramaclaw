// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Clicking "frame-by-frame breakdown" on the video node's toolbar = spawn a breakdown node downstream and connect
// an edge. This pins that edge down: addEdge's edge gate silently drops a non-compliant edge (returns null), and if
// the whitelist is ever missing an entry, the user clicking it would only see an orphaned, material-less empty node
// with no error at all.
import { beforeEach, describe, expect, it } from "vitest";

import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import {
  isManualConnectionAllowed,
  isUpstreamConnectionAllowed,
} from "@/features/canvas/domain/nodeRegistry";
import { useCanvasStore } from "@/stores/canvasStore";

const SOURCE_VIDEO: CanvasNode = {
  id: "v1",
  type: CANVAS_NODE_TYPES.video,
  position: { x: 0, y: 0 },
  data: { videoUrl: "/static/demo.mp4", displayName: "Source clip" },
} as CanvasNode;

describe("video -> frame-by-frame breakdown spawn", () => {
  beforeEach(() => {
    useCanvasStore.setState({ nodes: [SOURCE_VIDEO], edges: [] });
  });

  it("keeps the edge the toolbar draws from the video to the new breakdown node", () => {
    const store = useCanvasStore.getState();
    const position = store.findNodePosition("v1", 300, 292);
    const breakdownId = store.addNode(CANVAS_NODE_TYPES.videoBreakdown, position, {
      sourceNodeId: "v1",
    });

    expect(useCanvasStore.getState().addEdge("v1", breakdownId)).not.toBeNull();

    const { nodes, edges } = useCanvasStore.getState();
    const created = nodes.find((item) => item.id === breakdownId);
    expect(created?.type).toBe(CANVAS_NODE_TYPES.videoBreakdown);
    // The material is identified through this upstream edge; the node itself does not copy a URL - copying one
    // would break "disconnecting the edge reverts to the empty state".
    expect(created?.data.sourceVideoUrl ?? null).toBeNull();
    expect(
      edges.some((edge) => edge.source === "v1" && edge.target === breakdownId),
    ).toBe(true);
  });

  it("spawns downstream of the source instead of on top of it", () => {
    const store = useCanvasStore.getState();
    const position = store.findNodePosition("v1", 300, 292);

    expect(position.x).toBeGreaterThan(SOURCE_VIDEO.position.x);
  });

  it("lets users draw the same edge by hand", () => {
    // The toolbar builds an ordinary edge, not a system-only one: a user drawing the same edge by hand, or
    // reconnecting it after deleting it, must work too.
    expect(
      isUpstreamConnectionAllowed(
        CANVAS_NODE_TYPES.video,
        CANVAS_NODE_TYPES.videoBreakdown,
      ),
    ).toBe(true);
    expect(
      isManualConnectionAllowed(
        CANVAS_NODE_TYPES.video,
        CANVAS_NODE_TYPES.videoBreakdown,
      ),
    ).toBe(true);
  });
});
