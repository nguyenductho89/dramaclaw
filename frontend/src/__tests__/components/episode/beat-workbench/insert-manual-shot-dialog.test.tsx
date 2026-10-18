// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ReactNode } from "react";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    resources: {
      en: {
        translation: {
          common: { cancel: "Cancel", error: "Errors" },
          episode: {
            workbench: {
              insertManual: {
                titleBeforeFirst: "Insert manual shot before first beat",
                titleAfter: "Insert manual shot after beat {{n}}",
                audioType: "Shot type",
                audioTypeSilence: "Silent",
                audioTypeNarration: "Narration",
                audioTypeDialogue: "Dialogue",
                narration: "Line / narration",
                narrationPlaceholder: "Enter the dialogue or narration to speak",
                narrationRequired: "Enter dialogue or narration",
                silentHint: "Silent shots do not generate audio",
                speaker: "Speaker",
                speakerPlaceholder: "Select or enter speaker identity",
                speakerRequired: "Select a speaker",
                narrator: "Narrator",
                projectNarrator: "Project narrator",
                visualDescription: "Visual description",
                visualPlaceholder: "Describe what the camera should show in one sentence",
                visualRequired: "Visual description is required",
                type: "Type",
                typeManual: "Manual",
                location: "Scene",
                sceneVariant: "Variant",
                noSceneVariant: "No variant",
                locationPlaceholder: "Select scene",
                locationNone: "(none)",
                timeOfDay: "Time",
                timeOfDayPlaceholder: "Select time",
                timeOfDayNone: "(none)",
                duration: "Duration (s)",
                identities: "Identities",
                identitiesPlaceholder:
                  "Comma-separated (e.g. {{example}}); leave blank to auto-detect from visual description",
                identitiesPlaceholderEmpty:
                  "Comma-separated identity IDs; leave blank to auto-detect",
                props: "Props",
                propsPlaceholder:
                  "Comma-separated (e.g. {{example}}); leave blank to auto-detect from visual description",
                propsPlaceholderEmpty:
                  "Comma-separated prop IDs; leave blank to auto-detect",
                submit: "Insert",
                success: "Manual shot inserted",
              },
            },
          },
        },
      },
    },
  });
});

const insertMutateAsync: Mock = vi
  .fn()
  .mockResolvedValue({ ok: true, data: null });

interface TestSceneMenuItem {
  scene_id: string;
  base_scene_id?: string;
  variant_id?: string;
  time_of_day?: string;
}

const queryState: {
  beats: Array<{
    beat_number: number;
    narration_segment: string;
    visual_description: string;
    scene_ref: { scene_id: string; variant_id?: string };
    time_of_day: string;
    estimated_duration: number;
    audio_type: string;
    detected_identities: string[];
    detected_props: string[];
    set_description: string;
  }>;
  episode: {
    number: number;
    title: string;
    identity_ids: string[];
    scene_menu: TestSceneMenuItem[];
    prop_menu: { prop_id: string }[];
  };
} = {
  beats: [
    {
      beat_number: 1,
      narration_segment: "Narration",
      visual_description: "Original shot",
      scene_ref: { scene_id: "Warehouse_night" },
      time_of_day: "night",
      estimated_duration: 4,
      audio_type: "narration",
      detected_identities: [],
      detected_props: [],
      set_description:
        '{"scene_description":"old set scene","props_description":"old set props"}',
    },
  ],
  episode: {
    number: 1,
    title: "ep1",
    identity_ids: ["Lu Chen"],
    scene_menu: [{ scene_id: "Warehouse_night" }],
    prop_menu: [{ prop_id: "jade pendant" }],
  },
};

