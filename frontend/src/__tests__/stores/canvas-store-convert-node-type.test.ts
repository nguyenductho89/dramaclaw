// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from "vitest";

import { useCanvasStore } from "@/stores/canvasStore";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";

function edgesOf(nodeId: string) {
  return useCanvasStore
    .getState()
    .edges.filter((edge) => edge.source === nodeId || edge.target === nodeId);
}

describe("canvasStore.convertNodeType — edges that become invalid after a type change are cleaned up in sync", () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  it("after Upload converts to audio, the edge that led to the image node is removed", () => {
    // An empty Upload node is first connected to an image node (valid), then the user drops an audio file into it,
    // and UploadNode converts it to Audio -- that edge is no longer valid. If it is not removed it stays on
    // the canvas until it is silently removed by normalization on the next load.
    const store = useCanvasStore.getState();
    const upload = store.addNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 }, {});
    const image = store.addNode(CANVAS_NODE_TYPES.imageGen, { x: 400, y: 0 }, {});

    useCanvasStore.getState().onConnect({
      source: upload,
      target: image,
      sourceHandle: "source",
      targetHandle: "target",
    });
    expect(edgesOf(upload)).toHaveLength(1);

    const ok = useCanvasStore
      .getState()
      .convertNodeType(upload, CANVAS_NODE_TYPES.audio, { audioUrl: "a.mp3" });

    expect(ok).toBe(true);
    expect(edgesOf(upload)).toEqual([]);
  });

  it("edges that are still valid after the type change are kept as they are", () => {
    // Audio -> video is valid, so this edge must not be hit by mistake after Upload converts to Audio.
    const store = useCanvasStore.getState();
    const upload = store.addNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 }, {});
    const video = store.addNode(CANVAS_NODE_TYPES.video, { x: 400, y: 0 }, {});

    useCanvasStore.getState().onConnect({
      source: upload,
      target: video,
      sourceHandle: "source",
      targetHandle: "target",
    });
    expect(edgesOf(upload)).toHaveLength(1);

    useCanvasStore
      .getState()
      .convertNodeType(upload, CANVAS_NODE_TYPES.audio, { audioUrl: "a.mp3" });

    expect(edgesOf(upload)).toHaveLength(1);
  });

  it("edges removed by cleanup can be restored by undo", () => {
    const store = useCanvasStore.getState();
    const upload = store.addNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 }, {});
    const image = store.addNode(CANVAS_NODE_TYPES.imageGen, { x: 400, y: 0 }, {});

    useCanvasStore.getState().onConnect({
      source: upload,
      target: image,
      sourceHandle: "source",
      targetHandle: "target",
    });
    useCanvasStore
      .getState()
      .convertNodeType(upload, CANVAS_NODE_TYPES.audio, { audioUrl: "a.mp3" });
    expect(edgesOf(upload)).toEqual([]);

    useCanvasStore.getState().undo();

    expect(edgesOf(upload)).toHaveLength(1);
    const restored = useCanvasStore.getState().nodes.find((node) => node.id === upload);
    expect(restored?.type).toBe(CANVAS_NODE_TYPES.upload);
  });
});
