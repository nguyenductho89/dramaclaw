// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from "vitest";

import { useCanvasStore } from "@/stores/canvasStore";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { projectionScopedId } from "@/features/freezone/projectionGraphIds";

/**
 * Finishing step fitGroupToChildren after dragging a group member and releasing (libtv style: re-wrap based on the final member positions).
 * Key regression assertion: the group size must update the explicit width/height and style together -- when React Flow renders,
 * the explicit width takes precedence over style.width, so changing only style has no visual effect (the root cause of the frame not moving).
 */
describe("fitGroupToChildren (drop-position refit)", () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  function makePlainGroup(): string {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: "a",
          type: CANVAS_NODE_TYPES.imageEdit,
          position: { x: 100, y: 100 },
          width: 260,
          height: 160,
          style: { width: 260, height: 160 },
          data: { imageUrl: "a.png" },
        },
        {
          id: "b",
          type: CANVAS_NODE_TYPES.imageEdit,
          position: { x: 420, y: 130 },
          width: 240,
          height: 180,
          style: { width: 240, height: 180 },
          data: { imageUrl: "b.png" },
        },
      ],
      [],
    );
    const groupId = useCanvasStore.getState().groupNodes(["a", "b"]);
    expect(groupId).not.toBeNull();
    return groupId as string;
  }

  function group(groupId: string) {
    return useCanvasStore.getState().nodes.find((n) => n.id === groupId)!;
  }

  function groupSize(groupId: string): { width: number; height: number } {
    const g = group(groupId);
    return {
      width: (g.style?.width as number) ?? 0,
      height: (g.style?.height as number) ?? 0,
    };
  }

  function moveMember(id: string, dx: number, dy: number) {
    useCanvasStore.setState({
      nodes: useCanvasStore
        .getState()
        .nodes.map((n) =>
          n.id === id
            ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
            : n,
        ),
    });
  }

  it("members are free to move (no extent clamp on plain-group members)", () => {
    const groupId = makePlainGroup();
    const members = useCanvasStore
      .getState()
      .nodes.filter((n) => n.parentId === groupId);
    expect(members.length).toBe(2);
    expect(members.every((n) => n.extent === undefined)).toBe(true);
  });

  it("re-encloses a member dropped past the bottom/right, syncing width/height with style", () => {
    const groupId = makePlainGroup();
    const before = groupSize(groupId);

    // Simulate a drop far beyond the bottom/right edge, then the drag-stop refit.
    moveMember("b", 800, 600);
    useCanvasStore.getState().fitGroupToChildren(groupId);

    const after = groupSize(groupId);
    expect(after.width).toBeGreaterThan(before.width);
    expect(after.height).toBeGreaterThan(before.height);
    // The enclosed member must sit inside the new box (right/bottom + padding).
    const b = useCanvasStore.getState().nodes.find((n) => n.id === "b")!;
    expect(b.position.x + 240).toBeLessThanOrEqual(after.width);
    expect(b.position.y + 180).toBeLessThanOrEqual(after.height);
    // Regression guard: explicit width/height must follow style, or React Flow
    // keeps rendering the old size (explicit width wins over style.width).
    expect(group(groupId).width).toBe(after.width);
    expect(group(groupId).height).toBe(after.height);
  });

  it("re-encloses a member dropped past the top/left by shifting the origin", () => {
    const groupId = makePlainGroup();
    const originBefore = { ...group(groupId).position };

    moveMember("a", -300, -200);
    useCanvasStore.getState().fitGroupToChildren(groupId);

    // Origin shifts up/left so the runaway member is back inside.
    const originAfter = group(groupId).position;
    expect(originAfter.x).toBeLessThan(originBefore.x);
    expect(originAfter.y).toBeLessThan(originBefore.y);
    const a = useCanvasStore.getState().nodes.find((n) => n.id === "a")!;
    expect(a.position.x).toBeGreaterThanOrEqual(0);
    expect(a.position.y).toBeGreaterThanOrEqual(0);
    const size = groupSize(groupId);
    expect(group(groupId).width).toBe(size.width);
    expect(group(groupId).height).toBe(size.height);
  });

  /**
   * Mainline projection groups must also fit their members: the group frame is computed by the backend from estimated sizes, and the actual rendered member sizes (after images
   * load, after text wraps) are known only to the frontend. Without fitting, members with extent:"parent" would be
   * clamped back into the small frame by React Flow and pile up, and the user cannot rescue them manually -- the group frame is read-only.
   * Only geometry fitting is allowed; topology protection (no ungrouping) is still enforced by ungroupNode.
   */
  it("also re-encloses members of a backend-managed projection group", () => {
    const groupId = "projection_group_asset_character_x";
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: groupId,
          type: CANVAS_NODE_TYPES.group,
          position: { x: 0, y: 0 },
          width: 360,
          height: 240,
          style: { width: 360, height: 240 },
          data: {
            label: "Lin Xiaoman",
            preset_managed: true,
            projection_key: "asset:character:x",
          },
        },
        {
          id: "profile",
          type: CANVAS_NODE_TYPES.textAnnotation,
          position: { x: 20, y: 34 },
          parentId: groupId,
          extent: "parent",
          // The measured render size is far larger than the backend estimate, so the group frame cannot wrap it.
          measured: { width: 440, height: 320 },
          data: {
            content: "profile",
            preset_managed: true,
            projection_key: "asset:character:x",
          },
        },
      ],
      [],
    );

    // setCanvasData rewrites projection node ids to projectionScopedId(...), so the original id cannot be used.
    const scopedGroupId = projectionScopedId("asset:character:x", groupId);
    useCanvasStore.getState().fitGroupToChildren(scopedGroupId);

    const g = useCanvasStore.getState().nodes.find((n) => n.id === scopedGroupId)!;
    const child = useCanvasStore.getState().nodes.find((n) => n.id.endsWith("profile"))!;
    expect(child.position.x + 440).toBeLessThanOrEqual(g.width as number);
    expect(child.position.y + 320).toBeLessThanOrEqual(g.height as number);
    // Same as a normal group: the explicit width/height must stay in sync with style, otherwise React Flow does not repaint.
    expect(g.style?.width).toBe(g.width);
    expect(g.style?.height).toBe(g.height);
  });

  it("never shrinks below a manual enlarge (grow-only)", () => {
    const groupId = makePlainGroup();
    useCanvasStore.setState({
      nodes: useCanvasStore
        .getState()
        .nodes.map((n) =>
          n.id === groupId
            ? {
                ...n,
                width: 2000,
                height: 1500,
                style: { ...(n.style ?? {}), width: 2000, height: 1500 },
              }
            : n,
        ),
    });
    useCanvasStore.getState().fitGroupToChildren(groupId);
    expect(groupSize(groupId)).toEqual({ width: 2000, height: 1500 });
  });
});
