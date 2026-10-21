// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  Image as ImageIcon,
  Loader2,
  Play,
  RefreshCw,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  GLASS_DIALOG_CONTENT_CLASS,
  TRANSPARENT_DIALOG_FOOTER_CLASS,
} from "@/lib/dialog-styles";
import { cn } from "@/lib/utils";
import { resolveMediaUrl } from "@/lib/media-url";
import { backendErrorToastMessage } from "@/lib/api-errors";
import {
  useRunpodWorkerStatus,
  useStartRunpodWorker,
} from "@/lib/queries/runpod-worker";
import {
  useApplySegmentPlan,
  useApproveSegmentFrame,
  useGenerateSegmentFrames,
  useGenerateSegmentVideos,
  useSegmentPlan,
  useSegmentVideosReview,
  useSegments,
  type SegmentPlanItem,
  type SegmentReviewItem,
  type SegmentSummary,
  type SegmentVideosReviewData,
} from "@/lib/queries/segments";

export interface SegmentsWorkbenchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: string;
  episode: number;
  /** Compose selection to use for Phase 1 frame generation — the
   * project's own `render_image_selection` is used server-side when this
   * is omitted; pass it explicitly when the caller already has it loaded
   * (e.g. the beats page) so the dialog doesn't need its own fetch. */
  imageGenerationSelection?: string;
}

/**
 * Dev-only "Segment multishot" workbench — groups an episode's beats into
 * short (~10-15s) segments with an LLM, then walks the two-phase workflow:
 * Phase 1 generate + approve one sketch-free first frame per segment,
 * Phase 2 batch-review + batch-generate MiniMax H3 Multishot video for
 * every approved segment. See `lib/queries/segments.ts` and
 * `docs/adr/0005-segment-multishot-flow.md`.
 */
