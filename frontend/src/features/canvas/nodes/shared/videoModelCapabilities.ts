// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type {
  VideoGenMode,
  VideoKeyframeSlot,
} from "@/features/canvas/domain/canvasNodes";

/**
 * The **capability basis** of Freezone canvas video models — aligned one to one with the model gates of each video endpoint in the backend `freezone.py`,
 * serving as the **single source of truth** for CTAs / mode visibility / auto-derived defaults / submit validation,
 * so the assumption "treat every non-HappyHorse model as Seedance 2.0" does not scatter across components.
 *
 * Backend facts (src/novelvideo/api/routes/freezone.py):
 * - All reference omni-gen: `is_freezone_seedance2_backend` being false gives a direct 400;
 * - First-last-frame keyframes: only Seedance 2.0 appends the last frame, the rest of the backend **silently drops the last frame**;
 * - Image-to-video i2v / first-last-frame keyframes / video edit edit: all **do not validate the prompt** (an empty prompt is allowed);
 * - Video edit edit: HappyHorse only.
 *
 * Model id / apiModel looks like `newapi_seedance-2.0-fast` / `newapi_seedance-1.0-pro-fast`
 * / `newapi_happyhorse-1.0` (see freezone/video_node.py). Here separators are stripped uniformly and matching is by version-number
 * prefix, avoiding `2.0` being mis-hit as `1.x` (`seedance1\d` only eats `seedance1` followed by a digit).
 */

function normalizeVideoModelId(modelId: string | null | undefined): string {
  return String(modelId ?? "")
    .replace(/[\s._-]/g, "")
    .toLowerCase();
}

export function isHappyHorseVideoModel(modelId: string | null | undefined): boolean {
  return normalizeVideoModelId(modelId).includes("happyhorse10");
}

export function isGrokVideoChannelModel(modelId: string | null | undefined): boolean {
  return normalizeVideoModelId(modelId).includes("grokvideochannel");
}

// The whole Seedance 1 series (1.0 Pro Fast / 1.5 Pro / …): version `1.x` → `1x`, matching
// `seedance1` followed by any digit, avoiding a mis-hit on 2.0 (`seedance20`). These models are restricted when referencing assets.
export function isSeedance1xVideoModel(modelId: string | null | undefined): boolean {
  return /seedance1\d/.test(normalizeVideoModelId(modelId));
}

// The whole Seedance 2.0 series (2.0 / fast / value / fast-value): equivalent to the backend's
// `is_freezone_seedance2_backend` (model.startswith("seedance-2.0")).
export function isSeedance2VideoModel(modelId: string | null | undefined): boolean {
  return /seedance2/.test(normalizeVideoModelId(modelId));
}

/**
 * Seedance 2.5 (in the catalog `gateway_model = seedance-2.5`, apiModel `newapi_seedance-2.5`).
 *
 * After normalization it is `seedance25`, so it also matches `isSeedance2VideoModel` above (`/seedance2/`)
 * — that one is the coarse "2.x family" criterion (accepts multi-image / video / audio); the two do not conflict, so do not
 * change it to `seedance20` just to tell them apart: 2.5's multi-image and reference-material capabilities belong to the same family as 2.0,
 * and narrowing would push 2.5 back to 1.x treatment.
 *
 * This is used **only** for 2.5-exclusive entry points such as "clip reshoot". It matches by prefix rather than equality, so that
 * variants like `seedance-2.5-fast` in the future need no further change.
 */
export function isSeedance25VideoModel(modelId: string | null | undefined): boolean {
  return /seedance25/.test(normalizeVideoModelId(modelId));
}

/**
 * Which model "smart continuation" should land on: the first Seedance 2.5 in the catalog, or null if there is none.
 *
 * Returning null means this project's catalog has no 2.5 at all — the caller should gray out the entry point rather than
 * pick an arbitrary model as a stand-in: the continuation's reference-material spec is set for 2.5, and another model would only yield a
 * baffling generation.
 */
export function findSeedance25VideoModel<T extends { id: string; apiModel?: string }>(
  models: readonly T[],
): T | null {
  return models.find((model) => isSeedance25VideoModel(model.apiModel ?? model.id)) ?? null;
}

/**
 * Smart extend on a model that has no video-extend task of its own (MiniMax H3, catalog flag `supportsContinuation`).
 *
 * The backend rebuilds the continuation as "last frame of the trimmed source video = first frame, connected images = references"
 * (`freezone_video_omni_gen`, `continuation=true`), so the source video is NOT a model reference. Seedance 2.5 keeps its native
 * video-extend path and is deliberately excluded here.
 */
export function modelContinuesFromLastFrame(model: VideoModelRef): boolean {
  return (
    typeof model === "object" &&
    model !== null &&
    model.supportsContinuation === true &&
    !isSeedance25VideoModel(videoModelIdOf(model))
  );
}

/** Whether "Smart extend" may land on this model: Seedance 2.5, or a model that continues from the last frame. */
export function isContinuationCapableModel(model: VideoModelRef): boolean {
  return isSeedance25VideoModel(videoModelIdOf(model)) || modelContinuesFromLastFrame(model);
}

/**
 * Which model a new smart-extend node should land on. The source node's own model wins when it can be extended (a clip made by
 * H3 is continued by H3, so the face/look stays on the same model), then Seedance 2.5, then any other capable model; null when the
 * catalog has none and the caller should gray the entry point out.
 */
export function findContinuationVideoModel<
  T extends { id: string; apiModel?: string; supportsContinuation?: boolean },
>(models: readonly T[], preferredModelId?: string | null): T | null {
  const capable = models.filter((model) => isContinuationCapableModel(model));
  const preferred = preferredModelId
    ? capable.find((model) => model.id === preferredModelId || model.apiModel === preferredModelId)
    : undefined;
  return (
    preferred ??
    capable.find((model) => isSeedance25VideoModel(model.apiModel ?? model.id)) ??
    capable[0] ??
    null
  );
}

/**
 * `isVideoModeSupportedByModel` for a node that may be a smart-extend node. On such a node `allReference` is the stored mode even for a
 * model that continues from the last frame (H3), which has no `all_reference` of its own; without this the submit guard answers
 * "This model doesn't support omni reference" although the backend accepts the continuation.
 */
export function isVideoModeSupportedOnNode(
  mode: VideoGenMode,
  model: VideoModelRef,
  isExtendNode: boolean,
): boolean {
  if (isExtendNode && mode === "allReference" && modelContinuesFromLastFrame(model)) return true;
  return isVideoModeSupportedByModel(mode, model);
}

