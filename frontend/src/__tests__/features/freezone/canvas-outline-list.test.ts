// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
  type CanvasNodeType,
} from "@/features/canvas/domain/canvasNodes";
import {
  buildCanvasOutline,
  CANVAS_OUTLINE_FILTERS,
  canvasOutlineSignature,
  collectOutlineDownloads,
  collectOutlineGroupIds,
  collectOutlineIds,
  countOutlineNodes,
  filterCanvasOutline,
  matchesOutlineQuery,
  outlineFilterTypes,
} from "@/features/freezone/CanvasOutlineList";
import {
  DEFAULT_NODE_DISPLAY_NAME,
  EXPORT_RESULT_DISPLAY_NAME,
} from "@/features/canvas/domain/nodeDisplay";

// The outline's default names now go through i18n. Here the key is resolved back to the English canonical default, so the assertions below are still written against
// the copy users can see rather than the key.
const t = ((key: string) => {
  const nodeType = key.replace("node.displayName.", "");
  if (nodeType !== key) {
    return DEFAULT_NODE_DISPLAY_NAME[nodeType as keyof typeof DEFAULT_NODE_DISPLAY_NAME];
  }
  const resultKind = key.replace("node.exportResult.", "");
  if (resultKind !== key) {
    return EXPORT_RESULT_DISPLAY_NAME[resultKind as keyof typeof EXPORT_RESULT_DISPLAY_NAME];
  }
  return key;
}) as unknown as TFunction;

function node(
  id: string,
  type: CanvasNode["type"],
  data: Record<string, unknown> = {},
  parentId?: string,
): CanvasNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data,
    ...(parentId ? { parentId } : {}),
  } as CanvasNode;
}

describe("buildCanvasOutline", () => {
  it("keeps ungrouped nodes at the top level in store order", () => {
    const outline = buildCanvasOutline([
      node("a", CANVAS_NODE_TYPES.imageGen, { displayName: "Cover" }),
      node("b", CANVAS_NODE_TYPES.video, {}),
    ], t);

    expect(outline.map((item) => [item.id, item.kind, item.name])).toEqual([
      ["a", "node", "Cover"],
      ["b", "node", "Video"],
    ]);
  });

  it("turns a group node into a folder named after the group", () => {
    const outline = buildCanvasOutline([
      node("g", CANVAS_NODE_TYPES.group, { label: "Su Luan" }),
      node("m1", CANVAS_NODE_TYPES.imageGen, { displayName: "Portrait" }, "g"),
      node("m2", CANVAS_NODE_TYPES.video, {}, "g"),
      node("loose", CANVAS_NODE_TYPES.audio, {}),
    ], t);

    expect(outline).toHaveLength(2);
    expect(outline[0]).toMatchObject({ id: "g", kind: "group", name: "Su Luan" });
    expect(outline[0].children.map((child) => child.id)).toEqual(["m1", "m2"]);
    expect(outline[1]).toMatchObject({ id: "loose", kind: "node" });
  });

  it("prefers displayName over the legacy group label", () => {
    const outline = buildCanvasOutline([
      node("g", CANVAS_NODE_TYPES.group, { label: "Old name", displayName: "New name" }),
    ], t);

    expect(outline[0].name).toBe("New name");
  });

  it("nests groups inside groups", () => {
    const outline = buildCanvasOutline([
      node("outer", CANVAS_NODE_TYPES.group, { label: "Outer" }),
      node("inner", CANVAS_NODE_TYPES.group, { label: "Inner" }, "outer"),
      node("leaf", CANVAS_NODE_TYPES.imageGen, {}, "inner"),
    ], t);

    expect(outline).toHaveLength(1);
    expect(outline[0].children[0]).toMatchObject({ id: "inner", kind: "group" });
    expect(outline[0].children[0].children.map((child) => child.id)).toEqual(["leaf"]);
    expect(countOutlineNodes(outline)).toBe(1);
  });

  it("keeps nodes whose parent is missing or is not a group", () => {
    const outline = buildCanvasOutline([
      node("orphan", CANVAS_NODE_TYPES.imageGen, {}, "gone"),
      node("host", CANVAS_NODE_TYPES.imageGen, {}),
      node("child-of-non-group", CANVAS_NODE_TYPES.video, {}, "host"),
    ], t);

    expect(outline.map((item) => item.id)).toEqual(["orphan", "host", "child-of-non-group"]);
  });

  it("picks up the node image as its thumbnail", () => {
    const outline = buildCanvasOutline([
      node("a", CANVAS_NODE_TYPES.exportImage, { imageUrl: "https://cdn/a.png" }),
      node("b", CANVAS_NODE_TYPES.video, { previewImageUrl: "https://cdn/b.jpg" }),
      node("c", CANVAS_NODE_TYPES.audio, {}),
    ], t);

    expect(outline.map((item) => item.thumbUrl)).toEqual([
      "https://cdn/a.png",
      "https://cdn/b.jpg",
      null,
    ]);
  });
});

