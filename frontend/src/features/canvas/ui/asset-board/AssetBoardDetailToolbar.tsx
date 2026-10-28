// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown,
  ChevronRight,
  Download,
  FastForward,
  Film,
  Grid2x2,
  Grid3x3,
  ImageUpscale,
  LayoutDashboard,
  LayoutGrid,
  Loader2,
  Maximize2,
  MoreHorizontal,
  Mountain,
  Package,
  RefreshCw,
  Rewind,
  Scissors,
  Star,
  User,
  Users,
  Wand2,
  type LucideIcon,
} from 'lucide-react';

import type {
  FreezoneVideoUpscaleResolution,
} from '@/api/ops';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/shadcn/dropdown-menu';
import { spawnAssetBoardImageOpNode } from '@/features/canvas/application/assetBoardImageOps';
import { type GridActionKey } from '@/features/canvas/application/gridTemplateAction';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import {
  canRegenerateExportImageNode,
  regenerateExportImageNode,
} from '@/features/canvas/application/regenerateExportNode';
import {
  createVideoUpscaleResultNode,
  submitVideoUpscale,
  VIDEO_UPSCALE_RESOLUTIONS,
  VIDEO_UPSCALE_RESOLUTION_LABEL,
} from '@/features/canvas/application/videoUpscale';
import {
  CANVAS_NODE_TYPES,
  isAudioNode,
  isImageEditNode,
  isPendingUpscaleNode,
  isVideoComposeNode,
  isVideoNode,
  resolveNodeSourceImageUrl,
  type CanvasNode,
  type CanvasNodeData,
} from '@/features/canvas/domain/canvasNodes';
import {
  KEY_ELEMENT_CATEGORY_KEYS,
  KEY_ELEMENT_CATEGORY_LABEL,
  readKeyElementCategory,
} from '@/features/canvas/domain/keyElements';
import { CANVAS_NODE_TOOLBAR_SURFACE_CLASS } from '@/features/canvas/ui/nodeFrameStyles';
import {
  AssetBoardImageOps,
  useAssetBoardImageEditActions,
} from './AssetBoardImageEditMenu';
import {
  DetailToolbarButton,
  DETAIL_TOOLBAR_BUTTON_CLASS,
} from './AssetBoardToolbarButton';
import { VideoComposeModal } from '@/features/canvas/compose/VideoComposeModal';
import type { ComposeTimelineState } from '@/features/canvas/compose/timelineModel';
import { downloadUrlAsFile } from '@/lib/browserDownload';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

// The button component lives in AssetBoardToolbarButton (breaking the cycle with AssetBoardImageEditMenu's
// import); re-exported here so existing import paths (text/video toolbars etc.) stay unchanged.
export { DetailToolbarButton };

// Item styles of the "..." more menu (panel rounded-lg, item hover bg-white/5, consistent with this branch's system).
const MORE_MENU_ITEM_CLASS =
  'flex w-full items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-left text-[12px] text-white/80 transition-colors hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-45';

/** Leaf action item in the "..." more menu (for images: upscale/crop/rotate; for the video header: node actions). */
interface MoreMenuAction {
  kind: 'action';
  key: string;
  icon: LucideIcon;
  label: string;
  /** In progress: the icon becomes a spinner and is disabled (same feedback as toolbar buttons, e.g. matting in flight). */
  busy?: boolean;
  /** In the "expanded/active" state (e.g. highlighted while the history list is open). */
  active?: boolean;
  onSelect: () => void;
}

/** Expandable submenu item in the "..." more menu (grid templates: click/hover to expand 9 templates). */
interface MoreMenuSubmenu {
  kind: 'submenu';
  key: string;
  icon: LucideIcon;
  label: string;
  /** Alternate text shown while a submission is in flight (e.g. "Multi-camera 3x3"); non-empty shows a spinner. */
  pendingLabel?: string | null;
  disabled?: boolean;
  /** Sub-items are text + gray text on the right only: the fly-out panel is narrow (140px), and adding an icon would squeeze the label onto two lines. */
  children: Array<{
    key: string;
    label: string;
    /** Gray text on the right (e.g. "Current"). */
    hint?: string;
    onSelect: () => void;
  }>;
}

export type MoreMenuEntry = MoreMenuAction | MoreMenuSubmenu;

const MORE_MENU_CLOSE_DELAY_MS = 140;

/** Minimum width of the submenu fly-out panel and its gap to the parent item (used to compute coordinates, hence numbers not classes). */
const SUBMENU_MIN_WIDTH = 140;
const SUBMENU_GAP = 6;

/** The submenu being expanded: which item + the fixed coordinates of the fly-out panel. */
interface SubmenuPlacement {
  key: string;
  top: number;
  left: number;
}

/**
 * Compute the position of the submenu fly-out panel: top edge aligned with the parent item, opening to the **right** by default (the direction the user specified).
 * It is computed rather than `absolute left-full` because the storyboard overlay is itself a z-30 positioned layer,
 * and no z-index inside it can get above the right-hand z-45 chat drawer - a pure-CSS panel opening to the right
 * is covered by the drawer (user feedback: "it is blocked"). So the panel is portaled to body and placed with fixed coordinates,
 * so it can float above the drawer.
 *
 * When the right side really hits the viewport edge (narrow window) it flips to the left; better to change direction than to be half off-screen.
 */
