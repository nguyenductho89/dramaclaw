// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { VideoStoryRow } from '@/features/canvas/domain/canvasNodes';

// Backend response shape for `freezone_analyze_video_story` (observed at runtime,
// OpenAPI declares 200 schema `{}`):
// {
//   job_id, output_url, model, analysis_mode, frame_count,
//   frame_urls: string[],
//   analyses: ShotRow[],
//   video_story: { title, summary, duration, shots: ShotRow[] },
//   task_metadata: { ... }
// }
// Where ShotRow uses keys: shot / start_time / end_time / duration /
// visual_description / narrative / shot_size / camera_angle / camera_movement /
// focus_depth / lighting / background_music / voice_sound / image_prompt /
// motion_prompt / keyframes (array of 1-based indices into the chronologically
// sorted frame_urls).

// The two alias tables below are column-name literals returned by the model/backend (English only),
// used to match returned fields to frontend fields.
// i18n-exempt-start
const FIELD_ALIASES: Record<Exclude<keyof VideoStoryRow, 'raw' | 'keyframeUrl'>, string[]> = {
  shotNumber: ['shot', 'shotNumber', 'shot_number', 'shot_no', 'shot_index', 'index', 'number'],
  startTime: ['startTime', 'start_time', 'start'],
  endTime: ['endTime', 'end_time', 'end'],
  duration: ['duration', 'duration_sec'],
  visualDescription: ['visualDescription', 'visual_description', 'visual', 'description'],
  narrative: ['narrative', 'narration', 'story'],
  shotSize: ['shotSize', 'shot_size', 'shot_scale', 'scale'],
  cameraAngle: ['cameraAngle', 'camera_angle', 'angle'],
  cameraMovement: ['cameraMovement', 'camera_movement', 'movement'],
  focalAndDof: ['focalAndDof', 'focal_and_dof', 'focal_dof', 'focus_depth', 'focus', 'depth_of_field', 'dof'],
  lighting: ['lighting', 'light'],
  backgroundMusic: ['backgroundMusic', 'background_music', 'bgm', 'music'],
  voiceAndSfx: ['voiceAndSfx', 'voice_and_sfx', 'voice_sfx', 'voice_sound', 'voice', 'sfx'],
  imagePrompt: ['imagePrompt', 'image_prompt', 'image_gen_prompt'],
  videoMotionPrompt: ['videoMotionPrompt', 'video_motion_prompt', 'motion_prompt', 'motionPrompt'],
};

const KEYFRAME_URL_ALIASES = [
  'keyframeUrl',
  'keyframe_url',
  'keyframe',
  'frame_url',
  'image_url',
];

// i18n-exempt-end

const KEYFRAME_INDEX_ALIASES = ['keyframes', 'keyframe_indices', 'keyframeIndices'];

function pick(entry: Record<string, unknown>, aliases: string[]): unknown {
  for (const key of aliases) {
    if (key in entry) {
      const value = entry[key];
      if (value !== null && value !== undefined && value !== '') return value;
    }
  }
  return null;
}

function coerceString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function coerceShotNumber(value: unknown): number | string | null {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const asNum = Number(trimmed);
    return Number.isFinite(asNum) ? asNum : trimmed;
  }
  return null;
}

function sortFrameUrlsChronologically(urls: unknown): string[] {
  if (!Array.isArray(urls)) return [];
  const items = urls.filter((u): u is string => typeof u === 'string');
  // Backend returns frame_urls lexically (`scene_1041.png` before `scene_423.png`).
  // The `keyframes` indices reference the chronological order, so we sort by the
  // numeric suffix extracted from the filename.
  const withKey = items.map((url) => {
    const match = /(\d+)(?:\.[a-zA-Z]+)?(?:\?|$)/.exec(url.split('/').pop() ?? url);
    const numericKey = match ? Number(match[1]) : Number.POSITIVE_INFINITY;
    return { url, numericKey };
  });
  withKey.sort((a, b) => a.numericKey - b.numericKey);
  return withKey.map((item) => item.url);
}

