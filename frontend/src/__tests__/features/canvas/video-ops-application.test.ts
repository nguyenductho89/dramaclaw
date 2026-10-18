// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

const submitFreezoneVideoCompose = vi.hoisted(() => vi.fn());
const fetchFreezoneJobResult = vi.hoisted(() => vi.fn());
const submitFreezoneAnalyzeVideoStory = vi.hoisted(() => vi.fn());
const submitFreezoneAudioSeparate = vi.hoisted(() => vi.fn());
const fetchFreezoneAudioSeparateResult = vi.hoisted(() => vi.fn());
const uploadFreezoneImage = vi.hoisted(() => vi.fn());
const uploadFreezoneVideo = vi.hoisted(() => vi.fn());
const awaitTaskCompletion = vi.hoisted(() => vi.fn());
const readUrl = vi.hoisted(() => vi.fn());
const ensureWebSafeVideo = vi.hoisted(() => vi.fn());
const captureVideoFrameBlob = vi.hoisted(() => vi.fn());

vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  submitFreezoneVideoCompose,
  fetchFreezoneJobResult,
  submitFreezoneAnalyzeVideoStory,
  submitFreezoneAudioSeparate,
  fetchFreezoneAudioSeparateResult,
  uploadFreezoneImage,
  uploadFreezoneVideo,
}));
vi.mock('@/api/tasks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  awaitTaskCompletion,
}));
vi.mock('@/lib/url-params', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readUrl,
}));
vi.mock('@/features/canvas/application/videoTranscode', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureWebSafeVideo,
}));
// Frame capture needs a browser that can really decode (a <video> under jsdom never fires loadeddata), so it is stubbed out wholesale,
// verifying only the capture orchestration itself (capture -> upload -> create node -> wire edge -> write title).
vi.mock('@/features/canvas/application/videoFrameBlob', () => ({ captureVideoFrameBlob }));

import { analyzeVideoStory } from '@/features/canvas/application/videoAnalyzeStory';
import {
  submitVideoClip,
  videoClipNoUrlMessage,
} from '@/features/canvas/application/videoClipSubmit';
import { replaceNodeVideo } from '@/features/canvas/application/videoReplaceUpload';
import {
  classifyAudioSeparateResult,
  resolveSeparateBaseName,
  separateVideoAudio,
} from '@/features/canvas/application/videoSeparateAudio';
import {
  captureVideoFrameToNode,
  resolveCaptureSeekSec,
} from '@/features/canvas/application/videoCaptureFrame';
import { computeDisplayedVideoRect } from '@/features/canvas/nodes/shared/subtitleEraseBox';

function seedVideoNode(extraData: Record<string, unknown> = {}) {
  const nodes: CanvasNode[] = [
    {
      id: 'vid-1',
      type: CANVAS_NODE_TYPES.video,
      position: { x: 0, y: 0 },
      data: {
        videoUrl: '/static/src.mp4',
        durationMs: 8000,
        displayName: 'Source video',
        ...extraData,
      },
    } as CanvasNode,
  ];
  useCanvasStore.getState().setCanvasData(nodes, []);
}

function nodeById(id: string | null | undefined) {
  return useCanvasStore.getState().nodes.find((node) => node.id === id);
}

function hasEdge(source: string, target: string | null | undefined) {
  return useCanvasStore
    .getState()
    .edges.some((edge) => edge.source === source && edge.target === target);
}

beforeEach(() => {
  vi.clearAllMocks();
  readUrl.mockReturnValue({ project: 'proj-1', canvas: 'canvas-1' });
  seedVideoNode();
});

