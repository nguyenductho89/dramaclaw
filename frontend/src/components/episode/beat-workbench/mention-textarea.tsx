// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import * as React from "react";
import { createPortal } from "react-dom";

import {
  buildMentionRegex,
  normalizeMentionSeparatorSpaces,
} from "@/lib/mention-markers";
import { cn } from "@/lib/utils";

const MENTION_PREVIEW_SIZE = 200;

interface Segment {
  text: string;
  mention: boolean;
}

function buildSegments(text: string, labels: string[]): Segment[] {
  if (!text) return [];
  // Shares the dictionary/longest-first tokenizer with the parse layer
  // (mentionsToProgramMarkers), so what's highlighted is exactly what gets
  // extracted on submit — and a trailing space is never required.
  const pattern = buildMentionRegex(labels);
  if (!pattern) return [{ text, mention: false }];

  const segments: Segment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), mention: false });
    }
    segments.push({ text: match[0], mention: true });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), mention: false });
  }
  return segments;
}

/**
 * Finds the `@<label>` mention token that overlaps the [selStart, selEnd] selection - when double-clicking the textarea
 * the browser selects some "word" inside the token, and this locates which mention the user double-clicked. Returns null when nothing matches.
 */
export function findMentionTokenAtSelection(
  text: string,
  labels: string[],
  selStart: number,
  selEnd: number,
): { start: number; end: number; label: string } | null {
  const pattern = buildMentionRegex(labels);
  if (!pattern) return null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (start < selEnd && end > selStart) {
      return { start, end, label: match[0].replace(/^@/, "") };
    }
  }
  return null;
}

interface MentionTextareaProps
  extends Omit<React.ComponentProps<"textarea">, "value"> {
  value: string;
  mentionLabels?: string[];
  inputClassName?: string;
  // label (without @, e.g. "image1") -> preview image URL. A small image preview pops up when hovering the matching @mention highlight block.
  mentionPreviews?: Record<string, string>;
}

interface MentionState {
  start: number;
  end: number;
  query: string;
}

