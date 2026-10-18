// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { NarratorVoicePanel } from "@/components/assets/narrator-voice-panel";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "zh",
    fallbackLng: "zh",
    interpolation: { escapeValue: false },
    resources: {
      zh: {
        translation: {
          common: { cancel: "Cancel", error: "Errors" },
          episode: {
            workbench: {
              video: {
                seedance2Ready: "Configured",
                narratorVoice: "Narrator voice",
                narratorVoiceMissing: "Voice missing",
                narratorVoiceMissingDetail: "Third-person project narrator voice is not configured",
                narratorVoiceUpload: "Upload",
                narratorVoiceRecord: "Record",
                narratorVoiceProjectAudio: "Project audio",
                narratorVoiceTrim: "Crop",
                narratorVoiceDelete: "Delete",
                narratorVoiceTrimTitle: "Trim narrator voice",
                narratorVoiceTrimHint: "Seedance 2.0 works best with a clear 3-5 second single-speaker reference.",
                narratorVoiceTrimStart: "Start second",
                narratorVoiceTrimDuration: "Duration",
                narratorVoiceTrimApply: "Trim to 3-5 seconds",
                narratorVoiceTrimInvalid: "Invalid trim values",
                narratorVoiceTrimmed: "Narrator voice trimmed",
              },
            },
          },
        },
      },
    },
  });
});

const mutateTrim = vi.hoisted(() => vi.fn());
let mockHasVoice = false;

vi.mock("@/lib/queries/video", () => ({
  useNarratorVoiceStatus: () => ({
    data: {
      ok: true,
      data: {
        narration_style: "first_person",
        source: "protagonist_identity",
        reference_path: mockHasVoice ? "assets/narrator/voice.mp3" : "",
        reference_url: mockHasVoice ? "/static/demo/assets/narrator/voice.mp3" : "",
        heading: "First-person narrator voice",
        detail: "",
        explanation: "第一人称解说使用主角声线。",
        is_first_person: true,
      },
    },
    isLoading: false,
    isError: false,
  }),
  useNarratorVoiceSources: () => ({ data: { ok: true, data: { options: [] } } }),
  useUploadNarratorVoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRecordNarratorVoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCopyProjectNarratorVoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTrimNarratorVoice: () => ({ mutateAsync: mutateTrim, isPending: false }),
  useDeleteNarratorVoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

function renderPanel(allowFirstPersonProjectVoice = false) {
  render(
    <I18nextProvider i18n={i18n}>
      <NarratorVoicePanel
        project="demo"
        allowFirstPersonProjectVoice={allowFirstPersonProjectVoice}
      />
    </I18nextProvider>,
  );
}

describe("NarratorVoicePanel", () => {
  beforeEach(() => {
    mockHasVoice = false;
    mutateTrim.mockReset();
    mutateTrim.mockResolvedValue({
      ok: true,
      data: {
        reference_path: "assets/narrator/voice.mp3",
      },
    });
  });

  it("hides project narrator upload actions for first-person projects by default", () => {
    renderPanel(false);

    expect(screen.queryByRole("button", { name: "Upload" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Project audio" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Crop" })).not.toBeInTheDocument();
  });

  it("allows project narrator upload actions when first-person project voice is explicitly enabled", () => {
    renderPanel(true);

    expect(screen.getByRole("button", { name: "Upload" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Project audio" })).toBeInTheDocument();
  });

  it("trims configured narrator voice from the assets voice panel", async () => {
    mockHasVoice = true;
    const user = userEvent.setup();
    renderPanel(true);

    await user.click(screen.getByRole("button", { name: "Crop" }));

    expect(screen.getByRole("dialog", { name: "Trim narrator voice" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Trim to 3-5 seconds" }));

    expect(mutateTrim).toHaveBeenCalledWith({
      startSeconds: 0,
      durationSeconds: 4,
    });
  });
});
