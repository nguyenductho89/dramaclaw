// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  PromptMentionEditor,
  type MentionCandidate,
} from "@/features/canvas/nodes/PromptMentionEditor";

// jsdom does not implement scrollIntoView (used by the ref callback of the popover's highlighted row).
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
});

const candidates: MentionCandidate[] = [
  { key: "A", name: "image1", imageUrl: "https://example.com/a.png", index: 1 },
  { key: "B", name: "image2", imageUrl: "https://example.com/b.png", index: 2 },
];

describe("PromptMentionEditor — double-click to replace a reference", () => {
  it("double-clicking a chip opens the candidate popover anchored at it", () => {
    const { container } = render(
      <PromptMentionEditor
        value="@image1 "
        onChange={() => {}}
        candidates={candidates}
      />,
    );

    const chip = container.querySelector(".mention-chip");
    expect(chip).not.toBeNull();
    // There is no popover initially.
    expect(screen.queryByText("@image2")).toBeNull();

    fireEvent.doubleClick(chip as Element);

    // The popover appears, and the right side shows the actual serialized token, avoiding every asset type showing as @1.
    expect(screen.getByText("@image1")).toBeTruthy();
    expect(screen.getByText("@image2")).toBeTruthy();
  });

  it("picking a different candidate replaces the chip in place (serialized to @image2)", () => {
    const onChange = vi.fn();
    const { container } = render(
      <PromptMentionEditor
        value="@image1 "
        onChange={onChange}
        candidates={candidates}
      />,
    );

    fireEvent.doubleClick(container.querySelector(".mention-chip") as Element);

    // Pick the "@image2" row (candidate image2).
    const row = screen.getByText("@image2").closest("button");
    expect(row).not.toBeNull();
    fireEvent.mouseDown(row as Element);

    // After serialization the reference changes from image1 to image2 (the text sent to the backend still carries the number).
    expect(onChange).toHaveBeenCalledWith("@image2 ");
    // After replacement there is still just one chip, pointing to the new resource B.
    const chips = container.querySelectorAll(".mention-chip");
    expect(chips.length).toBe(1);
    expect((chips[0] as HTMLElement).dataset.mention).toBe("B");
  });

  it("does not open the popover when there are no candidates", () => {
    const { container } = render(
      <PromptMentionEditor value="@image1 " onChange={() => {}} candidates={[]} />,
    );
    // With no candidates rebuildDOM builds no chip (the list is empty); double-clicking empty content neither errors nor opens a popover.
    const chip = container.querySelector(".mention-chip");
    // There is no chip to double-click — just confirm the popover copy does not exist.
    expect(chip).toBeNull();
    expect(screen.queryByText("Referenced")).toBeNull();
  });

  it("distinguishes text and image tokens that both use per-kind index one", () => {
    const mixedCandidates: MentionCandidate[] = [
      { key: "T", name: "text1", imageUrl: "", index: 1, displayName: "Web copy" },
      { key: "I", name: "image1", imageUrl: "https://example.com/image.png", index: 1 },
    ];
    const { container } = render(
      <PromptMentionEditor
        value="@text1 "
        onChange={() => {}}
        candidates={mixedCandidates}
      />,
    );

    fireEvent.doubleClick(container.querySelector(".mention-chip") as Element);

    expect(screen.getByText("@text1")).toBeTruthy();
    expect(screen.getByText("@image1")).toBeTruthy();
  });
});
