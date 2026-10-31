// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  extendGateView,
  findContinuationVideoModel,
  isContinuationCapableModel,
  isVideoModeSupportedOnNode,
  modelContinuesFromLastFrame,
  videoModelReferenceDisabledReason,
  videoSubmitMediaRejectionReason,
} from "@/features/canvas/nodes/shared/videoModelCapabilities";

// What the catalog hands the frontend for MiniMax H3 (see _freezone_dev_media_model_catalog_entries): no all_reference mode, no
// video reference, but flagged as extendable by turning the source video's last frame into the first frame.
const h3 = {
  id: "runpod_minimax_h3",
  apiModel: "runpod_minimax_h3",
  supportedModes: ["text_to_video", "first_frame", "first_last_frame", "image_to_video", "image_reference"],
  referenceImageMax: 9,
  referenceVideoMax: 0,
  referenceAudioMax: 3,
  supportsContinuation: true,
};
const seedance25 = { id: "newapi_seedance-2.5", apiModel: "newapi_seedance-2.5", supportedModes: ["all_reference", "video_extend"] };
const seedance20 = { id: "newapi_seedance-2.0-fast", apiModel: "newapi_seedance-2.0-fast", supportedModes: ["all_reference"] };

describe("smart extend on a model that continues from the last frame", () => {
  it("recognizes H3 by the catalog flag, not by name", () => {
    expect(modelContinuesFromLastFrame(h3)).toBe(true);
    expect(modelContinuesFromLastFrame({ ...h3, supportsContinuation: false })).toBe(false);
    expect(modelContinuesFromLastFrame({ ...h3, supportsContinuation: undefined })).toBe(false);
    expect(modelContinuesFromLastFrame("runpod_minimax_h3")).toBe(false); // a bare id carries no catalog flag
  });

  it("keeps Seedance 2.5 on its native extend path", () => {
    expect(modelContinuesFromLastFrame(seedance25)).toBe(false);
    // even when a future catalog also flags it
    expect(modelContinuesFromLastFrame({ ...seedance25, supportsContinuation: true })).toBe(false);
    expect(isContinuationCapableModel(seedance25)).toBe(true);
  });

  it("accepts exactly Seedance 2.5 and flagged models", () => {
    expect(isContinuationCapableModel(h3)).toBe(true);
    expect(isContinuationCapableModel(seedance20)).toBe(false);
    expect(isContinuationCapableModel(null)).toBe(false);
  });

  it("lands on the source clip's own model first, then Seedance 2.5, then any capable model", () => {
    const models = [seedance20, seedance25, h3];
    expect(findContinuationVideoModel(models, "runpod_minimax_h3")).toBe(h3);
    expect(findContinuationVideoModel(models, "newapi_seedance-2.0-fast")).toBe(seedance25); // 2.0 cannot extend
    expect(findContinuationVideoModel(models, null)).toBe(seedance25);
    expect(findContinuationVideoModel([seedance20, h3], null)).toBe(h3);
    expect(findContinuationVideoModel([seedance20], null)).toBeNull();
  });
});

describe("extendGateView", () => {
  const counts = { images: 2, videos: 1, audios: 0 };

  it("judges an H3 extend node as image reference with the source video out of the counts", () => {
    expect(extendGateView(h3, "allReference", counts, true)).toEqual({
      mode: "imageReference",
      counts: { images: 2, videos: 0, audios: 0 },
    });
  });

  it("changes nothing for Seedance 2.5, for non-extend nodes and for the stored mode", () => {
    expect(extendGateView(seedance25, "allReference", counts, true)).toEqual({ mode: "allReference", counts });
    expect(extendGateView(h3, "allReference", counts, false)).toEqual({ mode: "allReference", counts });
  });

  it("never goes below zero videos", () => {
    expect(extendGateView(h3, "allReference", { images: 1, videos: 0, audios: 0 }, true).counts.videos).toBe(0);
  });

  it("is what makes the existing gates accept H3 (and keeps rejecting it without the view)", () => {
    // as stored: all_reference does not exist for H3 and one video exceeds its video cap -> rejected
    expect(videoSubmitMediaRejectionReason("allReference", h3, counts)).not.toBeNull();
    expect(videoModelReferenceDisabledReason(h3, counts)).not.toBeNull();
    // through the view -> accepted
    const view = extendGateView(h3, "allReference", counts, true);
    expect(videoSubmitMediaRejectionReason(view.mode, h3, view.counts)).toBeNull();
    expect(videoModelReferenceDisabledReason(h3, view.counts)).toBeNull();
  });

  it("still rejects what H3 really cannot take: a second video", () => {
    const view = extendGateView(h3, "allReference", { images: 1, videos: 2, audios: 0 }, true);
    expect(view.counts.videos).toBe(1);
    expect(videoModelReferenceDisabledReason(h3, view.counts)).not.toBeNull();
  });
});

describe("isVideoModeSupportedOnNode", () => {
  it("lets an extend node on H3 sit on allReference, which H3's catalog does not list", () => {
    expect(isVideoModeSupportedOnNode("allReference", h3, true)).toBe(true);
  });

  it("does not widen anything for plain nodes, other modes or other models", () => {
    expect(isVideoModeSupportedOnNode("allReference", h3, false)).toBe(false);
    expect(isVideoModeSupportedOnNode("videoEdit", h3, true)).toBe(false);
    expect(isVideoModeSupportedOnNode("allReference", { ...h3, supportsContinuation: false }, true)).toBe(false);
    expect(isVideoModeSupportedOnNode("allReference", seedance20, true)).toBe(true); // by its own catalog
    expect(isVideoModeSupportedOnNode("imageReference", h3, false)).toBe(true);
  });
});
