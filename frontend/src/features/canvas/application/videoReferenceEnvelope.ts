// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  videoReferenceEnvelopeForModel,
  type VideoReferenceEnvelope,
} from '@/features/canvas/domain/videoReferenceLimits';
import { readFreezoneVideoModels } from '@/features/canvas/hooks/useFreezoneVideoModels';
import type { ModelOption } from '@/features/canvas/ui/ProviderModelPicker';

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
  return videoReferenceEnvelopeForModel(model);
}
