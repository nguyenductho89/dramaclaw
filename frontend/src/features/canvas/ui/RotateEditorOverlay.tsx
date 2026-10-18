// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo } from 'react';
import { NodeToolbar as ReactFlowNodeToolbar, Position } from '@xyflow/react';

import {
  DEFAULT_NODE_WIDTH,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { NODE_TOOLBAR_CLASS } from './nodeToolbarConfig';
import { RotateEditorToolbar, useRotateEditor } from './rotateEditorContent';

interface RotateEditorOverlayProps {
  node: CanvasNode;
  imageSource: string;
  /**
   * Close the rotate editor. `committed` indicates whether a rotation was really committed (write-back to the node has started):
   *   - `false`: the user exits / presses Esc / closes with no transform at all - the caller should delete the "rotate result"
   *     node pre-created when entering rotation, avoiding a node appearing from nowhere.
   *   - `true`: the rotation result has started being written back to that node, and the caller keeps it.
   */
  onClose: (committed: boolean) => void;
}

/**
 * The rotate editor shell on the workflow canvas: both the preview and the control bar hang on the NodeToolbar above the node,
 * transformed by the viewport together with the node. The state machine and the control bar itself are in `rotateEditorContent`, shared with the storyboard
 * detail page's `AssetBoardRotateDialog`.
 */
export const RotateEditorOverlay = memo(
  ({ node, imageSource, onClose }: RotateEditorOverlayProps) => {
    const controller = useRotateEditor({ nodeId: node.id, imageSource, onClose });

    const nodeWidth =
      typeof node.measured?.width === 'number'
        ? node.measured.width
        : typeof node.width === 'number'
          ? node.width
          : DEFAULT_NODE_WIDTH;
    const nodeHeight =
      typeof node.measured?.height === 'number'
        ? node.measured.height
        : typeof node.height === 'number'
          ? node.height
          : nodeWidth;

    return (
      <>
        {/* Opaque mask + live-transformed preview image, covering the original node image. */}
        <ReactFlowNodeToolbar
          nodeId={node.id}
          isVisible
          position={Position.Top}
          align="center"
          offset={0}
          className={`${NODE_TOOLBAR_CLASS} pointer-events-none`}
        >
          <div className="relative" style={{ width: 0, height: 0 }}>
            <div
              className="pointer-events-none absolute overflow-hidden rounded-md bg-bg-dark"
              style={{
                width: nodeWidth,
                height: nodeHeight,
                left: '50%',
                top: nodeHeight / 2,
                transform: 'translate(-50%, -50%)',
              }}
            >
              <img
                src={imageSource}
                alt=""
                draggable={false}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'contain',
                  transform: controller.transform,
                  transition: 'transform 120ms ease-out',
                }}
              />
            </div>
          </div>
        </ReactFlowNodeToolbar>

        {/* Control bar: floating above the node. */}
        <ReactFlowNodeToolbar
          nodeId={node.id}
          isVisible
          position={Position.Top}
          align="center"
          offset={25}
          className={NODE_TOOLBAR_CLASS}
        >
          {/* Title not shown: this control bar's width follows the node, and adding a title would push past the node boundary. */}
          <RotateEditorToolbar controller={controller} />
        </ReactFlowNodeToolbar>
      </>
    );
  },
);

RotateEditorOverlay.displayName = 'RotateEditorOverlay';
