// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  useVideoReview,
  type SingleVideoRequestBody,
  type VideoReviewData,
} from "@/lib/queries/video";
import {
  H3InputPicker,
  h3InputsFromReview,
  h3InputsToBody,
  useStickyReview,
  type H3Inputs,
} from "./h3-input-picker";

/**
 * Mode + reference picker shown directly in the Video panel for the H3
 * backend (it replaces the Seedance2 "Mode" select there). It runs the same
 * read-only `/video/review` dry run the dialog uses to learn which images the
 * beat has and which modes can run, seeds `inputs` once per beat from what was
 * last saved, and reports every change to the owner, which also hands the
 * inputs to the review dialog and to the "Generate prompt" button.
 */
export function H3InputSection({
  project,
  episode,
  beatNum,
  reviewBody,
  inputs,
  onInputsChange,
  onReviewChange,
}: {
  project: string;
  episode: number;
  beatNum: number;
  reviewBody: SingleVideoRequestBody;
  inputs: H3Inputs | undefined;
  onInputsChange: (next: H3Inputs, userChanged: boolean) => void;
  /** Latest dry-run answer, so the owner can build the prompt preview from
   * the same picture set the picker shows. */
  onReviewChange?: (review: VideoReviewData | null) => void;
}) {
  const { t } = useTranslation();
  const reviewMutation = useVideoReview(project, episode);
  const seededForBeatRef = useRef<number | null>(null);
  // `reviewBody` changes identity on every render; keep the latest in a ref
  // so refetching never depends on it.
  const reviewBodyRef = useRef(reviewBody);
  reviewBodyRef.current = reviewBody;

  const fetchReview = (next: H3Inputs) => {
    reviewMutation.mutate({
      beatNum,
      body: { ...reviewBodyRef.current, ...h3InputsToBody(next) },
    });
  };

  useEffect(() => {
    seededForBeatRef.current = null;
    fetchReview({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, episode, beatNum]);

  const data = reviewMutation.data;
  const review = useStickyReview(data?.ok === true ? data : null, beatNum);

  useEffect(() => {
    onReviewChange?.(review);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review]);

  useEffect(() => {
    if (!review || seededForBeatRef.current === beatNum) return;
    seededForBeatRef.current = beatNum;
    onInputsChange(h3InputsFromReview(review), false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review, beatNum]);

  if (!review || review.candidates === undefined) {
    return reviewMutation.isPending ? (
      <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        {t("episode.workbench.videoReview.loading")}
      </div>
    ) : null;
  }

  return (
    <div className="rounded-[10px] border border-white/[0.055] bg-white/[0.012] p-3">
      <H3InputPicker
        review={review}
        inputs={inputs ?? h3InputsFromReview(review)}
        onChange={(next) => {
          onInputsChange(next, true);
          fetchReview(next);
        }}
      />
    </div>
  );
}
