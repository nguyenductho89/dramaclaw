// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Before submitting a smart extend, actually cut out the selection: fetch the source video → re-encode the time range in the browser → upload to OSS; the resulting
// URL replaces the whole source video as the reference material. It shares the mediabunny encoding chain with frame cropping, so the aspect ratio
// is preserved as-is (backend compose pads portrait material with 16:9 black bars, which cannot serve as the lead-in for an extension).
import { uploadFreezoneVideo } from "@/api/ops";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import { cropVideoBlob, VideoCropError } from "@/features/canvas/application/videoCrop/cropVideo";
import type { ExtendClipRange } from "@/features/canvas/application/videoExtendClip";

export interface ExtendTrimResult {
  url: string;
  durationMs: number;
}

// Each segment is cut only once: retries after a failed generation and multi-output runs all reuse this result. It is kept in memory only, not written to node
// data -- persisting it would make it yet another media field to copy/migrate with the canvas, while re-cutting a few seconds of
// video is cheap. Failures are not cached; the next submit starts over.
const cache = new Map<string, Promise<ExtendTrimResult>>();

export function trimAndUploadExtendClip(options: {
  projectId: string;
  videoUrl: string;
  range: ExtendClipRange;
}): Promise<ExtendTrimResult> {
  const { projectId, videoUrl, range } = options;
  const key = [projectId, videoUrl, range.startMs, range.endMs].join("|");
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = run(projectId, videoUrl, range).catch((error: unknown) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, pending);
  return pending;
}

async function run(projectId: string, videoUrl: string, range: ExtendClipRange): Promise<ExtendTrimResult> {
  const response = await fetch(resolveImageDisplayUrl(videoUrl));
  if (!response.ok) throw new VideoCropError("fetchFailed", String(response.status));
  const trimmed = await cropVideoBlob({ blob: await response.blob(), trim: range });
  const { url } = await uploadFreezoneVideo(projectId, trimmed.blob, `video-extend-${Date.now()}.mp4`);
  return { url, durationMs: trimmed.durationMs };
}

/** For unit-test cleanup only. */
export function resetExtendTrimCacheForTest(): void {
  cache.clear();
}
