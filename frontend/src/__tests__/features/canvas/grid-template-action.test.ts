// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

const submitFreezoneTemplateEdit = vi.hoisted(() => vi.fn());
const fetchFreezoneJobResult = vi.hoisted(() => vi.fn());
const awaitTaskCompletion = vi.hoisted(() => vi.fn());
const readUrl = vi.hoisted(() => vi.fn());

vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  submitFreezoneTemplateEdit,
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
  runAssetBoardImageOp,
  spawnAssetBoardImageOpNode,
} from '@/features/canvas/application/assetBoardImageOps';

const JOB_REF = { task_key: 'tk-1', task_type: 'freezone_template_edit', job_id: 'job-1' };

function seedSourceNode() {
  const nodes: CanvasNode[] = [
    {
      id: 'img-1',
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 0, y: 0 },
      data: { imageUrl: '/static/a.png', aspectRatio: '1:1' },
    } as CanvasNode,
  ];
  useCanvasStore.getState().setCanvasData(nodes, []);
}

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

/**
 * Interaction of the workflow toolbar "Nine-grid" dropdown: exactly the same as the storyboard detail toolbar -- clicking an item only builds
 * a feature node (an empty image generation node, node name = feature name), and the prompt / reference images / ratio are all edited on that
 * node, with submission only on the up arrow. The old "confirm to submit" floating bar (GridActionConfirmOverlay) has been removed.
 */
describe('workflow · grid feature (click a feature to create a node -> only the up arrow submits)', () => {
  beforeEach(() => {
    readUrl.mockReturnValue({ project: 'proj-1', canvas: 'canvas-1' });
    submitFreezoneTemplateEdit.mockReset();
    fetchFreezoneJobResult.mockReset();
    awaitTaskCompletion.mockReset();
    seedSourceNode();
  });

  it('clicking a feature only creates a node without submitting: the new node is imageGen, its name = the feature name, and it remembers the source image and wires the edge', () => {
    const nextNodeId = spawnAssetBoardImageOpNode('img-1', '/static/a.png?sig=x', 'multiCameraGrid');

    const state = useCanvasStore.getState();
    const created = state.nodes.find((node) => node.id === nextNodeId);
    expect(created?.type).toBe(CANVAS_NODE_TYPES.imageGen);
    expect(created?.data).toMatchObject({
      displayName: 'Multi-Camera 3x3',
      imageOpKey: 'multiCameraGrid',
      // The source image, with the signature query stripped, is recorded on the node and submitted from there on the up arrow.
      imageOpSourceUrl: '/static/a.png',
      isGenerating: false,
    });
    expect(
      state.edges.some((edge) => edge.source === 'img-1' && edge.target === nextNodeId),
    ).toBe(true);
    // Key point: this step does not submit.
    expect(submitFreezoneTemplateEdit).not.toHaveBeenCalled();
  });

  it('up-arrow submit: sent with the mode mapped by the feature, and the result is filled back into the feature node itself', async () => {
    submitFreezoneTemplateEdit.mockResolvedValue(JOB_REF);
    awaitTaskCompletion.mockResolvedValue({ result: { output_url: '/static/out.png' } });

    const nextNodeId = spawnAssetBoardImageOpNode('img-1', '/static/a.png', 'sceneSettingSheet');
    await runAssetBoardImageOp(nextNodeId as string);

    expect(submitFreezoneTemplateEdit).toHaveBeenCalledWith('proj-1', {
      sourceUrl: '/static/a.png',
      mode: 'scene_setting_sheet',
      // Empty prompt -> falls back to the feature name.
      prompt: 'Scene Setting Sheet',
    });
    expect(awaitTaskCompletion).toHaveBeenCalledWith('tk-1', 'proj-1');
    // output_url already present -> no more fallback lookup of the job result.
    expect(fetchFreezoneJobResult).not.toHaveBeenCalled();

    const state = useCanvasStore.getState();
    expect(state.nodes.find((node) => node.id === nextNodeId)?.data).toMatchObject({
      imageUrl: '/static/out.png',
      previewImageUrl: '/static/out.png',
      isGenerating: false,
      generationError: null,
    });
    // No extra result node is built: the source image + the feature node, just two.
    expect(state.nodes).toHaveLength(2);
  });

  it('the toolbar dropdown hangs on "create feature node" rather than a confirm floating bar', () => {
    const toolbar = readSource('src/features/canvas/ui/NodeActionToolbar.tsx');
    expect(toolbar).toContain('onSpawnGridActionNode({');
    // Dropdown items no longer carry a prompt / compute cost -- those belong to the confirm floating bar era.
    expect(toolbar).not.toContain('gridMenu.multiCameraGridPrompt');

    const overlay = readSource('src/features/canvas/ui/SelectedNodeOverlay.tsx');
    expect(overlay).toContain('spawnAssetBoardImageOpNode(sourceNode.id, imageSource, request.key)');
    expect(overlay).toContain('selectAndFocusCanvasNode(nextNodeId)');
    expect(overlay).not.toContain('GridActionConfirmOverlay');
  });

  it('the workflow and storyboard generation forms share the same feature props (chip / placeholder text / up arrow goes through the template)', () => {
    for (const host of [
      'src/features/canvas/nodes/ImageGenNode.tsx',
      'src/features/canvas/ui/asset-board/AssetBoardImageGenForm.tsx',
    ]) {
      const source = readSource(host);
      expect(source).toContain('useImageOpFormProps(');
      expect(source).toContain('{...(opFormProps ?? {})}');
    }
  });
});
