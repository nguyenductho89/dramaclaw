// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";

import {
  MentionTextarea,
  findMentionTokenAtSelection,
} from "@/components/episode/beat-workbench/mention-textarea";

describe("findMentionTokenAtSelection", () => {
  const text = "See @image1 end"; // @image1 is at [4,11)
  const labels = ["image1", "image2"];

  it("finds the mention token overlapping the double-click selection", () => {
    const hit = findMentionTokenAtSelection(text, labels, 5, 7);
    expect(hit).toEqual({ start: 4, end: 11, label: "image1" });
  });

  it("returns null on plain text", () => {
    expect(findMentionTokenAtSelection(text, labels, 0, 1)).toBeNull();
  });

  it("returns null when no labels are known", () => {
    expect(findMentionTokenAtSelection(text, [], 5, 7)).toBeNull();
  });
});

describe("MentionTextarea - double-click to replace a reference", () => {
  it("double-clicking a mention opens the picker and replaces it in place", () => {
    const onChange = vi.fn();
    const { container, getByRole } = render(
      <MentionTextarea
        value="See @image1 end"
        mentionLabels={["image1", "image2"]}
        onChange={onChange}
      />,
    );

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    textarea.setSelectionRange(5, 7); // the selection lands on @image1
    fireEvent.doubleClick(textarea);

    // The replace-mode picker appears, listing all candidates.
    const listbox = getByRole("listbox");
    expect(listbox).toBeTruthy();

    // Pick "image2" to replace.
    const option = Array.from(listbox.querySelectorAll("button")).find(
      (b) => b.textContent === "image2",
    );
    expect(option).toBeTruthy();
    fireEvent.mouseDown(option as Element);

    expect(onChange).toHaveBeenCalledTimes(1);
    const event = onChange.mock.calls[0][0] as { target: { value: string } };
    expect(event.target.value).toBe("See @image2 end");
  });

  it("does not open the picker when double-clicking plain text", () => {
    const onChange = vi.fn();
    const { container, queryByRole } = render(
      <MentionTextarea
        value="See @image1 end"
        mentionLabels={["image1", "image2"]}
        onChange={onChange}
      />,
    );
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    textarea.setSelectionRange(0, 1); // lands on "S"
    fireEvent.doubleClick(textarea);
    expect(queryByRole("listbox")).toBeNull();
  });
});
