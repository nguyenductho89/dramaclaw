// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { selectVideoModel } from "@/features/canvas/domain/catalogVideoModels";
import { compileWorkflowNodePrompt } from "@/features/canvas/application/workflowRecipeRuntime";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Handle,
  Position,
  useStore,
  useUpdateNodeInternals,
  type NodeProps,
} from "@xyflow/react";
import {
  isLowDetailZoom,
  setNodeMediaActive,
} from "@/features/canvas/application/canvasLod";
import {
  AlertTriangle,
  ArrowUp,
  Camera,
  ChevronDown,
  Download,
  Film,
  Images,
  Layers,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  Upload as UploadIcon,
  Video as VideoIcon,
  Volume2,
  VolumeX,
  X as XIcon,
  type LucideIcon,
} from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import {
  CANVAS_NODE_TYPES,
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
  publishNodeActionAccepted,
  publishNodeActionError,
  publishNodeActionSuccess,
  subscribeNodeAction,
} from "@/features/canvas/application/nodeActionResult";
import {
  audioReferenceDurationRejection,
  MAX_AUDIO_REFERENCE_DURATION_MS,
  MAX_AUDIO_REFERENCE_TOTAL_DURATION_MS,
  MIN_AUDIO_REFERENCE_DURATION_MS,
  referenceDurationLimitsMs,
  isHappyHorseVideoModel,
  isSeedance2VideoModel,
  isVideoModeSupportedByModel,
  resolveVideoKeyframeUrls,
  videoEmptyStateCtaModes,
  videoModeForcesAutomaticAspectRatio,
  videoModeRequiresMedia,
  videoModeRequiresPrompt,
  videoModelDefaultGenerateAudio,
  videoModelReferenceDisabledReason,
  videoModelSupportsGenerateAudio,
  videoMultiImageAutoSwitchMode,
  videoNoUpstreamResetMode,
  videoReferenceAutoSwitchAction,
  videoSubmitMediaRejectionReason,
  videoUpstreamImageDefaultMode,
  type VideoEmptyStateCtaMode,
} from "@/features/canvas/nodes/shared/videoModelCapabilities";
import {
  VIDEO_GENERATION_ASPECT_RATIOS,
  resolveImageDisplayUrl,
  snapToAllowedAspectRatio,
} from "@/features/canvas/application/imageData";
import {
  captureVideoFrameBlob,
  getLodStill,
  requestLodStill,
  subscribeLodStills,
} from "@/features/canvas/application/videoFrameCapture";
import {
  FALLBACK_VIDEO_ASPECT_OPTIONS,
  FALLBACK_VIDEO_RESOLUTION_OPTIONS,
} from "@/features/canvas/domain/mediaModelOptions";
import { ensureWebSafeVideo } from "@/features/canvas/application/videoTranscode";
import { isVideoFile, VIDEO_FILE_ACCEPT } from "@/features/canvas/application/videoFileTypes";
import { localizeNodeDisplayName } from "@/features/canvas/domain/nodeDisplay";
import { toast } from "sonner";
import { downloadUrlAsFile } from "@/lib/browserDownload";
import { useModelTaskAccess } from "@/lib/model-task-access";
import {
  setAlbumPendingTotal,
  useAlbumPendingTotal,
} from "@/features/canvas/nodes/shared/albumPendingTotals";
import { canvasEventBus } from "@/features/canvas/application/canvasServices";
import { useExternalFileHandoff } from "@/features/canvas/hooks/useExternalFileHandoff";
import {
  extractUpstreamContent,
  joinUpstreamText,
} from "@/features/canvas/application/graphContentResolver";
import { useUpstreamNodes } from "@/features/canvas/application/useUpstreamGraph";
import {
  sortUpstreamByReferenceOrder,
  upstreamNodesInEdgeOrder,
} from "@/features/canvas/nodes/referenceOrdering";
import { useReferenceMentionSync } from "@/features/canvas/nodes/useReferenceMentionSync";
import { useNodeGenerationTaskState } from "@/features/canvas/application/useNodeGenerationTaskState";
import {
  resolveErrorContent,
  showErrorDialog,
  notifyTaskStillRunning,
} from "@/features/canvas/application/errorDialog";
import {
  BillingRuleNotConfiguredError,
  backendErrorToastMessage,
} from "@/lib/api-errors";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { resolveGenerationErrorDiagnostics } from "@/features/canvas/application/generationErrorReport";
import {
  NodeHeader,
  NODE_HEADER_FLOATING_POSITION_CLASS,
} from "@/features/canvas/ui/NodeHeader";
import { NodeResizeHandle } from "@/features/canvas/ui/NodeResizeHandle";
import { NODE_OPS_PANEL_ENTER_CLASS } from "@/features/canvas/ui/OperationPanelShell";
import { NodeGenerationOverlay } from "@/features/canvas/ui/NodeGenerationOverlay";
import {
  CANVAS_NODE_INPUT_BODY_FRAME_CLASS,
  CANVAS_NODE_INPUT_BODY_SELECTED_FRAME_CLASS,
  CANVAS_NODE_INPUT_SURFACE_CLASS,
  CANVAS_NODE_OPS_PANEL_CLASS,
  CANVAS_NODE_PANEL_SURFACE_CLASS,
  CANVAS_NODE_TOOLBAR_PILL_CLASS,
  canvasNodeFrameClass,
} from "@/features/canvas/ui/nodeFrameStyles";
import {
  hasMainlineContexts,
  NodeContextBadges,
} from "@/features/freezone/context/NodeContextBadges";
import { RegenerateButton } from "@/features/canvas/ui/RegenerateButton";
import {
  NODE_CREDIT_PILL_FLAT_CLASS,
  NODE_GENERATE_BUTTON_BASE_CLASS,
  NODE_GENERATE_BUTTON_DISABLED_CLASS,
  NODE_GENERATE_BUTTON_ENABLED_CLASS,
} from "@/features/canvas/ui/nodeControlStyles";
import {
  NODE_SIDE_ACTION_BUTTON_CLASS,
  NODE_SIDE_ACTION_ICON_CLASS,
  NodeSideActionRail,
} from "@/features/canvas/ui/NodeSideActionRail";
import { VideoClipPanel } from "@/features/canvas/nodes/VideoClipPanel";
import {
  submitVideoUpscale,
  VIDEO_UPSCALE_RESOLUTIONS,
} from "@/features/canvas/application/videoUpscale";
import {
  CAMERA_MOVEMENT_PRESETS,
  findCameraMovementPreset,
  type CameraMovementPreset,
} from "@/features/canvas/domain/cameraMovementPresets";
import { useFreezoneVideoCameraTemplates } from "@/features/canvas/hooks/useFreezoneVideoCameraTemplates";
import { useFreezoneVideoModels } from "@/features/canvas/hooks/useFreezoneVideoModels";
import { useCanvasStore, useIsBoxSelecting } from "@/stores/canvasStore";
import { ReferenceValidationDialog, referenceDurationIssues, referenceIssues, matchesReference, referenceIssueName, type ReferenceIssue } from "./shared/ReferenceValidationDialog";
import {
  fetchFreezoneJobResult,
  submitFreezoneVideoCompose,
  submitFreezoneVideoErase,
  submitFreezoneVideoEdit,
  submitFreezoneVideoExtend,
  submitFreezoneVideoGen,
  submitFreezoneVideoI2v,
  submitFreezoneVideoKeyframes,
  submitFreezoneVideoOmniGen,
  uploadFreezoneImage,
  uploadFreezoneVideo,
  type FreezoneJobRef,
  type FreezoneVideoAspectRatio,
  type FreezoneVideoReferenceItem,
  type FreezoneVideoResolution,
  type FreezoneVideoUpscaleResolution,
} from "@/api/ops";
import {
  awaitTaskCompletion,
  isTaskCancelledError,
  isTaskPollTimeoutError,
} from "@/api/tasks";
import { generationTaskDescriptor } from "@/features/canvas/application/resumeGeneration";
import { useNodeGenerationHistory } from "@/features/canvas/hooks/useNodeGenerationHistory";
import {
  NodeGenerationHistory,
  hasCompletedHistoryRecords,
  historyRecordOutputUrl,
} from "@/features/canvas/ui/NodeGenerationHistory";
import type { FreezoneGenerationHistoryRecord } from "@/api/ops";
import { readUrl } from "@/lib/url-params";
import type { ModelOption } from "@/features/canvas/ui/ProviderModelPicker";
import { CreditCostPill } from "@/components/credits/credit-visual";
import { VideoOperationsPanel } from "@/features/canvas/nodes/VideoOperationsPanel";

type VideoNodeProps = NodeProps & {
  id: string;
  data: VideoNodeData;
  selected?: boolean;
};

const DEFAULT_WIDTH = 580;
export const DEFAULT_HEIGHT = 380;
/**
 * Billing feature key for video generation. Shared by the body (billing probe for error-state retry) and the operations panel (estimate
 * display + submit disabling); they must use the same basis — exported from the body, imported by the panel.
 */
export const VIDEO_GENERATE_FEATURE_KEY = "freezone.video_generate";

const MIN_WIDTH = 480;
const MIN_HEIGHT = 280;
const MAX_WIDTH = 1100;
const MAX_HEIGHT = 1000;

// Default landing size of image nodes (aligned with ImageGenNode's DEFAULT_WIDTH/HEIGHT).
// "All reference / image reference" creates an image node to the left of the video node, and the layout must use its real size.
const IMAGE_GEN_NODE_WIDTH = 580;
const IMAGE_GEN_NODE_HEIGHT = 360;

// Same as for the image node: once the reference-asset row lands, the writable height of the prompt gets squeezed small, so add a bit upward.
export const OPERATIONS_PANEL_HEIGHT = 328;
export const OPERATIONS_PANEL_GAP = 12;
// Extend the ops panel beyond the node's left/right edges so the textarea +
// chips have more room than the video frame itself.
export const OPERATIONS_PANEL_OVERHANG = 120;

// Icon + copy of the empty-state CTA: which modes are shown is decided by `videoEmptyStateCtaModes(modelId)`
// by model capability (see shared/videoModelCapabilities.ts); this only handles "mode → appearance".
const VIDEO_EMPTY_STATE_CTA_META: Record<
  VideoEmptyStateCtaMode,
  { Icon: LucideIcon; labelKey: string }
> = {
  allReference: { Icon: Sparkles, labelKey: "node.videoNode.cta.allReference" },
  imageReference: { Icon: Images, labelKey: "node.videoNode.cta.imageReference" },
  firstFrame: { Icon: Film, labelKey: "node.videoNode.cta.firstFrame" },
  imageToVideo: { Icon: Film, labelKey: "node.videoNode.cta.imageToVideo" },
  firstLastFrame: { Icon: Layers, labelKey: "node.videoNode.cta.firstLastFrame" },
};

// Hard upper limit of upstream reference counts per genMode. The UI uses this table to express the backend field constraints (multi-image / multimodal
// scenarios) explicitly: over-limit chips are grayed out and removed from the @ candidates, avoiding "the prompt references
// @image10 but it is silently dropped on submit".
//
// Modes absent from the table are unlimited by default (textToVideo consumes no upstream) and take the original path.
//   - allReference (omni)  : image 1-9 / video 0-3 / audio 0-3. Audio has two more vendor duration
//                            constraints — **per item** 1.8~15.2s and **total** ≤15.2s (admin-configurable
//                            referenceAudioTotalMaxSeconds) — both validated separately before submit,
//                            see audioReferenceDurationRejection. The duration basis does not enter this table:
//                            it only expresses counts.
//   - videoEdit            : by default 1 source video + 5 reference images; standalone audio is off by default and opens
//                            up to that limit once the media catalog configures referenceAudioMax > 0.
//   - firstLastFrame       : only 2 images (first frame + last frame), no video / audio allowed.
//                            With images >2 there is another fallback that auto-switches to allReference (see the
//                            effect inside VideoNode).
//   - firstFrame / imageToVideo: both accept only 1 image; the former locks the first frame, the latter serves as an overall picture reference.
const REFERENCE_CAPS_BY_MODE: Partial<
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

// Fallback tiers used when the admin "Media models" config gives the model no ratio / resolution. On the normal path both
// come from the catalog entry's ratioOptions / resolutionOptions.
export const ASPECT_RATIOS: ReadonlyArray<FreezoneVideoAspectRatio> =
  FALLBACK_VIDEO_ASPECT_OPTIONS;
const QUALITIES: ReadonlyArray<VideoGenQuality> = FALLBACK_VIDEO_RESOLUTION_OPTIONS;
const SCENE_OPTIMIZE_OPTIONS: ReadonlyArray<Seedance2SceneOptimize> = ["anime", "realistic"];
const DEFAULT_DURATION_MIN = 5;
const DEFAULT_DURATION_MAX = 15;

export function qualityToResolution(q: VideoGenQuality): FreezoneVideoResolution {
  return q;
}

function videoQualityOptionsForModel(
  model: { resolutionOptions?: string[] } | null | undefined,
): readonly VideoGenQuality[] {
  const options = (model?.resolutionOptions ?? []).map((item) => item.trim()).filter(Boolean);
  return options.length > 0 ? options : QUALITIES;
}

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

function videoDurationBoundsForModel(
  model: { minDuration?: number | null; maxDuration?: number | null } | null | undefined,
): { min: number; max: number } {
  const min = Number(model?.minDuration);
  const max = Number(model?.maxDuration);
  const resolvedMin = Number.isFinite(min) && min > 0 ? min : DEFAULT_DURATION_MIN;
  const resolvedMax = Number.isFinite(max) && max >= resolvedMin ? max : DEFAULT_DURATION_MAX;
  return { min: resolvedMin, max: resolvedMax };
}

export function clampVideoDuration(value: number, bounds: { min: number; max: number }): number {
  return Math.min(Math.max(Math.round(value), bounds.min), bounds.max);
}

