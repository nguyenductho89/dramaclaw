// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// The "..." menu of a single asset in the sidebar "Asset Library": send to canvas / download / rename / delete.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchFreezoneVideoCharacterLibrary = vi.fn();
const fetchFreezoneAssetLibraryFolders = vi.fn();
const renameFreezoneVideoCharacterLibraryItem = vi.fn();
const deleteFreezoneVideoCharacterLibraryItem = vi.fn();
const downloadUrlAsFile = vi.fn();

vi.mock("@/api/ops", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/ops")>()),
  fetchFreezoneVideoCharacterLibrary: (...args: unknown[]) =>
    fetchFreezoneVideoCharacterLibrary(...args),
  fetchFreezoneAssetLibraryFolders: (...args: unknown[]) =>
    fetchFreezoneAssetLibraryFolders(...args),
  renameFreezoneVideoCharacterLibraryItem: (...args: unknown[]) =>
    renameFreezoneVideoCharacterLibraryItem(...args),
  deleteFreezoneVideoCharacterLibraryItem: (...args: unknown[]) =>
    deleteFreezoneVideoCharacterLibraryItem(...args),
}));

vi.mock("@/lib/browserDownload", () => ({
  downloadUrlAsFile: (...args: unknown[]) => downloadUrlAsFile(...args),
}));

import { AssetLibraryBrowser } from "@/features/freezone/AssetLibraryBrowser";
import { ConfirmDialogHost } from "@/components/confirm-dialog-host";

const UPLOADED = {
  id: "item-1",
  name: "Atompunk",
  media: "image",
  source: "upload",
  category: "other",
  folder: "other",
  image_urls: ["/static/admin/58/freezone/_uploads/atom.png"],
};

const FROM_MAINLINE = {
  id: "mainline:character:Lin Xiaoman",
  name: "Lin Xiaoman",
  media: "image",
  source: "character",
  category: "character",
  folder: "mainline",
  image_urls: ["/static/admin/58/characters/lin.png"],
};

const VOICE_ONLY = {
  id: "item-2",
  name: "Su Bei voice",
  media: "audio",
  source: "upload",
  category: "audio",
  folder: "audio",
  audio_url: "/static/admin/58/freezone/_uploads/voice.mp3",
};

const VIDEO_ONLY = {
  id: "item-3",
  name: "Storyboard preview",
  media: "video",
  source: "upload",
  category: "other",
  folder: "other",
  video_url: "/static/admin/58/freezone/_uploads/preview.mp4",
};

function renderBrowser(onSendToCanvas?: (entry: unknown) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(
    <>
      <ConfirmDialogHost />
      <AssetLibraryBrowser project="demo" onSendToCanvas={onSendToCanvas} />
    </>,
    { wrapper },
  );
}

/** The sidebar has two levels, "folder first, then items", so to test an item you must click into the folder first. */
async function openFolder(label: string) {
  const folder = await screen.findByLabelText(`Folder ${label}`);
  fireEvent.click(folder);
}

async function openItemMenu(name: string) {
  fireEvent.click(await screen.findByLabelText(`More actions for ${name}`));
}

