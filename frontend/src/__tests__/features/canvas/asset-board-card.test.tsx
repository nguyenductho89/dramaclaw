// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AssetBoardItem } from '@/features/canvas/domain/assetBoard';
import { AssetBoardCard } from '@/features/canvas/ui/asset-board/AssetBoardCard';

function item(overrides: Partial<AssetBoardItem>): AssetBoardItem {
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

describe('AssetBoardCard', () => {
  it('video card renders title + model/duration/resolution badges + final corner badge', () => {
    render(
      <AssetBoardCard
        item={item({
          title: 'SB-01 Light found on the street',
          model: 'wan2.5',
          durationSec: 5,
          widthPx: 720,
          heightPx: 1280,
          videoRole: 'final',
          thumbnailUrl: '/static/poster.png',
        })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={() => {}}
      />,
    );
    expect(screen.getByText('SB-01 Light found on the street')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'SB-01 Light found on the street' })).toBeInTheDocument();
    expect(screen.getByText('wan2.5')).toBeInTheDocument();
    expect(screen.getByText('5s')).toBeInTheDocument();
    expect(screen.getByText('720 × 1280')).toBeInTheDocument();
    expect(screen.getByText('Final')).toBeInTheDocument();
  });

  it('video card without a recorded model -> no placeholder (only duration/resolution remain)', () => {
    render(
      <AssetBoardCard
        item={item({ model: null, durationSec: 5, widthPx: 720, heightPx: 1280 })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={() => {}}
      />,
    );
    expect(screen.getByText('5s')).toBeInTheDocument();
    expect(screen.getByText('720 × 1280')).toBeInTheDocument();
  });

  it('image card node without recorded dimensions -> fills the resolution badge from the image\'s loaded natural size', () => {
    const { container } = render(
      <AssetBoardCard
        item={item({
          column: 'image',
          widthPx: null,
          heightPx: null,
          thumbnailUrl: '/static/a.png',
        })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={() => {}}
      />,
    );
    const img = container.querySelector('img') as HTMLImageElement;
    // jsdom does not really decode images: naturalWidth/complete are always 0/false; stub them by hand as "loaded 1024x768".
    Object.defineProperty(img, 'naturalWidth', { value: 1024, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 768, configurable: true });
    Object.defineProperty(img, 'complete', { value: true, configurable: true });
    fireEvent.load(img);
    expect(screen.getByText('1024 × 768')).toBeInTheDocument();
  });

  it('image card node with recorded dimensions -> node data wins, the image is not read', () => {
    render(
      <AssetBoardCard
        item={item({ column: 'image', widthPx: 800, heightPx: 1328, thumbnailUrl: '/static/a.png' })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={() => {}}
      />,
    );
    expect(screen.getByText('800 × 1328')).toBeInTheDocument();
  });

  it('image card shows only the resolution, with no model badge (user decision: the image column does not show models)', () => {
    render(
      <AssetBoardCard
        item={item({
          column: 'image',
          model: 'seedream4.0',
          widthPx: 800,
          heightPx: 1328,
          thumbnailUrl: '/static/a.png',
        })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={() => {}}
      />,
    );
    expect(screen.getByText('800 × 1328')).toBeInTheDocument();
    expect(screen.queryByText('seedream4.0')).not.toBeInTheDocument();
  });

  it('reference assets row: renders thumbnails when there are references, and clicking triggers onPreviewImage', () => {
    const onPreviewImage = vi.fn();
    render(
      <AssetBoardCard
        item={item({
          references: [
            { nodeId: 'r1', label: 'Character image A', thumbnailUrl: '/static/a.png' },
            { nodeId: 'r2', label: 'Prop image B', thumbnailUrl: '/static/b.png' },
          ],
        })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={onPreviewImage}
      />,
    );
    // The "Reference assets" heading was dropped; only the thumbnails remain.
    expect(screen.queryByText('Reference assets')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Character image A' }));
    expect(onPreviewImage).toHaveBeenCalledWith('/static/a.png');
  });

  it('reference assets hover menu: Edit -> onOpenReference(ref), Locate -> onLocateReference(nodeId), neither bubbles to onOpen', () => {
    const onOpen = vi.fn();
    const onOpenReference = vi.fn();
    const onLocateReference = vi.fn();
    const ref = { nodeId: 'r1', label: 'Character image A', thumbnailUrl: '/static/a.png' };
    render(
      <AssetBoardCard
        item={item({ references: [ref] })}
        onOpen={onOpen}
        onLocate={() => {}}
        onPreviewImage={() => {}}
        onOpenReference={onOpenReference}
        onLocateReference={onLocateReference}
      />,
    );
    const thumb = screen.getByRole('button', { name: 'Character image A' });
    // No menu before hover; it expands only when moving onto the thumbnail (same component as the detail panel's reference menu).
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).not.toBeInTheDocument();
    fireEvent.mouseEnter(thumb.parentElement as HTMLElement);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect(onOpenReference).toHaveBeenCalledWith(ref);

    fireEvent.mouseEnter(thumb.parentElement as HTMLElement);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Locate' }));
    expect(onLocateReference).toHaveBeenCalledWith('r1');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('own reference image (nodeId=null): no card to scroll to in the storyboard -> the menu keeps only "Edit", without "Locate"', () => {
    render(
      <AssetBoardCard
        item={item({
          references: [{ nodeId: null, label: 'Own image', thumbnailUrl: '/static/own.png' }],
        })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={() => {}}
        onOpenReference={() => {}}
        onLocateReference={() => {}}
      />,
    );
    const thumb = screen.getByRole('button', { name: 'Own image' });
    fireEvent.mouseEnter(thumb.parentElement as HTMLElement);
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Locate' })).not.toBeInTheDocument();
  });

  it('with the menu attached, clicking the thumbnail still opens the lightbox preview (the menu is driven by hover only)', () => {
    const onPreviewImage = vi.fn();
    render(
      <AssetBoardCard
        item={item({
          references: [{ nodeId: 'r1', label: 'Character image A', thumbnailUrl: '/static/a.png' }],
        })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={onPreviewImage}
        onOpenReference={() => {}}
        onLocateReference={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Character image A' }));
    expect(onPreviewImage).toHaveBeenCalledWith('/static/a.png');
  });

  it('without reference callbacks (pure-navigation narrow list) -> bare thumbnails, no menu attached', () => {
    const onPreviewImage = vi.fn();
    render(
      <AssetBoardCard
        item={item({
          references: [{ nodeId: 'r1', label: 'Character image A', thumbnailUrl: '/static/a.png' }],
        })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={onPreviewImage}
      />,
    );
    const thumb = screen.getByRole('button', { name: 'Character image A' });
    fireEvent.mouseEnter(thumb.parentElement as HTMLElement);
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).not.toBeInTheDocument();
    fireEvent.click(thumb);
    expect(onPreviewImage).toHaveBeenCalledWith('/static/a.png');
  });

  it('clicking a reference assets thumbnail does not bubble up to trigger onOpen', () => {
    const onOpen = vi.fn();
    render(
      <AssetBoardCard
        item={item({
          references: [{ nodeId: 'r1', label: 'Character image A', thumbnailUrl: '/static/a.png' }],
        })}
        onOpen={onOpen}
        onLocate={() => {}}
        onPreviewImage={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Character image A' }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('a video card with no cover but a mediaUrl renders <video> with src carrying #t=0.1 first-frame positioning', () => {
    const { container } = render(
      <AssetBoardCard
        item={item({ mediaUrl: '/static/clip.mp4', thumbnailUrl: null })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={() => {}}
      />,
    );
    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.getAttribute('src')).toBe('/static/clip.mp4#t=0.1');
  });

  it('clicking the card body triggers onOpen, and clicking the locate button triggers onLocate without bubbling into onOpen', () => {
    const onOpen = vi.fn();
    const onLocate = vi.fn();
    render(
      <AssetBoardCard
        item={item({ title: 'Locate test' })}
        onOpen={onOpen}
        onLocate={onLocate}
        onPreviewImage={() => {}}
      />,
    );
    fireEvent.click(screen.getByText('Locate test'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Locate on canvas' }));
    expect(onLocate).toHaveBeenCalledWith('n1');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('generating (image card): progress "Generating X%..." overlays the media area mask, not trailing the title', () => {
    render(
      <AssetBoardCard
        item={item({ column: 'image', thumbnailUrl: '/static/a.png', isGenerating: true })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={() => {}}
      />,
    );
    const overlay = screen.getByRole('status', { name: 'Generating' });
    // generationStartedAt not given -> the estimate hook degrades to "time from mount", so at the first render
    // elapsed is ~0 and the percentage is 0. The progress text sits in the media mask (same frame as the spinner).
    expect(within(overlay).getByText('Generating 0%...')).toBeInTheDocument();
    // The whole card has just this one "Generating X%" -- no second copy hung on the title row.
    expect(screen.getAllByText(/Generating \d+%/)).toHaveLength(1);
  });

  it('generating (text card): no media area -> progress falls back inline on the title row', () => {
    render(
      <AssetBoardCard
        item={item({ column: 'text', textPreview: 'A script', isGenerating: true })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={() => {}}
      />,
    );
    // The text card has no media mask (role=status), so progress can only hang on the title row.
    expect(screen.queryByRole('status', { name: 'Generating' })).not.toBeInTheDocument();
    expect(screen.getByText('Generating 0%...')).toBeInTheDocument();
  });

  it('generating: with generationStartedAt, the percentage advances by elapsed-time estimate', () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      render(
        <AssetBoardCard
          item={item({
            column: 'image',
            thumbnailUrl: '/static/a.png',
            isGenerating: true,
            generationStartedAt: startedAt,
          })}
          onOpen={() => {}}
          onLocate={() => {}}
          onPreviewImage={() => {}}
        />,
      );
      expect(screen.getByText('Generating 0%...')).toBeInTheDocument();

    // The image column's estimated duration is 20s (see ESTIMATED_GENERATION_DURATION_MS in AssetBoardCard):
    // advancing 4s -> 33 polling ticks of 120ms (the last lands at 3960ms) -> the exponential saturation estimate is 24%.
      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(screen.getByText('Generating 24%...')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('generation failed: the media area shows a "Failed" corner badge, and title carries the error message', () => {
    render(
      <AssetBoardCard
        item={item({ column: 'image', generationError: 'Insufficient compute, generation failed' })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={() => {}}
      />,
    );
    const badge = screen.getByText('Failed');
    expect(badge.closest('[title]')?.getAttribute('title')).toBe('Insufficient compute, generation failed');
  });

  it('text card failed: an inline "Failed" indicator appears beside the title, and title carries the error message', () => {
    render(
      <AssetBoardCard
        item={item({ column: 'text', textPreview: 'Script body', generationError: 'Generation timed out' })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={() => {}}
      />,
    );
    const badge = screen.getByText('Failed');
    expect(badge.closest('[title]')?.getAttribute('title')).toBe('Generation timed out');
  });

  it('locate token: scrollTargetToken changes -> scrolls into view + adds a highlight marker; back to null -> highlight cleared', () => {
    const scrollSpy = vi.fn();
    // jsdom does not implement scrollIntoView -- attach a spy to both avoid errors and assert that "locate" triggers scrolling.
    Element.prototype.scrollIntoView = scrollSpy;
    const fixed = item({ nodeId: 'loc', title: 'Located card' });
    const props = {
      item: fixed,
      onOpen: () => {},
      onLocate: () => {},
      onPreviewImage: () => {},
    };

    const { container, rerender } = render(<AssetBoardCard {...props} scrollTargetToken={null} />);
    const card = container.firstElementChild as HTMLElement;
    expect(card).not.toHaveAttribute('data-locate-highlight');
    expect(scrollSpy).not.toHaveBeenCalled();

    // Token set to 1 (this card is located) -> scroll into view + highlight marker.
    rerender(<AssetBoardCard {...props} scrollTargetToken={1} />);
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(card).toHaveAttribute('data-locate-highlight', 'true');

    // Token changes to 2 (the same card located again) -> triggers scrolling again.
    rerender(<AssetBoardCard {...props} scrollTargetToken={2} />);
    expect(scrollSpy).toHaveBeenCalledTimes(2);

    // Token back to null (locate moved away) -> highlight cleared.
    rerender(<AssetBoardCard {...props} scrollTargetToken={null} />);
    expect(card).not.toHaveAttribute('data-locate-highlight');
  });

  it('text card renders only icon + title, and the body does not enter the list', () => {
    render(
      <AssetBoardCard
        item={item({ column: 'text', title: 'Anchor list', textPreview: 'Ad storyboard script body...' })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Anchor list' })).toBeInTheDocument();
    // The body preview was removed from the list (look in the detail).
    expect(screen.queryByText('Ad storyboard script body...')).not.toBeInTheDocument();
  });
});
