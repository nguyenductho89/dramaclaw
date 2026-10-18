// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { activeClipAt, type ComposeTimelineState } from "./timelineModel";

/**
 * Pure logic utilities for cover frame picking (no React). Resolve "some ms on the timeline" into a capturable source address + the time within
 * the source, and draw a <video> element already sought to the target frame into a JPEG Blob. The loading / seek of the capture
 * element is left to the caller (the cover editor holds a visible preview <video>).
 */

export interface CoverFrameSource {
  sourceUrl: string;
  /** The time within the source media (ms) corresponding to that timeline moment (trim/speed conversion already included). */
  sourceMs: number;
}

/**
 * At some ms on the timeline, take the source address and in-source time of the "topmost hit" video clip (the same track-picking rule as
 * the preview stage: a later video track in the array is on top). Returns null when it falls in a gap / there is no video.
 */
export function coverFrameSourceAt(
  timeline: ComposeTimelineState,
  ms: number,
): CoverFrameSource | null {
  const videos = timeline.tracks.filter((track) => track.kind === "video");
  for (let i = videos.length - 1; i >= 0; i -= 1) {
    const active = activeClipAt(videos[i], ms);
    if (active) {
      return { sourceUrl: active.laid.clip.sourceUrl, sourceMs: active.sourceMs };
    }
  }
  return null;
}

/** Whether the timeline contains any capturable video clip (used to disable the "pick frame" tab). */
export function hasCoverableVideo(timeline: ComposeTimelineState): boolean {
  return timeline.tracks.some(
    (track) => track.kind === "video" && track.clips.length > 0,
  );
}

/**
 * Wait for the <video> element's pending seek to settle and the current frame to be drawable (readyState >= HAVE_CURRENT_DATA).
 * Frame capture must wait for this first - when the user finishes dragging the frame-picking slider and immediately clicks OK the element is often still seeking, and
 * drawImage would draw the previous decoded frame rather than the chosen one. A timeout fallback returns (capture the current frame, no waiting forever).
 */
export function waitForVideoFrameReady(
  video: HTMLVideoElement,
  timeoutMs = 3000,
): Promise<void> {
  if (!video.seeking && video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener("seeked", check);
      video.removeEventListener("canplay", check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (!video.seeking && video.readyState >= 2) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    video.addEventListener("seeked", check);
    video.addEventListener("canplay", check);
  });
}

/**
 * Draw a <video> element already sought to the target frame onto an offscreen canvas and export a JPEG Blob.
 * After the source goes through the Vite proxy / Worker reverse proxy it is same-origin with the page, so the canvas is not tainted. Returns null when there is no size / no 2d
 * context / encoding fails.
 */
export function captureVideoFrame(
  video: HTMLVideoElement,
  quality = 0.9,
): Promise<Blob | null> {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return Promise.resolve(null);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(video, 0, 0, w, h);
  return new Promise((resolve) =>
    canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality),
  );
}
