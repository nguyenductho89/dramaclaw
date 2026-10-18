// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { AssetBoardColumn } from '@/features/canvas/ui/asset-board/AssetBoardColumn';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import {
  ASSET_BOARD_COLUMN_FRACTIONS_KEY,
  applyColumnResize,
  readStoredFractions,
} from '@/features/canvas/ui/asset-board/useAssetBoardColumnFractions';
import { useCanvasStore } from '@/stores/canvasStore';

// The ImageViewerModal / generation form permanently mounted inside AssetBoardView use useTranslation and react-query.
vi.mock('@/lib/queries/generation-credit-cost', () => ({
  useGenerationCreditCost: () => ({ data: undefined }),
}));

function seedBoard() {
  const nodes: CanvasNode[] = [
    {
      id: 'text-1',
      type: CANVAS_NODE_TYPES.textAnnotation,
      position: { x: 0, y: 0 },
      data: { content: '# Project info', displayName: 'Anchor list' },
    },
    {
      id: 'img-1',
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 0, y: 100 },
      data: { imageUrl: '/static/img1.png', aspectRatio: '1:1', displayName: 'Storyboard sketch' },
    },
    {
      id: 'vid-1',
      type: CANVAS_NODE_TYPES.video,
      position: { x: 0, y: 300 },
      data: { videoUrl: '/static/v.mp4', aspectRatio: '16:9', displayName: 'Final video' },
    },
  ];
  const edges: CanvasEdge[] = [];
  useCanvasStore.getState().setCanvasData(nodes, edges);
}

function renderBoard() {
  render(<AssetBoardView visible onLocateNode={vi.fn()} />);
}

/** The three-column container's getBoundingClientRect is always 0 wide under jsdom -- stub a fixed width for the conversion. */
function stubContainerWidth(width: number): HTMLElement {
  const container = screen.getByTestId('asset-board-columns');
  vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
    width,
    height: 600,
    top: 0,
    left: 0,
    right: width,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  return container;
}

function grow(testid: string): number {
  return Number(screen.getByTestId(testid).style.flexGrow);
}

