// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * The mask covering a node while picking a reference, in three forms:
 * - Selectable: hover shows "Select xxx", and already connected ones show "Deselect";
 * - Connectable but the kind is not accepted (an image node facing video / audio nodes): the whole thing is dimmed, cursor not-allowed,
 *   and hover shows the reason, turning "clicked and nothing happened" into "why it cannot be clicked";
 * - Other nodes (no output port, system-only edges): no mask is drawn, otherwise the whole canvas blurs into one.
 *
 * Why it covers inside the node (injected by withLodShell) rather than an absolutely positioned canvas layer: a node may be inside a group
 * and at any zoom, and a canvas layer would have to compute positionAbsolute x zoom itself to align; whereas
 * `.react-flow__node` is itself a positioned element, and `inset-0` is naturally this node's box.
 *
 * The mask swallowing pointer events is also deliberate: in the pick state clicking a node means "select it", and should not incidentally trigger buttons
 * inside the node, nor drag the node away.
 */
import { memo, type MouseEvent, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useCanvasStore } from '@/stores/canvasStore';
import { attachReferenceEdge } from '@/features/canvas/application/attachReference';
import { useReferencePickStore } from '@/features/canvas/application/referencePickStore';

/** The hint capsule in the center of the mask, sharing one style between the selectable and non-selectable states. */
function OverlayHint({ text, always }: { text: string; always: boolean }) {
  return (
    <span
      className={`pointer-events-none absolute left-1/2 top-1/2 max-w-[86%] -translate-x-1/2 -translate-y-1/2 truncate rounded-md bg-[#1b1b1b]/95 px-2.5 py-1 text-[12px] font-medium text-white shadow-[0_8px_20px_rgba(0,0,0,0.45)] ring-1 ring-white/12 transition-opacity ${
        always ? 'opacity-100' : 'opacity-0 group-hover/refpick:opacity-100'
      }`}
    >
      {text}
    </span>
  );
}

function stopEvent(event: SyntheticEvent) {
  event.stopPropagation();
}

function ActiveReferencePickOverlay({
  nodeId,
  targetNodeId,
  label,
}: {
  nodeId: string;
  targetNodeId: string;
  label: string;
}) {
  const { t } = useTranslation();
  const connected = useCanvasStore((state) =>
    state.edges.some((edge) => edge.source === nodeId && edge.target === targetNodeId)
  );

  const handleClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const store = useCanvasStore.getState();
    if (connected) {
      store.edges
        .filter((edge) => edge.source === nodeId && edge.target === targetNodeId)
        .forEach((edge) => store.deleteEdge(edge.id));
      return;
    }
    attachReferenceEdge(nodeId, targetNodeId);
  };

  const hint = connected
    ? t('canvas.referencePick.deselect')
    : t('canvas.referencePick.select', { label });

  return (
    <div
      role="button"
      tabIndex={-1}
      title={hint}
      className={`nodrag nopan group/refpick absolute inset-0 z-[45] cursor-pointer rounded-[var(--node-radius)] ring-2 transition-[box-shadow] ${
        connected
          ? 'ring-[rgb(var(--accent-rgb))] bg-[rgb(var(--accent-rgb)/0.08)]'
          : 'ring-transparent hover:ring-[rgb(var(--accent-rgb))] hover:bg-[rgb(var(--accent-rgb)/0.08)]'
      }`}
      onClick={handleClick}
      onPointerDown={stopEvent}
      onMouseDown={stopEvent}
      onDoubleClick={stopEvent}
      onContextMenu={stopEvent}
    >
      <OverlayHint text={hint} always={connected} />
    </div>
  );
}

// Non-selectable node: dim + hover shows the reason.
// Only swallow click / double-click / right-click, do not block press and do not add nopan - in the pick state most nodes on the canvas are covered by
// this mask, and swallowing dragging too would leave the user unable to drag the canvas to find the node to reference.
function BlockedReferencePickOverlay({ reason }: { reason: string }) {
  return (
    <div
      title={reason}
      className="nodrag group/refpick absolute inset-0 z-[45] cursor-not-allowed rounded-[var(--node-radius)] bg-black/55"
      onClick={stopEvent}
      onDoubleClick={stopEvent}
      onContextMenu={stopEvent}
    >
      <OverlayHint text={reason} always={false} />
    </div>
  );
}

function ReferencePickNodeOverlayImpl({ nodeId }: { nodeId: string }) {
  // All three selectors return primitive values: outside the pick state they are always null, and however the canvas content changes
  // no node re-renders because of this mask.
  const targetNodeId = useReferencePickStore((state) =>
    state.request && state.request.targetNodeId !== nodeId ? state.request.targetNodeId : null
  );
  const label = useReferencePickStore(
    (state) => state.request?.candidates.get(nodeId)?.label ?? null
  );
  const rejection = useReferencePickStore(
    (state) => state.request?.rejections.get(nodeId) ?? null
  );

  if (!targetNodeId) return null;
  if (label !== null) {
    return (
      <ActiveReferencePickOverlay
        nodeId={nodeId}
        targetNodeId={targetNodeId}
        label={label}
      />
    );
  }
  if (rejection !== null) return <BlockedReferencePickOverlay reason={rejection} />;
  return null;
}

export const ReferencePickNodeOverlay = memo(ReferencePickNodeOverlayImpl);
