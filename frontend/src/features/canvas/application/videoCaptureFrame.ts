// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { uploadFreezoneImage } from '@/api/ops';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { resolveImageDisplayUrl } from './imageData';
import { captureVideoFrameBlob } from './videoFrameBlob';

/** Capture frame tier: first frame / last frame / the player's current frame. */
export type VideoCaptureFrameMode = 'first' | 'last' | 'current';

export { captureVideoFrameBlob };

/**
 * The seek position corresponding to the three capture tiers (pure computation extracted from VideoNode.handleCaptureFrame):
 * - first  -> 0
 * - last   -> duration - 0.05s; when the duration is entirely unknown give MAX_SAFE_INTEGER, letting
 *            captureVideoFrameBlob clamp to the end by the actual duration internally
 * - current-> the live player's currentTime; fall back to 0 if unavailable
 *
 * `liveDurationSec` is the duration reported by the <video> that is playing in the detail/node (the most accurate),
 * `fallbackDurationSec` is the fallback converted from the node's data.durationMs.
 */
export function resolveCaptureSeekSec(
  mode: VideoCaptureFrameMode,
  live: {
    currentTimeSec?: number | null;
    durationSec?: number | null;
    fallbackDurationSec?: number | null;
  },
): number {
  if (mode === 'first') return 0;
  if (mode === 'last') {
    const liveDuration =
      typeof live.durationSec === 'number' && Number.isFinite(live.durationSec)
        ? live.durationSec
        : null;
    const knownDuration = liveDuration ?? live.fallbackDurationSec ?? null;
    return knownDuration != null
      ? Math.max(0, knownDuration - 0.05)
      : Number.MAX_SAFE_INTEGER;
  }
  return typeof live.currentTimeSec === 'number' && Number.isFinite(live.currentTimeSec)
    ? live.currentTimeSec
    : 0;
}

export interface VideoCaptureFrameResult {
  /** The id of the newly built image node; null on failure. */
  nodeId: string | null;
  /** Failure reason; null on success. */
  error: string | null;
}

/**
 * Frame capture orchestration (moved verbatim out of VideoNode.handleCaptureFrame, with zero semantic change; the node type
 * was later changed to exportImage, see below): extract the frame -> upload as png -> build a derived image
 * result node downstream of the source node, connect an edge and write the title. The image ratio prefers the source video's pixel width and height,
 * then data.aspectRatio, then 16:9.
 *
 * The result node is built with addDerivedExportNode as exportImage (not upload): an upload
 * node has no target handle, so the addEdge below would silently fail to connect; exportImage has a
 * target handle and is not restricted by the upstream whitelist, consistent with derived image flows such as matting/rotation.
 *
 * The seek position is computed in advance by the caller with {@link resolveCaptureSeekSec} - only the caller can get
 * that live <video> element (the in-node player in the workflow, the large detail player in the storyboard).
 * 那个活的 <video> 元素（工作流是节点内播放器，故事板是详情大播放器）。
 */
export async function captureVideoFrameToNode(
  sourceNodeId: string,
  opts: {
    videoUrl: string;
    seekSec: number;
    projectId?: string | null;
    /** The title of the result node (first/last/current frame; the text is decided by the caller per its own i18n). */
    displayName: string;
  },
): Promise<VideoCaptureFrameResult> {
  if (!opts.videoUrl) return { nodeId: null, error: null };
  const projectId = opts.projectId?.trim() || readUrl().project;
  if (!projectId) {
    console.error('[video-capture-frame] no project in URL');
    return { nodeId: null, error: null };
  }
  const store = useCanvasStore.getState();
  const node = store.nodes.find((candidate) => candidate.id === sourceNodeId);
  if (!node) return { nodeId: null, error: null };
  const data = node.data as Record<string, unknown>;

  try {
    const blob = await captureVideoFrameBlob(
      resolveImageDisplayUrl(opts.videoUrl),
      opts.seekSec,
    );
    const filename = `frame-${Date.now()}.png`;
    const file = new File([blob], filename, { type: 'image/png' });
    const uploaded = await uploadFreezoneImage(projectId, file, filename);

    const widthPx = typeof data.widthPx === 'number' ? data.widthPx : null;
    const heightPx = typeof data.heightPx === 'number' ? data.heightPx : null;
    const aspectForNode =
      widthPx && heightPx && widthPx > 0 && heightPx > 0
        ? `${widthPx}:${heightPx}`
        : (typeof data.aspectRatio === 'string' && data.aspectRatio) || '16:9';

    const done = useCanvasStore.getState();
    // exportImage (not upload): an upload node has no target handle (nodeRegistry.ts),
    // so the addEdge below cannot connect and silently fails. exportImage has a target handle and is not in the upstream
    // whitelist, the unified landing point for derived image flows such as matting/rotation. aspectRatioStrategy takes
    // 'derivedFromSource', keeping the sizing behavior consistent with addDerivedUploadNode
    // (both go through resolveDerivedAspectRatio(sourceNode, aspectRatio)).
    const createdNodeId = done.addDerivedExportNode(
      sourceNodeId,
      uploaded.url,
      aspectForNode,
      uploaded.url,
      { aspectRatioStrategy: 'derivedFromSource' },
    );
    if (createdNodeId) {
      done.updateNodeData(createdNodeId, { displayName: opts.displayName });
      done.addEdge(sourceNodeId, createdNodeId);
    }
    return { nodeId: createdNodeId, error: null };
  } catch (error) {
    console.error('[video-capture-frame] frame capture failed', error);
    return {
      nodeId: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