function placeSubmenu(key: string, anchor: HTMLElement): SubmenuPlacement {
  const rect = anchor.getBoundingClientRect();
  const right = rect.right + SUBMENU_GAP;
  const left =
    right + SUBMENU_MIN_WIDTH > window.innerWidth
      ? Math.max(SUBMENU_GAP, rect.left - SUBMENU_GAP - SUBMENU_MIN_WIDTH)
      : right;
  return { key, top: rect.top, left };
}

/**
 * "Set key element" submenu item: mark this node as a key element and categorize it (character/scene/object/other)
 * or remove the mark. The mark only writes the node's data.keyElementCategory (see domain/keyElements), and the key element bar
 * at the top of the storyboard stays pinned accordingly. The image toolbar's "..." and the video detail header's "..." share this one,
 * keeping labels, current-state marker and the remove item identical in both places.
 */
export function keyElementMenuEntry(
  node: CanvasNode,
  updateNodeData: (nodeId: string, patch: Partial<CanvasNodeData>) => void,
): MoreMenuSubmenu {
  const current = readKeyElementCategory(node.data as Record<string, unknown>);
  return {
    kind: 'submenu',
    key: 'keyElement',
    icon: Star,
    label: current ? i18n.t('canvas.assetBoard.keyElement.labelWithCategory', { category: KEY_ELEMENT_CATEGORY_LABEL[current] }) : i18n.t('canvas.assetBoard.keyElement.set'),
    children: [
      ...KEY_ELEMENT_CATEGORY_KEYS.map((category) => ({
        key: `key-${category}`,
        label: KEY_ELEMENT_CATEGORY_LABEL[category],
        hint: current === category ? i18n.t('canvas.assetBoard.keyElement.current') : undefined,
        onSelect: () =>
          updateNodeData(node.id, { keyElementCategory: category } as Partial<CanvasNodeData>),
      })),
      ...(current
        ? [
            {
              key: 'key-clear',
              label: i18n.t('canvas.assetBoard.keyElement.clear'),
              onSelect: () =>
                updateNodeData(node.id, { keyElementCategory: null } as Partial<CanvasNodeData>),
            },
          ]
        : []),
    ],
  };
}

/**
 * The "..." more menu in detail: tucks low-frequency actions from always-visible buttons into a hover-expanded dropdown panel. The image toolbar's
 * one holds the three edit items (upscale/crop/rotate), the detail header's one holds node-level actions (set key element etc.). Grid
 * templates are not in this list - they are a standalone dropdown button on the always-visible toolbar (user request).
 *
 * - Mainly hover: moving into the icon or panel keeps it open, moving out collapses after a delay of {@link MORE_MENU_CLOSE_DELAY_MS}ms
 *   (debounced, so passing over does not flash); clicking the icon also toggles it.
 * - Keyboard accessible: focus landing on the trigger/any item expands it (onFocus bubbles), and focus leaving as a whole collapses it;
 *   Esc collapses and returns focus to the trigger.
 * - The panel is absolutely positioned below the trigger, right-aligned, z-50 above the detail body; styles match this branch's system.
 * - The submenu flies out to the **right** as a standalone panel with its top edge aligned to the parent item, instead of expanding the sub-items
 *   in place under the parent (the reference style and direction the user specified). The panel is portaled to body and placed with fixed coordinates,
 *   see {@link placeSubmenu} - staying in this tree it would be covered by the right chat drawer.
 * - Leaf items do not close the menu on click (hover menu convention: only moving away/Esc closes), so continuous actions and in-flight feedback stay visible.
 */
