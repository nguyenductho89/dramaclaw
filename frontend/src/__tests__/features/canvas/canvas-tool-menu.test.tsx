// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasQuickActionBar } from "@/features/canvas/ui/CanvasQuickActionBar";
import { useCanvasToolStore } from "@/features/canvas/ui/canvasToolStore";

const translations: Record<string, string> = {
  "canvas.quickbar.addNode": "Add node",
  "canvas.quickbar.history": "History Assets",
  "canvas.quickbar.shortcuts": "Shortcuts",
  "canvas.quickbar.help": "Help",
  "canvas.quickbar.viewManual": "View manual",
  "canvas.toolbar.toolMove": "Move",
  "canvas.toolbar.toolHand": "Hand tool",
  "canvas.toolbar.toolGroupLabel": "Canvas pointer tool",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => translations[key] ?? key }),
}));

// These three panels render only when their entry is opened, but the import chain drags three.js / the canvas store into
// jsdom. Only the tool menu is tested here, so they are stubbed out directly.
vi.mock("@/features/canvas/ui/CanvasAddNodePanel", () => ({
  CanvasAddNodePanel: () => <div data-testid="add-node-panel" />,
}));
vi.mock("@/features/canvas/ui/CanvasShortcutsPanel", () => ({
  CanvasShortcutsPanel: () => <div data-testid="shortcuts-panel" />,
}));
vi.mock("@/features/canvas/ui/CanvasHistoryAssetsModal", () => ({
  CanvasHistoryAssetsModal: () => <div data-testid="history-modal" />,
}));

function renderBar() {
  render(
    <CanvasQuickActionBar
      skillItems={[]}
      onAddNode={vi.fn()}
      onAddSkill={vi.fn()}
      onUseAsset={vi.fn()}
      onDeleteNode={vi.fn()}
    />,
  );
  return screen.getByRole("button", { name: "Canvas pointer tool" });
}

describe("canvas bottom toolbar — move / hand tool", () => {
  beforeEach(() => {
    useCanvasToolStore.setState({ tool: "move" });
  });

  it("the move tool is the default", () => {
    expect(useCanvasToolStore.getState().tool).toBe("move");
  });

  it("opening the tool button pops up a two-row menu, and choosing the hand switches the canvas to hand mode and closes the menu", async () => {
    const user = userEvent.setup();
    const toolButton = renderBar();

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(toolButton);
    const menu = screen.getByRole("menu", { name: "Canvas pointer tool" });
    expect(menu).toBeInTheDocument();

    const move = screen.getByRole("menuitemradio", { name: /Move/ });
    const hand = screen.getByRole("menuitemradio", { name: /Hand tool/ });
    expect(move).toHaveAttribute("aria-checked", "true");
    expect(hand).toHaveAttribute("aria-checked", "false");

    await user.click(hand);
    expect(useCanvasToolStore.getState().tool).toBe("hand");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("the menu can switch back to the move tool", async () => {
    const user = userEvent.setup();
    useCanvasToolStore.setState({ tool: "hand" });
    const toolButton = renderBar();

    await user.click(toolButton);
    await user.click(screen.getByRole("menuitemradio", { name: /Move/ }));
    expect(useCanvasToolStore.getState().tool).toBe("move");
  });

  // With the menu closed, the button itself is the only hint of "is the hand active now".
  it("in hand mode the button's hover hint reports the hand tool and its shortcut", async () => {
    const user = userEvent.setup();
    const toolButton = renderBar();

    expect(screen.getByText("Move V")).toBeInTheDocument();

    await user.click(toolButton);
    await user.click(screen.getByRole("menuitemradio", { name: /Hand tool/ }));

    expect(screen.getByText("Hand tool H")).toBeInTheDocument();
    expect(screen.queryByText("Move V")).not.toBeInTheDocument();
  });
});
