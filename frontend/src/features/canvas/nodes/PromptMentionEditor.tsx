// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
// This uses the default i18next instance (the one `@/i18n` initializes). Chips are bare DOM outside
// React and cannot get the `t` from useTranslation, so it can only be taken at module level.
import i18n from 'i18next';


import type { ReferenceMaterialOption } from '@/features/canvas/application/referencePick';

import { MentionReplacePopover } from './MentionReplacePopover';

export interface MentionCandidate {
  key: string;
  name: string;
  imageUrl: string;
  index: number;
  /**
   * Source URL of a video reference. When there is no static first-frame image (imageUrl is empty), the thumbnail falls back to a
   * muted still <video preload="metadata">, whose first frame the browser positions automatically — the same rendering as the video chip
   * in the reference row.
   */
  videoUrl?: string;
  /** Source URL of an audio reference. Audio has no thumbnail; the chip becomes a clickable ▶ play button. */
  audioUrl?: string;
  /**
   * File name for display only (an audio chip shows as `audio_<displayName>`). Serialization still uses
   * `name` (with the number); the `@audio1` sent to the backend is unchanged.
   */
  displayName?: string | null;
}

interface PromptMentionEditorProps {
  value: string;
  onChange: (next: string) => void;
  candidates: MentionCandidate[];
  placeholder?: string;
  className?: string;
  onCompositionStart?: () => void;
  onCompositionEnd?: (next: string) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  /**
   * An **inline atomic block** pinned at the very start of the body (the storyboard's feature chip). It renders into a
   * `contenteditable=false` host span inside the contenteditable (React portal), so visually and in caret
   * behavior it is a single "character" in the input: text flows after it on the same line, the caret can cross it,
   * and pressing backspace after it deletes it — the deletion itself does not change the prompt text, it only calls back
   * `onLeadingChipDelete` so the host updates its own state. If not passed, none of this logic takes effect.
   */
  leadingChip?: ReactNode;
  onLeadingChipDelete?: () => void;
  /**
   * When the replace menu opens, read on demand the assets on the canvas not yet referenced, so that no host node long-term subscribes to
   * the whole nodes array.
   */
  getMaterials?: () => readonly ReferenceMaterialOption[];
  /** Connect a canvas asset as this node's reference; returning false means no reference was established. */
  onAttachMaterial?: (nodeId: string) => boolean;
}

export interface PromptMentionEditorHandle {
  insertTextAtCursor: (text: string) => void;
  /**
   * Insert an @ reference chip at the caret (the @ button on the reference row goes through this).
   *
   * Does not use insertTextAtCursor('@image1 '): that is plain text, and although the serialization is the same, it is only recognized as a chip by rebuildDOM on the next
   * external value change — commitChange has just written the new string into
   * lastSerializedRef, so the sync step returns directly on reflow. The user sees a string of bare text.
   */
  insertMentionAtCursor: (candidate: MentionCandidate) => void;
  focus: () => void;
}

// Visible row count before the popover starts scrolling. The full filtered
// list is still rendered — see the `max-h` + `overflow-y-auto` on the
// container below — so callers with >6 references (e.g. video image-reference takes
// up to 9) can still pick a later one.
const POPOVER_MAX_VISIBLE = 6;
// Each row is ~40px (py-1.5 + h-7 image + 1px borders). Computed once so the
// max-height tracks the row count consistently.
const POPOVER_ROW_PX = 40;
const PREVIEW_SIZE = 140;
const POPOVER_OFFSET_Y = 4;

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Frontend display only: strip the trailing number from a mention's "image1 / audio2" so it shows uniformly as "image / audio".
// Affects display only — serialization still uses dataset.name (with the number), and the prompt sent to the backend keeps @imageN.
export function mentionDisplayLabel(name: string): string {
  return name.replace(/\d+$/, '') || name;
}

// Audio and text chips carry the file/node display name (images/videos have thumbnails and need no name to be identified).
// Serialization is unaffected (still dataset.name). This is the "full" label, used for title / candidate list.
export function mentionChipLabel(candidate: MentionCandidate): string {
  const base = mentionDisplayLabel(candidate.name);
  const file = candidate.displayName?.trim();
  if ((candidate.audioUrl || candidate.name.startsWith('text')) && file) {
    return `${base}_${file}`;
  }
  return base;
}

