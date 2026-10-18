// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Attach a canvas node as a reference of some node (= one upstream edge), explaining the reason on failure.
 *
 * canvasStore.addEdge returns only null without giving reasons, and "video materials exceed the limit" is the only rejection reason needed here and also
 * the only one that can be explained. There is more than one entry for references (click-picking in the pick state, the replace menu in the prompt),
 * and they must give the same sentence on failure - silently doing nothing is the worst kind of "broken".
 */
import { toast } from 'sonner';
// This uses the default i18next instance (the one `@/i18n` initializes). `@/i18n` itself is not imported,
// because that module also pulls in react-i18next / HttpBackend, and putting it on this widely imported low-level chain
// would make every test that mocks react-i18next blow up at import time.
import i18n from 'i18next';

import { videoReferenceConnectionRejection } from '@/features/canvas/domain/videoReferenceLimits';
import { videoReferenceEnvelopeForNode } from '@/features/canvas/application/videoReferenceEnvelope';
import { useCanvasStore } from '@/stores/canvasStore';

/** Returns true when the edge is built successfully; on failure a toast has already been shown. */
export function attachReferenceEdge(sourceNodeId: string, targetNodeId: string): boolean {
  const store = useCanvasStore.getState();
  if (store.addEdge(sourceNodeId, targetNodeId)) return true;
  const rejection = videoReferenceConnectionRejection(
    store.nodes,
    store.edges,
    { source: sourceNodeId, target: targetNodeId },
    videoReferenceEnvelopeForNode,
  );
  toast.error(rejection ?? i18n.t('canvas.referencePick.rejectGeneric'));
  return false;
}