describe('videoClipSubmit (clip submission orchestration)', () => {
  it('single-track single-clip submit -> creates a downstream clip video node and wires the edge', async () => {
    submitFreezoneVideoCompose.mockResolvedValue({
      task_key: 'tk',
      task_type: 'freezone_video_compose',
      job_id: 'job-1',
    });
    awaitTaskCompletion.mockResolvedValue({ result: {} });
    fetchFreezoneJobResult.mockResolvedValue({ url: '/static/clip.mp4' });

    const result = await submitVideoClip('vid-1', {
      sourceUrl: '/static/src.mp4',
      startMs: 1000,
      endMs: 3500,
      quality: '1080P',
    });

    expect(result.error).toBeNull();
    const payload = submitFreezoneVideoCompose.mock.calls[0][1];
    expect(payload.resolution).toBe('1080p');
    expect(payload.tracks[0].items[0]).toMatchObject({
      sourceUrl: '/static/src.mp4',
      sourceStart: 1,
      sourceEnd: 3.5,
    });
    expect(nodeById(result.nodeId)?.data).toMatchObject({
      videoUrl: '/static/clip.mp4',
      durationMs: 2500,
      displayName: 'Clip',
    });
    expect(hasEdge('vid-1', result.nodeId)).toBe(true);
  });

  it('a non-1080P source falls back to 720p; a result missing url -> error and no node created', async () => {
    submitFreezoneVideoCompose.mockResolvedValue({
      task_key: 'tk',
      task_type: 'freezone_video_compose',
      job_id: 'job-1',
    });
    awaitTaskCompletion.mockResolvedValue({ result: {} });
    fetchFreezoneJobResult.mockResolvedValue({ url: null });

    const before = useCanvasStore.getState().nodes.length;
    const result = await submitVideoClip('vid-1', {
      sourceUrl: '/static/src.mp4',
      startMs: 0,
      endMs: 2000,
      quality: '480P',
    });

    expect(submitFreezoneVideoCompose.mock.calls[0][1].resolution).toBe('720p');
    expect(result).toEqual({ nodeId: null, error: videoClipNoUrlMessage() });
    expect(useCanvasStore.getState().nodes.length).toBe(before);
  });

  it('invalid range / missing project -> returns directly without submitting', async () => {
    expect(
      await submitVideoClip('vid-1', { sourceUrl: '/static/src.mp4', startMs: 5, endMs: 5 }),
    ).toEqual({ nodeId: null, error: null });
    readUrl.mockReturnValue({ project: null, canvas: null });
    expect(
      await submitVideoClip('vid-1', { sourceUrl: '/static/src.mp4', startMs: 0, endMs: 100 }),
    ).toEqual({ nodeId: null, error: null });
    expect(submitFreezoneVideoCompose).not.toHaveBeenCalled();
  });
});

describe('videoAnalyzeStory (video analysis generates a storyboard story)', () => {
  it('synchronously creates a loading story node -> the normalized result is filled back, and the source node clears isAnalyzing', async () => {
    submitFreezoneAnalyzeVideoStory.mockResolvedValue({ task_key: 'tk-story' });
    awaitTaskCompletion.mockResolvedValue({
      result: { shots: [{ start: 0, end: 2, description: 'Opening' }] },
    });

    const result = analyzeVideoStory('vid-1', { videoUrl: '/static/src.mp4', durationSec: 8 });
    expect(result).not.toBeNull();
    // Without waiting for the backend: the story node is already on the canvas in the loading state.
    expect(nodeById(result?.nodeId)?.type).toBe(CANVAS_NODE_TYPES.videoStory);
    expect(nodeById(result?.nodeId)?.data).toMatchObject({
      sourceVideoUrl: '/static/src.mp4',
      isAnalyzing: true,
    });
    expect(nodeById('vid-1')?.data).toMatchObject({ isAnalyzing: true });
    expect(hasEdge('vid-1', result?.nodeId)).toBe(true);

    await result?.completion;
    expect(submitFreezoneAnalyzeVideoStory).toHaveBeenCalledWith('proj-1', {
      videoUrl: '/static/src.mp4',
      durationSec: 8,
    });
    expect(nodeById(result?.nodeId)?.data).toMatchObject({
      isAnalyzing: false,
      analysisError: null,
    });
    expect(nodeById('vid-1')?.data).toMatchObject({ isAnalyzing: false });
  });

  it('a response without task_key -> treats the response itself as the synchronous result, with no polling', async () => {
    submitFreezoneAnalyzeVideoStory.mockResolvedValue({ shots: [] });
    const result = analyzeVideoStory('vid-1', { videoUrl: '/static/src.mp4' });
    await result?.completion;
    expect(awaitTaskCompletion).not.toHaveBeenCalled();
    expect(nodeById(result?.nodeId)?.data).toMatchObject({ isAnalyzing: false });
  });

  it('failure -> the error is written to both the story node and the source node', async () => {
    submitFreezoneAnalyzeVideoStory.mockRejectedValue(new Error('analyze boom'));
    const result = analyzeVideoStory('vid-1', { videoUrl: '/static/src.mp4' });
    await result?.completion;
    expect(nodeById(result?.nodeId)?.data).toMatchObject({
      isAnalyzing: false,
      analysisError: 'analyze boom',
    });
    expect(nodeById('vid-1')?.data).toMatchObject({ analysisError: 'analyze boom' });
  });

  it('missing project -> returns null and creates no node', () => {
    readUrl.mockReturnValue({ project: null, canvas: null });
    const before = useCanvasStore.getState().nodes.length;
    expect(analyzeVideoStory('vid-1', { videoUrl: '/static/src.mp4' })).toBeNull();
    expect(useCanvasStore.getState().nodes.length).toBe(before);
  });
});