/**
 * How the capability gates (mode support, reference caps, rejection reasons) should judge a smart-extend node.
 *
 * A continues-from-last-frame model has no `all_reference` mode and a video reference cap of 0, so judging the node as it is stored
 * (`allReference`, one connected video) would reject every such model. Judged as plain `imageReference` with the source video taken
 * out of the counts, the same gates answer correctly without a second set of rules. Everything else is judged unchanged.
 */
export function extendGateView(
  model: VideoModelRef,
  mode: VideoGenMode,
  counts: { images: number; videos: number; audios: number },
  isExtendNode: boolean,
): { mode: VideoGenMode; counts: { images: number; videos: number; audios: number } } {
  if (isExtendNode && modelContinuesFromLastFrame(model)) {
    return { mode: "imageReference", counts: { ...counts, videos: Math.max(0, counts.videos - 1) } };
  }
  return { mode, counts };
}

/**
 * Whether the output ratio / duration is determined by the input video — this is how Seedance video editing works: the vendor hard-validates
 * that `ratio` must be `adaptive` and `duration` must be -1; specifying concrete values gets the whole order rejected
 * (`[InvalidParameter.TaskTypeConstraint] ... the output ratio and duration follow
 * the input video`). So these two items should not appear in the UI either — a knob that has no effect when changed and
 * makes people think they can set the output duration is worse than not offering it.
 *
 * The backend `VideoGenerator._follows_source_video_output` is the same check (seedance family +
 * video edit); change one side and the other must be kept in sync. HappyHorse's video edit is not included; it carries
 * ratio and duration as usual.
 */
export function videoOutputFollowsSourceVideo(
  mode: VideoGenMode | null | undefined,
  modelId: string | null | undefined,
): boolean {
  if (mode !== "videoEdit") return false;
  return /seedance/.test(normalizeVideoModelId(modelId));
}

// The base Seedance 2.0 (`…seedance-2.0` itself, excluding the fast / value / fast-value variants).
// After normalization, ending in `seedance20` means the base model — variants all carry an extra `fast` / `value` suffix behind it.
function isBaseSeedance2VideoModel(modelId: string | null | undefined): boolean {
  return /seedance20$/.test(normalizeVideoModelId(modelId));
}

/** The only mapping between frontend modes and media model catalog capabilities. */
export const GEN_MODE_TO_CATALOG_MODE: Record<VideoGenMode, string> = {
  textToVideo: "text_to_video",
  firstFrame: "first_frame",
  imageToVideo: "image_to_video",
  firstLastFrame: "first_last_frame",
  imageReference: "image_reference",
  allReference: "all_reference",
  videoEdit: "video_edit",
  videoExtend: "video_extend",
  // MiniMax H3 Multishot (2026-10-25) — the frontend genMode and the
  // backend catalog mode string are the same literal on purpose (see
  // api/routes/freezone.py's _freezone_dev_media_model_catalog_entries).
  multishot: "multishot",
};

/**
 * The output aspect of these modes is decided by the input keyframes/source video, so the user's saved fixed ratio must not be submitted.
 * Only the effective value of this request is computed and the ratio in the node is not overwritten, so the user's choice can be restored when switching back to other modes.
 */
export function videoModeForcesAutomaticAspectRatio(mode: VideoGenMode): boolean {
  return (
    mode === "firstFrame" ||
    mode === "firstLastFrame" ||
    mode === "videoEdit" ||
    mode === "videoExtend"
  );
}

export interface VideoKeyframeCandidate {
  url: string;
  slot?: VideoKeyframeSlot | null;
}

/**
 * Resolve stable first-frame/last-frame slots from the video node's upstream images.
 *
 * New canvases go by edge.data.keyframeSlot; the node name is for display only, and a user rename does not change the semantics.
 * Images without a slot field are simply assigned in connection order (first the first frame, then the last frame).
 */
export function resolveVideoKeyframeUrls(
  candidates: readonly VideoKeyframeCandidate[],
): { firstFrameUrl: string | null; lastFrameUrl: string | null } {
  let firstFrameUrl: string | null = null;
  let lastFrameUrl: string | null = null;
  const unassigned: string[] = [];

  for (const candidate of candidates) {
    if (candidate.slot === "first") {
      if (!firstFrameUrl) firstFrameUrl = candidate.url;
      continue;
    }
    if (candidate.slot === "last") {
      if (!lastFrameUrl) lastFrameUrl = candidate.url;
      continue;
    }

    // No slot given: join the unassigned queue below, which is filled in connection order.
    unassigned.push(candidate.url);
  }

  if (!firstFrameUrl) firstFrameUrl = unassigned.shift() ?? null;
  if (!lastFrameUrl) lastFrameUrl = unassigned.shift() ?? null;
  return { firstFrameUrl, lastFrameUrl };
}

/**
 * The unified shape of the model argument: either just an id string, or the model object delivered by the media catalog
 * (when `supportedModes` exists it prevails — that is a capability declaration explicitly configured by Admin).
 */
export type VideoModelRef =
  | string
  | {
      id?: string;
      apiModel?: string;
      supportedModes?: string[];
      referenceAudioMax?: number | null;
      referenceImageMax?: number | null;
      supportsGenerateAudio?: boolean;
      /** Multishot only — shot-list add/remove bound, see FreezoneVideoModelInfo in api/ops.ts. */
      maxShots?: number | null;
      /** Smart extend runs as last frame -> first frame (MiniMax H3), see FreezoneVideoModelInfo in api/ops.ts. */
      supportsContinuation?: boolean;
    }
  | null
  | undefined;

/** New fields left unconfigured keep the old behavior: native audio is supported and on by default. */
export function videoModelSupportsGenerateAudio(model: VideoModelRef): boolean {
  return typeof model === "string" || model?.supportsGenerateAudio !== false;
}

export function videoModelDefaultGenerateAudio(model: VideoModelRef): boolean {
  return videoModelSupportsGenerateAudio(model);
}

/** Take from the model argument the id used for the capability heuristics (prefer apiModel, which is the name sent upstream). */
function videoModelIdOf(model: VideoModelRef): string | null | undefined {
  return typeof model === "string" ? model : (model?.apiModel ?? model?.id);
}

/**
 * Whether the given model supports a genMode (consistent with the visible tabs / whether leftover modes are reset when switching models).
 * - HappyHorse: text-to-video / first frame (i2v) / image reference (r2v) / video edit.
 * - When the catalog returns no supportedModes the old heuristics apply; video extend has no old default and opens only after the admin
 *   explicitly configures it.
 */