describe("collectOutlineIds", () => {
  it("lists a group before its members so clones can re-parent", () => {
    const outline = buildCanvasOutline([
      node("outer", CANVAS_NODE_TYPES.group, { label: "Outer" }),
      node("inner", CANVAS_NODE_TYPES.group, { label: "Inner" }, "outer"),
      node("leaf", CANVAS_NODE_TYPES.imageGen, {}, "inner"),
    ], t);

    expect(collectOutlineIds(outline[0])).toEqual(["outer", "inner", "leaf"]);
  });
});

describe("collectOutlineDownloads", () => {
  it("collects every descendant that actually has media", () => {
    const outline = buildCanvasOutline([
      node("g", CANVAS_NODE_TYPES.group, { label: "Folder" }),
      node("img", CANVAS_NODE_TYPES.exportImage, { imageUrl: "https://cdn/a.png" }, "g"),
      node("mute", CANVAS_NODE_TYPES.audio, {}, "g"),
      node("clip", CANVAS_NODE_TYPES.video, { videoUrl: "https://cdn/c.mp4" }, "g"),
    ], t);

    expect(collectOutlineDownloads(outline[0]).map((item) => [item.id, item.mediaUrl])).toEqual([
      ["img", "https://cdn/a.png"],
      ["clip", "https://cdn/c.mp4"],
    ]);
  });

  it("prefers the video/audio original over the still preview", () => {
    const outline = buildCanvasOutline([
      node("clip", CANVAS_NODE_TYPES.video, {
        videoUrl: "https://cdn/c.mp4",
        previewImageUrl: "https://cdn/c.jpg",
      }),
    ], t);

    expect(outline[0].thumbUrl).toBe("https://cdn/c.jpg");
    expect(outline[0].mediaUrl).toBe("https://cdn/c.mp4");
  });

  // In the nodes below, the original and the cover image exist together, and the original is not named videoUrl. An implementation that recognizes fields by itself would
  // download the cover as the original for the user - it must go through the global mapping resolveNodePrimaryAsset.
  it("downloading a 3D world takes the 3GS package, not the cover image", () => {
    const outline = buildCanvasOutline([
      node("world", CANVAS_NODE_TYPES.threeDWorld, {
        plyUrl: "https://cdn/scene.sog",
        previewImageUrl: "https://cdn/cover.png",
      }),
    ], t);

    expect(outline[0].thumbUrl).toBe("https://cdn/cover.png");
    expect(outline[0].mediaUrl).toBe("https://cdn/scene.sog");
  });

  it("downloading a video compose takes the final video, not the poster", () => {
    const outline = buildCanvasOutline([
      node("compose", CANVAS_NODE_TYPES.videoCompose, {
        resultVideoUrl: "https://cdn/final.mp4",
        previewImageUrl: "https://cdn/poster.jpg",
      }),
    ], t);

    expect(outline[0].thumbUrl).toBe("https://cdn/poster.jpg");
    expect(outline[0].mediaUrl).toBe("https://cdn/final.mp4");
  });

  it("a video story can still be downloaded when it only has a source clip", () => {
    const outline = buildCanvasOutline([
      node("story", CANVAS_NODE_TYPES.videoStory, {
        sourceVideoUrl: "https://cdn/source.mp4",
      }),
    ], t);

    expect(outline[0].mediaUrl).toBe("https://cdn/source.mp4");
  });

  it("the panorama viewer's sphere texture is both the thumbnail and the original", () => {
    const outline = buildCanvasOutline([
      node("pano", CANVAS_NODE_TYPES.pano360Viewer, {
        imageUrl: "https://cdn/pano.jpg",
      }),
    ], t);

    expect(outline[0].thumbUrl).toBe("https://cdn/pano.jpg");
    expect(outline[0].mediaUrl).toBe("https://cdn/pano.jpg");
  });

  it("a split node downloads the first cell instead of having no original", () => {
    const outline = buildCanvasOutline([
      node("split", CANVAS_NODE_TYPES.storyboardSplit, {
        frames: [
          { imageUrl: "https://cdn/frame-0.png" },
          { imageUrl: "https://cdn/frame-1.png" },
        ],
      }),
    ], t);

    expect(outline[0].mediaUrl).toBe("https://cdn/frame-0.png");
  });
});

