// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { hasImageGenPromptOverride } from "@/features/canvas/nodes/imageGenPrompt";

describe("image generation prompt helpers", () => {
  it("treats blank prompt text as no manual override", () => {
    expect(hasImageGenPromptOverride("")).toBe(false);
    expect(hasImageGenPromptOverride("   \n\t")).toBe(false);
    expect(hasImageGenPromptOverride("add a bit of warm light")).toBe(true);
  });
});
