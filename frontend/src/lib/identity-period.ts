// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFn } from "@/lib/i18n-types";

/**
 * Identity names (the visual_state produced by identity_planner) are short English
 * slugs (default, child, teen, young_adult, middle_aged, elderly, or a free-form
 * one such as 1893_chicago). The known slugs are rendered through i18n keys so the
 * label follows the UI language; unknown ones (script-specific looks) are shown as is.
 *
 * This layer only affects display; the stored value is never changed (rename box,
 * @mention tokens and identity_id keep the raw value).
 */
const PERIOD_LABEL_KEYS: Record<string, string> = {
  default: "characters.identityPeriods.default",
  early_childhood: "characters.identityPeriods.earlyChildhood",
  child: "characters.identityPeriods.childhoodChild",
  teen: "characters.identityPeriods.adolescence",
  student: "characters.identityPeriods.schoolYears",
  young_adult: "characters.identityPeriods.youngAdult",
  adult: "characters.identityPeriods.adulthood",
  middle_aged: "characters.identityPeriods.middleAge",
  elderly: "characters.identityPeriods.laterYears",
  work_attire: "characters.identityPeriods.workAttire",
  home_attire: "characters.identityPeriods.homeAttire",
  casual_wear: "characters.identityPeriods.casualWear",
  formal_wear: "characters.identityPeriods.formalWear",
  court_dress: "characters.identityPeriods.courtDress",
};

/** Returns the localized label for a known period slug, or the raw value otherwise. */
export function identityPeriodLabel(
  value: string | null | undefined,
  t: TFn,
): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const key = PERIOD_LABEL_KEYS[raw];
  return key ? t(key) : raw;
}

const PERIOD_SLUGS_LONGEST_FIRST = Object.keys(PERIOD_LABEL_KEYS).sort(
  (a, b) => b.length - a.length,
);

/**
 * identity_id looks like `Shen Wan_young_adult`: the character name comes from the
 * source and is not translated; only the period slug after the name is localized.
 * Known slugs (which may contain underscores) are matched as a suffix, longest first;
 * otherwise the last underscore is used as the split point.
 */
export function identityRefLabel(
  value: string | null | undefined,
  t: TFn,
): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  for (const slug of PERIOD_SLUGS_LONGEST_FIRST) {
    const suffix = `_${slug}`;
    if (raw.length > suffix.length && raw.endsWith(suffix)) {
      return `${raw.slice(0, raw.length - suffix.length)}_${identityPeriodLabel(slug, t)}`;
    }
  }
  const at = raw.lastIndexOf("_");
  if (at <= 0 || at === raw.length - 1) return identityPeriodLabel(raw, t);
  const head = raw.slice(0, at);
  const tail = raw.slice(at + 1);
  const localized = identityPeriodLabel(tail, t);
  return localized === tail ? raw : `${head}_${localized}`;
}
