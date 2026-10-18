// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText } from 'lucide-react';

import { ReferenceDetachButton } from './ReferenceDetachButton';

interface ReferenceTextChipProps {
  /** Upstream text node id (the edge's source) */
  nodeId: string;
  /** The referenced text content */
  text: string;
  /** Source label (displayName / nodeType), shown at the title of the preview popover */
  sourceLabel?: string;
  /** Detach-reference callback */
  onDetach: (nodeId: string) => void;
  /** Focus the upstream node when the chip is clicked (optional, needed only by some nodes) */
  onFocus?: (nodeId: string) => void;
  /** Jump the viewport to the upstream node's position when the chip is double-clicked (optional) */
  onJump?: (nodeId: string) => void;
  /** Override the style of the trigger square (default h-9 w-9 rounded square) */
  triggerClassName?: string;
}

/**
 * Unified display of referenced text: a text-icon square, with the full text preview floating above on hover.
 *
 * Replaces the previous chips "icon + truncated text + native title" everywhere — only the icon shows, saving horizontal space,
 * and the full content is presented by a styled hover popover (modeled on the music node's reference preview).
 *
 * The preview popover is rendered into body with portal + fixed positioning: node toolbars generally carry `overflow-x-auto`
 * (which also clips vertical overflow), so an absolute popover would be clipped and invisible; a portal avoids it.
 */
export function ReferenceTextChip({
  nodeId,
  text,
  sourceLabel,
  onDetach,
  onFocus,
  onJump,
  triggerClassName,
}: ReferenceTextChipProps) {
  const trimmed = (text ?? '').trim();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [previewAnchor, setPreviewAnchor] = useState<{ top: number; left: number } | null>(null);

  const showPreview = () => {
    if (trimmed.length === 0) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Hug the top edge of the icon with an 8px gap; the popover itself moves up with translateY(-100%).
    setPreviewAnchor({ top: rect.top - 8, left: rect.left });
  };
  const hidePreview = () => setPreviewAnchor(null);

  return (
    <div
      className="group/reftext relative shrink-0"
      onMouseEnter={showPreview}
      onMouseLeave={hidePreview}
    >
      <button
        ref={triggerRef}
        type="button"
        title={sourceLabel}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onFocus?.(nodeId);
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          // After jumping away, this chip and the whole panel are out of the viewport, and a leftover popover would float in mid-air.
          hidePreview();
          onJump?.(nodeId);
        }}
        className={
          triggerClassName ??
          'nodrag flex h-9 w-9 items-center justify-center rounded-lg bg-white/12 transition-colors hover:bg-white/20'
        }
      >
        <FileText className="h-4 w-4 text-white" />
      </button>
      <ReferenceDetachButton
        nodeId={nodeId}
        onDetach={onDetach}
        className="nodrag absolute right-0 top-0 z-10 hidden h-4 w-4 items-center justify-center rounded-bl-md rounded-tr-md bg-black/75 text-white transition-colors hover:bg-red-500 group-hover/reftext:flex"
      />
      {previewAnchor &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              top: previewAnchor.top,
              left: previewAnchor.left,
              transform: 'translateY(-100%)',
            }}
            className="canvas-node-transient-ui pointer-events-none z-[2000] w-max max-w-[280px] rounded-lg bg-black px-3 py-2.5 text-xs leading-relaxed text-white shadow-[0_10px_24px_rgba(0,0,0,0.45)]"
          >
            <div className="max-h-[220px] overflow-y-auto whitespace-pre-wrap break-words">
              {trimmed}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
