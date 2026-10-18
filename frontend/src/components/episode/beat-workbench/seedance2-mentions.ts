// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { buildMentionRegex } from "@/lib/mention-markers";

/**
 * Minimal shape of a Seedance2 reference asset: reference_label is the backend-assigned "image N / audio N" (renumbered
 * on add/remove/reorder), and url/key serve as the asset's stable identity.
 */
export interface Seedance2ReferenceAssetLike {
  reference_label: string;
  url?: string;
  path?: string;
  key: string;
}

// Asset identity: use the URL (semantics: "prompts reference assets by URL"), falling back to path / key if the URL is missing.
// When other assets are deleted / reordered, the surviving assets' URLs do not change, so they can be matched stably.
export function seedance2AssetIdentity(
  asset: Seedance2ReferenceAssetLike,
): string {
  return asset.url || asset.path || asset.key;
}

export interface Seedance2LabelIdentityMaps {
  /** image N -> asset identity (URL). */
  labelToIdentity: Map<string, string>;
  /** asset identity (URL) -> image N. */
  identityToLabel: Map<string, string>;
  /** All labels, used to build the matching regex. */
  labels: string[];
}

export function buildSeedance2LabelIdentityMaps(
  assets: Seedance2ReferenceAssetLike[],
): Seedance2LabelIdentityMaps {
  const labelToIdentity = new Map<string, string>();
  const identityToLabel = new Map<string, string>();
  const labels: string[] = [];
  for (const asset of assets) {
    const label = asset.reference_label;
    const identity = seedance2AssetIdentity(asset);
    if (!label || !identity) continue;
    if (!labelToIdentity.has(label)) {
      labelToIdentity.set(label, identity);
      labels.push(label);
    }
    if (!identityToLabel.has(identity)) {
      identityToLabel.set(identity, label);
    }
  }
  return { labelToIdentity, identityToLabel, labels };
}

export function sameSeedance2LabelIdentity(
  a: Seedance2LabelIdentityMaps,
  b: Seedance2LabelIdentityMaps,
): boolean {
  if (a.labelToIdentity.size !== b.labelToIdentity.size) return false;
  for (const [label, identity] of a.labelToIdentity) {
    if (b.labelToIdentity.get(label) !== identity) return false;
  }
  return true;
}

/**
 * Re-aligns `@image N / @audio N` in the prompt by asset identity (URL) - so a mention always follows the asset
 * it references, instead of being bound to a hard-coded number:
 * - prev can locate the identity and that identity is still in current -> rewrite to its current label (image2 -> image1).
 * - the identity no longer exists (asset deleted) -> remove the mention and the single space following it.
 * - prev cannot locate it (a manually typed unknown label, or it already is the current label) -> keep as is.
 *
 * Scans the original string once and maps each prev identity independently, so there is no cross-talk among 2->1, 3->2. What the backend still receives is
 * image N (this function only aligns the numbering to the current asset list in the frontend).
 */
export function remapSeedance2Mentions(
  text: string,
  prev: Seedance2LabelIdentityMaps,
  current: Seedance2LabelIdentityMaps,
): string {
  // Build the regex from the union of prev + current labels, so old labels in the text can be matched.
  const knownLabels = Array.from(new Set([...prev.labels, ...current.labels]));
  const pattern = buildMentionRegex(knownLabels);
  if (!pattern) return text;

  let out = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const label = match[1];
    out += text.slice(lastIndex, start);

    const identity = prev.labelToIdentity.get(label);
    if (identity === undefined) {
      out += match[0];
      lastIndex = end;
      continue;
    }
    const nextLabel = current.identityToLabel.get(identity);
    if (nextLabel === undefined) {
      // Asset deleted -> remove it together with the single space that follows.
      lastIndex = text[end] === " " ? end + 1 : end;
      continue;
    }
    out += `@${nextLabel}`;
    lastIndex = end;
  }
  out += text.slice(lastIndex);
  return out;
}
