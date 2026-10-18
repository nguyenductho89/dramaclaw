// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';

import {
  CANVAS_NODE_TYPES,
  type VideoNodeData,
} from '@/features/canvas/domain/canvasNodes';
import type { AssetLibrarySelection } from '@/features/canvas/ui/AssetLibraryModal';
import { useCanvasStore } from '@/stores/canvasStore';

/** Fallback when the target node's height was not measured (= ImageGenNode's DEFAULT_HEIGHT). */
const FALLBACK_TARGET_HEIGHT = 360;
/** Same as above, video side (= VideoNode's DEFAULT_HEIGHT). */
const FALLBACK_VIDEO_TARGET_HEIGHT = 380;
const UPLOAD_WIDTH = 320;
const UPLOAD_HEIGHT = 240;
const GAP_X = 40;
const GAP_Y = 24;

/** Drop point of the idx-th reference node stacked vertically to the left of the target node. */
function stackedSpawnPositions(
  target: { position: { x: number; y: number }; height?: number | null },
  count: number,
  fallbackHeight: number,
): { baseX: number; startY: number } {
  const baseX = target.position.x - UPLOAD_WIDTH - GAP_X;
  const totalH = UPLOAD_HEIGHT * count + GAP_Y * (count - 1);
  const startY =
    target.position.y + ((target.height ?? fallbackHeight) - totalH) / 2;
  return { baseX, startY };
}

/**
 * Generate upstream upload reference nodes from images selected in the asset library: one upload node per selected image, stacked
 * vertically to the left of the target node, then connected to the target node as reference images (multi-image references go straight into reference_urls).
 *
 * It touches only canvasStore throughout (no React Flow context), so the workflow node (ImageGenNode) and
 * the generation form in the storyboard detail can share the same orchestration — the "Asset library" chips in both places behave identically.
 */
export function spawnAssetLibraryReferences(
  targetNodeId: string,
  selections: ReadonlyArray<AssetLibrarySelection>,
): void {
  const imageSelections = selections.filter((sel) => sel.media === 'image');
  if (imageSelections.length === 0) return;
  const state = useCanvasStore.getState();
  const self = state.nodes.find((n) => n.id === targetNodeId);
  if (!self) return;
  const { baseX, startY } = stackedSpawnPositions(
    self,
    imageSelections.length,
    FALLBACK_TARGET_HEIGHT,
  );
  const newIds: string[] = [];
  imageSelections.forEach((sel, idx) => {
    const y = startY + idx * (UPLOAD_HEIGHT + GAP_Y);
    const newId = state.addNode(
      CANVAS_NODE_TYPES.upload,
      { x: baseX, y },
      {
        imageUrl: sel.url,
        previewImageUrl: sel.url,
        displayName: sel.name || undefined,
      },
    );
    state.addEdge(newId, targetNodeId);
    newIds.push(newId);
  });
  state.autoGroupSpawn(targetNodeId, newIds, { label: i18n.t('node.imageGen.assetReferenceGroup') });
}

/**
 * Video node version: all three kinds of library assets are accepted, and different upstream nodes are created by media type —
 * - image → upload node (imageUrl);
 * - video → a `referenceOnly` video node (can play the video itself, recognized by isVideoNode,
 *   so downstream auto-switches to videoEdit; the early upload node stuffed with videoUrl neither displayed nor was recognized);
 * - audio → audio node (audioUrl).
 *
 * Like the image version it touches only canvasStore (no React Flow context), so the workflow's VideoNode and
 * the video generation form in the storyboard detail share this one orchestration, and the "Asset library" chips in both places behave identically.
 */
export function spawnVideoAssetLibraryReferences(
  targetNodeId: string,
  selections: ReadonlyArray<AssetLibrarySelection>,
): void {
  if (selections.length === 0) return;
  const state = useCanvasStore.getState();
  const self = state.nodes.find((n) => n.id === targetNodeId);
  if (!self) return;
  // A newly created reference video node inherits the target node's ratio, so the player does not crop the asset skewed at the default ratio.
  const aspectRatio = (self.data as { aspectRatio?: unknown }).aspectRatio;
  const { baseX, startY } = stackedSpawnPositions(
    self,
    selections.length,
    FALLBACK_VIDEO_TARGET_HEIGHT,
  );
  const newIds: string[] = [];
  selections.forEach((sel, idx) => {
    const y = startY + idx * (UPLOAD_HEIGHT + GAP_Y);
    const displayName = sel.name || undefined;
    let newId: string;
    if (sel.media === 'audio') {
      newId = state.addNode(
        CANVAS_NODE_TYPES.audio,
        { x: baseX, y },
        { audioUrl: sel.url, displayName },
      );
    } else if (sel.media === 'video') {
      newId = state.addNode(
        CANVAS_NODE_TYPES.video,
        { x: baseX, y },
        {
          videoUrl: sel.url,
          aspectRatio,
          displayName,
          referenceOnly: true,
        } as Partial<VideoNodeData>,
      );
    } else {
      newId = state.addNode(
        CANVAS_NODE_TYPES.upload,
        { x: baseX, y },
        { imageUrl: sel.url, previewImageUrl: sel.url, displayName },
      );
    }
    state.addEdge(newId, targetNodeId);
    newIds.push(newId);
  });
  state.autoGroupSpawn(targetNodeId, newIds, { label: i18n.t('node.imageGen.assetReferenceGroup') });
}
