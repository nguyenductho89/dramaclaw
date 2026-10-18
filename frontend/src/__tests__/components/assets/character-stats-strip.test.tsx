// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "characters.stats.strip.total": "Total",
        "characters.stats.strip.mainCharacter": "Narrator lead",
        "characters.stats.strip.identity": "Identity",
        "characters.stats.strip.voice": "Voice",
        "characters.stats.strip.ariaLabel": "Character stats",
      })[key] ?? key,
  }),
}));

import {
  CharacterStatsStrip,
  deriveCharacterStats,
} from "@/components/assets/character-stats-strip";
import type { Character } from "@/types/character";

const characters: Character[] = [
  {
    name: "Mira",
    role: "Lead",
    is_main: true,
    portrait_url: "/static/demo/mira/portrait.png",
    reference_audio_path: "assets/characters/Mira/voice.wav",
  },
  {
    name: "Jun",
    role: "Supporting",
    portrait_path: "assets/characters/Jun/portrait.png",
    reference_audio_path: "",
  },
  {
    name: "Lio",
    role: "Scout",
    portrait_url: "",
    reference_audio_url: "/static/demo/lio/voice.wav",
  },
];

describe("deriveCharacterStats", () => {
  it("counts main characters, identities, and ready voice paths", () => {
    expect(deriveCharacterStats(characters, { Mira: 2, Jun: 1 })).toEqual({
      total: 3,
      mainCharacters: 1,
      identityReady: 2,
      voiceReady: 1,
    });
  });

  it("defaults identity ready to zero when identityCounts is omitted", () => {
    expect(deriveCharacterStats(characters).identityReady).toBe(0);
  });

  it("uses list-projected identity ids when explicit counts are omitted", () => {
    expect(
      deriveCharacterStats([
        { name: "Mira", identity_ids: ["Mira_default"] },
        { name: "Jun", identity_ids: [] },
      ]).identityReady,
    ).toBe(1);
  });
});

describe("CharacterStatsStrip", () => {
  it("renders a compact responsive stats strip with accessible stat labels", () => {
    render(
      <CharacterStatsStrip
        characters={characters}
        identityCounts={{ Mira: 2, Jun: 1 }}
        className="custom-strip"
      />,
    );

    const strip = screen.getByRole("list", { name: "Character stats" });
    expect(strip).toHaveClass("custom-strip");
    expect(strip).toHaveTextContent("总角色3");
    expect(strip).toHaveTextContent("解说主角1");
    expect(strip).not.toHaveTextContent("Portrait");
    expect(strip).toHaveTextContent("身份2/3");
    expect(strip).toHaveTextContent("声线1/3");

    expect(screen.getByLabelText("总角色: 3")).toBeInTheDocument();
    expect(screen.getByLabelText("声线: 1/3")).toBeInTheDocument();
  });

  it("uses the supplied main character label for drama projects", () => {
    render(
      <CharacterStatsStrip
        characters={characters}
        mainCharacterLabel="Lead"
      />,
    );

    expect(screen.getByLabelText("主角: 1")).toBeInTheDocument();
    expect(screen.queryByLabelText("解说主角: 1")).not.toBeInTheDocument();
  });
});
