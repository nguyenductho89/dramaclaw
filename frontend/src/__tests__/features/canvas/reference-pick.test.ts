// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import { enT } from "../../helpers/i18n-fixtures";
import {
  collectReferenceCandidates,
  collectReferenceMaterials,
  collectReferencePickTargets,
  supportsReferencePick,
} from '@/features/canvas/application/referencePick';
import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';

function node(
  id: string,
  type: CanvasNodeType,
  data: Record<string, unknown> = {},
): CanvasNode {
  return { id, type, position: { x: 0, y: 0 }, data } as unknown as CanvasNode;
}

const TARGET_IMAGE = node('target-image', CANVAS_NODE_TYPES.imageGen);
const TARGET_VIDEO = node('target-video', CANVAS_NODE_TYPES.video);

describe('reference pick candidates', () => {
  it('only image / video nodes offer the + Reference entry', () => {
    expect(supportsReferencePick(CANVAS_NODE_TYPES.imageGen)).toBe(true);
    expect(supportsReferencePick(CANVAS_NODE_TYPES.video)).toBe(true);
    expect(supportsReferencePick(CANVAS_NODE_TYPES.audio)).toBe(false);
    expect(supportsReferencePick(CANVAS_NODE_TYPES.textAnnotation)).toBe(false);
    expect(supportsReferencePick(undefined)).toBe(false);
  });

  it('an image node accepts only images and text', () => {
    const nodes = [
      TARGET_IMAGE,
      node('text', CANVAS_NODE_TYPES.textAnnotation, { content: 'A description' }),
      node('image', CANVAS_NODE_TYPES.imageGen, { imageUrl: 'https://x/a.png' }),
      node('video', CANVAS_NODE_TYPES.video, { videoUrl: 'https://x/a.mp4' }),
      node('audio', CANVAS_NODE_TYPES.audio, { audioUrl: 'https://x/a.mp3' }),
    ];

    const candidates = collectReferenceCandidates(
      nodes,
      TARGET_IMAGE.id,
      CANVAS_NODE_TYPES.imageGen,
      enT,
    );

    expect([...candidates.keys()].sort()).toEqual(['image', 'text']);
  });

  it('a video node accepts images, videos, audio and text', () => {
    const nodes = [
      TARGET_VIDEO,
      node('text', CANVAS_NODE_TYPES.textAnnotation, { content: 'A description' }),
      node('image', CANVAS_NODE_TYPES.imageGen, { imageUrl: 'https://x/a.png' }),
      node('video', CANVAS_NODE_TYPES.video, { videoUrl: 'https://x/a.mp4' }),
      node('audio', CANVAS_NODE_TYPES.audio, { audioUrl: 'https://x/a.mp3' }),
    ];

    const candidates = collectReferenceCandidates(
      nodes,
      TARGET_VIDEO.id,
      CANVAS_NODE_TYPES.video,
      enT,
    );

    expect([...candidates.keys()].sort()).toEqual(['audio', 'image', 'text', 'video']);
  });

  it('a node cannot reference itself', () => {
    const candidates = collectReferenceCandidates(
      [TARGET_IMAGE],
      TARGET_IMAGE.id,
      CANVAS_NODE_TYPES.imageGen,
      enT,
    );

    expect(candidates.size).toBe(0);
  });

  it('a node with no content yet is judged by type and does not vanish from the candidates', () => {
    const nodes = [
      TARGET_IMAGE,
      node('empty-text', CANVAS_NODE_TYPES.textAnnotation, { content: '' }),
      node('empty-image', CANVAS_NODE_TYPES.imageGen),
    ];

    const candidates = collectReferenceCandidates(
      nodes,
      TARGET_IMAGE.id,
      CANVAS_NODE_TYPES.imageGen,
      enT,
    );

    expect([...candidates.keys()].sort()).toEqual(['empty-image', 'empty-text']);
  });

  it('an upload node is judged by what it actually holds: only ones holding images become candidates of an image node', () => {
    const uploadVideo = node('upload-video', CANVAS_NODE_TYPES.upload, {
      videoUrl: 'https://x/a.mp4',
    });
    const uploadImage = node('upload-image', CANVAS_NODE_TYPES.upload, {
      imageUrl: 'https://x/a.png',
    });

    expect(
      [
        ...collectReferenceCandidates(
          [TARGET_IMAGE, uploadVideo, uploadImage],
          TARGET_IMAGE.id,
          CANVAS_NODE_TYPES.imageGen,
          enT,
        ).keys(),
      ].sort(),
    ).toEqual(['upload-image']);

    // The same upload node is a legal video reference on the video node side -- it is not "nobody can pick it".
    expect(
      [
        ...collectReferenceCandidates(
          [TARGET_VIDEO, uploadVideo, uploadImage],
          TARGET_VIDEO.id,
          CANVAS_NODE_TYPES.video,
          enT,
        ).keys(),
      ].sort(),
    ).toEqual(['upload-image', 'upload-video']);
  });

  it('system-only edges are not candidates: a style node cannot be manually wired into an image node', () => {
    const candidates = collectReferenceCandidates(
      [TARGET_IMAGE, node('style', CANVAS_NODE_TYPES.style, {})],
      TARGET_IMAGE.id,
      CANVAS_NODE_TYPES.imageGen,
      enT,
    );

    expect(candidates.has('style')).toBe(false);
  });

  it('candidates carry the node display name for the "Select xxx" hint', () => {
    const candidates = collectReferenceCandidates(
      [
        TARGET_IMAGE,
        node('named', CANVAS_NODE_TYPES.textAnnotation, {
          content: 'x',
          displayName: 'S09 | Close-up · Front',
        }),
        node('unnamed', CANVAS_NODE_TYPES.textAnnotation, { content: 'x' }),
      ],
      TARGET_IMAGE.id,
      CANVAS_NODE_TYPES.imageGen,
      enT,
    );

    expect(candidates.get('named')?.label).toBe('S09 | Close-up · Front');
    expect(candidates.get('unnamed')?.label).toBe('Text');
  });
});

