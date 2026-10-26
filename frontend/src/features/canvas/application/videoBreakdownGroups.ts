// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  CANVAS_NODE_TYPES,
  EXPORT_RESULT_NODE_MIN_HEIGHT,
  EXPORT_RESULT_NODE_MIN_WIDTH,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';

import { resolveMinEdgeFittedSize } from './imageNodeSizing';

/**
 * Frame-by-frame breakdown output -> canvas result group layout plan.
 *
 * Input types are written as a "structurally compatible" loose version (every field optional, nulls allowed), so
 * `FreezoneVideoBreakdownResult` (api/ops) can be passed straight in without the canvas layer having to depend back on the
 * API layer. The plan itself is pure data: the store is only responsible for turning it into nodes / edges, landing one
 * undo step in a single set().
 */

export interface VideoBreakdownShotLike {
  code?: string | null;
  shot?: number | null;
  duration?: number | null;
  shot_size?: string | null;
  lighting?: string | null;
  camera_movement?: string | null;
  description?: string | null;
  image_prompt?: string | null;
  image_url?: string | null;
}

export interface VideoBreakdownGroupLike {
  group_index?: number | null;
  label?: string | null;
  shots?: VideoBreakdownShotLike[];
}

export interface VideoBreakdownMotionClipLike {
  code?: string | null;
  duration_sec?: number | null;
  camera_movement?: string | null;
  description?: string | null;
  motion_prompt?: string | null;
  video_url?: string | null;
  preview_image_url?: string | null;
}

export interface VideoBreakdownMusicClipLike {
  code?: string | null;
  duration_sec?: number | null;
  description?: string | null;
  mood?: string | null;
  bpm?: number | null;
  audio_url?: string | null;
}

export interface VideoBreakdownResultLike {
  storyboard?: { label?: string | null; groups?: VideoBreakdownGroupLike[] } | null;
  motion?: { label?: string | null; clips?: VideoBreakdownMotionClipLike[] } | null;
  music?: { label?: string | null; clip?: VideoBreakdownMusicClipLike | null } | null;
}

export type VideoBreakdownGroupKind = 'storyboard' | 'motion' | 'music';

export interface VideoBreakdownChildPlan {
  type: CanvasNodeType;
  /** Position relative to the parent group (React Flow child-node coordinate space). */
  position: { x: number; y: number };
  width: number;
  height: number;
  data: Record<string, unknown>;
}

export interface VideoBreakdownGroupPlan {
  kind: VideoBreakdownGroupKind;
  label: string;
  /** Absolute canvas coordinates. */
  position: { x: number; y: number };
  width: number;
  height: number;
  children: VideoBreakdownChildPlan[];
}

const SIDE_PADDING = 20;
const TOP_PADDING = 34;
const BOTTOM_PADDING = 20;
const CELL_GAP = 24;
/** Vertical gap between groups (the three result groups stack top to bottom). */
const GROUP_GAP_Y = 56;

/**
 * Storyboard cards are laid out two columns wide. A group is usually 4 shots; laying them out in a single row would
 * stretch the group frame very wide - neither fully visible on the canvas nor leaving room for the motion/music groups
 * below it. A 2x2 block reads closer to how a storyboard sheet is read.
 */
const STORYBOARD_COLS = 2;
const MOTION_COLS = 3;

/** The result carries no frame-size info; land everything at 16:9 by default - the image node self-adjusts to the real ratio once loaded. */
const DEFAULT_ASPECT = '16:9';

// The size storyboard cards self-snap to once their image node finishes loading, avoiding a jump after landing.
const STORYBOARD_CELL = resolveMinEdgeFittedSize(DEFAULT_ASPECT, {
  minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
  minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
});
// Aligned with VideoNode / AudioNode's DEFAULT_WIDTH/HEIGHT.
const MOTION_CELL = { width: 580, height: 380 };
const MUSIC_CELL = { width: 480, height: 210 };

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function seconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function formatSeconds(value: unknown): string {
  const parsed = seconds(value);
  if (parsed === null) return '';
  return `${Math.round(parsed * 10) / 10}s`;
}

