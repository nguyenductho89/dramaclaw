// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Common facility for capturing a single frame from a video URL.
 *
 * Two consumers:
 *   1. The user action "capture current frame / first frame / last frame" - needs a full-size PNG, uploaded right after use.
 *   2. The static thumbnails at the canvas low-zoom tier (LOD) - need small JPEGs, kept in a module-level cache for long-term reuse.
 *
 * Both share the same offscreen <video> pipeline: cross-origin CDN media (in production `/projects/.../media/*`
 * gets a 302 from the backend to a presigned OSS) must be loaded with CORS, otherwise drawing it into a canvas taints it and the export throws.
 * The decision goes uniformly through [[mediaNeedsCrossOrigin]].
 *
 * Deliberately not reusing the <video> being shown on the canvas: it has no crossOrigin set (once a media source does not return
 * CORS headers, setting it would make the video fail to load and the whole node go black, a cost far greater than missing one thumbnail), so capturing frames
 * from it necessarily fails by tainting in production. An offscreen element has no such concern - a load failure only means one image is missing.
 */

import { mediaNeedsCrossOrigin } from '@/features/canvas/application/imageData';

type VideoFrameOptions = {
  /**
   * Default `auto`: a user-triggered frame capture should produce a result as fast as possible. LOD thumbnails use `metadata`,
   * fetching only enough bytes to decode the first frame, avoiding downloading a whole video for a 320px image.
   */
  preload?: 'auto' | 'metadata';
  /** Reject on timeout and release the concurrency slot. When not passed it never times out (keeping the existing frame capture behavior unchanged). */
  timeoutMs?: number;
};

/**
 * Start an offscreen <video>, seek to the specified second, wait for that frame to finish decoding, then hand it to `render`.
 *
 * The video element `render` receives is reclaimed after the callback returns (or its Promise settles),
 * so do not store it for asynchronous use.
 */
async function withVideoFrame<T>(
  src: string,
  seekSec: number,
  render: (video: HTMLVideoElement) => T | Promise<T>,
  options?: VideoFrameOptions,
): Promise<T> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = options?.preload ?? 'auto';
  if (mediaNeedsCrossOrigin(src)) video.crossOrigin = 'anonymous';

  try {
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: number | null = null;

      const finish = (run: () => void) => {
        if (settled) return;
        settled = true;
        if (timer !== null) window.clearTimeout(timer);
        run();
      };
      const fail = (reason: unknown) =>
        finish(() =>
          reject(reason instanceof Error ? reason : new Error(String(reason))),
        );
      const done = (value: T) => finish(() => resolve(value));

      const timeoutMs = options?.timeoutMs;
      if (timeoutMs !== undefined) {
        timer = window.setTimeout(
          () => fail(`video frame capture timed out after ${timeoutMs}ms`),
          timeoutMs,
        );
      }

      video.addEventListener('error', () => fail('video element error'));
      video.addEventListener(
        'loadeddata',
        () => {
          const duration = video.duration;
          if (!Number.isFinite(duration) || duration <= 0) {
            fail('invalid video duration');
            return;
          }
          const targetTime = Math.max(
            0,
            Math.min(seekSec, Math.max(0, duration - 0.05)),
          );
          video.addEventListener(
            'seeked',
            () => {
              void (async () => {
                try {
                  done(await render(video));
                } catch (error) {
                  fail(error);
                }
              })();
            },
            { once: true },
          );
          try {
            video.currentTime = targetTime;
          } catch (error) {
            fail(error);
          }
        },
        { once: true },
      );

      video.src = src;
      try {
        video.load();
      } catch {
        // ignored
      }
    });
  } finally {
    video.removeAttribute('src');
    try {
      video.load();
    } catch {
      // ignored
    }
  }
}

/**
 * Capture one video frame as a full-size PNG blob. For user actions such as "capture first/last/current frame".
 */
export async function captureVideoFrameBlob(
  src: string,
  seekSec: number,
): Promise<Blob> {
  return await withVideoFrame(
    src,
    seekSec,
    (video) =>
      new Promise<Blob>((resolve, reject) => {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('canvas context unavailable'));
          return;
        }
        ctx.drawImage(video, 0, 0);
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('canvas.toBlob returned null'));
        }, 'image/png');
      }),
  );
}

/* ------------------------------------------------------------------------- *
 * Low-zoom tier (LOD) static thumbnails
 *
 * When the canvas is zoomed below 0.35, the <video> in video nodes is replaced with the static image produced here: each
 * <video> is an independent compositing layer, whose count grows linearly with visible nodes, and measurement shows only degrading together with the video layers
 * brings p90 frame time back from 26ms to 14ms (see the measured data in [[canvasLod]]).
 * ------------------------------------------------------------------------- */

