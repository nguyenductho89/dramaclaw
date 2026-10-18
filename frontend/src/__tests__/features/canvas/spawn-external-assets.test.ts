// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  externalAssetGroupLabel,
  spawnExternalAssetNodes,
  type SpawnExternalAssetsDeps,
} from '@/features/canvas/application/spawnExternalAssets';
import {
  resetPendingExternalFilesForTest,
  takeExternalFile,
} from '@/features/canvas/application/pendingExternalFiles';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';

const TARGET = { id: 'video-1', position: { x: 1000, y: 500 }, height: 380 };

function makeFile(name: string, type: string): File {
  return new File(['x'], name, { type });
}

/** Fake dependencies. schedule runs synchronously so delivery completes before the function returns, which makes assertions easy. */
function makeDeps() {
  let seq = 0;
  const addNode = vi.fn<SpawnExternalAssetsDeps['addNode']>(() => `up-${seq++}`);
  const addEdge = vi.fn<SpawnExternalAssetsDeps['addEdge']>(() => 'edge-1');
  const publish = vi.fn<SpawnExternalAssetsDeps['publish']>();
  const autoGroupSpawn = vi.fn<SpawnExternalAssetsDeps['autoGroupSpawn']>(() => 'group-1');
  const deps: SpawnExternalAssetsDeps = {
    addNode,
    addEdge,
    publish,
    autoGroupSpawn,
    schedule: (fn) => fn(),
  };
  return { deps, addNode, addEdge, publish, autoGroupSpawn };
}