// An audio node's durationMs is lazily loaded (written only after the waveform player mounts and reads metadata); a just-uploaded
// audio node never rendered may be null. Before submit, probe the real duration with a temporary <audio> as a fallback;
// if probing fails (CORS/network etc.) it returns null and does not block submission, leaving the backend to handle it.
function probeMediaDurationMs(url: string, media: "audio" | "video"): Promise<number | null> {
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

function isSeedance2ValueModel(modelId: string | null | undefined): boolean {
  const normalized = String(modelId ?? "").trim().toLowerCase();
  return normalized === "newapi_seedance-2.0-value" ||
    normalized === "newapi_seedance-2.0-fast-value" ||
    normalized === "huimeng_seedance-2.0-value" ||
    normalized === "huimeng_seedance-2.0-fast-value";
}

// Model capability checks (isHappyHorseVideoModel / isSeedance1xVideoModel /
// isSeedance2VideoModel / isGrokVideoChannelModel / isVideoModeSupportedByModel)
// are converged in nodes/shared/videoModelCapabilities.ts as the single source of truth for CTA / tabs / submit validation;
// here we only additionally layer the per-mode asset caps declared by the media catalog.

function selectedVideoModelReferenceDisabledReason(
  model: ModelOption | null | undefined,
  counts: { images: number; videos: number; audios: number },
  mode: VideoGenMode,
  t: TFunction,
): string | null {
  const capabilityReason = videoModelReferenceDisabledReason(model, counts);
  if (capabilityReason) return t(capabilityReason);
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

// The single image of first frame and single-image image-to-video is **structural**, not model capacity.
// So this does not accept an override by the media catalog's referenceImageMax — that field expresses "how many reference images
// this model can take at most", governing reference-style modes; letting it override here would allow config to quietly turn a first frame into a reference.
const FIXED_IMAGE_CAP_BY_MODE: Partial<Record<VideoGenMode, number>> = {
  firstFrame: 1,
  imageToVideo: 1,
};

function referenceCapsForMode(
  model: ModelOption | null | undefined,
  mode: VideoGenMode,
): { image: number; video: number; audio: number } | null {
  const defaults = REFERENCE_CAPS_BY_MODE[mode];
  if (!defaults) return null;
  if (mode === "videoExtend") return defaults;
  return {
    image: FIXED_IMAGE_CAP_BY_MODE[mode] ?? model?.referenceImageMax ?? defaults.image,
    video: model?.referenceVideoMax ?? defaults.video,
    audio: model?.referenceAudioMax ?? defaults.audio,
  };
}

function hasConfiguredReferenceCaps(model: ModelOption | null | undefined): boolean {
  return (
    model?.referenceImageMax != null ||
    model?.referenceVideoMax != null ||
    model?.referenceAudioMax != null
  );
}

function referenceFileExtension(value: string): string {
  try {
    const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    const pathname = new URL(value, origin).pathname;
    return pathname.split(".").pop()?.toLowerCase() ?? "";
  } catch {
    return "";
  }
}

function isValidReferenceLink(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      Boolean(parsed.hostname) &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
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

function referenceImageUrl(node: CanvasNode | undefined | null): string | null {
  if (!node) return null;
  if (isImageGenNode(node)) {
    const data = node.data;
    // The "reference image" an imageGen node uploads for generation is written to data.referenceImageUrl;
    // until the imageGen node has its own result it is the image the node presents,
    // so a video node should treat it as an upstream image reference as well.
    const ref =
      typeof data.referenceImageUrl === "string" &&
      data.referenceImageUrl.length > 0
        ? data.referenceImageUrl
        : null;
    return data.previewImageUrl || data.imageUrl || ref;
  }
  if (
    isUploadNode(node) ||
    isImageEditNode(node) ||
    isExportImageNode(node) ||
    isStoryboardGenNode(node)
  ) {
    const data = node.data;
    return data.previewImageUrl || data.imageUrl || null;
  }
  return null;
}

// Upstream "video references": a video node carries its own videoUrl, but a video picked from the asset library is an upload node
// whose address is likewise stored in data.videoUrl. So "is this a video upstream" should be decided by
// "a non-empty data.videoUrl exists", not by node type — otherwise library videos are missed (HappyHorse does not auto-switch to videoEdit,
// submission finds no videoUrl), and they get mistaken for images by referenceImageUrl / isUploadNode.
function referenceVideoUrl(node: CanvasNode | undefined | null): string | null {
  if (!node) return null;
  const url = (node.data as { videoUrl?: unknown }).videoUrl;
  return typeof url === "string" && url.length > 0 ? url : null;
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

function resolveDroppedVideoFile(event: DragEvent<HTMLElement>): File | null {
  const directFile = event.dataTransfer.files?.[0];
  if (directFile && isVideoFile(directFile)) {
    return directFile;
  }
  // items[].type is likewise an empty string for .mxf, so first a coarse MIME filter to get the File, then the extension as a fallback.
  const candidates = Array.from(event.dataTransfer.items || []).filter(
    (candidate) => candidate.kind === "file",
  );
  for (const candidate of candidates) {
    const file = candidate.getAsFile();
    if (file && isVideoFile(file)) return file;
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

export const VideoNode = memo(
  ({ id, data, selected, width, height }: VideoNodeProps) => {
    const { t } = useTranslation();
    const updateNodeInternals = useUpdateNodeInternals();
    const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
    const [referenceErrors, setReferenceErrors] = useState<ReferenceIssue[]>([]);
    const [referenceErrorsOpen, setReferenceErrorsOpen] = useState(false);
    const isBoxSelecting = useIsBoxSelecting();
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);
    const addDerivedUploadNode = useCanvasStore(
      (state) => state.addDerivedUploadNode,
    );
    const addNode = useCanvasStore((state) => state.addNode);
    const addEdge = useCanvasStore((state) => state.addEdge);
    const addEdgeWithData = useCanvasStore((state) => state.addEdgeWithData);
    const setActiveOverlayNodeId = useCanvasStore(
      (state) => state.setActiveOverlayNodeId,
    );
    const inputRef = useRef<HTMLInputElement>(null);
    // In-flight guard: held until all concurrent tasks of this batch allSettle (see handleSubmit).
    const submittingRef = useRef(false);
    // Mirror the actual <video> element into state so VideoPlayerControls can
    // re-subscribe to events on mount/unmount (a ref alone does not trigger a re-render). Also keep a writable
    // ref for non-React paths (such as capture frame) to keep using .current.
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
    const setVideoRef = useCallback((el: HTMLVideoElement | null) => {
      videoRef.current = el;
      setVideoEl(el);
    }, []);

    // Low-zoom tier: the selector returns a boolean and triggers a re-render only once when crossing the threshold; during panning
    // transform[0]/[1] change every frame but the return value here does not, so there is no per-frame re-render.
    const lowDetailZoom = useStore((state) => isLowDetailZoom(state.transform[2]));
    // Do not downgrade while playing — the user playing it means they are watching, so do not pull the player away even when zoomed out.
    const isVideoPlayingRef = useRef(false);
    // On unmount clear the module-level playing flag: when viewport culling unmounts a playing node the <video> does not dispatch
    // a pause event, and without clearing a stale "playing" exemption would remain and this node would never downgrade again.
    useEffect(() => () => setNodeMediaActive(id, false), [id]);
    const transientUrlRef = useRef<string | null>(null);
    const [transientPreviewUrl, setTransientPreviewUrl] = useState<
      string | null
    >(null);
    const [isCapturingFrame, setIsCapturingFrame] = useState(false);
    const [isComposingClip, setIsComposingClip] = useState(false);
    const [clipError, setClipError] = useState<string | null>(null);

    // Per-node generation history: fetched only when the node is selected, avoiding every video node on the canvas each sending one
    // request. After generation completes call refreshHistory to pull in the new record.
    const {
      records: historyRecords,
      isLoading: historyLoading,
      refresh: refreshHistory,
    } = useNodeGenerationHistory(id, { enabled: Boolean(selected) });

    // While generating, clicking a history record goes through a "non-destructive preview": it does not overwrite videoUrl or interrupt the in-flight
    // task, and only temporarily shows this history video on the body (see the isGenerating render branch). After the new video
    // finishes, the effect below clears it automatically, returning to the latest result. It is also cleared when history is restored in the non-generating state.
    const [historyPreviewUrl, setHistoryPreviewUrl] = useState<string | null>(
      null,
    );

    const prompt = typeof data.prompt === "string" ? data.prompt : "";
    const genMode: VideoGenMode = data.genMode ?? "textToVideo";
    // Billing and submission must inspect the same one-hop inputs. Keeping the
    // subscription here also lets the displayed quote react when a source
    // video's browser-probed duration becomes available.
    const upstreamNodes = useUpstreamNodes(id);
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
    const followsInputAspectRatio = videoModeForcesAutomaticAspectRatio(genMode);
    // The aspect of keyframe/video-edit follows the input assets; it only changes this request's value and does not overwrite the ratio saved on the node.
    // Other modes submit as is when the Admin config exists, and keep the old auto-derivation logic when it is not configured.
    const submitAspectRatio: FreezoneVideoAspectRatio =
      followsInputAspectRatio
        ? "auto"
        : !hasConfiguredAspectRatios && aspectRatio === "auto"
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
    // Missing catalog fields preserve the legacy behavior: native audio is
    // supported and enabled by default. Admin can explicitly disable support,
    // in which case the control disappears and every submit path sends false.
    const supportsGenerateAudio =
      videoModelSupportsGenerateAudio(selectedVideoModel);
    const defaultGenerateAudio =
      videoModelDefaultGenerateAudio(selectedVideoModel);
    const generateAudio =
      supportsGenerateAudio &&
      (typeof data.generateAudio === "boolean"
        ? data.generateAudio
        : defaultGenerateAudio);
    // Family checks must be fed `selectedVideoModelId` (apiModel ?? id), **not `modelId`**:
    // `modelId` is `selectedVideoModel.id`, which in EE is the ULID primary key of media_model_catalog
    // (such as `01KZ58VSE52RFFDASY2T9SY4NC`) and contains no model name at all, so the check is always false —
    // even after choosing Seedance 2.0 it would be blocked by "All reference only supports Seedance 2.0", and video/audio upstreams
    // would no longer auto-switch the mode. The CE fallback list happens to have id === apiModel, so this trap shows only in EE.
    const isSeedance20Model = isSeedance2VideoModel(selectedVideoModelId);
    const supportsAllReference = isVideoModeSupportedByModel(
      "allReference",
      selectedVideoModel,
    );
    const supportsVideoEdit = isVideoModeSupportedByModel(
      "videoEdit",
      selectedVideoModel,
    );
    const supportsVideoExtend = isVideoModeSupportedByModel(
      "videoExtend",
      selectedVideoModel,
    );
    const videoEditAcceptsAudio =
      supportsVideoEdit &&
      (referenceCapsForMode(selectedVideoModel, "videoEdit")?.audio ?? 0) > 0;
    const supportsHumanReview = selectedVideoModel?.humanReview === true;
    const humanReview = Boolean(data.humanReview);
    const count: VideoGenCount = (data.count ?? 1) as VideoGenCount;
    const videoInputBilling = useMemo(() => {
      if (
        genMode !== "allReference" &&
        genMode !== "videoEdit" &&
        genMode !== "videoExtend"
      ) {
        return { present: false, ready: true, durationSeconds: 0 };
      }
      const ordered = sortUpstreamByReferenceOrder(
        upstreamNodes,
        data.referenceOrder,
      ).filter((node) => Boolean(referenceVideoUrl(node)));
      const limit =
        genMode === "videoEdit" || genMode === "videoExtend"
          ? 1
          : (selectedVideoModel?.referenceVideoMax ?? 3);
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
    const { isGenerating } = useNodeGenerationTaskState(data);
    const generationError =
      typeof data.generationError === 'string' ? data.generationError.trim() : '';
    // Only treat as a failure-state once generation has stopped and produced no
    // video — a stale error must never hide a successfully generated clip.
    const hasGenerationError =
      !isGenerating && !data.videoUrl && generationError.length > 0;
    const generationErrorRequestId =
      typeof data.generationErrorRequestId === "string" && data.generationErrorRequestId
        ? data.generationErrorRequestId
        : "";

    // After generation ends (success/failure), clear the temporary history preview so the body returns to the latest result.
    useEffect(() => {
      if (!isGenerating) setHistoryPreviewUrl(null);
    }, [isGenerating]);

    const handleRestoreHistory = useCallback(
      (record: FreezoneGenerationHistoryRecord) => {
        const url = historyRecordOutputUrl(record);
        if (!url) return;
        // While generating: only a non-destructive preview, never touching videoUrl and never interrupting the in-flight task.
        if (isGenerating) {
          setHistoryPreviewUrl(url);
          return;
        }
        setHistoryPreviewUrl(null);
        updateNodeData(id, {
          videoUrl: url,
          isGenerating: false,
          generationStartedAt: null,
          sourceFileName: null,
          generationError: null,
          generationErrorDetails: null,
          generationErrorRequestId: null,
          // When restoring a single history result the old batch album is already detached from the main video — clear it as well.
          generationBatch: null,
        });
      },
      [id, isGenerating, updateNodeData],
    );

    // ------ upstream reference images ----------------------------------------
    // Anything connected via target → this video node that has an image url
    // shows up as a thumbnail chip next to the camera/role/marker chips. Ordered
    // by connection order (later-referenced after earlier), with manual
    // referenceOrder taking precedence — see sortUpstreamByReferenceOrder.
    // Subscribe to ONLY this node's one-hop upstream (not the whole nodes array)
    // so dragging unrelated nodes doesn't re-render this node. See useUpstreamGraph.
    // Once the node is connected (has incoming edges): hide the "Try" CTA and show only an icon in the middle of the node (aligned with libtv).
    const isConnected = useCanvasStore((state) =>
      state.edges.some((edge) => edge.target === id)
    );
    const referenceImages = useMemo(() => {
      const upstream = sortUpstreamByReferenceOrder(
        upstreamNodes,
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
    }, [upstreamNodes, data.referenceOrder]);

    // Unified "image / video / audio" upstream reference entries, for the chips row. The order follows the connection order
    // (in sync with referenceImages), so chip numbers 1/2/3... match the visual order.
    // Text upstreams do not enter this row — the "@text chip" is already rendered separately above.
    const referenceMedia = useMemo<ReferenceMediaItem[]>(() => {
      const upstream = sortUpstreamByReferenceOrder(
        upstreamNodes,
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
    }, [upstreamNodes, data.referenceOrder]);

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
        // These three prefixes are the **protocol** of reference tokens like `@image1` in the prompt, sent to the backend
        // as is, not UI copy — translating them would make them stop matching.
        { prefix: "image", ids: orderedImageIds },
        { prefix: "video", ids: orderedVideoIds },
        { prefix: "audio", ids: orderedAudioIds },
      ],
      applyPromptRemap,
    );

    const referenceCaps = useMemo(
      () => referenceCapsForMode(selectedVideoModel, genMode),
      [genMode, selectedVideoModel],
    );

    // Generic upstream traversal: get a unified view of text/imageUrl/videoUrl/audioUrl of all upstream nodes.
    // Video generation uses only the text field to prepend to the prompt; image/video/audio still go through
    // the classification logic already in their own branches (with backend limit validation).
    const upstreamContents = useMemo(
      () => upstreamNodes.map(extractUpstreamContent),
      [upstreamNodes],
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
      for (const node of upstreamNodes) {
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
    }, [upstreamNodes]);
    // HappyHorse mode availability is decided by the "upstream node type", not by whether the asset is filled in. An empty image
    // node (not yet generated/uploaded) should also make "first frame / image reference" selectable — connecting the node first and filling the image
    // later is the normal order. So counts here are by node type, unlike the "resolved URL" basis of upstreamCounts.
    const upstreamTypeCounts = useMemo(() => {
      let images = 0;
      let videos = 0;
      let audios = 0;
      for (const node of upstreamNodes) {
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
    }, [upstreamNodes]);
    const isClipMode = Boolean(data.isClipMode);
    const clipStartMs =
      typeof data.clipStartMs === "number" ? data.clipStartMs : null;
    const clipEndMs =
      typeof data.clipEndMs === "number" ? data.clipEndMs : null;
    const durationMs =
      typeof data.durationMs === "number" ? data.durationMs : null;

    const resolvedTitle = useMemo(
      () => localizeNodeDisplayName(CANVAS_NODE_TYPES.video, data, t),
      [data, t],
    );
    const resolvedWidth = Math.max(
      MIN_WIDTH,
      Math.round(width ?? DEFAULT_WIDTH),
    );
    const resolvedHeight = Math.max(
      MIN_HEIGHT,
      Math.round(height ?? DEFAULT_HEIGHT),
    );
    // The collapsed floating panel has a fixed base size; enlarge uses a centered dialog (see OperationPanelShell below).
    const [panelExpanded, setPanelExpanded] = useState(false);
    const panelHeight = OPERATIONS_PANEL_HEIGHT;
    const panelOverhang = OPERATIONS_PANEL_OVERHANG;

    // ── Stacked-card album (a group of generated results with count > 1, isomorphic with the image node) ──
    // When collapsed, N-1 card edges peek out behind the main video; on hover a count badge appears at the top right, and clicking it expands into a
    // grid album. In the expanded state clicking a video sets it as the main video, and it can be individually "applied to canvas" / downloaded.
    const albumRootRef = useRef<HTMLDivElement | null>(null);
    const albumPointerDownPosRef = useRef<{ x: number; y: number } | null>(null);
    const [albumExpanded, setAlbumExpanded] = useState(false);
    // The "expected count" within this session — unfinished ones hold a place in the album. Stored in a module-level registry rather than component
    // state: under onlyRenderVisibleElements panning out of the viewport unmounts the component and state is lost.
    const albumPendingTotal = useAlbumPendingTotal(id);
    const albumUrls = useMemo(() => {
      const raw = data.generationBatch;
      if (!Array.isArray(raw)) return [];
      return raw.filter((u): u is string => typeof u === 'string' && u.length > 0);
    }, [data.generationBatch]);
    const albumTotalSlots = Math.max(albumUrls.length, albumPendingTotal);
    const albumPendingCount = Math.max(0, albumPendingTotal - albumUrls.length);
    const hasAlbum = albumTotalSlots > 1;

    // While the album is expanded, register as this node's activeOverlay: the external action toolbar / replace-asset
    // handle / + derive button all defer to it (and it holds even when a drag re-selects).
    useEffect(() => {
      if (!albumExpanded) return;
      setActiveOverlayNodeId(id);
      return () => {
        if (useCanvasStore.getState().activeOverlayNodeId === id) {
          setActiveOverlayNodeId(null);
        }
      };
    }, [albumExpanded, id, setActiveOverlayNodeId]);

    useEffect(() => {
      if (!albumExpanded) return;
      const handlePointerDown = (event: PointerEvent) => {
        if (albumRootRef.current?.contains(event.target as Node)) return;
        setAlbumExpanded(false);
      };
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') setAlbumExpanded(false);
      };
      window.addEventListener('pointerdown', handlePointerDown);
      window.addEventListener('keydown', handleKeyDown);
      return () => {
        window.removeEventListener('pointerdown', handlePointerDown);
        window.removeEventListener('keydown', handleKeyDown);
      };
    }, [albumExpanded]);

    const handleSetAlbumMainVideo = useCallback(
      (url: string) => {
        updateNodeData(id, { videoUrl: url, sourceFileName: null });
        setAlbumExpanded(false);
      },
      [id, updateNodeData],
    );

    // Deactivate the node when the album expands; React Flow's own selected flag must be cleared through onNodesChange
    // (clearing only the store's selectedNodeId would be written back by the selection sync effect).
    // The side effect goes outside the setState updater: the updater must be pure (StrictMode calls it twice).
    const handleToggleAlbumExpanded = useCallback(() => {
      if (!albumExpanded) {
        const store = useCanvasStore.getState();
        const selectionChanges = store.nodes
          .filter((node) => node.selected)
          .map((node) => ({ id: node.id, type: 'select' as const, selected: false }));
        if (selectionChanges.length > 0) {
          store.onNodesChange(selectionChanges);
        }
        setSelectedNode(null);
        // Reset the "apply to canvas" drop cursor on every expansion.
        albumAppliedCountRef.current = 0;
      }
      setAlbumExpanded(!albumExpanded);
    }, [albumExpanded, setSelectedNode]);

    // "Apply to canvas": place this video as an independent video node to the right of the expanded grid. Successive applications'
    // drop points are staggered so they do not stack exactly on the same coordinates with only the last visible.
    const albumAppliedCountRef = useRef(0);
    const handleApplyAlbumVideoToCanvas = useCallback(
      (url: string) => {
        const self = useCanvasStore.getState().nodes.find((n) => n.id === id);
        if (!self) return;
        const applyIndex = albumAppliedCountRef.current;
        albumAppliedCountRef.current += 1;
        const position = {
          x: self.position.x + resolvedWidth * 2 + 12 + 48 + applyIndex * 36,
          y: self.position.y + applyIndex * 36,
        };
        const newNodeId = addNode(CANVAS_NODE_TYPES.video, position, {
          videoUrl: url,
          aspectRatio: data.aspectRatio,
          user_spawned: true,
        } as Partial<VideoNodeData>);
        setSelectedNode(newNodeId);
      },
      [addNode, data.aspectRatio, id, resolvedWidth, setSelectedNode],
    );

    const handleDownloadAlbumVideo = useCallback(
      async (url: string, index: number) => {
        try {
          await downloadUrlAsFile(resolveImageDisplayUrl(url), `video-gen-${id}-${index + 1}.mp4`);
        } catch (error) {
          console.error('[video-node] album download failed', error);
        }
      },
      [id],
    );

    const clearTransientPreview = useCallback(() => {
      if (transientUrlRef.current) {
        URL.revokeObjectURL(transientUrlRef.current);
        transientUrlRef.current = null;
      }
      setTransientPreviewUrl(null);
    }, []);

    const processFile = useCallback(
      async (file: File) => {
        if (!isVideoFile(file)) return;
        const projectId = readUrl().project;
        if (!projectId) {
          console.error("[video-node] no project in URL");
          return;
        }
        clearTransientPreview();
        const previewUrl = URL.createObjectURL(file);
        transientUrlRef.current = previewUrl;
        setTransientPreviewUrl(previewUrl);
        updateNodeData(id, { sourceFileName: file.name, isUploading: true });
        try {
          // Web-incompatible codecs such as HEVC (Feishu screen recordings / iPhone) are first transcoded to H.264 in the browser before upload,
          // otherwise browsers like Edge without the matching decoder get sound but no picture. See videoTranscode.ts.
          // During transcoding the UI uniformly shows the "uploading" loading, without a separate transcoding progress.
          const prepared = await ensureWebSafeVideo(file);
          if (prepared.transcoded) {
            // The source codec may not be decodable in this browser at all (Edge+HEVC), so the local preview is also swapped to the transcoded output.
            clearTransientPreview();
            const preparedUrl = URL.createObjectURL(prepared.file);
            transientUrlRef.current = preparedUrl;
            setTransientPreviewUrl(preparedUrl);
          }
          const uploaded = await uploadFreezoneVideo(
            projectId,
            prepared.file,
            prepared.file.name,
          );
          updateNodeData(id, {
            videoUrl: uploaded.url,
            previewImageUrl: null,
            sourceFileName: file.name,
            isUploading: false,
          });
        } catch (error) {
          console.error("[video-node] upload failed", error);
          updateNodeData(id, { isUploading: false });
          clearTransientPreview();
        }
      },
      [clearTransientPreview, id, updateNodeData],
    );

    const handleFileChange = useCallback(
      async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) await processFile(file);
        event.target.value = "";
      },
      [processFile],
    );

    const handleDrop = useCallback(
      async (event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        event.stopPropagation();
        const file = resolveDroppedVideoFile(event);
        if (file) await processFile(file);
      },
      [processFile],
    );

    const handleDragOver = useCallback((event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
    }, []);

    const handleUploadClick = useCallback(() => {
      inputRef.current?.click();
    }, []);

    // Spawn the source node(s) to the left of this video node and wire them as
    // inputs. Used by the empty-state All reference / Image reference / First-last-frame CTAs.
    // All reference / image reference go through an image node (can upload or directly generate an image) + the matching reference mode;
    // first-last-frame goes through two upload nodes + firstLastFrame keyframes.
    const spawnFrameUploads = useCallback(
      (
        mode:
          | "allReference"
          | "imageReference"
          | "firstFrame"
          | "imageToVideo"
          | "firstLastFrame",
      ) => {
        const state = useCanvasStore.getState();
        const self = state.nodes.find((n) => n.id === id);
        if (!self) return;
        // Vertical centering must use the video node's real height: prefer the measured value, and fall back to the set height/default when unmeasured.
        const selfHeight =
          self.measured?.height ??
          (typeof self.height === "number" ? self.height : DEFAULT_HEIGHT);
        // All reference / image reference / first-frame-to-video lay out only one image node; first-last-frame lays out a first frame + last frame
        // two upload nodes.
        const isSingleImage =
          mode === "allReference" ||
          mode === "imageReference" ||
          mode === "firstFrame" ||
          mode === "imageToVideo";
        // The two source node kinds have different default sizes (image node 580×360 / upload node 320×350),
        // and the left column's positioning and avoidance must use the actual sizes, otherwise the image node would overlap the video node.
        const FRAME_WIDTH = isSingleImage ? IMAGE_GEN_NODE_WIDTH : 320;
        const FRAME_HEIGHT = isSingleImage ? IMAGE_GEN_NODE_HEIGHT : 350;
        const GAP_X = 40;
        const GAP_Y = 24;
        const baseX = self.position.x - FRAME_WIDTH - GAP_X;
        const stepY = FRAME_HEIGHT + GAP_Y;
        const nodeSize = (node: CanvasNode) => ({
          width:
            node.measured?.width ??
            (typeof node.width === "number" ? node.width : FRAME_WIDTH),
          height:
            node.measured?.height ??
            (typeof node.height === "number" ? node.height : FRAME_HEIGHT),
        });
        const overlaps = (
          a: { x: number; y: number; width: number; height: number },
          b: { x: number; y: number; width: number; height: number },
        ) => {
          const margin = 12;
          return (
            a.x < b.x + b.width + margin &&
            a.x + a.width + margin > b.x &&
            a.y < b.y + b.height + margin &&
            a.y + a.height + margin > b.y
          );
        };
        const occupiedRects = state.nodes
          .filter((node) => node.id !== self.id)
          .map((node) => {
            const size = nodeSize(node);
            return {
              x: node.position.x,
              y: node.position.y,
              width: size.width,
              height: size.height,
            };
          });
        const upstreamIds = new Set(
          state.edges.filter((edge) => edge.target === id).map((edge) => edge.source),
        );
        const frameColumnNodes = state.nodes.filter((node) => {
          if (!upstreamIds.has(node.id)) return false;
          if (
            node.type !== CANVAS_NODE_TYPES.upload &&
            node.type !== CANVAS_NODE_TYPES.imageGen
          ) {
            return false;
          }
          return Math.abs(node.position.x - baseX) < 8;
        });
        const lastFrameColumnY = frameColumnNodes.reduce<number | null>(
          (maxY, node) => (maxY === null ? node.position.y : Math.max(maxY, node.position.y)),
          null,
        );
        const resolveAvailableY = (preferredY: number) => {
          let y =
            lastFrameColumnY === null
              ? preferredY
              : Math.max(preferredY, lastFrameColumnY + stepY);
          for (let attempt = 0; attempt < 40; attempt += 1) {
            const candidate = { x: baseX, y, width: FRAME_WIDTH, height: FRAME_HEIGHT };
            if (!occupiedRects.some((rect) => overlaps(candidate, rect))) {
              occupiedRects.push(candidate);
              return y;
            }
            y += stepY;
          }
          occupiedRects.push({ x: baseX, y, width: FRAME_WIDTH, height: FRAME_HEIGHT });
          return y;
        };
        if (isSingleImage) {
          // Center vertically directly on the video height, with no downward avoidance. resolveAvailableY only pushes downward,
          // and once the left space is occupied by other nodes it would push the reference image down a row and break alignment with the video (exactly
          // the cause of "all reference vs image reference misaligned"). Alignment takes priority here: the reference image is always on
          // the left of the video (with a GAP_X gap) and never overlaps the video itself; if it collides with an unrelated node on the left, we would rather let
          // the user move it away by hand than sacrifice alignment with the video.
          const baseY = self.position.y + (selfHeight - FRAME_HEIGHT) / 2;
          const newId = addNode(
            CANVAS_NODE_TYPES.imageGen,
            { x: baseX, y: baseY },
            {
              displayName: t(
                mode === "firstFrame"
                  ? "node.videoNode.spawn.firstFrame"
                  : "node.videoNode.spawn.referenceImage",
              ),
            },
          );
          if (mode === "firstFrame") {
            addEdgeWithData(newId, id, { keyframeSlot: "first" });
          } else {
            addEdge(newId, id);
          }
          const groupLabel = t(
            mode === "imageReference"
              ? "node.videoNode.spawn.imageReferenceGroup"
              : mode === "firstFrame"
                ? "node.videoNode.spawn.firstFrameGroup"
                : mode === "imageToVideo"
                  ? "node.videoNode.spawn.imageToVideoGroup"
                  : "node.videoNode.spawn.allReferenceGroup",
          );
          state.autoGroupSpawn(id, [newId], { label: groupLabel });
          // Upstream images feed the matching endpoint directly as assets; the mode switches to the one the user clicked, with no prompt prefilled
          // (respecting what the user already wrote). Under HappyHorse the unified state machine confirms (imageToVideo /
          // imageReference both match "1 upstream image" and are not rewritten); under non-HappyHorse
          // once data.genMode is non-empty the default-inference effect no longer overrides it.
          updateNodeData(id, { genMode: mode });
          return;
        }
        const totalH = FRAME_HEIGHT * 2 + GAP_Y;
        const startY = self.position.y + (selfHeight - totalH) / 2;
        const firstY = resolveAvailableY(startY);
        const lastY = resolveAvailableY(firstY + stepY);
        const firstId = addNode(
          CANVAS_NODE_TYPES.upload,
          { x: baseX, y: firstY },
          { displayName: t("node.videoNode.spawn.firstFrame") },
        );
        addEdgeWithData(firstId, id, { keyframeSlot: "first" });
        const lastId = addNode(
          CANVAS_NODE_TYPES.upload,
          { x: baseX, y: lastY },
          { displayName: t("node.videoNode.spawn.lastFrame") },
        );
        addEdgeWithData(lastId, id, { keyframeSlot: "last" });
        state.autoGroupSpawn(id, [firstId, lastId], {
          label: t('node.videoNode.spawn.firstLastFrameGroup'),
        });
        updateNodeData(id, { genMode: "firstLastFrame" });
      },
      [addEdge, addEdgeWithData, addNode, id, updateNodeData],
    );

    useEffect(() => {
      return canvasEventBus.subscribe("video-node/reupload", ({ nodeId }) => {
        if (nodeId !== id) return;
        inputRef.current?.click();
      });
    }, [id]);

    const consumeExternalFile = useCallback(
      (file: File) => {
        // By this point the file has already been taken from staging; returning directly would be dropping it on the floor —
        // leave a warning, do not be silent. The wording follows `[upload-node] …` of UploadNode.tsx.
        if (!isVideoFile(file)) {
          console.warn(
            `[video-node] external file "${file.name}" (${file.type || "no mime"}) is not a video; dropped`,
          );
          return;
        }
        void processFile(file);
      },
      [processFile],
    );
    // The File itself is staged in pendingExternalFiles and delivered on mount — at low zoom this node first mounts as an
    // LOD shell, and subscribing to events alone would miss the handoff (see useExternalFileHandoff).
    useExternalFileHandoff("video-node/external-file", id, consumeExternalFile);

    // First time an upstream image becomes available, flip the gen mode so the
    // video actually consumes it. The default mode is chosen by model capability (videoUpstreamImageDefaultMode):
    // Seedance 2.0 → all reference (the general entry for 1-9 images; first-last-frame is still reachable via the empty-state CTA);
    // Seedance 1.x → first frame (1.x does not support all reference, and defaulting to it would make submit certainly 400).
    // A fallback only when data.genMode is undefined — once the user has chosen any tab, their choice is respected.
    // HappyHorse goes through the unified state machine below and does not take part in this default.
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
      selectedVideoModel,
      updateNodeData,
    ]);

    // HappyHorse's mode is entirely decided by the upstream node type (the 4 major functions of the docs map one to one); here a
    // unified state machine replaces scattered fallback effects, avoiding several effects fighting each other:
    //   - upstream has video       → video edit (videoEdit / video_url)
    //   - upstream images >1       → image reference (imageReference / reference_images 1-9)
    //   - upstream images == 1     → pick the single-image default entry by catalog capability, and respect the user's
    //                                explicit choice of first frame / image-to-video / image reference
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
        const currentImageMode = ["firstFrame", "imageToVideo", "imageReference"].includes(
          genMode,
        )
          ? genMode
          : null;
        target =
          currentImageMode && isVideoModeSupportedByModel(currentImageMode, selectedVideoModel)
            ? currentImageMode
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
      selectedVideoModel,
      upstreamTypeCounts.images,
      upstreamTypeCounts.videos,
      updateNodeData,
    ]);

    // Audio references are consumed by all reference; after the media catalog explicitly configures an audio limit for video_edit, video edit
    // can consume them too. Other modes still discard audio, so when audio is first connected, switch to allReference. Tracked
    // through a ref so we only fire on the 0 → ≥1 transition; once the user
    // disconnects all audio and reconnects, it fires again.
    // Whether audio can be consumed is decided by the media catalog's all_reference capability; models that do not declare it are
    // blocked by the model selector, and allReference is not forced here so as not to push into a mode where submit is certain to 400.
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
        !(data.genMode === "videoEdit" && videoEditAcceptsAudio) &&
        !isHappyHorseModel &&
        supportsAllReference
      ) {
        updateNodeData(id, { genMode: "allReference" });
      }
    }, [
      data.genMode,
      hasAudioUpstream,
      id,
      isHappyHorseModel,
      supportsAllReference,
      updateNodeData,
      videoEditAcceptsAudio,
    ]);

    // Seedance 1.x cannot take video / audio, and staying on it would only yield a submission that certainly fails. When the user connects a
    // video or audio node, that is clear intent, so switch them straight to Seedance 2.0 + all reference.
    // The check uses upstreamTypeCounts (by node type): an empty video node counts too — connecting the node first and generating later
    // is the normal order, and switching the model after it gets a URL would be too late (the user would see a 1.x in between that should not appear).
    // Model and mode must be written in one patch: two steps would first render the intermediate state "2.0 + image-to-video",
    // then get corrected once more by the videos→allReference effect below, flashing for a frame for nothing.
    //
    // Trigger only on the one transition "none → has video/audio", **it must not correct unconditionally on every render**:
    // updateNodeData pushSnapshot every time and clears future (canvasStore); if it kept correcting,
    // after the user presses ⌘Z to restore 1.x while the edge is still there, the effect would immediately write 2.0 back and push another past —
    // undo would look like it does nothing, and the redo stack would be cleared, blocking the path of "going back to before the connection". And what is changed
    // is the model, a value the user explicitly picked, so overriding silently and irreversibly is far heavier than genMode.
    // The one-shot trigger cannot be bypassed either: while the asset is present the selector already grays out 1.x, so it cannot be switched back.
    // It uses the same latch as the audio → allReference effect right above.
    const autoSwitchedForMediaRef = useRef(false);
    useEffect(() => {
      // All judgments (loading state, latch, whether to switch, to whom) live in videoReferenceAutoSwitchAction;
      // here we only change the ref and send the patch — that side is a pure function, so async loading timing can be tested.
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
      const nextModel = availableVideoModels.find(
        (model) => model.id === action.modelId,
      );
      updateNodeData(id, {
        model: action.modelId,
        genMode: action.genMode,
        generateAudio: videoModelDefaultGenerateAudio(nextModel),
      });
      // Deliberately do not call writeLastVideoModel: this is a rescue on the user's behalf, not a preference they expressed, and it should not also
      // change the default model inherited by video nodes created later.
    }, [
      availableVideoModels,
      id,
      selectedVideoModelId,
      updateNodeData,
      upstreamTypeCounts,
      videoModelsLoading,
    ]);

    // When video material is connected upstream, all reference, video edit and video extend can all consume it; other modes discard the video.
    // When already in a legitimate explicit video task, do not force allReference again.
    // Unlike the audio "0→≥1 transition", this corrects every time, ensuring the mode cannot be switched away while a video is present.
    // Whether video can be consumed is decided by the media catalog's all_reference capability; models that do not declare it are not forced,
    // so as not to push into a mode where submit is certain to 400.
    useEffect(() => {
      if (upstreamCounts.videos === 0) return;
      if (isHappyHorseModel) return;
      if (genMode === "videoEdit" && supportsVideoEdit) return;
      if (genMode === "videoExtend" && supportsVideoExtend) return;
      if (!supportsAllReference) return;
      if (genMode === "allReference") return;
      updateNodeData(id, { genMode: "allReference" });
    }, [
      upstreamCounts.videos,
      genMode,
      id,
      isHappyHorseModel,
      supportsAllReference,
      supportsVideoEdit,
      supportsVideoExtend,
      updateNodeData,
    ]);

    // Text-to-video accepts no asset references. Even if the user first manually picked textToVideo and then connected
    // images/audio (the two auto-switch effects above both bail because genMode is already explicit),
    // it must be forced away, otherwise it stays on textToVideo and discards the connected assets.
    // With images → pick the default by model capability (2.0 all reference / 1.x first frame); audio only (only Seedance 2.0
    // can consume it) → all reference; audio is unavailable for non-2.0, blocked by the model selector, and not forced here.
    useEffect(() => {
      if (isHappyHorseModel) return;
      if (genMode !== "textToVideo") return;
      if (upstreamCounts.images === 0 && upstreamCounts.audios === 0) return;
      if (upstreamCounts.images > 0) {
        const defaultMode = videoUpstreamImageDefaultMode(selectedVideoModel);
        if (defaultMode) updateNodeData(id, { genMode: defaultMode });
      } else if (supportsAllReference) {
        updateNodeData(id, { genMode: "allReference" });
      }
    }, [
      genMode,
      isHappyHorseModel,
      supportsAllReference,
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
      if (!supportsAllReference) return;
      updateNodeData(id, { genMode: "allReference" });
    }, [
      genMode,
      isHappyHorseModel,
      supportsAllReference,
      upstreamCounts.images,
      id,
      updateNodeData,
    ]);

    // "First-frame-to-video" carries only one image. The i2v endpoint dispatches by image count (1 = image-to-video,
    // 2-9 = image reference); after a second image is connected what it does is actually image reference, yet the mode still stays on
    // first frame — so steer the mode straight to what it is really doing: all reference / image reference.
    // Same kind of fallback as the first-last-frame >2 images one above, corrected every time (no one-shot latch),
    // so the user is not stuck on first frame in a multi-image state and silently truncated to one image on submit.
    // Which one to switch to and which cases must not be touched are all collected in videoMultiImageAutoSwitchMode.
    useEffect(() => {
      const target = videoMultiImageAutoSwitchMode(
        genMode,
        selectedVideoModel ?? selectedVideoModelId,
        upstreamCounts.images,
      );
      if (!target || target === genMode) return;
      updateNodeData(id, { genMode: target });
    }, [
      genMode,
      selectedVideoModel,
      selectedVideoModelId,
      upstreamCounts.images,
      id,
      updateNodeData,
    ]);

    // The mode derivations above are all **one-directional**: when an asset connects they push the mode to the one that can consume it, but
    // none is responsible for pushing the mode back once the assets are emptied. So after "connect an image → remove the image again" the node is stuck on
    // all reference: the UI looks fine, yet submit is silently blocked by handleSubmit's references.length === 0,
    // and the user sees "typed something, clicked send, nothing happened". The reverse tier is added here —
    // no upstream assets at all = text-to-video, the same rule as HappyHorse's unified state machine "no upstream → text-to-video".
    //
    // Use upstreamTypeCounts (by node type) rather than upstreamCounts (resolved URLs): the empty-state CTA
    // first lays out an image/upload node that has no image yet and then switches the mode; by the URL basis that instant is 0 images, and this one would
    // push it straight back to text-to-video. Same reason as the comment of videoNoUpstreamResetMode.
    //
    // recordHistory: false — this is the **derived result** of the user's "delete the asset" step, not an independent
    // user change. If it pushed past as usual, ⌘Z would only undo the mode back to "no assets + all reference", this effect would immediately
    // change it back and clear the redo stack, undo would look like it does nothing and could never return to before the connection (the cause is in the comment of the
    // model auto-rescue effect above). Without recording history, ⌘Z returns straight to "has image + all reference", and the forward effect
    // sees the asset still present and no longer rewrites it.
    useEffect(() => {
      if (isHappyHorseModel) return;
      const target = videoNoUpstreamResetMode(genMode, upstreamTypeCounts);
      if (!target) return;
      updateNodeData(id, { genMode: target }, { recordHistory: false });
    }, [
      genMode,
      isHappyHorseModel,
      upstreamTypeCounts,
      id,
      updateNodeData,
    ]);

    useEffect(
      () => () => {
        clearTransientPreview();
      },
      [clearTransientPreview],
    );

    const videoSource = useMemo(() => {
      if (data.videoUrl) return resolveImageDisplayUrl(data.videoUrl);
      if (transientPreviewUrl) return transientPreviewUrl;
      return null;
    }, [data.videoUrl, transientPreviewUrl]);

    // Preview-only src: preload="metadata" does not paint any frame and there is no poster, so on the canvas
    // it is a pure black box (the video itself is fine, and downloading shows it). Append the `#t=0.1` media fragment so the browser
    // seeks to 0.1s and paints that frame as the cover — consistent with the thumbnail usage in NodeGenerationHistory /
    // CanvasHistoryAssetsModal. Used for display only; does not affect download/frame capture/playback.
    const videoPosterSource = useMemo(() => {
      if (!videoSource) return null;
      return videoSource.includes("#t=") ? videoSource : `${videoSource}#t=0.1`;
    }, [videoSource]);

    // The static thumbnail needed at the low-zoom tier, via an off-screen <video> + CORS frame capture (see videoFrameCapture).
    // Queued when the node mounts, rather than starting only after zooming out: at the low-zoom tier the canvas mounts no
    // <video> at all, and capturing only then would leave the user staring at a screen of placeholder blocks; also, if the first-paint viewport is restored at a low-zoom tier,
    // the display <video> is never mounted even once and the capture opportunity never comes.
    useEffect(() => {
      requestLodStill(videoSource);
    }, [videoSource]);

    // Subscribe to the module-level cache: after the node is mounted/unmounted repeatedly by onlyRenderVisibleElements the thumbnail
    // is still there and used right after remount. The snapshot is a primitive value, rendering once before and once after the capture, not re-rendering every frame.
    const lodStill = useSyncExternalStore(subscribeLodStills, () =>
      getLodStill(videoSource)
    );

    useEffect(() => {
      updateNodeInternals(id);
    }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

    const [hasMetadata, setHasMetadata] = useState(false);
    const [videoLoadError, setVideoLoadError] = useState(false);
    useEffect(() => {
      setHasMetadata(false);
      setVideoLoadError(false);
    }, [videoSource]);

    // ---- subtitle erase mode (libtv-style smart subtitle removal) ------------------------
    const subtitleEraseMode = data.subtitleEraseMode ?? null;
    const subtitleEraseBox = data.subtitleEraseBox ?? null;
    const [isErasing, setIsErasing] = useState(false);
    // Transient drag state — null when not currently dragging.
    const [eraseDrag, setEraseDrag] = useState<{
      x0: number;
      y0: number;
      x1: number;
      y1: number;
    } | null>(null);

    /**
     * Compute the displayed video frame rect inside its container (object-contain).
     * Returns container-pixel coords. We use this to (a) size the box overlay so
     * it sits on top of the actual video pixels (not the letterbox bars) and (b)
     * convert pointer coords ↔ normalized 0..1 source coords.
     */
    const getDisplayedVideoRect = useCallback(
      (containerW: number, containerH: number) => {
        const vw = data.widthPx ?? 0;
        const vh = data.heightPx ?? 0;
        if (!vw || !vh || containerW <= 0 || containerH <= 0) {
          return { left: 0, top: 0, width: containerW, height: containerH };
        }
        const containerRatio = containerW / containerH;
        const videoRatio = vw / vh;
        if (videoRatio > containerRatio) {
          const w = containerW;
          const h = containerW / videoRatio;
          return { left: 0, top: (containerH - h) / 2, width: w, height: h };
        }
        const h = containerH;
        const w = containerH * videoRatio;
        return { left: (containerW - w) / 2, top: 0, width: w, height: h };
      },
      [data.heightPx, data.widthPx],
    );

    const handleEraseExit = useCallback(() => {
      updateNodeData(id, { subtitleEraseMode: null, subtitleEraseBox: null });
      setEraseDrag(null);
    }, [id, updateNodeData]);

    const handleClipSubmit = useCallback(
      async (startMs: number, endMs: number) => {
        if (isComposingClip) return;
        const sourceUrl = data.videoUrl;
        if (!sourceUrl) return;
        if (endMs <= startMs) return;
        const projectId = readUrl().project;
        if (!projectId) {
          console.error("[video-node] clip: no project in URL");
          return;
        }
        // Compose only supports 720p / 1080p — fall back to 720p for 480P sources.
        const composeResolution = quality.toLowerCase() === "1080p" ? "1080p" : "720p";
        setIsComposingClip(true);
        setClipError(null);
        try {
          const sourceStart = startMs / 1000;
          const sourceEnd = endMs / 1000;
          const ref = await submitFreezoneVideoCompose(projectId, {
            resolution: composeResolution,
            tracks: [
              {
                trackId: `track_${id}_video`,
                kind: "video",
                items: [
                  {
                    itemId: `item_${id}_${Date.now()}`,
                    sourceUrl,
                    timelineStart: 0,
                    sourceStart,
                    sourceEnd,
                  },
                ],
              },
            ],
          });
          await awaitTaskCompletion(ref.task_key, projectId, {
            taskType: ref.task_type,
          });
          const result = await fetchFreezoneJobResult(
            projectId,
            "freezone_video_compose",
            ref.job_id,
          );
          if (result.url) {
            const state = useCanvasStore.getState();
            const position = state.findNodePosition(
              id,
              DEFAULT_WIDTH,
              DEFAULT_HEIGHT,
            );
            const newNodeId = addNode(CANVAS_NODE_TYPES.video, position, {
              videoUrl: result.url,
              durationMs: Math.round((sourceEnd - sourceStart) * 1000),
              displayName: t("node.videoNode.clip.displayName"),
            });
            addEdge(id, newNodeId);
            updateNodeData(id, {
              isClipMode: false,
              clipStartMs: null,
              clipEndMs: null,
            });
          } else {
            console.warn("[video-node] compose completed without url", result);
            setClipError(t("node.videoNode.clip.noUrl"));
          }
        } catch (error) {
          console.error("[video-node] clip compose failed", error);
          setClipError(error instanceof Error ? error.message : String(error));
        } finally {
          setIsComposingClip(false);
        }
      },
      [
        addEdge,
        addNode,
        data.videoUrl,
        id,
        isComposingClip,
        quality,
        updateNodeData,
      ],
    );

    const handleEraseSubmit = useCallback(async () => {
      if (isErasing) return;
      if (!data.videoUrl) return;
      if (subtitleEraseMode === "box" && !subtitleEraseBox) return;
      const projectId = readUrl().project;
      if (!projectId) {
        console.error("[video-node] no project in URL");
        return;
      }
      setIsErasing(true);
      try {
        const ref = await submitFreezoneVideoErase(projectId, {
          sourceUrl: data.videoUrl,
          mode: subtitleEraseMode === "box" ? "box" : "smart_subtitle",
          box: subtitleEraseMode === "box" ? subtitleEraseBox : null,
        });
        await awaitTaskCompletion(ref.task_key, projectId, {
          taskType: ref.task_type,
        });
        const result = await fetchFreezoneJobResult(
          projectId,
          "freezone_video_erase",
          ref.job_id,
        );
        if (result.url) {
          updateNodeData(id, {
            videoUrl: result.url,
            subtitleEraseMode: null,
            subtitleEraseBox: null,
          });
        } else {
          console.warn("[video-node] erase completed without url", result);
        }
      } catch (error) {
        console.error("[video-node] subtitle erase failed", error);
      } finally {
        setIsErasing(false);
      }
    }, [
      data.videoUrl,
      id,
      isErasing,
      subtitleEraseBox,
      subtitleEraseMode,
      updateNodeData,
    ]);

    // Submit availability differs by mode (aligned with each backend endpoint's validation); prompt and assets are judged **separately**:
    // - Prompt: text-to-video / all reference strongly validate the prompt on the backend, so one must exist (self-written or upstream text); first frame /
    //   image-to-video / image reference / first-last-frame / video edit allow an empty prompt — this fixes the problem of "after deleting the default prompt
    //   a first frame is passed yet generation still cannot start directly".
    // - Assets: required except for text-to-video (image modes need ≥1 upstream image; video edit needs ≥1 upstream video;
    //   all reference needs ≥1 of any of image/video/audio) — aligned with the empty-asset early returns in each handleSubmit branch.
    // All reference is the only mode that needs both, so this cannot be written as "if it needs a prompt, only look at the prompt".
    const hasPromptText =
      prompt.trim().length > 0 || upstreamTextJoined.length > 0;
    const hasRequiredMediaForMode =
      genMode === "videoEdit" || genMode === "videoExtend"
        ? upstreamCounts.videos > 0
        : genMode === "allReference"
          ? upstreamCounts.images + upstreamCounts.videos + upstreamCounts.audios > 0 ||
            Boolean(data.referenceFileUrl || data.referenceLink?.trim())
          : upstreamCounts.images > 0;
    // Pre-submit guard: when the current model/mode cannot consume the connected assets (video/audio silently dropped, multi-image on non-2.0 non-
    // HappyHorse gets a backend 400), give the reason and disable submit, replacing silently dropping assets / a submit 400.
    const mediaRejectionReasonKey = videoSubmitMediaRejectionReason(
      genMode,
      selectedVideoModel,
      upstreamCounts,
    );
    const mediaRejectionReason = mediaRejectionReasonKey
      ? t(mediaRejectionReasonKey)
      : null;
    const upstreamReferenceError = selectedVideoModelReferenceDisabledReason(
      selectedVideoModel,
      upstreamCounts,
      genMode,
      t,
    );
    const selectedModelReferenceError = (() => {
      if (upstreamReferenceError || genMode !== "allReference") return upstreamReferenceError;
      const fileUrl = data.referenceFileUrl?.trim() ?? "";
      const link = data.referenceLink?.trim() ?? "";
      if (fileUrl && link) return t("node.videoNode.referenceDocument.fileLinkConflict");
      if (fileUrl && (selectedVideoModel?.referenceFileMax ?? 0) < 1) {
        return t("node.videoNode.referenceDocument.fileUnsupported");
      }
      if (link && (selectedVideoModel?.referenceLinkMax ?? 0) < 1) {
        return t("node.videoNode.referenceDocument.linkUnsupported");
      }
      if (link && !isValidReferenceLink(link)) {
        return t("node.videoNode.referenceDocument.invalidLink");
      }
      const allowedTypes = selectedVideoModel?.referenceFileTypes ?? [];
      if (
        fileUrl &&
        allowedTypes.length > 0 &&
        !allowedTypes.includes(referenceFileExtension(fileUrl))
      ) {
        return t("node.videoNode.referenceDocument.unsupportedType", {
          types: allowedTypes.join(", "),
        });
      }
      return null;
    })();
    // Billing gate for error-state retry. After the estimate chain moved down into the operations panel (mounted only when selected, no request when unselected),
    // the failure state's RegenerateButton became the only entry that can submit even when unselected — if the body did not intercept,
    // retry would let through a request doomed to be rejected by the backend when billing rules are not configured. Here a one-off enabled only in the error state is used
    // estimate probe is added back to intercept: when value is null the hook sends no request, so an unselected node with no error still has
    // zero estimate overhead; when the error state and the panel are active together, params are identical and the query shares the key, deduped by react-query.
    const retryBillingProbe = useGenerationCreditCost(
      "feature",
      hasGenerationError && videoBackendForCost && videoInputBilling.ready
        ? VIDEO_GENERATE_FEATURE_KEY
        : null,
      {
        surface: "canvas",
        params: {
          ...(selectedVideoModel?.catalogId
            ? { catalog_id: selectedVideoModel.catalogId }
            : {}),
          video_backend: videoBackendForCost,
          resolution: qualityToResolution(quality),
          pricing_quantity:
            Math.min(Math.max(count, 1), 4) *
            (genMode === "videoEdit"
              ? Math.max(Math.floor(videoInputBilling.durationSeconds), 1)
              : durationSec),
          operation: genMode,
          generate_audio: generateAudio,
          video_input_present: videoInputBilling.present,
          input_video_duration_seconds: videoInputBilling.durationSeconds,
        },
        quantity: Math.min(Math.max(count, 1), 4),
      },
    );
    const videoBillingRuleMissing =
      retryBillingProbe.error instanceof BillingRuleNotConfiguredError;
    const modelTaskAccess = useModelTaskAccess();
    const submitDisabled =
      isGenerating ||
      videoBillingRuleMissing ||
      modelTaskAccess.blocked ||
      !selectedVideoModel ||
      selectedModelReferenceError !== null ||
      mediaRejectionReason != null ||
      // Prompt and assets are **two parallel** requirements, not either-or: all reference needs both (the backend strongly validates
      // the prompt, and the omni endpoint has no assets to send). When written as a ternary, all reference looked only at the prompt, and once assets were emptied the
      // button stayed clickable, and clicking it was silently blocked by handleSubmit's references.length === 0.
      (videoModeRequiresPrompt(genMode) && !hasPromptText) ||
      (videoModeRequiresMedia(genMode) && !hasRequiredMediaForMode);

    const handleSubmit = useCallback(async () => {
      if (submitDisabled) return;
      // In-flight guard (consistent with ImageGenNode): the first completion clears isGenerating,
      // and submitDisabled cannot stop "resubmitting while N-1 tasks of the old batch are still running" — the old closure
      // would overwrite the new batch's generationBatch with stale completedUrls.
      if (submittingRef.current) return;
      submittingRef.current = true;
      setReferenceErrors([]);
      setReferenceErrorsOpen(false);
      try {
      const projectId = readUrl().project;
      if (!projectId) {
        console.error("[video-node] no project in URL");
        return;
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
        const composedPrompt = await compileWorkflowNodePrompt({
          nodeId: id,
          nodeData: data,
          nodeKind: "video",
          nodePrompt: trimmedPrompt,
          upstreamText: upstreamTextJoined,
          upstreamContents,
          fallbackPrompt,
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
          return sortUpstreamByReferenceOrder(
            upstreamNodesInEdgeOrder(state.nodes, state.edges, id),
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
            legacyDisplayName?: string | null;
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
              legacyDisplayName:
                typeof node.data.displayName === "string" ? node.data.displayName : null,
            });
          }
          return resolveVideoKeyframeUrls(candidates);
        };

        const validateReferenceDurations = async (
          media: "audio" | "video",
          refs: Array<{ url: string; label: string; durationMs: number | null; nodeId: string }>,
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
              url: ref.url,
              nodeId: ref.nodeId,
              index: index + 1,
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
          if (!rejection) return true;

          setReferenceErrors(referenceDurationIssues(media, rejection, limits));
          setReferenceErrorsOpen(true);
          updateNodeData(id, {
            isGenerating: false,
            generationStartedAt: null,
            generationError: t("referenceValidation.title"),
            generationErrorDetails: null,
            generationErrorRequestId: null,
          });
          return false;
        };

        const durationClamped = clampVideoDuration(durationSec, durationBounds);
        const cameraTemplateId = cameraMovementId;
        // The backend records each node's generation history by canvas_id + node_id. With multiple generations each
        // sibling node uses its own targetId as node_id, so history lands on the matching node separately.
        const canvasId = readUrl().canvas ?? "default";

        // The backend no longer supports producing several at once; instead it calls the endpoint N times concurrently by "generation count". First
        // assemble a "call the endpoint once" closure doSubmit by genMode; if validation fails it is set to empty and returns early.
        let doSubmit: ((targetId: string) => Promise<FreezoneJobRef>) | null = null;
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
            return;
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
            return;
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
          // Video edit: 1 source video, with reference images and standalone reference audio attached per the media catalog limits.
          // No longer HappyHorse-only — every model that declares video_edit in the catalog takes this path.
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
            return;
          }
          const allImageUrls = collectUpstreamImageUrls();
          const imageLimit = referenceCaps?.image ?? 5;
          if (allImageUrls.length > imageLimit) {
            toast.warning(
              t("node.videoNode.videoEdit.imageLimit", {
                limit: imageLimit,
                ignored: allImageUrls.length - imageLimit,
              }),
            );
          }
          const imageUrls = allImageUrls.slice(0, imageLimit);
          const audioLimit = referenceCaps?.audio ?? 0;
          const audioRefs = upstream
            .filter(isAudioNode)
            .map((node, index) => {
              const url =
                typeof node.data.audioUrl === "string" ? node.data.audioUrl : "";
              const rawLabel =
                (typeof node.data.sourceFileName === "string"
                  ? node.data.sourceFileName
                  : "") ||
                (typeof node.data.displayName === "string"
                  ? node.data.displayName
                  : "");
              return {
                url,
                nodeId: node.id,
                label:
                  rawLabel ||
                  t("node.videoNode.audio.clipFallbackLabel", { index: index + 1 }),
                durationMs:
                  typeof node.data.durationMs === "number"
                    ? node.data.durationMs
                    : null,
              };
            })
            .filter((item) => item.url.length > 0)
            .slice(0, audioLimit);
          if (!(await validateReferenceDurations("audio", audioRefs))) return;
          doSubmit = (targetId) =>
            submitFreezoneVideoEdit(projectId, {
              videoUrl,
              imageUrls,
              audioUrls: audioRefs.map((item) => item.url),
              prompt: composedPrompt,
              cameraTemplateId,
              resolution: qualityToResolution(quality),
              audioSetting: "auto",
              generateAudio,
              model: selectedVideoModel?.catalogId ?? modelId,
              genMode,
              modelParams: data.modelParams,
              humanReview: supportsHumanReview && humanReview,
              canvasId,
              nodeId: targetId,
            });
        } else if (genMode === "videoExtend") {
          const upstream = collectUpstream();
          const videoUrl =
            upstream
              .map((node) => referenceVideoUrl(node) ?? "")
              .find((url) => url.length > 0) ?? "";
          if (!videoUrl) {
            console.warn("[video-node] videoExtend submit without upstream video");
            updateNodeData(id, {
              isGenerating: false,
              generationStartedAt: null,
            });
            return;
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
              modelParams: data.modelParams,
              humanReview: supportsHumanReview && humanReview,
              canvasId,
              nodeId: targetId,
            });
        } else if (genMode === "allReference") {
          // Whether all reference is available is decided by the media catalog's supportedModes. This guard in front gives
          // a readable hint, preventing a leftover mode after switching models from hitting an unsupported endpoint.
          if (!supportsAllReference) {
            void showErrorDialog(
              t(
                isHappyHorseModel
                  ? "node.videoNode.allReference.happyHorseUnsupported"
                  : "node.videoNode.allReference.modelUnsupported",
              ),
              t("common.error"),
            );
            updateNodeData(id, {
              isGenerating: false,
              generationStartedAt: null,
            });
            return;
          }
          // Omni-gen: classify each upstream node by its media type.
          const caps = referenceCaps ?? { image: 9, video: 3, audio: 3 };
          const totalReferenceLimit = hasConfiguredReferenceCaps(selectedVideoModel)
            ? caps.image + caps.video + caps.audio
            : 12;
          const upstream = collectUpstream();
          const references: FreezoneVideoReferenceItem[] = [];
          // Corresponds one to one with the items in references where type==="audio", used to validate each audio duration before submit.
          const audioRefs: {
            url: string;
            label: string;
            durationMs: number | null;
            nodeId: string;
          }[] = [];
          const videoRefs: {
            url: string;
            label: string;
            durationMs: number | null;
            nodeId: string;
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
                  nodeId: node.id,
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
                  role: "soundtrack_reference", // references[].role is a protocol field sent to the backend
                  label: rawLabel,
                });
                audioRefs.push({
                  url,
                  nodeId: node.id,
                  // When a duration limit is exceeded we must name which one, so the label is kept here too; those without a file name
                  // (direct TTS output etc.) fall back to "Audio N". The index counts by the audio itself 1-based, on the same basis as the backend
                  // pipeline.py enumerate(audio_paths, start=1); the label itself
                  // only enters the hint copy and is not sent to the backend with references, so it follows the UI language.
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
          if (data.referenceFileUrl?.trim()) {
            references.push({
              type: "file",
              url: data.referenceFileUrl.trim(),
              role: "file_reference", // Same as above, a protocol field
              label: data.referenceFileName ?? "",
            });
          } else if (data.referenceLink?.trim()) {
            references.push({
              type: "link",
              url: data.referenceLink.trim(),
              role: "web_reference", // Same as above, a protocol field
            });
          }
          if (references.length === 0) {
            console.warn("[video-node] omni-gen submit without any reference");
            updateNodeData(id, {
              isGenerating: false,
              generationStartedAt: null,
            });
            return;
          }
          if (!(await validateReferenceDurations("audio", audioRefs))) return;
          if (!(await validateReferenceDurations("video", videoRefs))) return;
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

        const referenceSnapshot = collectUpstream();
        if (!doSubmit) {
          updateNodeData(id, { isGenerating: false, generationStartedAt: null });
          return;
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
            const completed = await awaitTaskCompletion(ref.task_key, projectId, {
              taskType: ref.task_type,
            });
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
            if (isTaskCancelledError(error)) {
              // The user is already informed in the stop confirmation: do not enter runErrors, show no error dialog, leave no error banner.
              if (runIndex === 0 && completedUrls.length === 0) {
                updateNodeData(id, { isGenerating: false, generationStartedAt: null });
              }
              return;
            }
            console.error("[video-node] video gen failed", error);
            // Record the error first and then decide whether to return early — the aggregation branch after settle relies on runErrors to judge
            // "partial failure" and show a toast; not recording before an early return would swallow failures after the first success entirely.
            runErrors.push(error);
            // When other videos of the same batch have completed (the main video has landed), do not overwrite the success state with an error —
            // a partial failure only affects the album count.
            if (completedUrls.length > 0) return;
            // A polling timeout is not a generation failure: the backend is still running. Keep isGenerating and the task handle;
            // on page refresh resumeNodeGeneration reconnects and backfills the result; writing an error here
            // banner would only mark a live task as failed and clear the resumable handle.
            if (isTaskPollTimeoutError(error)) return;
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
        // Decide the error feedback after the whole batch ends:
        //  - none succeeded → show one error dialog (including dedicated guidance for blocked real-person assets);
        //  - partially succeeded → no modal interruption, only a light toast saying how many fewer were produced.
        // This way "1 of N hits the queue limit and fails instantly while the rest run normally" no longer produces
        // the contradictory look of "a limit error pops up first, yet the node shows a loading animation".
        if (completedUrls.length === 0 && runErrors.length > 0) {
          const firstError = runErrors[0];
          const issues = referenceIssues(firstError);
          if (issues.length) {
            const upstream = referenceSnapshot;
            setReferenceErrors(issues.map((issue) => {
              const matching = upstream.filter((node) => {
                const values = [submittableImageUrl(node),
                  "audioUrl" in node.data ? node.data.audioUrl : null,
                  "videoUrl" in node.data ? node.data.videoUrl : null];
                return values.some((url) => typeof url === "string" && matchesReference(url, issue.reference_key));
              });
              const node = matching.length === 1 ? matching[0] : undefined;
              return { ...issue, nodeId: node?.id,
                label: referenceIssueName(issue, node?.data.sourceFileName) };
            }));
            setReferenceErrorsOpen(true);
            updateNodeData(id, { generationError: t("referenceValidation.title"),
              generationErrorDetails: null, generationErrorRequestId: null });
            return;
          }
          // When the whole batch is merely "the frontend stopped waiting", use a neutral hint: the backend is still generating, and the node stays in the generating
          // state awaiting refresh and resumption, and should not be presented as an error. If a real failure is mixed in it is still treated as a failure.
          if (runErrors.every((error) => isTaskPollTimeoutError(error))) {
            notifyTaskStillRunning(t);
            void refreshHistory();
            return;
          }
          const resolved = resolveErrorContent(
            firstError,
            t("node.videoNode.generation.failed"),
          );
          const displayErrorMessage = backendErrorToastMessage(firstError, t);
          const diagnostics = resolveGenerationErrorDiagnostics(firstError, resolved.details);
          const haystack = `${displayErrorMessage}\n${diagnostics.details ?? ""}`;
          if (
            haystack.includes(
              "InputImageSensitiveContentDetected.PrivateInformation",
            )
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
        void refreshHistory();
      } catch (error) {
        console.error("[video-node] video gen failed", error);
        // Failures before any run starts (e.g. Recipe compilation) must land on
        // the node too, or the workflow runner only sees "no videoUrl".
        updateNodeData(id, {
          isGenerating: false,
          generationStartedAt: null,
          generationError: backendErrorToastMessage(error, t),
        });
        setAlbumPendingTotal(id, 0);
      }
      } finally {
        submittingRef.current = false;
      }
    }, [
      aspectRatio,
      submitAspectRatio,
      cameraMovementId,
      cameraMovementPreset,
      count,
      data.modelParams,
      data.referenceFileName,
      data.referenceFileUrl,
      data.referenceLink,
      data.referenceOrder,
      durationBounds,
      durationSec,
      generateAudio,
      genMode,
      humanReview,
      id,
      isSeedance20Model,
      supportsAllReference,
      supportsHumanReview,
      modelId,
      prompt,
      quality,
      refreshHistory,
      sceneOptimize,
      submitDisabled,
      t,
      updateNodeData,
      upstreamTextJoined,
      upstreamContents,
    ]);

    useEffect(() => {
      return subscribeNodeAction(({ nodeId, action, executionMode, requestId }) => {
        if (nodeId !== id || action !== "generate_video") return;
        publishNodeActionAccepted(requestId, id, action);
        const latest = useCanvasStore.getState().nodes.find((node) => node.id === id);
        const latestData = isVideoNode(latest) ? latest.data : data;
        if (latestData.isUpscaleNode === true) {
          const sourceUrl =
            typeof latestData.upscaleSourceUrl === "string" ? latestData.upscaleSourceUrl : "";
          const resolution =
            typeof latestData.upscaleResolution === "string" &&
            VIDEO_UPSCALE_RESOLUTIONS.includes(
              latestData.upscaleResolution as FreezoneVideoUpscaleResolution,
            )
              ? (latestData.upscaleResolution as FreezoneVideoUpscaleResolution)
              : "1080p";
          if (!sourceUrl) {
            publishNodeActionError(requestId, id, action, new Error("Missing upscale video source"));
            return;
          }
          void submitVideoUpscale(id, { sourceUrl, resolution })
            .then(() => {
              const finished = useCanvasStore.getState().nodes.find((node) => node.id === id);
              const videoUrl =
                isVideoNode(finished) && typeof finished.data.videoUrl === "string"
                  ? finished.data.videoUrl
                  : undefined;
              publishNodeActionSuccess(requestId, id, action, {
                ...(videoUrl ? { videoUrl } : {}),
                ...(executionMode === "single" ? { submitted: true } : {}),
              });
            })
            .catch((error) => publishNodeActionError(requestId, id, action, error));
          return;
        }
        void handleSubmit()
          .then(() => {
            const finished = useCanvasStore.getState().nodes.find((node) => node.id === id);
            const videoUrl =
              isVideoNode(finished) && typeof finished.data.videoUrl === "string"
                ? finished.data.videoUrl
                : undefined;
            publishNodeActionSuccess(requestId, id, action, {
              ...(videoUrl ? { videoUrl } : {}),
              ...(executionMode === "single" ? { submitted: true } : {}),
            });
          })
          .catch((error) => publishNodeActionError(requestId, id, action, error));
      });
    }, [data, handleSubmit, id]);

    const hasMainlineContext = hasMainlineContexts(
      (data as { mainline_context?: unknown }).mainline_context,
    );

    const cardToneClass = canvasNodeFrameClass({
      selected,
      mainline: hasMainlineContext,
    });

    const isUploading = Boolean(data.isUploading);
    const isEmptyVideoBody = !videoSource && !isUploading && !isGenerating && !hasGenerationError;
    const bodySurfaceClass = isEmptyVideoBody
      ? CANVAS_NODE_INPUT_SURFACE_CLASS
      : CANVAS_NODE_PANEL_SURFACE_CLASS;
    const bodyFrameClass = isEmptyVideoBody
      ? selected
        ? CANVAS_NODE_INPUT_BODY_SELECTED_FRAME_CLASS
        : CANVAS_NODE_INPUT_BODY_FRAME_CLASS
      : cardToneClass;
    const showVideoOpsPanel =
      selected &&
      !isBoxSelecting &&
      !albumExpanded &&
      !isClipMode &&
      !subtitleEraseMode &&
      !data.referenceOnly &&
      // The video upscale node uses its own VideoUpscaleEditorOverlay config panel, not the regular generation panel.
      !data.isUpscaleNode;

    const handleCaptureFrame = useCallback(
      async (mode: "first" | "last" | "current") => {
        if (isCapturingFrame) return;
        if (!data.videoUrl) return;
        const projectId = readUrl().project;
        if (!projectId) {
          console.error("[video-node] no project in URL");
          return;
        }
        const src = resolveImageDisplayUrl(data.videoUrl);
        const liveEl = videoRef.current;
        const liveDuration =
          liveEl && Number.isFinite(liveEl.duration) ? liveEl.duration : null;
        const fallbackDurationSec =
          typeof data.durationMs === "number" ? data.durationMs / 1000 : null;
        const knownDuration = liveDuration ?? fallbackDurationSec;
        let seekSec = 0;
        if (mode === "first") {
          seekSec = 0;
        } else if (mode === "last") {
          seekSec =
            knownDuration != null
              ? Math.max(0, knownDuration - 0.05)
              : Number.MAX_SAFE_INTEGER;
        } else {
          seekSec =
            liveEl && Number.isFinite(liveEl.currentTime)
              ? liveEl.currentTime
              : 0;
        }

        setIsCapturingFrame(true);
        try {
          const blob = await captureVideoFrameBlob(src, seekSec);
          const filename = `frame-${mode}-${Date.now()}.png`;
          const file = new File([blob], filename, { type: "image/png" });
          const uploaded = await uploadFreezoneImage(
            projectId,
            file,
            filename,
          );
          const widthPx = data.widthPx;
          const heightPx = data.heightPx;
          const aspectForNode =
            widthPx && heightPx && widthPx > 0 && heightPx > 0
              ? `${widthPx}:${heightPx}`
              : data.aspectRatio || "16:9";
          const createdNodeId = addDerivedUploadNode(
            id,
            uploaded.url,
            aspectForNode,
            uploaded.url,
          );
          if (createdNodeId) {
            const titleKey =
              mode === "first"
                ? "node.videoNode.frame.titleFirst"
                : mode === "last"
                  ? "node.videoNode.frame.titleLast"
                  : "node.videoNode.frame.titleCurrent";
            updateNodeData(createdNodeId, { displayName: t(titleKey) });
            addEdge(id, createdNodeId);
          }
        } catch (error) {
          console.error("[video-node] frame capture failed", error);
        } finally {
          setIsCapturingFrame(false);
        }
      },
      [
        addDerivedUploadNode,
        addEdge,
        data.aspectRatio,
        data.durationMs,
        data.heightPx,
        data.videoUrl,
        data.widthPx,
        id,
        isCapturingFrame,
        t,
        updateNodeData,
      ],
    );

    return (
      <div
        ref={albumRootRef}
        className="group relative h-full w-full overflow-visible"
        style={{ width: resolvedWidth, height: resolvedHeight }}
        onClick={() => setSelectedNode(id)}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        <ReferenceValidationDialog issues={referenceErrors} open={referenceErrorsOpen} onClose={() => setReferenceErrorsOpen(false)} />
        {referenceErrors.length > 0 && <button type="button" className="tap-button nodrag absolute -top-10 left-0" onClick={(event) => {
          event.stopPropagation(); setReferenceErrorsOpen(true);
        }}>{t("referenceValidation.title")}</button>}
        {/* Card edges of the stacked-card album: peeking out from the right of the main video (same as the image node); clicking a card edge also expands the album. */}
        {hasAlbum && !albumExpanded && videoSource && (
          <>
            {Array.from({ length: Math.min(albumTotalSlots - 1, 3) }, (_, index) => {
              const step = index + 1;
              return (
                <div
                  key={`album-deck-${index}`}
                  role="button"
                  tabIndex={-1}
                  title={t("node.videoNode.album.expand")}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleToggleAlbumExpanded();
                  }}
                  className="absolute cursor-pointer rounded-[var(--node-radius)] border border-white/[0.18] bg-gradient-to-b from-[#48484d] to-[#2d2d31] shadow-[0_4px_14px_rgba(0,0,0,0.4)]"
                  style={{
                    top: step * 7,
                    bottom: step * 7,
                    left: step * 6,
                    right: -step * 7,
                    transform: `rotate(${step * 1.1}deg)`,
                    transformOrigin: 'center right',
                    opacity: 1 - step * 0.18,
                  }}
                />
              );
            })}
          </>
        )}
        <Handle
          type="target"
          position={Position.Left}
          id="target"
          className="!h-2 !w-2 !border-0 !bg-[rgb(148,163,184)]"
        />
        <Handle
          type="source"
          position={Position.Right}
          id="source"
          className="!h-2 !w-2 !border-0 !bg-[rgb(148,163,184)]"
        />

        {/* Hide the floating title and resolution badge when the album expands — the album container has its own header (consistent with the image node). */}
        {!albumExpanded && (
          <>
            <NodeHeader
              className={NODE_HEADER_FLOATING_POSITION_CLASS}
              icon={<VideoIcon className="h-4 w-4" />}
              titleText={resolvedTitle}
              editable
              onTitleChange={(nextTitle) =>
                updateNodeData(id, { displayName: nextTitle })
              }
            />
            {videoSource &&
            hasMetadata &&
            !videoLoadError &&
            typeof data.widthPx === "number" &&
            typeof data.heightPx === "number" &&
            data.widthPx > 0 &&
            data.heightPx > 0 ? (
              <div
                className="absolute -top-7 right-1 z-20 flex items-center gap-1 rounded-md border border-white/10 bg-black/55 px-2 py-0.5 text-[11px] font-medium tabular-nums text-white/70 backdrop-blur-sm"
                title={t("node.videoNode.resolution")}
              >
                <VideoIcon className="h-3 w-3 text-white/45" />
                {data.widthPx}×{data.heightPx}
              </div>
            ) : null}
          </>
        )}
        <NodeContextBadges
          contexts={(data as { mainline_context?: unknown }).mainline_context}
        />

        <NodeResizeHandle
          minWidth={MIN_WIDTH}
          minHeight={MIN_HEIGHT}
          maxWidth={MAX_WIDTH}
          maxHeight={MAX_HEIGHT}
          keepAspectRatio
        />

        {!videoSource && !isUploading && !isGenerating && !data.isUpscaleNode && (
          <NodeSideActionRail nodeId={id} autoHide selected={Boolean(selected)}>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                handleUploadClick();
              }}
              className={NODE_SIDE_ACTION_BUTTON_CLASS}
              title={t("node.videoNode.clickToUpload")}
            >
              <UploadIcon className={NODE_SIDE_ACTION_ICON_CLASS} />
              <span>{t("node.videoNode.upload")}</span>
            </button>
          </NodeSideActionRail>
        )}

        <div
          className={`relative flex h-full w-full items-center justify-center ${videoSource ? "overflow-hidden" : "overflow-visible"} rounded-[var(--node-radius)] border ${bodySurfaceClass} transition-colors ${bodyFrameClass} ${
            // Hide the node body when the album expands — the translucent album container does not cover it completely, and the video underneath would show through.
            albumExpanded && hasAlbum ? "invisible" : ""
          }`}
        >
          {/* While generating/uploading show loading first: when regenerating in place videoUrl is still the previous result,
              and without this guard the old video would keep holding the place and the isGenerating branch would never be reached.
              On failure isGenerating returns to false and the old video reappears automatically (videoUrl was not cleared). */}
          {/* Low-zoom tier: <video> is replaced by a static image/placeholder block. Every <video> is an independent
              compositing layer, and their number grows linearly with the visible nodes — measured at 69 nodes / zoom 0.1,
              only downgrading together with the video layer brought the p90 frame time back from 26ms to 14ms. */}
          {!isGenerating &&
          !isUploading &&
          videoSource &&
          lowDetailZoom &&
          !isVideoPlayingRef.current ? (
            lodStill ? (
              <img
                src={lodStill}
                alt=""
                className="h-full w-full object-contain"
                draggable={false}
                onClick={() => setSelectedNode(id)}
              />
            ) : (
              <div
                className="flex h-full w-full items-center justify-center bg-black/40"
                onClick={() => setSelectedNode(id)}
              >
                <VideoIcon className="h-1/4 max-h-10 w-1/4 max-w-10 text-white/25" />
              </div>
            )
          ) : !isGenerating && !isUploading && videoSource ? (
            <video
              ref={setVideoRef}
              src={videoPosterSource ?? undefined}
              className="h-full w-full object-contain"
              playsInline
              preload="metadata"
              onPlay={() => {
                isVideoPlayingRef.current = true;
                // The shell decision lives outside the component (withLodShell) and cannot read the in-component ref,
                // so the playing state is synced into a module-level registry: a playing node is not downgraded at the low-zoom tier.
                setNodeMediaActive(id, true);
              }}
              onPause={() => {
                isVideoPlayingRef.current = false;
                setNodeMediaActive(id, false);
              }}
              onClick={() => {
                // Clicking the video body only selects the node — play/pause is handled uniformly by the bottom-left button.
                setSelectedNode(id);
              }}
              onLoadedMetadata={(event) => {
                const el = event.currentTarget;
                setHasMetadata(true);
                setVideoLoadError(false);
                if (el.videoWidth && el.videoHeight) {
                  // Record only the video's real pixels into widthPx/heightPx; do not write back aspectRatio.
                  // aspectRatio stores only the ratio preset the user picked (16:9 / auto…), otherwise
                  // the chip would show a pixel string (1248:704) and carry an illegal aspect_ratio into
                  // the next generation request.
                  const updates: Partial<VideoNodeData> = {};
                  if (data.widthPx !== el.videoWidth)
                    updates.widthPx = el.videoWidth;
                  if (data.heightPx !== el.videoHeight)
                    updates.heightPx = el.videoHeight;
                  if (data.durationMs !== Math.round(el.duration * 1000)) {
                    updates.durationMs = Math.round(el.duration * 1000);
                  }
                  if (Object.keys(updates).length > 0) {
                    updateNodeData(id, updates);
                  }
                }
              }}
              onError={() => {
                setHasMetadata(true);
                setVideoLoadError(true);
              }}
            />
          ) : isUploading ? (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-text-muted/85">
              <Loader2 className="h-7 w-7 animate-spin opacity-70" />
              <span className="px-4 text-center text-[12px] leading-6">
                {t("node.videoNode.uploading")}
              </span>
            </div>
          ) : isGenerating && historyPreviewUrl ? (
            // Generating, but the user clicked a history record preview: temporarily play that history video while the new video
            // is still generating in the background. The top pill says "Generating", and "Back" at the top right returns to loading.
            <div className="relative h-full w-full">
              <video
                src={resolveImageDisplayUrl(historyPreviewUrl)}
                className="h-full w-full object-contain"
                controls
                playsInline
                preload="metadata"
                onClick={(event) => event.stopPropagation()}
              />
              <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-2 p-2">
                <span className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-white/90 backdrop-blur">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t("node.videoNode.history.generatingNew")}
                </span>
                <button
                  type="button"
                  className="nodrag pointer-events-auto inline-flex items-center gap-1 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-white/90 backdrop-blur transition-colors hover:bg-black/75"
                  onClick={(event) => {
                    event.stopPropagation();
                    setHistoryPreviewUrl(null);
                  }}
                >
                  <XIcon className="h-3 w-3" />
                  {t("node.videoNode.history.back")}
                </button>
              </div>
            </div>
          ) : isGenerating ? (
            <div className="relative h-full w-full">
              {data.previewImageUrl ? (
                <img
                  src={resolveImageDisplayUrl(data.previewImageUrl)}
                  alt=""
                  className="h-full w-full object-contain"
                  draggable={false}
                />
              ) : null}
              <NodeGenerationOverlay
                startedAt={data.generationStartedAt ?? null}
                durationMs={data.generationDurationMs}
                hasBackground={Boolean(data.previewImageUrl)}
              />
            </div>
          ) : hasGenerationError ? (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-red-300">
              <AlertTriangle className="h-7 w-7 opacity-90" />
              <span className="text-center text-[12px] font-medium leading-5 text-red-200">
                {t("node.videoNode.generation.failed")}
              </span>
              <span className="max-h-[64px] overflow-y-auto break-words text-center text-[11px] leading-5 text-red-200/90 [overflow-wrap:anywhere]">
                {generationError}
              </span>
              {generationErrorRequestId && (
                <div className="flex w-full max-w-[240px] items-center gap-1 rounded bg-red-500/10 px-2 py-1">
                  <span className="shrink-0 text-[10px] text-red-300/70">
                    {t("node.videoNode.error.requestId")}
                  </span>
                  <code
                    className="min-w-0 flex-1 truncate font-mono text-[10px] text-red-200"
                    title={generationErrorRequestId}
                  >
                    {generationErrorRequestId}
                  </code>
                </div>
              )}
              <div className="mt-1">
                <RegenerateButton
                  onClick={() => void handleSubmit()}
                  busy={isGenerating}
                  disabled={submitDisabled}
                />
              </div>
            </div>
          ) : data.isUpscaleNode ? (
            <div className="flex h-full w-full items-center justify-center px-6">
              <span className="text-center text-sm font-medium text-text-dark/78">
                {t("node.videoUpscale.placeholder")}
              </span>
            </div>
          ) : isConnected ? (
            // Connected: no longer show the text CTA, only put an icon in the middle of the node (aligned with libtv).
            <div className="flex h-full w-full items-center justify-center">
              <Play className="h-9 w-9 text-text-muted/46" />
            </div>
          ) : (
            <div className="flex h-full w-full items-center px-8">
              {/* Only the empty state (no incoming edges) reaches here. The CTAs are decided entirely by the media model catalog's supportedModes;
                  the model-family fallback is used only while the catalog has not loaded, avoiding showing entries the backend would reject. */}
              <div className="flex min-h-0 flex-col justify-center gap-2 py-4">
                <div className="text-xs text-[var(--canvas-node-input-helper)]">
                  {t("node.videoNode.emptyState.tryLabel")}
                </div>
                <div className="flex flex-col gap-0.5">
                  {videoEmptyStateCtaModes(selectedVideoModel).map((mode) => {
                    const { Icon, labelKey } = VIDEO_EMPTY_STATE_CTA_META[mode];
                    return (
                      <button
                        key={mode}
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          spawnFrameUploads(mode);
                        }}
                        className="nodrag -mx-2 inline-flex items-center gap-3 rounded-lg px-2 py-2 text-sm text-text-dark transition-colors hover:bg-white/[0.08]"
                      >
                        <Icon className="h-4 w-4 text-text-muted/90" />
                        <span>{t(labelKey)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <Play className="ml-auto mr-20 h-9 w-9 text-text-muted/46" />
            </div>
          )}

          {videoSource && videoLoadError && !isGenerating && !isUploading && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg-dark/70 px-4 text-center text-red-200">
              <AlertTriangle className="h-6 w-6 text-red-300" />
              <span className="text-[12px] font-medium">
                {t("node.videoNode.videoLoadFailed")}
              </span>
            </div>
          )}

          {videoSource && !hasMetadata && !isUploading && !isGenerating && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-bg-dark/40">
              <Loader2 className="h-6 w-6 animate-spin text-text-muted/70" />
            </div>
          )}

          {videoSource &&
            hasMetadata &&
            !videoLoadError &&
            !isGenerating &&
            !isUploading &&
            !subtitleEraseMode && (
              <VideoPlayerControls
                videoEl={videoEl}
                isCapturingFrame={isCapturingFrame}
                onCapture={handleCaptureFrame}
              />
            )}

          {/* Album count badge: appears on node hover; the arrow dips down on badge hover; click to expand the album. */}
          {hasAlbum && !isGenerating && videoSource && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                handleToggleAlbumExpanded();
              }}
              onPointerDown={(event) => event.stopPropagation()}
              title={t("node.videoNode.album.expandCount", { count: albumTotalSlots })}
              className="nodrag group/albumpill absolute right-2 top-2 z-10 hidden items-center gap-1 rounded-full bg-black/65 px-2.5 py-1 text-[12px] font-medium tabular-nums text-white shadow-lg backdrop-blur-sm transition-colors hover:bg-black/85 group-hover:inline-flex"
            >
              {albumPendingCount > 0
                ? `${albumUrls.length}/${albumPendingTotal}`
                : albumUrls.length}
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform duration-200 ${
                  albumExpanded
                    ? 'rotate-180 group-hover/albumpill:-translate-y-[2px]'
                    : 'group-hover/albumpill:translate-y-[2px]'
                }`}
              />
            </button>
          )}

          {videoSource && subtitleEraseMode === "box" && (
            <SubtitleEraseBoxOverlay
              box={subtitleEraseBox}
              drag={eraseDrag}
              disabled={isErasing}
              getDisplayedRect={getDisplayedVideoRect}
              onDragStart={(start) => setEraseDrag(start)}
              onDragMove={(next) =>
                setEraseDrag((prev) =>
                  prev ? { ...prev, x1: next.x1, y1: next.y1 } : prev,
                )
              }
              onDragEnd={(final) => {
                setEraseDrag(null);
                if (!final) return;
                updateNodeData(id, { subtitleEraseBox: final });
              }}
            />
          )}
        </div>

        {/* Expanded album grid: isomorphic with the image node — "group"-style outline + 2-column grid; clicking a video sets it as
            the main video and collapses; hover shows "Apply to canvas" + download; press and hold to drag the whole node. */}
        {albumExpanded && hasAlbum && (
          <div
            className="nowheel absolute -left-3 -top-3 z-[80] cursor-grab rounded-2xl border border-white/15 bg-white/[0.045] p-3 shadow-[0_16px_48px_rgba(0,0,0,0.4)] backdrop-blur-[2px] active:cursor-grabbing"
            style={{ width: resolvedWidth * 2 + 12 + 24 }}
            onClick={(event) => event.stopPropagation()}
            onPointerDownCapture={(event) => {
              albumPointerDownPosRef.current = { x: event.clientX, y: event.clientY };
            }}
          >
            <div className="mb-2 flex items-center gap-1.5 px-1 text-[12px] font-medium text-white/60">
              <VideoIcon className="h-3.5 w-3.5 text-white/45" />
              {t("node.videoNode.album.heading", { count: albumTotalSlots })}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {albumUrls.map((url, index) => {
                const isMain = url === data.videoUrl;
                return (
                  <div
                    key={`album-cell-${index}`}
                    role="button"
                    tabIndex={-1}
                    title={t("node.videoNode.album.setAsMain")}
                    onClick={(event) => {
                      event.stopPropagation();
                      // A click re-fired after dragging the album (moving the node) and releasing does not count as picking a main video.
                      const start = albumPointerDownPosRef.current;
                      if (
                        start
                        && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5
                      ) {
                        return;
                      }
                      handleSetAlbumMainVideo(url);
                    }}
                    className={`group/albumcell relative cursor-pointer overflow-hidden rounded-[var(--node-radius)] border bg-[#1b1b1d] shadow-[0_12px_32px_rgba(0,0,0,0.45)] transition-colors ${
                      isMain
                        ? 'border-accent/80 ring-2 ring-accent/40'
                        : 'border-white/12 hover:border-white/35'
                    }`}
                    style={{ width: resolvedWidth, height: resolvedHeight }}
                  >
                    <video
                      src={resolveImageDisplayUrl(url)}
                      muted
                      playsInline
                      preload="metadata"
                      className="h-full w-full object-cover"
                      onMouseEnter={(event) => {
                        void event.currentTarget.play().catch(() => undefined);
                      }}
                      onMouseLeave={(event) => {
                        event.currentTarget.pause();
                        event.currentTarget.currentTime = 0;
                      }}
                    />
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleApplyAlbumVideoToCanvas(url);
                      }}
                      title={t("node.videoNode.album.applyToCanvas")}
                      className="nodrag absolute left-2 top-2 z-10 hidden h-7 items-center gap-1 rounded-md bg-black/70 px-2.5 text-[12px] font-medium text-white backdrop-blur-sm transition-colors hover:bg-black/90 group-hover/albumcell:inline-flex"
                    >
                      <UploadIcon className="h-3.5 w-3.5" />
                      {t("node.videoNode.album.applyToCanvasLabel")}
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleDownloadAlbumVideo(url, index);
                      }}
                      title={t("node.videoNode.album.download")}
                      className="nodrag absolute right-2 top-2 z-10 hidden h-7 w-7 items-center justify-center rounded-full bg-black/70 text-white backdrop-blur-sm transition-colors hover:bg-black/90 group-hover/albumcell:inline-flex"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </button>
                    {isMain && (
                      <span className="absolute bottom-2 left-2 z-10 rounded-md bg-black/65 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm">
                        {t("node.videoNode.album.mainVideo")}
                      </span>
                    )}
                  </div>
                );
              })}
              {/* Slot still generating: placeholder skeleton, replaced one by one as each finishes. */}
              {Array.from({ length: albumPendingCount }, (_, index) => (
                <div
                  key={`album-pending-${index}`}
                  className="relative flex items-center justify-center overflow-hidden rounded-[var(--node-radius)] border border-white/10 bg-[#1b1b1d] shadow-[0_12px_32px_rgba(0,0,0,0.45)]"
                  style={{ width: resolvedWidth, height: resolvedHeight }}
                >
                  <div className="flex flex-col items-center gap-2 text-text-muted/70">
                    <Loader2 className="h-6 w-6 animate-spin" />
                    <span className="text-[12px]">{t("node.videoNode.album.generating")}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {isClipMode && videoSource && (
          <div
            className="absolute left-0 right-0 z-10 flex flex-col gap-1"
            style={{ top: `calc(100% + ${OPERATIONS_PANEL_GAP}px)` }}
          >
            <VideoClipPanel
              videoUrl={videoSource}
              durationMs={durationMs}
              clipStartMs={clipStartMs}
              clipEndMs={clipEndMs}
              isSubmitting={isComposingClip}
              onChange={(patch) => updateNodeData(id, patch)}
              onExit={() => {
                if (isComposingClip) return;
                setClipError(null);
                updateNodeData(id, { isClipMode: false });
              }}
              onSubmit={(start, end) => {
                void handleClipSubmit(start, end);
              }}
            />
            {clipError && (
              <div className="rounded-md bg-red-500/15 px-3 py-1.5 text-[11px] text-red-300 break-words [overflow-wrap:anywhere]">
                {t("node.videoNode.clip.failed", { detail: clipError })}
              </div>
            )}
          </div>
        )}

        {showVideoOpsPanel && (
          <VideoOperationsPanel
            id={id}
            data={data}
            genMode={genMode}
            modelId={modelId}
            selectedVideoModel={selectedVideoModel}
            availableVideoModels={availableVideoModels}
            isHappyHorseModel={isHappyHorseModel}
            upstreamCounts={upstreamCounts}
            upstreamTypeCounts={upstreamTypeCounts}
            upstreamContents={upstreamContents}
            upstreamTextJoined={upstreamTextJoined}
            referenceMedia={referenceMedia}
            referenceCaps={referenceCaps}
            cameraTemplates={cameraTemplates}
            cameraTemplatesLoading={cameraTemplatesLoading}
            configuredAspectRatios={configuredAspectRatios}
            aspectRatio={aspectRatio}
            quality={quality}
            qualityOptions={qualityOptions}
            durationSec={durationSec}
            durationBounds={durationBounds}
            sceneOptimize={sceneOptimize}
            sceneOptimizeOptions={sceneOptimizeOptions}
            supportsGenerateAudio={supportsGenerateAudio}
            generateAudio={generateAudio}
            supportsHumanReview={supportsHumanReview}
            humanReview={humanReview}
            count={count}
            prompt={prompt}
            isGenerating={isGenerating}
            videoBackendForCost={videoBackendForCost}
            videoInputPresent={videoInputBilling.present}
            videoInputBillingReady={videoInputBilling.ready}
            inputVideoDurationSeconds={videoInputBilling.durationSeconds}
            submitDisabled={submitDisabled}
            selectedModelReferenceError={selectedModelReferenceError}
            mediaRejectionReason={mediaRejectionReason}
            expanded={panelExpanded}
            onExpandedChange={setPanelExpanded}
            onSubmit={handleSubmit}
          />
        )}

        {selected &&
          !isBoxSelecting &&
          !albumExpanded &&
          !isClipMode &&
          !subtitleEraseMode &&
          !data.referenceOnly &&
          hasCompletedHistoryRecords(historyRecords) && (
            <div
              className={`nodrag absolute z-[300] rounded-[var(--node-radius)] ${CANVAS_NODE_OPS_PANEL_CLASS} ${NODE_OPS_PANEL_ENTER_CLASS} px-3 py-2`}
              style={{
                top: `calc(100% + ${OPERATIONS_PANEL_GAP * 2 + panelHeight}px)`,
                left: -panelOverhang,
                right: -panelOverhang,
              }}
              onClick={(event) => event.stopPropagation()}
            >
              <NodeGenerationHistory
                records={historyRecords}
                isLoading={historyLoading}
                onRestore={handleRestoreHistory}
                onRefresh={() => void refreshHistory()}
                isActive={(record) => {
                  const url = historyRecordOutputUrl(record);
                  if (!url) return false;
                  // In preview state highlight the history entry being previewed, otherwise highlight the current main video.
                  if (isGenerating && historyPreviewUrl) {
                    return url === historyPreviewUrl;
                  }
                  return url === data.videoUrl;
                }}
              />
            </div>
          )}

        {subtitleEraseMode && (
          <div
            className="nodrag absolute left-0 right-0 z-10 flex justify-center"
            style={{ top: `calc(100% + ${OPERATIONS_PANEL_GAP}px)` }}
            onClick={(event) => event.stopPropagation()}
          >
            <SubtitleEraseOpsPanel
              mode={subtitleEraseMode}
              isErasing={isErasing}
              hasBox={!!subtitleEraseBox}
              onExit={handleEraseExit}
              onResetBox={() => updateNodeData(id, { subtitleEraseBox: null })}
              onSubmit={handleEraseSubmit}
            />
          </div>
        )}

        <input
          ref={inputRef}
          type="file"
          accept={VIDEO_FILE_ACCEPT}
          className="hidden"
          onChange={handleFileChange}
        />
      </div>
    );
  },
);

VideoNode.displayName = "VideoNode";

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

// --- custom video player controls ------------------------------------------ //
//
// Replaces <video controls>: a libtv-style floating layer (a strip at the bottom). Subscribes to the native <video>
// play/pause/timeupdate/durationchange/volumechange, and on write-back operates the element directly,
// with events driving state in one direction. Hiding policy: shown at 0.85 opacity by default + darker on hover,
// no auto-hide, so the canvas never hides that "this video can still be controlled".

interface VideoPlayerControlsProps {
  videoEl: HTMLVideoElement | null;
  isCapturingFrame: boolean;
  onCapture: (mode: "first" | "last" | "current") => void;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function VideoPlayerControls({
  videoEl,
  isCapturingFrame,
  onCapture,
}: VideoPlayerControlsProps) {
  const { t } = useTranslation();
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isHoveringFrame, setIsHoveringFrame] = useState(false);

  useEffect(() => {
    if (!videoEl) return;
    const syncAll = () => {
      setIsPlaying(!videoEl.paused);
      setCurrentTime(videoEl.currentTime);
      setDuration(Number.isFinite(videoEl.duration) ? videoEl.duration : 0);
      setIsMuted(videoEl.muted);
    };
    syncAll();
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onTime = () => setCurrentTime(videoEl.currentTime);
    const onDur = () => {
      setDuration(Number.isFinite(videoEl.duration) ? videoEl.duration : 0);
    };
    const onVol = () => setIsMuted(videoEl.muted);
    videoEl.addEventListener("play", onPlay);
    videoEl.addEventListener("pause", onPause);
    videoEl.addEventListener("timeupdate", onTime);
    videoEl.addEventListener("durationchange", onDur);
    videoEl.addEventListener("loadedmetadata", onDur);
    videoEl.addEventListener("volumechange", onVol);
    return () => {
      videoEl.removeEventListener("play", onPlay);
      videoEl.removeEventListener("pause", onPause);
      videoEl.removeEventListener("timeupdate", onTime);
      videoEl.removeEventListener("durationchange", onDur);
      videoEl.removeEventListener("loadedmetadata", onDur);
      videoEl.removeEventListener("volumechange", onVol);
    };
  }, [videoEl]);

  const togglePlay = useCallback(() => {
    if (!videoEl) return;
    if (videoEl.paused) {
      void videoEl.play().catch(() => undefined);
    } else {
      videoEl.pause();
    }
  }, [videoEl]);

  const toggleMute = useCallback(() => {
    if (!videoEl) return;
    videoEl.muted = !videoEl.muted;
  }, [videoEl]);

  const onSeek = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      if (!videoEl) return;
      const next = Number(event.target.value);
      if (!Number.isFinite(next)) return;
      videoEl.currentTime = next;
      setCurrentTime(next);
    },
    [videoEl],
  );

  // Progress percentage (used as the gradient anchor of the range background).
  const progressPct =
    duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const sliderBg = `linear-gradient(to right, rgb(var(--accent-rgb)) 0%, rgb(var(--accent-rgb)) ${progressPct}%, rgba(255,255,255,0.18) ${progressPct}%, rgba(255,255,255,0.18) 100%)`;

  return (
    <div className="nodrag absolute inset-x-0 bottom-0 z-20 flex items-center gap-2.5 bg-gradient-to-t from-black/75 via-black/45 to-transparent px-3 pb-2 pt-6 text-text-dark">
      <button
        type="button"
        onClick={(event) => {
          // The only play/pause entry: stop propagation so clicking it does not also select the node.
          event.stopPropagation();
          togglePlay();
        }}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-dark/90 transition-colors hover:bg-white/[0.12] hover:text-text-dark"
        title={
          isPlaying
            ? t("node.videoNode.player.pause", { defaultValue: "Pause" })
            : t("node.videoNode.player.play", { defaultValue: "Play" })
        }
      >
        {isPlaying ? (
          <Pause className="h-4 w-4" />
        ) : (
          <Play className="h-4 w-4" fill="currentColor" />
        )}
      </button>

      <span className="shrink-0 text-[11px] tabular-nums text-text-dark/85">
        {formatTime(currentTime)}
      </span>

      <input
        type="range"
        min={0}
        max={duration > 0 ? duration : 0}
        step={0.05}
        value={currentTime}
        onChange={onSeek}
        onMouseDown={(event) => event.stopPropagation()}
        className="video-player-scrubber h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full"
        style={{ background: sliderBg }}
      />

      <span className="shrink-0 text-[11px] tabular-nums text-text-dark/85">
        {formatTime(duration)}
      </span>

      <button
        type="button"
        onClick={toggleMute}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-dark/90 transition-colors hover:bg-white/[0.12] hover:text-text-dark"
        title={
          isMuted
            ? t("node.videoNode.player.unmute", { defaultValue: "Unmute" })
            : t("node.videoNode.player.mute", { defaultValue: "Mute" })
        }
      >
        {isMuted ? (
          <VolumeX className="h-4 w-4" />
        ) : (
          <Volume2 className="h-4 w-4" />
        )}
      </button>

      <div
        className="relative shrink-0"
        onMouseEnter={() => setIsHoveringFrame(true)}
        onMouseLeave={() => setIsHoveringFrame(false)}
      >
        <button
          type="button"
          disabled={isCapturingFrame}
          onClick={() => onCapture("current")}
          title={t("node.videoNode.frame.captureCurrent")}
          className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
            isCapturingFrame
              ? "cursor-not-allowed text-text-muted/60"
              : "text-text-dark/90 hover:bg-white/[0.12] hover:text-text-dark"
          }`}
        >
          {isCapturingFrame ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Camera className="h-4 w-4" />
          )}
        </button>

        {isHoveringFrame && !isCapturingFrame && (
          <div className="absolute bottom-full right-0 flex flex-col gap-1 rounded-lg border border-white/10 bg-surface-dark/95 p-1 text-xs shadow-2xl backdrop-blur-md">
            <button
              type="button"
              onClick={() => onCapture("first")}
              className="whitespace-nowrap rounded-md px-3 py-1.5 text-left text-text-dark transition-colors hover:bg-white/[0.08]"
            >
              {t("node.videoNode.frame.captureFirst")}
            </button>
            <button
              type="button"
              onClick={() => onCapture("last")}
              className="whitespace-nowrap rounded-md px-3 py-1.5 text-left text-text-dark transition-colors hover:bg-white/[0.08]"
            >
              {t("node.videoNode.frame.captureLast")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// --- subtitle erase: box overlay ------------------------------------------- //

interface DisplayedRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface SubtitleEraseBoxOverlayProps {
  box: { x: number; y: number; width: number; height: number } | null;
  drag: { x0: number; y0: number; x1: number; y1: number } | null;
  disabled: boolean;
  getDisplayedRect: (containerW: number, containerH: number) => DisplayedRect;
  onDragStart: (start: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  }) => void;
  onDragMove: (next: { x1: number; y1: number }) => void;
  onDragEnd: (
    final: { x: number; y: number; width: number; height: number } | null,
  ) => void;
}

function SubtitleEraseBoxOverlay({
  box,
  drag,
  disabled,
  getDisplayedRect,
  onDragStart,
  onDragMove,
  onDragEnd,
}: SubtitleEraseBoxOverlayProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setContainerSize({
        w: entry.contentRect.width,
        h: entry.contentRect.height,
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const displayed = getDisplayedRect(containerSize.w, containerSize.h);

  const toNormalized = useCallback(
    (clientX: number, clientY: number) => {
      const el = containerRef.current;
      if (!el) return { nx: 0, ny: 0 };
      const rect = el.getBoundingClientRect();
      const localX = clientX - rect.left - displayed.left;
      const localY = clientY - rect.top - displayed.top;
      const nx = displayed.width > 0 ? localX / displayed.width : 0;
      const ny = displayed.height > 0 ? localY / displayed.height : 0;
      return {
        nx: Math.max(0, Math.min(1, nx)),
        ny: Math.max(0, Math.min(1, ny)),
      };
    },
    [displayed.height, displayed.left, displayed.top, displayed.width],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      const { nx, ny } = toNormalized(event.clientX, event.clientY);
      onDragStart({ x0: nx, y0: ny, x1: nx, y1: ny });
    },
    [disabled, onDragStart, toNormalized],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (disabled || !drag) return;
      const { nx, ny } = toNormalized(event.clientX, event.clientY);
      onDragMove({ x1: nx, y1: ny });
    },
    [disabled, drag, onDragMove, toNormalized],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (disabled || !drag) return;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // pointer may not have been captured
      }
      const x = Math.min(drag.x0, drag.x1);
      const y = Math.min(drag.y0, drag.y1);
      const width = Math.abs(drag.x1 - drag.x0);
      const height = Math.abs(drag.y1 - drag.y0);
      if (width < 0.01 || height < 0.01) {
        onDragEnd(null);
        return;
      }
      onDragEnd({ x, y, width, height });
    },
    [disabled, drag, onDragEnd],
  );

  const effective = drag
    ? {
        x: Math.min(drag.x0, drag.x1),
        y: Math.min(drag.y0, drag.y1),
        width: Math.abs(drag.x1 - drag.x0),
        height: Math.abs(drag.y1 - drag.y0),
      }
    : box;

  return (
    <div
      ref={containerRef}
      className="nodrag absolute inset-0 z-30"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onClick={(event) => event.stopPropagation()}
      style={{ cursor: disabled ? "not-allowed" : "crosshair" }}
    >
      {effective && effective.width > 0 && effective.height > 0 && (
        <div
          className="pointer-events-none absolute border-2 border-[rgb(var(--accent-rgb))] bg-[rgb(var(--accent-rgb)/0.15)]"
          style={{
            left: displayed.left + effective.x * displayed.width,
            top: displayed.top + effective.y * displayed.height,
            width: effective.width * displayed.width,
            height: effective.height * displayed.height,
          }}
        />
      )}
    </div>
  );
}

