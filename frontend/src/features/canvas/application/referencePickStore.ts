// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * The "reference" pick state. It is its own lightweight store, for the same reason as snapAlignStore: the components subscribing to it
 * (the top banner, the pick mask on each node) should not re-render because of canvas content changes.
 *
 * The rules and candidate computation are in [[referencePick]].
 */
import type { Viewport } from '@xyflow/react';
import { create } from 'zustand';

import type { CanvasNodeType } from '../domain/canvasNodes';
import type { ReferencePickCandidate } from './referencePick';

export interface ReferencePickRequest {
  /** The node that initiated + Reference, to which all reference edges are finally connected. */
  targetNodeId: string;
  targetNodeType: CanvasNodeType;
  /** The viewport when entering the pick state, which "Back to node" restores as is. */
  originViewport: Viewport | null;
  /** The snapshot of selectable nodes computed at the moment of entering the pick state: nodeId -> candidate info. */
  candidates: Map<string, ReferencePickCandidate>;
  /** The nodes computed at the same moment that are "connectable but whose kind is not accepted": nodeId -> the reason text why they cannot be chosen. */
  rejections: Map<string, string>;
}

interface ReferencePickState {
  request: ReferencePickRequest | null;
  start: (request: ReferencePickRequest) => void;
  stop: () => void;
}

export const useReferencePickStore = create<ReferencePickState>((set) => ({
  request: null,
  start: (request) => set({ request }),
  stop: () => set({ request: null }),
}));
