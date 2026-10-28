// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  MAX_EXTEND_CLIP_MS,
  MIN_EXTEND_CLIP_MS,
  defaultExtendRange,
  extendClipBoundMessage,
  extendNodeDisplayName,
  extendPromptPrefix,
  extendRangeNeedsTrim,
  formatTimecode,
  isExtendRangeSubmittable,
  resolveExtendRange,
} from '@/features/canvas/application/videoExtendClip';

describe('formatTimecode', () => {
  it('displays as mm:ss without truncating minutes', () => {
    expect(formatTimecode(0)).toBe('00:00');
    expect(formatTimecode(6_000)).toBe('00:06');
    expect(formatTimecode(75_000)).toBe('01:15');
  });
});

describe('defaultExtendRange', () => {
  it('long clips take the last 30s - extending continues from the end of this segment', () => {
    expect(defaultExtendRange(90_000)).toEqual({ startMs: 60_000, endMs: 90_000 });
  });

  it('falls back to the whole clip when under 30s', () => {
    expect(defaultExtendRange(15_070)).toEqual({ startMs: 0, endMs: 15_070 });
  });

  it('returns an empty range while duration is unknown, avoiding a negative start', () => {
    expect(defaultExtendRange(0)).toEqual({ startMs: 0, endMs: 0 });
    expect(defaultExtendRange(Number.NaN)).toEqual({ startMs: 0, endMs: 0 });
  });
});

describe('isExtendRangeSubmittable', () => {
  it('4s and 30s are both valid (closed interval)', () => {
    expect(isExtendRangeSubmittable({ startMs: 0, endMs: MIN_EXTEND_CLIP_MS })).toBe(true);
    expect(isExtendRangeSubmittable({ startMs: 0, endMs: MAX_EXTEND_CLIP_MS })).toBe(true);
  });

  it('1ms outside the range is not submittable', () => {
    expect(isExtendRangeSubmittable({ startMs: 0, endMs: 3_999 })).toBe(false);
    expect(isExtendRangeSubmittable({ startMs: 0, endMs: 30_001 })).toBe(false);
  });
});

describe('resolveExtendRange', () => {
  const anchorAt = (mode: 'start' | 'end' | 'move', startMs: number, endMs: number) => ({
    mode,
    startAtDown: startMs,
    endAtDown: endMs,
    anchorMs: mode === 'start' ? startMs : endMs,
  });

  it('dragging the end below 4s is clamped and reports min', () => {
    const next = resolveExtendRange(anchorAt('end', 10_000, 20_000), 11_000, 60_000);
    expect(next).toEqual({ startMs: 10_000, endMs: 14_000, bound: 'min' });
    expect(extendClipBoundMessage(next.bound)).toBe('The selected clip must be at least 4s');
  });

  it('dragging the end past 30s is clamped and reports max', () => {
    const next = resolveExtendRange(anchorAt('end', 10_000, 20_000), 55_000, 60_000);
    expect(next).toEqual({ startMs: 10_000, endMs: 40_000, bound: 'max' });
    expect(extendClipBoundMessage(next.bound)).toBe('The selected clip can\'t exceed 30s');
  });

  it('dragging to the clip end (not 30s) is not hitting the cap, so no hint', () => {
    const next = resolveExtendRange(anchorAt('end', 10_000, 20_000), 99_000, 25_000);
    expect(next).toEqual({ startMs: 10_000, endMs: 25_000, bound: null });
  });

  it('dragging the start clamps at both ends too: length first, position second', () => {
    expect(resolveExtendRange(anchorAt('start', 10_000, 50_000), 48_000, 60_000)).toEqual({
      startMs: 46_000,
      endMs: 50_000,
      bound: 'min',
    });
    expect(resolveExtendRange(anchorAt('start', 10_000, 50_000), 1_000, 60_000)).toEqual({
      startMs: 20_000,
      endMs: 50_000,
      bound: 'max',
    });
  });

  it('dragging the start past the head is only clamped by 0, which is not the 30s cap', () => {
    const next = resolveExtendRange(anchorAt('start', 5_000, 20_000), -3_000, 60_000);
    expect(next).toEqual({ startMs: 0, endMs: 20_000, bound: null });
  });

  it('moving the whole selection keeps its length and shows no hint at track ends', () => {
    const anchor = { mode: 'move' as const, startAtDown: 10_000, endAtDown: 20_000, anchorMs: 15_000 };
    expect(resolveExtendRange(anchor, 20_000, 60_000)).toEqual({
      startMs: 15_000,
      endMs: 25_000,
      bound: null,
    });
    expect(resolveExtendRange(anchor, 0, 60_000)).toEqual({
      startMs: 0,
      endMs: 10_000,
      bound: null,
    });
    expect(resolveExtendRange(anchor, 999_000, 60_000)).toEqual({
      startMs: 50_000,
      endMs: 60_000,
      bound: null,
    });
  });
});

describe('prefix and node name', () => {
  it('prefix includes the source video name and timecodes', () => {
    expect(extendPromptPrefix('Video (2)', { startMs: 0, endMs: 4_000 })).toBe(
      'Extend the 00:00-00:04 clip of Video (2): ',
    );
  });

  it('falls back when the source video has no name, avoiding an empty name', () => {
    expect(extendPromptPrefix('   ', { startMs: 0, endMs: 4_000 })).toBe(
      'Extend the 00:00-00:04 clip of the source video: ',
    );
    expect(extendNodeDisplayName('  ')).toBe('Extend video');
  });

  it('node name is "Extend + source video name"', () => {
    expect(extendNodeDisplayName('Video (2)')).toBe('Extend Video (2)');
  });
});

describe('extendRangeNeedsTrim', () => {
  it('source is 30.08s with only 25-30s selected: must trim, otherwise sending the whole clip exceeds the model's 30s cap', () => {
    expect(extendRangeNeedsTrim({ startMs: 25_000, endMs: 30_000 }, 30_080)).toBe(true);
  });

  it('does not re-encode when the selection is the whole clip (a frame or two off the edge counts)', () => {
    expect(extendRangeNeedsTrim({ startMs: 0, endMs: 15_070 }, 15_070)).toBe(false);
    expect(extendRangeNeedsTrim({ startMs: 20, endMs: 15_040 }, 15_070)).toBe(false);
  });

  it('treats an unknown source duration as needing a trim', () => {
    expect(extendRangeNeedsTrim({ startMs: 0, endMs: 5_000 }, null)).toBe(true);
  });

  it('an empty selection is not trimmed', () => {
    expect(extendRangeNeedsTrim({ startMs: 0, endMs: 0 }, 10_000)).toBe(false);
  });
});
