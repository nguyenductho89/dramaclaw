// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload } from 'lucide-react';
import { Position } from '@xyflow/react';

import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  NODE_SIDE_ACTION_ICON_BUTTON_CLASS,
  NODE_SIDE_ACTION_ICON_CLASS,
  NodeSideActionRail,
} from '@/features/canvas/ui/NodeSideActionRail';
import { useAssetCommitDrag } from '@/features/canvas/ui/useAssetCommitDrag';

/**
 * The "drag to asset library to replace" handle at the top-right of the node. While pressing and dragging from the handle,
 * the node itself does not move on the canvas — the gesture is driven by useAssetCommitDrag with native pointer events.
 *
 * Icon only, no label: this button appears only when selected and sits against the node corner, and a "Replace material" text
 * pill would cover node content when zoomed; the semantics are carried by the title. The icon is unified with the replace button
 * inside the node (NodeMediaReplaceButton) as an upload icon — to users they are the same thing.
 *
 * Nodes that already have that replace button inside the card (allowLocalReplace) do not mount this handle; the drag gesture is
 * handled by the one inside the card, see SelectedNodeOverlay.
 */
export function AssetCommitHandle({ node }: { node: CanvasNode }) {
  const { t } = useTranslation();
  const { canCommit, startDrag } = useAssetCommitDrag(node);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      // Prevent React Flow from taking over -> the node will not be dragged.
      event.preventDefault();
      event.stopPropagation();
      startDrag();
    },
    [startDrag],
  );

  if (!canCommit) return null;

  return (
    <NodeSideActionRail nodeId={node.id} position={Position.Right} anchorAtCorner>
      <button
        type="button"
        onPointerDown={handlePointerDown}
        aria-label={t('canvas.assetReplace.handleLabel')}
        title={t('canvas.assetReplace.handleHint')}
        className={`${NODE_SIDE_ACTION_ICON_BUTTON_CLASS} active:cursor-grabbing`}
        style={{ cursor: 'grab' }}
      >
        <Upload className={NODE_SIDE_ACTION_ICON_CLASS} />
      </button>
    </NodeSideActionRail>
  );
}
