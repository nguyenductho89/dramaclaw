// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  findReferenceTokenAtSelection,
  replaceReferenceToken,
} from "@/features/canvas/application/referenceTokenEditing";

describe("findReferenceTokenAtSelection", () => {
  const text = "Put @image1 and @image2 together"; // @image1 is at [4,11), @image2 at [16,23)

  it("finds the token whose range overlaps the double-click selection", () => {
    // Double-clicking "image1" selects roughly [5,11) (after the @), which should hit the first token.
    const hit = findReferenceTokenAtSelection(text, 5, 11, 2);
    expect(hit?.token).toBe("@image1");
    expect(hit?.start).toBe(4);
    expect(hit?.end).toBe(11);
  });

  it("finds the second token when the selection is on image2", () => {
    const hit = findReferenceTokenAtSelection(text, 17, 23, 2);
    expect(hit?.token).toBe("@image2");
  });

  it("returns null when the selection is on plain text", () => {
    expect(findReferenceTokenAtSelection(text, 0, 1, 2)).toBeNull();
  });

  it("matches a collapsed caret sitting inside the token", () => {
    // A selection collapsed inside the token (between "image" and "1") should also hit.
    const hit = findReferenceTokenAtSelection(text, 10, 10, 2);
    expect(hit?.token).toBe("@image1");
  });
});

describe("replaceReferenceToken", () => {
  it("replaces the token range with the new marker and returns the caret after it", () => {
    const text = "Animate @image1 now";
    // @image1 is at [8,15)
    const { nextText, nextCursor } = replaceReferenceToken(
      text,
      { start: 8, end: 15 },
      "@image2",
    );
    expect(nextText).toBe("Animate @image2 now");
    expect(nextCursor).toBe(8 + "@image2".length);
  });

  it("works for multi-digit markers", () => {
    const { nextText } = replaceReferenceToken("a @image1 b", { start: 2, end: 9 }, "@image10");
    expect(nextText).toBe("a @image10 b");
  });
});
