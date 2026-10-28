// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Execution chain for frame crop: fetch the source video -> crop in the browser -> upload to OSS. Creating nodes and connecting edges is left to VideoNode;
// this file does not touch the canvas store, which keeps it easy to unit test.
import { uploadFreezoneVideo } from "@/api/ops";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import type { CropBox } from "@/features/canvas/application/videoCrop/cropMath";
import { cropVideoBlob, VideoCropError } from "@/features/canvas/application/videoCrop/cropVideo";

export interface CropAndUploadOptions {
  projectId: string;
  videoUrl: string;
  box: CropBox;
  sourceWidth: number;
  sourceHeight: number;
  signal?: AbortSignal;
}

export interface CropAndUploadResult {
  url: string;
  width: number;
  height: number;
  durationMs: number;
}

export async function cropAndUploadVideo(options: CropAndUploadOptions): Promise<CropAndUploadResult> {
  const { signal } = options;
  let response: Response;
  let source: Blob;
  try {
    // response.blob() sits in the same try as fetch(): if aborted while the body is still being read, fetch()
    // itself resolved long ago and it is this step's stream read that throws AbortError. If it were not caught here it would
    // be treated as an ordinary failure and surface as "crop failed" rather than "crop canceled".
    response = await fetch(resolveImageDisplayUrl(options.videoUrl), { signal });
    if (!response.ok) throw new VideoCropError("fetchFailed", String(response.status));
    source = await response.blob();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new VideoCropError("canceled", "aborted during fetch");
    }
    throw error;
  }
  if (signal?.aborted) throw new VideoCropError("canceled", "aborted after fetch");

  const cropped = await cropVideoBlob({
    blob: source,
    box: options.box,
    sourceWidth: options.sourceWidth,
    sourceHeight: options.sourceHeight,
    signal,
  });

  if (signal?.aborted) {
    // The crop result is ready but the user already clicked cancel. Nothing has been uploaded to OSS yet, so skip the upload and leave no orphan.
    throw new VideoCropError("canceled", "aborted before upload");
  }

  let url: string;
  try {
    ({ url } = await uploadFreezoneVideo(
      options.projectId,
      cropped.blob,
      `video-crop-${Date.now()}.mp4`,
      { signal },
    ));
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new VideoCropError("canceled", "aborted during upload");
    }
    throw error;
  }
  // Upload can now truly be aborted, but a narrow window remains: the server has received the whole body and replied,
  // and the user clicks cancel almost simultaneously, so ky may not get to turn this successful response into an AbortError. This is
  // the safety net: the file is already on OSS (we do not delete it, see the upload call site above), but no node is created.
  if (signal?.aborted) {
    throw new VideoCropError("canceled", "aborted during upload");
  }
  return { url, width: cropped.width, height: cropped.height, durationMs: cropped.durationMs };
}
