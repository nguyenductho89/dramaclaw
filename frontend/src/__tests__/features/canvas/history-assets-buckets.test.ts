// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { recordsToAssetBuckets } from "@/features/canvas/ui/CanvasHistoryAssetsModal";
import {
  assetMatchesQuery,
  filterAssetBuckets,
  type CanvasAsset,
} from "@/features/canvas/domain/canvasAssets";
import {
  historyRecordInputImageUrl,
  historyRecordPreviewImageUrl,
  historyRecordStrictWorldUrl,
} from "@/features/canvas/ui/NodeGenerationHistory";
import type { FreezoneGenerationHistoryRecord } from "@/api/ops";

function record(
  partial: Partial<FreezoneGenerationHistoryRecord>,
): FreezoneGenerationHistoryRecord {
  return {
    id: "rec-1",
    status: "completed",
    recorded_at: "2026-06-15T00:00:00Z",
    media_type: "image",
    result: {},
    ...partial,
  } as FreezoneGenerationHistoryRecord;
}

describe("historyRecordStrictWorldUrl", () => {
  it("finds a nested .sog world asset", () => {
    expect(
      historyRecordStrictWorldUrl(
        record({ result: { data: { sog_url: "/static/p/scene/pano_depth.sog" } } }),
      ),
    ).toBe("/static/p/scene/pano_depth.sog");
  });

  it("returns null for an ordinary image record (no 3GS marker)", () => {
    expect(
      historyRecordStrictWorldUrl(
        record({ result: { output_url: "/static/p/foo.png", url: "/static/p/bar.png" } }),
      ),
    ).toBeNull();
  });
});

describe("historyRecordInputImageUrl (world cover fallback)", () => {
  it("uses the input source image as a cover for a .sog world record", () => {
    const rec = record({
      result: { source_url: "/static/p/src.png", ply_url: "/static/p/world.sog" },
    });
    expect(historyRecordInputImageUrl(rec)).toBe("/static/p/src.png");
    // and it flows through the preview-image resolver too
    expect(historyRecordPreviewImageUrl(rec)).toBe("/static/p/src.png");
  });

  it("digs the input image out of a nested params container", () => {
    expect(
      historyRecordInputImageUrl(
        record({ result: { params: { image_url: "/static/p/in.jpg" } } }),
      ),
    ).toBe("/static/p/in.jpg");
  });

  it("never returns the .sog/.ply product as a cover", () => {
    expect(
      historyRecordInputImageUrl(record({ result: { url: "/static/p/world.sog" } })),
    ).toBeNull();
  });
});

describe("recordsToAssetBuckets — world history", () => {
  it("buckets a .sog record as `model` even when media_type is not 3d/ply (the bug)", () => {
    const buckets = recordsToAssetBuckets([
      record({
        id: "world-1",
        // image-to-3gs records often come back tagged `image`, not `3d`.
        media_type: "image",
        result: { ply_url: "/static/p/scene/pano_depth.sog" },
      }),
    ]);
    expect(buckets.model).toHaveLength(1);
    expect(buckets.model[0]?.url).toContain("pano_depth.sog");
    expect(buckets.image).toHaveLength(0);
  });

  it("still buckets explicit media_type 3d/ply records as `model`", () => {
    const buckets = recordsToAssetBuckets([
      record({ id: "w-3d", media_type: "3d", result: { ply_url: "/static/p/a.ply" } }),
    ]);
    expect(buckets.model).toHaveLength(1);
  });

  it("keeps ordinary image records in the image bucket", () => {
    const buckets = recordsToAssetBuckets([
      record({ id: "img-1", media_type: "image", result: { image_url: "/static/p/x.png" } }),
    ]);
    expect(buckets.image).toHaveLength(1);
    expect(buckets.model).toHaveLength(0);
  });

  it("carries the record's prompt onto image assets (drives the image prompt caption)", () => {
    const buckets = recordsToAssetBuckets([
      record({
        id: "img-2",
        media_type: "image",
        result: { image_url: "/static/p/y.png", prompt: "A cat in the rain" },
      }),
    ]);
    expect(buckets.image[0]?.prompt).toBe("A cat in the rain");
    expect(buckets.image[0]?.label).toBe("A cat in the rain");
  });

  it("falls back to the host node's cover/name when the record carries neither", () => {
    const buckets = recordsToAssetBuckets(
      [
        record({
          id: "world-2",
          node_id: "world-node",
          media_type: "3d",
          result: { ply_url: "/static/p/world.sog" },
        }),
      ],
      (nodeId) =>
        nodeId === "world-node"
          ? { cover: "/static/p/dorm.png", name: "University dorm" }
          : { cover: null, name: null },
    );
    expect(buckets.model).toHaveLength(1);
    expect(buckets.model[0]?.previewUrl).toContain("dorm.png");
    expect(buckets.model[0]?.label).toBe("University dorm");
  });

  it("prefers the record's own prompt/cover over the host-node fallback", () => {
    const buckets = recordsToAssetBuckets(
      [
        record({
          id: "world-3",
          node_id: "world-node",
          media_type: "3d",
          result: {
            ply_url: "/static/p/world.sog",
            prompt: "Prompt in the record",
            source_url: "/static/p/record-src.png",
          },
        }),
      ],
      () => ({ cover: "/static/p/dorm.png", name: "University dorm" }),
    );
    expect(buckets.model[0]?.label).toBe("Prompt in the record");
    expect(buckets.model[0]?.previewUrl).toContain("record-src.png");
  });
});

