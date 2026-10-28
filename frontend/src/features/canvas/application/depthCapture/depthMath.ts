// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Pure computation for depth motion capture: sizes, normalization range, grayscale mapping. Shared by the worker and unit tests; never touches the DOM.
//
// The model outputs relative inverse depth (larger for near), with a different scale on every frame. Per-frame min/max normalization would make the whole
// video's brightness jump around, so the range uses the 1%/99% percentiles to resist outliers and is then smoothed across frames with an EMA.

export const DEPTH_MAX_OUTPUT_HEIGHT = 1080;
/** Inference canvas height: the model downscales to 518 internally anyway, so feeding a larger image only adds pointless interpolation. */
export const DEPTH_INFERENCE_HEIGHT = 518;
export const DEPTH_MAX_DURATION_SEC = 60;
export const DEPTH_RANGE_ALPHA = 0.1;

const MAX_RANGE_SAMPLES = 16384;

export interface FrameSize {
  width: number;
  height: number;
}

export interface DepthRange {
  lo: number;
  hi: number;
}

function evenFloor(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

/** Cap the height at maxHeight (keep it if the source is smaller) and scale the width proportionally; both sides are made even (H.264 requires it). */
export function fitHeight(srcWidth: number, srcHeight: number, maxHeight: number): FrameSize {
  const height = evenFloor(Math.min(srcHeight, maxHeight));
  const width = evenFloor((srcWidth * height) / srcHeight);
  return { width, height };
}

/** Take percentiles after uniform-stride sampling; with hundreds of thousands of pixels per frame, a full sort is unnecessary. */
export function percentileRange(
  values: ArrayLike<number>,
  lowQ = 0.01,
  highQ = 0.99,
): DepthRange {
  const total = values.length;
  if (total === 0) {
    return { lo: 0, hi: 0 };
  }
  const step = Math.max(1, Math.floor(total / MAX_RANGE_SAMPLES));
  const count = Math.ceil(total / step);
  const samples = new Float32Array(count);
  for (let i = 0, j = 0; i < total; i += step, j += 1) {
    samples[j] = values[i];
  }
  samples.sort();
  const pick = (q: number) =>
    samples[Math.min(count - 1, Math.max(0, Math.round(q * (count - 1))))];
  return { lo: pick(lowQ), hi: pick(highQ) };
}

/** Take the first frame's values directly; after that lo/hi each move toward the new frame by alpha. */
export function smoothRange(
  prev: DepthRange | null,
  next: DepthRange,
  alpha = DEPTH_RANGE_ALPHA,
): DepthRange {
  if (!prev) {
    return next;
  }
  return {
    lo: prev.lo + alpha * (next.lo - prev.lo),
    hi: prev.hi + alpha * (next.hi - prev.hi),
  };
}

/** Map linearly to 0–255 grayscale and write into RGBA; Uint8ClampedArray handles clamping and rounding itself. */
export function depthToGray(
  depth: ArrayLike<number>,
  range: DepthRange,
  rgba: Uint8ClampedArray,
): void {
  const span = range.hi - range.lo;
  const scale = span > 1e-6 ? 255 / span : 0;
  for (let i = 0; i < depth.length; i += 1) {
    const value = (depth[i] - range.lo) * scale;
    const offset = i * 4;
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }
}
