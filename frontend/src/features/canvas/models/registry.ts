// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type {
  ImageModelDefinition,
  ImageModelRuntimeContext,
  ModelProviderDefinition,
  ResolutionOption,
} from './types';

const providerModules = import.meta.glob<{ provider: ModelProviderDefinition }>(
  './providers/*.ts',
  { eager: true }
);

const SUPERTALE_PROVIDER_IDS = new Set(['huimeng', 'openai', 'openrouter']);

const providers: ModelProviderDefinition[] = Object.values(providerModules)
  .map((module) => module.provider)
  .filter((provider): provider is ModelProviderDefinition => Boolean(provider))
  .filter((provider) => SUPERTALE_PROVIDER_IDS.has(provider.id))
  .sort((a, b) => a.id.localeCompare(b.id));

const providerMap = new Map<string, ModelProviderDefinition>(
  providers.map((provider) => [provider.id, provider])
);

// The image model list itself comes from the backend "media models" config (`/freezone/image/models`), and the frontend no longer
// maintains a static registry; see `domain/catalogImageModels.ts`. Only two kinds of things are kept here:
//   1. The display names of providers - the catalog sends only providerId, with no display name;
//   2. Aliases of historical model ids - old canvas nodes store ids that no longer exist.
export const DEFAULT_IMAGE_MODEL_ID = 'openrouter/default';

const imageModelAliasMap = new Map<string, string>([
  ['gemini-3.1-flash', DEFAULT_IMAGE_MODEL_ID],
  ['gemini-3.1-flash-edit', DEFAULT_IMAGE_MODEL_ID],
  ['ppio/gemini-3.1-flash', DEFAULT_IMAGE_MODEL_ID],
  ['google/gemini-3-pro-image', DEFAULT_IMAGE_MODEL_ID],
  ['volcengine/seedream-4', 'huimeng/default'],
  ['fal/nano-banana-2', DEFAULT_IMAGE_MODEL_ID],
  ['fal/nano-banana-pro', DEFAULT_IMAGE_MODEL_ID],
  ['kie/nano-banana-2', DEFAULT_IMAGE_MODEL_ID],
  ['kie/nano-banana-pro', DEFAULT_IMAGE_MODEL_ID],
  ['grsai/nano-banana-2', DEFAULT_IMAGE_MODEL_ID],
  ['grsai/nano-banana-pro', DEFAULT_IMAGE_MODEL_ID],
]);

/** Normalize the model id stored on historical nodes to the current id; unknown ids are returned as is. */
export function normalizeImageModelId(modelId: string): string {
  return imageModelAliasMap.get(modelId) ?? modelId;
}

export function listModelProviders(): ModelProviderDefinition[] {
  return providers;
}

export function resolveImageModelResolutions(
  model: ImageModelDefinition,
  context: ImageModelRuntimeContext = {}
): ResolutionOption[] {
  const resolvedOptions = model.resolveResolutions?.(context);
  return resolvedOptions && resolvedOptions.length > 0 ? resolvedOptions : model.resolutions;
}

export function resolveImageModelResolution(
  model: ImageModelDefinition,
  requestedResolution: string | undefined,
  context: ImageModelRuntimeContext = {}
): ResolutionOption {
  const resolutionOptions = resolveImageModelResolutions(model, context);

  return (
    (requestedResolution
      ? resolutionOptions.find(
          (item) => item.value.toLowerCase() === requestedResolution.toLowerCase(),
        )
      : undefined) ??
    resolutionOptions.find(
      (item) => item.value.toLowerCase() === model.defaultResolution.toLowerCase(),
    ) ??
    resolutionOptions[0] ??
    model.resolutions[0]
  );
}

export function getModelProvider(providerId: string): ModelProviderDefinition {
  return (
    providerMap.get(providerId) ?? {
      id: providerId || 'unknown',
      // When the backend newly configures a provider the frontend does not recognize yet, use the id directly as the display name,
      // rather than showing "Unknown Provider".
      name: providerId || 'Unknown Provider',
      label: providerId || 'Unknown',
    }
  );
}
