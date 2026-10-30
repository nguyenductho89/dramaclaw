import { describe, expect, it } from "vitest";

import { loadCommunityH3Templates } from "./communityH3Templates";
import { H3_PROMPT_TEMPLATES, h3TemplateGenMode, h3TemplateRunnablePrompt } from "./h3PromptTemplates";

describe("community H3 templates", () => {
  it("loads unique first-frame templates that fit the RunPod backend", async () => {
    const templates = await loadCommunityH3Templates();
    expect(templates.length).toBeGreaterThan(100);

    const ids = [...templates, ...H3_PROMPT_TEMPLATES].map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const template of templates) {
      expect(template.source).toBe("community");
      expect(template.mode).toBe("fl2va");
      expect(h3TemplateGenMode(template)).toBe("firstFrame");
      expect(template.inputs.map((input) => input.label)).toEqual(["<Picture 1>"]);
      expect(template.durationSec).toBeGreaterThanOrEqual(5);
      expect(template.durationSec).toBeLessThanOrEqual(12);
      expect(["9:16", "16:9"]).toContain(template.aspectRatio);
      expect(template.title.en.trim()).not.toBe("");
      expect(template.title.vi.trim()).not.toBe("");
      expect(template.prompt.trim()).not.toBe("");
    }
  });

  it("sends the prompt text untouched (square brackets are content)", async () => {
    const templates = await loadCommunityH3Templates();
    const withBrackets = templates.find((item) => /\[[^\]\n]+\]/.test(item.prompt));
    if (withBrackets) {
      expect(h3TemplateRunnablePrompt(withBrackets)).toBe(withBrackets.prompt);
    }
  });
});
