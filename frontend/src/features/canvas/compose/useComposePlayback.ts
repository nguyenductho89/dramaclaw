// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The "master clock" of the timeline preview.
 *
 * Advance `playheadMs` with requestAnimationFrame, decoupled from the concrete media elements - the video / audio
 * elements are aligned on the component side by {@link activeClipAt} to this playhead with their own src + currentTime.
 * The clock advances independently (not reading video.currentTime), so the slight jitter caused by swapping the picture src across clip switches
 * does not drag down the overall progress, matching the trade-off that "the preview is not pixel-exact; the backend render is the final result".
 */
export interface ComposePlayback {
  playheadMs: number;
  isPlaying: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (ms: number) => void;
}

/**
 * The React state throttle interval (milliseconds). The playhead's "line movement" goes through onFrame changing the DOM directly
 * and is not subject to this; what is throttled here is only React state (driving the time readout + the paused-state media mirror + the whole
 * timeline re-render). Fully re-rendering that heavy and long timeline at 60fps was exactly the root cause of dropped frames; lowering it to ~5/s
 * is enough, and the line itself is still silky smooth every frame.
 */
const STATE_THROTTLE_MS = 200;

export function useComposePlayback(
  durationMs: number,
  /** Called back every frame (and on seek/play) with the latest playhead position, for the consumer to imperatively update the line DOM. */
  onFrame?: (ms: number) => void,
  /**
   * The "media master clock" while playing: returns the position (ms) on the timeline converted from the currently playing video element,
   * and returns null when unavailable (no video / buffering / clip boundary). When provided, the line advances following the real decoded frames,
   * in perfect sync with the picture (libtv effect); when it returns null it falls back to the performance.now wall clock, guaranteeing continuity.
   */
  clockMs?: () => number | null,
): ComposePlayback {
  const [playheadMs, setPlayheadMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const playheadRef = useRef(0);
  const isPlayingRef = useRef(false);
  const startWallRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const durationRef = useRef(durationMs);
  durationRef.current = durationMs;
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;
  const clockMsRef = useRef(clockMs);
  clockMsRef.current = clockMs;
  const lastStateMsRef = useRef(0);

  // force=true: sync React state immediately (seek / play / pause / reaching the end).
  // force=false: setState only when it differs from the last state value by more than the throttle threshold (used by rAF advance).
  const setPlayhead = useCallback((ms: number, force = true) => {
    playheadRef.current = ms;
    // The line position is updated imperatively every frame, bypassing React re-rendering.
    onFrameRef.current?.(ms);
    if (force || Math.abs(ms - lastStateMsRef.current) >= STATE_THROTTLE_MS) {
      lastStateMsRef.current = ms;
      setPlayheadMs(ms);
    }
  }, []);

  const stopRaf = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const setPlaying = useCallback((value: boolean) => {
    isPlayingRef.current = value;
    setIsPlaying(value);
  }, []);

  const tick = useCallback(() => {
    const dur = durationRef.current;
    // Prefer the media master clock (the line follows the real decoded frames); when unavailable fall back to the wall clock and align the wall-clock baseline
    // to the current position, ensuring that if the next frame still has no media clock it can continue seamlessly from the correct position.
    const fromMedia = clockMsRef.current?.();
    let elapsed: number;
    if (typeof fromMedia === "number" && Number.isFinite(fromMedia)) {
      elapsed = fromMedia;
      startWallRef.current = performance.now() - elapsed;
    } else {
      elapsed = performance.now() - startWallRef.current;
    }
    if (dur <= 0 || elapsed >= dur) {
      setPlayhead(dur > 0 ? dur : 0);
      setPlaying(false);
      stopRaf();
      return;
    }
    setPlayhead(elapsed, false);
    rafRef.current = requestAnimationFrame(tick);
  }, [setPlayhead, setPlaying, stopRaf]);

  const play = useCallback(() => {
    const dur = durationRef.current;
    if (dur <= 0) return;
    const from = playheadRef.current >= dur ? 0 : playheadRef.current;
    setPlayhead(from);
    startWallRef.current = performance.now() - from;
    setPlaying(true);
    stopRaf();
    rafRef.current = requestAnimationFrame(tick);
  }, [setPlayhead, setPlaying, stopRaf, tick]);

  const pause = useCallback(() => {
    setPlaying(false);
    stopRaf();
    // When paused, align React state to the real playhead: during playback state is throttled and may lag behind the
    // line/picture; without aligning there would be misalignments like "the line stopped on segment A while the preview shows segment B".
    lastStateMsRef.current = playheadRef.current;
    setPlayheadMs(playheadRef.current);
  }, [setPlaying, stopRaf]);

  const toggle = useCallback(() => {
    if (isPlayingRef.current) pause();
    else play();
  }, [pause, play]);

  const seek = useCallback(
    (ms: number) => {
      const dur = durationRef.current;
      const clamped = Math.max(0, Math.min(ms, dur));
      setPlayhead(clamped);
      if (isPlayingRef.current) startWallRef.current = performance.now() - clamped;
    },
    [setPlayhead],
  );

  // When an edit shortens the total duration to before the current playhead, pull the playhead back to the end.
  useEffect(() => {
    if (playheadRef.current > durationMs) seek(durationMs);
  }, [durationMs, seek]);

  useEffect(() => stopRaf, [stopRaf]);

  return { playheadMs, isPlaying, play, pause, toggle, seek };
}
