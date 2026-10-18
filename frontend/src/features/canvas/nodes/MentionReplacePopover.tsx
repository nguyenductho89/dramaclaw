// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * The menu that pops up after clicking the replace icon on an @ reference in the prompt: re-point this @ to another asset.
 *
 * It has two sections because "replace with what" has two sources with different costs:
 * - Already referenced: assets this node is currently connected to; switching only changes where this @ points, the reference row is untouched;
 * - Asset references: assets on the canvas not yet connected; selecting one first connects it as upstream (the reference row gains an entry),
 *   then replaces this @ with it. The user gets "re-pointed, and the new asset also entered the references".
 *
 * Assets are grouped by image / video / audio with a right-hand list expanding on hover: on a big canvas this list can have dozens
 * of entries, and spreading them all out at once would stretch the menu into a long strip, while the user usually already knows which kind they want.
 * Once searching starts it flattens into a single list — flipping through kinds while searching just gets in the way.
 */
import { useTranslation } from 'react-i18next';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { ChevronRight, Film, Image as ImageIcon, Search } from 'lucide-react';

import type {
  ReferenceMaterialOption,
  ReferenceMediaKind,
} from '@/features/canvas/application/referencePick';
import { placeAnchoredMenu } from '@/features/canvas/nodes/shared/anchoredMenuPlacement';

import { mentionChipLabel, type MentionCandidate } from './PromptMentionEditor';

const POPOVER_WIDTH = 236;
const SUBMENU_WIDTH = 208;
const LIST_MAX_HEIGHT = 268;
const SUBMENU_MAX_HEIGHT = 300;
const EDGE_GAP = 8;
const ANCHOR_GAP = 4;
/** Height taken by the search row (including the menu's own padding and the gap below it). */
const SEARCH_ROW_HEIGHT = 46;

const KIND_ORDER: readonly ReferenceMediaKind[] = ['image', 'video', 'audio'];
/** The display names of the three asset kinds share one set of entries with the asset library; only keys remain in the source. */
const KIND_LABEL_KEYS: Record<ReferenceMediaKind, string> = {
  image: 'canvas.assetLibrary.media.image',
  video: 'canvas.assetLibrary.media.video',
  audio: 'canvas.assetLibrary.media.audio',
};

export interface MentionReplacePopoverProps {
  /** Position of the clicked chip; the menu expands against its lower edge. */
  anchorRect: DOMRect;
  /** The "already referenced" section: this node's current reference assets. */
  referenced: readonly MentionCandidate[];
  /** The "asset references" section: assets on the canvas not yet referenced. */
  materials: readonly ReferenceMaterialOption[];
  onPickReferenced: (candidate: MentionCandidate) => void;
  onPickMaterial: (material: ReferenceMaterialOption) => void;
  /** Escape closes. Focus is on the search box as soon as the menu opens, so the editor never receives this key. */
  onClose: () => void;
}

/**
 * The square thumbnail at the start of a row. When no image is available, a placeholder icon is drawn by kind — it used to always draw ♪, so
 * "image assets with no image yet" wore a musical note, misleading even the group row they sit in.
 */
function RowThumb({
  imageUrl,
  videoUrl,
  kind,
  isText = false,
}: {
  imageUrl?: string;
  videoUrl?: string;
  kind?: ReferenceMediaKind;
  isText?: boolean;
}) {
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt=""
        className="h-7 w-7 shrink-0 rounded object-cover"
        draggable={false}
      />
    );
  }
  if (videoUrl) {
    return (
      <video
        src={videoUrl}
        className="h-7 w-7 shrink-0 rounded object-cover"
        muted
        playsInline
        preload="metadata"
        draggable={false}
      />
    );
  }
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-white/[0.06] text-[13px] text-accent">
      {isText ? (
        'T'
      ) : kind === 'image' ? (
        <ImageIcon className="h-3.5 w-3.5" aria-hidden />
      ) : kind === 'video' ? (
        <Film className="h-3.5 w-3.5" aria-hidden />
      ) : (
        '♪'
      )}
    </span>
  );
}

