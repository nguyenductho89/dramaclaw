// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFn } from "@/lib/i18n-types";

/**
 * When an episode has no LLM title, the backend fills in `Episode N` as a fallback (sqlite_store.py / cognee/store.py
 * both use this shape, and episode_fixer treats it as the "not named yet" sentinel). Once stored it would leak
 * untranslated into other UI languages, so it is re-localized at render time by episode number - only the one that matches the number is
 * recognized; titles the user wrote by hand such as "Episode 3: Rainy Night" are left alone.
 */
const AUTO_EPISODE_TITLE = /^Episode\s*(\d+)$/i;

export function isAutoEpisodeTitle(title: string | null | undefined, num: number): boolean {
  const matched = AUTO_EPISODE_TITLE.exec(String(title ?? "").trim());
  return matched !== null && Number(matched[1]) === num;
}

export function episodeDisplayTitle(
  num: number,
  title: string | null | undefined,
  t: TFn,
): string {
  const raw = String(title ?? "").trim();
  if (!raw || isAutoEpisodeTitle(raw, num)) return t("episode.list.episodeNumber", { n: num });
  return raw;
}
