// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// When a node body image may be fed a downscaled copy. The rule itself is short, but it protects two things that easily break together:
// the resolution badge / auto size must read the original image size, and the fullscreen viewer must receive the original image.
import { beforeEach, describe, expect, it } from "vitest";

import {
  NODE_BODY_VARIANT_MAX_EDGE,
  nodeBodyImageMeasurement,
  nodeBodyImageSrc,
  nodeBodyRequiredEdge,
  readNodeNaturalSize,
} from "@/features/canvas/application/imageData";
import { pickMediaVariant } from "@/lib/media-url";

const BIG = { width: 5504, height: 3072 };
const URL = "/static/projects/proj/freezone/_outputs/a.png";

describe("readNodeNaturalSize", () => {
  it("reads a recorded pixel size off node data", () => {
    expect(readNodeNaturalSize({ imageNaturalWidth: 5504, imageNaturalHeight: 3072 })).toEqual(BIG);
  });

  it("returns null when the record is missing, partial or nonsense", () => {
    for (const data of [
      null,
      undefined,
      7,
      "nope",
      {},
      { imageNaturalWidth: 5504 },
      { imageNaturalHeight: 3072 },
      { imageNaturalWidth: 0, imageNaturalHeight: 3072 },
      { imageNaturalWidth: -1, imageNaturalHeight: -1 },
      { imageNaturalWidth: "5504", imageNaturalHeight: "3072" },
    ]) {
      expect(readNodeNaturalSize(data)).toBeNull();
    }
  });
});

describe("nodeBodyImageSrc", () => {
  beforeEach(() => {
    window.history.pushState(null, "", "/");
  });

  it("asks only for thumb when the display fits the 320px budget", () => {
    expect(nodeBodyImageSrc(URL, BIG, { requiredEdge: 320 })).toEqual({
      src: `${URL}?st_thumb=thumb`,
      original: URL,
      downscaled: true,
      maxEdge: 320,
    });
  });

  // This load also carries the "measurement" duty: reading naturalWidth from a downscaled copy would write the wrong size
  // into the node data. When the size is unknown the original must be used, and once the measurement is persisted the next mount naturally uses the variant.
  it("stays on the original while the real size is still unknown", () => {
    expect(nodeBodyImageSrc(URL, null)).toEqual({
      src: URL,
      original: URL,
      downscaled: false,
      maxEdge: null,
    });
  });

  it("stays on the original when the source is not bigger than the variant", () => {
    const edge = NODE_BODY_VARIANT_MAX_EDGE;
    for (const natural of [
      { width: edge, height: edge },
      { width: edge, height: 100 },
      { width: 100, height: edge },
    ]) {
      expect(nodeBodyImageSrc(URL, natural)).toEqual({
        src: URL,
        original: URL,
        downscaled: false,
        maxEdge: null,
      });
    }
    expect(nodeBodyImageSrc(URL, { width: edge + 1, height: 100 }).downscaled).toBe(true);
  });

  // At the close-inspection zoom level the node is wider than the variant; this line is the same as the switch line between previewImageUrl/imageUrl
  // (shouldUseOriginalImageByZoom).
  it("hands back the original when the caller is zoomed in for detail", () => {
    expect(nodeBodyImageSrc(URL, BIG, { preferOriginal: true })).toEqual({
      src: URL,
      original: URL,
      downscaled: false,
      maxEdge: null,
    });
  });

  it("keeps an existing cache-bust token", () => {
    expect(nodeBodyImageSrc(`${URL}?st_v=17`, BIG, { requiredEdge: 320 }).src).toBe(
      `${URL}?st_v=17&st_thumb=thumb`,
    );
  });

  it("reports downscaled:false whenever the variant cannot apply", () => {
    for (const url of [
      "blob:http://localhost/abcd",
      "data:image/png;base64,AAAA",
      "/static/style-examples/demo.png",
      "/static/projects/proj/videos/clip.mp4",
    ]) {
      const result = nodeBodyImageSrc(url, BIG);
      expect(result).toEqual({ src: url, original: url, downscaled: false, maxEdge: null });
    }
  });
});

