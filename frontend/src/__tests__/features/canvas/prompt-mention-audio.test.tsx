// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import {
  PromptMentionEditor,
  mentionChipLabel,
  truncateChipLabel,
  type MentionCandidate,
} from "@/features/canvas/nodes/PromptMentionEditor";

const audioCandidate: MentionCandidate = {
  key: "A",
  name: "audio1",
  imageUrl: "",
  index: 1,
  audioUrl: "/static/projects/p/audio/long-voice-clip-name.mp3",
  displayName: "long-voice-clip-name.mp3",
};

describe("PromptMentionEditor — audio reference chip", () => {
  it("shows a 10-char-capped label but keeps the backend token (@audio1) unchanged", () => {
    const { container } = render(
      <PromptMentionEditor value="@audio1 " onChange={() => {}} candidates={[audioCandidate]} />,
    );
    const chip = container.querySelector(".mention-chip");
    expect(chip).not.toBeNull();
    // Visible label is capped at 10 chars + ellipsis.
    expect(chip?.querySelector(".mention-chip-label")?.textContent).toBe("audio_long…");
    // ...but the serialized token stays the numbered name (what reaches the backend).
    expect(chip?.getAttribute("data-name")).toBe("audio1");
    // Full name remains available in the tooltip.
    expect(chip?.getAttribute("title")).toContain("audio_long-voice-clip-name.mp3");
  });

  it("renders a clickable play control carrying the audio url", () => {
    const { container } = render(
      <PromptMentionEditor value="@audio1 " onChange={() => {}} candidates={[audioCandidate]} />,
    );
    const chip = container.querySelector(".mention-chip");
    expect(chip?.querySelector("[data-audio-play]")).not.toBeNull();
    expect(chip?.getAttribute("data-audio-url")).toBe(
      "/static/projects/p/audio/long-voice-clip-name.mp3",
    );
  });

  it("mentionChipLabel appends filename only for audio; image keeps its base label", () => {
    expect(mentionChipLabel(audioCandidate)).toBe("audio_long-voice-clip-name.mp3");
    expect(
      mentionChipLabel({ key: "I", name: "image2", imageUrl: "x", index: 2 }),
    ).toBe("image");
  });

  it("truncateChipLabel caps at 10 chars and leaves short labels intact", () => {
    expect(truncateChipLabel("audio_long-voice-clip-name.mp3")).toBe("audio_long…");
    expect(truncateChipLabel("audio_a")).toBe("audio_a");
    expect(truncateChipLabel("1234567890")).toBe("1234567890"); // exactly 10, no ellipsis
  });
});
