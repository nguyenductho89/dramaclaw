// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';
import {
  ensureBackendImageUrl,
  fetchFreezoneReversePromptResult,
  submitFreezoneReversePrompt,
} from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { generationTaskDescriptor } from './resumeGeneration';

/** Reverse-prompt usually returns in a dozen or so seconds; used to estimate progress advance for the loading overlay. */
export const REVERSE_PROMPT_DURATION_MS = 15000;

/**
 * Resolve the URL of "the image the upstream image node is showing right now". Keeps the same fallback order as the image branch of
 * graphContentResolver: generation result imageUrl -> previewImageUrl -> referenceImageUrl,
 * so that an image-generation node with only a reference image attached (not yet generated) is also recognized as a referenceable material.
 *
 * (Moved verbatim out of TextAnnotationNode's module-private function and exported - the storyboard detail needs to use the same fallback order
 * in its button show/hide check, otherwise the basis of "has an image, can reverse" would diverge from the workflow.)
 */
export function resolveUpstreamImageUrl(data: unknown): string | null {
  const d = data as
    | { imageUrl?: unknown; previewImageUrl?: unknown; referenceImageUrl?: unknown }
    | undefined;
  for (const candidate of [d?.imageUrl, d?.previewImageUrl, d?.referenceImageUrl]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

/** Take "the image shown right now" on the source node of the text node's first upstream edge (no upstream / no image -> null). */
export function resolveTextNodeUpstreamImageUrl(nodeId: string): string | null {
  const state = useCanvasStore.getState();
  const upstreamEdge = state.edges.find((edge) => edge.target === nodeId);
  if (!upstreamEdge) return null;
  const sourceNode = state.nodes.find((node) => node.id === upstreamEdge.source);
  return resolveUpstreamImageUrl(sourceNode?.data);
}

export interface TextImageToPromptResult {
  /** The prompt reversed out; null when not backfilled successfully. */
  prompt: string | null;
  /** Failure reason; null on success (including "returned an empty prompt"). */
  error: string | null;
}

/**
 * Image reverse-prompt submission orchestration (moved verbatim out of TextAnnotationNode.runImageToPrompt, with zero
 * semantic change): take the upstream image URL -> set this node's isGenerating -> when needed first upload a data: URL to a backend
 * static path -> submit /freezone/reverse-prompt -> wait for the task to complete -> take the prompt of the job result
 * and backfill into **this node's own content** (no new node).
 *
 * Failures and "no upstream image" both only clear the loading state and do not write node.data.generationError - the original implementation
 * was like this (errors only go to the console), kept unchanged; the return value lets the caller (storyboard detail) show the failure
 * text on its own toolbar.
 */
export async function runTextImageToPrompt(
  nodeId: string,
): Promise<TextImageToPromptResult> {
  const projectId = readUrl().project;
  if (!projectId) {
    console.error('[text-node] no project in URL');
    return { prompt: null, error: i18n.t('canvas.errors.missingProjectParam') };
  }
  const rawUrl = resolveTextNodeUpstreamImageUrl(nodeId);
  if (!rawUrl) {
    console.warn('[text-node] imageToPrompt: no upstream image url');
    return { prompt: null, error: i18n.t('canvas.errors.noUpstreamImageForPrompt') };
  }
  const updateNodeData = useCanvasStore.getState().updateNodeData;
  updateNodeData(nodeId, { isGenerating: true, generationStartedAt: Date.now() });
  try {
    // Backend looks up the file by static path — `data:` URLs get uploaded
    // first via /freezone/upload to obtain a real path; `?v=<ts>` cache
    // busters are stripped either way.
    const sourceUrl = await ensureBackendImageUrl(projectId, rawUrl);
    const ref = await submitFreezoneReversePrompt(projectId, {
      sourceUrl,
      canvasId: readUrl().canvas ?? 'default',
      nodeId,
    });
    // Persist the task handle so a page refresh can resume this job.
    useCanvasStore.getState().updateNodeData(nodeId, generationTaskDescriptor(ref));
    await awaitTaskCompletion(ref.task_key, projectId);
    // SSE task.result only carries `{ output_format: "json" }`; the prompt
    // text comes from the dedicated job-result endpoint.
    const { prompt } = await fetchFreezoneReversePromptResult(projectId, ref.job_id);
    const done = useCanvasStore.getState().updateNodeData;
    if (prompt && prompt.trim().length > 0) {
      done(nodeId, { content: prompt, isGenerating: false, generationStartedAt: null });
      return { prompt, error: null };
    }
    console.warn('[text-node] reverse-prompt returned empty prompt', { jobId: ref.job_id });
    done(nodeId, { isGenerating: false, generationStartedAt: null });
    return { prompt: null, error: null };
  } catch (error) {
    console.error('[text-node] reverse-prompt failed', error);
    useCanvasStore
      .getState()
      .updateNodeData(nodeId, { isGenerating: false, generationStartedAt: null });
    return {
      prompt: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
