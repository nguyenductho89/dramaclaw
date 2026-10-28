// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import type { VideoReviewData } from "@/lib/queries/video";
import { withFirstFrame } from "./h3-input-picker";

const review = {
  candidates: [
    { key: "identity:Yui_a", kind: "character" },
    { key: "prop:phone", kind: "prop" },
    { key: "scene:Bridge", kind: "scene" },
  ],
} as unknown as VideoReviewData;

describe("withFirstFrame", () => {
  it("brings the scene reference in when the rendered frame is dropped", () => {
    const next = withFirstFrame(
      { mode: "ref2va", firstFrame: "render", keys: ["identity:Yui_a", "prop:phone"] },
      review,
      false,
    );
    expect(next.firstFrame).toBe("none");
    expect(next.keys).toEqual(["identity:Yui_a", "prop:phone", "scene:Bridge"]);
  });

  it("does not duplicate a scene that is already selected", () => {
    const next = withFirstFrame({ firstFrame: "render", keys: ["scene:Bridge"] }, review, false);
    expect(next.keys).toEqual(["scene:Bridge"]);
  });

  it("takes the scene back out when the render is re-enabled", () => {
    const next = withFirstFrame(
      { firstFrame: "none", keys: ["identity:Yui_a", "scene:Bridge"] },
      review,
      true,
    );
    expect(next.firstFrame).toBe("render");
    expect(next.keys).toEqual(["identity:Yui_a"]);
  });
});
