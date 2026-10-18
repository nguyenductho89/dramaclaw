// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Definitions of the LLM mappings used by each system feature.
// Each feature maps to a backend *_MODEL environment variable, and the frontend lets the user override the model.
// Structured tasks have reasoning turned off by the backend, so there is no per-feature thinking-effort setting.

export interface FeatureModelDef {
  /** Stable id, matching the backend *_MODEL env var prefix, e.g. GLOBAL_VIDEO_OPTIMIZER. */
  id: string;
  /** The backend default model name, used for the "Default" dropdown entry and as the initial available model pool. */
  defaultModel: string;
  /** This feature sends images to the upstream LLM, so a model with vision input must be selected. */
  requiresVision?: boolean;
}

export interface FeatureModelGroup {
  /** Group key, used to build the i18n key settings.modelConfig.featureModels.groups.<key>. */
  key: string;
  features: readonly FeatureModelDef[];
}

export const FEATURE_MODEL_GROUPS: readonly FeatureModelGroup[] = [
  {
    key: "chat",
    features: [{ id: "HERMES", defaultModel: "DC-hermes-LLM" }],
  },
  {
    key: "shot",
    features: [
      {
        id: "GLOBAL_VIDEO_OPTIMIZER",
        defaultModel: "DC-video-prompt-optimizer-LLM",
        requiresVision: true,
      },
      { id: "SEEDANCE2_PROMPT_COMPOSER", defaultModel: "DC-seedance2-prompt-composer-LLM" },
    ],
  },
  {
    key: "sketch",
    features: [
      {
        id: "GLOBAL_VIDEO_IDENTITY_DETECTOR",
        defaultModel: "DC-video-identity-detector-LLM",
        requiresVision: true,
      },
    ],
  },
  {
    key: "episode",
    features: [
      { id: "IDENTITY_PLANNER_CAST", defaultModel: "DC-identity-cast-planner-LLM" },
      { id: "IDENTITY_PLANNER_ANALYSIS", defaultModel: "DC-identity-analysis-planner-LLM" },
      { id: "IDENTITY_PLANNER_APPEARANCE", defaultModel: "DC-identity-appearance-writer-LLM" },
      { id: "LITERAL_BEAT_META", defaultModel: "DC-literal-beat-meta-LLM" },
      { id: "EPISODE_SCENE_PLANNER", defaultModel: "DC-episode-scene-planner-LLM" },
      { id: "EPISODE_PROP_PLANNER", defaultModel: "DC-episode-prop-planner-LLM" },
    ],
  },
  {
    key: "sceneLibrary",
    features: [
      { id: "CHARACTER_BUILD", defaultModel: "DC-character-builder-LLM" },
      { id: "SCENE_BUILD", defaultModel: "DC-scene-builder-LLM" },
    ],
  },
  {
    key: "freezone",
    features: [
      { id: "FREEZONE_TRANSLATION", defaultModel: "DC-freezone-translator-LLM" },
      { id: "FREEZONE_TEXT_WRITER", defaultModel: "DC-freezone-text-writer-LLM" },
      { id: "FREEZONE_STORY_SCRIPT", defaultModel: "DC-freezone-story-script-writer-LLM" },
      { id: "FREEZONE_RECIPE_COMPILER", defaultModel: "DC-freezone-recipe-compiler-LLM" },
      {
        id: "FREEZONE_VISION",
        defaultModel: "DC-freezone-vision-LLM",
        requiresVision: true,
      },
    ],
  },
  {
    key: "style",
    features: [
      {
        id: "STYLE_ANALYZER",
        defaultModel: "DC-style-analyzer-LLM",
        requiresVision: true,
      },
    ],
  },
  {
    key: "contentRewrite",
    features: [{ id: "CONTENT_REWRITER", defaultModel: "DC-content-rewriter-LLM" }],
  },
  {
    key: "screenplay",
    features: [{ id: "SCREENPLAY_NORMALIZER", defaultModel: "DC-screenplay-normalizer-LLM" }],
  },
  {
    key: "assetCompile",
    features: [
      { id: "EPISODE_SCENE_RECONCILE", defaultModel: "DC-episode-scene-reconciler-LLM" },
      { id: "NARRATED_SCENE_ASSET", defaultModel: "DC-narrated-scene-asset-planner-LLM" },
    ],
  },
  {
    key: "directorWorld",
    features: [{ id: "STAGING_PROP", defaultModel: "DC-staging-prop-planner-LLM" }],
  },
  {
    key: "novelImport",
    features: [{ id: "COGNEE", defaultModel: "DC-cognee-LLM" }],
  },
];

const FEATURE_MODEL_BY_ID = new Map(
  FEATURE_MODEL_GROUPS.flatMap((group) => group.features.map((feature) => [feature.id, feature])),
);

function productFeature(id: string): FeatureModelDef {
  const feature = FEATURE_MODEL_BY_ID.get(id);
  if (!feature) throw new Error(`Unknown feature model id: ${id}`);
  return feature;
}

/**
 * Product entry groups in the settings UI. This only decides where things are shown; the system default model order, channel mapping
 * and backend env vars are still decided by FEATURE_MODEL_GROUPS, so renaming in the UI cannot affect runtime logic.
 */
export const FEATURE_MODEL_PRODUCT_GROUPS: readonly FeatureModelGroup[] = [
  {
    key: "xiahua",
    features: [
      productFeature("FREEZONE_TRANSLATION"),
      productFeature("FREEZONE_TEXT_WRITER"),
      productFeature("FREEZONE_STORY_SCRIPT"),
      productFeature("FREEZONE_RECIPE_COMPILER"),
      productFeature("FREEZONE_VISION"),
      productFeature("STAGING_PROP"),
    ],
  },
  {
    key: "xialiao",
    features: [productFeature("CONTENT_REWRITER"), productFeature("SCREENPLAY_NORMALIZER")],
  },
  {
    key: "xiatan",
    features: [productFeature("CHARACTER_BUILD"), productFeature("SCENE_BUILD")],
  },
  {
    key: "xiajing",
    features: [
      productFeature("GLOBAL_VIDEO_OPTIMIZER"),
      productFeature("SEEDANCE2_PROMPT_COMPOSER"),
      productFeature("GLOBAL_VIDEO_IDENTITY_DETECTOR"),
      productFeature("IDENTITY_PLANNER_CAST"),
      productFeature("IDENTITY_PLANNER_ANALYSIS"),
      productFeature("IDENTITY_PLANNER_APPEARANCE"),
      productFeature("LITERAL_BEAT_META"),
      productFeature("EPISODE_SCENE_PLANNER"),
      productFeature("EPISODE_PROP_PLANNER"),
      productFeature("EPISODE_SCENE_RECONCILE"),
      productFeature("NARRATED_SCENE_ASSET"),
    ],
  },
  { key: "xiadao", features: [productFeature("HERMES")] },
  { key: "xiage", features: [productFeature("STYLE_ANALYZER")] },
];

/** Default models of all features (deduplicated), used to pre-fill the "available models" pool. */
export const DEFAULT_AVAILABLE_MODELS: readonly string[] = Array.from(
  new Set(FEATURE_MODEL_GROUPS.flatMap((g) => g.features.map((f) => f.defaultModel)))
);

const FEATURE_DEFAULT_MODEL_BY_ID: Record<string, string> = Object.fromEntries(
  FEATURE_MODEL_GROUPS.flatMap((g) => g.features.map((f) => [f.id, f.defaultModel]))
);

export function getFeatureDefaultModel(id: string): string | undefined {
  return FEATURE_DEFAULT_MODEL_BY_ID[id];
}
