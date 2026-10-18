// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

const submitFreezoneUpscale = vi.hoisted(() => vi.fn());
const fetchFreezoneJobResult = vi.hoisted(() => vi.fn());
const awaitTaskCompletion = vi.hoisted(() => vi.fn());
const readUrl = vi.hoisted(() => vi.fn());

vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  submitFreezoneUpscale,
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

import {
  createUpscaleResultNode,
  submitImageUpscale,
} from '@/features/canvas/application/imageUpscale';

const JOB_REF = { task_key: 'tk-up', task_type: 'freezone_upscale', job_id: 'job-up' };

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

describe('imageUpscale application (pre-built node + upscale submission orchestration)', () => {
  beforeEach(() => {
    readUrl.mockReturnValue({ project: 'proj-1', canvas: 'canvas-1' });
    submitFreezoneUpscale.mockReset();
    fetchFreezoneJobResult.mockReset();
    awaitTaskCompletion.mockReset();
    seedSourceNode();
  });

  it('createUpscaleResultNode: builds a resultKind:upscale placeholder node and wires the edge (writes the upscale params, no submit)', () => {
    const nodeId = createUpscaleResultNode('src-1', { displayName: 'Upscale' });

    const state = useCanvasStore.getState();
    const created = state.nodes.find((node) => node.id === nodeId);
    expect(created?.type).toBe(CANVAS_NODE_TYPES.exportImage);
    expect(created?.data).toMatchObject({
      displayName: 'Upscale',
      previewImageUrl: '/static/src.png',
      aspectRatio: '16:9',
      resultKind: 'upscale',
      isGenerating: false,
      upscaleSourceUrl: '/static/src.png',
      upscaleImageSize: '2K',
      upscaleScaleFactor: 2,
    });
    expect(
      state.edges.some((edge) => edge.source === 'src-1' && edge.target === nodeId),
    ).toBe(true);
    // Pre-building does not submit a task.
    expect(submitFreezoneUpscale).not.toHaveBeenCalled();
  });

  it('createUpscaleResultNode: source node does not exist -> returns null and creates no node', () => {
    const before = useCanvasStore.getState().nodes.length;
    expect(createUpscaleResultNode('nope', { displayName: 'Upscale' })).toBeNull();
    expect(useCanvasStore.getState().nodes.length).toBe(before);
  });

  it('submitImageUpscale: sets isGenerating -> submits (query-stripped source url) -> fills the url back', async () => {
    const nodeId = createUpscaleResultNode('src-1', { displayName: 'Upscale' }) as string;
    submitFreezoneUpscale.mockResolvedValue(JOB_REF);
    awaitTaskCompletion.mockResolvedValue({ result: { output_url: '/static/hd.png' } });

    await submitImageUpscale(nodeId, {
      sourceUrl: '/static/src.png?sig=abc',
      scaleFactor: 4,
      imageSize: '4K',
      model: 'gpt-image-2',
    });

    expect(submitFreezoneUpscale).toHaveBeenCalledWith('proj-1', {
      sourceUrl: '/static/src.png',
      scaleFactor: 4,
      imageSize: '4K',
      model: 'gpt-image-2',
    });
    expect(awaitTaskCompletion).toHaveBeenCalledWith('tk-up', 'proj-1');
    // output_url returned directly -> no fallback to the job result.
    expect(fetchFreezoneJobResult).not.toHaveBeenCalled();
    const done = useCanvasStore.getState().nodes.find((node) => node.id === nodeId);
    expect(done?.data).toMatchObject({
      imageUrl: '/static/hd.png',
      previewImageUrl: '/static/hd.png',
      isGenerating: false,
      generationError: null,
    });
  });

  it('submitImageUpscale: missing project -> returns null without submitting', () => {
    const nodeId = createUpscaleResultNode('src-1', { displayName: 'Upscale' }) as string;
    readUrl.mockReturnValue({ project: null, canvas: null });
    expect(
      submitImageUpscale(nodeId, {
        sourceUrl: '/static/src.png',
        scaleFactor: 2,
        imageSize: '2K',
        model: 'gpt-image-2',
      }),
    ).toBeNull();
    expect(submitFreezoneUpscale).not.toHaveBeenCalled();
  });

  it('submitImageUpscale failure -> the error is written back to the node', async () => {
    const nodeId = createUpscaleResultNode('src-1', { displayName: 'Upscale' }) as string;
    submitFreezoneUpscale.mockRejectedValue(new Error('backend down'));

    await submitImageUpscale(nodeId, {
      sourceUrl: '/static/src.png',
      scaleFactor: 2,
      imageSize: '2K',
      model: 'gpt-image-2',
    });

    const failed = useCanvasStore.getState().nodes.find((node) => node.id === nodeId);
    expect(failed?.data).toMatchObject({
      isGenerating: false,
      generationError: 'backend down',
    });
  });
});
