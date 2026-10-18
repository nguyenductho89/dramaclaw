// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { XYPosition } from '@xyflow/react';

import {
  CANVAS_NODE_TYPES, type CanvasNode, type CanvasNodeData, type CanvasNodeType,
} from '../domain/canvasNodes';
import type { IdGenerator, NodeCatalog, NodeFactory } from './ports';

export class CanvasNodeFactory implements NodeFactory {
  constructor(
    private readonly idGenerator: IdGenerator,
    private readonly nodeCatalog: NodeCatalog
  ) {}

  createNode(
    type: CanvasNodeType,
    position: XYPosition,
    data: Partial<CanvasNodeData> = {}
  ): CanvasNode {
    const definition = this.nodeCatalog.getDefinition(type);
    // createdAt is placed after ...data deliberately: duplicateNodeAsSibling spreads the source node's whole
    // data in, and if placed first the duplicated node would inherit the source node's creation moment - while "duplicate three copies"
    // is exactly the scenario where the outline needs the moment to tell them apart. The factory is only called when a node is truly newly built (loading a canvas
    // directly does set(nodes), and undo goes through snapshots), so this override does not reach nodes read back from the server.
    const nodeData = {
      ...definition.createDefaultData(),
      ...data,
      ...(type === CANVAS_NODE_TYPES.audio ? { voicePolicyConfirmed: true } : {}),
      createdAt: Date.now(),
    } as CanvasNodeData;

    return {
      id: this.idGenerator.next(),
      type,
      position,
      data: nodeData,
    };
  }
}
