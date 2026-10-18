// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, it, expect } from "vitest";

import {
  parseEnvironmentPrompt,
  serializeEnvironmentPrompt,
} from "@/components/assets/scene-environment-prompt";

const FULL_PROMPT = [
  "Front: The core visual is a long wooden worktable.",
  "Left: There is a narrow doorway leading to the kitchen.",
  "Right: A simple wooden rack stands in the space.",
  "Back: An old double-leaf wooden window.",
  "Lighting: The main indoor light is off and a cold blue glare dominates.",
  "Material/Style: A typical 1990s Chinese residential interior.",
  "Forbidden elements: Modern smart home, minimalist decor.",
].join("\n");

describe("parseEnvironmentPrompt", () => {
  it("splits a full 7-heading prompt into its sections", () => {
    const s = parseEnvironmentPrompt(FULL_PROMPT);
    expect(s.front).toBe("The core visual is a long wooden worktable.");
    expect(s.left).toBe("There is a narrow doorway leading to the kitchen.");
    expect(s.right).toBe("A simple wooden rack stands in the space.");
    expect(s.back).toBe("An old double-leaf wooden window.");
    expect(s.light).toBe("The main indoor light is off and a cold blue glare dominates.");
    expect(s.material).toBe("A typical 1990s Chinese residential interior.");
    expect(s.forbidden).toBe("Modern smart home, minimalist decor.");
  });

  it("accepts both halfwidth and fullwidth colons", () => {
    const s = parseEnvironmentPrompt("Front: front\nBack: back");
    expect(s.front).toBe("front");
    expect(s.back).toBe("back");
  });

  it("keeps multi-line section content until the next heading", () => {
    const s = parseEnvironmentPrompt("Front: line1\nstill front\nLeft: l");
    expect(s.front).toBe("line1\nstill front");
    expect(s.left).toBe("l");
  });

  it("does not treat a keyword mid-sentence as a heading", () => {
    const s = parseEnvironmentPrompt("Front: Mentioning Back here is only a description");
    expect(s.front).toBe("Mentioning Back here is only a description");
    expect(s.back).toBe("");
  });

  it("keeps legacy / unlabeled prompts whole in the front field", () => {
    const s = parseEnvironmentPrompt("A piece of free text without any heading");
    expect(s.front).toBe("A piece of free text without any heading");
    expect(s.left).toBe("");
  });

  it("returns all-empty sections for blank input", () => {
    const s = parseEnvironmentPrompt("");
    expect(Object.values(s).every((v) => v === "")).toBe(true);
  });
});

describe("serializeEnvironmentPrompt", () => {
  it("round-trips a full prompt", () => {
    expect(serializeEnvironmentPrompt(parseEnvironmentPrompt(FULL_PROMPT))).toBe(
      FULL_PROMPT,
    );
  });

  it("omits empty sections", () => {
    const out = serializeEnvironmentPrompt({
      front: "f",
      left: "",
      right: "",
      back: "b",
      light: "",
      material: "",
      forbidden: "",
    });
    expect(out).toBe("Front: f\nBack: b");
  });

  it("trims section values", () => {
    const out = serializeEnvironmentPrompt({
      front: "  f  ",
      left: "",
      right: "",
      back: "",
      light: "",
      material: "",
      forbidden: "",
    });
    expect(out).toBe("Front: f");
  });
});
