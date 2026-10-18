// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';
import { useState, type ReactElement } from 'react';
import { AlertCircle, Download, Loader2, Music } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/shadcn/dropdown-menu';
import { downloadAudioAs } from '@/features/canvas/application/audioDownload';
import type { AssetBoardItem } from '@/features/canvas/domain/assetBoard';
import {
  AUDIO_DOWNLOAD_FORMATS,
  canProduceFormat,
  getAudioExtFromUrl,
  type AudioDownloadFormat,
} from '@/lib/audioTranscode';

/** Duration badge format: mm:ss (matches "01:41" inside the reference image's square). */
function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const mm = Math.floor(s / 60)
    .toString()
    .padStart(2, '0');
  const ss = (s % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

/**
 * Audio chip: a large icon square + the title below (the same form as key elements / image thumbnails, matching the reference image).
 * Clicking the square = open the audio detail (waveform player + generation form, the same master-detail as image/video);
 * on hover a "download / format convert" button appears at the square's top-right (reusing the passthrough/transcode core of
 * application/audioDownload). The top audio bar (overview state) and the audio detail's left switcher share the same chip.
 *
 * Failure indicator: audio generation failures are written only on node.data.generationError, and the chip used to have only a generating
 * spinner and no trace of failure - what the user saw was "the spinner stopped and then nothing". Here a red badge is added on the square's corner
 * (the title carries the full error text), and the full error text is on the generation form in the detail.
 */
export function AssetBoardAudioChip({
  item,
  onOpen,
  selected = false,
}: {
  item: AssetBoardItem;
  /** Click the body -> open the detail panel of this audio node. */
  onOpen: (item: AssetBoardItem) => void;
  /** Selected highlight of the current detail item in the top audio bar (audio switcher). */
  selected?: boolean;
}): ReactElement {
  const [converting, setConverting] = useState<AudioDownloadFormat | null>(null);
  // When the node did not record durationMs (generation/upload paths mostly do not write it), use a hidden <audio preload="metadata">
  // to probe the real duration - otherwise the chip would stay empty forever.
  // Only land it in local state, do not write back to the node: updateNodeData would pushSnapshot into the undo stack and trackEdit
  // to mark dirty, while this probe is a passive behavior that "runs automatically when the storyboard is opened" - writing back would stuff the user
  // with N undo records without them doing anything (Ctrl+Z would undo these first) and trigger a pointless autosave.
  // The same basis as the image card's natural size fallback (AssetBoardCard's captureNaturalSize).
  const [probedSec, setProbedSec] = useState<number | null>(null);
  const audioUrl = item.mediaUrl;
  const sourceExt = audioUrl ? getAudioExtFromUrl(audioUrl) : '';
  // A separated audio node's title may not carry an extension; if it does, strip it and re-append by the chosen format.
  const baseFileName =
    item.title.replace(/\.(mp3|m4a|aac|wav|flac|ogg|opus|mp4|m4b)$/i, '') ||
    `audio-${item.nodeId}`;

  const handleDownload = async (format: AudioDownloadFormat) => {
    if (!audioUrl || converting) return;
    if (!canProduceFormat(format, sourceExt)) {
      toast.error(i18n.t('canvas.assetBoard.audioChip.notM4a'));
      return;
    }
    try {
      await downloadAudioAs(format, {
        audioUrl,
        baseFileName,
        onConvertingChange: setConverting,
      });
    } catch (error) {
      console.error('[asset-board] audio download failed', error);
      toast.error(i18n.t('canvas.assetBoard.audioChip.downloadFailed'));
    }
  };

  // Generating takes priority over failure: during a retry the previous red mark should not still be hanging.
  const failure = !item.isGenerating && item.generationError ? item.generationError : null;
  const durationSec = item.durationSec ?? probedSec;
  const durationLabel = durationSec !== null ? formatDuration(durationSec) : null;

  return (
    <div className="group flex w-12 shrink-0 flex-col items-center gap-1">
      <div className="relative h-12 w-12">
        <button
          type="button"
          aria-label={item.title}
          title={item.title}
          onClick={() => onOpen(item)}
          className={cn(
            // The square's background is uniformly #141414 (the pure black the user specified): selected/hover feedback goes through the border,
            // avoiding a white translucent layer brightening the background and breaking this pure black.
            'flex h-full w-full items-center justify-center rounded-[6px] border bg-[#141414] transition-colors',
            failure
              ? 'border-red-500/40'
              : selected
                ? 'border-white/25'
                : 'border-transparent hover:border-white/15',
          )}
        >
          {/* Icon on top, duration below and centered (matches the reference image), no longer a small badge pressed in the bottom-left corner. */}
          <span className="flex flex-col items-center gap-1">
            {item.isGenerating ? (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            ) : (
              <Music className="h-5 w-5 text-muted-foreground" />
            )}
            {durationLabel && (
              <span className="text-[10px] leading-none text-white/50">{durationLabel}</span>
            )}
          </span>
        </button>

        {/* Hidden audio for probing: mounted only when the node did not record a duration and none has been probed locally yet. */}
        {audioUrl && item.durationSec === null && probedSec === null && (
          <audio
            src={audioUrl}
            preload="metadata"
            className="hidden"
            onLoadedMetadata={(event) => {
              const seconds = event.currentTarget.duration;
              if (!Number.isFinite(seconds) || seconds <= 0) return;
              setProbedSec(seconds);
            }}
          />
        )}

        {failure && (
          <span
            aria-label={i18n.t('canvas.assetBoard.audioChip.generationFailed')}
            title={failure}
            className="pointer-events-none absolute left-1 top-1 inline-flex"
          >
            <AlertCircle className="h-3.5 w-3.5 text-red-400" />
          </span>
        )}

        {audioUrl && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={i18n.t('canvas.assetBoard.audioChip.downloadLabel', { title: item.title })}
                title={i18n.t('canvas.assetBoard.audioChip.downloadTitle')}
                disabled={converting !== null}
                className={cn(
                  'absolute right-1 top-1 rounded-md bg-black/50 p-1 text-white/80 transition-opacity hover:bg-black/70 disabled:cursor-not-allowed',
                  // Hidden normally, shown on hover/focus of the square; always visible while transcoding (with a spinner).
                  converting ? 'opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
                )}
              >
                {converting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              sideOffset={6}
              className="z-50 min-w-[170px] border-white/10 bg-[#2e2e2e] text-white/85 shadow-xl"
            >
              {AUDIO_DOWNLOAD_FORMATS.map((format) => {
                const available = canProduceFormat(format, sourceExt);
                return (
                  <DropdownMenuItem
                    key={format}
                    disabled={!available || converting !== null}
                    className="gap-2 rounded-md text-white/80 focus:bg-white/[0.08] focus:text-white"
                    onSelect={() => void handleDownload(format)}
                  >
                    {converting === format ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                    <span className="flex-1">{i18n.t('canvas.assetBoard.audioChip.downloadAs', { format: format.toUpperCase() })}</span>
                    {!available && <span className="text-[10px] opacity-60">{i18n.t('canvas.assetBoard.audioChip.m4aOnly')}</span>}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <span className="block w-full truncate text-center text-[11px] text-white/80">{item.title}</span>
    </div>
  );
}
