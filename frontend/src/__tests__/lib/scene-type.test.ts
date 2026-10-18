// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { sceneTypeLabel, sceneTypeOptions } from "@/lib/scene-type";

import { enT } from "../helpers/i18n-fixtures";

describe("scene type labels", () => {
  it("renders canonical scene type values through i18n", () => {
    expect(sceneTypeOptions(null, enT)).toEqual([
      { value: "interior", label: "Interior" },
      { value: "exterior", label: "Exterior" },
      { value: "mixed", label: "Interior & exterior" },
      { value: "other", label: "Other" },
    ]);
    expect(sceneTypeLabel("interior", enT)).toBe("Interior");
    expect(sceneTypeLabel("exterior", enT)).toBe("Exterior");
  });

  it("keeps unknown legacy values readable", () => {
    expect(sceneTypeLabel("underground", enT)).toBe("underground");
    expect(sceneTypeLabel("", enT)).toBe("");
    // A project-defined type must stay selectable, and must not vanish from the dropdown just because it is not in the canonical table
    expect(sceneTypeOptions("underground", enT)).toContainEqual({
      value: "underground",
      label: "underground",
    });
  });
});
