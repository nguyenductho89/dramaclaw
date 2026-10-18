// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type {
  FreezoneVideoComposePayload,
  FreezoneVideoComposeResolution,
} from "@/api/ops";

/**
 * Frontend "video compose" timeline model.
 *
 * This layer is pure logic (no DOM / React), mapping the libtv-style multi-track timeline editing state to the backend's
 * existing `submitFreezoneVideoCompose` contract ({@link FreezoneVideoComposePayload}).
 * All rendering/encoding is done by the backend FFmpeg - the frontend is only responsible for "arranging + previewing".
 *
 * v2: the position of each clip on the output timeline is decided by an explicit `timelineStartMs`, allowing gaps between clips
 * and dragging clips to any position (libtv-style free positioning). Clips within the same track should not overlap (constrained by the UI
 * during dragging). The backend payload itself supports an arbitrary timelineStart, and the layout here follows it.
 * There may be several tracks of the same kind (multi-track), and the render order is the array order.
 */

export type ComposeTrackKind = "video" | "audio";

export interface ComposeClip {
  /** Local clip id, also used as the itemId on submission. */
  id: string;
  /** Source canvas node id (for tracing back the thumbnail/name); may be null for externally injected materials. */
  nodeId: string | null;
  kind: ComposeTrackKind;
  sourceUrl: string;
  displayName: string | null;
  /** Thumbnail (the video node's previewImageUrl); null for audio / when missing. */
  thumbUrl: string | null;
  /** Full duration of the source media (ms). null until metadata is probed. */
  durationMs: number | null;
  /** Position of the clip's left edge on the output timeline (ms). Gaps allowed; clips in the same track should not overlap. */
  timelineStartMs: number;
  /** Trim start point within the source (ms). */
  trimStartMs: number;
  /** Trim end point within the source (ms, exclusive). Must be > trimStartMs. */
  trimEndMs: number;
  /** 0..1 volume. */
  volume: number;
  muted: boolean;
  /**
   * Playback speed (speed change). 1 = original speed. Length occupied on the timeline = source trim length / speed.
   * Warning: whether the export really changes speed depends on whether the backend compose endpoint supports this field.
   */
  speed: number;
}

export interface ComposeTrack {
  id: string;
  kind: ComposeTrackKind;
  /** The order is the end-to-end layout order. */
  clips: ComposeClip[];
}

/**
 * The cover of the whole compose timeline. Both sources are normalized into one uploaded stable image URL:
 *  - `frame`: captured from a frame on the timeline (`frameMs` records the timeline position, used to echo the frame-picking slider);
 *  - `upload`: a custom image uploaded by the user (`frameMs` is null).
 * Only the uploaded `url` is persisted; a local preview before upload does not enter this structure (avoiding writing base64 into the draft).
 */
export interface ComposeCover {
  source: "frame" | "upload";
  /** Timeline position (ms) for the frame source; null for the upload source. */
  frameMs: number | null;
  /** The uploaded stable cover URL; only has a value once it has landed. */
  url: string | null;
}

export interface ComposeTimelineState {
  tracks: ComposeTrack[];
  resolution: FreezoneVideoComposeResolution;
  /** The compose cover (empty when not set). Persisted with the draft. */
  cover?: ComposeCover | null;
}

/** Default trim length (ms) - a fallback when the source duration is unknown, avoiding a zero length that cannot be laid out/previewed. */
export const FALLBACK_CLIP_MS = 5000;
export const MIN_CLIP_MS = 200;

/**
 * Fixed ids of the main video track / main audio track. The main video track is the only "magnetic" track: clips always stay flush without gaps,
 * and dragging can only reorder; additional video tracks and audio tracks are freely positioned. Gap-filling ({@link compactVideoTracks})
 * and the drag branch both judge by this id, keeping to the same rule.
 */
export const VIDEO_TRACK_ID = "track_video";
export const AUDIO_TRACK_ID = "track_audio";

/** Source trim length (ms) - the source media duration consumed, independent of speed. */
export function sourceSpanMs(clip: ComposeClip): number {
  return Math.max(0, clip.trimEndMs - clip.trimStartMs);
}

/** Length the clip occupies on the timeline (ms) = source trim length / speed. */
export function clipLengthMs(clip: ComposeClip): number {
  return sourceSpanMs(clip) / (clip.speed > 0 ? clip.speed : 1);
}

export interface LaidClip {
  clip: ComposeClip;
  timelineStartMs: number;
  timelineEndMs: number;
}

