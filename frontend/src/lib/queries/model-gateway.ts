// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import type { ErrorResponse, OkResponse } from "@/types/api";

export type GatewayMode = "official" | "custom" | "hybrid";
export type CustomLlmMode = "relayclaw_brainclaw" | "advanced";
export type AgentLlmMode = "inherit" | "third_party";

/** Generic "endpoint preview": the server only returns a key preview, never the full key. */
export interface GatewayEndpointPreview {
  baseUrl: string;
  apiKeyPreview: string;
  configured: boolean;
}

export interface OfficialGatewayConfig extends GatewayEndpointPreview {
  /** "database" | "env" etc., identifying the official config source. */
  source: string;
  /** The official default from .env (used as a fallback). */
  environment: GatewayEndpointPreview;
}

export interface CustomGatewayConfig extends GatewayEndpointPreview {
  llmMode: CustomLlmMode;
  adminBaseUrl: string;
  tokenName: string;
  tokenId: string;
}

export interface EffectiveGatewayConfig {
  /** "official" | "custom". */
  source: string;
  baseUrl: string;
  apiKeyPreview: string;
  configured: boolean;
}

export interface EffectiveLlmConfig extends EffectiveGatewayConfig {
  mode: string;
  model: string;
  brainclaw: boolean;
}

export interface AgentLlmConfig extends GatewayEndpointPreview {
  mode: AgentLlmMode;
  model: string;
}

export interface NewApiDatabaseStatus {
  configured: boolean;
  available?: boolean;
  source: string;
  databaseType?: "sqlite" | "external";
}

export interface SavedProviderChannelConfig {
  provider: string;
  type?: number;
  configured: boolean;
  upstreamKeyPreview: string;
  baseUrl: string;
  priority?: number;
  settings?: Record<string, unknown>;
}

export interface NewApiChannelType {
  type: number;
  provider: string;
  name: string;
  description: string;
  icon: string;
  defaultBaseUrl: string;
  status: number;
  capabilities: string[];
  requiresBaseUrl: boolean;
  supportsBaseUrlOverride: boolean;
}

export interface SavedMediaModelConfig {
  provider: string;
  upstreamModel: string;
  mediaType?: "image" | "video" | "audio";
  label?: string;
  enabled?: boolean;
  sortOrder?: number;
  config?: Record<string, unknown>;
}

export interface SavedEmbeddingModelConfig {
  provider: string;
  upstreamModel: string;
  dimension: number;
  batchSize?: number;
  sendDimensions?: boolean;
  internalModel?: string;
}

export interface ModelGatewayProvisionerConfig {
  enabled: boolean;
  adminBaseUrl: string;
  dbConfigured: boolean;
  adminUsername: string;
  relayTokenName: string;
  relayBaseUrl: string;
  providers: Record<string, { label: string; type: number; base_url: string }>;
  providerChannels?: SavedProviderChannelConfig[];
  mediaModels?: Record<string, SavedMediaModelConfig>;
  embeddingModel?: SavedEmbeddingModelConfig;
  database?: NewApiDatabaseStatus;
}

export interface MediaRelayConfig {
  source: string;
  provider: string;
  ttlSeconds: number;
  endpoint: string;
  bucket: string;
  accessKeyIdPreview: string;
  accessKeySecretPreview: string;
  cloudName?: string;
  cloudinaryApiKeyPreview?: string;
  cloudinaryApiSecretPreview?: string;
  apiFolder?: string;
  configured: boolean;
}

export interface ModelGatewayConfig {
  mode: GatewayMode;
  effective: EffectiveGatewayConfig;
  llmEffective: EffectiveLlmConfig;
  agent?: AgentLlmConfig;
  official: OfficialGatewayConfig;
  brainclaw?: GatewayEndpointPreview;
  custom: CustomGatewayConfig;
  provisioner?: ModelGatewayProvisionerConfig;
  mediaRelay?: MediaRelayConfig;
}

export interface OfficialMediaCatalogStatus {
  autoUpdate: boolean;
  source: "bundled" | "remote";
  schemaVersion: number;
  catalogVersion: string;
  modelCount: number;
  lastCheckedAt: string;
  sha256: string;
  revision: string;
  publishedAt: string;
  remoteUrl: string;
  lastError: string;
  updated?: boolean;
}

