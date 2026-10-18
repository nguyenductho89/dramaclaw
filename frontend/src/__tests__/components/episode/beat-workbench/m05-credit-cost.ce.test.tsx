// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SceneAssetCard } from "@/components/assets/scene-asset-card";
import type { SceneAsset } from "@/types/scene";

const runtimeState = vi.hoisted(() => ({ isCeRuntime: true }));

vi.mock("@/lib/runtime-config", () => ({
  isCeRuntime: () => runtimeState.isCeRuntime,
}));

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    resources: {
      en: {
        translation: {
          assets: {
            common: {
              edit: "Edit",
              delete: "Delete",
              generated: "Ready",
              missing: "Not generated",
            },
            scenes: {
              master: "Master",
              pano: "360 panorama",
              uploadMaster: "Upload master",
              generateMaster: "Generate master",
              regenerateMaster: "Regenerate master",
              deleteMaster: "Delete master",
              reverse: "reverse",
              generateReverse: "Generate reverse",
              regenerateReverse: "Regenerate reverse",
              uploadPano: "Upload/replace 360",
              generatePanoFromText: "Generate 360",
              generatePanoFromMaster: "Generate 360",
              generatePanoFromMasterReverse: "Generate 360",
              deletePano: "Delete 360",
              openPanoViewer: "Open 360 Viewer",
              noMaster: "master.png missing",
              noReverse: "reverse_master.png missing",
              noPano: "pano_360.png missing",
              stage: {
                title: "Director world",
                customWorld: "Custom Director World ready",
                masterWorld: "master Director World ready",
                reverseWorld: "reverse Director World ready",
                panoWorld: "360 Director World ready",
                uploadCustom: "Upload/replace custom package",
                deleteCustom: "Delete custom package",
                masterToPly: "master→Director World",
                reverseToPly: "reverse→Director World",
                panoToPly: "360→Director World",
                singleFaceFeature: "Scene single-face to SOG",
                panoFeature: "Scene panorama to SOG",
                confirmTitle: "Confirm conversion",
                confirmDescription: "{{feature}} will start immediately after confirmation.",
                confirmAction: "Confirm and start",
                openWorld: "Open Director World",
                worldNotReady: "Director World not ready",
              },
            },
          },
        },
      },
    },
    interpolation: { escapeValue: false },
  });
});

