// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Film,
  FileText,
  Languages,
  Library,
  Link as LinkIcon,
  Loader2,
  Music,
  Pause,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFn } from "@/lib/i18n-types";
import { toast } from "sonner";

import {
  CANVAS_NODE_TYPES,
  type Seedance2SceneOptimize,
  type VideoGenCount,
  type VideoGenMode,
  type VideoGenQuality,
  type VideoMultishotShot,
  type VideoNodeData,
} from "@/features/canvas/domain/canvasNodes";
import { formatResolutionLabel } from "@/features/canvas/domain/mediaModelOptions";
import {
  isHappyHorseVideoModel,
  isVideoModeSupportedByModel,
  videoModeForcesAutomaticAspectRatio,
  videoModelDefaultGenerateAudio,
  videoModelDefaultMode,
  videoModelReferenceDisabledReason,
} from "@/features/canvas/nodes/shared/videoModelCapabilities";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import { VIDEO_FILE_ACCEPT } from "@/features/canvas/application/videoFileTypes";
import { spawnExternalAssetNodes } from "@/features/canvas/application/spawnExternalAssets";
import { canvasEventBus } from "@/features/canvas/application/canvasServices";
import type { UpstreamContent } from "@/features/canvas/application/ports";
import { ReferenceTextChip } from "@/features/canvas/nodes/shared/ReferenceTextChip";
import { ReferenceDetachButton } from "@/features/canvas/nodes/shared/ReferenceDetachButton";
import { ReferencePickChip } from "@/features/canvas/nodes/shared/ReferencePickChip";
import { ReferenceMentionButton } from "@/features/canvas/nodes/shared/ReferenceMentionButton";
import { focusReferenceNode } from "@/features/canvas/application/viewportReturnStore";
import { collectReferenceMaterials } from "@/features/canvas/application/referencePick";
import { attachReferenceEdge } from "@/features/canvas/application/attachReference";
import {
  PromptMentionEditor,
  type MentionCandidate,
  type PromptMentionEditorHandle,
} from "@/features/canvas/nodes/PromptMentionEditor";
import { NodeContextPromptPaletteButton } from "@/features/canvas/nodes/ContextPromptPaletteButton";
import {
  contextPromptPaletteInsertionText,
  type ContextPromptPaletteEntry,
} from "@/features/canvas/nodes/contextPromptPalette";
import { PanelExpandButton } from "@/features/canvas/ui/PanelExpandButton";
import { OperationPanelShell } from "@/features/canvas/ui/OperationPanelShell";
import { MultishotShotListEditor } from "@/features/canvas/nodes/multishot/MultishotShotListEditor";
import {
  CANVAS_NODE_INPUT_PLACEHOLDER_CLASS,
  CANVAS_NODE_OPS_PANEL_CLASS,
} from "@/features/canvas/ui/nodeFrameStyles";
import {
  filterMediaModelParamsForMode,
  MediaModelParameterChip,
} from "@/features/canvas/ui/MediaModelParameterChip";
import {
  NODE_COUNT_POPOVER_CLASS,
  NODE_CONTEXT_CONTROL_TRIGGER_CLASS,
  NODE_CREDIT_PILL_FLAT_CLASS,
  NODE_FLOATING_PANEL_SURFACE_CLASS,
  NODE_GENERATE_BUTTON_BASE_CLASS,
  NODE_GENERATE_BUTTON_DISABLED_CLASS,
  NODE_GENERATE_BUTTON_ENABLED_CLASS,
  NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS,
  NODE_INLINE_ICON_BUTTON_CLASS,
  NODE_REFERENCE_MEDIA_CHIP_CLASS,
  NODE_REFERENCE_MEDIA_DETACH_CLASS,
  NODE_TEXT_CONTROL_ICON_CLASS,
  NODE_TEXT_CONTROL_TRIGGER_CLASS,
} from "@/features/canvas/ui/nodeControlStyles";
import { CameraMovementPickerPopover } from "@/features/canvas/nodes/CameraMovementPickerPopover";
import { H3TemplatePickerChip } from "@/features/canvas/nodes/H3TemplatePickerChip";
import { isRunpodH3VideoModel } from "@/features/canvas/domain/h3PromptTemplates";
import {
  cameraMovementPresetLabel,
  findCameraMovementPreset,
  type CameraMovementPreset,
} from "@/features/canvas/domain/cameraMovementPresets";
import {
  AssetLibraryModal,
  type AssetLibrarySelection,
} from "@/features/canvas/ui/AssetLibraryModal";
import { useCanvasStore } from "@/stores/canvasStore";
import {
  fetchFreezoneTextTranslateResult,
  submitFreezoneTextTranslate,
  uploadFreezoneReferenceFile,
  type FreezoneVideoAspectRatio,
} from "@/api/ops";
import { awaitTaskCompletion } from "@/api/tasks";
import { useModelTaskAccess } from "@/lib/model-task-access";
import { readUrl } from "@/lib/url-params";
import {
  ProviderModelPicker,
  type ModelOption,
} from "@/features/canvas/ui/ProviderModelPicker";
import { writeLastVideoModel } from "@/features/canvas/domain/lastVideoModel";
import { CreditCostPill } from "@/components/credits/credit-visual";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { BillingRuleNotConfiguredError } from "@/lib/api-errors";
import {
  ASPECT_RATIOS,
  clampVideoDuration,
  DEFAULT_HEIGHT,
  OPERATIONS_PANEL_GAP,
  OPERATIONS_PANEL_HEIGHT,
  OPERATIONS_PANEL_OVERHANG,
  qualityToResolution,
  VIDEO_GENERATE_FEATURE_KEY,
  type ReferenceMediaItem,
} from "@/features/canvas/nodes/VideoNode";


// After "enlarge", shown in a centered dialog, giving more comfortable room for prompt editing.
const OPERATIONS_PANEL_EXPANDED_HEIGHT = 560;
const OPERATIONS_PANEL_EXPANDED_WIDTH = 1040;

const MODE_TABS: ReadonlyArray<{ key: VideoGenMode; labelKey: string }> = [
  { key: "textToVideo", labelKey: "node.videoNode.tabs.textToVideo" },
  { key: "allReference", labelKey: "node.videoNode.tabs.allReference" },
  { key: "firstFrame", labelKey: "node.videoNode.tabs.firstFrame" },
  { key: "imageToVideo", labelKey: "node.videoNode.tabs.imageToVideo" },
  { key: "firstLastFrame", labelKey: "node.videoNode.tabs.firstLastFrame" },
  { key: "imageReference", labelKey: "node.videoNode.tabs.imageReference" },
  { key: "videoEdit", labelKey: "node.videoNode.tabs.videoEdit" },
  { key: "videoExtend", labelKey: "node.videoNode.tabs.videoExtend" },
  { key: "multishot", labelKey: "node.videoNode.tabs.multishot" },
];

// Seeded once a node first enters multishot mode with no shots saved yet
// (module-level so the ids stay stable across re-renders until the user's
// first real edit persists a real `multishotShots` array onto the node).
const DEFAULT_MULTISHOT_SHOTS: VideoMultishotShot[] = [
  { id: "shot-default-1", description: "" },
  { id: "shot-default-2", description: "" },
];

// HappyHorse entry order: text-to-video → first frame → image-to-video → image reference → video edit.
const HAPPYHORSE_TAB_ORDER: ReadonlyArray<VideoGenMode> = [
  "textToVideo",
  "firstFrame",
  "imageToVideo",
  "imageReference",
  "videoEdit",
];

const COUNT_OPTIONS: ReadonlyArray<VideoGenCount> = [1, 2, 4];
const VIDEO_PARAM_POPOVER_CLASS =
  `nodrag nowheel absolute bottom-full left-0 z-50 mb-2 w-[320px] p-4 ${NODE_FLOATING_PANEL_SURFACE_CLASS}`;
const VIDEO_PARAM_LABEL_CLASS =
  "mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-dark/72";
const VIDEO_PARAM_BUTTON_BASE_CLASS =
  "inline-flex items-center justify-center rounded px-2 py-2 text-xs transition-colors";
const VIDEO_PARAM_ACTIVE_BUTTON_CLASS =
  "bg-white/[0.13] text-text-dark ring-1 ring-white/24";
const VIDEO_PARAM_IDLE_BUTTON_CLASS =
  "bg-white/[0.07] text-text-muted/95 hover:bg-white/[0.11] hover:text-text-dark";
const VIDEO_PARAM_ROW_CLASS = "mb-4 gap-2";
const VIDEO_COUNT_OPTION_BASE_CLASS =
  "block w-full rounded-[6px] px-3 py-1.5 text-left text-xs transition-colors";
const VIDEO_MODE_POPOVER_CLASS =
  `nodrag nowheel fixed z-[10000] w-[132px] overflow-visible p-1 ${NODE_FLOATING_PANEL_SURFACE_CLASS}`;
// Hover hint bubble for disabled modes: floats to the right of the menu, a dark rounded capsule, consistent with the design.
const VIDEO_MODE_TOOLTIP_CLASS =
  "pointer-events-none absolute left-full top-1/2 z-[10001] ml-2 -translate-y-1/2 " +
  "whitespace-nowrap rounded-md bg-[#1f1f22] px-2.5 py-1.5 text-[11px] font-medium " +
  "text-white/90 shadow-lg ring-1 ring-white/10";

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

interface VideoOperationsPanelProps {
  id: string;
  data: VideoNodeData;
  genMode: VideoGenMode;
  modelId: string;
  selectedVideoModel: ModelOption | undefined;
  availableVideoModels: ModelOption[];
  isHappyHorseModel: boolean;
  upstreamCounts: { images: number; videos: number; audios: number };
  upstreamTypeCounts: { images: number; videos: number; audios: number };
  upstreamContents: UpstreamContent[];
  upstreamTextJoined: string;
  referenceMedia: ReferenceMediaItem[];
  referenceCaps: { image: number; video: number; audio: number } | null;
  cameraTemplates: ReadonlyArray<CameraMovementPreset>;
  cameraTemplatesLoading: boolean;
  configuredAspectRatios: string[];
  aspectRatio: FreezoneVideoAspectRatio;
  quality: VideoGenQuality;
  qualityOptions: readonly VideoGenQuality[];
  durationSec: number;
  durationBounds: { min: number; max: number };
  sceneOptimize: Seedance2SceneOptimize | undefined;
  sceneOptimizeOptions: readonly Seedance2SceneOptimize[];
  supportsGenerateAudio: boolean;
  generateAudio: boolean;
  supportsHumanReview: boolean;
  humanReview: boolean;
  count: VideoGenCount;
  prompt: string;
  isGenerating: boolean;
  /** Backend model ID used for estimation; null while the model catalog is loading / on fallback (no estimate request is sent for now). */
  videoBackendForCost: string | null;
  videoInputPresent: boolean;
  videoInputBillingReady: boolean;
  inputVideoDurationSeconds: number;
  submitDisabled: boolean;
  selectedModelReferenceError: string | null;
  mediaRejectionReason: string | null;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onSubmit: () => Promise<void>;
}

