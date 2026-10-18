// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * The unified resolution entry for media model capabilities.
 *
 * Which resolutions / aspect ratios / quality tiers each model supports are all delivered by the backend "media models" config,
 * entering the frontend via `/freezone/image|video/models`. All generation / editing panels on the canvas
 * must read from here and may not each maintain a constant - otherwise the frontend would not follow when the backend changes the config.
 *
 * The FALLBACK_* constants here are only a fallback when the catalog endpoint fails to fetch or a model entry does not declare that capability,
 * and are not the source of truth for model capabilities.
 */

/** Fields related to "capabilities" in a catalog entry; both image and video entries satisfy this shape. */
export interface MediaModelCapabilities {
  resolutionOptions?: string[] | null;
  ratioOptions?: string[] | null;
  qualityOptions?: string[] | null;
}

/** Fallback tiers when the catalog does not declare resolutions. */
export const FALLBACK_IMAGE_SIZE_OPTIONS: readonly string[] = ['1K', '2K', '4K'];

/** Fallback tiers when the catalog does not declare aspect ratios. */
export const FALLBACK_IMAGE_ASPECT_OPTIONS: readonly string[] = [
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '21:9',
];

/** Video fallback tiers when the catalog does not declare resolutions. */
export const FALLBACK_VIDEO_RESOLUTION_OPTIONS: readonly string[] = [
  '480p',
  '720p',
  '1080p',
];

/**
 * Video fallback tiers when the catalog does not declare aspect ratios.
 *
 * The first entry `auto` means following the first frame / reference image, which is frontend semantics rather than a capability of any model; once the catalog
 * declares ratioOptions it goes entirely by the catalog and no longer injects auto.
 */
export const FALLBACK_VIDEO_ASPECT_OPTIONS: readonly string[] = [
  'auto',
  '16:9',
  '4:3',
  '1:1',
  '3:4',
  '9:16',
  '21:9',
];

function normalizeOptions(values: string[] | null | undefined): string[] {
  return (values ?? []).map((item) => item.trim()).filter(Boolean);
}

/**
 * Resolutions are always displayed in lowercase in the UI.
 *
 * For display only, not changing the value saved on the node, the billing tier, or the raw value submitted to the backend; this also stays compatible with
 * `2K` / `1080P` that still exist in the old catalog.
 */
export function formatResolutionLabel(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeRatioOptions(values: string[] | null | undefined): string[] {
  return [
    ...new Set(
      normalizeOptions(values).map((item) =>
        ['auto', 'adaptive'].includes(item.toLowerCase()) ? 'auto' : item,
      ),
    ),
  ];
}

/** The resolution tiers the selected model supports; falls back if the catalog has none configured. */
export function resolveModelSizeOptions(
  model: MediaModelCapabilities | null | undefined,
  fallback: readonly string[] = FALLBACK_IMAGE_SIZE_OPTIONS,
): string[] {
  const configured = normalizeOptions(model?.resolutionOptions);
  return configured.length > 0 ? configured : [...fallback];
}

/** The aspect ratios the selected model supports; falls back if the catalog has none configured. */
export function resolveModelAspectOptions(
  model: MediaModelCapabilities | null | undefined,
  fallback: readonly string[] = FALLBACK_IMAGE_ASPECT_OPTIONS,
): string[] {
  const configured = normalizeRatioOptions(model?.ratioOptions);
  return configured.length > 0 ? configured : [...fallback];
}

/**
 * The quality tiers the selected model supports.
 *
 * Unlike resolution / ratio, quality has **no fallback**: if the catalog does not declare it, this model does not accept the
 * quality parameter, and sending quality then would be rejected by the gateway.
 */
export function resolveModelQualityOptions(
  model: MediaModelCapabilities | null | undefined,
): string[] {
  return normalizeOptions(model?.qualityOptions);
}

/**
 * Whether the model accepts the quality parameter.
 *
 * The criterion is whether `qualityOptions` is configured in the catalog, not what the model name looks like - when the backend adds a model
 * supporting quality, the frontend does not need code changes.
 */
export function modelSupportsQuality(
  model: MediaModelCapabilities | null | undefined,
): boolean {
  return resolveModelQualityOptions(model).length > 0;
}

/**
 * Converge the selected value into the range of values the current model allows.
 *
 * After switching models the old selection may no longer be among the new model's tiers, in which case fall back to the first available tier,
 * avoiding submitting a value the model does not support to the backend.
 */
export function pickAllowedOption(
  current: string | null | undefined,
  options: readonly string[],
  fallback?: string,
): string {
  const normalized = String(current ?? '').trim();
  if (normalized && options.includes(normalized)) return normalized;
  const caseInsensitive = normalized
    ? options.find((option) => option.toLowerCase() === normalized.toLowerCase())
    : undefined;
  return caseInsensitive ?? options[0] ?? fallback ?? '';
}