export interface SaveOfficialConfigInput {
  newApiApiKey: string;
}

export interface SaveBrainClawConfigInput {
  newApiBaseUrl: string;
  newApiApiKey?: string;
}

export interface SaveAgentLlmConfigInput {
  mode: AgentLlmMode;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export interface NewApiDatabaseConfigInput {
  sqlDsn?: string;
  sqlitePath?: string;
  adminUsername?: string;
}

export interface InitCustomNewApiInput {
  /** Optional; if omitted the backend uses the NEWAPI_BASE_URL env var. */
  newApiBaseUrl?: string;
  database?: NewApiDatabaseConfigInput;
  setupUsername?: string;
  setupPassword?: string;
  setupConfirmPassword?: string;
}

export interface NewApiSetupInitStatus {
  initialized: boolean;
  rootInitialized: boolean;
  databaseType: string;
  setupPerformed: boolean;
  alreadyInitialized: boolean;
}

export interface InitCustomNewApiResult {
  mode: "custom";
  newApiAdminBaseUrl: string;
  newApiBaseUrl: string;
  newApiSetup?: NewApiSetupInitStatus;
}

export interface FastApiErrorResponse {
  detail?: unknown;
  error?: unknown;
  message?: unknown;
  ok?: false;
}

/** One NewAPI channel: provider + upstream key + mapping from DC model names to upstream model names. */
export interface CustomChannelInput {
  provider: string;
  type?: number;
  /** Channel name, optional; generated automatically by the backend if omitted. */
  name?: string;
  upstreamKey: string;
  /** DC internal model name -> real upstream model name. */
  modelMapping: Record<string, string>;
  group: string;
  priority: number;
  weight: number;
  /** Optional; only filled in for a custom provider or when overriding the default address. */
  baseUrl: string;
  /** Optional; if omitted the backend uses the first key of modelMapping. */
  testModel: string;
  settings?: Record<string, unknown>;
}

export interface SaveProviderChannelsInput {
  preserveUnmentioned?: boolean;
  channels: Array<{
    provider: string;
    type?: number;
    upstreamKey?: string;
    baseUrl?: string;
    priority?: number;
    settings?: Record<string, unknown>;
  }>;
}

export interface SyncProviderChannelInput {
  newApiBaseUrl: string;
  database?: NewApiDatabaseConfigInput;
  provider: string;
  upstreamKey?: string;
  baseUrl?: string;
}

export interface ChannelModelsInput {
  newApiBaseUrl: string;
  database?: NewApiDatabaseConfigInput;
  provider: string;
}

export interface ChannelModelsResult {
  provider: string;
  channelId: number | string;
  models: string[];
}

export interface SaveMediaModelsInput {
  newApiBaseUrl: string;
  database?: NewApiDatabaseConfigInput;
  models: Record<string, SavedMediaModelConfig>;
}

export interface SaveEmbeddingModelInput {
  newApiBaseUrl: string;
  database?: NewApiDatabaseConfigInput;
  provider: string;
  upstreamModel: string;
  dimension: number;
  batchSize?: number;
}

export interface SaveMediaRelayConfigInput {
  provider: "aliyun_oss" | "cloudinary";
  ttlSeconds: number;
  endpoint?: string;
  bucket?: string;
  accessKeyId?: string;
  accessKeySecret?: string;
  cloudName?: string;
  apiKey?: string;
  apiSecret?: string;
  apiFolder?: string;
}

export interface SaveCustomChannelsBatchInput {
  newApiBaseUrl: string;
  database?: NewApiDatabaseConfigInput;
  channels: CustomChannelInput[];
}

export interface CustomChannelWriteResult {
  provider?: string;
  name?: string;
  ok?: boolean;
  channelId?: number | string;
  error?: string;
  /** Already masked by the backend, does not contain the full key. */
  upstreamKey?: string;
  [key: string]: unknown;
}

export interface SaveCustomChannelsBatchResult {
  succeeded: number;
  failed: number;
  results: CustomChannelWriteResult[];
}

export interface SyncProviderChannelResult {
  provider: string;
  channelId?: number | string;
  httpStatus?: number;
  savedChannel?: SavedProviderChannelConfig | null;
  sentPayload?: unknown;
  newApiResponse?: unknown;
}

export interface SaveMediaModelsResult extends SaveCustomChannelsBatchResult {
  models: Record<string, SavedMediaModelConfig>;
}

export interface SaveEmbeddingModelResult {
  embeddingModel: SavedEmbeddingModelConfig;
  result: CustomChannelWriteResult;
}

export function useModelGatewayConfig(enabled = true) {
  return useQuery({
    queryKey: queryKeys.modelGateway(),
    queryFn: ({ signal }) =>
      api
        .get("api/v1/model-gateway/config", { signal })
        .json<OkResponse<ModelGatewayConfig>>(),
    enabled,
  });
}

const officialMediaCatalogQueryKey = [
  ...queryKeys.modelGateway(),
  "official-media-catalog",
] as const;
const officialMediaCatalogStatusPollMs = 60_000;

function fetchOfficialMediaCatalogStatus(signal?: AbortSignal) {
  return api
    .get("api/v1/model-gateway/official/media-catalog", { signal })
    .json<OkResponse<OfficialMediaCatalogStatus>>();
}

export function useOfficialMediaCatalogStatus(enabled = true) {
  return useQuery({
    queryKey: officialMediaCatalogQueryKey,
    queryFn: ({ signal }) => fetchOfficialMediaCatalogStatus(signal),
    enabled,
  });
}

export function useOfficialMediaCatalogWatcher(enabled = true) {
  const previousSha256 = useRef<string | null>(null);
  const query = useQuery({
    queryKey: officialMediaCatalogQueryKey,
    queryFn: ({ signal }) => fetchOfficialMediaCatalogStatus(signal),
    enabled,
    refetchInterval: (current) =>
      current.state.data?.data.autoUpdate === false
        ? false
        : officialMediaCatalogStatusPollMs,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const sha256 = query.data?.data.sha256.trim() ?? "";

  useEffect(() => {
    if (!sha256) return;
    const previous = previousSha256.current;
    previousSha256.current = sha256;
    if (previous && previous !== sha256 && typeof window !== "undefined") {
      window.dispatchEvent(new Event("media-model-catalog-updated"));
    }
  }, [sha256]);

  return query;
}

export function useSaveOfficialMediaCatalogPreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (autoUpdate: boolean) =>
      api
        .post("api/v1/model-gateway/official/media-catalog/preferences", {
          json: { autoUpdate },
          throwHttpErrors: false,
        })
        .json<OkResponse<OfficialMediaCatalogStatus> | ErrorResponse>(),
    onSuccess: (response) => {
      if (response.ok) {
        qc.setQueryData(officialMediaCatalogQueryKey, response);
      } else {
        qc.invalidateQueries({ queryKey: officialMediaCatalogQueryKey });
      }
    },
  });
}

