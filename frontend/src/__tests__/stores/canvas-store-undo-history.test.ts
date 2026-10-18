// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from "vitest";
import type { NodeChange } from "@xyflow/react";

import { useCanvasStore, type CanvasNode } from "@/stores/canvasStore";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";

describe("canvasStore undo history — one undo removes a node right after creation", () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  it("auto-measure (dimensions change) adds no extra undo step; one undo deletes the new node", () => {
    const nodeId = useCanvasStore
      .getState()
      .addNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 }, {});

    expect(useCanvasStore.getState().nodes).toHaveLength(1);
    // addNode pushes one history step.
    expect(useCanvasStore.getState().history.past).toHaveLength(1);

    // Simulate ReactFlow auto-measuring the new node: one dimensions change (no resizing).
    useCanvasStore.getState().onNodesChange([
      {
        id: nodeId,
        type: "dimensions",
        dimensions: { width: 320, height: 200 },
      } as NodeChange<CanvasNode>,
    ]);

    // Auto-measure must not push history again (otherwise two undos would be needed to delete the node).
    expect(useCanvasStore.getState().history.past).toHaveLength(1);

    // One undo removes the newly created node.
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes).toHaveLength(0);
  });

  it("a user resize ending (dimensions + resizing:false) still pushes one history step", () => {
    const nodeId = useCanvasStore
      .getState()
      .addNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 }, {});
    expect(useCanvasStore.getState().history.past).toHaveLength(1);

    useCanvasStore.getState().onNodesChange([
      {
        id: nodeId,
        type: "dimensions",
        resizing: false,
        dimensions: { width: 400, height: 300 },
      } as NodeChange<CanvasNode>,
    ]);

    // A resize is a real edit and must push an extra history step.
    expect(useCanvasStore.getState().history.past).toHaveLength(2);
  });
});
