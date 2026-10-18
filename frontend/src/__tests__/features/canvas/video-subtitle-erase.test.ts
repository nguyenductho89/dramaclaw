// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from 'vitest';

const submitFreezoneVideoErase = vi.hoisted(() => vi.fn());
const fetchFreezoneJobResult = vi.hoisted(() => vi.fn());
const awaitTaskCompletion = vi.hoisted(() => vi.fn());

vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  submitFreezoneVideoErase,
  fetchFreezoneJobResult,
}));
vi.mock('@/api/tasks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  awaitTaskCompletion,
}));

import { runVideoSubtitleErase } from '@/features/canvas/application/videoSubtitleErase';

describe('runVideoSubtitleErase (subtitle erase submission core, extracted from VideoNode)', () => {
  beforeEach(() => {
    submitFreezoneVideoErase.mockReset();
    fetchFreezoneJobResult.mockReset();
    awaitTaskCompletion.mockReset();
  });

  it('smart tier: submit -> wait for completion -> fetch the job result (with the output url)', async () => {
    submitFreezoneVideoErase.mockResolvedValue({
      task_key: 'tk-e',
      task_type: 'freezone_video_erase',
      job_id: 'job-e',
    });
    awaitTaskCompletion.mockResolvedValue({ result: {} });
    fetchFreezoneJobResult.mockResolvedValue({ url: '/static/no-sub.mp4' });

    const result = await runVideoSubtitleErase('proj-1', {
      sourceUrl: '/static/v.mp4',
      mode: 'smart_subtitle',
      box: null,
    });

    expect(submitFreezoneVideoErase).toHaveBeenCalledWith('proj-1', {
      sourceUrl: '/static/v.mp4',
      mode: 'smart_subtitle',
      box: null,
    });
    expect(awaitTaskCompletion).toHaveBeenCalledWith('tk-e', 'proj-1');
    expect(fetchFreezoneJobResult).toHaveBeenCalledWith(
      'proj-1',
      'freezone_video_erase',
      'job-e',
    );
    expect(result.url).toBe('/static/no-sub.mp4');
  });

  it('submit failure is thrown upward (UI state is cleaned up by the caller)', async () => {
    submitFreezoneVideoErase.mockRejectedValue(new Error('erase failed'));
    await expect(
      runVideoSubtitleErase('proj-1', {
        sourceUrl: '/static/v.mp4',
        mode: 'smart_subtitle',
        box: null,
      }),
    ).rejects.toThrow('erase failed');
    expect(fetchFreezoneJobResult).not.toHaveBeenCalled();
  });
});
