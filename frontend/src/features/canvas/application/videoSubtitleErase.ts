// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  fetchFreezoneJobResult,
  submitFreezoneVideoErase,
  type FreezoneJobResult,
  type FreezoneVideoErasePayload,
} from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';

/**
 * The video subtitle removal submission core (extracted verbatim from VideoNode.handleEraseSubmit, with zero semantic change):
 * submit /freezone/video/erase -> wait for the task to complete -> take the job result (the product url is in result.url).
 * UI state (isErasing, subtitleEraseMode cleanup, videoUrl write-back) is held by the caller -
 * the workflow node's subtitle removal panel and the storyboard detail's "Smart subtitle removal" share this one submission path.
 */
export async function runVideoSubtitleErase(
  project: string,
  payload: FreezoneVideoErasePayload,
): Promise<FreezoneJobResult> {
  const ref = await submitFreezoneVideoErase(project, payload);
  await awaitTaskCompletion(ref.task_key, project);
  return await fetchFreezoneJobResult(project, 'freezone_video_erase', ref.job_id);
}
