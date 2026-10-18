// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeftRight,
  FastForward,
  Film,
  Globe,
  Grid2x2,
  Grid3x3,
  LayoutDashboard,
  Mountain,
  Package,
  Rewind,
  User,
  Users,
  type LucideIcon,
} from 'lucide-react';

import {
  ASSET_BOARD_IMAGE_OPS,
  ASSET_BOARD_IMAGE_OP_CATEGORY_LABELS,
  ASSET_BOARD_IMAGE_OP_MAP,
  switchAssetBoardImageOp,
  type AssetBoardImageOpCategoryKey,
  type AssetBoardImageOpKey,
} from '@/features/canvas/application/assetBoardImageOps';
import { NODE_FLOATING_PANEL_SURFACE_CLASS } from '@/features/canvas/ui/nodeControlStyles';

/** Feature -> icon. The same icon set as the toolbar's `GRID_ACTION_DEFS`; switching views does not change the mental model. */
export const ASSET_BOARD_IMAGE_OP_ICONS: Record<AssetBoardImageOpKey, LucideIcon> = {
  multiCameraGrid: Grid3x3,
  plotFourGrid: Grid2x2,
  faceThreeView: User,
  productThreeView: Package,
  serialStoryboard25: LayoutDashboard,
  cinematicLightCorrection: Film,
  characterThreeView: Users,
  sceneSettingSheet: Mountain,
  frameProjection3sLater: FastForward,
  frameProjection5sEarlier: Rewind,
  scene360: Globe,
};

/**
 * Column split of the feature box: the left column "Storyboard narrative + Texture tuning" (4+1), the right column "Space & camera + Design sheets"
 * (2+4), 5 rows on the left and 6 on the right (matches liblib; after adding the scene setting sheet the right column gains a row, and the panel itself
 * scrolls, not affecting reachability). A pure layout decision, so the feature table keeps only categories, and how to arrange them is decided here.
 */
const PANEL_COLUMNS: readonly (readonly AssetBoardImageOpCategoryKey[])[] = [
  ['narrative', 'texture'],
  ['space', 'setting'],
];

const COLUMN_WIDTH_PX = 228;
const PANEL_PADDING_PX = 16;
const PANEL_COLUMN_GAP_PX = 24;
const PANEL_WIDTH_PX =
  COLUMN_WIDTH_PX * PANEL_COLUMNS.length
  + PANEL_COLUMN_GAP_PX * (PANEL_COLUMNS.length - 1)
  + PANEL_PADDING_PX * 2;
const PANEL_MAX_HEIGHT_PX = 460;
const PANEL_GAP_PX = 8;

/**
 * The feature chip **inside** the prompt input box (matches the "hexagon Character sheet swap" chip in the liblib detail input box).
 * It is not a separate row of controls above the input box, but an inline atomic block inside the contenteditable
 * (portaled in via the `leadingChip` slot of `PromptMentionEditor`), therefore:
 * - the feature description is the input box's placeholder, following the chip on the same row;
 * - what the user types starts flowing after the chip;
 * - **Backspace removes it like deleting a character** (deletion is intercepted by the editor and calls back the host to clear `imageOpKey`),
 *   so no x button is drawn here anymore.
 *
 * Clicking the chip expands the feature box, listing all features in four columns (Storyboard narrative / Space & camera / Design sheets / Texture tuning),
 * and choosing one swaps out the current feature in place (the node name changes along). The feature box is portaled to body, avoiding being clipped
 * by the input box's overflow.
 */
