// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * Reconciliation rules between an image node's "selected style" and the upstream style node on the canvas.
 *
 * The one-way source of truth is the image node's `styleTemplateId` - submitting a generation request reads it, and the style node is only
 * its projection on the canvas. When the style node's own dialog changes the style, it also writes the downstream image node first, and this module then aligns the
 * node data, avoiding both sides writing half and nobody knowing which wins.
 *
 * It is extracted as pure functions because the truly hard part is not "create/delete" but a few timing pitfalls:
 *
 * - On the frame right after addNode when the store has not flowed back yet, the upstream looks empty. Judging directly by "a style is selected
 *   but there is no node => the user deleted it" would immediately clear the style the user just chose. So `everObservedStyleNode` is used
 *   to tell "not yet created" from "was created and then gone".
 * - Existing canvases (saved before this change went live) have a styleTemplateId but no style node; the first reconciliation must create one
 *   rather than clear the selection, so the first reconciliation takes its own branch using `lastSyncedTemplateId === undefined`.
 */

export interface StyleNodeSnapshot {
  id: string;
  templateId: string | null;
  /**
   * Whether this style node is still connected to other downstream nodes. Normally always false - one-to-one is the premise of all rules in this
   * module, see the shared branch in {@link resolveStyleNodeSyncAction}.
   */
  sharedWithOtherTargets: boolean;
}

export interface StyleNodeSyncInput {
  /** The style id currently selected on the image node. */
  selectedTemplateId: string | null;
  /** The style node connected upstream of the image node; null if none. */
  styleNode: StyleNodeSnapshot | null;
  /** The selection at the last reconciliation; `undefined` means this is the first reconciliation after this node mounted. */
  lastSyncedTemplateId: string | null | undefined;
  /** Whether this node has ever really seen the upstream style node. */
  everObservedStyleNode: boolean;
}

export type StyleNodeSyncAction =
  | { kind: 'none' }
  /** Create a style node to the left of the image node and connect an edge. */
  | { kind: 'create'; templateId: string }
  /** Reuse the existing node and only change the style it carries. */
  | { kind: 'update'; nodeId: string; templateId: string }
  /** Style cleared => remove the style node on the canvas. */
  | { kind: 'remove'; nodeId: string }
  /** The user deleted the style node => conversely clear the image node's style too. */
  | { kind: 'clear-selection' };

const NONE: StyleNodeSyncAction = { kind: 'none' };

/**
 * Admission criteria for reconciliation: the catalog has arrived, and the current selection is recognizable in the catalog.
 *
 * Neither can be skipped. Acting before the catalog arrives would make `create` build a node with an id that cannot be looked up; and
 * "recognizable" guards against something else - this release replaced the 30 old styles with 45 new ones wholesale, with zero overlap
 * between old and new ids, so none of the old ids in existing canvases can be found in the new catalog. Building anyway would mean the user merely opens a canvas to look,
 * and an empty-shell style node grows out of nowhere on the canvas, also marking it dirty, autosaving and entering the undo stack.
 *
 * When it cannot be found, never act: the stale id left in the node data is harmless (the backend degrades by ignoring stale ids),
 * and the user's next real style choice naturally overwrites it. Not writing is always safer than writing wrong.
 */
export function isStyleSyncReady(
  selectedTemplateId: string | null,
  templates: ReadonlyArray<{ id: string }>,
): boolean {
  if (templates.length === 0) return false;
  if (selectedTemplateId === null) return true;
  return templates.some((template) => template.id === selectedTemplateId);
}

export function resolveStyleNodeSyncAction({
  selectedTemplateId,
  styleNode,
  lastSyncedTemplateId,
  everObservedStyleNode,
}: StyleNodeSyncInput): StyleNodeSyncAction {
  const isFirstSync = lastSyncedTemplateId === undefined;

  if (selectedTemplateId === null) {
    // On the first reconciliation "no style selected" is the norm; do not delete a node that happens to be connected on the canvas as dirty data -
    // it may have been dragged out by the user, so wait until they actually change the selection.
    if (isFirstSync || lastSyncedTemplateId === null) return NONE;
    // A shared node does not belong to this node alone; clearing its own selection should not delete other people's projection along with it.
    if (!styleNode || styleNode.sharedWithOtherTargets) return NONE;
    return { kind: 'remove', nodeId: styleNode.id };
  }

  if (!styleNode) {
    // Create when the selection changed (or on the first reconciliation); otherwise only if it was "really seen" can it be judged as deleted by the user.
    if (isFirstSync || selectedTemplateId !== lastSyncedTemplateId) {
      return { kind: 'create', templateId: selectedTemplateId };
    }
    return everObservedStyleNode ? { kind: 'clear-selection' } : NONE;
  }

  if (styleNode.sharedWithOtherTargets) {
    // When one style node is connected to two image nodes, nobody may change it - A changes it to its own selection,
    // B's reconciliation immediately sees a mismatch and changes it back, and the two effects trigger each other through store writes,
    // each round being a commit; React throws Maximum update depth exceeded at 50 levels.
    // It cannot converge, so simply do nothing here: the two sides show inconsistently on the canvas, but the canvas does not crash.
    //
    // Sharing is itself an abnormal state. SYSTEM_ONLY_CONNECTIONS blocks manual connections, and the path of cloning incoming edges when copying nodes
    // is already skipped by type in canvasStore; this is only the last fallback.
    return NONE;
  }

  if (styleNode.templateId !== selectedTemplateId) {
    return { kind: 'update', nodeId: styleNode.id, templateId: selectedTemplateId };
  }

  return NONE;
}

