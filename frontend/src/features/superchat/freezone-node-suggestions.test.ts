// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";
import type { AssetBoardData, AssetBoardItem } from "@/features/canvas/domain/assetBoard";
import {
  appendFreezoneNodeMentions,
  buildFreezoneNodeMentionLookup,
  buildFreezoneNodePreviewInfo,
  buildFreezoneNodeSuggestions,
  filterFreezoneNodeSuggestions,
  freezoneNodeMentionIds,
  freezoneNodeMentionText,
  getFreezoneNodeAtQuery,
  insertFreezoneNodeMention,
  parseFreezoneNodeMentions,
  sanitizeFreezoneNodeLabel,
  stripFreezoneNodeAtQuery,
} from "./freezone-node-suggestions";

function item(partial: Partial<AssetBoardItem> & Pick<AssetBoardItem, "nodeId" | "column" | "title">): AssetBoardItem {
  return {
    mediaUrl: null,
    thumbnailUrl: null,
    textPreview: null,
    model: null,
    durationSec: null,
    widthPx: null,
    heightPx: null,
    videoRole: null,
    references: [],
    timestamp: null,
    isGenerating: false,
    generationStartedAt: null,
    generationError: null,
    keyElementCategory: null,
    ...partial,
  };
}

const board: AssetBoardData = {
  text: [item({ nodeId: "t1", column: "text", title: "Storyboard" })],
  image: [item({ nodeId: "i1", column: "image", title: "Multi-angle", thumbnailUrl: "https://x/i1.jpg" })],
  video: [item({ nodeId: "v1", column: "video", title: "Video node 5", mediaUrl: "https://x/v1.mp4" })],
  audio: [item({ nodeId: "a1", column: "audio", title: "Background music" })],
};

describe("getFreezoneNodeAtQuery", () => {
  it("returns empty string right after typing @", () => {
    expect(getFreezoneNodeAtQuery("@")).toBe("");
  });
  it("returns the query at end of string", () => {
    expect(getFreezoneNodeAtQuery("help @multi")).toBe("multi");
  });
  it("returns query when @ is at the very start", () => {
    expect(getFreezoneNodeAtQuery("@multi")).toBe("multi");
  });
  it("does NOT match @ glued to a preceding non-space char (email-safe)", () => {
    expect(getFreezoneNodeAtQuery("a@b.com")).toBeNull();
    expect(getFreezoneNodeAtQuery("help me@multi")).toBeNull();
  });
  it("closes (null) once a space follows the query", () => {
    expect(getFreezoneNodeAtQuery("@multi ")).toBeNull();
  });
  it("with multiple @ tokens, only the trailing one counts", () => {
    // The first @alice is followed by whitespace + non-@ text ("said "); only the second @multi is the token touching the end of the string;
    // The regex is anchored with $; scanning left to right only the whitespace before the second @ can match through to the end, hence "multi".
    expect(getFreezoneNodeAtQuery("@alice said @multi")).toBe("multi");
  });
});

describe("buildFreezoneNodeSuggestions", () => {
  it("flattens board in text→image→video→audio order with mapped fields", () => {
    const result = buildFreezoneNodeSuggestions(board);
    expect(result.map((r) => r.nodeId)).toEqual(["t1", "i1", "v1", "a1"]);
    expect(result[1]).toEqual({
      nodeId: "i1",
      column: "image",
      title: "Multi-angle",
      thumbnailUrl: "https://x/i1.jpg",
      mediaUrl: null,
      keyElementCategory: null,
    });
  });

  it("floats key-element nodes to the top, ordered by category (character→scene→object→other)", () => {
    // Key elements are scattered across columns and marked out of order; expect them pinned in category order, with unmarked ones keeping column order at the bottom.
    const tagged: AssetBoardData = {
      text: [
        item({ nodeId: "t-scene", column: "text", title: "Scene card", keyElementCategory: "scene" }),
        item({ nodeId: "t-plain", column: "text", title: "Plain text" }),
      ],
      image: [item({ nodeId: "i-other", column: "image", title: "Other image", keyElementCategory: "other" })],
      video: [item({ nodeId: "v-char", column: "video", title: "Hero video", keyElementCategory: "character" })],
      audio: [item({ nodeId: "a-plain", column: "audio", title: "Score" })],
    };
    const result = buildFreezoneNodeSuggestions(tagged);
    expect(result.map((r) => r.nodeId)).toEqual(["v-char", "t-scene", "i-other", "t-plain", "a-plain"]);
  });

  it("keeps column order stable among nodes sharing the same category", () => {
    // No reordering within the same category: stable by flattened column order (text > image > video > audio).
    const sameCategory: AssetBoardData = {
      text: [item({ nodeId: "t-char", column: "text", title: "Character text", keyElementCategory: "character" })],
      image: [item({ nodeId: "i-char", column: "image", title: "Character image", keyElementCategory: "character" })],
      video: [],
      audio: [],
    };
    const result = buildFreezoneNodeSuggestions(sameCategory);
    expect(result.map((r) => r.nodeId)).toEqual(["t-char", "i-char"]);
  });
});

