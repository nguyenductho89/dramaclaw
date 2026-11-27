// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

export const H3_RATIO_OPTIONS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;
export const H3_DEFAULT_DURATION = 5;
export const H3_MIN_DURATION = 4;
export const H3_MAX_DURATION = 15;

export interface H3ShotConfig {
  raw: Record<string, unknown>;
  finalPrompt: string;
  promptGuidance: string;
  duration: number;
  ratio: string;
  assetsOnly: boolean;
}

/** Why the last generation kept the rule-based draft, or null when the AI prompt was used. */
export function h3FallbackReason(config: H3ShotConfig): string | null {
  if (config.raw.prompt_source !== "fallback") return null;
  if (config.finalPrompt !== String(config.raw.final_prompt ?? "")) return null;
  return String(config.raw.prompt_fallback_reason ?? "");
}

export function clampH3Duration(value: unknown, min = H3_MIN_DURATION, max = H3_MAX_DURATION) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return Math.min(Math.max(H3_DEFAULT_DURATION, min), max);
  return Math.min(Math.max(n, min), max);
}

export function parseH3ShotConfig(json: string | null | undefined): H3ShotConfig {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(json ?? "") || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed;
  } catch {
    raw = {};
  }
  return {
    raw,
    finalPrompt: String(raw.final_prompt ?? ""),
    promptGuidance: String(raw.prompt_guidance ?? ""),
    duration: clampH3Duration(raw.duration),
    ratio: typeof raw.ratio === "string" && raw.ratio ? raw.ratio : "16:9",
    assetsOnly: raw.h3_assets_only === true,
  };
}

/** Config JSON saved for an H3 Shots beat: multi-reference, render left out. */
export function serializeH3ShotConfig(config: H3ShotConfig): string {
  return JSON.stringify({
    ...config.raw,
    ...(config.finalPrompt !== String(config.raw.final_prompt ?? "")
      ? { prompt_source: "edited", prompt_fallback_reason: "" }
      : {}),
    mode: "multimodal_reference",
    mode_user_set: true,
    final_prompt: config.finalPrompt,
    prompt_guidance: config.promptGuidance.trim(),
    duration: config.duration,
    ratio: config.ratio,
    generate_audio: false,
    generate_audio_user_set: false,
    return_last_frame: false,
    human_review: false,
    human_review_user_set: false,
    h3_assets_only: true,
  });
}