export function VideoOperationsPanel({
  id,
  data,
  genMode,
  modelId,
  selectedVideoModel,
  availableVideoModels,
  isHappyHorseModel,
  upstreamCounts,
  upstreamTypeCounts,
  upstreamContents,
  upstreamTextJoined,
  referenceMedia,
  referenceCaps,
  cameraTemplates,
  cameraTemplatesLoading,
  configuredAspectRatios,
  aspectRatio,
  quality,
  qualityOptions,
  durationSec,
  durationBounds,
  sceneOptimize,
  sceneOptimizeOptions,
  supportsGenerateAudio,
  generateAudio,
  supportsHumanReview,
  humanReview,
  count,
  prompt,
  isGenerating,
  videoBackendForCost,
  videoInputPresent,
  videoInputBillingReady,
  inputVideoDurationSeconds,
  submitDisabled,
  selectedModelReferenceError,
  mediaRejectionReason,
  expanded,
  onExpandedChange,
  onSubmit,
}: VideoOperationsPanelProps) {
    const { t } = useTranslation();
    // The capability guard returns an i18n key (see videoModelCapabilities.ts), while the selector wants copy.
    const translateDisabledReason = (key: string | null) => (key ? t(key) : null);
    // `submitDisabled` already carries the org admission block from VideoNode;
    // this is only for the button's title, so a blocked member is told why.
    const modelTaskAccess = useModelTaskAccess();
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);
    const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
    const addNode = useCanvasStore((state) => state.addNode);
    const addEdge = useCanvasStore((state) => state.addEdge);
    const deleteEdge = useCanvasStore((state) => state.deleteEdge);
    // Separate from inputRef: that one is "replace this node's own video" (single select, video only),
    // this one is "add upstream external assets" (multi-select, image/video/audio).
    const externalAssetInputRef = useRef<HTMLInputElement>(null);
    const referenceFileInputRef = useRef<HTMLInputElement>(null);
    const toolbarContentRef = useRef<HTMLDivElement>(null);
    const [isUploadingReferenceFile, setIsUploadingReferenceFile] = useState(false);
    const [referenceLinkDraft, setReferenceLinkDraft] = useState(data.referenceLink ?? "");
    const [referencePanelWidth, setReferencePanelWidth] = useState<number | null>(null);
    const [isTranslatingPrompt, setIsTranslatingPrompt] = useState(false);
    const [isCharacterLibraryOpen, setIsCharacterLibraryOpen] = useState(false);
    // Local draft + composition guard so IME (input method) candidates stop being
    // wiped by the store-driven re-render. Same fix pattern as
    // `docs/changes/2026-05-12-image-gen-ime-fix.md`.
    const [promptDraft, setPromptDraft] = useState(prompt);
    const isComposingRef = useRef(false);
    const promptEditorRef = useRef<PromptMentionEditorHandle | null>(null);
    useEffect(() => {
      if (isComposingRef.current) return;
      setPromptDraft(prompt);
    }, [prompt]);
    useEffect(() => {
      setReferenceLinkDraft(data.referenceLink ?? "");
    }, [data.referenceLink]);

    const supportsReferenceFile = (selectedVideoModel?.referenceFileMax ?? 0) > 0;
    const supportsReferenceLink = (selectedVideoModel?.referenceLinkMax ?? 0) > 0;
    const referenceFileTypes = selectedVideoModel?.referenceFileTypes ?? [];
    const referenceFileAccept = referenceFileTypes.length > 0
      ? referenceFileTypes.map((extension) => `.${extension.replace(/^\./, "")}`).join(",")
      : undefined;

    const handleReferenceFile = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file || isUploadingReferenceFile) return;
      const maxReferenceFileBytes = 100 * 1024 * 1024;
      if (file.size > maxReferenceFileBytes) {
        toast.error(t("node.videoNode.referenceDocument.fileTooLarge", {
          size: (file.size / 1024 / 1024).toFixed(1),
        }));
        return;
      }
      const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
      if (referenceFileTypes.length > 0 && !referenceFileTypes.includes(extension)) {
        toast.error(t("node.videoNode.referenceDocument.unsupportedType", {
          types: referenceFileTypes.join(", "),
        }));
        return;
      }
      const project = readUrl().project;
      if (!project) return;
      setIsUploadingReferenceFile(true);
      try {
        const uploaded = await uploadFreezoneReferenceFile(project, file);
        updateNodeData(id, {
          referenceFileUrl: uploaded.url,
          referenceFileName: uploaded.filename || file.name,
          referenceLink: null,
        });
        setReferenceLinkDraft("");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("common.error"));
      } finally {
        setIsUploadingReferenceFile(false);
      }
    }, [id, isUploadingReferenceFile, referenceFileTypes, t, updateNodeData]);

    const commitReferenceLink = useCallback(() => {
      const value = referenceLinkDraft.trim();
      updateNodeData(id, {
        referenceLink: value || null,
        ...(value ? { referenceFileUrl: null, referenceFileName: null } : {}),
      });
    }, [id, referenceLinkDraft, updateNodeData]);
    // IME composition fallback before unmount: deselecting while composing is in progress unmounts this panel directly,
    // onCompositionEnd never gets a chance to fire, and the latest draft exists only in local state.
    // Mirror the draft with a ref; if cleanup on unmount finds composition still in progress, it lands the draft back in data.prompt.
    const promptDraftRef = useRef(promptDraft);
    promptDraftRef.current = promptDraft;
    useEffect(
      () => () => {
        if (!isComposingRef.current) return;
        isComposingRef.current = false;
        updateNodeData(id, { prompt: promptDraftRef.current });
      },
      [id, updateNodeData],
    );
    // "Context palette": same as the image-generation node, quickly inserting the marker colors of characters/props in the shot into the prompt.
    // The palette's full nodes/edges subscription moves down into NodeContextPromptPaletteButton, so this node does not
    // subscribe to the whole graph for it and get dragged into re-renders by any node drag. Insertion goes straight through the editor's imperative API: the popover and editor
    // are both in the panel and the editor is always mounted, so the callback need not depend on prompt (keeping a stable reference).
    const insertContextPaletteEntry = useCallback(
      (entry: ContextPromptPaletteEntry) => {
        promptEditorRef.current?.insertTextAtCursor(
          contextPromptPaletteInsertionText(entry),
        );
      },
      [],
    );
    const aspectRatioOptions = useMemo(() => {
      return configuredAspectRatios.length > 0 ? configuredAspectRatios : ASPECT_RATIOS;
    }, [configuredAspectRatios]);
    const cameraMovementId =
      typeof data.cameraMovement === "string" ? data.cameraMovement : null;
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
      videoInputPresent,
      350,
    );
    const debouncedInputVideoDuration = useDebouncedValue(
      inputVideoDurationSeconds,
      350,
    );
    const videoCount = Math.min(Math.max(debouncedCount, 1), 4);
    const videoPricingQuantity =
      videoCount *
      (genMode === "videoEdit"
        ? Math.max(Math.floor(debouncedInputVideoDuration), 1)
        : debouncedDurationSec);
    const videoCreditCost = useGenerationCreditCost(
      "feature",
      debouncedBackend && videoInputBillingReady
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
    const totalCreditCostDisplay =
      videoCreditCost.data?.data.display ??
      (videoBillingRuleMissing
        ? t("common.billingRuleNotConfiguredShort")
        : null);
    // Add "same-type index + whether within the current mode's cap" to each referenceMedia entry.
    // When the current genMode has no entry in REFERENCE_CAPS_BY_MODE (such as textToVideo /
    // imageToVideo / imageReference), everything is treated as within=true; the downstream chip /
    // mention candidates decide whether to consume within.
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
    // For modes with an entry in the REFERENCE_CAPS_BY_MODE table, entries beyond the cap must not enter the
    // @ candidates — the server drops them outright, and leaving them in the candidates would only get what the user picked silently ignored.
    // "image1 / video1 / audio1" are reference tokens written into the prompt and parsed by the backend;
    // translating them would make them stop matching the backend.
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

    // The @ button at the lower right of a reference thumbnail: insert this reference into the prompt by its current number. The number is
    // computed by mentionCandidates (images / videos / audio each counted separately), so the user need not count.
    const mentionNameByNodeId = useMemo(() => {
      const map = new Map<string, string>();
      for (const candidate of mentionCandidates) map.set(candidate.key, candidate.name);
      return map;
    }, [mentionCandidates]);
    const handleMentionReference = useCallback(
      (nodeId: string) => {
        const candidate = mentionCandidates.find((item) => item.key === nodeId);
        if (!candidate) return;
        promptEditorRef.current?.insertMentionAtCursor(candidate);
      },
      [mentionCandidates],
    );
    // Double-click a reference → the viewport jumps to that upstream node and leaves a "Back to node" at the bottom.
    const handleJumpToReference = useCallback(
      (nodeId: string) => {
        focusReferenceNode(nodeId, id);
      },
      [id],
    );

    // The "asset references" section of the replace menu: assets on the canvas not yet connected. Already referenced ones are excluded — they
    // are already in the section above, and the same one appearing twice would only make people think they are two things. Excluded by **edge**:
    // an upstream node that is connected but has no content yet also counts as referenced (otherwise selecting it would just create a second edge for the same one).
    //
    // Computed only when the menu opens: this list scans the whole canvas, and with a resident subscription dragging any node on the canvas would
    // make this panel recompute every frame.
    const getMentionMaterials = useCallback(() => {
      const store = useCanvasStore.getState();
      const attached = new Set(
        store.edges.filter((edge) => edge.target === id).map((edge) => edge.source),
      );
      return collectReferenceMaterials(store.nodes, id, CANVAS_NODE_TYPES.video, attached, t);
    }, [id, t]);
    // Selecting a canvas asset: just connect it as upstream — the reference row and @ candidate numbering are followed by the upstream derivation chain,
    // and the editor swaps the @ over once it appears in the candidates. When rejected (asset limit)
    // attachReferenceEdge has already shown the reason; here the result is returned to the editor so it does not wait in vain.
    const handleAttachMaterial = useCallback(
      (sourceNodeId: string) => attachReferenceEdge(sourceNodeId, id),
      [id],
    );

    const upstreamTextContents = useMemo(
      () =>
        upstreamContents.filter(
          (c) => typeof c.text === "string" && c.text.trim().length > 0,
        ),
      [upstreamContents],
    );

    // Spawn reference nodes from selected asset-library entries — one per
    // selection, stacked vertically to the left of this video node, then wired
    // as upstream references so they show up in the operations panel. The node
    // type depends on the media: images/videos become upload nodes carrying
    // imageUrl/videoUrl, audio becomes an audio node carrying audioUrl.
    const spawnCharacterLibraryReferences = useCallback(
      (selections: ReadonlyArray<AssetLibrarySelection>) => {
        if (selections.length === 0) return;
        const state = useCanvasStore.getState();
        const self = state.nodes.find((n) => n.id === id);
        if (!self) return;
        const UPLOAD_WIDTH = 320;
        const UPLOAD_HEIGHT = 240;
        const GAP_X = 40;
        const GAP_Y = 24;
        const baseX = self.position.x - UPLOAD_WIDTH - GAP_X;
        const totalH =
          UPLOAD_HEIGHT * selections.length + GAP_Y * (selections.length - 1);
        const startY =
          self.position.y + ((self.height ?? DEFAULT_HEIGHT) - totalH) / 2;
        const newIds: string[] = [];
        selections.forEach((sel, idx) => {
          const y = startY + idx * (UPLOAD_HEIGHT + GAP_Y);
          const displayName = sel.name || undefined;
          let newId: string;
          if (sel.media === "audio") {
            newId = addNode(
              CANVAS_NODE_TYPES.audio,
              { x: baseX, y },
              { audioUrl: sel.url, displayName },
            );
          } else if (sel.media === "video") {
            // A library video as an "upstream video reference asset": create a referenceOnly video node,
            // which can play the video itself, is recognized by isVideoNode, and downstream auto-switches to videoEdit. It used to create an
            // upload node that renders only images — even with videoUrl stuffed in, it neither displayed nor was recognized as video.
            newId = addNode(
              CANVAS_NODE_TYPES.video,
              { x: baseX, y },
              {
                videoUrl: sel.url,
                aspectRatio: data.aspectRatio,
                displayName,
                referenceOnly: true,
              } as Partial<VideoNodeData>,
            );
          } else {
            newId = addNode(
              CANVAS_NODE_TYPES.upload,
              { x: baseX, y },
              {
                imageUrl: sel.url,
                previewImageUrl: sel.url,
                displayName,
              },
            );
          }
          addEdge(newId, id);
          newIds.push(newId);
        });
        state.autoGroupSpawn(id, newIds, {
          label: t("node.videoOps.referenceGroupLabel"),
        });
      },
      [addEdge, addNode, data.aspectRatio, id, t],
    );

    const handleExternalAssetFiles = useCallback(
      (event: ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files ?? []);
        // Clear first so the user can pick the same file twice in a row (otherwise change does not fire).
        event.target.value = "";
        if (files.length === 0) return;
        const state = useCanvasStore.getState();
        const self = state.nodes.find((n) => n.id === id);
        // The node may have been deleted while the file picker was open.
        if (!self) return;
        spawnExternalAssetNodes(
          {
            id,
            position: self.position,
            // measured first, then fall back to data.height — aligned with the store's duplicateNodeAsSibling
            // (canvasStore.ts:1600) basis measured?.height ?? height ?? fallback.
            // Reading only data.height would miss the common nodes that "have been re-measured but have no hard-coded height" and push the whole column
            // off (node actual height 280, but centered by the fallback 380, shifting down about 50px). The spawn side still falls back to
            // 380 for undefined/0.
            height: self.measured?.height ?? self.height ?? undefined,
          },
          files,
          {
            addNode,
            addEdge,
            // canvasEventBus.publish is a prototype method that uses this, so it cannot be passed bare.
            publish: (type, payload) => canvasEventBus.publish(type, payload),
            autoGroupSpawn: (sourceId, spawnedIds, opts) =>
              state.autoGroupSpawn(sourceId, spawnedIds, opts),
          },
        );
      },
      [addEdge, addNode, id],
    );

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
        const ref = await submitFreezoneTextTranslate(project, {
          text: prompt,
          nodeType: "video",
          canvasId: readUrl().canvas ?? "default",
          nodeId: id,
        });
        await awaitTaskCompletion(ref.task_key, project, { taskType: ref.task_type });
        const result = await fetchFreezoneTextTranslateResult(
          project,
          ref.job_id,
        );
        if (result.translated_text) {
          updateNodeData(id, { prompt: result.translated_text });
        }
      } catch (error) {
        console.error("[video-node] translate failed", error);
      } finally {
        setIsTranslatingPrompt(false);
      }
    }, [id, isGenerating, isTranslatingPrompt, prompt, updateNodeData]);

    // The collapsed floating panel has a fixed base size; enlarge uses a centered dialog (see OperationPanelShell below).
    const panelHeight = OPERATIONS_PANEL_HEIGHT;
    const panelOverhang = OPERATIONS_PANEL_OVERHANG;
    const showReferenceDocumentControls =
      genMode === "allReference" &&
      (supportsReferenceFile ||
        supportsReferenceLink ||
        Boolean(data.referenceFileUrl) ||
        Boolean(referenceLinkDraft.trim()));
    useLayoutEffect(() => {
      if (!showReferenceDocumentControls) {
        setReferencePanelWidth(null);
        return;
      }
      // The same toolbar is portalled into a constrained modal while expanded.
      // Measuring there overwrites the inline panel's natural width with the
      // modal layout width; on collapse that stale value can shrink the panel
      // to only a few controls. Re-measure after it is back under the node.
      if (expanded) return;
      const content = toolbarContentRef.current;
      if (!content) return;
      const updateWidth = () => {
        const contentWidth = content.scrollWidth;
        if (contentWidth <= 0) return;
        // Include toolbar padding plus a small buffer for borders and fractional
        // canvas scaling, otherwise an exact fit can still show a scrollbar.
        // scrollWidth is intentional: offsetWidth reports the width imposed by
        // the current panel and can feed a collapsed width back into itself.
        const nextWidth = Math.ceil(contentWidth + 76);
        setReferencePanelWidth((current) => current === nextWidth ? current : nextWidth);
      };
      updateWidth();
      if (typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(updateWidth);
      observer.observe(content);
      return () => observer.disconnect();
    }, [expanded, showReferenceDocumentControls]);
    const adaptivePanelWidth = referencePanelWidth == null
      ? "min(1040px, calc(100vw - 48px))"
      : `min(${referencePanelWidth}px, calc(100vw - 48px))`;

    return (
      <>
            <OperationPanelShell
              expanded={expanded}
              onCollapse={() => onExpandedChange(false)}
              inlineClassName={`nodrag absolute z-30 flex flex-col rounded-[var(--node-radius)] ${CANVAS_NODE_OPS_PANEL_CLASS}`}
              inlineStyle={{
                top: `calc(100% + ${OPERATIONS_PANEL_GAP}px)`,
                left: showReferenceDocumentControls
                  ? `calc((100% - ${adaptivePanelWidth}) / 2)`
                  : -panelOverhang,
                right: showReferenceDocumentControls ? "auto" : -panelOverhang,
                width: showReferenceDocumentControls ? adaptivePanelWidth : undefined,
                height: panelHeight,
              }}
              modalStyle={{
                width: `min(${OPERATIONS_PANEL_EXPANDED_WIDTH}px, 92vw)`,
                height: `min(${OPERATIONS_PANEL_EXPANDED_HEIGHT}px, 86vh)`,
              }}
            >
              <PanelExpandButton
                expanded={expanded}
                onToggle={() => onExpandedChange(!expanded)}
                className="absolute right-2 top-2 z-20"
              />
              <div className="flex shrink-0 items-center overflow-x-auto px-3 pb-2 pr-10 pt-3">
                <div ref={toolbarContentRef} className="flex w-max shrink-0 items-center">
                <div className="flex shrink-0 items-center gap-2">
                  <ReferencePickChip
                    nodeId={id}
                    nodeType={CANVAS_NODE_TYPES.video}
                    onPickExternal={() => externalAssetInputRef.current?.click()}
                  />
                  <CameraMovementChip
                    templates={cameraTemplates}
                    isLoading={cameraTemplatesLoading}
                    selectedId={cameraMovementId}
                    onChange={(nextId) =>
                      updateNodeData(id, { cameraMovement: nextId })
                    }
                  />
                  <CharacterLibraryChip
                    onOpen={() => setIsCharacterLibraryOpen(true)}
                  />
                  {isRunpodH3VideoModel(selectedVideoModel?.apiModel ?? modelId) && (
                    <H3TemplatePickerChip
                      prompt={promptDraft}
                      onApply={(template) => {
                        // A camera-move fragment would be prepended ahead of
                        // the structured H3 sections, so clear it.
                        const nextMode =
                          template.mode === "fl2va" ? "first_frame" : "image_reference";
                        setPromptDraft(template.prompt);
                        updateNodeData(id, {
                          prompt: template.prompt,
                          aspectRatio: template.aspectRatio,
                          durationSec: template.durationSec,
                          cameraMovement: null,
                          genMode: nextMode,
                          modelParams: filterMediaModelParamsForMode(
                            selectedVideoModel?.request?.parameters,
                            data.modelParams,
                            nextMode,
                          ),
                        });
                      }}
                    />
                  )}
                </div>
                <div className="ml-3 flex shrink-0 items-center gap-3">
                  <GenModeSelect
                    value={genMode}
                    modelId={selectedVideoModel?.apiModel ?? selectedVideoModel?.id ?? modelId}
                    supportedModes={selectedVideoModel?.supportedModes}
                    // HappyHorse's selectable modes are decided by the upstream node type (including empty nodes with no image filled),
                    // while other models still count by resolved asset URLs.
                    upstreamCounts={
                      isHappyHorseModel ? upstreamTypeCounts : upstreamCounts
                    }
                    onChange={(nextMode) =>
                      updateNodeData(id, {
                        genMode: nextMode,
                        modelParams: filterMediaModelParamsForMode(
                          selectedVideoModel?.request?.parameters,
                          data.modelParams,
                          nextMode,
                        ),
                      })
                    }
                  />
                  <NodeContextPromptPaletteButton
                    nodeId={id}
                    onInsert={insertContextPaletteEntry}
                  />
                </div>
                {showReferenceDocumentControls && (
                  <div className="ml-3 flex shrink-0 items-center gap-1.5">
                    {(supportsReferenceFile || data.referenceFileUrl) && (
                      <>
                        <button
                          type="button"
                          title={t("node.videoNode.referenceDocument.file")}
                          disabled={!supportsReferenceFile || isUploadingReferenceFile}
                          onClick={() => referenceFileInputRef.current?.click()}
                          className={NODE_CONTEXT_CONTROL_TRIGGER_CLASS}
                        >
                          {isUploadingReferenceFile ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <FileText className="h-3.5 w-3.5" />
                          )}
                          <span className="max-w-32 truncate">
                            {data.referenceFileName || t("node.videoNode.referenceDocument.file")}
                          </span>
                        </button>
                        {data.referenceFileUrl && (
                          <button
                            type="button"
                            title={t("node.videoNode.referenceDocument.removeFile")}
                            onClick={() => updateNodeData(id, { referenceFileUrl: null, referenceFileName: null })}
                            className={NODE_INLINE_ICON_BUTTON_CLASS}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </>
                    )}
                    {(supportsReferenceLink || referenceLinkDraft.trim()) && (
                      <label className="flex h-7 w-44 items-center gap-1.5 rounded border border-white/15 bg-black/20 px-2 text-xs text-text-dark">
                        <LinkIcon className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                        <input
                          type="url"
                          value={referenceLinkDraft}
                          placeholder={t("node.videoNode.referenceDocument.linkPlaceholder")}
                          onChange={(event) => {
                            const value = event.target.value;
                            setReferenceLinkDraft(value);
                            updateNodeData(
                              id,
                              {
                                referenceLink: value,
                                ...(value.trim()
                                  ? { referenceFileUrl: null, referenceFileName: null }
                                  : {}),
                              },
                              { recordHistory: false },
                            );
                          }}
                          onBlur={commitReferenceLink}
                          onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === "Enter") event.currentTarget.blur();
                          }}
                          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-text-muted/60"
                        />
                      </label>
                    )}
                    <input
                      ref={referenceFileInputRef}
                      type="file"
                      accept={referenceFileAccept}
                      className="hidden"
                      onChange={handleReferenceFile}
                    />
                  </div>
                )}
                </div>
              </div>

              {/* Reference assets get their own row: the top row of feature chips is already full, and squeezing assets in would push out the input area. */}
              {(upstreamTextContents.length > 0 || referenceMedia.length > 0) && (
                <div className="nowheel flex shrink-0 items-center gap-3 overflow-x-auto px-3 pb-2">
                  {upstreamTextContents.map((content) => (
                    <ReferenceTextChip
                      key={`upstream-text-${content.nodeId}`}
                      nodeId={content.nodeId}
                      text={content.text ?? ""}
                      sourceLabel={content.displayName ?? content.nodeType}
                      onDetach={handleDetachUpstream}
                      onJump={handleJumpToReference}
                    />
                  ))}
                  {referenceMedia.length > 0 && (
                    <ReferenceMediaRow
                      items={referenceMediaCapInfo}
                      caps={referenceCaps}
                      genMode={genMode}
                      mentionNames={mentionNameByNodeId}
                      onFocus={(nodeId) => setSelectedNode(nodeId)}
                      onMention={handleMentionReference}
                      onJump={handleJumpToReference}
                      onDetach={handleDetachUpstream}
                      onReorder={(ids) =>
                        updateNodeData(id, { referenceOrder: ids })
                      }
                    />
                  )}
                </div>
              )}

              <PromptMentionEditor
                ref={promptEditorRef}
                value={promptDraft}
                onChange={(next) => {
                  setPromptDraft(next);
                  if (!isComposingRef.current) {
                    updateNodeData(id, { prompt: next });
                  }
                }}
                onCompositionStart={() => {
                  isComposingRef.current = true;
                }}
                onCompositionEnd={(next) => {
                  isComposingRef.current = false;
                  setPromptDraft(next);
                  updateNodeData(id, { prompt: next });
                }}
                onKeyDown={(event) => event.stopPropagation()}
                candidates={mentionCandidates}
                getMaterials={getMentionMaterials}
                onAttachMaterial={handleAttachMaterial}
                placeholder={
                  genMode === "multishot"
                    ? t("node.videoOps.multishot.overallDirection")
                    : upstreamTextJoined.length > 0
                      ? t("node.videoOps.upstreamPlaceholder")
                      : t("node.videoNode.placeholder")
                }
                className={
                  genMode === "multishot"
                    // Multishot's own shot list (below) needs most of the
                    // panel's height — the prompt box here only ever holds
                    // a short "overall direction" line (see VideoNode.tsx's
                    // "multishot" submit branch: `prompt` becomes
                    // `director_guidance` server-side, not per-shot text).
                    ? `nodrag nowheel h-12 w-full shrink-0 overflow-y-auto whitespace-pre-wrap break-words border-none bg-transparent px-3 py-2 text-sm leading-6 text-text-dark outline-none ${CANVAS_NODE_INPUT_PLACEHOLDER_CLASS}`
                    : `nodrag nowheel min-h-0 w-full flex-1 overflow-y-auto whitespace-pre-wrap break-words border-none bg-transparent px-3 py-2 text-sm leading-6 text-text-dark outline-none ${CANVAS_NODE_INPUT_PLACEHOLDER_CLASS}`
                }
              />

              {genMode === "multishot" && (
                <div className="shrink-0 border-t border-white/[0.06] px-3 py-2">
                  <MultishotShotListEditor
                    shots={
                      data.multishotShots && data.multishotShots.length > 0
                        ? data.multishotShots
                        : DEFAULT_MULTISHOT_SHOTS
                    }
                    maxShots={selectedVideoModel?.maxShots}
                    shotSeconds={durationSec}
                    onChange={(shots) => updateNodeData(id, { multishotShots: shots })}
                    disabled={data.isGenerating}
                  />
                </div>
              )}

              <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <ProviderModelPicker
                    selectedModelId={modelId}
                    onChange={(nextModelId) => {
                      const nextModel = availableVideoModels.find(
                        (item) => item.id === nextModelId,
                      );
                      // After switching models, if the current genMode is not supported by the new model (such as HappyHorse-only
                      // videoEdit switching to a regular model), reset to a mode the NEW model actually supports —
                      // letting the state machine re-derive by the new model + upstream; otherwise a leftover mode would hit
                      // an unsupported endpoint on submit and be rejected with a backend 400 (while the UI is still on the wrong tab).
                      // Previously this always reset to the hardcoded "textToVideo" — harmless for every model before
                      // multishot (all of them support text-to-video), but would silently land a multishot-only model
                      // (supportedModes === ["multishot"]) on a mode it cannot run at all.
                      const resetGenMode =
                        data.genMode != null &&
                        !isVideoModeSupportedByModel(
                          data.genMode,
                          nextModel,
                        );
                      updateNodeData(id, {
                        model: nextModelId,
                        modelParams: {},
                        generateAudio: videoModelDefaultGenerateAudio(nextModel),
                        ...(resetGenMode
                          ? { genMode: videoModelDefaultMode(nextModel) }
                          : {}),
                      });
                      // Remember this choice; video nodes created later will inherit it.
                      writeLastVideoModel(nextModelId);
                    }}
                    domain="video"
                    popoverPlacement="top"
                    getOptionDisabledReason={(model) =>
                      // Pass the whole ModelOption, do not collapse it to an id — the capability basis is the supportedModes
                      // declared by the admin "Media models"; passing only an id falls back to heuristics and discards the catalog's
                      // changes entirely (for example, after the admin takes down HappyHorse's video edit, it is
                      // still selectable here, and once selected every mode is gray and submit is blocked too). Same source as VideoNode's
                      // submit guard.
                      translateDisabledReason(videoModelReferenceDisabledReason(model, {
                        images: upstreamCounts.images,
                        // Video / audio must use the same basis as the auto model-switch effect (by node type,
                        // empty nodes count too). If the "resolved URL" basis were used here, with an empty video node connected
                        // 1.x would not be grayed out and the user could select it back, only to be switched away by the effect at once, fighting back and forth.
                        videos: upstreamTypeCounts.videos,
                        audios: upstreamTypeCounts.audios,
                      }))
                    }
                  />
                  <VideoConfigChip
                    followInputAspectRatio={videoModeForcesAutomaticAspectRatio(genMode)}
                    followInputDuration={genMode === "videoEdit"}
                    aspectRatio={aspectRatio}
                    aspectRatioOptions={aspectRatioOptions}
                    quality={quality}
                    qualityOptions={qualityOptions}
                    durationSec={durationSec}
                    durationBounds={durationBounds}
                    sceneOptimize={sceneOptimize}
                    sceneOptimizeOptions={sceneOptimizeOptions}
                    supportsGenerateAudio={supportsGenerateAudio}
                    generateAudio={generateAudio}
                    onChange={(patch) => updateNodeData(id, patch)}
                  />
                  <MediaModelParameterChip
                    parameters={selectedVideoModel?.request?.parameters}
                    values={data.modelParams}
                    mode={genMode}
                    onChange={(modelParams) => updateNodeData(id, { modelParams })}
                  />
                  {supportsHumanReview && (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={humanReview}
                      title={t("node.videoOps.humanReviewTitle")}
                      onClick={(event) => {
                        event.stopPropagation();
                        updateNodeData(id, { humanReview: !humanReview });
                      }}
                      className={`nodrag inline-flex h-7 items-center gap-1.5 rounded px-1 text-xs font-medium transition-colors ${
                        humanReview
                          ? "text-text-dark"
                          : "text-text-dark/72 hover:text-text-dark"
                      }`}
                    >
                      <span>{t("node.videoOps.humanReviewLabel")}</span>
                      <span
                        className={`relative inline-flex h-3.5 w-6 shrink-0 items-center rounded-full transition-colors ${
                          humanReview
                            ? "bg-[rgb(var(--accent-rgb))]"
                            : "bg-white/15"
                        }`}
                      >
                        <span
                          className={`inline-block h-2.5 w-2.5 transform rounded-full bg-white transition-transform ${
                            humanReview ? "translate-x-3" : "translate-x-0.5"
                          }`}
                        />
                      </span>
                    </button>
                  )}
                  {genMode !== "multishot" && (
                    // Multishot is always exactly 1 long-running paid job —
                    // "generate N variants" doesn't apply (see VideoNode.tsx:
                    // total is forced to 1 for this mode).
                    <CountPicker
                      value={count}
                      onChange={(nextCount) =>
                        updateNodeData(id, { count: nextCount })
                      }
                    />
                  )}
                  <button
                    type="button"
                    title={t("node.videoOps.translateTitle")}
                    disabled={
                      isTranslatingPrompt ||
                      isGenerating ||
                      prompt.trim().length === 0
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleTranslatePrompt();
                    }}
                    className={`${NODE_INLINE_ICON_BUTTON_CLASS} ${
                      isTranslatingPrompt
                        ? NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS
                        : ""
                    }`}
                  >
                    {isTranslatingPrompt ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Languages className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <CreditCostPill
                    display={totalCreditCostDisplay}
                    promotion={videoCreditCost.data?.data.promotion}
                    disabled={submitDisabled || videoBillingRuleMissing}
                    className={NODE_CREDIT_PILL_FLAT_CLASS}
                  />
                  <button
                    type="button"
                    disabled={submitDisabled || videoBillingRuleMissing}
                    title={
                      selectedModelReferenceError ?? (isGenerating
                        ? t("node.videoNode.submitBusy")
                        : (modelTaskAccess.message ?? mediaRejectionReason ??
                          t("node.videoNode.submit")))
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      void onSubmit();
                    }}
                    className={`${NODE_GENERATE_BUTTON_BASE_CLASS} ${
                      submitDisabled || videoBillingRuleMissing
                        ? NODE_GENERATE_BUTTON_DISABLED_CLASS
                        : NODE_GENERATE_BUTTON_ENABLED_CLASS
                    }`}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </OperationPanelShell>
        <input
          ref={externalAssetInputRef}
          type="file"
          multiple
          accept={`image/*,${VIDEO_FILE_ACCEPT},audio/*`}
          className="hidden"
          onChange={handleExternalAssetFiles}
        />

        <AssetLibraryModal
          mode="pick"
          open={isCharacterLibraryOpen}
          project={readUrl().project ?? null}
          onClose={() => setIsCharacterLibraryOpen(false)}
          onConfirm={(selections) =>
            spawnCharacterLibraryReferences(selections)
          }
        />
      </>
    );
}

