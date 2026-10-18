// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CanvasBookmarkContextMenu } from "@/features/canvas/ui/CanvasBookmarkContextMenu";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "canvas.bookmarks.setCurrent": "Set current position (overwrite)",
        "canvas.bookmarks.setNew": "Set current position",
        "canvas.bookmarks.deleteCurrent": "Delete current position",
        "canvas.bookmarks.clearAll": "Clear all positions",
      }[key] ?? key),
  }),
}));

describe("CanvasBookmarkContextMenu", () => {
  const baseProps = {
    index: 0,
    filled: true,
    position: { x: 10, y: 10 },
    onSetCurrent: vi.fn(),
    onDelete: vi.fn(),
    onClearAll: vi.fn(),
    onClose: vi.fn(),
  };

  it("renders the three actions", () => {
    render(<CanvasBookmarkContextMenu {...baseProps} />);
    expect(screen.getByText("Set current position (overwrite)")).toBeInTheDocument();
    expect(screen.getByText("Delete current position")).toBeInTheDocument();
    expect(screen.getByText("Clear all positions")).toBeInTheDocument();
  });

  it("invokes the set handler then closes", async () => {
    const onSetCurrent = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <CanvasBookmarkContextMenu {...baseProps} onSetCurrent={onSetCurrent} onClose={onClose} />,
    );
    await user.click(screen.getByText("Set current position (overwrite)"));
    expect(onSetCurrent).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("hides delete and drops the overwrite hint when the slot is empty", () => {
    render(<CanvasBookmarkContextMenu {...baseProps} filled={false} />);
    // Empty slot: no delete row, and the set label has no (overwrite) suffix.
    expect(screen.queryByText("Delete current position")).not.toBeInTheDocument();
    expect(screen.getByText("Set current position")).toBeInTheDocument();
    expect(screen.queryByText("Set current position (overwrite)")).not.toBeInTheDocument();
    // Clear-all stays available regardless of slot state.
    expect(screen.getByText("Clear all positions")).toBeInTheDocument();
  });
});
