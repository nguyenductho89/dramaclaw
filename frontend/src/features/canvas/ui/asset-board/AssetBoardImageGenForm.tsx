// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';
import { useCallback, useState, type ReactElement } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ImageGenerationForm } from '@/features/canvas/nodes/shared/ImageGenerationForm';
import { useImageGenerationForm } from '@/features/canvas/nodes/shared/useImageGenerationForm';
import { ReferenceValidationDialog } from '@/features/canvas/nodes/shared/ReferenceValidationDialog';
import { useImageOpFormProps } from '@/features/canvas/nodes/shared/useImageOpFormProps';
import { spawnAssetLibraryReferences } from '@/features/canvas/nodes/shared/assetLibraryReferenceSpawn';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import {
  AssetLibraryModal,
  type AssetLibrarySelection,
} from '@/features/canvas/ui/AssetLibraryModal';
import { CANVAS_NODE_OPS_PANEL_CLASS } from '@/features/canvas/ui/nodeFrameStyles';
import {
  NODE_REFERENCE_MEDIA_CHIP_CLASS,
  NODE_REFERENCE_MEDIA_DETACH_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import { useCanvasStore } from '@/stores/canvasStore';
import { readUrl } from '@/lib/url-params';

import { AssetBoardReferenceDropZone } from './AssetBoardReferenceDropZone';

/**
 * The fixed height of the form in the detail. Cut from 248 to 184 (user request): the detail is now "media fills +
 * generation bar pinned to the bottom", and however tall the form is, the content area above is that much shorter; 184 still holds 4~5 lines of prompt.
 */
const FORM_HEIGHT_PX = 184;

/**
 * The image generation bar in the storyboard detail: `ImageGenerationForm` is mounted below the media area, so an **empty node** can
 * generate an image from scratch and a node with existing products can change parameters and regenerate (going through the same `useImageGenerationForm` as the workflow,
 * so parameters/prompt/reference images share the node data on all three sides, and the two views sync naturally).
 *
 * How the two host overlay props land:
 * - `onStylePickerOpenChange`: the workflow uses it to temporarily hide the "generation history" strip stacked below the panel;
 *   the detail panel has no such history, hence a no-op.
 * - `onOpenAssetLibrary`: wired to the real dialog. The selected images generate upload reference nodes on the canvas and connect to this node
 *   (the orchestration is shared with the workflow via `spawnAssetLibraryReferences`), and after flowing back appear as the reference images in the form's
 *   chips row - not a button that does nothing when clicked.
 *
 * A node's own reference image (`data.referenceImageUrl`, picked directly from the asset library / replace material, with no upstream edge)
 * is not shown by the shared form `ImageGenerationForm` (it only renders upstream-edge reference chips). The storyboard detail's bottom
 * "Reference assets" read-only row is removed when there is a generation form (to avoid duplicating the form chips), and without adding it back here the own
 * reference image would vanish from the detail - so an own-reference chip is added at the top of the form here (right next to the upstream chips and
 * in the same style), rendered only in the host, with zero changes to the shared form. */
export function AssetBoardImageGenForm({ nodeId }: { nodeId: string }): ReactElement {
  const { t } = useTranslation();
  const { formProps, isGenerating, referenceImageUrl, referenceErrors, referenceErrorsOpen, closeReferenceErrors, openReferenceErrors } = useImageGenerationForm(nodeId);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [isAssetLibraryOpen, setIsAssetLibraryOpen] = useState(false);

  // Feature node (the kind built after clicking a one-image feature on the toolbar): the input box gets one extra switchable/removable
  // feature chip, and the up button goes through the matching capability rather than regular text-to-image. The differing part shares the same hook with the workflow;
  // ordinary image generation nodes have no `imageOpKey`, get null, and the rendering degrades to the original behavior.
  const opFormProps = useImageOpFormProps(nodeId, { isGenerating });

  const noopStylePickerOpenChange = useCallback(() => {}, []);
  const handleAssetLibraryConfirm = useCallback(
    (selections: ReadonlyArray<AssetLibrarySelection>) => {
      spawnAssetLibraryReferences(nodeId, selections);
    },
    [nodeId],
  );

  return (
    <div className="flex w-full flex-col">
      <ReferenceValidationDialog issues={referenceErrors} open={referenceErrorsOpen} onClose={closeReferenceErrors} />
      {referenceErrors.length > 0 && (
        <button type="button" className="self-start text-xs text-red-400"
          onClick={openReferenceErrors}>{t('referenceValidation.title')}</button>
      )}
      {/* Reference-area drop layer: dragging a node card in from the left list -> addEdge connects it as an upstream reference of the current node,
      and after flowing back it shows as a reference thumbnail chip via the form's existing upstream derivation (zero change to the workflow). */}
      <AssetBoardReferenceDropZone nodeId={nodeId}>
        <div
          className={`flex w-full flex-col rounded-[var(--node-radius)] ${CANVAS_NODE_OPS_PANEL_CLASS}`}
          style={{ height: FORM_HEIGHT_PX }}
        >
          {/* Own reference image chip (the shared form does not render this one): added right above the form's chip row, and the remove
          button clears data.referenceImageUrl (the same patch as the workflow ImageGenNode's "remove reference image").
          Appears only when an own reference image exists. */}
          {referenceImageUrl && (
            <div className="flex shrink-0 items-center gap-1.5 pl-3 pt-3">
              <div className={NODE_REFERENCE_MEDIA_CHIP_CLASS} title={i18n.t('canvas.assetBoard.imageGenForm.ownReference')}>
                <img
                  src={resolveImageDisplayUrl(referenceImageUrl)}
                  alt={i18n.t('canvas.assetBoard.imageGenForm.referenceAlt')}
                  className="h-full w-full object-cover"
                  draggable={false}
                />
                <button
                  type="button"
                  title={i18n.t('canvas.assetBoard.imageGenForm.removeReference')}
                  className={NODE_REFERENCE_MEDIA_DETACH_CLASS}
                  onClick={() => updateNodeData(nodeId, { referenceImageUrl: null })}
                >
                  <X className="h-3 w-3" strokeWidth={2.5} />
                </button>
              </div>
            </div>
          )}
          {/* The feature chip goes through the shared form's `leadingChip` channel, landing **inside the prompt input box**,
          at the very front of the body (matches liblib): the feature description serves as the placeholder to its right, and backspace can delete it
          like a character. For non-feature nodes `opFormProps` is null, and rendering is the same as before. */}
          <ImageGenerationForm
            {...formProps}
            compact
            onStylePickerOpenChange={noopStylePickerOpenChange}
            onOpenAssetLibrary={() => setIsAssetLibraryOpen(true)}
            {...(opFormProps ?? {})}
          />
        </div>
      </AssetBoardReferenceDropZone>
      <AssetLibraryModal
        mode="pick"
        open={isAssetLibraryOpen}
        project={readUrl().project ?? null}
        allowedMedia={['image']}
        onClose={() => setIsAssetLibraryOpen(false)}
        onConfirm={handleAssetLibraryConfirm}
      />
    </div>
  );
}
