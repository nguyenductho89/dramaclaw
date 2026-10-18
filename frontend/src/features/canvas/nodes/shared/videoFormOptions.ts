// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// Pure constants / pure functions / pure types **shared** by the video generation form and the video node.
//
// This layer is extracted for one reason only: `VideoGenerationForm` is imported by `VideoNode` (one-way dependency),
// but the symbols below are needed on both sides (the node computes reference caps and the form draws cap badges; the node clamps duration and
// the form slider clamps duration…). Putting them in the form file and having the node import back would produce the odd smell of "a UI component exporting domain
// constants"; here both sides merely import a small module with no React dependency.

import type { VideoGenMode } from "@/features/canvas/domain/canvasNodes";
import type { FreezoneVideoAspectRatio } from "@/api/ops";

export const ASPECT_RATIOS: ReadonlyArray<FreezoneVideoAspectRatio> = [
  "auto",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
  "21:9",
];

// Hard upper limit of upstream reference counts per genMode. The UI uses this table to express the backend field constraints (multi-image / multimodal
// scenarios) explicitly: over-limit chips are grayed out and removed from the @ candidates, avoiding "the prompt references
// @image10 but it is silently dropped on submit".
//
// These are the **default** caps; when the media catalog (Admin config) declares referenceImageMax /
// referenceVideoMax / referenceAudioMax for a model, they are overridden per model, see referenceCapsForMode().
// Modes absent from the table are unlimited by default (textToVideo consumes no upstream) and take the original path.
//   - firstFrame / imageToVideo: both accept only 1 image; the former locks the first frame, the latter serves as an overall picture reference.
//   - imageReference: image reference, image 1-9.
//   - videoEdit            : video 1 + image ≤5 (HappyHorse video edit).
//   - allReference (omni)  : image 1-9 / video 0-3 / audio 0-3. The part of total duration ≤ 15s
//                            cannot get precise media metadata on the frontend, deferred to the server.
//   - firstLastFrame       : only 2 images (first frame + last frame), no video / audio allowed.
//                            With images >2 there is another fallback that auto-switches to allReference (see the
//                            effect inside VideoNode).
export const REFERENCE_CAPS_BY_MODE: Partial<
  Record<VideoGenMode, { image: number; video: number; audio: number }>
> = {
  firstFrame: { image: 1, video: 0, audio: 0 },
  imageToVideo: { image: 1, video: 0, audio: 0 },
  imageReference: { image: 9, video: 0, audio: 0 },
  videoEdit: { image: 5, video: 1, audio: 0 },
  videoExtend: { image: 0, video: 1, audio: 0 },
  allReference: { image: 9, video: 3, audio: 3 },
  firstLastFrame: { image: 2, video: 0, audio: 0 },
};

// The 1 image of first frame and single-image image-to-video is a structural limit and cannot be overridden by catalog capacity.
const FIXED_IMAGE_CAP_BY_MODE: Partial<Record<VideoGenMode, number>> = {
  firstFrame: 1,
  imageToVideo: 1,
};

/** The model fields in the media catalog that can declare per-type asset caps (#210). */
export interface ReferenceCapModel {
  referenceImageMax?: number | null;
  referenceVideoMax?: number | null;
  referenceAudioMax?: number | null;
}

/**
 * The actual asset caps of the current mode: take REFERENCE_CAPS_BY_MODE as the base, overridden item by item by the caps the model itself
 * declares in the media catalog. A mode not in the table (textToVideo) returns null = unlimited.
 */
export function referenceCapsForMode(
  model: ReferenceCapModel | null | undefined,
  mode: VideoGenMode,
): { image: number; video: number; audio: number } | null {
  const defaults = REFERENCE_CAPS_BY_MODE[mode];
  if (!defaults) return null;
  return {
    image: FIXED_IMAGE_CAP_BY_MODE[mode] ?? model?.referenceImageMax ?? defaults.image,
    video: mode === "videoExtend" ? 1 : model?.referenceVideoMax ?? defaults.video,
    audio: model?.referenceAudioMax ?? defaults.audio,
  };
}

/** Whether the model carries Admin-configured asset caps (decides whether omni's total cap uses the configured value or the old 12). */
export function hasConfiguredReferenceCaps(
  model: ReferenceCapModel | null | undefined,
): boolean {
  return (
    model?.referenceImageMax != null ||
    model?.referenceVideoMax != null ||
    model?.referenceAudioMax != null
  );
}

export function clampVideoDuration(
  value: number,
  bounds: { min: number; max: number },
): number {
  return Math.min(Math.max(Math.round(value), bounds.min), bounds.max);
}

export function isHappyHorseVideoModel(modelId: string | null | undefined): boolean {
  const normalized = String(modelId ?? "")
    .replace(/[\s._-]/g, "")
    .toLowerCase();
  return normalized.includes("happyhorse10");
}

export type ReferenceMediaItem =
  | {
      kind: "image";
      nodeId: string;
      imageUrl: string;
      displayName?: string | null;
    }
  | {
      kind: "video";
      nodeId: string;
      videoUrl: string;
      thumbUrl?: string | null;
      displayName?: string | null;
    }
  | {
      kind: "audio";
      nodeId: string;
      audioUrl: string;
      displayName?: string | null;
    };

export interface ReferenceMediaCapEntry {
  item: ReferenceMediaItem;
  /** 1-based same-type index (image/video/audio each accumulate), aligned with the chip badge + @ mention. */
  typeIndex: number;
  /** Whether within the current mode's reference cap; modes absent from the table default to true. */
  withinCap: boolean;
}

const REFERENCE_MEDIA_KIND_LABEL: Record<ReferenceMediaItem["kind"], string> = {
  image: "image",
  video: "video",
  audio: "audio",
};

export function formatReferenceMediaCompilerLabel(entry: ReferenceMediaCapEntry): string {
  const { item, typeIndex } = entry;
  const title =
    typeof item.displayName === "string" && item.displayName.trim().length > 0
      ? item.displayName.trim()
      : item.nodeId;
  return `${REFERENCE_MEDIA_KIND_LABEL[item.kind]}${typeIndex}: ${title}`;
}
