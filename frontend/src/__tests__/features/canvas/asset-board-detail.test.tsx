// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import { useCanvasStore } from '@/stores/canvasStore';

// Model-task access is mocked: the test tree has no auth/query providers.
vi.mock('@/lib/model-task-access', () => ({
  useModelTaskAccess: () => ({ blocked: false, denialReason: null, message: null }),
}));

// Grid live pricing (M2) uses react-query's useGenerationCreditCost, and the test tree has no
// QueryClientProvider -- mock it out so the component falls back to the hard-coded cost display.
vi.mock('@/lib/queries/generation-credit-cost', () => ({
  useGenerationCreditCost: () => ({ data: undefined }),
}));

function seedBoard() {
  const nodes: CanvasNode[] = [
    {
      id: 'text-1',
      type: CANVAS_NODE_TYPES.textAnnotation,
      position: { x: 0, y: 0 },
      data: { content: '# Project info\n\nBrand: Light & Shadow', displayName: 'Anchor list' },
    },
    {
      id: 'img-1',
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 0, y: 100 },
      data: {
        imageUrl: '/static/img1.png',
      prompt: 'Nine-grid pencil line-art storyboard sketch',
        model: 'test-model',
        size: '1K',
        aspectRatio: '1:1',
      displayName: 'Storyboard sketch',
      },
    },
    {
      id: 'img-2',
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 200, y: 100 },
      data: {
        imageUrl: '/static/img2.png',
        prompt: '',
        model: 'test-model',
        size: '1K',
        aspectRatio: '1:1',
      displayName: 'Second image',
      },
    },
    {
      id: 'ref-1',
      type: CANVAS_NODE_TYPES.upload,
      position: { x: 400, y: 100 },
      data: { imageUrl: '/static/ref.png', aspectRatio: '1:1', displayName: 'Character reference' },
    },
    {
  // videoCompose (final cut / composition) is a read-only video node with no generation form: its detail still renders
  // the read-only "Reference assets" row at the bottom (the cross-column "edit/locate" cases below rely on it). A regular video
  // generation node has a form and the bottom row is dropped by !showGenerationForm; a separate case covers that.
      id: 'vid-1',
      type: CANVAS_NODE_TYPES.videoCompose,
      position: { x: 0, y: 300 },
      data: {
        videoUrl: '/static/v.mp4',
        previewImageUrl: '/static/poster.png',
        aspectRatio: '16:9',
        durationSec: 5,
        widthPx: 1280,
        heightPx: 720,
      displayName: 'Final video',
      },
    },
    {
  // Regular video generation node: the detail mounts the generation form, and duration/resolution live in the form's bottom row.
      id: 'vid-gen',
      type: CANVAS_NODE_TYPES.video,
      position: { x: 200, y: 300 },
      data: {
        videoUrl: '/static/gen.mp4',
        aspectRatio: '16:9',
        durationSec: 4,
        widthPx: 1280,
        heightPx: 720,
      displayName: 'Generated video',
      },
    },
  ];
  // Character reference (uploaded image) -> final video: the source of the video card/detail "Reference assets".
  const edges: CanvasEdge[] = [{ id: 'e1', source: 'ref-1', target: 'vid-1' }];
  useCanvasStore.getState().setCanvasData(nodes, edges);
}

function renderBoard() {
  const onLocateNode = vi.fn();
  render(<AssetBoardView visible onLocateNode={onLocateNode} />);
  return { onLocateNode };
}

function detailPanel() {
  return screen.getByRole('region', { name: 'Asset details' });
}

// jsdom does not implement scrollIntoView: locating a reference asset calls it on the referenced card,
// so attach a shared mock to the prototype to avoid errors and to assert that "Locate" triggered scrolling.
const scrollIntoViewMock = vi.fn();