describe('videoSeparateAudio (separate audio and video)', () => {
  it('classify prefers the canonical *_url fields', () => {
    expect(
      classifyAudioSeparateResult({
        audio_path: '/data/output/u/p/a.mp3',
        audio_url: '/static/projects/p/a.mp3',
        mute_video_url: '/static/projects/p/mute.mp4',
      }),
    ).toEqual({ audio: '/static/projects/p/a.mp3', video: '/static/projects/p/mute.mp4' });
  });

  it('classify falls back to traversing and picking by extension, preferring already directly accessible addresses', () => {
    expect(
      classifyAudioSeparateResult({
        nested: { a: '/data/output/u/p/track.mp3', b: 'https://cdn/x/track.mp3' },
        v: 'https://cdn/x/silent.mp4',
      }),
    ).toEqual({ audio: 'https://cdn/x/track.mp3', video: 'https://cdn/x/silent.mp4' });
    expect(classifyAudioSeparateResult(null)).toEqual({ audio: null, video: null });
  });

  it('resolveSeparateBaseName: source file name > display name > video, with the extension stripped', () => {
    expect(resolveSeparateBaseName({ sourceFileName: 'a.mov', displayName: 'b' })).toBe('a');
    expect(resolveSeparateBaseName({ displayName: 'Shot 1' })).toBe('Shot 1');
    expect(resolveSeparateBaseName({})).toBe('video');
  });

  it('success -> creates an audio node and a silent video node, wires the edges, and finally clears isSeparatingAv', async () => {
    seedVideoNode({ sourceFileName: 'shot.mp4' });
    submitFreezoneAudioSeparate.mockResolvedValue({ task_key: 'tk-av', job_id: 'job-av' });
    awaitTaskCompletion.mockResolvedValue({
      result: { audio_url: '/static/a.mp3', mute_video_url: '/static/mute.mp4' },
    });

    const result = await separateVideoAudio('vid-1', { sourceUrl: '/static/src.mp4' });

    expect(result.error).toBeNull();
    expect(nodeById(result.audioNodeId)?.type).toBe(CANVAS_NODE_TYPES.audio);
    expect(nodeById(result.audioNodeId)?.data).toMatchObject({
      audioUrl: '/static/a.mp3',
      displayName: 'shot_background_audio',
    });
    expect(nodeById(result.videoNodeId)?.data).toMatchObject({
      videoUrl: '/static/mute.mp4',
      displayName: 'shot_silent',
      sourceFileName: 'shot_silent.mp4',
    });
    // The silent video is video->video and connects. The audio node deliberately gets no edge (user decision): in the store's
    // upstream whitelist audio accepts only textAnnotation, so a video->audio edge would be rejected anyway -- rather than
    // quietly calling an addEdge that is bound to fail, it is better not to call it; the audio node is still built normally and relies on
    // findNodePosition to land near the source, just without an incoming edge.
    expect(hasEdge('vid-1', result.videoNodeId)).toBe(true);
    expect(result.audioNodeId).not.toBeNull();
    expect(hasEdge('vid-1', result.audioNodeId)).toBe(false);
    expect(
      useCanvasStore.getState().edges.some((edge) => edge.target === result.audioNodeId),
    ).toBe(false);
    expect(nodeById('vid-1')?.data).toMatchObject({ isSeparatingAv: false });
  });

  it('an SSE result missing addresses -> falls back to the job result endpoint', async () => {
    submitFreezoneAudioSeparate.mockResolvedValue({ task_key: 'tk-av', job_id: 'job-av' });
    awaitTaskCompletion.mockResolvedValue({ result: {} });
    fetchFreezoneAudioSeparateResult.mockResolvedValue({
      audio_url: '/static/fb.mp3',
      mute_video_url: '/static/fb.mp4',
    });

    const result = await separateVideoAudio('vid-1', { sourceUrl: '/static/src.mp4' });
    expect(fetchFreezoneAudioSeparateResult).toHaveBeenCalledWith('proj-1', 'job-av');
    expect(nodeById(result.audioNodeId)?.data).toMatchObject({ audioUrl: '/static/fb.mp3' });
  });

  it('failure -> returns error and still clears isSeparatingAv', async () => {
    submitFreezoneAudioSeparate.mockRejectedValue(new Error('av boom'));
    const result = await separateVideoAudio('vid-1', { sourceUrl: '/static/src.mp4' });
    expect(result.error).toBe('av boom');
    expect(nodeById('vid-1')?.data).toMatchObject({ isSeparatingAv: false });
  });
});

