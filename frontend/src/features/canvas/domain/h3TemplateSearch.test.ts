import { describe, expect, it } from "vitest";

import { H3_PROMPT_TEMPLATES } from "./h3PromptTemplates";
import { searchH3Templates } from "./h3TemplateSearch";

describe("searchH3Templates", () => {
  it("returns everything for an empty query", () => {
    expect(searchH3Templates(H3_PROMPT_TEMPLATES, "  ")).toHaveLength(H3_PROMPT_TEMPLATES.length);
  });

  it("matches Vietnamese titles without accents", () => {
    const hits = searchH3Templates(H3_PROMPT_TEMPLATES, "khoanh khac lang");
    expect(hits.map((t) => t.id)).toContain("sound_designed_silence");
  });

  it("matches the id and requires every word", () => {
    expect(searchH3Templates(H3_PROMPT_TEMPLATES, "sound_designed").length).toBeGreaterThan(0);
    expect(searchH3Templates(H3_PROMPT_TEMPLATES, "sound_designed zzzznotaword")).toHaveLength(0);
  });

  it("searches the prompt text", () => {
    const hits = searchH3Templates(H3_PROMPT_TEMPLATES, "librarian");
    expect(hits.some((t) => t.id === "sound_designed_silence")).toBe(true);
  });
});
