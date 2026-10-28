// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  CANVAS_NODE_TYPES,
  hasInlineMediaReplaceButton,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { hasInlineCommitButton } from '@/features/canvas/ui/SelectedNodeOverlay';

function node(type: string, data: Record<string, unknown>): CanvasNode {
  return { id: 'n1', type, position: { x: 0, y: 0 }, data } as unknown as CanvasNode;
}

describe('in-card "Replace media" button toggle', () => {
  it('only honors allowLocalReplace on frame-by-frame breakdown outputs', () => {
    expect(hasInlineMediaReplaceButton({ allowLocalReplace: true })).toBe(true);
    expect(hasInlineMediaReplaceButton({ allowLocalReplace: false })).toBe(false);
    expect(hasInlineMediaReplaceButton({})).toBe(false);
    expect(hasInlineMediaReplaceButton(null)).toBe(false);
    expect(hasInlineMediaReplaceButton(undefined)).toBe(false);
  });

  it('selection state itself is no longer the toggle: ordinary generated results must not grow this button', () => {
    // Whether a node is selected is the `selected` flag in the node component; this pins that it is no longer in the predicate:
    // the same data only looks at allowLocalReplace regardless of selection.
    expect(hasInlineMediaReplaceButton({ selected: true } as never)).toBe(false);
  });
});

describe('mutual-exclusion check for the outer AssetCommitHandle', () => {
  it('breakdown output images/videos/audio use the in-card button and no longer mount the outer handle', () => {
    for (const type of [
      CANVAS_NODE_TYPES.exportImage,
      CANVAS_NODE_TYPES.video,
      CANVAS_NODE_TYPES.audio,
    ]) {
      expect(hasInlineCommitButton(node(type, { allowLocalReplace: true }))).toBe(true);
    }
  });

  it('ordinary nodes of the same type have no in-card button, so the outer handle must stay', () => {
    // Regression guard: it used to exclude by type wholesale, so ordinary video/image nodes lost the outer handle too,
    // leaving "drag to the asset library to replace" with no entry point at all.
    for (const type of [
      CANVAS_NODE_TYPES.exportImage,
      CANVAS_NODE_TYPES.video,
      CANVAS_NODE_TYPES.audio,
    ]) {
      expect(hasInlineCommitButton(node(type, {}))).toBe(false);
    }
  });

  it('all other types use the outer handle', () => {
    expect(hasInlineCommitButton(node(CANVAS_NODE_TYPES.upload, { allowLocalReplace: true }))).toBe(
      false,
    );
    expect(hasInlineCommitButton(node(CANVAS_NODE_TYPES.imageGen, {}))).toBe(false);
  });
});
