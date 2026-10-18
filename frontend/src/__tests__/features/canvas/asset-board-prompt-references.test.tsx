// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolvePromptReferences } from '@/features/canvas/domain/promptReferences';
import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import { useCanvasStore } from '@/stores/canvasStore';

vi.mock('@/lib/queries/generation-credit-cost', () => ({
  useGenerationCreditCost: () => ({ data: undefined }),
}));
vi.mock('@/features/canvas/hooks/useFreezoneImageModels', () => ({
  useFreezoneImageModels: () => ({ models: [] }),
}));

function detailPanel() {
  return screen.getByRole('region', { name: 'Asset details' });
}

/**
 * Two upstream images -> one result node, whose prompt references @image1 / @image2.
 *
 * The result node is an imageEdit: the details of imageGen and video now both mount an editable generation form
 * (@ references are rendered as chips by PromptMentionEditor itself); the read-only AssetBoardPromptText
 * only serves node types whose "detail has no generation form", and AI image edit is exactly that kind today.
 * Its label family is `imageN` (see resolvePromptReferences' labelPrefix);
 * the numbering rules of `imageN` / `videoN` / `audioN` are covered by the pure-function cases below.
 */
function seedGraph(prompt: string, extra: Record<string, unknown> = {}) {
  const nodes: CanvasNode[] = [
    {
      id: 'ref-a',
      type: CANVAS_NODE_TYPES.upload,
      position: { x: 0, y: 0 },
      data: { imageUrl: '/static/a.png', displayName: 'Reference A' },
    } as CanvasNode,
    {
      id: 'ref-b',
      type: CANVAS_NODE_TYPES.upload,
      position: { x: 0, y: 100 },
      data: { imageUrl: '/static/b.png', displayName: 'Reference B' },
    } as CanvasNode,
    {
      id: 'gen-1',
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 300, y: 0 },
      data: {
        imageUrl: '/static/out.png',
        displayName: 'Generated image',
        prompt,
        ...extra,
      },
    } as CanvasNode,
  ];
  const edges: CanvasEdge[] = [
    { id: 'e1', source: 'ref-a', target: 'gen-1' } as CanvasEdge,
    { id: 'e2', source: 'ref-b', target: 'gen-1' } as CanvasEdge,
  ];
  useCanvasStore.getState().setCanvasData(nodes, edges);
}

describe('@ reference chips in the detail prompt', () => {
  beforeEach(() => {
    seedGraph('Put the character from @image1 into the scene of @image2');
  });

  it('matched references render as chips with thumbnails (plain text is kept as is)', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Generated image' }));

    const detail = detailPanel();
    // @image1 / @image2 each render a chip, with thumbnails matching upstream A / B in edge order.
    const chip1 = within(detail).getByRole('button', { name: 'image1' });
    const chip2 = within(detail).getByRole('button', { name: 'image2' });
    expect(within(chip1).getByRole('img')).toHaveAttribute('src', '/static/a.png');
    expect(within(chip2).getByRole('img')).toHaveAttribute('src', '/static/b.png');
    // Non-reference text is kept as is.
    expect(within(detail).getByText(/Put the character from/)).toBeInTheDocument();
    expect(within(detail).getByText(/into the scene of/)).toBeInTheDocument();
  });

  it('hovering a chip pops up a large image preview (portal to body)', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Generated image' }));

    const chip = within(detailPanel()).getByRole('button', { name: 'image1' });
    expect(screen.getAllByRole('img', { name: 'image1' })).toHaveLength(1);
    fireEvent.mouseEnter(chip.parentElement as HTMLElement);
    // The preview image is a second same-source img (chip thumbnail + portal large image).
    const previews = screen.getAllByRole('img').filter((img) => img.getAttribute('src') === '/static/a.png');
    expect(previews.length).toBeGreaterThan(1);
    fireEvent.mouseLeave(chip.parentElement as HTMLElement);
  });

  it('references with no matching target stay plain text (no empty chip rendered, no error)', () => {
    // Only 2 upstreams -> @image9 resolves to no target.
    seedGraph('Try @image9');
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Generated image' }));

    const detail = detailPanel();
    expect(within(detail).queryByRole('button', { name: 'image9' })).not.toBeInTheDocument();
    expect(within(detail).getByText(/Try @image9/)).toBeInTheDocument();
  });

  it('read-only: chips carry no detach / delete badge', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Generated image' }));

    const chip = within(detailPanel()).getByRole('button', { name: 'image1' });
    expect(within(chip.parentElement as HTMLElement).queryByRole('button', { name: /unreference|remove|detach/i }))
      .not.toBeInTheDocument();
  });
});

