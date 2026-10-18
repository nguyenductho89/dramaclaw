// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';
import { useEffect, useRef, type ReactElement, type RefObject } from 'react';
import { ChevronLeft, Copy, ImageIcon, Loader2, Music, Play, Trash2, X } from 'lucide-react';

import type {
  AssetBoardColumn,
  AssetBoardItem,
  AssetBoardReference,
} from '@/features/canvas/domain/assetBoard';
import {
  isExportImageNode,
  isImageEditNode,
  isImageGenNode,
  isVideoNode,
  type AudioNodeData,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { AddNodeToChatIconButton } from '@/features/canvas/ui/AddNodeToChatButton';
import { AudioWaveformPlayer } from '@/features/canvas/ui/AudioWaveformPlayer';
import { useEstimatedProgress } from '@/features/canvas/ui/useEstimatedProgress';
import { cn } from '@/lib/utils';
import { useCanvasStore } from '@/stores/canvasStore';

import { AssetBoardAudioGenForm } from './AssetBoardAudioGenForm';
import { Chip, emptyMediaPlaceholderText, estimatedGenerationDurationMs } from './AssetBoardCard';
import {
  AssetBoardImageDetailToolbar,
  AssetBoardVideoDetailToolbar,
  DetailMoreMenu,
  hasImageDetailActions,
  hasVideoDetailActions,
  keyElementMenuEntry,
} from './AssetBoardDetailToolbar';
import { AssetBoardDetailTextSection } from './AssetBoardDetailTextSection';
import { AssetBoardImageGenForm } from './AssetBoardImageGenForm';
import { AssetBoardUpscaleForm } from './AssetBoardUpscaleForm';
import { AssetBoardVideoGenForm } from './AssetBoardVideoGenForm';
import { AssetBoardPromptText } from './AssetBoardPromptText';
import { AssetBoardReferenceThumbMenu } from './AssetBoardReferenceThumbMenu';

interface AssetBoardDetailProps {
  /** Overall storyboard visibility: when false, freeze store subscriptions and pause video playback in the detail (kept-alive mount). */
  visible: boolean;
  /** Canvas node id of the current detail (the raw node is read straight from the store, without extending AssetBoardItem with fields). */
  nodeId: string;
  /** The matching storyboard entry (badges/references/media addresses already resolved by buildAssetBoard); null -> the node no longer exists. */
  item: AssetBoardItem | null;
  /** Back: when the detail stack is non-empty pop to the previous detail, otherwise close (decided by AssetBoardView). */
  onBack: () => void;
  /** Close: clear the detail stack and return to the three columns. */
  onClose: () => void;
  /** Reference material menu "Edit" -> push that node's detail across columns (the parent falls back to a lightbox when there is no detail to open). */
  onOpenReference: (ref: AssetBoardReference) => void;
  /** Reference material menu "Locate" -> scroll the storyboard list to the referenced node's card and highlight it (not canvas positioning). */
  onLocateReference: (nodeId: string) => void;
  /** Click the large image -> open ImageViewerModal for zoomed viewing. */
  onZoomImage: (url: string) => void;
  /**
   * After "Create copy" builds the new node, switch the detail to it. The column is given here (a copy has the same type as the source -> same column),
   * the parent does not look it up - a just-created node is not in the previous frame's index yet.
   */
  onOpenNode: (nodeId: string, column: AssetBoardColumn) => void;
}

const HEADER_ICON_BUTTON_CLASS =
  'shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground';

function promptOf(node: CanvasNode): string | null {
  if (isImageGenNode(node) || isImageEditNode(node) || isVideoNode(node)) {
    const prompt = node.data.prompt;
    return typeof prompt === 'string' && prompt.trim().length > 0 ? prompt : null;
  }
  return null;
}

/** Image upscale result node: the resultKind:'upscale' placeholder/result node pre-created by "Edit -> Upscale". */
function isImageUpscaleNode(node: CanvasNode): boolean {
  return (
    isExportImageNode(node)
    && (node.data as { resultKind?: unknown }).resultKind === 'upscale'
  );
}

/**
 * Which generation form to mount below the detail media area (null = none, read-only display).
 *
 * An image upscale result node mounts the upscale editor (model/quality/scale + up button), not the regular image generation
 * form - it has no prompt, and its params are persisted on its own node.data.
 *
 * The video-side exclusions match the workflow VideoNode's `showVideoOpsPanel`:
 * - `videoCompose` goes through edit/compose, not a generation node (isVideoNode only recognizes video, so it never matches);
 * - `referenceOnly`: a reference asset pulled in from the asset library, which does not generate itself;
 * - `isUpscaleNode`: a video upscale node has its own config panel and does not use the regular generation form.
 */
function generationFormKindOf(node: CanvasNode): 'image' | 'video' | 'upscale' | null {
  if (isImageGenNode(node)) return 'image';
  if (isImageUpscaleNode(node)) return 'upscale';
  if (isVideoNode(node)) {
    return node.data.referenceOnly || node.data.isUpscaleNode ? null : 'video';
  }
  return null;
}

function ReferencesRow({
  references,
  onOpenReference,
  onLocateReference,
}: {
  references: AssetBoardReference[];
  onOpenReference: (ref: AssetBoardReference) => void;
  onLocateReference: (nodeId: string) => void;
}) {
  if (references.length === 0) return null;
  // role=group + aria-label: gives this group a locatable container so the "click reference thumbnail"
  // edit/locate interaction has a clear landing point. The bottom row is now only rendered in read-only details with "no generation form"
  // (see the !showGenerationForm guard in MediaBody), so it no longer coexists with the form's reference chips,
  // and there is no ambiguity of same-named thumbnails in two places.
  return (
    <div role="group" aria-label={i18n.t('canvas.assetBoard.detail.referenceAssets')} className="flex flex-col gap-1.5">
    <span className="text-[12px] text-white/40">{i18n.t('canvas.assetBoard.detail.referenceAssets')}</span>
      <div className="flex flex-wrap gap-2">
        {references.map((ref) => {
          const refNodeId = ref.nodeId;
          return (
            <AssetBoardReferenceThumbMenu
              // A built-in reference image has nodeId=null (no upstream node), so use the url as a fallback key; one node has at most one built-in image, so no collision.
              key={refNodeId ?? `own:${ref.thumbnailUrl}`}
              reference={ref}
              onEdit={() => onOpenReference(ref)}
              // A built-in image has nowhere to locate (no matching canvas node/card) -> no "Locate" item, rather than one that does nothing on click.
              onLocate={refNodeId ? () => onLocateReference(refNodeId) : null}
            />
          );
        })}
      </div>
    </div>
  );
}

/** Image/video detail body: large media + pill badges + prompt + reference assets. */
function MediaBody({
  item,
  node,
  videoRef,
  fill,
  onOpenReference,
  onLocateReference,
  onZoomImage,
}: {
  item: AssetBoardItem;
  node: CanvasNode;
  /** Video element ref: forced to pause by AssetBoardDetail when the storyboard is hidden (kept-alive mount). */
  videoRef: RefObject<HTMLVideoElement | null>;
  /** The media fills the remaining height, the generation bar is pinned to the bottom, and the whole block does not scroll (see mediaFillsBody in AssetBoardDetail). */
  fill: boolean;
  onOpenReference: (ref: AssetBoardReference) => void;
  onLocateReference: (nodeId: string) => void;
  onZoomImage: (url: string) => void;
}): ReactElement {
  const prompt = promptOf(node);
  // Image/video generation nodes mount the full generation form in the detail (empty nodes generate directly / existing outputs get params changed and
  // regenerated). The form has its own prompt input, so these nodes no longer render a separate read-only prompt block - the same
  // prompt appearing twice (one editable, one not) would make people think there are two copies of data. Other node types stay
  // read-only.
  const generationFormKind = generationFormKindOf(node);
  const showGenerationForm = generationFormKind !== null;
  // The duration/resolution badges are only for nodes without a generation form (uploaded videos, finished videos etc.) - for nodes with the form mounted,
  // the row at the bottom of the form already says "model · 16:9 · 720P · 4s"; repeating "4s" in the body is a second copy of the same
  // information and, sitting below the form, looks like a stray fragment (user asked to remove it).
  const badges: ReactElement[] = [];
  if (!showGenerationForm) {
    if (item.durationSec !== null) badges.push(<Chip key="dur">{i18n.t('canvas.assetBoard.detail.durationSec', { count: item.durationSec })}</Chip>);
    if (item.widthPx !== null && item.heightPx !== null) {
      badges.push(<Chip key="dim">{`${item.widthPx} × ${item.heightPx}`}</Chip>);
    }
  }

  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-3xl flex-col gap-4',
        // fill: no longer width-limited and centered - the media and the generation bar fill the panel together (user wants the input box to fill the panel,
        // extra space goes to the content area); min-h-full lets the parent scroll as a fallback when the content is too tall.
        fill && 'min-h-full max-w-none gap-3',
      )}
    >
      {/* Generating: existing media (regeneration keeps the old url in place) only gets an overlay, not a placeholder swap - the image the user is
      looking at should not vanish the instant "Regenerate" is clicked; only the first generation (no mediaUrl) uses the full placeholder. */}
      <div
        className={cn(
          'flex items-center justify-center',
          // The media area takes the remaining height; min-h is the lower bound so a short viewport does not squash it under the generation bar
          // (after hitting the lower bound the parent scrolls as a fallback). The media itself is sized by ratio and centered with margins - the generation bar
          // fills the panel while the content box does not (user request).
          fill && 'min-h-[180px] flex-1',
        )}
      >
        {item.column === 'video' ? (
          item.mediaUrl ? (
            <div className={cn('relative', fill ? 'h-full' : 'w-full')}>
              <video
                ref={videoRef}
                src={item.mediaUrl}
                poster={item.thumbnailUrl ?? undefined}
                controls={!item.isGenerating}
                playsInline
                // fill: the height fills this area, and the width follows the clip's own ratio (w-auto + max-w-full
                // -> the content box does not fill the panel, leaving natural side margins); non-fill: the body scrolls, with 62vh as the height cap.
                className={cn(
                  'rounded-lg bg-black object-contain',
                  fill ? 'h-full w-auto max-w-full' : 'max-h-[62vh] w-full',
                )}
              />
              {item.isGenerating && <GeneratingOverlay />}
            </div>
          ) : (
            <MediaPlaceholder kind="video" item={item} fill={fill} />
          )
        ) : item.mediaUrl ? (
          <div className={cn('relative', fill && 'h-full')}>
            <button
              type="button"
              aria-label={i18n.t('canvas.assetBoard.detail.zoomView')}
              title={i18n.t('canvas.assetBoard.detail.zoomView')}
              disabled={item.isGenerating}
              onClick={() => onZoomImage(item.mediaUrl as string)}
              className={cn('cursor-zoom-in disabled:cursor-not-allowed', fill && 'block h-full')}
            >
              <img
                src={item.mediaUrl}
                alt={item.title}
                className={cn(
                  'rounded-lg object-contain',
                  fill ? 'h-full w-auto max-w-full' : 'max-h-[62vh] w-full',
                )}
              />
            </button>
            {item.isGenerating && <GeneratingOverlay />}
          </div>
        ) : (
          <MediaPlaceholder kind="image" item={item} fill={fill} />
        )}
      </div>

      {/* key={node.id}: force a new instance when switching detail items - the form holds the prompt draft / IME composition state,
      and reusing the same-position instance would carry A's draft into B.
      Clear division of labor with the video toolbar in the header (edit/upscale/download/fullscreen): the toolbar only handles post-production on "an existing clip"
      and sits in the header; the generation form handles "make another one" and sits below the media area, with no overlap. */}
      {/* In the fill layout the form is pinned to the bottom and not compressed: when height is short, first shrink the media area above,
      instead of squeezing the generation bar out of shape. */}
      {generationFormKind === 'image' && (
        <div className={cn(fill && 'shrink-0')}>
          <AssetBoardImageGenForm key={node.id} nodeId={node.id} />
        </div>
      )}
      {generationFormKind === 'video' && (
        <div className={cn(fill && 'shrink-0')}>
          <AssetBoardVideoGenForm key={node.id} nodeId={node.id} />
        </div>
      )}
      {/* Upscale result node: the upscale editor is mounted below - after "Edit -> Upscale" creates the node the detail switches here,
      and it only submits when the model/quality/scale is chosen and the up button is pressed (matches liblib). Before submit the media area is the "generate after confirmation"
      empty state, not filled with the source image to be enlarged (see isPendingUpscaleNode). */}
      {generationFormKind === 'upscale' && (
        <div className={cn(fill && 'shrink-0')}>
          <AssetBoardUpscaleForm key={node.id} nodeId={node.id} />
        </div>
      )}

      {badges.length > 0 && <div className="flex flex-wrap gap-1.5">{badges}</div>}

      {prompt && !showGenerationForm && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] text-white/40">{i18n.t('canvas.assetBoard.detail.prompt')}</span>
          {/* @image1 / @video1 / @audio1 render as read-only chips with thumbnails (large image on hover),
          numbering reuses the workflow's mapping; references that cannot be resolved stay as plain text. */}
          <AssetBoardPromptText
            node={node}
            prompt={prompt}
            onOpenReference={(target) => {
              if (!target.nodeId || !target.thumbnailUrl) return;
              onOpenReference({
                nodeId: target.nodeId,
                label: target.label,
                thumbnailUrl: target.thumbnailUrl,
              });
            }}
          />
        </div>
      )}

      {/* The bottom "Reference assets" read-only row is only rendered in details without a generation form (read-only nodes such as upload / imageEdit /
      exportImage / videoCompose - they have no form chips to carry references).
      References of imageGen / video generation nodes are already shown by the form chips: upstream edge references -> form
      chips; imageGen's own referenceImageUrl -> the built-in reference chip added in the host AssetBoardImageGenForm.
      Rendering them again here would duplicate the form chips (image-cache/64, 65 duplicates were exactly this), so the
      !showGenerationForm guard removes it. */}
      {!showGenerationForm && (
        <ReferencesRow
          references={item.references}
          onOpenReference={onOpenReference}
          onLocateReference={onLocateReference}
        />
      )}
    </div>
  );
}

