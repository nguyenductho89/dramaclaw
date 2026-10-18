// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { SketchStudioActions } from "@/components/episode/beat-workbench/sketch-studio-actions";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "zh",
    fallbackLng: "zh",
    interpolation: { escapeValue: false },
    resources: {
      zh: {
        translation: {
          common: {
            cancel: "Cancel",
            confirmExecute: "Confirm execution",
            error: "Errors",
          },
          episode: {
            workbench: {
              batch: {
                aiDetect: "AI detect",
                aiDetectTooltip: "AI detect",
                aiDetectRunning: "AI detecting characters...",
                aiDetectEmpty: "AI returned no detections",
                aiDetectSuccess:
                  "AI detect complete: {{beats}} beats, {{ids}} identities, {{props}} props",
                reassignColors: "Reassign colors",
                reassignColorsTooltip: "Reassign colors",
                reassignColorsTitle: "Reassign sketch colors?",
                reassignColorsDesc: "Reassign sketch colors?",
                reassignColorsSuccess:
                  "Assigned {{count}} identities, {{propCount}} props",
              },
              sketch: {
                identityColors: "Identity",
                propColors: "Prop",
                aiDetectResults: "AI results",
                aiDetectResultCounts:
                  "{{beats}} beats / {{identities}} identities / {{props}} props",
                openGridGallery: "Sketch grid",
              },
              renderGrid: {
                title: "Render Grid",
              },
            },
          },
        },
      },
    },
  });
});

vi.mock("@/lib/queries/scripts", () => ({
  useScript: () => ({
    data: {
      ok: true,
      data: {
        sketch_colors: {
          "Hero_Main": "#ff0000 RED",
        },
      },
    },
  }),
}));

vi.mock("@/lib/queries/characters", () => ({
  useCharacters: () => ({
    data: [{ name: "Hero" }],
  }),
}));

vi.mock("@/lib/queries/episodes", () => ({
  useEpisodeBeats: () => ({
    data: {
      ok: true,
      data: [
        {
          beat_number: 1,
          detected_identities: ["Hero_Main"],
          detected_props: ["jade_sword"],
        },
        {
          beat_number: 2,
          detected_identities: ["Hero_Main", "Villain_Main"],
          detected_props: [],
        },
      ],
    },
  }),
  useEpisodeDetail: () => ({
    data: {
      ok: true,
      data: {
        number: 1,
        title: "ep1",
        prop_menu: [
          {
            prop_id: "jade_sword",
            marker_color: "#00ff00 GREEN",
            description: "Jade sword",
          },
        ],
      },
    },
  }),
}));

describe("SketchStudioActions", () => {
  it("does not expose the removed scene sketch gallery command", async () => {
    const user = userEvent.setup();
    const openSceneGallery = vi.fn();
    const openGridGallery = vi.fn();

    render(
      <I18nextProvider i18n={i18n}>
        <SketchStudioActions
          project="demo"
          episode={1}
          onOpenGridGallery={openGridGallery}
        />
      </I18nextProvider>,
    );

    expect(screen.queryByRole("button", { name: /Scene sketch gallery|openSceneGallery/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sketch grid" }));

    expect(openSceneGallery).not.toHaveBeenCalled();
    expect(openGridGallery).toHaveBeenCalledTimes(1);
  });


  it("hides sketch and render grid gallery actions when grid galleries are disabled", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <SketchStudioActions
          project="demo"
          episode={1}
          onOpenGridGallery={vi.fn()}
          onOpenRenderGridGallery={vi.fn()}
          showGridGalleryActions={false}
        />
      </I18nextProvider>,
    );

    expect(screen.queryByRole("button", { name: "Sketch grid" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Render Grid" })).not.toBeInTheDocument();
  });

  it("shows identity and prop color legend entries", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <SketchStudioActions project="demo" episode={1} />
      </I18nextProvider>,
    );

    expect(screen.getByText("Identity")).toBeInTheDocument();
    expect(screen.getByText(/Hero/)).toBeInTheDocument();
    expect(screen.getByText("Main")).toBeInTheDocument();
    expect(screen.getByText("Prop")).toBeInTheDocument();
    expect(screen.getByText("jade_sword")).toBeInTheDocument();
  });

  it("shows a visible AI detection result summary from beat detections", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <SketchStudioActions project="demo" episode={1} />
      </I18nextProvider>,
    );

    expect(screen.getByText("AI results")).toBeInTheDocument();
    expect(screen.getByText("2 beats / 2 identities / 1 props")).toBeInTheDocument();
  });

  it("does not render AI tool actions after they move to the top batch toolbar", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <SketchStudioActions project="demo" episode={1} />
      </I18nextProvider>,
    );

    expect(screen.queryByRole("button", { name: "AI detect" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reassign colors" })).not.toBeInTheDocument();
  });
});
