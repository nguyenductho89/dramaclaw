// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef } from 'react';

import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import {
  takeExternalFile,
  type ExternalFileChannel,
} from '@/features/canvas/application/pendingExternalFiles';

/**
 * The node side receives an "externally injected File". Shared by UploadNode / VideoNode / AudioNode.
 *
 * Re-deliver once on mount and fetch again each time an event is received - both go through the consuming
 * takeExternalFile, so the same File is processed only once. Why the "re-delivery on mount" path is a must:
 * at the low-zoom tier a new node first mounts as an LOD shell, and the full component attaches its subscription later than the delivery frame; subscribing to
 * the event alone, the File would be lost together with the bus's no-replay semantics (see [[pendingExternalFiles]]).
 *
 * onFile does its own type validation by the caller (VideoNode accepts only video etc.), and no filtering is done here. It lives in a ref
 * and is not an effect dependency: when the caller forgets useCallback (or its dependencies change every frame), the subscription should not
 * unsubscribe and resubscribe along with it - that would leave a window between unsubscribing and resubscribing where events get lost, and also make the "re-delivery on mount"
 * run on every render.
 */
export function useExternalFileHandoff(
  channel: ExternalFileChannel,
  nodeId: string,
  onFile: (file: File) => void,
): void {
  // useRef(onFile) already carries the first-frame value, so the re-delivery on mount gets the latest callback;
  // this effect is declared before the subscription effect, and later updates also always run before it.
  const onFileRef = useRef(onFile);
  useEffect(() => {
    onFileRef.current = onFile;
  });

  useEffect(() => {
    const drain = () => {
      const file = takeExternalFile(channel, nodeId);
      if (file) onFileRef.current(file);
    };
    drain();
    return canvasEventBus.subscribe(channel, ({ nodeId: targetId }) => {
      if (targetId !== nodeId) return;
      drain();
    });
  }, [channel, nodeId]);
}
