// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * The placeholder mask covering a node pasted across projects, before the material is copied into this project / after the copy fails
 * (injected by withLodShell, present in both the shell tier and the full component).
 *
 * - `copying` with the migration task running: spinner + "Copying assets";
 * - `failed`, or the marker is still `copying` but the task is gone (page refreshed, migration unexpectedly interrupted): an error placeholder +
 *   "Remove node" - the node never had a source project URL in it, and the user just deletes it and pastes again.
 *
 * The mask does not block pointerdown: a placeholder node can still be dragged, selected and right-click deleted; it only eats click / double-click, so as not to
 * click through to the "upload / pick image" entry of the empty node beneath and take a half-finished product as a normal node to keep using.
 */
import { memo, useSyncExternalStore, type MouseEvent, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2 } from 'lucide-react';

import { useCanvasStore } from '@/stores/canvasStore';
import {
  isAssetMigrationInFlight,
  readAssetMigrationState,
  subscribeAssetMigrations,
  type AssetMigrationState,
} from '@/features/canvas/application/crossProjectAssets';

function stopEvent(event: SyntheticEvent) {
  event.stopPropagation();
}

const OVERLAY_CLASS =
  'absolute inset-0 z-[45] flex items-center justify-center rounded-[var(--node-radius)]';
const PILL_CLASS =
  'flex max-w-[90%] items-center gap-2 rounded-md bg-[#1b1b1b]/95 px-3 py-1.5 text-[12px] font-medium text-white shadow-[0_8px_20px_rgba(0,0,0,0.45)] ring-1 ring-white/12';

function CopyingOverlay() {
  const { t } = useTranslation();
  return (
    <div
      data-testid="asset-migration-copying"
      className={`${OVERLAY_CLASS} bg-black/45`}
      onClick={stopEvent}
      onDoubleClick={stopEvent}
    >
      <span className={PILL_CLASS}>
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        <span className="truncate">{t('canvas.crossProjectAssets.copying')}</span>
      </span>
    </div>
  );
}

function FailedOverlay({ nodeId }: { nodeId: string }) {
  const { t } = useTranslation();
  const handleRemove = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    useCanvasStore.getState().deleteNode(nodeId);
  };
  return (
    <div
      data-testid="asset-migration-failed"
      className={`${OVERLAY_CLASS} bg-black/55 ring-2 ring-red-500/70`}
      onClick={stopEvent}
      onDoubleClick={stopEvent}
    >
      <span className={`${PILL_CLASS} flex-col items-start gap-1.5`}>
        <span className="flex items-center gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-400" />
          <span>{t('canvas.crossProjectAssets.failedPlaceholder')}</span>
        </span>
        <button
          type="button"
          className="nodrag nopan self-end rounded bg-white/12 px-2 py-0.5 text-[11px] hover:bg-white/20"
          onClick={handleRemove}
          onPointerDown={stopEvent}
          onMouseDown={stopEvent}
        >
          {t('canvas.crossProjectAssets.removeNode')}
        </button>
      </span>
    </div>
  );
}

function AssetMigrationNodeOverlayImpl({
  nodeId,
  state,
}: {
  nodeId: string;
  state: AssetMigrationState;
}) {
  // The snapshot is a boolean, and a registry change makes only the node whose in-flight state truly flips re-render.
  const inFlight = useSyncExternalStore(subscribeAssetMigrations, () =>
    isAssetMigrationInFlight(nodeId)
  );
  if (state === 'copying' && inFlight) {
    return <CopyingOverlay />;
  }
  return <FailedOverlay nodeId={nodeId} />;
}

function AssetMigrationNodeOverlayBase({ nodeId, data }: { nodeId: string; data: unknown }) {
  // The vast majority of nodes have no marker: subscribe to nothing here and return null directly, not adding an extra cost to every node.
  const state = readAssetMigrationState(data);
  if (!state) {
    return null;
  }
  return <AssetMigrationNodeOverlayImpl nodeId={nodeId} state={state} />;
}

export const AssetMigrationNodeOverlay = memo(AssetMigrationNodeOverlayBase);
