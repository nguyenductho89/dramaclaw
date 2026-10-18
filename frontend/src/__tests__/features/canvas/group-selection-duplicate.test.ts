// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Box-select a whole group and then click duplicate: the marquee removes the group itself from selected (otherwise dragging would double-shift),
// so only the members are passed to duplicateNodesAsSiblings, and the copy would fall apart and be stuffed back into the original group. This locks down
// the two things "adding the group back" and "pre-order" -- the latter being the precondition for the store to re-point parentId via idMap.
import { describe, expect, it } from "vitest";

import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { collectDuplicableIds } from "@/features/canvas/domain/groupSelectionDuplicate";

function node(id: string, type: CanvasNode["type"], extra: Partial<CanvasNode> = {}): CanvasNode {
  return { id, type, position: { x: 0, y: 0 }, data: {}, ...extra } as CanvasNode;
}

function member(id: string, parentId: string, extra: Partial<CanvasNode> = {}): CanvasNode {
  return node(id, CANVAS_NODE_TYPES.imageGen, { parentId, extent: "parent", ...extra });
}

describe("collectDuplicableIds", () => {
  it("when a whole group is box-selected (only members selected) the group is added back and ordered before the members", () => {
    const nodes = [node("g", CANVAS_NODE_TYPES.group), member("m1", "g"), member("m2", "g")];

    expect(collectDuplicableIds(nodes, ["m1", "m2"])).toEqual(["g", "m1", "m2"]);
  });

  it("the result is unchanged when the group is explicitly selected, and the order is still parent first", () => {
    const nodes = [node("g", CANVAS_NODE_TYPES.group), member("m1", "g")];

    expect(collectDuplicableIds(nodes, ["m1", "g"])).toEqual(["g", "m1"]);
  });

  it("the group is not added back when only some members are selected -- that is \"duplicate these nodes\", not \"duplicate this group\"", () => {
    const nodes = [node("g", CANVAS_NODE_TYPES.group), member("m1", "g"), member("m2", "g")];

    expect(collectDuplicableIds(nodes, ["m1"])).toEqual(["m1"]);
  });

  it("nested groups: the inner is added first and then the outer, and the output is still pre-order", () => {
    const nodes = [
      node("outer", CANVAS_NODE_TYPES.group),
      node("inner", CANVAS_NODE_TYPES.group, { parentId: "outer", extent: "parent" }),
      member("m1", "inner"),
      member("m2", "inner"),
    ];

    // The inner is fully covered by members -> add inner; outer's only child inner is therefore covered too -> add outer.
    expect(collectDuplicableIds(nodes, ["m1", "m2"])).toEqual(["outer", "inner", "m1", "m2"]);
  });

  it("preset/mainline-locked groups are not added on the user's behalf", () => {
    const nodes = [
      node("g", CANVAS_NODE_TYPES.group, { data: { preset_managed: true } }),
      member("m1", "g"),
    ];

    expect(collectDuplicableIds(nodes, ["m1"])).toEqual(["m1"]);
  });

  it("explicitly selected locked members are still kept -- duplication is not destructive and does not reuse the delete-side filtering", () => {
    const nodes = [
      node("a", CANVAS_NODE_TYPES.imageGen, { data: { preset_managed: true } }),
      node("b", CANVAS_NODE_TYPES.imageGen),
    ];

    expect(collectDuplicableIds(nodes, ["a", "b"])).toEqual(["a", "b"]);
  });

  it("returns as-is when there are no groups (in nodes order)", () => {
    const nodes = [node("a", CANVAS_NODE_TYPES.imageGen), node("b", CANVAS_NODE_TYPES.imageGen)];

    expect(collectDuplicableIds(nodes, ["b", "a"])).toEqual(["a", "b"]);
  });
});
