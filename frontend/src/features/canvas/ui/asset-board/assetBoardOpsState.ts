// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useSyncExternalStore } from 'react';

/** When an operation fails, how long (ms) the red error text on the source node's toolbar takes to disappear automatically. */
export const OP_FAILURE_AUTO_DISMISS_MS = 8000;

export interface AssetBoardOpsRegistry<Op extends string> {
  /** Read a node's operation currently in progress (survives cross-component remounts). */
  useInFlightOp: (nodeId: string) => Op | null;
  /** Read a node's most recent failure text (cleared automatically after {@link OP_FAILURE_AUTO_DISMISS_MS}). */
  useOpFailure: (nodeId: string) => string | null;
  markOpStart: (nodeId: string, op: Op) => void;
  markOpSettled: (nodeId: string) => void;
  reportOpFailure: (nodeId: string, message: string) => void;
  /** A read-only view for test assertions (nodeId -> name of the operation in progress). */
  inFlight: ReadonlyMap<string, Op>;
  /** For tests only: clear the two registries, avoiding cross-talk between cases via fixed node ids. */
  resetForTest: () => void;
}

/**
 * The factory of the "in progress / failure feedback" registries for the storyboard detail toolbars.
 *
 * Why a module-level Map rather than component state: the detail toolbar remounts as a whole by `key={node.id}`
 * (switching to another node and back gives a brand-new instance), and if the busy state lived only in component-local state, switching away and
 * back would reset it to null - the user could submit the same node again before the background task settles,
 * causing duplicate billing. The approach is the same as the stacked-card album counting in nodes/shared/albumPendingTotals.ts:
 * a module-level Map + useSyncExternalStore, surviving component unmount/remount; not persisted to
 * localStorage - a refresh does not resume tasks anyway, and keeping it would only show a fake busy state that spins forever.
 *
 * The same goes for failure feedback: the failure info of generation-type operations is currently written only on the newly built **result node's**
 * data.generationError, while the user is staying on the **source node's** detail panel and cannot see that just-built
 * node, which most likely has not scrolled into the viewport - so a red line of text is added on the source node's toolbar,
 * disappearing automatically on schedule. (FreezoneShell's setToast / canvasEventBus are not used: both paths would need a
 * new ports.ts event type + a FreezoneShell subscriber, beyond the file scope of this batch of changes.)
 *
 * The image side and the video side each build an instance (see assetBoardImageOpsRegistry /
 * assetBoardVideoOpsRegistry) - a node is never both image and video, and separating them just keeps each side's
 * test reset from affecting the other.
 */
export function createAssetBoardOpsRegistry<Op extends string>(): AssetBoardOpsRegistry<Op> {
  const inFlightMap = new Map<string, Op>();
  const inFlightListeners = new Set<() => void>();
  const failureMap = new Map<string, string>();
  const failureListeners = new Set<() => void>();

  const emitInFlight = () => {
    for (const listener of inFlightListeners) listener();
  };
  const emitFailure = () => {
    for (const listener of failureListeners) listener();
  };
  const subscribeInFlight = (listener: () => void) => {
    inFlightListeners.add(listener);
    return () => {
      inFlightListeners.delete(listener);
    };
  };
  const subscribeFailure = (listener: () => void) => {
    failureListeners.add(listener);
    return () => {
      failureListeners.delete(listener);
    };
  };

  return {
    useInFlightOp: (nodeId: string) =>
      useSyncExternalStore(subscribeInFlight, () => inFlightMap.get(nodeId) ?? null),
    useOpFailure: (nodeId: string) =>
      useSyncExternalStore(subscribeFailure, () => failureMap.get(nodeId) ?? null),
    markOpStart: (nodeId: string, op: Op) => {
      inFlightMap.set(nodeId, op);
      emitInFlight();
    },
    markOpSettled: (nodeId: string) => {
      if (!inFlightMap.delete(nodeId)) return;
      emitInFlight();
    },
    reportOpFailure: (nodeId: string, message: string) => {
      failureMap.set(nodeId, message);
      emitFailure();
      setTimeout(() => {
        if (failureMap.get(nodeId) === message) {
          failureMap.delete(nodeId);
          emitFailure();
        }
      }, OP_FAILURE_AUTO_DISMISS_MS);
    },
    inFlight: inFlightMap,
    resetForTest: () => {
      inFlightMap.clear();
      failureMap.clear();
      emitInFlight();
      emitFailure();
    },
  };
}
