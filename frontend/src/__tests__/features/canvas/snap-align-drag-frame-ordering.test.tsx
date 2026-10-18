// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import { render } from '@testing-library/react';
import { useCallback, useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';

// createSnapAlignDragSession computes positionOffset as
// `getInternalNode(id).internals.positionAbsolute - node.position` and reuses
// that value throughout the whole drag. Only when both sources are taken from the same frame in which the session is established is the offset a pure parent
// offset; otherwise the first-frame displacement gets mixed into the offset and every snap line afterwards shifts as a whole.
//
// This contract depends on React Flow's update order: the drag loop modifies the dragItem copied out by getDragItems()
// (which contains a brand-new internals object), and updateNodePositions only hands the change to
// onNodesChange; neither writes nodeLookup. The positionAbsolute of nodeLookup is refreshed only when the controlled
// nodes flow back in. So the positionAbsolute read inside onNodesChange never runs ahead of the controlled
// store. The real drag path is used here to pin this order down, so it turns red if it changes when React Flow is upgraded.

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function installDomStubs() {
  // jsdom lacks these two: React Flow measures nodes with ResizeObserver and reads the zoom with DOMMatrixReadOnly.m22.
  // Assign via Object.assign to avoid scattering ts-expect-error over signature differences.
  Object.assign(globalThis, {
    ResizeObserver: StubResizeObserver,
    DOMMatrixReadOnly: class {
      m22 = 1;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 100 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 100 });
}

type Frame = {
  changePosition: { x: number; y: number };
  internalAbsolute: { x: number; y: number };
  storePosition: { x: number; y: number };
};

function Harness({ frames }: { frames: Frame[] }) {
  const rf = useReactFlow();
  const nodesRef = useRef<Node[]>([
    {
      id: 'a',
      position: { x: 0, y: 0 },
      data: {},
      width: 100,
      height: 100,
      measured: { width: 100, height: 100 },
    },
  ]);
  const [nodes, setNodes] = useState<Node[]>(nodesRef.current);

  const onNodesChange = useCallback(
    (changes: NodeChange<Node>[]) => {
      for (const change of changes) {
        if (change.type !== 'position' || !change.position) continue;
        const internal = rf.getInternalNode(change.id);
        const stored = nodesRef.current.find((n) => n.id === change.id);
        if (!internal || !stored) continue;
        // Sampling must happen before applyNodesChange -- the same timing at which Canvas.tsx establishes the snap session.
        frames.push({
          changePosition: { ...change.position },
          internalAbsolute: { ...internal.internals.positionAbsolute },
          storePosition: { ...stored.position },
        });
        const next = nodesRef.current.map((n) =>
          n.id === change.id ? { ...n, position: { ...change.position! } } : n,
        );
        nodesRef.current = next;
        setNodes(next);
      }
    },
    [rf, frames],
  );

  return (
    <div style={{ width: 800, height: 600 }}>
      <ReactFlow nodes={nodes} edges={[]} onNodesChange={onNodesChange} />
    </div>
  );
}

// jsdom does not accept view in the constructor arguments, but d3-drag's nodrag() reads event.view.document,
// so a view property is added after construction.
function dispatchMouse(type: string, target: EventTarget, clientX: number) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY: 0,
    button: 0,
    buttons: type === 'mouseup' ? 0 : 1,
  });
  Object.defineProperty(event, 'view', { value: window });
  target.dispatchEvent(event);
}

describe('drag frame order that snap-align depends on', () => {
  it('in the frame where the session is established, internals.positionAbsolute does not run ahead of the controlled store', () => {
    installDomStubs();
    const frames: Frame[] = [];

    const { container } = render(
      <ReactFlowProvider>
        <Harness frames={frames} />
      </ReactFlowProvider>,
    );
    const nodeEl = container.querySelector('.react-flow__node');
    expect(nodeEl).not.toBeNull();

    dispatchMouse('mousedown', nodeEl!, 0);
    for (const step of [2, 5, 9]) dispatchMouse('mousemove', document, step);
    dispatchMouse('mouseup', document, 9);

    expect(frames.length).toBeGreaterThan(0);

    // First frame = the frame in which the snap session is established. positionAbsolute must still equal the controlled store's position,
    // not this frame's new coordinates -- otherwise positionOffset would swallow the first-frame displacement.
    const first = frames[0];
    expect(first.internalAbsolute).toEqual(first.storePosition);
    expect(first.changePosition).not.toEqual(first.storePosition);

    // This node has no parent, so the derived offset must be 0 and must not carry the first-frame displacement.
    const positionOffset = {
      x: first.internalAbsolute.x - first.storePosition.x,
      y: first.internalAbsolute.y - first.storePosition.y,
    };
    expect(positionOffset).toEqual({ x: 0, y: 0 });
  });
});
