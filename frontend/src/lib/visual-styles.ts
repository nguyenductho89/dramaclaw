// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * Built-in visual style preset id -> i18n key.
 *
 * The `label` in the backend `src/novelvideo/styles/presets/*.json` is Chinese-only, and rendering it directly would
 * show Chinese in the English UI. The preset id is stable, so the display name is always looked up here by id
 * ; only user-created styles (id not found) fall back to the backend's name/label.
 *
 * The order is the order of the import page dropdown, and the first entry is the default style.
 */
export const BUILTIN_VISUAL_STYLES: readonly { value: string; labelKey: string }[] = [
  { value: "chinese_period_drama", labelKey: "ingest.visualStyles.chinesePeriodDrama" },
  { value: "anime", labelKey: "ingest.visualStyles.anime" },
  { value: "guoman_fantasy", labelKey: "ingest.visualStyles.guomanFantasy" },
  { value: "post_apocalyptic", labelKey: "ingest.visualStyles.postApocalyptic" },
  { value: "realistic", labelKey: "ingest.visualStyles.realistic" },
  { value: "republican_era_drama", labelKey: "ingest.visualStyles.republicanEraDrama" },
];

export const BUILTIN_STYLE_LABEL_KEYS: Record<string, string> = Object.fromEntries(
  BUILTIN_VISUAL_STYLES.map((style) => [style.value, style.labelKey]),
);

export const DEFAULT_VISUAL_STYLE = BUILTIN_VISUAL_STYLES[0].value;
