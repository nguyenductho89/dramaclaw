// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Keeps the `@image1` / `@audio1` references in a prompt in one-to-one correspondence with the connected references in the character library.
 *
 * Background: a video node's prompt serializes mentions to plain text such as `@image2` (the number is hard-coded from the reference
 * index at insertion time, so it loses which upstream node it pointed to). When the user deletes / reorders / adds reference edges, the
 * library renumbers (after image1 is removed, the old image2 becomes image1), but `@image2` in the prompt does not follow,
 * so the mention goes stale (it points to a missing or misaligned image).
 *
 * Here we diff the "previous ordered node id list" against the "current ordered node id list": every
 * `@<prefix>N` recovers the node it originally pointed to through `prevIds[N-1]`, then looks up its new index in `nextIds`
 * and rewrites the number; if the node was removed (the edge was deleted), the mention is deleted together with one
 * trailing space. One pass over the original string does it, so index mappings never interfere (no 2→1, 3→2 cross-talk).
 */
export interface MentionFamily {
  /** Mention prefix, e.g. "image" / "audio". */
  prefix: string;
  /** Ordered upstream node ids before the change (matching the pre-change indices 1..n). */
  prevIds: string[];
  /** Ordered upstream node ids after the change (determines the new indices). */
  nextIds: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function remapReferenceMentions(
  prompt: string,
  families: MentionFamily[],
): string {
  let out = prompt;
  for (const { prefix, prevIds, nextIds } of families) {
    // Skip when prev/next are unchanged within the same frame, avoiding a needless string rebuild.
    if (sameOrder(prevIds, nextIds)) {
      continue;
    }
    const pattern = new RegExp(`@${escapeRegExp(prefix)}(\\d+)(\\s?)`, "g");
    out = out.replace(pattern, (full, numStr: string, trailing: string) => {
      const oldIndex = Number(numStr);
      const node = prevIds[oldIndex - 1];
      if (node === undefined) {
        // Out of range / not a tracked mention: keep as is.
        return full;
      }
      const nextIndex = nextIds.indexOf(node);
      if (nextIndex === -1) {
        // The reference's edge was deleted → remove the mention together with the trailing space.
        return "";
      }
      return `@${prefix}${nextIndex + 1}${trailing}`;
    });
  }
  return out;
}

export function sameOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
