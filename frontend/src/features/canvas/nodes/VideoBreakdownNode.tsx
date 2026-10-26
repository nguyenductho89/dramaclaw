// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from "@xyflow/react";
import { Loader2, MousePointerClick, ScanSearch, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useCanvasStore } from "@/stores/canvasStore";
import { useCanvasPickStore } from "@/stores/canvasPickStore";
import { useUpstreamNodes } from "@/features/canvas/application/useUpstreamGraph";
import { landVideoBreakdownResult } from "@/features/canvas/application/videoBreakdownLanding";
import { BillingRuleNotConfiguredError } from "@/lib/api-errors";
import { CreditCostPill } from "@/components/credits/credit-visual";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import {
  CANVAS_NODE_TYPES,
  VIDEO_BREAKDOWN_DIMENSIONS,
  isVideoNode,
  type VideoBreakdownDimension,
  type VideoBreakdownNodeData,
} from "@/features/canvas/domain/canvasNodes";
import { resolveNodeDisplayName } from "@/features/canvas/domain/nodeDisplay";
import {
  NodeHeader,
  NODE_HEADER_FLOATING_POSITION_CLASS,
} from "@/features/canvas/ui/NodeHeader";
import {
  CANVAS_NODE_INPUT_SURFACE_CLASS,
  canvasNodeFrameClass,
} from "@/features/canvas/ui/nodeFrameStyles";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import { ensureWebSafeVideo } from "@/features/canvas/application/videoTranscode";
import {
  isVideoFile,
  VIDEO_FILE_ACCEPT,
} from "@/features/canvas/application/videoFileTypes";
import {
  submitFreezoneVideoBreakdown,
  uploadFreezoneVideo,
  type FreezoneVideoBreakdownResult,
} from "@/api/ops";
import { awaitTaskCompletion } from "@/api/tasks";
import { readUrl } from "@/lib/url-params";
import {
  publishNodeActionAccepted,
  publishNodeActionError,
  publishNodeActionSuccess,
  subscribeNodeAction,
} from "@/features/canvas/application/nodeActionResult";

type VideoBreakdownNodeProps = NodeProps & {
  id: string;
  data: VideoBreakdownNodeData;
  selected?: boolean;
};

const NODE_WIDTH = 300;
const NODE_HEIGHT = 292;

/** This node only serves Seedance 2.5's breakdown capability; the badge is hardcoded, no model picker. */
const TARGET_MODEL_BADGE = "SD 2.5";

