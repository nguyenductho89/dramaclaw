// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCanvasStore } from "@/stores/canvasStore";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { VIDEO_REFERENCE_ENVELOPE } from "@/features/canvas/domain/videoReferenceLimits";
import type { ModelOption } from "@/features/canvas/ui/ProviderModelPicker";

// Edge validation runs outside React, and the model catalog is read from useFreezoneVideoModels' module-level store.
// Replacing that read port here lets any catalog be fed in; the default empty list = the catalog has not loaded yet, behavior falls back to the default envelope,
// and the first few cases below still assert 9/3/3/12.
let catalog: ModelOption[] = [];
vi.mock("@/features/canvas/hooks/useFreezoneVideoModels", () => ({
  readFreezoneVideoModels: () => catalog,
  prefetchFreezoneVideoModels: () => {},
  useFreezoneVideoModels: () => ({
    models: catalog,
    isLoading: false,
    isFallback: true,
    error: null,
  }),
}));

function incomingEdges(target: string) {
  return useCanvasStore.getState().edges.filter((edge) => edge.target === target);
}

describe("canvasStore material cap at the edge creation entry", () => {
  beforeEach(() => {
    catalog = [];
    useCanvasStore.getState().setCanvasData([], []);
  });

  // onConnect covers only manual line dragging. Picking a reference from the asset library and external file import (spawnExternalAssetNodes)
  // go through addEdge -- which is likewise "attaching material to an existing video node", and missing it means this
  // cap holds only when dragging lines and the normal product entries could bypass it directly.
  it("addEdge is also bound by the cap: after 9 images the 10th cannot connect", () => {
    const store = useCanvasStore.getState();
    const video = store.addNode(CANVAS_NODE_TYPES.video, { x: 900, y: 0 }, {});
    const images = Array.from({ length: VIDEO_REFERENCE_ENVELOPE.image + 1 }, (_, index) =>
      useCanvasStore
        .getState()
        .addNode(CANVAS_NODE_TYPES.imageGen, { x: index * 100, y: 0 }, {}),
    );

    for (const image of images.slice(0, VIDEO_REFERENCE_ENVELOPE.image)) {
      expect(useCanvasStore.getState().addEdge(image, video)).not.toBeNull();
    }
    expect(incomingEdges(video)).toHaveLength(VIDEO_REFERENCE_ENVELOPE.image);

    const overflow = images[VIDEO_REFERENCE_ENVELOPE.image];
    expect(useCanvasStore.getState().addEdge(overflow, video)).toBeNull();
    expect(incomingEdges(video)).toHaveLength(VIDEO_REFERENCE_ENVELOPE.image);
  });

  // External file import goes in the order "first create an empty Upload and wire the edge, then convert it to video/audio by MIME".
  // At the moment of edge creation an empty Upload can only be counted as an image, so 4 video files all fall within the image cap (9) --
  // and once the conversion finishes they become 4 video references, exceeding the video cap (3). So after the type is settled it must be recomputed.
  it("the edge exceeding the video cap after Upload converts to video is cleared", () => {
    const store = useCanvasStore.getState();
    const video = store.addNode(CANVAS_NODE_TYPES.video, { x: 900, y: 0 }, {});
    const uploads = Array.from({ length: VIDEO_REFERENCE_ENVELOPE.video + 1 }, (_, index) =>
      useCanvasStore
        .getState()
        .addNode(CANVAS_NODE_TYPES.upload, { x: index * 100, y: 0 }, {}),
    );
    for (const upload of uploads) {
      expect(useCanvasStore.getState().addEdge(upload, video)).not.toBeNull();
    }
    expect(incomingEdges(video)).toHaveLength(VIDEO_REFERENCE_ENVELOPE.video + 1);

    uploads.forEach((upload, index) => {
      useCanvasStore
        .getState()
        .convertNodeType(upload, CANVAS_NODE_TYPES.video, { videoUrl: `/v-${index}.mp4` });
    });

    expect(incomingEdges(video)).toHaveLength(VIDEO_REFERENCE_ENVELOPE.video);
    // The earlier ones stay and the later one is cleared, so the user sees "the last one did not connect" rather than a random one missing.
    expect(incomingEdges(video).map((edge) => edge.source)).toEqual(
      uploads.slice(0, VIDEO_REFERENCE_ENVELOPE.video),
    );
  });

  // The media catalog allows referenceImageMax to be configured as any non-negative integer, and the backend lets it through as configured. If the frontend treated
  // the default 9 as a hard cap for all models, a model configured with image=10 would be blocked locally at the 10th image and the request would never
  // reach the backend that would have accepted it. Edge validation must follow the effective envelope of the **selected model**.
  it("a model configured with image=10 in the catalog: the 10th image connects", () => {
    catalog = [
      {
        id: "wide-model",
        providerId: "seedance",
        apiModel: "wide-model",
        label: "Wide",
        referenceImageMax: 10,
      },
    ];
    const store = useCanvasStore.getState();
    const video = store.addNode(CANVAS_NODE_TYPES.video, { x: 900, y: 0 }, { model: "wide-model" });
    const images = Array.from({ length: 10 }, (_, index) =>
      useCanvasStore
        .getState()
        .addNode(CANVAS_NODE_TYPES.imageGen, { x: index * 100, y: 0 }, {}),
    );
    for (const image of images) {
      expect(useCanvasStore.getState().addEdge(image, video)).not.toBeNull();
    }
    expect(incomingEdges(video)).toHaveLength(10);
  });

  // The reverse must also hold: when the catalog sets the cap smaller than the default, the frontend must not let it through up to 9.
  it("a model configured with image=2 in the catalog: the 3rd image is blocked", () => {
    catalog = [
      {
        id: "narrow-model",
        providerId: "seedance",
        apiModel: "narrow-model",
        label: "Narrow",
        referenceImageMax: 2,
      },
    ];
    const store = useCanvasStore.getState();
    const video = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 900, y: 0 },
      { model: "narrow-model" },
    );
    const images = Array.from({ length: 3 }, (_, index) =>
      useCanvasStore
        .getState()
        .addNode(CANVAS_NODE_TYPES.imageGen, { x: index * 100, y: 0 }, {}),
    );
    expect(useCanvasStore.getState().addEdge(images[0], video)).not.toBeNull();
    expect(useCanvasStore.getState().addEdge(images[1], video)).not.toBeNull();
    expect(useCanvasStore.getState().addEdge(images[2], video)).toBeNull();
    expect(incomingEdges(video)).toHaveLength(2);
  });

  // Recomputation after type conversion uses the same yardstick: with video=5 configured in the catalog, none of the 5 video references should be cleared.
  it("a model configured with video=5 in the catalog: all 5 edges stay after every Upload converts to video", () => {
    catalog = [
      {
        id: "many-video",
        providerId: "seedance",
        apiModel: "many-video",
        label: "ManyVideo",
        referenceVideoMax: 5,
      },
    ];
    const store = useCanvasStore.getState();
    const video = store.addNode(CANVAS_NODE_TYPES.video, { x: 900, y: 0 }, { model: "many-video" });
    const uploads = Array.from({ length: 5 }, (_, index) =>
      useCanvasStore
        .getState()
        .addNode(CANVAS_NODE_TYPES.upload, { x: index * 100, y: 0 }, {}),
    );
    for (const upload of uploads) {
      useCanvasStore.getState().addEdge(upload, video);
    }
    uploads.forEach((upload, index) => {
      useCanvasStore
        .getState()
        .convertNodeType(upload, CANVAS_NODE_TYPES.video, { videoUrl: `/v-${index}.mp4` });
    });

    expect(incomingEdges(video)).toHaveLength(5);
  });

  it("conversion does not hurt any edge when the cap is not exceeded", () => {
    const store = useCanvasStore.getState();
    const video = store.addNode(CANVAS_NODE_TYPES.video, { x: 900, y: 0 }, {});
    const uploads = Array.from({ length: VIDEO_REFERENCE_ENVELOPE.video }, (_, index) =>
      useCanvasStore
        .getState()
        .addNode(CANVAS_NODE_TYPES.upload, { x: index * 100, y: 0 }, {}),
    );
    for (const upload of uploads) {
      useCanvasStore.getState().addEdge(upload, video);
    }

    uploads.forEach((upload, index) => {
      useCanvasStore
        .getState()
        .convertNodeType(upload, CANVAS_NODE_TYPES.video, { videoUrl: `/v-${index}.mp4` });
    });

    expect(incomingEdges(video)).toHaveLength(VIDEO_REFERENCE_ENVELOPE.video);
  });
});