/** At the low-zoom tier a node is under 140px on screen, so a 320px-wide thumbnail is more than enough. */
const LOD_STILL_WIDTH = 320;

/** t=0 is a black/unpainted frame in some browsers, so take 0.1s (consistent with the other cover usages on the canvas). */
const LOD_STILL_SEEK_SEC = 0.1;

/** A ~320px JPEG is about 15-25KB each, and the 400-entry cap corresponds to a few MB, acceptable. */
const LOD_STILL_CACHE_LIMIT = 400;

/**
 * At most 2 offscreen frame captures run at the same time.
 *
 * This is a pure background warm-up task and must not compete for bandwidth and decoders with requests the user is waiting for; the canvas may have
 * dozens of video nodes mounted at once, and without a gate it would launch dozens of video loads at once.
 */
const LOD_STILL_MAX_CONCURRENT = 2;

/** Timeout for a single frame capture. Stuck media must not occupy a concurrency slot for long. */
const LOD_STILL_TIMEOUT_MS = 15_000;

/** key = video URL; value = dataURL, or null meaning "tried but could not get it". */
const lodStills = new Map<string, string | null>();
/** URLs queued or being captured, used for dedup. */
const lodInFlight = new Set<string>();
const lodQueue: string[] = [];
let lodActiveCount = 0;
const lodListeners = new Set<() => void>();

function scheduleIdle(run: () => void): void {
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 2_000 });
    return;
  }
  window.setTimeout(run, 300);
}

function commitLodStill(src: string, still: string | null): void {
  if (lodStills.size >= LOD_STILL_CACHE_LIMIT && !lodStills.has(src)) {
    // Map keeps insertion order, and the earliest written is evicted first.
    const oldest = lodStills.keys().next();
    if (!oldest.done) lodStills.delete(oldest.value);
  }
  lodStills.set(src, still);
  for (const listener of lodListeners) listener();
}

async function runLodCapture(src: string): Promise<void> {
  let still: string | null = null;
  try {
    still = await withVideoFrame(
      src,
      LOD_STILL_SEEK_SEC,
      (video) => {
        const sourceWidth = video.videoWidth || LOD_STILL_WIDTH;
        const sourceHeight = video.videoHeight || LOD_STILL_WIDTH;
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, LOD_STILL_WIDTH / sourceWidth);
        canvas.width = Math.max(1, Math.round(sourceWidth * scale));
        canvas.height = Math.max(1, Math.round(sourceHeight * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.72);
      },
      { preload: 'metadata', timeoutMs: LOD_STILL_TIMEOUT_MS },
    );
  } catch {
    // Load failure / cross-origin tainting / timeout: record null, the render side degrades to a placeholder block, and no retry -
    // failure is often a property of the media source itself, and retrying would only pull the stream repeatedly.
    still = null;
  }
  commitLodStill(src, still);
}

function pumpLodQueue(): void {
  while (lodActiveCount < LOD_STILL_MAX_CONCURRENT && lodQueue.length > 0) {
    const src = lodQueue.shift();
    if (src === undefined) return;
    lodActiveCount += 1;
    scheduleIdle(() => {
      void runLodCapture(src).finally(() => {
        lodActiveCount -= 1;
        lodInFlight.delete(src);
        pumpLodQueue();
      });
    });
  }
}

/**
 * Read the thumbnail from the cache. `null` = none yet (not captured yet, or confirmed uncapturable).
 *
 * Returns synchronously and returns a stable primitive for the same input, usable directly as a `useSyncExternalStore` snapshot.
 */
export function getLodStill(src: string | null | undefined): string | null {
  if (!src) return null;
  return lodStills.get(src) ?? null;
}

/**
 * Request a thumbnail be prepared for this video. Idempotent: if a conclusion exists or it is already queued it returns directly.
 *
 * Deliberately not distinguishing the current zoom tier - at the low-zoom tier no <video> is mounted on the canvas at all, and starting to capture only then
 * would make the user first see a screen of placeholder blocks. Queueing into the idle queue when the node mounts means the thumbnail is already in place by the time of zooming out.
 */
export function requestLodStill(src: string | null | undefined): void {
  if (!src) return;
  if (lodStills.has(src) || lodInFlight.has(src)) return;
  lodInFlight.add(src);
  lodQueue.push(src);
  pumpLodQueue();
}

/** Called back when the cache is written; returns the unsubscribe function. */
export function subscribeLodStills(listener: () => void): () => void {
  lodListeners.add(listener);
  return () => {
    lodListeners.delete(listener);
  };
}
