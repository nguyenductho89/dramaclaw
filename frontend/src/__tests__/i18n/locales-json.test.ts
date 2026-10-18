// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

function collectKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }

  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    collectKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

function collectEntries(value: unknown, prefix = ""): Array<[string, string]> {
  if (typeof value === "string") return [[prefix, value]];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    collectEntries(child, prefix ? `${prefix}.${key}` : key),
  );
}

function loadLocale(language: string): unknown {
  return JSON.parse(readFileSync(`public/locales/${language}/translation.json`, "utf8"));
}

describe("locale translation files", () => {
  it.each(["en", "vi"])("%s translation JSON is valid", (language) => {
    const content = readFileSync(`public/locales/${language}/translation.json`, "utf8");

    expect(() => JSON.parse(content)).not.toThrow();
  });

  it("ships only the en and vi locales", () => {
    expect(readdirSync("public/locales").sort()).toEqual(["en", "vi"]);
  });

  // `en` is the reference key set. A locale may leave a value in English on
  // purpose (prompt fragments, domain terms and product names all stay as they
  // are) but it may never be missing a key, or i18next renders the raw key.
  it("keeps vi aligned with the en key set", () => {
    const enKeys = new Set(collectKeys(loadLocale("en")));
    const viKeys = new Set(collectKeys(loadLocale("vi")));

    expect([...enKeys].filter((key) => !viKeys.has(key)).sort()).toEqual([]);
    expect([...viKeys].filter((key) => !enKeys.has(key)).sort()).toEqual([]);
  });

  it.each(["en", "vi"])("%s values contain no CJK characters", (language) => {
    const cjk = /[\u3400-\u9fff\uff00-\uffef]/;
    const offenders = collectEntries(loadLocale(language)).filter(([, value]) => cjk.test(value));

    expect(offenders.map(([key]) => key)).toEqual([]);
  });

  it("defines the Niu Lai accessory name and selection feedback", () => {
    const en = loadLocale("en") as any;

    expect(en.myBuddy.debug.accessories.niulai).toBe("Niu Lai");
    expect(en.myBuddy.debug.accessoryFeedback.niulai).toBe("Mom!");
  });

  it("defines the project queue full toasts", () => {
    const en = loadLocale("en") as any;

    expect(en.common.projectDefaultQueueFull).toBe("The current project's default queue is full");
    expect(en.common.organizationDefaultQueueFull).toBe("The current organization's default queue is full");
    expect(en.common.platformDefaultQueueFull).toBe("The platform default queue is full");
    expect(en.common.nodeDefaultQueueFull).toBe("The current node's default queue is full");
  });

  it("defines project queue kind labels", () => {
    const en = loadLocale("en") as any;

    expect(en.common.projectQueueKinds).toMatchObject({
      video: "video",
      world: "world",
      ffmpeg: "composition",
    });
  });

  it("defines 3D director labels used without default values", () => {
    const keys = [
      "currentBackgroundSource",
      "downstreamCurrentBackground",
      "shapeHint",
      "saveScene",
      "clearScene",
    ];

    for (const language of ["en", "vi"]) {
      const translations = loadLocale(language) as any;
      for (const key of keys) {
        expect(translations.viewer.threeD[key]).toEqual(expect.any(String));
        expect(translations.viewer.threeD[key].length).toBeGreaterThan(0);
      }
    }
  });
});