describe("collectOutlineGroupIds", () => {
  it("collects nested groups but not plain nodes", () => {
    const outline = buildCanvasOutline([
      node("outer", CANVAS_NODE_TYPES.group, { label: "Outer" }),
      node("inner", CANVAS_NODE_TYPES.group, { label: "Inner" }, "outer"),
      node("leaf", CANVAS_NODE_TYPES.imageGen, {}, "inner"),
      node("loose", CANVAS_NODE_TYPES.audio, {}),
    ], t);

    expect(collectOutlineGroupIds(outline)).toEqual(["outer", "inner"]);
  });
});

describe("CANVAS_OUTLINE_FILTERS", () => {
  it("covers every node type exactly once, groups excluded", () => {
    const seen = new Set<CanvasNodeType>();
    for (const filter of CANVAS_OUTLINE_FILTERS) {
      for (const type of filter.types) {
        expect(seen.has(type)).toBe(false);
        seen.add(type);
      }
    }

    const expected = Object.values(CANVAS_NODE_TYPES).filter(
      (type) => type !== CANVAS_NODE_TYPES.group,
    );
    expect([...seen].sort()).toEqual([...expected].sort());
  });

  it("maps All to an empty type list", () => {
    expect(outlineFilterTypes("all")).toEqual([]);
    expect(outlineFilterTypes("audio")).toEqual([CANVAS_NODE_TYPES.audio]);
  });
});

describe("matchesOutlineQuery", () => {
  it("matches case-insensitive substrings", () => {
    expect(matchesOutlineQuery("Image 107 - copy", "image 107")).toBe(true);
    expect(matchesOutlineQuery("Image 107 - copy", "copy")).toBe(true);
  });

  it("falls back to subsequence matching", () => {
    expect(matchesOutlineQuery("Image 107 - copy", "img107")).toBe(true);
    expect(matchesOutlineQuery("Image 107 - copy", "img701")).toBe(false);
  });

  it("rejects subsequences scattered across a long prompt name", () => {
    const prompt = `Wolf${",".repeat(60)}ear`;
    expect(matchesOutlineQuery(prompt, "wr")).toBe(false);
    expect(matchesOutlineQuery("wr-ap", "wr")).toBe(true);
  });

  it("treats an empty query as a match", () => {
    expect(matchesOutlineQuery("anything", "   ")).toBe(true);
  });
});

describe("filterCanvasOutline", () => {
  const outline = buildCanvasOutline([
    node("g", CANVAS_NODE_TYPES.group, { label: "Su Luan" }),
    node("m1", CANVAS_NODE_TYPES.imageGen, { displayName: "Portrait" }, "g"),
    node("m2", CANVAS_NODE_TYPES.video, { displayName: "Entrance shot" }, "g"),
    node("loose", CANVAS_NODE_TYPES.audio, { displayName: "Score" }),
  ], t);

  it("returns the same array when nothing is filtered", () => {
    expect(filterCanvasOutline(outline, { query: "  ", types: [] })).toBe(outline);
  });

  it("keeps a group but only the members that match", () => {
    const result = filterCanvasOutline(outline, {
      query: "",
      types: outlineFilterTypes("video"),
    });

    expect(result.map((item) => item.id)).toEqual(["g"]);
    expect(result[0].children.map((child) => child.id)).toEqual(["m2"]);
  });

  it("drops groups whose members all miss", () => {
    const result = filterCanvasOutline(outline, {
      query: "",
      types: outlineFilterTypes("audio"),
    });

    expect(result.map((item) => item.id)).toEqual(["loose"]);
  });

  it("keeps the whole group when the group name itself matches", () => {
    const result = filterCanvasOutline(outline, { query: "Su Luan", types: [] });

    expect(result.map((item) => item.id)).toEqual(["g"]);
    expect(result[0].children.map((child) => child.id)).toEqual(["m1", "m2"]);
  });

  it("combines the type filter with the query", () => {
    expect(
      filterCanvasOutline(outline, { query: "Portrait", types: outlineFilterTypes("image") }).flatMap(
        (item) => item.children.map((child) => child.id),
      ),
    ).toEqual(["m1"]);
    // A group name hit must not bypass the type filter, otherwise filtering "Image" would also bring along the whole group's videos
    expect(filterCanvasOutline(outline, { query: "Su Luan", types: outlineFilterTypes("video") })).toEqual(
      [],
    );
  });
});

