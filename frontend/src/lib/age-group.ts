// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFn } from "@/lib/i18n-types";

/**
 * The backend (identity_planner._normalize_age_group_value) normalizes the age group into these four codes.
 * Generated data carries the code, so the UI looks up the label by code and follows the UI language.
 * In the label keys `youth` is spelled `young`; that is historical naming, leave the locale entries alone (old snapshots still use them).
 */
export const AGE_GROUP_CODES = ["child", "youth", "middle", "elder"] as const;

export type AgeGroupCode = (typeof AGE_GROUP_CODES)[number];

const AGE_GROUP_LABEL_KEYS: Record<AgeGroupCode, string> = {
  child: "characters.ageGroups.child",
  youth: "characters.ageGroups.young",
  middle: "characters.ageGroups.middle",
  elder: "characters.ageGroups.elder",
};

export function isAgeGroupCode(value: string | null | undefined): value is AgeGroupCode {
  return AGE_GROUP_CODES.includes(String(value ?? "") as AgeGroupCode);
}

/** Returns the localized label for a known code; unknown values (legacy data stored as free text) are shown as is. */
export function ageGroupLabel(value: string | null | undefined, t: TFn): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return isAgeGroupCode(raw) ? t(AGE_GROUP_LABEL_KEYS[raw]) : raw;
}