describe("AssetLibraryBrowser item actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchFreezoneAssetLibraryFolders.mockResolvedValue([]);
    fetchFreezoneVideoCharacterLibrary.mockResolvedValue([
      UPLOADED,
      FROM_MAINLINE,
    ]);
  });

  // The cover rule must match the dialog: if there is an image take the first image as the cover; a pure-audio folder falls back to the folder icon.
  it("shows a cover thumbnail on folders that hold an image", async () => {
    renderBrowser(() => {});
    const folder = await screen.findByLabelText("Folder Unsorted assets");

    const cover = folder.querySelector("img");
    expect(cover).toBeTruthy();
    expect(cover?.getAttribute("src")).toContain("atom.png");
  });

  it("falls back to the folder icon when nothing inside is an image", async () => {
    fetchFreezoneVideoCharacterLibrary.mockResolvedValue([VOICE_ONLY]);
    renderBrowser(() => {});
    const folder = await screen.findByLabelText("Folder Sound effects");

    expect(folder.querySelector("img")).toBeNull();
  });

  it("does not preload metadata for every video in an opened folder", async () => {
    fetchFreezoneVideoCharacterLibrary.mockResolvedValue([VIDEO_ONLY]);
    renderBrowser(() => {});
    await openFolder("Unsorted assets");

    const video = document.querySelector("video");
    expect(video).toBeTruthy();
    expect(video?.getAttribute("preload")).toBe("none");
  });

  it("offers the four actions on a locally uploaded asset", async () => {
    renderBrowser(() => {});
    await openFolder("Unsorted assets");
    await openItemMenu("Atompunk");

    expect(screen.getByRole("menuitem", { name: "Send to canvas" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Download" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
  });

  it("hides Send to canvas when there is no canvas to send to", async () => {
    renderBrowser();
    await openFolder("Unsorted assets");
    await openItemMenu("Atompunk");

    expect(screen.queryByRole("menuitem", { name: "Send to canvas" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Download" })).toBeTruthy();
  });

  // Assets synced from the mainline would be overwritten back on the next sync after being renamed/deleted, so these two entries are not offered.
  it("only offers read-only actions on mainline-synced assets", async () => {
    renderBrowser(() => {});
    await openFolder("Mainline");
    await openItemMenu("Lin Xiaoman");

    expect(screen.getByRole("menuitem", { name: "Send to canvas" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Download" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
  });

  it("sends the clicked asset to the canvas", async () => {
    const onSend = vi.fn();
    renderBrowser(onSend);
    await openFolder("Unsorted assets");
    await openItemMenu("Atompunk");
    fireEvent.click(screen.getByRole("menuitem", { name: "Send to canvas" }));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toMatchObject({
      id: "item-1",
      name: "Atompunk",
    });
  });

  it("downloads under the asset name plus the url's extension", async () => {
    downloadUrlAsFile.mockResolvedValue(undefined);
    renderBrowser(() => {});
    await openFolder("Unsorted assets");
    await openItemMenu("Atompunk");
    fireEvent.click(screen.getByRole("menuitem", { name: "Download" }));

    await waitFor(() => expect(downloadUrlAsFile).toHaveBeenCalledTimes(1));
    expect(downloadUrlAsFile.mock.calls[0][1]).toBe("atompunk.png");
  });

  it("renames through the shared name dialog", async () => {
    renameFreezoneVideoCharacterLibraryItem.mockResolvedValue({});
    renderBrowser(() => {});
    await openFolder("Unsorted assets");
    await openItemMenu("Atompunk");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));

    const input = screen.getByLabelText(/Asset name/);
    fireEvent.change(input, { target: { value: "Cyber neon" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(renameFreezoneVideoCharacterLibraryItem).toHaveBeenCalledWith(
        "demo",
        "item-1",
        "Cyber neon",
      ),
    );
  });

  it("confirms deletion through the styled dialog instead of window.confirm", async () => {
    deleteFreezoneVideoCharacterLibraryItem.mockResolvedValue({});
    const nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    renderBrowser(() => {});
    await openFolder("Unsorted assets");
    await openItemMenu("Atompunk");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    const dialog = await screen.findByRole("alertdialog");
    // With native confirm this dialog would never appear, and the deletion would already have been sent.
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(deleteFreezoneVideoCharacterLibraryItem).not.toHaveBeenCalled();

    // Cancel: find it by the button other than its text, so it does not break together with the i18n "Cancel" copy.
    const cancel = within(dialog)
      .getAllByRole("button")
      .find((button) => button.textContent !== "Delete");
    fireEvent.click(cancel as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(deleteFreezoneVideoCharacterLibraryItem).not.toHaveBeenCalled();

    await openItemMenu("Atompunk");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    const retry = await screen.findByRole("alertdialog");
    fireEvent.click(within(retry).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(deleteFreezoneVideoCharacterLibraryItem).toHaveBeenCalledWith(
        "demo",
        "item-1",
      ),
    );

    nativeConfirm.mockRestore();
  });
});
