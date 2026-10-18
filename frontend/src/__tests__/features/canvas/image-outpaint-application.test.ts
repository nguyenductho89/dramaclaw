// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

const submitFreezoneOutpaint = vi.hoisted(() => vi.fn());
const fetchFreezoneJobResult = vi.hoisted(() => vi.fn());
const awaitTaskCompletion = vi.hoisted(() => vi.fn());
const readUrl = vi.hoisted(() => vi.fn());

vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  submitFreezoneOutpaint,
  fetchFreezoneJobResult,
}));
vi.mock('@/api/tasks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  awaitTaskCompletion,
}));
vi.mock('@/lib/url-params', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readUrl,
}));

import { outpaintImage } from '@/features/canvas/application/imageOutpaint';

const JOB_REF = { task_key: 'tk-op', task_type: 'freezone_edit', job_id: 'job-op' };

function seedSourceNode() {
  const nodes: CanvasNode[] = [
    {
      id: 'src-1',
      type: CANVAS_NODE_TYPES.upload,
      position: { x: 0, y: 0 },
      data: { imageUrl: '/static/src.png', aspectRatio: '1:1' },
    } as CanvasNode,
  ];
  useCanvasStore.getState().setCanvasData(nodes, []);
}

describe('imageOutpaint application (outpaint submission orchestration)', () => {
  beforeEach(() => {
    readUrl.mockReturnValue({ project: 'proj-1', canvas: 'canvas-1' });
    submitFreezoneOutpaint.mockReset();
    fetchFreezoneJobResult.mockReset();
    awaitTaskCompletion.mockReset();
    seedSourceNode();
  });

  it('single image: builds an isGenerating result node and wires the edge -> submits (query-stripped source url) -> fills the url back', async () => {
    submitFreezoneOutpaint.mockResolvedValue(JOB_REF);
    awaitTaskCompletion.mockResolvedValue({ result: { output_url: '/static/op.png' } });

    const result = outpaintImage('src-1', '/static/src.png?sig=x', {
      displayName: 'Outpaint',
      targetAspectRatio: '16:9',
      imageSize: '2K',
      numImages: 1,
      model: 'gpt-image-2',
    });

    expect(result).not.toBeNull();
    expect(result?.nodeIds).toHaveLength(1);
    const nodeId = result?.nodeIds[0];
    const state = useCanvasStore.getState();
    const created = state.nodes.find((node) => node.id === nodeId);
    expect(created?.type).toBe(CANVAS_NODE_TYPES.exportImage);
    expect(created?.data).toMatchObject({
      displayName: 'Outpaint',
      // target != original -> use the target ratio.
      aspectRatio: '16:9',
      resultKind: 'generic',
      isGenerating: true,
    });
    expect(
      state.edges.some((edge) => edge.source === 'src-1' && edge.target === nodeId),
    ).toBe(true);

    await result?.completion;
    expect(submitFreezoneOutpaint).toHaveBeenCalledWith('proj-1', {
      sourceUrl: '/static/src.png',
      targetAspectRatio: '16:9',
      numImages: 1,
      imageSize: '2K',
      model: 'gpt-image-2',
    });
    const done = useCanvasStore.getState().nodes.find((node) => node.id === nodeId);
    expect(done?.data).toMatchObject({
      imageUrl: '/static/op.png',
      previewImageUrl: '/static/op.png',
      isGenerating: false,
      generationError: null,
    });
  });

  it('original ratio: inherits the source node aspectRatio; N images build N nodes, each sending one single-image request', async () => {
    submitFreezoneOutpaint.mockResolvedValue(JOB_REF);
    awaitTaskCompletion.mockResolvedValue({ result: {} });
    fetchFreezoneJobResult.mockResolvedValue({ url: '/static/op.png' });

    const result = outpaintImage('src-1', '/static/src.png', {
      displayName: 'Outpaint',
      targetAspectRatio: 'original',
      imageSize: '2K',
      numImages: 3,
      model: 'gpt-image-2',
    });

    expect(result?.nodeIds).toHaveLength(3);
    const first = useCanvasStore
      .getState()
      .nodes.find((node) => node.id === result?.nodeIds[0]);
    expect(first?.data).toMatchObject({ aspectRatio: '1:1' });

    await result?.completion;
    // The backend handles only 1 image per call: N=3 sends 3 single-image requests (num_images is always 1).
    expect(submitFreezoneOutpaint).toHaveBeenCalledTimes(3);
    expect(submitFreezoneOutpaint.mock.calls[0][1]).toMatchObject({ numImages: 1 });
  });

  it('missing project -> returns null and creates no node', () => {
    readUrl.mockReturnValue({ project: null, canvas: null });
    const before = useCanvasStore.getState().nodes.length;
    expect(
      outpaintImage('src-1', '/static/src.png', {
        displayName: 'Outpaint',
        targetAspectRatio: '1:1',
        imageSize: '2K',
        numImages: 1,
        model: 'gpt-image-2',
      }),
    ).toBeNull();
    expect(useCanvasStore.getState().nodes.length).toBe(before);
  });

  it('single-image failure -> the error is written back to that result node', async () => {
    submitFreezoneOutpaint.mockRejectedValue(new Error('outpaint boom'));

    const result = outpaintImage('src-1', '/static/src.png', {
      displayName: 'Outpaint',
      targetAspectRatio: '1:1',
      imageSize: '2K',
      numImages: 1,
      model: 'gpt-image-2',
    });
    await result?.completion;

    const failed = useCanvasStore
      .getState()
      .nodes.find((node) => node.id === result?.nodeIds[0]);
    expect(failed?.data).toMatchObject({
      isGenerating: false,
      generationError: 'outpaint boom',
    });
  });
});