interface GenModeSelectProps {
  value: VideoGenMode;
  modelId: string | null | undefined;
  supportedModes?: string[];
  upstreamCounts: { videos: number; images: number; audios: number };
  onChange: (next: VideoGenMode) => void;
}

export function videoModeDisabledReason(
  mode: VideoGenMode,
  modelId: string | null | undefined,
  upstreamCounts: { videos: number; images: number; audios: number },
  t: TFn,
  supportedModes?: string[],
): string | null {
  // HappyHorse's mode availability is decided entirely by the upstream node type (the 4 major functions in the docs):
  //   text-to-video       — available only with no upstream
  //   first frame / image-to-video — available only when there is exactly 1 upstream image
  //   image reference     — available with 1~9 upstream images
  //   video edit          — available only with 1 upstream video
  // When unavailable, return hover copy (telling the user what needs to be connected).
  if (isHappyHorseVideoModel(modelId)) {
    const { images, videos } = upstreamCounts;
    switch (mode) {
      case "textToVideo":
        if (videos > 0) return t("node.videoOps.modeDisabled.hasVideoUseVideoEdit");
        if (images > 0) return t("node.videoOps.modeDisabled.hasImagePickMode");
        return null;
      case "imageToVideo":
      case "firstFrame":
        if (videos > 0) {
          return mode === "firstFrame"
            ? t("node.videoOps.modeDisabled.hasVideoNoFirstFrame")
            : t("node.videoOps.modeDisabled.hasVideoNoImageToVideo");
        }
        if (images === 0) return t("node.videoOps.modeDisabled.needOneImage");
        if (images > 1) {
          return mode === "firstFrame"
            ? t("node.videoOps.modeDisabled.firstFrameSingleImage")
            : t("node.videoOps.modeDisabled.imageToVideoSingleImageUseRef");
        }
        return null;
      case "imageReference": // image reference (r2v)
        if (videos > 0) return t("node.videoOps.modeDisabled.hasVideoNoImageReference");
        if (images === 0) return t("node.videoOps.modeDisabled.needImages1to9");
        if (images > 9) return t("node.videoOps.modeDisabled.imageReferenceMax9");
        return null;
      case "videoEdit":
        if (videos === 0) return t("node.videoOps.modeDisabled.needOneVideo");
        if (videos > 1) return t("node.videoOps.modeDisabled.videoEditSingleVideo");
        return null;
      default:
        return t("node.videoOps.modeDisabled.happyHorseUnsupported");
    }
  }
  // All reference, video edit and video extend all consume the upstream video; the latter two validate their own input counts and model capability
  // separately before entering the generic asset guard.
  const model = supportedModes?.length
    ? { apiModel: modelId ?? undefined, supportedModes }
    : modelId;
  const supportsVideoEdit = isVideoModeSupportedByModel("videoEdit", model);
  const supportsVideoExtend = isVideoModeSupportedByModel("videoExtend", model);
  if (mode === "videoEdit") {
    if (!supportsVideoEdit) return t("node.videoOps.modeDisabled.modelNoVideoEdit");
    if (upstreamCounts.videos === 0) return t("node.videoOps.modeDisabled.needOneVideo");
    if (upstreamCounts.videos > 1) return t("node.videoOps.modeDisabled.videoEditSingleVideo");
    return null;
  }
  if (mode === "videoExtend") {
    if (!supportsVideoExtend) return t("node.videoOps.modeDisabled.modelNoVideoExtend");
    if (upstreamCounts.videos === 0) return t("node.videoOps.modeDisabled.needOneVideo");
    if (upstreamCounts.videos > 1) {
      return t("node.videoOps.modeDisabled.videoExtendSingleVideo");
    }
    if (upstreamCounts.images > 0 || upstreamCounts.audios > 0) {
      return t("node.videoOps.modeDisabled.videoExtendSourceOnly");
    }
    return null;
  }
  if (upstreamCounts.videos > 0 && mode !== "allReference") {
    return supportsVideoEdit
      ? t("node.videoOps.modeDisabled.videoUpstreamAllRefOrEdit")
      : t("node.videoOps.modeDisabled.videoUpstreamAllRefOnly");
  }
  if (
    mode === "textToVideo" &&
    (upstreamCounts.images > 0 || upstreamCounts.audios > 0)
  ) {
    return t("node.videoOps.modeDisabled.hasImageOrAudioRefs");
  }
  if ((mode === "firstFrame" || mode === "imageToVideo") && upstreamCounts.images > 1) {
    return mode === "firstFrame"
      ? t("node.videoOps.modeDisabled.firstFrameSingleImage")
      : t("node.videoOps.modeDisabled.imageToVideoSingleImage");
  }
  if (mode === "firstLastFrame" && upstreamCounts.images > 2) {
    return t("node.videoOps.modeDisabled.moreThanTwoImages");
  }
  return null;
}

