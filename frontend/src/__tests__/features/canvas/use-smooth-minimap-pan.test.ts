// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSmoothMinimapPan } from "@/features/canvas/hooks/useSmoothMinimapPan";

const MINIMAP_RECT = { left: 100, top: 100, right: 300, bottom: 250, width: 200, height: 150 };
const FRAME_MS = 1000 / 60;

type TestNode = {
  id: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  parentId?: string;
  hidden?: boolean;
};

// The gain must be predictable, so nodes are laid out at a fixed size: viewScale = max(2000/200, 1500/150) = 10.
const PLAIN_NODES: TestNode[] = [
  { id: "n", position: { x: 0, y: 0 }, width: 2000, height: 1500 },
];

// ---- Manually driven rAF ---------------------------------------------------------
let rafCallbacks = new Map<number, FrameRequestCallback>();
let nextRafId = 1;
let now = 0;

function flushFrames(maxFrames: number) {
  for (let i = 0; i < maxFrames; i += 1) {
    if (rafCallbacks.size === 0) return;
    now += FRAME_MS;
    const pending = [...rafCallbacks.values()];
    rafCallbacks.clear();
    pending.forEach((cb) => cb(now));
  }
}

function pointerEvent(
  type: string,
  init: { pointerId: number; clientX: number; clientY: number; button?: number },
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
    button: init.button ?? 0,
  });
  Object.defineProperty(event, "pointerId", { value: init.pointerId });
  return event;
}

function mountMinimapDom() {
  const wrapper = document.createElement("div");
  const minimap = document.createElement("div");
  minimap.className = "react-flow__minimap";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  minimap.appendChild(svg);
  wrapper.appendChild(minimap);
  document.body.appendChild(wrapper);

  const rect = { ...MINIMAP_RECT, x: MINIMAP_RECT.left, y: MINIMAP_RECT.top, toJSON: () => ({}) };
  minimap.getBoundingClientRect = () => rect as DOMRect;
  svg.getBoundingClientRect = () => rect as DOMRect;
  return { wrapper, svg };
}

/**
 * Replicates `instance.getNodesBounds`: it carries nodeLookup, and group members are counted by **absolute position**
 * (parent position + relative position). The same-named static utility has no nodeLookup and would treat relative coordinates
 * as global coordinates -- the difference between the two is exactly what the group case below pins down.
 */
function makeGetNodesBounds(allNodes: TestNode[]) {
  const byId = new Map(allNodes.map((node) => [node.id, node]));
  const absolute = (node: TestNode): { x: number; y: number } => {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (!parent) return node.position;
    const base = absolute(parent);
    return { x: base.x + node.position.x, y: base.y + node.position.y };
  };
  return vi.fn((nodes: TestNode[]) => {
    if (nodes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    nodes.forEach((node) => {
      const { x, y } = absolute(node);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + node.width);
      maxY = Math.max(maxY, y + node.height);
    });
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  });
}

function makeInstance(nodes: TestNode[] = PLAIN_NODES, initial = { x: 0, y: 0, zoom: 0.5 }) {
  let viewport = { ...initial };
  const setViewport = vi.fn((next: { x: number; y: number; zoom: number }) => {
    viewport = { ...next };
  });
  return {
    getViewport: () => viewport,
    getNodes: () => nodes,
    getNodesBounds: makeGetNodesBounds(nodes),
    setViewport,
    current: () => viewport,
  };
}