export function DetailMoreMenu({
  entries,
  triggerClassName,
  triggerLabel = i18n.t('canvas.assetBoard.detailToolbar.moreActions'),
}: {
  entries: MoreMenuEntry[];
  /** Trigger style: the default toolbar button; the one in the detail header passes the header icon button's class. */
  triggerClassName?: string;
  /**
   * Accessible name of the trigger. An image detail has a "..." in both the header and the toolbar (the former for node actions,
   * the latter for asset actions); the same name would confuse screen readers and tests alike, so the header one passes
   * "Node actions".
   */
  triggerLabel?: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<SubmenuPlacement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const submenuRef = useRef<HTMLDivElement | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);
  const openNow = useCallback(() => {
    clearCloseTimer();
    setOpen(true);
  }, [clearCloseTimer]);
  const closeNow = useCallback(() => {
    clearCloseTimer();
    setOpen(false);
    setSubmenu(null);
  }, [clearCloseTimer]);
  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      setOpen(false);
      setSubmenu(null);
    }, MORE_MENU_CLOSE_DELAY_MS);
  }, [clearCloseTimer]);
  // On unmount clear any pending collapse timer (the detail remounts as a whole by key={node.id}, which goes through here).
  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  /** Expand a submenu and compute its fixed coordinates from the anchor on the spot (see placeSubmenu). */
  const openSubmenu = useCallback((key: string, anchor: HTMLElement) => {
    setSubmenu(placeSubmenu(key, anchor));
  }, []);

  const handleBlur = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      // Focus leaves the menu as a whole (the next focus is neither inside the wrapper nor inside the flown-out submenu panel) ->
      // collapse. The submenu panel is portaled to body and is no longer a DOM descendant of the wrapper, so it must be asked
      // separately, otherwise the menu would close itself the instant Tab moves into a sub-item.
      const next = event.relatedTarget as Node | null;
      if (event.currentTarget.contains(next)) return;
      if (submenuRef.current?.contains(next)) return;
      closeNow();
    },
    [closeNow],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape' && open) {
        event.stopPropagation();
        closeNow();
        triggerRef.current?.focus();
      }
    },
    [closeNow, open],
  );

  return (
    <div
      className="relative inline-flex"
      onMouseEnter={openNow}
      onMouseLeave={scheduleClose}
      onFocus={openNow}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={triggerLabel}
        aria-haspopup="true"
        aria-expanded={open}
        title={triggerLabel}
        onClick={() => (open ? closeNow() : openNow())}
        className={triggerClassName ?? DETAIL_TOOLBAR_BUTTON_CLASS}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          aria-label={i18n.t('canvas.assetBoard.detailToolbar.moreActions')}
          className="absolute right-0 top-full z-50 mt-1.5 min-w-[210px] rounded-lg border border-white/10 bg-[#2e2e2e] p-1 text-white/85 shadow-xl"
        >
          {entries.map((entry) => {
            if (entry.kind === 'submenu') {
              const Icon = entry.icon;
              const placement = submenu?.key === entry.key ? submenu : null;
              const pending = Boolean(entry.pendingLabel);
              return (
                <div
                  key={entry.key}
                  onMouseEnter={(event) => !entry.disabled && openSubmenu(entry.key, event.currentTarget)}
                >
                  <button
                    type="button"
                    aria-haspopup="true"
                    aria-expanded={placement !== null}
                    disabled={entry.disabled}
                    onClick={(event) =>
                      placement
                        ? setSubmenu(null)
                        : openSubmenu(entry.key, event.currentTarget)
                    }
                    className={`${MORE_MENU_ITEM_CLASS} ${placement ? 'bg-white/5 text-white' : ''}`}
                  >
                    {pending ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                    ) : (
                      <Icon className="h-4 w-4 shrink-0" />
                    )}
                    <span className="flex-1">{entry.pendingLabel ?? entry.label}</span>
                    {/* The arrow does not rotate 90 degrees on expand: the panel flies out sideways, and the right-pointing arrow already points the way it goes. */}
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-white/40" />
                  </button>
                  {placement &&
                    createPortal(
                      // Portaled to body + fixed coordinates: the storyboard overlay is a z-30 positioned layer,
                      // and a panel left inside it cannot get above the right-hand z-45 chat drawer (see placeSubmenu).
                      // Moving the mouse across the gap from the parent item into the panel first fires the wrapper's onMouseLeave,
                      // so enter/leave are caught here to cancel the collapse timer.
                      <div
                        ref={submenuRef}
                        aria-label={entry.label}
                        onMouseEnter={clearCloseTimer}
                        onMouseLeave={scheduleClose}
                        style={{
                          top: placement.top,
                          left: placement.left,
                          minWidth: SUBMENU_MIN_WIDTH,
                        }}
                        className="fixed z-[60] rounded-lg border border-white/10 bg-[#2e2e2e] p-1 text-white/85 shadow-xl"
                      >
                        {entry.children.map((child) => (
                          <button
                            key={child.key}
                            type="button"
                            onClick={child.onSelect}
                            className={MORE_MENU_ITEM_CLASS}
                          >
                            <span className="flex-1">{child.label}</span>
                            {child.hint && (
                              <span className="text-[10px] text-white/40">{child.hint}</span>
                            )}
                          </button>
                        ))}
                      </div>,
                      document.body,
                    )}
                </div>
              );
            }
            const Icon = entry.icon;
            return (
              <button
                key={entry.key}
                type="button"
                disabled={entry.busy}
                onClick={entry.onSelect}
                className={`${MORE_MENU_ITEM_CLASS} ${entry.active ? 'bg-white/[0.06] text-white' : ''}`}
              >
                {entry.busy ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                ) : (
                  <Icon className="h-4 w-4 shrink-0" />
                )}
                <span className="flex-1">{entry.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Grid template list (same source as NodeActionToolbar.gridActions: the label is the translated value, and on submit
// the label is also sent as the display prompt - the real template is decided by the key -> mode mapping).
// No compute cost is attached here: clicking an item only **creates a node** and costs nothing; the price is shown live on the new node's up button
// by the current model/params (AssetBoardImageGenForm); pricing it here would look like clicking charges.
const GRID_ACTION_DEFS: Array<{
  key: GridActionKey;
  icon: LucideIcon;
  label: string;
}> = [
  { key: 'multiCameraGrid', icon: Grid3x3, get label() { return i18n.t('nodeToolbar.gridMenu.multiCameraGrid'); } },
  { key: 'plotFourGrid', icon: Grid2x2, get label() { return i18n.t('nodeToolbar.gridMenu.plotFourGrid'); } },
  { key: 'faceThreeView', icon: User, get label() { return i18n.t('nodeToolbar.gridMenu.faceThreeView'); } },
  { key: 'productThreeView', icon: Package, get label() { return i18n.t('nodeToolbar.gridMenu.productThreeView'); } },
  { key: 'serialStoryboard25', icon: LayoutDashboard, get label() { return i18n.t('nodeToolbar.gridMenu.serialStoryboard25'); } },
  { key: 'cinematicLightCorrection', icon: Film, get label() { return i18n.t('nodeToolbar.gridMenu.cinematicLightCorrection'); } },
  { key: 'characterThreeView', icon: Users, get label() { return i18n.t('nodeToolbar.gridMenu.characterThreeView'); } },
  { key: 'sceneSettingSheet', icon: Mountain, get label() { return i18n.t('nodeToolbar.gridMenu.sceneSettingSheet'); } },
  { key: 'frameProjection3sLater', icon: FastForward, get label() { return i18n.t('nodeToolbar.gridMenu.frameProjection3sLater'); } },
  { key: 'frameProjection5sEarlier', icon: Rewind, get label() { return i18n.t('nodeToolbar.gridMenu.frameProjection5sEarlier'); } },
];

/**
 * Image detail toolbar. Always visible: download / retry on failure / panorama / multi-angle / relight / grid templates;
 * **upscale / crop / rotate** are tucked into the "..." more menu on the far right (expands on hover).
 *
 * Two removals decided by the user:
 * - the old "Edit" dropdown is gone; its three items are now what is inside "...";
 * - matting / crop (tool dialog) / annotate / cell extraction / history are all removed from the old "...".
 *   Note that "history" is gone too - a node whose generation failed no longer has an entry to "go back to the last successful result".
 *
 * @param onOpenNode after creating a new node, switch the detail to it (same path as the header's "create copy").
 *   Grid templates and "... -> upscale" are both "create the node first, submit on up button"; without switching the detail the user
 *   could not tell what happened.
 */
export function AssetBoardImageDetailToolbar({
  node,
  onOpenNode,
}: {
  node: CanvasNode;
  onOpenNode?: (nodeId: string) => void;
}): ReactElement {
  const data = node.data as Record<string, unknown>;
  const imageSource = useMemo(() => resolveNodeSourceImageUrl(node), [node]);
  const isImageEdit = isImageEditNode(node);
  const isGenerating = data.isGenerating === true;
  const canRegenerate = canRegenerateExportImageNode(data);
  const [isDownloading, setIsDownloading] = useState(false);

  // The three edit items (upscale/crop/rotate): the entries go in the "..." below, and the editor dialogs are mounted with overlays.
  // An imageEdit node gets no image edit entry (same show/hide semantics as the workflow NodeActionToolbar).
  const { entries: editEntries, overlays: editOverlays } = useAssetBoardImageEditActions({
    node,
    imageSource: isImageEdit ? null : imageSource,
    onOpenNode,
  });

  // File name inference follows NodeActionToolbar.resolveImageDownloadFilename's rules.
  const handleDownload = useCallback(async () => {
    if (!imageSource || isDownloading) return;
    const sourceFileName =
      typeof data.sourceFileName === 'string' ? data.sourceFileName.trim() : '';
    const displayName = typeof data.displayName === 'string' ? data.displayName.trim() : '';
    const filename = sourceFileName || (displayName ? `${displayName}.png` : `node-${node.id}.png`);
    setIsDownloading(true);
    try {
      await downloadUrlAsFile(resolveImageDisplayUrl(imageSource), filename);
    } catch (error) {
      console.error('[asset-board] image download failed', error);
    } finally {
      setIsDownloading(false);
    }
  }, [data.displayName, data.sourceFileName, imageSource, isDownloading, node.id]);

  // Clicking a feature = **create the node first, do not submit** (matches liblib): create an empty image generation node downstream,
  // the node name = the feature name, with a closable/switchable feature chip in the input box; the detail then switches to the new node,
  // and the user submits with the up button after editing the prompt/reference images/ratio (or switching the feature in the feature box).
  //
  // This only changes the storyboard's interaction: the workflow side's "confirm to submit" (GridActionConfirmOverlay
  // + submitGridTemplateAction) is untouched, with exactly the same capability.
  const handleGridAction = useCallback(
    (def: (typeof GRID_ACTION_DEFS)[number]) => {
      if (!imageSource) return;
      const newNodeId = spawnAssetBoardImageOpNode(node.id, imageSource, def.key);
      if (!newNodeId) return;
      // Low-cost viewport pre-positioning (M7): the kept-alive Canvas first aims the viewport at the new node, so the user
      // does not have to find it when switching back to the workflow.
      useCanvasStore.getState().requestFocusNode(newNodeId);
      onOpenNode?.(newNodeId);
    },
    [imageSource, node.id, onOpenNode],
  );

  // The entries of the "..." more menu are the three edit items (upscale/crop/rotate), all from
  // useAssetBoardImageEditActions. Matting / crop (tool dialog) / annotate /
  // cell extraction / history that used to live here were removed as a whole at the user's request (the capabilities themselves remain in the workflow-side NodeActionToolbar).
  // Grid templates are an always-visible dropdown button, not in the menu; "Set key element" is a node-level action, in the detail header's
  // "..." (consistent across the four columns, see AssetBoardDetail).

  return (
    <div className="flex flex-col gap-2">
      {/* Centered: the toolbar is the detail's action row and the media itself is centered too; left alignment would leave this row
      hanging alone in the top-left (user request). */}
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <DetailToolbarButton
          icon={Download}
          label={i18n.t('canvas.assetBoard.detailToolbar.download')}
          busy={isDownloading}
          disabled={!imageSource}
          onClick={() => void handleDownload()}
        />
        {canRegenerate && (
          <DetailToolbarButton
            icon={RefreshCw}
            label={i18n.t('canvas.assetBoard.detailToolbar.regenerate')}
            busy={isGenerating}
            title={i18n.t('canvas.assetBoard.detailToolbar.regenerateTitle')}
            onClick={() => void regenerateExportImageNode(node.id)}
          />
        )}
        {/* Second batch of always-visible image actions (panorama / multi-angle / relight). Buttons sit on this row; the failure fallback text
        uses w-full to wrap onto the next row automatically. Show/hide has the same source as the workflow NodeActionToolbar: an imageEdit
        node gets no image edit entry, and nothing shows without an image source. */}
        {!isImageEdit && imageSource && (
          <AssetBoardImageOps node={node} imageSource={imageSource} />
        )}
        {/* Grid templates: an always-visible dropdown button (moved out of the "..." menu, user request). Opens a list of 9 templates;
        selecting one creates an empty image node of the same name downstream and switches the detail to it - no longer submitting on the spot,
        the user confirms (or switches feature) in the new node's input box and presses up to actually generate. */}
        {!isImageEdit && imageSource && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title={i18n.t('canvas.assetBoard.detailToolbar.gridTemplatesTitle')}
                className={DETAIL_TOOLBAR_BUTTON_CLASS}
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                {i18n.t('nodeToolbar.gridMenu.trigger')}
                <ChevronDown className="h-3 w-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={6}
              className="z-50 min-w-[200px] border-white/10 bg-[#2e2e2e] text-white/85 shadow-xl"
            >
              {GRID_ACTION_DEFS.map((def) => {
                const Icon = def.icon;
                return (
                  <DropdownMenuItem
                    key={def.key}
                    className="gap-2 rounded-[6px] text-white/80 focus:bg-white/[0.08] focus:text-white"
                    onSelect={() => handleGridAction(def)}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="flex-1">{def.label}</span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {/* "..." more menu: upscale / crop / rotate (expands on hover, see the component comment).
        Not rendered at all when the entries are all filtered out by preset_managed or there is no image to edit
        - otherwise opening it would show an empty panel. */}
        {editEntries.length > 0 && <DetailMoreMenu entries={editEntries} />}
      </div>
      {/* Crop / rotate editors (portal dialogs), coming from the same hook as the three items above. */}
      {editOverlays}
    </div>
  );
}

/** Node video source: videoUrl first, then resultVideoUrl written back by upscale/subtitle removal etc. */
function videoSourceUrlOf(node: CanvasNode): string | null {
  const data = node.data as Record<string, unknown>;
  if (typeof data.videoUrl === 'string' && data.videoUrl) return data.videoUrl;
  if (typeof data.resultVideoUrl === 'string' && data.resultVideoUrl) return data.resultVideoUrl;
  return null;
}

/** Nodes whose generation has failed. */
function hasFailedGeneration(node: CanvasNode): boolean {
  const data = node.data as Record<string, unknown>;
  return typeof data.generationError === 'string' && data.generationError.trim().length > 0;
}

/**
 * Whether the image detail toolbar has any usable action. If none, do not render the whole bar - on an empty node (no image yet),
 * download/edit/grid all need an image source, and a row of gray buttons is just noise (user request).
 * Two exceptions:
 * - when an export image node fails to generate it has no image source, but "Regenerate" is exactly what is needed then;
 * - other nodes whose generation failed also keep the whole bar, so entries that do not need an image source such as "Regenerate" have a place.
 *   Note "history" was removed with the "..." menu redesign (user request), so failed nodes no longer have an entry to
 *   "go back to the last successful result" - the same trade-off as the video side.
 */
export function hasImageDetailActions(node: CanvasNode): boolean {
  // A not-yet-produced upscale result node: resolveNodeSourceImageUrl would reach the **source image** it stores
  // (previewImageUrl), so showing a row of "download/edit/panorama..." would operate on the original to be enlarged as if it were
  // this node's product. Short-circuit here first - the only thing it should do right now is the up button on the card below.
  if (isPendingUpscaleNode(node)) return false;
  return (
    Boolean(resolveNodeSourceImageUrl(node)) ||
    canRegenerateExportImageNode(node.data as Record<string, unknown>) ||
    hasFailedGeneration(node)
  );
}

/**
 * Whether the video detail toolbar has any usable action. Same as above: a video node without a source renders no bar at all.
 * The only exception is the compose node - its "Edit" relies on upstream materials rather than its own source, so it stays even before it has produced a video
 * (when materials are insufficient the button itself explains "at least 2 ready upstream video assets are required").
 *
 * Failed generation nodes are no longer an exception: after the toolbar was cut to four items "Edit/Upscale/Download/Fullscreen" (user request),
 * "history", which did not require a source, is gone, and keeping it would just be four all-gray buttons.
 */
export function hasVideoDetailActions(node: CanvasNode): boolean {
  return Boolean(videoSourceUrlOf(node)) || isVideoComposeNode(node);
}

/**
 * Toolbar shell: the same surface as the canvas node toolbar (CANVAS_NODE_TOOLBAR_SURFACE_CLASS), just with
 * one step less padding - it has to fit in the detail header row. Corners also follow 10px, no full pill (user feedback).
 */
const VIDEO_FLOAT_PILL_CLASS =
  `flex items-center gap-0.5 rounded-[10px] p-1 ${CANVAS_NODE_TOOLBAR_SURFACE_CLASS}`;

/** A button in the toolbar: borderless (the shell already provides the surface), the icon can be its own key; h-6 keeps the whole bar flush with the header row height. */
const VIDEO_FLOAT_BUTTON_CLASS =
  'inline-flex h-6 items-center gap-1.5 rounded-[7px] px-2.5 text-[12px] text-white/80 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40';

/** A button on the floating toolbar (label only shows with showLabel, otherwise it degrades to an icon-only key). */
function VideoFloatButton({
  icon: Icon,
  label,
  showLabel = false,
  busy = false,
  disabled = false,
  title,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  showLabel?: boolean;
  busy?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      // An icon-only key has no visible text; aria-label covers the accessible name for screen readers and tests.
      aria-label={label}
      title={title ?? label}
      disabled={disabled || busy}
      onClick={onClick}
      className={VIDEO_FLOAT_BUTTON_CLASS}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
      {showLabel && label}
    </button>
  );
}

/**
 * The floating toolbar of the video detail: four items **Edit / Upscale / Download / Fullscreen** (cut to these four at the user's request;
 * the other video features - smart subtitle removal / prompt translation / history / edit track / analysis / audio-video separation /
 * frame capture / video replace / box-select erase - were removed from the storyboard; the workflow-side NodeActionToolbar is unaffected).
 *
 * The form changed too: no longer an always-visible button row below the detail header, but a centered pill
 * (matching liblib) that **appears on hover over the video detail**. It sits in the blank space between the detail header title and the right icons
 * - covering the picture would block part of the video (user feedback). The hover context is provided by AssetBoardDetail's
 * root `group/detail` (a named group: the detail has other group-hover, and sharing the anonymous group
 * would trigger each other by mistake); while the config panel or compose dialog is open it is pinned and not hidden, otherwise once the mouse moves away, the upscale
 * parameters being filled in would disappear with it.
 */
export function AssetBoardVideoDetailToolbar({
  node,
  playerRef,
}: {
  node: CanvasNode;
  /** The live <video> in the detail body: "Fullscreen" calls requestFullscreen on it directly. */
  playerRef?: RefObject<HTMLVideoElement | null>;
}): ReactElement {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const data = node.data as Record<string, unknown>;
  const isVideo = isVideoNode(node);
  const isCompose = isVideoComposeNode(node);
  const videoUrl = videoSourceUrlOf(node);

  const [upscaleOpen, setUpscaleOpen] = useState(false);
  const [upscaleResolution, setUpscaleResolution] =
    useState<FreezoneVideoUpscaleResolution>('1080p');
  const [isDownloading, setIsDownloading] = useState(false);
  const [isSubmittingUpscale, setIsSubmittingUpscale] = useState(false);
  const [composeSeeds, setComposeSeeds] = useState<string[] | null>(null);

  const project = readUrl().project;
  const canvasId = readUrl().canvas ?? 'default';

  // Availability of the video compose entry: a compose node keeps the workflow's ">= 2 upstream videos with a source" threshold;
  // a plain video node uses itself as the material seed, needing only a source.
  // A reactive selector replaces the getState() snapshot in useMemo - the latter only recomputes when its dependencies
  // (isCompose/node.id) change, so an upstream video finishing generation while the detail is open would not
  // trigger a re-render and the "Edit" button would stay disabled. The selector returns a number,
  // which Zustand dedupes with Object.is, so an unchanged value does not re-render; subscribing to only this one derived value
  // means no extra renders from changes to other unrelated store fields.
  const composeUpstreamVideoCount = useCanvasStore((state) => {
    if (!isCompose) return 0;
    const byId = new Map(state.nodes.map((candidate) => [candidate.id, candidate]));
    return state.edges
      .filter((edge) => edge.target === node.id)
      .map((edge) => byId.get(edge.source))
      .filter((upstream): upstream is CanvasNode => Boolean(upstream))
      .filter((upstream) => isVideoNode(upstream) && Boolean(upstream.data.videoUrl)).length;
  });
  const canOpenCompose = isCompose ? composeUpstreamVideoCount >= 2 : Boolean(videoUrl);

  const openCompose = useCallback(() => {
    if (!project || !canOpenCompose) return;
    if (!isCompose) {
      setComposeSeeds([node.id]);
      return;
    }
    // Same seed derivation as VideoComposeNode: upstream video/audio nodes with a source, sorted by y.
    const state = useCanvasStore.getState();
    const byId = new Map(state.nodes.map((candidate) => [candidate.id, candidate]));
    const seeds = state.edges
      .filter((edge) => edge.target === node.id)
      .map((edge) => byId.get(edge.source))
      .filter((upstream): upstream is CanvasNode => Boolean(upstream))
      .filter(
        (upstream) =>
          (isVideoNode(upstream) && Boolean(upstream.data.videoUrl)) ||
          (isAudioNode(upstream) && Boolean(upstream.data.audioUrl)),
      )
      .sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0))
      .map((upstream) => upstream.id);
    setComposeSeeds(seeds);
  }, [canOpenCompose, isCompose, node.id, project]);

  const handleComposed = useCallback(
    (url: string, coverUrl: string | null) => {
      // Same semantics as VideoComposeNode.onComposed: create a video node downstream to carry the result and connect an edge;
      // a compose node also focuses the new node and writes back resultVideoUrl/previewImageUrl.
      const store = useCanvasStore.getState();
      const position = store.findNodePosition(node.id, 580, 380);
      const newId = store.addNode(CANVAS_NODE_TYPES.video, position, {
        videoUrl: url,
        previewImageUrl: coverUrl,
        displayName: i18n.t('canvas.assetBoard.detailToolbar.composedVideo'),
        sourceFileName: null,
      } as Partial<CanvasNodeData>);
      store.addEdge(node.id, newId);
      if (isCompose) {
        store.setSelectedNode(newId);
        store.requestFocusNode(newId);
        store.updateNodeData(node.id, {
          resultVideoUrl: url,
          previewImageUrl: coverUrl,
        } as Partial<CanvasNodeData>);
      }
      setComposeSeeds(null);
    },
    [isCompose, node.id],
  );

  const handleDownload = useCallback(async () => {
    if (!videoUrl || isDownloading) return;
    // File name inference follows NodeActionToolbar's video download rules.
    const sourceFileName =
      typeof data.sourceFileName === 'string' && data.sourceFileName.trim().length > 0
        ? data.sourceFileName
        : typeof data.displayName === 'string' && data.displayName.trim().length > 0
          ? `${data.displayName}.mp4`
          : `video-${node.id}.mp4`;
    setIsDownloading(true);
    try {
      await downloadUrlAsFile(resolveImageDisplayUrl(videoUrl), sourceFileName);
    } catch (error) {
      console.error('[asset-board] video download failed', error);
    } finally {
      setIsDownloading(false);
    }
  }, [data.displayName, data.sourceFileName, isDownloading, node.id, videoUrl]);

  const handleUpscaleSubmit = useCallback(() => {
    if (!videoUrl || isSubmittingUpscale) return;
    // Follows the workflow semantics of "create the isUpscaleNode result node first"; the config is submitted directly once chosen in the detail.
    const displayName = i18n.t('canvas.assetBoard.detailToolbar.upscaleName', { resolution: VIDEO_UPSCALE_RESOLUTION_LABEL[upscaleResolution] });
    const upscaleNodeId = createVideoUpscaleResultNode(node.id, {
      sourceUrl: videoUrl,
      displayName,
      resolution: upscaleResolution,
    });
    if (!upscaleNodeId) return;
    // After the config row collapses, the toolbar "Upscale" button becomes a spinner until submit settles -
    // the same in-progress feedback style as translate/subtitle removal/grid (the result lands on a newly created canvas node).
    setUpscaleOpen(false);
    setIsSubmittingUpscale(true);
    // Low-cost viewport pre-positioning (M7): the result node is already created synchronously, focus it immediately (see the handleMatte comment).
    useCanvasStore.getState().requestFocusNode(upscaleNodeId);
    void submitVideoUpscale(upscaleNodeId, {
      sourceUrl: videoUrl,
      resolution: upscaleResolution,
    }).finally(() => setIsSubmittingUpscale(false));
  }, [isSubmittingUpscale, node.id, upscaleResolution, videoUrl]);

  // Fullscreen: call requestFullscreen directly on the live player in the body (not enlarging the whole detail panel -
  // the user wants to "watch the video"). iOS Safari's <video> has no standard API, so fall back to its own
  // webkitEnterFullscreen.
  const handleFullscreen = useCallback(() => {
    const player = playerRef?.current;
    if (!player) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    if (typeof player.requestFullscreen === 'function') {
      void player.requestFullscreen().catch((error: unknown) => {
        console.error('[asset-board] video fullscreen failed', error);
      });
      return;
    }
    (player as HTMLVideoElement & { webkitEnterFullscreen?: () => void }).webkitEnterFullscreen?.();
  }, [playerRef]);

  // While the config panel / compose dialog is open, the toolbar switches from "appear on hover" to pinned always visible.
  const pinned = upscaleOpen || composeSeeds !== null;

  return (
    <>
      {/* Transparent by default + ignores the pointer; appears when the mouse moves into the detail panel or keyboard focus lands in it. opacity rather than
      hidden - visibility:hidden would make the buttons untabbable, and keyboard users could never reach these four features;
      also because the footprint stays the same, appearing/hiding does not push the header around. */}
      <div
        className={`relative shrink-0 transition-opacity duration-150 ${
          pinned
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 group-hover/detail:pointer-events-auto group-hover/detail:opacity-100'
        }`}
      >
        <div className={VIDEO_FLOAT_PILL_CLASS}>
          <VideoFloatButton
            icon={Scissors}
            label={i18n.t('canvas.assetBoard.detailToolbar.edit')}
            showLabel
            disabled={!project || !canOpenCompose}
            title={
              isCompose && !canOpenCompose
                ? i18n.t('canvas.assetBoard.detailToolbar.editNeedsTwo')
                : i18n.t('canvas.assetBoard.detailToolbar.editOpen')
            }
            onClick={openCompose}
          />
          {isVideo && (
            <VideoFloatButton
              icon={ImageUpscale}
              label={i18n.t('canvas.assetBoard.detailToolbar.upscale')}
              showLabel
              busy={isSubmittingUpscale}
              disabled={!videoUrl}
              title={i18n.t('canvas.assetBoard.detailToolbar.upscaleTitle')}
              onClick={() => setUpscaleOpen((open) => !open)}
            />
          )}
          <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-white/12" />
          <VideoFloatButton
            icon={Download}
            label={i18n.t('canvas.assetBoard.detailToolbar.download')}
            busy={isDownloading}
            disabled={!videoUrl}
            onClick={() => void handleDownload()}
          />
          <VideoFloatButton
            icon={Maximize2}
            label={i18n.t('canvas.assetBoard.detailToolbar.fullscreen')}
            disabled={!videoUrl}
            title={i18n.t('canvas.assetBoard.detailToolbar.fullscreenTitle')}
            onClick={handleFullscreen}
          />
        </div>

        {/* Upscale config: a floating layer hanging right below the pill (it used to be a config row taking a whole line in the detail - after the toolbar
        moved into the header, there was no place for that row). z-50 above the body below. */}
        {upscaleOpen && isVideo && (
          <div className="absolute left-1/2 top-full z-50 mt-2 flex -translate-x-1/2 flex-wrap items-center justify-center gap-3 whitespace-nowrap rounded-xl border border-white/10 bg-[#282828] px-3 py-2 shadow-[0_10px_24px_rgba(0,0,0,0.32)]">
            <span className="text-[12px] text-white/40">{i18n.t('canvas.assetBoard.detailToolbar.resolution')}</span>
            <div className="inline-flex items-center gap-0.5 rounded-md border border-white/10 bg-white/[0.04] p-0.5">
              {VIDEO_UPSCALE_RESOLUTIONS.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setUpscaleResolution(value)}
                  className={`rounded px-2 py-0.5 text-[12px] transition-colors ${
                    upscaleResolution === value
                      ? 'bg-white/15 text-white'
                      : 'text-white/50 hover:bg-white/5 hover:text-white/80'
                  }`}
                >
                  {VIDEO_UPSCALE_RESOLUTION_LABEL[value]}
                </button>
              ))}
            </div>
            <DetailToolbarButton
              icon={Wand2}
              label={i18n.t('canvas.assetBoard.detailToolbar.submitUpscale')}
              busy={isSubmittingUpscale}
              disabled={!videoUrl}
              title={i18n.t('canvas.assetBoard.detailToolbar.submitUpscaleTitle')}
              onClick={handleUpscaleSubmit}
            />
          </div>
        )}
      </div>

      {/* The dialog stays outside the hover layer: it is a full-screen portal-level thing, fading in/out with the toolbar
      makes no sense and it should not be affected by the pointer-events switch. */}
      {composeSeeds !== null && project && (
        <VideoComposeModal
          project={project}
          canvasId={canvasId}
          seedNodeIds={composeSeeds}
          // Same semantics as VideoComposeNode.tsx (no longer branching on isCompose): a plain video node
          // opening "Edit" also reads/writes the draft on its own node.data.draftTimeline -
          // VideoNodeData already has a [key: string]: unknown index signature; previously plain video nodes
          // took the degraded path of "close = lose the draft" (M4). onPersistDraft is called unconditionally
          // when the dialog unmounts (see VideoComposeModal's unmount effect), so it is always injected here.
          initialTimeline={(data.draftTimeline as ComposeTimelineState | undefined) ?? null}
          onPersistDraft={(timeline) =>
            updateNodeData(node.id, { draftTimeline: timeline } as Partial<CanvasNodeData>)
          }
          onClose={() => setComposeSeeds(null)}
          onComposed={handleComposed}
        />
      )}
    </>
  );
}
