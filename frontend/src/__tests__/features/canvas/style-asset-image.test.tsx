// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StyleAssetImage } from "@/features/canvas/ui/StyleAssetImage";

describe("StyleAssetImage", () => {
  it("resolves the relative path against the asset base", () => {
    render(
      <StyleAssetImage
        rel="golden_age/cover.webp"
        assetBase="https://cdn.example.com/styles"
        alt="Golden Age"
      />,
    );

    expect(screen.getByAltText("Golden Age")).toHaveAttribute(
      "src",
      "https://cdn.example.com/styles/golden_age/cover.webp",
    );
  });

  it("falls back to a placeholder when the asset 404s", () => {
    render(
      <StyleAssetImage rel="gone/cover.webp" assetBase="" alt="Retired style" />,
    );

    fireEvent.error(screen.getByAltText("Retired style"));

    // Even if the image is gone, keep a placeholder block and do not expose the browser's broken-image icon
    const placeholder = screen.getByRole("img", { name: "Retired style" });
    expect(placeholder.tagName).toBe("DIV");
  });

  it("renders the placeholder when the manifest has no cover", () => {
    render(<StyleAssetImage rel="" assetBase="" alt="No cover" />);

    expect(screen.getByRole("img", { name: "No cover" }).tagName).toBe("DIV");
  });
});
