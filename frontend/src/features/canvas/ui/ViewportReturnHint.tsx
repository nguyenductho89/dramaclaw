// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * The "Back to node" hint strip floating at the bottom of the canvas after double-clicking a reference material to jump to where it is.
 *
 * The position and form are the same set as [[BackToNodesHint]] (a capsule centered at the bottom) - both are the way back from
 * "the viewport got lost", and since they look the same the user need not learn them anew. When both appear, BackToNodesHint yields and moves up.
 */
import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useReactFlow } from '@xyflow/react';
import { X } from 'lucide-react';

import { useCanvasStore } from '@/stores/canvasStore';
import { selectNodeExclusively } from '@/features/canvas/application/nodeSelection';
import { useViewportReturnStore } from '@/features/canvas/application/viewportReturnStore';

export function ViewportReturnHint() {
  const { t } = useTranslation();
  const request = useViewportReturnStore((state) => state.request);
  const stop = useViewportReturnStore((state) => state.stop);
  const reactFlow = useReactFlow();

  // If the starting node has been deleted, this way back is meaningless (going back would leave only blank), so remove it directly.
  const originGone = useCanvasStore(
    (state) =>
      request !== null && !state.nodes.some((node) => node.id === request.originNodeId)
  );
  useEffect(() => {
    if (originGone) stop();
  }, [originGone, stop]);

  const handleReturn = useCallback(() => {
    if (!request) return;
    // Select first, then move the viewport: selecting reopens the operation panel, and the user returns to "the node they were just writing",
    // not just a coordinate.
    selectNodeExclusively(request.originNodeId);
    void reactFlow.setViewport(request.originViewport, { duration: 320 });
    stop();
  }, [reactFlow, request, stop]);

  if (!request || originGone) return null;

  return (
    <div className="pointer-events-none absolute bottom-6 left-1/2 z-[132] -translate-x-1/2">
      <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-white/10 bg-[#1f1f1f]/95 py-1.5 pl-4 pr-1.5 text-xs text-white/85 shadow-lg shadow-black/40 backdrop-blur">
        <span className="whitespace-nowrap">{t("canvas.viewportHint.focused")}</span>
        <button
          type="button"
          className="whitespace-nowrap rounded-full bg-white/[0.14] px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-white/25"
          onClick={handleReturn}
        >
          {t("canvas.viewportHint.returnToNode")}
        </button>
        <button
          type="button"
          title={t("common.close")}
          aria-label={t("common.close")}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/[0.14] hover:text-white"
          onClick={stop}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
