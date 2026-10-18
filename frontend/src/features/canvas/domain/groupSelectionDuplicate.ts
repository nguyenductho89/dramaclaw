// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { CANVAS_NODE_TYPES, type CanvasNode } from "./canvasNodes";
import { isPresetManagedNode } from "./mainlineNodeFlags";

/** The number of ancestor levels from a node to the root; with cycle protection (so corrupted canvas data does not cause an infinite loop). */
function nodeDepth(node: CanvasNode, byId: Map<string, CanvasNode>): number {
  let depth = 0;
  const visited = new Set<string>([node.id]);
  let parentId = node.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    depth += 1;
    parentId = byId.get(parentId)?.parentId;
  }
  return depth;
}

/**
 * In bulk duplication, the id list of "the selected nodes" actually sent into `duplicateNodesAsSiblings`.
 *
 * This is two sides of the same pitfall as {@link collectBatchDeletableIds}: the canvas's custom marquee removes
 * "groups that enclose other hit nodes" from the selection (`ancestorsOfHits` in `Canvas.tsx`), otherwise when dragging
 * a multi-selection parent and child would be displaced twice. The cost is that **when the user box-selects a whole group, the group's own `selected` is always false**.
 *
 * If duplication took only selected, `parentIsCloned` in `duplicateNodesAsSiblings` would be false everywhere, so
 * each member would move down one slot on its own, each add "- Copy", and `parentId` point back at the original group - the copies fall apart and get stuffed back into
 * the original group. Here the ordinary groups that "will be duplicated as a whole" are added back.
 *
 * Two differences from the delete side:
 * - **Preset/mainline-locked members are not filtered**. Duplication is not destructive, and the existing behavior is to take everything as is;
 *   only *the added-back group* itself is subject to the lock - the user did not select it, and a managed container should not be cloned for them.
 * - **The return value guarantees pre-order** (the parent always comes before its members). `duplicateNodesAsSiblings` relies on this order
 *   to re-point members to the newly cloned group with `idMap.get(source.parentId)`; with the order reversed, members could not get
 *   the parent group's clone id and would land back in the original group. The delete side has no such constraint, so `Array.from(Set)` is enough there.
 *
 * Nested groups must hold too: add back deep first, then shallow, and only after a deep subgroup is added back can the outer group see "members are all covered".
 */
export function collectDuplicableIds(
  nodes: CanvasNode[],
  selectedIds: Iterable<string>,
): string[] {
  const selected = new Set(selectedIds);
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const result = new Set<string>();
  for (const node of nodes) {
    if (selected.has(node.id)) {
      result.add(node.id);
    }
  }

  // One pass to count each parent node's total children; a child's "covered" count grows as groups are added back.
  const childrenByParent = new Map<string, CanvasNode[]>();
  for (const node of nodes) {
    if (!node.parentId) {
      continue;
    }
    const siblings = childrenByParent.get(node.parentId);
    if (siblings) {
      siblings.push(node);
    } else {
      childrenByParent.set(node.parentId, [node]);
    }
  }

  const groups = nodes
    .filter((node) => node.type === CANVAS_NODE_TYPES.group)
    .map((node) => ({ node, depth: nodeDepth(node, byId) }))
    // Judge deep ones first: only after a nested group is added into result can its parent group count as "members all covered".
    .sort((a, b) => b.depth - a.depth);
  for (const { node } of groups) {
    if (result.has(node.id) || isPresetManagedNode(node)) {
      continue;
    }
    const children = childrenByParent.get(node.id);
    if (children && children.length > 0 && children.every((child) => result.has(child.id))) {
      result.add(node.id);
    }
  }

  // Pre-order: ascending by ancestor level. A parent's level is necessarily smaller than a child's, so putting shallow ones first is enough, and same-level ones keep the original `nodes` order.
  return nodes
    .filter((node) => result.has(node.id))
    .map((node) => ({ id: node.id, depth: nodeDepth(node, byId) }))
    .sort((a, b) => a.depth - b.depth)
    .map((entry) => entry.id);
}
