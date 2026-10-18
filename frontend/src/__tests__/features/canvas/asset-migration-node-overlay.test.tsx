// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Cross-project paste placeholder overlay: a spinner while copying, and an error placeholder + removal on failure (or when the marker lingers but the task is gone).
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const copyFreezoneAssets = vi.hoisted(() => vi.fn());
const deleteNode = vi.hoisted(() => vi.fn());

vi.mock('@/api/ops', () => ({ copyFreezoneAssets }));
vi.mock('@/stores/canvasStore', () => ({
  useCanvasStore: { getState: () => ({ deleteNode }) },
}));

const { AssetMigrationNodeOverlay } = await import('@/features/canvas/ui/AssetMigrationNodeOverlay');
const { migratePastedNodeAssets } = await import('@/features/canvas/application/crossProjectAssets');

const SOURCE = '/static/projects/projA/images/a.png';

describe('AssetMigrationNodeOverlay', () => {
  beforeEach(() => {
    copyFreezoneAssets.mockReset();
    deleteNode.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing for an ordinary node', () => {
    const { container } = render(
      <AssetMigrationNodeOverlay nodeId="n1" data={{ imageUrl: '/static/projects/projB/x.png' }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the copying placeholder while the migration runs, then the error placeholder if the marker outlives it', async () => {
    let resolveCopy: (value: unknown) => void = () => undefined;
    copyFreezoneAssets.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCopy = resolve;
        }),
    );
    const pending = migratePastedNodeAssets({
      nodes: [{ id: 'n1', withheld: [{ path: ['imageUrl'], url: SOURCE }] }],
      targetProject: 'projB',
      // The node was deleted during the copy: the fill-back step is skipped, and the marker lingers in the store (simulated with static data in this test).
      getLiveNodeData: () => null,
      updateNodeData: () => undefined,
    });

    render(<AssetMigrationNodeOverlay nodeId="n1" data={{ imageUrl: null, assetMigration: 'copying' }} />);
    expect(screen.getByTestId('asset-migration-copying')).toBeInTheDocument();
    expect(screen.getByText('Copying assets…')).toBeInTheDocument();
    expect(screen.queryByTestId('asset-migration-failed')).toBeNull();

    await act(async () => {
      resolveCopy({ mapping: { [SOURCE]: '/static/projects/projB/freezone/_uploads/a.png' }, failed: [] });
      await pending;
    });

    // The task ended while the marker is still copying (a leftover persisted after a refresh, or the node is no longer on the fill-back list) -> treated as a failure placeholder.
    expect(screen.queryByTestId('asset-migration-copying')).toBeNull();
    expect(screen.getByTestId('asset-migration-failed')).toBeInTheDocument();
  });

  it('treats a persisted copying marker with no running migration as failed (after a reload)', () => {
    render(<AssetMigrationNodeOverlay nodeId="stale" data={{ imageUrl: null, assetMigration: 'copying' }} />);
    expect(screen.getByTestId('asset-migration-failed')).toBeInTheDocument();
    expect(screen.getByText('Asset copy failed. Delete this node and paste again.')).toBeInTheDocument();
  });

  it('lets the user remove a failed placeholder node', () => {
    render(<AssetMigrationNodeOverlay nodeId="n9" data={{ imageUrl: null, assetMigration: 'failed' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove node' }));
    expect(deleteNode).toHaveBeenCalledWith('n9');
  });
});
