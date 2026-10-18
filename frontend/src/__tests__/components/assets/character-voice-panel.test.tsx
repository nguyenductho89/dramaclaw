// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import ky from "ky";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
  uploadApi: ky.create({ baseUrl: "http://localhost:3000/" }),
}));

import { CharacterVoicePanel } from "@/components/assets/character-voice-panel";
import type { Character } from "@/types/character";

const server = setupServer();
const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "zh",
    fallbackLng: "zh",
    resources: {
      zh: {
        translation: {
          characters: {
            voiceSamples: {
              title: "Voice samples (IndexTTS2)",
              hint: "Usually upload only the default voice. Override age slots only when variants need a different sound.",
              defaultRequired: "Default (required)",
              ageDefaultRequired: "{{age}} (default · required)",
              optionalOverride: "{{age}} (optional override)",
              missingDefault: "Not configured -> this character cannot speak",
              inheritedDefault: "-> inherits default",
              missing: "Not configured",
              upload: "Upload voice sample",
              record: "Record",
              trim: "Trim to 3-5 seconds",
              clear: "Clear",
              loading: "Loading voice samples",
              loadFailed: "Failed to load voice samples",
              currentDuration: "Current: about {{seconds}} seconds",
            },
            ageGroups: {
              child: "Child",
              young: "Young adult",
              middle: "Middle-aged",
              elder: "Elder",
            },
          },
          common: {
            error: "Errors",
          },
        },
      },
    },
    interpolation: { escapeValue: false },
  });
  server.listen();
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </I18nextProvider>
  );
}

function renderPanel(character: Character) {
  return render(
    <CharacterVoicePanel project="demo" character={character} />,
    { wrapper },
  );
}

describe("CharacterVoicePanel", () => {
  it("renders default and age voice slots with inherited status and actions", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/characters/Qin/voice-samples",
        () =>
          HttpResponse.json({
            ok: true,
            data: {
              character: "Qin",
              slots: [
                {
                  slot: "default",
                  label: "default (fallback)",
                  path: "assets/characters/Qin/voices/voice_default.wav",
                  url: "/static/admin/demo/assets/characters/Qin/voices/voice_default.wav",
                  sha256: "sha-default",
                  updated_at: "2026-05-13T00:00:00+00:00",
                  inherited_from_default: false,
                  required: true,
                },
                {
                  slot: "child",
                  label: "Child",
                  path: "",
                  url: "",
                  sha256: "",
                  updated_at: "",
                  inherited_from_default: true,
                  required: false,
                },
                {
                  slot: "youth",
                  label: "Young adult",
                  path: "",
                  url: "",
                  sha256: "",
                  updated_at: "",
                  inherited_from_default: true,
                  required: false,
                },
                {
                  slot: "middle",
                  label: "Middle-aged",
                  path: "",
                  url: "",
                  sha256: "",
                  updated_at: "",
                  inherited_from_default: true,
                  required: false,
                },
                {
                  slot: "elder",
                  label: "Elder",
                  path: "assets/characters/Qin/voices/voice_elder.wav",
                  url: "/static/admin/demo/assets/characters/Qin/voices/voice_elder.wav",
                  sha256: "sha-elder",
                  updated_at: "2026-05-13T00:00:01+00:00",
                  inherited_from_default: false,
                  required: false,
                },
              ],
            },
          }),
      ),
    );

    const { container } = renderPanel({ name: "Qin", age_group: "youth" });

    expect(await screen.findByText("Voice samples (IndexTTS2)")).toBeInTheDocument();
    expect(await screen.findByText("Young adult (default · required)")).toBeInTheDocument();
    expect(screen.getByText("Child (optional override)")).toBeInTheDocument();
    expect(screen.getAllByText("-> inherits default").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("voice_elder.wav")).toHaveAttribute(
      "title",
      "assets/characters/Qin/voices/voice_elder.wav",
    );
    expect(screen.getAllByRole("button", { name: "Upload voice sample" })).toHaveLength(4);
    expect(screen.getAllByRole("button", { name: "Record" })).toHaveLength(4);
    expect(screen.getAllByRole("button", { name: "Trim to 3-5 seconds" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Clear" })).toHaveLength(2);

    const audio = await waitFor(() => {
      const el = container.querySelector("audio");
      expect(el).not.toBeNull();
      return el as HTMLAudioElement;
    });
    Object.defineProperty(audio, "duration", { value: 6.5, configurable: true });
    fireEvent.loadedMetadata(audio);
    expect(await screen.findByText("Current: about 6.5 seconds")).toBeInTheDocument();
  });

  it("warns when the default voice is missing", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/characters/Qin/voice-samples",
        () =>
          HttpResponse.json({
            ok: true,
            data: {
              character: "Qin",
              slots: [
                {
                  slot: "default",
                  label: "default (fallback)",
                  path: "",
                  url: "",
                  sha256: "",
                  updated_at: "",
                  inherited_from_default: false,
                  required: true,
                },
              ],
            },
          }),
      ),
    );

    renderPanel({ name: "Qin" });

    await waitFor(() =>
      expect(screen.getByText("Not configured -> this character cannot speak")).toBeInTheDocument(),
    );
  });

  it("shows an error instead of crashing when the voice API returns ok false", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/characters/Qin/voice-samples",
        () =>
          HttpResponse.json({
            ok: false,
            error: "Character 'Qin' not found",
          }),
      ),
    );

    renderPanel({ name: "Qin" });

    expect(await screen.findByText("Failed to read voice samples")).toBeInTheDocument();
  });
});
