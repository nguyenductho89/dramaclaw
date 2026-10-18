// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EpisodeSourceEditor } from "@/components/episode/episode-source-editor";

const labels = {
  rawLabel: "Original text",
  rawActionLabel: "View source",
  noRawText: "No original text",
  sourceLabel: "Beat source text",
  sourceMeta: (count: number) => `Edits auto-save, ${count} lines total`,
  sourcePlaceholder: "Enter the beat source text",
  linePreviewLabel: "Line split preview",
  lineCount: (count: number) => `${count} lines`,
  noLines: "No generated lines yet",
};

describe("EpisodeSourceEditor", () => {
  it("opens raw content in a dialog and saves edited beat source text on blur", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EpisodeSourceEditor
        rawContent="Chapter one original text"
        sourceText="old beat source text"
        labels={labels}
        onSave={onSave}
      />,
    );

    expect(screen.queryByText("Chapter one original text")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View source" }));
    expect(screen.getByText("Chapter one original text")).toBeInTheDocument();

    const source = screen.getByLabelText("Beat source text 1");
    expect(source).toHaveValue("old beat source text");

    fireEvent.change(source, { target: { value: "new beat source text" } });
    fireEvent.blur(source);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith("new beat source text"));
  });

  it("edits source text as one input per generated line", () => {
    render(
      <EpisodeSourceEditor
        rawContent=""
        sourceText={" First line\n\nSecond line \r\n Third line "}
        labels={labels}
        onSave={vi.fn()}
      />,
    );

    expect(
      screen.getByText("(Edits are saved automatically, 3 lines in total)"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Beat source text 1")).toHaveValue("First line");
    expect(screen.getByLabelText("Beat source text 2")).toHaveValue("Second line");
    expect(screen.getByLabelText("Beat source text 3")).toHaveValue("Third line");
  });

  it("splits pasted multiline text into editable lines and saves normalized text", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EpisodeSourceEditor
        rawContent=""
        sourceText="First line"
        labels={labels}
        onSave={onSave}
      />,
    );

    const source = screen.getByLabelText("Beat source text 1");
    fireEvent.change(source, { target: { value: "Rewritten first line\nRewritten second line" } });
    expect(screen.getByLabelText("Beat source text 1")).toHaveValue("Rewritten first line");
    expect(screen.getByLabelText("Beat source text 2")).toHaveValue("Rewritten second line");

    fireEvent.blur(screen.getByLabelText("Beat source text 2"));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith("Rewritten first line\nRewritten second line"),
    );
  });
});
