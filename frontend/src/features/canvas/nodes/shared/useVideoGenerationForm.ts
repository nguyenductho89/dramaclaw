// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { selectVideoModel } from "@/features/canvas/domain/catalogVideoModels";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFn } from "@/lib/i18n-types";
import { toast } from "sonner";

import {
  isAudioNode,
  isExportImageNode,
  isImageEditNode,
  isImageGenNode,
  isStoryboardGenNode,
  isUploadNode,
  isVideoNode,
  type CanvasNode,
  type Seedance2SceneOptimize,
  type VideoGenCount,
  type VideoGenMode,
  type VideoGenQuality,
  type VideoNodeData,
} from "@/features/canvas/domain/canvasNodes";
import {
  VIDEO_GENERATION_ASPECT_RATIOS,
  resolveImageDisplayUrl,
  snapToAllowedAspectRatio,
} from "@/features/canvas/application/imageData";
import {
  extractUpstreamContent,
  joinUpstreamText,
} from "@/features/canvas/application/graphContentResolver";
import { compileWorkflowNodePrompt } from "@/features/canvas/application/workflowRecipeRuntime";
import { useUpstreamNodes } from "@/features/canvas/application/useUpstreamGraph";
import {
  sortUpstreamByReferenceOrder,
  upstreamNodesInEdgeOrder,
} from "@/features/canvas/nodes/referenceOrdering";
import {
  referenceImageUrl,
  referenceVideoUrl,
} from "@/features/canvas/nodes/referenceMedia";
import {
  ASPECT_RATIOS,
  clampVideoDuration,
  formatReferenceMediaCompilerLabel,
  hasConfiguredReferenceCaps,
  referenceCapsForMode,
  type ReferenceMediaItem,
} from "@/features/canvas/nodes/shared/videoFormOptions";
import {
  audioReferenceDurationRejection,
  formatAudioDurationClips,
  formatAudioDurationSeconds,
  isCompositionTimelineAudioData,
  isHappyHorseVideoModel,
  isSeedance2VideoModel,
  isVideoModeSupportedByModel,
  MAX_AUDIO_REFERENCE_DURATION_MS,
  MAX_AUDIO_REFERENCE_TOTAL_DURATION_MS,
  MIN_AUDIO_REFERENCE_DURATION_MS,
  referenceDurationLimitsMs,
  resolveVideoKeyframeUrls,
  videoModeRequiresPrompt,
  videoModelReferenceDisabledReason,
  videoReferenceAutoSwitchAction,
  videoSubmitMediaRejectionReason,
  videoUpstreamImageDefaultMode,
} from "@/features/canvas/nodes/shared/videoModelCapabilities";
import { normalizeCanvasEdgeSemanticKind } from "@/features/freezone/canvasEdgeSemantics";
import type { VideoGenerationFormProps } from "@/features/canvas/nodes/shared/VideoGenerationForm";
import { setAlbumPendingTotal } from "@/features/canvas/nodes/shared/albumPendingTotals";
import { useReferenceMentionSync } from "@/features/canvas/nodes/useReferenceMentionSync";
import { useNodeGenerationTaskState } from "@/features/canvas/application/useNodeGenerationTaskState";
import {
  resolveErrorContent,
  showErrorDialog,
} from "@/features/canvas/application/errorDialog";
import {
  backendErrorToastMessage,
  BillingRuleNotConfiguredError,
} from "@/lib/api-errors";
import { resolveGenerationErrorDiagnostics } from "@/features/canvas/application/generationErrorReport";
import type { MentionCandidate } from "@/features/canvas/nodes/PromptMentionEditor";
import {
  CAMERA_MOVEMENT_PRESETS,
  findCameraMovementPreset,
  type CameraMovementPreset,
} from "@/features/canvas/domain/cameraMovementPresets";
import { useFreezoneVideoCameraTemplates } from "@/features/canvas/hooks/useFreezoneVideoCameraTemplates";
import { useFreezoneVideoModels } from "@/features/canvas/hooks/useFreezoneVideoModels";
import { useCanvasStore } from "@/stores/canvasStore";
import {
  fetchFreezoneJobResult,
  submitFreezoneVideoEdit,
  submitFreezoneVideoExtend,
  submitFreezoneVideoGen,
  submitFreezoneVideoI2v,
  submitFreezoneVideoKeyframes,
  submitFreezoneVideoOmniGen,
  type FreezoneJobRef,
  type FreezoneVideoAspectRatio,
  type FreezoneVideoReferenceItem,
  type FreezoneVideoResolution,
} from "@/api/ops";
import { awaitTaskCompletion } from "@/api/tasks";
import {
  CLEARED_GENERATION_TASK_FIELDS,
  generationTaskDescriptor,
} from "@/features/canvas/application/resumeGeneration";
import { translateNodeText } from "@/features/canvas/application/translateText";
import { readUrl } from "@/lib/url-params";
import type { ModelOption } from "@/features/canvas/ui/ProviderModelPicker";
import { writeLastVideoModel } from "@/features/canvas/domain/lastVideoModel";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { useDebouncedValue } from "@/hooks/use-debounced-value";

// The media catalog can declare arbitrary resolution tiers for a model, and this is only a fallback when nothing is configured; case follows the backend
// basis, unified to lowercase (`qualityToResolution` thus degenerates into the identity function).
const QUALITIES: ReadonlyArray<VideoGenQuality> = ["480p", "720p", "1080p"];
const SCENE_OPTIMIZE_OPTIONS: ReadonlyArray<Seedance2SceneOptimize> = ["anime", "realistic"];
const DEFAULT_DURATION_MIN = 5;
const DEFAULT_DURATION_MAX = 15;
// Unified billing (#210): video generation is quoted by feature key, with the model identity put into params.
const VIDEO_GENERATE_FEATURE_KEY = "freezone.video_generate";

// Empty-data fallback for when the node is deleted / not yet in the store, keeping the hook free of early returns
// (the number of hooks must be the same every frame).
const EMPTY_NODE_DATA = {} as VideoNodeData;

// The tier string is the resolution the backend wants: whatever the media catalog configures is sent as is, and the frontend no longer keeps
// a whitelist mapping like "480P → 480p", otherwise tiers newly configured by Admin would be silently dropped.
function qualityToResolution(q: VideoGenQuality): FreezoneVideoResolution {
  return q;
}

function videoQualityOptionsForModel(
  model: { resolutionOptions?: string[] } | null | undefined,
): readonly VideoGenQuality[] {
  const options = (model?.resolutionOptions ?? []).map((item) => item.trim()).filter(Boolean);
  return options.length > 0 ? options : QUALITIES;
}

// The old value stored on the node may be "720P" while the catalog now says "720p": match case-insensitively,
// and do not reset the tier the user picked as an invalid value.
function normalizeVideoQuality(
  value: VideoGenQuality | undefined,
  options: readonly VideoGenQuality[],
): VideoGenQuality {
  const configured = value
    ? options.find((option) => option.toLowerCase() === value.toLowerCase())
    : undefined;
  const fallback =
    options.find((option) => option.toLowerCase() === "720p") ?? options[0] ?? "720p";
  return configured ?? fallback;
}

// The asset guard stacks two layers: first the model capability (Seedance 1.x takes only 1 image and the like, hard-coded in the capability module),
// then the per-mode caps declared by the media catalog.
function selectedVideoModelReferenceDisabledReason(
  model: ModelOption | null | undefined,
  counts: { images: number; videos: number; audios: number },
  mode: VideoGenMode,
  t: TFn,
): string | null {
  const capabilityReason = videoModelReferenceDisabledReason(model, counts);
  if (capabilityReason) return capabilityReason;
  const caps = referenceCapsForMode(model, mode);
  if (!caps) return null;
  if (counts.images > caps.image) {
    return t("node.videoModel.reason.maxImages", { count: caps.image });
  }
  if (counts.videos > caps.video) {
    return caps.video === 0
      ? t("node.videoModel.reason.videoUnsupported")
      : t("node.videoModel.reason.maxVideos", { count: caps.video });
  }
  if (counts.audios > caps.audio) {
    return caps.audio === 0
      ? t("node.videoModel.reason.audioUnsupported")
      : t("node.videoModel.reason.maxAudios", { count: caps.audio });
  }
  return null;
}

function videoDurationBoundsForModel(
  model: { minDuration?: number | null; maxDuration?: number | null } | null | undefined,
): { min: number; max: number } {
  const min = Number(model?.minDuration);
  const max = Number(model?.maxDuration);
  const resolvedMin = Number.isFinite(min) && min > 0 ? min : DEFAULT_DURATION_MIN;
  const resolvedMax = Number.isFinite(max) && max >= resolvedMin ? max : DEFAULT_DURATION_MAX;
  return { min: resolvedMin, max: resolvedMax };
}

// A media node's durationMs may not be loaded yet. Before submit, probe the real duration with a temporary media element as a fallback;
// if probing fails (CORS/network etc.) it returns null and does not block submission, leaving the backend to handle it.
function probeMediaDurationMs(
  url: string,
  media: "audio" | "video",
): Promise<number | null> {
  return new Promise((resolve) => {
    if (!url) {
      resolve(null);
      return;
    }
    const element = document.createElement(media);
    let settled = false;
    const finish = (ms: number | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      element.onloadedmetadata = null;
      element.onerror = null;
      element.removeAttribute("src");
      element.load();
      resolve(ms);
    };
    const timer = window.setTimeout(() => finish(null), 8000);
    element.preload = "metadata";
    element.onloadedmetadata = () => {
      const secs = element.duration;
      finish(Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : null);
    };
    element.onerror = () => finish(null);
    element.src = url;
  });
}

function probeAudioDurationMs(url: string): Promise<number | null> {
  return probeMediaDurationMs(url, "audio");
}

function probeVideoDurationMs(url: string): Promise<number | null> {
  return probeMediaDurationMs(url, "video");
}

