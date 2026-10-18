// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useState, type ReactElement } from 'react';

import { VideoGenerationForm } from '@/features/canvas/nodes/shared/VideoGenerationForm';
import { useVideoGenerationForm } from '@/features/canvas/nodes/shared/useVideoGenerationForm';
import { spawnVideoAssetLibraryReferences } from '@/features/canvas/nodes/shared/assetLibraryReferenceSpawn';
import {
  AssetLibraryModal,
  type AssetLibrarySelection,
} from '@/features/canvas/ui/AssetLibraryModal';
import { CANVAS_NODE_OPS_PANEL_CLASS } from '@/features/canvas/ui/nodeFrameStyles';
import { readUrl } from '@/lib/url-params';

import { AssetBoardReferenceDropZone } from './AssetBoardReferenceDropZone';

/**
 * The fixed height of the form in the detail. One notch taller than the image side (184px): the video form's parameter rows have a whole extra row
 * (mode / duration / scene optimization / audio / real-person review / count), and being shorter would squeeze the prompt area into one line.
 * Cut from 268 to 204 (user request): the prompt area still has about 5 lines, and the height saved goes to the video content box above -
 * the detail is now "media fills + generation bar pinned to the bottom", and however tall the form is, the content area is that much shorter.
 */
const FORM_HEIGHT_PX = 204;

/**
 * The video generation bar in the storyboard detail: `VideoGenerationForm` is mounted below the media area, so an **empty video node**
 * can generate a clip from scratch and a node with existing products can change parameters and regenerate (going through the same
 * `useVideoGenerationForm` as the workflow, so prompt/parameters/reference materials share the node data on all three sides, and the two views
 * sync naturally).
 *
 * `onOpenCharacterLibrary` is wired to a real dialog, not a dead button: the selected images/videos/audio generate upstream nodes of the matching type
 * on the canvas and connect to this node (the orchestration is shared with the workflow via
 * `spawnVideoAssetLibraryReferences`), and after flowing back appear as the reference materials in the form's chips row.
 * All three media kinds are open (unlike the image side that accepts only image) - the video genMode state machine is exactly driven by upstream types.
 */
export function AssetBoardVideoGenForm({ nodeId }: { nodeId: string }): ReactElement {
  const { formProps } = useVideoGenerationForm(nodeId);
  const [isAssetLibraryOpen, setIsAssetLibraryOpen] = useState(false);

  const handleAssetLibraryConfirm = useCallback(
    (selections: ReadonlyArray<AssetLibrarySelection>) => {
      spawnVideoAssetLibraryReferences(nodeId, selections);
    },
    [nodeId],
  );

  return (
    <div className="flex w-full flex-col">
      {/* Reference-area drop layer: dragging image/video/audio node cards in from the left list -> addEdge connects them as upstream
      references of the current node, and after flowing back they show as reference material chips via the form's existing upstream derivation (zero change to the workflow). */}
      <AssetBoardReferenceDropZone nodeId={nodeId}>
        <div
          className={`flex w-full flex-col rounded-[var(--node-radius)] ${CANVAS_NODE_OPS_PANEL_CLASS}`}
          style={{ height: FORM_HEIGHT_PX }}
        >
          {/* compact: the detail has no "enlarge" button stacked at the top-right as in the workflow, so drop the pr-10 the chips row
          reserved for it, otherwise a block is missing out of nowhere on the right of the first row. */}
          <VideoGenerationForm
            {...formProps}
            compact
            onOpenCharacterLibrary={() => setIsAssetLibraryOpen(true)}
          />
        </div>
      </AssetBoardReferenceDropZone>
      <AssetLibraryModal
        mode="pick"
        open={isAssetLibraryOpen}
        project={readUrl().project ?? null}
        onClose={() => setIsAssetLibraryOpen(false)}
        onConfirm={handleAssetLibraryConfirm}
      />
    </div>
  );
}