describe('AssetBoard master-detail', () => {
  beforeEach(() => {
    scrollIntoViewMock.mockClear();
    Element.prototype.scrollIntoView = scrollIntoViewMock;
    seedBoard();
  });

  it('clicking an image card -> detail panel appears, the other two columns hide, only the clicked column keeps a narrow list', () => {
    renderBoard();
    expect(screen.getByText('Text')).toBeInTheDocument();
    expect(screen.getByText('Videos')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Storyboard sketch' }));

    const detail = detailPanel();
    expect(within(detail).getByText('Storyboard sketch')).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'View enlarged' })).toBeInTheDocument();
    expect(within(detail).getByText('Nine-grid pencil line-art storyboard sketch')).toBeInTheDocument();
    // The detail panel no longer offers a "Locate on canvas" entry (locating goes through card hover / reference jumps).
    expect(within(detail).queryByRole('button', { name: /Locate on canvas/ })).not.toBeInTheDocument();
    // The image column's narrow list stays; the text/video columns disappear.
    expect(screen.getByText('Images')).toBeInTheDocument();
    expect(screen.queryByText('Text')).not.toBeInTheDocument();
    expect(screen.queryByText('Videos')).not.toBeInTheDocument();
  });

  it('clicking another item in the left column -> detail switches to that item', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Storyboard sketch' }));
    expect(within(detailPanel()).getByText('Storyboard sketch')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Second image' }));

    const detail = detailPanel();
    expect(within(detail).getByText('Second image')).toBeInTheDocument();
    expect(within(detail).queryByText('Storyboard sketch')).not.toBeInTheDocument();
  });

  it('x close details -> back to the three-column layout', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Storyboard sketch' }));
    expect(screen.queryByText('Text')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));

    expect(screen.queryByRole('region', { name: 'Asset details' })).not.toBeInTheDocument();
    expect(screen.getByText('Text')).toBeInTheDocument();
    expect(screen.getByText('Images')).toBeInTheDocument();
    expect(screen.getByText('Videos')).toBeInTheDocument();
  });

  it('Esc closes details -> back to the three-column layout', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Storyboard sketch' }));
    expect(screen.queryByRole('region', { name: 'Asset details' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('region', { name: 'Asset details' })).not.toBeInTheDocument();
    expect(screen.getByText('Videos')).toBeInTheDocument();
  });

  it('clicking a text card -> detail renders the full text content (Markdown)', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Anchor list' }));

    const detail = detailPanel();
    // Reading-page title + the heading/body rendered from markdown.
    expect(within(detail).getByRole('heading', { name: 'Anchor list' })).toBeInTheDocument();
    expect(within(detail).getByRole('heading', { name: 'Project info' })).toBeInTheDocument();
    expect(within(detail).getByText('Brand: Light & Shadow')).toBeInTheDocument();
  });

  it('expanding the reference thumbnail menu -> shows the "Edit" and "Locate" items', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Final video' }));

    const referencesGroup = within(detailPanel()).getByRole('group', { name: 'Reference assets' });
    // No menu items before expanding.
    expect(within(referencesGroup).queryByRole('menuitem', { name: 'Edit' })).not.toBeInTheDocument();
    // Clicking the thumbnail opens the small menu (same open/close logic as hover).
    fireEvent.click(within(referencesGroup).getByRole('button', { name: 'Character reference' }));
    expect(within(referencesGroup).getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    expect(within(referencesGroup).getByRole('menuitem', { name: 'Locate' })).toBeInTheDocument();
  });

  it('reference menu "Edit" -> cross-column push of the referenced node detail, Back returns to the original detail', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Final video' }));
    expect(screen.getByText('Videos')).toBeInTheDocument();
    expect(within(detailPanel()).getByText('Final video')).toBeInTheDocument();

    // Reference thumbnail menu -> "Edit" -> push the referenced node (uploaded image, image column) detail.
    // Look the thumbnail up inside the "Reference assets" group only (defensive scope, avoids clashing with the card's inline thumbnails).
    const referencesGroup = within(detailPanel()).getByRole('group', { name: 'Reference assets' });
    fireEvent.click(within(referencesGroup).getByRole('button', { name: 'Character reference' }));
    fireEvent.click(within(referencesGroup).getByRole('menuitem', { name: 'Edit' }));
    expect(within(detailPanel()).getByText('Character reference')).toBeInTheDocument();
    // The left column auto-switches to the matching module list (videos -> images).
    expect(screen.getByText('Images')).toBeInTheDocument();
    expect(screen.queryByText('Videos')).not.toBeInTheDocument();

    // Back pops the stack to the previous detail.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(within(detailPanel()).getByText('Final video')).toBeInTheDocument();
    expect(screen.getByText('Videos')).toBeInTheDocument();
  });

  it('reference menu "Locate" (cross-column) -> back to the three-column overview and scroll to the referenced image card', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Final video' }));
    // Video detail state: the left side keeps only the narrow video list; the image/text columns are absent.
    expect(screen.queryByText('Images')).not.toBeInTheDocument();

    const referencesGroup = within(detailPanel()).getByRole('group', { name: 'Reference assets' });
    fireEvent.click(within(referencesGroup).getByRole('button', { name: 'Character reference' }));
    fireEvent.click(within(referencesGroup).getByRole('menuitem', { name: 'Locate' }));

    // Cross-column (videos -> images) -> detail closes, back to the three-column overview, and the referenced card scrolls into view.
    expect(screen.queryByRole('region', { name: 'Asset details' })).not.toBeInTheDocument();
    expect(screen.getByText('Images')).toBeInTheDocument();
    expect(screen.getByText('Videos')).toBeInTheDocument();
    expect(scrollIntoViewMock).toHaveBeenCalled();
  });

  it('video generation node with an upstream reference -> the bottom read-only "Reference assets" row does not appear (references are carried by the video form chips)', () => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'v-ref',
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 0, y: 0 },
          data: { imageUrl: '/static/v-ref.png', aspectRatio: '1:1', displayName: 'Video reference image' },
        },
        {
          // A regular video node has a generation form -> !showGenerationForm drops the bottom read-only row.
          id: 'v-gen',
          type: CANVAS_NODE_TYPES.video,
          position: { x: 0, y: 200 },
          data: { videoUrl: '/static/v-gen.mp4', aspectRatio: '16:9', displayName: 'Generated video' },
        },
      ],
      [{ id: 'e-vref', source: 'v-ref', target: 'v-gen' }],
    );
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Generated video' }));

    // Generation form present -> no bottom read-only "Reference assets" group (references are shown only by the form's reference chips, not duplicated).
    expect(within(detailPanel()).queryByRole('group', { name: 'Reference assets' })).not.toBeInTheDocument();
  });

  it('reference menu "Locate" (same column) -> keeps the detail, scrolls the narrow list to the referenced card', () => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'loc-a',
          type: CANVAS_NODE_TYPES.imageEdit,
          position: { x: 0, y: 0 },
          data: { imageUrl: '/static/loc-a.png', aspectRatio: '1:1', displayName: 'Locate image A' },
        },
        {
          id: 'loc-b',
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 200, y: 0 },
          data: { imageUrl: '/static/loc-b.png', aspectRatio: '1:1', displayName: 'Locate image B' },
        },
      ],
      // Image B (upload) -> image A: the source of image A's detail "Reference assets", in the same image column as image A.
      [{ id: 'e-b-a', source: 'loc-b', target: 'loc-a' }],
    );
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Locate image A' }));

    const referencesGroup = within(detailPanel()).getByRole('group', { name: 'Reference assets' });
    fireEvent.click(within(referencesGroup).getByRole('button', { name: 'Locate image B' }));
    fireEvent.click(within(referencesGroup).getByRole('menuitem', { name: 'Locate' }));

    // Same column (images -> images) -> detail stays open, and the referenced card in the narrow list scrolls into view.
    expect(screen.getByRole('region', { name: 'Asset details' })).toBeInTheDocument();
    expect(within(detailPanel()).getByText('Locate image A')).toBeInTheDocument();
    expect(scrollIntoViewMock).toHaveBeenCalled();
  });

  it('A->B->A mutual references -> detail stack dedups by (column, nodeId) down to depth 1, Back closes directly', () => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'mut-a',
          type: CANVAS_NODE_TYPES.imageEdit,
          position: { x: 0, y: 0 },
          data: { imageUrl: '/static/a.png', aspectRatio: '1:1', displayName: 'Mutual ref A' },
        },
        {
          id: 'mut-b',
          type: CANVAS_NODE_TYPES.imageEdit,
          position: { x: 200, y: 0 },
          data: { imageUrl: '/static/b.png', aspectRatio: '1:1', displayName: 'Mutual ref B' },
        },
      ],
      [
        // A's "Reference assets" come from its upstream B; B's "Reference assets" come from its upstream A -- mutual references.
        { id: 'e-b-to-a', source: 'mut-b', target: 'mut-a' },
        { id: 'e-a-to-b', source: 'mut-a', target: 'mut-b' },
      ],
    );
    renderBoard();
    // The card itself also inlines reference thumbnails (AssetBoardCard); with mutual references the B card
    // shows a reference thumbnail button with aria-label="Mutual ref A", sharing its name with A's card title button --
    // use getByText to locate the title button precisely (plain-text child) and avoid this button-level name clash.
    fireEvent.click(screen.getByText('Mutual ref A'));
    expect(within(detailPanel()).getByText('Mutual ref A')).toBeInTheDocument();

    // A -> B: reference menu "Edit" -> push, stack depth becomes 2.
    const groupA = within(detailPanel()).getByRole('group', { name: 'Reference assets' });
    fireEvent.click(within(groupA).getByRole('button', { name: 'Mutual ref B' }));
    fireEvent.click(within(groupA).getByRole('menuitem', { name: 'Edit' }));
    expect(within(detailPanel()).getByText('Mutual ref B')).toBeInTheDocument();

    // B -> A: A has already appeared in the stack (bottom layer) -> truncate back to that layer instead of pushing another.
    const groupB = within(detailPanel()).getByRole('group', { name: 'Reference assets' });
    fireEvent.click(within(groupB).getByRole('button', { name: 'Mutual ref A' }));
    fireEvent.click(within(groupB).getByRole('menuitem', { name: 'Edit' }));
    expect(within(detailPanel()).getByText('Mutual ref A')).toBeInTheDocument();

    // Stack depth has converged to 1: Back closes the detail straight to three columns (does not pop back to B first).
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByRole('region', { name: 'Asset details' })).not.toBeInTheDocument();
    expect(screen.getByText('Images')).toBeInTheDocument();
  });

  it('Back at stack depth 1 closes the detail -> back to the three-column layout', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Storyboard sketch' }));
    expect(screen.queryByRole('region', { name: 'Asset details' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.queryByRole('region', { name: 'Asset details' })).not.toBeInTheDocument();
    expect(screen.getByText('Text')).toBeInTheDocument();
    expect(screen.getByText('Images')).toBeInTheDocument();
    expect(screen.getByText('Videos')).toBeInTheDocument();
  });

  it('node deleted while the detail is open -> shows the "This node no longer exists" empty state', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Storyboard sketch' }));
    expect(within(detailPanel()).getByText('Storyboard sketch')).toBeInTheDocument();

    act(() => {
      const state = useCanvasStore.getState();
      state.setCanvasData(
        state.nodes.filter((node) => node.id !== 'img-1'),
        state.edges,
      );
    });

    expect(within(detailPanel()).getByText('This node no longer exists')).toBeInTheDocument();
    expect(within(detailPanel()).queryByText('Storyboard sketch')).not.toBeInTheDocument();
  });

  it('generating node -> detail media area shows the generating placeholder (no large image rendered)', () => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'gen-1',
          type: CANVAS_NODE_TYPES.imageEdit,
          position: { x: 0, y: 0 },
          // generationTaskKey: setCanvasData zeroes isGenerating when there is no recoverable handle
          // (to stop interrupted tasks spinning forever); carry a task handle to keep the generating state.
          data: {
            imageUrl: null,
            isGenerating: true,
            generationTaskKey: 'task-1',
            aspectRatio: '1:1',
            displayName: 'Generating image',
          },
        },
      ],
      [],
    );
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Generating image' }));

    const detail = detailPanel();
    // generationStartedAt not given -> the estimate hook degrades to "time from mount", so it renders 0% at the first instant.
    expect(within(detail).getByText('Generating 0%...')).toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: 'View enlarged' })).not.toBeInTheDocument();
  });

  it('generating with existing media (regeneration) -> keeps the original image and overlays the generating mask', () => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'regen-1',
          type: CANVAS_NODE_TYPES.imageEdit,
          position: { x: 0, y: 0 },
          data: {
            imageUrl: '/static/regen.png',
            isGenerating: true,
            generationTaskKey: 'task-2',
            aspectRatio: '1:1',
            displayName: 'Regenerated image',
          },
        },
      ],
      [],
    );
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Regenerated image' }));

    const detail = detailPanel();
    // The old image is not displaced by the generating state (regeneration keeps the old url in place); the mask overlays it.
    expect(within(detail).getByAltText('Regenerated image')).toBeInTheDocument();
    expect(within(detail).getByRole('status', { name: 'Generating' })).toBeInTheDocument();
    // Regeneration goes through GeneratingOverlay (pure spinner, no percentage text) -- the placeholder branch's
    // "Generating X%..." text does not appear together with the mask.
    expect(within(detail).queryByText(/^Generating \d+%\.\.\.$/)).not.toBeInTheDocument();
    // Enlarged view is blocked while generating (the keyboard path is blocked too, not just a visual mask on top).
    expect(within(detail).getByRole('button', { name: 'View enlarged' })).toBeDisabled();
  });

  it('failed node -> a red error bar appears below the detail header', () => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'err-1',
          type: CANVAS_NODE_TYPES.imageEdit,
          position: { x: 0, y: 0 },
          data: {
            imageUrl: '/static/err.png',
            generationError: 'Insufficient compute, generation failed',
            aspectRatio: '1:1',
            displayName: 'Failed image',
          },
        },
      ],
      [],
    );
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Failed image' }));

    expect(within(detailPanel()).getByText('Insufficient compute, generation failed')).toBeInTheDocument();
  });

  it('clicking a card does not trigger onLocateNode; the detail panel no longer offers a "Locate on canvas" entry', () => {
    const { onLocateNode } = renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Anchor list' }));
    expect(onLocateNode).not.toHaveBeenCalled();

    // The locate button has been removed from the detail panel entirely (four detail kinds: text/image/video/audio);
    // locating now goes through the card-hover crosshair button and is unrelated to this detail panel.
    expect(within(detailPanel()).queryByRole('button', { name: /Locate on canvas/ })).not.toBeInTheDocument();
    expect(onLocateNode).not.toHaveBeenCalled();
  });
});

