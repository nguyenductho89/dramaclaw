// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * Adapt the image model catalog delivered by the backend "media models" to the shape of `ImageModelDefinition` used by the old canvas nodes
 * (storyboard / image edit) and `ModelParamsControls`.
 *
 * These two nodes used to read the static registry in `features/canvas/models`, with the model list,
 * resolutions, aspect ratios and extra parameters all hard-coded in the frontend. Now these are all delivered by the catalog:
 * - list -> `useFreezoneImageModels()` (falls back to ProviderModelPicker's fallback list on failure)
 * - resolution / ratio -> the entry's resolutionOptions / ratioOptions (see mediaModelOptions)
 * - extra parameters -> the control declarations in the entry's request.parameters
 */

import { useMemo } from 'react';
// This uses the default i18next instance (the one `@/i18n` initializes). `@/i18n` itself is not imported,
// because that module also pulls in react-i18next / HttpBackend, and putting it on this widely imported low-level chain
// would make every test that mocks react-i18next blow up at import time.
import i18n from 'i18next';

import type { MediaModelRequestSchema } from '@/api/ops';
import type { ImageModelDefinition } from '@/features/canvas/models';
import { normalizeImageModelId } from '@/features/canvas/models';
import {
  isAuthoritativeEmptyCatalog,
  useFreezoneImageModels,
} from '@/features/canvas/hooks/useFreezoneImageModels';
import { SHARED_MODELS } from '@/features/canvas/ui/ProviderModelPicker';
import {
  formatResolutionLabel,
  resolveModelAspectOptions,
  resolveModelSizeOptions,
} from '@/features/canvas/domain/mediaModelOptions';

/**
 * Catalog entry fields needed for adaptation.
 *
 * A structural type is used instead of directly referencing `FreezoneImageModelInfo`, because the fallback list `ModelOption`
 * has a providerId wider than the catalog's `FreezoneProvider` (including video providers), and both must be accepted.
 */
export interface CatalogImageModelEntry {
  id: string;
  providerId: string;
  apiModel: string;
  label: string;
  resolutionOptions?: string[] | null;
  ratioOptions?: string[] | null;
  qualityOptions?: string[] | null;
  request?: MediaModelRequestSchema;
}

/** The resolution tier a node wants by default when the catalog gives none (it must still fall within the actually selectable tiers). */
const PREFERRED_DEFAULT_RESOLUTION = '2k';

/** Adapt one catalog entry into the `ImageModelDefinition` used by nodes. */
export function toImageModelDefinition(
  info: CatalogImageModelEntry,
): ImageModelDefinition {
  const resolutions = resolveModelSizeOptions(info).map((value) => ({
    value,
    label: formatResolutionLabel(value),
  }));
  const aspectRatios = resolveModelAspectOptions(info).map((value) => ({
    value,
    label: value,
  }));
  // Catalog parameters are passed as is to `MediaModelParameterChip`, no longer translated into the static registry's
  // `extraParamsSchema` (see the note on ImageModelDefinition.requestParameters: that translation
  // flattened multiselect into single select, flattened numeric/boolean options into strings, and the values were in the end not even submitted).
  const parameters = info.request?.parameters ?? [];

  return {
    id: info.id,
    mediaType: 'image',
    displayName: info.label,
    providerId: info.providerId,
    description: '',
    eta: '',
    defaultAspectRatio: aspectRatios[0]?.value ?? '1:1',
    defaultResolution:
      resolutions.find(
        (item) => item.value.toLowerCase() === PREFERRED_DEFAULT_RESOLUTION,
      )?.value
      ?? resolutions[0]?.value
      ?? PREFERRED_DEFAULT_RESOLUTION,
    aspectRatios,
    resolutions,
    ...(parameters.length > 0 ? { requestParameters: parameters } : {}),
    resolveRequest: ({ referenceImageCount }) => ({
      // The provider prefix must be included: `freezoneAiGateway.splitProviderModel` splits provider/model at the **first**
      // `/`. With a bare apiModel, ones without a slash such as `huimeng_gpt_image2` would lose the provider (falling back to the backend env), and ones with their own namespace like OpenRouter's
      // `google/gemini-2.5-flash-image-preview` would be cut into `gemini-...`, which does not match the model
      // configured in the catalog, and the backend `_catalog_image_execution_selection` returns 400 outright.
      // With the prefix added, what is split out is exactly (openrouter, google/gemini-2.5-flash-image-preview).
      requestModel: `${info.providerId}/${info.apiModel}`,
      modeLabel: i18n.t(
        referenceImageCount > 0
          ? 'canvas.imageModel.modeEdit'
          : 'canvas.imageModel.modeGenerate',
      ),
    }),
  };
}

export interface CatalogImageModels {
  /** All image models in the catalog, already adapted to `ImageModelDefinition`. An empty array for an authoritative empty catalog. */
  models: ImageModelDefinition[];
  /**
   * Get a model by the model id stored on the node.
   *
   * Fallback chain: exact id -> historical id alias -> same-named apiModel -> first catalog model. The node may
   * store a model the backend has taken offline, in which case it falls back to the first available model rather than crashing.
   *
   * For an authoritative empty catalog (`isEmpty`) return undefined - having no model to choose is a state the caller must
   * see, and it must not be covered up with a fallback model.
   */
  getModel: (modelId: string | null | undefined) => ImageModelDefinition | undefined;
  /** The catalog is on its way. At this point `models` is the fallback list, and do not use it to judge "whether there are models". */
  isLoading: boolean;
  /**
   * The backend **really** has not configured a single image model (the endpoint succeeded and returned an empty list), not a fetch-failure fallback.
   * When true, submission must be disabled: the backend `_resolve_catalog_request` returns 409 straight away for an empty catalog,
   * and letting the user pick a frontend hard-coded model only to receive an error is the worst experience.
   */
  isEmpty: boolean;
}

export function useCatalogImageModels(): CatalogImageModels {
  const { models: catalog, isLoading, isFallback } = useFreezoneImageModels();
  return useMemo(() => {
    // "Fetch failed" and "the backend simply has not configured" must be kept apart:
    // - failure (isFallback) -> `useFreezoneImageModels` has already put SHARED_MODELS in,
    //   the catalog is non-empty, use it as usual, and the user can keep working;
    // - loading -> same as above, prop up with the fallback first, do not flash "no available models";
    // - success but empty (isFallback=false and not loading) -> this is the backend's **authoritative answer**.
    //   Previously this fell back to SHARED_MODELS unconditionally, disguising "no model configured" as "models exist",
    //   and the user picked a frontend hard-coded model, clicked generate, and was only then bounced back by the backend with 409.
    const isEmpty = isAuthoritativeEmptyCatalog({
      models: catalog,
      isLoading,
      isFallback,
    });
    const source = isEmpty ? [] : catalog.length > 0 ? catalog : SHARED_MODELS;
    const models = source.map(toImageModelDefinition);
    const byId = new Map(models.map((model) => [model.id, model]));
    const byApiModel = new Map(
      source.map((info, index) => [info.apiModel, models[index]]),
    );
    return {
      models,
      isLoading,
      isEmpty,
      getModel: (modelId) => {
        const requested = String(modelId ?? '').trim();
        return (
          byId.get(requested)
          ?? byId.get(normalizeImageModelId(requested))
          ?? byApiModel.get(requested)
          ?? models[0]
        );
      },
    };
  }, [catalog, isFallback, isLoading]);
}

/**
 * A placeholder definition to prop up nodes under an authoritative empty catalog.
 *
 * Only so that selectors such as ratio / resolution have something to read, **never to be used for submission** - the submission path is
 * blocked dead by `isEmpty`. Deliberately not reusing `SHARED_MODELS[0]`: putting a real model name as a placeholder would make the user
 * think it is usable, exactly the kind of misleading this fix removes.
 */
export const EMPTY_CATALOG_IMAGE_MODEL: ImageModelDefinition = toImageModelDefinition({
  id: '',
  providerId: '',
  apiModel: '',
  label: i18n.t('canvas.imageModel.noneAvailable'),
});
