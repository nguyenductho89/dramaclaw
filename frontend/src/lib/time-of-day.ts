// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from "i18next";

/**
 * The time-of-day values are a protocol: the backend `novelvideo/time_of_day.py`
 * CanonicalTimeOfDay uses exactly these slugs. The array itself is never translated;
 * only the rendered label goes through i18n via a value -> key map. Unknown values
 * (raw script values) are passed through as is.
 */
export const STANDARD_TIME_OF_DAY_OPTIONS = [
  "dawn",
  "morning",
  "noon",
  "afternoon",
  "day",
  "dusk",
  "night",
] as const;

const TIME_OF_DAY_LABEL_KEYS: Record<string, string> = {
  dawn: "timeOfDay.dawn",
  morning: "timeOfDay.forenoon",
  noon: "timeOfDay.noon",
  afternoon: "timeOfDay.afternoon",
  day: "timeOfDay.day",
  dusk: "timeOfDay.dusk",
  night: "timeOfDay.night",
  none: "timeOfDay.none",
};

export function timeOfDayOptions(...values: Array<string | null | undefined>): string[] {
  const options: string[] = [...STANDARD_TIME_OF_DAY_OPTIONS];
  const seen = new Set<string>(options);
  for (const value of values) {
    const trimmed = String(value || "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    options.push(trimmed);
  }
  return options;
}

export function timeOfDayLabel(value: string | null | undefined, t: TFunction): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) return t("timeOfDay.none");
  const key = TIME_OF_DAY_LABEL_KEYS[trimmed];
  return key ? t(key) : t("timeOfDay.scriptOriginal", { value: trimmed });
}
