// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';
import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { Boxes, Crop, Globe2, ImageUpscale, Lightbulb, RotateCw, Scaling } from 'lucide-react';

import {
  createCropResultNode,
  discardCropResultNode,
} from '@/features/canvas/application/imageCrop';
import {
  createRotateResultNode,
  discardRotateResultNode,
} from '@/features/canvas/application/imageRotate';
import { scene360Image } from '@/features/canvas/application/imageScene360';
import { createUpscaleResultNode } from '@/features/canvas/application/imageUpscale';
import { nodeMainlineFlags } from '@/features/canvas/domain/mainlineNodeFlags';
import { type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useFreezoneImageModels } from '@/features/canvas/hooks/useFreezoneImageModels';
import {
  DEFAULT_SHARED_MODEL_ID,
  SHARED_MODELS,
} from '@/features/canvas/ui/ProviderModelPicker';
import { useCanvasStore } from '@/stores/canvasStore';

import { ImageResizeDialog } from '../ImageResizeDialog';
import { AssetBoardCropDialog } from './AssetBoardCropDialog';
import { AssetBoardMultiAngleDialog } from './AssetBoardMultiAngleDialog';
import { AssetBoardRelightDialog } from './AssetBoardRelightDialog';
import { AssetBoardRotateDialog } from './AssetBoardRotateDialog';
import { createAssetBoardOpsRegistry } from './assetBoardOpsState';
import { DetailToolbarButton } from './AssetBoardToolbarButton';
// Type-only (erased at compile time), so it does not create a runtime circular import with AssetBoardDetailToolbar.
import type { MoreMenuEntry } from './AssetBoardDetailToolbar';

/**
 * Generation-type operations in progress (the trigger button turns into a spinner and recovers after settle).
 *
 * Upscale is not in this list: it now creates the node first and then submits with the up button in that node's detail; the in-progress feedback lands on the result
 * node itself (isGenerating -> "Generating X%" in the detail media area), so the source node has nothing to wait for.
 */
type BusyOp = 'crop' | 'rotate' | 'pano' | null;

/**
 * Registry of "in-progress operations + failure feedback" that survives remounts. The implementation and design rationale were lifted to
 * assetBoardOpsState.ts (the video detail toolbar reuses the same set); only the image-side instance is built here.
 */
const imageOpsRegistry = createAssetBoardOpsRegistry<Exclude<BusyOp, null>>();
const { markOpStart, markOpSettled, reportOpFailure } = imageOpsRegistry;
const useInFlightOp = (nodeId: string): BusyOp => imageOpsRegistry.useInFlightOp(nodeId);
const useOpFailure = (nodeId: string): string | null =>
  imageOpsRegistry.useOpFailure(nodeId);

/**
 * Exported for tests to assert (the busy-state registry that survives remounts: nodeId -> name of the operation in progress);
 * production code should only change it through the component's internal markOpStart / markOpSettled, not manipulate it directly.
 */
export const inFlightImageOps: ReadonlyMap<string, Exclude<BusyOp, null>> =
  imageOpsRegistry.inFlight;

/**
 * For tests only: clear the two module-level registries (in-progress operations + failure text), avoiding cross-talk between cases
 * via fixed node ids (such as the test's 'img-up') - production code never needs to call this.
 */
export function __resetAssetBoardImageOpsStateForTest(): void {
  imageOpsRegistry.resetForTest();
}

/**
 * Unified wrap-up of generation-type operations: the result node is already created synchronously -> immediately request viewport pre-positioning (so the viewport is in place
 * when switching back to the workflow, see Task 10), and set the source node's trigger entry busy until the background chain settles.
 *
 * A module-level function rather than an in-component useCallback: the three edit items (upscale/crop/rotate) were split into
 * {@link useAssetBoardImageEditActions}, sharing the same wrap-up logic with the panorama that still lives in {@link AssetBoardImageOps};
 * both sides depend only on nodeId.
 */
function trackSpawn(
  sourceNodeId: string,
  op: Exclude<BusyOp, null>,
  resultNodeId: string,
  completion: Promise<void>,
): void {
  useCanvasStore.getState().requestFocusNode(resultNodeId);
  markOpStart(sourceNodeId, op);
  void completion.finally(() => {
    markOpSettled(sourceNodeId);
    // The failure was only written on the newly created result node (generationError), so add a red hint line on the source node side
    // - otherwise a user staying on the source node's detail panel would not see at all that the operation just failed.
    const resultNode = useCanvasStore.getState().nodes.find((n) => n.id === resultNodeId);
    const errorMessage = (resultNode?.data as { generationError?: unknown } | undefined)
      ?.generationError;
    if (typeof errorMessage === 'string' && errorMessage) {
      reportOpFailure(sourceNodeId, errorMessage);
    }
  });
}

