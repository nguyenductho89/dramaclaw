// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// `@imageN` is the reference token written into the prompt and recognized by the model, independent of the UI language.
// i18n-exempt-start
const STORYBOARD_AT_TAG_REGEX = /@\s*image\d+/g;
const STORYBOARD_AT_PREFIX_REGEX = /@(?=\s*image\d+)/g;
// i18n-exempt-end

export function sanitizeStoryboardText(input: string, ignoreAtTag: boolean): string {
  if (!ignoreAtTag) {
    return input.trim();
  }

  return input
    .replace(STORYBOARD_AT_TAG_REGEX, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function sanitizeStoryboardPromptText(input: string): string {
  return input
    .replace(STORYBOARD_AT_PREFIX_REGEX, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
