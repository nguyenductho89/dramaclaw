// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoClipPanel } from '@/features/canvas/nodes/VideoClipPanel';

const captureVideoFrames = vi.hoisted(() => vi.fn());

vi.mock('@/features/canvas/application/videoFrameStrip', () => ({
  captureVideoFrames,
}));

const TOTAL_MS = 10_000;
/** Track is 200px wide with its left edge at 0: clientX is directly "milliseconds / 50". */
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

function renderPanel(overrides: Partial<Parameters<typeof VideoClipPanel>[0]> = {}) {
  const onChange = vi.fn();
  const onSubmit = vi.fn();
  const onExit = vi.fn();
  const view = render(
    <VideoClipPanel
      videoUrl="https://cdn.example.com/a.mp4"
      durationMs={TOTAL_MS}
      clipStartMs={1_000}
      clipEndMs={5_000}
      onChange={onChange}
      onExit={onExit}
      onSubmit={onSubmit}
      {...overrides}
    />,
  );
  return { ...view, onChange, onExit, onSubmit };
}

function handles() {
  const start = screen.getByRole('slider', { name: 'Clip start' });
  const end = screen.getByRole('slider', { name: 'Clip end' });
  const selection = start.parentElement as HTMLElement;
  const track = selection.parentElement as HTMLElement;
  return { start, end, selection, track };
}

beforeEach(() => {
  captureVideoFrames.mockReset();
  captureVideoFrames.mockResolvedValue(['data:image/jpeg;base64,a']);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(TRACK_RECT);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VideoClipPanel dragging', () => {
  it('does not write the node while dragging; commits once on release', () => {
    const { onChange } = renderPanel();
    const { start } = handles();

    fireEvent.pointerDown(start, { clientX: 20, pointerId: 1 });
    fireEvent.pointerMove(start, { clientX: 60, pointerId: 1 });
    fireEvent.pointerMove(start, { clientX: 50, pointerId: 1 });
    fireEvent.pointerMove(start, { clientX: 40, pointerId: 1 });

    // Key point: every updateNodeData call pushes a canvas snapshot and clears the redo stack,
    // so it must not be called even once during the drag.
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.pointerUp(start, { clientX: 40, pointerId: 1 });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ clipStartMs: 2_000 });
  });

  it('the start never crosses the end, leaving at least 200ms', () => {
    const { onChange } = renderPanel();
    const { start } = handles();

    fireEvent.pointerDown(start, { clientX: 20, pointerId: 1 });
    fireEvent.pointerMove(start, { clientX: 180, pointerId: 1 });
    fireEvent.pointerUp(start, { clientX: 180, pointerId: 1 });

    expect(onChange).toHaveBeenCalledWith({ clipStartMs: 4_800 });
  });

  it('dragging the middle of the selection shifts it as a whole, duration unchanged', () => {
    const { onChange } = renderPanel();
    const { selection } = handles();

    fireEvent.pointerDown(selection, { clientX: 60, pointerId: 1 });
    fireEvent.pointerMove(selection, { clientX: 80, pointerId: 1 });
    fireEvent.pointerUp(selection, { clientX: 80, pointerId: 1 });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ clipStartMs: 2_000, clipEndMs: 6_000 });
  });

  it('pressing on empty track pulls the nearer handle over', () => {
    const { onChange } = renderPanel();
    const { track } = handles();

    // 8_000ms is closer to the end (5_000), so the end should be pulled rather than the start.
    fireEvent.pointerDown(track, { clientX: 160, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 160, pointerId: 1 });

    expect(onChange).toHaveBeenCalledWith({ clipEndMs: 8_000 });
  });
});

describe('VideoClipPanel keyboard', () => {
  it('arrow keys step by 100ms, Shift steps by 1s', () => {
    const { onChange } = renderPanel();
    const { start } = handles();

    fireEvent.keyDown(start, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith({ clipStartMs: 1_100 });

    fireEvent.keyDown(start, { key: 'ArrowLeft', shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith({ clipStartMs: 0 });
  });

  it('the End key on the end handle jumps to the clip end', () => {
    const { onChange } = renderPanel();
    const { end } = handles();

    fireEvent.keyDown(end, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith({ clipEndMs: TOTAL_MS });
  });

  it('ignores the keyboard while submitting', () => {
    const { onChange } = renderPanel({ isSubmitting: true });
    const { start } = handles();

    fireEvent.keyDown(start, { key: 'ArrowRight' });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('VideoClipPanel track width', () => {
  it('the track allots pixels by duration, so long clips spread out', () => {
    renderPanel({ durationMs: 44_000 });
    // 44s × 14px/s = 616px, rather than being squeezed to about two hundred pixels by the node width.
    expect(handles().track.style.minWidth).toBe('616px');
  });

  it('clips that are too short have a lower bound, too long an upper bound', () => {
    const short = renderPanel({ durationMs: 3_000 });
    expect(handles().track.style.minWidth).toBe('260px');
    short.unmount();

    renderPanel({ durationMs: 600_000 });
    expect(handles().track.style.minWidth).toBe('960px');
  });

  it('a wider track samples more frames, so cells are not stretched out of shape', () => {
    const short = renderPanel({ durationMs: 3_000 });
    expect(captureVideoFrames).toHaveBeenLastCalledWith(expect.any(String), 6);
    short.unmount();

    renderPanel({ durationMs: 600_000 });
    expect(captureVideoFrames).toHaveBeenLastCalledWith(expect.any(String), 10);
  });
});

describe('VideoClipPanel thumbnails', () => {
  it('lays out as many cells as frames sampled, with no black cells as filler', async () => {
    captureVideoFrames.mockResolvedValue([
      'data:image/jpeg;base64,a',
      'data:image/jpeg;base64,b',
      'data:image/jpeg;base64,c',
    ]);
    const { container } = renderPanel();

    await waitFor(() => {
      expect(container.querySelectorAll('[style*="background-image"]')).toHaveLength(3);
    });
  });

  it('can retry after a failure', async () => {
    captureVideoFrames.mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderPanel();

    const retry = await screen.findByRole('button', { name: 'Retry extracting frames' });
    expect(captureVideoFrames).toHaveBeenCalledTimes(1);

    fireEvent.click(retry);
    await waitFor(() => {
      expect(captureVideoFrames).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.queryByText('Failed to load frames')).toBeNull();
    });
  });

  it('the wheel does not pass through to the canvas (nowheel)', () => {
    const { container } = renderPanel();
    expect(container.firstElementChild?.className).toContain('nowheel');
  });
});
