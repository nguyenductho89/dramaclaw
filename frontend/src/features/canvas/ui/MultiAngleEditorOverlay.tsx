// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo } from 'react';
import { NodeToolbar as ReactFlowNodeToolbar, Position } from '@xyflow/react';

import { type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { MultiAngleEditorContent } from '@/features/canvas/ui/MultiAngleEditorContent';
import { NODE_TOOLBAR_CLASS } from './nodeToolbarConfig';
import { ZoomScaledToolbar } from './ZoomScaledToolbar';

interface MultiAngleEditorOverlayProps {
  node: CanvasNode;
  imageSource: string;
  onClose: () => void;
}

/**
 * The **workflow shell** of the multi-dimension editor: hangs the content layer (MultiAngleEditorContent) below the canvas node
 * and follows the canvas zoom. The editor itself and the submission orchestration are both in the content layer, and only positioning +
 * "select the new result node after submission" remain here - equivalent to before the split (onSubmitted=setSelectedNode,
 * the content layer calls onClose after it, in the same order as the old handleSubmit).
 */
export const MultiAngleEditorOverlay = memo(
  ({ node, imageSource, onClose }: MultiAngleEditorOverlayProps) => {
    const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);

    return (
      <ReactFlowNodeToolbar
        nodeId={node.id}
        isVisible
        position={Position.Bottom}
        align="start"
        offset={16}
        className={NODE_TOOLBAR_CLASS}
      >
        {/* The operation area follows the canvas zoom (align=start -> anchor at the top-left corner, hugging the node's bottom edge). */}
        <ZoomScaledToolbar origin="top left">
          <MultiAngleEditorContent
            node={node}
            imageSource={imageSource}
            onClose={onClose}
            onSubmitted={setSelectedNode}
          />
        </ZoomScaledToolbar>
      </ReactFlowNodeToolbar>
    );
  },
);

MultiAngleEditorOverlay.displayName = 'MultiAngleEditorOverlay';
