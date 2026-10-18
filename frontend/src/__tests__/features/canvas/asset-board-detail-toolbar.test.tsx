// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { __resetAssetBoardImageOpsStateForTest } from '@/features/canvas/ui/asset-board/AssetBoardImageEditMenu';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import { useCanvasStore } from '@/stores/canvasStore';

// Clicking an audio chip to open the detail mounts the waveform player: it needs ResizeObserver + a canvas 2D context,
// and the decode fetch(src) hangs without settling (otherwise a console.warn after the test ends triggers a teardown error).
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverMock);
HTMLCanvasElement.prototype.getContext = vi.fn(
  () => null,
) as unknown as typeof HTMLCanvasElement.prototype.getContext;
vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

// ImageViewerModal / the detail toolbar depend on useTranslation (VideoComposeModal etc.).
vi.mock('@/lib/model-task-access', () => ({
  useModelTaskAccess: () => ({ blocked: false, denialReason: null, message: null }),
}));

// For busy-state isolation tests: returns a controllable { nodeId, completion }, avoiding the real panorama generation chain (network).
const scene360ImageMock = vi.hoisted(() => vi.fn());
vi.mock('@/features/canvas/application/imageScene360', () => ({
  scene360Image: scene360ImageMock,
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
      data: { content: 'Original content', displayName: 'Anchor list' },
    },
    {
      // Second text node: the target used to verify that the detail body updates by node.id when switching to another node.
      id: 'text-2',
      type: CANVAS_NODE_TYPES.textAnnotation,
      position: { x: 200, y: 0 },
      data: { content: 'Content B', displayName: 'Second list' },
    },
    {
      // upload node: the full image toolbar form (imageEdit hides edit-type operations by workflow semantics).
      id: 'img-up',
      type: CANVAS_NODE_TYPES.upload,
      position: { x: 0, y: 100 },
      data: { imageUrl: '/static/up.png', aspectRatio: '1:1', displayName: 'Uploaded image' },
    },
    {
      // Second image node: the switch target for the busy-state cross-node misalignment regression case.
      id: 'img-up-2',
      type: CANVAS_NODE_TYPES.upload,
      position: { x: 200, y: 100 },
      data: { imageUrl: '/static/up2.png', aspectRatio: '1:1', displayName: 'Second uploaded image' },
    },
    {
      id: 'vid-1',
      type: CANVAS_NODE_TYPES.video,
      position: { x: 0, y: 300 },
      data: {
        videoUrl: '/static/v.mp4',
        prompt: 'A single shot',
        aspectRatio: '16:9',
        displayName: 'Final video',
      },
    },
    {
      // Empty-content node (params ready, not yet submitted for generation): the toolbar should not render at all.
      id: 'vid-empty',
      type: CANVAS_NODE_TYPES.video,
      position: { x: 400, y: 300 },
      data: { prompt: 'Not generated yet', aspectRatio: '16:9', displayName: 'Empty video' },
    },
    {
      id: 'img-empty',
      type: CANVAS_NODE_TYPES.imageGen,
      position: { x: 400, y: 100 },
      data: { prompt: 'Not generated yet', aspectRatio: '1:1', displayName: 'Empty image' },
    },
    {
      // Failed video: no media source, but "History" may hold a previous successful result -> the toolbar should be kept.
      id: 'vid-failed',
      type: CANVAS_NODE_TYPES.video,
      position: { x: 600, y: 300 },
      data: {
        prompt: 'A failed shot',
        aspectRatio: '16:9',
        displayName: 'Failed video',
        generationError: 'Insufficient compute, generation failed',
      },
    },
    {
      // Audio node: used by the case where all four column details carry the "Node actions" menu in the header.
      id: 'aud-1',
      type: CANVAS_NODE_TYPES.audio,
      position: { x: 0, y: 500 },
      data: { audioUrl: '/static/bgm.mp3', displayName: 'Background music' },
    },
  ];
  const edges: CanvasEdge[] = [];
  useCanvasStore.getState().setCanvasData(nodes, edges);
}

function detailPanel() {
  return screen.getByRole('region', { name: 'Asset details' });
}

