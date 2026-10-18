// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";

import i18next, { type TFunction } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { localizeFormatCheck } from "@/lib/format-check-copy";
import type { FormatCheck } from "@/lib/queries/ingest";

const CJK = /[\u4e00-\u9fff\u3001\u3002]/;
const BACKEND_SOURCE = "../src/novelvideo/utils/screenplay_quality.py";

function loadLocale(language: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`public/locales/${language}/translation.json`, "utf8"));
}

let instance: ReturnType<typeof i18next.createInstance>;
let en: TFunction;
let vi: TFunction;

beforeAll(async () => {
  instance = i18next.createInstance();
  await instance.init({
    lng: "en",
    fallbackLng: false,
    resources: {
      en: { translation: loadLocale("en") },
      vi: { translation: loadLocale("vi") },
    },
    interpolation: { escapeValue: false },
  });
  en = instance.getFixedT("en");
  vi = instance.getFixedT("vi");
});

// The backend screenplay_quality.py emits one fixed text per code, and the frontend looks up i18n by code. This sample covers
// every issue shape it can emit: report-level (empty params), row-level scene headers (params.header decides the shared key),
// and chapter structure (with number/title interpolation).
const PAYLOAD: FormatCheck = {
  level: "warning",
  summary: "Upload succeeded, but 3 format risks were detected that may affect scene recognition.",
  summary_code: "format_risks",
  summary_params: { count: 3 },
  issues: [
    {
      code: "scene_headers_missing_time",
      line: null,
      message:
        "Detected scene headings with no explicit time anchor; later time_of_day and scene variant inheritance may be unstable.",
      fix: "Add an explicit time to the scene heading, such as DAY/NIGHT; the system still keeps the scene boundary and normalizes it later.",
      params: {},
    },
    {
      code: "incomplete_scene_header",
      line: 12,
      message: "Scene heading “1-1 City Cafe” is missing a time and INT/EXT.",
      fix: "Fill in the missing values from the actual scene, for example “1-1 City Cafe [DAY/NIGHT] [INT/EXT]”.",
      params: {
        header: "1-1 City Cafe",
        missing_slots: ["time", "interior_exterior"],
        location: "City Cafe",
        time_of_day: "",
        interior_exterior: "",
        labeled_form: false,
      },
    },
    {
      code: "duplicate_chapter_number",
      line: 40,
      message: "Duplicate chapter number 3 detected: Untitled chapter.",
      fix: "Check the sentences in the body that look like chapter titles, so the same chapter number is not split into several chapters.",
      params: { number: 3, title: "" },
    },
  ],
  metrics: {},
  scene_header_status: "repairable",
};

