// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from "vitest";

import { useCanvasStore } from "@/stores/canvasStore";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";

/** The three "arrange" modes of the group toolbar. Grid semantics match Hermes and are unaffected by workflow edges. */
describe("arrangeGroupChildren", () => {
  const SIDE_PAD = 20;
  const TOP_PAD = 34;

  beforeEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  function makeGroup(edges: Array<[string, string]> = []): string {
    // Four nodes of equal size, initially laid out 2×2, so it is obvious whether they were rearranged by edges.
    useCanvasStore.getState().setCanvasData(
      [
        { id: "a", position: { x: 0, y: 0 } },
        { id: "b", position: { x: 400, y: 0 } },
        { id: "c", position: { x: 0, y: 300 } },
        { id: "d", position: { x: 400, y: 300 } },
      ].map((n) => ({
        ...n,
        type: CANVAS_NODE_TYPES.imageEdit,
        width: 200,
        height: 150,
        style: { width: 200, height: 150 },
        data: { imageUrl: `${n.id}.png` },
      })),
      edges.map(([source, target]) => ({
        id: `${source}-${target}`,
        source,
        target,
      })),
    );
    const groupId = useCanvasStore.getState().groupNodes(["a", "b", "c", "d"]);
    expect(groupId).not.toBeNull();
    return groupId as string;
  }

  function posOf(id: string): { x: number; y: number } {
    return useCanvasStore.getState().nodes.find((n) => n.id === id)!.position;
  }

  it("grid arrange: four nodes still form a 2×2 even with chained edges", () => {
    const groupId = makeGroup([
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
    ]);
    useCanvasStore.getState().arrangeGroupChildren(groupId, "grid");

    const [a, b, c, d] = ["a", "b", "c", "d"].map(posOf);
    expect(a).toEqual({ x: SIDE_PAD, y: TOP_PAD });
    expect(b).toEqual({ x: SIDE_PAD + 232, y: TOP_PAD });
    expect(c).toEqual({ x: SIDE_PAD, y: TOP_PAD + 182 });
    expect(d).toEqual({ x: SIDE_PAD + 232, y: TOP_PAD + 182 });
  });

  it("grid arrange: result is anchored at the group padding, same origin as horizontal/vertical", () => {
    const groupId = makeGroup([
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
    ]);
    useCanvasStore.getState().arrangeGroupChildren(groupId, "grid");

    const all = ["a", "b", "c", "d"].map(posOf);
    expect(Math.min(...all.map((p) => p.x))).toBe(SIDE_PAD);
    expect(Math.min(...all.map((p) => p.y))).toBe(TOP_PAD);
  });

  it("horizontal arrange: single row starting at the group padding", () => {
    const groupId = makeGroup();
    useCanvasStore.getState().arrangeGroupChildren(groupId, "horizontal");

    const all = ["a", "b", "c", "d"].map(posOf);
    expect(new Set(all.map((p) => p.y)).size).toBe(1);
    expect(all[0]).toEqual({ x: SIDE_PAD, y: TOP_PAD });
    // node width 200 + GAP 32
    expect(all[1].x - all[0].x).toBe(232);
  });

  it("vertical arrange: single column starting at the group padding", () => {
    const groupId = makeGroup();
    useCanvasStore.getState().arrangeGroupChildren(groupId, "vertical");

    const all = ["a", "b", "c", "d"].map(posOf);
    expect(new Set(all.map((p) => p.x)).size).toBe(1);
    expect(all[0]).toEqual({ x: SIDE_PAD, y: TOP_PAD });
    // node height 150 + GAP 32
    expect(all[1].y - all[0].y).toBe(182);
  });

  it("after arranging, the group frame shrinks to just wrap the child nodes", () => {
    const groupId = makeGroup();
    useCanvasStore.getState().arrangeGroupChildren(groupId, "vertical");

    const g = useCanvasStore.getState().nodes.find((n) => n.id === groupId)!;
    // single column: width = padding + 200 + padding; height = top padding + 4*150 + 3*32 + padding
    expect(g.style?.width).toBe(SIDE_PAD * 2 + 200);
    expect(g.style?.height).toBe(TOP_PAD + 150 * 4 + 32 * 3 + SIDE_PAD);
  });

  it("after grid arrange, the group frame fully wraps the 2×2 child nodes", () => {
    const groupId = makeGroup();
    useCanvasStore.getState().arrangeGroupChildren(groupId, "grid");

    const g = useCanvasStore.getState().nodes.find((n) => n.id === groupId)!;
    expect(g.style?.width).toBe(SIDE_PAD + 200 * 2 + 32 + SIDE_PAD);
    expect(g.style?.height).toBe(TOP_PAD + 150 * 2 + 32 + SIDE_PAD);
  });
});
