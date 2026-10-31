// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
  type CanvasNodeType,
} from "@/features/canvas/domain/canvasNodes";
import {
  VIDEO_REFERENCE_ENVELOPE,
  classifyVideoReferenceMedia,
  overflowingVideoReferenceEdgeIds,
  videoReferenceConnectionRejection,
  videoReferenceEnvelopeForModel,
} from "@/features/canvas/domain/videoReferenceLimits";
import { videoReferenceEnvelopeForNode } from "@/features/canvas/application/videoReferenceEnvelope";
import type { ModelOption } from "@/features/canvas/ui/ProviderModelPicker";

function node(
  id: string,
  type: CanvasNodeType,
  data: Record<string, unknown> = {},
): CanvasNode {
  return { id, type, position: { x: 0, y: 0 }, data } as CanvasNode;
}

/** A target video node + n connected material nodes of some kind, returning (nodes, edges) for the guard to check. */
function scene(kinds: readonly CanvasNodeType[], datas: readonly Record<string, unknown>[] = []) {
  const target = node("video-target", CANVAS_NODE_TYPES.video);
  const sources = kinds.map((type, index) => node(`src-${index}`, type, datas[index] ?? {}));
  return {
    nodes: [target, ...sources],
    edges: sources.map((source) => ({ source: source.id, target: target.id })),
  };
}

function fill(type: CanvasNodeType, count: number): CanvasNodeType[] {
  return Array.from({ length: count }, () => type);
}

describe("classifyVideoReferenceMedia — material classification", () => {
  it("classifies by node type, counting empty nodes too (wiring the node first and filling the material later is the normal order)", () => {
    expect(classifyVideoReferenceMedia(node("a", CANVAS_NODE_TYPES.imageGen))).toBe("image");
    expect(classifyVideoReferenceMedia(node("a", CANVAS_NODE_TYPES.upload))).toBe("image");
    expect(classifyVideoReferenceMedia(node("a", CANVAS_NODE_TYPES.video))).toBe("video");
    expect(classifyVideoReferenceMedia(node("a", CANVAS_NODE_TYPES.audio))).toBe("audio");
  });

  // A video picked from the asset library is an upload node with its address in data.videoUrl -- looking at the type alone would mistake it for an image.
  it("an upload node with videoUrl counts as video, not image", () => {
    expect(
      classifyVideoReferenceMedia(
        node("a", CANVAS_NODE_TYPES.upload, { videoUrl: "/a.mp4" }),
      ),
    ).toBe("video");
  });

  it("non-material nodes (text / empty) are not counted", () => {
    expect(classifyVideoReferenceMedia(node("a", CANVAS_NODE_TYPES.textAnnotation))).toBeNull();
    expect(classifyVideoReferenceMedia(null)).toBeNull();
  });
});

// 9/3/3/12 are only the defaults for "catalog not configured". The media catalog allows referenceImageMax and friends to be set to any
// non-negative integer, and the backend _catalog_reference_limits (api/routes/freezone.py:7004) adopts them;
// if the frontend treated the defaults as a hard cap, a legitimate model configured with image=10 would be blocked at the 10th image and the request would never
// reach the backend that would have accepted it -- a frontend stricter than the backend swallows the capability the admin configured.
describe("videoReferenceEnvelopeForModel — catalog configuration takes precedence", () => {
  it("uses the default envelope when no catalog value is configured", () => {
    expect(videoReferenceEnvelopeForModel(undefined)).toEqual(VIDEO_REFERENCE_ENVELOPE);
    expect(videoReferenceEnvelopeForModel({})).toEqual(VIDEO_REFERENCE_ENVELOPE);
  });

  // The total is computed the same way as the backend omni call site (freezone.py:7857-7868): as soon as any
  // one of the three comes from the catalog, the total is the sum of the three; only when none is configured does it fall back to 12.
  it("configuring any one item computes the total as the sum of the three", () => {
    expect(videoReferenceEnvelopeForModel({ referenceImageMax: 10 })).toEqual({
      image: 10,
      video: VIDEO_REFERENCE_ENVELOPE.video,
      audio: VIDEO_REFERENCE_ENVELOPE.audio,
      total: 10 + VIDEO_REFERENCE_ENVELOPE.video + VIDEO_REFERENCE_ENVELOPE.audio,
    });
    expect(
      videoReferenceEnvelopeForModel({
        referenceImageMax: 4,
        referenceVideoMax: 1,
        referenceAudioMax: 0,
      }),
    ).toEqual({ image: 4, video: 1, audio: 0, total: 5 });
  });

  // Same rule as the backend `type(value) is int and value >= 0`.
  it("null / negative / fractional values are all treated as not configured", () => {
    expect(
      videoReferenceEnvelopeForModel({
        referenceImageMax: null,
        referenceVideoMax: -1,
        referenceAudioMax: 2.5,
      }),
    ).toEqual(VIDEO_REFERENCE_ENVELOPE);
  });
});

