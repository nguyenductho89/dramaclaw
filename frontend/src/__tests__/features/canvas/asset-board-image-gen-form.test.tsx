// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { submitFreezoneGen } from '@/api/ops';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import { useCanvasStore } from '@/stores/canvasStore';

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
  fetchFreezoneImageModels: vi.fn(async () => [
    {
      id: 'huimeng/test-image',
      providerId: 'huimeng',
      apiModel: 'test_image_api',
      label: 'Test model',
    },
  ]),
  listFreezoneStyleTemplates: vi.fn(async () => []),
  fetchFreezoneCameraOptions: vi.fn(async () => null),
  listFreezoneGenerationHistory: vi.fn(async () => []),
  submitFreezoneGen: vi.fn(async () => ({
    task_key: 'task-1',
    task_type: 'freezone_gen',
    job_id: 'job-1',
  })),
  fetchFreezoneJobResult: vi.fn(async () => ({ url: '/static/out.png' })),
}));

vi.mock('@/api/tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/tasks')>()),
  awaitTaskCompletion: vi.fn(async () => ({
    result: { output_url: '/static/out.png' },
  })),
}));

function seed(nodes: CanvasNode[]) {
  useCanvasStore.getState().setCanvasData(nodes, []);
}

function emptyImageGenNode(overrides: Partial<CanvasNode['data']> = {}): CanvasNode {
  return {
    id: 'gen-1',
    type: CANVAS_NODE_TYPES.imageGen,
    position: { x: 0, y: 0 },
    data: {
      imageUrl: null,
      prompt: '',
      aspectRatio: '16:9',
      size: '2K',
      displayName: 'Image node 3',
      ...overrides,
    },
  };
}

function detailPanel() {
  return screen.getByRole('region', { name: 'Asset details' });
}

function openDetail(name: string) {
  render(<AssetBoardView visible onLocateNode={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name }));
}

