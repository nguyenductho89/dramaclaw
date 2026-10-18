// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { identityPeriodLabel, identityRefLabel } from "@/lib/identity-period";

// Fake t: echoes the key as is, enough to tell "was a locale entry found".
const t = ((key: string) => key) as never;

describe("identityPeriodLabel", () => {
  it("known period slugs go through locale entries", () => {
    expect(identityPeriodLabel("young_adult", t)).toBe(
      "characters.identityPeriods.youngAdult",
    );
    expect(identityPeriodLabel("default", t)).toBe(
      "characters.identityPeriods.default",
    );
  });

  it("unknown made-up names are echoed as is", () => {
    expect(identityPeriodLabel("1893_chicago", t)).toBe("1893_chicago");
    expect(identityPeriodLabel("", t)).toBe("");
    expect(identityPeriodLabel(null, t)).toBe("");
  });
});

describe("identityRefLabel", () => {
  it("only localizes the period slug after the underscore, the character name stays as is", () => {
    expect(identityRefLabel("Shen Wan_young_adult", t)).toBe(
      "Shen Wan_characters.identityPeriods.youngAdult",
    );
  });

  it("a character name that contains an underscore is still split correctly", () => {
    expect(identityRefLabel("Shen_Wan_middle_aged", t)).toBe(
      "Shen_Wan_characters.identityPeriods.middleAge",
    );
    expect(identityRefLabel("Shen_Wan_default", t)).toBe(
      "Shen_Wan_characters.identityPeriods.default",
    );
  });

  it("an unknown period echoes the whole string, with no partial replacement", () => {
    expect(identityRefLabel("Shen Wan_big_tech_era", t)).toBe("Shen Wan_big_tech_era");
  });

  it("without an underscore it is treated as a bare period slug", () => {
    expect(identityRefLabel("elderly", t)).toBe(
      "characters.identityPeriods.laterYears",
    );
    expect(identityRefLabel("passerby", t)).toBe("passerby");
  });

  it("malformed values with a leading or trailing underscore do not crash", () => {
    expect(identityRefLabel("_default", t)).toBe("_default");
    expect(identityRefLabel("Shen Wan_", t)).toBe("Shen Wan_");
  });
});
