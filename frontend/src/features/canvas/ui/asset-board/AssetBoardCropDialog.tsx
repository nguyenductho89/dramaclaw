// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import {
  CropEditorSurface,
  CropEditorToolbar,
  useCropEditor,
} from '@/features/canvas/ui/cropEditorContent';

interface AssetBoardCropDialogProps {
  /** The id of the target node the crop is written back to (the "crop result" node pre-built by the caller before entering). */
  nodeId: string;
  imageSource: string;
  /** When `committed=false` the caller needs to reclaim the pre-built result node, see the note on useCropEditor. */
  onClose: (committed: boolean) => void;
  /** After the submit takes off, hand the completion to the caller to attach the busy state and failure feedback. */
  onCommitted: (completion: Promise<void>) => void;
}

/**
 * The crop editor in the storyboard detail: large image + crop frame + a control bar floating above the image (matches liblib).
 *
 * The shell has the same recipe as AssetBoardRotateDialog (a z-[300] full-screen mask portaled to body), the difference
 * being only that the crop frame needs no square container - cropping does not rotate, and the image just spreads out object-contain by its own ratio,
 * with the crop frame placed on the image by percentage (see the coordinate system note in cropEditorContent).
 *
 * Esc is handled uniformly by useCropEditor, and not attached again here (otherwise one Esc would close twice).
 */
export function AssetBoardCropDialog({
  nodeId,
  imageSource,
  onClose,
  onCommitted,
}: AssetBoardCropDialogProps): ReactElement | null {
  const { t } = useTranslation();
  const controller = useCropEditor({ nodeId, imageSource, onClose, onCommitted });

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('cropEditor.title')}
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/72 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget && !controller.isSaving) {
          controller.onExit();
        }
      }}
    >
      {/* Wraps only the image itself: the control bar is anchored outside its top edge (bottom-full), so even a narrow image has it follow along.
      The image height is reduced to 72vh precisely to leave this space for the control bar. */}
      <div className="relative">
        <CropEditorSurface
          controller={controller}
          imageSource={imageSource}
          className="max-h-[72vh] max-w-[86vw]"
        />

        <div className="absolute inset-x-0 bottom-full mb-3 flex justify-center">
          <CropEditorToolbar controller={controller} showTitle />
        </div>
      </div>
    </div>,
    document.body,
  );
}
