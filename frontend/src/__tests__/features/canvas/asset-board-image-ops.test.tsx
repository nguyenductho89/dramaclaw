// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  __resetAssetBoardImageOpsStateForTest,
  inFlightImageOps,
} from '@/features/canvas/ui/asset-board/AssetBoardImageEditMenu';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import { useCanvasStore } from '@/stores/canvasStore';

// The Radix Slider inside MultiAngleEditorPanel / LightEditorPanel depends on
// ResizeObserver (@radix-ui/react-use-size), which jsdom does not implement; same fallback as
// editor-content-split.test.tsx / canvas-skill-manual-connect.test.tsx.
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverMock);

// The detail toolbar's live-price query has no QueryClientProvider -- mock it so it falls back to the hard-coded cost.
vi.mock('@/lib/queries/generation-credit-cost', () => ({
  useGenerationCreditCost: () => ({ data: undefined }),
}));
// The model list also hits the network, so provide a deterministic preferred model.
vi.mock('@/features/canvas/hooks/useFreezoneImageModels', () => ({
  isAuthoritativeEmptyCatalog: () => false,
  useFreezoneImageModels: () => ({
    models: [{ id: 'huimeng/gpt-image-2', apiModel: 'gpt-image-2', label: 'GPT Image 2' }],
  }),
}));

// Orchestration functions of the second batch of operations: verify that "pick params -> submit" passes the right input down, and use a never-settling
// completion to keep the busy state assertable.
const scene360Image = vi.hoisted(() => vi.fn());
const multiAngleImage = vi.hoisted(() => vi.fn());
const relightImage = vi.hoisted(() => vi.fn());
const createUpscaleResultNode = vi.hoisted(() => vi.fn());
const submitImageUpscale = vi.hoisted(() => vi.fn());
const createRotateResultNode = vi.hoisted(() => vi.fn());
const discardRotateResultNode = vi.hoisted(() => vi.fn());
const rotateImageInPlace = vi.hoisted(() => vi.fn());
const createCropResultNode = vi.hoisted(() => vi.fn());
const discardCropResultNode = vi.hoisted(() => vi.fn());
const cropImageInPlace = vi.hoisted(() => vi.fn());

vi.mock('@/features/canvas/application/imageScene360', () => ({ scene360Image }));
vi.mock('@/features/canvas/application/imageMultiAngle', () => ({ multiAngleImage }));
vi.mock('@/features/canvas/application/imageRelight', () => ({ relightImage }));
vi.mock('@/features/canvas/application/imageUpscale', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createUpscaleResultNode,
  submitImageUpscale,
}));
// Rotation mocks only the three side-effect functions and keeps isIdentityRotateTransform real -- the rotate editor's
// "save without any transform" branch is decided by it.
vi.mock('@/features/canvas/application/imageRotate', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createRotateResultNode,
  discardRotateResultNode,
  rotateImageInPlace,
}));
// Same for crop: mock only the three side-effect functions and keep ratio conversion / crop-frame reset / whole-image detection real --
// the assertions "where the crop frame lands after changing ratio" and "confirm without moving the frame" rely on them.
vi.mock('@/features/canvas/application/imageCrop', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createCropResultNode,
  discardCropResultNode,
  cropImageInPlace,
}));

const NEVER = new Promise<void>(() => {});

function seedBoard(extraData: Record<string, unknown> = {}) {
  const nodes: CanvasNode[] = [
    {
      id: 'img-up',
      type: CANVAS_NODE_TYPES.upload,
      position: { x: 0, y: 0 },
      data: {
        imageUrl: '/static/up.png',
        aspectRatio: '1:1',
        displayName: 'Uploaded image',
        ...extraData,
      },
    } as CanvasNode,
    {
      // imageEdit node: by workflow semantics it gets no image-edit entry.
      id: 'img-edit',
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 200, y: 0 },
      data: { imageUrl: '/static/edit.png', displayName: 'Image-edit node' },
    } as CanvasNode,
  ];
  useCanvasStore.getState().setCanvasData(nodes, []);
}

/** Id of the result node pre-built by "Edit -> Upscale", written by seedUpscaleResultNode for assertions. */
let upscaleResultNodeId = '';

/**
 * Reproduce the real side effect of createUpscaleResultNode: build a resultKind:'upscale'
 * result node in the store (not submitted; previewImageUrl is the source image to upscale). After the orchestration function is mocked out,
 * this node must still really exist so the detail can switch to it and the upscale editor below has data to read and write.
 */
