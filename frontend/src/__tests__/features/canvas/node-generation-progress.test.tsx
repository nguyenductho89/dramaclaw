// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Behavior contract of the node generation progress curve.
 *
 * The old implementation was `Math.min(elapsed / duration, 0.96)`: it hit a hard ceiling once the estimated duration was reached, while real
 * generation is often a bit slower than estimated, so it stalled at 96% almost every time. After switching to an exponential saturation curve, the point where it stops
 * moves out to about 3.8 times the estimated duration.
 *
 * "No more change after 99%" is locked down here too -- it is a cost the current implementation accepts on purpose, not a bug that slipped
 * through; if it is ever changed to an indeterminate waiting animation, this case should be changed explicitly rather than silently going stale.
 */
import { render, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NodeGenerationOverlay } from '@/features/canvas/ui/NodeGenerationOverlay';

const DURATION_MS = 60_000;

function renderProgress() {
  const { container } = render(
    <NodeGenerationOverlay startedAt={0} durationMs={DURATION_MS} />,
  );
  const bar = container.querySelector('[role="progressbar"]');
  if (!bar) throw new Error('progressbar not rendered');
  return () => Number(bar.getAttribute('aria-valuenow'));
}

/** Advances to the moment of "n times the estimated duration". */
function advanceToMultiple(multiple: number) {
  act(() => {
    // The component re-renders driven by a 120ms interval, so one tick is enough; step back one tick and then advance,
    // so that the landing point is exactly multiple x estimated duration.
    vi.setSystemTime(multiple * DURATION_MS - 120);
    vi.advanceTimersByTime(120);
  });
}

describe('NodeGenerationOverlay progress curve', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('progress within the estimated duration is conservative and does not stick to a high value early', () => {
    const percent = renderProgress();
    expect(percent()).toBe(0);

    advanceToMultiple(0.5);
    expect(percent()).toBe(50);

    // About 75% when the full estimated duration has elapsed, leaving ample headroom for the common overrun.
    advanceToMultiple(1);
    expect(percent()).toBe(74);
  });

  it('keeps advancing past the estimated duration, unlike the old linear version that hit the ceiling at 1x', () => {
    const percent = renderProgress();

    advanceToMultiple(2);
    expect(percent()).toBe(93);

    advanceToMultiple(3);
    expect(percent()).toBe(98);
  });

  it('settles at 99% after about 3.8x the estimated duration and no longer changes afterwards', () => {
    const percent = renderProgress();

    advanceToMultiple(3.5);
    expect(percent()).toBe(98);

    advanceToMultiple(4);
    expect(percent()).toBe(99);

    // Waiting another order of magnitude still gives 99 -- this is an intentional cap, not a miscalculated curve.
    advanceToMultiple(40);
    expect(percent()).toBe(99);
  });

  it('never shows 100% -- completion is expressed by the outside unmounting the overlay', () => {
    const percent = renderProgress();
    for (const multiple of [1, 5, 20, 100, 1000]) {
      advanceToMultiple(multiple);
      expect(percent()).toBeLessThan(100);
    }
  });

  it('progress is monotonically non-decreasing', () => {
    const percent = renderProgress();
    let previous = percent();
    for (let multiple = 0.2; multiple <= 6; multiple += 0.2) {
      advanceToMultiple(multiple);
      const current = percent();
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});
