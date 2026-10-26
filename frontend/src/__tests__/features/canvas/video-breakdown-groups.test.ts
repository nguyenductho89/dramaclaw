// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from "vitest";

import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import {
  planVideoBreakdownGroups,
  type VideoBreakdownResultLike,
} from "@/features/canvas/application/videoBreakdownGroups";
import { useCanvasStore } from "@/stores/canvasStore";

function shot(index: number, overrides: Record<string, unknown> = {}) {
  return {
    code: `S${String(index).padStart(2, "0")}`,
    shot: index,
    segment: 1,
    duration: 2.5,
    shot_size: "Medium shot",
    lighting: "Natural light",
    camera_movement: "Push in",
    description: `Shot ${index}`,
    image_url: `/static/shot_${index}.jpg`,
    ...overrides,
  };
}

function result(): VideoBreakdownResultLike {
  return {
    storyboard: {
      label: "Storyboard groups",
      groups: [
        { group_index: 1, label: "Storyboard group 01", shots: [shot(1), shot(2)] },
        { group_index: 2, label: "Storyboard group 02", shots: [shot(3), shot(4)] },
      ],
    },
    motion: {
      label: "Motion | camera-movement reference",
      clips: [
        {
          code: "M01",
          duration_sec: 3.2,
          camera_movement: "Pan right",
          description: "Pans from left to right across the street",
          motion_prompt: "camera pans right",
          video_url: "/static/motion_01.mp4",
          preview_image_url: "/static/motion_01.jpg",
        },
      ],
    },
    music: {
      label: "Music | BGM reference clip",
      clip: {
        code: "A01",
        duration_sec: 15,
        description: "A low, moody synth bed",
        mood: "Tense",
        audio_url: "/static/music_01.m4a",
      },
    },
  };
}

describe("planVideoBreakdownGroups", () => {
  it("lays the three dimensions out as a non-overlapping column", () => {
    const plans = planVideoBreakdownGroups(result(), { origin: { x: 100, y: 40 } });

    expect(plans.map((plan) => plan.kind)).toEqual([
      "storyboard",
      "storyboard",
      "motion",
      "music",
    ]);
    expect(plans.map((plan) => plan.label)).toEqual([
      "Storyboard group 01",
      "Storyboard group 02",
      "Motion | camera-movement reference",
      "Music | BGM reference clip",
    ]);

    for (const plan of plans) {
      expect(plan.position.x).toBe(100);
    }
    plans.forEach((plan, index) => {
      if (index === 0) {
        expect(plan.position.y).toBe(40);
        return;
      }
      const previous = plans[index - 1];
      expect(plan.position.y).toBeGreaterThan(
        previous.position.y + previous.height,
      );
    });
  });

  it("lays storyboard cards two per row", () => {
    const four = {
      storyboard: {
        label: "Storyboard groups",
        groups: [
          {
            group_index: 1,
            label: "Storyboard group 01",
            shots: [shot(1), shot(2), shot(3), shot(4)],
          },
        ],
      },
    } satisfies VideoBreakdownResultLike;
    const [plan] = planVideoBreakdownGroups(four, { origin: { x: 0, y: 0 } });

    // 4 shots -> 2x2: each x coordinate appears twice, each y coordinate also appears twice.
    const xs = new Set(plan.children.map((child) => child.position.x));
    const ys = new Set(plan.children.map((child) => child.position.y));
    expect(xs.size).toBe(2);
    expect(ys.size).toBe(2);
    // The first two are on the same row, the third wraps to the next row.
    expect(plan.children[0].position.y).toBe(plan.children[1].position.y);
    expect(plan.children[2].position.y).toBeGreaterThan(
      plan.children[0].position.y,
    );
    expect(plan.children[2].position.x).toBe(plan.children[0].position.x);
  });

  it("keeps every child inside its group box", () => {
    const plans = planVideoBreakdownGroups(result(), { origin: { x: 0, y: 0 } });

    for (const plan of plans) {
      for (const child of plan.children) {
        expect(child.position.x + child.width).toBeLessThanOrEqual(plan.width);
        expect(child.position.y + child.height).toBeLessThanOrEqual(plan.height);
      }
    }
  });

  it("labels shot cards shot-code | shot-size·lighting | description and motion cards duration·camera-movement", () => {
    const plans = planVideoBreakdownGroups(result(), { origin: { x: 0, y: 0 } });

    expect(plans[0].children[0].data.displayName).toBe(
      "S01 | Medium shot·Natural light | Shot 1",
    );
    expect(plans[2].children[0].data.displayName).toBe(
      "M01 | 3.2s·Pan right | Pans from left to right across the street",
    );
    expect(plans[3].children[0].data.displayName).toBe("A01 | 15s·Tense");
  });

  it("marks every produced card replaceable so users can swap in their own file", () => {
    // Missing even one dimension would make users think "this kind of card can't be replaced" - all three must carry it.
    const plans = planVideoBreakdownGroups(result(), { origin: { x: 0, y: 0 } });
    const kinds = new Set(plans.map((plan) => plan.kind));

    expect(kinds).toEqual(new Set(["storyboard", "motion", "music"]));
    for (const plan of plans) {
      for (const child of plan.children) {
        expect(child.data.allowLocalReplace).toBe(true);
      }
    }
  });

  it("skips shots whose frame extraction produced no image", () => {
    const payload = result();
    payload.storyboard = {
      groups: [
        {
          group_index: 1,
          label: "Storyboard group 01",
          shots: [shot(1, { image_url: null }), shot(2)],
        },
      ],
    };

    const plans = planVideoBreakdownGroups(payload, { origin: { x: 0, y: 0 } });
    const storyboard = plans.find((plan) => plan.kind === "storyboard");
    expect(storyboard?.children).toHaveLength(1);
    expect(storyboard?.children[0].data.imageUrl).toBe("/static/shot_2.jpg");
  });

  it("drops dimensions that produced nothing instead of leaving empty groups", () => {
    expect(planVideoBreakdownGroups({}, { origin: { x: 0, y: 0 } })).toEqual([]);
    expect(
      planVideoBreakdownGroups(
        { motion: { clips: [] }, music: { clip: null } },
        { origin: { x: 0, y: 0 } },
      ),
    ).toEqual([]);
  });

  it("falls back to localized labels when the backend sends none", () => {
    const payload = result();
    payload.storyboard = { groups: [{ group_index: 1, shots: [shot(1)] }] };
    payload.motion = { clips: payload.motion?.clips };
    payload.music = { clip: payload.music?.clip };

    const plans = planVideoBreakdownGroups(payload, {
      origin: { x: 0, y: 0 },
      storyboardFallbackLabel: (index) => `Shot group ${index}`,
      motionFallbackLabel: "Motion",
      musicFallbackLabel: "Music",
    });

    expect(plans.map((plan) => plan.label)).toEqual([
      "Shot group 1",
      "Motion",
      "Music",
    ]);
  });
});

