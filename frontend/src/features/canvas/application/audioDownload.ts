// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  canProduceFormat,
  getAudioExtFromUrl,
  transcodeAudio,
  type AudioDownloadFormat,
} from '@/lib/audioTranscode';
import { downloadBlobAsFile, downloadUrlAsFile } from '@/lib/browserDownload';

import { resolveImageDisplayUrl } from './imageData';

/**
 * The shared core of audio "download as a specified format" (extracted from NodeActionToolbar.handleAudioDownload,
 * with zero semantic change): when the target container is the same as the source (or m4a direct take), pass through and download the original bytes; otherwise fetch ->
 * frontend transcode -> trigger the download. The transcoding start/end are notified to the caller via onConvertingChange (the node toolbar writes
 * convertingAudioFormat of node data, and the storyboard audio chip uses local state).
 * The availability pre-check (canProduceFormat) and the error hint are held by the caller; failures are thrown upward.
 */
export async function downloadAudioAs(
  format: AudioDownloadFormat,
  params: {
    audioUrl: string;
    /** The file name body without an extension (the caller has already stripped the trailing audio extension). */
    baseFileName: string;
    onConvertingChange?: (format: AudioDownloadFormat | null) => void;
  },
): Promise<void> {
  const sourceExt = getAudioExtFromUrl(params.audioUrl);
  const filename = `${params.baseFileName}.${format}`;
  const resolvedUrl = resolveImageDisplayUrl(params.audioUrl);
  // Passthrough (target container == source): download original bytes via
  // downloadUrlAsFile (robust cross-origin fallback + correct extension),
  // no lossy re-encode.
  const passthrough =
    format === sourceExt || (format === 'm4a' && canProduceFormat('m4a', sourceExt));
  if (passthrough) {
    await downloadUrlAsFile(resolvedUrl, filename);
    return;
  }
  params.onConvertingChange?.(format);
  try {
    const resp = await fetch(resolvedUrl);
    if (!resp.ok) {
      throw new Error(`fetch failed: ${resp.status}`);
    }
    const srcBlob = await resp.blob();
    const outBlob = await transcodeAudio(srcBlob, sourceExt, format);
    downloadBlobAsFile(outBlob, filename);
  } finally {
    params.onConvertingChange?.(null);
  }
}
