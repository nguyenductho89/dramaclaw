// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface AssetBoardEditorDialogProps {
  /** Accessible name (the editor title, e.g. "Multi-dimension editor"); the panel already has a visible title inside, and this is only for a11y. */
  label: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * The centered dialog shell hosting the "complete workflow editor" inside the storyboard detail.
 *
 * A z-[300] full-screen layer portaled to document.body (the same layering and mask recipe as RedrawOverlay / EraseOverlay),
 * higher than the storyboard's z-30; clicking the mask or pressing Esc closes it.
 *
 * The shell **adds no card chrome**: the editor panels stuffed in (MultiAngleEditorPanel /
 * LightEditorPanel) are themselves 600px cards with their own corner radius and background, and wrapping another layer in the shell would produce
 * a double border. When the viewport is not tall enough the whole thing scrolls, avoiding a 600x~430 panel being clipped.
 */
/**
 * Wrap the close callback to "let through only once within this mount".
 *
 * Necessary, because the two editor panels themselves also carry a document capture listener of "click outside the panel -> onClose"
 * (both MultiAngleEditorPanel / LightEditorPanel have it): clicking the mask hits both the panel's listener
 * and the shell's onClick, and without dedup the host would receive the close twice. The caller must hand the **same** wrapped
 * callback to both the shell and the content layer, otherwise the two paths each hold the raw callback and dedup is ineffective.
 */
export function useCloseOnce(onClose: () => void): () => void {
  const closedRef = useRef(false);
  return useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    onClose();
  }, [onClose]);
}

export function AssetBoardEditorDialog({
  label,
  onClose,
  children,
}: AssetBoardEditorDialogProps): ReactElement | null {
  useEffect(() => {
    // Neither panel has its own Esc close, so it is added here.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 z-[300] flex items-center justify-center overflow-y-auto bg-black/72 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="my-auto" onClick={(event) => event.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
