// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { AudioPane } from "@/components/episode/beat-workbench/audio-pane";
import type { Beat } from "@/types/episode";

const i18n = i18next.createInstance();
const mutateRegenerate = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const audioPrereqErrors = vi.hoisted(() => ({ current: [] as string[] }));

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    resources: {
      en: {
        translation: {
          common: {
            cancel: "Cancel",
            confirm: "Confirm",
            error: "Errors",
            regenerate: "Regenerate",
          },
          episode: {
            workbench: {
              audio: {
                narrationEmpty: "Narration is empty — this beat cannot generate audio. Fill in text first.",
                generating: "Generating...",
                genFailed: "Generation failed",
                notGenerated: "Not generated",
                regenTitle: "Regenerate audio?",
                regenDesc: "Regenerate TTS voiceover for Beat #{{n}}.",
                regenerated: "Beat #{{n}} regenerated",
                regenFailed: "Regen failed",
                configureVoiceAction: "Configure",
                prereqHintCharacters: ". Go to Characters to upload the narrator voice.",
                prereqHintVoices: ". Go to Assets > Voices to upload or trim a default narrator voice.",
              },
              video: {
                seedance2Ready: "Configured",
                narratorVoice: "Narrator voice",
                narratorVoiceMissing: "Voice missing",
                narratorVoiceLoading: "Loading narrator voice",
                narratorVoiceLoadFailed: "Failed to load narrator voice",
                narratorVoiceMissingDetail: "Third-person project narrator voice is not configured",
                narratorVoiceUpload: "Upload",
                narratorVoiceRecord: "Record",
                narratorVoiceProjectAudio: "Project audio",
                narratorVoiceDelete: "Delete",
              },
            },
          },
        },
      },
    },
  });
});