describe('videoCaptureFrame (frame capture)', () => {
  it('resolveCaptureSeekSec: first frame 0 / last frame backs off 0.05s / current frame takes the player progress', () => {
    expect(resolveCaptureSeekSec('first', { currentTimeSec: 3, durationSec: 8 })).toBe(0);
    expect(resolveCaptureSeekSec('last', { durationSec: 8 })).toBeCloseTo(7.95);
    // When the live player reports no duration, fall back to the value converted from node data.durationMs.
    expect(resolveCaptureSeekSec('last', { durationSec: null, fallbackDurationSec: 4 })).toBeCloseTo(
      3.95,
    );
    // Neither duration available -> captureVideoFrameBlob clamps to the end by the actual duration internally.
    expect(resolveCaptureSeekSec('last', {})).toBe(Number.MAX_SAFE_INTEGER);
    expect(resolveCaptureSeekSec('current', { currentTimeSec: 2.5 })).toBe(2.5);
    expect(resolveCaptureSeekSec('current', { currentTimeSec: Number.NaN })).toBe(0);
  });

  it('capture -> upload -> create a derived image node, wire the edge, write the title; the ratio comes from the source video pixel size', async () => {
    seedVideoNode({ widthPx: 1920, heightPx: 1080 });
    captureVideoFrameBlob.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    uploadFreezoneImage.mockResolvedValue({ url: '/static/frame.png' });

    const result = await captureVideoFrameToNode('vid-1', {
      videoUrl: '/static/src.mp4',
      seekSec: 0,
      displayName: 'First frame',
    });

    expect(result.error).toBeNull();
    // The result node is exportImage (not upload): upload has no target handle, so earlier
    // addEdge silently failed; exportImage has a target handle and is not restricted by the upstream whitelist,
    // so wiring the edge should succeed.
    expect(nodeById(result.nodeId)?.type).toBe(CANVAS_NODE_TYPES.exportImage);
    expect(nodeById(result.nodeId)?.data).toMatchObject({
      imageUrl: '/static/frame.png',
      displayName: 'First frame',
    });
    expect(hasEdge('vid-1', result.nodeId)).toBe(true);
  });

  it('capture failure -> returns error and creates no node', async () => {
    captureVideoFrameBlob.mockRejectedValue(new Error('taint'));
    const before = useCanvasStore.getState().nodes.length;
    const result = await captureVideoFrameToNode('vid-1', {
      videoUrl: '/static/src.mp4',
      seekSec: 0,
      displayName: 'First frame',
    });
    expect(result).toEqual({ nodeId: null, error: 'taint' });
    expect(useCanvasStore.getState().nodes.length).toBe(before);
  });
});

