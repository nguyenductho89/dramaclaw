// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useState } from "react";

import { MentionTextarea } from "@/components/episode/beat-workbench/mention-textarea";

function ControlledMentionTextarea() {
  const [value, setValue] = useState("");
  return (
    <MentionTextarea
      aria-label="Visual description"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      mentionLabels={["Lu Chen_young_adult", "Sheepskin notebook"]}
    />
  );
}

describe("MentionTextarea", () => {
  it("opens candidates after @ and inserts the selected mention", () => {
    render(<ControlledMentionTextarea />);

    const textarea = screen.getByRole("textbox", { name: "Visual description" });
    fireEvent.change(textarea, {
      target: { value: "@", selectionStart: 1, selectionEnd: 1 },
    });

    const option = screen.getByRole("option", { name: "Lu Chen_young_adult" });
    fireEvent.mouseDown(option);

    expect(screen.getByDisplayValue("@Lu Chen_young_adult")).toBeInTheDocument();
  });

  it("confirms the highlighted candidate when pressing space", () => {
    render(<ControlledMentionTextarea />);

    const textarea = screen.getByRole("textbox", {
      name: "Visual description",
    }) as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: "@", selectionStart: 1, selectionEnd: 1 },
    });
    expect(
      screen.getByRole("option", { name: "Lu Chen_young_adult" }),
    ).toBeInTheDocument();

    fireEvent.keyDown(textarea, { key: " " });

    // Space confirms the first candidate and leaves a trailing separator.
    expect(textarea.value).toBe("@Lu Chen_young_adult ");
  });

  it("adds a separator when typing after a complete mention", () => {
    render(<ControlledMentionTextarea />);

    const textarea = screen.getByRole("textbox", {
      name: "Visual description",
    }) as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: {
        value: "@Lu Chen_young_adultapproaches",
        selectionStart: 21,
        selectionEnd: 21,
      },
    });

    expect(textarea.value).toBe("@Lu Chen_young_adult approaches");
  });

  it("does not hijack space while an IME is composing", () => {
    render(<ControlledMentionTextarea />);

    const textarea = screen.getByRole("textbox", {
      name: "Visual description",
    }) as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: "@", selectionStart: 1, selectionEnd: 1 },
    });

    fireEvent.keyDown(textarea, { key: " ", isComposing: true });

    // The picker is left untouched so the input method keeps the space.
    expect(textarea.value).toBe("@");
  });
});