vi.mock("@/lib/queries/audio", () => ({
  useAudioBillingQuote: () => ({
    data: {
      ok: true,
      data: { display: "", prereq_errors: audioPrereqErrors.current },
    },
  }),
  useRegenerateBeatAudio: () => ({
    mutateAsync: mutateRegenerate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/use-task-controller", () => ({
  useTaskController: () => ({
    started: false,
    start: vi.fn(),
  }),
}));

vi.mock("@/lib/queries/video", () => ({
  useNarratorVoiceStatus: () => ({
    data: {
      ok: true,
      data: {
        narration_style: "third_person",
        source: "project_narrator",
        reference_path: "",
        reference_url: "",
        heading: "Third-person project narration voice",
        detail: "",
        explanation: "Third-person narration uses the project-level voice.",
        is_first_person: false,
      },
    },
    isLoading: false,
    isError: false,
  }),
  useNarratorVoiceSources: () => ({
    data: { ok: true, data: { options: [] } },
    isLoading: false,
    isError: false,
  }),
  useUploadNarratorVoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRecordNarratorVoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCopyProjectNarratorVoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteNarratorVoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("sonner", () => ({
  toast: { error: toastError, success: vi.fn() },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

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

function makeBeat(overrides: Partial<Beat> = {}): Beat {
  return {
    beat_number: 1,
    narration_segment: "A voice-over sounds.",
    visual_description: "Empty corridor",
    audio_type: "narration",
    audio_url: "",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  audioPrereqErrors.current = [];
  mutateRegenerate.mockResolvedValue({
    ok: true,
    scope: "ep001:beat_01:__narrator__",
  });
});

describe("AudioPane", () => {
  it("uses quote prerequisite errors to avoid submitting an invalid audio task", async () => {
    audioPrereqErrors.current = [
      "Beat 01 narrator voice missing: the project narrator voice is configured but its voice file cannot be read, re-upload it or check project storage",
    ];
    const user = userEvent.setup();

    render(
      <Wrapper>
        <AudioPane
          beat={makeBeat()}
          project="demo"
          episode={1}
          state="missing"
          spineTemplate="narrated"
        />
      </Wrapper>,
    );

    await user.click(screen.getByRole("button", { name: "Configure" }));

    expect(mutateRegenerate).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Confirm" })).not.toBeInTheDocument();
    expect(toastError).toHaveBeenCalledWith(
      "Beat 01 narrator voice missing: the project narrator voice is configured but its voice file cannot be read, re-upload it or check project storage. Go to Assets > Voices to upload or trim a default narrator voice.",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Configure" }),
      }),
    );
  });

  it("keeps beat voice upload and project narrator voice controls out of drama narration", () => {
    render(
      <Wrapper>
        <AudioPane
          beat={makeBeat()}
          project="demo"
          episode={1}
          state="missing"
          spineTemplate="drama"
        />
      </Wrapper>,
    );

    expect(screen.queryByText("This beat's narration audio")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload beat audio" })).not.toBeInTheDocument();
    expect(screen.queryByText("Narrator voice")).not.toBeInTheDocument();
  });

  it("hides beat upload and project narrator voice controls for narrated project narration", () => {
    render(
      <Wrapper>
        <AudioPane
          beat={makeBeat()}
          project="demo"
          episode={1}
          state="missing"
          spineTemplate="narrated"
        />
      </Wrapper>,
    );

    expect(screen.queryByText("This beat's narration audio")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload beat audio" })).not.toBeInTheDocument();
    expect(screen.queryByText("Narrator voice")).not.toBeInTheDocument();
  });

  it("keeps voice controls out of the audio pane when narration text is empty", () => {
    render(
      <Wrapper>
        <AudioPane
          beat={makeBeat({ narration_segment: "" })}
          project="demo"
          episode={1}
          state="missing"
          spineTemplate="narrated"
        />
      </Wrapper>,
    );

    expect(screen.getByText("Narration is empty — this beat cannot generate audio. Fill in text first.")).toBeInTheDocument();
    expect(screen.queryByText("This beat's narration audio")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload beat audio" })).not.toBeInTheDocument();
    expect(screen.queryByText("Narrator voice")).not.toBeInTheDocument();
  });

  it("does not expose beat voice upload when audio_type is blank narration", () => {
    render(
      <Wrapper>
        <AudioPane
          beat={makeBeat({ audio_type: "" })}
          project="demo"
          episode={1}
          state="missing"
          spineTemplate="drama"
        />
      </Wrapper>,
    );

    expect(screen.queryByText("This beat's narration audio")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload beat audio" })).not.toBeInTheDocument();
    expect(screen.queryByText("Narrator voice")).not.toBeInTheDocument();
  });

  it("offers a jump to project voice assets when beat audio generation lacks default narrator voice", async () => {
    mutateRegenerate.mockResolvedValueOnce({
      ok: false,
      code: "voice_prereq_required",
      error: "Beat 01 narrator voice missing: the project narrator voice is not configured, upload or record narrator audio",
    });
    const user = userEvent.setup();

    render(
      <Wrapper>
        <AudioPane
          beat={makeBeat()}
          project="demo"
          episode={1}
          state="missing"
          spineTemplate="narrated"
        />
      </Wrapper>,
    );

    await user.click(screen.getByRole("button", { name: "Regenerate" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(toastError).toHaveBeenCalledWith(
      "Beat 01 narrator voice missing: the project narrator voice is not configured, upload or record narrator audio. Go to Assets > Voices to upload or trim a default narrator voice.",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Configure" }),
      }),
    );

    const action = toastError.mock.calls[0][1].action as { onClick: () => void };
    action.onClick();

    expect(window.localStorage.getItem("supertale-asset-tab:demo")).toBe("voices");
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/projects/$project/characters",
      params: { project: "demo" },
    });
  });

  it("offers a jump to characters when first-person narrator protagonist voice is missing", async () => {
    mutateRegenerate.mockResolvedValueOnce({
      ok: false,
      code: "voice_prereq_required",
      error: "Beat 01 narrator voice missing: the narrator protagonist voice is missing, upload a character voice in the character workbench",
    });
    const user = userEvent.setup();

    render(
      <Wrapper>
        <AudioPane
          beat={makeBeat()}
          project="demo project"
          episode={1}
          state="missing"
          spineTemplate="narrated"
        />
      </Wrapper>,
    );

    await user.click(screen.getByRole("button", { name: "Regenerate" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(toastError).toHaveBeenCalledWith(
      "Beat 01 narrator voice missing: the narrator protagonist voice is missing, upload a character voice in the character workbench. Go to Characters to upload the narrator voice.",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Configure" }),
      }),
    );

    const action = toastError.mock.calls[0][1].action as { onClick: () => void };
    action.onClick();

    expect(window.localStorage.getItem("supertale-asset-tab:demo%20project")).toBe("characters");
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/projects/$project/characters",
      params: { project: "demo project" },
    });
  });

  it("keeps regular regeneration errors as plain toasts", async () => {
    mutateRegenerate.mockResolvedValueOnce({
      ok: false,
      error: "TTS service is temporarily unavailable",
    });
    const user = userEvent.setup();

    render(
      <Wrapper>
        <AudioPane
          beat={makeBeat()}
          project="demo"
          episode={1}
          state="missing"
          spineTemplate="narrated"
        />
      </Wrapper>,
    );

    await user.click(screen.getByRole("button", { name: "Regenerate" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(toastError).toHaveBeenCalledWith(
      "TTS service is temporarily unavailable",
    );
  });
});