describe("localizeFormatCheck", () => {
  it("returns null for a missing format check", () => {
    expect(localizeFormatCheck(null, en)).toBeNull();
    expect(localizeFormatCheck(undefined, en)).toBeNull();
  });

  it("renders the English copy from the locale entries", () => {
    const localized = localizeFormatCheck(PAYLOAD, en)!;

    expect(localized.summary).toBe(
      "Upload succeeded, but 3 formatting risks were detected that may affect scene recognition.",
    );
    // The user's original text (scene heading, location) may be in any language, so only the sentence frames we produce are asserted.
    expect(localized.issues![0].message).not.toMatch(CJK);
    expect(localized.issues![0].fix).not.toMatch(CJK);
    expect(localized.issues![1].message).toBe(
      "Scene heading “1-1 City Cafe” is missing a time of day, an INT/EXT marker.",
    );
    expect(localized.issues![1].fix).toBe(
      "Fill in the missing values from the actual scene — for example “1-1 City Cafe [DAY/NIGHT] [INT/EXT]”.",
    );
    expect(localized.issues![2].message).toBe("Duplicate chapter number 3: Untitled chapter.");
    expect(localized.issues![2].fix).not.toMatch(CJK);
  });

  it("keeps the singular form for a single risk", () => {
    const localized = localizeFormatCheck(
      { ...PAYLOAD, summary_params: { count: 1 } },
      en,
    )!;

    expect(localized.summary).toContain("1 formatting risk was detected");
  });

  it("rebuilds the labeled suggestion form with localized placeholders", () => {
    const localized = localizeFormatCheck(
      {
        ...PAYLOAD,
        issues: [
          {
            code: "incomplete_scene_header",
            line: 7,
            message: "Scene heading “Scene 1” is missing a time and INT/EXT.",
            fix: "Fill in the missing values from the actual scene.",
            params: {
              header: "Scene 1",
              missing_slots: ["time", "interior_exterior"],
              location: "Cafe",
              time_of_day: "",
              interior_exterior: "",
              labeled_form: true,
            },
          },
        ],
      },
      en,
    )!;

    expect(localized.issues![0].fix).toContain(
      "Scene 1; Location: Cafe, [DAY/NIGHT], [INT/EXT]",
    );
  });

  it("renders the Vietnamese copy from the locale entries", () => {
    const localized = localizeFormatCheck(PAYLOAD, vi)!;

    expect(localized.summary).not.toBe(PAYLOAD.summary);
    expect(localized.summary).not.toMatch(/^ingest\./);
    expect(localized.issues![1].message).toContain("1-1 City Cafe");
    expect(localized.issues![1].message).not.toBe(PAYLOAD.issues![1].message);
    expect(localized.issues![2].message).not.toBe(PAYLOAD.issues![2].message);
  });

  it("falls back to the backend copy for a code the frontend has no key for", () => {
    const localized = localizeFormatCheck(
      {
        ...PAYLOAD,
        summary_code: "brand_new_backend_code",
        issues: [
          {
            code: "brand_new_issue",
            line: null,
            message: "A problem the backend just added.",
            fix: "A suggestion the backend just added.",
            params: {},
          },
        ],
      },
      en,
    )!;

    expect(localized.summary).toBe(PAYLOAD.summary);
    expect(localized.issues![0].message).toBe("A problem the backend just added.");
  });
});

// Ratchet: when the backend adds an issue code without adding the en/vi key, the UI silently shows the backend text
// (the defaultValue fallback does not raise). The code constants are extracted straight from the Python source to reconcile.
describe("format check codes stay covered by the locale files", () => {
  // The three row-level scene header codes share sceneHeaderMissingSlots, routed by params.header.
  const HEADER_ROUTED = new Set([
    "incomplete_scene_header",
    "scene_headers_missing_time",
    "missing_interior_exterior",
  ]);

  it("has a message and fix for every code the backend can emit", () => {
    const source = readFileSync(BACKEND_SOURCE, "utf8");
    const codes = new Set<string>();
    for (const match of source.matchAll(/(?:"code":\s*|code=)"([a-z_]+)"/g)) {
      codes.add(match[1]);
    }
    expect(codes.size).toBeGreaterThan(8);

    const missing = [...codes]
      .filter((code) => !HEADER_ROUTED.has(code))
      .filter((code) => {
        const key = `ingest.formatCheck.issue.${code.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`;
        return !instance.exists(`${key}.message`, { lng: "en" }) ||
          !instance.exists(`${key}.fix`, { lng: "en" });
      })
      .sort();

    expect(missing).toEqual([]);
  });

  it("has a summary for every summary_code the backend can emit", () => {
    const source = readFileSync(BACKEND_SOURCE, "utf8");
    const codes = new Set<string>();
    for (const match of source.matchAll(/summary_code\s*=\s*"([a-z_]+)"/g)) {
      codes.add(match[1]);
    }
    expect(codes.size).toBeGreaterThan(3);

    const missing = [...codes]
      .filter((code) => {
        const camel = code.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
        // Plural keys are stored as _one/_other in i18next, so exists() misses the bare key.
        return (
          !instance.exists(`ingest.formatCheck.summary.${camel}`, { lng: "en" }) &&
          !instance.exists(`ingest.formatCheck.summary.${camel}_other`, { lng: "en" })
        );
      })
      .sort();

    expect(missing).toEqual([]);
  });
});