describe('videoReplaceUpload (replace video)', () => {
  function videoFile(name = 'new.mp4') {
    return new File(['data'], name, { type: 'video/mp4' });
  }

  it('upload after transcoding -> writes back videoUrl and clears the preview image and isUploading', async () => {
    const transcoded = videoFile('new.h264.mp4');
    ensureWebSafeVideo.mockResolvedValue({ file: transcoded, transcoded: true });
    uploadFreezoneVideo.mockResolvedValue({ url: '/static/new.mp4' });
    const onTranscodedPreview = vi.fn();

    const result = await replaceNodeVideo('vid-1', videoFile(), { onTranscodedPreview });

    expect(result).toEqual({ url: '/static/new.mp4', error: null });
    // The browser may be unable to decode the source encoding -> the local preview is swapped for the transcoded result.
    expect(onTranscodedPreview).toHaveBeenCalledWith(transcoded);
    expect(uploadFreezoneVideo).toHaveBeenCalledWith('proj-1', transcoded, 'new.h264.mp4');
    expect(nodeById('vid-1')?.data).toMatchObject({
      videoUrl: '/static/new.mp4',
      previewImageUrl: null,
      sourceFileName: 'new.mp4',
      isUploading: false,
    });
  });

  it('does not call back the local preview when no transcoding is needed', async () => {
    const original = videoFile();
    ensureWebSafeVideo.mockResolvedValue({ file: original, transcoded: false });
    uploadFreezoneVideo.mockResolvedValue({ url: '/static/new.mp4' });
    const onTranscodedPreview = vi.fn();
    await replaceNodeVideo('vid-1', original, { onTranscodedPreview });
    expect(onTranscodedPreview).not.toHaveBeenCalled();
  });

  it('non-video file / missing project -> no upload; upload failure -> clears isUploading and returns error', async () => {
    await replaceNodeVideo('vid-1', new File(['x'], 'a.txt', { type: 'text/plain' }));
    expect(uploadFreezoneVideo).not.toHaveBeenCalled();

    readUrl.mockReturnValue({ project: null, canvas: null });
    await replaceNodeVideo('vid-1', videoFile());
    expect(uploadFreezoneVideo).not.toHaveBeenCalled();

    readUrl.mockReturnValue({ project: 'proj-1', canvas: 'canvas-1' });
    ensureWebSafeVideo.mockResolvedValue({ file: videoFile(), transcoded: false });
    uploadFreezoneVideo.mockRejectedValue(new Error('upload boom'));
    const result = await replaceNodeVideo('vid-1', videoFile());
    expect(result).toEqual({ url: null, error: 'upload boom' });
    expect(nodeById('vid-1')?.data).toMatchObject({ isUploading: false });
  });
});

describe('computeDisplayedVideoRect (object-contain coordinate conversion)', () => {
  it('video wider than the container -> letterbox bars top and bottom', () => {
    expect(computeDisplayedVideoRect(400, 400, 1920, 1080)).toEqual({
      left: 0,
      top: 87.5,
      width: 400,
      height: 225,
    });
  });

  it('video taller than the container -> pillarbox bars left and right', () => {
    expect(computeDisplayedVideoRect(400, 400, 1080, 1920)).toEqual({
      left: 87.5,
      top: 0,
      width: 225,
      height: 400,
    });
  });

  it('intrinsic size unknown -> degrades to the whole container', () => {
    expect(computeDisplayedVideoRect(400, 300, null, null)).toEqual({
      left: 0,
      top: 0,
      width: 400,
      height: 300,
    });
  });
});