function isCompositionTimelineAudioNode(node: CanvasNode): boolean {
  return isAudioNode(node) && isCompositionTimelineAudioData(node.data);
}

function isSeedance2ValueModel(modelId: string | null | undefined): boolean {
  const normalized = String(modelId ?? "").trim().toLowerCase();
  return normalized === "newapi_seedance-2.0-value" ||
    normalized === "newapi_seedance-2.0-fast-value" ||
    normalized === "huimeng_seedance-2.0-value" ||
    normalized === "huimeng_seedance-2.0-fast-value";
}

function sceneOptimizeOptionsForModel(
  model: {
    id?: string;
    apiModel?: string;
    sceneOptimizeOptions?: Array<"anime" | "realistic">;
  } | null | undefined,
): readonly Seedance2SceneOptimize[] {
  if (model?.sceneOptimizeOptions?.length) {
    return model.sceneOptimizeOptions;
  }
  return isSeedance2ValueModel(model?.apiModel ?? model?.id) ? SCENE_OPTIMIZE_OPTIONS : [];
}

function defaultSceneOptimizeForModel(
  model: {
    id?: string;
    apiModel?: string;
    defaultSceneOptimize?: "anime" | "realistic" | null;
  } | null | undefined,
): Seedance2SceneOptimize {
  if (model?.defaultSceneOptimize === "anime" || model?.defaultSceneOptimize === "realistic") {
    return model.defaultSceneOptimize;
  }
  const modelId = String(model?.apiModel ?? model?.id ?? "").toLowerCase();
  return modelId.includes("fast-value") ? "realistic" : "anime";
}

function normalizeSceneOptimize(
  value: Seedance2SceneOptimize | undefined,
  options: readonly Seedance2SceneOptimize[],
  fallback: Seedance2SceneOptimize,
): Seedance2SceneOptimize | undefined {
  if (options.length === 0) return undefined;
  return value && options.includes(value) ? value : fallback;
}

// Display file name of an audio reference chip: prefer the node's displayName, otherwise take the last file-name segment from audioUrl.
// For frontend display only (audio_<file name>); does not affect the @audio1 serialized to the backend.
function audioReferenceFileName(item: {
  displayName?: string | null;
  audioUrl: string;
}): string | null {
  const name = item.displayName?.trim();
  if (name) return name;
  try {
    const origin =
      typeof window !== "undefined" ? window.location.origin : "http://localhost";
    const path = new URL(item.audioUrl, origin).pathname;
    const base = decodeURIComponent(path.split("/").filter(Boolean).pop() ?? "");
    return base || null;
  } catch {
    return null;
  }
}

function submittableImageUrl(
  node: CanvasNode | undefined | null,
): string | null {
  if (!node) return null;
  if (isImageGenNode(node)) {
    const data = node.data;
    const ref =
      typeof data.referenceImageUrl === "string" &&
      data.referenceImageUrl.length > 0
        ? data.referenceImageUrl
        : null;
    return data.imageUrl || ref;
  }
  if (
    isUploadNode(node) ||
    isImageEditNode(node) ||
    isExportImageNode(node) ||
    isStoryboardGenNode(node)
  ) {
    return node.data.imageUrl || null;
  }
  return null;
}