describe("videoReferenceEnvelopeForNode — resolves the selected model's envelope from the node", () => {
  const catalog: ModelOption[] = [
    { id: 'first', providerId: 'seedance', apiModel: 'first', label: 'First' },
    {
      id: 'wide',
      providerId: 'seedance',
      apiModel: 'wide',
      label: 'Wide',
      referenceImageMax: 10,
    },
  ];

  it("looks up by data.model in the catalog", () => {
    const videoNode = node("v", CANVAS_NODE_TYPES.video, { model: 'wide' });
    expect(videoReferenceEnvelopeForNode(videoNode, catalog).image).toBe(10);
  });

  // The fallback must match VideoNode's selectedVideoModel (the first in the list is shown when no model is stored),
  // otherwise the UI would show the cap of model A while edge creation blocks by model B.
  it("falls back to the first in the list when no model is stored / it is not found in the catalog", () => {
    expect(videoReferenceEnvelopeForNode(node("v", CANVAS_NODE_TYPES.video), catalog).image).toBe(
      VIDEO_REFERENCE_ENVELOPE.image,
    );
    expect(
      videoReferenceEnvelopeForNode(
        node("v", CANVAS_NODE_TYPES.video, { model: 'gone' }),
        catalog,
      ).image,
    ).toBe(VIDEO_REFERENCE_ENVELOPE.image);
  });

  it("falls back to the default envelope when the catalog has not loaded yet (empty list)", () => {
    expect(videoReferenceEnvelopeForNode(node("v", CANVAS_NODE_TYPES.video), [])).toEqual(
      VIDEO_REFERENCE_ENVELOPE,
    );
  });
});

describe("smart extend on MiniMax H3 — the source video must be connectable", () => {
  // The catalog entry of H3: video reference cap 0 (the clip is consumed server-side, last frame -> first frame), flagged extendable.
  const h3: ModelOption = {
    id: "runpod_minimax_h3",
    providerId: "seedance",
    apiModel: "runpod_minimax_h3",
    label: "MiniMax-H3",
    referenceImageMax: 9,
    referenceVideoMax: 0,
    referenceAudioMax: 3,
    supportsContinuation: true,
  };

  it("an extend node accepts one video and at most 8 images (one slot is the last frame)", () => {
    const extend = node("v", CANVAS_NODE_TYPES.video, { model: "runpod_minimax_h3", isExtendMode: true });
    expect(videoReferenceEnvelopeForNode(extend, [h3])).toEqual({ image: 8, video: 1, audio: 3, total: 12 });
  });

  it("a plain H3 node keeps video cap 0: this is not a general video reference", () => {
    const plain = node("v", CANVAS_NODE_TYPES.video, { model: "runpod_minimax_h3" });
    expect(videoReferenceEnvelopeForNode(plain, [h3]).video).toBe(0);
  });

  it("an extend node on a model without the flag is left alone", () => {
    const extend = node("v", CANVAS_NODE_TYPES.video, { model: "runpod_minimax_h3", isExtendMode: true });
    expect(videoReferenceEnvelopeForNode(extend, [{ ...h3, supportsContinuation: false }]).video).toBe(0);
  });

  it("the edge from the source video to the extend node is accepted, a second video is not", () => {
    const extend = node("ext", CANVAS_NODE_TYPES.video, { model: "runpod_minimax_h3", isExtendMode: true });
    const source = node("src", CANVAS_NODE_TYPES.video, { videoUrl: "/a.mp4" });
    const other = node("other", CANVAS_NODE_TYPES.video, { videoUrl: "/b.mp4" });
    const resolve = (n: CanvasNode) => videoReferenceEnvelopeForNode(n, [h3]);
    expect(
      videoReferenceConnectionRejection([extend, source], [], { source: "src", target: "ext" }, resolve),
    ).toBeNull();
    expect(
      videoReferenceConnectionRejection(
        [extend, source, other],
        [{ source: "src", target: "ext" }],
        { source: "other", target: "ext" },
        resolve,
      ),
    ).not.toBeNull();
    // the same edge into a plain H3 node is still refused (cap 0)
    const plain = node("plain", CANVAS_NODE_TYPES.video, { model: "runpod_minimax_h3" });
    expect(
      videoReferenceConnectionRejection([plain, source], [], { source: "src", target: "plain" }, resolve),
    ).not.toBeNull();
  });

  it("overflow cleanup keeps the source edge of an extend node", () => {
    const extend = node("ext", CANVAS_NODE_TYPES.video, { model: "runpod_minimax_h3", isExtendMode: true });
    const source = node("src", CANVAS_NODE_TYPES.video, { videoUrl: "/a.mp4" });
    const edges = [{ id: "e1", source: "src", target: "ext" }];
    const resolve = (n: CanvasNode) => videoReferenceEnvelopeForNode(n, [h3]);
    expect(overflowingVideoReferenceEdgeIds([extend, source], edges, "ext", resolve)).toEqual([]);
  });
});

