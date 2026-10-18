// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from 'vitest';

const submitFreezoneTextTranslate = vi.hoisted(() => vi.fn());
const fetchFreezoneTextTranslateResult = vi.hoisted(() => vi.fn());
const awaitTaskCompletion = vi.hoisted(() => vi.fn());
const readUrl = vi.hoisted(() => vi.fn());

vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  submitFreezoneTextTranslate,
  fetchFreezoneTextTranslateResult,
}));
vi.mock('@/api/tasks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  awaitTaskCompletion,
}));
vi.mock('@/lib/url-params', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readUrl,
}));

import { translateNodeText } from '@/features/canvas/application/translateText';

describe('translateNodeText (shared translation core, formerly 5 inline node implementations)', () => {
  beforeEach(() => {
    readUrl.mockReturnValue({ project: 'proj-1', canvas: 'canvas-1' });
    submitFreezoneTextTranslate.mockReset();
    fetchFreezoneTextTranslateResult.mockReset();
    awaitTaskCompletion.mockReset();
  });

  it('submits (with canvasId/nodeId context) -> waits for completion -> returns the translation', async () => {
    submitFreezoneTextTranslate.mockResolvedValue({
      task_key: 'tk-t',
      task_type: 'freezone_text_translate',
      job_id: 'job-t',
    });
    awaitTaskCompletion.mockResolvedValue({ result: {} });
    fetchFreezoneTextTranslateResult.mockResolvedValue({
      translated_text: 'a cinematic shot',
      source_language: 'zh',
      target_language: 'en',
      node_type: 'video',
    });

    const translated = await translateNodeText('proj-1', {
      text: 'A cinematic shot',
      nodeId: 'vid-1',
      nodeType: 'video',
    });

    expect(submitFreezoneTextTranslate).toHaveBeenCalledWith('proj-1', {
      text: 'A cinematic shot',
      nodeType: 'video',
      canvasId: 'canvas-1',
      nodeId: 'vid-1',
    });
    expect(awaitTaskCompletion).toHaveBeenCalledWith('tk-t', 'proj-1');
    expect(fetchFreezoneTextTranslateResult).toHaveBeenCalledWith('proj-1', 'job-t');
    expect(translated).toBe('a cinematic shot');
  });

  it('a missing canvasId falls back to default (consistent with the original implementation)', async () => {
    readUrl.mockReturnValue({ project: 'proj-1', canvas: null });
    submitFreezoneTextTranslate.mockResolvedValue({
      task_key: 'tk',
      task_type: 'freezone_text_translate',
      job_id: 'j',
    });
    awaitTaskCompletion.mockResolvedValue({ result: {} });
    fetchFreezoneTextTranslateResult.mockResolvedValue({ translated_text: 'x' });

    await translateNodeText('proj-1', { text: 'hi', nodeId: 'n1', nodeType: 'text' });
    expect(submitFreezoneTextTranslate.mock.calls[0][1]).toMatchObject({
      canvasId: 'default',
    });
  });

  it('failure is thrown upward (loading state / write-back are owned by the caller)', async () => {
    submitFreezoneTextTranslate.mockRejectedValue(new Error('translate down'));
    await expect(
      translateNodeText('proj-1', { text: 'hi', nodeId: 'n1', nodeType: 'text' }),
    ).rejects.toThrow('translate down');
  });
});
