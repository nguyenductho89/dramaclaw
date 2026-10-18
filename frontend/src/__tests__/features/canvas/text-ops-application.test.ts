// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

const ensureBackendImageUrl = vi.hoisted(() => vi.fn());
const submitFreezoneReversePrompt = vi.hoisted(() => vi.fn());
const fetchFreezoneReversePromptResult = vi.hoisted(() => vi.fn());
const submitFreezoneVideoGen = vi.hoisted(() => vi.fn());
const submitFreezoneAnalyzeVideoStory = vi.hoisted(() => vi.fn());
const awaitTaskCompletion = vi.hoisted(() => vi.fn());
const readUrl = vi.hoisted(() => vi.fn());

vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureBackendImageUrl,
  submitFreezoneReversePrompt,
  fetchFreezoneReversePromptResult,
  submitFreezoneVideoGen,
  submitFreezoneAnalyzeVideoStory,
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
  resolveTextNodeUpstreamImageUrl,
  resolveUpstreamImageUrl,
  runTextImageToPrompt,
} from '@/features/canvas/application/textImageToPrompt';
import {
  applyTextNodeMode,
  TEXT_TO_MUSIC_DEFAULT_CONTENT,
} from '@/features/canvas/application/textNodeModes';
import { submitTextToVideo } from '@/features/canvas/application/textToVideoSubmit';
import { reanalyzeVideoStory } from '@/features/canvas/application/videoAnalyzeStory';

function nodeById(id: string | null | undefined) {
  return useCanvasStore.getState().nodes.find((node) => node.id === id);
}

function hasEdge(source: string, target: string | null | undefined) {
  return useCanvasStore
    .getState()
    .edges.some((edge) => edge.source === source && edge.target === target);
}

function seedTextNode(extraData: Record<string, unknown> = {}) {
  const nodes: CanvasNode[] = [
    {
      id: 'txt-1',
      type: CANVAS_NODE_TYPES.textAnnotation,
      position: { x: 400, y: 200 },
      data: { content: 'Old train station on a rainy night', ...extraData },
    } as CanvasNode,
  ];
  useCanvasStore.getState().setCanvasData(nodes, []);
}

beforeEach(() => {
  vi.clearAllMocks();
  readUrl.mockReturnValue({ project: 'proj-1', canvas: 'canvas-1' });
  seedTextNode();
});

describe('textNodeModes (text node capability derivation)', () => {
  it('textToVideo: switches mode + creates a downstream video node and wires the edge, carrying the body into the prompt', () => {
    const result = applyTextNodeMode('txt-1', 'textToVideo');

    expect(result.enterEdit).toBe(false);
    expect(nodeById('txt-1')?.data.mode).toBe('textToVideo');
    expect(nodeById(result.spawnedNodeId)).toMatchObject({
      type: CANVAS_NODE_TYPES.video,
      data: expect.objectContaining({ genMode: 'textToVideo', prompt: 'Old train station on a rainy night' }),
    });
    expect(hasEdge('txt-1', result.spawnedNodeId)).toBe(true);
  });

  it('imageToPrompt: creates an image-only upload node upstream, with the edge directed upload -> text', () => {
    const result = applyTextNodeMode('txt-1', 'imageToPrompt');

    expect(nodeById('txt-1')?.data.mode).toBe('imageToPrompt');
    expect(nodeById(result.spawnedNodeId)).toMatchObject({
      type: CANVAS_NODE_TYPES.upload,
      data: expect.objectContaining({ imageOnly: true }),
    });
    // The upstream lands left of the text node (smaller x), the opposite direction from downstream derivation.
    expect(nodeById(result.spawnedNodeId)!.position.x).toBeLessThan(400);
    expect(hasEdge(result.spawnedNodeId!, 'txt-1')).toBe(true);
  });

  it('textToMusic / textToMusicGen: derives an audio node, and the music tier also switches this node back to writing and prefills the description', () => {
    const speech = applyTextNodeMode('txt-1', 'textToMusic');
    expect(nodeById(speech.spawnedNodeId)).toMatchObject({
      type: CANVAS_NODE_TYPES.audio,
      data: expect.objectContaining({ audioKind: 'speech' }),
    });
    expect(nodeById('txt-1')?.data.mode).toBe('textToMusic');

    seedTextNode();
    const music = applyTextNodeMode('txt-1', 'textToMusicGen');
    expect(music.enterEdit).toBe(true);
    expect(nodeById(music.spawnedNodeId)?.data.audioKind).toBe('music');
    // Derive first, write back after: the text node returns to writing + closes the picker + prefills the default music description.
    expect(nodeById('txt-1')?.data).toMatchObject({
      mode: 'writing',
      pickerDismissed: true,
      content: TEXT_TO_MUSIC_DEFAULT_CONTENT,
    });
  });

  it('writing: only switches mode and derives no node', () => {
    const before = useCanvasStore.getState().nodes.length;
    const result = applyTextNodeMode('txt-1', 'writing');

    expect(result).toEqual({ spawnedNodeId: null, enterEdit: true });
    expect(useCanvasStore.getState().nodes).toHaveLength(before);
  });
});