export const VideoBreakdownNode = memo(
  ({ id, data, selected }: VideoBreakdownNodeProps) => {
    const { t } = useTranslation();
    const updateNodeInternals = useUpdateNodeInternals();
    const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);
    const startPick = useCanvasPickStore((state) => state.startPick);
    const upstreamNodes = useUpstreamNodes(id);

    // Frame-by-frame breakdown shares the freezone.video_analyze pricing rule with video-story analysis - operation
    // is only a bookkeeping dimension, it does not affect pricing - passing video_breakdown is so the estimate
    // matches up with the real charge later. The whole canvas is turned off by CreditDisplayHiddenProvider on the
    // CE-local runtime, so there is no need to branch on that here.
    const breakdownCreditCost = useGenerationCreditCost(
      "feature",
      "freezone.video_analyze",
      { surface: "canvas", params: { operation: "video_breakdown" } },
    );
    const breakdownBillingRuleMissing =
      breakdownCreditCost.error instanceof BillingRuleNotConfiguredError;
    const breakdownCreditCostDisplay =
      breakdownCreditCost.data?.data.display ??
      (breakdownBillingRuleMissing
        ? t("common.billingRuleNotConfiguredShort")
        : null);

    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [isSourceMenuOpen, setSourceMenuOpen] = useState(false);

    useEffect(() => {
      updateNodeInternals(id);
    }, [id, updateNodeInternals]);

    // The upstream video node connected via an edge takes priority: that edge is the single source of truth for
    // where the source material comes from, and disconnecting the edge should revert to the empty state. A local
    // upload has no upstream edge, so it lands on data.sourceVideoUrl.
    const upstreamVideo = useMemo(
      () =>
        upstreamNodes.find((node) => isVideoNode(node) && Boolean(node.data.videoUrl)) ??
        null,
      [upstreamNodes],
    );
    const videoUrl =
      (upstreamVideo && isVideoNode(upstreamVideo)
        ? upstreamVideo.data.videoUrl
        : null) ?? data.sourceVideoUrl ?? null;
    const sourceLabel =
      (upstreamVideo
        ? resolveNodeDisplayName(CANVAS_NODE_TYPES.video, upstreamVideo.data)
        : data.sourceFileName) ?? null;

    const videoSource = videoUrl ? resolveImageDisplayUrl(videoUrl) : null;
    const isUploading = Boolean(data.isUploading);
    const isBreakingDown = Boolean(data.isBreakingDown);
    const breakdownError =
      typeof data.breakdownError === "string" && data.breakdownError.length > 0
        ? data.breakdownError
        : null;

    const dimensions = useMemo<VideoBreakdownDimension[]>(
      () =>
        Array.isArray(data.dimensions) && data.dimensions.length > 0
          ? data.dimensions
          : [...VIDEO_BREAKDOWN_DIMENSIONS],
      [data.dimensions],
    );

    const resolvedTitle = useMemo(
      () => resolveNodeDisplayName(CANVAS_NODE_TYPES.videoBreakdown, data),
      [data],
    );
    const cardToneClass = canvasNodeFrameClass({ selected });

    const toggleDimension = useCallback(
      (dimension: VideoBreakdownDimension) => {
        const next = dimensions.includes(dimension)
          ? dimensions.filter((item) => item !== dimension)
          : [...VIDEO_BREAKDOWN_DIMENSIONS].filter(
              (item) => item === dimension || dimensions.includes(item),
            );
        // Always keep at least one dimension selected - turning them all off would make "start breakdown" produce nothing.
        if (next.length === 0) return;
        updateNodeData(id, { dimensions: next });
      },
      [dimensions, id, updateNodeData],
    );

    const processFile = useCallback(
      async (file: File) => {
        if (!isVideoFile(file)) return;
        const projectId = readUrl().project;
        if (!projectId) {
          console.error("[video-breakdown] no project in URL");
          return;
        }
        updateNodeData(id, { sourceFileName: file.name, isUploading: true });
        try {
          // Same handling as the video node: encodings the web doesn't support (e.g. HEVC) are transcoded to H.264
          // before upload, otherwise a browser without the matching decoder (e.g. Edge) gets audio with no picture.
          const prepared = await ensureWebSafeVideo(file);
          const uploaded = await uploadFreezoneVideo(
            projectId,
            prepared.file,
            prepared.file.name,
          );
          updateNodeData(id, {
            sourceVideoUrl: uploaded.url,
            sourceFileName: file.name,
            sourceNodeId: null,
            isUploading: false,
          });
        } catch (error) {
          console.error("[video-breakdown] upload failed", error);
          updateNodeData(id, { isUploading: false, sourceFileName: null });
          toast.error(t("videoBreakdown.uploadFailed"));
        }
      },
      [id, t, updateNodeData],
    );

    const handleFileChange = useCallback(
      async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) await processFile(file);
        event.target.value = "";
      },
      [processFile],
    );

    const handlePickFromCanvas = useCallback(() => {
      setSourceMenuOpen(false);
      startPick({ requesterNodeId: id, kind: "video" });
    }, [id, startPick]);

    // The submitted callback is only for the agent's node action: breakdown takes several minutes to run, so the
    // action reports "started" the instant the task is submitted, without waiting for the result to land.
    const handleStartBreakdown = useCallback(async (
      options: {
        dimensions?: VideoBreakdownDimension[];
        onSubmitted?: () => void;
        onSubmitError?: (error: unknown) => void;
      } = {},
    ) => {
      if (!videoUrl || isBreakingDown) return;
      const projectId = readUrl().project;
      if (!projectId) {
        console.error("[video-breakdown] no project in URL");
        options.onSubmitError?.(new Error("no project in URL"));
        return;
      }
      const runDimensions = options.dimensions ?? dimensions;

      updateNodeData(id, {
        isBreakingDown: true,
        breakdownStartedAt: Date.now(),
        breakdownError: null,
        ...(options.dimensions ? { dimensions: options.dimensions } : {}),
      });

      let submitted = false;
      try {
        const ref = await submitFreezoneVideoBreakdown(projectId, {
          videoUrl,
          dimensions: runDimensions,
        });
        submitted = true;
        options.onSubmitted?.();
        const taskKey =
          typeof ref?.task_key === "string" ? ref.task_key : null;
        // The endpoint normally runs as an async task (returns task_key); when the result comes back synchronously,
        // treat it directly as the result, matching the video-story analysis chain.
        const result = taskKey
          ? ((((
              await awaitTaskCompletion(taskKey, projectId, {
                taskType: ref.task_type,
              })
            ).result ?? {}) as unknown) as FreezoneVideoBreakdownResult)
          : (ref as unknown as FreezoneVideoBreakdownResult);

        const outcome = landVideoBreakdownResult({
          nodeId: id,
          result,
          labels: {
            storyboardFallbackLabel: (index) =>
              t("videoBreakdown.groups.storyboard", {
                index: String(index).padStart(2, "0"),
              }),
            motionFallbackLabel: t("videoBreakdown.groups.motion"),
            musicFallbackLabel: t("videoBreakdown.groups.music"),
          },
        });

        if (outcome === "node-gone") {
          // Breakdown takes several minutes; it's entirely normal for the user to delete the node while waiting.
          // Finish quietly in that case - there's no node to write to, and this shouldn't be reported as "zero output".
          return;
        }

        if (outcome === "empty") {
          // The task succeeded but all three dimensions produced zero output (e.g. every dimension was turned off, or
          // the source video has no audio track and frame extraction entirely failed) - this must not be silent,
          // otherwise the user sees no feedback at all.
          updateNodeData(id, {
            isBreakingDown: false,
            breakdownError: t("videoBreakdown.emptyResult"),
          });
          toast.error(t("videoBreakdown.emptyResult"));
          return;
        }

        updateNodeData(id, { isBreakingDown: false, breakdownError: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[video-breakdown] failed", error);
        if (!submitted) options.onSubmitError?.(error);
        updateNodeData(id, { isBreakingDown: false, breakdownError: message });
        toast.error(t("videoBreakdown.failed"));
      }
    }, [
      dimensions,
      id,
      isBreakingDown,
      t,
      updateNodeData,
      videoUrl,
    ]);

    useEffect(
      () => subscribeNodeAction(({ nodeId, action, requestId, parameters }) => {
        if (nodeId !== id || action !== "start_video_breakdown") return;
        publishNodeActionAccepted(requestId, id, action);
        if (!videoUrl) {
          publishNodeActionError(requestId, id, action, t("videoBreakdown.emptyHint"));
          return;
        }
        if (isBreakingDown) {
          publishNodeActionError(requestId, id, action, t("videoBreakdown.running"));
          return;
        }
        if (breakdownBillingRuleMissing) {
          publishNodeActionError(requestId, id, action, t("common.billingRuleNotConfiguredShort"));
          return;
        }
        const requested = Array.isArray(parameters?.dimensions)
          ? VIDEO_BREAKDOWN_DIMENSIONS.filter((dimension) =>
              (parameters.dimensions as unknown[]).includes(dimension),
            )
          : [];
        void handleStartBreakdown({
          ...(requested.length > 0 ? { dimensions: requested } : {}),
          onSubmitted: () =>
            publishNodeActionSuccess(requestId, id, action, { started: true }),
          onSubmitError: (error) => publishNodeActionError(requestId, id, action, error),
        });
      }),
      [breakdownBillingRuleMissing, handleStartBreakdown, id, isBreakingDown, t, videoUrl],
    );

    return (
      <div
        className="group relative h-full w-full overflow-visible"
        style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
        onClick={() => setSelectedNode(id)}
      >
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

        <NodeHeader
          className={NODE_HEADER_FLOATING_POSITION_CLASS}
          icon={<ScanSearch className="h-4 w-4" />}
          titleText={resolvedTitle}
          editable
          onTitleChange={(next) => updateNodeData(id, { displayName: next })}
        />

        <div
          className={`relative flex h-full w-full flex-col gap-3 overflow-hidden rounded-[var(--node-radius)] border p-3 ${CANVAS_NODE_INPUT_SURFACE_CLASS} ${cardToneClass}`}
        >
          <div className="flex items-center justify-between">
            <span className="text-[12px] leading-none text-text-muted/90">
              {t("videoBreakdown.sourceLabel")}
            </span>
            <span className="rounded-full border border-cyan-300/25 bg-cyan-300/[0.12] px-2 py-0.5 text-[11px] font-medium leading-none text-cyan-200">
              {TARGET_MODEL_BADGE}
            </span>
          </div>

          <div className="relative">
            {videoSource ? (
              <div className="relative h-[120px] w-full overflow-hidden rounded-[10px] border border-white/12 bg-black/40">
                <video
                  src={videoSource}
                  className="h-full w-full object-cover"
                  muted
                  playsInline
                  preload="metadata"
                />
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/75 to-transparent px-2 py-1.5">
                  <span className="max-w-[60%] overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-white/85">
                    {sourceLabel ?? t("videoBreakdown.attached")}
                  </span>
                  <button
                    type="button"
                    className="nodrag rounded-md border border-white/20 bg-black/45 px-2 py-0.5 text-[11px] text-white/85 transition-colors hover:bg-black/65"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSourceMenuOpen((open) => !open);
                    }}
                  >
                    {t("videoBreakdown.replace")}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                disabled={isUploading}
                onClick={(event) => {
                  event.stopPropagation();
                  setSourceMenuOpen((open) => !open);
                }}
                className="nodrag flex h-[120px] w-full flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed border-white/18 bg-white/[0.02] text-text-muted transition-colors hover:border-white/28 hover:bg-white/[0.04] disabled:cursor-progress"
              >
                {isUploading ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin text-white/60" />
                    <span className="text-[12px]">
                      {t("videoBreakdown.uploading")}
                    </span>
                  </>
                ) : (
                  <>
                    <Upload className="h-5 w-5 text-white/45" />
                    <span className="text-[12px]">
                      {t("videoBreakdown.emptyHint")}
                    </span>
                  </>
                )}
              </button>
            )}

            {isSourceMenuOpen && (
              <>
                {/* Click outside to close the menu. Placed one layer below the menu, covering the whole canvas area. */}
                <div
                  className="fixed inset-0 z-30"
                  onClick={(event) => {
                    event.stopPropagation();
                    setSourceMenuOpen(false);
                  }}
                />
                <div className="absolute left-1/2 top-1/2 z-40 w-[168px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[10px] border border-white/12 bg-[#242426] p-1 shadow-[0_12px_28px_rgba(0,0,0,0.45)]">
                  <button
                    type="button"
                    className="nodrag flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] text-text-dark transition-colors hover:bg-white/[0.08]"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSourceMenuOpen(false);
                      fileInputRef.current?.click();
                    }}
                  >
                    <Upload className="h-3.5 w-3.5 text-white/55" />
                    {t("videoBreakdown.uploadVideo")}
                  </button>
                  <button
                    type="button"
                    className="nodrag flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] text-text-dark transition-colors hover:bg-white/[0.08]"
                    onClick={(event) => {
                      event.stopPropagation();
                      handlePickFromCanvas();
                    }}
                  >
                    <MousePointerClick className="h-3.5 w-3.5 text-white/55" />
                    {t("videoBreakdown.pickFromCanvas")}
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[12px] leading-none text-text-muted/90">
              {t("videoBreakdown.dimensionsLabel")}
            </span>
            <div className="flex items-center gap-1.5">
              {VIDEO_BREAKDOWN_DIMENSIONS.map((dimension) => {
                const active = dimensions.includes(dimension);
                return (
                  <button
                    key={dimension}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleDimension(dimension);
                    }}
                    className={`nodrag flex-1 rounded-full border px-2 py-1 text-[12px] leading-none transition-colors ${
                      active
                        ? "border-cyan-300/30 bg-cyan-300/[0.14] text-cyan-100"
                        : "border-white/12 bg-white/[0.03] text-text-muted hover:bg-white/[0.06]"
                    }`}
                  >
                    {t(`videoBreakdown.dimension.${dimension}`)}
                  </button>
                );
              })}
            </div>
          </div>

          {breakdownError && !isBreakingDown ? (
            <p className="line-clamp-2 text-[11px] leading-tight text-red-300/90">
              {breakdownError}
            </p>
          ) : null}

          <button
            type="button"
            disabled={
              !videoSource || isBreakingDown || breakdownBillingRuleMissing
            }
            title={
              breakdownBillingRuleMissing
                ? t("common.billingRuleNotConfiguredShort")
                : undefined
            }
            onClick={(event) => {
              event.stopPropagation();
              if (breakdownBillingRuleMissing) return;
              void handleStartBreakdown();
            }}
            className="nodrag mt-auto flex h-9 w-full items-center justify-center gap-2 rounded-[10px] border border-white/15 bg-white/[0.06] text-[13px] text-text-dark transition-colors hover:bg-white/[0.1] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {isBreakingDown && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {isBreakingDown
              ? t("videoBreakdown.running")
              : t("videoBreakdown.start")}
            <CreditCostPill
              display={breakdownCreditCostDisplay}
              promotion={breakdownCreditCost.data?.data.promotion}
              disabled={
                !videoSource || isBreakingDown || breakdownBillingRuleMissing
              }
            />
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept={VIDEO_FILE_ACCEPT}
          className="hidden"
          onChange={handleFileChange}
        />
      </div>
    );
  },
);

VideoBreakdownNode.displayName = "VideoBreakdownNode";
