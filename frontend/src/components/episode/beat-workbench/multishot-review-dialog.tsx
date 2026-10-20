// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AlertTriangle, Image as ImageIcon, Loader2, Play } from "lucide-react";

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
  useGenerateMultishotVideo,
  useMultishotReview,
} from "@/lib/queries/multishot";
import {
  useRunpodWorkerStatus,
  useStartRunpodWorker,
} from "@/lib/queries/runpod-worker";

export interface MultishotReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: string;
  episode: number;
  chainId: string;
  /** Called after a successful enqueue — the caller typically clears the
   * beat selection / shows its own "queued" affordance. */
  onEnqueued?: () => void;
}

/**
 * Dev-only review/confirm dialog for a MiniMax H3 Multishot chain — see
 * `runpod-h3-qwen-endpoints.md` section 5. Unlike the 1-shot H3 review
 * dialog, this one is read-only: the script is the join of each beat's own
 * already-generated MiniMax H3 prompt (via the existing per-beat
 * "Generate MiniMax H3 prompt" button), so there's nothing to hand-edit
 * here — only to review before spending RunPod GPU time on the whole
 * chain.
 */
export function MultishotReviewDialog({
  open,
  onOpenChange,
  project,
  episode,
  chainId,
  onEnqueued,
}: MultishotReviewDialogProps) {
  const { t } = useTranslation();
  const reviewMutation = useMultishotReview(project, episode);
  const generateMutation = useGenerateMultishotVideo(project, episode);
  const workerStatus = useRunpodWorkerStatus("multishot", open);
  const startWorker = useStartRunpodWorker("multishot");

  useEffect(() => {
    if (!open || !chainId) return;
    reviewMutation.mutate({ chainId });
    // Re-fetch only on a genuine open transition or chain switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, chainId]);

  const reviewData = reviewMutation.data;
  const review = reviewData?.ok === true ? reviewData : null;
  const reviewError = reviewData?.ok === false ? reviewData.error : null;

  const handleStartWorker = async () => {
    try {
      const res = await startWorker.mutateAsync();
      if (res.ok !== true) {
        toast.error(t("common.error"));
      }
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const handleConfirm = async () => {
    if (!review) return;
    try {
      const res = await generateMutation.mutateAsync({
        chainId,
        reviewFingerprint: review.input_fingerprint,
      });
      if (res.ok === false) {
        if (res.error === "input_stale") {
          toast.error(t("episode.workbench.multishotReview.inputStale"));
          reviewMutation.mutate({ chainId });
          return;
        }
        toast.error(res.error || t("episode.workbench.multishotReview.enqueueFailed"));
        return;
      }
      onOpenChange(false);
      toast.success(t("episode.workbench.multishotReview.enqueued"));
      onEnqueued?.();
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const loading = reviewMutation.isPending && !review;
  const frameSrc = review?.start_frame_path
    ? resolveMediaUrl(review.start_frame_path)
    : null;
  const workerData = workerStatus.data?.data as
    | { configured?: boolean; running?: boolean }
    | undefined;
  const workerOff = Boolean(workerData && workerData.configured && !workerData.running);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(GLASS_DIALOG_CONTENT_CLASS, "ring-white/10 sm:max-w-3xl")}>
        <DialogHeader>
          <DialogTitle>{t("episode.workbench.multishotReview.title")}</DialogTitle>
        </DialogHeader>

        <div className="grid max-h-[70vh] gap-4 overflow-y-auto pr-1">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("episode.workbench.multishotReview.loading")}
            </div>
          ) : reviewError ? (
            <div className="rounded-[8px] border border-destructive/35 bg-destructive/[0.08] p-3 text-xs text-destructive">
              {reviewError}
            </div>
          ) : reviewMutation.isError ? (
            <div className="rounded-[8px] border border-destructive/35 bg-destructive/[0.08] p-3 text-xs text-destructive">
              {backendErrorToastMessage(reviewMutation.error, t)}
            </div>
          ) : review ? (
            <>
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

              {review.issues.length > 0 && (
                <div className="rounded-[8px] border border-destructive/35 bg-destructive/[0.08] p-3 text-xs text-destructive">
                  <ul className="list-disc space-y-1 pl-4">
                    {review.issues.map((issue, i) => (
                      <li key={i}>{issue}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
                <div
                  className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-[8px] border border-white/[0.075] bg-white/[0.02] sm:w-[160px]"
                  title={review.start_frame_path ?? undefined}
                >
                  {frameSrc ? (
                    <img src={frameSrc} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <ImageIcon className="size-6 text-muted-foreground/60" />
                  )}
                </div>

                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
                  <SummaryField
                    label={t("episode.workbench.multishotReview.shotCountLabel")}
                    value={String(review.shot_count)}
                  />
                  <SummaryField
                    label={t("episode.workbench.multishotReview.checkpointLabel")}
                    value={review.checkpoint}
                  />
                  <SummaryField
                    label={t("episode.workbench.multishotReview.resolutionLabel")}
                    value={`${review.width}x${review.height}`}
                  />
                  <SummaryField
                    label={t("episode.workbench.multishotReview.durationLabel")}
                    value={`${review.total_duration_seconds.toFixed(1)}s`}
                  />
                </div>
              </div>

              <div className="grid gap-1.5 text-xs">
                <span className="text-[11px] text-muted-foreground/78">
                  {t("episode.workbench.multishotReview.shotsLabel")}
                </span>
                <ul className="grid gap-1">
                  {review.shots.map((shot) => (
                    <li
                      key={shot.beat_number}
                      className="flex items-center justify-between gap-2 rounded-[6px] border border-white/[0.06] bg-white/[0.015] px-2 py-1"
                    >
                      <span className="tabular-nums text-foreground/85">
                        {t("episode.workbench.multishotReview.beatLabel", {
                          n: shot.beat_number,
                        })}
                      </span>
                      <span className="text-muted-foreground/75">
                        {shot.frames}f / {shot.duration_seconds.toFixed(1)}s
                        {shot.is_dialogue
                          ? ` · ${t("episode.workbench.multishotReview.dialogue")}`
                          : ""}
                      </span>
                      <span
                        className={cn(
                          "shrink-0",
                          shot.has_prompt ? "text-emerald-400" : "text-destructive",
                        )}
                      >
                        {shot.has_prompt
                          ? t("episode.workbench.multishotReview.promptReady")
                          : t("episode.workbench.multishotReview.promptMissing")}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              {review.references.length > 0 && (
                <div className="grid gap-1 text-xs">
                  <span className="text-[11px] text-muted-foreground/78">
                    {t("episode.workbench.multishotReview.referencesLabel")}
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {review.references.map((ref) => (
                      <span
                        key={ref.tag}
                        className="rounded-[5px] border border-white/[0.07] bg-white/[0.02] px-1.5 py-0.5 text-[11px] text-foreground/80"
                      >
                        {ref.tag} {ref.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {review.script_preview && (
                <div className="grid gap-1 text-xs">
                  <span className="text-[11px] text-muted-foreground/78">
                    {t("episode.workbench.multishotReview.scriptPreviewLabel")}
                  </span>
                  <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-[8px] border border-white/[0.06] bg-white/[0.012] p-2 text-[11px] text-foreground/80">
                    {review.script_preview}
                  </pre>
                </div>
              )}
            </>
          ) : null}
        </div>

        <DialogFooter className={TRANSPARENT_DIALOG_FOOTER_CLASS}>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={!review || !review.can_enqueue || generateMutation.isPending}
          >
            {generateMutation.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : null}
            {t("episode.workbench.multishotReview.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SummaryField({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <span className="text-[10px] text-muted-foreground/70">{label}</span>
      <span className="text-foreground/90">{value}</span>
    </div>
  );
}