describe("videoReferenceConnectionRejection — material cap when creating an edge", () => {
  const connect = (nodes: CanvasNode[], edges: { source: string; target: string }[], sourceId: string) =>
    videoReferenceConnectionRejection(nodes, edges, {
      source: sourceId,
      target: "video-target",
    });

  it(`rejects image ${VIDEO_REFERENCE_ENVELOPE.image + 1} once ${VIDEO_REFERENCE_ENVELOPE.image} images are reached`, () => {
    const { nodes, edges } = scene(fill(CANVAS_NODE_TYPES.imageGen, VIDEO_REFERENCE_ENVELOPE.image));
    const extra = node("extra", CANVAS_NODE_TYPES.imageGen);
    expect(connect([...nodes, extra], edges, extra.id)).toContain(
      String(VIDEO_REFERENCE_ENVELOPE.image),
    );
  });

  it("allows it while not full", () => {
    const { nodes, edges } = scene(
      fill(CANVAS_NODE_TYPES.imageGen, VIDEO_REFERENCE_ENVELOPE.image - 1),
    );
    const extra = node("extra", CANVAS_NODE_TYPES.imageGen);
    expect(connect([...nodes, extra], edges, extra.id)).toBeNull();
  });

  // This is the core case for "block by capability envelope" rather than "block by the current mode's slot": first-frame takes only 1 image,
  // but the 2nd must be connectable, otherwise the automatic switch "first frame -> omni reference" in VideoNode would never
  // fire, and the user would be stuck in the single-image state.
  it("the 2nd image is still allowed in first-frame mode -- left to the automatic mode switch to correct", () => {
    const { nodes, edges } = scene([CANVAS_NODE_TYPES.imageGen]);
    const second = node("second", CANVAS_NODE_TYPES.imageGen);
    expect(connect([...nodes, second], edges, second.id)).toBeNull();
  });

  it(`rejects video / audio once each reaches ${VIDEO_REFERENCE_ENVELOPE.video}`, () => {
    for (const [type, cap] of [
      [CANVAS_NODE_TYPES.video, VIDEO_REFERENCE_ENVELOPE.video],
      [CANVAS_NODE_TYPES.audio, VIDEO_REFERENCE_ENVELOPE.audio],
    ] as const) {
      const { nodes, edges } = scene(fill(type, cap));
      const extra = node("extra", type);
      expect(connect([...nodes, extra], edges, extra.id)).toContain(String(cap));
    }
  });

  // Besides the per-item limits, the backend validate_omni_reference_limits also has total_max=12: 9 images + 3 videos
  // already fill the total, and connecting audio exceeds the total while staying within the per-item limits.
  it("every item within limits but the total exceeds 12 -> also rejected", () => {
    const { nodes, edges } = scene([
      ...fill(CANVAS_NODE_TYPES.imageGen, VIDEO_REFERENCE_ENVELOPE.image),
      ...fill(CANVAS_NODE_TYPES.video, VIDEO_REFERENCE_ENVELOPE.video),
    ]);
    const extra = node("extra", CANVAS_NODE_TYPES.audio);
    expect(connect([...nodes, extra], edges, extra.id)).toContain(
      String(VIDEO_REFERENCE_ENVELOPE.total),
    );
  });

  it("target is not a video node / source is not a material node -> ignored", () => {
    const { nodes, edges } = scene(fill(CANVAS_NODE_TYPES.imageGen, VIDEO_REFERENCE_ENVELOPE.image));
    const text = node("text", CANVAS_NODE_TYPES.textAnnotation);
    // 9 images are full, but a text node is wired in: it takes no material slot.
    expect(connect([...nodes, text], edges, text.id)).toBeNull();
    // Same 9 images with an image node as target: this cap applies only to video nodes.
    const imageTarget = node("image-target", CANVAS_NODE_TYPES.imageGen);
    const extra = node("extra", CANVAS_NODE_TYPES.imageGen);
    expect(
      videoReferenceConnectionRejection(
        [...nodes, imageTarget, extra],
        edges.map((edge) => ({ ...edge, target: imageTarget.id })),
        { source: extra.id, target: imageTarget.id },
      ),
    ).toBeNull();
  });

  // Reconnecting an existing edge must not be blocked by itself (it could not create a second edge anyway).
  it("repeated wiring from the same source is allowed", () => {
    const { nodes, edges } = scene(fill(CANVAS_NODE_TYPES.imageGen, VIDEO_REFERENCE_ENVELOPE.image));
    expect(connect(nodes, edges, "src-0")).toBeNull();
  });

  // The envelope is resolved by the caller and fed in: for a model configured with image=10 in the catalog, the 10th image must be allowed.
  it("allows by model envelope -- the 10th image connects when the catalog sets image=10", () => {
    const { nodes, edges } = scene(fill(CANVAS_NODE_TYPES.imageGen, VIDEO_REFERENCE_ENVELOPE.image));
    const extra = node("extra", CANVAS_NODE_TYPES.imageGen);
    expect(
      videoReferenceConnectionRejection(
        [...nodes, extra],
        edges,
        { source: extra.id, target: "video-target" },
        () => videoReferenceEnvelopeForModel({ referenceImageMax: 10 }),
      ),
    ).toBeNull();
  });

  it("an upstream upload node with videoUrl counts as video and takes no image quota", () => {
    const { nodes, edges } = scene(
      fill(CANVAS_NODE_TYPES.upload, VIDEO_REFERENCE_ENVELOPE.video),
      Array.from({ length: VIDEO_REFERENCE_ENVELOPE.video }, () => ({ videoUrl: "/a.mp4" })),
    );
    const extraVideo = node("extra-video", CANVAS_NODE_TYPES.video);
    expect(connect([...nodes, extraVideo], edges, extraVideo.id)).toContain(
      String(VIDEO_REFERENCE_ENVELOPE.video),
    );
    // The same upload nodes took no image quota, so images can still be connected.
    const extraImage = node("extra-image", CANVAS_NODE_TYPES.imageGen);
    expect(connect([...nodes, extraImage], edges, extraImage.id)).toBeNull();
  });
});

