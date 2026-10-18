// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import { buildAssetBoard, modelBadgeLabel } from '@/features/canvas/domain/assetBoard';
import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';

function node(id: string, type: string, data: Record<string, unknown>): CanvasNode {
  return { id, type, position: { x: 0, y: 0 }, data } as unknown as CanvasNode;
}

function edge(source: string, target: string): CanvasEdge {
  return { id: `${source}->${target}`, source, target } as CanvasEdge;
}

describe('buildAssetBoard', () => {
  it('sorts nodes into the text/image/video/audio buckets by media type and ignores structural nodes such as groups', () => {
    const board = buildAssetBoard(
      [
        node('t1', CANVAS_NODE_TYPES.textAnnotation, { content: 'Ad storyboard script body' }),
        node('i1', CANVAS_NODE_TYPES.imageGen, { imageUrl: '/static/i1.png' }),
        node('v1', CANVAS_NODE_TYPES.video, { videoUrl: '/static/v1.mp4' }),
        node('a1', CANVAS_NODE_TYPES.audio, { audioUrl: '/static/a1.mp3' }),
        node('g1', CANVAS_NODE_TYPES.group, { label: 'Group' }),
        node('s1', CANVAS_NODE_TYPES.skill, {}),
      ],
      [],
    );
    expect(board.text.map((i) => i.nodeId)).toEqual(['t1']);
    expect(board.image.map((i) => i.nodeId)).toEqual(['i1']);
    expect(board.video.map((i) => i.nodeId)).toEqual(['v1']);
    expect(board.audio.map((i) => i.nodeId)).toEqual(['a1']);
  });

  it('video compose nodes are marked final and regular video nodes are clips', () => {
    const board = buildAssetBoard(
      [
        node('vc', CANVAS_NODE_TYPES.videoCompose, { resultVideoUrl: '/static/final.mp4' }),
        node('v1', CANVAS_NODE_TYPES.video, { videoUrl: '/static/v1.mp4' }),
      ],
      [],
    );
    const roles = Object.fromEntries(board.video.map((i) => [i.nodeId, i.videoRole]));
    expect(roles).toEqual({ vc: 'final', v1: 'clip' });
  });

  it('badge metadata: model / durationSec / widthPx / heightPx; audio durationMs is converted to seconds', () => {
    const board = buildAssetBoard(
      [
        node('v1', CANVAS_NODE_TYPES.video, {
          videoUrl: '/static/v1.mp4',
          model: 'wan2.5',
          durationSec: 5,
          widthPx: 720,
          heightPx: 1280,
        }),
        node('a1', CANVAS_NODE_TYPES.audio, { audioUrl: '/static/a1.mp3', durationMs: 101402 }),
      ],
      [],
    );
    const v = board.video[0];
    expect(v.model).toBe('wan2.5');
    expect(v.durationSec).toBe(5);
    expect(v.widthPx).toBe(720);
    expect(v.heightPx).toBe(1280);
    expect(board.audio[0].durationSec).toBe(101);
  });

  it('reference assets take upstream in edge order, referenceOrder can reorder them, and upstreams without a thumbnail are dropped', () => {
    const nodes = [
      node('img-a', CANVAS_NODE_TYPES.imageGen, { imageUrl: '/static/a.png', displayName: 'Character image A' }),
      node('img-b', CANVAS_NODE_TYPES.imageGen, { imageUrl: '/static/b.png', displayName: 'Prop image B' }),
      node('txt', CANVAS_NODE_TYPES.textAnnotation, { content: 'Plain-text upstream, no thumbnail' }),
      node('v1', CANVAS_NODE_TYPES.video, {
        videoUrl: '/static/v1.mp4',
        referenceOrder: ['img-b', 'img-a'],
      }),
    ];
    const edges = [edge('img-a', 'v1'), edge('img-b', 'v1'), edge('txt', 'v1')];
    const board = buildAssetBoard(nodes, edges);
    expect(board.video[0].references.map((r) => r.nodeId)).toEqual(['img-b', 'img-a']);
    expect(board.video[0].references.map((r) => r.label)).toEqual(['Prop image B', 'Character image A']);
  });

  it('the own reference image (imageGen referenceImageUrl, no upstream edge) joins the reference assets at position 1 with a null nodeId', () => {
    const board = buildAssetBoard(
      [
        node('gen', CANVAS_NODE_TYPES.imageGen, {
          imageUrl: '/static/gen.png',
          referenceImageUrl: '/static/own-ref.png',
        }),
      ],
      [],
    );
    const refs = board.image[0].references;
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ nodeId: null, thumbnailUrl: '/static/own-ref.png' });
    // Consistent with @imageN: the own image appears as a separate reference, even if the node's main image is a generated result.
    expect(refs[0].label).toBe('Reference image');
  });

  it('own reference image + upstream images: the own image takes position 1 and upstream follows in edge order (same as orderedReferenceUrlsWithOwnFirst)', () => {
    const nodes = [
      node('up-a', CANVAS_NODE_TYPES.upload, { imageUrl: '/static/up-a.png', displayName: 'Upstream A' }),
      node('up-b', CANVAS_NODE_TYPES.upload, { imageUrl: '/static/up-b.png', displayName: 'Upstream B' }),
      node('gen', CANVAS_NODE_TYPES.imageGen, {
        imageUrl: '/static/gen.png',
        referenceImageUrl: '/static/own.png',
      }),
    ];
    const edges = [edge('up-a', 'gen'), edge('up-b', 'gen')];
    const board = buildAssetBoard(nodes, edges);
    const refs = board.image.find((i) => i.nodeId === 'gen')?.references ?? [];
    expect(refs.map((r) => r.thumbnailUrl)).toEqual([
      '/static/own.png',
      '/static/up-a.png',
      '/static/up-b.png',
    ]);
    expect(refs.map((r) => r.nodeId)).toEqual([null, 'up-a', 'up-b']);
  });

  it('when the own reference image has the same URL as an upstream image -> dedupe, keeping only the own-image entry (position 1)', () => {
    const nodes = [
      node('up-same', CANVAS_NODE_TYPES.upload, { imageUrl: '/static/shared.png', displayName: 'Same-image upstream' }),
      node('up-other', CANVAS_NODE_TYPES.upload, { imageUrl: '/static/other.png', displayName: 'Another upstream' }),
      node('gen', CANVAS_NODE_TYPES.imageGen, {
        imageUrl: '/static/gen.png',
        referenceImageUrl: '/static/shared.png',
      }),
    ];
    const board = buildAssetBoard(nodes, [edge('up-same', 'gen'), edge('up-other', 'gen')]);
    const refs = board.image.find((i) => i.nodeId === 'gen')?.references ?? [];
    // shared.png appears only once (the own-image entry), and other.png follows.
    expect(refs.map((r) => r.thumbnailUrl)).toEqual(['/static/shared.png', '/static/other.png']);
    expect(refs.map((r) => r.nodeId)).toEqual([null, 'up-other']);
  });

  it('pure-upstream imageGen (no own reference image) keeps its reference assets unchanged (regression)', () => {
    const nodes = [
      node('up-a', CANVAS_NODE_TYPES.upload, { imageUrl: '/static/a.png', displayName: 'A' }),
      node('up-b', CANVAS_NODE_TYPES.upload, { imageUrl: '/static/b.png', displayName: 'B' }),
      node('gen', CANVAS_NODE_TYPES.imageGen, { imageUrl: '/static/gen.png' }),
    ];
    const board = buildAssetBoard(nodes, [edge('up-a', 'gen'), edge('up-b', 'gen')]);
    const refs = board.image.find((i) => i.nodeId === 'gen')?.references ?? [];
    expect(refs.map((r) => r.nodeId)).toEqual(['up-a', 'up-b']);
  });

  it('referenceImageUrl of a non-imageGen node does not enter the reference assets (own reference image is an imageGen-only concept)', () => {
    const board = buildAssetBoard(
      [
        node('up', CANVAS_NODE_TYPES.upload, {
          imageUrl: '/static/up.png',
          referenceImageUrl: '/static/should-not-appear.png',
        }),
      ],
      [],
    );
    expect(board.image[0].references).toEqual([]);
  });

  it('items in a column are ordered newest to oldest by creation order (nodes array order), with the newest node on top', () => {
    const board = buildAssetBoard(
      [
        node('first', CANVAS_NODE_TYPES.imageGen, { imageUrl: '/static/first.png' }),
        node('second', CANVAS_NODE_TYPES.imageGen, { imageUrl: '/static/second.png' }),
        node('third', CANVAS_NODE_TYPES.imageGen, { imageUrl: '/static/third.png' }),
      ],
      [],
    );
    // addNode appends to the end -> array order first->second->third; reversed = the newest, third, on top.
    expect(board.image.map((i) => i.nodeId)).toEqual(['third', 'second', 'first']);
  });

  it('a node that just finished generating (generationStartedAt cleared, no committed_at) still sorts above older nodes', () => {
    const board = buildAssetBoard(
      [
        node('old-committed', CANVAS_NODE_TYPES.imageGen, {
          imageUrl: '/static/old.png',
          committed_at: '2026-07-01T00:00:00Z',
        }),
        // An image is generated in a later-created empty node: after completion generationStartedAt is cleared to null and there is no committed_at.
        node('fresh-gen', CANVAS_NODE_TYPES.imageGen, { imageUrl: '/static/fresh.png' }),
      ],
      [],
    );
    // Timestamp ordering would sink fresh-gen (no stamp) to the bottom; with creation order, the later-created fresh-gen goes on top.
    expect(board.image.map((i) => i.nodeId)).toEqual(['fresh-gen', 'old-committed']);
  });

  it('keyElementCategory: reads the key-element category from node data, passing valid values through and giving null for invalid/missing ones', () => {
    const board = buildAssetBoard(
      [
        node('tagged', CANVAS_NODE_TYPES.imageGen, {
          imageUrl: '/static/a.png',
          keyElementCategory: 'character',
        }),
        node('bad', CANVAS_NODE_TYPES.imageGen, {
          imageUrl: '/static/b.png',
          keyElementCategory: 'garbage',
        }),
        node('untagged', CANVAS_NODE_TYPES.imageGen, { imageUrl: '/static/c.png' }),
      ],
      [],
    );
    const byId = Object.fromEntries(board.image.map((i) => [i.nodeId, i.keyElementCategory]));
    expect(byId.tagged).toBe('character');
    expect(byId.bad).toBeNull();
    expect(byId.untagged).toBeNull();
  });

  it('text preview: content is truncated to 80 chars; the storyboard table shows the shot count; the title uses the resolveNodeDisplayName default', () => {
    const long = 'x'.repeat(100);
    const board = buildAssetBoard(
      [
        node('t1', CANVAS_NODE_TYPES.textAnnotation, { content: long }),
        node('vs', CANVAS_NODE_TYPES.videoStory, { rows: [{}, {}, {}] }),
      ],
      [],
    );
    expect(board.text.find((i) => i.nodeId === 't1')?.textPreview).toBe(`${'x'.repeat(80)}…`);
    expect(board.text.find((i) => i.nodeId === 'vs')?.textPreview).toBe('Storyboard table · 3 shots');
    expect(board.text.find((i) => i.nodeId === 't1')?.title).toBe('Text');
  });

  it('videoCompose mediaUrl falls back to resultVideoUrl', () => {
    const board = buildAssetBoard(
      [node('vc', CANVAS_NODE_TYPES.videoCompose, { resultVideoUrl: '/static/final.mp4' })],
      [],
    );
    expect(board.video.find((i) => i.nodeId === 'vc')?.mediaUrl).toBe('/static/final.mp4');
  });

  it('script node textPreview uses scriptTitle and falls back to prompt without it', () => {
    const board = buildAssetBoard(
      [
        node('s-title', CANVAS_NODE_TYPES.script, { scriptTitle: 'Episode 1: Daybreak', prompt: 'Write an opening' }),
        node('s-prompt', CANVAS_NODE_TYPES.script, { prompt: 'Write an ending' }),
      ],
      [],
    );
    expect(board.text.find((i) => i.nodeId === 's-title')?.textPreview).toBe('Episode 1: Daybreak');
    expect(board.text.find((i) => i.nodeId === 's-prompt')?.textPreview).toBe('Write an ending');
  });

  it('video durationSec is rounded down', () => {
    const board = buildAssetBoard(
      [node('v1', CANVAS_NODE_TYPES.video, { videoUrl: '/static/v1.mp4', durationSec: 5.9 })],
      [],
    );
    expect(board.video[0].durationSec).toBe(5);
  });

  it('isGenerating: any of isGenerating/isUploading/isAnalyzing being true means in progress, normalized with Boolean', () => {
    const board = buildAssetBoard(
      [
        node('gen', CANVAS_NODE_TYPES.imageGen, { imageUrl: null, isGenerating: true }),
        node('up', CANVAS_NODE_TYPES.video, { videoUrl: null, isUploading: true }),
        node('ana', CANVAS_NODE_TYPES.video, { videoUrl: '/static/v.mp4', isAnalyzing: 1 }),
      ],
      [],
    );
    expect(board.image.find((i) => i.nodeId === 'gen')?.isGenerating).toBe(true);
    expect(board.video.find((i) => i.nodeId === 'up')?.isGenerating).toBe(true);
    // Non-boolean truthy values are normalized to true by Boolean() (rather than passed through).
    expect(board.video.find((i) => i.nodeId === 'ana')?.isGenerating).toBe(true);
  });

  it('generationError fallback chain: generationError ?? analysisError ?? uploadError', () => {
    const board = buildAssetBoard(
      [
        node('e1', CANVAS_NODE_TYPES.video, {
          videoUrl: null,
          generationError: 'Generation failed',
          analysisError: 'Analysis failed',
          uploadError: 'Upload failed',
        }),
        node('e2', CANVAS_NODE_TYPES.video, { videoUrl: null, analysisError: 'Analysis failed' }),
        node('e3', CANVAS_NODE_TYPES.upload, { imageUrl: null, uploadError: 'Upload failed' }),
      ],
      [],
    );
    expect(board.video.find((i) => i.nodeId === 'e1')?.generationError).toBe('Generation failed');
    expect(board.video.find((i) => i.nodeId === 'e2')?.generationError).toBe('Analysis failed');
    expect(board.image.find((i) => i.nodeId === 'e3')?.generationError).toBe('Upload failed');
  });

  it('with no in-progress/failure markers isGenerating=false and generationError=null (an empty-string error counts as none)', () => {
    const board = buildAssetBoard(
      [
        node('idle', CANVAS_NODE_TYPES.imageGen, { imageUrl: '/static/i.png' }),
        node('blank', CANVAS_NODE_TYPES.imageGen, { imageUrl: '/static/j.png', generationError: '  ' }),
      ],
      [],
    );
    expect(board.image.find((i) => i.nodeId === 'idle')?.isGenerating).toBe(false);
    expect(board.image.find((i) => i.nodeId === 'idle')?.generationError).toBeNull();
    expect(board.image.find((i) => i.nodeId === 'blank')?.generationError).toBeNull();
  });

  it('generationStartedAt: numbers pass through as-is, non-numbers/missing normalize to null (input for the card progress estimate)', () => {
    const board = buildAssetBoard(
      [
        node('gen', CANVAS_NODE_TYPES.imageGen, {
          imageUrl: null,
          isGenerating: true,
          generationStartedAt: 1700000000000,
        }),
        node('idle', CANVAS_NODE_TYPES.imageGen, { imageUrl: '/static/i.png' }),
        node('bad', CANVAS_NODE_TYPES.imageGen, {
          imageUrl: null,
          isGenerating: true,
          generationStartedAt: '2026-01-01T00:00:00Z',
        }),
      ],
      [],
    );
    expect(board.image.find((i) => i.nodeId === 'gen')?.generationStartedAt).toBe(1700000000000);
    expect(board.image.find((i) => i.nodeId === 'idle')?.generationStartedAt).toBeNull();
    expect(board.image.find((i) => i.nodeId === 'bad')?.generationStartedAt).toBeNull();
  });
});

describe('modelBadgeLabel', () => {
  it('strips the channel prefix and keeps only the model name', () => {
    expect(modelBadgeLabel('newapi_seedance-2.0-value')).toBe('seedance-2.0-value');
    expect(modelBadgeLabel('newapi_happyhorse-1.0')).toBe('happyhorse-1.0');
  });

  it('ids with no prefix / a malformed prefix are returned as-is (not swallowed into an empty string)', () => {
    expect(modelBadgeLabel('wan2.5')).toBe('wan2.5');
    expect(modelBadgeLabel('_leading')).toBe('_leading');
    expect(modelBadgeLabel('trailing_')).toBe('trailing_');
  });
});