/**
 * Audio detail body: a large waveform player (AudioWaveformPlayer) in the middle + the audio generation form
 * (AssetBoardAudioGenForm) below. An empty audio node (no audioUrl) shows a placeholder in the middle
 * and still mounts the form below, so generation from scratch is possible, matching the image/video empty node experience.
 *
 * The waveform does not use the GeneratingOverlay + keep-existing-url scheme (image/video "regenerate keeps the old
 * image in place"): when regenerating audio the old audio can still play until the new url arrives, and an overlay blocking playback would be worse; the in-progress feedback is
 * carried by the form's own spinner.
 */
function AudioBody({
  item,
  node,
  visible,
  fill,
}: {
  item: AssetBoardItem;
  node: CanvasNode;
  /** Overall storyboard visibility: when false, tell the waveform player to pause (kept-alive hidden, handled the same as video). */
  visible: boolean;
  /** The content area fills the remaining height, the generation bar is pinned to the bottom and fills the width, and the whole block does not scroll (same as image/video detail). */
  fill: boolean;
}): ReactElement {
  const data = node.data as AudioNodeData;
  const audioUrl = item.mediaUrl;
  const durationMs =
    typeof data.durationMs === 'number' && data.durationMs > 0 ? data.durationMs : null;
  // Content box: fills the remaining height but only takes 3/4 of the width, centered (consistent with video detail - the generation bar fills the panel,
  // the content box does not). When not fill, fall back to the original fixed 200px.
  const mediaBoxClass = cn(
    'mx-auto flex w-3/4 items-center justify-center overflow-hidden rounded-lg bg-[#141414]',
    fill ? 'min-h-[180px] flex-1' : 'h-[200px]',
  );

  return (
    // Player/placeholder on top, generation form below (the same "media + generation bar" structure as image/video detail).
    // fill: no longer width-limited and centered, the form fills the panel; min-h-full lets the parent scroll as a fallback when the content is too tall.
    <div className={cn('mx-auto flex w-full max-w-5xl flex-col gap-4', fill && 'min-h-full max-w-none gap-3')}>
      {audioUrl ? (
        <div className={mediaBoxClass}>
          <AudioWaveformPlayer
            // key={node.id}: force a new instance when switching detail items - the player owns the <audio> and isPlaying
            // state; reusing the instance from A to B only changes src and does not fire a pause event, leaving isPlaying stuck at true
            // (clicking the pause icon would start playing B). Same isolation as the other subcomponents in this file.
            key={node.id}
            src={audioUrl}
            durationMs={durationMs}
            // When hidden by the kept-alive mount (clicking "Locate on canvas" switches back to the workflow) stop the audio, same as the video side's videoRef
            // forced pause - the player owns the <audio> and cannot be stopped manually once hidden.
            paused={!visible}
            // Deliberately do not write the decoded duration back to the node: updateNodeData pushes an undo snapshot and marks dirty, while "opening
            // the detail" is not an edit - writing back would pollute the user's undo stack and trigger a pointless autosave.
            // When the chip side needs to show a duration it probes by itself (probedSec of AssetBoardAudioChip), the same convention.
          />
        </div>
      ) : (
        <AudioPlaceholder item={item} className={mediaBoxClass} />
      )}

      {/* The generation form is always mounted (consistent with image/video detail): an empty node generates from scratch; existing audio can edit the synthesized text,
      switch the voice/timbre, change music settings and "Regenerate" (button semantics see the
      hasAudio branch of AssetBoardAudioGenForm). Matches liblib - the bottom of audio detail is also an editable generation bar.
      When fill, pinned to the bottom and not compressed: when height is short shrink the content area above first.
      key={node.id}: force a new instance when switching detail items - the form holds drafts/IME composition state, and reusing the same-position
      instance would carry A's draft into B. The duplicate-submit registry is module-level and survives remounts. */}
      <div className={cn(fill && 'shrink-0')}>
        <AssetBoardAudioGenForm key={node.id} nodeId={node.id} data={data} />
      </div>
    </div>
  );
}