describe('textImageToPrompt (reverse an image into a prompt)', () => {
  it('resolveUpstreamImageUrl fallback order: imageUrl -> previewImageUrl -> referenceImageUrl', () => {
    expect(resolveUpstreamImageUrl({ imageUrl: 'a', previewImageUrl: 'b' })).toBe('a');
    expect(resolveUpstreamImageUrl({ previewImageUrl: 'b', referenceImageUrl: 'c' })).toBe('b');
    expect(resolveUpstreamImageUrl({ referenceImageUrl: 'c' })).toBe('c');
    expect(resolveUpstreamImageUrl({})).toBeNull();
    expect(resolveUpstreamImageUrl(undefined)).toBeNull();
  });

  it('successful submit -> the reversed result is filled back into the text node\'s own content (no new node)', async () => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'img-1',
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 0, y: 0 },
          data: { previewImageUrl: '/static/ref.png' },
        } as CanvasNode,
        {
          id: 'txt-1',
          type: CANVAS_NODE_TYPES.textAnnotation,
          position: { x: 400, y: 0 },
          data: { mode: 'imageToPrompt' },
        } as CanvasNode,
      ],
      [{ id: 'e1', source: 'img-1', target: 'txt-1' }],
    );
    expect(resolveTextNodeUpstreamImageUrl('txt-1')).toBe('/static/ref.png');

    ensureBackendImageUrl.mockResolvedValue('/static/ref.png');
    submitFreezoneReversePrompt.mockResolvedValue({
      task_key: 'tk',
      task_type: 'freezone_image_reverse_prompt',
      job_id: 'job-1',
    });
    awaitTaskCompletion.mockResolvedValue({ result: {} });
    fetchFreezoneReversePromptResult.mockResolvedValue({ prompt: 'A rainy-night photo' });

    const before = useCanvasStore.getState().nodes.length;
    const result = await runTextImageToPrompt('txt-1');

    expect(result).toEqual({ prompt: 'A rainy-night photo', error: null });
    expect(useCanvasStore.getState().nodes).toHaveLength(before);
    expect(nodeById('txt-1')?.data).toMatchObject({
      content: 'A rainy-night photo',
      isGenerating: false,
      generationStartedAt: null,
    });
  });

  it('no upstream image -> errors directly, with no submit and no loading state', async () => {
    const result = await runTextImageToPrompt('txt-1');

    expect(result.error).toBe('No upstream image to reverse into a prompt');
    expect(submitFreezoneReversePrompt).not.toHaveBeenCalled();
    expect(nodeById('txt-1')?.data.isGenerating).not.toBe(true);
  });
});