// The visible label inside a chip is at most 10 characters, with an ellipsis beyond that; the full name goes in title. Cut by code point to avoid
// breaking surrogate pairs (emoji etc.).
const CHIP_LABEL_MAX_CHARS = 10;

export function truncateChipLabel(text: string, max = CHIP_LABEL_MAX_CHARS): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

function buildChipElement(candidate: MentionCandidate): HTMLElement {
  const span = document.createElement('span');
  span.contentEditable = 'false';
  span.dataset.mention = candidate.key;
  span.dataset.name = candidate.name;
  span.dataset.imageUrl = candidate.imageUrl;
  if (candidate.videoUrl) span.dataset.videoUrl = candidate.videoUrl;
  if (candidate.audioUrl) span.dataset.audioUrl = candidate.audioUrl;
  span.className = 'mention-chip';
  const label = mentionChipLabel(candidate);
  if (candidate.imageUrl) {
    span.title = i18n.t('canvas.mentionChip.doubleClickReplace');
    const img = document.createElement('img');
    img.src = candidate.imageUrl;
    img.alt = '';
    img.draggable = false;
    span.appendChild(img);
  } else if (candidate.videoUrl) {
    span.title = i18n.t('canvas.mentionChip.doubleClickReplace');
    // With no static first-frame image, show the first frame with a muted still <video> — consistent with the candidate rows / reference row.
    const video = document.createElement('video');
    video.src = candidate.videoUrl;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.draggable = false;
    span.appendChild(video);
  } else if (candidate.audioUrl) {
    // Audio has no thumbnail: place a clickable ▶/⏸ play button (the icon is drawn by ::before; the playing state is toggled by
    // data-audio-playing on the chip). On hover, title gives the full file name.
    span.classList.add('mention-chip-audio');
    span.title = i18n.t('canvas.mentionChip.clickToPlay', { label });
    const play = document.createElement('span');
    play.className = 'mention-chip-audio-play';
    play.dataset.audioPlay = '';
    play.setAttribute('aria-hidden', 'true');
    span.appendChild(play);
  } else {
    span.title = i18n.t('canvas.mentionChip.doubleClickReplace');
  }
  const labelEl = document.createElement('span');
  labelEl.className = 'mention-chip-label';
  labelEl.textContent = truncateChipLabel(label);
  span.appendChild(labelEl);
  // A replace button that takes over the thumbnail on hover. "This @ can be swapped for another asset" used to be discoverable only by
  // double-click, which is as good as absent; for images / videos it sits where the thumbnail is (swapped on hover in CSS), while the audio cell is
  // already taken by the play button, so it hangs after the label.
  const swap = document.createElement('span');
  swap.className = 'mention-chip-swap';
  swap.dataset.mentionSwap = '';
  swap.title = i18n.t('canvas.mentionChip.replace');
  swap.setAttribute('aria-hidden', 'true');
  if (candidate.imageUrl || candidate.videoUrl) {
    span.insertBefore(swap, span.firstChild);
  } else {
    span.appendChild(swap);
  }
  return span;
}

function appendTextWithLineBreaks(root: HTMLElement, text: string): void {
  const parts = text.split('\n');
  parts.forEach((part, idx) => {
    if (part.length > 0) {
      root.appendChild(document.createTextNode(part));
    }
    if (idx < parts.length - 1) {
      root.appendChild(document.createElement('br'));
    }
  });
}

function selectionBelongsTo(root: HTMLElement, selection: Selection): boolean {
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  return Boolean(
    anchor
    && root.contains(anchor)
    && (!focus || root.contains(focus))
  );
}

function rangeAtEndOf(root: HTMLElement): Range {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  return range;
}

function insertPlainTextAtRange(range: Range, text: string): Range {
  range.deleteContents();

  const fragment = document.createDocumentFragment();
  let lastNode: Node | null = null;
  const parts = text.split('\n');
  parts.forEach((part, idx) => {
    if (part.length > 0) {
      const textNode = document.createTextNode(part);
      fragment.appendChild(textNode);
      lastNode = textNode;
    }
    if (idx < parts.length - 1) {
      const br = document.createElement('br');
      fragment.appendChild(br);
      lastNode = br;
    }
  });

  range.insertNode(fragment);

  const after = document.createRange();
  if (lastNode) {
    after.setStartAfter(lastNode);
  } else {
    after.setStart(range.startContainer, range.startOffset);
  }
  after.collapse(true);
  return after;
}