/**
 * Lay out by each clip's explicit `timelineStartMs` (ascending), computing the start and end on the output timeline (ms).
 * Gaps allowed; negative values are clamped to 0. Clips with zero length are skipped.
 */
export function layoutTrack(track: ComposeTrack): LaidClip[] {
  return track.clips
    .filter((clip) => clipLengthMs(clip) > 0)
    .map((clip) => {
      const start = Math.max(0, clip.timelineStartMs);
      return { clip, timelineStartMs: start, timelineEndMs: start + clipLengthMs(clip) };
    })
    .sort((a, b) => a.timelineStartMs - b.timelineStartMs);
}

/**
 * Re-lay out a track's clips end to end in array order (magnetic / seamless):
 * timelineStartMs accumulates from 0 by each clip's timeline length, returning a new clips array (original objects unchanged).
 * The video track uses it to implement a "CapCut-style" magnetic track - after a drag reorder the whole track always stays flush with no gaps.
 */
export function packTrackClips(clips: ComposeClip[]): ComposeClip[] {
  let cursor = 0;
  return clips.map((clip) => {
    const packed = { ...clip, timelineStartMs: Math.round(cursor) };
    cursor += clipLengthMs(clip);
    return packed;
  });
}

/**
 * Fill the "main video track" seamlessly in timeline order (ripple): after delete / trim / speed change use it to remove gaps,
 * keeping the main track always flush end to end. Additional video tracks and audio tracks stay freely positioned and untouched - the drag branch lets
 * the user place additional-track clips at any time position, and packing them here would quietly snap them back to 0, creating time overlap
 * with the main track (export is then blocked by hasOverlappingVideoClips).
 */
export function compactVideoTracks(
  state: ComposeTimelineState,
): ComposeTimelineState {
  return {
    ...state,
    tracks: state.tracks.map((track) =>
      track.kind === "video" && track.id === VIDEO_TRACK_ID
        ? {
            ...track,
            clips: packTrackClips(
              [...track.clips].sort(
                (a, b) => a.timelineStartMs - b.timelineStartMs,
              ),
            ),
          }
        : track,
    ),
  };
}

/**
 * Write the probed source duration (clipId -> ms) back to clips: a trim end point still at the fallback length or beyond the source length
 * receives the real duration, then the main video track is gap-filled. Without gap-filling, the start of the following clip laid out with the 5s fallback
 * would not shift right, and once the clip gets longer it would overlap its successor.
 */
export function applyProbedDurations(
  state: ComposeTimelineState,
  probed: ReadonlyMap<string, number>,
): ComposeTimelineState {
  if (probed.size === 0) return state;
  return compactVideoTracks({
    ...state,
    tracks: state.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => {
        const durationMs = probed.get(clip.id);
        if (durationMs == null) return clip;
        return {
          ...clip,
          durationMs,
          trimEndMs:
            clip.trimEndMs === FALLBACK_CLIP_MS || clip.trimEndMs > durationMs
              ? durationMs
              : clip.trimEndMs,
        };
      }),
    })),
  });
}

/**
 * On drag reorder, from the drop position (ms) of the dragged clip's left edge on the timeline, compute the index at which it should be inserted into the
 * "already seamlessly laid out siblings". The criterion is that the dragged clip's center crossing a sibling's center places it before that one.
 * siblings must already be in timeline order.
 */
export function reorderIndexForDrag(
  siblings: ComposeClip[],
  draggedLeftMs: number,
  draggedLengthMs: number,
): number {
  const center = Math.max(0, draggedLeftMs) + draggedLengthMs / 2;
  let acc = 0;
  for (let i = 0; i < siblings.length; i += 1) {
    const len = clipLengthMs(siblings[i]);
    if (center < acc + len / 2) return i;
    acc += len;
  }
  return siblings.length;
}

/**
 * The boundaries of the left and right neighbors immediately adjacent to a clip on a track (the previous clip's end / next clip's start after sorting by timeline position).
 * Used to constrain a clip between its neighbors during drag / trim to avoid overlap. Returns null on a side with no neighbor.
 */
export function neighborBoundsMs(
  track: ComposeTrack,
  clipId: string,
): { prevEndMs: number | null; nextStartMs: number | null } {
  const laid = layoutTrack(track);
  const index = laid.findIndex((entry) => entry.clip.id === clipId);
  if (index < 0) return { prevEndMs: null, nextStartMs: null };
  return {
    prevEndMs: index > 0 ? laid[index - 1].timelineEndMs : null,
    nextStartMs: index < laid.length - 1 ? laid[index + 1].timelineStartMs : null,
  };
}

