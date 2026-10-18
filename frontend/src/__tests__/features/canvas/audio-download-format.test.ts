// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const downloadUrlAsFile = vi.hoisted(() => vi.fn());
const downloadBlobAsFile = vi.hoisted(() => vi.fn());
const transcodeAudio = vi.hoisted(() => vi.fn());

vi.mock('@/lib/browserDownload', () => ({
  downloadUrlAsFile,
  downloadBlobAsFile,
}));
vi.mock('@/lib/audioTranscode', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  transcodeAudio,
}));

import { downloadAudioAs } from '@/features/canvas/application/audioDownload';

describe('downloadAudioAs (audio format download core, extracted from NodeActionToolbar)', () => {
  beforeEach(() => {
    downloadUrlAsFile.mockReset().mockResolvedValue(undefined);
    downloadBlobAsFile.mockReset();
    transcodeAudio.mockReset();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, blob: async () => new Blob(['audio']) })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('same container (mp3->mp3) passes the original bytes through for download without transcoding', async () => {
    const onConvertingChange = vi.fn();
    await downloadAudioAs('mp3', {
      audioUrl: '/static/bg.mp3',
      baseFileName: 'bg',
      onConvertingChange,
    });

    expect(downloadUrlAsFile).toHaveBeenCalledWith('/static/bg.mp3', 'bg.mp3');
    expect(transcodeAudio).not.toHaveBeenCalled();
    expect(onConvertingChange).not.toHaveBeenCalled();
  });

  it('cross container (mp3->wav) fetch -> transcode -> download the blob, with transcode start/end callbacks', async () => {
    const onConvertingChange = vi.fn();
    const outBlob = new Blob(['wav']);
    transcodeAudio.mockResolvedValue(outBlob);

    await downloadAudioAs('wav', {
      audioUrl: '/static/bg.mp3',
      baseFileName: 'bg',
      onConvertingChange,
    });

    expect(transcodeAudio).toHaveBeenCalledTimes(1);
    expect(transcodeAudio.mock.calls[0][1]).toBe('mp3');
    expect(transcodeAudio.mock.calls[0][2]).toBe('wav');
    expect(downloadBlobAsFile).toHaveBeenCalledWith(outBlob, 'bg.wav');
    expect(onConvertingChange.mock.calls).toEqual([['wav'], [null]]);
  });

  it('a transcode failure is thrown upward and the transcoding state is always cleared', async () => {
    const onConvertingChange = vi.fn();
    transcodeAudio.mockRejectedValue(new Error('ffmpeg boom'));

    await expect(
      downloadAudioAs('wav', {
        audioUrl: '/static/bg.mp3',
        baseFileName: 'bg',
        onConvertingChange,
      }),
    ).rejects.toThrow('ffmpeg boom');
    expect(onConvertingChange.mock.calls).toEqual([['wav'], [null]]);
    expect(downloadBlobAsFile).not.toHaveBeenCalled();
  });
});
