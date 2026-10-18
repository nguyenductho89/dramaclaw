// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';
import {
  MASK_ALPHA_THRESHOLD,
  MASK_HIGHLIGHT_RGBA,
  binarizeMaskToRed,
} from './mask-highlight';

/** Builds an RGBA buffer containing a single pixel. */
function pixel(r: number, g: number, b: number, a: number): Uint8ClampedArray {
  return new Uint8ClampedArray([r, g, b, a]);
}

describe('binarizeMaskToRed', () => {
  const { r, g, b, a } = MASK_HIGHLIGHT_RGBA;

  it('single brush stroke (alpha 140) -> uniform semi-transparent red', () => {
    const d = pixel(239, 68, 68, 140); // 0.55 brush
    binarizeMaskToRed(d);
    expect([...d]).toEqual([r, g, b, a]);
  });

  it('overlap area (alpha 203) produces exactly the same output as a single stroke - proves uneven shading is gone', () => {
    const single = pixel(239, 68, 68, 140);
    const overlap = pixel(239, 68, 68, 203); // ~0.80 segment-joint overlap
    binarizeMaskToRed(single);
    binarizeMaskToRed(overlap);
    expect([...overlap]).toEqual([...single]);
    expect([...overlap]).toEqual([r, g, b, a]);
  });

  it('unpainted pixel (alpha 0) -> fully transparent', () => {
    const d = pixel(0, 0, 0, 0);
    binarizeMaskToRed(d);
    expect(d[3]).toBe(0);
  });

  it('anti-aliased edge below the threshold -> fully transparent', () => {
    const d = pixel(239, 68, 68, MASK_ALPHA_THRESHOLD - 1);
    binarizeMaskToRed(d);
    expect(d[3]).toBe(0);
  });

  it('whatever the original color, painted areas are rewritten to red', () => {
    const d = pixel(12, 200, 99, 60);
    binarizeMaskToRed(d);
    expect([...d]).toEqual([r, g, b, a]);
  });

  it('mixed multi-pixel buffer: painted areas become uniform red, the rest transparent', () => {
    const d = new Uint8ClampedArray([
      239, 68, 68, 140, // painted
      239, 68, 68, 203, // overlap
      0, 0, 0, 0, // empty
      1, 2, 3, 4, // below threshold
    ]);
    binarizeMaskToRed(d);
    expect([...d]).toEqual([
      r, g, b, a,
      r, g, b, a,
      0, 0, 0, 0,
      1, 2, 3, 0,
    ]);
  });
});
