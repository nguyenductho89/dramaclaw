// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Self-healing after a save is rejected by the backend with `canvas_media_scope_mismatch`: parse the refs, copy the assets into
 * this project, and fill them back into the nodes by field path; anything that cannot be copied is blanked and marked failed so the save can proceed.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const copyFreezoneAssets = vi.hoisted(() => vi.fn());
vi.mock('@/api/ops', () => ({ copyFreezoneAssets }));

const {
  applyForeignMediaRepairToNodes,
  clearForeignMediaRefs,
  parseCanvasMediaScopeRefs,
  publishForeignMediaRefs,
  repairForeignMediaRefs,
} = await import('@/features/canvas/application/canvasMediaScope');

const FOREIGN = '/static/projects/projA/freezone/_uploads/a.png';
const COPIED = '/static/projects/projB/freezone/_uploads/a.png';

function ref(overrides: Record<string, unknown> = {}) {
  return {
    node_id: 'n1',
    field: 'imageUrl',
    url: FOREIGN,
    source_project_id: 'projA',
    ...overrides,
  };
}

describe('parseCanvasMediaScopeRefs', () => {
  it('reads the refs out of the 422 body', () => {
    expect(
      parseCanvasMediaScopeRefs(422, {
        detail: { code: 'canvas_media_scope_mismatch', project_id: 'projB', refs: [ref()] },
      }),
    ).toEqual([ref()]);
  });

  it('ignores any other error', () => {
    expect(parseCanvasMediaScopeRefs(409, { detail: { code: 'canvas_revision_conflict' } })).toBeNull();
    expect(parseCanvasMediaScopeRefs(422, { detail: { code: 'canvas_payload_too_large' } })).toBeNull();
    expect(parseCanvasMediaScopeRefs(422, undefined)).toBeNull();
  });

  it('drops malformed entries instead of trusting the wire', () => {
    expect(
      parseCanvasMediaScopeRefs(422, {
        detail: {
          code: 'canvas_media_scope_mismatch',
          refs: [ref(), { node_id: 'n2' }, 'nonsense', null],
        },
      }),
    ).toEqual([ref()]);
  });

  it('returns null when the backend reports the code with no usable ref', () => {
    // With no repairable location, do not spin through the self-healing branch; report it directly as an ordinary error.
    expect(
      parseCanvasMediaScopeRefs(422, { detail: { code: 'canvas_media_scope_mismatch', refs: [] } }),
    ).toBeNull();
  });
});

