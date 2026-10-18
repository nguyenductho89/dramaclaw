// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ImageQuality, ImageSize } from '@/features/canvas/domain/canvasNodes';
import {
  parseAspectRatio,
  pickClosestAspectRatio,
} from '@/features/canvas/application/imageData';

/**
 * **Built-in fallback options** for image generation ratio/resolution/quality.
 *
 * After unified billing (#210) these three tiers are driven first by the media catalog (the admin-configurable `ratioOptions` /
 * `resolutionOptions` / `qualityOptions`); the constants here are only a fallback when the catalog declares nothing.
 *
 * Placed in a separate module rather than left in `ImageGenerationForm` because `useImageGenerationForm`
 * also needs the same fallback to compute `effectiveImageSize` / `effectiveAspectRatio` — two copies on each side
 * will sooner or later diverge, and the divergence shows up as "the ratio shown on the chip" differing from "the ratio sent on submit".
 */
export const IMAGE_ASPECT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: '1:1', label: '1:1' },
  { value: '9:16', label: '9:16' },
  { value: '16:9', label: '16:9' },
  { value: '3:4', label: '3:4' },
  { value: '4:3', label: '4:3' },
  { value: '3:2', label: '3:2' },
  { value: '2:3', label: '2:3' },
  { value: '4:5', label: '4:5' },
  { value: '5:4', label: '5:4' },
  { value: '21:9', label: '21:9' },
];

export const IMAGE_SIZE_OPTIONS: ReadonlyArray<ImageSize> = ['1K', '2K', '4K'];

export const IMAGE_QUALITY_OPTIONS: ReadonlyArray<{ value: ImageQuality; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Standard' },
  { value: 'high', label: 'High' },
];

/**
 * The ratio computed from an image's natural size is often in reduced form (such as 21:9 reduced to 7:3), which is not in the selectable list,
 * and showing it directly yields labels like "7:3" that are outside the list. Here it falls back to the "numerically closest selectable ratio"
 * — the chip label and the highlighted option in the dropdown are both based on it, keeping the two consistent.
 */
export function resolveNearestAspectOption(
  aspectRatio: string,
  options: ReadonlyArray<{ value: string; label: string }> = IMAGE_ASPECT_OPTIONS,
): { value: string; label: string } {
  const exact = options.find((option) => option.value === aspectRatio);
  if (exact) return exact;
  const candidates = options.filter((option) => option.value !== 'auto');
  const nearestValue = pickClosestAspectRatio(
    parseAspectRatio(aspectRatio),
    candidates.map((option) => option.value),
  );
  return (
    candidates.find((option) => option.value === nearestValue)
    ?? { value: aspectRatio, label: aspectRatio }
  );
}
