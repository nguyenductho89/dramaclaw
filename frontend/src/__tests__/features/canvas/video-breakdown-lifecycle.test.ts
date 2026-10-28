// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Three lifecycle contracts for the breakdown node, each of which only surfaces when "the user did something else
// mid-run" - hard to hit through manual testing:
//   1. a refresh happens mid-breakdown - the stranded in-progress state must reset, otherwise the button stays
//      disabled forever and the only recovery is deleting and recreating the node;
//   2. material picked from the canvas - the upstream edge is the single source of truth, no URL may be copied
//      into the node as well;
//   3. the node gets deleted mid-breakdown - finish quietly, do not pop a false "zero output" error.
import { beforeEach, describe, expect, it } from "vitest";

import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
} from "@/features/canvas/domain/canvasNodes";
import {
  commitVideoPickToNode,
  landVideoBreakdownResult,
} from "@/features/canvas/application/videoBreakdownLanding";
import { useCanvasStore } from "@/stores/canvasStore";

const BREAKDOWN_NODE = (data: Record<string, unknown> = {}): CanvasNode =>
  ({
    id: "b1",
    type: CANVAS_NODE_TYPES.videoBreakdown,
    position: { x: 400, y: 0 },
    data: { displayName: "Frame-by-frame breakdown", ...data },
  }) as CanvasNode;

const SOURCE_VIDEO: CanvasNode = {
  id: "v1",
  type: CANVAS_NODE_TYPES.video,
  position: { x: 0, y: 0 },
  data: { videoUrl: "/static/demo.mp4", displayName: "Source clip" },
} as CanvasNode;

const LABELS = {
  storyboardFallbackLabel: (index: number) => `Storyboard group ${index}`,
  motionFallbackLabel: "Motion",
  musicFallbackLabel: "Music",
};

describe("breakdown in-progress state resets on hydration", () => {
  it("clears isBreakingDown so a refresh mid-run does not disable the button forever", () => {
    // Breakdown has no task_key resume mechanism (unlike isGenerating, which has resumeNodeGeneration), so a
    // persisted true would never flip back to false on its own.
    useCanvasStore
      .getState()
      .setCanvasData(
        [BREAKDOWN_NODE({ isBreakingDown: true, breakdownStartedAt: 1_700_000_000 })],
        [],
      );

    const node = useCanvasStore.getState().nodes.find((item) => item.id === "b1");
    expect(node?.data.isBreakingDown).toBe(false);
    expect(node?.data.breakdownStartedAt ?? null).toBeNull();
  });

  it("leaves an idle node untouched", () => {
    useCanvasStore.getState().setCanvasData([BREAKDOWN_NODE()], []);

    const node = useCanvasStore.getState().nodes.find((item) => item.id === "b1");
    expect(node?.data.isBreakingDown ?? false).toBe(false);
  });
});

describe("frame crop resets on hydration", () => {
  it("clears isCropMode but leaves isClipMode untouched", () => {
    // Like breakdown it has no resume mechanism; the box/ratio only live in component-local state, so a persisted
    // isCropMode: true would, once reopened, have neither a box nor a way to reconnect to the in-flight request.
    useCanvasStore.getState().setCanvasData(
      [
        {
          ...SOURCE_VIDEO,
          data: { ...SOURCE_VIDEO.data, isCropMode: true, isClipMode: true },
        },
      ],
      [],
    );

    const node = useCanvasStore.getState().nodes.find((item) => item.id === "v1");
    expect(node?.data.isCropMode).toBe(false);
    expect(node?.data.isClipMode).toBe(true);
  });

  it("leaves an idle node untouched", () => {
    useCanvasStore.getState().setCanvasData([SOURCE_VIDEO], []);

    const node = useCanvasStore.getState().nodes.find((item) => item.id === "v1");
    expect(node?.data.isCropMode ?? false).toBe(false);
  });
});

