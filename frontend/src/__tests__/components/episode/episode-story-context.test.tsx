// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EpisodeStoryContext } from "@/components/episode/episode-story-context";

const labels = {
  summary: "Story summary",
  noSummary: "No summary",
  keyEvents: "Key events",
  noKeyEvents: "No key events yet",
  cliffhanger: "Cliffhanger",
  noCliffhanger: "No cliffhanger",
};

describe("EpisodeStoryContext", () => {
  it("renders episode summary, key events, and cliffhanger as read-only context", () => {
    render(
      <EpisodeStoryContext
        contentSummary="Qin enters the royal city on a rainy night."
        keyEvents={["enters the palace", "meets an old friend"]}
        cliffhanger="A familiar voice comes from behind the city gate."
        labels={labels}
      />,
    );

    expect(screen.getByText("Story summary")).toBeInTheDocument();
    expect(screen.getByText("Qin enters the royal city on a rainy night.")).toBeInTheDocument();
    expect(screen.getByText("Key events")).toBeInTheDocument();
    expect(screen.getByText("enters the palace")).toBeInTheDocument();
    expect(screen.getByText("meets an old friend")).toBeInTheDocument();
    expect(screen.getByText("Cliffhanger")).toBeInTheDocument();
    expect(screen.getByText("A familiar voice comes from behind the city gate.")).toBeInTheDocument();
  });

  it("shows explicit empty states when episode planning fields are absent", () => {
    render(
      <EpisodeStoryContext
        contentSummary=""
        keyEvents={[]}
        cliffhanger=""
        labels={labels}
      />,
    );

    expect(screen.getByText("No summary")).toBeInTheDocument();
    expect(screen.getByText("No key events yet")).toBeInTheDocument();
    expect(screen.getByText("No cliffhanger")).toBeInTheDocument();
  });
});
