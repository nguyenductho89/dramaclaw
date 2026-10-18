// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Audio waveform peak decoding + module-level cache.
 *
 * Used to draw waveforms for audio clips on the "video compose" timeline: by a fixed density ({@link PEAK_BUCKETS_PER_SEC}),
 * downsample the whole source audio into a normalized peak array, and the timeline then slices and draws it by the clip's trim window.
 * decodeAudioData is not cheap, so the same src is decoded only once with an LRU cache; concurrent requests reuse the same promise.
 */

/** Peak sampling density (buckets per second). The waveform is sliced by this density; larger is finer. */
export const PEAK_BUCKETS_PER_SEC = 120;

const CACHE_MAX = 60;
const cache = new Map<string, Float32Array>();
const inflight = new Map<string, Promise<Float32Array>>();

function cachePeaks(src: string, peaks: Float32Array): void {
  cache.delete(src); // A hit refreshes it to the end of "most recently used"
  cache.set(src, peaks);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function computePeaks(buffer: AudioBuffer): Float32Array {
  const channel = buffer.getChannelData(0);
  const bucketCount = Math.max(1, Math.ceil(buffer.duration * PEAK_BUCKETS_PER_SEC));
  const samplesPerBucket = Math.max(1, Math.floor(channel.length / bucketCount));
  const peaks = new Float32Array(bucketCount);
  let max = 0;
  for (let i = 0; i < bucketCount; i += 1) {
    const start = i * samplesPerBucket;
    const end = Math.min(channel.length, start + samplesPerBucket);
    let peak = 0;
    for (let j = start; j < end; j += 1) {
      const v = Math.abs(channel[j]);
      if (v > peak) peak = v;
    }
    peaks[i] = peak;
    if (peak > max) max = peak;
  }
  // Normalize, amplifying quieter material for easier viewing.
  if (max > 0) {
    for (let i = 0; i < peaks.length; i += 1) peaks[i] /= max;
  }
  return peaks;
}

/** Peaks already decoded and cached (read synchronously, returns null if not cached). */
export function getCachedAudioPeaks(src: string): Float32Array | null {
  return cache.get(src) ?? null;
}

/** Fetch + decode + downsample the audio, returning a normalized peak array (with cache / concurrent dedup). */
export async function loadAudioPeaks(src: string): Promise<Float32Array> {
  const cached = cache.get(src);
  if (cached) {
    cachePeaks(src, cached); // LRU bump
    return cached;
  }
  const existing = inflight.get(src);
  if (existing) return existing;

  const task = (async () => {
    const res = await fetch(src);
    const arrayBuffer = await res.arrayBuffer();
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new Ctx();
    try {
      const decoded = await ctx.decodeAudioData(arrayBuffer);
      const peaks = computePeaks(decoded);
      cachePeaks(src, peaks);
      return peaks;
    } finally {
      void ctx.close?.();
      inflight.delete(src);
    }
  })();
  inflight.set(src, task);
  return task;
}
