// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Loader2, RotateCcw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { TFn } from '@/lib/i18n-types';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { captureVideoFrames } from '@/features/canvas/application/videoFrameStrip';
import {
  MAX_EXTEND_CLIP_MS,
  MIN_EXTEND_CLIP_MS,
  defaultExtendRange,
  extendClipBoundMessage,
  isExtendRangeSubmittable,
  resolveExtendRange,
  type ExtendClipBound,
  type ExtendDragAnchor,
  type ExtendDragMode,
  type ExtendClipRange,
} from '@/features/canvas/application/videoExtendClip';
import { CANVAS_NODE_OPS_PANEL_CLASS } from '@/features/canvas/ui/nodeFrameStyles';

interface VideoExtendPanelProps {
  videoUrl: string;
  durationMs: number | null | undefined;
  isSubmitting?: boolean;
  onExit: () => void;
  onConfirm: (range: ExtendClipRange) => void;
}

/** Same conversion as VideoClipPanel: the track gets pixels by duration, then is clamped to upper and lower bounds. */
const PX_PER_SECOND = 14;
const MIN_TRACK_PX = 280;
const MAX_TRACK_PX = 960;
const THUMB_CELL_PX = 100;
const MIN_THUMBS = 6;
const MAX_THUMBS = 16;
const KEY_STEP_MS = 100;
const KEY_STEP_COARSE_MS = 1000;
/** How long the hit-the-boundary hint stays. Long enough to read one line, short enough not to block the next drag. */
const BOUND_HINT_MS = 2200;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** `15.07 s`. Two decimals match the design spec -- extension is sensitive to lead-in length, and rounding would hide that it just passed 4s. */
function formatDuration(ms: number, t: TFn): string {
  return t('canvas.videoExtend.durationSeconds', { seconds: (ms / 1000).toFixed(2) });
}

/**
 * Pre-selection video segment track for "Smart extend": attached under the **source** video node, cutting a single segment, 4-30s.
 *
 * The difference from the clip bar is more than a few missing buttons: clipping cuts the selected segment out as the result, while extending uses the selected
 * segment as input, so there is no "replace in place after submit" here; confirming creates a new downstream node
 * (see VideoNode's handleExtendConfirm). The track itself writes no node data and the selection lives only in
 * local component state -- users may drag a dozen times before deciding, and writing the store on every drag would flush the undo stack.
 */
