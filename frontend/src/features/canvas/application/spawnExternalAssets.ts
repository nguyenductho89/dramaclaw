// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// This uses the default i18next instance (the one `@/i18n` initializes). `@/i18n` itself is not imported,
// because that module also pulls in react-i18next / HttpBackend, and putting it on this widely imported low-level chain
// would make every test that mocks react-i18next blow up at import time.
import i18n from 'i18next';

import {
  CANVAS_NODE_TYPES,
  type CanvasNodeData,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';
import { isSupportedMediaFile } from '@/features/canvas/application/videoFileTypes';
import { stashExternalFile } from '@/features/canvas/application/pendingExternalFiles';
import type { CanvasEventMap } from '@/features/canvas/application/ports';

/** The same nominal size as VideoNode's spawnCharacterLibraryReferences. */
const UPLOAD_WIDTH = 320;
const UPLOAD_HEIGHT = 240;
const GAP_X = 40;
const GAP_Y = 24;

/** Aligned with DEFAULT_HEIGHT of VideoNode.tsx, a fallback when the target gives no height. */
const FALLBACK_TARGET_HEIGHT = 380;

/** Distinguishes the source from the library's "asset reference group". The group name is shown on the canvas, so it is a translated entry, not a constant. */
export function externalAssetGroupLabel(): string {
  return i18n.t('canvas.naming.externalAssetGroup');
}

export interface SpawnExternalAssetsTarget {
  id: string;
  position: { x: number; y: number };
  /** Used to vertically center the stacked asset nodes with the target node; falls back to 380 when absent or 0. */
  height?: number;
}

export interface SpawnExternalAssetsDeps {
  addNode: (
    type: CanvasNodeType,
    position: { x: number; y: number },
    data?: Partial<CanvasNodeData>,
  ) => string;
  addEdge: (source: string, target: string) => string | null;
  publish: (
    type: 'upload-node/external-file',
    payload: CanvasEventMap['upload-node/external-file'],
  ) => void;
  /** Used to automatically group the newly created asset nodes. */
  autoGroupSpawn: (
    sourceNodeId: string,
    spawnedNodeIds: string[],
    opts?: { label?: string },
  ) => string | null;
  /** Defaults to requestAnimationFrame; tests inject synchronous execution. */
  schedule?: (fn: () => void) => void;
}

/**
 * Connect locally selected external files as upstream materials of the target node.
 *
 * Each file first lands as an upload node and is connected by an edge, and then the File is handed to it - UploadNode splits by MIME itself:
 * images stay in the upload node, and videos/audios morph in place via convertNodeType into video/audio
 * nodes. The morph does not change the id, so the edge connected first is not lost.
 *
 * Do not pass imageOnly (it would make UploadNode reject audio/video), do not pass displayName (it would override
 * the default behavior of "use the uploaded file name as the node title"), only pass user_spawned:true - it is the classification basis of
 * nodeMainlineFlags, and also the basis on which the backend _merge_restored_preset_canvas
 * (freezone.py's _is_replaceable_projection_node) judges "do not overwrite
 * this node when refreshing the preset canvas".
 *
 * Do not copy the line in Canvas.tsx at the file drop point saying "if not passed it will be locked by NodeActionToolbar's canvas-level
 * fallback" - that fallback is gone. From NodeActionToolbar.tsx:1043 isPresetLocked only looks at
 * isPresetManaged, and a {} node with no marker is judged ordinary and not locked (pinned by a test:
 * isSystemManagedNodeData({}) === false in system-managed-node-data.test.ts).
 *
 * target is a snapshot passed in by the caller; this function does not read the store live inside - the caller must take the latest position/height
 * from the store at the moment of calling, and not stuff in a possibly stale closure value.
 *
 * This module looks like "deriving new nodes from existing nodes" in shape, but semantically it is freshly imported external material with no
 * provenance to inherit, so it deliberately does not go through domain/inheritMainlineFields.ts - that helper
 * is for paths "deriving from existing nodes/records", and going through it would wrongly inherit lineage fields such as slot_target.
 * Hand-writing user_spawned is isomorphic with the file drop in Canvas.tsx and assetDrag.ts.
 *
 * Event delivery is deferred by one frame (injected via schedule), because the new node has not mounted its subscription in the same frame; while the File itself is
 * synchronously stashed into [[pendingExternalFiles]] - at the low-zoom tier a new node first mounts as an LOD shell,
 * the full component subscribes later than that frame, and relying on the event alone would surely lose it (the bus has no replay). The consumer fetches it on mount.
 *
 * focusNewNodeIfLowZoom is deliberately not called here: it is for "creating a node from nothing at a blank canvas spot" -
 * where a drag/paste lands the user may not be able to see, so zoom is pulled to 0.6 for confirmation. This function derives upstream materials from an already selected
 * target node, the view is already on the target node, and changing zoom again would steal the camera. The omission by default is not an oversight.
 *
 * Multiple files are stacked vertically and vertically centered with the target node, aligned with VideoNode.tsx's
 * spawnCharacterLibraryReferences: the same UPLOAD_WIDTH/UPLOAD_HEIGHT/GAP_X/GAP_Y,
 * and when the target node gives no height, FALLBACK_TARGET_HEIGHT (= VideoNode's DEFAULT_HEIGHT) is the
 * fallback. The newly created nodes are finally grouped by autoGroupSpawn.
 */
export function spawnExternalAssetNodes(
  target: SpawnExternalAssetsTarget,
  files: readonly File[],
  deps: SpawnExternalAssetsDeps,
): string[] {
  // Non-media files must be blocked here first: UploadNode.handleMediaFile silently returns for a file that is neither an image nor
  // a video/audio (there is no else branch), and letting it in would leave an upload node that is connected by an edge
  // but forever empty.
  const accepted = files.filter(isSupportedMediaFile);

  // The short circuit must land after accepted is computed, judging accepted.length - if it were changed to judge files.length
  // before filtering, the case "everything selected is a non-media file" would bypass the short circuit and run to the end,
  // and then autoGroupSpawn(target.id, []) would build an empty group.
  if (accepted.length === 0) return [];

  const schedule =
    deps.schedule ?? ((fn: () => void) => { requestAnimationFrame(fn); });

  const baseX = target.position.x - UPLOAD_WIDTH - GAP_X;
  const totalH =
    UPLOAD_HEIGHT * accepted.length + GAP_Y * (accepted.length - 1);
  // Use || rather than ??: 0 and NaN should also take the fallback. The reference implementation wrote ??, in which case when height is 0
  // it would center by a height of 0 and push the whole group up out of the target node's range - this hole is not followed.
  const startY =
    target.position.y + ((target.height || FALLBACK_TARGET_HEIGHT) - totalH) / 2;

  const newIds: string[] = [];
  accepted.forEach((file, idx) => {
    const y = startY + idx * (UPLOAD_HEIGHT + GAP_Y);
    const nodeId = deps.addNode(
      CANVAS_NODE_TYPES.upload,
      { x: baseX, y },
      { user_spawned: true } as Partial<CanvasNodeData>,
    );
    const edgeId = deps.addEdge(nodeId, target.id);
    if (edgeId === null) {
      // The node was built, the edge did not connect, and the file is still delivered - this is the hardest silent failure to troubleshoot, so first
      // print a warning. The convention follows the `[upload-node] ...` of UploadNode.tsx.
      console.warn(
        `[spawn-external-assets] addEdge(${nodeId} -> ${target.id}) returned null; node created without an edge`,
      );
    }
    // The File itself goes through staging (landing synchronously, not waiting for schedule); the event just pokes an already-mounted node.
    stashExternalFile('upload-node/external-file', nodeId, file);
    schedule(() => {
      deps.publish('upload-node/external-file', { nodeId });
    });
    newIds.push(nodeId);
  });

  deps.autoGroupSpawn(target.id, newIds, { label: externalAssetGroupLabel() });

  return newIds;
}