describe('resolvePromptReferences (numbering rules reuse the workflow\'s)', () => {
  it('image family: the node\'s own reference image takes "image1" and upstream images follow (consistent with orderedReferenceUrlsWithOwnFirst)', () => {
    const upstream: CanvasNode[] = [
      {
        id: 'ref-a',
        type: CANVAS_NODE_TYPES.upload,
        position: { x: 0, y: 0 },
        data: { imageUrl: '/static/a.png' },
      } as CanvasNode,
    ];
    const node = {
      id: 'gen-1',
      type: CANVAS_NODE_TYPES.imageGen,
      position: { x: 0, y: 0 },
      data: { referenceImageUrl: '/static/own.png', prompt: '' },
    } as CanvasNode;

    const targets = resolvePromptReferences(node, upstream);
    // The own reference image is first -- if this is misaligned, @imageN would shift by 1 across the board.
    expect(targets.get('image1')?.thumbnailUrl).toBe('/static/own.png');
    expect(targets.get('image1')?.nodeId).toBeNull();
    expect(targets.get('image2')?.thumbnailUrl).toBe('/static/a.png');
    expect(targets.get('image2')?.nodeId).toBe('ref-a');
  });

  it('AI image edit node numbers by `imageN`, with a baseline of pure upstream images and no slot for an own reference image', () => {
    const upstream: CanvasNode[] = [
      {
        id: 'ref-a',
        type: CANVAS_NODE_TYPES.upload,
        position: { x: 0, y: 0 },
        data: { imageUrl: '/static/a.png' },
      } as CanvasNode,
      {
        id: 'ref-b',
        type: CANVAS_NODE_TYPES.upload,
        position: { x: 0, y: 0 },
        data: { imageUrl: '/static/b.png' },
      } as CanvasNode,
    ];
    const node = {
      id: 'edit-1',
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 0, y: 0 },
      // referenceImageUrl does not take part in numbering for imageEdit (only imageGen takes "image1" for it).
      data: { referenceImageUrl: '/static/own.png', prompt: '' },
    } as CanvasNode;

    const targets = resolvePromptReferences(node, upstream);
    expect(targets.get('image1')?.thumbnailUrl).toBe('/static/a.png');
    expect(targets.get('image2')?.thumbnailUrl).toBe('/static/b.png');
    // The own reference image must not be numbered in.
    expect(targets.size).toBe(2);
    expect([...targets.values()].some((t) => t.thumbnailUrl === '/static/own.png')).toBe(false);
  });

  it('video family: image/video/audio are counted independently, and manual referenceOrder reordering is respected', () => {
    const upstream: CanvasNode[] = [
      {
        id: 'img-1',
        type: CANVAS_NODE_TYPES.upload,
        position: { x: 0, y: 0 },
        data: { imageUrl: '/static/i1.png' },
      } as CanvasNode,
      {
        id: 'vid-1',
        type: CANVAS_NODE_TYPES.video,
        position: { x: 0, y: 0 },
        data: { videoUrl: '/static/v1.mp4', previewImageUrl: '/static/v1.png' },
      } as CanvasNode,
      {
        id: 'img-2',
        type: CANVAS_NODE_TYPES.upload,
        position: { x: 0, y: 0 },
        data: { imageUrl: '/static/i2.png' },
      } as CanvasNode,
    ];
    const node = {
      id: 'video-node',
      type: CANVAS_NODE_TYPES.video,
      position: { x: 0, y: 0 },
      // Manually drag img-2 to the front -> it becomes image1.
      data: { prompt: '', referenceOrder: ['img-2', 'img-1', 'vid-1'] },
    } as CanvasNode;

    const targets = resolvePromptReferences(node, upstream);
    expect(targets.get('image1')?.nodeId).toBe('img-2');
    expect(targets.get('image2')?.nodeId).toBe('img-1');
    // Video does not take image's index (each counted independently).
    expect(targets.get('video1')?.nodeId).toBe('vid-1');
    expect(targets.get('video1')?.thumbnailUrl).toBe('/static/v1.png');
  });
});
