// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from "i18next";

export type CharacterMainCopy = {
  label: string;
  makeMain: string;
  unsetMain: string;
  mainSet: string;
  mainUnset: string;
};

/**
 * The "protagonist / narrator protagonist" copy varies with spine_template; it is UI text, not a protocol value, so only
 * the key is stored here and the caller resolves it with its own `t` at render time.
 */
const MAIN_COPY_KEY_PREFIX = {
  drama: "character.main.drama",
  narrated: "character.main.narrated",
} as const;

export function characterMainCopyForSpineTemplate(
  spineTemplate: string | null | undefined,
  t: TFunction,
): CharacterMainCopy {
  const prefix =
    spineTemplate === "narrated" ? MAIN_COPY_KEY_PREFIX.narrated : MAIN_COPY_KEY_PREFIX.drama;
  return {
    label: t(`${prefix}.label`),
    makeMain: t(`${prefix}.makeMain`),
    unsetMain: t(`${prefix}.unsetMain`),
    mainSet: t(`${prefix}.mainSet`),
    mainUnset: t(`${prefix}.mainUnset`),
  };
}
