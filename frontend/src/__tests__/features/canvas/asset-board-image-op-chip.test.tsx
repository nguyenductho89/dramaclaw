// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { submitFreezoneTemplateEdit } from '@/api/ops';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import { useCanvasStore } from '@/stores/canvasStore';

vi.mock('@/lib/queries/generation-credit-cost', () => ({
  useGenerationCreditCost: () => ({ data: undefined }),
}));

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
  submitFreezoneTemplateEdit: vi.fn(async () => ({
    task_key: 'task-1',
    task_type: 'freezone_template_edit',
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

const SOURCE_NODE: CanvasNode = {
  id: 'src-1',
  type: CANVAS_NODE_TYPES.upload,
  position: { x: 0, y: 0 },
  data: {
    imageUrl: '/static/source.png',
    aspectRatio: '16:9',
    displayName: 'Source image',
  },
};

function detailPanel() {
  return screen.getByRole('region', { name: 'Asset details' });
}

function nodeData(nodeId: string): Record<string, unknown> {
  const node = useCanvasStore.getState().nodes.find((candidate) => candidate.id === nodeId);
  return (node?.data ?? {}) as Record<string, unknown>;
}

function spawnedOpNode(): CanvasNode {
  const spawned = useCanvasStore
    .getState()
    .nodes.find((candidate) => candidate.id !== SOURCE_NODE.id);
  if (!spawned) throw new Error('The feature node was not created');
  return spawned;
}

function promptEditor(): HTMLElement {
  const editor = detailPanel().querySelector('.prompt-mention-editor');
  if (!(editor instanceof HTMLElement)) throw new Error('The prompt input did not render');
  return editor;
}

function opChip(): HTMLElement {
  return within(detailPanel()).getByTitle(/click to switch feature, Backspace to remove/);
}

/** Collapse the caret to right after the chip -- where the user's finger is when they want to delete it. */
function putCaretAfterChip(): void {
  const host = promptEditor().querySelector('[data-lead-chip]');
  if (!host) throw new Error('The chip host node is not inside the input');
  const range = document.createRange();
  range.setStartAfter(host);
  range.collapse(true);
  const selection = window.getSelection();
  if (!selection) throw new Error('The environment has no Selection');
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Open the source image detail -> expand the "Grid templates" dropdown -> click a feature. */
async function pickGridOp(label: string) {
  const user = userEvent.setup();
  useCanvasStore.getState().setCanvasData([SOURCE_NODE], []);
  render(<AssetBoardView visible onLocateNode={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Source image' }));
  await user.click(within(detailPanel()).getByRole('button', { name: 'Grid' }));
  await user.click(await screen.findByRole('menuitem', { name: new RegExp(label) }));
  return user;
}

describe('Storyboard · feature chip (click a feature to create a node -> generate after confirmation)', () => {
  beforeEach(() => {
    vi.mocked(submitFreezoneTemplateEdit).mockClear();
  });

  it('clicking a feature only creates a node without submitting: the new node is imageGen, its name = the feature name, and it remembers the source image and wires the edge', async () => {
    await pickGridOp('Multi-Camera 3x3');

    const spawned = spawnedOpNode();
    expect(spawned.type).toBe(CANVAS_NODE_TYPES.imageGen);
    const data = spawned.data as Record<string, unknown>;
    expect(data.displayName).toBe('Multi-Camera 3x3');
    expect(data.imageOpKey).toBe('multiCameraGrid');
    expect(data.imageOpSourceUrl).toBe('/static/source.png');
    expect(data.isGenerating).toBe(false);
    // Wired downstream of the source node.
    expect(
      useCanvasStore
        .getState()
        .edges.some((edge) => edge.source === SOURCE_NODE.id && edge.target === spawned.id),
    ).toBe(true);
    // Key point: this step does not submit.
    expect(submitFreezoneTemplateEdit).not.toHaveBeenCalled();
  });

  it('the chip sits inside the prompt input: the feature description acts as the placeholder and does not leak into the prompt', async () => {
    await pickGridOp('Character Three-View');
    const spawnedId = spawnedOpNode().id;

    const editor = promptEditor();
    // The chip is an inline block inside the input, not a separate control row above the input.
    expect(editor.contains(opChip())).toBe(true);
    // The feature description is the placeholder (on the same line, right of the chip).
    expect(editor.getAttribute('data-placeholder')).toContain(
      'Click to generate: create a complete character three-view straight from the current image; text/reference images are supported.',
    );

    // The chip is only a display node: what the user types is the prompt, and the chip text is not serialized into it.
    editor.appendChild(document.createTextNode('Make the side profile clearer'));
    fireEvent.input(editor);
    expect(nodeData(spawnedId).prompt).toBe('Make the side profile clearer');
  });

  it('an empty prompt can still be submitted (the up arrow uses the matching template, and prompt falls back to the feature name)', async () => {
    await pickGridOp('Product Three-View');

    const submit = within(detailPanel()).getByRole('button', { name: 'Generate' });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() => expect(submitFreezoneTemplateEdit).toHaveBeenCalled());
    const [project, payload] = vi.mocked(submitFreezoneTemplateEdit).mock.calls[0];
    expect(project).toBe('demo-project');
    expect(payload.sourceUrl).toBe('/static/source.png');
    expect(payload.mode).toBe('product_three_view');
    expect(payload.prompt).toBe('Product Three-View');
    // The result is filled back into the feature node itself instead of creating another result node.
    await waitFor(() => expect(nodeData(spawnedOpNode().id).imageUrl).toBe('/static/out.png'));
    expect(useCanvasStore.getState().nodes).toHaveLength(2);
  });

  it('scene setting sheet: reachable in the "Design sheets" column of the feature box, and submit goes through the scene_setting_sheet template', async () => {
    const user = await pickGridOp('Multi-Camera 3x3');
    const spawnedId = spawnedOpNode().id;

    await user.click(opChip());
    await user.click(screen.getByRole('button', { name: /^Scene Setting Sheet/ }));
    expect(nodeData(spawnedId).imageOpKey).toBe('sceneSettingSheet');
    expect(nodeData(spawnedId).displayName).toBe('Scene Setting Sheet');

    fireEvent.click(within(detailPanel()).getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(submitFreezoneTemplateEdit).toHaveBeenCalled());
    const [, payload] = vi.mocked(submitFreezoneTemplateEdit).mock.calls[0];
    expect(payload.mode).toBe('scene_setting_sheet');
    expect(payload.prompt).toBe('Scene Setting Sheet');
  });

  it('clicking the chip expands the feature box (four columns), and choosing another feature -> the key and node name change together', async () => {
    const user = await pickGridOp('Plot Progression 2x2');
    const spawnedId = spawnedOpNode().id;

    await user.click(opChip());
    for (const category of ['Storyboard narrative', 'Space & camera', 'Design sheets', 'Texture tuning']) {
      expect(await screen.findByText(category)).toBeInTheDocument();
    }
    // Each row is "feature name + one-line description", so match by name prefix.
    await user.click(screen.getByRole('button', { name: /^Panorama/ }));

    expect(nodeData(spawnedId).imageOpKey).toBe('scene360');
    expect(nodeData(spawnedId).displayName).toBe('Panorama');
  });

  it('Backspace right after the chip deletes it -> degrades to a regular image generation node', async () => {
    await pickGridOp('Cinematic Light Grading');
    const spawnedId = spawnedOpNode().id;

    putCaretAfterChip();
    fireEvent.keyDown(promptEditor(), { key: 'Backspace' });

    expect(nodeData(spawnedId).imageOpKey).toBeNull();
    expect(within(detailPanel()).queryByTitle(/click to switch feature, Backspace to remove/)).not.toBeInTheDocument();
    expect(promptEditor().querySelector('[data-lead-chip]')).toBeNull();
    // Back to regular text-to-image: an empty prompt disables submit again.
    expect(within(detailPanel()).getByRole('button', { name: 'Generate' })).toBeDisabled();
  });
});
