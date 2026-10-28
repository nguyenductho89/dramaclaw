// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/// <reference lib="webworker" />
//
// Matting (background removal) Web Worker.
//
// Inference core: the background-removal pipeline of `@huggingface/transformers` (Apache-2.0).
// The earlier `@imgly/background-removal` is AGPL-3.0 (viral copyleft), which conflicts with this repo's
// Elastic License v2 closed-source policy, so it was replaced. The model weights use open-source models under permissive commercial licenses
// (see MATTE_MODEL), carrying no non-commercial / copyleft constraints.
//
// Why build our own Worker: inference (especially the WASM fallback path), if run on the main thread, would freeze the whole canvas.
// Putting the whole pipeline in a worker means the main thread is never blocked, whether or not WebGPU is available.

import { env, pipeline } from "@huggingface/transformers";
import {
  applyBrowserModelSource,
  type BrowserModelSourceConfig,
  type TransformersEnvLike,
} from "./browserModelSource";

// Matting models (all under permissive commercial licenses, switchable at any time):
//   - "Xenova/modnet"            Apache-2.0, ~6.6MB (q8)/13MB (fp16), portrait/character matting, the smallest
//   - "onnx-community/BEN2-ONNX" MIT, ~219MB (fp16), the best general object matting quality, but a large first download
// This project's canvas is mainly character portraits / storyboard figures, so MODNet is the default (a download far smaller than the old imgly ~45MB).
const MATTE_MODEL = "Xenova/modnet";

// modelSource: the source of the model and wasm (see browserModelSource.ts); all null means use the library default source.
type InboundMessage =
  | { type: "preload"; id: number; modelSource: BrowserModelSourceConfig }
  | { type: "matte"; id: number; blob: Blob; modelSource: BrowserModelSourceConfig };

type OutboundMessage =
  | { type: "ready"; id: number }
  | { type: "result"; id: number; blob: Blob }
  | { type: "error"; id: number; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// When onnxruntime-web creates a session it sets `wasm.numThreads` to hardwareConcurrency.
// But WASM multithreading depends on SharedArrayBuffer, and SAB is only available when the page is "cross-origin isolated" (COOP+COEP).
// Our page sets only COOP and not COEP, so `crossOriginIsolated === false`,
// multithreading cannot start, and ort prints a warning and falls back to a single thread. Since it is bound to be single-threaded, report the core count as 1,
// so the library requests only one thread from the start - the same result, but with no useless multithreaded init attempt and warning.
if (!ctx.crossOriginIsolated) {
  try {
    Object.defineProperty(ctx.navigator, "hardwareConcurrency", {
      configurable: true,
      get: () => 1,
    });
  } catch {
    // Some engines may refuse to redefine this read-only property; being refused is fine, since the warning itself is harmless.
  }
}

async function detectGpu(): Promise<boolean> {
  const gpu = (ctx.navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) {
    return false;
  }
  try {
    return (await gpu.requestAdapter()) != null;
  } catch {
    return false;
  }
}

// The pipeline is initialized only once inside the worker (a lazily loaded singleton): preload and matte share the same instance,
// hitting the already initialized inference session and avoiding reloading the model weights.
//
// Return shape: transformers.js's BackgroundRemovalPipeline returns a single
// RawImage for a "single input" and returns RawImage[] only for an "array input" (source: `Array.isArray(images) ? result : result[0]`).
// We matte one image at a time, so what we get is a single RawImage - destructuring it as an array before
// triggered "(intermediate value) is not iterable".
type MatteImage = { toBlob(): Promise<Blob> };
type RemoveBackground = (input: string) => Promise<MatteImage>;
let removerPromise: Promise<RemoveBackground> | null = null;

function getRemover(modelSource: BrowserModelSourceConfig): Promise<RemoveBackground> {
  if (!removerPromise) {
    removerPromise = (async () => {
      applyBrowserModelSource(env as unknown as TransformersEnvLike, modelSource, ctx.navigator);
      const useGpu = await detectGpu();
      const remover = await pipeline("background-removal", MATTE_MODEL, {
        device: useGpu ? "webgpu" : "wasm",
        // WebGPU uses fp16; the WASM (CPU) fallback uses q8 quantized weights, with the smallest size and memory.
        dtype: useGpu ? "fp16" : "q8",
      });
      return remover as unknown as RemoveBackground;
    })();
  }
  return removerPromise;
}

ctx.onmessage = async (event: MessageEvent<InboundMessage>) => {
  const message = event.data;
  try {
    if (message.type === "preload") {
      await getRemover(message.modelSource);
      ctx.postMessage({ type: "ready", id: message.id } satisfies OutboundMessage);
      return;
    }
    const remover = await getRemover(message.modelSource);
    // The background-removal pipeline returns a single RawImage for a single input (the matte already composited into the alpha channel).
    const url = URL.createObjectURL(message.blob);
    try {
      const image = await remover(url);
      const out = await image.toBlob();
      ctx.postMessage({ type: "result", id: message.id, blob: out } satisfies OutboundMessage);
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (err) {
    ctx.postMessage({
      type: "error",
      id: message.id,
      message: err instanceof Error ? err.message : String(err),
    } satisfies OutboundMessage);
  }
};

// The sources of model weights and the ort wasm are defined in ./browserModelSource.ts: if the backend configures a
// self-hosted prefix or a public mirror, they are pulled from there; otherwise the transformers.js default behavior applies
// (weights from the Hugging Face Hub, wasm from jsDelivr).