/** Card titles are joined as "shot number | shot size·lighting | description", missing pieces are dropped rather than leaving an empty segment. */
function joinLabel(parts: (string | null | undefined)[]): string {
  return parts.map((part) => text(part)).filter(Boolean).join(' | ');
}

function gridSize(count: number, cols: number, cell: { width: number; height: number }) {
  const usedCols = Math.max(1, Math.min(cols, count));
  const rows = Math.max(1, Math.ceil(count / usedCols));
  return {
    cols: usedCols,
    rows,
    width: SIDE_PADDING * 2 + usedCols * cell.width + (usedCols - 1) * CELL_GAP,
    height:
      TOP_PADDING + BOTTOM_PADDING + rows * cell.height + (rows - 1) * CELL_GAP,
  };
}

function cellPosition(
  index: number,
  cols: number,
  cell: { width: number; height: number }
) {
  const col = index % cols;
  const row = Math.floor(index / cols);
  return {
    x: SIDE_PADDING + col * (cell.width + CELL_GAP),
    y: TOP_PADDING + row * (cell.height + CELL_GAP),
  };
}

function planStoryboardGroups(
  result: VideoBreakdownResultLike,
  fallbackLabel: (index: number) => string
): VideoBreakdownGroupPlan[] {
  const groups = result.storyboard?.groups ?? [];
  const plans: VideoBreakdownGroupPlan[] = [];

  groups.forEach((group, groupIndex) => {
    // A shot where frame extraction failed has no image_url; landing an empty card would just be noise, skip it.
    const shots = (group.shots ?? []).filter((shot) => text(shot.image_url));
    if (shots.length === 0) return;

    const grid = gridSize(shots.length, STORYBOARD_COLS, STORYBOARD_CELL);
    const children = shots.map((shot, index) => {
      const imageUrl = text(shot.image_url);
      return {
        type: CANVAS_NODE_TYPES.exportImage,
        position: cellPosition(index, grid.cols, STORYBOARD_CELL),
        width: STORYBOARD_CELL.width,
        height: STORYBOARD_CELL.height,
        data: {
          imageUrl,
          previewImageUrl: imageUrl,
          aspectRatio: DEFAULT_ASPECT,
          // The breakdown output is reference material; the frame the model picked may not be the one wanted - a "replace"
          // entry in the top-right corner lets the user swap in their own image (via upload into OSS).
          allowLocalReplace: true,
          displayName: joinLabel([
            shot.code,
            joinTone(shot.shot_size, shot.lighting),
            shot.description,
          ]),
        },
      } satisfies VideoBreakdownChildPlan;
    });

    plans.push({
      kind: 'storyboard',
      label: text(group.label) || fallbackLabel(groupIndex + 1),
      position: { x: 0, y: 0 },
      width: grid.width,
      height: grid.height,
      children,
    });
  });

  return plans;
}

/** "Shot size·lighting": omit the whole segment when both are missing, don't leave a lone separator when only one is present. */
function joinTone(shotSize: unknown, lighting: unknown): string {
  return [text(shotSize), text(lighting)].filter(Boolean).join('·');
}

function planMotionGroup(
  result: VideoBreakdownResultLike,
  fallbackLabel: string
): VideoBreakdownGroupPlan | null {
  const clips = (result.motion?.clips ?? []).filter((clip) => text(clip.video_url));
  if (clips.length === 0) return null;

  const grid = gridSize(clips.length, MOTION_COLS, MOTION_CELL);
  const children = clips.map((clip, index) => {
    const durationSec = seconds(clip.duration_sec);
    return {
      type: CANVAS_NODE_TYPES.video,
      position: cellPosition(index, grid.cols, MOTION_CELL),
      width: MOTION_CELL.width,
      height: MOTION_CELL.height,
      data: {
        videoUrl: text(clip.video_url),
        previewImageUrl: text(clip.preview_image_url) || null,
        aspectRatio: DEFAULT_ASPECT,
        durationMs: durationSec === null ? null : Math.round(durationSec * 1000),
        // Reference material only: playback + a top toolbar, no generation panel at the bottom.
        referenceOnly: true,
        allowLocalReplace: true,
        prompt: text(clip.motion_prompt),
        displayName: joinLabel([
          clip.code,
          joinTone(formatSeconds(clip.duration_sec), clip.camera_movement),
          clip.description,
        ]),
      },
    } satisfies VideoBreakdownChildPlan;
  });

  return {
    kind: 'motion',
    label: text(result.motion?.label) || fallbackLabel,
    position: { x: 0, y: 0 },
    width: grid.width,
    height: grid.height,
    children,
  };
}