// Validation at edge creation cannot catch "wire first, change type later": an external file import first lands an empty Upload and wires it (counted as an image),
// then converts it to video/audio by MIME. Once the type is settled, the overflowing edges must be recomputable.
describe("overflowingVideoReferenceEdgeIds — recomputation after the type changed", () => {
  function graph(kinds: readonly CanvasNodeType[]) {
    const target = node("video-target", CANVAS_NODE_TYPES.video);
    const sources = kinds.map((type, index) => node(`src-${index}`, type));
    return {
      nodes: [target, ...sources],
      edges: sources.map((source) => ({
        id: `e-${source.id}`,
        source: source.id,
        target: target.id,
      })),
    };
  }

  it("returns empty when nothing overflows", () => {
    const { nodes, edges } = graph(fill(CANVAS_NODE_TYPES.video, VIDEO_REFERENCE_ENVELOPE.video));
    expect(overflowingVideoReferenceEdgeIds(nodes, edges, "video-target")).toEqual([]);
  });

  it("overflow goes by first come first served, so only the last few edges overflow", () => {
    const { nodes, edges } = graph(
      fill(CANVAS_NODE_TYPES.video, VIDEO_REFERENCE_ENVELOPE.video + 2),
    );
    expect(overflowingVideoReferenceEdgeIds(nodes, edges, "video-target")).toEqual([
      `e-src-${VIDEO_REFERENCE_ENVELOPE.video}`,
      `e-src-${VIDEO_REFERENCE_ENVELOPE.video + 1}`,
    ]);
  });

  it("also counts as overflow when each item is within limits but the total exceeds 12", () => {
    const { nodes, edges } = graph([
      ...fill(CANVAS_NODE_TYPES.imageGen, VIDEO_REFERENCE_ENVELOPE.image),
      ...fill(CANVAS_NODE_TYPES.video, VIDEO_REFERENCE_ENVELOPE.video),
      CANVAS_NODE_TYPES.audio,
    ]);
    expect(overflowingVideoReferenceEdgeIds(nodes, edges, "video-target")).toEqual([
      `e-src-${VIDEO_REFERENCE_ENVELOPE.total}`,
    ]);
  });

  // Recomputation also follows the model envelope: for a model configured with video=5, none of the 5 video references should be cleared.
  it("recomputes by model envelope -- all 5 videos stay when the catalog sets video=5", () => {
    const { nodes, edges } = graph(fill(CANVAS_NODE_TYPES.video, 5));
    expect(
      overflowingVideoReferenceEdgeIds(nodes, edges, "video-target", () =>
        videoReferenceEnvelopeForModel({ referenceVideoMax: 5 }),
      ),
    ).toEqual([]);
  });

  it("ignored when the target is not a video node", () => {
    const { nodes, edges } = graph(fill(CANVAS_NODE_TYPES.video, VIDEO_REFERENCE_ENVELOPE.video + 2));
    const imageTarget = node("image-target", CANVAS_NODE_TYPES.imageGen);
    expect(
      overflowingVideoReferenceEdgeIds(
        [...nodes, imageTarget],
        edges.map((edge) => ({ ...edge, target: imageTarget.id })),
        imageTarget.id,
      ),
    ).toEqual([]);
  });
});
