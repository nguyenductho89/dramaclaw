// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  nextAutoTitleIndex,
  resolveNodeDisplayName,
} from '@/features/canvas/domain/nodeDisplay';
import { useCanvasStore } from '@/stores/canvasStore';

function nodeOf(id: string, type: string, data: Record<string, unknown> = {}): CanvasNode {
  return { id, type, position: { x: 0, y: 0 }, data } as unknown as CanvasNode;
}

/** Gets the title a node currently renders (default name + auto sequence number). */
function titleOf(nodeId: string): string {
  const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
  if (!node?.type) throw new Error(`node ${nodeId} not found`);
  return resolveNodeDisplayName(node.type, node.data);
}

describe('auto numbering of unnamed nodes', () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  it('nextAutoTitleIndex: an empty canvas starts at 1 and increments by the used numbers of the same type', () => {
    expect(nextAutoTitleIndex(CANVAS_NODE_TYPES.textAnnotation, [])).toBe(1);
    const nodes = [
      nodeOf('t1', CANVAS_NODE_TYPES.textAnnotation, { autoTitleIndex: 1 }),
      nodeOf('t2', CANVAS_NODE_TYPES.textAnnotation, { autoTitleIndex: 2 }),
      // Other types do not take part in issuing numbers for this type.
      nodeOf('i1', CANVAS_NODE_TYPES.imageGen, { autoTitleIndex: 7 }),
    ];
    expect(nextAutoTitleIndex(CANVAS_NODE_TYPES.textAnnotation, nodes)).toBe(3);
    expect(nextAutoTitleIndex(CANVAS_NODE_TYPES.imageGen, nodes)).toBe(8);
  });

  it('nextAutoTitleIndex: deleting a middle node does not reuse a number (max used + 1)', () => {
    const nodes = [nodeOf('t2', CANVAS_NODE_TYPES.textAnnotation, { autoTitleIndex: 2 })];
    // Number 1 was deleted, but the next still takes 3 and does not recycle 1.
    expect(nextAutoTitleIndex(CANVAS_NODE_TYPES.textAnnotation, nodes)).toBe(3);
  });

  it('nextAutoTitleIndex: nodes of an old canvas have no number -> raise the starting point by the same-type count to avoid the unnumbered default name', () => {
    const legacy = [
      nodeOf('t1', CANVAS_NODE_TYPES.textAnnotation, {}),
      nodeOf('t2', CANVAS_NODE_TYPES.textAnnotation, {}),
    ];
    expect(nextAutoTitleIndex(CANVAS_NODE_TYPES.textAnnotation, legacy)).toBe(3);
  });

  it('creating nodes of the same type in a row -> titles carry increasing numbers and never collide', () => {
    const store = useCanvasStore.getState();
    const a = store.addNode(CANVAS_NODE_TYPES.textAnnotation, { x: 0, y: 0 });
    const b = store.addNode(CANVAS_NODE_TYPES.textAnnotation, { x: 0, y: 100 });
    const img = store.addNode(CANVAS_NODE_TYPES.imageGen, { x: 200, y: 0 });

    expect(titleOf(a)).toBe('Text1');
    expect(titleOf(b)).toBe('Text2');
    // Images have their own numbering, unaffected by text.
    expect(titleOf(img)).toBe('Image node1');
  });

  it('the caller brings its own displayName (such as the various result nodes) -> no number is issued and the title stays as is', () => {
    const store = useCanvasStore.getState();
    const id = store.addNode(CANVAS_NODE_TYPES.imageGen, { x: 0, y: 0 }, { displayName: 'Cutout' });

    expect(titleOf(id)).toBe('Cutout');
    const node = useCanvasStore.getState().nodes.find((n) => n.id === id);
    expect(node?.data.autoTitleIndex).toBeUndefined();
  });

  it('the user changed the title -> the number no longer shows; reverting to blank falls back to the numbered default name', () => {
    const store = useCanvasStore.getState();
    const id = store.addNode(CANVAS_NODE_TYPES.textAnnotation, { x: 0, y: 0 });
    expect(titleOf(id)).toBe('Text1');

    useCanvasStore.getState().updateNodeData(id, { displayName: 'Opening remarks' });
    expect(titleOf(id)).toBe('Opening remarks');

    // displayName cleared -> back to the default name (the number is still on data, not overwritten).
    useCanvasStore.getState().updateNodeData(id, { displayName: '' });
    expect(titleOf(id)).toBe('Text1');
  });

  it('duplicating an unnamed node -> the copy gets a fresh number and does not collide with the source name', () => {
    const store = useCanvasStore.getState();
    const source = store.addNode(CANVAS_NODE_TYPES.textAnnotation, { x: 0, y: 0 });
    expect(titleOf(source)).toBe('Text1');

    const copy = useCanvasStore.getState().duplicateNodeAsSibling(source, 1);
    expect(copy).not.toBeNull();
    expect(titleOf(copy as string)).toBe('Text2');
  });
});
