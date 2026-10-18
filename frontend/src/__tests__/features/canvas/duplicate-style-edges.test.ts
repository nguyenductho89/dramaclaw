// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// When duplicating an image node, cloning its upstream edges wholesale is right -- except for style nodes. A style node is
// "a projection of the downstream image node's styleTemplateId", and one-to-one is the precondition of all the styleNodeSync rules.
// After cloning "one style node -> two image nodes", the two downstreams each rewrite the same node by their own choice,
// trigger each other's effect, and React hits Maximum update depth exceeded at 50 levels.
import { beforeEach, describe, expect, it } from "vitest";

import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
} from "@/features/canvas/domain/canvasNodes";
import { useCanvasStore } from "@/stores/canvasStore";

function node(
  id: string,
  type: CanvasNode["type"],
  data: Record<string, unknown> = {},
): CanvasNode {
  return { id, type, position: { x: 0, y: 0 }, data } as CanvasNode;
}

function edge(source: string, target: string): CanvasEdge {
  return {
    id: `e-${source}-${target}`,
    source,
    target,
    sourceHandle: "source",
    targetHandle: "target",
    type: "disconnectableEdge",
  } as CanvasEdge;
}

function seed() {
  useCanvasStore.setState({
    nodes: [
      node("style", CANVAS_NODE_TYPES.style, { styleTemplateId: "golden_age" }),
      node("upload", CANVAS_NODE_TYPES.upload, { imageUrl: "https://x/a.png" }),
      node("img", CANVAS_NODE_TYPES.imageGen, { styleTemplateId: "golden_age" }),
    ],
    edges: [edge("style", "img"), edge("upload", "img")],
  });
}

function edgesInto(nodeId: string): string[] {
  return useCanvasStore
    .getState()
    .edges.filter((item) => item.target === nodeId)
    .map((item) => item.source);
}

describe("style edges when duplicating an image node", () => {
  beforeEach(() => {
    useCanvasStore.setState({ nodes: [], edges: [] });
  });

  it("duplicateNodesAsSiblings does not clone the style node's edge along", () => {
    seed();

    const [cloneId] = useCanvasStore.getState().duplicateNodesAsSiblings(["img"]);

    expect(cloneId).toBeTruthy();
    // Ordinary upstreams come along as before; only the style edge is dropped.
    expect(edgesInto(cloneId)).toEqual(["upload"]);
    // Not a single edge of the original node may be lost.
    expect(edgesInto("img").sort()).toEqual(["style", "upload"]);
  });

  it("when the style node is duplicated along, the copy connects to the new style node", () => {
    seed();

    const created = useCanvasStore
      .getState()
      .duplicateNodesAsSiblings(["style", "img"]);
    const [styleCloneId, imgCloneId] = created;

    expect(edgesInto(imgCloneId).sort()).toEqual(
      [styleCloneId, "upload"].sort(),
    );
    // It points to the newly cloned style node, not the original (otherwise it becomes one-to-two again).
    expect(edgesInto(imgCloneId)).not.toContain("style");
  });

  it("duplicateNodeAsSibling follows the same rules", () => {
    seed();

    const cloneId = useCanvasStore.getState().duplicateNodeAsSibling("img", 1);

    expect(cloneId).toBeTruthy();
    expect(edgesInto(cloneId!)).toEqual(["upload"]);
  });
});