const ROW_CLASS =
  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-white/[0.08] hover:text-text-dark';

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-1.5 text-[10px] uppercase tracking-wide text-text-muted/60">
      {children}
    </div>
  );
}

export function MentionReplacePopover({
  anchorRect,
  referenced,
  materials,
  onPickReferenced,
  onPickMaterial,
  onClose,
}: MentionReplacePopoverProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  // The expanded kind group + the position of its row (the right-hand list uses fixed positioning to avoid the menu's own scroll clipping).
  const [openGroup, setOpenGroup] = useState<{
    kind: ReferenceMediaKind;
    top: number;
    left: number;
  } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent) => {
    // The menu consumes keyboard events itself: it is a portal-ed sibling, so bubbling up would not reach the editor either,
    // and the editor's arrow keys / Enter candidate navigation should not be fed by input here.
    event.stopPropagation();
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (openGroup) {
      // First collapse the expanded kind list; a second press closes the whole menu.
      setOpenGroup(null);
      return;
    }
    onClose();
  };

  const q = query.trim().toLowerCase();
  const matchedReferenced = useMemo(
    () =>
      q
        ? referenced.filter((c) => mentionChipLabel(c).toLowerCase().includes(q))
        : referenced,
    [q, referenced],
  );
  const matchedMaterials = useMemo(
    () => (q ? materials.filter((m) => m.label.toLowerCase().includes(q)) : materials),
    [q, materials],
  );
  const groups = useMemo(
    () =>
      KIND_ORDER.map((kind) => ({
        kind,
        items: matchedMaterials.filter((m) => m.kind === kind),
      })).filter((group) => group.items.length > 0),
    [matchedMaterials],
  );

  // No grouping while searching: the user is looking for a specific thing by name, and an extra expansion layer just gets in the way.
  const flattenMaterials = q.length > 0;

  // The chip is often inside an operations panel hugging the bottom edge of the viewport: opening only downward puts the whole menu off screen, and the user
  // sees "clicked replace and nothing happened". When there is not enough space, flip above the chip; if still not enough, shrink the inner scroll.
  const { top, left, maxHeight } = placeAnchoredMenu({
    anchorRect,
    width: POPOVER_WIDTH,
    preferredHeight: SEARCH_ROW_HEIGHT + LIST_MAX_HEIGHT,
    gap: ANCHOR_GAP,
    edgeGap: EDGE_GAP,
  });
  const listMaxHeight = Math.max(72, maxHeight - SEARCH_ROW_HEIGHT);

  const openGroupItems =
    openGroup === null
      ? []
      : (groups.find((group) => group.kind === openGroup.kind)?.items ?? []);

  return (
    <>
      <div
        className="canvas-node-transient-ui fixed z-[10000] flex flex-col rounded-lg border border-white/10 bg-surface-dark/95 p-1 shadow-xl backdrop-blur-sm"
        style={{ top, left, width: POPOVER_WIDTH, maxHeight }}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-1.5 rounded-md bg-white/[0.06] px-2 py-1.5">
          <Search className="h-3 w-3 shrink-0 text-text-muted/70" aria-hidden />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpenGroup(null);
            }}
            // The editor uses arrow keys / Enter for candidate navigation; do not let input here bubble up.
            // Escape is the exception: focus is on this input, and if it is not handled here nobody will.
            onKeyDown={handleKeyDown}
            placeholder={t('common.search')}
            className="min-w-0 flex-1 bg-transparent text-xs text-text-dark outline-none placeholder:text-text-muted/60"
          />
        </div>

        <div
          className="ui-scrollbar mt-1 min-h-0 overflow-y-auto"
          style={{ maxHeight: listMaxHeight }}
          onScroll={() => setOpenGroup(null)}
        >
          {matchedReferenced.length > 0 && (
            <>
              <SectionLabel>{t('canvas.mentionReplace.referenced')}</SectionLabel>
              {matchedReferenced.map((candidate) => (
                <button
                  key={candidate.key}
                  type="button"
                  onMouseEnter={() => setOpenGroup(null)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onPickReferenced(candidate);
                  }}
                  className={ROW_CLASS}
                >
                  <RowThumb
                    imageUrl={candidate.imageUrl || undefined}
                    videoUrl={candidate.videoUrl}
                    isText={candidate.name.startsWith('text')}
                  />
                  <span className="flex-1 truncate">{mentionChipLabel(candidate)}</span>
                  <span className="text-[10px] text-text-muted/70">@{candidate.name}</span>
                </button>
              ))}
            </>
          )}

          {groups.length > 0 && (
            <>
              <SectionLabel>{t('canvas.mentionReplace.materials')}</SectionLabel>
              {flattenMaterials
                ? matchedMaterials.map((material) => (
                    <button
                      key={material.nodeId}
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onPickMaterial(material);
                      }}
                      className={ROW_CLASS}
                    >
                      <RowThumb
                        imageUrl={material.imageUrl}
                        videoUrl={material.videoUrl}
                        kind={material.kind}
                      />
                      <span className="flex-1 truncate">{material.label}</span>
                    </button>
                  ))
                : groups.map((group) => (
                    <button
                      key={group.kind}
                      type="button"
                      // The inline text is only "Image", indistinguishable from the same-named reference label in the already-referenced section;
                      // give a clear readable name so screen readers and tests can point to this row.
                      aria-label={t('canvas.mentionReplace.kindMaterialsAria', {
                        kind: t(KIND_LABEL_KEYS[group.kind]),
                      })}
                      onMouseEnter={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        setOpenGroup({
                          kind: group.kind,
                          top: rect.top - 4,
                          left: rect.right + 4,
                        });
                      }}
                      onMouseDown={(event) => event.preventDefault()}
                      className={`${ROW_CLASS} ${
                        openGroup?.kind === group.kind
                          ? 'bg-white/[0.08] text-text-dark'
                          : ''
                      }`}
                    >
                      <RowThumb
                        imageUrl={group.items[0]?.imageUrl}
                        videoUrl={group.items[0]?.videoUrl}
                        kind={group.kind}
                      />
                      <span className="flex-1 truncate">{t(KIND_LABEL_KEYS[group.kind])}</span>
                      <span className="text-[10px] text-text-muted/70">
                        {group.items.length}
                      </span>
                      <ChevronRight className="h-3 w-3 shrink-0 text-text-muted/70" />
                    </button>
                  ))}
            </>
          )}

          {matchedReferenced.length === 0 && groups.length === 0 && (
            <div className="px-2 py-3 text-center text-[11px] text-text-muted/70">
              {t('canvas.mentionReplace.empty')}
            </div>
          )}
        </div>
      </div>

      {openGroup && openGroupItems.length > 0 && (
        <div
          className="canvas-node-transient-ui ui-scrollbar fixed z-[10001] overflow-y-auto rounded-lg border border-white/10 bg-surface-dark/95 p-1 shadow-xl backdrop-blur-sm"
          style={{
            top: Math.max(
              EDGE_GAP,
              Math.min(openGroup.top, window.innerHeight - SUBMENU_MAX_HEIGHT - EDGE_GAP),
            ),
            left: Math.max(
              EDGE_GAP,
              Math.min(openGroup.left, window.innerWidth - SUBMENU_WIDTH - EDGE_GAP),
            ),
            width: SUBMENU_WIDTH,
            maxHeight: SUBMENU_MAX_HEIGHT,
          }}
        >
          {openGroupItems.map((material) => (
            <button
              key={material.nodeId}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onPickMaterial(material);
              }}
              className={ROW_CLASS}
            >
              <RowThumb
                imageUrl={material.imageUrl}
                videoUrl={material.videoUrl}
                kind={material.kind}
              />
              <span className="flex-1 truncate">{material.label}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