describe("filterFreezoneNodeSuggestions", () => {
  it("returns all items for empty query", () => {
    const all = buildFreezoneNodeSuggestions(board);
    expect(filterFreezoneNodeSuggestions(all, "")).toHaveLength(4);
  });
  it("filters by case-insensitive title substring", () => {
    const all = buildFreezoneNodeSuggestions(board);
    expect(filterFreezoneNodeSuggestions(all, "multi").map((r) => r.nodeId)).toEqual(["i1"]);
  });
});

describe("stripFreezoneNodeAtQuery", () => {
  it("removes a leading @token entirely", () => {
    expect(stripFreezoneNodeAtQuery("@multi")).toBe("");
  });
  it("keeps preceding text and its space", () => {
    expect(stripFreezoneNodeAtQuery("help @multi")).toBe("help ");
  });
  it("leaves text without an @token unchanged", () => {
    expect(stripFreezoneNodeAtQuery("help me merge videos")).toBe("help me merge videos");
  });
});

describe("sanitizeFreezoneNodeLabel", () => {
  it("strips bracket/paren/newline chars and collapses whitespace", () => {
    expect(sanitizeFreezoneNodeLabel("Image[Node](50)\nmulti")).toBe("Image Node 50 multi");
  });
  it("trims and returns empty string for whitespace-only", () => {
    expect(sanitizeFreezoneNodeLabel("   ")).toBe("");
  });
});

describe("insertFreezoneNodeMention", () => {
  it("replaces the trailing @query with a @[label](nodeId) token + trailing space", () => {
    expect(insertFreezoneNodeMention("help me with @multi", "node50", "Image node 50")).toBe(
      "help me with @[Image node 50](node50) ",
    );
  });
  it("replaces a leading @query", () => {
    expect(insertFreezoneNodeMention("@", "n1", "Storyboard")).toBe("@[Storyboard](n1) ");
  });
  it("sanitizes the label before embedding", () => {
    expect(insertFreezoneNodeMention("@x", "n1", "Name (with parens)")).toBe("@[Name with parens](n1) ");
  });
  it("falls back to nodeId when label sanitizes to empty", () => {
    expect(insertFreezoneNodeMention("@x", "n1", "()")).toBe("@[n1](n1) ");
  });
  it("appends with a leading space when there is no active @query", () => {
    expect(insertFreezoneNodeMention("Existing text", "n1", "Name")).toBe("Existing text @[Name](n1) ");
  });
});

describe("parseFreezoneNodeMentions", () => {
  it("parses multiple tokens with correct nodeId/label/positions", () => {
    const value = "See @[Image node 50](node50) and @[Storyboard](t1) compare";
    const parsed = parseFreezoneNodeMentions(value);
    expect(parsed.map((m) => m.nodeId)).toEqual(["node50", "t1"]);
    expect(parsed.map((m) => m.label)).toEqual(["Image node 50", "Storyboard"]);
    expect(value.slice(parsed[0].start, parsed[0].end)).toBe("@[Image node 50](node50)");
  });
  it("returns empty for text without a node token", () => {
    expect(parseFreezoneNodeMentions("Plain text @multi")).toEqual([]);
  });
});

describe("freezoneNodeMentionIds", () => {
  it("collects nodeIds deduped and order-preserving", () => {
    expect(freezoneNodeMentionIds("@[A](n1) @[B](n2) again @[A2](n1)")).toEqual(["n1", "n2"]);
  });
});

describe("freezoneNodeMentionText", () => {
  it("rewrites @[label](id) tokens to readable [label] and keeps the rest", () => {
    expect(freezoneNodeMentionText("help me with @[Image node 50](node50) generate a kitten on it")).toBe(
      "help me with [Image node 50] generate a kitten on it",
    );
  });
  it("keeps leading whitespace before a token", () => {
    expect(freezoneNodeMentionText("a @[X](n1) b")).toBe("a [X] b");
  });
  it("leaves text without tokens unchanged", () => {
    expect(freezoneNodeMentionText("Text without references")).toBe("Text without references");
  });
});

