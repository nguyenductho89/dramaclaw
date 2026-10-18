// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from "i18next";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AudioLines,
  Box,
  ChevronDown,
  ChevronRight,
  Clapperboard,
  Copy,
  Download,
  FileText,
  Film,
  Folder,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  LayoutGrid,
  ListCollapse,
  ListFilter,
  ListTree,
  MoreHorizontal,
  Navigation,
  Palette,
  Pencil,
  Play,
  ScrollText,
  Search,
  Sparkles,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";

import {
  CANVAS_NODE_TYPES,
  isGroupNode,
  resolveNodeSourceImageUrl,
  type CanvasNode,
  type CanvasNodeType,
} from "@/features/canvas/domain/canvasNodes";
import { resolveNodePrimaryAsset } from "@/features/canvas/domain/canvasAssets";
import {
  localizeDefaultNodeDisplayName,
  localizeNodeDisplayName,
  resolveNodeDisplayName,
} from "@/features/canvas/domain/nodeDisplay";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { downloadUrlAsFile } from "@/lib/browserDownload";
import { useCanvasStore } from "@/stores/canvasStore";

export type CanvasOutlineItem = {
  id: string;
  kind: "node" | "group";
  /** Groups use the group name; ordinary nodes use the node display name. */
  name: string;
  type: CanvasNodeType;
  thumbUrl: string | null;
  /** Original resource URL for download; null when there is nothing downloadable. */
  mediaUrl: string | null;
  /** A secondary line beyond the name (type · generation time); null when there is nothing to say. */
  meta: string | null;
  children: CanvasOutlineItem[];
};

const NODE_TYPE_ICON: Record<CanvasNodeType, LucideIcon> = {
  vectorSvgNode: ImageIcon,
  animatedGifNode: Film,
  [CANVAS_NODE_TYPES.upload]: Upload,
  [CANVAS_NODE_TYPES.imageEdit]: ImageIcon,
  [CANVAS_NODE_TYPES.imageGen]: ImageIcon,
  [CANVAS_NODE_TYPES.exportImage]: ImageIcon,
  [CANVAS_NODE_TYPES.beatContext]: Clapperboard,
  [CANVAS_NODE_TYPES.htmlArtifact]: FileText,
  [CANVAS_NODE_TYPES.textAnnotation]: FileText,
  [CANVAS_NODE_TYPES.group]: Folder,
  [CANVAS_NODE_TYPES.storyboardSplit]: LayoutGrid,
  [CANVAS_NODE_TYPES.storyboardGen]: LayoutGrid,
  [CANVAS_NODE_TYPES.video]: Play,
  [CANVAS_NODE_TYPES.audio]: AudioLines,
  [CANVAS_NODE_TYPES.videoStory]: Film,
  [CANVAS_NODE_TYPES.videoCompose]: Film,
  [CANVAS_NODE_TYPES.script]: ScrollText,
  [CANVAS_NODE_TYPES.pano360Viewer]: Globe,
  [CANVAS_NODE_TYPES.threeDWorld]: Box,
  [CANVAS_NODE_TYPES.skill]: Sparkles,
  [CANVAS_NODE_TYPES.style]: Palette,
};

/** The thumbnail uses the node's own picture; video/audio without a still fall back to an icon. */
function outlineThumbUrl(node: CanvasNode): string | null {
  const imageUrl = resolveNodeSourceImageUrl(node);
  if (imageUrl) {
    return imageUrl;
  }
  const preview = (node.data as { previewImageUrl?: unknown }).previewImageUrl;
  if (typeof preview === "string" && preview) {
    return preview;
  }
  // Things like the panorama viewer are not "image nodes" but their original is a single image, so use the original as the thumbnail.
  const asset = resolveNodePrimaryAsset(node);
  return asset?.kind === "image" ? asset.url : null;
}

/**
 * Download fetches the original, via the global "node -> original asset" mapping (`resolveNodePrimaryAsset`),
 * without recognizing fields here: a composed video's result is in `resultVideoUrl`, a video story's source in
 * `sourceVideoUrl`, a 3D world's package in `plyUrl`, and all of them also carry a cover image, so recognizing
 * fields by hand would download the poster as the video. Nodes without an original (text, scripts, etc.) fall back to their own picture.
 */
function outlineMediaUrl(node: CanvasNode): string | null {
  return resolveNodePrimaryAsset(node)?.url ?? outlineThumbUrl(node);
}