export function isVideoModeSupportedByModel(
  mode: VideoGenMode,
  model: VideoModelRef,
): boolean {
  if (typeof model === "object" && model !== null && (model.supportedModes?.length ?? 0) > 0) {
    return model.supportedModes?.includes(GEN_MODE_TO_CATALOG_MODE[mode]) ?? false;
  }
  const modelId = videoModelIdOf(model);
  if (isHappyHorseVideoModel(modelId)) {
    return (
      mode === "textToVideo" ||
      mode === "firstFrame" ||
      mode === "imageToVideo" ||
      mode === "imageReference" ||
      mode === "videoEdit"
    );
  }
  if (isSeedance1xVideoModel(modelId)) {
    return mode === "textToVideo" || mode === "firstFrame";
  }
  if (mode === "videoEdit" || mode === "videoExtend") return false;
  // Multishot is a dedicated backend (runpod_minimax_h3_multishot) that
  // ONLY ever declares support via a real catalog entry (the `object`
  // branch above) — there is no legacy/heuristic model this should ever
  // apply to.
  if (mode === "multishot") return false;
  if (mode === "allReference" || mode === "firstLastFrame") {
    return isSeedance2VideoModel(modelId);
  }
  return true;
}

/** True when a model's catalog entry declares ONLY multishot support (e.g. runpod_minimax_h3_multishot) — it has no plain text-to-video of its own. */
export function isMultishotOnlyModel(model: VideoModelRef): boolean {
  return (
    typeof model === "object" &&
    model !== null &&
    (model.supportedModes?.length ?? 0) > 0 &&
    (model.supportedModes ?? []).every((mode) => mode === "multishot")
  );
}

/**
 * The mode a video node should land on right after the user picks `model` —
 * `"textToVideo"` when the model supports it (every non-multishot model
 * today), otherwise the first mode the model's own catalog entry declares
 * (in `MODE_TABS` order). Used by the model-switch handler in
 * `VideoOperationsPanel.tsx`/`VideoGenerationForm.tsx`, which previously
 * hardcoded a reset to `"textToVideo"` regardless of what the newly
 * selected model actually supports — harmless for every model before
 * multishot (all of them support text-to-video), but would silently land
 * a multishot-only model on an unsupported mode.
 */
export function videoModelDefaultMode(model: VideoModelRef): VideoGenMode {
  if (isVideoModeSupportedByModel("textToVideo", model)) return "textToVideo";
  const order: VideoGenMode[] = [
    "firstFrame",
    "firstLastFrame",
    "imageToVideo",
    "imageReference",
    "allReference",
    "videoEdit",
    "videoExtend",
    "multishot",
  ];
  return order.find((mode) => isVideoModeSupportedByModel(mode, model)) ?? "textToVideo";
}

/**
 * The empty-state CTA covers only the image / first-last-frame modes that "start by laying out assets" — text-to-video needs no assets and video edit goes through
 * a separate entry, so neither is in the empty-state CTA. One to one with the modes `spawnFrameUploads` accepts.
 */
export type VideoEmptyStateCtaMode =
  | "allReference"
  | "imageReference"
  | "firstFrame"
  | "imageToVideo"
  | "firstLastFrame"
  | "multishot";

/**
 * Mode order of the video node "empty state" CTA — lists only the image / first-last-frame modes the model can **truly start with**:
 * - HappyHorse: first frame → image reference;
 * - Seedance 2.0: all reference → image reference → first-last-frame;
 * - Seedance 1.x and other non-2.0 non-HappyHorse: all reference would 400, first-last-frame silently drops the last frame,
 *   multi-image reference is unsupported too, so only the genuinely usable "first frame" is offered.
 */
export function videoEmptyStateCtaModes(
  model: VideoModelRef,
): VideoEmptyStateCtaMode[] {
  if (typeof model === "object" && model !== null && (model.supportedModes?.length ?? 0) > 0) {
    const order: VideoEmptyStateCtaMode[] = [
      "allReference",
      "imageToVideo",
      "firstFrame",
      "imageReference",
      "firstLastFrame",
      // Last: a multishot-only model (supportedModes === ["multishot"])
      // falls through every mode above and would otherwise return [],
      // which makes videoSubmitMediaRejectionReason/
      // videoModelReferenceDisabledReason wrongly treat ANY attached
      // image as unsupported (see their own "imageUnsupported" checks).
      "multishot",
    ];
    return order.filter((mode) => isVideoModeSupportedByModel(mode, model));
  }
  const modelId = videoModelIdOf(model);
  if (isHappyHorseVideoModel(modelId)) {
    return ["imageToVideo", "firstFrame", "imageReference"];
  }
  if (isSeedance2VideoModel(modelId)) {
    return ["allReference", "imageToVideo", "firstFrame", "imageReference", "firstLastFrame"];
  }
  return ["firstFrame"];
}

/**
 * The default mode of non-HappyHorse models after "assets are first connected": Seedance 2.0 uses all reference
 * (omni, the general entry for 1-9 images + video + audio), while the rest (Seedance 1.x) do not support all reference
 * and fall back to the genuinely usable "first frame", avoiding default derivation pushing 1.x into a mode where submit is certain to 400.
 */
export function videoUpstreamImageDefaultMode(
  model: VideoModelRef,
): VideoGenMode | null {
  if (typeof model === "object" && model !== null && (model.supportedModes?.length ?? 0) > 0) {
    for (const mode of [
      "allReference",
      "imageToVideo",
      "firstFrame",
      "imageReference",
      // Last resort: a multishot-only model has none of the modes above,
      // but connecting its one required start-frame image should still
      // land it in the one mode it actually supports, not null (which
      // would leave the node stuck on an unsupported default).
      "multishot",
    ] as const) {
      if (isVideoModeSupportedByModel(mode, model)) return mode;
    }
    return null;
  }
  const modelId = videoModelIdOf(model);
  if (isHappyHorseVideoModel(modelId)) return "imageToVideo";
  return isSeedance2VideoModel(modelId) ? "allReference" : "firstFrame";
}

/**
 * Whether this genMode **must carry a prompt** to submit: text-to-video / all reference strongly validate the prompt on the backend;
 * first frame / image-to-video / image reference / first-last-frame / video edit allow an empty prompt (assets just need to be complete).
 */
export function videoModeRequiresPrompt(mode: VideoGenMode): boolean {
  return mode === "textToVideo" || mode === "allReference" || mode === "videoExtend";
}