function planMusicGroup(
  result: VideoBreakdownResultLike,
  fallbackLabel: string
): VideoBreakdownGroupPlan | null {
  const clip = result.music?.clip ?? null;
  if (!clip || !text(clip.audio_url)) return null;

  const grid = gridSize(1, 1, MUSIC_CELL);
  const durationSec = seconds(clip.duration_sec);

  return {
    kind: 'music',
    label: text(result.music?.label) || fallbackLabel,
    position: { x: 0, y: 0 },
    width: grid.width,
    height: grid.height,
    children: [
      {
        type: CANVAS_NODE_TYPES.audio,
        position: cellPosition(0, 1, MUSIC_CELL),
        width: MUSIC_CELL.width,
        height: MUSIC_CELL.height,
        data: {
          audioUrl: text(clip.audio_url),
          durationMs: durationSec === null ? null : Math.round(durationSec * 1000),
          audioKind: 'music',
          allowLocalReplace: true,
          // The music description lands in text: the user can take it straight into "text-to-music" to re-run it.
          text: text(clip.description),
          displayName: joinLabel([
            clip.code,
            joinTone(formatSeconds(clip.duration_sec), clip.mood),
          ]),
        },
      },
    ],
  };
}

export interface PlanVideoBreakdownGroupsOptions {
  /** Top-left corner of the first group (absolute canvas coordinates), typically to the right of the breakdown node. */
  origin: { x: number; y: number };
  /** Fallback name when a storyboard group has no label; the argument is the 1-based group index. */
  storyboardFallbackLabel?: (index: number) => string;
  motionFallbackLabel?: string;
  musicFallbackLabel?: string;
}

/**
 * Lay a breakdown result out into a stacked column of result groups: "Storyboard group 01/02/03 -> Motion | camera-movement
 * reference -> Music | BGM reference clip". A dimension with no output does not occupy any space; an empty return array
 * means this breakdown produced nothing landable at all.
 */
export function planVideoBreakdownGroups(
  result: VideoBreakdownResultLike,
  options: PlanVideoBreakdownGroupsOptions
): VideoBreakdownGroupPlan[] {
  // i18n-exempt-start fallback of a fallback: in production VideoBreakdownNode always passes already-translated
  // *FallbackLabel (see t('videoBreakdown.groups.*')); these three literals are only ever hit when the caller does not
  // pass options (e.g. a unit test calling this function directly) - they are never actually shown to a user, so they
  // don't need to go through i18n.
  const storyboardFallback =
    options.storyboardFallbackLabel ??
    ((index: number) => `Storyboard group ${String(index).padStart(2, '0')}`);

  const plans = [
    ...planStoryboardGroups(result, storyboardFallback),
    planMotionGroup(result, options.motionFallbackLabel ?? 'Motion | camera-movement reference'),
    planMusicGroup(result, options.musicFallbackLabel ?? 'Music | BGM reference clip'),
  ].filter((plan): plan is VideoBreakdownGroupPlan => plan !== null);
  // i18n-exempt-end

  let cursorY = Math.round(options.origin.y);
  for (const plan of plans) {
    plan.position = { x: Math.round(options.origin.x), y: cursorY };
    cursorY += plan.height + GROUP_GAP_Y;
  }

  return plans;
}
