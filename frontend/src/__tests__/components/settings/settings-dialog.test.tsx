// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import ky from "ky";

import { SettingsDialog } from "@/components/settings/settings-dialog";
import { enT, viT } from "@/__tests__/helpers/i18n-fixtures";

const runtimeState = vi.hoisted(() => ({ isCeRuntime: true }));
const localeState = vi.hoisted(() => ({ language: "en" }));
const modelGatewayMocks = vi.hoisted(() => ({
  config: undefined as Record<string, unknown> | undefined,
  saveAgent: vi.fn(),
  saveBrainClaw: vi.fn(),
  saveMediaRelay: vi.fn(),
  setCustomLlmMode: vi.fn(),
}));
const freezoneAgentConfigMocks = vi.hoisted(() => ({
  delete: vi.fn(),
  exportBundle: vi.fn(),
  installBundle: vi.fn(),
  items: [] as Array<Record<string, unknown>>,
  itemsByKind: {} as Record<string, Array<Record<string, unknown>>>,
  refetch: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@/lib/runtime-config", () => ({
  isCeRuntime: () => runtimeState.isCeRuntime,
  runpodWorkerControlEnabled: () => false,
}));

vi.mock("@/lib/queries/freezone-agent-config", () => ({
  useFreezoneAgentConfigItems: (kind: string) => {
    const scopedItems = freezoneAgentConfigMocks.itemsByKind[kind];
    return {
      data: scopedItems ?? freezoneAgentConfigMocks.items,
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: freezoneAgentConfigMocks.refetch,
    };
  },
  useSaveFreezoneAgentConfigItem: () => ({
    mutateAsync: freezoneAgentConfigMocks.save,
    isPending: false,
  }),
  useDeleteFreezoneAgentConfigItem: () => ({
    mutateAsync: freezoneAgentConfigMocks.delete,
    isPending: false,
  }),
  useInstallFreezoneAgentBundle: () => ({
    mutateAsync: freezoneAgentConfigMocks.installBundle,
    isPending: false,
  }),
  useExportFreezoneAgentBundle: () => ({
    mutateAsync: freezoneAgentConfigMocks.exportBundle,
    isPending: false,
  }),
}));

