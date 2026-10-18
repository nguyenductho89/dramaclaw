// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from "vitest";

import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { resolveAbsolutePosition, useCanvasStore } from "@/stores/canvasStore";

/** Computes a node's absolute position from the current store's nodes (accumulating up the parent chain, which also holds for newly built asset groups). */
function absolutePositionOf(nodeId: string) {
  const nodes = useCanvasStore.getState().nodes;
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`Node does not exist: ${nodeId}`);
  return resolveAbsolutePosition(node, new Map(nodes.map((n) => [n.id, n] as const)));
}

// Consistent with the placement rule of spawnExternalAssets / spawnCharacterLibraryReferences: derived nodes
// are placed in the "source node coordinate system" (baseX = source.position.x - width - gap), first built as root-level nodes,
// then handed to autoGroupSpawn to be adopted. When the source is inside a group, source.position is a group-relative coordinate.
const UPLOAD_WIDTH = 320;
const GAP_X = 40;

const GROUP_ABS = { x: 1000, y: 500 };
const VIDEO_REL = { x: 60, y: 40 };
const ORPHAN_GAP_Y = 260;
const baseX = VIDEO_REL.x - UPLOAD_WIDTH - GAP_X; // -300 (group-relative coordinate system)

/**
 * Builds the initial canvas of "a video node inside a group + two freshly built root-level derived nodes".
 * The derived nodes are deliberately placed with group-relative coordinates (simulating callers placing by source.position),
 * and if autoGroupSpawn did not correct to absolute coordinates they would be treated as absolute and land at the canvas top-left.
 *
 * Note: a protected projection group has its node ids rewritten by setCanvasData (projection_<key>__<id>),
 * so after seeding the real ids must be read back from the store by type; literal ids cannot be reused.
 */
function seedGroupedVideoWithOrphans(groupData: Record<string, unknown>) {
  const group = {
    id: "g1",
    type: CANVAS_NODE_TYPES.group,
    position: { ...GROUP_ABS },
    style: { width: 900, height: 700 },
    data: groupData,
  };
  const video = {
    id: "v1",
    type: CANVAS_NODE_TYPES.video,
    parentId: "g1",
    position: { ...VIDEO_REL },
    style: { width: 480, height: 380 },
    data: {},
  };
  // Two derived upload nodes, placed left of the video (group-relative coordinate system).
  const orphans = [0, 1].map((idx) => ({
    id: `s${idx}`,
    type: CANVAS_NODE_TYPES.upload,
    position: { x: baseX, y: VIDEO_REL.y + idx * ORPHAN_GAP_Y },
    style: { width: UPLOAD_WIDTH, height: 240 },
    data: { user_spawned: true },
  }));
  useCanvasStore.getState().setCanvasData([group, video, ...orphans], []);

  const nodes = useCanvasStore.getState().nodes;
  const videoId = nodes.find((n) => n.type === CANVAS_NODE_TYPES.video)?.id;
  const groupId = nodes.find((n) => n.type === CANVAS_NODE_TYPES.group)?.id;
  // upload nodes have no projection_key and are not rewritten; in array order they are s0, s1.
  const orphanIds = nodes
    .filter((n) => n.type === CANVAS_NODE_TYPES.upload)
    .map((n) => n.id);
  if (!videoId || !groupId || orphanIds.length !== 2) {
    throw new Error("seed failed: could not read back the video/group/derived nodes from the store");
  }
  return { videoId, groupId, orphanIds };
}

