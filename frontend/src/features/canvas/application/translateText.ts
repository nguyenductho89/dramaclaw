// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  fetchFreezoneTextTranslateResult,
  submitFreezoneTextTranslate,
  type FreezoneTextTranslateNodeType,
} from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import { readUrl } from '@/lib/url-params';

/**
 * The shared core of text translation (the same orchestration formerly inlined separately in ImageGenNode / VideoNode / TextAnnotationNode / ScriptNode /
 * AudioOperationsPanel): submit /freezone/text/translate ->
 * wait for the task to complete -> take the translation. canvasId is uniformly taken from the current URL (consistent with the original implementation).
 * The project guard, loading state and writing back the translation (the fields differ per node) are held by the caller.
 */
export async function translateNodeText(
  project: string,
  params: { text: string; nodeId: string; nodeType: FreezoneTextTranslateNodeType },
): Promise<string> {
  const ref = await submitFreezoneTextTranslate(project, {
    text: params.text,
    nodeType: params.nodeType,
    canvasId: readUrl().canvas ?? 'default',
    nodeId: params.nodeId,
  });
  await awaitTaskCompletion(ref.task_key, project);
  const result = await fetchFreezoneTextTranslateResult(project, ref.job_id);
  return result.translated_text;
}
