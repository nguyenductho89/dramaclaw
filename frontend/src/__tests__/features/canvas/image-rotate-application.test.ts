// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

const uploadFreezoneImage = vi.hoisted(() => vi.fn());
const loadImageElement = vi.hoisted(() => vi.fn());
const readUrl = vi.hoisted(() => vi.fn());

vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  uploadFreezoneImage,
}));
vi.mock('@/features/canvas/application/imageData', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadImageElement,
}));
vi.mock('@/lib/url-params', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readUrl,
}));

import {
  createRotateResultNode,
  discardRotateResultNode,
  isIdentityRotateTransform,
  rotateImageInPlace,
} from '@/features/canvas/application/imageRotate';

function seedSourceNode() {
  const nodes: CanvasNode[] = [
    {
      id: 'src-1',
      type: CANVAS_NODE_TYPES.upload,
      position: { x: 0, y: 0 },
      data: { imageUrl: '/static/src.png', aspectRatio: '4:3' },
    } as CanvasNode,
  ];
  useCanvasStore.getState().setCanvasData(nodes, []);
}

// jsdom's <canvas> has no 2D context; stub a minimal ctx + toBlob.
function stubCanvas() {
  const ctx = {
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    drawImage: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
  ) {
    callback(new Blob(['png']));
  });
}

describe('imageRotate application (pre-build/cancel + in-place rotation write-back)', () => {
  beforeEach(() => {
    readUrl.mockReturnValue({ project: 'proj-1', canvas: 'canvas-1' });
    uploadFreezoneImage.mockReset();
    loadImageElement.mockReset();
    seedSourceNode();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('isIdentityRotateTransform: angle 0 with no mirroring counts as no transform', () => {
    expect(isIdentityRotateTransform({ angleDeg: 0, mirrorH: false, mirrorV: false })).toBe(true);
    expect(isIdentityRotateTransform({ angleDeg: 90, mirrorH: false, mirrorV: false })).toBe(false);
    expect(isIdentityRotateTransform({ angleDeg: 0, mirrorH: true, mirrorV: false })).toBe(false);
  });

  it('createRotateResultNode: builds an exportImage previewing the source image and wires the edge (without setting isGenerating)', () => {
    const nodeId = createRotateResultNode('src-1', { displayName: 'Rotate result' });

    const state = useCanvasStore.getState();
    const created = state.nodes.find((node) => node.id === nodeId);
    expect(created?.type).toBe(CANVAS_NODE_TYPES.exportImage);
    expect(created?.data).toMatchObject({
      displayName: 'Rotate result',
      previewImageUrl: '/static/src.png',
      aspectRatio: '4:3',
      resultKind: 'generic',
      isGenerating: false,
    });
    expect(
      state.edges.some((edge) => edge.source === 'src-1' && edge.target === nodeId),
    ).toBe(true);
  });

  it('createRotateResultNode: supports an imageGen node that has only a referenceImageUrl', () => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'src-ref',
          type: CANVAS_NODE_TYPES.imageGen,
          position: { x: 0, y: 0 },
          data: { referenceImageUrl: '/static/reference.png', aspectRatio: '1:1' },
        } as CanvasNode,
      ],
      [],
    );

    const nodeId = createRotateResultNode('src-ref', { displayName: 'Rotate result' });

    const created = useCanvasStore.getState().nodes.find((node) => node.id === nodeId);
    expect(created?.type).toBe(CANVAS_NODE_TYPES.exportImage);
    expect(created?.data.previewImageUrl).toBe('/static/reference.png');
  });

  it('discardRotateResultNode: deletes the pre-built node (cancel/exit path)', () => {
    const nodeId = createRotateResultNode('src-1', { displayName: 'Rotate result' }) as string;
    discardRotateResultNode(nodeId);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === nodeId)).toBeUndefined();
  });

  it('rotateImageInPlace: local canvas rotation -> upload -> writes the url and new aspectRatio back in place', async () => {
    stubCanvas();
    loadImageElement.mockResolvedValue({ naturalWidth: 100, naturalHeight: 50 });
    uploadFreezoneImage.mockResolvedValue({ url: '/static/rotated.png' });
    const nodeId = createRotateResultNode('src-1', { displayName: 'Rotate result' }) as string;

    await rotateImageInPlace(nodeId, '/static/src.png', {
      angleDeg: 90,
      mirrorH: false,
      mirrorV: false,
    });

    expect(loadImageElement).toHaveBeenCalledWith('/static/src.png');
    expect(uploadFreezoneImage).toHaveBeenCalledTimes(1);
    expect(uploadFreezoneImage.mock.calls[0][0]).toBe('proj-1');
    const done = useCanvasStore.getState().nodes.find((node) => node.id === nodeId);
    // After a 90 degree rotation the canvas swaps width and height -> 50x100.
    expect(done?.data).toMatchObject({
      imageUrl: '/static/rotated.png',
      previewImageUrl: '/static/rotated.png',
      aspectRatio: '50:100',
      isGenerating: false,
      generationError: null,
    });
  });

  it('rotateImageInPlace: missing project -> returns null without uploading', () => {
    readUrl.mockReturnValue({ project: null, canvas: null });
    const nodeId = createRotateResultNode('src-1', { displayName: 'Rotate result' }) as string;
    expect(
      rotateImageInPlace(nodeId, '/static/src.png', {
        angleDeg: 90,
        mirrorH: false,
        mirrorV: false,
      }),
    ).toBeNull();
    expect(uploadFreezoneImage).not.toHaveBeenCalled();
  });

  it('rotateImageInPlace failure -> the error is written back to the node', async () => {
    stubCanvas();
    loadImageElement.mockRejectedValue(new Error('load boom'));
    const nodeId = createRotateResultNode('src-1', { displayName: 'Rotate result' }) as string;

    await rotateImageInPlace(nodeId, '/static/src.png', {
      angleDeg: 90,
      mirrorH: false,
      mirrorV: false,
    });

    const failed = useCanvasStore.getState().nodes.find((node) => node.id === nodeId);
    expect(failed?.data).toMatchObject({
      isGenerating: false,
      generationError: 'load boom',
      generationErrorDetails: 'load boom',
    });
    expect(uploadFreezoneImage).not.toHaveBeenCalled();
  });
});
