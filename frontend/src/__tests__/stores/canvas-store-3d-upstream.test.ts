// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from "vitest";

import { useCanvasStore } from "@/stores/canvasStore";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";

function incomingTo(target: string) {
  return useCanvasStore.getState().edges.filter((edge) => edge.target === target);
}

describe("canvasStore.onConnect — 3D world node accepts a single incoming edge", () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  it("rejects connecting a second node into the 3D world node when an upstream exists, keeping the first upstream", () => {
    const store = useCanvasStore.getState();
    const imgA = store.addNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 }, { imageUrl: "a.png" });
    const imgB = store.addNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 200 }, { imageUrl: "b.png" });
    const world = store.addNode(CANVAS_NODE_TYPES.threeDWorld, { x: 400, y: 100 }, {});

    useCanvasStore.getState().onConnect({
      source: imgA,
      target: world,
      sourceHandle: "source",
      targetHandle: "target",
    });
    expect(incomingTo(world)).toHaveLength(1);

    // The second upstream should be rejected.
    useCanvasStore.getState().onConnect({
      source: imgB,
      target: world,
      sourceHandle: "source",
      targetHandle: "target",
    });
    const incoming = incomingTo(world);
    expect(incoming).toHaveLength(1);
    expect(incoming[0]?.source).toBe(imgA);
  });

  it("non-3D-world nodes are not limited to a single upstream (multiple upstreams accepted)", () => {
    const store = useCanvasStore.getState();
    const imgA = store.addNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 }, {});
    const imgB = store.addNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 200 }, {});
    const gen = store.addNode(CANVAS_NODE_TYPES.imageGen, { x: 400, y: 100 }, {});

    useCanvasStore.getState().onConnect({
      source: imgA,
      target: gen,
      sourceHandle: "source",
      targetHandle: "target",
    });
    useCanvasStore.getState().onConnect({
      source: imgB,
      target: gen,
      sourceHandle: "source",
      targetHandle: "target",
    });
    expect(incomingTo(gen)).toHaveLength(2);
  });
});