/**
 * Whether this genMode **must have upstream assets** to submit: only text-to-video does not, while the submit
 * branches of every other mode return directly when assets are empty (see handleSubmit of VideoNode).
 *
 * It is **parallel** to `videoModeRequiresPrompt`, not either-or — all reference needs both:
 * the backend omni endpoint strongly validates the prompt, and with empty references there is nothing to send. It was once written as "a mode that needs a prompt
 * looks only at the prompt", so on the path "connect an image → remove the image again → only type", the button looked clickable,
 * yet clicking was silently blocked by handleSubmit's `references.length === 0`, showing up as "clicked and nothing happened".
 * Normally `videoNoUpstreamResetMode` first falls the mode back to text-to-video; this is the safety net: when the upstream node
 * is still connected but its image was cleared (typeCounts>0 while counts==0) the fall-back does not trigger, and submit must still be blocked.
 */
export function videoModeRequiresMedia(mode: VideoGenMode): boolean {
  return mode !== "textToVideo";
}

export interface VideoModeInputCounts {
  images: number;
  videos: number;
  audios: number;
  hasOtherReference?: boolean;
}

/** Required inputs, shared by mode availability and model switching. */
export function videoModeMissingInputReason(
  mode: VideoGenMode,
  counts: VideoModeInputCounts,
): string | null {
  if (mode === "videoEdit" || mode === "videoExtend") {
    return counts.videos === 0 ? "node.videoOps.modeDisabled.needOneVideo" : null;
  }
  // All-reference entry semantics are separate from input-required image/video modes.
  if (mode !== "textToVideo" && mode !== "allReference" && counts.images === 0) {
    return "node.videoOps.modeDisabled.needOneImage";
  }
  return null;
}

/** Preserve compatible explicit modes, including those waiting for their input. */
export function videoModeForModel(
  mode: VideoGenMode,
  model: VideoModelRef,
  counts: VideoModeInputCounts,
): VideoGenMode {
  if (!model) return mode;
  const supportsCurrentMode = isVideoModeSupportedByModel(mode, model);
  if (supportsCurrentMode && !videoSubmitMediaRejectionReason(mode, model, counts)) return mode;
  const candidates = (Object.keys(GEN_MODE_TO_CATALOG_MODE) as VideoGenMode[])
    .filter((candidate) => isVideoModeSupportedByModel(candidate, model));
  return candidates.find((candidate) =>
    !videoModeMissingInputReason(candidate, counts) &&
    !videoSubmitMediaRejectionReason(candidate, model, counts)
  ) ?? (supportsCurrentMode ? mode : candidates[0] ?? mode);
}

/**
 * Which mode to fall back to once all upstream assets are removed: `"textToVideo"` = back to text-to-video, null = leave alone.
 *
 * The video node's mode derivation was originally **one-directional**: when images/videos/audio connect, a pile of effects pushes the mode
 * to one that can consume that asset, but none pushes it back once the assets are emptied. So after "connect an image → delete
 * the image again" the node is stuck on all reference, the UI shows nothing wrong, and submit is inevitably silently blocked.
 * HappyHorse's unified state machine long had the "no upstream → text-to-video" tier; here the same rule is added for
 * the other models.
 *
 * The asset counts must be passed on the **by-node-type** basis (`upstreamTypeCounts`, where an empty image node counts too), not the
 * "resolved URL" basis: the empty-state CTAs (all reference / image reference / first-last-frame) first lay out an image/upload node with no image yet,
 * then switch the mode over; by the URL basis the asset count is 0 at that instant, and this rule would push it straight back
 * to text-to-video, voiding all three CTAs.
 */
export function videoNoUpstreamResetMode(
  mode: VideoGenMode,
  counts: VideoModeInputCounts,
  model?: VideoModelRef,
): VideoGenMode | null {
  if (counts.images > 0 || counts.videos > 0 || counts.audios > 0 || counts.hasOtherReference) return null;
  if (model && !isVideoModeSupportedByModel("textToVideo", model)) return null;
  // A multishot-only model cannot run text-to-video at all — falling back there on an emptied start
  // frame would strand the node on a mode its own model doesn't support.
  // Leave it on multishot; the submit guard already requires >=1 image.
  if (mode === "multishot") return null;
  return mode === "textToVideo" ? null : "textToVideo";
}

/**
 * Whether the model's i2v endpoint lets multiple images (>1) through. The backend returns a direct 400 for
 * `len(source_paths) > 1` only when "not 2.0 and not HappyHorse" (freezone.py), so models outside those two families (Seedance
 * 1.x etc.) can take only one image at a time — switching mode does not save them; the model must be switched.
 */
export function videoModelAcceptsMultipleImages(
  model: VideoModelRef,
): boolean {
  if (typeof model === "object" && model !== null && (model.supportedModes?.length ?? 0) > 0) {
    return (
      isVideoModeSupportedByModel("allReference", model) ||
      isVideoModeSupportedByModel("imageReference", model) ||
      // Multishot takes one start frame plus up to `referenceImageMax`
      // shared reference images — a second+ image is always legitimate.
      isVideoModeSupportedByModel("multishot", model)
    );
  }
  const modelId = videoModelIdOf(model);
  return isSeedance2VideoModel(modelId) || isHappyHorseVideoModel(modelId);
}

/**
 * Which mode to switch to when "first-frame-to-video" (imageToVideo / i2v) has multiple images connected; null = leave alone.
 *
 * Why it must switch: the backend i2v endpoint dispatches by **image count** (1 = image-to-video, 2-9 = image
 * reference video); connecting one more does not error but quietly turns into another way of generating — while the UI mode still says
 * "first-frame-to-video". The user connecting a second image is itself clear intent, so steer the mode straight to
 * what is really being done: prefer "all reference" (omni, which can keep connecting video / audio), and when the model does not support
 * omni fall back to "image reference".
 *
 * Three cases **leave it alone**:
 * - HappyHorse has its own complete state machine (videos>0→video edit / images>1→image reference /
 *   images===1→first frame), settled uniformly there, and meddling again here would only make the two places fight;
 * - The model cannot consume multiple images at all (Seedance 1.x: the i2v endpoint gives a direct 400 for >1 image), so any mode we switch to is a
 *   400. Stay on first frame and let the submit guard's "this model supports only 1 image at a time" say it clearly, rather than covering
 *   the real problem (the model should be switched) with a mode jump;
 * - Neither candidate mode is supported by the model — better not to move than push into a mode where submit is certain to 400.
 */
