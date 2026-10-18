// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from 'vitest';

import { selectNodeExclusively } from '@/features/canvas/application/nodeSelection';
import { useCanvasStore } from '@/stores/canvasStore';

function seedNodes() {
  useCanvasStore.setState({
    nodes: [
      { id: 'a', type: 'imageGen', position: { x: 0, y: 0 }, data: {}, selected: true },
      { id: 'b', type: 'imageGen', position: { x: 0, y: 0 }, data: {}, selected: false },
    ] as never,
    selectedNodeId: 'a',
  });
}

describe('selectNodeExclusively', () => {
  beforeEach(seedNodes);

  it('writes both React Flow selected and the store selectedNodeId', () => {
    selectNodeExclusively('b');

    const state = useCanvasStore.getState();
    // Writing only selectedNodeId is not enough: the node operation panel is gated on selected, and the Canvas
    // "RF -> store" sync effect would immediately wipe a selectedNodeId that nobody has selected to null.
    expect(state.nodes.map((node) => [node.id, Boolean(node.selected)])).toEqual([
      ['a', false],
      ['b', true],
    ]);
    expect(state.selectedNodeId).toBe('b');
  });

  it('does nothing when the node is no longer on the canvas', () => {
    selectNodeExclusively('gone');

    const state = useCanvasStore.getState();
    expect(state.selectedNodeId).toBe('a');
    expect(state.nodes.find((node) => node.id === 'a')?.selected).toBe(true);
  });
});