function rebuildDOM(root: HTMLElement, text: string, candidates: MentionCandidate[]): void {
  while (root.firstChild) {
    root.removeChild(root.firstChild);
  }
  if (!text) return;
  const names = candidates
    .map((c) => c.name)
    .filter((n) => n.length > 0)
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) {
    appendTextWithLineBreaks(root, text);
    return;
  }
  const pattern = new RegExp('@(' + names.map(escapeRegex).join('|') + ')', 'g');
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      appendTextWithLineBreaks(root, text.slice(lastIndex, match.index));
    }
    const name = match[1];
    const candidate = candidates.find((c) => c.name === name);
    if (candidate) {
      root.appendChild(buildChipElement(candidate));
    } else {
      appendTextWithLineBreaks(root, match[0]);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    appendTextWithLineBreaks(root, text.slice(lastIndex));
  }
}

function serialize(root: HTMLElement): string {
  let out = '';
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    // Leading chip host: just a display node hung in the DOM, not part of the prompt text.
    if (el.dataset.leadChip !== undefined) return;
    if (el.dataset.mention) {
      out += '@' + (el.dataset.name ?? '');
      return;
    }
    if (el.tagName === 'BR') {
      out += '\n';
      return;
    }
    if (el.tagName === 'DIV') {
      if (out.length > 0 && !out.endsWith('\n')) out += '\n';
      for (const child of Array.from(el.childNodes)) walk(child);
      return;
    }
    for (const child of Array.from(el.childNodes)) walk(child);
  };
  for (const child of Array.from(root.childNodes)) walk(child);
  return out;
}

/**
 * Whether this keystroke is "deleting the leading chip":
 * - caret collapsed after the chip with no character/element in between → Backspace deletes the chip;
 * - caret collapsed before the chip → Delete deletes the chip;
 * - with a selection always return false, leave it to the browser to delete the whole span, and `handleInput` notifies the host as a fallback.
 */
function isLeadChipDeletion(root: HTMLElement, host: HTMLElement, key: string): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return false;
  if (!root.contains(range.startContainer) || !root.contains(host)) return false;

  const beforeHost = document.createRange();
  beforeHost.setStartBefore(host);
  beforeHost.collapse(true);
  if (range.compareBoundaryPoints(Range.START_TO_START, beforeHost) <= 0) {
    return key === 'Delete';
  }
  if (key !== 'Backspace') return false;

  const probe = document.createRange();
  probe.setStartAfter(host);
  probe.setEnd(range.startContainer, range.startOffset);
  const between = probe.cloneContents();
  // Only an empty text node in between counts as "adjacent"; any character or <br> means the thing to delete is that one.
  return (between.textContent ?? '') === '' && between.childElementCount === 0;
}

interface MentionContext {
  textNode: Text;
  atOffset: number;
  caretOffset: number;
  query: string;
  rect: DOMRect;
}

/**
 * Walk back from the caret inside a text node to find a fresh `@token`.
 * Fires on any `@` (regardless of the preceding character) so `111@` triggers
 * the picker just like `111 @` does — this is an asset-reference prompt field,
 * not an email input, so the `@` is always a deliberate mention trigger.
 */
function detectMention(): MentionContext | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return null;
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const textNode = node as Text;
  const caretOffset = range.startOffset;
  const textBefore = (textNode.textContent ?? '').slice(0, caretOffset);
  const match = textBefore.match(/@([^\s@]*)$/);
  if (!match) return null;
  const atIndex = textBefore.length - match[0].length;
  const rect = range.getBoundingClientRect();
  return {
    textNode,
    atOffset: atIndex,
    caretOffset,
    query: match[1],
    rect,
  };
}

interface HoverState {
  imageUrl: string;
  videoUrl: string;
  rect: DOMRect;
}