function resolveKeyframeUrl(
  entry: Record<string, unknown>,
  sortedFrameUrls: string[],
): string | null {
  const direct = pick(entry, KEYFRAME_URL_ALIASES);
  if (typeof direct === 'string') return direct;

  for (const key of KEYFRAME_INDEX_ALIASES) {
    const value = entry[key];
    if (Array.isArray(value) && value.length > 0) {
      const first = value[0];
      const idx = typeof first === 'number' ? first : Number(first);
      if (Number.isFinite(idx)) {
        // Backend uses 1-based indexing into the chronological frame list.
        const url = sortedFrameUrls[idx - 1];
        if (typeof url === 'string') return url;
      }
    } else if (typeof value === 'number') {
      const url = sortedFrameUrls[value - 1];
      if (typeof url === 'string') return url;
    }
  }

  return null;
}

function normalizeRow(
  entry: Record<string, unknown>,
  sortedFrameUrls: string[],
): VideoStoryRow {
  return {
    shotNumber: coerceShotNumber(pick(entry, FIELD_ALIASES.shotNumber)),
    startTime: coerceString(pick(entry, FIELD_ALIASES.startTime)),
    endTime: coerceString(pick(entry, FIELD_ALIASES.endTime)),
    duration: coerceString(pick(entry, FIELD_ALIASES.duration)),
    visualDescription: coerceString(pick(entry, FIELD_ALIASES.visualDescription)),
    narrative: coerceString(pick(entry, FIELD_ALIASES.narrative)),
    shotSize: coerceString(pick(entry, FIELD_ALIASES.shotSize)),
    cameraAngle: coerceString(pick(entry, FIELD_ALIASES.cameraAngle)),
    cameraMovement: coerceString(pick(entry, FIELD_ALIASES.cameraMovement)),
    focalAndDof: coerceString(pick(entry, FIELD_ALIASES.focalAndDof)),
    lighting: coerceString(pick(entry, FIELD_ALIASES.lighting)),
    backgroundMusic: coerceString(pick(entry, FIELD_ALIASES.backgroundMusic)),
    voiceAndSfx: coerceString(pick(entry, FIELD_ALIASES.voiceAndSfx)),
    imagePrompt: coerceString(pick(entry, FIELD_ALIASES.imagePrompt)),
    videoMotionPrompt: coerceString(pick(entry, FIELD_ALIASES.videoMotionPrompt)),
    keyframeUrl: resolveKeyframeUrl(entry, sortedFrameUrls),
    raw: entry,
  };
}

// Preferred order: prod backend nests rows under `video_story.shots`, with
// `analyses` mirroring the same content. Older/mock backends may put rows at
// the top level or under generic envelope keys.
const ROW_LIST_PATHS: Array<string[]> = [
  ['video_story', 'shots'],
  ['videoStory', 'shots'],
  ['analyses'],
  ['rows'],
  ['shots'],
  ['entries'],
  ['items'],
  ['data'],
  ['story'],
  ['table'],
  ['records'],
];

function valueAtPath(payload: Record<string, unknown>, path: string[]): unknown {
  let cursor: unknown = payload;
  for (const segment of path) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return null;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function findRowArray(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  for (const path of ROW_LIST_PATHS) {
    const value = valueAtPath(record, path);
    if (Array.isArray(value)) return value;
  }
  // Last-resort: walk one level deep looking for any array of objects.
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      if (value.some((item) => item && typeof item === 'object')) return value;
    }
  }
  return null;
}

function extractFrameUrls(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  const candidate = record.frame_urls ?? record.frameUrls;
  return sortFrameUrlsChronologically(candidate);
}

export function normalizeVideoStoryRows(payload: unknown): VideoStoryRow[] {
  const list = findRowArray(payload) ?? [];
  const sortedFrameUrls = extractFrameUrls(payload);
  const rows: VideoStoryRow[] = [];
  for (const item of list) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      rows.push(normalizeRow(item as Record<string, unknown>, sortedFrameUrls));
    }
  }
  return rows;
}

export interface VideoStoryMeta {
  title?: string | null;
  summary?: string | null;
}

export function extractVideoStoryMeta(payload: unknown): VideoStoryMeta {
  if (!payload || typeof payload !== 'object') return {};
  const record = payload as Record<string, unknown>;
  const wrapper = record.video_story ?? record.videoStory;
  if (wrapper && typeof wrapper === 'object') {
    const w = wrapper as Record<string, unknown>;
    return {
      title: typeof w.title === 'string' ? w.title : null,
      summary: typeof w.summary === 'string' ? w.summary : null,
    };
  }
  return {};
}
