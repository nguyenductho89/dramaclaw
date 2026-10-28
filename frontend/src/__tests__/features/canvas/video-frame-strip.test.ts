// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  captureVideoFrames,
  clearVideoFrameCache,
} from '@/features/canvas/application/videoFrameStrip';

/** Fake <video>: jsdom does not decode, so seeked/loadeddata are fed manually by each test. */
class FakeVideo {
  listeners = new Map<string, Set<() => void>>();
  duration = 8;
  videoWidth = 1920;
  videoHeight = 1080;
  currentTime = 0;
  muted = false;
  playsInline = false;
  preload = '';
  crossOrigin: string | null = null;
  src = '';
  loadCount = 0;

  addEventListener(type: string, cb: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }

  removeEventListener(type: string, cb: () => void) {
    this.listeners.get(type)?.delete(cb);
  }

  removeAttribute() {}

  load() {
    this.loadCount += 1;
  }

  emit(type: string) {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb();
  }

  get listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

let videos: FakeVideo[] = [];

function fakeCanvas() {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => {} }),
    toDataURL: () => `frame-${videos[videos.length - 1]?.currentTime ?? 0}`,
  };
  return canvas as unknown as HTMLCanvasElement;
}

/** Run a whole strip: loadeddata + count seeked events. */
function feed(video: FakeVideo, count: number) {
  video.emit('loadeddata');
  for (let i = 0; i < count; i += 1) video.emit('seeked');
}

beforeEach(() => {
  videos = [];
  clearVideoFrameCache();
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag === 'video') {
      const video = new FakeVideo();
      videos.push(video);
      return video as unknown as HTMLVideoElement;
    }
    if (tag === 'canvas') return fakeCanvas();
    throw new Error(`unexpected createElement(${tag})`);
  }) as typeof document.createElement);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  clearVideoFrameCache();
});

describe('captureVideoFrames', () => {
  it('reuses the result by (src, count) once fully captured, without opening a second <video>', async () => {
    const first = captureVideoFrames('https://cdn.example.com/a.mp4', 3);
    feed(videos[0], 3);
    expect(await first).toHaveLength(3);
    expect(videos).toHaveLength(1);

    // Hit the cache when the panel is mounted repeatedly (LOD, mode switches), saving a whole round of seek + decode.
    expect(await captureVideoFrames('https://cdn.example.com/a.mp4', 3)).toHaveLength(3);
    expect(videos).toHaveLength(1);
  });

  it('recaptures when src or frame count changes', async () => {
    const first = captureVideoFrames('https://cdn.example.com/a.mp4', 3);
    feed(videos[0], 3);
    await first;

    const other = captureVideoFrames('https://cdn.example.com/b.mp4', 3);
    feed(videos[1], 3);
    await other;

    const wider = captureVideoFrames('https://cdn.example.com/a.mp4', 4);
    feed(videos[2], 4);
    await wider;

    expect(videos).toHaveLength(3);
  });

  it('removes listeners and src when finished', async () => {
    const pending = captureVideoFrames('https://cdn.example.com/a.mp4', 2);
    feed(videos[0], 2);
    await pending;

    expect(videos[0].listenerCount).toBe(0);
  });

  it('times out with an error when stuck before any frame is captured, instead of hanging forever', async () => {
    vi.useFakeTimers();
    const pending = captureVideoFrames('https://cdn.example.com/stuck.mp4', 4);
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    videos[0].emit('loadeddata'); // seek issued, seeked never comes back
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(videos[0].listenerCount).toBe(0);
  });

  it('hands back a partial strip when stuck halfway, and does not cache it', async () => {
    vi.useFakeTimers();
    const pending = captureVideoFrames('https://cdn.example.com/half.mp4', 4);
    videos[0].emit('loadeddata');
    videos[0].emit('seeked');
    videos[0].emit('seeked');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toHaveLength(2);

    // Degraded results are not cached: the next mount still gets a chance to capture fully.
    vi.useRealTimers();
    const retry = captureVideoFrames('https://cdn.example.com/half.mp4', 4);
    expect(videos).toHaveLength(2);
    feed(videos[1], 4);
    expect(await retry).toHaveLength(4);
  });

  it('does not cache failures, so the next attempt can retry', async () => {
    const pending = captureVideoFrames('https://cdn.example.com/bad.mp4', 2);
    const assertion = expect(pending).rejects.toThrow(/video element error/);
    videos[0].emit('error');
    await assertion;

    const retry = captureVideoFrames('https://cdn.example.com/bad.mp4', 2);
    expect(videos).toHaveLength(2);
    feed(videos[1], 2);
    expect(await retry).toHaveLength(2);
  });
});
