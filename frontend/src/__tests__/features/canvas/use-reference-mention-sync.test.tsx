// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { useReferenceMentionSync } from "@/features/canvas/nodes/useReferenceMentionSync";

type Props = {
  prompt: string;
  ids: string[];
  apply: (next: string) => void;
};

function renderSync(initial: Props) {
  return renderHook(
    ({ prompt, ids, apply }: Props) =>
      useReferenceMentionSync(prompt, [{ prefix: "image", ids }], apply),
    { initialProps: initial },
  );
}

describe("useReferenceMentionSync", () => {
  it("only records a baseline on first render, leaving the prompt untouched", () => {
    const apply = vi.fn();
    renderSync({ prompt: "make @image2 move", ids: ["A", "B"], apply });
    expect(apply).not.toHaveBeenCalled();
  });

  it("renumbers mentions when an earlier reference is deleted", () => {
    const apply = vi.fn();
    const { rerender } = renderSync({
      prompt: "make @image2 move",
      ids: ["A", "B"],
      apply,
    });

    // Delete A's edge → B remains, and B goes from image2 to image1.
    rerender({ prompt: "make @image2 move", ids: ["B"], apply });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith("make @image1 move");
  });

  it("does not fire when only the prompt changes (references stable)", () => {
    const apply = vi.fn();
    const { rerender } = renderSync({
      prompt: "@image1",
      ids: ["A", "B"],
      apply,
    });

    rerender({ prompt: "@image1 plus a few words", ids: ["A", "B"], apply });

    expect(apply).not.toHaveBeenCalled();
  });

  it("does not fire when the remap produces an identical prompt", () => {
    const apply = vi.fn();
    const { rerender } = renderSync({
      prompt: "no references at all",
      ids: ["A", "B"],
      apply,
    });

    // The order changed but the prompt has no mention → do not write back.
    rerender({ prompt: "no references at all", ids: ["B", "A"], apply });

    expect(apply).not.toHaveBeenCalled();
  });
});
