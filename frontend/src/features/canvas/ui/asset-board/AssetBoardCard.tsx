// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { AlertCircle, ChevronRight, FileText, MapPin, ImageIcon, Loader2, Play } from 'lucide-react';

import {
  modelBadgeLabel,
  type AssetBoardColumn,
  type AssetBoardItem,
  type AssetBoardReference,
} from '@/features/canvas/domain/assetBoard';
import { AddNodeToChatIconButton } from '@/features/canvas/ui/AddNodeToChatButton';
import { cn } from '@/lib/utils';

import { useEstimatedProgress } from '../useEstimatedProgress';
import { AssetBoardReferenceThumbMenu } from './AssetBoardReferenceThumbMenu';
import { writeBoardReferenceDragPayload } from './boardReferenceDrag';

interface AssetBoardCardProps {
  item: AssetBoardItem;
  /** Click the card body (open the preview). */
  onOpen: (item: AssetBoardItem) => void;
  /** "Locate on canvas" - switch back to the workflow and focus the node. */
  onLocate: (nodeId: string) => void;
  /** Click a reference asset thumbnail -> lightbox preview of that image. */
  onPreviewImage: (url: string) => void;
  /** Reference asset hover "Edit" -> open the referenced node's detail, where the user edits (same semantics as the detail panel). */
  onOpenReference?: (ref: AssetBoardReference) => void;
  /** Reference asset hover "Locate" -> scroll the storyboard list to the referenced node's card and highlight it (not canvas positioning). */
  onLocateReference?: (nodeId: string) => void;
  /** Selected item highlight in the left narrow list in master-detail mode. */
  selected?: boolean;
  /** The storyboard as a whole is invisible (kept-alive hidden): stop the generation progress polling, do not spin idly in the background. */
  paused?: boolean;
  /**
   * "Locate" scroll request token: when "Locate" is clicked on a reference asset in the detail and this card is exactly the referenced node,
   * the parent passes a monotonically increasing token to this card (other cards are always null, so memo is not interrupted).
   * Each token change (including re-locating the same node) -> the card scrolls into view and highlights briefly; null -> clear the highlight.
   */
  scrollTargetToken?: number | null;
}

/** Duration (ms) of the "locate" highlight: the border pulses once and ends, only to draw the eye to the card. */
const LOCATE_HIGHLIGHT_MS = 1200;

/**
 * Media empty-state text: the node has no image/video yet (params and prompt are in place, waiting for the user to confirm and submit on the generation bar).
 * The same sentence is shared by image and video, card and detail (four places), avoiding some places having an explanation and others only a gray icon.
 */
export function emptyMediaPlaceholderText(): string {
  return i18n.t('canvas.assetBoard.pendingConfirm');
}

/**
 * Empirical estimates of generation time per column (ms) - not the backend's real progress; the backend does not send step-by-step progress events,
 * this only gives useEstimatedProgress's linear time interpolation an order of magnitude: images are fastest, video
 * slowest, and text (scripts/storyboard tables etc.) in between, leaning fast. If the user has a more accurate number for how long a column feels like it takes,
 * change this table; it does not affect the estimation algorithm itself.
 */
const ESTIMATED_GENERATION_DURATION_MS: Record<AssetBoardColumn, number> = {
  text: 10_000,
  image: 20_000,
  audio: 30_000,
  video: 60_000,
};

/** Lets other files such as AssetBoardDetail reuse the same estimated durations (keeping cards and details consistent). */
export function estimatedGenerationDurationMs(column: AssetBoardColumn): number {
  return ESTIMATED_GENERATION_DURATION_MS[column];
}

/**
 * A small "Generating X%..." label: X is a time estimate by useEstimatedProgress from generationStartedAt + the estimated durations in the table above
 * (not the backend's real progress). Split into its own subcomponent so the 120ms polling
 * timer only mounts when the card is really generating - cards not generating are not
 * slowed by this effect (AssetBoardCard renders it conditionally on item.isGenerating).
 * className can override the default style: media cards overlay the progress on the thumbnail mask (one size larger, white 85%),
 * and text cards have no media area, falling back to the inline small label on the title row (default style).
 */