export const PromptMentionEditor = forwardRef<PromptMentionEditorHandle, PromptMentionEditorProps>(
  function PromptMentionEditor(
    {
      value,
      onChange,
      candidates,
      placeholder,
      className,
      onCompositionStart,
      onCompositionEnd,
      onKeyDown,
      leadingChip,
      onLeadingChipDelete,
      getMaterials,
      onAttachMaterial,
    },
    ref,
  ) {
    const editorRef = useRef<HTMLDivElement | null>(null);
    const lastSerializedRef = useRef<string>('');
    const isComposingRef = useRef(false);
    // A single shared <audio>: clicking an audio chip plays/pauses that reference; switching to another stops the previous one first.
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const playingUrlRef = useRef<string | null>(null);
    const [mention, setMention] = useState<MentionContext | null>(null);
    const [activeIdx, setActiveIdx] = useState(0);
    const [hover, setHover] = useState<HoverState | null>(null);
    // Double-click an existing @ chip → open the candidate list to "replace in place" that reference (anchored on the double-clicked chip).
    // Mutually exclusive with `mention` (insertion triggered by typing @): opening one must clear the other.
    const [replaceTarget, setReplaceTarget] = useState<{
      el: HTMLElement;
      rect: DOMRect;
      /** Snapshot of assets at the moment of opening; see getMaterials. */
      materials: readonly ReferenceMaterialOption[];
    } | null>(null);
    // Picked an asset that is not yet referenced: the host first creates the edge, and only after it appears in candidates (with a number)
    // can the chip be swapped — before that we do not even know which @imageN to write.
    const pendingAttachRef = useRef<{ el: HTMLElement; key: string } | null>(null);
    const popoverRef = useRef<HTMLDivElement | null>(null);

    // Host node of the leading chip: the DOM node is made and kept by us (React only portals content into it),
    // so after `rebuildDOM` clears and rebuilds, re-inserting the same node suffices and the portal target never changes.
    const leadHostRef = useRef<HTMLSpanElement | null>(null);
    const [leadHost, setLeadHost] = useState<HTMLSpanElement | null>(null);
    const hasLeadingChip = leadingChip !== undefined && leadingChip !== null;

    const ensureLeadHost = useCallback((): HTMLSpanElement | null => {
      const el = editorRef.current;
      if (!el) return null;
      if (!hasLeadingChip) {
        leadHostRef.current?.remove();
        return null;
      }
      let host = leadHostRef.current;
      if (!host) {
        host = document.createElement('span');
        host.contentEditable = 'false';
        host.dataset.leadChip = '';
        host.className = 'prompt-lead-chip';
        leadHostRef.current = host;
      }
      if (el.firstChild !== host) el.insertBefore(host, el.firstChild);
      return host;
    }, [hasLeadingChip]);

    // External value → DOM sync. Only re-render if the incoming value
    // differs from our own last-emitted serialization, otherwise we'd
    // wipe the caret on every keystroke.
    useLayoutEffect(() => {
      const el = editorRef.current;
      if (!el) return;
      if (value === lastSerializedRef.current) return;
      rebuildDOM(el, value, candidates);
      lastSerializedRef.current = value;
      ensureLeadHost(); // The rebuild cleared the host too; insert it back at the very start of the body
    }, [value, candidates, ensureLeadHost]);

    useLayoutEffect(() => {
      setLeadHost(ensureLeadHost());
    }, [ensureLeadHost]);

    const commitChange = useCallback(() => {
      const el = editorRef.current;
      if (!el) return;
      const next = serialize(el);
      if (next === lastSerializedRef.current) return;
      lastSerializedRef.current = next;
      onChange(next);
    }, [onChange]);

    const insertTextAtCursor = useCallback(
      (text: string) => {
        const el = editorRef.current;
        if (!el || text.length === 0) return;

        el.focus();
        const selection = window.getSelection();
        const range = selection && selection.rangeCount > 0 && selectionBelongsTo(el, selection)
          ? selection.getRangeAt(0).cloneRange()
          : rangeAtEndOf(el);
        const after = insertPlainTextAtRange(range, text);
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(after);
        }
        setMention(null);
        commitChange();
      },
      [commitChange],
    );

    const insertMentionAtCursor = useCallback(
      (candidate: MentionCandidate) => {
        const el = editorRef.current;
        if (!el) return;

        el.focus();
        const selection = window.getSelection();
        const range =
          selection && selection.rangeCount > 0 && selectionBelongsTo(el, selection)
            ? selection.getRangeAt(0).cloneRange()
            : rangeAtEndOf(el);
        range.deleteContents();
        const chip = buildChipElement(candidate);
        range.insertNode(chip);
        // As with inserting from the candidate list, add a trailing space with the caret after it, so continued typing does not stick to the chip.
        const space = document.createTextNode(' ');
        chip.parentNode?.insertBefore(space, chip.nextSibling);
        if (selection) {
          const after = document.createRange();
          after.setStartAfter(space);
          after.collapse(true);
          selection.removeAllRanges();
          selection.addRange(after);
        }
        setMention(null);
        commitChange();
      },
      [commitChange],
    );

    useImperativeHandle(
      ref,
      () => ({
        insertTextAtCursor,
        insertMentionAtCursor,
        focus: () => editorRef.current?.focus(),
      }),
      [insertTextAtCursor, insertMentionAtCursor],
    );

    const clearPlayingState = useCallback(() => {
      playingUrlRef.current = null;
      editorRef.current
        ?.querySelectorAll('.mention-chip[data-audio-playing]')
        .forEach((el) => el.removeAttribute('data-audio-playing'));
    }, []);

    // Click the ▶ button of an audio chip: play/pause that reference. Clicking the same one that is playing again → pause;
    // clicking another → stop the previous one first, then play. After successful playback the chip gets data-audio-playing (::before
    // switches to ⏸), cleared when it ends.
    const toggleAudio = useCallback(
      (chip: HTMLElement) => {
        const url = chip.dataset.audioUrl;
        if (!url) return;
        let audio = audioRef.current;
        if (!audio) {
          audio = new Audio();
          audio.addEventListener('ended', clearPlayingState);
          audioRef.current = audio;
        }
        if (playingUrlRef.current === url && !audio.paused) {
          audio.pause();
          clearPlayingState();
          return;
        }
        clearPlayingState();
        audio.pause();
        audio.src = url;
        playingUrlRef.current = url;
        void audio
          .play()
          .then(() => {
            if (playingUrlRef.current === url) chip.setAttribute('data-audio-playing', '');
          })
          .catch(() => {
            if (playingUrlRef.current === url) clearPlayingState();
          });
      },
      [clearPlayingState],
    );

    useEffect(() => {
      return () => {
        audioRef.current?.pause();
        audioRef.current = null;
      };
    }, []);

    const filtered = useMemo(() => {
      if (!mention) return candidates;
      const q = mention.query.toLowerCase();
      if (!q) return candidates;
      return candidates.filter((c) => c.name.toLowerCase().includes(q));
    }, [mention, candidates]);

    useEffect(() => {
      setActiveIdx(0);
    }, [mention?.query, mention?.atOffset, replaceTarget]);

    const handleInput = useCallback(() => {
      if (isComposingRef.current) return;
      // Once typing starts, leave "replace" mode and return to the normal input / insert flow.
      setReplaceTarget(null);
      commitChange();
      setMention(detectMention());
      // Whole-span deletions such as select-all-delete are executed by the browser and take the host node with them — notify as a fallback here,
      // otherwise the chip is visually gone while the feature on the node still hangs on.
      const el = editorRef.current;
      const host = leadHostRef.current;
      if (hasLeadingChip && el && host && !el.contains(host)) {
        onLeadingChipDelete?.();
      }
    }, [commitChange, hasLeadingChip, onLeadingChipDelete]);

    // contentEditable's default paste injects the source's rich HTML, which
    // drags along inline color/font styling — e.g. black text copied from
    // elsewhere becomes invisible against the dark editor. Force plain text
    // instead (same approach as EditableTableCell). execCommand fires a native
    // input event, so handleInput re-commits + re-runs mention detection.
    const handlePaste = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
      event.preventDefault();
      const plain = event.clipboardData.getData('text/plain');
      if (!plain) return;
      document.execCommand('insertText', false, plain);
    }, []);

    const insertChip = useCallback(
      (candidate: MentionCandidate) => {
        const ctx = mention;
        const el = editorRef.current;
        if (!ctx || !el) return;
        const sel = window.getSelection();
        if (!sel) return;

        // Replace `@query` text with the chip. Use the cached atOffset
        // anchor — caret-relative recomputation is fragile after React
        // re-renders touch surrounding nodes.
        const range = document.createRange();
        range.setStart(ctx.textNode, ctx.atOffset);
        const currentRange = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
        if (
          currentRange
          && currentRange.endContainer === ctx.textNode
          && currentRange.endOffset >= ctx.atOffset
        ) {
          range.setEnd(currentRange.endContainer, currentRange.endOffset);
        } else {
          range.setEnd(ctx.textNode, ctx.caretOffset);
        }
        range.deleteContents();
        const chip = buildChipElement(candidate);
        range.insertNode(chip);

        // Drop a trailing space and put the caret after it so the next
        // keystroke continues naturally.
        const space = document.createTextNode(' ');
        const parent = chip.parentNode;
        if (parent) {
          parent.insertBefore(space, chip.nextSibling);
        }
        const after = document.createRange();
        after.setStartAfter(space);
        after.collapse(true);
        sel.removeAllRanges();
        sel.addRange(after);

        setMention(null);
        commitChange();
      },
      [mention, commitChange],
    );

    // Replace the double-clicked chip in place: build a chip from the new candidate to take over the old node, put the caret after it,
    // then re-serialize and commit. The reference queue is unchanged — only this mention is re-pointed to another existing resource.
    const replaceChip = useCallback(
      (chipEl: HTMLElement, candidate: MentionCandidate) => {
        const el = editorRef.current;
        setReplaceTarget(null);
        if (!el || !el.contains(chipEl)) return;
        const fresh = buildChipElement(candidate);
        chipEl.replaceWith(fresh);
        el.focus();
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.setStartAfter(fresh);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        commitChange();
      },
      [commitChange],
    );

    // Open the replace menu below a chip. Shared by two entries: the hover-revealed replace icon, and double-click on the
    // chip (an old habit, kept).
    const openReplaceFor = useCallback(
      (chip: HTMLElement) => {
        const materials = getMaterials?.() ?? [];
        if (candidates.length === 0 && materials.length === 0) return;
        pendingAttachRef.current = null;
        setMention(null);
        setHover(null);
        setReplaceTarget({ el: chip, rect: chip.getBoundingClientRect(), materials });
      },
      [candidates.length, getMaterials],
    );

    // Double-click an @ chip → open the candidate list below it to quickly replace that reference, saving "delete the chip and @ again".
    const handleDoubleClick = useCallback(
      (event: ReactMouseEvent<HTMLDivElement>) => {
        const chip = (event.target as HTMLElement | null)?.closest('.mention-chip');
        if (!(chip instanceof HTMLElement) || !chip.dataset.mention) return;
        event.preventDefault();
        event.stopPropagation();
        openReplaceFor(chip);
      },
      [openReplaceFor],
    );

    // Picked a canvas asset: first let the host create the edge, then wait for it to enter candidates with a number.
    // While the edge is being created the prompt text does not change and rebuildDOM does not run, so the chip element held here stays valid.
    // If edge creation is rejected (e.g. the asset limit was exceeded and the host already showed a toast), do not leave a pending —
    // if it stayed, when the user later connects the same node from another entry, this chip long since stripped of context would be silently changed.
    const attachMaterial = useCallback(
      (chipEl: HTMLElement, nodeId: string) => {
        setReplaceTarget(null);
        if (!onAttachMaterial) return;
        if (!onAttachMaterial(nodeId)) return;
        pendingAttachRef.current = { el: chipEl, key: nodeId };
      },
      [onAttachMaterial],
    );

    // In replace mode, clicking anywhere outside the popover closes it (capture phase, ahead of React bubbling).
    useEffect(() => {
      if (!replaceTarget) return;
      const onDocMouseDown = (event: MouseEvent) => {
        const target = event.target as Node | null;
        if (popoverRef.current && target && popoverRef.current.contains(target)) {
          return;
        }
        setReplaceTarget(null);
      };
      document.addEventListener('mousedown', onDocMouseDown, true);
      return () => document.removeEventListener('mousedown', onDocMouseDown, true);
    }, [replaceTarget]);

    // After a new reference is connected candidates gains this entry (with its number), and only then is the chip swapped.
    // Wait for this one round only: the edge is already built, so candidates must have been recomputed in the same update; if it is still not found,
    // the host simply cannot supply this candidate (e.g. two nodes point to the same image and the numbering only recognizes the first),
    // so stop here — leaving it pending would only wrongly change an unrelated chip long afterwards.
    useEffect(() => {
      const pending = pendingAttachRef.current;
      if (!pending) return;
      pendingAttachRef.current = null;
      const candidate = candidates.find((item) => item.key === pending.key);
      if (candidate) replaceChip(pending.el, candidate);
    }, [candidates, replaceChip]);

    const handleKeyDown = useCallback(
      (event: ReactKeyboardEvent<HTMLDivElement>) => {
        event.stopPropagation();
        // The leading chip is deleted by backspace like a character: intercept this keystroke and notify the host ourselves, so the
        // browser does not touch the DOM (it would delete the host span, and the React portal would lose its landing point).
        if (hasLeadingChip && (event.key === 'Backspace' || event.key === 'Delete')) {
          const el = editorRef.current;
          const host = leadHostRef.current;
          if (el && host && isLeadChipDeletion(el, host, event.key)) {
            event.preventDefault();
            onLeadingChipDelete?.();
            return;
          }
        }
        const popoverOpen = (Boolean(mention) || Boolean(replaceTarget)) && filtered.length > 0;
        if (popoverOpen) {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActiveIdx((i) => (i + 1) % filtered.length);
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIdx((i) => (i - 1 + filtered.length) % filtered.length);
            return;
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            insertChip(filtered[activeIdx]);
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            setMention(null);
            setReplaceTarget(null);
            return;
          }
        }
        if (event.key === 'Escape') {
          setHover(null);
        }
        onKeyDown?.(event);
      },
      [
        mention,
        replaceTarget,
        filtered,
        activeIdx,
        insertChip,
        replaceChip,
        onKeyDown,
        hasLeadingChip,
        onLeadingChipDelete,
      ],
    );

    const handleClick = useCallback(
      (event: ReactMouseEvent<HTMLDivElement>) => {
        event.stopPropagation();
        const swapEl = (event.target as HTMLElement | null)?.closest('[data-mention-swap]');
        if (swapEl) {
          const chip = swapEl.closest('.mention-chip');
          if (chip instanceof HTMLElement && chip.dataset.mention) {
            event.preventDefault();
            openReplaceFor(chip);
          }
          return;
        }
        const playEl = (event.target as HTMLElement | null)?.closest('[data-audio-play]');
        if (!playEl) return;
        const chip = playEl.closest('.mention-chip');
        if (chip instanceof HTMLElement) {
          event.preventDefault();
          toggleAudio(chip);
        }
      },
      [openReplaceFor, toggleAudio],
    );

    const handleMouseOver = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
      const target = (event.target as HTMLElement | null)?.closest('[data-mention]');
      if (!(target instanceof HTMLElement)) {
        setHover(null);
        return;
      }
      const imageUrl = target.dataset.imageUrl ?? '';
      const videoUrl = target.dataset.videoUrl ?? '';
      if (!imageUrl && !videoUrl) return;
      setHover({ imageUrl, videoUrl, rect: target.getBoundingClientRect() });
    }, []);

    const handleMouseOut = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
      const target = (event.target as HTMLElement | null)?.closest('[data-mention]');
      if (!(target instanceof HTMLElement)) return;
      const related = event.relatedTarget as Node | null;
      if (related && target.contains(related)) return;
      setHover(null);
    }, []);

    // Attach as `ref` only on the currently-active row. When activeIdx changes
    // the ref detaches from the old button (null) and attaches to the new one
    // (the element), at which point we nudge it into the visible viewport.
    // Without this, Arrow Down past the 6th row hides the highlight behind the
    // scroll edge.
    const scrollActiveIntoView = useCallback((el: HTMLButtonElement | null) => {
      if (el) el.scrollIntoView({ block: 'nearest' });
    }, []);

    const popoverStyle = useMemo(() => {
      const rect = mention?.rect ?? null;
      if (!rect) return null;
      const top = rect.bottom + POPOVER_OFFSET_Y;
      const left = rect.left;
      return { top, left } as { top: number; left: number };
    }, [mention]);

    const previewStyle = useMemo(() => {
      if (!hover) return null;
      const left = Math.min(
        Math.max(8, hover.rect.left),
        window.innerWidth - PREVIEW_SIZE - 8,
      );
      // The popover lifts itself above the chip with -translate-y-full; top only needs to fall slightly above the chip's top edge,
      // so the height adapts to the image/video's original aspect ratio and is no longer cropped to a square.
      const top = hover.rect.top - 8;
      return { left, top };
    }, [hover]);

    return (
      <>
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          className={`prompt-mention-editor cursor-text ${className ?? ''}`}
          data-placeholder={placeholder ?? ''}
          // When there is a leading chip the editor is no longer :empty and the placeholder CSS stops working — add a marker
          // so the placeholder text is shown by ::after on the same line after the chip (matching liblib).
          {...(hasLeadingChip && value.length === 0 ? { 'data-text-empty': '' } : {})}
          spellCheck={false}
          onInput={handleInput}
          onPaste={handlePaste}
          onCompositionStart={() => {
            isComposingRef.current = true;
            onCompositionStart?.();
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false;
            commitChange();
            setMention(detectMention());
            const el = editorRef.current;
            if (el) onCompositionEnd?.(serialize(el));
          }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          onKeyDown={handleKeyDown}
          onMouseOver={handleMouseOver}
          onMouseOut={handleMouseOut}
        />
        {/* The chip content is portaled into the host span inside the contenteditable: in the DOM it is inside the input
            (so it flows with the text and the caret can cross it), while in the React tree it is a sibling of the editor
            (so clicking/hovering does not accidentally trigger the editor's own handlers). */}
        {leadHost && leadingChip ? createPortal(leadingChip, leadHost) : null}
        {(mention || replaceTarget) && popoverStyle && filtered.length > 0
          && createPortal(
            <div
              ref={popoverRef}
              className="canvas-node-transient-ui ui-scrollbar fixed z-[10000] flex min-w-[200px] max-w-[280px] flex-col overflow-y-auto rounded-lg border border-white/10 bg-surface-dark/95 shadow-xl backdrop-blur-sm"
              style={{
                ...popoverStyle,
                maxHeight: POPOVER_MAX_VISIBLE * POPOVER_ROW_PX,
              }}
              onMouseDown={(event) => event.preventDefault()}
            >
              {filtered.map((candidate, idx) => (
                <button
                  key={candidate.key}
                  type="button"
                  ref={idx === activeIdx ? scrollActiveIntoView : undefined}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    insertChip(candidate);
                  }}
                  onMouseEnter={() => setActiveIdx(idx)}
                  className={`flex items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors ${
                    idx === activeIdx
                      ? 'bg-white/[0.08] text-text-dark'
                      : 'text-text-muted hover:bg-white/[0.05] hover:text-text-dark'
                  }`}
                >
                  {candidate.imageUrl ? (
                    <img
                      src={candidate.imageUrl}
                      alt=""
                      className="h-7 w-7 shrink-0 rounded object-cover"
                      draggable={false}
                    />
                  ) : candidate.videoUrl ? (
                    <video
                      src={candidate.videoUrl}
                      className="h-7 w-7 shrink-0 rounded object-cover"
                      muted
                      playsInline
                      preload="metadata"
                      draggable={false}
                    />
                  ) : (
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-white/[0.06] text-[13px] text-accent">
                      {candidate.name.startsWith('text') ? 'T' : '♪'}
                    </span>
                  )}
                  <span className="flex-1 truncate">{mentionChipLabel(candidate)}</span>
                  <span className="text-[10px] text-text-muted/70">@{candidate.name}</span>
                </button>
              ))}
            </div>,
            document.body,
          )}
        {replaceTarget
          && createPortal(
            <div ref={popoverRef}>
              <MentionReplacePopover
                anchorRect={replaceTarget.rect}
                referenced={candidates}
                materials={replaceTarget.materials}
                onPickReferenced={(candidate) => replaceChip(replaceTarget.el, candidate)}
                onPickMaterial={(material) =>
                  attachMaterial(replaceTarget.el, material.nodeId)
                }
                onClose={() => setReplaceTarget(null)}
              />
            </div>,
            document.body,
          )}
        {hover && previewStyle
          && createPortal(
            <div
              className="canvas-node-transient-ui pointer-events-none fixed z-[10001] -translate-y-full overflow-hidden rounded-lg border border-white/15 bg-surface-dark/95 shadow-xl"
              style={{
                left: previewStyle.left,
                top: previewStyle.top,
                width: PREVIEW_SIZE,
              }}
            >
              {hover.imageUrl ? (
                <img
                  src={hover.imageUrl}
                  alt=""
                  className="block h-auto max-h-[220px] w-full object-contain"
                  draggable={false}
                />
              ) : (
                <video
                  src={hover.videoUrl}
                  autoPlay
                  loop
                  muted
                  playsInline
                  className="block h-auto max-h-[220px] w-full object-contain"
                />
              )}
            </div>,
            document.body,
          )}
      </>
    );
  },
);
