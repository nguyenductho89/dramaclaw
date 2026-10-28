// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { mediaNeedsCrossOrigin } from '@/features/canvas/application/imageData';

/** Decode budget for the whole thumbnail strip. On timeout, return however many frames we have instead of waiting longer. */
const CAPTURE_TIMEOUT_MS = 15_000;
/** Budget for a single seek. If an individual keyframe stalls, skip it rather than dragging down the whole strip. */
const SEEK_TIMEOUT_MS = 4_000;
/** Cache entry limit; the oldest by insertion order is evicted. One strip is about 8 160px JPEGs, on the order of a few hundred KB. */
const CACHE_LIMIT = 12;

const cache = new Map<string, Promise<string[]>>();

function cacheKey(src: string, count: number): string {
  return `${count}|${src}`;
}

/**
 * Sample N evenly spaced frames for a thumbnail strip, using a hidden <video> + <canvas>.
 *
 * Extracted from VideoClipPanel so it can be shared -- the segment re-shoot timeline needs
 * the very same thumbnail strip, and copying it would duplicate the pitfalls below:
 * - Cross-origin CDN media (absolute http(s) URLs in production) needs `crossOrigin='anonymous'`,
 *   otherwise the canvas is tainted and toDataURL throws; same-origin `/static/*`
 *   (the dev vite proxy) must skip it instead -- that origin does not reply with
 *   `Access-Control-Allow-Origin`, and same-origin drawing never taints the canvas anyway.
 * - Before the first seek, wait for `loadeddata` (at least one frame available), otherwise the
 *   first frame is drawn black.
 * - Every step needs a timeout: `seeked` may never arrive on some containers/codecs, and without a
 *   fallback the panel would stay on "Extracting frames..." forever and the hidden <video> would
 *   never be reclaimed.
 *
 * Results are cached by (src, count): the clip panel and the re-shoot track are mounted and
 * unmounted repeatedly (LOD, mode switches), and redoing 8 seeks + decodes each time is the most
 * expensive thing in this panel. Only successful results with all `count` frames are cached;
 * half-strips degraded by a timeout and failures are not cached, so the next mount can retry.
 */
export async function captureVideoFrames(
  src: string,
  count: number,
): Promise<string[]> {
  const key = cacheKey(src, count);
  const cached = cache.get(key);
  if (cached) return await cached;

  const pending = captureUncached(src, count);
  cache.set(key, pending);
  try {
    const frames = await pending;
    if (frames.length < count) {
      // Degraded results are not cached, so the next mount gets another chance to sample all frames.
      cache.delete(key);
    } else if (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next();
      if (!oldest.done && oldest.value !== key) cache.delete(oldest.value);
    }
    return frames;
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}

/** Drop the thumbnail cache of one asset (used when the video is replaced/regenerated). Clears everything if omitted. */
export function clearVideoFrameCache(src?: string): void {
  if (!src) {
    cache.clear();
    return;
  }
  for (const key of [...cache.keys()]) {
    if (key.slice(key.indexOf('|') + 1) === src) cache.delete(key);
  }
}

function captureUncached(src: string, count: number): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    if (mediaNeedsCrossOrigin(src)) video.crossOrigin = 'anonymous';

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      reject(new Error('canvas context unavailable'));
      return;
    }

    const thumbs: string[] = [];
    let settled = false;
    let seekTimer: ReturnType<typeof setTimeout> | null = null;
    let overallTimer: ReturnType<typeof setTimeout> | null = null;

    const onError = () => fail('video element error');
    const onLoadedData = () => start();
    const onSeeked = () => captureCurrent();

    const teardown = () => {
      if (seekTimer !== null) clearTimeout(seekTimer);
      seekTimer = null;
      if (overallTimer !== null) clearTimeout(overallTimer);
      overallTimer = null;
      video.removeEventListener('error', onError);
      video.removeEventListener('loadeddata', onLoadedData);
      video.removeEventListener('seeked', onSeeked);
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        // ignored
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      teardown();
      resolve(thumbs);
    };

    const fail = (reason: unknown) => {
      if (settled) return;
      settled = true;
      teardown();
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };

    // If we time out partway, still hand over the frames we have: half a strip is far more useful than a "load failed" message.
    const onTimeout = () => {
      if (thumbs.length > 0) finish();
      else fail('thumbnail extraction timed out');
    };

    overallTimer = setTimeout(onTimeout, CAPTURE_TIMEOUT_MS);

    let index = 0;

    const seekNext = (duration: number) => {
      if (seekTimer !== null) clearTimeout(seekTimer);
      if (index >= count) {
        finish();
        return;
      }
      const t = (duration * (index + 0.5)) / count;
      // If a single-frame seek never returns, stop rather than skipping it and sampling on: when that
      // `seeked` arrives late it would insert a frame that does not match its position and scramble
      // the strip order. Better to hand over a short strip.
      seekTimer = setTimeout(onTimeout, SEEK_TIMEOUT_MS);
      video.currentTime = Math.min(Math.max(t, 0), Math.max(0, duration - 0.05));
    };

    const captureCurrent = () => {
      if (settled) return;
      if (seekTimer !== null) {
        clearTimeout(seekTimer);
        seekTimer = null;
      }
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        thumbs.push(canvas.toDataURL('image/jpeg', 0.6));
      } catch (error) {
        fail(error);
        return;
      }
      index += 1;
      seekNext(video.duration);
    };

    const start = () => {
      if (settled) return;
      const duration = video.duration;
      if (!isFinite(duration) || duration <= 0) {
        fail('invalid duration for thumbnails');
        return;
      }
      const targetWidth = 160;
      const ratio = video.videoHeight / Math.max(video.videoWidth, 1);
      canvas.width = targetWidth;
      canvas.height = Math.max(1, Math.round(targetWidth * ratio));
      seekNext(duration);
    };

    video.addEventListener('error', onError);
    video.addEventListener('loadeddata', onLoadedData);
    video.addEventListener('seeked', onSeeked);

    video.src = src;
    try {
      video.load();
    } catch {
      // ignored — `src` assignment already kicks off the fetch in most browsers
    }
  });
}
