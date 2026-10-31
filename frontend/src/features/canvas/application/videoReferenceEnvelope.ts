// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  videoReferenceEnvelopeForModel,
  type VideoReferenceEnvelope,
} from '@/features/canvas/domain/videoReferenceLimits';
import { readFreezoneVideoModels } from '@/features/canvas/hooks/useFreezoneVideoModels';
import { modelContinuesFromLastFrame } from '@/features/canvas/nodes/shared/videoModelCapabilities';
import type { ModelOption } from '@/features/canvas/ui/ProviderModelPicker';

/** H3 smart extend: the backend uses one image slot for the last frame of the source video (see H3_EXTEND_MAX_REFERENCE_IMAGES). */
const H3_EXTEND_MAX_IMAGES = 8;

/**
 * Resolve a video node into the reference limit envelope of its **currently selected model**.
 *
 * Edge validation (Canvas's isValidConnection, canvasStore's onConnect/addEdge) runs outside React
 * and cannot get the return value of useFreezoneVideoModels, so the catalog is read here directly from the same module-level store.
 * The domain layer stays pure functions and accepts only the computed envelope, with the resolving placed in the application layer.
 *
 * The fallback basis must match VideoNode's `selectedVideoModel`: when `data.model` is not stored or cannot be found in the catalog,
 * use the first model in the list - exactly the one ProviderModelPicker shows and submission will use too.
 * If the two sides disagree, we would get "the UI shows model A's limit while edge creation blocks by model B".
 *
 * The models parameter is only for tests to inject a catalog; production code should not pass it.
 */
export function videoReferenceEnvelopeForNode(
  videoNode: CanvasNode,
  models: ModelOption[] = readFreezoneVideoModels(),
): VideoReferenceEnvelope {
  const persisted =
    typeof videoNode.data?.model === 'string' && videoNode.data.model.length > 0
      ? videoNode.data.model
      : null;
  const model =
    (persisted ? models.find((entry) => entry.id === persisted) : undefined) ??
    models[0];
  const envelope = videoReferenceEnvelopeForModel(model);
  // A smart-extend node on a model that continues from the last frame (MiniMax H3) is wired to its source video, yet the model's own
  // video reference cap is 0: the video is consumed server-side (its last frame becomes the first frame), not sent as a reference.
  // Judged by the model cap alone, the edge to the source clip would be rejected and the node would have nothing to extend.
  if (videoNode.data?.isExtendMode === true && modelContinuesFromLastFrame(model)) {
    const image = Math.min(envelope.image, H3_EXTEND_MAX_IMAGES);
    const video = Math.max(envelope.video, 1);
    return { image, video, audio: envelope.audio, total: image + video + envelope.audio };
  }
  return envelope;
}
