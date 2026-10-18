// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { mentionDisplayLabel } from "@/features/canvas/nodes/PromptMentionEditor";

describe("mentionDisplayLabel", () => {
  it("strips the trailing number so image1/image2/... all show as image", () => {
    expect(mentionDisplayLabel("image1")).toBe("image");
    expect(mentionDisplayLabel("image2")).toBe("image");
    expect(mentionDisplayLabel("image10")).toBe("image");
  });

  it("does the same for audio mentions", () => {
    expect(mentionDisplayLabel("audio1")).toBe("audio");
    expect(mentionDisplayLabel("audio3")).toBe("audio");
  });

  it("leaves names without a trailing number unchanged", () => {
    expect(mentionDisplayLabel("image")).toBe("image");
    expect(mentionDisplayLabel("audio")).toBe("audio");
  });

  it("falls back to the original name when stripping would empty it", () => {
    expect(mentionDisplayLabel("123")).toBe("123");
    expect(mentionDisplayLabel("")).toBe("");
  });
});
