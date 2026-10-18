// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';

/**
 * Key elements: users manually mark canvas nodes as "key elements" and categorize them (matching liblib's
 * node "..." -> Set key element -> Character/Scene/Object/Other). The mark is only written on the node data
 * (data.keyElementCategory); it is canvas-level display metadata persisted with the node - the workflow side
 * does not read it, zero impact. The key element bar at the top of the storyboard pins marked nodes and filters by category.
 */
export type KeyElementCategory = 'character' | 'scene' | 'object' | 'other';

/** Stable key order (character -> scene -> object -> other); the bar's category dropdown and sorting follow it. */
export const KEY_ELEMENT_CATEGORY_KEYS: readonly KeyElementCategory[] = [
  'character',
  'scene',
  'object',
  'other',
];

// Getters so the label follows the active language at read time (not frozen at import).
export const KEY_ELEMENT_CATEGORY_LABEL: Record<KeyElementCategory, string> = {
  get character() { return i18n.t('canvas.keyElement.character'); },
  get scene() { return i18n.t('canvas.keyElement.scene'); },
  get object() { return i18n.t('canvas.keyElement.object'); },
  get other() { return i18n.t('canvas.keyElement.other'); },
};

const CATEGORY_KEY_SET = new Set<string>(KEY_ELEMENT_CATEGORY_KEYS);

/** Read the key element category from node data; unmarked / invalid value -> null. */
export function readKeyElementCategory(data: unknown): KeyElementCategory | null {
  if (!data || typeof data !== 'object') return null;
  const raw = (data as Record<string, unknown>).keyElementCategory;
  return typeof raw === 'string' && CATEGORY_KEY_SET.has(raw) ? (raw as KeyElementCategory) : null;
}