export const VideoExtendPanel = memo(function VideoExtendPanel({
  videoUrl,
  durationMs,
  isSubmitting = false,
  onExit,
  onConfirm,
}: VideoExtendPanelProps) {
  const { t } = useTranslation();
  const totalMs = useMemo(() => {
    if (typeof durationMs === 'number' && durationMs > 0) return durationMs;
    return null;
  }, [durationMs]);

  const trackMinWidth = useMemo(() => {
    if (!totalMs) return MIN_TRACK_PX;
    return clamp(Math.round((totalMs / 1000) * PX_PER_SECOND), MIN_TRACK_PX, MAX_TRACK_PX);
  }, [totalMs]);

  const thumbCount = useMemo(
    () => clamp(Math.round(trackMinWidth / THUMB_CELL_PX), MIN_THUMBS, MAX_THUMBS),
    [trackMinWidth],
  );

  const [range, setRange] = useState<ExtendClipRange>(() => defaultExtendRange(totalMs ?? 0));
  const rangeRef = useRef(range);
  rangeRef.current = range;
  // The media duration is read asynchronously (durationMs is null until metadata arrives); a default
  // selection only makes sense once it is known. So recompute along with totalMs instead of reading it once at mount.
  useEffect(() => {
    if (!totalMs) return;
    setRange(defaultExtendRange(totalMs));
  }, [totalMs]);

  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<ExtendDragAnchor | null>(null);
  const [dragMode, setDragMode] = useState<ExtendDragMode | null>(null);
  const [boundHint, setBoundHint] = useState<ExtendClipBound>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [thumbsState, setThumbsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [thumbsAttempt, setThumbsAttempt] = useState(0);

  // The hint means "you just hit the edge", not a persistent state: if it does not dismiss itself, it lingers after the user lets go
  // and covers the next normal drag.
  useEffect(() => {
    if (!boundHint) return;
    const timer = setTimeout(() => setBoundHint(null), BOUND_HINT_MS);
    return () => clearTimeout(timer);
  }, [boundHint]);

  useEffect(() => {
    let cancelled = false;
    setThumbs([]);
    setThumbsState('loading');
    const resolved = resolveImageDisplayUrl(videoUrl);
    if (!resolved) {
      setThumbsState('error');
      return;
    }
    void captureVideoFrames(resolved, thumbCount)
      .then((frames) => {
        if (cancelled) return;
        setThumbs(frames);
        setThumbsState('ready');
      })
      .catch((error) => {
        console.warn('[video-extend] thumbnail extraction failed', error);
        if (!cancelled) setThumbsState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [thumbCount, videoUrl, thumbsAttempt]);

  useEffect(() => {
    if (!dragMode || !totalMs) return;

    let frame = 0;
    let pendingX: number | null = null;

    const apply = () => {
      frame = 0;
      const anchor = dragRef.current;
      const track = trackRef.current;
      if (pendingX === null || !anchor || !track) return;
      const rect = track.getBoundingClientRect();
      const ratio = clamp((pendingX - rect.left) / Math.max(rect.width, 1), 0, 1);
      pendingX = null;
      const next = resolveExtendRange(anchor, Math.round(ratio * totalMs), totalMs);
      setRange({ startMs: next.startMs, endMs: next.endMs });
      if (next.bound) setBoundHint(next.bound);
    };

    const handlePointerMove = (event: PointerEvent) => {
      pendingX = event.clientX;
      if (!frame) frame = requestAnimationFrame(apply);
    };

    const handlePointerUp = () => {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      apply(); // Flush the displacement of the last frame not yet painted, so it does not snap back one step on release
      dragRef.current = null;
      setDragMode(null);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [dragMode, totalMs]);

  const beginDrag = useCallback(
    (mode: ExtendDragMode, event: ReactPointerEvent<HTMLElement>) => {
      if (isSubmitting || !totalMs) return;
      const track = trackRef.current;
      if (!track) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = track.getBoundingClientRect();
      const ratio = clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
      const current = rangeRef.current;
      dragRef.current = {
        mode,
        startAtDown: current.startMs,
        endAtDown: current.endMs,
        anchorMs: Math.round(ratio * totalMs),
      };
      setDragMode(mode);
    },
    [isSubmitting, totalMs],
  );

  const startDrag = useCallback(
    (mode: ExtendDragMode) => (event: ReactPointerEvent<HTMLDivElement>) => beginDrag(mode, event),
    [beginDrag],
  );

  const handleKeyDown = useCallback(
    (edge: 'start' | 'end') => (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (isSubmitting || !totalMs) return;
      const step = event.shiftKey ? KEY_STEP_COARSE_MS : KEY_STEP_MS;
      const current = rangeRef.current;
      let target: number | null = null;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
        target = (edge === 'start' ? current.startMs : current.endMs) - step;
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
        target = (edge === 'start' ? current.startMs : current.endMs) + step;
      } else if (event.key === 'Home') {
        target = edge === 'start' ? 0 : current.startMs;
      } else if (event.key === 'End') {
        target = edge === 'start' ? current.endMs : totalMs;
      }
      if (target === null) return;
      event.preventDefault();
      event.stopPropagation();
      // The keyboard uses the same conversion as the pointer, and the boundary hint still pops up: holding an arrow key against the edge needs feedback.
      const next = resolveExtendRange(
        { mode: edge, startAtDown: current.startMs, endAtDown: current.endMs, anchorMs: target },
        target,
        totalMs,
      );
      setRange({ startMs: next.startMs, endMs: next.endMs });
      if (next.bound) setBoundHint(next.bound);
    },
    [isSubmitting, totalMs],
  );

  const startPct = totalMs ? (range.startMs / totalMs) * 100 : 0;
  const endPct = totalMs ? (range.endMs / totalMs) * 100 : 100;
  const selectionMs = Math.max(0, range.endMs - range.startMs);
  const canConfirm = Boolean(totalMs) && isExtendRangeSubmittable(range) && !isSubmitting;

  const handleConfirm = useCallback(() => {
    if (!canConfirm) return;
    onConfirm(rangeRef.current);
  }, [canConfirm, onConfirm]);

  // Lay out as many cells as frames extracted; filling the rest with black cells would make people think the second half of the video is black.
  const cellCount = thumbs.length > 0 ? thumbs.length : thumbCount;
  const chipLeftPct = clamp((startPct + endPct) / 2, 8, 92);
  const hintMessage = extendClipBoundMessage(boundHint);
  // The hint hangs under the end that was hit: left-aligned when dragging the left handle, right-aligned for the right handle, so the eye does not have to search.
  const hintLeftPct = clamp(dragMode === 'start' ? startPct : endPct, 4, 96);

  return (
    <div className="relative">
      <div
        className={`nodrag nowheel flex items-center gap-2 rounded-[var(--node-radius)] ${CANVAS_NODE_OPS_PANEL_CLASS} p-2`}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-dark/80 transition-colors hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-55"
          onClick={onExit}
          disabled={isSubmitting}
          aria-label={t('canvas.videoExtend.exit')}
          title={t('canvas.videoExtend.exit')}
        >
          <X className="h-4 w-4" />
        </button>

        {/* Wrap the track in one more layer: the hint must pop up next to the end that was hit, and the percentage only lines up relative to
            the track itself; the track is overflow-hidden, so a hint inside it would be clipped. */}
        <div className="relative flex-1" style={{ minWidth: trackMinWidth }}>
        <div
          ref={trackRef}
          className="relative h-14 w-full select-none overflow-hidden rounded-md bg-bg-dark/80"
        >
          <div className="absolute inset-0 flex">
            {Array.from({ length: cellCount }).map((_, index) => (
              <div
                key={index}
                className="h-full flex-1 bg-bg-dark/70"
                style={{
                  backgroundImage: thumbs[index] ? `url(${thumbs[index]})` : undefined,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                }}
              />
            ))}
          </div>

          {thumbsState === 'loading' && thumbs.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-text-muted/70">
              {t('canvas.videoClip.extractingFrames')}
            </div>
          )}
          {/* z-30 + pointer-events-none: the retry button must sit above the selection box to be clickable,
              but the whole overlay must not swallow handle drags. */}
          {thumbsState === 'error' && (
            <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center gap-1.5 text-[11px] text-text-muted/70">
              <span>{t('canvas.videoClip.framesFailed')}</span>
              <button
                type="button"
                className="pointer-events-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-text-dark/80 transition-colors hover:bg-white/[0.1] hover:text-white"
                onClick={() => setThumbsAttempt((value) => value + 1)}
                onPointerDown={(event) => event.stopPropagation()}
                aria-label={t('canvas.videoClip.retryExtract')}
              >
                <RotateCcw className="h-3 w-3" />
                {t('common.retry')}
              </button>
            </div>
          )}

          {/* Dim outside the selection */}
          <div
            className="pointer-events-none absolute inset-y-0 left-0 bg-black/55"
            style={{ width: `${startPct}%` }}
          />
          <div
            className="pointer-events-none absolute inset-y-0 right-0 bg-black/55"
            style={{ width: `${100 - endPct}%` }}
          />

          {/* No fill inside the selection: that is exactly where you pick "where to continue from" against the frames. Only the handles
              at both ends are blue, matching the look of the clip re-shoot track. */}
          <div
            className={`absolute inset-y-0 z-10 ${
              isSubmitting ? '' : dragMode === 'move' ? 'cursor-grabbing' : 'cursor-grab'
            }`}
            style={{ left: `${startPct}%`, right: `${100 - endPct}%` }}
            onPointerDown={startDrag('move')}
          >
            <div
              role="slider"
              tabIndex={isSubmitting ? -1 : 0}
              aria-label={t('canvas.videoExtend.startHandle')}
              aria-valuemin={0}
              aria-valuemax={totalMs ?? 0}
              aria-valuenow={range.startMs}
              aria-valuetext={formatDuration(range.startMs, t)}
              // after:* is the handle's invisible hit area: visually still a thin bar, but 28px wide to click.
              className="absolute inset-y-0 left-0 flex w-3 cursor-ew-resize items-center justify-center rounded-l-md bg-[#2f6bff] outline-none after:absolute after:inset-y-0 after:-left-2 after:-right-2 after:content-[''] focus-visible:ring-2 focus-visible:ring-sky-400"
              onPointerDown={startDrag('start')}
              onKeyDown={handleKeyDown('start')}
              title={t('canvas.videoClip.dragStart')}
            >
              <div className="pointer-events-none h-4 w-[2px] rounded-full bg-white/85" />
            </div>
            <div
              role="slider"
              tabIndex={isSubmitting ? -1 : 0}
              aria-label={t('canvas.videoExtend.endHandle')}
              aria-valuemin={0}
              aria-valuemax={totalMs ?? 0}
              aria-valuenow={range.endMs}
              aria-valuetext={formatDuration(range.endMs, t)}
              className="absolute inset-y-0 right-0 flex w-3 cursor-ew-resize items-center justify-center rounded-r-md bg-[#2f6bff] outline-none after:absolute after:inset-y-0 after:-left-2 after:-right-2 after:content-[''] focus-visible:ring-2 focus-visible:ring-sky-400"
              onPointerDown={startDrag('end')}
              onKeyDown={handleKeyDown('end')}
              title={t('canvas.videoClip.dragEnd')}
            >
              <div className="pointer-events-none h-4 w-[2px] rounded-full bg-white/85" />
            </div>
          </div>

          {/* duration chip */}
          <div
            className="pointer-events-none absolute top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-md bg-black/70 px-2 py-0.5 text-[12px] font-medium tabular-nums text-white"
            style={{ left: `${chipLeftPct}%` }}
          >
            {formatDuration(selectionMs, t)}
          </div>
        </div>

        {hintMessage && (
          <div
            className="pointer-events-none absolute top-full z-30 mt-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-black/85 px-3 py-2 text-[12px] text-white shadow-lg"
            style={{ left: `${hintLeftPct}%` }}
            role="status"
          >
            {hintMessage}
          </div>
        )}
        </div>

        <button
          type="button"
          className="flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full px-3 text-sm font-medium text-text-dark transition-colors hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:text-text-muted/50 disabled:hover:bg-transparent"
          onClick={handleConfirm}
          disabled={!canConfirm}
          title={
            totalMs && totalMs < MIN_EXTEND_CLIP_MS
              ? t('canvas.videoExtend.tooShort', { seconds: MIN_EXTEND_CLIP_MS / 1000 })
              : selectionMs > MAX_EXTEND_CLIP_MS
                ? (extendClipBoundMessage('max') ?? undefined)
                : undefined
          }
        >
          {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {t('canvas.videoExtend.confirm')}
        </button>
      </div>
    </div>
  );
});
