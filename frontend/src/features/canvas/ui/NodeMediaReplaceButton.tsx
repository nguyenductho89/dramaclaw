// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useRef, type ChangeEvent } from 'react';
import { Loader2, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * The "Replace asset" button at the top-right of a result card: opens the local file picker and hands the chosen file back to the caller
 * to upload (each node uses its own upload path: images/audio use the generic upload, video first goes through
 * Web-compatible transcoding), then replaces the node's media on success.
 *
 * Only placed on cards that **already have content**: empty-state nodes each have their own upload entry (the NodeSideActionRail
 * "Upload" button bar), so the two never stack.
 *
 * accept is only a picker hint: the user can switch to "All files" and still pick another type, so hard validation must stay in
 * the caller's onPick.
 *
 * When onCommitDragStart is passed, this button doubles as the handle for "drag to the left asset library to replace": a click opens the
 * local file picker, while press-and-drag commits to the asset library. They are one button because users call both "Replace",
 * and giving each its own would stack two identical icons in the same corner.
 *
 * Clicking to swap a local file is the primary action and every card with content should offer it: if only drag were wired and click did nothing,
 * the button would look exactly clickable and users would think it was broken when nothing happens.
 */
interface NodeMediaReplaceButtonProps {
  accept?: string;
  /** Uploading: the button spins and is disabled, preventing repeated clicks from piling up uploads. */
  busy?: boolean;
  title: string;
  /** If omitted, this button only handles dragging (click does nothing); see above, don't use it that way anymore. */
  onPick?: (file: File) => void | Promise<void>;
  /** Fires when press-and-drag exceeds the threshold (drag to the left asset library to replace same-type assets). */
  onCommitDragStart?: () => void;
}

/** Displacement below this still counts as a click; a shaky hand should not turn "swap local file" into "drag to asset library". */
const DRAG_THRESHOLD_PX = 4;

export function NodeMediaReplaceButton({
  accept,
  busy = false,
  title,
  onPick,
  onCommitDragStart,
}: NodeMediaReplaceButtonProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  // This gesture has already escalated to a drag, so on release don't treat it as a click that opens the file picker.
  const draggedRef = useRef(false);
  // When both gestures exist the title must explain both, otherwise the "press and drag" part has no hint; appended as a second line after the
  // "Replace" title, since the icon alone can't convey the "press and drag" semantics.
  const fullTitle =
    onPick && onCommitDragStart
      ? `${title} (${t('canvas.assetLibrary.commitDragHint')})`
      : title;

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Clear value before handling: selecting the same file a second time won't fire change again, so clearing allows reselecting.
    event.target.value = '';
    if (file) void onPick?.(file);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    // nodrag already prevents React Flow from dragging the node; here we only need to block canvas box-select/deselect.
    event.stopPropagation();
    draggedRef.current = false;
    if (!onCommitDragStart || busy || event.button !== 0) return;

    const startX = event.clientX;
    const startY = event.clientY;
    const onMove = (moveEvent: PointerEvent) => {
      if (
        Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) <
        DRAG_THRESHOLD_PX
      ) {
        return;
      }
      cleanup();
      draggedRef.current = true;
      // Only start dragging once past the threshold: startDrag takes over the subsequent pointermove / pointerup itself.
      onCommitDragStart();
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', cleanup);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanup);
  };

  return (
    <>
      <button
        type="button"
        disabled={busy}
        title={fullTitle}
        aria-label={title}
        // nodrag: otherwise pressing would turn into dragging the node and the click would never arrive.
        className="nodrag absolute right-2 top-2 z-20 inline-flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-black/55 text-white/85 backdrop-blur-sm transition-colors hover:border-white/25 hover:bg-black/80 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
        style={onCommitDragStart ? { cursor: 'grab' } : undefined}
        onPointerDown={handlePointerDown}
        onClick={(event) => {
          event.stopPropagation();
          if (draggedRef.current || !onPick) return;
          inputRef.current?.click();
        }}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Upload className="h-3.5 w-3.5" />
        )}
      </button>
      {onPick && (
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={handleChange}
        />
      )}
    </>
  );
}
