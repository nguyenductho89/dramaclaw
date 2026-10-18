// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { create } from 'zustand';

/**
 * The canvas pointer tool.
 * - `move`: the default mode, left button box-selects / drags nodes, middle button or space drags to pan the canvas.
 * - `hand`: the hand, holding the left button drags the canvas directly; nodes cannot be dragged or box-selected (dragging onto a node also pans).
 */
export type CanvasTool = 'move' | 'hand';

interface CanvasToolState {
  tool: CanvasTool;
  setTool: (tool: CanvasTool) => void;
}

/**
 * Deliberately not persisted: the hand is "temporarily switching gesture", not a preference. If it were left on the hand at last exit, on the next entry
 * no node could be clicked, and the user would only think the canvas was broken. A refresh always returns to the move tool.
 *
 * A standalone lightweight store (isomorphic with the snap alignment / trackpad pan switches), so the toolbar subscribing to it does not re-render
 * because of canvas node changes.
 */
export const useCanvasToolStore = create<CanvasToolState>((set) => ({
  tool: 'move',
  setTool: (tool) => set({ tool }),
}));