describe('spawnExternalAssetNodes', () => {
  // The staging is module-level, and every case here restarts node ids from up-0 -- without clearing, state would leak across cases.
  beforeEach(() => {
    resetPendingExternalFilesForTest();
  });

  afterEach(() => {
    resetPendingExternalFilesForTest();
  });

  it('images/videos/audio all land as upload nodes first, and UploadNode routes them itself', () => {
    const { deps, addNode } = makeDeps();
    const files = [
      makeFile('a.png', 'image/png'),
      makeFile('b.mp4', 'video/mp4'),
      makeFile('c.mp3', 'audio/mpeg'),
    ];

    spawnExternalAssetNodes(TARGET, files, deps);

    expect(addNode).toHaveBeenCalledTimes(3);
    for (const call of addNode.mock.calls) {
      expect(call[0]).toBe(CANVAS_NODE_TYPES.upload);
      // The only data field allowed is user_spawned (otherwise the new node would be
      // locked by NodeActionToolbar as a system node). imageOnly would make UploadNode reject
      // audio/video, and displayName would override "use the uploaded file name as the node title" -- neither of them, nor any
      // other unexpected field, should appear.
      expect(call[2]).toEqual({ user_spawned: true });
    }
  });

  it('non-media files are blocked before node creation, leaving no empty nodes', () => {
    const { deps, addNode, addEdge, publish } = makeDeps();
    const files = [
      new File(['x'], 'doc.pdf', { type: 'application/pdf' }),
      makeFile('a.png', 'image/png'),
    ];

    const ids = spawnExternalAssetNodes(TARGET, files, deps);

    // Only the image got in. UploadNode silently returns for non-media files, and letting them in would leave
    // a node that is wired but forever empty.
    expect(ids).toEqual(['up-0']);
    expect(addNode).toHaveBeenCalledOnce();
    expect(addEdge).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
  });

  it('professional containers like .mxf whose MIME is an empty string are still accepted', () => {
    const { deps, addNode } = makeDeps();

    spawnExternalAssetNodes(TARGET, [new File(['x'], 'clip.mxf', { type: '' })], deps);

    expect(addNode).toHaveBeenCalledOnce();
  });

  it('each new node gets one edge to the target node, directed new node -> target', () => {
    const { deps, addEdge } = makeDeps();

    spawnExternalAssetNodes(TARGET, [makeFile('a.png', 'image/png')], deps);

    expect(addEdge).toHaveBeenCalledExactlyOnceWith('up-0', 'video-1');
  });

  it('stages the original File object under the matching new node, and the event carries only nodeId', () => {
    const { deps, publish } = makeDeps();
    const file = makeFile('a.png', 'image/png');

    const ids = spawnExternalAssetNodes(TARGET, [file], deps);

    expect(ids).toEqual(['up-0']);
    expect(publish).toHaveBeenCalledOnce();
    const [type, payload] = publish.mock.calls[0]!;
    expect(type).toBe('upload-node/external-file');
    expect(payload.nodeId).toBe('up-0');
    // The contract is "hand the original File object to that node": identity, not structure. File does not go through the payload,
    // it goes through module-level staging -- the bus has no replay, and at low zoom the new node mounts as an LOD shell first, so an event alone would surely be lost.
    expect(takeExternalFile('upload-node/external-file', 'up-0')).toBe(file);
  });

  it('with multiple files each node receives its own file and wires its own edge', () => {
    const { deps, addEdge, publish } = makeDeps();
    const files = [makeFile('a.png', 'image/png'), makeFile('b.mp4', 'video/mp4')];

    spawnExternalAssetNodes(TARGET, files, deps);

    // Hoisting nodeId out of the loop would blow up the two assertions below; and file must be compared by identity with toBe --
    // File's name/type/size are prototype getters with no own enumerable properties, so under toEqual
    // any two Files are equal, and a structural comparison would test nothing.
    expect(addEdge.mock.calls).toEqual([
      ['up-0', 'video-1'],
      ['up-1', 'video-1'],
    ]);
    expect(publish.mock.calls.map((c) => c[1].nodeId)).toEqual(['up-0', 'up-1']);
    expect(takeExternalFile('upload-node/external-file', 'up-0')).toBe(files[0]);
    expect(takeExternalFile('upload-node/external-file', 'up-1')).toBe(files[1]);
  });

  it('the edge is already wired when delivery happens, so the morph has an edge to inherit', () => {
    const { deps, addEdge, publish } = makeDeps();
    const scheduled: Array<() => void> = [];
    deps.schedule = (fn) => {
      scheduled.push(fn);
    };

    spawnExternalAssetNodes(TARGET, [makeFile('a.mp4', 'video/mp4')], deps);

    expect(addEdge).toHaveBeenCalledOnce(); // The edge is already there before delivery
    scheduled.forEach((fn) => fn());
    expect(publish).toHaveBeenCalledOnce();
  });

  it('delivery is deferred to the scheduler, waiting for the new node to mount and subscribe', () => {
    const { deps, publish } = makeDeps();
    const scheduled: Array<() => void> = [];
    deps.schedule = (fn) => {
      scheduled.push(fn);
    };

    spawnExternalAssetNodes(TARGET, [makeFile('a.png', 'image/png')], deps);

    // The scheduler has not run yet -> no event should be sent at all.
    expect(publish).not.toHaveBeenCalled();
    scheduled.forEach((fn) => fn());
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('a single file is vertically centered relative to the target node', () => {
    const { deps, addNode } = makeDeps();

    spawnExternalAssetNodes(TARGET, [makeFile('a.png', 'image/png')], deps);

    // UPLOAD_HEIGHT=240,target.height=380 → y = 500 + (380-240)/2 = 570
    expect(addNode).toHaveBeenCalledExactlyOnceWith(
      CANVAS_NODE_TYPES.upload,
      { x: 640, y: 570 },
      { user_spawned: true },
    );
  });

  it('multiple files stack vertically with a step of UPLOAD_HEIGHT+GAP_Y=264, centered as a whole relative to the target', () => {
    const { deps, addNode } = makeDeps();
    const files = [makeFile('a.png', 'image/png'), makeFile('b.mp4', 'video/mp4')];

    spawnExternalAssetNodes(TARGET, files, deps);

    // totalH = 240*2 + 24 = 504; startY = 500 + (380-504)/2 = 438
    expect(addNode.mock.calls[0]?.[1]).toEqual({ x: 640, y: 438 });
    expect(addNode.mock.calls[1]?.[1]).toEqual({ x: 640, y: 702 });
    expect(addNode.mock.calls[1]![1].x).toBe(addNode.mock.calls[0]![1].x);
    expect(addNode.mock.calls[1]![1].y - addNode.mock.calls[0]![1].y).toBe(264);
  });

  it('falls back to 380 (FALLBACK_TARGET_HEIGHT) when target gives no height', () => {
    const { deps, addNode } = makeDeps();
    const targetNoHeight = { id: 'video-1', position: { x: 1000, y: 500 } };

    spawnExternalAssetNodes(targetNoHeight, [makeFile('a.png', 'image/png')], deps);

    expect(addNode).toHaveBeenCalledExactlyOnceWith(
      CANVAS_NODE_TYPES.upload,
      { x: 640, y: 570 },
      { user_spawned: true },
    );
  });

  it('also falls back to 380 when target.height is 0, instead of centering on a 0 height', () => {
    const { deps, addNode } = makeDeps();
    // With ?? the 0 would slip through and startY would become 500 + (0-240)/2 = 380, floating the whole group upward.
    const targetZeroHeight = { id: 'video-1', position: { x: 1000, y: 500 }, height: 0 };

    spawnExternalAssetNodes(targetZeroHeight, [makeFile('a.png', 'image/png')], deps);

    expect(addNode.mock.calls[0]?.[1]).toEqual({ x: 640, y: 570 });
  });

  it('warns when the edge fails but still delivers the file (not silently swallowed)', () => {
    const { deps, addEdge, publish } = makeDeps();
    addEdge.mockReturnValueOnce(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      spawnExternalAssetNodes(TARGET, [makeFile('a.png', 'image/png')], deps);

      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]?.[0])).toContain('up-0');
      // A failed edge does not mean the file should not be delivered -- the node is already built, so at least give it content.
      expect(publish).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('non-media files take no vertical slot: totalH is computed from accepted.length rather than files.length', () => {
    const { deps, addNode } = makeDeps();
    const pdf = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    const files = [pdf, makeFile('a.png', 'image/png'), pdf];

    spawnExternalAssetNodes(TARGET, files, deps);

    // Only 1 is accepted -> it should be laid out at the "single file centered" y=570, rather than at the centered offset
    // computed from files.length=3 (which would place it at a different y).
    expect(addNode).toHaveBeenCalledExactlyOnceWith(
      CANVAS_NODE_TYPES.upload,
      { x: 640, y: 570 },
      { user_spawned: true },
    );
  });

  it('newly created nodes are automatically grouped', () => {
    const { deps, autoGroupSpawn } = makeDeps();
    const files = [makeFile('a.png', 'image/png'), makeFile('b.mp4', 'video/mp4')];

    spawnExternalAssetNodes(TARGET, files, deps);

    expect(autoGroupSpawn).toHaveBeenCalledExactlyOnceWith(
      'video-1',
      ['up-0', 'up-1'],
      { label: externalAssetGroupLabel() },
    );
  });

  it('empty file list: returns [] directly, creating no nodes, edges, deliveries or groups', () => {
    const { deps, addNode, addEdge, publish, autoGroupSpawn } = makeDeps();

    const ids = spawnExternalAssetNodes(TARGET, [], deps);

    expect(ids).toEqual([]);
    expect(addNode).not.toHaveBeenCalled();
    expect(addEdge).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(autoGroupSpawn).not.toHaveBeenCalled();
  });

  it('all selected files are non-media: the short circuit must land after filtering, leaving no empty group', () => {
    const { deps, autoGroupSpawn } = makeDeps();
    const pdf = new File(['x'], 'a.pdf', { type: 'application/pdf' });

    const ids = spawnExternalAssetNodes(TARGET, [pdf], deps);

    expect(ids).toEqual([]);
    // Regression test: if the short circuit were written before filtering and checked files.length, this "all non-media"
    // input would slip through the short circuit, run to the end, and then autoGroupSpawn(target.id, []) would create an
    // empty group.
    expect(autoGroupSpawn).not.toHaveBeenCalled();
  });
});

describe('externalAssetGroupLabel', () => {
  it('is distinguished from the asset library\'s group label', () => {
    expect(externalAssetGroupLabel()).not.toBe('Asset reference group');
  });
});
