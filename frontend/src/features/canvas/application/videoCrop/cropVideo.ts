// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Encoding for frame cropping: mediabunny Conversion has built-in crop (after rotation, before scaling, in display pixel space).
// The video is re-encoded to H.264 and the audio track is passed through when possible. Runs on the main thread, since encoding/decoding itself is done asynchronously by WebCodecs.
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  ConversionCanceledError,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
} from "mediabunny";

import { toEvenSourceRect, type CropBox } from "@/features/canvas/application/videoCrop/cropMath";

/** Same limit as MAX_TRANSCODE_BYTES in videoTranscode: BufferTarget holds the whole output in memory. */
export const CROP_MAX_SOURCE_BYTES = 800 * 1024 * 1024;

export type VideoCropErrorCode =
  | "tooLarge"
  | "noVideoTrack"
  | "cannotDecode"
  | "fetchFailed"
  | "canceled"
  | "failed";

export class VideoCropError extends Error {
  readonly code: VideoCropErrorCode;

  constructor(code: VideoCropErrorCode, message: string) {
    super(message);
    this.name = "VideoCropError";
    this.code = code;
  }
}

export interface CropVideoOptions {
  blob: Blob;
  /** The box in the UI, in the sourceWidth × sourceHeight coordinate system. Omitted = no frame crop (time range only). */
  box?: CropBox;
  sourceWidth?: number;
  sourceHeight?: number;
  /** Keep only this segment of the source video (milliseconds). Smart extend uses it to actually trim out the selection before feeding the model. */
  trim?: { startMs: number; endMs: number };
  onProgress?: (progress: number) => void;
  /** Cancel midway: short-circuit if already aborted, otherwise forward to conversion.cancel() once running. */
  signal?: AbortSignal;
}

export interface CropVideoResult {
  blob: Blob;
  width: number;
  height: number;
  durationMs: number;
}

// no_encodable_target_codec means the browser has no H.264 encoder, not that the source cannot be decoded, so it must not be classified as cannotDecode.
const UNDECODABLE_VIDEO_REASONS = new Set(["unknown_source_codec", "undecodable_source_codec"]);

export async function cropVideoBlob({
  blob,
  box,
  sourceWidth = 0,
  sourceHeight = 0,
  trim,
  onProgress,
  signal,
}: CropVideoOptions): Promise<CropVideoResult> {
  if (blob.size > CROP_MAX_SOURCE_BYTES) {
    throw new VideoCropError("tooLarge", `${Math.round(blob.size / 1024 / 1024)} MB`);
  }
  if (signal?.aborted) {
    // Already canceled before starting, so there is no need to even open the Input.
    throw new VideoCropError("canceled", "aborted before starting");
  }
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new VideoCropError("noVideoTrack", "no video track");
    if (!(await track.canDecode())) {
      throw new VideoCropError("cannotDecode", String(await track.getCodec()));
    }

    // The node's widthPx/heightPx may be stale (e.g. after the video was replaced), so use the track display size,
    // and scale the box proportionally and round to even numbers, otherwise the crop would be off.
    const displayWidth = await track.getDisplayWidth();
    const displayHeight = await track.getDisplayHeight();
    const scaleX = sourceWidth > 0 ? displayWidth / sourceWidth : 1;
    const scaleY = sourceHeight > 0 ? displayHeight / sourceHeight : 1;
    const rect = box
      ? toEvenSourceRect(
          { x: box.x * scaleX, y: box.y * scaleY, width: box.width * scaleX, height: box.height * scaleY },
          displayWidth,
          displayHeight,
        )
      : null;

    const audioTrack = await input.getPrimaryAudioTrack();
    const audioCodec = audioTrack ? await audioTrack.getCodec() : null;
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target: new BufferTarget(),
    });
    const conversion = await Conversion.init({
      input,
      output,
      video: { codec: "avc", bitrate: QUALITY_HIGH, ...(rect ? { crop: rect } : {}) },
      // AAC/MP3 pass through without re-encoding; others (pcm, ac3, opus...) are re-encoded to AAC, consistent with videoTranscode.
      audio:
        audioCodec && !["aac", "mp3"].includes(audioCodec)
          ? { codec: "aac", bitrate: 128_000 }
          : undefined,
      ...(trim ? { trim: { start: trim.startMs / 1000, end: trim.endMs / 1000 } } : {}),
      showWarnings: false,
    });

    const reasons = conversion.discardedTracks
      .map((entry) => `${entry.track.type}:${entry.reason}`)
      .join(", ");
    // isValid may still be true when the video track was dropped (the audio track remains), which would produce an audio-only file.
    const droppedVideo = conversion.discardedTracks.find((entry) => entry.track.type === "video");
    if (droppedVideo) {
      throw new VideoCropError(
        UNDECODABLE_VIDEO_REASONS.has(droppedVideo.reason) ? "cannotDecode" : "failed",
        reasons,
      );
    }
    if (!conversion.isValid) throw new VideoCropError("failed", `conversion invalid (${reasons})`);

    conversion.onProgress = (progress) => onProgress?.(progress);

    if (signal?.aborted) {
      // init() itself has no cancel hook and can only be checked after it finishes; this covers the window
      // where cancellation happens during init, avoiding a wasted execute().
      throw new VideoCropError("canceled", "aborted before execute");
    }
    // conversion.cancel() returns a Promise<void>; if not caught, a rejection of cancel itself
    // (e.g. when execute() has already finished by then) becomes an unhandled rejection.
    const onAbort = () => void conversion.cancel().catch(() => {});
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await conversion.execute();
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }

    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer || buffer.byteLength === 0) {
      throw new VideoCropError("failed", "conversion produced empty output");
    }
    const sourceDurationMs = Math.round((await input.computeDuration()) * 1000);
    return {
      blob: new Blob([buffer], { type: "video/mp4" }),
      width: rect ? rect.width : displayWidth,
      height: rect ? rect.height : displayHeight,
      durationMs: trim
        ? Math.max(0, Math.min(trim.endMs, sourceDurationMs) - Math.max(trim.startMs, 0))
        : sourceDurationMs,
    };
  } catch (error) {
    if (error instanceof VideoCropError) throw error;
    if (error instanceof ConversionCanceledError || signal?.aborted) {
      throw new VideoCropError("canceled", error instanceof Error ? error.message : String(error));
    }
    throw new VideoCropError("failed", error instanceof Error ? error.message : String(error));
  } finally {
    input.dispose();
  }
}