describe('AssetBoard three-column drag-to-resize', () => {
  beforeEach(() => {
    window.localStorage.clear();
    seedBoard();
  });

  it('equal widths by default: all three columns have flexGrow 1/3', () => {
    renderBoard();
    expect(grow('asset-board-column-wrapper-text')).toBeCloseTo(1 / 3, 5);
    expect(grow('asset-board-column-wrapper-image')).toBeCloseTo(1 / 3, 5);
    expect(grow('asset-board-column-wrapper-video')).toBeCloseTo(1 / 3, 5);
  });

  it('dragging the text/image divider: right widens text and narrows images (flexGrow changes, video unchanged)', () => {
    renderBoard();
    stubContainerWidth(900);
    const resizer = screen.getByTestId('asset-board-resizer-0');

    fireEvent.pointerDown(resizer, { clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(resizer, { clientX: 390, pointerId: 1 }); // +90px -> +0.1 share

    expect(grow('asset-board-column-wrapper-text')).toBeCloseTo(1 / 3 + 0.1, 4);
    expect(grow('asset-board-column-wrapper-image')).toBeCloseTo(1 / 3 - 0.1, 4);
    expect(grow('asset-board-column-wrapper-video')).toBeCloseTo(1 / 3, 4);
  });

  it('dragging the image/video divider: shares move only between images and video (text unchanged)', () => {
    renderBoard();
    stubContainerWidth(900);
    const resizer = screen.getByTestId('asset-board-resizer-1');

    fireEvent.pointerDown(resizer, { clientX: 600, pointerId: 1 });
    fireEvent.pointerMove(resizer, { clientX: 690, pointerId: 1 });

    expect(grow('asset-board-column-wrapper-text')).toBeCloseTo(1 / 3, 4);
    expect(grow('asset-board-column-wrapper-image')).toBeCloseTo(1 / 3 + 0.1, 4);
    expect(grow('asset-board-column-wrapper-video')).toBeCloseTo(1 / 3 - 0.1, 4);
  });

  it('persist on release: after pointerUp the ratios are written to localStorage (sum is 1, reflecting the drag result)', () => {
    renderBoard();
    stubContainerWidth(900);
    const resizer = screen.getByTestId('asset-board-resizer-0');

    fireEvent.pointerDown(resizer, { clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(resizer, { clientX: 390, pointerId: 1 });
    // Before persisting, localStorage is still empty (written only on release).
    expect(window.localStorage.getItem(ASSET_BOARD_COLUMN_FRACTIONS_KEY)).toBeNull();

    fireEvent.pointerUp(resizer, { clientX: 390, pointerId: 1 });

    const stored = readStoredFractions();
    expect(stored[0] + stored[1] + stored[2]).toBeCloseTo(1, 5);
    expect(stored[0]).toBeCloseTo(1 / 3 + 0.1, 4);
    expect(stored[1]).toBeCloseTo(1 / 3 - 0.1, 4);
  });

  it('restore on refresh: pre-seeded localStorage -> initial flexGrow reflects the stored ratios', () => {
    window.localStorage.setItem(ASSET_BOARD_COLUMN_FRACTIONS_KEY, JSON.stringify([0.5, 0.3, 0.2]));
    renderBoard();
    expect(grow('asset-board-column-wrapper-text')).toBeCloseTo(0.5, 5);
    expect(grow('asset-board-column-wrapper-image')).toBeCloseTo(0.3, 5);
    expect(grow('asset-board-column-wrapper-video')).toBeCloseTo(0.2, 5);
  });

  it('dirty values fall back to equal widths: invalid JSON / structure / numbers -> each column 1/3', () => {
    for (const dirty of ['not-json', '[0.5,0.5]', '[1,2,"x"]', '[-1,1,1]', '[0,1,1]', '{"a":1}']) {
      window.localStorage.setItem(ASSET_BOARD_COLUMN_FRACTIONS_KEY, dirty);
      const stored = readStoredFractions();
      expect(stored[0]).toBeCloseTo(1 / 3, 5);
      expect(stored[1]).toBeCloseTo(1 / 3, 5);
      expect(stored[2]).toBeCloseTo(1 / 3, 5);
    }
  });

  it('minimum width: dragging all the way left, the image column does not collapse (stays >= 200/900 share), and text shrinks to the minimum', () => {
    renderBoard();
    stubContainerWidth(900);
    const resizer = screen.getByTestId('asset-board-resizer-0');

    fireEvent.pointerDown(resizer, { clientX: 300, pointerId: 1 });
    // Drag far left by 500px, well beyond the available space.
    fireEvent.pointerMove(resizer, { clientX: -200, pointerId: 1 });

    const minFrac = 200 / 900;
    expect(grow('asset-board-column-wrapper-text')).toBeCloseTo(minFrac, 4);
    // Share moves from text to images: images grow rather than collapse.
    expect(grow('asset-board-column-wrapper-image')).toBeGreaterThan(1 / 3);
  });

  it('detail-state isolation: entering the detail unmounts the whole three-column container (fractions do not apply to the detail layout)', () => {
    window.localStorage.setItem(ASSET_BOARD_COLUMN_FRACTIONS_KEY, JSON.stringify([0.5, 0.3, 0.2]));
    renderBoard();
    expect(screen.getByTestId('asset-board-columns')).toBeInTheDocument();

    // Click an image card to enter the detail.
    fireEvent.click(screen.getByRole('button', { name: 'Storyboard sketch' }));
    expect(screen.queryByTestId('asset-board-columns')).not.toBeInTheDocument();

    // Back to the overview -> remount and restore the ratios from localStorage.
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(screen.getByTestId('asset-board-columns')).toBeInTheDocument();
    expect(grow('asset-board-column-wrapper-text')).toBeCloseTo(0.5, 5);
  });
});

describe('video column filter dropdown', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'vid-final',
          type: CANVAS_NODE_TYPES.videoCompose,
          position: { x: 0, y: 0 },
          data: { videoUrl: '/static/final.mp4', displayName: 'Final one' },
        },
        {
          id: 'vid-clip',
          type: CANVAS_NODE_TYPES.video,
          position: { x: 0, y: 200 },
          data: { videoUrl: '/static/clip.mp4', displayName: 'Clip one' },
        },
      ],
      [],
    );
  });

  it('default "All": both kinds of video are in the list, and "All" is checked when the menu expands', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Final one' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clip one' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /All/ }));
    const menu = screen.getByRole('menu', { name: 'Filter videos' });
    expect(within(menu).getByRole('menuitemradio', { name: 'All' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('choosing "Final" -> keeps only finals and the trigger text follows; choosing "All" again restores', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /All/ }));
    fireEvent.click(
      within(screen.getByRole('menu', { name: 'Filter videos' })).getByRole('menuitemradio', {
        name: 'Final',
      }),
    );
    expect(screen.getByRole('button', { name: 'Final one' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clip one' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Final$/ }));
    fireEvent.click(
      within(screen.getByRole('menu', { name: 'Filter videos' })).getByRole('menuitemradio', {
        name: 'All',
      }),
    );
    expect(screen.getByRole('button', { name: 'Clip one' })).toBeInTheDocument();
  });
});