// A textarea that highlights `@<label>` mentions. A backdrop div mirrors the
// text and wraps matched tokens; the textarea sits on top with transparent text
// (caret stays visible) so the highlight shows through. The highlight only
// changes color/background — never glyph metrics — so the backdrop stays in
// 1:1 alignment with the textarea's characters.
export function MentionTextarea({
  className,
  inputClassName,
  value,
  mentionLabels = [],
  mentionPreviews,
  onScroll,
  onChange,
  onKeyDown,
  onKeyUp,
  onMouseUp,
  onMouseMove,
  onMouseLeave,
  onSelect,
  ...props
}: MentionTextareaProps) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const backdropRef = React.useRef<HTMLDivElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = React.useState<MentionState | null>(null);
  const [activeIndex, setActiveIndex] = React.useState(0);
  // Range of the @mention token hit by a double-click: when non-null the picker is in "replace" mode, and choosing a candidate replaces
  // this span instead of inserting at the cursor (mutually exclusive with mention insertion mode).
  const [replaceRange, setReplaceRange] = React.useState<{
    start: number;
    end: number;
  } | null>(null);
  // Preview image shown when hovering an @mention highlight block. Uses "bottom anchoring" (bottom measured from the viewport bottom) so the preview
  // sits right above the text and grows upward - a landscape image is actually shorter than its container, and with top anchoring a gap would
  // be left between the text and the image.
  const hoverLabelRef = React.useRef<string | null>(null);
  const [preview, setPreview] = React.useState<
    { url: string; left: number; bottom: number } | null
  >(null);

  const hasPreviews = Boolean(
    mentionPreviews && Object.keys(mentionPreviews).length > 0,
  );

  // The backdrop's <mark> is pointer-events-none and cannot be hovered directly; instead, in the textarea's
  // mousemove a hit test is done against each mark's screen rect, and a mention that has a preview image pops up the small image.
  const handleTextareaMouseMove = (
    event: React.MouseEvent<HTMLTextAreaElement>,
  ) => {
    onMouseMove?.(event);
    if (!hasPreviews) return;
    const backdrop = backdropRef.current;
    if (!backdrop) return;
    const { clientX, clientY } = event;
    let hitLabel: string | null = null;
    let hitRect: DOMRect | null = null;
    for (const mark of backdrop.querySelectorAll<HTMLElement>(
      "mark[data-mention-label]",
    )) {
      const rect = mark.getBoundingClientRect();
      if (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      ) {
        hitLabel = mark.dataset.mentionLabel ?? null;
        hitRect = rect;
        break;
      }
    }
    if (hitLabel === hoverLabelRef.current) return;
    hoverLabelRef.current = hitLabel;
    const url = hitLabel ? mentionPreviews?.[hitLabel] : undefined;
    if (hitLabel && url && hitRect) {
      const left = Math.min(
        Math.max(8, hitRect.left),
        window.innerWidth - MENTION_PREVIEW_SIZE - 8,
      );
      // The preview's bottom edge sits 6px above the top of the text and grows upward, always hugging the mention.
      const bottom = window.innerHeight - hitRect.top + 6;
      setPreview({ url, left, bottom });
    } else {
      setPreview(null);
    }
  };

  const handleTextareaMouseLeave = (
    event: React.MouseEvent<HTMLTextAreaElement>,
  ) => {
    onMouseLeave?.(event);
    hoverLabelRef.current = null;
    setPreview(null);
  };

  const segments = React.useMemo(
    () => buildSegments(value, mentionLabels),
    [value, mentionLabels],
  );

  const outerBox = cn(
    "relative w-full rounded-lg border bg-transparent transition-colors focus-within:ring-3",
    className,
    "focus-within:border-white/[0.16] focus-within:ring-white/10",
  );
  const textLayer = cn(
    "w-full whitespace-pre-wrap break-words",
    inputClassName ?? "px-2.5 py-2 text-sm",
  );

  const filteredLabels = React.useMemo(() => {
    // Replace mode: list all candidates (not filtered by query), for the user to pick a new asset.
    if (replaceRange) {
      return mentionLabels.filter(Boolean).slice(0, 8);
    }
    if (!mention) return [];
    const query = mention.query.toLowerCase();
    return mentionLabels
      .filter(Boolean)
      .filter((label) => !query || label.toLowerCase().includes(query))
      .slice(0, 8);
  }, [mention, replaceRange, mentionLabels]);

  React.useEffect(() => {
    setActiveIndex(0);
  }, [mention?.query, replaceRange]);

  // In replace mode, clicking anywhere outside the picker exits (capture phase, before the candidate onMouseDown).
  React.useEffect(() => {
    if (!replaceRange) return;
    const onDocMouseDown = (event: MouseEvent) => {
      const root = rootRef.current;
      if (root && event.target instanceof globalThis.Node && root.contains(event.target)) {
        return;
      }
      setReplaceRange(null);
    };
    document.addEventListener("mousedown", onDocMouseDown, true);
    return () => document.removeEventListener("mousedown", onDocMouseDown, true);
  }, [replaceRange]);

  const detectMention = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const match = before.match(/(^|[\s\uFF0C,\u3002\uFF01\uFF1F\uFF1B;\uFF1A:\u3001\uFF08(])@([^\s@]*)$/);
    if (!match) {
      setMention(null);
      return;
    }
    setMention({
      start: before.length - match[2].length - 1,
      end: caret,
      query: match[2],
    });
  };

  const emitChange = (
    textarea: HTMLTextAreaElement,
    nextValue: string,
    selectionStart = textarea.selectionStart,
    selectionEnd = selectionStart,
  ) => {
    const event = {
      target: {
        ...textarea,
        value: nextValue,
        selectionStart,
        selectionEnd,
      },
      currentTarget: {
        ...textarea,
        value: nextValue,
        selectionStart,
        selectionEnd,
      },
    } as unknown as React.ChangeEvent<HTMLTextAreaElement>;
    onChange?.(event);
  };

  const insertMention = (label: string) => {
    const textarea = textareaRef.current;
    if (!textarea || !mention) return;
    const suffix = value.slice(mention.end).replace(/^\s+/, "");
    // Always follow the inserted mention with a single space so the next
    // keystroke can't glue onto it, and the caret lands after that space.
    const inserted = `@${label} `;
    const nextValue = value.slice(0, mention.start) + inserted + suffix;
    const nextCaret = mention.start + inserted.length;
    emitChange(textarea, nextValue, nextCaret, nextCaret);
    setMention(null);
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
    });
  };

  // Double-click replace: swap the whole matched @<oldLabel> token span for @<label> (without a trailing space - the text after the
  // original token stays untouched), and the referenced object changes accordingly.
  const replaceMention = (label: string) => {
    const textarea = textareaRef.current;
    if (!textarea || !replaceRange) return;
    const inserted = `@${label}`;
    const nextValue =
      value.slice(0, replaceRange.start) + inserted + value.slice(replaceRange.end);
    const nextCaret = replaceRange.start + inserted.length;
    emitChange(textarea, nextValue, nextCaret, nextCaret);
    setReplaceRange(null);
    setMention(null);
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const applyLabel = (label: string) => {
    if (replaceRange) {
      replaceMention(label);
    } else {
      insertMention(label);
    }
  };

  // Double-clicking @image N / @audio N -> opens the candidate picker below to "replace" that reference, saving the "delete token then @" steps.
  const handleDoubleClick = (event: React.MouseEvent<HTMLTextAreaElement>) => {
    if (mentionLabels.length === 0) return;
    const textarea = event.currentTarget;
    const selStart = textarea.selectionStart ?? 0;
    const selEnd = textarea.selectionEnd ?? selStart;
    const hit = findMentionTokenAtSelection(value, mentionLabels, selStart, selEnd);
    if (!hit) return;
    setMention(null);
    setActiveIndex(0);
    setReplaceRange({ start: hit.start, end: hit.end });
  };

  const handleScroll = (event: React.UIEvent<HTMLTextAreaElement>) => {
    const backdrop = backdropRef.current;
    if (backdrop) {
      backdrop.scrollTop = event.currentTarget.scrollTop;
      backdrop.scrollLeft = event.currentTarget.scrollLeft;
    }
    onScroll?.(event);
  };

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    // Typing changes token positions, so the replace-mode range becomes invalid -> exit replace mode.
    if (replaceRange) setReplaceRange(null);
    const textarea = event.currentTarget;
    const normalized = normalizeMentionSeparatorSpaces(
      textarea.value,
      mentionLabels,
      textarea.selectionStart ?? textarea.value.length,
    );
    if (normalized.text !== textarea.value) {
      emitChange(textarea, normalized.text, normalized.caret, normalized.caret);
      detectMention(normalized.text, normalized.caret);
      window.requestAnimationFrame(() => {
        textarea.setSelectionRange(normalized.caret, normalized.caret);
      });
      return;
    }
    onChange?.(event);
    detectMention(textarea.value, textarea.selectionStart ?? textarea.value.length);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Skip while an IME is composing so the candidate keys (notably Space, which
    // confirms a pinyin candidate) reach the input method instead of the picker.
    if (
      (mention || replaceRange) &&
      filteredLabels.length > 0 &&
      !event.nativeEvent.isComposing
    ) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % filteredLabels.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex(
          (index) => (index - 1 + filteredLabels.length) % filteredLabels.length,
        );
        return;
      }
      // Enter / Tab / Space all confirm the highlighted candidate — Space lets
      // you commit a query in one motion, and the inserted mention carries its
      // own trailing space anyway. In replace mode Space should not trigger (to avoid accidental changes), only Enter/Tab.
      if (
        event.key === "Enter" ||
        event.key === "Tab" ||
        (event.key === " " && !replaceRange)
      ) {
        event.preventDefault();
        applyLabel(filteredLabels[activeIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        setReplaceRange(null);
        return;
      }
    }
    onKeyDown?.(event);
  };

  const refreshMention = (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const textarea = event.currentTarget;
    detectMention(textarea.value, textarea.selectionStart ?? textarea.value.length);
  };

  return (
    <div className={outerBox} ref={rootRef}>
      <div
        ref={backdropRef}
        aria-hidden="true"
        className={cn(
          textLayer,
          "pointer-events-none absolute inset-0 select-none overflow-hidden text-foreground",
        )}
      >
        {segments.map((segment, index) =>
          segment.mention ? (
            <mark
              key={index}
              data-mention-label={segment.text.replace(/^@/, "")}
              className="rounded-[3px] bg-primary/20 text-primary"
            >
              {segment.text}
            </mark>
          ) : (
            <React.Fragment key={index}>{segment.text}</React.Fragment>
          ),
        )}
        {/* Trailing newline needs a glyph so the backdrop's height tracks the
            textarea's. */}
        {value.endsWith("\n") ? " " : null}
      </div>
      <textarea
        ref={textareaRef}
        data-slot="textarea"
        value={value}
        onChange={handleChange}
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
        onKeyUp={(event) => {
          refreshMention(event);
          onKeyUp?.(event);
        }}
        onMouseUp={(event) => {
          refreshMention(event);
          onMouseUp?.(event);
        }}
        onMouseMove={handleTextareaMouseMove}
        onMouseLeave={handleTextareaMouseLeave}
        onDoubleClick={handleDoubleClick}
        onSelect={(event) => {
          refreshMention(event);
          onSelect?.(event);
        }}
        className={cn(
          textLayer,
          "field-sizing-content relative block min-h-[inherit] resize-none border-0 bg-transparent text-transparent caret-foreground outline-none placeholder:text-muted-foreground dark:bg-transparent",
        )}
        {...props}
      />
      {(mention || replaceRange) && filteredLabels.length > 0 ? (
        <div
          role="listbox"
          className="absolute left-2 top-full z-50 mt-1 flex min-w-[180px] max-w-[280px] flex-col overflow-hidden rounded-[8px] border border-white/10 bg-popover/95 py-1 shadow-xl backdrop-blur"
        >
          {filteredLabels.map((label, index) => (
            <button
              key={label}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              onMouseDown={(event) => {
                event.preventDefault();
                applyLabel(label);
              }}
              onMouseEnter={() => setActiveIndex(index)}
              className={cn(
                "px-2.5 py-1.5 text-left text-xs",
                index === activeIndex
                  ? "bg-primary/15 text-primary"
                  : "text-foreground/82 hover:bg-white/[0.06]",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      {preview && typeof document !== "undefined"
        ? createPortal(
            <div
              className="pointer-events-none fixed z-[400]"
              style={{
                left: preview.left,
                bottom: preview.bottom,
                width: MENTION_PREVIEW_SIZE,
              }}
            >
              <div className="overflow-hidden rounded-xl border border-white/15 bg-surface-dark/95 shadow-2xl backdrop-blur-sm">
                <img
                  src={preview.url}
                  alt=""
                  className="block h-auto w-full object-contain"
                  draggable={false}
                />
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
