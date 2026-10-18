// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ScriptBeatPreview } from "@/components/episode/script-beat-preview";
import type { Beat } from "@/types/episode";

const labels = {
  title: "Script preview",
  count: (count: number) => `${count} Beats`,
  loading: "Loading script...",
  emptyTitle: "No script yet",
  empty: "No script beats",
  audioType: (type: string) =>
    ({
      narration: "Narration",
      dialogue: "Dialogue",
      silence: "Silent shot",
      action: "Action shot",
    })[type] ?? type,
  speaker: "Speaker",
  noSpeaker: "No speaker",
  dialogueLine: "Dialogue",
  narrationLine: "Narration",
  noNarration: "No lines",
  visualDescription: "Visual description",
  noVisualDescription: "No visual description",
};

function makeBeat(overrides: Partial<Beat>): Beat {
  return {
    beat_number: 1,
    narration_segment: "Narration text",
    visual_description: "Visual one",
    audio_type: "narration",
    speaker: "",
    ...overrides,
  };
}

describe("ScriptBeatPreview", () => {
  it("renders each beat with audio type, speaker, dialogue/narration line, and visual description", () => {
    render(
      <ScriptBeatPreview
        labels={labels}
        beats={[
          makeBeat({ beat_number: 1 }),
          makeBeat({
            beat_number: 2,
            narration_segment: "Dialogue text",
            visual_description: "Visual two",
            audio_type: "dialogue",
            speaker: "Chen Feng_monk",
          }),
        ]}
      />,
    );

    expect(screen.getByText("Script preview")).toBeInTheDocument();
    expect(screen.getByText("(2 Beats)")).toBeInTheDocument();
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText("#2")).toBeInTheDocument();
    expect(screen.getByText("Narration")).toBeInTheDocument();
    expect(screen.getByText("Dialogue")).toBeInTheDocument();
    expect(screen.getByText("No speaker")).toBeInTheDocument();
    expect(screen.getByText("Chen Feng_monk")).toBeInTheDocument();
    // The narration beat shows the narration text label; the dialogue beat shows the dialogue text label.
    expect(screen.getByText("Narration")).toBeInTheDocument();
    expect(screen.getByText("Dialogue")).toBeInTheDocument();
    expect(screen.getByText("Narration text")).toBeInTheDocument();
    expect(screen.getByText("Dialogue text")).toBeInTheDocument();
    expect(screen.getAllByText("Visual description")).toHaveLength(2);
    expect(screen.getByText("Visual one")).toBeInTheDocument();
    expect(screen.getByText("Visual two")).toBeInTheDocument();
  });

  it("shows an empty state when no beats exist", () => {
    render(<ScriptBeatPreview labels={labels} beats={[]} />);

    expect(screen.getByText("Script preview")).toBeInTheDocument();
    expect(screen.getByText("(0 Beats)")).toBeInTheDocument();
    expect(screen.getByText("No script beats")).toBeInTheDocument();
  });

  it("hides narration for silence, action, and manual beats like NiceGUI", () => {
    render(
      <ScriptBeatPreview
        labels={labels}
        beats={[
          makeBeat({
            beat_number: 1,
            audio_type: "silence",
            narration_segment: "Silent not shown",
          }),
          makeBeat({
            beat_number: 2,
            audio_type: "action",
            narration_segment: "Action not shown",
          }),
          makeBeat({
            beat_number: 3,
            is_manual_shot: true,
            narration_segment: "Manual shot not shown",
          }),
        ]}
      />,
    );

    expect(screen.queryByText("Silent not shown")).not.toBeInTheDocument();
    expect(screen.queryByText("Action not shown")).not.toBeInTheDocument();
    expect(screen.queryByText("Manual shot not shown")).not.toBeInTheDocument();
    // No spoken-line column (and no speaker badge) for silent/action/manual beats.
    expect(screen.queryAllByText("Dialogue")).toHaveLength(0);
    expect(screen.queryAllByText("Narration")).toHaveLength(0);
  });
});
