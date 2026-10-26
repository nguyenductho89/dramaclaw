// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// The two "cross-node writes" of frame-by-frame breakdown: picking source material, landing the output.
//
// Both are pulled out of the component because both mutate someone else's node after an await - the correctness of
// this kind of write depends on "what the canvas looks like right now", not on the instant the component closure
// captured, which is hard to test from inside a component and easy to miss the case where the node has already been
// deleted.

import { useCanvasStore } from '@/stores/canvasStore';
import type {
  PlanVideoBreakdownGroupsOptions,
  VideoBreakdownResultLike,
} from '@/features/canvas/application/videoBreakdownGroups';

/**
 * Wire a video selected on the canvas into the breakdown node.
 *
 * The single source of truth for the source material is that upstream edge - the breakdown node reads the upstream
 * edge first and falls back to `data.sourceVideoUrl`, so once an edge is connected the fallback field must be cleared:
 * leaving the old value means that if the user disconnects the edge wanting to switch source, the node keeps clutching
 * the previous URL and keeps running on it regardless - "disconnecting the edge reverts to the empty state" would be a
 * lie.
 *
 * Only fall back to copying a URL when edge creation is rejected by the gate (returns null) - in that case, not
 * copying means the user clicking "pick from canvas" results in nothing happening at all.
 *
 * @returns whether an edge was connected (false = took the URL-copying fallback path)
 */
export function commitVideoPickToNode({
  sourceNodeId,
  requesterNodeId,
  videoUrl,
  label,
}: {
  sourceNodeId: string;
  requesterNodeId: string;
  videoUrl: string;
  label: string | null;
}): boolean {
  const store = useCanvasStore.getState();
  const edgeId = store.addEdge(sourceNodeId, requesterNodeId);

  store.updateNodeData(
    requesterNodeId,
    edgeId
      ? { sourceVideoUrl: null, sourceFileName: null, sourceNodeId: null }
      : { sourceVideoUrl: videoUrl, sourceFileName: label, sourceNodeId },
  );

  return edgeId !== null;
}

export type VideoBreakdownLandingOutcome = 'ok' | 'node-gone' | 'empty';

/**
 * Land the output of a breakdown run onto the canvas.
 *
 * A single breakdown run can take several minutes, and it is entirely normal for the user to delete the node while
 * waiting for the result. In that case `addVideoBreakdownGroups` likewise fails to find the source node and returns
 * null, which collides with "the task succeeded but all three dimensions produced zero output" - unless the two are
 * told apart, a node the user deleted themselves gets reported back as "the breakdown produced nothing at all". So
 * check whether the node still exists first, splitting the two outcomes apart.
 */
export function landVideoBreakdownResult({
  nodeId,
  result,
  labels,
}: {
  nodeId: string;
  result: VideoBreakdownResultLike;
  labels: Omit<PlanVideoBreakdownGroupsOptions, 'origin'>;
}): VideoBreakdownLandingOutcome {
  const store = useCanvasStore.getState();
  if (!store.nodes.some((node) => node.id === nodeId)) {
    return 'node-gone';
  }

  const groupIds = store.addVideoBreakdownGroups(nodeId, result, labels);
  return groupIds && groupIds.length > 0 ? 'ok' : 'empty';
}
