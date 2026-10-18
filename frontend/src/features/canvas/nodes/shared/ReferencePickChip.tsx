// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * The "+ Reference" entry on the prompt bar of image / video nodes.
 *
 * In the user's eyes the two kinds of reference are one thing — "give this generation a reference" — only the source of the asset differs:
 * an existing node on the canvas, or a local file. So they merge into one chip, and clicking opens a two-way
 * dropdown; the top row also has one fewer chip, freeing horizontal space for the input area.
 *
 * "Canvas reference" enters pick mode: the user clicks a node directly on the canvas, and the selected result is one upstream edge,
 * with the reference chip and the submit payload both followed automatically by the existing upstream derivation chain (see [[referencePick]]).
 * "External reference" hands file selection back to the host node (each node accepts different file types).
 *
 * Nodes that do not pass onPickExternal (such as the image generation node, which never had an external asset entry) keep
 * a single click that goes straight into pick mode, with no needless extra menu layer.
 */
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { MousePointerClick, Plus, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { useCanvasStore } from '@/stores/canvasStore';
import type { CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import { collectReferencePickTargets } from '@/features/canvas/application/referencePick';
import { useReferencePickStore } from '@/features/canvas/application/referencePickStore';
import { placeAnchoredMenu } from '@/features/canvas/nodes/shared/anchoredMenuPlacement';
import {
  NODE_FLOATING_PANEL_SURFACE_CLASS,
  NODE_TEXT_CONTROL_ICON_CLASS,
  NODE_TEXT_CONTROL_TRIGGER_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';

const MENU_WIDTH = 208;
const MENU_GAP = 6;
/** Height when the two fixed menu items fill the menu, used to judge whether there is room below. */
const MENU_HEIGHT = 108;

/**
 * Enter canvas pick mode. Do not enter when the pickable targets are empty — in pick mode the whole canvas changes look,
 * and entering with nothing clickable would only make the user think the feature is broken.
 */
function startCanvasPick(nodeId: string, nodeType: CanvasNodeType, t: TFunction): void {
  // The viewport is read from the store rather than useReactFlow(): this chip lives inside node components, whose
  // unit tests generally mock only a handful of @xyflow/react exports, and requiring one more hook would drag them all
  // down; currentViewport is maintained by the store anyway (see BackToNodesHint).
  const { nodes, currentViewport } = useCanvasStore.getState();
  const { candidates, rejections } = collectReferencePickTargets(nodes, nodeId, nodeType, t);
  if (candidates.size === 0) {
    toast.info(t('canvas.referencePick.noTargets'));
    return;
  }
  useReferencePickStore.getState().start({
    targetNodeId: nodeId,
    targetNodeType: nodeType,
    originViewport: currentViewport ?? null,
    candidates,
    rejections,
  });
}

function ReferenceSourceMenuItem({
  icon,
  label,
  hint,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/[0.09]"
    >
      <span className="mt-[3px] shrink-0 text-text-muted/90">{icon}</span>
      <span className="min-w-0">
        <span className="block text-[13px] leading-tight text-text-dark">{label}</span>
        <span className="mt-0.5 block text-[11px] leading-tight text-text-muted/80">
          {hint}
        </span>
      </span>
    </button>
  );
}

export function ReferencePickChip({
  nodeId,
  nodeType,
  onPickExternal,
}: {
  nodeId: string;
  nodeType: CanvasNodeType;
  /** Callback when "External reference" is chosen; if not passed, a single click on this chip goes straight into canvas pick mode. */
  onPickExternal?: () => void;
}) {
  const { t } = useTranslation();
  const active = useReferencePickStore((state) => state.request?.targetNodeId === nodeId);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{
    left: number;
    top: number;
    maxHeight: number;
  } | null>(null);

  // The menu uses portal + fixed, for the same reason as CameraMovementChip: the row this chip sits in is
  // overflow-x-auto (which also clips vertically), and the node's own transform locks an absolute popover
  // into its own stacking context, so it cannot cover other things on the canvas.
  useEffect(() => {
    if (!anchor) return;
    const close = (event: globalThis.MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        menuRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setAnchor(null);
    };
    document.addEventListener('mousedown', close, true);
    return () => document.removeEventListener('mousedown', close, true);
  }, [anchor]);

  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // The operations panel perpetually hugs the bottom edge of the viewport, and this chip is often only a few dozen pixels from the bottom: opening only downward pushes the whole
    // menu out of the viewport, which looks like a click that did nothing. See [[placeAnchoredMenu]].
    const { top, left, maxHeight } = placeAnchoredMenu({
      anchorRect: rect,
      width: MENU_WIDTH,
      preferredHeight: MENU_HEIGHT,
      gap: MENU_GAP,
    });
    setAnchor({ left, top, maxHeight });
  };

  const handleClick = (event: MouseEvent) => {
    event.stopPropagation();
    // Already in pick mode: this click means "never mind, don't pick", and the menu must not pop up again.
    if (active) {
      useReferencePickStore.getState().stop();
      return;
    }
    if (!onPickExternal) {
      startCanvasPick(nodeId, nodeType, t);
      return;
    }
    if (anchor) setAnchor(null);
    else openMenu();
  };

  const highlighted = active || anchor !== null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleClick}
        className={`${NODE_TEXT_CONTROL_TRIGGER_CLASS} group/refpick shrink-0 px-1.5 ${
          highlighted ? 'text-[rgb(var(--accent-rgb))]' : ''
        }`}
        title={
          onPickExternal
            ? t('canvas.referencePick.chipTitleWithExternal')
            : t('canvas.referencePick.chipTitleCanvasOnly')
        }
      >
        <Plus
          className={`${NODE_TEXT_CONTROL_ICON_CLASS} ${
            highlighted
              ? 'text-[rgb(var(--accent-rgb))]'
              : 'group-hover/refpick:text-text-dark'
          }`}
        />
        <span>{t('canvas.referencePick.chip')}</span>
      </button>
      {anchor &&
        onPickExternal &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuRef}
            style={{
              left: anchor.left,
              top: anchor.top,
              width: MENU_WIDTH,
              maxHeight: anchor.maxHeight,
            }}
            className={`nodrag nowheel ui-scrollbar fixed z-[10000] overflow-y-auto p-1 ${NODE_FLOATING_PANEL_SURFACE_CLASS}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <ReferenceSourceMenuItem
              icon={<MousePointerClick className="h-3.5 w-3.5" />}
              label={t('canvas.referencePick.sourceCanvas')}
              hint={t('canvas.referencePick.sourceCanvasHint')}
              onSelect={() => {
                setAnchor(null);
                startCanvasPick(nodeId, nodeType, t);
              }}
            />
            <ReferenceSourceMenuItem
              icon={<Upload className="h-3.5 w-3.5" />}
              label={t('canvas.referencePick.sourceExternal')}
              hint={t('canvas.referencePick.sourceExternalHint')}
              onSelect={() => {
                setAnchor(null);
                onPickExternal();
              }}
            />
          </div>,
          document.body,
        )}
    </>
  );
}
