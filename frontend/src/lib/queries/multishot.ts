// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMutation } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { jsonWithBackendError } from "@/lib/api-errors";
import { p } from "@/lib/api-path";
import type { ErrorResponse, TaskResponse } from "@/types/api";

/** Dev-only: MiniMax H3 Multishot (chains N consecutive beats sharing a
 * `multishot_chain_id` into one continuous video) — see
 * `api/routes/generation.py`'s `review_multishot_video`/
 * `generate_multishot_video` and `runpod-h3-qwen-endpoints.md` section 5. */

export interface MultishotShot {
  beat_number: number;
  duration_seconds: number;
  frames: number;
  is_dialogue: boolean;
  has_prompt: boolean;
  prompt_preview: string;
}

export interface MultishotReference {
  tag: string;
  identity_id: string;
  name: string;
  path: string;
  appearance_details: string;
}

export interface MultishotReviewData {
  ok: true;
  chain_id: string;
  beat_numbers: number[];
  shot_count: number;
  checkpoint: "fl2va" | "ref2va";
  /** How the chain will be sampled (`multishot_sampling_plan`). Empty
   * `pdd_nfe` means no PDD file for this checkpoint: base 20-step schedule. */
  sampling?: { pdd_nfe: string; pdd_file: string; steps: number; output_scale: number };
  width: number;
  height: number;
  frames_per_shot: number;
  total_duration_seconds: number;
  shots: MultishotShot[];
  references: MultishotReference[];
  script_preview: string;
  start_frame_path: string | null;
  frame_missing: boolean;
  worker_status: unknown;
  issues: string[];
  can_enqueue: boolean;
  input_fingerprint: string;
  max_shots: number;
}

export type MultishotReviewResponse = MultishotReviewData | ErrorResponse;

/** `POST .../multishot/{chainId}/review` — read-only / dry-run preview, no
 * request body. Never enqueues a task or spends RunPod GPU time. */
export function useMultishotReview(project: string, episode: number) {
  return useMutation({
    mutationFn: ({ chainId }: { chainId: string }) =>
      jsonWithBackendError<MultishotReviewResponse>(
        api.post(
          p`api/v1/projects/${project}/episodes/${episode}/multishot/${chainId}/review`,
          { throwHttpErrors: false },
        ),
      ),
  });
}

/** `POST .../multishot/{chainId}/video` — enqueue. `reviewFingerprint`
 * should be the matching review call's `input_fingerprint`; a mismatch
 * comes back as `{ok:false, error:"input_stale"}` (a plain 200, not an
 * HTTP error), same contract as the 1-shot H3 video route. */
export function useGenerateMultishotVideo(project: string, episode: number) {
  return useMutation({
    mutationFn: ({
      chainId,
      reviewFingerprint,
    }: {
      chainId: string;
      reviewFingerprint?: string;
    }) =>
      jsonWithBackendError<TaskResponse | ErrorResponse>(
        api.post(
          p`api/v1/projects/${project}/episodes/${episode}/multishot/${chainId}/video`,
          {
            json: { review_fingerprint: reviewFingerprint },
            throwHttpErrors: false,
          },
        ),
      ),
  });
}
