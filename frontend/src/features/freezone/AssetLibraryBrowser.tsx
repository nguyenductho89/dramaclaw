// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// Content of the left panel's "Asset Library" tab: browsing the project-level asset library, two levels - folders first, click in
// to see items, with a breadcrumb on top to go back.
//
// Relation to AssetLibraryModal: item normalization and folder grouping share
// `@/features/canvas/ui/assetLibraryItems`, so both sides always see the same directory structure.
// The "..." on the right of an item offers send to canvas / download / rename / delete - all immediate single-asset
// operations, one menu is enough. Upload, create folder and sync from mainline remain only in the dialog: they need
// file picking, choosing a save location and a progress bar, which a 300px sidebar cannot hold.
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  Download,
  Folder,
  MoreHorizontal,
  Music,
  Pencil,
  SendHorizontal,
  Trash2,
  Video as VideoIcon,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  deleteFreezoneVideoCharacterLibraryItem,
  renameFreezoneVideoCharacterLibraryItem,
} from "@/api/ops";
import { confirmDialog } from "@/components/confirm-dialog-host";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { downloadUrlAsFile } from "@/lib/browserDownload";
import { queryKeys } from "@/lib/query-keys";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import {
  useFreezoneAssetLibrary,
  useFreezoneAssetLibraryFolders,
} from "@/lib/queries/freezone";
import {
  buildAssetFolders,
  folderCoverUrl,
  libraryItemDownloadFilename,
  LIBRARY_ITEM_NAME_MAX_LEN,
  type AssetFolderKey,
  type LibraryItem,
} from "@/features/canvas/ui/assetLibraryItems";
import { AssetLibraryNewFolderDialog } from "@/features/canvas/ui/AssetLibraryNewFolderDialog";

interface AssetLibraryBrowserProps {
  project: string;
  /** Omit to mean the current scene has no canvas to send to, so "Send to canvas" does not appear in the menu. */
  onSendToCanvas?: (entry: LibraryItem) => void;
}

// Same style as the outline panel's row menu - two "..." in the same sidebar should not look different.
const MENU_CONTENT_CLASS =
  "z-[120] min-w-[132px] border-[var(--ui-border-soft)] bg-[rgba(var(--surface-rgb)/0.95)] text-text-dark shadow-none backdrop-blur-3xl";
const MENU_ITEM_CLASS =
  "gap-2 rounded-[var(--ui-radius-lg)] text-xs text-text-dark focus:bg-[rgb(var(--text-rgb)/0.075)] focus:text-text-dark";
/** The red of the delete item comes from DropdownMenuItem's destructive variant; the text color must not be overridden here. */
const MENU_ITEM_DANGER_CLASS = "gap-2 rounded-[var(--ui-radius-lg)] text-xs";

