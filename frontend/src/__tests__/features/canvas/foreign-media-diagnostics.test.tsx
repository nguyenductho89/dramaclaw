// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Read-time diagnostics: the backend reports in GET the foreign-project references the canvas is still serving, and the frontend uses this to mark those nodes
 * and offer a one-click fix, instead of leaving the user with a field of unexplained broken images.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const copyFreezoneAssets = vi.hoisted(() => vi.fn());
const updateNodeData = vi.hoisted(() => vi.fn());
const nodes = vi.hoisted(() => [] as Array<{ id: string; data: unknown }>);

vi.mock('@/api/ops', () => ({ copyFreezoneAssets }));
vi.mock('@/stores/canvasStore', () => ({
  useCanvasStore: { getState: () => ({ nodes, updateNodeData }) },
}));

const {
  clearForeignMediaRefs,
  publishForeignMediaRefs,
  readForeignMediaRefsForNode,
} = await import('@/features/canvas/application/canvasMediaScope');
const { ForeignMediaNodeOverlay } = await import(
  '@/features/canvas/ui/ForeignMediaNodeOverlay'
);

const FOREIGN = '/static/projects/projA/freezone/_uploads/a.png';
const COPIED = '/static/projects/projB/freezone/_uploads/a.png';
const REF = {
  node_id: 'n1',
  field: 'imageUrl',
  url: FOREIGN,
  source_project_id: 'projA',
};

describe('foreign media registry', () => {
  beforeEach(() => {
    clearForeignMediaRefs();
    copyFreezoneAssets.mockReset();
    updateNodeData.mockReset();
    nodes.length = 0;
  });
  afterEach(() => {
    clearForeignMediaRefs();
  });

  it('indexes the published refs by node', () => {
    publishForeignMediaRefs('projB', 'default', [REF, { ...REF, node_id: 'n2' }]);
    expect(readForeignMediaRefsForNode('n1')).toEqual([REF]);
    expect(readForeignMediaRefsForNode('n3')).toEqual([]);
  });

  it('forgets everything from the previous canvas when a new one publishes', () => {
    publishForeignMediaRefs('projB', 'default', [REF]);
    publishForeignMediaRefs('projB', 'default', []);
    expect(readForeignMediaRefsForNode('n1')).toEqual([]);
  });
});

describe('ForeignMediaNodeOverlay', () => {
  beforeEach(() => {
    clearForeignMediaRefs();
    copyFreezoneAssets.mockReset();
    updateNodeData.mockReset();
    nodes.length = 0;
    nodes.push({ id: 'n1', data: { imageUrl: FOREIGN } });
  });
  afterEach(() => {
    clearForeignMediaRefs();
  });

  it('renders nothing for a node with no reported problem', () => {
    const { container } = render(<ForeignMediaNodeOverlay nodeId="n1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('explains why the media is broken instead of leaving a bare cracked image', () => {
    publishForeignMediaRefs('projB', 'default', [REF]);
    render(<ForeignMediaNodeOverlay nodeId="n1" />);
    expect(screen.getByText('Media belongs to another project')).toBeInTheDocument();
  });

  it('copies the media into this project when the user asks, then clears the marker', async () => {
    copyFreezoneAssets.mockResolvedValue({ mapping: { [FOREIGN]: COPIED }, failed: [] });
    publishForeignMediaRefs('projB', 'default', [REF]);
    render(<ForeignMediaNodeOverlay nodeId="n1" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy into this project' }));
    });

    expect(copyFreezoneAssets).toHaveBeenCalledWith('projB', [FOREIGN]);
    expect(updateNodeData).toHaveBeenCalledWith('n1', { imageUrl: COPIED }, { recordHistory: false });
    expect(readForeignMediaRefsForNode('n1')).toEqual([]);
    expect(screen.queryByText('Media belongs to another project')).toBeNull();
  });

  it('keeps the marker when the copy fails so the user is not told it worked', async () => {
    copyFreezoneAssets.mockResolvedValue({
      mapping: {},
      failed: [{ source: FOREIGN, reason: 'forbidden' }],
    });
    publishForeignMediaRefs('projB', 'default', [REF]);
    render(<ForeignMediaNodeOverlay nodeId="n1" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy into this project' }));
    });

    expect(readForeignMediaRefsForNode('n1')).toEqual([REF]);
  });

  it('says why the copy failed instead of looking like a dead button', async () => {
    // The most common reason a copy fails is having no permission on the source project -- exactly the situation of the #192 canvases.
    // Silently doing nothing would make the user think the button is broken and keep clicking it.
    copyFreezoneAssets.mockResolvedValue({
      mapping: {},
      failed: [{ source: FOREIGN, reason: 'forbidden' }],
    });
    publishForeignMediaRefs('projB', 'default', [REF]);
    render(<ForeignMediaNodeOverlay nodeId="n1" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy into this project' }));
    });

    expect(screen.getByText('Copy failed — you may not have access to the source project')).toBeInTheDocument();
  });
});