function source(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

function renderSceneAssetCard(scene: SceneAsset) {
  render(
    <I18nextProvider i18n={i18n}>
      <SceneAssetCard
        scene={scene}
        masterCost="12 credits"
        reverseCost="12 credits"
        panoCost="12 credits"
        singleFaceStageCost="6 credits"
        panoStageCost="8 credits"
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onUploadMaster={vi.fn()}
        onGenerateMaster={vi.fn()}
        onDeleteMaster={vi.fn()}
        onGenerateReverse={vi.fn()}
        onUploadPano={vi.fn()}
        onGeneratePano={vi.fn()}
        onDeletePano={vi.fn()}
        onOpenPanoViewer={vi.fn()}
        onOpenStageViewer={vi.fn()}
        onOpenFreezone={vi.fn()}
        onUploadCustomPackage={vi.fn()}
        onDeleteCustomPackage={vi.fn()}
        onGenerateStagePly={vi.fn()}
      />
    </I18nextProvider>,
  );
}

describe("M05 CE generation credit cost gating", () => {
  beforeEach(() => {
    runtimeState.isCeRuntime = true;
  });

  it("hides scene image and Director World conversion costs in CE runtime", () => {
    renderSceneAssetCard({
      name: "Palace Hall",
      scene_type: "interior",
      environment_prompt: "Golden palace lanterns, vermilion pillars, deep space",
      description: "",
      aliases: [],
      notes: "",
      master_url: "/static/u/p/assets/scenes/hall/master.png",
      reverse_master_url: "/static/u/p/assets/scenes/hall/reverse_master.png",
      pano_url: "/static/u/p/director_worlds/hall/v1/pano_360.png",
    });

    expect(screen.queryByText("12 credits")).not.toBeInTheDocument();
    expect(screen.queryByText("6 credits")).not.toBeInTheDocument();
    expect(screen.queryByText("8 credits")).not.toBeInTheDocument();
  });

  it("keeps Director World confirmation copy free of credit prices in CE runtime", () => {
    renderSceneAssetCard({
      name: "Palace Hall",
      scene_type: "interior",
      environment_prompt: "Golden palace lanterns, vermilion pillars, deep space",
      description: "",
      aliases: [],
      notes: "",
      master_url: "/static/u/p/assets/scenes/hall/master.png",
    });

    fireEvent.click(screen.getByRole("button", { name: "master→Director World" }));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Scene single-face to SOG will start immediately after confirmation.");
    expect(dialog).not.toHaveTextContent("6 credits");
    expect(dialog).not.toHaveTextContent("Credits");
  });

  it("routes every named M05 cost display through CreditCostInline", () => {
    expect(source("src/components/assets/scene-asset-card.tsx")).toEqual(
      expect.stringMatching(/<CreditCostInline\s+display=\{masterCost\}/),
    );
    expect(source("src/components/assets/scene-asset-card.tsx")).toEqual(
      expect.stringMatching(/<CreditCostInline\s+display=\{reverseCost\}/),
    );
    expect(source("src/components/assets/scene-asset-card.tsx")).toEqual(
      expect.stringMatching(/<CreditCostInline\s+display=\{panoCost\}/),
    );
    expect(source("src/components/assets/scene-asset-card.tsx")).toEqual(
      expect.stringMatching(/<CreditCostInline\s+display=\{singleFaceStageCost\}/),
    );
    expect(source("src/components/assets/scene-asset-card.tsx")).toEqual(
      expect.stringMatching(/<CreditCostInline\s+display=\{panoStageCost\}/),
    );
    expect(source("src/components/assets/scenes-panel.tsx")).toEqual(
      expect.stringContaining("masterCost={sceneReferenceCostDisplay}"),
    );
    expect(source("src/components/assets/scenes-panel.tsx")).toEqual(
      expect.stringContaining("reverseCost={sceneReferenceCostDisplay}"),
    );
    expect(source("src/components/assets/scenes-panel.tsx")).toEqual(
      expect.stringContaining("panoCost={panoCostDisplay}"),
    );
    expect(source("src/components/assets/scenes-panel.tsx")).toEqual(
      expect.stringContaining(
        '"mainline.scene_single_face_to_sog"',
      ),
    );
    expect(source("src/components/assets/scenes-panel.tsx")).toEqual(
      expect.stringContaining('"mainline.scene_pano_to_sog"'),
    );
    expect(source("src/components/assets/scenes-panel.tsx")).toEqual(
      expect.stringContaining("singleFaceStageDisabledReason="),
    );
    expect(source("src/components/assets/scenes-panel.tsx")).toEqual(
      expect.stringContaining("panoStageDisabledReason="),
    );
    expect(source("src/components/assets/scenes-panel.tsx")).toEqual(
      expect.stringContaining('useGenerationCreditCost("feature", "mainline.build_scenes")'),
    );
    expect(source("src/components/assets/scenes-panel.tsx")).toEqual(
      expect.stringContaining("buildScenesCost.error instanceof BillingRuleNotConfiguredError"),
    );
    expect(source("src/components/assets/scenes-panel.tsx")).toEqual(
      expect.stringMatching(/<CreditCostInline\s+display=\{buildScenesCostDisplay\}/),
    );
    expect(source("src/components/episode/beat-workbench/sketch-section.tsx")).toEqual(
      expect.stringContaining("sketchRegenCost.data?.data.display"),
    );
    expect(source("src/components/episode/beat-workbench/render-section.tsx")).toEqual(
      expect.stringContaining("renderRegenCost.data?.data.display"),
    );
    expect(source("src/components/episode/beat-workbench/batch-panel.tsx")).toEqual(
      expect.stringMatching(/<CreditCostInline\s+display=\{sketchPlanCostDisplay\}/),
    );
    expect(source("src/components/episode/beat-workbench/render-plan-dialog.tsx")).toEqual(
      expect.stringMatching(/<CreditCostInline\s+display=\{renderPlanCostDisplay\}/),
    );
    expect(
      source("src/routes/_app/projects.$project/episodes.$episode/beats.lazy.tsx"),
    ).toEqual(
      expect.stringMatching(/<CreditCostInline\s+display=\{sketchPlanCostDisplay\}/),
    );
  });

  it("does not add CE runtime forks to M05 business paths or the cost query hook", () => {
    const businessPaths = [
      "src/components/assets/scene-asset-card.tsx",
      "src/components/assets/scenes-panel.tsx",
      "src/components/episode/beat-workbench/sketch-section.tsx",
      "src/components/episode/beat-workbench/render-section.tsx",
      "src/components/episode/beat-workbench/batch-panel.tsx",
      "src/components/episode/beat-workbench/render-plan-dialog.tsx",
      "src/routes/_app/projects.$project/episodes.$episode/beats.lazy.tsx",
      "src/lib/queries/generation-credit-cost.ts",
    ];

    for (const relativePath of businessPaths) {
      expect(source(relativePath), relativePath).not.toMatch(/\bisCeRuntime\b/);
    }
  });
});