export function AssetBoardImageOpChip({
  nodeId,
  opKey,
  disabled = false,
}: {
  nodeId: string;
  opKey: AssetBoardImageOpKey;
  /** Lock feature switching while generating: an in-flight task still writes back to this node, and changing the key midway would only mislead people. */
  disabled?: boolean;
}): ReactElement {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!anchor) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        panelRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setAnchor(null);
    };
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [anchor]);

  // When the feature is switched away / deleted, also collapse the panel along the way, avoiding it hanging in place pointing at a chip that no longer exists.
  useEffect(() => setAnchor(null), [opKey]);

  const def = ASSET_BOARD_IMAGE_OP_MAP[opKey];
  const Icon = ASSET_BOARD_IMAGE_OP_ICONS[opKey];

  // The input box hugs the bottom of the panel, and popping downward would push out of the viewport -> always pop upward, left edge aligned to the chip and clamped inside the viewport.
  const panelStyle = anchor
    ? {
        left: Math.max(8, Math.min(anchor.left, window.innerWidth - PANEL_WIDTH_PX - 8)),
        bottom: Math.max(8, window.innerHeight - anchor.top + PANEL_GAP_PX),
        width: PANEL_WIDTH_PX,
        maxHeight: Math.min(PANEL_MAX_HEIGHT_PX, anchor.top - PANEL_GAP_PX - 16),
      }
    : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        title={i18n.t('canvas.assetBoard.imageOps.chipTitle', { label: def.label })}
        disabled={disabled}
        // Do not let mousedown take its default behavior: that would move the caret onto the chip (an atomic block with contenteditable=false),
        // and the user's next typing would land somewhere unexpected.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          setAnchor((prev) =>
            prev ? null : (triggerRef.current?.getBoundingClientRect() ?? null),
          );
        }}
        className="prompt-op-chip nodrag"
      >
        <span className="prompt-op-chip-icon">
          <Icon className="h-2.5 w-2.5" strokeWidth={2.5} />
        </span>
        <span className="prompt-op-chip-label">{def.label}</span>
        <ArrowLeftRight className="prompt-op-chip-switch h-3 w-3" />
      </button>
      {panelStyle
        && createPortal(
          <div
            ref={panelRef}
            className={`ui-scrollbar nodrag nowheel fixed z-[10000] flex gap-6 overflow-y-auto p-4 ${NODE_FLOATING_PANEL_SURFACE_CLASS}`}
            style={panelStyle}
            onMouseDown={(event) => event.preventDefault()}
          >
            {PANEL_COLUMNS.map((categories) => (
              <div
                key={categories.join('-')}
                className="flex flex-col gap-4"
                style={{ width: COLUMN_WIDTH_PX }}
              >
                {categories.map((category) => (
                  <div key={category}>
                    <div className="px-2 pb-1.5 text-xs text-white/40">
                      {ASSET_BOARD_IMAGE_OP_CATEGORY_LABELS[category]}
                    </div>
                    <div className="flex flex-col gap-1">
                      {ASSET_BOARD_IMAGE_OPS.filter((op) => op.category === category).map((op) => {
                        const OpIcon = ASSET_BOARD_IMAGE_OP_ICONS[op.key];
                        const isActive = op.key === opKey;
                        return (
                          <button
                            key={op.key}
                            type="button"
                            onClick={() => {
                              switchAssetBoardImageOp(nodeId, op.key);
                              setAnchor(null);
                            }}
                            className={`group flex h-11 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors ${
                              isActive ? 'bg-white/[0.1]' : 'hover:bg-white/[0.06]'
                            }`}
                          >
                            <span
                              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white transition-colors ${
                                isActive
                                  ? 'bg-white/[0.14]'
                                  : 'bg-white/[0.06] group-hover:bg-white/[0.1]'
                              }`}
                            >
                              <OpIcon className="h-4 w-4" />
                            </span>
                            {/* Row height fixed at 44px: the description row is collapsed normally and appears only on hover/selection, and the title
                            moves up a bit accordingly, so the whole panel does not jump in height. */}
                            <span className="flex min-w-0 flex-col justify-center gap-0.5">
                              <span className="truncate text-[13px] leading-tight text-white">
                                {op.label}
                              </span>
                              <span
                                className={`truncate text-[11px] leading-tight text-white/40 ${
                                  isActive ? '' : 'hidden group-hover:block'
                                }`}
                              >
                                {op.summary}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