// The size in the record is not bound to any URL, while a node's image can be swapped (picking the main image in an album, restoring from history,
// a generation finishing and backfilling), and nobody clears imageNaturalWidth/Height when it is swapped. If the record were still
// trusted unconditionally, the measurement would be permanently poisoned: the element reports the new image's real size, yet we write back by the old record,
// and the written-back ratio happens to equal data.aspectRatio, so the update branch is skipped and it never
// self-heals. Before the change the element itself was the source of truth, so this scene did not exist.
describe("nodeBodyImageMeasurement must not trust the record when it does not match", () => {
  const RECORD = { width: 5504, height: 3072 };
  const downscaled = { src: "x", original: "x", downscaled: true, maxEdge: 1280 };

  it("a faithfully downscaled copy: the long edge sits exactly on the budget, measure by the record", () => {
    // 5504x3072 -> card(1280) = 1280x714
    expect(nodeBodyImageMeasurement({ naturalWidth: 1280, naturalHeight: 714 }, downscaled, RECORD))
      .toEqual(RECORD);
  });

  it("swapped to a smaller square image: the element is only 1024, so the record cannot describe it", () => {
    expect(
      nodeBodyImageMeasurement({ naturalWidth: 1024, naturalHeight: 1024 }, downscaled, RECORD),
    ).toEqual({ width: 1024, height: 1024 });
  });

  it("swapped to an equally large image with a different ratio: the long edge matches, the short edge does not", () => {
    // 2000x2000 -> card = 1280x1280, while by the record's ratio the short edge should be 714.
    expect(
      nodeBodyImageMeasurement({ naturalWidth: 1280, naturalHeight: 1280 }, downscaled, RECORD),
    ).toEqual({ width: 1280, height: 1280 });
  });

  // A blind spot, noted here so nobody next time thinks it can catch an image swap: the copy's long edge is pinned to the budget, and how big
  // the original is gets lost at downscale time, so another image of the same ratio looks perfectly compliant. What really blocks
  // this scene is distrusting the record the moment the image is swapped (useNaturalSizeRecordTrust); this only covers
  // old data that was already stored skewed at mount time.
  it("a same-ratio swap is undetectable: a 2752x1536 copy is pixel-identical to a 5504x3072 one", () => {
    expect(
      nodeBodyImageMeasurement({ naturalWidth: 1280, naturalHeight: 714 }, downscaled, RECORD),
    ).toEqual(RECORD);
  });

  it("swapped orientation: the direction does not match", () => {
    expect(
      nodeBodyImageMeasurement({ naturalWidth: 714, naturalHeight: 1280 }, downscaled, RECORD),
    ).toEqual({ width: 714, height: 1280 });
  });

  it("the backend refused this downscale and returned the original: the element is pixel-identical to the record and still counts as matching", () => {
    expect(
      nodeBodyImageMeasurement({ naturalWidth: 5504, naturalHeight: 3072 }, downscaled, RECORD),
    ).toEqual(RECORD);
  });
});

describe("nodeBodyImageMeasurement", () => {
  // 5504x3072 faithfully downscaled to card(1280) is 1280x714, which matches BIG.
  const element = { naturalWidth: 1280, naturalHeight: 714 };

  // The point is not to "skip measurement" but to switch the measurement source: the subsequent ratio/size/badge calculations are byte-for-byte identical to
  // feeding the original.
  it("measures from the record when the element holds a downscaled copy", () => {
    expect(
      nodeBodyImageMeasurement(element, { src: "x", original: "x", downscaled: true, maxEdge: 1280 }, BIG),
    ).toEqual(BIG);
  });

  it("measures from the element when it holds the original", () => {
    expect(
      nodeBodyImageMeasurement(element, { src: "x", original: "x", downscaled: false, maxEdge: null }, BIG),
    ).toEqual({ width: 1280, height: 714 });
  });

  // downscaled can only be true when there is a record, but even if we really get here an empty size must not be returned.
  it("falls back to the element when there is no record to trust", () => {
    expect(
      nodeBodyImageMeasurement(element, { src: "x", original: "x", downscaled: true, maxEdge: 1280 }, null),
    ).toEqual({ width: 1280, height: 714 });
  });
});

