// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from "i18next";
import type { AssetBoardColumn, AssetBoardData } from "@/features/canvas/domain/assetBoard";
import { KEY_ELEMENT_CATEGORY_KEYS, type KeyElementCategory } from "@/features/canvas/domain/keyElements";

/** How many candidates to render per page (load another page on scroll-to-bottom / keyboard overflow). */
export const FREEZONE_NODE_SUGGESTION_PAGE = 24;

export type FreezoneNodeSuggestion = {
  nodeId: string;
  column: AssetBoardColumn;
  title: string;
  thumbnailUrl: string | null;
  /** Media source URL (the video/audio/image itself). Used as a first-frame fallback for videos with no stored cover. */
  mediaUrl: string | null;
  /** Key-element category (user-marked); null when unmarked. The default sort pins key elements to the top by it. */
  keyElementCategory: KeyElementCategory | null;
};

/**
 * Matches the `@query` being typed at the cursor: `@` must be at the string start or after whitespace; the token contains no whitespace/@.
 * Isomorphic to getFreezoneSkillSlashQuery for `/skill`; requiring a leading boundary avoids false triggers on emails like a@b.
 * Returns null when the cursor is not in an @ query (the menu should close).
 */
export function getFreezoneNodeAtQuery(value: string): string | null {
  const match = value.match(/(?:^|\s)@([^\s@]*)$/u);
  return match ? match[1].trim().toLowerCase() : null;
}

/** Sort tier for nodes without a key-element mark (after the four categories). */
const NON_KEY_ELEMENT_RANK = KEY_ELEMENT_CATEGORY_KEYS.length;

function keyElementRank(category: KeyElementCategory | null): number {
  return category === null ? NON_KEY_ELEMENT_RANK : KEY_ELEMENT_CATEGORY_KEYS.indexOf(category);
}

/**
 * Flattens the four storyboard columns into a candidate list. Default order: nodes marked as key elements are pinned
 * to the top in category order (character > scene > prop > other, matching KeyElementsBar); the rest keep column order
 * (text > image > video > audio). Order is stable within the same tier.
 */
export function buildFreezoneNodeSuggestions(board: AssetBoardData): FreezoneNodeSuggestion[] {
  const flattened = [...board.text, ...board.image, ...board.video, ...board.audio].map((item) => ({
    nodeId: item.nodeId,
    column: item.column,
    title: item.title,
    thumbnailUrl: item.thumbnailUrl,
    mediaUrl: item.mediaUrl,
    keyElementCategory: item.keyElementCategory,
  }));
  return flattened
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const rankDelta =
        keyElementRank(a.item.keyElementCategory) - keyElementRank(b.item.keyElementCategory);
      return rankDelta !== 0 ? rankDelta : a.index - b.index;
    })
    .map((entry) => entry.item);
}

/** Case-insensitive substring filter on the title; an empty query returns everything. */
export function filterFreezoneNodeSuggestions(
  items: FreezoneNodeSuggestion[],
  query: string,
): FreezoneNodeSuggestion[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return items;
  return items.filter((item) => item.title.toLowerCase().includes(normalized));
}

/** Erases the `@query` token being typed at the cursor, keeping the remaining text and leading whitespace. */
export function stripFreezoneNodeAtQuery(value: string): string {
  const match = value.match(/(?:^|\s)@([^\s@]*)$/u);
  if (!match || match.index === undefined) return value;
  const matched = match[0];
  const tokenStart = match.index + (matched.startsWith("@") ? 0 : 1);
  return value.slice(0, tokenStart);
}

/** Node token syntax `@[nodeName](nodeId)`. The name contains no `]`/newline, the nodeId no `)`/whitespace. The leading boundary matches @ detection. */
const NODE_MENTION_PATTERN = /(?:^|\s)@\[([^\]\n]+)\]\(([^)\s]+)\)/gu;

export type FreezoneNodeMention = {
  nodeId: string;
  label: string;
  /** Start of the token in the string (points at `@`). */
  start: number;
  /** End position of the token (after the closing parenthesis). */
  end: number;
};

/**
 * Node lookup for the editor chip / hover preview: nodeId -> thumbnail/media source/column. The label comes from the token itself.
 * mediaUrl is the first-frame fallback for videos with no stored cover (same as the storyboard VideoThumb).
 */
export type FreezoneNodeMentionLookup = Map<
  string,
  { thumbnailUrl: string | null; mediaUrl: string | null; column: AssetBoardColumn }
>;

/** Sanitizes a node name before it goes into a token: strips characters that would break the `@[name](id)` syntax and collapses whitespace. */
export function sanitizeFreezoneNodeLabel(title: string): string {
  return title.replace(/[[\]()\n\r]/gu, " ").replace(/\s+/gu, " ").trim();
}

/**
 * Replaces the `@query` being typed at the cursor with a node token `@[name](nodeId) ` (trailing space makes it easy to keep typing).
 * If there is no `@query`, appends at the end. Mirrors insertFreezoneSkillMention.
 */
