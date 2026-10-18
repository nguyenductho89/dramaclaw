// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LOD_SHELL_EXEMPT_TYPES,
  LOW_DETAIL_ZOOM_THRESHOLD,
  isCanvasGestureActive,
  isCanvasMeasurementDeferred,
  isLowDetailZoom,
  isNodeMediaActive,
  onCanvasMeasurementResume,
  requestShellUpgrade,
  setCanvasGestureActive,
  setCanvasLowDetail,
  setNodeMediaActive,
} from '@/features/canvas/application/canvasLod';

describe('isLowDetailZoom', () => {
  it('only below the threshold counts as the low zoom tier, the boundary value itself does not', () => {
    expect(isLowDetailZoom(LOW_DETAIL_ZOOM_THRESHOLD - 0.01)).toBe(true);
    expect(isLowDetailZoom(LOW_DETAIL_ZOOM_THRESHOLD)).toBe(false);
    expect(isLowDetailZoom(LOW_DETAIL_ZOOM_THRESHOLD + 0.01)).toBe(false);
  });

  it('the common working zoom range (0.5~1) is unaffected', () => {
    expect(isLowDetailZoom(0.5)).toBe(false);
    expect(isLowDetailZoom(1)).toBe(false);
  });

  it('non-finite values are all treated as "no downgrade" to avoid misjudgment during initialization', () => {
    expect(isLowDetailZoom(Number.NaN)).toBe(false);
    expect(isLowDetailZoom(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isLowDetailZoom(Number.NEGATIVE_INFINITY)).toBe(false);
  });
});

describe('canvas measurement deferral signal', () => {
  beforeEach(() => {
    // Module-level state survives across cases, so reset it before each case.
    setCanvasGestureActive(false);
    setCanvasLowDetail(false);
  });

  it('measurement is allowed by default', () => {
    expect(isCanvasMeasurementDeferred()).toBe(false);
  });

  it('measurement is skipped during gestures or in the low zoom tier', () => {
    setCanvasGestureActive(true);
    expect(isCanvasMeasurementDeferred()).toBe(true);

    setCanvasGestureActive(false);
    setCanvasLowDetail(true);
    expect(isCanvasMeasurementDeferred()).toBe(true);
  });

  it('notifies subscribers to re-measure when the canvas settles', () => {
    const listener = vi.fn();
    onCanvasMeasurementResume(listener);

    setCanvasGestureActive(true);
    expect(listener).not.toHaveBeenCalled();

    setCanvasGestureActive(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not notify while another condition is still deferring -- otherwise it would measure in vain under the low zoom tier', () => {
    const listener = vi.fn();
    onCanvasMeasurementResume(listener);

    setCanvasGestureActive(true);
    setCanvasLowDetail(true);

    // The gesture ended, but still in the low zoom tier: measuring is not allowed yet.
    setCanvasGestureActive(false);
    expect(listener).not.toHaveBeenCalled();

    // Zoom is pulled back, and only now is it truly still.
    setCanvasLowDetail(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('setting the same state repeatedly does not notify repeatedly', () => {
    const listener = vi.fn();
    onCanvasMeasurementResume(listener);

    setCanvasGestureActive(true);
    setCanvasGestureActive(true);
    setCanvasGestureActive(false);
    setCanvasGestureActive(false);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('no more notifications after unsubscribing', () => {
    const listener = vi.fn();
    const unsubscribe = onCanvasMeasurementResume(listener);

    setCanvasGestureActive(true);
    unsubscribe();
    setCanvasGestureActive(false);

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('node media active signal', () => {
  it('mark/clear/query are consistent', () => {
    expect(isNodeMediaActive('n1')).toBe(false);
    setNodeMediaActive('n1', true);
    expect(isNodeMediaActive('n1')).toBe(true);
    expect(isNodeMediaActive('n2')).toBe(false);
    setNodeMediaActive('n1', false);
    expect(isNodeMediaActive('n1')).toBe(false);
  });

  it('repeated clearing is idempotent (unmount cleanup and onPause fire one after the other)', () => {
    setNodeMediaActive('n1', true);
    setNodeMediaActive('n1', false);
    setNodeMediaActive('n1', false);
    expect(isNodeMediaActive('n1')).toBe(false);
  });
});

describe('shell upgrade queue', () => {
  let rafCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    rafCallbacks = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback): number => rafCallbacks.push(cb)
    );
    setCanvasGestureActive(false);
    setCanvasLowDetail(false);
  });

  /** Runs one "frame": executes the currently scheduled rAF callbacks (the pump may reschedule for the next frame). */
  const tick = () => {
    const callbacks = rafCallbacks.splice(0);
    for (const cb of callbacks) cb(0);
  };

  /** Case cleanup: drains the queue completely so module-level state does not leak into the next case. */
  const drain = () => {
    setCanvasGestureActive(false);
    for (let i = 0; i < 50 && rafCallbacks.length > 0; i++) tick();
  };

  afterEach(() => {
    drain();
    vi.unstubAllGlobals();
  });

  it('lets only 3 through per frame, deferring the rest to later frames', () => {
    const granted: number[] = [];
    for (let i = 0; i < 7; i++) requestShellUpgrade(() => granted.push(i));
    tick();
    expect(granted).toEqual([0, 1, 2]);
    tick();
    expect(granted).toEqual([0, 1, 2, 3, 4, 5]);
    tick();
    expect(granted).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('lets nothing through during a gesture and resumes after it ends', () => {
    const granted = vi.fn();
    requestShellUpgrade(granted);
    requestShellUpgrade(granted);

    setCanvasGestureActive(true);
    expect(isCanvasGestureActive()).toBe(true);
    tick();
    expect(granted).not.toHaveBeenCalled();
    // The pump stays alive (rescheduled for the next frame) rather than dying
    expect(rafCallbacks.length).toBeGreaterThan(0);

    setCanvasGestureActive(false);
    tick();
    expect(granted).toHaveBeenCalledTimes(2);
  });

  it('lets nothing through after cancellation (the node was unmounted while queued)', () => {
    const a = vi.fn();
    const b = vi.fn();
    const cancelA = requestShellUpgrade(a);
    requestShellUpgrade(b);
    cancelA();
    tick();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe('auto-focus for newly created nodes in the low zoom tier', () => {
  const CANVAS_SOURCE = readFileSync('src/features/canvas/Canvas.tsx', 'utf8');

  /**
   * Cuts out the function body of a handler inside a component: from the declaration anchor to the next component scope (two-space indent)
   * `const` declaration. Inner `const` declarations are indented deeper and will not be cut by mistake.
   */
  const bodyAfter = (marker: string): string => {
    const start = CANVAS_SOURCE.indexOf(marker);
    expect(start, `Anchor not found in Canvas.tsx: ${marker}`).toBeGreaterThan(-1);
    const rest = CANVAS_SOURCE.slice(start + marker.length);
    const end = rest.indexOf('\n  const ');
    return end === -1 ? rest : rest.slice(0, end);
  };

  it('every "create a node from nothing" entry must go through focusNewNodeIfLowZoom', () => {
    // At 10% zoom a new node is only a few dozen pixels on screen, a dark panel against a dark background, and the user would think
    // "it was not created". Previously only the drag-and-drop drop point got focus, while the bottom "+" quick bar and the drag-line menu
    // were missed -- this list exists to lock down all entries, and any new entry must be added to it too.
    for (const marker of [
      'const commitNodePlacementAtClientPosition = useCallback(',
      'const finalizeNodeSpawn = useCallback(',
      'const handleQuickAddNode = useCallback(',
      'const handleQuickAddSkill = useCallback(',
    ]) {
      expect(bodyAfter(marker), marker).toContain('focusNewNodeIfLowZoom(');
    }
  });

  it('the focus threshold goes through isLowDetailZoom and pulls zoom up to >=0.6', () => {
    expect(bodyAfter('const focusNewNodeIfLowZoom = useCallback(')).toContain(
      'isLowDetailZoom(reactFlowInstance.getZoom())'
    );
    expect(CANVAS_SOURCE).toContain('zoom: Math.max(currentZoom, 0.6)');
  });
});

describe('shell exemption list', () => {
  it('the three node kinds with in-component recovery logic / blur persistence / dynamic handles are not made into shells', () => {
    // The exemption reasons for these three kinds are in the canvasLod.ts comments; changing the list should be a deliberate design decision.
    expect([...LOD_SHELL_EXEMPT_TYPES].sort()).toEqual([
      'beatContextNode',
      'groupNode',
      'skillNode',
    ]);
  });
});