function GeneratingLabel({
  item,
  className,
  paused,
}: {
  item: AssetBoardItem;
  className?: string;
  /** Stop the timer when the storyboard is kept-alive hidden (see the paused note of useEstimatedProgress). */
  paused?: boolean;
}): ReactElement {
  const percent = useEstimatedProgress(
    item.generationStartedAt,
    estimatedGenerationDurationMs(item.column),
    paused,
  );
  return <span className={cn('text-[11px] text-white/40', className)}>{i18n.t('canvas.assetBoard.generatingPercent', { percent })}</span>;
}

// Duration/resolution badges: pill shape + thin border + very faint background, matching the liblib reference image.
// "Final" no longer goes through here - it moved to an overlay badge at the top-left of the video thumbnail (see the VideoThumb call site below).
// The badge row of AssetBoardDetail reuses the same Chip (exported).
export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-0.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] leading-4 text-white/70">
      {children}
    </span>
  );
}

/**
 * Video thumbnail: use the cover if there is one, otherwise take the first frame (#t=0.1) from <video preload="metadata">.
 * Exported for the expanded-state grid card to reuse - many video nodes have no recorded cover, and trusting only thumbnailUrl
 * would give a screen full of black boxes (user feedback).
 */
export function VideoThumb({ item }: { item: AssetBoardItem }) {
  if (item.thumbnailUrl) {
    return <img src={item.thumbnailUrl} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover" />;
  }
  if (item.mediaUrl) {
    return (
      <video
        src={`${item.mediaUrl}#t=0.1`}
        preload="metadata"
        muted
        playsInline
        draggable={false}
        className="h-full w-full object-cover"
      />
    );
  }
  // Neither cover nor source = an empty video node not yet generated: like the image empty state, say plainly "generates after confirmation",
  // rather than an unexplained gray icon (the video generation form in the detail is its confirmation entry).
  return (
    <div className="flex flex-col items-center gap-1.5">
      <Play className="h-6 w-6 text-muted-foreground" />
      <span className="text-[11px] text-muted-foreground">{emptyMediaPlaceholderText()}</span>
    </div>
  );
}

