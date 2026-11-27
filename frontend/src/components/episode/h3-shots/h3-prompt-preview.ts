// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

export type H3PromptToken =
  | { kind: "text"; text: string }
  | { kind: "ref"; media: "image" | "audio"; n: number; raw: string };

// `<Picture 2>` / `<Audio 1>` (H3 labels) and `@图片2` / `图片2` / `@音频1` (editor markers). // i18n-exempt
const REF_RE = /<(Picture|Audio)\s*(\d+)>|@?(图片|音频)\s*(\d+)/g; // i18n-exempt

export function tokenizeH3Prompt(prompt: string): H3PromptToken[] {
  const tokens: H3PromptToken[] = [];
  let last = 0;
  for (const m of prompt.matchAll(REF_RE)) {
    const index = m.index ?? 0;
    if (index > last) tokens.push({ kind: "text", text: prompt.slice(last, index) });
    const media = (m[1] ?? m[3]) === "Audio" || m[3] === "音频" ? "audio" : "image"; // i18n-exempt
    tokens.push({ kind: "ref", media, n: Number(m[2] ?? m[4]), raw: m[0] });
    last = index + m[0].length;
  }
  if (last < prompt.length) tokens.push({ kind: "text", text: prompt.slice(last) });
  return tokens;
}

export function referenceNumber(label: string): number {
  return Number(String(label ?? "").replace(/\D/g, "")) || 0;
}

/** Image numbers (ascending) the prompt cites. */
export function usedImageNumbers(tokens: H3PromptToken[]): number[] {
  const used = new Set<number>();
  for (const token of tokens) {
    if (token.kind === "ref" && token.media === "image") used.add(token.n);
  }
  return [...used].sort((a, b) => a - b);
}
