// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  buildSeedance2LabelIdentityMaps,
  remapSeedance2Mentions,
  sameSeedance2LabelIdentity,
  type Seedance2ReferenceAssetLike,
} from "@/components/episode/beat-workbench/seedance2-mentions";

const asset = (
  reference_label: string,
  url: string,
): Seedance2ReferenceAssetLike => ({ reference_label, url, key: url });

const maps = (assets: Seedance2ReferenceAssetLike[]) =>
  buildSeedance2LabelIdentityMaps(assets);

describe("remapSeedance2Mentions", () => {
  it("renumbers a mention when an earlier asset is deleted (binds by URL)", () => {
    const prev = maps([asset("image1", "A"), asset("image2", "B")]);
    const next = maps([asset("image1", "B")]); // A removed, B becomes image1
    expect(remapSeedance2Mentions("Use @image2 at the end", prev, next)).toBe(
      "Use @image1 at the end",
    );
  });

  it("drops a mention whose asset was removed (with trailing space)", () => {
    const prev = maps([asset("image1", "A"), asset("image2", "B")]);
    const next = maps([asset("image1", "B")]);
    expect(remapSeedance2Mentions("First @image1 then @image2 at the end", prev, next)).toBe(
      "First then @image1 at the end",
    );
  });

  it("follows assets through a reorder", () => {
    const prev = maps([asset("image1", "A"), asset("image2", "B")]);
    const next = maps([asset("image1", "B"), asset("image2", "A")]);
    expect(remapSeedance2Mentions("@image1 and @image2", prev, next)).toBe(
      "@image2 and @image1",
    );
  });

  it("remaps image and audio families independently", () => {
    const prev = maps([
      asset("image1", "i1"),
      asset("image2", "i2"),
      asset("audio1", "a1"),
      asset("audio2", "a2"),
    ]);
    const next = maps([asset("image1", "i2"), asset("audio1", "a2")]); // removed i1, a1
    expect(remapSeedance2Mentions("Watch @image2 listen @audio2", prev, next)).toBe(
      "Watch @image1 listen @audio1",
    );
  });

  it("leaves unknown / manually-typed labels untouched", () => {
    const prev = maps([asset("image1", "A")]);
    const next = maps([asset("image1", "A")]);
    expect(remapSeedance2Mentions("@image9 kept", prev, next)).toBe("@image9 kept");
  });

  it("returns text unchanged when nothing references a changed asset", () => {
    const prev = maps([asset("image1", "A"), asset("image2", "B")]);
    const next = maps([asset("image1", "B")]);
    expect(remapSeedance2Mentions("No references at all", prev, next)).toBe("No references at all");
  });
});

describe("sameSeedance2LabelIdentity", () => {
  it("detects when the label↔identity mapping changes", () => {
    const a = maps([asset("image1", "A"), asset("image2", "B")]);
    const same = maps([asset("image1", "A"), asset("image2", "B")]);
    const reordered = maps([asset("image1", "B"), asset("image2", "A")]);
    expect(sameSeedance2LabelIdentity(a, same)).toBe(true);
    expect(sameSeedance2LabelIdentity(a, reordered)).toBe(false);
  });
});
