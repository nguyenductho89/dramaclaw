// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FreezoneCanvasSummary } from "@/api/canvas";
import { MAX_USER_CREATED_CANVASES_PER_PROJECT } from "@/lib/limits";
import { useAuthStore } from "@/stores/auth-store";

const CANVASES_ZH: Record<string, string> = {
  "freezone.canvases.createTitle": "New project canvas",
  "freezone.canvases.createLimitTitle": "Canvas limit reached",
  "freezone.canvases.createQuotaUnknownTitle": "Cannot confirm the canvas count yet",
  "freezone.canvases.createQuotaUnknown": "The canvas list has not loaded yet; wait a moment before creating",
  "freezone.canvases.createLimitReached": "Each person may create at most {{limit}} canvases per project; delete some before creating",
  "freezone.canvases.createPlaceholder": "New canvas name",
  "freezone.canvases.create": "Create",
  "freezone.canvases.createBusy": "Creating",
  "freezone.canvases.switcher": "Switch canvas",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      let value = CANVASES_ZH[key] ?? key;
      for (const [optKey, optValue] of Object.entries(options ?? {})) {
        value = value.split(`{{${optKey}}}`).join(String(optValue));
      }
      return value;
    },
  }),
}));

const listFreezoneCanvases = vi.fn();
const createBlankFreezoneCanvas = vi.fn();

vi.mock("@/api/canvas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/canvas")>()),
  listFreezoneCanvases: (...args: unknown[]) => listFreezoneCanvases(...args),
  createBlankFreezoneCanvas: (...args: unknown[]) => createBlankFreezoneCanvas(...args),
}));

type NoticeOptions = { title?: string; description: string };

const alertDialog = vi.hoisted(() =>
  vi.fn((_options: { title?: string; description: string }) => Promise.resolve()),
);

vi.mock("@/components/confirm-dialog-host", () => ({
  alertDialog: (options: NoticeOptions) => alertDialog(options),
  confirmDialog: vi.fn(() => Promise.resolve(false)),
}));

import { CanvasesTab } from "@/features/freezone/CanvasesTab";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function myCanvas(index: number): FreezoneCanvasSummary {
  return {
    id: `canvas_mine_${index}`,
    modified_at: "2026-06-03T00:00:00Z",
    size: 1,
    metadata: {
      canvas_origin: "user_created",
      display_name: `My canvas ${index}`,
      creator_username: "admin",
    },
  } as FreezoneCanvasSummary;
}

async function openCanvasMenu() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Switch canvas" }));
  return user;
}

