// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * The drag MIME from the storyboard left-list card -> (in the detail) the generation form's reference area.
 *
 * A dedicated type is used instead of text/plain or the workflow's `CANVAS_ASSET_DRAG_MIME`:
 * - no mutual interference with system file / plain-text drops;
 * - distinct from the workflow's payload of "a sidebar asset dragged into the canvas to build a new node" - that one carries a url, and the drop point
 *   `spawnAssetNode` builds a new node; this payload carries only one **existing node id**, and when dropped in the detail
 *   form's reference area the semantics is "add an upstream reference edge to the current detail node" (addEdge), building no node.
 */
export const BOARD_REFERENCE_DRAG_MIME = 'application/x-freezone-board-ref';

export interface BoardReferenceDragPayload {
  /** The existing canvas node id corresponding to the dragged card (connected to the current detail node as an upstream source). */
  nodeId: string;
}

/** Serialize "referencing some existing node" into dataTransfer (drag source = the left-list card). */
export function writeBoardReferenceDragPayload(
  dataTransfer: DataTransfer,
  payload: BoardReferenceDragPayload,
): void {
  dataTransfer.setData(BOARD_REFERENCE_DRAG_MIME, JSON.stringify(payload));
  dataTransfer.effectAllowed = 'copy';
}

/** Parse the reference drag payload from dataTransfer; returns null for a drag of another kind or missing nodeId. */
export function readBoardReferenceDragPayload(
  dataTransfer: DataTransfer,
): BoardReferenceDragPayload | null {
  const raw = dataTransfer.getData(BOARD_REFERENCE_DRAG_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as BoardReferenceDragPayload;
    if (!parsed || typeof parsed.nodeId !== 'string' || !parsed.nodeId) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * During the drag (dragenter / dragover), judge whether this is a "reference drag".
 * Note that during dragover the browser does not allow reading getData, only `types` can be looked at, hence it is used for highlight gating.
 */
export function hasBoardReferenceDrag(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types ?? []).includes(BOARD_REFERENCE_DRAG_MIME);
}
