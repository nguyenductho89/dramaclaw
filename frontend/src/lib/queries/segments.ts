// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { jsonWithBackendError } from "@/lib/api-errors";
import { p } from "@/lib/api-path";
import { queryKeys } from "@/lib/query-keys";
import type { ErrorResponse, TaskResponse } from "@/types/api";

/**
 * "Segment multishot" 2-phase workflow (added 2026-10-21) — see
 * `.claude/CLAUDE.md`'s "Segment multishot" section and
 * `docs/adr/0005-segment-multishot-flow.md`. An LLM groups an episode's
 * beats into short (~10-15s) segments, each becoming one MiniMax H3
 * Multishot job (one shot per beat, continuous). Phase 1: generate + approve
 * one sketch-free compose first frame per segment. Phase 2: batch-review +
 * batch-generate video for every approved segment. Dev-only, same
 * reasoning as `multishot.ts` (this layers on top of that single-chain
 * plumbing — `review_multishot_video`/`generate_multishot_video`).
 */

export type SegmentFrameStatus = "pending" | "approved";
export type SegmentVideoStatus = "pending" | "queued" | "generated";

export interface SegmentSummary {
  chain_id: string;
  beat_numbers: number[];
  reason: string;
  shot_seconds: number[];
  frame_status: SegmentFrameStatus;
  frame_url: string | null;
  frame_missing: boolean;
  video_status: SegmentVideoStatus;
}

export interface SegmentListData {
  ok: true;
  segments: SegmentSummary[];
}

export type SegmentListResponse = SegmentListData | ErrorResponse;

/** `GET .../segments` — cheap, read-only, safe to poll. No LLM call, no
 * RunPod call. This is what drives the segments panel; `useSegmentVideosReview`
 * below (which DOES call the LLM) is only for the Phase 2 confirm dialog. */
export function useSegments(project: string, episode: number, enabled = true) {
  return useQuery({
    queryKey: queryKeys.segments(project, episode),
    queryFn: ({ signal }) =>
      jsonWithBackendError<SegmentListResponse>(
        api.get(p`api/v1/projects/${project}/episodes/${episode}/segments`, {
          signal,
          throwHttpErrors: false,
        }),
      ),
    enabled,
  });
}

// ── Phase 0: plan + apply ──────────────────────────────────────────────────

export interface SegmentPlanItem {
  chain_id: string;
  beat_numbers: number[];
  shot_seconds: number[];
  total_seconds: number;
  reason: string;
  warnings: string[];
}

export interface SegmentPlanData {
  ok: true;
  source: "llm" | "llm_repaired" | "fallback";
  warnings: string[];
  segments: SegmentPlanItem[];
}

export type SegmentPlanResponse = SegmentPlanData | ErrorResponse;

/** `POST .../segments/plan` — dry-run, writes nothing. */
export function useSegmentPlan(project: string, episode: number) {
  return useMutation({
    mutationFn: () =>
      jsonWithBackendError<SegmentPlanResponse>(
        api.post(p`api/v1/projects/${project}/episodes/${episode}/segments/plan`, {
          throwHttpErrors: false,
        }),
      ),
  });
}

export interface SegmentApplyData {
  ok: true;
  segment_count: number;
}

export type SegmentApplyResponse = SegmentApplyData | ErrorResponse;

/** `POST .../segments/apply` — writes `multishot_chain_id` +
 * `duration_seconds` per the given plan, replacing the episode's entire
 * segment set. Invalidates both the segments list and the beats list
 * (grouping/duration changed on every affected beat). */
export function useApplySegmentPlan(project: string, episode: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (segments: SegmentPlanItem[]) =>
      jsonWithBackendError<SegmentApplyResponse>(
        api.post(p`api/v1/projects/${project}/episodes/${episode}/segments/apply`, {
          json: { segments },
          throwHttpErrors: false,
        }),
      ),
    onSuccess: (res) => {
      if (res.ok) {
        qc.invalidateQueries({ queryKey: queryKeys.segments(project, episode) });
        qc.invalidateQueries({ queryKey: queryKeys.beats(project, episode) });
      }
    },
  });
}

// ── Phase 1: frames ──────────────────────────────────────────────────────

export type SegmentFrameResult =
  | (TaskResponse & { chain_id: string; beat_number: number })
  | (ErrorResponse & { chain_id: string; beat_number?: number })
  | { chain_id: string; skipped: true; reason: string };

export interface SegmentFramesGenerateData {
  ok: true;
  results: SegmentFrameResult[];
}

export type SegmentFramesGenerateResponse = SegmentFramesGenerateData | ErrorResponse;

