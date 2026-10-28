// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Messages between the depth motion-capture worker and the main thread. A worker only runs one task, so no request id is needed.
import type { BrowserModelSourceConfig } from "@/features/canvas/application/browserModelSource";
import type { DepthCaptureErrorCode } from "@/features/canvas/domain/canvasNodes";

export type DepthWorkerInbound = {
  type: "run";
  blob: Blob;
  /** Source of the model and wasm (see browserModelSource.ts); all null means use the library's default source. */
  modelSource: BrowserModelSourceConfig;
};

export type DepthWorkerOutbound =
  /** progress is 0–1. */
  | { type: "progress"; progress: number }
  | { type: "result"; blob: Blob; width: number; height: number; durationMs: number }
  | { type: "error"; code: DepthCaptureErrorCode; message: string };
