import { describe, expect, it } from "vitest";

import {
  H3_PROMPT_TEMPLATES,
  H3_TEMPLATE_CATEGORIES,
  isRunpodH3VideoModel,
} from "./h3PromptTemplates";

const REF_SECTIONS = [
  "subject_definitions:",
  "summary:",
  "retention_analysis:",
  "detailed_description:",
  "overall_soundscape:",
  "non_diegetic_music:",
];
const FIRST_FRAME_SECTIONS = [
  "integrated_multimodal_description:",
  "overall_soundscape:",
  "non_diegetic_music:",
];

function labelsIn(prompt: string, kind: "Picture" | "Audio"): Set<string> {
  return new Set(prompt.match(new RegExp(`<${kind} \\d+>`, "g")) ?? []);
}

describe("H3 prompt templates", () => {
  it("has unique ids and every category is populated", () => {
    const ids = H3_PROMPT_TEMPLATES.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const category of H3_TEMPLATE_CATEGORIES) {
      expect(H3_PROMPT_TEMPLATES.some((item) => item.category === category)).toBe(true);
    }
  });

  it.each(H3_PROMPT_TEMPLATES.map((item) => [item.id, item] as const))(
    "%s follows the official H3 layout and fits the backend",
    (_id, template) => {
      const sections = template.mode === "ref2va" ? REF_SECTIONS : FIRST_FRAME_SECTIONS;
      let cursor = -1;
      for (const header of sections) {
        const at = template.prompt.indexOf(header);
        expect(at, header).toBeGreaterThan(cursor);
        cursor = at;
      }
      expect(template.prompt.match(/^\[Shot 1\] /gm)).toHaveLength(1);
      expect(template.prompt).toContain("<Picture 1>");
      expect(template.durationSec).toBeGreaterThanOrEqual(5);
      expect(template.durationSec).toBeLessThanOrEqual(12);
      expect(["9:16", "16:9"]).toContain(template.aspectRatio);

      // Every label the prompt cites is an input the picker tells the user to connect, and vice versa.
      const declared = new Set(template.inputs.map((input) => input.label));
      const used = new Set([...labelsIn(template.prompt, "Picture"), ...labelsIn(template.prompt, "Audio")]);
      expect(used).toEqual(declared);
      expect(template.mode === "fl2va").toBe(declared.size === 1);

      // Later shots carry MM:SS.mmm timestamps in order.
      const stamps = [...template.prompt.matchAll(/\[Shot (\d+)\] At (\d\d):(\d\d\.\d{3})/g)];
      stamps.forEach((match, index) => {
        expect(Number(match[1])).toBe(index + 2);
        const seconds = Number(match[2]) * 60 + Number(match[3]);
        expect(seconds).toBeLessThan(template.durationSec);
      });
    },
  );

  it("matches only the RunPod H3 single-shot backend", () => {
    expect(isRunpodH3VideoModel("runpod_minimax_h3")).toBe(true);
    expect(isRunpodH3VideoModel("runpod_minimax_h3_multishot")).toBe(false);
    expect(isRunpodH3VideoModel("newapi_seedance-2.0-fast")).toBe(false);
    expect(isRunpodH3VideoModel(undefined)).toBe(false);
  });
});