describe('textToVideoSubmit (text-to-video submission)', () => {
  function seedTextToVideoGraph(videoData: Record<string, unknown> = {}) {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'txt-1',
          type: CANVAS_NODE_TYPES.textAnnotation,
          position: { x: 0, y: 0 },
          data: { mode: 'textToVideo', content: 'Old train station on a rainy night' },
        } as CanvasNode,
        {
          id: 'vid-1',
          type: CANVAS_NODE_TYPES.video,
          position: { x: 600, y: 0 },
          data: { genMode: 'textToVideo', ...videoData },
        } as CanvasNode,
      ],
      [{ id: 'e1', source: 'txt-1', target: 'vid-1' }],
    );
  }

  it('parameters are read from the downstream video node, and the result is filled back into that node', async () => {
    seedTextToVideoGraph({
      aspectRatio: '9:16',
      quality: '1080P',
      durationSec: 8,
      generateAudio: true,
      model: 'model-x',
    });
    submitFreezoneVideoGen.mockResolvedValue({
      task_key: 'tk',
      task_type: 'freezone_video_gen',
      job_id: 'job-1',
    });
    awaitTaskCompletion.mockResolvedValue({ result: { video_url: '/static/out.mp4' } });

    const result = await submitTextToVideo('txt-1', {
      content: 'Old train station on a rainy night',
      fallbackModelId: 'fallback-model',
    });

    expect(result).toEqual({ nodeIds: ['vid-1'], error: null });
    expect(submitFreezoneVideoGen.mock.calls[0][1]).toMatchObject({
      prompt: 'Old train station on a rainy night',
      aspectRatio: '9:16',
      resolution: '1080p',
      durationSeconds: 8,
      generateAudio: true,
      model: 'model-x',
      nodeId: 'vid-1',
    });
    expect(nodeById('vid-1')?.data).toMatchObject({
      videoUrl: '/static/out.mp4',
      isGenerating: false,
    });
  });

  it('a video node with no model selected -> uses the caller\'s fallback id; default aspect/quality fall back to 16:9 / 720p', async () => {
    // model is explicitly set to an empty string (the node default would fill a model id, and without clearing it the fallback branch is never reached).
    seedTextToVideoGraph({ model: '' });
    submitFreezoneVideoGen.mockResolvedValue({
      task_key: 'tk',
      task_type: 'freezone_video_gen',
      job_id: 'job-1',
    });
    awaitTaskCompletion.mockResolvedValue({ result: { url: '/static/out.mp4' } });

    await submitTextToVideo('txt-1', {
      content: 'Old train station on a rainy night',
      fallbackModelId: 'fallback-model',
    });

    expect(submitFreezoneVideoGen.mock.calls[0][1]).toMatchObject({
      aspectRatio: '16:9',
      resolution: '720p',
      durationSeconds: 5,
      model: 'fallback-model',
    });
  });

  it('an empty body is not submitted; no downstream video node -> errors without submitting', async () => {
    seedTextToVideoGraph();
    expect(
      await submitTextToVideo('txt-1', { content: '   ', fallbackModelId: 'm' }),
    ).toEqual({ nodeIds: [], error: null });

    seedTextNode({ mode: 'textToVideo' });
    const orphan = await submitTextToVideo('txt-1', { content: 'x', fallbackModelId: 'm' });
    expect(orphan.error).toBe('No downstream video node to hold the result');
    expect(submitFreezoneVideoGen).not.toHaveBeenCalled();
  });

  it('submit failure -> clears the loading state and returns the first error reason to the caller', async () => {
    seedTextToVideoGraph();
    submitFreezoneVideoGen.mockRejectedValue(new Error('Insufficient credits'));

    const result = await submitTextToVideo('txt-1', {
      content: 'Old train station on a rainy night',
      fallbackModelId: 'm',
    });

    expect(result.error).toBe('Insufficient credits');
    expect(nodeById('vid-1')?.data).toMatchObject({
      isGenerating: false,
      generationStartedAt: null,
    });
  });
});

describe('reanalyzeVideoStory (re-analyze a video story)', () => {
  function seedStoryNode(data: Record<string, unknown> = {}) {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'story-1',
          type: CANVAS_NODE_TYPES.videoStory,
          position: { x: 0, y: 0 },
          data: {
            sourceVideoUrl: '/static/src.mp4',
            rows: [{ shotNumber: 1, visualDescription: 'Old' }],
            ...data,
          },
        } as CanvasNode,
      ],
      [],
    );
  }

  it('reuses the current story node: no new node, no new edge, and the result overwrites in place', async () => {
    seedStoryNode();
    submitFreezoneAnalyzeVideoStory.mockResolvedValue({
      task_key: 'tk',
      job_id: 'job-1',
    });
    awaitTaskCompletion.mockResolvedValue({
      result: { shots: [{ shot_number: 1, visual_description: 'New' }] },
    });

    const before = useCanvasStore.getState().nodes.length;
    const result = reanalyzeVideoStory('story-1');
    expect(result?.nodeId).toBe('story-1');
    // It should be set to analyzing in the synchronous phase (the detail button turns into a spinner accordingly).
    expect(nodeById('story-1')?.data.isAnalyzing).toBe(true);
    await result?.completion;

    expect(useCanvasStore.getState().nodes).toHaveLength(before);
    expect(useCanvasStore.getState().edges).toHaveLength(0);
    expect(submitFreezoneAnalyzeVideoStory.mock.calls[0][1]).toMatchObject({
      videoUrl: '/static/src.mp4',
    });
    expect(nodeById('story-1')?.data).toMatchObject({
      isAnalyzing: false,
      analysisError: null,
    });
    expect((nodeById('story-1')?.data.rows as unknown[]).length).toBeGreaterThan(0);
  });

  it('the node did not remember the source clip -> returns null without submitting', () => {
    seedStoryNode({ sourceVideoUrl: null });

    expect(reanalyzeVideoStory('story-1')).toBeNull();
    expect(submitFreezoneAnalyzeVideoStory).not.toHaveBeenCalled();
  });

  it('failure -> the error is written back to the story node itself and the loading state is cleared', async () => {
    seedStoryNode();
    submitFreezoneAnalyzeVideoStory.mockRejectedValue(new Error('Analysis service unavailable'));

    const result = reanalyzeVideoStory('story-1');
    await result?.completion;

    expect(nodeById('story-1')?.data).toMatchObject({
      isAnalyzing: false,
      analysisError: 'Analysis service unavailable',
    });
  });
});
