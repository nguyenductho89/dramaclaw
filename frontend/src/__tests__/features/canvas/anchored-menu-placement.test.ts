// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import { placeAnchoredMenu } from '@/features/canvas/nodes/shared/anchoredMenuPlacement';

const VIEWPORT = { viewportWidth: 1200, viewportHeight: 800 };

function rect(top: number, left = 400, height = 24) {
  return { top, bottom: top + height, left };
}

describe('placeAnchoredMenu', () => {
  it('opens below when there is room below, giving the full content height', () => {
    const geometry = placeAnchoredMenu({
      anchorRect: rect(200),
      width: 236,
      preferredHeight: 300,
      ...VIEWPORT,
    });

    expect(geometry.placement).toBe('below');
    expect(geometry.top).toBe(228);
    expect(geometry.left).toBe(400);
    expect(geometry.maxHeight).toBe(300);
  });

  it('flips above the trigger element when hugging the bottom of the viewport, rather than falling off screen', () => {
    // The operations panel hugs the bottom edge: only 40px remain below the chip, which cannot fit a 300px menu.
    const geometry = placeAnchoredMenu({
      anchorRect: rect(736),
      width: 236,
      preferredHeight: 300,
      ...VIEWPORT,
    });

    expect(geometry.placement).toBe('above');
    expect(geometry.maxHeight).toBe(300);
    // The top edge is inside the viewport, and the bottom edge lands exactly above the trigger element.
    expect(geometry.top).toBe(432);
    expect(geometry.top + geometry.maxHeight).toBeLessThanOrEqual(736 - 4);
  });

  it('does not fill below but is still roomier than above: stays below and shrinks, no flipping back and forth', () => {
    const geometry = placeAnchoredMenu({
      anchorRect: rect(300),
      width: 236,
      preferredHeight: 500,
      ...VIEWPORT,
    });

    expect(geometry.placement).toBe('below');
    expect(geometry.top).toBe(328);
    expect(geometry.maxHeight).toBe(464);
    expect(geometry.top + geometry.maxHeight).toBeLessThanOrEqual(800 - 8);
  });

  it('shrinks the height when it does not fit above either, letting the menu scroll itself rather than exceed the viewport', () => {
    const geometry = placeAnchoredMenu({
      anchorRect: rect(200),
      width: 236,
      preferredHeight: 500,
      viewportWidth: 1200,
      viewportHeight: 400,
    });

    expect(geometry.placement).toBe('above');
    expect(geometry.maxHeight).toBe(188);
    expect(geometry.top).toBe(8);
  });

  it('stays below when both sides are cramped, and is pressed back into the viewport as a whole', () => {
    const geometry = placeAnchoredMenu({
      anchorRect: rect(60),
      width: 236,
      preferredHeight: 300,
      viewportWidth: 1200,
      viewportHeight: 160,
    });

    expect(geometry.placement).toBe('below');
    expect(geometry.top).toBeGreaterThanOrEqual(8);
    expect(geometry.top + geometry.maxHeight).toBeLessThanOrEqual(160 - 8);
  });

  it('still clamps horizontally inside the viewport', () => {
    expect(
      placeAnchoredMenu({
        anchorRect: rect(200, 1150),
        width: 236,
        preferredHeight: 100,
        ...VIEWPORT,
      }).left,
    ).toBe(1200 - 236 - 8);

    expect(
      placeAnchoredMenu({
        anchorRect: rect(200, -50),
        width: 236,
        preferredHeight: 100,
        ...VIEWPORT,
      }).left,
    ).toBe(8);
  });
});