/**
 * The secondary line only supplies what the name does not say:
 * add the type when the name was edited by the user (or is a prompt), and do not repeat it when the name is already the default type name;
 * then add a creation time, to tell apart rows like "the same prompt generated three times" whose name and type are identical.
 *
 * The time reads `createdAt`, **not** `generationStartedAt`: the latter is a temporary field that every generation
 * chain writes back to null on success and failure (see VideoNode / ImageGenNode / each Overlay), visible only during
 * the few dozen seconds of spinning and gone once finished - exactly when you look back to find "which is which"
 * nothing is left. `createdAt` is set once by nodeFactory when the node is created and never changed afterwards.
 *
 * Use an absolute time rather than "3 minutes ago": relative time either calls Date.now() and pollutes the pure function, or shows
 * the stale value from the last render. Old canvases saved before the field was added have no createdAt; those rows fall back to the type only.
 */
function outlineMeta(
  node: CanvasNode,
  type: CanvasNodeType,
  name: string,
  t: TFunction,
): string | null {
  const parts: string[] = [];
  const typeLabel = localizeDefaultNodeDisplayName(type, node.data, t);
  if (typeLabel && typeLabel !== name) {
    parts.push(typeLabel);
  }
  const createdAt = (node.data as { createdAt?: unknown }).createdAt;
  if (typeof createdAt === "number" && Number.isFinite(createdAt) && createdAt > 0) {
    parts.push(formatOutlineStamp(createdAt));
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function formatOutlineStamp(epochMs: number): string {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toOutlineItem(node: CanvasNode, t: TFunction): CanvasOutlineItem {
  const type = node.type as CanvasNodeType;
  const group = isGroupNode(node);
  const name = localizeNodeDisplayName(type, node.data, t);
  return {
    id: node.id,
    kind: group ? "group" : "node",
    name,
    type,
    thumbUrl: group ? null : outlineThumbUrl(node),
    mediaUrl: group ? null : outlineMediaUrl(node),
    meta: group ? null : outlineMeta(node, type, name, t),
    children: [],
  };
}

/**
 * Flatten canvas nodes into an outline tree: groups become folders (the name is the group name) with members under them,
 * and the other nodes are laid flat at the top level. Nodes whose parent is missing (or not a group) go back to the top level, so no node is lost.
 */
export function buildCanvasOutline(nodes: CanvasNode[], t: TFunction): CanvasOutlineItem[] {
  const items = new Map<string, CanvasOutlineItem>();
  for (const node of nodes) {
    items.set(node.id, toOutlineItem(node, t));
  }

  const roots: CanvasOutlineItem[] = [];
  for (const node of nodes) {
    const item = items.get(node.id);
    if (!item) continue;
    const parent = node.parentId ? items.get(node.parentId) : undefined;
    if (parent && parent !== item && parent.kind === "group") {
      parent.children.push(item);
    } else {
      roots.push(item);
    }
  }
  return roots;
}

/** Groups may be nested; the count must include deep members too. */
export function countOutlineNodes(items: CanvasOutlineItem[]): number {
  return items.reduce(
    (total, item) => total + (item.kind === "node" ? 1 : 0) + countOutlineNodes(item.children),
    0,
  );
}

/**
 * Pre-order expansion into an id list: a parent always comes before its members.
 * duplicateNodesAsSiblings relies on this order to re-point the members' parentId to the newly cloned group.
 */
export function collectOutlineIds(item: CanvasOutlineItem): string[] {
  return [item.id, ...item.children.flatMap(collectOutlineIds)];
}

/** Downloading a group = downloading all its members, at every level, that carry resources. */
export function collectOutlineDownloads(item: CanvasOutlineItem): CanvasOutlineItem[] {
  const self = item.kind === "node" && item.mediaUrl ? [item] : [];
  return [...self, ...item.children.flatMap(collectOutlineDownloads)];
}

export type CanvasOutlineRowEntry = { item: CanvasOutlineItem; depth: number };

/**
 * Flatten the tree into "rows from top to bottom on screen" according to the current collapse state.
 * Virtualization can only fetch rows by index, so a recursively rendered structure does not work here.
 */
export function flattenCanvasOutline(
  items: CanvasOutlineItem[],
  collapsedGroupIds: ReadonlySet<string>,
  depth = 0,
  out: CanvasOutlineRowEntry[] = [],
): CanvasOutlineRowEntry[] {
  for (const item of items) {
    out.push({ item, depth });
    if (item.kind === "group" && !collapsedGroupIds.has(item.id)) {
      flattenCanvasOutline(item.children, collapsedGroupIds, depth + 1, out);
    }
  }
  return out;
}

/** Expand/collapse all needs to know which groups are in the tree, including nested groups. */
export function collectOutlineGroupIds(items: CanvasOutlineItem[]): string[] {
  return items.flatMap((item) =>
    item.kind === "group" ? [item.id, ...collectOutlineGroupIds(item.children)] : [],
  );
}

export type CanvasOutlineFilterKey =
  | "all"
  | "text"
  | "image"
  | "video"
  | "storyboard"
  | "beat"
  | "audio"
  | "script"
  | "world"
  | "skill"
  | "webpage";

/**
 * Type filtering is bucketed by "what the user sees", not by listing each node type -
 * image generation/edit/export look the same in the list, and splitting them would turn the menu into a wall.
 * Groups are not here: a folder is a container, and when filtering by type only what it holds matters.
 */
export const CANVAS_OUTLINE_FILTERS: ReadonlyArray<{
  key: CanvasOutlineFilterKey;
  types: readonly CanvasNodeType[];
}> = [
  { key: "all", types: [] },
  { key: "text", types: [CANVAS_NODE_TYPES.textAnnotation] },
  {
    key: "image",
    types: [
      CANVAS_NODE_TYPES.upload,
      CANVAS_NODE_TYPES.imageEdit,
      CANVAS_NODE_TYPES.imageGen,
      CANVAS_NODE_TYPES.exportImage,
      CANVAS_NODE_TYPES.vectorSvg,
      CANVAS_NODE_TYPES.animatedGif,
      // Style nodes do not exist independently; they are a projection of the style selected on an image node and are filtered together with the image.
      CANVAS_NODE_TYPES.style,
    ],
  },
  {
    key: "video",
    types: [
      CANVAS_NODE_TYPES.video,
      CANVAS_NODE_TYPES.videoStory,
      CANVAS_NODE_TYPES.videoCompose,
    ],
  },
  {
    key: "storyboard",
    types: [CANVAS_NODE_TYPES.storyboardSplit, CANVAS_NODE_TYPES.storyboardGen],
  },
  { key: "beat", types: [CANVAS_NODE_TYPES.beatContext] },
  { key: "audio", types: [CANVAS_NODE_TYPES.audio] },
  { key: "script", types: [CANVAS_NODE_TYPES.script] },
  { key: "world", types: [CANVAS_NODE_TYPES.pano360Viewer, CANVAS_NODE_TYPES.threeDWorld] },
  { key: "skill", types: [CANVAS_NODE_TYPES.skill] },
  { key: "webpage", types: [CANVAS_NODE_TYPES.htmlArtifact] },
];

export function outlineFilterTypes(key: CanvasOutlineFilterKey): readonly CanvasNodeType[] {
  return CANVAS_OUTLINE_FILTERS.find((filter) => filter.key === key)?.types ?? [];
}

/**
 * Fuzzy matching: first check for a substring, otherwise degrade to subsequence matching (characters only need to appear in order),
 * so "img107" can also hit "Image 107 - copy". An empty keyword always matches.
 *
 * A subsequence additionally requires the matched positions to be close together: otherwise in a node whose name is a whole prompt,
 * any two characters can be found in order within hundreds of characters, everything matches, and the filter is useless.
 */
export function matchesOutlineQuery(name: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  const haystack = name.toLowerCase();
  if (haystack.includes(needle)) {
    return true;
  }
  const chars = [...needle].filter((char) => char !== " ");
  let cursor = 0;
  let first = -1;
  for (const char of chars) {
    const index = haystack.indexOf(char, cursor);
    if (index < 0) {
      return false;
    }
    if (first < 0) {
      first = index;
    }
    cursor = index + 1;
  }
  return cursor - first <= chars.length * 4 + 8;
}

/**
 * Filter the outline by type + keyword. A group is kept as long as it still has members (only the matching members are kept);
 * when no member matches but the group name itself matches, the whole group is kept, so searching a folder name shows everything inside at once.
 */
export function filterCanvasOutline(
  items: CanvasOutlineItem[],
  options: { query: string; types: readonly CanvasNodeType[] },
): CanvasOutlineItem[] {
  const queryOff = options.query.trim() === "";
  const typesOff = options.types.length === 0;
  if (queryOff && typesOff) {
    return items;
  }
  const allowed = new Set(options.types);

  const walk = (list: CanvasOutlineItem[]): CanvasOutlineItem[] =>
    list.flatMap((item) => {
      if (item.kind === "node") {
        const typeHit = typesOff || allowed.has(item.type);
        return typeHit && matchesOutlineQuery(item.name, options.query) ? [item] : [];
      }
      const children = walk(item.children);
      if (children.length > 0) {
        return [{ ...item, children }];
      }
      return typesOff && !queryOff && matchesOutlineQuery(item.name, options.query) ? [item] : [];
    });

  return walk(items);
}

/**
 * The outline only cares about "which nodes exist, what they are called, who they hang under, what the thumbnail is", not coordinates.
 * While dragging the canvas, nodes gets a new reference every frame, and subscribing to nodes directly would re-render this table of hundreds of rows each frame;
 * after subscribing to this signature, it only re-renders when a field that actually affects the list changes.
 */
export function canvasOutlineSignature(nodes: CanvasNode[]): string {
  return nodes
    .map((node) => {
      const type = node.type as CanvasNodeType;
      return [
        node.id,
        type,
        node.parentId ?? "",
        resolveNodeDisplayName(type, node.data),
        (isGroupNode(node) ? null : outlineThumbUrl(node)) ?? "",
        (isGroupNode(node) ? null : outlineMediaUrl(node)) ?? "",
        // The signature only decides "did the canvas change" and never reaches the UI, so it takes language-independent raw values -
        // switching language should not change the signature; that is the job of the t dependency of useMemo.
        String((node.data as { createdAt?: unknown }).createdAt ?? ""),
      ].join("\u0001");
    })
    .join("\u0002");
}

const FILE_EXTENSION_PATTERN = /\.([a-z0-9]{2,5})$/i;

/** Download file name: first the original name from upload, otherwise "display name + extension guessed from the URL". */
function outlineDownloadFilename(item: CanvasOutlineItem, url: string): string {
  const node = useCanvasStore.getState().nodes.find((candidate) => candidate.id === item.id);
  const sourceFileName = (node?.data as { sourceFileName?: unknown } | undefined)?.sourceFileName;
  if (typeof sourceFileName === "string" && sourceFileName.trim()) {
    return sourceFileName.trim();
  }
  const path = url.split(/[?#]/, 1)[0] ?? "";
  const extension = FILE_EXTENSION_PATTERN.exec(path)?.[1]?.toLowerCase() ?? "png";
  return `${item.name}.${extension}`;
}

export function CanvasOutlineList({
  collapsed = false,
  leading,
}: {
  collapsed?: boolean;
  /** Content placed at the far left of the toolbar (the canvas picker). When given it replaces the "canvas elements" label. */
  leading?: ReactNode;
} = {}) {
  const { t } = useTranslation();
  // Collapsing the drawer is a pure CSS translation and the component does not unmount - without short-circuiting, while the user drags the canvas
  // with the drawer collapsed this signature would still concatenate hundreds of nodes (including prompt names of possibly hundreds of characters) into a big string every frame, then discard it.
  // Returning the constant "" makes zustand's equality check skip the re-render; recompute once when it expands.
  const signature = useCanvasStore((state) =>
    collapsed ? "" : canvasOutlineSignature(state.nodes),
  );
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<ReadonlySet<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [filterKey, setFilterKey] = useState<CanvasOutlineFilterKey>("all");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");

  const outline = useMemo(
    // Rebuild only when the signature changes; read nodes fresh from the store so nodes is not subscribed too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => buildCanvasOutline(useCanvasStore.getState().nodes, t),
    [signature, t],
  );

  const filtering = filterKey !== "all" || query.trim() !== "";
  const visible = useMemo(
    () => filterCanvasOutline(outline, { query, types: outlineFilterTypes(filterKey) }),
    [outline, query, filterKey],
  );
  const total = useMemo(() => countOutlineNodes(visible), [visible]);

  // Ignore the collapse state when filtering/searching, otherwise a hit might be hidden inside a collapsed group.
  const effectiveCollapsed = filtering ? NO_COLLAPSED_GROUPS : collapsedGroupIds;
  const rows = useMemo(
    () => flattenCanvasOutline(visible, effectiveCollapsed),
    [visible, effectiveCollapsed],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  // Small canvases render the whole tree as usual: in jsdom the scroll container height is always 0 and virtualization would render no rows at all;
  // taking the original path below the threshold keeps this from breaking the render tests and "open and see content right away" screenshots.
  const virtualized = rows.length > OUTLINE_VIRTUALIZE_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: virtualized ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => OUTLINE_ROW_STRIDE_PX,
    overscan: 8,
  });

  const groupIds = useMemo(() => collectOutlineGroupIds(outline), [outline]);
  const allCollapsed =
    groupIds.length > 0 && groupIds.every((groupId) => collapsedGroupIds.has(groupId));

  const toggleAllGroups = useCallback(() => {
    setCollapsedGroupIds((previous) => {
      const everyCollapsed = groupIds.length > 0 && groupIds.every((id) => previous.has(id));
      return everyCollapsed ? new Set<string>() : new Set(groupIds);
    });
  }, [groupIds]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
  }, []);

  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroupIds((previous) => {
      const next = new Set(previous);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  // Selection goes through ReactFlow's select change: canvasStore syncs it into selectedNodeId,
  // and changing selectedNodeId directly would be overwritten by Canvas's reverse sync.
  const focusNode = useCallback((nodeId: string) => {
    const store = useCanvasStore.getState();
    store.onNodesChange(
      store.nodes.map((node) => ({
        type: "select" as const,
        id: node.id,
        selected: node.id === nodeId,
      })),
    );
    store.requestFocusNode(nodeId);
  }, []);

  // When duplicating a group the members must be passed too, with the parent before the members (collectOutlineIds is pre-order).
  const duplicateItem = useCallback((item: CanvasOutlineItem) => {
    useCanvasStore.getState().duplicateNodesAsSiblings(collectOutlineIds(item));
  }, []);

  const commitRename = useCallback((item: CanvasOutlineItem, rawName: string) => {
    setRenamingId(null);
    const name = rawName.trim();
    if (!name || name === item.name) {
      return;
    }
    // A group frame's name was historically written on label; write both so an edit is not overwritten back by the old field.
    useCanvasStore
      .getState()
      .updateNodeData(item.id, item.kind === "group" ? { displayName: name, label: name } : { displayName: name });
  }, []);

  // There is no packaged download for groups, so save one by one in member order; a failure of one does not affect the later ones.
  const downloadItem = useCallback(async (item: CanvasOutlineItem) => {
    const targets = collectOutlineDownloads(item);
    for (const target of targets) {
      if (!target.mediaUrl) continue;
      try {
        await downloadUrlAsFile(target.mediaUrl, outlineDownloadFilename(target, target.mediaUrl));
      } catch (error) {
        console.error("Failed to download canvas node", target.id, error);
      }
    }
  }, []);

  // The two render paths (whole tree / windowed) share one set of callbacks; do not write them twice.
  const rowProps = {
    collapsedGroupIds: effectiveCollapsed,
    selectedNodeId,
    renamingId,
    onToggleGroup: toggleGroup,
    onFocusNode: focusNode,
    onDuplicate: duplicateItem,
    onStartRename: setRenamingId,
    onCommitRename: commitRename,
    onDownload: downloadItem,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 pb-1.5 pl-2 pr-3 pt-2.5">
        {searchOpen ? (
          <OutlineSearchInput value={query} onChange={setQuery} onClose={closeSearch} />
        ) : (
          <>
            {/* When there is a canvas picker it is this row's identity; adding a "canvas elements" label as well would be redundant */}
            {leading ?? (
              <span className="shrink-0 text-[10px] font-semibold tracking-[0.09em] text-text-muted/85">
                {t("freezone.canvasOutline.title")}
              </span>
            )}
            {groupIds.length > 0 && (
              <OutlineIconButton
                label={t(
                  allCollapsed
                    ? "freezone.canvasOutline.expandAll"
                    : "freezone.canvasOutline.collapseAll",
                )}
                onClick={toggleAllGroups}
              >
                {/* Collapsed shows the branch (clicking expands), expanded shows the collapse arrow */}
                {allCollapsed ? (
                  <ListTree className="h-3.5 w-3.5" />
                ) : (
                  <ListCollapse className="h-3.5 w-3.5" />
                )}
              </OutlineIconButton>
            )}
            <span className="flex-1" />
            {filtering && (
              <span className="shrink-0 text-[11px] tabular-nums text-text-muted/70">
                {t("freezone.canvasOutline.matched", { count: total })}
              </span>
            )}
          </>
        )}
        <OutlineTypeFilter compact={searchOpen} value={filterKey} onChange={setFilterKey} />
        {searchOpen ? (
          <OutlineIconButton
            label={t("freezone.canvasOutline.closeSearch")}
            onClick={closeSearch}
          >
            <X className="h-3.5 w-3.5" />
          </OutlineIconButton>
        ) : (
          <OutlineIconButton
            label={t("freezone.canvasOutline.search")}
            onClick={() => setSearchOpen(true)}
          >
            <Search className="h-3.5 w-3.5" />
          </OutlineIconButton>
        )}
      </div>
      {/* The horizontal padding is moved onto the row (see ROW_INSET_PX) so the row can fill the container width -
          the hover background is painted on the row, and container padding would shave a piece off its left. */}
      <div
        ref={scrollRef}
        className="ui-scrollbar-vertical min-h-0 flex-1 overflow-y-auto pb-2 pl-1 pr-2"
      >
        {outline.length === 0 ? (
          <div className="px-1 py-6 text-center text-xs text-text-muted/70">
            {t("freezone.canvasOutline.empty")}
          </div>
        ) : rows.length === 0 ? (
          <div className="px-1 py-6 text-center text-xs text-text-muted/70">
            {t("freezone.canvasOutline.noMatch")}
          </div>
        ) : virtualized ? (
          <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const entry = rows[virtualRow.index];
              return (
                <div
                  key={entry.item.id}
                  className="absolute inset-x-0 top-0"
                  style={{ height: OUTLINE_ROW_STRIDE_PX, transform: `translateY(${virtualRow.start}px)` }}
                >
                  <CanvasOutlineRow {...rowProps} item={entry.item} depth={entry.depth} />
                </div>
              );
            })}
          </div>
        ) : (
          rows.map((entry) => (
            <CanvasOutlineRow
              {...rowProps}
              key={entry.item.id}
              item={entry.item}
              depth={entry.depth}
            />
          ))
        )}
      </div>
    </div>
  );
}

const NO_COLLAPSED_GROUPS: ReadonlySet<string> = new Set();

/**
 * Row height is hard-coded so virtualization can position by index without measuring.
 * The stride is 1px more than the row height; that 1px is the gap between rows - the hover background does not stick together with the rows above and below.
 */
/** Corresponds to `h-11` (44px) + `mb-px` (1px) on the row. Change one and the other must follow. */
const OUTLINE_ROW_STRIDE_PX = 45;
/** Below this count render the whole tree: the gain of windowing does not outweigh its awkwardness in jsdom / on the first frame. */
const OUTLINE_VIRTUALIZE_THRESHOLD = 60;

const HEADER_ICON_BUTTON_CLASS =
  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted transition hover:bg-[rgb(var(--text-rgb)/0.1)] hover:text-text-dark";

const TOOLTIP_CONTENT_CLASS =
  "z-[130] rounded-md border border-[var(--ui-border-soft)] bg-surface-dark px-2 py-1 text-[11px] text-text-dark shadow-lg";

/** Icon button on the toolbar: hover shows a custom tooltip instead of the browser's slow native title. */
function OutlineIconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <TooltipProvider delay={120}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={label}
              onClick={onClick}
              className={HEADER_ICON_BUTTON_CLASS}
            />
          }
        >
          {children}
        </TooltipTrigger>
        <TooltipContent side="bottom" showArrow={false} className={TOOLTIP_CONTENT_CLASS}>
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

const FILTER_MENU_CONTENT_CLASS =
  "z-[120] min-w-[132px] border-[var(--ui-border-soft)] bg-[rgba(var(--surface-rgb)/0.95)] text-text-dark shadow-none backdrop-blur-3xl";

/** Type filter: collapses into an icon when the search box is expanded, yielding to the input. */
function OutlineTypeFilter({
  compact,
  value,
  onChange,
}: {
  compact: boolean;
  value: CanvasOutlineFilterKey;
  onChange: (key: CanvasOutlineFilterKey) => void;
}) {
  const { t } = useTranslation();
  const active = value !== "all";
  const label = t(`freezone.canvasOutline.types.${value}`);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t("freezone.canvasOutline.filter")}
            title={compact ? `${t("freezone.canvasOutline.filter")}: ${label}` : undefined}
            className={
              "inline-flex h-6 shrink-0 items-center gap-1 px-1 text-[11px] transition-colors hover:text-text-dark " +
              (active
                ? "text-primary"
                : "text-text-muted")
            }
          />
        }
      >
        {compact ? (
          <ListFilter className="h-3.5 w-3.5" />
        ) : (
          <>
            <span className="max-w-[72px] truncate">{label}</span>
            <ChevronDown className="h-3 w-3 opacity-60" />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent className={FILTER_MENU_CONTENT_CLASS} align="end">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(next as CanvasOutlineFilterKey)}
        >
          {CANVAS_OUTLINE_FILTERS.map((filter) => (
            <DropdownMenuRadioItem
              key={filter.key}
              value={filter.key}
              // base-ui's single-select items do not close the menu by default; close it once an item is chosen.
              closeOnClick
              className="rounded-[var(--ui-radius-lg)] text-xs text-text-dark focus:bg-[rgb(var(--text-rgb)/0.075)] focus:text-text-dark"
            >
              {t(`freezone.canvasOutline.types.${filter.key}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function OutlineSearchInput({
  value,
  onChange,
  onClose,
}: {
  value: string;
  onChange: (next: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="relative flex min-w-0 flex-1 items-center">
      <input
        value={value}
        autoFocus
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // The canvas layer listens to global keys; typing in the search box must not leak through.
          event.stopPropagation();
          if (event.key === "Escape") onClose();
        }}
        placeholder={t("freezone.canvasOutline.search")}
        className="h-6 w-full rounded-md border border-[var(--ui-border-soft)] bg-[rgb(var(--text-rgb)/0.04)] pl-2 pr-6 text-[11px] text-text-dark outline-none transition placeholder:text-text-muted/70 focus:border-[var(--ui-border-strong)]"
      />
      <Search className="pointer-events-none absolute right-2 h-3 w-3 text-text-muted/70" />
    </div>
  );
}

const MENU_CONTENT_CLASS =
  "z-[120] min-w-[140px] border-[var(--ui-border-soft)] bg-[rgba(var(--surface-rgb)/0.95)] text-text-dark shadow-none backdrop-blur-3xl";
const MENU_ITEM_CLASS =
  "gap-2 rounded-[var(--ui-radius-lg)] text-xs text-text-dark focus:bg-[rgb(var(--text-rgb)/0.075)] focus:text-text-dark";

type OutlineRowProps = {
  item: CanvasOutlineItem;
  depth: number;
  collapsedGroupIds: ReadonlySet<string>;
  selectedNodeId: string | null;
  renamingId: string | null;
  onToggleGroup: (groupId: string) => void;
  onFocusNode: (nodeId: string) => void;
  onDuplicate: (item: CanvasOutlineItem) => void;
  onStartRename: (itemId: string | null) => void;
  onCommitRename: (item: CanvasOutlineItem, name: string) => void;
  onDownload: (item: CanvasOutlineItem) => void;
};

/** Left padding inside the row: the thumbnail is still 8px from the panel, and the hover background can extend 4px further left to wrap it. */
const ROW_INSET_PX = 4;

const THUMB_CLASS =
  // ring rather than border: border would stretch 36px to 38px and misalign with the empty thumbnail's icon box.
  "relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-[8px] bg-[rgb(var(--text-rgb)/0.05)] ring-1 ring-inset ring-[rgb(var(--text-rgb)/0.09)]";

/** The thumbnail is itself the type of content; adding an "image" badge on top is just noise. */
const PLAIN_IMAGE_TYPES: ReadonlySet<CanvasNodeType> = new Set([
  CANVAS_NODE_TYPES.upload,
  CANVAS_NODE_TYPES.imageEdit,
  CANVAS_NODE_TYPES.imageGen,
  CANVAS_NODE_TYPES.exportImage,
]);



const CanvasOutlineRow = memo(function CanvasOutlineRow(props: OutlineRowProps) {
  const {
    item,
    depth,
    collapsedGroupIds,
    selectedNodeId,
    renamingId,
    onToggleGroup,
    onFocusNode,
  } = props;
  const { t } = useTranslation();
  const indent = { paddingLeft: `${ROW_INSET_PX + depth * 14}px` };
  const selected = selectedNodeId === item.id;
  const renaming = renamingId === item.id;
  const collapsed = collapsedGroupIds.has(item.id);

  const rowClass =
    // h-11 / mb-px must match OUTLINE_ROW_STRIDE_PX: virtualization does not measure height and positions by stride.
    // Do not write a template string like `h-[${...}px]` here - Tailwind scans literals in the source,
    // and class names assembled at runtime do not reach the output (the same pitfall as the mask-image one).
    "ui-outline-row group/row relative mb-px flex h-11 w-full items-center gap-2 rounded-[8px] pr-1.5 transition-colors duration-150 " +
    // Selection uses a low-opacity layer of the product primary color, hover stays neutral, and no extra vertical bar repeats the state.
    (selected
      ? "bg-primary/[0.14] ring-1 ring-inset ring-primary/20"
      : "hover:bg-[rgb(var(--text-rgb)/0.05)]");
  const leadClass = "flex h-full min-w-0 flex-1 items-center gap-2 text-left";

  const lead =
    item.kind === "group" ? (
      <>
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted/70" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted/70" />
        )}
        <span className={THUMB_CLASS}>
          {collapsed ? (
            <Folder className="h-3.5 w-3.5 text-text-muted" />
          ) : (
            <FolderOpen className="h-3.5 w-3.5 text-text-muted" />
          )}
        </span>
      </>
    ) : (
      <>
        <span className={THUMB_CLASS}>
          {item.thumbUrl ? (
            <img src={item.thumbUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
          ) : (
            <OutlineNodeIcon type={item.type} />
          )}
          {/* For a node with a picture, the thumbnail alone cannot tell video from 3D - and the fallback icon only shows when there is no picture,
              which is exactly the case that needs the hint least. */}
          {item.thumbUrl && !PLAIN_IMAGE_TYPES.has(item.type) ? (
            <OutlineTypeBadge type={item.type} />
          ) : null}
        </span>
      </>
    );

  const body = renaming ? (
    // While renaming, the whole row can no longer be a <button>; an input is not allowed inside a button.
    <div className={leadClass}>
      {lead}
      <OutlineRenameInput
        item={item}
        onCommit={props.onCommitRename}
        onCancel={props.onStartRename}
      />
    </div>
  ) : (
    <button
      type="button"
      title={item.name}
      aria-expanded={item.kind === "group" ? !collapsed : undefined}
      onClick={() => (item.kind === "group" ? onToggleGroup(item.id) : onFocusNode(item.id))}
      className={leadClass}
    >
      {lead}
      <span className="ui-outline-row-name flex min-w-0 flex-1 flex-col justify-center gap-px">
        <span
          className={
            "truncate text-xs leading-4 transition-colors" +
            (item.kind === "group" ? " pr-7 font-medium" : "") +
            (selected ? " font-medium text-text-dark" : " text-text-dark/85")
          }
        >
          {item.name}
        </span>
        {/* When names collide (the same prompt generated three times) this line tells them apart - see outlineMeta;
            the time comes from the persistent createdAt, do not change it back to generationStartedAt which is cleared once the run finishes */}
        {item.meta && (
          <span className="truncate text-xs leading-4 text-text-muted/75">{item.meta}</span>
        )}
      </span>
    </button>
  );

  const row = (
    <div style={indent} className={rowClass}>
      {body}
      {item.kind === "group" && !renaming && (
        <span className="pointer-events-none absolute right-2 text-[10px] tabular-nums text-text-muted/70 transition-opacity group-hover/row:opacity-0">
          {t("freezone.canvasOutline.groupMembers", { count: countOutlineNodes(item.children) })}
        </span>
      )}
      {!renaming && <OutlineRowActions {...props} />}
    </div>
  );

  return row;
});

function OutlineNodeIcon({ type }: { type: CanvasNodeType }) {
  const Icon = NODE_TYPE_ICON[type] ?? ImageIcon;
  return <Icon className="h-3.5 w-3.5 text-text-muted" />;
}

/** The type badge at the thumbnail's bottom-right; it sits over the picture so it brings its own background. */
function OutlineTypeBadge({ type }: { type: CanvasNodeType }) {
  const Icon = NODE_TYPE_ICON[type] ?? ImageIcon;
  return (
    <span className="pointer-events-none absolute bottom-0 right-0 flex h-3.5 w-3.5 items-center justify-center rounded-tl-[5px] bg-[rgb(var(--surface-rgb)/0.85)] backdrop-blur-[2px]">
      <Icon className="h-2.5 w-2.5 text-text-dark/75" />
    </span>
  );
}

/** The group of actions revealed only on hover: more menu + locate, following libtv's row-end layout. */
function OutlineRowActions({ item, onFocusNode, onDuplicate, onStartRename, onDownload }: OutlineRowProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  // When the menu closes base-ui steals focus back to the trigger button, so renaming waits until it has fully closed before mounting the input.
  const renameQueuedRef = useRef(false);
  const downloadable = collectOutlineDownloads(item).length > 0;
  const iconButtonClass =
    "inline-flex h-6 w-6 items-center justify-center rounded-md text-text-muted transition hover:bg-[rgb(var(--text-rgb)/0.1)] hover:text-text-dark";

  return (
    <div
      className={
        // Float over the name instead of pushing it aside; together with NAME_FADE_CLASS's fade-out, nothing in the row moves on hover.
        "absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 transition-opacity duration-150 group-hover/row:opacity-100 " +
        (menuOpen ? "opacity-100" : "pointer-events-none opacity-0 group-hover/row:pointer-events-auto")
      }
    >
      <DropdownMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        onOpenChangeComplete={(open) => {
          if (open || !renameQueuedRef.current) return;
          renameQueuedRef.current = false;
          onStartRename(item.id);
        }}
      >
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={t("freezone.canvasOutline.moreActions")}
              title={t("freezone.canvasOutline.moreActions")}
              className={iconButtonClass}
            />
          }
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className={MENU_CONTENT_CLASS} align="end">
          <DropdownMenuItem className={MENU_ITEM_CLASS} onClick={() => onDuplicate(item)}>
            <Copy className="h-3.5 w-3.5" />
            <span>{t("freezone.canvasOutline.duplicate")}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            className={MENU_ITEM_CLASS}
            onClick={() => {
              renameQueuedRef.current = true;
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
            <span>{t("freezone.canvasOutline.rename")}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            className={MENU_ITEM_CLASS}
            disabled={!downloadable}
            onClick={() => void onDownload(item)}
          >
            <Download className="h-3.5 w-3.5" />
            <span>{t("freezone.canvasOutline.download")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        type="button"
        onClick={() => onFocusNode(item.id)}
        aria-label={t("freezone.canvasOutline.locate")}
        title={t("freezone.canvasOutline.locate")}
        className={iconButtonClass}
      >
        <Navigation className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function OutlineRenameInput({
  item,
  onCommit,
  onCancel,
}: {
  item: CanvasOutlineItem;
  onCommit: (item: CanvasOutlineItem, name: string) => void;
  onCancel: (itemId: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Do not honor blur on the first beat after mount: a blur then can only mean something else is stealing focus, not that the user clicked away.
  const readyRef = useRef(false);
  const [value, setValue] = useState(item.name);

  useEffect(() => {
    inputRef.current?.select();
    const timer = window.setTimeout(() => {
      readyRef.current = true;
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <input
      ref={inputRef}
      value={value}
      autoFocus
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        if (!readyRef.current) {
          inputRef.current?.focus();
          return;
        }
        onCommit(item, value);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          onCommit(item, value);
        } else if (event.key === "Escape") {
          onCancel(null);
        }
      }}
      className="min-w-0 flex-1 rounded-md border border-[var(--ui-border-soft)] bg-[rgb(var(--text-rgb)/0.06)] px-1.5 py-0.5 text-xs text-text-dark outline-none focus:border-[var(--ui-border-strong)]"
    />
  );
}
