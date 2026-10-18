// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback } from 'react';

import { type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  MultiAngleEditorPanel,
  type MultiAngleSubmitPayload,
} from '@/features/canvas/ui/MultiAngleEditorPanel';
import { multiAngleImage } from '@/features/canvas/application/imageMultiAngle';

export interface MultiAngleEditorContentProps {
  /** The source image node (the result node is built downstream of it). */
  node: CanvasNode;
  /** The resolved image source (taken by the caller with resolveNodeSourceImageUrl). */
  imageSource: string;
  /** Close the editor. Also called after a successful submit (after onSubmitted). */
  onClose: () => void;
  /**
   * Called back when submission succeeds and the result node has been built synchronously, with the new result node id as the argument.
   * The host decides the follow-up action - the workflow side selects that node, the storyboard side requests viewport pre-positioning.
   * It does not fire (nor onClose) when submission fails because project is missing / the source node does not exist.
   */
  onSubmitted?: (nodeId: string) => void;
}

/**
 * The **pure content layer** of the multi-dimension editor: the complete editor panel + submission orchestration, with no React Flow
 * dependency whatsoever (no NodeToolbar / useReactFlow / ZoomScaledToolbar), so it can be mounted below a canvas node
 * (MultiAngleEditorOverlay) and also stuffed into the storyboard's centered dialog
 * (AssetBoardMultiAngleDialog).
 *
 * Submission goes through application/imageMultiAngle (the same source as the workflow); this component does not touch selection/viewport,
 * and always hands off to the host via onSubmitted, avoiding the behaviors of the two hosts polluting each other.
 */
export const MultiAngleEditorContent = memo(
  ({ node, imageSource, onClose, onSubmitted }: MultiAngleEditorContentProps) => {
    const handleSubmit = useCallback(
      (payload: MultiAngleSubmitPayload) => {
        const result = multiAngleImage(node.id, imageSource, payload);
        if (!result) return;
        onSubmitted?.(result.nodeId);
        onClose();
      },
      [imageSource, node.id, onClose, onSubmitted],
    );

    return (
      <MultiAngleEditorPanel
        imageSource={imageSource}
        onClose={onClose}
        onSubmit={handleSubmit}
      />
    );
  },
);

MultiAngleEditorContent.displayName = 'MultiAngleEditorContent';
