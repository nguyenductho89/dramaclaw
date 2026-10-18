// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo } from 'react';
import { NodeToolbar as ReactFlowNodeToolbar, Position } from '@xyflow/react';

import { type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import type {
  LightMainLightDescriptor,
  LightSmartModeDescriptor,
} from '@/features/canvas/ui/LightEditorPanel';
import { LightEditorContent } from '@/features/canvas/ui/LightEditorContent';
import { NODE_TOOLBAR_CLASS } from './nodeToolbarConfig';
import { ZoomScaledToolbar } from './ZoomScaledToolbar';

export interface LightEditorRequestPayload {
  sourceNodeId: string;
  imageSource: string;
  brightness: number;
  color: string;
  mainLight: LightMainLightDescriptor;
  rimLight: boolean;
  smartMode: LightSmartModeDescriptor;
  prompt: string;
  displayName: string;
  generationMode: 'image_reference';
  requestAspectRatio: 'auto';
  submittedAt: string;
}

interface LightEditorOverlayProps {
  node: CanvasNode;
  imageSource: string;
  onClose: () => void;
}

/**
 * The **workflow shell** of the lighting editor: hangs the content layer (LightEditorContent) below the canvas node and
 * follows the canvas zoom. The editor itself and the submission orchestration are both in the content layer, and only positioning +
 * "select the new result node after submission" remain here - equivalent to before the split (onSubmitted=setSelectedNode,
 * the content layer calls onClose after it, in the same order as the old handleSubmit).
 */
export const LightEditorOverlay = memo(
  ({ node, imageSource, onClose }: LightEditorOverlayProps) => {
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
          <LightEditorContent
            node={node}
            imageSource={imageSource}
            onClose={onClose}
            onSubmitted={setSelectedNode}
          />
        </ZoomScaledToolbar>
      </ReactFlowNodeToolbar>
    );
  }
);

LightEditorOverlay.displayName = 'LightEditorOverlay';
