// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, it, expect } from "vitest";
import { taskIoLabel } from "@/lib/task-io-label";
import { enT, viT } from "../helpers/i18n-fixtures";

const en = enT as unknown as (k: string, o?: Record<string, unknown>) => string;
const vi = viT as unknown as (k: string, o?: Record<string, unknown>) => string;

describe("taskIoLabel", () => {
  it("localizes freezone source/target labels in English", () => {
    expect(taskIoLabel("Sketch + background + identities/props", en)).toBe(
      "Sketch + background + identities/props",
    );
    expect(taskIoLabel("Current storyboard", en)).toBe("Current storyboard");
    expect(taskIoLabel("360 panorama", en)).toBe("360\u00b0 panorama");
  });

  it("localizes every known label in Vietnamese", () => {
    for (const raw of [
      "Beat context",
      "Master + Reverse",
      "Scene Master + Reverse",
      "Director composite",
      "Background",
      "Current background",
      "Background candidate",
      "Input reference",
      "Sketch + background + identities/props",
      "360 panorama",
      "Current sketch",
      "Sketch candidate",
      "Current sketch candidate",
      "Current storyboard",
      "Storyboard candidate",
    ]) {
      expect(taskIoLabel(raw, vi)).not.toBe("");
      expect(taskIoLabel(raw, vi)).not.toMatch(/^taskCenter\./);
    }
    expect(taskIoLabel("Current storyboard", vi)).toBe("Storyboard hiện tại");
  });

  it("passes unknown labels through untouched", () => {
    expect(taskIoLabel("Some new label", en)).toBe("Some new label");
    expect(taskIoLabel("", en)).toBe("");
    expect(taskIoLabel(null, en)).toBe("");
    expect(taskIoLabel(undefined, en)).toBe("");
  });
});