export function AssetBoardCard({
  item,
  onOpen,
  onLocate,
  onPreviewImage,
  onOpenReference,
  onLocateReference,
  selected = false,
  paused = false,
  scrollTargetToken = null,
}: AssetBoardCardProps): ReactElement {
  const cardRef = useRef<HTMLDivElement | null>(null);
  // Thumbnail container: used as the custom drag ghost while dragging, showing only the content thumbnail without the title/reference asset panel.
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const [locateHighlighted, setLocateHighlighted] = useState(false);
  // The original size the image actually loaded at: only a fallback for the resolution badge when the node has not recorded widthPx/heightPx.
  // Stored together with the url, so after switching images (the same card switching node/result) the old size is invalidated immediately and does not cross over.
  const [loadedSize, setLoadedSize] = useState<{
    url: string;
    width: number;
    height: number;
  } | null>(null);
  const naturalSize =
    loadedSize && loadedSize.url === item.thumbnailUrl ? loadedSize : null;
  // If the node already recorded a size there is no need to read the image (so no ref/onLoad is attached).
  const needsNaturalSize = item.widthPx === null || item.heightPx === null;
  // Both ref and onLoad paths are used: new images go through onLoad; images already in cache are complete at mount,
  // the load event will not come again, so they can only be read on the spot in the ref callback. The same url returns the original state, and React bails
  // out directly, with no repeated re-renders because the ref is called on every render.
  const captureNaturalSize = useCallback((img: HTMLImageElement | null) => {
    if (!img || !img.complete || !img.naturalWidth || !img.naturalHeight) return;
    const url = img.getAttribute('src') ?? '';
    setLoadedSize((prev) =>
      prev && prev.url === url && prev.width === img.naturalWidth
        ? prev
        : { url, width: img.naturalWidth, height: img.naturalHeight },
    );
  }, []);

  // "Locate" scroll + highlight: token non-null (this card is the referenced node) -> scroll into view, flash, then fade; token back
  // to null (locate switched to another card) -> immediately clear this card's leftover highlight. The effect depends only on the token,
  // and non-target cards are always null, so unrelated re-renders do not trigger it repeatedly.
  useEffect(() => {
    if (scrollTargetToken === null) {
      setLocateHighlighted(false);
      return;
    }
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setLocateHighlighted(true);
    const timer = setTimeout(() => setLocateHighlighted(false), LOCATE_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [scrollTargetToken]);

  const isFinalVideo = item.column === 'video' && item.videoRole === 'final';
  const badges: ReactElement[] = [];
  // The model is shown only on video cards, and only when the node really recorded a model (uploaded/edited videos have no
  // model field -> take no space). Image cards keep only the resolution as requested, without the model.
  if (item.column === 'video' && item.model) {
    badges.push(
      <Chip key="model">
        <span className="max-w-[160px] truncate" title={item.model}>
          {modelBadgeLabel(item.model)}
        </span>
      </Chip>,
    );
  }
  if (item.durationSec !== null) badges.push(<Chip key="dur">{i18n.t('canvas.assetBoard.durationSec', { count: item.durationSec })}</Chip>);
  // Resolution prefers the node's recorded size; nodes with no recorded size such as uploaded images fall back to the original size the image actually loaded at
  // (the card shows the original image, so naturalWidth is the real resolution).
  // Take the pair as a whole rather than falling back per item: with half-broken data (only widthPx recorded), per-item fallback would pair the stored width with the
  // probed height, producing a size wrong on both sides.
  const hasStoredSize = item.widthPx !== null && item.heightPx !== null;
  const width = hasStoredSize ? item.widthPx : (naturalSize?.width ?? null);
  const height = hasStoredSize ? item.heightPx : (naturalSize?.height ?? null);
  if (width !== null && height !== null) {
    badges.push(<Chip key="dim">{`${width} × ${height}`}</Chip>);
  }

  // hover uses low-opacity white rather than border-border/bg-muted: semantic tokens on the #262626 panel
  // appear as a harsh light outline, here we match liblib's soft highlight.
  return (
    <div
      ref={cardRef}
      data-locate-highlight={locateHighlighted ? 'true' : undefined}
      onClick={() => onOpen(item)}
      // The whole card is a drag source: dragged into the reference area of the detail generation form -> connects this node as an upstream
      // reference of the current detail node (AssetBoardReferenceDropZone lands addEdge). The payload only carries the nodeId (an existing node,
      // not newly created); the inner <img>/<video> set draggable=false, ensuring the drag starts from the card itself rather than
      // becoming the browser's default image drag. Click semantics are unaffected (a click with no displacement does not trigger dragstart).
      draggable
      onDragStart={(event) => {
        writeBoardReferenceDragPayload(event.dataTransfer, { nodeId: item.nodeId });
        // Custom drag ghost: capture only the thumbnail block, not the browser's default "screenshot of the whole card" (which would bring along the title,
        // badges and reference asset panel). The offset is clamped within the thumbnail range, ensuring the cursor always lands on the ghost.
        // Text cards have no thumbnail container (thumbRef is empty) -> keep the default whole-card ghost.
        const thumb = thumbRef.current;
        if (thumb) {
          const rect = thumb.getBoundingClientRect();
          const offsetX = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
          const offsetY = Math.min(Math.max(event.clientY - rect.top, 0), rect.height);
          event.dataTransfer.setDragImage(thumb, offsetX, offsetY);
        }
      }}
      className={cn(
        'group relative flex cursor-pointer flex-col gap-2 rounded-md border p-2 transition-colors',
        // Hover feedback by column (user request):
        // - text cards are rows of a list, where a light background + outline on the whole row is the standard list feel, so keep it;
        // - image/video cards are almost entirely media, and adding a gray background layer would become a big dirty gray slab (especially
        //   once dividers are added), so the card body does not change and feedback lands only on the media area (see ring below)
        //   and the title brightening.
        selected
          ? 'border-white/10 bg-white/[0.06]'
          : cn(
              'border-transparent',
              item.column === 'text' && 'hover:border-white/10 hover:bg-white/[0.04]',
            ),
        // "Locate" hit: cyan ring + pulse, briefly drawing the eye to this card (ends after LOCATE_HIGHLIGHT_MS).
        locateHighlighted && 'animate-pulse ring-2 ring-primary',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        {/* Title color by column (user decision): text cards pure white (along with the file icon, dropping their own muted color to inherit white),
        image/video cards gray - they have a thumbnail below, and the title is only secondary description. */}
        <div
          className={cn(
            'flex min-w-0 items-center gap-1.5 text-[13px] transition-colors',
            // Image/video card titles are normally pressed to 60% gray (the thumbnail is below, the title is only secondary description),
            // brightening on hover, which together with the media-area outline forms "this card is being pointed at".
            item.column === 'text' ? 'text-white' : 'text-white/60 group-hover:text-white/90',
          )}
        >
          {item.column === 'text' && <FileText className="h-3.5 w-3.5 shrink-0" />}
          <button
            type="button"
            className="min-w-0 truncate text-left"
            onClick={(event) => {
              event.stopPropagation();
              onOpen(item);
            }}
          >
            {item.title}
          </button>
          {/* Text cards have no media area, so generation progress can only hang on the title row; for image/video cards the progress is overlaid on
          the thumbnail mask below (no longer trailing the title, see the isGenerating branch of the media area). */}
          {item.column === 'text' && item.isGenerating && (
            <GeneratingLabel item={item} className="shrink-0" paused={paused} />
          )}
          {/* Text cards have no media area to hang a failure badge on (script etc. also carry generationError) -
          a small inline indicator next to the title; media cards still use the badge in the media area below. */}
          {item.column === 'text' && !item.isGenerating && item.generationError && (
            <span
              title={item.generationError}
              className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-red-400"
            >
              <AlertCircle className="h-3 w-3" />
              {i18n.t('canvas.assetBoard.failed')}
            </span>
          )}
        </div>
        {/* The action group that appears on hover only. The storyboard and the canvas are two projections of the same node data,
        and the behavior of "Add to chat" must be consistent - so the shared component is used directly (emits an event; FreezoneShell
        lands select + expand chat uniformly), only restyled in this view's icon-button language. */}
        <div className="invisible flex shrink-0 items-center gap-0.5 group-hover:visible group-focus-within:visible">
          <AddNodeToChatIconButton
            nodeId={item.nodeId}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            iconClassName="h-3.5 w-3.5"
          />
          <button
            type="button"
            aria-label={i18n.t('canvas.assetBoard.locateOnCanvas')}
            title={i18n.t('canvas.assetBoard.locateOnCanvas')}
            onClick={(event) => {
              event.stopPropagation();
              onLocate(item.nodeId);
            }}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <MapPin className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Text cards show only the icon + title (the title row above); body text does not enter the list - go to the detail to see it (user request). */}
      {item.column === 'text' ? null : (
        <div
          ref={thumbRef}
          // On hover the media area gets an inner outline ring (no background change, no scaling) - feedback lands on the content itself,
          // far more restrained than painting the whole card with a gray background.
          className="relative flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-[#141414] ring-1 ring-inset ring-transparent transition-[box-shadow] group-hover:ring-white/20"
        >
          {item.column === 'video' ? (
            <>
              <VideoThumb item={item} />
              {isFinalVideo && (
                <span className="absolute left-1.5 top-1.5 z-10 inline-flex items-center gap-0.5 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-medium text-white/90 backdrop-blur-sm">
                  {i18n.t('canvas.assetBoard.finalBadge')}
                  <ChevronRight className="h-3 w-3" />
                </span>
              )}
              {(item.thumbnailUrl || item.mediaUrl) && (
                <span className="absolute inset-0 flex items-center justify-center">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/45 backdrop-blur-sm">
                    <Play className="h-4 w-4 fill-white text-white" />
                  </span>
                </span>
              )}
            </>
          ) : item.thumbnailUrl ? (
            <img
              src={item.thumbnailUrl}
              alt=""
              loading="lazy"
              draggable={false}
              ref={needsNaturalSize ? captureNaturalSize : undefined}
              onLoad={
                needsNaturalSize ? (event) => captureNaturalSize(event.currentTarget) : undefined
              }
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex flex-col items-center gap-1.5">
              <ImageIcon className="h-6 w-6 text-muted-foreground" />
              <span className="text-[11px] text-muted-foreground">
                {emptyMediaPlaceholderText()}
              </span>
            </div>
          )}
          {/* Generating: mask + centered spinner + "Generating X%..." progress (covering overlays such as the play button,
          highest z). The progress is overlaid directly on the card thumbnail, no longer trailing the node title.
          If there is media underneath (regeneration) use semi-transparency - so the user can still see the one being replaced;
          if underneath is the empty-state placeholder (first generation) the mask must be opaque, otherwise the "generates after confirmation"
          icon and text would show through the mask and pile up with the spinner and percentage into a blur of text. */}
          {item.isGenerating && (
            <span
              role="status"
              aria-label={i18n.t('canvas.assetBoard.generating')}
              className={cn(
                'absolute inset-0 z-20 flex flex-col items-center justify-center gap-1.5',
                item.thumbnailUrl || item.mediaUrl ? 'bg-black/50' : 'bg-[#141414]',
              )}
            >
              <Loader2 className="h-5 w-5 animate-spin text-white" />
              <GeneratingLabel item={item} className="text-[12px] text-white/85" paused={paused} />
            </span>
          )}
          {/* Failure badge: shown only when not generating (while retrying the spinner prevails), hover to see the full error. */}
          {!item.isGenerating && item.generationError && (
            <span
              title={item.generationError}
              className="absolute left-1.5 top-1.5 z-20 inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-medium text-red-400 backdrop-blur-sm"
            >
              <AlertCircle className="h-3 w-3" />
              {i18n.t('canvas.assetBoard.failed')}
            </span>
          )}
        </div>
      )}

      {badges.length > 0 && <div className="flex flex-wrap gap-1">{badges}</div>}

      {item.references.length > 0 && (
        // Reference assets: no border outline, no background fill (user request), separated from the content image above only by
        // the top margin.
        <div className="mt-3 flex flex-col gap-1.5">
          {/* No longer write the "Reference assets" title - the thumbnails alone are expressive enough (user request). */}
          <div className="flex flex-wrap gap-1">
            {item.references.map((ref) => {
              const refNodeId = ref.nodeId;
              // No reference callback (a pure navigation scenario such as the narrow list on the detail's left) -> fall back to a
              // bare thumbnail that "opens the lightbox", with no menu attached.
              if (!onOpenReference) {
                return (
                  <button
                    key={refNodeId ?? `own:${ref.thumbnailUrl}`}
                    type="button"
                    aria-label={ref.label}
                    title={ref.label}
                    onClick={(event) => {
                      event.stopPropagation();
                      onPreviewImage(ref.thumbnailUrl);
                    }}
                    // 5px corner radius: 3px is nearly a right angle and too hard, 8px (rounded-lg) too round; 5px has a slightly soft
                    // radius without looking round, the feel the user decided on.
                    className="h-10 w-10 shrink-0 overflow-hidden rounded-[5px] border border-border"
                  >
                    <img src={ref.thumbnailUrl} alt={ref.label} loading="lazy" draggable={false} className="h-full w-full object-cover" />
                  </button>
                );
              }
              return (
                <AssetBoardReferenceThumbMenu
                  // A built-in reference image has nodeId=null (no upstream node), so use the url as a fallback key.
                  key={refNodeId ?? `own:${ref.thumbnailUrl}`}
                  reference={ref}
                  onEdit={() => onOpenReference(ref)}
                  // A built-in image has nowhere to locate (no matching canvas node/card) -> no "Locate" item.
                  onLocate={
                    onLocateReference && refNodeId ? () => onLocateReference(refNodeId) : null
                  }
                  // The reference thumbnail in a card is 40px (48px in the detail); clicking still opens the lightbox for the large image,
                  // edit/locate are left to the menu that appears on hover.
                  className="h-10 w-10 rounded-[5px]"
                  onThumbClick={() => onPreviewImage(ref.thumbnailUrl)}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