export function AssetLibraryBrowser({
  project,
  onSendToCanvas,
}: AssetLibraryBrowserProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [openKey, setOpenKey] = useState<AssetFolderKey | null>(null);
  const [renameEntry, setRenameEntry] = useState<LibraryItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const libraryQuery = useFreezoneAssetLibrary(project);
  const foldersQuery = useFreezoneAssetLibraryFolders(project);
  const items = useMemo(() => libraryQuery.data ?? [], [libraryQuery.data]);
  const folders = useMemo(
    () => buildAssetFolders(items, t, foldersQuery.data ?? []),
    [items, t, foldersQuery.data],
  );
  const openFolder = openKey
    ? (folders.find((folder) => folder.key === openKey) ?? null)
    : null;

  const refreshLibrary = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.freezoneAssetLibrary(project),
    });
  }, [queryClient, project]);

  const handleDownload = useCallback(async (entry: LibraryItem) => {
    try {
      await downloadUrlAsFile(
        resolveImageDisplayUrl(entry.url),
        libraryItemDownloadFilename(entry),
      );
    } catch (err) {
      toast.error(
        t("canvas.assetLibrary.downloadFailed", {
          detail: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }, [t]);

  const handleDelete = useCallback(
    async (entry: LibraryItem) => {
      if (!entry.id) return;
      const confirmed = await confirmDialog({
        title: t("canvas.assetLibrary.deleteEntryTitle"),
        description: t("canvas.assetLibrary.deleteEntryDescription", { name: entry.name || entry.id }),
        confirmText: t("canvas.assetLibrary.delete"),
        confirmVariant: "destructive",
      });
      if (!confirmed) return;
      setBusyId(entry.id);
      try {
        await deleteFreezoneVideoCharacterLibraryItem(project, entry.id);
        refreshLibrary();
        toast.success(t("freezone.assetBrowser.deleted", { name: entry.name || t("freezone.assetBrowser.itemFallbackName") }));
      } catch (err) {
        toast.error(
          t("freezone.assetBrowser.deleteFailed", {
            detail: err instanceof Error ? err.message : String(err),
          }),
        );
      } finally {
        setBusyId(null);
      }
    },
    [project, refreshLibrary, t],
  );

  const handleRename = useCallback(
    async (name: string) => {
      if (!renameEntry?.id) return;
      await renameFreezoneVideoCharacterLibraryItem(project, renameEntry.id, name);
      setRenameEntry(null);
      refreshLibrary();
    },
    [project, renameEntry, refreshLibrary, t],
  );

  if (libraryQuery.isError) {
    return (
      <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-400">
          {t("freezone.assetBrowser.loadFailed", {
            detail:
              libraryQuery.error instanceof Error
                ? libraryQuery.error.message
                : String(libraryQuery.error),
          })}
        </div>
      </div>
    );
  }

  if (libraryQuery.isPending) {
    return (
      <div className="min-h-0 flex-1 px-3 py-6 text-center text-xs text-white/25">
        {t("freezone.assetBrowser.loading")}
      </div>
    );
  }

  // When the library is empty and no folder was ever created, do not show two empty directories; just say the entry is in the dialog, so users don't hunt for upload in the sidebar.
  if (items.length === 0 && (foldersQuery.data?.length ?? 0) === 0) {
    return (
      <div className="min-h-0 flex-1 px-4 py-6 text-center text-[11px] leading-relaxed text-white/25">
        {t("freezone.assetBrowser.empty")}
      </div>
    );
  }

  return (
    <>
      {/* -- Breadcrumb (only after entering a folder) -- */}
      {openFolder ? (
        <div className="flex shrink-0 items-center gap-1 px-3 pt-2.5 pb-1.5 text-xs text-white/40">
          <button
            type="button"
            onClick={() => setOpenKey(null)}
            aria-label={t("freezone.assetBrowser.backToRoot")}
            className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 transition-colors hover:bg-white/[0.06] hover:text-white/70"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            {t("canvas.assetLibrary.title")}
          </button>
          <span className="text-white/20">/</span>
          <span className="truncate px-0.5 text-white/80">
            {openFolder.label}
          </span>
        </div>
      ) : null}

      <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-1.5">
        {/* -- Root: folder list -- */}
        {!openFolder
          ? folders.map((folder) => {
              // The cover rule matches the dialog (folderCoverUrl: custom cover first, otherwise the first image),
              // the two places must not each compute their own - the same folder looking different in two views is the most confusing.
              const cover = folderCoverUrl(folder);
              return (
                <button
                  key={folder.key}
                  type="button"
                  onClick={() => setOpenKey(folder.key)}
                  aria-label={t("canvas.assetLibrary.folderAria", { label: folder.label })}
                  className="flex w-full items-center gap-2.5 rounded-[8px] px-1.5 py-1.5 text-left transition-colors hover:bg-primary/[0.10] focus-visible:bg-primary/[0.10] focus-visible:outline-none"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[8px] bg-white/[0.06] ring-1 ring-inset ring-white/[0.06]">
                    {cover ? (
                      <img
                        src={resolveImageDisplayUrl(cover)}
                        alt=""
                        className="h-full w-full object-cover"
                        draggable={false}
                        loading="lazy"
                      />
                    ) : (
                      <Folder className="h-4.5 w-4.5 text-white/40" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-white/85">
                    {folder.label}
                  </span>
                  <span className="shrink-0 pr-1 text-[11px] text-white/25">
                    {folder.items.length}
                  </span>
                </button>
              );
            })
          : null}

        {/* -- Inside a folder: item list -- */}
        {openFolder && openFolder.items.length === 0 ? (
          <div className="px-2 py-6 text-center text-[11px] text-white/25">
            {t("freezone.assetBrowser.folderEmpty", { name: openFolder.label })}
          </div>
        ) : null}

        {openFolder?.items.map((entry, idx) => (
          <div
            key={entry.id ?? `idx-${idx}`}
            className={`group flex w-full items-center gap-2.5 rounded-[8px] px-1.5 py-1.5 transition-colors hover:bg-primary/[0.10] ${
              busyId && entry.id === busyId ? "opacity-40" : ""
            }`}
            title={entry.name || t("canvas.assetLibrary.unnamed")}
          >
            <span className="relative h-10 w-10 shrink-0 overflow-hidden rounded-[8px] bg-white/[0.06] ring-1 ring-inset ring-white/[0.06]">
              {entry.media === "image" ? (
                <img
                  src={resolveImageDisplayUrl(entry.url)}
                  alt={entry.name}
                  className="h-full w-full object-cover"
                  draggable={false}
                  loading="lazy"
                />
              ) : entry.media === "video" ? (
                <>
                  <video
                    src={resolveImageDisplayUrl(entry.url)}
                    className="h-full w-full object-cover"
                    muted
                    playsInline
                    preload="none"
                  />
                  {/* A video without a poster is a black slab; add a badge to tell it apart from images */}
                  <span className="pointer-events-none absolute left-0.5 top-0.5 rounded bg-black/55 p-0.5 text-white/90">
                    <VideoIcon className="h-2.5 w-2.5" />
                  </span>
                </>
              ) : (
                <span className="flex h-full w-full items-center justify-center text-white/40">
                  <Music className="h-4 w-4" />
                </span>
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-white/85">
              {entry.name || t("canvas.assetLibrary.unnamed")}
            </span>
            <AssetItemMenu
              entry={entry}
              onSendToCanvas={
                onSendToCanvas ? () => onSendToCanvas(entry) : undefined
              }
              onDownload={() => void handleDownload(entry)}
              onRename={() => setRenameEntry(entry)}
              onDelete={() => void handleDelete(entry)}
            />
          </div>
        ))}
      </div>

      <AssetLibraryNewFolderDialog
        open={Boolean(renameEntry)}
        title={t("canvas.assetLibrary.rename")}
        mode="rename"
        fieldLabel={t("freezone.assetBrowser.assetName")}
        placeholder={t("freezone.assetBrowser.assetNamePlaceholder")}
        maxLength={LIBRARY_ITEM_NAME_MAX_LEN}
        initialName={renameEntry?.name ?? ""}
        onClose={() => setRenameEntry(null)}
        onSubmit={handleRename}
      />
    </>
  );
}

/**
 * The item's "..." menu.
 *
 * Assets synced from the mainline cannot be renamed/deleted - a rename would be overwritten by the mainline name at the next "sync from mainline",
 * and a deletion would grow back as-is at the next sync; showing them would only make people think it is broken.
 */
function AssetItemMenu({
  entry,
  onSendToCanvas,
  onDownload,
  onRename,
  onDelete,
}: {
  entry: LibraryItem;
  onSendToCanvas?: () => void;
  onDownload: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const queuedRef = useRef<(() => void) | null>(null);
  const writable = entry.source === "upload" && Boolean(entry.id);

  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      // The rename dialog and delete confirmation both grab focus, and colliding with the menu returning focus to the trigger button on close would flicker,
      // so these two items are queued until the menu has fully closed (download / send to canvas open no dialog and can run immediately).
      onOpenChangeComplete={(next) => {
        if (next) return;
        const queued = queuedRef.current;
        queuedRef.current = null;
        queued?.();
      }}
    >
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t("canvas.assetLibrary.folderMoreAria", { label: entry.name || t("freezone.assetBrowser.itemFallbackName") })}
            // Hidden normally, shown on hover or keyboard focus; kept visible while its own menu is open,
            // otherwise the button would vanish as soon as the mouse moves onto the menu.
            className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] text-white/45 transition-colors hover:bg-white/[0.10] hover:text-white focus-visible:opacity-100 ${
              open
                ? "bg-white/[0.10] text-white opacity-100"
                : "opacity-0 group-hover:opacity-100"
            }`}
          />
        }
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className={MENU_CONTENT_CLASS} align="end">
        {onSendToCanvas ? (
          <DropdownMenuItem className={MENU_ITEM_CLASS} onClick={onSendToCanvas}>
            <SendHorizontal className="h-3.5 w-3.5" />
            <span>{t("canvas.assetLibrary.sendToCanvas")}</span>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem className={MENU_ITEM_CLASS} onClick={onDownload}>
          <Download className="h-3.5 w-3.5" />
          <span>{t("freezone.assetBrowser.download")}</span>
        </DropdownMenuItem>
        {writable ? (
          <>
            <DropdownMenuItem
              className={MENU_ITEM_CLASS}
              onClick={() => {
                queuedRef.current = onRename;
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
              <span>{t("canvas.assetLibrary.rename")}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              className={MENU_ITEM_DANGER_CLASS}
              onClick={() => {
                queuedRef.current = onDelete;
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>{t("canvas.assetLibrary.delete")}</span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
