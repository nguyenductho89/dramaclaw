// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

const uploadFreezoneImage = vi.hoisted(() => vi.fn());
const matteInWorker = vi.hoisted(() => vi.fn());
const readUrl = vi.hoisted(() => vi.fn());

vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  uploadFreezoneImage,
}));
vi.mock('@/features/canvas/application/matteClient', () => ({
  matteInWorker,
  preloadMatteWorker: vi.fn(),
}));
vi.mock('@/lib/url-params', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readUrl,
}));

import { matteImage } from '@/features/canvas/application/matteImage';

function seedSourceNode() {
  const nodes: CanvasNode[] = [
    {
      id: 'src-1',
      type: CANVAS_NODE_TYPES.upload,
      position: { x: 0, y: 0 },
      data: { imageUrl: '/static/src.png', aspectRatio: '16:9' },
    } as CanvasNode,
  ];
  useCanvasStore.getState().setCanvasData(nodes, []);
}

describe('matteImage (cutout orchestration, extracted from NodeActionToolbar)', () => {
  beforeEach(() => {
    readUrl.mockReturnValue({ project: 'proj-1', canvas: 'canvas-1' });
    uploadFreezoneImage.mockReset();
    matteInWorker.mockReset();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, blob: async () => new Blob(['src']) })),
    );
    seedSourceNode();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('synchronously builds an isGenerating exportImage result node, wires/selects it, and fills the url back on completion', async () => {
    matteInWorker.mockResolvedValue(new Blob(['matted']));
    uploadFreezoneImage.mockResolvedValue({ url: '/static/matted.png' });

    const result = matteImage('src-1', '/static/src.png', { displayName: 'Cutout' });

    expect(result).not.toBeNull();
    const resultId = result?.nodeId;
    const state = useCanvasStore.getState();
    const created = state.nodes.find((node) => node.id === resultId);
    expect(created?.type).toBe(CANVAS_NODE_TYPES.exportImage);
    expect(created?.data).toMatchObject({
      displayName: 'Cutout',
      aspectRatio: '16:9',
      resultKind: 'matte',
      isGenerating: true,
    });
    expect(
      state.edges.some((edge) => edge.source === 'src-1' && edge.target === resultId),
    ).toBe(true);
    expect(state.selectedNodeId).toBe(resultId);
    expect(state.pendingFocusNodeId).toBe(resultId);

    // completion resolves after the background chain (fetch -> worker -> upload -> fill back) settles.
    await result?.completion;
    // Call order: fetch the source image -> worker background removal -> upload -> fill back.
    expect(matteInWorker).toHaveBeenCalledTimes(1);
    expect(uploadFreezoneImage).toHaveBeenCalledTimes(1);
    expect(uploadFreezoneImage.mock.calls[0][0]).toBe('proj-1');
    const done = useCanvasStore.getState().nodes.find((node) => node.id === resultId);
    expect(done?.data).toMatchObject({
      imageUrl: '/static/matted.png',
      previewImageUrl: '/static/matted.png',
      isGenerating: false,
      generationError: null,
    });
  });

  it('background removal failure -> writes the error to the result node and clears isGenerating', async () => {
    matteInWorker.mockRejectedValue(new Error('worker boom'));

    const result = matteImage('src-1', '/static/src.png');
    await result?.completion;

    const failed = useCanvasStore
      .getState()
      .nodes.find((node) => node.id === result?.nodeId);
    expect(failed?.data).toMatchObject({
      isGenerating: false,
      generationError: 'worker boom',
      generationErrorDetails: 'worker boom',
    });
    expect(uploadFreezoneImage).not.toHaveBeenCalled();
  });

  it('missing project -> returns null directly without creating a node', () => {
    readUrl.mockReturnValue({ project: null, canvas: null });
    const before = useCanvasStore.getState().nodes.length;
    expect(matteImage('src-1', '/static/src.png')).toBeNull();
    expect(useCanvasStore.getState().nodes.length).toBe(before);
  });
});
