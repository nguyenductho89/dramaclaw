// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from "i18next";

/**
 * The scene type value is the protocol (the backend stores interior/exterior/...), the label is only UI text,
 * so only the value -> key mapping is kept here, and the caller resolves it with its own `t`. Unrecognized values
 * (types extended by the project itself) are shown as is.
 */
const SCENE_TYPE_LABEL_KEYS: Record<string, string> = {
  interior: "assets.scenes.types.interior",
  exterior: "assets.scenes.types.exterior",
  mixed: "assets.scenes.types.mixed",
  other: "assets.scenes.types.other",
};

export const SCENE_TYPE_VALUES = ["interior", "exterior", "mixed", "other"] as const;

export function sceneTypeLabel(value: string | null | undefined, t: TFunction): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const key = SCENE_TYPE_LABEL_KEYS[trimmed];
  return key ? t(key) : trimmed;
}

export function sceneTypeOptions(
  value: string | null | undefined,
  t: TFunction,
): Array<{ value: string; label: string }> {
  const options = SCENE_TYPE_VALUES.map((item) => ({ value: item, label: sceneTypeLabel(item, t) }));
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed in SCENE_TYPE_LABEL_KEYS) return options;
  return [...options, { value: trimmed, label: trimmed }];
}
