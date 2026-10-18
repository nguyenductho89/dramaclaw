// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Regression: a playing audio node must not be swapped out by the low-zoom tier's shell.
 *
 * The audio node is not in LOD_SHELL_EXEMPT_TYPES, the playing state is internal component state of AudioWaveformPlayer,
 * and the shell decision (withLodShell) outside the component cannot read it. The play button also
 * stopPropagation, so the node is not selected and gets no "selection exemption". Stacked together: click play while
 * unselected → zoom out past the threshold → <audio> unmounts with the component → playback is interrupted and progress resets to zero.
 *
 * This locks two things:
 *   1. The player reports the playing state to the caller (AudioNode writes setNodeMediaActive from it);
 *   2. A node with active media is not re-shelled across the threshold, and the DOM instance is the same one (progress does not reset).
 */
import { render, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AudioWaveformPlayer } from '@/features/canvas/ui/AudioWaveformPlayer';
import {
  isNodeMediaActive,
  setCanvasGestureActive,
  setNodeMediaActive,
} from '@/features/canvas/application/canvasLod';

// ---- @xyflow/react: only useStore needs to read transform[2], and Handle renders as an empty node ----
let currentZoom = 1;
vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  useStore: (selector: (state: { transform: [number, number, number] }) => unknown) =>
    selector({ transform: [0, 0, currentZoom] }),
}));

// Canvas store: in these cases the node is never selected (exactly the consequence of the play button's stopPropagation).
vi.mock('@/stores/canvasStore', () => ({
  useCanvasStore: (selector: (state: { selectedNodeId: string | null }) => unknown) =>
    selector({ selectedNodeId: null }),
}));

const { withLodShell } = await import('@/features/canvas/nodes/LodShellNode');

const NODE_ID = 'audio-1';

function AudioStub() {
  return <div data-testid="full-audio-node">waveform</div>;
}

const WrappedAudioNode = withLodShell('audioNode', AudioStub);

function renderAudioNode() {
  return render(
    <WrappedAudioNode
      id={NODE_ID}
      type="audioNode"
      data={{}}
      selected={false}
      width={420}
      height={220}
      dragging={false}
      zIndex={0}
      isConnectable
      positionAbsoluteX={0}
      positionAbsoluteY={0}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {...({} as any)}
    />,
  );
}

describe('AudioWaveformPlayer reports its playing state outward', () => {
  beforeEach(() => {
    // jsdom has no ResizeObserver / canvas 2d / AudioContext, and the waveform line is not the focus
    // of these cases; a minimal stub that lets the component mount is enough.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in test')));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('notifies the caller on both play and pause', async () => {
    const onPlayingChange = vi.fn();
    const { container } = render(
      <AudioWaveformPlayer src="blob:audio" onPlayingChange={onPlayingChange} />,
    );
    // Sync "not playing" once on mount.
    expect(onPlayingChange).toHaveBeenLastCalledWith(false);

    const audio = container.querySelector('audio');
    expect(audio).not.toBeNull();

    // jsdom does not implement play(), so drive the pause/ended events the component listens to and the play entry directly.
    const playButton = container.querySelector('button[aria-label="play"]');
    expect(playButton).not.toBeNull();
    // jsdom's paused is always true, so togglePlay takes the play() branch.
    await act(async () => {
      (playButton as HTMLButtonElement).click();
    });
    expect(onPlayingChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      audio!.dispatchEvent(new Event('pause'));
    });
    expect(onPlayingChange).toHaveBeenLastCalledWith(false);
  });

  it('emits false when unmounted while playing — <audio> unmount does not dispatch a pause event', async () => {
    const onPlayingChange = vi.fn();
    const { container, unmount } = render(
      <AudioWaveformPlayer src="blob:audio" onPlayingChange={onPlayingChange} />,
    );
    await act(async () => {
      (container.querySelector('button[aria-label="play"]') as HTMLButtonElement).click();
    });
    expect(onPlayingChange).toHaveBeenLastCalledWith(true);

    onPlayingChange.mockClear();
    unmount();
    expect(onPlayingChange).toHaveBeenCalledWith(false);
  });
});

describe('a playing audio node is not re-shelled across the low-zoom tier', () => {
  beforeEach(() => {
    currentZoom = 1;
    setCanvasGestureActive(false);
    setNodeMediaActive(NODE_ID, false);
  });

  afterEach(() => {
    setNodeMediaActive(NODE_ID, false);
    vi.restoreAllMocks();
  });

  it('when not playing, zooming below the threshold swaps to the shell (control group)', () => {
    const { queryByTestId, rerender } = renderAudioNode();
    expect(queryByTestId('full-audio-node')).not.toBeNull();

    currentZoom = 0.2;
    act(() => {
      rerender(
        <WrappedAudioNode
          id={NODE_ID}
          type="audioNode"
          data={{}}
          selected={false}
          width={420}
          height={220}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          {...({} as any)}
        />,
      );
    });
    expect(queryByTestId('full-audio-node')).toBeNull();
  });

  it('while playing, zooming below the threshold keeps the full component, and the DOM instance is not rebuilt (progress is not lost)', () => {
    const { queryByTestId, rerender } = renderAudioNode();
    const before = queryByTestId('full-audio-node');
    expect(before).not.toBeNull();

    // Click play while unselected: AudioNode writes the playing state into the module-level registry.
    setNodeMediaActive(NODE_ID, true);
    expect(isNodeMediaActive(NODE_ID)).toBe(true);

    currentZoom = 0.2;
    act(() => {
      rerender(
        <WrappedAudioNode
          id={NODE_ID}
          type="audioNode"
          data={{}}
          selected={false}
          width={420}
          height={220}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          {...({} as any)}
        />,
      );
    });

    const after = queryByTestId('full-audio-node');
    expect(after).not.toBeNull();
    // The same DOM node — the component was not unmounted and remounted, so the <audio>'s currentTime is naturally still there.
    expect(after).toBe(before);
  });
});