function GenModeSelect({ value, modelId, supportedModes, upstreamCounts, onChange }: GenModeSelectProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [hoveredKey, setHoveredKey] = useState<VideoGenMode | null>(null);
  const [popoverPosition, setPopoverPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  // HappyHorse's mode panel splits first frame and single-image overall reference into separate entries.
  //   - Hide "first-last-frame" and "all reference": HappyHorse has neither capability, and clicking would only error.
  //   - First frame and image-to-video are two separate modes: the former locks the first frame, the latter uses the single image as an overall reference.
  //   - Once video is connected upstream, image-type entries are hidden, leaving only "text-to-video" (disabled) and "video edit".
  // Non-HappyHorse does not expose "video edit" (it is HappyHorse-only).
  const visibleTabs = useMemo(() => {
    if (supportedModes?.length) {
      const configuredModel = { apiModel: modelId ?? undefined, supportedModes };
      return MODE_TABS.filter((tab) => isVideoModeSupportedByModel(tab.key, configuredModel));
    }
    if (!isHappyHorseVideoModel(modelId)) {
      // Filtered by model capability rather than "non-HappyHorse always gets everything": Seedance 1.x does not support
      // all reference (400) or true-last-frame first-last-frame (last frame silently dropped), so those two tabs are invisible to it.
      return MODE_TABS.filter((tab) => isVideoModeSupportedByModel(tab.key, modelId));
    }
    const order =
      upstreamCounts.videos > 0
        ? (["textToVideo", "videoEdit"] as VideoGenMode[])
        : HAPPYHORSE_TAB_ORDER;
    return order
      .map((key) => MODE_TABS.find((tab) => tab.key === key))
      .filter((tab): tab is (typeof MODE_TABS)[number] => Boolean(tab));
  }, [modelId, supportedModes, upstreamCounts.videos]);
  const activeTab = visibleTabs.find((tab) => tab.key === value) ?? visibleTabs[0];

  const syncPopoverPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const margin = 8;
    setPopoverPosition({
      left: Math.min(Math.max(margin, rect.left), window.innerWidth - 132 - margin),
      top: rect.bottom + 8,
    });
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setHoveredKey(null);
      return;
    }
    syncPopoverPosition();
    const onPointerDown = (event: MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        popoverRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setIsOpen(false);
    };
    const onViewportChange = () => syncPopoverPosition();
    document.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [isOpen, syncPopoverPosition]);

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        className={NODE_CONTEXT_CONTROL_TRIGGER_CLASS}
      >
        <span>{t(activeTab.labelKey)}</span>
        <ChevronDown className="h-3 w-3 text-text-muted/90" />
      </button>
      {isOpen && popoverPosition && createPortal(
        <div
          ref={popoverRef}
          className={VIDEO_MODE_POPOVER_CLASS}
          style={{
            left: popoverPosition.left,
            top: popoverPosition.top,
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {visibleTabs.map((tab) => {
            const isActive = tab.key === value;
            const disabledReason = videoModeDisabledReason(
              tab.key,
              modelId,
              upstreamCounts,
              t,
              supportedModes,
            );
            const isDisabled = disabledReason != null && !isActive;
            // A disabled button fires no mouse events in most browsers, so the hover hint hangs on the outer div;
            // the hint bubble is positioned to the right of the menu, consistent with the design.
            return (
              <div
                key={tab.key}
                className="relative"
                onMouseEnter={() =>
                  isDisabled ? setHoveredKey(tab.key) : setHoveredKey(null)
                }
                onMouseLeave={() =>
                  setHoveredKey((prev) => (prev === tab.key ? null : prev))
                }
              >
                <button
                  type="button"
                  disabled={isDisabled}
                  onClick={() => {
                    if (isDisabled) return;
                    onChange(tab.key);
                    setIsOpen(false);
                  }}
                  className={`block w-full rounded-[6px] px-3 py-1.5 text-left text-xs transition-colors ${
                    isActive
                      ? VIDEO_PARAM_ACTIVE_BUTTON_CLASS
                      : isDisabled
                        ? "cursor-not-allowed text-text-muted/40"
                        : "text-text-muted/95 hover:bg-white/[0.11] hover:text-text-dark"
                  }`}
                >
                  {t(tab.labelKey)}
                </button>
                {isDisabled && hoveredKey === tab.key && disabledReason && (
                  <div className={VIDEO_MODE_TOOLTIP_CLASS}>{disabledReason}</div>
                )}
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

interface VideoConfigChipProps {
  followInputAspectRatio: boolean;
  followInputDuration: boolean;
  aspectRatio: FreezoneVideoAspectRatio;
  aspectRatioOptions: readonly FreezoneVideoAspectRatio[];
  quality: VideoGenQuality;
  qualityOptions: readonly VideoGenQuality[];
  durationSec: number;
  durationBounds: { min: number; max: number };
  sceneOptimize?: Seedance2SceneOptimize;
  sceneOptimizeOptions: readonly Seedance2SceneOptimize[];
  supportsGenerateAudio: boolean;
  generateAudio: boolean;
  onChange: (patch: Partial<VideoNodeData>) => void;
}

function VideoConfigChip({
  followInputAspectRatio,
  followInputDuration,
  aspectRatio,
  aspectRatioOptions,
  quality,
  qualityOptions,
  durationSec,
  durationBounds,
  sceneOptimize,
  sceneOptimizeOptions,
  supportsGenerateAudio,
  generateAudio,
  onChange,
}: VideoConfigChipProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  // Local draft for the direct-entry duration box. The field stays free text
  // while editing so a half-typed value isn't fought by clamping, but we still
  // want the slider and bottom chip to track the box live — so on each keystroke
  // we commit as soon as the draft is a *complete integer already inside* the
  // model's bounds. An out-of-range interim (the "1" of "12" when min is 5) is
  // held as draft only and NOT committed, so the user is never stranded at the
  // min mid-typing; blur/Enter clamps anything still out of range on the way out.
  const [durationDraft, setDurationDraft] = useState<string>(String(durationSec));
  useEffect(() => {
    setDurationDraft(String(durationSec));
  }, [durationSec]);
  const handleDurationInput = (raw: string) => {
    setDurationDraft(raw);
    const parsed = Number(raw);
    if (
      raw.trim() !== "" &&
      Number.isInteger(parsed) &&
      parsed >= durationBounds.min &&
      parsed <= durationBounds.max &&
      parsed !== durationSec
    ) {
      onChange({ durationSec: parsed });
    }
  };
  const commitDuration = () => {
    const parsed = Number(durationDraft);
    if (durationDraft.trim() === "" || !Number.isFinite(parsed)) {
      setDurationDraft(String(durationSec)); // revert empty/garbage to current
      return;
    }
    const clamped = clampVideoDuration(parsed, durationBounds);
    setDurationDraft(String(clamped));
    if (clamped !== durationSec) onChange({ durationSec: clamped });
  };

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        popoverRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setIsOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [isOpen]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        className={NODE_TEXT_CONTROL_TRIGGER_CLASS}
      >
        <span>
          {followInputAspectRatio || aspectRatio === "auto"
            ? t("node.videoNode.aspect.auto")
            : aspectRatio}
        </span>
        <span className="text-text-muted/80">·</span>
        <span>{formatResolutionLabel(quality)}</span>
        {!followInputDuration && (
          <>
            <span className="text-text-muted/80">·</span>
            <span>{durationSec}s</span>
          </>
        )}
        {supportsGenerateAudio && (
          generateAudio ? (
            <Volume2 className="ml-0.5 h-3.5 w-3.5 text-text-muted/90" />
          ) : (
            <VolumeX className="ml-0.5 h-3.5 w-3.5 text-text-muted/90" />
          )
        )}
        <ChevronDown className="h-3 w-3 text-text-muted/90" />
      </button>
      {isOpen && (
        <div
          ref={popoverRef}
          className={VIDEO_PARAM_POPOVER_CLASS}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {!followInputAspectRatio && (
            <>
              <div className={VIDEO_PARAM_LABEL_CLASS}>
                {t("node.videoNode.aspect.title")}
              </div>
              <div className={`grid grid-cols-5 ${VIDEO_PARAM_ROW_CLASS}`}>
                {aspectRatioOptions.map((ratio) => {
                  const isActive = aspectRatio === ratio;
                  return (
                    <button
                      key={ratio}
                      type="button"
                      onClick={() => onChange({ aspectRatio: ratio })}
                      className={`${VIDEO_PARAM_BUTTON_BASE_CLASS} ${
                        isActive
                          ? VIDEO_PARAM_ACTIVE_BUTTON_CLASS
                          : VIDEO_PARAM_IDLE_BUTTON_CLASS
                      }`}
                    >
                      {ratio === "auto" ? t("node.videoNode.aspect.auto") : ratio}
                    </button>
                  );
                })}
              </div>
            </>
          )}
          {followInputAspectRatio && (
            <>
              <div className={VIDEO_PARAM_LABEL_CLASS}>
                {t("node.videoNode.aspect.title")}
              </div>
              <div className={`grid grid-cols-5 ${VIDEO_PARAM_ROW_CLASS}`}>
                <button
                  type="button"
                  disabled
                  className={`${VIDEO_PARAM_BUTTON_BASE_CLASS} ${VIDEO_PARAM_ACTIVE_BUTTON_CLASS} cursor-not-allowed`}
                >
                  {t("node.videoNode.aspect.auto")}
                </button>
              </div>
            </>
          )}

          <div className={VIDEO_PARAM_LABEL_CLASS}>
            {t("node.videoNode.quality.title")}
          </div>
          <div className={`grid grid-cols-3 ${VIDEO_PARAM_ROW_CLASS}`}>
            {qualityOptions.map((q) => {
              const isActive = quality === q;
              return (
                <button
                  key={q}
                  type="button"
                  onClick={() => onChange({ quality: q })}
                  className={`${VIDEO_PARAM_BUTTON_BASE_CLASS} ${
                    isActive
                      ? VIDEO_PARAM_ACTIVE_BUTTON_CLASS
                      : VIDEO_PARAM_IDLE_BUTTON_CLASS
                  }`}
                >
                  {formatResolutionLabel(q)}
                </button>
              );
            })}
          </div>

          {!followInputDuration && (
            <>
              <div className={VIDEO_PARAM_LABEL_CLASS}>
                {t("node.videoNode.duration.title")}
              </div>
              <div className="mb-4 flex items-center gap-3">
            <input
              type="range"
              min={durationBounds.min}
              max={durationBounds.max}
              step={1}
              value={durationSec}
              onChange={(event) =>
                onChange({
                  durationSec: clampVideoDuration(Number(event.target.value), durationBounds),
                })
              }
              className="video-duration-slider min-w-0 flex-1"
            />
            <div className="flex shrink-0 items-center gap-1">
              <input
                type="number"
                inputMode="numeric"
                min={durationBounds.min}
                max={durationBounds.max}
                step={1}
                value={durationDraft}
                onChange={(event) => handleDurationInput(event.target.value)}
                onBlur={commitDuration}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitDuration();
                    event.currentTarget.blur();
                  }
                }}
                aria-label={t("node.videoNode.duration.title")}
                className="h-7 w-12 rounded border border-white/12 bg-white/[0.07] px-1.5 text-center text-xs tabular-nums text-text-dark outline-none transition-colors focus:border-white/28 focus:bg-white/[0.11] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <span className="text-[11px] text-text-muted/80">s</span>
            </div>
              </div>
            </>
          )}

          {sceneOptimizeOptions.length > 0 && (
            <>
              <div className={VIDEO_PARAM_LABEL_CLASS}>
                {t("node.videoNode.sceneOptimize.title")}
              </div>
              <div className={`grid grid-cols-2 ${VIDEO_PARAM_ROW_CLASS}`}>
                {sceneOptimizeOptions.map((option) => {
                  const isActive = sceneOptimize === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      onClick={() => onChange({ sceneOptimize: option })}
                      className={`${VIDEO_PARAM_BUTTON_BASE_CLASS} ${
                        isActive
                          ? VIDEO_PARAM_ACTIVE_BUTTON_CLASS
                          : VIDEO_PARAM_IDLE_BUTTON_CLASS
                      }`}
                    >
                      {t(`node.videoNode.sceneOptimize.options.${option}`)}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {supportsGenerateAudio && (
            <>
              <div className={VIDEO_PARAM_LABEL_CLASS}>
                {t("node.videoNode.audio.title")}
              </div>
              <div className="flex items-center justify-between rounded-md bg-white/[0.045] px-2.5 py-1.5">
                <span className="text-xs font-medium text-text-dark/88">
                  {generateAudio
                    ? t("node.videoNode.audio.on")
                    : t("node.videoNode.audio.off")}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={generateAudio}
                  aria-label={t("node.videoNode.audio.title")}
                  onClick={() => onChange({ generateAudio: !generateAudio })}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
                    generateAudio
                      ? "border-white/24 bg-white/[0.18]"
                      : "border-white/10 bg-white/[0.08]"
                  }`}
                >
                  <span
                    className={`h-4 w-4 rounded-full bg-text-dark shadow-[0_2px_8px_rgba(0,0,0,0.35)] transition-transform ${
                      generateAudio ? "translate-x-[18px]" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface CameraMovementChipProps {
  templates: ReadonlyArray<CameraMovementPreset>;
  isLoading: boolean;
  selectedId: string | null;
  onChange: (next: string | null) => void;
}

const CAMERA_MOVEMENT_POPOVER_WIDTH = 640;
const CAMERA_MOVEMENT_POPOVER_MAX_HEIGHT = 560;
const CAMERA_MOVEMENT_POPOVER_GAP = 8;

function CameraMovementChip({
  templates,
  isLoading,
  selectedId,
  onChange,
}: CameraMovementChipProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(
    null,
  );

  // Position above the chip whenever it opens or the viewport changes. We
  // render the popover into <body> via portal so it can sit above the
  // react-flow NodeToolbar (z-[120]) — without portal it lives inside the
  // video node's transformed stacking context and gets covered.
  useEffect(() => {
    if (!isOpen) return;
    const updateAnchor = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const popHeight = Math.min(
        CAMERA_MOVEMENT_POPOVER_MAX_HEIGHT,
        rect.top - CAMERA_MOVEMENT_POPOVER_GAP - 8,
      );
      const wantTop = rect.top - popHeight - CAMERA_MOVEMENT_POPOVER_GAP;
      // If we can't fit above, fall back to below.
      const top =
        wantTop < 8 ? rect.bottom + CAMERA_MOVEMENT_POPOVER_GAP : wantTop;
      const wantLeft = rect.left;
      const left = Math.max(
        8,
        Math.min(
          wantLeft,
          window.innerWidth - CAMERA_MOVEMENT_POPOVER_WIDTH - 8,
        ),
      );
      setAnchor({ left, top });
    };
    updateAnchor();
    window.addEventListener("resize", updateAnchor);
    window.addEventListener("scroll", updateAnchor, true);
    return () => {
      window.removeEventListener("resize", updateAnchor);
      window.removeEventListener("scroll", updateAnchor, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        popoverRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setIsOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [isOpen]);

  const selectedPreset = findCameraMovementPreset(templates, selectedId);
  const label = selectedPreset ? cameraMovementPresetLabel(selectedPreset, t) : t("canvas.cameraMovement.title");
  const isActive = Boolean(selectedPreset);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        className={`${NODE_TEXT_CONTROL_TRIGGER_CLASS} group/camera px-1.5 ${isActive ? "text-text-dark" : ""}`}
      >
        <Film className={`${NODE_TEXT_CONTROL_ICON_CLASS} group-hover/camera:text-text-dark`} />
        <span>{label}</span>
      </button>
      {isOpen &&
        anchor &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed z-[10000]"
            style={{ left: anchor.left, top: anchor.top }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <CameraMovementPickerPopover
              templates={templates}
              isLoading={isLoading}
              selectedId={selectedId}
              onConfirm={(nextId) => {
                onChange(nextId);
                setIsOpen(false);
              }}
              onClose={() => setIsOpen(false)}
            />
          </div>,
          document.body,
        )}
    </>
  );
}

interface CharacterLibraryChipProps {
  onOpen: () => void;
}

function CharacterLibraryChip({ onOpen }: CharacterLibraryChipProps) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      className={`${NODE_TEXT_CONTROL_TRIGGER_CLASS} group/asset px-1.5`}
    >
      <Library className={`${NODE_TEXT_CONTROL_ICON_CLASS} group-hover/asset:text-text-dark`} />
      <span>{t("canvas.assetLibrary.title")}</span>
    </button>
  );
}

interface CountPickerProps {
  value: VideoGenCount;
  onChange: (next: VideoGenCount) => void;
}

function CountPicker({ value, onChange }: CountPickerProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        popoverRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setIsOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [isOpen]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        className={NODE_TEXT_CONTROL_TRIGGER_CLASS}
      >
        <span>{t("node.videoNode.count.format", { count: value })}</span>
        <ChevronUp className="h-3 w-3 text-text-muted/90" />
      </button>
      {isOpen && (
        <div
          ref={popoverRef}
          className={NODE_COUNT_POPOVER_CLASS}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {COUNT_OPTIONS.map((option) => {
            const isActive = option === value;
            return (
              <button
                key={option}
                type="button"
                onClick={() => {
                  onChange(option);
                  setIsOpen(false);
                }}
                className={`${VIDEO_COUNT_OPTION_BASE_CLASS} ${
                  isActive
                    ? VIDEO_PARAM_ACTIVE_BUTTON_CLASS
                    : "text-text-muted/95 hover:bg-white/[0.11] hover:text-text-dark"
                }`}
              >
                {t("node.videoNode.count.format", { count: option })}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface ReferenceMediaCapEntry {
  item: ReferenceMediaItem;
  /** 1-based same-type index (image/video/audio each accumulate), aligned with the chip badge + @ mention. */
  typeIndex: number;
  /** Whether within the current mode's reference cap; modes absent from the table default to true. */
  withinCap: boolean;
}

interface ReferenceMediaRowProps {
  items: ReadonlyArray<ReferenceMediaCapEntry>;
  caps: { image: number; video: number; audio: number } | null;
  /** The current genMode; used to decide whether the first two images get first-frame/last-frame badges in firstLastFrame mode. */
  genMode: VideoGenMode;
  /**
   * nodeId → this reference's name in the prompt (image1 / video2 …). Ones not in the table get no @ button
   * — assets beyond the current mode's cap never enter the @ candidates anyway, and giving them a button would only insert a number
   * the backend would drop.
   */
  mentionNames: ReadonlyMap<string, string>;
  onFocus: (nodeId: string) => void;
  /** The @ at the lower right: insert this reference into the prompt. */
  onMention: (nodeId: string) => void;
  /** Double-click a chip: the viewport jumps to that asset's position on the canvas. */
  onJump: (nodeId: string) => void;
  onDetach: (nodeId: string) => void;
  // After dragging a chip to reorder, pass back the new "list of upstream node ids in visual order".
  onReorder: (orderedNodeIds: string[]) => void;
}

function ReferenceMediaRow({
  items,
  caps,
  genMode,
  mentionNames,
  onFocus,
  onMention,
  onJump,
  onDetach,
  onReorder,
}: ReferenceMediaRowProps) {
  const { t } = useTranslation();
  // Also manages the "currently playing node" of the whole audio row — only one audio chip may
  // play at a time. Clicking another switches; clicking the same one again pauses.
  const [playingAudioNodeId, setPlayingAudioNodeId] = useState<string | null>(
    null,
  );
  // Temporary drag-reorder state: the chip being dragged / the chip currently hovered as the drop target.
  const [dragNodeId, setDragNodeId] = useState<string | null>(null);
  const [overNodeId, setOverNodeId] = useState<string | null>(null);

  const clearDrag = useCallback(() => {
    setDragNodeId(null);
    setOverNodeId(null);
  }, []);

  const handleDrop = useCallback(
    (targetNodeId: string) => {
      const sourceId = dragNodeId;
      clearDrag();
      if (!sourceId || sourceId === targetNodeId) return;
      const ids = items.map((entry) => entry.item.nodeId);
      const from = ids.indexOf(sourceId);
      const to = ids.indexOf(targetNodeId);
      if (from === -1 || to === -1) return;
      ids.splice(from, 1);
      ids.splice(to, 0, sourceId);
      onReorder(ids);
    },
    [dragNodeId, items, onReorder, clearDrag],
  );

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {items.map((entry) => {
        const { item, typeIndex, withinCap } = entry;
        // "Beyond the current mode's cap" applies only to modes registered in REFERENCE_CAPS_BY_MODE.
        const overCap = caps != null && !withinCap;
        const modeCap = caps?.[item.kind] ?? 0;
        const modeLabel = t(`node.videoOps.modes.${genMode}`, {
          defaultValue: t("node.videoOps.modes.current"),
        });
        const overCapTitle = overCap
          ? t("node.videoOps.overCap", {
              kind: t(`node.videoOps.refKind.${item.kind}`),
              mode: modeLabel,
              cap: modeCap,
              unit: t(
                `node.videoOps.refUnit.${item.kind === "image" ? "image" : "video"}`,
              ),
            })
          : undefined;
        // In first-last-frame mode, the first two images get first-frame/last-frame badges; images beyond the cap fall back to
        // numeric badges, so the user sees "this image is ignored" while still being able to cross-reference it by original index in the prompt
        // — though that state is mainly covered by the auto-switch to allReference and normally does not occur.
        const slotLabel =
          genMode === "firstLastFrame" &&
          item.kind === "image" &&
          withinCap
            ? typeIndex === 1
              ? t("node.videoOps.slot.firstFrame")
              : typeIndex === 2
                ? t("node.videoOps.slot.lastFrame")
                : undefined
            : // Multishot: the first image (by reference order) is always
              // the chain's single start frame (<Picture 1> server-side);
              // the rest are shared references (<Picture 2..N+1>) — no
              // special badge needed for those, the numeric index already
              // shows their order.
              genMode === "multishot" && item.kind === "image" && typeIndex === 1
              ? t("node.videoOps.multishot.startFrameLabel")
              : undefined;
        let chip: ReactNode;
        if (item.kind === "image") {
          chip = (
            <ReferenceImageChip
              item={item}
              index={typeIndex - 1}
              slotLabel={slotLabel}
              mentionName={mentionNames.get(item.nodeId) ?? null}
              onFocus={onFocus}
              onMention={onMention}
              onJump={onJump}
              onDetach={onDetach}
            />
          );
        } else if (item.kind === "video") {
          chip = (
            <ReferenceVideoChip
              item={item}
              index={typeIndex - 1}
              mentionName={mentionNames.get(item.nodeId) ?? null}
              onFocus={onFocus}
              onMention={onMention}
              onJump={onJump}
              onDetach={onDetach}
            />
          );
        } else {
          chip = (
            <ReferenceAudioChip
              item={item}
              index={typeIndex - 1}
              isPlaying={playingAudioNodeId === item.nodeId}
              onToggle={(playing) =>
                setPlayingAudioNodeId(playing ? item.nodeId : null)
              }
              mentionName={mentionNames.get(item.nodeId) ?? null}
              onFocus={onFocus}
              onMention={onMention}
              onJump={onJump}
              onDetach={onDetach}
            />
          );
        }

        const isDragging = dragNodeId === item.nodeId;
        const isDropTarget =
          overNodeId === item.nodeId && dragNodeId !== null && !isDragging;

        return (
          <div
            key={item.nodeId}
            title={overCapTitle}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", item.nodeId);
              setDragNodeId(item.nodeId);
            }}
            onDragOver={(event) => {
              if (!dragNodeId) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              if (overNodeId !== item.nodeId) setOverNodeId(item.nodeId);
            }}
            onDragLeave={() => {
              setOverNodeId((cur) => (cur === item.nodeId ? null : cur));
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              handleDrop(item.nodeId);
            }}
            onDragEnd={clearDrag}
            className={`nodrag relative cursor-grab rounded-md transition active:cursor-grabbing ${
              isDragging ? "opacity-40" : ""
            } ${
              isDropTarget
                ? "ring-2 ring-accent ring-offset-1 ring-offset-surface-dark"
                : ""
            } ${
              // Chips beyond the omni cap: desaturated + semi-transparent + amber outline; on hover the
              // parent's title shows "Beyond the cap and will not be used". Paired with the detach button prompting the user to
              // remove the excess assets themselves.
              overCap
                ? "opacity-50 grayscale ring-1 ring-amber-400/45 ring-offset-1 ring-offset-surface-dark"
                : ""
            }`}
          >
            {chip}
            {overCap && (
              <span className="pointer-events-none absolute -bottom-1 -left-1 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-amber-500/90 text-[10px] font-bold leading-none text-surface-dark shadow ring-1 ring-surface-dark">
                !
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function useHoverPreviewPos(
  buttonRef: React.RefObject<HTMLElement | null>,
  width: number,
) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const PREVIEW_OFFSET = 10;
  const show = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(
      8,
      Math.min(
        window.innerWidth - width - 8,
        rect.left + rect.width / 2 - width / 2,
      ),
    );
    const top = rect.top - PREVIEW_OFFSET;
    setPos({ left, top });
  }, [buttonRef, width]);
  const hide = useCallback(() => setPos(null), []);
  return { pos, show, hide };
}

interface ReferenceImageChipProps {
  item: Extract<ReferenceMediaItem, { kind: "image" }>;
  index: number;
  /** Custom copy shown on the badge (such as "First frame" / "Last frame"). When unset the numeric badge is used. */
  slotLabel?: string;
  /** This reference's name in the prompt; null means it is not in the @ candidates and no @ button is shown. */
  mentionName: string | null;
  onFocus: (nodeId: string) => void;
  onMention: (nodeId: string) => void;
  onJump: (nodeId: string) => void;
  onDetach: (nodeId: string) => void;
}

function ReferenceImageChip({
  item,
  index,
  slotLabel,
  mentionName,
  onFocus,
  onMention,
  onJump,
  onDetach,
}: ReferenceImageChipProps) {
  const { t } = useTranslation();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const PREVIEW_W = 140;
  const { pos, show, hide } = useHoverPreviewPos(buttonRef, PREVIEW_W);
  const label =
    item.displayName?.trim()
    || slotLabel
    || t("node.videoOps.chip.imageFallback", { index: index + 1 });

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onFocus(item.nodeId);
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          hide();
          onJump(item.nodeId);
        }}
        onMouseEnter={show}
        onMouseLeave={hide}
        className={`nodrag ${NODE_REFERENCE_MEDIA_CHIP_CLASS}`}
        title={label}
      >
        <img
          src={resolveImageDisplayUrl(item.imageUrl)}
          alt={label}
          className="h-full w-full object-cover"
          draggable={false}
        />
        {slotLabel ? (
          // First/last-frame badges: structural info (not an index), kept. Per product requirements the frontend no longer shows
          // numeric badges like "image N" — references are presented uniformly as "Image", and the index exists only in the prompt (@image1)
          // submitted to the backend, not exposed on the reference thumbnails.
          <span
            className="pointer-events-none absolute bottom-1 left-1 z-10 text-[9px] font-medium leading-none text-white"
            style={{ textShadow: "0 0 2px rgba(0,0,0,0.65), 0 1px 1px rgba(0,0,0,0.55)" }}
          >
            {slotLabel}
          </span>
        ) : null}
        {mentionName ? (
          <ReferenceMentionButton
            mentionName={mentionName}
            onInsert={() => {
              hide();
              onMention(item.nodeId);
            }}
          />
        ) : null}
        <ReferenceDetachButton
          nodeId={item.nodeId}
          onDetach={onDetach}
          className={NODE_REFERENCE_MEDIA_DETACH_CLASS}
        />
      </button>
      {pos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[400] -translate-y-full"
            style={{ left: pos.left, top: pos.top, width: PREVIEW_W }}
          >
            <div className="overflow-hidden rounded-xl border border-white/15 bg-surface-dark/95 shadow-2xl backdrop-blur-sm">
              <img
                src={resolveImageDisplayUrl(item.imageUrl)}
                alt={label}
                className="block h-auto w-full object-contain"
                draggable={false}
              />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

interface ReferenceVideoChipProps {
  item: Extract<ReferenceMediaItem, { kind: "video" }>;
  index: number;
  /** This reference's name in the prompt; null means it is not in the @ candidates and no @ button is shown. */
  mentionName: string | null;
  onFocus: (nodeId: string) => void;
  onMention: (nodeId: string) => void;
  onJump: (nodeId: string) => void;
  onDetach: (nodeId: string) => void;
}

function ReferenceVideoChip({
  item,
  index,
  mentionName,
  onFocus,
  onMention,
  onJump,
  onDetach,
}: ReferenceVideoChipProps) {
  const { t } = useTranslation();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const PREVIEW_W = 140;
  const { pos, show, hide } = useHoverPreviewPos(buttonRef, PREVIEW_W);
  const label =
    item.displayName?.trim()
    || t("node.videoOps.chip.videoFallback", { index: index + 1 });

  // Chip thumbnail: use the static image when there is a previewImageUrl; otherwise use a muted still <video>
  // to show the first frame. preload=metadata lets Safari/Chrome position to the first frame automatically.
  const thumb = item.thumbUrl ? (
    <img
      src={resolveImageDisplayUrl(item.thumbUrl)}
      alt={label}
      className="h-full w-full object-cover"
      draggable={false}
    />
  ) : (
    <video
      src={resolveImageDisplayUrl(item.videoUrl)}
      className="h-full w-full object-cover"
      muted
      playsInline
      preload="metadata"
      draggable={false}
    />
  );

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onFocus(item.nodeId);
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          hide();
          onJump(item.nodeId);
        }}
        onMouseEnter={show}
        onMouseLeave={hide}
        className={`nodrag ${NODE_REFERENCE_MEDIA_CHIP_CLASS}`}
        title={label}
      >
        {thumb}
        {mentionName ? (
          <ReferenceMentionButton
            mentionName={mentionName}
            onInsert={() => {
              hide();
              onMention(item.nodeId);
            }}
          />
        ) : null}
        <ReferenceDetachButton
          nodeId={item.nodeId}
          onDetach={onDetach}
          className={NODE_REFERENCE_MEDIA_DETACH_CLASS}
        />
      </button>
      {pos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[400] -translate-y-full"
            style={{ left: pos.left, top: pos.top, width: PREVIEW_W }}
          >
            <div className="overflow-hidden rounded-xl border border-white/15 bg-surface-dark/95 shadow-2xl backdrop-blur-sm">
              {/* On hover autoplay + loop + muted — no sound, so other playing
                  audio chips are not disturbed. */}
              <video
                src={resolveImageDisplayUrl(item.videoUrl)}
                autoPlay
                loop
                muted
                playsInline
                className="block h-auto w-full object-contain"
              />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

interface ReferenceAudioChipProps {
  item: Extract<ReferenceMediaItem, { kind: "audio" }>;
  index: number;
  isPlaying: boolean;
  onToggle: (playing: boolean) => void;
  /** This reference's name in the prompt; null means it is not in the @ candidates and no @ button is shown. */
  mentionName: string | null;
  onFocus: (nodeId: string) => void;
  onMention: (nodeId: string) => void;
  onJump: (nodeId: string) => void;
  onDetach: (nodeId: string) => void;
}

function ReferenceAudioChip({
  item,
  index,
  isPlaying,
  onToggle,
  mentionName,
  onFocus,
  onMention,
  onJump,
  onDetach,
}: ReferenceAudioChipProps) {
  const { t } = useTranslation();
  // Hold an HTMLAudioElement with a ref — simpler than a <audio> hung on the DOM: it can
  // be .play()/.pause() directly, and it is also easier to handle the "only one plays at a time" logic (the parent tells this
  // chip it is no longer the one currently playing).
  const audioRef = useRef<HTMLAudioElement | null>(null);
  if (audioRef.current === null && typeof Audio !== "undefined") {
    audioRef.current = new Audio();
  }

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const src = resolveImageDisplayUrl(item.audioUrl);
    if (audio.src !== src) {
      audio.src = src;
    }
  }, [item.audioUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      void audio.play().catch(() => {
        // Autoplay blocked by the browser or resource loading failed — roll back the parent state.
        onToggle(false);
      });
    } else {
      audio.pause();
    }
  }, [isPlaying, onToggle]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const handleEnded = () => onToggle(false);
    audio.addEventListener("ended", handleEnded);
    return () => audio.removeEventListener("ended", handleEnded);
  }, [onToggle]);

  // Stop playback on unmount, so no dirty state is left in the browser.
  useEffect(() => {
    return () => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.pause();
      audio.src = "";
    };
  }, []);

  const label =
    item.displayName?.trim()
    || t("node.videoOps.chip.audioFallback", { index: index + 1 });

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        // Single click: toggle playback; also move focus to the upstream node (convenient for the user to jump over and look).
        onFocus(item.nodeId);
        onToggle(!isPlaying);
      }}
      onDoubleClick={(event) => {
        // Double-click jumps to that audio node on the canvas. The playback toggle gets clicked into "on then off" by these two clicks,
        // which lands exactly back at the pre-double-click state, so no extra suppression is needed.
        event.stopPropagation();
        onJump(item.nodeId);
      }}
      className={`group/refmedia nodrag relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border transition-colors ${
        isPlaying
          ? "border-accent/60 bg-[rgb(var(--accent-rgb)/0.15)]"
          : "border-white/10 bg-white/[0.04] hover:border-white/30"
      }`}
      title={label}
    >
      {isPlaying ? (
        <Pause className="h-4 w-4 text-accent" />
      ) : (
        <Music className="h-4 w-4 text-text-dark/90" />
      )}
      {mentionName ? (
        <ReferenceMentionButton
          mentionName={mentionName}
          onInsert={() => onMention(item.nodeId)}
        />
      ) : null}
      <ReferenceDetachButton
        nodeId={item.nodeId}
        onDetach={onDetach}
        className={NODE_REFERENCE_MEDIA_DETACH_CLASS}
      />
    </button>
  );
}
