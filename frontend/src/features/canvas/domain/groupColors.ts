// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Group node background color presets (matching libtv's group palette). value is the base color, with low opacity overlaid at render time as the background.
export interface GroupColorPreset {
  key: string;
  /** The entry key of the color name for accessibility/title - this table follows the UI language, and only the key is left in source. */
  labelKey: string;
  /** Base color hex. */
  value: string;
}

export const GROUP_COLOR_PRESETS: ReadonlyArray<GroupColorPreset> = [
  { key: 'red', labelKey: 'canvas.groupColor.red', value: '#ef4444' },
  { key: 'orange', labelKey: 'canvas.groupColor.orange', value: '#f97316' },
  { key: 'yellow', labelKey: 'canvas.groupColor.yellow', value: '#eab308' },
  { key: 'green', labelKey: 'canvas.groupColor.green', value: '#22c55e' },
  { key: 'cyan', labelKey: 'canvas.groupColor.cyan', value: '#06b6d4' },
  { key: 'blue', labelKey: 'canvas.groupColor.blue', value: '#3b82f6' },
  { key: 'purple', labelKey: 'canvas.groupColor.purple', value: '#8b5cf6' },
  { key: 'pink', labelKey: 'canvas.groupColor.pink', value: '#ec4899' },
  { key: 'gray', labelKey: 'canvas.groupColor.gray', value: '#6b7280' },
];

/** Overlay a fixed opacity on the group background base hex to get the group card background / border color (8-digit hex). */
export function groupColorBackground(color: string | null | undefined): string | undefined {
  if (!color) return undefined;
  return `${color}1f`; // Background of ~12% opacity
}

export function groupColorBorder(color: string | null | undefined): string | undefined {
  if (!color) return undefined;
  return `${color}66`; // Border of ~40% opacity
}
