// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  mediaNeedsCrossOrigin,
  resolveImageDisplayUrl,
} from "@/features/canvas/application/imageData";

/**
 * Video "filmstrip" frame extraction - fill timeline clips with sampled frames (libtv style).
 *
 * Frames are extracted only once per source video and cached by url: the extraction covers the whole source duration, and at render time the nearest frames are tiled by the
 * clip's trim window (trimStart..trimEnd). So dragging the trim handles only swaps the displayed frames,
 * with no re-extraction and very low cost. Cross-origin CDN media (online absolute http(s) addresses) are loaded with
 * crossOrigin='anonymous', otherwise drawing them into a canvas taints it and the export fails; the local `/static`
 * proxy is same-origin so it is not set (consistent with VideoClipPanel.captureFrames).
 */
export interface FilmstripFrame {
  timeMs: number;
  url: string;
}

const cache = new Map<string, Promise<FilmstripFrame[]>>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Get (and cache) the filmstrip frames for a source video. */
export function getFilmstrip(sourceUrl: string): Promise<FilmstripFrame[]> {
  const resolved = resolveImageDisplayUrl(sourceUrl);
  if (!resolved) return Promise.resolve([]);
  const cached = cache.get(resolved);
  if (cached) return cached;
  const pending = captureFilmstrip(resolved).catch((error) => {
    cache.delete(resolved);
    throw error;
  });
  cache.set(resolved, pending);
  return pending;
}

function captureFilmstrip(resolvedSrc: string): Promise<FilmstripFrame[]> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    if (mediaNeedsCrossOrigin(resolvedSrc)) video.crossOrigin = "anonymous";

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      reject(new Error("canvas context unavailable"));
      return;
    }

    const cleanup = () => {
      video.removeAttribute("src");
      try {
        video.load();
      } catch {
        /* ignore */
      }
    };
    const fail = (reason: unknown) => {
      cleanup();
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };

    video.addEventListener("error", () => fail("video element error"));
    video.addEventListener("loadeddata", () => {
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) {
        fail("invalid duration for filmstrip");
        return;
      }
      // ~1 frame/sec, clamped so short clips still get a strip and long ones
      // don't capture forever.
      const count = clamp(Math.round(duration), 6, 40);
      const targetWidth = 120;
      const ratio = video.videoHeight / Math.max(video.videoWidth, 1);
      canvas.width = targetWidth;
      canvas.height = Math.max(1, Math.round(targetWidth * ratio));

      const frames: FilmstripFrame[] = [];
      let index = 0;
      const seekNext = () => {
        if (index >= count) {
          cleanup();
          resolve(frames);
          return;
        }
        const t = (duration * (index + 0.5)) / count;
        video.currentTime = clamp(t, 0, Math.max(0, duration - 0.05));
      };
      video.addEventListener("seeked", () => {
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const t = (duration * (index + 0.5)) / count;
          frames.push({
            timeMs: Math.round(t * 1000),
            url: canvas.toDataURL("image/jpeg", 0.6),
          });
        } catch (error) {
          fail(error);
          return;
        }
        index += 1;
        seekNext();
      });
      seekNext();
    });

    video.src = resolvedSrc;
    try {
      video.load();
    } catch {
      /* ignore — src assignment already kicks off the fetch */
    }
  });
}

/** Pick the captured frame closest to a given source time (ms). */
export function pickFrame(
  frames: FilmstripFrame[],
  timeMs: number,
): FilmstripFrame | null {
  if (frames.length === 0) return null;
  let best = frames[0];
  let bestDelta = Math.abs(frames[0].timeMs - timeMs);
  for (const frame of frames) {
    const delta = Math.abs(frame.timeMs - timeMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = frame;
    }
  }
  return best;
}