describe('AssetBoard detail-state narrow left list column-switch dropdown', () => {
  beforeEach(() => {
    scrollIntoViewMock.mockClear();
    Element.prototype.scrollIntoView = scrollIntoViewMock;
    seedBoard();
  });

  function openSwitcher(currentLabel: string): HTMLElement {
    // The header dropdown trigger = the current column's name (a button without aria-label, so findable by name).
    fireEvent.click(screen.getByRole('button', { name: currentLabel }));
    return screen.getByRole('menu', { name: 'Switch column' });
  }

  it('image detail left-list header is a column-switch dropdown: expands to "Text/Images/Videos", with the current "Images" checked', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Storyboard sketch' }));

    const trigger = screen.getByRole('button', { name: 'Images' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    // No menu items before expanding.
    expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument();

    const menu = openSwitcher('Images');
    expect(within(menu).getByRole('menuitemradio', { name: 'Text' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitemradio', { name: 'Images' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitemradio', { name: 'Videos' })).toBeInTheDocument();
    // The column currently shown (Images) is checked, the others are not.
    expect(within(menu).getByRole('menuitemradio', { name: 'Images', checked: true })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitemradio', { name: 'Text', checked: false })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitemradio', { name: 'Videos', checked: false })).toBeInTheDocument();
  });

  it('switching to "Videos" -> left list becomes video cards, the right detail stays the original image (does not change with the column switch)', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Storyboard sketch' }));
    // Right detail = Storyboard sketch; the left list is currently the image column (with another image card).
    expect(within(detailPanel()).getByText('Storyboard sketch')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Second image' })).toBeInTheDocument();

    fireEvent.click(within(openSwitcher('Images')).getByRole('menuitemradio', { name: 'Videos' }));

    // The left list becomes video cards, the image card disappears, and the trigger becomes "Videos".
    expect(screen.getByRole('button', { name: 'Final video' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Second image' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Videos' })).toBeInTheDocument();
    // The right detail is unchanged (switching columns only changes the list browsed on the left).
    expect(within(detailPanel()).getByText('Storyboard sketch')).toBeInTheDocument();
  });

  it('after switching columns, clicking a card in the left list -> opens that node detail and the left list follows to that card\'s column', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Storyboard sketch' }));
    // In the image detail, switch the left list to browse videos.
    fireEvent.click(within(openSwitcher('Images')).getByRole('menuitemradio', { name: 'Videos' }));

    // Click a video card in the left list -> opens that video detail.
    fireEvent.click(screen.getByRole('button', { name: 'Final video' }));
    expect(within(detailPanel()).getByText('Final video')).toBeInTheDocument();
    // "The column of the clicked card is the column of the left list": still the video column (trigger "Videos" + video card in the left list).
    expect(screen.getByRole('button', { name: 'Videos' })).toBeInTheDocument();
  });

  it('after switching columns, a reference jump on the right pushes a new detail -> left list resets to the new detail\'s column', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Final video' }));
    // Manually switch the left list from "Videos" to "Text".
    fireEvent.click(within(openSwitcher('Videos')).getByRole('menuitemradio', { name: 'Text' }));
    expect(screen.getByRole('button', { name: 'Text' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Anchor list' })).toBeInTheDocument();

    // The right-hand video detail's reference assets "Edit" -> push the referenced image (Character reference) detail.
    const referencesGroup = within(detailPanel()).getByRole('group', { name: 'Reference assets' });
    fireEvent.click(within(referencesGroup).getByRole('button', { name: 'Character reference' }));
    fireEvent.click(within(referencesGroup).getByRole('menuitem', { name: 'Edit' }));

    // New detail = Character reference (image column) -> left list resets to images (no longer stays on the text the user picked before).
    expect(within(detailPanel()).getByText('Character reference')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Images' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Anchor list' })).not.toBeInTheDocument();
  });

  it('empty state: switching to a column with no cards shows that column\'s empty-state copy', () => {
    // Only image nodes: switching to the text/video column should show the matching empty state.
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'only-img',
          type: CANVAS_NODE_TYPES.imageEdit,
          position: { x: 0, y: 0 },
          data: { imageUrl: '/static/only.png', aspectRatio: '1:1', displayName: 'Only image' },
        },
      ],
      [],
    );
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Only image' }));

    fireEvent.click(within(openSwitcher('Images')).getByRole('menuitemradio', { name: 'Videos' }));
    expect(screen.getByText('No video nodes on the canvas yet')).toBeInTheDocument();

    fireEvent.click(within(openSwitcher('Videos')).getByRole('menuitemradio', { name: 'Text' }));
    expect(screen.getByText('No text nodes on the canvas yet')).toBeInTheDocument();
  });

  it('video detail with a generation form no longer renders duplicate duration/resolution badges (the form\'s bottom row already has them)', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Generated video' }));

    const detail = detailPanel();
    // Only the form's own bottom row shows the duration; the detail header badge must not duplicate it.
    expect(within(detail).queryAllByText('4s')).toHaveLength(1);
    expect(within(detail).queryByText('1280 × 720')).not.toBeInTheDocument();
  });

  it('video detail without a generation form (final cut) still shows the duration/resolution badges -- the only place they appear', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Final video' }));

    const detail = detailPanel();
    expect(within(detail).getByText('5s')).toBeInTheDocument();
    expect(within(detail).getByText('1280 × 720')).toBeInTheDocument();
  });
});