export function videoMultiImageAutoSwitchMode(
  mode: VideoGenMode,
  model: VideoModelRef,
  imageCount: number,
): VideoGenMode | null {
  if (mode !== "imageToVideo" || imageCount <= 1) return null;
  const modelId = videoModelIdOf(model);
  if (isHappyHorseVideoModel(modelId)) return null;
  if (!videoModelAcceptsMultipleImages(model)) return null;
  const candidates: VideoGenMode[] = ["allReference", "imageReference"];
  return candidates.find((candidate) => isVideoModeSupportedByModel(candidate, model)) ?? null;
}

/**
 * Duration bounds of Seedance 2.0 audio references. The vendor has **two mutually independent rules**, and both reject with 400:
 *
 * 1. Per item: `[InvalidParameter.DurationTooShort] Duration must be between 1.8s and 15.2s`
 * 2. Total: `the parameter audio total duration (seconds) specified in the request must
 *    be less than or equal to 15.2 for model doubao-seedance-2-0 in r2v`
 *
 * **This once checked only rule 1**, and the comments even said "the vendor basis is per item, with not a word about the total" and "do not
 * go back to judging by total duration". That was wrong: on 2026-08-06 in the 3060 environment two task failures
 * (freezone_video_gen/01KZ5R8ZZZY9M8T9F01H159RP7, gen_mode=allReference) captured the actual
 * rule 2 payload — 3 clips of 6s each, every one inside 1.8~15.2 so the per-item judgment inevitably lets them through, yet the total of 18s was
 * rejected outright by the vendor. So the total-duration rule is **not a rule we imagined**, and deleting it would put this failure back.
 *
 * The total duration cap first reads the media model catalog's `referenceAudioTotalMaxSeconds` (admin-configurable), and only when it is not configured uses
 * the 15.2s vendor fallback value below. The fallback is deliberately the same number as the per-item cap: 15.2s per item is explicitly
 * allowed by the vendor, and a smaller fallback (say 15s) would wrongly block a legitimate maximum-length audio locally. To keep a safety margin
 * configure `referenceAudioTotalMaxSeconds` smaller in the admin console rather than changing the constant here.
 *
 * The backend freezone omni-gen endpoint has the same fallback (`validate_omni_reference_audio_durations`,
 * src/novelvideo/freezone/video_node.py); that layer takes the landed file path + ffprobe, and is the last gate that can block before billing
 * when the local `<audio>` probe fails.
 *
 * Seconds in the copy are always derived from these constants (`/ 1000`); do not write the literal again at call sites, otherwise the hint
 * silently drifts when thresholds change.
 */
export const MIN_AUDIO_REFERENCE_DURATION_MS = 1_800;
export const MAX_AUDIO_REFERENCE_DURATION_MS = 15_200;
export const MAX_AUDIO_REFERENCE_TOTAL_DURATION_MS = 15_200;

const COMPOSITION_TIMELINE_AUDIO_ROLES = new Set([
  "voiceover",
  "narration",
  "shot_voice",
  "music",
  "bgm",
  "background_music",
]);
const COMPOSITION_TIMELINE_AUDIO_INTENT =
  /(?:voiceover|voice[_\s-]*over|narration|background[_\s-]*music|soundtrack|(?:^|[\s_-])bgm(?:$|[\s_-]))/i;

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

/**
 * Detect full-length narration/music tracks that belong on the compose
 * timeline. New workflows carry an explicit timelineRole; legacy workflows
 * are recovered from their catalog item identity without classifying manually
 * connected audio uploads as timeline tracks.
 */
export function isCompositionTimelineAudioData(data: unknown): boolean {
  const source = recordValue(data);
  if (!source) return false;
  const catalog = recordValue(source.workflowCatalog);
  const promptBuilder = recordValue(catalog?.promptBuilder);
  const planItem = recordValue(promptBuilder?.planItem);
  const explicitRole = [
    catalog?.timelineRole,
    catalog?.timeline_role,
    source.timelineRole,
    source.timeline_role,
    planItem?.timelineRole,
    planItem?.timeline_role,
  ]
    .map((value) => String(value ?? "").trim().toLowerCase())
    .find(Boolean);
  if (explicitRole) return COMPOSITION_TIMELINE_AUDIO_ROLES.has(explicitRole);
  if (!catalog) return false;
  const searchable = [
    source.displayName,
    source.title,
    catalog.stepId,
    catalog.operationType,
    catalog.recipeId,
    planItem?.id,
    planItem?.title,
    planItem?.audio_kind,
    planItem?.audioKind,
  ].filter(Boolean).join(" ");
  return COMPOSITION_TIMELINE_AUDIO_INTENT.test(searchable);
}

/** The audio-duration-related fields in the media catalog (a subset of `ModelOption`). */
export interface AudioDurationLimitModel {
  referenceAudioMinSeconds?: number | null;
  referenceAudioMaxSeconds?: number | null;
  referenceAudioTotalMinSeconds?: number | null;
  referenceAudioTotalMaxSeconds?: number | null;
  referenceVideoMinSeconds?: number | null;
  referenceVideoMaxSeconds?: number | null;
  referenceVideoTotalMinSeconds?: number | null;
  referenceVideoTotalMaxSeconds?: number | null;
}

export interface ReferenceDurationLimitsMs {
  minMs?: number;
  maxMs?: number;
  totalMinMs?: number;
  totalMaxMs?: number;
}

export function referenceDurationLimitsMs(
  model: AudioDurationLimitModel | null | undefined,
  media: "audio" | "video",
): ReferenceDurationLimitsMs {
  const prefix = media === "audio" ? "referenceAudio" : "referenceVideo";
  const read = (suffix: string): number | undefined => {
    const seconds = (model as Record<string, unknown> | null | undefined)?.[
      `${prefix}${suffix}`
    ];
    return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
      ? Math.round(seconds * 1000)
      : undefined;
  };
  return {
    minMs: read("MinSeconds"),
    maxMs: read("MaxSeconds"),
    totalMinMs: read("TotalMinSeconds"),
    totalMaxMs: read("TotalMaxSeconds"),
  };
}

/**
 * The **effective** total audio duration cap (milliseconds) of the selected model: the catalog config first, and 15.2s only when it is not configured.
 *
 * On the same basis as the backend `_catalog_audio_total_duration_max` (api/routes/freezone.py): only accepts a
 * finite positive number; null / 0 / negative / NaN / Infinity are all treated as not configured. Decimals are allowed — 15.2 itself is not
 * an integer, unlike those "non-negative integer" count fields, so do not casually apply `Number.isInteger`.
 *
 * `vendorCapMs` = this model's vendor hard cap (seedance2 passes 15.2s; models with unknown bounds pass nothing). When passed
 * it is **min-ed** with the catalog value: admins may configure it stricter, but configuring it looser should not make the vendor let it through too — configuring
 * 60s for seedance2 would let 3 clips of 6s all pass locally and still 400 at the vendor, exactly the failure this guard exists to eliminate.
 */
