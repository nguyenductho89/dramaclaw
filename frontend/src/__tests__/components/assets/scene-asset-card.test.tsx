// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { SceneAssetCard } from "@/components/assets/scene-asset-card";
import type { SceneAsset } from "@/types/scene";

import { zhTranslation } from "../../helpers/i18n-fixtures";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "zh",
    fallbackLng: "zh",
    resources: { zh: { translation: zhTranslation } },
    interpolation: { escapeValue: false },
  });
});

function renderCard(scene: SceneAsset, overrides = {}) {
  const handlers = {
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onUploadMaster: vi.fn(),
    onGenerateMaster: vi.fn(),
    onDeleteMaster: vi.fn(),
    onGenerateReverse: vi.fn(),
    onUploadPano: vi.fn(),
    onGeneratePano: vi.fn(),
    onDeletePano: vi.fn(),
    onOpenPanoViewer: vi.fn(),
    onOpenStageViewer: vi.fn(),
    onOpenFreezone: vi.fn(),
    onUploadCustomPackage: vi.fn(),
    onDeleteCustomPackage: vi.fn(),
    onGenerateStagePly: vi.fn(),
    singleFaceStageCost: "6",
    panoStageCost: "8",
    ...overrides,
  };
  render(
    <I18nextProvider i18n={i18n}>
      <SceneAssetCard scene={scene} {...handlers} />
    </I18nextProvider>,
  );
  return handlers;
}

