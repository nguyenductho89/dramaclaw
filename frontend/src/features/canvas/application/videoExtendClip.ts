// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';

/**
 * Pure logic for trimming the preceding video for "smart extend".
 *
 * Extend trims only **one** segment: it is the "previous story" fed to the model, and
 * with several segments it would be unclear where to continue from.
 * So there is exactly one range here, with two hard bounds:
 * - Lower bound 4s: Seedance 2.5 does not accept video material shorter than 4s.
 * - Upper bound 30s: likewise its duration limit for video material.
 *
 * While dragging, these bounds "hold" the handle rather than "reject" the drag: at the
 * moment it holds, the UI shows a hint so the user knows the handle is not stuck but
 * has reached the edge.
 */

/** `00:06`. Material over an hour is rare, so shown as mm:ss with minutes not truncated. */
export function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export const MIN_EXTEND_CLIP_MS = 4_000;
export const MAX_EXTEND_CLIP_MS = 30_000;

export interface ExtendClipRange {
  startMs: number;
  endMs: number;
}

/** Which bound the drag is held at. null = not held, no hint needed. */
export type ExtendClipBound = 'min' | 'max' | null;

export function extendClipBoundMessage(bound: ExtendClipBound): string | null {
  if (bound === 'min') {
    return i18n.t('canvas.videoExtend.boundMin', { seconds: MIN_EXTEND_CLIP_MS / 1000 });
  }
  if (bound === 'max') {
    return i18n.t('canvas.videoExtend.boundMax', { seconds: MAX_EXTEND_CLIP_MS / 1000 });
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Default selection when the track opens: up to 30s taken against the **end** of the clip.
 *
 * Extend continues from the end of this segment, so the default should be "the most recent
 * 30 seconds"; taking from the start would drop the latter part and force the user to drag
 * the whole selection to the tail. If the material is shorter than 30s it falls back to the
 * whole clip, consistent with "the whole clip is the previous story".
 */
export function defaultExtendRange(totalMs: number): ExtendClipRange {
  if (!(totalMs > 0)) return { startMs: 0, endMs: 0 };
  const length = Math.min(totalMs, MAX_EXTEND_CLIP_MS);
  return { startMs: Math.max(0, totalMs - length), endMs: totalMs };
}

/** Whether the selection is too short to submit (also true when the material itself is under 4s, since such a video cannot be extended). */
export function isExtendRangeSubmittable(range: ExtendClipRange): boolean {
  const length = range.endMs - range.startMs;
  return length >= MIN_EXTEND_CLIP_MS && length <= MAX_EXTEND_CLIP_MS;
}

export type ExtendDragMode = 'start' | 'end' | 'move';

export interface ExtendDragAnchor {
  mode: ExtendDragMode;
  /** Range at the moment of pointer-down. move uses it to keep the length; start/end use it to lock the fixed end. */
  startAtDown: number;
  endAtDown: number;
  /** Timecode under the pointer at pointer-down; move uses it to compute the offset. */
  anchorMs: number;
}

export interface ExtendDragResult extends ExtendClipRange {
  /** Which bound clamped this step; the UI decides which hint to show from it. */
  bound: ExtendClipBound;
}

/**
 * Convert the pointer position into a new range, and also report whether a bound clamped it.
 *
 * The clamping order matters: clamp the length by 4s/30s first, then clamp the position by
 * [0, totalMs]. Done the other way round, dragging the start past the clip head would be cut
 * at 0 first and the length would silently shrink, so the 30s hint would never appear.
 */
export function resolveExtendRange(
  anchor: ExtendDragAnchor,
  pointerMs: number,
  totalMs: number,
): ExtendDragResult {
  if (anchor.mode === 'move') {
    const length = anchor.endAtDown - anchor.startAtDown;
    const startMs = clamp(
      anchor.startAtDown + (pointerMs - anchor.anchorMs),
      0,
      Math.max(0, totalMs - length),
    );
    // Moving the whole range keeps its length, so it never hits 4s/30s; it can only hit the track ends, which needs no hint.
    return { startMs, endMs: startMs + length, bound: null };
  }

  if (anchor.mode === 'start') {
    const end = anchor.endAtDown;
    const lowest = Math.max(0, end - MAX_EXTEND_CLIP_MS);
    const highest = Math.max(0, end - MIN_EXTEND_CLIP_MS);
    const startMs = clamp(pointerMs, lowest, highest);
    const bound: ExtendClipBound =
      pointerMs > highest ? 'min' : pointerMs < lowest && lowest > 0 ? 'max' : null;
    return { startMs, endMs: end, bound };
  }

  const start = anchor.startAtDown;
  const lowest = Math.min(start + MIN_EXTEND_CLIP_MS, totalMs);
  const highest = Math.min(start + MAX_EXTEND_CLIP_MS, totalMs);
  const endMs = clamp(pointerMs, lowest, highest);
  const bound: ExtendClipBound =
    pointerMs < lowest ? 'min' : pointerMs > highest && highest < totalMs ? 'max' : null;
  return { startMs: start, endMs, bound };
}

/**
 * Fixed prefix placed at the very start of the prompt, e.g.
 * `Extend the 00:00-00:04 clip of Video (2): `.
 *
 * The prefix does not go into `data.prompt`: it is the node's **identity**, not user-written
 * content. Mixed into the body, one backspace could delete half the sentence and the model
 * would receive a truncated instruction. It is only prepended to the final prompt at submit
 * time and rendered in the input as a non-editable chip.
 */
export function extendPromptPrefix(sourceName: string, range: ExtendClipRange): string {
  const name = sourceName.trim() || i18n.t('canvas.videoExtend.defaultSourceName');
  return i18n.t('canvas.videoExtend.promptPrefix', {
    name,
    start: formatTimecode(range.startMs),
    end: formatTimecode(range.endMs),
  });
}

/**
 * Whether the selection is only part of the source video. If so, the segment must actually be
 * trimmed out before it is used as reference material. Without trimming, the whole source
 * video goes to the model: it exceeds the model's duration limit for video material (any
 * selection gets blocked when the source is > 30s) and the model also sees frames outside the
 * selection. When the selection is the whole clip there is no need for a wasted transcode.
 * If the source duration is unknown, treat it as "needs trimming": better one extra transcode
 * than sending over-long material.
 */
export function extendRangeNeedsTrim(range: ExtendClipRange, sourceDurationMs: number | null): boolean {
  if (!(range.endMs > range.startMs)) return false;
  if (sourceDurationMs == null || !(sourceDurationMs > 0)) return true;
  return range.startMs > EXTEND_FULL_RANGE_TOLERANCE_MS
    || range.endMs < sourceDurationMs - EXTEND_FULL_RANGE_TOLERANCE_MS;
}

/** Tolerance for a selection flush with the edge: a selection dragged to the end that differs from the probed duration by a frame or two does not count as "only part selected". */
const EXTEND_FULL_RANGE_TOLERANCE_MS = 50;

/**
 * Prefix used on submit after the selection has actually been trimmed out: the segment the
 * model receives starts at 0 seconds, so timecodes from the original video no longer apply
 * and it just says "Extend X". The chip in the input still shows the timecoded
 * [[extendPromptPrefix]], which tells the user which segment they selected.
 */
export function extendPromptPrefixTrimmed(sourceName: string): string {
  const name = sourceName.trim() || i18n.t('canvas.videoExtend.defaultSourceName');
  return i18n.t('canvas.videoExtend.promptPrefixTrimmed', { name });
}

/** Name of the extend node: `Extend Video (2)`. */
export function extendNodeDisplayName(sourceName: string): string {
  const name = sourceName.trim() || i18n.t('canvas.videoExtend.defaultLabel');
  return i18n.t('canvas.videoExtend.nodeDisplayName', { name });
}
