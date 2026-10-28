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
import { Check, Loader2, Repeat, RotateCcw, Type as TypeIcon, VolumeX, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { captureVideoFrames } from '@/features/canvas/application/videoFrameStrip';
import { CANVAS_NODE_OPS_PANEL_CLASS } from '@/features/canvas/ui/nodeFrameStyles';

interface VideoClipPanelProps {
  videoUrl: string;
  durationMs: number | null | undefined;
  clipStartMs: number | null | undefined;
  clipEndMs: number | null | undefined;
  isSubmitting?: boolean;
  onChange: (patch: { clipStartMs?: number | null; clipEndMs?: number | null }) => void;
  onExit: () => void;
  onSubmit: (start: number, end: number) => void;
}

const MIN_CLIP_MS = 200;
/**
 * Allot track pixels by duration rather than always following the node width.
 *
 * At a fixed width, a 44s clip spread over 200px is 220ms/px: a one-pixel hand tremor skips
 * nearly half a second, so snapping to a beat is impossible. Give it enough pixel density, then clamp it
 * between bounds: very short clips do not shrink to a sliver, and very long ones do not stretch the panel off screen.
 */
const PX_PER_SECOND = 14;
const MIN_TRACK_PX = 260;
const MAX_TRACK_PX = 960;
/** Target width of one thumbnail cell: h-14 (56px) at 16:9 is about this; a wider track just tiles more cells. */
const THUMB_CELL_PX = 100;
const MIN_THUMBS = 6;
const MAX_THUMBS = 16;
/** Arrow-key single step; hold Shift for a big step. */
const KEY_STEP_MS = 100;
const KEY_STEP_COARSE_MS = 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  if (seconds >= 10) return `${seconds.toFixed(1)} s`;
  return `${seconds.toFixed(2)} s`;
}

type DragMode = 'start' | 'end' | 'move';

interface DragState {
  mode: DragMode;
  rect: DOMRect;
  /** Range at the moment of pointer-down; move mode uses it to keep the duration unchanged. */
  startAtDown: number;
  endAtDown: number;
  /** Timecode under the pointer at pointer-down; move mode uses it to compute the offset. */
  anchorMs: number;
}

