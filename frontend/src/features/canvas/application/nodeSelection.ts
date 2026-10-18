// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Programmatically "select only this one node".
 *
 * Calling setSelectedNode alone is not enough: it only writes selectedNodeId in the store, while the node's operation
 * panel is gated by the `selected` prop passed down from React Flow; worse, the one-way sync effect "React Flow selection -> store" in Canvas
 * writes selectedNodeId back to null on the next render (because no node is really selected). So a select
 * change must first be dispatched via onNodesChange and then the store synced - both are needed, and missing either amounts to not selecting.
 */
import { useCanvasStore } from '@/stores/canvasStore';

export function selectNodeExclusively(nodeId: string): void {
  const store = useCanvasStore.getState();
  if (!store.nodes.some((node) => node.id === nodeId)) return;
  const changes = store.nodes
    .filter((node) => Boolean(node.selected) !== (node.id === nodeId))
    .map((node) => ({
      id: node.id,
      type: 'select' as const,
      selected: node.id === nodeId,
    }));
  if (changes.length > 0) store.onNodesChange(changes);
  store.setSelectedNode(nodeId);
}