export function audioReferenceTotalDurationLimitMs(
  model: AudioDurationLimitModel | null | undefined,
  { vendorCapMs }: { vendorCapMs?: number } = {},
): number {
  const seconds = model?.referenceAudioTotalMaxSeconds;
  const configured =
    typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
      ? Math.round(seconds * 1000)
      : null;
  if (vendorCapMs == null) {
    return configured ?? MAX_AUDIO_REFERENCE_TOTAL_DURATION_MS;
  }
  return configured == null ? vendorCapMs : Math.min(configured, vendorCapMs);
}

/**
 * The three kinds must each take one union branch: if written as `kind: "tooShort" | "tooLong"` merging those two,
 * TS cannot rule the whole branch out of the union via `kind !== "tooLong"`, and the call site's ternary chain cannot reach
 * totalMs / limitMs unique to totalTooLong.
 */
export interface ReferenceDurationClip {
  label: string;
  durationMs: number | null;
  nodeId?: string;
  url?: string;
  index?: number;
}

type MeasuredReferenceDurationClip = ReferenceDurationClip & { durationMs: number };

export type AudioDurationRejection =
  | { kind: "tooShort"; clips: MeasuredReferenceDurationClip[] }
  | { kind: "tooLong"; clips: MeasuredReferenceDurationClip[] }
  | {
      kind: "totalTooShort";
      clips: MeasuredReferenceDurationClip[];
      totalMs: number;
      limitMs: number;
    }
  | {
      kind: "totalTooLong";
      clips: MeasuredReferenceDurationClip[];
      totalMs: number;
      limitMs: number;
    };

/**
 * Pre-submit audio duration guard.
 *
 * `durationMs` null = duration cannot be probed (the audio node never rendered a waveform, and the `<audio>` probe hit
 * CORS / network / timeout). Such entries **do not take part in the judgment** — better to let it pass and have the backend catch it than to
 * block a normal submission out of thin air. For the total it means the computed sum is a **lower bound**, yet the judgment direction stays safe:
 * a missed entry only makes the sum smaller, so "computed as over" is definitely really over and never wrongly blocks.
 *
 * The two kinds of bounds are **authorized separately**, corresponding one to one with the backend `validate_omni_reference_audio_durations`:
 *   - `perClipLimits`: per item 1.8~15.2s; these two numbers were measured from Seedance 2.0's payloads,
 *     and hold only for it. Other models pass `false` — blocking them with 2.0's numbers would block a normal 25s audio
 *     locally out of thin air.
 *   - `totalLimitMs`: the total duration, listening first to `referenceAudioTotalMaxSeconds` in the catalog
 *     (see `audioReferenceTotalDurationLimitMs`), and falling to the 15.2s fallback only when not configured.
 *
 * Reporting order: too short → single too long → total too long: the first two are "replace this item", the last is "trim the whole thing";
 * listing them mixed together leaves the user not knowing which to touch first.
 */
export function audioReferenceDurationRejection(
  clips: readonly ReferenceDurationClip[],
  options: {
    totalLimitMs?: number | null;
    totalMinMs?: number;
    minMs?: number | null;
    maxMs?: number | null;
    perClipLimits?: boolean;
  } = {},
): AudioDurationRejection | null {
  const {
    totalLimitMs = MAX_AUDIO_REFERENCE_TOTAL_DURATION_MS,
    totalMinMs,
    minMs = MIN_AUDIO_REFERENCE_DURATION_MS,
    maxMs = MAX_AUDIO_REFERENCE_DURATION_MS,
    perClipLimits = true,
  } = options;
  const measured = clips.filter(
    (clip): clip is MeasuredReferenceDurationClip =>
      typeof clip.durationMs === "number" && clip.durationMs > 0,
  );
  if (perClipLimits) {
    const tooShort = minMs == null
      ? []
      : measured.filter((clip) => clip.durationMs < minMs);
    if (tooShort.length > 0) {
      return { kind: "tooShort", clips: tooShort };
    }
    const tooLong = maxMs == null
      ? []
      : measured.filter((clip) => clip.durationMs > maxMs);
    if (tooLong.length > 0) {
      return { kind: "tooLong", clips: tooLong };
    }
  }
  const totalMs = measured.reduce((sum, clip) => sum + clip.durationMs, 0);
  if (totalMinMs != null && measured.length === clips.length && totalMs < totalMinMs) {
    return { kind: "totalTooShort", clips: measured, totalMs, limitMs: totalMinMs };
  }
  if (totalLimitMs != null && measured.length > 0 && totalMs > totalLimitMs) {
    return { kind: "totalTooLong", clips: measured, totalMs, limitMs: totalLimitMs };
  }
  return null;
}

/**
 * Seconds display of violating entries — **must not round into contradiction with the threshold**.
 *
 * Early on `toFixed(1)` was used, so 1.799s showed as "1.8s" and 15.201s as "15.2s": the user saw
 * exactly a legal boundary value yet was told it is out of bounds, and could only suspect we miscalculated. Durations are whole milliseconds
 * (`Math.round(secs * 1000)`), so show at millisecond precision and then strip meaningless trailing 0s:
 * 900 → `0.9`, 1799 → `1.799`, 15201 → `15.201`, 6000 → `6`.
 */
export function formatAudioDurationSeconds(durationMs: number): string {
  return (durationMs / 1000).toFixed(3).replace(/\.?0+$/, "");
}

/**
 * Join the violating entries into the `{{clips}}` in the hint (shared by tooShort / tooLong / totalTooLong).
 *
 * The brackets and separator are taken from the locale (en uses half-width brackets + commas), so do not
 * hard-code them at call sites — this once hard-coded full-width brackets and an ideographic comma, and en users would see a string of CJK punctuation.
 */
export function formatAudioDurationClips(
  clips: readonly { label: string; durationMs: number }[],
  translate: (key: string, vars?: Record<string, string | number>) => string,
): string {
  return clips
    .map((clip) =>
      translate("node.videoNode.audio.clipDuration", {
        label: clip.label,
        seconds: formatAudioDurationSeconds(clip.durationMs),
      }),
    )
    .join(translate("node.videoNode.audio.clipSeparator"));
}

