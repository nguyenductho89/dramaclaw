// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from 'vitest';

import {
  focusReferenceNode,
  useViewportReturnStore,
} from '@/features/canvas/application/viewportReturnStore';
import { useCanvasStore } from '@/stores/canvasStore';

describe('focusReferenceNode', () => {
  beforeEach(() => {
    useViewportReturnStore.getState().stop();
    useCanvasStore.setState({
      currentViewport: { x: 120, y: -40, zoom: 0.75 },
      pendingFocusNodeId: null,
    });
  });

  it('focuses the referenced node and records a way back to the origin node', () => {
    focusReferenceNode('ref-node', 'origin-node');

    expect(useCanvasStore.getState().pendingFocusNodeId).toBe('ref-node');
    expect(useViewportReturnStore.getState().request).toEqual({
      originViewport: { x: 120, y: -40, zoom: 0.75 },
      originNodeId: 'origin-node',
    });
  });

  it('stores a viewport snapshot rather than the live object in the store', () => {
    focusReferenceNode('ref-node', 'origin-node');
    // The jump itself changes currentViewport; the "original viewport" must not change along with it,
    // otherwise "return to node" goes back to the post-jump position, which is the same as not returning.
    useCanvasStore.setState({ currentViewport: { x: 999, y: 999, zoom: 2 } });

    expect(useViewportReturnStore.getState().request?.originViewport).toEqual({
      x: 120,
      y: -40,
      zoom: 0.75,
    });
  });

  it('stop is idempotent: it produces no new state object when already collapsed', () => {
    const before = useViewportReturnStore.getState();
    useViewportReturnStore.getState().stop();
    expect(useViewportReturnStore.getState()).toBe(before);
  });
});
