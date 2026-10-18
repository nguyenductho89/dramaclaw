// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback } from 'react';

import { useCanvasStore } from '@/stores/canvasStore';

/**
 * Return a function for "unreferencing an upstream material".
 *
 * Unreferencing is essentially deleting the edge between "upstream node -> current node",
 * and the canvas persists automatically when edges change, with no extra handling needed.
 *
 * @param nodeId the current node id (the edge's target)
 * @returns detach(sourceNodeId) - delete all incoming edges from sourceNodeId
 */
export function useDetachUpstream(nodeId: string) {
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);

  return useCallback(
    (sourceNodeId: string) => {
      const { edges } = useCanvasStore.getState();
      edges
        .filter((edge) => edge.source === sourceNodeId && edge.target === nodeId)
        .forEach((edge) => deleteEdge(edge.id));
    },
    [nodeId, deleteEdge],
  );
}
