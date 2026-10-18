// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { CANVAS_NODE_OPS_PANEL_CLASS } from '@/features/canvas/ui/nodeFrameStyles';

interface OperationPanelShellProps {
  /** When expanded, show as a body-level centered dialog; when collapsed, it is the floating panel below the node. */
  expanded: boolean;
  /** Close the dialog (click the mask / Esc / click the collapse button again). */
  onCollapse: () => void;
  /** Collapsed state: the positioning class of the floating panel below the node. */
  inlineClassName: string;
  /** Collapsed state: the positioning/size style of the floating panel (top/left/right/width/height). */
  inlineStyle: CSSProperties;
  /** Expanded state: the size style of the dialog box (width/height; you can give only width and let the height follow the content). */
  modalStyle?: CSSProperties;
  children: ReactNode;
}

function stopPropagation(event: { stopPropagation: () => void }): void {
  event.stopPropagation();
}

// When a node is activated, the operation area fades in from below the node with a slight downward slide (rather than appearing abruptly).
// The collapsed floating panel hangs below the node, so sliding in from above reads like "expanding from inside the node".
// Under motion-reduce no displacement/scale animation is done, respecting the system's "reduce motion".
//
// Exported for the "history" panel below the node to reuse the same entrance animation, so the three (top toolbar /
// operation area / history) float in in the same direction with the same duration when activated, visually aligned, no longer each jumping on its own.
export const NODE_OPS_PANEL_ENTER_CLASS =
  'animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-200 ease-out motion-reduce:animate-none';
const INLINE_ENTER_CLASS = NODE_OPS_PANEL_ENTER_CLASS;

/**
 * The "shell" of the node's operation area: when collapsed it is the floating panel below the node; after clicking "Enlarge" it becomes
 * a document.body-level centered dialog showing the same content.
 *
 * Why it must be portaled to body - React Flow applies a CSS transform to the canvas viewport,
 * and a panel using `position: fixed` would be positioned relative to "the transformed ancestor" rather than the viewport, unable to
 * truly center; only createPortal to body can escape this transform context.
 */
export function OperationPanelShell({
  expanded,
  onCollapse,
  inlineClassName,
  inlineStyle,
  modalStyle,
  children,
}: OperationPanelShellProps) {
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCollapse();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [expanded, onCollapse]);

  if (!expanded) {
    return (
      <div
        className={`${inlineClassName} ${INLINE_ENTER_CLASS}`}
        style={inlineStyle}
        onClick={stopPropagation}
      >
        {children}
      </div>
    );
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
      onClick={onCollapse}
      onPointerDown={stopPropagation}
    >
      <div
        className={`nodrag nowheel relative flex max-h-full max-w-full flex-col rounded-[var(--node-radius)] ${CANVAS_NODE_OPS_PANEL_CLASS}`}
        style={modalStyle}
        onClick={stopPropagation}
        onPointerDown={stopPropagation}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