describe("useSmoothMinimapPan", () => {
  beforeEach(() => {
    rafCallbacks = new Map();
    nextRafId = 1;
    now = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = nextRafId;
      nextRafId += 1;
      rafCallbacks.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      rafCallbacks.delete(id);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  function setup(nodes: TestNode[] = PLAIN_NODES) {
    const { wrapper, svg } = mountMinimapDom();
    const instance = makeInstance(nodes);
    const onPanStart = vi.fn();
    const onPanEnd = vi.fn();
    const onViewportSettled = vi.fn();
    const view = renderHook(() =>
      useSmoothMinimapPan({
        enabled: true,
        wrapperRef: { current: wrapper },
        // Only the four methods getViewport / getNodes / getNodesBounds / setViewport are used.
        instance: instance as never,
        onPanStart,
        onPanEnd,
        onViewportSettled,
      }),
    );
    return { view, svg, instance, onPanStart, onPanEnd, onViewportSettled };
  }

  it("keeps panning after the pointer is dragged out of the minimap, ending only at pointerup", () => {
    const { svg, instance, onPanStart, onPanEnd } = setup();

    svg.dispatchEvent(pointerEvent("pointerdown", { pointerId: 7, clientX: 200, clientY: 180 }));
    expect(onPanStart).toHaveBeenCalledTimes(1);

    // The pointer is already far outside the minimap (minimap right edge 300), so events only hit window.
    window.dispatchEvent(pointerEvent("pointermove", { pointerId: 7, clientX: 220, clientY: 180 }));
    flushFrames(120);

    // moveScale = viewScale(10) * zoom(0.5) = 5, a 20px displacement => viewport x moves by -100.
    expect(instance.current().x).toBeCloseTo(-100, 5);

    // Not released yet, so continued dragging still follows the pointer, and the gain is unchanged (no longer compounding as the viewport drifts off the content area).
    window.dispatchEvent(pointerEvent("pointermove", { pointerId: 7, clientX: 240, clientY: 180 }));
    flushFrames(120);
    expect(instance.current().x).toBeCloseTo(-200, 5);
    expect(onPanEnd).not.toHaveBeenCalled();

    // The release point is outside the minimap (minimap bottom edge 250) => the outer layer should resume auto-hiding.
    window.dispatchEvent(pointerEvent("pointerup", { pointerId: 7, clientX: 240, clientY: 400 }));
    flushFrames(120);
    expect(onPanEnd).toHaveBeenCalledTimes(1);
    expect(onPanEnd).toHaveBeenCalledWith(false);

    // A pointermove after release must not move the viewport.
    const settled = instance.current().x;
    window.dispatchEvent(pointerEvent("pointermove", { pointerId: 7, clientX: 400, clientY: 180 }));
    flushFrames(120);
    expect(instance.current().x).toBeCloseTo(settled, 5);
  });

  it("tells the outer layer to keep it visible when the release point is still inside the minimap", () => {
    const { svg, onPanEnd } = setup();
    svg.dispatchEvent(pointerEvent("pointerdown", { pointerId: 3, clientX: 200, clientY: 180 }));
    window.dispatchEvent(pointerEvent("pointerup", { pointerId: 3, clientX: 210, clientY: 190 }));
    flushFrames(120);
    expect(onPanEnd).toHaveBeenCalledWith(true);
  });

  it("after converging, holding still no longer spins rAF idly or rewrites the viewport repeatedly", () => {
    const { svg, instance } = setup();

    svg.dispatchEvent(pointerEvent("pointerdown", { pointerId: 1, clientX: 200, clientY: 180 }));
    window.dispatchEvent(pointerEvent("pointermove", { pointerId: 1, clientX: 220, clientY: 180 }));
    flushFrames(200);

    // The pointer is still pressed but already in place: the loop must stop by itself.
    expect(rafCallbacks.size).toBe(0);

    const callsAfterSettle = instance.setViewport.mock.calls.length;
    flushFrames(200);
    expect(instance.setViewport).toHaveBeenCalledTimes(callsAfterSettle);
  });

  it("if still dragging on unmount, the end event must be handed back to the outer layer", () => {
    const { view, svg, onPanEnd } = setup();
    svg.dispatchEvent(pointerEvent("pointerdown", { pointerId: 5, clientX: 200, clientY: 180 }));
    view.unmount();
    expect(onPanEnd).toHaveBeenCalledWith(false);
  });

  // ---- P1: gain is computed only from the absolute bounding box of visible nodes ------------------------------------
  it("hidden group members do not take part in the gain calculation, and relative coordinates are not mistaken for global ones", () => {
    // Storyboard group: the group is at x=10000, members are changed to parentId + hidden, and position is an in-group cell
    // coordinate (near the origin). The static getNodesBounds would stretch the bounding box from x=20 all the way to x=12000
    // (width 11980 => gain ~29.95), whereas the correct answer counts only the visible group itself (width 2000 => gain 5).
    const nodes: TestNode[] = [
      { id: "g", position: { x: 10000, y: 0 }, width: 2000, height: 1500 },
      { id: "c", parentId: "g", hidden: true, position: { x: 20, y: 10 }, width: 100, height: 100 },
    ];
    const { svg, instance } = setup(nodes);

    svg.dispatchEvent(pointerEvent("pointerdown", { pointerId: 9, clientX: 200, clientY: 180 }));

    // Hidden members must be filtered out first -- the built-in MiniMap's bounding box likewise counts only visible nodes.
    expect(instance.getNodesBounds).toHaveBeenCalledTimes(1);
    expect(instance.getNodesBounds.mock.calls[0][0].map((node: TestNode) => node.id)).toEqual(["g"]);

    window.dispatchEvent(pointerEvent("pointermove", { pointerId: 9, clientX: 220, clientY: 180 }));
    flushFrames(200);
    // moveScale = 10 * 0.5 = 5 => a 20px displacement moves by -100, not the stretched -599.
    expect(instance.current().x).toBeCloseTo(-100, 5);
  });

  // ---- P1: commit the final viewport once on convergence --------------------------------------------
  it("on convergence hands the final viewport to the outer layer to commit once, and sends nothing midway through the easing", () => {
    const { svg, instance, onViewportSettled } = setup();

    svg.dispatchEvent(pointerEvent("pointerdown", { pointerId: 2, clientX: 200, clientY: 180 }));
    window.dispatchEvent(pointerEvent("pointermove", { pointerId: 2, clientX: 220, clientY: 180 }));

    // The easing covers only 30% per frame, so the first few frames are far from in place and nothing should be committed during that time.
    flushFrames(3);
    expect(instance.setViewport.mock.calls.length).toBeGreaterThan(1);
    expect(onViewportSettled).not.toHaveBeenCalled();

    flushFrames(200);
    expect(onViewportSettled).toHaveBeenCalledTimes(1);
    expect(onViewportSettled.mock.calls[0][0].x).toBeCloseTo(-100, 5);
  });

  // ---- P2: the end notification waits until the easing is really in place --------------------------------------------
  it("if the easing has not finished on release, the outer layer is notified of the end only after it settles", () => {
    const { svg, instance, onPanEnd } = setup();

    svg.dispatchEvent(pointerEvent("pointerdown", { pointerId: 4, clientX: 200, clientY: 180 }));
    // Dragged far in one go (400px => the viewport must travel 2000), and still far from the target on release.
    window.dispatchEvent(pointerEvent("pointermove", { pointerId: 4, clientX: 600, clientY: 180 }));
    flushFrames(2);
    window.dispatchEvent(pointerEvent("pointerup", { pointerId: 4, clientX: 600, clientY: 180 }));

    // The end must not be reported at the moment of release: once the outer layer lifts its mount protection, unmounting MiniMap cuts off rAF
    // and leaves the canvas halfway. The old fixed 180ms approach cannot cover this convergence time.
    expect(onPanEnd).not.toHaveBeenCalled();
    flushFrames(5);
    expect(onPanEnd).not.toHaveBeenCalled();
    expect(Math.abs(instance.current().x)).toBeLessThan(2000);

    flushFrames(200);
    expect(instance.current().x).toBeCloseTo(-2000, 5);
    expect(onPanEnd).toHaveBeenCalledTimes(1);
  });

  it("pressing again during the easing wind-down does not flush out the previous end notification", () => {
    const { svg, onPanEnd } = setup();

    svg.dispatchEvent(pointerEvent("pointerdown", { pointerId: 6, clientX: 200, clientY: 180 }));
    window.dispatchEvent(pointerEvent("pointermove", { pointerId: 6, clientX: 600, clientY: 180 }));
    flushFrames(2);
    window.dispatchEvent(pointerEvent("pointerup", { pointerId: 6, clientX: 200, clientY: 180 }));

    // Pressing again before the wind-down finishes => a new gesture starts and the old end notification is voided.
    svg.dispatchEvent(pointerEvent("pointerdown", { pointerId: 8, clientX: 200, clientY: 180 }));
    flushFrames(200);
    expect(onPanEnd).not.toHaveBeenCalled();
  });
});
