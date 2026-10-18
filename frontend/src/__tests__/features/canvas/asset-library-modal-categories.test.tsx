// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// Asset library modal: the left-hand folders control the storage scope, and the right-hand categories only filter assets within that scope.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const fetchFreezoneVideoCharacterLibrary = vi.fn();
const syncFreezoneAssetLibraryFromMainline = vi.fn();
const fetchFreezoneAssetLibraryFolders = vi.fn();
const createFreezoneAssetLibraryFolder = vi.fn();
const deleteFreezoneVideoCharacterLibraryItem = vi.fn();
const updateFreezoneAssetLibraryFolder = vi.fn();
const deleteFreezoneAssetLibraryFolder = vi.fn();

vi.mock("@/api/ops", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/ops")>()),
  fetchFreezoneVideoCharacterLibrary: (...args: unknown[]) =>
    fetchFreezoneVideoCharacterLibrary(...args),
  syncFreezoneAssetLibraryFromMainline: (...args: unknown[]) =>
    syncFreezoneAssetLibraryFromMainline(...args),
  fetchFreezoneAssetLibraryFolders: (...args: unknown[]) =>
    fetchFreezoneAssetLibraryFolders(...args),
  createFreezoneAssetLibraryFolder: (...args: unknown[]) =>
    createFreezoneAssetLibraryFolder(...args),
  deleteFreezoneVideoCharacterLibraryItem: (...args: unknown[]) =>
    deleteFreezoneVideoCharacterLibraryItem(...args),
  updateFreezoneAssetLibraryFolder: (...args: unknown[]) =>
    updateFreezoneAssetLibraryFolder(...args),
  deleteFreezoneAssetLibraryFolder: (...args: unknown[]) =>
    deleteFreezoneAssetLibraryFolder(...args),
}));

import { AssetLibraryModal } from "@/features/canvas/ui/AssetLibraryModal";
import { ConfirmDialogHost } from "@/components/confirm-dialog-host";

const LIBRARY = [
  {
    id: "mainline:scene:Kitchen",
    name: "Kitchen",
    media: "image",
    source: "scene",
    image_urls: ["/static/kitchen.png"],
  },
  {
    id: "up-1",
    name: "Reference image A",
    media: "image",
    source: "upload",
    image_urls: ["/static/a.png"],
  },
  {
    id: "up-2",
    name: "Cyber neon",
    media: "image",
    source: "upload",
    category: "style",
    image_urls: ["/static/b.png"],
  },
  {
    id: "up-3",
    name: "Footsteps",
    media: "audio",
    source: "upload",
    category: "audio",
    audio_url: "/static/step.mp3",
  },
];

function renderModal(props: Partial<React.ComponentProps<typeof AssetLibraryModal>> = {}) {
  return render(
    <>
      <ConfirmDialogHost />
      <AssetLibraryModal mode="manage" open project="demo" onClose={() => {}} {...props} />
    </>,
  );
}

/** Delete confirmation goes through AlertDialog (not window.confirm); click its "Delete" to let it through. */
async function acceptDeleteConfirm() {
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
}

/** Cancel: find the button that is not "Delete", so the test does not depend on the cancel label. */
async function dismissConfirm(dialog: HTMLElement) {
  const cancel = within(dialog)
    .getAllByRole("button")
    .find((button) => button.textContent !== "Delete");
  fireEvent.click(cancel as HTMLElement);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
}

