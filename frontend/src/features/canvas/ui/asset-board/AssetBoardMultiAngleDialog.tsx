// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';
import { type ReactElement } from 'react';

import { type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { MultiAngleEditorContent } from '@/features/canvas/ui/MultiAngleEditorContent';
import { useCanvasStore } from '@/stores/canvasStore';

import { AssetBoardEditorDialog, useCloseOnce } from './AssetBoardEditorDialog';

export interface AssetBoardMultiAngleDialogProps {
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
 * The "Multi-angle" dialog of the storyboard detail: a centered dialog holding **the workflow's complete multi-dimension editor**
 * (sphere angle picking + direction buttons + presets/quality + three sliders + prompt switch + compute cost and submit),
 * rather than the simplified inline config row in the detail.
 *
 * The only difference from the workflow is the wrap-up after submission: the workflow selects the new node, while here viewport pre-positioning is requested
 * (when the storyboard is visible the canvas is suspended, so selection state is meaningless; pre-positioning lets the user find the viewport already aimed
 * at the result node on switching back to the workflow, the same Task 10 pattern).
 */
export function AssetBoardMultiAngleDialog({
  node,
  imageSource,
  onClose,
  onSubmitted,
}: AssetBoardMultiAngleDialogProps): ReactElement {
  // The shell and the content layer must share the same wrapped close callback, see the note on useCloseOnce.
  const close = useCloseOnce(onClose);
  return (
    <AssetBoardEditorDialog label={i18n.t('canvas.assetBoard.multiAngleEditor')} onClose={close}>
      <MultiAngleEditorContent
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
