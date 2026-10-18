// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { ConfirmDialogHost, alertDialog, confirmDialog } from "@/components/confirm-dialog-host";

describe("ConfirmDialogHost", () => {
  it("resolves true when the user confirms", async () => {
    const user = userEvent.setup();
    render(<ConfirmDialogHost />);

    const pending = confirmDialog({
      title: "Stop task",
      description: "Terminating does not refund credits",
      confirmText: "Stop task",
      cancelText: "Keep running",
    });

    await user.click(await screen.findByRole("button", { name: "Stop task" }));

    await expect(pending).resolves.toBe(true);
  });

  it("resolves false when the user cancels", async () => {
    const user = userEvent.setup();
    render(<ConfirmDialogHost />);

    const pending = confirmDialog({ description: "Terminating does not refund credits" });

    expect(await screen.findByText("Terminating does not refund credits")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "common.cancel" }));

    await expect(pending).resolves.toBe(false);
  });

  it("supersedes an unanswered request by resolving it as declined", async () => {
    render(<ConfirmDialogHost />);

    const first = confirmDialog({ description: "First request" });
    const second = confirmDialog({ description: "Second request" });

    await expect(first).resolves.toBe(false);
    await waitFor(() =>
      expect(screen.getByText("Second request")).toBeInTheDocument(),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "common.confirm" }));
    await expect(second).resolves.toBe(true);
  });

  it("drops the cancel button for notice-only dialogs", async () => {
    const user = userEvent.setup();
    render(<ConfirmDialogHost />);

    const pending = alertDialog({ title: "Canvas limit reached", description: "Delete some before creating a new one" });

    expect(await screen.findByText("Delete some before creating a new one")).toBeInTheDocument();
    // With no second option, leaving a "Cancel" would only make people think they can still back out.
    expect(screen.queryByRole("button", { name: "common.cancel" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "common.ok" }));

    await expect(pending).resolves.toBeUndefined();
  });

  // Regression marker: the confirm dialog used to sit at shadcn's original z-50, while the asset library dialog is z-[300] and the canvas bookmark menu
  // is z-[10010]. The result was that clicking "Delete" from the asset library showed the confirm dialog behind the popup - it could be neither confirmed nor dismissed.
  // jsdom cannot measure stacking order (Tailwind classes are not compiled into CSS), so the z value is pulled straight out of the class name here
  // and compared with the known highest layer; changing the algorithm is fine, failing to cover the whole overlay stack is not.
  it("renders above the canvas overlay stack so in-modal confirms stay reachable", async () => {
    const HIGHEST_OVERLAY_Z = 10010; // CanvasBookmarkContextMenu, the highest layer in the whole repo

    render(<ConfirmDialogHost />);
    void confirmDialog({ description: "Are you sure you want to delete \"Cover\"?" });

    await screen.findByText("Are you sure you want to delete \"Cover\"?");

    for (const slot of ["alert-dialog-overlay", "alert-dialog-content"]) {
      const el = document.querySelector(`[data-slot="${slot}"]`);
      expect(el, `${slot} was not rendered`).not.toBeNull();
      const match = /z-\[(\d+)\]/.exec(el!.className);
      expect(match, `${slot} has no z-[N], it was probably changed back to z-50`).not.toBeNull();
      expect(Number(match![1])).toBeGreaterThan(HIGHEST_OVERLAY_Z);
    }
  });

  it("keeps confirmation dialogs vertically centered", async () => {
    render(<ConfirmDialogHost />);
    void confirmDialog({ description: "Delete canvas?" });

    await screen.findByText("Delete canvas?");
    const content = document.querySelector('[data-slot="alert-dialog-content"]');

    expect(content).toHaveClass("top-1/2", "-translate-y-1/2");
    expect(content).not.toHaveClass("top-24", "translate-y-0");
  });
});