/**
 * The percentage text of the generating placeholder: the same "Generating X%..." as the card (a time estimate, not the backend's real
 * progress; see useEstimatedProgress / estimatedGenerationDurationMs for the algorithm/estimated duration table).
 * Split into its own subcomponent so the 120ms polling timer only mounts on placeholders that are really generating.
 */
function GeneratingPlaceholderLabel({ item }: { item: AssetBoardItem }) {
  const percent = useEstimatedProgress(item.generationStartedAt, estimatedGenerationDurationMs(item.column));
  return <span className="text-[12px] text-muted-foreground">{i18n.t('canvas.assetBoard.detail.generatingPercent', { percent })}</span>;
}

function AudioPlaceholder({ item, className }: { item: AssetBoardItem; className: string }) {
  return (
    // Same size as the player box (see mediaBoxClass of AudioBody): the content area does not stretch along with the generation bar
    // that fills the panel.
    <div className={cn(className, 'flex-col gap-2')}>
      {item.isGenerating ? (
        <>
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <GeneratingPlaceholderLabel item={item} />
        </>
      ) : (
        <>
          <Music className="h-8 w-8 text-muted-foreground" />
          <span className="text-[12px] text-muted-foreground">{emptyMediaPlaceholderText()}</span>
        </>
      )}
    </div>
  );
}