describe('repairForeignMediaRefs', () => {
  beforeEach(() => {
    copyFreezoneAssets.mockReset();
    clearForeignMediaRefs();
  });

  it('copies the asset into this project and writes the new url back into the node', async () => {
    copyFreezoneAssets.mockResolvedValue({ mapping: { [FOREIGN]: COPIED }, failed: [] });
    const updateNodeData = vi.fn();

    const result = await repairForeignMediaRefs({
      refs: [ref()],
      targetProject: 'projB',
      getLiveNodeData: () => ({ imageUrl: FOREIGN }) as never,
      updateNodeData,
    });

    expect(copyFreezoneAssets).toHaveBeenCalledWith('projB', [FOREIGN]);
    expect(updateNodeData).toHaveBeenCalledWith('n1', { imageUrl: COPIED });
    expect(result.urlMap.get(FOREIGN)).toBe(COPIED);
    expect(result.failedUrls.size).toBe(0);
  });

  it('walks the nested field path the backend reported', async () => {
    copyFreezoneAssets.mockResolvedValue({ mapping: { [FOREIGN]: COPIED }, failed: [] });
    const updateNodeData = vi.fn();

    await repairForeignMediaRefs({
      refs: [ref({ field: 'cells[1].imageUrl' })],
      targetProject: 'projB',
      getLiveNodeData: () =>
        ({ cells: [{ imageUrl: null }, { imageUrl: FOREIGN }] }) as never,
      updateNodeData,
    });

    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      cells: [{ imageUrl: null }, { imageUrl: COPIED }],
    });
  });

  it('copies one url once even when several nodes point at it', async () => {
    copyFreezoneAssets.mockResolvedValue({ mapping: { [FOREIGN]: COPIED }, failed: [] });
    const updateNodeData = vi.fn();

    await repairForeignMediaRefs({
      refs: [ref(), ref({ node_id: 'n2' })],
      targetProject: 'projB',
      getLiveNodeData: () => ({ imageUrl: FOREIGN }) as never,
      updateNodeData,
    });

    expect(copyFreezoneAssets).toHaveBeenCalledTimes(1);
    expect(updateNodeData).toHaveBeenCalledTimes(2);
  });

  it('blanks the field and marks the node failed when the copy does not succeed', async () => {
    copyFreezoneAssets.mockResolvedValue({
      mapping: {},
      failed: [{ source: FOREIGN, reason: 'forbidden' }],
    });
    const updateNodeData = vi.fn();

    const result = await repairForeignMediaRefs({
      refs: [ref()],
      targetProject: 'projB',
      getLiveNodeData: () => ({ imageUrl: FOREIGN }) as never,
      updateNodeData,
    });

    // Blanking is required: keeping the source project URL means saving the 403 again, and the backend would reject it again.
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      imageUrl: null,
      assetMigration: 'failed',
    });
    expect(result.failedUrls.has(FOREIGN)).toBe(true);
  });

  it('leaves every field alone when the request itself did not go through', async () => {
    // A request that did not go through != these assets cannot be copied. Blanking is irreversible and must not be traded for a network blip.
    copyFreezoneAssets.mockRejectedValue(new Error('network down'));
    const updateNodeData = vi.fn();

    const result = await repairForeignMediaRefs({
      refs: [ref()],
      targetProject: 'projB',
      getLiveNodeData: () => ({ imageUrl: FOREIGN }) as never,
      updateNodeData,
    });

    expect(result.retryable).toBe(true);
    expect(result.failedUrls.size).toBe(0);
    expect(updateNodeData).not.toHaveBeenCalled();
  });

  it('leaves every field alone when the backend says a source is only unavailable', async () => {
    copyFreezoneAssets.mockResolvedValue({
      mapping: {},
      failed: [{ source: FOREIGN, reason: 'unavailable' }],
    });
    const updateNodeData = vi.fn();

    const result = await repairForeignMediaRefs({
      refs: [ref()],
      targetProject: 'projB',
      getLiveNodeData: () => ({ imageUrl: FOREIGN }) as never,
      updateNodeData,
    });

    expect(result.retryable).toBe(true);
    expect(updateNodeData).not.toHaveBeenCalled();
  });

  it('leaves every field alone when the copy failed on the storage side', async () => {
    // copy_failed = an OSError while copying/creating the target file, a storage-side problem, not that this source cannot be copied.
    copyFreezoneAssets.mockResolvedValue({
      mapping: {},
      failed: [{ source: FOREIGN, reason: 'copy_failed' }],
    });
    const updateNodeData = vi.fn();

    const result = await repairForeignMediaRefs({
      refs: [ref()],
      targetProject: 'projB',
      getLiveNodeData: () => ({ imageUrl: FOREIGN }) as never,
      updateNodeData,
    });

    expect(result.retryable).toBe(true);
    expect(updateNodeData).not.toHaveBeenCalled();
  });

  it('normalizes a same-origin absolute url before asking the backend to copy it', async () => {
    // The guard finds it by browser semantics, but the copy endpoint accepts only relative canonical paths: without normalization it would come back as
    // invalid_source, and the self-healing would instead delete the reference.
    const absolute = `${window.location.origin}/static/projects/projA/freezone/x/../_uploads/a.png`;
    copyFreezoneAssets.mockResolvedValue({ mapping: { [FOREIGN]: COPIED }, failed: [] });
    const updateNodeData = vi.fn();

    const result = await repairForeignMediaRefs({
      refs: [ref({ url: absolute })],
      targetProject: 'projB',
      getLiveNodeData: () => ({ imageUrl: absolute }) as never,
      updateNodeData,
    });

    expect(copyFreezoneAssets).toHaveBeenCalledWith('projB', [FOREIGN]);
    // Externally the original URL string from the canvas is still the key, so the caller can modify the snapshot it holds.
    expect(result.urlMap.get(absolute)).toBe(COPIED);
    expect(updateNodeData).toHaveBeenCalledWith('n1', { imageUrl: COPIED });
  });

  it('does not touch an url it cannot resolve to a same-origin asset', async () => {
    // An external image whose path looks like a project asset: the guard blocks it by mistake, but it was never a local asset, and if it cannot be copied it should not be deleted.
    const external = 'https://cdn.example.com/static/projects/projA/a.png';
    const updateNodeData = vi.fn();

    const result = await repairForeignMediaRefs({
      refs: [ref({ url: external })],
      targetProject: 'projB',
      getLiveNodeData: () => ({ imageUrl: external }) as never,
      updateNodeData,
    });

    expect(copyFreezoneAssets).not.toHaveBeenCalled();
    expect(result.failedUrls.size).toBe(0);
    expect(updateNodeData).not.toHaveBeenCalled();
  });

  it('still blanks what the backend definitively refused', async () => {
    // 403 is final: keeping the source project URL saves the 403 again, the backend would reject it next round, and the save would be stuck forever.
    copyFreezoneAssets.mockResolvedValue({
      mapping: {},
      failed: [{ source: FOREIGN, reason: 'forbidden' }],
    });
    const updateNodeData = vi.fn();

    const result = await repairForeignMediaRefs({
      refs: [ref()],
      targetProject: 'projB',
      getLiveNodeData: () => ({ imageUrl: FOREIGN }) as never,
      updateNodeData,
    });

    expect(result.retryable).toBe(false);
    expect(result.failedUrls.has(FOREIGN)).toBe(true);
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      imageUrl: null,
      assetMigration: 'failed',
    });
  });

  it('writes nothing when the canvas changed while the copy was in flight', async () => {
    // The copy takes a few seconds; if the canvas is switched meanwhile, the refs in hand no longer refer to the image on screen.
    publishForeignMediaRefs('projB', 'canvas-a', [ref()]);
    const updateNodeData = vi.fn();
    copyFreezoneAssets.mockImplementation(async () => {
      publishForeignMediaRefs('projB', 'canvas-b', []);
      return { mapping: { [FOREIGN]: COPIED }, failed: [] };
    });

    const result = await repairForeignMediaRefs({
      refs: [ref()],
      targetProject: 'projB',
      getLiveNodeData: () => ({ imageUrl: FOREIGN }) as never,
      updateNodeData,
    });

    expect(result.retryable).toBe(true);
    expect(updateNodeData).not.toHaveBeenCalled();
  });

  it('keeps going when the same canvas merely re-hydrates mid-copy', async () => {
    // A background refresh must not interrupt a repair the user is running.
    publishForeignMediaRefs('projB', 'canvas-a', [ref()]);
    const updateNodeData = vi.fn();
    copyFreezoneAssets.mockImplementation(async () => {
      publishForeignMediaRefs('projB', 'canvas-a', [ref()]);
      return { mapping: { [FOREIGN]: COPIED }, failed: [] };
    });

    const result = await repairForeignMediaRefs({
      refs: [ref()],
      targetProject: 'projB',
      getLiveNodeData: () => ({ imageUrl: FOREIGN }) as never,
      updateNodeData,
    });

    expect(result.retryable).toBe(false);
    expect(updateNodeData).toHaveBeenCalledWith('n1', { imageUrl: COPIED });
  });

  it('skips a node that is gone by the time the copy comes back', async () => {
    copyFreezoneAssets.mockResolvedValue({ mapping: { [FOREIGN]: COPIED }, failed: [] });
    const updateNodeData = vi.fn();

    await repairForeignMediaRefs({
      refs: [ref()],
      targetProject: 'projB',
      getLiveNodeData: () => null,
      updateNodeData,
    });

    expect(updateNodeData).not.toHaveBeenCalled();
  });

  it('leaves a field the user already changed alone', async () => {
    copyFreezoneAssets.mockResolvedValue({ mapping: { [FOREIGN]: COPIED }, failed: [] });
    const updateNodeData = vi.fn();

    await repairForeignMediaRefs({
      refs: [ref()],
      targetProject: 'projB',
      // If the user swapped the image between the rejection and the retry, that is their choice; do not overwrite it with the copy result.
      getLiveNodeData: () => ({ imageUrl: '/static/projects/projB/mine.png' }) as never,
      updateNodeData,
    });

    expect(updateNodeData).not.toHaveBeenCalled();
  });
});

