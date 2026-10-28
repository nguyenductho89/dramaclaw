// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// The main-thread client of the matting Worker: a lazily loaded singleton worker, correlating requests <-> responses by id.
// See the comment at the top of ./matteWorker.ts: the whole inference runs inside the worker, and the main thread (canvas) is not blocked.
import { browserModelSource } from "@/lib/runtime-config";

type OutboundMessage =
  | { type: "ready"; id: number }
  | { type: "result"; id: number; blob: Blob }
  | { type: "error"; id: number; message: string };

let worker: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<number, { resolve: (blob: Blob) => void; reject: (err: Error) => void }>();

function ensureWorker(): Worker {
  if (worker) {
    return worker;
  }
  worker = new Worker(new URL("./matteWorker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (event: MessageEvent<OutboundMessage>) => {
    const message = event.data;
    if (message.type === "ready") {
      return; // Warm-up ack, no pending promise needed
    }
    const entry = pending.get(message.id);
    if (!entry) {
      return;
    }
    pending.delete(message.id);
    if (message.type === "result") {
      entry.resolve(message.blob);
    } else {
      entry.reject(new Error(message.message));
    }
  };
  worker.onerror = (event) => {
    // The worker crashed as a whole: reject all in-flight requests, and reset so it can be rebuilt next time.
    const err = new Error(event.message || "matte worker crashed");
    for (const [, entry] of pending) {
      entry.reject(err);
    }
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** Idle warm-up: create the worker and preload the model, moving the one-time initialization to before the user clicks. */
export function preloadMatteWorker(): void {
  ensureWorker().postMessage({ type: "preload", id: 0, modelSource: browserModelSource() });
}

/** Matte inside the worker; the main thread is not blocked. Returns the background-removed PNG blob. */
export function matteInWorker(blob: Blob): Promise<Blob> {
  const target = ensureWorker();
  const id = nextRequestId++;
  return new Promise<Blob>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    target.postMessage({ type: "matte", id, blob, modelSource: browserModelSource() });
  });
}