// Fixed tiers cannot stop this scene: the same 1280px copy is more than enough in a default 580 CSS px node,
// but blurry when scaled up inside a node the user stretched to 1600px; on Retina both numbers are doubled. So the tier
// must be derived backwards from "how many device pixels this slot needs".
describe("picks the tier by display size x zoom x DPR", () => {
  it("nodeBodyRequiredEdge counts all three factors and takes the long edge", () => {
    expect(nodeBodyRequiredEdge({ width: 580, height: 326 }, 1, 1)).toBe(580);
    expect(nodeBodyRequiredEdge({ width: 580, height: 326 }, 1, 2)).toBe(1160);
    expect(nodeBodyRequiredEdge({ width: 900, height: 900 }, 0.35, 2)).toBe(630);
    expect(nodeBodyRequiredEdge({ width: 326, height: 580 }, 1, 1)).toBe(580);
  });

  it("bad values fall back to 1x so no absurd tier is picked", () => {
    expect(nodeBodyRequiredEdge({ width: 580, height: 326 }, Number.NaN, 0)).toBe(580);
  });

  it("pickMediaVariant keeps only thumb and returns to the original beyond 320px", () => {
    expect(pickMediaVariant(315)).toBe("thumb");
    expect(pickMediaVariant(320)).toBe("thumb");
    expect(pickMediaVariant(321)).toBeNull();
    expect(pickMediaVariant(630)).toBeNull();
    expect(pickMediaVariant(1160)).toBeNull();
    expect(pickMediaVariant(1280)).toBeNull();
  });

  // Blurry upscaling is the only unacceptable outcome: better to pay for decoding the original than hand over a copy that must be enlarged 2.5x.
  it("returns the original when no tier covers it", () => {
    expect(pickMediaVariant(1281)).toBeNull();
    expect(pickMediaVariant(Number.POSITIVE_INFINITY)).toBeNull();
  });

  // The example from the review: an ImageNode can be stretched to 1600px, and DPR=1 / zoom=1 is already not enough.
  it("a stretched node gets the original instead of an enlarged 1280 copy", () => {
    const required = nodeBodyRequiredEdge({ width: 1600, height: 900 }, 1, 1);
    expect(nodeBodyImageSrc(URL, BIG, { requiredEdge: required })).toEqual({
      src: URL,
      original: URL,
      downscaled: false,
      maxEdge: null,
    });
  });

  it("a default-size node uses the original directly on Retina", () => {
    const required = nodeBodyRequiredEdge({ width: 580, height: 326 }, 1, 2);
    expect(nodeBodyImageSrc(URL, BIG, { requiredEdge: required }).src).toBe(URL);
  });

  it("the LOD shell only has the 1x size within the thumb budget", () => {
    const shell = { width: 900, height: 900 };
    expect(pickMediaVariant(nodeBodyRequiredEdge(shell, 0.35, 1))).toBe("thumb");
    expect(pickMediaVariant(nodeBodyRequiredEdge(shell, 0.35, 2))).toBeNull();
  });

  it("still returns the original when the picked tier is not smaller than the source", () => {
    expect(
      nodeBodyImageSrc(URL, { width: 600, height: 400 }, { requiredEdge: 630 }).downscaled,
    ).toBe(false);
  });

  it("uses only the thumb budget when requiredEdge is not passed", () => {
    expect(nodeBodyImageSrc(URL, BIG).maxEdge).toBe(NODE_BODY_VARIANT_MAX_EDGE);
    expect(nodeBodyImageSrc(URL, BIG).maxEdge).toBe(320);
  });
});