export function insertFreezoneNodeMention(value: string, nodeId: string, title: string): string {
  const label = sanitizeFreezoneNodeLabel(title) || nodeId;
  const token = `@[${label}](${nodeId}) `;
  const atMatch = value.match(/(?:^|\s)@([^\s@]*)$/u);
  if (!atMatch || atMatch.index === undefined) {
    return `${value}${value && !/\s$/u.test(value) ? " " : ""}${token}`;
  }
  const matched = atMatch[0];
  const tokenStart = atMatch.index + (matched.startsWith("@") ? 0 : 1);
  return `${value.slice(0, tokenStart)}${token}`;
}

/** Parses all node tokens (including duplicates), returning nodeId/label/position. */
export function parseFreezoneNodeMentions(value: string): FreezoneNodeMention[] {
  const out: FreezoneNodeMention[] = [];
  for (const match of value.matchAll(NODE_MENTION_PATTERN)) {
    if (match.index === undefined) continue;
    const label = match[1] ?? "";
    const nodeId = match[2]?.trim();
    if (!nodeId) continue;
    const matched = match[0] ?? "";
    const start = match.index + (matched.startsWith("@") ? 0 : 1);
    out.push({ nodeId, label, start, end: start + `@[${label}](${nodeId})`.length });
  }
  return out;
}

/** Collects the nodeIds mentioned in the text (deduplicated, order preserved). */
export function freezoneNodeMentionIds(value: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const mention of parseFreezoneNodeMentions(value)) {
    if (seen.has(mention.nodeId)) continue;
    seen.add(mention.nodeId);
    ids.push(mention.nodeId);
  }
  return ids;
}

/** On submit, rewrites `@[name](id)` into a readable `[name]` (keeping leading whitespace) as the body sent to the agent. */
export function freezoneNodeMentionText(value: string): string {
  return value.replace(NODE_MENTION_PATTERN, (matched: string, label: string) => {
    const lead = matched.startsWith("@") ? "" : matched.slice(0, 1);
    return `${lead}[${label}]`;
  });
}

/** Builds a nodeId -> thumbnail/media source/column lookup from the candidate list, so editor chips can render thumbnails and the first-frame fallback. */
export function buildFreezoneNodeMentionLookup(
  items: FreezoneNodeSuggestion[],
): FreezoneNodeMentionLookup {
  return new Map(
    items.map((item) => [
      item.nodeId,
      { thumbnailUrl: item.thumbnailUrl, mediaUrl: item.mediaUrl, column: item.column },
    ]),
  );
}

/**
 * "Add to chat": appends a batch of nodeIds as inline mention chips in the draft.
 * - titleLookup lacks the id (node is no longer on the canvas) -> skip;
 * - draft already mentions it or duplicate within the batch -> skip, avoiding duplicate chips.
 * Reuses insertFreezoneNodeMention one by one (appends at the end when there is no trailing @query).
 */
export function appendFreezoneNodeMentions(
  draft: string,
  nodeIds: string[],
  titleLookup: Map<string, string>,
): string {
  const seen = new Set(freezoneNodeMentionIds(draft));
  let result = draft;
  for (const nodeId of nodeIds) {
    if (seen.has(nodeId)) continue;
    const title = titleLookup.get(nodeId);
    if (title === undefined) continue;
    result = insertFreezoneNodeMention(result, nodeId, title);
    seen.add(nodeId);
  }
  return result;
}

/** Column -> type label shown in the hover preview. */
const FREEZONE_NODE_COLUMN_LABEL_KEY: Record<AssetBoardColumn, string> = {
  text: "superchat.panel.mentionType.text",
  image: "superchat.panel.mentionType.image",
  video: "superchat.panel.mentionType.video",
  audio: "superchat.panel.mentionType.audio",
};

/**
 * Hover preview content for a reference chip in the input box.
 * - thumbnailUrl set -> render <img> directly (image itself / video cover);
 * - thumbnailUrl empty but videoPosterUrl set -> use the media source to grab a first-frame <video> (fallback for videos with no stored cover);
 * - both empty -> text/audio etc., use the type placeholder.
 */
export type FreezoneNodePreviewInfo = {
  label: string;
  thumbnailUrl: string | null;
  /** Video without a cover -> fallback source for grabbing the first frame; null for non-videos or when a cover exists. */
  videoPosterUrl: string | null;
  typeLabel: string;
};

/**
 * Builds the preview card content from the chip's own label and the lookup meta:
 * - image/video with a thumbnail -> shown enlarged; video with no stored cover -> first-frame fallback from mediaUrl (matches the storyboard VideoThumb);
 * - text/audio etc. with no image -> type placeholder only;
 * - meta missing (node is no longer on the canvas) -> type falls back to "Reference", the label is still shown.
 */
export function buildFreezoneNodePreviewInfo(
  label: string,
  meta: { thumbnailUrl: string | null; mediaUrl: string | null; column: AssetBoardColumn } | null,
): FreezoneNodePreviewInfo {
  const thumbnailUrl = meta?.thumbnailUrl ?? null;
  const videoPosterUrl =
    !thumbnailUrl && meta?.column === "video" ? (meta.mediaUrl ?? null) : null;
  return {
    label,
    thumbnailUrl,
    videoPosterUrl,
    typeLabel: meta
      ? i18n.t(FREEZONE_NODE_COLUMN_LABEL_KEY[meta.column])
      : i18n.t("superchat.panel.mentionType.reference"),
  };
}
