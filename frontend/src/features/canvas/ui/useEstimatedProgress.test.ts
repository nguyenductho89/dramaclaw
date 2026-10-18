// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useEstimatedProgress } from './useEstimatedProgress';

describe('useEstimatedProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('when startedAt is null it degrades to timing from mount, and renders 0% at the first instant', () => {
    const { result } = renderHook(() => useEstimatedProgress(null, 10_000));
    expect(result.current).toBe(0);
  });

  it('advances by exponential saturation of elapsed/duration, refreshing on a 120ms poll', () => {
    const startedAt = Date.now();
    const { result } = renderHook(() => useEstimatedProgress(startedAt, 10_000));
    expect(result.current).toBe(0);

    // 10s estimated duration, advanced by 2s. 2000ms is not an integer multiple of 120, and the last tick lands at
    // 1920ms (16 ticks), where the exponential saturation estimate is 23% -- this verifies both the polling rhythm and the algorithm.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current).toBe(23);
  });

  it('capped at 99%: even far beyond the estimated duration it never reaches 100% (real completion is triggered by the caller\'s isGenerating)', () => {
    const startedAt = Date.now();
    const { result } = renderHook(() => useEstimatedProgress(startedAt, 1_000));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe(99);
  });

  it('durationMs is clamped to a minimum of 1000ms (so a tiny value does not make progress jump to the cap instantly)', () => {
    const startedAt = Date.now();
    const { result } = renderHook(() => useEstimatedProgress(startedAt, 10));
    act(() => {
      vi.advanceTimersByTime(120);
    });
    // duration is clamped to 1000ms: 120ms by exponential saturation is 15%, rather than being pushed to the cap instantly by durationMs=10.
    expect(result.current).toBe(15);
  });

  it('clears the polling timer after unmount (no lingering setInterval)', () => {
    const startedAt = Date.now();
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
    const { unmount } = renderHook(() => useEstimatedProgress(startedAt, 10_000));
    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
