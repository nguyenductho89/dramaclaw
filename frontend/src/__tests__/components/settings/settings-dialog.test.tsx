// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { SettingsDialog } from "@/components/settings/settings-dialog";

const runtimeState = vi.hoisted(() => ({ isCeRuntime: true }));
const modelGatewayMocks = vi.hoisted(() => ({
  config: undefined as Record<string, unknown> | undefined,
  saveBrainClaw: vi.fn(),
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
  useSaveMediaRelayConfig: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSyncProviderChannel: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("react-i18next", () => ({
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
      },
    ) =>
      ({
        "settings.title": "Settings",
        "settings.close": "Close",
        "settings.navigationLabel": "设置导航",
        "settings.pages.models": "Model Config",
        "settings.pages.storage": "Media Storage",
        "settings.pages.freezoneSkills": "Freezone Skills",
        "settings.pages.freezoneRecipes": "Freezone Recipes",
        "settings.statusConfigured": `${options?.page ?? ""} is configured`,
        "settings.statusNotConfigured": `${options?.page ?? ""} is not configured`,
        "settings.modelConfig.title": "Model Config",
        "settings.modelConfig.description": "选择模型网关渠道",
        "settings.modelConfig.gatewayWarningIconLabel": "Model gateway is not configured",
        "settings.modelConfig.gatewayNotConfiguredImpact": "Model gateway is not configured",
        "settings.modelConfig.modes.official": "官方渠道",
        "settings.modelConfig.modes.custom": "自定义 NewAPI",
        "settings.modelConfig.official.description": "官方渠道说明",
        "settings.modelConfig.official.registerLink": "注册",
        "settings.modelConfig.official.save": "Save & Enable",
        "settings.modelConfig.brainclaw.tab": "RelayClaw BrainClaw (Recommended)",
        "settings.modelConfig.brainclaw.advancedTab": "Advanced Custom",
        "settings.modelConfig.brainclaw.title": "BrainClaw by RelayClaw (Recommended)",
        "settings.modelConfig.brainclaw.description": "虾脑仅通过虾驿提供",
        "settings.modelConfig.brainclaw.model": "Fixed model",
        "settings.modelConfig.brainclaw.save": "保存并启用 BrainClaw",
        "settings.modelConfig.featureModels.title": "Business Model Mapping",
        "settings.modelConfig.embeddingModel.title": "Embedding 模型",
        "settings.modelConfig.mediaModels.title": "媒体模型",
        "settings.modelConfig.fields.gatewayBaseUrl": "Gateway URL",
        "settings.modelConfig.fields.apiKey": "API Key",
        "settings.mediaStorage.title": "Image Host / Media Storage",
        "settings.mediaStorage.description": "媒体存储说明",
        "settings.freezoneCatalog.skills.description": "Manage skills the Agent can use directly.",
        "settings.freezoneCatalog.recipes.description": "Maintain the underlying Recipes that Skills can call, usually for debugging or built-in capability management.",
        "settings.freezoneCatalog.searchSkills": "Search Skill",
        "settings.freezoneCatalog.searchRecipes": "搜索 Recipe",
        "settings.freezoneCatalog.emptySkills": "No Freezone Skills yet",
        "settings.freezoneCatalog.emptyRecipes": "No Freezone Recipes yet",
        "settings.freezoneCatalog.emptyDescription": "当前还没有配置项。",
        "settings.freezoneCatalog.loading": "Loading…",
        "settings.freezoneCatalog.retry": "Retry",
        "settings.freezoneCatalog.saved": "Freezone config saved",
        "settings.freezoneCatalog.saveFailed": "Save failed. Check the config content.",
        "settings.freezoneCatalog.deleted": "Freezone config deleted",
        "settings.freezoneCatalog.deleteFailed": "Delete failed. Please retry.",
        "settings.freezoneCatalog.deleteSelected": "Delete selected",
        "settings.freezoneCatalog.deleteSkillDialog.title": "Delete Skill",
        "settings.freezoneCatalog.deleteSkillDialog.description": `确定要删除「${options?.id ?? ""}」吗？`,
        "settings.freezoneCatalog.deleteSkillDialog.recipeHint": `This Skill uses ${options?.count ?? 0} modules: ${options?.exclusiveCount ?? 0} used only here, ${options?.sharedCount ?? 0} also used by other Skills.`,
        "settings.freezoneCatalog.deleteSkillDialog.exclusiveRecipes": "Can be deleted with this Skill",
        "settings.freezoneCatalog.deleteSkillDialog.sharedRecipes": "Shared modules will be kept",
        "settings.freezoneCatalog.deleteSkillDialog.cancel": "Cancel",
        "settings.freezoneCatalog.deleteSkillDialog.deleteSkillOnly": "Delete Skill only",
        "settings.freezoneCatalog.deleteSkillDialog.deleteWithRecipes": "Delete Skill and exclusive modules",
        "settings.freezoneCatalog.exported": "Freezone config exported",
        "settings.freezoneCatalog.imported": "Freezone config imported",
        "settings.freezoneCatalog.importFailed": "Import failed. Choose a valid JSON file.",
        "settings.freezoneCatalog.toggleEnabled": `切换 ${options?.id ?? ""} 启用状态`,
        "settings.freezoneCatalog.editItem": `Edit ${options?.id ?? ""}`,
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
        "settings.freezoneCatalog.customizedShort": "定制",
        "settings.freezoneCatalog.skillsCount": `${options?.count ?? 0} item(s)`,
        "settings.freezoneCatalog.recipesCount": `${options?.count ?? 0} item(s)`,
        "settings.freezoneCatalog.selectionCount": `${options?.selectedCount ?? 0} / ${options?.count ?? 0} selected`,
        "settings.freezoneCatalog.recipesPendingTitle": "Recipe settings entry reserved",
        "settings.freezoneCatalog.recipesPendingDescription": "等待后端 Recipe catalog 接入后，这里会展示和编辑虾画 Recipes。",
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
        "settings.freezoneCatalog.newSkill.keywordsPlaceholder": "输入关键词",
        "settings.freezoneCatalog.newSkill.keywordsHint": "支持权重",
        "settings.freezoneCatalog.newSkill.nodeScopes": "Node scopes",
        "settings.freezoneCatalog.newSkill.nodeScopesPlaceholder": "textGeneration / imageGeneration / videoGeneration / audioGeneration",
        "settings.freezoneCatalog.newSkill.workflow2Title": "Workflow Settings",
        "settings.freezoneCatalog.newSkill.workflow2Description": "工作流字段",
        "settings.freezoneCatalog.newSkill.schemaVersion": "Schema version",
        "settings.freezoneCatalog.newSkill.version": "Release",
        "settings.freezoneCatalog.newSkill.allowedRecipeIds": "Linked Recipes",
        "settings.freezoneCatalog.newSkill.allowedRecipeIdsPlaceholder": "输入 Recipe ID",
        "settings.freezoneCatalog.newSkill.allowedRecipeIdsHint": "动态规划时使用",
        "settings.freezoneCatalog.newSkill.inputParameters": "Start options",
        "settings.freezoneCatalog.newSkill.inputParametersEmpty": "没有选项",
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
        "settings.freezoneCatalog.newSkill.planningDescription": "规则策略",
        "settings.freezoneCatalog.newSkill.planningNotes": "Planner guidance",
        "settings.freezoneCatalog.newSkill.planningNotesPlaceholder": "规划提示...",
        "settings.freezoneCatalog.newSkill.promptGuide": "Prompt style",
        "settings.freezoneCatalog.newSkill.promptGuidePlaceholder": "风格指引...",
        "settings.freezoneCatalog.newSkill.conductRules": "Behavior rules",
        "settings.freezoneCatalog.newSkill.conductRulesPlaceholder": "行为规则...",
        "settings.freezoneCatalog.newSkill.aspectPresets": "默认画幅",
        "settings.freezoneCatalog.newSkill.modelNamePlaceholder": "任务类型",
        "settings.freezoneCatalog.newSkill.ratioPlaceholder": "Aspect ratio",
        "settings.freezoneCatalog.newSkill.ratioLabel": "Aspect ratio",
        "settings.freezoneCatalog.newSkill.ratioSelectPlaceholder": "选择比例",
        "settings.freezoneCatalog.newSkill.modelHints": "模型偏好",
        "settings.freezoneCatalog.newSkill.taskTypeLabel": "任务类型",
        "settings.freezoneCatalog.newSkill.taskTypePlaceholder": "选择类型",
        "settings.freezoneCatalog.newSkill.modelSelectLabel": "Model name",
        "settings.freezoneCatalog.newSkill.modelSelectPlaceholder": "Select model",
        "settings.freezoneCatalog.newSkill.modelLoading": "模型加载中…",
        "settings.freezoneCatalog.newSkill.evaluationTitle": "Evaluation Rules",
        "settings.freezoneCatalog.newSkill.evaluationDescription": "评分标准",
        "settings.freezoneCatalog.newSkill.qualityThreshold": "Passing score",
        "settings.freezoneCatalog.newSkill.qualityThresholdPlaceholder": "e.g. 7",
        "settings.freezoneCatalog.newSkill.domainConstraints": "Domain rules",
        "settings.freezoneCatalog.newSkill.domainConstraintsPlaceholder": "输入规则",
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
        "settings.freezoneCatalog.newSkill.rawJsonSyncHint": "直接编辑 JSON 会同步到上方表单字段",
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
      })[key] ?? options?.defaultValue ?? key,
  }),
}));

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
  modelGatewayMocks.config = undefined;
  modelGatewayMocks.saveBrainClaw.mockReset();
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
  it("opens on the model settings page", () => {
    renderSettingsDialog();

    expect(screen.getByRole("button", { name: /Model Config/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByText("选择模型网关渠道")).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "保存并启用 BrainClaw" })).toBeEnabled();
    expect(screen.getByText("Embedding 模型")).toBeInTheDocument();
    expect(screen.getByText("媒体模型")).toBeInTheDocument();
    expect(screen.queryByText("Business Model Mapping")).not.toBeInTheDocument();

    modelGatewayMocks.saveBrainClaw.mockResolvedValue({ ok: true, data: modelGatewayMocks.config });
    fireEvent.change(endpoint, { target: { value: "http://127.0.0.1:8317" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并启用 BrainClaw" }));
    await waitFor(() => {
      expect(modelGatewayMocks.saveBrainClaw).toHaveBeenCalledWith({
        newApiBaseUrl: "http://127.0.0.1:8317",
      });
    });

    fireEvent.click(screen.getByRole("tab", { name: "Advanced Custom" }));

    expect(modelGatewayMocks.setCustomLlmMode).toHaveBeenCalledWith("advanced");
    expect(screen.getByText("Business Model Mapping")).toBeInTheDocument();
    expect(screen.getByText("Embedding 模型")).toBeInTheDocument();
    expect(screen.getByText("媒体模型")).toBeInTheDocument();
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
      target: { value: "数码智能产品详情页策划文案" },
    });

    const [operationInput, mustHaveItemsInput] =
      screen.getAllByPlaceholderText("Press Enter or comma to confirm");
    fireEvent.change(operationInput, {
      target: { value: "digital-product-text-plan" },
    });
    fireEvent.keyDown(operationInput, { key: "Enter", code: "Enter" });

    fireEvent.change(screen.getByPlaceholderText("System instruction used to enhance generation prompts..."), {
      target: { value: "系统提示" },
    });

    fireEvent.change(mustHaveItemsInput, { target: { value: "【产品定位】" } });
    fireEvent.keyDown(mustHaveItemsInput, { key: "Enter", code: "Enter" });

    fireEvent.change(screen.getByPlaceholderText("Short hint for the planner (~30 chars)"), {
      target: { value: "规划提示" },
    });
    fireEvent.change(screen.getByPlaceholderText("Output feature description (~50 chars)"), {
      target: { value: "输出描述" },
    });
    fireEvent.click(screen.getByLabelText("Needs upstream media"));

    fireEvent.click(screen.getByRole("button", { name: "View / edit raw JSON (advanced)" }));

    const rawJson = JSON.parse(screen.getByLabelText("Recipe raw JSON").textContent ?? "{}");
    expect(rawJson).toMatchObject({
      id: "digital-product-text-plan",
      name: "数码智能产品详情页策划文案",
      output_kind: "image",
      action_keys: ["digital-product-text-plan"],
      system_prompt: "系统提示",
      must_have_items: ["【产品定位】"],
      planning_prompt: "规划提示",
      result_summary: "输出描述",
      requires_source_media: true,
    });
    expect(rawJson).not.toHaveProperty("force_enhancement");
    expect(rawJson).not.toHaveProperty("skip_detail_check");
  });

  it("preserves legacy Recipe enhancement flags while keeping them out of the form", () => {
    freezoneAgentConfigMocks.items = [
      {
        id: "legacy-recipe",
        name: "旧版 Recipe",
        enabled: true,
        output_kind: "image",
        action_keys: ["legacy-action"],
        system_prompt: "旧版系统提示",
        planning_prompt: "旧版规划提示",
        result_summary: "旧版输出说明",
        requires_source_media: false,
        force_enhancement: true,
        skip_detail_check: true,
      },
    ];
    renderSettingsDialog();

    openRecipesManagement();
    fireEvent.click(screen.getByRole("button", { name: "Edit 旧版 Recipe" }));

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
      target: { value: "可复制 Recipe" },
    });
    fireEvent.change(screen.getByPlaceholderText("System instruction used to enhance generation prompts..."), {
      target: { value: "复制用系统提示" },
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
      target: { value: "故事 Recipe" },
    });

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    const [actionKeysInput] = screen.getAllByPlaceholderText("Press Enter or comma to confirm");
    fireEvent.change(actionKeysInput, {
      target: { value: "story-action" },
    });
    fireEvent.keyDown(actionKeysInput, { key: "Enter", code: "Enter" });
    fireEvent.change(screen.getByPlaceholderText("System instruction used to enhance generation prompts..."), {
      target: { value: "系统提示" },
    });

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("Short hint for the planner (~30 chars)"), {
      target: { value: "规划提示" },
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
    const keywordInput = screen.getByPlaceholderText("输入关键词");
    fireEvent.change(keywordInput, {
      target: { value: "关键词" },
    });
    fireEvent.keyDown(keywordInput, {
      key: "Enter",
      code: "Enter",
    });
    fireEvent.change(keywordInput, {
      target: { value: "关键词2" },
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
    fireEvent.click(screen.getByRole("checkbox", { name: "Image 片生成 imageGeneration" }));
    fireEvent.change(screen.getByPlaceholderText("规划提示..."), {
      target: { value: "planhints" },
    });
    fireEvent.change(screen.getByPlaceholderText("风格指引..."), {
      target: { value: "sytleguide" },
    });
    const behaviorRulesInput = screen.getByPlaceholderText("行为规则...");
    fireEvent.change(behaviorRulesInput, {
      target: { value: "behaviorrules" },
    });
    fireEvent.keyDown(behaviorRulesInput, {
      key: "Enter",
      code: "Enter",
    });
    expect(screen.queryByText("默认画幅")).not.toBeInTheDocument();
    expect(screen.queryByText("模型偏好")).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("e.g. 7"), { target: { value: "7" } });
    fireEvent.change(screen.getByPlaceholderText("输入规则"), {
      target: { value: "domainrules" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add anchor" }));

    expect(screen.getByRole("button", { name: "Delete 关键词" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete 关键词2" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete imageGeneration" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit 关键词" }));
    const keywordEditInput = screen.getByRole("textbox", { name: "Edit 关键词" });
    expect(keywordEditInput).toHaveValue("关键词");
    expect(screen.queryByRole("button", { name: "Edit 关键词" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete 关键词" })).toBeInTheDocument();
    fireEvent.change(keywordEditInput, {
      target: { value: "关键词编辑" },
    });
    fireEvent.keyDown(keywordEditInput, {
      key: "Enter",
      code: "Enter",
    });
    expect(screen.getByRole("button", { name: "Delete 关键词编辑" })).toBeInTheDocument();

    const addDimensionButtons = screen.getAllByRole("button", { name: "Add dimension" });
    fireEvent.click(addDimensionButtons[0]);
    fireEvent.click(addDimensionButtons[1]);

    fireEvent.change(screen.getByPlaceholderText("0"), { target: { value: "10" } });
    fireEvent.change(screen.getByPlaceholderText("Description for this score band"), {
      target: { value: "分数段描述" },
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
        keywords: ["关键词编辑"],
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
            description: "分数段描述",
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
      target: { value: "可复制 Skill" },
    });
    const keywordInput = screen.getByPlaceholderText("输入关键词");
    fireEvent.change(keywordInput, {
      target: { value: "海报" },
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
      description: "故事规则",
      category: "general",
    });
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "Freezone Skills" }));
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.change(screen.getByPlaceholderText("my-skill"), {
      target: { value: "story-skill" },
    });
    fireEvent.change(screen.getByPlaceholderText("Describe the use case"), {
      target: { value: "故事规则" },
    });
    fireEvent.change(screen.getByPlaceholderText("输入关键词"), {
      target: { value: "故事" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText("输入关键词"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "添加 Recipe" }));
    fireEvent.change(screen.getByPlaceholderText("输入 Recipe ID"), {
      target: { value: "story-recipe" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText("输入 Recipe ID"), { key: "Enter" });
    fireEvent.change(screen.getByPlaceholderText("规划提示..."), {
      target: { value: "根据故事需求动态规划。" },
    });
    fireEvent.change(screen.getByPlaceholderText("行为规则..."), {
      target: { value: "保持故事一致性" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText("行为规则..."), { key: "Enter" });
    fireEvent.change(screen.getByPlaceholderText("e.g. 7"), { target: { value: "7" } });
    fireEvent.change(screen.getByPlaceholderText("输入规则"), {
      target: { value: "不得偏离故事主题" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add anchor" }));
    fireEvent.change(screen.getByPlaceholderText("0"), { target: { value: "5" } });
    fireEvent.change(screen.getByPlaceholderText("Description for this score band"), {
      target: { value: "故事完整" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(freezoneAgentConfigMocks.save).toHaveBeenCalledWith({
        kind: "skills",
        payload: expect.objectContaining({
          id: "story-skill",
          description: "故事规则",
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
        description: "社交媒体内容素材制作",
        triggers: { keywords: ["instagram", "tiktok"] },
      },
    ];
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "Freezone Skills" }));

    expect(screen.getByText("social-media")).toBeInTheDocument();
    expect(screen.getByText("社交媒体内容素材制作")).toBeInTheDocument();
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
        name: "公益宣传海报生成",
        enabled: true,
        output_kind: "image",
        action_keys: ["public-welfare-poster-9-16"],
        result_summary: "9:16 竖版公益宣传海报",
      },
      {
        id: "public-welfare-copy",
        name: "公益宣传文案",
        _catalog_source: "user",
        _catalog_base_source: "builtin",
        enabled: true,
        output_kind: "text",
        action_keys: ["public-welfare-copy"],
        result_summary: "温暖感人的公益宣传文案",
      },
    ];
    renderSettingsDialog();

    openRecipesManagement();

    expect(screen.getByText("公益宣传海报生成").closest("article")).toHaveTextContent("Image");
    expect(screen.getByText("公益宣传文案").closest("article")).toHaveTextContent("Text");
    expect(screen.getByText("公益宣传文案").closest("article")).toHaveTextContent("定制");
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
        description: "内置规则",
        triggers: { keywords: ["builtin"] },
      },
      {
        id: "user-skill",
        enabled: true,
        category: "general",
        description: "用户规则",
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
        name: "内置 Skill",
        version: "1.0.0",
        _catalog_source: "builtin",
        enabled: true,
        category: "general",
        description: "内置规则",
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
          planning_notes: "根据用户目标动态规划。",
          conduct_rules: ["保持主体一致。"],
        },
        evaluation: {
          rating_bands: [{ score: 5, description: "结果清晰" }],
          quality_threshold: 4,
          domain_constraints: ["不得改变主体。"],
        },
      },
      {
        id: "customized-skill",
        _catalog_source: "user",
        _catalog_base_source: "builtin",
        enabled: true,
        category: "general",
        description: "用户定制规则",
        triggers: { keywords: ["customized"] },
      },
    ];
    freezoneAgentConfigMocks.save.mockResolvedValue({});
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "Freezone Skills" }));

    expect(screen.getByText("内置 Skill").closest("article")).toHaveTextContent("Built-in");
    expect(screen.getByText("customized-skill").closest("article")).toHaveTextContent("定制");
    expect(screen.queryByText("Customized")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "Toggle 内置 Skill enabled state" }));

    await waitFor(() => {
      expect(freezoneAgentConfigMocks.save).toHaveBeenCalledWith({
        kind: "skills",
        payload: {
          id: "builtin-skill",
          schema_version: "dramaclaw.workflow-skill.v1",
          name: "内置 Skill",
          version: "1.0.0",
          enabled: false,
          category: "general",
          description: "内置规则",
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
            planning_notes: "根据用户目标动态规划。",
            conduct_rules: ["保持主体一致。"],
          },
          evaluation: {
            rating_bands: [{ score: 5, description: "结果清晰" }],
            quality_threshold: 4,
            domain_constraints: ["不得改变主体。"],
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
      target: { value: "故事规则" },
    });

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(freezoneAgentConfigMocks.save).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText("输入关键词"), {
      target: { value: "故事" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText("输入关键词"), { key: "Enter" });

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
          name: "缺字段 Recipe",
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
          name: "半截 Skill",
          enabled: true,
          allowed_recipe_ids: ["loose-recipe"],
          category: "video",
          description: "缺少规划和评估字段",
          triggers: { keywords: ["半截"] },
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
        description: "故事规则",
        category: "general",
      },
      {
        id: "visual-skill",
        description: "视觉规则",
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
        description: "故事规则",
        category: "general",
      },
      {
        id: "visual-skill",
        description: "视觉规则",
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
        description: "故事规则",
        category: "general",
        enabled: true,
        triggers: { keywords: ["故事"] },
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
          description: "故事规则",
          allowed_recipe_ids: ["recipe-a", "recipe-b"],
        },
        {
          id: "visual-skill",
          description: "视觉规则",
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
          description: "故事规则",
          allowed_recipe_ids: ["recipe-a"],
        },
        {
          id: "visual-skill",
          description: "视觉规则",
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
        description: "故事规则",
        category: "general",
        triggers: { keywords: ["故事"], nodeTypes: ["imageGeneration"] },
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
    expect(screen.getByDisplayValue("故事规则")).toBeInTheDocument();
    expect(screen.getAllByText("故事").length).toBeGreaterThan(0);
    expect(screen.getByRole("checkbox", { name: "Image 片生成 imageGeneration" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "View / edit raw JSON (advanced)" }));
    const rawJson = JSON.parse(screen.getByLabelText("Raw JSON").textContent ?? "{}");
    expect(rawJson.planning.default_aspect_ratios).toBeUndefined();
    expect(rawJson.planning.model_preferences).toBeUndefined();
  });

});
