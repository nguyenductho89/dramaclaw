// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  extractIdentityMarkers,
  extractPropMarkers,
  mentionsToProgramMarkers,
  programMarkersToMentions,
} from "@/lib/mention-markers";

describe("mention marker helpers", () => {
  it("converts identity and prop @ mentions to backend marker syntax", () => {
    expect(
      mentionsToProgramMarkers("@Lu Chen_young picks up @jade", {
        identities: ["Lu Chen_young"],
        props: ["jade"],
      }),
    ).toBe("{{Lu Chen_young}} picks up [[jade]]");
  });

  it("only converts known standalone mentions", () => {
    expect(
      mentionsToProgramMarkers("contact a@b.com, @unknown kept, @Lu Chen_young convert", {
        identities: ["Lu Chen_young"],
        props: [],
      }),
    ).toBe("contact a@b.com, @unknown kept, {{Lu Chen_young}} convert");
  });

  it("resolves a known label even without a trailing space", () => {
    expect(
      mentionsToProgramMarkers("@Qingtong_girlhoodhahaha", {
        identities: ["Qingtong_girlhood"],
        props: [],
      }),
    ).toBe("{{Qingtong_girlhood}}hahaha");
  });

  it("converts consecutive mentions that the user did not separate", () => {
    expect(
      mentionsToProgramMarkers("@Qingtong_girlhoodhaha @Second Madam_middle_agedheihei", {
        identities: ["Qingtong_girlhood", "Second Madam_middle_aged"],
        props: [],
      }),
    ).toBe("{{Qingtong_girlhood}}haha {{Second Madam_middle_aged}}heihei");
  });

  it("prefers the longest matching label", () => {
    expect(
      mentionsToProgramMarkers("@Qingtong_girlhoodX", {
        identities: ["Qingtong_girl", "Qingtong_girlhood"],
        props: [],
      }),
    ).toBe("{{Qingtong_girlhood}}X");
  });

  it("resolves adjacent mentions whose labels end in digits", () => {
    // No look-behind on the char before `@`, so `@image1@image2` resolves both
    // even though `@image2` directly follows the digit `1`.
    expect(
      mentionsToProgramMarkers("@image1@image2", {
        identities: [],
        props: ["image1", "image2"],
      }),
    ).toBe("[[image1]][[image2]]");
  });

  it("extracts unique identity and prop markers in first-seen order", () => {
    const text = "{{Lu Chen_young}}picks up[[jade]], {{Lu Chen_young}}looks at[[recorder]]";

    expect(extractIdentityMarkers(text)).toEqual(["Lu Chen_young"]);
    expect(extractPropMarkers(text)).toEqual(["jade", "recorder"]);
  });

  it("converts stored backend markers back to user-facing @ mentions", () => {
    expect(programMarkersToMentions("{{Lu Chen_young}}picks up[[jade]]")).toBe(
      "@Lu Chen_youngpicks up@jade",
    );
  });
});
