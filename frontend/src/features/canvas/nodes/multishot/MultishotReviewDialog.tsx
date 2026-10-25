// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import {
  GLASS_DIALOG_CONTENT_CLASS,
  TRANSPARENT_DIALOG_FOOTER_CLASS,
} from "@/lib/dialog-styles";
import { cn } from "@/lib/utils";
import { resolveMediaUrl } from "@/lib/media-url";
import { backendErrorToastMessage } from "@/lib/api-errors";
import {
  reviewFreezoneVideoMultishot,
  type FreezoneMultishotShotPromptInput,
  type FreezoneVideoMultishotPayload,
  type FreezoneVideoMultishotReviewResult,
} from "@/api/ops";
import {
  useRunpodWorkerStatus,
  useStartRunpodWorker,
} from "@/lib/queries/runpod-worker";

export interface MultishotReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: string;
  /** Built by VideoNode.tsx the same way it would build the submit payload — reused verbatim for the review dry run. */
  reviewPayload: FreezoneVideoMultishotPayload;
  /** Called when the user clicks Confirm. The caller (VideoNode.tsx) does the actual submitFreezoneVideoMultishot + job tracking. */
  onConfirm: (confirmed: {
    shotPrompts: FreezoneMultishotShotPromptInput[];
    reviewFingerprint: string;
  }) => void;
}

/**
 * Review/confirm dialog for MiniMax H3 Multishot (`runpod_minimax_h3_multishot`).
 *
 * Modeled on `components/episode/beat-workbench/video-review-dialog.tsx`
 * (the main-pipeline's analogous H3 1-shot dialog) — same shape: a
 * read-only `/freezone/video/multishot/review` dry run resolves the start
 * frame, shared references and a fresh AI-rewritten prompt for EVERY shot
 * before anything is actually enqueued, so the user can see (and edit) what
 * will render and catch lint issues first. Unlike the 1-shot dialog there
 * is no separate "AI rewrite" button — the review call already does the
 * rewrite for every shot in one pass.
 */