/** What reconciliation must remember between two calls, corresponding one to one to the last two items of {@link StyleNodeSyncInput}. */
export interface StyleNodeSyncState {
  lastSyncedTemplateId: string | null | undefined;
  everObservedStyleNode: boolean;
}

export const INITIAL_STYLE_NODE_SYNC_STATE: StyleNodeSyncState = {
  lastSyncedTemplateId: undefined,
  everObservedStyleNode: false,
};

/**
 * One reconciliation step: compute what to do, and along the way compute the bookkeeping state needed next time.
 *
 * Bookkeeping follows the action, and cannot be updated just by "whether the node was seen in this frame" - after `create` / `remove`
 * the existence of the node on the canvas is flipping, and before the store flows back `styleNode` is necessarily null; leaving
 * `everObservedStyleNode` as true then would make the next round judge the just-built selection as "the user deleted the node"
 * and clear it in return. So both actions must press it back to false, setting it only when the node is truly seen again.
 */
export function advanceStyleNodeSync(
  state: StyleNodeSyncState,
  input: Pick<StyleNodeSyncInput, 'selectedTemplateId' | 'styleNode'>,
): { action: StyleNodeSyncAction; state: StyleNodeSyncState } {
  const everObservedStyleNode = state.everObservedStyleNode || input.styleNode !== null;
  const action = resolveStyleNodeSyncAction({
    ...input,
    lastSyncedTemplateId: state.lastSyncedTemplateId,
    everObservedStyleNode,
  });

  switch (action.kind) {
    case 'create':
    case 'remove':
      return {
        action,
        state: {
          lastSyncedTemplateId: input.selectedTemplateId,
          everObservedStyleNode: false,
        },
      };
    case 'clear-selection':
      // The selection was cleared in reverse, so the next round's "last selection" is null.
      return {
        action,
        state: { lastSyncedTemplateId: null, everObservedStyleNode: false },
      };
    default:
      return {
        action,
        state: {
          lastSyncedTemplateId: input.selectedTemplateId,
          everObservedStyleNode,
        },
      };
  }
}

/* ------------------------------------------------------------------------- *
 * Where the bookkeeping state is stored
 *
 * It cannot live in ImageGenNode's ref: at the low-zoom tier imageGenNode is swapped for LodShellNode,
 * the component really unmounts, and the ref goes with it. Then on "zoom out -> delete the style node -> zoom in" the component remounts,
 * `lastSyncedTemplateId` returns to undefined, and reconciliation treats it as the first time, rebuilding the node the user just deleted.
 * Lifted to module level keyed by nodeId, it survives unmounts.
 *
 * It must be cleared on canvas switch: after re-hydrate the style node may not have been saved at all (e.g. the canvas was opened by an old frontend version,
 * and nodes of unknown types were dropped along with their edges), and leftover bookkeeping would make reconciliation judge "should rebuild"
 * as "the user deleted the node" and clear the selection in return.
 * ------------------------------------------------------------------------- */

const syncStates = new Map<string, StyleNodeSyncState>();

export function readStyleNodeSyncState(nodeId: string): StyleNodeSyncState {
  return syncStates.get(nodeId) ?? INITIAL_STYLE_NODE_SYNC_STATE;
}

export function writeStyleNodeSyncState(nodeId: string, state: StyleNodeSyncState): void {
  syncStates.set(nodeId, state);
}

/** Called on canvas switch / clearing the canvas, see the comment above. */
export function resetStyleNodeSyncStates(): void {
  syncStates.clear();
}

/** Horizontal gap (px) left between the style node and the image node. */
export const STYLE_NODE_GAP = 28;

/**
 * When rebuilding a style node, place it directly to the left of the image node, vertically centered. This is extracted because the image node's height has
 * three sources (measured height / explicit height / default), and a wrong landing point means a new node covering other nodes
 * or floating outside the viewport, which is nearly untestable in the component.
 */
export function resolveStyleNodePlacement(input: {
  imageNodePosition: { x: number; y: number };
  imageNodeHeight: number;
  styleNodeWidth: number;
  styleNodeHeight: number;
}): { x: number; y: number } {
  return {
    x: input.imageNodePosition.x - input.styleNodeWidth - STYLE_NODE_GAP,
    y:
      input.imageNodePosition.y
      + (input.imageNodeHeight - input.styleNodeHeight) / 2,
  };
}