export const VideoClipPanel = memo(function VideoClipPanel({
  videoUrl,
  durationMs,
  clipStartMs,
  clipEndMs,
  isSubmitting = false,
  onChange,
  onExit,
  onSubmit,
}: VideoClipPanelProps) {
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

  const committedStartMs = useMemo(() => {
    if (typeof clipStartMs === 'number') return clamp(clipStartMs, 0, totalMs ?? clipStartMs);
    return 0;
  }, [clipStartMs, totalMs]);

  const committedEndMs = useMemo(() => {
    if (typeof clipEndMs === 'number') return clamp(clipEndMs, 0, totalMs ?? clipEndMs);
    return totalMs ?? 0;
  }, [clipEndMs, totalMs]);

  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [dragMode, setDragMode] = useState<DragMode | null>(null);
  /**
   * While dragging, the range stays local to the component and is only written back to the node on release.
   *
   * `onChange` ends up in `updateNodeData`, which pushes a whole canvas snapshot on every call and clears the
   * redo stack. Called at pointermove frequency, a single drag could push in hundreds of snapshots and the undo history
   * would be wiped out. A local draft plus commit on release leaves a single undo entry per drag.
   */
  const [draft, setDraft] = useState<{ start: number; end: number } | null>(null);
  /** Mirror kept in sync with the draft: pointerup must get the final value inside the same event, without waiting for state. */
  const draftRef = useRef<{ start: number; end: number } | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [thumbsState, setThumbsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [thumbsAttempt, setThumbsAttempt] = useState(0);

  const startMs = draft ? draft.start : committedStartMs;
  const endMs = draft ? draft.end : committedEndMs;

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
        console.warn('[video-clip] thumbnail extraction failed', error);
        if (!cancelled) setThumbsState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [thumbCount, videoUrl, thumbsAttempt]);

  const commit = useCallback(
    (next: { start: number; end: number }) => {
      const patch: { clipStartMs?: number; clipEndMs?: number } = {};
      if (next.start !== committedStartMs) patch.clipStartMs = next.start;
      if (next.end !== committedEndMs) patch.clipEndMs = next.end;
      // One drag = one updateNodeData = one undo entry. Even if both ends moved, only one patch is sent.
      if (patch.clipStartMs !== undefined || patch.clipEndMs !== undefined) onChange(patch);
    },
    [committedEndMs, committedStartMs, onChange],
  );

  /** Convert a pointer position into a range. Pure function so keyboard and pointer share the same clamping rules. */
  const resolveRange = useCallback(
    (drag: DragState, pointerMs: number, total: number) => {
      if (drag.mode === 'start') {
        return {
          start: clamp(pointerMs, 0, Math.max(0, drag.endAtDown - MIN_CLIP_MS)),
          end: drag.endAtDown,
        };
      }
      if (drag.mode === 'end') {
        return {
          start: drag.startAtDown,
          end: clamp(pointerMs, Math.min(drag.startAtDown + MIN_CLIP_MS, total), total),
        };
      }
      const length = drag.endAtDown - drag.startAtDown;
      const start = clamp(drag.startAtDown + (pointerMs - drag.anchorMs), 0, Math.max(0, total - length));
      return { start, end: start + length };
    },
    [],
  );

  useEffect(() => {
    if (!dragMode || !totalMs) return;

    let frame = 0;
    let pendingX: number | null = null;

    const apply = () => {
      frame = 0;
      const drag = dragRef.current;
      if (pendingX === null || !drag) return;
      const ratio = clamp((pendingX - drag.rect.left) / Math.max(drag.rect.width, 1), 0, 1);
      pendingX = null;
      const next = resolveRange(drag, Math.round(ratio * totalMs), totalMs);
      draftRef.current = next;
      setDraft(next);
    };

    // On high-refresh screens pointermove can fire 100+ times a second; coalescing once per frame is enough for the display.
    const handlePointerMove = (event: PointerEvent) => {
      pendingX = event.clientX;
      if (!frame) frame = requestAnimationFrame(apply);
    };

    const handlePointerUp = () => {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      apply(); // Flush the displacement of the last frame not yet painted, to avoid a one-cell snap-back on release
      const final = draftRef.current;
      dragRef.current = null;
      draftRef.current = null;
      if (final) commit(final);
      setDragMode(null);
      setDraft(null);
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
  }, [commit, dragMode, resolveRange, totalMs]);

  const startPct = totalMs ? (startMs / totalMs) * 100 : 0;
  const endPct = totalMs ? (endMs / totalMs) * 100 : 100;
  const selectionMs = Math.max(0, endMs - startMs);

  const handleSubmit = useCallback(() => {
    if (!totalMs || isSubmitting) return;
    onSubmit(startMs, endMs);
  }, [endMs, isSubmitting, onSubmit, startMs, totalMs]);

  const beginDrag = useCallback(
    (mode: DragMode, event: ReactPointerEvent<HTMLElement>) => {
      if (isSubmitting || !totalMs) return;
      const track = trackRef.current;
      if (!track) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = track.getBoundingClientRect();
      const ratio = clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
      const pointerMs = Math.round(ratio * totalMs);
      const drag: DragState = {
        mode,
        rect,
        startAtDown: committedStartMs,
        endAtDown: committedEndMs,
        anchorMs: pointerMs,
      };
      dragRef.current = drag;
      // Start dragging from the current value right away instead of waiting for the first pointermove, otherwise pressing on an empty part of the track gives no feedback.
      const initial =
        mode === 'move'
          ? { start: committedStartMs, end: committedEndMs }
          : resolveRange(drag, pointerMs, totalMs);
      draftRef.current = initial;
      setDraft(initial);
      setDragMode(mode);
    },
    [committedEndMs, committedStartMs, isSubmitting, resolveRange, totalMs],
  );

  const startDrag = useCallback(
    (mode: DragMode) => (event: ReactPointerEvent<HTMLDivElement>) => beginDrag(mode, event),
    [beginDrag],
  );

  /** Pressing on an empty part of the track: pull the nearer end over and continue into a drag. */
  const handleTrackPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (isSubmitting || !totalMs) return;
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const ratio = clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
      const pointerMs = Math.round(ratio * totalMs);
      if (pointerMs >= committedStartMs && pointerMs <= committedEndMs) return; // The inside of the selection is left to move
      const mode: DragMode =
        Math.abs(pointerMs - committedStartMs) <= Math.abs(pointerMs - committedEndMs) ? 'start' : 'end';
      beginDrag(mode, event);
    },
    [beginDrag, committedEndMs, committedStartMs, isSubmitting, totalMs],
  );

  const handleKeyDown = useCallback(
    (edge: 'start' | 'end') => (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (isSubmitting || !totalMs) return;
      const step = event.shiftKey ? KEY_STEP_COARSE_MS : KEY_STEP_MS;
      let next: number | null = null;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
        next = (edge === 'start' ? committedStartMs : committedEndMs) - step;
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
        next = (edge === 'start' ? committedStartMs : committedEndMs) + step;
      } else if (event.key === 'Home') {
        next = edge === 'start' ? 0 : committedStartMs + MIN_CLIP_MS;
      } else if (event.key === 'End') {
        next = edge === 'start' ? committedEndMs - MIN_CLIP_MS : totalMs;
      }
      if (next === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (edge === 'start') {
        commit({ start: clamp(next, 0, Math.max(0, committedEndMs - MIN_CLIP_MS)), end: committedEndMs });
      } else {
        commit({
          start: committedStartMs,
          end: clamp(next, Math.min(committedStartMs + MIN_CLIP_MS, totalMs), totalMs),
        });
      }
    },
    [commit, committedEndMs, committedStartMs, isSubmitting, totalMs],
  );

  // Tile as many cells as frames were extracted; filling the rest with black cells would make people think the second half of the video is black.
  const cellCount = thumbs.length > 0 ? thumbs.length : thumbCount;
  // The duration bubble sticks to the selection midpoint but never sticks out past either end of the track.
  const chipLeftPct = clamp((startPct + endPct) / 2, 8, 92);

  return (
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
        aria-label={t('canvas.videoClip.exit')}
        title={t('canvas.videoClip.exit')}
      >
        <X className="h-4 w-4" />
      </button>
      <button
        type="button"
        className="flex h-9 w-9 shrink-0 cursor-not-allowed items-center justify-center rounded-full text-text-dark/72 opacity-40"
        aria-label={t('canvas.videoClip.subtitleTodo')}
        title={t('canvas.videoClip.subtitleTodo')}
        disabled
      >
        <TypeIcon className="h-4 w-4" />
      </button>

      <div
        ref={trackRef}
        className="relative h-14 flex-1 select-none overflow-hidden rounded-md bg-bg-dark/80"
        // Widening relies on min-width: the panel's outer layer is w-max, so when the node is narrow it pushes the whole panel open,
        // and when the node is wide flex-1 can still take up the remaining space.
        style={{ minWidth: trackMinWidth }}
        onPointerDown={handleTrackPointerDown}
      >
        {/* thumbnail strip */}
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
        {/* z-30 + pointer-events-none: the retry button must sit above the selection frame to be clickable,
            but the overlay as a whole must not swallow handle drags. */}
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

        {/* dark mask outside the selection */}
        <div
          className="pointer-events-none absolute inset-y-0 left-0 bg-black/55"
          style={{ width: `${startPct}%` }}
        />
        <div
          className="pointer-events-none absolute inset-y-0 right-0 bg-black/55"
          style={{ width: `${100 - endPct}%` }}
        />

        {/* selection rectangle (top/bottom borders + inner handles) */}
        <div
          className={`absolute inset-y-0 z-10 border-y-2 border-white ${
            isSubmitting ? '' : dragMode === 'move' ? 'cursor-grabbing' : 'cursor-grab'
          }`}
          style={{ left: `${startPct}%`, right: `${100 - endPct}%` }}
          onPointerDown={startDrag('move')}
        >
          <div
            role="slider"
            tabIndex={isSubmitting ? -1 : 0}
            aria-label={t('canvas.videoClip.startHandle')}
            aria-valuemin={0}
            aria-valuemax={totalMs ?? 0}
            aria-valuenow={startMs}
            aria-valuetext={formatSeconds(startMs)}
            // after:* is the handle's invisible hotspot: visually still a 12px strip, but clickable across a 28px width,
            // and with a very narrow selection the two handles do not fight over clicks.
            className="absolute inset-y-0 left-0 flex w-3 cursor-ew-resize items-center justify-center rounded-l-md bg-white outline-none after:absolute after:inset-y-0 after:-left-2 after:-right-2 after:content-[''] focus-visible:ring-2 focus-visible:ring-sky-400"
            onPointerDown={startDrag('start')}
            onKeyDown={handleKeyDown('start')}
            title={t('canvas.videoClip.dragStart')}
          >
            <div className="pointer-events-none h-4 w-[2px] rounded-full bg-black/40" />
          </div>
          <div
            role="slider"
            tabIndex={isSubmitting ? -1 : 0}
            aria-label={t('canvas.videoClip.endHandle')}
            aria-valuemin={0}
            aria-valuemax={totalMs ?? 0}
            aria-valuenow={endMs}
            aria-valuetext={formatSeconds(endMs)}
            className="absolute inset-y-0 right-0 flex w-3 cursor-ew-resize items-center justify-center rounded-r-md bg-white outline-none after:absolute after:inset-y-0 after:-left-2 after:-right-2 after:content-[''] focus-visible:ring-2 focus-visible:ring-sky-400"
            onPointerDown={startDrag('end')}
            onKeyDown={handleKeyDown('end')}
            title={t('canvas.videoClip.dragEnd')}
          >
            <div className="pointer-events-none h-4 w-[2px] rounded-full bg-black/40" />
          </div>
        </div>

        {/* While dragging, push the timecodes at both ends to the top edge of the track, leaving the center for the picture */}
        {dragMode && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-between px-1 pt-0.5 text-[10px] font-medium tabular-nums text-white/90">
            <span className="rounded bg-black/65 px-1">{formatSeconds(startMs)}</span>
            <span className="rounded bg-black/65 px-1">{formatSeconds(endMs)}</span>
          </div>
        )}

        {/* duration chip */}
        <div
          className="pointer-events-none absolute bottom-1 z-20 -translate-x-1/2 rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white"
          style={{ left: `${chipLeftPct}%` }}
        >
          {formatSeconds(selectionMs)}
        </div>
      </div>

      <button
        type="button"
        className="flex h-9 w-9 shrink-0 cursor-not-allowed items-center justify-center rounded-full text-text-dark/72 opacity-40"
        aria-label={t('canvas.videoClip.muteTodo')}
        title={t('canvas.videoClip.muteTodo')}
        disabled
      >
        <VolumeX className="h-4 w-4" />
      </button>
      <button
        type="button"
        className="flex h-9 w-9 shrink-0 cursor-not-allowed items-center justify-center rounded-full text-text-dark/72 opacity-40"
        aria-label={t('canvas.videoClip.loopTodo')}
        title={t('canvas.videoClip.loopTodo')}
        disabled
      >
        <Repeat className="h-4 w-4" />
      </button>
      <button
        type="button"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-black transition-colors hover:bg-white/90 disabled:cursor-not-allowed disabled:bg-white/30 disabled:text-text-muted"
        onClick={handleSubmit}
        disabled={!totalMs || selectionMs < MIN_CLIP_MS || isSubmitting}
        aria-label={
          isSubmitting
            ? t('canvas.videoClip.submitting')
            : t('canvas.videoClip.submit')
        }
        title={
          isSubmitting
            ? t('canvas.videoClip.submitting')
            : t('canvas.videoClip.submit')
        }
      >
        {isSubmitting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Check className="h-4 w-4" />
        )}
      </button>
    </div>
  );
});
