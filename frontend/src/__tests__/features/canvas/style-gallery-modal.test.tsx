// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { FreezoneStyleTemplate } from "@/api/ops";
import {
  StyleGalleryModal,
  resolveStyleSelectionState,
} from "@/features/canvas/ui/StyleGalleryModal";

function makeTemplate(
  id: string,
  label: string,
  category: string,
): FreezoneStyleTemplate {
  return {
    id,
    label,
    category,
    cover: `${id}/cover.webp`,
    samples: [
      `${id}/female.webp`,
      `${id}/youth.webp`,
      `${id}/male.webp`,
      `${id}/elder.webp`,
    ],
    style_prompt: `${label} prompt line one\n${label} prompt line two`,
  };
}

const TEMPLATES: FreezoneStyleTemplate[] = [
  makeTemplate("golden_age", "Golden Age", "Period"),
  makeTemplate("wuxia", "Wuxia World", "Costume"),
];

describe("StyleGalleryModal", () => {
  it("renders one card per template with the bundled cover url", () => {
    render(
      <StyleGalleryModal
        templates={TEMPLATES}
        assetBase=""
        selectedId={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Golden Age")).toBeInTheDocument();
    expect(screen.getByText("Wuxia World")).toBeInTheDocument();
    expect(screen.getByAltText("Golden Age")).toHaveAttribute(
      "src",
      "/style-gallery/golden_age/cover.webp",
    );
  });

  it("prefixes covers with the configured asset base", () => {
    render(
      <StyleGalleryModal
        templates={TEMPLATES}
        assetBase="https://cdn.example.com/styles"
        selectedId={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByAltText("Golden Age")).toHaveAttribute(
      "src",
      "https://cdn.example.com/styles/golden_age/cover.webp",
    );
  });

  it("matches the fixed-card poster hover behavior", () => {
    render(
      <StyleGalleryModal
        templates={TEMPLATES}
        assetBase=""
        selectedId={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const cover = screen.getByAltText("Golden Age");
    const card = cover.closest("button")?.parentElement;
    expect(cover).toHaveClass("origin-top", "group-hover:scale-[1.02]");
    expect(card).toHaveClass("transition-[border-color,box-shadow]");
    expect(card?.className).not.toContain("translate-y");
  });

  it("card body opens the detail view instead of selecting outright", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(
      <StyleGalleryModal
        templates={TEMPLATES}
        assetBase=""
        selectedId={null}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "View Golden Age details" }));

    // A single cover cannot show how this style treats different characters, so clicking a card means "take a look" rather than "this is the one".
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByAltText("Golden Age sample 1")).toBeInTheDocument();
  });

  it("the always-visible Use button selects without a detour", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(
      <StyleGalleryModal
        templates={TEMPLATES}
        assetBase=""
        selectedId={null}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    // The quick path must not hide behind hover -- the entry only counts as existing if keyboard users can reach it with Tab.
    const quickUse = screen.getByRole("button", { name: "Use Golden Age" });
    expect(quickUse.className).not.toContain("opacity-0");

    await user.click(quickUse);

    expect(onSelect).toHaveBeenCalledWith("golden_age");
  });

  it("clears the selection and only offers clearing while something is selected", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    const { rerender } = render(
      <StyleGalleryModal
        templates={TEMPLATES}
        assetBase=""
        selectedId={null}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Clear style" })).toBeNull();

    rerender(
      <StyleGalleryModal
        templates={TEMPLATES}
        assetBase=""
        selectedId="golden_age"
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Clear style" }));

    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("opens the detail view with all four samples and the full prompt", async () => {
    const user = userEvent.setup();

    render(
      <StyleGalleryModal
        templates={TEMPLATES}
        assetBase=""
        selectedId={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "View Golden Age details" }));

    expect(screen.getByAltText("Golden Age sample 1")).toHaveAttribute(
      "src",
      "/style-gallery/golden_age/female.webp",
    );
    expect(screen.getByAltText("Golden Age sample 4")).toHaveAttribute(
      "src",
      "/style-gallery/golden_age/elder.webp",
    );
    expect(
      screen.getByText(/Golden Age prompt line one/),
    ).toHaveTextContent("Golden Age prompt line two");
  });

  it("fits the detail dialog height to its content", async () => {
    const user = userEvent.setup();

    render(
      <StyleGalleryModal
        templates={TEMPLATES}
        assetBase=""
        selectedId={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Style gallery" });
    expect(dialog).toHaveClass("h-[min(720px,82vh)]");

    await user.click(screen.getByRole("button", { name: "View Golden Age details" }));

    expect(dialog).not.toHaveClass("h-[min(720px,82vh)]");
    expect(dialog).toHaveClass("max-h-[82vh]");
  });

  it("uses the style from the detail view", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(
      <StyleGalleryModal
        templates={TEMPLATES}
        assetBase=""
        selectedId={null}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "View Wuxia World details" }));
    await user.click(screen.getByRole("button", { name: "Use" }));

    expect(onSelect).toHaveBeenCalledWith("wuxia");
  });

  it("narrows the grid to one category and back", async () => {
    const user = userEvent.setup();

    render(
      <StyleGalleryModal
        templates={TEMPLATES}
        assetBase=""
        selectedId={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Costume" }));

    expect(
      screen.getByRole("button", { name: "View Wuxia World details" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View Golden Age details" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "All" }));

    expect(
      screen.getByRole("button", { name: "View Golden Age details" }),
    ).toBeInTheDocument();
  });

  it("shows a placeholder instead of an empty grid", () => {
    const { rerender } = render(
      <StyleGalleryModal
        templates={[]}
        assetBase=""
        selectedId={null}
        isLoading
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Loading…")).toBeInTheDocument();

    rerender(
      <StyleGalleryModal
        templates={[]}
        assetBase=""
        selectedId={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("No style templates yet")).toBeInTheDocument();
  });

  it("returns from the detail view to the gallery", async () => {
    const user = userEvent.setup();

    render(
      <StyleGalleryModal
        templates={TEMPLATES}
        assetBase=""
        selectedId={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "View Golden Age details" }));
    expect(screen.queryByRole("button", { name: "View Wuxia World details" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(
      screen.getByRole("button", { name: "View Wuxia World details" }),
    ).toBeInTheDocument();
  });
});

describe("resolveStyleSelectionState", () => {
  const template = TEMPLATES[0];

  it("no selection stays no selection", () => {
    expect(
      resolveStyleSelectionState(null, null, {
        isLoading: false,
        hasError: false,
      }),
    ).toBe("none");
  });

  it("selected and found is ready", () => {
    expect(
      resolveStyleSelectionState("golden_age", template, {
        isLoading: false,
        hasError: false,
      }),
    ).toBe("ready");
  });

  // All three below make describeStyleSelection return null, but for completely different reasons,
  // and the UI must not always show "no style selected" -- that id is still being sent with the generation request.
  it("a list still on its way is loading", () => {
    expect(
      resolveStyleSelectionState("golden_age", null, {
        isLoading: true,
        hasError: false,
      }),
    ).toBe("loading");
  });

  it("a failed list fetch is failed", () => {
    expect(
      resolveStyleSelectionState("golden_age", null, {
        isLoading: false,
        hasError: true,
      }),
    ).toBe("failed");
  });

  it("a list that arrived without the id is missing", () => {
    expect(
      resolveStyleSelectionState("three_oclock_2300", null, {
        isLoading: false,
        hasError: false,
      }),
    ).toBe("missing");
  });
});
