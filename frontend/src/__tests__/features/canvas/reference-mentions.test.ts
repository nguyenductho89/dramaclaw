// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  remapReferenceMentions,
  sameOrder,
} from "@/features/canvas/nodes/referenceMentions";

const imageFamily = (prevIds: string[], nextIds: string[]) => ({
  prefix: "image",
  prevIds,
  nextIds,
});

describe("remapReferenceMentions", () => {
  it("renumbers a mention when an earlier reference is removed", () => {
    // Regression case: references [A, B], the prompt has @image2 (→B); after A is deleted B becomes image1,
    // and @image2 should follow and become @image1.
    const out = remapReferenceMentions("make @image2 move", [
      imageFamily(["A", "B"], ["B"]),
    ]);
    expect(out).toBe("make @image1 move");
  });

  it("drops a mention whose referenced node was removed (with trailing space)", () => {
    const out = remapReferenceMentions("first @image1 then @image2 finish", [
      imageFamily(["A", "B"], ["B"]),
    ]);
    // A (image1) is deleted → remove "@image1 "; B goes from image2 to image1.
    expect(out).toBe("first then @image1 finish");
  });

  it("follows nodes through a manual reorder", () => {
    const out = remapReferenceMentions("@image1 and @image2", [
      imageFamily(["A", "B"], ["B", "A"]),
    ]);
    // A: image1→image2; B: image2→image1.
    expect(out).toBe("@image2 and @image1");
  });

  it("leaves mentions untouched when a new reference is appended", () => {
    const out = remapReferenceMentions("use @image1", [
      imageFamily(["A"], ["A", "C"]),
    ]);
    expect(out).toBe("use @image1");
  });

  it("handles multi-digit numbering without cross-token collisions", () => {
    const prev = ["n1", "n2", "n3"];
    const next = ["n3", "n1", "n2"]; // each shifts right by one, the last returns to first
    const out = remapReferenceMentions("@image1 @image2 @image3", [
      imageFamily(prev, next),
    ]);
    // n1:1→2, n2:2→3, n3:3→1
    expect(out).toBe("@image2 @image3 @image1");
  });

  it("remaps image and audio families independently", () => {
    const out = remapReferenceMentions("look @image2 listen @audio2", [
      imageFamily(["i1", "i2"], ["i2"]),
      { prefix: "audio", prevIds: ["a1", "a2"], nextIds: ["a2"] },
    ]);
    expect(out).toBe("look @image1 listen @audio1");
  });

  it("leaves out-of-range / untracked numbers as-is", () => {
    const out = remapReferenceMentions("@image9 keep", [
      imageFamily(["A", "B"], ["B"]),
    ]);
    expect(out).toBe("@image9 keep");
  });

  it("returns prompt unchanged when order did not change", () => {
    const out = remapReferenceMentions("@image1 @image2", [
      imageFamily(["A", "B"], ["A", "B"]),
    ]);
    expect(out).toBe("@image1 @image2");
  });
});

describe("sameOrder", () => {
  it("compares by length and element identity in order", () => {
    expect(sameOrder(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameOrder(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameOrder(["a"], ["a", "b"])).toBe(false);
    expect(sameOrder([], [])).toBe(true);
  });
});
