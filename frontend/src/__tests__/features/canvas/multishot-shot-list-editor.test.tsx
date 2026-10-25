// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MultishotShotListEditor } from "@/features/canvas/nodes/multishot/MultishotShotListEditor";
import type { VideoMultishotShot } from "@/features/canvas/domain/canvasNodes";

const TWO_SHOTS: VideoMultishotShot[] = [
  { id: "s1", description: "A red phone rings on the table" },
  { id: "s2", description: "She picks it up and frowns" },
];

describe("MultishotShotListEditor", () => {
  it("renders one textarea per shot with its description", () => {
    render(<MultishotShotListEditor shots={TWO_SHOTS} onChange={vi.fn()} />);
    expect(screen.getByDisplayValue("A red phone rings on the table")).toBeInTheDocument();
    expect(screen.getByDisplayValue("She picks it up and frowns")).toBeInTheDocument();
  });

  it("labels the first row as the start frame, not Shot 1", () => {
    render(<MultishotShotListEditor shots={TWO_SHOTS} onChange={vi.fn()} />);
    expect(screen.getByText("Start frame")).toBeInTheDocument();
    expect(screen.getByText("Shot 2")).toBeInTheDocument();
  });

  it("editing a shot's text clears its stale review state and reports the full array", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const shots: VideoMultishotShot[] = [
      { id: "s1", description: "old text", finalPrompt: "[Shot 1] old rewritten prompt" },
      TWO_SHOTS[1],
    ];
    render(<MultishotShotListEditor shots={shots} onChange={onChange} />);

    await user.type(screen.getByDisplayValue("old text"), "!");

    expect(onChange).toHaveBeenCalled();
    const calls = onChange.mock.calls;
    const lastCall = calls[calls.length - 1][0] as VideoMultishotShot[];
    expect(lastCall).toHaveLength(2);
    expect(lastCall[0].description).toBe("old text!");
    // Stale AI-rewritten prompt/lint must not survive an edit to the raw
    // description — the review dialog would otherwise show a prompt that
    // no longer matches what the user actually typed.
    expect(lastCall[0].finalPrompt).toBeNull();
    expect(lastCall[1]).toBe(TWO_SHOTS[1]);
  });

  it("adds a new empty shot, capped at maxShots", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<MultishotShotListEditor shots={TWO_SHOTS} maxShots={2} onChange={onChange} />);

    const addButton = screen.getByRole("button", { name: "Add shot" });
    expect(addButton).toBeDisabled();
    await user.click(addButton);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("adds a shot when under the cap", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<MultishotShotListEditor shots={TWO_SHOTS} maxShots={8} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Add shot" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as VideoMultishotShot[];
    expect(next).toHaveLength(3);
    expect(next[2].description).toBe("");
  });

  it("does not allow removing below minShots", () => {
    const onChange = vi.fn();
    render(<MultishotShotListEditor shots={TWO_SHOTS} minShots={2} onChange={onChange} />);

    const removeButtons = screen.getAllByTitle("Remove shot");
    expect(removeButtons).toHaveLength(2);
    for (const button of removeButtons) {
      expect(button).toBeDisabled();
    }
  });

  it("removes a shot when above minShots", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const threeShots: VideoMultishotShot[] = [
      ...TWO_SHOTS,
      { id: "s3", description: "A third shot" },
    ];
    render(<MultishotShotListEditor shots={threeShots} minShots={2} onChange={onChange} />);

    const removeButtons = screen.getAllByTitle("Remove shot");
    await user.click(removeButtons[0]);

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as VideoMultishotShot[];
    expect(next.map((s) => s.id)).toEqual(["s2", "s3"]);
  });

  it("reorders shots with the move up/down buttons", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const threeShots: VideoMultishotShot[] = [
      { id: "s1", description: "first" },
      { id: "s2", description: "second" },
      { id: "s3", description: "third" },
    ];
    render(<MultishotShotListEditor shots={threeShots} onChange={onChange} />);

    const downButtons = screen.getAllByTitle("Move down");
    await user.click(downButtons[0]); // move shot s1 down past s2

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as VideoMultishotShot[];
    expect(next.map((s) => s.id)).toEqual(["s2", "s1", "s3"]);
  });

  it("cannot move the first shot up or the last shot down", () => {
    const threeShots: VideoMultishotShot[] = [
      { id: "s1", description: "first" },
      { id: "s2", description: "second" },
      { id: "s3", description: "third" },
    ];
    render(<MultishotShotListEditor shots={threeShots} onChange={vi.fn()} />);

    const upButtons = screen.getAllByTitle("Move up");
    const downButtons = screen.getAllByTitle("Move down");
    expect(upButtons[0]).toBeDisabled();
    expect(downButtons[downButtons.length - 1]).toBeDisabled();
  });

  it("shows the minShots warning when fewer than minShots are filled in", () => {
    render(
      <MultishotShotListEditor
        shots={[{ id: "s1", description: "only one filled" }, { id: "s2", description: "" }]}
        minShots={2}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("At least 2 shots with text are required")).toBeInTheDocument();
  });

  it("shows the total duration based on filled shots and seconds per shot", () => {
    render(<MultishotShotListEditor shots={TWO_SHOTS} shotSeconds={5.17} onChange={vi.fn()} />);
    expect(screen.getByText("2 shots × 10.3s")).toBeInTheDocument();
  });
});
