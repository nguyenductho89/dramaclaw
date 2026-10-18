// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import {
  RotateEditorToolbar,
  useRotateEditor,
} from '@/features/canvas/ui/rotateEditorContent';

interface AssetBoardRotateDialogProps {
  /** The id of the target node the rotation is written back to (the "rotate result" node pre-built by the caller before entering). */
  nodeId: string;
  imageSource: string;
  /** When `committed=false` the caller needs to reclaim the pre-built result node, see the note on useRotateEditor. */
  onClose: (committed: boolean) => void;
  /** After the submit takes off, hand the completion to the caller to attach the busy state and failure feedback. */
  onCommitted: (completion: Promise<void>) => void;
}

/**
 * The rotate editor in the storyboard detail: large-image live preview + a control bar floating over the image (matches libtv).
 *
 * The same content layer (rotateEditorContent) as the workflow's RotateEditorOverlay, only the shell
 * differs - that side hangs on React Flow's NodeToolbar, while the storyboard detail has no React Flow and goes through a portal to
 * body's z-[300] full-screen layer (the same layering and mask recipe as RedrawOverlay / EraseOverlay).
 *
 * The crop frame is deliberately a **square**: after an image is object-contained into a square frame, the bounding size of a rotation at any angle
 * never exceeds the frame, so there is no need to compute scale compensation from the actual width and height, and rotating by 90 degrees is not cropped.
 *
 * Esc is handled uniformly by useRotateEditor, and not attached again here (otherwise one Esc would close twice).
 */
export function AssetBoardRotateDialog({
  nodeId,
  imageSource,
  onClose,
  onCommitted,
}: AssetBoardRotateDialogProps): ReactElement | null {
  const { t } = useTranslation();
  const controller = useRotateEditor({ nodeId, imageSource, onClose, onCommitted });

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('rotateEditor.title')}
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/72 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget && !controller.isSaving) {
          controller.onExit();
        }
      }}
    >
      {/* No clipping: the square frame already guarantees rotation at any angle never leaves the frame, and the control bar, when wider than a narrow image,
      needs to overflow outside the image; overflow-hidden would cut both its ends off. */}
      <div className="flex h-[min(72vh,76vw)] w-[min(72vh,76vw)] items-center justify-center">
        {/* The inner layer wraps only the image itself: the transform does not affect the layout box, so this wrapper is always the image's
        unrotated frame, and the control bar anchored on it follows the image, rather than being flung into a blank area because the outer layer is a square. */}
        <div className="relative">
          <img
            src={imageSource}
            alt=""
            draggable={false}
            className="block max-h-[min(72vh,76vw)] max-w-[min(72vh,76vw)] object-contain"
            style={{
              transform: controller.transform,
              transition: 'transform 120ms ease-out',
            }}
          />

          {/* The control bar floats **above** the image rather than pressed on it - pressing on it would cover the top of the picture (user feedback).
          bottom-full places it outward against the image's top edge, and the frame is reduced to 72vh to leave this
          space (so a portrait image filling the height is not pushed out of the viewport either).
          inset-x-0 + justify-center rather than left-1/2 + translate: the latter halves the available width of an absolutely positioned
          element, and once the control bar is squeezed narrow its text would run vertically. */}
          <div className="absolute inset-x-0 bottom-full mb-3 flex justify-center">
            <RotateEditorToolbar controller={controller} showTitle />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
