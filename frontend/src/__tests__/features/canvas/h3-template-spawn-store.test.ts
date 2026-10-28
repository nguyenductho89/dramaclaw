// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from 'vitest';

import { spawnH3TemplateInputs } from '@/features/canvas/application/spawnH3TemplateRun';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  H3_PROMPT_TEMPLATES,
  h3TemplateGenMode,
  h3TemplateRunnablePrompt,
  type H3PromptTemplate,
} from '@/features/canvas/domain/h3PromptTemplates';
import {
  sortUpstreamByReferenceOrder,
  upstreamNodesInEdgeOrder,
} from '@/features/canvas/nodes/referenceOrdering';
import { useCanvasStore } from '@/stores/canvasStore';

const VIDEO_ID = 'video-1';

function seedVideoNode(extra: Record<string, unknown> = {}) {
  const video: CanvasNode = {
    id: VIDEO_ID,
    type: CANVAS_NODE_TYPES.video,
    position: { x: 1200, y: 300 },
    data: { prompt: '', aspectRatio: '16:9', displayName: 'Video1', ...extra },
  } as CanvasNode;
  useCanvasStore.setState({ nodes: [video], edges: [] });
}

function apply(template: H3PromptTemplate) {
  const state = useCanvasStore.getState();
  const self = state.nodes.find((node) => node.id === VIDEO_ID)!;
  return spawnH3TemplateInputs(
    { id: VIDEO_ID, position: self.position, height: 380 },
    template,
    { genMode: h3TemplateGenMode(template) },
    {
      addNode: state.addNode,
      addEdge: state.addEdge,
      updateNodeData: (id, patch) => state.updateNodeData(id, patch),
      autoGroupSpawn: (source, spawned, opts) => state.autoGroupSpawn(source, spawned, opts),
    },
  );
}

function template(id: string): H3PromptTemplate {
  return H3_PROMPT_TEMPLATES.find((item) => item.id === id)!;
}

function videoData() {
  return useCanvasStore.getState().nodes.find((node) => node.id === VIDEO_ID)!.data as Record<string, unknown>;
}

describe('H3 template spawn against the real canvas store', () => {
  beforeEach(() => seedVideoNode());

  it('ref2va: 4 pictures become 4 image nodes whose edge order matches <Picture N>', () => {
    const t = template('fal_desert_fashion');
    const result = apply(t);
    const { nodes, edges } = useCanvasStore.getState();

    expect(result.rejectedNodeIds).toEqual([]);
    expect(result.imageNodeIds).toHaveLength(4);
    const upstream = sortUpstreamByReferenceOrder(
      upstreamNodesInEdgeOrder(nodes, edges, VIDEO_ID),
      videoData().referenceOrder as string[],
    );
    expect(upstream.map((node) => node.id)).toEqual(result.imageNodeIds);
    expect(upstream.map((node) => (node.data as { prompt: string }).prompt)).toEqual(
      t.inputs.map((input) => input.imagePrompt),
    );
    expect(videoData()).toMatchObject({
      genMode: 'imageReference',
      aspectRatio: '16:9',
      durationSec: 12,
      prompt: h3TemplateRunnablePrompt(t),
    });
  });

  it('fl2va: a single first-frame image node and firstFrame mode', () => {
    const result = apply(template('fal_space_opera'));
    expect(result.imageNodeIds).toHaveLength(1);
    expect(videoData().genMode).toBe('firstFrame');
  });

  it('flf2va: two image nodes (first and last frame) and firstLastFrame mode', () => {
    const result = apply(template('fal_otome_transition'));
    expect(result.imageNodeIds).toHaveLength(2);
    expect(videoData().genMode).toBe('firstLastFrame');
  });

  it('audio template: the audio node connects after the pictures', () => {
    const result = apply(template('voice_cloned_narration'));
    const { nodes } = useCanvasStore.getState();
    expect(result.rejectedNodeIds).toEqual([]);
    expect(result.audioNodeIds).toHaveLength(1);
    expect(nodes.find((node) => node.id === result.audioNodeIds[0])?.type).toBe(CANVAS_NODE_TYPES.audio);
    expect(videoData().referenceOrder).toEqual([...result.imageNodeIds, ...result.audioNodeIds]);
  });

  it('applying a second template replaces the prompt and mode, and clears the camera move', () => {
    seedVideoNode({ cameraMovement: 'dolly_in' });
    apply(template('fal_desert_fashion'));
    apply(template('fal_gallery_poster'));
    expect(videoData()).toMatchObject({ genMode: 'firstFrame', aspectRatio: '9:16', durationSec: 8, cameraMovement: null });
    expect(videoData().prompt).toBe(h3TemplateRunnablePrompt(template('fal_gallery_poster')));
  });

  it('spawned image nodes are marked and placed left of the video node', () => {
    const result = apply(template('fal_binocular_film'));
    const { nodes } = useCanvasStore.getState();
    for (const id of result.imageNodeIds) {
      const node = nodes.find((item) => item.id === id)!;
      expect((node.data as { h3TemplateInput?: boolean }).h3TemplateInput).toBe(true);
      expect(node.position.x).toBeLessThan(1200);
    }
  });

  it.each(H3_PROMPT_TEMPLATES.map((item) => [item.id, item] as const))(
    '%s connects every input without the reference limit rejecting any',
    (_id, t) => {
      seedVideoNode();
      const result = apply(t);
      expect(result.rejectedNodeIds).toEqual([]);
      const incoming = useCanvasStore.getState().edges.filter((edge) => edge.target === VIDEO_ID);
      expect(incoming).toHaveLength(t.inputs.length);
    },
  );
});
