// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { type ReactElement } from 'react';

import { type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { CANVAS_NODE_OPS_PANEL_CLASS } from '@/features/canvas/ui/nodeFrameStyles';
import {
  UpscaleEditorPanel,
  useUpscaleEditor,
} from '@/features/canvas/ui/upscaleEditorContent';
import { useCanvasStore } from '@/stores/canvasStore';

/**
 * The "Upscale" editor in the storyboard detail: mounted below the media area, in the same position as the generation form of image/video/audio details,
 * with the same rhythm of "view the image above, adjust parameters below, press the up button to submit" (matches liblib).
 *
 * It follows "build the node first, submit only on the up button": when the toolbar's "Edit -> Upscale" is clicked, this resultKind:'upscale'
 * placeholder node has already been built downstream of the source image and the detail switched over (see handleOpenHd of AssetBoardImageOps),
 * so here only parameter changes and submission are handled, and building nodes is no longer its concern.
 *
 * The card itself shares `upscaleEditorContent` with the workflow's UpscaleEditorOverlay, only with the shell changed from
 * "a floating layer below the node" to "a form filling the detail panel", and with no "Cancel" given - the detail header already
 * has back and delete, and putting another one in the card would clash with them semantically.
 */
export function AssetBoardUpscaleForm({ nodeId }: { nodeId: string }): ReactElement | null {
  const node = useCanvasStore((state) => state.nodes.find((n) => n.id === nodeId) ?? null);
  // When the node is deleted while the detail is open (header "..." -> Delete), exit gracefully, rather than letting the hook below
  // run with a null node.
  if (!node) return null;
  return <UpscaleFormBody key={node.id} node={node} />;
}

/** Split a layer only so that useUpscaleEditor gets a non-null node - a hook cannot be written after an early-return branch. */
function UpscaleFormBody({ node }: { node: CanvasNode }): ReactElement {
  const controller = useUpscaleEditor({ node });
  return (
    <UpscaleEditorPanel
      controller={controller}
      className={`w-full rounded-[var(--node-radius)] p-4 ${CANVAS_NODE_OPS_PANEL_CLASS}`}
    />
  );
}