describe("SceneAssetCard", () => {
  it("renders master, 360, and active Director World controls", () => {
    const handlers = renderCard({
      name: "皇宫大殿",
      scene_type: "interior",
      environment_prompt: "金色宫灯、朱红立柱、纵深空间",
      description: "",
      aliases: [],
      notes: "",
      master_url: "/static/u/p/assets/scenes/hall/master.png",
      reverse_master_url: "/static/u/p/assets/scenes/hall/reverse_master.png",
      pano_url: "/static/u/p/director_worlds/hall/v1/pano_360.png",
      stage_3gs: {
        stage_dir: "/tmp/director_worlds/hall/v1",
        manifest_ready: true,
        source: "custom_scene",
        active_source: "custom",
        active: {
          ready: true,
          path: "/tmp/director_worlds/hall/v1/custom.sog",
          url: "/static/u/p/director_worlds/hall/v1/custom.sog",
          size_bytes: 1048576,
          size_mb: 1,
        },
        custom: {
          ready: true,
          path: "/tmp/director_worlds/hall/v1/custom.sog",
          url: "/static/u/p/director_worlds/hall/v1/custom.sog",
          size_bytes: 1048576,
          size_mb: 1,
        },
        master: {
          ready: true,
          path: "/tmp/director_worlds/hall/v1/master_sharp.ply",
          url: "/static/u/p/director_worlds/hall/v1/master_sharp.ply",
          size_bytes: 2048,
          size_mb: 0,
        },
        reverse: {
          ready: false,
          path: "",
          url: "",
          size_bytes: 0,
          size_mb: 0,
        },
        pano: {
          ready: true,
          path: "/tmp/director_worlds/hall/v1/pano_depth.ply",
          url: "/static/u/p/director_worlds/hall/v1/pano_depth.ply",
          size_bytes: 4096,
          size_mb: 0,
        },
      },
    });

    expect(screen.getByText("皇宫大殿")).toBeInTheDocument();
    expect(screen.getByText("Master")).toBeInTheDocument();
    expect(screen.getByText("Back")).toBeInTheDocument();
    expect(screen.getByText("360 panorama")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload master" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate master" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate reverse" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload/replace 360" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate 360" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete 360" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open 360 Viewer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Director World" })).toBeInTheDocument();
    expect(screen.getByText("Director world")).toBeInTheDocument();
    expect(screen.queryByText(/当前导演世界/)).not.toBeInTheDocument();
    expect(screen.getByText("Custom Director World ready")).toBeInTheDocument();
    expect(screen.getByText("master Director World ready")).toBeInTheDocument();
    expect(screen.getByText("360 Director World ready")).toBeInTheDocument();
    expect(screen.queryByText("/tmp/director_worlds/hall/v1")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload/replace custom package" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete custom package" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "master→Director World" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "reverse→Director World" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "360→Director World" })).toBeInTheDocument();
    expect(screen.queryByText(/voxel/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/DirectorStage/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate reverse" }));
    expect(handlers.onGenerateReverse).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Generate 360" }));
    expect(handlers.onGeneratePano).toHaveBeenCalledWith("master");

    fireEvent.click(screen.getByRole("button", { name: "Delete 360" }));
    expect(handlers.onDeletePano).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Open 360 Viewer" }));
    expect(handlers.onOpenPanoViewer).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Open Director World" }));
    expect(handlers.onOpenStageViewer).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "master→Director World" }));
    expect(handlers.onGenerateStagePly).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "场景单面转 SOG will start immediately after confirmation.",
    );
    expect(screen.getByRole("alertdialog")).toHaveTextContent("6");
    fireEvent.click(screen.getByRole("button", { name: "Confirm and start" }));
    expect(handlers.onGenerateStagePly).toHaveBeenCalledWith("master");

    fireEvent.click(screen.getByRole("button", { name: "360→Director World" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "场景全景转 SOG will start immediately after confirmation.",
    );
    expect(screen.getByRole("alertdialog")).toHaveTextContent("8");
    fireEvent.click(screen.getByRole("button", { name: "Confirm and start" }));
    expect(handlers.onGenerateStagePly).toHaveBeenCalledWith("pano");
  });

  it("disables Director World conversion when the organization price is unavailable", () => {
    renderCard(
      {
        name: "皇宫大殿",
        scene_type: "interior",
        environment_prompt: "",
        description: "",
        aliases: [],
        notes: "",
        master_url: "/static/master.png",
        reverse_master_url: "/static/reverse.png",
        pano_url: "/static/pano.png",
      },
      {
        singleFaceStageCost: "Configure",
        singleFaceStageDisabledReason: "Billing rule is not configured. Please contact an administrator to set credit pricing.",
        panoStageCost: "Configure",
        panoStageDisabledReason: "Billing rule is not configured. Please contact an administrator to set credit pricing.",
      },
    );

    expect(screen.getByRole("button", { name: "master→Director World" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "reverse→Director World" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "360→Director World" })).toBeDisabled();
  });

  it("falls back to text-to-360 when master is missing", () => {
    const handlers = renderCard({
      name: "雨夜巷口",
      scene_type: "exterior",
      environment_prompt: "",
      description: "潮湿的巷口和霓虹灯",
      aliases: [],
      notes: "",
    });

    expect(screen.getByText("master.png missing")).toBeInTheDocument();
    expect(screen.getByText("reverse_master.png missing")).toBeInTheDocument();
    expect(screen.getByText("pano_360.png missing")).toBeInTheDocument();
    const generate = screen.getByRole("button", { name: "Generate 360" });
    fireEvent.click(generate);
    expect(handlers.onGeneratePano).toHaveBeenCalledWith("text");
  });

  it("allows opening Director World even when no scene source exists yet", () => {
    const handlers = renderCard({
      name: "公寓楼家门口",
      scene_type: "exterior",
      environment_prompt: "",
      description: "",
      aliases: [],
      notes: "",
    });

    expect(screen.queryByText(/当前导演世界/)).not.toBeInTheDocument();
    expect(screen.queryByText("Director World not ready")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open Director World" }));
    expect(handlers.onOpenStageViewer).toHaveBeenCalledOnce();
  });

  it("renders scene type badges in Chinese", () => {
    renderCard({
      name: "雨夜巷口",
      scene_type: "exterior",
      environment_prompt: "",
      description: "",
      aliases: [],
      notes: "",
    });

    expect(screen.getByText("Exterior")).toBeInTheDocument();
    expect(screen.queryByText("exterior")).not.toBeInTheDocument();
  });
});