describe("CanvasesTab canvas quota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ username: "admin", role: "admin" });
  });

  afterEach(() => {
    useAuthStore.setState({ username: null, role: null });
  });

  it("keeps the create entry clickable at the quota and explains itself in a dialog", async () => {
    listFreezoneCanvases.mockResolvedValue(
      Array.from({ length: MAX_USER_CREATED_CANVASES_PER_PROJECT }, (_unused, i) => myCanvas(i)),
    );

    render(
      <CanvasesTab project="demo" currentCanvasId="canvas_mine_0" hasPresetLabel={false} />,
      { wrapper },
    );

    const user = await openCanvasMenu();
    // The entry is not greyed out: the user can click it, so there is a place to say "why not".
    const createItem = await screen.findByText("New project canvas");
    await user.click(createItem);

    expect(alertDialog).toHaveBeenCalledTimes(1);
    expect(alertDialog.mock.calls[0][0]).toMatchObject({
      title: "Canvas limit reached",
      description: `Each person may create at most ${MAX_USER_CREATED_CANVASES_PER_PROJECT} canvases per project; delete some before creating`,
    });
    // A dialog replaces the form: the input must not be visible before reaching the limit.
    expect(screen.queryByPlaceholderText("New canvas name")).toBeNull();
  });

  it("keeps the bottom actions out of the scrolling canvas list", async () => {
    listFreezoneCanvases.mockResolvedValue(
      Array.from({ length: MAX_USER_CREATED_CANVASES_PER_PROJECT }, (_unused, i) => myCanvas(i)),
    );

    render(
      <CanvasesTab project="demo" currentCanvasId="canvas_mine_0" hasPresetLabel={false} />,
      { wrapper },
    );

    await openCanvasMenu();
    const createItem = await screen.findByText("New project canvas");
    const scroller = document.querySelector<HTMLElement>(
      '[data-slot="dropdown-menu-content"] .overflow-y-auto',
    );

    // When there are so many canvases that scrolling is needed, only the list itself may scroll; if the actions scrolled with the list, every use would require dragging to the bottom first.
    expect(scroller).not.toBeNull();
    // 25 self-created + 1 personal canvas projection, the whole list is inside the scroll area.
    expect(scroller!.querySelectorAll('[data-slot="dropdown-menu-item"]').length).toBe(
      MAX_USER_CREATED_CANVASES_PER_PROJECT + 1,
    );
    expect(scroller!.contains(createItem)).toBe(false);
  });

  it("refuses to create while the canvas list is still loading", async () => {
    // Before the list comes back the code holds an empty array. Letting it through would allow creating one extra canvas in this window -
    // the backend does not count, and that extra one is real.
    listFreezoneCanvases.mockReturnValue(new Promise(() => {}));

    render(
      <CanvasesTab project="demo" currentCanvasId="canvas_mine_0" hasPresetLabel={false} />,
      { wrapper },
    );

    const user = await openCanvasMenu();
    await user.click(await screen.findByText("New project canvas"));

    expect(screen.queryByPlaceholderText("New canvas name")).toBeNull();
    expect(createBlankFreezoneCanvas).not.toHaveBeenCalled();
    expect(alertDialog).toHaveBeenCalledTimes(1);
    expect(alertDialog.mock.calls[0][0]).toMatchObject({
      title: "Cannot confirm the canvas count yet",
      description: "The canvas list has not loaded yet; wait a moment before creating",
    });
  });

  it("refuses to create before the username has been restored", async () => {
    // When identity is not restored, what gets counted is the anonymous bucket, which can neither block the real author nor be treated as having room left;
    // if really let through, this canvas would be stored with creatorUsername: null and count toward nobody's quota.
    useAuthStore.setState({ username: null, role: null });
    listFreezoneCanvases.mockResolvedValue([myCanvas(0)]);

    render(
      <CanvasesTab project="demo" currentCanvasId="canvas_mine_0" hasPresetLabel={false} />,
      { wrapper },
    );

    const user = await openCanvasMenu();
    await user.click(await screen.findByText("New project canvas"));

    expect(screen.queryByPlaceholderText("New canvas name")).toBeNull();
    expect(createBlankFreezoneCanvas).not.toHaveBeenCalled();
    expect(alertDialog).toHaveBeenCalledTimes(1);
    expect(alertDialog.mock.calls[0][0]).toMatchObject({ title: "Cannot confirm the canvas count yet" });
  });

  it("stops trusting the old count when the post-create refresh fails", async () => {
    // After creating the 25th, the list refresh fails: React Query keeps the previous 24-item data,
    // and refetch() itself does not throw. Counting from this old data would let the 26th be created - the backend does not
    // count; that extra one is real. When the refresh cannot proceed it can only be treated as "unknown".
    const below = Array.from(
      { length: MAX_USER_CREATED_CANVASES_PER_PROJECT - 1 },
      (_unused, i) => myCanvas(i),
    );
    listFreezoneCanvases.mockResolvedValueOnce(below).mockRejectedValue(new Error("boom"));
    createBlankFreezoneCanvas.mockResolvedValue(undefined);

    render(
      <CanvasesTab project="demo" currentCanvasId="canvas_mine_0" hasPresetLabel={false} />,
      { wrapper },
    );

    const user = await openCanvasMenu();
    await user.click(await screen.findByText("New project canvas"));
    await user.type(await screen.findByPlaceholderText("New canvas name"), "Twenty-fifth");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createBlankFreezoneCanvas).toHaveBeenCalledTimes(1));
    // The refresh failed, and what is held is still that old 24-item list.
    await waitFor(() => expect(listFreezoneCanvases.mock.calls.length).toBeGreaterThan(1));

    alertDialog.mockClear();
    const user2 = await openCanvasMenu();
    await user2.click(await screen.findByText("New project canvas"));

    expect(screen.queryByPlaceholderText("New canvas name")).toBeNull();
    expect(createBlankFreezoneCanvas).toHaveBeenCalledTimes(1);
    expect(alertDialog).toHaveBeenCalledTimes(1);
    expect(alertDialog.mock.calls[0][0]).toMatchObject({ title: "Cannot confirm the canvas count yet" });
  });

  it("opens the create form without a dialog below the quota", async () => {
    listFreezoneCanvases.mockResolvedValue(
      Array.from({ length: MAX_USER_CREATED_CANVASES_PER_PROJECT - 1 }, (_unused, i) =>
        myCanvas(i),
      ),
    );

    render(
      <CanvasesTab project="demo" currentCanvasId="canvas_mine_0" hasPresetLabel={false} />,
      { wrapper },
    );

    const user = await openCanvasMenu();
    await user.click(await screen.findByText("New project canvas"));

    expect(alertDialog).not.toHaveBeenCalled();
    expect(await screen.findByPlaceholderText("New canvas name")).toBeTruthy();
  });
});