export function useCheckOfficialMediaCatalog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api
        .post("api/v1/model-gateway/official/media-catalog/check", {
          timeout: 20_000,
          throwHttpErrors: false,
        })
        .json<OkResponse<OfficialMediaCatalogStatus> | ErrorResponse>(),
    onSuccess: (response) => {
      if (response.ok) {
        qc.setQueryData(officialMediaCatalogQueryKey, response);
      } else {
        qc.invalidateQueries({ queryKey: officialMediaCatalogQueryKey });
      }
    },
  });
}

export function useNewApiChannelTypes(enabled = true) {
  return useQuery({
    queryKey: [...queryKeys.modelGateway(), "channel-types"],
    queryFn: ({ signal }) =>
      api
        .get("api/v1/model-gateway/custom/newapi/channel-types", {
          signal,
          throwHttpErrors: false,
        })
        .json<OkResponse<{ items: NewApiChannelType[] }> | ErrorResponse>(),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useSaveOfficialConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveOfficialConfigInput) =>
      api
        .post("api/v1/model-gateway/official/config", { json: input })
        .json<OkResponse<ModelGatewayConfig> | ErrorResponse>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.modelGateway() });
    },
  });
}

export function useSaveAgentLlmConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveAgentLlmConfigInput) =>
      api
        .post("api/v1/model-gateway/agent/config", {
          json: input,
          throwHttpErrors: false,
        })
        .json<OkResponse<ModelGatewayConfig> | ErrorResponse>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.modelGateway() });
    },
  });
}