describe('image/video column expand', () => {
  beforeEach(() => {
    window.localStorage.clear();
    seedBoard();
  });

  it('clicking "Expand" on the image column -> three columns collapse into "left column + wide image grid", and "Collapse" restores', () => {
    renderBoard();
    // Three-column state: the image and video columns each have an expand button.
    expect(screen.getAllByRole('button', { name: 'Expand' })).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: 'Expand' })[0]);
    // After expanding the three-column container yields; only the expanded column remains on the right (the Collapse button is unique).
    expect(screen.queryByTestId('asset-board-columns')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse' })).toBeInTheDocument();
    // The grid shows that column's items as usual, and the text column stays on the left.
    expect(screen.getByRole('button', { name: 'Storyboard sketch' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Anchor list' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(screen.getByTestId('asset-board-columns')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Expand' })).toHaveLength(2);
  });

  it('the narrow left list in detail state has no "Expand" button (clicking it would change nothing)', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Storyboard sketch' }));

    // The left column is the image column right now (the column the detail is in), but expanding is meaningless in detail state -> do not render this button,
    // otherwise clicking does nothing, and closing the detail would suddenly jump into the expanded state.
    expect(screen.queryByRole('button', { name: 'Expand' })).not.toBeInTheDocument();
  });

  it('the left column (text column) in expanded state has no "Expand" button either', () => {
    renderBoard();
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand' })[0]);
    // Only the expanded column\'s "Collapse" remains; the left text column never had an expand entry.
    expect(screen.queryByRole('button', { name: 'Expand' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse' })).toBeInTheDocument();
  });

  it('in expanded state clicking a card opens the detail; closing the detail returns to the expanded state rather than three columns', () => {
    renderBoard();
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Storyboard sketch' }));

    const detail = screen.getByRole('region', { name: 'Asset details' });
    expect(detail).toBeInTheDocument();

    fireEvent.click(within(detail).getByRole('button', { name: 'Close details' }));
    expect(screen.getByRole('button', { name: 'Collapse' })).toBeInTheDocument();
    expect(screen.queryByTestId('asset-board-columns')).not.toBeInTheDocument();
  });
});

describe('AssetBoardColumn item dividers', () => {
  it('dividedItems: N items get N-1 dividers between them (none drawn at the ends)', () => {
    render(
      <AssetBoardColumn title="Images" count={3} emptyText="Empty" dividedItems>
        <div>Card 1</div>
        <div>Card 2</div>
        <div>Card 3</div>
      </AssetBoardColumn>,
    );
    expect(screen.getAllByTestId('asset-board-item-divider')).toHaveLength(2);
  });

  it('without dividedItems (text column) -> no divider is drawn at all', () => {
    render(
      <AssetBoardColumn title="Text" count={2} emptyText="Empty">
        <div>Text 1</div>
        <div>Text 2</div>
      </AssetBoardColumn>,
    );
    expect(screen.queryByTestId('asset-board-item-divider')).not.toBeInTheDocument();
  });

  it('dividers are independent elements with their own background -- not relying on card borders (a card\'s border-transparent would wipe out divide-*)', () => {
    render(
      <AssetBoardColumn title="Images" count={2} emptyText="Empty" dividedItems>
        <div className="border border-transparent">Card 1</div>
        <div className="border border-transparent">Card 2</div>
      </AssetBoardColumn>,
    );
    const divider = screen.getByTestId('asset-board-item-divider');
    expect(divider.className).toContain('bg-white/10');
  });
});

describe('applyColumnResize pure function', () => {
  const start = [1 / 3, 1 / 3, 1 / 3] as const;

  it('adjacent columns transfer share, the rest stay put, and the sum is always 1', () => {
    const next = applyColumnResize(start, 0, 90, 900, 200);
    expect(next[0]).toBeCloseTo(1 / 3 + 0.1, 5);
    expect(next[1]).toBeCloseTo(1 / 3 - 0.1, 5);
    expect(next[2]).toBeCloseTo(1 / 3, 5);
    expect(next[0] + next[1] + next[2]).toBeCloseTo(1, 5);
  });

  it('clamps minimum width: neither column goes below minPx/width', () => {
    const next = applyColumnResize(start, 1, 100000, 900, 200);
    const minFrac = 200 / 900;
    expect(next[2]).toBeCloseTo(minFrac, 5);
    expect(next[1]).toBeGreaterThan(1 / 3);
  });

  it('zero-width fallback: no displacement when width<=0', () => {
    const next = applyColumnResize(start, 0, 90, 0, 200);
    expect(next[0]).toBeCloseTo(1 / 3, 5);
    expect(next[1]).toBeCloseTo(1 / 3, 5);
  });
});