/** `POST .../segments/frames/generate` — one sketch-free compose render
 * per segment not yet approved. `chainIds`, when given, restricts this to
 * just those segments (a per-segment "generate"/"regenerate this one"
 * button) instead of the whole episode. `force: true` also regenerates
 * already-approved segments (within whatever `chainIds` scope is given,
 * or every segment if `chainIds` is omitted). */
export function useGenerateSegmentFrames(project: string, episode: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      imageGenerationSelection?: string;
      force?: boolean;
      chainIds?: string[];
    }) =>
      jsonWithBackendError<SegmentFramesGenerateResponse>(
        api.post(
          p`api/v1/projects/${project}/episodes/${episode}/segments/frames/generate`,
          {
            json: {
              ...(params.imageGenerationSelection
                ? { image_generation_selection: params.imageGenerationSelection }
                : {}),
              ...(params.force ? { force: true } : {}),
              ...(params.chainIds ? { chain_ids: params.chainIds } : {}),
            },
            throwHttpErrors: false,
          },
        ),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.segments(project, episode) });
    },
  });
}

export interface SegmentFrameApproveData {
  ok: true;
  chain_id: string;
  frame_status: SegmentFrameStatus;
  frame_fingerprint: string;
}

export type SegmentFrameApproveResponse = SegmentFrameApproveData | ErrorResponse;

/** `POST .../segments/{chainId}/frame/approve` — Phase 1 confirm. */
export function useApproveSegmentFrame(project: string, episode: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ chainId }: { chainId: string }) =>
      jsonWithBackendError<SegmentFrameApproveResponse>(
        api.post(
          p`api/v1/projects/${project}/episodes/${episode}/segments/${chainId}/frame/approve`,
          { json: {}, throwHttpErrors: false },
        ),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.segments(project, episode) });
    },
  });
}

// ── Phase 2: video review + batch generate ─────────────────────────────────

export interface SegmentReviewShot {
  beat_number: number;
  duration_seconds: number;
  frames: number;
  is_dialogue: boolean;
  has_prompt: boolean;
  prompt_preview: string;
  lint: { severity: "error" | "warning"; code: string; message: string }[];
}

export interface SegmentReviewItem {
  chain_id: string;
  ok: boolean;
  error?: string;
  beat_numbers?: number[];
  checkpoint?: "fl2va" | "ref2va";
  sampling?: { pdd_nfe: string; pdd_file: string; steps: number; output_scale: number };
  width?: number;
  height?: number;
  frames_per_shot?: number;
  total_duration_seconds?: number;
  shots?: SegmentReviewShot[];
  start_frame_path?: string | null;
  issues?: string[];
  can_enqueue?: boolean;
  input_fingerprint?: string;
}

export interface SegmentVideosReviewData {
  ok: true;
  worker_status: unknown;
  segments: SegmentReviewItem[];
}

export type SegmentVideosReviewResponse = SegmentVideosReviewData | ErrorResponse;

/** `POST .../segments/videos/review` — dry-run across EVERY segment in the
 * episode: (re)writes and lints each shot's MiniMax H3 prompt. No RunPod
 * call, no enqueue, but DOES call the (text-only) prompt LLM for every
 * shot — not free to call repeatedly, just far cheaper than the GPU job
 * it gates. Call once per dialog-open, not on every render. */
export function useSegmentVideosReview(project: string, episode: number) {
  return useMutation({
    mutationFn: () =>
      jsonWithBackendError<SegmentVideosReviewResponse>(
        api.post(p`api/v1/projects/${project}/episodes/${episode}/segments/videos/review`, {
          throwHttpErrors: false,
        }),
      ),
  });
}

export interface SegmentVideoGenerateResult {
  chain_id: string;
  ok: boolean;
  error?: string;
  task_id?: string;
  task_type?: string;
}

export interface SegmentVideosGenerateData {
  ok: boolean;
  results: SegmentVideoGenerateResult[];
}

export type SegmentVideosGenerateResponse = SegmentVideosGenerateData | ErrorResponse;

/** `POST .../segments/video/generate` — Phase 2 batch enqueue for the
 * given `{chainId, reviewFingerprint}` entries (reuse the matching
 * `SegmentReviewItem.input_fingerprint` from the review call above). A
 * mismatch for one entry comes back as that entry's own
 * `{ok:false,error:"input_stale"}`, the others still enqueue. */
export function useGenerateSegmentVideos(project: string, episode: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (entries: { chainId: string; reviewFingerprint?: string }[]) =>
      jsonWithBackendError<SegmentVideosGenerateResponse>(
        api.post(p`api/v1/projects/${project}/episodes/${episode}/segments/video/generate`, {
          json: {
            segments: entries.map((e) => ({
              chain_id: e.chainId,
              review_fingerprint: e.reviewFingerprint,
            })),
          },
          throwHttpErrors: false,
        }),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.segments(project, episode) });
    },
  });
}