function seedUpscaleResultNode(): string {
  upscaleResultNodeId = useCanvasStore.getState().addNode(
    CANVAS_NODE_TYPES.exportImage,
    { x: 320, y: 0 },
    {
      displayName: 'Upscale',
      imageUrl: null,
      previewImageUrl: '/static/up.png',
      resultKind: 'upscale',
      isGenerating: false,
      upscaleSourceUrl: '/static/up.png',
      upscaleModelId: 'huimeng/gpt-image-2',
    } as never,
  );
  return upscaleResultNodeId;
}

function detailPanel() {
  return screen.getByRole('region', { name: 'Asset details' });
}

/**
 * Make the image in the crop editor "finish loading". jsdom does not really decode images (onLoad never fires,
 * naturalWidth is always 0), while the crop frame's coordinates are all computed in natural pixels -- so fill in the size by hand and
 * dispatch load, otherwise the editor stays forever in the "image not measured yet" state and the crop frame never renders.
 */
function loadCropImage(dialog: HTMLElement, width: number, height: number) {
  const img = dialog.querySelector('img');
  expect(img).not.toBeNull();
  Object.defineProperty(img, 'naturalWidth', { value: width, configurable: true });
  Object.defineProperty(img, 'naturalHeight', { value: height, configurable: true });
  fireEvent.load(img as HTMLImageElement);
}

function openDetail(name: string) {
  render(<AssetBoardView visible onLocateNode={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name }));
}

/**
 * Expand the rightmost "..." more menu of the toolbar (the three edit items: Upscale/Crop/Rotate live inside).
 *
 * - Use fireEvent.click rather than user.click: the menu is hover-first (the wrapper has
 *   onMouseEnter -> open), and userEvent's click first dispatches mouseenter to open it,
 *   then the following click is treated as "click again" and closes it. fireEvent sends only click, with clean semantics.
 * - Dedupe by aria-expanded: after one open, clicking a leaf item does not auto-close it (hover-menu convention),
 *   so blindly clicking again would close it instead.
 */
function openMoreMenu(): HTMLElement {
  const detail = detailPanel();
  const trigger = within(detail).getByRole('button', { name: 'More' });
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
  return detail;
}

