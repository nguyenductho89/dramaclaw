// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback } from 'react';
import { useStore } from '@xyflow/react';

import { deriveNodeDropInfo, useAssetDropStore } from '@/stores/assetDropStore';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';

/**
 * The gesture "press and drag to the left asset library to replace same-type assets". It originally lived only on the AssetCommitHandle
 * button floating outside the node; it was extracted so the replace button at the top-right inside the node
 * (NodeMediaReplaceButton) can carry the same gesture too: the same corner should not hold two identical-looking
 * replace buttons that each do their own thing.
 *
 * The whole drag is self-driven with native pointer events (not HTML5 DnD), therefore:
 * - the replacement is only committed when released over a same-type asset card on the left;
 * - the drag preview overlay is rendered by NodeReplaceDragPreview reading the store.
 */
export function useAssetCommitDrag(node: CanvasNode | null | undefined) {
  const dropInfo = node ? deriveNodeDropInfo(node) : null;
  const sourceUrl = dropInfo?.sourceUrl ?? null;
  const nodeId = node?.id ?? null;

  const startDrag = useCallback(() => {
    if (!nodeId || !dropInfo || !sourceUrl) return;

    useAssetDropStore.getState().beginDrag({
      nodeId,
      mediaType: dropInfo.mediaType,
      sourceUrl,
      thumbUrl: dropInfo.thumbUrl,
      label: dropInfo.label,
      directorControlBundle: dropInfo.directorControlBundle,
    });

    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';

    const onMove = (e: PointerEvent) => {
      const drag = useAssetDropStore.getState().activeDrag;
      const elements = document.elementsFromPoint(e.clientX, e.clientY);
      let hoverId: string | null = null;
      for (const el of elements) {
        const card = (el as Element).closest?.(
          '[data-asset-id]',
        ) as HTMLElement | null;
        if (!card) continue;
        const assetType = card.dataset.assetMediaType;
        if (drag && assetType && assetType === drag.mediaType) {
          hoverId = card.dataset.assetId ?? null;
        }
        break;
      }
      useAssetDropStore.getState().setHoverAsset(hoverId);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
      // If a valid asset is hit, generate a replace request for the sidebar to consume.
      useAssetDropStore.getState().endDrag(true);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [dropInfo, nodeId, sourceUrl]);

  return { canCommit: Boolean(dropInfo && sourceUrl), startDrag };
}

/**
 * Inside a node component only id/data are available, not the full CanvasNode (the node type is also needed to determine
 * the media type), so the current node is taken directly from React Flow's nodeLookup.
 */
export function useAssetCommitDragById(nodeId: string) {
  const node = useStore(
    useCallback(
      (state) => (state.nodeLookup.get(nodeId) ?? null) as CanvasNode | null,
      [nodeId],
    ),
  );
  return useAssetCommitDrag(node);
}
