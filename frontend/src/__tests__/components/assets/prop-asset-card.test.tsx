// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { PropAssetCard } from "@/components/assets/prop-asset-card";
import type { PropAsset } from "@/types/prop";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "zh",
    fallbackLng: "zh",
    resources: {
      zh: {
        translation: {
          assets: {
            common: {
              edit: "Edit",
              delete: "Delete",
              generated: "Ready",
              missing: "Not generated",
            },
            props: {
              reference: "Reference image",
              noReference: "Reference image missing",
              noDescription: "No description",
              generateReference: "Generate reference",
              generatingReference: "Generating...",
              regenerateReference: "Regenerate reference",
              owner: "Owner",
              types: {
                weapon: "Weapon",
                accessory: "Accessory",
                artifact: "Artifact",
                document: "Document",
                furniture: "Furniture",
                object: "Other object",
              },
            },
          },
        },
      },
    },
    interpolation: { escapeValue: false },
  });
});

function renderCard(prop: PropAsset, overrides = {}) {
  const handlers = {
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onGenerateReference: vi.fn(),
    onUploadReference: vi.fn(),
    onOpenFreezone: vi.fn(),
    ...overrides,
  };
  render(
    <I18nextProvider i18n={i18n}>
      <PropAssetCard prop={prop} {...handlers} />
    </I18nextProvider>,
  );
  return handlers;
}

describe("PropAssetCard", () => {
  it("renders reference image and generate action", () => {
    const handlers = renderCard({
      name: "七星剑",
      aliases: [],
      prop_type: "weapon",
      visual_prompt: "古铜剑柄，剑身刻七星纹",
      description: "",
      owner: "李青",
      notes: "",
      reference_url: "/static/u/p/assets/props/seven-star-sword/reference.png",
    });

    expect(screen.getByText("七星剑")).toBeInTheDocument();
    expect(screen.getByText("Weapon")).toBeInTheDocument();
    expect(screen.getByText("所属角色：李青")).toBeInTheDocument();
    expect(screen.getByText("参考图 已生成")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate reference" })).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: /Upload/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /删除参考图/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate reference" }));
    expect(handlers.onGenerateReference).toHaveBeenCalledTimes(1);
  });

  it("renders empty reference state", () => {
    renderCard({
      name: "密信",
      aliases: [],
      prop_type: "document",
      visual_prompt: "",
      description: "折叠的牛皮纸密信",
      owner: "",
      notes: "",
    });

    expect(screen.getByText("Reference image missing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate reference" })).toBeInTheDocument();
  });

  it("falls back when a convention URL points at a missing file", () => {
    renderCard({
      name: "密信",
      aliases: [],
      prop_type: "document",
      visual_prompt: "",
      description: "折叠的牛皮纸密信",
      owner: "",
      notes: "",
      reference_url: "/static/projects/demo/assets/props/密信/reference_3view.png",
    });

    fireEvent.error(screen.getByAltText("密信 参考图"));

    expect(screen.getByText("Reference image missing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate reference" })).toBeInTheDocument();
  });

  it("retries the convention URL after an upload finishes", () => {
    const prop: PropAsset = {
      name: "密信",
      aliases: [],
      prop_type: "document",
      visual_prompt: "",
      description: "折叠的牛皮纸密信",
      owner: "",
      notes: "",
      reference_url: "/static/projects/demo/assets/props/密信/reference_3view.png",
    };
    const handlers = {
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onGenerateReference: vi.fn(),
      onUploadReference: vi.fn(),
      onOpenFreezone: vi.fn(),
    };
    const view = render(
      <I18nextProvider i18n={i18n}>
        <PropAssetCard prop={prop} uploading {...handlers} />
      </I18nextProvider>,
    );

    fireEvent.error(screen.getByAltText("密信 参考图"));
    expect(screen.getByText("Reference image missing")).toBeInTheDocument();

    view.rerender(
      <I18nextProvider i18n={i18n}>
        <PropAssetCard prop={prop} uploading={false} {...handlers} />
      </I18nextProvider>,
    );

    expect(screen.getByAltText("密信 参考图")).toBeInTheDocument();
  });

  it("renders NiceGUI prop type labels instead of raw prop type codes", () => {
    renderCard({
      name: "TOKEN",
      aliases: [],
      prop_type: "artifact",
      visual_prompt: "红色数字、二进制代码和方块粒子构成的发光团",
      description: "",
      owner: "",
      notes: "",
    });

    expect(screen.getByText("Artifact")).toBeInTheDocument();
    expect(screen.queryByText("artifact")).not.toBeInTheDocument();
  });

  it("renders the NiceGUI visible action row", () => {
    renderCard({
      name: "TOKEN",
      aliases: [],
      prop_type: "artifact",
      visual_prompt: "红色数字、二进制代码和方块粒子构成的发光团",
      description: "",
      owner: "",
      notes: "",
    });

    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate reference" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("opens a reference image preview from the card image", () => {
    renderCard({
      name: "七星剑",
      aliases: [],
      prop_type: "weapon",
      visual_prompt: "古铜剑柄，剑身刻七星纹",
      description: "",
      owner: "",
      notes: "",
      reference_url: "/static/u/p/assets/props/seven-star-sword/reference.png",
    });

    fireEvent.click(screen.getByRole("button", { name: "七星剑 参考图" }));

    expect(
      screen.getByRole("link", { name: "Download image" }),
    ).toBeInTheDocument();
    expect(screen.getAllByAltText("七星剑 参考图")).toHaveLength(2);
  });

  it("shows the NiceGUI generating label for single prop reference generation", () => {
    renderCard(
      {
        name: "七星剑",
        aliases: [],
        prop_type: "weapon",
        visual_prompt: "古铜剑柄，剑身刻七星纹",
        description: "",
        owner: "",
        notes: "",
        reference_url: "/static/u/p/assets/props/seven-star-sword/reference.png",
      },
      { generating: true },
    );

    expect(screen.getByRole("button", { name: "Generating..." })).toBeDisabled();
  });

  it("renders the NiceGUI empty description fallback", () => {
    renderCard({
      name: "TOKEN",
      aliases: [],
      prop_type: "artifact",
      visual_prompt: "",
      description: "",
      owner: "",
      notes: "",
    });

    expect(screen.getByText("No description")).toBeInTheDocument();
  });
});