export function MultishotReviewDialog({
  open,
  onOpenChange,
  project,
  reviewPayload,
  onConfirm,
}: MultishotReviewDialogProps) {
  const { t } = useTranslation();
  const workerStatus = useRunpodWorkerStatus("multishot", open);
  const startWorker = useStartRunpodWorker("multishot");

  const [review, setReview] = useState<FreezoneVideoMultishotReviewResult | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [editedPrompts, setEditedPrompts] = useState<Record<string, string>>({});
  // Guards the textarea seed: only set from the review's own prompts once
  // per dialog-open, never on a background refetch, or an in-progress edit
  // would be clobbered.
  const promptsSeededRef = useRef(false);

  const fetchReview = async () => {
    setReviewLoading(true);
    setReviewError(null);
    try {
      const result = await reviewFreezoneVideoMultishot(project, reviewPayload);
      setReview(result);
    } catch (err) {
      setReviewError(backendErrorToastMessage(err, t));
    } finally {
      setReviewLoading(false);
    }
  };

  useEffect(() => {
    promptsSeededRef.current = false;
    setReview(null);
    setReviewError(null);
    if (!open) return;
    void fetchReview();
    // Re-fetch only on a genuine open transition — not on every render
    // where the caller hands us a structurally-equal-but-new payload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || promptsSeededRef.current || !review) return;
    setEditedPrompts(
      Object.fromEntries(review.shots.map((shot) => [shot.id, shot.prompt])),
    );
    promptsSeededRef.current = true;
  }, [open, review]);

  const handleStartWorker = async () => {
    try {
      const res = await startWorker.mutateAsync();
      if (res.ok !== true) toast.error(t("common.error"));
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const handleConfirm = () => {
    if (!review) return;
    onOpenChange(false);
    onConfirm({
      shotPrompts: review.shots.map((shot) => ({
        id: shot.id,
        finalPrompt: editedPrompts[shot.id] ?? shot.prompt,
      })),
      reviewFingerprint: review.input_fingerprint,
    });
  };

  const loading = reviewLoading && !review;
  const startFrameSrc = review ? resolveMediaUrl(reviewPayload.startImageUrl) : null;
  const workerData = workerStatus.data?.data;
  const workerOff = Boolean(workerData && workerData.configured && !workerData.running);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(GLASS_DIALOG_CONTENT_CLASS, "ring-white/10 sm:max-w-3xl")}>
        <DialogHeader>
          <DialogTitle>{t("node.videoOps.multishot.reviewTitle")}</DialogTitle>
        </DialogHeader>

        <div className="grid max-h-[70vh] gap-4 overflow-y-auto pr-1">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("node.videoOps.multishot.reviewLoading")}
            </div>
          ) : reviewError ? (
            <div className="rounded-[8px] border border-destructive/35 bg-destructive/[0.08] p-3 text-xs text-destructive">
              {reviewError}
            </div>
          ) : review ? (
            <>
              {workerOff && (
                <div className="flex items-center justify-between gap-3 rounded-[8px] border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                  <span className="inline-flex items-center gap-1.5">
                    <AlertTriangle className="size-3.5" />
                    {t("node.videoOps.multishot.workerOff")}
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
                    {t("node.videoOps.multishot.startWorker")}
                  </Button>
                </div>
              )}

              {review.issues.length > 0 && (
                <div className="space-y-1">
                  {review.issues.map((issue, i) => (
                    <div
                      key={i}
                      className="rounded-[6px] border border-destructive/35 bg-destructive/[0.08] px-2 py-1 text-xs text-destructive"
                    >
                      {issue}
                    </div>
                  ))}
                </div>
              )}

              <div className="rounded-[8px] border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                {t("node.videoOps.multishot.costWarning", {
                  shots: review.shots.length,
                  seconds: review.total_duration_seconds,
                })}
              </div>

              <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
                <div
                  className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-[8px] border border-white/[0.075] bg-white/[0.02] sm:w-[160px]"
                  title={reviewPayload.startImageUrl}
                >
                  {startFrameSrc ? (
                    <img src={startFrameSrc} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <ImageIcon className="size-6 text-muted-foreground/60" />
                  )}
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
                  <SummaryField
                    label={t("node.videoOps.multishot.backendLabel")}
                    value={review.checkpoint}
                  />
                  <SummaryField
                    label={t("node.videoOps.multishot.shotsLabel")}
                    value={String(review.shots.length)}
                  />
                  <SummaryField
                    label={t("node.videoOps.multishot.shotSecondsLabel")}
                    value={`${review.shot_seconds}s`}
                  />
                  <SummaryField
                    label={t("node.videoOps.multishot.totalSecondsLabel")}
                    value={`${review.total_duration_seconds}s`}
                  />
                </div>
              </div>

              {review.references.length > 0 && (
                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("node.videoOps.multishot.referencesHeader")}
                  </span>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,6.5rem))] gap-2">
                    {review.references.map((ref) => {
                      const refSrc = resolveMediaUrl(ref.url);
                      return (
                        <div
                          key={ref.tag}
                          className="overflow-hidden rounded-[7px] border border-white/[0.075] bg-white/[0.018]"
                        >
                          <div className="relative aspect-square w-full bg-white/[0.02]">
                            {refSrc ? (
                              <img
                                src={refSrc}
                                alt={ref.name}
                                className="absolute inset-0 h-full w-full object-cover"
                              />
                            ) : (
                              <ImageIcon className="absolute inset-0 m-auto size-5 text-muted-foreground/60" />
                            )}
                          </div>
                          <div className="px-1.5 py-1">
                            <div className="truncate text-[10px] font-medium">
                              {ref.tag} · {ref.name || ref.kind}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("node.videoOps.multishot.promptsHeader")}
                </span>
                {review.shots.map((shot, index) => {
                  const shotErrors = shot.lint.filter((i) => i.severity === "error");
                  const shotWarnings = shot.lint.filter((i) => i.severity === "warning");
                  return (
                    <div
                      key={shot.id}
                      className="space-y-1 rounded-[8px] border border-white/[0.075] bg-white/[0.015] p-2"
                    >
                      <div className="flex items-center justify-between text-[10px] font-medium text-muted-foreground">
                        <span>
                          {index === 0
                            ? t("node.videoOps.multishot.startFrameLabel")
                            : t("node.videoOps.multishot.shotLabel", { n: index + 1 })}
                        </span>
                        {shot.fallback_used && (
                          <span className="text-amber-600 dark:text-amber-400">
                            {t("node.videoOps.multishot.fallbackUsed")}
                          </span>
                        )}
                      </div>
                      <Textarea
                        value={editedPrompts[shot.id] ?? shot.prompt}
                        onChange={(e) =>
                          setEditedPrompts((prev) => ({ ...prev, [shot.id]: e.target.value }))
                        }
                        rows={4}
                        className="resize-none text-xs"
                      />
                      {shotErrors.map((issue, i) => (
                        <div
                          key={`err-${i}`}
                          className="rounded-[6px] border border-destructive/35 bg-destructive/[0.08] px-2 py-1 text-xs text-destructive"
                        >
                          {issue.message}
                        </div>
                      ))}
                      {shotWarnings.map((issue, i) => (
                        <div
                          key={`warn-${i}`}
                          className="rounded-[6px] border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300"
                        >
                          {issue.message}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>

        <DialogFooter className={TRANSPARENT_DIALOG_FOOTER_CLASS}>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("node.videoOps.multishot.cancel")}
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={loading || !review || !review.can_enqueue}
          >
            {t("node.videoOps.multishot.confirmGenerate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SummaryField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
        {label}
      </div>
      <div className="truncate text-foreground">{value}</div>
    </div>
  );
}