describe("recordsToAssetBuckets — model/genMode memory", () => {
  it("extracts model/gen_mode from a record into the asset", () => {
    const buckets = recordsToAssetBuckets([
      record({
        media_type: "video",
        model: "happyhouse_1_0",
        gen_mode: "firstLastFrame",
        result: { output_url: "/static/p/v.mp4" },
      }),
    ]);
    const asset = Object.values(buckets)
      .flat()
      .find((a) => a.url === "/static/p/v.mp4");
    expect(asset?.model).toBe("happyhouse_1_0");
    expect(asset?.genMode).toBe("firstLastFrame");
  });

  it("gets undefined when an old record lacks the fields", () => {
    const buckets = recordsToAssetBuckets([
      record({ media_type: "image", result: { output_url: "/static/p/i.png" } }),
    ]);
    const asset = Object.values(buckets)
      .flat()
      .find((a) => a.url === "/static/p/i.png");
    expect(asset?.model).toBeUndefined();
    expect(asset?.genMode).toBeUndefined();
  });
});

// issue #175: keyword search for history assets.
describe("assetMatchesQuery", () => {
  function asset(partial: Partial<CanvasAsset>): CanvasAsset {
    return {
      id: "a-1",
      kind: "image",
      url: "/static/p/a.png",
      previewUrl: null,
      nodeId: "node-1",
      label: null,
      prompt: null,
      timestamp: 0,
      ...partial,
    } as CanvasAsset;
  }

  it("matches a substring of the prompt", () => {
    expect(assetMatchesQuery(asset({ prompt: "A cat in the rain" }), "rain")).toBe(true);
    expect(assetMatchesQuery(asset({ prompt: "A cat in the rain" }), "dog")).toBe(false);
  });

  it("English matching is case-insensitive", () => {
    expect(assetMatchesQuery(asset({ prompt: "A Fluffy Cat" }), "fluffy")).toBe(true);
    expect(assetMatchesQuery(asset({ prompt: "a fluffy cat" }), "FLUFFY")).toBe(true);
  });

  it("also matches label (the node name a world record falls back to / the file name at pick time)", () => {
    expect(assetMatchesQuery(asset({ prompt: null, label: "University dorm" }), "dorm")).toBe(
      true,
    );
  });

  it("an asset with both prompt and label empty (audio / old record) is dropped when there is a query", () => {
    expect(assetMatchesQuery(asset({ prompt: null, label: null }), "cat")).toBe(false);
  });

  it("an empty query matches everything", () => {
    expect(assetMatchesQuery(asset({ prompt: null, label: null }), "")).toBe(true);
  });

  it("does not stitch a false match across the prompt/label boundary", () => {
    // Per-field matching: the end of prompt + the start of label must not be stitched into one match.
    expect(assetMatchesQuery(asset({ prompt: "kitten", label: "fishbowl" }), "tenfi")).toBe(
      false,
    );
  });

  it("a live-canvas asset (prompt is always undefined) can still be found by label", () => {
    // extractCanvasAssets never writes prompt, only label (node name / file name).
    const live = asset({ prompt: undefined, label: "storyboard01.png" });
    expect(assetMatchesQuery(live, "storyboard")).toBe(true);
    expect(assetMatchesQuery(live, "png")).toBe(true);
  });

  it("leading and trailing spaces do not affect matching", () => {
    expect(assetMatchesQuery(asset({ prompt: "A kitten" }), "  kitten  ")).toBe(true);
  });

  it("a whitespace-only query counts as empty and matches everything", () => {
    expect(assetMatchesQuery(asset({ prompt: null, label: null }), "   ")).toBe(true);
  });
});

describe("filterAssetBuckets", () => {
  const buckets = recordsToAssetBuckets([
    record({
      id: "i-1",
      media_type: "image",
      result: { image_url: "/static/p/cat.png", prompt: "A cute kitten" },
    }),
    record({
      id: "i-2",
      media_type: "image",
      result: { image_url: "/static/p/dog.png", prompt: "A dog running" },
    }),
    record({
      id: "v-1",
      media_type: "video",
      result: { output_url: "/static/p/cat.mp4", prompt: "A kitten eating fish" },
    }),
  ]);

  it("cross-bucket filtering: each tab's count keeps only matching items", () => {
    const filtered = filterAssetBuckets(buckets, "kitten");
    expect(filtered.image.map((a) => a.id)).toEqual(["i-1"]);
    expect(filtered.video.map((a) => a.id)).toEqual(["v-1"]);
    expect(filtered.audio).toHaveLength(0);
    expect(filtered.model).toHaveLength(0);
  });

  it("all four buckets are empty when nothing matches", () => {
    const filtered = filterAssetBuckets(buckets, "a keyword that does not exist");
    expect(Object.values(filtered).flat()).toHaveLength(0);
  });

  it("an empty query returns the same object as-is (stable reference, no downstream recompute)", () => {
    expect(filterAssetBuckets(buckets, "")).toBe(buckets);
  });
});