describe('Storyboard detail · image generation form', () => {
  beforeEach(() => {
    vi.mocked(submitFreezoneGen).mockClear();
  });

  it('empty imageGen node: the media area shows the "Generates after confirmation" placeholder, with the full generation form mounted below', () => {
    seed([emptyImageGenNode()]);
    openDetail('Image node 3');

    const detail = detailPanel();
    // Empty-state placeholder (no large image to enlarge).
    expect(within(detail).getAllByText('Generates after confirmation').length).toBeGreaterThan(0);
    expect(within(detail).queryByRole('button', { name: 'View enlarged' })).not.toBeInTheDocument();
    // Generation bar: Style / Asset library chips + prompt input + params + translate + submit.
    expect(within(detail).getByRole('button', { name: 'Style' })).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: /Asset library/ })).toBeInTheDocument();
    // The prompt editor is contenteditable, and its placeholder goes through data-placeholder + ::before.
    expect(
      detail.querySelector('[data-placeholder="Describe the image you want, use @ to reference assets"]'),
    ).not.toBeNull();
    expect(within(detail).getByRole('button', { name: 'Generate' })).toBeInTheDocument();
  });

  it('with a prompt -> clicking submit goes through the real submission chain (submitFreezoneGen receives that prompt)', async () => {
    seed([emptyImageGenNode({ prompt: 'A glowing kitten on a snowy night' })]);
    openDetail('Image node 3');

    const submit = within(detailPanel()).getByRole('button', { name: 'Generate' });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() => expect(submitFreezoneGen).toHaveBeenCalled());
    const [project, payload] = vi.mocked(submitFreezoneGen).mock.calls[0];
    expect(project).toBe('demo-project');
    expect(payload.prompt).toBe('A glowing kitten on a snowy night');
    expect(payload.nodeId).toBe('gen-1');
  });

  it('empty prompt and no upstream text -> the submit button is disabled', () => {
    seed([emptyImageGenNode()]);
    openDetail('Image node 3');

    expect(within(detailPanel()).getByRole('button', { name: 'Generate' })).toBeDisabled();
  });

  it('an imageGen node with output still mounts the form, and no longer renders the read-only prompt block twice', () => {
    seed([
      emptyImageGenNode({
        imageUrl: '/static/done.png',
        prompt: 'The prompt of an already generated image',
      }),
    ]);
    openDetail('Image node 3');

    const detail = detailPanel();
    expect(within(detail).getByRole('button', { name: 'View enlarged' })).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'Generate' })).toBeInTheDocument();
    // The read-only block's small heading does not appear -- the prompt is carried only once, by the input in the form.
    expect(within(detail).queryByText('Prompt')).not.toBeInTheDocument();
    // The prompt text appears only once (the one in the form input).
    expect(within(detail).getAllByText('The prompt of an already generated image')).toHaveLength(1);
  });

  it('a non-image-generation node (upload node) detail has no generation form, and the read-only prompt block stays as before', () => {
    seed([
      {
        id: 'up-1',
        type: CANVAS_NODE_TYPES.upload,
        position: { x: 0, y: 0 },
        data: { imageUrl: '/static/up.png', aspectRatio: '1:1', displayName: 'Character reference' },
      },
      {
        id: 'edit-1',
        type: CANVAS_NODE_TYPES.imageEdit,
        position: { x: 200, y: 0 },
        data: {
          imageUrl: '/static/edit.png',
          prompt: 'Change the background to a snowy night',
          aspectRatio: '1:1',
          displayName: 'Edit image',
        },
      },
    ]);
    render(<AssetBoardView visible onLocateNode={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Character reference' }));
    expect(within(detailPanel()).queryByRole('button', { name: 'Generate' })).not.toBeInTheDocument();
    expect(within(detailPanel()).queryByRole('button', { name: /Asset library/ })).not.toBeInTheDocument();

    // imageEdit has its own set of forms (a later slice), not wired in this slice: it is still a read-only prompt display.
    fireEvent.click(screen.getByRole('button', { name: 'Edit image' }));
    expect(within(detailPanel()).queryByRole('button', { name: 'Generate' })).not.toBeInTheDocument();
    expect(within(detailPanel()).getByText('Prompt')).toBeInTheDocument();
    expect(within(detailPanel()).getByText('Change the background to a snowy night')).toBeInTheDocument();
  });

  it('imageGen own reference image (referenceImageUrl, no upstream) -> the form area additionally shows an own-reference chip, without going through the bottom read-only row', () => {
    seed([
      emptyImageGenNode({
        imageUrl: '/static/done.png',
        referenceImageUrl: '/static/own-ref.png',
        displayName: 'Node with a reference image',
      }),
    ]);
    openDetail('Node with a reference image');

    const detail = detailPanel();
    // Generation form present -> the bottom "Reference assets" read-only row is dropped (avoids duplicating the form chip).
    expect(within(detail).queryByRole('group', { name: 'Reference assets' })).not.toBeInTheDocument();
    // The shared form does not render the own reference image, so the host adds one chip in the form area (using referenceImageUrl),
    // making sure the own reference image does not disappear because the bottom row is hidden.
    const ownRef = within(detail).getByAltText('Reference image');
    expect(ownRef).toHaveAttribute('src', '/static/own-ref.png');
  });

  it('the "Remove reference image" of the own-reference chip in the form area -> clears referenceImageUrl, and the chip disappears', () => {
    seed([
      emptyImageGenNode({
        imageUrl: '/static/done.png',
        referenceImageUrl: '/static/own-ref.png',
        displayName: 'Node with a reference image',
      }),
    ]);
    openDetail('Node with a reference image');

    const detail = detailPanel();
    expect(within(detail).getByAltText('Reference image')).toBeInTheDocument();
    // The remove button only shows on hover (display:none), so grab it directly by title and click.
    fireEvent.click(within(detail).getByTitle('Remove reference image'));

    expect(within(detail).queryByAltText('Reference image')).not.toBeInTheDocument();
    const node = useCanvasStore.getState().nodes.find((candidate) => candidate.id === 'gen-1');
    expect((node?.data as { referenceImageUrl?: string | null }).referenceImageUrl).toBeNull();
  });

  it('imageGen with upstream references -> the bottom read-only row does not appear, and references are carried only by form chips (no duplication)', () => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'up-ref',
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 0, y: 0 },
          data: { imageUrl: '/static/up-ref.png', aspectRatio: '1:1', displayName: 'Upstream reference' },
        },
        emptyImageGenNode({ imageUrl: '/static/done.png', prompt: 'Generated', displayName: 'Image node 3' }),
      ],
      [{ id: 'e-up', source: 'up-ref', target: 'gen-1' }],
    );
    render(<AssetBoardView visible onLocateNode={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Image node 3' }));

    const detail = detailPanel();
    // Generation form present -> no bottom "Reference assets" read-only row.
    expect(within(detail).queryByRole('group', { name: 'Reference assets' })).not.toBeInTheDocument();
    // The upstream reference appears as a form reference chip (chip container title="From upstream · Upstream reference").
    expect(within(detail).getByTitle('From upstream · Upstream reference')).toBeInTheDocument();
  });

  it('the image card empty placeholder text matches the detail', () => {
    seed([emptyImageGenNode()]);
    render(<AssetBoardView visible onLocateNode={() => {}} />);

    // The image card's empty media area in three-column state.
    expect(screen.getByText('Generates after confirmation')).toBeInTheDocument();
  });
});