function MediaPlaceholder({
  kind,
  item,
  fill,
}: {
  kind: 'image' | 'video';
  item: AssetBoardItem;
  /** Fill the parent's remaining height (when the detail has a generation form mounted); otherwise a 16:9 placeholder. */
  fill?: boolean;
}) {
  const Icon = kind === 'video' ? Play : ImageIcon;
  return (
    // An empty node (no image/video yet) uses a pure black background for the media area, consistent with the black background of existing media, with cleaner margins.
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg bg-black',
        // fill: the height fills, width fixed at 16:9 (an empty node has no real media ratio), with natural side margins;
        // otherwise 16:9 by container width.
        fill ? 'aspect-video h-full max-w-full' : 'aspect-video w-full',
      )}
    >
      {item.isGenerating ? (
        <>
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <GeneratingPlaceholderLabel item={item} />
        </>
      ) : (
        <>
          <Icon className="h-8 w-8 text-muted-foreground" />
          {/* The empty state says plainly "no image/video yet, generates after you confirm the params" (matches liblib empty nodes),
          instead of an unexplained gray icon; the generation form below is that confirmation entry. */}
          <span className="text-[12px] text-muted-foreground">{emptyMediaPlaceholderText()}</span>
        </>
      )}
    </div>
  );
}

/** Generating overlay on existing media: semi-transparent + centered spinner, also blocking interaction beneath (zoom/player). */
function GeneratingOverlay() {
  return (
    <span
      role="status"
      aria-label={i18n.t('canvas.assetBoard.detail.generating')}
      className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-black/40"
    >
      <Loader2 className="h-6 w-6 animate-spin text-white" />
    </span>
  );
}

