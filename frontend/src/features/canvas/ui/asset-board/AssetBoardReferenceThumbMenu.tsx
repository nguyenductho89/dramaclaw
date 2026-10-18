// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { MapPin, PenLine } from 'lucide-react';

import type { AssetBoardReference } from '@/features/canvas/domain/assetBoard';
import { cn } from '@/lib/utils';

// Menu item style (the same as the "..." menu items of AssetBoardDetailToolbar: rounded-[6px],
// hover bg-white/5, unified in this branch's system).
const REFERENCE_MENU_ITEM_CLASS =
  'flex w-full items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-left text-[12px] text-white/80 transition-colors hover:bg-white/5 hover:text-white';

const REFERENCE_MENU_CLOSE_DELAY_MS = 140;

interface AssetBoardReferenceThumbMenuProps {
  reference: AssetBoardReference;
  /** "Edit" -> open the referenced node's detail, where the user edits. */
  onEdit: () => void;
  /** "Locate" -> scroll to the referenced node's card and highlight it; null (the node's own reference image has no matching node) -> this item is not rendered. */
  onLocate: (() => void) | null;
  /** Appearance overrides such as thumbnail size: 48px in detail, 40px in cards. */
  className?: string;
  /**
   * The behavior of clicking the thumbnail itself. Not passed -> a click toggles the menu open/closed (the detail's existing feel);
   * passed -> a click runs it (card: open a lightbox preview), and the menu is driven only by hover/focus.
   */
  onThumbClick?: () => void;
}

/**
 * Reference asset thumbnail + hover menu (shared by the detail panel and storyboard cards, keeping the feel consistent in both places):
 * the thumbnail is the trigger, and hover / click expands a small menu -
 * - "Edit" -> onEdit (push the referenced node's detail across columns to edit);
 * - "Locate" -> onLocate (scroll the storyboard list to the referenced node's card and highlight it, not canvas positioning).
 *
 * Mainly hover: moving into the thumbnail or panel keeps it open, and moving out collapses it after a delay of {@link REFERENCE_MENU_CLOSE_DELAY_MS}ms
 * (debounced). Keyboard accessible: focus landing on the trigger/any item expands it, and focus leaving as a whole collapses it,
 * Esc collapses and returns focus to the thumbnail. After choosing any item the menu collapses.
 *
 * The root node swallows click bubbling: the whole card carries a "click to open detail" onClick, and the reference asset menu interaction
 * should not open the current card along with it (the detail side has no parent click handler, so swallowing has no side effect).
 */
export function AssetBoardReferenceThumbMenu({
  reference,
  onEdit,
  onLocate,
  className,
  onThumbClick,
}: AssetBoardReferenceThumbMenuProps): ReactElement {
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);
  const openNow = useCallback(() => {
    clearCloseTimer();
    setOpen(true);
  }, [clearCloseTimer]);
  const closeNow = useCallback(() => {
    clearCloseTimer();
    setOpen(false);
  }, [clearCloseTimer]);
  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => setOpen(false), REFERENCE_MENU_CLOSE_DELAY_MS);
  }, [clearCloseTimer]);
  // On unmount / switching detail items (the list remounts by key) clear any pending collapse timer.
  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  const handleBlur = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        closeNow();
      }
    },
    [closeNow],
  );
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape' && open) {
        event.stopPropagation();
        closeNow();
        triggerRef.current?.focus();
      }
    },
    [closeNow, open],
  );

  return (
    <div
      // shrink-0: the reference row in a card is flex-wrap, and the thumbnail must not be squashed.
      className="relative shrink-0"
      onMouseEnter={openNow}
      onMouseLeave={scheduleClose}
      onFocus={openNow}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={reference.label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={reference.label}
        onClick={() => {
          if (onThumbClick) {
            onThumbClick();
            return;
          }
          if (open) closeNow();
          else openNow();
        }}
        // Corner radius 3px: unified with the inline reference thumbnails in the prompt (AssetBoardPromptText); a small thumbnail
        // pairs better with a nearly right-angled small radius for a tighter look.
        className={cn(
          'block h-12 w-12 overflow-hidden rounded-[3px] border border-white/10 transition-colors hover:border-white/25',
          className,
        )}
      >
        <img
          src={reference.thumbnailUrl}
          alt={reference.label}
          loading="lazy"
          draggable={false}
          className="h-full w-full object-cover"
        />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={i18n.t('canvas.assetBoard.referenceMenu.actions', { label: reference.label })}
          className="absolute left-0 top-full z-50 mt-1.5 min-w-[120px] rounded-md border border-white/10 bg-[#2e2e2e] p-1 text-white/85 shadow-xl"
        >
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              onEdit();
              closeNow();
            }}
            className={REFERENCE_MENU_ITEM_CLASS}
          >
            <PenLine className="h-4 w-4 shrink-0" />
            <span className="flex-1">{i18n.t('canvas.assetBoard.referenceMenu.edit')}</span>
          </button>
          {onLocate && (
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                onLocate();
                closeNow();
              }}
              className={REFERENCE_MENU_ITEM_CLASS}
            >
              <MapPin className="h-4 w-4 shrink-0" />
              <span className="flex-1">{i18n.t('canvas.assetBoard.referenceMenu.locate')}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
