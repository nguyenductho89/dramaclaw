// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";

import type { TFunction } from "i18next";

/**
 * Test-side `t`: resolves keys against the shipped locale JSON.
 *
 * Pure functions that take a `t` can be asserted against the text users actually
 * see, and a missing key fails loudly instead of silently echoing the key.
 */
function loadLocale(lng: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`public/locales/${lng}/translation.json`, "utf8")) as Record<
    string,
    unknown
  >;
}

export const enTranslation = loadLocale("en");
export const viTranslation = loadLocale("vi");

function lookup(table: unknown, key: string): string | undefined {
  let cursor: unknown = table;
  for (const part of key.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return typeof cursor === "string" ? cursor : undefined;
}

function makeT(lang: "vi" | "en", table: unknown) {
  return ((key: string, options?: Record<string, unknown>) => {
    const template = lookup(table, key);
    if (template === undefined) {
      // Dynamically built keys may legitimately miss; fall back to defaultValue like
      // i18next does. A key with neither an entry nor a default is a missing translation.
      if (options && typeof options.defaultValue === "string") return options.defaultValue;
      throw new Error(`${lang} translation.json has no key: ${key}`);
    }
    return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
      options && name in options ? String(options[name]) : whole,
    );
  }) as unknown as TFunction;
}

export const enT = makeT("en", enTranslation);
export const viT = makeT("vi", viTranslation);
/** @deprecated Chinese UI was removed; aliases to English so stale imports still compile. */
export const zhT = enT;
/** @deprecated see zhT. */
export const zhTranslation = enTranslation;