describe('AssetBoard detail image operations (batch 2: "..." edit items + panorama / multi-angle / relight)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetAssetBoardImageOpsStateForTest();
    upscaleResultNodeId = '';
    seedBoard();
  });

  it('renders the Panorama / Multi-angle / Relight entries; the "..." menu holds Upscale/Crop/Rotate', () => {
    openDetail('Uploaded image');

    const detail = detailPanel();
    for (const label of ['Panorama', 'Multi-angle', 'Relight']) {
      expect(within(detail).getByRole('button', { name: new RegExp(label) })).toBeInTheDocument();
    }
    // The "Edit" dropdown was removed (user request); its three items moved into the rightmost "...".
    expect(within(detail).queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();

    openMoreMenu();
    for (const label of ['Upscale', 'Crop', 'Rotate']) {
      expect(within(detail).getByRole('button', { name: label })).toBeInTheDocument();
    }
    // Inpaint / erase need a mask painted on the image, so the storyboard detail omits them; outpaint was dropped by the user (its slot went to crop).
    for (const label of ['Repaint', 'Erase', 'Outpaint']) {
      expect(within(detail).queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
  });

  it('preset_managed (mainline projection locked) node: "..." hides Upscale and Rotate, keeps Crop', () => {
    seedBoard({ preset_managed: true });
    openDetail('Uploaded image');

    const detail = openMoreMenu();
    // Crop spawns a user_spawned child node, which stays available while locked.
    expect(within(detail).getByRole('button', { name: 'Crop' })).toBeInTheDocument();
    // The two items that rewrite the source image in place are filtered out (same semantics as the workflow NodeActionToolbar).
    expect(within(detail).queryByRole('button', { name: 'Upscale' })).not.toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: 'Rotate' })).not.toBeInTheDocument();
  });

  it('rotate: "..." opens the live-preview editor -> rotate 180 degrees -> save writes back to the pre-built result node', async () => {
    const user = userEvent.setup();
    createRotateResultNode.mockReturnValue('rot-1');
    rotateImageInPlace.mockReturnValue(NEVER);
    openDetail('Uploaded image');

    fireEvent.click(within(openMoreMenu()).getByRole('button', { name: 'Rotate' }));

    // Entering the editor builds the "Rotate result" node (source image untouched), and the editor writes straight back to it.
    expect(createRotateResultNode).toHaveBeenCalledWith('img-up', { displayName: 'Rotate result' });

    const dialog = await screen.findByRole('dialog', { name: 'rotateEditor.title' });
    const preview = dialog.querySelector('img');
    expect(preview).not.toBeNull();
    expect(preview?.style.transform).toBe('rotate(0deg) scale(1, 1)');

    // Each click of "rotate 90 clockwise" adds 90 to the current angle, and the preview follows live (libtv behavior).
    const rotate90 = within(dialog).getByRole('button', { name: 'rotateEditor.rotate90' });
    await user.click(rotate90);
    await user.click(rotate90);
    expect(preview?.style.transform).toBe('rotate(180deg) scale(1, 1)');

    await user.click(within(dialog).getByRole('button', { name: /rotateEditor\.save/ }));

    expect(rotateImageInPlace).toHaveBeenCalledWith('rot-1', expect.stringContaining('up.png'), {
      angleDeg: 180,
      mirrorH: false,
      mirrorV: false,
    });
    // After submit the editor closes, and the source node's "... -> Rotate" goes busy until the background chain settles.
    expect(screen.queryByRole('dialog', { name: 'rotateEditor.title' })).not.toBeInTheDocument();
    expect(inFlightImageOps.get('img-up')).toBe('rotate');
    expect(discardRotateResultNode).not.toHaveBeenCalled();
  });

  it('rotate: exiting directly without submitting recycles the pre-built result node', async () => {
    const user = userEvent.setup();
    createRotateResultNode.mockReturnValue('rot-2');
    openDetail('Uploaded image');

    fireEvent.click(within(openMoreMenu()).getByRole('button', { name: 'Rotate' }));

    const dialog = await screen.findByRole('dialog', { name: 'rotateEditor.title' });
    await user.click(within(dialog).getByRole('button', { name: 'rotateEditor.exit' }));

    expect(rotateImageInPlace).not.toHaveBeenCalled();
    expect(discardRotateResultNode).toHaveBeenCalledWith('rot-2');
    expect(screen.queryByRole('dialog', { name: 'rotateEditor.title' })).not.toBeInTheDocument();
    expect(inFlightImageOps.get('img-up')).toBeUndefined();
  });

  it('imageEdit node: does not get the second-batch image operation entries', () => {
    openDetail('Image-edit node');
    const detail = detailPanel();
    // The three edit items have no image to edit -> the whole "..." is not rendered (otherwise it would open an empty panel).
    expect(within(detail).queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: /Panorama/ })).not.toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: /Multi-angle/ })).not.toBeInTheDocument();
  });

  it('crop: "..." opens the framing editor -> change ratio -> confirm, and the crop frame is written back to the pre-built result node in natural pixels', async () => {
    const user = userEvent.setup();
    createCropResultNode.mockReturnValue('crop-1');
    cropImageInPlace.mockReturnValue(NEVER);
    openDetail('Uploaded image');

    const detail = openMoreMenu();
    fireEvent.click(within(detail).getByRole('button', { name: 'Crop' }));

    // Entering the editor builds the "Crop result" node (source image untouched), and the editor writes straight back to it.
    expect(createCropResultNode).toHaveBeenCalledWith('img-up', { displayName: 'Crop result' });

    const dialog = await screen.findByRole('dialog', { name: 'cropEditor.title' });
    loadCropImage(dialog, 800, 400);

    // The default is "original ratio"; after switching to 1:1 the crop frame resets to the largest centered rectangle at that ratio
    // (400x400 inside 800x400, centered means x=200).
    await user.click(within(dialog).getByRole('button', { name: 'cropEditor.aspectOriginal' }));
    await user.click(await within(dialog).findByRole('option', { name: /1:1/ }));
    await user.click(within(dialog).getByRole('button', { name: 'cropEditor.confirm' }));

    expect(cropImageInPlace).toHaveBeenCalledWith('crop-1', '/static/up.png', {
      x: 200,
      y: 0,
      width: 400,
      height: 400,
    });
    // After submit the editor closes, and the source node's "... -> Crop" goes busy until the background chain settles.
    expect(screen.queryByRole('dialog', { name: 'cropEditor.title' })).not.toBeInTheDocument();
    expect(within(openMoreMenu()).getByRole('button', { name: 'Crop' })).toBeDisabled();
    expect(inFlightImageOps.get('img-up')).toBe('crop');
    expect(discardCropResultNode).not.toHaveBeenCalled();
    // The result node has requested a viewport pre-position (Task 10 pattern).
    expect(useCanvasStore.getState().pendingFocusNodeId).toBe('crop-1');
  });

  it('crop: exiting / confirming without moving the frame both count as not submitted and recycle the pre-built result node', async () => {
    const user = userEvent.setup();
    createCropResultNode.mockReturnValue('crop-2');
    openDetail('Uploaded image');

    fireEvent.click(within(openMoreMenu()).getByRole('button', { name: 'Crop' }));
    let dialog = await screen.findByRole('dialog', { name: 'cropEditor.title' });
    await user.click(within(dialog).getByRole('button', { name: 'cropEditor.exit' }));

    expect(cropImageInPlace).not.toHaveBeenCalled();
    expect(discardCropResultNode).toHaveBeenCalledWith('crop-2');
    expect(screen.queryByRole('dialog', { name: 'cropEditor.title' })).not.toBeInTheDocument();
    expect(inFlightImageOps.get('img-up')).toBeUndefined();

    // Enter again and confirm without touching anything: the crop frame is still the whole image, nothing to crop -- do not upload, and
    // likewise recycle the pre-built node so the canvas does not gain a copy pixel-identical to the original.
    createCropResultNode.mockReturnValue('crop-3');
    fireEvent.click(within(openMoreMenu()).getByRole('button', { name: 'Crop' }));
    dialog = await screen.findByRole('dialog', { name: 'cropEditor.title' });
    loadCropImage(dialog, 800, 400);
    await user.click(within(dialog).getByRole('button', { name: 'cropEditor.confirm' }));

    expect(cropImageInPlace).not.toHaveBeenCalled();
    expect(discardCropResultNode).toHaveBeenCalledWith('crop-3');
    expect(inFlightImageOps.get('img-up')).toBeUndefined();
  });

  it('upscale: clicking "... -> Upscale" only builds the result node and switches the detail to it, without submitting on the spot', () => {
    // Reproduce the real side effect of createUpscaleResultNode (really building the result node in the store),
    // otherwise the detail would just show "This node no longer exists" after switching.
    createUpscaleResultNode.mockImplementation(() => seedUpscaleResultNode());
    openDetail('Uploaded image');

    fireEvent.click(within(openMoreMenu()).getByRole('button', { name: 'Upscale' }));

    // Only build the node, do not submit (mirrors liblib: params are tuned in the new node's detail, and the up arrow actually generates).
    expect(createUpscaleResultNode).toHaveBeenCalledWith('img-up', {
      displayName: 'Upscale',
      modelId: 'huimeng/gpt-image-2',
    });
    expect(submitImageUpscale).not.toHaveBeenCalled();
    // The old centered parameter dialog is gone.
    expect(screen.queryByRole('dialog', { name: 'Upscale' })).not.toBeInTheDocument();

    // The detail switched to the newly built upscale node, with the upscale editor (model/quality/multiplier + up arrow) mounted below the body.
    const detail = detailPanel();
    expect(within(detail).getByRole('button', { name: 'upscaleEditor.submit' })).toBeInTheDocument();
    // The result node has requested a viewport pre-position (Task 10 pattern).
    expect(useCanvasStore.getState().pendingFocusNodeId).toBe(upscaleResultNodeId);
    // The source node did not go busy -- this step produces no in-flight task.
    expect(inFlightImageOps.get('img-up')).toBeUndefined();

    // Not submitted -> the media area is empty; do not stand in the source image to be upscaled (otherwise users would take it for the upscaled result).
    expect(within(detail).getByText('Generates after confirmation')).toBeInTheDocument();
    expect(within(detail).queryByRole('img', { name: 'Upscale' })).toBeNull();
    // The empty-state node renders no operation toolbar at all (download/"..."/panorama... all need media to apply).
    expect(within(detail).queryByRole('button', { name: 'More' })).toBeNull();
    expect(within(detail).queryByRole('button', { name: /Panorama/ })).toBeNull();
  });

  it('upscale: change quality/multiplier in the editor of the new node detail -> press the up arrow to submit, with params taken from node data', async () => {
    const user = userEvent.setup();
    createUpscaleResultNode.mockImplementation(() => seedUpscaleResultNode());
    submitImageUpscale.mockReturnValue(NEVER);
    openDetail('Uploaded image');

    fireEvent.click(within(openMoreMenu()).getByRole('button', { name: 'Upscale' }));

    const detail = detailPanel();
    // Quality is picked in the popup selector (the card shared with the workflow).
    await user.click(within(detail).getByRole('button', { name: /qualityPicker/ }));
    await user.click(await screen.findByRole('button', { name: '4K' }));
    // The upscale multiplier is a segmented button group.
    await user.click(within(detail).getByRole('button', { name: '4' }));

    // What changes is the node data (survives repeated mount/unmount of the panel), not component-local state.
    const resultData = useCanvasStore
      .getState()
      .nodes.find((n) => n.id === upscaleResultNodeId)?.data as Record<string, unknown>;
    expect(resultData.upscaleImageSize).toBe('4K');
    expect(resultData.upscaleScaleFactor).toBe(4);

    await user.click(within(detail).getByRole('button', { name: 'upscaleEditor.submit' }));

    expect(submitImageUpscale).toHaveBeenCalledWith(upscaleResultNodeId, {
      sourceUrl: '/static/up.png',
      scaleFactor: 4,
      imageSize: '4K',
      model: 'gpt-image-2',
    });
  });

  it('busy state survives remounts: switching away and back to the same node is still busy, preventing duplicate submission / double billing', async () => {
    const user = userEvent.setup();
    scene360Image.mockReturnValue({ nodeId: 'pano-inflight', completion: NEVER });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const { unmount } = render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Uploaded image' }));
    let detail = detailPanel();
    await user.click(within(detail).getByRole('button', { name: /Panorama/ }));

    // Registered in the module-level Map that survives remounts (not component-local state).
    expect(inFlightImageOps.get('img-up')).toBe('pano');
    expect(scene360Image).toHaveBeenCalledTimes(1);

    // Simulate the detail toolbar fully remounting by key={node.id}: unmount and render again (same node).
    unmount();
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Uploaded image' }));
    detail = detailPanel();

    // The new instance reads "still running" from the module-level registry on mount, so the trigger button stays disabled.
    expect(within(detail).getByRole('button', { name: /Panorama/ })).toBeDisabled();

    // The disabled state itself already blocks the entry point -- the orchestration function was not called a second time, so no double billing.
    await user.click(within(detail).getByRole('button', { name: /Panorama/ }));
    expect(scene360Image).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it('failure fallback feedback: when completion settles the result node carries generationError, the source node toolbar shows a red error text, and it disappears after 8 seconds', async () => {
    // Close to the real application-layer completion contract: failure does not reject, it writes the error onto the result node
    // data and then resolves (see the catch branch in imageScene360.ts / imageUpscale.ts).
    scene360Image.mockImplementation(() => {
      const resultNodeId = useCanvasStore.getState().addNode(
        CANVAS_NODE_TYPES.exportImage,
        { x: 0, y: 0 },
        { displayName: 'Panorama placeholder' } as never,
      );
      return {
        nodeId: resultNodeId,
        completion: Promise.resolve().then(() => {
          useCanvasStore.getState().updateNodeData(resultNodeId, {
            generationError: 'Generation failed: insufficient credits',
          });
        }),
      };
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    openDetail('Uploaded image');
    const detail = detailPanel();

    vi.useFakeTimers();
    try {
      fireEvent.click(within(detail).getByRole('button', { name: /Panorama/ }));

      // completion is a Promise.resolve().then(...) microtask chain, unrelated to fake timers
      // (fake timers only intercept setTimeout/setInterval); flush it so trackSpawn's
      // finally and reportOpFailure finish, then query synchronously (no findBy, to avoid its internal
      // polling depending on fake timers).
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getByRole('alert')).toHaveTextContent('Generation failed: insufficient credits');

      act(() => {
        vi.advanceTimersByTime(8000);
      });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
      confirmSpy.mockRestore();
    }
  });

  it('panorama: submits directly after confirmation (no submission if confirmation is cancelled)', async () => {
    const user = userEvent.setup();
    scene360Image.mockReturnValue({ nodeId: 'pano-1', completion: NEVER });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    openDetail('Uploaded image');

    const detail = detailPanel();
    await user.click(within(detail).getByRole('button', { name: /Panorama/ }));
    expect(scene360Image).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    await user.click(within(detail).getByRole('button', { name: /Panorama/ }));
    expect(scene360Image).toHaveBeenCalledWith('img-up', '/static/up.png', {
      displayName: '360° panorama',
      aspectRatio: '2:1',
    });
    expect(useCanvasStore.getState().pendingFocusNodeId).toBe('pano-1');
    confirmSpy.mockRestore();
  });

  it('multi-angle: clicking the button opens the full workflow dialog editor (portal to body), and the old inline sphere block no longer renders', async () => {
    const user = userEvent.setup();
    multiAngleImage.mockReturnValue({ nodeId: 'mv-1', completion: NEVER });
    openDetail('Uploaded image');

    const detail = detailPanel();
    await user.click(within(detail).getByRole('button', { name: /Multi-angle/ }));

    // The dialog portals to document.body: not found inside the detail panel, but findable globally.
    const dialog = await screen.findByRole('dialog', { name: 'Multi-dimension editor' });
    expect(within(detail).queryByRole('dialog')).toBeNull();
    // The old inline sphere angle-picker block (orbit/pitch readout) no longer coexists.
    expect(screen.queryByText(/Orbit 0° · Pitch 0°/)).not.toBeInTheDocument();

    // Submit carries the editor panel's current params (default horizontal/vertical 0 degrees, medium shot) and requests a viewport pre-position.
    await user.click(within(dialog).getByRole('button', { name: 'multiAngleEditor.submit' }));
    expect(multiAngleImage).toHaveBeenCalledWith(
      'img-up',
      '/static/up.png',
      expect.objectContaining({
        preset: 'custom',
        horizontalDeg: 0,
        verticalDeg: 0,
        zoom: 'medium',
        apiModel: 'gpt-image-2',
      }),
    );
    // After a successful submit the dialog closes itself (onSubmitted -> onClose contract), and the viewport is pre-positioned to the new node.
    expect(screen.queryByRole('dialog', { name: 'Multi-dimension editor' })).not.toBeInTheDocument();
    expect(useCanvasStore.getState().pendingFocusNodeId).toBe('mv-1');
  });

  it('multi-angle: clicking the dialog backdrop closes it -- the panel\'s own outside-click listener and the backdrop onClick both hitting still closes only once', async () => {
    const user = userEvent.setup();
    openDetail('Uploaded image');

    const detail = detailPanel();
    await user.click(within(detail).getByRole('button', { name: /Multi-angle/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Multi-dimension editor' });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Click the backdrop itself directly (target === currentTarget), which also triggers the panel's document capture listener.
    fireEvent.click(dialog);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();

    expect(screen.queryByRole('dialog', { name: 'Multi-dimension editor' })).not.toBeInTheDocument();
    expect(multiAngleImage).not.toHaveBeenCalled();
    // Not stuck in a half-closed state: clicking the button again still reopens normally.
    await user.click(within(detail).getByRole('button', { name: /Multi-angle/ }));
    expect(await screen.findByRole('dialog', { name: 'Multi-dimension editor' })).toBeInTheDocument();
  });

  it('relight: clicking the button opens the full workflow dialog editor (portal to body), and the old inline plane config row no longer renders', async () => {
    const user = userEvent.setup();
    relightImage.mockReturnValue({ nodeId: 'rl-1', completion: NEVER });
    openDetail('Uploaded image');

    const detail = detailPanel();
    await user.click(within(detail).getByRole('button', { name: /Relight/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Lighting effect editor' });
    expect(within(detail).queryByRole('dialog')).toBeNull();
    // The old inline plane config row (key light direction segments) no longer coexists.
    expect(screen.queryByText('Key light direction')).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'lightEditor.submit' }));
    expect(relightImage).toHaveBeenCalledWith(
      'img-up',
      '/static/up.png',
      expect.objectContaining({
        rimLight: false,
        mainLight: expect.objectContaining({ nearestPreset: 'front' }),
        smartMode: expect.objectContaining({ enabled: false }),
      }),
    );
    expect(screen.queryByRole('dialog', { name: 'Lighting effect editor' })).not.toBeInTheDocument();
    expect(useCanvasStore.getState().pendingFocusNodeId).toBe('rl-1');
  });

  it('relight: clicking the dialog backdrop closes it -- closes only once and does not stay half-closed', async () => {
    const user = userEvent.setup();
    openDetail('Uploaded image');

    const detail = detailPanel();
    await user.click(within(detail).getByRole('button', { name: /Relight/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Lighting effect editor' });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fireEvent.click(dialog);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();

    expect(screen.queryByRole('dialog', { name: 'Lighting effect editor' })).not.toBeInTheDocument();
    expect(relightImage).not.toHaveBeenCalled();
    await user.click(within(detail).getByRole('button', { name: /Relight/ }));
    expect(await screen.findByRole('dialog', { name: 'Lighting effect editor' })).toBeInTheDocument();
  });

});