describe('reference pick rejections', () => {
  it('an image node gives an explainable rejection for video / audio nodes instead of silently vanishing', () => {
    const { candidates, rejections } = collectReferencePickTargets(
      [
        TARGET_IMAGE,
        node('image', CANVAS_NODE_TYPES.imageGen, { imageUrl: 'https://x/a.png' }),
        node('video', CANVAS_NODE_TYPES.video, { videoUrl: 'https://x/a.mp4' }),
        node('audio', CANVAS_NODE_TYPES.audio, { audioUrl: 'https://x/a.mp3' }),
      ],
      TARGET_IMAGE.id,
      CANVAS_NODE_TYPES.imageGen,
      enT,
    );

    expect([...candidates.keys()]).toEqual(['image']);
    expect(rejections.get('video')).toBe("This video node can't be used as a reference yet");
    expect(rejections.get('audio')).toBe("This audio node can't be used as a reference yet");
  });

  it('a video node accepts everything, so there is no rejection at all', () => {
    const { rejections } = collectReferencePickTargets(
      [
        TARGET_VIDEO,
        node('image', CANVAS_NODE_TYPES.imageGen, { imageUrl: 'https://x/a.png' }),
        node('video', CANVAS_NODE_TYPES.video, { videoUrl: 'https://x/a.mp4' }),
        node('audio', CANVAS_NODE_TYPES.audio, { audioUrl: 'https://x/a.mp3' }),
      ],
      TARGET_VIDEO.id,
      CANVAS_NODE_TYPES.video,
      enT,
    );

    expect(rejections.size).toBe(0);
  });

  it('a node of unknown kind gets the generic text, while a group node gets no overlay at all', () => {
    const { candidates, rejections } = collectReferencePickTargets(
      [
        TARGET_IMAGE,
        node('style', CANVAS_NODE_TYPES.style, {}),
        node('group', CANVAS_NODE_TYPES.group, {}),
      ],
      TARGET_IMAGE.id,
      CANVAS_NODE_TYPES.imageGen,
      enT,
    );

    expect(candidates.size).toBe(0);
    expect(rejections.get('style')).toBe("This node can't be used as a reference");
    expect(rejections.has('group')).toBe(false);
  });

  it('an upload node holding a video can enter the video node\'s "material references" and carries the video thumbnail', () => {
    const materials = collectReferenceMaterials(
      [
        TARGET_VIDEO,
        node('upload-video', CANVAS_NODE_TYPES.upload, {
          videoUrl: 'https://x/a.mp4',
          // The poster is only a cover and must not be taken for an image asset.
          previewImageUrl: 'https://x/poster.png',
        }),
      ],
      TARGET_VIDEO.id,
      CANVAS_NODE_TYPES.video,
      new Set<string>(),
      enT,
    );

    expect(materials).toHaveLength(1);
    expect(materials[0]).toMatchObject({
      nodeId: 'upload-video',
      kind: 'video',
      videoUrl: 'https://x/a.mp4',
    });
    expect(materials[0].imageUrl).toBeUndefined();
  });

  it('a node does not enter its own rejection table', () => {
    const { rejections } = collectReferencePickTargets(
      [node('target-video', CANVAS_NODE_TYPES.video, { videoUrl: 'https://x/a.mp4' })],
      'target-video',
      CANVAS_NODE_TYPES.imageGen,
      enT,
    );

    expect(rejections.size).toBe(0);
  });
});
