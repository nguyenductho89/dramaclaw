// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { TFn } from "@/lib/i18n-types";
import {
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Film,
  Languages,
  Library,
  Loader2,
  Music,
  Pause,
  Plus,
  Volume2,
  VolumeX,
} from "lucide-react";

import type {
  Seedance2SceneOptimize,
  VideoGenCount,
  VideoGenMode,
  VideoGenQuality,
  VideoNodeData,
} from "@/features/canvas/domain/canvasNodes";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import type { UpstreamContent } from "@/features/canvas/application/ports";
import type {
  FreezoneVideoAspectRatio,
  MediaModelParameterDefinition,
} from "@/api/ops";
import { useModelTaskAccess } from "@/lib/model-task-access";
import { useCanvasStore } from "@/stores/canvasStore";
import { ReferenceTextChip } from "@/features/canvas/nodes/shared/ReferenceTextChip";
import { ReferenceDetachButton } from "@/features/canvas/nodes/shared/ReferenceDetachButton";
import {
  clampVideoDuration,
  isHappyHorseVideoModel,
  type ReferenceMediaCapEntry,
  type ReferenceMediaItem,
} from "@/features/canvas/nodes/shared/videoFormOptions";
import {
  isVideoModeSupportedByModel,
  videoModelReferenceDisabledReason,
  videoModeMissingInputReason,
  type VideoModeInputCounts,
} from "@/features/canvas/nodes/shared/videoModelCapabilities";
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
import { CameraMovementPickerPopover } from "@/features/canvas/nodes/CameraMovementPickerPopover";
import {
  findCameraMovementPreset,
  type CameraMovementPreset,
} from "@/features/canvas/domain/cameraMovementPresets";
import { ProviderModelPicker } from "@/features/canvas/ui/ProviderModelPicker";
import {
  filterMediaModelParamsForMode,
  MediaModelParameterChip,
} from "@/features/canvas/ui/MediaModelParameterChip";
import {
  CreditCostPill,
  type CreditPromotionDisplay,
} from "@/components/credits/credit-visual";
import { CANVAS_NODE_INPUT_PLACEHOLDER_CLASS } from "@/features/canvas/ui/nodeFrameStyles";
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

const MODE_TABS: ReadonlyArray<{ key: VideoGenMode; labelKey: string }> = [
  { key: "textToVideo", labelKey: "node.videoNode.tabs.textToVideo" },
  { key: "allReference", labelKey: "node.videoNode.tabs.allReference" },
  { key: "firstFrame", labelKey: "node.videoNode.tabs.firstFrame" },
  { key: "imageToVideo", labelKey: "node.videoNode.tabs.imageToVideo" },
  { key: "firstLastFrame", labelKey: "node.videoNode.tabs.firstLastFrame" },
  { key: "imageReference", labelKey: "node.videoNode.tabs.imageReference" },
  { key: "videoEdit", labelKey: "node.videoNode.tabs.videoEdit" },
  { key: "videoExtend", labelKey: "node.videoNode.tabs.videoExtend" },
];

// HappyHorse mode panel order: text-to-video → first frame → image reference → video edit.
// One to one with the 4 major functions of the upstream docs, and consistent with the product design.
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

interface GenModeSelectProps {
  value: VideoGenMode;
  modelId: string | null | undefined;
  supportedModes?: string[];
  upstreamCounts: VideoModeInputCounts;
  onChange: (next: VideoGenMode) => void;
}

