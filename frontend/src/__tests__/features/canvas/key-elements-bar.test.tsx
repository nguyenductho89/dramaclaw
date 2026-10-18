// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import { useCanvasStore } from '@/stores/canvasStore';

/** Collect the freezone/add-nodes-to-chat payloads published during this segment. */
function captureAddToChat(run: () => void): string[][] {
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

vi.mock('@/lib/queries/generation-credit-cost', () => ({
  useGenerationCreditCost: () => ({ data: undefined }),
}));

vi.mock('@/lib/url-params', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/url-params')>()),
  readUrl: () => ({ project: 'demo-project', canvas: 'default' }),
}));

function imageNode(id: string, data: Record<string, unknown>): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.imageGen,
    position: { x: 0, y: 0 },
    data: { imageUrl: `/static/${id}.png`, aspectRatio: '1:1', ...data },
  } as CanvasNode;
}

function audioNode(id: string, data: Record<string, unknown>): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.audio,
    position: { x: 0, y: 0 },
    data: { audioUrl: `/static/${id}.mp3`, displayName: 'Audio', ...data },
  } as CanvasNode;
}

function seed(nodes: CanvasNode[]) {
  useCanvasStore.getState().setCanvasData(nodes, []);
}

/**
 * Top bar (rendered only when there are key elements / audio). Structure: bar root > tab row (div) > key-element dropdown trigger.
 * The trigger's nearest div ancestor is the tab row, whose parent is the bar root; assertions inside the bar are scoped with within(bar) to avoid clashing with
 * the same-named cards in the image column.
 */
function keyElementsBar(): HTMLElement {
  const trigger = screen.getByRole('button', { name: /Key elements ·/ });
  const bar = trigger.closest('div')?.parentElement;
  if (!(bar instanceof HTMLElement)) throw new Error('key elements bar not found');
  return bar;
}

describe('storyboard key elements bar', () => {
  it('no key elements at all -> the top bar is not rendered', () => {
    seed([imageNode('a', { displayName: 'Character A' })]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Key elements ·/ })).not.toBeInTheDocument();
  });

  it('marked nodes -> the top bar renders their chips (thumbnail + name)', () => {
    seed([
      imageNode('a', { displayName: 'Hero portrait', keyElementCategory: 'character' }),
      imageNode('b', { displayName: 'Plain image' }),
    ]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    const bar = keyElementsBar();
    expect(within(bar).getByRole('button', { name: 'Hero portrait' })).toBeInTheDocument();
    // Unmarked ones do not enter the bar.
    expect(within(bar).queryByRole('button', { name: 'Plain image' })).not.toBeInTheDocument();
  });

  it('category filter: switching to "Scene" keeps only scene key elements', async () => {
    const user = userEvent.setup();
    seed([
      imageNode('a', { displayName: 'Hero portrait', keyElementCategory: 'character' }),
      imageNode('b', { displayName: 'Forest scene', keyElementCategory: 'scene' }),
    ]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    // Default "All": both are in the bar (scoped with within to avoid the same-named cards in the image column).
    expect(within(keyElementsBar()).getByRole('button', { name: 'Hero portrait' })).toBeInTheDocument();
    expect(within(keyElementsBar()).getByRole('button', { name: 'Forest scene' })).toBeInTheDocument();

    // Open the category dropdown and switch to "Scene".
    await user.click(screen.getByRole('button', { name: /Key elements ·/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Scene' }));

    expect(within(keyElementsBar()).queryByRole('button', { name: 'Hero portrait' })).not.toBeInTheDocument();
    expect(within(keyElementsBar()).getByRole('button', { name: 'Forest scene' })).toBeInTheDocument();
  });

  it('clicking a chip -> opens that node\'s detail', () => {
    seed([imageNode('a', { displayName: 'Hero portrait', keyElementCategory: 'character' })]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    fireEvent.click(within(keyElementsBar()).getByRole('button', { name: 'Hero portrait' }));
    expect(screen.getByRole('region', { name: 'Asset details' })).toBeInTheDocument();
  });

  it('key elements get an "Add to chat" pill entry (mirrors liblib\'s hover overlay)', async () => {
    // The overlay goes through a Tooltip Portal; in a real browser CSS makes it visible only on hover;
    // jsdom has no CSS, so only assert that the entry mounts and its accessible name matches; visibility is left to the manual/visual verification above.
    const user = userEvent.setup();
    seed([imageNode('a', { displayName: 'Hero portrait', keyElementCategory: 'character' })]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    await user.hover(within(keyElementsBar()).getByRole('button', { name: 'Hero portrait' }));
    expect(await screen.findByRole('button', { name: 'Add to chat' })).toBeInTheDocument();
  });

  it('clicking the pill -> goes through the add-nodes-to-chat event with that node id, and does not open the detail', async () => {
    const user = userEvent.setup();
    seed([imageNode('a', { displayName: 'Hero portrait', keyElementCategory: 'character' })]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    await user.hover(within(keyElementsBar()).getByRole('button', { name: 'Hero portrait' }));
    const pill = await screen.findByRole('button', { name: 'Add to chat' });
    const events = captureAddToChat(() => {
      fireEvent.click(pill);
    });
    expect(events).toEqual([['a']]);
    // Clicking the pill does not accidentally trigger the thumbnail's "open detail".
    expect(screen.queryByRole('region', { name: 'Asset details' })).not.toBeInTheDocument();
  });

  it('key elements + audio -> two top-bar tabs, and switching to "Audio" shows the audio chips (mirrors liblib)', async () => {
    const user = userEvent.setup();
    seed([
      imageNode('a', { displayName: 'Hero portrait', keyElementCategory: 'character' }),
      audioNode('bg', { displayName: 'Background music' }),
    ]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    // Both tabs coexist.
    expect(screen.getByRole('button', { name: /Key elements ·/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Audio' })).toBeInTheDocument();
    // Default key-elements tab: the bar holds key-element chips, and audio chips are not rendered.
    expect(within(keyElementsBar()).getByRole('button', { name: 'Hero portrait' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Background music' })).not.toBeInTheDocument();

    // Switch to the audio tab -> audio chips appear, and key-element chips collapse.
    await user.click(screen.getByRole('button', { name: 'Audio' }));
    expect(within(keyElementsBar()).getByRole('button', { name: 'Background music' })).toBeInTheDocument();
    expect(within(keyElementsBar()).queryByRole('button', { name: 'Hero portrait' })).not.toBeInTheDocument();
  });

  it('in overview state it sits above the three columns; entering the detail it indents into the left column (the whole right half goes to the detail panel)', () => {
    seed([imageNode('a', { displayName: 'Hero portrait', keyElementCategory: 'character' })]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    // Overview state: the key elements bar and the three-column container are siblings, not inside any column.
    const columns = screen.getByTestId('asset-board-columns');
    expect(columns.contains(keyElementsBar())).toBe(false);

    // Entering the detail: the key elements bar and the narrow left list share one left-column container, while the detail panel is outside it.
    fireEvent.click(within(keyElementsBar()).getByRole('button', { name: 'Hero portrait' }));
    const detail = screen.getByRole('region', { name: 'Asset details' });
    const leftColumn = keyElementsBar().parentElement as HTMLElement;
    expect(leftColumn.contains(detail)).toBe(false);
    // The left column also holds the narrow list (the column-switch dropdown is its title slot).
    expect(within(leftColumn).getByRole('button', { name: /Switch column|Images|Videos|Text/ })).toBeTruthy();
  });
});