/** Total duration of the whole timeline (ms) = the largest end after laying out each track. */
export function timelineDurationMs(state: ComposeTimelineState): number {
  let max = 0;
  for (const track of state.tracks) {
    const laid = layoutTrack(track);
    const end = laid.length > 0 ? laid[laid.length - 1].timelineEndMs : 0;
    if (end > max) max = end;
  }
  return max;
}

export interface ActiveClip {
  laid: LaidClip;
  /** The time within the source media (ms) corresponding to that playhead moment. */
  sourceMs: number;
}

/**
 * Given the playhead position, return the clip currently hit on a track and its in-source time.
 * Returns null when it falls in a gap between clips / beyond the end.
 */
export function activeClipAt(
  track: ComposeTrack,
  playheadMs: number,
): ActiveClip | null {
  for (const laid of layoutTrack(track)) {
    if (playheadMs >= laid.timelineStartMs && playheadMs < laid.timelineEndMs) {
      const offset = playheadMs - laid.timelineStartMs;
      const speed = laid.clip.speed > 0 ? laid.clip.speed : 1;
      return { laid, sourceMs: laid.clip.trimStartMs + offset * speed };
    }
  }
  return null;
}

export interface BuildComposeOptions {
  title?: string;
  canvasId?: string;
  nodeId?: string;
  fps?: number;
}

/** Map the timeline state to the backend compose endpoint's input (ms -> seconds). Empty tracks are dropped. */
export function buildComposePayload(
  state: ComposeTimelineState,
  options: BuildComposeOptions = {},
): FreezoneVideoComposePayload {
  const tracks = state.tracks
    .map((track) => ({
      trackId: track.id,
      kind: track.kind,
      items: layoutTrack(track).map(({ clip, timelineStartMs }) => ({
        itemId: clip.id,
        sourceUrl: clip.sourceUrl,
        timelineStart: timelineStartMs / 1000,
        sourceStart: clip.trimStartMs / 1000,
        sourceEnd: clip.trimEndMs / 1000,
        volume: clip.volume,
        muted: clip.muted,
        // Warning: the backend must support this field for the speed to really change; otherwise it is ignored (export at original speed).
        speed: clip.speed > 0 ? clip.speed : 1,
      })),
    }))
    .filter((track) => track.items.length > 0);

  return {
    title: options.title,
    canvasId: options.canvasId,
    nodeId: options.nodeId,
    resolution: state.resolution,
    fps: options.fps ?? 30,
    // The cover is returned as result video metadata, and the frontend writes it into the result video node's previewImageUrl / poster.
    coverUrl: state.cover?.url ?? null,
    tracks,
  };
}

/** Whether the timeline has any exportable clip. */
export function hasExportableClips(state: ComposeTimelineState): boolean {
  return state.tracks.some((track) =>
    track.clips.some((clip) => clipLengthMs(clip) > 0),
  );
}

/**
 * Whether there are "time-overlapping video clips" (judged after merging across all video tracks and sorting by time).
 * The MVP backend compose does not support overlapping video compose, so this is used to block before export and give a clear message.
 * Audio is not judged here (multiple audio tracks can be layered and mixed). A 1ms tolerance absorbs floating-point rounding error.
 */
export function hasOverlappingVideoClips(state: ComposeTimelineState): boolean {
  return overlappingVideoClipIds(state).size > 0;
}

/**
 * Return the ids of all video clips that "overlap other video clips in time" (across all video tracks).
 * Used to highlight conflicting clips on the timeline to warn the user. A 1ms tolerance absorbs floating-point rounding.
 */
export function overlappingVideoClipIds(state: ComposeTimelineState): Set<string> {
  const laid = state.tracks
    .filter((track) => track.kind === "video")
    .flatMap((track) => layoutTrack(track))
    .sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  const ids = new Set<string>();
  for (let i = 0; i < laid.length; i += 1) {
    for (let j = i + 1; j < laid.length; j += 1) {
      // Already sorted by start: once the latter's start >= the former's end, later ones overlap i even less, so stop early.
      if (laid[j].timelineStartMs >= laid[i].timelineEndMs - 1) break;
      ids.add(laid[i].clip.id);
      ids.add(laid[j].clip.id);
    }
  }
  return ids;
}