describe('applyForeignMediaRepairToNodes', () => {
  const nodes = [
    { id: 'n1', data: { imageUrl: FOREIGN, label: 'One' } },
    { id: 'n2', data: { imageUrl: '/static/projects/projB/ok.png' } },
  ];

  it('rewrites the repaired urls in the snapshot the retry will send', () => {
    const next = applyForeignMediaRepairToNodes(nodes as never, [ref()], {
      urlMap: new Map([[FOREIGN, COPIED]]),
      failedUrls: new Set<string>(),
      retryable: false,
    });

    expect((next[0] as { data: { imageUrl: string; label: string } }).data).toEqual({
      imageUrl: COPIED,
      label: 'One',
    });
    // Untouched nodes keep the same reference, so the whole canvas is not re-rendered for nothing.
    expect(next[1]).toBe(nodes[1]);
  });

  it('blanks and marks what could not be copied, so the retry is not rejected again', () => {
    const next = applyForeignMediaRepairToNodes(nodes as never, [ref()], {
      urlMap: new Map<string, string>(),
      failedUrls: new Set([FOREIGN]),
      retryable: false,
    });

    expect((next[0] as { data: Record<string, unknown> }).data).toMatchObject({
      imageUrl: null,
      assetMigration: 'failed',
    });
  });

  it('returns the very same array when there is nothing to change', () => {
    const next = applyForeignMediaRepairToNodes(nodes as never, [ref({ node_id: 'gone' })], {
      urlMap: new Map([[FOREIGN, COPIED]]),
      failedUrls: new Set<string>(),
      retryable: false,
    });

    expect(next).toBe(nodes);
  });
});