describe("buildFreezoneNodeMentionLookup", () => {
  it("maps nodeId to thumbnail/media/column", () => {
    const lookup = buildFreezoneNodeMentionLookup(buildFreezoneNodeSuggestions(board));
    expect(lookup.get("i1")).toEqual({
      thumbnailUrl: "https://x/i1.jpg",
      mediaUrl: null,
      column: "image",
    });
  });

  it("carries a video's mediaUrl for first-frame fallback when it has no poster thumbnail", () => {
    const lookup = buildFreezoneNodeMentionLookup(buildFreezoneNodeSuggestions(board));
    expect(lookup.get("v1")).toEqual({
      thumbnailUrl: null,
      mediaUrl: "https://x/v1.mp4",
      column: "video",
    });
  });
});

describe("appendFreezoneNodeMentions", () => {
  const titles = new Map([
    ["node50", "Image node 50"],
    ["t1", "Storyboard"],
  ]);

  it("appends a single mention resolving its title from the lookup", () => {
    expect(appendFreezoneNodeMentions("Handle this", ["node50"], titles)).toBe(
      "Handle this @[Image node 50](node50) ",
    );
  });

  it("appends multiple ids in order", () => {
    expect(appendFreezoneNodeMentions("See", ["node50", "t1"], titles)).toBe(
      "See @[Image node 50](node50) @[Storyboard](t1) ",
    );
  });

  it("skips ids missing from the lookup (node not on canvas)", () => {
    expect(appendFreezoneNodeMentions("draft", ["ghost"], titles)).toBe("draft");
  });

  it("skips ids already mentioned in the draft", () => {
    expect(appendFreezoneNodeMentions("Existing @[Storyboard](t1) ", ["t1"], titles)).toBe(
      "Existing @[Storyboard](t1) ",
    );
  });

  it("dedupes repeated ids within the same batch", () => {
    expect(appendFreezoneNodeMentions("", ["t1", "t1"], titles)).toBe("@[Storyboard](t1) ");
  });

  it("leaves the draft unchanged for an empty batch", () => {
    expect(appendFreezoneNodeMentions("As is", [], titles)).toBe("As is");
  });
});

describe("buildFreezoneNodePreviewInfo", () => {
  it("keeps the thumbnail and maps image column to Image", () => {
    expect(
      buildFreezoneNodePreviewInfo("Multi-angle", { thumbnailUrl: "https://x/i1.jpg", mediaUrl: null, column: "image" }),
    ).toEqual({
      label: "Multi-angle",
      thumbnailUrl: "https://x/i1.jpg",
      videoPosterUrl: null,
      typeLabel: "Image",
    });
  });

  it("prefers a video's poster thumbnail (no first-frame fallback needed)", () => {
    expect(
      buildFreezoneNodePreviewInfo("Clip 5", {
        thumbnailUrl: "https://x/v1.jpg",
        mediaUrl: "https://x/v1.mp4",
        column: "video",
      }),
    ).toEqual({
      label: "Clip 5",
      thumbnailUrl: "https://x/v1.jpg",
      videoPosterUrl: null,
      typeLabel: "Video",
    });
  });

  it("falls back to the video mediaUrl for a first-frame poster when it has no thumbnail", () => {
    expect(
      buildFreezoneNodePreviewInfo("Video without cover", { thumbnailUrl: null, mediaUrl: "https://x/v1.mp4", column: "video" }),
    ).toEqual({
      label: "Video without cover",
      thumbnailUrl: null,
      videoPosterUrl: "https://x/v1.mp4",
      typeLabel: "Video",
    });
  });

  it("does NOT use mediaUrl as a poster for non-video columns (audio has a media url too)", () => {
    // Audio also has a mediaUrl, but the preview must not use it as a <video> first frame; only the video column gets the first-frame fallback.
    expect(
      buildFreezoneNodePreviewInfo("Score", { thumbnailUrl: null, mediaUrl: "https://x/bg.mp3", column: "audio" }),
    ).toEqual({
      label: "Score",
      thumbnailUrl: null,
      videoPosterUrl: null,
      typeLabel: "Audio",
    });
  });

  it("has no thumbnail for text nodes but still labels the type", () => {
    expect(buildFreezoneNodePreviewInfo("Storyboard", { thumbnailUrl: null, mediaUrl: null, column: "text" })).toEqual({
      label: "Storyboard",
      thumbnailUrl: null,
      videoPosterUrl: null,
      typeLabel: "Text",
    });
  });

  it("falls back to Reference when the node is no longer on canvas (meta missing)", () => {
    expect(buildFreezoneNodePreviewInfo("Old reference", null)).toEqual({
      label: "Old reference",
      thumbnailUrl: null,
      videoPosterUrl: null,
      typeLabel: "Reference",
    });
  });
});