/**
 * Pre-submit guard: whether the current (model, mode) would **drop or be directly rejected by the backend for** connected upstream assets.
 * A non-empty reason should disable submit and show the reason in the button tooltip, replacing "silently dropping assets / submit 400".
 *
 * Rules are aligned with the backend freezone i2v / omni-gen endpoints (src/novelvideo/api/routes/freezone.py):
 * - Video assets: consumed by "all reference", "video edit" and "video extend", silently dropped by other modes → block;
 * - Audio assets: consumed by "all reference"; "video edit" consumes them only when the media catalog explicitly configures an audio cap;
 *   silently dropped by other modes → block;
 * - Multiple images (>1): the i2v endpoint lets only Seedance 2.0 / HappyHorse through, and for non-2.0 non-HappyHorse
 *   (Seedance 1.x) passing >1 image gives a direct backend 400 → block.
 *
 * For models without the corresponding video mode configured, these rules prevent connected video/audio from being silently dropped.
 */
/** Returns an i18n key (when non-null the caller turns it into copy with `t()`), not a sentence that can be shown directly. */
export function videoSubmitMediaRejectionReason(
  mode: VideoGenMode,
  model: VideoModelRef,
  counts: { images: number; videos: number; audios: number },
): string | null {
  if (
    mode === "videoExtend" &&
    !isVideoModeSupportedByModel("videoExtend", model)
  ) {
    return "node.videoOps.modeDisabled.modelNoVideoExtend";
  }
  if (
    mode === "videoExtend" &&
    (counts.videos !== 1 || counts.images > 0 || counts.audios > 0)
  ) {
    return "node.videoModel.reason.videoExtendSourceOnly";
  }
  if (!isVideoModeSupportedByModel(mode, model)) {
    return "node.videoModel.reason.modeUnsupported";
  }
  if (counts.images > 0 && videoEmptyStateCtaModes(model).length === 0) {
    return "node.videoModel.reason.imageUnsupported";
  }
  if (counts.videos > 0 && mode !== "allReference" && mode !== "videoEdit" && mode !== "videoExtend") {
    return "node.videoModel.reason.videoUnsupported";
  }
  const videoEditAcceptsAudio =
    mode === "videoEdit" &&
    typeof model === "object" &&
    model !== null &&
    isVideoModeSupportedByModel("videoEdit", model) &&
    typeof model.referenceAudioMax === "number" &&
    model.referenceAudioMax > 0;
  if (counts.audios > 0 && mode !== "allReference" && !videoEditAcceptsAudio) {
    return "node.videoModel.reason.audioUnsupported";
  }
  if (counts.images > 1 && !videoModelAcceptsMultipleImages(model)) {
    return "node.videoModel.reason.singleImageOnly";
  }
  if (
    mode === "multishot" &&
    counts.images >
      1 +
        (typeof model === "object" && model !== null && typeof model.referenceImageMax === "number"
          ? model.referenceImageMax
          : 3)
  ) {
    // Multishot's "accepts multiple images" (videoModelAcceptsMultipleImages
    // above) is unconditionally true for this mode — the real cap is 1
    // start frame + up to referenceImageMax shared references, which the
    // generic singleImageOnly check (>1 images, model can't do multi) can
    // never catch here.
    return "node.videoModel.reason.multishotTooManyImages";
  }
  return null;
}

/**
 * Why a candidate in the model selector **cannot be chosen** (when non-null it is grayed out and this reason shows on hover).
 *
 * A pair with `videoSubmitMediaRejectionReason` above: that one governs "can it be submitted after the model is chosen",
 * this one governs "with this pile of upstream assets, can we still switch to this model". The invariant to maintain is
 * **"not grayed out ⇒ there exists a mode the model supports and the submit guard lets through"** — not per-threshold equality.
 * Per-item equality does not hold here: HappyHorse's multi-image / video are digested by its own r2v / video edit
 * paths, and the two guards are written with different judgments to begin with; what must not break is "what can be selected must be workable",
 * otherwise users would be put into a dead end where submit is certain to be blocked yet the UI gives no warning.
 *
 * Origin of the three thresholds:
 * - Seedance 1.x is **>1 image**, not >0: the backend i2v endpoint gives 400 only when `len(source_paths) > 1`
 *   and not 2.0 and not HappyHorse (freezone.py); a single-image first frame is exactly the only thing 1.x can use, and also the mode
 *   `videoEmptyStateCtaModes` explicitly recommends for it. Writing >0 would lock out the fully legitimate everyday combination "one image + Seedance
 *   1.5 Pro" entirely.
 * - HappyHorse blocks only audio: audio can be consumed only by all reference (omni, 2.0), and in
 *   `isVideoModeSupportedByModel` HappyHorse can never reach allReference — without blocking,
 *   "HappyHorse + audio node" is exactly the dead end described above (selectable yet submit certain to be blocked).
 *   Its multi-image (r2v) and video (video edit) can both be digested, so no blocking.
 * - Grok Video Channel supports only images. Note: it is currently turned off on the backend
 *   (`FREEZONE_DISABLED_VIDEO_BACKENDS`) and does not appear in the selector, so this branch is dormant.
 */
/** Same as above: returns an i18n key, and the caller is responsible for `t()`. */
export function videoModelReferenceDisabledReason(
  model: VideoModelRef,
  counts: { images: number; videos: number; audios: number },
): string | null {
  if (typeof model === "object" && model !== null && (model.supportedModes?.length ?? 0) > 0) {
    if (
      counts.videos === 0 &&
      model.supportedModes?.every((mode) => mode === "video_edit" || mode === "video_extend")
    ) {
      return "node.videoOps.modeDisabled.needOneVideo";
    }
    if (counts.images > 0 && videoEmptyStateCtaModes(model).length === 0) {
      return "node.videoModel.reason.imageUnsupported";
    }
    const supportsAllReference = isVideoModeSupportedByModel("allReference", model);
    const supportsVideoEdit = isVideoModeSupportedByModel("videoEdit", model);
    const supportsVideoExtend = isVideoModeSupportedByModel("videoExtend", model);
    if (
      counts.videos > 0 &&
      !supportsAllReference &&
      !supportsVideoEdit &&
      !supportsVideoExtend
    ) {
      return "node.videoModel.reason.videoUnsupported";
    }
    const supportsVideoEditAudio =
      supportsVideoEdit &&
      typeof model.referenceAudioMax === "number" &&
      model.referenceAudioMax > 0;
    if (counts.audios > 0 && !supportsAllReference && !supportsVideoEditAudio) {
      return "node.videoModel.reason.audioUnsupported";
    }
    if (counts.images > 1 && !videoModelAcceptsMultipleImages(model)) {
      return "node.videoModel.reason.singleImageOnly";
    }
    if (
      isVideoModeSupportedByModel("multishot", model) &&
      counts.images > 1 + (typeof model.referenceImageMax === "number" ? model.referenceImageMax : 3)
    ) {
      return "node.videoModel.reason.multishotTooManyImages";
    }
    return null;
  }
  const modelId = videoModelIdOf(model);
  if (isGrokVideoChannelModel(modelId)) {
    if (counts.videos > 0 || counts.audios > 0) {
      return "node.videoModel.reason.grokImagesOnly";
    }
    if (counts.images > 8) {
      return "node.videoModel.reason.grokImageLimit";
    }
    return null;
  }
  if (isHappyHorseVideoModel(modelId)) {
    if (counts.audios > 0) {
      return "node.videoModel.reason.audioUnsupported";
    }
    return null;
  }
  if (isSeedance1xVideoModel(modelId)) {
    if (counts.videos > 0 || counts.audios > 0) {
      return "node.videoModel.reason.imagesOnly";
    }
    if (counts.images > 1) {
      return "node.videoModel.reason.singleImageOnly";
    }
  }
  return null;
}

