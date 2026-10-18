// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { FreezoneStyleTemplate } from "@/api/ops";
import {
  StyleThumbnail,
  StyleTriggerChip,
} from "@/features/canvas/nodes/StyleChip";

const TEMPLATE: FreezoneStyleTemplate = {
  id: "golden_age",
  label: "Golden Age",
  category: "Era",
  cover: "golden_age/cover.webp",
  samples: ["golden_age/female.webp"],
  style_prompt: "Golden Age prompt",
};

describe("StyleTriggerChip", () => {
  it("opens the gallery", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();

    render(<StyleTriggerChip onOpen={onOpen} />);

    await user.click(screen.getByRole("button", { name: "Style" }));

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  // "Template not found" does not mean "no style selected" — that id is still sent along with the generation request,
  // and a chip that just says "Style" would make the user think they selected none, so images that carry a style look haunted.
  it.each([
    ["loading" as const, "Style · loading"],
    ["failed" as const, "Style · load failed"],
    ["missing" as const, "Style · unavailable"],
  ])("tells the truth in the %s state", (state, label) => {
    render(<StyleTriggerChip state={state} onOpen={vi.fn()} />);

    expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
  });

  it("still opens the gallery from a degraded state", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();

    render(<StyleTriggerChip state="failed" onOpen={onOpen} />);

    await user.click(screen.getByRole("button", { name: "Style · load failed" }));

    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("StyleThumbnail", () => {
  it("renders the cover and the style name", () => {
    render(
      <StyleThumbnail
        template={TEMPLATE}
        assetBase=""
        onOpen={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    expect(screen.getByAltText("Golden Age")).toHaveAttribute(
      "src",
      "/style-gallery/golden_age/cover.webp",
    );
    // Only visible on hover, but the copy itself must be in the DOM
    expect(screen.getByText("Golden Age")).toBeInTheDocument();
  });

  it("prefixes the cover with the configured asset base", () => {
    render(
      <StyleThumbnail
        template={TEMPLATE}
        assetBase="https://cdn.example.com/styles"
        onOpen={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    expect(screen.getByAltText("Golden Age")).toHaveAttribute(
      "src",
      "https://cdn.example.com/styles/golden_age/cover.webp",
    );
  });

  it("reopens the gallery when clicked", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();

    render(
      <StyleThumbnail
        template={TEMPLATE}
        assetBase=""
        onOpen={onOpen}
        onClear={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Style Golden Age" }));

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("clears the style without reopening the gallery", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onClear = vi.fn();

    render(
      <StyleThumbnail
        template={TEMPLATE}
        assetBase=""
        onOpen={onOpen}
        onClear={onClear}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Clear style" }));

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