describe("canvasOutlineSignature", () => {
  it("ignores position changes", () => {
    const before = [node("a", CANVAS_NODE_TYPES.imageGen, { displayName: "Cover" })];
    const after = [
      { ...before[0], position: { x: 999, y: -42 } } as CanvasNode,
    ];

    expect(canvasOutlineSignature(after)).toBe(canvasOutlineSignature(before));
  });

  it("changes when a node is renamed, regrouped, added or re-imaged", () => {
    const base = [
      node("g", CANVAS_NODE_TYPES.group, { label: "Folder" }),
      node("a", CANVAS_NODE_TYPES.exportImage, { displayName: "Cover", imageUrl: "u1" }),
    ];
    const signature = canvasOutlineSignature(base);

    expect(
      canvasOutlineSignature([
        base[0],
        node("a", CANVAS_NODE_TYPES.exportImage, { displayName: "Renamed", imageUrl: "u1" }),
      ]),
    ).not.toBe(signature);
    expect(
      canvasOutlineSignature([
        base[0],
        node("a", CANVAS_NODE_TYPES.exportImage, { displayName: "Cover", imageUrl: "u1" }, "g"),
      ]),
    ).not.toBe(signature);
    expect(
      canvasOutlineSignature([
        base[0],
        node("a", CANVAS_NODE_TYPES.exportImage, { displayName: "Cover", imageUrl: "u2" }),
      ]),
    ).not.toBe(signature);
    expect(canvasOutlineSignature([...base, node("b", CANVAS_NODE_TYPES.audio)])).not.toBe(
      signature,
    );
  });
});

describe("outline meta", () => {
  // The time is only visible while "spinning" and disappears once finished, which is the pitfall this row most easily regresses into:
  // generationStartedAt is written back to null on both the success and failure branches of every generation chain,
  // so the two cases below pin down "what is read must be the persistent field", not "a time can be shown".
  const CREATED_AT = new Date(2026, 7, 20, 14, 32).getTime(); // 08-20 14:32

  function metaOf(data: Record<string, unknown>): string | null {
    const [item] = buildCanvasOutline([node("a", CANVAS_NODE_TYPES.video, data)], t);
    return item.kind === "node" ? item.meta : null;
  }

  it("keeps the stamp after generation finishes", () => {
    // What it looks like after generation finishes: isGenerating falls back to false, and generationStartedAt is cleared to null.
    expect(
      metaOf({
        displayName: "Seaside dusk",
        createdAt: CREATED_AT,
        isGenerating: false,
        generationStartedAt: null,
      }),
    ).toContain("08-20 14:32");
  });

  it("does not fall back to the transient generationStartedAt", () => {
    // Nodes in old canvases have no createdAt. Better not to show anything than to show a value that is about to evaporate.
    const meta = metaOf({
      displayName: "Seaside dusk",
      isGenerating: true,
      generationStartedAt: CREATED_AT,
    });

    expect(meta).not.toContain("14:32");
  });

  it("separates same-named siblings by their own creation moment", () => {
    // The same prompt generated three times: name and type are identical, and only the time can tell them apart.
    const outline = buildCanvasOutline([
      node("a", CANVAS_NODE_TYPES.video, { displayName: "Seaside dusk", createdAt: CREATED_AT }),
      node("b", CANVAS_NODE_TYPES.video, {
        displayName: "Seaside dusk",
        createdAt: CREATED_AT + 5 * 60_000,
      }),
    ], t);
    const metas = outline.map((item) => (item.kind === "node" ? item.meta : null));

    expect(metas[0]).not.toBe(metas[1]);
    expect(metas[0]).toContain("14:32");
    expect(metas[1]).toContain("14:37");
  });
});
