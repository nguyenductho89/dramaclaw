// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * The hint bar at the top of the canvas while picking references. Mounted on the canvas container (not inside ReactFlow's transform layer),
 * so it does not move with zoom or pan.
 *
 * "Back to node" restores the viewport to the moment of clicking + Reference and exits picking; "x" exits in place. Picking itself
 * does not exit automatically - a node often needs several references connected.
 */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useReactFlow } from '@xyflow/react';
import { Send, X } from 'lucide-react';

import { useCanvasStore } from '@/stores/canvasStore';
import { selectNodeExclusively } from '@/features/canvas/application/nodeSelection';
import { useReferencePickStore } from '@/features/canvas/application/referencePickStore';

export function ReferencePickBanner() {
  const { t } = useTranslation();
  const request = useReferencePickStore((state) => state.request);
  const stop = useReferencePickStore((state) => state.stop);
  const reactFlowInstance = useReactFlow();

  // Once the target node is deleted (or the canvas switched) there is no point in picking, so exit automatically, avoiding the hint bar hanging dead.
  const targetNodeId = request?.targetNodeId ?? null;
  const targetMissing = useCanvasStore((state) =>
    targetNodeId === null ? false : !state.nodes.some((node) => node.id === targetNodeId)
  );
  useEffect(() => {
    if (targetMissing) stop();
  }, [targetMissing, stop]);

  useEffect(() => {
    if (!targetNodeId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') stop();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [targetNodeId, stop]);

  if (!request) return null;

  const handleReturn = () => {
    // Re-select the target node along the way: during picking the user mostly clicked on blank canvas, and the selection was long lost,
    // while the user's "Back to node" is exactly to see the reference chip just attached - which needs the operation panel to still be there.
    selectNodeExclusively(request.targetNodeId);
    if (request.originViewport) {
      void reactFlowInstance.setViewport(request.originViewport, { duration: 420 });
    } else {
      const internals = reactFlowInstance.getInternalNode(request.targetNodeId)?.internals;
      if (internals) {
        const { x, y } = internals.positionAbsolute;
        void reactFlowInstance.setCenter(x, y, {
          zoom: reactFlowInstance.getZoom(),
          duration: 420,
        });
      }
    }
    stop();
  };

  return (
    <div className="pointer-events-none absolute left-1/2 top-4 z-[140] -translate-x-1/2">
      <div className="pointer-events-auto flex items-center gap-2 rounded-lg bg-[rgb(var(--accent-rgb))] py-1.5 pl-3 pr-1.5 text-[13px] leading-5 text-white shadow-[0_14px_34px_rgba(0,0,0,0.45)]">
        <Send className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="font-medium">{t("canvas.referencePick.bannerTitle")}</span>
        <button
          type="button"
          onClick={handleReturn}
          className="ml-1 inline-flex h-7 items-center rounded-md bg-white/[0.18] px-3 text-[12px] font-medium text-white transition-colors hover:bg-white/[0.3]"
        >
          {t("canvas.viewportHint.returnToNode")}
        </button>
        <button
          type="button"
          onClick={stop}
          title={t("canvas.referencePick.exit")}
          aria-label={t("canvas.referencePick.exit")}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-white/75 transition-colors hover:bg-white/[0.18] hover:text-white"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
