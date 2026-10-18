// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * How image capability panels "without a model selector" (360 panorama, grid actions) resolve the model.
 *
 * Such panels do not let the user pick the model / size / quality, and the caller selects a catalog model by feature rules
 * (e.g. 360 is fixed to LingShan-G2, grid uses the catalog default model). Previously the quote and the submission each did their own thing:
 * the quote was computed by the selected model + converged size/quality, but the submission carried
 * none of them, so the backend ran with its own `FREEZONE_DEFAULT_IMAGE_MODEL` and a fixed 2K.
 * The result: when "the catalog's first model != the backend default model" or "that model has no 2K", the price shown on the UI,
 * the capability tiers and what actually runs were entirely different, and the backend's media model config was as good as ineffective on these two panels.
 *
 * Here the quote parameters and the submission fields are **produced together from the same resolution**, leaving no chance for them to diverge.
 */

import { buildImageFeatureBillingParams } from '@/features/canvas/domain/imageBilling';
import {
  pickAllowedOption,
  resolveModelQualityOptions,
  resolveModelSizeOptions,
  type MediaModelCapabilities,
} from '@/features/canvas/domain/mediaModelOptions';

/** The catalog entry fields needed for resolution (both `FreezoneImageModelInfo` and the fallback `ModelOption` satisfy them). */
export interface FixedFeatureModel extends MediaModelCapabilities {
  catalogId?: string;
  apiModel?: string;
}

/** Model-related fields submitted to `/freezone/scene-360` and `/freezone/template-edit`. */
export interface FixedFeatureSubmitFields {
  /**
   * The bare `apiModel`, without a provider prefix.
   *
   * These two old routes infer the provider in different ways (scene-360 always goes by newapi,
   * template-edit alone recognizes `provider/model`), and a prefix would be taken as the whole model name on the scene-360 side.
   * Send the bare name uniformly, leaving the provider to the backend under each one's old rules.
   */
  model?: string;
  /** Catalog identity. With it the backend bills by the catalog pricing rules, consistent with the quote basis. */
  catalogId?: string;
  imageSize: string;
  /** Present only if the catalog declares qualityOptions; if not declared it is not sent and not quoted by quality. */
  quality?: string;
}

export interface FixedFeatureModelRequest {
  submit: FixedFeatureSubmitFields;
  /** The `params` fed directly to `useGenerationCreditCost`. */
  billingParams: Record<string, unknown>;
}

/** The default tier wanted when the panel provides no selector (it must still fall within the tiers the model actually supports). */
const PREFERRED_SIZE = '2K';
const PREFERRED_QUALITY = 'medium';

export function resolveFixedFeatureModelRequest(
  model: FixedFeatureModel | null | undefined,
  extraBillingParams: Record<string, unknown> = {},
): FixedFeatureModelRequest {
  const imageSize = pickAllowedOption(PREFERRED_SIZE, resolveModelSizeOptions(model));
  const qualityOptions = resolveModelQualityOptions(model);
  const quality =
    qualityOptions.length > 0
      ? pickAllowedOption(PREFERRED_QUALITY, qualityOptions)
      : undefined;
  const apiModel = String(model?.apiModel ?? '').trim();
  const catalogId = String(model?.catalogId ?? '').trim();

  return {
    submit: {
      ...(apiModel ? { model: apiModel } : {}),
      ...(catalogId ? { catalogId } : {}),
      imageSize,
      ...(quality ? { quality } : {}),
    },
    billingParams: buildImageFeatureBillingParams(model, {
      size: imageSize,
      ...(quality ? { quality } : {}),
      ...extraBillingParams,
    }),
  };
}
