// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import type { LightEditorSubmitPayload } from '@/features/canvas/ui/LightEditorPanel';
import { useCanvasStore } from '@/stores/canvasStore';

const submitFreezoneRelight = vi.hoisted(() => vi.fn());
const fetchFreezoneJobResult = vi.hoisted(() => vi.fn());
const awaitTaskCompletion = vi.hoisted(() => vi.fn());
const readUrl = vi.hoisted(() => vi.fn());

vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  submitFreezoneRelight,
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

import { relightImage } from '@/features/canvas/application/imageRelight';

const JOB_REF = { task_key: 'tk-rl', task_type: 'freezone_relight', job_id: 'job-rl' };

function payload(overrides: Partial<LightEditorSubmitPayload> = {}): LightEditorSubmitPayload {
  return {
    prompt: '',
    displayName: 'Relight',
    brightness: 70,
    color: '#ffd7a8',
    colorTemperatureKelvin: 4000,
    mainLight: {
      vector: { x: -0.6, y: 0.2 },
      depth: 'front',
      nearestPreset: 'left',
      label: 'Left',
    },
    rimLight: true,
    smartMode: {
      enabled: true,
      prompt: 'Soft morning light',
      preset: null,
      presetLabel: null,
      presetPrompt: 'Cinematic feel',
    },
    apiModel: 'gpt-image-2',
    providerId: 'huimeng',
    imageSize: '2K',
    ...overrides,
  };
}

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

describe('imageRelight application (relight generation orchestration)', () => {
  beforeEach(() => {
    readUrl.mockReturnValue({ project: 'proj-1', canvas: 'canvas-1' });
    submitFreezoneRelight.mockReset();
    fetchFreezoneJobResult.mockReset();
    awaitTaskCompletion.mockReset();
    seedSourceNode();
  });

  it('builds the result node and wires the edge -> submits (key light direction + smart prompt concatenation) -> fills the url back', async () => {
    submitFreezoneRelight.mockResolvedValue(JOB_REF);
    awaitTaskCompletion.mockResolvedValue({ result: { output_url: '/static/rl.png' } });

    const result = relightImage('src-1', '/static/src.png?sig=x', payload());

    expect(result).not.toBeNull();
    const nodeId = result?.nodeId;
    const state = useCanvasStore.getState();
    expect(state.nodes.find((node) => node.id === nodeId)?.data).toMatchObject({
      displayName: 'Relight',
      aspectRatio: '16:9',
      resultKind: 'generic',
      isGenerating: true,
    });
    expect(
      state.edges.some((edge) => edge.source === 'src-1' && edge.target === nodeId),
    ).toBe(true);

    await result?.completion;
    expect(submitFreezoneRelight).toHaveBeenCalledWith('proj-1', {
      sourceUrl: '/static/src.png',
      lightingReferenceUrl: null,
      scope: 'global',
      smartMode: true,
      brightness: 70,
      colorHex: '#ffd7a8',
      colorTemperatureKelvin: 4000,
      keyLightDirection: 'left',
      rimLight: true,
      // Smart mode on: prompt + presetPrompt joined with a newline.
      prompt: 'Soft morning light\nCinematic feel',
      imageSize: '2K',
      model: 'gpt-image-2',
    });
    const done = useCanvasStore.getState().nodes.find((node) => node.id === nodeId);
    expect(done?.data).toMatchObject({
      imageUrl: '/static/rl.png',
      isGenerating: false,
      generationError: null,
    });
  });

  it('smart mode off -> empty prompt; key light without a valid preset -> falls back to front', async () => {
    submitFreezoneRelight.mockResolvedValue(JOB_REF);
    awaitTaskCompletion.mockResolvedValue({ result: { output_url: '/static/rl.png' } });

    const result = relightImage(
      'src-1',
      '/static/src.png',
      payload({
        mainLight: {
          vector: { x: 0, y: 0 },
          depth: 'front',
          nearestPreset: null,
          label: 'Front',
        },
        smartMode: {
          enabled: false,
          prompt: 'Ignored',
          preset: null,
          presetLabel: null,
          presetPrompt: 'Also ignored',
        },
      }),
    );
    await result?.completion;

    expect(submitFreezoneRelight.mock.calls[0][1]).toMatchObject({
      smartMode: false,
      keyLightDirection: 'front',
      prompt: '',
    });
  });

  it('missing project -> returns null and creates no node', () => {
    readUrl.mockReturnValue({ project: null, canvas: null });
    const before = useCanvasStore.getState().nodes.length;
    expect(relightImage('src-1', '/static/src.png', payload())).toBeNull();
    expect(useCanvasStore.getState().nodes.length).toBe(before);
  });

  it('submit failure -> the error is written back to the result node', async () => {
    submitFreezoneRelight.mockRejectedValue(new Error('relight boom'));

    const result = relightImage('src-1', '/static/src.png', payload());
    await result?.completion;

    const failed = useCanvasStore.getState().nodes.find((node) => node.id === result?.nodeId);
    expect(failed?.data).toMatchObject({
      isGenerating: false,
      generationError: 'relight boom',
    });
  });
});
