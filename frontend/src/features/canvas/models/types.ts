// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { MediaModelParameterDefinition } from '@/api/ops';
import type { ModelPricingDefinition } from '@/features/canvas/pricing/types';

export type MediaModelType = 'image' | 'video' | 'audio';

export interface ModelProviderDefinition {
  id: string;
  name: string;
  label: string;
}

export interface AspectRatioOption {
  value: string;
  label: string;
}

export interface ResolutionOption {
  value: string;
  label: string;
}

export interface ImageModelRuntimeContext {
  extraParams?: Record<string, unknown>;
}

export type ExtraParamType = 'boolean' | 'enum' | 'number' | 'string';

export interface ExtraParamDefinition {
  key: string;
  label: string;
  labelKey?: string;
  type: ExtraParamType;
  description?: string;
  descriptionKey?: string;
  defaultValue?: boolean | number | string;
  options?: Array<{ value: string; label: string; labelKey?: string }>;
  min?: number;
  max?: number;
  step?: number;
}

export interface ImageModelDefinition {
  id: string;
  mediaType: 'image';
  displayName: string;
  providerId: string;
  description: string;
  eta: string;
  expectedDurationMs?: number;
  defaultAspectRatio: string;
  defaultResolution: string;
  aspectRatios: AspectRatioOption[];
  resolutions: ResolutionOption[];
  resolveResolutions?: (context: ImageModelRuntimeContext) => ResolutionOption[];
  extraParamsSchema?: ExtraParamDefinition[];
  defaultExtraParams?: Record<string, unknown>;
  /**
   * The `request.parameters` delivered by the backend "media models" are carried over as is, handed to
   * `MediaModelParameterChip` for rendering and submitted as `model_params`.
   *
   * Deliberately not stuffed into the `extraParamsSchema` above: that is the old structure of the frontend static registry, recognizing only
   * enum/boolean/number/string, with no multiselect, no modes filtering, and option values all
   * flattened into strings by `String()`. A multiselect parameter in the catalog rendered by it would degrade to single select,
   * numeric/boolean options would become strings, and the backend `media_model_request_schema` type validation would reject it outright.
   * The two sets of schema each manage their own and do not translate each other.
   */
  requestParameters?: MediaModelParameterDefinition[];
  pricing?: ModelPricingDefinition;
  resolveRequest: (context: { referenceImageCount: number }) => {
    requestModel: string;
    modeLabel: string;
  };
}
