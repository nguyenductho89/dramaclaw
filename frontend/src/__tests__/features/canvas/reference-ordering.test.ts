// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  orderedReferenceUrlsWithOwnFirst,
  sortUpstreamByReferenceOrder,
  upstreamNodesInEdgeOrder,
} from "@/features/canvas/nodes/referenceOrdering";

type Node = { id: string; position?: { y?: number } };

const ids = (nodes: Node[]) => nodes.map((node) => node.id);

describe("sortUpstreamByReferenceOrder", () => {
  it("keeps newly connected nodes in connection order, ignoring canvas y position", () => {
    // Regression case: the old image (red, referenced first, at y=900 below on the canvas) should sort before the new image (grid, referenced later,
    // at y=0 above on the canvas). Sorting by y once wrongly put the upper new image in position 1.
    const connectionOrder: Node[] = [
      { id: "red", position: { y: 900 } },
      { id: "grid", position: { y: 0 } },
    ];

    const sorted = sortUpstreamByReferenceOrder(connectionOrder, undefined);

    expect(ids(sorted)).toEqual(["red", "grid"]);
  });

  it("honors an explicit manual referenceOrder over connection order", () => {
    const connectionOrder: Node[] = [
      { id: "a", position: { y: 0 } },
      { id: "b", position: { y: 100 } },
      { id: "c", position: { y: 200 } },
    ];

    const sorted = sortUpstreamByReferenceOrder(connectionOrder, ["c", "a", "b"]);

    expect(ids(sorted)).toEqual(["c", "a", "b"]);
  });

  it("places manually-ordered nodes first, then unordered ones in connection order", () => {
    // b was manually dragged to the first position; a and the later-connected c, d are not in referenceOrder,
    // and should follow b in connection order (input array order).
    const connectionOrder: Node[] = [
      { id: "a", position: { y: 50 } },
      { id: "b", position: { y: 999 } },
      { id: "c", position: { y: 10 } },
      { id: "d", position: { y: 5 } },
    ];

    const sorted = sortUpstreamByReferenceOrder(connectionOrder, ["b"]);

    expect(ids(sorted)).toEqual(["b", "a", "c", "d"]);
  });

  it("does not mutate the input array", () => {
    const input: Node[] = [
      { id: "x", position: { y: 1 } },
      { id: "y", position: { y: 0 } },
    ];

    sortUpstreamByReferenceOrder(input, undefined);

    expect(ids(input)).toEqual(["x", "y"]);
  });
});

describe("upstreamNodesInEdgeOrder", () => {
  it("returns upstream nodes in edge-connection order, not nodes-array order", () => {
    // Regression case: @imageN numbering follows connection order (useUpstreamNodes), while submission once collected in nodes array
    // order — a gen node created first but connected later was wrongly ordered to references[0], making
    // @image1 in the prompt point to another image on the backend. Both sides must go through the same function.
    const nodes: Node[] = [
      { id: "gen" }, // created earliest (position 1 of the nodes array), but connected last
      { id: "upload-a" },
      { id: "upload-b" },
    ];
    const edges = [
      { source: "upload-a", target: "video" },
      { source: "upload-b", target: "video" },
      { source: "gen", target: "video" },
    ];

    const upstream = upstreamNodesInEdgeOrder(nodes, edges, "video");

    expect(ids(upstream)).toEqual(["upload-a", "upload-b", "gen"]);
  });

  it("ignores edges targeting other nodes and edges with missing source nodes", () => {
    const nodes: Node[] = [{ id: "a" }, { id: "b" }];
    const edges = [
      { source: "a", target: "video" },
      { source: "b", target: "other" },
      { source: "ghost", target: "video" },
    ];

    const upstream = upstreamNodesInEdgeOrder(nodes, edges, "video");

    expect(ids(upstream)).toEqual(["a"]);
  });

  it("excludes execution-only dependency edges from consumable upstream inputs", () => {
    const nodes: Node[] = [{ id: "outline" }, { id: "anchor" }];
    const edges = [
      {
        source: "outline",
        target: "image",
        data: { link_type: "dependency_for" },
      },
      {
        source: "anchor",
        target: "image",
        data: { link_type: "media_input_for" },
      },
    ];

    const upstream = upstreamNodesInEdgeOrder(nodes, edges, "image");

    expect(ids(upstream)).toEqual(["anchor"]);
  });
});

describe("orderedReferenceUrlsWithOwnFirst", () => {
  it("puts the node's own reference image first, upstream images after", () => {
    // Regression case: when an image node carries its own reference image, it is the 1st one submitted to the backend — the @imageN
    // numbering must count it as image1 too, otherwise all @imageN in the prompt shift by 1 on the backend.
    expect(
      orderedReferenceUrlsWithOwnFirst("own.png", ["a.png", "b.png"]),
    ).toEqual(["own.png", "a.png", "b.png"]);
  });

  it("returns upstream urls unchanged when there is no own reference image", () => {
    expect(orderedReferenceUrlsWithOwnFirst(null, ["a.png", "b.png"])).toEqual([
      "a.png",
      "b.png",
    ]);
  });

  it("dedupes an upstream url that equals the own reference image, keeping the front slot", () => {
    expect(
      orderedReferenceUrlsWithOwnFirst("a.png", ["a.png", "b.png"]),
    ).toEqual(["a.png", "b.png"]);
  });
});