describe("canvasStore autoGroupSpawn — coordinate semantics of derived nodes inside a group", () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  it("protected projection group: the source does not join the group, but the derived assets are translated back to absolute coordinates and grouped into a separate root-level asset group", () => {
    // user_spawned not true + has projection_key -> protected projection group.
    const { videoId, groupId, orphanIds } = seedGroupedVideoWithOrphans({
      projection_key: "proj-a",
    });

    const result = useCanvasStore.getState().autoGroupSpawn(videoId, orphanIds, {
      label: "External assets",
    });

    // The source cannot be moved out of the protected group, but the assets (>=2) form a new root-level asset group.
    expect(result).not.toBeNull();
    expect(result).not.toBe(groupId); // not the original protected projection group

    const state = useCanvasStore.getState();
    const assetGroup = state.nodes.find((n) => n.id === result);
    expect(assetGroup?.type).toBe(CANVAS_NODE_TYPES.group);
    // The new asset group is a root-level node (not stuffed into the protected projection group).
    expect(assetGroup?.parentId).toBeUndefined();

    orphanIds.forEach((orphanId, idx) => {
      const node = state.nodes.find((n) => n.id === orphanId);
      expect(node).toBeDefined();
      // The assets are adopted into the new root-level asset group.
      expect(node?.parentId).toBe(result);
      // Key regression: absolute positions land next to the video (the group's absolute offset is compensated), not at the canvas top-left where
      // "a relative value is taken as absolute". Group-relative coordinates change with the new group's origin, so only absolute coordinates are asserted.
      expect(absolutePositionOf(orphanId)).toEqual({
        x: baseX + GROUP_ABS.x, // -300 + 1000 = 700
        y: VIDEO_REL.y + idx * ORPHAN_GAP_Y + GROUP_ABS.y, // 540 / 800
      });
    });
  });

  it("storyboard group: the source likewise does not join, and the derived assets are corrected to absolute coordinates and grouped into a separate root-level asset group", () => {
    const { videoId, groupId, orphanIds } = seedGroupedVideoWithOrphans({
      storyboardGroup: true,
    });

    const result = useCanvasStore.getState().autoGroupSpawn(videoId, orphanIds, {
      label: "External assets",
    });

    expect(result).not.toBeNull();
    expect(result).not.toBe(groupId);
    const first = useCanvasStore.getState().nodes.find((n) => n.id === orphanIds[0]);
    expect(first?.parentId).toBe(result);
    expect(absolutePositionOf(orphanIds[0])).toEqual({
      x: baseX + GROUP_ABS.x,
      y: VIDEO_REL.y + GROUP_ABS.y,
    });
  });

  it("protected projection group + only one derived asset: it cannot form a group (<2 members), so the asset stays an independent root node with corrected coordinates", () => {
    const { videoId, orphanIds } = seedGroupedVideoWithOrphans({
      projection_key: "proj-a",
    });
    const singleOrphan = orphanIds[0];

    const result = useCanvasStore.getState().autoGroupSpawn(videoId, [singleOrphan], {
      label: "External assets",
    });

    // groupNodes requires >=2 members, so a single asset cannot form a group -> returns null and stays an independent root node.
    expect(result).toBeNull();
    const node = useCanvasStore.getState().nodes.find((n) => n.id === singleOrphan);
    expect(node?.parentId).toBeUndefined();
    // But the coordinates are still corrected to absolute, so it will not land at the canvas top-left.
    expect(absolutePositionOf(singleOrphan)).toEqual({
      x: baseX + GROUP_ABS.x,
      y: VIDEO_REL.y + GROUP_ABS.y,
    });
  });

  it("regular group: still adopts the derived nodes as members, without adding the group's absolute offset (keeping group-relative coordinate semantics)", () => {
    // Regular group: user_spawned:true with no projection_key and not a storyboard group.
    const { videoId, groupId, orphanIds } = seedGroupedVideoWithOrphans({
      user_spawned: true,
    });

    const result = useCanvasStore.getState().autoGroupSpawn(videoId, orphanIds, {
      label: "External assets",
    });

    // A regular group adopts normally and returns the group id.
    expect(result).toBe(groupId);
    const first = useCanvasStore.getState().nodes.find((n) => n.id === orphanIds[0]);
    expect(first?.parentId).toBe(groupId);
    // After being adopted into the same parent group the coordinates are already group-relative: they must never get the group's absolute
    // offset the way the protected/storyboard branches do (otherwise they would land near baseX + 1000). fitGroupToChildren may push members inward,
    // so only "still a small relative coordinate" is asserted, not an exact value.
    expect(first?.position.x).toBeLessThan(GROUP_ABS.x);
  });
});
