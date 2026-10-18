// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { uploadFreezoneVideo } from '@/api/ops';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { isVideoFile } from './videoFileTypes';
import { ensureWebSafeVideo } from './videoTranscode';

export interface VideoReplaceUploadResult {
  /** The product address after upload; null when unsuccessful. */
  url: string | null;
  /** Failure reason; null on success or "not a video file / project missing" (the latter only logs an error). */
  error: string | null;
}

/**
 * Orchestration of replacing (re-uploading) a node's video (moved verbatim out of VideoNode.processFile, with zero semantic change):
 * validate it is a video -> set isUploading and write sourceFileName -> encodings Web cannot handle such as HEVC are first converted
 * to H.264 in the browser (see videoTranscode.ts) -> upload -> write back videoUrl and clear the preview image;
 * on failure clear isUploading.
 *
 * The local objectURL preview is left entirely to the caller (the workflow node uses it for "see the local picture first while uploading",
 * and the storyboard detail likewise): `onTranscodedPreview` is called back only once when transcoding really happens - the source codec
 * may not be decodable by this browser at all (Edge + HEVC), in which case the local preview must also be swapped for the transcoded product.
 */
export async function replaceNodeVideo(
  nodeId: string,
  file: File,
  hooks?: { onTranscodedPreview?: (transcoded: File) => void },
): Promise<VideoReplaceUploadResult> {
  if (!isVideoFile(file)) return { url: null, error: null };
  const projectId = readUrl().project;
  if (!projectId) {
    console.error('[video-replace] no project in URL');
    return { url: null, error: null };
  }
  const store = useCanvasStore.getState();
  store.updateNodeData(nodeId, { sourceFileName: file.name, isUploading: true });
  try {
    // Encodings Web cannot handle such as HEVC (Feishu screen recordings/iPhone) are first converted to H.264 in the browser and then uploaded,
    // otherwise browsers without a matching decoder such as Edge give only sound and no picture. See videoTranscode.ts.
    // During transcoding the UI uniformly shows the "uploading" loading and shows no separate transcoding progress.
    const prepared = await ensureWebSafeVideo(file);
    if (prepared.transcoded) {
      hooks?.onTranscodedPreview?.(prepared.file);
    }
    const uploaded = await uploadFreezoneVideo(
      projectId,
      prepared.file,
      prepared.file.name,
    );
    useCanvasStore.getState().updateNodeData(nodeId, {
      videoUrl: uploaded.url,
      previewImageUrl: null,
      sourceFileName: file.name,
      isUploading: false,
    });
    return { url: uploaded.url, error: null };
  } catch (error) {
    console.error('[video-replace] upload failed', error);
    useCanvasStore.getState().updateNodeData(nodeId, { isUploading: false });
    return {
      url: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
