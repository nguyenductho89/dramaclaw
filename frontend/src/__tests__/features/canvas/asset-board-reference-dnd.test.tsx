// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import { referenceDropHintText } from '@/features/canvas/ui/asset-board/AssetBoardReferenceDropZone';
import { BOARD_REFERENCE_DRAG_MIME } from '@/features/canvas/ui/asset-board/boardReferenceDrag';
import { useCanvasStore } from '@/stores/canvasStore';

// Compute-cost quoting goes through react-query and the test tree has no QueryClientProvider -- short-circuit it directly.
vi.mock('@/lib/queries/generation-credit-cost', () => ({
  useGenerationCreditCost: () => ({ data: undefined }),
}));

vi.mock('@/lib/url-params', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/url-params')>()),
  readUrl: () => ({ project: 'demo-project', canvas: 'default' }),
}));

vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/ops')>()),
  fetchFreezoneImageModels: vi.fn(async () => [
    { id: 'huimeng/test-image', providerId: 'huimeng', apiModel: 'test_image_api', label: 'Test model' },
  ]),
  listFreezoneStyleTemplates: vi.fn(async () => []),
  fetchFreezoneCameraOptions: vi.fn(async () => null),
  listFreezoneGenerationHistory: vi.fn(async () => []),
}));

/** dataTransfer stub: a Map backing store + `types` reflecting the keys already set via setData (dragover can only read types). */
function makeDataTransfer() {
  const store = new Map<string, string>();
  return {
    setData: (type: string, value: string) => store.set(type, value),
    getData: (type: string) => store.get(type) ?? '',
    // Entry for the custom drag ghost -- the card calls it on dragStart to swap the ghost for a content-thumbnail-only image.
    setDragImage: vi.fn(),
    get types() {
      return Array.from(store.keys());
    },
    effectAllowed: '',
    dropEffect: '',
  };
}

function seed(nodes: CanvasNode[], edges: CanvasEdge[] = []) {
  useCanvasStore.getState().setCanvasData(nodes, edges);
}

/** The current detail's target image generation node (an empty node is enough: the media area is a placeholder with the full form below). */
function targetImageNode(): CanvasNode {
  return {
    id: 'gen-1',
    type: CANVAS_NODE_TYPES.imageGen,
    position: { x: 0, y: 0 },
    data: {
      imageUrl: null,
      prompt: '',
      aspectRatio: '16:9',
      size: '2K',
      displayName: 'Target image node',
    },
  };
}

/** A draggable reference image card in the left list (an upload node with a thumbnail -> once dropped as upstream it shows as an image chip). */
function referenceImageNode(): CanvasNode {
  return {
    id: 'ref-2',
    type: CANVAS_NODE_TYPES.upload,
    position: { x: 200, y: 0 },
    data: {
      imageUrl: '/static/ref.png',
      previewImageUrl: '/static/ref.png',
      aspectRatio: '1:1',
      displayName: 'Reference image card',
    },
  };
}

function detailPanel() {
  return screen.getByRole('region', { name: 'Asset details' });
}

/**
 * The draggable root element of the card for a given title in the left list. The current detail node's title also appears in the detail toolbar as
 * a button, so getAll + the button "inside a draggable card" filter picks out the real left-list card.
 */
function leftListCard(title: string): HTMLElement {
  for (const button of screen.getAllByRole('button', { name: title })) {
    const card = button.closest('div[draggable="true"]');
    if (card instanceof HTMLElement) return card;
  }
  throw new Error(`draggable card not found for ${title}`);
}

/** A stable drop point inside the drop zone (the generate button is in the form, the form is in the drop layer, and drop bubbles up to the drop layer). */
function dropTarget() {
  return within(detailPanel()).getByRole('button', { name: 'Generate' });
}