describe("AssetLibraryModal categories and folders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchFreezoneVideoCharacterLibrary.mockResolvedValue({ items: LIBRARY });
    syncFreezoneAssetLibraryFromMainline.mockResolvedValue({ items: LIBRARY });
    fetchFreezoneAssetLibraryFolders.mockResolvedValue([]);
    deleteFreezoneVideoCharacterLibraryItem.mockResolvedValue({ ok: true });
  });

  it("shows all assets by default, with folders in the left navigation", async () => {
    renderModal();

    expect(await screen.findByRole("button", { name: "Folder Mainline" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Folder Uncategorized" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Folder Styles" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All assets" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await screen.findByText("Kitchen")).toBeInTheDocument();
    expect(screen.getByText("Reference image A")).toBeInTheDocument();
    // High-frequency write actions sit in the top-right corner instead of hiding in a two-option "New" menu.
    expect(screen.getByRole("button", { name: "Bulk delete" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New folder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload assets" })).toBeInTheDocument();
  });

  it("folders only change the asset scope, and the All assets entry restores the full view", async () => {
    renderModal();

    fireEvent.click(await screen.findByRole("button", { name: "Folder Mainline" }));
    expect(await screen.findByText("Kitchen")).toBeInTheDocument();
    expect(screen.queryByText("Reference image A")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "All assets" }));
    expect(await screen.findByText("Reference image A")).toBeInTheDocument();
    expect(screen.getByText("Kitchen")).toBeInTheDocument();
  });

  it("the Unsorted assets folder holds only uploads without a category", async () => {
    renderModal();

    fireEvent.click(await screen.findByRole("button", { name: "Folder Uncategorized" }));
    expect(await screen.findByText("Reference image A")).toBeInTheDocument();
    expect(screen.queryByText("Cyber neon")).toBeNull();
  });

  it("categories only filter the current asset scope and never switch to another content level", async () => {
    renderModal();

    await screen.findByRole("button", { name: "Folder Mainline" });
    fireEvent.click(screen.getByRole("button", { name: "Category Styles" }));
    expect(await screen.findByText("Cyber neon")).toBeInTheDocument();
    expect(screen.queryByText("Reference image A")).toBeNull();
    expect(screen.getByRole("button", { name: "Folder Uncategorized" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Folder Mainline" }));
    expect(await screen.findByText("Kitchen")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Category Styles" }));
    expect(screen.queryByText("Cyber neon")).toBeNull();
    expect(screen.getByText("No assets in this category")).toBeInTheDocument();
  });

  it("when allowedMedia is image-only, neither the sound-effect category nor audio entries appear", async () => {
    renderModal({ allowedMedia: ["image"] });

    await screen.findByRole("button", { name: "Folder Mainline" });
    expect(screen.queryByRole("button", { name: "Category Audio" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Folder Uncategorized" }));
    expect(await screen.findByText("Reference image A")).toBeInTheDocument();
    expect(screen.queryByText("Footsteps")).toBeNull();
  });

  it("searches by name within the current folder and category scope, and can be cleared straight from the empty state", async () => {
    renderModal();
    await screen.findByText("Reference image A");

    const search = screen.getByRole("searchbox", { name: "Search assets" });
    fireEvent.change(search, { target: { value: "Cyber" } });

    expect(screen.getByText("Cyber neon")).toBeInTheDocument();
    expect(screen.queryByText("Reference image A")).toBeNull();

    fireEvent.change(search, { target: { value: "nonexistent" } });
    expect(screen.getByText("No matching assets")).toBeInTheDocument();
    const clearButtons = screen.getAllByRole("button", { name: "Clear search" });
    fireEvent.click(clearButtons[clearButtons.length - 1]!);

    expect(await screen.findByText("Reference image A")).toBeInTheDocument();
  });
});

describe("AssetLibraryModal create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchFreezoneVideoCharacterLibrary.mockResolvedValue({ items: LIBRARY });
    syncFreezoneAssetLibraryFromMainline.mockResolvedValue({ items: LIBRARY });
    fetchFreezoneAssetLibraryFolders.mockResolvedValue([]);
  });

  it("a new folder appears right after saving and is entered", async () => {
    const created = { id: "fld-1", name: "Episode 1 assets" };
    createFreezoneAssetLibraryFolder.mockResolvedValue(created);
    // The folder list is refetched after creation.
    fetchFreezoneAssetLibraryFolders
      .mockResolvedValueOnce([])
      .mockResolvedValue([created]);

    renderModal();
    await screen.findByRole("button", { name: "Folder Mainline" });

    fireEvent.click(screen.getByRole("button", { name: "New folder" }));

    const input = screen.getByPlaceholderText("Enter a folder name");
    fireEvent.change(input, { target: { value: "Episode 1 assets" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(createFreezoneAssetLibraryFolder).toHaveBeenCalledWith(
        "demo",
        "Episode 1 assets",
      ),
    );
    // After creation the left scope switches straight to the new folder and the right side shows the matching empty state.
    expect(
      await screen.findByRole("button", { name: "Folder Episode 1 assets" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("No assets yet")).toBeInTheDocument();
  });

  it("the upload dialog requires a destination before saving, and Mainline is not selectable", async () => {
    fetchFreezoneAssetLibraryFolders.mockResolvedValue([
      { id: "fld-1", name: "Episode 1 assets" },
    ]);
    renderModal();
    await screen.findByRole("button", { name: "Folder Mainline" });

    fireEvent.click(screen.getByRole("button", { name: "Upload assets" }));

    // With no file and no destination chosen, saving is unavailable.
    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Choose a destination" }));
    expect(screen.getByRole("button", { name: "Uncategorized" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Episode 1 assets" })).toBeInTheDocument();
    // Mainline is a synced artifact and cannot be an upload target.
    expect(screen.queryByRole("button", { name: "Mainline" })).toBeNull();
  });
});

describe("AssetLibraryModal bottom pagination", () => {
  // 26 untagged uploads -> all land in "Unsorted assets", enough for two pages.
  const MANY = Array.from({ length: 26 }, (_, i) => ({
    id: `up-${i + 1}`,
    name: `Asset ${i + 1}`,
    media: "image",
    source: "upload",
    image_urls: [`/static/${i + 1}.png`],
  }));

  beforeEach(() => {
    vi.clearAllMocks();
    fetchFreezoneVideoCharacterLibrary.mockResolvedValue({ items: MANY });
    syncFreezoneAssetLibraryFromMainline.mockResolvedValue({ items: MANY });
    fetchFreezoneAssetLibraryFolders.mockResolvedValue([]);
  });

  it("manage mode keeps only pagination at the bottom, with no Confirm", async () => {
    renderModal();

    expect(await screen.findByRole("button", { name: "Page 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Items per page" })).toHaveTextContent(
      "20 / page",
    );
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  });

  it("Confirm is still there when picking assets for a node", async () => {
    renderModal({ mode: "pick", onConfirm: vi.fn() });

    expect(await screen.findByRole("button", { name: "Confirm" })).toBeInTheDocument();
  });

  it("defaults to 20 per page, and paging shows the rest", async () => {
    renderModal();

    fireEvent.click(await screen.findByRole("button", { name: "Folder Uncategorized" }));
    expect(await screen.findByText("Asset 1")).toBeInTheDocument();
    expect(screen.getByText("Asset 20")).toBeInTheDocument();
    expect(screen.queryByText("Asset 21")).toBeNull();
    // 26 items -> 2 pages.
    expect(screen.queryByRole("button", { name: "Page 3" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Asset 21")).toBeInTheDocument();
    expect(screen.queryByText("Asset 1")).toBeNull();
  });

  it("changing the page size returns to page one and lists everything at once", async () => {
    renderModal();

    fireEvent.click(await screen.findByRole("button", { name: "Folder Uncategorized" }));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Asset 21")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Items per page" }));
    fireEvent.click(screen.getByRole("button", { name: "40 / page" }));

    expect(await screen.findByText("Asset 1")).toBeInTheDocument();
    expect(screen.getByText("Asset 26")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Page 2" })).toBeNull();
  });
});

describe("AssetLibraryModal folder actions", () => {
  const CUSTOM = {
    id: "fld-1",
    name: "Episode 1 assets",
    created_at: "2026-08-12T10:20:30",
  };
  const FILED = [
    ...LIBRARY,
    {
      id: "up-4",
      name: "Heroine makeup test",
      media: "image",
      source: "upload",
      category: "character",
      folder: "fld-1",
      image_urls: ["/static/c.png"],
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    fetchFreezoneVideoCharacterLibrary.mockResolvedValue({ items: FILED });
    syncFreezoneAssetLibraryFromMainline.mockResolvedValue({ items: FILED });
    fetchFreezoneAssetLibraryFolders.mockResolvedValue([CUSTOM]);
    updateFreezoneAssetLibraryFolder.mockResolvedValue(CUSTOM);
    deleteFreezoneAssetLibraryFolder.mockResolvedValue({ deleted_items: 1 });
  });

  it("only user-created folders have the \"...\" menu, system folders do not", async () => {
    renderModal();

    expect(
      await screen.findByRole("button", { name: "More actions for Episode 1 assets" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More actions for Mainline" })).toBeNull();
    // The name moves below the card, the count is no longer shown, and the creation date appears on the line under the name.
    expect(screen.queryByText("1 asset")).toBeNull();
    expect(screen.getByText("2026-08-12")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "More actions for Uncategorized" }),
    ).toBeNull();
  });

  it("\"Send to canvas\" hands the whole folder to the caller and closes the dialog", async () => {
    const onSendFolderToCanvas = vi.fn();
    const onClose = vi.fn();
    renderModal({ onSendFolderToCanvas, onClose });

    // There is one next to every non-empty folder nav item; scope to that row, then click.
    const folderButton = await screen.findByRole("button", {
      name: "Folder Episode 1 assets",
    });
    fireEvent.click(
      within(folderButton.parentElement as HTMLElement).getByRole("button", {
        name: "Send to canvas",
      }),
    );

    expect(onSendFolderToCanvas).toHaveBeenCalledTimes(1);
    expect(onSendFolderToCanvas.mock.calls[0][0]).toMatchObject({
      key: "fld-1",
      label: "Episode 1 assets",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("rename goes through PATCH and changes only the name", async () => {
    renderModal();

    fireEvent.click(
      await screen.findByRole("button", { name: "More actions for Episode 1 assets" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    const input = screen.getByPlaceholderText("Enter a folder name");
    expect(input).toHaveValue("Episode 1 assets");
    fireEvent.change(input, { target: { value: "Episode 1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateFreezoneAssetLibraryFolder).toHaveBeenCalledWith(
        "demo",
        "fld-1",
        { name: "Episode 1" },
      ),
    );
  });

  it("changing the cover picks from the images inside the folder", async () => {
    renderModal();

    fireEvent.click(
      await screen.findByRole("button", { name: "More actions for Episode 1 assets" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Change cover" }));

    // Only this folder's own images are listed; other folders' images do not appear.
    expect(screen.queryByRole("button", { name: "Use Reference image A as cover" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use Heroine makeup test as cover" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateFreezoneAssetLibraryFolder).toHaveBeenCalledWith(
        "demo",
        "fld-1",
        { cover: "/static/c.png" },
      ),
    );
  });

  it("deleting a folder needs a second confirmation, then deletes the whole folder", async () => {
    const nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderModal();

    const moreButton = await screen.findByRole("button", {
      name: "More actions for Episode 1 assets",
    });
    fireEvent.click(moreButton);
    fireEvent.click(
      within(moreButton.parentElement as HTMLElement).getByRole("button", {
        name: "Delete",
      }),
    );

    // The confirmation text must say the assets inside will be gone too.
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("The 1 assets inside will be deleted too");
    // With the native confirm this dialog would never appear.
    expect(nativeConfirm).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(deleteFreezoneAssetLibraryFolder).toHaveBeenCalledWith(
        "demo",
        "fld-1",
      ),
    );
  });

  it("the confirmation text counts the real number of items in the folder, unaffected by the allowedMedia filter", async () => {
    // An image-generation node only shows images, but the backend deletes the whole folder -- the text must say 2 items honestly, otherwise that video
    // would vanish without the user knowing.
    const withVideo = [
      ...FILED,
      {
        id: "up-5",
        name: "Makeup test outtakes",
        media: "video",
        source: "upload",
        category: "character",
        folder: "fld-1",
        video_url: "/static/d.mp4",
      },
    ];
    fetchFreezoneVideoCharacterLibrary.mockResolvedValue({ items: withVideo });
    syncFreezoneAssetLibraryFromMainline.mockResolvedValue({ items: withVideo });
    renderModal({ allowedMedia: ["image"] });

    const moreButton = await screen.findByRole("button", {
      name: "More actions for Episode 1 assets",
    });
    fireEvent.click(moreButton);
    fireEvent.click(
      within(moreButton.parentElement as HTMLElement).getByRole("button", {
        name: "Delete",
      }),
    );

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("The 2 assets inside will be deleted too");
    // Always answer it: confirmDialog's pending state lives in a module-level store that unmounting does not clear,
    // so a leftover open confirm dialog would cover the whole page in the next case's render.
    await dismissConfirm(dialog);
  });
});

describe("AssetLibraryModal bulk actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchFreezoneVideoCharacterLibrary.mockResolvedValue({ items: LIBRARY });
    syncFreezoneAssetLibraryFromMainline.mockResolvedValue({ items: LIBRARY });
    fetchFreezoneAssetLibraryFolders.mockResolvedValue([]);
    deleteFreezoneVideoCharacterLibraryItem.mockResolvedValue({ ok: true });
  });

  it("All assets is the asset view by default, and bulk delete needs no folder first", async () => {
    renderModal();

    const bulkButton = await screen.findByRole("button", { name: "Bulk delete" });
    expect(bulkButton).toBeEnabled();
    expect(await screen.findByText("Reference image A")).toBeInTheDocument();
  });

  it("in manage mode clicking a card opens details with clear next actions, producing no dead-end selection", async () => {
    const onSendItemToCanvas = vi.fn();
    renderModal({ onSendItemToCanvas });

    expect(screen.queryByRole("button", { name: "Select" })).toBeNull();
    fireEvent.click(
      await screen.findByRole("button", { name: "View details for Reference image A" }),
    );

    const details = screen.getByRole("dialog", { name: "Asset details" });
    expect(within(details).getByRole("button", { name: "Download" })).toBeEnabled();
    expect(within(details).getByRole("button", { name: "Delete" })).toBeEnabled();
    fireEvent.click(within(details).getByRole("button", { name: "Send to canvas" }));
    expect(onSendItemToCanvas).toHaveBeenCalledWith(
      expect.objectContaining({ id: "up-1" }),
    );
  });

  it("pick mode keeps the selection confirm but hides bulk delete", async () => {
    renderModal({ mode: "pick", onConfirm: vi.fn() });

    expect((await screen.findAllByRole("button", { name: "Select" })).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Bulk delete" })).toBeNull();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  });

  it("in bulk mode locally uploaded assets can be deleted, and mainline assets are not selectable", async () => {
    renderModal();
    await screen.findByRole("button", { name: "Folder Mainline" });

    fireEvent.click(screen.getByRole("button", { name: "Folder Uncategorized" }));
    fireEvent.click(screen.getByRole("button", { name: "Bulk delete" }));

    fireEvent.click(await screen.findByRole("button", { name: "Mark for deletion" }));
    expect(screen.getByText(/only locally uploaded assets can be deleted/)).toHaveTextContent(
      "1 selected",
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    await acceptDeleteConfirm();
    await waitFor(() =>
      expect(deleteFreezoneVideoCharacterLibraryItem).toHaveBeenCalledWith(
        "demo",
        "up-1",
      ),
    );
  });

  it("when one bulk delete fails, the rest are still deleted", async () => {
    // The most common failure is that the id was already deleted elsewhere; abandoning the whole batch for that makes no sense.
    const items = [
      {
        id: "up-1",
        name: "Reference image A",
        media: "image",
        source: "upload",
        image_urls: ["/static/a.png"],
      },
      {
        id: "up-9",
        name: "Reference image B",
        media: "image",
        source: "upload",
        image_urls: ["/static/e.png"],
      },
    ];
    fetchFreezoneVideoCharacterLibrary.mockResolvedValue({ items });
    syncFreezoneAssetLibraryFromMainline.mockResolvedValue({ items });
    deleteFreezoneVideoCharacterLibraryItem.mockImplementation(
      (_project: unknown, id: unknown) =>
        id === "up-1"
          ? Promise.reject(new Error("item not found"))
          : Promise.resolve({ ok: true }),
    );
    renderModal();
    await screen.findByRole("button", { name: "Folder Mainline" });

    fireEvent.click(screen.getByRole("button", { name: "Folder Uncategorized" }));
    fireEvent.click(screen.getByRole("button", { name: "Bulk delete" }));

    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Mark for deletion" }))[0],
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark for deletion" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    await acceptDeleteConfirm();

    await waitFor(() =>
      expect(deleteFreezoneVideoCharacterLibraryItem).toHaveBeenCalledWith(
        "demo",
        "up-9",
      ),
    );
    expect(deleteFreezoneVideoCharacterLibraryItem).toHaveBeenCalledWith(
      "demo",
      "up-1",
    );
  });

  it("in bulk mode mainline assets show no delete checkbox but can still open details", async () => {
    renderModal();
    await screen.findByRole("button", { name: "Folder Mainline" });

    fireEvent.click(screen.getByRole("button", { name: "Folder Mainline" }));
    fireEvent.click(screen.getByRole("button", { name: "Bulk delete" }));

    expect(
      screen.queryByRole("button", { name: "Mark for deletion" }),
    ).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "View details for Kitchen" }));
    expect(screen.getByRole("dialog", { name: "Asset details" })).toBeInTheDocument();
    expect(screen.getByText("Assets synced from the mainline must be edited in the mainline content they come from")).toBeInTheDocument();
  });
});