vi.mock("@/lib/queries/episodes", () => ({
  useEpisodeBeats: () => ({
    data: { ok: true, data: queryState.beats },
  }),
  useEpisodeDetail: () => ({
    data: { ok: true, data: queryState.episode },
  }),
  useInsertManualShot: () => ({
    mutateAsync: insertMutateAsync,
    isPending: false,
  }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { InsertManualShotDialog } from "@/components/episode/beat-workbench/insert-manual-shot-dialog";

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  insertMutateAsync.mockClear();
  insertMutateAsync.mockResolvedValue({ ok: true, data: null });
  queryState.beats = [
    {
      beat_number: 1,
      narration_segment: "Narration",
      visual_description: "Original shot",
      scene_ref: { scene_id: "Warehouse_night" },
      time_of_day: "night",
      estimated_duration: 4,
      audio_type: "narration",
      detected_identities: [],
      detected_props: [],
      set_description:
        '{"scene_description":"old set scene","props_description":"old set props"}',
    },
  ];
  queryState.episode = {
    number: 1,
    title: "ep1",
    identity_ids: ["Lu Chen"],
    scene_menu: [{ scene_id: "Warehouse_night" }],
    prop_menu: [{ prop_id: "jade pendant" }],
  };
});

describe("InsertManualShotDialog", () => {
  it("uses v2 scene fields and hides legacy staging editors", () => {
    render(
      <Wrapper>
        <InsertManualShotDialog
          open
          onOpenChange={vi.fn()}
          project="demo"
          episode={1}
          afterBeatNumber={1}
        />
      </Wrapper>,
    );

    expect(screen.getByText("Visual description")).toBeInTheDocument();
    expect(screen.getByText("Silent")).toBeInTheDocument();
    expect(screen.getByText("Narration")).toBeInTheDocument();
    expect(screen.getByText("Dialogue")).toBeInTheDocument();
    expect(screen.getByText("Scene")).toBeInTheDocument();
    expect(screen.queryByText("Video prompt")).not.toBeInTheDocument();
    expect(screen.queryByText(/Set dressing/)).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("old set scene")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("old set props")).not.toBeInTheDocument();
  });

  it("submits an empty manual beat container by default", () => {
    render(
      <Wrapper>
        <InsertManualShotDialog
          open
          onOpenChange={vi.fn()}
          project="demo"
          episode={1}
          afterBeatNumber={1}
        />
      </Wrapper>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Insert" }));

    expect(insertMutateAsync).toHaveBeenCalledTimes(1);
    expect(insertMutateAsync.mock.calls[0][0]).toMatchObject({
      after_beat_number: 1,
      audio_type: "silence",
      narration_segment: null,
      speaker: null,
      visual_description: "\u200B",
      duration_seconds: 3,
      scene_ref: null,
      time_of_day: null,
      detected_identities: null,
      detected_props: null,
    });
    expect(insertMutateAsync.mock.calls[0][0]).not.toHaveProperty(
      "set_description",
    );
  });

  it("submits narration metadata when narration type is selected", () => {
    render(
      <Wrapper>
        <InsertManualShotDialog
          open
          onOpenChange={vi.fn()}
          project="demo"
          episode={1}
          spineTemplate="narrated"
          afterBeatNumber={1}
        />
      </Wrapper>,
    );

    fireEvent.change(
      screen.getByPlaceholderText("Describe what the camera should show in one sentence"),
      { target: { value: "Empty shot at the warehouse door" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Narration" }));
    fireEvent.change(screen.getByPlaceholderText("Enter the dialogue or narration to speak"), {
      target: { value: "The footsteps outside the door are getting closer." },
    });

    expect(screen.getByText("Narrator")).toBeInTheDocument();
    expect(screen.getByText("Project narrator")).toBeInTheDocument();
    expect(screen.queryByText("Speaker")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Insert" }));

    expect(insertMutateAsync).toHaveBeenCalledTimes(1);
    expect(insertMutateAsync.mock.calls[0][0]).toMatchObject({
      audio_type: "narration",
      narration_segment: "The footsteps outside the door are getting closer.",
      speaker: null,
      visual_description: "Empty shot at the warehouse door",
    });
  });

  it("submits canonical base and variant from split scene controls", async () => {
    const user = userEvent.setup();
    queryState.episode.scene_menu = [
      { scene_id: "Bathroom", base_scene_id: "", variant_id: "", time_of_day: "" },
      {
        scene_id: "Bathroom_leak",
        base_scene_id: "Bathroom",
        variant_id: "leak",
        time_of_day: "",
      },
      {
        scene_id: "Bathroom_leak_night",
        base_scene_id: "Bathroom",
        variant_id: "leak",
        time_of_day: "night",
      },
    ];
    render(
      <Wrapper>
        <InsertManualShotDialog
          open
          onOpenChange={vi.fn()}
          project="demo"
          episode={1}
          afterBeatNumber={1}
        />
      </Wrapper>,
    );

    await user.click(screen.getByRole("combobox", { name: "Scene" }));
    await user.click(await screen.findByRole("option", { name: "Bathroom" }));
    await user.click(screen.getByRole("combobox", { name: "Variant" }));
    await user.click(await screen.findByRole("option", { name: "leak" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));

    expect(insertMutateAsync).toHaveBeenCalledTimes(1);
    expect(insertMutateAsync.mock.calls[0][0]).toMatchObject({
      scene_ref: { scene_id: "Bathroom", variant_id: "leak" },
    });
  });

  it("does not show narrator speaker semantics for drama narration", () => {
    render(
      <Wrapper>
        <InsertManualShotDialog
          open
          onOpenChange={vi.fn()}
          project="demo"
          episode={1}
          afterBeatNumber={1}
        />
      </Wrapper>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Narration" }));

    expect(screen.queryByText("Narrator")).not.toBeInTheDocument();
    expect(screen.queryByText("Project narrator")).not.toBeInTheDocument();
    expect(screen.queryByText("Speaker")).not.toBeInTheDocument();
  });

  it("does not show or submit speaker for drama dialogue", () => {
    render(
      <Wrapper>
        <InsertManualShotDialog
          open
          onOpenChange={vi.fn()}
          project="demo"
          episode={1}
          afterBeatNumber={1}
        />
      </Wrapper>,
    );

    fireEvent.change(
      screen.getByPlaceholderText("Describe what the camera should show in one sentence"),
      { target: { value: "Lu Chen turns around at the warehouse door" } },
    );
    fireEvent.click(screen.getByText("Dialogue"));
    fireEvent.change(screen.getByPlaceholderText("Enter the dialogue or narration to speak"), {
      target: { value: "Don't look back." },
    });

    expect(screen.queryByText("Speaker")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Insert" }));

    expect(insertMutateAsync).toHaveBeenCalledTimes(1);
    expect(insertMutateAsync.mock.calls[0][0]).toMatchObject({
      audio_type: "dialogue",
      narration_segment: "Don't look back.",
      speaker: null,
      visual_description: "Lu Chen turns around at the warehouse door",
    });
  });

  it("submits dialogue metadata when dialogue type is selected", async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <InsertManualShotDialog
          open
          onOpenChange={vi.fn()}
          project="demo"
          episode={1}
          spineTemplate="narrated"
          afterBeatNumber={1}
        />
      </Wrapper>,
    );

    fireEvent.change(
      screen.getByPlaceholderText("Describe what the camera should show in one sentence"),
      { target: { value: "Lu Chen turns around at the warehouse door" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Silent" }));
    fireEvent.click(screen.getByText("Dialogue"));
    fireEvent.change(screen.getByPlaceholderText("Enter the dialogue or narration to speak"), {
      target: { value: "Don't look back." },
    });
    await user.click(screen.getByRole("combobox", { name: "Speaker" }));
    await user.click(await screen.findByRole("option", { name: "Lu Chen" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));

    expect(insertMutateAsync).toHaveBeenCalledTimes(1);
    expect(insertMutateAsync.mock.calls[0][0]).toMatchObject({
      audio_type: "dialogue",
      narration_segment: "Don't look back.",
      speaker: "Lu Chen",
      visual_description: "Lu Chen turns around at the warehouse door",
    });
  });

  it("converts @ mentions and submits detected identity and prop references", () => {
    render(
      <Wrapper>
        <InsertManualShotDialog
          open
          onOpenChange={vi.fn()}
          project="demo"
          episode={1}
          afterBeatNumber={1}
        />
      </Wrapper>,
    );

    fireEvent.change(
      screen.getByPlaceholderText("Describe what the camera should show in one sentence"),
      { target: { value: "@Lu Chen picks up @jade pendant" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));

    expect(insertMutateAsync).toHaveBeenCalledTimes(1);
    expect(insertMutateAsync.mock.calls[0][0]).toMatchObject({
      visual_description: "{{Lu Chen}} picks up [[jade pendant]]",
      detected_identities: ["Lu Chen"],
      detected_props: ["jade pendant"],
    });
  });

  it("fills identity and prop fields from visual @ mentions", () => {
    render(
      <Wrapper>
        <InsertManualShotDialog
          open
          onOpenChange={vi.fn()}
          project="demo"
          episode={1}
          afterBeatNumber={1}
        />
      </Wrapper>,
    );

    fireEvent.change(
      screen.getByPlaceholderText("Describe what the camera should show in one sentence"),
      { target: { value: "@Lu Chen picks up @jade pendant" } },
    );

    expect(screen.getByDisplayValue("Lu Chen")).toBeInTheDocument();
    expect(screen.getByDisplayValue("jade pendant")).toBeInTheDocument();
  });
});
