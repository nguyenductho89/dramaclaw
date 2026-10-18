// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useState } from 'react';

/**
 * A time-based estimate of generation progress (not the backend's real progress; the backend currently sends no step-by-step progress events): by
 * `startedAt` + the estimated `durationMs`, an exponential saturation estimate approaching 99% asymptotically (the real "done"
 * is triggered by the caller's `isGenerating` turning false). Refreshed by polling every 120ms.
 *
 * Extracted verbatim from the internal algorithm of {@link ./NodeGenerationOverlay.tsx} (the big number of the workflow node overlay),
 * and the storyboard card/detail placeholders reuse the same estimate, avoiding the two implementations drifting.
 *
 * @param startedAt generation start timestamp (epoch ms); when empty it falls back to the hook's mount moment -
 *   the same semantics as the original NodeGenerationOverlay's `mountedAt` fallback.
 * @param durationMs estimated total generation duration (milliseconds), clamped to at least 1000ms.
 * @param paused pause polling (pass true when the storyboard is hidden by kept-alive). After the storyboard is hidden the data source is
 *   frozen as a whole, and cards stay at the "generating" frame forever - without stopping the timer, this 120ms timer would never stop
 *   while the user switches back to the workflow to work, needlessly re-rendering the hidden view 8 times a second.
 */
export function useEstimatedProgress(
  startedAt: number | null,
  durationMs: number,
  paused = false,
): number {
  const [now, setNow] = useState(() => Date.now());
  const [mountedAt] = useState(() => Date.now());

  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 120);
    return () => {
      window.clearInterval(timer);
    };
  }, [paused]);

  return useMemo(() => {
    const begin = typeof startedAt === 'number' ? startedAt : mountedAt;
    const duration = Math.max(1000, durationMs);
    const elapsed = Math.max(0, now - begin);
    const progress = 0.995 * (1 - Math.exp((-1.4 * elapsed) / duration));
    return Math.min(99, Math.floor(progress * 100));
  }, [durationMs, mountedAt, now, startedAt]);
}