/**
 * Menu entries and editor dialogs for the three image "Edit" items - **Upscale / Crop / Rotate**.
 *
 * Why a hook rather than a component: the user asked to remove the "Edit" dropdown on the toolbar and move these three into the rightmost
 * "..." menu; the "..." is rendered by AssetBoardImageDetailToolbar and must come after "Grid
 * templates". The menu entries can only be assembled by the caller, while the dialogs and state like cropNodeId/rotateNodeId
 * are returned along with `overlays` to be mounted.
 *
 * - Upscale "create the node first, do not submit" (matches liblib): create an empty upscale result node downstream and switch the detail
 *   to it; the parameters are adjusted in the upscale editor below the new node's detail and only submitted with the up button (AssetBoardUpscaleForm).
 * - Crop / rotate both use the large-image live-preview editor: pre-create the result node first, the editor transforms locally on it and
 *   writes back, and cancelling reclaims it. The orchestration all goes through application/image* (same source as the workflow overlays, consistent semantics).
 *
 * Excludes the workflow side's redraw / erase (they need brushing a mask on the image, which storyboard detail does not do) and outpaint (its slot was given to
 * crop) - both are trade-offs the user decided.
 */
export function useAssetBoardImageEditActions({
  node,
  imageSource,
  onOpenNode,
}: {
  node: CanvasNode;
  /** The image source resolved by the caller; empty means this node has no image to edit yet, and empty entries are returned. */
  imageSource: string | null;
  /**
   * After a new node is created, switch the detail to it (same path as grid templates / the header's "Create copy"). Upscale relies on
   * it to bring the user into the detail of the newly created upscale node to adjust parameters - without switching the detail the user cannot tell what happened.
   */
  onOpenNode?: (nodeId: string) => void;
}): { entries: MoreMenuEntry[]; overlays: ReactElement | null } {
  const busyOp = useInFlightOp(node.id);
  // Crop / rotate: create the result node before entering the editor (same as the workflow SelectedNodeOverlay),
  // the editor live-previews and writes the result back into this node on save; cancelling reclaims it.
  const [cropNodeId, setCropNodeId] = useState<string | null>(null);
  const [rotateNodeId, setRotateNodeId] = useState<string | null>(null);
  const [resizeOpen, setResizeOpen] = useState(false);

  const { models: imageModels } = useFreezoneImageModels();
  // Model selection priority is the same as the workflow UpscaleEditorOverlay / OutpaintEditorOverlay: prefer the
  // default shared model (DEFAULT_SHARED_MODEL_ID), fall back to the first available model if it is not in the available list,
  // and only if none is available fall back to the hard-coded SHARED_MODELS.
  const selectedModelId =
    (imageModels.find((model) => model.id === DEFAULT_SHARED_MODEL_ID)
      ?? imageModels[0]
      ?? SHARED_MODELS.find((model) => model.id === DEFAULT_SHARED_MODEL_ID))?.id
    ?? DEFAULT_SHARED_MODEL_ID;

  // The same show/hide semantics as the workflow NodeActionToolbar: preset_managed (mainline projection locked) nodes
  // hide the entries that "rewrite the source image in place" - upscale and rotate both write back via updateNodeData, which would break
  // canonical immutability; crop spawns a user_spawned child node and stays available as usual when locked.
  const isPresetLocked = useMemo(() => nodeMainlineFlags(node).isPresetManaged, [node]);

  /**
   * Upscale = **create the node first, do not submit** (matches liblib, the same path as grid templates): create an empty upscale result node downstream of the source image,
   * the detail switches to it right away, and the user chooses the model/quality/scale in the upscale editor below the new node's detail
   * and only really submits with the up button (AssetBoardUpscaleForm).
   *
   * It no longer submits on the spot here, so the source node's busy state is not attached either - the in-progress feedback lands on the result node
   * itself (isGenerating -> "Generating X%" in the detail media area).
   */
  const handleOpenHd = useCallback(() => {
    if (busyOp) return;
    const resultNodeId = createUpscaleResultNode(node.id, {
      displayName: i18n.t('canvas.assetBoard.imageOps.upscaleNode'),
      modelId: selectedModelId,
    });
    if (!resultNodeId) return;
    // Low-cost viewport pre-positioning (M7): the result node is already created synchronously, the kept-alive Canvas first aims the viewport at
    // it, so the user does not have to find it when switching back to the workflow.
    useCanvasStore.getState().requestFocusNode(resultNodeId);
    onOpenNode?.(resultNodeId);
  }, [busyOp, node.id, onOpenNode, selectedModelId]);

  /**
   * Open the crop editor: same path as rotate - first create the "crop result" node (the source image stays untouched),
   * and the editor writes the result directly onto this node. Reclaimed by handleCloseCrop when the user cancels.
   */
  const handleOpenCrop = useCallback(() => {
    if (busyOp) return;
    const resultNodeId = createCropResultNode(node.id, { displayName: i18n.t('canvas.assetBoard.imageOps.cropResult') });
    if (!resultNodeId) return;
    setCropNodeId(resultNodeId);
  }, [busyOp, node.id]);

  const handleCloseCrop = useCallback(
    (committed: boolean) => {
      // Not committed (exit / Esc / the crop frame is the whole image) -> reclaim the pre-created result node.
      if (!committed && cropNodeId) discardCropResultNode(cropNodeId);
      setCropNodeId(null);
    },
    [cropNodeId],
  );

  const handleCropCommitted = useCallback(
    (completion: Promise<void>) => {
      if (cropNodeId) trackSpawn(node.id, 'crop', cropNodeId, completion);
    },
    [cropNodeId, node.id],
  );

  /**
   * Open the rotate editor: consistent with the workflow, first create the "rotate result" node (the source image stays untouched),
   * and the editor writes the result directly onto this node. Reclaimed by handleCloseRotate when the user cancels.
   */
  const handleOpenRotate = useCallback(() => {
    if (busyOp) return;
    const resultNodeId = createRotateResultNode(node.id, { displayName: i18n.t('canvas.assetBoard.imageOps.rotateResult') });
    if (!resultNodeId) return;
    setRotateNodeId(resultNodeId);
  }, [busyOp, node.id]);

  const handleCloseRotate = useCallback(
    (committed: boolean) => {
      // Not committed (exit / Esc / no transform made) -> reclaim the pre-created result node, avoiding an empty node appearing from nowhere.
      if (!committed && rotateNodeId) discardRotateResultNode(rotateNodeId);
      setRotateNodeId(null);
    },
    [rotateNodeId],
  );

  const handleRotateCommitted = useCallback(
    (completion: Promise<void>) => {
      if (rotateNodeId) trackSpawn(node.id, 'rotate', rotateNodeId, completion);
    },
    [node.id, rotateNodeId],
  );

  const entries: MoreMenuEntry[] = !imageSource
    ? []
    : (
        [
          { kind: 'action', key: 'hd', icon: ImageUpscale, label: i18n.t('canvas.assetBoard.imageOps.upscale'), onSelect: handleOpenHd },
          { kind: 'action', key: 'crop', icon: Crop, label: i18n.t('canvas.assetBoard.imageOps.crop'), busy: busyOp === 'crop', onSelect: handleOpenCrop },
          { kind: 'action', key: 'resize', icon: Scaling, label: i18n.t('resizeEditor.title'), onSelect: () => { if (!busyOp) setResizeOpen(true); } },
          { kind: 'action', key: 'rotate', icon: RotateCw, label: i18n.t('canvas.assetBoard.imageOps.rotate'), busy: busyOp === 'rotate', onSelect: handleOpenRotate },
        ] satisfies MoreMenuEntry[]
      ).filter((entry) => !(isPresetLocked && (entry.key === 'hd' || entry.key === 'rotate')));

  const overlays =
    !imageSource || (!cropNodeId && !rotateNodeId && !resizeOpen) ? null : (
      <>
        {resizeOpen && <ImageResizeDialog nodeId={node.id} imageSource={imageSource}
          onClose={() => setResizeOpen(false)} onCreated={onOpenNode} />}
        {/* Crop: large image + crop frame + floating control bar (same as liblib). Pure local canvas cutting,
        does not go through the generation API. */}
        {cropNodeId && (
          <AssetBoardCropDialog
            nodeId={cropNodeId}
            imageSource={imageSource}
            onClose={handleCloseCrop}
            onCommitted={handleCropCommitted}
          />
        )}
        {/* Rotate: large-image live preview + floating control bar (same as libtv), sharing the same content layer as the workflow RotateEditorOverlay,
        only with the shell swapped for a portal dialog. */}
        {rotateNodeId && (
          <AssetBoardRotateDialog
            nodeId={rotateNodeId}
            imageSource={imageSource}
            onClose={handleCloseRotate}
            onCommitted={handleRotateCommitted}
          />
        )}
      </>
    );

  return { entries, overlays };
}

