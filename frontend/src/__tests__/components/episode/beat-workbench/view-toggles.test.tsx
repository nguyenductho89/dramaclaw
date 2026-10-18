// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ViewToggles } from "@/components/episode/beat-workbench/view-toggles";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    resources: {
      en: {
        translation: {
          episode: {
            beat: {
              sectionSketch: "Sketch",
              sectionRender: "Render",
            },
            workbench: {
              view: {
                selectAll: "Select all",
                selectedCount: "{{count}} selected",
                clear: "Clear",
                totalShots: "{{count}} shots",
                activeBeat: "Beat {{n}}",
                selectionHint: "Select beats to batch regen sketches and renders",
                batchRegenSketch: "Regen Sketch",
                batchRegenRender: "Regen Render",
              },
            },
          },
        },
      },
    },
  });
});

describe("ViewToggles", () => {
  it("removes select all while keeping selected count and clear action", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const onClearSelection = vi.fn();
    const onBatchRegenSketch = vi.fn();
    const onBatchRegenRender = vi.fn();

    render(
      <I18nextProvider i18n={i18n}>
        <ViewToggles
          toggles={new Set(["sketch", "render"])}
          onToggle={onToggle}
          selection={{ mode: "multi", checked: new Set([1]) }}
          totalBeats={3}
          onClearSelection={onClearSelection}
          onBatchRegenSketch={onBatchRegenSketch}
          onBatchRegenRender={onBatchRegenRender}
        />
      </I18nextProvider>,
    );

    expect(screen.queryByRole("button", { name: "Select all" })).not.toBeInTheDocument();
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regen Sketch" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regen Render" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Regen Sketch" }));
    await user.click(screen.getByRole("button", { name: "Regen Render" }));

    expect(onBatchRegenSketch).toHaveBeenCalledTimes(1);
    expect(onBatchRegenRender).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Clear" }));

    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });

  it("shows the selection hint when no beat is checked", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ViewToggles
          toggles={new Set(["sketch", "render"])}
          onToggle={vi.fn()}
          selection={{ mode: "none" }}
          totalBeats={3}
          onClearSelection={vi.fn()}
          onBatchRegenSketch={vi.fn()}
          onBatchRegenRender={vi.fn()}
        />
      </I18nextProvider>,
    );

    expect(screen.getByText("Select beats to batch regen sketches and renders")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Regen Sketch" })).not.toBeInTheDocument();
  });

  it("keeps redraw actions hidden for single-beat selection", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ViewToggles
          toggles={new Set(["sketch", "render"])}
          onToggle={vi.fn()}
          selection={{ mode: "single", beatNum: 1 }}
          totalBeats={3}
          onClearSelection={vi.fn()}
          onBatchRegenSketch={vi.fn()}
          onBatchRegenRender={vi.fn()}
        />
      </I18nextProvider>,
    );

    expect(screen.getByText("Select beats to batch regen sketches and renders")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Regen Sketch" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Regen Render" })).not.toBeInTheDocument();
  });
});