describe('Storyboard detail · drag to add a reference', () => {
  it('left-list cards are drag sources (draggable) and write the reference payload when dragged', () => {
    seed([targetImageNode(), referenceImageNode()]);
    render(<AssetBoardView visible onLocateNode={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Target image node' }));

    const card = leftListCard('Reference image card');
    expect(card).toHaveAttribute('draggable', 'true');

    const dt = makeDataTransfer();
    fireEvent.dragStart(card, { dataTransfer: dt });
    expect(dt.getData(BOARD_REFERENCE_DRAG_MIME)).toBe(JSON.stringify({ nodeId: 'ref-2' }));
  });

  it('the drag ghost uses only the content thumbnail, without the title / reference assets panel (setDragImage points to the thumbnail container)', () => {
    seed([targetImageNode(), referenceImageNode()]);
    render(<AssetBoardView visible onLocateNode={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Target image node' }));

    const dt = makeDataTransfer();
    fireEvent.dragStart(leftListCard('Reference image card'), { dataTransfer: dt });

    expect(dt.setDragImage).toHaveBeenCalledTimes(1);
    const dragImageEl = dt.setDragImage.mock.calls[0][0] as HTMLElement;
    // The thumbnail container is passed: it contains the reference thumbnail <img> but is not the draggable whole-card root itself,
    // and it does not contain the title button -> the ghost carries neither the title nor the reference assets panel.
    expect(dragImageEl.querySelector('img')?.getAttribute('src')).toBe('/static/ref.png');
    expect(dragImageEl).not.toHaveAttribute('draggable');
    expect(within(dragImageEl).queryByRole('button', { name: 'Reference image card' })).not.toBeInTheDocument();
  });

  it('dragging over the form reference area -> the highlighted hint text appears', () => {
    seed([targetImageNode(), referenceImageNode()]);
    render(<AssetBoardView visible onLocateNode={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Target image node' }));

    const dt = makeDataTransfer();
    fireEvent.dragStart(leftListCard('Reference image card'), { dataTransfer: dt });
    // There is no hint layer before hovering.
    expect(within(detailPanel()).queryByText(referenceDropHintText())).not.toBeInTheDocument();

    fireEvent.dragEnter(dropTarget(), { dataTransfer: dt });
    expect(within(detailPanel()).getByText(referenceDropHintText())).toBeInTheDocument();

    // It collapses after leaving (the enter/leave counter returns to zero).
    fireEvent.dragLeave(dropTarget(), { dataTransfer: dt });
    expect(within(detailPanel()).queryByText(referenceDropHintText())).not.toBeInTheDocument();
  });

  it('dropping into the form reference area -> the store creates an upstream edge and the reference appears in the form as a thumbnail chip', () => {
    seed([targetImageNode(), referenceImageNode()]);
    render(<AssetBoardView visible onLocateNode={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Target image node' }));

    // Before the drop: no edge, and no reference chip in the form.
    expect(useCanvasStore.getState().edges).toHaveLength(0);
    expect(within(detailPanel()).queryByTitle('Stop referencing this asset')).not.toBeInTheDocument();

    const dt = makeDataTransfer();
    fireEvent.dragStart(leftListCard('Reference image card'), { dataTransfer: dt });
    fireEvent.dragEnter(dropTarget(), { dataTransfer: dt });
    fireEvent.drop(dropTarget(), { dataTransfer: dt });

    // An upstream edge ref-2 -> gen-1 was created (reusing the workflow's addEdge, deterministic id).
    const edges = useCanvasStore.getState().edges;
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: 'ref-2', target: 'gen-1' });

    // After flow-back: the form reference area shows that reference's thumbnail chip (with its own detach button) and the hint layer collapses.
    expect(within(detailPanel()).getByTitle('Stop referencing this asset')).toBeInTheDocument();
    expect(within(detailPanel()).queryByText(referenceDropHintText())).not.toBeInTheDocument();
  });

  it('dedupe: dragging in a node that is already upstream does not create the edge again', () => {
    seed(
      [targetImageNode(), referenceImageNode()],
      [
        {
          id: 'e-ref-2-gen-1',
          source: 'ref-2',
          target: 'gen-1',
          sourceHandle: 'source',
          targetHandle: 'target',
          type: 'disconnectableEdge',
        },
      ],
    );
    render(<AssetBoardView visible onLocateNode={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Target image node' }));

    const dt = makeDataTransfer();
    fireEvent.dragStart(leftListCard('Reference image card'), { dataTransfer: dt });
    fireEvent.drop(dropTarget(), { dataTransfer: dt });

    // There is still only the original edge (addEdge dedupes idempotently by e-source-target).
    expect(useCanvasStore.getState().edges).toHaveLength(1);
  });

  it('dragging the current detail node\'s own card into its own form -> ignored, and no self-loop edge is created', () => {
    seed([targetImageNode(), referenceImageNode()]);
    render(<AssetBoardView visible onLocateNode={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Target image node' }));

    const dt = makeDataTransfer();
    fireEvent.dragStart(leftListCard('Target image node'), { dataTransfer: dt });
    fireEvent.drop(dropTarget(), { dataTransfer: dt });

    expect(useCanvasStore.getState().edges).toHaveLength(0);
  });
});