interface AssetBoardImageOpsProps {
  node: CanvasNode;
  /** The image source resolved by the caller using resolveNodeSourceImageUrl (when there is no source the caller does not render this component). */
  imageSource: string;
}

/**
 * The image generation operation area of the storyboard detail: three always-visible buttons **Panorama / Multi-angle / Relight**.
 *
 * The three edit items (upscale/crop/rotate) are not here - they moved into the "..." menu at the far right of the toolbar, with entries and dialogs provided by
 * {@link useAssetBoardImageEditActions} (the user asked to remove the "Edit" dropdown).
 *
 * - Multi-angle / relight open the workflow's full dialog editors (AssetBoardMultiAngleDialog /
 *   AssetBoardRelightDialog, also portaled to document.body); sphere angle picking / light-ball direction,
 *   sliders, quality, prompt switch, compute cost and submit are all handled in the dialog content layer.
 * - Panorama has no required parameters, and submits right after confirmation.
 *
 * Returns a fragment: the buttons land directly in the caller's flex-wrap toolbar, and the parameter dialogs are all portaled
 * to body, no longer taking toolbar space. The failure fallback text (including crop/rotate failures) is also mounted here -
 * the three operations share the same registry keyed by nodeId.
 */
export function AssetBoardImageOps({
  node,
  imageSource,
}: AssetBoardImageOpsProps): ReactElement {
  // The busy state survives remounts (the detail toolbar remounts as a whole by key={node.id}), it is not component-local
  // state - see the note on inFlightImageOps.
  const busyOp = useInFlightOp(node.id);
  const opFailure = useOpFailure(node.id);
  // Multi-angle / relight: no longer an inline config row, but open the workflow's full dialog editors
  // (AssetBoardMultiAngleDialog / AssetBoardRelightDialog); busy/compute/submit are all handled
  // in the dialog content layer, and here we only manage open/close.
  const [multiAngleOpen, setMultiAngleOpen] = useState(false);
  const [relightOpen, setRelightOpen] = useState(false);

  const handlePanoSubmit = useCallback(() => {
    if (busyOp) return;
    if (!window.confirm(i18n.t('canvas.assetBoard.imageOps.panoConfirm'))) return;
    const result = scene360Image(node.id, imageSource, {
      displayName: i18n.t('canvas.assetBoard.imageOps.panoNodeName'),
      aspectRatio: '2:1',
    });
    if (!result) return;
    trackSpawn(node.id, 'pano', result.nodeId, result.completion);
  }, [busyOp, imageSource, node.id]);

  return (
    <>
      <DetailToolbarButton
        icon={Globe2}
        label={i18n.t('canvas.assetBoard.imageOps.pano')}
        busy={busyOp === 'pano'}
        disabled={busyOp !== null}
        title={i18n.t('canvas.assetBoard.imageOps.panoTitle')}
        onClick={handlePanoSubmit}
      />
      <DetailToolbarButton
        icon={Boxes}
        label={i18n.t('canvas.assetBoard.imageOps.multiAngle')}
        disabled={busyOp !== null}
        title={i18n.t('canvas.assetBoard.imageOps.multiAngleTitle')}
        onClick={() => setMultiAngleOpen(true)}
      />
      <DetailToolbarButton
        icon={Lightbulb}
        label={i18n.t('canvas.assetBoard.imageOps.relight')}
        disabled={busyOp !== null}
        title={i18n.t('canvas.assetBoard.imageOps.relightTitle')}
        onClick={() => setRelightOpen(true)}
      />

      {/* Operation failure fallback feedback: the failure info is only written on the newly created result node, and the user still on the source node detail
      panel cannot see it; add a red text line here that disappears automatically after settle (see the note of reportOpFailure). */}
      {opFailure && (
        <div
          role="alert"
          className="w-full rounded-[6px] border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[12px] text-red-300"
        >
          {opFailure}
        </div>
      )}

      {/* Multi-angle / relight: the workflow's full dialog editors (sphere angle picking / light-ball direction + sliders +
      quality + prompt switch + compute cost + submit), a centered dialog portaled to document.body.
      After a successful submit the dialog requests viewport pre-positioning and closes by itself (see the onSubmitted combination of AssetBoardMultiAngleDialog /
      AssetBoardRelightDialog), and here we only manage the open/close state. */}
      {multiAngleOpen && (
        <AssetBoardMultiAngleDialog
          node={node}
          imageSource={imageSource}
          onClose={() => setMultiAngleOpen(false)}
        />
      )}
      {relightOpen && (
        <AssetBoardRelightDialog
          node={node}
          imageSource={imageSource}
          onClose={() => setRelightOpen(false)}
        />
      )}
    </>
  );
}
