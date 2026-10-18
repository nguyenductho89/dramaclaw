// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { listCapabilities } from "@/features/freezone/capabilities/capabilityRegistry";

function lookup(translations: Record<string, unknown>, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
      translations,
    );
}

/**
 * The capability table's display text lives entirely in locale entries, and the source keeps only keys. When an entry is missing the UI shows the bare key directly,
 * rather than falling back to another language -- so every key is checked here against both locales.
 */
describe("capability copy is fully translated", () => {
  const locales = ["en", "vi"].map((language) => ({
    language,
    translations: JSON.parse(
      readFileSync(`public/locales/${language}/translation.json`, "utf8"),
    ) as Record<string, unknown>,
  }));

  const keys = listCapabilities().flatMap((capability) => [
    capability.nameKey,
    capability.shortNameKey,
    capability.descriptionKey,
    ...capability.inputs.flatMap((input) =>
      [input.labelKey, input.descriptionKey].filter((key): key is string => Boolean(key)),
    ),
    ...capability.params.flatMap((param) => [
      param.labelKey,
      ...(param.descriptionKey ? [param.descriptionKey] : []),
      ...(param.options ?? []).map((option) => option.labelKey),
    ]),
  ]);

  it.each(locales)("resolves every capability key in $language", ({ translations }) => {
    const missing = keys.filter((key) => typeof lookup(translations, key) !== "string");

    expect(missing).toEqual([]);
  });
});
