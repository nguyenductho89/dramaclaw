// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import type { AssetBoardItem } from '@/features/canvas/domain/assetBoard';
import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { AddNodeToChatButton } from '@/features/canvas/ui/AddNodeToChatButton';
import { AssetBoardCard } from '@/features/canvas/ui/asset-board/AssetBoardCard';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import { useCanvasStore } from '@/stores/canvasStore';

// ImageViewerModal (permanently mounted inside AssetBoardView) uses useTranslation.
// Grid live pricing uses react-query and the test tree has no QueryClientProvider -- mock it out.
vi.mock('@/lib/queries/generation-credit-cost', () => ({
  useGenerationCreditCost: () => ({ data: undefined }),
}));

/** Collects the freezone/add-nodes-to-chat payloads published by this click. */
function captureEvents(run: () => void): string[][] {
  const seen: string[][] = [];
  const unsubscribe = canvasEventBus.subscribe('freezone/add-nodes-to-chat', ({ nodeIds }) => {
    seen.push(nodeIds);
  });
  try {
    run();
  } finally {
    unsubscribe();
  }
  return seen;
}

function boardItem(overrides: Partial<AssetBoardItem> = {}): AssetBoardItem {
  return {
    nodeId: 'n1',
    column: 'video',
    title: 'Test card',
    mediaUrl: null,
    thumbnailUrl: null,
    textPreview: null,
    model: null,
    durationSec: null,
    widthPx: null,
    heightPx: null,
    videoRole: null,
    references: [],
    timestamp: null,
    isGenerating: false,
    generationError: null,
    generationStartedAt: null,
    keyElementCategory: null,
    ...overrides,
  };
}

describe('Add to chat (shared entry for canvas nodes / the storyboard)', () => {
  it('the top-right button of a canvas node publishes the event and does not bubble to the node root (the root onClick would collapse the selection to a single one)', () => {
    const onRootClick = vi.fn();
    render(
      <div onClick={onRootClick}>
        <AddNodeToChatButton nodeId="img-1" />
      </div>,
    );
    const events = captureEvents(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }));
    });
    expect(events).toEqual([['img-1']]);
    expect(onRootClick).not.toHaveBeenCalled();
  });

  // The text hint goes through the shadcn Tooltip rather than the native title (the native one takes about a second of hovering to appear, and its style
  // is inconsistent with the product's other hover explanations) -- the regression point: a later refactor must not fall back to title.
  it('hovering pops up the "Add to chat" text hint and no longer carries the native title', async () => {
    const user = userEvent.setup();
    render(<AddNodeToChatButton nodeId="img-1" />);
    const button = screen.getByRole('button', { name: 'Add to chat' });
    expect(button).not.toHaveAttribute('title');

    await user.hover(button);
    expect(await screen.findByText('Add to chat')).toBeInTheDocument();
  });

  it('the top-right button of a storyboard card goes through the same event and does not trigger "open details" or "locate on canvas"', () => {
    const onOpen = vi.fn();
    const onLocate = vi.fn();
    render(
      <AssetBoardCard
        item={boardItem({ nodeId: 'vid-7', title: 'SB-07' })}
        onOpen={onOpen}
        onLocate={onLocate}
        onPreviewImage={() => {}}
      />,
    );
    const events = captureEvents(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }));
    });
    expect(events).toEqual([['vid-7']]);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onLocate).not.toHaveBeenCalled();
  });

  // The landing half (event -> the Xiadao draft appends an inline @[name](id) chip) is now covered by the
  // appendFreezoneNodeMentions unit test in freezone-node-suggestions.test.ts.

  describe('storyboard detail header', () => {
    beforeEach(() => {
      const nodes: CanvasNode[] = [
        {
          id: 'text-1',
          type: CANVAS_NODE_TYPES.textAnnotation,
          position: { x: 0, y: 0 },
          data: { content: '# Project info', displayName: 'Anchor list' },
        },
      ];
      const edges: CanvasEdge[] = [];
      useCanvasStore.getState().setCanvasData(nodes, edges);
    });

    // It hangs on the header rather than the media toolbar: the text column has no toolbar at all, and an empty node's toolbar does not render either,
    // yet both kinds of node can be referenced into the chat all the same.
    it('a text detail (with no media toolbar) can also be "added to chat", carrying the current detail node id', () => {
      render(<AssetBoardView visible onLocateNode={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: 'Anchor list' }));
      const detail = screen.getByRole('region', { name: 'Asset details' });
      const events = captureEvents(() => {
        fireEvent.click(within(detail).getByRole('button', { name: 'Add to chat' }));
      });
      expect(events).toEqual([['text-1']]);
    });
  });
});
