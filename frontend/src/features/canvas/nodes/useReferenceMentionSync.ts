// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef } from "react";

import {
  remapReferenceMentions,
  sameOrder,
  type MentionFamily,
} from "./referenceMentions";

export interface ReferenceMentionFamilyInput {
  /** Mention prefix, e.g. "image" (video / ImageGen) / "audio". */
  prefix: string;
  /**
   * The current frame's ordered reference id list; index + 1 is the reference's number in the prompt (@<prefix>N).
   * Must match the ordered list the node uses to number the "character library / reference row" (after dedupe, in connection order).
   */
  ids: string[];
}

// Separator for the signature: an invisible character that never appears in node ids / prefixes, avoiding concatenation ambiguity.
const FIELD_SEP = "␟";
const FAMILY_SEP = "␞";

/**
 * Keeps `@<prefix>N` mentions in the prompt following the reference numbering: whenever a family's ordered id list
 * changes (delete / reorder / add a reference edge, covering every edge-deletion path), the matching numbers in the prompt are rewritten,
 * and the mention of a deleted reference is removed together with its trailing space. The first frame only records a baseline and leaves the prompt alone — persisted
 * mentions already match the reference order at that time. See referenceMentions.ts.
 *
 * `applyPrompt` should be stable (useCallback); even if it is not, it only costs one extra no-op (the sameOrder guard
 * ensures a write-back happens only when the order really changed), and the prompt is never corrupted.
 */
export function useReferenceMentionSync(
  prompt: string,
  families: ReferenceMentionFamilyInput[],
  applyPrompt: (next: string) => void,
): void {
  const prevRef = useRef<Map<string, string[]> | null>(null);
  // Structural signature as the effect dependency: re-run only when some family's ids really change.
  const signature = families
    .map((family) => family.prefix + FIELD_SEP + family.ids.join(FIELD_SEP))
    .join(FAMILY_SEP);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = new Map(
      families.map((family) => [family.prefix, family.ids] as const),
    );
    // The first frame only records the baseline and does not touch the prompt.
    if (!prev) return;

    let changed = false;
    const remapFamilies: MentionFamily[] = families.map((family) => {
      const prevIds = prev.get(family.prefix) ?? [];
      if (!sameOrder(prevIds, family.ids)) changed = true;
      return { prefix: family.prefix, prevIds, nextIds: family.ids };
    });
    if (!changed) return;

    const next = remapReferenceMentions(prompt, remapFamilies);
    if (next !== prompt) applyPrompt(next);
    // families are represented by the signature; prompt / applyPrompt are listed explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, prompt, applyPrompt]);
}
