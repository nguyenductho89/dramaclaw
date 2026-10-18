// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  translateSkillDescription,
  translateSkillInputLabel,
  translateSkillName,
  translateSkillOutputLabel,
  translateSkillCardinality,
  translateSkillParameterLabel,
  translateSkillParameterOption,
  translateSkillRequirement,
} from "@/features/freezone/context/skillI18n";
import type { SkillDefinition } from "@/features/freezone/context/skillRoles";

const translations: Record<string, string> = {
  "viewer.threeD.skillDefinitions.freezone_sketch_from_context.name": "Generate sketch from current background",
  "viewer.threeD.skillDefinitions.freezone_sketch_from_context.description": "Generate mainline sketch candidates from the shot context and the current background.",
  "viewer.threeD.skillDefinitions.freezone_frame_from_context.name": "Generate storyboard frame from shot context",
  "viewer.threeD.skillDefinitions.freezone_frame_from_context.description": "Generate mainline storyboard frame candidates from the shot context, sketch and reference images.",
  "viewer.threeD.skillInputLabels.beat_context": "Shot context",
  "viewer.threeD.skillOutputLabels.current_frame_candidate": "Storyboard frame candidate",
  "viewer.threeD.skillParameterLabels.freezone_sketch_from_context.aspect_ratio": "Ratio",
  "viewer.threeD.skillParameterOptions.freezone_sketch_from_context.aspect_ratio.2_3": "Portrait 2:3",
  "viewer.threeD.skillParameterOptions.freezone_sketch_from_context.aspect_ratio.16_9": "Landscape 16:9",
  "viewer.threeD.skillParameterLabels.freezone_frame_from_context.background_reference_mode": "Background reference mode",
  "viewer.threeD.skillParameterOptions.freezone_frame_from_context.background_reference_mode.material_only": "Appearance only",
  "viewer.threeD.skillParameterOptions.freezone_frame_from_context.background_reference_mode.scene_anchor": "Scene anchor",
  "viewer.threeD.skillRequirement.required": "Required",
  "viewer.threeD.skillRequirement.optional": "Optional",
  "viewer.threeD.skillCardinality.single": "Single",
  "viewer.threeD.skillCardinality.multi": "Multiple",
};

const t = ((key: string) => translations[key] ?? key) as never;

describe("mainline skill i18n", () => {
  it("translates backend English names and descriptions by skill id", () => {
    const skill = {
      id: "freezone.sketch_from_context",
      display_name: "Sketch From Selected Background",
      description: "Generate a mainline sketch candidate from beat context and selected background.",
    } as SkillDefinition;

    expect(translateSkillName(skill, t)).toBe("Generate sketch from current background");
    expect(translateSkillDescription(skill, t)).toBe("Generate mainline sketch candidates from the shot context and the current background.");
  });

  it("keeps skill node input/output labels in Chinese", () => {
    expect(translateSkillInputLabel("beat_context", "Beat context", t)).toBe("Shot context");
    expect(translateSkillOutputLabel("current_frame_candidate", "Current frame candidate", t)).toBe("Storyboard frame candidate");
  });

  it("translates skill parameter labels and option values", () => {
    expect(
      translateSkillParameterLabel(
        "freezone.sketch_from_context",
        "aspect_ratio",
        "Aspect ratio",
        t,
      ),
    ).toBe("Ratio");
    expect(
      translateSkillParameterOption(
        "freezone.sketch_from_context",
        "aspect_ratio",
        "2:3",
        t,
      ),
    ).toBe("Portrait 2:3");
    expect(
      translateSkillParameterOption(
        "freezone.sketch_from_context",
        "aspect_ratio",
        "16:9",
        t,
      ),
    ).toBe("Landscape 16:9");
    expect(
      translateSkillParameterLabel(
        "freezone.frame_from_context",
        "background_reference_mode",
        "Background reference mode",
        t,
      ),
    ).toBe("Background reference mode");
    expect(
      translateSkillParameterOption(
        "freezone.frame_from_context",
        "background_reference_mode",
        "material_only",
        t,
      ),
    ).toBe("Appearance only");
    expect(
      translateSkillParameterOption(
        "freezone.frame_from_context",
        "background_reference_mode",
        "scene_anchor",
        t,
      ),
    ).toBe("Scene anchor");
  });

  it("translates requirement and cardinality labels", () => {
    expect(translateSkillRequirement(true, t)).toBe("Required");
    expect(translateSkillRequirement(false, t)).toBe("Optional");
    expect(translateSkillCardinality("single", t)).toBe("Single");
    expect(translateSkillCardinality("multi", t)).toBe("Multiple");
  });
});
