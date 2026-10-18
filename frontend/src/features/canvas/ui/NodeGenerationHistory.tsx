// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Check,
  Film,
  History,
  Image as ImageIcon,
  Loader2,
  Music,
  RotateCw,
  Box as BoxIcon,
  FileText,
  Globe,
} from 'lucide-react';

import type { FreezoneGenerationHistoryRecord } from '@/api/ops';
import type { TFn } from '@/lib/i18n-types';
import { resolveMediaUrl } from '@/lib/media-url';

/**
 * Pull the displayable output URL out of a history record's `result` payload.
 * The shape varies by task_type, so we probe the known keys in priority order.
 */
export function historyRecordOutputUrl(
  record: FreezoneGenerationHistoryRecord,
): string | null {
  const result = record.result ?? {};
  for (const key of [
    'output_url',
    'image_url',
    'video_url',
    'audio_url',
    'ply_url',
    'master_url',
    'url',
  ]) {
    const value = result[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

export function historyRecordHtmlIdentity(
  record: FreezoneGenerationHistoryRecord,
): { artifactId: string; version: number } | null {
  if (record.media_type !== 'html') return null;
  const result = record.result ?? {};
  const artifactId = typeof result.artifact_id === 'string' ? result.artifact_id.trim() : '';
  const version = result.version;
  if (!artifactId || typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return null;
  }
  return { artifactId, version };
}

/** 3GS extension; a hit counts as a world model product. */
const THREE_GS_EXT_RE = /\.(ply|sog|splat|ksplat|spz)(\?|#|$)/i;

/**
 * Dig the world model (3GS / 360 panorama) product URL out of a record's `result`.
 * A world model url may hide under many keys such as `sog_url` / `splat_url` / `scene_3gs_ply_fs` /
 * `master_ply_url` (even nested), and the generic {@link historyRecordOutputUrl},
 * recognizing only the flat `ply_url`/`url`, would miss it. Here it probes recursively and prefers compressed packages (.sog -> splat -> ply).
 * Kept consistent with ThreeDWorldNode's restore value logic, as the single source of truth for world history.
 */
export function historyRecordWorldUrl(
  record: FreezoneGenerationHistoryRecord,
): string | null {
  const candidates: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 4) return;
    if (typeof value === 'string') {
      if (THREE_GS_EXT_RE.test(value) || /scene_3gs|ply_fs|splat/i.test(value)) {
        candidates.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const preferredKeys = [
        'sog_url',
        'sogUrl',
        'splat_url',
        'splatUrl',
        'ply_url',
        'plyUrl',
        'master_ply_url',
        'masterPlyUrl',
        'scene_3gs_ply_fs',
        'scene_3gs_master_ply_fs',
        'output_url',
        'asset_url',
        'static_url',
        'url',
      ];
      for (const key of preferredKeys) {
        const v = obj[key];
        if (typeof v === 'string' && v.length > 0) candidates.push(v);
      }
      for (const key in obj) {
        if (!preferredKeys.includes(key)) visit(obj[key], depth + 1);
      }
    }
  };
  visit(record.result ?? {}, 0);
  // Prefer compressed SOG / splat packages, then the old bare PLY, and finally fall back to the first candidate (possibly a 360 panorama image).
  const sog = candidates.find((c) => /\.sog(\?|#|$)/i.test(c));
  if (sog) return sog;
  const packaged = candidates.find((c) => /\.(ksplat|splat|spz)(\?|#|$)/i.test(c));
  if (packaged) return packaged;
  const ply = candidates.find((c) => /\.ply(\?|#|$)/i.test(c));
  if (ply) return ply;
  // With no 3GS extension, fall back to the generic output url (360 panoramas are mostly ordinary image urls).
  return candidates[0] ?? historyRecordOutputUrl(record);
}

/**
 * Strictly judge "is this a world (3GS / 360 -> 3GS) generation record" and take its product URL.
 * Unlike {@link historyRecordWorldUrl}: this **only** collects strings in result that truly hit 3GS markers
 * (`.ply/.sog/.splat/...` extensions, or the `scene_3gs/ply_fs/splat` wording), and never
 * unconditionally swallows generic keys like `output_url/url` - so ordinary image/video records return null.
 * Used for bucketing in the history assets dialog: the backend's `media_type` for image-to-3gs records is unreliable (often marked
 * `image` etc.), so a world cannot be judged by media_type alone, and the product structure has to be sniffed like the node side's `pickPlyUrlFromResult`.
 * The return value prefers .sog -> splat package -> bare .ply -> first hit.
 */
export function historyRecordStrictWorldUrl(
  record: FreezoneGenerationHistoryRecord,
): string | null {
  const candidates: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 4) return;
    if (typeof value === 'string') {
      if (THREE_GS_EXT_RE.test(value) || /scene_3gs|ply_fs|splat/i.test(value)) {
        candidates.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        visit((value as Record<string, unknown>)[key], depth + 1);
      }
    }
  };
  visit(record.result ?? {}, 0);
  const sog = candidates.find((c) => /\.sog(\?|#|$)/i.test(c));
  if (sog) return sog;
  const packaged = candidates.find((c) => /\.(ksplat|splat|spz)(\?|#|$)/i.test(c));
  if (packaged) return packaged;
  const ply = candidates.find((c) => /\.ply(\?|#|$)/i.test(c));
  if (ply) return ply;
  return candidates[0] ?? null;
}

/**
 * Take a "preview image URL usable as a thumbnail" - for records whose product is not itself an image (such as a 3D world .sog).
 * Probe the commonly seen preview/source image fields in the result; return null if none, and the fallback passed in by the host takes over.
 */
export function historyRecordPreviewImageUrl(
  record: FreezoneGenerationHistoryRecord,
): string | null {
  const result = record.result ?? {};
  for (const key of [
    'preview_image_url',
    'previewImageUrl',
    'preview_url',
    'previewUrl',
    'cover_url',
    'coverUrl',
    'thumbnail_url',
    'thumbnailUrl',
    'source_image_url',
    'sourceImageUrl',
  ]) {
    const value = result[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  // Fallback: when the product has no preview of its own (such as an image-to-3gs .sog world), use the **input source image** as the cover.
  // The source image url may be at the top level or nested in containers such as input/params/request, and the key names vary (source_url
  // /image_url/url etc.). Only accept image-like urls (by extension), avoiding using .sog/.ply as a cover.
  const input = historyRecordInputImageUrl(record);
  if (input) return input;
  return null;
}

/** An image-like url (common image extensions). */
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|avif|gif|bmp|tiff?)(\?|#|$)/i;
const INPUT_IMAGE_KEYS = [
  'source_url',
  'sourceUrl',
  'source_image_url',
  'sourceImageUrl',
  'input_image_url',
  'inputImageUrl',
  'image_url',
  'imageUrl',
  'master_url',
  'masterUrl',
  'pano_url',
  'panoUrl',
  'url',
];
const INPUT_CONTAINER_KEYS = [
  'input',
  'inputs',
  'params',
  'parameters',
  'request',
  'payload',
  'meta',
  'metadata',
];

/** Dig out an input/source **image** url to use as a cover for non-image
 *  products (3GS worlds etc.). Only accepts image-extension urls so we never
 *  hand back the .sog/.ply product itself. */
export function historyRecordInputImageUrl(
  record: FreezoneGenerationHistoryRecord,
): string | null {
  const result = (record.result ?? {}) as Record<string, unknown>;
  const pickImage = (scope: unknown): string | null => {
    if (!scope || typeof scope !== 'object') return null;
    const rec = scope as Record<string, unknown>;
    for (const key of INPUT_IMAGE_KEYS) {
      const value = rec[key];
      if (typeof value === 'string' && IMAGE_EXT_RE.test(value)) return value;
    }
    return null;
  };
  const direct = pickImage(result);
  if (direct) return direct;
  for (const key of INPUT_CONTAINER_KEYS) {
    const nested = pickImage(result[key]);
    if (nested) return nested;
  }
  return null;
}

// Keys that may carry the human-readable prompt across image/video/audio tasks.
const PROMPT_KEYS = [
  'prompt',
  'composed_prompt',
  'composedPrompt',
  'translated_text',
  'positive_prompt',
  'user_prompt',
  'input_prompt',
  'text',
  'reverse_prompt',
];
// Nested containers a backend might echo the original request under (video gen
// results often only carry the output url; the prompt was an input).
const PROMPT_CONTAINER_KEYS = [
  'input',
  'inputs',
  'params',
  'parameters',
  'request',
  'payload',
  'meta',
  'metadata',
];

function pickPromptString(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  for (const key of PROMPT_KEYS) {
    const value = rec[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

/**
 * Pull a prompt / text payload out of a history record, searching the result,
 * common nested request containers, and top-level record fields. Video gen
 * results typically only store the output url, so the prompt (an input) may be
 * echoed under `result.input`/`params`/etc. or alongside `result` — search all.
 */
export function historyRecordPrompt(
  record: FreezoneGenerationHistoryRecord,
): string | null {
  const result = (record.result ?? {}) as Record<string, unknown>;
  const top = record as unknown as Record<string, unknown>;
  for (const scope of [result, top]) {
    const direct = pickPromptString(scope);
    if (direct) return direct;
    for (const key of PROMPT_CONTAINER_KEYS) {
      const nested = pickPromptString(scope[key]);
      if (nested) return nested;
    }
  }
  return null;
}

function isCompleted(record: FreezoneGenerationHistoryRecord): boolean {
  return record.status === 'completed' || record.status === 'succeeded';
}

/**
 * Whether the history strip would render any entry. Only successful generations
 * show up (failed / pending attempts are filtered out), so a node that has only
 * failed attempts has no visible history — hosts must gate their wrapper on this
 * (not on `records.length`) or they render an empty bordered box. See VideoNode.
 */
export function hasCompletedHistoryRecords(
  records: FreezoneGenerationHistoryRecord[],
): boolean {
  return records.some(isCompleted);
}

function formatRelativeTime(iso: string, t: TFn): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return t('canvas.nodeHistory.secondsAgo', { count: Math.max(sec, 0) });
  const min = Math.round(sec / 60);
  if (min < 60) return t('canvas.nodeHistory.minutesAgo', { count: min });
  const hr = Math.round(min / 60);
  if (hr < 24) return t('canvas.nodeHistory.hoursAgo', { count: hr });
  const day = Math.round(hr / 24);
  if (day < 30) return t('canvas.nodeHistory.daysAgo', { count: day });
  return new Date(then).toLocaleDateString();
}

function MediaFallbackIcon({ mediaType }: { mediaType: string }) {
  const className = 'h-4 w-4 text-text-muted';
  if (mediaType === 'video') return <Film className={className} />;
  if (mediaType === 'audio') return <Music className={className} />;
  if (mediaType === '3d' || mediaType === 'ply') return <BoxIcon className={className} />;
  if (mediaType === 'text') return <FileText className={className} />;
  if (mediaType === 'html') return <Globe className={className} />;
  return <ImageIcon className={className} />;
}

interface NodeGenerationHistoryProps {
  records: FreezoneGenerationHistoryRecord[];
  isLoading?: boolean;
  /** Invoked when the user clicks a (completed) history entry to restore it. */
  onRestore: (record: FreezoneGenerationHistoryRecord) => void;
  onRefresh?: () => void;
  /**
   * Returns true for the record currently shown on the host node, so the strip
   * can highlight it. The host owns the identity (URL / payload match) since the
   * strip stays media-agnostic.
   */
  isActive?: (record: FreezoneGenerationHistoryRecord) => boolean;
  /**
   * When the product is not an image (such as a 3D world .sog) and the record itself has no preview image, use this fallback thumbnail
   * (usually the host node's previewImageUrl, e.g. a scene pano).
   */
  fallbackThumbnailUrl?: string | null;
  className?: string;
  /** When true the whole entry is disabled (e.g. not recoverable while generating): the strip dims, the cursor is not-allowed, and the row buttons are natively disabled. */
  disabled?: boolean;
}

/**
 * Horizontal strip of a node's recent generation history. Image/video records
 * render a thumbnail; other media render a typed icon. Failed records are
 * dimmed and not restorable. The host node owns the restore semantics via
 * `onRestore` (the strip stays media-agnostic).
 */
export function NodeGenerationHistory({
  records,
  isLoading = false,
  onRestore,
  onRefresh,
  isActive,
  fallbackThumbnailUrl,
  className,
  disabled = false,
}: NodeGenerationHistoryProps) {
  const { t } = useTranslation();
  // Only successful generations belong in the history strip — failed / pending
  // / running attempts are noise here. Newest first; the backend already sorts,
  // but guard against ordering drift.
  const sorted = useMemo(
    () =>
      records
        .filter(isCompleted)
        .sort(
          (a, b) =>
            new Date(b.recorded_at).getTime() -
            new Date(a.recorded_at).getTime(),
        ),
    [records],
  );

  if (!isLoading && sorted.length === 0) return null;

  return (
    <div
      className={`flex flex-col gap-1.5 ${disabled ? 'cursor-not-allowed opacity-50' : ''} ${className ?? ''}`}
    >
      <div className="flex items-center justify-between px-0.5">
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-text-muted">
          <History className="h-3 w-3" />
          {t('canvas.nodeHistory.title')}
          {sorted.length > 0 ? ` · ${sorted.length}` : ''}
        </span>
        {onRefresh && (
          <button
            type="button"
            className="nodrag inline-flex h-5 w-5 items-center justify-center rounded text-text-muted transition-colors hover:bg-white/[0.08] hover:text-text-dark"
            onClick={(event) => {
              event.stopPropagation();
              onRefresh();
            }}
            title={t('canvas.nodeHistory.refresh')}
          >
            {isLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RotateCw className="h-3 w-3" />
            )}
          </button>
        )}
      </div>
      <div className="nodrag nowheel flex gap-1.5 overflow-x-auto pb-1">
        {sorted.map((record) => {
          const rawUrl = historyRecordOutputUrl(record);
          const url = resolveMediaUrl(rawUrl);
          // The thumbnail slot is fed only the downsampled variant: the original is often 5504x3072, and drawn into a 56x56 cell
          // each one still needs a full decode + raster - nine measured 2.1s of main-thread long task and 7 dropped frames.
          // `url` stays the original, and what onRestore restores back to the node must be the original product.
          const thumbUrl = resolveMediaUrl(rawUrl, { variant: 'thumb' });
          const completed = isCompleted(record);
          const isImage =
            completed && Boolean(url) && record.media_type === 'image';
          // A video thumbnail cannot use <img> (a src of .mp4 gives a broken image), so use <video> to take the first frame instead.
          const isVideo =
            completed && Boolean(url) && record.media_type === 'video';
          // When the product is not an image/video (such as a 3D world .sog), use the record's own preview image or the host's fallback image as the thumbnail.
          const previewImg =
            completed && !isImage && !isVideo
              ? resolveMediaUrl(
                  historyRecordPreviewImageUrl(record) ?? fallbackThumbnailUrl ?? null,
                  { variant: 'thumb' },
                )
              : null;
          const restorable = completed && Boolean(
            url || historyRecordPrompt(record) || historyRecordHtmlIdentity(record),
          );
          const active = completed && Boolean(isActive?.(record));
          return (
            <button
              key={record.id}
              type="button"
              disabled={disabled || !restorable}
              aria-pressed={active}
              onClick={(event) => {
                event.stopPropagation();
                if (!disabled && restorable) onRestore(record);
              }}
              title={`${formatRelativeTime(record.recorded_at, t)}${
                completed ? '' : ` · ${record.status}`
              }${active ? ` · ${t('canvas.nodeHistory.current')}` : ''}`}
              className={`group relative h-14 w-14 shrink-0 overflow-hidden rounded-[8px] border transition ${
                active
                  ? 'border-[rgb(var(--accent-rgb))]'
                  : completed
                    ? 'border-white/10 hover:border-[rgb(var(--accent-rgb))]'
                    : 'border-rose-500/40'
              } ${restorable && !disabled ? 'cursor-pointer' : 'cursor-not-allowed'}`}
            >
              {isImage ? (
                <img
                  src={thumbUrl ?? undefined}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                />
              ) : isVideo ? (
                <video
                  src={url ?? undefined}
                  className="h-full w-full object-cover"
                  muted
                  playsInline
                  preload="metadata"
                />
              ) : previewImg ? (
                <img
                  src={previewImg}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center bg-white/[0.04]">
                  <MediaFallbackIcon mediaType={record.media_type} />
                </span>
              )}
              {!completed && (
                <span className="absolute right-0.5 top-0.5 rounded-full bg-rose-500/90 p-0.5">
                  <AlertCircle className="h-2.5 w-2.5 text-white" />
                </span>
              )}
              {active && (
                // Filled accent dot with a check, clearly marking which entry
                // is the one currently shown on the host node. The
                // surface-dark ring fakes a small "cutout" against the
                // thumbnail so the badge reads cleanly over any image.
                <span className="pointer-events-none absolute right-1 top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[rgb(var(--accent-rgb))] shadow-sm ring-1 ring-surface-dark">
                  <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />
                </span>
              )}
              <span
                className={`pointer-events-none absolute inset-x-0 bottom-0 truncate px-1 py-0.5 text-[9px] leading-none ${
                  active
                    ? 'bg-[rgb(var(--accent-rgb)/0.85)] text-white'
                    : 'bg-black/55 text-white/80'
                }`}
              >
                {formatRelativeTime(record.recorded_at, t)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
