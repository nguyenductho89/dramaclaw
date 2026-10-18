// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// Covers two things about the storyboard "generating-state progress percentage" aligned with liblib:
// 1. Premise check -- whether the narrow left list is really live in detail state (a newly spawned generating node should
//    appear in the list automatically). AssetBoardView's board data source is not frozen while the storyboard is visible
//    (buildAssetBoard(nodes, edges) subscribes to the store's live nodes/edges), which should hold in theory;
//    here we run it against the real store + real addNode (spawned the same way as the "multi-angle" orchestration imageMultiAngle.ts:
//    addNode an isGenerating exportImage node) to verify it empirically,
//    rather than guessing from reading code.
// 2. New feature -- the small "Generating" text beside the card title is upgraded to a "Generating X%..." percentage (time estimate,
//    linearly interpolated from generationStartedAt + estimated durationMs, sharing the same algorithm with the workflow NodeGenerationOverlay).

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import { useCanvasStore } from '@/stores/canvasStore';

vi.mock('@/lib/queries/generation-credit-cost', () => ({
  useGenerationCreditCost: () => ({ data: undefined }),
}));

function seedBoard() {
  const nodes: CanvasNode[] = [
    {
      id: 'img-1',
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 0, y: 0 },
      data: { imageUrl: '/static/img1.png', aspectRatio: '1:1', displayName: 'Existing image' },
    },
  ];
  const edges: CanvasEdge[] = [];
  useCanvasStore.getState().setCanvasData(nodes, edges);
}

function renderBoard() {
  render(<AssetBoardView visible onLocateNode={vi.fn()} />);
}

function detailPanel() {
  return screen.getByRole('region', { name: 'Asset details' });
}

describe('storyboard generating state: new node enters the left list + progress percentage', () => {
  beforeEach(() => {
    seedBoard();
  });

  it('spawning a generating image node in image detail state (the same addNode+addEdge way as "multi-angle") -> appears in the narrow left list and renders the generating state', () => {
    renderBoard();
    // Enter the image detail first (matching the user scenario: while editing/generating the user is sitting inside some detail).
    fireEvent.click(screen.getByRole('button', { name: 'Existing image' }));
    expect(within(detailPanel()).getByText('Existing image')).toBeInTheDocument();
    // In master-detail layout only the narrow image-column list remains on the left.
    expect(screen.getByText('Images')).toBeInTheDocument();

    // As the imageMultiAngle.ts orchestration does: synchronously addNode an isGenerating result node
    // and wire it to the source node -- not replacing the whole nodes array (setCanvasData) but spawning incrementally.
    act(() => {
      const store = useCanvasStore.getState();
      const newNodeId = store.addNode(
        CANVAS_NODE_TYPES.exportImage,
        { x: 200, y: 0 },
        {
          displayName: 'Multi-angle candidate',
          imageUrl: null,
          previewImageUrl: null,
          aspectRatio: '1:1',
          isGenerating: true,
          generationStartedAt: Date.now(),
        },
      );
      store.addEdge('img-1', newNodeId);
    });

    // Assertion A: the new node really appears in the narrow left list (the board data source is live, not frozen by the detail state).
    const imageList = screen.getByText('Images').closest('section') as HTMLElement;
    expect(within(imageList).getByRole('button', { name: 'Multi-angle candidate' })).toBeInTheDocument();
    // Assertion B: it renders in the generating state -- the percentage text beside the title + the spinner overlay on the media area.
    expect(within(imageList).getByText(/^Generating \d+%\.\.\.$/)).toBeInTheDocument();
    expect(within(imageList).getAllByRole('status', { name: 'Generating' }).length).toBeGreaterThan(0);
    // The existing detail (Existing image) is not interrupted -- the left list gains one item without affecting the detail being viewed on the right.
    expect(within(detailPanel()).getByText('Existing image')).toBeInTheDocument();
  });

  it('the percentage advances over time: the card text grows from 0%, with an estimated duration of 20s for the image column', () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      act(() => {
        const store = useCanvasStore.getState();
        store.addNode(
          CANVAS_NODE_TYPES.exportImage,
          { x: 200, y: 0 },
          {
            displayName: 'Generating candidate',
            imageUrl: null,
            aspectRatio: '1:1',
            isGenerating: true,
            generationStartedAt: startedAt,
          },
        );
      });
      renderBoard();

      expect(screen.getByText('Generating 0%...')).toBeInTheDocument();

      // 4s / 20s estimated through the exponential saturation algorithm is about 24% (120ms polling tick, the last tick landing at 3960ms).
      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(screen.getByText('Generating 24%...')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('generation finished (isGenerating becomes false) -> the percentage text disappears and the card returns to normal', () => {
    act(() => {
      const store = useCanvasStore.getState();
      const id = store.addNode(
        CANVAS_NODE_TYPES.exportImage,
        { x: 200, y: 0 },
        { displayName: 'Finishing candidate', imageUrl: null, aspectRatio: '1:1', isGenerating: true, generationStartedAt: Date.now() },
      );
      store.updateNodeData(id, {
        imageUrl: '/static/done.png',
        previewImageUrl: '/static/done.png',
        isGenerating: false,
        generationStartedAt: null,
      });
    });
    renderBoard();

    expect(screen.queryByText(/^Generating \d+%\.\.\.$/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finishing candidate' })).toBeInTheDocument();
  });
});