// The three edit items (Upscale/Crop/Rotate) live in the "..." more menu -- expand it first.
// (Grid templates are a standalone dropdown on the always-visible toolbar, not inside this menu.)
function openMoreMenu(detail: HTMLElement) {
  fireEvent.click(within(detail).getByRole('button', { name: 'More' }));
}

describe('AssetBoard detail toolbar (batch 1 assembly)', () => {
  beforeEach(() => {
    scene360ImageMock.mockReset();
    // The busy registry is module-level (survives remounts); not clearing it between cases would leak state.
    __resetAssetBoardImageOpsStateForTest();
    seedBoard();
  });

  it('image detail: Download/Panorama/Multi-angle/Relight/Grid templates are always visible, with the three edit items folded into the "..." more menu', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Uploaded image' }));

    const detail = detailPanel();
    // Always-visible items are directly visible (Grid templates moved from "..." to the always-visible dropdown).
    for (const label of ['Download', 'Panorama', 'Multi-angle', 'Relight', 'Grid templates', 'More']) {
      expect(within(detail).getByRole('button', { name: label })).toBeInTheDocument();
    }
    // The "Edit" dropdown was removed; its three items are now what lives in "...".
    expect(within(detail).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    // Items folded into "..." are not visible before expanding.
    for (const label of ['Upscale', 'Crop', 'Rotate']) {
      expect(within(detail).queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
    // After expanding the "..." more menu, these items are reachable.
    openMoreMenu(detail);
    for (const label of ['Upscale', 'Crop', 'Rotate']) {
      expect(within(detail).getByRole('button', { name: label })).toBeInTheDocument();
    }
    // Old menu items the user decided to remove (the capability still lives on the workflow side NodeActionToolbar) must not appear at all.
    for (const label of ['Cutout', 'Annotate', 'Extract cells', 'History']) {
      expect(within(detail).queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
    // The uploaded-image node has no retryable generation payload -> Regenerate is not shown.
    expect(within(detail).queryByRole('button', { name: 'Regenerate' })).not.toBeInTheDocument();
  });

  it('image detail: the always-visible "Grid templates" dropdown expands to 9 template items', async () => {
    const user = userEvent.setup();
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Uploaded image' }));

    const detail = detailPanel();
    // Sub-templates are not visible before expanding.
    expect(screen.queryByRole('menuitem', { name: /Multi-Camera 3x3/ })).not.toBeInTheDocument();
    // Click the always-visible "Grid templates" dropdown (the Radix menu portals to body and items use the menuitem role).
    await user.click(within(detail).getByRole('button', { name: 'Grid templates' }));
    for (const label of ['Multi-Camera 3x3', 'Plot Progression 2x2', '25-Cell Storyboard']) {
      expect(await screen.findByRole('menuitem', { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it('image detail header "Node actions" -> Set key element -> Character writes the marker, and it can be cleared again', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Uploaded image' }));

    // The key-element entry is unified in the "..." at the detail header, not in the toolbar's "More".
    const header = within(detailPanel()).getByRole('banner', { hidden: true });
    fireEvent.click(within(header).getByRole('button', { name: 'Node actions' }));
    fireEvent.click(within(header).getByRole('button', { name: /Set key element/ }));
    // The second-level menu portals to body (to float above the right chat drawer), so look for the child items on screen.
    fireEvent.click(screen.getByRole('button', { name: 'Character' }));
    expect(
      useCanvasStore.getState().nodes.find((n) => n.id === 'img-up')?.data.keyElementCategory,
    ).toBe('character');

    // After marking, the submenu title becomes "Key element · Character" and a "Remove key element" appears. Click it to clear.
    fireEvent.click(screen.getByRole('button', { name: 'Remove key element' }));
    expect(
      useCanvasStore.getState().nodes.find((n) => n.id === 'img-up')?.data.keyElementCategory,
    ).toBeNull();
  });

  it('the toolbar\'s "More" no longer repeats "Set key element" (it is unified in the header)', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Uploaded image' }));

    const detail = detailPanel();
    openMoreMenu(detail);
    expect(within(detail).queryByRole('button', { name: /Set key element/ })).not.toBeInTheDocument();
  });

  it('video detail: only Edit/Upscale/Download/Fullscreen remain; Upscale expands a config popover', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Final video' }));

    const detail = detailPanel();
    for (const label of ['Edit', 'Upscale', 'Download', 'Fullscreen']) {
      expect(within(detail).getByRole('button', { name: label })).toBeInTheDocument();
    }
    // The other video features were removed from the storyboard (user asked to cut down to four items).
    for (const label of [
      'Smart subtitle removal',
      'Translate prompt',
      'History',
      'Edit track',
      'Parse',
      'Separate audio and video',
      'Capture frame',
      'Replace video',
      'Box erase',
    ]) {
      expect(within(detail).queryByRole('button', { name: label })).not.toBeInTheDocument();
    }

    fireEvent.click(within(detail).getByRole('button', { name: 'Upscale' }));
    expect(within(detail).getByText('Resolution')).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: '2K' })).toBeInTheDocument();
    expect(within(detail).queryByText('Denoise')).not.toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'Submit upscale' })).toBeInTheDocument();
  });

  it('empty-content video node (no clip yet): the whole toolbar does not render', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Empty video' }));

    const detail = detailPanel();
    for (const label of ['Edit', 'Upscale', 'Download', 'Fullscreen']) {
      expect(within(detail).queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
  });

  it('empty-content image node (no image yet): the whole toolbar does not render', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Empty image' }));

    const detail = detailPanel();
    expect(within(detail).queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
  });

  it('failed video node: the toolbar does not render (all four operations need a media source; a row of grey buttons is just noise)', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Failed video' }));

    const detail = detailPanel();
    // The failure reason is still given by the red bar under the header (see AssetBoardDetail).
    expect(within(detail).getByText('Insufficient compute, generation failed')).toBeInTheDocument();
    for (const label of ['Edit', 'Upscale', 'Download', 'Fullscreen']) {
      expect(within(detail).queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
  });

  it('a video node with a media source still gets its toolbar as usual (the empty-state check does not hit already-rendered clips by mistake)', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Final video' }));
    expect(within(detailPanel()).getByRole('button', { name: 'Download' })).toBeInTheDocument();
  });

  it('video detail header "...": Set key element (writes a category, can be cancelled) / Create copy / Delete', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Empty video' }));

    const header = within(detailPanel()).getByRole('banner', { hidden: true });
    fireEvent.click(within(header).getByRole('button', { name: 'Node actions' }));
    for (const label of ['Set key element', 'Create copy', 'Delete']) {
      expect(within(header).getByRole('button', { name: new RegExp(label) })).toBeInTheDocument();
    }

    // Expand the submenu and pick "Character" -> writes the node marker; the menu title becomes "Key element · Character" accordingly.
    // Look up the child item from screen rather than within(header): the flyout second-level panel is portaled to body (otherwise
    // the right chat drawer would cover it, see DetailMoreMenu's placeSubmenu), so it is not in the header subtree in the DOM.
    fireEvent.click(within(header).getByRole('button', { name: /Set key element/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Character' }));
    expect(
      useCanvasStore.getState().nodes.find((n) => n.id === 'vid-empty')?.data.keyElementCategory,
    ).toBe('character');
    expect(within(header).getByRole('button', { name: /Key element · Character/ })).toBeInTheDocument();
  });

  it('video detail header "..." -> Create copy: clones the node and switches the detail to the copy', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Final video' }));
    const idsBefore = new Set(useCanvasStore.getState().nodes.map((n) => n.id));

    const header = within(detailPanel()).getByRole('banner', { hidden: true });
    fireEvent.click(within(header).getByRole('button', { name: 'Node actions' }));
    fireEvent.click(within(header).getByRole('button', { name: 'Create copy' }));

    const clone = useCanvasStore.getState().nodes.find((n) => !idsBefore.has(n.id));
    expect(clone).toBeDefined();
    // The detail really switched to the copy: the header title shows the copy's own name (the copy gets a new number, so its name differs from the source).
    // Asserting only "the detail panel is still there" is a vacuous assertion -- the detail was open already, always true, and would let "clicked but nothing happened" through.
    expect(within(detailPanel()).getByRole('heading')).toHaveTextContent(
      String((clone?.data as { displayName?: string }).displayName),
    );
  });

  it('video detail header "..." -> Delete: the node leaves the canvas and the detail closes', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Empty video' }));

    const header = within(detailPanel()).getByRole('banner', { hidden: true });
    fireEvent.click(within(header).getByRole('button', { name: 'Node actions' }));
    fireEvent.click(within(header).getByRole('button', { name: 'Delete' }));

    expect(useCanvasStore.getState().nodes.find((n) => n.id === 'vid-empty')).toBeUndefined();
    expect(screen.queryByRole('region', { name: 'Asset details' })).not.toBeInTheDocument();
  });

  it.each([
    ['Text', 'Anchor list'],
    ['Images', 'Uploaded image'],
    ['Videos', 'Final video'],
    ['Audio', 'Background music'],
  ])('%s detail header carries the "Node actions" menu (consistent across all four columns)', (_column, cardName) => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: cardName }));

    const header = within(detailPanel()).getByRole('banner', { hidden: true });
    fireEvent.click(within(header).getByRole('button', { name: 'Node actions' }));
    for (const label of ['Set key element', 'Create copy', 'Delete']) {
      expect(within(header).getByRole('button', { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it('text detail: read-only display, offers no "Edit" or "Translate" entry', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Anchor list' }));

    const detail = detailPanel();
    expect(within(detail).getByText('Original content')).toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: 'Translate' })).not.toBeInTheDocument();
    expect(within(detail).queryByPlaceholderText('Enter text…')).not.toBeInTheDocument();
  });

  it('switching the detail item -> text body updates by node.id and does not keep the previous node\'s content', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Anchor list' }));

    let detail = detailPanel();
    expect(within(detail).getByText('Original content')).toBeInTheDocument();

    // Left column switches to another text detail: key={node.id} should force a new instance.
    fireEvent.click(screen.getByRole('button', { name: 'Second list' }));

    detail = detailPanel();
    expect(within(detail).queryByText('Original content')).not.toBeInTheDocument();
    expect(within(detail).getByText('Content B')).toBeInTheDocument();

    // B's content was not overwritten by A's leftover content.
    const nodeB = useCanvasStore.getState().nodes.find((candidate) => candidate.id === 'text-2');
    expect(nodeB?.data).toMatchObject({ content: 'Content B' });
  });

  it('switching the detail item -> toolbar busy state resets (A\'s panorama spinner does not carry over to B)', () => {
    // completion never settles: A's panorama stays in the busy state.
    scene360ImageMock.mockReturnValue({
      nodeId: 'pano-result',
      completion: new Promise(() => {}),
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Uploaded image' }));

    fireEvent.click(within(detailPanel()).getByRole('button', { name: 'Panorama' }));
    expect(scene360ImageMock).toHaveBeenCalledWith('img-up', '/static/up.png', {
      displayName: '360° panorama',
      aspectRatio: '2:1',
    });
    expect(within(detailPanel()).getByRole('button', { name: 'Panorama' })).toBeDisabled();

    // Switch to another image: the busy registry is keyed by nodeId, so B must not inherit A's busy state.
    fireEvent.click(screen.getByRole('button', { name: 'Second uploaded image' }));
    expect(within(detailPanel()).getByRole('button', { name: 'Panorama' })).not.toBeDisabled();
    confirmSpy.mockRestore();
  });

  it('audio chip: clicking opens the detail (no longer locates), and a download button appears on the right', () => {
    const nodes: CanvasNode[] = [
      {
        id: 'aud-1',
        type: CANVAS_NODE_TYPES.audio,
        position: { x: 0, y: 0 },
        data: { audioUrl: '/static/bg.mp3', displayName: 'Background sound' },
      },
    ];
    useCanvasStore.getState().setCanvasData(nodes, []);
    const onLocateNode = vi.fn();
    render(<AssetBoardView visible onLocateNode={onLocateNode} />);

    // Three-column state: there is a download button next to the audio strip chip at the top (the exact name hits only the chip; the download name is "Download Background sound").
    expect(screen.getByRole('button', { name: 'Download Background sound' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Background sound' }));
    // Clicking the main body now opens the detail (waveform + generation form) instead of locating directly.
    expect(detailPanel()).toBeInTheDocument();
    expect(within(detailPanel()).getByRole('slider', { name: 'Audio waveform scrubber' })).toBeInTheDocument();
    expect(onLocateNode).not.toHaveBeenCalled();
  });
});
