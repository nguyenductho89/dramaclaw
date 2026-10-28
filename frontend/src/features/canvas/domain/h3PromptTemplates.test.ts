import { describe, expect, it } from "vitest";

import {
  H3_PROMPT_TEMPLATES,
  H3_TEMPLATE_CATEGORIES,
  h3TemplateGenMode,
  h3TemplateRunnablePrompt,
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
      if (template.mode === "fl2va") expect(declared.size).toBe(1);

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

  it("maps template modes to the frontend video gen modes", () => {
    const byMode = (mode: string) => H3_PROMPT_TEMPLATES.find((item) => item.mode === mode);
    expect(h3TemplateGenMode(byMode("fl2va")!)).toBe("firstFrame");
    expect(h3TemplateGenMode(byMode("flf2va")!)).toBe("firstLastFrame");
    expect(h3TemplateGenMode(byMode("ref2va")!)).toBe("imageReference");
  });

  it("includes both pixo and fal sources, with fal covering every mode it needs", () => {
    expect(H3_PROMPT_TEMPLATES.some((item) => item.source === "pixo")).toBe(true);
    expect(H3_PROMPT_TEMPLATES.filter((item) => item.source === "fal").length).toBeGreaterThanOrEqual(25);
    expect(H3_PROMPT_TEMPLATES.some((item) => item.mode === "flf2va")).toBe(true);
  });

  it.each(H3_PROMPT_TEMPLATES.map((item) => [item.id, item] as const))(
    "%s can run: picture inputs have image prompts and numbering is consecutive",
    (_id, template) => {
      const pictures = template.inputs.filter((input) => input.label.startsWith("<Picture"));
      expect(pictures.map((input) => input.label)).toEqual(
        pictures.map((_input, index) => `<Picture ${index + 1}>`),
      );
      for (const input of pictures) {
        expect(input.imagePrompt?.trim().length, `${template.id} ${input.label}`).toBeGreaterThan(20);
      }
      for (const input of template.inputs.filter((item) => item.label.startsWith("<Audio"))) {
        expect(input.imagePrompt).toBeUndefined();
      }
      // Pictures first, audio after: the spawner connects inputs in this order.
      const labels = template.inputs.map((input) => input.label);
      expect(labels).toEqual([...labels].sort((a, b) => Number(a.startsWith("<Audio")) - Number(b.startsWith("<Audio"))));
      if (template.mode === "flf2va") expect(pictures).toHaveLength(2);
      if (template.mode === "fl2va") expect(pictures).toHaveLength(1);
    },
  );

  it.each(H3_PROMPT_TEMPLATES.map((item) => [item.id, item] as const))(
    "%s has no stray placeholder brackets once made runnable",
    (_id, template) => {
      const runnable = h3TemplateRunnablePrompt(template);
      const left = [...runnable.matchAll(/\[([^\]\n]+)\]/g)].map((match) => match[1]);
      for (const inner of left) {
        expect(inner).toMatch(
          /^(Shot \d+|keyframe completion.*|reference generation|English|Vietnamese|Chinese|Japanese|Korean)$/,
        );
      }
      // The official-format markers must survive.
      expect(runnable).toMatch(/^\[Shot 1\] /m);
      if (template.mode === "ref2va") expect(runnable).toMatch(/\[keyframe completion[^\]]*\]/);
    },
  );

  it("unwraps sample values but keeps language tags", () => {
    const template = H3_PROMPT_TEMPLATES.find((item) => item.id === "fal_family_confrontation")!;
    const runnable = h3TemplateRunnablePrompt(template);
    expect(runnable).toContain("<d>[English] ");
    expect(runnable).not.toContain("[the son]");
    expect(runnable).toContain("the son");
  });
});