export function useEnableOfficial() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api
        .post("api/v1/model-gateway/official/enable")
        .json<OkResponse<ModelGatewayConfig> | ErrorResponse>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.modelGateway() });
    },
  });
}

export function useEnableCustom() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api
        .post("api/v1/model-gateway/custom/enable", { throwHttpErrors: false })
        .json<OkResponse<ModelGatewayConfig> | ErrorResponse>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.modelGateway() });
    },
  });
}

export function useSaveBrainClawConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveBrainClawConfigInput) =>
      api
        .post("api/v1/model-gateway/custom/brainclaw/config", { json: input })
        .json<OkResponse<ModelGatewayConfig> | ErrorResponse>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.modelGateway() });
    },
  });
}

export function useEnableHybrid() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api
        .post("api/v1/model-gateway/hybrid/enable", { throwHttpErrors: false })
        .json<OkResponse<ModelGatewayConfig> | ErrorResponse>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.modelGateway() });
    },
  });
}

export function useEnableBrainClaw() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api
        .post("api/v1/model-gateway/custom/brainclaw/enable")
        .json<OkResponse<ModelGatewayConfig> | ErrorResponse>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.modelGateway() });
    },
  });
}

export function useSetCustomLlmMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mode: CustomLlmMode) =>
      api
        .post("api/v1/model-gateway/custom/llm-mode", { json: { mode } })
        .json<OkResponse<ModelGatewayConfig> | ErrorResponse>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.modelGateway() });
    },
  });
}

export function useInitCustomNewApi() {
  const qc = useQueryClient();
  return useMutation({
    // Initialization connects to NewAPI, creates a token and writes to the DB, which takes long, so the timeout is relaxed.
    mutationFn: (input: InitCustomNewApiInput) =>
      api
        .post("api/v1/model-gateway/custom/newapi/init", {
          json: input,
          timeout: 60_000,
          throwHttpErrors: false,
        })
        .json<OkResponse<InitCustomNewApiResult> | ErrorResponse | FastApiErrorResponse>(),
    onSuccess: (data) => {
      if (data.ok === true) {
        qc.invalidateQueries({ queryKey: queryKeys.modelGateway() });
      }
    },
  });
}


/** Saves the provider channel-level config. */
export function useSaveProviderChannels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveProviderChannelsInput) =>
      api
        .post("api/v1/model-gateway/custom/newapi/provider-channels", {
          json: input,
          timeout: 60_000,
          throwHttpErrors: false,
        })
        .json<
          | OkResponse<{
              channels: SavedProviderChannelConfig[];
              mediaModels: Record<string, SavedMediaModelConfig>;
              embeddingModel: SavedEmbeddingModelConfig | null;
            }>
          | ErrorResponse
          | FastApiErrorResponse
        >(),
    onSuccess: async (response) => {
      if (response.ok === true) {
        await qc.resetQueries({ queryKey: CHANNEL_MODELS_QUERY_KEY });
        await qc.cancelQueries({ queryKey: queryKeys.modelGateway() });
        qc.setQueryData<OkResponse<ModelGatewayConfig>>(
          queryKeys.modelGateway(),
          (current) =>
            current
              ? {
                  ...current,
                  data: {
                    ...current.data,
                    provisioner: current.data.provisioner
                      ? {
                          ...current.data.provisioner,
                          providerChannels: response.data.channels,
                          mediaModels: response.data.mediaModels,
                          embeddingModel:
                            response.data.embeddingModel ?? undefined,
                        }
                      : current.data.provisioner,
                  },
                }
              : current,
        );
      }
      if (response.ok !== true) {
        qc.invalidateQueries({ queryKey: queryKeys.modelGateway() });
      }
    },
  });
}

