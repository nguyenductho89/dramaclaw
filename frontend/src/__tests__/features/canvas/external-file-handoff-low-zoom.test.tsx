// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Regression: when an image is dragged in from outside at the low-zoom tier (zoom < LOW_DETAIL_ZOOM_THRESHOLD), the newly created upload
 * node must not be an empty node.
 *
 * What was seen in the field: "after zooming in, the added node is an upload node unrelated to the dragged image". The chain:
 * the deliverer addNodes first and only on the next frame sends the File to canvasEventBus, while at the low-zoom tier the new node first mounts as an
 * LOD shell (withLodShell), and the full component must wait for the upgrade queue of requestShellUpgrade to release it,
 * inevitably later than the delivery frame — the bus has no replay, and the File is gone on the spot.
 *
 * This locks "the File's carrier is decoupled from subscription timing": stash on delivery, and the consumer re-delivers once on mount.
 */
import { render, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- @xyflow/react: only useStore needs to read transform[2], and Handle renders as an empty node ----
let currentZoom = 1;
vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  useStore: (selector: (state: { transform: [number, number, number] }) => unknown) =>
    selector({ transform: [0, 0, currentZoom] }),
}));

// Canvas store: only the "selection exemption" of withLodShell reads it. In these cases the node is not selected —
// when the drop lands on a blank canvas, React Flow's selection sync resets selectedNodeId and the exemption does not apply,
// consistent with the field.
vi.mock('@/stores/canvasStore', () => ({
  useCanvasStore: (selector: (state: { selectedNodeId: string | null }) => unknown) =>
    selector({ selectedNodeId: null }),
}));

const { withLodShell } = await import('@/features/canvas/nodes/LodShellNode');
const { useExternalFileHandoff } = await import(
  '@/features/canvas/hooks/useExternalFileHandoff'
);
const { canvasEventBus } = await import('@/features/canvas/application/canvasServices');
const {
  stashExternalFile,
  takeExternalFile,
  resetPendingExternalFilesForTest,
} = await import('@/features/canvas/application/pendingExternalFiles');
const { setCanvasGestureActive } = await import(
  '@/features/canvas/application/canvasLod'
);

const NODE_ID = 'upload-1';

const received: string[] = [];

/**
 * Impersonates UploadNode: where it hands the received File to handleMediaFile, it records a note instead.
 * The receiving side uses the production useExternalFileHandoff, the same path as the three node components.
 */
function UploadStub({ id }: { id: string }) {
  useExternalFileHandoff('upload-node/external-file', id, (file) => {
    received.push(file.name);
  });
  return <div data-testid="full-upload-node" />;
}

const WrappedUploadNode = withLodShell('uploadNode', UploadStub);

function renderNode() {
  return render(
    <WrappedUploadNode
      id={NODE_ID}
      type="uploadNode"
      data={{}}
      selected={false}
      width={320}
      height={350}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {...({} as any)}
    />,
  );
}

/** Replicates the file branch of Canvas.handleCanvasDrop: stash + emit the event one frame later. */
function dropFile(nodeId: string, name: string) {
  const file = new File(['x'], name, { type: 'image/png' });
  stashExternalFile('upload-node/external-file', nodeId, file);
  requestAnimationFrame(() => {
    canvasEventBus.publish('upload-node/external-file', { nodeId });
  });
}

/** Wait frame by frame (must be serial: registering n rAFs at once only waits for one frame). */
async function nextFrames(count: number) {
  for (let i = 0; i < count; i += 1) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
}

describe('file drop delivery at the low-zoom tier', () => {
  beforeEach(() => {
    received.length = 0;
    currentZoom = 1;
    setCanvasGestureActive(false);
    resetPendingExternalFilesForTest();
  });

  afterEach(() => {
    resetPendingExternalFilesForTest();
  });

  it('at the usual zoom the node mounts directly as the full component and receives the File in the same frame (control group)', async () => {
    const { queryByTestId } = renderNode();
    expect(queryByTestId('full-upload-node')).not.toBeNull();

    await act(async () => {
      dropFile(NODE_ID, 'a.png');
      await nextFrames(2);
    });

    expect(received).toEqual(['a.png']);
  });

  it('a File delivered during the shell phase is not lost: re-delivered when the full component mounts', async () => {
    currentZoom = 0.2;
    const { queryByTestId, rerender } = renderNode();
    // Premise: at the low-zoom tier it is indeed a shell and the full component is not mounted — so there are no subscribers.
    expect(queryByTestId('full-upload-node')).toBeNull();

    await act(async () => {
      dropFile(NODE_ID, 'b.png');
      await nextFrames(2);
    });
    // The delivery has already happened, the node is still a shell, and nobody receives the event.
    expect(received).toEqual([]);

    // Zoom in across the threshold: the shell is swapped to the full component via the upgrade queue.
    currentZoom = 1;
    await act(async () => {
      rerender(
        <WrappedUploadNode
          id={NODE_ID}
          type="uploadNode"
          data={{}}
          selected={false}
          width={320}
          height={350}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          {...({} as any)}
        />,
      );
    });
    // The upgrade is queued in the rerender's effect, and must settle before pushing frames, otherwise the pump runs once ahead of
    // being enqueued.
    await act(async () => {
      await nextFrames(3);
    });

    expect(queryByTestId('full-upload-node')).not.toBeNull();
    expect(received).toEqual(['b.png']);
  });

  it('the same File is consumed only once (mount re-delivery and event delivery do not duplicate)', async () => {
    const { queryByTestId } = renderNode();
    expect(queryByTestId('full-upload-node')).not.toBeNull();

    await act(async () => {
      dropFile(NODE_ID, 'c.png');
      await nextFrames(3);
    });

    expect(received).toEqual(['c.png']);
    // The stash has been emptied, so a remount does not process it again.
    expect(takeExternalFile('upload-node/external-file', NODE_ID)).toBeNull();
  });

  it('multi-file drop: each new node gets its own File', async () => {
    currentZoom = 0.2;
    const files = ['d1.png', 'd2.png', 'd3.png'];
    files.forEach((name, index) => {
      dropFile(`upload-multi-${index}`, name);
    });

    currentZoom = 1;
    await act(async () => {
      render(
        <>
          {files.map((_, index) => (
            <WrappedUploadNode
              key={index}
              id={`upload-multi-${index}`}
              type="uploadNode"
              data={{}}
              selected={false}
              width={320}
              height={350}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              {...({} as any)}
            />
          ))}
        </>,
      );
      await nextFrames(2);
    });

    expect(received.sort()).toEqual(files);
  });
});
