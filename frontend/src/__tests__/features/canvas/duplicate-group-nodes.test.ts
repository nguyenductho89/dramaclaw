// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Duplicating a group = cloning the group frame + all members together. Three pitfalls were hit here historically: members stuffed back into the original group,
// each member offset downward once on its own (the group falls apart instantly), and the group frame size lost (createNode carries no width/height).
import { beforeEach, describe, expect, it } from "vitest";

import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { collectDuplicableIds } from "@/features/canvas/domain/groupSelectionDuplicate";
import { useCanvasStore } from "@/stores/canvasStore";

function node(
  id: string,
  type: CanvasNode["type"],
  position: { x: number; y: number },
  data: Record<string, unknown> = {},
  extra: Partial<CanvasNode> = {},
): CanvasNode {
  return { id, type, position, data, ...extra } as CanvasNode;
}

describe("duplicateNodesAsSiblings", () => {
  beforeEach(() => {
    useCanvasStore.setState({ nodes: [], edges: [] });
  });

  it("keeps a duplicated group intact", () => {
    const group = node(
      "g",
      CANVAS_NODE_TYPES.group,
      { x: 0, y: 0 },
      { label: "Su Luan" },
      { width: 640, height: 480, style: { zIndex: -1 } },
    );
    const member = node(
      "m",
      CANVAS_NODE_TYPES.imageGen,
      { x: 40, y: 60 },
      { displayName: "Portrait" },
      { parentId: "g", extent: "parent" },
    );
    useCanvasStore.setState({ nodes: [group, member], edges: [] });

    const [groupCloneId, memberCloneId] = useCanvasStore
      .getState()
      .duplicateNodesAsSiblings(["g", "m"]);

    const nodes = useCanvasStore.getState().nodes;
    const groupClone = nodes.find((candidate) => candidate.id === groupCloneId);
    const memberClone = nodes.find((candidate) => candidate.id === memberCloneId);

    expect(groupClone).toBeDefined();
    expect(memberClone).toBeDefined();
    // Members attach to the new group, not the original group
    expect(memberClone?.parentId).toBe(groupCloneId);
    // Member coordinates are relative to the parent group and simply follow the group; they must not each shift down again
    expect(memberClone?.position).toEqual({ x: 40, y: 60 });
    // Only the group frame itself needs to step aside by one slot
    expect(groupClone?.position).toEqual({ x: 0, y: 480 + 24 });
    // Size/style are node-level fields that createNode cannot carry over, so they must be moved by hand
    expect(groupClone?.width).toBe(640);
    expect(groupClone?.height).toBe(480);
    // Only the directly duplicated object gets the "Copy" suffix, and in-group members keep their original names
    expect((groupClone?.data as { label?: string }).label).toBe("Su Luan - Copy");
    expect((memberClone?.data as { displayName?: string }).displayName).toBe("Portrait");
  });

  // Box-selecting a whole group goes this way: the marquee drops the ancestor group, and the toolbar's selected contains only members.
  // Passing it straight to the store would reproduce "the copy falls apart + gets stuffed back into the original group"; after adding the group back it must be equivalent to explicitly selecting the group.
  it("keeps the group intact when only its members are selected (marquee path)", () => {
    const group = node(
      "g",
      CANVAS_NODE_TYPES.group,
      { x: 0, y: 0 },
      { label: "Su Luan" },
      { width: 640, height: 480, style: { zIndex: -1 } },
    );
    const member = node(
      "m",
      CANVAS_NODE_TYPES.imageGen,
      { x: 40, y: 60 },
      { displayName: "Portrait" },
      { parentId: "g", extent: "parent" },
    );
    const nodes = [group, member];
    useCanvasStore.setState({ nodes, edges: [] });

    const [groupCloneId, memberCloneId] = useCanvasStore
      .getState()
      .duplicateNodesAsSiblings(collectDuplicableIds(nodes, ["m"]));

    const after = useCanvasStore.getState().nodes;
    const groupClone = after.find((candidate) => candidate.id === groupCloneId);
    const memberClone = after.find((candidate) => candidate.id === memberCloneId);

    expect(memberClone?.parentId).toBe(groupCloneId);
    expect(memberClone?.position).toEqual({ x: 40, y: 60 });
    expect(groupClone?.position).toEqual({ x: 0, y: 480 + 24 });
    expect(groupClone?.width).toBe(640);
    // Members get no suffix; only the group frame itself counts as "the directly duplicated object"
    expect((groupClone?.data as { label?: string }).label).toBe("Su Luan - Copy");
    expect((memberClone?.data as { displayName?: string }).displayName).toBe("Portrait");
  });

  it("still offsets a standalone node below the original", () => {
    useCanvasStore.setState({
      nodes: [
        node("solo", CANVAS_NODE_TYPES.imageGen, { x: 10, y: 20 }, { displayName: "Cover" }, {
          measured: { width: 320, height: 200 },
        }),
      ],
      edges: [],
    });

    const [cloneId] = useCanvasStore.getState().duplicateNodesAsSiblings(["solo"]);
    const clone = useCanvasStore.getState().nodes.find((candidate) => candidate.id === cloneId);

    expect(clone?.position).toEqual({ x: 10, y: 20 + 200 + 24 });
    expect(clone?.parentId).toBeUndefined();
    expect((clone?.data as { displayName?: string }).displayName).toBe("Cover - Copy");
  });
});

describe("createdAt on duplication", () => {
  beforeEach(() => {
    useCanvasStore.setState({ nodes: [], edges: [] });
  });

  // In the factory createdAt is placed after ...data for exactly this reason: duplicateNodeAsSibling spreads
  // the source node's whole data in, and if it came first the duplicate would inherit the source node's creation time,
  // while the sidebar outline relies on exactly that time to tell apart same-named rows from "one prompt duplicated three times".
  it("gives each clone its own creation moment instead of inheriting the source's", () => {
    const createdAt = new Date(2020, 0, 1).getTime();
    useCanvasStore.setState({
      nodes: [node("src", CANVAS_NODE_TYPES.video, { x: 0, y: 0 }, { displayName: "Dusk by the sea", createdAt })],
      edges: [],
    });

    const cloneId = useCanvasStore.getState().duplicateNodeAsSibling("src", 1);
    const clone = useCanvasStore.getState().nodes.find((n) => n.id === cloneId);

    expect(clone).toBeDefined();
    expect((clone!.data as { displayName?: string }).displayName).toBe("Dusk by the sea");
    expect((clone!.data as { createdAt?: number }).createdAt).not.toBe(createdAt);
    expect((clone!.data as { createdAt?: number }).createdAt).toBeGreaterThan(createdAt);
  });
});
