// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import type { ErrorResponse, OkResponse } from "@/types/api";
import type { FastApiErrorResponse } from "@/lib/queries/model-gateway";

export interface RunpodWorkerLiveCounts {
  idle: number;
  initializing: number;
  ready: number;
  running: number;
  throttled: number;
  unhealthy: number;
}

export interface RunpodWorkerJobCounts {
  completed: number;
  failed: number;
  inProgress: number;
  inQueue: number;
  retried: number;
}

/** One of the 4 RunPod endpoints split out 2026-10-19 — see
 * `runpod_worker_control.py`'s `_ENDPOINTS` registry. Fetch the live list
 * via `useRunpodWorkerKeys()` rather than hardcoding this union where
 * possible; it's kept here only for call sites that need a literal type. */
export type RunpodWorkerKey = "h3" | "qwen_edit" | "qwen_t2i" | "multishot";

export interface RunpodWorkerStatus {
  key: string;
  displayName?: string;
  configured: boolean;
  running: boolean;
  endpointId?: string;
  endpointName?: string;
  workers?: {
    max: number;
    min: number;
    idleTimeoutSeconds: number;
  };
  /** null when the last RunPod health check itself failed (not when cold). */
  live?: RunpodWorkerLiveCounts | null;
  jobs?: RunpodWorkerJobCounts | null;
}

type RunpodWorkerResponse =
  | OkResponse<RunpodWorkerStatus>
  | ErrorResponse
  | FastApiErrorResponse;

type RunpodWorkerKeysResponse =
  | OkResponse<{ keys: string[] }>
  | ErrorResponse
  | FastApiErrorResponse;

/** Stable list of endpoint keys ("h3", "qwen_edit", "qwen_t2i", "multishot")
 * in display order — lets Settings render one section per endpoint without
 * hardcoding the key list on the frontend too. */
export function useRunpodWorkerKeys(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.runpodWorkerKeys(),
    queryFn: ({ signal }) =>
      api
        .get("api/v1/runpod-worker/keys", { signal })
        .json<RunpodWorkerKeysResponse>(),
    enabled,
    staleTime: Infinity, // this list never changes at runtime
  });
}

/** Dev-only RunPod worker status for one endpoint key — see
 * Settings → Models. Polls faster while a worker is mid-boot so the Start
 * button's spinner resolves promptly, slower once things have settled. */
export function useRunpodWorkerStatus(key: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.runpodWorker(key),
    queryFn: ({ signal }) =>
      api
        .get(`api/v1/runpod-worker/${key}/status`, { signal })
        .json<OkResponse<RunpodWorkerStatus>>(),
    enabled: enabled && !!key,
    refetchInterval: (query) => {
      const live = query.state.data?.data.live;
      return live && live.initializing > 0 ? 5_000 : 20_000;
    },
  });
}

export function useStartRunpodWorker(key: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api
        .post(`api/v1/runpod-worker/${key}/start`, {
          timeout: 30_000,
          throwHttpErrors: false,
        })
        .json<RunpodWorkerResponse>(),
    onSuccess: (response) => {
      if (response.ok === true) {
        qc.setQueryData(queryKeys.runpodWorker(key), response);
      } else {
        qc.invalidateQueries({ queryKey: queryKeys.runpodWorker(key) });
      }
    },
  });
}

export function useStopRunpodWorker(key: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api
        .post(`api/v1/runpod-worker/${key}/stop`, {
          timeout: 30_000,
          throwHttpErrors: false,
        })
        .json<RunpodWorkerResponse>(),
    onSuccess: (response) => {
      if (response.ok === true) {
        qc.setQueryData(queryKeys.runpodWorker(key), response);
      } else {
        qc.invalidateQueries({ queryKey: queryKeys.runpodWorker(key) });
      }
    },
  });
}