function resolveOutputUrl(
  result: Record<string, unknown> | null | undefined,
): string | null {
  if (!result) return null;
  for (const key of ["video_url", "output_url", "url"]) {
    const value = result[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * The part of the props of `VideoGenerationForm` that this hook is responsible for supplying.
 *
 * The remaining two are **the host's own orchestration / layout**, unrelated to the generation form's data and submit, so they do not enter the hook:
 * - `onOpenCharacterLibrary`: opens the asset library dialog held by the host;
 * - `compact`: the host decides whether to leave room for the "enlarge" button on the right of the chips row.
 */
export type VideoGenerationFormBoundProps = Omit<
  VideoGenerationFormProps,
  "onOpenCharacterLibrary" | "compact"
>;

export interface UseVideoGenerationFormOptions {
  /**
   * Fired after a batch of generations (including N concurrent calls) has all settled. The node uses it to refresh the "generation history"
   * strip; hosts that do not care about history may omit it.
   */
  onGenerationSettled?: () => void;
  /**
   * Whether to fire the compute cost estimate quote. Default true — hosts like the storyboard where "the form is resident, one per screen"
   * use the default directly.
   *
   * Workflow nodes must pass `selected`: the hook is mounted at the top level of VideoNode, and every video node on the canvas with a configured model
   * would each send one /generation-credit-cost (the query key contains their own params,
   * so react-query cannot dedupe). Same basis as `useNodeGenerationHistory` above in the same file,
   * `enabled: Boolean(selected)`.
   *
   * The failure state is kept always on inside the hook and is not bound by this switch: the retry button on the failure banner is the only entry that can still submit
   * while the node is unselected, its disabled is wired to submitDisabled, and it must get the gate
   * for missing billing rules.
   */
  costProbeEnabled?: boolean;
}

export interface UseVideoGenerationFormResult {
  /** Spread directly into `<VideoGenerationForm {...formProps} />`. */
  formProps: VideoGenerationFormBoundProps;
  /**
   * The values below also exist in formProps (or derive from it), but the host needs them itself:
   * - isGenerating / submitDisabled / submit: the retry button of the "generation failed" banner on the node,
   *   and the "non-destructive preview" branch of clicking history while generating;
   * - prompt: the **persisted** `data.prompt` (not the editor draft) — the "first-frame-to-video" CTA
   *   relies on it to judge whether the user has already written a prompt and whether to overwrite it;
   * - quality: the node's edit-compose picks the compose resolution by it;
   * - upstreamCounts: the node empty-state CTA uses `videos === 0` to decide whether to show the first-frame/first-last-frame guidance.
   */
  isGenerating: boolean;
  submitDisabled: boolean;
  /** Submit generation; returns the url of the first video to finish in this batch (an empty object when all fail / nothing produced). */
  submit: () => Promise<{ videoUrl?: string }>;
  prompt: string;
  quality: VideoGenQuality;
  selectedVideoModelId: string;
  upstreamCounts: { images: number; videos: number; audios: number };
}

/**
 * The **parent state and orchestration** of the video generation form: prompt draft + IME composition state, collection and numbering of upstream text / image /
 * video / audio (@image1 / @video1 / @audio1), the genMode state machine (including the several fallbacks that auto-switch with upstream
 * and model), model and param normalization, translation, compute cost estimate, and the handleSubmit that calls concurrently by "generation
 * count" (dispatching by genMode to the five endpoints keyframes / i2v / edit /
 * omni-gen / gen).
 *
 * Like `VideoGenerationForm` it touches no React Flow context — node data is always taken from
 * `useCanvasStore` by id (the nodes the canvas feeds to ReactFlow are the same ones in the store,
 * so they are the same object as the `data` prop the node component receives). This way standalone layouts such as the storyboard detail
 * can also get the whole set of capabilities directly via `useVideoGenerationForm(nodeId)`.
 *
 * The submit orchestration is deliberately kept inside the hook (the same trade-off as the image-side `useImageGenerationForm`): it
 * interweaves per-run patches, the module-level album counts (albumPendingTotals), the aggregated error dialog and the
 * "partial failure" toast; lifting it out to application/ would need a dozen parameters and instead endanger "zero behavior change".
 */
export function useVideoGenerationForm(
  nodeId: string,
  options?: UseVideoGenerationFormOptions,
): UseVideoGenerationFormResult {
  const { t } = useTranslation();
  const onGenerationSettled = options?.onGenerationSettled;
  const costProbeEnabled = options?.costProbeEnabled ?? true;
  const id = nodeId;

  const data = (useCanvasStore(
    (state) => state.nodes.find((node) => node.id === nodeId)?.data,
  ) ?? EMPTY_NODE_DATA) as VideoNodeData;
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);

  // In-flight guard: held until all concurrent tasks of this batch allSettle (see handleSubmit).
  const submittingRef = useRef(false);
  const [isTranslatingPrompt, setIsTranslatingPrompt] = useState(false);

  const prompt = typeof data.prompt === "string" ? data.prompt : "";
  // Local draft + composition guard so IME (input method) candidates stop being
  // wiped by the store-driven re-render. Same fix pattern as
  // `docs/changes/2026-05-12-image-gen-ime-fix.md`.
  const [promptDraft, setPromptDraft] = useState(prompt);
  const isComposingRef = useRef(false);
  useEffect(() => {
    if (isComposingRef.current) return;
    setPromptDraft(prompt);
  }, [prompt]);

  // The prompt draft / IME composition state stay in this hook (not moved down into the form component): the "generation failed" retry
  // banner and auto-submit both read the same prompt to judge whether it can be submitted, and moving the draft down would make the two places mismatch.
  const handlePromptChange = useCallback(
    (next: string) => {
      setPromptDraft(next);
      if (!isComposingRef.current) {
        updateNodeData(id, { prompt: next });
      }
    },
    [id, updateNodeData],
  );
  const handlePromptCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);
  const handlePromptCompositionEnd = useCallback(
    (next: string) => {
      isComposingRef.current = false;
      setPromptDraft(next);
      updateNodeData(id, { prompt: next });
    },
    [id, updateNodeData],
  );
  const genMode: VideoGenMode = data.genMode ?? "textToVideo";
  const {
    models: availableVideoModels,
    isLoading: videoModelsLoading,
    isFallback: videoModelsFallback,
  } = useFreezoneVideoModels();
  const selectedVideoModel = useMemo(
    () => selectVideoModel(availableVideoModels, data.model),
    [availableVideoModels, data.model],
  );
  const modelId = selectedVideoModel?.id ?? "";
  const selectedVideoModelId = selectedVideoModel?.apiModel ?? selectedVideoModel?.id ?? modelId;
  const isHappyHorseModel = isHappyHorseVideoModel(selectedVideoModelId);
  const configuredAspectRatios = useMemo(
    () => (selectedVideoModel?.ratioOptions ?? []).map((ratio) => ratio.trim()).filter(Boolean),
    [selectedVideoModel],
  );
  const hasConfiguredAspectRatios = configuredAspectRatios.length > 0;
  // When the model declares ratios in the media catalog they prevail; otherwise the old basis applies — aspectRatio accepts only
  // legal ratio presets (including "auto"); old nodes that were historically written as a pixel string (such as "1248:704")
  // snap here to the nearest legal video ratio, keeping the chip display clean.
  const aspectRatio: FreezoneVideoAspectRatio = hasConfiguredAspectRatios
    ? configuredAspectRatios.includes(String(data.aspectRatio))
      ? String(data.aspectRatio)
      : configuredAspectRatios[0]
    : (ASPECT_RATIOS as readonly string[]).includes(String(data.aspectRatio))
      ? String(data.aspectRatio)
      : snapToAllowedAspectRatio(
          String(data.aspectRatio ?? ""),
          VIDEO_GENERATION_ASPECT_RATIOS,
          "16:9",
        );
  // When Admin config exists, submit the model's declared ratio as is; when not configured keep the old auto-derivation logic:
  // never send "auto", derive the nearest ratio from the node's real pixels (if any), otherwise fall back to 16:9.
  const submitAspectRatio: FreezoneVideoAspectRatio =
    !hasConfiguredAspectRatios && aspectRatio === "auto"
      ? snapToAllowedAspectRatio(
          typeof data.widthPx === "number" &&
            typeof data.heightPx === "number" &&
            data.widthPx > 0 &&
            data.heightPx > 0
            ? `${data.widthPx}:${data.heightPx}`
            : "",
          VIDEO_GENERATION_ASPECT_RATIOS,
          "16:9",
        )
      : aspectRatio;
  const aspectRatioOptions = useMemo<readonly FreezoneVideoAspectRatio[]>(
    () => (hasConfiguredAspectRatios ? configuredAspectRatios : ASPECT_RATIOS),
    [configuredAspectRatios, hasConfiguredAspectRatios],
  );
  const qualityOptions = useMemo(
    () => videoQualityOptionsForModel(selectedVideoModel),
    [selectedVideoModel],
  );
  const quality = normalizeVideoQuality(data.quality, qualityOptions);
  const durationBounds = useMemo(
    () => videoDurationBoundsForModel(selectedVideoModel),
    [selectedVideoModel],
  );
  const durationSec = clampVideoDuration(
    typeof data.durationSec === "number" ? data.durationSec : DEFAULT_DURATION_MIN,
    durationBounds,
  );
  const sceneOptimizeOptions = useMemo(
    () => sceneOptimizeOptionsForModel(selectedVideoModel),
    [selectedVideoModel],
  );
  const sceneOptimize = normalizeSceneOptimize(
    data.sceneOptimize,
    sceneOptimizeOptions,
    defaultSceneOptimizeForModel(selectedVideoModel),
  );
  const generateAudio = Boolean(data.generateAudio);
  const isSeedance20Model = isSeedance2VideoModel(selectedVideoModelId);
  // The real-person asset review switch is now declared by the media catalog (#210): it used to be "shown for every Seedance 2.0",
  // and now whoever supports it is ticked in Admin. isSeedance20Model is still used for 2.0-only logic such as scene optimization.
  const supportsHumanReview = selectedVideoModel?.humanReview === true;
  const humanReview = Boolean(data.humanReview);
  const count: VideoGenCount = (data.count ?? 1) as VideoGenCount;
  const upstreamNodes = useUpstreamNodes(id);
  const videoInputBilling = useMemo(() => {
    if (genMode !== "allReference" && genMode !== "videoEdit") {
      return { present: false, ready: true, durationSeconds: 0 };
    }
    const ordered = sortUpstreamByReferenceOrder(
      upstreamNodes,
      data.referenceOrder,
    ).filter((node) => Boolean(referenceVideoUrl(node)));
    const limit =
      genMode === "videoEdit" ? 1 : (selectedVideoModel?.referenceVideoMax ?? 3);
    const videos = ordered.slice(0, Math.max(limit, 0));
    if (videos.length === 0) {
      return { present: false, ready: true, durationSeconds: 0 };
    }
    const durations = videos.map((node) =>
      typeof node.data.durationMs === "number" && node.data.durationMs > 0
        ? node.data.durationMs
        : null,
    );
    const ready = durations.every((duration) => duration != null);
    return {
      present: true,
      ready,
      durationSeconds: ready
        ? durations.reduce((sum, duration) => sum + (duration ?? 0), 0) / 1000
        : 0,
    };
  }, [data.referenceOrder, genMode, selectedVideoModel, upstreamNodes]);
  useEffect(() => {
    const patch: Partial<VideoNodeData> = {};
    if (data.quality !== quality) {
      patch.quality = quality;
    }
    if (data.durationSec !== durationSec) {
      patch.durationSec = durationSec;
    }
    if (Object.keys(patch).length > 0) {
      updateNodeData(id, patch);
    }
  }, [
    data.durationSec,
    data.quality,
    durationSec,
    id,
    quality,
    updateNodeData,
  ]);
  const videoBackendForCost =
    videoModelsLoading || videoModelsFallback
      ? null
      : (selectedVideoModel?.apiModel ?? null);
  // Debounce the cost-estimate inputs: dragging the duration slider (and,
  // to a lesser degree, flipping count/quality/model) churns the query key
  // and TanStack Query aborts each in-flight request, spraying "Canceled"
  // rows across the Network tab. Coalesce to one request once the params
  // settle (~350ms). Primitives only — see useDebouncedValue's contract.
  const debouncedBackend = useDebouncedValue(videoBackendForCost, 350);
  const debouncedCatalogId = useDebouncedValue(
    selectedVideoModel?.catalogId ?? null,
    350,
  );
  const debouncedQuality = useDebouncedValue(quality, 350);
  const debouncedCount = useDebouncedValue(count, 350);
  const debouncedDurationSec = useDebouncedValue(durationSec, 350);
  const debouncedVideoInputPresent = useDebouncedValue(
    videoInputBilling.present,
    350,
  );
  const debouncedInputVideoDuration = useDebouncedValue(
    videoInputBilling.durationSeconds,
    350,
  );
  const videoCount = Math.min(Math.max(debouncedCount, 1), 4);
  const videoPricingQuantity = videoCount * debouncedDurationSec;
  // The failure state always quotes (see the comment of costProbeEnabled): the retry button can submit even when the node is unselected.
  // This line used to sit below cameraMovementPreset and was lifted here to serve as input to the quote; the call position
  // changed but it still executes unconditionally, so the hook order stays stable.
  const { isGenerating } = useNodeGenerationTaskState(data);
  const hasGenerationError =
    !isGenerating &&
    !data.videoUrl &&
    typeof data.generationError === "string" &&
    data.generationError.trim().length > 0;
  const costProbeActive = costProbeEnabled || hasGenerationError;
  const videoCreditCost = useGenerationCreditCost(
    "feature",
    costProbeActive && debouncedBackend && videoInputBilling.ready
      ? VIDEO_GENERATE_FEATURE_KEY
      : null,
    {
      surface: "canvas",
      params: {
        ...(debouncedCatalogId ? { catalog_id: debouncedCatalogId } : {}),
        video_backend: debouncedBackend,
        resolution: qualityToResolution(debouncedQuality),
        pricing_quantity: videoPricingQuantity,
        operation: genMode,
        generate_audio: generateAudio,
        video_input_present: debouncedVideoInputPresent,
        input_video_duration_seconds: debouncedInputVideoDuration,
      },
      quantity: videoCount,
    },
  );
  const videoBillingRuleMissing =
    videoCreditCost.error instanceof BillingRuleNotConfiguredError;
  const billingRuleMissingSubmitMessage = videoBillingRuleMissing
    ? t("node.videoNode.billingRuleMissingSubmit", {
        defaultValue:
          "Video generation did not start: billing rules are not configured. Contact an administrator to set credit rules and retry.",
      })
    : null;
  // Use the server-issued `display`, do not format `cost` yourself: during a promotion display is "original→current",
  // and CreditCostPill renders the struck-through original price and the promo label precisely through this `→` (credit-visual.tsx:117).
  // A self-assembled one has only a single number, and the whole promo display would vanish. Same basis as VideoNode.
  const totalCreditCostDisplay =
    videoCreditCost.data?.data.display ??
    (videoBillingRuleMissing ? t("common.billingRuleNotConfiguredShort") : null);
  // display and promotion must be issued as a pair: with only the former the label falls back to the generic "On sale",
  // and the real copy like "50% off for a limited time" cannot be obtained.
  const creditPromotion = videoCreditCost.data?.data.promotion ?? null;
  const cameraMovementId =
    typeof data.cameraMovement === "string" ? data.cameraMovement : null;
  // Pull the camera-template catalog from `/freezone/video/camera-templates`.
  // Fall back to the bundled `CAMERA_MOVEMENT_PRESETS` while loading or if the
  // backend is unreachable so the chip never goes blank.
  const cameraTemplatesQuery = useFreezoneVideoCameraTemplates();
  const cameraTemplates = useMemo<ReadonlyArray<CameraMovementPreset>>(
    () =>
      cameraTemplatesQuery.templates.length > 0
        ? cameraTemplatesQuery.templates
        : CAMERA_MOVEMENT_PRESETS,
    [cameraTemplatesQuery.templates],
  );
  const cameraTemplatesLoading = cameraTemplatesQuery.isLoading;
  const cameraMovementPreset = useMemo(
    () => findCameraMovementPreset(cameraTemplates, cameraMovementId),
    [cameraTemplates, cameraMovementId],
  );
  // ------ upstream reference images ----------------------------------------
  // Anything connected via target → this video node that has an image url
  // shows up as a thumbnail chip next to the camera/role/marker chips. Ordered
  // by connection order (later-referenced after earlier), with manual
  // referenceOrder taking precedence — see sortUpstreamByReferenceOrder.
  // Subscribe to ONLY this node's one-hop upstream (not the whole nodes array)
  // so dragging unrelated nodes doesn't re-render this node. See useUpstreamGraph.
  const videoInputNodes = useMemo(
    () => upstreamNodes.filter((node) => !isCompositionTimelineAudioNode(node)),
    [upstreamNodes],
  );
  const referenceImages = useMemo(() => {
    const upstream = sortUpstreamByReferenceOrder(
      videoInputNodes,
      data.referenceOrder,
    );
    return upstream
      .map((node) => {
        const url = referenceImageUrl(node);
        if (!url) return null;
        return { nodeId: node.id, url };
      })
      .filter(
        (entry): entry is { nodeId: string; url: string } => entry != null,
      );
  }, [videoInputNodes, data.referenceOrder]);

  // Unified "image / video / audio" upstream reference entries, for the chips row. The order follows the connection order
  // (in sync with referenceImages), so chip numbers 1/2/3... match the visual order.
  // Text upstreams do not enter this row — the "@text chip" is already rendered separately above.
  const referenceMedia = useMemo<ReferenceMediaItem[]>(() => {
    const upstream = sortUpstreamByReferenceOrder(
      videoInputNodes,
      data.referenceOrder,
    );
    const items: ReferenceMediaItem[] = [];
    for (const node of upstream) {
      const videoUrl = referenceVideoUrl(node);
      if (videoUrl) {
        const vdata = node.data as {
          previewImageUrl?: string | null;
          displayName?: string | null;
        };
        const thumbUrl =
          typeof vdata.previewImageUrl === "string" &&
          vdata.previewImageUrl.length > 0
            ? vdata.previewImageUrl
            : null;
        items.push({
          kind: "video",
          nodeId: node.id,
          videoUrl,
          thumbUrl,
          displayName: vdata.displayName ?? null,
        });
        continue;
      }
      if (isAudioNode(node)) {
        const audioUrl =
          typeof node.data.audioUrl === "string" &&
          node.data.audioUrl.length > 0
            ? node.data.audioUrl
            : null;
        if (!audioUrl) continue;
        items.push({
          kind: "audio",
          nodeId: node.id,
          audioUrl,
          displayName: node.data.displayName ?? null,
        });
        continue;
      }
      const url = referenceImageUrl(node);
      if (url) {
        items.push({
          kind: "image",
          nodeId: node.id,
          imageUrl: url,
          displayName:
            (node.data as { displayName?: string | null }).displayName ??
            null,
        });
      }
    }
    return items;
  }, [videoInputNodes, data.referenceOrder]);

  // @image1 / @audio1 in the prompt must correspond live to the "character library" connected references: when deleting / reordering /
  // adding references the library renumbers (after image1 is deleted the old image2 becomes image1), and here the mention numbers in the prompt
  // are rewritten accordingly, with mentions of deleted references removed. By diffing "the previous frame's ordered ids ↔ this frame's ordered
  // ids", it covers all edge-deletion paths (detach button / double-click disconnect / Delete key) and manual reordering.
  const orderedImageIds = useMemo(
    () =>
      referenceMedia
        .filter((item) => item.kind === "image")
        .map((item) => item.nodeId),
    [referenceMedia],
  );
  const orderedVideoIds = useMemo(
    () =>
      referenceMedia
        .filter((item) => item.kind === "video")
        .map((item) => item.nodeId),
    [referenceMedia],
  );
  const orderedAudioIds = useMemo(
    () =>
      referenceMedia
        .filter((item) => item.kind === "audio")
        .map((item) => item.nodeId),
    [referenceMedia],
  );
  const applyPromptRemap = useCallback(
    (next: string) => updateNodeData(id, { prompt: next }),
    [id, updateNodeData],
  );
  useReferenceMentionSync(
    prompt,
    [
      { prefix: "image", ids: orderedImageIds },
      { prefix: "video", ids: orderedVideoIds },
      { prefix: "audio", ids: orderedAudioIds },
    ],
    applyPromptRemap,
  );

  // Add "same-type index + whether within the current mode's cap" to each referenceMedia entry.
  // When the current genMode has no entry in REFERENCE_CAPS_BY_MODE (textToVideo), everything is treated as
  // within=true; the downstream chip / mention candidates decide whether to consume within.
  const referenceCaps = useMemo(
    () => referenceCapsForMode(selectedVideoModel, genMode),
    [genMode, selectedVideoModel],
  );
  const referenceMediaCapInfo = useMemo(() => {
    const counts = { image: 0, video: 0, audio: 0 };
    return referenceMedia.map((item) => {
      counts[item.kind] += 1;
      const cap = referenceCaps?.[item.kind];
      const withinCap = cap == null || counts[item.kind] <= cap;
      return { item, typeIndex: counts[item.kind], withinCap };
    });
  }, [referenceCaps, referenceMedia]);

  // @ mention candidates — images and audio can both be referenced, but the numbering follows *each type's own* index,
  // *not* the mixed position in the row. The backend maps imageN by the number of uploaded images; if mixed positions were used for numbering
  // (with audio first the image would become "image2"), the backend sees only 1 image yet is asked to reference image2
  // and errors. So images use the image index and audio uses the audio index, each counted independently.
  //
  // For modes with an entry in the REFERENCE_CAPS_BY_MODE table, entries beyond the cap must not enter the @ candidates
  // — the server drops them outright, and leaving them in the candidates would only get what the user picked silently ignored.
  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    const out: MentionCandidate[] = [];
    let imageIdx = 0;
    let videoIdx = 0;
    let audioIdx = 0;
    const enforceCap = referenceCaps != null;
    for (const info of referenceMediaCapInfo) {
      const item = info.item;
      if (item.kind === "image") {
        imageIdx += 1;
        if (enforceCap && !info.withinCap) continue;
        out.push({
          key: item.nodeId,
          name: `image${imageIdx}`,
          imageUrl: resolveImageDisplayUrl(item.imageUrl),
          index: imageIdx,
        });
      } else if (item.kind === "video") {
        videoIdx += 1;
        if (enforceCap && !info.withinCap) continue;
        out.push({
          key: item.nodeId,
          name: `video${videoIdx}`,
          imageUrl: item.thumbUrl ? resolveImageDisplayUrl(item.thumbUrl) : "",
          videoUrl: resolveImageDisplayUrl(item.videoUrl),
          index: videoIdx,
        });
      } else if (item.kind === "audio") {
        audioIdx += 1;
        if (enforceCap && !info.withinCap) continue;
        out.push({
          key: item.nodeId,
          name: `audio${audioIdx}`,
          imageUrl: "",
          index: audioIdx,
          audioUrl: resolveImageDisplayUrl(item.audioUrl),
          displayName: audioReferenceFileName(item),
        });
      }
    }
    return out;
  }, [referenceCaps, referenceMediaCapInfo]);

  // Detach an upstream asset: delete the edge "that upstream node → this node". collectInputContents
  // walks only one hop, so item.nodeId is the directly connected upstream node, and the edge to delete can be located precisely.
  const handleDetachUpstream = useCallback(
    (sourceNodeId: string) => {
      useCanvasStore
        .getState()
        .edges.filter((edge) => edge.source === sourceNodeId && edge.target === id)
        .forEach((edge) => deleteEdge(edge.id));
    },
    [id, deleteEdge],
  );

  // Generic upstream traversal: get a unified view of text/imageUrl/videoUrl/audioUrl of all upstream nodes.
  // Video generation uses only the text field to prepend to the prompt; image/video/audio still go through
  // the classification logic already in their own branches (with backend limit validation).
  const upstreamContents = useMemo(
    () => videoInputNodes.map(extractUpstreamContent),
    [videoInputNodes],
  );
  const upstreamTextContents = useMemo(
    () =>
      upstreamContents.filter(
        (c) => typeof c.text === "string" && c.text.trim().length > 0,
      ),
    [upstreamContents],
  );
  const upstreamTextJoined = useMemo(
    () => joinUpstreamText(upstreamContents),
    [upstreamContents],
  );

  // Count upstream resources by media type. Drives the disable rules on the
  // tab row — e.g. image-to-video only makes sense with images (no upstream videos),
  // first-last-frame caps at 2 images.
  const upstreamCounts = useMemo(() => {
    let images = 0;
    let videos = 0;
    let audios = 0;
    for (const node of videoInputNodes) {
      if (referenceVideoUrl(node)) {
        // Video nodes or upload nodes carrying a videoUrl (videos picked from the asset library) all count as video.
        videos += 1;
      } else if (isAudioNode(node)) {
        if (
          typeof node.data.audioUrl === "string" &&
          node.data.audioUrl.length > 0
        ) {
          audios += 1;
        }
      } else if (referenceImageUrl(node)) {
        images += 1;
      }
    }
    return { images, videos, audios };
  }, [videoInputNodes]);
  // HappyHorse mode availability is decided by the "upstream node type", not by whether the asset is filled in. An empty image
  // node (not yet generated/uploaded) should also make "first frame / image reference" selectable — connecting the node first and filling the image
  // later is the normal order. So counts here are by node type, unlike the "resolved URL" basis of upstreamCounts.
  const upstreamTypeCounts = useMemo(() => {
    let images = 0;
    let videos = 0;
    let audios = 0;
    for (const node of videoInputNodes) {
      // An upload node carrying a videoUrl (a library video) is judged as video first, avoiding falling into the isUploadNode branch below
      // and being miscounted as an image. An empty video node (not yet generated) still counts as video by type.
      if (isVideoNode(node) || referenceVideoUrl(node)) {
        videos += 1;
      } else if (isAudioNode(node)) {
        audios += 1;
      } else if (
        isImageGenNode(node) ||
        isUploadNode(node) ||
        isImageEditNode(node) ||
        isExportImageNode(node) ||
        isStoryboardGenNode(node)
      ) {
        images += 1;
      }
    }
    return { images, videos, audios };
  }, [videoInputNodes]);

  const handleTranslatePrompt = useCallback(async () => {
    if (isTranslatingPrompt || isGenerating) return;
    const trimmed = prompt.trim();
    if (trimmed.length === 0) return;
    const project = readUrl().project;
    if (!project) {
      console.error("[video-node] translate: no project in URL");
      return;
    }
    setIsTranslatingPrompt(true);
    try {
      const translated = await translateNodeText(project, {
        text: prompt,
        nodeId: id,
        nodeType: "video",
      });
      if (translated) {
        updateNodeData(id, { prompt: translated });
      }
    } catch (error) {
      console.error("[video-node] translate failed", error);
    } finally {
      setIsTranslatingPrompt(false);
    }
  }, [id, isGenerating, isTranslatingPrompt, prompt, updateNodeData]);

  // First connected image selects a model-compatible mode. Seedance 2.0 uses
  // omni reference; Seedance 1.x uses first-frame generation.
  useEffect(() => {
    if (isHappyHorseModel) return;
    if (data.genMode != null) return;
    if (referenceImages.length === 0) return;
    const defaultMode = videoUpstreamImageDefaultMode(selectedVideoModel);
    if (defaultMode) updateNodeData(id, { genMode: defaultMode });
  }, [
    data.genMode,
    id,
    isHappyHorseModel,
    referenceImages.length,
    selectedVideoModelId,
    selectedVideoModel,
    updateNodeData,
  ]);

  // HappyHorse's mode is entirely decided by the upstream node type (the 4 major functions of the docs map one to one); here a
  // unified state machine replaces scattered fallback effects, avoiding several effects fighting each other:
  //   - upstream has video       → video edit (videoEdit / video_url)
  //   - upstream images >1       → image reference (imageReference / reference_images 1-9)
  //   - upstream images == 1     → default first frame (imageToVideo / image_url), but respect the user's
  //                                active switch to "image reference"
  //   - no upstream              → text-to-video (textToVideo)
  // Corrected every time, ensuring genMode never gets stuck in a mode that mismatches the current upstream (otherwise submit would be
  // silently truncated / trigger an upstream mutual-exclusion error).
  useEffect(() => {
    if (!isHappyHorseModel) return;
    const { images, videos } = upstreamTypeCounts;
    let target: VideoGenMode;
    if (videos > 0) {
      target = "videoEdit";
    } else if (images > 1) {
      target = "imageReference";
    } else if (images === 1) {
      target = ["firstFrame", "imageToVideo", "imageReference"].includes(genMode)
        && isVideoModeSupportedByModel(genMode, selectedVideoModel)
        ? genMode
        : (videoUpstreamImageDefaultMode(selectedVideoModel) ?? "textToVideo");
    } else {
      target = "textToVideo";
    }
    if (genMode !== target && isVideoModeSupportedByModel(target, selectedVideoModel)) {
      updateNodeData(id, { genMode: target });
    }
  }, [
    genMode,
    id,
    isHappyHorseModel,
    upstreamTypeCounts.images,
    upstreamTypeCounts.videos,
    selectedVideoModel,
    updateNodeData,
  ]);

  // Seedance 1.x cannot consume video or audio references. Switch once to the
  // base Seedance 2.0 omni model when those node types first appear. The pure
  // capability helper also waits for the real model list before choosing.
  const autoSwitchedForMediaRef = useRef(false);
  useEffect(() => {
    const action = videoReferenceAutoSwitchAction({
      counts: upstreamTypeCounts,
      currentModelId: selectedVideoModelId,
      models: availableVideoModels,
      modelsLoading: videoModelsLoading,
      alreadySwitched: autoSwitchedForMediaRef.current,
    });
    if (action.kind === "release") {
      autoSwitchedForMediaRef.current = false;
      return;
    }
    if (action.kind === "none") return;
    autoSwitchedForMediaRef.current = true;
    updateNodeData(id, {
      model: action.modelId,
      genMode: action.genMode,
    });
  }, [
    availableVideoModels,
    id,
    selectedVideoModelId,
    updateNodeData,
    upstreamTypeCounts,
    videoModelsLoading,
  ]);

  // Audio refs only carry meaning under the omni-gen (allReference) path —
  // textToVideo / firstLastFrame / imageToVideo discard them. So when an
  // audio upstream first appears, force the mode to `allReference`. Tracked
  // through a ref so we only fire on the 0 → ≥1 transition; once the user
  // disconnects all audio and reconnects, it fires again.
  const prevHasAudioRef = useRef(false);
  const hasAudioUpstream = useMemo(
    () => referenceMedia.some((item) => item.kind === "audio"),
    [referenceMedia],
  );
  useEffect(() => {
    const prev = prevHasAudioRef.current;
    prevHasAudioRef.current = hasAudioUpstream;
    if (
      !prev &&
      hasAudioUpstream &&
      data.genMode !== "allReference" &&
      !isHappyHorseModel &&
      isSeedance20Model
    ) {
      updateNodeData(id, { genMode: "allReference" });
    }
  }, [
    data.genMode,
    hasAudioUpstream,
    id,
    isHappyHorseModel,
    isSeedance20Model,
    updateNodeData,
  ]);

  // When video is connected upstream, only "all reference" can consume it; other modes (text-to-video / image-to-video /
  // first-last-frame / image reference) all discard the video. So whenever a video exists upstream, force-switch to
  // allReference and lock it — the tab disabling rules below disable the other tabs along with it.
  // Unlike the audio "0→≥1 transition", this corrects every time, ensuring the mode cannot be switched away while a video is present.
  useEffect(() => {
    if (upstreamCounts.videos === 0) return;
    if (videoModelsLoading) return;
    if (isHappyHorseModel) return;
    if (!isSeedance20Model) return;
    if (genMode === "allReference" || (genMode === "videoExtend" && isVideoModeSupportedByModel("videoExtend", selectedVideoModel))) return;
    updateNodeData(id, { genMode: "allReference" });
  }, [
    upstreamCounts.videos,
    genMode,
    id,
    isHappyHorseModel,
    isSeedance20Model,
    selectedVideoModel,
    videoModelsLoading,
    updateNodeData,
  ]);

  // Text-to-video accepts no asset references. Even if the user first manually picked textToVideo and then connected
  // images/audio (the two auto-switch effects above both bail because genMode is already explicit),
  // it must be forced away, otherwise it stays on textToVideo and discards the connected assets. Images/audio uniformly go to
  // allReference (all reference), consistent with the default on "first image connection".
  useEffect(() => {
    if (isHappyHorseModel) return;
    if (genMode !== "textToVideo") return;
    if (upstreamCounts.images === 0 && upstreamCounts.audios === 0) return;
    if (upstreamCounts.images > 0) {
      const defaultMode = videoUpstreamImageDefaultMode(selectedVideoModel);
      if (defaultMode) updateNodeData(id, { genMode: defaultMode });
    } else if (isSeedance20Model) {
      updateNodeData(id, { genMode: "allReference" });
    }
  }, [
    genMode,
    isHappyHorseModel,
    isSeedance20Model,
    selectedVideoModelId,
    selectedVideoModel,
    upstreamCounts.images,
    upstreamCounts.audios,
    id,
    updateNodeData,
  ]);

  // First-last-frame carries only the two images "first frame + last frame". Once upstream images >2, semantically it is no longer
  // a first-last-frame scenario (it should be multi-image reference / all reference); auto-switching to allReference is the same kind of fallback as
  // "force allReference when video is upstream". Corrected every time, so the user is not stuck in firstLastFrame with >2
  // images and silently truncated to two on submit.
  useEffect(() => {
    if (isHappyHorseModel) return;
    if (genMode !== "firstLastFrame") return;
    if (upstreamCounts.images <= 2) return;
    updateNodeData(id, { genMode: "allReference" });
  }, [genMode, isHappyHorseModel, upstreamCounts.images, id, updateNodeData]);

  const hasPromptText = prompt.trim().length > 0 || upstreamTextJoined.length > 0;
  const hasRequiredMediaForMode =
    genMode === "videoEdit" || genMode === "videoExtend"
      ? upstreamCounts.videos > 0
      : upstreamCounts.images > 0;
  const mediaRejectionReasonKey = videoSubmitMediaRejectionReason(
    genMode,
    selectedVideoModel,
    upstreamCounts,
  );
  const mediaRejectionReason = mediaRejectionReasonKey ? t(mediaRejectionReasonKey) : null;
  // Per-mode asset caps declared by the media catalog: when exceeded, do not let the user click only to wait for a backend 400.
  const selectedModelReferenceError = selectedVideoModelReferenceDisabledReason(
    selectedVideoModel,
    upstreamCounts,
    genMode,
    t,
  );
  const submitDisabled =
    isGenerating ||
    videoBillingRuleMissing ||
    !selectedVideoModel ||
    selectedModelReferenceError !== null ||
    mediaRejectionReason != null ||
    (videoModeRequiresPrompt(genMode)
      ? !hasPromptText
      : !hasRequiredMediaForMode);

  const handleSubmit = useCallback(async (): Promise<{ videoUrl?: string }> => {
    if (billingRuleMissingSubmitMessage) {
      updateNodeData(id, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: billingRuleMissingSubmitMessage,
        generationErrorDetails: billingRuleMissingSubmitMessage,
        generationErrorRequestId: null,
      });
      return {};
    }
    if (submitDisabled) return {};
    // In-flight guard (consistent with ImageGenNode): the first completion clears isGenerating,
    // and submitDisabled cannot stop "resubmitting while N-1 tasks of the old batch are still running" — the old closure
    // would overwrite the new batch's generationBatch with stale completedUrls.
    if (submittingRef.current) return {};
    submittingRef.current = true;
    try {
    const projectId = readUrl().project;
    if (!projectId) {
      console.error("[video-node] no project in URL");
      return {};
    }
    updateNodeData(id, {
      isGenerating: true,
      generationStartedAt: Date.now(),
      // Clear any prior failure so the banner reflects only this attempt.
      // Note generationBatch is not cleared here: below there are several more validation-failure early-return paths,
      // and clearing here would let one failed submission needlessly destroy the existing album — batch clearing moves to just before the run really starts.
      generationError: null,
      generationErrorDetails: null,
      generationErrorRequestId: null,
    });
    // The camera-movement fragment is prepended to the final prompt; upstream text comes first, the user's own
    // prompt after, and the two segments are separated by \n\n (consistent with ImageGenNode/ImageEditNode).
    const fragment = cameraMovementPreset?.promptFragment;
    const trimmedPrompt = prompt.trim();
    const userPrompt = [upstreamTextJoined, trimmedPrompt]
      .filter((s) => s.length > 0)
      .join("\n\n");
    const fallbackPrompt = fragment
      ? userPrompt
        ? `${fragment}, ${userPrompt}`
        : fragment
      : userPrompt;
    try {
      // Workflow recipe nodes use the final prompt compiled by the recipe; non-recipe nodes fall back to the concatenation above.
      const composedPrompt = await compileWorkflowNodePrompt({
        nodeId: id,
        nodeData: data,
        nodeKind: "video",
        nodePrompt: trimmedPrompt,
        upstreamText: upstreamTextJoined,
        upstreamContents,
        fallbackPrompt,
        referenceMedia: referenceMediaCapInfo.map((entry) => ({
          kind: entry.item.kind,
          label: formatReferenceMediaCompilerLabel(entry),
        })),
        onCompileMetadata: ({ mode, prompt: compiledPrompt, recipeIds }) => updateNodeData(id, {
          workflowRecipeCompileMode: mode,
          workflowRecipeCompiledAt: new Date().toISOString(),
          workflowRecipeCompiledPrompt: compiledPrompt,
          prompt: compiledPrompt,
          workflowRecipeIds: recipeIds,
        }),
      });
      // Walk the current edges/nodes once — used by every non-textToVideo
      // branch to collect upstream resources. It must come from the same source as the UI numbering side (useUpstreamNodes):
      // collected in connection order. It once collected in state.nodes order (node creation order), so a node created first
      // but connected later was ordered before others in references, and @image1 pointed to a misaligned image on the backend.
      const collectUpstream = () => {
        const state = useCanvasStore.getState();
        const inputEdges = state.edges.filter((edge) => {
          const edgeData =
            edge.data && typeof edge.data === "object"
              ? edge.data as Record<string, unknown>
              : null;
          return normalizeCanvasEdgeSemanticKind(edgeData?.link_type) !== "dependency_for";
        });
        return sortUpstreamByReferenceOrder(
          upstreamNodesInEdgeOrder(state.nodes, inputEdges, id)
            .filter((node) => !isCompositionTimelineAudioNode(node)),
          data.referenceOrder,
        );
      };
      const collectUpstreamImageUrls = (): string[] => {
        const upstream = collectUpstream();
        const urls: string[] = [];
        for (const node of upstream) {
          const url = submittableImageUrl(node);
          if (typeof url === "string" && url.length > 0) urls.push(url);
        }
        return urls;
      };
      const collectUpstreamKeyframeUrls = (): {
        firstFrameUrl: string | null;
        lastFrameUrl: string | null;
      } => {
        const state = useCanvasStore.getState();
        const candidates: Array<{
          url: string;
          slot?: "first" | "last";
        }> = [];
        for (const node of collectUpstream()) {
          const url = submittableImageUrl(node);
          if (!url) continue;
          const edge = state.edges.find(
            (candidate) => candidate.source === node.id && candidate.target === id,
          );
          candidates.push({
            url,
            slot: edge?.data?.keyframeSlot,
          });
        }
        return resolveVideoKeyframeUrls(candidates);
      };

      const durationClamped = clampVideoDuration(durationSec, durationBounds);
      const cameraTemplateId = cameraMovementId;
      // The backend records each node's generation history by canvas_id + node_id. With multiple generations each
      // sibling node uses its own targetId as node_id, so history lands on the matching node separately.
      const canvasId = readUrl().canvas ?? "default";

      // The backend no longer supports producing several at once; instead it calls the endpoint N times concurrently by "generation count". First
      // assemble a "call the endpoint once" closure doSubmit by genMode; if validation fails it is set to empty and returns early.
      let doSubmit: ((targetId: string) => Promise<FreezoneJobRef>) | null = null;
      if (genMode === "multishot") {
        // MiniMax H3 Multishot (long continuous video) is canvas-only in
        // v1 — its ordered shot list, review dialog and reference-source
        // UI (canvas images + Character Library) only exist in
        // VideoOperationsPanel.tsx. This form's own MODE_TABS never offers
        // "multishot" as a tab, so this only fires for a node whose saved
        // data already has genMode:"multishot" from the canvas.
        toast.error(t("node.videoOps.modeDisabled.multishotCanvasOnly"));
        updateNodeData(id, { isGenerating: false, generationStartedAt: null });
        return {};
      }
      if (genMode === "firstFrame" || genMode === "firstLastFrame") {
        const keyframes = collectUpstreamKeyframeUrls();
        const firstFrameUrl = keyframes.firstFrameUrl;
        const lastFrameUrl = genMode === "firstLastFrame" ? keyframes.lastFrameUrl : null;
        if (!firstFrameUrl && !lastFrameUrl) {
          console.warn(
            "[video-node] firstLastFrame submit without any frame",
          );
          updateNodeData(id, {
            isGenerating: false,
            generationStartedAt: null,
          });
          return {};
        }
        doSubmit = (targetId) =>
          submitFreezoneVideoKeyframes(projectId, {
            firstFrameUrl,
            lastFrameUrl,
            genMode,
            prompt: composedPrompt,
            cameraTemplateId,
            aspectRatio: submitAspectRatio,
            resolution: qualityToResolution(quality),
            durationSeconds: durationClamped,
            generateAudio,
            model: selectedVideoModel?.catalogId ?? modelId,
            modelParams: data.modelParams,
            humanReview: supportsHumanReview && humanReview,
            sceneOptimize: sceneOptimize ?? null,
            canvasId,
            nodeId: targetId,
          });
      } else if (genMode === "imageToVideo" || genMode === "imageReference") {
        // Unified i2v endpoint: 1 image = image-to-video, 2-9 images = image-reference video.
        const imageUrls = collectUpstreamImageUrls().slice(
          0,
          referenceCaps?.image ?? 9,
        );
        if (imageUrls.length === 0) {
          console.warn("[video-node] i2v submit without any upstream image");
          updateNodeData(id, {
            isGenerating: false,
            generationStartedAt: null,
          });
          return {};
        }
        doSubmit = (targetId) =>
          submitFreezoneVideoI2v(projectId, {
            imageUrls,
            prompt: composedPrompt,
            cameraTemplateId,
            aspectRatio: submitAspectRatio,
            resolution: qualityToResolution(quality),
            durationSeconds: durationClamped,
            generateAudio,
            model: selectedVideoModel?.catalogId ?? modelId,
            genMode,
            modelParams: data.modelParams,
            humanReview: supportsHumanReview && humanReview,
            sceneOptimize: sceneOptimize ?? null,
            canvasId,
            nodeId: targetId,
          });
      } else if (genMode === "videoEdit") {
        // Video edit: 1 source video + 0-5 reference images → video_url + reference_images.
        // No longer HappyHorse-only — every model that declares video_edit in the catalog takes this path,
        // and submissions carry their own catalogId, with capability validated by the backend per the catalog.
        const upstream = collectUpstream();
        const videoUrl =
          upstream
            .map((node) => referenceVideoUrl(node) ?? "")
            .find((url) => url.length > 0) ?? "";
        if (!videoUrl) {
          console.warn("[video-node] videoEdit submit without upstream video");
          updateNodeData(id, {
            isGenerating: false,
            generationStartedAt: null,
          });
          return {};
        }
        const allImageUrls = collectUpstreamImageUrls();
        // The reference image cap of video edit follows the media catalog (5 if not configured); silent truncation of the excess would make
        // the user think all were used.
        const imageLimit = referenceCaps?.image ?? 5;
        if (allImageUrls.length > imageLimit) {
          toast.warning(
            t("node.videoNode.videoEdit.imageLimit", { limit: imageLimit, ignored: allImageUrls.length - imageLimit }),
          );
        }
        const imageUrls = allImageUrls.slice(0, imageLimit);
        const audioLimit = referenceCaps?.audio ?? 0;
        const audioUrls = referenceMedia
          .filter((item) => item.kind === "audio")
          .map((item) => item.audioUrl)
          .slice(0, audioLimit);
        doSubmit = (targetId) =>
          submitFreezoneVideoEdit(projectId, {
            videoUrl,
            imageUrls,
            audioUrls,
            prompt: composedPrompt,
            cameraTemplateId,
            resolution: qualityToResolution(quality),
            audioSetting: "auto",
            generateAudio,
            model: selectedVideoModel?.catalogId ?? modelId,
            genMode,
            modelParams: data.modelParams,
            canvasId,
            nodeId: targetId,
          });
      } else if (genMode === "videoExtend") {
        const videoUrl = collectUpstream()
          .map((node) => referenceVideoUrl(node) ?? "")
          .find((url) => url.length > 0) ?? "";
        if (!videoUrl) {
          updateNodeData(id, { isGenerating: false, generationStartedAt: null });
          return {};
        }
        doSubmit = (targetId) =>
          submitFreezoneVideoExtend(projectId, {
            videoUrl,
            prompt: composedPrompt,
            cameraTemplateId,
            resolution: qualityToResolution(quality),
            durationSeconds: durationClamped,
            generateAudio,
            model: selectedVideoModel?.catalogId ?? modelId,
            genMode,
            humanReview: supportsHumanReview && humanReview,
            canvasId,
            nodeId: targetId,
          });
      } else if (genMode === "allReference") {
        if (!isSeedance20Model) {
          void showErrorDialog(
            isHappyHorseModel
              ? t("node.videoNode.allReference.happyHorseUnsupported")
              : t("node.videoNode.allReference.modelUnsupported"),
            t("common.error"),
          );
          updateNodeData(id, {
            isGenerating: false,
            generationStartedAt: null,
          });
          return {};
        }
        // Omni-gen: classify each upstream node by its media type.
        // Per-type caps follow the media catalog (if not configured image≤9 / video≤3 / audio≤3); the total
        // cap is computed as the sum of the three only when the model carries its own config, otherwise the backend's hard cap of 12 is kept.
        const caps = referenceCaps ?? { image: 9, video: 3, audio: 3 };
        const totalReferenceLimit = hasConfiguredReferenceCaps(selectedVideoModel)
          ? caps.image + caps.video + caps.audio
          : 12;
        const upstream = collectUpstream();
        const references: FreezoneVideoReferenceItem[] = [];
        const audioRefs: {
          url: string;
          label: string;
          durationMs: number | null;
        }[] = [];
        const videoRefs: {
          url: string;
          label: string;
          durationMs: number | null;
        }[] = [];
        let imageCount = 0;
        let videoCount = 0;
        let audioCount = 0;
        for (const node of upstream) {
          if (references.length >= totalReferenceLimit) break;
          const videoRefUrl = referenceVideoUrl(node);
          if (videoRefUrl) {
            // Video nodes or upload nodes carrying a videoUrl (library videos) are collected uniformly.
            if (videoCount < caps.video) {
              references.push({ type: "video", url: videoRefUrl });
              videoRefs.push({
                url: videoRefUrl,
                label: t("node.videoNode.referenceDuration.videoFallbackLabel", {
                  index: videoCount + 1,
                }),
                durationMs:
                  typeof node.data.durationMs === "number"
                    ? node.data.durationMs
                    : null,
              });
              videoCount += 1;
            }
          } else if (isAudioNode(node)) {
            const url =
              typeof node.data.audioUrl === "string"
                ? node.data.audioUrl
                : "";
            if (url && audioCount < caps.audio) {
              // Audio references use the "soundtrack reference" semantics by default; label uses one of sourceFileName /
              // displayName, so backend logs and later UI display line up.
              const rawLabel =
                (typeof node.data.sourceFileName === "string"
                  ? node.data.sourceFileName
                  : "") ||
                (typeof node.data.displayName === "string"
                  ? node.data.displayName
                  : "");
              references.push({
                type: "audio",
                url,
                role: "soundtrack_reference",
                label: rawLabel,
              });
              audioRefs.push({
                url,
                label:
                  rawLabel ||
                  t("node.videoNode.audio.clipFallbackLabel", {
                    index: audioCount + 1,
                  }),
                durationMs:
                  typeof node.data.durationMs === "number"
                    ? node.data.durationMs
                    : null,
              });
              audioCount += 1;
            }
          } else {
            const url = submittableImageUrl(node);
            if (url && imageCount < caps.image) {
              references.push({ type: "image", url });
              imageCount += 1;
            }
          }
        }
        if (references.length === 0) {
          console.warn("[video-node] omni-gen submit without any reference");
          updateNodeData(id, {
            isGenerating: false,
            generationStartedAt: null,
          });
          return {};
        }
        const validateReferenceDurations = async (
          media: "audio" | "video",
          refs: typeof audioRefs,
        ): Promise<boolean> => {
          const configured = referenceDurationLimitsMs(selectedVideoModel, media);
          const limits = {
            minMs:
              configured.minMs ??
              (media === "audio" && isSeedance20Model
                ? MIN_AUDIO_REFERENCE_DURATION_MS
                : undefined),
            maxMs:
              configured.maxMs ??
              (media === "audio" && isSeedance20Model
                ? MAX_AUDIO_REFERENCE_DURATION_MS
                : undefined),
            totalMinMs: configured.totalMinMs,
            totalMaxMs:
              configured.totalMaxMs ??
              (media === "audio" && isSeedance20Model
                ? MAX_AUDIO_REFERENCE_TOTAL_DURATION_MS
                : undefined),
          };
          if (refs.length === 0 || Object.values(limits).every((value) => value == null)) {
            return true;
          }
          const resolvedDurations = await Promise.all(
            refs.map((ref) =>
              typeof ref.durationMs === "number" && ref.durationMs > 0
                ? Promise.resolve(ref.durationMs)
                : media === "audio"
                  ? probeAudioDurationMs(ref.url)
                  : probeVideoDurationMs(ref.url),
            ),
          );
          const rejection = audioReferenceDurationRejection(
            refs.map((ref, index) => ({
              label: ref.label,
              durationMs: resolvedDurations[index] ?? null,
            })),
            {
              minMs: limits.minMs ?? null,
              maxMs: limits.maxMs ?? null,
              totalMinMs: limits.totalMinMs,
              totalLimitMs: limits.totalMaxMs ?? null,
              perClipLimits: limits.minMs != null || limits.maxMs != null,
            },
          );
          if (rejection) {
            const clips = formatAudioDurationClips(rejection.clips, (key, vars) =>
              t(key, vars),
            );
            const prefix =
              media === "audio"
                ? "node.videoNode.audio"
                : "node.videoNode.referenceDuration";
            const message =
              rejection.kind === "tooShort"
                ? t(`${prefix}.${media === "audio" ? "durationTooShort" : "videoTooShort"}`, {
                    min: formatAudioDurationSeconds(limits.minMs ?? 0),
                    clips,
                  })
                : rejection.kind === "tooLong"
                  ? t(`${prefix}.${media === "audio" ? "durationTooLong" : "videoTooLong"}`, {
                      max: formatAudioDurationSeconds(limits.maxMs ?? 0),
                      clips,
                    })
                  : rejection.kind === "totalTooShort"
                    ? t(
                        `${prefix}.${media === "audio" ? "durationTotalTooShort" : "videoTotalTooShort"}`,
                        {
                          min: formatAudioDurationSeconds(rejection.limitMs),
                          total: formatAudioDurationSeconds(rejection.totalMs),
                          clips,
                        },
                      )
                    : t(
                        `${prefix}.${media === "audio" ? "durationTotalTooLong" : "videoTotalTooLong"}`,
                        {
                          max: formatAudioDurationSeconds(rejection.limitMs),
                          total: formatAudioDurationSeconds(rejection.totalMs),
                          clips,
                        },
                      );
            toast.error(message, { duration: 5_000 });
            updateNodeData(id, {
              isGenerating: false,
              generationStartedAt: null,
            });
            return false;
          }
          return true;
        };
        if (!(await validateReferenceDurations("audio", audioRefs))) return {};
        if (!(await validateReferenceDurations("video", videoRefs))) return {};
        doSubmit = (targetId) =>
          submitFreezoneVideoOmniGen(projectId, {
            prompt: composedPrompt,
            cameraTemplateId,
            references,
            aspectRatio: submitAspectRatio,
            resolution: qualityToResolution(quality),
            durationSeconds: durationClamped,
            generateAudio,
            model: selectedVideoModel?.catalogId ?? modelId,
            genMode,
            modelParams: data.modelParams,
            humanReview: supportsHumanReview && humanReview,
            sceneOptimize: sceneOptimize ?? null,
            canvasId,
            nodeId: targetId,
          });
      } else {
        // textToVideo (default).
        doSubmit = (targetId) =>
          submitFreezoneVideoGen(projectId, {
            prompt: composedPrompt,
            cameraTemplateId,
            aspectRatio: submitAspectRatio,
            resolution: qualityToResolution(quality),
            durationSeconds: durationClamped,
            generateAudio,
            model: selectedVideoModel?.catalogId ?? modelId,
            genMode,
            modelParams: data.modelParams,
            humanReview: supportsHumanReview && humanReview,
            sceneOptimize: sceneOptimize ?? null,
            canvasId,
            nodeId: targetId,
          });
      }

      if (!doSubmit) {
        updateNodeData(id, { isGenerating: false, generationStartedAt: null });
        return {};
      }
      const submitOnce = doSubmit;

      // Multiple generations no longer clone sibling nodes: N tasks run concurrently and all backfill the current node's
      // generationBatch (stacked-card album, consistent with the image node). The first one to finish is set as the main video,
      // and the rest are appended one by one.
      const total = Math.min(Math.max(count, 1), 4);
      // Concurrent tasks finish in no fixed order, so accumulate the completed URLs locally and write back the whole group (avoiding read-modify-write races).
      const completedUrls: string[] = [];
      // Collect each sub-task's failure and leave it until the whole batch settles to decide uniformly whether to show an error dialog — avoiding
      // the contradictory look of "1 of N fails instantly (e.g. hits the queue limit) while the rest generate normally" showing an error and
      // a loading animation at the same time.
      const runErrors: unknown[] = [];
      const runOne = async (runIndex: number) => {
        try {
          const ref = await submitOnce(id);
          // Persist the task handle so a page refresh can resume this job.
          // N concurrent tasks of the same node can store only one handle — keep the first one's (the main video's).
          if (runIndex === 0) {
            updateNodeData(id, generationTaskDescriptor(ref));
          }
          const completed = await awaitTaskCompletion(ref.task_key, projectId);
          // Prefer the dedicated result endpoint — SSE `task.result` may only
          // carry metadata (same pattern as reverse_prompt + video_erase).
          let url = resolveOutputUrl(completed.result);
          if (!url) {
            try {
              const result = await fetchFreezoneJobResult(
                projectId,
                ref.task_type,
                ref.job_id,
              );
              url = result.url || null;
            } catch (error) {
              console.error("[video-node] fetch job result failed", error);
            }
          }
          if (url) {
            completedUrls.push(url);
            const isFirstCompleted = completedUrls.length === 1;
            updateNodeData(id, {
              // The first to finish is set as the main video and ends loading; later ones only expand the album.
              ...(isFirstCompleted
                ? {
                    videoUrl: url,
                    isGenerating: false,
                    generationStartedAt: null,
                    sourceFileName: null,
                    generationError: null,
                    generationErrorDetails: null,
                    generationErrorRequestId: null,
                  }
                : {}),
              ...(total > 1 ? { generationBatch: [...completedUrls] } : {}),
            });
          } else {
            console.warn(
              "[video-node] video gen completed without output url",
              completed,
            );
            // Only run 0 (the owner of the task handle) with no success so far ends loading —
            // a non-first task finishing first "without a URL" must not cut off the overall loading that is still running.
            if (runIndex === 0 && completedUrls.length === 0) {
              updateNodeData(id, {
                isGenerating: false,
                generationStartedAt: null,
                generationError: t("node.videoNode.generation.noResult"),
                generationErrorDetails: null,
                generationErrorRequestId: null,
              });
            }
          }
        } catch (error) {
          console.error("[video-node] video gen failed", error);
          // Record the error first and then decide whether to return early — the aggregation branch after settle relies on runErrors to judge
          // "partial failure" and show a toast; not recording before an early return would swallow failures after the first success entirely.
          runErrors.push(error);
          // When other videos of the same batch have completed (the main video has landed), do not overwrite the success state with an error —
          // a partial failure only affects the album count.
          if (completedUrls.length > 0) return;
          const resolved = resolveErrorContent(error, t("node.videoNode.generation.failed"));
          const displayErrorMessage = backendErrorToastMessage(error, t);
          const diagnostics = resolveGenerationErrorDiagnostics(error, resolved.details);
          // Persist the failure on the node so the regenerate entry survives after
          // the user dismisses the dialog (previously the error was dialog-only).
          // Only a run 0 failure ends loading: when a non-first run fails, run 0 may still be running,
          // and its success patch would clear the error banner written here.
          updateNodeData(id, {
            ...(runIndex === 0
              ? { isGenerating: false, generationStartedAt: null }
              : {}),
            generationError: displayErrorMessage,
            generationErrorDetails: diagnostics.details,
            generationErrorRequestId: diagnostics.requestId,
          });
        }
      };

      // Clearing the old album + the placeholder count happen only after all validations pass and just before the run really starts — earlier there are several
      // validation-failure early-return paths, and doing it earlier would needlessly destroy the existing album / leave the "generating" placeholder stuck.
      updateNodeData(id, { generationBatch: null });
      setAlbumPendingTotal(id, total > 1 ? total : 0);
      await Promise.allSettled(
        Array.from({ length: total }, (_, runIndex) => runOne(runIndex)),
      );
      setAlbumPendingTotal(id, 0);
      updateNodeData(id, CLEARED_GENERATION_TASK_FIELDS);
      // Decide the error feedback after the whole batch ends:
      //  - none succeeded → show one error dialog (including dedicated guidance for blocked real-person assets);
      //  - partially succeeded → no modal interruption, only a light toast saying how many fewer were produced.
      // This way "1 of N hits the queue limit and fails instantly while the rest run normally" no longer produces
      // the contradictory look of "a limit error pops up first, yet the node shows a loading animation".
      if (completedUrls.length === 0 && runErrors.length > 0) {
        const firstError = runErrors[0];
        const resolved = resolveErrorContent(firstError, t("node.videoNode.generation.failed"));
        const displayErrorMessage = backendErrorToastMessage(firstError, t);
        const diagnostics = resolveGenerationErrorDiagnostics(firstError, resolved.details);
        const haystack = `${displayErrorMessage}\n${diagnostics.details ?? ""}`;
        if (
          haystack.includes("InputImageSensitiveContentDetected.PrivateInformation")
          || haystack.includes("InputImageSensitiveContentDetected.PrivacyInformation")
        ) {
          // Assets containing a real face were blocked: guide the user to turn on "Real-person asset review" and retry.
          void showErrorDialog(
            t("node.videoNode.generation.faceBlockedMessage"),
            t("node.videoNode.generation.faceBlockedTitle"),
            diagnostics.details ?? undefined,
          );
        } else {
          void showErrorDialog(
            displayErrorMessage,
            t("common.error"),
            diagnostics.details ?? undefined,
          );
        }
      } else if (runErrors.length > 0) {
        toast.error(
          t("node.videoNode.partialBatchFailed", {
            ok: completedUrls.length,
            total,
          }),
        );
      }
      // After all tasks settle, fetch history once uniformly: all N records land under this node, and fetching when run 0
      // settles would miss the N-1 that finish later (the backend records both success and failure).
      onGenerationSettled?.();
      return completedUrls[0] ? { videoUrl: completedUrls[0] } : {};
    } catch (error) {
      console.error("[video-node] video gen failed", error);
      // Failures before any run starts (e.g. Recipe compilation) must land on
      // the node too, or the workflow runner only sees "no videoUrl".
      updateNodeData(id, {
        ...CLEARED_GENERATION_TASK_FIELDS,
        generationError: backendErrorToastMessage(error, t),
      });
      setAlbumPendingTotal(id, 0);
    }
    } finally {
      submittingRef.current = false;
    }
    return {};
  }, [
    aspectRatio,
    submitAspectRatio,
    cameraMovementId,
    cameraMovementPreset,
    count,
    data,
    referenceMediaCapInfo,
    upstreamContents,
    durationBounds,
    durationSec,
    generateAudio,
    genMode,
    humanReview,
    id,
    isSeedance20Model,
    supportsHumanReview,
    modelId,
    selectedVideoModel,
    referenceCaps,
    prompt,
    quality,
    onGenerationSettled,
    sceneOptimize,
    billingRuleMissingSubmitMessage,
    submitDisabled,
    updateNodeData,
    upstreamTextJoined,
  ]);

  // Switching models is not a pure patch, so it does not move down into the form component: when the new model does not support the current genMode
  // (such as HappyHorse-only videoEdit switching to a regular model) reset to the generic safe value
  // textToVideo, letting the state machine re-derive by the new model + upstream; otherwise a leftover mode would hit
  // an unsupported endpoint on submit and be rejected with a backend 400 (while the UI is still on the wrong tab). Also remember this choice, so video
  // nodes created later will inherit it.
  const handleModelChange = useCallback(
    (nextModelId: string) => {
      // Pass the model object rather than a bare id: when the media catalog declares supportedModes they prevail,
      // and falling back to capability inference is only a fallback when nothing is configured.
      const resetGenMode =
        data.genMode != null &&
        !isVideoModeSupportedByModel(
          data.genMode,
          availableVideoModels.find((item) => item.id === nextModelId),
        );
      updateNodeData(id, {
        model: nextModelId,
        // Switching models must clear modelParams: the param table is declared per model, and keys left over from the previous model
        // would be sent to the backend as is — at best ignored, at worst rejected as invalid params.
        modelParams: {},
        ...(resetGenMode ? { genMode: "textToVideo" as VideoGenMode } : {}),
      });
      writeLastVideoModel(nextModelId);
    },
    [availableVideoModels, data.genMode, id, updateNodeData],
  );

  // The form buttons only need `() => void`; async orchestration stays in this hook.
  const handleTranslate = useCallback(() => {
    void handleTranslatePrompt();
  }, [handleTranslatePrompt]);
  const handleGenerateClick = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);

  return {
    formProps: {
      nodeId: id,
      cameraTemplates,
      cameraTemplatesLoading,
      cameraMovementId,
      genMode,
      genModeModelId: selectedVideoModelId,
      genModeSupportedModes: selectedVideoModel?.supportedModes,
      // HappyHorse's selectable modes are decided by the upstream node type (including empty nodes with no image filled),
      // while other models still count by resolved asset URLs.
      genModeUpstreamCounts: isHappyHorseModel ? upstreamTypeCounts : upstreamCounts,
      upstreamTextContents,
      onDetachUpstream: handleDetachUpstream,
      referenceMediaItems: referenceMediaCapInfo,
      referenceCaps,
      prompt: promptDraft,
      onPromptChange: handlePromptChange,
      onCompositionStart: handlePromptCompositionStart,
      onCompositionEnd: handlePromptCompositionEnd,
      mentionCandidates,
      upstreamTextJoined,
      modelId,
      onModelChange: handleModelChange,
      modelUpstreamCounts: {
        images: upstreamCounts.images,
        videos: upstreamTypeCounts.videos,
        audios: upstreamTypeCounts.audios,
      },
      aspectRatio,
      aspectRatioOptions,
      quality,
      qualityOptions,
      durationSec,
      durationBounds,
      sceneOptimize,
      sceneOptimizeOptions,
      generateAudio,
      showHumanReview: supportsHumanReview,
      humanReview,
      modelParameters: selectedVideoModel?.request?.parameters,
      modelParams: data.modelParams,
      count,
      isTranslatingPrompt,
      isGenerating,
      // The translate threshold looks at the **persisted** prompt (data.prompt), not the editor draft —
      // during IME composition the draft already has characters but has not been written back to the store, and the button should stay disabled then.
      translateDisabled:
        isTranslatingPrompt || isGenerating || prompt.trim().length === 0,
      onTranslate: handleTranslate,
      totalCreditCostDisplay,
      creditPromotion,
      submitDisabled,
      // An over-cap asset hint takes priority over "asset type unsupported": the former is something the user just over-dragged and can fix.
      submitDisabledReason:
        billingRuleMissingSubmitMessage ??
        selectedModelReferenceError ??
        mediaRejectionReason,
      onSubmit: handleGenerateClick,
    },
    isGenerating,
    submitDisabled,
    submit: handleSubmit,
    prompt,
    quality,
    selectedVideoModelId,
    upstreamCounts,
  };
}
