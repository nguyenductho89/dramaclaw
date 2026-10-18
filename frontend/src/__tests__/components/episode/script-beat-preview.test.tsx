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
  empty: "暂无脚本 beat",
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
    narration_segment: "旁白文案",
    visual_description: "画面一",
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
            narration_segment: "对白文案",
            visual_description: "画面二",
            audio_type: "dialogue",
            speaker: "陈锋_和尚",
          }),
        ]}
      />,
    );

    expect(screen.getByText("Script preview")).toBeInTheDocument();
    expect(screen.getByText("(2 个 Beat)")).toBeInTheDocument();
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText("#2")).toBeInTheDocument();
    expect(screen.getByText("Narration")).toBeInTheDocument();
    expect(screen.getByText("Dialogue")).toBeInTheDocument();
    expect(screen.getByText("No speaker")).toBeInTheDocument();
    expect(screen.getByText("陈锋_和尚")).toBeInTheDocument();
    // Narration beat shows the 旁白台词 label; dialogue beat shows 对白台词.
    expect(screen.getByText("Narration")).toBeInTheDocument();
    expect(screen.getByText("Dialogue")).toBeInTheDocument();
    expect(screen.getByText("旁白文案")).toBeInTheDocument();
    expect(screen.getByText("对白文案")).toBeInTheDocument();
    expect(screen.getAllByText("Visual description")).toHaveLength(2);
    expect(screen.getByText("画面一")).toBeInTheDocument();
    expect(screen.getByText("画面二")).toBeInTheDocument();
  });

  it("shows an empty state when no beats exist", () => {
    render(<ScriptBeatPreview labels={labels} beats={[]} />);

    expect(screen.getByText("Script preview")).toBeInTheDocument();
    expect(screen.getByText("(0 个 Beat)")).toBeInTheDocument();
    expect(screen.getByText("暂无脚本 beat")).toBeInTheDocument();
  });

  it("hides narration for silence, action, and manual beats like NiceGUI", () => {
    render(
      <ScriptBeatPreview
        labels={labels}
        beats={[
          makeBeat({
            beat_number: 1,
            audio_type: "silence",
            narration_segment: "静音不显示",
          }),
          makeBeat({
            beat_number: 2,
            audio_type: "action",
            narration_segment: "动作不显示",
          }),
          makeBeat({
            beat_number: 3,
            is_manual_shot: true,
            narration_segment: "手工镜头不显示",
          }),
        ]}
      />,
    );

    expect(screen.queryByText("静音不显示")).not.toBeInTheDocument();
    expect(screen.queryByText("动作不显示")).not.toBeInTheDocument();
    expect(screen.queryByText("手工镜头不显示")).not.toBeInTheDocument();
    // No spoken-line column (and no speaker badge) for silent/action/manual beats.
    expect(screen.queryAllByText("Dialogue")).toHaveLength(0);
    expect(screen.queryAllByText("Narration")).toHaveLength(0);
  });
});