describe("canvasStore.addVideoBreakdownGroups", () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: "bd",
          type: CANVAS_NODE_TYPES.videoBreakdown,
          position: { x: 0, y: 0 },
          data: { sourceVideoUrl: "/static/source.mp4" },
        },
      ],
      [],
    );
  });

  it("materializes each dimension as a group node followed by its own children", () => {
    const groupIds = useCanvasStore
      .getState()
      .addVideoBreakdownGroups("bd", result());

    expect(groupIds).toHaveLength(4);

    const nodes = useCanvasStore.getState().nodes;
    for (const groupId of groupIds ?? []) {
      const groupIndex = nodes.findIndex((node) => node.id === groupId);
      expect(groupIndex).toBeGreaterThan(-1);
      expect(nodes[groupIndex].type).toBe(CANVAS_NODE_TYPES.group);

      const children = nodes.filter((node) => node.parentId === groupId);
      expect(children.length).toBeGreaterThan(0);
      for (const child of children) {
        // React Flow requires the parent to come first in the array.
        expect(nodes.findIndex((node) => node.id === child.id)).toBeGreaterThan(
          groupIndex,
        );
      }
    }

    const types = (groupIds ?? []).map(
      (groupId) => nodes.find((node) => node.parentId === groupId)?.type,
    );
    expect(types).toEqual([
      CANVAS_NODE_TYPES.exportImage,
      CANVAS_NODE_TYPES.exportImage,
      CANVAS_NODE_TYPES.video,
      CANVAS_NODE_TYPES.audio,
    ]);
  });

  it("wires every child back to the breakdown node in one undo step", () => {
    const before = useCanvasStore.getState().history.past.length;
    useCanvasStore.getState().addVideoBreakdownGroups("bd", result());

    const { nodes, edges, history } = useCanvasStore.getState();
    const childIds = nodes
      .filter((node) => typeof node.parentId === "string")
      .map((node) => node.id);

    expect(childIds).toHaveLength(6);
    expect(edges).toHaveLength(6);
    for (const edge of edges) {
      expect(edge.source).toBe("bd");
      expect(childIds).toContain(edge.target);
    }
    expect(history.past.length).toBe(before + 1);
  });

  it("keeps the BGM edge alive through load-time normalization", () => {
    useCanvasStore.getState().addVideoBreakdownGroups("bd", result());
    const { nodes, edges } = useCanvasStore.getState();

    // Reload the exact graph: the audio node's upstream whitelist has to accept
    // frame-by-frame breakdown, otherwise the BGM edge is silently dropped on the next open.
    useCanvasStore.getState().setCanvasData(nodes, edges);

    const audioNode = useCanvasStore
      .getState()
      .nodes.find((node) => node.type === CANVAS_NODE_TYPES.audio);
    expect(audioNode).toBeDefined();
    expect(
      useCanvasStore
        .getState()
        .edges.some((edge) => edge.target === audioNode?.id),
    ).toBe(true);
  });

  it("returns null when the source node is gone or nothing was produced", () => {
    expect(
      useCanvasStore.getState().addVideoBreakdownGroups("missing", result()),
    ).toBeNull();
    expect(useCanvasStore.getState().addVideoBreakdownGroups("bd", {})).toBeNull();
  });
});