export function SegmentsWorkbenchDialog({
  open,
  onOpenChange,
  project,
  episode,
  imageGenerationSelection,
}: SegmentsWorkbenchDialogProps) {
  const { t } = useTranslation();
  const segmentsQuery = useSegments(project, episode, open);
  const planMutation = useSegmentPlan(project, episode);
  const applyMutation = useApplySegmentPlan(project, episode);
  const framesMutation = useGenerateSegmentFrames(project, episode);
  const approveMutation = useApproveSegmentFrame(project, episode);
  const reviewMutation = useSegmentVideosReview(project, episode);
  const generateMutation = useGenerateSegmentVideos(project, episode);
  const workerStatus = useRunpodWorkerStatus("multishot", open);
  const startWorker = useStartRunpodWorker("multishot");

  const [planPreview, setPlanPreview] = useState<SegmentPlanItem[] | null>(null);
  const [planSource, setPlanSource] = useState<string>("");
  const [reviewData, setReviewData] = useState<SegmentVideosReviewData | null>(null);
  const [selectedForVideo, setSelectedForVideo] = useState<Set<string>>(new Set());
  const [regeneratingChainId, setRegeneratingChainId] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setPlanPreview(null);
    setPlanSource("");
    setReviewData(null);
    setSelectedForVideo(new Set());
  }, [open]);

  const segments: SegmentSummary[] = segmentsQuery.data?.ok ? segmentsQuery.data.segments : [];
  const hasSegments = segments.length > 0;
  const approvedCount = segments.filter((s) => s.frame_status === "approved").length;

  const workerData = workerStatus.data?.data as
    | { configured?: boolean; running?: boolean }
    | undefined;
  const workerOff = Boolean(workerData && workerData.configured && !workerData.running);

  const handleStartWorker = async () => {
    try {
      const res = await startWorker.mutateAsync();
      if (res.ok !== true) toast.error(t("common.error"));
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const handlePlan = async () => {
    try {
      const res = await planMutation.mutateAsync();
      if (!res.ok) {
        toast.error(res.error || t("common.error"));
        return;
      }
      setPlanPreview(res.segments);
      setPlanSource(res.source);
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const handleApplyPlan = async () => {
    if (!planPreview) return;
    try {
      const res = await applyMutation.mutateAsync(planPreview);
      if (!res.ok) {
        toast.error(res.error || t("common.error"));
        return;
      }
      setPlanPreview(null);
      toast.success(
        t("episode.workbench.segments.planApplied", {
          defaultValue: "Segments applied",
          count: res.segment_count,
        }),
      );
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const handleGenerateFrames = async (chainIds?: string[], force?: boolean) => {
    if (chainIds?.length === 1) setRegeneratingChainId(chainIds[0]);
    try {
      const res = await framesMutation.mutateAsync({
        chainIds,
        force,
        imageGenerationSelection,
      });
      if (!res.ok) {
        toast.error(res.error || t("common.error"));
        return;
      }
      const failed = res.results.filter(
        (r) => !("skipped" in r) && "ok" in r && r.ok === false,
      );
      if (failed.length > 0) {
        toast.error(
          t("episode.workbench.segments.framesPartialFailure", {
            defaultValue: "{{count}} segment(s) failed to start",
            count: failed.length,
          }),
        );
      } else {
        toast.success(
          t("episode.workbench.segments.framesStarted", {
            defaultValue: "Frame generation started",
          }),
        );
      }
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    } finally {
      setRegeneratingChainId(null);
    }
  };

  const handleApprove = async (chainId: string) => {
    try {
      const res = await approveMutation.mutateAsync({ chainId });
      if (!res.ok) {
        toast.error(res.error || t("common.error"));
        return;
      }
      toast.success(
        t("episode.workbench.segments.frameApprovedToast", { defaultValue: "Frame approved" }),
      );
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const handleOpenVideoReview = async () => {
    try {
      const res = await reviewMutation.mutateAsync();
      if (!res.ok) {
        toast.error(res.error || t("common.error"));
        return;
      }
      setReviewData(res);
      setSelectedForVideo(
        new Set(res.segments.filter((s) => s.can_enqueue).map((s) => s.chain_id)),
      );
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const toggleSelected = (chainId: string) => {
    setSelectedForVideo((prev) => {
      const next = new Set(prev);
      if (next.has(chainId)) next.delete(chainId);
      else next.add(chainId);
      return next;
    });
  };

  const handleGenerateVideos = async () => {
    if (!reviewData) return;
    const entries = reviewData.segments
      .filter((s) => selectedForVideo.has(s.chain_id))
      .map((s) => ({ chainId: s.chain_id, reviewFingerprint: s.input_fingerprint }));
    if (entries.length === 0) return;
    try {
      const res = await generateMutation.mutateAsync(entries);
      if (!("results" in res)) {
        toast.error(res.error || t("common.error"));
        return;
      }
      const staleIds = res.results.filter((r) => r.error === "input_stale").map((r) => r.chain_id);
      const failedOther = res.results.filter((r) => !r.ok && r.error !== "input_stale");
      const okCount = res.results.filter((r) => r.ok).length;
      if (okCount > 0) {
        toast.success(
          t("episode.workbench.segments.videosQueued", {
            defaultValue: "{{count}} video job(s) queued",
            count: okCount,
          }),
        );
      }
      if (staleIds.length > 0) {
        toast.error(
          t("episode.workbench.multishotReview.inputStale", {
            defaultValue: "Something changed since review — refreshing…",
          }),
        );
        void handleOpenVideoReview();
      } else if (failedOther.length > 0) {
        toast.error(
          t("episode.workbench.segments.videosPartialFailure", {
            defaultValue: "{{count}} video job(s) failed to queue",
            count: failedOther.length,
          }),
        );
      }
      if (okCount > 0 && staleIds.length === 0) {
        setReviewData(null);
      }
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(GLASS_DIALOG_CONTENT_CLASS, "ring-white/10 sm:max-w-4xl")}>
        <DialogHeader>
          <DialogTitle>
            {t("episode.workbench.segments.title", { defaultValue: "Segments (Multishot)" })}
          </DialogTitle>
        </DialogHeader>

        <div className="grid max-h-[72vh] gap-4 overflow-y-auto pr-1">
          {workerOff && (
            <div className="flex items-center justify-between gap-3 rounded-[8px] border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <span className="inline-flex items-center gap-1.5">
                <AlertTriangle className="size-3.5" />
                {t("episode.workbench.multishotReview.workerOff")}
              </span>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => void handleStartWorker()}
                disabled={startWorker.isPending}
              >
                {startWorker.isPending ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Play className="size-3" />
                )}
                {t("episode.workbench.multishotReview.startWorker")}
              </Button>
            </div>
          )}

          {!hasSegments && (
            <div className="grid gap-3 rounded-[8px] border border-white/[0.075] bg-white/[0.012] p-4 text-sm">
              <p className="text-muted-foreground">
                {t("episode.workbench.segments.planEmptyDesc", {
                  defaultValue:
                    "No segments yet. An AI will group this episode's beats into short (10-15s) segments, each becoming one continuous Multishot video job.",
                })}
              </p>
              <div>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void handlePlan()}
                  disabled={planMutation.isPending}
                >
                  {planMutation.isPending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="size-3.5" />
                  )}
                  {t("episode.workbench.segments.planButton", { defaultValue: "Plan segments (AI)" })}
                </Button>
              </div>
            </div>
          )}

          {planPreview && (
            <PlanPreview
              items={planPreview}
              source={planSource}
              pending={applyMutation.isPending}
              onApply={() => void handleApplyPlan()}
              onDiscard={() => setPlanPreview(null)}
              t={t}
            />
          )}

          {hasSegments && !planPreview && (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("episode.workbench.segments.framesTitle", {
                    defaultValue: "Phase 1 — first frames",
                  })}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => void handlePlan()}
                    disabled={planMutation.isPending}
                  >
                    {planMutation.isPending ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Sparkles className="size-3" />
                    )}
                    {t("episode.workbench.segments.replan", { defaultValue: "Re-plan" })}
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    onClick={() => void handleGenerateFrames()}
                    disabled={framesMutation.isPending}
                  >
                    {framesMutation.isPending ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <ImageIcon className="size-3" />
                    )}
                    {t("episode.workbench.segments.generateAllFrames", {
                      defaultValue: "Generate all pending frames",
                    })}
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                {segments.map((seg) => (
                  <SegmentFrameCard
                    key={seg.chain_id}
                    segment={seg}
                    pending={
                      regeneratingChainId === seg.chain_id ||
                      (framesMutation.isPending && regeneratingChainId === null)
                    }
                    approving={approveMutation.isPending}
                    onGenerate={() => void handleGenerateFrames([seg.chain_id])}
                    onRegenerate={() => void handleGenerateFrames([seg.chain_id], true)}
                    onApprove={() => void handleApprove(seg.chain_id)}
                    t={t}
                  />
                ))}
              </div>

              <div className="grid gap-2 rounded-[8px] border border-white/[0.075] bg-white/[0.012] p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("episode.workbench.segments.videoSectionTitle", {
                      defaultValue: "Phase 2 — batch generate video",
                    })}
                  </span>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => void handleOpenVideoReview()}
                    disabled={reviewMutation.isPending || approvedCount === 0}
                  >
                    {reviewMutation.isPending ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3" />
                    )}
                    {t("episode.workbench.segments.reviewVideos", {
                      defaultValue: "Review ({{count}} approved)",
                      count: approvedCount,
                    })}
                  </Button>
                </div>

                {approvedCount === 0 && (
                  <p className="text-[11px] text-muted-foreground/75">
                    {t("episode.workbench.segments.noApprovedSegments", {
                      defaultValue: "Approve at least one segment's frame in Phase 1 first.",
                    })}
                  </p>
                )}

                {reviewData && (
                  <ul className="grid gap-1.5">
                    {reviewData.segments.map((seg) => (
                      <VideoReviewRow
                        key={seg.chain_id}
                        item={seg}
                        selected={selectedForVideo.has(seg.chain_id)}
                        onToggle={() => toggleSelected(seg.chain_id)}
                        t={t}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>

        <DialogFooter className={TRANSPARENT_DIALOG_FOOTER_CLASS}>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          {reviewData && (
            <Button
              type="button"
              onClick={() => void handleGenerateVideos()}
              disabled={selectedForVideo.size === 0 || generateMutation.isPending}
            >
              {generateMutation.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : null}
              {t("episode.workbench.segments.generateSelectedVideos", {
                defaultValue: "Generate video ({{count}})",
                count: selectedForVideo.size,
              })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlanPreview({
  items,
  source,
  pending,
  onApply,
  onDiscard,
  t,
}: {
  items: SegmentPlanItem[];
  source: string;
  pending: boolean;
  onApply: () => void;
  onDiscard: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  return (
    <div className="grid gap-2 rounded-[8px] border border-white/[0.075] bg-white/[0.012] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {t("episode.workbench.segments.planPreviewTitle", {
            defaultValue: "Proposed segments ({{count}})",
            count: items.length,
          })}
        </span>
        {source === "fallback" && (
          <span className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-3" />
            {t("episode.workbench.segments.planFallbackWarning", {
              defaultValue: "AI grouping unavailable — used automatic grouping instead",
            })}
          </span>
        )}
      </div>
      <ul className="grid max-h-56 gap-1 overflow-y-auto">
        {items.map((item) => (
          <li
            key={item.chain_id}
            className="flex items-center justify-between gap-2 rounded-[6px] border border-white/[0.06] bg-white/[0.015] px-2 py-1 text-xs"
          >
            <span className="tabular-nums text-foreground/85">
              {t("episode.workbench.segments.beatRangeLabel", {
                defaultValue: "Beats {{from}}-{{to}}",
                from: item.beat_numbers[0],
                to: item.beat_numbers[item.beat_numbers.length - 1],
              })}
            </span>
            <span className="text-muted-foreground/75">{item.total_seconds.toFixed(1)}s</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground/70" title={item.reason}>
              {item.reason}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex justify-end gap-2">
        <Button type="button" size="xs" variant="ghost" onClick={onDiscard}>
          {t("common.cancel")}
        </Button>
        <Button type="button" size="xs" onClick={onApply} disabled={pending}>
          {pending ? <Loader2 className="size-3 animate-spin" /> : null}
          {t("episode.workbench.segments.planApply", { defaultValue: "Apply" })}
        </Button>
      </div>
    </div>
  );
}

function SegmentFrameCard({
  segment,
  pending,
  approving,
  onGenerate,
  onRegenerate,
  onApprove,
  t,
}: {
  segment: SegmentSummary;
  pending: boolean;
  approving: boolean;
  onGenerate: () => void;
  onRegenerate: () => void;
  onApprove: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const src = segment.frame_url ? resolveMediaUrl(segment.frame_url) : null;
  const approved = segment.frame_status === "approved";
  return (
    <div className="grid gap-1.5 rounded-[8px] border border-white/[0.075] bg-white/[0.012] p-2">
      <div className="relative flex aspect-[2/3] w-full items-center justify-center overflow-hidden rounded-[6px] border border-white/[0.075] bg-white/[0.02]">
        {src ? (
          <img src={src} alt="" className="h-full w-full object-cover" />
        ) : (
          <ImageIcon className="size-5 text-muted-foreground/60" />
        )}
        {approved && (
          <span className="absolute bottom-0 right-0 rounded-tl bg-emerald-500 px-1 text-[10px] leading-4 text-white">
            <Check className="inline size-2.5" />
          </span>
        )}
      </div>
      <span className="truncate text-[11px] tabular-nums text-foreground/85">
        {t("episode.workbench.segments.beatRangeLabel", {
          defaultValue: "Beats {{from}}-{{to}}",
          from: segment.beat_numbers[0],
          to: segment.beat_numbers[segment.beat_numbers.length - 1],
        })}
      </span>
      <div className="flex gap-1">
        {segment.frame_missing ? (
          <Button type="button" size="xs" variant="outline" className="flex-1" onClick={onGenerate} disabled={pending}>
            {pending ? <Loader2 className="size-3 animate-spin" /> : <ImageIcon className="size-3" />}
            {t("episode.workbench.segments.generateFrame", { defaultValue: "Generate" })}
          </Button>
        ) : (
          <>
            {!approved && (
              <Button type="button" size="xs" className="flex-1" onClick={onApprove} disabled={approving}>
                {approving ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                {t("episode.workbench.segments.approveFrame", { defaultValue: "Approve" })}
              </Button>
            )}
            <Button
              type="button"
              size="xs"
              variant="outline"
              className={approved ? "flex-1" : undefined}
              onClick={onRegenerate}
              disabled={pending}
              title={t("episode.workbench.segments.regenerateFrame", { defaultValue: "Regenerate" })}
            >
              {pending ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function VideoReviewRow({
  item,
  selected,
  onToggle,
  t,
}: {
  item: SegmentReviewItem;
  selected: boolean;
  onToggle: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const errorCount = (item.issues ?? []).length;
  return (
    <li className="flex items-center gap-2 rounded-[6px] border border-white/[0.06] bg-white/[0.015] px-2 py-1 text-xs">
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          className="size-3.5"
          checked={selected}
          disabled={!item.can_enqueue}
          onChange={onToggle}
        />
        <span className="tabular-nums text-foreground/85">
          {item.beat_numbers
            ? t("episode.workbench.segments.beatRangeLabel", {
                defaultValue: "Beats {{from}}-{{to}}",
                from: item.beat_numbers[0],
                to: item.beat_numbers[item.beat_numbers.length - 1],
              })
            : item.chain_id}
        </span>
      </label>
      <span className="text-muted-foreground/75">
        {item.total_duration_seconds !== undefined ? `${item.total_duration_seconds.toFixed(1)}s` : ""}
      </span>
      {errorCount > 0 ? (
        <span className="min-w-0 flex-1 truncate text-destructive" title={(item.issues ?? []).join("; ")}>
          <AlertTriangle className="mr-1 inline size-3" />
          {item.issues?.[0]}
        </span>
      ) : (
        <span className="flex-1 text-right text-emerald-400">
          {t("episode.workbench.multishotReview.promptReady")}
        </span>
      )}
    </li>
  );
}