export function videoModeDisabledReason(
  mode: VideoGenMode,
  modelId: string | null | undefined,
  upstreamCounts: VideoModeInputCounts,
  t: TFn,
  supportedModes?: string[],
): string | null {
  // HappyHorse's mode availability is decided entirely by the upstream node type (the 4 major functions in the docs):
  //   text-to-video — available only with no upstream
  //   first frame   — available only when there is exactly 1 upstream image
  //   image reference — available with 1~9 upstream images
  //   video edit    — available only with 1 upstream video
  // When unavailable, return hover copy (telling the user what needs to be connected).
  if (isHappyHorseVideoModel(modelId)) {
    const { images, videos } = upstreamCounts;
    switch (mode) {
      case "textToVideo":
        if (videos > 0) return t("node.videoOps.modeDisabled.hasVideoUseVideoEdit");
        if (images > 0) return t("node.videoOps.modeDisabled.hasImagePickMode");
        return null;
      case "firstFrame":
        if (videos > 0) return t("node.videoOps.modeDisabled.hasVideoNoFirstFrame");
        if (images === 0) return t("node.videoOps.modeDisabled.needOneImage");
        if (images > 1) return t("node.videoOps.modeDisabled.firstFrameSingleImage");
        return null;
      case "imageToVideo":
        if (videos > 0) return t("node.videoOps.modeDisabled.hasVideoNoImageToVideo");
        if (images === 0) return t("node.videoOps.modeDisabled.needOneImage");
        if (images > 1) return t("node.videoOps.modeDisabled.imageToVideoSingleImageUseRef");
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
  // "Video edit" takes the upstream video **as input**, and must not be implicated by the rule below, "with a video only all reference is left".
  // It and "all reference" are the only two modes that consume video assets — the submit guard
  // `videoSubmitMediaRejectionReason` already says `mode !== "allReference" && mode !==
  // "videoEdit"`, and the same exemption was missed here. Video edit was once HappyHorse-only (see the comment of
  // `isVideoModeSupportedByModel`), later models in the catalog such as seedance-2.0-mini
  // also declared `video_edit`, and the tab showed up yet was grayed out together by this old rule, so "connected a video and wanted to switch to
  // video edit" was blocked by ourselves.
  const model = supportedModes?.length
    ? { apiModel: modelId ?? undefined, supportedModes }
    : modelId;
  const supportsVideoEdit = isVideoModeSupportedByModel("videoEdit", model);
  if (mode === "videoEdit") {
    if (!supportsVideoEdit) return t("node.videoOps.modeDisabled.modelNoVideoEdit");
    if (upstreamCounts.videos === 0) return t("node.videoOps.modeDisabled.needOneVideo");
    if (upstreamCounts.videos > 1) return t("node.videoOps.modeDisabled.videoEditSingleVideo");
    return null;
  }
  if (mode === "videoExtend") {
    if (!isVideoModeSupportedByModel("videoExtend", model)) return t("node.videoOps.modeDisabled.modelNoVideoExtend");
    if (upstreamCounts.videos !== 1 || upstreamCounts.images > 0 || upstreamCounts.audios > 0) {
      return t("node.videoModel.reason.videoExtendSourceOnly");
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
  if (mode === "imageToVideo" && upstreamCounts.videos >= 2) {
    return t("canvasNodes.videoForm.multipleVideosUnavailable");
  }
  if (mode === "firstLastFrame" && upstreamCounts.images > 2) {
    return t("node.videoOps.modeDisabled.moreThanTwoImages");
  }
  const missingInputReason = videoModeMissingInputReason(mode, upstreamCounts);
  return missingInputReason ? t(missingInputReason) : null;
}

function GenModeSelect({
  value,
  modelId,
  supportedModes,
  upstreamCounts,
  onChange,
}: GenModeSelectProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [hoveredKey, setHoveredKey] = useState<VideoGenMode | null>(null);
  const [popoverPosition, setPopoverPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  // The HappyHorse mode panel aligns with the 4 major functions in the docs: text-to-video / first frame / image reference / video edit.
  //   - Hide "first-last-frame" and "all reference": HappyHorse has neither capability, and clicking would only error.
  //   - Show "image-to-video" as "first frame": it is a single-image first-frame i2v to begin with, and calling it "first frame" directly makes it instantly distinguishable from "image
  //     reference".
  //   - Once video is connected upstream, the "first frame" and "image reference" entries are hidden entirely (docs: under a video node there are no such two
  //     options), leaving only "text-to-video" (disabled) and "video edit".
  // Non-HappyHorse does not expose "video edit" (it is HappyHorse-only).
  // When the media catalog declares supportedModes it prevails entirely (the Admin config is the latest fact),
  // and the model-id inference rules below are only a fallback when nothing is configured.
  const visibleTabs = useMemo(() => {
    if (supportedModes?.length) {
      const keyMap: Record<VideoGenMode, string> = {
        textToVideo: "text_to_video",
        firstFrame: "first_frame",
        imageToVideo: "image_reference",
        firstLastFrame: "first_last_frame",
        imageReference: "image_reference",
        allReference: "all_reference",
        videoEdit: "video_edit",
        videoExtend: "video_extend",
        // Multishot has no tab in this (asset-board) form's own MODE_TABS —
        // only the canvas VideoOperationsPanel supports it — so this entry
        // exists purely to satisfy Record<VideoGenMode, string>; it is
        // never looked up.
        multishot: "multishot",
      };
      return MODE_TABS.filter((tab) => supportedModes.includes(keyMap[tab.key]));
    }
    if (!isHappyHorseVideoModel(modelId)) {
      return MODE_TABS.filter((tab) =>
        isVideoModeSupportedByModel(tab.key, modelId),
      );
    }
    const order =
      upstreamCounts.videos > 0
        ? (["textToVideo", "videoEdit"] as VideoGenMode[])
        : HAPPYHORSE_TAB_ORDER;
    return order
      .map((key) => MODE_TABS.find((tab) => tab.key === key))
      .filter((tab): tab is (typeof MODE_TABS)[number] => Boolean(tab))
      .map((tab) =>
        tab.key === "imageToVideo"
          ? { ...tab, labelKey: "node.videoNode.tabs.firstFrame" }
          : tab,
      );
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
            const isDisabled = disabledReason != null;
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
                    isDisabled
                      ? "cursor-not-allowed text-text-muted/40"
                      : isActive
                        ? VIDEO_PARAM_ACTIVE_BUTTON_CLASS
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
  aspectRatio: FreezoneVideoAspectRatio;
  aspectRatioOptions: readonly FreezoneVideoAspectRatio[];
  quality: VideoGenQuality;
  qualityOptions: readonly VideoGenQuality[];
  durationSec: number;
  durationBounds: { min: number; max: number };
  sceneOptimize?: Seedance2SceneOptimize;
  sceneOptimizeOptions: readonly Seedance2SceneOptimize[];
  generateAudio: boolean;
  onChange: (patch: Partial<VideoNodeData>) => void;
}

function VideoConfigChip({
  aspectRatio,
  aspectRatioOptions,
  quality,
  qualityOptions,
  durationSec,
  durationBounds,
  sceneOptimize,
  sceneOptimizeOptions,
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
          {aspectRatio === "auto"
            ? t("node.videoNode.aspect.auto")
            : aspectRatio}
        </span>
        <span className="text-text-muted/80">·</span>
        <span>{quality}</span>
        <span className="text-text-muted/80">·</span>
        <span>{durationSec}s</span>
        {generateAudio ? (
          <Volume2 className="ml-0.5 h-3.5 w-3.5 text-text-muted/90" />
        ) : (
          <VolumeX className="ml-0.5 h-3.5 w-3.5 text-text-muted/90" />
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
                  {q}
                </button>
              );
            })}
          </div>

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
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
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
  const label = selectedPreset?.label ?? t("canvasNodes.videoForm.cameraMovement");
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
      <span>{t("node.imageGen.assetLibrary")}</span>
    </button>
  );
}

function ExternalAssetChip({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      className={`${NODE_TEXT_CONTROL_TRIGGER_CLASS} group/external px-1.5`}
    >
      <Plus className={`${NODE_TEXT_CONTROL_ICON_CLASS} group-hover/external:text-text-dark`} />
      <span>{t("canvasNodes.videoForm.externalMaterial")}</span>
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

interface ReferenceMediaRowProps {
  items: ReadonlyArray<ReferenceMediaCapEntry>;
  /** Per-type caps of the current mode (including model overrides); null = this mode is unlimited and no chip is grayed out. */
  caps: { image: number; video: number; audio: number } | null;
  /** The current genMode; used to decide whether the first two images get first-frame/last-frame badges in firstLastFrame mode. */
  genMode: VideoGenMode;
  onFocus: (nodeId: string) => void;
  onDetach: (nodeId: string) => void;
  // After dragging a chip to reorder, pass back the new "list of upstream node ids in visual order".
  onReorder: (orderedNodeIds: string[]) => void;
}

function ReferenceMediaRow({
  items,
  caps,
  genMode,
  onFocus,
  onDetach,
  onReorder,
}: ReferenceMediaRowProps) {
  // Also manages the "currently playing node" of the whole audio row — only one audio chip may
  // play at a time. Clicking another switches; clicking the same one again pauses.
  const { t } = useTranslation();
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
    <div className="ml-4 flex shrink-0 items-center gap-1.5">
      {items.map((entry) => {
        const { item, typeIndex, withinCap } = entry;
        // "Beyond the current mode's cap" applies only to modes registered in REFERENCE_CAPS_BY_MODE.
        const overCap = caps != null && !withinCap;
        const modeCap = caps?.[item.kind] ?? 0;
        const modeLabel =
          {
            textToVideo: t("node.videoOps.modes.textToVideo"),
            firstFrame: t("node.videoOps.modes.firstFrame"),
            imageToVideo: t("node.videoOps.modes.imageToVideo"),
            imageReference: t("node.videoOps.modes.imageReference"),
            firstLastFrame: t("node.videoOps.modes.firstLastFrame"),
            videoEdit: t("node.videoOps.modes.videoEdit"),
            videoExtend: t("node.videoNode.tabs.videoExtend"),
            allReference: t("node.videoOps.modes.allReference"),
            // Not reachable from this (asset-board) form — see the
            // keyMap comment above — kept only to satisfy the lookup type.
            multishot: t("node.videoNode.tabs.multishot"),
          }[genMode] ?? t("node.videoOps.modes.current");
        const overCapTitle = overCap
          ? t("node.videoOps.overCap", {
              kind: t(`node.videoOps.refKind.${item.kind}`),
              mode: modeLabel,
              cap: modeCap,
              unit: t(`node.videoOps.refUnit.${item.kind === "image" ? "image" : "video"}`),
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
            : undefined;
        let chip: ReactNode;
        if (item.kind === "image") {
          chip = (
            <ReferenceImageChip
              item={item}
              index={typeIndex - 1}
              slotLabel={slotLabel}
              onFocus={onFocus}
              onDetach={onDetach}
            />
          );
        } else if (item.kind === "video") {
          chip = (
            <ReferenceVideoChip
              item={item}
              index={typeIndex - 1}
              onFocus={onFocus}
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
              onFocus={onFocus}
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
  onFocus: (nodeId: string) => void;
  onDetach: (nodeId: string) => void;
}

function ReferenceImageChip({
  item,
  index,
  slotLabel,
  onFocus,
  onDetach,
}: ReferenceImageChipProps) {
  const { t } = useTranslation();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const PREVIEW_W = 140;
  const { pos, show, hide } = useHoverPreviewPos(buttonRef, PREVIEW_W);
  const label =
    item.displayName?.trim() || slotLabel || t("node.videoOps.chip.imageFallback", { index: index + 1 });

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onFocus(item.nodeId);
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
          // numeric badges like "image N" — references are presented uniformly as "Image", and the index exists only in the prompt
          // (@image1) submitted to the backend, not exposed on the reference thumbnails.
          <span
            className="pointer-events-none absolute bottom-1 left-1 z-10 text-[9px] font-medium leading-none text-white"
            style={{ textShadow: "0 0 2px rgba(0,0,0,0.65), 0 1px 1px rgba(0,0,0,0.55)" }}
          >
            {slotLabel}
          </span>
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
  onFocus: (nodeId: string) => void;
  onDetach: (nodeId: string) => void;
}

function ReferenceVideoChip({ item, index, onFocus, onDetach }: ReferenceVideoChipProps) {
  const { t } = useTranslation();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const PREVIEW_W = 140;
  const { pos, show, hide } = useHoverPreviewPos(buttonRef, PREVIEW_W);
  const label = item.displayName?.trim() || t("node.videoOps.chip.videoFallback", { index: index + 1 });

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
        onMouseEnter={show}
        onMouseLeave={hide}
        className={`nodrag ${NODE_REFERENCE_MEDIA_CHIP_CLASS}`}
        title={label}
      >
        {thumb}
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
  onFocus: (nodeId: string) => void;
  onDetach: (nodeId: string) => void;
}

function ReferenceAudioChip({
  item,
  index,
  isPlaying,
  onToggle,
  onFocus,
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

  const label = item.displayName?.trim() || t("node.videoOps.chip.audioFallback", { index: index + 1 });

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        // Single click: toggle playback; also move focus to the upstream node (convenient for the user to jump over and look).
        onFocus(item.nodeId);
        onToggle(!isPlaying);
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
      <ReferenceDetachButton
        nodeId={item.nodeId}
        onDetach={onDetach}
        className={NODE_REFERENCE_MEDIA_DETACH_CLASS}
      />
    </button>
  );
}

export interface VideoGenerationFormProps {
  /**
   * Target node id: used only as the positioning identifier of buttons inside this component (NodeContextPromptPaletteButton)
   * and as the nodeId when calling useCanvasStore().updateNodeData; it reads no React Flow context.
   */
  nodeId: string;

  // ── Camera movement / asset library / mode / reference chips row ──
  cameraTemplates: ReadonlyArray<CameraMovementPreset>;
  cameraTemplatesLoading: boolean;
  cameraMovementId: string | null;
  onOpenCharacterLibrary: () => void;
  onOpenExternalAssets?: () => void;
  genMode: VideoGenMode;
  /** Model identifier sent to the mode menu to judge availability (prefer apiModel, fall back to id). */
  genModeModelId: string | null | undefined;
  /** Available modes declared by the media catalog (backend keys); when present it prevails, and capability inference is only a fallback. */
  genModeSupportedModes?: string[];
  /**
   * Upstream counts used by the mode menu. **Two separate copies from `modelUpstreamCounts`**: HappyHorse's selectable
   * modes are decided by the upstream node type (including empty nodes with no image filled), while other models count by resolved asset URLs;
   * that conditional judgment stays in the host (VideoNode), and this component only displays.
   */
  genModeUpstreamCounts: VideoModeInputCounts;
  upstreamTextContents: readonly UpstreamContent[];
  onDetachUpstream: (sourceNodeId: string) => void;
  /** Reference assets already ordered by reference order and supplemented with "same-type index + whether within the mode cap". */
  referenceMediaItems: ReadonlyArray<ReferenceMediaCapEntry>;
  /** Per-type asset caps of the current mode (including model overrides); null = this mode is unlimited. */
  referenceCaps: { image: number; video: number; audio: number } | null;

  // ── Prompt editor ──
  // The prompt draft state and IME composition state are held by the host — the retry button of the "generation failed" banner on the node
  // needs to read the same prompt to judge whether it can be submitted, and moving the draft state into this component would make the two places mismatch.
  prompt: string;
  onPromptChange: (next: string) => void;
  onCompositionStart: () => void;
  onCompositionEnd: (next: string) => void;
  mentionCandidates: MentionCandidate[];
  /** Text concatenated from upstream; when non-empty the prompt placeholder copy differs. */
  upstreamTextJoined: string;

  // ── Params row ──
  modelId: string;
  /**
   * Switching models is not a pure patch: when the new model does not support the current genMode the mode must be reset along with it, and
   * the choice is recorded into "inherited by the next newly created video node". This policy stays in the host, and this component only reports the selection.
   */
  onModelChange: (nextModelId: string) => void;
  /** Upstream counts used in the model dropdown to judge "this model cannot take the current assets" (always by resolved asset URLs). */
  modelUpstreamCounts: { images: number; videos: number; audios: number };
  aspectRatio: FreezoneVideoAspectRatio;
  /** Selectable ratios: the model's own if declared in the media catalog, otherwise the built-in 7 presets. */
  aspectRatioOptions: readonly FreezoneVideoAspectRatio[];
  quality: VideoGenQuality;
  qualityOptions: readonly VideoGenQuality[];
  durationSec: number;
  durationBounds: { min: number; max: number };
  sceneOptimize?: Seedance2SceneOptimize;
  sceneOptimizeOptions: readonly Seedance2SceneOptimize[];
  generateAudio: boolean;
  /** The "Human verification" switch shows only for models with humanReview ticked in the media catalog. */
  showHumanReview: boolean;
  humanReview: boolean;
  /** The custom parameter form declared by the selected model (MediaModelParameterChip). */
  modelParameters: MediaModelParameterDefinition[] | undefined;
  modelParams: Record<string, unknown> | undefined;
  count: VideoGenCount;
  isTranslatingPrompt: boolean;
  isGenerating: boolean;
  /**
   * The disabled state of the translate button is computed by the host and passed in (symmetrical with `submitDisabled`): the video node's threshold
   * looks at the **persisted prompt** (`data.prompt`), not the draft in the editor — during IME
   * composition the draft already has characters but has not been written back to the store, and the button should stay disabled then.
   */
  translateDisabled: boolean;
  onTranslate: () => void;

  // ── Submit ──
  totalCreditCostDisplay: string | null;
  /** Paired with `totalCreditCostDisplay`: without it the promo label falls back to the generic "On sale". */
  creditPromotion: CreditPromotionDisplay | null;
  submitDisabled: boolean;
  submitDisabledReason?: string | null;
  onSubmit: () => void;

  /**
   * A pure layout adaptation slot (changes no field/behavior): by default `pr-10` is left on the right of the chips row for the host's
   * "enlarge" button overlaid at the top right (VideoNode's PanelExpandButton). Hosts without
   * that button pass true to drop this margin, so the chips row does not lack a chunk out of thin air.
   */
  compact?: boolean;
}

/**
 * The **pure form content layer** of the video generation node: camera movement / asset library / generation mode / reference assets chips +
 * prompt input + model selection + params (ratio/definition/duration/scene optimization/audio/human verification/count) +
 * translate button + compute cost + submit button. It contains no React Flow dependency (no useReactFlow /
 * useNodeId / NodeToolbar / useUpdateNodeInternals), so it can sit in the floating panel below a canvas node
 * (VideoNode + OperationPanelShell), and also be stuffed into a standalone layout such as the storyboard detail.
 *
 * The same approach as the image side (ImageGenerationForm): pure field patches go straight through
 * `useCanvasStore().updateNodeData`, while policy-bearing actions (the genMode reset when switching models, submit,
 * translate, detach reference, open the asset library dialog) are all injected by the host via callbacks — **the genMode state machine,
 * references collection and submit orchestration all remain in VideoNode**, and this component holds none of them.
 *
 * The panel's "collapse/enlarge" shell (OperationPanelShell), its absolute positioning on the canvas, and the
 * "generation failed" retry banner (reusing the same onSubmit/submitDisabled) are all the host's responsibility.
 */
export const VideoGenerationForm = memo((props: VideoGenerationFormProps) => {
  const {
    nodeId,
    cameraTemplates,
    cameraTemplatesLoading,
    cameraMovementId,
    onOpenCharacterLibrary,
    onOpenExternalAssets,
    genMode,
    genModeModelId,
    genModeSupportedModes,
    genModeUpstreamCounts,
    upstreamTextContents,
    onDetachUpstream,
    referenceMediaItems,
    referenceCaps,
    prompt,
    onPromptChange,
    onCompositionStart,
    onCompositionEnd,
    mentionCandidates,
    upstreamTextJoined,
    modelId,
    onModelChange,
    modelUpstreamCounts,
    aspectRatio,
    aspectRatioOptions,
    quality,
    qualityOptions,
    durationSec,
    durationBounds,
    sceneOptimize,
    sceneOptimizeOptions,
    generateAudio,
    showHumanReview,
    humanReview,
    modelParameters,
    modelParams,
    count,
    isTranslatingPrompt,
    isGenerating,
    translateDisabled,
    onTranslate,
    totalCreditCostDisplay,
    creditPromotion,
    submitDisabled,
    submitDisabledReason,
    onSubmit,
    compact = false,
  } = props;

  const { t } = useTranslation();
  // `submitDisabled` already carries the org admission block from the owning
  // node; this is only for the button's title, so a blocked member is told why.
  const modelTaskAccess = useModelTaskAccess();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const promptEditorRef = useRef<PromptMentionEditorHandle | null>(null);

  // The popover and editor are both in the panel and the editor is always mounted, so insertion goes straight through the imperative API and the callback keeps a stable reference
  // (no need to depend on prompt, avoiding rebuilding the callback on every keystroke and re-rendering the palette button with it).
  const insertContextPaletteEntry = useCallback(
    (entry: ContextPromptPaletteEntry) => {
      promptEditorRef.current?.insertTextAtCursor(
        contextPromptPaletteInsertionText(entry),
      );
    },
    [],
  );

  return (
    <>
      <div
        className={`flex shrink-0 items-center overflow-x-auto px-3 pb-2 ${
          compact ? "" : "pr-10 "
        }pt-3`}
      >
        <div className="flex shrink-0 items-center gap-2">
          <CameraMovementChip
            templates={cameraTemplates}
            isLoading={cameraTemplatesLoading}
            selectedId={cameraMovementId}
            onChange={(nextId) =>
              updateNodeData(nodeId, { cameraMovement: nextId })
            }
          />
          <CharacterLibraryChip onOpen={onOpenCharacterLibrary} />
          {onOpenExternalAssets ? (
            <ExternalAssetChip onOpen={onOpenExternalAssets} />
          ) : null}
        </div>
        <div className="ml-3 flex shrink-0 items-center gap-3">
          <GenModeSelect
            value={genMode}
            modelId={genModeModelId}
            supportedModes={genModeSupportedModes}
            upstreamCounts={genModeUpstreamCounts}
            // When switching mode, also trim the custom params that belonged only to the previous mode: the param table is declared per mode,
            // and leftover keys would be sent to the backend as is — at best ignored, at worst rejected as invalid params.
            onChange={(nextMode) =>
              updateNodeData(nodeId, {
                genMode: nextMode,
                modelParams: filterMediaModelParamsForMode(
                  modelParameters,
                  modelParams,
                  nextMode,
                ),
              })
            }
          />
          <NodeContextPromptPaletteButton
            nodeId={nodeId}
            onInsert={insertContextPaletteEntry}
          />
          {upstreamTextContents.map((content) => (
            <ReferenceTextChip
              key={`upstream-text-${content.nodeId}`}
              nodeId={content.nodeId}
              text={content.text ?? ""}
              sourceLabel={content.displayName ?? content.nodeType}
              onDetach={onDetachUpstream}
            />
          ))}
        </div>
        {referenceMediaItems.length > 0 && (
          <ReferenceMediaRow
            items={referenceMediaItems}
            caps={referenceCaps}
            genMode={genMode}
            onFocus={(focusNodeId) => setSelectedNode(focusNodeId)}
            onDetach={onDetachUpstream}
            onReorder={(ids) => updateNodeData(nodeId, { referenceOrder: ids })}
          />
        )}
      </div>

      <PromptMentionEditor
        ref={promptEditorRef}
        value={prompt}
        onChange={onPromptChange}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        onKeyDown={(event) => event.stopPropagation()}
        candidates={mentionCandidates}
        placeholder={
          upstreamTextJoined.length > 0
            ? t("node.videoOps.upstreamPlaceholder")
            : t("node.videoNode.placeholder")
        }
        className={`nodrag nowheel min-h-0 w-full flex-1 overflow-y-auto whitespace-pre-wrap break-words border-none bg-transparent px-3 py-2 text-sm leading-6 text-text-dark outline-none ${CANVAS_NODE_INPUT_PLACEHOLDER_CLASS}`}
      />

      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <ProviderModelPicker
            selectedModelId={modelId}
            onChange={onModelChange}
            domain="video"
            popoverPlacement="top"
            getOptionDisabledReason={(model) => {
              const reason = videoModelReferenceDisabledReason(
                model,
                modelUpstreamCounts,
              );
              return reason ? t(reason) : null;
            }}
          />
          <VideoConfigChip
            aspectRatio={aspectRatio}
            aspectRatioOptions={aspectRatioOptions}
            quality={quality}
            qualityOptions={qualityOptions}
            durationSec={durationSec}
            durationBounds={durationBounds}
            sceneOptimize={sceneOptimize}
            sceneOptimizeOptions={sceneOptimizeOptions}
            generateAudio={generateAudio}
            onChange={(patch) => updateNodeData(nodeId, patch)}
          />
          <MediaModelParameterChip
            parameters={modelParameters}
            values={modelParams}
            mode={genMode}
            onChange={(next) => updateNodeData(nodeId, { modelParams: next })}
          />
          {showHumanReview && (
            <button
              type="button"
              role="switch"
              aria-checked={humanReview}
              title={t("node.videoOps.humanReviewTitle")}
              onClick={(event) => {
                event.stopPropagation();
                updateNodeData(nodeId, { humanReview: !humanReview });
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
          <CountPicker
            value={count}
            onChange={(nextCount) => updateNodeData(nodeId, { count: nextCount })}
          />
          <button
            type="button"
            title={t("node.videoOps.translateTitle")}
            disabled={translateDisabled}
            onClick={(event) => {
              event.stopPropagation();
              onTranslate();
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
            promotion={creditPromotion}
            disabled={submitDisabled}
            className={NODE_CREDIT_PILL_FLAT_CLASS}
          />
          <button
            type="button"
            disabled={submitDisabled}
            title={
              isGenerating
                ? t("node.videoNode.submitBusy")
                : (modelTaskAccess.message ?? submitDisabledReason ??
                  t("node.videoNode.submit"))
            }
            onClick={(event) => {
              event.stopPropagation();
              onSubmit();
            }}
            className={`${NODE_GENERATE_BUTTON_BASE_CLASS} ${
              submitDisabled
                ? NODE_GENERATE_BUTTON_DISABLED_CLASS
                : NODE_GENERATE_BUTTON_ENABLED_CLASS
            }`}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </div>
    </>
  );
});

VideoGenerationForm.displayName = "VideoGenerationForm";
