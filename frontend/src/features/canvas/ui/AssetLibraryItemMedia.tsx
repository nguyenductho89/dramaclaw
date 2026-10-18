// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// The picture layer of asset library cards: images are laid out directly, videos get a first-frame cover + hover in-place preview, and audio gets a
// hand-drawn small player.
//
// Audio used to be a native <audio controls> placed directly - the gray capsule the browser provides clashes with the dark
// skin of the whole panel, and also squeezes out the name along the bottom edge of the card. Here it becomes "a round play button + waveform progress bar +
// time", visually aligned with the video card's play badge, so the two kinds of non-image material look like one set.
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Play, Pause } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import type { LibraryItem } from './assetLibraryItems';

/** mm:ss; shows 0:00 while the duration has not been read yet, so the card does not flash a string of NaN. */
function formatClock(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const total = Math.floor(safe);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}

/**
 * Only one audio track sounds at a time. Cards are laid out in a grid, and clicking through them one by one easily piles into a wall of noise;
 * here the current one is remembered at module level, and playing a new one stops the old one.
 */
let playingAudio: HTMLAudioElement | null = null;

const WAVEFORM_BARS = 28;

/**
 * Generate a fixed string of waveform heights by URL.
 *
 * A real waveform needs the whole audio decoded to draw, which is too costly; all that is needed here is "each track looks different
 * but looks the same every time it is opened", and a linear congruential generator seeded by the URL is enough.
 */
function waveformHeights(seed: string): number[] {
  let state = 0;
  for (let i = 0; i < seed.length; i += 1) {
    state = (state * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return Array.from({ length: WAVEFORM_BARS }, () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return 26 + ((state >>> 16) % 74);
  });
}

export interface AssetLibraryItemMediaProps {
  entry: LibraryItem;
}

/** The card's picture layer. The outer layer handles the square container and overlays such as selection/delete; here we only fill the content. */
export function AssetLibraryItemMedia({ entry }: AssetLibraryItemMediaProps) {
  const src = resolveImageDisplayUrl(entry.url);
  if (entry.media === 'video') return <VideoThumb src={src} />;
  if (entry.media === 'audio') return <AudioThumb src={src} />;
  return (
    <img
      src={src}
      alt={entry.name}
      className="h-full w-full object-cover"
      draggable={false}
    />
  );
}

function VideoThumb({ src }: { src: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState(0);
  const [previewing, setPreviewing] = useState(false);

  // `#t=0.1` makes the browser seek to 0.1 second and paint that frame as the cover; t=0 is a black frame in some browsers.
  // preload=metadata pulls only the first frame, not the whole clip.
  const posterSrc = src.includes('#') ? src : `${src}#t=0.1`;

  const startPreview = () => {
    const el = videoRef.current;
    if (!el) return;
    void el.play().catch(() => undefined);
  };
  const stopPreview = () => {
    const el = videoRef.current;
    if (!el) return;
    el.pause();
    // Return to the cover frame, so after the mouse sweeps over a row of cards it does not leave a pile of pictures stuck halfway.
    el.currentTime = 0.1;
  };

  return (
    <div
      className="relative h-full w-full"
      onMouseEnter={startPreview}
      onMouseLeave={stopPreview}
    >
      <video
        ref={videoRef}
        src={posterSrc}
        className="h-full w-full object-cover"
        muted
        loop
        playsInline
        preload="metadata"
        tabIndex={-1}
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration;
          if (Number.isFinite(value) && value > 0) setDuration(value);
        }}
        onPlay={() => setPreviewing(true)}
        onPause={() => setPreviewing(false)}
      />
      {/* Play badge: fades out once the preview starts, so it does not smear over the middle of the picture. */}
      <span
        className={`pointer-events-none absolute left-1/2 top-1/2 flex h-10 w-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 ring-1 ring-white/25 backdrop-blur-[2px] transition-opacity duration-200 ${
          previewing ? 'opacity-0' : 'opacity-100'
        }`}
      >
        <Play className="ml-0.5 h-4 w-4 text-white" fill="currentColor" />
      </span>
      {duration > 0 && (
        // Placed at the bottom-left: the bottom-right is where the delete button is, and the bottom edge is left for the name.
        <span className="pointer-events-none absolute bottom-8 left-2 rounded bg-black/55 px-1.5 py-0.5 text-[10px] tabular-nums text-white/90">
          {formatClock(duration)}
        </span>
      )}
    </div>
  );
}

function AudioThumb({ src }: { src: string }) {
  const { t } = useTranslation();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bars] = useState(() => waveformHeights(src));

  // While playing, advance progress with rAF: the timeupdate event comes only four times a second, and the waveform would jump cell by cell.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const el = audioRef.current;
      if (el) setTime(el.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // When the card is replaced by paging/switching directory, the sound must stop with it - the worst case is the component gone while the <audio> keeps sounding.
  // The spec also pauses when an element is removed from the document, but that is a side effect rather than a guarantee, so stop explicitly once here.
  useEffect(
    () => () => {
      const el = audioRef.current;
      if (!el) return;
      el.pause();
      if (playingAudio === el) playingAudio = null;
    },
    [],
  );

  // Auditioning should not select the card in passing; the rest of the card still selects on click as usual.
  const toggle = (event: ReactMouseEvent) => {
    event.stopPropagation();
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      if (playingAudio && playingAudio !== el) playingAudio.pause();
      playingAudio = el;
      void el.play().catch(() => undefined);
    } else {
      el.pause();
    }
  };

  const seekTo = (event: ReactMouseEvent<HTMLElement>) => {
    event.stopPropagation();
    const el = audioRef.current;
    if (!el || duration <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const clientX = event.clientX;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    el.currentTime = ratio * duration;
    setTime(el.currentTime);
  };

  const progress = duration > 0 ? Math.min(1, time / duration) : 0;

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center gap-2.5 bg-[radial-gradient(120%_100%_at_50%_0%,rgba(120,140,255,0.16),rgba(255,255,255,0.02))] pb-7">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration;
          if (Number.isFinite(value) && value > 0) setDuration(value);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setTime(0);
        }}
      />

      <button
        type="button"
        onClick={toggle}
        aria-label={
          playing
            ? t('canvas.assetLibrary.audioPause')
            : t('canvas.assetLibrary.audioPlay')
        }
        className="flex h-10 w-10 items-center justify-center rounded-full bg-white/92 text-[#15161b] shadow-[0_2px_10px_rgba(0,0,0,0.35)] transition hover:scale-105 hover:bg-white"
      >
        {playing ? (
          <Pause className="h-4 w-4" fill="currentColor" />
        ) : (
          <Play className="ml-0.5 h-4 w-4" fill="currentColor" />
        )}
      </button>

      {/* The waveform is the progress bar: played bars light up, and clicking anywhere jumps there. */}
      <div
        role="slider"
        aria-label={t('canvas.assetLibrary.audioProgress')}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(time)}
        tabIndex={0}
        onClick={seekTo}
        className="flex h-5 w-[76%] cursor-pointer items-center justify-between gap-px"
      >
        {bars.map((height, index) => (
          <span
            key={index}
            style={{ height: `${height}%` }}
            className={`w-[2px] shrink-0 rounded-full transition-colors ${
              index / bars.length < progress ? 'bg-white/85' : 'bg-white/22'
            }`}
          />
        ))}
      </div>

      <div className="text-[10px] tabular-nums text-white/55">
        {playing || time > 0
          ? `${formatClock(time)} / ${formatClock(duration)}`
          : formatClock(duration)}
      </div>
    </div>
  );
}
