// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';
import {
  useCallback,
  useRef,
  useState,
  type DragEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

import { useCanvasStore } from '@/stores/canvasStore';

import {
  hasBoardReferenceDrag,
  readBoardReferenceDragPayload,
} from './boardReferenceDrag';

/** The hint text of the drop area on drag hover (matches the placeholder text of reference image 58). */
export function referenceDropHintText(): string {
  return i18n.t('canvas.assetBoard.dropHint');
}

/**
 * A drop-zone layer wrapping the "image/video generation form" in the storyboard detail: **existing node cards** dragged from the left list
 * land as one upstream reference edge of the current detail node (`addEdge(dragged node -> current node)`), and after flowing back the form's
 * existing `useUpstreamContents` derivation renders them as reference thumbnail chips - exactly the same basis as the workflow's "manually connect an edge to add a
 * reference", without changing the shared form or adding store semantics.
 *
 * Why wrap a layer in the host rather than adding drop into the shared `ImageGenerationForm`:
 * - the shared form is reused by the workflow's ImageGenNode, and adding drop to it would affect the workflow;
 * - the references in the form's reference area come from upstream edges anyway, and calling the same `addEdge` on the host side is enough, with zero change to the form.
 *
 * All DnD logic hangs on the outer `relative` container (not on the overlay layer): the highlight overlay is `pointer-events-none`
 * purely for visuals, drop events bubble to the container as usual to be handled uniformly, and the container's `preventDefault` also cancels
 * the default text insertion of the contenteditable prompt box.
 */
export function AssetBoardReferenceDropZone({
  nodeId,
  children,
}: {
  nodeId: string;
  children: ReactNode;
}): ReactElement {
  const [isDragActive, setIsDragActive] = useState(false);
  // Nested child elements each bubble dragenter/dragleave, so debounce with an enter/leave counter, avoiding flicker when passing over inner elements.
  const depthRef = useRef(0);

  const handleDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasBoardReferenceDrag(event.dataTransfer)) return;
    event.preventDefault();
    depthRef.current += 1;
    setIsDragActive(true);
  }, []);

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasBoardReferenceDrag(event.dataTransfer)) return;
    // preventDefault is what makes this container a legal drop target (and takes over drops of child elements bubbling up).
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasBoardReferenceDrag(event.dataTransfer)) return;
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (depthRef.current === 0) setIsDragActive(false);
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!hasBoardReferenceDrag(event.dataTransfer)) return;
      event.preventDefault();
      depthRef.current = 0;
      setIsDragActive(false);
      const payload = readBoardReferenceDragPayload(event.dataTransfer);
      if (!payload) return;
      // Dragging the current detail node's own card into its own form -> ignore, building no self-loop edge.
      if (payload.nodeId === nodeId) return;
      // Reuse the workflow's edge creation rules: addEdge internally validates node existence / connection type, and dedups by the deterministic
      // id `e-source-target` - dragging the same node repeatedly does not produce a second edge (idempotent).
      useCanvasStore.getState().addEdge(payload.nodeId, nodeId);
    },
    [nodeId],
  );

  return (
    <div
      className="relative"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {children}
      {isDragActive && (
        <div
          role="status"
          aria-label={referenceDropHintText()}
          className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-[var(--node-radius)] border-2 border-dashed border-primary/70 bg-[#262626]/85 px-4 text-center text-[13px] font-medium text-white/85"
        >
          {referenceDropHintText()}
        </div>
      )}
    </div>
  );
}
