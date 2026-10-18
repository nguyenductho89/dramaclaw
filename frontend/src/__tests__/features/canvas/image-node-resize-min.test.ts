// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { resolveResizeMinConstraintsByAspect } from "@/features/canvas/application/imageNodeSizing";

/**
 * The resize lower bound must be converted by the image ratio into a mutually consistent minimum width and height, so that with keepAspectRatio the short side is
 * the binding constraint; otherwise two independent mins would force wide/portrait images into an oversized minimum box that cannot shrink.
 */
describe("resolveResizeMinConstraintsByAspect", () => {
  it("scales a wide image's min box so the short edge is the binding floor", () => {
    const result = resolveResizeMinConstraintsByAspect("2:1", {
      minWidth: 140,
      minHeight: 140,
    });
    // Short side (height) = base 140, width = 140*2 = 280; not 140x140 (which keepAspectRatio would push to 280x140 with unclear semantics)
    expect(result.minHeight).toBe(140);
    expect(result.minWidth).toBe(280);
  });

  it("scales a tall image's min box so the short edge (width) is the floor", () => {
    const result = resolveResizeMinConstraintsByAspect("1:2", {
      minWidth: 140,
      minHeight: 140,
    });
    expect(result.minWidth).toBe(140);
    expect(result.minHeight).toBe(280);
  });
});