vi.mock("@/lib/queries/model-gateway", () => ({
  useModelGatewayConfig: () => ({
    data: modelGatewayMocks.config ? { data: modelGatewayMocks.config } : undefined,
    isLoading: false,
  }),
  useOfficialMediaCatalogStatus: () => ({ data: undefined, isLoading: false }),
  useSaveOfficialMediaCatalogPreferences: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useCheckOfficialMediaCatalog: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useNewApiChannelTypes: () => ({ data: undefined, isLoading: false }),
  useEnableOfficial: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useEnableCustom: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useEnableHybrid: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useEnableBrainClaw: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveOfficialConfig: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveAgentLlmConfig: () => ({
    mutateAsync: modelGatewayMocks.saveAgent,
    isPending: false,
  }),
  useSaveBrainClawConfig: () => ({
    mutateAsync: modelGatewayMocks.saveBrainClaw,
    isPending: false,
  }),
  useSetCustomLlmMode: () => ({
    mutateAsync: modelGatewayMocks.setCustomLlmMode,
    isPending: false,
  }),
  useInitCustomNewApi: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveCustomChannel: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveCustomChannelsBatch: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveEmbeddingModel: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveMediaModels: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveProviderChannels: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveMediaRelayConfig: () => ({
    mutateAsync: modelGatewayMocks.saveMediaRelay,
    isPending: false,
  }),
  useSyncProviderChannel: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useChannelModels: () => ({
    data: undefined,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("react-i18next", async () => {
  const { enT, viT } = await import("@/__tests__/helpers/i18n-fixtures");
  return {
  useTranslation: () => ({
    t: (
      key: string,
      options?: {
        defaultValue?: string;
        count?: number;
        exclusiveCount?: number;
        id?: string;
        page?: string;
        selectedCount?: number;
        sharedCount?: number;
        tag?: string;
        missing?: number;
      },
    ) =>
      key.startsWith("settings.mediaStorage.errors.")
        ? (localeState.language === "vi" ? viT : enT)(key, options)
        : ({
        "settings.title": "Settings",
        "settings.close": "Close",
        "settings.navigationLabel": "Settings categories",
        "settings.pages.models": "Model Config",
        "settings.pages.storage": "Media Storage",
        "settings.pages.freezoneSkills": "Freezone Skills",
        "settings.pages.freezoneRecipes": "Freezone Recipes",
        "settings.statusConfigured": `${options?.page ?? ""} is configured`,
        "settings.statusNotConfigured": `${options?.page ?? ""} is not configured`,
        "settings.modelConfig.title": "Model Config",
        "settings.modelConfig.description": "Choose a model gateway channel",
        "settings.modelConfig.gatewayWarningIconLabel": "Model gateway is not configured",
        "settings.modelConfig.gatewayNotConfiguredImpact": "Model gateway is not configured",
        "settings.modelConfig.modes.official": "Official channel",
        "settings.modelConfig.modes.custom": "Custom NewAPI",
        "settings.modelConfig.official.description": "Official channel description",
        "settings.modelConfig.official.registerLink": "Register",
        "settings.modelConfig.official.save": "Save & Enable",
        "settings.modelConfig.brainclaw.tab": "RelayClaw BrainClaw (Recommended)",
        "settings.modelConfig.brainclaw.advancedTab": "Advanced Custom",
        "settings.modelConfig.brainclaw.title": "BrainClaw by RelayClaw (Recommended)",
        "settings.modelConfig.brainclaw.description": "Xia Brain is only available through Xia Relay",
        "settings.modelConfig.brainclaw.model": "Fixed model",
        "settings.modelConfig.brainclaw.save": "Save and enable BrainClaw",
        "settings.modelConfig.agent.title": "Agent model",
        "settings.modelConfig.agent.description": "Agent model description",
        "settings.modelConfig.agent.inherit": "Follow current channel",
        "settings.modelConfig.agent.thirdParty": "Third-party",
        "settings.modelConfig.agent.model": "Model name",
        "settings.modelConfig.agent.thirdPartyHint": "Must be compatible with the Responses API",
        "settings.modelConfig.agent.save": "Save Agent config",
        "settings.modelConfig.agent.saved": "Agent model config saved",
        "settings.modelConfig.featureModels.title": "Business Model Mapping",
        "settings.modelConfig.embeddingModel.title": "Embedding model",
        "settings.modelConfig.mediaModels.title": "Media models",
        "settings.modelConfig.fields.gatewayBaseUrl": "Gateway URL",
        "settings.modelConfig.fields.apiKey": "API Key",
        "settings.mediaStorage.title": "Image Host / Media Storage",
        "settings.mediaStorage.description": "Media storage description",
        "settings.freezoneCatalog.skills.description": "Manage skills the Agent can use directly.",
        "settings.freezoneCatalog.recipes.description": "Maintain the underlying Recipes that Skills can call, usually for debugging or built-in capability management.",
        "settings.freezoneCatalog.searchSkills": "Search Skill",
        "settings.freezoneCatalog.searchRecipes": "Search Recipes",
        "settings.freezoneCatalog.emptySkills": "No Freezone Skills yet",
        "settings.freezoneCatalog.emptyRecipes": "No Freezone Recipes yet",
        "settings.freezoneCatalog.emptyDescription": "No config items yet.",
        "settings.freezoneCatalog.loading": "Loading…",
        "settings.freezoneCatalog.retry": "Retry",
        "settings.freezoneCatalog.saved": "Freezone config saved",
        "settings.freezoneCatalog.saveFailed": "Save failed. Check the config content.",
        "settings.freezoneCatalog.deleted": "Freezone config deleted",
        "settings.freezoneCatalog.deleteFailed": "Delete failed. Please retry.",
        "settings.freezoneCatalog.deleteSelected": "Delete selected",
        "settings.freezoneCatalog.deleteSkillDialog.title": "Delete Skill",
        "settings.freezoneCatalog.deleteSkillDialog.description": `Delete "${options?.id ?? ""}"?`,
        "settings.freezoneCatalog.deleteSkillDialog.recipeHint": `This Skill uses ${options?.count ?? 0} modules: ${options?.exclusiveCount ?? 0} used only here, ${options?.sharedCount ?? 0} also used by other Skills.`,
        "settings.freezoneCatalog.deleteSkillDialog.exclusiveRecipes": "Can be deleted with this Skill",
        "settings.freezoneCatalog.deleteSkillDialog.sharedRecipes": "Shared modules will be kept",
        "settings.freezoneCatalog.deleteSkillDialog.cancel": "Cancel",
        "settings.freezoneCatalog.deleteSkillDialog.deleteSkillOnly": "Delete Skill only",
        "settings.freezoneCatalog.deleteSkillDialog.deleteWithRecipes": "Delete Skill and exclusive modules",
        "settings.freezoneCatalog.exported": "Freezone config exported",
        "settings.freezoneCatalog.imported": "Freezone config imported",
        "settings.freezoneCatalog.importFailed": "Import failed. Choose a valid JSON file.",
        "settings.freezoneCatalog.toggleEnabled": `Toggle ${options?.id ?? ""} enabled state`,
        "settings.freezoneCatalog.editItem": `Edit ${options?.id ?? ""}`,
        "settings.freezoneCatalog.tags.edit": `Edit ${options?.tag ?? ""}`,
        "settings.freezoneCatalog.tags.remove": `Delete ${options?.tag ?? ""}`,
        "settings.freezoneCatalog.nodeScopes.textGeneration": "Text generation",
        "settings.freezoneCatalog.nodeScopes.imageGeneration": "Image generation",
        "settings.freezoneCatalog.nodeScopes.videoGeneration": "Video generation",
        "settings.freezoneCatalog.nodeScopes.audioGeneration": "Audio generation",
        "settings.freezoneCatalog.recipeLinks.addRecipe": "Add Recipe",
        "settings.freezoneCatalog.recipeLinks.recipeIdPlaceholder": "Enter Recipe ID",
        "settings.freezoneCatalog.recipeLinks.add": "Add",
        "settings.freezoneCatalog.recipeLinks.searchRecipe": "Search Recipes",
        "settings.freezoneCatalog.recipeLinks.manualAddId": "Add by ID",
        "settings.freezoneCatalog.recipeLinks.none": "This Skill has no linked Recipe yet",
        "settings.freezoneCatalog.mine": "Mine",
        "settings.freezoneCatalog.deleteItem": `Delete ${options?.id ?? ""}`,
        "settings.freezoneCatalog.refresh": "Refresh",
        "settings.freezoneCatalog.advancedManagement": "Advanced",
        "settings.freezoneCatalog.backToSkills": "Back to Skills",
        "settings.freezoneCatalog.import": "Import",
        "settings.freezoneCatalog.importBundle": "Import Skill",
        "settings.freezoneCatalog.export": "Export",
        "settings.freezoneCatalog.exportBundle": "Export Skill",
        "settings.freezoneCatalog.community.filters.all": "All",
        "settings.freezoneCatalog.new": "New",
        "settings.freezoneCatalog.selectAll": "Select all",
        "settings.freezoneCatalog.backToTop": "Top",
        "settings.freezoneCatalog.readOnly": "Read-only",
        "settings.freezoneCatalog.builtIn": "Built-in",
        "settings.freezoneCatalog.customized": "Customized",
        "settings.freezoneCatalog.customizedShort": "Custom",
        "settings.freezoneCatalog.skillsCount": `${options?.count ?? 0} item(s)`,
        "settings.freezoneCatalog.recipesCount": `${options?.count ?? 0} item(s)`,
        "settings.freezoneCatalog.selectionCount": `${options?.selectedCount ?? 0} / ${options?.count ?? 0} selected`,
        "settings.freezoneCatalog.recipesPendingTitle": "Recipe settings entry reserved",
        "settings.freezoneCatalog.recipesPendingDescription": "Once the backend Recipe catalog is connected, Freezone Recipes will be shown and edited here.",
        "settings.freezoneCatalog.newSkill.title": "New Skill",
        "settings.freezoneCatalog.newSkill.editTitle": "Edit Skill",
        "settings.freezoneCatalog.newSkill.close": "Close new Skill",
        "settings.freezoneCatalog.newSkill.cancel": "Cancel",
        "settings.freezoneCatalog.newSkill.save": "Save",
        "settings.freezoneCatalog.newSkill.id": "ID",
        "settings.freezoneCatalog.newSkill.idHint": "Only a-z, 0-9, -, and _ are allowed",
        "settings.freezoneCatalog.newSkill.name": "Name",
        "settings.freezoneCatalog.newSkill.namePlaceholder": "e.g. brand video Skill",
        "settings.freezoneCatalog.newSkill.category": "Category",
        "settings.freezoneCatalog.newSkill.description": "Use Case",
        "settings.freezoneCatalog.newSkill.descriptionPlaceholder": "Describe the use case",
        "settings.freezoneCatalog.newSkill.triggerTitle": "Trigger Conditions",
        "settings.freezoneCatalog.newSkill.triggerDescription": "Define which keywords or node types activate this Skill",
        "settings.freezoneCatalog.newSkill.keywords": "Trigger keywords",
        "settings.freezoneCatalog.newSkill.keywordsPlaceholder": "Enter keywords",
        "settings.freezoneCatalog.newSkill.keywordsHint": "Weights supported",
        "settings.freezoneCatalog.newSkill.nodeScopes": "Node scopes",
        "settings.freezoneCatalog.newSkill.nodeScopesPlaceholder": "textGeneration / imageGeneration / videoGeneration / audioGeneration",
        "settings.freezoneCatalog.newSkill.workflow2Title": "Workflow Settings",
        "settings.freezoneCatalog.newSkill.workflow2Description": "Workflow fields",
        "settings.freezoneCatalog.newSkill.schemaVersion": "Schema version",
        "settings.freezoneCatalog.newSkill.version": "Release",
        "settings.freezoneCatalog.newSkill.allowedRecipeIds": "Linked Recipes",
        "settings.freezoneCatalog.newSkill.allowedRecipeIdsPlaceholder": "Enter Recipe ID",
        "settings.freezoneCatalog.newSkill.allowedRecipeIdsHint": "Used in dynamic planning",
        "settings.freezoneCatalog.newSkill.inputParameters": "Start options",
        "settings.freezoneCatalog.newSkill.inputParametersEmpty": "No options",
        "settings.freezoneCatalog.newSkill.inputParameterRequired": "Required",
        "settings.freezoneCatalog.newSkill.inputParameterDefault": "Default",
        "settings.freezoneCatalog.newSkill.inputParameterOptions": `${options?.count ?? 0} option(s)`,
        "settings.freezoneCatalog.newSkill.inputParameterOptionList": "Options",
        "settings.freezoneCatalog.newSkill.addInputParameter": "Add option",
        "settings.freezoneCatalog.newSkill.deleteInputParameter": "Delete option",
        "settings.freezoneCatalog.newSkill.inputParameterId": "Parameter ID",
        "settings.freezoneCatalog.newSkill.inputParameterIdPlaceholder": "e.g. total_duration",
        "settings.freezoneCatalog.newSkill.inputParameterLabel": "Display name",
        "settings.freezoneCatalog.newSkill.inputParameterLabelPlaceholder": "e.g. Duration",
        "settings.freezoneCatalog.newSkill.inputParameterType": "Type",
        "settings.freezoneCatalog.newSkill.inputParameterDefaultPlaceholder": "e.g. 15s",
        "settings.freezoneCatalog.newSkill.inputParameterOptionsPlaceholder": "One option per line",
        "settings.freezoneCatalog.newSkill.inputParameterTypes.single_select": "Single select",
        "settings.freezoneCatalog.newSkill.inputParameterTypes.multi_select": "Multi-select",
        "settings.freezoneCatalog.newSkill.inputParameterTypes.text": "Text",
        "settings.freezoneCatalog.newSkill.inputParameterTypes.number": "Number",
        "settings.freezoneCatalog.newSkill.inputParameterTypes.boolean": "Toggle",
        "settings.freezoneCatalog.newSkill.inputParametersPlaceholder": "[]",
        "settings.freezoneCatalog.newSkill.planningTitle": "Rule Config",
        "settings.freezoneCatalog.newSkill.planningDescription": "Rule policy",
        "settings.freezoneCatalog.newSkill.planningNotes": "Planner guidance",
        "settings.freezoneCatalog.newSkill.planningNotesPlaceholder": "Planning hint...",
        "settings.freezoneCatalog.newSkill.promptGuide": "Prompt style",
        "settings.freezoneCatalog.newSkill.promptGuidePlaceholder": "Style guide...",
        "settings.freezoneCatalog.newSkill.conductRules": "Behavior rules",
        "settings.freezoneCatalog.newSkill.conductRulesPlaceholder": "Behavior rules...",
        "settings.freezoneCatalog.newSkill.aspectPresets": "Default aspect ratios",
        "settings.freezoneCatalog.newSkill.modelNamePlaceholder": "Task type",
        "settings.freezoneCatalog.newSkill.ratioPlaceholder": "Aspect ratio",
        "settings.freezoneCatalog.newSkill.ratioLabel": "Aspect ratio",
        "settings.freezoneCatalog.newSkill.ratioSelectPlaceholder": "Select ratio",
        "settings.freezoneCatalog.newSkill.modelHints": "Model preference",
        "settings.freezoneCatalog.newSkill.taskTypeLabel": "Task type",
        "settings.freezoneCatalog.newSkill.taskTypePlaceholder": "Select type",
        "settings.freezoneCatalog.newSkill.modelSelectLabel": "Model name",
        "settings.freezoneCatalog.newSkill.modelSelectPlaceholder": "Select model",
        "settings.freezoneCatalog.newSkill.modelLoading": "Loading models…",
        "settings.freezoneCatalog.newSkill.evaluationTitle": "Evaluation Rules",
        "settings.freezoneCatalog.newSkill.evaluationDescription": "Scoring criteria",
        "settings.freezoneCatalog.newSkill.qualityThreshold": "Passing score",
        "settings.freezoneCatalog.newSkill.qualityThresholdPlaceholder": "e.g. 7",
        "settings.freezoneCatalog.newSkill.domainConstraints": "Domain rules",
        "settings.freezoneCatalog.newSkill.domainConstraintsPlaceholder": "Enter rules",
        "settings.freezoneCatalog.newSkill.ratingBands": "Rating bands",
        "settings.freezoneCatalog.newSkill.visualReviewItems": "Visual review dimensions",
        "settings.freezoneCatalog.newSkill.textReviewItems": "Text review dimensions",
        "settings.freezoneCatalog.newSkill.add": "Add",
        "settings.freezoneCatalog.newSkill.addRatingBand": "Add anchor",
        "settings.freezoneCatalog.newSkill.addDimension": "Add dimension",
        "settings.freezoneCatalog.newSkill.dimensionNamePlaceholder": "Dimension name",
        "settings.freezoneCatalog.newSkill.dimensionDescriptionPlaceholder": "Dimension description",
        "settings.freezoneCatalog.newSkill.dimensionWeight": "Weight",
        "settings.freezoneCatalog.newSkill.dimensionWeightPlaceholder": "1",
        "settings.freezoneCatalog.newSkill.dimensionWeightHint": "Total weight is recommended to be 1.0",
        "settings.freezoneCatalog.newSkill.removeDimension": "Remove evaluation dimension",
        "settings.freezoneCatalog.newSkill.ratingBandScorePlaceholder": "0",
        "settings.freezoneCatalog.newSkill.ratingBandDescriptionPlaceholder": "Description for this score band",
        "settings.freezoneCatalog.newSkill.removeRatingBand": "Remove rating band",
        "settings.freezoneCatalog.newSkill.rawJson": "View / edit raw JSON (advanced)",
        "settings.freezoneCatalog.newSkill.collapseRawJson": "Collapse raw JSON",
        "settings.freezoneCatalog.newSkill.rawJsonAria": "Raw JSON",
        "settings.freezoneCatalog.newSkill.rawJsonSyncHint": "Editing the JSON directly syncs to the form fields above",
        "settings.freezoneCatalog.newSkill.copyRawJson": "Copy JSON",
        "settings.freezoneCatalog.newSkill.rawJsonCopied": "Skill JSON copied",
        "settings.freezoneCatalog.newSkill.rawJsonCopyFailed": "Copy failed; copy manually",
        "settings.freezoneCatalog.newRecipe.title": "New Recipe",
        "settings.freezoneCatalog.newRecipe.close": "Close new Recipe",
        "settings.freezoneCatalog.newRecipe.cancel": "Cancel",
        "settings.freezoneCatalog.newRecipe.save": "Save",
        "settings.freezoneCatalog.newRecipe.id": "ID",
        "settings.freezoneCatalog.newRecipe.idHint": "Only a-z, 0-9, -, and _ are allowed",
        "settings.freezoneCatalog.newRecipe.name": "Name",
        "settings.freezoneCatalog.newRecipe.namePlaceholder": "e.g. ecommerce ad enhancement",
        "settings.freezoneCatalog.newRecipe.outputKind": "Output type",
        "settings.freezoneCatalog.newRecipe.outputKinds.image": "Image",
        "settings.freezoneCatalog.newRecipe.outputKinds.video": "Video",
        "settings.freezoneCatalog.newRecipe.outputKinds.audio": "Audio",
        "settings.freezoneCatalog.newRecipe.outputKinds.text": "Text",
        "settings.freezoneCatalog.newRecipe.actionKeys": "Operation keys",
        "settings.freezoneCatalog.newRecipe.actionKeysPlaceholder": "Press Enter or comma to confirm",
        "settings.freezoneCatalog.newRecipe.actionKeysHint": "Operation type identifiers used by Agent planning to match this Recipe",
        "settings.freezoneCatalog.newRecipe.system_prompt": "System Prompt",
        "settings.freezoneCatalog.newRecipe.system_promptPlaceholder": "System instruction used to enhance generation prompts...",
        "settings.freezoneCatalog.newRecipe.mustHaveItems": "Required elements",
        "settings.freezoneCatalog.newRecipe.mustHaveItemsPlaceholder": "Press Enter or comma to confirm",
        "settings.freezoneCatalog.newRecipe.mustHaveItemsHint": "Key elements the generated output must include",
        "settings.freezoneCatalog.newRecipe.planningPrompt": "Planner guidance",
        "settings.freezoneCatalog.newRecipe.planningPromptPlaceholder": "Short hint for the planner (~30 chars)",
        "settings.freezoneCatalog.newRecipe.resultSummary": "Output summary",
        "settings.freezoneCatalog.newRecipe.resultSummaryPlaceholder": "Output feature description (~50 chars)",
        "settings.freezoneCatalog.newRecipe.sourceMediaRequired": "Needs upstream media",
        "settings.freezoneCatalog.newRecipe.sourceMediaRequiredHint": "When enabled, this Recipe requires image/video or similar input",
        "settings.freezoneCatalog.newRecipe.forceEnhancement": "Skip detail check",
        "settings.freezoneCatalog.newRecipe.forceEnhancementHint": "Force the enhancement flow and ignore the “already detailed enough” check",
        "settings.freezoneCatalog.newRecipe.rawJson": "View / edit raw JSON (advanced)",
        "settings.freezoneCatalog.newRecipe.collapseRawJson": "Collapse raw JSON",
        "settings.freezoneCatalog.newRecipe.rawJsonAria": "Recipe raw JSON",
        "settings.freezoneCatalog.newRecipe.rawJsonSyncHint": "The JSON is generated from the form fields above",
        "settings.freezoneCatalog.newRecipe.copyRawJson": "Copy JSON",
        "settings.freezoneCatalog.newRecipe.rawJsonCopied": "Recipe JSON copied",
        "settings.freezoneCatalog.newRecipe.rawJsonCopyFailed": "Copy failed; copy manually",
      })[key] ?? (() => {
        try {
          return enT(key, options);
        } catch {
          return options?.defaultValue ?? key;
        }
      })(),
  }),
  };
});

function renderSettingsDialog() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <SettingsDialog open onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  );
}

function openRecipesManagement() {
  fireEvent.click(screen.getByRole("button", { name: "Freezone Skills" }));
  fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
}

beforeEach(() => {
  runtimeState.isCeRuntime = true;
  localeState.language = "en";
  modelGatewayMocks.config = undefined;
  modelGatewayMocks.saveAgent.mockReset();
  modelGatewayMocks.saveBrainClaw.mockReset();
  modelGatewayMocks.saveMediaRelay.mockReset();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
  modelGatewayMocks.setCustomLlmMode.mockReset();
  modelGatewayMocks.setCustomLlmMode.mockResolvedValue({ ok: true });
  freezoneAgentConfigMocks.delete.mockReset();
  freezoneAgentConfigMocks.exportBundle.mockReset();
  freezoneAgentConfigMocks.installBundle.mockReset();
  freezoneAgentConfigMocks.items = [];
  freezoneAgentConfigMocks.itemsByKind = {};
  freezoneAgentConfigMocks.refetch.mockReset();
  freezoneAgentConfigMocks.save.mockReset();
  freezoneAgentConfigMocks.exportBundle.mockImplementation(
    async ({ bundle }: { bundle: Record<string, unknown> }) => bundle,
  );
  freezoneAgentConfigMocks.installBundle.mockResolvedValue({
    bundle_id: "test-bundle",
    installed_skill: "test-skill",
    installed_recipes: [],
  });
});

describe("SettingsDialog pages", () => {
  it.each([
    {
      language: "en",
      expected: "MEDIA_STORAGE_ACCESS_DENIED: Media storage access denied. Check your credentials and upload/read permissions.",
    },
    {
      language: "vi",
      expected: `MEDIA_STORAGE_ACCESS_DENIED: ${viT("settings.mediaStorage.errors.MEDIA_STORAGE_ACCESS_DENIED")}`,
    },
  ])("shows the $language storage error after Ky consumes the HTTP response", async ({ language, expected }) => {
    localeState.language = language;
    const detail = "MEDIA_STORAGE_ACCESS_DENIED: Media storage access denied (backend text)";
    let requestError: unknown;
    try {
      await ky
        .post("https://storage.example.test/config", {
          retry: 0,
          fetch: async () =>
            new Response(JSON.stringify({ detail }), {
              status: 400,
              headers: { "content-type": "application/json" },
            }),
        })
        .json();
    } catch (error) {
      requestError = error;
    }
    expect(requestError).toMatchObject({
      data: { detail },
      response: { bodyUsed: true },
    });
    modelGatewayMocks.saveMediaRelay.mockRejectedValue(requestError);

    renderSettingsDialog();
    fireEvent.click(screen.getByRole("button", { name: /Media Storage/ }));
    fireEvent.click(
      screen.getByRole("tab", {
        name: enT("settings.mediaStorage.providerAliyunOss"),
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: enT("settings.mediaStorage.save") }),
    );

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expected));
    expect(modelGatewayMocks.saveMediaRelay).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "aliyun_oss" }),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it.each([
    ["MEDIA_STORAGE_TIMEOUT", "Media storage connection timed out. Check your network and try again."],
    ["MEDIA_STORAGE_AUTH_INVALID", "Media storage credentials are invalid. Check your AccessKey / API Key."],
    ["MEDIA_STORAGE_ACCESS_DENIED", "Media storage access denied. Check your credentials and upload/read permissions."],
    ["MEDIA_STORAGE_TARGET_INVALID", "Media storage destination is unavailable. Check the bucket, endpoint, or folder."],
    ["MEDIA_STORAGE_CONFIG_INVALID", "Media storage configuration is incomplete or the upload failed. Check the selected storage settings."],
    ["MEDIA_STORAGE_UNAVAILABLE", "Media storage read/write verification failed. Check your connection and settings, then try again."],
    ["MEDIA_STORAGE_READ_MISMATCH", "Media storage read verification failed. Check the storage access settings."],
  ])("translates %s in failed save responses", async (code, message) => {
    localeState.language = "en";
    modelGatewayMocks.saveMediaRelay.mockResolvedValue({
      ok: false,
      error: `${code}: backend raw error text`,
    });
    renderSettingsDialog();
    fireEvent.click(screen.getByRole("button", { name: /Media Storage/ }));
    fireEvent.click(
      screen.getByRole("tab", {
        name: enT("settings.mediaStorage.providerAliyunOss"),
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: enT("settings.mediaStorage.save") }),
    );

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(`${code}: ${message}`));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "parsed text payload",
      error: () => ({ data: "  Storage unavailable  " }),
      expected: "Storage unavailable",
    },
    {
      name: "unknown storage error code",
      error: () => ({ data: { detail: "MEDIA_STORAGE_NEW_ERROR: Original error" } }),
      expected: "MEDIA_STORAGE_NEW_ERROR: Original error",
    },
    {
      name: "unconsumed legacy response",
      error: () => ({
        response: new Response(JSON.stringify({ detail: "Legacy storage error" })),
      }),
      expected: "Legacy storage error",
    },
    {
      name: "consumed response without parsed data",
      error: async () => {
        const response = new Response("unavailable");
        await response.text();
        return { response, message: "Storage request failed" };
      },
      expected: "Storage request failed",
    },
    {
      name: "synchronous response cloning failure",
      error: () => ({
        response: {
          bodyUsed: false,
          clone: () => {
            throw new TypeError("Cannot clone response");
          },
        },
        message: "Storage request failed",
      }),
      expected: "Storage request failed",
    },
    {
      name: "missing error details",
      error: () => ({}),
      expected: enT("settings.mediaStorage.saveFailed"),
    },
  ])("shows a storage save error for $name", async ({ error, expected }) => {
    modelGatewayMocks.saveMediaRelay.mockRejectedValue(await error());
    renderSettingsDialog();
    fireEvent.click(screen.getByRole("button", { name: /Media Storage/ }));
    fireEvent.click(
      screen.getByRole("tab", {
        name: enT("settings.mediaStorage.providerAliyunOss"),
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: enT("settings.mediaStorage.save") }),
    );

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expected));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("opens on the model settings page", () => {
    renderSettingsDialog();

    expect(screen.getByRole("button", { name: /Model Config/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByText("Choose a model gateway channel")).toBeInTheDocument();
    expect(screen.getByText("Agent model")).toBeInTheDocument();
  });

  it("saves an independent third-party Agent model", async () => {
    modelGatewayMocks.config = {
      mode: "official",
      effective: { source: "official", baseUrl: "https://relay.example/v1", apiKeyPreview: "", configured: false },
      llmEffective: { mode: "official", source: "official", baseUrl: "https://relay.example/v1", apiKeyPreview: "", configured: false, model: "brainclaw", brainclaw: true },
      agent: { mode: "inherit", baseUrl: "", apiKeyPreview: "", configured: false, model: "" },
      official: { source: "database", baseUrl: "https://relay.example/v1", apiKeyPreview: "", configured: false, environment: { baseUrl: "https://relay.example/v1", apiKeyPreview: "", configured: false } },
      custom: { llmMode: "advanced", baseUrl: "", apiKeyPreview: "", configured: false, adminBaseUrl: "", tokenName: "", tokenId: "" },
    };
    modelGatewayMocks.saveAgent.mockResolvedValue({ ok: true, data: modelGatewayMocks.config });

    renderSettingsDialog();
    fireEvent.click(screen.getByRole("tab", { name: "Third-party" }));
    fireEvent.change(screen.getByPlaceholderText("https://api.example.com/v1"), {
      target: { value: "https://agent.example/v1" },
    });
    const agentApiKey = document.querySelector(
      'input[name="agent-third-party-api-key"]',
    );
    expect(agentApiKey).not.toBeNull();
    fireEvent.change(agentApiKey!, {
      target: { value: "sk-agent-secret" },
    });
    fireEvent.change(screen.getByPlaceholderText("gpt-5.2-codex"), {
      target: { value: "vendor-agent-model" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Agent config" }));

    await waitFor(() => {
      expect(modelGatewayMocks.saveAgent).toHaveBeenCalledWith({
        mode: "third_party",
        baseUrl: "https://agent.example/v1",
        apiKey: "sk-agent-secret",
        model: "vendor-agent-model",
      });
    });
  });

  it("lets BrainClaw use an editable NewAPI endpoint in custom mode", async () => {
    modelGatewayMocks.config = {
      mode: "custom",
      effective: {
        source: "custom",
        baseUrl: "http://local-newapi:3000/v1",
        apiKeyPreview: "sk-c...cret",
        configured: true,
      },
      llmEffective: {
        mode: "relayclaw_brainclaw",
        source: "official",
        baseUrl: "https://relayclaw.cdnfg.com/v1",
        apiKeyPreview: "sk-r...cret",
        configured: true,
        model: "brainclaw",
        brainclaw: true,
      },
      official: {
        source: "database",
        baseUrl: "https://relayclaw.cdnfg.com/v1",
        apiKeyPreview: "sk-r...cret",
        configured: true,
        environment: {
          baseUrl: "https://relayclaw.cdnfg.com/v1",
          apiKeyPreview: "",
          configured: false,
        },
      },
      brainclaw: {
        baseUrl: "https://relayclaw.cdnfg.com/v1",
        apiKeyPreview: "sk-r...cret",
        configured: true,
      },
      custom: {
        llmMode: "relayclaw_brainclaw",
        baseUrl: "http://local-newapi:3000/v1",
        apiKeyPreview: "sk-c...cret",
        configured: true,
        adminBaseUrl: "http://local-newapi:3000",
        tokenName: "dramaclaw",
        tokenId: "1",
      },
    };

    renderSettingsDialog();

    expect(screen.getByRole("tab", { name: "RelayClaw BrainClaw (Recommended)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Advanced Custom" })).toBeInTheDocument();
    expect(screen.getByText("BrainClaw by RelayClaw (Recommended)")).toBeInTheDocument();
    const endpoint = screen.getByDisplayValue("https://relayclaw.cdnfg.com/v1");
    expect(endpoint).not.toHaveAttribute("readonly");
    expect(screen.getByText("brainclaw")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save and enable BrainClaw" })).toBeEnabled();
    expect(screen.getByText("Embedding model")).toBeInTheDocument();
    expect(screen.getByText("Media models")).toBeInTheDocument();
    expect(screen.queryByText("Business Model Mapping")).not.toBeInTheDocument();

    modelGatewayMocks.saveBrainClaw.mockResolvedValue({ ok: true, data: modelGatewayMocks.config });
    fireEvent.change(endpoint, { target: { value: "http://127.0.0.1:8317" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and enable BrainClaw" }));
    await waitFor(() => {
      expect(modelGatewayMocks.saveBrainClaw).toHaveBeenCalledWith({
        newApiBaseUrl: "http://127.0.0.1:8317",
      });
    });

    fireEvent.click(screen.getByRole("tab", { name: "Advanced Custom" }));

    expect(modelGatewayMocks.setCustomLlmMode).toHaveBeenCalledWith("advanced");
    expect(screen.getByText("Business Model Mapping")).toBeInTheDocument();
    expect(screen.getByText("Embedding model")).toBeInTheDocument();
    expect(screen.getByText("Media models")).toBeInTheDocument();
  });

  it("limits EE settings to Freezone Skills with Recipes under advanced management", () => {
    runtimeState.isCeRuntime = false;

    renderSettingsDialog();

    expect(screen.queryByRole("button", { name: /Model Config/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Media Storage/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Freezone Skills" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByText("No Freezone Skills yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Freezone Recipes" })).not.toBeInTheDocument();

    openRecipesManagement();

    expect(screen.getByText("No Freezone Recipes yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to Skills" })).toBeInTheDocument();
  });

  it("opens Recipes from the Skills advanced management entry", () => {
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "Freezone Skills" }));

    expect(screen.getByText("No Freezone Skills yet")).toBeInTheDocument();
    expect(screen.getByText("Import Skill")).toBeInTheDocument();
    expect(screen.queryByText("freezone_demo")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Freezone Recipes" })).not.toBeInTheDocument();

    openRecipesManagement();

    expect(screen.getByText("No Freezone Recipes yet")).toBeInTheDocument();
  });

  it("opens a JSON file picker from the Freezone import button", () => {
    const clickSpy = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => undefined);
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "Freezone Skills" }));
    fireEvent.click(screen.getByRole("button", { name: "Import Skill" }));

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Import Skill")).toHaveAttribute("type", "file");
    expect(screen.getByLabelText("Import Skill")).toHaveAttribute("accept", ".json,application/json");

    clickSpy.mockRestore();
  });

  it("opens the new Skill editor shell without saving data", () => {
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "Freezone Skills" }));
    fireEvent.click(screen.getByRole("button", { name: "New" }));

    expect(screen.getByText("New Skill")).toBeInTheDocument();
    expect(screen.getByText("No Freezone Skills yet")).toBeInTheDocument();
    expect(screen.getByText("Trigger Conditions")).toBeInTheDocument();
    expect(screen.getByText("Rule Config")).toBeInTheDocument();
    expect(screen.getByText("Evaluation Rules")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("No Freezone Skills yet")).toBeInTheDocument();
    expect(screen.queryByText("New Skill")).not.toBeInTheDocument();
  });

  it("opens the new Recipe editor shell from advanced management", () => {
    renderSettingsDialog();

    openRecipesManagement();
    fireEvent.click(screen.getByRole("button", { name: "New" }));

    expect(screen.getByText("New Recipe")).toBeInTheDocument();
    expect(screen.getByText("No Freezone Recipes yet")).toBeInTheDocument();
    expect(screen.getByText("Output type")).toBeInTheDocument();
    expect(screen.getAllByText("Operation keys")).toHaveLength(1);
    expect(screen.getAllByText("System Prompt")).toHaveLength(1);
    expect(screen.getAllByText("Required elements")).toHaveLength(1);
    expect(screen.getByText("Needs upstream media")).toBeInTheDocument();
    expect(screen.queryByText("Skip detail check")).not.toBeInTheDocument();
  });

  it("shows raw JSON that maps to the current new Recipe form fields", () => {
    renderSettingsDialog();

    openRecipesManagement();
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.change(screen.getByPlaceholderText("my-recipe"), {
      target: { value: "digital-product-text-plan" },
    });
    fireEvent.change(screen.getByPlaceholderText("e.g. ecommerce ad enhancement"), {
      target: { value: "Digital smart product detail page copy plan" },
    });

    const [operationInput, mustHaveItemsInput] =
      screen.getAllByPlaceholderText("Press Enter or comma to confirm");
    fireEvent.change(operationInput, {
      target: { value: "digital-product-text-plan" },
    });
    fireEvent.keyDown(operationInput, { key: "Enter", code: "Enter" });

    fireEvent.change(screen.getByPlaceholderText("System instruction used to enhance generation prompts..."), {
      target: { value: "System prompt" },
    });

    fireEvent.change(mustHaveItemsInput, { target: { value: "[Product positioning]" } });
    fireEvent.keyDown(mustHaveItemsInput, { key: "Enter", code: "Enter" });

    fireEvent.change(screen.getByPlaceholderText("Short hint for the planner (~30 chars)"), {
      target: { value: "Planning hint" },
    });
    fireEvent.change(screen.getByPlaceholderText("Output feature description (~50 chars)"), {
      target: { value: "Output description" },
    });
    fireEvent.click(screen.getByLabelText("Needs upstream media"));

    fireEvent.click(screen.getByRole("button", { name: "View / edit raw JSON (advanced)" }));

    const rawJson = JSON.parse(screen.getByLabelText("Recipe raw JSON").textContent ?? "{}");
    expect(rawJson).toMatchObject({
      id: "digital-product-text-plan",
      name: "Digital smart product detail page copy plan",
      output_kind: "image",
      action_keys: ["digital-product-text-plan"],
      system_prompt: "System prompt",
      must_have_items: ["[Product positioning]"],
      planning_prompt: "Planning hint",
      result_summary: "Output description",
      requires_source_media: true,
    });
    expect(rawJson).not.toHaveProperty("force_enhancement");
    expect(rawJson).not.toHaveProperty("skip_detail_check");
  });

  it("preserves legacy Recipe enhancement flags while keeping them out of the form", () => {
    freezoneAgentConfigMocks.items = [
      {
        id: "legacy-recipe",
        name: "Legacy Recipe",
        enabled: true,
        output_kind: "image",
        action_keys: ["legacy-action"],
        system_prompt: "Legacy system prompt",
        planning_prompt: "Legacy planning hint",
        result_summary: "Legacy output description",
        requires_source_media: false,
        force_enhancement: true,
        skip_detail_check: true,
      },
    ];
    renderSettingsDialog();

    openRecipesManagement();
    fireEvent.click(screen.getByRole("button", { name: "Edit Legacy Recipe" }));

    expect(screen.queryByText("Skip detail check")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View / edit raw JSON (advanced)" }));
    const rawJson = JSON.parse(screen.getByLabelText("Recipe raw JSON").textContent ?? "{}");
    expect(rawJson.force_enhancement).toBe(true);
    expect(rawJson.skip_detail_check).toBe(true);
  });

  it("copies the generated Recipe raw JSON from the raw JSON header", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderSettingsDialog();

    openRecipesManagement();
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.change(screen.getByPlaceholderText("my-recipe"), {
      target: { value: "copyable-recipe" },
    });
    fireEvent.change(screen.getByPlaceholderText("e.g. ecommerce ad enhancement"), {
      target: { value: "Copyable Recipe" },
    });
    fireEvent.change(screen.getByPlaceholderText("System instruction used to enhance generation prompts..."), {
      target: { value: "System prompt for copy" },
    });

    fireEvent.click(screen.getByRole("button", { name: "View / edit raw JSON (advanced)" }));
    const rawJsonText = screen.getByLabelText("Recipe raw JSON").textContent ?? "";

    fireEvent.click(screen.getByRole("button", { name: "Copy JSON" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(rawJsonText));
    expect(toast.success).toHaveBeenCalledWith("Recipe JSON copied");
  });

  it("does not save a Freezone Recipe until all required fields are present", () => {
    renderSettingsDialog();

    openRecipesManagement();
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.change(screen.getByPlaceholderText("my-recipe"), {
      target: { value: "story-recipe" },
    });
    fireEvent.change(screen.getByPlaceholderText("e.g. ecommerce ad enhancement"), {
      target: { value: "Story Recipe" },
    });

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    const [actionKeysInput] = screen.getAllByPlaceholderText("Press Enter or comma to confirm");
    fireEvent.change(actionKeysInput, {
      target: { value: "story-action" },
    });
    fireEvent.keyDown(actionKeysInput, { key: "Enter", code: "Enter" });
    fireEvent.change(screen.getByPlaceholderText("System instruction used to enhance generation prompts..."), {
      target: { value: "System prompt" },
    });

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("Short hint for the planner (~30 chars)"), {
      target: { value: "Planning hint" },
    });
    fireEvent.change(screen.getByPlaceholderText("Output feature description (~50 chars)"), {
      target: { value: "Output summary" },
    });

    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
  });

  it("adds and removes rating band rows in the new Skill editor", () => {
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "Freezone Skills" }));
    fireEvent.click(screen.getByRole("button", { name: "New" }));

    expect(screen.queryByPlaceholderText("Description for this score band")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add anchor" }));

    const scoreInput = screen.getByPlaceholderText("0");
    expect(scoreInput).toBeInTheDocument();
    expect(scoreInput).toHaveAttribute("min", "0");
    expect(scoreInput).toHaveAttribute("max", "10");
    expect(scoreInput).toHaveAttribute("step", "0.5");
    expect(screen.getByPlaceholderText("Description for this score band")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove rating band" }));

    expect(screen.queryByPlaceholderText("Description for this score band")).not.toBeInTheDocument();
  });

  it("adds and removes visual and text dimension rows in the new Skill editor", () => {
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "Freezone Skills" }));
    fireEvent.click(screen.getByRole("button", { name: "New" }));

    expect(screen.queryByPlaceholderText("Dimension name")).not.toBeInTheDocument();

    const addDimensionButtons = screen.getAllByRole("button", { name: "Add dimension" });
    fireEvent.click(addDimensionButtons[0]);
    fireEvent.click(addDimensionButtons[1]);

    expect(screen.getAllByPlaceholderText("Dimension name")).toHaveLength(2);
    const weightInputs = screen.getAllByPlaceholderText("1");
    expect(weightInputs).toHaveLength(2);
    for (const weightInput of weightInputs) {
      expect(weightInput).toHaveAttribute("min", "0");
      expect(weightInput).toHaveAttribute("max", "1");
      expect(weightInput).toHaveAttribute("step", "0.1");
    }
    expect(screen.getAllByPlaceholderText("Dimension description")).toHaveLength(2);

    fireEvent.click(screen.getAllByRole("button", { name: "Remove evaluation dimension" })[0]);

    expect(screen.getAllByPlaceholderText("Dimension name")).toHaveLength(1);
  });

  it("shows raw JSON that maps to the current new Skill form fields", () => {
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "Freezone Skills" }));
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.change(screen.getByPlaceholderText("my-skill"), { target: { value: "id" } });
    fireEvent.change(screen.getByPlaceholderText("general"), {
      target: { value: "category" },
    });
    fireEvent.change(screen.getByPlaceholderText("Describe the use case"), {
      target: { value: "des" },
    });
    const keywordInput = screen.getByPlaceholderText("Enter keywords");
    fireEvent.change(keywordInput, {
      target: { value: "keyword" },
    });
    fireEvent.keyDown(keywordInput, {
      key: "Enter",
      code: "Enter",
    });
    fireEvent.change(keywordInput, {
      target: { value: "keyword 2" },
    });
    fireEvent.keyDown(keywordInput, {
      key: "Enter",
      code: "Enter",
    });
    fireEvent.keyDown(keywordInput, {
      key: "Backspace",
      code: "Backspace",
    });
    expect(
      screen.queryByPlaceholderText(
        "textGeneration / imageGeneration / videoGeneration / audioGeneration",
      ),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Image generation imageGeneration" }));
    fireEvent.change(screen.getByPlaceholderText("Planning hint..."), {
      target: { value: "planhints" },
    });
    fireEvent.change(screen.getByPlaceholderText("Style guide..."), {
      target: { value: "sytleguide" },
    });
    const behaviorRulesInput = screen.getByPlaceholderText("Behavior rules...");
    fireEvent.change(behaviorRulesInput, {
      target: { value: "behaviorrules" },
    });
    fireEvent.keyDown(behaviorRulesInput, {
      key: "Enter",
      code: "Enter",
    });
    expect(screen.queryByText("Default aspect ratios")).not.toBeInTheDocument();
    expect(screen.queryByText("Model preference")).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("e.g. 7"), { target: { value: "7" } });
    fireEvent.change(screen.getByPlaceholderText("Enter rules"), {
      target: { value: "domainrules" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add anchor" }));

    expect(screen.getByRole("button", { name: "Delete keyword" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete keyword 2" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete imageGeneration" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit keyword" }));
    const keywordEditInput = screen.getByRole("textbox", { name: "Edit keyword" });
    expect(keywordEditInput).toHaveValue("keyword");
    expect(screen.queryByRole("button", { name: "Edit keyword" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete keyword" })).toBeInTheDocument();
    fireEvent.change(keywordEditInput, {
      target: { value: "keyword edited" },
    });
    fireEvent.keyDown(keywordEditInput, {
      key: "Enter",
      code: "Enter",
    });
    expect(screen.getByRole("button", { name: "Delete keyword edited" })).toBeInTheDocument();

    const addDimensionButtons = screen.getAllByRole("button", { name: "Add dimension" });
    fireEvent.click(addDimensionButtons[0]);
    fireEvent.click(addDimensionButtons[1]);

    fireEvent.change(screen.getByPlaceholderText("0"), { target: { value: "10" } });
    fireEvent.change(screen.getByPlaceholderText("Description for this score band"), {
      target: { value: "Score band description" },
    });

    const weightInputs = screen.getAllByPlaceholderText("1");
    fireEvent.change(weightInputs[0], { target: { value: "0.1" } });
    fireEvent.change(weightInputs[1], { target: { value: "0.9" } });

    fireEvent.click(screen.getByRole("button", { name: "View / edit raw JSON (advanced)" }));

    expect(screen.getByRole("button", { name: "Collapse raw JSON" })).toBeInTheDocument();
    const rawJson = JSON.parse(screen.getByLabelText("Raw JSON").textContent ?? "{}");

    expect(rawJson).toMatchObject({
      id: "id",
      description: "des",
      category: "category",
      triggers: {
        keywords: ["keyword edited"],
        node_scopes: ["imageGeneration"],
      },
      planning: {
        planning_notes: "planhints",
        prompt_guide: "sytleguide",
        conduct_rules: ["behaviorrules"],
      },
      evaluation: {
        rating_bands: [
          {
            score: 10,
            description: "Score band description",
          },
        ],
        visual_review_items: [
          {
            name: "",
            weight: 0.1,
            description: "",
          },
        ],
        text_review_items: [
          {
            name: "",
            weight: 0.9,
            description: "",
          },
        ],
        quality_threshold: 7,
        domain_constraints: ["domainrules"],
      },
    });
    expect(rawJson.planning.default_aspect_ratios).toBeUndefined();
    expect(rawJson.planning.model_preferences).toBeUndefined();
  });

  it("copies the generated Skill raw JSON from the raw JSON header", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "Freezone Skills" }));
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.change(screen.getByPlaceholderText("my-skill"), {
      target: { value: "copyable-skill" },
    });
    fireEvent.change(screen.getByPlaceholderText("general"), {
      target: { value: "poster" },
    });
    fireEvent.change(screen.getByPlaceholderText("Describe the use case"), {
      target: { value: "Copyable Skill" },
    });
    const keywordInput = screen.getByPlaceholderText("Enter keywords");
    fireEvent.change(keywordInput, {
      target: { value: "poster" },
    });
    fireEvent.keyDown(keywordInput, {
      key: "Enter",
      code: "Enter",
    });

    fireEvent.click(screen.getByRole("button", { name: "View / edit raw JSON (advanced)" }));
    const rawJsonText = screen.getByLabelText("Raw JSON").textContent ?? "";

    fireEvent.click(screen.getByRole("button", { name: "Copy JSON" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(rawJsonText));
    expect(toast.success).toHaveBeenCalledWith("Skill JSON copied");
  });

  it("saves a new Freezone Skill through account config storage", async () => {
    freezoneAgentConfigMocks.save.mockResolvedValue({
      id: "story-skill",
      description: "Story rules",
      category: "general",
    });
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "Freezone Skills" }));
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.change(screen.getByPlaceholderText("my-skill"), {
      target: { value: "story-skill" },
    });
    fireEvent.change(screen.getByPlaceholderText("Describe the use case"), {
      target: { value: "Story rules" },
    });
    fireEvent.change(screen.getByPlaceholderText("Enter keywords"), {
      target: { value: "story" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText("Enter keywords"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Add Recipe" }));
    fireEvent.change(screen.getByPlaceholderText("Enter Recipe ID"), {
      target: { value: "story-recipe" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText("Enter Recipe ID"), { key: "Enter" });
    fireEvent.change(screen.getByPlaceholderText("Planning hint..."), {
      target: { value: "Plan dynamically according to story needs." },
    });
    fireEvent.change(screen.getByPlaceholderText("Behavior rules..."), {
      target: { value: "Keep story consistency" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText("Behavior rules..."), { key: "Enter" });
    fireEvent.change(screen.getByPlaceholderText("e.g. 7"), { target: { value: "7" } });
    fireEvent.change(screen.getByPlaceholderText("Enter rules"), {
      target: { value: "Do not stray from the story theme" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add anchor" }));
    fireEvent.change(screen.getByPlaceholderText("0"), { target: { value: "5" } });
    fireEvent.change(screen.getByPlaceholderText("Description for this score band"), {
      target: { value: "Story is complete" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(freezoneAgentConfigMocks.save).toHaveBeenCalledWith({
        kind: "skills",
        payload: expect.objectContaining({
          id: "story-skill",
          description: "Story rules",
          category: "general",
          allowed_recipe_ids: ["story-recipe"],
        }),
      });
    });
  });

  it("does not render Freezone Skill catalog tags in the list", async () => {
    freezoneAgentConfigMocks.items = [
      {
        id: "social-media",
        enabled: true,
        category: "social",
        description: "Social media content asset production",
        triggers: { keywords: ["instagram", "tiktok"] },
      },
    ];
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "Freezone Skills" }));

    expect(screen.getByText("social-media")).toBeInTheDocument();
    expect(screen.getByText("Social media content asset production")).toBeInTheDocument();
    expect(screen.queryByText("instagram")).not.toBeInTheDocument();
    expect(screen.queryByText("tiktok")).not.toBeInTheDocument();
    expect(screen.queryByText("social")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search Skill"), {
      target: { value: "instagram" },
    });

    expect(screen.getByText("social-media")).toBeInTheDocument();
  });

  it("renders Freezone Recipe generation type labels in the list", async () => {
    freezoneAgentConfigMocks.items = [
      {
        id: "public-welfare-poster-9-16",
        name: "Public-interest poster generation",
        enabled: true,
        output_kind: "image",
        action_keys: ["public-welfare-poster-9-16"],
        result_summary: "9:16 vertical public-interest poster",
      },
      {
        id: "public-welfare-copy",
        name: "Public-interest copywriting",
        _catalog_source: "user",
        _catalog_base_source: "builtin",
        enabled: true,
        output_kind: "text",
        action_keys: ["public-welfare-copy"],
        result_summary: "Warm and touching public-interest copy",
      },
    ];
    renderSettingsDialog();

    openRecipesManagement();

    expect(screen.getByText("Public-interest poster generation").closest("article")).toHaveTextContent("Image");
    expect(screen.getByText("Public-interest copywriting").closest("article")).toHaveTextContent("Text");
    expect(screen.getByText("Public-interest copywriting").closest("article")).toHaveTextContent("Custom");
    expect(screen.queryByText("Customized")).not.toBeInTheDocument();
    expect(screen.queryByText("image")).not.toBeInTheDocument();
    expect(screen.queryByText("text")).not.toBeInTheDocument();
  });

  it("marks built-in Freezone catalog items in the list", async () => {
    freezoneAgentConfigMocks.items = [
      {
        id: "builtin-skill",
        _catalog_source: "builtin",
        enabled: true,
        category: "general",
        description: "Built-in rules",
        triggers: { keywords: ["builtin"] },
      },
      {
        id: "user-skill",
        enabled: true,
        category: "general",
        description: "User rules",
        triggers: { keywords: ["user"] },
      },
    ];
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "Freezone Skills" }));

    expect(screen.getByText("builtin-skill")).toBeInTheDocument();
    expect(screen.getByText("user-skill")).toBeInTheDocument();
    expect(screen.getByText("Built-in")).toBeInTheDocument();
    expect(screen.getByText("builtin-skill").closest("article")).toHaveTextContent("Built-in");
    expect(screen.getByText("user-skill").closest("article")).not.toHaveTextContent("Built-in");
  });

  it("marks customized built-in items and toggles pure built-ins with the full payload", async () => {
    freezoneAgentConfigMocks.items = [
      {
        id: "builtin-skill",
        schema_version: "dramaclaw.workflow-skill.v1",
        name: "Built-in Skill",
        version: "1.0.0",
        _catalog_source: "builtin",
        enabled: true,
        category: "general",
        description: "Built-in rules",
        triggers: { keywords: ["builtin"] },
        allowed_recipe_ids: ["builtin-recipe"],
        input_parameters: [
          {
            id: "aspect_ratio",
            label: "Aspect",
            type: "single_select",
            required: true,
            default: "16:9",
            options: ["16:9", "1:1"],
          },
        ],
        planning: {
          planning_notes: "Plan dynamically according to the user's goal.",
          conduct_rules: ["Keep the subject consistent."],
        },
        evaluation: {
          rating_bands: [{ score: 5, description: "Result is clear" }],
          quality_threshold: 4,
          domain_constraints: ["Do not change the subject."],
        },
      },
      {
        id: "customized-skill",
        _catalog_source: "user",
        _catalog_base_source: "builtin",
        enabled: true,
        category: "general",
        description: "User custom rules",
        triggers: { keywords: ["customized"] },
      },
    ];
    freezoneAgentConfigMocks.save.mockResolvedValue({});
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "Freezone Skills" }));

    expect(screen.getByText("Built-in Skill").closest("article")).toHaveTextContent("Built-in");
    expect(screen.getByText("customized-skill").closest("article")).toHaveTextContent("Custom");
    expect(screen.queryByText("Customized")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "Toggle Built-in Skill enabled state" }));

    await waitFor(() => {
      expect(freezoneAgentConfigMocks.save).toHaveBeenCalledWith({
        kind: "skills",
        payload: {
          id: "builtin-skill",
          schema_version: "dramaclaw.workflow-skill.v1",
          name: "Built-in Skill",
          version: "1.0.0",
          enabled: false,
          category: "general",
          description: "Built-in rules",
          triggers: { keywords: ["builtin"] },
          allowed_recipe_ids: ["builtin-recipe"],
          input_parameters: [
            {
              id: "aspect_ratio",
              label: "Aspect",
              type: "single_select",
              required: true,
              default: "16:9",
              options: ["16:9", "1:1"],
            },
          ],
          planning: {
            planning_notes: "Plan dynamically according to the user's goal.",
            conduct_rules: ["Keep the subject consistent."],
          },
          evaluation: {
            rating_bands: [{ score: 5, description: "Result is clear" }],
            quality_threshold: 4,
            domain_constraints: ["Do not change the subject."],
          },
        },
      });
    });
  });

  it("does not save a Freezone Skill until all required fields are present", async () => {
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "Freezone Skills" }));
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.change(screen.getByPlaceholderText("my-skill"), {
      target: { value: "story-skill" },
    });
    fireEvent.change(screen.getByPlaceholderText("Describe the use case"), {
      target: { value: "Story rules" },
    });

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(freezoneAgentConfigMocks.save).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText("Enter keywords"), {
      target: { value: "story" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText("Enter keywords"), { key: "Enter" });

    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
  });

  it("rejects imported Freezone Recipes that miss required fields", async () => {
    renderSettingsDialog();

    openRecipesManagement();
    const importInput = screen.getByLabelText("Import");
    const file = new File(
      [
        JSON.stringify({
          id: "recipe-without-system-prompt",
          name: "Missing-field Recipe",
          output_kind: "image",
          action_keys: ["missing-prompt"],
        }),
      ],
      "recipe.json",
      { type: "application/json" },
    );
    fireEvent.change(importInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(freezoneAgentConfigMocks.save).not.toHaveBeenCalled();
    });
  });

  it("rejects imported Freezone Skills that miss required schema fields", async () => {
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "Freezone Skills" }));
    const importInput = screen.getByLabelText("Import");
    const file = new File(
      [
        JSON.stringify({
          id: "loose-skill",
          name: "Half-finished Skill",
          enabled: true,
          allowed_recipe_ids: ["loose-recipe"],
          category: "video",
          description: "Missing planning and evaluation fields",
          triggers: { keywords: ["half"] },
        }),
      ],
      "skill.json",
      { type: "application/json" },
    );
    fireEvent.change(importInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(freezoneAgentConfigMocks.save).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("planning.planning_notes"));
    });
  });

  it("exports selected Freezone config items as JSON", async () => {
    freezoneAgentConfigMocks.items = [
      {
        id: "story-skill",
        description: "Story rules",
        category: "general",
      },
      {
        id: "visual-skill",
        description: "Visual rules",
        category: "image",
      },
    ];
    const createObjectURL = vi.fn((payload: Blob | MediaSource) => {
      void payload;
      return "blob:freezone-config";
    });
    const revokeObjectURL = vi.fn();
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });

    try {
      renderSettingsDialog();

      fireEvent.click(screen.getByRole("button", { name: "Freezone Skills" }));
      fireEvent.click(screen.getAllByRole("checkbox")[1]);
      fireEvent.click(screen.getByRole("button", { name: "Export Skill" }));

      await waitFor(() => {
        expect(anchorClick).toHaveBeenCalledTimes(1);
      });
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:freezone-config");
      const exportedBlob = createObjectURL.mock.calls[0]?.[0];
      if (!(exportedBlob instanceof Blob)) {
        throw new Error("expected Freezone export to create a Blob");
      }
      const exportedText = await exportedBlob.text();
      expect(exportedText).toContain('"id": "story-skill"');
      expect(exportedText).not.toContain('"id": "visual-skill"');
    } finally {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: originalCreateObjectURL,
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: originalRevokeObjectURL,
      });
      anchorClick.mockRestore();
    }
  });

  it("selects all visible items and deletes them in bulk", async () => {
    freezoneAgentConfigMocks.items = [
      {
        id: "story-skill",
        description: "Story rules",
        category: "general",
      },
      {
        id: "visual-skill",
        description: "Visual rules",
        category: "image",
      },
    ];
    freezoneAgentConfigMocks.delete.mockResolvedValue({ deleted: true });
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "Freezone Skills" }));
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));

    await waitFor(() => {
      expect(freezoneAgentConfigMocks.delete).toHaveBeenCalledWith({
        kind: "skills",
        id: "story-skill",
      });
      expect(freezoneAgentConfigMocks.delete).toHaveBeenCalledWith({
        kind: "skills",
        id: "visual-skill",
      });
    });
  });

  it("toggles and deletes an existing Freezone Skill", async () => {
    freezoneAgentConfigMocks.items = [
      {
        id: "story-skill",
        description: "Story rules",
        category: "general",
        enabled: true,
        triggers: { keywords: ["story"] },
      },
    ];
    freezoneAgentConfigMocks.save.mockResolvedValue({});
    freezoneAgentConfigMocks.delete.mockResolvedValue({ deleted: true });
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "Freezone Skills" }));
    fireEvent.click(screen.getByRole("switch", { name: "Toggle story-skill enabled state" }));

    await waitFor(() => {
      expect(freezoneAgentConfigMocks.save).toHaveBeenCalledWith({
        kind: "skills",
        payload: expect.objectContaining({
          id: "story-skill",
          enabled: false,
        }),
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete story-skill" }));
    expect(screen.getByText("Delete Skill")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete Skill only" }));

    await waitFor(() => {
      expect(freezoneAgentConfigMocks.delete).toHaveBeenCalledWith({
        kind: "skills",
        id: "story-skill",
      });
    });
  });

  it("deletes a Skill with only its exclusive linked Recipes", async () => {
    freezoneAgentConfigMocks.itemsByKind = {
      skills: [
        {
          id: "story-skill",
          description: "Story rules",
          allowed_recipe_ids: ["recipe-a", "recipe-b"],
        },
        {
          id: "visual-skill",
          description: "Visual rules",
          allowed_recipe_ids: ["recipe-b"],
        },
      ],
      recipes: [
        { id: "recipe-a", output_kind: "text", result_summary: "A" },
        { id: "recipe-b", output_kind: "image", result_summary: "B" },
        { id: "recipe-c", output_kind: "video", result_summary: "C" },
      ],
    };
    freezoneAgentConfigMocks.delete.mockResolvedValue({ deleted: true });
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "Freezone Skills" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete story-skill" }));

    expect(screen.getByText("recipe-a")).toBeInTheDocument();
    expect(screen.getByText("recipe-b")).toBeInTheDocument();
    expect(screen.queryByText("recipe-c")).not.toBeInTheDocument();
    expect(screen.getByText("Can be deleted with this Skill")).toBeInTheDocument();
    expect(screen.getByText("Shared modules will be kept")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete Skill and exclusive modules" }));

    await waitFor(() => {
      expect(freezoneAgentConfigMocks.delete).toHaveBeenCalledWith({
        kind: "skills",
        id: "story-skill",
      });
      expect(freezoneAgentConfigMocks.delete).toHaveBeenCalledWith({
        kind: "recipes",
        id: "recipe-a",
      });
      expect(freezoneAgentConfigMocks.delete).not.toHaveBeenCalledWith({
        kind: "recipes",
        id: "recipe-b",
      });
      expect(freezoneAgentConfigMocks.delete).not.toHaveBeenCalledWith({
        kind: "recipes",
        id: "recipe-c",
      });
    });
  });

  it("keeps the linked Recipe delete option hidden when all linked Recipes are shared", async () => {
    freezoneAgentConfigMocks.itemsByKind = {
      skills: [
        {
          id: "story-skill",
          description: "Story rules",
          allowed_recipe_ids: ["recipe-a"],
        },
        {
          id: "visual-skill",
          description: "Visual rules",
          allowed_recipe_ids: ["recipe-a"],
        },
      ],
      recipes: [
        { id: "recipe-a", output_kind: "text", result_summary: "A" },
      ],
    };
    freezoneAgentConfigMocks.delete.mockResolvedValue({ deleted: true });
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "Freezone Skills" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete story-skill" }));

    expect(screen.getByText("recipe-a")).toBeInTheDocument();
    expect(screen.getByText("Shared modules will be kept")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete Skill and exclusive modules" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete Skill only" }));

    await waitFor(() => {
      expect(freezoneAgentConfigMocks.delete).toHaveBeenCalledWith({
        kind: "skills",
        id: "story-skill",
      });
      expect(freezoneAgentConfigMocks.delete).not.toHaveBeenCalledWith({
        kind: "recipes",
        id: "recipe-a",
      });
    });
  });

  it("opens an existing Freezone Skill for editing", () => {
    freezoneAgentConfigMocks.items = [
      {
        id: "story-skill",
        description: "Story rules",
        category: "general",
        triggers: { keywords: ["story"], nodeTypes: ["imageGeneration"] },
        planning: {
          default_aspect_ratios: {
            imageGeneration: "9:16",
            textGeneration: "1:1",
            videoGeneration: "auto",
          },
        },
      },
    ];
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "Freezone Skills" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit story-skill" }));

    expect(screen.getByText("Edit Skill")).toBeInTheDocument();
    expect(screen.queryByText("New Skill")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("story-skill")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Story rules")).toBeInTheDocument();
    expect(screen.getAllByText("story").length).toBeGreaterThan(0);
    expect(screen.getByRole("checkbox", { name: "Image generation imageGeneration" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "View / edit raw JSON (advanced)" }));
    const rawJson = JSON.parse(screen.getByLabelText("Raw JSON").textContent ?? "{}");
    expect(rawJson.planning.default_aspect_ratios).toBeUndefined();
    expect(rawJson.planning.model_preferences).toBeUndefined();
  });

});