/** Deletes the ComfyUI channel and media model mappings in CE local and NewAPI. */
export function useClearComfyUIConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api
        .delete("api/v1/model-gateway/custom/newapi/comfyui", {
          timeout: 60_000,
          throwHttpErrors: false,
        })
        .json<OkResponse<unknown> | ErrorResponse | FastApiErrorResponse>(),
    onSuccess: (response) => {
      if (response.ok !== true) return;
      qc.invalidateQueries({ queryKey: queryKeys.modelGateway() });
      window.dispatchEvent(new Event("media-model-catalog-updated"));
    },
  });
}

const CHANNEL_MODELS_QUERY_KEY = ["newapi-channel-models"] as const;

/** Fetch explicitly; all model inputs for this gateway/provider share the list. */
export function useChannelModels(input: ChannelModelsInput) {
  return useQuery({
    queryKey: [
      ...CHANNEL_MODELS_QUERY_KEY,
      input.newApiBaseUrl.trim().replace(/\/v1\/?$/, ""),
      input.provider,
    ],
    queryFn: ({ signal }) =>
      api
        .post("api/v1/model-gateway/custom/newapi/provider-channel/models", {
          json: input,
          signal,
          timeout: 60_000,
          retry: 0,
        })
        .json<OkResponse<ChannelModelsResult>>(),
    enabled: false,
    retry: false,
    staleTime: Infinity,
  });
}

/** Creates the provider channel on first use; later calls update the key / Base URL and keep model mappings. */
export function useSyncProviderChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SyncProviderChannelInput) =>
      api
        .post("api/v1/model-gateway/custom/newapi/provider-channel/sync", {
          json: input,
          timeout: 60_000,
          throwHttpErrors: false,
        })
        .json<OkResponse<SyncProviderChannelResult> | ErrorResponse | FastApiErrorResponse>(),
    onSuccess: async (data) => {
      if (data.ok === true) {
        await qc.resetQueries({ queryKey: CHANNEL_MODELS_QUERY_KEY });
        qc.invalidateQueries({ queryKey: queryKeys.modelGateway() });
      }
    },
  });
}

/** Writes a single NewAPI channel. */
export function useSaveCustomChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CustomChannelInput & { newApiBaseUrl: string; database?: NewApiDatabaseConfigInput }) =>
      api
        .post("api/v1/model-gateway/custom/newapi/channels", {
          json: input,
          timeout: 60_000,
        })
        .json<OkResponse<CustomChannelWriteResult> | ErrorResponse>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.modelGateway() });
    },
  });
}

/** Saves the fixed image / video model mappings. */
export function useSaveMediaModels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveMediaModelsInput) =>
      api
        .post("api/v1/model-gateway/custom/newapi/media-models", {
          json: input,
          timeout: 120_000,
        })
        .json<OkResponse<SaveMediaModelsResult> | ErrorResponse>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.modelGateway() });
    },
  });
}

/** Saves the Cognee embedding model mapping; the dimension is only stored in the CE local config. */
export function useSaveEmbeddingModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveEmbeddingModelInput) =>
      api
        .post("api/v1/model-gateway/custom/newapi/embedding-model", {
          json: input,
          timeout: 120_000,
        })
        .json<OkResponse<SaveEmbeddingModelResult> | ErrorResponse>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.modelGateway() });
    },
  });
}

/** Saves the NewAPI reference-media relay config. */
export function useSaveMediaRelayConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveMediaRelayConfigInput) =>
      api
        .post("api/v1/model-gateway/media-relay/config", {
          json: input,
          timeout: 60_000,
        })
        .json<OkResponse<MediaRelayConfig> | ErrorResponse>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.modelGateway() });
    },
  });
}

/** Writes NewAPI channels in batch (saving the feature-model mapping). The backend supports partial success. */
export function useSaveCustomChannelsBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveCustomChannelsBatchInput) =>
      api
        .post("api/v1/model-gateway/custom/newapi/channels/batch", {
          json: input,
          timeout: 120_000,
        })
        .json<OkResponse<SaveCustomChannelsBatchResult> | ErrorResponse>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.modelGateway() });
    },
  });
}
