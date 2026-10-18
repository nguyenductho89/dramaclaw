// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback } from 'react';

import { type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  LightEditorPanel,
  type LightEditorSubmitPayload,
} from '@/features/canvas/ui/LightEditorPanel';
import { relightImage } from '@/features/canvas/application/imageRelight';

export interface LightEditorContentProps {
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
 * The **pure content layer** of the lighting editor: the complete editor panel + submission orchestration, with no React Flow
 * dependency whatsoever (no NodeToolbar / useReactFlow / ZoomScaledToolbar), so it can be mounted below a canvas node
 * (LightEditorOverlay) and also stuffed into the storyboard's centered dialog (AssetBoardRelightDialog).
 *
 * Submission goes through application/imageRelight (the same source as the workflow); this component does not touch selection/viewport,
 * and always hands off to the host via onSubmitted.
 */
export const LightEditorContent = memo(
  ({ node, imageSource, onClose, onSubmitted }: LightEditorContentProps) => {
    const handleSubmit = useCallback(
      (payload: LightEditorSubmitPayload) => {
        const result = relightImage(node.id, imageSource, payload);
        if (!result) return;
        onSubmitted?.(result.nodeId);
        onClose();
      },
      [imageSource, node.id, onClose, onSubmitted],
    );

    return (
      <LightEditorPanel
        imageSource={imageSource}
        onClose={onClose}
        onSubmit={handleSubmit}
      />
    );
  },
);

LightEditorContent.displayName = 'LightEditorContent';