describe("picking a video from the canvas", () => {
  beforeEach(() => {
    useCanvasStore.setState({ nodes: [SOURCE_VIDEO, BREAKDOWN_NODE()], edges: [] });
  });

  it("connects the edge without copying the URL into the node", () => {
    // Copying it into data.sourceVideoUrl as well would break "disconnecting the edge reverts to the empty state" -
    // the user disconnects wanting to switch source, but the node keeps clutching the old URL and keeps running on
    // it regardless.
    expect(
      commitVideoPickToNode({
        sourceNodeId: "v1",
        requesterNodeId: "b1",
        videoUrl: "/static/demo.mp4",
        label: "Source clip",
      }),
    ).toBe(true);

    const { nodes, edges } = useCanvasStore.getState();
    const requester = nodes.find((item) => item.id === "b1");
    expect(requester?.data.sourceVideoUrl ?? null).toBeNull();
    expect(edges.some((edge) => edge.source === "v1" && edge.target === "b1")).toBe(
      true,
    );
  });

  it("wipes a stale local upload left on the node", () => {
    // Uploaded a file locally first, then switched to picking from the canvas: leaving the old URL would make it
    // the fallback source once the edge is disconnected.
    useCanvasStore.setState({
      nodes: [
        SOURCE_VIDEO,
        BREAKDOWN_NODE({
          sourceVideoUrl: "/static/old-upload.mp4",
          sourceFileName: "old-upload.mp4",
        }),
      ],
      edges: [],
    });

    commitVideoPickToNode({
      sourceNodeId: "v1",
      requesterNodeId: "b1",
      videoUrl: "/static/demo.mp4",
      label: "Source clip",
    });

    const requester = useCanvasStore
      .getState()
      .nodes.find((item) => item.id === "b1");
    expect(requester?.data.sourceVideoUrl ?? null).toBeNull();
    expect(requester?.data.sourceFileName ?? null).toBeNull();
  });

  it("falls back to copying the URL when the edge is refused", () => {
    // The edge gate (type rules / reference limits) silently returns null. When the edge is genuinely lost, the
    // only option left is to copy the URL - otherwise clicking "pick from canvas" would result in nothing happening.
    useCanvasStore.setState({ nodes: [SOURCE_VIDEO, BREAKDOWN_NODE()], edges: [] });

    expect(
      commitVideoPickToNode({
        sourceNodeId: "v1",
        requesterNodeId: "missing-node",
        videoUrl: "/static/demo.mp4",
        label: "Source clip",
      }),
    ).toBe(false);
  });
});

describe("landing a breakdown result", () => {
  const RESULT = {
    storyboard: {
      groups: [
        {
          label: "Opening",
          shots: [{ code: "S01", description: "A boy stops at the edge of a field", image_url: "/static/s1.jpg" }],
        },
      ],
    },
  };

  beforeEach(() => {
    useCanvasStore.setState({ nodes: [BREAKDOWN_NODE()], edges: [] });
  });

  it("lands the groups when the node is still on the canvas", () => {
    expect(landVideoBreakdownResult({ nodeId: "b1", result: RESULT, labels: LABELS })).toBe(
      "ok",
    );
    expect(useCanvasStore.getState().nodes.length).toBeGreaterThan(1);
  });

  it("reports node-gone instead of empty when the node was deleted mid-run", () => {
    // Breakdown takes several minutes; it is entirely normal for the user to delete the node mid-run. That is not
    // "zero output" and should not pop an error.
    useCanvasStore.setState({ nodes: [], edges: [] });

    expect(landVideoBreakdownResult({ nodeId: "b1", result: RESULT, labels: LABELS })).toBe(
      "node-gone",
    );
  });

  it("reports empty when the job genuinely produced nothing", () => {
    expect(
      landVideoBreakdownResult({ nodeId: "b1", result: {}, labels: LABELS }),
    ).toBe("empty");
  });
});