/**
 * The right-hand detail panel of the storyboard master-detail layout (read-only display, matches the liblib reference image).
 * Header back/title/close; the body dispatches by the clicked column: text -> Markdown reading page/row table (top-left aligned),
 * image/video -> large media + badges + prompt + reference assets.
 */
export function AssetBoardDetail({
  visible,
  nodeId,
  item,
  onBack,
  onClose,
  onOpenReference,
  onLocateReference,
  onZoomImage,
  onOpenNode,
}: AssetBoardDetailProps): ReactElement {
  // Read the raw node straight from the store (the detail renders the full content, while AssetBoardItem only has card summary fields).
  // While hidden the selector always returns undefined (Object.is equal) -> re-rendering frozen, consistent with AssetBoardView's
  // liveNodes frozen mode; undefined = frozen, null = visible but the node was deleted.
  const liveNode = useCanvasStore((state) =>
    visible ? (state.nodes.find((candidate) => candidate.id === nodeId) ?? null) : undefined,
  );
  // Write the ref during render: an idempotent latest non-frozen cache (see the note on AssetBoardView dataRef).
  const nodeRef = useRef<CanvasNode | null>(null);
  if (liveNode !== undefined && nodeRef.current !== liveNode) {
    nodeRef.current = liveNode;
  }
  const node = nodeRef.current;

  // With the kept-alive mount, after the storyboard is hidden by visibility, <video controls> would still keep playing sound
  // (triggered by clicking "Locate on canvas" on a card/audio bar to switch back to the workflow) -> force pause the instant it is hidden.
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (!visible) {
      videoRef.current?.pause();
    }
  }, [visible]);

  // Node-level actions for the header "..." menu (key element mark / create copy / delete).
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const duplicateNodeAsSibling = useCanvasStore((state) => state.duplicateNodeAsSibling);
  const deleteNode = useCanvasStore((state) => state.deleteNode);

  const missing = !item || !node;
  // Text detail titles use the large heading in the body (matches the liblib reading page); the header keeps only back/close.
  const showHeaderTitle = !missing && item.column !== 'text';
  // "Media fills + generation bar pinned to the bottom" layout: image/video details with a generation form mounted do not scroll - the media area takes the
  // remaining height (scaled by ratio, not cropped) and the form is fixed below. The whole body used to scroll with the media at
  // max-h-62vh, and adding the form exceeded one screen: users who wanted to write a prompt below had to scroll down, pushing part of the video area out of
  // view (user feedback). liblib's detail page is likewise "image on top, generation bar below, whole page not scrolling".
  // The audio detail's generation form is always mounted (empty node synthesizes from scratch, existing audio changes params and regenerates), so the whole column
  // always uses this layout, with the same look as image/video detail (user asked for "same style as video").
  const mediaFillsBody =
    !missing &&
    (item.column === 'audio' ||
      ((item.column === 'image' || item.column === 'video') && generationFormKindOf(node) !== null));

  return (
    <section
      aria-label={i18n.t('canvas.assetBoard.detail.assetDetail')}
      // group/detail: the hover source for the header's video toolbar "appears when hovering the detail". A **named** group
      // is required - the detail subtree already has many anonymous group-hover consumers (image action chips, audio
      // bar, cards...), and an anonymous group would trigger them all by mistake whenever the mouse enters anywhere in the detail.
      className="group/detail flex min-h-0 min-w-0 flex-1 flex-col rounded-lg rounded-b-none border border-white/5 bg-[#262626]"
    >
      <header className="flex shrink-0 items-center gap-1.5 px-3 py-2.5">
        <button type="button" aria-label={i18n.t('canvas.assetBoard.detail.back')} title={i18n.t('canvas.assetBoard.detail.back')} onClick={onBack} className={HEADER_ICON_BUTTON_CLASS}>
          <ChevronLeft className="h-4 w-4" />
        </button>
        {showHeaderTitle && (
          <h3 className="min-w-0 truncate text-sm font-medium text-foreground">{item.title}</h3>
        )}
        {/* The four video actions (edit/upscale/download/fullscreen) sit in the blank between the header title and the right icons,
        rather than over the picture - floating above the player would block part of the video (user feedback).
        key={node.id}: force a new instance when the left column switches detail items - the toolbar holds local state (upscale params,
        busy state), and reusing the same-position instance would carry A's state into B. */}
        {!missing && item.column === 'video' && hasVideoDetailActions(node) ? (
          <div className="flex min-w-0 flex-1 justify-center px-2">
            <AssetBoardVideoDetailToolbar key={node.id} node={node} playerRef={videoRef} />
          </div>
        ) : (
          <div className="flex-1" />
        )}
        {/* "Add to chat": the same entry as the card's top-right and the canvas node (only emits an event; selecting + expanding the
        chat is handled by FreezoneShell). Mounted in the header rather than the toolbar below - all four columns are treated alike,
        and referencing an empty node is valid too, so it should not be blocked by the "has an image/video yet" threshold. */}
        {!missing && (
          // side=bottom: the button hugs the top edge of the detail panel, and a tooltip pointing up would be clipped by the panel.
          <AddNodeToChatIconButton
            nodeId={node.id}
            className={HEADER_ICON_BUTTON_CLASS}
            side="bottom"
          />
        )}
        {/* Node-level actions (matches the "..." at the top-right of liblib detail): set key element / create copy /
        delete. All four columns (text/image/video/audio) are treated alike - these three have nothing to do with "whether there is an image/video yet",
        so they are mounted in the header rather than on the toolbar that needs materials to exist, and are clickable on empty nodes too.
        The image side's "Set key element" was removed from the toolbar's "..." and now goes through here uniformly. */}
        {!missing && (
          <DetailMoreMenu
            key={node.id}
            triggerClassName={HEADER_ICON_BUTTON_CLASS}
            triggerLabel={i18n.t('canvas.assetBoard.detail.nodeActions')}
            entries={[
              keyElementMenuEntry(node, updateNodeData),
              {
                kind: 'action',
                key: 'duplicate',
                icon: Copy,
                label: i18n.t('canvas.assetBoard.detail.duplicate'),
                // Copy one slot below the source node and clone the upstream edges (the same store action
                // as the workflow multi-select toolbar); after creating, switch the detail to the copy, otherwise users cannot tell what happened.
                onSelect: () => {
                  const cloneId = duplicateNodeAsSibling(node.id, 1);
                  if (cloneId) onOpenNode(cloneId, item.column);
                },
              },
              {
                kind: 'action',
                key: 'delete',
                icon: Trash2,
                label: i18n.t('canvas.assetBoard.detail.delete'),
                // Once the node is gone the detail has no object - close the detail first and then delete, avoiding the detail flashing "node no longer exists".
                onSelect: () => {
                  onClose();
                  deleteNode(node.id);
                },
              },
            ]}
          />
        )}
        <button
          type="button"
          aria-label={i18n.t('canvas.assetBoard.detail.closeDetail')}
          title={i18n.t('canvas.assetBoard.detail.closeDetail')}
          onClick={onClose}
          className={HEADER_ICON_BUTTON_CLASS}
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      {/* Failure banner: when a node has a failure reason and is not retrying, it is shown persistently below the header (above the toolbar) -
      previously the failure reason was only written on the node data and could not be seen from the storyboard (quality review I2). */}
      {!missing && !item.isGenerating && item.generationError && (
        <div className="shrink-0 px-4 pb-2">
          <div className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-[12px] text-red-400">
            {item.generationError}
          </div>
        </div>
      )}
      {/* Action toolbar: an action chain below the detail header (matches liblib); text detail actions live in the body
      dispatch component (read-only reading page, see AssetBoardDetailTextSection).
      key={node.id}: force a new instance when the left column switches detail items - the toolbar/editor holds local
      state (edit draft, busy state), and reusing the same-position instance would carry A's draft/spinner into B
      (worst path: blur writes A's draft into B's content). The cost is that switching away from the same node and back
      loses the busy display (the in-flight task still writes back to the node correctly); a second batch will consider storing the in-flight state in node data. */}
      {/* An empty-content node (no image/video yet) renders no toolbar at all - every action above needs materials to exist,
      and a row of gray buttons is just noise (user request). See has*DetailActions for the check. */}
      {!missing && item.column === 'image' && hasImageDetailActions(node) && (
        <div className="shrink-0 px-4 pb-2">
          {/* onOpenNode: after a grid template click an empty feature node is created, and the detail must switch to it
          (same handling as "Create copy") - the new node always lands in the image column. */}
          <AssetBoardImageDetailToolbar
            key={node.id}
            node={node}
            onOpenNode={(newNodeId) => onOpenNode(newNodeId, 'image')}
          />
        </div>
      )}
      {/* Video has no such slot: its four actions (edit/upscale/download/fullscreen) became a pill floating above the player
      that only appears on hover, mounted in the body's media area (see MediaBody). */}
      <div
        className={cn(
          'min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-2',
          // Media-fills layout: the body becomes a flex column, the media area takes the remaining height, and the generation bar is pinned to the bottom. overflow-y-auto stays
          // as a fallback - on a short viewport the total height exceeds after the media shrinks to its lower bound, and then scrolling is preferred
          // to clipping the generation bar (overflow-hidden would make the submit button unclickable).
          mediaFillsBody && 'flex flex-col',
        )}
      >
        {missing ? (
          <p className="py-16 text-center text-[13px] text-muted-foreground">{i18n.t('canvas.assetBoard.detail.nodeGone')}</p>
        ) : item.column === 'text' ? (
          // Left-aligned, top-aligned: the body starts at the top-left of the detail area (matches the liblib reading page), no longer horizontally centered.
          // The body takes 90% of the panel width (it used to be capped at max-w-3xl=768px, using only half of a wide panel,
          // with few characters per line before wrapping). The remaining 10% keeps text from touching the panel edge directly.
          <div className="flex w-[90%] flex-col gap-4">
            <AssetBoardDetailTextSection key={node.id} node={node} title={item.title} />
          </div>
        ) : item.column === 'audio' ? (
          <AudioBody item={item} node={node} visible={visible} fill={mediaFillsBody} />
        ) : (
          <MediaBody
            item={item}
            node={node}
            videoRef={videoRef}
            fill={mediaFillsBody}
            onOpenReference={onOpenReference}
            onLocateReference={onLocateReference}
            onZoomImage={onZoomImage}
          />
        )}
      </div>
    </section>
  );
}