export interface VideoReferenceAutoSwitch {
  /** The target model's `id` (the value stored into `VideoNodeData.model`, not apiModel). */
  modelId: string;
  genMode: VideoGenMode;
}

/**
 * **Auto-rescue** when video / audio is connected upstream: Seedance 1.x cannot consume these two kinds of assets at all
 * (the i2v endpoint takes only images, and the omni endpoint gives a direct 400 for non-2.0), and leaving the user on 1.x would only yield one
 * certainly failing submission. The user connecting a video/audio node is itself clear intent, so swap them straight
 * to a Seedance 2.0 that can eat these assets, landing on the only mode that can consume them, "all reference".
 *
 * It handles only Seedance 1.x:
 * - HappyHorse has its own "video edit" path that can take video, and must not be taken away;
 * - Grok Video Channel is an independent channel the user explicitly selected and supports only images; we do not change their channel here,
 *   and the selector graying + submit guard keep covering it;
 * - 2.0 supports it natively and needs no change.
 *
 * Pass asset counts on the **by-node-type** basis (an empty video node counts too), and keep them from the same source as what is fed to
 * `videoModelReferenceDisabledReason` — otherwise "the effect switches the model away while the selector allows switching back"
 * fighting back and forth would appear.
 *
 * The target locks onto the **base Seedance 2.0**, not the `Seedance2.0 Fast` listed first: fast is a
 * speed-up, downgraded variant, and quietly putting the user on a downgraded model while rescuing them is inappropriate; the base model is also the backend
 * default value of `FreezoneVideoGenRequest.model`. When the base model is not in the candidate list (the endpoint delivered only variants)
 * fall back to any 2.0 — better than leaving them stuck on a certainly failing 1.x; with no 2.0 at all return null,
 * better not to move than to switch blindly.
 */
function pickVideoReferenceAutoSwitch(
  currentModelId: string | null | undefined,
  counts: { videos: number; audios: number },
  models: readonly { id: string; apiModel?: string }[],
): VideoReferenceAutoSwitch | null {
  if (counts.videos === 0 && counts.audios === 0) {
    return null;
  }
  if (!isSeedance1xVideoModel(currentModelId)) {
    return null;
  }
  const target =
    models.find((model) => isBaseSeedance2VideoModel(model.apiModel ?? model.id)) ??
    models.find((model) => isSeedance2VideoModel(model.apiModel ?? model.id));
  return target ? { modelId: target.id, genMode: "allReference" } : null;
}

export type VideoReferenceAutoSwitchAction =
  /** Do nothing (still loading / already rescued once / no need to switch to begin with). */
  | { kind: "none" }
  /** Video and audio are both removed — release the one-shot latch to prepare for the next connection. */
  | { kind: "release" }
  /** Write this one patch (model + mode in one go), and set the latch. */
  | { kind: "switch"; modelId: string; genMode: VideoGenMode };

/**
 * The **complete gate** of auto-rescue — this is the one the component effect should call, and apart from changing the ref and sending the patch
 * it should judge no condition itself. The gate is made a pure function so the whole segment can be tested: the async loading timing (first item below)
 * is not covered by testing only "who to switch to", and it is exactly where things most easily go wrong.
 *
 * Three gates, in a deliberate order:
 * 1. **Asset removal takes priority over everything** (including loading) — releasing the latch just resets a ref with no side effects,
 *    and there is no need to wait for the list; waiting would instead miss the wrap-up of "the user pulled the wire again while loading".
 * 2. **Never move during `modelsLoading`**. When pending, `useFreezoneVideoModels` returns
 *    not an empty array but the hard-coded `VIDEO_MODELS` — a 2.0 picked from it may not exist in the project's
 *    real list. Switching early and also setting the latch means the node is not corrected again when the real list returns, and the node gets stuck on a
 *    model the backend does not recognize, with submit giving a direct 400. **Note: look only at `isLoading`, do not block on `isFallback` as well**:
 *    isFallback stays true in the three **settled** cases "the URL has no project", "the fetch failed", "the backend returned an empty list",
 *    and then what the selector renders is the same `VIDEO_MODELS` (
 *    `ProviderModelPicker` uses this hook's models), the 2.0 is in it and the user can also
 *    select it manually; blocking on it too would permanently turn off the rescue in those cases.
 * 3. **After `alreadySwitched` sets the latch, no more correction**, avoiding blocking undo (see the comment in the component).
 *
 * "Not switched" does not set the latch: when there is not a single 2.0 in the list it returns `none`, keeping this transition,
 * so there is still a chance to remedy it once the list changes.
 */
export function videoReferenceAutoSwitchAction(input: {
  counts: { videos: number; audios: number };
  currentModelId: string | null | undefined;
  models: readonly { id: string; apiModel?: string }[];
  modelsLoading: boolean;
  alreadySwitched: boolean;
}): VideoReferenceAutoSwitchAction {
  const { counts, currentModelId, models, modelsLoading, alreadySwitched } = input;
  if (counts.videos === 0 && counts.audios === 0) {
    return { kind: "release" };
  }
  if (modelsLoading || alreadySwitched) {
    return { kind: "none" };
  }
  const target = pickVideoReferenceAutoSwitch(currentModelId, counts, models);
  return target
    ? { kind: "switch", modelId: target.modelId, genMode: target.genMode }
    : { kind: "none" };
}
