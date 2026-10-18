// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import {
  STANDARD_TIME_OF_DAY_OPTIONS,
  timeOfDayLabel,
  timeOfDayOptions,
} from "@/lib/time-of-day";

describe("time-of-day helpers", () => {
  it("exposes the closed standard list without the none value", () => {
    expect(STANDARD_TIME_OF_DAY_OPTIONS).toEqual([
      "dawn",
      "morning",
      "noon",
      "afternoon",
      "day",
      "dusk",
      "night",
    ]);
  });

  it("appends non-standard current values as legacy choices", () => {
    expect(timeOfDayOptions("midnight")).toEqual([
      "dawn",
      "morning",
      "noon",
      "afternoon",
      "day",
      "dusk",
      "night",
      "midnight",
    ]);
  });

  it("labels empty and legacy values explicitly", () => {
    // Echo the key + interpolation, to assert which entry is mapped without depending on the exact translation.
    const echoKey = ((key: string, opts?: Record<string, unknown>) =>
      opts?.value ? `${key}:${String(opts.value)}` : key) as unknown as TFunction;
    expect(timeOfDayLabel("", echoKey)).toBe("timeOfDay.none");
    expect(timeOfDayLabel("day", echoKey)).toBe("timeOfDay.day");
    expect(timeOfDayLabel("night", echoKey)).toBe("timeOfDay.night");
    expect(timeOfDayLabel("morning", echoKey)).toBe("timeOfDay.forenoon");
    expect(timeOfDayLabel("midnight", echoKey)).toBe("timeOfDay.scriptOriginal:midnight");
  });
});
