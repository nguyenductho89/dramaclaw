// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';
import { type ReactElement } from 'react';

import { type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { LightEditorContent } from '@/features/canvas/ui/LightEditorContent';
import { useCanvasStore } from '@/stores/canvasStore';

import { AssetBoardEditorDialog, useCloseOnce } from './AssetBoardEditorDialog';

export interface AssetBoardRelightDialogProps {
  /** The source image node. */
  node: CanvasNode;
  /** The resolved image source. */
  imageSource: string;
  /** Close the dialog (the content layer also calls it after a successful submit). */
  onClose: () => void;
  /** Submit success callback, with the new result node id as argument (viewport pre-positioning is requested by default; a busy-state wrap-up can be layered on here). */
  onSubmitted?: (nodeId: string) => void;
}

/**
 * The "Relight" dialog of the storyboard detail: a centered dialog holding **the workflow's complete lighting editor**
 * (light-ball direction drag + brightness/color temperature + rim light + smart mode and presets + compute cost and submit),
 * rather than the simplified inline config row in the detail.
 *
 * The wrap-up after submission is the same as the multi-angle dialog: request viewport pre-positioning rather than selection (see the note of
 * AssetBoardMultiAngleDialog).
 */
export function AssetBoardRelightDialog({
  node,
  imageSource,
  onClose,
  onSubmitted,
}: AssetBoardRelightDialogProps): ReactElement {
  // The shell and the content layer must share the same wrapped close callback, see the note on useCloseOnce.
  const close = useCloseOnce(onClose);
  return (
    <AssetBoardEditorDialog label={i18n.t('canvas.assetBoard.lightEditor')} onClose={close}>
      <LightEditorContent
        node={node}
        imageSource={imageSource}
        onClose={close}
        onSubmitted={(nodeId) => {
          useCanvasStore.getState().requestFocusNode(nodeId);
          onSubmitted?.(nodeId);
        }}
      />
    </AssetBoardEditorDialog>
  );
}
