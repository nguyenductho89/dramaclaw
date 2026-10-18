// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { CANVAS_NODE_TYPES, type CanvasNode } from "./canvasNodes";
import { isPresetManagedNode } from "./mainlineNodeFlags";

/**
 * The set of ids actually deletable among "the selected nodes" in bulk deletion.
 *
 * Why `selected` nodes cannot be used directly: the canvas box selection (see Canvas's custom marquee) removes "groups that enclose other hit nodes"
 * from the selection - so that when dragging a multi-selection parent and child are not displaced twice. The cost is that when the user box-selects a whole group,
 * the group's own `selected` is always false and only the children in the group are selected. If bulk delete deleted only selected, it would delete all the children
 * and leave an empty group frame (a follow-up bug of #62).
 *
 * Here the groups that "are about to be emptied" are added back: if every child of a group is within the selection => deletion would empty it =>
 * delete this empty shell group as well. Preset/mainline-locked groups (and groups containing locked children that cannot truly be emptied)
 * stay excluded. The store's deleteNodes cascades to delete descendants automatically, so only the group id needs to be added.
 */
export function collectBatchDeletableIds(
  nodes: CanvasNode[],
  selectedIds: Iterable<string>,
): string[] {
  const selectedSet = new Set(selectedIds);

  const deletable = new Set<string>();
  for (const node of nodes) {
    if (selectedSet.has(node.id) && !isPresetManagedNode(node)) {
      deletable.add(node.id);
    }
  }

  // One pass to count each parent node's total children / selected count / whether it contains locked children.
  const childTally = new Map<
    string,
    { total: number; selected: number; hasLocked: boolean }
  >();
  for (const node of nodes) {
    if (!node.parentId) {
      continue;
    }
    const tally =
      childTally.get(node.parentId) ?? { total: 0, selected: 0, hasLocked: false };
    tally.total += 1;
    if (selectedSet.has(node.id)) {
      tally.selected += 1;
    }
    if (isPresetManagedNode(node)) {
      tally.hasLocked = true;
    }
    childTally.set(node.parentId, tally);
  }

  // Add back ordinary groups that would be emptied: all children selected, no locked children, and the group itself not locked.
  for (const node of nodes) {
    if (node.type !== CANVAS_NODE_TYPES.group) {
      continue;
    }
    if (deletable.has(node.id) || isPresetManagedNode(node)) {
      continue;
    }
    const tally = childTally.get(node.id);
    if (tally && tally.total > 0 && tally.total === tally.selected && !tally.hasLocked) {
      deletable.add(node.id);
    }
  }

  return Array.from(deletable);
}
