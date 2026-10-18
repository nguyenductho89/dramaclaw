// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { sceneNameToRef, sceneRefToName } from "@/lib/scene-ref";

describe("scene-ref helpers", () => {
  it("keeps plain scene names as base scenes", () => {
    expect(sceneNameToRef("Bathroom")).toEqual({
      scene_id: "Bathroom",
      variant_id: "",
      plate_time_of_day: "",
    });
  });

  it("splits underscore scene names into base and variant", () => {
    expect(sceneNameToRef("Bathroom_leak")).toEqual({
      scene_id: "Bathroom",
      variant_id: "leak",
      plate_time_of_day: "",
    });
  });

  it("splits a standard time suffix into plate metadata without composing it back", () => {
    expect(sceneNameToRef("Bathroom_leak_night")).toEqual({
      scene_id: "Bathroom",
      variant_id: "leak",
      plate_time_of_day: "night",
    });
  });

  it("prefers structured scene records over name parsing", () => {
    expect(
      sceneNameToRef("Bathroom_leak_night", [
        {
          name: "Bathroom_leak_night",
          base_scene_id: "Bathroom",
          variant_id: "leak",
          time_of_day: "night",
        },
      ]),
    ).toEqual({
      scene_id: "Bathroom",
      variant_id: "leak",
      plate_time_of_day: "night",
    });
  });

  it("composes canonical scene refs back to display names", () => {
    expect(sceneRefToName({ scene_id: "Bathroom", variant_id: "leak" })).toBe(
      "Bathroom_leak",
    );
    expect(sceneRefToName({ scene_id: "Bathroom", variant_id: "" })).toBe("Bathroom");
  });
});
