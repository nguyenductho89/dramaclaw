// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEstimatedProgress } from './useEstimatedProgress';

type NodeGenerationOverlayProps = {
  /** Generation start timestamp, used to simulate progress. When empty, timing starts from the mount moment. */
  startedAt?: number | null;
  /** Estimated total generation duration (milliseconds), used to simulate progress advance. */
  durationMs?: number;
  /** @deprecated Kept only for compatibility with old callers; the loading state no longer draws a background mask. */
  hasBackground?: boolean;
  /** Corner radius, following the node corner radius variable by default. */
  rounded?: string;
  /** The i18n key of the progress text, which needs to accept {{percent}} interpolation. Default "Generating X%". */
  messageKey?: string;
};

const DEFAULT_DURATION_MS = 60000;

/**
 * The unified loading overlay while a node is generating:
 * - the percentage is shown directly in the center, with no extra mask, icon or status text layered on
 */
export function NodeGenerationOverlay({
  startedAt = null,
  durationMs = DEFAULT_DURATION_MS,
  hasBackground: _hasBackground = false,
  rounded = 'rounded-[var(--node-radius)]',
  messageKey: _messageKey = 'canvas.generationProgress',
}: NodeGenerationOverlayProps) {
  // The estimation algorithm is extracted to useEstimatedProgress, shared with the storyboard cards/detail.
  const percent = useEstimatedProgress(startedAt, durationMs);

  return (
    <div
      className={`pointer-events-none absolute inset-0 z-10 flex items-center justify-center overflow-hidden ${rounded}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <div className="relative flex flex-col items-center text-center">
        <div className="flex items-baseline leading-none text-white">
          <span className="text-[34px] font-semibold tabular-nums tracking-tight">
            {percent}
          </span>
          <span className="ml-1 text-[15px] font-medium text-white/70">%</span>
        </div>
      </div>
    </div>
  );
}
