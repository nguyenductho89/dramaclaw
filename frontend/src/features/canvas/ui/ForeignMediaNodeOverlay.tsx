// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * The "material belongs to another project" node mask (injected by withLodShell, present in both the shell tier and the full component).
 *
 * In canvases saved before the guard went live, some media URLs point to other projects. Static resources are authorized independently by the project id in the URL,
 * so members of the source project see everything normal, while another equally valid member of this project who opens it gets a whole page of 403 broken images
 * (SuperTale#192). The backend reports these references when reading the canvas (`foreign_media`), and here that is turned into
 * one explanation + a one-click "Copy to this project" - the repair only touches node data and lands in the database with the next autosave.
 *
 * Division of labor with `AssetMigrationNodeOverlay`: that one handles **newly pasted** placeholder nodes whose URLs never entered the store;
 * this one handles historical dirty references **already saved into the canvas**.
 */
import { useCallback, useState, useSyncExternalStore, type MouseEvent, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2 } from 'lucide-react';

import { useCanvasStore } from '@/stores/canvasStore';
import {
  foreignMediaTargetProject,
  readForeignMediaRefsForNode,
  repairForeignMediaRefs,
  resolveForeignMediaRefs,
  subscribeForeignMediaRefs,
} from '@/features/canvas/application/canvasMediaScope';

function stopEvent(event: SyntheticEvent) {
  event.stopPropagation();
}

const OVERLAY_CLASS =
  'absolute inset-0 z-[45] flex items-center justify-center rounded-[var(--node-radius)] bg-black/55 ring-2 ring-amber-500/70';
const PILL_CLASS =
  'flex max-w-[90%] flex-col items-start gap-1.5 rounded-md bg-[#1b1b1b]/95 px-3 py-1.5 text-[12px] font-medium text-white shadow-[0_8px_20px_rgba(0,0,0,0.45)] ring-1 ring-white/12';

function ForeignMediaNodeOverlayImpl({ nodeId }: { nodeId: string }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  // The explanation shown on failure (an i18n key); if nothing is shown the button looks broken and users only click repeatedly.
  const [hint, setHint] = useState<string | null>(null);

  const handleRepair = useCallback(
    async (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const refs = readForeignMediaRefsForNode(nodeId);
      const targetProject = foreignMediaTargetProject();
      if (busy || refs.length === 0 || !targetProject) {
        return;
      }
      setBusy(true);
      setHint(null);
      try {
        const { urlMap, failedUrls, retryable } = await repairForeignMediaRefs({
          refs,
          targetProject,
          getLiveNodeData: (id) =>
            (useCanvasStore.getState().nodes.find((node) => node.id === id)?.data ??
              null) as never,
          updateNodeData: (id, patch) => {
            // Repairing historical data is not a user edit action: it does not enter the undo stack.
            useCanvasStore.getState().updateNodeData(id, patch, { recordHistory: false });
          },
          // If it cannot be copied, leave it as is: the backend already lets this data through, and when it cannot be repaired the user's last remaining clue should not be deleted in passing.
          blankOnFailure: false,
        });
        if (retryable) {
          // This round did not go through at all (network/5xx), and not a single field was touched. Make clear it is "try again"
          // rather than "no permission", otherwise the user would go ask for a permission they actually already have.
          setHint('canvas.crossProjectAssets.foreignMediaCopyRetryable');
          return;
        }
        resolveForeignMediaRefs(nodeId, urlMap.keys());
        // Failing to copy is usually a lack of permission on the source project. Stating the reason lets them know to ask for permission rather than retry.
        setHint(failedUrls.size > 0 ? 'canvas.crossProjectAssets.foreignMediaCopyFailed' : null);
      } finally {
        setBusy(false);
      }
    },
    [busy, nodeId],
  );

  return (
    <div
      data-testid="foreign-media-overlay"
      className={OVERLAY_CLASS}
      onClick={stopEvent}
      onDoubleClick={stopEvent}
    >
      <span className={PILL_CLASS}>
        <span className="flex items-center gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
          <span>{t('canvas.crossProjectAssets.foreignMedia')}</span>
        </span>
        {hint ? (
          <span className="text-[11px] font-normal text-amber-300">{t(hint)}</span>
        ) : null}
        <button
          type="button"
          className="nodrag nopan self-end rounded bg-white/12 px-2 py-0.5 text-[11px] hover:bg-white/20 disabled:opacity-60"
          onClick={handleRepair}
          onPointerDown={stopEvent}
          onMouseDown={stopEvent}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            t('canvas.crossProjectAssets.copyIntoProject')
          )}
        </button>
      </span>
    </div>
  );
}

export function ForeignMediaNodeOverlay({ nodeId }: { nodeId: string }) {
  // The snapshot is a stable reference (clean nodes share the same empty array), and a registry change makes only the truly affected nodes re-render.
  const refs = useSyncExternalStore(subscribeForeignMediaRefs, () =>
    readForeignMediaRefsForNode(nodeId),
  );
  if (refs.length === 0) {
    return null;
  }
  return <ForeignMediaNodeOverlayImpl nodeId={nodeId} />;
}
