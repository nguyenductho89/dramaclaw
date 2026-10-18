// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// At the low-zoom tier, nodes other than exempt types are truly unmounted and replaced by LodShellNode. Nodes whose size was never measured
// (restored at first paint in the low-zoom tier, the component never rendered) can only draw their box from this fallback table, and an unregistered one gets
// the generic 400×300 — tsc cannot catch it, only this ratchet can.
import { describe, expect, it } from "vitest";

import { LOD_SHELL_EXEMPT_TYPES } from "@/features/canvas/application/canvasLod";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { SHELL_FALLBACK_SIZES } from "@/features/canvas/nodes/LodShellNode";

describe("SHELL_FALLBACK_SIZES", () => {
  it("covers every node type that can actually be shelled", () => {
    const missing = Object.values(CANVAS_NODE_TYPES)
      .filter((type) => !LOD_SHELL_EXEMPT_TYPES.has(type))
      .filter((type) => !SHELL_FALLBACK_SIZES[type])
      .sort();

    expect(missing).toEqual([]);
  });

  it("does not carry sizes for types that never get shelled", () => {
    const pointless = Object.keys(SHELL_FALLBACK_SIZES)
      .filter((type) => LOD_SHELL_EXEMPT_TYPES.has(type))
      .sort();

    expect(pointless).toEqual([]);
  });
});
