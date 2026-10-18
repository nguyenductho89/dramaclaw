// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { submitFreezoneVideoGen } from '@/api/ops';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import { useCanvasStore } from '@/stores/canvasStore';

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverMock);

vi.mock('@/lib/model-task-access', () => ({
  useModelTaskAccess: () => ({ blocked: false, denialReason: null, message: null }),
}));

// Compute-cost quoting goes through react-query and the test tree has no QueryClientProvider -- short-circuit it directly.
vi.mock('@/lib/queries/generation-credit-cost', () => ({
  useGenerationCreditCost: () => ({ data: undefined }),
}));

// Submission requires a project in the URL (otherwise handleSubmit returns early).
vi.mock('@/lib/url-params', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/url-params')>()),
  readUrl: () => ({ project: 'demo-project', canvas: 'default' }),
}));

vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/ops')>()),
  fetchFreezoneVideoModels: vi.fn(async () => [
    {
      id: 'huimeng/test-video',
      providerId: 'huimeng',
      apiModel: 'test_video_api',
      label: 'Test video model',
    },
  ]),
  fetchFreezoneVideoCameraTemplates: vi.fn(async () => []),
  listFreezoneGenerationHistory: vi.fn(async () => []),
  submitFreezoneVideoGen: vi.fn(async () => ({
    task_key: 'task-1',
    task_type: 'freezone_video_gen',
    job_id: 'job-1',
  })),
  fetchFreezoneJobResult: vi.fn(async () => ({ url: '/static/out.mp4' })),
}));

vi.mock('@/api/tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/tasks')>()),
  awaitTaskCompletion: vi.fn(async () => ({
    result: { video_url: '/static/out.mp4' },
  })),
}));

function seed(nodes: CanvasNode[]) {
  useCanvasStore.getState().setCanvasData(nodes, []);
}

function emptyVideoNode(overrides: Record<string, unknown> = {}): CanvasNode {
  return {
    id: 'vid-1',
    type: CANVAS_NODE_TYPES.video,
    position: { x: 0, y: 0 },
    data: {
      videoUrl: null,
      prompt: '',
      aspectRatio: '16:9',
      quality: '720P',
      displayName: 'Video node 1',
      ...overrides,
    },
  } as CanvasNode;
}

function detailPanel() {
  return screen.getByRole('region', { name: 'Asset details' });
}

function openDetail(name: string) {
  render(<AssetBoardView visible onLocateNode={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name }));
}

describe('Storyboard detail · video generation form', () => {
  beforeEach(() => {
    vi.mocked(submitFreezoneVideoGen).mockClear();
  });

  it('empty video node: the media area shows the "Generates after confirmation" placeholder, with the full generation form mounted below', () => {
    seed([emptyVideoNode()]);
    openDetail('Video node 1');

    const detail = detailPanel();
    expect(within(detail).getAllByText('Generates after confirmation').length).toBeGreaterThan(0);
    // Generation bar: camera / Asset library chips + prompt input + submit.
    expect(within(detail).getByRole('button', { name: /Asset library/ })).toBeInTheDocument();
    expect(
      detail.querySelector('[data-placeholder="Describe the video to generate."]'),
    ).not.toBeNull();
    expect(within(detail).getByRole('button', { name: 'Submit' })).toBeInTheDocument();
  });

  it('empty prompt and no upstream text -> the submit button is disabled', () => {
    seed([emptyVideoNode()]);
    openDetail('Video node 1');

    expect(within(detailPanel()).getByRole('button', { name: 'Submit' })).toBeDisabled();
  });

  it('with a prompt -> clicking submit goes through the real submission chain (submitFreezoneVideoGen receives that prompt)', async () => {
    seed([emptyVideoNode({ prompt: 'A glowing kitten strolls across a rooftop on a snowy night' })]);
    openDetail('Video node 1');

    const submit = within(detailPanel()).getByRole('button', { name: 'Submit' });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() => expect(submitFreezoneVideoGen).toHaveBeenCalled());
    const [project, payload] = vi.mocked(submitFreezoneVideoGen).mock.calls[0];
    expect(project).toBe('demo-project');
    expect(payload.prompt).toBe('A glowing kitten strolls across a rooftop on a snowy night');
    expect(payload.nodeId).toBe('vid-1');
    expect(payload.genMode).toBe('textToVideo');
  });

  it('a video node with output still mounts the form, and no longer renders the read-only prompt block twice', () => {
    seed([
      emptyVideoNode({
        videoUrl: '/static/done.mp4',
        prompt: 'The prompt of an already generated clip',
      }),
    ]);
    openDetail('Video node 1');

    const detail = detailPanel();
    expect(within(detail).getByRole('button', { name: 'Submit' })).toBeInTheDocument();
    // The read-only block's small heading does not appear -- the prompt is carried only once, by the input in the form.
    expect(within(detail).queryByText('Prompt')).not.toBeInTheDocument();
    expect(within(detail).getAllByText('The prompt of an already generated clip')).toHaveLength(1);
  });

  it('videoCompose node detail has no generation form (it goes through clip composition and is not a generation node)', () => {
    seed([
      {
        id: 'compose-1',
        type: CANVAS_NODE_TYPES.videoCompose,
        position: { x: 0, y: 0 },
        data: { displayName: 'Compose node', prompt: 'A compose prompt' },
      } as CanvasNode,
    ]);
    openDetail('Compose node');

    const detail = detailPanel();
    expect(within(detail).queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: /Asset library/ })).not.toBeInTheDocument();
  });

  it('a referenceOnly reference video node mounts no form (aligned with the workflow, which shows no generation panel)', () => {
    seed([
      emptyVideoNode({
        videoUrl: '/static/ref.mp4',
        displayName: 'Asset library reference video',
        referenceOnly: true,
      }),
    ]);
    openDetail('Asset library reference video');

    expect(within(detailPanel()).queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();
  });

  it('the video card empty placeholder text matches the detail', () => {
    seed([emptyVideoNode()]);
    render(<AssetBoardView visible onLocateNode={() => {}} />);

    // The video card's empty media area in three-column state.
    expect(screen.getByText('Generates after confirmation')).toBeInTheDocument();
  });
});
