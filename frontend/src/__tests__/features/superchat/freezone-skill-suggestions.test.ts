// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  filterFreezoneSkillSuggestions,
  findFreezoneSkillMention,
  FREEZONE_SKILL_EMPTY_ACTIONS,
  getFreezoneSkillSlashQuery,
  insertFreezoneSkillEmptyActionPrompt,
  insertFreezoneSkillMention,
  moveFreezoneSkillSuggestionIndex,
  removeFreezoneSkillMention,
  shouldShowFreezoneSkillSuggestionMenu,
  splitFreezoneSkillMentionText,
  toFreezoneSkillSuggestions,
} from "@/features/superchat/freezone-skill-suggestions";

describe("freezone skill slash suggestions", () => {
  it("builds suggestions only from enabled skills with ids", () => {
    const suggestions = toFreezoneSkillSuggestions([
      {
        id: "poster_design",
        name: "Poster design",
        enabled: true,
        allowed_recipe_ids: ["poster-image"],
        category: "visual",
        description: "Poster visual style",
        triggers: { keywords: ["poster", { keyword: "visual" }] },
      },
      { id: "general", enabled: true, description: "No Recipe boundary" },
      { id: "disabled_skill", enabled: false, description: "Not shown" },
      { enabled: true, description: "No id" },
    ]);

    expect(suggestions).toEqual([
      {
        id: "poster_design",
        label: "Poster design",
        category: "visual",
        description: "Poster visual style",
        keywords: ["poster", "visual"],
      },
    ]);
  });

  it("opens only for the current slash token and filters by id, category, description, or keywords", () => {
    const suggestions = toFreezoneSkillSuggestions([
      {
        id: "poster_design",
        allowed_recipe_ids: ["poster-image"],
        category: "visual",
        description: "Poster visual style",
        triggers: { keywords: ["poster"] },
      },
      {
        id: "copy_plan",
        allowed_recipe_ids: ["copy-text"],
        category: "text",
        description: "Detail page copy",
        triggers: { keywords: ["copy"] },
      },
    ]);

    expect(getFreezoneSkillSlashQuery("/")).toBe("");
    expect(getFreezoneSkillSlashQuery("use /post")).toBe("post");
    expect(getFreezoneSkillSlashQuery("use /post continue")).toBeNull();
    expect(filterFreezoneSkillSuggestions(suggestions, "visual").map((item) => item.id)).toEqual([
      "poster_design",
    ]);
    expect(filterFreezoneSkillSuggestions(suggestions, "text").map((item) => item.id)).toEqual([
      "copy_plan",
    ]);
  });

  it("inserts the selected skill as visible prompt text without hidden metadata", () => {
    expect(insertFreezoneSkillMention("/", "poster_design")).toBe("/poster_design ");
    expect(insertFreezoneSkillMention("help me /post", "poster_design")).toBe("help me /poster_design ");
    expect(insertFreezoneSkillMention("first line\n/post", "poster_design")).toBe("first line\n/poster_design ");
    expect(insertFreezoneSkillMention("help me make", "poster_design")).toBe("help me make /poster_design ");
  });

  it("finds a completed skill mention wherever slash suggestions can be used", () => {
    expect(findFreezoneSkillMention("/poster_design make a poster")).toMatchObject({
      skillId: "poster_design",
      start: 0,
      end: 14,
    });
    expect(findFreezoneSkillMention("help me /poster_design make a poster")).toMatchObject({
      skillId: "poster_design",
      start: 8,
      end: 22,
    });
    expect(findFreezoneSkillMention("first line\n/poster_design make a poster")).toMatchObject({
      skillId: "poster_design",
      start: 11,
      end: 25,
    });
    expect(findFreezoneSkillMention("https://example.com/poster_design")).toBeNull();
  });

  it("removes a selected skill mention without leaving doubled spacing", () => {
    const mention = findFreezoneSkillMention("help me /poster_design make a poster");
    expect(removeFreezoneSkillMention("help me /poster_design make a poster", mention)).toBe("help me make a poster");
    expect(removeFreezoneSkillMention("/poster_design make a poster", findFreezoneSkillMention("/poster_design make a poster"))).toBe(
      "make a poster",
    );
  });

  it("splits sent message text into normal text and skill mention parts", () => {
    expect(splitFreezoneSkillMentionText("/poster_design make a poster")).toEqual([
      { type: "skill", skillId: "poster_design" },
      { type: "text", text: " make a poster" },
    ]);
    expect(splitFreezoneSkillMentionText("help me /poster_design make a poster /copy_plan")).toEqual([
      { type: "text", text: "help me " },
      { type: "skill", skillId: "poster_design" },
      { type: "text", text: " make a poster " },
      { type: "skill", skillId: "copy_plan" },
    ]);
  });

  it("cycles the active suggestion index with arrow keys", () => {
    expect(moveFreezoneSkillSuggestionIndex(0, 1, 3)).toBe(1);
    expect(moveFreezoneSkillSuggestionIndex(2, 1, 3)).toBe(0);
    expect(moveFreezoneSkillSuggestionIndex(0, -1, 3)).toBe(2);
    expect(moveFreezoneSkillSuggestionIndex(8, 1, 2)).toBe(1);
    expect(moveFreezoneSkillSuggestionIndex(0, 1, 0)).toBe(0);
  });

  it("keeps the slash skill menu open for empty results", () => {
    expect(shouldShowFreezoneSkillSuggestionMenu({ isFreezoneLayout: true, slashQuery: "" })).toBe(
      true,
    );
    expect(
      shouldShowFreezoneSkillSuggestionMenu({ isFreezoneLayout: true, slashQuery: "missing" }),
    ).toBe(true);
    expect(shouldShowFreezoneSkillSuggestionMenu({ isFreezoneLayout: true, slashQuery: null })).toBe(
      false,
    );
    expect(
      shouldShowFreezoneSkillSuggestionMenu({
        isFreezoneLayout: true,
        slashQuery: null,
        explicitOpen: true,
      }),
    ).toBe(true);
    expect(shouldShowFreezoneSkillSuggestionMenu({ isFreezoneLayout: false, slashQuery: "" })).toBe(
      false,
    );
    expect(
      shouldShowFreezoneSkillSuggestionMenu({
        isFreezoneLayout: false,
        slashQuery: null,
        explicitOpen: true,
      }),
    ).toBe(false);
  });

  it("fills the composer with an empty-state skill creation prompt", () => {
    expect(FREEZONE_SKILL_EMPTY_ACTIONS.map((action) => action.id)).toEqual([
      "summarize-canvas",
      "create-with-agent",
    ]);
    expect(insertFreezoneSkillEmptyActionPrompt("/", FREEZONE_SKILL_EMPTY_ACTIONS[0].prompt)).toBe(
      "Summarize the current canvas into a reusable Skill",
    );
    expect(insertFreezoneSkillEmptyActionPrompt("Please /skill", FREEZONE_SKILL_EMPTY_ACTIONS[1].prompt)).toBe(
      "Please Help me create a Skill:",
    );
  });
});
