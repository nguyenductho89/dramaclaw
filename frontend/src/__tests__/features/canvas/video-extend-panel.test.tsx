// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoExtendPanel } from '@/features/canvas/nodes/VideoExtendPanel';

const captureVideoFrames = vi.hoisted(() => vi.fn());

vi.mock('@/features/canvas/application/videoFrameStrip', () => ({
  captureVideoFrames,
}));

const TOTAL_MS = 60_000;
/** Track is 200px wide with its left edge at 0, so clientX is simply "milliseconds / 300". */
const TRACK_RECT = {
  x: 0,
  y: 0,
  left: 0,
  top: 0,
  right: 200,
  bottom: 56,
  width: 200,
  height: 56,
  toJSON: () => ({}),
} as DOMRect;

function renderPanel(overrides: Partial<Parameters<typeof VideoExtendPanel>[0]> = {}) {
  const onConfirm = vi.fn();
  const onExit = vi.fn();
  const view = render(
    <VideoExtendPanel
      videoUrl="https://cdn.example.com/a.mp4"
      durationMs={TOTAL_MS}
      onConfirm={onConfirm}
      onExit={onExit}
      {...overrides}
    />,
  );
  return { ...view, onConfirm, onExit };
}

function handles() {
  return {
    start: screen.getByRole('slider', { name: 'Extend clip start' }),
    end: screen.getByRole('slider', { name: 'Extend clip end' }),
    confirm: screen.getByRole('button', { name: /Confirm extend/ }),
  };
}

function drag(el: HTMLElement, toX: number) {
  fireEvent.pointerDown(el, { clientX: 100, pointerId: 1 });
  fireEvent.pointerMove(el, { clientX: toX, pointerId: 1 });
  fireEvent.pointerUp(el, { clientX: toX, pointerId: 1 });
}

beforeEach(() => {
  captureVideoFrames.mockReset();
  captureVideoFrames.mockResolvedValue(['data:image/jpeg;base64,a']);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(TRACK_RECT);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VideoExtendPanel default selection', () => {
  it('long clips default to the last 30s', () => {
    renderPanel();
    expect(screen.getByText('30.00s')).toBeTruthy();
    expect(handles().start.getAttribute('aria-valuenow')).toBe('30000');
    expect(handles().end.getAttribute('aria-valuenow')).toBe('60000');
  });

  it('clips under 30s are used whole as the lead-in', () => {
    renderPanel({ durationMs: 15_070 });
    expect(screen.getByText('15.07s')).toBeTruthy();
    expect(handles().confirm.hasAttribute('disabled')).toBe(false);
  });

  it('single selection: the track only ever has one pair of handles', () => {
    renderPanel();
    expect(screen.getAllByRole('slider')).toHaveLength(2);
  });
});

describe('VideoExtendPanel 4-30s bounds', () => {
  it('shrinking below 4s is clamped and shows a hint', () => {
    renderPanel();
    // 57_000ms would leave a 3s selection, which the 4s minimum clamps back to 56_000.
    drag(handles().start, 190);

    expect(handles().start.getAttribute('aria-valuenow')).toBe('56000');
    expect(screen.getByText('The selected clip must be at least 4s')).toBeTruthy();
  });

  it('growing past 30s is clamped and shows a hint', () => {
    renderPanel();
    // Dragging the start toward the head: the selection is already a full 30s, so going further left hits the cap.
    drag(handles().start, 20);

    expect(handles().start.getAttribute('aria-valuenow')).toBe('30000');
    expect(screen.getByText('The selected clip can\'t exceed 30s')).toBeTruthy();
  });

  it('the hint dismisses itself after a moment and does not block the next drag', () => {
    vi.useFakeTimers();
    try {
      renderPanel();
      drag(handles().start, 190);
      expect(screen.getByText('The selected clip must be at least 4s')).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(2_500);
      });
      expect(screen.queryByText('The selected clip must be at least 4s')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('no hint is shown when no bound is hit', () => {
    renderPanel();
    drag(handles().start, 140); // 42_000ms, 18s selection, neither bound is reached

    expect(handles().start.getAttribute('aria-valuenow')).toBe('42000');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('confirm is disabled when the clip itself is under 4s', () => {
    renderPanel({ durationMs: 3_000 });
    const { confirm } = handles();
    expect(confirm.hasAttribute('disabled')).toBe(true);
    expect(confirm.getAttribute('title')).toBe('Video is shorter than 4s and can\'t be extended');
  });
});

describe('VideoExtendPanel keyboard', () => {
  it('arrow keys step by 100ms, Shift steps by 1s', () => {
    renderPanel();
    const { start } = handles();

    // The default selection is exactly 30s, so the start is already at the cap and can only move right (shorten).
    fireEvent.keyDown(start, { key: 'ArrowRight' });
    expect(start.getAttribute('aria-valuenow')).toBe('30100');

    fireEvent.keyDown(start, { key: 'ArrowRight', shiftKey: true });
    expect(start.getAttribute('aria-valuenow')).toBe('31100');

    fireEvent.keyDown(start, { key: 'ArrowLeft' });
    expect(start.getAttribute('aria-valuenow')).toBe('31000');
  });

  it('when the selection is already 30s, moving the start further left does nothing', () => {
    renderPanel();
    const { start } = handles();

    fireEvent.keyDown(start, { key: 'ArrowLeft' });
    expect(start.getAttribute('aria-valuenow')).toBe('30000');
    expect(screen.getByText('The selected clip can\'t exceed 30s')).toBeTruthy();
  });

  it('hitting a bound via keyboard also shows the hint', () => {
    renderPanel();
    fireEvent.keyDown(handles().start, { key: 'Home' });

    expect(handles().start.getAttribute('aria-valuenow')).toBe('30000');
    expect(screen.getByText('The selected clip can\'t exceed 30s')).toBeTruthy();
  });
});

describe('VideoExtendPanel exits', () => {
  it('confirm hands off the current range', () => {
    const { onConfirm } = renderPanel();
    drag(handles().start, 140);
    fireEvent.click(handles().confirm);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith({ startMs: 42_000, endMs: 60_000 });
  });

  it('X exits trimming', () => {
    const { onExit } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Exit extend clip selection' }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('while submitting, keyboard is ignored and confirm cannot be clicked', () => {
    renderPanel({ isSubmitting: true });
    const { start, confirm } = handles();

    fireEvent.keyDown(start, { key: 'ArrowRight' });
    expect(start.getAttribute('aria-valuenow')).toBe('30000');
    expect(confirm.hasAttribute('disabled')).toBe(true);
  });

  it('wheel does not leak through to the canvas (nowheel)', () => {
    const { container } = renderPanel();
    expect(container.querySelector('.nowheel')).toBeTruthy();
  });
});