// --- subtitle erase: ops panel --------------------------------------------- //

interface SubtitleEraseOpsPanelProps {
  mode: "smart" | "box";
  isErasing: boolean;
  hasBox: boolean;
  onExit: () => void;
  onResetBox: () => void;
  onSubmit: () => void;
}

function SubtitleEraseOpsPanel({
  mode,
  isErasing,
  hasBox,
  onExit,
  onResetBox,
  onSubmit,
}: SubtitleEraseOpsPanelProps) {
  const { t } = useTranslation();
  const submitDisabled = isErasing || (mode === "box" && !hasBox);
  const labelKey =
    mode === "box"
      ? "nodeToolbar.video.subtitleRemovalBox"
      : "nodeToolbar.video.subtitleRemovalSmart";
  const icon =
    mode === "box" ? (
      <Square className="h-3.5 w-3.5 shrink-0 text-text-muted" />
    ) : (
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-text-muted" />
    );

  return (
    <div className={`flex min-w-[420px] max-w-[calc(100vw-32px)] items-center gap-2 ${CANVAS_NODE_TOOLBAR_PILL_CLASS}`}>
      <button
        type="button"
        onClick={onExit}
        title={t("node.videoNode.subtitleErase.exit")}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-dark/70 text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
      >
        <XIcon className="h-4 w-4" />
      </button>

      <div className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-xs text-text-dark">
        {icon}
        <span className="truncate font-medium">{t(labelKey)}</span>
      </div>

      {mode === "box" && (
        <button
          type="button"
          onClick={onResetBox}
          title={t("node.videoNode.subtitleErase.tools.reset")}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded px-1 text-text-dark/72 transition-colors hover:text-text-dark"
        >
          <RotateCcw className="h-4 w-4" />
        </button>
      )}

      <CreditCostPill
        display="0"
        disabled={submitDisabled}
        className={NODE_CREDIT_PILL_FLAT_CLASS}
      />

      <button
        type="button"
        disabled={submitDisabled}
        onClick={onSubmit}
        title={t("node.videoNode.subtitleErase.submit")}
        className={`${NODE_GENERATE_BUTTON_BASE_CLASS} shrink-0 ${
          submitDisabled
            ? NODE_GENERATE_BUTTON_DISABLED_CLASS
            : NODE_GENERATE_BUTTON_ENABLED_CLASS
        }`}
      >
        {isErasing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <ArrowUp className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}
